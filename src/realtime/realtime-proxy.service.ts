import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { randomUUID, createHash } from 'crypto';
import type { IncomingMessage, Server } from 'http';
import type { Socket } from 'net';
import { WebSocket as UpstreamWebSocket } from 'undici';
import { ConfigService } from '../config/config.service';
import { NodeConfig } from '../config/gateway.config';
import { SecretReferenceResolverService } from '../config/secret-reference-resolver.service';
import { StateBackendService } from '../state/state-backend.service';
import {
  GatewayApiKeyContext,
  GatewayApiKeyService,
} from '../auth/gateway-api-key.service';
import { normalizeWorkspaceId } from '../workspaces/workspace-scope';
import { TelemetryService } from '../telemetry/telemetry.service';
import type { ErrorRedactionTelemetry } from '../security/error-redaction';
import { redactErrorText } from '../security/error-redaction';
import { RealtimePricingService, type RealtimePricingHandle } from '../pricing/realtime-pricing.service';
import { realtimePricingEvent } from '../pricing/realtime-metering';
import { BudgetExceededError } from '../budget/budget.service';

type RealtimeCloseReason =
  | 'client_closed'
  | 'upstream_closed'
  | 'client_error'
  | 'upstream_error'
  | 'idle_timeout'
  | 'session_timeout'
  | 'gateway_shutdown';

interface RealtimeTarget {
  node: NodeConfig;
  model: string;
  mode: 'auto' | 'direct';
}

interface ParsedFrame {
  opcode: number;
  payload: Buffer;
  fin: boolean;
}

interface RealtimeSession {
  id: string;
  requestId: string;
  socket: Socket;
  upstream?: InstanceType<typeof UpstreamWebSocket>;
  target: RealtimeTarget;
  apiKey: GatewayApiKeyContext;
  workspaceId: string;
  startedAt: number;
  lastActivityAt: number;
  clientMessages: number;
  upstreamMessages: number;
  clientBytes: number;
  upstreamBytes: number;
  closed: boolean;
  buffer: Buffer;
  fragments: Buffer[];
  fragmentOpcode: number | null;
  pendingClientMessages: Array<{ opcode: number; payload: Buffer }>;
  idleTimer?: NodeJS.Timeout;
  sessionTimer?: NodeJS.Timeout;
  pricing?: RealtimePricingHandle | null;
  pricingWork?: Promise<void>;
  pricingPending?: number;
}

export interface RealtimeConnectionSummary {
  id: string;
  request_id: string;
  node: string;
  model: string;
  mode: 'auto' | 'direct';
  workspace_id: string;
  api_key_name: string | null;
  namespace_id: string | null;
  connected_at: string;
  closed_at: string | null;
  duration_ms: number | null;
  status: 'connecting' | 'open' | 'closed';
  close_reason: RealtimeCloseReason | null;
  error: string | null;
  client_messages: number;
  upstream_messages: number;
  client_bytes: number;
  upstream_bytes: number;
}

export interface RealtimeNodeStatus {
  enabled: boolean;
  experimental: true;
  supported: boolean;
  endpoint: string | null;
  models: string[];
  active_connections: number;
  max_connections_per_node: number;
  last_connected_at: string | null;
  last_closed_at: string | null;
  last_error: string | null;
}

export interface RealtimeStatus {
  enabled: boolean;
  experimental: true;
  path: string;
  active_connections: number;
  max_connections: number;
  max_connections_per_node: number;
  idle_timeout_ms: number;
  upstream_connect_timeout_ms: number;
  max_session_ms: number;
  recent: RealtimeConnectionSummary[];
}

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_PENDING_MESSAGES = 16;
const MAX_PENDING_BYTES = 1_000_000;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const REALTIME_ERROR_REDACTION = {
  bearerReplacement: 'Bearer [redacted]',
  gatewayKeyReplacement: 'gw_sk_[redacted]',
  skKeyReplacement: 'sk-[redacted]',
  providerKeyReplacement: '[redacted-provider-key]',
  sensitiveValueReplacement: '[redacted]',
  maxLength: 300,
};

@Injectable()
export class RealtimeProxyService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RealtimeProxyService.name);
  private server?: Server;
  private readonly sessions = new Map<string, RealtimeSession>();
  private readonly recent: RealtimeConnectionSummary[] = [];
  private readonly nodeLastConnectedAt = new Map<string, string>();
  private readonly nodeLastClosedAt = new Map<string, string>();
  private readonly nodeLastError = new Map<string, string>();
  private readonly pricingCloses = new Set<Promise<void>>();
  private readonly upgrades = new Set<Promise<void>>();
  private stopping = false;
  private readonly upgradeHandler = (
    req: IncomingMessage,
    socket: Socket,
    head: Buffer,
  ) => {
    const running = this.handleUpgrade(req, socket, head).catch((err) => {
      this.logger.warn(`Realtime upgrade failed: ${this.sanitizeError(err)}`);
      this.rejectUpgrade(socket, 500, 'Realtime upgrade failed');
    });
    this.upgrades.add(running);
    void running.finally(() => this.upgrades.delete(running));
  };

  constructor(
    private readonly config: ConfigService,
    private readonly apiKeys: GatewayApiKeyService,
    private readonly adapterHost: HttpAdapterHost,
    private readonly secretResolver: SecretReferenceResolverService,
    private readonly stateBackend?: StateBackendService,
    @Optional()
    private readonly telemetry?: TelemetryService,
    @Optional() private readonly pricing?: RealtimePricingService,
  ) {}

  onModuleInit(): void {
    const server = this.adapterHost.httpAdapter?.getHttpServer?.() as
      | Server
      | undefined;
    if (!server?.on) {
      this.logger.warn('Realtime preview could not attach to HTTP upgrade events.');
      return;
    }
    this.server = server;
    server.on('upgrade', this.upgradeHandler);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    this.server?.off?.('upgrade', this.upgradeHandler);
    for (const session of [...this.sessions.values()]) {
      this.closeSession(session, 'gateway_shutdown', 1001);
    }
    await Promise.allSettled([...this.upgrades]);
    await Promise.allSettled([...this.pricingCloses]);
    await this.pricing?.flush();
  }

  getStatus(workspaceId?: string | null): RealtimeStatus {
    const realtime = this.config.realtime;
    const currentWorkspaceId = normalizeWorkspaceId(workspaceId);
    return {
      enabled: realtime.enabled,
      experimental: true,
      path: realtime.path,
      active_connections: this.activeConnectionsForWorkspace(currentWorkspaceId),
      max_connections: realtime.max_connections,
      max_connections_per_node: realtime.max_connections_per_node,
      idle_timeout_ms: realtime.idle_timeout_ms,
      upstream_connect_timeout_ms: realtime.upstream_connect_timeout_ms,
      max_session_ms: realtime.max_session_ms,
      recent: this.recent.filter((item) => item.workspace_id === currentWorkspaceId),
    };
  }

  getNodeStatus(nodeId: string, workspaceId?: string | null): RealtimeNodeStatus {
    const realtime = this.config.realtime;
    const node = this.config.getNode(nodeId);
    const models = node?.realtime_models || [];
    const currentWorkspaceId = normalizeWorkspaceId(workspaceId);
    const nodeKey = this.nodeWorkspaceKey(nodeId, currentWorkspaceId);
    return {
      enabled: realtime.enabled,
      experimental: true,
      supported: models.length > 0,
      endpoint: node?.realtime_endpoint || (models.length > 0 ? '/v1/realtime' : null),
      models,
      active_connections: this.activeConnectionsForNode(nodeId, currentWorkspaceId),
      max_connections_per_node: realtime.max_connections_per_node,
      last_connected_at: this.nodeLastConnectedAt.get(nodeKey) || null,
      last_closed_at: this.nodeLastClosedAt.get(nodeKey) || null,
      last_error: this.nodeLastError.get(nodeKey) || null,
    };
  }

  private async handleUpgrade(
    req: IncomingMessage,
    socket: Socket,
    head: Buffer,
  ): Promise<void> {
    if (this.stopping) { this.rejectUpgrade(socket, 503, 'Gateway is shutting down'); return; }
    const requestUrl = new URL(req.url || '/', 'http://localhost');
    const realtime = this.config.realtime;
    if (requestUrl.pathname !== realtime.path) {
      this.rejectUpgrade(socket, 404, 'WebSocket route not found');
      return;
    }
    if (!realtime.enabled) {
      this.rejectUpgrade(socket, 404, 'Realtime preview is disabled');
      return;
    }
    if (!this.isWebSocketUpgrade(req)) {
      this.rejectUpgrade(socket, 400, 'Invalid WebSocket upgrade request');
      return;
    }
    // Closed transports may still own pending admission/settlement work. Keep
    // those bounded too instead of freeing every slot before accounting drains.
    if (this.sessions.size + this.pricingCloses.size >= realtime.max_connections || this.upgrades.size >= realtime.max_connections) {
      this.rejectUpgrade(socket, 429, 'Realtime connection or accounting limit exceeded');
      return;
    }

    const apiKey = await this.authenticate(req);
    if (!apiKey) {
      this.rejectUpgrade(socket, 401, 'Invalid API key');
      return;
    }

    const requestedModel =
      requestUrl.searchParams.get('model') || realtime.default_model || 'auto';
    let target: RealtimeTarget;
    try {
      target = this.resolveTarget(requestedModel, apiKey);
    } catch (err) {
      this.rejectUpgrade(
        socket,
        err instanceof RealtimeUpgradeError ? err.statusCode : 400,
        err instanceof Error ? err.message : 'Realtime route rejected',
      );
      return;
    }

    if (this.sessions.size + this.pricingCloses.size >= realtime.max_connections) {
      this.rejectUpgrade(socket, 429, 'Realtime connection limit exceeded');
      return;
    }
    if (
      this.activeConnectionsForNode(
        target.node.id,
        normalizeWorkspaceId(apiKey.workspace_id),
      ) >=
      realtime.max_connections_per_node
    ) {
      this.rejectUpgrade(socket, 429, 'Realtime node connection limit exceeded');
      return;
    }

    const session = this.createSession(socket, target, apiKey);
    this.sessions.set(session.id, session);
    this.attachClientSocket(session);
    try {
      session.pricing = await this.pricing?.begin(session.requestId, apiKey, target.node.id, target.model, realtime.max_session_ms);
      if (session.closed || socket.destroyed || this.stopping) {
        await session.pricing?.close(false);
        this.sessions.delete(session.id);
        if (!socket.destroyed) this.rejectUpgrade(socket, 503, 'Gateway is shutting down');
        return;
      }
    } catch (error) {
      this.sessions.delete(session.id);
      const status = error instanceof BudgetExceededError ? 429 : error && typeof error === 'object' && 'status' in error ? Number(error.status) : error && typeof error === 'object' && 'statusCode' in error ? Number(error.statusCode) : 503;
      this.rejectUpgrade(socket, [400, 403, 409, 422, 429, 503].includes(status) ? status : 503, 'Realtime pricing admission unavailable; review the configured tariff and limits', status === 429 ? 'realtime_budget_exceeded' : 'realtime_pricing_admission_failed');
      return;
    }
    this.acceptUpgrade(req, socket);
    this.nodeLastConnectedAt.set(
      this.nodeWorkspaceKey(target.node.id, session.workspaceId),
      new Date().toISOString(),
    );
    this.recordRecent(session, 'open', null, null);
    this.persistRealtimeSummary(session, 'open', null, null);
    this.scheduleTimers(session);

    if (head.length > 0) {
      this.handleClientData(session, head);
    }
    if (session.closed) return;

    try {
      const upstream = await this.openUpstream(session);
      if (session.closed) {
        upstream.close(1000, 'client closed');
        return;
      }
      session.upstream = upstream;
      this.flushPendingClientMessages(session);
      this.logger.log(
        `Realtime connected request=${session.requestId} node=${target.node.id} model=${target.model}`,
      );
    } catch (err) {
      const sanitized = this.sanitizeError(err);
      this.nodeLastError.set(
        this.nodeWorkspaceKey(target.node.id, session.workspaceId),
        sanitized,
      );
      this.logger.warn(
        `Realtime upstream connection failed request=${session.requestId} node=${target.node.id}: ${sanitized}`,
      );
      this.closeSession(session, 'upstream_error', 1011, sanitized);
    }
  }

  private authenticate(
    req: IncomingMessage,
  ): Promise<GatewayApiKeyContext | null> {
    const authHeader = this.headerValue(req, 'authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return Promise.resolve(null);
    }
    const key = authHeader.slice(7);
    const ip = req.socket.remoteAddress || undefined;
    return this.apiKeys.findContextByPlainKey(key, ip);
  }

  private resolveTarget(
    requestedModel: string,
    apiKey: GatewayApiKeyContext,
  ): RealtimeTarget {
    const realtime = this.config.realtime;
    const mode: 'auto' | 'direct' =
      requestedModel && requestedModel !== 'auto' ? 'direct' : 'auto';

    if (mode === 'auto') {
      if (!apiKey.allow_auto) {
        throw new RealtimeUpgradeError(403, 'This API key cannot use auto realtime routing.');
      }
      const configuredDefault = this.resolveDefaultTarget();
      if (configuredDefault && this.isTargetAllowed(configuredDefault, apiKey)) {
        return { ...configuredDefault, mode };
      }
      const firstAllowed = this.realtimeTargets().find((target) =>
        this.isTargetAllowed(target, apiKey),
      );
      if (firstAllowed) return { ...firstAllowed, mode };
      throw new RealtimeUpgradeError(403, 'No realtime target is allowed for this API key.');
    }

    if (!apiKey.allow_direct) {
      throw new RealtimeUpgradeError(403, 'This API key cannot use direct realtime routing.');
    }
    const resolved = this.config.resolveRealtimeModel(requestedModel);
    if (!resolved) {
      throw new RealtimeUpgradeError(
        400,
        `Realtime model "${requestedModel}" is not configured.`,
      );
    }
    const node = this.config.getNode(resolved.nodeId);
    if (!node) {
      throw new RealtimeUpgradeError(400, `Realtime node "${resolved.nodeId}" is not configured.`);
    }
    const target = { node, model: resolved.model, mode };
    if (!this.isTargetAllowed(target, apiKey, requestedModel)) {
      throw new RealtimeUpgradeError(
        403,
        `This API key is not allowed to use ${node.id}/${resolved.model}.`,
      );
    }
    if (!realtime.enabled) {
      throw new RealtimeUpgradeError(404, 'Realtime preview is disabled.');
    }
    return target;
  }

  private resolveDefaultTarget(): Omit<RealtimeTarget, 'mode'> | null {
    const realtime = this.config.realtime;
    if (realtime.default_node) {
      const node = this.config.getNode(realtime.default_node);
      if (!node?.realtime_models?.length) return null;
      const model =
        realtime.default_model && realtime.default_model !== 'auto'
          ? realtime.default_model
          : node.realtime_models[0];
      if (!node.realtime_models.includes(model)) return null;
      return { node, model };
    }
    if (realtime.default_model && realtime.default_model !== 'auto') {
      const resolved = this.config.resolveRealtimeModel(realtime.default_model);
      if (!resolved) return null;
      const node = this.config.getNode(resolved.nodeId);
      return node ? { node, model: resolved.model } : null;
    }
    return null;
  }

  private realtimeTargets(): Array<Omit<RealtimeTarget, 'mode'>> {
    const targets: Array<Omit<RealtimeTarget, 'mode'>> = [];
    for (const node of this.config.nodes) {
      for (const model of node.realtime_models || []) {
        targets.push({ node, model });
      }
    }
    return targets;
  }

  private isTargetAllowed(
    target: Omit<RealtimeTarget, 'mode'>,
    apiKey: GatewayApiKeyContext,
    requestedModel?: string,
  ): boolean {
    const allowedEndpoints = apiKey.allowed_endpoints || [];
    const allowedModalities = apiKey.allowed_modalities || [];
    if (allowedEndpoints.length > 0 && !allowedEndpoints.includes('realtime')) {
      return false;
    }
    if (allowedModalities.length > 0 && !allowedModalities.includes('realtime')) {
      return false;
    }
    if (
      apiKey.allowed_nodes.length > 0 &&
      !apiKey.allowed_nodes.includes(target.node.id)
    ) {
      return false;
    }
    if (apiKey.allowed_models.length === 0) return true;
    return (
      apiKey.allowed_models.includes(target.model) ||
      (requestedModel ? apiKey.allowed_models.includes(requestedModel) : false)
    );
  }

  private createSession(
    socket: Socket,
    target: RealtimeTarget,
    apiKey: GatewayApiKeyContext,
  ): RealtimeSession {
    const id = randomUUID();
    return {
      id,
      requestId: `rt_${id.replace(/-/g, '').slice(0, 24)}`,
      socket,
      target,
      apiKey,
      workspaceId: normalizeWorkspaceId(apiKey.workspace_id),
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      clientMessages: 0,
      upstreamMessages: 0,
      clientBytes: 0,
      upstreamBytes: 0,
      closed: false,
      buffer: Buffer.alloc(0),
      fragments: [],
      fragmentOpcode: null,
      pendingClientMessages: [],
    };
  }

  private async openUpstream(
    session: RealtimeSession,
  ): Promise<InstanceType<typeof UpstreamWebSocket>> {
    const realtime = this.config.realtime;
    const url = this.buildUpstreamUrl(session.target.node, session.target.model);
    const headers = await this.buildUpstreamHeaders(session.target.node);
    if (session.closed || this.stopping) throw new Error('Realtime connection cancelled before dispatch');
    await session.pricing?.dispatched();
    if (session.closed || this.stopping) throw new Error('Realtime connection cancelled before transport dispatch');
    const ws = new UpstreamWebSocket(url, { headers });
    (ws as unknown as { binaryType: string }).binaryType = 'arraybuffer';

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        try {
          ws.close(1011, 'connect timeout');
        } catch {
          // best effort
        }
        reject(new Error(`upstream connect timed out after ${realtime.upstream_connect_timeout_ms}ms`));
      }, realtime.upstream_connect_timeout_ms);
      const cleanup = () => {
        clearTimeout(timeout);
        ws.removeEventListener('open', onOpen as EventListener);
        ws.removeEventListener('error', onError as EventListener);
        ws.removeEventListener('close', onClose as EventListener);
      };
      const onOpen = () => {
        cleanup();
        session.pricing?.opened();
        this.attachUpstreamSocket(session, ws);
        resolve(ws);
      };
      const onError = (event: unknown) => {
        cleanup();
        reject(new Error(this.sanitizeError(event) || 'upstream websocket error'));
      };
      const onClose = (event: unknown) => {
        cleanup();
        const code =
          typeof event === 'object' && event && 'code' in event
            ? String((event as { code: unknown }).code)
            : 'unknown';
        reject(new Error(`upstream websocket closed before open (${code})`));
      };
      ws.addEventListener('open', onOpen as EventListener, { once: true });
      ws.addEventListener('error', onError as EventListener, { once: true });
      ws.addEventListener('close', onClose as EventListener, { once: true });
    });
  }

  private attachClientSocket(session: RealtimeSession): void {
    session.socket.on('data', (chunk) => this.handleClientData(session, chunk));
    session.socket.on('close', () => {
      if (!session.closed) {
        // No valid protocol close frame was received. A TCP disconnect is not
        // evidence that all supplier work completed without further charges.
        this.closeSession(session, 'client_error', 1006);
      }
    });
    session.socket.on('error', (err) => {
      this.closeSession(session, 'client_error', 1011, this.sanitizeError(err));
    });
  }

  private attachUpstreamSocket(
    session: RealtimeSession,
    upstream: InstanceType<typeof UpstreamWebSocket>,
  ): void {
    upstream.addEventListener('message', (event: unknown) => {
      if (session.closed) return;
      const data =
        event && typeof event === 'object' && 'data' in event
          ? (event as { data: unknown }).data
          : undefined;
      if (session.pricing && typeof data === 'string') {
        const metering = realtimePricingEvent(data);
        if (metering) {
          const observed = session.pricing.observation(metering);
          // Configuration admission is transport-ordered; queued audio may only
          // resume after its acknowledged, already-reserved ASR model is known.
          if (metering.kind === 'session_mode') this.flushPendingClientMessages(session);
          session.pricingPending = (session.pricingPending ?? 0) + 1;
          if (session.pricingPending > 128) {
            this.closeSession(session, 'upstream_error', 1013, 'realtime accounting backpressure');
            return;
          }
          session.pricingWork = (session.pricingWork ?? Promise.resolve()).then(async () => {
            try {
              if (!(await session.pricing!.observe(metering, observed))) this.closeSession(session, 'upstream_error', 1013, 'realtime metering requires reconciliation');
            } catch {
              this.closeSession(session, 'upstream_error', 1013, 'realtime accounting remains pending');
            } finally { session.pricingPending!--; }
          });
        }
      }
      void this.forwardUpstreamMessage(session, data);
    });
    upstream.addEventListener('close', (event: unknown) => {
      if (session.closed) return;
      const code =
        event && typeof event === 'object' && 'code' in event
          ? (event as { code: number }).code
          : 1000;
      this.closeSession(session, 'upstream_closed', code || 1000);
    });
    upstream.addEventListener('error', (event: unknown) => {
      this.closeSession(
        session,
        'upstream_error',
        1011,
        this.sanitizeError(event) || 'upstream websocket error',
      );
    });
  }

  private handleClientData(session: RealtimeSession, chunk: Buffer): void {
    if (session.closed) return;
    this.touch(session);
    session.buffer = Buffer.concat([session.buffer, chunk]);

    let frame: ParsedFrame | null;
    while ((frame = this.readFrame(session)) !== null) {
      if (frame.payload.length > MAX_FRAME_BYTES) {
        this.closeSession(session, 'client_error', 1009, 'realtime frame too large');
        return;
      }

      if (frame.opcode === 0x8) {
        this.closeSession(session, 'client_closed', this.closeCodeFrom(frame.payload));
        return;
      }
      if (frame.opcode === 0x9) {
        this.writeFrame(session.socket, frame.payload, 0xA);
        continue;
      }
      if (frame.opcode === 0xA) {
        continue;
      }

      const message = this.assembleClientMessage(session, frame);
      if (session.closed) return;
      if (!message) continue;
      session.clientMessages += 1;
      session.clientBytes += message.payload.length;
      this.forwardClientMessage(session, message.opcode, message.payload);
    }
  }

  private assembleClientMessage(
    session: RealtimeSession,
    frame: ParsedFrame,
  ): { opcode: number; payload: Buffer } | null {
    if (frame.opcode === 0x1 || frame.opcode === 0x2) {
      if (session.fragmentOpcode !== null) { this.closeSession(session, 'client_error', 1002, 'interleaved websocket fragments'); return null; }
      if (frame.fin) {
        return { opcode: frame.opcode, payload: frame.payload };
      }
      session.fragmentOpcode = frame.opcode;
      session.fragments = [frame.payload];
      return null;
    }
    if (frame.opcode === 0x0 && session.fragmentOpcode !== null) {
      if (session.fragments.length >= 4096 || session.fragments.reduce((sum, value) => sum + value.length, frame.payload.length) > MAX_FRAME_BYTES) {
        this.closeSession(session, 'client_error', 1009, 'realtime fragmented message too large'); return null;
      }
      session.fragments.push(frame.payload);
      if (!frame.fin) return null;
      const payload = Buffer.concat(session.fragments);
      const opcode = session.fragmentOpcode;
      session.fragments = [];
      session.fragmentOpcode = null;
      return { opcode, payload };
    }

    this.closeSession(session, 'client_error', 1002, 'unsupported websocket frame');
    return null;
  }

  private forwardClientMessage(
    session: RealtimeSession,
    opcode: number,
    payload: Buffer,
  ): void {
    const upstream = session.upstream;
    if (!upstream || upstream.readyState !== 1 || session.pendingClientMessages.length > 0 || session.pricing?.clientReady?.(opcode === 0x1 ? payload.toString('utf8') : undefined) === false) {
      const pendingBytes = session.pendingClientMessages.reduce(
        (sum, item) => sum + item.payload.length,
        0,
      );
      if (
        session.pendingClientMessages.length >= MAX_PENDING_MESSAGES ||
        pendingBytes + payload.length > MAX_PENDING_BYTES
      ) {
        this.closeSession(session, 'client_error', 1013, 'realtime upstream is not ready');
        return;
      }
      session.pendingClientMessages.push({ opcode, payload });
      if (upstream?.readyState === 1) this.flushPendingClientMessages(session);
      return;
    }
    if (session.pricing?.clientActivity(opcode === 0x1 ? payload.toString('utf8') : undefined) === false) {
      this.closeSession(session, 'client_error', 1008, 'realtime generation allowance exhausted');
      return;
    }
    this.sendToUpstream(upstream, opcode, payload);
  }

  private flushPendingClientMessages(session: RealtimeSession): void {
    const upstream = session.upstream;
    if (!upstream || upstream.readyState !== 1) return;
    while (session.pendingClientMessages.length > 0 && !session.closed) {
      const item = session.pendingClientMessages[0];
      if (session.pricing?.clientReady?.(item.opcode === 0x1 ? item.payload.toString('utf8') : undefined) === false) return;
      session.pendingClientMessages.shift();
      if (session.pricing?.clientActivity(item.opcode === 0x1 ? item.payload.toString('utf8') : undefined) === false) {
        this.closeSession(session, 'client_error', 1008, 'realtime generation allowance exhausted');
        return;
      }
      this.sendToUpstream(upstream, item.opcode, item.payload);
    }
  }

  private sendToUpstream(
    upstream: InstanceType<typeof UpstreamWebSocket>,
    opcode: number,
    payload: Buffer,
  ): void {
    if (opcode === 0x1) {
      upstream.send(payload.toString('utf8'));
      return;
    }
    upstream.send(payload);
  }

  private async forwardUpstreamMessage(
    session: RealtimeSession,
    data: unknown,
  ): Promise<void> {
    if (session.closed) return;
    this.touch(session);
    if (typeof data === 'string') {
      const payload = Buffer.from(data, 'utf8');
      session.upstreamMessages += 1;
      session.upstreamBytes += payload.length;
      this.writeFrame(session.socket, payload, 0x1);
      return;
    }
    if (data instanceof ArrayBuffer) {
      const payload = Buffer.from(data);
      session.upstreamMessages += 1;
      session.upstreamBytes += payload.length;
      this.writeFrame(session.socket, payload, 0x2);
      return;
    }
    if (Buffer.isBuffer(data)) {
      session.upstreamMessages += 1;
      session.upstreamBytes += data.length;
      this.writeFrame(session.socket, data, 0x2);
      return;
    }
    if (data && typeof data === 'object' && 'arrayBuffer' in data) {
      const payload = Buffer.from(
        await (data as { arrayBuffer: () => Promise<ArrayBuffer> }).arrayBuffer(),
      );
      session.upstreamMessages += 1;
      session.upstreamBytes += payload.length;
      this.writeFrame(session.socket, payload, 0x2);
    }
  }

  private readFrame(session: RealtimeSession): ParsedFrame | null {
    const buffer = session.buffer;
    if (buffer.length < 2) return null;
    const first = buffer[0];
    const second = buffer[1];
    const opcode = first & 0x0f;
    const fin = (first & 0x80) === 0x80;
    const masked = (second & 0x80) === 0x80;
    let length = second & 0x7f;
    let offset = 2;

    if (length === 126) {
      if (buffer.length < offset + 2) return null;
      length = buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (buffer.length < offset + 8) return null;
      const bigLength = buffer.readBigUInt64BE(offset);
      if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) {
        this.closeSession(session, 'client_error', 1009, 'realtime frame too large');
        return null;
      }
      length = Number(bigLength);
      offset += 8;
    }

    if (!masked) {
      this.closeSession(session, 'client_error', 1002, 'client websocket frames must be masked');
      return null;
    }
    if (length > MAX_FRAME_BYTES) {
      this.closeSession(session, 'client_error', 1009, 'realtime frame too large');
      return null;
    }
    if (buffer.length < offset + 4 + length) return null;

    const mask = buffer.subarray(offset, offset + 4);
    offset += 4;
    const payload = Buffer.from(buffer.subarray(offset, offset + length));
    for (let i = 0; i < payload.length; i++) {
      payload[i] ^= mask[i % 4];
    }
    session.buffer = buffer.subarray(offset + length);
    return { opcode, payload, fin };
  }

  private writeFrame(socket: Socket, payload: Buffer, opcode: number): void {
    if (socket.destroyed) return;
    const first = Buffer.from([0x80 | opcode]);
    let header: Buffer;
    if (payload.length < 126) {
      header = Buffer.concat([first, Buffer.from([payload.length])]);
    } else if (payload.length <= 0xffff) {
      header = Buffer.alloc(4);
      header[0] = first[0];
      header[1] = 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = first[0];
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    socket.write(Buffer.concat([header, payload]));
  }

  private closeSession(
    session: RealtimeSession,
    reason: RealtimeCloseReason,
    code = 1000,
    error: string | null = null,
  ): void {
    if (session.closed) return;
    session.closed = true;
    clearTimeout(session.idleTimer);
    clearTimeout(session.sessionTimer);
    this.sessions.delete(session.id);

    const sanitizedError = error ? this.sanitizeError(error) : null;
    if (sanitizedError) {
      this.nodeLastError.set(
        this.nodeWorkspaceKey(session.target.node.id, session.workspaceId),
        sanitizedError,
      );
    }
    this.nodeLastClosedAt.set(
      this.nodeWorkspaceKey(session.target.node.id, session.workspaceId),
      new Date().toISOString(),
    );
    this.recordRecent(session, 'closed', reason, sanitizedError);
    this.persistRealtimeSummary(session, 'closed', reason, sanitizedError);
    if (session.pricing) {
      const closing = session.pricing.close(reason !== 'client_closed' || code !== 1000, session.pricingWork);
      this.pricingCloses.add(closing);
      void closing.catch(() => this.logger.warn('Realtime accounting remains pending for review.')).finally(() => this.pricingCloses.delete(closing));
    }

    try {
      if (session.upstream && session.upstream.readyState <= 1) {
        session.upstream.close(code, reason);
      }
    } catch {
      // best effort
    }

    try {
      if (!session.socket.destroyed) {
        const closePayload = Buffer.alloc(2);
        closePayload.writeUInt16BE(this.safeCloseCode(code), 0);
        this.writeFrame(session.socket, closePayload, 0x8);
        session.socket.end();
      }
    } catch {
      session.socket.destroy();
    }
  }

  private scheduleTimers(session: RealtimeSession): void {
    const realtime = this.config.realtime;
    const refreshIdle = () => {
      clearTimeout(session.idleTimer);
      session.idleTimer = setTimeout(() => {
        this.closeSession(session, 'idle_timeout', 1001, 'realtime idle timeout');
      }, realtime.idle_timeout_ms);
    };
    session.idleTimer = setTimeout(() => {
      this.closeSession(session, 'idle_timeout', 1001, 'realtime idle timeout');
    }, realtime.idle_timeout_ms);
    session.sessionTimer = setTimeout(() => {
      this.closeSession(session, 'session_timeout', 1001, 'realtime session timeout');
    }, session.pricing?.maximumMs ?? realtime.max_session_ms);
    (session as unknown as { refreshIdle: () => void }).refreshIdle = refreshIdle;
  }

  private touch(session: RealtimeSession): void {
    session.lastActivityAt = Date.now();
    const refreshIdle = (session as unknown as { refreshIdle?: () => void }).refreshIdle;
    refreshIdle?.();
  }

  private acceptUpgrade(req: IncomingMessage, socket: Socket): void {
    const key = this.headerValue(req, 'sec-websocket-key') || '';
    const accept = createHash('sha1').update(`${key}${WS_GUID}`).digest('base64');
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        '\r\n',
      ].join('\r\n'),
    );
  }

  private rejectUpgrade(socket: Socket, statusCode: number, message: string, code?: string): void {
    if (socket.destroyed) return;
    const statusText = this.statusText(statusCode);
    const body = JSON.stringify({
      error: {
        message,
        type: statusCode === 429 ? 'rate_limit_exceeded' : 'realtime_error',
        ...(code ? { code } : {}),
      },
    });
    socket.write(
      [
        `HTTP/1.1 ${statusCode} ${statusText}`,
        'Connection: close',
        'Content-Type: application/json',
        `Content-Length: ${Buffer.byteLength(body)}`,
        '',
        body,
      ].join('\r\n'),
    );
    socket.destroy();
  }

  private isWebSocketUpgrade(req: IncomingMessage): boolean {
    const upgrade = this.headerValue(req, 'upgrade')?.toLowerCase();
    const key = this.headerValue(req, 'sec-websocket-key');
    return req.method === 'GET' && upgrade === 'websocket' && Boolean(key);
  }

  private buildUpstreamUrl(node: NodeConfig, model: string): string {
    const endpoint = node.realtime_endpoint || '/v1/realtime';
    const url = endpoint.startsWith('ws://') || endpoint.startsWith('wss://')
      ? new URL(endpoint)
      : new URL(endpoint, this.realtimeBaseUrl(node.base_url));
    if (!url.searchParams.has('model')) {
      url.searchParams.set('model', model);
    }
    return url.toString();
  }

  private realtimeBaseUrl(baseUrl: string): string {
    const url = new URL(baseUrl);
    if (url.protocol === 'https:') url.protocol = 'wss:';
    if (url.protocol === 'http:') url.protocol = 'ws:';
    return url.toString();
  }

  private async buildUpstreamHeaders(node: NodeConfig): Promise<Record<string, string>> {
    if (node.disabled === true) throw new Error(`Node "${node.id}" is disabled`);
    const nodeHeaders = await this.secretResolver.resolveRecord(node.headers, {
      optional: true,
      location: `nodes.${node.id}.headers`,
    });
    const credential = node.credentials?.find((entry) => entry.enabled !== false);
    const apiKeyRef = node.api_key || credential?.api_key;
    if (!apiKeyRef) {
      throw new Error(`Node "${node.id}" must define api_key or credentials`);
    }
    const apiKey = await this.secretResolver.resolveString(apiKeyRef, {
      location: node.api_key
        ? `nodes.${node.id}.api_key`
        : `nodes.${node.id}.credentials.${credential?.id || 'default'}.api_key`,
    });
    const headers: Record<string, string> = {
      'OpenAI-Beta': 'realtime=v1',
    };
    const authType =
      node.auth_type || (node.protocol === 'messages' ? 'x-api-key' : 'bearer');
    if (authType === 'x-api-key') {
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = nodeHeaders['anthropic-version'] || '2023-06-01';
    } else {
      headers.Authorization = `Bearer ${apiKey}`;
    }
    for (const [key, value] of Object.entries(nodeHeaders)) {
      if (this.isForwardableUpstreamHeader(key) && typeof value === 'string') {
        headers[key] = value;
      }
    }
    return headers;
  }

  private isForwardableUpstreamHeader(key: string): boolean {
    return !['host', 'content-length', 'connection', 'upgrade'].includes(
      key.toLowerCase(),
    );
  }

  private headerValue(req: IncomingMessage, name: string): string | undefined {
    const value = req.headers[name.toLowerCase()];
    if (Array.isArray(value)) return value[0];
    return value;
  }

  private activeConnectionsForWorkspace(workspaceId: string): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.workspaceId === workspaceId) count++;
    }
    return count;
  }

  private activeConnectionsForNode(nodeId: string, workspaceId?: string): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (
        session.target.node.id === nodeId &&
        (!workspaceId || session.workspaceId === workspaceId)
      ) {
        count++;
      }
    }
    return count;
  }

  private nodeWorkspaceKey(nodeId: string, workspaceId: string): string {
    return `${workspaceId}:${nodeId}`;
  }

  private recordRecent(
    session: RealtimeSession,
    status: 'open' | 'closed',
    closeReason: RealtimeCloseReason | null,
    error: string | null,
  ): void {
    const existing = this.recent.find((item) => item.id === session.id);
    const now = Date.now();
    const summary: RealtimeConnectionSummary = {
      id: session.id,
      request_id: session.requestId,
      node: session.target.node.id,
      model: session.target.model,
      mode: session.target.mode,
      workspace_id: session.workspaceId,
      api_key_name: session.apiKey.name || null,
      namespace_id: session.apiKey.namespace_id || null,
      connected_at: new Date(session.startedAt).toISOString(),
      closed_at: status === 'closed' ? new Date(now).toISOString() : null,
      duration_ms: status === 'closed' ? now - session.startedAt : null,
      status,
      close_reason: closeReason,
      error,
      client_messages: session.clientMessages,
      upstream_messages: session.upstreamMessages,
      client_bytes: session.clientBytes,
      upstream_bytes: session.upstreamBytes,
    };
    if (existing) {
      Object.assign(existing, summary);
    } else {
      this.recent.unshift(summary);
    }
    this.recent.splice(50);
  }

  private persistRealtimeSummary(
    session: RealtimeSession,
    status: 'open' | 'closed',
    reason: RealtimeCloseReason | null,
    error: string | null,
  ): void {
    if (!this.stateBackend?.isRedisConfigured()) return;
    const workspaceId = session.workspaceId;
    this.stateBackend
      .setHashJson(
        'realtime_session',
        'workspaces',
        workspaceId,
        {
          workspace_id: workspaceId,
          active_connections: this.activeConnectionsForWorkspace(workspaceId),
          last_node: session.target.node.id,
          last_model: session.target.model,
          last_status: status,
          last_close_reason: reason,
          last_error: error,
          updated_at: new Date().toISOString(),
        },
        { workspaceId },
      )
      .catch((err) =>
        this.logger.warn(`Realtime session state write skipped: ${(err as Error).message}`),
      );
  }

  private closeCodeFrom(payload: Buffer): number {
    if (payload.length < 2) return 1000;
    return this.safeCloseCode(payload.readUInt16BE(0));
  }

  private safeCloseCode(code: number): number {
    return code >= 1000 && code < 5000 ? code : 1000;
  }

  private sanitizeError(value: unknown): string {
    const raw = this.errorMessage(value);
    return redactErrorText(raw, {
      ...REALTIME_ERROR_REDACTION,
      telemetry: this.realtimeRedactionTelemetry(),
    });
  }

  private realtimeRedactionTelemetry(): ErrorRedactionTelemetry | undefined {
    if (!this.telemetry) return undefined;
    return {
      surface: 'realtime',
      record: (event) => this.telemetry?.recordErrorRedaction(event),
    };
  }

  private errorMessage(value: unknown): string {
    if (value instanceof Error) return value.message;
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object') {
      const event = value as {
        error?: unknown;
        message?: unknown;
        reason?: unknown;
        type?: unknown;
      };
      if (event.error) return this.errorMessage(event.error);
      if (typeof event.message === 'string') return event.message;
      if (typeof event.reason === 'string') return event.reason;
      if (typeof event.type === 'string') return `websocket ${event.type}`;
    }
    return 'websocket error';
  }

  private statusText(statusCode: number): string {
    switch (statusCode) {
      case 400:
        return 'Bad Request';
      case 401:
        return 'Unauthorized';
      case 403:
        return 'Forbidden';
      case 404:
        return 'Not Found';
      case 429:
        return 'Too Many Requests';
      case 500:
        return 'Internal Server Error';
      default:
        return 'Error';
    }
  }
}

class RealtimeUpgradeError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'RealtimeUpgradeError';
  }
}

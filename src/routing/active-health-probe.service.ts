import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '../config/config.service';
import {
  HealthCheckMethod,
  NodeConfig,
  NodeHealthCheckConfig,
} from '../config/gateway.config';
import { CircuitBreakerService } from './circuit-breaker.service';
import { AlertService } from '../alerts/alert.service';
import { SecretReferenceResolverService } from '../config/secret-reference-resolver.service';
import { StateBackendService } from '../state/state-backend.service';

export type ActiveProbeStatus = 'disabled' | 'unknown' | 'healthy' | 'unhealthy';

export interface ActiveHealthProbeSnapshot {
  enabled: boolean;
  status: ActiveProbeStatus;
  method: HealthCheckMethod | null;
  target: string | null;
  last_checked_at: string | null;
  last_success_at: string | null;
  latency_ms: number | null;
  failure_reason: string | null;
  consecutive_failures: number;
}

interface NormalizedHealthCheck {
  enabled: boolean;
  intervalMs: number;
  timeoutMs: number;
  method: HealthCheckMethod;
  path: string;
  lightweightModel?: string;
}

@Injectable()
export class ActiveHealthProbeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ActiveHealthProbeService.name);
  private readonly statuses = new Map<string, ActiveHealthProbeSnapshot>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly timerIntervals = new Map<string, number>();

  constructor(
    private readonly config: ConfigService,
    private readonly circuitBreaker: CircuitBreakerService,
    @Optional() private readonly alerts?: AlertService,
    @Optional() private readonly secretResolver?: SecretReferenceResolverService,
    @Optional() private readonly stateBackend?: StateBackendService,
  ) {}

  onModuleInit(): void {
    this.refreshSchedules();
  }

  onModuleDestroy(): void {
    this.stopAll();
  }

  refreshSchedules(): void {
    const enabledNodes = new Map(
      this.config.nodes
        .filter((node) => this.normalizeHealthCheck(node).enabled)
        .map((node) => [node.id, node]),
    );

    for (const nodeId of this.timers.keys()) {
      if (!enabledNodes.has(nodeId)) {
        this.stopNodeTimer(nodeId);
      }
    }

    for (const node of enabledNodes.values()) {
      const check = this.normalizeHealthCheck(node);
      if (this.timers.has(node.id) && this.timerIntervals.get(node.id) === check.intervalMs) {
        continue;
      }
      this.stopNodeTimer(node.id);
      void this.probeNode(node.id);
      const timer = setInterval(() => {
        void this.probeNode(node.id);
      }, check.intervalMs);
      timer.unref?.();
      this.timers.set(node.id, timer);
      this.timerIntervals.set(node.id, check.intervalMs);
      this.logger.log(
        `Active health probe enabled for "${node.id}" (${check.intervalMs / 1000}s interval)`,
      );
    }

    for (const node of this.config.nodes) {
      if (!enabledNodes.has(node.id)) {
        this.statuses.set(node.id, this.initialSnapshot(node));
      }
    }
  }

  async probeNode(nodeId: string): Promise<ActiveHealthProbeSnapshot> {
    const node = this.config.getNode(nodeId);
    if (!node) {
      throw new Error(`Node not found: ${nodeId}`);
    }

    const check = this.normalizeHealthCheck(node);
    if (!check.enabled) {
      const snapshot = this.initialSnapshot(node);
      this.statuses.set(node.id, snapshot);
      return snapshot;
    }

    const startedAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), check.timeoutMs);
    timeout.unref?.();

    try {
      const request = await this.buildProbeRequest(node, check);
      const response = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        signal: controller.signal,
      });
      clearTimeout(timeout);

      const latencyMs = Date.now() - startedAt;
      if (response.ok) {
        return this.recordSuccess(node, check, latencyMs);
      }

      const responseText = await response.text().catch(() => '');
      return this.recordFailure(
        node,
        check,
        latencyMs,
        `HTTP ${response.status}${responseText ? `: ${responseText.slice(0, 160)}` : ''}`,
      );
    } catch (err) {
      clearTimeout(timeout);
      const latencyMs = Date.now() - startedAt;
      const error = err as Error;
      const reason = error.name === 'AbortError'
        ? `Timed out after ${check.timeoutMs}ms`
        : error.message;
      return this.recordFailure(node, check, latencyMs, reason);
    }
  }

  getNodeStatus(nodeId: string): ActiveHealthProbeSnapshot {
    const node = this.config.getNode(nodeId);
    if (!node) {
      return {
        enabled: false,
        status: 'disabled',
        method: null,
        target: null,
        last_checked_at: null,
        last_success_at: null,
        latency_ms: null,
        failure_reason: 'Node not found',
        consecutive_failures: 0,
      };
    }

    const snapshot = this.statuses.get(nodeId) || this.initialSnapshot(node);
    const check = this.normalizeHealthCheck(node);
    return {
      ...snapshot,
      enabled: check.enabled,
      method: check.enabled ? check.method : null,
      target: check.enabled ? this.describeTarget(node, check) : null,
      status: check.enabled ? snapshot.status : 'disabled',
    };
  }

  getAllStatuses(): Record<string, ActiveHealthProbeSnapshot> {
    const result: Record<string, ActiveHealthProbeSnapshot> = {};
    for (const node of this.config.nodes) {
      result[node.id] = this.getNodeStatus(node.id);
    }
    return result;
  }

  getClusterSummary(): {
    enabled_nodes: number;
    unhealthy_nodes: number;
    last_checked_at: string | null;
  } {
    const statuses = Object.values(this.getAllStatuses());
    const enabled = statuses.filter((status) => status.enabled);
    const lastChecked = statuses
      .map((status) => status.last_checked_at)
      .filter((value): value is string => Boolean(value))
      .sort()
      .pop() || null;
    return {
      enabled_nodes: enabled.length,
      unhealthy_nodes: enabled.filter((status) => status.status === 'unhealthy').length,
      last_checked_at: lastChecked,
    };
  }

  private async buildProbeRequest(
    node: NodeConfig,
    check: NormalizedHealthCheck,
  ): Promise<{
    url: string;
    method: HealthCheckMethod;
    headers: Record<string, string>;
    body?: string;
  }> {
    const headers = await this.buildHeaders(node, check.method);
    const model = check.lightweightModel || node.models[0];
    const path =
      node.protocol === 'gemini' && model
        ? check.path
            .replace(':model', encodeURIComponent(model))
            .replace('{model}', encodeURIComponent(model))
        : check.path;
    const url = this.buildUrl(node.base_url, path);
    if (check.method !== 'POST') {
      return { url, method: check.method, headers };
    }

    if (!model) {
      throw new Error(`Node "${node.id}" has no model available for POST health probe`);
    }

    return {
      url,
      method: 'POST',
      headers,
      body: JSON.stringify(this.buildSyntheticProbeBody(node, model)),
    };
  }

  private async buildHeaders(
    node: NodeConfig,
    method: HealthCheckMethod,
  ): Promise<Record<string, string>> {
    const nodeHeaders = this.secretResolver
      ? await this.secretResolver.resolveRecord(node.headers, {
          optional: true,
          location: `nodes.${node.id}.headers`,
        })
      : { ...(node.headers || {}) };
    const credential = node.credentials?.find((entry) => entry.enabled !== false);
    const apiKeyRef = node.api_key || credential?.api_key;
    if (!apiKeyRef) {
      throw new Error(`Node "${node.id}" must define api_key or credentials`);
    }
    const apiKey = this.secretResolver
      ? await this.secretResolver.resolveString(apiKeyRef, {
          location: node.api_key
            ? `nodes.${node.id}.api_key`
            : `nodes.${node.id}.credentials.${credential?.id || 'default'}.api_key`,
        })
      : apiKeyRef;
    const headers: Record<string, string> = {};
    if (method === 'POST') {
      headers['Content-Type'] = 'application/json';
    }

    const authType =
      node.auth_type ||
      (node.protocol === 'messages' || node.protocol === 'gemini'
        ? 'x-api-key'
        : 'bearer');
    if (authType === 'custom-header') {
      const headerName = node.auth_header_name?.trim();
      if (!headerName) {
        throw new Error(`Node "${node.id}" auth_type=custom-header requires auth_header_name`);
      }
      headers[headerName] = node.auth_header_prefix
        ? `${node.auth_header_prefix} ${apiKey}`
        : apiKey;
    } else if (authType === 'x-api-key') {
      if (this.usesGoogleApiKeyHeader(node)) {
        headers['x-goog-api-key'] = apiKey;
      } else {
        headers['x-api-key'] = apiKey;
        headers['anthropic-version'] = nodeHeaders['anthropic-version'] || '2023-06-01';
      }
    } else {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    Object.assign(headers, nodeHeaders);
    return headers;
  }

  private usesGoogleApiKeyHeader(node: NodeConfig): boolean {
    return (
      node.protocol === 'gemini' ||
      node.base_url.toLowerCase().includes('generativelanguage.googleapis.com')
    );
  }

  private buildSyntheticProbeBody(
    node: NodeConfig,
    model: string,
  ): Record<string, unknown> {
    if (node.protocol === 'responses') {
      return {
        model,
        stream: false,
        max_output_tokens: 1,
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'health check' }],
          },
        ],
      };
    }

    if (node.protocol === 'messages') {
      return {
        model,
        stream: false,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'health check' }],
      };
    }

    if (node.protocol === 'gemini') {
      return {
        contents: [{ role: 'user', parts: [{ text: 'health check' }] }],
        generationConfig: { maxOutputTokens: 1 },
      };
    }

    return {
      model,
      stream: false,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'health check' }],
    };
  }

  private recordSuccess(
    node: NodeConfig,
    check: NormalizedHealthCheck,
    latencyMs: number,
  ): ActiveHealthProbeSnapshot {
    const previous = this.statuses.get(node.id);
    const now = new Date().toISOString();
    const snapshot: ActiveHealthProbeSnapshot = {
      enabled: true,
      status: 'healthy',
      method: check.method,
      target: this.describeTarget(node, check),
      last_checked_at: now,
      last_success_at: now,
      latency_ms: latencyMs,
      failure_reason: null,
      consecutive_failures: 0,
    };
    this.statuses.set(node.id, snapshot);
    this.persistProbeSummary(node, snapshot);
    for (const model of this.modelsForCircuit(node)) {
      this.circuitBreaker.recordProbeSuccess(node.id, model);
    }
    if (previous?.status === 'unhealthy') {
      this.alerts?.emit({
        type: 'node_recovered',
        severity: 'info',
        message: `Node recovered: ${node.id}.`,
        dedupeKey: node.id,
        details: {
          node_id: node.id,
          method: check.method,
          target: this.describeTarget(node, check),
          latency_ms: latencyMs,
          previous_failure_reason: previous.failure_reason,
        },
      });
    }
    return snapshot;
  }

  private recordFailure(
    node: NodeConfig,
    check: NormalizedHealthCheck,
    latencyMs: number,
    reason: string,
  ): ActiveHealthProbeSnapshot {
    const previous = this.statuses.get(node.id);
    const snapshot: ActiveHealthProbeSnapshot = {
      enabled: true,
      status: 'unhealthy',
      method: check.method,
      target: this.describeTarget(node, check),
      last_checked_at: new Date().toISOString(),
      last_success_at: previous?.last_success_at ?? null,
      latency_ms: latencyMs,
      failure_reason: reason,
      consecutive_failures: (previous?.consecutive_failures ?? 0) + 1,
    };
    this.statuses.set(node.id, snapshot);
    this.persistProbeSummary(node, snapshot);
    for (const model of this.modelsForCircuit(node)) {
      this.circuitBreaker.markUnavailable(node.id, model, reason);
    }
    if (previous?.status !== 'unhealthy') {
      this.alerts?.emit({
        type: 'node_down',
        severity: 'critical',
        message: `Node down: ${node.id} (${reason}).`,
        dedupeKey: node.id,
        details: {
          node_id: node.id,
          method: check.method,
          target: this.describeTarget(node, check),
          latency_ms: latencyMs,
          failure_reason: reason,
          consecutive_failures: snapshot.consecutive_failures,
        },
      });
    }
    return snapshot;
  }

  private persistProbeSummary(
    node: NodeConfig,
    snapshot: ActiveHealthProbeSnapshot,
  ): void {
    if (!this.stateBackend?.isRedisConfigured()) return;
    this.stateBackend
      .setHashJson(
        'health_probe',
        'nodes',
        node.id,
        {
          node_id: node.id,
          status: snapshot.status,
          last_checked_at: snapshot.last_checked_at,
          last_success_at: snapshot.last_success_at,
          latency_ms: snapshot.latency_ms,
          consecutive_failures: snapshot.consecutive_failures,
        },
      )
      .catch((err) =>
        this.logger.warn(`Health probe state write skipped: ${(err as Error).message}`),
      );
  }

  private modelsForCircuit(node: NodeConfig): Array<string | undefined> {
    return node.models.length > 0 ? node.models : [undefined];
  }

  private initialSnapshot(node: NodeConfig): ActiveHealthProbeSnapshot {
    const check = this.normalizeHealthCheck(node);
    return {
      enabled: check.enabled,
      status: check.enabled ? 'unknown' : 'disabled',
      method: check.enabled ? check.method : null,
      target: check.enabled ? this.describeTarget(node, check) : null,
      last_checked_at: null,
      last_success_at: null,
      latency_ms: null,
      failure_reason: null,
      consecutive_failures: 0,
    };
  }

  private normalizeHealthCheck(node: NodeConfig): NormalizedHealthCheck {
    const raw: NodeHealthCheckConfig = node.health_check || {};
    const rawMethod = raw.method?.toUpperCase();
    const method: HealthCheckMethod =
      rawMethod === 'HEAD' || rawMethod === 'GET' || rawMethod === 'POST'
        ? rawMethod
        : raw.lightweight_model
          ? 'POST'
          : 'HEAD';

    return {
      enabled: node.disabled !== true && (raw.enabled ?? false),
      intervalMs: Math.max(1, raw.interval_seconds ?? 30) * 1000,
      timeoutMs: Math.max(1, raw.timeout_ms ?? Math.min(node.timeout_ms || 5000, 5000)),
      method,
      path: raw.path || node.endpoint,
      lightweightModel: raw.lightweight_model,
    };
  }

  private describeTarget(node: NodeConfig, check: NormalizedHealthCheck): string {
    const model = check.method === 'POST'
      ? ` model=${check.lightweightModel || node.models[0] || 'unknown'}`
      : '';
    return `${check.method} ${check.path}${model}`;
  }

  private buildUrl(baseUrl: string, probePath: string): string {
    if (/^https?:\/\//i.test(probePath)) {
      return probePath;
    }
    const base = baseUrl.replace(/\/+$/, '');
    const path = probePath.startsWith('/') ? probePath : `/${probePath}`;
    return `${base}${path}`;
  }

  private stopNodeTimer(nodeId: string): void {
    const timer = this.timers.get(nodeId);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(nodeId);
      this.timerIntervals.delete(nodeId);
    }
  }

  private stopAll(): void {
    for (const nodeId of this.timers.keys()) {
      this.stopNodeTimer(nodeId);
    }
  }
}

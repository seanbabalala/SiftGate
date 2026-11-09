import { intersectPermissionScopes } from '../auth/permission-scopes';
import {
  BadRequestException,
  Body,
  Controller,
  Optional,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { Repository } from 'typeorm';
import { ChatCompletionsNormalizer } from '../canonical/normalizers/chat-completions.normalizer';
import { EmbeddingsNormalizer } from '../canonical/normalizers/embeddings.normalizer';
import { MediaNormalizer } from '../canonical/normalizers/media.normalizer';
import { MessagesNormalizer } from '../canonical/normalizers/messages.normalizer';
import { RerankNormalizer } from '../canonical/normalizers/rerank.normalizer';
import { ResponsesNormalizer } from '../canonical/normalizers/responses.normalizer';
import {
  CanonicalEmbeddingRequest,
  CanonicalMediaRequest,
  CanonicalMediaSourceFormat,
  CanonicalRequest,
  CanonicalRequestMetadata,
  CanonicalRerankRequest,
} from '../canonical/canonical.types';
import { ConfigService } from '../config/config.service';
import type { NamespaceConfig } from '../config/gateway.config';
import { CallLog, RouteDecisionLog } from '../database/entities';
import { DashboardGuard } from '../auth/dashboard.guard';
import { DashboardRbacGuard } from '../auth/dashboard-rbac.guard';
import { RequireDashboardRole } from '../auth/dashboard-rbac';
import {
  attachGatewayApiKeyMetadata,
} from '../auth/gateway-api-key-metadata';
import {
  GatewayApiKeyContext,
  GatewayApiKeyService,
} from '../auth/gateway-api-key.service';
import { PipelineResult, PipelineService } from '../pipeline/pipeline.service';
import { ErrorEnvelopeDto } from '../openapi/openapi.dto';
import { WorkspaceContextService } from '../workspaces/workspace-context.service';
import {
  normalizeWorkspaceId,
  workspaceFindWhereStrict,
} from '../workspaces/workspace-scope';

type PlaygroundEndpoint =
  | 'chat_completions'
  | 'responses'
  | 'messages'
  | 'embeddings'
  | 'rerank'
  | 'images'
  | 'audio'
  | 'video'
  | 'realtime';

type PlaygroundImageOperation =
  | 'image_generation'
  | 'image_edit'
  | 'image_variation';

type PlaygroundAudioOperation =
  | 'audio_speech'
  | 'audio_transcription'
  | 'audio_translation';

type PlaygroundOperation =
  | PlaygroundEndpoint
  | PlaygroundImageOperation
  | PlaygroundAudioOperation
  | 'video_generation'
  | 'realtime_probe';

interface PlaygroundRunDto {
  endpoint?: PlaygroundEndpoint;
  operation?: PlaygroundOperation;
  model?: string;
  api_key_id?: string | null;
  namespace_id?: string | null;
  routing_hint?: unknown;
  stream?: boolean;
  body?: Record<string, unknown>;
}

interface PlaygroundExecutionResult {
  body: Record<string, unknown> | Buffer | string;
  statusCode: number;
  contentType?: string;
}

type PlaygroundCanonical =
  | CanonicalRequest
  | CanonicalEmbeddingRequest
  | CanonicalRerankRequest
  | CanonicalMediaRequest;

interface PlaygroundScope {
  namespace?: NamespaceConfig;
  effectiveContext?: GatewayApiKeyContext;
}

const TEXT_ENDPOINTS = new Set<PlaygroundEndpoint>([
  'chat_completions',
  'responses',
  'messages',
]);

const DEFAULT_MODEL = 'auto';

@Controller('api/dashboard/playground')
@UseGuards(DashboardGuard, DashboardRbacGuard)
@ApiTags('Dashboard')
@ApiBearerAuth('dashboardSession')
@ApiUnauthorizedResponse({ type: ErrorEnvelopeDto })
export class PlaygroundController {
  private readonly chatNormalizer = new ChatCompletionsNormalizer();
  private readonly responsesNormalizer = new ResponsesNormalizer();
  private readonly messagesNormalizer = new MessagesNormalizer();
  private readonly embeddingsNormalizer = new EmbeddingsNormalizer();
  private readonly rerankNormalizer = new RerankNormalizer();
  private readonly mediaNormalizer = new MediaNormalizer();

  constructor(
    private readonly pipeline: PipelineService,
    private readonly config: ConfigService,
    private readonly gatewayApiKeys: GatewayApiKeyService,
    @InjectRepository(CallLog)
    private readonly callLogRepo: Repository<CallLog>,
    @InjectRepository(RouteDecisionLog)
    private readonly routeDecisionRepo: Repository<RouteDecisionLog>,
    @Optional()
    private readonly workspaceContext?: WorkspaceContextService,
  ) {}

  @Post('run')
  @RequireDashboardRole('operator')
  @ApiOperation({
    summary: 'Run a privacy-safe Dashboard Playground probe',
    description:
      'Runs a minimal operator-triggered probe through the OSS Data Plane without exposing provider keys or storing playground prompt/response bodies. Realtime is an endpoint/capability probe only.',
  })
  @ApiBody({ description: 'Playground endpoint, model, scope, routing hint, stream toggle, and optional sample body.' })
  @ApiOkResponse({ description: 'Request preview, response summary, usage/cost/latency metadata, and route decision link when available.' })
  async run(@Body() input: PlaygroundRunDto) {
    const startedAt = Date.now();
    const endpoint = this.normalizeEndpoint(input.endpoint);
    const operation = this.normalizeOperation(endpoint, input.operation);
    const model = this.normalizeModel(input.model);
    const sessionKey = `playground-${randomUUID()}`;
    const routingHint = this.normalizeRoutingHint(input.routing_hint);
    const stream = Boolean(input.stream && TEXT_ENDPOINTS.has(endpoint));
    const requestBody = this.withModelAndStream(
      input.body && typeof input.body === 'object' ? input.body : this.defaultBody(operation, model),
      model,
      stream,
    );

    if (endpoint === 'realtime') {
      return this.runRealtimeProbe({
        model,
        operation,
        routingHint,
        input,
        requestBody,
        startedAt,
      });
    }

    const headers = this.playgroundHeaders(sessionKey, routingHint);
    const canonical = this.normalizeCanonical(endpoint, operation, requestBody, headers);
    await this.applyPlaygroundScope(canonical, input);

    const execution = await this.execute(canonical, endpoint, stream);
    const log = await this.findPlaygroundLog(sessionKey);
    const decision = log
      ? await this.routeDecisionRepo.findOne({
          where: workspaceFindWhereStrict(this.workspaceId(), {
            request_id: log.request_id,
          }),
        })
      : null;
    const latencyMs = log?.latency_ms ?? Date.now() - startedAt;

    return {
      success: execution.statusCode >= 200 && execution.statusCode < 300,
      endpoint,
      operation,
      stream,
      request: {
        method: 'POST',
        path: this.pathForOperation(operation),
        model,
        api_key_id: input.api_key_id || null,
        namespace_id: input.namespace_id || null,
        routing_hint: routingHint,
        body_preview: this.previewJson(requestBody),
      },
      response_summary: this.summarizeResponse(execution, stream),
      usage: {
        input_tokens: log?.input_tokens ?? 0,
        output_tokens: log?.output_tokens ?? 0,
        total_tokens: (log?.input_tokens ?? 0) + (log?.output_tokens ?? 0),
      },
      cost_usd: Number(Number(log?.cost_usd || 0).toFixed(6)),
      latency_ms: latencyMs,
      status_code: execution.statusCode,
      route_decision: log
        ? {
            request_id: log.request_id,
            link: `/route-decisions/${encodeURIComponent(log.request_id)}`,
            available: Boolean(decision),
          }
        : null,
      privacy: {
        prompt_response_stored: false,
        raw_headers_stored: false,
        provider_keys_exposed: false,
        media_bytes_stored: false,
        standard_call_log_metadata: Boolean(log),
      },
    };
  }

  private async execute(
    canonical: PlaygroundCanonical,
    endpoint: PlaygroundEndpoint,
    stream: boolean,
  ): Promise<PlaygroundExecutionResult> {
    if (stream && this.isTextCanonical(canonical)) {
      const res = new CapturingResponse();
      await this.pipeline.processStream(canonical, res.asExpressResponse());
      return {
        body: res.body(),
        statusCode: res.statusCode,
        contentType: res.contentType(),
      };
    }

    let result: PipelineResult;
    if (endpoint === 'embeddings') {
      result = await this.pipeline.processEmbeddings(canonical as CanonicalEmbeddingRequest);
    } else if (endpoint === 'rerank') {
      result = await this.pipeline.processRerank(canonical as CanonicalRerankRequest);
    } else if (endpoint === 'images' || endpoint === 'audio' || endpoint === 'video') {
      result = await this.pipeline.processMedia(canonical as CanonicalMediaRequest);
    } else {
      result = await this.pipeline.process(canonical as CanonicalRequest);
    }
    return result;
  }

  private normalizeCanonical(
    endpoint: PlaygroundEndpoint,
    operation: PlaygroundOperation,
    body: Record<string, unknown>,
    headers: Record<string, string>,
  ): PlaygroundCanonical {
    switch (endpoint) {
      case 'chat_completions':
        return this.chatNormalizer.normalize(body, headers);
      case 'responses':
        return this.responsesNormalizer.normalize(body, headers);
      case 'messages':
        return this.messagesNormalizer.normalize(body, headers);
      case 'embeddings':
        return this.embeddingsNormalizer.normalize(body, headers);
      case 'rerank':
        return this.rerankNormalizer.normalize(body, headers);
      case 'images':
      case 'audio':
      case 'video':
        return this.mediaNormalizer.normalize(
          body,
          headers,
          this.mediaSourceFormat(operation),
        );
      default:
        throw new BadRequestException(`Unsupported playground endpoint: ${endpoint}`);
    }
  }

  private async applyPlaygroundScope(
    canonical: PlaygroundCanonical,
    input: PlaygroundRunDto,
  ): Promise<void> {
    canonical.metadata.workspace_id = this.workspaceId();
    const scope = await this.resolvePlaygroundScope(input);

    if (scope.effectiveContext) {
      attachGatewayApiKeyMetadata(
        canonical as { metadata: CanonicalRequestMetadata },
        scope.effectiveContext,
      );
      return;
    }

    const namespace = scope.namespace;
    if (!namespace) return;
    canonical.metadata.namespace_id = namespace.id;
    canonical.metadata.namespace_name = namespace.name || namespace.id;
    canonical.metadata.api_key_permissions = {
      allow_auto: true,
      allow_direct: true,
      allowed_nodes: namespace.allowed_nodes || [],
      allowed_models: namespace.allowed_models || [],
      allowed_endpoints: [],
      allowed_modalities: [],
    };
  }

  private async resolvePlaygroundScope(input: PlaygroundRunDto): Promise<PlaygroundScope> {
    const apiKeyContext = input.api_key_id
      ? await this.gatewayApiKeys.getContextById(input.api_key_id)
      : undefined;
    const namespace = input.namespace_id
      ? this.requireNamespace(input.namespace_id)
      : undefined;
    return {
      namespace,
      effectiveContext: apiKeyContext
        ? this.applyNamespaceOverride(apiKeyContext, namespace)
        : undefined,
    };
  }

  private applyNamespaceOverride(
    context: GatewayApiKeyContext,
    namespace: NamespaceConfig | undefined,
  ): GatewayApiKeyContext {
    if (!namespace) return context;
    return {
      ...context,
      allowed_nodes: intersectPermissionScopes(
        context.allowed_nodes,
        namespace.allowed_nodes || [],
      ),
      allowed_models: intersectPermissionScopes(
        context.allowed_models,
        namespace.allowed_models || [],
      ),
      namespace_id: namespace.id,
      namespace_name: namespace.name || namespace.id,
      rate_limit_per_minute: this.combineRateLimit(
        context.rate_limit_per_minute,
        namespace.rate_limit?.requests_per_minute,
      ),
    };
  }

  private combineRateLimit(
    left: number | null,
    right: number | null | undefined,
  ): number | null {
    const values = [left, right].filter(
      (value): value is number => typeof value === 'number' && value > 0,
    );
    return values.length > 0 ? Math.min(...values) : null;
  }

  private isRealtimeAllowedByScope(
    scope: PlaygroundScope,
    model: string,
  ): { allowed: boolean; statusCode: number; message?: string } {
    const context = scope.effectiveContext;
    const allowedEndpoints = context?.allowed_endpoints || [];
    const allowedModalities = context?.allowed_modalities || [];
    const allowedModels = context?.allowed_models || scope.namespace?.allowed_models || [];

    if (allowedEndpoints.length > 0 && !allowedEndpoints.includes('realtime')) {
      return {
        allowed: false,
        statusCode: 403,
        message: 'Selected API key is not allowed to use the realtime endpoint.',
      };
    }
    if (allowedModalities.length > 0 && !allowedModalities.includes('realtime')) {
      return {
        allowed: false,
        statusCode: 403,
        message: 'Selected API key is not allowed to use the realtime modality.',
      };
    }
    if (
      model !== DEFAULT_MODEL &&
      allowedModels.length > 0 &&
      !allowedModels.includes(model)
    ) {
      return {
        allowed: false,
        statusCode: 403,
        message: `Selected scope is not allowed to use realtime model "${model}".`,
      };
    }
    return { allowed: true, statusCode: 200 };
  }

  private requireNamespace(namespaceId: string): NamespaceConfig {
    const namespace = this.config.getNamespace(namespaceId);
    if (!namespace) {
      throw new BadRequestException(`Unknown namespace_id: ${namespaceId}`);
    }
    return namespace;
  }

  private async runRealtimeProbe(params: {
    model: string;
    operation: PlaygroundOperation;
    routingHint: unknown;
    input: PlaygroundRunDto;
    requestBody: Record<string, unknown>;
    startedAt: number;
  }) {
    const scope = await this.resolvePlaygroundScope(params.input);
    const scopeAllowed = this.isRealtimeAllowedByScope(scope, params.model);
    const allowedNodes =
      scope.effectiveContext?.allowed_nodes || scope.namespace?.allowed_nodes || [];
    const allowedModels =
      scope.effectiveContext?.allowed_models || scope.namespace?.allowed_models || [];
    const realtime = this.config.realtime;
    const candidates = this.config.nodes
      .filter((node) => (node.realtime_models || []).length > 0)
      .filter((node) => allowedNodes.length === 0 || allowedNodes.includes(node.id))
      .filter(
        (node) =>
          params.model === DEFAULT_MODEL
            ? allowedModels.length === 0 ||
              (node.realtime_models || []).some((model) => allowedModels.includes(model))
            : (node.realtime_models || []).includes(params.model),
      )
      .map((node) => ({
        node: node.id,
        models: allowedModels.length > 0
          ? (node.realtime_models || []).filter((model) => allowedModels.includes(model))
          : node.realtime_models || [],
        endpoint: node.realtime_endpoint || null,
      }));
    const statusCode = !scopeAllowed.allowed
      ? scopeAllowed.statusCode
      : realtime.enabled && candidates.length > 0
        ? 200
        : 400;
    const message = !scopeAllowed.allowed
      ? scopeAllowed.message
      : !realtime.enabled
      ? 'Realtime preview is disabled in gateway config.'
      : candidates.length === 0
        ? 'No realtime-capable node matches this model.'
        : 'Realtime endpoint/auth/capability probe passed. No WebSocket session was opened.';

    return {
      success: statusCode === 200,
      endpoint: 'realtime',
      operation: params.operation,
      stream: false,
      request: {
        method: 'GET',
        path: realtime.path,
        model: params.model,
        api_key_id: params.input.api_key_id || null,
        namespace_id: params.input.namespace_id || null,
        routing_hint: params.routingHint,
        body_preview: this.previewJson(params.requestBody),
      },
      response_summary: {
        status_code: statusCode,
        content_type: 'application/json',
        body_type: 'json',
        body_preview: this.previewJson({
          message,
          candidates,
          max_connections: realtime.max_connections,
          max_connections_per_node: realtime.max_connections_per_node,
          probe_only: true,
        }),
        bytes: 0,
        event_count: 0,
        truncated: false,
      },
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      cost_usd: 0,
      latency_ms: Date.now() - params.startedAt,
      status_code: statusCode,
      route_decision: null,
      privacy: {
        prompt_response_stored: false,
        raw_headers_stored: false,
        provider_keys_exposed: false,
        media_bytes_stored: false,
        standard_call_log_metadata: false,
      },
    };
  }

  private async findPlaygroundLog(sessionKey: string): Promise<CallLog | null> {
    return this.callLogRepo.findOne({
      where: workspaceFindWhereStrict(this.workspaceId(), {
        session_key: sessionKey,
      }),
      order: { timestamp: 'DESC' },
    });
  }

  private workspaceId(): string {
    return normalizeWorkspaceId(this.workspaceContext?.currentWorkspaceId());
  }

  private normalizeEndpoint(value: unknown): PlaygroundEndpoint {
    const endpoint = String(value || 'chat_completions') as PlaygroundEndpoint;
    const allowed: PlaygroundEndpoint[] = [
      'chat_completions',
      'responses',
      'messages',
      'embeddings',
      'rerank',
      'images',
      'audio',
      'video',
      'realtime',
    ];
    if (!allowed.includes(endpoint)) {
      throw new BadRequestException(`Unsupported playground endpoint: ${endpoint}`);
    }
    return endpoint;
  }

  private normalizeOperation(
    endpoint: PlaygroundEndpoint,
    value: unknown,
  ): PlaygroundOperation {
    const operation = String(value || '');
    if (endpoint === 'images') {
      if (
        operation === 'image_edit' ||
        operation === 'image_variation' ||
        operation === 'image_generation'
      ) {
        return operation;
      }
      return 'image_generation';
    }
    if (endpoint === 'audio') {
      if (
        operation === 'audio_transcription' ||
        operation === 'audio_translation' ||
        operation === 'audio_speech'
      ) {
        return operation;
      }
      return 'audio_speech';
    }
    if (endpoint === 'video') return 'video_generation';
    if (endpoint === 'realtime') return 'realtime_probe';
    return endpoint;
  }

  private normalizeModel(value: unknown): string {
    const model = typeof value === 'string' ? value.trim() : '';
    return model || DEFAULT_MODEL;
  }

  private normalizeRoutingHint(value: unknown): unknown {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) return null;
      try {
        return JSON.parse(trimmed);
      } catch {
        return trimmed;
      }
    }
    return value;
  }

  private playgroundHeaders(
    sessionKey: string,
    routingHint: unknown,
  ): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-session-key': sessionKey,
      'x-siftgate-playground': 'true',
    };
    if (routingHint) {
      headers['x-siftgate-routing-hint'] =
        typeof routingHint === 'string' ? routingHint : JSON.stringify(routingHint);
    }
    return headers;
  }

  private withModelAndStream(
    body: Record<string, unknown>,
    model: string,
    stream: boolean,
  ): Record<string, unknown> {
    return {
      ...body,
      model,
      ...(stream ? { stream: true } : {}),
    };
  }

  private defaultBody(
    operation: PlaygroundOperation,
    model: string,
  ): Record<string, unknown> {
    switch (operation) {
      case 'chat_completions':
        return {
          model,
          messages: [
            {
              role: 'user',
              content: 'Reply with one short sentence from the SiftGate playground.',
            },
          ],
          max_tokens: 64,
        };
      case 'responses':
        return {
          model,
          input: 'Reply with one short sentence from the SiftGate playground.',
          max_output_tokens: 64,
        };
      case 'messages':
        return {
          model,
          max_tokens: 64,
          messages: [
            {
              role: 'user',
              content: 'Reply with one short sentence from the SiftGate playground.',
            },
          ],
        };
      case 'embeddings':
        return { model, input: 'SiftGate playground embedding probe.' };
      case 'rerank':
        return {
          model,
          query: 'What is SiftGate?',
          documents: [
            'SiftGate is a self-hosted AI traffic gateway.',
            'This is a short unrelated sample.',
          ],
          top_n: 1,
        };
      case 'image_edit':
        return {
          model,
          prompt: 'Safe image edit probe. Provide a small JSON error if files are required.',
        };
      case 'image_variation':
        return {
          model,
          prompt: 'Safe image variation probe. Provide a small JSON error if files are required.',
        };
      case 'image_generation':
        return {
          model,
          prompt: 'A small clean SiftGate status icon on a neutral background.',
          size: '1024x1024',
          n: 1,
        };
      case 'audio_transcription':
      case 'audio_translation':
        return {
          model,
          response_format: 'json',
          note: 'Playground safe probe uses JSON only; upload media through client SDK or curl.',
        };
      case 'audio_speech':
        return {
          model,
          input: 'SiftGate playground audio probe.',
          voice: 'alloy',
          response_format: 'mp3',
        };
      case 'video_generation':
        return {
          model,
          prompt: 'A three second abstract loading animation for a dashboard.',
          duration: 3,
          size: '720x1280',
        };
      case 'realtime_probe':
        return { model, probe_only: true };
      default:
        return { model };
    }
  }

  private mediaSourceFormat(
    operation: PlaygroundOperation,
  ): CanonicalMediaSourceFormat {
    if (
      operation === 'image_generation' ||
      operation === 'image_edit' ||
      operation === 'image_variation' ||
      operation === 'audio_transcription' ||
      operation === 'audio_translation' ||
      operation === 'audio_speech' ||
      operation === 'video_generation'
    ) {
      return operation;
    }
    throw new BadRequestException(`Unsupported media playground operation: ${operation}`);
  }

  private pathForOperation(operation: PlaygroundOperation): string {
    switch (operation) {
      case 'chat_completions':
        return '/v1/chat/completions';
      case 'responses':
        return '/v1/responses';
      case 'messages':
        return '/v1/messages';
      case 'embeddings':
        return '/v1/embeddings';
      case 'rerank':
        return '/v1/rerank';
      case 'image_generation':
        return '/v1/images/generations';
      case 'image_edit':
        return '/v1/images/edits';
      case 'image_variation':
        return '/v1/images/variations';
      case 'audio_transcription':
        return '/v1/audio/transcriptions';
      case 'audio_translation':
        return '/v1/audio/translations';
      case 'audio_speech':
        return '/v1/audio/speech';
      case 'video_generation':
        return '/v1/videos/generations';
      case 'realtime_probe':
        return this.config.realtime.path;
      default:
        return '/v1';
    }
  }

  private summarizeResponse(
    execution: PlaygroundExecutionResult,
    stream: boolean,
  ) {
    const contentType = execution.contentType || 'application/json';
    const body = execution.body;
    const bodyType = Buffer.isBuffer(body)
      ? 'binary'
      : typeof body === 'string'
        ? stream
          ? 'sse'
          : 'text'
        : 'json';
    const text = Buffer.isBuffer(body)
      ? `<${body.length} binary bytes>`
      : typeof body === 'string'
        ? body
        : this.previewJson(body);
    const preview = this.truncate(text, 6000);
    return {
      status_code: execution.statusCode,
      content_type: contentType,
      body_type: bodyType,
      body_preview: preview.value,
      bytes: Buffer.isBuffer(body)
        ? body.length
        : Buffer.byteLength(typeof body === 'string' ? body : JSON.stringify(body)),
      event_count: stream && typeof body === 'string'
        ? body.split('\n\n').filter((line) => line.trim()).length
        : 0,
      truncated: preview.truncated,
    };
  }

  private previewJson(value: unknown): string {
    return this.truncate(JSON.stringify(value, null, 2), 6000).value;
  }

  private truncate(value: string, max: number): { value: string; truncated: boolean } {
    if (value.length <= max) return { value, truncated: false };
    return { value: `${value.slice(0, max)}\n...`, truncated: true };
  }

  private isTextCanonical(canonical: PlaygroundCanonical): canonical is CanonicalRequest {
    return 'messages' in canonical && 'stream' in canonical;
  }
}

class CapturingResponse {
  statusCode = 200;
  headersSent = false;
  writableEnded = false;
  private readonly headers = new Map<string, string>();
  private readonly chunks: Buffer[] = [];
  private jsonBody: unknown;

  asExpressResponse() {
    return this as never;
  }

  setHeader(name: string, value: string): this {
    this.headers.set(name.toLowerCase(), value);
    return this;
  }

  flushHeaders(): void {
    this.headersSent = true;
  }

  write(chunk: string | Buffer): boolean {
    this.headersSent = true;
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    return true;
  }

  end(chunk?: string | Buffer): this {
    if (chunk !== undefined) this.write(chunk);
    this.writableEnded = true;
    return this;
  }

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  json(body: unknown): this {
    this.jsonBody = body;
    this.setHeader('content-type', 'application/json');
    this.write(JSON.stringify(body));
    return this.end();
  }

  type(value: string): this {
    this.setHeader('content-type', value);
    return this;
  }

  send(body: string | Buffer | object): this {
    if (Buffer.isBuffer(body)) {
      this.write(body);
    } else if (typeof body === 'string') {
      this.write(body);
    } else {
      this.jsonBody = body;
      this.setHeader('content-type', 'application/json');
      this.write(JSON.stringify(body));
    }
    return this.end();
  }

  on(): this {
    return this;
  }

  off(): this {
    return this;
  }

  contentType(): string | undefined {
    return this.headers.get('content-type');
  }

  body(): Record<string, unknown> | Buffer | string {
    if (this.jsonBody && !this.contentType()?.includes('text/event-stream')) {
      return this.jsonBody as Record<string, unknown>;
    }
    const buffer = Buffer.concat(this.chunks);
    const contentType = this.contentType() || '';
    if (!contentType || contentType.includes('json') || contentType.startsWith('text/')) {
      return buffer.toString('utf8');
    }
    return buffer;
  }
}

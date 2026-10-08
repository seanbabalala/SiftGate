import { videoResultProfile, translateNativeVideoResult, nativeVideoRequestShape, nativeVideoGenerationPath } from "../pricing/video-result-profile";
import { providerFailureUsage } from "./provider-failure-evidence";
import type { ProviderAttemptObserver, ProviderAttemptReceipt } from "./provider-attempt.types";
import { mediaJobId } from "../pricing/media-task-metering";
import { isMeteredRequest, meterMediaUsage, meterRerankProviderUsage, mediaPricingContext } from "../pricing/media-metering";
import { attachUsageEvidence, getUsageEvidence } from '../canonical/usage-evidence';
import { attachTokenPricingEvidence } from './pricing-usage-evidence';
import { geminiCompatibilityUsage, isNativeGeminiUsageSchema } from './gemini-pricing-usage';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { SpanKind } from '@opentelemetry/api';
import { ConfigService } from '../config/config.service';
import { NodeConfig, NodeProtocol } from '../config/gateway.config';
import { resolveNodeUsageSchema } from '../catalog/compatibility-profiles';
import {
  CanonicalRequest,
  CanonicalEmbeddingRequest,
  CanonicalEmbeddingResponse,
  CanonicalRerankRequest,
  CanonicalRerankResponse,
  CanonicalMediaRequest,
  CanonicalMediaResponse,
  CanonicalMediaSourceFormat,
  CanonicalResponse,
  CanonicalContentBlock,
  CanonicalStreamEvent,
  StopReason,
  Tier,
  TokenUsage,
} from '../canonical/canonical.types';
import { ChatCompletionsDenormalizer } from '../canonical/denormalizers/chat-completions.denormalizer';
import { ResponsesDenormalizer } from '../canonical/denormalizers/responses.denormalizer';
import { MessagesDenormalizer } from '../canonical/denormalizers/messages.denormalizer';
import { GeminiDenormalizer } from '../canonical/denormalizers/gemini.denormalizer';
import { toAnthropicMessagesOutputFormat } from '../canonical/structured-output';
import { toAnthropicThinking } from '../canonical/reasoning-effort';
import { ChatCompletionsStreamParser } from './stream/chat-completions.stream';
import { ResponsesStreamParser } from './stream/responses.stream';
import { MessagesStreamParser } from './stream/messages.stream';
import { GeminiStreamParser } from './stream/gemini.stream';
import { classifyStreamError } from './stream/stream-error-classifier';
import { TelemetryService } from '../telemetry/telemetry.service';
import type {
  StreamLifecycleMetricEvent,
  StreamLifecycleMetricPhase,
  StreamLifecycleMetricReason,
} from '../telemetry/telemetry.service';
import { UpstreamConnectionPoolService } from './upstream-connection-pool.service';
import { SecretReferenceResolverService } from '../config/secret-reference-resolver.service';
import {
  CredentialPoolService,
  CredentialSelection,
} from './credential-pool.service';
import {
  extractUsageBySchema,
  extractUsageByKnownFields,
  UsageSchema,
} from './usage-schema-resolver';
import {
  redactProviderErrorText,
  sanitizeProviderErrorBody,
} from './provider-error-redaction';
import type { ErrorRedactionTelemetry } from '../security/error-redaction';
import type { Dispatcher } from 'undici';

type FetchOptionsWithDispatcher = RequestInit & { dispatcher?: Dispatcher };

function isUndiciTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const typed = error as { name?: string; code?: string };
  return (
    typed.name === 'HeadersTimeoutError' ||
    typed.name === 'BodyTimeoutError' ||
    typed.code === 'UND_ERR_HEADERS_TIMEOUT' ||
    typed.code === 'UND_ERR_BODY_TIMEOUT'
  );
}

/**
 * `fetch` collapses every transport failure into "fetch failed" and keeps the
 * real reason on `err.cause`. Surface it, otherwise a tunnel/route problem and
 * a dead upstream are indistinguishable in the logs.
 */
function describeFetchError(error: unknown): string {
  if (!(error instanceof Error)) return 'Unknown fetch error';
  const cause = (error as { cause?: unknown }).cause;
  if (!cause) return error.message;

  if (cause instanceof AggregateError) {
    const detail = Array.from(cause.errors as unknown[])
      .map(describeErrorCause)
      .filter((part) => part.length > 0)
      .join('; ');
    return detail ? `${error.message} (${detail})` : error.message;
  }

  const detail = describeErrorCause(cause);
  return detail ? `${error.message} (${detail})` : error.message;
}

function describeErrorCause(cause: unknown): string {
  if (!(cause instanceof Error)) return '';
  const code = (cause as { code?: unknown }).code;
  return typeof code === 'string' && code ? `${code}: ${cause.message}` : cause.message;
}

interface ProviderRequestOptions {
  pricingAttempts?: ProviderAttemptObserver;
  credentialAttemptLimit?: number;
  singleAttempt?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

interface ResponseCredentialMetadata {
  selection: CredentialSelection;
  retryCount: number;
}

@Injectable()
export class ProviderClientService {
  private readonly logger = new Logger(ProviderClientService.name);
  private readonly allowedAnthropicBetas = new Set([
    'claude-code-20250219',
    'interleaved-thinking-2025-05-14',
    'context-management-2025-06-27',
    'context-1m-2025-08-07',
    'fast-mode-2026-02-01',
  ]);

  private readonly chatDenorm = new ChatCompletionsDenormalizer();
  private readonly respDenorm = new ResponsesDenormalizer();
  private readonly msgDenorm = new MessagesDenormalizer();
  private readonly geminiDenorm = new GeminiDenormalizer();
  private readonly responseCredentials = new WeakMap<Response, ResponseCredentialMetadata>();
  private readonly responsePricingReceipts = new WeakMap<Response, ProviderAttemptReceipt>();
  private readonly responseAbortCleanups = new WeakMap<Response, () => void>();
  private readonly completedCredentialResponses = new WeakSet<Response>();

  constructor(
    private readonly config: ConfigService,
    private readonly telemetry: TelemetryService,
    @Optional()
    private readonly connectionPool?: UpstreamConnectionPoolService,
    @Optional()
    private readonly secretResolver?: SecretReferenceResolverService,
    @Optional()
    private readonly credentialPool?: CredentialPoolService,
  ) {}

  // ══════════════════════════════════════════════════════
  // Non-Streaming Forward
  // ══════════════════════════════════════════════════════

  async forward(
    canonical: CanonicalRequest,
    nodeId: string,
    targetModel: string,
    routingMeta: {
      tier: Tier;
      score: number;
      is_fallback: boolean;
      fallback_reason?: string | null;
    },
    options: ProviderRequestOptions = {},
  ): Promise<CanonicalResponse> {
    return this.telemetry.withSpan(
      'gateway.upstream',
      {
        'gateway.upstream.node': nodeId,
        'gateway.upstream.model': targetModel,
        'gateway.upstream.is_fallback': routingMeta.is_fallback,
        'gen_ai.system': canonical.metadata.source_format,
        'gen_ai.request.model': targetModel,
      },
      async (span) => {
        const node = this.config.getNode(nodeId);
        if (!node) throw new Error(`Node not found: ${nodeId}`);

        const startTime = Date.now();
        const upstreamModel = this.resolveUpstreamModel(node, targetModel);
        const requestBody = this.denormalizeRequest(canonical, node.protocol, upstreamModel);
        this.applyNodeRequestCompatibility(
          node,
          requestBody,
          this.shouldPassthroughNativeResponses(canonical, node.protocol),
        );
        this.applyStreamFlag(node, requestBody, false);

        const response = await this.sendRequest(
          node,
          requestBody,
          canonical,
          options.timeoutMs,
          options.signal,
          this.resolveRequestEndpoint(node, upstreamModel, false),
          false, 0, options.credentialAttemptLimit, options.pricingAttempts,
          canonical.metadata.source_format, upstreamModel,
        );
        const latencyMs = Date.now() - startTime;

        this.telemetry.upstreamDuration.record(latencyMs, { node: nodeId, model: targetModel });

        const responseBody = await this.readJsonResponse(response, node);
        const usageSchema = this.resolveUsageSchemaForNode(node);
        const canonical_resp = this.normalizeResponse(
          responseBody,
          node.protocol,
          routingMeta,
          nodeId,
          targetModel,
          latencyMs,
          usageSchema,
        );
        attachTokenPricingEvidence(responseBody, canonical_resp.usage, usageSchema);
        this.applyCredentialRoutingMetadata(canonical_resp.routing, response);
        this.recordResponseCredentialUsage(response, canonical_resp.usage, canonical.metadata);

        // GenAI semantic attributes
        span.setAttributes({
          'gen_ai.usage.input_tokens': canonical_resp.usage.input_tokens,
          'gen_ai.usage.output_tokens': canonical_resp.usage.output_tokens,
          'gateway.upstream.latency_ms': latencyMs,
        });

        return canonical_resp;
      },
      SpanKind.CLIENT,
    );
  }

  async forwardEmbeddings(
    canonical: CanonicalEmbeddingRequest,
    nodeId: string,
    targetModel: string,
    routingMeta: {
      tier: Tier;
      score: number;
      is_fallback: boolean;
      fallback_reason?: string | null;
    },
    options: ProviderRequestOptions = {},
  ): Promise<CanonicalEmbeddingResponse> {
    return this.telemetry.withSpan(
      'gateway.upstream.embeddings',
      {
        'gateway.upstream.node': nodeId,
        'gateway.upstream.model': targetModel,
        'gateway.upstream.is_fallback': routingMeta.is_fallback,
        'gen_ai.system': 'embeddings',
        'gen_ai.request.model': targetModel,
      },
      async (span) => {
        const node = this.config.getNode(nodeId);
        if (!node) throw new Error(`Node not found: ${nodeId}`);

        const startTime = Date.now();
        const requestBody = this.buildEmbeddingsRequest(canonical, targetModel);
        const response = await this.sendRequest(
          node,
          requestBody,
          undefined,
          options.timeoutMs,
          options.signal,
          node.embeddings_endpoint || '/v1/embeddings',
          false, 0, options.credentialAttemptLimit, options.pricingAttempts,
          canonical.metadata.source_format, targetModel,
        );
        const latencyMs = Date.now() - startTime;

        this.telemetry.upstreamDuration.record(latencyMs, { node: nodeId, model: targetModel });

        const responseBody = await this.readJsonResponse(response, node);
        const canonicalResp = this.normalizeEmbeddingsResponse(
          responseBody as Record<string, unknown>,
          routingMeta,
          nodeId,
          targetModel,
          latencyMs,
        );
        attachTokenPricingEvidence(responseBody, canonicalResp.usage, undefined, 'embeddings');
        this.applyCredentialRoutingMetadata(canonicalResp.routing, response);
        this.recordResponseCredentialUsage(response, canonicalResp.usage, canonical.metadata);
        span.setAttributes({
          'gen_ai.usage.input_tokens': canonicalResp.usage.input_tokens,
          'gen_ai.usage.output_tokens': canonicalResp.usage.output_tokens,
          'gateway.upstream.latency_ms': latencyMs,
        });
        return canonicalResp;
      },
      SpanKind.CLIENT,
    );
  }

  async forwardRerank(
    canonical: CanonicalRerankRequest,
    nodeId: string,
    targetModel: string,
    routingMeta: {
      tier: Tier;
      score: number;
      is_fallback: boolean;
      fallback_reason?: string | null;
    },
    options: ProviderRequestOptions = {},
  ): Promise<CanonicalRerankResponse> {
    return this.telemetry.withSpan(
      'gateway.upstream.rerank',
      {
        'gateway.upstream.node': nodeId,
        'gateway.upstream.model': targetModel,
        'gateway.upstream.is_fallback': routingMeta.is_fallback,
        'gen_ai.system': 'rerank',
        'gen_ai.request.model': targetModel,
      },
      async (span) => {
        const node = this.config.getNode(nodeId);
        if (!node) throw new Error(`Node not found: ${nodeId}`);

        const startTime = Date.now();
        const requestBody = this.buildRerankRequest(canonical, targetModel);
        const response = await this.sendRequest(
          node,
          requestBody,
          undefined,
          options.timeoutMs,
          options.signal,
          node.rerank_endpoint || '/v1/rerank',
          false, 0, options.credentialAttemptLimit, options.pricingAttempts,
          canonical.metadata.source_format, targetModel,
        );
        const latencyMs = Date.now() - startTime;

        this.telemetry.upstreamDuration.record(latencyMs, { node: nodeId, model: targetModel });

        const responseBody = await this.readJsonResponse(response, node);
        const canonicalResp = this.normalizeRerankResponse(
          responseBody as Record<string, unknown>,
          canonical,
          routingMeta,
          nodeId,
          targetModel,
          latencyMs,
        );
        attachTokenPricingEvidence(responseBody.usage === undefined && responseBody.meta ? { usage: responseBody.meta } : responseBody, canonicalResp.usage, undefined, 'rerank');
        const billing = getUsageEvidence(canonicalResp.usage);
        // A 2xx job acknowledgement is not final billed work. There is no rerank
        // job adapter yet: retain the dispatch/hold instead of settling a fee from
        // a locally inferred invocation count or provisional document counters.
        const pending = response.status === 202 || responseBody.done === false ||
          ['queued', 'pending', 'processing', 'in_progress', 'submitted', 'running'].includes(String(responseBody.status ?? responseBody.state ?? responseBody.phase ?? '').toLowerCase());
        attachUsageEvidence(canonicalResp.usage, { ...billing, usage: meterRerankProviderUsage(canonical, canonicalResp, responseBody, billing?.usage), mediaContext: mediaPricingContext(canonical, canonicalResp),
          ...(pending ? { pendingJob: { providerJobId: mediaJobId(responseBody) ?? undefined } } : {}) });
        this.applyCredentialRoutingMetadata(canonicalResp.routing, response);
        this.recordResponseCredentialUsage(response, canonicalResp.usage, canonical.metadata);
        span.setAttributes({
          'gen_ai.usage.input_tokens': canonicalResp.usage.input_tokens,
          'gen_ai.usage.output_tokens': canonicalResp.usage.output_tokens,
          'gateway.upstream.latency_ms': latencyMs,
        });
        return canonicalResp;
      },
      SpanKind.CLIENT,
    );
  }

  async forwardMedia(
    canonical: CanonicalMediaRequest,
    nodeId: string,
    targetModel: string,
    routingMeta: {
      tier: Tier;
      score: number;
      is_fallback: boolean;
      fallback_reason?: string | null;
    },
    options: ProviderRequestOptions = {},
  ): Promise<CanonicalMediaResponse> {
    return this.telemetry.withSpan(
      `gateway.upstream.${canonical.source_format}`,
      {
        'gateway.upstream.node': nodeId,
        'gateway.upstream.model': targetModel,
        'gateway.upstream.is_fallback': routingMeta.is_fallback,
        'gen_ai.system': canonical.source_format,
        'gen_ai.request.model': targetModel,
        'gateway.media.type': canonical.media.media_type,
        'gateway.media.operation': canonical.media.operation,
        'gateway.media.multipart': canonical.media.multipart,
        'gateway.media.byte_size': canonical.media.byte_size,
      },
      async (span) => {
        const node = this.config.getNode(nodeId);
        if (!node) throw new Error(`Node not found: ${nodeId}`);

        const startTime = Date.now();
        const profile = canonical.source_format === 'video_generation' ? videoResultProfile(node.video_result_profile) : 'generic-v1';
        const upstreamModel = profile === 'generic-v1' ? targetModel : this.resolveUpstreamModel(node, targetModel);
        if (canonical.source_format === 'video_generation' &&
          (profile === 'generic-v1' ? !Buffer.isBuffer(canonical.payload) && typeof canonical.payload.prompt !== 'string' : !nativeVideoRequestShape(profile, canonical.payload)))
          throw new ProviderError('Video request envelope does not match the explicitly selected node profile', 400, nodeId, 'http_error');
        const configuredEndpoint = this.mediaEndpointFor(node, canonical.source_format);
        const endpoint = profile === 'generic-v1' ? configuredEndpoint : nativeVideoGenerationPath(profile, configuredEndpoint, upstreamModel);
        const request = this.buildMediaRequest(canonical, upstreamModel);
        if (profile === 'gemini-veo-rest-v1' && !Buffer.isBuffer(request.body)) delete request.body.model;
        const response = await this.sendMediaRequest(
          node,
          request,
          endpoint,
          options.timeoutMs,
          options.signal,
          options.singleAttempt,
          options.credentialAttemptLimit,
          options.pricingAttempts,
          upstreamModel,
          canonical.source_format,
        );
        const latencyMs = Date.now() - startTime;

        this.telemetry.upstreamDuration.record(latencyMs, { node: nodeId, model: targetModel });
        let canonicalResp: CanonicalMediaResponse;
        try {
          canonicalResp = await this.normalizeMediaResponse(
            response,
            canonical,
            routingMeta,
            nodeId,
            targetModel,
            latencyMs,
          );
          if (isMeteredRequest(canonical)) {
            const billingBody = canonicalResp.body && typeof canonicalResp.body === 'object' && !Buffer.isBuffer(canonicalResp.body) && !Array.isArray(canonicalResp.body) ? canonicalResp.body : {};
            const native = profile !== 'generic-v1' ? translateNativeVideoResult(profile, billingBody) : null;
            if (!native) attachTokenPricingEvidence(billingBody, canonicalResp.usage, undefined, canonical.source_format);
            const billing = getUsageEvidence(canonicalResp.usage);
            const safeJobId = native?.provider_job_id ?? mediaJobId(billingBody) ?? undefined;
            const jobStatus = String(billingBody.status ?? billingBody.state ?? billingBody.phase ?? '').toLowerCase();
            const pending = !!native || response.status === 202 || billingBody.done === false || ['queued', 'pending', 'processing', 'in_progress', 'submitted', 'running'].includes(jobStatus) || !!safeJobId && (typeof billingBody.done === 'boolean' || ['completed', 'succeeded', 'success', 'done', 'partially_completed', 'failed', 'cancelled', 'canceled', 'rejected'].includes(jobStatus));
            attachUsageEvidence(canonicalResp.usage, { ...billing, usage: meterMediaUsage(canonical, canonicalResp, 'result', billing?.usage, profile), mediaContext: mediaPricingContext(canonical, canonicalResp, profile), ...(pending ? { pendingJob: { providerJobId: safeJobId } } : {}) });
          }
          this.applyCredentialRoutingMetadata(canonicalResp.routing, response);
          this.recordResponseCredentialUsage(response, canonicalResp.usage, canonical.metadata);
          this.completeResponseCredential(response, {
            statusCode: response.status,
          });
        } catch (err) {
          this.completeResponseCredential(response, {
            statusCode: response.status,
            error: err instanceof Error ? err.message : 'media_response_error',
          });
          throw err;
        }
        span.setAttributes({
          'gen_ai.usage.input_tokens': canonicalResp.usage.input_tokens,
          'gen_ai.usage.output_tokens': canonicalResp.usage.output_tokens,
          'gateway.upstream.latency_ms': latencyMs,
        });
        return canonicalResp;
      },
      SpanKind.CLIENT,
    );
  }

  // ══════════════════════════════════════════════════════
  // Streaming Forward
  // ══════════════════════════════════════════════════════

  /**
   * Forward a canonical request as a stream.
   * Returns an async generator of CanonicalStreamEvent.
   *
   * Throws ProviderError during connection phase (before first chunk).
   * After first chunk is yielded, errors are emitted as StreamErrorEvent.
   */
  async *forwardStream(
    canonical: CanonicalRequest,
    nodeId: string,
    targetModel: string,
    options: ProviderRequestOptions = {},
  ): AsyncGenerator<CanonicalStreamEvent> {
    const node = this.config.getNode(nodeId);
    if (!node) throw new Error(`Node not found: ${nodeId}`);

    const upstreamModel = this.resolveUpstreamModel(node, targetModel);
    const passthroughNativeStream = this.shouldPassthroughRawSse(
      canonical,
      node.protocol,
    );
    const requestBody = this.denormalizeRequest(canonical, node.protocol, upstreamModel);
    this.applyNodeRequestCompatibility(
      node,
      requestBody,
      this.shouldPassthroughNativeResponses(canonical, node.protocol),
    );
    this.applyStreamFlag(node, requestBody, true);

    const response = await this.sendRequest(
      node,
      requestBody,
      canonical,
      options.timeoutMs,
      options.signal,
      this.resolveRequestEndpoint(node, upstreamModel, true),
      true, 0, options.credentialAttemptLimit, options.pricingAttempts,
      canonical.metadata.source_format, upstreamModel,
    );

    if (!response.body) {
      throw new ProviderError(`No response body from ${node.id}`, 502, nodeId);
    }

    // Parse the SSE stream
    const parser = this.createStreamParser(
      node.protocol,
      this.resolveUsageSchemaForNode(node),
    );
    let latestUsage: TokenUsage | undefined;
    let pricingFailure: string | undefined;
    let pricingResponseModel: string | undefined;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const streamBodyIdleTimeoutMs = this.resolveStreamBodyIdleTimeoutMs(
      node,
      options.timeoutMs,
    );
    const streamMaxDurationMs = this.resolveStreamMaxDurationMs(node);
    const streamStartedAtMs = Date.now();
    const parseChunk = (chunk: string): CanonicalStreamEvent[] => {
      const parsedEvents = [...parser.parse(chunk)];
      for (const event of parsedEvents) {
        if (event.type === 'start') pricingResponseModel = event.model;
        if (event.type === 'stop') {
          latestUsage = event.usage;
        } else if (event.type === 'error') {
          pricingFailure = 'stream_failure';
          const classification = classifyStreamError(event);
          this.completeResponseCredential(response, {
            statusCode: classification.statusCode,
            failureType: classification.failureType,
            error: event.error.message,
          });
        }
      }
      return parsedEvents;
    };
    let forwardedStreamData = false;
    let streamAbortMetricRecorded = false;
    const recordClientAbort = () => {
      if (streamAbortMetricRecorded) return;
      streamAbortMetricRecorded = true;
      this.recordStreamLifecycleMetric(
        node.id,
        targetModel,
        'abort',
        'client_aborted',
        this.streamLifecyclePhase(forwardedStreamData),
      );
    };
    const cancelReader = () => {
      recordClientAbort();
      void reader.cancel().catch(() => undefined);
    };
    if (options.signal?.aborted) {
      cancelReader();
    } else {
      options.signal?.addEventListener('abort', cancelReader, { once: true });
    }

    try {
      while (true) {
        if (options.signal?.aborted) {
          break;
        }
        const { done, value } = await this.readStreamChunkWithTimeouts(
          reader,
          node.id,
          streamBodyIdleTimeoutMs,
          streamMaxDurationMs,
          streamStartedAtMs,
          targetModel,
          this.streamLifecyclePhase(forwardedStreamData),
        );
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const parsedEvents = parseChunk(chunk);
        if (passthroughNativeStream) {
          if (chunk || parsedEvents.length > 0) {
            forwardedStreamData = true;
            yield { type: 'raw_sse', text: chunk, events: parsedEvents };
          }
          continue;
        }

        for (const event of parsedEvents) {
          forwardedStreamData = true;
          yield event;
        }
      }
      const trailingChunk = decoder.decode();
      if (trailingChunk) {
        const parsedEvents = parseChunk(trailingChunk);
        if (passthroughNativeStream) {
          forwardedStreamData = true;
          yield { type: 'raw_sse', text: trailingChunk, events: parsedEvents };
        } else {
          for (const event of parsedEvents) {
            forwardedStreamData = true;
            yield event;
          }
        }
      }
      if (
        'flush' in parser &&
        typeof (parser as { flush?: () => Generator<CanonicalStreamEvent> }).flush === 'function'
      ) {
        const flushedEvents = [
          ...(parser as { flush: () => Generator<CanonicalStreamEvent> }).flush(),
        ];
        for (const event of flushedEvents) {
          if (event.type === 'start') pricingResponseModel = event.model;
        if (event.type === 'stop') {
            latestUsage = event.usage;
          } else if (event.type === 'error') {
          pricingFailure = 'stream_failure';
            const classification = classifyStreamError(event);
            this.completeResponseCredential(response, {
              statusCode: classification.statusCode,
              failureType: classification.failureType,
              error: event.error.message,
            });
          }
        }
        if (passthroughNativeStream && flushedEvents.length > 0) {
          forwardedStreamData = true;
          yield { type: 'raw_sse', text: '', events: flushedEvents };
        } else {
          for (const event of flushedEvents) {
            forwardedStreamData = true;
            yield event;
          }
        }
      }
    } catch (err) {
      pricingFailure = "stream_failure";
      const message = err instanceof Error ? err.message : String(err);
      const redactedMessage = redactProviderErrorText(
        message,
        this.providerRedactionTelemetry(),
      );
      const providerError = err instanceof ProviderError ? err : null;
      if (providerError) {
        this.completeResponseCredential(response, {
          statusCode: providerError.statusCode,
          failureType: providerError.failureType,
          error: providerError.message,
        });
      }
      if (!forwardedStreamData) {
        const connectionPhaseError =
          providerError ||
          new ProviderError(
            `Provider ${node.id} stream failed before receiving data: ${redactedMessage}`,
            502,
            node.id,
            'http_error',
          );
        if (!providerError) {
          this.completeResponseCredential(response, {
            statusCode: connectionPhaseError.statusCode,
            failureType: connectionPhaseError.failureType,
            error: connectionPhaseError.message,
          });
        }
        throw connectionPhaseError;
      }
      // Transmission phase error — emit as error event (don't throw)
      const errorEvent: CanonicalStreamEvent = {
        type: 'error',
        error: {
          message: `Stream interrupted from ${node.id}: ${redactedMessage}`,
          code: providerError?.failureType === 'timeout' ? 'timeout' : 'stream_error',
        },
      };
      if (providerError) {
        errorEvent.error.status_code = providerError.statusCode;
      }
      yield errorEvent;
    } finally {
      const finalUsage = parser.getPricingUsage() ?? latestUsage;
      const finalEvidence = finalUsage && getUsageEvidence(finalUsage);
      // Cumulative reports can arrive after a protocol stop event. Update only the
      // private billing evidence; never append duplicate client-visible stop frames.
      if (latestUsage && finalEvidence) attachUsageEvidence(latestUsage, finalEvidence);
      try {
        await this.responsePricingReceipts.get(response)?.streamFinished?.(
          finalUsage,
          options.signal?.aborted ? 'client_aborted' : pricingFailure ?? (finalUsage ? undefined : 'stream_incomplete'),
          pricingResponseModel,
        );
      } finally {
        this.responsePricingReceipts.delete(response);
        this.recordResponseCredentialUsage(response, finalUsage, canonical.metadata);
        this.completeResponseCredential(response, {
          statusCode: options.signal?.aborted ? 499 : response.status,
        });
        this.responseAbortCleanups.get(response)?.();
        this.responseAbortCleanups.delete(response);
        options.signal?.removeEventListener('abort', cancelReader);
        reader.releaseLock();
      }
    }
  }

  // ══════════════════════════════════════════════════════
  // Shared HTTP Request Logic
  // ══════════════════════════════════════════════════════

  private resolveStreamBodyIdleTimeoutMs(
    node: NodeConfig,
    requestTimeoutMs?: number,
  ): number {
    const configuredBodyTimeoutMs = node.connection?.body_timeout_ms;
    if (
      typeof configuredBodyTimeoutMs === 'number' &&
      Number.isFinite(configuredBodyTimeoutMs) &&
      configuredBodyTimeoutMs >= 0
    ) {
      return Math.floor(configuredBodyTimeoutMs);
    }
    return requestTimeoutMs ?? node.timeout_ms ?? 60000;
  }

  private resolveStreamMaxDurationMs(node: NodeConfig): number {
    const configuredMaxDurationMs = node.connection?.stream_max_duration_ms;
    if (
      typeof configuredMaxDurationMs === 'number' &&
      Number.isFinite(configuredMaxDurationMs) &&
      configuredMaxDurationMs >= 0
    ) {
      return Math.floor(configuredMaxDurationMs);
    }
    return 0;
  }

  private async readStreamChunkWithTimeouts(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    nodeId: string,
    idleTimeoutMs: number,
    maxDurationMs: number,
    streamStartedAtMs: number,
    targetModel: string,
    phase: StreamLifecycleMetricPhase,
  ): Promise<ReadableStreamReadResult<Uint8Array>> {
    const timers: ReturnType<typeof setTimeout>[] = [];
    const timeoutPromises: Promise<never>[] = [];
    let timeoutTriggered = false;

    const addTimeout = (
      timeoutMs: number,
      errorMessage: string,
      reason: StreamLifecycleMetricReason,
    ): void => {
      timeoutPromises.push(
        new Promise<never>((_resolve, reject) => {
          const timeout = setTimeout(() => {
            if (timeoutTriggered) return;
            timeoutTriggered = true;
            void reader.cancel().catch(() => undefined);
            this.recordStreamLifecycleMetric(
              nodeId,
              targetModel,
              'timeout',
              reason,
              phase,
            );
            reject(new ProviderError(errorMessage, 504, nodeId, 'timeout'));
          }, timeoutMs);
          timers.push(timeout);
        }),
      );
    };

    if (maxDurationMs > 0) {
      const remainingDurationMs = maxDurationMs - (Date.now() - streamStartedAtMs);
      if (remainingDurationMs <= 0) {
        void reader.cancel().catch(() => undefined);
        this.recordStreamLifecycleMetric(
          nodeId,
          targetModel,
          'timeout',
          'max_duration',
          phase,
        );
        throw new ProviderError(
          `Provider ${nodeId} stream exceeded max duration ${maxDurationMs}ms`,
          504,
          nodeId,
          'timeout',
        );
      }
      addTimeout(
        remainingDurationMs,
        `Provider ${nodeId} stream exceeded max duration ${maxDurationMs}ms`,
        'max_duration',
      );
    }

    if (idleTimeoutMs > 0) {
      addTimeout(
        idleTimeoutMs,
        `Provider ${nodeId} stream timed out after ${idleTimeoutMs}ms without receiving data`,
        'idle_timeout',
      );
    }

    if (timeoutPromises.length === 0) {
      return reader.read();
    }

    try {
      return await Promise.race([reader.read(), ...timeoutPromises]);
    } finally {
      for (const timeout of timers) clearTimeout(timeout);
    }
  }

  private recordStreamLifecycleMetric(
    node: string,
    model: string,
    event: StreamLifecycleMetricEvent,
    reason: StreamLifecycleMetricReason,
    phase: StreamLifecycleMetricPhase,
  ): void {
    this.telemetry.recordStreamLifecycle?.({
      event,
      reason,
      phase,
      node,
      model,
    });
  }

  private providerRedactionTelemetry(): ErrorRedactionTelemetry {
    return {
      surface: 'provider',
      record: (event) => this.telemetry.recordErrorRedaction(event),
    };
  }

  private streamLifecyclePhase(forwardedStreamData: boolean): StreamLifecycleMetricPhase {
    return forwardedStreamData ? 'transmission' : 'pre_first_chunk';
  }

  private async resolveNodeApiKey(
    node: NodeConfig,
    credential?: CredentialSelection,
  ): Promise<string> {
    const configuredKey = credential?.credential.api_key || node.api_key;
    if (!configuredKey) {
      throw new Error(`Node "${node.id}" must define api_key or credentials`);
    }
    return this.secretResolver
      ? this.secretResolver.resolveString(configuredKey, {
          location: credential?.synthetic
            ? `nodes.${node.id}.api_key`
            : `nodes.${node.id}.credentials.${credential?.credential.id || 'default'}.api_key`,
        })
      : configuredKey;
  }

  private async resolveNodeHeaders(node: NodeConfig): Promise<Record<string, string>> {
    return this.secretResolver
      ? this.secretResolver.resolveRecord(node.headers, {
          optional: true,
          location: `nodes.${node.id}.headers`,
        })
      : { ...(node.headers || {}) };
  }

  private async sendRequest(
    node: NodeConfig,
    requestBody: Record<string, unknown>,
    canonical?: CanonicalRequest,
    timeoutMs?: number,
    signal?: AbortSignal,
    endpointOverride?: string,
    preserveAbortAfterResponse = false,
    reservedToolSchemaRetryCount = 0,
    credentialAttemptLimit?: number,
    pricingAttempts?: ProviderAttemptObserver,
    operation = "chat",
    wireModel?: string,
    dispatchBudget = { remaining: credentialAttemptLimit ?? Infinity, sequence: 0 },
  ): Promise<Response> {
    if (node.disabled === true) throw new ProviderError(`Node ${node.id} is disabled`, 503, node.id, "http_error");
    const url = `${node.base_url}${endpointOverride || node.endpoint}`;
    const nodeHeaders = await this.resolveNodeHeaders(node);
    const effectiveTimeoutMs = timeoutMs ?? node.timeout_ms ?? 60000;

    const triedCredentialIds = new Set<string>();
    const attemptLimit = Math.min(this.credentialPool?.attemptLimit(node) ?? 1, credentialAttemptLimit ?? Infinity);
    let lastError: ProviderError | null = null;

    for (let attempt = 0; attempt < attemptLimit && dispatchBudget.remaining > 0; attempt++) {
      if (signal?.aborted) throw new ProviderError(`Provider ${node.id} request cancelled before dispatch`, 499, node.id, "http_error");
      const credential = await this.selectCredential(node, canonical?.metadata, triedCredentialIds);
      triedCredentialIds.add(credential.credential.id);
      const headers = await this.buildHeaders(
        node,
        nodeHeaders,
        'application/json',
        credential,
      );

      // Preserve Anthropic-native request headers for messages → messages passthrough.
      if (canonical && this.shouldPassthroughNativeMessages(canonical, node.protocol)) {
        Object.assign(headers, this.extractNativeMessageHeaders(canonical));
      }

      this.logger.debug(
        `Forwarding to ${node.id} (${node.protocol}) → ${url} model=${requestBody.model} stream=${requestBody.stream} credential=${credential.credential.id}`,
      );

      let pricingReceipt: ProviderAttemptReceipt | undefined;
      try {
        pricingReceipt = await pricingAttempts?.begin({
          node_id: node.id, wire_model: typeof requestBody.model === 'string' ? requestBody.model : wireModel ?? null,
          credential_id: credential.credential.id, credential_strategy: credential.strategy,
          credential_retry_index: attempt, compatibility_retry_index: reservedToolSchemaRetryCount,
          dispatch_index: dispatchBudget.sequence++, protocol: node.protocol, dispatched_at: new Date(Date.now()).toISOString(),
        });
      } catch (error) { this.completeCredential(credential, {}); throw error; }
      dispatchBudget.remaining--;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), effectiveTimeoutMs);
      const abortFromExternal = () => controller.abort();
      if (signal?.aborted) {
        controller.abort();
      } else {
        signal?.addEventListener('abort', abortFromExternal, { once: true });
      }

      let response: Response;
      try {
        const fetchOptions: FetchOptionsWithDispatcher = {
          method: 'POST',
          headers,
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        };
        const dispatcher = this.connectionPool?.getDispatcher(node);
        if (dispatcher) {
          fetchOptions.dispatcher = dispatcher;
        }

        response = await fetch(url, fetchOptions);
      } catch (err: unknown) {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abortFromExternal);
        const message = describeFetchError(err);
        const errorName = err instanceof Error ? err.name : '';
        const providerError =
          errorName === 'AbortError' || isUndiciTimeoutError(err)
            ? new ProviderError(
                `Provider ${node.id} timed out after ${effectiveTimeoutMs}ms`,
                504,
                node.id,
                'timeout',
                credential.credential.id,
                credential.strategy,
                attempt,
              )
            : new ProviderError(
                `Failed to connect to ${node.id}: ${message}`,
                0,
                node.id,
                'network_error',
                credential.credential.id,
                credential.strategy,
                attempt,
              );
        this.completeCredential(credential, {
          statusCode: providerError.statusCode,
          failureType: providerError.failureType,
          error: providerError.message,
        });
        await pricingReceipt?.failed(signal?.aborted ? "client_aborted" : providerError.failureType);
        lastError = providerError;
        if (
          !signal?.aborted && dispatchBudget.remaining > 0 && attempt < attemptLimit - 1 &&
          this.credentialPool?.shouldRetry(node, providerError.statusCode, providerError.failureType)
        ) {
          continue;
        }
        throw providerError;
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abortFromExternal);
      }

      if (response.ok) {
        this.responseCredentials.set(response, { selection: credential, retryCount: attempt });
        if (pricingReceipt) this.responsePricingReceipts.set(response, pricingReceipt);
        if (preserveAbortAfterResponse && signal) {
          const abortAfterResponse = () => controller.abort();
          if (signal.aborted) {
            controller.abort();
          } else {
            signal.addEventListener('abort', abortAfterResponse, { once: true });
          }
          this.responseAbortCleanups.set(response, () => {
            signal.removeEventListener('abort', abortAfterResponse);
          });
        }
        this.applyCredentialRequestMetadata(canonical?.metadata, credential, attempt);
        return response;
      }

      let errorBody: string;
      try { errorBody = await response.text(); } catch { errorBody = 'Unable to read error body'; }
      await pricingReceipt?.failed(response.status === 429 ? 'rate_limited' : 'http_error', providerFailureUsage(errorBody, this.resolveUsageSchemaForNode(node), operation));
      if (process.env.GATEWAY_DEBUG_MESSAGES_BODY === '1' && node.protocol === 'messages') {
        this.logger.debug(
          `Failed messages request body preview: ${JSON.stringify(requestBody).substring(0, 2000)}`,
        );
      }
      const sanitizedErrorBody = sanitizeProviderErrorBody(
        errorBody,
        this.providerRedactionTelemetry(),
      );
      this.logger.warn(`Provider ${node.id} returned ${response.status}: ${sanitizedErrorBody.substring(0, 200)}`);
      // Some load-balanced Responses backends intermittently disagree about
      // the configured schema for reserved collaboration tools. This exact
      // 400 occurs before model execution, so replay the unchanged request
      // once without making unrelated client-shape errors retryable.
      if (
        reservedToolSchemaRetryCount < 1 && dispatchBudget.remaining > 0 &&
        !signal?.aborted &&
        this.isReservedCollaborationToolSchemaMismatch(
          node,
          requestBody,
          response.status,
          errorBody,
        )
      ) {
        this.logger.warn(
          `Retrying ${node.id} once after an intermittent reserved collaboration tool schema mismatch`,
        );
        this.completeCredential(credential, {
          statusCode: response.status,
          failureType: 'http_error',
          error: `Intermittent reserved collaboration tool schema mismatch from ${node.id}`,
        });
        return this.sendRequest(
          node,
          requestBody,
          canonical,
          timeoutMs,
          signal,
          endpointOverride,
          preserveAbortAfterResponse,
          reservedToolSchemaRetryCount + 1,
          credentialAttemptLimit,
          pricingAttempts,
          operation,
          wireModel,
          dispatchBudget,
        );
      }
      const retryAfter = response.headers?.get?.('retry-after');
      const providerError = new ProviderError(
        `Provider ${node.id} returned ${response.status}: ${sanitizedErrorBody.substring(0, 500)}` +
          (retryAfter ? ` retry-after: ${retryAfter}` : ''),
        response.status,
        node.id,
        response.status === 429 ? 'rate_limited' : 'http_error',
        credential.credential.id,
        credential.strategy,
        attempt,
      );
      this.completeCredential(credential, {
        statusCode: response.status,
        failureType: providerError.failureType,
        error: providerError.message,
        retryAfter,
      });
      lastError = providerError;
      if (
        !signal?.aborted && dispatchBudget.remaining > 0 && attempt < attemptLimit - 1 &&
        this.credentialPool?.shouldRetry(node, response.status, providerError.failureType)
      ) {
        continue;
      }
      throw providerError;
    }

    throw lastError || new ProviderError(`Provider ${node.id} has no credential attempts`, 503, node.id);
  }

  private isReservedCollaborationToolSchemaMismatch(
    node: NodeConfig,
    requestBody: Record<string, unknown>,
    statusCode: number,
    errorBody: string,
  ): boolean {
    if (node.protocol !== 'responses' || statusCode !== 400) return false;
    const tools = Array.isArray(requestBody.tools) ? requestBody.tools : [];
    const includesReservedTool = tools.some(
      (tool) => {
        if (!this.isPlainRecord(tool)) return false;
        if (
          tool.type === 'function' &&
          tool.name === 'collaboration.spawn_agent'
        ) {
          return true;
        }
        if (
          tool.type !== 'namespace' ||
          tool.name !== 'collaboration' ||
          !Array.isArray(tool.tools)
        ) {
          return false;
        }
        return tool.tools.some(
          (child) =>
            this.isPlainRecord(child) &&
            child.type === 'function' &&
            child.name === 'spawn_agent',
        );
      },
    );
    if (!includesReservedTool) return false;

    return (
      errorBody.includes(
        "Function 'collaboration.spawn_agent' is reserved for use by this model",
      ) && errorBody.includes('must match the configured schema')
    );
  }

  private async sendMediaRequest(
    node: NodeConfig,
    request: { body: Record<string, unknown> | Buffer; contentType: string },
    endpoint: string,
    timeoutMs?: number,
    signal?: AbortSignal,
    singleAttempt = false,
    credentialAttemptLimit?: number,
    pricingAttempts?: ProviderAttemptObserver,
    wireModel?: string,
    operation = "media",
  ): Promise<Response> {
    if (node.disabled === true) throw new ProviderError(`Node ${node.id} is disabled`, 503, node.id, "http_error");
    const url = `${node.base_url}${endpoint}`;
    const nodeHeaders = await this.resolveNodeHeaders(node);
    const effectiveTimeoutMs = timeoutMs ?? node.timeout_ms ?? 60000;

    const triedCredentialIds = new Set<string>();
    const attemptLimit = singleAttempt ? 1 : Math.min(this.credentialPool?.attemptLimit(node) ?? 1, credentialAttemptLimit ?? Infinity);
    let lastError: ProviderError | null = null;

    for (let attempt = 0; attempt < attemptLimit; attempt++) {
      if (signal?.aborted) throw new ProviderError(`Provider ${node.id} request cancelled before dispatch`, 499, node.id, "http_error");
      const credential = await this.selectCredential(node, undefined, triedCredentialIds);
      triedCredentialIds.add(credential.credential.id);
      const headers = await this.buildHeaders(
        node,
        nodeHeaders,
        request.contentType,
        credential,
      );

      let pricingReceipt: ProviderAttemptReceipt | undefined;
      try {
        pricingReceipt = await pricingAttempts?.begin({
          node_id: node.id, wire_model: wireModel ?? null,
          credential_id: credential.credential.id, credential_strategy: credential.strategy,
          credential_retry_index: attempt, compatibility_retry_index: 0, dispatch_index: attempt,
          protocol: node.protocol, dispatched_at: new Date(Date.now()).toISOString(),
        });
      } catch (error) { this.completeCredential(credential, {}); throw error; }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), effectiveTimeoutMs);
      const abortFromExternal = () => controller.abort();
      if (signal?.aborted) {
        controller.abort();
      } else {
        signal?.addEventListener('abort', abortFromExternal, { once: true });
      }

      try {
        const body = Buffer.isBuffer(request.body)
          ? (request.body as unknown as BodyInit)
          : JSON.stringify(request.body);
        const fetchOptions: FetchOptionsWithDispatcher = {
          method: 'POST',
          headers,
          body,
          signal: controller.signal,
        };
        const dispatcher = this.connectionPool?.getDispatcher(node);
        if (dispatcher) {
          fetchOptions.dispatcher = dispatcher;
        }
        const response = await fetch(url, fetchOptions);
        if (response.ok) {
          this.responseCredentials.set(response, { selection: credential, retryCount: attempt });
        if (pricingReceipt) this.responsePricingReceipts.set(response, pricingReceipt);
          return response;
        }

        let errorBody: string;
        try { errorBody = await response.text(); } catch { errorBody = 'Unable to read error body'; }
        const sanitizedErrorBody = sanitizeProviderErrorBody(
          errorBody,
          this.providerRedactionTelemetry(),
        );
        this.logger.warn(`Provider ${node.id} returned ${response.status}: ${sanitizedErrorBody.substring(0, 200)}`);
        const retryAfter = response.headers?.get?.('retry-after');
        const providerError = new ProviderError(
          `Provider ${node.id} returned ${response.status}: ${sanitizedErrorBody.substring(0, 500)}` +
            (retryAfter ? ` retry-after: ${retryAfter}` : ''),
          response.status,
          node.id,
          response.status === 429 ? 'rate_limited' : 'http_error',
          credential.credential.id,
          credential.strategy,
          attempt,
        );
        this.completeCredential(credential, {
          statusCode: response.status,
          failureType: providerError.failureType,
          error: providerError.message,
          retryAfter,
        });
        await pricingReceipt?.failed(providerError.failureType, providerFailureUsage(errorBody, this.resolveUsageSchemaForNode(node), operation));
        lastError = providerError;
        if (
          !signal?.aborted && attempt < attemptLimit - 1 &&
          this.credentialPool?.shouldRetry(node, response.status, providerError.failureType)
        ) {
          continue;
        }
        throw providerError;
      } catch (err: unknown) {
        if (err instanceof ProviderError) throw err;
        const message = describeFetchError(err);
        const errorName = err instanceof Error ? err.name : '';
        const providerError =
          errorName === 'AbortError' || isUndiciTimeoutError(err)
            ? new ProviderError(
                `Provider ${node.id} timed out after ${effectiveTimeoutMs}ms`,
                504,
                node.id,
                'timeout',
                credential.credential.id,
                credential.strategy,
                attempt,
              )
            : new ProviderError(
                `Failed to connect to ${node.id}: ${message}`,
                0,
                node.id,
                'network_error',
                credential.credential.id,
                credential.strategy,
                attempt,
              );
        this.completeCredential(credential, {
          statusCode: providerError.statusCode,
          failureType: providerError.failureType,
          error: providerError.message,
        });
        await pricingReceipt?.failed(signal?.aborted ? "client_aborted" : providerError.failureType);
        lastError = providerError;
        if (
          !signal?.aborted && attempt < attemptLimit - 1 &&
          this.credentialPool?.shouldRetry(node, providerError.statusCode, providerError.failureType)
        ) {
          continue;
        }
        throw providerError;
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abortFromExternal);
      }
    }

    throw lastError || new ProviderError(`Provider ${node.id} has no credential attempts`, 503, node.id);
  }

  private async readJsonResponse(
    response: Response,
    node: NodeConfig,
  ): Promise<Record<string, unknown>> {
    try {
      const body = (await response.json()) as Record<string, unknown>;
      this.completeResponseCredential(response, { statusCode: response.status });
      return body;
    } catch (err: unknown) {
      if (isUndiciTimeoutError(err)) {
        this.completeResponseCredential(response, {
          statusCode: 504,
          failureType: 'timeout',
          error: `Provider ${node.id} timed out while reading upstream response body`,
        });
        throw new ProviderError(
          `Provider ${node.id} timed out while reading upstream response body`,
          504,
          node.id,
          'timeout',
        );
      }
      this.completeResponseCredential(response, {
        statusCode: response.status,
        error: err instanceof Error ? err.message : 'response_parse_error',
      });
      throw err;
    }
  }

  private async buildHeaders(
    node: NodeConfig,
    nodeHeaders: Record<string, string>,
    contentType: string,
    credential: CredentialSelection,
  ): Promise<Record<string, string>> {
    const apiKey = await this.resolveNodeApiKey(node, credential);
    const headers: Record<string, string> = {
      'Content-Type': contentType,
    };

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

  private async selectCredential(
    node: NodeConfig,
    metadata?: CanonicalRequest['metadata'],
    triedCredentialIds?: Set<string>,
  ): Promise<CredentialSelection> {
    if (this.credentialPool) {
      return this.credentialPool.select(node, { metadata, triedCredentialIds });
    }
    const fallback = {
      nodeId: node.id,
      credential: {
        id: 'default',
        api_key: node.api_key || '',
        weight: 1,
        enabled: true,
      },
      strategy: 'least_in_flight' as const,
      stickyBy: 'none' as const,
      cooldownMs: 60_000,
      maxFailures: 3,
      retryOnStatus: [429, 500, 502, 503, 504],
      synthetic: true,
    };
    return fallback;
  }

  private completeCredential(
    selection: CredentialSelection,
    result: {
      statusCode?: number;
      failureType?: string;
      error?: string | null;
      retryAfter?: string | null;
    },
  ): void {
    this.credentialPool?.complete(selection, result);
  }

  private completeResponseCredential(
    response: Response,
    result: {
      statusCode?: number;
      failureType?: string;
      error?: string | null;
      retryAfter?: string | null;
    },
  ): void {
    const metadata = this.responseCredentials.get(response);
    if (!metadata) return;
    if (this.completedCredentialResponses.has(response)) return;
    this.completedCredentialResponses.add(response);
    this.completeCredential(metadata.selection, result);
  }

  private applyCredentialRequestMetadata(
    metadata: CanonicalRequest['metadata'] | undefined,
    selection: CredentialSelection,
    retryCount: number,
  ): void {
    if (!metadata) return;
    metadata.provider_credential_id = selection.credential.id;
    metadata.provider_credential_strategy = selection.strategy;
    metadata.provider_credential_retry_count = retryCount;
  }

  private applyCredentialRoutingMetadata(
    routing: {
      credential_id?: string | null;
      credential_strategy?: string | null;
      credential_retry_count?: number;
    },
    response: Response,
  ): void {
    const metadata = this.responseCredentials.get(response);
    if (!metadata) return;
    routing.credential_id = metadata.selection.credential.id;
    routing.credential_strategy = metadata.selection.strategy;
    routing.credential_retry_count = metadata.retryCount;
  }

  private recordResponseCredentialUsage(
    response: Response,
    usage: TokenUsage | undefined,
    requestMetadata?: CanonicalRequest['metadata'],
  ): void {
    const metadata = this.responseCredentials.get(response);
    if (!metadata) return;
    this.credentialPool?.recordUsage(metadata.selection, usage, requestMetadata);
  }

  // ══════════════════════════════════════════════════════
  // Stream Parser Factory
  // ══════════════════════════════════════════════════════

  private createStreamParser(
    protocol: NodeProtocol,
    usageSchema?: UsageSchema,
  ) {
    switch (protocol) {
      case 'chat_completions':
        return new ChatCompletionsStreamParser(usageSchema);
      case 'responses':
        return new ResponsesStreamParser(usageSchema);
      case 'messages':
        return new MessagesStreamParser(usageSchema);
      case 'gemini':
        return new GeminiStreamParser(usageSchema);
      default:
        throw new Error(`Unsupported stream protocol: ${protocol}`);
    }
  }

  // ══════════════════════════════════════════════════════
  // Request Denormalization
  // ══════════════════════════════════════════════════════

  private denormalizeRequest(
    canonical: CanonicalRequest,
    protocol: NodeProtocol,
    targetModel: string,
  ): Record<string, unknown> {
    if (this.shouldPassthroughNativeResponses(canonical, protocol)) {
      return this.buildNativeResponsesRequest(canonical, targetModel);
    }

    if (this.shouldPassthroughNativeMessages(canonical, protocol)) {
      return this.buildNativeMessagesRequest(canonical, targetModel);
    }

    switch (protocol) {
      case 'chat_completions': {
        const requestBody = this.chatDenorm.denormalize(canonical, targetModel);
        this.applyNativeChatCompletionsPassthrough(canonical, requestBody);
        return requestBody;
      }
      case 'responses': {
        const requestBody = this.respDenorm.denormalize(canonical, targetModel);
        this.applyNativeResponsesPassthrough(canonical, requestBody);
        return requestBody;
      }
      case 'messages':
        return this.msgDenorm.denormalize(canonical, targetModel);
      case 'gemini':
        return this.geminiDenorm.denormalize(canonical, targetModel);
      default:
        throw new Error(`Unsupported protocol: ${protocol}`);
    }
  }

  private applyStreamFlag(
    node: NodeConfig,
    requestBody: Record<string, unknown>,
    stream: boolean,
  ): void {
    if (node.protocol === 'gemini') {
      delete requestBody.stream;
      return;
    }
    requestBody.stream = stream;
  }

  private applyNativeChatCompletionsPassthrough(
    canonical: CanonicalRequest,
    requestBody: Record<string, unknown>,
  ): void {
    if (canonical.metadata.source_format !== 'chat_completions') return;
    const rawBody =
      canonical.metadata.raw_body &&
      typeof canonical.metadata.raw_body === 'object' &&
      !Array.isArray(canonical.metadata.raw_body)
        ? (canonical.metadata.raw_body as Record<string, unknown>)
        : {};

    if (
      rawBody.max_completion_tokens !== undefined &&
      rawBody.max_tokens === undefined
    ) {
      delete requestBody.max_tokens;
      requestBody.max_completion_tokens = this.cloneJson(
        rawBody.max_completion_tokens,
      );
    }

    for (const field of [
      'audio',
      'extra_body',
      'frequency_penalty',
      'logit_bias',
      'logprobs',
      'metadata',
      'modalities',
      'n',
      'parallel_tool_calls',
      'prediction',
      'presence_penalty',
      'seed',
      'service_tier',
      'store',
      'top_logprobs',
      'user',
      'web_search_options',
    ]) {
      if (requestBody[field] === undefined && rawBody[field] !== undefined) {
        requestBody[field] = this.cloneJson(rawBody[field]);
      }
    }

    if (rawBody.stream_options !== undefined) {
      requestBody.stream_options = this.cloneJson(rawBody.stream_options);
    }
  }

  private applyNativeResponsesPassthrough(
    canonical: CanonicalRequest,
    requestBody: Record<string, unknown>,
  ): void {
    if (canonical.metadata.source_format !== 'responses') return;
    const rawBody =
      canonical.metadata.raw_body &&
      typeof canonical.metadata.raw_body === 'object' &&
      !Array.isArray(canonical.metadata.raw_body)
        ? (canonical.metadata.raw_body as Record<string, unknown>)
        : {};

    this.mergeNativeResponsesTools(rawBody.tools, requestBody);

    if (canonical.tool_choice === undefined && rawBody.tool_choice !== undefined) {
      requestBody.tool_choice = this.cloneJson(rawBody.tool_choice);
    }

    for (const field of [
      'background',
      'include',
      'parallel_tool_calls',
      'service_tier',
      'store',
      'truncation',
      'user',
    ]) {
      if (requestBody[field] === undefined && rawBody[field] !== undefined) {
        requestBody[field] = this.cloneJson(rawBody[field]);
      }
    }
  }

  private mergeNativeResponsesTools(
    rawTools: unknown,
    requestBody: Record<string, unknown>,
  ): void {
    if (!Array.isArray(rawTools)) return;
    const existingTools = Array.isArray(requestBody.tools)
      ? ([...requestBody.tools] as Record<string, unknown>[])
      : [];
    const existingFunctions = new Map<string, Record<string, unknown>>();
    for (const tool of existingTools) {
      if (tool?.type === 'function' && typeof tool.name === 'string') {
        existingFunctions.set(tool.name, tool);
      }
    }

    const merged: Record<string, unknown>[] = [];
    const usedFunctions = new Set<string>();
    for (const rawTool of rawTools) {
      if (!rawTool || typeof rawTool !== 'object' || Array.isArray(rawTool)) {
        continue;
      }
      const tool = rawTool as Record<string, unknown>;
      if (tool.type === 'function') {
        const name = typeof tool.name === 'string' ? tool.name : '';
        const normalized = existingFunctions.get(name);
        if (normalized) {
          merged.push(normalized);
          usedFunctions.add(name);
        }
        continue;
      }
      merged.push(this.cloneJson(tool) as Record<string, unknown>);
    }

    for (const tool of existingTools) {
      if (tool?.type !== 'function') continue;
      const name = typeof tool.name === 'string' ? tool.name : '';
      if (!usedFunctions.has(name)) merged.push(tool);
    }

    if (merged.length > 0) {
      requestBody.tools = merged;
    }
  }

  private cloneJson(value: unknown): unknown {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
  }

  private resolveUpstreamModel(node: NodeConfig, targetModel: string): string {
    return node.upstream_model_aliases?.[targetModel] || targetModel;
  }

  private resolveRequestEndpoint(
    node: NodeConfig,
    targetModel: string,
    stream: boolean,
  ): string | undefined {
    if (node.protocol !== 'gemini') return undefined;
    const encodedModel = encodeURIComponent(targetModel);
    let endpoint = node.endpoint || '/v1beta/models/:model:generateContent';
    endpoint = endpoint
      .replace(':model', encodedModel)
      .replace('{model}', encodedModel);
    if (stream) {
      endpoint = endpoint
        .replace(':generateContent', ':streamGenerateContent')
        .replace('generateContent', 'streamGenerateContent');
      if (!endpoint.includes('alt=sse')) {
        endpoint += endpoint.includes('?') ? '&alt=sse' : '?alt=sse';
      }
    }
    return endpoint;
  }

  private applyNodeRequestCompatibility(
    node: NodeConfig,
    requestBody: Record<string, unknown>,
    preserveNativeResponsesToolSchemas = false,
  ): void {
    for (const parameter of node.request_compatibility?.drop_parameters || []) {
      delete requestBody[parameter];
    }

    const defaultParameters =
      node.request_compatibility?.default_parameters || {};
    for (const [parameter, value] of Object.entries(defaultParameters)) {
      if (requestBody[parameter] === undefined) {
        requestBody[parameter] = this.cloneJson(value);
      } else {
        requestBody[parameter] = this.mergeMissingDefaults(
          requestBody[parameter],
          value,
        );
      }
    }

    // Responses -> Responses requests are cloned from the original client body.
    // Keep already-valid function schemas semantically unchanged: newer models
    // can reserve tool names and require the submitted schema to exactly match
    // the model's configured schema. Malformed schemas still receive the
    // provider-compatibility fallback used by translated requests.
    this.sanitizeFunctionToolSchemas(
      requestBody,
      new WeakSet<object>(),
      false,
      preserveNativeResponsesToolSchemas,
    );

    if (node.protocol === 'chat_completions') {
      this.applyChatToolMessageCompatibility(
        requestBody,
        node.request_compatibility?.chat_tool_messages,
      );
    }

    if (
      node.protocol !== 'messages' ||
      node.request_compatibility?.messages_tool_result_content !== 'string'
    ) {
      return;
    }

    this.stringifyToolResultContent(requestBody.messages);
  }

  private sanitizeFunctionToolSchemas(
    value: unknown,
    seen = new WeakSet<object>(),
    inToolContainer = false,
    preserveValidSchemas = false,
  ): void {
    if (Array.isArray(value)) {
      for (const item of value) {
        this.sanitizeFunctionToolSchemas(
          item,
          seen,
          inToolContainer,
          preserveValidSchemas,
        );
      }
      return;
    }

    if (!this.isPlainRecord(value)) return;
    if (seen.has(value)) return;
    seen.add(value);

    if (inToolContainer) {
      this.ensureNonEmptyToolDescription(value);
    }
    this.sanitizeFunctionToolRecord(
      value,
      inToolContainer,
      preserveValidSchemas,
    );

    for (const [key, child] of Object.entries(value)) {
      this.sanitizeFunctionToolSchemas(
        child,
        seen,
        key === 'tools' && Array.isArray(child),
        preserveValidSchemas,
      );
    }
  }

  private sanitizeFunctionToolRecord(
    record: Record<string, unknown>,
    inToolContainer: boolean,
    preserveValidSchemas: boolean,
  ): void {
    if (record.type === 'function') {
      if (this.isPlainRecord(record.function)) {
        this.ensureNonEmptyToolDescription(record.function);
        record.function.parameters = this.normalizeFunctionParametersSchema(
          record.function.parameters,
          preserveValidSchemas,
        );
        return;
      }

      this.ensureNonEmptyToolDescription(record);
      record.parameters = this.normalizeFunctionParametersSchema(
        record.parameters,
        preserveValidSchemas,
      );
      return;
    }

    if (
      inToolContainer &&
      typeof record.name === 'string' &&
      Object.prototype.hasOwnProperty.call(record, 'parameters')
    ) {
      this.ensureNonEmptyToolDescription(record);
      record.parameters = this.normalizeFunctionParametersSchema(
        record.parameters,
        preserveValidSchemas,
      );
      return;
    }

    if (
      typeof record.name === 'string' &&
      Object.prototype.hasOwnProperty.call(record, 'input_schema')
    ) {
      record.input_schema = this.normalizeFunctionParametersSchema(
        record.input_schema,
        preserveValidSchemas,
      );
    }
  }

  private ensureNonEmptyToolDescription(record: Record<string, unknown>): void {
    if (
      typeof record.description !== 'string' ||
      record.description.trim().length > 0
    ) {
      return;
    }

    const name = typeof record.name === 'string' ? record.name.trim() : '';
    record.description = name ? `Tool ${name}` : 'Tool';
  }

  private normalizeFunctionParametersSchema(
    schema: unknown,
    preserveValidSchema = false,
  ): Record<string, unknown> {
    if (!this.isPlainRecord(schema)) {
      return { type: 'object', properties: {} };
    }

    if (preserveValidSchema && schema.type === 'object') {
      return schema;
    }

    const normalized = this.cloneJson(schema) as Record<string, unknown>;
    const schemaType = normalized.type;
    if (Array.isArray(schemaType)) {
      normalized.type = 'object';
    } else if (
      typeof schemaType !== 'string' ||
      schemaType.toLowerCase() !== 'object'
    ) {
      normalized.type = 'object';
    }

    delete normalized.oneOf;
    delete normalized.anyOf;
    delete normalized.allOf;
    delete normalized.enum;
    delete normalized.not;

    if (!this.isPlainRecord(normalized.properties)) {
      normalized.properties = {};
    }

    return normalized;
  }

  private applyChatToolMessageCompatibility(
    requestBody: Record<string, unknown>,
    mode?: 'native' | 'stringify_as_user' | 'drop',
  ): void {
    if (!mode || mode === 'native' || !Array.isArray(requestBody.messages)) {
      return;
    }

    const rewritten: unknown[] = [];

    for (const item of requestBody.messages) {
      if (!this.isPlainRecord(item)) {
        rewritten.push(item);
        continue;
      }

      const role = item.role;
      if (role === 'tool' || role === 'function') {
        if (mode === 'stringify_as_user') {
          rewritten.push(this.chatToolMessageAsUserMessage(item));
        }
        continue;
      }

      if (role === 'assistant') {
        const message = { ...item };
        const toolSummary = this.chatAssistantToolSummary(message);
        if (toolSummary) {
          delete message.tool_calls;
          delete message.function_call;
          if (mode === 'stringify_as_user') {
            message.content = this.appendTextToChatContent(
              message.content,
              toolSummary,
            );
          }
        }

        if (mode === 'drop' && this.isEmptyChatContent(message.content)) {
          continue;
        }

        rewritten.push(message);
        continue;
      }

      rewritten.push(item);
    }

    requestBody.messages = rewritten;
  }

  private chatToolMessageAsUserMessage(
    message: Record<string, unknown>,
  ): Record<string, unknown> {
    const role = message.role;
    const label = role === 'function' ? 'Function result' : 'Tool result';
    const id =
      typeof message.tool_call_id === 'string' && message.tool_call_id
        ? ` ${message.tool_call_id}`
        : typeof message.name === 'string' && message.name
          ? ` ${message.name}`
          : '';
    const content = this.chatContentToText(message.content);
    return {
      role: 'user',
      content: content ? `[${label}${id}]\n${content}` : `[${label}${id}]`,
    };
  }

  private chatAssistantToolSummary(
    message: Record<string, unknown>,
  ): string {
    const parts: string[] = [];
    if (Array.isArray(message.tool_calls)) {
      const toolCalls = message.tool_calls
        .map((toolCall) => this.chatToolCallToText(toolCall))
        .filter(Boolean);
      parts.push(...toolCalls);
    }

    if (this.isPlainRecord(message.function_call)) {
      parts.push(this.legacyFunctionCallToText(message.function_call));
    }

    return parts.filter(Boolean).join('\n');
  }

  private chatToolCallToText(toolCall: unknown): string {
    if (!this.isPlainRecord(toolCall)) {
      return `[Tool call] ${this.jsonishToText(toolCall)}`;
    }

    const functionRecord = this.isPlainRecord(toolCall.function)
      ? toolCall.function
      : {};
    const id =
      typeof toolCall.id === 'string' && toolCall.id
        ? ` ${toolCall.id}`
        : '';
    const name =
      typeof functionRecord.name === 'string' && functionRecord.name
        ? functionRecord.name
        : typeof toolCall.name === 'string' && toolCall.name
          ? toolCall.name
          : 'unknown';
    const args = this.jsonishToText(
      functionRecord.arguments ?? toolCall.arguments,
    );

    return args
      ? `[Tool call${id}] ${name}: ${args}`
      : `[Tool call${id}] ${name}`;
  }

  private legacyFunctionCallToText(
    functionCall: Record<string, unknown>,
  ): string {
    const name =
      typeof functionCall.name === 'string' && functionCall.name
        ? functionCall.name
        : 'unknown';
    const args = this.jsonishToText(functionCall.arguments);
    return args
      ? `[Function call] ${name}: ${args}`
      : `[Function call] ${name}`;
  }

  private appendTextToChatContent(content: unknown, text: string): unknown {
    if (!text) return content ?? '';
    if (content === undefined || content === null) return text;
    if (typeof content === 'string') {
      return content.trim().length > 0 ? `${content}\n${text}` : text;
    }
    if (Array.isArray(content)) {
      const blocks = this.cloneJson(content) as unknown[];
      blocks.push({ type: 'text', text });
      return blocks;
    }

    const existing = this.chatContentToText(content);
    return existing ? `${existing}\n${text}` : text;
  }

  private isEmptyChatContent(content: unknown): boolean {
    return this.chatContentToText(content).trim().length === 0;
  }

  private chatContentToText(content: unknown): string {
    if (content === null || content === undefined) return '';
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return this.contentBlocksToText(content);
    if (typeof content === 'object') return this.contentBlockToText(content);
    return String(content);
  }

  private jsonishToText(value: unknown): string {
    if (value === undefined || value === null) return '';
    if (typeof value === 'string') return value;
    try {
      return JSON.stringify(value) || '';
    } catch {
      return String(value);
    }
  }

  private stringifyToolResultContent(value: unknown): void {
    if (!Array.isArray(value)) return;

    for (const item of value) {
      if (!item || typeof item !== 'object') continue;
      const record = item as Record<string, unknown>;

      if (record.type === 'tool_result' && Array.isArray(record.content)) {
        record.content = this.contentBlocksToText(record.content);
        continue;
      }

      if (Array.isArray(record.content)) {
        this.stringifyToolResultContent(record.content);
      }
    }
  }

  private contentBlocksToText(blocks: unknown[]): string {
    return blocks
      .map((block) => this.contentBlockToText(block))
      .filter(Boolean)
      .join('\n');
  }

  private contentBlockToText(block: unknown): string {
    if (block === null || block === undefined) return '';
    if (typeof block === 'string') return block;
    if (typeof block !== 'object') return String(block);

    const record = block as Record<string, unknown>;
    if (record.type === 'text') {
      return typeof record.text === 'string' ? record.text : String(record.text ?? '');
    }
    if (record.type === 'image') {
      const source =
        record.source && typeof record.source === 'object'
          ? (record.source as Record<string, unknown>)
          : {};
      const mediaType =
        typeof source.media_type === 'string' ? source.media_type : 'image';
      return `[${mediaType}]`;
    }
    if (Array.isArray(record.content)) {
      return this.contentBlocksToText(record.content);
    }
    if (typeof record.content === 'string') {
      return record.content;
    }
    return JSON.stringify(record);
  }

  private mergeMissingDefaults(current: unknown, defaults: unknown): unknown {
    if (!this.isPlainRecord(current) || !this.isPlainRecord(defaults)) {
      return current;
    }

    const merged = this.cloneJson(current) as Record<string, unknown>;
    for (const [key, defaultValue] of Object.entries(defaults)) {
      if (merged[key] === undefined) {
        merged[key] = this.cloneJson(defaultValue);
      } else {
        merged[key] = this.mergeMissingDefaults(merged[key], defaultValue);
      }
    }
    return merged;
  }

  private isPlainRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
  }

  private buildEmbeddingsRequest(
    canonical: CanonicalEmbeddingRequest,
    targetModel: string,
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: targetModel,
      input: canonical.input,
    };
    if (canonical.dimensions !== undefined) {
      body.dimensions = canonical.dimensions;
    }
    if (canonical.encoding_format) {
      body.encoding_format = canonical.encoding_format;
    }
    if (canonical.user) {
      body.user = canonical.user;
    }
    return body;
  }

  private buildRerankRequest(
    canonical: CanonicalRerankRequest,
    targetModel: string,
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: targetModel,
      query: canonical.query,
      documents: canonical.documents,
    };
    if (canonical.top_n !== undefined) {
      body.top_n = canonical.top_n;
    }
    if (canonical.return_documents !== undefined) {
      body.return_documents = canonical.return_documents;
    }
    return body;
  }

  private mediaEndpointFor(
    node: NodeConfig,
    sourceFormat: CanonicalMediaSourceFormat,
  ): string {
    switch (sourceFormat) {
      case 'image_generation':
        return node.images_generations_endpoint || '/v1/images/generations';
      case 'image_edit':
        return node.images_edits_endpoint || '/v1/images/edits';
      case 'image_variation':
        return node.images_variations_endpoint || '/v1/images/variations';
      case 'audio_transcription':
        return node.audio_transcriptions_endpoint || '/v1/audio/transcriptions';
      case 'audio_translation':
        return node.audio_translations_endpoint || '/v1/audio/translations';
      case 'audio_speech':
        return node.audio_speech_endpoint || '/v1/audio/speech';
      case 'video_generation':
        return node.video_endpoint || node.video_generations_endpoint || '/v1/videos/generations';
      default:
        return node.endpoint;
    }
  }

  private buildMediaRequest(
    canonical: CanonicalMediaRequest,
    targetModel: string,
  ): { body: Record<string, unknown> | Buffer; contentType: string } {
    if (Buffer.isBuffer(canonical.payload)) {
      return {
        body: this.withMultipartModel(canonical.payload, canonical.content_type, targetModel),
        contentType: canonical.content_type,
      };
    }

    return {
      body: {
        ...canonical.payload,
        model: targetModel,
      },
      contentType: 'application/json',
    };
  }

  private withMultipartModel(
    body: Buffer,
    contentType: string,
    targetModel: string,
  ): Buffer {
    const boundaryMatch = /boundary=([^;]+)/i.exec(contentType);
    if (!boundaryMatch) return body;

    const boundary = boundaryMatch[1].replace(/^"|"$/g, '');
    const raw = body.toString('latin1');
    const parts = raw.split(`--${boundary}`);
    let replaced = false;
    const rewritten = parts.map((part) => {
      if (replaced || !part.includes('name="model"')) return part;
      const valueStart = part.indexOf('\r\n\r\n');
      if (valueStart < 0) return part;
      const valueEnd = part.indexOf('\r\n', valueStart + 4);
      replaced = true;
      return `${part.slice(0, valueStart + 4)}${targetModel}${part.slice(valueEnd >= 0 ? valueEnd : part.length)}`;
    }).join(`--${boundary}`);

    if (replaced) {
      return Buffer.from(rewritten, 'latin1');
    }

    const closing = `--${boundary}--`;
    const insertAt = raw.lastIndexOf(closing);
    if (insertAt < 0) return body;
    const field =
      `--${boundary}\r\n` +
      'Content-Disposition: form-data; name="model"\r\n\r\n' +
      `${targetModel}\r\n`;
    return Buffer.from(`${raw.slice(0, insertAt)}${field}${raw.slice(insertAt)}`, 'latin1');
  }

  private shouldPassthroughNativeMessages(
    canonical: CanonicalRequest,
    protocol: NodeProtocol,
  ): boolean {
    return protocol === 'messages' && canonical.metadata.source_format === 'messages';
  }

  private shouldPassthroughNativeResponses(
    canonical: CanonicalRequest,
    protocol: NodeProtocol,
  ): boolean {
    return protocol === 'responses' && canonical.metadata.source_format === 'responses';
  }

  private shouldPassthroughRawSse(
    canonical: CanonicalRequest,
    protocol: NodeProtocol,
  ): boolean {
    return (
      this.shouldPassthroughNativeResponses(canonical, protocol) ||
      this.shouldPassthroughNativeMessages(canonical, protocol)
    );
  }

  private buildNativeResponsesRequest(
    canonical: CanonicalRequest,
    targetModel: string,
  ): Record<string, unknown> {
    const rawBody = this.isPlainRecord(canonical.metadata.raw_body)
      ? canonical.metadata.raw_body
      : null;
    const cloned = rawBody
      ? (this.cloneJson(rawBody) as Record<string, unknown>)
      : this.respDenorm.denormalize(canonical, targetModel);
    cloned.model = targetModel;
    cloned.stream = canonical.stream;
    return cloned;
  }

  private buildNativeMessagesRequest(
    canonical: CanonicalRequest,
    targetModel: string,
  ): Record<string, unknown> {
    const rawBody =
      canonical.metadata.raw_body &&
      typeof canonical.metadata.raw_body === 'object' &&
      !Array.isArray(canonical.metadata.raw_body)
        ? (canonical.metadata.raw_body as Record<string, unknown>)
        : {};

    const cloned = JSON.parse(JSON.stringify(rawBody)) as Record<string, unknown>;
    cloned.model = targetModel;
    cloned.stream = canonical.stream;
    const outputFormat = toAnthropicMessagesOutputFormat(
      canonical.response_format,
    );
    if (outputFormat) {
      const outputConfig =
        cloned.output_config &&
        typeof cloned.output_config === 'object' &&
        !Array.isArray(cloned.output_config)
          ? (cloned.output_config as Record<string, unknown>)
          : {};
      cloned.output_config = {
        ...outputConfig,
        format: outputFormat,
      };
      delete cloned.output_format;
      delete cloned.response_format;
      delete cloned.text;
    }
    const choice = this.isPlainRecord(cloned.tool_choice) ? cloned.tool_choice : null;
    if (cloned.thinking === undefined) {
      // Respect mapped caller intent before suppressing a provider's default.
      const thinking = toAnthropicThinking(canonical.reasoning, canonical.max_tokens);
      if (thinking) cloned.thinking = thinking;
      else if (
        !canonical.reasoning?.requested &&
        (choice?.type === 'tool' || choice?.type === 'any')
      ) {
        cloned.thinking = { type: 'disabled' };
      }
    }
    return this.sanitizeNativeMessagesRequest(cloned);
  }

  private sanitizeNativeMessagesRequest(
    body: Record<string, unknown>,
  ): Record<string, unknown> {
    const sanitizeContentField = (value: unknown): string | unknown[] => {
      if (typeof value === 'string') {
        return value;
      }
      if (Array.isArray(value)) {
        const blocks = sanitizeBlocks(value) as unknown[];
        return blocks.length > 0 ? blocks : '';
      }
      if (value === null || value === undefined) {
        return '';
      }
      if (typeof value === 'object') {
        return JSON.stringify(value);
      }
      return String(value);
    };

    const sanitizeBlocks = (value: unknown): unknown => {
      if (!Array.isArray(value)) {
        return value;
      }

      const sanitized: unknown[] = [];
      for (const block of value) {
        if (block === null || block === undefined) {
          continue;
        }

        if (typeof block === 'string') {
          if (block.length > 0) {
            sanitized.push({ type: 'text', text: block });
          }
          continue;
        }

        if (typeof block !== 'object') {
          sanitized.push({ type: 'text', text: String(block) });
          continue;
        }

        const typedBlock = block as Record<string, unknown>;
        if (
          typedBlock.tool_use &&
          typeof typedBlock.tool_use === 'object' &&
          !Array.isArray(typedBlock.tool_use)
        ) {
          sanitized.push({
            ...typedBlock,
            tool_use: this.normalizeToolUseBlock(
              typedBlock.tool_use as Record<string, unknown>,
            ),
          });
          continue;
        }

        if (typeof typedBlock.type !== 'string' || typedBlock.type.length === 0) {
          sanitized.push({ type: 'text', text: JSON.stringify(typedBlock) });
          continue;
        }

        if (typedBlock.type === 'text') {
          if (typeof typedBlock.text === 'string' && typedBlock.text.length > 0) {
            sanitized.push(block);
          } else if (
            typedBlock.text !== null &&
            typedBlock.text !== undefined &&
            typeof typedBlock.text !== 'string'
          ) {
            sanitized.push({ ...typedBlock, text: String(typedBlock.text) });
          }
          continue;
        }

        if (
          typedBlock.type === 'thinking' ||
          typedBlock.type === 'redacted_thinking'
        ) {
          // Signed native history must be replayed verbatim, including empty
          // thinking and opaque redacted data. The provider validates it.
          sanitized.push(block);
          continue;
        }

        if (typedBlock.type === 'tool_use') {
          sanitized.push(this.normalizeToolUseBlock(typedBlock));
          continue;
        }

        if (Object.prototype.hasOwnProperty.call(typedBlock, 'content')) {
          sanitized.push({
            ...typedBlock,
            content: sanitizeContentField(typedBlock.content),
          });
          continue;
        }

        sanitized.push(block);
      }

      return sanitized;
    };

    if (Array.isArray(body.messages)) {
      body.messages = (body.messages as unknown[]).flatMap((message) => {
        if (!message || typeof message !== 'object') {
          return [];
        }

        const typedMessage = { ...(message as Record<string, unknown>) };
        if (typedMessage.role !== 'user' && typedMessage.role !== 'assistant') {
          return [];
        }
        typedMessage.content = sanitizeContentField(typedMessage.content);
        return [typedMessage];
      });
    }

    if (body.system !== undefined) {
      body.system = sanitizeContentField(body.system);
    }

    return body;
  }

  private normalizeToolUseInput(input: unknown): Record<string, unknown> {
    if (input && typeof input === 'object' && !Array.isArray(input)) {
      return input as Record<string, unknown>;
    }
    if (typeof input === 'string' && input.trim()) {
      try {
        const parsed = JSON.parse(input) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        return { value: input };
      }
      return { value: input };
    }
    return {};
  }

  private normalizeToolUseBlock(
    block: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      ...block,
      input: this.normalizeToolUseInput(block.input),
    };
  }

  private extractNativeMessageHeaders(
    canonical: CanonicalRequest,
  ): Record<string, string> {
    const rawHeaders = canonical.metadata.raw_headers || {};
    const forwarded: Record<string, string> = {};

    const anthropicVersion = rawHeaders['anthropic-version'];
    if (anthropicVersion) {
      forwarded['anthropic-version'] = anthropicVersion;
    }

    const anthropicBeta = rawHeaders['anthropic-beta'];
    if (anthropicBeta) {
      const filteredBetas = anthropicBeta
        .split(',')
        .map((beta) => beta.trim())
        .filter((beta) => beta && this.allowedAnthropicBetas.has(beta));

      if (filteredBetas.length > 0) {
        forwarded['anthropic-beta'] = filteredBetas.join(',');
      }
    }

    return forwarded;
  }

  // ══════════════════════════════════════════════════════
  // Response Normalization (non-stream)
  // ══════════════════════════════════════════════════════

  normalizeResponse(
    body: Record<string, unknown>,
    protocol: NodeProtocol,
    routingMeta: {
      tier: Tier;
      score: number;
      is_fallback: boolean;
      fallback_reason?: string | null;
    },
    nodeId: string,
    model: string,
    latencyMs: number,
    usageSchema?: UsageSchema,
  ): CanonicalResponse {
    switch (protocol) {
      case 'chat_completions':
        return this.normalizeChatCompletionsResponse(
          body,
          routingMeta,
          nodeId,
          model,
          latencyMs,
          usageSchema,
        );
      case 'responses':
        return this.normalizeResponsesResponse(
          body,
          routingMeta,
          nodeId,
          model,
          latencyMs,
          usageSchema,
        );
      case 'messages':
        return this.normalizeMessagesResponse(
          body,
          routingMeta,
          nodeId,
          model,
          latencyMs,
          usageSchema,
        );
      case 'gemini':
        return this.normalizeGeminiResponse(
          body,
          routingMeta,
          nodeId,
          model,
          latencyMs,
          usageSchema,
        );
      default:
        throw new Error(`Unsupported protocol: ${protocol}`);
    }
  }

  normalizeEmbeddingsResponse(
    body: Record<string, unknown>,
    routingMeta: {
      tier: Tier;
      score: number;
      is_fallback: boolean;
      fallback_reason?: string | null;
    },
    nodeId: string,
    model: string,
    latencyMs: number,
  ): CanonicalEmbeddingResponse {
    const usage = (body.usage || {}) as Record<string, unknown>;
    const data = Array.isArray(body.data) ? body.data : [];
    return {
      id: (body.id as string) || `emb_${Date.now()}`,
      object: 'list',
      data: data.map((item, index) => {
        const entry =
          item && typeof item === 'object'
            ? (item as Record<string, unknown>)
            : {};
        return {
          index:
            typeof entry.index === 'number' && Number.isFinite(entry.index)
              ? entry.index
              : index,
          embedding: Array.isArray(entry.embedding) || typeof entry.embedding === 'string'
            ? (entry.embedding as number[] | string)
            : [],
        };
      }),
      usage: {
        input_tokens:
          (usage.prompt_tokens as number) ||
          (usage.input_tokens as number) ||
          (usage.total_tokens as number) ||
          0,
        output_tokens: 0,
      },
      model: (body.model as string) || model,
      routing: { ...routingMeta, node: nodeId, latency_ms: latencyMs },
    };
  }

  normalizeRerankResponse(
    body: Record<string, unknown>,
    canonical: CanonicalRerankRequest,
    routingMeta: {
      tier: Tier;
      score: number;
      is_fallback: boolean;
      fallback_reason?: string | null;
    },
    nodeId: string,
    model: string,
    latencyMs: number,
  ): CanonicalRerankResponse {
    const usage = (body.usage || body.meta || {}) as Record<string, unknown>;
    const billedUnits = (usage.billed_units || {}) as Record<string, unknown>;
    const results = Array.isArray(body.results)
      ? body.results
      : Array.isArray(body.data)
        ? body.data
        : [];

    return {
      id: (body.id as string) || `rerank_${Date.now()}`,
      object: 'rerank',
      results: results.map((item, index) => {
        const entry =
          item && typeof item === 'object'
            ? (item as Record<string, unknown>)
            : {};
        const resultIndex =
          typeof entry.index === 'number' && Number.isFinite(entry.index)
            ? entry.index
            : index;
        return {
          index: resultIndex,
          relevance_score:
            typeof entry.relevance_score === 'number' && Number.isFinite(entry.relevance_score)
              ? entry.relevance_score
              : typeof entry.score === 'number' && Number.isFinite(entry.score)
                ? entry.score
                : 0,
          document:
            entry.document !== undefined
              ? (entry.document as CanonicalRerankResponse['results'][number]['document'])
              : canonical.return_documents
                ? canonical.documents[resultIndex]
                : undefined,
        };
      }),
      usage: {
        input_tokens:
          (usage.prompt_tokens as number) ||
          (usage.input_tokens as number) ||
          (usage.total_tokens as number) ||
          (billedUnits.input_tokens as number) ||
          (billedUnits.search_units as number) ||
          0,
        output_tokens: (usage.output_tokens as number) || 0,
      },
      model: (body.model as string) || model,
      routing: { ...routingMeta, node: nodeId, latency_ms: latencyMs },
    };
  }

  private async normalizeMediaResponse(
    response: Response,
    canonical: CanonicalMediaRequest,
    routingMeta: {
      tier: Tier;
      score: number;
      is_fallback: boolean;
      fallback_reason?: string | null;
    },
    nodeId: string,
    model: string,
    latencyMs: number,
  ): Promise<CanonicalMediaResponse> {
    const contentType = response.headers.get('content-type') || 'application/octet-stream';
    const providerResponseType = contentType.split(';')[0].trim().toLowerCase() || contentType;
    if (contentType.includes('application/json')) {
      const body = (await response.json()) as Record<string, unknown>;
      const usage = (body.usage || {}) as Record<string, unknown>;
      return {
        id: (body.id as string) || `${canonical.source_format}_${Date.now()}`,
        body,
        content_type: contentType,
        provider_response_type: providerResponseType,
        usage: {
          input_tokens:
            (usage.prompt_tokens as number) ||
            (usage.input_tokens as number) ||
            (usage.total_tokens as number) ||
            0,
          output_tokens:
            (usage.completion_tokens as number) ||
            (usage.output_tokens as number) ||
            0,
        },
        model: (body.model as string) || model,
        routing: { ...routingMeta, node: nodeId, latency_ms: latencyMs },
      };
    }

    const arrayBuffer = await response.arrayBuffer();
    return {
      id: `${canonical.source_format}_${Date.now()}`,
      body: Buffer.from(arrayBuffer),
      content_type: contentType,
      provider_response_type: providerResponseType,
      usage: { input_tokens: 0, output_tokens: 0 },
      model,
      routing: { ...routingMeta, node: nodeId, latency_ms: latencyMs },
    };
  }

  private normalizeChatCompletionsResponse(
    body: Record<string, unknown>,
    routingMeta: {
      tier: Tier;
      score: number;
      is_fallback: boolean;
      fallback_reason?: string | null;
    },
    nodeId: string,
    model: string,
    latencyMs: number,
    usageSchema?: UsageSchema,
  ): CanonicalResponse {
    const choices = body.choices as Record<string, unknown>[];
    const choice = choices?.[0] || {};
    const message = (choice.message || {}) as Record<string, unknown>;
    const content: CanonicalContentBlock[] = [];

    if (message.content && typeof message.content === 'string') {
      content.push({ type: 'text', text: message.content });
    }
    if (message.tool_calls && Array.isArray(message.tool_calls)) {
      for (const tc of message.tool_calls as Record<string, unknown>[]) {
        const fn = tc.function as Record<string, unknown>;
        content.push({
          type: 'tool_use', id: (tc.id as string) || '', name: (fn.name as string) || '',
          input: this.safeParseJson((fn.arguments as string) || '{}'),
        });
      }
    }

    const fallbackUsage: TokenUsage = {
      input_tokens: ((body.usage as Record<string, unknown>)?.prompt_tokens as number) || 0,
      output_tokens:
        ((body.usage as Record<string, unknown>)?.completion_tokens as number) || 0,
      cache_read_input_tokens:
        ((((body.usage as Record<string, unknown>)?.prompt_tokens_details as Record<
          string,
          unknown
        >)?.cached_tokens as number) || 0),
    };

    return {
      id: (body.id as string) || `gen_${Date.now()}`, content,
      stop_reason: this.mapChatFinishReason(choice.finish_reason as string),
      usage: this.resolveNormalizedUsage(body, usageSchema, fallbackUsage),
      model: (body.model as string) || model,
      routing: { ...routingMeta, node: nodeId, latency_ms: latencyMs },
    };
  }

  private normalizeResponsesResponse(
    body: Record<string, unknown>,
    routingMeta: {
      tier: Tier;
      score: number;
      is_fallback: boolean;
      fallback_reason?: string | null;
    },
    nodeId: string,
    model: string,
    latencyMs: number,
    usageSchema?: UsageSchema,
  ): CanonicalResponse {
    const output = (body.output || []) as Record<string, unknown>[];
    const content: CanonicalContentBlock[] = [];

    for (const item of output) {
      if (item.type === 'message') {
        const msgContent = item.content as Record<string, unknown>[];
        if (Array.isArray(msgContent)) {
          for (const part of msgContent) {
            if (part.type === 'output_text') content.push({ type: 'text', text: (part.text as string) || '' });
          }
        }
      } else if (item.type === 'function_call') {
        content.push({
          type: 'tool_use', id: (item.call_id as string) || (item.id as string) || '',
          name: (item.name as string) || '', input: this.safeParseJson((item.arguments as string) || '{}'),
        });
      }
    }

    const fallbackUsage: TokenUsage = {
      input_tokens: ((body.usage as Record<string, unknown>)?.input_tokens as number) || 0,
      output_tokens:
        ((body.usage as Record<string, unknown>)?.output_tokens as number) || 0,
      cache_read_input_tokens:
        ((((body.usage as Record<string, unknown>)?.input_tokens_details as Record<
          string,
          unknown
        >)?.cached_tokens as number) ||
          (((body.usage as Record<string, unknown>)?.prompt_tokens_details as Record<
            string,
            unknown
          >)?.cached_tokens as number) ||
          ((((body.usage as Record<string, unknown>)?.input_token_details as Record<
            string,
            unknown
          >)?.cached_tokens as number) || 0)),
    };

    return {
      id: (body.id as string) || `gen_${Date.now()}`, content,
      stop_reason: this.mapResponsesStatus(body.status as string),
      usage: this.resolveNormalizedUsage(body, usageSchema, fallbackUsage),
      model: (body.model as string) || model,
      routing: { ...routingMeta, node: nodeId, latency_ms: latencyMs },
    };
  }

  private normalizeMessagesResponse(
    body: Record<string, unknown>,
    routingMeta: {
      tier: Tier;
      score: number;
      is_fallback: boolean;
      fallback_reason?: string | null;
    },
    nodeId: string,
    model: string,
    latencyMs: number,
    usageSchema?: UsageSchema,
  ): CanonicalResponse {
    const rawContent = (body.content || []) as Record<string, unknown>[];
    const content: CanonicalContentBlock[] = [];

    for (const block of rawContent) {
      if (block.type === 'text') content.push({ type: 'text', text: (block.text as string) || '' });
      else if (block.type === 'thinking') {
        content.push({
          type: 'thinking',
          thinking: typeof block.thinking === 'string' ? block.thinking : '',
          ...(typeof block.signature === 'string' ? { signature: block.signature } : {}),
        });
      } else if (block.type === 'redacted_thinking' && typeof block.data === 'string') {
        content.push({ type: 'redacted_thinking', data: block.data });
      } else if (block.type === 'tool_use') {
        content.push({
          type: 'tool_use', id: (block.id as string) || '', name: (block.name as string) || '',
          input: (block.input as Record<string, unknown>) || {},
        });
      }
    }

    const fallbackUsage: TokenUsage = {
      input_tokens: ((body.usage as Record<string, unknown>)?.input_tokens as number) || 0,
      output_tokens:
        ((body.usage as Record<string, unknown>)?.output_tokens as number) || 0,
      cache_creation_input_tokens:
        (((body.usage as Record<string, unknown>)?.cache_creation_input_tokens as number) ||
          0),
      cache_read_input_tokens:
        (((body.usage as Record<string, unknown>)?.cache_read_input_tokens as number) || 0),
    };

    return {
      id: (body.id as string) || `gen_${Date.now()}`,
      content,
      native_messages_content: this.cloneJson(rawContent) as Record<
        string,
        unknown
      >[],
      stop_reason: (body.stop_reason as StopReason) || 'end_turn',
      stop_sequence: typeof body.stop_sequence === 'string' ? body.stop_sequence : null,
      usage: this.resolveNormalizedUsage(body, usageSchema, fallbackUsage),
      model: (body.model as string) || model,
      routing: { ...routingMeta, node: nodeId, latency_ms: latencyMs },
    };
  }

  private normalizeGeminiResponse(
    body: Record<string, unknown>,
    routingMeta: {
      tier: Tier;
      score: number;
      is_fallback: boolean;
      fallback_reason?: string | null;
    },
    nodeId: string,
    model: string,
    latencyMs: number,
    usageSchema?: UsageSchema,
  ): CanonicalResponse {
    const candidates = Array.isArray(body.candidates)
      ? (body.candidates as Record<string, unknown>[])
      : [];
    const candidate = candidates[0] || {};
    const candidateContent = (candidate.content || {}) as Record<string, unknown>;
    const parts = Array.isArray(candidateContent.parts)
      ? (candidateContent.parts as Record<string, unknown>[])
      : [];
    const content: CanonicalContentBlock[] = [];

    for (const part of parts) {
      if (typeof part.text === 'string') {
        content.push({ type: 'text', text: part.text });
      } else if (part.functionCall && typeof part.functionCall === 'object') {
        const functionCall = part.functionCall as Record<string, unknown>;
        content.push({
          type: 'tool_use',
          id: (functionCall.id as string) || (functionCall.name as string) || '',
          name: (functionCall.name as string) || '',
          input:
            functionCall.args &&
            typeof functionCall.args === 'object' &&
            !Array.isArray(functionCall.args)
              ? (functionCall.args as Record<string, unknown>)
              : {},
        });
      }
    }

    const usageMetadata = (body.usageMetadata || {}) as Record<string, unknown>;
    const fallbackUsage: TokenUsage = {
      input_tokens: (usageMetadata.promptTokenCount as number) || 0,
      output_tokens: (usageMetadata.candidatesTokenCount as number) || 0,
      cache_read_input_tokens:
        (usageMetadata.cachedContentTokenCount as number) || 0,
    };

    return {
      id: (body.responseId as string) || `gemini_${Date.now()}`,
      content,
      stop_reason: this.mapGeminiFinishReason(candidate.finishReason as string),
      usage: isNativeGeminiUsageSchema(usageSchema) ? geminiCompatibilityUsage(usageMetadata) : this.resolveNormalizedUsage(body, usageSchema, fallbackUsage),
      model: (body.modelVersion as string) || model,
      routing: { ...routingMeta, node: nodeId, latency_ms: latencyMs },
    };
  }

  // ══════════════════════════════════════════════════════
  // Helpers
  // ══════════════════════════════════════════════════════

  private mapChatFinishReason(reason: string): StopReason {
    switch (reason) {
      case 'stop': return 'end_turn';
      case 'tool_calls': return 'tool_use';
      case 'length': return 'max_tokens';
      default: return 'end_turn';
    }
  }

  private mapResponsesStatus(status: string): StopReason {
    if (status === 'completed') return 'end_turn';
    if (status === 'incomplete') return 'max_tokens';
    return 'end_turn';
  }

  private mapGeminiFinishReason(reason: string): StopReason {
    switch (reason) {
      case 'MAX_TOKENS':
        return 'max_tokens';
      case 'MALFORMED_FUNCTION_CALL':
        return 'tool_use';
      case 'STOP':
      default:
        return 'end_turn';
    }
  }

  private safeParseJson(str: string): Record<string, unknown> {
    try { return JSON.parse(str); } catch { return { _raw: str }; }
  }

  private resolveUsageSchemaForNode(node: NodeConfig): UsageSchema | undefined {
    return resolveNodeUsageSchema(
      node,
      node.protocol,
      this.getMergedCatalogSafely(),
    );
  }

  private getMergedCatalogSafely() {
    return typeof this.config.getMergedCatalog === 'function'
      ? this.config.getMergedCatalog()
      : undefined;
  }

  private resolveNormalizedUsage(
    body: Record<string, unknown>,
    usageSchema: UsageSchema | undefined,
    fallbackUsage: TokenUsage,
  ): TokenUsage {
    const schemaUsage = usageSchema
      ? extractUsageBySchema(body, usageSchema)
      : { input_tokens: 0, output_tokens: 0 };
    const knownUsage = extractUsageByKnownFields(body);
    return {
      input_tokens:
        schemaUsage.input_tokens ||
        knownUsage.input_tokens ||
        fallbackUsage.input_tokens ||
        0,
      output_tokens:
        schemaUsage.output_tokens ||
        knownUsage.output_tokens ||
        fallbackUsage.output_tokens ||
        0,
      cache_creation_input_tokens:
        schemaUsage.cache_creation_input_tokens ||
        knownUsage.cache_creation_input_tokens ||
        fallbackUsage.cache_creation_input_tokens ||
        0,
      cache_read_input_tokens:
        schemaUsage.cache_read_input_tokens ||
        knownUsage.cache_read_input_tokens ||
        fallbackUsage.cache_read_input_tokens ||
        0,
    };
  }
}

// ══════════════════════════════════════════════════════
// Custom Error
// ══════════════════════════════════════════════════════

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly nodeId: string,
    public readonly failureType:
      | 'timeout'
      | 'rate_limited'
      | 'http_error'
      | 'network_error' = 'http_error',
    public readonly credentialId?: string,
    public readonly credentialStrategy?: string,
    public readonly credentialRetryCount = 0,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

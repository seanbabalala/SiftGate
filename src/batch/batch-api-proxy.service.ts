import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { withCoordinatedRepository } from '../database/coordinated-repository';
import type { Request } from 'express';
import { ConfigService } from '../config/config.service';
import type { NodeConfig } from '../config/gateway.config';
import { BudgetExceededError, BudgetService } from '../budget/budget.service';
import { CallLog } from '../database/entities';
import { TelemetryService } from '../telemetry/telemetry.service';
import { normalizeRequestIdentityHeaders } from '../canonical/normalizers/request-metadata';
import { gatewayApiKeyFromRequest } from '../auth/gateway-api-key-metadata';
import type { GatewayApiKeyContext } from '../auth/gateway-api-key.service';
import { WorkspaceContextService } from '../workspaces/workspace-context.service';
import type { ErrorRedactionTelemetry } from '../security/error-redaction';
import { normalizeWorkspaceId } from '../workspaces/workspace-scope';
import { BatchJobStoreService } from './batch-job-store.service';
import { BatchProviderAdapterService } from './batch-provider-adapter.service';
import type {
  BatchCreateInput,
  BatchDownloadInput,
  BatchExistingJobInput,
  BatchProxyResponse,
  BatchRequestContext,
  BatchTarget,
} from './batch.types';
import {
  extractBatchProviderError,
  redactBatchProviderErrorText,
  sanitizeBatchProviderErrorBody,
} from './batch-error-redaction';

@Injectable()
export class BatchApiProxyService {
  constructor(
    private readonly config: ConfigService,
    private readonly budget: BudgetService,
    private readonly adapter: BatchProviderAdapterService,
    private readonly jobs: BatchJobStoreService,
    private readonly telemetry: TelemetryService,
    private readonly workspaceContext: WorkspaceContextService,
    @InjectRepository(CallLog)
    private readonly callLogs: Repository<CallLog>,
  ) {}

  buildContext(req: Request, operation: BatchRequestContext['operation']): BatchRequestContext {
    const headers = this.extractHeaders(req);
    const identity = normalizeRequestIdentityHeaders(headers);
    return {
      requestId: this.requestId(headers),
      operation,
      apiKey: gatewayApiKeyFromRequest(req),
      headers,
      startedAt: Date.now(),
      session_id: identity.session_id,
      trace_id: identity.trace_id,
      client_source: identity.client_source,
    };
  }

  async create(input: BatchCreateInput): Promise<BatchProxyResponse> {
    this.assertBody(input.body);
    const target = this.resolveCreateTarget(input.body, input.context);
    const node = this.config.getNode(target.nodeId);
    if (!node) throw new BadRequestException(`Batch node "${target.nodeId}" is not configured.`);

    this.assertApiKeyAllowed(input.context.apiKey, target, input.body, input.context);
    await this.checkBudget(input.context.apiKey);

    const response = await this.adapter.create(node, input.body, input.context.requestId);
    const body = this.responseBody(response.body);
    const publicBody = this.publicResponseBody(response.body, response.statusCode);
    let providerBatchId: string | null = null;
    let status: string | null = null;
    let error: string | null = null;

    if (this.isRecord(body)) {
      providerBatchId = this.firstString(body.id, body.batch_id, body.name);
      status = this.firstString(body.status, body.state);
      error = extractBatchProviderError(body.error, this.batchRedactionTelemetry());
      if (response.statusCode >= 200 && response.statusCode < 300) {
        await this.jobs.createFromProvider({
          requestId: input.context.requestId,
          nodeId: target.nodeId,
          model: target.model,
          requestBody: input.body,
          providerBody: body,
          apiKey: input.context.apiKey,
        });
      }
    } else if (response.statusCode >= 400) {
      error = redactBatchProviderErrorText(String(body), {
        maxLength: 500,
        telemetry: this.batchRedactionTelemetry(),
      });
    }

    await this.recordZeroUsage(input.context.apiKey);
    await this.logBatchCall({
      context: input.context,
      target,
      statusCode: response.statusCode,
      latencyMs: response.latencyMs,
      error,
    });

    return {
      statusCode: response.statusCode,
      contentType: response.contentType,
      body: publicBody,
      headers: response.headers,
      requestId: input.context.requestId,
      nodeId: target.nodeId,
      model: target.model,
      endpoint: target.endpoint,
      providerBatchId,
      status,
      error,
    };
  }

  async retrieve(input: BatchExistingJobInput): Promise<BatchProxyResponse> {
    const job = await this.getAccessibleJob(input.id, input.context.apiKey);
    this.assertApiKeyAllowedForStoredJob(input.context.apiKey, job, input.context);
    const node = this.requireNode(job.node_id);
    await this.checkBudget(input.context.apiKey);

    const response = await this.adapter.retrieve(
      node,
      job.provider_batch_id || job.request_id,
      input.context.requestId,
    );
    const body = this.responseBody(response.body);
    const publicBody = this.publicResponseBody(response.body, response.statusCode);
    let error: string | null = null;
    if (this.isRecord(body)) {
      await this.jobs.updateFromProvider(job, body);
      error = extractBatchProviderError(body.error, this.batchRedactionTelemetry());
    } else if (response.statusCode >= 400) {
      error = redactBatchProviderErrorText(String(body), {
        maxLength: 500,
        telemetry: this.batchRedactionTelemetry(),
      });
    }

    await this.recordZeroUsage(input.context.apiKey);
    await this.logBatchCall({
      context: input.context,
      target: { nodeId: job.node_id, model: job.model, endpoint: job.endpoint },
      statusCode: response.statusCode,
      latencyMs: response.latencyMs,
      error,
    });

    return {
      statusCode: response.statusCode,
      contentType: response.contentType,
      body: publicBody,
      headers: response.headers,
      requestId: input.context.requestId,
      nodeId: job.node_id,
      model: job.model,
      endpoint: job.endpoint,
      providerBatchId: job.provider_batch_id,
      status: this.isRecord(body) ? this.firstString(body.status, body.state) : job.status,
      error,
    };
  }

  async cancel(input: BatchExistingJobInput): Promise<BatchProxyResponse> {
    const job = await this.getAccessibleJob(input.id, input.context.apiKey);
    this.assertApiKeyAllowedForStoredJob(
      input.context.apiKey,
      job,
      input.context,
    );
    const node = this.requireNode(job.node_id);
    await this.checkBudget(input.context.apiKey);

    const response = await this.adapter.cancel(
      node,
      job.provider_batch_id || job.request_id,
      input.context.requestId,
    );
    const body = this.responseBody(response.body);
    const publicBody = this.publicResponseBody(
      response.body,
      response.statusCode,
    );
    let error: string | null = null;
    if (response.statusCode === 204) {
      // JSON adapters represent an empty 204 as {}; do not treat that as a new validating job.
      job.status = (await this.jobs.markCancelled(job)).status;
    } else if (this.isRecord(body)) {
      await this.jobs.updateFromProvider(job, body);
      error = extractBatchProviderError(
        body.error,
        this.batchRedactionTelemetry(),
      );
    } else if (response.statusCode >= 400) {
      error = redactBatchProviderErrorText(String(body), {
        maxLength: 500,
        telemetry: this.batchRedactionTelemetry(),
      });
    } else {
      job.status = (await this.jobs.markCancelled(job)).status;
    }

    await this.recordZeroUsage(input.context.apiKey);
    await this.logBatchCall({
      context: input.context,
      target: { nodeId: job.node_id, model: job.model, endpoint: job.endpoint },
      statusCode: response.statusCode,
      latencyMs: response.latencyMs,
      error,
    });

    return {
      statusCode: response.statusCode,
      contentType: response.contentType,
      body: publicBody,
      headers: response.headers,
      requestId: input.context.requestId,
      nodeId: job.node_id,
      model: job.model,
      endpoint: job.endpoint,
      providerBatchId: job.provider_batch_id,
      status: this.isRecord(body)
        ? this.firstString(body.status, body.state) || job.status
        : job.status,
      error,
    };
  }

  async download(input: BatchDownloadInput): Promise<BatchProxyResponse> {
    const job = await this.getAccessibleJob(input.id, input.context.apiKey);
    this.assertApiKeyAllowedForStoredJob(input.context.apiKey, job, input.context);
    const node = this.requireNode(job.node_id);
    const fileId = input.fileKind === 'error' ? job.error_file_id : job.output_file_id;
    if (!fileId) {
      throw new BadRequestException(
        input.fileKind === 'error'
          ? 'Batch error file is not available yet.'
          : 'Batch output file is not available yet.',
      );
    }
    await this.checkBudget(input.context.apiKey);

    const response = await this.adapter.downloadOutput(
      node,
      { batchId: job.provider_batch_id || job.request_id, fileId },
      input.context.requestId,
    );
    const error =
      response.statusCode >= 400
        ? redactBatchProviderErrorText(String(response.body), {
          maxLength: 500,
          telemetry: this.batchRedactionTelemetry(),
        })
        : null;
    const publicBody =
      response.statusCode >= 400
        ? sanitizeBatchProviderErrorBody(response.body, this.batchRedactionTelemetry())
        : response.body;

    await this.recordZeroUsage(input.context.apiKey);
    await this.logBatchCall({
      context: input.context,
      target: { nodeId: job.node_id, model: job.model, endpoint: job.endpoint },
      statusCode: response.statusCode,
      latencyMs: response.latencyMs,
      error,
    });

    return {
      statusCode: response.statusCode,
      contentType: response.contentType,
      body: publicBody,
      headers: response.headers,
      requestId: input.context.requestId,
      nodeId: job.node_id,
      model: job.model,
      endpoint: job.endpoint,
      providerBatchId: job.provider_batch_id,
      status: job.status,
      error,
    };
  }

  private resolveCreateTarget(
    body: Record<string, unknown>,
    context: BatchRequestContext,
  ): BatchTarget {
    const nodeHint = this.firstString(
      body.node,
      body.node_id,
      context.headers['x-siftgate-node'],
      context.headers['x-siftgate-batch-node'],
    );
    const modelHint = this.firstString(
      body.model,
      body.batch_model,
      context.headers['x-siftgate-model'],
    );
    const endpoint = this.firstString(body.endpoint);

    if (nodeHint) {
      const node = this.config.getNode(nodeHint);
      if (!node) throw new BadRequestException(`Batch node "${nodeHint}" is not configured.`);
      return {
        nodeId: node.id,
        model: modelHint || this.defaultModelForEndpoint(node, endpoint),
        endpoint,
      };
    }

    if (modelHint) {
      const resolved = this.resolveModelHint(modelHint, endpoint);
      if (resolved) {
        return { nodeId: resolved.nodeId, model: resolved.model, endpoint };
      }
    }

    const candidate = this.defaultNodeForEndpoint(endpoint);
    if (!candidate) {
      throw new BadRequestException('No node is configured for OpenAI-compatible batch proxying.');
    }
    return {
      nodeId: candidate.id,
      model: modelHint || this.defaultModelForEndpoint(candidate, endpoint),
      endpoint,
    };
  }

  private resolveModelHint(
    model: string,
    endpoint: string | null,
  ): { nodeId: string; model: string } | null {
    const normalizedEndpoint = endpoint || '';
    if (normalizedEndpoint.includes('embeddings')) {
      return this.config.resolveEmbeddingModel(model) || this.config.resolveModel(model);
    }
    if (normalizedEndpoint.includes('rerank')) {
      return this.config.resolveRerankModel(model) || this.config.resolveModel(model);
    }
    if (normalizedEndpoint.includes('images')) {
      return this.config.resolveImageModel(model) || this.config.resolveModel(model);
    }
    if (normalizedEndpoint.includes('audio')) {
      return this.config.resolveAudioModel(model) || this.config.resolveModel(model);
    }
    if (normalizedEndpoint.includes('videos')) {
      return this.config.resolveVideoModel(model) || this.config.resolveModel(model);
    }
    return this.config.resolveModel(model);
  }

  private defaultNodeForEndpoint(endpoint: string | null): NodeConfig | null {
    const nodes = this.config.nodes;
    const normalizedEndpoint = endpoint || '';
    const batchCapable = nodes.filter((node) => Boolean(node.batch_endpoint));
    const pool = batchCapable.length > 0 ? batchCapable : nodes;

    if (normalizedEndpoint.includes('embeddings')) {
      return pool.find((node) => node.embedding_models?.length) || null;
    }
    if (normalizedEndpoint.includes('rerank')) {
      return pool.find((node) => node.rerank_models?.length) || null;
    }
    if (normalizedEndpoint.includes('images')) {
      return pool.find((node) => node.image_models?.length) || null;
    }
    if (normalizedEndpoint.includes('audio')) {
      return pool.find((node) => node.audio_models?.length) || null;
    }
    if (normalizedEndpoint.includes('videos')) {
      return pool.find((node) => node.video_models?.length) || null;
    }
    return pool[0] || null;
  }

  private defaultModelForEndpoint(node: NodeConfig, endpoint: string | null): string {
    const normalizedEndpoint = endpoint || '';
    if (normalizedEndpoint.includes('embeddings') && node.embedding_models?.[0]) {
      return node.embedding_models[0];
    }
    if (normalizedEndpoint.includes('rerank') && node.rerank_models?.[0]) {
      return node.rerank_models[0];
    }
    if (normalizedEndpoint.includes('images') && node.image_models?.[0]) {
      return node.image_models[0];
    }
    if (normalizedEndpoint.includes('audio') && node.audio_models?.[0]) {
      return node.audio_models[0];
    }
    if (normalizedEndpoint.includes('videos') && node.video_models?.[0]) {
      return node.video_models[0];
    }
    return node.models?.[0] || 'batch';
  }

  private assertApiKeyAllowed(
    apiKey: GatewayApiKeyContext | undefined,
    target: BatchTarget,
    body: Record<string, unknown>,
    context: BatchRequestContext,
  ): void {
    if (!apiKey) return;
    this.assertBatchEndpointAllowed(apiKey, context);
    if (apiKey.allowed_nodes.length > 0 && !apiKey.allowed_nodes.includes(target.nodeId)) {
      throw new ForbiddenException(`This API key is not allowed to use node "${target.nodeId}".`);
    }

    const requestedModel = this.firstString(body.model, body.batch_model, context.headers['x-siftgate-model']);
    if (apiKey.allowed_models.length > 0) {
      if (!requestedModel) {
        throw new ForbiddenException(
          'This API key restricts models; include a top-level model or x-siftgate-model hint for batch requests.',
        );
      }
      if (!apiKey.allowed_models.includes(target.model)) {
        throw new ForbiddenException(`This API key is not allowed to use model "${target.model}".`);
      }
    }
    this.assertBatchModalitiesAllowed(apiKey, target.endpoint);
  }

  private assertApiKeyAllowedForStoredJob(
    apiKey: GatewayApiKeyContext | undefined,
    job: { node_id: string; model: string; endpoint: string | null },
    context: BatchRequestContext,
  ): void {
    if (!apiKey) return;
    this.assertBatchEndpointAllowed(apiKey, context);
    if (apiKey.allowed_nodes.length > 0 && !apiKey.allowed_nodes.includes(job.node_id)) {
      throw new ForbiddenException(`This API key is not allowed to use node "${job.node_id}".`);
    }
    if (apiKey.allowed_models.length > 0 && !apiKey.allowed_models.includes(job.model)) {
      throw new ForbiddenException(`This API key is not allowed to use model "${job.model}".`);
    }
    this.assertBatchModalitiesAllowed(apiKey, job.endpoint);
  }

  private assertBatchEndpointAllowed(
    apiKey: GatewayApiKeyContext,
    context: BatchRequestContext,
  ): void {
    if (apiKey.allowed_endpoints.length === 0) return;
    const aliases = ['batch', 'batches', context.operation];
    if (!aliases.some((alias) => apiKey.allowed_endpoints.includes(alias))) {
      throw new ForbiddenException('This API key is not allowed to use the batch endpoint.');
    }
  }

  private assertBatchModalitiesAllowed(
    apiKey: GatewayApiKeyContext,
    endpoint: string | null,
  ): void {
    const allowed = apiKey.allowed_modalities || [];
    if (allowed.length === 0) return;
    const requested = this.modalitiesForBatchEndpoint(endpoint);
    if (requested.some((modality) => !allowed.includes(modality))) {
      throw new ForbiddenException(
        `This API key is not allowed to use modality "${requested.join(',')}".`,
      );
    }
  }

  private modalitiesForBatchEndpoint(endpoint: string | null): string[] {
    const normalized = endpoint || '';
    if (normalized.includes('embeddings')) return ['embedding'];
    if (normalized.includes('rerank')) return ['rerank'];
    if (normalized.includes('images')) return ['image'];
    if (normalized.includes('audio')) return ['audio'];
    if (normalized.includes('videos')) return ['video'];
    return ['text'];
  }

  private async checkBudget(apiKey: GatewayApiKeyContext | undefined): Promise<void> {
    await this.budget.check(apiKey?.name, apiKey?.id, apiKey?.namespace_id || null);
  }

  private async recordZeroUsage(apiKey: GatewayApiKeyContext | undefined): Promise<void> {
    await this.budget.record(0, 0, apiKey?.name, apiKey?.id, apiKey?.namespace_id || null);
  }

  private async getAccessibleJob(id: string, apiKey: GatewayApiKeyContext | undefined) {
    const job = await this.jobs.findAccessible(id, apiKey);
    if (!job) throw new NotFoundException(`Batch job "${id}" not found.`);
    return job;
  }

  private requireNode(nodeId: string): NodeConfig {
    const node = this.config.getNode(nodeId);
    if (!node) throw new BadRequestException(`Batch node "${nodeId}" is not configured.`);
    return node;
  }

  private async logBatchCall(input: {
    context: BatchRequestContext;
    target: BatchTarget;
    statusCode: number;
    latencyMs: number;
    error: string | null;
  }): Promise<void> {
    const log = this.callLogs.create({
      request_id: input.context.requestId,
      source_format: 'batch',
      client_source: input.context.client_source || null,
      tier: 'direct',
      score: 0,
      node_id: input.target.nodeId,
      model: input.target.model || 'batch',
      input_tokens: 0,
      output_tokens: 0,
      cost_usd: 0,
      latency_ms: Math.max(0, input.latencyMs),
      status_code: input.statusCode,
      is_fallback: false,
      fallback_reason: null,
      session_id: input.context.session_id || null,
      session_key: input.context.session_id || null,
      trace_id: input.context.trace_id || null,
      error: input.error,
      workspace_id: normalizeWorkspaceId(
        input.context.apiKey?.workspace_id ||
          this.workspaceContext.currentWorkspaceId(),
      ),
      api_key_name: input.context.apiKey?.name || null,
      api_key_id: input.context.apiKey?.id || null,
      namespace_id: input.context.apiKey?.namespace_id || null,
    });
    await withCoordinatedRepository(this.callLogs, true, (repo) =>
      repo.save(log),
    );
    this.telemetry.recordCallMetrics({
      tier: 'direct',
      node: input.target.nodeId,
      model: input.target.model || 'batch',
      statusCode: input.statusCode,
      latencyMs: input.latencyMs,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      isFallback: false,
    });
  }

  private responseBody(
    body: Record<string, unknown> | Buffer | string,
  ): Record<string, unknown> | Buffer | string {
    return body;
  }

  private publicResponseBody(
    body: Record<string, unknown> | Buffer | string,
    statusCode: number,
  ): Record<string, unknown> | Buffer | string {
    if (statusCode >= 400) {
      return sanitizeBatchProviderErrorBody(body, this.batchRedactionTelemetry());
    }
    if (this.isRecord(body) && body.error) {
      return sanitizeBatchProviderErrorBody(body, this.batchRedactionTelemetry());
    }
    return body;
  }

  private batchRedactionTelemetry(): ErrorRedactionTelemetry {
    return {
      surface: 'batch',
      record: (event) => this.telemetry.recordErrorRedaction(event),
    };
  }

  private extractHeaders(req: Request): Record<string, string> {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') headers[key.toLowerCase()] = value;
    }
    return headers;
  }

  private requestId(headers: Record<string, string>): string {
    return headers['x-request-id'] || headers['x-siftgate-request-id'] || uuidv4();
  }

  private assertBody(body: unknown): asserts body is Record<string, unknown> {
    if (!this.isRecord(body)) {
      throw new BadRequestException('Batch create body must be a JSON object.');
    }
    if (!this.firstString(body.input_file_id)) {
      throw new BadRequestException('Batch create requires input_file_id.');
    }
    if (!this.firstString(body.endpoint)) {
      throw new BadRequestException('Batch create requires endpoint.');
    }
  }

  private firstString(...values: unknown[]): string | null {
    return values.find((value): value is string => typeof value === 'string' && value.length > 0) || null;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && !Buffer.isBuffer(value);
  }
}

export { BudgetExceededError };

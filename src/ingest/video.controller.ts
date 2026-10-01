import { MediaTaskService } from '../pricing/media-task.service';
import { sendMediaTaskResponse } from './media-task-response';
import { serializeDatabaseAccess } from '../database/database-serialization';
import { applyWorkspaceQueryScope, normalizeWorkspaceId } from '../workspaces/workspace-scope';
import { mediaJobId, mediaJobStatus } from '../pricing/media-task-metering';
import { fetchMediaControl, mediaControlHeaders, readMediaControlMetadata } from '../pricing/media-control-client';
import { Controller, Get, Post, Req, Res, Param, Logger, UseGuards, Optional } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Request, Response as ExpressResponse } from 'express';
import { MediaNormalizer } from '../canonical/normalizers/media.normalizer';
import { PipelineService, PipelineResult } from '../pipeline/pipeline.service';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { RateLimitGuard } from '../auth/rate-limit.guard';
import {
  attachGatewayApiKeyMetadata,
  gatewayApiKeyFromRequest,
} from '../auth/gateway-api-key-metadata';
import { ConfigService } from '../config/config.service';
import { NodeConfig } from '../config/gateway.config';
import { SecretReferenceResolverService } from '../config/secret-reference-resolver.service';
import { VideoJob } from '../database/entities';
import { sendMappedPublicErrorResponse } from '../http/public-error-handling';
import {
  sendPublicErrorResponse,
  sendPublicResponse,
} from '../http/public-contract';
import {
  ErrorEnvelopeDto,
  VideoGenerationRequestDto,
} from '../openapi/openapi.dto';

@Controller('v1')
@UseGuards(ApiKeyGuard, RateLimitGuard)
@ApiTags('AI Proxy')
@ApiBearerAuth('gatewayApiKey')
export class VideoController {
  private readonly logger = new Logger(VideoController.name);
  private readonly normalizer = new MediaNormalizer();

  constructor(
    private readonly pipeline: PipelineService,
    private readonly config: ConfigService,
    @InjectRepository(VideoJob)
    private readonly videoJobs: Repository<VideoJob>,
    @Optional()
    private readonly secretResolver?: SecretReferenceResolverService,
    @Optional() private readonly mediaTasks?: MediaTaskService,
  ) {}

  @Post('videos/generations')
  @ApiOperation({
    summary: 'Experimental async video generation preview',
    description: 'OpenAI/common-compatible JSON pass-through for async video generation. SiftGate stores job metadata only; prompt, source image, and video bytes are not persisted.',
  })
  @ApiBody({ type: VideoGenerationRequestDto })
  @ApiOkResponse({ description: 'Provider video job response with local job metadata persisted.' })
  @ApiUnauthorizedResponse({ type: ErrorEnvelopeDto })
  @ApiTooManyRequestsResponse({ type: ErrorEnvelopeDto })
  async videoGenerations(@Req() req: Request, @Res() res: ExpressResponse) {
    try {
      const headers = this.extractHeaders(req);
      const canonical = this.normalizer.normalize(req.body, headers, 'video_generation');
      this.applyGatewayKey(req, canonical);

      this.logger.log(
        `[videos/generations] model=${canonical.model || 'auto'}, bytes=${canonical.media.byte_size}`,
      );

      const result = await this.pipeline.processMedia(canonical);
      if (result.statusCode >= 200 && result.statusCode < 300 && !result.pricingReplayed && !(result.requestId && await this.mediaTasks?.findOwned(result.requestId, gatewayApiKeyFromRequest(req)))) {
        await this.persistJob(result, canonical);
      }
      this.sendPipelineResult(res, result);
    } catch (err) {
      this.logger.error('Video submission could not complete.');
      if (!res.headersSent) {
        sendMappedPublicErrorResponse(res, req, err);
      }
    }
  }

  @Get('videos/:id')
  @ApiOperation({ summary: 'Get experimental video job status' })
  @ApiOkResponse({ description: 'Local video job metadata, optionally refreshed from provider status endpoint.' })
  async getVideo(@Param('id') id: string, @Req() req: Request, @Res() res: ExpressResponse) {
    if (this.mediaTasks && await sendMediaTaskResponse(this.mediaTasks, 'video', 'status', id, req, res)) return;
    const job = await this.findJob(id, req);
    if (!job) {
      sendPublicErrorResponse(res, 404, 'openai', `Video job "${id}" not found`, {
        type: 'not_found',
      });
      return;
    }
    await this.refreshStatus(job).catch((err) => {
      this.logger.warn(`Video status refresh failed for ${id}: ${(err as Error).message}`);
    });
    sendPublicResponse(res, {
      statusCode: 200,
      body: this.jobResponse(job),
      requestId: job.request_id,
    });
  }

  @Get('videos/:id/content')
  @ApiOperation({ summary: 'Proxy experimental video job content' })
  async getVideoContent(@Param('id') id: string, @Req() req: Request, @Res() res: ExpressResponse) {
    if (this.mediaTasks && await sendMediaTaskResponse(this.mediaTasks, 'video', 'content', id, req, res)) return;
    const job = await this.findJob(id, req);
    if (!job) {
      sendPublicErrorResponse(res, 404, 'openai', `Video job "${id}" not found`, {
        type: 'not_found',
      });
      return;
    }
    const node = this.config.getNode(job.node_id);
    if (!node?.video_content_endpoint) {
      sendPublicErrorResponse(
        res,
        400,
        'openai',
        'Video content endpoint is not configured for this node.',
        {
          type: 'unsupported_operation',
          requestId: job.request_id,
        },
      );
      return;
    }
    try {
      await this.proxyProvider(node, node.video_content_endpoint, job, 'GET', res);
    } catch (err) {
      this.logger.warn(`Video content proxy failed for ${id}: ${(err as Error).message}`);
      if (!res.headersSent) {
        sendMappedPublicErrorResponse(res, req, err, {
          statusCode: 502,
          type: 'video_proxy_error',
          requestId: job.request_id,
        });
      }
    }
  }

  @Post('videos/:id/cancel')
  @ApiOperation({ summary: 'Cancel experimental video job when the provider supports it' })
  async cancelVideo(@Param('id') id: string, @Req() req: Request, @Res() res: ExpressResponse) {
    if (this.mediaTasks && await sendMediaTaskResponse(this.mediaTasks, 'video', 'cancel', id, req, res)) return;
    const job = await this.findJob(id, req);
    if (!job) {
      sendPublicErrorResponse(res, 404, 'openai', `Video job "${id}" not found`, {
        type: 'not_found',
      });
      return;
    }
    const node = this.config.getNode(job.node_id);
    if (!node?.video_cancel_endpoint) {
      sendPublicErrorResponse(
        res,
        400,
        'openai',
        'Video cancel endpoint is not configured for this node.',
        {
          type: 'unsupported_operation',
          requestId: job.request_id,
        },
      );
      return;
    }
    try {
      await this.proxyProvider(node, node.video_cancel_endpoint, job, 'POST', res, async (buffer) => {
        let body: Record<string, unknown>;
        try { body = JSON.parse(buffer.toString('utf8')); } catch { return; }
        job.status = this.extractStatus(body) ?? job.status;
        job.error = this.extractError(body);
        await this.saveJob(job);
      });
    } catch (err) {
      this.logger.warn(`Video cancel proxy failed for ${id}: ${(err as Error).message}`);
      if (!res.headersSent) {
        sendMappedPublicErrorResponse(res, req, err, {
          statusCode: 502,
          type: 'video_proxy_error',
          requestId: job.request_id,
        });
      }
    }
  }

  private async persistJob(
    result: PipelineResult,
    canonical: ReturnType<MediaNormalizer['normalize']>,
  ): Promise<void> {
    if (!result.requestId || !result.nodeId || !result.model) return;
    const body =
      result.body && typeof result.body === 'object' && !Buffer.isBuffer(result.body)
        ? (result.body as Record<string, unknown>)
        : {};
    const providerJobId = this.extractProviderJobId(body);
    const status = this.extractStatus(body) || 'queued';
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await this.saveJob(
      this.videoJobs.create({
        workspace_id: normalizeWorkspaceId(canonical.metadata.workspace_id),
        request_id: result.requestId,
        provider_job_id: providerJobId,
        node_id: result.nodeId,
        model: result.model,
        api_key_id: canonical.metadata.api_key_id || null,
        api_key_name: canonical.metadata.api_key_name || null,
        namespace_id: canonical.metadata.namespace_id || null,
        namespace_name: canonical.metadata.namespace_name || null,
        status,
        error: this.extractError(body),
        expires_at: expiresAt,
      }),
    );

    if (!('id' in body) && result.body && typeof result.body === 'object' && !Buffer.isBuffer(result.body)) {
      (result.body as Record<string, unknown>).id = providerJobId || result.requestId;
    }
  }

  private async findJob(id: string, req: Request): Promise<VideoJob | null> {
    const key = gatewayApiKeyFromRequest(req); if (!key) return null;
    return serializeDatabaseAccess(this.videoJobs.manager.connection, async () => {
      const query = this.videoJobs.createQueryBuilder('job').where('(job.request_id = :id OR job.provider_job_id = :id)', { id });
      applyWorkspaceQueryScope(query, 'job', key.workspace_id);
      if (key.id) query.andWhere('job.api_key_id = :keyId', { keyId: key.id });
      else query.andWhere('job.api_key_id IS NULL AND job.api_key_name = :name', { name: key.name });
      if (key.namespace_id) query.andWhere('job.namespace_id = :namespace', { namespace: key.namespace_id });
      else query.andWhere('job.namespace_id IS NULL');
      const jobs = await query.take(2).getMany();
      return jobs.length === 1 ? jobs[0] : null;
    });
  }

  private async saveJob(job: VideoJob): Promise<void> {
    await serializeDatabaseAccess(this.videoJobs.manager.connection, () => this.videoJobs.save(job));
  }

  private async refreshStatus(job: VideoJob): Promise<void> {
    const node = this.config.getNode(job.node_id);
    if (!node?.video_status_endpoint) return;
    const response = await this.fetchProvider(node, node.video_status_endpoint, job, 'GET');
    if (!response.ok) { await response.body?.cancel(); return; }
    const body = await readMediaControlMetadata(response);
    if (!body) return;
    job.status = this.extractStatus(body) || job.status;
    job.error = this.extractError(body);
    await this.saveJob(job);
  }

  private async proxyProvider(
    node: NodeConfig,
    endpointTemplate: string,
    job: VideoJob,
    method: 'GET' | 'POST',
    res: ExpressResponse,
    afterSuccess?: (body: Buffer) => Promise<void>,
  ): Promise<void> {
    const response = await this.fetchProvider(node, endpointTemplate, job, method);
    const contentType = response.headers.get('content-type') || 'application/octet-stream';
    const body = Buffer.from(await response.arrayBuffer());
    if (response.ok && afterSuccess) await afterSuccess(body);
    sendPublicResponse(res, {
      statusCode: response.status,
      body,
      contentType,
      requestId: job.request_id,
    });
  }

  private async fetchProvider(
    node: NodeConfig,
    endpointTemplate: string,
    job: VideoJob,
    method: 'GET' | 'POST',
  ): Promise<globalThis.Response> {
    const jobId = encodeURIComponent(job.provider_job_id || job.request_id);
    const endpoint = endpointTemplate.replace(':id', jobId).replace('{id}', jobId);
    const url = endpoint.startsWith('http')
      ? endpoint
      : `${node.base_url.replace(/\/+$/, '')}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`;
    const headers = await this.providerHeaders(node);
    return fetchMediaControl(url, { method, headers }, new Set(), 60000);
  }

  private async providerHeaders(node: NodeConfig): Promise<Record<string, string>> {
    const credentials = node.credentials?.filter((entry) => entry.enabled !== false) ?? [];
    // Legacy rows do not record a submission credential. Never guess among a pool.
    if (credentials.length > 1) throw new Error('Legacy media task has no pinned credential; reconciliation is required');
    return mediaControlHeaders(node, credentials[0]?.id ?? 'default', this.secretResolver);
  }

  private jobResponse(job: VideoJob): Record<string, unknown> {
    return {
      id: job.provider_job_id || job.request_id,
      object: 'video.generation.job',
      request_id: job.request_id,
      status: job.status,
      node: job.node_id,
      model: job.model,
      created_at: job.created_at.toISOString(),
      updated_at: job.updated_at.toISOString(),
      expires_at: job.expires_at,
      error: job.error,
    };
  }

  private extractProviderJobId(body: Record<string, unknown>): string | null { return mediaJobId(body); }

  private extractStatus(body: Record<string, unknown>): string | null {
    const status = mediaJobStatus(body);
    return status !== 'pending' ? status : ['queued', 'pending', 'processing', 'in_progress', 'submitted'].includes(String(body.status ?? body.state ?? body.phase)) ? String(body.status ?? body.state ?? body.phase) : null;
  }

  private extractError(body: Record<string, unknown>): string | null { return body.error ? 'provider_media_job_error' : null; }

  private applyGatewayKey(
    req: Request,
    canonical: ReturnType<MediaNormalizer['normalize']>,
  ): void {
    attachGatewayApiKeyMetadata(canonical, gatewayApiKeyFromRequest(req));
  }

  private sendPipelineResult(res: ExpressResponse, result: PipelineResult): void {
    sendPublicResponse(res, result);
  }

  private extractHeaders(req: Request): Record<string, string> {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') headers[key] = value;
    }
    return headers;
  }
}

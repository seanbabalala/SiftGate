import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Equal, IsNull, Or, Repository } from 'typeorm';
import { coordinatedRepositoryOperation } from '../database/coordinated-repository';
import { BatchJob } from '../database/entities';
import type { GatewayApiKeyContext } from '../auth/gateway-api-key.service';
import { TelemetryService } from '../telemetry/telemetry.service';
import type { ErrorRedactionTelemetry } from '../security/error-redaction';
import { WorkspaceContextService } from '../workspaces/workspace-context.service';
import {
  applyWorkspaceQueryScope,
  normalizeWorkspaceId,
  workspaceFindWhere,
} from '../workspaces/workspace-scope';
import { extractBatchProviderError } from './batch-error-redaction';
import { batchDashboardItem } from './batch.types';
import type { BatchDashboardResponse } from './batch.types';

@Injectable()
export class BatchJobStoreService {
  private databaseScoped = false;
  constructor(
    private readonly workspaceContext: WorkspaceContextService,
    @InjectRepository(BatchJob)
    private readonly batchJobs: Repository<BatchJob>,
    private readonly telemetry?: TelemetryService,
  ) {}

  private database<T>(
    write: boolean,
    action: (service: BatchJobStoreService) => Promise<T>,
  ): Promise<T> {
    return coordinatedRepositoryOperation(this.batchJobs, write, (manager) => {
      if (!manager) return action(this);
      const scoped = new BatchJobStoreService(
        this.workspaceContext,
        manager.getRepository(BatchJob),
        this.telemetry,
      );
      scoped.databaseScoped = true;
      return action(scoped);
    });
  }

  async createFromProvider(input: {
    requestId: string;
    nodeId: string;
    model: string;
    requestBody: Record<string, unknown>;
    providerBody: Record<string, unknown>;
    apiKey?: GatewayApiKeyContext;
  }): Promise<BatchJob> {
    if (!this.databaseScoped && this.batchJobs.manager?.connection)
      return this.database(true, (service) =>
        service.createFromProvider(input),
      );
    const extracted = this.extractJobFields(
      input.providerBody,
      input.requestBody,
    );
    const entity = this.batchJobs.create({
      request_id: input.requestId,
      provider_batch_id: extracted.providerBatchId,
      node_id: input.nodeId,
      model: input.model,
      endpoint: extracted.endpoint,
      input_file_id: extracted.inputFileId,
      output_file_id: extracted.outputFileId,
      error_file_id: extracted.errorFileId,
      completion_window: extracted.completionWindow,
      metadata_keys_json: JSON.stringify(extracted.metadataKeys),
      request_counts_total: extracted.requestCounts.total,
      request_counts_completed: extracted.requestCounts.completed,
      request_counts_failed: extracted.requestCounts.failed,
      workspace_id: normalizeWorkspaceId(
        input.apiKey?.workspace_id ||
          this.workspaceContext.currentWorkspaceId(),
      ),
      api_key_id: input.apiKey?.id || null,
      api_key_name: input.apiKey?.name || null,
      namespace_id: input.apiKey?.namespace_id || null,
      namespace_name: input.apiKey?.namespace_name || null,
      status: extracted.status || 'validating',
      error: extracted.error,
      expires_at: extracted.expiresAt,
    });
    return this.batchJobs.save(entity);
  }

  async updateFromProvider(
    job: BatchJob,
    providerBody: Record<string, unknown>,
  ): Promise<BatchJob> {
    if (!this.databaseScoped && this.batchJobs.manager?.connection)
      return this.database(true, (service) =>
        service.updateFromProvider(job, providerBody),
      );
    if (this.databaseScoped) {
      const current = await this.batchJobs.findOne({
        where: workspaceFindWhere(normalizeWorkspaceId(job.workspace_id), {
          id: job.id,
          request_id: job.request_id,
        }),
        ...(this.batchJobs.manager.connection.options.type === 'postgres'
          ? { lock: { mode: 'pessimistic_write' as const } }
          : {}),
      });
      if (!current) throw new NotFoundException('Batch job not found.');
      job = current;
    }
    const extracted = this.extractJobFields(providerBody, {});
    job.provider_batch_id = extracted.providerBatchId || job.provider_batch_id;
    job.endpoint = extracted.endpoint || job.endpoint;
    job.input_file_id = extracted.inputFileId || job.input_file_id;
    job.output_file_id = extracted.outputFileId || job.output_file_id;
    job.error_file_id = extracted.errorFileId || job.error_file_id;
    job.completion_window = extracted.completionWindow || job.completion_window;
    job.request_counts_total =
      extracted.requestCounts.total || job.request_counts_total;
    job.request_counts_completed =
      extracted.requestCounts.completed || job.request_counts_completed;
    job.request_counts_failed =
      extracted.requestCounts.failed || job.request_counts_failed;
    job.status = extracted.status || job.status;
    job.error = extracted.error;
    job.expires_at = extracted.expiresAt || job.expires_at;
    return this.batchJobs.save(job);
  }

  async findAccessible(
    id: string,
    apiKey?: GatewayApiKeyContext,
  ): Promise<BatchJob | null> {
    if (!apiKey) return null;
    if (!this.databaseScoped && this.batchJobs.manager?.connection)
      return this.database(false, (service) =>
        service.findAccessible(id, apiKey),
      );
    const job = await this.batchJobs.findOne({
      where: [{ request_id: id }, { provider_batch_id: id }].flatMap((where) =>
        workspaceFindWhere(normalizeWorkspaceId(apiKey.workspace_id), {
          ...where,
          api_key_id: Or(IsNull(), Equal(apiKey.id)),
          namespace_id: apiKey.namespace_id
            ? Or(IsNull(), Equal(apiKey.namespace_id))
            : IsNull(),
        }),
      ),
    });
    if (!job) return null;
    if (
      normalizeWorkspaceId(job.workspace_id) !==
      normalizeWorkspaceId(apiKey.workspace_id)
    ) {
      return null;
    }
    if (job.api_key_id && job.api_key_id !== apiKey.id) return null;
    if (job.namespace_id && job.namespace_id !== (apiKey.namespace_id || null))
      return null;
    return job;
  }

  async markCancelled(job: BatchJob): Promise<BatchJob> {
    if (!this.databaseScoped && this.batchJobs.manager?.connection)
      return this.database(true, (service) => service.markCancelled(job));
    const current = this.databaseScoped
      ? await this.batchJobs.findOne({
          where: workspaceFindWhere(normalizeWorkspaceId(job.workspace_id), {
            id: job.id,
            request_id: job.request_id,
          }),
          ...(this.batchJobs.manager.connection.options.type === 'postgres'
            ? { lock: { mode: 'pessimistic_write' as const } }
            : {}),
        })
      : job;
    if (!current) throw new NotFoundException('Batch job not found.');
    current.status = 'cancelled';
    return this.batchJobs.save(current);
  }

  async dashboardSummary(filters: {
    period?: string;
    status?: string;
    node?: string;
    namespace?: string;
    api_key_id?: string;
    limit?: number;
  }): Promise<BatchDashboardResponse> {
    if (!this.databaseScoped && this.batchJobs.manager?.connection)
      return this.database(false, (service) =>
        service.dashboardSummary(filters),
      );
    const period = filters.period || '24h';
    const qb = this.batchJobs.createQueryBuilder('batch').where('1 = 1');
    applyWorkspaceQueryScope(
      qb,
      'batch',
      this.workspaceContext.currentWorkspaceId(),
    );
    const since = periodStart(period);
    if (since) {
      qb.andWhere('batch.created_at >= :since', { since });
    }
    if (filters.status) {
      qb.andWhere('batch.status = :status', { status: filters.status });
    }
    if (filters.node) {
      qb.andWhere('batch.node_id = :node', { node: filters.node });
    }
    if (filters.namespace) {
      qb.andWhere('batch.namespace_id = :namespace', {
        namespace: filters.namespace,
      });
    }
    if (filters.api_key_id) {
      qb.andWhere('batch.api_key_id = :apiKeyId', {
        apiKeyId: filters.api_key_id,
      });
    }

    const items = await qb
      .orderBy('batch.updated_at', 'DESC')
      .take(Math.min(Math.max(filters.limit || 100, 1), 500))
      .getMany();

    const totals = items.reduce(
      (acc, job) => {
        acc.total += 1;
        if (isActiveStatus(job.status)) acc.active += 1;
        else if (job.status === 'completed') acc.completed += 1;
        else if (job.status === 'cancelled' || job.status === 'canceled')
          acc.cancelled += 1;
        else if (job.status === 'failed' || job.status === 'expired')
          acc.failed += 1;
        return acc;
      },
      { total: 0, active: 0, completed: 0, failed: 0, cancelled: 0 },
    );

    return {
      metadata_only: true,
      items: items.map(batchDashboardItem),
      totals,
      filters: {
        period,
        status: filters.status || null,
        node: filters.node || null,
        namespace: filters.namespace || null,
        api_key_id: filters.api_key_id || null,
      },
    };
  }

  private extractJobFields(
    providerBody: Record<string, unknown>,
    requestBody: Record<string, unknown>,
  ) {
    const requestCounts = isRecord(providerBody.request_counts)
      ? providerBody.request_counts
      : {};
    const metadata = isRecord(requestBody.metadata) ? requestBody.metadata : {};
    return {
      providerBatchId: firstString(providerBody.id, providerBody.batch_id, providerBody.name),
      endpoint: firstString(providerBody.endpoint, requestBody.endpoint),
      inputFileId: firstString(providerBody.input_file_id, requestBody.input_file_id),
      outputFileId: firstString(providerBody.output_file_id),
      errorFileId: firstString(providerBody.error_file_id),
      completionWindow: firstString(providerBody.completion_window, requestBody.completion_window),
      metadataKeys: Object.keys(metadata).slice(0, 50),
      requestCounts: {
        total: numberField(requestCounts.total),
        completed: numberField(requestCounts.completed),
        failed: numberField(requestCounts.failed),
      },
      status: firstString(providerBody.status, providerBody.state),
      error: extractBatchProviderError(providerBody.error, this.batchRedactionTelemetry()),
      expiresAt: epochOrString(providerBody.expires_at),
    };
  }

  private batchRedactionTelemetry(): ErrorRedactionTelemetry | undefined {
    if (!this.telemetry) return undefined;
    return {
      surface: 'batch',
      record: (event) => this.telemetry?.recordErrorRedaction(event),
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function firstString(...values: unknown[]): string | null {
  return values.find((value): value is string => typeof value === 'string' && value.length > 0) || null;
}

function numberField(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function epochOrString(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value * 1000).toISOString();
  }
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function periodStart(period: string): Date | null {
  const now = Date.now();
  if (period === '7d') return new Date(now - 7 * 86_400_000);
  if (period === '30d') return new Date(now - 30 * 86_400_000);
  if (period === 'all') return null;
  return new Date(now - 86_400_000);
}

function isActiveStatus(status: string): boolean {
  return ['validating', 'queued', 'in_progress', 'finalizing', 'cancelling'].includes(status);
}

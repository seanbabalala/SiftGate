import {
  BeforeApplicationShutdown,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { LessThan, Repository } from 'typeorm';
import {
  GATEWAY_DENIAL_REASONS,
  GatewayDenial,
  type GatewayDenialReason,
} from '../database/entities/gateway-denial.entity';
import { withCoordinatedRepository } from '../database/coordinated-repository';
import { ConfigService } from '../config/config.service';
import { normalizeWorkspaceId, applyWorkspaceQueryScope } from '../workspaces/workspace-scope';

/** Everything a denial may record. All of it is request metadata. */
export interface GatewayDenialInput {
  reason: GatewayDenialReason;
  statusCode: number;
  workspaceId?: string | null;
  requestId?: string | null;
  budgetScope?: string | null;
  apiKeyId?: string | null;
  apiKeyName?: string | null;
  namespaceId?: string | null;
  teamId?: string | null;
  sourceFormat?: string | null;
  requestedModel?: string | null;
  clientSource?: string | null;
}

export interface GatewayDenialSummary {
  period: string;
  since: string;
  total: number;
  by_reason: Array<{ reason: GatewayDenialReason; requests: number }>;
  by_key: Array<{ api_key_id: string | null; api_key_name: string | null; requests: number }>;
}

const FLUSH_INTERVAL_MS = 5_000;
const PURGE_INTERVAL_MS = 6 * 60 * 60_000;
// One pending bucket per (workspace, key, reason, minute). A burst of distinct
// keys flushes early instead of growing memory without bound.
const MAX_PENDING_BUCKETS = 1_000;
const MAX_FIELD_LENGTH = 200;
const MINUTE_MS = 60_000;
const PERIODS: Record<string, number> = {
  '1h': 60 * MINUTE_MS,
  '24h': 24 * 60 * MINUTE_MS,
  '7d': 7 * 24 * 60 * MINUTE_MS,
  '30d': 30 * 24 * 60 * MINUTE_MS,
};

/**
 * Records requests the gateway refused on a governance policy (budget, key
 * permission, key rate limit) before any provider call. Recording never blocks
 * or fails the request it describes: denials are aggregated in memory per
 * minute and written in the background.
 */
@Injectable()
export class GatewayDenialService implements OnModuleInit, BeforeApplicationShutdown {
  private readonly logger = new Logger(GatewayDenialService.name);
  private readonly pending = new Map<string, GatewayDenial>();
  private flushTimer: NodeJS.Timeout | null = null;
  private purgeTimer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> | null = null;
  private stopped = false;

  constructor(
    @InjectRepository(GatewayDenial)
    private readonly repo: Repository<GatewayDenial>,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    this.flushTimer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
    this.flushTimer.unref();
    // Same retention as call logs, on the same six-hour cadence.
    this.purgeTimer = setInterval(() => {
      void this.purgeExpired().catch((error) => {
        this.logger.warn(`Governance denial cleanup failed: ${(error as Error).message}`);
      });
    }, PURGE_INTERVAL_MS);
    this.purgeTimer.unref();
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.purgeTimer) clearInterval(this.purgeTimer);
    await this.flush();
  }

  /** Never throws. */
  record(input: GatewayDenialInput, now: Date = new Date()): void {
    try {
      if (!(GATEWAY_DENIAL_REASONS as readonly string[]).includes(input.reason)) return;
      const workspaceId = normalizeWorkspaceId(input.workspaceId);
      const minute = Math.floor(now.getTime() / MINUTE_MS);
      const key = JSON.stringify([workspaceId, input.apiKeyId || input.apiKeyName || '', input.reason, minute]);
      const existing = this.pending.get(key);
      if (existing) {
        existing.request_count += 1;
        existing.last_at = now;
        return;
      }
      this.pending.set(key, this.repo.create({
        id: randomUUID(),
        workspace_id: workspaceId,
        first_at: now,
        last_at: now,
        request_count: 1,
        reason: input.reason,
        status_code: input.statusCode,
        budget_scope: bounded(input.budgetScope),
        api_key_id: bounded(input.apiKeyId),
        api_key_name: bounded(input.apiKeyName),
        namespace_id: bounded(input.namespaceId),
        team_id: bounded(input.teamId),
        source_format: bounded(input.sourceFormat),
        requested_model: bounded(input.requestedModel),
        client_source: bounded(input.clientSource),
        first_request_id: bounded(input.requestId),
      }));
      if (this.pending.size >= MAX_PENDING_BUCKETS) void this.flush();
    } catch (error) {
      this.logger.warn(`Could not record a governance denial: ${(error as Error).message}`);
    }
  }

  /** Writes pending buckets. A failed write is logged and dropped, never retried forever. */
  async flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    if (this.pending.size === 0) return;
    const batch = [...this.pending.values()];
    this.pending.clear();
    this.flushing = (async () => {
      try {
        await withCoordinatedRepository(this.repo, true, (repo) => repo.save(batch, { chunk: 100 }));
      } catch (error) {
        if (!this.stopped) {
          this.logger.warn(`Dropped ${batch.length} governance denial record(s): ${(error as Error).message}`);
        }
      } finally {
        this.flushing = null;
      }
    })();
    return this.flushing;
  }

  async list(options: {
    workspaceId: string;
    period?: string;
    reason?: string;
    apiKeyId?: string;
    page?: number;
    limit?: number;
  }) {
    await this.flush();
    const since = sinceForPeriod(options.period);
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const page = Math.max(options.page ?? 1, 1);
    const qb = this.repo
      .createQueryBuilder('denial')
      .where('denial.first_at >= :since', { since })
      .orderBy('denial.first_at', 'DESC')
      .addOrderBy('denial.id', 'DESC');
    applyWorkspaceQueryScope(qb, 'denial', options.workspaceId);
    if (options.reason && (GATEWAY_DENIAL_REASONS as readonly string[]).includes(options.reason)) {
      qb.andWhere('denial.reason = :reason', { reason: options.reason });
    }
    if (options.apiKeyId) qb.andWhere('denial.api_key_id = :apiKeyId', { apiKeyId: options.apiKeyId });
    const [rows, total] = await qb.skip((page - 1) * limit).take(limit).getManyAndCount();
    return {
      data: rows.map(serialize),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async summary(workspaceId: string, period = '24h'): Promise<GatewayDenialSummary> {
    await this.flush();
    const normalizedPeriod = PERIODS[period] ? period : '24h';
    const since = sinceForPeriod(normalizedPeriod);
    const byReasonQb = this.repo
      .createQueryBuilder('denial')
      .select('denial.reason', 'reason')
      .addSelect('SUM(denial.request_count)', 'requests')
      .where('denial.first_at >= :since', { since })
      .groupBy('denial.reason');
    applyWorkspaceQueryScope(byReasonQb, 'denial', workspaceId);
    const byKeyQb = this.repo
      .createQueryBuilder('denial')
      .select('denial.api_key_id', 'apiKeyId')
      .addSelect('MAX(denial.api_key_name)', 'apiKeyName')
      .addSelect('SUM(denial.request_count)', 'requests')
      .where('denial.first_at >= :since', { since })
      .groupBy('denial.api_key_id')
      .orderBy('requests', 'DESC')
      .limit(10);
    applyWorkspaceQueryScope(byKeyQb, 'denial', workspaceId);
    const [byReason, byKey] = await Promise.all([
      byReasonQb.getRawMany<{ reason: GatewayDenialReason; requests: string | number }>(),
      byKeyQb.getRawMany<{ apiKeyId: string | null; apiKeyName: string | null; requests: string | number }>(),
    ]);
    const reasons = byReason
      .map((row) => ({ reason: row.reason, requests: Number(row.requests || 0) }))
      .sort((a, b) => b.requests - a.requests);
    return {
      period: normalizedPeriod,
      since: since.toISOString(),
      total: reasons.reduce((sum, row) => sum + row.requests, 0),
      by_reason: reasons,
      by_key: byKey.map((row) => ({
        api_key_id: row.apiKeyId || null,
        api_key_name: row.apiKeyName || null,
        requests: Number(row.requests || 0),
      })),
    };
  }

  /** Follows database.log_retention_days, like call logs. */
  async purgeExpired(now = Date.now()): Promise<number> {
    const days = this.config.database?.log_retention_days ?? 30;
    if (days <= 0) return 0;
    const cutoff = new Date(now - days * 24 * 60 * MINUTE_MS);
    const result = await withCoordinatedRepository(this.repo, true, (repo) =>
      repo.delete({ last_at: LessThan(cutoff) }),
    );
    return result.affected ?? 0;
  }
}

function bounded(value: string | null | undefined): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  return text ? text.slice(0, MAX_FIELD_LENGTH) : null;
}

function sinceForPeriod(period: string | undefined, now = Date.now()): Date {
  return new Date(now - (PERIODS[period || ''] ?? PERIODS['24h']));
}

function serialize(row: GatewayDenial) {
  return {
    id: row.id,
    first_at: row.first_at,
    last_at: row.last_at,
    request_count: row.request_count,
    reason: row.reason,
    status_code: row.status_code,
    budget_scope: row.budget_scope,
    api_key_id: row.api_key_id,
    api_key_name: row.api_key_name,
    namespace_id: row.namespace_id,
    team_id: row.team_id,
    source_format: row.source_format,
    requested_model: row.requested_model,
    client_source: row.client_source,
    first_request_id: row.first_request_id,
  };
}

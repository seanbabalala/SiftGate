import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { And, LessThanOrEqual, MoreThanOrEqual, Repository } from 'typeorm';
import { ConfigService } from '../config/config.service';
import { resolvePricingLimits } from '../config/pricing-limits';
import { CallLog } from '../database/entities';
import { withCoordinatedRepository } from '../database/coordinated-repository';
import { legacyReportMoney, subtractCostReportMoney, sumCostReportMoney } from '../pricing/cost-report-money';
import { WorkspaceContextService } from '../workspaces/workspace-context.service';
import { workspaceFindWhereStrict } from '../workspaces/workspace-scope';
import type { CacheSavingsGroupBy, CacheSavingsScope, CacheSavingsMetrics, CacheSavingsSummaryResponse } from './cache-savings.types';
export type { CacheSavingsGroupBy, CacheSavingsScope, CacheSavingsMetrics, CacheSavingsSummaryResponse, CacheSavingsGroupRow, CacheSavingsTrendRow } from './cache-savings.types';

interface MutableMetrics {
  total_requests: number; provider_routed_requests: number; cache_eligible_requests: number;
  requests_with_provider_cache_hit: number; total_input_tokens: number; total_output_tokens: number;
  total_cache_read_tokens: number; total_cache_creation_tokens: number; total_normal_input_tokens: number;
  comparable_requests: number; unavailable_reference_requests: number; excluded_requests: number;
  actual: string; reference: string;
}
const NON_PROVIDER_NODE_IDS = new Set(['cache', 'semantic_cache', 'hook']);
const TOKEN_OPERATIONS = new Set(['chat_completions', 'responses', 'messages', 'gemini_generate_content', 'embeddings']);

@Injectable()
export class CacheSavingsService {
  constructor(
    @InjectRepository(CallLog) private readonly callLogRepo: Repository<CallLog>,
    private readonly config: ConfigService,
    private readonly workspaceContext: WorkspaceContextService,
  ) {}

  async getSummary(period = '7d', groupBy: CacheSavingsGroupBy = 'node', scope: CacheSavingsScope = {}): Promise<CacheSavingsSummaryResponse> {
    const window = resolvePeriod(period);
    const limit = resolvePricingLimits(this.config.pricingLimits).max_replay_rows;
    const now = new Date();
    const selected = await withCoordinatedRepository(this.callLogRepo, false, repo => repo.find({
      where: workspaceFindWhereStrict(this.workspaceContext.currentWorkspaceId(), {
        timestamp: And(MoreThanOrEqual(window.since), LessThanOrEqual(now)),
        ...(scope.api_key_id ? { api_key_id: scope.api_key_id } : {}),
        ...(!scope.api_key_id && scope.api_key ? { api_key_name: scope.api_key } : {}),
        ...(scope.namespace ? { namespace_id: scope.namespace } : {}),
        ...(scope.team_id ? { team_id: scope.team_id } : {}),
      }),
      select: { id: true, request_id: true, source_format: true, timestamp: true, node_id: true, model: true,
        input_tokens: true, output_tokens: true, cost_usd: true, cost_without_cache_usd: true,
        cache_creation_input_tokens: true, cache_read_input_tokens: true, namespace_id: true, team_id: true,
        api_key_id: true, api_key_name: true },
      order: { timestamp: 'ASC', id: 'ASC' },
      take: limit + 1,
    }));
    const truncated = selected.length > limit, rows = selected.slice(0, limit);
    const summary = createMetrics(), groups = new Map<string, { metrics: MutableMetrics; label: string }>();
    const days = new Map(enumerateUtcDates(window.since, now).map(date => [date, createMetrics()]));
    for (const row of rows) {
      accumulate(summary, row);
      const value = groupValue(groupBy, row);
      const group = groups.get(value) ?? { metrics: createMetrics(), label: groupBy === 'api_key' ? row.api_key_name || row.api_key_id || value : value };
      accumulate(group.metrics, row); groups.set(value, group);
      const date = dateKey(row.timestamp), metrics = days.get(date) ?? createMetrics();
      accumulate(metrics, row); days.set(date, metrics);
    }
    return {
      period: window.label, period_days: window.days, group_by: groupBy,
      filters: { api_key_id: scope.api_key_id || null, api_key_name: scope.api_key || null, namespace_id: scope.namespace || null, team_id: scope.team_id || null },
      scan: { row_limit: limit, scanned_rows: rows.length, has_more: truncated },
      summary: finalize(summary, truncated),
      groups: [...groups].map(([value, group]) => ({ group_value: value, group_label: group.label, ...finalize(group.metrics, truncated) }))
        .filter(group => group.provider_routed_requests > 0)
        .sort((a, b) => b.known_savings_usd - a.known_savings_usd || b.known_actual_cost_usd - a.known_actual_cost_usd || b.total_requests - a.total_requests),
      daily_trend: [...days].sort(([a], [b]) => a.localeCompare(b)).map(([date, metrics]) => ({ date, ...finalize(metrics, truncated) })),
    };
  }
}

function accumulate(metrics: MutableMetrics, row: CallLog): void {
  metrics.total_requests++;
  if (NON_PROVIDER_NODE_IDS.has(row.node_id || '')) return;
  metrics.provider_routed_requests++;
  // Older log rows predate the source-format field and used the token-only contract.
  if (!TOKEN_OPERATIONS.has(row.source_format || 'chat_completions')) { metrics.excluded_requests++; return; }
  metrics.cache_eligible_requests++;
  const input = count(row.input_tokens), output = count(row.output_tokens), read = count(row.cache_read_input_tokens), write = count(row.cache_creation_input_tokens);
  if (read > 0) metrics.requests_with_provider_cache_hit++;
  metrics.total_input_tokens += input; metrics.total_output_tokens += output;
  metrics.total_cache_read_tokens += read; metrics.total_cache_creation_tokens += write;
  metrics.total_normal_input_tokens += Math.max(0, input - read - write);
  const actual = money(row.cost_usd), reference = money(row.cost_without_cache_usd);
  // A null baseline is deliberate on immutable-ledger projections. Never substitute
  // current token rates, infer a media baseline, or "repair" a historical actual cost.
  if (actual === null || reference === null) { metrics.unavailable_reference_requests++; return; }
  metrics.comparable_requests++;
  metrics.actual = sumCostReportMoney(metrics.actual, actual);
  metrics.reference = sumCostReportMoney(metrics.reference, reference);
}

function money(value: unknown): string | null {
  return typeof value === 'number' ? legacyReportMoney(value) : null;
}
function count(value: unknown): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : 0;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}
function createMetrics(): MutableMetrics {
  return { total_requests: 0, provider_routed_requests: 0, cache_eligible_requests: 0, requests_with_provider_cache_hit: 0,
    total_input_tokens: 0, total_output_tokens: 0, total_cache_read_tokens: 0, total_cache_creation_tokens: 0,
    total_normal_input_tokens: 0, comparable_requests: 0, unavailable_reference_requests: 0, excluded_requests: 0,
    actual: '0.000000000000000000', reference: '0.000000000000000000' };
}
function finalize(metrics: MutableMetrics, truncated: boolean): CacheSavingsMetrics {
  const { actual, reference, ...counts } = metrics;
  const complete = !truncated && metrics.comparable_requests === metrics.provider_routed_requests;
  const status = !truncated && !metrics.provider_routed_requests ? 'empty' : complete ? 'complete' : metrics.comparable_requests ? 'partial' : 'unavailable';
  const delta = subtractCostReportMoney(reference, actual), numeric = (value: string) => Number(Number(value).toFixed(6));
  const knownActual = numeric(actual), knownReference = numeric(reference), knownSavings = numeric(delta);
  return { ...counts, comparison_basis: 'recorded_log_estimates', comparison_status: status,
    cache_hit_rate: !truncated && metrics.cache_eligible_requests ? Number((metrics.requests_with_provider_cache_hit / metrics.cache_eligible_requests * 100).toFixed(2)) : !metrics.provider_routed_requests && !truncated ? 0 : null,
    actual_cost_usd: complete ? knownActual : null, hypothetical_no_cache_cost_usd: complete ? knownReference : null,
    savings_usd: complete ? knownSavings : null,
    savings_percentage: complete && Number(reference) > 0 ? Number((Number(delta) / Number(reference) * 100).toFixed(2)) : null,
    known_actual_cost_usd: knownActual, known_hypothetical_no_cache_cost_usd: knownReference, known_savings_usd: knownSavings,
    exact: { comparable_actual_usd: actual, comparable_no_cache_usd: reference, comparable_savings_usd: delta },
    normal_input_cost_usd: null, cache_read_cost_usd: null, cache_creation_cost_usd: null, output_cost_usd: null,
  };
}
function resolvePeriod(period: string) {
  const value = `${period || '7d'}`.trim().toLowerCase();
  const days = value === '1d' ? 1 : value === '30d' ? 30 : value === '90d' ? 90 : 7;
  const since = new Date(); since.setUTCHours(0, 0, 0, 0); since.setUTCDate(since.getUTCDate() - days + 1);
  return { label: `${days}d`, days, since };
}
function dateKey(value: Date | string): string { return new Date(value).toISOString().slice(0, 10); }
function enumerateUtcDates(start: Date, end: Date): string[] {
  const dates: string[] = [], cursor = new Date(start), limit = new Date(end); limit.setUTCHours(0, 0, 0, 0);
  while (cursor <= limit) { dates.push(dateKey(cursor)); cursor.setUTCDate(cursor.getUTCDate() + 1); }
  return dates;
}
function groupValue(group: CacheSavingsGroupBy, row: CallLog): string {
  if (group === 'model') return row.model || 'unknown';
  if (group === 'namespace') return row.namespace_id || 'unscoped';
  if (group === 'team') return row.team_id || 'unassigned';
  if (group === 'api_key') return row.api_key_id || row.api_key_name || 'anonymous';
  return row.node_id || 'unknown';
}

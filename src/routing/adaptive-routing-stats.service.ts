import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThanOrEqual, Repository } from 'typeorm';
import { CallLog } from '../database/entities/call-log.entity';

type RoutingStatsLog = Pick<CallLog,
  | 'timestamp' | 'tier' | 'node_id' | 'model' | 'status_code'
  | 'is_fallback' | 'latency_ms' | 'cost_usd' | 'retry_count'
>;

const ROUTING_STATS_FIELDS = [
  'timestamp', 'tier', 'node_id', 'model', 'status_code',
  'is_fallback', 'latency_ms', 'cost_usd', 'retry_count',
] as const satisfies ReadonlyArray<keyof RoutingStatsLog>;

export interface AdaptiveRoutingStatsOptions {
  windowHours?: number;
  sampleLimit?: number;
  minSamples?: number;
}

export interface RouteTargetStats {
  key: string;
  tier?: string;
  node: string;
  model: string;
  calls: number;
  successes: number;
  failures: number;
  success_rate: number;
  fallback_calls: number;
  fallback_rate: number;
  retry_count: number;
  avg_latency_ms: number;
  p50_latency_ms: number;
  p95_latency_ms: number;
  total_cost_usd: number;
  avg_cost_usd: number;
  cost_per_1k_calls_usd: number;
  first_seen_at: string | null;
  last_seen_at: string | null;
}

export interface TierRoutingStats {
  tier: string;
  calls: number;
  fallback_calls: number;
  fallback_rate: number;
  targets: RouteTargetStats[];
}

export interface AdaptiveRoutingStatsWindow {
  generated_at: string;
  window_hours: number;
  sample_limit: number;
  min_samples: number;
  observed_calls: number;
  targets: RouteTargetStats[];
  tiers: TierRoutingStats[];
}

@Injectable()
export class AdaptiveRoutingStatsService {
  constructor(
    @InjectRepository(CallLog)
    private readonly callLogRepo: Repository<CallLog>,
  ) {}

  async getWindow(
    options: AdaptiveRoutingStatsOptions = {},
  ): Promise<AdaptiveRoutingStatsWindow> {
    const windowHours = this.clampInt(options.windowHours ?? 24, 1, 24 * 30);
    const sampleLimit = this.clampInt(options.sampleLimit ?? 1000, 50, 10000);
    const minSamples = this.clampInt(options.minSamples ?? 5, 1, 1000);
    const since = new Date(Date.now() - windowHours * 60 * 60 * 1000);

    const logs = await this.readWindow(since, sampleLimit);

    const globalGroups = this.groupLogs(logs, (log) =>
      this.targetKey(log.node_id, log.model),
    );
    const targets = Array.from(globalGroups.entries())
      .map(([key, group]) => this.summarizeTarget(key, group))
      .sort((a, b) => b.calls - a.calls || a.key.localeCompare(b.key));

    const tierGroups = this.groupLogs(logs, (log) => log.tier || 'unknown');
    const tiers = Array.from(tierGroups.entries())
      .map(([tier, tierLogs]) => {
        const targetGroups = this.groupLogs(tierLogs, (log) =>
          this.targetKey(log.node_id, log.model),
        );
        const fallbackCalls = tierLogs.filter((log) => log.is_fallback).length;

        return {
          tier,
          calls: tierLogs.length,
          fallback_calls: fallbackCalls,
          fallback_rate: this.roundRatio(fallbackCalls, tierLogs.length),
          targets: Array.from(targetGroups.entries())
            .map(([key, group]) => this.summarizeTarget(key, group, tier))
            .sort((a, b) => b.calls - a.calls || a.key.localeCompare(b.key)),
        };
      })
      .sort((a, b) => a.tier.localeCompare(b.tier));

    return {
      generated_at: new Date().toISOString(),
      window_hours: windowHours,
      sample_limit: sampleLimit,
      min_samples: minSamples,
      observed_calls: logs.length,
      targets,
      tiers,
    };
  }

  private async readWindow(since: Date, sampleLimit: number): Promise<RoutingStatsLog[]> {
    // Flat statistics need no entity identity map, relation processing or hidden
    // primary-key selection. Preserve the driver's normal column conversions.
    const query = this.callLogRepo.createQueryBuilder('log').select([]);
    const columns = ROUTING_STATS_FIELDS.map((field) => {
      const column = this.callLogRepo.metadata.findColumnWithPropertyName(field);
      if (!column) throw new Error(`Missing routing statistics column: ${field}`);
      query.addSelect(`log.${field}`, field);
      return column;
    });
    const rows = await query
      .where({ timestamp: MoreThanOrEqual(since) })
      .orderBy('log.timestamp', 'DESC')
      .take(sampleLimit)
      .getRawMany<Record<keyof RoutingStatsLog, unknown>>();
    const driver = this.callLogRepo.manager.connection.driver;
    return rows.map((row) => {
      const log = {} as RoutingStatsLog;
      for (const column of columns) {
        const value = row[column.propertyName as keyof RoutingStatsLog];
        if (value !== undefined) column.setEntityValue(log, driver.prepareHydratedValue(value, column));
      }
      return log;
    });
  }

  private summarizeTarget(
    key: string,
    logs: RoutingStatsLog[],
    tier?: string,
  ): RouteTargetStats {
    const [node, model] = this.splitTargetKey(key);
    const successes = logs.filter((log) => this.isSuccess(log.status_code)).length;
    const fallbackCalls = logs.filter((log) => log.is_fallback).length;
    const latencies = logs
      .map((log) => log.latency_ms)
      .filter((value) => Number.isFinite(value) && value >= 0)
      .sort((a, b) => a - b);
    const costs = logs.map((log) => Number(log.cost_usd || 0));
    const timestamps = logs
      .map((log) => log.timestamp)
      .filter((value): value is Date => value instanceof Date)
      .sort((a, b) => a.getTime() - b.getTime());
    const totalCost = costs.reduce((sum, value) => sum + value, 0);
    const retryCount = logs.reduce((sum, log) => sum + (log.retry_count || 0), 0);

    return {
      key,
      tier,
      node,
      model,
      calls: logs.length,
      successes,
      failures: logs.length - successes,
      success_rate: this.roundRatio(successes, logs.length),
      fallback_calls: fallbackCalls,
      fallback_rate: this.roundRatio(fallbackCalls, logs.length),
      retry_count: retryCount,
      avg_latency_ms: this.roundNumber(this.average(latencies), 0),
      p50_latency_ms: this.roundNumber(this.percentile(latencies, 50), 0),
      p95_latency_ms: this.roundNumber(this.percentile(latencies, 95), 0),
      total_cost_usd: this.roundNumber(totalCost, 6),
      avg_cost_usd: this.roundNumber(totalCost / Math.max(logs.length, 1), 6),
      cost_per_1k_calls_usd: this.roundNumber(
        (totalCost / Math.max(logs.length, 1)) * 1000,
        4,
      ),
      first_seen_at: timestamps[0]?.toISOString() || null,
      last_seen_at: timestamps[timestamps.length - 1]?.toISOString() || null,
    };
  }

  private groupLogs(
    logs: RoutingStatsLog[],
    keyFn: (log: RoutingStatsLog) => string,
  ): Map<string, RoutingStatsLog[]> {
    const groups = new Map<string, RoutingStatsLog[]>();
    for (const log of logs) {
      const key = keyFn(log);
      const group = groups.get(key);
      if (group) {
        group.push(log);
      } else {
        groups.set(key, [log]);
      }
    }
    return groups;
  }

  private targetKey(node: string, model: string): string {
    return `${node}:${model}`;
  }

  private splitTargetKey(key: string): [string, string] {
    const separator = key.indexOf(':');
    if (separator === -1) return [key, ''];
    return [key.slice(0, separator), key.slice(separator + 1)];
  }

  private isSuccess(statusCode: number): boolean {
    return statusCode >= 200 && statusCode < 400;
  }

  private average(values: number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }

  private percentile(values: number[], percentile: number): number {
    if (values.length === 0) return 0;
    const index = Math.max(
      0,
      Math.min(values.length - 1, Math.ceil((percentile / 100) * values.length) - 1),
    );
    return values[index];
  }

  private roundRatio(numerator: number, denominator: number): number {
    if (denominator <= 0) return 0;
    return this.roundNumber(numerator / denominator, 4);
  }

  private roundNumber(value: number, digits: number): number {
    if (!Number.isFinite(value)) return 0;
    return Number(value.toFixed(digits));
  }

  private clampInt(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) return min;
    return Math.min(Math.max(Math.floor(value), min), max);
  }
}

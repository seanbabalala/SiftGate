import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, In, MoreThanOrEqual, Repository } from 'typeorm';
import { withCoordinatedRepository } from '../database/coordinated-repository';
import { ConfigService } from '../config/config.service';
import { ModelPricing } from '../config/gateway.config';
import {
  CanonicalEmbeddingRequest,
  CanonicalEmbeddingResponse,
  CanonicalRequest,
  CanonicalResponse,
  TokenUsage,
} from '../canonical/canonical.types';
import {
  ProviderClientService,
  ProviderError,
} from '../providers/provider-client.service';
import {
  ShadowTrafficKind,
  ShadowTrafficResult,
} from '../database/entities/shadow-traffic-result.entity';
import { CallLog } from '../database/entities/call-log.entity';
import { WorkspaceContextService } from '../workspaces/workspace-context.service';
import {
  normalizeWorkspaceId,
  workspaceFindWhere,
} from '../workspaces/workspace-scope';

interface ShadowTargetContext {
  requestId: string;
  workspaceId: string;
  namespaceId?: string | null;
  apiKeyId?: string | null;
  apiKeyName?: string | null;
  sessionId?: string | null;
  traceId?: string | null;
  sourceFormat: string;
  primaryNode: string;
  primaryModel: string;
}

export interface ShadowReportFilters {
  namespaceId?: string;
  apiKeyId?: string;
  apiKeyName?: string;
  node?: string;
  model?: string;
  period?: string;
  sourceFormat?: string;
}

export interface ShadowConfidence {
  level: 'low' | 'medium' | 'high';
  score: number;
}

export interface ShadowComparisonPair {
  primary_node: string;
  primary_model: string;
  shadow_node: string;
  shadow_model: string;
  calls: number;
  primary_success_rate: number | null;
  shadow_success_rate: number | null;
  primary_p50_latency_ms: number | null;
  shadow_p50_latency_ms: number | null;
  primary_p95_latency_ms: number | null;
  shadow_p95_latency_ms: number | null;
  cost_delta_usd: number;
  token_delta: number;
  fallback_delta: number;
}

export interface ShadowComparisonReport {
  generated_at: string;
  filters: {
    namespace_id: string | null;
    api_key_id: string | null;
    api_key_name: string | null;
    node: string | null;
    model: string | null;
    period: string;
    source_format: string | null;
  };
  window: {
    start_at: string;
    end_at: string;
    rows: number;
    comparable: number;
    missing_primary_logs: number;
  };
  primary_success_rate: number | null;
  shadow_success_rate: number | null;
  latency_delta_ms: number | null;
  p50_latency_comparison: {
    primary_ms: number | null;
    shadow_ms: number | null;
    delta_ms: number | null;
  };
  p95_latency_comparison: {
    primary_ms: number | null;
    shadow_ms: number | null;
    delta_ms: number | null;
  };
  cost_delta_usd: number;
  potential_savings_usd: number;
  token_delta: number;
  fallback_delta: number;
  quality_sample_coverage: number;
  confidence: ShadowConfidence;
  risk_notes: string[];
  primary: {
    calls: number;
    success_rate: number | null;
    p50_latency_ms: number | null;
    p95_latency_ms: number | null;
    total_cost_usd: number;
    total_tokens: number;
    fallback_rate: number | null;
  };
  shadow: {
    calls: number;
    success_rate: number | null;
    p50_latency_ms: number | null;
    p95_latency_ms: number | null;
    total_cost_usd: number;
    total_tokens: number;
    fallback_rate: number | null;
    pricing_missing: number;
  };
  pairs: ShadowComparisonPair[];
  privacy: {
    stores_prompts: boolean;
    stores_responses: boolean;
    raw_headers: false;
    provider_keys: false;
    media_bytes: false;
    video_bytes: false;
    sample_redaction: true;
  };
}

export interface ShadowResultComparison {
  result_id: number;
  request_id: string;
  timestamp: Date;
  source_format: string;
  namespace_id: string | null;
  api_key_id: string | null;
  api_key_name: string | null;
  primary: {
    node: string;
    model: string;
    success: boolean | null;
    status_code: number | null;
    latency_ms: number | null;
    cost_usd: number | null;
    input_tokens: number;
    output_tokens: number;
    is_fallback: boolean | null;
    fallback_reason: string | null;
  };
  shadow: {
    node: string;
    model: string;
    success: boolean;
    status: string;
    status_code: number | null;
    latency_ms: number | null;
    estimated_cost_usd: number;
    input_tokens: number;
    output_tokens: number;
    error: string | null;
  };
  deltas: {
    latency_ms: number | null;
    cost_usd: number | null;
    tokens: number | null;
    fallback: number | null;
  };
  samples: {
    prompt_stored: boolean;
    response_stored: boolean;
    prompt_preview: string | null;
    response_preview: string | null;
  };
  risk_notes: string[];
  privacy: ShadowComparisonReport['privacy'];
}

interface ShadowCostEstimate {
  cost: number;
  pricingMissing: boolean;
}

@Injectable()
export class ShadowTrafficService {
  private readonly logger = new Logger(ShadowTrafficService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly providerClient: ProviderClientService,
    private readonly workspaceContext: WorkspaceContextService,
    @InjectRepository(ShadowTrafficResult)
    private readonly shadowRepo: Repository<ShadowTrafficResult>,
    @InjectRepository(CallLog)
    private readonly callLogRepo: Repository<CallLog>,
  ) {}

  enqueueChat(
    requestId: string,
    canonical: CanonicalRequest,
    response: CanonicalResponse,
    primaryNode: string,
    primaryModel: string,
  ): void {
    if (!this.shouldMirror()) return;
    void this.dispatchChat(requestId, canonical, response, primaryNode, primaryModel)
      .catch((err) => this.logger.warn(`Shadow chat dispatch failed: ${(err as Error).message}`));
  }

  enqueueEmbeddings(
    requestId: string,
    canonical: CanonicalEmbeddingRequest,
    response: CanonicalEmbeddingResponse,
    primaryNode: string,
    primaryModel: string,
  ): void {
    if (!this.shouldMirror()) return;
    void this.dispatchEmbeddings(requestId, canonical, response, primaryNode, primaryModel)
      .catch((err) => this.logger.warn(`Shadow embeddings dispatch failed: ${(err as Error).message}`));
  }

  async dispatchChat(
    requestId: string,
    canonical: CanonicalRequest,
    response: CanonicalResponse,
    primaryNode: string,
    primaryModel: string,
  ): Promise<void> {
    const target = this.resolveTarget(primaryModel);
    const context = this.contextFromCanonical(
      requestId,
      canonical,
      primaryNode,
      primaryModel,
    );
    if (!target) {
      await this.saveSkipped('chat', context, 'Shadow target is not configured or not found.');
      return;
    }

    const cfg = this.config.shadowTraffic;
    const start = Date.now();
    try {
      const shadowResponse = await this.providerClient.forward(
        this.cloneChatRequest(canonical),
        target.node,
        target.model,
        {
          tier: 'direct',
          score: 0,
          is_fallback: false,
          fallback_reason: null,
        },
        cfg.timeout_ms > 0 ? { timeoutMs: cfg.timeout_ms } : {},
      );
      await this.saveResult({
        kind: 'chat',
        context,
        shadowNode: target.node,
        shadowModel: target.model,
        status: 'sent',
        latencyMs: Date.now() - start,
        statusCode: 200,
        usage: shadowResponse.usage,
        promptSample: this.promptSample(canonical),
        responseSample: this.chatResponseSample(shadowResponse),
      });
    } catch (err) {
      await this.saveResult({
        kind: 'chat',
        context,
        shadowNode: target.node,
        shadowModel: target.model,
        status: 'failed',
        latencyMs: Date.now() - start,
        statusCode: err instanceof ProviderError ? err.statusCode || null : null,
        usage: { input_tokens: 0, output_tokens: 0 },
        error: (err as Error).message,
        promptSample: this.promptSample(canonical),
        responseSample: null,
      });
    }
  }

  async dispatchEmbeddings(
    requestId: string,
    canonical: CanonicalEmbeddingRequest,
    response: CanonicalEmbeddingResponse,
    primaryNode: string,
    primaryModel: string,
  ): Promise<void> {
    const target = this.resolveTarget(primaryModel);
    const context = this.contextFromCanonical(
      requestId,
      canonical,
      primaryNode,
      primaryModel,
    );
    if (!target) {
      await this.saveSkipped('embeddings', context, 'Shadow target is not configured or not found.');
      return;
    }

    const cfg = this.config.shadowTraffic;
    const start = Date.now();
    try {
      const shadowResponse = await this.providerClient.forwardEmbeddings(
        this.cloneEmbeddingRequest(canonical),
        target.node,
        target.model,
        {
          tier: 'direct',
          score: 0,
          is_fallback: false,
          fallback_reason: null,
        },
        cfg.timeout_ms > 0 ? { timeoutMs: cfg.timeout_ms } : {},
      );
      await this.saveResult({
        kind: 'embeddings',
        context,
        shadowNode: target.node,
        shadowModel: target.model,
        status: 'sent',
        latencyMs: Date.now() - start,
        statusCode: 200,
        usage: shadowResponse.usage,
        promptSample: this.embeddingPromptSample(canonical),
        responseSample: this.embeddingResponseSample(shadowResponse),
      });
    } catch (err) {
      await this.saveResult({
        kind: 'embeddings',
        context,
        shadowNode: target.node,
        shadowModel: target.model,
        status: 'failed',
        latencyMs: Date.now() - start,
        statusCode: err instanceof ProviderError ? err.statusCode || null : null,
        usage: { input_tokens: 0, output_tokens: 0 },
        error: (err as Error).message,
        promptSample: this.embeddingPromptSample(canonical),
        responseSample: null,
      });
    }
  }

  async recent(
    namespaceId?: string,
    limit = 50,
  ): Promise<ShadowTrafficResult[]> {
    const safeLimit = Math.min(Math.max(limit, 1), 200);
    return withCoordinatedRepository(this.shadowRepo, false, (repo) =>
      repo.find({
        where: workspaceFindWhere(
          this.workspaceContext.currentWorkspaceId(),
          namespaceId ? { namespace_id: namespaceId } : {},
        ),
        order: { timestamp: 'DESC' },
        take: safeLimit,
      }),
    );
  }

  async comparisonReport(filters: ShadowReportFilters = {}): Promise<ShadowComparisonReport> {
    const period = this.normalizePeriod(filters.period);
    const end = new Date();
    const start = this.periodStart(period, end);
    const rows = await this.findReportRows(filters, start);
    const primaryLogs = await this.findPrimaryLogs(rows);
    const paired = rows
      .map((row) => ({ row, primary: primaryLogs.get(row.request_id) || null }))
      .filter((entry) => entry.primary !== null) as Array<{ row: ShadowTrafficResult; primary: CallLog }>;

    const primaryLatencies = paired.map((entry) => entry.primary.latency_ms).filter((value) => Number.isFinite(value));
    const shadowLatencies = paired
      .map((entry) => entry.row.latency_ms)
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
    const primarySuccessCount = paired.filter((entry) => this.isPrimarySuccess(entry.primary)).length;
    const shadowSuccessCount = paired.filter((entry) => this.isShadowSuccess(entry.row)).length;
    const primaryFallbackCount = paired.filter((entry) => entry.primary.is_fallback).length;
    const primaryTokens = paired.reduce(
      (sum, entry) => sum + entry.primary.input_tokens + entry.primary.output_tokens,
      0,
    );
    const shadowTokens = paired.reduce(
      (sum, entry) => sum + entry.row.input_tokens + entry.row.output_tokens,
      0,
    );
    const primaryCost = paired.reduce((sum, entry) => sum + (entry.primary.cost_usd || 0), 0);
    const shadowCostEstimates = paired.map((entry) => this.estimateShadowCost(entry.row));
    const shadowCost = shadowCostEstimates.reduce((sum, estimate) => sum + estimate.cost, 0);
    const shadowPricingMissing = shadowCostEstimates.filter((estimate) => estimate.pricingMissing).length;
    const sampleCoverageCount = paired.filter((entry) => Boolean(entry.row.prompt_sample || entry.row.response_sample)).length;

    const primarySuccessRate = this.rate(primarySuccessCount, paired.length);
    const shadowSuccessRate = this.rate(shadowSuccessCount, paired.length);
    const primaryFallbackRate = this.rate(primaryFallbackCount, paired.length);
    const shadowFallbackRate = paired.length > 0 ? 0 : null;
    const p50Primary = this.percentile(primaryLatencies, 0.5);
    const p50Shadow = this.percentile(shadowLatencies, 0.5);
    const p95Primary = this.percentile(primaryLatencies, 0.95);
    const p95Shadow = this.percentile(shadowLatencies, 0.95);
    const latencyDelta = p50Primary !== null && p50Shadow !== null
      ? this.round(p50Shadow - p50Primary, 2)
      : null;
    const fallbackDelta = primaryFallbackRate !== null && shadowFallbackRate !== null
      ? this.round(shadowFallbackRate - primaryFallbackRate, 4)
      : 0;
    const costDelta = this.round(shadowCost - primaryCost, 8);
    const tokenDelta = shadowTokens - primaryTokens;
    const qualitySampleCoverage = this.rate(sampleCoverageCount, paired.length) ?? 0;
    const riskNotes = this.reportRiskNotes({
      rows,
      pairedCount: paired.length,
      primarySuccessRate,
      shadowSuccessRate,
      latencyDelta,
      costDelta,
      qualitySampleCoverage,
      shadowPricingMissing,
    });

    return {
      generated_at: end.toISOString(),
      filters: {
        namespace_id: filters.namespaceId || null,
        api_key_id: filters.apiKeyId || null,
        api_key_name: filters.apiKeyName || null,
        node: filters.node || null,
        model: filters.model || null,
        period,
        source_format: filters.sourceFormat || null,
      },
      window: {
        start_at: start.toISOString(),
        end_at: end.toISOString(),
        rows: rows.length,
        comparable: paired.length,
        missing_primary_logs: rows.length - paired.length,
      },
      primary_success_rate: primarySuccessRate,
      shadow_success_rate: shadowSuccessRate,
      latency_delta_ms: latencyDelta,
      p50_latency_comparison: {
        primary_ms: p50Primary,
        shadow_ms: p50Shadow,
        delta_ms: p50Primary !== null && p50Shadow !== null ? this.round(p50Shadow - p50Primary, 2) : null,
      },
      p95_latency_comparison: {
        primary_ms: p95Primary,
        shadow_ms: p95Shadow,
        delta_ms: p95Primary !== null && p95Shadow !== null ? this.round(p95Shadow - p95Primary, 2) : null,
      },
      cost_delta_usd: costDelta,
      potential_savings_usd: this.round(Math.max(primaryCost - shadowCost, 0), 8),
      token_delta: tokenDelta,
      fallback_delta: fallbackDelta,
      quality_sample_coverage: qualitySampleCoverage,
      confidence: this.confidence(paired.length, qualitySampleCoverage, shadowPricingMissing, shadowSuccessRate),
      risk_notes: riskNotes,
      primary: {
        calls: paired.length,
        success_rate: primarySuccessRate,
        p50_latency_ms: p50Primary,
        p95_latency_ms: p95Primary,
        total_cost_usd: this.round(primaryCost, 8),
        total_tokens: primaryTokens,
        fallback_rate: primaryFallbackRate,
      },
      shadow: {
        calls: paired.length,
        success_rate: shadowSuccessRate,
        p50_latency_ms: p50Shadow,
        p95_latency_ms: p95Shadow,
        total_cost_usd: this.round(shadowCost, 8),
        total_tokens: shadowTokens,
        fallback_rate: shadowFallbackRate,
        pricing_missing: shadowPricingMissing,
      },
      pairs: this.groupPairs(paired),
      privacy: this.privacySummary(),
    };
  }

  async comparisonForResult(
    id: number,
  ): Promise<ShadowResultComparison | null> {
    const row = await withCoordinatedRepository(
      this.shadowRepo,
      false,
      (repo) =>
        repo.findOne({
          where: workspaceFindWhere(
            this.workspaceContext.currentWorkspaceId(),
            { id },
          ),
        }),
    );
    if (!row) return null;
    const primary = await withCoordinatedRepository(
      this.callLogRepo,
      false,
      (repo) =>
        repo.findOne({
          where: workspaceFindWhere(row.workspace_id, {
            request_id: row.request_id,
          }),
        }),
    );
    const shadowCost = this.estimateShadowCost(row);
    const primaryTokens = primary
      ? primary.input_tokens + primary.output_tokens
      : null;
    const shadowTokens = row.input_tokens + row.output_tokens;
    const riskNotes = this.resultRiskNotes(row, primary, shadowCost);

    return {
      result_id: row.id,
      request_id: row.request_id,
      timestamp: row.timestamp,
      source_format: row.source_format,
      namespace_id: row.namespace_id,
      api_key_id: row.api_key_id,
      api_key_name: row.api_key_name,
      primary: {
        node: primary?.node_id || row.primary_node,
        model: primary?.model || row.primary_model,
        success: primary ? this.isPrimarySuccess(primary) : null,
        status_code: primary?.status_code ?? null,
        latency_ms: primary?.latency_ms ?? null,
        cost_usd: primary?.cost_usd ?? null,
        input_tokens: primary?.input_tokens ?? 0,
        output_tokens: primary?.output_tokens ?? 0,
        is_fallback: primary?.is_fallback ?? null,
        fallback_reason: primary?.fallback_reason ?? null,
      },
      shadow: {
        node: row.shadow_node,
        model: row.shadow_model,
        success: this.isShadowSuccess(row),
        status: row.status,
        status_code: row.status_code,
        latency_ms: row.latency_ms,
        estimated_cost_usd: shadowCost.cost,
        input_tokens: row.input_tokens,
        output_tokens: row.output_tokens,
        error: row.error,
      },
      deltas: {
        latency_ms:
          primary && row.latency_ms !== null
            ? this.round(row.latency_ms - primary.latency_ms, 2)
            : null,
        cost_usd: primary
          ? this.round(shadowCost.cost - (primary.cost_usd || 0), 8)
          : null,
        tokens: primaryTokens !== null ? shadowTokens - primaryTokens : null,
        fallback: primary ? (primary.is_fallback ? -1 : 0) : null,
      },
      samples: {
        prompt_stored: Boolean(row.prompt_sample),
        response_stored: Boolean(row.response_sample),
        prompt_preview: row.prompt_sample
          ? this.sanitizeSample(row.prompt_sample)
          : null,
        response_preview: row.response_sample
          ? this.sanitizeSample(row.response_sample)
          : null,
      },
      risk_notes: riskNotes,
      privacy: this.privacySummary(),
    };
  }

  getStatus() {
    const cfg = this.config.shadowTraffic;
    return {
      enabled: cfg.enabled,
      sample_rate: cfg.sample_rate,
      target_node: cfg.target_node || null,
      target_model: cfg.target_model || null,
      timeout_ms: cfg.timeout_ms || null,
      max_recent_results: cfg.max_recent_results,
      compare: cfg.compare,
      privacy: {
        stores_prompts: cfg.compare.store_prompts,
        stores_responses: cfg.compare.store_responses,
        raw_headers: false,
        provider_keys: false,
        media_bytes: false,
        video_bytes: false,
        sample_redaction: true,
      },
    };
  }

  private async findReportRows(
    filters: ShadowReportFilters,
    start: Date,
  ): Promise<ShadowTrafficResult[]> {
    const where: FindOptionsWhere<ShadowTrafficResult> = {
      timestamp: MoreThanOrEqual(start),
    };
    if (filters.namespaceId) where.namespace_id = filters.namespaceId;
    if (filters.apiKeyId) where.api_key_id = filters.apiKeyId;
    else if (filters.apiKeyName) where.api_key_name = filters.apiKeyName;
    if (filters.sourceFormat) where.source_format = filters.sourceFormat;

    const rows = await withCoordinatedRepository(
      this.shadowRepo,
      false,
      (repo) =>
        repo.find({
          where: workspaceFindWhere(
            this.workspaceContext.currentWorkspaceId(),
            where,
          ),
          order: { timestamp: 'DESC' },
          take: Math.min(
            Math.max(this.config.shadowTraffic.max_recent_results, 100),
            5000,
          ),
        }),
    );

    return rows.filter((row) => {
      if (
        filters.node &&
        row.primary_node !== filters.node &&
        row.shadow_node !== filters.node
      ) {
        return false;
      }
      if (
        filters.model &&
        row.primary_model !== filters.model &&
        row.shadow_model !== filters.model
      ) {
        return false;
      }
      return true;
    });
  }

  private async findPrimaryLogs(
    rows: ShadowTrafficResult[],
  ): Promise<Map<string, CallLog>> {
    const requestIds = Array.from(
      new Set(rows.map((row) => row.request_id).filter(Boolean)),
    );
    if (requestIds.length === 0) return new Map();
    const logs = await withCoordinatedRepository(
      this.callLogRepo,
      false,
      (repo) =>
        repo.find({
          where: workspaceFindWhere(
            this.workspaceContext.currentWorkspaceId(),
            {
              request_id: In(requestIds),
            },
          ),
        }),
    );
    return new Map(logs.map((log) => [log.request_id, log]));
  }

  private groupPairs(paired: Array<{ row: ShadowTrafficResult; primary: CallLog }>): ShadowComparisonPair[] {
    const groups = new Map<string, Array<{ row: ShadowTrafficResult; primary: CallLog }>>();
    for (const entry of paired) {
      const key = [
        entry.primary.node_id,
        entry.primary.model,
        entry.row.shadow_node,
        entry.row.shadow_model,
      ].join('\u0000');
      const current = groups.get(key) || [];
      current.push(entry);
      groups.set(key, current);
    }

    return Array.from(groups.values())
      .map((entries) => {
        const primaryLatencies = entries.map((entry) => entry.primary.latency_ms);
        const shadowLatencies = entries
          .map((entry) => entry.row.latency_ms)
          .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
        const primaryCost = entries.reduce((sum, entry) => sum + (entry.primary.cost_usd || 0), 0);
        const shadowCost = entries.reduce((sum, entry) => sum + this.estimateShadowCost(entry.row).cost, 0);
        const primaryTokens = entries.reduce(
          (sum, entry) => sum + entry.primary.input_tokens + entry.primary.output_tokens,
          0,
        );
        const shadowTokens = entries.reduce(
          (sum, entry) => sum + entry.row.input_tokens + entry.row.output_tokens,
          0,
        );
        const primaryFallbackRate = this.rate(
          entries.filter((entry) => entry.primary.is_fallback).length,
          entries.length,
        ) || 0;

        return {
          primary_node: entries[0].primary.node_id,
          primary_model: entries[0].primary.model,
          shadow_node: entries[0].row.shadow_node,
          shadow_model: entries[0].row.shadow_model,
          calls: entries.length,
          primary_success_rate: this.rate(
            entries.filter((entry) => this.isPrimarySuccess(entry.primary)).length,
            entries.length,
          ),
          shadow_success_rate: this.rate(
            entries.filter((entry) => this.isShadowSuccess(entry.row)).length,
            entries.length,
          ),
          primary_p50_latency_ms: this.percentile(primaryLatencies, 0.5),
          shadow_p50_latency_ms: this.percentile(shadowLatencies, 0.5),
          primary_p95_latency_ms: this.percentile(primaryLatencies, 0.95),
          shadow_p95_latency_ms: this.percentile(shadowLatencies, 0.95),
          cost_delta_usd: this.round(shadowCost - primaryCost, 8),
          token_delta: shadowTokens - primaryTokens,
          fallback_delta: this.round(0 - primaryFallbackRate, 4),
        };
      })
      .sort((a, b) => b.calls - a.calls);
  }

  private normalizePeriod(period?: string): string {
    const value = (period || '7d').trim().toLowerCase();
    return /^\d+[hd]$/.test(value) ? value : '7d';
  }

  private periodStart(period: string, end: Date): Date {
    const match = /^(\d+)([hd])$/.exec(period);
    if (!match) return new Date(end.getTime() - 7 * 86_400_000);
    const amount = Number(match[1]);
    const millis = match[2] === 'h' ? amount * 3_600_000 : amount * 86_400_000;
    return new Date(end.getTime() - millis);
  }

  private isPrimarySuccess(log: CallLog): boolean {
    return log.status_code >= 200 && log.status_code < 400;
  }

  private isShadowSuccess(row: ShadowTrafficResult): boolean {
    return row.status === 'sent' && (row.status_code === null || (row.status_code >= 200 && row.status_code < 400));
  }

  private estimateShadowCost(row: ShadowTrafficResult): ShadowCostEstimate {
    const pricing = this.config.getModelPricing(row.shadow_model, row.shadow_node);
    if (!pricing) {
      return {
        cost: 0,
        pricingMissing: row.input_tokens + row.output_tokens > 0,
      };
    }
    return {
      cost: this.round(this.calculateCost(
        { input_tokens: row.input_tokens, output_tokens: row.output_tokens },
        pricing,
      ), 8),
      pricingMissing: false,
    };
  }

  private calculateCost(usage: TokenUsage, pricing: ModelPricing): number {
    return (
      ((usage.input_tokens || 0) / 1_000_000) * pricing.input +
      ((usage.output_tokens || 0) / 1_000_000) * pricing.output
    );
  }

  private rate(count: number, total: number): number | null {
    if (total <= 0) return null;
    return this.round(count / total, 4);
  }

  private percentile(values: number[], percentile: number): number | null {
    const filtered = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
    if (filtered.length === 0) return null;
    const index = Math.min(filtered.length - 1, Math.max(0, Math.ceil(filtered.length * percentile) - 1));
    return this.round(filtered[index], 2);
  }

  private round(value: number, digits = 4): number {
    if (!Number.isFinite(value)) return 0;
    return Number(value.toFixed(digits));
  }

  private confidence(
    comparable: number,
    qualityCoverage: number,
    pricingMissing: number,
    shadowSuccessRate: number | null,
  ): ShadowConfidence {
    if (comparable <= 0) return { level: 'low', score: 0 };
    let score = Math.min(0.55, comparable / 100);
    score += Math.min(0.2, qualityCoverage * 0.2);
    score += pricingMissing === 0 ? 0.15 : 0;
    score += shadowSuccessRate !== null ? shadowSuccessRate * 0.1 : 0;
    if (comparable < 10) score = Math.min(score, 0.35);
    else if (comparable < 30) score = Math.min(score, 0.65);
    const rounded = this.round(Math.min(score, 0.95), 4);
    return {
      level: rounded >= 0.75 ? 'high' : rounded >= 0.4 ? 'medium' : 'low',
      score: rounded,
    };
  }

  private reportRiskNotes(params: {
    rows: ShadowTrafficResult[];
    pairedCount: number;
    primarySuccessRate: number | null;
    shadowSuccessRate: number | null;
    latencyDelta: number | null;
    costDelta: number;
    qualitySampleCoverage: number;
    shadowPricingMissing: number;
  }): string[] {
    const notes = new Set<string>();
    if (params.rows.length === 0) notes.add('no_shadow_results');
    if (params.pairedCount < 10) notes.add('low_sample_size');
    if (params.rows.length > params.pairedCount) notes.add('missing_primary_logs');
    if (
      params.primarySuccessRate !== null &&
      params.shadowSuccessRate !== null &&
      params.shadowSuccessRate + 0.02 < params.primarySuccessRate
    ) {
      notes.add('shadow_success_rate_lower');
    }
    if (params.latencyDelta !== null && params.latencyDelta > 250) notes.add('latency_regression');
    if (params.costDelta > 0.000001) notes.add('shadow_cost_higher');
    if (params.shadowPricingMissing > 0) notes.add('pricing_missing');
    if (params.qualitySampleCoverage === 0) notes.add('quality_samples_disabled');
    if (params.rows.some((row) => row.status === 'failed')) notes.add('shadow_failures_present');
    notes.add('shadow_does_not_apply_routing_changes');
    return Array.from(notes);
  }

  private resultRiskNotes(
    row: ShadowTrafficResult,
    primary: CallLog | null,
    shadowCost: ShadowCostEstimate,
  ): string[] {
    const notes = new Set<string>();
    if (!primary) notes.add('missing_primary_log');
    if (!this.isShadowSuccess(row)) notes.add('shadow_failed_or_skipped');
    if (primary && row.latency_ms !== null && row.latency_ms - primary.latency_ms > 250) {
      notes.add('latency_regression');
    }
    if (primary && shadowCost.cost > (primary.cost_usd || 0)) notes.add('shadow_cost_higher');
    if (shadowCost.pricingMissing) notes.add('pricing_missing');
    if (!row.response_sample) notes.add('quality_samples_disabled');
    return Array.from(notes);
  }

  private privacySummary(): ShadowComparisonReport['privacy'] {
    const cfg = this.config.shadowTraffic;
    return {
      stores_prompts: cfg.compare.store_prompts,
      stores_responses: cfg.compare.store_responses,
      raw_headers: false,
      provider_keys: false,
      media_bytes: false,
      video_bytes: false,
      sample_redaction: true,
    };
  }

  private shouldMirror(): boolean {
    const cfg = this.config.shadowTraffic;
    if (!cfg.enabled) return false;
    if (cfg.sample_rate <= 0) return false;
    if (cfg.sample_rate >= 1) return true;
    return Math.random() < cfg.sample_rate;
  }

  private resolveTarget(primaryModel: string): { node: string; model: string } | null {
    const cfg = this.config.shadowTraffic;
    if (!cfg.target_node) return null;
    const node = this.config.getNode(cfg.target_node);
    if (!node) return null;
    const model = cfg.target_model || primaryModel || node.models[0] || node.embedding_models?.[0];
    if (!model) return null;
    return { node: node.id, model };
  }

  private contextFromCanonical(
    requestId: string,
    canonical: CanonicalRequest | CanonicalEmbeddingRequest,
    primaryNode: string,
    primaryModel: string,
  ): ShadowTargetContext {
    return {
      requestId,
      workspaceId: normalizeWorkspaceId(
        canonical.metadata.workspace_id || this.workspaceContext.currentWorkspaceId(),
      ),
      namespaceId: canonical.metadata.namespace_id || null,
      apiKeyId: canonical.metadata.api_key_id || null,
      apiKeyName: canonical.metadata.api_key_name || null,
      sessionId:
        canonical.metadata.session_id ||
        canonical.metadata.session_key ||
        null,
      traceId: canonical.metadata.trace_id || null,
      sourceFormat: canonical.metadata.source_format,
      primaryNode,
      primaryModel,
    };
  }

  private cloneChatRequest(canonical: CanonicalRequest): CanonicalRequest {
    const cloned = JSON.parse(JSON.stringify(canonical)) as CanonicalRequest;
    cloned.stream = false;
    cloned.metadata = {
      ...cloned.metadata,
      raw_headers: {},
    };
    return cloned;
  }

  private cloneEmbeddingRequest(canonical: CanonicalEmbeddingRequest): CanonicalEmbeddingRequest {
    const cloned = JSON.parse(JSON.stringify(canonical)) as CanonicalEmbeddingRequest;
    cloned.metadata = {
      ...cloned.metadata,
      raw_headers: {},
    };
    return cloned;
  }

  private promptSample(canonical: CanonicalRequest): string | null {
    if (!this.config.shadowTraffic.compare.store_prompts) return null;
    return this.sanitizeSample(JSON.stringify({ messages: canonical.messages, tools: canonical.tools || [] }));
  }

  private embeddingPromptSample(canonical: CanonicalEmbeddingRequest): string | null {
    if (!this.config.shadowTraffic.compare.store_prompts) return null;
    return this.sanitizeSample(JSON.stringify({ input: canonical.input, dimensions: canonical.dimensions ?? null }));
  }

  private chatResponseSample(response: CanonicalResponse): string | null {
    if (!this.config.shadowTraffic.compare.store_responses) return null;
    return this.sanitizeSample(JSON.stringify({ content: response.content, stop_reason: response.stop_reason }));
  }

  private embeddingResponseSample(response: CanonicalEmbeddingResponse): string | null {
    if (!this.config.shadowTraffic.compare.store_responses) return null;
    return this.sanitizeSample(JSON.stringify({ data: response.data, usage: response.usage }));
  }

  private sanitizeSample(value: string): string {
    const max = this.config.shadowTraffic.compare.sample_max_chars ?? 4000;
    const redacted = value
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
      .replace(/\b(?:sk|gw_sk|pk|rk)_[A-Za-z0-9._-]{8,}\b/g, '[redacted-key]')
      .replace(/\bsk-[A-Za-z0-9._-]{8,}\b/g, '[redacted-key]')
      .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[redacted-aws-key]')
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-email]');
    return redacted.length > max ? `${redacted.slice(0, max)}...[truncated]` : redacted;
  }

  private async saveSkipped(
    kind: ShadowTrafficKind,
    context: ShadowTargetContext,
    error: string,
  ): Promise<void> {
    const cfg = this.config.shadowTraffic;
    await this.saveResult({
      kind,
      context,
      shadowNode: cfg.target_node || 'unconfigured',
      shadowModel: cfg.target_model || 'unconfigured',
      status: 'skipped',
      latencyMs: null,
      statusCode: null,
      usage: { input_tokens: 0, output_tokens: 0 },
      error,
      promptSample: null,
      responseSample: null,
    });
  }

  private async saveResult(params: {
    kind: ShadowTrafficKind;
    context: ShadowTargetContext;
    shadowNode: string;
    shadowModel: string;
    status: 'sent' | 'failed' | 'skipped';
    latencyMs: number | null;
    statusCode: number | null;
    usage: TokenUsage;
    error?: string | null;
    promptSample: string | null;
    responseSample: string | null;
  }): Promise<void> {
    const saved = await withCoordinatedRepository(
      this.shadowRepo,
      true,
      (repo) =>
        repo.save(
          repo.create({
            request_id: params.context.requestId,
            kind: params.kind,
            workspace_id: params.context.workspaceId,
            namespace_id: params.context.namespaceId || null,
            api_key_id: params.context.apiKeyId || null,
            api_key_name: params.context.apiKeyName || null,
            session_id: params.context.sessionId || null,
            trace_id: params.context.traceId || null,
            source_format: params.context.sourceFormat,
            primary_node: params.context.primaryNode,
            primary_model: params.context.primaryModel,
            shadow_node: params.shadowNode,
            shadow_model: params.shadowModel,
            status: params.status,
            latency_ms: params.latencyMs,
            status_code: params.statusCode,
            error: params.error || null,
            input_tokens: params.usage.input_tokens || 0,
            output_tokens: params.usage.output_tokens || 0,
            prompt_sample: params.promptSample,
            response_sample: params.responseSample,
          }),
        ),
    );

    await this.enforceRetention(saved.id);
  }

  private async enforceRetention(newestId: number): Promise<void> {
    const maxRecent = this.config.shadowTraffic.max_recent_results;
    if (maxRecent <= 0) return;

    try {
      await withCoordinatedRepository(this.shadowRepo, true, async (repo) => {
        const rows = await repo.find({
          order: { timestamp: 'DESC' },
          skip: maxRecent,
          take: 200,
        });
        const staleIds = rows
          .map((row) => row.id)
          .filter((id) => id !== newestId);
        if (staleIds.length > 0) {
          await repo.delete({ id: In(staleIds) });
        }
      });
    } catch (err) {
      this.logger.debug(
        `Shadow retention cleanup skipped: ${(err as Error).message}`,
      );
    }
  }
}

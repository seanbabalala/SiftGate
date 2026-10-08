import {
  BadRequestException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'crypto';
import { Repository, type EntityManager } from 'typeorm';
import {
  coordinatedRepositoryOperation,
  lockRepositoryWriter,
  withCoordinatedRepository,
} from '../database/coordinated-repository';
import { v4 as uuidv4 } from 'uuid';
import { ConfigService } from '../config/config.service';
import type {
  ContextOptimizerStrategy,
  RouteTarget,
  SemanticIntentCategory,
} from '../config/gateway.config';
import type {
  CanonicalContentBlock,
  CanonicalMessage,
  CanonicalRequest,
  CanonicalResponse,
} from '../canonical/canonical.types';
import { estimateCanonicalRequestTokens } from '../routing/token-estimator';
import { PromptCacheService } from '../cache/prompt-cache.service';
import {
  CallLog,
  PromptTemplate,
  RouteDecisionLog,
} from '../database/entities';
import { SqliteAnalyticsService } from '../database/sqlite-analytics.service';
import { WorkspaceContextService } from '../workspaces/workspace-context.service';
import {
  applyWorkspaceQueryScope,
  normalizeWorkspaceId,
  workspaceFindWhere,
} from '../workspaces/workspace-scope';
import { CapabilityService } from '../config/capability.service';

export interface CreatePromptTemplateInput {
  prompt_key?: string;
  name?: string | null;
  template?: string;
  variables?: string[];
  route_policy_id?: string | null;
  ab_metadata?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
}

export interface SemanticPlatformEvidence {
  intent?: SemanticIntentEvidence;
  context_optimizer?: ContextOptimizerEvidence;
  guardrails_v2?: GuardrailsV2Evidence;
  prompt_registry?: PromptRegistryRouteEvidence;
}

export interface SemanticIntentEvidence {
  enabled: boolean;
  category: SemanticIntentCategory;
  confidence: number;
  signals: string[];
  route_hint: {
    preferred_capabilities: string[];
    quality_critical: boolean;
    security_sensitive: boolean;
  };
}

export interface ContextOptimizerEvidence {
  enabled: boolean;
  strategy: ContextOptimizerStrategy;
  action: 'none' | 'metadata_only' | 'trim_suggested' | 'summarize_suggested' | 'trimmed' | 'summarized';
  mutation_allowed: boolean;
  estimated_context_tokens: number;
  max_context_tokens: number | null;
  context_ratio: number | null;
  threshold_ratio: number;
  route_target: RouteTarget | null;
  changed_content: false;
  reason: string;
}

export interface GuardrailsV2Finding {
  surface: 'input' | 'output';
  kind: 'pii' | 'toxicity' | 'jailbreak';
  action: 'observe' | 'block' | 'alert';
  severity: 'info' | 'warning' | 'critical';
  match_count: number;
  metadata_only: true;
}

export interface GuardrailsV2Evidence {
  enabled: boolean;
  metadata_only: boolean;
  input_policy: {
    enabled: boolean;
    pii: boolean;
    toxicity: boolean;
    jailbreak: boolean;
    action: 'observe' | 'block' | 'alert';
  };
  output_policy: {
    enabled: boolean;
    pii: boolean;
    toxicity: boolean;
    jailbreak: boolean;
    action: 'observe' | 'block' | 'alert';
  };
  findings: GuardrailsV2Finding[];
  blocked: false;
  reason: string;
}

export interface PromptRegistryRouteEvidence {
  enabled: boolean;
  prompt_key: string | null;
  version: number | null;
  template_hash: string | null;
  variables: string[];
  route_policy_id: string | null;
  ab_metadata: Record<string, unknown> | null;
  content_available: false;
  reason: string;
}

interface SemanticDashboardAnalytics {
  recentRequests: number;
  recentHits: number;
  recentMetadataMatches: number;
  intentCounts: Record<string, number>;
  contextActions: Record<string, number>;
  guardrailKinds: Record<string, number>;
}

interface SemanticDashboardMetricRow extends Record<string, unknown> {
  metric: string;
  dimension: string;
  count: number;
}

@Injectable()
export class SemanticPlatformService {
  private promptTransaction?: EntityManager;
  constructor(
    private readonly config: ConfigService,
    private readonly workspaceContext: WorkspaceContextService,
    private readonly capabilityService: CapabilityService,
    private readonly cacheService: PromptCacheService,
    @InjectRepository(PromptTemplate)
    private readonly promptTemplateRepo: Repository<PromptTemplate>,
    @InjectRepository(CallLog)
    private readonly callLogRepo: Repository<CallLog>,
    @InjectRepository(RouteDecisionLog)
    private readonly routeDecisionRepo: Repository<RouteDecisionLog>,
    @Optional() private readonly sqliteAnalytics?: SqliteAnalyticsService,
  ) {}

  async getDashboardSummary(period = '7d') {
    const workspaceId = this.workspaceId();
    const periodDays = period === '90d' ? 90 : period === '30d' ? 30 : 7;
    const since = new Date(Date.now() - periodDays * 86_400_000);
    const [templates, analytics] = await Promise.all([
      this.listPromptTemplates({ limit: 50 }),
      this.loadDashboardAnalytics(since, workspaceId),
    ]);
    const semanticStats = this.cacheService.getSemanticStats();

    return {
      version: 'v1',
      workspace_id: workspaceId,
      generated_at: new Date().toISOString(),
      period,
      config: {
        enabled: this.config.semanticPlatform.enabled,
        semantic_cache: {
          enabled: this.config.semanticCache.enabled,
          backend: this.config.semanticCache.backend,
          isolation: this.config.semanticCache.isolation,
          ttl_seconds: this.config.semanticCache.ttl_seconds,
          threshold: this.config.semanticCache.similarity_threshold,
          store_responses: this.config.semanticCache.store_responses,
          response_storage_requires_header:
            this.config.semanticCache.response_storage_requires_header,
          explicit_response_storage_opt_in:
            this.config.semanticCache.store_responses &&
            this.config.semanticCache.response_storage_requires_header,
        },
        prompt_registry: this.config.semanticPlatform.prompt_registry,
        context_optimizer: this.config.semanticPlatform.context_optimizer,
        intent_classification: this.config.semanticPlatform.intent_classification,
        guardrails_v2: this.config.semanticPlatform.guardrails_v2,
      },
      semantic_cache: {
        ...semanticStats,
        workspace_isolated: true,
        key_isolated: this.config.semanticCache.isolation === 'workspace_api_key_model',
        model_isolated: this.config.semanticCache.isolation !== 'workspace',
        explicit_response_storage_opt_in:
          this.config.semanticCache.store_responses &&
          this.config.semanticCache.response_storage_requires_header,
        recent_requests: analytics.recentRequests,
        recent_hits: analytics.recentHits,
        recent_metadata_matches: analytics.recentMetadataMatches,
      },
      prompt_registry: {
        enabled: this.config.semanticPlatform.prompt_registry.enabled,
        stores_template_content:
          this.config.semanticPlatform.prompt_registry.store_template_content,
        templates: templates.items,
        total: templates.total,
        active: templates.items.filter((item) => item.status === 'active').length,
      },
      context_optimizer: {
        enabled: this.config.semanticPlatform.context_optimizer.enabled,
        strategy: this.config.semanticPlatform.context_optimizer.strategy,
        mutation_allowed:
          this.config.semanticPlatform.context_optimizer.allow_content_mutation,
        actions: analytics.contextActions,
        content_persistence: false,
      },
      intent_classification: {
        enabled: this.config.semanticPlatform.intent_classification.enabled,
        categories: this.config.semanticPlatform.intent_classification.categories,
        observed: analytics.intentCounts,
      },
      guardrails_v2: {
        enabled: this.config.semanticPlatform.guardrails_v2.enabled,
        metadata_only: this.config.semanticPlatform.guardrails_v2.metadata_only,
        findings: analytics.guardrailKinds,
        blocked_by_default: false,
      },
      privacy: this.privacyContract(),
    };
  }

  private promptWrite<T>(
    action: (service: SemanticPlatformService) => Promise<T>,
  ): Promise<T> {
    return coordinatedRepositoryOperation(
      this.promptTemplateRepo,
      true,
      (manager) => {
        if (!manager) return action(this);
        const scoped = new SemanticPlatformService(
          this.config,
          this.workspaceContext,
          this.capabilityService,
          this.cacheService,
          manager.getRepository(PromptTemplate),
          this.callLogRepo,
          this.routeDecisionRepo,
          this.sqliteAnalytics,
        );
        scoped.promptTransaction = manager;
        return action(scoped);
      },
    );
  }

  async listPromptTemplates(options: { limit?: number } = {}) {
    const rows = await withCoordinatedRepository(
      this.promptTemplateRepo,
      false,
      async (repo) => {
        const qb = repo
          .createQueryBuilder('template')
          .orderBy('template.prompt_key', 'ASC')
          .addOrderBy('template.version', 'DESC')
          .take(Math.max(1, Math.min(200, options.limit || 100)));
        applyWorkspaceQueryScope(qb, 'template', this.workspaceId());
        return qb.getMany();
      },
    );
    return {
      total: rows.length,
      items: rows.map((row) => this.toPromptTemplateSummary(row)),
      privacy: this.privacyContract(),
    };
  }

  createPromptTemplate(input: CreatePromptTemplateInput) {
    return this.promptWrite((service) =>
      service.createPromptTemplateInTransaction(input),
    );
  }

  private async createPromptTemplateInTransaction(
    input: CreatePromptTemplateInput,
  ) {
    if (!this.config.semanticPlatform.prompt_registry.enabled) {
      throw new BadRequestException('Prompt Registry is disabled.');
    }
    const promptKey = sanitizeIdentifier(input.prompt_key, 120);
    if (!promptKey) throw new BadRequestException('prompt_key is required.');
    const template = typeof input.template === 'string' ? input.template : '';
    if (!template.trim())
      throw new BadRequestException('template is required.');
    const workspaceId = this.workspaceId();
    await lockRepositoryWriter(
      this.promptTemplateRepo,
      this.promptTransaction,
      JSON.stringify([workspaceId, promptKey]),
    );
    const latest = await this.promptTemplateRepo.findOne({
      where: workspaceFindWhere(workspaceId, { prompt_key: promptKey }),
      order: { version: 'DESC' },
    });
    const version = (latest?.version || 0) + 1;
    const canStoreContent =
      this.config.semanticPlatform.prompt_registry.store_template_content;
    const saved = await this.promptTemplateRepo.save(
      this.promptTemplateRepo.create({
        id: `pt_${uuidv4()}`,
        workspace_id: workspaceId,
        prompt_key: promptKey,
        version,
        name: sanitizeIdentifier(input.name, 160),
        status: 'active',
        template_content: canStoreContent ? template : null,
        template_hash: sha256(template),
        variables_json: JSON.stringify(
          (input.variables || [])
            .map((item) => sanitizeIdentifier(item, 80))
            .filter(Boolean),
        ),
        route_policy_id: sanitizeIdentifier(input.route_policy_id, 120),
        ab_metadata_json: safeJson(input.ab_metadata),
        metadata_json: safeJson(input.metadata),
        content_storage_enabled: canStoreContent,
      }),
    );
    await this.pruneOldPromptVersions(promptKey, workspaceId);
    return {
      success: true,
      item: this.toPromptTemplateSummary(saved),
      privacy: this.privacyContract(),
    };
  }

  archivePromptTemplate(id: string) {
    return this.promptWrite((service) =>
      service.archivePromptTemplateInTransaction(id),
    );
  }

  private async archivePromptTemplateInTransaction(id: string) {
    const original = await this.findPromptTemplate(id);
    await lockRepositoryWriter(
      this.promptTemplateRepo,
      this.promptTransaction,
      JSON.stringify([this.workspaceId(), original.prompt_key]),
    );
    const row = await this.findPromptTemplate(id);
    row.status = 'archived';
    const saved = await this.promptTemplateRepo.save(row);
    return {
      success: true,
      item: this.toPromptTemplateSummary(saved),
      privacy: this.privacyContract(),
    };
  }

  async invalidateSemanticCache(scope: 'workspace' | 'all' = 'workspace') {
    this.cacheService.clearSemantic(scope === 'workspace' ? this.workspaceId() : undefined);
    return {
      success: true,
      scope,
      workspace_id: scope === 'workspace' ? this.workspaceId() : null,
      stats: this.cacheService.getSemanticStats(),
    };
  }

  async buildRouteEvidence(
    canonical: CanonicalRequest,
    target?: RouteTarget | null,
  ): Promise<SemanticPlatformEvidence> {
    const [promptEvidence] = await Promise.all([
      this.resolvePromptRegistryEvidence(canonical),
    ]);
    return {
      intent: this.classifyIntent(canonical),
      context_optimizer: this.contextOptimizerEvidence(canonical, target || null),
      guardrails_v2: this.guardrailsEvidence(canonical),
      prompt_registry: promptEvidence,
    };
  }

  classifyIntent(canonical: CanonicalRequest): SemanticIntentEvidence {
    const enabled = this.config.semanticPlatform.intent_classification.enabled;
    const text = extractRequestText(canonical).toLowerCase();
    const signals: string[] = [];
    const scores = new Map<SemanticIntentCategory, number>();
    const add = (category: SemanticIntentCategory, score: number, signal: string) => {
      scores.set(category, (scores.get(category) || 0) + score);
      signals.push(signal);
    };

    if (/\b(code|function|typescript|python|bug|stack trace|refactor|pull request|diff)\b/.test(text)) add('coding', 0.5, 'coding_terms');
    if (/\b(cve|security|vulnerability|exploit|xss|sql injection|secret leak|audit)\b/.test(text)) add('security', 0.7, 'security_terms');
    if (/\b(prove|reason|analyze|derive|formal|logic|math|why)\b/.test(text)) add('reasoning', 0.45, 'reasoning_terms');
    if (/\b(todo|plan|steps|task|checklist|workflow|runbook)\b/.test(text)) add('task', 0.35, 'task_terms');
    if (/\b(write|rewrite|brand|story|creative|copy|tone)\b/.test(text)) add('creative', 0.3, 'creative_terms');
    if (canonical.messages.some((msg) => messageBlocks(msg).some((block) => block.type !== 'text'))) add('multimodal', 0.6, 'non_text_blocks');
    if (/\b(compare|trend|metric|benchmark|root cause|investigate)\b/.test(text)) add('analysis', 0.35, 'analysis_terms');

    const allowed = new Set(this.config.semanticPlatform.intent_classification.categories);
    const ranked = [...scores.entries()]
      .filter(([category]) => allowed.has(category))
      .sort((a, b) => b[1] - a[1]);
    const [category, rawScore] = ranked[0] || ['general', 0.2];
    const confidence = enabled
      ? Math.max(0, Math.min(1, Number(rawScore.toFixed(4))))
      : 0;
    const effectiveCategory =
      enabled && confidence >= this.config.semanticPlatform.intent_classification.min_confidence
        ? category
        : 'general';
    return {
      enabled,
      category: effectiveCategory,
      confidence,
      signals: [...new Set(signals)].slice(0, 8),
      route_hint: {
        preferred_capabilities: intentCapabilities(effectiveCategory),
        quality_critical: effectiveCategory === 'security' || effectiveCategory === 'reasoning',
        security_sensitive: effectiveCategory === 'security',
      },
    };
  }

  contextOptimizerEvidence(
    canonical: CanonicalRequest,
    target: RouteTarget | null,
  ): ContextOptimizerEvidence {
    const cfg = this.config.semanticPlatform.context_optimizer;
    const estimate = estimateCanonicalRequestTokens(canonical);
    const maxContextTokens = target
      ? this.capabilityService.resolveModelRoutingCapabilities(target.node, target.model)
          .max_context_tokens ?? null
      : null;
    const ratio =
      maxContextTokens && maxContextTokens > 0
        ? Number((estimate.context_tokens / maxContextTokens).toFixed(4))
        : null;
    const overThreshold = ratio !== null && ratio >= cfg.max_context_ratio;
    const suggested =
      cfg.strategy === 'trim'
        ? 'trim_suggested'
        : cfg.strategy === 'summarize'
          ? 'summarize_suggested'
          : 'metadata_only';
    return {
      enabled: cfg.enabled,
      strategy: cfg.strategy,
      action:
        !cfg.enabled
          ? 'none'
          : overThreshold
            ? (cfg.allow_content_mutation ? suggested : 'metadata_only')
            : 'metadata_only',
      mutation_allowed: cfg.allow_content_mutation,
      estimated_context_tokens: estimate.context_tokens,
      max_context_tokens: maxContextTokens,
      context_ratio: ratio,
      threshold_ratio: cfg.max_context_ratio,
      route_target: target,
      changed_content: false,
      reason:
        !cfg.enabled
          ? 'context_optimizer_disabled'
          : !overThreshold
            ? 'context_within_window'
            : cfg.allow_content_mutation
              ? 'content_mutation_requested_but_not_applied_in_v2_7'
              : 'metadata_only_no_prompt_mutation',
    };
  }

  guardrailsEvidence(
    canonical: CanonicalRequest,
    response?: CanonicalResponse | null,
  ): GuardrailsV2Evidence {
    const cfg = this.config.semanticPlatform.guardrails_v2;
    const findings: GuardrailsV2Finding[] = [];
    if (cfg.enabled && cfg.input.enabled) {
      findings.push(...this.findGuardrailMatches(extractRequestText(canonical), 'input'));
    }
    if (cfg.enabled && cfg.output.enabled && response) {
      findings.push(...this.findGuardrailMatches(extractResponseText(response), 'output'));
    }
    return {
      enabled: cfg.enabled,
      metadata_only: cfg.metadata_only,
      input_policy: cfg.input,
      output_policy: cfg.output,
      findings,
      blocked: false,
      reason:
        !cfg.enabled
          ? 'guardrails_v2_disabled'
          : findings.length > 0
            ? 'guardrails_v2_findings_metadata_only'
            : 'guardrails_v2_no_findings',
    };
  }

  async resolvePromptRegistryEvidence(
    canonical: CanonicalRequest,
  ): Promise<PromptRegistryRouteEvidence> {
    const enabled = this.config.semanticPlatform.prompt_registry.enabled;
    const promptKey = sanitizeIdentifier(
      canonical.metadata.raw_headers?.['x-siftgate-prompt-key'],
      120,
    );
    if (!enabled || !promptKey) {
      return {
        enabled,
        prompt_key: promptKey || null,
        version: null,
        template_hash: null,
        variables: [],
        route_policy_id: null,
        ab_metadata: null,
        content_available: false,
        reason: enabled
          ? 'prompt_key_not_supplied'
          : 'prompt_registry_disabled',
      };
    }
    const requestedVersion = Number(
      canonical.metadata.raw_headers?.['x-siftgate-prompt-version'],
    );
    const row = await withCoordinatedRepository(
      this.promptTemplateRepo,
      false,
      (repo) =>
        repo.findOne({
          where: workspaceFindWhere(this.workspaceId(), {
            prompt_key: promptKey,
            ...(Number.isFinite(requestedVersion) && requestedVersion > 0
              ? { version: requestedVersion }
              : {}),
          }),
          order: { version: 'DESC' },
        }),
    );
    if (!row || row.status !== 'active') {
      return {
        enabled,
        prompt_key: promptKey,
        version: Number.isFinite(requestedVersion) ? requestedVersion : null,
        template_hash: null,
        variables: [],
        route_policy_id: null,
        ab_metadata: null,
        content_available: false,
        reason: 'prompt_template_not_found',
      };
    }
    return {
      enabled,
      prompt_key: row.prompt_key,
      version: row.version,
      template_hash: row.template_hash,
      variables: parseJson<string[]>(row.variables_json) || [],
      route_policy_id: row.route_policy_id,
      ab_metadata: parseJson<Record<string, unknown>>(row.ab_metadata_json),
      content_available: false,
      reason: 'prompt_template_version_bound',
    };
  }

  private findGuardrailMatches(
    text: string,
    surface: 'input' | 'output',
  ): GuardrailsV2Finding[] {
    const policy = surface === 'input'
      ? this.config.semanticPlatform.guardrails_v2.input
      : this.config.semanticPlatform.guardrails_v2.output;
    const findings: GuardrailsV2Finding[] = [];
    if (policy.pii) {
      const piiMatches = [
        /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
        /\b(?:\d[ -]*?){13,16}\b/g,
      ].reduce((sum, pattern) => sum + (text.match(pattern)?.length || 0), 0);
      if (piiMatches > 0) findings.push({
        surface,
        kind: 'pii',
        action: policy.action,
        severity: policy.action === 'block' ? 'critical' : 'warning',
        match_count: piiMatches,
        metadata_only: true,
      });
    }
    if (policy.toxicity) {
      const toxicityMatches = (text.match(/\b(hate|harass|abuse|kill yourself)\b/gi) || []).length;
      if (toxicityMatches > 0) findings.push({
        surface,
        kind: 'toxicity',
        action: policy.action,
        severity: policy.action === 'block' ? 'critical' : 'warning',
        match_count: toxicityMatches,
        metadata_only: true,
      });
    }
    if (policy.jailbreak) {
      const jailbreakMatches = (text.match(/\b(ignore previous instructions|developer mode|jailbreak|reveal system prompt|bypass policy)\b/gi) || []).length;
      if (jailbreakMatches > 0) findings.push({
        surface,
        kind: 'jailbreak',
        action: policy.action,
        severity: policy.action === 'block' ? 'critical' : 'warning',
        match_count: jailbreakMatches,
        metadata_only: true,
      });
    }
    return findings;
  }

  private async findPromptTemplate(id: string): Promise<PromptTemplate> {
    const qb = this.promptTemplateRepo
      .createQueryBuilder('template')
      .where('template.id = :id', { id });
    applyWorkspaceQueryScope(qb, 'template', this.workspaceId());
    const row = await qb.getOne();
    if (!row) throw new NotFoundException('Prompt template not found.');
    return row;
  }

  private async pruneOldPromptVersions(promptKey: string, workspaceId: string) {
    const maxVersions = Math.max(
      1,
      this.config.semanticPlatform.prompt_registry.max_versions_per_key,
    );
    const rows = await this.promptTemplateRepo.find({
      where: { workspace_id: workspaceId, prompt_key: promptKey },
      order: { version: 'DESC' },
    });
    const stale = rows.slice(maxVersions);
    if (stale.length > 0) {
      await this.promptTemplateRepo.remove(stale);
    }
  }

  private toPromptTemplateSummary(row: PromptTemplate) {
    return {
      id: row.id,
      workspace_id: normalizeWorkspaceId(row.workspace_id),
      prompt_key: row.prompt_key,
      version: row.version,
      name: row.name,
      status: row.status,
      template_hash: row.template_hash,
      variables: parseJson<string[]>(row.variables_json) || [],
      route_policy_id: row.route_policy_id,
      ab_metadata: parseJson<Record<string, unknown>>(row.ab_metadata_json),
      metadata: parseJson<Record<string, unknown>>(row.metadata_json),
      content_storage_enabled: row.content_storage_enabled,
      content_available: false,
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
    };
  }

  private async loadDashboardAnalytics(
    since: Date,
    workspaceId: string,
  ): Promise<SemanticDashboardAnalytics> {
    if (this.sqliteAnalytics?.available) {
      const rows = await this.sqliteAnalytics.queryAll<SemanticDashboardMetricRow>(
        `WITH recent_logs AS MATERIALIZED (
          SELECT semantic_cache_hit, semantic_cache_score
          FROM call_logs
          WHERE timestamp >= ? AND (workspace_id = ? OR workspace_id IS NULL)
          ORDER BY timestamp DESC
          LIMIT 5000
        ),
        recent_decisions AS MATERIALIZED (
          SELECT trace_json
          FROM route_decisions
          WHERE timestamp >= ? AND (workspace_id = ? OR workspace_id IS NULL)
          ORDER BY timestamp DESC
          LIMIT 5000
        ),
        semantic_evidence AS MATERIALIZED (
          SELECT trace_json
          FROM recent_decisions
          WHERE json_valid(trace_json)
            AND json_type(trace_json, '$.semantic_platform') = 'object'
        )
        SELECT 'semantic_recent' AS metric, '' AS dimension, COUNT(*) AS count
        FROM recent_logs
        WHERE semantic_cache_hit = 1 OR semantic_cache_score IS NOT NULL
        UNION ALL
        SELECT 'semantic_hits', '', COUNT(*)
        FROM recent_logs
        WHERE semantic_cache_hit = 1
        UNION ALL
        SELECT 'semantic_metadata_matches', '', COUNT(*)
        FROM recent_logs
        WHERE semantic_cache_hit = 0 AND semantic_cache_score IS NOT NULL
        UNION ALL
        SELECT
          'intent',
          COALESCE(json_extract(trace_json, '$.semantic_platform.intent.category'), 'unknown'),
          COUNT(*)
        FROM semantic_evidence
        GROUP BY 2
        UNION ALL
        SELECT
          'context_action',
          COALESCE(json_extract(trace_json, '$.semantic_platform.context_optimizer.action'), 'unknown'),
          COUNT(*)
        FROM semantic_evidence
        GROUP BY 2
        UNION ALL
        SELECT
          'guardrail',
          COALESCE(json_extract(finding.value, '$.kind'), 'unknown'),
          COUNT(*)
        FROM semantic_evidence,
          json_each(semantic_evidence.trace_json, '$.semantic_platform.guardrails_v2.findings') AS finding
        GROUP BY 2`,
        [
          this.sqliteDateTime(since),
          workspaceId,
          this.sqliteDateTime(since),
          workspaceId,
        ],
      );
      return {
        recentRequests: this.metricCount(rows, 'semantic_recent'),
        recentHits: this.metricCount(rows, 'semantic_hits'),
        recentMetadataMatches: this.metricCount(
          rows,
          'semantic_metadata_matches',
        ),
        intentCounts: this.metricBreakdown(rows, 'intent'),
        contextActions: this.metricBreakdown(rows, 'context_action'),
        guardrailKinds: this.metricBreakdown(rows, 'guardrail'),
      };
    }

    const [logs, decisions] = await Promise.all([
      this.loadLogs(since, workspaceId),
      this.loadDecisions(since, workspaceId),
    ]);
    const semanticLogs = logs.filter(
      (log) => log.semantic_cache_hit || log.semantic_cache_score !== null,
    );
    const semanticEvidence = decisions
      .map((decision) => parseJson<Record<string, unknown>>(decision.trace_json))
      .filter((trace): trace is Record<string, unknown> => Boolean(trace))
      .map(
        (trace) =>
          trace.semantic_platform as Record<string, unknown> | undefined,
      )
      .filter((evidence): evidence is Record<string, unknown> => Boolean(evidence));

    return {
      recentRequests: semanticLogs.length,
      recentHits: semanticLogs.filter((log) => log.semantic_cache_hit).length,
      recentMetadataMatches: semanticLogs.filter(
        (log) => !log.semantic_cache_hit && log.semantic_cache_score !== null,
      ).length,
      intentCounts: countBy(
        semanticEvidence.map((evidence) =>
          String(
            (evidence.intent as Record<string, unknown> | undefined)?.category ||
              'unknown',
          ),
        ),
      ),
      contextActions: countBy(
        semanticEvidence.map((evidence) =>
          String(
            (evidence.context_optimizer as Record<string, unknown> | undefined)
              ?.action || 'unknown',
          ),
        ),
      ),
      guardrailKinds: countBy(
        semanticEvidence.flatMap((evidence) =>
          ((evidence.guardrails_v2 as Record<string, unknown> | undefined)
            ?.findings as Array<Record<string, unknown>> | undefined || []).map(
            (finding) => String(finding.kind || 'unknown'),
          ),
        ),
      ),
    };
  }

  private metricCount(
    rows: SemanticDashboardMetricRow[],
    metric: string,
  ): number {
    return Number(rows.find((row) => row.metric === metric)?.count || 0);
  }

  private metricBreakdown(
    rows: SemanticDashboardMetricRow[],
    metric: string,
  ): Record<string, number> {
    return Object.fromEntries(
      rows
        .filter((row) => row.metric === metric)
        .map((row) => [String(row.dimension || 'unknown'), Number(row.count || 0)]),
    );
  }

  private sqliteDateTime(value: Date): string {
    return value.toISOString().slice(0, 23).replace('T', ' ');
  }

  private async loadLogs(since: Date, workspaceId: string) {
    const qb = this.callLogRepo
      .createQueryBuilder('log')
      .where('log.timestamp >= :since', { since })
      .orderBy('log.timestamp', 'DESC')
      .take(5000);
    applyWorkspaceQueryScope(qb, 'log', workspaceId);
    return qb.getMany();
  }

  private async loadDecisions(since: Date, workspaceId: string) {
    const qb = this.routeDecisionRepo
      .createQueryBuilder('decision')
      .where('decision.timestamp >= :since', { since })
      .orderBy('decision.timestamp', 'DESC')
      .take(5000);
    applyWorkspaceQueryScope(qb, 'decision', workspaceId);
    return qb.getMany();
  }

  private privacyContract() {
    return {
      metadata_only: true,
      stores_prompts: false,
      stores_responses: false,
      stores_prompt_templates_by_default: false,
      stores_raw_headers: false,
      stores_provider_keys: false,
      stores_tool_payloads: false,
      stores_media_bytes: false,
      stores_hidden_reasoning: false,
      semantic_cache_response_storage_opt_in: this.config.semanticCache.store_responses,
      prompt_registry_content_storage_opt_in:
        this.config.semanticPlatform.prompt_registry.store_template_content,
    };
  }

  private workspaceId() {
    return normalizeWorkspaceId(this.workspaceContext.currentWorkspaceId());
  }
}

function extractRequestText(canonical: CanonicalRequest): string {
  return canonical.messages.map(messageText).join('\n').trim();
}

function extractResponseText(response: CanonicalResponse): string {
  return response.content.map(blockText).join('\n').trim();
}

function messageText(message: CanonicalMessage): string {
  if (typeof message.content === 'string') return message.content;
  return message.content.map(blockText).join('\n');
}

function messageBlocks(message: CanonicalMessage): CanonicalContentBlock[] {
  return typeof message.content === 'string'
    ? [{ type: 'text', text: message.content }]
    : message.content;
}

function blockText(block: CanonicalContentBlock): string {
  if (block.type === 'text') return block.text;
  if (block.type === 'tool_result') {
    return typeof block.content === 'string'
      ? block.content
      : block.content.map(blockText).join('\n');
  }
  if (block.type === 'tool_use') return block.name;
  return '';
}

function intentCapabilities(category: SemanticIntentCategory): string[] {
  if (category === 'coding') return ['coding'];
  if (category === 'security') return ['coding', 'reasoning'];
  if (category === 'reasoning') return ['reasoning'];
  if (category === 'multimodal') return ['vision'];
  if (category === 'analysis') return ['analysis', 'reasoning'];
  return [];
}

function sanitizeIdentifier(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const sanitized = value.trim().slice(0, maxLength);
  return sanitized.length > 0 ? sanitized : null;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function safeJson(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function parseJson<T>(value: string | null | undefined): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function countBy(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((acc, value) => {
    acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {});
}

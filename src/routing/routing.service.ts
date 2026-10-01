import { PricingRuntimeService } from '../pricing/pricing-runtime.service';
// ===================================================================
// RoutingService — Tier-based route resolution with circuit breaker
// ===================================================================
// Resolves a Tier → primary node + fallback chain.
// Integrates with CircuitBreakerService to skip unhealthy nodes.
// Integrates with MomentumService for session-level tier smoothing.
// Supports domain hints (frontend/backend/etc) for domain-aware routing.
//
// Domain preference resolution (in priority order):
//   1. Explicit: routing.domain_preferences.{domain} → ordered node list
//   2. Tag-based: nodes with matching tag are promoted
//   3. Default: tier config order unchanged
// ===================================================================

import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '../config/config.service';
import {
  CapabilityService,
  ResolvedModelRoutingCapabilities,
} from '../config/capability.service';
import { CanonicalMediaSourceFormat, Tier, TokenUsage } from '../canonical/canonical.types';
import { CircuitBreakerService } from './circuit-breaker.service';
import { MomentumService } from './momentum.service';
import {
  CacheAffinityResult,
  CacheAffinityService,
} from './cache-affinity.service';
import {
  LoadBalancingStrategy,
  NodeConfig,
  RouteTarget,
  RoutingOptimization,
  SplitVariant,
  TierConfig,
  WeightedRouteTarget,
} from '../config/gateway.config';
import { Modality, supportsModalities } from '../config/modality';
import { v4 as uuidv4 } from 'uuid';
import {
  RouteDecisionTrace,
  RouteDecisionCandidateCapabilityEvidence,
  RouteDecisionCompatibilityEvidence,
  RouteDecisionCacheEvidence,
  RouteDecisionTraceCandidate,
  RouteDecisionTraceFilter,
  routeTargetKey,
} from './route-decision-trace';
import { pricingEvidenceFromModelPricing } from '../catalog/pricing-governance';
import {
  compatibilityEvidence,
  compatibilityFilteredReason,
  resolveNodeCompatibilityProfiles,
} from '../catalog/compatibility-profiles';

export interface RouteDecision {
  primary: RouteTarget;
  fallbacks: RouteTarget[];
  tier: Tier;
  score: number;
  momentumAdjusted: boolean;
  domainHint: 'frontend' | 'backend' | null;
  experimentGroup: string | null;  // A/B split: "tier:variantName" format, null when no split
  experimentGroupsByTarget: Record<string, string>;
  loadBalancing: RouteLoadBalancingDecision;
  trace: RouteDecisionTrace;
}

export type EffectiveRoutingStrategy =
  | LoadBalancingStrategy
  | RoutingOptimization
  | 'primary_fallback'
  | 'split';

export interface RouteLoadBalancingDecision {
  strategy: EffectiveRoutingStrategy;
  source: 'primary_fallback' | 'targets' | 'split';
  selected: RouteTarget;
  target_count: number;
}

export interface RouteTargetMetrics {
  node: string;
  model: string;
  weight: number | null;
  samples: number;
  avg_latency_ms: number | null;
  p95_latency_ms: number | null;
  last_latency_ms: number | null;
  last_status_code: number | null;
}

export interface RoutingTierStatus {
  strategy: EffectiveRoutingStrategy;
  source: 'primary_fallback' | 'targets' | 'split';
  targets: RouteTargetMetrics[];
  last_selected: {
    node: string;
    model: string;
    selected_at: string;
    strategy: EffectiveRoutingStrategy;
    reason: string;
  } | null;
}

export interface RouteSelectionHints {
  estimated_input_tokens?: number;
  estimated_output_tokens?: number;
  estimated_context_tokens?: number;
  requires_structured_output?: boolean;
  requires_reasoning?: boolean;
  reasoning_effort?: string | null;
  reasoning_budget_tokens?: number | null;
  reasoning_strategy?: string | null;
  requested_modality?: string | null;
  input_types?: string[];
  output_types?: string[];
  file_count?: number | null;
  byte_size?: number | null;
  required_capabilities?: string[];
  endpoint_strategy?: string | null;
  source_format?: string | null;
  local_prompt_cache_eligible?: boolean;
  local_prompt_cache_hit?: boolean;
  local_prompt_cache_lookup?: 'hit' | 'miss' | 'disabled' | 'skipped' | null;
  semantic_cache_enabled?: boolean;
  semantic_cache_match?: boolean;
  semantic_cache_hit?: boolean;
  semantic_cache_score?: number | null;
  semantic_cache_threshold?: number | null;
  semantic_cache_metadata_only?: boolean;
  semantic_cache_reason?: string | null;
  semantic_intent?: string | null;
  semantic_intent_confidence?: number | null;
  semantic_capabilities?: string[];
  stream?: boolean;
  multipart?: boolean;
  workspace_id?: string | null;
}

export interface EmbeddingRouteDecision {
  primary: RouteTarget;
  fallbacks: RouteTarget[];
  mode: 'auto' | 'direct';
  trace?: RouteDecisionTrace;
}

export interface RerankRouteDecision {
  primary: RouteTarget;
  fallbacks: RouteTarget[];
  mode: 'auto' | 'direct';
  trace?: RouteDecisionTrace;
}

export interface MediaRouteDecision {
  primary: RouteTarget;
  fallbacks: RouteTarget[];
  mode: 'auto' | 'direct';
  trace?: RouteDecisionTrace;
}

interface SelectedRouteTarget {
  target: WeightedRouteTarget;
  strategy: EffectiveRoutingStrategy;
}

export class RoutingConstraintError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 400,
  ) {
    super(message);
    this.name = 'RoutingConstraintError';
  }
}

/**
 * FNV-1a 32-bit hash — deterministic, fast, no dependencies.
 * Used for A/B split bucket assignment (session stickiness).
 */
function fnv1a32(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

@Injectable()
export class RoutingService {
  private readonly logger = new Logger(RoutingService.name);
  private readonly roundRobinCounters = new Map<string, number>();
  private readonly latencyWindows = new Map<string, number[]>();
  private readonly targetLastStatus = new Map<string, {
    latencyMs: number;
    statusCode: number;
  }>();
  private readonly targetCacheStats = new Map<string, {
    calls: number;
    cacheReadCalls: number;
    cacheWriteCalls: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
  }>();
  private readonly lastSelections = new Map<string, RoutingTierStatus['last_selected']>();
  private readonly latencyWindowSize = 50;

  constructor(
    private readonly config: ConfigService,
    private readonly capabilityService: CapabilityService,
    private readonly circuitBreaker: CircuitBreakerService,
    private readonly momentum: MomentumService,
    private readonly cacheAffinityService: CacheAffinityService,
    @Optional() private readonly pricingRuntime?: PricingRuntimeService,
  ) {}

  /**
   * Resolve a route for a given tier + score.
   *
   * 1. Apply momentum smoothing (if session key provided)
   * 2. Look up tier config for primary + fallbacks
   * 3. Filter out nodes with OPEN circuit breaker
   * 3.5. Modality-aware filtering
   * 4. Apply domain hint adjustments (config preference → tag fallback)
   * 5. Build final route
   */
  resolve(
    tier: Tier,
    score: number,
    sessionKey?: string,
    domainHint?: 'frontend' | 'backend' | null,
    modalityHints?: Modality[],
    selectionHints: RouteSelectionHints = {},
  ): RouteDecision {
    const hint = domainHint || null;

    const scopedSessionKey = this.momentum.scopedSessionKey(
      sessionKey,
      selectionHints.workspace_id,
    );

    // ── Step 1: Momentum smoothing ──
    const { tier: effectiveTier, adjusted } = this.momentum.apply(
      tier,
      score,
      scopedSessionKey,
    );

    // ── Step 2: Get tier config ──
    const tierConfig = this.config.routing.tiers[effectiveTier];
    if (!tierConfig) {
      const firstTier = Object.keys(this.config.routing.tiers)[0];
      this.logger.warn(
        `No config for tier "${effectiveTier}", falling back to "${firstTier}"`,
      );
      const fallbackConfig = this.config.routing.tiers[firstTier];
      const modalityCompatibleTargets = this.filterTargetsByModalities(
        effectiveTier,
        this.normalizeTierTargets(fallbackConfig).targets,
        modalityHints,
      );
      const profileCompatibleTargets = this.filterTargetsByCompatibilityProfiles(
        effectiveTier,
        modalityCompatibleTargets,
        selectionHints,
      );
      const fallbackTargets = this.applyCapabilityConstraints(
        effectiveTier,
        profileCompatibleTargets,
        selectionHints,
      );
      const selected = fallbackTargets[0];
      const loadBalancing = {
        strategy: 'primary_fallback' as EffectiveRoutingStrategy,
        source: 'primary_fallback' as const,
        selected,
        target_count: fallbackTargets.length,
      };
      return {
        primary: selected,
        fallbacks: fallbackTargets.slice(1).map((target) => this.toRouteTarget(target)),
        tier: effectiveTier,
        score,
        momentumAdjusted: adjusted,
        domainHint: hint,
        experimentGroup: null,
        experimentGroupsByTarget: {},
        loadBalancing,
        trace: this.buildRouteTrace({
          mode: 'auto',
          requestedTier: tier,
          effectiveTier,
          score,
          momentumAdjusted: adjusted,
          domainHint: hint,
          modalityHints,
          selectionHints,
          initialTargets: this.normalizeTierTargets(fallbackConfig).targets,
          finalTargets: fallbackTargets,
          selected,
          sessionKey: scopedSessionKey,
          loadBalancing,
          reason: `tier "${effectiveTier}" missing; fell back to "${firstTier}"`,
        }),
      };
    }

    // ── Step 2.5: A/B split — override targets if split is configured ──
    let experimentGroup: string | null = null;

    if (tierConfig.split && tierConfig.split.length > 0) {
      const splitResult = this.resolveABSplit(
        tierConfig.split, effectiveTier, scopedSessionKey,
      );
      // Use split-derived targets for Steps 3+
      const splitAllTargets = splitResult.orderedTargets;

      // Filter by circuit breaker
      let splitAvailable = splitAllTargets.filter((t) =>
        this.circuitBreaker.isAvailable(t.node, t.model),
      );

      if (splitAvailable.length === 0) {
        this.logger.warn(
          `All split variants for tier "${effectiveTier}" have open circuits. Using all variants as last resort.`,
        );
        splitAvailable = splitAllTargets;
      }

      splitAvailable = this.filterTargetsByModalities(
        effectiveTier,
        splitAvailable,
        modalityHints,
      );
      splitAvailable = this.filterTargetsByCompatibilityProfiles(
        effectiveTier,
        splitAvailable,
        selectionHints,
      );

      // Domain hint reordering on split targets
      let splitOrdered = [...splitAvailable];
      if (hint && splitAvailable.length > 1) {
        const preferredNodes = this.resolvePreferredNodes(hint);
        if (preferredNodes.length > 0) {
          splitOrdered = this.reorderByPreference(splitAvailable, preferredNodes);
        }
      }

      splitOrdered = this.applyCapabilityConstraints(
        effectiveTier,
        splitOrdered,
        selectionHints,
      );

      experimentGroup = this.resolveExperimentGroupForTarget(
        splitResult.experimentGroupsByTarget,
        splitOrdered[0],
      );
      this.recordSelection(
        effectiveTier,
        splitOrdered[0],
        'split',
        'split',
        'A/B split experiment',
      );
      const loadBalancing = {
        strategy: 'split' as EffectiveRoutingStrategy,
        source: 'split' as const,
        selected: splitOrdered[0],
        target_count: splitOrdered.length,
      };

      return {
        primary: splitOrdered[0],
        fallbacks: splitOrdered.slice(1),
        tier: effectiveTier,
        score,
        momentumAdjusted: adjusted,
        domainHint: hint,
        experimentGroup,
        experimentGroupsByTarget: splitResult.experimentGroupsByTarget,
        loadBalancing,
        trace: this.buildRouteTrace({
          mode: 'auto',
          requestedTier: tier,
          effectiveTier,
          score,
          momentumAdjusted: adjusted,
          domainHint: hint,
          modalityHints,
          selectionHints,
          initialTargets: splitAllTargets,
          finalTargets: splitOrdered,
          selected: splitOrdered[0],
          sessionKey: scopedSessionKey,
          loadBalancing,
          reason: 'A/B split experiment',
        }),
      };
    }

    // ── Step 3: Normalize routing schema + filter by circuit breaker ──
    const normalized = this.normalizeTierTargets(tierConfig);
    let availableTargets = normalized.targets.filter((t) =>
      this.circuitBreaker.isAvailable(t.node, t.model),
    );

    if (availableTargets.length === 0) {
      this.logger.warn(
        `All nodes for tier "${effectiveTier}" have open circuits. Using all targets as last resort.`,
      );
      availableTargets = normalized.targets;
    }

    // ── Step 3.5: Modality-aware filtering ──
    availableTargets = this.filterTargetsByModalities(
      effectiveTier,
      availableTargets,
      modalityHints,
    );
    availableTargets = this.filterTargetsByCompatibilityProfiles(
      effectiveTier,
      availableTargets,
      selectionHints,
    );

    // ── Step 4: Apply domain hint reordering ──
    let orderedTargets = [...availableTargets];

    if (hint && normalized.source !== 'primary_fallback' && availableTargets.length > 1) {
      const preferredNodes = this.resolvePreferredNodes(hint);

      if (preferredNodes.length > 0) {
        orderedTargets = this.reorderByPreference(availableTargets, preferredNodes);

        if (orderedTargets[0].node !== availableTargets[0].node) {
          this.logger.log(
            `Domain hint "${hint}": promoted node "${orderedTargets[0].node}" over "${availableTargets[0].node}"`,
          );
        }
      }
    }

    orderedTargets = this.applyCapabilityConstraints(
      effectiveTier,
      orderedTargets,
      selectionHints,
    );

    // ── Step 5: Apply load-balancing strategy and build final route ──
    const selection = this.selectTargetByStrategy(
      effectiveTier,
      normalized.strategy,
      orderedTargets,
      scopedSessionKey,
      selectionHints,
    );
    const primary = selection.target;
    const fallbacks = orderedTargets
      .filter((target) => target !== primary)
      .map((target) => this.toRouteTarget(target));

    if (tierConfig.primary && primary.node !== tierConfig.primary.node && !hint) {
      this.logger.log(
        `Primary node "${tierConfig.primary.node}" unavailable (circuit OPEN), promoting "${primary.node}"`,
      );
    }

    this.recordSelection(
      effectiveTier,
      primary,
      selection.strategy,
      normalized.source,
      this.selectionReason(selection.strategy, primary, scopedSessionKey, selectionHints),
    );

    const loadBalancing = {
      strategy: selection.strategy,
      source: normalized.source,
      selected: this.toRouteTarget(primary),
      target_count: orderedTargets.length,
    };

    return {
      primary: this.toRouteTarget(primary),
      fallbacks,
      tier: effectiveTier,
      score,
      momentumAdjusted: adjusted,
      domainHint: hint,
      experimentGroup: null,
      experimentGroupsByTarget: {},
      loadBalancing,
      trace: this.buildRouteTrace({
        mode: 'auto',
        requestedTier: tier,
        effectiveTier,
        score,
        momentumAdjusted: adjusted,
        domainHint: hint,
        modalityHints,
        selectionHints,
        initialTargets: normalized.targets,
        finalTargets: orderedTargets,
        selected: this.toRouteTarget(primary),
        sessionKey: scopedSessionKey,
        loadBalancing,
        reason: this.selectionReason(
          selection.strategy,
          primary,
          scopedSessionKey,
          selectionHints,
        ),
      }),
    };
  }

  recordTargetResult(
    node: string,
    model: string,
    latencyMs: number,
    statusCode: number,
  ): void {
    const key = this.buildExperimentTargetKey(node, model);
    this.targetLastStatus.set(key, { latencyMs, statusCode });
    if (statusCode < 200 || statusCode >= 400 || latencyMs < 0) return;

    const samples = this.latencyWindows.get(key) || [];
    samples.push(latencyMs);
    if (samples.length > this.latencyWindowSize) {
      samples.splice(0, samples.length - this.latencyWindowSize);
    }
    this.latencyWindows.set(key, samples);
  }

  recordTargetUsage(
    node: string,
    model: string,
    usage: Pick<TokenUsage, 'cache_read_input_tokens' | 'cache_creation_input_tokens'> | undefined,
  ): void {
    if (!usage || node === 'cache' || node === 'hook') return;
    const key = this.buildExperimentTargetKey(node, model);
    const current = this.targetCacheStats.get(key) || {
      calls: 0,
      cacheReadCalls: 0,
      cacheWriteCalls: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    };
    const readTokens = Math.max(0, Number(usage.cache_read_input_tokens || 0));
    const creationTokens = Math.max(0, Number(usage.cache_creation_input_tokens || 0));
    current.calls += 1;
    if (readTokens > 0) current.cacheReadCalls += 1;
    if (creationTokens > 0) current.cacheWriteCalls += 1;
    current.cacheReadTokens += readTokens;
    current.cacheCreationTokens += creationTokens;
    this.targetCacheStats.set(key, current);
  }

  recordSessionRouteResult(
    sessionKey: string | undefined,
    node: string,
    model: string,
    usage: Pick<TokenUsage, 'cache_read_input_tokens'> | undefined,
    workspaceId?: string | null,
  ): void {
    this.cacheAffinityService.recordRouteResult(
      sessionKey,
      node,
      model,
      usage,
      { workspaceId },
    );
  }

  resolveEmbeddingRoute(
    requestedModel: string | undefined,
    dimensions?: number,
    targetFilter: (target: RouteTarget) => boolean = () => true,
  ): EmbeddingRouteDecision {
    const model = requestedModel || 'auto';
    const allTargets = this.getEmbeddingTargets();
    const selectionHints = this.embeddingSelectionHints(dimensions);

    if (model !== 'auto') {
      const resolved = this.config.resolveEmbeddingModel(model);
      if (!resolved) {
        throw new RoutingConstraintError(
          `Embedding model "${model}" is not configured. Use "auto" or configure nodes[].embedding_models.`,
          400,
        );
      }
      const primary = { node: resolved.nodeId, model: resolved.model };
      if (!targetFilter(primary)) {
        throw new RoutingConstraintError(
          `This API key is not allowed to use ${primary.node}/${primary.model}.`,
          403,
        );
      }
      this.assertTargetCompatibility(primary, selectionHints);
      if (!this.embeddingDimensionsCompatible(primary, dimensions)) {
        throw new RoutingConstraintError(
          `Embedding model ${primary.node}/${primary.model} does not advertise support for dimensions=${dimensions}.`,
          400,
        );
      }
      const fallbacks = this.rankEmbeddingTargets(
        this.filterEmbeddingTargets(
          allTargets.filter((target) =>
            target.node !== primary.node || target.model !== primary.model,
          ),
          dimensions,
          targetFilter,
        ),
      );
      return {
        primary,
        fallbacks,
        mode: 'direct',
        trace: this.buildRouteTrace({
          mode: 'embedding_direct',
          requestedTier: 'direct',
          effectiveTier: 'direct',
          score: 0,
          momentumAdjusted: false,
          domainHint: null,
          modalityHints: ['embedding'],
          selectionHints,
          initialTargets: allTargets,
          finalTargets: [primary, ...fallbacks],
          selected: primary,
          loadBalancing: {
            strategy: 'primary_fallback',
            source: 'embedding',
            selected: primary,
            target_count: 1 + fallbacks.length,
          },
          reason: 'direct embedding model match',
        }),
      };
    }

    const candidates = this.rankEmbeddingTargets(
      this.filterEmbeddingTargets(allTargets, dimensions, targetFilter),
    );
    if (candidates.length === 0) {
      throw new RoutingConstraintError(
        dimensions
          ? `No configured embedding model can satisfy dimensions=${dimensions}.`
          : 'No embedding models are configured.',
        400,
      );
    }

    return {
      primary: candidates[0],
      fallbacks: candidates.slice(1),
      mode: 'auto',
      trace: this.buildRouteTrace({
        mode: 'embedding_auto',
        requestedTier: 'standard',
        effectiveTier: 'standard',
        score: 0,
          momentumAdjusted: false,
          domainHint: null,
          modalityHints: ['embedding'],
          selectionHints,
          initialTargets: allTargets,
          finalTargets: candidates,
        selected: candidates[0],
        loadBalancing: {
          strategy: 'cost',
          source: 'embedding',
          selected: candidates[0],
          target_count: candidates.length,
        },
        reason: dimensions
          ? `embedding capability and dimensions=${dimensions}`
          : 'embedding capability and lowest configured input cost',
      }),
    };
  }

  resolveRerankRoute(
    requestedModel: string | undefined,
    targetFilter: (target: RouteTarget) => boolean = () => true,
    selectionHints: RouteSelectionHints = this.rerankSelectionHints(),
  ): RerankRouteDecision {
    const model = requestedModel || 'auto';
    const allTargets = this.getRerankTargets();
    const evidenceHints = this.withDefaultRerankSelectionHints(selectionHints);

    if (model !== 'auto') {
      const resolved = this.config.resolveRerankModel(model);
      if (!resolved) {
        throw new RoutingConstraintError(
          `Rerank model "${model}" is not configured. Use "auto" or configure nodes[].rerank_models.`,
          400,
        );
      }
      const primary = { node: resolved.nodeId, model: resolved.model };
      if (!targetFilter(primary)) {
        throw new RoutingConstraintError(
          `This API key is not allowed to use ${primary.node}/${primary.model}.`,
          403,
        );
      }
      this.assertTargetCompatibility(primary, evidenceHints);
      const fallbacks = this.rankRerankTargets(
        this.filterRerankTargets(
          allTargets.filter((target) =>
            target.node !== primary.node || target.model !== primary.model,
          ),
          targetFilter,
        ),
      );
      return {
        primary,
        fallbacks,
        mode: 'direct',
        trace: this.buildRouteTrace({
          mode: 'rerank_direct',
          requestedTier: 'direct',
          effectiveTier: 'direct',
          score: 0,
          momentumAdjusted: false,
          domainHint: null,
          modalityHints: ['rerank'],
          selectionHints: evidenceHints,
          initialTargets: allTargets,
          finalTargets: [primary, ...fallbacks],
          selected: primary,
          loadBalancing: {
            strategy: 'rerank',
            source: 'rerank',
            selected: primary,
            target_count: 1 + fallbacks.length,
          },
          reason: 'direct rerank model match',
        }),
      };
    }

    const candidates = this.rankRerankTargets(
      this.filterRerankTargets(allTargets, targetFilter),
    );
    if (candidates.length === 0) {
      throw new RoutingConstraintError(
        'No rerank models are configured.',
        400,
      );
    }

    return {
      primary: candidates[0],
      fallbacks: candidates.slice(1),
      mode: 'auto',
      trace: this.buildRouteTrace({
        mode: 'rerank_auto',
        requestedTier: 'standard',
        effectiveTier: 'standard',
        score: 0,
        momentumAdjusted: false,
        domainHint: null,
        modalityHints: ['rerank'],
        selectionHints: evidenceHints,
        initialTargets: allTargets,
        finalTargets: candidates,
        selected: candidates[0],
        loadBalancing: {
          strategy: 'rerank',
          source: 'rerank',
          selected: candidates[0],
          target_count: candidates.length,
        },
        reason: 'rerank capability and lowest configured input cost',
      }),
    };
  }

  resolveMediaRoute(
    sourceFormat: CanonicalMediaSourceFormat,
    requestedModel: string | undefined,
    targetFilter: (target: RouteTarget) => boolean = () => true,
    selectionHints: RouteSelectionHints = this.mediaSelectionHints(sourceFormat),
  ): MediaRouteDecision {
    const model = requestedModel || 'auto';
    const kind = this.mediaKind(sourceFormat);
    const allTargets = this.getMediaTargets(kind);
    const evidenceHints = this.withDefaultMediaSelectionHints(sourceFormat, selectionHints);

    if (model !== 'auto') {
      const resolved =
        kind === 'image'
          ? this.config.resolveImageModel(model)
          : kind === 'audio'
            ? this.config.resolveAudioModel(model)
            : this.config.resolveVideoModel(model);
      if (!resolved) {
        throw new RoutingConstraintError(
          `${kind === 'image' ? 'Image' : kind === 'audio' ? 'Audio' : 'Video'} model "${model}" is not configured. Use "auto" or configure nodes[].${kind}_models.`,
          400,
        );
      }
      const primary = { node: resolved.nodeId, model: resolved.model };
      if (!targetFilter(primary)) {
        throw new RoutingConstraintError(
          `This API key is not allowed to use ${primary.node}/${primary.model}.`,
          403,
        );
      }
      this.assertTargetCompatibility(primary, evidenceHints);
      const fallbacks = this.rankMediaTargets(
        this.filterMediaTargets(
          allTargets.filter((target) =>
            target.node !== primary.node || target.model !== primary.model,
          ),
          targetFilter,
          evidenceHints,
        ),
      );
      return {
        primary,
        fallbacks,
        mode: 'direct',
        trace: this.buildRouteTrace({
          mode: 'media_direct',
          requestedTier: 'direct',
          effectiveTier: 'direct',
          score: 0,
          momentumAdjusted: false,
          domainHint: null,
          modalityHints: [kind],
          selectionHints: evidenceHints,
          initialTargets: allTargets,
          finalTargets: [primary, ...fallbacks],
          selected: primary,
          loadBalancing: {
            strategy: 'media',
            source: 'media',
            selected: primary,
            target_count: 1 + fallbacks.length,
          },
          reason: `direct ${kind} model match`,
        }),
      };
    }

    const candidates = this.rankMediaTargets(
      this.filterMediaTargets(allTargets, targetFilter, evidenceHints),
    );
    if (candidates.length === 0) {
      throw new RoutingConstraintError(
        `No ${kind} models are configured.`,
        400,
      );
    }

    return {
      primary: candidates[0],
      fallbacks: candidates.slice(1),
      mode: 'auto',
      trace: this.buildRouteTrace({
        mode: 'media_auto',
        requestedTier: 'standard',
        effectiveTier: 'standard',
        score: 0,
        momentumAdjusted: false,
        domainHint: null,
        modalityHints: [kind],
        selectionHints: evidenceHints,
        initialTargets: allTargets,
        finalTargets: candidates,
        selected: candidates[0],
        loadBalancing: {
          strategy: 'media',
          source: 'media',
          selected: candidates[0],
          target_count: candidates.length,
        },
        reason: `${kind} capability and lowest configured input cost`,
      }),
    };
  }

  getRoutingStatus(): Record<string, RoutingTierStatus> {
    const result: Record<string, RoutingTierStatus> = {};
    for (const [tier, tierConfig] of Object.entries(this.config.routing.tiers || {})) {
      const normalized = tierConfig.split?.length
        ? {
            strategy: 'split' as EffectiveRoutingStrategy,
            source: 'split' as const,
            targets: tierConfig.split.map((variant) => ({
              node: variant.node,
              model: variant.model,
              weight: variant.weight,
              name: variant.name,
            })),
          }
        : this.normalizeTierTargets(tierConfig);
      const effectiveStrategy =
        normalized.source === 'split'
          ? normalized.strategy
          : this.config.routing.optimization || normalized.strategy;

      result[tier] = {
        strategy: effectiveStrategy,
        source: normalized.source,
        targets: normalized.targets.map((target) => this.buildTargetMetrics(target)),
        last_selected: this.lastSelections.get(tier) || null,
      };
    }
    return result;
  }

  private normalizeTierTargets(tierConfig: TierConfig): {
    targets: WeightedRouteTarget[];
    strategy: EffectiveRoutingStrategy;
    source: 'primary_fallback' | 'targets';
  } {
    if (tierConfig.targets && tierConfig.targets.length > 0) {
      return {
        targets: tierConfig.targets.map((target) => ({ ...target, weight: target.weight ?? 1 })),
        strategy: tierConfig.strategy || 'weighted',
        source: 'targets',
      };
    }

    const legacyTargets = [
      tierConfig.primary,
      ...(tierConfig.fallbacks || []),
    ].filter(Boolean).map((target) => ({
      ...(target as RouteTarget),
      weight: 1,
    }));

    return {
      targets: legacyTargets,
      strategy: 'primary_fallback',
      source: 'primary_fallback',
    };
  }

  private selectTargetByStrategy(
    tier: string,
    strategy: EffectiveRoutingStrategy,
    targets: WeightedRouteTarget[],
    sessionKey?: string,
    selectionHints: RouteSelectionHints = {},
  ): SelectedRouteTarget {
    if (targets.length === 0) {
      throw new Error(`No route targets available for tier "${tier}"`);
    }
    if (targets.length === 1 || strategy === 'split') {
      return { target: targets[0], strategy };
    }

    const contextPreferred = this.selectContextPreferredTarget(
      targets,
      selectionHints,
    );
    if (contextPreferred) {
      return { target: contextPreferred, strategy };
    }

    const optimization = this.config.routing.optimization;
    if (optimization) {
      const optimizedTarget = this.selectTargetByOptimization(
        optimization,
        targets,
        sessionKey,
        selectionHints,
      );
      if (optimizedTarget) {
        return { target: optimizedTarget, strategy: optimization };
      }
    }

    if (strategy === 'primary_fallback') {
      return { target: targets[0], strategy };
    }

    switch (strategy) {
      case 'round_robin':
        return { target: this.selectRoundRobin(tier, targets), strategy };
      case 'least_latency':
        return {
          target: this.selectLeastLatency(targets, sessionKey, selectionHints),
          strategy,
        };
      case 'random':
        return {
          target: targets[Math.floor(Math.random() * targets.length)] || targets[0],
          strategy,
        };
      case 'weighted':
      default:
        return { target: this.selectWeighted(tier, targets, sessionKey), strategy };
    }
  }

  private selectTargetByOptimization(
    optimization: RoutingOptimization,
    targets: WeightedRouteTarget[],
    sessionKey: string | undefined,
    selectionHints: RouteSelectionHints,
  ): WeightedRouteTarget | null {
    switch (optimization) {
      case 'cost':
        return this.selectLowestCost(targets, sessionKey, selectionHints);
      case 'latency':
        return this.selectLeastLatency(targets, sessionKey, selectionHints);
      case 'balanced':
        return this.selectBalanced(targets, sessionKey, selectionHints);
      case 'quality':
        return this.selectHighestQuality(targets);
      default:
        return null;
    }
  }

  private selectContextPreferredTarget(
    targets: WeightedRouteTarget[],
    selectionHints: RouteSelectionHints,
  ): WeightedRouteTarget | null {
    const estimatedContextTokens = selectionHints.estimated_context_tokens;
    if (!estimatedContextTokens || estimatedContextTokens <= 0) return null;

    const safe: WeightedRouteTarget[] = [];
    const unknown: WeightedRouteTarget[] = [];
    let nearLimitCount = 0;

    for (const target of targets) {
      const maxContextTokens =
        this.capabilityService.resolveModelRoutingCapabilities(
          target.node,
          target.model,
        ).max_context_tokens;
      if (!maxContextTokens) {
        unknown.push(target);
      } else if (estimatedContextTokens > maxContextTokens * 0.8) {
        nearLimitCount++;
      } else {
        safe.push(target);
      }
    }

    if (nearLimitCount === 0) return null;
    return safe[0] || unknown[0] || null;
  }

  private selectLowestCost(
    targets: WeightedRouteTarget[],
    sessionKey: string | undefined,
    selectionHints: RouteSelectionHints,
  ): WeightedRouteTarget | null {
    const priced = targets
      .map((target, index) => ({
        target,
        index,
        cost: this.estimateTargetCost(target, selectionHints),
        affinityBonus: this.affinityBonusForTarget(
          target,
          sessionKey,
          selectionHints.workspace_id,
        ),
      }))
      .filter((item) => item.cost !== null);

    if (priced.length === 0) return null;

    const costs = priced.map((item) => item.cost as number);
    const minCost = Math.min(...costs);
    const maxCost = Math.max(...costs);
    priced.sort((a, b) => {
      const aScore =
        this.normalizeMetric(a.cost, minCost, maxCost) - a.affinityBonus;
      const bScore =
        this.normalizeMetric(b.cost, minCost, maxCost) - b.affinityBonus;
      if (aScore !== bScore) return aScore - bScore;
      if (a.cost !== b.cost) return (a.cost as number) - (b.cost as number);
      return a.index - b.index;
    });
    return priced[0].target;
  }

  private selectBalanced(
    targets: WeightedRouteTarget[],
    sessionKey: string | undefined,
    selectionHints: RouteSelectionHints,
  ): WeightedRouteTarget | null {
    const entries = targets.map((target, index) => ({
      target,
      index,
      cost: this.estimateTargetCost(target, selectionHints),
      latency: this.averageLatency(target.node, target.model),
      cacheScore: this.estimateCacheScore(target, selectionHints),
      affinityBonus: this.affinityBonusForTarget(
        target,
        sessionKey,
        selectionHints.workspace_id,
      ),
    }));
    const costs = entries
      .map((entry) => entry.cost)
      .filter((value): value is number => value !== null);
    const latencies = entries
      .map((entry) => entry.latency)
      .filter((value): value is number => value !== null);
    const cacheScores = entries
      .map((entry) => entry.cacheScore)
      .filter((value): value is number => value !== null);

    if (costs.length === 0 && latencies.length === 0 && cacheScores.length === 0) return null;

    const minCost = costs.length ? Math.min(...costs) : 0;
    const maxCost = costs.length ? Math.max(...costs) : 0;
    const minLatency = latencies.length ? Math.min(...latencies) : 0;
    const maxLatency = latencies.length ? Math.max(...latencies) : 0;

    const cacheAware = cacheScores.length > 0;
    const normalized = entries.map((entry) => {
      const costWeight = cacheAware ? 0.55 : 0.6;
      const latencyWeight = cacheAware ? 0.35 : 0.4;
      const cachePenalty = cacheAware ? 1 - (entry.cacheScore ?? 0) : 0;
      return {
        ...entry,
        score:
          this.normalizeMetric(entry.cost, minCost, maxCost) * costWeight +
          this.normalizeMetric(entry.latency, minLatency, maxLatency) * latencyWeight +
          cachePenalty * (cacheAware ? 0.1 : 0) -
          entry.affinityBonus,
      };
    });

    normalized.sort((a, b) => {
      if (a.score !== b.score) return a.score - b.score;
      return a.index - b.index;
    });
    return normalized[0].target;
  }

  private selectHighestQuality(
    targets: WeightedRouteTarget[],
  ): WeightedRouteTarget | null {
    const scored = targets
      .map((target, index) => ({
        target,
        index,
        quality:
          this.capabilityService.resolveModelRoutingCapabilities(
            target.node,
            target.model,
          ).quality_score ?? null,
      }))
      .filter((item) => item.quality !== null);

    if (scored.length === 0) return null;

    scored.sort((a, b) => {
      if (a.quality !== b.quality) return (b.quality as number) - (a.quality as number);
      return a.index - b.index;
    });
    return scored[0].target;
  }

  private estimateTargetCost(
    target: RouteTarget,
    selectionHints: RouteSelectionHints,
  ): number | null {
    const frozen = this.pricingRuntime?.estimate({ node_id: target.node, model: target.model }, selectionHints.estimated_input_tokens ?? 1_000_000, selectionHints.estimated_output_tokens ?? 1_000_000);
    if (frozen) return frozen.report_amount === null ? null : Number(frozen.report_amount);
    const pricing = this.capabilityService.resolveModelRoutingCapabilities?.(
      target.node,
      target.model,
    )?.pricing;
    if (!pricing) return null;

    const inputTokens = selectionHints.estimated_input_tokens ?? 1_000_000;
    const outputTokens = selectionHints.estimated_output_tokens ?? 1_000_000;
    const evidence = this.buildCacheEvidence(target, undefined, selectionHints);
    return evidence.estimated_cache_adjusted_cost_usd ?? (
      (inputTokens / 1_000_000) * pricing.input +
      (outputTokens / 1_000_000) * pricing.output
    );
  }

  private estimateCacheScore(
    target: RouteTarget,
    selectionHints: RouteSelectionHints,
  ): number | null {
    return this.buildCacheEvidence(target, undefined, selectionHints).cache_score;
  }

  private buildCacheEvidence(
    target: RouteTarget,
    sessionKey: string | undefined,
    selectionHints: RouteSelectionHints,
  ): RouteDecisionCacheEvidence {
    const capabilities =
      this.capabilityService.resolveModelRoutingCapabilities?.(
        target.node,
        target.model,
      ) || {};
    const circuitState =
      this.circuitBreaker.getCircuitState?.(target.node, target.model) || 'CLOSED';
    const cacheAffinity = this.resolveCacheAffinity(
      target,
      sessionKey,
      capabilities,
      circuitState,
      selectionHints.workspace_id,
    );
    const pricing = capabilities.pricing;
    const stats = this.targetCacheStats.get(
      this.buildExperimentTargetKey(target.node, target.model),
    );
    const observedHitRate =
      stats && stats.calls > 0
        ? Number((stats.cacheReadCalls / stats.calls).toFixed(4))
        : null;
    const providerReadCache = Boolean(
      capabilities.read_cache ||
      capabilities.prompt_cache ||
      pricing?.cache_read_input !== undefined ||
      pricing?.cache_read_per_1m_tokens !== undefined,
    );
    const providerWriteCache = Boolean(
      capabilities.write_cache ||
      capabilities.prompt_cache ||
      pricing?.cache_creation_input !== undefined ||
      pricing?.cache_write_per_1m_tokens !== undefined,
    );
    const providerPromptCache = Boolean(
      capabilities.prompt_cache ||
      providerReadCache ||
      providerWriteCache,
    );
    const localEligible = selectionHints.local_prompt_cache_eligible === true;
    const localHit = selectionHints.local_prompt_cache_hit === true;
    const inputTokens = selectionHints.estimated_input_tokens ?? 1_000_000;
    const outputTokens = selectionHints.estimated_output_tokens ?? 1_000_000;
    const baseCost =
      pricing && Number.isFinite(pricing.input) && Number.isFinite(pricing.output)
        ? (inputTokens / 1_000_000) * pricing.input +
          (outputTokens / 1_000_000) * pricing.output
        : null;
    const supportsDiscountedRead =
      providerReadCache &&
      (pricing?.cache_read_input !== undefined ||
        pricing?.cache_read_per_1m_tokens !== undefined) &&
      (pricing.cache_read_input ?? pricing.cache_read_per_1m_tokens ?? pricing.input) <
        pricing.input;
    const priorHitRate =
      observedHitRate !== null
        ? observedHitRate
        : supportsDiscountedRead && localEligible
          ? 0.05
          : supportsDiscountedRead
            ? 0.02
            : 0;
    const adjustedCost =
      pricing && baseCost !== null && supportsDiscountedRead
        ? (inputTokens / 1_000_000) *
            (priorHitRate *
              ((pricing.cache_read_input ??
                pricing.cache_read_per_1m_tokens ??
                pricing.input) as number) +
              (1 - priorHitRate) * pricing.input) +
          (outputTokens / 1_000_000) * pricing.output
        : baseCost;
    const savings =
      baseCost !== null && adjustedCost !== null
        ? Math.max(0, baseCost - adjustedCost)
        : null;
    const cacheScore = providerPromptCache
      ? Math.min(
          1,
          0.35 +
            (providerReadCache ? 0.25 : 0) +
            (providerWriteCache ? 0.15 : 0) +
            Math.min(0.25, priorHitRate * 0.25),
        )
      : localHit
        ? 1
        : null;
    const reason = localHit
      ? 'local_prompt_cache_hit'
      : supportsDiscountedRead && (savings || 0) > 0
        ? 'provider_cache_read_price_preferred'
        : providerPromptCache
          ? 'provider_prompt_cache_capable'
          : localEligible
            ? 'local_prompt_cache_miss'
            : 'cache_not_applicable';

    return {
      local_prompt_cache_eligible: localEligible,
      local_prompt_cache_hit: localHit,
      local_prompt_cache_lookup: selectionHints.local_prompt_cache_lookup ?? null,
      provider_prompt_cache: providerPromptCache,
      provider_read_cache: providerReadCache,
      provider_write_cache: providerWriteCache,
      supports_cache: capabilities.supports_cache ?? providerPromptCache,
      cache_type: capabilities.cache_type ?? null,
      cache_min_tokens: capabilities.cache_min_tokens ?? null,
      cache_read_discount: capabilities.cache_read_discount ?? null,
      observed_cache_hit_rate: observedHitRate,
      observed_cache_read_tokens: stats?.cacheReadTokens ?? 0,
      observed_cache_creation_tokens: stats?.cacheCreationTokens ?? 0,
      input_price_per_mtok: pricing?.input ?? null,
      cache_read_price_per_mtok:
        pricing?.cache_read_input ?? pricing?.cache_read_per_1m_tokens ?? null,
      cache_write_price_per_mtok:
        pricing?.cache_creation_input ?? pricing?.cache_write_per_1m_tokens ?? null,
      estimated_base_cost_usd:
        baseCost === null ? null : Number(baseCost.toFixed(6)),
      estimated_cache_adjusted_cost_usd:
        adjustedCost === null ? null : Number(adjustedCost.toFixed(6)),
      estimated_cache_savings_usd:
        savings === null ? null : Number(savings.toFixed(6)),
      cache_score: cacheScore === null ? null : this.roundScore(cacheScore),
      cache_affinity_active: cacheAffinity.active,
      cache_affinity_reason: cacheAffinity.reason,
      cache_affinity_bonus: cacheAffinity.bonus || null,
      provider_cache_ttl_seconds: cacheAffinity.provider_cache_ttl_seconds,
      time_since_last_cache_hit_seconds:
        cacheAffinity.time_since_last_cache_hit_seconds,
      estimated_cache_hit_probability:
        cacheAffinity.estimated_cache_hit_probability,
      reason,
    };
  }

  private affinityBonusForTarget(
    target: RouteTarget,
    sessionKey: string | undefined,
    workspaceId?: string | null,
  ): number {
    return this.resolveCacheAffinity(
      target,
      sessionKey,
      undefined,
      undefined,
      workspaceId,
    ).bonus;
  }

  private resolveCacheAffinity(
    target: RouteTarget,
    sessionKey: string | undefined,
    capabilitiesInput?: ResolvedModelRoutingCapabilities,
    circuitStateInput?: string,
    workspaceId?: string | null,
  ): CacheAffinityResult {
    const capabilities =
      capabilitiesInput ||
      this.capabilityService.resolveModelRoutingCapabilities?.(
        target.node,
        target.model,
      ) ||
      {};
    const circuitState =
      circuitStateInput ||
      this.circuitBreaker.getCircuitState?.(target.node, target.model) ||
      'CLOSED';
    const affinity = this.cacheAffinityService.getCacheAffinity(
      sessionKey,
      target.node,
      target.model,
      capabilities,
      { workspaceId },
    );
    if (String(circuitState) === 'OPEN' && affinity.active) {
      return {
        ...affinity,
        active: false,
        bonus: 0,
        reason: 'circuit_open',
      };
    }
    return affinity;
  }

  private getEmbeddingTargets(): RouteTarget[] {
    const targets: RouteTarget[] = [];
    for (const node of this.config.nodes) {
      for (const model of node.embedding_models || []) {
        targets.push({ node: node.id, model });
      }
    }
    return targets;
  }

  private getRerankTargets(): RouteTarget[] {
    const targets: RouteTarget[] = [];
    for (const node of this.config.nodes) {
      for (const model of node.rerank_models || []) {
        targets.push({ node: node.id, model });
      }
    }
    return targets;
  }

  private mediaKind(sourceFormat: CanonicalMediaSourceFormat): 'image' | 'audio' | 'video' {
    if (sourceFormat === 'video_generation') return 'video';
    return (
      sourceFormat === 'image_generation' ||
      sourceFormat === 'image_edit' ||
      sourceFormat === 'image_variation'
    )
      ? 'image'
      : 'audio';
  }

  private getMediaTargets(kind: 'image' | 'audio' | 'video'): RouteTarget[] {
    const targets: RouteTarget[] = [];
    for (const node of this.config.nodes) {
      const models =
        kind === 'image'
          ? node.image_models
          : kind === 'audio'
            ? node.audio_models
            : node.video_models;
      for (const model of models || []) {
        targets.push({ node: node.id, model });
      }
    }
    return targets;
  }

  private filterMediaTargets(
    targets: RouteTarget[],
    targetFilter: (target: RouteTarget) => boolean,
    selectionHints: RouteSelectionHints = {},
  ): RouteTarget[] {
    const allowed = targets
      .filter(targetFilter)
      .filter((target) => this.circuitBreaker.isAvailable(target.node, target.model))
      .filter((target) => !this.targetCompatibilityReason(target, selectionHints));
    const byteSize = selectionHints.byte_size;
    if (byteSize === null || byteSize === undefined || byteSize <= 0) return allowed;

    const compatible = allowed.filter((target) => {
      const maxFileSize = this.capabilityService.resolveModelRoutingCapabilities(
        target.node,
        target.model,
      ).max_file_size;
      return !maxFileSize || byteSize <= maxFileSize;
    });
    return compatible.length > 0 ? compatible : allowed;
  }

  private rankMediaTargets(targets: RouteTarget[]): RouteTarget[] {
    return [...targets].sort((a, b) => {
      const aCost = this.estimateMediaCost(a);
      const bCost = this.estimateMediaCost(b);
      if (aCost !== bCost) return aCost - bCost;
      return targets.indexOf(a) - targets.indexOf(b);
    });
  }

  private estimateMediaCost(target: RouteTarget): number {
    const frozen = this.pricingRuntime?.estimate({ node_id: target.node, model: target.model }, 1000, 0);
    if (frozen) return frozen.report_amount === null ? Number.POSITIVE_INFINITY : Number(frozen.report_amount);
    const pricing = this.capabilityService.resolveModelRoutingCapabilities(
      target.node,
      target.model,
    ).pricing;
    return pricing ? pricing.input : Number.POSITIVE_INFINITY;
  }

  private filterEmbeddingTargets(
    targets: RouteTarget[],
    dimensions: number | undefined,
    targetFilter: (target: RouteTarget) => boolean,
  ): RouteTarget[] {
    const allowed = targets
      .filter(targetFilter)
      .filter((target) => this.circuitBreaker.isAvailable(target.node, target.model))
      .filter((target) =>
        !this.targetCompatibilityReason(target, this.embeddingSelectionHints(dimensions)),
      );
    if (!dimensions) return allowed;

    const exact = allowed.filter((target) =>
      this.embeddingDimensionsCompatible(target, dimensions, false),
    );
    if (exact.length > 0) return exact;

    return allowed.filter((target) =>
      this.embeddingDimensionsCompatible(target, dimensions, true),
    );
  }

  private embeddingDimensionsCompatible(
    target: RouteTarget,
    dimensions: number | undefined,
    allowUnknown = true,
  ): boolean {
    if (!dimensions) return true;
    const configured = this.capabilityService.resolveModelRoutingCapabilities(
      target.node,
      target.model,
    ).dimensions;
    if (configured === undefined) return allowUnknown;
    if (typeof configured === 'number') return configured === dimensions;
    return configured.includes(dimensions);
  }

  private rankEmbeddingTargets(targets: RouteTarget[]): RouteTarget[] {
    return [...targets].sort((a, b) => {
      const aCost = this.estimateEmbeddingCost(a);
      const bCost = this.estimateEmbeddingCost(b);
      if (aCost !== bCost) return aCost - bCost;
      return targets.indexOf(a) - targets.indexOf(b);
    });
  }

  private filterRerankTargets(
    targets: RouteTarget[],
    targetFilter: (target: RouteTarget) => boolean,
  ): RouteTarget[] {
    return targets
      .filter(targetFilter)
      .filter((target) => this.circuitBreaker.isAvailable(target.node, target.model))
      .filter((target) =>
        !this.targetCompatibilityReason(target, this.rerankSelectionHints()),
      );
  }

  private rankRerankTargets(targets: RouteTarget[]): RouteTarget[] {
    return [...targets].sort((a, b) => {
      const aCost = this.estimateRerankCost(a);
      const bCost = this.estimateRerankCost(b);
      if (aCost !== bCost) return aCost - bCost;
      return targets.indexOf(a) - targets.indexOf(b);
    });
  }

  private estimateRerankCost(target: RouteTarget): number {
    const frozen = this.pricingRuntime?.estimate({ node_id: target.node, model: target.model }, 1000, 0);
    if (frozen) return frozen.report_amount === null ? Number.POSITIVE_INFINITY : Number(frozen.report_amount);
    const pricing = this.capabilityService.resolveModelRoutingCapabilities(
      target.node,
      target.model,
    ).pricing;
    return pricing ? pricing.input : Number.POSITIVE_INFINITY;
  }

  private estimateEmbeddingCost(target: RouteTarget): number {
    const frozen = this.pricingRuntime?.estimate({ node_id: target.node, model: target.model }, 1000, 0);
    if (frozen) return frozen.report_amount === null ? Number.POSITIVE_INFINITY : Number(frozen.report_amount);
    const pricing = this.capabilityService.resolveModelRoutingCapabilities(
      target.node,
      target.model,
    ).pricing;
    return pricing ? pricing.input : Number.POSITIVE_INFINITY;
  }

  private normalizeMetric(
    value: number | null,
    min: number,
    max: number,
  ): number {
    if (value === null) return 1;
    if (max <= min) return 0;
    return (value - min) / (max - min);
  }

  private selectRoundRobin(
    tier: string,
    targets: WeightedRouteTarget[],
  ): WeightedRouteTarget {
    const index = this.roundRobinCounters.get(tier) || 0;
    const selected = targets[index % targets.length];
    this.roundRobinCounters.set(tier, index + 1);
    return selected;
  }

  private selectWeighted(
    tier: string,
    targets: WeightedRouteTarget[],
    sessionKey?: string,
  ): WeightedRouteTarget {
    const weights = targets.map((target) => Math.max(0, target.weight ?? 1));
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    if (total <= 0) return targets[0];

    const seed = sessionKey ? fnv1a32(`${tier}:${sessionKey}`) / 0xffffffff : Math.random();
    let bucket = seed * total;
    for (let i = 0; i < targets.length; i++) {
      bucket -= weights[i];
      if (bucket < 0) return targets[i];
    }
    return targets[targets.length - 1];
  }

  private selectLeastLatency(
    targets: WeightedRouteTarget[],
    sessionKey: string | undefined,
    selectionHints: RouteSelectionHints = {},
  ): WeightedRouteTarget {
    const entries = targets.map((target, index) => ({
      target,
      index,
      latency: this.averageLatency(target.node, target.model),
      affinityBonus: this.affinityBonusForTarget(
        target,
        sessionKey,
        selectionHints.workspace_id,
      ),
    }));
    const latencies = entries
      .map((entry) => entry.latency)
      .filter((value): value is number => value !== null);
    const minLatency = latencies.length ? Math.min(...latencies) : 0;
    const maxLatency = latencies.length ? Math.max(...latencies) : 0;

    return [...entries].sort((a, b) => {
      const aScore =
        (a.latency === null ? 0 : this.normalizeMetric(a.latency, minLatency, maxLatency)) -
        a.affinityBonus;
      const bScore =
        (b.latency === null ? 0 : this.normalizeMetric(b.latency, minLatency, maxLatency)) -
        b.affinityBonus;
      if (aScore !== bScore) return aScore - bScore;
      if (a.latency === null && b.latency !== null) return -1;
      if (a.latency !== null && b.latency === null) return 1;
      const aAvg = a.latency ?? Number.POSITIVE_INFINITY;
      const bAvg = b.latency ?? Number.POSITIVE_INFINITY;
      if (aAvg !== bAvg) return aAvg - bAvg;
      return a.index - b.index;
    })[0].target;
  }

  private buildTargetMetrics(target: WeightedRouteTarget): RouteTargetMetrics {
    const samples = this.getLatencySamples(target.node, target.model);
    const lastStatus = this.targetLastStatus.get(this.buildExperimentTargetKey(target.node, target.model));
    return {
      node: target.node,
      model: target.model,
      weight: target.weight ?? null,
      samples: samples.length,
      avg_latency_ms: this.average(samples),
      p95_latency_ms: this.percentile(samples, 0.95),
      last_latency_ms: lastStatus?.latencyMs ?? null,
      last_status_code: lastStatus?.statusCode ?? null,
    };
  }

  private recordSelection(
    tier: string,
    target: RouteTarget,
    strategy: EffectiveRoutingStrategy,
    source: 'primary_fallback' | 'targets' | 'split',
    reason: string,
  ): void {
    this.lastSelections.set(tier, {
      node: target.node,
      model: target.model,
      selected_at: new Date().toISOString(),
      strategy,
      reason: `${source}: ${reason}`,
    });
  }

  private selectionReason(
    strategy: EffectiveRoutingStrategy,
    target: RouteTarget,
    sessionKey: string | undefined,
    selectionHints: RouteSelectionHints = {},
  ): string {
    const cache = this.buildCacheEvidence(target, sessionKey, selectionHints);
    const affinityPrefix = cache.cache_affinity_active
      ? 'cache affinity kept the session on a recent provider-cache target; '
      : '';
    if (strategy === 'cost') {
      const cost = this.estimateTargetCost(target, selectionHints);
      if (cache.estimated_cache_savings_usd && cache.estimated_cache_savings_usd > 0) {
        return `${affinityPrefix}lowest cache-adjusted estimated cost (${cost?.toFixed(6)} USD)`;
      }
      return cost === null
        ? `${affinityPrefix}lowest configured cost`
        : `${affinityPrefix}lowest estimated cost (${cost.toFixed(6)} USD)`;
    }
    if (strategy === 'latency') {
      const avg = this.averageLatency(target.node, target.model);
      return avg === null
        ? `${affinityPrefix}latency optimization cold-start fallback`
        : `${affinityPrefix}lowest local average latency (${avg}ms)`;
    }
    if (strategy === 'balanced') {
      return `${affinityPrefix}balanced local cost, latency, cache-aware score, and cache affinity`;
    }
    if (strategy === 'quality') return 'highest configured quality score';
    if (strategy === 'least_latency') {
      const avg = this.averageLatency(target.node, target.model);
      return avg === null
        ? `${affinityPrefix}cold-start ordered fallback`
        : `${affinityPrefix}lowest local average latency (${avg}ms)`;
    }
    if (strategy === 'round_robin') return 'next round-robin slot';
    if (strategy === 'random') return 'random target';
    if (strategy === 'weighted') return 'weighted target selection';
    return 'legacy primary/fallback order';
  }

  private buildRouteTrace(input: {
    mode: RouteDecisionTrace['mode'];
    requestedTier: Tier;
    effectiveTier: Tier;
    score: number;
    momentumAdjusted: boolean;
    domainHint: string | null;
    sessionKey?: string;
    modalityHints?: Modality[] | string[];
    selectionHints: RouteSelectionHints;
    initialTargets: RouteTarget[];
    finalTargets: RouteTarget[];
    selected: RouteTarget | null;
    loadBalancing: {
      strategy: RouteDecisionTrace['load_balancing']['strategy'];
      source: RouteDecisionTrace['load_balancing']['source'];
      selected: RouteTarget | null;
      target_count: number;
    };
    reason: string;
  }): RouteDecisionTrace {
    const finalKeys = new Set(input.finalTargets.map(routeTargetKey));
    const selectedKey = input.selected ? routeTargetKey(input.selected) : null;
    const filters: RouteDecisionTraceFilter[] = [];

    const candidates = input.initialTargets.map((target, index) => {
      const reasons = this.inferFilterReasons(
        target,
        input.initialTargets,
        finalKeys.has(routeTargetKey(target)),
        input.modalityHints,
        input.selectionHints,
      );
      for (const reason of reasons) {
        filters.push({
          node: target.node,
          model: target.model,
          stage: this.filterStage(reason),
          reason,
        });
      }
      return this.buildTraceCandidate(
        target,
        index,
        routeTargetKey(target) === selectedKey,
        finalKeys.has(routeTargetKey(target)) && routeTargetKey(target) !== selectedKey,
        reasons,
        input.sessionKey,
        input.selectionHints,
      );
    });

    return {
      version: 1,
      mode: input.mode,
      tier: input.effectiveTier,
      score: input.score,
      domain_hints: {
        domain: input.domainHint,
        modalities: (input.modalityHints || []).map(String),
      },
      scoring: {
        tier: input.requestedTier,
        score: input.score,
        momentum_adjusted: input.momentumAdjusted,
      },
      constraints: {
        estimated_input_tokens: input.selectionHints.estimated_input_tokens ?? null,
        estimated_output_tokens: input.selectionHints.estimated_output_tokens ?? null,
        estimated_context_tokens: input.selectionHints.estimated_context_tokens ?? null,
        requires_structured_output: Boolean(input.selectionHints.requires_structured_output),
        requires_reasoning: Boolean(input.selectionHints.requires_reasoning),
        reasoning_effort: input.selectionHints.reasoning_effort ?? null,
        reasoning_budget_tokens: input.selectionHints.reasoning_budget_tokens ?? null,
        reasoning_strategy: input.selectionHints.reasoning_strategy ?? null,
        local_prompt_cache_eligible: Boolean(input.selectionHints.local_prompt_cache_eligible),
        local_prompt_cache_hit: Boolean(input.selectionHints.local_prompt_cache_hit),
        local_prompt_cache_lookup: input.selectionHints.local_prompt_cache_lookup ?? null,
      },
      modality_evidence: this.buildTraceModalityEvidence(
        input.selectionHints,
        input.modalityHints,
        candidates,
      ),
      cache_evidence: this.buildTraceCacheEvidence(input.selectionHints, candidates),
      candidate_targets: candidates,
      filters,
      load_balancing: {
        ...input.loadBalancing,
        reason: input.reason,
      },
      fallback_chain: input.finalTargets
        .filter((target) => routeTargetKey(target) !== selectedKey)
        .map((target) => this.toRouteTarget(target)),
      cost_downgrade: null,
      intelligence: undefined,
      final_selection: {
        node: input.selected?.node ?? null,
        model: input.selected?.model ?? null,
        reason: input.reason,
        is_fallback: false,
        fallback_reason: null,
      },
      privacy: {
        prompt: false,
        response: false,
        raw_headers: false,
        provider_keys: false,
      },
    };
  }

  private buildTraceCandidate(
    target: RouteTarget,
    index: number,
    selected: boolean,
    fallback: boolean,
    filterReasons: string[],
    sessionKey: string | undefined,
    selectionHints: RouteSelectionHints,
  ): RouteDecisionTraceCandidate {
    const capabilities =
      this.capabilityService.resolveModelRoutingCapabilities?.(
        target.node,
        target.model,
      ) || {};
    const estimatedCost = this.estimateTargetCost(target, selectionHints);
    const avgLatencyMs = this.averageLatency(target.node, target.model);
    const samples = this.getLatencySamples(target.node, target.model);
    const maxContextTokens = capabilities.max_context_tokens ?? null;
    const contextTokens = selectionHints.estimated_context_tokens;
    const contextFit = this.contextFit(contextTokens, maxContextTokens);
    const circuitState =
      this.circuitBreaker.getCircuitState?.(target.node, target.model) || 'CLOSED';
    const capabilityEvidence = this.buildCandidateCapabilityEvidence(
      target,
      selectionHints,
    );
    const cacheEvidence = this.buildCacheEvidence(
      target,
      sessionKey,
      selectionHints,
    );
    const compatibility = this.buildCompatibilityEvidence(
      target,
      selectionHints,
      selected,
      fallback || selected,
    );

    return {
      node: target.node,
      model: target.model,
      weight:
        'weight' in target && typeof target.weight === 'number'
          ? target.weight
          : null,
      position: index,
      circuit_state: String(circuitState),
      circuit_available: String(circuitState) !== 'OPEN',
      selected,
      fallback,
      filter_reasons: filterReasons,
      scores: {
        cost: estimatedCost === null ? null : this.roundScore(1 / (1 + estimatedCost)),
        latency: avgLatencyMs === null ? null : this.roundScore(1 / (1 + avgLatencyMs / 1000)),
        context: this.contextScore(contextTokens, maxContextTokens),
        cache: cacheEvidence.cache_score,
      },
      metrics: {
        estimated_cost_usd:
          estimatedCost === null ? null : Number(estimatedCost.toFixed(6)),
        avg_latency_ms: avgLatencyMs,
        p95_latency_ms: this.percentile(samples, 0.95),
        max_context_tokens: maxContextTokens,
        context_fit: contextFit,
        structured_output:
          typeof capabilities.structured_output === 'boolean'
            ? capabilities.structured_output
            : null,
        reasoning:
          typeof capabilities.supports_reasoning === 'boolean'
            ? capabilities.supports_reasoning
            : null,
        provider_cache_hit_rate: cacheEvidence.observed_cache_hit_rate,
        estimated_cache_savings_usd: cacheEvidence.estimated_cache_savings_usd,
      },
      capability_evidence: capabilityEvidence,
      cache_evidence: cacheEvidence,
      compatibility_evidence: compatibility,
    };
  }

  private buildCompatibilityEvidence(
    target: RouteTarget,
    selectionHints: RouteSelectionHints,
    selected: boolean,
    eligible: boolean,
  ): RouteDecisionCompatibilityEvidence {
    const node = this.config.getNode(target.node);
    return compatibilityEvidence({
      node,
      catalog: this.config.getMergedCatalog(),
      sourceFormat: selectionHints.source_format,
      requestedModality: selectionHints.requested_modality,
      stream: selectionHints.stream,
      multipart: selectionHints.multipart,
      selected,
      eligible,
    });
  }

  private buildTraceCacheEvidence(
    selectionHints: RouteSelectionHints,
    candidates: RouteDecisionTraceCandidate[],
  ) {
    const providerCacheCandidates = candidates.filter((candidate) =>
      candidate.cache_evidence?.provider_prompt_cache,
    );
    const savingsCandidates = candidates.filter((candidate) =>
      (candidate.cache_evidence?.estimated_cache_savings_usd || 0) > 0,
    );
    const affinityCandidates = candidates.filter((candidate) =>
      candidate.cache_evidence?.cache_affinity_active,
    );
    const notes = new Set<string>();
    if (selectionHints.local_prompt_cache_hit) notes.add('local_prompt_cache_hit');
    if (selectionHints.local_prompt_cache_eligible && !selectionHints.local_prompt_cache_hit) {
      notes.add('local_prompt_cache_miss');
    }
    if (providerCacheCandidates.length > 0) notes.add('provider_cache_capable_candidates');
    if (savingsCandidates.length > 0) notes.add('cache_read_price_considered');
    if (affinityCandidates.length > 0) notes.add('cache_affinity_active');

    return {
      local_prompt_cache_eligible: Boolean(selectionHints.local_prompt_cache_eligible),
      local_prompt_cache_hit: Boolean(selectionHints.local_prompt_cache_hit),
      local_prompt_cache_lookup: selectionHints.local_prompt_cache_lookup ?? null,
      cache_aware_routing: providerCacheCandidates.length > 0 || Boolean(selectionHints.local_prompt_cache_hit),
      provider_cache_preference: savingsCandidates.length > 0 || providerCacheCandidates.length > 0,
      notes: Array.from(notes),
    };
  }

  private buildTraceModalityEvidence(
    selectionHints: RouteSelectionHints,
    modalityHints: Modality[] | string[] | undefined,
    candidates: RouteDecisionTraceCandidate[],
  ) {
    const requestedModality =
      selectionHints.requested_modality ||
      (modalityHints && modalityHints.length > 0 ? String(modalityHints[0]) : null);
    const filteredByCapability = candidates
      .filter((candidate) => candidate.capability_evidence?.filtered_by_capability)
      .map((candidate) => ({
        node: candidate.node,
        model: candidate.model,
        reason: 'capability_unsupported',
        missing_capabilities:
          candidate.capability_evidence?.missing_capabilities || [],
      }));
    const filteredByFileSize = candidates
      .filter((candidate) => candidate.capability_evidence?.filtered_by_file_size)
      .map((candidate) => ({
        node: candidate.node,
        model: candidate.model,
        reason: 'file_size_exceeded',
        byte_size: candidate.capability_evidence?.byte_size ?? null,
        max_file_size: candidate.capability_evidence?.max_file_size ?? null,
      }));

    return {
      requested_modality: requestedModality,
      input_types: this.uniqueStrings(selectionHints.input_types || []),
      output_types: this.uniqueStrings(selectionHints.output_types || []),
      file_count: selectionHints.file_count ?? null,
      byte_size: selectionHints.byte_size ?? null,
      required_capabilities: this.uniqueStrings(
        selectionHints.required_capabilities ||
          (requestedModality ? [requestedModality] : []),
      ),
      endpoint_strategy: selectionHints.endpoint_strategy ?? null,
      filtered_by_capability: filteredByCapability,
      filtered_by_file_size: filteredByFileSize,
    };
  }

  private buildCandidateCapabilityEvidence(
    target: RouteTarget,
    selectionHints: RouteSelectionHints,
  ): RouteDecisionCandidateCapabilityEvidence {
    const capabilities =
      this.capabilityService.resolveModelRoutingCapabilities?.(
        target.node,
        target.model,
      ) || {
        modalities: this.capabilityService.resolveModelModalities?.(
          target.node,
          target.model,
        ) || [],
        structured_output: null,
      };
    const supportedModalities = this.uniqueStrings(
      capabilities.modalities ||
        this.capabilityService.resolveModelModalities?.(target.node, target.model) ||
        [],
    );
    const inputTypes = this.uniqueStrings(
      capabilities.input_types || this.inferInputTypesFromModalities(supportedModalities),
    );
    const outputTypes = this.uniqueStrings(
      capabilities.output_types || this.inferOutputTypesFromModalities(supportedModalities),
    );
    const requestedModality = selectionHints.requested_modality ?? null;
    const requiredCapabilities = this.uniqueStrings(
      selectionHints.required_capabilities ||
        (requestedModality ? [requestedModality] : []),
    );
    const matchedCapabilities = requiredCapabilities.filter((requirement) =>
      this.candidateSupportsRequirement(
        requirement,
        capabilities,
        supportedModalities,
        inputTypes,
        outputTypes,
      ),
    );
    const missingCapabilities = requiredCapabilities.filter(
      (requirement) => !matchedCapabilities.includes(requirement),
    );
    const byteSize = selectionHints.byte_size ?? null;
    const maxFileSize = capabilities.max_file_size ?? null;
    const filteredByFileSize =
      byteSize !== null &&
      maxFileSize !== null &&
      Number.isFinite(byteSize) &&
      Number.isFinite(maxFileSize) &&
      byteSize > maxFileSize;
    const endpoint = this.resolveEndpointEvidence(
      target,
      requestedModality,
      selectionHints.source_format,
      capabilities,
    );
    const pricingEvidence = pricingEvidenceFromModelPricing(capabilities.pricing);

    return {
      requested_modality: requestedModality,
      supported_modalities: supportedModalities,
      input_types: inputTypes,
      output_types: outputTypes,
      required_capabilities: requiredCapabilities,
      matched_capabilities: matchedCapabilities,
      missing_capabilities: missingCapabilities,
      endpoint_strategy: selectionHints.endpoint_strategy || endpoint.strategy,
      endpoint_status: endpoint.status,
      endpoint: endpoint.path,
      file_count: selectionHints.file_count ?? null,
      byte_size: byteSize,
      max_file_size: maxFileSize,
      filtered_by_capability: missingCapabilities.length > 0,
      filtered_by_file_size: filteredByFileSize,
      pricing_source: pricingEvidence.pricing_source || this.resolvePricingSource(capabilities),
      pricing_confidence: pricingEvidence.pricing_confidence,
      pricing_stale: pricingEvidence.pricing_stale,
      pricing_used_from: pricingEvidence.pricing_used_from,
      missing_price_units: pricingEvidence.missing_price_units,
      estimated_cost_basis: pricingEvidence.estimated_cost_basis,
      catalog_source: this.resolveCatalogSource(capabilities),
    };
  }

  private candidateSupportsRequirement(
    requirement: string,
    capabilities: Partial<ResolvedModelRoutingCapabilities>,
    supportedModalities: string[],
    inputTypes: string[],
    outputTypes: string[],
  ): boolean {
    const normalized = requirement.toLowerCase();
    if (normalized === 'image' || normalized === 'vision') {
      return supportsModalities(supportedModalities as Modality[], ['image']);
    }
    if (normalized === 'audio') {
      return supportedModalities.includes('audio') ||
        inputTypes.includes('audio') ||
        outputTypes.includes('audio');
    }
    if (normalized === 'embedding' || normalized === 'embeddings') {
      return supportedModalities.includes('embedding') ||
        inputTypes.includes('embedding') ||
        outputTypes.includes('embedding') ||
        capabilities.dimensions !== undefined;
    }
    if (normalized === 'rerank') {
      return supportedModalities.includes('rerank') ||
        capabilities.supports_rerank === true ||
        Boolean(capabilities.endpoints?.rerank);
    }
    if (normalized === 'realtime') {
      return supportedModalities.includes('realtime') ||
        capabilities.supports_realtime === true ||
        Boolean(capabilities.endpoints?.realtime);
    }
    if (normalized === 'streaming') {
      return capabilities.supports_streaming === true;
    }
    if (normalized === 'reasoning' || normalized === 'thinking') {
      return capabilities.supports_reasoning === true;
    }
    if (normalized === 'prompt_cache') {
      return capabilities.prompt_cache === true ||
        capabilities.read_cache === true ||
        capabilities.write_cache === true;
    }
    if (normalized === 'read_cache') return capabilities.read_cache === true;
    if (normalized === 'write_cache') return capabilities.write_cache === true;
    if (normalized === 'video') {
      return supportedModalities.includes('video') ||
        inputTypes.includes('video') ||
        outputTypes.includes('video') ||
        Boolean((capabilities.endpoints as Record<string, string> | undefined)?.video);
    }
    return (
      supportedModalities.includes(normalized) ||
      inputTypes.includes(normalized) ||
      outputTypes.includes(normalized)
    );
  }

  private resolveEndpointEvidence(
    target: RouteTarget,
    requestedModality: string | null,
    sourceFormat: string | null | undefined,
    capabilities: Partial<ResolvedModelRoutingCapabilities>,
  ): { strategy: string; status: string; path: string | null } {
    const node = this.config.getNode(target.node);
    const explicit = this.explicitCapabilityEndpoint(
      requestedModality,
      sourceFormat,
      capabilities,
    );
    if (explicit) {
      return { strategy: 'native', status: 'configured', path: explicit };
    }

    const legacy = this.legacyNodeEndpoint(node, requestedModality, sourceFormat);
    if (legacy) {
      return { strategy: 'configured', status: 'configured', path: legacy };
    }

    const defaultPath = this.defaultEndpointPath(requestedModality, sourceFormat);
    if (defaultPath) {
      return { strategy: 'default', status: 'default', path: defaultPath };
    }

    if (node?.endpoint) {
      return { strategy: 'passthrough', status: 'fallback', path: node.endpoint };
    }

    return { strategy: 'missing', status: 'missing', path: null };
  }

  private explicitCapabilityEndpoint(
    requestedModality: string | null,
    sourceFormat: string | null | undefined,
    capabilities: Partial<ResolvedModelRoutingCapabilities>,
  ): string | null {
    const endpoints = capabilities.endpoints as Record<string, string> | undefined;
    if (!endpoints) return null;
    const key = this.endpointKey(requestedModality, sourceFormat);
    return (key && endpoints[key]) || null;
  }

  private legacyNodeEndpoint(
    node: NodeConfig | undefined,
    requestedModality: string | null,
    sourceFormat: string | null | undefined,
  ): string | null {
    if (!node) return null;
    if (sourceFormat === 'image_generation') return node.images_generations_endpoint || null;
    if (sourceFormat === 'image_edit') return node.images_edits_endpoint || null;
    if (sourceFormat === 'image_variation') return node.images_variations_endpoint || null;
    if (sourceFormat === 'audio_transcription') return node.audio_transcriptions_endpoint || null;
    if (sourceFormat === 'audio_translation') return node.audio_translations_endpoint || null;
    if (sourceFormat === 'audio_speech') return node.audio_speech_endpoint || null;
    if (sourceFormat === 'video_generation') return node.video_endpoint || node.video_generations_endpoint || null;
    if (requestedModality === 'embedding') return node.embeddings_endpoint || null;
    if (requestedModality === 'rerank') return node.rerank_endpoint || null;
    if (requestedModality === 'realtime') return node.realtime_endpoint || null;
    return null;
  }

  private defaultEndpointPath(
    requestedModality: string | null,
    sourceFormat: string | null | undefined,
  ): string | null {
    if (sourceFormat === 'image_generation') return '/v1/images/generations';
    if (sourceFormat === 'image_edit') return '/v1/images/edits';
    if (sourceFormat === 'image_variation') return '/v1/images/variations';
    if (sourceFormat === 'audio_transcription') return '/v1/audio/transcriptions';
    if (sourceFormat === 'audio_translation') return '/v1/audio/translations';
    if (sourceFormat === 'audio_speech') return '/v1/audio/speech';
    if (sourceFormat === 'video_generation') return '/v1/videos/generations';
    if (requestedModality === 'embedding') return '/v1/embeddings';
    if (requestedModality === 'rerank') return '/v1/rerank';
    if (requestedModality === 'realtime') return '/v1/realtime';
    return null;
  }

  private endpointKey(
    requestedModality: string | null,
    sourceFormat: string | null | undefined,
  ): string | null {
    if (sourceFormat === 'image_generation' || sourceFormat === 'image_edit' || sourceFormat === 'image_variation') return 'image';
    if (sourceFormat === 'audio_transcription' || sourceFormat === 'audio_translation' || sourceFormat === 'audio_speech') return 'audio';
    if (sourceFormat === 'video_generation') return 'video';
    if (requestedModality === 'embedding') return 'embeddings';
    if (requestedModality === 'rerank') return 'rerank';
    if (requestedModality === 'realtime') return 'realtime';
    if (requestedModality === 'image' || requestedModality === 'vision') return 'image';
    if (requestedModality === 'audio') return 'audio';
    if (requestedModality === 'video') return 'video';
    return null;
  }

  private resolvePricingSource(
    capabilities: Partial<ResolvedModelRoutingCapabilities>,
  ): string | null {
    const pricing = capabilities.pricing as
      | (ResolvedModelRoutingCapabilities['pricing'] & { source?: string })
      | undefined;
    if (!pricing) return 'missing';
    return pricing.source || 'config';
  }

  private resolveCatalogSource(
    capabilities: Partial<ResolvedModelRoutingCapabilities>,
  ): string | null {
    const metadata = capabilities as {
      catalog_source?: string;
      source?: string;
      overridden?: boolean;
    };
    if (metadata.catalog_source) return metadata.catalog_source;
    if (metadata.overridden) return 'override';
    if (metadata.source) return metadata.source;
    return 'config';
  }

  private inferInputTypesFromModalities(modalities: readonly string[]): string[] {
    const inputTypes = new Set<string>();
    if (modalities.includes('text') || modalities.includes('embedding') || modalities.includes('rerank')) {
      inputTypes.add('text');
    }
    if (modalities.includes('vision') || modalities.includes('image')) {
      inputTypes.add('image');
    }
    if (modalities.includes('audio')) {
      inputTypes.add('audio');
    }
    if (modalities.includes('rerank')) {
      inputTypes.add('documents');
    }
    if (modalities.includes('realtime')) {
      inputTypes.add('events');
    }
    return Array.from(inputTypes);
  }

  private inferOutputTypesFromModalities(modalities: readonly string[]): string[] {
    const outputTypes = new Set<string>();
    if (modalities.includes('text') || modalities.includes('vision')) {
      outputTypes.add('text');
    }
    if (modalities.includes('image')) {
      outputTypes.add('image');
    }
    if (modalities.includes('audio')) {
      outputTypes.add('audio');
    }
    if (modalities.includes('embedding')) {
      outputTypes.add('embedding');
    }
    if (modalities.includes('rerank')) {
      outputTypes.add('ranked_documents');
    }
    if (modalities.includes('realtime')) {
      outputTypes.add('events');
    }
    return Array.from(outputTypes);
  }

  private embeddingSelectionHints(dimensions?: number): RouteSelectionHints {
    return {
      requested_modality: 'embedding',
      input_types: ['text'],
      output_types: ['embedding'],
      required_capabilities: ['embedding'],
      endpoint_strategy: 'embeddings',
      source_format: 'embeddings',
      estimated_output_tokens: dimensions,
    };
  }

  private rerankSelectionHints(): RouteSelectionHints {
    return {
      requested_modality: 'rerank',
      input_types: ['text', 'documents'],
      output_types: ['ranked_documents'],
      file_count: 0,
      byte_size: null,
      required_capabilities: ['rerank'],
      endpoint_strategy: 'rerank',
      source_format: 'rerank',
    };
  }

  private withDefaultRerankSelectionHints(
    selectionHints: RouteSelectionHints,
  ): RouteSelectionHints {
    return {
      ...this.rerankSelectionHints(),
      ...selectionHints,
      input_types: selectionHints.input_types || ['text', 'documents'],
      output_types: selectionHints.output_types || ['ranked_documents'],
      required_capabilities: selectionHints.required_capabilities || ['rerank'],
      requested_modality: selectionHints.requested_modality || 'rerank',
      endpoint_strategy: selectionHints.endpoint_strategy || 'rerank',
      source_format: selectionHints.source_format || 'rerank',
    };
  }

  private mediaSelectionHints(
    sourceFormat: CanonicalMediaSourceFormat,
  ): RouteSelectionHints {
    if (sourceFormat === 'image_generation') {
      return {
        requested_modality: 'image',
        input_types: ['text'],
        output_types: ['image'],
        required_capabilities: ['image'],
        endpoint_strategy: 'image_generation',
        source_format: sourceFormat,
      };
    }
    if (sourceFormat === 'image_edit') {
      return {
        requested_modality: 'image',
        input_types: ['text', 'image', 'file'],
        output_types: ['image'],
        required_capabilities: ['image'],
        endpoint_strategy: 'image_edit',
        source_format: sourceFormat,
      };
    }
    if (sourceFormat === 'image_variation') {
      return {
        requested_modality: 'image',
        input_types: ['image', 'file'],
        output_types: ['image'],
        required_capabilities: ['image'],
        endpoint_strategy: 'image_variation',
        source_format: sourceFormat,
      };
    }
    if (sourceFormat === 'audio_transcription') {
      return {
        requested_modality: 'audio',
        input_types: ['audio', 'file'],
        output_types: ['text'],
        required_capabilities: ['audio'],
        endpoint_strategy: 'audio_transcription',
        source_format: sourceFormat,
      };
    }
    if (sourceFormat === 'audio_translation') {
      return {
        requested_modality: 'audio',
        input_types: ['audio', 'file'],
        output_types: ['text'],
        required_capabilities: ['audio'],
        endpoint_strategy: 'audio_translation',
        source_format: sourceFormat,
      };
    }
    if (sourceFormat === 'video_generation') {
      return {
        requested_modality: 'video',
        input_types: ['text', 'image'],
        output_types: ['video'],
        required_capabilities: ['video'],
        endpoint_strategy: 'video_generation',
        source_format: sourceFormat,
      };
    }
    return {
      requested_modality: 'audio',
      input_types: ['text'],
      output_types: ['audio'],
      required_capabilities: ['audio'],
      endpoint_strategy: 'audio_speech',
      source_format: sourceFormat,
    };
  }

  private withDefaultMediaSelectionHints(
    sourceFormat: CanonicalMediaSourceFormat,
    selectionHints: RouteSelectionHints,
  ): RouteSelectionHints {
    const defaults = this.mediaSelectionHints(sourceFormat);
    return {
      ...defaults,
      ...selectionHints,
      input_types: selectionHints.input_types || defaults.input_types,
      output_types: selectionHints.output_types || defaults.output_types,
      required_capabilities:
        selectionHints.required_capabilities || defaults.required_capabilities,
      requested_modality:
        selectionHints.requested_modality || defaults.requested_modality,
      endpoint_strategy:
        selectionHints.endpoint_strategy || defaults.endpoint_strategy,
      source_format: selectionHints.source_format || sourceFormat,
    };
  }

  private uniqueStrings(values: readonly unknown[]): string[] {
    return Array.from(
      new Set(
        values
          .filter((value): value is string => typeof value === 'string' && value.length > 0)
          .map((value) => value.toLowerCase()),
      ),
    );
  }

  private inferFilterReasons(
    target: RouteTarget,
    initialTargets: RouteTarget[],
    isFinalTarget: boolean,
    modalityHints: Modality[] | string[] | undefined,
    selectionHints: RouteSelectionHints,
  ): string[] {
    const reasons: string[] = [];
    const capabilities =
      this.capabilityService.resolveModelRoutingCapabilities?.(
        target.node,
        target.model,
      ) || {};
    const circuitState =
      this.circuitBreaker.getCircuitState?.(target.node, target.model) || 'CLOSED';
    if (!isFinalTarget && String(circuitState) === 'OPEN') {
      reasons.push('circuit_open');
    }

    const estimatedContextTokens = selectionHints.estimated_context_tokens;
    const maxContextTokens = capabilities.max_context_tokens;
    if (
      !isFinalTarget &&
      estimatedContextTokens &&
      maxContextTokens &&
      estimatedContextTokens > maxContextTokens
    ) {
      reasons.push('context_window_exceeded');
    }

    if (
      !isFinalTarget &&
      selectionHints.requires_structured_output &&
      capabilities.structured_output === false &&
      initialTargets.some((candidate) =>
        this.capabilityService.resolveModelRoutingCapabilities?.(
          candidate.node,
          candidate.model,
        )?.structured_output === true,
      )
    ) {
      reasons.push('structured_output_unsupported');
    }

    if (
      !isFinalTarget &&
      selectionHints.requires_reasoning &&
      capabilities.supports_reasoning === false &&
      initialTargets.some((candidate) =>
        this.capabilityService.resolveModelRoutingCapabilities?.(
          candidate.node,
          candidate.model,
        )?.supports_reasoning === true,
      )
    ) {
      reasons.push('reasoning_unsupported');
    }

    if (modalityHints && modalityHints.length > 0) {
      const targetModalities =
        this.capabilityService.resolveModelModalities?.(target.node, target.model) || [];
      const supported = supportsModalities(
        targetModalities,
        modalityHints as Modality[],
      );
      if (!supported) {
        reasons.push(isFinalTarget ? 'modality_demoted' : 'modality_unsupported');
      }
    }

    const capabilityEvidence = this.buildCandidateCapabilityEvidence(
      target,
      selectionHints,
    );
    if (
      capabilityEvidence.filtered_by_capability &&
      !reasons.includes('modality_unsupported') &&
      !reasons.includes('modality_demoted')
    ) {
      reasons.push(isFinalTarget ? 'capability_demoted' : 'capability_unsupported');
    }
    if (capabilityEvidence.filtered_by_file_size) {
      reasons.push(isFinalTarget ? 'file_size_demoted' : 'file_size_exceeded');
    }

    const compatibilityReason = this.targetCompatibilityReason(target, selectionHints);
    if (compatibilityReason) {
      reasons.push(isFinalTarget ? `${compatibilityReason}:demoted` : compatibilityReason);
    }

    if (!isFinalTarget && reasons.length === 0) {
      reasons.push('routing_constraint_filtered');
    }
    return reasons;
  }

  private filterStage(reason: string): string {
    if (reason.startsWith('circuit')) return 'circuit_breaker';
    if (reason.startsWith('context')) return 'context_window';
    if (reason.startsWith('structured')) return 'structured_output';
    if (reason.startsWith('reasoning')) return 'reasoning';
    if (reason.startsWith('compatibility_profile')) return 'compatibility_profile';
    if (reason.startsWith('modality')) return 'modality';
    if (reason.startsWith('capability')) return 'capability';
    if (reason.startsWith('file_size')) return 'file_size';
    return 'routing';
  }

  private contextFit(
    contextTokens: number | undefined,
    maxContextTokens: number | null,
  ): 'safe' | 'near_limit' | 'overflow' | 'unknown' {
    if (!contextTokens || !maxContextTokens) return 'unknown';
    if (contextTokens > maxContextTokens) return 'overflow';
    if (contextTokens > maxContextTokens * 0.8) return 'near_limit';
    return 'safe';
  }

  private contextScore(
    contextTokens: number | undefined,
    maxContextTokens: number | null,
  ): number | null {
    if (!contextTokens || !maxContextTokens) return null;
    return this.roundScore(Math.max(0, 1 - contextTokens / maxContextTokens));
  }

  private roundScore(value: number): number {
    return Number(value.toFixed(4));
  }

  private applyCapabilityConstraints<T extends RouteTarget>(
    tier: string,
    targets: T[],
    selectionHints: RouteSelectionHints,
  ): T[] {
    let constrained = targets;

    if (selectionHints.requires_structured_output) {
      constrained = this.preferStructuredOutputTargets(tier, constrained);
    }

    if (selectionHints.requires_reasoning) {
      constrained = this.preferReasoningTargets(tier, constrained);
    }

    const estimatedContextTokens = selectionHints.estimated_context_tokens;
    if (
      estimatedContextTokens === undefined ||
      estimatedContextTokens <= 0 ||
      constrained.length === 0
    ) {
      return constrained;
    }

    const safe: T[] = [];
    const unknown: T[] = [];
    const nearLimit: T[] = [];
    const overflow: T[] = [];

    for (const target of constrained) {
      const maxContextTokens =
        this.capabilityService.resolveModelRoutingCapabilities(
          target.node,
          target.model,
        ).max_context_tokens;

      if (!maxContextTokens) {
        unknown.push(target);
      } else if (estimatedContextTokens > maxContextTokens) {
        overflow.push(target);
      } else if (estimatedContextTokens > maxContextTokens * 0.8) {
        nearLimit.push(target);
      } else {
        safe.push(target);
      }
    }

    const fits = [...safe, ...unknown, ...nearLimit];
    if (fits.length === 0) {
      const largestWindow = Math.max(
        ...overflow.map((target) =>
          this.capabilityService.resolveModelRoutingCapabilities(
            target.node,
            target.model,
          ).max_context_tokens || 0,
        ),
      );
      throw new RoutingConstraintError(
        `No route targets for tier "${tier}" can fit the estimated ${estimatedContextTokens} context tokens` +
          (largestWindow ? ` (largest configured window: ${largestWindow}).` : '.'),
        400,
      );
    }

    if (overflow.length > 0) {
      this.logger.warn(
        `Context-aware routing removed ${overflow.length} target(s) for tier "${tier}" because estimated context ${estimatedContextTokens} exceeds their configured windows.`,
      );
    }

    if (safe.length > 0 && nearLimit.length > 0) {
      this.logger.debug(
        `Context-aware routing demoted ${nearLimit.length} near-limit target(s) for tier "${tier}" over 80% of context window.`,
      );
    }

    return fits;
  }

  private filterTargetsByModalities<T extends RouteTarget>(
    tier: string,
    targets: T[],
    modalityHints?: Modality[],
  ): T[] {
    const required = Array.from(new Set(modalityHints || []));
    if (required.length === 0 || targets.length === 0) return targets;

    const compatible = targets.filter((target) => {
      const targetModalities = this.capabilityService.resolveModelModalities(
        target.node,
        target.model,
      );
      return supportsModalities(targetModalities, required);
    });

    if (compatible.length === 0) {
      throw new RoutingConstraintError(
        `No route targets for tier "${tier}" support required modalities [${required.join(', ')}].`,
        400,
      );
    }

    const removed = targets.length - compatible.length;
    if (removed > 0) {
      this.logger.debug(
        `Modality-aware routing removed ${removed} target(s) for tier "${tier}" because they do not support [${required.join(', ')}].`,
      );
    }

    return compatible;
  }

  private filterTargetsByCompatibilityProfiles<T extends RouteTarget>(
    tier: string,
    targets: T[],
    selectionHints: RouteSelectionHints,
  ): T[] {
    if (
      targets.length === 0 ||
      (!selectionHints.source_format &&
        !selectionHints.requested_modality &&
        !selectionHints.stream &&
        !selectionHints.multipart)
    ) {
      return targets;
    }

    const compatible = targets.filter((target) =>
      !this.targetCompatibilityReason(target, selectionHints),
    );
    if (compatible.length === 0) {
      const source = selectionHints.source_format || selectionHints.requested_modality || 'request';
      throw new RoutingConstraintError(
        `No route targets for tier "${tier}" have a compatibility_profile that supports ${source}.`,
        400,
      );
    }

    const removed = targets.length - compatible.length;
    if (removed > 0) {
      this.logger.debug(
        `Compatibility-profile routing removed ${removed} target(s) for tier "${tier}".`,
      );
    }
    return compatible;
  }

  private assertTargetCompatibility(
    target: RouteTarget,
    selectionHints: RouteSelectionHints,
  ): void {
    const reason = this.targetCompatibilityReason(target, selectionHints);
    if (!reason) return;
    throw new RoutingConstraintError(
      `Target ${target.node}/${target.model} is not compatible with ${selectionHints.source_format || selectionHints.requested_modality || 'this request'} (${reason}).`,
      reason.includes('multipart') ? 400 : 400,
    );
  }

  private targetCompatibilityReason(
    target: RouteTarget,
    selectionHints: RouteSelectionHints,
  ): string | null {
    const node = this.config.getNode(target.node);
    if (!node) return 'compatibility_profile_missing_node';
    const profiles = resolveNodeCompatibilityProfiles(
      node,
      this.config.getMergedCatalog(),
    );
    return compatibilityFilteredReason({
      profiles,
      sourceFormat: selectionHints.source_format,
      requestedModality: selectionHints.requested_modality,
      stream: selectionHints.stream,
      multipart: selectionHints.multipart,
    });
  }

  private preferStructuredOutputTargets<T extends RouteTarget>(
    tier: string,
    targets: T[],
  ): T[] {
    const supported: T[] = [];
    const unknown: T[] = [];
    const unsupported: T[] = [];

    for (const target of targets) {
      const structuredOutput =
        this.capabilityService.resolveModelRoutingCapabilities(
          target.node,
          target.model,
        ).structured_output;
      if (structuredOutput === true) {
        supported.push(target);
      } else if (structuredOutput === false) {
        unsupported.push(target);
      } else {
        unknown.push(target);
      }
    }

    if (supported.length > 0) {
      return [...supported, ...unknown];
    }

    if (unknown.length === 0 && unsupported.length > 0) {
      throw new RoutingConstraintError(
        `No route targets for tier "${tier}" declare structured output support.`,
        400,
      );
    }

    return [...unknown, ...unsupported];
  }

  private preferReasoningTargets<T extends RouteTarget>(
    tier: string,
    targets: T[],
  ): T[] {
    const supported: T[] = [];
    const unknown: T[] = [];
    const unsupported: T[] = [];

    for (const target of targets) {
      const reasoning =
        this.capabilityService.resolveModelRoutingCapabilities(
          target.node,
          target.model,
        ).supports_reasoning;
      if (reasoning === true) {
        supported.push(target);
      } else if (reasoning === false) {
        unsupported.push(target);
      } else {
        unknown.push(target);
      }
    }

    if (supported.length > 0) {
      return [...supported, ...unknown];
    }

    if (unknown.length === 0 && unsupported.length > 0) {
      throw new RoutingConstraintError(
        `No route targets for tier "${tier}" declare reasoning support.`,
        400,
      );
    }

    return [...unknown, ...unsupported];
  }

  private toRouteTarget(target: RouteTarget): RouteTarget {
    return { node: target.node, model: target.model };
  }

  private averageLatency(node: string, model: string): number | null {
    return this.average(this.getLatencySamples(node, model));
  }

  private getLatencySamples(node: string, model: string): number[] {
    return this.latencyWindows.get(this.buildExperimentTargetKey(node, model)) || [];
  }

  private average(samples: number[]): number | null {
    if (samples.length === 0) return null;
    return Math.round(samples.reduce((sum, value) => sum + value, 0) / samples.length);
  }

  private percentile(samples: number[], percentile: number): number | null {
    if (samples.length === 0) return null;
    const sorted = [...samples].sort((a, b) => a - b);
    const index = Math.min(
      sorted.length - 1,
      Math.ceil(percentile * sorted.length) - 1,
    );
    return sorted[index];
  }

  /**
   * Resolve A/B split: hash the session key into a bucket and select a variant.
   * The selected variant becomes primary; remaining variants become fallbacks.
   * Uses FNV-1a 32-bit hash for deterministic, sticky routing.
   */
  private resolveABSplit(
    variants: SplitVariant[],
    tier: string,
    sessionKey?: string,
  ): { orderedTargets: RouteTarget[]; experimentGroupsByTarget: Record<string, string> } {
    const hash = fnv1a32(sessionKey || uuidv4());
    const bucket = hash % 100;

    let cumulative = 0;
    let selectedIdx = 0;
    for (let i = 0; i < variants.length; i++) {
      cumulative += variants[i].weight;
      if (bucket < cumulative) {
        selectedIdx = i;
        break;
      }
    }

    const selected = variants[selectedIdx];
    const name = selected.name || `${selected.node}:${selected.model}`;
    const primary: RouteTarget = { node: selected.node, model: selected.model };
    const fallbacks = variants
      .filter((_, i) => i !== selectedIdx)
      .map(v => ({ node: v.node, model: v.model }));
    const experimentGroupsByTarget = Object.fromEntries(
      variants.map((variant) => {
        const variantName = variant.name || `${variant.node}:${variant.model}`;
        return [
          this.buildExperimentTargetKey(variant.node, variant.model),
          `${tier}:${variantName}`,
        ];
      }),
    );

    this.logger.log(
      `A/B split tier="${tier}": bucket=${bucket} → variant="${name}" (weight=${selected.weight})`,
    );

    return {
      orderedTargets: [primary, ...fallbacks],
      experimentGroupsByTarget,
    };
  }

  private resolveExperimentGroupForTarget(
    experimentGroupsByTarget: Record<string, string>,
    target: RouteTarget,
  ): string | null {
    return experimentGroupsByTarget[this.buildExperimentTargetKey(target.node, target.model)] || null;
  }

  private buildExperimentTargetKey(node: string, model: string): string {
    return `${node}:${model}`;
  }

  /**
   * Resolve preferred node IDs for a domain hint.
   *
   * Priority:
   *   1. Explicit config: routing.domain_preferences.{domain}
   *   2. Tag-based: all nodes with the domain as a tag, sorted by tier cost (cheap → expensive)
   *   3. Capability-based: nodes whose capabilities include the domain hint
   */
  private resolvePreferredNodes(domain: string): string[] {
    // 1. Check explicit config
    const explicit = this.config.routing.domain_preferences?.[domain];
    if (explicit && explicit.length > 0) {
      return explicit;
    }

    // 2. Fallback to tag matching — find nodes tagged with this domain
    const tagged = this.config.nodes
      .filter((n) => n.tags?.includes(domain))
      .map((n) => n.id);

    if (tagged.length > 0) {
      this.logger.debug(
        `Domain "${domain}": no explicit preference, using tag match: [${tagged.join(', ')}]`,
      );
      return tagged;
    }

    // 3. Fallback to capability matching — find nodes with matching capability
    const capabilityMatched = this.config.nodes
      .filter((n) => n.capabilities?.includes(domain))
      .map((n) => n.id);

    if (capabilityMatched.length > 0) {
      this.logger.debug(
        `Domain "${domain}": no tag match, using capability match: [${capabilityMatched.join(', ')}]`,
      );
    }

    return capabilityMatched;
  }

  /**
   * Reorder targets so preferred nodes come first (while keeping their relative order).
   * Non-preferred targets maintain their original order after preferred ones.
   */
  private reorderByPreference<T extends RouteTarget>(
    targets: T[],
    preferredNodes: string[],
  ): T[] {
    const preferred: T[] = [];
    const rest: T[] = [];

    // Walk through preferred list in order to maintain priority
    for (const prefNode of preferredNodes) {
      const found = targets.find((t) => t.node === prefNode);
      if (found) {
        preferred.push(found);
      }
    }

    // Add remaining targets not in preferred list
    for (const t of targets) {
      if (!preferred.includes(t)) {
        rest.push(t);
      }
    }

    return [...preferred, ...rest];
  }
}

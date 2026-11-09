import { RoutingService } from '../../src/routing/routing.service';
import { mockConfigService } from '../helpers';
import { Tier } from '../../src/canonical/canonical.types';

function inactiveAffinityResult() {
  return {
    active: false,
    bonus: 0,
    reason: 'no_session_history',
    provider_cache_ttl_seconds: null,
    time_since_last_cache_hit_seconds: null,
    estimated_cache_hit_probability: null,
    consecutive_count: 0,
    cache_type: null,
  };
}

function makeRoutingService(overrides: {
  tiers?: Record<string, any>;
  domainPreferences?: Record<string, string[]>;
  optimization?: any;
  nodes?: any[];
  resolveEmbeddingModel?: any;
  resolveRerankModel?: any;
  resolveImageModel?: any;
  resolveAudioModel?: any;
  circuitBreaker?: any;
  momentum?: any;
  capabilityService?: any;
  cacheAffinityService?: any;
} = {}) {
  const config = mockConfigService({
    routing: {
      tiers: overrides.tiers || {
        simple: {
          primary: { node: 'n1', model: 'fast-model' },
          fallbacks: [{ node: 'n2', model: 'medium-model' }],
        },
        standard: {
          primary: { node: 'n2', model: 'medium-model' },
          fallbacks: [{ node: 'n1', model: 'fast-model' }],
        },
      },
      scoring: { simple_max: 0.3, standard_max: 0.6, complex_max: 0.85 },
      optimization: overrides.optimization,
      domain_preferences: overrides.domainPreferences,
    },
    nodes: overrides.nodes || [
      { id: 'n1', tags: ['fast', 'frontend'] },
      { id: 'n2', tags: ['backend', 'reasoning'] },
    ],
  });
  config.getNode = jest.fn().mockImplementation((id: string) =>
    config.nodes.find((node: any) => node.id === id),
  );
  config.resolveEmbeddingModel = overrides.resolveEmbeddingModel || jest.fn().mockImplementation((model: string) => {
    for (const node of config.nodes) {
      if (node.embedding_models?.includes(model)) {
        return { nodeId: node.id, model };
      }
    }
    return null;
  });
  config.resolveRerankModel = overrides.resolveRerankModel || jest.fn().mockImplementation((model: string) => {
    for (const node of config.nodes) {
      if (node.rerank_models?.includes(model)) {
        return { nodeId: node.id, model };
      }
    }
    return null;
  });
  config.resolveImageModel = overrides.resolveImageModel || jest.fn().mockImplementation((model: string) => {
    for (const node of config.nodes) {
      if (node.image_models?.includes(model)) {
        return { nodeId: node.id, model };
      }
    }
    return null;
  });
  config.resolveAudioModel = overrides.resolveAudioModel || jest.fn().mockImplementation((model: string) => {
    for (const node of config.nodes) {
      if (node.audio_models?.includes(model)) {
        return { nodeId: node.id, model };
      }
    }
    return null;
  });

  const circuitBreaker = overrides.circuitBreaker || {
    isAvailable: jest.fn().mockReturnValue(true),
    getCircuitState: jest.fn().mockReturnValue('CLOSED'),
  };

  const momentum = overrides.momentum || {
    scopedSessionKey: jest.fn((sessionKey?: string) => sessionKey),
    apply: jest.fn().mockImplementation((tier: Tier, _score: number, _key?: string) => ({
      tier,
      adjusted: false,
    })),
  };

  const capabilityService = overrides.capabilityService || {
    resolveModelModalities: jest.fn().mockReturnValue(['text', 'vision']),
    resolveModelRoutingCapabilities: jest.fn().mockReturnValue({
      structured_output: null,
      pricing: undefined,
    }),
  };

  const cacheAffinityService = overrides.cacheAffinityService || {
    getCacheAffinity: jest.fn().mockReturnValue(inactiveAffinityResult()),
    recordRouteResult: jest.fn(),
  };

  return new RoutingService(
    config,
    capabilityService,
    circuitBreaker,
    momentum,
    cacheAffinityService,
  );
}

describe('RoutingService', () => {
  // ── Normal routing ───────────────────────────────────────

  it('should resolve primary and fallbacks for a valid tier', () => {
    const svc = makeRoutingService();
    const decision = svc.resolve('simple' as Tier, 0.1);

    expect(decision.primary.node).toBe('n1');
    expect(decision.primary.model).toBe('fast-model');
    expect(decision.fallbacks).toHaveLength(1);
    expect(decision.fallbacks[0].node).toBe('n2');
    expect(decision.tier).toBe('simple');
    expect(decision.momentumAdjusted).toBe(false);
  });

  // ── Missing tier fallback ────────────────────────────────

  it('should fall back to first tier config when tier is missing', () => {
    const svc = makeRoutingService();
    const decision = svc.resolve('reasoning' as Tier, 0.9);

    // 'reasoning' not in tiers config, should fall back to first tier ('simple')
    expect(decision.primary.node).toBe('n1');
    expect(decision.tier).toBe('reasoning'); // tier stays as requested
  });

  // ── Circuit breaker filtering ────────────────────────────

  it('should filter out nodes with open circuit breakers', () => {
    const circuitBreaker = {
      isAvailable: jest.fn().mockImplementation((node: string, _model: string) => node !== 'n1'),
      getCircuitState: jest.fn().mockImplementation((node: string) => node === 'n1' ? 'OPEN' : 'CLOSED'),
    };
    const svc = makeRoutingService({ circuitBreaker });
    const decision = svc.resolve('simple' as Tier, 0.1);

    // n1 is unavailable, so n2 should be promoted to primary
    expect(decision.primary.node).toBe('n2');
    expect(decision.fallbacks).toHaveLength(0);
  });

  it('should use all targets as last resort when all circuits are open', () => {
    const circuitBreaker = {
      isAvailable: jest.fn().mockReturnValue(false),
      getCircuitState: jest.fn().mockReturnValue('OPEN'),
    };
    const svc = makeRoutingService({ circuitBreaker });
    const decision = svc.resolve('simple' as Tier, 0.1);

    // Should still return something (all targets as last resort)
    expect(decision.primary.node).toBe('n1');
    expect(decision.fallbacks).toHaveLength(1);
  });

  // ── Modality filtering ───────────────────────────────────

  it('should filter targets based on modality compatibility', () => {
    const capabilityService = {
      resolveModelModalities: jest.fn().mockImplementation((_nodeId: string, model: string) => {
        if (model === 'fast-model') return ['text']; // n1 doesn't support vision
        return ['text', 'vision']; // n2 supports vision
      }),
    };
    const svc = makeRoutingService({ capabilityService });
    const decision = svc.resolve('simple' as Tier, 0.1, undefined, null, ['text', 'vision']);

    // n2 supports vision, n1 is removed rather than kept as a fallback
    expect(decision.primary.node).toBe('n2');
    expect(decision.fallbacks).toHaveLength(0);
  });

  it('should treat configured image modality as compatible with legacy vision hints', () => {
    const capabilityService = {
      resolveModelModalities: jest.fn().mockImplementation((_nodeId: string, model: string) => {
        if (model === 'fast-model') return ['text'];
        return ['text', 'image'];
      }),
    };
    const svc = makeRoutingService({ capabilityService });
    const decision = svc.resolve('simple' as Tier, 0.1, undefined, null, ['text', 'vision']);

    expect(decision.primary.node).toBe('n2');
    expect(decision.fallbacks).toHaveLength(0);
  });

  it('should reject automatic routes when no target supports required modalities', () => {
    const capabilityService = {
      resolveModelModalities: jest.fn().mockReturnValue(['text']),
    };
    const svc = makeRoutingService({ capabilityService });

    expect(() =>
      svc.resolve('simple' as Tier, 0.1, undefined, null, ['text', 'audio']),
    ).toThrow('No route targets for tier "simple" support required modalities');
  });

  it('should filter targets by compatibility profile source format', () => {
    const svc = makeRoutingService({
      nodes: [
        {
          id: 'n1',
          protocol: 'chat_completions',
          base_url: 'https://api.openai.com',
          tags: ['text'],
          compatibility_profile: ['openai_compatible'],
        },
        {
          id: 'n2',
          protocol: 'chat_completions',
          base_url: 'https://images.example',
          tags: ['image'],
          compatibility_profile: ['media_generation_sync'],
        },
      ],
    });

    const decision = svc.resolve('simple' as Tier, 0.1, undefined, null, undefined, {
      source_format: 'image_generation',
      requested_modality: 'image',
    });

    expect(decision.primary.node).toBe('n2');
    expect(decision.trace?.filters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          node: 'n1',
          stage: 'compatibility_profile',
        }),
      ]),
    );
    expect(decision.trace?.candidate_targets.find((candidate) => candidate.node === 'n1')).toMatchObject({
      compatibility_evidence: expect.objectContaining({
        filtered_by_profile_reason: 'compatibility_profile_unsupported_source_format:image_generation',
      }),
    });
  });

  // ── Domain hint (explicit config) ────────────────────────

  it('should reorder targets based on explicit domain preferences', () => {
    const svc = makeRoutingService({
      tiers: {
        simple: {
          strategy: 'primary_fallback',
          targets: [
            { node: 'n1', model: 'fast-model' },
            { node: 'n2', model: 'medium-model' },
          ],
        },
      },
      domainPreferences: { backend: ['n2', 'n1'] },
    });
    const decision = svc.resolve('simple' as Tier, 0.1, undefined, 'backend');

    expect(decision.primary.node).toBe('n2');
    expect(decision.domainHint).toBe('backend');
  });

  it('should preserve explicit primary/fallback order despite domain preferences', () => {
    const svc = makeRoutingService({
      domainPreferences: { backend: ['n2', 'n1'] },
    });
    const decision = svc.resolve('simple' as Tier, 0.1, undefined, 'backend');

    expect(decision.primary.node).toBe('n1');
    expect(decision.fallbacks).toEqual([{ node: 'n2', model: 'medium-model' }]);
    expect(decision.domainHint).toBe('backend');
  });

  // ── Domain hint (tag-based fallback) ─────────────────────

  it('should use tag-based domain preference when no explicit config', () => {
    const svc = makeRoutingService();
    // 'frontend' is a tag on n1; no explicit domain_preferences for 'frontend'
    const decision = svc.resolve('simple' as Tier, 0.1, undefined, 'frontend');

    // n1 has tag 'frontend', so it should stay as primary (it already is)
    expect(decision.primary.node).toBe('n1');
    expect(decision.domainHint).toBe('frontend');
  });

  // ── Momentum smoothing ──────────────────────────────────

  it('should use momentum-adjusted tier', () => {
    const momentum = {
      scopedSessionKey: jest.fn((sessionKey?: string) => sessionKey),
      apply: jest.fn().mockReturnValue({ tier: 'standard', adjusted: true }),
    };
    const svc = makeRoutingService({ momentum });
    const decision = svc.resolve('complex' as Tier, 0.7, 'session-1');

    expect(decision.tier).toBe('standard'); // momentum adjusted
    expect(decision.momentumAdjusted).toBe(true);
    expect(momentum.apply).toHaveBeenCalledWith('complex', 0.7, 'session-1');
  });

  // ── Score passthrough ────────────────────────────────────

  it('should pass through the original score', () => {
    const svc = makeRoutingService();
    const decision = svc.resolve('simple' as Tier, 0.42);
    expect(decision.score).toBe(0.42);
  });

  it('should include route decision trace candidates, filters, and scores', () => {
    const circuitBreaker = {
      isAvailable: jest.fn().mockImplementation((node: string) => node !== 'n2'),
      getCircuitState: jest.fn().mockImplementation((node: string) => node === 'n2' ? 'OPEN' : 'CLOSED'),
    };
    const capabilityService = {
      resolveModelModalities: jest.fn().mockReturnValue(['text']),
      resolveModelRoutingCapabilities: jest.fn().mockImplementation((_node: string, model: string) => ({
        max_context_tokens: model === 'fast-model' ? 128000 : 1000,
        structured_output: model === 'fast-model',
        pricing: model === 'fast-model'
          ? { input: 1, output: 2 }
          : { input: 10, output: 20 },
      })),
    };
    const svc = makeRoutingService({ circuitBreaker, capabilityService });
    const decision = svc.resolve(
      'simple' as Tier,
      0.42,
      'session-1',
      'backend',
      ['text'],
      {
        estimated_input_tokens: 100,
        estimated_output_tokens: 50,
        estimated_context_tokens: 1200,
        requires_structured_output: true,
      },
    );

    expect(decision.trace).toMatchObject({
      mode: 'auto',
      tier: 'simple',
      score: 0.42,
      domain_hints: { domain: 'backend', modalities: ['text'] },
      constraints: {
        estimated_context_tokens: 1200,
        requires_structured_output: true,
      },
      final_selection: {
        node: 'n1',
        model: 'fast-model',
      },
      privacy: {
        prompt: false,
        response: false,
        raw_headers: false,
        provider_keys: false,
      },
    });
    expect(decision.trace.candidate_targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          node: 'n1',
          selected: true,
          scores: expect.objectContaining({
            cost: expect.any(Number),
            context: expect.any(Number),
          }),
        }),
        expect.objectContaining({
          node: 'n2',
          circuit_state: 'OPEN',
          filter_reasons: expect.arrayContaining(['circuit_open']),
        }),
      ]),
    );
    expect(decision.trace.filters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ node: 'n2', stage: 'circuit_breaker' }),
      ]),
    );
  });

  it('should prefer reasoning-capable targets when reasoning is requested', () => {
    const capabilityService = {
      resolveModelModalities: jest.fn().mockReturnValue(['text']),
      resolveModelRoutingCapabilities: jest.fn().mockImplementation((_node: string, model: string) => ({
        structured_output: null,
        supports_reasoning: model === 'reasoning-model',
        pricing: undefined,
      })),
    };
    const svc = makeRoutingService({
      tiers: {
        standard: {
          primary: { node: 'n1', model: 'fast-model' },
          fallbacks: [{ node: 'n2', model: 'reasoning-model' }],
        },
      },
      capabilityService,
    });

    const decision = svc.resolve('standard' as Tier, 0.5, undefined, null, ['text'], {
      requires_reasoning: true,
      reasoning_effort: 'high',
      required_capabilities: ['text', 'reasoning'],
    });

    expect(decision.primary).toEqual({ node: 'n2', model: 'reasoning-model' });
    expect(decision.trace.constraints).toMatchObject({
      requires_reasoning: true,
      reasoning_effort: 'high',
    });
    expect(decision.trace.candidate_targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          node: 'n2',
          metrics: expect.objectContaining({ reasoning: true }),
        }),
      ]),
    );
  });

  // ── Null domain hint ─────────────────────────────────────

  it('should handle null domain hint', () => {
    const svc = makeRoutingService();
    const decision = svc.resolve('simple' as Tier, 0.1, undefined, null);
    expect(decision.domainHint).toBeNull();
  });

  // ── Domain hint reorder only when > 1 target ─────────────

  it('should not reorder when only one target is available', () => {
    const circuitBreaker = {
      isAvailable: jest.fn().mockImplementation((node: string) => node === 'n1'),
      getCircuitState: jest.fn().mockImplementation((node: string) => node === 'n1' ? 'CLOSED' : 'OPEN'),
    };
    const svc = makeRoutingService({
      circuitBreaker,
      domainPreferences: { backend: ['n2', 'n1'] },
    });
    const decision = svc.resolve('simple' as Tier, 0.1, undefined, 'backend');

    // Only n1 is available, no reordering possible
    expect(decision.primary.node).toBe('n1');
  });

  // ── Unified targets + strategy schema ─────────────────────

  it('should use targets schema when present', () => {
    const svc = makeRoutingService({
      tiers: {
        simple: {
          strategy: 'weighted',
          targets: [
            { node: 'n1', model: 'fast-model', weight: 1 },
            { node: 'n2', model: 'medium-model', weight: 1 },
          ],
          primary: { node: 'n2', model: 'medium-model' },
          fallbacks: [],
        },
      },
    });

    const decision = svc.resolve('simple' as Tier, 0.1, 'sticky');

    expect(['n1', 'n2']).toContain(decision.primary.node);
    expect(decision.loadBalancing.source).toBe('targets');
    expect(decision.loadBalancing.strategy).toBe('weighted');
  });

  it('should rotate targets with round_robin strategy', () => {
    const svc = makeRoutingService({
      tiers: {
        simple: {
          strategy: 'round_robin',
          targets: [
            { node: 'n1', model: 'fast-model' },
            { node: 'n2', model: 'medium-model' },
          ],
        },
      },
    });

    expect(svc.resolve('simple' as Tier, 0.1).primary.node).toBe('n1');
    expect(svc.resolve('simple' as Tier, 0.1).primary.node).toBe('n2');
    expect(svc.resolve('simple' as Tier, 0.1).primary.node).toBe('n1');
  });

  it('should choose deterministic cold-start targets before least_latency metrics exist', () => {
    const svc = makeRoutingService({
      tiers: {
        simple: {
          strategy: 'least_latency',
          targets: [
            { node: 'n1', model: 'fast-model' },
            { node: 'n2', model: 'medium-model' },
          ],
        },
      },
    });

    expect(svc.resolve('simple' as Tier, 0.1).primary.node).toBe('n1');
    svc.recordTargetResult('n1', 'fast-model', 200, 200);
    expect(svc.resolve('simple' as Tier, 0.1).primary.node).toBe('n2');
  });

  it('should choose the lowest sliding-window latency once least_latency is warm', () => {
    const svc = makeRoutingService({
      tiers: {
        simple: {
          strategy: 'least_latency',
          targets: [
            { node: 'n1', model: 'fast-model' },
            { node: 'n2', model: 'medium-model' },
          ],
        },
      },
    });

    svc.recordTargetResult('n1', 'fast-model', 250, 200);
    svc.recordTargetResult('n2', 'medium-model', 80, 200);
    svc.recordTargetResult('n2', 'medium-model', 100, 200);

    const decision = svc.resolve('simple' as Tier, 0.1);

    expect(decision.primary.node).toBe('n2');
    expect(decision.loadBalancing.strategy).toBe('least_latency');
  });

  it('should expose recent selection and latency status for dashboard', () => {
    const svc = makeRoutingService({
      tiers: {
        simple: {
          strategy: 'least_latency',
          targets: [
            { node: 'n1', model: 'fast-model', weight: 30 },
            { node: 'n2', model: 'medium-model', weight: 70 },
          ],
        },
      },
    });
    svc.recordTargetResult('n1', 'fast-model', 120, 200);

    svc.resolve('simple' as Tier, 0.1);
    const status = svc.getRoutingStatus();

    expect(status.simple.strategy).toBe('least_latency');
    expect(status.simple.targets[0].avg_latency_ms).toBe(120);
    expect(status.simple.last_selected?.node).toBe('n2');
    expect(status.simple.last_selected?.reason).toContain('cold-start');
  });

  it('should keep split precedence over targets', () => {
    const svc = makeRoutingService({
      tiers: {
        simple: {
          strategy: 'round_robin',
          targets: [{ node: 'n2', model: 'medium-model', weight: 100 }],
          primary: { node: 'n1', model: 'fast-model' },
          fallbacks: [],
          split: [
            { node: 'n1', model: 'fast-model', weight: 100, name: 'legacy-split' },
          ],
        },
      },
    });

    const decision = svc.resolve('simple' as Tier, 0.1, 'session');

    expect(decision.primary.node).toBe('n1');
    expect(decision.experimentGroup).toBe('simple:legacy-split');
    expect(decision.loadBalancing.source).toBe('split');
  });

  it('should prefer the lowest estimated cost when routing.optimization is cost', () => {
    const capabilityService = {
      resolveModelModalities: jest.fn().mockReturnValue(['text']),
      resolveModelRoutingCapabilities: jest.fn().mockImplementation((_nodeId: string, model: string) => ({
        structured_output: null,
        pricing:
          model === 'cheap-model'
            ? { input: 0.1, output: 0.2 }
            : { input: 5, output: 15 },
      })),
    };
    const svc = makeRoutingService({
      optimization: 'cost',
      capabilityService,
      tiers: {
        standard: {
          strategy: 'weighted',
          targets: [
            { node: 'n2', model: 'expensive-model', weight: 100 },
            { node: 'n1', model: 'cheap-model', weight: 1 },
          ],
        },
      },
    });

    const decision = svc.resolve('standard' as Tier, 0.4, undefined, null, undefined, {
      estimated_input_tokens: 1000,
      estimated_output_tokens: 500,
      estimated_context_tokens: 1500,
    });

    expect(decision.primary.model).toBe('cheap-model');
    expect(decision.loadBalancing.strategy).toBe('cost');
  });

  it('should prefer cache-adjusted provider paths when cache reads are observed', () => {
    const capabilityService = {
      resolveModelModalities: jest.fn().mockReturnValue(['text']),
      resolveModelRoutingCapabilities: jest.fn().mockImplementation((_nodeId: string, model: string) => ({
        structured_output: null,
        prompt_cache: model === 'cache-model',
        read_cache: model === 'cache-model',
        pricing:
          model === 'cache-model'
            ? { input: 10, output: 0, cache_read_input: 0.1 }
            : { input: 2, output: 0 },
      })),
    };
    const svc = makeRoutingService({
      optimization: 'cost',
      capabilityService,
      tiers: {
        standard: {
          strategy: 'weighted',
          targets: [
            { node: 'n1', model: 'no-cache-model', weight: 100 },
            { node: 'n2', model: 'cache-model', weight: 1 },
          ],
        },
      },
    });
    svc.recordTargetUsage('n2', 'cache-model', { cache_read_input_tokens: 800 });

    const decision = svc.resolve('standard' as Tier, 0.4, undefined, null, undefined, {
      estimated_input_tokens: 1_000_000,
      estimated_output_tokens: 0,
      local_prompt_cache_eligible: true,
      local_prompt_cache_hit: false,
      local_prompt_cache_lookup: 'miss',
    });

    expect(decision.primary.model).toBe('cache-model');
    expect(decision.loadBalancing.strategy).toBe('cost');
    const selected = decision.trace.candidate_targets.find((candidate) => candidate.selected);
    expect(selected?.cache_evidence).toMatchObject({
      provider_prompt_cache: true,
      provider_read_cache: true,
      observed_cache_hit_rate: 1,
      reason: 'provider_cache_read_price_preferred',
    });
    expect(selected?.scores.cache).toBeGreaterThan(0.5);
    expect(decision.trace.cache_evidence).toMatchObject({
      local_prompt_cache_lookup: 'miss',
      provider_cache_preference: true,
    });
  });

  it('should apply cache affinity bonus during cost optimization when a warm cache session exists', () => {
    const cacheAffinityService = {
      getCacheAffinity: jest.fn().mockImplementation((sessionKey: string | undefined, node: string) =>
        sessionKey === 'session-1' && node === 'n2'
          ? {
              active: true,
              bonus: 0.35,
              reason: 'cache_affinity_active',
              provider_cache_ttl_seconds: 600,
              time_since_last_cache_hit_seconds: 18,
              estimated_cache_hit_probability: 0.91,
              consecutive_count: 3,
              cache_type: 'automatic',
            }
          : inactiveAffinityResult(),
      ),
      recordRouteResult: jest.fn(),
    };
    const capabilityService = {
      resolveModelModalities: jest.fn().mockReturnValue(['text']),
      resolveModelRoutingCapabilities: jest.fn().mockImplementation((_nodeId: string, model: string) => ({
        structured_output: null,
        prompt_cache: model === 'warm-cache-model',
        read_cache: model === 'warm-cache-model',
        supports_cache: model === 'warm-cache-model',
        cache_type: model === 'warm-cache-model' ? 'automatic' : 'none',
        cache_ttl_seconds: model === 'warm-cache-model' ? 600 : null,
        pricing:
          model === 'cheapest-model'
            ? { input: 1.0, output: 0 }
            : model === 'warm-cache-model'
              ? { input: 1.2, output: 0, cache_read_input: 0.12 }
              : { input: 2.0, output: 0 },
      })),
    };
    const svc = makeRoutingService({
      optimization: 'cost',
      capabilityService,
      cacheAffinityService,
      tiers: {
        standard: {
          strategy: 'weighted',
          targets: [
            { node: 'n1', model: 'cheapest-model', weight: 1 },
            { node: 'n2', model: 'warm-cache-model', weight: 1 },
            { node: 'n3', model: 'expensive-model', weight: 1 },
          ],
        },
      },
    });

    const decision = svc.resolve('standard' as Tier, 0.4, 'session-1', null, undefined, {
      estimated_input_tokens: 1_000_000,
      estimated_output_tokens: 0,
    });

    expect(decision.primary.model).toBe('warm-cache-model');
    expect(decision.trace.final_selection.reason).toContain('cache affinity kept the session');
    expect(
      decision.trace.candidate_targets.find((candidate) => candidate.model === 'warm-cache-model')
        ?.cache_evidence,
    ).toMatchObject({
      cache_affinity_active: true,
      cache_affinity_reason: 'cache_affinity_active',
      cache_affinity_bonus: 0.35,
      provider_cache_ttl_seconds: 600,
      time_since_last_cache_hit_seconds: 18,
      estimated_cache_hit_probability: 0.91,
    });
  });

  it('should suppress cache affinity when the candidate circuit is open', () => {
    const cacheAffinityService = {
      getCacheAffinity: jest.fn().mockImplementation((sessionKey: string | undefined, node: string) =>
        sessionKey === 'session-1' && node === 'n2'
          ? {
              active: true,
              bonus: 0.35,
              reason: 'cache_affinity_active',
              provider_cache_ttl_seconds: 600,
              time_since_last_cache_hit_seconds: 12,
              estimated_cache_hit_probability: 0.88,
              consecutive_count: 2,
              cache_type: 'automatic',
            }
          : inactiveAffinityResult(),
      ),
      recordRouteResult: jest.fn(),
    };
    const capabilityService = {
      resolveModelModalities: jest.fn().mockReturnValue(['text']),
      resolveModelRoutingCapabilities: jest.fn().mockImplementation((_nodeId: string, model: string) => ({
        structured_output: null,
        prompt_cache: model === 'warm-cache-model',
        read_cache: model === 'warm-cache-model',
        supports_cache: model === 'warm-cache-model',
        cache_type: model === 'warm-cache-model' ? 'automatic' : 'none',
        cache_ttl_seconds: model === 'warm-cache-model' ? 600 : null,
        pricing:
          model === 'cheapest-model'
            ? { input: 1.0, output: 0 }
            : model === 'warm-cache-model'
              ? { input: 1.2, output: 0, cache_read_input: 0.12 }
              : { input: 2.0, output: 0 },
      })),
    };
    const circuitBreaker = {
      isAvailable: jest.fn().mockReturnValue(true),
      getCircuitState: jest.fn().mockImplementation((node: string) =>
        node === 'n2' ? 'OPEN' : 'CLOSED',
      ),
    };
    const svc = makeRoutingService({
      optimization: 'cost',
      capabilityService,
      cacheAffinityService,
      circuitBreaker,
      tiers: {
        standard: {
          strategy: 'weighted',
          targets: [
            { node: 'n1', model: 'cheapest-model', weight: 1 },
            { node: 'n2', model: 'warm-cache-model', weight: 1 },
            { node: 'n3', model: 'expensive-model', weight: 1 },
          ],
        },
      },
    });

    const decision = svc.resolve('standard' as Tier, 0.4, 'session-1', null, undefined, {
      estimated_input_tokens: 1_000_000,
      estimated_output_tokens: 0,
    });

    expect(decision.primary.model).toBe('cheapest-model');
    expect(
      decision.trace.candidate_targets.find((candidate) => candidate.model === 'warm-cache-model')
        ?.cache_evidence,
    ).toMatchObject({
      cache_affinity_active: false,
      cache_affinity_reason: 'circuit_open',
      cache_affinity_bonus: null,
    });
  });

  it('should remove targets whose configured context window is too small', () => {
    const capabilityService = {
      resolveModelModalities: jest.fn().mockReturnValue(['text']),
      resolveModelRoutingCapabilities: jest.fn().mockImplementation((_nodeId: string, model: string) => ({
        structured_output: null,
        max_context_tokens: model === 'short-model' ? 8000 : 32000,
      })),
    };
    const svc = makeRoutingService({
      capabilityService,
      tiers: {
        standard: {
          targets: [
            { node: 'n1', model: 'short-model' },
            { node: 'n2', model: 'long-model' },
          ],
        },
      },
    });

    const decision = svc.resolve('standard' as Tier, 0.4, undefined, null, undefined, {
      estimated_context_tokens: 9000,
    });

    expect(decision.primary.model).toBe('long-model');
    expect(decision.fallbacks).toHaveLength(0);
  });

  it('should demote near-limit context targets when a longer-context target exists', () => {
    const capabilityService = {
      resolveModelModalities: jest.fn().mockReturnValue(['text']),
      resolveModelRoutingCapabilities: jest.fn().mockImplementation((_nodeId: string, model: string) => ({
        structured_output: null,
        max_context_tokens: model === 'near-model' ? 10000 : 50000,
      })),
    };
    const svc = makeRoutingService({
      capabilityService,
      tiers: {
        standard: {
          targets: [
            { node: 'n1', model: 'near-model' },
            { node: 'n2', model: 'long-model' },
          ],
        },
      },
    });

    const decision = svc.resolve('standard' as Tier, 0.4, undefined, null, undefined, {
      estimated_context_tokens: 9000,
    });

    expect(decision.primary.model).toBe('long-model');
    expect(decision.fallbacks[0].model).toBe('near-model');
  });

  it('should reject automatic routes when every configured target is over context window', () => {
    const capabilityService = {
      resolveModelModalities: jest.fn().mockReturnValue(['text']),
      resolveModelRoutingCapabilities: jest.fn().mockReturnValue({
        structured_output: null,
        max_context_tokens: 4000,
      }),
    };
    const svc = makeRoutingService({
      capabilityService,
      tiers: {
        standard: {
          targets: [
            { node: 'n1', model: 'short-a' },
            { node: 'n2', model: 'short-b' },
          ],
        },
      },
    });

    expect(() =>
      svc.resolve('standard' as Tier, 0.4, undefined, null, undefined, {
        estimated_context_tokens: 5000,
      }),
    ).toThrow('No route targets for tier "standard" can fit');
  });
});

describe('RoutingService — embeddings', () => {
  const embeddingNodes = [
    {
      id: 'cheap',
      tags: ['fast'],
      embedding_models: ['text-embedding-3-small'],
    },
    {
      id: 'quality',
      tags: ['quality'],
      embedding_models: ['text-embedding-3-large'],
    },
  ];

  it('should choose the lowest priced embedding target for auto routing', () => {
    const svc = makeRoutingService({
      nodes: embeddingNodes,
      capabilityService: {
        resolveModelModalities: jest.fn().mockReturnValue(['text']),
        resolveModelRoutingCapabilities: jest.fn().mockImplementation((_node: string, model: string) => ({
          structured_output: null,
          dimensions: model.includes('small') ? [512, 1536] : [1024, 3072],
          pricing: model.includes('small')
            ? { input: 0.02, output: 0 }
            : { input: 0.13, output: 0 },
        })),
      },
    });

    const route = svc.resolveEmbeddingRoute('auto', 1536);

    expect(route.mode).toBe('auto');
    expect(route.primary).toEqual({ node: 'cheap', model: 'text-embedding-3-small' });
    expect(route.fallbacks).toHaveLength(0);
  });

  it('should filter embedding targets by requested dimensions', () => {
    const svc = makeRoutingService({
      nodes: embeddingNodes,
      capabilityService: {
        resolveModelModalities: jest.fn().mockReturnValue(['text']),
        resolveModelRoutingCapabilities: jest.fn().mockImplementation((_node: string, model: string) => ({
          structured_output: null,
          dimensions: model.includes('small') ? [512, 1536] : [1024, 3072],
          pricing: model.includes('small')
            ? { input: 0.02, output: 0 }
            : { input: 0.13, output: 0 },
        })),
      },
    });

    const route = svc.resolveEmbeddingRoute('auto', 3072);

    expect(route.primary).toEqual({ node: 'quality', model: 'text-embedding-3-large' });
  });

  it('should resolve direct embedding models and keep compatible fallbacks', () => {
    const svc = makeRoutingService({
      nodes: embeddingNodes,
      capabilityService: {
        resolveModelModalities: jest.fn().mockReturnValue(['text']),
        resolveModelRoutingCapabilities: jest.fn().mockReturnValue({
          structured_output: null,
          dimensions: [1536],
          pricing: { input: 0.1, output: 0 },
        }),
      },
    });

    const route = svc.resolveEmbeddingRoute('text-embedding-3-small', 1536);

    expect(route.mode).toBe('direct');
    expect(route.primary).toEqual({ node: 'cheap', model: 'text-embedding-3-small' });
  });
});

describe('RoutingService — rerank', () => {
  const rerankNodes = [
    {
      id: 'cheap',
      tags: ['fast'],
      rerank_models: ['rerank-small'],
    },
    {
      id: 'quality',
      tags: ['quality'],
      rerank_models: ['rerank-large'],
    },
  ];

  it('should choose the lowest priced healthy rerank target for auto routing', () => {
    const svc = makeRoutingService({
      nodes: rerankNodes,
      capabilityService: {
        resolveModelModalities: jest.fn().mockReturnValue(['rerank']),
        resolveModelRoutingCapabilities: jest.fn().mockImplementation((_node: string, model: string) => ({
          modalities: ['rerank'],
          input_types: ['text', 'documents'],
          output_types: ['ranked_documents'],
          supports_rerank: true,
          structured_output: null,
          pricing: model.includes('small')
            ? { input: 0.01, output: 0 }
            : { input: 0.1, output: 0 },
        })),
      },
    });

    const route = svc.resolveRerankRoute('auto');

    expect(route.mode).toBe('auto');
    expect(route.primary).toEqual({ node: 'cheap', model: 'rerank-small' });
    expect(route.fallbacks).toEqual([{ node: 'quality', model: 'rerank-large' }]);
    expect(route.trace?.modality_evidence).toMatchObject({
      requested_modality: 'rerank',
      input_types: ['text', 'documents'],
      output_types: ['ranked_documents'],
      required_capabilities: ['rerank'],
    });
    expect(route.trace?.candidate_targets[0].capability_evidence).toMatchObject({
      requested_modality: 'rerank',
      filtered_by_capability: false,
      pricing_source: 'config',
      pricing_used_from: 'gateway_config',
      estimated_cost_basis: 'input_output_per_1m_tokens',
      catalog_source: 'config',
    });
  });

  it('should filter rerank targets by API key/namespace permissions', () => {
    const svc = makeRoutingService({
      nodes: rerankNodes,
      capabilityService: {
        resolveModelModalities: jest.fn().mockReturnValue(['text']),
        resolveModelRoutingCapabilities: jest.fn().mockReturnValue({
          structured_output: null,
          pricing: { input: 0.1, output: 0 },
        }),
      },
    });

    const route = svc.resolveRerankRoute('auto', (target) => target.node === 'quality');

    expect(route.primary).toEqual({ node: 'quality', model: 'rerank-large' });
    expect(route.fallbacks).toHaveLength(0);
  });

  it('should keep unhealthy rerank targets out of auto routing', () => {
    const svc = makeRoutingService({
      nodes: rerankNodes,
      circuitBreaker: {
        isAvailable: jest.fn().mockImplementation((node: string) => node !== 'cheap'),
      },
      capabilityService: {
        resolveModelModalities: jest.fn().mockReturnValue(['text']),
        resolveModelRoutingCapabilities: jest.fn().mockReturnValue({
          structured_output: null,
          pricing: { input: 0.1, output: 0 },
        }),
      },
    });

    const route = svc.resolveRerankRoute('auto');

    expect(route.primary).toEqual({ node: 'quality', model: 'rerank-large' });
  });
});

describe('RoutingService — images and audio', () => {
  const mediaNodes = [
    {
      id: 'cheap-media',
      tags: ['fast'],
      image_models: ['gpt-image-mini'],
      audio_models: ['tts-mini'],
    },
    {
      id: 'quality-media',
      tags: ['quality'],
      image_models: ['gpt-image-1'],
      audio_models: ['gpt-4o-mini-transcribe'],
    },
  ];

  it('should choose the lowest priced image target for auto routing', () => {
    const svc = makeRoutingService({
      nodes: mediaNodes,
      capabilityService: {
        resolveModelModalities: jest.fn().mockReturnValue(['vision']),
        resolveModelRoutingCapabilities: jest.fn().mockImplementation((_node: string, model: string) => ({
          structured_output: null,
          pricing: model.includes('mini')
            ? { input: 0.5, output: 0 }
            : { input: 5, output: 0 },
        })),
      },
    });

    const route = svc.resolveMediaRoute('image_generation', 'auto');

    expect(route.mode).toBe('auto');
    expect(route.primary).toEqual({ node: 'cheap-media', model: 'gpt-image-mini' });
    expect(route.fallbacks[0]).toEqual({ node: 'quality-media', model: 'gpt-image-1' });
    expect(svc.resolveMediaRoute('image_variation', 'auto').primary).toEqual({
      node: 'cheap-media',
      model: 'gpt-image-mini',
    });
  });

  it('should resolve direct audio models and apply target permissions', () => {
    const svc = makeRoutingService({ nodes: mediaNodes });

    expect(() =>
      svc.resolveMediaRoute(
        'audio_speech',
        'tts-mini',
        (target) => target.node !== 'cheap-media',
      ),
    ).toThrow('This API key is not allowed');
  });

  it('should skip unavailable media targets when healthy alternatives exist', () => {
    const svc = makeRoutingService({
      nodes: mediaNodes,
      circuitBreaker: {
        isAvailable: jest.fn().mockImplementation((node: string) => node !== 'cheap-media'),
      },
      capabilityService: {
        resolveModelModalities: jest.fn().mockReturnValue(['audio']),
        resolveModelRoutingCapabilities: jest.fn().mockReturnValue({
          structured_output: null,
          pricing: { input: 1, output: 0 },
        }),
      },
    });

    const route = svc.resolveMediaRoute('audio_transcription', 'auto');

    expect(route.primary).toEqual({ node: 'quality-media', model: 'gpt-4o-mini-transcribe' });
    expect(svc.resolveMediaRoute('audio_translation', 'auto').primary).toEqual({
      node: 'quality-media',
      model: 'gpt-4o-mini-transcribe',
    });
  });

  it('should record modality evidence and file-size filters for media route traces', () => {
    const svc = makeRoutingService({
      nodes: mediaNodes,
      capabilityService: {
        resolveModelModalities: jest.fn().mockReturnValue(['image']),
        resolveModelRoutingCapabilities: jest.fn().mockImplementation((node: string, model: string) => ({
          modalities: ['image'],
          input_types: ['text'],
          output_types: ['image'],
          max_file_size: node === 'cheap-media' ? 100 : 10_000,
          structured_output: null,
          pricing: model.includes('mini')
            ? { input: 0.5, output: 0 }
            : { input: 5, output: 0 },
        })),
      },
    });

    const route = svc.resolveMediaRoute(
      'image_generation',
      'auto',
      () => true,
      {
        requested_modality: 'image',
        input_types: ['text'],
        output_types: ['image'],
        file_count: 1,
        byte_size: 2048,
        required_capabilities: ['image'],
        endpoint_strategy: 'image_generation',
        source_format: 'image_generation',
      },
    );

    expect(route.primary).toEqual({ node: 'quality-media', model: 'gpt-image-1' });
    expect(route.trace?.modality_evidence).toMatchObject({
      requested_modality: 'image',
      file_count: 1,
      byte_size: 2048,
    });
    expect(route.trace?.modality_evidence?.filtered_by_file_size).toEqual([
      expect.objectContaining({
        node: 'cheap-media',
        model: 'gpt-image-mini',
        max_file_size: 100,
      }),
    ]);
    expect(route.trace?.candidate_targets[0].filter_reasons).toContain('file_size_exceeded');
    expect(route.trace?.candidate_targets[0].capability_evidence).toMatchObject({
      endpoint_status: 'default',
      filtered_by_file_size: true,
    });
  });
});

describe('RoutingService — API key model pools', () => {
  const nodes = ['n1', 'n2'].map((id) => ({
    id,
    models: ['shared-model'],
    protocol: 'chat_completions',
  }));
  const targets = nodes.map((node) => ({
    node: node.id,
    model: 'shared-model',
    weight: 1,
  }));

  it('balances concurrent selection and isolates each key/workspace scope', async () => {
    const service = makeRoutingService({ nodes });
    const selected = await Promise.all(
      Array.from(
        { length: 20 },
        async () =>
          service.resolveKeyModelPool(
            'workspace-a/key-a',
            'round_robin',
            targets,
            {},
          ).primary.node,
      ),
    );
    expect(selected.filter((n) => n === 'n1')).toHaveLength(10);
    expect(selected.filter((n) => n === 'n2')).toHaveLength(10);
    service.resolveKeyModelPool(
      'workspace-a/key-a',
      'round_robin',
      targets,
      {},
    );
    expect(
      service.resolveKeyModelPool(
        'workspace-a/key-b',
        'round_robin',
        targets,
        {},
      ).primary.node,
    ).toBe('n1');
    expect(
      service.resolveKeyModelPool(
        'workspace-b/key-a',
        'round_robin',
        targets,
        {},
      ).primary.node,
    ).toBe('n1');
    expect(
      service.resolveKeyModelPool(
        'workspace-a/key-a',
        'round_robin',
        targets,
        {},
      ).primary.node,
    ).toBe('n2');
  });

  it('respects weights and ignores global optimizations', () => {
    const service = makeRoutingService({ nodes, optimization: 'lowest_cost' });
    const optimize = jest.spyOn(service as any, 'selectTargetByOptimization');
    const random = jest.spyOn(Math, 'random');
    try {
      const weighted = [{ ...targets[0], weight: 3 }, targets[1]];
      random.mockReturnValue(0.7);
      expect(
        service.resolveKeyModelPool('key', 'weighted', weighted, {}).primary
          .node,
      ).toBe('n1');
      random.mockReturnValue(0.9);
      const route = service.resolveKeyModelPool(
        'key',
        'weighted',
        weighted,
        {},
      );
      expect(route.primary.node).toBe('n2');
      expect(route.fallbacks).toEqual([{ node: 'n1', model: 'shared-model' }]);
      expect(optimize).not.toHaveBeenCalled();
    } finally {
      random.mockRestore();
    }
  });

  it('filters missing, disabled, changed-model and circuit-open nodes, failing closed when empty', () => {
    const circuitBreaker = {
      isAvailable: jest.fn((node: string) => node !== 'n1'),
    };
    const service = makeRoutingService({ nodes, circuitBreaker });
    expect(
      service.resolveKeyModelPool(
        'key',
        'round_robin',
        [...targets, { node: 'missing', model: 'shared-model', weight: 1 }],
        {},
      ).primary.node,
    ).toBe('n2');
    circuitBreaker.isAvailable.mockReturnValue(false);
    expect(() =>
      service.resolveKeyModelPool('key', 'round_robin', targets, {}),
    ).toThrow('No healthy');
    for (const unavailable of [
      { ...nodes[1], disabled: true },
      { ...nodes[1], models: ['different'] },
    ]) {
      const svc = makeRoutingService({ nodes: [nodes[0], unavailable] });
      expect(
        svc.resolveKeyModelPool('key', 'round_robin', targets, {}),
      ).toEqual({
        primary: { node: 'n1', model: 'shared-model' },
        fallbacks: [],
      });
    }
  });

  it('reuses modality, context and structured-output constraints for primary and fallbacks', () => {
    const capabilities = {
      resolveModelModalities: jest.fn((node: string) =>
        node === 'n1' ? ['text'] : ['text', 'vision'],
      ),
      resolveModelRoutingCapabilities: jest.fn((node: string) => ({
        max_context_tokens: node === 'n1' ? 100 : 1000,
        structured_output: node === 'n2',
      })),
    };
    const service = makeRoutingService({
      nodes,
      capabilityService: capabilities,
    });
    expect(
      service.resolveKeyModelPool('key', 'round_robin', targets, {}, ['vision'])
        .primary.node,
    ).toBe('n2');
    const route = service.resolveKeyModelPool('key', 'round_robin', targets, {
      estimated_context_tokens: 200,
      requires_structured_output: true,
    });
    expect(route).toEqual({
      primary: { node: 'n2', model: 'shared-model' },
      fallbacks: [],
    });
    expect(() =>
      service.resolveKeyModelPool('key', 'round_robin', targets, {
        estimated_context_tokens: 2000,
      }),
    ).toThrow('context tokens');
  });

  it('bounds per-key counters without evicting global routing counters', () => {
    const service = makeRoutingService({ nodes });
    (service as any).roundRobinCounters.set('standard', 1);
    for (let i = 0; i < 10001; i++)
      service.resolveKeyModelPool(`key-${i}`, 'round_robin', targets, {});
    expect((service as any).keyModelRoundRobinCounters.size).toBe(10000);
    expect((service as any).roundRobinCounters.get('standard')).toBe(1);
  });
});

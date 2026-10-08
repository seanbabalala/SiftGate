import { AdaptiveRoutingStatsService } from '../../src/routing/adaptive-routing-stats.service';
import { RoutingRecommendationService } from '../../src/routing/routing-recommendation.service';
import { mockConfigService } from '../helpers';

function log(overrides: Record<string, unknown> = {}) {
  return {
    timestamp: new Date(),
    tier: 'standard',
    node_id: 'openai',
    model: 'gpt-4o',
    status_code: 200,
    is_fallback: false,
    latency_ms: 100,
    cost_usd: 0.001,
    retry_count: 0,
    ...overrides,
  } as any;
}

describe('AdaptiveRoutingStatsService', () => {
  it('aggregates node:model sliding-window stats with percentiles and fallback rate', async () => {
    const query = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([
        log({ latency_ms: 100, cost_usd: 0.001 }),
        log({ latency_ms: 200, cost_usd: 0.002 }),
        log({ status_code: 500, latency_ms: 500, cost_usd: 0, is_fallback: true }),
        log({
          node_id: 'claude',
          model: 'claude-sonnet',
          latency_ms: 80,
          cost_usd: 0.003,
          is_fallback: true,
        }),
      ]),
    };
    const repo = {
      createQueryBuilder: jest.fn(() => query),
      metadata: {
        findColumnWithPropertyName: (propertyName: string) => ({
          propertyName,
          setEntityValue: (entity: Record<string, unknown>, value: unknown) => { entity[propertyName] = value; },
        }),
      },
      manager: { connection: { driver: { prepareHydratedValue: (value: unknown) => value } } },
    };
    const service = new AdaptiveRoutingStatsService(repo as any);

    const result = await service.getWindow({ windowHours: 6, sampleLimit: 500, minSamples: 2 });
    const openai = result.targets.find((target) => target.key === 'openai:gpt-4o');

    expect(query.select).toHaveBeenCalledWith([]);
    expect(query.take).toHaveBeenCalledWith(500);
    expect(query.orderBy).toHaveBeenCalledWith('log.timestamp', 'DESC');
    expect(query.addSelect.mock.calls).toEqual([
      ['log.timestamp', 'timestamp'], ['log.tier', 'tier'],
      ['log.node_id', 'node_id'], ['log.model', 'model'],
      ['log.status_code', 'status_code'], ['log.is_fallback', 'is_fallback'],
      ['log.latency_ms', 'latency_ms'], ['log.cost_usd', 'cost_usd'],
      ['log.retry_count', 'retry_count'],
    ]);
    expect(result.observed_calls).toBe(4);
    expect(openai).toMatchObject({
      calls: 3,
      successes: 2,
      failures: 1,
      success_rate: 0.6667,
      fallback_calls: 1,
      fallback_rate: 0.3333,
      p50_latency_ms: 200,
      p95_latency_ms: 500,
      total_cost_usd: 0.003,
    });
    expect(result.tiers[0].targets.length).toBe(2);
  });
});

describe('RoutingRecommendationService', () => {
  it('recommends a better observed fallback without applying config changes', async () => {
    const stats = {
      generated_at: new Date().toISOString(),
      window_hours: 24,
      sample_limit: 1000,
      min_samples: 5,
      observed_calls: 20,
      targets: [],
      tiers: [
        {
          tier: 'standard',
          calls: 20,
          fallback_calls: 8,
          fallback_rate: 0.4,
          targets: [
            {
              key: 'openai:gpt-4o',
              tier: 'standard',
              node: 'openai',
              model: 'gpt-4o',
              calls: 10,
              successes: 9,
              failures: 1,
              success_rate: 0.9,
              fallback_calls: 0,
              fallback_rate: 0,
              retry_count: 1,
              avg_latency_ms: 420,
              p50_latency_ms: 400,
              p95_latency_ms: 900,
              total_cost_usd: 0.02,
              avg_cost_usd: 0.002,
              cost_per_1k_calls_usd: 2,
              first_seen_at: null,
              last_seen_at: null,
            },
            {
              key: 'claude:sonnet',
              tier: 'standard',
              node: 'claude',
              model: 'sonnet',
              calls: 10,
              successes: 10,
              failures: 0,
              success_rate: 1,
              fallback_calls: 10,
              fallback_rate: 1,
              retry_count: 0,
              avg_latency_ms: 200,
              p50_latency_ms: 180,
              p95_latency_ms: 350,
              total_cost_usd: 0.01,
              avg_cost_usd: 0.001,
              cost_per_1k_calls_usd: 1,
              first_seen_at: null,
              last_seen_at: null,
            },
          ],
        },
      ],
    };
    const statsService = { getWindow: jest.fn().mockResolvedValue(stats) };
    const config = mockConfigService({
      routing: {
        tiers: {
          standard: {
            primary: { node: 'openai', model: 'gpt-4o' },
            fallbacks: [{ node: 'claude', model: 'sonnet' }],
          },
        },
        scoring: { simple_max: -0.1, standard_max: 0.08, complex_max: 0.35 },
      },
    });
    const service = new RoutingRecommendationService(config, statsService as any);

    const result = await service.getRecommendations();
    const recommendation = result.recommendations[0];

    expect(result.mode).toBe('recommendation_only');
    expect(recommendation.type).toBe('promote_primary');
    expect(recommendation.suggested_primary).toEqual({ node: 'claude', model: 'sonnet' });
    expect(recommendation.potential_savings).toEqual(
      expect.objectContaining({
        cost_usd_per_1k_calls: 1,
        p50_latency_ms: 220,
        p95_latency_ms: 550,
      }),
    );
    expect(recommendation.risks.join(' ')).toContain('fallback');
  });

  it('returns collect_more_data when the window is too sparse', async () => {
    const statsService = {
      getWindow: jest.fn().mockResolvedValue({
        generated_at: new Date().toISOString(),
        window_hours: 24,
        sample_limit: 1000,
        min_samples: 5,
        observed_calls: 1,
        targets: [],
        tiers: [],
      }),
    };
    const config = mockConfigService({
      routing: {
        tiers: {
          simple: {
            primary: { node: 'openai', model: 'gpt-4o-mini' },
            fallbacks: [{ node: 'claude', model: 'haiku' }],
          },
        },
        scoring: { simple_max: -0.1, standard_max: 0.08, complex_max: 0.35 },
      },
    });
    const service = new RoutingRecommendationService(config, statsService as any);

    const result = await service.getRecommendations();

    expect(result.recommendations[0]).toMatchObject({
      type: 'collect_more_data',
      suggested_primary: null,
      confidence: 0.2,
    });
  });
});

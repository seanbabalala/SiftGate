import { pricingBenchmarkFixture, runPricingBenchmark, validatePricingBenchmark, PRICING_BENCHMARK_DEFAULTS } from '../../scripts/benchmark-pricing';
import { pricingContentHash } from '../../src/pricing/pricing-json';

describe('bounded pure-pricing benchmark fixtures', () => {
  const small = { models: 2, rules: 2, components: 2, iterations: 4, warmup: 1, seed: 42 };
  it('generates deterministic exact dimensions without vendor rate assumptions', () => {
    const a = pricingBenchmarkFixture(small), b = pricingBenchmarkFixture(small);
    expect(pricingContentHash(a)).toBe(pricingContentHash(b));
    expect(a.books).toHaveLength(2); expect(a.bindings).toHaveLength(2);
    for (const book of a.books) { expect(book.content.groups[0].rules).toHaveLength(2); expect(book.content.groups[0].rules.every(rule => rule.rates.length === 2 && rule.rates.every(rate => rate.operation === 'add'))).toBe(true); }
  });
  it('measures real complete quotes without claiming reduced-size or HTTP acceptance', () => {
    const result = runPricingBenchmark(small);
    expect(result.samples_ms).toHaveLength(4); expect(result.visited_models).toBe(2); expect(result.full_scale).toBe(false); expect(result.quote_slo_met).toBe(false); expect(result.gateway_http_comparison).toBe('not_performed');
  });
  it('caps resource parameters and preserves the exact required acceptance scale', () => {
    expect(PRICING_BENCHMARK_DEFAULTS).toMatchObject({ models: 1000, rules: 20, components: 12, iterations: 10000 });
    for (const options of [{ ...small, models: 1001 }, { ...small, iterations: 10001 }, { ...small, rules: -1 }, { ...small, seed: NaN }]) expect(() => validatePricingBenchmark(options)).toThrow();
  });
});

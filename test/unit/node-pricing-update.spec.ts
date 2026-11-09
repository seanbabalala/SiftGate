import { applyNodePricingUpdates } from '../../src/config/node-pricing-update';
import type { NodeConfig } from '../../src/config/gateway.config';
import { withLegacyCachePricing } from '../../src/config/legacy-pricing-resolution';
import { legacyTokenPriceBook } from '../../src/pricing/legacy-pricing-adapter';

describe('lossless node price updates', () => {
  const original: NodeConfig['model_capabilities'] = {
    model: { modalities: ['text', 'image'], max_context_tokens: 300000, supports_reasoning: true, pricing: { input: 1, output: 2, cache_read_input: 0.1, cache_creation_input: 1.25, video_per_second: 0.15, audio_per_minute: 0.06, source_url: 'https://example.test/prices' } },
    hidden: { dimensions: [512, 1024], pricing: { input: 9, output: 3 } },
  };
  it('patches only explicitly edited numbers while retaining hidden prices and every capability', () => {
    const next = applyNodePricingUpdates(original, [{ model: 'model', action: 'set', input: 0, output: 4 }]);
    expect(next).toEqual({ ...original, model: { ...original.model, pricing: { ...original.model.pricing, input: 0, output: 4 } } });
    expect(original.model.pricing?.input).toBe(1);
    expect(applyNodePricingUpdates(original, [])).toEqual(original);
  });
  it('removes the full legacy price only on explicit inheritance and retains non-price fields', () => {
    const next = applyNodePricingUpdates(original, [{ model: 'model', action: 'inherit' }]);
    expect(next.model.pricing).toBeUndefined(); expect(next.model.modalities).toEqual(['text', 'image']); expect(next.hidden).toEqual(original.hidden);
  });
  it('updates cache read and write independently, including explicit zero, without losing media or capabilities', () => {
    const next = applyNodePricingUpdates(original, [{ model: 'model', action: 'set', input: 1, output: 2, cache_read_input: 0, cache_creation_input: 2.5 }]);
    expect(next.model).toEqual({ ...original.model, pricing: { ...original.model.pricing, cache_read_input: 0, cache_creation_input: 2.5 } });
    expect(applyNodePricingUpdates(next, [{ model: 'model', action: 'set', input: 1, output: 2, cache_creation_input: 3 }]).model.pricing?.cache_read_input).toBe(0);
    expect(original.model.pricing?.cache_read_input).toBe(0.1);
  });
  it('preserves untouched aliases and removes stale aliases when setting or clearing a cache override', () => {
    const aliased = { model: { ...original.model, pricing: { ...original.model.pricing!, cache_read_per_1m_tokens: 0.5, cache_write_per_1m_tokens: 1.5 } } };
    const base = { model: 'model', action: 'set' as const, input: 1, output: 2 };
    expect(applyNodePricingUpdates(aliased, [base])).toEqual(aliased);
    const changed = applyNodePricingUpdates(aliased, [{ ...base, cache_read_input: 0, cache_creation_input: null }]);
    expect(changed.model.pricing).toEqual({ ...original.model.pricing, cache_read_input: 0, cache_creation_input: undefined });
    expect(Object.hasOwn(changed.model.pricing!, 'cache_creation_input')).toBe(false);
    expect(Object.hasOwn(changed.model.pricing!, 'cache_read_per_1m_tokens')).toBe(false);
    expect(Object.hasOwn(changed.model.pricing!, 'cache_write_per_1m_tokens')).toBe(false);
    expect(aliased.model.pricing.cache_write_per_1m_tokens).toBe(1.5);
  });
  it('rejects invalid cache prices and rate fields on inheritance without mutating the original', () => {
    const before = structuredClone(original);
    for (const field of ['cache_read_input', 'cache_creation_input']) {
      for (const value of ['', '0.1', -1, NaN, Infinity, false, {}, []]) {
        expect(() => applyNodePricingUpdates(original, [{ model: 'model', action: 'set', input: 1, output: 2, [field]: value }] as never)).toThrow();
      }
      for (const value of [0, null]) expect(() => applyNodePricingUpdates(original, [{ model: 'model', action: 'inherit', [field]: value }])).toThrow();
    }
    expect(original).toEqual(before);
  });
  it('feeds explicit cache rates into compatibility billing and restores fallback only after reset', () => {
    const update = { model: 'model', action: 'set' as const, input: 2, output: 4, cache_read_input: 0, cache_creation_input: 3 };
    const patched = applyNodePricingUpdates(original, [update]);
    const rates = (pricing: NonNullable<typeof original.model.pricing>) => legacyTokenPriceBook(withLegacyCachePricing(pricing, 'claude-test')).groups[0].rules[0].rates.map(entry => [entry.component.dimension, entry.component.amount]);
    expect(rates(patched.model.pricing!)).toEqual(expect.arrayContaining([
      ['cache_read_tokens', '0'], ['cache_write_tokens', '3'], ['cache_write_5m_tokens', '3'], ['cache_write_1h_tokens', '3'],
    ]));
    const reset = applyNodePricingUpdates(patched, [{ ...update, cache_read_input: null, cache_creation_input: null }]);
    expect(rates(reset.model.pricing!)).toEqual(expect.arrayContaining([
      ['cache_read_tokens', '0.2'], ['cache_write_tokens', '2.5'],
    ]));
  });
  it('rejects blank/coerced, negative, duplicate and prototype-polluting updates', () => {
    for (const update of [ { model: 'model', action: 'set', input: '', output: 1 }, { model: 'model', action: 'set', input: -1, output: 1 }, { model: '__proto__', action: 'inherit' }, { model: 'model', action: 'inherit', input: 0 } ]) expect(() => applyNodePricingUpdates(original, [update] as never)).toThrow();
    expect(() => applyNodePricingUpdates(original, [{ model: 'model', action: 'inherit' }, { model: 'model', action: 'inherit' }])).toThrow();
  });
});

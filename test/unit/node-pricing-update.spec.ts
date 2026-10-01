import { applyNodePricingUpdates } from '../../src/config/node-pricing-update';
import type { NodeConfig } from '../../src/config/gateway.config';

describe('lossless node base-price updates', () => {
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
  it('rejects blank/coerced, negative, duplicate and prototype-polluting updates', () => {
    for (const update of [ { model: 'model', action: 'set', input: '', output: 1 }, { model: 'model', action: 'set', input: -1, output: 1 }, { model: '__proto__', action: 'inherit' }, { model: 'model', action: 'inherit', input: 0 } ]) expect(() => applyNodePricingUpdates(original, [update] as never)).toThrow();
    expect(() => applyNodePricingUpdates(original, [{ model: 'model', action: 'inherit' }, { model: 'model', action: 'inherit' }])).toThrow();
  });
});

import { calculateCost } from '../../src/pricing/cost-calculator';
import { compilePriceBook } from '../../src/pricing/pricing-compiler';
import { PricingCompileError } from '../../src/pricing/pricing-errors';
import { normalizeQuantities } from '../../src/pricing/usage-normalizer';
import { book, rate } from './pricing-fixtures';

function variants() {
  const content = book([rate('base', 'image_count', '0.01', '1')]);
  content.groups.push({
    id: 'quality',
    order: 1,
    required: true,
    rules: [
      {
        id: 'standard',
        priority: 0,
        mode: 'whole_request',
        condition: { media: { quality: ['standard'], size: ['1024x1024'] } },
        rates: [
          { operation: 'replace', component: rate('standard-image', 'image_count', '0.04', '1') },
        ],
      },
      {
        id: 'high',
        priority: 0,
        mode: 'whole_request',
        condition: { media: { quality: ['high'], size: ['1024x1024'] } },
        rates: [
          { operation: 'replace', component: rate('high-image', 'image_count', '0.08', '1') },
        ],
      },
    ],
  });
  return content;
}

const usage = () =>
  normalizeQuantities([{ dimension: 'image_count', value: 3 }], {
    adapter_id: 'synthetic-media',
    adapter_version: '1',
    source: 'provider_job_result',
  });

describe('allowlisted media price conditions', () => {
  it('selects distinct media prices and retains the selection explanation in the cost snapshot', () => {
    const compiled = compilePriceBook(variants(), { book_id: 'images', version_id: '1' });
    const u = usage();
    const result = calculateCost(
      u,
      compiled.resolve(u, { media: { quality: 'high', size: '1024x1024' } }),
    );
    expect(result.amount).toBe('0.240000000');
    expect(result.selection?.media).toEqual({ quality: 'high', size: '1024x1024' });
    expect(result.selection?.evaluations.find((entry) => entry.rule_id === 'high')?.selected).toBe(
      true,
    );
    expect(
      result.selection?.evaluations.find((entry) => entry.rule_id === 'standard')?.reasons,
    ).toContain('media_attribute_mismatch:quality');
  });

  it('STATE-10 does not fall back to a cheap unconditional rule for missing or unknown specifications', () => {
    const content = variants();
    content.groups[1].rules.push({
      id: 'cheap-fallback',
      priority: 0,
      mode: 'whole_request',
      condition: {},
      rates: [],
    });
    content.groups[1].rules[0].priority = 1;
    content.groups[1].rules[1].priority = 1;
    const compiled = compilePriceBook(content, { book_id: 'images', version_id: '1' });
    const u = usage();
    for (const media of [{ quality: 'unexpected', size: '1024x1024' }, { quality: 'high' }, {}]) {
      const price = compiled.resolve(u, { media });
      expect(calculateCost(u, price).amount).toBeNull();
      expect(price.diagnostics.some((entry) => entry.code === 'pricing_unknown_variant')).toBe(
        true,
      );
    }
  });

  it('keeps estimated media selection distinct from observed usage', () => {
    const u = usage();
    const compiled = compilePriceBook(variants(), { book_id: 'images', version_id: '1' });
    const result = calculateCost(
      u,
      compiled.resolve(u, { media: { quality: 'high', size: '1024x1024' }, media_estimated: true }),
    );
    expect(result.status).toBe('estimated');
  });

  it('normalizes exact frame-rate strings and accepts explicit audio-track variants', () => {
    const content = book([rate('video', 'video_seconds', '0.1', '1')]);
    content.groups[0].rules[0].condition.media = {
      frame_rate: ['24.0'],
      audio_track: ['false'],
      width: ['1920'],
      height: ['1080'],
    };
    const u = normalizeQuantities([{ dimension: 'video_seconds', value: '6.4' }], {
      adapter_id: 'synthetic',
      adapter_version: '1',
      source: 'provider_job_result',
    });
    const compiled = compilePriceBook(content, { book_id: 'video', version_id: '1' });
    expect(
      calculateCost(
        u,
        compiled.resolve(u, {
          media: { frame_rate: '24', audio_track: 'false', width: '1920', height: '1080' },
        }),
      ).amount,
    ).toBe('0.640000000');
  });

  it.each([
    { frame_rate: ['24', '24.00'] },
    { width: ['0'] },
    { height: ['1080.0'] },
    { audio_track: ['yes'] },
    { audio_direction: ['both'] },
    { quality: [] },
    { generation_count: ['-1'] },
    { arbitrary_script: ['execute'] },
  ])('rejects malformed or unknown media condition %j', (media) => {
    const content = variants();
    Object.assign(content.groups[1].rules[0].condition, { media });
    expect(() => compilePriceBook(content, { book_id: 'bad', version_id: '1' })).toThrow(
      PricingCompileError,
    );
  });

  it('rejects same-priority overlap in media variants', () => {
    const content = variants();
    content.groups[1].rules[1].condition.media!.quality!.push('standard');
    expect(() => compilePriceBook(content, { book_id: 'bad', version_id: '1' })).toThrow(
      PricingCompileError,
    );
  });
});

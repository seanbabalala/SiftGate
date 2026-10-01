import {
  normalizeCanonicalTokenUsage,
  normalizeQuantities,
} from '../../src/pricing/usage-normalizer';
import type { UsageAdapterIdentity } from '../../src/pricing/usage-normalizer';

const adapter: UsageAdapterIdentity = {
  adapter_id: 'synthetic',
  adapter_version: '1',
  source: 'provider_usage',
};

describe('pricing usage normalization', () => {
  it('rejects complete modality partitions that leave part of the total unaccounted for', () => {
    const usage = normalizeQuantities(
      [
        { dimension: 'output_tokens', value: 100 },
        { dimension: 'text_output_tokens', value: 50 },
        { dimension: 'audio_output_tokens', value: 0 },
        { dimension: 'image_output_tokens', value: 0 },
      ],
      adapter,
    );
    expect(usage.diagnostics[0]?.code).toBe('pricing_usage_conflict');
    expect(usage.quantities.text_output_tokens?.value).toBeNull();
  });

  it('CALC-02 decomposes cache TTL writes without charging the aggregate twice', () => {
    const usage = normalizeCanonicalTokenUsage(
      {
        input_tokens: 10000,
        output_tokens: 0,
        cache_read_input_tokens: 4000,
        cache_creation_input_tokens: 1500,
        cache_creation_5m_input_tokens: 1000,
        cache_creation_1h_input_tokens: 500,
      },
      adapter,
    );
    expect(usage.diagnostics).toEqual([]);
    expect(usage.quantities.uncached_input_tokens?.value).toBe('4500');
    expect(usage.quantities.cache_write_tokens?.value).toBe('0');
    expect(usage.quantities.cache_write_5m_tokens?.subset_of).toBe('total_input_tokens');
  });

  it('CALC-20 retains an unknown-TTL remainder instead of guessing 5m', () => {
    const usage = normalizeCanonicalTokenUsage(
      {
        input_tokens: 2000,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 1000,
      },
      adapter,
    );
    expect(usage.quantities.cache_write_tokens?.value).toBe('1000');
    expect(usage.quantities.cache_write_5m_tokens?.value).toBe('0');
    expect(usage.quantities.cache_write_1h_tokens?.value).toBe('0');
    expect(usage.quantities.uncached_input_tokens?.value).toBe('1000');
  });

  it('does not assume missing cache counters are zero without an adapter contract', () => {
    const missing = normalizeCanonicalTokenUsage({ input_tokens: 100, output_tokens: 2 }, adapter);
    expect(missing.quantities.cache_read_tokens?.quality).toBe('missing');
    expect(missing.quantities.uncached_input_tokens?.value).toBeNull();
    const legacy = normalizeCanonicalTokenUsage({ input_tokens: 100, output_tokens: 2 }, adapter, {
      absent_cache_is_zero: true,
    });
    expect(legacy.quantities.uncached_input_tokens?.value).toBe('100');
  });

  it.each([-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1e6', '1.5', ''])(
    'CALC-14 rejects invalid token count %s',
    (value) => {
      const usage = normalizeQuantities([{ dimension: 'output_tokens', value }], adapter);
      expect(usage.quantities.output_tokens?.value).toBeNull();
      expect(usage.diagnostics[0]?.code).toBe('pricing_invalid_quantity');
    },
  );

  it('accepts large string counts and precise fractional seconds', () => {
    const usage = normalizeQuantities(
      [
        { dimension: 'output_tokens', value: '9007199254740993' },
        { dimension: 'video_seconds', value: '6.400' },
      ],
      adapter,
    );
    expect(usage.quantities.output_tokens?.value).toBe('9007199254740993');
    expect(usage.quantities.video_seconds?.value).toBe('6.4');
    expect(usage.diagnostics).toEqual([]);
  });

  it('invalidates inconsistent cache partitions instead of clamping normal input to zero', () => {
    const usage = normalizeCanonicalTokenUsage(
      {
        input_tokens: 10,
        output_tokens: 2,
        cache_read_input_tokens: 20,
        cache_creation_input_tokens: 0,
      },
      adapter,
    );
    expect(usage.diagnostics.some((entry) => entry.code === 'pricing_usage_conflict')).toBe(true);
    expect(usage.quantities.uncached_input_tokens?.value).toBeNull();
    expect(usage.quantities.cache_read_tokens?.value).toBeNull();
  });

  it('rejects cache TTL components that exceed the aggregate', () => {
    const usage = normalizeCanonicalTokenUsage(
      {
        input_tokens: 100,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 10,
        cache_creation_5m_input_tokens: 11,
      },
      adapter,
    );
    expect(usage.quantities.cache_write_5m_tokens?.value).toBeNull();
    expect(usage.quantities.uncached_input_tokens?.value).toBeNull();
    expect(usage.diagnostics[0]?.code).toBe('pricing_usage_conflict');
  });

  it('does not retain a full write aggregate as a remainder when one TTL counter is invalid', () => {
    const usage = normalizeCanonicalTokenUsage(
      {
        input_tokens: 1000,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 100,
        cache_creation_5m_input_tokens: NaN,
        cache_creation_1h_input_tokens: 50,
      },
      adapter,
    );
    expect(usage.quantities.cache_write_tokens?.value).toBeNull();
    expect(usage.quantities.cache_write_1h_tokens?.value).toBe('50');
    expect(usage.quantities.uncached_input_tokens?.value).toBe('900');
  });

  it('CALC-21 keeps reasoning as a subset, not additional billable output', () => {
    const usage = normalizeCanonicalTokenUsage(
      { input_tokens: 10, output_tokens: 50, reasoning_output_tokens: 40 },
      adapter,
      { absent_cache_is_zero: true },
    );
    expect(usage.quantities.output_tokens?.value).toBe('50');
    expect(usage.quantities.reasoning_output_tokens?.subset_of).toBe('output_tokens');
    expect(usage.diagnostics).toEqual([]);
  });

  it('rejects duplicate evidence instead of silently picking one report', () => {
    const usage = normalizeQuantities(
      [
        { dimension: 'output_tokens', value: 10 },
        { dimension: 'output_tokens', value: 20 },
      ],
      adapter,
    );
    expect(usage.quantities.output_tokens?.value).toBeNull();
    expect(usage.diagnostics[0]?.code).toBe('pricing_usage_conflict');
  });

  it('preserves estimated and missing evidence without arbitrary metadata', () => {
    const usage = normalizeQuantities(
      [
        { dimension: 'image_count', value: 3, quality: 'estimated', source: 'request_metadata' },
        { dimension: 'video_seconds', value: null },
      ],
      adapter,
    );
    expect(usage.quantities.image_count?.quality).toBe('estimated');
    expect(usage.quantities.video_seconds?.quality).toBe('missing');
    expect(Object.keys(usage).sort()).toEqual([
      'adapter_id',
      'adapter_version',
      'diagnostics',
      'quantities',
      'schema_version',
    ]);
  });
});

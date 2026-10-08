import { calculateCost } from '../../src/pricing/cost-calculator';
import { compilePriceBook } from '../../src/pricing/pricing-compiler';
import { legacyTokenPriceBook } from '../../src/pricing/legacy-pricing-adapter';
import { FxSnapshot } from '../../src/pricing/pricing.types';
import { normalizeQuantities, QuantityEvidence } from '../../src/pricing/usage-normalizer';
import { book, quote, rate, tokenBook, tokens } from './pricing-fixtures';

function media(evidence: QuantityEvidence[]) {
  return normalizeQuantities(evidence, {
    adapter_id: 'synthetic-media',
    adapter_version: '1',
    source: 'provider_job_result',
  });
}

describe('pure pricing calculator', () => {
  it('CALC-01 calculates ordinary tokens exactly', () => {
    const result = quote(tokenBook(), tokens({ input_tokens: 1000, output_tokens: 500 }));
    expect(result.status).toBe('priced');
    expect(result.amount).toBe('0.002000000');
    expect(result.report_amount).toBe(result.amount);
    expect(result.rounding_adjustment).toBe('0.000000000');
  });

  it('CALC-02 computes uncached, cache reads, 5m and 1h writes once each', () => {
    const result = quote(
      tokenBook(),
      tokens({
        input_tokens: 10000,
        output_tokens: 0,
        cache_read_input_tokens: 4000,
        cache_creation_input_tokens: 1500,
        cache_creation_5m_input_tokens: 1000,
        cache_creation_1h_input_tokens: 500,
      }),
    );
    expect(result.amount).toBe('0.007150000');
    expect(result.lines).toHaveLength(4);
  });

  it('CALC-10 uses observed generated images rather than the request count', () => {
    const result = quote(
      book([rate('image', 'image_count', '0.04', '1')]),
      media([
        { dimension: 'image_count', value: 3 },
        { dimension: 'request_count', value: 1 },
      ]),
    );
    expect(result.amount).toBe('0.120000000');
    expect(result.lines).toHaveLength(1);
  });

  it('CALC-11 supports explicit request base fees plus precise/rounded video duration', () => {
    const content = book([
      rate('video', 'video_seconds', '0.10', '1'),
      rate('base-fee', 'request_count', '0.02', '1'),
    ]);
    const usage = media([
      { dimension: 'video_seconds', value: '6.4' },
      { dimension: 'request_count', value: 1 },
    ]);
    expect(quote(content, usage).amount).toBe('0.660000000');
    content.groups[0].rules[0].rates[0].component.quantity_rounding = {
      increment: '1',
      mode: 'ceil',
    };
    expect(quote(content, usage).amount).toBe('0.720000000');
  });

  it('CALC-12 keeps minute conversion exact before final monetary rounding', () => {
    const content = book([rate('audio', 'audio_input_seconds', '0.06', '60')]);
    const usage = media([{ dimension: 'audio_input_seconds', value: 61 }]);
    expect(quote(content, usage).amount).toBe('0.061000000');
    content.groups[0].rules[0].rates[0].component.quantity_rounding = {
      increment: '60',
      mode: 'ceil',
    };
    expect(quote(content, usage).amount).toBe('0.120000000');
  });

  it('CALC-13 distinguishes no price, missing quantity, explicit free and pending evidence', () => {
    const usage = media([{ dimension: 'video_seconds', value: 2 }]);
    expect(calculateCost(usage, null).status).toBe('unpriced');
    expect(calculateCost(usage, null).amount).toBeNull();
    const missing = quote(
      book([rate('video', 'video_seconds', '1', '1')]),
      media([{ dimension: 'video_seconds', value: null }]),
    );
    expect(missing.status).toBe('missing_usage');
    expect(missing.amount).toBeNull();
    expect(missing.known_subtotal).toBeNull();
    expect(quote(book([rate('video', 'video_seconds', '0', '1')]), usage).status).toBe('free');
  });

  it('marks partial prices as incomplete and only exposes known subtotal', () => {
    const content = tokenBook();
    content.groups[0].rules[0].rates = content.groups[0].rules[0].rates.filter(
      (entry) => entry.component.dimension !== 'output_tokens',
    );
    const result = quote(content, tokens({ input_tokens: 1000, output_tokens: 500 }));
    expect(result.status).toBe('partial');
    expect(result.amount).toBeNull();
    expect(result.report_amount).toBeNull();
    expect(result.known_subtotal).toBe('0.001000000');
    expect(result.diagnostics[0]?.path).toBe('rates.output_tokens');
  });

  it('does not demand a rate for a reliably zero quantity', () => {
    const content = tokenBook();
    content.groups[0].rules[0].rates = content.groups[0].rules[0].rates.filter(
      (entry) => entry.component.dimension !== 'cache_read_tokens',
    );
    expect(quote(content, tokens({ input_tokens: 1000, output_tokens: 500 })).status).toBe(
      'priced',
    );
  });

  it('CALC-16 preserves native currency when FX is missing and uses a frozen rational FX snapshot', () => {
    const content = book([rate('image', 'image_count', '7', '1')]);
    content.currency = 'CNY';
    const usage = media([{ dimension: 'image_count', value: 1 }]);
    const price = compilePriceBook(content, { book_id: 'currency', version_id: '1' }).resolve(
      usage,
    );
    const missing = calculateCost(usage, price, { report_currency: 'USD' });
    expect(missing.status).toBe('unpriced');
    expect(missing.amount).toBe('7.000000000');
    expect(missing.report_amount).toBeNull();
    const fx: FxSnapshot = {
      version_id: 'test-fx-1',
      source: 'synthetic',
      effective_at: '2026-01-01T00:00:00Z',
      from_currency: 'CNY',
      to_currency: 'USD',
      numerator: '1',
      denominator: '7',
    };
    const result = calculateCost(usage, price, { report_currency: 'USD', fx });
    expect(result.report_amount).toBe('1.000000000');
    expect(result.fx_version_id).toBe('test-fx-1');
    expect(result.lines[0].report_amount).toBe('1.000000000');
    expect(result.status).toBe('priced');
    expect(
      calculateCost(usage, price, { report_currency: 'USD', fx: { ...fx, denominator: '0' } })
        .status,
    ).toBe('unpriced');
  });

  it('CALC-17 adds sub-micro line amounts before rounding and explains display differences', () => {
    const content = book([rate('a', 'request_count', '0.0000004', '1')]);
    content.money_precision = 6;
    content.groups.push({
      id: 'surcharges',
      order: 1,
      required: true,
      rules: [
        {
          id: 'surcharge-rates',
          priority: 0,
          mode: 'whole_request',
          condition: {},
          rates: [
            rate('b', 'request_count', '0.0000004', '1'),
            rate('c', 'request_count', '0.0000004', '1'),
          ].map((component) => ({ operation: 'add', component })),
        },
      ],
    });
    const result = quote(content, media([{ dimension: 'request_count', value: 1 }]));
    expect(result.amount).toBe('0.000001');
    expect(result.lines.map((line) => line.amount)).toEqual(['0.000000', '0.000000', '0.000000']);
    expect(result.rounding_adjustment).toBe('0.000001');
    expect(result.report_rounding_adjustment).toBe('0.000001');
    expect(result.lines[0].exact_amount).toEqual({ numerator: '1', denominator: '2500000' });
  });

  it('does not label a positive subprecision amount as free', () => {
    const content = book([rate('image', 'image_count', '0.0000000001', '1')]);
    const result = quote(content, media([{ dimension: 'image_count', value: 1 }]));
    expect(result.amount).toBe('0.000000000');
    expect(result.status).toBe('priced');
  });

  it('does not bill minimum quantity when observed usage is zero', () => {
    const component = { ...rate('video', 'video_seconds', '1', '1'), minimum_quantity: '5' };
    expect(quote(book([component]), media([{ dimension: 'video_seconds', value: 0 }])).amount).toBe(
      '0.000000000',
    );
    expect(quote(book([component]), media([{ dimension: 'video_seconds', value: 1 }])).amount).toBe(
      '5.000000000',
    );
  });

  it('marks estimated quantities and reference prices without claiming reconciliation', () => {
    const content = book([rate('image', 'image_count', '1', '1')]);
    const usage = media([
      { dimension: 'image_count', value: 3, quality: 'estimated', source: 'request_metadata' },
    ]);
    expect(quote(content, usage).status).toBe('estimated');
    content.source.kind = 'reference';
    expect(quote(content, media([{ dimension: 'image_count', value: 3 }])).status).toBe(
      'estimated',
    );
  });

  it('CALC-21 does not add reasoning twice', () => {
    const result = quote(
      tokenBook(),
      tokens({ input_tokens: 0, output_tokens: 1000, reasoning_output_tokens: 900 }),
    );
    expect(result.amount).toBe('0.002000000');
    expect(result.lines).toHaveLength(1);
  });

  it('returns an owned immutable-evidence snapshot rather than aliasing caller inputs', () => {
    const usage = tokens({ input_tokens: 1000, output_tokens: 0 });
    const result = quote(tokenBook(), usage);
    usage.quantities.uncached_input_tokens!.value = '1';
    usage.diagnostics.push({
      code: 'pricing_invalid_quantity',
      path: 'external',
      message: 'modified',
    });
    expect(result.usage.quantities.uncached_input_tokens!.value).toBe('1000');
    expect(result.diagnostics).toEqual([]);
  });

  it('matches the deployed four-token legacy formula over deterministic samples', () => {
    for (let sample = 0; sample < 40; sample++) {
      const input = 1000 + sample * 137;
      const read = sample * 11;
      const write = sample * 7;
      const output = sample * 23;
      const pricing = {
        input: 1.25,
        output: 3.7,
        ...(sample % 2 ? { cache_read_input: 0.1, cache_creation_input: 1.5 } : {}),
      };
      const expected =
        ((input - read - write) * pricing.input +
          read * (pricing.cache_read_input ?? pricing.input) +
          write * (pricing.cache_creation_input ?? pricing.input) +
          output * pricing.output) /
        1000000;
      const result = quote(
        legacyTokenPriceBook(pricing),
        tokens({
          input_tokens: input,
          output_tokens: output,
          cache_read_input_tokens: read,
          cache_creation_input_tokens: write,
        }),
      );
      expect(result.status).toBe('legacy_estimate');
      expect(Number(result.amount)).toBeCloseTo(expected, 14);
    }
  });
});

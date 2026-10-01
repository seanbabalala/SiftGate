import { calculateCost } from '../../src/pricing/cost-calculator';
import { compilePriceBook, PricingCompileError } from '../../src/pricing/pricing-compiler';
import type { PriceBookContent } from '../../src/pricing/pricing.types';
import { book, quote, rate, tokenBook, tokens } from './pricing-fixtures';

function tieredBook(): PriceBookContent {
  const content = tokenBook();
  content.groups.push({
    id: 'context',
    order: 1,
    required: true,
    rules: [
      {
        id: 'short',
        priority: 0,
        mode: 'whole_request',
        condition: { input_tokens: { min: '0', max: '272001' } },
        rates: [],
      },
      {
        id: 'long',
        priority: 0,
        mode: 'whole_request',
        condition: { input_tokens: { min: '272001' } },
        rates: [
          rate('long-input', 'uncached_input_tokens', '2'),
          rate('long-output', 'output_tokens', '3'),
          rate('long-read', 'cache_read_tokens', '0.2'),
        ].map((component) => ({ operation: 'replace', component })),
      },
    ],
  });
  return content;
}

describe('pricing rule compiler', () => {
  it('copies only declared identity fields into resolved prices', () => {
    const identity = {
      book_id: 'book',
      version_id: 'v1',
      unrelated_internal_field: 'must-not-export',
    };
    const price = compilePriceBook(tokenBook(), identity).resolve(
      tokens({ input_tokens: 100, output_tokens: 0 }),
    );
    expect(price).not.toHaveProperty('unrelated_internal_field');
  });
  it('keeps pricing estimated when the threshold quantity is estimated', () => {
    const usage = tokens({ input_tokens: 272001, output_tokens: 1000 });
    usage.quantities.total_input_tokens!.quality = 'estimated';
    const result = quote(tieredBook(), usage);
    expect(result.amount).toBe('0.547002000');
    expect(result.status).toBe('estimated');
  });

  it('CALC-03 selects whole-request tiers at exact 272000 / 272001 boundaries', () => {
    expect(quote(tieredBook(), tokens({ input_tokens: 272000, output_tokens: 1000 })).amount).toBe(
      '0.274000000',
    );
    expect(quote(tieredBook(), tokens({ input_tokens: 272001, output_tokens: 1000 })).amount).toBe(
      '0.547002000',
    );
  });

  it('CALC-04 thresholds include cached input, not just uncached tokens', () => {
    const result = quote(
      tieredBook(),
      tokens({ input_tokens: 300000, output_tokens: 10000, cache_read_input_tokens: 280000 }),
    );
    expect(result.amount).toBe('0.126000000');
    expect(result.selected_rule_ids).toEqual(['base-rate', 'long']);
  });

  it('does not select a cheap fallback rule when the context total is missing', () => {
    const content = tieredBook();
    content.groups[1].rules[0].condition = {};
    content.groups[1].rules[1].priority = 1;
    const usage = tokens({ output_tokens: 100 });
    const result = quote(content, usage);
    expect(result.status).toBe('missing_usage');
    expect(result.amount).toBeNull();
    expect(result.selected_rule_ids).not.toContain('short');
  });

  it('CALC-05 resolves the reported service tier rather than the requested tier', () => {
    const content = tokenBook();
    content.groups.push({
      id: 'service',
      order: 1,
      required: true,
      rules: [
        {
          id: 'standard',
          priority: 0,
          mode: 'whole_request',
          condition: { service_tiers: ['default'] },
          rates: [],
        },
        {
          id: 'priority',
          priority: 0,
          mode: 'whole_request',
          condition: { service_tiers: ['priority'] },
          rates: [],
          multipliers: [{ dimension: 'uncached_input_tokens', factor: '2' }],
        },
      ],
    });
    const usage = tokens({ input_tokens: 1000, output_tokens: 0 });
    const compiled = compilePriceBook(content, { book_id: 'service', version_id: '1' });
    const downgraded = compiled.resolve(usage, {
      requested_service_tier: 'priority',
      resolved_service_tier: 'default',
    });
    expect(calculateCost(usage, downgraded).amount).toBe('0.001000000');
    const priority = compiled.resolve(usage, {
      requested_service_tier: 'priority',
      resolved_service_tier: 'priority',
    });
    expect(calculateCost(usage, priority).amount).toBe('0.002000000');
  });

  it('CALC-06 does not invent Priority pricing', () => {
    const usage = tokens({ input_tokens: 1000, output_tokens: 0 });
    const price = compilePriceBook(tokenBook(), { book_id: 'default', version_id: '1' }).resolve(
      usage,
      { requested_service_tier: 'priority' },
    );
    expect(price.diagnostics[0]?.code).toBe('pricing_unknown_variant');
    expect(calculateCost(usage, price).amount).toBeNull();
  });

  it('rejects ambiguous same-priority rules before activation', () => {
    const content = tieredBook();
    content.groups[1].rules[0].condition.input_tokens!.max = '300000';
    expect(() => compilePriceBook(content, { book_id: 'bad', version_id: '1' })).toThrow(
      PricingCompileError,
    );
  });

  it('does not depend on group array order and preserves the compiled snapshot', () => {
    const content = tieredBook();
    const first = compilePriceBook(content, { book_id: 'a', version_id: '1' });
    const reversed = compilePriceBook(
      { ...content, groups: [...content.groups].reverse() },
      { book_id: 'a', version_id: '1' },
    );
    expect(first.contentHash).toBe(reversed.contentHash);
    content.groups[0].rules[0].rates[0].component.amount = '999';
    first.document().groups[0].rules[0].rates[0].component.amount = '999';
    const usage = tokens({ input_tokens: 1000, output_tokens: 0 });
    expect(calculateCost(usage, first.resolve(usage)).amount).toBe('0.001000000');
  });

  it('retains exact multiplier factors instead of rounding between groups', () => {
    const content = book([rate('a', 'request_count', '1', '1')]);
    content.money_precision = 18;
    for (let index = 1; index <= 2; index++)
      content.groups.push({
        id: `g${index}`,
        order: index,
        required: true,
        rules: [
          {
            id: `r${index}`,
            priority: 0,
            mode: 'whole_request',
            condition: {},
            rates: [],
            multipliers: [{ dimension: 'request_count', factor: '1.000000000000000001' }],
          },
        ],
      });
    const usage = {
      ...tokens({ input_tokens: 0, output_tokens: 0 }),
      quantities: {
        request_count: {
          dimension: 'request_count' as const,
          unit: 'request' as const,
          value: '1',
          source: 'provider_usage' as const,
          quality: 'observed' as const,
        },
      },
    };
    const result = quote(content, usage);
    expect(result.amount).toBe('1.000000000000000002');
    expect(result.lines[0].multipliers).toEqual(['1.000000000000000001', '1.000000000000000001']);
  });

  it.each([
    (content: PriceBookContent) => {
      (content.groups[0].rules[0] as unknown as Record<string, unknown>).mode = 'graduated';
    },
    (content: PriceBookContent) => {
      (
        content.groups[0].rules[0].condition as unknown as Record<string, unknown>
      ).made_up_condition = true;
    },
    (content: PriceBookContent) => {
      content.groups[0].rules[0].rates[0].component.amount = '';
    },
    (content: PriceBookContent) => {
      content.groups[0].rules[0].rates[0].component.amount = '-1';
    },
    (content: PriceBookContent) => {
      content.groups[0].rules[0].rates[0].component.amount = '0';
    },
    (content: PriceBookContent) => {
      content.groups[0].rules[0].rates[0].component.unit_size = '0';
    },
    (content: PriceBookContent) => {
      content.groups[0].rules[0].rates[0].component.unit = 'second';
    },
    (content: PriceBookContent) => {
      content.groups[0].order = NaN;
    },
    (content: PriceBookContent) => {
      content.groups[0].rules[0].condition.input_tokens = { min: '1', max: '1' };
    },
    (content: PriceBookContent) => {
      content.groups[0].rules[0].condition.input_tokens = { min: '1.5' };
    },
    (content: PriceBookContent) => {
      content.money_precision = 1000000;
    },
  ])('rejects unsupported or invalid configuration mutation %#', (mutate) => {
    const content = tokenBook();
    mutate(content);
    expect(() => compilePriceBook(content, { book_id: 'bad', version_id: '1' })).toThrow(
      PricingCompileError,
    );
  });

  it.each([null, 1, 'invalid', [], {}, { source: null }, { groups: [null] }])(
    'rejects malformed JSON documents safely: %j',
    (value) => {
      expect(() => compilePriceBook(value, { book_id: 'bad', version_id: '1' })).toThrow(
        PricingCompileError,
      );
    },
  );

  it('CALC-15 rejects implicit media double charging and token parent/subset double charging', () => {
    const media = book([
      rate('image', 'image_count', '1', '1'),
      rate('output', 'output_tokens', '1'),
    ]);
    expect(() => compilePriceBook(media, { book_id: 'bad', version_id: '1' })).toThrow(
      PricingCompileError,
    );
    media.allow_combined_media = true;
    expect(() => compilePriceBook(media, { book_id: 'explicit', version_id: '1' })).not.toThrow();
    const duplicate = book([
      rate('output', 'output_tokens', '1'),
      rate('audio', 'audio_output_tokens', '1'),
    ]);
    duplicate.allow_combined_media = true;
    expect(() => compilePriceBook(duplicate, { book_id: 'bad', version_id: '1' })).toThrow(
      PricingCompileError,
    );
  });
});

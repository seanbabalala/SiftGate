import { calculateCost } from '../../src/pricing/cost-calculator';
import { compilePriceBook } from '../../src/pricing/pricing-compiler';
import {
  DIMENSION_UNITS,
  NormalizedUsage,
  PriceBookContent,
  RateComponent,
} from '../../src/pricing/pricing.types';
import {
  CanonicalTokenEvidence,
  normalizeCanonicalTokenUsage,
} from '../../src/pricing/usage-normalizer';

export function rate(
  id: string,
  dimension: RateComponent['dimension'],
  amount: string,
  unitSize = '1000000',
): RateComponent {
  return {
    id,
    dimension,
    amount,
    unit: DIMENSION_UNITS[dimension],
    unit_size: unitSize,
    ...(amount === '0' ? { free: true } : {}),
  };
}

export function book(rates: RateComponent[]): PriceBookContent {
  return {
    schema_version: 1,
    currency: 'USD',
    money_precision: 9,
    money_rounding: 'half_even',
    source: { kind: 'manual' },
    billing_dimensions: [...new Set(rates.map((component) => component.dimension))],
    allow_combined_media: false,
    groups: [
      {
        id: 'base',
        order: 0,
        required: true,
        rules: [
          {
            id: 'base-rate',
            priority: 0,
            mode: 'whole_request',
            condition: {},
            rates: rates.map((component) => ({ operation: 'replace', component })),
          },
        ],
      },
    ],
  };
}

export function tokenBook(): PriceBookContent {
  return book([
    rate('input', 'uncached_input_tokens', '1'),
    rate('output', 'output_tokens', '2'),
    rate('read', 'cache_read_tokens', '0.1'),
    rate('write', 'cache_write_tokens', '1.25'),
    rate('write-5m', 'cache_write_5m_tokens', '1.25'),
    rate('write-1h', 'cache_write_1h_tokens', '2'),
  ]);
}

export function tokens(values: CanonicalTokenEvidence): NormalizedUsage {
  return normalizeCanonicalTokenUsage(
    values,
    { adapter_id: 'synthetic-canonical', adapter_version: '1', source: 'provider_usage' },
    { absent_cache_is_zero: true },
  );
}

export function quote(content: PriceBookContent, usage: NormalizedUsage) {
  const compiled = compilePriceBook(content, { book_id: 'synthetic', version_id: 'v1' });
  return calculateCost(usage, compiled.resolve(usage));
}

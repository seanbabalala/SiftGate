import { PricingApiInput } from './pricing-api-input';
import { parsePricingInstant } from './pricing-time';
import type { CostReportWindow } from './cost-report.types';
export function parseCostReportQuery(value: unknown): CostReportWindow & { limit: number; cursor?: string } {
  const reader = new PricingApiInput(value), raw = reader.body(['from', 'to', 'limit', 'cursor']);
  const from = reader.string(raw.from, 'from', 64), to = reader.string(raw.to, 'to', 64), limit = raw.limit === undefined ? '50' : reader.string(raw.limit, 'limit', 3);
  try { const start = parsePricingInstant(from), end = parsePricingInstant(to); if (end <= start || end - start > 366 * 86400000) throw new Error('window'); } catch { reader.invalid('from', 'Use absolute timestamps and a positive window no longer than 366 days'); }
  if (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 50) reader.invalid('limit', 'Use a page size from 1 to 50');
  const cursor = raw.cursor === undefined ? undefined : reader.string(raw.cursor, 'cursor', 4096);
  reader.done();
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString(), limit: Number(limit), cursor };
}
export function parseCostLogIds(value: unknown): number[] {
  const reader = new PricingApiInput(value), raw = reader.body(['ids']), ids = reader.string(raw.ids, 'ids', 4096).split(',');
  if (ids.length < 1 || ids.length > 200 || new Set(ids).size !== ids.length || ids.some(v => !/^[1-9]\d*$/.test(v) || !Number.isSafeInteger(Number(v)))) reader.invalid('ids', 'Use 1 to 200 distinct positive integer log IDs');
  reader.done(); return ids.map(Number);
}

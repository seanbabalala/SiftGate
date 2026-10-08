import type { PricingLimitsConfig } from '../config/gateway.config';
import type { CatalogBookVersion } from './pricing-catalog.types';
import { PricingRepositoryError } from './pricing-repository.types';

export function assertPricingRequestSize(value: unknown, limits: Readonly<Required<PricingLimitsConfig>>): void {
  let json: string;
  try { json = JSON.stringify(value) ?? ''; }
  catch { throw new PricingRepositoryError('pricing_invalid_document', 'Pricing actions require JSON data.', 400); }
  if (Buffer.byteLength(json, 'utf8') > limits.max_request_body_bytes) {
    throw new PricingRepositoryError('pricing_request_too_large',
      `Pricing action JSON exceeds the configured ${limits.max_request_body_bytes}-byte limit.`, 413);
  }
}

function ruleCount(content: unknown): number {
  if (!content || typeof content !== 'object') return 0;
  const groups = (content as { groups?: unknown }).groups;
  if (!Array.isArray(groups)) return 0;
  let count = 0;
  for (const group of groups as unknown[]) {
    const rules = group && typeof group === 'object' ? (group as { rules?: unknown }).rules : undefined;
    if (Array.isArray(rules)) count += rules.length;
  }
  return count;
}

export function assertPriceBookRuleCapacity(content: unknown, limit: number): void {
  if (ruleCount(content) > limit) rejectCapacity(limit);
}

export function assertPublishedRuleCapacity(books: ReadonlyArray<CatalogBookVersion>, limit: number): void {
  const seen = new Set<string>();
  let count = 0;
  for (const book of books) {
    const key = JSON.stringify([book.book_id, book.version_id]);
    if (seen.has(key)) continue;
    seen.add(key);
    count += ruleCount(book.content);
    if (count > limit) rejectCapacity(limit);
  }
}

function rejectCapacity(limit: number): never {
  // Do not expose other workspaces' identities or aggregate usage to the caller.
  throw new PricingRepositoryError('pricing_capacity_exceeded',
    `Price publication exceeds the configured ${limit}-rule capacity.`, 400);
}

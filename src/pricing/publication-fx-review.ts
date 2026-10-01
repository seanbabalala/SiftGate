import type { CatalogFxVersion } from './pricing-catalog.types';
import type { PricingDiagnostic } from './pricing.types';
import { parsePricingInstant } from './pricing-time';

export const PUBLICATION_FX_STATUSES = ['not_required', 'covered', 'incomplete'] as const;
export type PublicationFxStatus = typeof PUBLICATION_FX_STATUSES[number];
export interface PublicationFxWindow {
  effective_from: string;
  effective_to: string | null;
}
export interface PublicationFxReview {
  schema_version: 1;
  from_currency: string;
  report_currency: 'USD';
  workspace_id: string | null;
  status: PublicationFxStatus;
  window: PublicationFxWindow;
  /** Relevant available versions, not a claim that each one will be selected. */
  fx_version_ids: string[];
  gaps: PublicationFxWindow[];
  diagnostics: PricingDiagnostic[];
}

/** Management-only review of a validated catalog; no quote, I/O or invented FX. */
export function reviewPublicationFx(input: {
  currency: string;
  workspace_id: string | null;
  window: PublicationFxWindow;
  fx_versions: readonly CatalogFxVersion[];
}): PublicationFxReview {
  const review: PublicationFxReview = {
    schema_version: 1, from_currency: input.currency, report_currency: 'USD',
    workspace_id: input.workspace_id, window: { ...input.window },
    status: input.currency === 'USD' ? 'not_required' : 'covered',
    fx_version_ids: [], gaps: [], diagnostics: [],
  };
  if (review.status === 'not_required') return review;
  const start = parsePricingInstant(input.window.effective_from);
  const end = input.window.effective_to === null ? Infinity : parsePricingInstant(input.window.effective_to);
  // Same scope/direction as the runtime selector. A workspace override may fill
  // a gap in global coverage; a global book cannot depend on one tenant's FX.
  const intervals = input.fx_versions.filter(version =>
    (version.workspace_id === null || version.workspace_id === input.workspace_id) &&
    version.fx.from_currency === input.currency && version.fx.to_currency === 'USD',
  ).map(version => ({
    id: version.fx.version_id,
    from: Math.max(start, parsePricingInstant(version.fx.effective_at)),
    to: Math.min(end, version.effective_to ? parsePricingInstant(version.effective_to) : Infinity),
  })).filter(interval => interval.from < interval.to).sort((a, b) => a.from - b.from || a.id.localeCompare(b.id));
  review.fx_version_ids = intervals.map(interval => interval.id).sort();
  const gap = (from: number, to: number): PublicationFxWindow => ({
    effective_from: new Date(from).toISOString(), effective_to: to === Infinity ? null : new Date(to).toISOString(),
  });
  let cursor = start;
  for (const interval of intervals) {
    if (cursor < interval.from) review.gaps.push(gap(cursor, interval.from));
    cursor = Math.max(cursor, interval.to);
  }
  if (cursor < end) review.gaps.push(gap(cursor, end));
  if (review.gaps.length) {
    review.status = 'incomplete';
    review.diagnostics.push({ code: 'pricing_fx_missing', path: 'fx', message: 'The proposed activation interval is not fully covered by scoped FX to USD. Original-currency prices remain usable; report amounts are unknown when conversion is missing.' });
  }
  return review;
}

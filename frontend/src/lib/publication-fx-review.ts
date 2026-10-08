import type { PricingBinding, PublicationFxReview } from '@/types/pricing'

const invalid = (): never => { throw new Error('invalid_publication_fx_review') }
const epoch = (value: string): number => {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid()
  return Date.parse(value)
}

export function verifyPublicationFxReview(review: PublicationFxReview, expected: {
  currency: string
  workspace_id: string | null
  bindings: PricingBinding[]
}): void {
  if (!review || review.schema_version !== 1 || review.from_currency !== expected.currency ||
    review.report_currency !== 'USD' || review.workspace_id !== expected.workspace_id ||
    !['not_required', 'covered', 'incomplete'].includes(review.status) || !review.window ||
    !Array.isArray(review.gaps) || review.gaps.length > 513 ||
    !Array.isArray(review.fx_version_ids) || review.fx_version_ids.length > 512 ||
    new Set(review.fx_version_ids).size !== review.fx_version_ids.length ||
    review.fx_version_ids.some(id => typeof id !== 'string' || !id || id.length > 128) ||
    !Array.isArray(review.diagnostics) || !expected.bindings.length) invalid()
  const from = epoch(review.window.effective_from)
  const to = review.window.effective_to === null ? Infinity : epoch(review.window.effective_to)
  if (from >= to || expected.bindings.some(binding => binding.workspace_id !== expected.workspace_id ||
    binding.effective_from !== review.window.effective_from || (binding.effective_to ?? null) !== review.window.effective_to)) invalid()
  let cursor = from
  for (const gap of review.gaps) {
    if (!gap) invalid()
    const start = epoch(gap.effective_from), end = gap.effective_to === null ? Infinity : epoch(gap.effective_to)
    if (start < cursor || start >= end || end > to) invalid()
    cursor = end
  }
  if (review.from_currency === 'USD') {
    if (review.status !== 'not_required' || review.gaps.length || review.fx_version_ids.length || review.diagnostics.length) invalid()
  } else if (review.status === 'incomplete') {
    if (!review.gaps.length || review.diagnostics.length !== 1 || review.diagnostics[0]?.code !== 'pricing_fx_missing') invalid()
  } else if (review.status !== 'covered' || review.gaps.length || review.diagnostics.length || !review.fx_version_ids.length) invalid()
}

export function canPublishWithFx(review: PublicationFxReview | null, acknowledged: boolean): boolean {
  return review !== null && (review.status === 'not_required' || review.status === 'covered' || (review.status === 'incomplete' && acknowledged))
}

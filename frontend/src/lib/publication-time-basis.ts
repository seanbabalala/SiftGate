import type { PriceBookContent, PublicationTimeBasisReview, TimeBasisConfirmation } from '@/types/pricing'

export function verifyPublicationTimeBasis(review: PublicationTimeBasisReview, content: PriceBookContent, contentHash: string): void {
  const basis = content.time_basis ?? 'attempt_dispatched_at'
  if (!review || review.schema_version !== 1 || review.content_hash !== contentHash || review.basis !== basis ||
    review.supplier_verified !== false || review.requires_confirmation !== (basis !== 'attempt_dispatched_at') ||
    review.uses_time_rules !== content.groups.some(group => group.rules.some(rule => rule.condition.time_tags !== undefined))) throw Error('invalid_time_basis_review')
}

export function canConfirmTimeBasis(review: PublicationTimeBasisReview | null, reference: string, confirmed: boolean): boolean {
  return review !== null && (!review.requires_confirmation || confirmed && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(reference))
}

export function timeBasisConfirmation(review: PublicationTimeBasisReview, reference: string, confirmed: boolean): TimeBasisConfirmation | undefined {
  if (!canConfirmTimeBasis(review, reference, confirmed)) throw Error('invalid_time_basis_review')
  if (!review.requires_confirmation) return undefined
  if (review.basis === 'attempt_dispatched_at') throw Error('invalid_time_basis_review')
  return { basis: review.basis, content_hash: review.content_hash, reference, confirmed: true }
}

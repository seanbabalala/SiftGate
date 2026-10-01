import type { PricingTimeBasis } from './pricing-calendar.types';
import type { PriceBookContent } from './pricing.types';
import { PricingRepositoryError } from './pricing-repository.types';

export interface PublicationTimeBasisReview {
  schema_version: 1;
  content_hash: string;
  basis: PricingTimeBasis;
  uses_time_rules: boolean;
  requires_confirmation: boolean;
  /** Administrator attestation is not independent supplier verification. */
  supplier_verified: false;
}

export interface TimeBasisConfirmation {
  basis: Exclude<PricingTimeBasis, 'attempt_dispatched_at'>;
  content_hash: string;
  /** Opaque review-record identifier, not contract text, credentials or a private URL. */
  reference: string;
  confirmed: true;
}

export function publicationTimeBasisReview(content: PriceBookContent, contentHash: string): PublicationTimeBasisReview {
  const basis = content.time_basis ?? 'attempt_dispatched_at';
  return { schema_version: 1, content_hash: contentHash, basis,
    uses_time_rules: content.groups.some(group => group.rules.some(rule => rule.condition.time_tags !== undefined)),
    requires_confirmation: basis !== 'attempt_dispatched_at', supplier_verified: false };
}

export function parseTimeBasisConfirmation(value: unknown): TimeBasisConfirmation | undefined {
  if (value === undefined) return undefined;
  const invalid = (): never => { throw new PricingRepositoryError('pricing_invalid_document', 'Timing confirmation requires the selected basis, exact content hash, explicit consent and a review identifier (letters, digits, dots, underscores or hyphens; no contract text or URLs)', 400); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(key => !['basis', 'content_hash', 'reference', 'confirmed'].includes(key)) ||
    !['provider_accepted_at', 'completed_at'].includes(row.basis as string) || row.confirmed !== true ||
    typeof row.content_hash !== 'string' || !/^[a-f0-9]{64}$/.test(row.content_hash) ||
    typeof row.reference !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(row.reference)) invalid();
  return { basis: row.basis as TimeBasisConfirmation['basis'], content_hash: row.content_hash as string, reference: row.reference as string, confirmed: true };
}

/** Called for every new activation, including rollback and inherited materializations. */
export function confirmPublicationTimeBasis(review: PublicationTimeBasisReview, value: unknown): TimeBasisConfirmation | null {
  const confirmation = parseTimeBasisConfirmation(value);
  if (!review.requires_confirmation) {
    if (confirmation) throw new PricingRepositoryError('pricing_invalid_document', 'Default dispatch timing does not accept a non-default timing confirmation', 400);
    return null;
  }
  if (!confirmation) throw new PricingRepositoryError('pricing_time_basis_review_required', 'Confirm the supplier timing agreement and its review identifier before publishing a non-default time basis', 400);
  if (confirmation.basis !== review.basis || confirmation.content_hash !== review.content_hash)
    throw new PricingRepositoryError('pricing_version_conflict', 'Timing confirmation differs from the current immutable price content; review this version again', 409);
  return confirmation;
}

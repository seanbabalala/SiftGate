import type { FxSnapshot } from './pricing.types';
import type { PricingRequestSnapshot } from './pricing-catalog.types';

/** A display projection, never a replacement for the immutable cost or FX document. */
export interface HistoricalFxView {
  schema_version: 1;
  read_only: true;
  workspace_id: string;
  request_id: string;
  receipt_hash: string;
  snapshot: PricingRequestSnapshot;
  fx: Omit<FxSnapshot, 'source'> & { source: string | null; source_redacted: boolean };
  evidence_hash: string;
}

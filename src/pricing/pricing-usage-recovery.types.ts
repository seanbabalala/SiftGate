import type {
  CostComputation,
  MeterDimension,
  PricingContext,
} from "./pricing.types";
import type { AttemptPriceContext } from "./cost-ledger.types";
import type { EmbeddingBatchMember } from "./pricing-batch.types";
import type { PricingTarget } from "./pricing-catalog.types";

/** Administrator attestation, never an authenticated supplier receipt or a money override. */
export interface UsageRecoveryInput {
  id: string;
  attempt_id: string;
  expected_basis_hash: string;
  reason: string;
  confirm: true;
  evidence: Array<{ dimension: MeterDimension; value: string | null }>;
  conditions?: Pick<
    PricingContext,
    "resolved_service_tier" | "provider_accepted_at" | "completed_at" | "media"
  >;
  evidence_digest?: string;
}

export interface UsageRecoveryBasis {
  basis_hash: string;
  request_id: string;
  target: PricingTarget;
  pricing: AttemptPriceContext;
  dispatched_at: string;
  legacy_version: string | null;
  physical: null | {
    batch_id: string;
    physical_attempt_id: string;
    members: EmbeddingBatchMember[];
  };
  attempts: Array<{ id: string; request_id: string; reservation_id: string }>;
}

export interface UsageRecoveryResult {
  id: string;
  anchor_reservation_id: string;
  attempt_id: string;
  basis_hash: string;
  dry_run: boolean;
  replayed: boolean;
  source: "administrator_attestation";
  supplier_confirmed: false;
  budget_changed: false;
  changes: Array<{
    attempt_id: string;
    request_id: string;
    reservation_id: string;
    cost_hash: string;
    cost: CostComputation;
  }>;
}

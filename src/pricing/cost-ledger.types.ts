import type { PricingRecoveryCaseSummary } from "./pricing-orphan.types";
import type { ProviderCostAttribution } from "../providers/provider-cost-attribution.types";
import type { PricingAdmissionAssessment } from "./pricing-admission.types";
import type { CostAdjustmentView } from "./cost-adjustment.types";
import type {
  BudgetLedgerHold,
  BudgetLedgerIdentity,
} from "../budget/budget-ledger.types";
import type {
  CostComputation,
  PriceBookContent,
  PricingContext,
} from "./pricing.types";
import type { PricingTarget } from "./pricing-catalog.types";
import type { LocalCacheReference } from "./local-cache-reference.types";

export interface CostReservationRow {
  id: string;
  request_id: string;
  workspace_id: string;
  state: "reserved" | "committed" | "released" | "abandoned";
  identity_json: string;
  target_json: string;
  estimate_json: string;
  reserved_tokens: string;
  reserved_cost_usd: string;
  holds_json: string;
  committed_tokens: string;
  committed_cost_usd: string;
  budget_basis: string;
  lease_owner: string;
  lease_until: string;
  job_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface CostAttemptRow {
  id: string;
  request_id: string;
  workspace_id: string;
  reservation_id: string | null;
  node_id: string;
  model: string;
  state: "dispatched" | "terminal";
  fee_source: "provider" | "local_cache" | "synthetic";
  dispatched_at: string;
  completed_at: string | null;
  price_context_json: string;
  cost_json: string | null;
  cost_hash: string | null;
  error_code: string | null;
}

export interface CostReservationInput {
  id: string;
  requestId: string;
  identity: BudgetLedgerIdentity;
  target: PricingTarget;
  estimate: CostComputation;
  tokens: string;
  costUsd: string;
  budgetBasis: string;
  leaseOwner: string;
  leaseUntil: string;
  jobId?: string;
}

export interface AttemptPriceContext {
  batch?: {
    batch_id: string;
    physical_attempt_id: string;
    manifest_hash?: string;
    member_index: number;
    request_ids: string[];
  };
  dispatch?: ProviderCostAttribution;
  context: PricingContext;
  legacyPrice: PriceBookContent | null;
}

export interface CostLedgerSummary {
  local_cache_reference?: LocalCacheReference;
  request_id: string;
  status:
    | "priced"
    | "estimated"
    | "partial"
    | "unpriced"
    | "missing_usage"
    | "pending"
    | "free"
    | "legacy_estimate";
  report_currency: "USD";
  amount: string | null;
  known_subtotal: string | null;
  pending_attempts: number;
  unknown_attempts: number;
  provider_attempts: number;
  budget_committed_usd: string;
  budget_reserved_usd: string;
  pending_budget_adjustments: number;
  attempts: Array<
    Omit<CostAttemptRow, "cost_json" | "price_context_json"> & {
      dispatch: ProviderCostAttribution | null;
      cost: CostComputation | null;
      effective_cost: CostComputation | null;
      effective_cost_hash: string | null;
      adjustments: CostAdjustmentView[];
    }
  >;
  reservations: Array<{
    id: string;
    state: CostReservationRow["state"];
    reserved_cost_usd: string;
    committed_cost_usd: string;
    reserved_tokens: string;
    committed_tokens: string;
    budget_basis: string;
    admission: PricingAdmissionAssessment | null;
    known_cost_overrun_usd: string;
    observed_limit_excesses: Array<{
      attempt_id: string;
      dimension: string;
      observed: string;
      limit: string;
    }>;

    recovery_case: PricingRecoveryCaseSummary | null;
    settlement_status: CostSettlementIntentRow["state"] | null;
    settlement_error_code: string | null;
    lease_until: string;
  }>;
}

export interface CostBudgetEffect {
  holds: BudgetLedgerHold[];
  identity: BudgetLedgerIdentity;
}

/** Persisted before applying the receipt and budget mutation. No provider payloads. */
export interface CostSettlementPayload {
  /** Explicit logical-budget winner for multi-receipt settlements; absent on older intents. */
  budget_attempt_id?: string;
  /** Additional terminal outcomes from physical retries; old intents keep this absent. */
  receipts?: Array<NonNullable<CostSettlementPayload["receipt"]>>;
  kind: "commit" | "release";
  tokens: string;
  cost_usd: string;
  budget_basis: string;
  receipt: {
    attemptId: string;
    cost: CostComputation;
    errorCode?: string | null;
  } | null;
}

export interface CostSettlementIntentRow {
  reservation_id: string;
  workspace_id: string;
  request_id: string;
  payload_json: string;
  payload_hash: string;
  state: "pending" | "applied" | "review_required";
  attempt_count: number;
  next_attempt_at: string;
  last_error_code: string | null;
  created_at: string;
  applied_at: string | null;
}

export interface CostRecoveryResult {
  applied: number;
  pending: number;
  review_required: number;
}

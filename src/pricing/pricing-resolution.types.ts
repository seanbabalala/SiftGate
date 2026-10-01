import type { CostComputation } from "./pricing.types";
import type {
  CostAttemptRow,
  CostReservationRow,
  CostSettlementIntentRow,
  AttemptPriceContext,
  CostSettlementPayload,
} from "./cost-ledger.types";
import type { CostAdjustmentView } from "./cost-adjustment.types";
import type { PricingRecoveryCaseRow } from "./pricing-orphan.types";
import type { ActualRecoveryBasis, ActualBudgetCohortRow } from "./actual-upstream-budget-cohort.types";

export interface RecoveryDecision {
  reservation_id: string;
  action: "release" | "commit" | "apply_recorded" | "reconcile_actual";
  budget_attempt_id?: string;
  /** Only required when the receipt does not carry both logical token totals. */
  logical_tokens?: string;
}
export interface RecoveryResolutionInput {
  id: string;
  expected_basis_hash: string;
  reason: string;
  confirm: true;
  decisions: RecoveryDecision[];
}
export interface RecoveryBasis {
  anchor_reservation_id: string;
  basis_hash: string;
  request_ids: string[];
  /** This workflow resolves internal holds, not supplier invoices. */
  budget_only: true;
  reservations: Array<{
    id: string;
    request_id: string;
    state: CostReservationRow["state"];
    reserved_cost_usd: string;
    reserved_tokens: string;
    committed_cost_usd: string;
    committed_tokens: string;
    lease_until: string;
    intent_state: CostSettlementIntentRow["state"] | null;
    blocked_reason: string | null;
    budget_basis?: string;
    actual_budget?: {
      dispatch_closed: boolean;
      known_cost_usd: string | null;
      settlement_ready: boolean;
      pending_reasons: string[];
      unresolved_attempt_ids: string[];
    };
  }>;
  attempts: Array<{
    id: string;
    request_id: string;
    reservation_id: string | null;
    state: CostAttemptRow["state"];
    fee_source: CostAttemptRow["fee_source"];
    node_id: string; model: string; error_code: string | null; dispatched_at: string;
    effective_cost_hash: string | null;
    cost: CostComputation | null;
    physical_attempt_id: string | null;
  }>;
}
export interface RecoveryResolutionResult {
  id: string;
  anchor_reservation_id: string;
  basis_hash: string;
  budget_only: true;
  dry_run: boolean;
  replayed: boolean;
  unknown_attempt_ids: string[];
  changes: Array<{
    reservation_id: string;
    action: RecoveryDecision["action"];
    previous_state: CostReservationRow["state"];
    next_state: "committed" | "released" | "reserved";
    actual_closure_hash?: string;
    pending_reasons?: string[];
    budget_tokens: string;
    budget_cost_usd: string;
    budget_attempt_id: string | null;
    reserved_cost_usd: string;
    /** Budget epoch changes can prevent a refund from affecting today's balance. */
    current_balance_refund_not_guaranteed: true;
  }>;
}
export interface LockedRecoveryBasis {
  view: RecoveryBasis;
  reservations: CostReservationRow[];
  intents: Map<string, CostSettlementIntentRow>;
  attempts: Array<{
    row: CostAttemptRow;
    context: AttemptPriceContext;
    cost: CostComputation | null;
    history: CostAdjustmentView[];
  }>;
  cases: PricingRecoveryCaseRow[];
  actual?: Map<string, ActualRecoveryBasis>;
}
export interface RecoveryResolutionPlan {
  result: RecoveryResolutionResult;
  payloads: Array<{
    reservation: CostReservationRow;
    payload: CostSettlementPayload;
    recorded: boolean;
  }>;
  actual?: Array<{ reservation: CostReservationRow; cohort: ActualBudgetCohortRow }>;
}

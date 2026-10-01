import type { CostComputation } from "./pricing.types";
import type {
  CostAdjustmentApplication,
  CostAdjustmentView,
} from "./cost-adjustment.types";
import type { UsageRecoveryInput } from "./pricing-usage-recovery.types";
import type { BudgetLedgerHold } from "../budget/budget-ledger.types";
import type {
  AttemptPriceContext,
  CostAttemptRow,
  CostReservationRow,
  CostSettlementIntentRow,
} from "./cost-ledger.types";
import type { PricingTarget } from "./pricing-catalog.types";

export interface AttemptCorrectionInput extends Omit<
  UsageRecoveryInput,
  "attempt_id"
> {
  expected_cost_hash: string;
}
export interface AttemptCorrectionBasis {
  attempt_id: string;
  request_id: string;
  basis_hash: string;
  effective_cost_hash: string;
  original: CostComputation;
  current: CostComputation;
  revision: number;
  reservation_state: CostReservationRow["state"] | null;
  blocked_reason:
    | "batch_group_required"
    | "not_provider"
    | "lease_active"
    | "async_owned"
    | "pending_intent"
    | null;
}
export interface LockedAttemptCorrection {
  view: AttemptCorrectionBasis;
  attempt: CostAttemptRow;
  reservation: CostReservationRow | null;
  intent: CostSettlementIntentRow | null;
  history: CostAdjustmentView[];
  pricing: AttemptPriceContext;
  target: PricingTarget;
}
export interface AttemptCorrectionResult {
  id: string;
  attempt_id: string;
  request_id: string;
  basis_hash: string;
  previous_cost_hash: string;
  cost_hash: string;
  previous_cost: CostComputation;
  cost: CostComputation;
  dry_run: boolean;
  replayed: boolean;
  supplier_confirmed: false;
  original_receipt_modified: false;
  budget: Pick<
    CostAdjustmentApplication,
    | "budget_state"
    | "budget_cost_before"
    | "budget_cost_after"
    | "budget_tokens_before"
    | "budget_tokens_after"
    | "cost_delta"
    | "tokens_delta"
  > & {
    allocations: BudgetLedgerHold[];
    /** No amount is promised as a credit against the currently active period. */
    current_period_refund_not_guaranteed: true;
  };
  adjustment: CostAdjustmentView | null;
}

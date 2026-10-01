import type { CostComputation } from "./pricing.types";
import type { CostAdjustmentView } from "./cost-adjustment.types";
import type {
  OutcomeDispositionAction,
  OutcomeDispositionInput,
  OutcomeDispositionResult,
} from "./pricing-outcome-disposition.types";
export type GroupDispositionInput = OutcomeDispositionInput;
export interface GroupDispositionRow {
  outcome_id: string;
  workspace_id: string;
  operation_id: string;
  actor_id: string;
  action: OutcomeDispositionAction;
  outcome_hash: string;
  proposal_hash: string;
  result_hash: string;
  audit_id: string;
  created_at: string;
  result_json: string;
}
export type GroupDispositionBlocked =
  | "not_review_required"
  | "already_disposed"
  | "lease_active"
  | "pending_intent"
  | "async_owned"
  | "not_provider"
  | null;
export type GroupDispositionAcceptanceBlocked =
  | "no_receipts"
  | "ambiguous_receipts"
  | "manifest_missing"
  | "incomplete_historical_group"
  | "inconsistent_group_history"
  | "allocation_failure"
  | null;
export interface GroupDispositionReceipt {
  attempt_id: string;
  request_id: string;
  reservation_id: string;
  physical_attempt_id: string | null;
  original: CostComputation | null;
  current: CostComputation | null;
  retained: CostComputation;
  retained_hash: string;
  current_hash: string | null;
  recorded_error: string | null;
  retained_error: string | null;
}
export interface GroupDispositionBasis {
  outcome_id: string;
  outcome_hash: string;
  basis_hash: string;
  source: "gateway_runtime";
  supplier_confirmed: false;
  budget_decision_unchanged: true;
  blocked_reason: GroupDispositionBlocked;
  acceptance_blocked_reason: GroupDispositionAcceptanceBlocked;
  disposition: {
    id: string;
    action: OutcomeDispositionAction;
    actor_id: string;
    result_hash: string;
  } | null;
  related_outcomes: Array<{
    id: string;
    state: string;
    document_hash: string;
    disposition: OutcomeDispositionAction | null;
  }>;
  groups: Array<{
    physical_attempt_id: string;
    batch_id: string;
    complete: boolean;
    represented_attempt_ids: string[];
    retained_physical_hash: string;
    original_physical: CostComputation | null;
    current_physical: CostComputation | null;
    retained_physical: CostComputation;
  }>;
  receipts: GroupDispositionReceipt[];
}
export interface GroupDispositionResult {
  id: string;
  outcome_id: string;
  outcome_hash: string;
  basis_hash: string;
  action: OutcomeDispositionAction;
  dry_run: boolean;
  replayed: boolean;
  supplier_confirmed: false;
  outcome_document_modified: false;
  original_receipts_modified: false;
  budget_decision_unchanged: true;
  changes: Array<{
    attempt_id: string;
    request_id: string;
    reservation_id: string;
    physical_attempt_id: string | null;
    operation: "initial_receipt" | "linked_correction" | "already_recorded";
    previous_cost: CostComputation | null;
    previous_cost_hash: string | null;
    retained_hash: string;
    cost: CostComputation;
    cost_hash: string;
    retained_error: string | null;
    recorded_error: string | null;
    original_error_preserved: boolean;
    adjustment: CostAdjustmentView | null;
    budget: OutcomeDispositionResult["changes"][number]["budget"];
  }>;
}

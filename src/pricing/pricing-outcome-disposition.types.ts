import type { CostComputation } from "./pricing.types";
import type { AttemptCorrectionResult } from "./attempt-correction.types";
import type { CostAdjustmentView } from "./cost-adjustment.types";

export type OutcomeDispositionAction = "accept_receipts" | "reject_evidence";
export interface OutcomeDispositionInput {
  id: string;
  expected_basis_hash: string;
  expected_outcome_hash: string;
  action: OutcomeDispositionAction;
  reason: string;
  confirm: true;
}
export interface OutcomeDispositionRow {
  outcome_id: string;
  workspace_id: string;
  request_id: string;
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
export interface OutcomeDispositionBasis {
  outcome_id: string;
  outcome_hash: string;
  request_id: string;
  reservation_id: string;
  basis_hash: string;
  source: "gateway_runtime";
  supplier_confirmed: false;
  /** Sibling variants are alternatives, never added as separate monetary charges. */
  related_outcomes: Array<{
    id: string;
    kind: string;
    state: string;
    outcome_hash: string;
    disposition: OutcomeDispositionAction | null;
  }>;
  disposition: {
    id: string;
    action: OutcomeDispositionAction;
    actor_id: string;
    result_hash: string;
  } | null;
  blocked_reason:
    | "not_review_required"
    | "already_disposed"
    | "lease_active"
    | "pending_intent"
    | "async_owned"
    | "batch_group_required"
    | "not_provider"
    | null;
  receipts: Array<{
    attempt_id: string;
    original: CostComputation | null;
    current: CostComputation | null;
    current_hash: string | null;
    retained: CostComputation;
    retained_hash: string;
    recorded_error: string | null;
    retained_error: string | null;
  }>;
  budget_decision_unchanged: true;
}
export interface OutcomeDispositionResult {
  id: string;
  outcome_id: string;
  outcome_hash: string;
  request_id: string;
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
    operation: "initial_receipt" | "linked_correction" | "already_recorded";
    previous_cost: CostComputation | null;
    previous_cost_hash: string | null;
    cost: CostComputation;
    cost_hash: string;
    error_code: string | null;
    original_error_preserved: boolean;
    adjustment: CostAdjustmentView | null;
    budget: AttemptCorrectionResult["budget"];
  }>;
}

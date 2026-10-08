import type { CostComputation } from "./pricing.types";
import type { MediaLookupObservation } from "./media-job-lookup.types";
import type { CostReservationRow } from "./cost-ledger.types";
import type { AttemptCorrectionResult } from "./attempt-correction.types";

export type MediaEventDispositionAction = "accept" | "reject";
export type MediaEventOrdering =
  | "continue_ordered"
  | "manual_review"
  | "unchanged";
export interface MediaEventAuthority {
  disposition_id: string;
  mode: Exclude<MediaEventOrdering, "unchanged">;
  source_id: string;
  sequence: string;
  provider_job_id: string;
}
export interface MediaEventDispositionChoice {
  action: MediaEventDispositionAction;
  ordering: MediaEventOrdering;
  expected_basis_hash: string;
  expected_event_hash: string;
}
export interface MediaEventDispositionInput extends MediaEventDispositionChoice {
  id: string;
  expected_preview_hash: string;
  reason: string;
  confirm: true;
}
export interface MediaEventDispositionBasis {
  task_id: string;
  request_id: string;
  workspace_id: string;
  event_id: string;
  event_hash: string;
  basis_hash: string;
  origin: "authenticated_connector" | "unversioned_observation";
  sequence: string | null;
  effective_sequence: string | null;
  authority: MediaEventAuthority | null;
  current_cost: CostComputation | null;
  current_cost_hash: string | null;
  reservation_state: CostReservationRow["state"];
  blocked_reason: "not_review_required" | "already_disposed" | null;
  accept_blocked_reason:
    | "pending_processing"
    | "terminal_regression"
    | "stale_sequence"
    | "budget_decision_present"
    | "control_in_progress"
    | null;
  disposition: {
    id: string;
    action: MediaEventDispositionAction;
    actor_id: string;
    record_hash: string;
  } | null;
}
export interface MediaEventDispositionPreview {
  task_id: string;
  request_id: string;
  event_id: string;
  event_hash: string;
  basis_hash: string;
  action: MediaEventDispositionAction;
  ordering: MediaEventOrdering;
  next_sequence: string;
  source_id: string;
  observation: MediaLookupObservation;
  previous_cost: CostComputation | null;
  previous_cost_hash: string | null;
  cost: CostComputation | null;
  cost_hash: string | null;
  impact: {
    operation: "initial" | "adjustment" | "noop" | "pending_only" | "none";
    amount_delta: string | null;
    currency: string | null;
    budget: AttemptCorrectionResult["budget"] | null;
    original_reservation_id: string;
    processing_deferred: true;
  };
  preview_hash: string;
  dry_run: true;
  supplier_invoice_confirmed: false;
  original_receipts_modified: false;
}
export interface MediaEventDispositionRow {
  id: string;
  operation_id: string;
  task_id: string;
  request_id: string;
  workspace_id: string;
  event_record_id: string;
  actor_id: string;
  action: MediaEventDispositionAction;
  revision: number;
  proposal_hash: string;
  preview_hash: string;
  document_json: string;
  observation_id: string | null;
  audit_id: string;
  record_hash: string;
  created_at: string;
}
export interface MediaEventDispositionReceipt {
  id: string;
  task_id: string;
  event_id: string;
  actor_id: string;
  observation_id: string | null;
  record_hash: string;
  preview: MediaEventDispositionPreview;
  replayed: boolean;
  dry_run: false;
  processing_pending?: boolean;
}

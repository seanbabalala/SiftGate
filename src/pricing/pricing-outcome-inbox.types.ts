import type { OutcomeDispositionAction } from "./pricing-outcome-disposition.types";

export type RuntimeOutcomeState = "pending" | "delivered" | "review_required";
export interface RuntimeOutcomeRow {
  id: string;
  workspace_id: string;
  request_id: string;
  reservation_id: string;
  subject_id: string;
  kind: "attempt" | "settlement" | "actual_budget_closure";
  source: "gateway_runtime";
  outcome_hash: string;
  outcome_json: string;
  state: RuntimeOutcomeState;
  created_at: string;
  updated_at: string;
  next_attempt_at: string;
  attempts: number;
  last_error_code: string | null;
  delivered_at: string | null;
}
export type RuntimeOutcomeSummary = Omit<RuntimeOutcomeRow, "outcome_json"> & {
  disposition?: {
    id: string;
    action: OutcomeDispositionAction;
    actor_id: string;
    result_hash: string;
  } | null;
};

import type { CostComputation } from "./pricing.types";
import type { CostSettlementPayload } from "./cost-ledger.types";
import type { ActualBudgetClosurePayload } from "./actual-upstream-budget-cohort.types";

export interface GroupAttemptOutcome {
  id: string;
  cost: CostComputation;
  errorCode?: string;
  settlement?: CostSettlementPayload;
}
export type PricingGroupOutcome =
  | { type: "attempt_group"; workspace: string; entries: GroupAttemptOutcome[] }
  | {
      type: "settlement_group";
      workspace: string;
      entries: Array<{ reservationId: string; payload: CostSettlementPayload }>;
    }
  | {
      type: "actual_budget_closure_group";
      workspace: string;
      entries: Array<{ reservationId: string; payload: ActualBudgetClosurePayload }>;
    };
export interface GroupOutcomeMember {
  request_id: string;
  reservation_id: string;
}
export type GroupOutcomeState = "pending" | "delivered" | "review_required";
export interface GroupOutcomeRow {
  id: string;
  workspace_id: string;
  kind: PricingGroupOutcome["type"];
  subject_id: string;
  document_hash: string;
  document_json: string;
  members_hash: string;
  member_count: number;
  state: GroupOutcomeState;
  created_at: string;
  updated_at: string;
  next_attempt_at: string;
  attempts: number;
  last_error_code: string | null;
  delivered_at: string | null;
}

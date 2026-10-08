import type { CostSettlementPayload } from "./cost-ledger.types";
import type { ActualUpstreamBudgetPlan } from "./actual-upstream-budget.types";

export interface ActualBudgetClosurePayload {
  attempt_ids: string[];
  missing_dispatch_evidence: boolean;
  receipts: Array<NonNullable<CostSettlementPayload["receipt"]>>;
  receipt?: never;
}
/** Stored authority is deliberately NOT accepted by the runtime-outcome wire parser. */
export interface ActualMediaAuthorityRef {
  task_id: string;
  observation_id: string;
  processing_hash: string;
  context_hash: string;
}
export type ActualBudgetStoredClosure = ActualBudgetClosurePayload & {
  operator_authority?: { resolution_id: string; audit_id: string };
  media_authority?: ActualMediaAuthorityRef & { siblings?: ActualMediaAuthorityRef[] };
};
export interface ActualBudgetCohortRow {
  reservation_id: string;
  workspace_id: string;
  request_id: string;
  catalog_revision_id: string;
  policy_hash: string;
  closure_hash: string;
  closure_json: string;
  state: "pending" | "applied" | "review_required";
  created_at: string;
  updated_at: string;
  applied_plan_json: string | null;
  applied_plan_hash: string | null;
  last_error_code: string | null;
}

export interface ActualRecoveryBasis {
  cohort: ActualBudgetCohortRow | null;
  closure: ActualBudgetStoredClosure;
  identity: Pick<ActualBudgetCohortRow, "reservation_id" | "workspace_id" | "request_id" | "catalog_revision_id" | "policy_hash">;
  plan: ActualUpstreamBudgetPlan;
  pending: string[];
  custody_hash: string;
}

import type { CostComputation } from "./pricing.types";
import type { CostAttemptRow } from "./cost-ledger.types";

/** Internal planning contract. Not an activated catalog policy or a budget write API. */
export interface ActualBudgetAttempt {
  id: string;
  request_id: string;
  reservation_id: string | null;
  workspace_id: string;
  fee_source: CostAttemptRow["fee_source"];
  state: CostAttemptRow["state"];
  error_code: string | null;
  cost: CostComputation | null;
  cost_hash: string | null;
}

export interface ActualBudgetScope {
  workspace_id: string;
  request_id: string;
  reservation_id: string;
  /** Must eventually come from runtime closure or an explicitly fenced recovery decision. */
  dispatch_complete: boolean;
  /** Derived from retained original budget holds, never inferred from absent usage. */
  require_upstream_tokens: boolean;
}

export interface ActualBudgetContribution {
  attempt_id: string;
  cost_hash: string | null;
  price_identity_hash: string | null;
  fee_source: ActualBudgetAttempt["fee_source"];
  error_code: string | null;
  cost_usd: string | null;
  known_cost_usd: string | null;
  upstream_tokens: string | null;
  evidence_basis: "receipt" | "allocated_physical_receipt" | "local_zero" | "unresolved";
  state: "known" | "local_zero" | "pending" | "missing_cost" | "estimated_cost" | "unclassified_local_cost";
}

export interface ActualUpstreamBudgetPlan extends ActualBudgetScope {
  schema_version: 1;
  basis: "actual_upstream";
  report_currency: "USD";
  state: "ready" | "awaiting_dispatch_finality" | "awaiting_evidence";
  /** A failed logical request may still commit actual provider expense. */
  terminal_kind: "commit" | "release" | null;
  cost_usd: string | null;
  known_cost_usd: string | null;
  upstream_tokens: string | null;
  contributions: ActualBudgetContribution[];
  unresolved_cost_attempts: string[];
  unresolved_token_attempts: string[];
  plan_hash: string;
}

export interface ActualBudgetAdjustmentPlan {
  basis: "actual_upstream";
  previous_plan_hash: string;
  next_plan_hash: string;
  state: "ready" | "awaiting_evidence";
  cost_delta_usd: string | null;
  tokens_delta: string | null;
  changed_attempt_ids: string[];
}

import type { CostComputation } from "./pricing.types";
import type { BudgetLedgerHold } from "../budget/budget-ledger.types";

export interface CostAdjustmentInput {
  id: string;
  attemptId: string;
  workspace: string;
  expectedCostHash: string;
  cost: CostComputation;
  reason: string;
  actorId: string;
  source: "provider_usage" | "provider_job_result" | "reconciliation";
}

export interface CostAdjustmentRow {
  id: string;
  attempt_id: string;
  workspace_id: string;
  previous_hash: string;
  cost_hash: string;
  cost_json: string;
  reason: string;
  created_at: string;
}

export interface CostAdjustmentApplication {
  adjustment_id: string;
  workspace_id: string;
  request_id: string;
  attempt_id: string;
  reservation_id: string | null;
  revision: number;
  actor_id: string;
  source: CostAdjustmentInput["source"];
  application_hash: string;
  budget_state: "applied" | "applied_cost_only" | "not_applicable" | "pending";
  budget_cost_before: string | null;
  budget_cost_after: string | null;
  budget_tokens_before: string | null;
  budget_tokens_after: string | null;
  cost_delta: string;
  tokens_delta: string;
  allocations_json: string;
  created_at: string;
}

export interface CostAdjustmentView extends Omit<
  CostAdjustmentRow,
  "cost_json"
> {
  cost: CostComputation;
  application: Omit<CostAdjustmentApplication, "allocations_json"> & {
    allocations: BudgetLedgerHold[];
  };
}

/** All members are derived from immutable batch membership, never accepted from a client. */
export interface BatchCostAdjustmentInput {
  id: string;
  attemptId: string;
  workspace: string;
  expectedPhysicalCostHash: string;
  physicalCost: CostComputation;
  reason: string;
  actorId: string;
  source: CostAdjustmentInput["source"];
}

export interface BatchCostAdjustmentResult {
  id: string;
  batch_id: string;
  physical_attempt_id: string;
  revision: number;
  previous_physical_cost_hash: string;
  physical_cost_hash: string;
  dry_run: boolean;
  replayed: boolean;
  changes: Array<{
    request_id: string;
    attempt_id: string;
    previous_cost_hash: string;
    previous_cost: CostComputation;
    cost: CostComputation;
    adjustment: CostAdjustmentView | null;
  }>;
}

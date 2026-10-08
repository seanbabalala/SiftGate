import type { EntityManager } from "typeorm";
import type { BudgetLedgerHold } from "../budget/budget-ledger.types";
import type { CostAttemptRow } from "./cost-ledger.types";
import type { CostAdjustmentRow, CostAdjustmentApplication, CostAdjustmentView } from "./cost-adjustment.types";
import { pricingContentHash } from "./pricing-json";
import { PricingRepositoryError } from "./pricing-repository.types";
function conflict(message: string): never { throw new PricingRepositoryError("pricing_version_conflict", message, 409); }

/** Decode the complete revision chain, retaining the original receipt separately. */
export async function readCostAdjustmentHistory(
  manager: EntityManager,
  requestId: string,
  workspace: string,
  attempts: CostAttemptRow[],
): Promise<Map<string, CostAdjustmentView[]>> {
  if (!attempts.length) return new Map();
  const applications = await manager
    .createQueryBuilder()
    .select("m.*")
    .from("pricing_adjustment_applications", "m")
    .where("m.request_id = :request AND m.workspace_id = :workspace", {
      request: requestId,
      workspace,
    })
    .orderBy("m.revision", "ASC")
    .getRawMany<CostAdjustmentApplication>();
  const rows = await manager
    .createQueryBuilder()
    .select("a.*")
    .from("pricing_cost_adjustments", "a")
    .where("a.attempt_id IN (:...ids) AND a.workspace_id = :workspace", {
      ids: attempts.map((attempt) => attempt.id),
      workspace,
    })
    .getRawMany<CostAdjustmentRow>();
  return decodeCostAdjustmentHistory(attempts, applications, rows);
}

/** Same exact validation for sequential reads and one fresh owned SQL snapshot.
 * Callers supply scoped rows, never a reusable cross-transaction verification. */
export function decodeCostAdjustmentHistory(
  attempts: CostAttemptRow[], applications: CostAdjustmentApplication[], rows: CostAdjustmentRow[],
): Map<string, CostAdjustmentView[]> {
  if (!attempts.length) return new Map();
  const byId = new Map(
    applications.map((application) => [application.adjustment_id, application]),
  );
  const grouped = new Map<string, CostAdjustmentView[]>();
  for (const row of rows) {
    const application = byId.get(row.id);
    if (!application || application.attempt_id !== row.attempt_id)
      conflict("Cost adjustment application is missing or inconsistent");
    const { application_hash, ...applicationBody } = application;
    if (
      pricingContentHash({ row, application: applicationBody }) !==
      application_hash
    )
      conflict("Cost adjustment application integrity check failed");
    let cost: CostAdjustmentView["cost"];
    let allocations: BudgetLedgerHold[];
    try {
      cost = JSON.parse(row.cost_json);
      allocations = JSON.parse(application.allocations_json);
    } catch {
      conflict("Cost adjustment evidence is invalid");
    }
    if (pricingContentHash(cost!) !== row.cost_hash)
      conflict("Cost adjustment receipt hash mismatch");
    const { cost_json: _raw, ...metadata } = row;
    const { allocations_json: _allocations, ...effect } = application;
    const views = grouped.get(row.attempt_id) ?? [];
    views.push({
      ...metadata,
      cost: cost!,
      application: { ...effect, allocations: allocations! },
    });
    grouped.set(row.attempt_id, views);
  }
  for (const attempt of attempts) {
    const views = (grouped.get(attempt.id) ?? []).sort(
      (a, b) => a.application.revision - b.application.revision,
    );
    let hash = attempt.cost_hash;
    for (let index = 0; index < views.length; index++) {
      const view = views[index];
      if (
        view.application.revision !== index + 1 ||
        view.previous_hash !== hash
      )
        conflict("Cost adjustment chain is discontinuous");
      hash = view.cost_hash;
    }
  }
  return grouped;
}

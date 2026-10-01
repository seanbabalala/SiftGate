import type { EntityManager, TableOptions } from "typeorm";
import { pricingContentHash } from "./pricing-json";
import { PricingRepositoryError } from "./pricing-repository.types";
import type { ActualUpstreamBudgetPlan } from "./actual-upstream-budget.types";
import type { ActualBudgetCohortRow, ActualBudgetStoredClosure } from "./actual-upstream-budget-cohort.types";
export type { ActualBudgetClosurePayload, ActualBudgetCohortRow, ActualBudgetStoredClosure } from "./actual-upstream-budget-cohort.types";
import { runtimeOutcomeDocument } from "./pricing-outcome-document";
import type { RecoveryResolutionResult } from "./pricing-resolution.types";
import { verifyActualMediaAuthority, validateActualMediaAuthority } from "./actual-media-budget-evidence";

export const ACTUAL_BUDGET_COHORT_TABLE = "pricing_actual_budget_cohorts";
export const ACTUAL_BUDGET_COHORT_DEFINITIONS: TableOptions[] = [{
  name: ACTUAL_BUDGET_COHORT_TABLE,
  columns: [
    { name: "reservation_id", type: "varchar", isPrimary: true },
    ...["workspace_id", "request_id", "catalog_revision_id", "policy_hash", "closure_hash", "state", "created_at", "updated_at"].map(name => ({ name, type: "varchar", isNullable: false })),
    { name: "closure_json", type: "text", isNullable: false },
    { name: "applied_plan_json", type: "text", isNullable: true },
    { name: "applied_plan_hash", type: "varchar", isNullable: true },
    { name: "last_error_code", type: "varchar", isNullable: true },
  ],
  foreignKeys: [{ name: "fk_actual_budget_reservation", columnNames: ["reservation_id"], referencedTableName: "pricing_reservations", referencedColumnNames: ["id"], onDelete: "RESTRICT" }],
  indices: [{ name: "idx_actual_budget_pending", columnNames: ["state", "updated_at"] }, { name: "idx_actual_budget_request", columnNames: ["workspace_id", "request_id"] }],
}];

export function actualBudgetCohortIdentity(row: Pick<ActualBudgetCohortRow, "reservation_id" | "workspace_id" | "request_id" | "catalog_revision_id" | "policy_hash">, closure: ActualBudgetStoredClosure) {
  return { reservation_id: row.reservation_id, workspace_id: row.workspace_id, request_id: row.request_id, catalog_revision_id: row.catalog_revision_id, policy_hash: row.policy_hash, closure };
}
export function actualBudgetClosure(row: ActualBudgetCohortRow): ActualBudgetStoredClosure {
  const stored = JSON.parse(row.closure_json) as ActualBudgetStoredClosure;
  const { operator_authority, media_authority, ...payload } = stored;
  runtimeOutcomeDocument({ type: "actual_budget_closure", workspace: row.workspace_id, reservationId: row.reservation_id, payload });
  if (operator_authority !== undefined && (!operator_authority || typeof operator_authority !== "object" || Array.isArray(operator_authority) || Object.keys(operator_authority).sort().join(",") !== "audit_id,resolution_id" ||
    typeof operator_authority.resolution_id !== "string" || !operator_authority.resolution_id || operator_authority.resolution_id.length > 128 ||
    operator_authority.audit_id !== `recovery-resolution:${pricingContentHash([row.workspace_id, operator_authority.resolution_id])}`))
    throw new PricingRepositoryError("pricing_version_conflict", "Actual budget operator authority is invalid", 409);
  if (media_authority !== undefined && (operator_authority !== undefined || !validateActualMediaAuthority(media_authority)))
    throw new PricingRepositoryError("pricing_version_conflict", "Actual media closure authority is invalid", 409);
  return stored;
}

/** A historical pending acknowledgement remains valid after later automatic settlement. */
export async function verifyActualBudgetOperatorAuthority(manager: EntityManager, row: ActualBudgetCohortRow): Promise<boolean> {
  const authority = actualBudgetClosure(row).operator_authority;
  if (!authority) return false;
  const audit = await manager.createQueryBuilder().select("a.metadata_json", "metadata_json").from("pricing_audit_events", "a")
    .where("a.id = :id AND a.workspace_id = :workspace AND a.action = :action", { id: authority.audit_id, workspace: row.workspace_id, action: "cost.recovery_resolution" })
    .getRawOne<{ metadata_json: string }>();
  const stored = audit ? JSON.parse(audit.metadata_json) as { result: RecoveryResolutionResult; result_hash: string } : null;
  if (!stored || pricingContentHash(stored.result) !== stored.result_hash || stored.result.id !== authority.resolution_id || stored.result.dry_run ||
    !stored.result.changes.some(change => change.reservation_id === row.reservation_id && change.action === "reconcile_actual" && change.actual_closure_hash === row.closure_hash))
    throw new PricingRepositoryError("pricing_version_conflict", "Actual budget fence lacks its immutable operator acknowledgement", 409);
  return true;
}
/** Caller holds the request/reservation lock and persists its own authority in this transaction. */
export async function retainActualBudgetCohort(manager: EntityManager, row: ActualBudgetCohortRow): Promise<void> {
  if (!manager.queryRunner?.isTransactionActive || row.closure_hash !== pricingContentHash(actualBudgetCohortIdentity(row, actualBudgetClosure(row))))
    throw new PricingRepositoryError("pricing_version_conflict", "Actual budget closure requires a valid owned transaction", 409);
  await verifyActualBudgetOperatorAuthority(manager, row);
  await verifyActualMediaAuthority(manager, row, actualBudgetClosure(row));
  await manager.createQueryBuilder().insert().into(ACTUAL_BUDGET_COHORT_TABLE).values(row).execute();
}

export async function readActualBudgetCohort(manager: EntityManager, reservation: string, workspace: string): Promise<ActualBudgetCohortRow | null> {
  const row = await manager.createQueryBuilder().select("c.*").from(ACTUAL_BUDGET_COHORT_TABLE, "c")
    .where("c.reservation_id = :reservation", { reservation })
    .getRawOne<ActualBudgetCohortRow>();
  if (!row) return null;
  const { closure_hash, closure_json, applied_plan_json, applied_plan_hash, state } = row;
  try {
    const body: unknown = JSON.parse(closure_json);
    if (row.workspace_id !== workspace || pricingContentHash({ reservation_id: row.reservation_id, workspace_id: row.workspace_id, request_id: row.request_id, catalog_revision_id: row.catalog_revision_id, policy_hash: row.policy_hash, closure: body }) !== closure_hash ||
      !["pending", "applied", "review_required"].includes(state) || Boolean(applied_plan_json) !== Boolean(applied_plan_hash) ||
      (state === "applied" && !applied_plan_json)) throw new Error("identity");
    if (applied_plan_json) {
      const plan = JSON.parse(applied_plan_json) as ActualUpstreamBudgetPlan;
      const { plan_hash, ...content } = plan;
      if (plan_hash !== applied_plan_hash || pricingContentHash(content) !== plan_hash || plan.reservation_id !== reservation || plan.workspace_id !== workspace || plan.request_id !== row.request_id || plan.state !== "ready") throw new Error("plan");
    }
  } catch {
    throw new PricingRepositoryError("pricing_version_conflict", "Actual budget cohort integrity differs", 409);
  }
  actualBudgetClosure(row);
  await verifyActualBudgetOperatorAuthority(manager, row);
  await verifyActualMediaAuthority(manager, row, actualBudgetClosure(row));
  return row;
}

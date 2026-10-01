import type { EntityManager } from "typeorm";
import type { BudgetLedgerHold } from "../budget/budget-ledger.types";
import type { CostReservationRow, CostAttemptRow } from "./cost-ledger.types";
import type { ActualBudgetAttempt } from "./actual-upstream-budget.types";
import type { CostComputation } from "./pricing.types";
import { readCostAdjustmentHistory } from "./cost-adjustment-history";
import { pricingContentHash } from "./pricing-json";
import { PricingRepositoryError } from "./pricing-repository.types";
const conflict = (message: string): never => { throw new PricingRepositoryError("pricing_version_conflict", message, 409); };

/** Caller owns the request/reservation transaction; preflight bytes before hydration. */
export async function readActualBudgetEvidence(manager: EntityManager, row: CostReservationRow) {
  if (!manager.queryRunner?.isTransactionActive) conflict("Actual budget evidence requires an owned transaction");
    const reservationId = row.id, workspace = row.workspace_id;
    const byteSize = (column: string) => manager.connection.options.type === "postgres"
      ? `OCTET_LENGTH(COALESCE(${column}, ''))`
      : `LENGTH(CAST(COALESCE(${column}, '') AS BLOB))`;
    const selected = await manager.createQueryBuilder().select("a.id", "id")
      .addSelect(`${byteSize("a.cost_json")} + ${byteSize("a.price_context_json")}`, "bytes")
      .from("pricing_attempts", "a")
      .where("a.request_id = :request AND a.reservation_id = :id AND a.workspace_id = :workspace", { request: row.request_id, id: reservationId, workspace })
      .orderBy("a.id", "ASC").limit(1025).getRawMany<{ id: string; bytes: string | number }>();
    if (selected.length > 1024) conflict("Actual budget evidence exceeds its bounded read");
    const historySize = selected.length ? await manager.createQueryBuilder()
      .select("COUNT(*)", "count").addSelect(`SUM(${byteSize("a.cost_json")})`, "bytes")
      .from("pricing_cost_adjustments", "a")
      .where("a.attempt_id IN (:...ids) AND a.workspace_id = :workspace", { ids: selected.map(a => a.id), workspace })
      .getRawOne<{ count: string | number; bytes: string | number }>() : undefined;
    const applicationSize = await manager.createQueryBuilder().select("COUNT(*)", "count")
      .addSelect(`SUM(${byteSize("a.allocations_json")})`, "bytes")
      .from("pricing_adjustment_applications", "a")
      .where("a.request_id = :request AND a.workspace_id = :workspace", { request: row.request_id, workspace })
      .getRawOne<{ count: string | number; bytes: string | number }>();
    if (Number(historySize?.count ?? 0) > 4096 || Number(applicationSize?.count ?? 0) > 4096 ||
      selected.reduce((sum, a) => sum + Number(a.bytes), 0) + Number(historySize?.bytes ?? 0) + Number(applicationSize?.bytes ?? 0) > 8 * 1024 * 1024)
      conflict("Actual budget receipt history exceeds the bounded inspection size");
    const attempts = await manager.createQueryBuilder().select("a.*").from("pricing_attempts", "a")
      .where("a.request_id = :request AND a.reservation_id = :id AND a.workspace_id = :workspace", { request: row.request_id, id: reservationId, workspace })
      .orderBy("a.id", "ASC").limit(1025).getRawMany<CostAttemptRow>();
    if (attempts.length > 1024) conflict("Actual budget evidence exceeds its bounded read");
    const history = await readCostAdjustmentHistory(manager, row.request_id, workspace, attempts);
    const holds = JSON.parse(row.holds_json) as BudgetLedgerHold[];
    if (!Array.isArray(holds) || holds.some(hold => hold.workspaceId !== workspace))
      conflict("Actual budget holds cross workspace boundaries");
  const effective: ActualBudgetAttempt[] = attempts.map(attempt => {
    const original = attempt.cost_json ? JSON.parse(attempt.cost_json) as CostComputation : null;
    if ((original && pricingContentHash(original) !== attempt.cost_hash) || (!original && attempt.cost_hash)) conflict("Original cost receipt integrity differs during actual budget planning");
    const latest = history.get(attempt.id)?.at(-1);
    return { id: attempt.id, workspace_id: attempt.workspace_id, request_id: attempt.request_id, reservation_id: attempt.reservation_id, state: attempt.state, fee_source: attempt.fee_source, error_code: attempt.error_code, cost: latest?.cost ?? original, cost_hash: latest?.cost_hash ?? attempt.cost_hash };
  });
  return { records: attempts, history, effective, requireTokens: holds.some(hold => hold.type === "daily_tokens") };
}

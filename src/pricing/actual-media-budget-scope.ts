import type { EntityManager } from "typeorm";
import type { MediaTaskRow } from "./media-task.types";
import type { CostAttemptRow } from "./cost-ledger.types";
import { mediaTaskContext } from "./media-observation-evidence";
import { PricingRepositoryError } from "./pricing-repository.types";
import { limitReplayQuery, replayBudget } from "./pricing-replay-budget";

/** Read-only inventory, also used by summaries. Writers must hold the request fence. */
export async function readActualMediaTasks(manager: EntityManager, reservation: string, workspace: string, request: string): Promise<MediaTaskRow[]> {
  const size = manager.connection.options.type === "postgres" ? "OCTET_LENGTH(t.context_json)" : "LENGTH(CAST(t.context_json AS BLOB))";
  const query = () => manager.createQueryBuilder().from("pricing_media_tasks", "t")
    .where("t.reservation_id = :reservation AND t.workspace_id = :workspace", { reservation, workspace });
  const budget = replayBudget(manager);
  if (!budget) {
    const footprint = await query().select("COUNT(*)", "count").addSelect(`SUM(${size})`, "bytes").getRawOne<{ count: string; bytes: string }>();
    if (Number(footprint?.count ?? 0) > 1024 || Number(footprint?.bytes ?? 0) > 8 * 1024 * 1024)
      throw new PricingRepositoryError("pricing_media_task_conflict", "Media scope exceeds bounded inspection", 409);
    if (Number(footprint?.count ?? 0) === 0) return [];
  }
  const select = query().select("t.*").orderBy("t.id", "ASC");
  const tasks = await (budget ? limitReplayQuery(select, 1024, 8 * 1024 * 1024) : select).getRawMany<MediaTaskRow>();
  for (const task of tasks) {
    mediaTaskContext(task);
    const attempt = await manager.createQueryBuilder().select("a.id,a.request_id,a.reservation_id,a.workspace_id,a.node_id,a.model,a.fee_source")
      .from("pricing_attempts", "a").where("a.id = :id AND a.workspace_id = :workspace", { id: task.id, workspace }).getRawOne<CostAttemptRow>();
    if (task.request_id !== request || !attempt || attempt.request_id !== request || attempt.reservation_id !== reservation ||
      attempt.fee_source !== "provider" || task.node_id !== attempt.node_id || task.model !== attempt.model)
      throw new PricingRepositoryError("pricing_media_task_conflict", "Media scope lost original attempt ownership", 409);
  }
  return tasks;
}

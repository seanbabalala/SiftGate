import type { DataSource, EntityManager } from "typeorm";
import { serializeDatabaseAccess } from "../database/database-serialization";
import { pricingBypassAuditId } from "./pricing-bypass";

export interface PricingEvidenceCursor { workspace: string; at: string; id: string }
export interface PricingEvidencePurgeResult {
  scanned: number;
  purged: number;
  /** Not removable: unsettled, under review, corrected or otherwise still referenced. */
  kept: number;
  /** A foreign key rejected the delete; the request's rows were rolled back. */
  blocked: number;
  /** Resume point for the next run; null once every candidate before the cutoff was visited. */
  next: PricingEvidenceCursor | null;
}

/** Raised inside a purge transaction so a request whose rows changed rolls back untouched. */
class EvidenceChanged extends Error {}

const SETTLED = new Set(["committed", "released"]);
const EFFECTS = new Set(["reserve", "commit", "release"]);
const MARKERS = ["retained", "delivered", "review_required"] as const;
const PAGE = 100;

/**
 * Deletes the complete pricing evidence of fully settled requests admitted before `before`.
 * A request qualifies only when every hold is committed or released, every attempt is terminal,
 * every settlement intent is applied, every runtime outcome is delivered, and no recovery,
 * correction, disposition, cohort, media, group, batch or bypass record refers to it. Each request
 * is one transaction under the request fence; RESTRICT foreign keys reject any other dependant.
 * Lookups use primary keys or (workspace, request) indexes only: a `workspace_id = ? AND id IN`
 * filter is planned by SQLite as a scan of the whole workspace.
 */
export async function purgeSettledPricingEvidence(
  source: DataSource,
  options: { before: Date; limit: number; after?: PricingEvidenceCursor | null; shouldStop?: () => boolean },
): Promise<PricingEvidencePurgeResult> {
  const before = options.before.toISOString();
  const result: PricingEvidencePurgeResult = { scanned: 0, purged: 0, kept: 0, blocked: 0, next: null };
  const workspaces = (await serializeDatabaseAccess(source, () => source.createQueryBuilder()
    .select("DISTINCT s.workspace_id", "workspace_id").from("pricing_request_snapshots", "s")
    .where("s.created_at < :before", { before }).getRawMany<{ workspace_id: string }>()))
    .map(row => row.workspace_id).sort();
  const start = options.after ?? null;
  for (const workspace of workspaces) {
    if (start && workspace < start.workspace) continue;
    let position = start && start.workspace === workspace ? { at: start.at, id: start.id } : null;
    for (;;) {
      if (result.scanned >= options.limit || options.shouldStop?.()) {
        result.next = { workspace, at: position?.at ?? "", id: position?.id ?? "" };
        return result;
      }
      const page = await serializeDatabaseAccess(source, () => {
        const query = source.createQueryBuilder().select(["s.request_id AS request_id", "s.created_at AS created_at"])
          .from("pricing_request_snapshots", "s")
          .where("s.workspace_id = :workspace AND s.created_at < :before", { workspace, before });
        if (position) query.andWhere("s.created_at >= :at AND (s.created_at > :at OR s.request_id > :id)", position);
        return query.orderBy("s.created_at", "ASC").addOrderBy("s.request_id", "ASC")
          .limit(Math.min(PAGE, options.limit - result.scanned)).getRawMany<{ request_id: string; created_at: string }>();
      });
      if (!page.length) break;
      for (const row of page) {
        result.scanned++;
        result[await purgeRequest(source, workspace, row.request_id, before)]++;
        position = { at: row.created_at, id: row.request_id };
        // Each request is a short transaction; let request traffic run between them.
        await new Promise<void>(resolve => setImmediate(resolve));
      }
    }
  }
  return result;
}

async function purgeRequest(source: DataSource, workspace: string, request: string, before: string): Promise<"purged" | "kept" | "blocked"> {
  try {
    return await serializeDatabaseAccess(source, () => source.transaction(manager => removeSettledRequest(manager, workspace, request, before)));
  } catch (error) {
    if (error instanceof EvidenceChanged) return "kept";
    if (isForeignKeyViolation(error)) return "blocked";
    throw error;
  }
}

async function removeSettledRequest(manager: EntityManager, workspace: string, request: string, before: string): Promise<"purged" | "kept"> {
  const rows = <T>(table: string, columns: string[], where: string, parameters: object) => manager.createQueryBuilder()
    .select(columns.map(column => `x.${column} AS ${column}`)).from(table, "x").where(where, parameters).getRawMany<T>();
  const fence = manager.createQueryBuilder().select(["x.workspace_id AS workspace_id", "x.created_at AS created_at"])
    .from("pricing_request_snapshots", "x").where("x.request_id = :request", { request });
  if (manager.connection.options.type === "postgres") fence.setLock("pessimistic_write");
  const snapshot = await fence.getRawOne<{ workspace_id: string; created_at: string }>();
  if (!snapshot || snapshot.workspace_id !== workspace || !(snapshot.created_at < before)) return "kept";
  const scope = { workspace, request };
  const holds = await rows<{ id: string; state: string }>("pricing_reservations", ["id", "state"],
    "x.workspace_id = :workspace AND x.request_id = :request", scope);
  if (!holds.length || holds.some(hold => !SETTLED.has(hold.state))) return "kept";
  const holdIds = new Set(holds.map(hold => hold.id));
  const attempts = await rows<{ id: string; state: string; reservation_id: string; price_context_json: string }>("pricing_attempts",
    ["id", "state", "reservation_id", "price_context_json"], "x.workspace_id = :workspace AND x.request_id = :request", scope);
  if (attempts.some(attempt => attempt.state !== "terminal" || !holdIds.has(attempt.reservation_id) || batched(attempt.price_context_json))) return "kept";
  const intents = await rows<{ reservation_id: string; state: string }>("pricing_settlement_intents", ["reservation_id", "state"],
    "x.workspace_id = :workspace AND x.request_id = :request", scope);
  if (intents.length !== holds.length || intents.some(intent => intent.state !== "applied" || !holdIds.has(intent.reservation_id))) return "kept";
  const effects = await rows<{ id: string; reservation_id: string; kind: string }>("pricing_budget_effects", ["id", "reservation_id", "kind"],
    "x.workspace_id = :workspace AND x.request_id = :request", scope);
  if (effects.some(effect => !EFFECTS.has(effect.kind) || !holdIds.has(effect.reservation_id))) return "kept";
  const subjects = [...attempts.map(attempt => ["attempt", attempt.id]), ...holds.map(hold => ["settlement", hold.id])];
  const outcomes: Array<{ id: string; state: string; reservation_id: string }> = [];
  for (const [kind, subject] of subjects)
    outcomes.push(...await rows<{ id: string; state: string; reservation_id: string }>("pricing_runtime_outcomes", ["id", "state", "reservation_id"],
      "x.workspace_id = :workspace AND x.kind = :kind AND x.subject_id = :subject", { workspace, kind, subject }));
  if (outcomes.some(outcome => outcome.state !== "delivered" || !holdIds.has(outcome.reservation_id))) return "kept";
  if (await referenced(manager, workspace, request, [...holdIds], attempts.map(attempt => attempt.id))) return "kept";
  const markerIds = outcomes.flatMap(outcome => MARKERS.map(marker => `${outcome.id}:${marker}`));
  const markers = markerIds.length ? await rows<{ id: string; workspace_id: string }>("pricing_audit_events", ["id", "workspace_id"],
    "x.id IN (:...ids)", { ids: markerIds }) : [];
  if (markers.some(marker => marker.workspace_id !== workspace)) return "kept";
  await remove(manager, "pricing_audit_events", "id", markers.map(marker => marker.id));
  await remove(manager, "pricing_runtime_outcomes", "id", outcomes.map(outcome => outcome.id));
  await remove(manager, "pricing_settlement_intents", "reservation_id", intents.map(intent => intent.reservation_id));
  await remove(manager, "pricing_budget_effects", "id", effects.map(effect => effect.id));
  await remove(manager, "pricing_attempts", "id", attempts.map(attempt => attempt.id));
  await remove(manager, "pricing_reservations", "id", [...holdIds]);
  await remove(manager, "pricing_request_snapshots", "request_id", [request]);
  return "purged";
}

async function referenced(manager: EntityManager, workspace: string, request: string, holds: string[], attempts: string[]): Promise<boolean> {
  const exists = async (table: string, where: string, parameters: object) => Boolean(await manager.createQueryBuilder()
    .select("1", "found").from(table, "x").where(where, parameters).limit(1).getRawOne());
  for (const id of holds) {
    for (const table of ["pricing_recovery_cases", "pricing_recovery_decisions", "pricing_actual_budget_cohorts"])
      if (await exists(table, "x.reservation_id = :id", { id })) return true;
    for (const table of ["pricing_media_tasks", "pricing_runtime_group_outcome_members"])
      if (await exists(table, "x.workspace_id = :workspace AND x.reservation_id = :id", { workspace, id })) return true;
  }
  for (const id of attempts) {
    if (await exists("pricing_cost_adjustments", "x.workspace_id = :workspace AND x.attempt_id = :id", { workspace, id })) return true;
    if (await exists("pricing_batch_manifests", "x.physical_attempt_id = :id", { id })) return true;
  }
  for (const table of ["pricing_adjustment_applications", "pricing_runtime_outcome_dispositions"])
    if (await exists(table, "x.workspace_id = :workspace AND x.request_id = :request", { workspace, request })) return true;
  return exists("pricing_audit_events", "x.id = :id", { id: pricingBypassAuditId(workspace, request) });
}

async function remove(manager: EntityManager, table: string, key: string, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const result = await manager.createQueryBuilder().delete().from(table).where(`${key} IN (:...ids)`, { ids }).execute();
  if (result.affected !== ids.length) throw new EvidenceChanged();
}

function batched(priceContext: string): boolean {
  const parsed = JSON.parse(priceContext) as { batch?: unknown } | null;
  return parsed?.batch !== undefined && parsed?.batch !== null;
}

/** SQLite reports an ON DELETE RESTRICT rejection as SQLITE_CONSTRAINT_TRIGGER; PostgreSQL as 23001. */
function isForeignKeyViolation(error: unknown): boolean {
  const outer = error as { code?: string; message?: string; driverError?: { code?: string; message?: string } } | null;
  const code = outer?.driverError?.code ?? outer?.code;
  const message = outer?.driverError?.message ?? outer?.message ?? "";
  if (code === "23001" || code === "23503") return true;
  return (code === "SQLITE_CONSTRAINT_FOREIGNKEY" || code === "SQLITE_CONSTRAINT_TRIGGER") && message.includes("FOREIGN KEY constraint failed");
}

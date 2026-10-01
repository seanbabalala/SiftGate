import type { EntityManager } from "typeorm";
import { mediaSupplierError } from "./media-supplier-event";
import { pricingContentHash } from "./pricing-json";

export function mediaJobKey(
  connection: string,
  credential: string,
  job: string,
) {
  return pricingContentHash([connection, credential, job]);
}
/** Shared across signed and manually correlated job associations, including initially empty maps. */
export async function lockMediaJobIdentity(
  manager: EntityManager,
  key: string,
): Promise<void> {
  if (manager.connection.options.type !== "postgres") return;
  if (!manager.queryRunner?.isTransactionActive)
    throw new Error("Media job identity lock requires a transaction");
  const table = manager.connection.driver.buildTableName(
    "pricing_media_tasks",
    manager.connection.options.schema,
  );
  await manager.query(
    "SELECT pg_advisory_xact_lock(hashtext($1::text), hashtext($2::text))",
    ["siftgate.media-job", `${table}:${key}`],
  );
}
export async function assertMediaJobUnclaimed(
  manager: EntityManager,
  taskId: string,
  connection: string,
  credential: string,
  job: string,
): Promise<string> {
  const key = mediaJobKey(connection, credential, job);
  await lockMediaJobIdentity(manager, key);
  for (const table of [
    "pricing_media_event_heads",
    "pricing_media_job_reconciliations",
  ]) {
    const existing = await manager
      .createQueryBuilder()
      .select("j.task_id", "task_id")
      .from(table, "j")
      .where("j.job_key = :key", { key })
      .getRawOne<{ task_id: string }>();
    if (existing && existing.task_id !== taskId)
      mediaSupplierError(
        "Provider job is already associated with another task",
      );
  }
  const other = await manager
    .createQueryBuilder()
    .select("t.id", "id")
    .from("pricing_media_tasks", "t")
    .where(
      "t.connection_hash = :connection AND t.credential_id = :credential AND t.provider_job_id = :job AND t.id <> :id",
      { connection, credential, job, id: taskId },
    )
    .limit(1)
    .getRawOne<{ id: string }>();
  if (other)
    mediaSupplierError("Provider job is already associated with another task");
  return key;
}

import type { EntityManager } from "typeorm";
import { Workspace } from "../database/entities";

/** Shared by workspace, membership and invitation writers, including empty sets. */
export async function lockWorkspaceWriter(
  manager: EntityManager | undefined,
  workspaceId: string,
): Promise<void> {
  if (!manager || manager.connection.options.type !== "postgres") return;
  if (!manager.queryRunner?.isTransactionActive)
    throw new Error("Workspace writer lock requires an active transaction");
  // Use the same schema-qualified namespace across repositories and connections.
  const table = manager.connection.driver.buildTableName(
    "workspaces",
    manager.connection.options.schema,
  );
  await manager.query(
    "SELECT pg_advisory_xact_lock(hashtext($1::text), hashtext($2::text))",
    ["siftgate.workspace-writer", `${table}:${workspaceId}`],
  );
}

export async function lockOrganizationBootstrap(
  manager: EntityManager | undefined,
): Promise<void> {
  if (!manager || manager.connection.options.type !== "postgres") return;
  if (!manager.queryRunner?.isTransactionActive)
    throw new Error("Organization bootstrap requires an active transaction");
  const table = manager.getRepository(Workspace).metadata.tablePath;
  await manager.query(
    "SELECT pg_advisory_xact_lock(hashtext($1::text), hashtext($2::text))",
    ["siftgate.organization-bootstrap", table],
  );
}

import type { EntityManager, ObjectLiteral, Repository } from "typeorm";
import { serializeDatabaseAccess } from "./database-serialization";

/** Use only with an explicitly scoped repository when joining an existing transaction. */
export async function coordinatedRepositoryOperation<
  Entity extends ObjectLiteral,
  T,
>(
  repository: Repository<Entity>,
  write: boolean,
  action: (manager?: EntityManager) => Promise<T>,
): Promise<T> {
  const manager = repository.manager;
  const source = manager?.connection;
  // Lightweight repository test doubles do not expose a database connection.
  if (!source) return action();
  if (manager.queryRunner?.isTransactionActive) return action(manager);
  return serializeDatabaseAccess(source, () =>
    write ? source.transaction(action) : action(manager),
  );
}

/** Keep the callback database-only; never hold the SQLite queue across provider work. */
export function withCoordinatedRepository<Entity extends ObjectLiteral, T>(
  repository: Repository<Entity>,
  write: boolean,
  action: (scoped: Repository<Entity>, manager?: EntityManager) => Promise<T>,
): Promise<T> {
  return coordinatedRepositoryOperation(repository, write, (manager) =>
    action(
      manager ? manager.getRepository(repository.target) : repository,
      manager,
    ),
  );
}

/** Protect read/create decisions, including an absent natural key, across PostgreSQL connections. */
export async function lockRepositoryWriter<Entity extends ObjectLiteral>(
  repository: Repository<Entity>,
  manager: EntityManager | undefined,
  key: string,
): Promise<void> {
  if (!manager || manager.connection.options.type !== "postgres") return;
  requireRepositoryTransaction(repository, manager);
  await manager.query(
    "SELECT pg_advisory_xact_lock(hashtext($1::text), hashtext($2::text))",
    [
      "siftgate.repository-writer",
      JSON.stringify([repository.metadata.tablePath, key]),
    ],
  );
}

export function requireRepositoryTransaction<Entity extends ObjectLiteral>(
  repository: Repository<Entity>,
  manager: EntityManager,
): void {
  if (
    manager.connection !== repository.manager?.connection ||
    !manager.queryRunner?.isTransactionActive
  ) {
    throw new Error("An active transaction on the same database is required");
  }
}

/** Translate only the scoped-name constraint, never unrelated storage failures. */
export function isUniqueNameConflict<Entity extends ObjectLiteral>(
  repository: Repository<Entity>,
  error: unknown,
): boolean {
  return isUniqueColumnsConflict(repository, error, ["workspace_id", "name"]);
}

export function isUniqueColumnsConflict<Entity extends ObjectLiteral>(
  repository: Repository<Entity>,
  error: unknown,
  columns: string[],
  knownConstraints: readonly string[] = [],
): boolean {
  if (!error || typeof error !== "object") return false;
  const outer = error as {
    driverError?: { code?: string; constraint?: string; message?: string };
    code?: string;
    constraint?: string;
    message?: string;
  };
  const driver = outer.driverError ?? outer;
  if (driver.code === "23505")
    return (
      knownConstraints.includes(driver.constraint ?? "") ||
      repository.metadata.indices.some(
        (index) =>
          index.isUnique &&
          index.name === driver.constraint &&
          index.columns.length === columns.length &&
          columns.every((name) =>
            index.columns.some((column) => column.propertyName === name),
          ),
      )
    );
  return (
    driver.code === "SQLITE_CONSTRAINT_UNIQUE" &&
    Boolean(
      columns.every((name) =>
        driver.message?.includes(`${repository.metadata.tableName}.${name}`),
      ),
    )
  );
}

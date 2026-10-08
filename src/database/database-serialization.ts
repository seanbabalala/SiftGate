import type { DataSource } from "typeorm";

const sqliteQueues = new WeakMap<DataSource, Promise<void>>();

/** SQLite's TypeORM DataSource shares one connection; unrelated async transactions must not overlap. */
export async function serializeDatabaseAccess<T>(
  dataSource: DataSource,
  action: () => Promise<T>,
): Promise<T> {
  if (dataSource.options.type !== "better-sqlite3") return action();
  const previous = sqliteQueues.get(dataSource) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  sqliteQueues.set(
    dataSource,
    previous.then(() => current),
  );
  await previous;
  try {
    return await action();
  } finally {
    release();
  }
}

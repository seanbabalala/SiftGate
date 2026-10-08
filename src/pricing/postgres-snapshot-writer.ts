import { QueryFailedError, type EntityManager } from 'typeorm';
import { canExecutePostgresOwnedProgram, renderPostgresScalarStatement } from './postgres-read-program';

interface SnapshotRow {
  request_id: string;
  workspace_id: string;
  catalog_revision_id: string;
  snapshot_hash: string;
  descriptor_json: string;
  created_at: string;
}
interface Result { command: string; rowCount: number | null; rows: SnapshotRow[] }
interface Client { query(sql: string): Promise<Result | Result[]> }

/** Keep INSERT and the authoritative fresh SELECT as separate server commands
 * in one transport. A bare RETURNING row would miss an AFTER-trigger UPDATE;
 * sibling data-modifying CTEs would share a snapshot. Neither shortcut is used.
 * Null means no command ran and the ordinary bound-query path is required.
 */
export async function tryInsertPricingSnapshot(
  manager: EntityManager, input: Readonly<SnapshotRow>,
): Promise<{ row: SnapshotRow | undefined } | null> {
  if (!canExecutePostgresOwnedProgram(manager)) return null;
  const table = 'pricing_request_snapshots';
  if (manager.connection.hasMetadata(table) && manager.connection.getMetadata(table).listeners.length) return null;
  const row = { ...input };
  const queries = [
    manager.createQueryBuilder().insert().into(table).values(row).orIgnore(),
    manager.createQueryBuilder().select('s.*').from(table, 's')
      .where('s.request_id = :id AND s.workspace_id = :workspace', { id: row.request_id, workspace: row.workspace_id }),
  ];
  const commands = ['INSERT', 'SELECT'] as const;
  const statements = queries.map((query, index) => {
    const [sql, parameters] = query.getQueryAndParameters();
    return renderPostgresScalarStatement({ sql, parameters }, commands[index]);
  });
  if (statements.some(statement => statement === null)) return null;
  const sql = '/* siftgate_snapshot_insert_read:2 */\n' + statements.join(';\n');
  if (Buffer.byteLength(sql) > 262144) return null;
  const runner = manager.queryRunner!, client = await runner.connect() as Client;
  if (!canExecutePostgresOwnedProgram(manager)) return null;
  const logger = manager.connection.logger, began = Date.now();
  logger.logQuery(sql, undefined, runner);
  try {
    const raw = await client.query(sql), results = Array.isArray(raw) ? raw : [raw];
    if (results.length !== 2 || results[0].command !== 'INSERT' || ![0, 1].includes(results[0].rowCount ?? -1) ||
      !Array.isArray(results[0].rows) || results[0].rows.length !== 0 || results[1].command !== 'SELECT' ||
      !Array.isArray(results[1].rows) || results[1].rowCount !== results[1].rows.length || results[1].rows.length > 1)
      throw new Error('PostgreSQL returned an incomplete snapshot insert/read acknowledgement');
    const elapsed = Date.now() - began, slow = manager.connection.options.maxQueryExecutionTime;
    if (slow && elapsed > slow) logger.logQuerySlow(elapsed, sql, undefined, runner);
    return { row: results[1].rows[0] };
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    logger.logQueryError(failure, sql, undefined, runner);
    throw new QueryFailedError(sql, undefined, failure);
  }
}

import type { EntityManager, Repository } from 'typeorm';
import { CallLog } from '../database/entities/call-log.entity';
import { RouteDecisionLog } from '../database/entities/route-decision-log.entity';
import { normalizeWorkspaceId } from '../workspaces/workspace-scope';

export interface SettlementLogPair {
  call: CallLog;
  route?: RouteDecisionLog;
}

/** Only ordinary new log rows use the paired insertion. Preserve the ORM path
 * when subscribers/listeners or explicit identities require its save semantics.
 */
export function canInsertSettlementLogPair(manager: EntityManager, logs: SettlementLogPair): boolean {
  return manager.connection.options.type === 'postgres' && manager.connection.subscribers.length === 0 &&
    logs.call.id === undefined && (logs.route === undefined || logs.route.id === undefined) &&
    manager.getRepository(CallLog).metadata.listeners.length === 0 &&
    (logs.route === undefined || manager.getRepository(RouteDecisionLog).metadata.listeners.length === 0);
}

/** One bound SQL statement inside the caller's existing savepoint. Neither this
 * function nor its returned rows acknowledge the enclosing money transaction.
 */
export async function insertSettlementLogPair(manager: EntityManager, logs: SettlementLogPair): Promise<SettlementLogPair> {
  if (!manager.queryRunner?.isTransactionActive || !canInsertSettlementLogPair(manager, logs))
    throw new Error('Paired settlement logs require an owning PostgreSQL transaction and new unhooked rows');
  if (logs.route && (logs.route.request_id !== logs.call.request_id ||
    normalizeWorkspaceId(logs.route.workspace_id) !== normalizeWorkspaceId(logs.call.workspace_id)))
    throw new Error('Paired settlement log ownership differs');
  const parameters: unknown[] = [];
  const bind = (value: unknown) => `$${parameters.push(value)}`;
  const callRepo = manager.getRepository(CallLog), routeRepo = logs.route ? manager.getRepository(RouteDecisionLog) : undefined;
  const callInsert = insert(callRepo, logs.call, bind);
  const routeInsert = logs.route ? insert(routeRepo!, logs.route, bind) : undefined;
  const rows: Array<{ saved_call: Record<string, unknown>; saved_route: Record<string, unknown> | null }> = await manager.query(
    `WITH ${routeInsert ? `settlement_route AS (${routeInsert}),` : ''}
      settlement_call AS (${callInsert})
      SELECT to_jsonb(settlement_call) AS saved_call,
        ${routeInsert ? '(SELECT to_jsonb(settlement_route) FROM settlement_route)' : 'NULL::jsonb'} AS saved_route
      FROM settlement_call`, parameters,
  );
  if (rows.length !== 1 || !rows[0].saved_call || (logs.route && !rows[0].saved_route))
    throw new Error('A paired settlement log insertion was suppressed');
  hydrate(callRepo, logs.call, rows[0].saved_call);
  if (logs.route) hydrate(routeRepo!, logs.route, rows[0].saved_route!);
  return logs;
}

function insert<T extends CallLog | RouteDecisionLog>(repo: Repository<T>, entity: T, bind: (value: unknown) => string): string {
  const { driver } = repo.manager.connection;
  const columns = repo.metadata.columns.filter(column => column.isInsert && !column.isVirtualProperty &&
    !(column.isGenerated && column.generationStrategy === 'increment'));
  const values = columns.map(column => {
    const value = column.getEntityValue(entity);
    return value === undefined ? 'DEFAULT' : bind(driver.preparePersistentValue(value, column));
  });
  const table = [repo.metadata.schema, repo.metadata.tableName].filter((value): value is string => !!value)
    .map(value => driver.escape(value)).join('.');
  return `INSERT INTO ${table} (${columns.map(column => driver.escape(column.databaseName)).join(', ')})
    VALUES (${values.join(', ')})
    RETURNING ${repo.metadata.getInsertionReturningColumns().map(column => driver.escape(column.databaseName)).join(', ')}`;
}

function hydrate<T extends CallLog | RouteDecisionLog>(repo: Repository<T>, entity: T, row: Record<string, unknown>): void {
  // Repository.save normalizes absent nullable properties on the returned
  // entity before merging its generated/default values. Keep that API shape.
  for (const column of repo.metadata.columns) {
    if (column.isNullable && !column.isVirtualProperty && column.getEntityValue(entity) === undefined)
      column.setEntityValue(entity, null);
  }
  for (const column of repo.metadata.getInsertionReturningColumns()) {
    if (!(column.databaseName in row)) throw new Error('Paired log returning columns are incomplete');
    column.setEntityValue(entity, repo.manager.connection.driver.prepareHydratedValue(row[column.databaseName], column));
  }
}

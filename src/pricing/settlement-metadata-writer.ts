import { QueryFailedError, type EntityManager } from 'typeorm';
import { CallLog } from '../database/entities/call-log.entity';
import { workspaceFindWhere } from '../workspaces/workspace-scope';
import type { CostReservationRow, CostSettlementIntentRow } from './cost-ledger.types';
import { PricingRepositoryError } from './pricing-repository.types';
import { canExecutePostgresReadProgram, renderPostgresScalarStatement } from './postgres-read-program';

export type SettlementReservationPatch = Pick<CostReservationRow,
  'state' | 'committed_tokens' | 'committed_cost_usd' | 'budget_basis' | 'updated_at'>;
interface UpdateResult { command: string; rowCount: number | null; rows: unknown[] }
interface UpdateClient { query(sql: string): Promise<UpdateResult | UpdateResult[]> }
interface StatementBuilder { getQueryAndParameters(): [string, unknown[]] }

/** Execute only the four existing request-owned metadata updates, in their
 * original server order. Every result is real and checked BEFORE any shared
 * budget mutation. A false result means no SQL ran and the ORM path is required.
 */
export async function tryWriteSettlementMetadata(
  manager: EntityManager, row: CostReservationRow, intent: CostSettlementIntentRow,
  projection: { costUsd: number } | null, patch?: SettlementReservationPatch,
): Promise<boolean> {
  if (!canExecutePostgresReadProgram(manager)) return false;
  for (const table of ['pricing_reservations', 'pricing_settlement_intents', 'pricing_recovery_cases', 'call_logs']) {
    if (manager.connection.hasMetadata(table) && manager.connection.getMetadata(table).listeners.length) return false;
  }
  if (row.id !== intent.reservation_id || row.request_id !== intent.request_id || row.workspace_id !== intent.workspace_id ||
    patch && (row.state !== 'reserved' || !['committed', 'released'].includes(patch.state)))
    throw new PricingRepositoryError('pricing_version_conflict', 'Settlement metadata ownership or state differs', 409);
  const updates: Array<{ query: StatementBuilder; exact?: number }> = [];
  if (patch) updates.push({
    query: manager.createQueryBuilder().update('pricing_reservations').set(patch)
      .where('id = :id AND workspace_id = :workspace AND state = :state', { id: row.id, workspace: row.workspace_id, state: 'reserved' }),
    exact: 1,
  });
  if (intent.state !== 'applied') updates.push({
    query: manager.createQueryBuilder().update('pricing_settlement_intents')
      .set({ state: 'applied', applied_at: new Date().toISOString(), last_error_code: null })
      .where('reservation_id = :id AND workspace_id = :workspace', { id: row.id, workspace: row.workspace_id }),
    exact: 1,
  });
  const now = new Date().toISOString();
  updates.push({ query: manager.createQueryBuilder().update('pricing_recovery_cases')
    .set({ state: 'resolved', revision: () => 'revision + 1', updated_at: now, resolved_at: now, resolution_code: 'settlement_applied' })
    .where('reservation_id = :id AND workspace_id = :workspace AND state = :state', { id: row.id, workspace: row.workspace_id, state: 'open' }) });
  if (projection) updates.push({ query: manager.getRepository(CallLog).createQueryBuilder().update(CallLog)
    .set({ cost_usd: projection.costUsd, cost_without_cache_usd: null })
    .where(workspaceFindWhere(row.workspace_id, { request_id: row.request_id })) });
  const statements = updates.map(({ query }) => {
    const [sql, parameters] = query.getQueryAndParameters();
    return renderPostgresScalarStatement({ sql, parameters }, 'UPDATE');
  });
  if (statements.some(sql => sql === null)) return false;
  const sql = `/* siftgate_settlement_metadata:${updates.length} */\n` + statements.join(';\n');
  if (Buffer.byteLength(sql) > 262144) return false;
  const runner = manager.queryRunner!, client = await runner.connect() as UpdateClient;
  const logger = manager.connection.logger, begin = Date.now();
  logger.logQuery(sql, undefined, runner);
  let raw: UpdateResult | UpdateResult[];
  try {
    // Separate statements retain read-your-writes and cross-table trigger order;
    // unlike sibling data-modifying CTEs they do not share one command snapshot.
    raw = await client.query(sql);
    const elapsed = Date.now() - begin, slow = manager.connection.options.maxQueryExecutionTime;
    if (slow && elapsed > slow) logger.logQuerySlow(elapsed, sql, undefined, runner);
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    logger.logQueryError(failure, sql, undefined, runner);
    throw new QueryFailedError(sql, undefined, failure);
  }
  const results = Array.isArray(raw) ? raw : [raw];
  if (results.length !== updates.length || results.some((result, index) => result.command !== 'UPDATE' ||
    !Array.isArray(result.rows) || result.rowCount === null || !Number.isSafeInteger(result.rowCount) || result.rowCount < 0 ||
    updates[index].exact !== undefined && result.rowCount !== updates[index].exact))
    throw new PricingRepositoryError('pricing_version_conflict', 'A required settlement metadata write was suppressed or changed', 409);
  return true;
}

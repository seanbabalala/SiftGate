import type { EntityManager } from 'typeorm';
import type { CostAttemptRow, CostReservationRow } from './cost-ledger.types';
import type { CostAdjustmentApplication, CostAdjustmentRow } from './cost-adjustment.types';
import { decodeCostAdjustmentHistory } from './cost-adjustment-history';
import { PricingRepositoryError } from './pricing-repository.types';

type RowKind = 'attempt' | 'reservation' | 'application' | 'adjustment';
const conflict = (): never => { throw new PricingRepositoryError('pricing_version_conflict', 'Invalid request log snapshot', 409); };

/** Read inside the existing request-fenced transaction. Four indexed row sets,
 * not a multiplying many-to-many join, one JSON aggregate, or a cached graph.
 * Money remains its original text; only existing integer revisions are numeric. */
export async function readRequestLogSnapshot(manager: EntityManager, requestId: string, workspace: string) {
  if (manager.connection.options.type !== 'postgres' || !manager.queryRunner?.isTransactionActive || !requestId || !workspace)
    return conflict();
  const parameters = { request: requestId, workspace };
  const ids = manager.createQueryBuilder().select('owned.id').from('pricing_attempts', 'owned')
    .where('owned.request_id = :request AND owned.workspace_id = :workspace').getQuery();
  const parts: Array<[RowKind, string, string, string, string, string, string]> = [
    ['attempt', 'pricing_attempts', 'a', 'a.request_id = :request AND a.workspace_id = :workspace', 'a.dispatched_at', 'a.id', '0'],
    ['reservation', 'pricing_reservations', 'r', 'r.request_id = :request AND r.workspace_id = :workspace', "''::text", 'r.id', '0'],
    ['application', 'pricing_adjustment_applications', 'm', 'm.request_id = :request AND m.workspace_id = :workspace', "''::text", 'm.adjustment_id', 'm.revision'],
    ['adjustment', 'pricing_cost_adjustments', 'c', `c.workspace_id = :workspace AND c.attempt_id IN (${ids})`, "''::text", 'c.id', '0'],
  ];
  const values: unknown[] = [];
  const statements = parts.map(([kind, table, alias, predicate, time, id, revision]) => {
    const query = manager.createQueryBuilder().select(`'${kind}'::text`, 'kind')
      .addSelect(`to_jsonb(${alias})`, 'payload').addSelect(time, 'sort_time')
      .addSelect(id, 'sort_id').addSelect(revision, 'sort_revision').from(table, alias)
      .where(predicate, parameters);
    const [sql, bound] = query.getQueryAndParameters();
    const offset = values.length;
    values.push(...bound);
    // All values remain bound; the generated SQL contains only fixed identifiers
    // and expressions above. Renumber placeholders when concatenating builders.
    return `(${sql.replace(/\$(\d+)/g, (_, n: string) => `$${Number(n) + offset}`)})`;
  });
  const raw: Array<{ kind: RowKind; payload: Record<string, unknown> }> = await manager.query(
    statements.join(' UNION ALL ') + ' ORDER BY kind, sort_time, sort_revision, sort_id', values,
  );
  const attempts: CostAttemptRow[] = [], reservations: CostReservationRow[] = [];
  const applications: CostAdjustmentApplication[] = [], adjustments: CostAdjustmentRow[] = [];
  for (const item of raw) {
    if (!item.payload || typeof item.payload !== 'object' || Array.isArray(item.payload) || item.payload.workspace_id !== workspace)
      return conflict();
    if (item.kind !== 'adjustment' && item.payload.request_id !== requestId) return conflict();
    switch (item.kind) {
      case 'attempt': attempts.push(item.payload as unknown as CostAttemptRow); break;
      case 'reservation': reservations.push(item.payload as unknown as CostReservationRow); break;
      case 'application': applications.push(item.payload as unknown as CostAdjustmentApplication); break;
      case 'adjustment': adjustments.push(item.payload as unknown as CostAdjustmentRow); break;
      default: return conflict();
    }
  }
  const ownedIds = new Set(attempts.map(attempt => attempt.id));
  if (adjustments.some(row => !ownedIds.has(row.attempt_id))) return conflict();
  return { attempts, reservations, history: decodeCostAdjustmentHistory(attempts, applications, adjustments) };
}

import type { EntityManager } from 'typeorm';
import type { CostLedgerSummary } from './cost-ledger.types';
import { RECOVERY_VIEWS, type RecoveryInventoryItem, type RecoveryInventoryPage, type RecoveryView } from './pricing-recovery-inventory.types';
export { RECOVERY_VIEWS } from './pricing-recovery-inventory.types';
export type { RecoveryView } from './pricing-recovery-inventory.types';
import { PricingRepositoryError } from './pricing-repository.types';
import { parsePricingInstant } from './pricing-time';

function invalid(): never { throw new PricingRepositoryError('pricing_invalid_document', 'Invalid recovery inventory query or cursor', 400); }

/** Keyset pagination consumes only inspected candidates; filtered empty pages still carry a cursor. */
export async function recoveryInventory(
  manager: EntityManager,
  workspace: string,
  options: { view: RecoveryView; limit: number; cursor?: string },
  summary: (requestId: string) => Promise<CostLedgerSummary | null>,
): Promise<RecoveryInventoryPage> {
  if (!RECOVERY_VIEWS.includes(options.view) || !Number.isInteger(options.limit) || options.limit < 1 || options.limit > 50) invalid();
  let after: { t: string; i: string } | undefined;
  if (options.cursor) {
    try {
      if (options.cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(options.cursor)) invalid();
      const value = JSON.parse(Buffer.from(options.cursor, 'base64url').toString('utf8'));
      if (!value || value.v !== 1 || value.w !== workspace || value.k !== options.view || typeof value.t !== 'string' || typeof value.i !== 'string' || !value.i || value.i.length > 256) invalid();
      parsePricingInstant(value.t); after = value;
    } catch { invalid(); }
  }
  const query = manager.createQueryBuilder().select([ ...['reservation_id','workspace_id','request_id','state','reason','revision','evidence_hash','created_at','updated_at','checked_at','resolved_at','resolution_code'].map((name) => `c.${name} AS ${name}`), 'r.state AS budget_state', 'r.reserved_cost_usd AS budget_reserved_usd', 'r.committed_cost_usd AS budget_committed_usd'])
    .from('pricing_recovery_cases', 'c')
    .innerJoin('pricing_reservations', 'r', 'r.id = c.reservation_id AND r.workspace_id = c.workspace_id')
    .where('c.workspace_id = :workspace', { workspace });
  if (options.view === 'open') query.andWhere('r.state = :state', { state: 'reserved' });
  if (options.view === 'resolved') query.andWhere('r.state <> :state', { state: 'reserved' });
  if (after) query.andWhere('(c.created_at > :time OR (c.created_at = :time AND c.reservation_id > :id))', { time: after.t, id: after.i });
  const scanLimit = options.view === 'unresolved_cost' ? 200 : options.limit;
  const rows = await query.orderBy('c.created_at', 'ASC').addOrderBy('c.reservation_id', 'ASC').limit(scanLimit + 1)
    .getRawMany<RecoveryInventoryItem & { evidence_json?: string }>();
  const summaries = new Map<string, CostLedgerSummary | null | 'invalid'>();
  const items: RecoveryInventoryItem[] = [];
  let scanned = 0;
  for (const row of rows.slice(0, scanLimit)) {
    if (!summaries.has(row.request_id)) {
      try { summaries.set(row.request_id, await summary(row.request_id)); }
      catch (error) {
        if (error instanceof SyntaxError || (error instanceof PricingRepositoryError && [400, 404, 409].includes(error.status))) summaries.set(row.request_id, 'invalid');
        else throw error;
      }
    }
    const current = summaries.get(row.request_id)!;
    const { evidence_json: _private, ...metadata } = row;
    const supplierState = current === 'invalid' || !current ? 'evidence_invalid' : current.amount === null ? 'unknown' : 'known';
    scanned++;
    if (options.view !== 'unresolved_cost' || supplierState !== 'known') items.push({ ...metadata, supplier_state: supplierState,
      request_cost_status: current && current !== 'invalid' ? current.status : null,
      request_amount_usd: current && current !== 'invalid' ? current.amount : null,
      known_request_subtotal_usd: current && current !== 'invalid' ? current.known_subtotal : null,
    });
    if (items.length === options.limit) break;
  }
  const last = rows[scanned - 1];
  return { items, view: options.view, limit: options.limit, scanned,
    next_cursor: last && rows.length > scanned ? Buffer.from(JSON.stringify({ v: 1, w: workspace, k: options.view, t: last.created_at, i: last.reservation_id })).toString('base64url') : null,
    coverage: 'recorded_recovery_cases',
  };
}

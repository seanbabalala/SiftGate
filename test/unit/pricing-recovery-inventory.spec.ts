import type { EntityManager } from 'typeorm';
import { recoveryInventory } from '../../src/pricing/pricing-recovery-inventory';
import type { CostLedgerSummary } from '../../src/pricing/cost-ledger.types';

function queryFixture(rows: Array<Record<string, unknown>>) {
  const query = {
    select: jest.fn().mockReturnThis(), from: jest.fn().mockReturnThis(),
    innerJoin: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(), orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(), limit: jest.fn().mockReturnThis(),
    getRawMany: jest.fn().mockResolvedValue(rows),
  };
  return { query, manager: { createQueryBuilder: () => query } as unknown as EntityManager };
}
const row = (index: number) => ({
  reservation_id: `hold-${String(index).padStart(3, '0')}`,
  request_id: `request-${index}`, workspace_id: 'workspace',
  created_at: '2026-09-25T00:00:00.000Z',
  budget_state: 'released', budget_committed_usd: '0', budget_reserved_usd: '0.5',
});
const known = { amount: '0.001', known_subtotal: '0.001', status: 'priced' } as CostLedgerSummary;

describe('bounded recovery inventory projection', () => {
  it('returns a continuation for an empty 200-candidate scan and does not skip the next unknown cost', async () => {
    const rows = Array.from({ length: 201 }, (_, index) => row(index));
    const { query, manager } = queryFixture(rows);
    const summary = jest.fn(async (id: string) => id === 'request-200' ? null : known);
    const first = await recoveryInventory(manager, 'workspace', { view: 'unresolved_cost', limit: 20 }, summary);
    expect(first.items).toEqual([]);
    expect(first.scanned).toBe(200);
    expect(summary).toHaveBeenCalledTimes(200);
    expect(query.limit).toHaveBeenCalledWith(201);
    expect(JSON.parse(Buffer.from(first.next_cursor!, 'base64url').toString('utf8'))).toMatchObject({ w: 'workspace', k: 'unresolved_cost', i: 'hold-199' });
    query.getRawMany.mockResolvedValueOnce(rows.slice(200));
    const second = await recoveryInventory(manager, 'workspace', { view: 'unresolved_cost', limit: 20, cursor: first.next_cursor! }, summary);
    expect(query.andWhere).toHaveBeenCalledWith(expect.stringContaining('c.reservation_id > :id'), { time: rows[199].created_at, id: 'hold-199' });
    expect(second).toMatchObject({ scanned: 1, next_cursor: null });
    expect(second.items[0]).toMatchObject({ reservation_id: 'hold-200', supplier_state: 'evidence_invalid', request_amount_usd: null });
  });

  it('projects duplicate request summaries without double aggregation or repeated summary reads', async () => {
    const { query, manager } = queryFixture([row(0), { ...row(1), request_id: 'request-0' }]);
    const summary = jest.fn(async () => known);
    const page = await recoveryInventory(manager, 'workspace', { view: 'resolved', limit: 2 }, summary);
    expect(summary).toHaveBeenCalledTimes(1);
    expect(page.items.map((item) => item.request_amount_usd)).toEqual(['0.001', '0.001']);
    expect(page.coverage).toBe('recorded_recovery_cases');
    expect(query.where).toHaveBeenCalledWith('c.workspace_id = :workspace', { workspace: 'workspace' });
    expect(query.innerJoin).toHaveBeenCalledWith('pricing_reservations', 'r', expect.stringContaining('r.workspace_id = c.workspace_id'));
    expect(query.select.mock.calls[0][0].every((column: string) => !column.includes('*') && !column.includes('evidence_json'))).toBe(true);
  });

  it('propagates unavailable storage instead of reporting corrupted or free evidence', async () => {
    const { manager } = queryFixture([row(0)]);
    const failure = new Error('synthetic database unavailable');
    await expect(recoveryInventory(manager, 'workspace', { view: 'all', limit: 20 }, async () => { throw failure; })).rejects.toBe(failure);
  });
});

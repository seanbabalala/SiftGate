import type { Repository } from 'typeorm';
import type { BudgetRule } from '../database/entities/budget-rule.entity';
import type { ExactDecimal } from '../pricing/exact-decimal';
import { DEFAULT_WORKSPACE_ID } from '../workspaces/workspace.constants';

export interface BudgetCounterUpdate {
  rule: BudgetRule;
  value: ExactDecimal;
}

/** Persist already-locked counters and their exact projections in one bounded
 * PostgreSQL statement. This never discovers scopes, caches a balance, changes
 * epochs, releases a lock, or opens/commits a transaction on its caller's behalf.
 */
export async function persistPostgresBudgetCounters(
  repo: Repository<BudgetRule>, workspace: string, updates: BudgetCounterUpdate[],
): Promise<void> {
  if (repo.manager.connection.options.type !== 'postgres' || !repo.manager.queryRunner?.isTransactionActive)
    throw new Error('Batched counters require the owning PostgreSQL transaction');
  if (new Set(updates.map(update => update.rule.id)).size !== updates.length)
    throw new Error('Duplicate batched budget counter identity');
  const values = updates.map(({ rule, value }) => {
    if (rule.workspace_id !== workspace && !(workspace === DEFAULT_WORKSPACE_ID && rule.workspace_id === null))
      throw new Error('Batched budget counter is outside the workspace');
    const amount = value.toFixed(18), projection = Math.fround(Number(amount));
    if (!Number.isFinite(Number(amount)) || !Number.isFinite(projection))
      throw new Error('Legacy budget projection overflow');
    return { rule, amount, projection, period: new Date(rule.period_start).toISOString() };
  }).sort((a, b) => a.rule.id - b.rule.id);
  const escape = (name: string) => repo.manager.connection.driver.escape(name);
  const table = [repo.metadata.schema, repo.metadata.tableName].filter((name): name is string => !!name).map(escape).join('.');
  for (let offset = 0; offset < values.length; offset += 128) {
    const chunk = values.slice(offset, offset + 128);
    const parameters: Array<string | number | boolean> = [workspace, workspace === DEFAULT_WORKSPACE_ID];
    const bind = (value: string | number, type: 'integer' | 'text') => `$${parameters.push(value)}::${type}`;
    const inputs = chunk.map(row => `(${bind(row.rule.id, 'integer')}, ${bind(row.period, 'text')}, ${bind(row.amount, 'text')}, ${bind(String(row.projection), 'text')})`).join(', ');
    // Depend on RETURNING, not rereads of modified tables within the same SQL
    // snapshot. A cross-workspace conflicting exact epoch is never overwritten.
    const rows: Array<{ counters: string; balances: string }> = await repo.manager.query(
      `WITH budget_counter_input (id, period, amount, projection) AS (VALUES ${inputs}),
      budget_counter_writes AS (
        UPDATE ${table} AS r SET current_value = input.projection::real
        FROM budget_counter_input AS input
        WHERE r.id = input.id AND (r.workspace_id = $1::text OR ($2::boolean AND r.workspace_id IS NULL))
        RETURNING r.id
      ), budget_balance_writes AS (
        INSERT INTO "pricing_budget_balances" (rule_id, period_start, workspace_id, amount_decimal, legacy_projection)
        SELECT input.id, input.period, $1::text, input.amount, input.projection
        FROM budget_counter_input AS input JOIN budget_counter_writes AS changed ON changed.id = input.id
        ON CONFLICT (rule_id, period_start) DO UPDATE
          SET amount_decimal = EXCLUDED.amount_decimal, legacy_projection = EXCLUDED.legacy_projection
          WHERE "pricing_budget_balances".workspace_id = EXCLUDED.workspace_id
        RETURNING rule_id
      ) SELECT (SELECT count(*) FROM budget_counter_writes) AS counters,
               (SELECT count(*) FROM budget_balance_writes) AS balances`, parameters,
    );
    if (rows.length !== 1 || String(rows[0].counters) !== String(chunk.length) || String(rows[0].balances) !== String(chunk.length))
      throw new Error('Budget counter or exact balance changed, was suppressed, or is outside the workspace');
  }
  // Publish transaction-local projections only after every bounded write passed.
  for (const { rule, amount, projection } of values) {
    rule.current_value = projection;
    rule.current_value_exact = amount;
  }
}

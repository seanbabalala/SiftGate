import { DataSource, type EntityManager } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { BudgetRule } from '../../src/database/entities/budget-rule.entity';
import { ExactDecimal } from '../../src/pricing/exact-decimal';
import { persistPostgresBudgetCounters } from '../../src/budget/budget-counter-batch';
import { applyPricingSchema } from '../../src/pricing/pricing-schema';
import { DEFAULT_WORKSPACE_ID } from '../../src/workspaces/workspace.constants';

const url = process.env.SIFTGATE_PRICING_TEST_POSTGRES_URL;
if (url && (new URL(url).hostname !== '127.0.0.1' || new URL(url).port === '2099' || !/^\/pricing_goal_[a-z0-9_]+$/.test(new URL(url).pathname)))
  throw new Error('Use only an isolated loopback pricing_goal counter database');
const suite = url ? describe : describe.skip;
suite('PostgreSQL bounded counter-and-exact writes', () => {
  let admin: DataSource, source: DataSource, schema: string, rules: BudgetRule[];
  const workspace = DEFAULT_WORKSPACE_ID;
  beforeEach(async () => {
    schema = `budget_batch_${randomUUID().replaceAll('-', '')}`;
    admin = await new DataSource({ type: 'postgres', url }).initialize();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    source = await new DataSource({ type: 'postgres', url, schema, extra: { options: `-c search_path=${schema}`, max: 4 },
      synchronize: true, entities: [BudgetRule] }).initialize();
    await applyPricingSchema(source);
    const repo = source.getRepository(BudgetRule);
    rules = await repo.save(['daily_tokens', 'daily_cost'].map(type => repo.create({
      workspace_id: workspace, type, limit_value: 100, current_value: 0, alert_threshold: .8,
      period_start: new Date('2026-01-01T00:00:00.000Z'), is_active: true,
      api_key_name: null, api_key_id: null, namespace_id: null, team_id: null,
    })));
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    if (source?.isInitialized) await source.destroy();
    if (admin?.isInitialized) { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.destroy(); }
  });
  const dump = async () => ({ rules: await source.query('SELECT * FROM budget_rules ORDER BY id'),
    balances: await source.query('SELECT * FROM pricing_budget_balances ORDER BY rule_id, period_start') });
  const changes = (rows = rules) => rows.map(rule => ({ rule, value: ExactDecimal.parse('1.000000000000000007') }));
  const lock = (manager: EntityManager) => manager.getRepository(BudgetRule).createQueryBuilder('b')
    .orderBy('b.id', 'ASC').setLock('pessimistic_write').getMany();
  const write = () => source.transaction(async manager => {
    const rows = await lock(manager);
    await persistPostgresBudgetCounters(manager.getRepository(BudgetRule), workspace, changes(rows));
  });

  it('writes a mixed existing/new exact epoch once while preserving precision and only counter fields', async () => {
    await source.query('INSERT INTO pricing_budget_balances VALUES ($1,$2,$3,$4,$5)',
      [rules[0].id, rules[0].period_start.toISOString(), workspace, '0', '0']);
    const before = await dump(), spy = jest.spyOn(source.logger, 'logQuery');
    await write();
    const writes = spy.mock.calls.filter(([sql]) => sql.startsWith('WITH budget_counter_input'));
    expect(writes).toHaveLength(1); expect(writes[0][1]).toHaveLength(10);
    const after = await dump();
    expect(after.balances.map((r: { amount_decimal: string }) => r.amount_decimal)).toEqual(Array(2).fill('1.000000000000000007'));
    expect(after.rules).toEqual(before.rules.map((r: Record<string, unknown>) => ({ ...r, current_value: 1 })));
  });

  it.each(['counter', 'new-balance', 'existing-balance'] as const)('rejects and rolls back a suppressed %s write', async target => {
    if (target === 'existing-balance') await write();
    const before = await dump(), table = target === 'counter' ? 'budget_rules' : 'pricing_budget_balances';
    const field = target === 'counter' ? 'id' : 'rule_id';
    await source.query(`CREATE FUNCTION suppress_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.${field} = ${rules[1].id} THEN RETURN NULL; END IF; RETURN NEW; END $$`);
    await source.query(`CREATE TRIGGER suppress_write BEFORE ${target === 'new-balance' ? 'INSERT' : 'UPDATE'} ON ${table} FOR EACH ROW EXECUTE FUNCTION suppress_write()`);
    await expect(write()).rejects.toThrow('Budget counter or exact balance changed');
    expect(await dump()).toEqual(before);
  });

  it('never takes over a conflicting foreign-workspace exact epoch', async () => {
    await source.query('INSERT INTO pricing_budget_balances VALUES ($1,$2,$3,$4,$5)',
      [rules[1].id, rules[1].period_start.toISOString(), 'foreign', '9', '9']);
    const before = await dump();
    await expect(write()).rejects.toThrow('outside the workspace');
    expect(await dump()).toEqual(before);
  });

  it('rejects a disappeared counter and rolls back another valid counter in the same batch', async () => {
    await source.getRepository(BudgetRule).delete(rules[1].id);
    const before = await dump();
    await expect(source.transaction(async manager => {
      await lock(manager);
      await persistPostgresBudgetCounters(manager.getRepository(BudgetRule), workspace, changes());
    })).rejects.toThrow('Budget counter or exact balance changed');
    expect(await dump()).toEqual(before);
  });

  it('supports legacy NULL default-workspace counters without rewriting their ownership', async () => {
    await source.getRepository(BudgetRule).update(rules[0].id, { workspace_id: null });
    await write(); const after = await dump();
    expect(after.rules[0].workspace_id).toBeNull();
    expect(after.balances.every((r: { workspace_id: string }) => r.workspace_id === workspace)).toBe(true);
  });

  it('bounds 129 counters into two statements and rolls back the first if the last chunk fails', async () => {
    const repo = source.getRepository(BudgetRule);
    const many = await repo.save(Array.from({ length: 127 }, () => repo.create({ ...rules[0], id: undefined })));
    const last = many.at(-1)!.id, before = await dump();
    await source.query(`CREATE FUNCTION reject_last() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.rule_id = ${last} THEN RAISE EXCEPTION 'Synthetic last chunk failure'; END IF; RETURN NEW; END $$`);
    await source.query('CREATE TRIGGER reject_last BEFORE INSERT ON pricing_budget_balances FOR EACH ROW EXECUTE FUNCTION reject_last()');
    const spy = jest.spyOn(source.logger, 'logQuery');
    await expect(write()).rejects.toThrow('Synthetic last chunk failure');
    const statements = spy.mock.calls.filter(([sql]) => sql.startsWith('WITH budget_counter_input'));
    expect(statements).toHaveLength(2); expect(statements[0][1]).toHaveLength(514); expect(statements[1][1]).toHaveLength(6);
    expect(await dump()).toEqual(before);
    await source.query('DROP TRIGGER reject_last ON pricing_budget_balances');
    await write(); expect((await dump()).balances).toHaveLength(129);
  });

  it('rejects transactionless, duplicate, foreign-workspace and overflowing input before writing', async () => {
    const before = await dump();
    await expect(persistPostgresBudgetCounters(source.getRepository(BudgetRule), workspace, changes())).rejects.toThrow('owning PostgreSQL transaction');
    for (const invalid of [changes([rules[0], rules[0]]), changes([{ ...rules[0], workspace_id: 'foreign' }]),
      [{ rule: rules[0], value: ExactDecimal.parse('1' + '0'.repeat(20)).multiply(ExactDecimal.parse('1' + '0'.repeat(20))) }]]) {
      await expect(source.transaction(manager => persistPostgresBudgetCounters(manager.getRepository(BudgetRule), workspace, invalid))).rejects.toThrow();
    }
    expect(await dump()).toEqual(before);
  });
});

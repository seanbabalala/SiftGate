import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { CallLog } from '../../src/database/entities/call-log.entity';
import { RouteDecisionLog } from '../../src/database/entities/route-decision-log.entity';
import { BudgetRule } from '../../src/database/entities/budget-rule.entity';
import { canInsertSettlementLogPair, insertSettlementLogPair } from '../../src/pricing/settlement-log-pair';
import { DEFAULT_WORKSPACE_ID } from '../../src/workspaces/workspace.constants';

const url = process.env.SIFTGATE_PRICING_TEST_POSTGRES_URL;
if (url && (new URL(url).hostname !== '127.0.0.1' || new URL(url).port === '2099' || !/^\/pricing_goal_[a-z0-9_]+$/.test(new URL(url).pathname)))
  throw new Error('Use only an isolated loopback pricing_goal log-pair database');
const suite = url ? describe : describe.skip;
suite('bound PostgreSQL settlement log pair', () => {
  let source: DataSource, admin: DataSource, schema: string;
  const workspace = DEFAULT_WORKSPACE_ID;
  beforeEach(async () => {
    schema = `log_pair_${randomUUID().replaceAll('-', '')}`;
    admin = await new DataSource({ type: 'postgres', url }).initialize();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    source = await new DataSource({ type: 'postgres', url, schema, extra: { options: `-c search_path=${schema}`, max: 4 },
      synchronize: true, entities: [CallLog, RouteDecisionLog, BudgetRule] }).initialize();
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    if (source?.isInitialized) await source.destroy();
    if (admin?.isInitialized) { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.destroy(); }
  });
  function logs(request: string) {
    const common = { request_id: request, workspace_id: workspace, source_format: 'chat_completions', tier: 'standard',
      score: .234567891, timestamp: new Date('2026-01-01T01:02:03.456Z') };
    return { call: source.getRepository(CallLog).create({ ...common, node_id: 'synthetic-node', model: 'synthetic-model',
      cost_usd: .123456789, input_tokens: 1000, output_tokens: 100 }),
      route: source.getRepository(RouteDecisionLog).create({ ...common, selected_node_id: 'synthetic-node',
        selected_model: 'synthetic-model', trace_json: '{"synthetic":true}' }) };
  }
  const count = async () => [await source.getRepository(CallLog).count(), await source.getRepository(RouteDecisionLog).count()];
  const comparable = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).filter(([key]) => !['id', 'request_id'].includes(key)));

  it('matches ORM insert values, defaults and returned entity types with one bound statement', async () => {
    const ordinary = logs('ordinary'), paired = logs('paired');
    await source.transaction(async manager => {
      await manager.getRepository(RouteDecisionLog).save(ordinary.route);
      await manager.getRepository(CallLog).save(ordinary.call);
    });
    const spy = jest.spyOn(source.logger, 'logQuery');
    await source.transaction(manager => insertSettlementLogPair(manager, paired));
    const writes = spy.mock.calls.filter(([sql]) => sql.startsWith('WITH '));
    expect(writes).toHaveLength(1); expect(writes[0][0]).toContain('settlement_route');
    expect(writes[0][1]!.length).toBeGreaterThan(10);
    expect(paired.call.timestamp).toBeInstanceOf(Date); expect(paired.route.timestamp).toBeInstanceOf(Date);
    expect(Number.isSafeInteger(paired.call.id)).toBe(true); expect(Number.isSafeInteger(paired.route.id)).toBe(true);
    expect(comparable({ ...paired.call })).toEqual(comparable({ ...ordinary.call }));
    expect(comparable({ ...paired.route })).toEqual(comparable({ ...ordinary.route }));
    for (const table of ['call_logs', 'route_decisions']) {
      const [a, b] = await source.query(`SELECT * FROM ${table} ORDER BY id`);
      expect(comparable(a)).toEqual(comparable(b));
    }
  });

  it('preserves quotes, dollar markers, Unicode and JSON as bound data rather than SQL', async () => {
    const input = logs('quotes');
    const text = "模型'); DROP TABLE call_logs; -- \\ $1 \" $$ /* */";
    input.call.model = text; input.call.error = text; input.route.trace_json = JSON.stringify({ text });
    const spy = jest.spyOn(source.logger, 'logQuery');
    await source.transaction(manager => insertSettlementLogPair(manager, input));
    const write = spy.mock.calls.find(([sql]) => sql.startsWith('WITH '))!;
    expect(write[0]).not.toContain(text); expect(write[1]).toContain(text);
    const saved = await source.getRepository(CallLog).findOneByOrFail({ request_id: 'quotes' });
    expect(saved.model).toBe(text); expect(saved.error).toBe(text);
    expect((await source.getRepository(RouteDecisionLog).findOneByOrFail({ request_id: 'quotes' })).trace_json).toBe(input.route.trace_json);
    expect(await count()).toEqual([1, 1]);
  });

  it('supports a missing optional route and generated default timestamps', async () => {
    const input = logs('call-only'); delete (input.call as Partial<CallLog>).timestamp;
    await source.transaction(manager => insertSettlementLogPair(manager, { call: input.call }));
    expect(input.call.timestamp).toBeInstanceOf(Date); expect(input.call.cost_without_cache_usd).toBeNull();
    expect(await count()).toEqual([1, 0]);
  });

  it.each(['call_logs', 'route_decisions'])('rejects and rolls back a suppressed %s insertion', async table => {
    await source.query('CREATE FUNCTION suppress_log() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$');
    await source.query(`CREATE TRIGGER suppress_log BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION suppress_log()`);
    await expect(source.transaction(manager => insertSettlementLogPair(manager, logs('suppressed')))).rejects.toThrow('suppressed');
    expect(await count()).toEqual([0, 0]);
  });

  it('a failed optional-log savepoint does not poison surrounding budget writes', async () => {
    const repo = source.getRepository(BudgetRule);
    const budget = await repo.save(repo.create({ workspace_id: workspace, type: 'daily_cost', limit_value: 100,
      current_value: 0, alert_threshold: .8, period_start: new Date(), is_active: true }));
    const input = logs('bad-route'); input.route.trace_json = null as unknown as string;
    await source.transaction(async manager => {
      await manager.getRepository(BudgetRule).update(budget.id, { current_value: 1 });
      await expect(manager.transaction(nested => insertSettlementLogPair(nested, input))).rejects.toMatchObject({ code: '23502' });
      expect(manager.queryRunner!.isTransactionActive).toBe(true);
      await manager.getRepository(BudgetRule).update(budget.id, { current_value: 2 });
    });
    expect((await repo.findOneByOrFail({ id: budget.id })).current_value).toBe(2);
    expect(await count()).toEqual([0, 0]);
  });

  it('does not acknowledge log rows if the enclosing transaction later rolls back', async () => {
    await expect(source.transaction(async manager => {
      await manager.transaction(nested => insertSettlementLogPair(nested, logs('rolled-back')));
      throw new Error('Synthetic money failure');
    })).rejects.toThrow('Synthetic money failure');
    expect(await count()).toEqual([0, 0]);
  });

  it('rejects transactionless or cross-owner input and preserves ORM fallback for hooks and existing IDs', async () => {
    await expect(insertSettlementLogPair(source.manager, logs('no-transaction'))).rejects.toThrow('owning PostgreSQL transaction');
    const foreign = logs('foreign'); foreign.route.workspace_id = 'another-workspace';
    await expect(source.transaction(manager => insertSettlementLogPair(manager, foreign))).rejects.toThrow('ownership differs');
    const existing = logs('existing'); existing.call.id = 10;
    expect(canInsertSettlementLogPair(source.manager, existing)).toBe(false);
    const listener = { listenTo: () => CallLog, afterInsert: jest.fn() };
    source.subscribers.push(listener);
    expect(canInsertSettlementLogPair(source.manager, logs('hooked'))).toBe(false);
    await source.getRepository(CallLog).save(logs('hooked').call);
    expect(listener.afterInsert).toHaveBeenCalledTimes(1);
    expect(await count()).toEqual([1, 0]);
  });
});

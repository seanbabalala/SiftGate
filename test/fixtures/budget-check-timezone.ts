import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { DataSource, type Repository } from 'typeorm';
import { BudgetService } from '../../src/budget/budget.service';
import { BudgetRule } from '../../src/database/entities/budget-rule.entity';
import { WorkspaceContextService } from '../../src/workspaces/workspace-context.service';
import { DEFAULT_WORKSPACE_ID } from '../../src/workspaces/workspace.constants';
import { applyPricingSchema } from '../../src/pricing/pricing-schema';
import type { ConfigService } from '../../src/config/config.service';

const url = new URL(process.env.SIFTGATE_PRICING_TEST_POSTGRES_URL!);
assert.equal(url.hostname, '127.0.0.1'); assert.notEqual(url.port, '2099'); assert.match(url.pathname, /^\/pricing_goal_[a-z0-9_]+$/);
assert(['UTC', 'America/New_York', 'Asia/Shanghai'].includes(process.env.TZ!));
(async () => {
  const schema = 'budget_zone_' + randomUUID().replaceAll('-', '');
  const admin = await new DataSource({ type: 'postgres', url: url.toString() }).initialize();
  let source: DataSource | undefined;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    source = await new DataSource({ type: 'postgres', url: url.toString(), schema, extra: { options: `-c search_path=${schema}`, max: 4 }, synchronize: true, entities: [BudgetRule] }).initialize();
    await applyPricingSchema(source);
    const repo = source.getRepository(BudgetRule), workspace = DEFAULT_WORKSPACE_ID;
    await repo.save(repo.create({ workspace_id: workspace, type: 'daily_cost', limit_value: 100, current_value: 1, alert_threshold: .8, is_active: true, api_key_name: null, api_key_id: null, namespace_id: null, team_id: null }));
    // Future DST-fold wall time and sub-millisecond storage: compare against the
    // installed driver's actual hydration, never an invented SQL timezone map.
    await source.query("UPDATE budget_rules SET period_start='2026-11-01 01:30:00.123456'");
    const expected = (await repo.find())[0]; assert(expected.period_start instanceof Date);
    await source.createQueryBuilder().insert().into('pricing_budget_balances').values({ rule_id: expected.id, workspace_id: workspace, period_start: expected.period_start.toISOString(), amount_decimal: '1.000000000000000009', legacy_projection: '1' }).execute();
    const service = new BudgetService({} as ConfigService, new WorkspaceContextService(), repo); service.enableExactLedger();
    type Hydration = { hydrateExactRules(rules: BudgetRule[], repo: Repository<BudgetRule>): Promise<void> };
    const inspected = service as unknown as Hydration, original = inspected.hydrateExactRules.bind(service); const observed: BudgetRule[][] = [];
    inspected.hydrateExactRules = async (rules, repository) => { await original(rules, repository); observed.push(rules.map(rule => Object.assign(new BudgetRule(), rule))); };
    const queries: string[] = [], log = source.logger.logQuery.bind(source.logger);
    source.logger.logQuery = (...args) => { queries.push(args[0]); log(...args); };
    await service.check();
    assert.equal(observed.length, 1); assert.equal(observed[0].length, 1);
    const actual = observed[0][0]; assert(actual instanceof BudgetRule); assert(actual.period_start instanceof Date);
    const { current_value_exact: exact, ...plain } = actual;
    const { current_value_exact: priorExact, ...reference } = expected;
    assert.equal(priorExact, undefined); // The ordinary ORM entity has no hydrated transient balance yet.
    assert.deepEqual(plain, reference); assert.equal(exact, '1.000000000000000009');
    assert.equal(queries.filter(sql => sql.startsWith('/* siftgate_transaction_read_prelude:1 */') && sql.includes('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')).length, 1);
    assert.equal((await source.query('SELECT amount_decimal FROM pricing_budget_balances'))[0].amount_decimal, exact);
    console.log(JSON.stringify({ timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, requested_timezone: process.env.TZ, period: actual.period_start.toISOString(), exact, entity_equal: true, prelude_observed: true }));
  } finally { if (source?.isInitialized) await source.destroy(); await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.destroy(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

import { DataSource, UpdateQueryBuilder } from 'typeorm';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BudgetService } from '../../src/budget/budget.service';
import { BudgetRule } from '../../src/database/entities/budget-rule.entity';
import { WorkspaceContextService } from '../../src/workspaces/workspace-context.service';
import { DEFAULT_WORKSPACE_ID } from '../../src/workspaces/workspace.constants';
import { serializeDatabaseAccess } from '../../src/database/database-serialization';
import { applyPricingSchema } from '../../src/pricing/pricing-schema';
import type { AlertService } from '../../src/alerts/alert.service';
import { mockConfigService } from '../helpers';

const identity = { workspaceId: DEFAULT_WORKSPACE_ID, apiKeyName: 'Synthetic key', apiKeyId: 'key', namespaceId: 'namespace', teamId: 'team' };
const fixed = (value: string) => { const [whole, part = ''] = value.split('.'); return `${whole}.${part.padEnd(18, '0')}`; };
type Fixture = { source: DataSource; cleanup(): Promise<void> };
function contract(name: string, connect: () => Promise<Fixture>, run = describe, postgres = false) {
  run(name, () => {
    let source: DataSource, cleanup: Fixture['cleanup'], budgets: BudgetService, rules: BudgetRule[], foreign: BudgetRule;
    const context = new WorkspaceContextService(), alerts = { emit: jest.fn() };
    beforeEach(async () => {
      ({ source, cleanup } = await connect()); await applyPricingSchema(source); alerts.emit.mockClear();
      const repo = source.getRepository(BudgetRule);
      rules = [];
      for (const scope of [{}, { namespace_id: identity.namespaceId }, { team_id: identity.teamId }, { api_key_id: identity.apiKeyId, api_key_name: identity.apiKeyName, namespace_id: identity.namespaceId }]) {
        for (const type of ['daily_tokens', 'daily_cost']) rules.push(await repo.save(repo.create({ workspace_id: identity.workspaceId, type, limit_value: 100, current_value: 0, alert_threshold: .8, period_start: new Date(), is_active: true, api_key_name: null, api_key_id: null, namespace_id: null, team_id: null, ...scope })));
      }
      foreign = await repo.save(repo.create({ ...rules[1], id: undefined, workspace_id: 'another-workspace', current_value: 17 }));
      budgets = new BudgetService(mockConfigService(), context, repo, alerts as unknown as AlertService);
    });
    afterEach(async () => { jest.restoreAllMocks(); if (source?.isInitialized) await source.destroy(); await cleanup?.(); });
    const commit = <T>(action: (manager: import('typeorm').EntityManager) => Promise<T>, service = budgets) => service.withCommittedBudgetEffects(() => serializeDatabaseAccess(source, () => source.transaction(action)));
    const reserve = (tokens = '3', cost = '0.3') => commit(manager => budgets.reserveLedger(manager, identity, tokens, cost));
    async function expectCurrent(tokens: string, cost: string) {
      const repo = source.getRepository(BudgetRule);
      for (const rule of await repo.find({ where: { workspace_id: identity.workspaceId, is_active: true } })) {
        const balance = await source.createQueryBuilder().select('b.amount_decimal', 'amount').from('pricing_budget_balances', 'b').where('b.workspace_id = :workspace AND b.rule_id = :id AND b.period_start = :period', { workspace: identity.workspaceId, id: rule.id, period: rule.period_start.toISOString() }).getRawOne<{ amount: string }>();
        expect(balance?.amount).toBe(fixed(rule.type === 'daily_tokens' ? tokens : cost));
      }
      expect((await repo.findOneByOrFail({ id: foreign.id })).current_value).toBe(17);
    }
    async function dump() {
      return { rules: await source.query('SELECT * FROM budget_rules ORDER BY id'), balances: await source.query('SELECT * FROM pricing_budget_balances ORDER BY rule_id, period_start') };
    }

    it('settles every overlapping scope exactly without rounding the stored decimal through float4', async () => {
      const holds = await reserve('3', '0.000000000000000003'); expect(holds).toHaveLength(8);
      const allocations = await commit(manager => budgets.settleLedger(manager, identity, holds, '5', '0.000000000000000005'));
      expect(allocations).toHaveLength(8); expect(new Set(allocations.map(a => a.ruleId)).size).toBe(8);
      await expectCurrent('5', '0.000000000000000005');
    });

    it('preserves ordered duplicate-hold subtraction and zero clamping before actual usage', async () => {
      const holds = await reserve();
      await commit(manager => budgets.settleLedger(manager, identity, [...holds].reverse().flatMap(hold => [hold, hold]), '5', '0.4'));
      await expectCurrent('5', '0.4');
    });

    it('releases an inactive original rule but charges its newly active replacement', async () => {
      const holds = await reserve(), old = rules[1], repo = source.getRepository(BudgetRule);
      await repo.update(old.id, { is_active: false });
      const replacement = await repo.save(repo.create({ ...old, id: undefined }));
      const allocations = await commit(manager => budgets.settleLedger(manager, identity, holds, '5', '0.4'));
      expect(allocations.some(a => a.ruleId === old.id)).toBe(false);
      expect(allocations.some(a => a.ruleId === replacement.id)).toBe(true);
      expect((await repo.findOneByOrFail({ id: old.id })).current_value).toBe(0);
      await expectCurrent('5', '0.4');
    });

    it('does not refund old epochs into counters changed by an explicit manual reset', async () => {
      const oldHolds = await reserve();
      for (const rule of rules) await context.run({ workspaceId: identity.workspaceId }, () => budgets.resetRule(rule.id));
      await reserve('2', '0.2');
      const allocations = await commit(manager => budgets.settleLedger(manager, identity, oldHolds, '5', '0.4'));
      expect(allocations.every(a => a.periodStart !== oldHolds.find(h => h.ruleId === a.ruleId)!.periodStart)).toBe(true);
      await expectCurrent('7', '0.6');
      for (const hold of oldHolds) {
        const balance = await source.createQueryBuilder().select('b.amount_decimal', 'amount').from('pricing_budget_balances', 'b').where('b.rule_id = :id AND b.period_start = :period AND b.workspace_id = :workspace', { id: hold.ruleId, period: hold.periodStart, workspace: identity.workspaceId }).getRawOne<{ amount: string }>();
        expect(balance?.amount).toBe(hold.amount);
      }
    });

    it('rolls back all projections and exact balances if a later balance write fails', async () => {
      if (postgres) {
        const holds = await reserve(), before = await dump();
        await source.query(`CREATE FUNCTION reject_exact_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.rule_id = ${rules[3].id} THEN RAISE EXCEPTION 'Synthetic exact balance failure'; END IF; RETURN NEW; END $$`);
        await source.query('CREATE TRIGGER reject_exact_write BEFORE UPDATE ON pricing_budget_balances FOR EACH ROW EXECUTE FUNCTION reject_exact_write()');
        await expect(commit(manager => budgets.settleLedger(manager, identity, holds, '5', '0.4'))).rejects.toThrow('Synthetic exact balance failure');
        expect(await dump()).toEqual(before); expect(alerts.emit).not.toHaveBeenCalled();
        await source.query('DROP TRIGGER reject_exact_write ON pricing_budget_balances');
        await commit(manager => budgets.settleLedger(manager, identity, holds, '5', '0.4')); await expectCurrent('5', '0.4');
        return;
      }
      const holds = await reserve(), before = await dump(), original = UpdateQueryBuilder.prototype.execute;
      let writes = 0;
      const fault = jest.spyOn(UpdateQueryBuilder.prototype, 'execute').mockImplementation(function (this: UpdateQueryBuilder<Record<string, unknown>>) {
        if (this.getQuery().startsWith('UPDATE "pricing_budget_balances"') && ++writes === 2) throw new Error('Synthetic exact balance failure');
        return original.call(this);
      });
      await expect(commit(manager => budgets.settleLedger(manager, identity, holds, '5', '0.4'))).rejects.toThrow('Synthetic exact balance failure');
      fault.mockRestore(); expect(writes).toBe(2); expect(await dump()).toEqual(before); expect(alerts.emit).not.toHaveBeenCalled();
      await commit(manager => budgets.settleLedger(manager, identity, holds, '5', '0.4')); await expectCurrent('5', '0.4');
    });

    it('rejects a foreign-workspace hold without persisting any partial settlement', async () => {
      const holds = await reserve(), before = await dump(); holds.at(-1)!.workspaceId = 'another-workspace';
      await expect(commit(manager => budgets.settleLedger(manager, identity, holds, '5', '0.4'))).rejects.toThrow('Budget hold workspace mismatch');
      expect(await dump()).toEqual(before);
    });

    it('reconciles an externally changed legacy projection instead of reusing stale exact state', async () => {
      const holds = await reserve();
      for (const rule of rules.filter(r => r.type === 'daily_cost')) await source.getRepository(BudgetRule).update(rule.id, { current_value: .7 });
      const cold = new BudgetService(mockConfigService(), new WorkspaceContextService(), source.getRepository(BudgetRule));
      await commit(manager => cold.settleLedger(manager, identity, holds, '5', '0.4'), cold);
      await expectCurrent('5', '0.8');
    });

    it('serializes overlapping concurrent reservations and settlements without losing exact increments', async () => {
      const services = Array.from({ length: 6 }, () => new BudgetService(mockConfigService(), new WorkspaceContextService(), source.getRepository(BudgetRule)));
      await Promise.all(services.map(service => commit(async manager => {
        const holds = await service.reserveLedger(manager, identity, '3', '0.3');
        return service.settleLedger(manager, identity, holds, '5', '0.4');
      }, service)));
      await expectCurrent('30', '2.4');
    });

    if (postgres) it('uses one globally ordered lock query and one bounded counter-and-exact write', async () => {
      const holds = await reserve(), log = jest.spyOn(source.logger, 'logQuery');
      await commit(manager => budgets.settleLedger(manager, identity, holds, '5', '0.4'));
      const schema = source.getMetadata(BudgetRule).schema;
      const sql = log.mock.calls.map(call => schema ? call[0].replaceAll(`"${schema}".`, '') : call[0]);
      const locks = sql.filter(query => query.includes('FROM "budget_rules"') && query.includes('FOR UPDATE'));
      expect(locks).toHaveLength(1); expect(locks[0]).toContain('ORDER BY "rule"."id" ASC'); expect(locks[0]).toContain('workspace_id');
      expect(sql.filter(query => query.startsWith('SELECT') && query.includes('FROM "budget_rules"'))).toHaveLength(1);
      const writes = sql.filter(query => query.startsWith('WITH budget_counter_input'));
      expect(writes).toHaveLength(1);
      expect(sql.filter(query => query.startsWith('UPDATE "budget_rules"'))).toHaveLength(0);
      expect(writes[0]).toContain('workspace_id'); expect(writes[0]).toContain('ON CONFLICT (rule_id, period_start)');
      expect(writes[0]).not.toMatch(/SET current_value[^\n]*(?:limit_value|is_active|api_key_id|period_start)/);
      await expectCurrent('5', '0.4');
    });

    if (postgres) it('preserves database sub-millisecond epoch precision during ordinary counter writes', async () => {
      await source.query("UPDATE budget_rules SET period_start = period_start + interval '0.000123 second' WHERE id = $1", [rules[0].id]);
      const epoch = () => source.query("SELECT to_char(period_start, 'YYYY-MM-DD HH24:MI:SS.US') AS epoch FROM budget_rules WHERE id = $1", [rules[0].id]);
      const before = await epoch(), holds = await reserve();
      await commit(manager => budgets.settleLedger(manager, identity, holds, '5', '0.4'));
      expect(await epoch()).toEqual(before);
      await expectCurrent('5', '0.4');
    });
  });
}
contract('SQLite reference budget settlement', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'budget-settlement-'));
  const source = await new DataSource({ type: 'better-sqlite3', database: join(directory, 'test.sqlite'), synchronize: true, entities: [BudgetRule] }).initialize();
  return { source, cleanup: async () => rmSync(directory, { recursive: true, force: true }) };
});
const url = process.env.SIFTGATE_PRICING_TEST_POSTGRES_URL;
if (url && (new URL(url).hostname !== '127.0.0.1' || !/^\/pricing_goal_[a-z0-9_]+$/.test(new URL(url).pathname))) throw new Error('Use an isolated loopback pricing_goal database');
contract('PostgreSQL folded locked budget settlement', async () => {
  const admin = await new DataSource({ type: 'postgres', url }).initialize(), schema = `budget_settlement_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const source = await new DataSource({ type: 'postgres', url, schema, extra: { options: `-c search_path=${schema}`, max: 4 }, synchronize: true, entities: [BudgetRule] }).initialize();
  return { source, cleanup: async () => { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.destroy(); } };
}, url ? describe : describe.skip, true);

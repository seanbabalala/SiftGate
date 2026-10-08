import { DataSource, SelectQueryBuilder, type EntityManager, type QueryRunner, type Repository } from 'typeorm';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { BudgetService, BudgetExceededError } from '../../src/budget/budget.service';
import { BudgetRule } from '../../src/database/entities/budget-rule.entity';
import { WorkspaceContextService } from '../../src/workspaces/workspace-context.service';
import { DEFAULT_WORKSPACE_ID } from '../../src/workspaces/workspace.constants';
import { serializeDatabaseAccess } from '../../src/database/database-serialization';
import { applyPricingSchema } from '../../src/pricing/pricing-schema';
import { mockConfigService } from '../helpers';

const identity = { workspaceId: DEFAULT_WORKSPACE_ID, apiKeyName: 'Synthetic hydration key', apiKeyId: 'hydration-key', namespaceId: 'hydration-namespace', teamId: 'hydration-team' };
const pgUrl = process.env.SIFTGATE_PRICING_TEST_POSTGRES_URL;
if (pgUrl) {
  const url = new URL(pgUrl);
  if (url.hostname !== '127.0.0.1' || url.port === '2099' || !/^\/pricing_goal_[a-z0-9_]+$/.test(url.pathname))
    throw new Error('Use an isolated loopback pricing_goal hydration database');
}
for (const dialect of ['better-sqlite3', 'postgres'] as const) {
  const suite = dialect === 'postgres' && !pgUrl ? describe.skip : describe;
  suite(`bounded exact budget hydration (${dialect})`, () => {
    let source: DataSource, admin: DataSource | undefined, directory: string | undefined, schema: string;
    let service: BudgetService, rules: BudgetRule[];
    const context = new WorkspaceContextService();
    beforeEach(async () => {
      if (dialect === 'postgres') {
        schema = `budget_hydration_${randomUUID().replaceAll('-', '')}`;
        admin = await new DataSource({ type: 'postgres', url: pgUrl }).initialize();
        await admin.query(`CREATE SCHEMA "${schema}"`);
        source = new DataSource({ type: dialect, url: pgUrl, schema, extra: { options: `-c search_path=${schema}`, max: 4 }, synchronize: true, entities: [BudgetRule] });
      } else {
        directory = mkdtempSync(join(tmpdir(), 'budget-hydration-'));
        source = new DataSource({ type: dialect, database: join(directory, 'test.sqlite'), synchronize: true, entities: [BudgetRule] });
      }
      await source.initialize(); await applyPricingSchema(source);
      const repo = source.getRepository(BudgetRule); rules = [];
      for (const scope of [{}, { namespace_id: identity.namespaceId }, { team_id: identity.teamId }, { api_key_id: identity.apiKeyId, api_key_name: identity.apiKeyName, namespace_id: identity.namespaceId }]) {
        for (const type of ['daily_tokens', 'daily_cost']) rules.push(await repo.save(repo.create({ workspace_id: identity.workspaceId, type, limit_value: 100, current_value: 0, alert_threshold: .8, period_start: new Date(), is_active: true, api_key_name: null, api_key_id: null, namespace_id: null, team_id: null, ...scope })));
      }
      service = new BudgetService(mockConfigService(), context, repo); service.enableExactLedger();
    });
    afterEach(async () => {
      jest.restoreAllMocks(); if (source?.isInitialized) await source.destroy();
      if (admin?.isInitialized) { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.destroy(); }
      if (directory) rmSync(directory, { recursive: true, force: true });
    });
    const commit = <T>(action: (manager: EntityManager) => Promise<T>) => service.withCommittedBudgetEffects(() => serializeDatabaseAccess(source, () => source.transaction(action)));
    const reserve = (tokens = '1', cost = '0.000000000000000003') => commit(manager => service.reserveLedger(manager, identity, tokens, cost));
    const exactReads = (spy: jest.SpyInstance) => spy.mock.calls.filter((call: [string, unknown[]?, QueryRunner?]) => /^SELECT/.test(call[0]) && /FROM "pricing_budget_balances"/.test(call[0]));
    async function balances() { return source.query('SELECT * FROM pricing_budget_balances ORDER BY rule_id, period_start'); }
    async function dump() { return { rules: await source.query('SELECT * FROM budget_rules ORDER BY id'), balances: await balances() }; }

    it('hydrates all unique overlapping scopes once during a reservation without a second per-rule read', async () => {
      await reserve(); const spy = jest.spyOn(source.logger, 'logQuery');
      const holds = await reserve();
      expect(holds).toHaveLength(8); expect(new Set(holds.map(h => h.ruleId)).size).toBe(8);
      expect(exactReads(spy)).toHaveLength(1);
      for (const row of await balances()) expect(row.amount_decimal).toBe(rules.find(r => r.id === Number(row.rule_id))!.type === 'daily_tokens' ? '2.000000000000000000' : '0.000000000000000006');
    });

    it('hydrates matching check scopes in one fresh read without changing any rows', async () => {
      await reserve(); const before = await dump(), spy = jest.spyOn(source.logger, 'logQuery');
      await service.check(identity.apiKeyName, identity.apiKeyId, identity.namespaceId, identity.teamId);
      expect(exactReads(spy)).toHaveLength(1); expect(await dump()).toEqual(before);
    });

    it('does not query exact balances when there are no active matching rules', async () => {
      await source.getRepository(BudgetRule).update(rules.map(r => r.id), { is_active: false });
      const spy = jest.spyOn(source.logger, 'logQuery');
      await service.check(identity.apiKeyName, identity.apiKeyId, identity.namespaceId, identity.teamId);
      expect(exactReads(spy)).toEqual([]);
    });

    it('bounds each hydration query while preserving every selected rule and exact amount', async () => {
      await source.getRepository(BudgetRule).clear();
      const repo = source.getRepository(BudgetRule), base = rules[1];
      await repo.save(Array.from({ length: 251 }, () => repo.create({ ...base, id: undefined, period_start: new Date() })));
      const many = await repo.find();
      await source.createQueryBuilder().insert().into('pricing_budget_balances', ['rule_id', 'period_start', 'workspace_id', 'amount_decimal', 'legacy_projection']).values(many.map(r => ({ rule_id: r.id, period_start: r.period_start.toISOString(), workspace_id: identity.workspaceId, amount_decimal: '0.000000000000000007', legacy_projection: '0' }))).execute();
      expect((await balances())[0]).toMatchObject({ rule_id: many[0].id, period_start: many[0].period_start.toISOString(), workspace_id: identity.workspaceId });
      const spy = jest.spyOn(source.logger, 'logQuery'), statuses = await service.getStatus();
      expect(statuses).toHaveLength(251); expect(statuses.map(r => r.currentExact)).toEqual(Array(251).fill('0.000000000000000007'));
      const reads = exactReads(spy); expect(reads).toHaveLength(2);
      for (const [sql, parameters] of reads) { expect(parameters.length).toBeLessThanOrEqual(501); expect(sql).toContain('workspace_id'); expect(sql).toContain('period_start'); }
    });

    it('does not reuse hydration across transactions even if the legacy projection stays equal', async () => {
      await reserve(); const cost = rules[1];
      await source.createQueryBuilder().update('pricing_budget_balances').set({ amount_decimal: '0.000000000000000004' }).where('rule_id = :id', { id: cost.id }).execute();
      await reserve();
      expect((await balances()).find((b: { rule_id: number }) => b.rule_id === cost.id).amount_decimal).toBe('0.000000000000000007');
    });

    it('keeps legacy fallback for absent and mismatching balance projections', async () => {
      await reserve(); const repo = source.getRepository(BudgetRule);
      await source.createQueryBuilder().delete().from('pricing_budget_balances').where('rule_id = :id', { id: rules[0].id }).execute();
      await repo.update(rules[1].id, { current_value: .5 });
      await reserve('1', '0.25');
      const rows = await balances(); expect(rows.find((b: { rule_id: number }) => b.rule_id === rules[0].id).amount_decimal).toBe('2.000000000000000000');
      expect(rows.find((b: { rule_id: number }) => b.rule_id === rules[1].id).amount_decimal).toBe('0.750000000000000000');
    });

    it('scopes balances to both the requested workspace and exact epoch', async () => {
      await reserve(); const rule = rules[1];
      await source.createQueryBuilder().update('pricing_budget_balances').set({ workspace_id: 'another-workspace', amount_decimal: '99' }).where('rule_id = :id', { id: rule.id }).execute();
      await source.createQueryBuilder().insert().into('pricing_budget_balances', ['rule_id', 'period_start', 'workspace_id', 'amount_decimal', 'legacy_projection']).values({ rule_id: rule.id, period_start: '2001-01-01T00:00:00.000Z', workspace_id: identity.workspaceId, amount_decimal: '88', legacy_projection: String((await source.getRepository(BudgetRule).findOneByOrFail({ id: rule.id })).current_value) }).execute();
      const before = await dump(), statuses = await service.getStatus();
      const value = statuses.find(s => s.id === rule.id)!;
      expect(Number(value.currentExact)).toBeLessThan(.001); expect(value.currentExact).not.toBe('99'); expect(value.currentExact).not.toBe('88'); expect(await dump()).toEqual(before);
    });

    it('rehydrates a reset epoch instead of reusing the previous period balance', async () => {
      await reserve(); const repo = source.getRepository(BudgetRule), yesterday = new Date(Date.now() - 86400000);
      for (const rule of rules) await repo.update(rule.id, { period_start: yesterday, current_value: 77 });
      await reserve('2', '0.25');
      for (const rule of await repo.find()) {
        const row = (await balances()).find((b: { rule_id: number; period_start: string }) => b.rule_id === rule.id && b.period_start === rule.period_start.toISOString());
        expect(row.amount_decimal).toBe(rule.type === 'daily_tokens' ? '2.000000000000000000' : '0.250000000000000000');
      }
    });

    it('rejects malformed exact amounts and rolls back rather than replacing them with legacy zero', async () => {
      await reserve(); await source.createQueryBuilder().update('pricing_budget_balances').set({ amount_decimal: 'not-a-decimal' }).where('rule_id = :id', { id: rules[1].id }).execute();
      const before = await dump(); await expect(reserve()).rejects.toThrow(); expect(await dump()).toEqual(before);
    });

    it('preserves legacy-null workspace rule ownership without reading foreign balances', async () => {
      await source.getRepository(BudgetRule).update(rules[1].id, { workspace_id: null });
      await reserve(); await reserve();
      const row = (await balances()).find((b: { rule_id: number }) => b.rule_id === rules[1].id);
      expect(row.workspace_id).toBe(identity.workspaceId); expect(row.amount_decimal).toBe('0.000000000000000006');
    });
    if (dialect === 'postgres') {
      it('check batches real START, isolation and one ordered rule lock while keeping exact hydration fresh', async () => {
        await reserve();
        const before = await dump(), query = jest.spyOn(source.logger, 'logQuery');
        await service.check(identity.apiKeyName, identity.apiKeyId, identity.namespaceId, identity.teamId);
        const programs = query.mock.calls.filter(([sql]) => sql.startsWith('/* siftgate_transaction_read_prelude:1 */'));
        expect(programs).toHaveLength(1);
        const statements = programs[0][0].split(';\n'); expect(statements).toHaveLength(3);
        expect(statements[0]).toContain('START TRANSACTION'); expect(statements[1]).toBe('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
        expect(statements[2]).toContain('ORDER BY "rule"."id" ASC FOR UPDATE');
        expect(exactReads(query)).toHaveLength(1);
        expect(query.mock.calls.indexOf(exactReads(query)[0])).toBeGreaterThan(query.mock.calls.indexOf(programs[0]));
        expect(await dump()).toEqual(before);
      });
      it('check preserves ORM after-load subscribers instead of bypassing their entity processing', async () => {
        await reserve(); const afterLoad = jest.fn(); source.subscribers.push({ afterLoad });
        const query = jest.spyOn(source.logger, 'logQuery');
        await service.check(identity.apiKeyName, identity.apiKeyId, identity.namespaceId, identity.teamId);
        expect(afterLoad).toHaveBeenCalledTimes(8);
        for (const call of afterLoad.mock.calls) expect(call[0]).toBeInstanceOf(BudgetRule);
        expect(query.mock.calls.some(([sql]) => sql.includes('siftgate_transaction_read_prelude'))).toBe(false);
      });
      it.each(['getMany', 'getRawAndEntities'] as const)('check preserves a customized query-builder %s method', async method => {
        await reserve(); const customized = jest.spyOn(SelectQueryBuilder.prototype, method), query = jest.spyOn(source.logger, 'logQuery');
        await service.check(identity.apiKeyName, identity.apiKeyId, identity.namespaceId, identity.teamId);
        expect(customized).toHaveBeenCalledTimes(1);
        expect(query.mock.calls.some(([sql]) => sql.includes('siftgate_transaction_read_prelude'))).toBe(false);
      });
      it.each(['exact-limit-change', 'moved-scope'] as const)('check re-evaluates %s after its actual rule-lock wait', async change => {
        await reserve();
        await source.getRepository(BudgetRule).update(rules[1].id, { current_value: 1, limit_value: 1 });
        await source.createQueryBuilder().update('pricing_budget_balances').set({ amount_decimal: '0.999999999999999999', legacy_projection: '1' }).where('rule_id=:id', { id: rules[1].id }).execute();
        const writer = source.createQueryRunner(); await writer.startTransaction();
        const writerId = (await writer.query('SELECT pg_backend_pid() AS pid'))[0].pid;
        let pending: Promise<{ error?: unknown }> | undefined;
        try {
          await writer.query('SELECT id FROM budget_rules WHERE id=$1 FOR UPDATE', [rules[1].id]);
          if (change === 'exact-limit-change') await writer.query('UPDATE pricing_budget_balances SET amount_decimal=$1 WHERE rule_id=$2', ['1.000000000000000009', rules[1].id]);
          else await writer.query('UPDATE budget_rules SET namespace_id=$1 WHERE id=$2', ['unrelated-namespace', rules[1].id]);
          let finished = false;
          pending = service.check(identity.apiKeyName, identity.apiKeyId, identity.namespaceId, identity.teamId)
            .then(() => ({}), error => ({ error })).finally(() => { finished = true; });
          let blocked = false;
          for (let n = 0; n < 100; n++) {
            blocked = (await admin!.query("SELECT pid FROM pg_stat_activity WHERE query LIKE '/* siftgate_transaction_read_prelude:1 */%' AND $1::int=ANY(pg_blocking_pids(pid))", [writerId])).length === 1;
            if (blocked) break; await new Promise(resolve => setTimeout(resolve, 10));
          }
          expect(blocked).toBe(true); expect(finished).toBe(false); await writer.commitTransaction();
          const result = await pending;
          if (change === 'exact-limit-change') {
            expect(result.error).toBeInstanceOf(BudgetExceededError);
            const rows = await balances(); expect(rows.find((r: { rule_id: number }) => r.rule_id === rules[1].id).amount_decimal).toBe('1.000000000000000009');
            await source.createQueryBuilder().update('pricing_budget_balances').set({ amount_decimal: '0.999999999999999999' }).where('rule_id=:id', { id: rules[1].id }).execute();
            await expect(service.check(identity.apiKeyName, identity.apiKeyId, identity.namespaceId, identity.teamId)).resolves.toBeUndefined();
          } else expect(result.error).toBeUndefined();
        } finally { if (writer.isTransactionActive) await writer.rollbackTransaction(); if (pending) await pending; await writer.release(); }
      });
      it.each(['UTC', 'America/New_York', 'Asia/Shanghai'])('hydrates full entities and exact DST-fold epoch keys identically to TypeORM in %s', timezone => {
        const child = spawnSync(process.execPath, ['-r', 'ts-node/register/transpile-only', join(__dirname, '../fixtures/budget-check-timezone.ts')], {
          cwd: join(__dirname, '../..'), env: { ...process.env, TZ: timezone }, encoding: 'utf8', timeout: 25000,
        });
        expect({ status: child.status, stderr: child.stderr, error: child.error?.message }).toEqual({ status: 0, stderr: '', error: undefined });
        const output = JSON.parse(child.stdout.trim().split('\n').at(-1)!);
        expect(output).toMatchObject({ timezone, requested_timezone: timezone, exact: '1.000000000000000009', entity_equal: true, prelude_observed: true });
      }, 30000);

      type ScopeReader = { loadRuleScopes(name: string | null, key: string | null, ns: string | null, team: string | null,
        context: { repo: Repository<BudgetRule>; lockActiveRules: boolean; lockedRules?: Map<number, BudgetRule> }, extra?: number[]): Promise<Array<{ rules: BudgetRule[] }>> };
      const readScopes = (manager: EntityManager) => (service as unknown as ScopeReader).loadRuleScopes(
        identity.apiKeyName, identity.apiKeyId, identity.namespaceId, identity.teamId,
        { repo: manager.getRepository(BudgetRule), lockActiveRules: true },
      );

      it('discovers every overlapping scope in one ordered locking query, then hydrates exact values separately', async () => {
        const spy = jest.spyOn(source.logger, 'logQuery');
        const scopes = await source.transaction(readScopes);
        expect(scopes.map(scope => scope.rules.length)).toEqual([2, 4, 2, 0]);
        const reads = spy.mock.calls.map(([sql]) => sql).filter(sql => sql.startsWith('SELECT') && sql.includes('budget_rules'));
        expect(reads).toHaveLength(1); expect(reads[0]).toContain('FOR UPDATE');
        expect(reads[0]).toContain('ORDER BY "rule"."id" ASC');
        expect(exactReads(spy)).toHaveLength(1);
      });

      async function afterContendedChange(change: (runner: QueryRunner) => Promise<void>) {
        const writer = source.createQueryRunner(), reader = source.createQueryRunner();
        await writer.connect(); await reader.connect();
        const writerId = Number((await writer.query('SELECT pg_backend_pid() AS pid'))[0].pid);
        const readerId = Number((await reader.query('SELECT pg_backend_pid() AS pid'))[0].pid);
        let pending: ReturnType<typeof readScopes> | undefined;
        try {
          await writer.startTransaction();
          await writer.manager.getRepository(BudgetRule).createQueryBuilder('b').where('b.id=:id', { id: rules[1].id }).setLock('pessimistic_write').getOne();
          await change(writer);
          await reader.startTransaction();
          pending = readScopes(reader.manager);
          let blocked = false;
          for (let count = 0; count < 100; count++) {
            blocked = (await admin!.query('SELECT $1::int=ANY(pg_blocking_pids($2::int)) AS blocked', [writerId, readerId]))[0].blocked;
            if (blocked) break;
            await new Promise(resolve => setTimeout(resolve, 10));
          }
          expect(blocked).toBe(true);
          await writer.commitTransaction();
          const rows = await pending;
          await reader.commitTransaction();
          return rows.flatMap(scope => scope.rules);
        } finally {
          if (writer.isTransactionActive) await writer.rollbackTransaction();
          if (pending) await pending.catch(() => undefined);
          if (reader.isTransactionActive) await reader.rollbackTransaction();
          await writer.release(); await reader.release();
        }
      }

      it('does not charge a rule that moved out of the requested scope while its lock was awaited', async () => {
        const selected = await afterContendedChange(runner => runner.manager.getRepository(BudgetRule)
          .update(rules[1].id, { namespace_id: 'not-this-request' }).then(() => undefined));
        expect(selected).toHaveLength(7);
        expect(selected.some(rule => rule.id === rules[1].id)).toBe(false);
      });

      it('reads exact balances after a lock wait even when both old and new amounts share the same float4 projection', async () => {
        await source.getRepository(BudgetRule).update(rules[1].id, { current_value: 1 });
        await source.createQueryBuilder().insert().into('pricing_budget_balances').values({
          rule_id: rules[1].id, workspace_id: identity.workspaceId, period_start: rules[1].period_start.toISOString(),
          amount_decimal: '1.000000000000000001', legacy_projection: '1',
        }).execute();
        const selected = await afterContendedChange(runner => runner.manager.createQueryBuilder().update('pricing_budget_balances')
          .set({ amount_decimal: '1.000000000000000009' }).where('rule_id=:id', { id: rules[1].id }).execute().then(() => undefined));
        expect(selected.find(rule => rule.id === rules[1].id)?.current_value_exact).toBe('1.000000000000000009');
      });
    }
  });
}

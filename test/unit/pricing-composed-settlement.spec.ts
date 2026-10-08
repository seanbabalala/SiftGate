import { DataSource, InsertQueryBuilder, UpdateQueryBuilder, type EntityManager, type QueryRunner } from 'typeorm';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { BudgetRule } from '../../src/database/entities/budget-rule.entity';
import { CallLog } from '../../src/database/entities/call-log.entity';
import { RouteDecisionLog } from '../../src/database/entities/route-decision-log.entity';
import { BudgetService } from '../../src/budget/budget.service';
import { WorkspaceContextService } from '../../src/workspaces/workspace-context.service';
import { CostLedgerService } from '../../src/pricing/cost-ledger.service';
import { PricingRepository } from '../../src/pricing/pricing-repository';
import { PricingOutcomeDispositionService } from '../../src/pricing/pricing-outcome-disposition.service';
import { applyPricingSchema } from '../../src/pricing/pricing-schema';
import { runtimeOutcomeDocument } from '../../src/pricing/pricing-outcome-document';
import { allocateBatchCost, batchShareCost } from '../../src/pricing/cost-allocation';
import type { PricingOutcome } from '../../src/pricing/pricing-outcome-retry';
import { acknowledgeSettlementReceipts, retainRuntimeOutcome, type RuntimeOutcomeRow } from '../../src/pricing/pricing-outcome-inbox';
import type { CostReservationRow, CostSettlementIntentRow, CostLedgerSummary, CostAttemptRow } from '../../src/pricing/cost-ledger.types';
import type { CostComputation } from '../../src/pricing/pricing.types';
import { tokenBook, tokens } from './pricing-fixtures';
import { mockConfigService } from '../helpers';

type Settlement = Extract<PricingOutcome, { type: 'settlement' }>;
type Internals = {
  attempt(manager: EntityManager, id: string, workspace: string, lock: boolean): Promise<CostAttemptRow | undefined>;
  receiptAttemptsUnderRequest(manager: EntityManager, row: CostReservationRow, receipts: Array<{ attemptId: string; cost: CostComputation; errorCode?: string | null }>): Promise<Map<string, Pick<CostAttemptRow, 'id' | 'state' | 'cost_hash' | 'error_code'>>>;
  deliverRuntimeOutcome(row: RuntimeOutcomeRow, apply?: boolean): Promise<void>;
  applyRuntimeSettlement(row: RuntimeOutcomeRow): Promise<void>;
  applySettlementInTransaction(manager: EntityManager, row: CostReservationRow, intent: CostSettlementIntentRow): Promise<CostReservationRow>;
  summaryInTransaction(manager: EntityManager, requestId: string, workspace: string, mode?: "detail" | "log"): Promise<CostLedgerSummary | Pick<CostLedgerSummary, "known_subtotal"> | null>;
};
const workspace = 'default-workspace';
const actor = { id: 'synthetic-admin', workspace_id: workspace, role: 'admin' as const, global_admin: true };
const target = { node_id: 'synthetic-node', model: 'synthetic-model' };
const gate = () => {
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  return { ready, release };
};
const pgUrl = process.env.SIFTGATE_PRICING_TEST_POSTGRES_URL;
if (pgUrl) {
  const url = new URL(pgUrl);
  if (url.hostname !== '127.0.0.1' || url.port === '2099' || !/^\/pricing_goal_[a-z0-9_]+$/.test(url.pathname))
    throw new Error('Use an isolated composed-settlement PostgreSQL database');
}

for (const dialect of ['better-sqlite3', 'postgres'] as const) {
  const suite = dialect === 'postgres' && !pgUrl ? describe.skip : describe;
  suite(`retained composed settlement (${dialect})`, () => {
    let source: DataSource, admin: DataSource | undefined, schema: string, directory: string | undefined;
    let ledger: CostLedgerService, prices: PricingRepository, outcome: Settlement, cost: CostComputation;
    const makeLedger = (db = source) => new CostLedgerService(db,
      new BudgetService(mockConfigService(), new WorkspaceContextService(), db.getRepository(BudgetRule)));
    beforeEach(async () => {
      if (dialect === 'postgres') {
        schema = `composed_${randomUUID().replaceAll('-', '')}`;
        admin = await new DataSource({ type: 'postgres', url: pgUrl }).initialize();
        await admin.query(`CREATE SCHEMA "${schema}"`);
        source = new DataSource({ type: 'postgres', url: pgUrl, schema, extra: { options: `-c search_path=${schema}`, max: 4 }, entities: [BudgetRule, CallLog, RouteDecisionLog], synchronize: true });
      } else {
        directory = mkdtempSync(join(tmpdir(), 'composed-settlement-'));
        source = new DataSource({ type: dialect, database: join(directory, 'gateway.sqlite'), entities: [BudgetRule, CallLog, RouteDecisionLog], synchronize: true });
      }
      await source.initialize();
      if (dialect === 'better-sqlite3') { await source.query('PRAGMA journal_mode=WAL'); await source.query('PRAGMA synchronous=FULL'); }
      await applyPricingSchema(source);
      await source.getRepository(BudgetRule).save({ workspace_id: workspace, type: 'daily_cost', current_value: 0, limit_value: 100, alert_threshold: .8, period_start: new Date(), is_active: true });
      ledger = makeLedger(); prices = new PricingRepository(source);
      const book = await prices.createBook(actor, { name: 'Synthetic composition', scope: 'workspace', content: tokenBook() });
      await prices.publishDraft(actor, book.draft.id, { draft_revision: 1, catalog_revision: 0, reason: 'Synthetic composition test', confirm: true, targets: [{ level: 'model', model: target.model }] });
      const snapshot = await prices.capture({ request_id: 'request', workspace_id: workspace, report_currency: 'USD' });
      cost = snapshot!.quote(target, tokens({ input_tokens: 1000, output_tokens: 100 })).cost;
      await ledger.reserve({ id: 'reservation', requestId: 'request', identity: { workspaceId: workspace, apiKeyId: null, apiKeyName: null, namespaceId: null, teamId: null }, target, estimate: cost, tokens: '1100', costUsd: '0.5', budgetBasis: 'legacy_logical', leaseOwner: 'synthetic-owner', leaseUntil: new Date(Date.now() + 60000).toISOString() });
      await ledger.beginAttempt({ id: 'attempt', requestId: 'request', workspace, reservationId: 'reservation', target, feeSource: 'provider', dispatchedAt: '2026-09-20T00:00:00.000Z', priceContext: { context: {}, legacyPrice: null } });
      await source.getRepository(CallLog).save({ request_id: 'request', workspace_id: workspace, source_format: 'chat_completions', tier: 'standard', score: 0, node_id: target.node_id!, model: target.model, cost_usd: 0 });
      outcome = { type: 'settlement', workspace, reservationId: 'reservation', payload: { kind: 'commit', tokens: '1100', cost_usd: cost.report_amount!, budget_basis: 'legacy_logical', receipt: { attemptId: 'attempt', cost, errorCode: null } } };
    });
    afterEach(async () => {
      jest.restoreAllMocks();
      if (source?.isInitialized) await source.destroy();
      if (admin?.isInitialized) { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.destroy(); }
      if (directory) rmSync(directory, { recursive: true, force: true });
    });
    const rows = () => source.query('SELECT * FROM pricing_runtime_outcomes ORDER BY id') as Promise<RuntimeOutcomeRow[]>;
    const financial = async () => {
      const data: Record<string, unknown> = {};
      for (const name of ['pricing_attempts', 'pricing_settlement_intents', 'pricing_reservations', 'pricing_budget_balances', 'pricing_budget_effects', 'budget_rules', 'call_logs'])
        data[name] = await source.query(`SELECT * FROM ${name}`);
      return data;
    };
    async function committed() {
      const summary = await ledger.summary('request', workspace);
      expect(summary?.budget_committed_usd).toBe('0.001200000000000000');
      expect(summary?.amount).toBe('0.001200000000000000');
      expect(await source.query("SELECT * FROM pricing_budget_effects WHERE kind = 'commit'")).toHaveLength(1);
      expect((await source.query('SELECT state FROM pricing_settlement_intents'))[0].state).toBe('applied');
      expect((await rows())[0].state).toBe('delivered');
      expect((await source.getRepository(CallLog).findOneByOrFail({ request_id: 'request' })).cost_usd).toBeCloseTo(.0012, 8);
    }
    async function recover() {
      ledger = makeLedger();
      await ledger.replayRuntimeOutcomes(new Date(Date.now() + 120000));
      await ledger.reconcilePending(100, new Date(Date.now() + 120000));
      await committed();
    }

    const attemptOutcome = (): Extract<PricingOutcome, { type: 'attempt' }> => ({
      type: 'attempt', workspace, reservationId: 'reservation', attemptId: 'attempt', cost, errorCode: null,
    });
    // Keep the red test executable against the older two-argument method.
    const jointSettlement = (value = outcome) => (ledger.persistAndApplyRuntimeSettlement.bind(ledger) as
      (input: Settlement, yieldAfterRetention: boolean, acknowledgeReceipts: boolean) => Promise<void>)(value, true, true);

    const newLogs = () => ({
      call: source.getRepository(CallLog).create({ request_id: 'request', workspace_id: workspace, source_format: 'chat_completions', tier: 'standard', score: 0, node_id: target.node_id!, model: target.model, input_tokens: 1000, output_tokens: 100, cost_usd: 999, cost_without_cache_usd: 999, status_code: 200, stream: false, is_fallback: false }),
      route: source.getRepository(RouteDecisionLog).create({ request_id: 'request', workspace_id: workspace, source_format: 'chat_completions', tier: 'standard', score: 0, route_mode: 'direct', strategy: 'primary_fallback', selected_node_id: target.node_id!, selected_model: target.model, candidate_count: 1, filtered_count: 0, status_code: 200, is_fallback: false, trace_json: '{}' }),
    });
    if (dialect === 'better-sqlite3') it('joined log foundation keeps SQLite settlement separate without leaking rollback-reusable rowids', async () => {
      await source.getRepository(CallLog).delete({ request_id: 'request' });
      const logs = newLogs();
      expect(await ledger.persistAndApplyRuntimeSettlementWithLogs(outcome, logs)).toBeNull();
      expect(logs.call.id).toBeUndefined(); expect(logs.route.id).toBeUndefined();
      expect(await source.getRepository(CallLog).count()).toBe(0);
      await ledger.persistCallLogs([logs.call], true); await committed();
    });

    if (dialect === 'postgres') {
      it('joined log foundation writes the full validated cost and route in the owning settlement transaction', async () => {
        await source.getRepository(CallLog).delete({ request_id: 'request' });
        await ledger.retainRuntimeOutcome(attemptOutcome());
        const logs = newLogs(), summaries = jest.spyOn(ledger as unknown as Internals, 'summaryInTransaction');
        const saved = await ledger.persistAndApplyRuntimeSettlementWithLogs(outcome, logs, true);
        expect(saved?.id).toBe(logs.call.id); expect(saved?.cost_usd).toBeCloseTo(.0012, 10);
        expect(saved?.cost_without_cache_usd).toBeNull(); expect(summaries).toHaveBeenCalledTimes(1);
        summaries.mockRestore(); await committed();
        expect(await source.getRepository(RouteDecisionLog).count()).toBe(1);
        const replay = newLogs();
        expect(await ledger.persistAndApplyRuntimeSettlementWithLogs(outcome, replay, true)).toBeNull();
        expect(replay.call.id).toBeUndefined(); expect(await source.getRepository(CallLog).count()).toBe(1);
      });

      it.each(['call_logs', 'route_decisions'] as const)('joined log foundation rolls back optional %s failure to a real savepoint but still commits money', async table => {
        await source.getRepository(CallLog).delete({ request_id: 'request' });
        const logs = newLogs();
        await source.query("CREATE FUNCTION joined_log_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic optional log failure'; END; $$");
        await source.query(`CREATE TRIGGER joined_log_failure BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION joined_log_failure()`);
        try {
          expect(await ledger.persistAndApplyRuntimeSettlementWithLogs(outcome, logs)).toBeNull();
          expect(await source.getRepository(CallLog).count()).toBe(0);
          expect(await source.getRepository(RouteDecisionLog).count()).toBe(0);
          expect((await ledger.summary('request', workspace))?.budget_committed_usd).toBe('0.001200000000000000');
          expect(await source.query("SELECT * FROM pricing_budget_effects WHERE kind='commit'")).toHaveLength(1);
        } finally {
          await source.query(`DROP TRIGGER joined_log_failure ON ${table}`); await source.query('DROP FUNCTION joined_log_failure()');
        }
        await source.getRepository(RouteDecisionLog).save(logs.route);
        await ledger.persistCallLogs([logs.call], true); await committed();
      });

      it('joined log foundation keeps staged logs invisible and does not acquire budget locks early', async () => {
        await source.getRepository(CallLog).delete({ request_id: 'request' });
        const logs = newLogs(), before = newLogs();
        const observer = await new DataSource({ ...source.options, synchronize: false }).initialize();
        const settle = BudgetService.prototype.settleLedger;
        const hook = jest.spyOn(BudgetService.prototype, 'settleLedger').mockImplementationOnce(async function (manager, ...args) {
          expect(await manager.getRepository(CallLog).count()).toBe(1);
          expect(await manager.getRepository(RouteDecisionLog).count()).toBe(1);
          expect(await observer.getRepository(CallLog).count()).toBe(0);
          const runner = observer.createQueryRunner(); await runner.connect(); await runner.startTransaction();
          try { await runner.query('SELECT id FROM budget_rules FOR UPDATE NOWAIT'); }
          finally { await runner.rollbackTransaction(); await runner.release(); }
          expect(logs.call.id).toBeUndefined(); expect(logs.call.cost_usd).toBe(before.call.cost_usd);
          return settle.call(this, manager, ...args);
        });
        try { await ledger.persistAndApplyRuntimeSettlementWithLogs(outcome, logs); }
        finally { hook.mockRestore(); await observer.destroy(); }
        await committed();
      });

      it('joined log foundation preserves the assigned identity after a lost commit response so scoped fallback cannot duplicate logs', async () => {
        await source.getRepository(CallLog).delete({ request_id: 'request' });
        const logs = newLogs(), create = source.createQueryRunner.bind(source), hooks: Array<{ mockRestore(): void }> = [];
        let commits = 0;
        const factory = jest.spyOn(source, 'createQueryRunner').mockImplementation((...args) => {
          const runner = create(...args), commit = runner.commitTransaction.bind(runner);
          hooks.push(jest.spyOn(runner, 'commitTransaction').mockImplementation(async () => {
            const outer = (runner as QueryRunner & { transactionDepth: number }).transactionDepth === 1;
            await commit();
            if (outer && ++commits === 2) throw Error('synthetic joined commit acknowledgement lost');
          }));
          return runner;
        });
        try { await expect(ledger.persistAndApplyRuntimeSettlementWithLogs(outcome, logs)).rejects.toThrow('synthetic joined commit acknowledgement lost'); }
        finally { factory.mockRestore(); for (const hook of hooks) hook.mockRestore(); }
        expect(Number.isSafeInteger(logs.call.id)).toBe(true); expect(Number.isSafeInteger(logs.route.id)).toBe(true);
        await ledger.persistCallLogs([logs.call], true); await source.getRepository(RouteDecisionLog).save(logs.route);
        expect(await source.getRepository(CallLog).count()).toBe(1); expect(await source.getRepository(RouteDecisionLog).count()).toBe(1);
        await committed();
      });

      it('joined log foundation rolls back staged logs when money fails, then recovers with the same reserved sequence identities', async () => {
        await source.getRepository(CallLog).delete({ request_id: 'request' });
        const logs = newLogs(), before = await financial();
        await source.query("CREATE FUNCTION joined_budget_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic joined money failure'; END; $$");
        await source.query('CREATE TRIGGER joined_budget_failure BEFORE UPDATE ON budget_rules FOR EACH ROW EXECUTE FUNCTION joined_budget_failure()');
        try {
          await expect(ledger.persistAndApplyRuntimeSettlementWithLogs(outcome, logs)).rejects.toThrow('synthetic joined money failure');
          expect(await financial()).toEqual(before); expect(await source.getRepository(RouteDecisionLog).count()).toBe(0);
        } finally { await source.query('DROP TRIGGER joined_budget_failure ON budget_rules'); await source.query('DROP FUNCTION joined_budget_failure()'); }
        await ledger.replayRuntimeOutcomes(new Date(Date.now() + 120000)); await ledger.reconcilePending();
        await ledger.persistCallLogs([logs.call], true); await source.getRepository(RouteDecisionLog).save(logs.route); await committed();
      });

      it.each(['workspace', 'request', 'existing-id'] as const)('joined log foundation rejects %s mismatch without changing money or another request log', async mismatch => {
        const logs = newLogs();
        if (mismatch === 'workspace') logs.call.workspace_id = 'foreign';
        if (mismatch === 'request') logs.call.request_id = 'foreign';
        if (mismatch === 'existing-id') logs.call.id = 999;
        const before = await financial();
        await expect(ledger.persistAndApplyRuntimeSettlementWithLogs(outcome, logs)).rejects.toMatchObject({ status: 409 });
        expect(await financial()).toEqual(before); expect(await source.getRepository(RouteDecisionLog).count()).toBe(0);
      });
    }

    async function rejectWrite(table: 'pricing_runtime_outcomes' | 'pricing_audit_events', operation: 'INSERT' | 'UPDATE', condition = '1 = 1', suppress = false, message = 'synthetic inbox write failure') {
      if (dialect === 'postgres') {
        await source.query(`CREATE FUNCTION inbox_fixture_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${condition} THEN ${suppress ? 'RETURN NULL;' : `RAISE EXCEPTION '${message}';`} END IF; RETURN NEW; END; $$`);
        await source.query(`CREATE TRIGGER inbox_fixture_failure BEFORE ${operation} ON ${table} FOR EACH ROW EXECUTE FUNCTION inbox_fixture_failure()`);
      } else await source.query(`CREATE TRIGGER inbox_fixture_failure BEFORE ${operation} ON ${table} WHEN ${condition} BEGIN SELECT RAISE(${suppress ? 'IGNORE' : `ABORT, '${message}'`}); END`);
      return async () => {
        await source.query(dialect === 'postgres' ? `DROP TRIGGER inbox_fixture_failure ON ${table}` : 'DROP TRIGGER inbox_fixture_failure');
        if (dialect === 'postgres') await source.query('DROP FUNCTION inbox_fixture_failure()');
      };
    }

    it.each(['retained', 'review_required'] as const)('inbox persistence phase rolls back the retained body when its %s marker is rejected by the database', async event => {
      const before = await financial(), restore = await rejectWrite('pricing_audit_events', 'INSERT', `NEW.action = 'cost.outcome_${event}'`);
      try {
        await expect(event === 'retained' ? ledger.retainRuntimeOutcome(attemptOutcome()) : ledger.archiveRuntimeOutcome(attemptOutcome())).rejects.toThrow('synthetic inbox write failure');
        expect(await rows()).toEqual([]); expect(await financial()).toEqual(before);
        expect(await source.query("SELECT * FROM pricing_audit_events WHERE action LIKE 'cost.outcome_%'")).toEqual([]);
      } finally { await restore(); }
      if (event === 'retained') await ledger.retainRuntimeOutcome(attemptOutcome());
      else await ledger.archiveRuntimeOutcome(attemptOutcome());
      expect((await rows())[0].state).toBe(event === 'retained' ? 'pending' : 'review_required');
    });

    it.each(['update', 'marker'] as const)('inbox persistence phase rolls back all graph members after a database %s rejection', async point => {
      const receipt = await ledger.retainRuntimeOutcome(attemptOutcome()); await ledger.retainRuntimeOutcome(outcome);
      const before = await financial();
      const restore = point === 'update'
        ? await rejectWrite('pricing_runtime_outcomes', 'UPDATE', `NEW.id = '${receipt.id}' AND NEW.state = 'delivered'`)
        : await rejectWrite('pricing_audit_events', 'INSERT', `NEW.id = '${receipt.id}:delivered'`);
      try {
        await expect(jointSettlement()).rejects.toThrow('synthetic inbox write failure');
        expect(await financial()).toEqual(before);
        expect((await rows()).every(row => row.state === 'pending')).toBe(true);
        expect(await source.query("SELECT * FROM pricing_audit_events WHERE action = 'cost.outcome_delivered'")).toEqual([]);
      } finally { await restore(); }
      await jointSettlement(); await committed();
    });

    it('inbox persistence phase keeps the full receipt chunk boundary bounded and commits each acknowledgement once', async () => {
      const [template] = await source.query('SELECT * FROM pricing_attempts');
      const extra = Array.from({ length: 128 }, (_, index) => ({ attemptId: `bound-${String(index).padStart(3, '0')}`, cost, errorCode: null }));
      await source.createQueryBuilder().insert().into('pricing_attempts').values(extra.map(receipt => ({ ...template, id: receipt.attemptId }))).execute();
      await ledger.retainRuntimeOutcome(attemptOutcome());
      for (const receipt of extra) await ledger.retainRuntimeOutcome({ ...attemptOutcome(), attemptId: receipt.attemptId });
      const query = jest.spyOn(source.logger, 'logQuery');
      const value = { ...outcome, payload: { ...outcome.payload, receipts: extra } };
      await jointSettlement(value);
      if (dialect === 'postgres') {
        const writes = query.mock.calls.filter(([sql]) => sql.startsWith('WITH pricing_outcome_updates'));
        expect(writes).toHaveLength(2);
        expect(writes.every(([, parameters]) => parameters!.length <= 2100)).toBe(true);
      }
      query.mockRestore();
      expect(await rows()).toHaveLength(130); expect((await rows()).every(row => row.state === 'delivered')).toBe(true);
      expect(await source.query("SELECT * FROM pricing_audit_events WHERE action = 'cost.outcome_delivered'")).toHaveLength(130);
      expect((await ledger.summary('request', workspace))?.amount).toBe('0.154800000000000000');
      expect(await source.query("SELECT * FROM pricing_budget_effects WHERE kind = 'commit'")).toHaveLength(1);
      await jointSettlement(value);
      expect(await source.query("SELECT * FROM pricing_audit_events WHERE action = 'cost.outcome_delivered'")).toHaveLength(130);
      expect(await source.query("SELECT * FROM pricing_budget_effects WHERE kind = 'commit'")).toHaveLength(1);
    }, 30000);

    if (dialect === 'postgres') {
      it.each(['body', 'marker'] as const)('inbox persistence phase fails closed if a database trigger suppresses the retained %s', async point => {
        const before = await financial(), restore = point === 'body'
          ? await rejectWrite('pricing_runtime_outcomes', 'INSERT', '1 = 1', true)
          : await rejectWrite('pricing_audit_events', 'INSERT', "NEW.action = 'cost.outcome_retained'", true);
        try {
          await expect(ledger.retainRuntimeOutcome(attemptOutcome())).rejects.toThrow('suppressed');
          expect(await rows()).toEqual([]); expect(await financial()).toEqual(before);
          expect(await source.query("SELECT * FROM pricing_audit_events WHERE action LIKE 'cost.outcome_%'")).toEqual([]);
        } finally { await restore(); }
      });

      it.each(['update', 'marker'] as const)('inbox persistence phase fails closed if a database trigger suppresses one acknowledgement %s', async point => {
        const receipt = await ledger.retainRuntimeOutcome(attemptOutcome()); await ledger.retainRuntimeOutcome(outcome);
        const before = await financial(), restore = point === 'update'
          ? await rejectWrite('pricing_runtime_outcomes', 'UPDATE', `NEW.id = '${receipt.id}' AND NEW.state = 'delivered'`, true)
          : await rejectWrite('pricing_audit_events', 'INSERT', `NEW.id = '${receipt.id}:delivered'`, true);
        try {
          await expect(jointSettlement()).rejects.toThrow('suppressed');
          expect(await financial()).toEqual(before);
          expect((await rows()).some(row => row.state === 'review_required')).toBe(true);
          expect((await rows()).some(row => row.state === 'delivered')).toBe(false);
          expect(await source.query("SELECT * FROM pricing_audit_events WHERE action = 'cost.outcome_delivered'")).toEqual([]);
        } finally { await restore(); }
      });

      it('inbox persistence phase reads a fresh graph after waiting for the parent fence, not the lock-query snapshot', async () => {
        await prices.capture({ request_id: 'other-request', workspace_id: workspace, report_currency: 'USD' });
        const blocker = source.createQueryRunner(), waiter = source.createQueryRunner();
        await blocker.connect(); await waiter.connect(); await blocker.startTransaction(); await waiter.startTransaction();
        const [{ pid }] = await waiter.query('SELECT pg_backend_pid() AS pid');
        await blocker.query('SELECT request_id FROM pricing_request_snapshots WHERE request_id=$1 FOR UPDATE', ['request']);
        const pending = retainRuntimeOutcome(waiter.manager, attemptOutcome());
        const rejected = expect(pending).rejects.toMatchObject({ status: 409 });
        try {
          let blocked = false;
          for (let i = 0; i < 50; i++) {
            const [state] = await source.query('SELECT cardinality(pg_blocking_pids($1)) AS blockers', [pid]);
            if (Number(state.blockers) > 0) { blocked = true; break; }
            await new Promise(resolve => setTimeout(resolve, 10));
          }
          expect(blocked).toBe(true);
          // The waiter must lock only the parent, not hold the child first.
          await blocker.query("SET LOCAL lock_timeout='500ms'");
          await blocker.query('UPDATE pricing_reservations SET request_id=$1 WHERE id=$2', ['other-request', 'reservation']);
          await blocker.commitTransaction(); await rejected;
          expect(await rows()).toEqual([]);
        } finally {
          if (blocker.isTransactionActive) await blocker.rollbackTransaction();
          await pending.catch(() => undefined);
          if (waiter.isTransactionActive) await waiter.rollbackTransaction();
          await blocker.release(); await waiter.release();
        }
      });

      it.each((['pricing_reservations', 'pricing_attempts'] as const).flatMap(table => [false, true].map(customized => ({ table, customized }))))('owned $table read refuses a changed parent after an actual lock wait (customized=$customized)', async ({ table, customized }) => {
        await prices.capture({ request_id: 'other-request', workspace_id: workspace, report_currency: 'USD' });
        const blocker = source.createQueryRunner(), waiter = source.createQueryRunner();
        await blocker.connect(); await waiter.connect(); await blocker.startTransaction(); await waiter.startTransaction();
        const [{ pid }] = await waiter.query('SELECT pg_backend_pid() AS pid');
        await blocker.query('SELECT request_id FROM pricing_request_snapshots WHERE request_id=$1 FOR UPDATE', ['request']);
        const id = table === 'pricing_reservations' ? 'reservation' : 'attempt';
        const reader = ledger as unknown as {
          reservation(manager: EntityManager, id: string, workspace: string, lock: boolean): Promise<unknown>;
          attempt(manager: EntityManager, id: string, workspace: string, lock: boolean): Promise<unknown>;
        };
        if (customized) jest.spyOn(waiter, 'query');
        const pending = reader[table === 'pricing_reservations' ? 'reservation' : 'attempt'](waiter.manager, id, workspace, true);
        const rejected = expect(pending).rejects.toMatchObject({ status: 409 });
        try {
          let blocked = false;
          for (let i = 0; i < 100; i++) {
            blocked = Number((await source.query('SELECT cardinality(pg_blocking_pids($1)) AS blockers', [pid]))[0].blockers) > 0;
            if (blocked) break;
            await new Promise(resolve => setTimeout(resolve, 10));
          }
          expect(blocked).toBe(true);
          await blocker.query("SET LOCAL lock_timeout='500ms'");
          await blocker.query('UPDATE ' + table + ' SET request_id=$1 WHERE id=$2', ['other-request', id]);
          await blocker.commitTransaction(); await rejected;
          expect(await source.query("SELECT * FROM pricing_budget_effects WHERE kind='commit'")).toEqual([]);
        } finally {
          if (blocker.isTransactionActive) await blocker.rollbackTransaction();
          await pending.catch(() => undefined);
          if (waiter.isTransactionActive) await waiter.rollbackTransaction();
          await blocker.release(); await waiter.release();
        }
      });

      it('inbox persistence phase binds the body and retention markers in one statement per independent transaction', async () => {
        const query = jest.spyOn(source.logger, 'logQuery');
        await ledger.retainRuntimeOutcome(attemptOutcome());
        await ledger.retainRuntimeOutcome(outcome);
        const writes = query.mock.calls.filter(([sql]) => sql.startsWith('WITH pricing_retained_outcome'));
        expect(writes).toHaveLength(2);
        // Real START is now transported with its reads; the TWO independent commits remain mandatory.
        expect(query.mock.calls.filter(([sql]) => sql.startsWith('/* siftgate_transaction_read_prelude:2 */'))).toHaveLength(2);
        expect(query.mock.calls.filter(([sql]) => sql === 'START TRANSACTION' || sql.startsWith('/* siftgate_transaction_read_prelude:2 */\nSTART TRANSACTION;'))).toHaveLength(2);
        expect(query.mock.calls.filter(([sql]) => sql === 'COMMIT')).toHaveLength(2);
        for (const [sql, values] of writes) {
          expect(sql).not.toContain('default-workspace');
          expect(sql).not.toContain('cost.outcome_retained');
          expect(values).toContain(workspace);
          expect(values).toContain('cost.outcome_retained');
        }
        query.mockRestore();
        expect((await rows()).map(row => row.state)).toEqual(['pending', 'pending']);
        expect(await source.query("SELECT * FROM pricing_audit_events WHERE action = 'cost.outcome_retained'")).toHaveLength(2);
        expect(await source.query("SELECT * FROM pricing_budget_effects WHERE kind = 'commit'")).toHaveLength(0);
      });

      it('inbox persistence phase acknowledges a verified two-body graph in one bounded statement without merging retention commits', async () => {
        await ledger.retainRuntimeOutcome(attemptOutcome());
        const query = jest.spyOn(source.logger, 'logQuery');
        await jointSettlement();
        expect(query.mock.calls.filter(([sql]) => sql.startsWith('WITH pricing_outcome_updates'))).toHaveLength(1);
        expect(query.mock.calls.filter(([sql]) => sql === 'START TRANSACTION' || sql.startsWith('/* siftgate_transaction_read_prelude:2 */\nSTART TRANSACTION;'))).toHaveLength(2);
        expect(query.mock.calls.filter(([sql]) => sql === 'COMMIT')).toHaveLength(2);
        query.mockRestore(); await committed();
        expect((await rows()).every(row => row.state === 'delivered')).toBe(true);
        expect(await source.query("SELECT * FROM pricing_audit_events WHERE action = 'cost.outcome_delivered'")).toHaveLength(2);
      });
    }

    it('settlement receipt graph inspects exact bodies, membership, audits and dispositions in one bounded read', async () => {
      await ledger.retainRuntimeOutcome(attemptOutcome());
      const queries = jest.spyOn(source.logger, 'logQuery');
      await jointSettlement();
      const reads = queries.mock.calls.filter(([sql]) => sql.startsWith('SELECT') && sql.includes('"ack_expected_id"'));
      expect(reads).toHaveLength(1);
      expect(reads[0][0]).toContain('"ack_receipt_count"');
      expect(reads[0][0]).toContain('pricing_runtime_outcome_dispositions');
      expect(reads[0][0]).toContain('pricing_audit_events');
      expect(queries.mock.calls.some(([sql]) => sql.startsWith('SELECT DISTINCT o.subject_id'))).toBe(false);
      queries.mockRestore(); await committed();
    });

    it('settlement receipt graph accepts direct intents without inventing retained receipt rows', async () => {
      await jointSettlement();
      expect((await rows()).map(row => row.kind)).toEqual(['settlement']);
      await committed();
    });
    it('settlement receipt graph accepts the same receipt hash with a different JSON property order', async () => {
      const original = attemptOutcome();
      original.cost = Object.fromEntries(Object.entries(original.cost).reverse()) as unknown as CostComputation;
      const receipt = await ledger.retainRuntimeOutcome(original);
      expect(receipt.outcome_hash).toBe(runtimeOutcomeDocument(attemptOutcome()).hash);
      await jointSettlement(); await committed();
      expect((await rows()).every(row => row.state === 'delivered')).toBe(true);
    });
    it('settlement receipt graph requires a transaction and bounded distinct receipt identities', async () => {
      const receipt = { attemptId: 'attempt', cost, errorCode: null };
      const owner = { id: 'reservation', request_id: 'request', workspace_id: workspace };
      const before = await financial();
      await expect(acknowledgeSettlementReceipts(source.manager, owner, [receipt])).rejects.toMatchObject({ status: 409 });
      for (const entries of [[receipt, receipt], Array(129).fill(receipt)])
        await expect(source.transaction(manager => acknowledgeSettlementReceipts(manager, owner, entries))).rejects.toMatchObject({ status: 409 });
      expect(await financial()).toEqual(before); expect(await rows()).toEqual([]);
    });
    it('settlement receipt graph captures caller objects before awaiting ownership', async () => {
      await ledger.retainRuntimeOutcome(attemptOutcome());
      const delivered = await ledger.retainRuntimeOutcome(outcome), owner = { id: 'reservation', request_id: 'request', workspace_id: workspace };
      const receipt = { attemptId: 'attempt', cost: structuredClone(cost), errorCode: null };
      await source.transaction(async manager => {
        const pending = acknowledgeSettlementReceipts(manager, owner, [receipt], delivered);
        owner.request_id = 'different'; receipt.attemptId = 'different'; receipt.cost.amount = '999'; delivered.outcome_json = '{}';
        await pending;
      });
      expect((await rows()).every(row => row.state === 'delivered')).toBe(true);
      expect(await source.query("SELECT * FROM pricing_budget_effects WHERE kind = 'commit'")).toEqual([]);
    });
    it('settlement receipt graph revalidates already delivered receipt markers on replay', async () => {
      const receipt = await ledger.retainRuntimeOutcome(attemptOutcome()); await jointSettlement();
      await source.createQueryBuilder().delete().from('pricing_audit_events').where('id = :id', { id: `${receipt.id}:delivered` }).execute();
      const before = await financial(); await expect(jointSettlement()).rejects.toMatchObject({ status: 409 });
      expect(await financial()).toEqual(before);
    });
    it('settlement receipt graph checks membership again after its request fence', async () => {
      await ledger.retainRuntimeOutcome(attemptOutcome());
      const owner = { id: 'reservation', request_id: 'request', workspace_id: workspace };
      const runner = source.createQueryRunner(); await runner.connect(); await runner.startTransaction();
      const query = runner.query.bind(runner); let changed = false;
      const spy = jest.spyOn(runner, 'query').mockImplementation(async (...args: Parameters<QueryRunner['query']>) => {
        const result = await query(...args);
        if (!changed && args[0].startsWith('SELECT') && args[0].includes('FROM "pricing_request_snapshots"')) {
          changed = true;
          await runner.manager.createQueryBuilder().update('pricing_attempts').set({ workspace_id: 'different' }).where('id = :id', { id: 'attempt' }).execute();
        }
        return result;
      });
      try {
        await expect(acknowledgeSettlementReceipts(runner.manager, owner, [{ attemptId: 'attempt', cost, errorCode: null }])).rejects.toMatchObject({ status: 404 });
        expect(changed).toBe(true);
        expect(await runner.manager.createQueryBuilder().select('a.id').from('pricing_audit_events', 'a').where('a.action = :action', { action: 'cost.outcome_delivered' }).getRawMany()).toEqual([]);
      } finally { spy.mockRestore(); await runner.rollbackTransaction(); await runner.release(); }
    });
    it('settlement receipt graph rolls back the first chunk when a later chunk has damaged evidence', async () => {
      await ledger.retainRuntimeOutcome(attemptOutcome());
      const [template] = await source.query('SELECT * FROM pricing_attempts');
      const extra = Array.from({ length: 128 }, (_, index) => ({ attemptId: `extra-${String(index).padStart(3, '0')}`, cost, errorCode: null }));
      await source.createQueryBuilder().insert().into('pricing_attempts').values(extra.map(receipt => ({ ...template, id: receipt.attemptId }))).execute();
      const last = await ledger.retainRuntimeOutcome({ ...attemptOutcome(), attemptId: extra[127].attemptId });
      await source.createQueryBuilder().delete().from('pricing_audit_events').where('id = :id', { id: `${last.id}:retained` }).execute();
      const before = await financial(), queries = jest.spyOn(source.logger, 'logQuery');
      await expect(jointSettlement({ ...outcome, payload: { ...outcome.payload, receipts: extra } })).rejects.toMatchObject({ status: 409 });
      const reads = queries.mock.calls.filter(([sql]) => sql.startsWith('SELECT') && sql.includes('"ack_expected_id"'));
      expect(reads).toHaveLength(2); expect(reads[0][0]).toContain('LIMIT 129'); expect(reads[1][0]).toContain('LIMIT 1');
      queries.mockRestore(); expect(await financial()).toEqual(before);
      expect(await source.query("SELECT * FROM pricing_audit_events WHERE action = 'cost.outcome_delivered'")).toEqual([]);
    });

    it.each(['missing-exact', 'wrong-subject', 'wrong-reservation', 'retained-marker', 'orphan-marker'] as const)('settlement receipt graph rejects %s without budget or acknowledgement writes', async defect => {
      const retained = await ledger.retainRuntimeOutcome(attemptOutcome());
      if (defect === 'missing-exact') {
        const different = structuredClone(attemptOutcome()); different.cost.lines[0].rate = '999';
        await ledger.retainRuntimeOutcome(different);
        await source.createQueryBuilder().delete().from('pricing_runtime_outcomes').where('id = :id', { id: retained.id }).execute();
      }
      if (defect === 'wrong-subject') await source.createQueryBuilder().update('pricing_runtime_outcomes').set({ subject_id: 'different' }).where('id = :id', { id: retained.id }).execute();
      if (defect === 'wrong-reservation') {
        await ledger.reserve({ id: 'different', requestId: 'request', identity: { workspaceId: workspace, apiKeyId: null, apiKeyName: null, namespaceId: null, teamId: null }, target, estimate: cost, tokens: '0', costUsd: '0', budgetBasis: 'legacy_logical', leaseOwner: 'synthetic-other', leaseUntil: new Date(Date.now() + 60000).toISOString() });
        await source.createQueryBuilder().update('pricing_runtime_outcomes').set({ reservation_id: 'different' }).where('id = :id', { id: retained.id }).execute();
      }
      if (defect === 'retained-marker') await source.createQueryBuilder().update('pricing_audit_events').set({ actor_id: 'different' }).where('id = :id', { id: `${retained.id}:retained` }).execute();
      if (defect === 'orphan-marker') await source.createQueryBuilder().delete().from('pricing_runtime_outcomes').where('id = :id', { id: retained.id }).execute();
      const before = await financial();
      await expect(jointSettlement()).rejects.toMatchObject({ status: 409 });
      expect(await financial()).toEqual(before);
      expect(await source.query("SELECT * FROM pricing_audit_events WHERE action = 'cost.outcome_delivered'")).toEqual([]);
    });

    it('batched acknowledgements read both exact audit sets once without merging durable retention boundaries', async () => {
      const receipt = await ledger.retainRuntimeOutcome(attemptOutcome()), terminal = runtimeOutcomeDocument(outcome);
      const queries = jest.spyOn(source.logger, 'logQuery'), transactions = jest.spyOn(source, 'transaction');
      await jointSettlement();
      const auditReads = queries.mock.calls.filter(([sql]) => sql.startsWith('SELECT') && sql.includes('"ack_expected_id"'));
      expect(auditReads).toHaveLength(1);
      expect(auditReads[0][0]).toContain('LIMIT 2');
      for (const marker of ['retained', 'delivered', 'review_required']) expect(auditReads[0][0]).toContain(`"ack_${marker}_metadata_json"`);
      expect(auditReads[0][1]).toEqual(expect.arrayContaining([workspace, receipt.id, terminal.id]));
      expect(transactions).toHaveBeenCalledTimes(2);
      queries.mockRestore(); transactions.mockRestore(); await committed();
      expect((await rows()).every(row => row.state === 'delivered')).toBe(true);
    });

    it('batched acknowledgements reject damage in the later receipt before committing any acknowledgement or money', async () => {
      await ledger.retainRuntimeOutcome(attemptOutcome());
      await ledger.beginAttempt({ id: 'attempt-2', requestId: 'request', workspace, reservationId: 'reservation', target, feeSource: 'provider', dispatchedAt: '2026-09-20T00:00:01.000Z', priceContext: { context: {}, legacyPrice: null } });
      const second = await ledger.retainRuntimeOutcome({ ...attemptOutcome(), attemptId: 'attempt-2' });
      await source.createQueryBuilder().delete().from('pricing_audit_events').where('id = :id', { id: `${second.id}:retained` }).execute();
      const before = await financial();
      const both = { ...outcome, payload: { ...outcome.payload, receipts: [{ attemptId: 'attempt-2', cost, errorCode: null }] } };
      await expect(jointSettlement(both)).rejects.toMatchObject({ status: 409 });
      expect(await financial()).toEqual(before);
      expect(await source.query("SELECT * FROM pricing_audit_events WHERE action = 'cost.outcome_delivered'")).toEqual([]);
      expect((await rows()).filter(row => row.kind === 'attempt').every(row => row.state === 'pending')).toBe(true);
    });

    it.each([false, true])('single-pass composed receipt inspection happens at application, not again at intent creation (joint=%s)', async joint => {
      if (joint) await ledger.retainRuntimeOutcome(attemptOutcome());
      const internal = ledger as unknown as Internals, apply = internal.applySettlementInTransaction.bind(ledger);
      let applying = false;
      const inspections: boolean[] = [];
      const attempts = internal.receiptAttemptsUnderRequest.bind(ledger);
      jest.spyOn(internal, 'receiptAttemptsUnderRequest').mockImplementation(async (...args) => {
        const result = await attempts(...args);
        expect([...result.keys()]).toEqual(['attempt']);
        expect(Object.keys(result.get('attempt')!).sort()).toEqual(['cost_hash', 'error_code', 'id', 'state']);
        inspections.push(applying);
        return result;
      });
      jest.spyOn(internal, 'applySettlementInTransaction').mockImplementation(async (...args) => {
        expect(args[0].queryRunner?.isTransactionActive).toBe(true);
        applying = true;
        try { return await apply(...args); } finally { applying = false; }
      });
      await (joint ? jointSettlement() : ledger.persistAndApplyRuntimeSettlement(outcome));
      expect(inspections).toEqual([true]);
      jest.restoreAllMocks(); await committed();
    });

    it.each(['missing', 'foreign', 'terminal'] as const)('single-pass composed change leaves queue-only %s receipt preflight intact', async defect => {
      if (defect === 'missing') await source.createQueryBuilder().delete().from('pricing_attempts').where('id = :id', { id: 'attempt' }).execute();
      if (defect === 'foreign') await source.createQueryBuilder().update('pricing_attempts').set({ workspace_id: 'another-workspace' }).where('id = :id', { id: 'attempt' }).execute();
      if (defect === 'terminal') {
        const different = (await prices.restoreRequest('request', workspace)).quote(target, tokens({ input_tokens: 2000, output_tokens: 100 })).cost;
        await ledger.completeAttempt('attempt', workspace, different);
      }
      const before = await financial();
      await expect(ledger.queueSettlement('reservation', workspace, outcome.payload.kind, outcome.payload.tokens, outcome.payload.cost_usd, outcome.payload.budget_basis, outcome.payload.receipt)).rejects.toMatchObject({ status: defect === 'terminal' ? 409 : 404 });
      expect(await financial()).toEqual(before);
      expect(await rows()).toEqual([]);
      expect(await source.query('SELECT * FROM pricing_settlement_intents')).toEqual([]);
    });

    it.each(['missing', 'foreign', 'terminal'] as const)('single-pass composed application still reads %s receipt changes after the provisional intent', async defect => {
      const internal = ledger as unknown as Internals, apply = internal.applySettlementInTransaction.bind(ledger), before = await financial();
      const fault = jest.spyOn(internal, 'applySettlementInTransaction').mockImplementationOnce(async (manager, row, intent) => {
        expect(await manager.createQueryBuilder().select('i.reservation_id').from('pricing_settlement_intents', 'i').where('i.reservation_id = :id', { id: row.id }).getRawMany()).toHaveLength(1);
        if (defect === 'missing') await manager.createQueryBuilder().delete().from('pricing_attempts').where('id = :id', { id: 'attempt' }).execute();
        if (defect === 'foreign') await manager.createQueryBuilder().update('pricing_attempts').set({ workspace_id: 'another-workspace' }).where('id = :id', { id: 'attempt' }).execute();
        if (defect === 'terminal') await manager.createQueryBuilder().update('pricing_attempts').set({ state: 'terminal', cost_hash: 'synthetic-other-receipt' }).where('id = :id', { id: 'attempt' }).execute();
        return apply(manager, row, intent);
      });
      await expect(ledger.persistAndApplyRuntimeSettlement(outcome)).rejects.toMatchObject({ status: defect === 'terminal' ? 409 : 404 });
      fault.mockRestore();
      expect(await financial()).toEqual(before);
      expect((await rows())[0].state).toBe('review_required');
      expect(JSON.parse((await rows())[0].outcome_json)).toEqual(outcome);
      expect(await source.query("SELECT * FROM pricing_audit_events WHERE action = 'cost.outcome_delivered'")).toEqual([]);
    });

    it('joint receipt application acknowledges both retained bodies with one full projection and one money effect', async () => {
      const receipt = await ledger.retainRuntimeOutcome(attemptOutcome());
      const before = await financial();
      expect((await rows())[0].state).toBe('pending');
      const tx = jest.spyOn(source, 'transaction'), summary = jest.spyOn(ledger as unknown as Internals, 'summaryInTransaction');
      await jointSettlement();
      expect(tx).toHaveBeenCalledTimes(2);
      expect(summary).toHaveBeenCalledTimes(1);
      tx.mockRestore(); summary.mockRestore();
      expect(await rows()).toHaveLength(2);
      expect((await rows()).every(row => row.state === 'delivered')).toBe(true);
      expect(JSON.parse((await source.query('SELECT * FROM pricing_attempts'))[0].cost_json)).toEqual(JSON.parse(JSON.stringify(cost)));
      expect((await financial()).budget_rules).not.toEqual(before.budget_rules);
      await committed();
      await ledger.persistRuntimeOutcome(attemptOutcome());
      await jointSettlement();
      expect(await source.query("SELECT * FROM pricing_budget_effects WHERE kind = 'commit'")).toHaveLength(1);
      expect(await source.createQueryBuilder().select('a.id', 'id').from('pricing_audit_events', 'a')
        .where('a.id = :id', { id: `${receipt.id}:delivered` }).getRawMany()).toHaveLength(1);
    });

    it.each([false, true])('joint receipt provenance rejects a different retained cost before applying money (joint=%s)', async joint => {
      await ledger.retainRuntimeOutcome(attemptOutcome());
      const snapshot = await prices.capture({ request_id: 'request', workspace_id: workspace, report_currency: 'USD' });
      const different = snapshot!.quote(target, tokens({ input_tokens: 2000, output_tokens: 100 })).cost;
      const changed: Settlement = { ...outcome, payload: { ...outcome.payload, tokens: '2100', cost_usd: different.report_amount!, receipt: { attemptId: 'attempt', cost: different, errorCode: null } } };
      const before = await financial();
      await expect(joint ? jointSettlement(changed) : ledger.persistAndApplyRuntimeSettlement(changed)).rejects.toMatchObject({ status: 409 });
      expect(await financial()).toEqual(before);
      expect((await rows()).find(row => row.kind === 'attempt')?.state).toBe('pending');
      expect(await source.query("SELECT * FROM pricing_budget_effects WHERE kind = 'commit'")).toEqual([]);
    });

    it.each(['retention-audit', 'quarantine', 'ownership'] as const)('joint receipt application rejects %s damage without acknowledging or changing money', async defect => {
      const retained = await ledger.retainRuntimeOutcome(attemptOutcome());
      if (defect === 'retention-audit') await source.createQueryBuilder().delete().from('pricing_audit_events').where('id = :id', { id: `${retained.id}:retained` }).execute();
      if (defect === 'quarantine') await ledger.archiveRuntimeOutcome(attemptOutcome());
      if (defect === 'ownership') await source.createQueryBuilder().update('pricing_runtime_outcomes').set({ request_id: 'wrong-request' }).where('id = :id', { id: retained.id }).execute();
      const before = await financial();
      await expect(jointSettlement()).rejects.toThrow();
      expect(await financial()).toEqual(before);
      expect(await source.query("SELECT * FROM pricing_audit_events WHERE action = 'cost.outcome_delivered'")).toEqual([]);
    });

    it.each(['receipt_ack', 'after_money'] as const)('joint receipt application rolls back both acknowledgements and money after %s failure', async phase => {
      const receipt = await ledger.retainRuntimeOutcome(attemptOutcome()), before = await financial();
      const settle = BudgetService.prototype.settleLedger;
      const restore = phase === 'receipt_ack'
        ? await rejectWrite('pricing_audit_events', 'INSERT', `NEW.id = '${receipt.id}:delivered'`, false, 'synthetic joint failure')
        : (() => { const fault = jest.spyOn(BudgetService.prototype, 'settleLedger').mockImplementation(async function (...args) {
            await settle.apply(this, args); throw new Error('synthetic joint failure');
          }); return async () => { fault.mockRestore(); }; })();
      try { await expect(jointSettlement()).rejects.toThrow('synthetic joint failure'); }
      finally { await restore(); }
      expect(await financial()).toEqual(before);
      expect((await rows()).every(row => row.state === 'pending')).toBe(true);
      expect(await source.query("SELECT * FROM pricing_audit_events WHERE action = 'cost.outcome_delivered'")).toEqual([]);
      await jointSettlement(); await committed();
      expect((await rows()).every(row => row.state === 'delivered')).toBe(true);
    });

    it('joint receipt application races standalone replay without duplicate effects or lost acknowledgements', async () => {
      await ledger.retainRuntimeOutcome(attemptOutcome());
      const peer = dialect === 'postgres' ? await new DataSource({ ...source.options, synchronize: false }).initialize() : source;
      try {
        await Promise.all([makeLedger(peer).persistRuntimeOutcome(attemptOutcome()), jointSettlement()]);
        await committed();
        expect((await rows()).every(row => row.state === 'delivered')).toBe(true);
        expect(await source.query("SELECT * FROM pricing_audit_events WHERE action = 'cost.outcome_delivered'")).toHaveLength(2);
      } finally { if (peer !== source) await peer.destroy(); }
    });

    it.each(['retained', 'delivered'] as const)('joint receipt revisits the %s audit even when standalone delivery already completed', async event => {
      await ledger.persistRuntimeOutcome(attemptOutcome());
      const id = runtimeOutcomeDocument(attemptOutcome()).id;
      await source.createQueryBuilder().delete().from('pricing_audit_events').where('id = :id', { id: `${id}:${event}` }).execute();
      const before = await financial();
      await expect(jointSettlement()).rejects.toMatchObject({ status: 409 });
      expect(await financial()).toEqual(before);
    });

    it('joint receipt reads full bodies only for exact matching identities, not every retained variant', async () => {
      await ledger.retainRuntimeOutcome(attemptOutcome());
      const snapshot = await prices.capture({ request_id: 'request', workspace_id: workspace, report_currency: 'USD' });
      const other = { ...attemptOutcome(), cost: snapshot!.quote(target, tokens({ input_tokens: 2000, output_tokens: 100 })).cost };
      const variant = await ledger.retainRuntimeOutcome(other);
      await source.createQueryBuilder().update('pricing_runtime_outcomes').set({ outcome_json: 'x'.repeat(1024 * 1024) }).where('id = :id', { id: variant.id }).execute();
      const queries = jest.spyOn(source.logger, 'logQuery');
      await jointSettlement();
      const discovery = queries.mock.calls.filter(([sql]) => sql.startsWith('SELECT') && sql.includes('"ack_expected_id"'));
      expect(discovery).toHaveLength(1);
      expect(discovery[0][0]).toContain('o.id = e.expected_id');
      expect(discovery[0][0]).toContain('SELECT 1 FROM "pricing_runtime_outcomes" "sibling"');
      expect(discovery[0][1]).not.toContain(variant.id);
      queries.mockRestore();
      expect((await rows()).find(row => row.id === variant.id)).toMatchObject({ state: 'review_required', outcome_json: 'x'.repeat(1024 * 1024) });
      expect((await ledger.summary('request', workspace))?.budget_committed_usd).toBe('0.001200000000000000');
    });

    it('joint receipt application recovers a real child exit after both acknowledgements but before commit', async () => {
      await ledger.retainRuntimeOutcome(attemptOutcome());
      const before = await financial();
      const child = spawnSync(process.execPath, ['-r', require.resolve('ts-node/register'), '-e', `
        require('reflect-metadata');
        const {DataSource}=require('typeorm');
        const {BudgetRule}=require('./src/database/entities/budget-rule.entity');
        const {CallLog}=require('./src/database/entities/call-log.entity');
        const {BudgetService}=require('./src/budget/budget.service');
        const {WorkspaceContextService}=require('./src/workspaces/workspace-context.service');
        const {CostLedgerService}=require('./src/pricing/cost-ledger.service');
        (async()=>{
          const db=await new DataSource({...JSON.parse(process.env.PRICING_CHILD_DB),entities:[BudgetRule,CallLog],synchronize:false}).initialize();
          const ledger=new CostLedgerService(db,new BudgetService({},new WorkspaceContextService(),db.getRepository(BudgetRule)));
          const apply=ledger.applySettlementInTransaction.bind(ledger);
          ledger.applySettlementInTransaction=async(...args)=>{await apply(...args);
            const rows=await args[0].query("SELECT state FROM pricing_runtime_outcomes");
            if(rows.length!==2||!rows.every(row=>row.state==='delivered'))process.exit(22);
            process.exit(21);
          };
          await ledger.persistAndApplyRuntimeSettlement(JSON.parse(process.env.PRICING_CHILD_OUTCOME),true,true);process.exit(23);
        })().catch(error=>{console.error(error.stack);process.exit(24)});
      `], { cwd: process.cwd(), encoding: 'utf8', timeout: 20000, env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, NODE_OPTIONS: '--max-old-space-size=512', LC_ALL: 'C', TS_NODE_TRANSPILE_ONLY: 'true', PRICING_CHILD_DB: JSON.stringify(source.options), PRICING_CHILD_OUTCOME: JSON.stringify(outcome) } });
      expect(child.error).toBeUndefined(); expect(child.status).toBe(21);
      expect(await financial()).toEqual(before);
      expect((await rows()).every(row => row.state === 'pending')).toBe(true);
      expect(await source.query("SELECT * FROM pricing_audit_events WHERE action = 'cost.outcome_delivered'")).toEqual([]);
      ledger = makeLedger(); await jointSettlement(); await committed();
      expect((await rows()).every(row => row.state === 'delivered')).toBe(true);
    }, 30000);

    it('validates the completed receipt projection before taking shared budget locks', async () => {
      const order: string[] = [], internal = ledger as unknown as Internals;
      const summary = internal.summaryInTransaction.bind(ledger), settle = BudgetService.prototype.settleLedger;
      jest.spyOn(internal, 'summaryInTransaction').mockImplementation(async (...args) => {
        const value = await summary(...args);
        expect(args[3]).toBe('log');
        expect(value).toEqual({ known_subtotal: '0.001200000000000000' });
        order.push('verified-projection');
        return value;
      });
      jest.spyOn(BudgetService.prototype, 'settleLedger').mockImplementation(function (...args) { order.push('budget-apply'); return settle.apply(this, args); });
      await ledger.persistAndApplyRuntimeSettlement(outcome);
      expect(order).toEqual(['verified-projection', 'budget-apply']);
      jest.restoreAllMocks(); await committed();
    });

    it('still verifies unrelated retained receipts when there are no log rows to update', async () => {
      await ledger.beginAttempt({ id: 'earlier-attempt', requestId: 'request', workspace, reservationId: 'reservation', target, feeSource: 'provider', dispatchedAt: '2026-09-19T00:00:00.000Z', priceContext: { context: {}, legacyPrice: null } });
      await ledger.completeAttempt('earlier-attempt', workspace, cost);
      await source.createQueryBuilder().update('pricing_attempts').set({ cost_hash: 'synthetic-corruption' }).where('id = :id', { id: 'earlier-attempt' }).execute();
      await source.getRepository(CallLog).clear();
      const before = await financial();
      await expect(ledger.persistAndApplyRuntimeSettlement(outcome)).rejects.toMatchObject({ status: 409 });
      expect(await financial()).toEqual(before);
      expect((await rows())[0].state).toBe('review_required');
    });

    const phaseFinancial = async (db = source) => {
      const value: Record<string, unknown> = {};
      for (const table of ['pricing_attempts', 'pricing_settlement_intents', 'pricing_reservations', 'pricing_budget_balances', 'pricing_budget_effects', 'budget_rules', 'call_logs', 'pricing_recovery_cases'])
        value[table] = await db.query(`SELECT * FROM ${table}`);
      return value;
    };
    async function openPhaseCase() {
      await source.createQueryBuilder().update('pricing_reservations').set({ lease_until: '2000-01-01T00:00:00.000Z' }).where('id = :id', { id: 'reservation' }).execute();
      expect((await ledger.reconcileDispatched()).opened).toBe(1);
    }
    async function assertTentativeCompletion(manager: EntityManager) {
      expect(manager.queryRunner?.isTransactionActive).toBe(true);
      expect((await manager.query('SELECT state FROM pricing_reservations'))[0].state).toBe('committed');
      expect((await manager.query('SELECT state FROM pricing_settlement_intents'))[0].state).toBe('applied');
      expect((await manager.query('SELECT state FROM pricing_recovery_cases'))[0].state).toBe('resolved');
      expect(Number((await manager.query('SELECT cost_usd FROM call_logs'))[0].cost_usd)).toBe(.0012);
      expect(await manager.query("SELECT * FROM pricing_budget_effects WHERE kind='commit'")).toEqual([]);
      expect(Number((await manager.query('SELECT current_value FROM budget_rules'))[0].current_value)).toBe(.5);
    }

    it.each([false, true])('settlement metadata phase finishes owner records before shared budget mutation (joint=%s)', async joint => {
      await openPhaseCase();
      if (joint) await ledger.retainRuntimeOutcome(attemptOutcome());
      const settle = BudgetService.prototype.settleLedger;
      const observer = jest.spyOn(BudgetService.prototype, 'settleLedger').mockImplementation(async function (...args) {
        await assertTentativeCompletion(args[0]);
        return settle.apply(this, args);
      });
      await (joint ? jointSettlement() : ledger.persistAndApplyRuntimeSettlement(outcome));
      expect(observer).toHaveBeenCalledTimes(1);
      observer.mockRestore(); await committed();
    });

    it.each(['pricing_reservations', 'pricing_settlement_intents', 'pricing_recovery_cases', 'call_logs'])('settlement metadata phase fails %s before touching budgets and rolls back all tentative state', async table => {
      await openPhaseCase(); const before = await phaseFinancial(), update = UpdateQueryBuilder.prototype.execute;
      const budget = jest.spyOn(BudgetService.prototype, 'settleLedger');
      let restoreFault: () => Promise<void>;
      if (dialect === 'postgres') {
        await source.query("CREATE FUNCTION metadata_phase_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic metadata phase failure'; END; $$");
        await source.query('CREATE TRIGGER metadata_phase_failure BEFORE UPDATE ON ' + table + ' FOR EACH ROW EXECUTE FUNCTION metadata_phase_failure()');
        restoreFault = async () => { await source.query('DROP TRIGGER metadata_phase_failure ON ' + table); await source.query('DROP FUNCTION metadata_phase_failure()'); };
      } else {
        const fault = jest.spyOn(UpdateQueryBuilder.prototype, 'execute').mockImplementation(function () {
          const path = this.expressionMap.mainAlias?.tablePath;
          if (path === table || path?.endsWith('.' + table)) throw new Error('synthetic metadata phase failure');
          return update.call(this);
        });
        restoreFault = async () => { fault.mockRestore(); };
      }
      await expect(ledger.persistAndApplyRuntimeSettlement(outcome)).rejects.toThrow('synthetic metadata phase failure');
      expect(budget).not.toHaveBeenCalled();
      await restoreFault(); budget.mockRestore();
      expect(await phaseFinancial()).toEqual(before);
      expect((await rows())[0].state).toBe('pending');
      expect(await source.query("SELECT * FROM pricing_audit_events WHERE action='cost.outcome_delivered'")).toEqual([]);
      await recover(); await committed();
    });

    if (dialect === 'postgres') {
      it('sends the four metadata updates in original order as one real database operation', async () => {
        await openPhaseCase(); const logger = jest.spyOn(source.logger, 'logQuery');
        await ledger.persistAndApplyRuntimeSettlement(outcome);
        const programs = logger.mock.calls.filter(([sql]) => sql.startsWith('/* siftgate_settlement_metadata:'));
        expect(programs).toHaveLength(1);
        expect(programs[0][0]).toContain('/* siftgate_settlement_metadata:4 */');
        const statements = programs[0][0].split(';\n');
        expect(statements).toHaveLength(4);
        for (const [index, table] of ['pricing_reservations', 'pricing_settlement_intents', 'pricing_recovery_cases', 'call_logs'].entries()) {
          const qualified = table === 'call_logs' ? `"${schema}"."call_logs"` : `"${table}"`;
          expect(statements[index]).toContain(`UPDATE ${qualified} SET `);
        }
        logger.mockRestore(); await committed();
      });

      it('preserves cross-table trigger read-your-writes ordering, not sibling-CTE snapshots', async () => {
        await openPhaseCase();
        await source.query(`CREATE FUNCTION metadata_order_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
          IF TG_TABLE_NAME='pricing_settlement_intents' AND (SELECT state FROM pricing_reservations WHERE id='reservation') <> 'committed' THEN RAISE EXCEPTION 'reservation not ready'; END IF;
          IF TG_TABLE_NAME='pricing_recovery_cases' AND (SELECT state FROM pricing_settlement_intents WHERE reservation_id='reservation') <> 'applied' THEN RAISE EXCEPTION 'intent not ready'; END IF;
          IF TG_TABLE_NAME='call_logs' AND (SELECT state FROM pricing_recovery_cases WHERE reservation_id='reservation') <> 'resolved' THEN RAISE EXCEPTION 'case not ready'; END IF;
          RETURN NEW; END $$`);
        for (const table of ['pricing_settlement_intents', 'pricing_recovery_cases', 'call_logs'])
          await source.query('CREATE TRIGGER metadata_order_guard BEFORE UPDATE ON ' + table + ' FOR EACH ROW EXECUTE FUNCTION metadata_order_guard()');
        await ledger.persistAndApplyRuntimeSettlement(outcome); await committed();
      });

      it.each(['pricing_reservations', 'pricing_settlement_intents'])('rejects a suppressed required %s update before budgets and rolls back all metadata', async table => {
        await openPhaseCase(); const before = await phaseFinancial();
        const budget = jest.spyOn(BudgetService.prototype, 'settleLedger');
        await source.query('CREATE FUNCTION suppress_metadata() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$');
        await source.query('CREATE TRIGGER suppress_metadata BEFORE UPDATE ON ' + table + ' FOR EACH ROW EXECUTE FUNCTION suppress_metadata()');
        await expect(ledger.persistAndApplyRuntimeSettlement(outcome)).rejects.toMatchObject({ status: 409 });
        expect(budget).not.toHaveBeenCalled(); budget.mockRestore();
        expect(await phaseFinancial()).toEqual(before);
        expect((await rows())[0].state).toBe('review_required');
        expect(await source.query("SELECT * FROM pricing_audit_events WHERE action='cost.outcome_delivered'")).toEqual([]);
      });

      it('permits an absent optional recovery case or existing log without suppressing money', async () => {
        await source.getRepository(CallLog).clear();
        await ledger.persistAndApplyRuntimeSettlement(outcome);
        expect((await ledger.summary('request', workspace))?.budget_committed_usd).toBe('0.001200000000000000');
        expect(await source.query("SELECT * FROM pricing_budget_effects WHERE kind='commit'")).toHaveLength(1);
        expect(await source.getRepository(CallLog).count()).toBe(0);
        expect(await source.query('SELECT * FROM pricing_recovery_cases')).toEqual([]);
      });

      it('keeps ORM query/entity subscribers on the original metadata-update path', async () => {
        await openPhaseCase();
        const subscriber = { listenTo: () => CallLog, beforeUpdate: jest.fn() }; source.subscribers.push(subscriber);
        const logger = jest.spyOn(source.logger, 'logQuery');
        try {
          await ledger.persistAndApplyRuntimeSettlement(outcome);
          expect(logger.mock.calls.some(([sql]) => sql.startsWith('/* siftgate_settlement_metadata:'))).toBe(false);
          expect(subscriber.beforeUpdate).toHaveBeenCalledTimes(1);
          await committed();
        } finally { source.subscribers.splice(source.subscribers.indexOf(subscriber), 1); }
      });
    }

    it('settlement metadata phase rolls back on a real database budget-write rejection', async () => {
      await openPhaseCase(); const before = await phaseFinancial();
      if (dialect === 'postgres') {
        await source.query("CREATE FUNCTION phase_budget_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic phase budget failure'; END; $$");
        await source.query('CREATE TRIGGER phase_budget_failure BEFORE UPDATE ON budget_rules FOR EACH ROW EXECUTE FUNCTION phase_budget_failure()');
      } else await source.query("CREATE TRIGGER phase_budget_failure BEFORE UPDATE ON budget_rules BEGIN SELECT RAISE(ABORT, 'synthetic phase budget failure'); END");
      try {
        await expect(ledger.persistAndApplyRuntimeSettlement(outcome)).rejects.toThrow('synthetic phase budget failure');
        expect(await phaseFinancial()).toEqual(before);
        expect((await rows())[0].state).toBe('pending');
        expect(await source.query("SELECT * FROM pricing_audit_events WHERE action='cost.outcome_delivered'")).toEqual([]);
      } finally {
        await source.query(dialect === 'postgres' ? 'DROP TRIGGER phase_budget_failure ON budget_rules' : 'DROP TRIGGER phase_budget_failure');
        if (dialect === 'postgres') await source.query('DROP FUNCTION phase_budget_failure()');
      }
      await recover(); await committed();
    });

    it('settlement metadata phase stays invisible to another connection and does not acquire the shared budget lock early', async () => {
      await openPhaseCase(); const before = await phaseFinancial(), entered = gate(), resume = gate();
      const observer = await new DataSource({ ...source.options, synchronize: false }).initialize();
      const settle = BudgetService.prototype.settleLedger;
      const hook = jest.spyOn(BudgetService.prototype, 'settleLedger').mockImplementationOnce(async function (...args) {
        await assertTentativeCompletion(args[0]); entered.release(); await resume.ready;
        return settle.apply(this, args);
      });
      const pending = ledger.persistAndApplyRuntimeSettlement(outcome);
      try {
        await Promise.race([entered.ready, pending.then(() => { throw new Error('Missing metadata phase barrier'); })]);
        expect(await phaseFinancial(observer)).toEqual(before);
        expect((await observer.query('SELECT state FROM pricing_runtime_outcomes'))[0].state).toBe('pending');
        if (dialect === 'postgres') {
          await observer.transaction(async manager => {
            const rules = await manager.createQueryBuilder().select('b.id').from(BudgetRule, 'b').where('b.workspace_id = :workspace', { workspace })
              .setLock('pessimistic_write').setOnLocked('nowait').getRawMany();
            expect(rules).toHaveLength(1);
          });
          await expect(observer.transaction(manager => manager.createQueryBuilder().select('s.request_id').from('pricing_request_snapshots', 's')
            .where('s.request_id = :id AND s.workspace_id = :workspace', { id: 'request', workspace }).setLock('pessimistic_write').setOnLocked('nowait').getRawOne())).rejects.toMatchObject({ driverError: { code: '55P03' } });
        }
      } finally { resume.release(); await pending.catch(() => undefined); hook.mockRestore(); await observer.destroy(); }
      await pending; await committed();
    });

    if (dialect === 'postgres') it('settlement metadata phase does not freeze a budget epoch before the budget lock', async () => {
      await openPhaseCase(); const entered = gate(), resume = gate(), settle = BudgetService.prototype.settleLedger;
      const hook = jest.spyOn(BudgetService.prototype, 'settleLedger').mockImplementationOnce(async function (...args) {
        await assertTentativeCompletion(args[0]); entered.release(); await resume.ready;
        return settle.apply(this, args);
      });
      const pending = ledger.persistAndApplyRuntimeSettlement(outcome);
      const period = new Date(Date.now() + 60000);
      try {
        await Promise.race([entered.ready, pending.then(() => { throw new Error('Missing metadata phase barrier'); })]);
        await source.transaction(async manager => {
          const rule = await manager.getRepository(BudgetRule).createQueryBuilder('b').where('b.workspace_id = :workspace', { workspace }).setLock('pessimistic_write').setOnLocked('nowait').getOneOrFail();
          await manager.getRepository(BudgetRule).update(rule.id, { period_start: period, current_value: .3 });
        });
      } finally { resume.release(); await pending.catch(() => undefined); hook.mockRestore(); }
      await pending; await committed();
      const rule = await source.getRepository(BudgetRule).findOneByOrFail({ workspace_id: workspace });
      expect(rule.period_start.toISOString()).toBe(period.toISOString());
      expect(rule.current_value).toBeCloseTo(.3012, 12);
      const balance = await source.query('SELECT amount_decimal FROM pricing_budget_balances ORDER BY period_start');
      expect(balance.map((r: { amount_decimal: string }) => r.amount_decimal)).toEqual(['0.500000000000000000', '0.301200000000000000']);
    });

    it('settlement metadata phase survives a real child exit before any budget write', async () => {
      await openPhaseCase(); const before = await phaseFinancial();
      const child = spawnSync(process.execPath, ['-r', require.resolve('ts-node/register'), '-e', `
        require('reflect-metadata');
        const {DataSource}=require('typeorm');
        const {BudgetRule}=require('./src/database/entities/budget-rule.entity');
        const {CallLog}=require('./src/database/entities/call-log.entity');
        const {BudgetService}=require('./src/budget/budget.service');
        const {WorkspaceContextService}=require('./src/workspaces/workspace-context.service');
        const {CostLedgerService}=require('./src/pricing/cost-ledger.service');
        (async()=>{
          const db=await new DataSource({...JSON.parse(process.env.PRICING_CHILD_DB),entities:[BudgetRule,CallLog],synchronize:false}).initialize();
          const budgets=new BudgetService({},new WorkspaceContextService(),db.getRepository(BudgetRule));
          budgets.settleLedger=async(manager)=>{
            const reservation=(await manager.query('SELECT state FROM pricing_reservations'))[0];
            const intent=(await manager.query('SELECT state FROM pricing_settlement_intents'))[0];
            const recovery=(await manager.query('SELECT state FROM pricing_recovery_cases'))[0];
            const log=(await manager.query('SELECT cost_usd FROM call_logs'))[0];
            if(reservation.state!=='committed'||intent.state!=='applied'||recovery.state!=='resolved'||Number(log.cost_usd)!==.0012)process.exit(52);
            process.exit(51);
          };
          const ledger=new CostLedgerService(db,budgets);
          await ledger.persistAndApplyRuntimeSettlement(JSON.parse(process.env.PRICING_CHILD_OUTCOME));process.exit(53);
        })().catch(error=>{console.error(error.stack);process.exit(54)});
      `], { cwd: process.cwd(), encoding: 'utf8', timeout: 20000, env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, NODE_OPTIONS: '--max-old-space-size=512', LC_ALL: 'C', TS_NODE_TRANSPILE_ONLY: 'true', PRICING_CHILD_DB: JSON.stringify(source.options), PRICING_CHILD_OUTCOME: JSON.stringify(outcome) } });
      expect(child.error).toBeUndefined(); expect(child.status).toBe(51);
      expect(await phaseFinancial()).toEqual(before);
      expect((await rows())[0].state).toBe('pending');
      expect(await source.query("SELECT * FROM pricing_audit_events WHERE action='cost.outcome_delivered'")).toEqual([]);
      await recover(); await committed();
    }, 30000);

    if (dialect === 'postgres') it('keeps its request fence but not the shared budget lock while preparing the projection', async () => {
      const entered = gate(), resume = gate(), internal = ledger as unknown as Internals;
      const summary = internal.summaryInTransaction.bind(ledger);
      jest.spyOn(internal, 'summaryInTransaction').mockImplementationOnce(async (...args) => { entered.release(); await resume.ready; return summary(...args); });
      const pending = ledger.persistAndApplyRuntimeSettlement(outcome);
      let budgetError: unknown;
      try {
        await entered.ready;
        await expect(source.transaction(manager => manager.createQueryBuilder().select('s.request_id').from('pricing_request_snapshots', 's')
          .where('s.request_id = :id AND s.workspace_id = :workspace', { id: 'request', workspace }).setLock('pessimistic_write').setOnLocked('nowait').getRawOne())).rejects.toMatchObject({ driverError: { code: '55P03' } });
        try {
          await source.transaction(async manager => {
            const rows = await manager.createQueryBuilder().select('rule.id').from(BudgetRule, 'rule').where('rule.workspace_id = :workspace', { workspace })
              .setLock('pessimistic_write').setOnLocked('nowait').getRawMany();
            expect(rows).toHaveLength(1);
          });
        } catch (error) { budgetError = error; }
      } finally { resume.release(); await pending; }
      expect(budgetError).toBeUndefined();
      jest.restoreAllMocks(); await committed();
    });

    it('uses two durable transactions while preserving the default queue-only API', async () => {
      const before = await financial();
      await ledger.persistRuntimeOutcome(outcome);
      expect((await rows())[0].state).toBe('delivered');
      expect((await source.query('SELECT state FROM pricing_settlement_intents'))[0].state).toBe('pending');
      expect((await financial()).budget_rules).toEqual(before.budget_rules);
      const tx = jest.spyOn(source, 'transaction');
      await ledger.persistAndApplyRuntimeSettlement(outcome);
      expect(tx).toHaveBeenCalledTimes(2);
      tx.mockRestore(); await committed();
      expect(await source.query("SELECT * FROM pricing_audit_events WHERE action = 'cost.outcome_delivered'")).toHaveLength(1);
    });

    it('keeps first retention independently visible before any delivery or budget write', async () => {
      const entered = gate(), resume = gate(), internal = ledger as unknown as Internals;
      const deliver = internal.deliverRuntimeOutcome.bind(ledger);
      jest.spyOn(internal, 'deliverRuntimeOutcome').mockImplementationOnce(async (...args) => { entered.release(); await resume.ready; return deliver(...args); });
      const before = await financial();
      const pending = ledger.persistAndApplyRuntimeSettlement(outcome);
      let observer: DataSource | undefined;
      try {
        await entered.ready;
        observer = await new DataSource({ ...source.options, synchronize: false }).initialize();
        expect((await observer.query('SELECT state FROM pricing_runtime_outcomes'))[0].state).toBe('pending');
        expect(await observer.query("SELECT * FROM pricing_audit_events WHERE action = 'cost.outcome_retained'")).toHaveLength(1);
        expect(await financial()).toEqual(before);
      } finally { if (observer?.isInitialized) await observer.destroy(); resume.release(); await pending; }
      await committed();
    });

    it.each(['before_budget', 'after_budget'] as const)('rolls back intent, acknowledgement and money on %s failure but retains replayable evidence', async phase => {
      const before = await financial(), internal = ledger as unknown as Internals;
      const apply = internal.applySettlementInTransaction.bind(ledger);
      const fault = jest.spyOn(internal, 'applySettlementInTransaction').mockImplementationOnce(async (...args) => {
        if (phase === 'after_budget') await apply(...args);
        throw new Error('synthetic composed application failure');
      });
      await expect(ledger.persistAndApplyRuntimeSettlement(outcome)).rejects.toThrow('synthetic composed application failure');
      fault.mockRestore();
      expect(await financial()).toEqual(before);
      expect((await rows())[0]).toMatchObject({ state: 'pending', last_error_code: 'storage_unavailable' });
      expect(JSON.parse((await rows())[0].outcome_json)).toEqual(outcome);
      expect(await source.query("SELECT * FROM pricing_audit_events WHERE action = 'cost.outcome_delivered'")).toHaveLength(0);
      await recover(); const recovered = await financial();
      await ledger.persistAndApplyRuntimeSettlement(outcome);
      await ledger.persistRuntimeOutcome(outcome); await ledger.reconcilePending();
      expect(await financial()).toEqual(recovered);
    });

    it('does not apply money when the mandatory delivery audit fails', async () => {
      const before = await financial(), execute = InsertQueryBuilder.prototype.execute;
      const fault = jest.spyOn(InsertQueryBuilder.prototype, 'execute').mockImplementation(function () {
        const values: Array<{ action?: unknown } | undefined> = Array.isArray(this.expressionMap.valuesSet) ? this.expressionMap.valuesSet : [this.expressionMap.valuesSet];
        if (this.expressionMap.mainAlias?.tablePath === 'pricing_audit_events' && values.some(value => value?.action === 'cost.outcome_delivered')) throw new Error('synthetic acknowledgement audit failure');
        return execute.call(this);
      });
      await expect(ledger.persistAndApplyRuntimeSettlement(outcome)).rejects.toThrow('acknowledgement audit failure');
      fault.mockRestore(); expect(await financial()).toEqual(before);
      expect((await rows())[0].state).toBe('pending'); await recover();
    });

    it('survives a lost acknowledgement after the actual delivery/application commit without double charging', async () => {
      const create = source.createQueryRunner.bind(source); let commits = 0;
      const wrapped = new Set<QueryRunner>();
      const faults: jest.SpyInstance[] = [];
      const factory = jest.spyOn(source, 'createQueryRunner').mockImplementation((...args) => {
        const runner = create(...args);
        // SQLite reuses one runner; wrapping it twice would recurse into the spy.
        if (!wrapped.has(runner)) {
          wrapped.add(runner);
          const commit = runner.commitTransaction.bind(runner);
          faults.push(jest.spyOn(runner, 'commitTransaction').mockImplementation(async () => { await commit(); if (++commits === 2) throw new Error('synthetic lost commit acknowledgement'); }));
        }
        return runner;
      });
      try { await expect(ledger.persistAndApplyRuntimeSettlement(outcome)).rejects.toThrow('lost commit acknowledgement'); }
      finally { factory.mockRestore(); for (const fault of faults) fault.mockRestore(); }
      await committed(); const before = await financial();
      ledger = makeLedger(); await ledger.persistAndApplyRuntimeSettlement(outcome);
      expect(await financial()).toEqual(before);
    });

    it('applies the retained body rather than a caller mutation after the first commit', async () => {
      const original = JSON.parse(JSON.stringify(outcome)) as Settlement;
      const retain = ledger.retainRuntimeOutcome.bind(ledger);
      jest.spyOn(ledger, 'retainRuntimeOutcome').mockImplementationOnce(async (...args) => {
        const row = await retain(...args); outcome.payload.tokens = '99999'; outcome.payload.cost_usd = '99'; return row;
      });
      await ledger.persistAndApplyRuntimeSettlement(outcome); await committed();
      expect(JSON.parse((await rows())[0].outcome_json)).toEqual(original);
    });

    it('serializes duplicate deliveries from independent service instances', async () => {
      await Promise.all(Array.from({ length: 4 }, () => makeLedger().persistAndApplyRuntimeSettlement(structuredClone(outcome))));
      await committed(); expect(await rows()).toHaveLength(1);
      expect(await source.query("SELECT * FROM pricing_audit_events WHERE action = 'cost.outcome_delivered'")).toHaveLength(1);
    });

    it('preserves a differing variant for review and rejects foreign ownership without another debit', async () => {
      await ledger.persistAndApplyRuntimeSettlement(outcome);
      const before = await financial();
      const different = structuredClone(outcome); different.payload.tokens = '2100'; different.payload.cost_usd = '0.0022';
      await expect(ledger.persistAndApplyRuntimeSettlement(different)).rejects.toMatchObject({ status: 409 });
      await expect(ledger.persistAndApplyRuntimeSettlement({ ...outcome, workspace: 'other-workspace' })).rejects.toMatchObject({ status: 404 });
      expect((await rows()).map(row => row.state).sort()).toEqual(['delivered', 'review_required']);
      expect(await financial()).toEqual(before);
    });

    it.each(['async_job', 'actual_upstream'] as const)('does not take over %s ownership', async ownership => {
      if (ownership === 'async_job') await source.createQueryBuilder().update('pricing_reservations').set({ job_id: 'synthetic-job' }).where('id = :id', { id: 'reservation' }).execute();
      else {
        await source.createQueryBuilder().update('pricing_reservations').set({ budget_basis: 'actual_upstream' }).where('id = :id', { id: 'reservation' }).execute();
        outcome.payload.budget_basis = 'actual_upstream';
      }
      const before = await financial();
      await expect(ledger.persistAndApplyRuntimeSettlement(outcome)).rejects.toMatchObject({ status: 409 });
      expect(await financial()).toEqual(before); expect((await rows())[0].state).toBe('review_required');
    });

    it('quarantines a physical batch share instead of independently applying its logical hold', async () => {
      const allocation = allocateBatchCost('synthetic-physical-batch', cost, [{
        request_id: 'request', reservation_id: 'reservation', input_start: 0,
        input_count: 1, weight: '1', weight_basis: 'token_input_count',
      }]);
      outcome.payload.receipt = { attemptId: 'attempt', cost: batchShareCost(allocation, 0, 'synthetic-physical-attempt'), errorCode: null };
      const before = await financial();
      await expect(ledger.persistAndApplyRuntimeSettlement(outcome)).rejects.toMatchObject({ status: 409 });
      expect(await financial()).toEqual(before);
      expect((await rows())[0]).toMatchObject({ state: 'review_required' });
      expect(JSON.parse((await rows())[0].outcome_json)).toEqual(outcome);
    });

    it('fences a paused composed delivery after an operator rejects its retained body', async () => {
      // Review cannot override a live owner's lease; this is a delayed retry
      // from an expired owner, not a way to dispose an active request.
      await source.createQueryBuilder().update('pricing_reservations').set({ lease_until: new Date(Date.now() - 60000).toISOString() }).where('id = :id', { id: 'reservation' }).execute();
      const entered = gate(), resume = gate(), internal = ledger as unknown as Internals;
      const apply = internal.applyRuntimeSettlement.bind(ledger);
      jest.spyOn(internal, 'applyRuntimeSettlement').mockImplementationOnce(async row => { entered.release(); await resume.ready; return apply(row); });
      const pending = ledger.persistAndApplyRuntimeSettlement(outcome).then(() => null, error => error as Error);
      try {
        await entered.ready; await ledger.archiveRuntimeOutcome(outcome);
        const id = runtimeOutcomeDocument(outcome).id, basis = await ledger.outcomeDispositionBasis(id, workspace);
        expect(basis.blocked_reason).toBeNull();
        await new PricingOutcomeDispositionService(ledger, prices).dispose(actor, id, { id: 'synthetic-rejection', action: 'reject_evidence', expected_basis_hash: basis.basis_hash, expected_outcome_hash: basis.outcome_hash, reason: 'Synthetic rejected evidence', confirm: true }, false);
      } finally { resume.release(); }
      expect(await pending).toMatchObject({ status: 409 });
      expect(await source.query('SELECT * FROM pricing_settlement_intents')).toEqual([]);
      expect((await ledger.summary('request', workspace))?.budget_reserved_usd).toBe('0.500000000000000000');
    });

    it('rolls back a stale delivery when its evidence was quarantined without a disposition', async () => {
      const entered = gate(), resume = gate(), internal = ledger as unknown as Internals;
      const apply = internal.applyRuntimeSettlement.bind(ledger), before = await financial();
      jest.spyOn(internal, 'applyRuntimeSettlement').mockImplementationOnce(async row => { entered.release(); await resume.ready; return apply(row); });
      const pending = ledger.persistAndApplyRuntimeSettlement(outcome).then(() => null, error => error as Error);
      try { await entered.ready; await ledger.archiveRuntimeOutcome(outcome); }
      finally { resume.release(); }
      expect(await pending).toMatchObject({ status: 409 });
      expect((await rows())[0].state).toBe('review_required');
      expect(await financial()).toEqual(before);
      expect(await source.query("SELECT * FROM pricing_audit_events WHERE action = 'cost.outcome_delivered'")).toHaveLength(0);
    });

    it('keeps legacy estimated budget policy distinct from an unknown supplier cost', async () => {
      const missing: CostComputation = { ...cost, status: 'missing_usage', evidence_status: 'incomplete', amount: null, known_subtotal: null, report_amount: null, report_known_subtotal: null, rounding_adjustment: null, report_rounding_adjustment: null, lines: [], diagnostics: [{ code: 'pricing_dimension_missing', path: 'usage', message: 'Synthetic missing usage' }] };
      outcome.payload.receipt = { attemptId: 'attempt', cost: missing, errorCode: null };
      outcome.payload.cost_usd = '0.5'; outcome.payload.budget_basis = 'reserved_estimate_missing_usage';
      await ledger.persistAndApplyRuntimeSettlement(outcome);
      expect(await ledger.summary('request', workspace)).toMatchObject({ amount: null, status: 'missing_usage', budget_committed_usd: '0.500000000000000000', unknown_attempts: 1 });
    });

    it('releases an explicitly authorized logical hold without fabricating a free supplier receipt', async () => {
      outcome.payload = { kind: 'release', tokens: '0', cost_usd: '0', budget_basis: 'legacy_logical', receipt: null };
      await ledger.persistAndApplyRuntimeSettlement(outcome);
      expect(await ledger.summary('request', workspace)).toMatchObject({ amount: null, status: 'pending', budget_reserved_usd: '0.000000000000000000' });
      expect((await source.query('SELECT state FROM pricing_reservations'))[0].state).toBe('released');
    });

    it('rejects a non-settlement outcome before retention', async () => {
      const before = await financial();
      await expect(ledger.persistAndApplyRuntimeSettlement({ type: 'attempt', workspace, reservationId: 'reservation', attemptId: 'attempt', cost, errorCode: null } as never)).rejects.toMatchObject({ status: 409 });
      expect(await rows()).toEqual([]); expect(await financial()).toEqual(before);
    });

    it.each(['after_retention', 'before_commit'] as const)('recovers an actual isolated process exit %s', async phase => {
      const before = await financial();
      const child = spawnSync(process.execPath, ['-r', require.resolve('ts-node/register'), '-e', `
        require('reflect-metadata');
        const {DataSource}=require('typeorm');
        const {BudgetRule}=require('./src/database/entities/budget-rule.entity');
        const {CallLog}=require('./src/database/entities/call-log.entity');
        const {BudgetService}=require('./src/budget/budget.service');
        const {WorkspaceContextService}=require('./src/workspaces/workspace-context.service');
        const {CostLedgerService}=require('./src/pricing/cost-ledger.service');
        (async()=>{
          const db=await new DataSource({...JSON.parse(process.env.PRICING_CHILD_DB),entities:[BudgetRule,CallLog],synchronize:false}).initialize();
          const ledger=new CostLedgerService(db,new BudgetService({},new WorkspaceContextService(),db.getRepository(BudgetRule)));
          if(process.env.PRICING_CHILD_PHASE==='after_retention') ledger.applyRuntimeSettlement=async()=>process.exit(17);
          else {const apply=ledger.applySettlementInTransaction.bind(ledger);ledger.applySettlementInTransaction=async(...args)=>{await apply(...args);process.exit(18);};}
          await ledger.persistAndApplyRuntimeSettlement(JSON.parse(process.env.PRICING_CHILD_OUTCOME));process.exit(19);
        })().catch(error=>{console.error(error.stack);process.exit(20)});
      `], { cwd: process.cwd(), encoding: 'utf8', timeout: 20000, env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, NODE_OPTIONS: '--max-old-space-size=512', LC_ALL: 'C', TS_NODE_TRANSPILE_ONLY: 'true', PRICING_CHILD_DB: JSON.stringify(source.options), PRICING_CHILD_PHASE: phase, PRICING_CHILD_OUTCOME: JSON.stringify(outcome) } });
      expect(child.error).toBeUndefined(); expect(child.status).toBe(phase === 'after_retention' ? 17 : 18);
      expect(await financial()).toEqual(before); expect((await rows())[0].state).toBe('pending');
      expect(JSON.parse((await rows())[0].outcome_json)).toEqual(outcome);
      await recover(); await ledger.persistAndApplyRuntimeSettlement(outcome); await committed();
    }, 30000);
  });
}

import { readRequestLogSnapshot } from '../../src/pricing/request-log-snapshot';
import { readCostAdjustmentHistory } from '../../src/pricing/cost-adjustment-history';
import type { CostAttemptRow, CostReservationRow } from '../../src/pricing/cost-ledger.types';
import { DataSource, Repository, type EntityManager } from 'typeorm';
import { pricingContentHash } from '../../src/pricing/pricing-json';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BudgetRule } from '../../src/database/entities/budget-rule.entity';
import { CallLog } from '../../src/database/entities/call-log.entity';
import { BudgetService } from '../../src/budget/budget.service';
import { WorkspaceContextService } from '../../src/workspaces/workspace-context.service';
import { DEFAULT_WORKSPACE_ID } from '../../src/workspaces/workspace.constants';
import { PricingRepository } from '../../src/pricing/pricing-repository';
import { CostLedgerService } from '../../src/pricing/cost-ledger.service';
import { PricingRuntimeService } from '../../src/pricing/pricing-runtime.service';
import { applyPricingSchema } from '../../src/pricing/pricing-schema';
import type { CostComputation } from '../../src/pricing/pricing.types';
import { makeRequest, mockConfigService } from '../helpers';
import { tokenBook, tokens } from './pricing-fixtures';

const workspace = DEFAULT_WORKSPACE_ID;
const target = { node_id: 'synthetic-node', model: 'synthetic-model' };
const pgUrl = process.env.SIFTGATE_PRICING_TEST_POSTGRES_URL;
if (pgUrl) {
  const url = new URL(pgUrl);
  if (url.hostname !== '127.0.0.1' || url.port === '2099' || !/^\/pricing_goal_[a-z0-9_]+$/.test(url.pathname))
    throw new Error('Use an isolated PostgreSQL projection test database');
}

for (const dialect of ['better-sqlite3', 'postgres'] as const) {
  const suite = dialect === 'postgres' && !pgUrl ? describe.skip : describe;
  suite(`owned call-log projection (${dialect})`, () => {
    let source: DataSource, admin: DataSource | undefined, directory: string | undefined, schema: string;
    let prices: PricingRepository, ledger: CostLedgerService, runtime: PricingRuntimeService;
    beforeEach(async () => {
      if (dialect === 'postgres') {
        schema = `log_projection_${randomUUID().replaceAll('-', '')}`;
        admin = await new DataSource({ type: 'postgres', url: pgUrl }).initialize();
        await admin.query(`CREATE SCHEMA "${schema}"`);
        source = new DataSource({ type: 'postgres', url: pgUrl, schema, extra: { options: `-c search_path=${schema}`, max: 4 }, entities: [CallLog, BudgetRule], synchronize: true });
      } else {
        directory = mkdtempSync(join(tmpdir(), 'log-projection-'));
        source = new DataSource({ type: dialect, database: join(directory, 'test.sqlite'), entities: [CallLog, BudgetRule], synchronize: true });
      }
      await source.initialize(); await applyPricingSchema(source);
      const config = mockConfigService({ modelsPricing: {}, nodes: [], database: { type: dialect === 'postgres' ? 'postgres' : 'sqlite', path: ':memory:' } });
      const rules = source.getRepository(BudgetRule);
      await rules.save(rules.create({ workspace_id: workspace, type: 'daily_cost', limit_value: 100, current_value: 0, alert_threshold: .8, period_start: new Date(), is_active: true }));
      ledger = new CostLedgerService(source, new BudgetService(config, new WorkspaceContextService(), rules));
      prices = new PricingRepository(source);
      const actor = { id: 'synthetic-operator', workspace_id: workspace, role: 'admin' as const, global_admin: true };
      const created = await prices.createBook(actor, { name: 'Synthetic log projection', scope: 'workspace', content: tokenBook() });
      await prices.publishDraft(actor, created.draft.id, { draft_revision: 1, catalog_revision: 0, reason: 'Synthetic log fixture', confirm: true, targets: [{ level: 'model', model: target.model }] });
      runtime = new PricingRuntimeService(prices, ledger, config, {} as never);
    });
    afterEach(async () => {
      jest.restoreAllMocks();
      if (source?.isInitialized) await source.destroy();
      if (admin?.isInitialized) { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.destroy(); }
      if (directory) rmSync(directory, { recursive: true, force: true });
    });
    const log = (request = 'request', scope: string | null = workspace) => source.getRepository(CallLog).create({
      request_id: request, workspace_id: scope, source_format: 'chat_completions', tier: 'standard', score: 0,
      node_id: target.node_id, model: target.model, cost_usd: 99, cost_without_cache_usd: 99,
    });
    const owned = <T>(action: () => Promise<T>) => runtime.runRequest('request', makeRequest('synthetic', { originalModel: target.model }), workspace, async () => {
      await runtime.admit(); return action();
    });
    async function receipt(missing = false) {
      const snapshot = await prices.capture({ request_id: 'request', workspace_id: workspace, report_currency: 'USD' });
      const estimate = snapshot!.quote(target, tokens({ input_tokens: 1000, output_tokens: 500 })).cost;
      await ledger.reserve({ id: 'reservation', requestId: 'request', identity: { workspaceId: workspace, apiKeyName: null, apiKeyId: null, namespaceId: null, teamId: null }, target, estimate, tokens: '1500', costUsd: estimate.report_amount!, budgetBasis: 'legacy_logical', leaseOwner: 'synthetic-owner', leaseUntil: new Date(Date.now() + 60000).toISOString() });
      await ledger.beginAttempt({ id: 'attempt', requestId: 'request', workspace, reservationId: 'reservation', target, feeSource: 'provider', dispatchedAt: new Date().toISOString(), priceContext: { context: {}, legacyPrice: null } });
      const cost: CostComputation = missing ? { ...estimate, status: 'missing_usage', evidence_status: 'incomplete', amount: null, known_subtotal: null, report_amount: null, report_known_subtotal: null, rounding_adjustment: null, report_rounding_adjustment: null, lines: [], diagnostics: [{ code: 'pricing_dimension_missing', path: 'usage', message: 'Synthetic missing usage' }] } : estimate;
      await ledger.completeAttempt('attempt', workspace, cost);
      return cost;
    }

    const usage = { input_tokens: 1000, output_tokens: 500 };
    async function dispatch(canonical: ReturnType<typeof makeRequest>) {
      return runtime.forward(canonical, target, async observer => {
        await observer!.begin({ node_id: target.node_id, wire_model: target.model, credential_id: 'synthetic-credential',
          credential_strategy: 'single', credential_retry_index: 0, compatibility_retry_index: 0, dispatch_index: 0,
          protocol: canonical.metadata.source_format, dispatched_at: new Date().toISOString() });
        return { usage, model: target.model };
      });
    }

    it('joins only the captured unclosed PostgreSQL group and returns the committed log projection', async () => {
      const canonical = makeRequest('synthetic', { originalModel: target.model, maxTokens: 500 });
      await runtime.runRequest('request', canonical, workspace, async () => {
        await runtime.admit(); const reservation = await runtime.reserve(canonical, target, usage, 1);
        await dispatch(canonical);
        expect(runtime.canJoinLogSettlement('wrong-request', workspace, target, reservation)).toBe(false);
        expect(runtime.canJoinLogSettlement('request', 'foreign', target, reservation)).toBe(false);
        expect(runtime.canJoinLogSettlement('request', workspace, { ...target, model: 'other' }, reservation)).toBe(false);
        expect(runtime.canJoinLogSettlement('request', workspace, target, reservation)).toBe(dialect === 'postgres');
        const input = { call: log() };
        const result = await runtime.budgetResultWithLogs(canonical, usage, target, reservation, input);
        if (dialect === 'postgres') {
          expect(result?.budget).toEqual({ totalTokens: 1500, costUsd: .002 });
          expect(result?.saved?.cost_usd).toBeCloseTo(.002, 10);
          expect(input.call.id).toBe(result?.saved?.id);
          expect(await source.getRepository(CallLog).count()).toBe(1);
          expect(runtime.canJoinLogSettlement('request', workspace, target, reservation)).toBe(false);
        } else {
          expect(result).toBeNull(); expect(input.call.id).toBeUndefined();
          await runtime.budgetResult(canonical, usage, target, reservation);
        }
      });
      expect((await ledger.summary('request', workspace))?.budget_committed_usd).toBe('0.002000000000000000');
      expect(runtime.canJoinLogSettlement('request', workspace, target, null)).toBe(false);
    });

    it('does not let a joined log request frame leak into an unrelated later settlement', async () => {
      for (const request of ['request', 'other-request']) {
        const canonical = makeRequest('synthetic', { originalModel: target.model, maxTokens: 500 });
        await runtime.runRequest(request, canonical, workspace, async () => {
          await runtime.admit(); const reservation = await runtime.reserve(canonical, target, usage, 1); await dispatch(canonical);
          if (request === 'request') {
            const joined = await runtime.budgetResultWithLogs(canonical, usage, target, reservation, { call: log(request) });
            if (!joined) await runtime.budgetResult(canonical, usage, target, reservation);
          } else await runtime.budgetResult(canonical, usage, target, reservation);
        });
      }
      expect(await source.getRepository(CallLog).count()).toBe(dialect === 'postgres' ? 1 : 0);
      expect(await source.getRepository(CallLog).countBy({ request_id: 'other-request' })).toBe(0);
      expect(await source.query("SELECT * FROM pricing_budget_effects WHERE kind='commit'")).toHaveLength(2);
    });

    it('joins synchronous receipts without returning before settlement', async () => {
      const canonical = makeRequest('synthetic', { originalModel: target.model, maxTokens: 500 });
      const complete = jest.spyOn(ledger, 'completeAttempt');
      await runtime.runRequest('request', canonical, workspace, async () => {
        await runtime.admit();
        const reservation = await runtime.reserve(canonical, target, usage, 1);
        expect(reservation).not.toBeNull();
        await dispatch(canonical);
        const retained = await source.query('SELECT * FROM pricing_runtime_outcomes');
        expect(retained).toHaveLength(1);
        expect(retained[0].state).toBe('pending');
        expect(await source.query("SELECT * FROM pricing_budget_effects WHERE kind = 'commit'")).toEqual([]);
        await runtime.budgetResult(canonical, usage, target, reservation);
        expect((await source.query('SELECT state FROM pricing_runtime_outcomes')).every((row: { state: string }) => row.state === 'delivered')).toBe(true);
        expect(await source.query("SELECT * FROM pricing_budget_effects WHERE kind = 'commit'")).toHaveLength(1);
        await runtime.persistCallLogs([log()], true);
      });
      expect(complete).not.toHaveBeenCalled();
      expect((await source.getRepository(CallLog).findOneByOrFail({ request_id: 'request' })).cost_usd).toBe(.002);
      expect((await ledger.summary('request', workspace))?.budget_committed_usd).toBe('0.002000000000000000');
      await runtime.waitForRequests();
    });

    it('drains an independently retained synchronous receipt when the caller fails before settlement', async () => {
      const canonical = makeRequest('synthetic', { originalModel: target.model, maxTokens: 500 });
      await expect(runtime.runRequest('request', canonical, workspace, async () => {
        await runtime.admit(); await runtime.reserve(canonical, target, usage, 1);
        await dispatch(canonical);
        throw new Error('synthetic pre-response hook failure');
      })).rejects.toThrow('pre-response hook');
      expect((await source.query('SELECT state FROM pricing_runtime_outcomes')).every((row: { state: string }) => row.state === 'delivered')).toBe(true);
      expect((await ledger.summary('request', workspace))?.known_subtotal).toBe('0.002000000000000000');
      expect(await source.query("SELECT * FROM pricing_budget_effects WHERE kind = 'commit'")).toEqual([]);
      await runtime.waitForRequests();
    });

    it('delivers receipts standalone after a joint settlement failure and later replays money exactly once', async () => {
      const canonical = makeRequest('synthetic', { originalModel: target.model, maxTokens: 500 });
      const failure = jest.spyOn(ledger, 'persistAndApplyRuntimeSettlement').mockRejectedValueOnce(new Error('synthetic settlement unavailable'));
      await runtime.runRequest('request', canonical, workspace, async () => {
        await runtime.admit(); const reservation = await runtime.reserve(canonical, target, usage, 1);
        await dispatch(canonical);
        await runtime.budgetResult(canonical, usage, target, reservation);
      });
      failure.mockRestore();
      expect((await ledger.summary('request', workspace))?.known_subtotal).toBe('0.002000000000000000');
      expect(await source.query("SELECT * FROM pricing_budget_effects WHERE kind = 'commit'")).toEqual([]);
      await runtime.flushPendingOutcomes(new Date(Date.now() + 120000), true);
      expect(await source.query("SELECT * FROM pricing_budget_effects WHERE kind = 'commit'")).toHaveLength(1);
      expect((await ledger.summary('request', workspace))?.budget_committed_usd).toBe('0.002000000000000000');
    });

    it('drains the prior receipt before another dispatch and joins only the final receipt', async () => {
      const canonical = makeRequest('synthetic', { originalModel: target.model, maxTokens: 500 });
      const complete = jest.spyOn(ledger, 'completeAttempt');
      await runtime.runRequest('request', canonical, workspace, async () => {
        await runtime.admit(); const reservation = await runtime.reserve(canonical, target, usage, 2);
        await dispatch(canonical); await dispatch(canonical);
        const retained = await source.query('SELECT state FROM pricing_runtime_outcomes');
        expect(retained).toHaveLength(2);
        expect(retained.filter((row: { state: string }) => row.state === 'delivered')).toHaveLength(1);
        expect(retained.filter((row: { state: string }) => row.state === 'pending')).toHaveLength(1);
        await runtime.budgetResult(canonical, usage, target, reservation);
      });
      expect(complete).toHaveBeenCalledTimes(1);
      expect((await ledger.summary('request', workspace))).toMatchObject({ known_subtotal: '0.004000000000000000', budget_committed_usd: '0.002000000000000000' });
      expect((await source.query('SELECT state FROM pricing_runtime_outcomes')).every((row: { state: string }) => row.state === 'delivered')).toBe(true);
    });

    it('requires the admitted matching context and preserves legacy logging outside it', async () => {
      expect(runtime.ownsLogContext('request', workspace)).toBe(false);
      await expect(runtime.persistCallLogs([log()], true)).rejects.toThrow('captured request context');
      await runtime.runRequest('request', makeRequest('synthetic'), workspace, async () => {
        expect(runtime.ownsLogContext('request', workspace)).toBe(false);
        await expect(runtime.persistCallLogs([log()], true)).rejects.toThrow('captured request context');
      });
      await owned(async () => {
        expect(runtime.ownsLogContext('request', workspace)).toBe(true);
        expect(runtime.ownsLogContext('other', workspace)).toBe(false);
        expect(runtime.ownsLogContext('request', 'other-workspace')).toBe(false);
        await expect(runtime.persistCallLogs([log('other')], true)).rejects.toThrow('captured request context');
        await expect(runtime.persistCallLogs([log('request', 'other-workspace')], true)).rejects.toThrow('captured request context');
      });
      const saved = await ledger.persistCallLogs([log('legacy')]);
      expect(saved?.[0].cost_usd).toBe(99);
    });

    it('requires a real snapshot rather than writing a caller-supplied cost placeholder', async () => {
      await expect(ledger.persistCallLogs([log('missing')], true)).rejects.toThrow();
      expect(await source.getRepository(CallLog).count()).toBe(0);
    });

    it('uses zero only for a captured request with no attempts and no reservations', async () => {
      await owned(async () => {
        const saved = await runtime.persistCallLogs([log('request', null)], true);
        expect(saved?.[0]).toMatchObject({ cost_usd: 0, cost_without_cache_usd: null });
      });
      expect(await source.getRepository(CallLog).count()).toBe(1);
    });

    it('projects the verified receipt once under the request lock, not the log input price', async () => {
      const cost = await receipt();
      const read = jest.spyOn(ledger as unknown as { summaryInTransaction: (...args: unknown[]) => Promise<unknown> }, 'summaryInTransaction');
      await owned(async () => {
        const saved = await runtime.persistCallLogs([log()], true);
        expect(saved?.[0].cost_usd).toBe(Number(cost.report_amount));
        expect(saved?.[0].cost_without_cache_usd).toBeNull();
      });
      expect(read).toHaveBeenCalledTimes(1);
      expect((await source.getRepository(CallLog).findOneByOrFail({ request_id: 'request' })).cost_usd).toBeCloseTo(Number(cost.report_amount), 8);
    });

    it('numeric log subtotal omits display-only intent/case reads while detailed reports retain them', async () => {
      const cost = await receipt();
      await ledger.queueSettlement('reservation', workspace, 'commit', '1500', cost.report_amount!, 'legacy_logical', { attemptId: 'attempt', cost });
      const now = new Date().toISOString();
      await source.createQueryBuilder().insert().into('pricing_recovery_cases').values({ reservation_id: 'reservation', request_id: 'request', workspace_id: workspace,
        state: 'open', reason: 'settlement_decision_missing', revision: 1, evidence_json: '{}', evidence_hash: pricingContentHash({}), created_at: now, updated_at: now, checked_at: now,
        resolved_at: null, resolution_code: null }).execute();
      const before = await ledger.summary('request', workspace);
      expect(before!.reservations[0]).toMatchObject({ settlement_status: 'pending', recovery_case: { state: 'open' } });
      const queries = jest.spyOn(source.logger, 'logQuery');
      const saved = await ledger.persistCallLogs([log()], true);
      const displayReads = queries.mock.calls.map(([sql]) => sql).filter(sql => sql.startsWith('SELECT') && /FROM "pricing_(settlement_intents|recovery_cases)"/.test(sql));
      expect(displayReads).toEqual([]);
      expect(saved![0].cost_usd).toBe(Number(before!.known_subtotal));
      queries.mockRestore(); expect(await ledger.summary('request', workspace)).toEqual(before);
    });

    it('numeric log subtotal has an explicit compact result and never substitutes it for a detailed report', async () => {
      await receipt();
      const reader = ledger as unknown as { summaryInTransaction(manager: EntityManager, id: string, workspace: string, mode?: string): Promise<unknown> };
      const compact = await source.transaction(manager => reader.summaryInTransaction(manager, 'request', workspace, 'log'));
      expect(compact).toEqual({ known_subtotal: '0.002000000000000000' });
      expect(await ledger.summary('request', workspace)).toMatchObject({ amount: '0.002000000000000000', attempts: [{ id: 'attempt' }], reservations: [{ id: 'reservation' }] });
    });

    it.each([
      ['pricing_attempts', 'cost_hash', 'corrupt'],
      ['pricing_attempts', 'cost_json', '{'],
      ['pricing_attempts', 'price_context_json', '{'],
      ['pricing_reservations', 'estimate_json', '{'],
      ['pricing_reservations', 'reserved_cost_usd', 'invalid-decimal'],
    ])('numeric log subtotal retains rejection of corrupt %s.%s evidence', async (table, column, value) => {
      await receipt();
      const before = await source.query('SELECT * FROM budget_rules ORDER BY id');
      await source.createQueryBuilder().update(table).set({ [column]: value }).execute();
      await expect(ledger.summary('request', workspace)).rejects.toThrow();
      await expect(ledger.persistCallLogs([log()], true)).rejects.toThrow();
      expect(await source.getRepository(CallLog).count()).toBe(0);
      expect(await source.query('SELECT * FROM budget_rules ORDER BY id')).toEqual(before);
    });

    it('numeric log subtotal re-reads corrections in later transactions and rejects a broken application chain', async () => {
      const cost = await receipt();
      await ledger.settle('reservation', workspace, 'commit', '1500', cost.report_amount!, 'legacy_logical', { attemptId: 'attempt', cost });
      const saved = (await ledger.persistCallLogs([log()], true))![0];
      const snapshot = await prices.restoreRequest('request', workspace);
      const replacement = snapshot.quote(target, tokens({ input_tokens: 3000, output_tokens: 500 })).cost;
      await ledger.adjustAttempt({ id: 'projection-correction', workspace, attemptId: 'attempt', actorId: 'synthetic-operator', source: 'provider_usage', reason: 'Synthetic correction', expectedCostHash: pricingContentHash(cost), cost: replacement });
      const summary = await ledger.summary('request', workspace);
      const next = (await ledger.persistCallLogs([{ ...saved, cost_usd: 99 }], true))![0];
      expect(next.cost_usd).toBe(Number(summary!.known_subtotal));
      expect(next.cost_usd).toBe(.004);
      await source.createQueryBuilder().update('pricing_adjustment_applications').set({ application_hash: 'invalid' }).where('adjustment_id = :id', { id: 'projection-correction' }).execute();
      await expect(ledger.persistCallLogs([{ ...saved, cost_usd: 99 }], true)).rejects.toThrow('integrity');
      expect((await source.getRepository(CallLog).findOneByOrFail({ id: saved.id })).cost_usd).toBe(.004);
    });

    it('keeps a missing-usage fee unknown and its hold unchanged after projecting the numeric log subtotal', async () => {
      await receipt(true);
      const before = await ledger.summary('request', workspace);
      await owned(() => runtime.persistCallLogs([log()], true));
      const after = await ledger.summary('request', workspace);
      expect(after).toEqual(before);
      expect(after).toMatchObject({ amount: null, status: 'missing_usage', unknown_attempts: 1 });
      expect(after?.budget_reserved_usd).not.toBe('0.000000000000000000');
      expect((await source.getRepository(CallLog).findOneByOrFail({ request_id: 'request' })).cost_usd).toBe(0);
    });

    it('rejects corrupted receipts without publishing the placeholder or changing the budget', async () => {
      await receipt();
      const budgets = await source.query('SELECT * FROM budget_rules ORDER BY id');
      await source.createQueryBuilder().update('pricing_attempts').set({ cost_hash: 'synthetic-corruption' }).where('id = :id', { id: 'attempt' }).execute();
      await owned(async () => { await expect(runtime.persistCallLogs([log()], true)).rejects.toThrow('integrity'); });
      expect(await source.getRepository(CallLog).count()).toBe(0);
      expect(await source.query('SELECT * FROM budget_rules ORDER BY id')).toEqual(budgets);
    });

    it('does not fall back to unpriced storage when the captured projection becomes unavailable', async () => {
      await owned(async () => {
        const available = jest.spyOn(ledger, 'available').mockResolvedValueOnce(false);
        try { await expect(runtime.persistCallLogs([log()], true)).rejects.toThrow('unavailable'); }
        finally { available.mockRestore(); }
      });
      expect(await source.getRepository(CallLog).count()).toBe(0);
    });

    it('rolls back a log-save failure without modifying receipts or releasing the hold', async () => {
      await receipt();
      const before = await ledger.summary('request', workspace);
      const save = Repository.prototype.save;
      const fault = jest.spyOn(Repository.prototype, 'save').mockImplementation(function (this: Repository<CallLog>, ...args: Parameters<typeof save>) {
        if (this.metadata.target === CallLog) return Promise.reject(new Error('synthetic log save failure'));
        return save.apply(this, args);
      });
      try { await owned(async () => { await expect(runtime.persistCallLogs([log()], true)).rejects.toThrow('synthetic log save failure'); }); }
      finally { fault.mockRestore(); }
      expect(await source.getRepository(CallLog).count()).toBe(0);
      expect(await ledger.summary('request', workspace)).toEqual(before);
    });
    if (dialect === 'postgres') {
      it('one fresh request snapshot matches all prior row reads and adjustment validation without writing anything', async () => {
        const cost = await receipt();
        await ledger.settle('reservation', workspace, 'commit', '1500', cost.report_amount!, 'legacy_logical', { attemptId: 'attempt', cost });
        const snapshot = await prices.restoreRequest('request', workspace);
        const corrected = snapshot.quote(target, tokens({ input_tokens: 3000, output_tokens: 500 })).cost;
        await ledger.adjustAttempt({ id: 'snapshot-adjustment', workspace, attemptId: 'attempt', actorId: 'synthetic-operator', source: 'provider_usage', reason: 'Synthetic snapshot parity', expectedCostHash: pricingContentHash(cost), cost: corrected });
        await source.transaction(async manager => {
          await manager.createQueryBuilder().select('s.request_id').from('pricing_request_snapshots', 's').where('s.request_id=:id AND s.workspace_id=:workspace', { id: 'request', workspace }).setLock('pessimistic_write').getRawOne();
          const spy = jest.spyOn(source.logger, 'logQuery');
          const combined = await readRequestLogSnapshot(manager, 'request', workspace);
          expect(spy.mock.calls).toHaveLength(1);
          expect(spy.mock.calls[0][0].match(/UNION ALL/g)).toHaveLength(3);
          spy.mockRestore();
          const attempts = await manager.createQueryBuilder().select('a.*').from('pricing_attempts', 'a').where('a.request_id=:id AND a.workspace_id=:workspace', { id: 'request', workspace }).orderBy('a.dispatched_at', 'ASC').addOrderBy('a.id', 'ASC').getRawMany<CostAttemptRow>();
          const reservations = await manager.createQueryBuilder().select('r.*').from('pricing_reservations', 'r').where('r.request_id=:id AND r.workspace_id=:workspace', { id: 'request', workspace }).getRawMany<CostReservationRow>();
          const history = await readCostAdjustmentHistory(manager, 'request', workspace, attempts);
          expect(combined).toEqual({ attempts, reservations, history });
          expect(combined.history.get('attempt')?.[0].application.revision).toBe(1);
          expect(combined.history.get('attempt')?.[0].cost.report_amount).toBe('0.004000000');
        });
      });

      it('keeps unknown request/foreign workspace reads empty and binds request text rather than interpolating it', async () => {
        await receipt();
        await source.transaction(async manager => {
          for (const [request, scope] of [["request' OR 1=1 --", workspace], ['request', 'foreign-workspace']]) {
            expect(await readRequestLogSnapshot(manager, request, scope)).toEqual({ attempts: [], reservations: [], history: new Map() });
          }
        });
        await expect(readRequestLogSnapshot(source.manager, 'request', workspace)).rejects.toMatchObject({ status: 409 });
      });
    }
  });
}

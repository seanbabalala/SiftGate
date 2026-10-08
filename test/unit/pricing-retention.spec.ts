import { Logger } from '@nestjs/common';
import { DataSource, DeleteQueryBuilder, type ObjectLiteral } from 'typeorm';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BudgetService } from '../../src/budget/budget.service';
import { DashboardController } from '../../src/dashboard/dashboard.controller';
import { BudgetRule, CallLog, RouteDecisionLog } from '../../src/database/entities';
import { WorkspaceContextService } from '../../src/workspaces/workspace-context.service';
import { CostLedgerService } from '../../src/pricing/cost-ledger.service';
import { CostReportService } from '../../src/pricing/cost-report.service';
import { PricingRepository } from '../../src/pricing/pricing-repository';
import { applyPricingSchema, PRICING_TABLE_NAMES, removeEmptyPricingSchema } from '../../src/pricing/pricing-schema';
import type { PricingOutcome } from '../../src/pricing/pricing-outcome-retry';
import { mockConfigService } from '../helpers';
import { tokenBook, tokens } from './pricing-fixtures';

const workspace = 'default-workspace';
const actor = { id: 'synthetic-retention-admin', workspace_id: workspace, role: 'admin' as const, global_admin: true };
const target = { node_id: 'synthetic-node', model: 'synthetic-model' };
const identity = { workspaceId: workspace, apiKeyName: null, apiKeyId: null, namespaceId: null, teamId: null };
const entities = [BudgetRule, CallLog, RouteDecisionLog];
type Fixture = { source: DataSource; cleanup: () => Promise<void> };

function retentionContract(label: string, connect: () => Promise<Fixture>, run = describe) {
  run(label, () => {
    let source: DataSource, cleanup: Fixture['cleanup'], prices: PricingRepository, ledger: CostLedgerService;
    let originalBook: string, originalVersion: string;
    const config = mockConfigService({ database: { log_retention_days: 1 } });
    const publication = (revision: number) => ({ draft_revision: 1, catalog_revision: revision,
      reason: 'Synthetic retention fixture', confirm: true as const, targets: [{ level: 'model' as const, model: target.model }] });
    const makeLedger = () => new CostLedgerService(source, new BudgetService(config, new WorkspaceContextService(), source.getRepository(BudgetRule)));
    beforeEach(async () => {
      ({ source, cleanup } = await connect());
      await applyPricingSchema(source);
      await source.getRepository(BudgetRule).save({ workspace_id: workspace, type: 'daily_cost', limit_value: 100,
        current_value: 0, alert_threshold: 0.8, period_start: new Date(), is_active: true });
      prices = new PricingRepository(source); ledger = makeLedger();
      const book = await prices.createBook(actor, { name: 'Original synthetic rates', scope: 'workspace', content: tokenBook() });
      const published = await prices.publishDraft(actor, book.draft.id, publication(0));
      originalBook = book.book.id; originalVersion = published.version_id;
      jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No supplier access in retention tests'));
    });
    afterEach(async () => {
      jest.restoreAllMocks();
      if (source?.isInitialized) await source.destroy();
      await cleanup?.();
    });
    async function snapshot(includeLogs = false) {
      const rows: Record<string, unknown> = {};
      for (const table of [...PRICING_TABLE_NAMES, 'budget_rules', ...(includeLogs ? ['call_logs', 'route_decisions'] : [])]) {
        const values: unknown[] = await source.query(`SELECT * FROM "${table}"`);
        rows[table] = values.map(value => JSON.stringify(value)).sort();
      }
      return rows;
    }
    const cleanupLogs = () => Object.assign(Object.create(DashboardController.prototype) as { cleanupOldLogs(): Promise<void> }, {
      config, callLogRepo: source.getRepository(CallLog), routeDecisionRepo: source.getRepository(RouteDecisionLog),
      cleanupStopped: false, logger: new Logger('SyntheticRetention'),
    }).cleanupOldLogs();
    async function seed(id: string, state: 'committed' | 'retained' | 'intent' | 'orphan' = 'committed') {
      const frozen = (await prices.capture({ request_id: id, workspace_id: workspace, report_currency: 'USD' }))!;
      const cost = frozen.quote(target, tokens({ input_tokens: 1000, output_tokens: 100 })).cost;
      await ledger.reserve({ id: `hold-${id}`, requestId: id, identity, target, estimate: cost, tokens: '1100', costUsd: '0.5',
        budgetBasis: 'legacy_logical', leaseOwner: 'synthetic-retention', leaseUntil: new Date(Date.now() - 60000).toISOString() });
      await ledger.beginAttempt({ id: `attempt-${id}`, requestId: id, workspace, reservationId: `hold-${id}`, target,
        feeSource: 'provider', dispatchedAt: new Date().toISOString(), priceContext: { context: {}, legacyPrice: null } });
      const attempt: PricingOutcome = { type: 'attempt', workspace, reservationId: `hold-${id}`, attemptId: `attempt-${id}`, cost, errorCode: null };
      const settlement: PricingOutcome = { type: 'settlement', workspace, reservationId: `hold-${id}`, payload: {
        kind: 'commit', tokens: '1100', cost_usd: cost.report_amount!, budget_basis: 'legacy_logical',
        receipt: { attemptId: `attempt-${id}`, cost, errorCode: null },
      } };
      if (state === 'retained') { await ledger.retainRuntimeOutcome(attempt); await ledger.retainRuntimeOutcome(settlement); }
      if (state === 'committed' || state === 'intent') { await ledger.persistRuntimeOutcome(attempt); await ledger.persistRuntimeOutcome(settlement); }
      if (state === 'committed') await ledger.applySettlement(`hold-${id}`, workspace);
      const old = new Date(Date.now() - 2 * 86400000);
      const log = await source.getRepository(CallLog).save({ request_id: id, workspace_id: workspace, timestamp: old,
        source_format: 'chat_completions', node_id: target.node_id, model: target.model, tier: 'standard', score: 0,
        cost_usd: 99, input_tokens: 1000, output_tokens: 100 });
      await source.getRepository(RouteDecisionLog).save({ request_id: id, workspace_id: workspace, timestamp: old,
        source_format: 'chat_completions', tier: 'standard', score: 0, selected_node_id: target.node_id, selected_model: target.model, trace_json: '{}' });
      return { frozen, cost, log, attempt, settlement };
    }
    async function publishNewRate() {
      const content = tokenBook();
      for (const rate of content.groups[0].rules[0].rates) {
        if (rate.component.dimension === 'uncached_input_tokens') rate.component.amount = '2';
        if (rate.component.dimension === 'output_tokens') rate.component.amount = '4';
      }
      const created = await prices.createBook(actor, { name: 'New synthetic rates', scope: 'workspace', content });
      const head = (await prices.listBindings(actor)).head;
      await prices.publishDraft(actor, created.draft.id, publication(head.revision));
    }
    const reports = () => new CostReportService(source, makeLedger());
    const window = () => ({ from: new Date(Date.now() - 86400000).toISOString(), to: new Date(Date.now() + 60000).toISOString(), limit: '50' });

    it('keeps original receipts, cold historical quotes and report rows after actual cleanup and new prices', async () => {
      const original = await seed('historical'); await publishNewRate();
      await source.getRepository(CallLog).save({ request_id: 'recent-log', workspace_id: workspace, source_format: 'chat_completions',
        node_id: target.node_id, model: target.model, tier: 'standard', score: 0, cost_usd: 0.1 });
      const newer = (await prices.capture({ request_id: 'new-price', workspace_id: workspace, report_currency: 'USD' }))!;
      expect(newer.quote(target, tokens({ input_tokens: 1000, output_tokens: 100 })).cost.amount).toBe('0.002400000');
      const before = await snapshot(); await cleanupLogs();
      expect(await snapshot()).toEqual(before);
      expect(await source.getRepository(CallLog).findOneBy({ id: original.log.id })).toBeNull();
      expect(await source.getRepository(CallLog).count()).toBe(1);
      expect(await source.getRepository(RouteDecisionLog).count()).toBe(0);
      const restored = await new PricingRepository(source).restoreRequest('historical', workspace);
      expect(restored.quote(target, tokens({ input_tokens: 1000, output_tokens: 100 })).cost).toEqual(original.cost);
      expect(await makeLedger().summary('historical', workspace)).toMatchObject({ status: 'priced', amount: '0.001200000000000000', budget_committed_usd: '0.001200000000000000' });
      expect((await new PricingRepository(source).getVersion(actor, originalBook, originalVersion)).content).toEqual(tokenBook());
      const page = await reports().page(actor, window());
      expect(page.rows.find(row => row.request_id === 'historical')).toMatchObject({ basis: 'immutable_ledger', status: 'priced',
        log_id: null, amount_usd: '0.001200000000000000', legacy_estimate_usd: null, node_id: target.node_id, model: target.model });
      expect((await reports().logSummaries(actor, { ids: String(original.log.id) })).unavailable_log_ids).toEqual([original.log.id]);
      expect((await reports().page({ ...actor, workspace_id: 'foreign-workspace' }, window())).rows).toEqual([]);
      expect(await makeLedger().summary('historical', 'foreign-workspace')).toBeNull();
      expect(globalThis.fetch).not.toHaveBeenCalled();
      const after = await snapshot(true); await cleanupLogs(); expect(await snapshot(true)).toEqual(after);
    });

    it('preserves retained outcomes, pending intents and unresolved holds through cleanup, then recovers without double charging', async () => {
      await seed('already-committed'); await seed('retained', 'retained'); await seed('queued', 'intent'); await seed('orphan', 'orphan');
      await ledger.reconcileDispatched(); await publishNewRate();
      const before = await snapshot(), orphanBefore = await ledger.summary('orphan', workspace);
      await cleanupLogs(); expect(await snapshot()).toEqual(before);
      expect(await source.getRepository(CallLog).count()).toBe(0);
      const page = await reports().page(actor, window());
      expect(page.rows).toHaveLength(4);
      expect(page.rows.find(row => row.request_id === 'orphan')).toMatchObject({ status: 'pending', amount_usd: null, log_id: null, budget_reserved_usd: '0.500000000000000000' });
      expect(page.rows.find(row => row.request_id === 'retained')).toMatchObject({ status: 'pending', log_id: null });
      ledger = makeLedger();
      expect(await ledger.replayRuntimeOutcomes(new Date(Date.now() + 2000))).toMatchObject({ persisted: 2, pending: 0, review_required: 0 });
      expect(await ledger.reconcilePending(100, new Date(Date.now() + 3000))).toMatchObject({ applied: 2, pending: 0, review_required: 0 });
      for (const id of ['already-committed', 'retained', 'queued']) expect(await ledger.summary(id, workspace)).toMatchObject({ amount: '0.001200000000000000', budget_committed_usd: '0.001200000000000000' });
      expect(await ledger.summary('orphan', workspace)).toEqual(orphanBefore);
      const settled = await snapshot();
      await ledger.replayRuntimeOutcomes(new Date(Date.now() + 5000)); await ledger.reconcilePending(100, new Date(Date.now() + 5000));
      expect(await snapshot()).toEqual(settled);
      expect(await source.getRepository(CallLog).count()).toBe(0);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('rolls back the current cleanup batch on a storage failure without deleting pricing evidence', async () => {
      await seed('rollback'); const before = await snapshot(true);
      const execute = DeleteQueryBuilder.prototype.execute;
      const fault = jest.spyOn(DeleteQueryBuilder.prototype, 'execute').mockImplementation(async function (this: DeleteQueryBuilder<ObjectLiteral>) {
        const result = await execute.call(this);
        if (this.expressionMap.mainAlias?.tablePath?.endsWith('call_logs')) throw new Error('Synthetic cleanup write failure');
        return result;
      });
      try { await expect(cleanupLogs()).rejects.toThrow('Synthetic cleanup write failure'); } finally { fault.mockRestore(); }
      expect(await snapshot(true)).toEqual(before);
      await cleanupLogs(); expect(await source.getRepository(CallLog).count()).toBe(0);
      expect(await ledger.summary('rollback', workspace)).toMatchObject({ amount: '0.001200000000000000' });
    });

    it('refuses schema removal after log cleanup and never substitutes current prices for a missing historical version', async () => {
      await seed('guarded'); await publishNewRate(); await cleanupLogs();
      const before = await snapshot(); await expect(removeEmptyPricingSchema(source)).rejects.toThrow('nonempty'); expect(await snapshot()).toEqual(before);
      // A deliberately privileged SQL corruption is outside the supported cleanup/API surface.
      // The manifest references are JSON, not a foreign key for each version.
      await source.createQueryBuilder().delete().from('pricing_book_versions')
        .where('book_id = :book AND version_id = :version', { book: originalBook, version: originalVersion }).execute();
      await expect(new PricingRepository(source).restoreRequest('guarded', workspace)).rejects.toMatchObject({ status: 503 });
      // Receipt costs are self-contained and remain readable; this does not certify a valid catalog.
      expect(await makeLedger().summary('guarded', workspace)).toMatchObject({ amount: '0.001200000000000000' });
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });
  });
}

retentionContract('SQLite pricing retention lifecycle', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pricing-retention-'));
  const source = await new DataSource({ type: 'better-sqlite3', database: join(directory, 'fixture.sqlite'), entities, synchronize: true }).initialize();
  await source.query('PRAGMA journal_mode=WAL');
  return { source, cleanup: async () => rmSync(directory, { recursive: true, force: true }) };
});
const pg = process.env.SIFTGATE_PRICING_TEST_POSTGRES_URL;
if (pg && (new URL(pg).hostname !== '127.0.0.1' || !/^\/pricing_goal_[a-z0-9_]+$/.test(new URL(pg).pathname))) throw new Error('Use the task-owned PostgreSQL test database');
retentionContract('PostgreSQL pricing retention lifecycle', async () => {
  if (!pg) throw new Error('No isolated PostgreSQL URL');
  const schema = `pricing_retention_${process.pid}_${Math.random().toString(16).slice(2)}`;
  const admin = await new DataSource({ type: 'postgres', url: pg, synchronize: false }).initialize();
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const source = await new DataSource({ type: 'postgres', url: pg, schema, extra: { max: 2, options: `-c search_path=${schema}` }, entities, synchronize: true }).initialize();
  return { source, cleanup: async () => { try { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await admin.destroy(); } } };
}, pg ? describe : describe.skip);

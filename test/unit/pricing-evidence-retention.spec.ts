import { DataSource } from 'typeorm';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BudgetService } from '../../src/budget/budget.service';
import { BudgetRule, CallLog, RouteDecisionLog } from '../../src/database/entities';
import { WorkspaceContextService } from '../../src/workspaces/workspace-context.service';
import { CostLedgerService } from '../../src/pricing/cost-ledger.service';
import { PricingRepository } from '../../src/pricing/pricing-repository';
import { applyPricingSchema, PRICING_TABLE_NAMES } from '../../src/pricing/pricing-schema';
import { purgeSettledPricingEvidence } from '../../src/pricing/pricing-evidence-retention';
import { PricingEvidenceRetentionService } from '../../src/pricing/pricing-evidence-retention.service';
import type { PricingOutcome } from '../../src/pricing/pricing-outcome-retry';
import { mockConfigService } from '../helpers';
import { tokenBook, tokens } from './pricing-fixtures';

const workspace = 'default-workspace';
const actor = { id: 'synthetic-evidence-admin', workspace_id: workspace, role: 'admin' as const, global_admin: true };
const target = { node_id: 'synthetic-node', model: 'synthetic-model' };
const identity = { workspaceId: workspace, apiKeyName: null, apiKeyId: null, namespaceId: null, teamId: null };
const entities = [BudgetRule, CallLog, RouteDecisionLog];
const days = (n: number) => new Date(Date.now() - n * 86_400_000);
type Fixture = { source: DataSource; cleanup: () => Promise<void> };

function evidenceContract(label: string, connect: () => Promise<Fixture>, run = describe) {
  run(label, () => {
    let source: DataSource, cleanup: Fixture['cleanup'], prices: PricingRepository, ledger: CostLedgerService;
    const makeLedger = (config = mockConfigService()) =>
      new CostLedgerService(source, new BudgetService(config, new WorkspaceContextService(), source.getRepository(BudgetRule)));
    beforeEach(async () => {
      ({ source, cleanup } = await connect());
      await applyPricingSchema(source);
      await source.getRepository(BudgetRule).save({ workspace_id: workspace, type: 'daily_cost', limit_value: 100,
        current_value: 0, alert_threshold: 0.8, period_start: new Date(), is_active: true });
      prices = new PricingRepository(source); ledger = makeLedger();
      const book = await prices.createBook(actor, { name: 'Synthetic evidence rates', scope: 'workspace', content: tokenBook() });
      await prices.publishDraft(actor, book.draft.id, { draft_revision: 1, catalog_revision: 0, reason: 'Synthetic evidence fixture',
        confirm: true, targets: [{ level: 'model', model: target.model }] });
    });
    afterEach(async () => {
      jest.restoreAllMocks();
      if (source?.isInitialized) await source.destroy();
      await cleanup?.();
    });
    /** A complete request: snapshot, hold, attempt, applied commit and both delivered runtime outcomes. */
    async function settle(id: string) {
      const frozen = (await prices.capture({ request_id: id, workspace_id: workspace, report_currency: 'USD' }))!;
      const cost = frozen.quote(target, tokens({ input_tokens: 1000, output_tokens: 100 })).cost;
      await ledger.reserve({ id: `hold-${id}`, requestId: id, identity, target, estimate: cost, tokens: '1100', costUsd: '0.5',
        budgetBasis: 'legacy_logical', leaseOwner: 'synthetic-evidence', leaseUntil: new Date(Date.now() - 60000).toISOString() });
      await ledger.beginAttempt({ id: `attempt-${id}`, requestId: id, workspace, reservationId: `hold-${id}`, target,
        feeSource: 'provider', dispatchedAt: new Date().toISOString(), priceContext: { context: {}, legacyPrice: null } });
      const attempt: PricingOutcome = { type: 'attempt', workspace, reservationId: `hold-${id}`, attemptId: `attempt-${id}`, cost, errorCode: null };
      const settlement: PricingOutcome = { type: 'settlement', workspace, reservationId: `hold-${id}`, payload: {
        kind: 'commit', tokens: '1100', cost_usd: cost.report_amount!, budget_basis: 'legacy_logical',
        receipt: { attemptId: `attempt-${id}`, cost, errorCode: null } } };
      await ledger.persistRuntimeOutcome(attempt); await ledger.persistRuntimeOutcome(settlement);
      await ledger.applySettlement(`hold-${id}`, workspace);
    }
    const set = (table: string, values: Record<string, unknown>, where: string, parameters: object) =>
      source.createQueryBuilder().update(table).set(values).where(where, parameters).execute();
    const insert = (table: string, values: Record<string, unknown>) => source.createQueryBuilder().insert().into(table).values(values).execute();
    const age = (id: string, created: Date) => set('pricing_request_snapshots', { created_at: created.toISOString() }, 'request_id = :id', { id });
    async function tables() {
      const rows: Record<string, string[]> = {};
      for (const table of [...PRICING_TABLE_NAMES, 'budget_rules'])
        rows[table] = ((await source.query(`SELECT * FROM "${table}"`)) as unknown[]).map(row => JSON.stringify(row)).sort();
      return rows;
    }
    /** Every row the purge must remove for one request, read through the same relations it uses. */
    async function owned(id: string) {
      const rows = async (table: string, where: string, parameters: object) => ((await source.createQueryBuilder()
        .select('x.*').from(table, 'x').where(where, parameters).getRawMany()) as unknown[]).map(row => JSON.stringify(row));
      const request = { id }, hold = { id: `hold-${id}` };
      const outcomes = await source.createQueryBuilder().select('x.id', 'id').from('pricing_runtime_outcomes', 'x')
        .where('x.reservation_id = :id', hold).getRawMany<{ id: string }>();
      return {
        pricing_request_snapshots: await rows('pricing_request_snapshots', 'x.request_id = :id', request),
        pricing_reservations: await rows('pricing_reservations', 'x.request_id = :id', request),
        pricing_attempts: await rows('pricing_attempts', 'x.request_id = :id', request),
        pricing_budget_effects: await rows('pricing_budget_effects', 'x.request_id = :id', request),
        pricing_settlement_intents: await rows('pricing_settlement_intents', 'x.request_id = :id', request),
        pricing_runtime_outcomes: await rows('pricing_runtime_outcomes', 'x.reservation_id = :id', hold),
        pricing_audit_events: outcomes.length ? await rows('pricing_audit_events', 'x.id IN (:...ids)',
          { ids: outcomes.flatMap(o => [`${o.id}:retained`, `${o.id}:delivered`, `${o.id}:review_required`]) }) : [],
      } as Record<string, string[]>;
    }
    async function foreignKeysIntact() {
      if (source.options.type === 'better-sqlite3') expect(await source.query('PRAGMA foreign_key_check')).toEqual([]);
    }

    it('removes exactly the complete evidence of an old settled request and keeps everything unsettled or referenced', async () => {
      for (const id of ['done', 'recent', 'reserved', 'undelivered', 'recovery', 'corrected', 'unregistered']) await settle(id);
      const old = days(10).toISOString();
      for (const id of ['done', 'reserved', 'undelivered', 'recovery', 'corrected', 'unregistered']) await age(id, days(10));
      await age('recent', days(1));
      await set('pricing_reservations', { state: 'reserved' }, 'id = :id', { id: 'hold-reserved' });
      await set('pricing_runtime_outcomes', { state: 'pending' }, 'reservation_id = :id', { id: 'hold-undelivered' });
      await insert('pricing_recovery_cases', { reservation_id: 'hold-recovery', workspace_id: workspace, request_id: 'recovery',
        state: 'open', reason: 'synthetic', revision: 1, evidence_json: '{}', evidence_hash: 'e'.repeat(64),
        created_at: old, updated_at: old, checked_at: old, resolved_at: null, resolution_code: null });
      await insert('pricing_cost_adjustments', { id: 'adjustment-corrected', attempt_id: 'attempt-corrected', workspace_id: workspace,
        previous_hash: 'p'.repeat(64), cost_hash: 'c'.repeat(64), cost_json: '{}', reason: 'synthetic', created_at: old });
      // A dependant the purge does not know about: its RESTRICT key must reject the delete and roll the request back.
      await insert('pricing_media_submissions', { id: 'submission-unregistered', workspace_id: workspace, request_id: 'unregistered',
        fingerprint_hash: 'f'.repeat(64), state: 'accepted', task_id: null, lease_until: old, created_at: old });
      const removed = await owned('done');
      expect(removed.pricing_attempts).toHaveLength(1);
      expect(removed.pricing_runtime_outcomes).toHaveLength(2);
      expect(removed.pricing_audit_events).toHaveLength(4);
      const before = await tables();

      const result = await purgeSettledPricingEvidence(source, { before: days(7), limit: 100 });

      expect(result).toEqual({ scanned: 6, purged: 1, kept: 4, blocked: 1, next: null });
      const after = await tables();
      for (const [table, rows] of Object.entries(before))
        expect(after[table]).toEqual(rows.filter(row => !(removed[table] ?? []).includes(row)));
      expect(after.pricing_audit_events.some(row => row.includes('hold-done') || row.includes('attempt-done'))).toBe(false);
      await foreignKeysIntact();
      expect(await makeLedger().summary('done', workspace)).toBeNull();
      expect(await makeLedger().summary('recent', workspace)).not.toBeNull();

      expect(await purgeSettledPricingEvidence(source, { before: days(7), limit: 100 })).toEqual({ scanned: 5, purged: 0, kept: 4, blocked: 1, next: null });
      expect(await tables()).toEqual(after);
    });

    it('resumes after the per-run limit and finishes on the next run', async () => {
      for (const id of ['a', 'b', 'c']) { await settle(id); await age(id, days(9)); }
      const first = await purgeSettledPricingEvidence(source, { before: days(7), limit: 2 });
      expect(first).toMatchObject({ scanned: 2, purged: 2 });
      expect(first.next).not.toBeNull();
      expect(await purgeSettledPricingEvidence(source, { before: days(7), limit: 2, after: first.next })).toEqual(
        { scanned: 1, purged: 1, kept: 0, blocked: 0, next: null });
      expect(await source.query('SELECT count(*) AS n FROM pricing_request_snapshots')).toEqual([{ n: source.options.type === 'postgres' ? '0' : 0 }]);
      await foreignKeysIntact();
    });

    it('does nothing unless database.pricing_evidence_retention_days is positive', async () => {
      await settle('old'); await age('old', days(30));
      const service = (retention?: number) => {
        const config = mockConfigService({ database: { pricing_evidence_retention_days: retention } });
        return new PricingEvidenceRetentionService(source, config, makeLedger(config));
      };
      for (const disabled of [undefined, 0]) await service(disabled).runOnce();
      expect(await makeLedger().summary('old', workspace)).not.toBeNull();
      await service(7).runOnce();
      expect(await makeLedger().summary('old', workspace)).toBeNull();
      await foreignKeysIntact();
    });
  });
}

evidenceContract('SQLite settled pricing evidence retention', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pricing-evidence-'));
  const source = await new DataSource({ type: 'better-sqlite3', database: join(directory, 'fixture.sqlite'), entities, synchronize: true }).initialize();
  await source.query('PRAGMA journal_mode=WAL');
  return { source, cleanup: async () => rmSync(directory, { recursive: true, force: true }) };
});
const pg = process.env.SIFTGATE_PRICING_TEST_POSTGRES_URL;
if (pg && (new URL(pg).hostname !== '127.0.0.1' || !/^\/pricing_goal_[a-z0-9_]+$/.test(new URL(pg).pathname))) throw new Error('Use the task-owned PostgreSQL test database');
evidenceContract('PostgreSQL settled pricing evidence retention', async () => {
  if (!pg) throw new Error('No isolated PostgreSQL URL');
  const schema = `pricing_evidence_${process.pid}_${Math.random().toString(16).slice(2)}`;
  const admin = await new DataSource({ type: 'postgres', url: pg, synchronize: false }).initialize();
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const source = await new DataSource({ type: 'postgres', url: pg, schema, extra: { max: 2, options: `-c search_path=${schema}` }, entities, synchronize: true }).initialize();
  return { source, cleanup: async () => { try { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await admin.destroy(); } } };
}, pg ? describe : describe.skip);

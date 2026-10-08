import { DataSource } from 'typeorm';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HistoricalFxService, historicalFxSource } from '../../src/pricing/historical-fx.service';
import { PricingRepository } from '../../src/pricing/pricing-repository';
import { CostLedgerService } from '../../src/pricing/cost-ledger.service';
import { applyPricingSchema, PRICING_TABLE_NAMES } from '../../src/pricing/pricing-schema';
import { pricingContentHash } from '../../src/pricing/pricing-json';
import { BudgetRule } from '../../src/database/entities/budget-rule.entity';
import { CallLog } from '../../src/database/entities/call-log.entity';
import { BudgetService } from '../../src/budget/budget.service';
import { WorkspaceContextService } from '../../src/workspaces/workspace-context.service';
import { mockConfigService } from '../helpers';
import { tokenBook, tokens } from './pricing-fixtures';

const workspace = 'default-workspace';
function contract(name: string, connect: () => Promise<{ source: DataSource; cleanup: () => Promise<void> }>, run = describe) {
  run(name, () => {
    let source: DataSource, cleanup: () => Promise<void>, prices: PricingRepository, ledger: CostLedgerService, service: HistoricalFxService;
    const actor = { id: 'reader', workspace_id: workspace, role: 'viewer' as const, global_admin: false }, admin = { ...actor, role: 'admin' as const, global_admin: true };
    beforeEach(async () => {
      ({ source, cleanup } = await connect()); ledger = new CostLedgerService(source, new BudgetService(mockConfigService(), new WorkspaceContextService(), source.getRepository(BudgetRule)));
      prices = new PricingRepository(source); service = new HistoricalFxService(source, ledger); await applyPricingSchema(source);
      const content = tokenBook(); content.currency = 'CNY'; const created = await prices.createBook(admin, { name: 'Synthetic FX', scope: 'workspace', content });
      await prices.publishDraft(admin, created.draft.id, { draft_revision: 1, catalog_revision: 0, confirm: true, reason: 'Synthetic', targets: [{ level: 'model', model: 'm' }] });
    });
    afterEach(async () => { jest.restoreAllMocks(); if (source?.isInitialized) await source.destroy(); await cleanup?.(); });
    async function fx(denominator = '7', provenance = 'Synthetic source') {
      const head = (await prices.listBooks(admin)).head;
      await prices.updateFx(admin, { catalog_revision: head.revision, scope: 'workspace', reason: 'Synthetic', confirm: true, versions: [{ fx: { version_id: 'input', from_currency: 'CNY', to_currency: 'USD', numerator: '1', denominator, source: provenance, effective_at: '2026-01-01T00:00:00Z' } }] });
    }
    async function receipt(id = 'original', complete = true) {
      const snapshot = await prices.capture({ request_id: id, workspace_id: workspace, report_currency: 'USD' });
      const cost = snapshot!.quote({ model: 'm', node_id: 'n' }, tokens({ input_tokens: 1000, output_tokens: 0 })).cost;
      await ledger.beginAttempt({ id: 'attempt-' + id, requestId: id, workspace, target: { model: 'm', node_id: 'n' }, feeSource: 'provider', dispatchedAt: new Date().toISOString(), priceContext: { context: {}, legacyPrice: null } });
      if (complete) await ledger.completeAttempt('attempt-' + id, workspace, cost);
      return { cost, hash: pricingContentHash(cost), snapshot: snapshot!.descriptor() };
    }
    const dump = async () => { const data: Record<string, unknown> = {}; for (const table of [...PRICING_TABLE_NAMES, 'budget_rules', 'call_logs']) data[table] = await source.query(`SELECT * FROM ${table}`); return data; };
    it('restores the receipt-selected FX under one read snapshot after newer publication', async () => {
      await fx(); const old = await receipt(); await fx('5'); const fresh = await receipt('fresh'); const before = await dump();
      const spy = jest.spyOn(ledger, 'reportSummary'); const result = await service.read(actor, 'original', old.cost.fx_version_id!, { cost_hash: old.hash });
      expect(result).toMatchObject({ request_id: 'original', receipt_hash: old.hash, snapshot: old.snapshot, fx: { version_id: old.cost.fx_version_id, numerator: '1', denominator: '7', source: 'Synthetic source', source_redacted: false } });
      expect(spy.mock.calls[0][0].connection).toBe(source);
      const { evidence_hash, ...body } = result; expect(evidence_hash).toBe(pricingContentHash(body));
      await expect(service.read(actor, 'original', fresh.cost.fx_version_id!, { cost_hash: old.hash })).rejects.toMatchObject({ status: 404 });
      expect(await dump()).toEqual(before);
    });
    it('requires the exact retained receipt hash, not just a catalog FX ID', async () => {
      await fx(); const r = await receipt(); const before = await dump();
      await expect(service.read(actor, 'original', r.cost.fx_version_id!, { cost_hash: '0'.repeat(64) })).rejects.toMatchObject({ status: 404 });
      await expect(service.read(actor, 'missing', r.cost.fx_version_id!, { cost_hash: r.hash })).rejects.toMatchObject({ status: 404 });
      await expect(service.read({ ...actor, workspace_id: 'other' }, 'original', r.cost.fx_version_id!, { cost_hash: r.hash })).rejects.toMatchObject({ status: 404 });
      expect(await dump()).toEqual(before);
    });
    it('never treats an uncompleted estimate or a missing FX as retained conversion evidence', async () => {
      const missing = await receipt('missing-fx'); await fx(); const pending = await receipt('pending', false); const before = await dump();
      await expect(service.read(actor, 'missing-fx', pending.cost.fx_version_id!, { cost_hash: missing.hash })).rejects.toMatchObject({ status: 404 });
      await expect(service.read(actor, 'pending', pending.cost.fx_version_id!, { cost_hash: pending.hash })).rejects.toMatchObject({ status: 404 });
      expect(await dump()).toEqual(before);
    });
    it.each(['hash', 'null-snapshot', 'syntax-snapshot', 'admission-time', 'receipt-fx'])('rejects corrupt %s without rewriting the stored evidence', async kind => {
      await fx(); const r = await receipt(); let hash = r.hash;
      if (kind === 'hash') await source.createQueryBuilder().update('pricing_attempts').set({ cost_hash: 'bad' }).where('id = :id', { id: 'attempt-original' }).execute();
      if (kind.endsWith('snapshot')) await source.createQueryBuilder().update('pricing_request_snapshots').set({ descriptor_json: kind === 'null-snapshot' ? 'null' : '{' }).where('request_id = :id', { id: 'original' }).execute();
      if (kind === 'admission-time') await source.createQueryBuilder().update('pricing_request_snapshots').set({ created_at: '2026-01-01T00:00:00.000Z' }).where('request_id = :id', { id: 'original' }).execute();
      if (kind === 'receipt-fx') { r.cost.currency = 'EUR'; hash = pricingContentHash(r.cost); await source.createQueryBuilder().update('pricing_attempts').set({ cost_json: JSON.stringify(r.cost), cost_hash: hash }).where('id = :id', { id: 'attempt-original' }).execute(); }
      const before = await dump(); await expect(service.read(actor, 'original', r.cost.fx_version_id!, { cost_hash: hash })).rejects.toMatchObject({ status: ['null-snapshot', 'syntax-snapshot', 'admission-time'].includes(kind) ? 503 : 409 }); expect(await dump()).toEqual(before);
    });
    it('keeps original and corrected receipt FX references readable after an adjustment', async () => {
      await fx(); const r = await receipt(); const frozen = await prices.restoreRequest('original', workspace);
      const corrected = frozen.quote({ model: 'm', node_id: 'n' }, tokens({ input_tokens: 2000, output_tokens: 0 })).cost;
      const adjustment = await ledger.adjustAttempt({ id: 'fx-correction', attemptId: 'attempt-original', workspace, expectedCostHash: r.hash, cost: corrected, actorId: 'synthetic-admin', reason: 'Synthetic usage correction', source: 'reconciliation' });
      await fx('5'); const before = await dump();
      for (const hash of [r.hash, adjustment.cost_hash]) {
        const view = await service.read(actor, 'original', r.cost.fx_version_id!, { cost_hash: hash }); expect(view.receipt_hash).toBe(hash); expect(view.fx.denominator).toBe('7');
      }
      expect(await dump()).toEqual(before);
    });
    it('does not mask a database failure as a missing reference', async () => {
      await fx(); const r = await receipt(); jest.spyOn(ledger, 'reportSummary').mockRejectedValueOnce(new Error('isolated read unavailable'));
      await expect(service.read(actor, 'original', r.cost.fx_version_id!, { cost_hash: r.hash })).rejects.toThrow('isolated read unavailable');
    });
    it('returns a sanitized source view while retaining the exact original FX and receipt bytes', async () => {
      await fx('7', 'https://user:pass@rates.example.test/reference?token=private#secret'); const r = await receipt(); const before = await dump();
      const view = await service.read(actor, 'original', r.cost.fx_version_id!, { cost_hash: r.hash });
      expect(view.fx).toMatchObject({ source: 'https://rates.example.test/reference', source_redacted: true }); expect(await dump()).toEqual(before);
    });
    it('validates request/version/hash/query before reading financial evidence', async () => {
      const spy = jest.spyOn(ledger, 'reportSummary');
      for (const query of [{}, { cost_hash: 'bad' }, { cost_hash: 'a'.repeat(64), source: 'current' }]) await expect(service.read(actor, 'r', 'v', query)).rejects.toBeDefined();
      await expect(service.read(actor, '', 'v', { cost_hash: 'a'.repeat(64) })).rejects.toBeDefined();
      await expect(service.read({ ...actor, id: '' }, 'r', 'v', { cost_hash: 'a'.repeat(64) })).rejects.toMatchObject({ status: 403 }); expect(spy).not.toHaveBeenCalled();
    });
  });
}
contract('SQLite historical FX', async () => { const dir = mkdtempSync(join(tmpdir(), 'historical-fx-')); const source = await new DataSource({ type: 'better-sqlite3', database: join(dir, 'fixture.db'), entities: [BudgetRule, CallLog], synchronize: true }).initialize(); await source.query('PRAGMA journal_mode=WAL'); return { source, cleanup: async () => rmSync(dir, { recursive: true, force: true }) }; });
const pg = process.env.SIFTGATE_PRICING_TEST_POSTGRES_URL;
if (pg && (new URL(pg).hostname !== '127.0.0.1' || !/^\/pricing_goal_[a-z0-9_]+$/.test(new URL(pg).pathname))) throw Error('Private test database required');
contract('PostgreSQL historical FX', async () => { if (!pg) throw Error('No private PG'); const schema = `historical_fx_${process.pid}_${Math.random().toString(16).slice(2)}`, admin = await new DataSource({ type: 'postgres', url: pg, synchronize: false }).initialize(); await admin.query(`CREATE SCHEMA "${schema}"`); const source = await new DataSource({ type: 'postgres', url: pg, schema, extra: { options: `-c search_path=${schema}` }, entities: [BudgetRule, CallLog], synchronize: true }).initialize(); return { source, cleanup: async () => { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.destroy(); } }; }, pg ? describe : describe.skip);

describe('historical FX source display boundary', () => {
  it.each(['https://secret.internal./rates', 'https://127.0.0.1/rates', 'https://[::1]/rates', 'https://localhost/rates', 'file:///private/rates', '/private/rates', 'prefix https://secret.internal/rates', 'password=hidden', 'Bearer synthetic-token', 'name\nheader'])('omits private or secret-bearing provenance %s', value => { expect(historicalFxSource(value)).toBeNull(); });
  it('preserves Unicode labels as text and strips public URL credentials/query/fragment', () => {
    expect(historicalFxSource('合成合同 2026 · 海外')).toBe('合成合同 2026 · 海外');
    expect(historicalFxSource('https://u:p@rates.example.test/path?q=hidden#private')).toBe('https://rates.example.test/path');
  });
});

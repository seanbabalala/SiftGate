import { DataSource, type EntityManager } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BudgetRule } from '../../src/database/entities/budget-rule.entity';
import { CallLog } from '../../src/database/entities/call-log.entity';
import { BudgetService } from '../../src/budget/budget.service';
import { WorkspaceContextService } from '../../src/workspaces/workspace-context.service';
import { CostLedgerService } from '../../src/pricing/cost-ledger.service';
import { PricingRepository } from '../../src/pricing/pricing-repository';
import { PricingReplayService } from '../../src/pricing/pricing-replay.service';
import { PricingReplayBudget, PricingReplayLimitError } from '../../src/pricing/pricing-replay-budget';
import { applyPricingSchema, PRICING_TABLE_NAMES } from '../../src/pricing/pricing-schema';
import { resolvePricingLimits } from '../../src/config/pricing-limits';
import type { PricingLimitsConfig } from '../../src/config/gateway.config';
import { tokenBook, tokens } from './pricing-fixtures';
import { pricingContentHash } from '../../src/pricing/pricing-json';
import { mockConfigService } from '../helpers';

const workspace = 'default-workspace';
const actor = { id: 'synthetic-reader', workspace_id: workspace, role: 'admin' as const, global_admin: true };
const target = { node_id: 'synthetic-node', model: 'synthetic-model' };
const pgUrl = process.env.SIFTGATE_PRICING_TEST_POSTGRES_URL;
if (pgUrl) { const u = new URL(pgUrl); if (u.hostname !== '127.0.0.1' || u.port === '2099' || !/^\/pricing_goal_[a-z0-9_]+$/.test(u.pathname)) throw new Error('Replay tests require an isolated database'); }

describe('replay computation budgets', () => {
  it('uses a monotonic deadline and does not start more work at the boundary', async () => {
    let now = 100;
    const b = new PricingReplayBudget(resolvePricingLimits({ max_replay_ms: 10 }), undefined, () => now);
    now = 109; expect(() => b.check()).not.toThrow(); now = 110;
    await expect(b.checkpoint()).rejects.toMatchObject({ code: 'pricing_replay_timeout' });
  });
  it('counts shared output repeatedly and honors exact UTF-8/escaping size boundaries', async () => {
    const shared = { amount: '中😀\n\\"' }, value = { rows: [shared, shared], absent: undefined };
    const bytes = Buffer.byteLength(JSON.stringify(value));
    await expect(new PricingReplayBudget(resolvePricingLimits({ max_replay_result_bytes: bytes })).assertResult(value)).resolves.toBeUndefined();
    await expect(new PricingReplayBudget(resolvePricingLimits({ max_replay_result_bytes: bytes - 1 })).assertResult(value)).rejects.toMatchObject({ code: 'pricing_replay_limit_exceeded' });
  });
  it('rejects cycles, oversized output and exhausted calculation work without a success result', async () => {
    const b = new PricingReplayBudget(resolvePricingLimits({ max_replay_work: 2 }));
    b.spend(2); expect(() => b.spend(1)).toThrow(PricingReplayLimitError);
    const cycle: unknown[] = []; cycle.push(cycle);
    await expect(new PricingReplayBudget(resolvePricingLimits()).assertResult(cycle)).rejects.toThrow();
    await expect(new PricingReplayBudget(resolvePricingLimits({ max_replay_result_bytes: 16 })).assertResult({ text: 'x'.repeat(100000) })).rejects.toMatchObject({ code: 'pricing_replay_limit_exceeded' });
  });
  it('accounts incremental array entries, commas and dates exactly before constructing the whole result', async () => {
    const entries = [{ a: '\n中' }, { a: new Date('2026-01-01T00:00:00Z') }];
    const size = Buffer.byteLength(JSON.stringify({ results: entries }));
    for (const delta of [0, -1]) {
      const b = new PricingReplayBudget(resolvePricingLimits({ max_replay_result_bytes: size + delta }));
      await b.addResult({ results: [] }); await b.addResult(entries[0]);
      if (delta === 0) await expect(b.addResult(entries[1], 1)).resolves.toBeUndefined();
      else await expect(b.addResult(entries[1], 1)).rejects.toMatchObject({ code: 'pricing_replay_limit_exceeded' });
    }
  });
  it('observes caller cancellation and bounds pairwise rule compilation work', async () => {
    const abort = new AbortController(), b = new PricingReplayBudget(resolvePricingLimits(), abort.signal);
    abort.abort(); await expect(b.checkpoint()).rejects.toMatchObject({ code: 'pricing_replay_cancelled' });
    const book = tokenBook(); book.groups[0].rules = Array.from({ length: 20 }, (_, i) => ({ ...book.groups[0].rules[0], id: `r${i}` }));
    expect(new PricingReplayBudget(resolvePricingLimits()).bookWork(book)).toBeGreaterThan(400);
  });
});

for (const dialect of ['better-sqlite3', 'postgres'] as const) {
  const suite = dialect === 'postgres' && !pgUrl ? describe.skip : describe;
  suite(`bounded read-only historical replay (${dialect})`, () => {
    let source: DataSource, admin: DataSource | undefined, schema: string, directory: string | undefined;
    let ledger: CostLedgerService, prices: PricingRepository, bookId: string, draftId: string, versionId: string;
    const service = (limits: PricingLimitsConfig = {}) => new PricingReplayService(source, ledger, prices,
      mockConfigService({ pricingLimits: resolvePricingLimits({ max_replay_ms: 10000, ...limits }) }));
    const run = (limits: PricingLimitsConfig = {}, ids = ['request']) => service(limits).replay(actor, { request_ids: ids, content: tokenBook() });
    beforeEach(async () => {
      if (dialect === 'postgres') {
        schema = `replay_${randomUUID().replaceAll('-', '')}`;
        admin = await new DataSource({ type: 'postgres', url: pgUrl }).initialize(); await admin.query(`CREATE SCHEMA "${schema}"`);
        source = new DataSource({ type: 'postgres', url: pgUrl, schema, extra: { options: `-c search_path=${schema}`, max: 4 }, entities: [BudgetRule, CallLog], synchronize: true });
      } else {
        directory = mkdtempSync(join(tmpdir(), 'replay-budget-'));
        source = new DataSource({ type: dialect, database: join(directory, 'test.sqlite'), entities: [BudgetRule, CallLog], synchronize: true });
      }
      await source.initialize();
      if (dialect === 'better-sqlite3') await source.query('PRAGMA journal_mode=WAL');
      await applyPricingSchema(source);
      const rules = source.getRepository(BudgetRule);
      await rules.save({ workspace_id: workspace, type: 'daily_cost', current_value: 0, limit_value: 100, alert_threshold: .8, period_start: new Date(), is_active: true });
      ledger = new CostLedgerService(source, new BudgetService(mockConfigService(), new WorkspaceContextService(), rules)); prices = new PricingRepository(source);
      const created = await prices.createBook(actor, { name: 'Replay fixture', scope: 'workspace', content: tokenBook() });
      const published = await prices.publishDraft(actor, created.draft.id, { draft_revision: 1, catalog_revision: 0, reason: 'Synthetic fixture', confirm: true, targets: [{ level: 'model', model: target.model }] });
      bookId = created.book.id; versionId = published.version_id;
      draftId = (await prices.forkDraft(actor, bookId, versionId)).id;
      const snapshot = (await prices.capture({ request_id: 'request', workspace_id: workspace, report_currency: 'USD' }))!;
      const cost = snapshot.quote(target, tokens({ input_tokens: 1000, output_tokens: 100 })).cost;
      await ledger.reserve({ id: 'reservation', requestId: 'request', identity: { workspaceId: workspace, apiKeyId: null, apiKeyName: null, namespaceId: null, teamId: null }, target, estimate: cost, tokens: '1100', costUsd: '0.5', budgetBasis: 'legacy_logical', leaseOwner: 'fixture', leaseUntil: new Date(Date.now() + 60000).toISOString() });
      await ledger.beginAttempt({ id: 'attempt', requestId: 'request', workspace, reservationId: 'reservation', target, feeSource: 'provider', dispatchedAt: new Date().toISOString(), priceContext: { context: {}, legacyPrice: null } });
      await ledger.completeAttempt('attempt', workspace, cost);
    });
    afterEach(async () => {
      jest.restoreAllMocks();
      if (source?.isInitialized) await source.destroy();
      if (admin?.isInitialized) { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.destroy(); }
      if (directory) rmSync(directory, { recursive: true, force: true });
    });
    const snapshot = async () => {
      const value: Record<string, string[]> = {};
      for (const table of [...PRICING_TABLE_NAMES, 'budget_rules']) value[table] = (await source.query(`SELECT * FROM "${table}"`) as unknown[]).map(row => JSON.stringify(row)).sort();
      return value;
    };
    const transaction = <T>(callback: (manager: EntityManager) => Promise<T>) => dialect === 'postgres' ? source.transaction('REPEATABLE READ', callback) : source.transaction(callback);

    it.each(['inline', 'draft', 'version'] as const)('replays %s content with complete results and no state mutation', async kind => {
      const before = await snapshot();
      const response = await service().replay(actor, { request_ids: ['request', 'missing', 'request'], ...(kind === 'inline' ? { content: tokenBook() } : kind === 'draft' ? { draft_id: draftId } : { book_id: bookId, version_id: versionId }) });
      expect(response).toMatchObject({ simulation: true, historical_records_modified: false, complete: true });
      expect(response.results[0]).toMatchObject({ request_id: 'request', original: { amount: '0.001200000000000000' }, simulations: [{ simulated: { amount: '0.001200000' } }] });
      expect(response.results[1]).toEqual({ request_id: 'missing', status: 'not_replayable' });
      expect(response.results[2]).toEqual(response.results[0]); expect(await snapshot()).toEqual(before);
    });
    it.each([{ max_replay_rows: 1 }, { max_replay_source_bytes: 64 }, { max_replay_result_bytes: 64 }, { max_replay_work: 1 }])('fails the entire operation for %j without a partial response or writes', async limits => {
      const before = await snapshot();
      await expect(run(limits)).rejects.toMatchObject({ status: 422, code: 'pricing_replay_limit_exceeded' });
      expect(await snapshot()).toEqual(before);
    });
    it('rejects an oversized stored body before fetching or parsing it', async () => {
      await source.createQueryBuilder().update('pricing_attempts').set({ cost_json: 'x'.repeat(2 * 1024 * 1024) }).where('id = :id', { id: 'attempt' }).execute();
      const queries = jest.spyOn(source.logger, 'logQuery');
      await expect(run({ max_replay_source_bytes: 1024 * 1024 })).rejects.toMatchObject({ code: 'pricing_replay_limit_exceeded' });
      expect(queries.mock.calls.some(([sql]) => sql.startsWith('SELECT') && /FROM (?:"[^"]+"\.)?"pricing_attempts"/.test(sql) && !sql.includes('OCTET_LENGTH'))).toBe(false);
    });
    it('keeps workspace authorization and rejects caller-supplied budget overrides', async () => {
      const before = await snapshot();
      const other = { ...actor, workspace_id: 'foreign', global_admin: false };
      expect((await service().replay(other, { request_ids: ['request'], content: tokenBook() })).results).toEqual([{ request_id: 'request', status: 'not_replayable' }]);
      await expect(service().replay(other, { request_ids: ['request'], draft_id: draftId })).rejects.toMatchObject({ status: 404 });
      await expect(service().replay(actor, { request_ids: ['request'], content: tokenBook(), max_replay_ms: 30000 })).rejects.toThrow('Unknown field');
      expect(await snapshot()).toEqual(before);
    });
    it('does not permit mutation through the bounded manager and does not alter ordinary reads', async () => {
      const before = await snapshot();
      await transaction(async manager => {
        const proxy = new PricingReplayBudget(resolvePricingLimits()).bind(manager);
        expect(() => proxy.createQueryBuilder().delete()).toThrow(PricingReplayLimitError);
        expect(() => proxy.query('DELETE FROM pricing_attempts')).toThrow(PricingReplayLimitError);
        expect(() => proxy.getRepository(CallLog)).toThrow(PricingReplayLimitError);
        expect(await manager.createQueryBuilder().select('a.*').from('pricing_attempts', 'a').getRawMany()).toHaveLength(1);
      });
      expect(await snapshot()).toEqual(before);
    });
    it('cannot reuse a bounded manager after its read scope has been closed', async () => {
      await transaction(async manager => {
        const budget = new PricingReplayBudget(resolvePricingLimits()), proxy = budget.bind(manager);
        expect(() => budget.bind(manager)).toThrow(PricingReplayLimitError);
        budget.closeReads();
        await expect(proxy.createQueryBuilder().select('a.id').from('pricing_attempts', 'a').getRawMany()).rejects.toBeInstanceOf(PricingReplayLimitError);
      });
    });
    it('releases its admission slot and restores connection settings after timeout/cancellation', async () => {
      const before = dialect === 'postgres' ? await source.query('SHOW statement_timeout') : await source.query('PRAGMA busy_timeout');
      const abort = new AbortController(), replay = service(); abort.abort();
      await expect(replay.replay(actor, { request_ids: ['request'], content: tokenBook() }, abort.signal)).rejects.toMatchObject({ code: 'pricing_replay_cancelled' });
      await expect(run({ max_replay_ms: 1 })).rejects.toMatchObject({ code: 'pricing_replay_timeout' });
      expect(dialect === 'postgres' ? await source.query('SHOW statement_timeout') : await source.query('PRAGMA busy_timeout')).toEqual(before);
      expect((await replay.replay(actor, { request_ids: ['request'], content: tokenBook() })).complete).toBe(true);
    });
    it('rejects concurrent replay admission until the owned operation has really finished', async () => {
      let entered!: () => void, release!: () => void;
      const paused = new Promise<void>(resolve => { entered = resolve; }), resume = new Promise<void>(resolve => { release = resolve; });
      const original = prices.replayContent.bind(prices);
      const pause = jest.spyOn(prices, 'replayContent').mockImplementationOnce(async (...args) => { entered(); await resume; return original(...args); });
      const replay = service(), pending = replay.replay(actor, { request_ids: ['request'], content: tokenBook() });
      try {
        await paused;
        await expect(replay.replay(actor, { request_ids: ['request'], content: tokenBook() })).rejects.toMatchObject({ status: 429, code: 'pricing_replay_busy' });
      } finally { release(); await pending; pause.mockRestore(); }
      expect((await replay.replay(actor, { request_ids: ['request'], content: tokenBook() })).complete).toBe(true);
    });
    it('cancels and drains owned replay work before database shutdown, rather than abandoning a disconnected caller', async () => {
      let entered!: () => void, release!: () => void;
      const paused = new Promise<void>(resolve => { entered = resolve; }), resume = new Promise<void>(resolve => { release = resolve; });
      const read = prices.replayContent.bind(prices);
      jest.spyOn(prices, 'replayContent').mockImplementationOnce(async (...args) => { entered(); await resume; return read(...args); });
      const replay = service();
      const pending = replay.replay(actor, { request_ids: ['request'], content: tokenBook() }).then(() => null, error => error as Error);
      await paused;
      let drained = false;
      const closing = replay.onModuleDestroy().then(() => { drained = true; });
      await Promise.resolve(); expect(drained).toBe(false); expect(source.isInitialized).toBe(true);
      release(); expect(await pending).toMatchObject({ code: 'pricing_replay_cancelled' });
      await closing; expect(drained).toBe(true);
      await expect(replay.replay(actor, { request_ids: ['request'], content: tokenBook() })).rejects.toMatchObject({ code: 'pricing_replay_busy' });
    });
    it('keeps footprint inspection and body reads in the same snapshot while another connection changes the body', async () => {
      const peer = await new DataSource({ ...source.options, synchronize: false }).initialize();
      const original = (await source.query('SELECT cost_json FROM pricing_attempts'))[0].cost_json;
      const b = new PricingReplayBudget(resolvePricingLimits({ max_replay_source_bytes: 100000, max_replay_ms: 10000 }));
      const beforeRead = b.beforeRead.bind(b); let calls = 0;
      jest.spyOn(b, 'beforeRead').mockImplementation(async manager => {
        await beforeRead(manager);
        if (++calls === 3) await peer.createQueryBuilder().update('pricing_attempts').set({ cost_json: 'x'.repeat(200000) }).where('id = :id', { id: 'attempt' }).execute();
      });
      try {
        await transaction(async manager => {
          const proxy = b.bind(manager);
          const rows = await proxy.createQueryBuilder().select('a.cost_json', 'cost_json').from('pricing_attempts', 'a').where('a.workspace_id = :workspace', { workspace }).getRawMany();
          expect(rows).toEqual([{ cost_json: original }]);
        });
        expect((await source.query('SELECT cost_json FROM pricing_attempts'))[0].cost_json).toHaveLength(200000);
      } finally { await peer.destroy(); }
    });
    it('preserves cold-catalog local-cache reference checks and never swallows a replay limit as missing reference', async () => {
      const row = (await source.query('SELECT cost_json FROM pricing_attempts'))[0];
      const zero = { ...JSON.parse(row.cost_json), status: 'free', evidence_status: 'observed', amount: '0', known_subtotal: '0', report_amount: '0', report_known_subtotal: '0', rounding_adjustment: '0', report_rounding_adjustment: '0', lines: [], diagnostics: [] };
      await source.createQueryBuilder().update('pricing_attempts').set({ fee_source: 'local_cache', cost_json: JSON.stringify(zero), cost_hash: pricingContentHash(zero) }).where('id = :id', { id: 'attempt' }).execute();
      const before = await snapshot();
      const catalogOwner = ledger as unknown as { prices: { catalogs: Map<string, unknown> } };
      catalogOwner.prices.catalogs.clear(); // Admission warmed it; exercise an actual cold historical restore.
      expect(catalogOwner.prices.catalogs.size).toBe(0);
      expect((await run()).results[0]).toMatchObject({ original: { amount: '0.000000000000000000', local_cache_reference: { state: 'estimated', hypothetical_savings_usd: '0.001200000000000000' } } });
      expect(catalogOwner.prices.catalogs.size).toBe(0);
      const fail = jest.spyOn(PricingRepository.prototype, 'restoreRequestInTransaction').mockRejectedValueOnce(new PricingReplayLimitError('capacity'));
      await expect(run()).rejects.toMatchObject({ code: 'pricing_replay_limit_exceeded' });
      fail.mockRestore(); expect(await snapshot()).toEqual(before);
    });
    it('supports inherited drafts with the same scoped parent and audit verification', async () => {
      const version = await prices.getVersion(actor, bookId, versionId);
      const child = await prices.createInheritedBook(actor, { name: 'Inherited replay', scope: 'workspace', definition: {
        schema_version: 1, parent: { book_id: bookId, version_id: versionId, content_hash: version.content_hash }, inherit: 'all', source: { kind: 'manual' },
        rate_overrides: [], removed_component_ids: [], replaced_groups: [], added_groups: [], removed_group_ids: [], settings: {}, calendar: { mode: 'inherit' },
      } });
      const before = await snapshot();
      const response = await service().replay(actor, { request_ids: ['request'], draft_id: child.draft.id });
      expect(response.complete).toBe(true);
      expect(response.results[0]).toMatchObject({ simulations: [{ simulated: { amount: '0.001200000' } }] });
      expect(await snapshot()).toEqual(before);
    });
    it('captures inline content before awaiting storage and enforces the body limit for direct callers too', async () => {
      const value = { request_ids: ['request'], content: tokenBook() };
      const pending = service().replay(actor, value);
      value.content.groups[0].rules[0].rates[0].component.amount = '99';
      expect((await pending).results[0]).toMatchObject({ simulations: [{ simulated: { amount: '0.001200000' } }] });
      await expect(service({ max_request_body_bytes: 1024 }).replay(actor, { ...value, extra: 'x'.repeat(2048) })).rejects.toMatchObject({ status: 413, code: 'pricing_request_too_large' });
    });
    if (dialect === 'postgres') it('cancels a real slow statement and leaves no failed transaction on the pool', async () => {
      await expect(transaction(async manager => {
        await manager.query('SET TRANSACTION READ ONLY');
        const b = new PricingReplayBudget(resolvePricingLimits({ max_replay_ms: 250 }));
        const reader = b.bind(manager);
        await reader.createQueryBuilder().select('a.id', 'id').from('pricing_attempts', 'a').where('a.workspace_id = :workspace', { workspace })
          .andWhere('(SELECT pg_sleep(2)) IS NULL').getRawMany();
      })).rejects.toMatchObject({ code: 'pricing_replay_timeout' });
      expect((await source.query('SHOW statement_timeout'))[0].statement_timeout).toBe('0');
      expect(await source.query('SELECT 1 AS ready')).toEqual([{ ready: 1 }]);
    });
  });
}

import { DataSource } from 'typeorm';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodeContractHarness, CONTRACT_MODEL, quoteNodeContract, type NodeContractVersion } from '../helpers/node-contract-fixture';
import { API_KEY, type E2EHarness } from './setup';
import { PricingRuntimeService } from '../../src/pricing/pricing-runtime.service';
import { PRICING_TABLE_NAMES } from '../../src/pricing/pricing-schema';
import type { CostLedgerSummary } from '../../src/pricing/cost-ledger.types';
import { book, rate } from '../unit/pricing-fixtures';

const base = '/api/dashboard/pricing';
describe('mixed native currencies across real HTTP fallback with frozen FX', () => {
  let h: E2EHarness, db: DataSource, directory: string;
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'mixed-currency-http-'));
    h = await createNodeContractHarness(directory); db = h.app.get(DataSource);
  });
  afterEach(async () => {
    await h?.app.get(PricingRuntimeService).waitForRequests(); await h?.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });
  async function publish(node: string, currency: string): Promise<NodeContractVersion> {
    const content = book([rate('input', 'uncached_input_tokens', currency === 'CNY' ? '7' : '1'), rate('output', 'output_tokens', currency === 'CNY' ? '14' : '2')]);
    content.currency = currency;
    const created = await h.agent.post(`${base}/books`).send({ name: 'Synthetic ' + node + ' ' + currency, content });
    expect(created.status).toBe(201);
    const head = (await h.agent.get(`${base}/bindings`)).body.head;
    const published = await h.agent.post(`${base}/drafts/${created.body.draft.id}/publish`).send({
      draft_revision: 1, catalog_revision: head.revision, confirm: true, reason: 'Synthetic currency contract',
      targets: [{ level: 'node', node_id: node, model: CONTRACT_MODEL, operation: 'chat_completions' }],
    });
    expect(published.status).toBe(201);
    return { node_id: node, book_id: created.body.book.id, version_id: published.body.version_id };
  }
  async function fx(denominator: string) {
    const head = (await h.agent.get(`${base}/bindings`)).body.head;
    const result = await h.agent.put(`${base}/fx`).send({
      catalog_revision: head.revision, scope: 'workspace', confirm: true, reason: 'Synthetic FX update',
      versions: [{ fx: { version_id: 'synthetic-fx-input', from_currency: 'CNY', to_currency: 'USD', numerator: '1', denominator, source: 'Synthetic ratio 1/' + denominator, effective_at: '2026-01-01T00:00:00Z' } }],
    });
    expect(result.status).toBe(200);
  }
  async function snapshot() {
    const rows: Record<string, unknown> = {};
    for (const table of [...PRICING_TABLE_NAMES, 'budget_rules', 'call_logs']) rows[table] = await db.query(`SELECT * FROM ${table}`);
    return rows;
  }
  async function detail(id: number): Promise<CostLedgerSummary> {
    const response = await h.agent.get(`/api/dashboard/logs/${id}/cost-breakdown`);
    expect(response.status).toBe(200); return response.body as CostLedgerSummary;
  }
  it.each([false, true].flatMap(missingFx => [false, true].map(stream => ({ missingFx, stream }))))(
    'does not add USD and CNY directly or borrow newly published FX (missingFx=$missingFx,stream=$stream)', async ({ missingFx, stream }) => {
      const usd = await publish('contract-a', 'USD'), cny = await publish('contract-b', 'CNY');
      if (!missingFx) await fx('7');
      const head = (await h.agent.get(`${base}/bindings`)).body.head;
      expect((await h.agent.put(`${base}/admission-policy`).send({ catalog_revision: head.revision, scope: 'workspace', operation: 'chat_completions', confirm: true, reason: 'Synthetic explicit actual expense', policy: { mode: 'compatibility', budget_basis: 'actual_upstream' } })).status).toBe(200);
      const beforeQuote = await snapshot();
      expect((await quoteNodeContract(h, usd)).amount).toBe('0.001200000');
      expect((await quoteNodeContract(h, cny)).amount).toBe('0.008400000');
      expect(await snapshot()).toEqual(beforeQuote); expect(h.fetchMock.calls).toHaveLength(0);
      const usage = { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100, prompt_tokens_details: { cached_tokens: 0 }, cache_creation_input_tokens: 0 };
      let primary = 0;
      h.fetchMock.setHandler(async (url, init) => {
        const node = new URL(url).hostname;
        expect(['contract-a.test', 'contract-b.test']).toContain(node);
        if (node === 'contract-a.test') {
          expect(++primary).toBe(1); await fx('5');
          return new Response(JSON.stringify({ model: 'supplier-a', error: { message: 'Synthetic paid failure', type: 'server_error' }, usage }), { status: 503, headers: { 'content-type': 'application/json' } });
        }
        const body = JSON.parse(String(init?.body));
        const result = { id: 'synthetic-fx', model: 'supplier-b', choices: [{ index: 0, message: { role: 'assistant', content: 'Synthetic currency output' }, finish_reason: 'stop' }], usage };
        return body.stream
          ? new Response(`data: ${JSON.stringify({ ...result, choices: [] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
          : new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } });
      });
      const call = async (model: string) => {
        const response = await h.agent.post('/v1/chat/completions').set('Authorization', `Bearer ${API_KEY}`).send({ model, stream, max_tokens: 100, messages: [{ role: 'user', content: 'Synthetic mixed currency' }] });
        expect(response.status).toBe(200); if (stream) expect(response.text).toContain('[DONE]');
        await h.app.get(PricingRuntimeService).waitForRequests();
      };
      await call('auto');
      const firstLog = (await h.callLogRepo.find({ order: { id: 'ASC' } }))[0];
      const first = await detail(firstLog.id), original = await db.query('SELECT * FROM pricing_attempts WHERE request_id = ?', [first.request_id]);
      expect(first.provider_attempts).toBe(2);
      const usdAttempt = first.attempts.find(a => a.node_id === 'contract-a')!, cnyAttempt = first.attempts.find(a => a.node_id === 'contract-b')!;
      expect(usdAttempt.error_code).not.toBeNull();
      expect(usdAttempt.cost).toMatchObject({ currency: 'USD', amount: '0.001200000', report_currency: 'USD', report_amount: '0.001200000', version_id: usd.version_id });
      expect(cnyAttempt.cost).toMatchObject({ currency: 'CNY', amount: '0.008400000', report_currency: 'USD', report_amount: missingFx ? null : '0.001200000', version_id: cny.version_id });
      expect(first.amount).toBe(missingFx ? null : '0.002400000000000000');
      expect(first.known_subtotal).toBe(missingFx ? '0.001200000000000000' : '0.002400000000000000');
      expect(first.unknown_attempts).toBe(missingFx ? 1 : 0);
      expect(first.budget_committed_usd).toBe(first.known_subtotal);
      expect(firstLog.cost_usd).toBe(missingFx ? 0.0012 : 0.0024);
      if (missingFx) {
        expect(cnyAttempt.cost!.fx_version_id).toBeNull();
        expect(first.reservations.find(r => r.id === cnyAttempt.reservation_id)?.state).toBe('reserved');
        expect(cnyAttempt.cost!.diagnostics.some(d => d.code === 'pricing_fx_missing')).toBe(true);
      } else {
        const read = await h.agent.get(`${base}/requests/${first.request_id}/fx/${cnyAttempt.cost!.fx_version_id}`).query({ cost_hash: cnyAttempt.cost_hash });
        expect(read.status).toBe(200); expect(read.body.fx).toMatchObject({ numerator: '1', denominator: '7' });
      }
      await call(`contract-b/${CONTRACT_MODEL}`);
      const secondLog = (await h.callLogRepo.find({ order: { id: 'DESC' } }))[0], second = await detail(secondLog.id);
      expect(second.amount).toBe('0.001680000000000000'); expect(second.budget_committed_usd).toBe(second.amount);
      expect(second.attempts[0].cost).toMatchObject({ currency: 'CNY', amount: '0.008400000', report_currency: 'USD', report_amount: '0.001680000', version_id: cny.version_id });
      expect(second.attempts[0].cost!.fx_version_id).not.toBe(cnyAttempt.cost!.fx_version_id);
      expect(await db.query('SELECT * FROM pricing_attempts WHERE request_id = ?', [first.request_id])).toEqual(original);
      const beforeRead = await snapshot(); expect(await detail(firstLog.id)).toEqual(first);
      const report = await h.agent.get(`${base}/cost-report`).query({ from: new Date(Date.now() - 60000).toISOString(), to: new Date(Date.now() + 1000).toISOString() });
      expect(report.status).toBe(200);
      expect(report.body.rows.find((r: { request_id: string }) => r.request_id === first.request_id)).toMatchObject({ amount_usd: first.amount, known_subtotal_usd: first.known_subtotal });
      expect(report.body.totals.calculated_usd).toBe(missingFx ? '0.001680000000000000' : '0.004080000000000000');
      expect(report.body.totals.partial_known_usd).toBe(missingFx ? '0.001200000000000000' : '0.000000000000000000');
      expect(await snapshot()).toEqual(beforeRead); expect(h.fetchMock.calls).toHaveLength(3);
    },
  );
});

import { DataSource } from 'typeorm';
import { createE2EHarness, type E2EHarness } from './setup';
import { ConfigService } from '../../src/config/config.service';
import { resolvePricingLimits } from '../../src/config/pricing-limits';
import { PricingRepository } from '../../src/pricing/pricing-repository';
import { CostLedgerService } from '../../src/pricing/cost-ledger.service';
import { PricingRecoveryService } from '../../src/pricing/pricing-recovery.service';
import { PricingReplayLimitError } from '../../src/pricing/pricing-replay-budget';
import { applyPricingSchema, PRICING_TABLE_NAMES } from '../../src/pricing/pricing-schema';
import { tokenBook, tokens } from '../unit/pricing-fixtures';

const workspace = 'default-workspace';
const actor = { id: 'dashboard', workspace_id: workspace, role: 'admin' as const, global_admin: true };
const target = { node_id: 'mock-openai', model: 'gpt-4o', operation: 'chat_completions' as const };
const endpoint = '/api/dashboard/pricing/replay';

describe('bounded historical replay HTTP', () => {
  let h: E2EHarness, source: DataSource, prices: PricingRepository, ledger: CostLedgerService;
  beforeEach(async () => {
    h = await createE2EHarness(); await h.app.get(PricingRecoveryService).onModuleDestroy();
    source = h.app.get(DataSource); await applyPricingSchema(source);
    prices = h.app.get(PricingRepository); ledger = h.app.get(CostLedgerService);
    const book = await prices.createBook(actor, { name: 'Replay HTTP fixture', scope: 'workspace', content: tokenBook() });
    await prices.publishDraft(actor, book.draft.id, { draft_revision: 1, catalog_revision: 0, reason: 'Synthetic test', confirm: true, targets: [{ level: 'model', model: target.model }] });
    await seed('request');
  }, 30000);
  afterEach(async () => { jest.restoreAllMocks(); await h?.close(); });
  async function seed(id: string, actual = false) {
    const frozen = (await prices.capture({ request_id: id, workspace_id: workspace, report_currency: 'USD' }))!;
    const cost = frozen.quote(target, tokens({ input_tokens: 1000, output_tokens: 100 })).cost;
    await ledger.reserve({ id, requestId: id, identity: { workspaceId: workspace, apiKeyId: null, apiKeyName: null, namespaceId: null, teamId: null }, target, estimate: cost, tokens: '1100', costUsd: '0.5', budgetBasis: actual ? 'actual_upstream' : 'legacy_logical', leaseOwner: 'fixture', leaseUntil: new Date(Date.now() + 60000).toISOString() });
    await ledger.beginAttempt({ id: `attempt-${id}`, requestId: id, workspace, reservationId: id, target, feeSource: 'provider', dispatchedAt: new Date().toISOString(), priceContext: { context: {}, legacyPrice: null } });
    await ledger.completeAttempt(`attempt-${id}`, workspace, cost);
    if (actual) await ledger.persistRuntimeOutcome({ type: 'actual_budget_closure', workspace, reservationId: id, payload: {
      attempt_ids: [`attempt-${id}`], missing_dispatch_evidence: false, receipts: [{ attemptId: `attempt-${id}`, cost, errorCode: null }],
    } });
  }
  async function state() {
    const result: Record<string, string[]> = {};
    for (const table of [...PRICING_TABLE_NAMES, 'budget_rules']) result[table] = (await source.query(`SELECT * FROM "${table}"`) as unknown[]).map(row => JSON.stringify(row)).sort();
    return result;
  }
  const payload = () => ({ request_ids: ['request'], content: tokenBook() });
  it('returns complete bounded simulations and leaves all pricing/financial rows unchanged', async () => {
    const before = await state();
    const response = await h.agent.post(endpoint).send(payload());
    expect(response.status).toBe(201); expect(response.body).toMatchObject({ complete: true, simulation: true, historical_records_modified: false });
    expect(response.body.results[0].simulations[0].simulated.amount).toBe('0.001200000');
    expect(await state()).toEqual(before); expect(h.fetchMock.calls).toHaveLength(0);
  });
  it.each([{ max_replay_rows: 1 }, { max_replay_source_bytes: 64 }, { max_replay_result_bytes: 64 }, { max_replay_work: 1 }])('returns a structured non-partial error for %j', async limit => {
    jest.spyOn(h.app.get(ConfigService), 'pricingLimits', 'get').mockReturnValue(resolvePricingLimits({ max_replay_ms: 10000, ...limit }));
    const before = await state(), response = await h.agent.post(endpoint).send(payload());
    expect(response.status).toBe(422); expect(response.body.error.code).toBe('pricing_replay_limit_exceeded');
    expect(response.body).not.toHaveProperty('results'); expect(response.body).not.toHaveProperty('complete');
    expect(await state()).toEqual(before); expect(h.fetchMock.calls).toHaveLength(0);
  });
  it('maps deadline failures explicitly and accepts a later successful request', async () => {
    const original = ledger.reportSummary.bind(ledger);
    jest.spyOn(ledger, 'reportSummary').mockImplementationOnce(async (...args) => { await original(...args); throw new PricingReplayLimitError('time'); });
    const before = await state(), response = await h.agent.post(endpoint).send(payload());
    expect(response.status).toBe(408); expect(response.body.error.code).toBe('pricing_replay_timeout'); expect(response.body).not.toHaveProperty('results');
    expect((await h.agent.post(endpoint).send(payload())).status).toBe(201);
    expect(await state()).toEqual(before); expect(h.fetchMock.calls).toHaveLength(0);
  });
  it('does not permit JSON budget/role overrides or non-JSON/cross-origin actions', async () => {
    expect((await h.agent.post(endpoint).send({ ...payload(), max_replay_ms: 30000 })).status).toBe(400);
    expect((await h.agent.post(endpoint).send({ ...payload(), workspace_id: 'foreign', role: 'admin' })).status).toBe(400);
    expect((await h.agent.post(endpoint).set('Origin', 'https://untrusted.example').send(payload())).status).toBe(403);
    expect((await h.agent.post(endpoint).type('form').send({ request_ids: 'request' })).status).toBe(403);
    expect((await h.agent.post(endpoint).send({ ...payload(), request_ids: Array(31).fill('request') })).status).toBe(400);
    expect(h.fetchMock.calls).toHaveLength(0);
  });
  it('preserves actual-budget closure evidence in a read-only replay', async () => {
    const head = (await h.agent.get('/api/dashboard/pricing/bindings')).body.head;
    const policy = await h.agent.put('/api/dashboard/pricing/admission-policy').send({ catalog_revision: head.revision, scope: 'workspace', operation: 'chat_completions', reason: 'Synthetic opt-in', confirm: true, policy: { mode: 'compatibility', budget_basis: 'actual_upstream' } });
    expect(policy.status).toBe(200); await seed('actual-request', true);
    const before = await state(), response = await h.agent.post(endpoint).send({ ...payload(), request_ids: ['actual-request'] });
    expect(response.status).toBe(201); expect(response.body.results[0].original.budget_committed_usd).toBe('0.001200000000000000');
    expect(await state()).toEqual(before); expect(h.fetchMock.calls).toHaveLength(0);
  });
});

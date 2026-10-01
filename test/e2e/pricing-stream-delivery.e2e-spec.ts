import { DataSource, InsertQueryBuilder } from "typeorm";
import { createE2EHarness, API_KEY, type E2EHarness } from "./setup";
import { applyPricingSchema } from "../../src/pricing/pricing-schema";
import { CostLedgerService } from "../../src/pricing/cost-ledger.service";
import { PricingRecoveryService } from "../../src/pricing/pricing-recovery.service";
import { PricingRuntimeService } from "../../src/pricing/pricing-runtime.service";
import { BudgetService } from "../../src/budget/budget.service";
import { tokenBook, tokens } from "../unit/pricing-fixtures";
import { attachUsageEvidence } from "../../src/canonical/usage-evidence";
import type { CanonicalStreamEvent } from "../../src/canonical/canonical.types";

const gate = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { release, promise }; };
async function bounded<T>(promise: PromiseLike<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), 3000); })]); }
  finally { if (timer) clearTimeout(timer); }
}
describe("durable stream receipt before HTTP end, tracked delivery afterward", () => {
  let h: E2EHarness, db: DataSource, ledger: CostLedgerService, runtime: PricingRuntimeService;
  beforeEach(async () => {
    h = await createE2EHarness(); db = h.app.get(DataSource); ledger = h.app.get(CostLedgerService); runtime = h.app.get(PricingRuntimeService);
    await h.app.get(PricingRecoveryService).onModuleDestroy(); await applyPricingSchema(db);
    const created = await h.agent.post('/api/dashboard/pricing/books').send({ name: 'Synthetic stream retention', content: tokenBook() }); expect(created.status).toBe(201);
    expect((await h.agent.post(`/api/dashboard/pricing/drafts/${created.body.draft.id}/publish`).send({ draft_revision: 1, catalog_revision: 0, reason: 'Synthetic only', confirm: true, targets: [{ level: 'model', model: 'gpt-4o' }] })).status).toBe(201);
    h.fetchMock.setHandler(async () => new Response([
      { id: 'synthetic', model: 'gpt-4o', choices: [{ index: 0, delta: { role: 'assistant', content: 'PRIVATE-OUTPUT' }, finish_reason: null }] },
      { id: 'synthetic', model: 'gpt-4o', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      { id: 'synthetic', model: 'gpt-4o', choices: [], usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100, prompt_tokens_details: { cached_tokens: 0 }, cache_creation_input_tokens: 0 } },
    ].map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }));
  });
  afterEach(async () => { jest.restoreAllMocks(); await runtime?.waitForRequests(); await h?.close(); });
  async function actual(enabled: boolean) {
    if (!enabled) return;
    expect((await h.agent.put('/api/dashboard/pricing/admission-policy').send({ catalog_revision: 1, reason: 'Synthetic actual stream budget', confirm: true, scope: 'workspace', operation: 'chat_completions', policy: { mode: 'compatibility', budget_basis: 'actual_upstream' } })).status).toBe(200);
  }
  const request = () => h.agent.post('/v1/chat/completions').set('Authorization', `Bearer ${API_KEY}`).send({ model: 'gpt-4o', max_tokens: 20, stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'PRIVATE-PROMPT' }] }).then(reply => reply);
  async function summary() {
    await runtime.waitForRequests(); const rows = await db.query('SELECT request_id,workspace_id FROM pricing_request_snapshots');
    return (await ledger.summary(rows[0].request_id, rows[0].workspace_id))!;
  }
  // Direct public-runtime integration below exercises same-group races that
  // separate HTTP requests (each owning a distinct hold) cannot reproduce.
  const canonical = { model: 'gpt-4o', metadata: { source_format: 'chat_completions' as const, original_model: 'gpt-4o', raw_headers: {} } };
  const target = { node_id: 'mock-openai', model: 'gpt-4o' };
  it.each([false, true].flatMap(stream => [false, true].map(enabled => ({ stream, enabled }))))('uses the completed stream I/O hint only for its own final decision (stream=$stream, actual=$enabled)', async ({ stream, enabled }) => {
    await actual(enabled);
    if (!stream) h.fetchMock.setHandler(async () => Response.json({ id: 'synthetic', object: 'chat.completion', model: 'gpt-4o', choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 0 }, cache_creation_input_tokens: 0 } }));
    const writes: Array<{ outcome: Parameters<CostLedgerService['persistRuntimeOutcome']>[0]; yieldAfterRetention: boolean }> = [];
    const original = ledger.retainRuntimeOutcome.bind(ledger);
    const streamRetention = jest.spyOn(ledger, 'prepareStreamReceipt');
    const prepare = ledger.prepareRuntimeReceipt.bind(ledger);
    const joinsReceipt = !stream && !enabled;
    let retainedIoTurn = false;
    const decisionIoTurns: boolean[] = [];
    const preparedReceipts = jest.spyOn(ledger, 'prepareRuntimeReceipt').mockImplementation(async outcome => {
      const delivery = await prepare(outcome);
      if (joinsReceipt) setImmediate(() => { retainedIoTurn = true; });
      return delivery;
    });
    jest.spyOn(ledger, 'retainRuntimeOutcome').mockImplementation(async (outcome, yieldAfterRetention = true) => { writes.push({ outcome, yieldAfterRetention }); if (joinsReceipt && outcome.type !== 'attempt') decisionIoTurns.push(retainedIoTurn); return original(outcome, yieldAfterRetention); });
    const reply = stream ? await request() : await h.agent.post('/v1/chat/completions').set('Authorization', `Bearer ${API_KEY}`).send({ model: 'gpt-4o', stream: false, max_tokens: 20, messages: [{ role: 'user', content: 'Synthetic scheduling check' }] });
    expect(reply.status).toBe(200); await runtime.waitForRequests();
    const decisions = writes.filter(write => write.outcome.type !== 'attempt');
    expect(decisions).toHaveLength(1); expect(decisions[0].yieldAfterRetention).toBe(!stream);
    const attempts = writes.filter(write => write.outcome.type === 'attempt');
    // Streams and joined ordinary JSON retain directly; actual-budget JSON keeps
    // standalone delivery. Every final decision still uses retainRuntimeOutcome.
    expect(attempts).toHaveLength(stream || joinsReceipt ? 0 : 1);
    expect(streamRetention).toHaveBeenCalledTimes(stream ? 1 : 0);
    expect(preparedReceipts).toHaveBeenCalledTimes(stream || joinsReceipt ? 1 : 0);
    if (joinsReceipt) expect(decisionIoTurns).toEqual([true]);
    expect(attempts.every(write => write.yieldAfterRetention)).toBe(true);
    expect((await summary()).budget_committed_usd).toBe('0.001200000000000000');
    const inspect = runtime as unknown as { needsRetentionIoTurn(outcome: Parameters<CostLedgerService['persistRuntimeOutcome']>[0]): boolean };
    expect(inspect.needsRetentionIoTurn(decisions[0].outcome)).toBe(true);
    await runtime.runRequest('unrelated-scheduling-context', canonical, 'default-workspace', async () => { expect(inspect.needsRetentionIoTurn(decisions[0].outcome)).toBe(true); });
  });
  const consume = async () => {
    const stream = runtime.stream(canonical, target, async function* (observer): AsyncGenerator<CanonicalStreamEvent> {
      if (!observer) throw new Error('Expected priced dispatch observer');
      const receipt = await observer.begin({ node_id: target.node_id, wire_model: target.model, credential_id: 'synthetic', credential_strategy: 'single', credential_retry_index: 0, compatibility_retry_index: 0, dispatch_index: 0, protocol: 'chat_completions', dispatched_at: new Date().toISOString() });
      const usage = { input_tokens: 1000, output_tokens: 100 };
      attachUsageEvidence(usage, { usage: tokens(usage) });
      await receipt.streamFinished!(usage);
    });
    for await (const event of stream) expect(event).toBeUndefined();
  };
  it('drains every concurrently retained same-group stream receipt before actual settlement', async () => {
    await actual(true); const ready = gate(), release = gate(), delivered: string[] = [];
    const original = ledger.prepareStreamReceipt.bind(ledger); let entered = 0;
    jest.spyOn(ledger, 'prepareStreamReceipt').mockImplementation(async outcome => {
      if (++entered === 2) ready.release();
      await release.promise; const deliver = await original(outcome);
      return async () => { delivered.push(outcome.attemptId); await deliver(); };
    });
    await runtime.runRequest('synthetic-concurrent-streams', canonical, 'default-workspace', async () => {
      await runtime.admit(); const hold = await runtime.reserve(canonical, target, { input_tokens: 1000, output_tokens: 100 }, 2); expect(hold).not.toBeNull();
      const streams = Promise.all([consume(), consume()]);
      try { await bounded(ready.promise, 'Both streams must reach retention'); }
      finally { release.release(); await streams; }
      expect(delivered).toHaveLength(0);
      expect(await db.query("SELECT * FROM pricing_runtime_outcomes WHERE state='pending'")).toHaveLength(2);
      await hold!.commit(2200, 0.0024); expect(new Set(delivered).size).toBe(2);
    });
    expect((await summary()).budget_committed_usd).toBe('0.002400000000000000');
    expect((await db.query('SELECT state FROM pricing_runtime_outcomes')).every((row: { state: string }) => row.state === 'delivered')).toBe(true);
    expect(h.fetchMock.calls).toHaveLength(0);
  });
  it('fences new actual dispatch immediately even while retained delivery is blocked', async () => {
    await actual(true); const entered = gate(), release = gate(), original = ledger.prepareStreamReceipt.bind(ledger);
    jest.spyOn(ledger, 'prepareStreamReceipt').mockImplementation(async outcome => {
      const deliver = await original(outcome); return async () => { entered.release(); await release.promise; await deliver(); };
    });
    await runtime.runRequest('synthetic-closing-stream', canonical, 'default-workspace', async () => {
      await runtime.admit(); const hold = await runtime.reserve(canonical, target, { input_tokens: 1000, output_tokens: 100 }, 2); expect(hold).not.toBeNull();
      await consume(); const settlement = hold!.commit(1100, 0.0012);
      try {
        await bounded(entered.promise, 'Delivery did not begin');
        // This begin may wait for the previous delivery, but must be refused
        // once that wait ends, not admitted into the closing cohort.
        const late = expect(consume()).rejects.toThrow('cohort is closed');
        release.release(); await late; await settlement;
      } finally { release.release(); await settlement; }
    });
    expect(await db.query('SELECT * FROM pricing_attempts')).toHaveLength(1);
    expect((await summary()).budget_committed_usd).toBe('0.001200000000000000');
  });
  it('delivers inline if retention finishes after the owning action has already returned', async () => {
    await actual(true); const entered = gate(), release = gate(), original = ledger.prepareStreamReceipt.bind(ledger);
    let deliveryCalls = 0, stream: Promise<void> | undefined;
    jest.spyOn(ledger, 'prepareStreamReceipt').mockImplementation(async outcome => {
      entered.release(); await release.promise; const deliver = await original(outcome);
      return async () => { deliveryCalls++; await deliver(); };
    });
    try {
      await runtime.runRequest('synthetic-late-stream', canonical, 'default-workspace', async () => {
        await runtime.admit(); await runtime.reserve(canonical, target, { input_tokens: 1000, output_tokens: 100 }, 1);
        stream = consume(); await bounded(entered.promise, 'Retention did not begin');
      });
      expect(await runtime.renewActiveLeases()).toBe(1);
    } finally { release.release(); await stream; }
    expect(deliveryCalls).toBe(1); expect(await runtime.renewActiveLeases()).toBe(0);
    expect((await db.query('SELECT state FROM pricing_runtime_outcomes')).map((row: { state: string }) => row.state)).toEqual(['delivered']);
    // Returning a runtime action does not fabricate a missing budget closure.
    expect((await summary()).reservations[0].state).toBe('reserved');
  });
  it('keeps the lease while a returned action drains one receipt and a concurrent late stream finishes', async () => {
    await actual(true);
    const both = gate(), firstDelivery = gate(), releaseFirst = gate(), releaseSecond = gate();
    const original = ledger.prepareStreamReceipt.bind(ledger); let preparations = 0, second: Promise<void> | undefined;
    jest.spyOn(ledger, 'prepareStreamReceipt').mockImplementation(async outcome => {
      const ordinal = ++preparations; if (ordinal === 2) both.release();
      await both.promise; if (ordinal === 2) await releaseSecond.promise;
      const deliver = await original(outcome);
      return async () => { if (ordinal === 1) { firstDelivery.release(); await releaseFirst.promise; } await deliver(); };
    });
    let returned = false;
    const owner = runtime.runRequest('synthetic-draining-lease', canonical, 'default-workspace', async () => {
      await runtime.admit(); await runtime.reserve(canonical, target, { input_tokens: 1000, output_tokens: 100 }, 2);
      const first = consume(); second = consume(); await first;
    }).then(() => { returned = true; });
    try {
      await bounded(firstDelivery.promise, 'First retained receipt did not begin draining');
      releaseSecond.release(); await bounded(second!, 'Late stream did not finish');
      expect(returned).toBe(false);
      expect((await db.query('SELECT state FROM pricing_runtime_outcomes')).map((row: { state: string }) => row.state).sort()).toEqual(['delivered', 'pending']);
      expect(await runtime.renewActiveLeases()).toBe(1);
    } finally { both.release(); releaseFirst.release(); releaseSecond.release(); await second; await owner; }
    expect(await runtime.renewActiveLeases()).toBe(0);
    expect((await summary()).reservations[0].state).toBe('reserved');
  });
  it.each([false, true])("ends HTTP after durable retention without waiting for slow delivery, but drains before debit/teardown (actual=%s)", async enabled => {
    await actual(enabled); const entered = gate(), release = gate(), original = ledger.completeAttempt.bind(ledger);
    jest.spyOn(ledger, 'completeAttempt').mockImplementation(async (...args) => { entered.release(); await release.promise; return original(...args); });
    const reply = request();
    try {
      await bounded(entered.promise, 'Delivery did not begin'); const client = await bounded(reply, 'HTTP waited for post-retention delivery');
      expect(client.status).toBe(200); expect(client.text).toContain('[DONE]');
      const retained = await db.query('SELECT * FROM pricing_runtime_outcomes'); expect(retained).toHaveLength(1); expect(retained[0]).toMatchObject({ kind: 'attempt', state: 'pending' });
      expect(JSON.parse(retained[0].outcome_json).cost.report_amount).toBe('0.001200000');
      expect(retained[0].outcome_json).not.toMatch(/PRIVATE-/);
      expect((await db.query('SELECT state FROM pricing_attempts'))[0].state).toBe('dispatched');
      expect(await db.query("SELECT * FROM pricing_budget_effects WHERE kind='commit'")).toHaveLength(0);
      const pendingView = await h.agent.get(`/api/dashboard/pricing/requests/${retained[0].request_id}/cost`);
      expect(pendingView.status).toBe(200);
      expect(pendingView.body).toMatchObject({ status: 'pending', amount: null, pending_attempts: 1 });
      expect(Number(pendingView.body.budget_reserved_usd)).toBeGreaterThan(0);
      let drained = false; const draining = runtime.waitForRequests().then(() => { drained = true; }); await new Promise(resolve => setImmediate(resolve)); expect(drained).toBe(false);
      expect(await runtime.renewActiveLeases()).toBe(1); release.release(); await draining;
      const cost = await summary(); expect(cost.budget_committed_usd).toBe('0.001200000000000000'); expect(cost.reservations[0].state).toBe('committed');
      expect((await db.query('SELECT state FROM pricing_runtime_outcomes')).every((row: { state: string }) => row.state === 'delivered')).toBe(true);
      const logs = (await h.agent.get('/api/dashboard/logs')).body.data;
      const log = logs.find((row: { request_id: string }) => row.request_id === retained[0].request_id);
      expect(log).toBeDefined();
      const detail = await h.agent.get(`/api/dashboard/logs/${log.id}/cost-breakdown`);
      expect(detail.body.amount).toBe('0.001200000000000000');
      expect(h.fetchMock.calls).toHaveLength(1);
    } finally { release.release(); await reply; }
  });
  it.each([false, true])("does not end HTTP before the immutable stream receipt commits (actual=%s)", async enabled => {
    await actual(enabled); const entered = gate(), release = gate(), original = ledger.prepareStreamReceipt.bind(ledger);
    jest.spyOn(ledger, 'prepareStreamReceipt').mockImplementation(async outcome => { entered.release(); await release.promise; return original(outcome); });
    let ended = false; const reply = request().then(result => { ended = true; return result; });
    try {
      await bounded(entered.promise, 'Stream did not reach retention'); await new Promise(resolve => setTimeout(resolve, 30));
      expect(ended).toBe(false); expect(await db.query('SELECT * FROM pricing_runtime_outcomes')).toHaveLength(0);
      release.release(); expect((await reply).status).toBe(200); expect((await summary()).budget_committed_usd).toBe('0.001200000000000000');
    } finally { release.release(); await reply; }
  });
  it.each([false, true])("keeps the receipt recoverable when delivery acknowledgement fails (actual=%s)", async enabled => {
    await actual(enabled); const original = InsertQueryBuilder.prototype.execute;
    const fault = jest.spyOn(InsertQueryBuilder.prototype, 'execute').mockImplementation(function (this: InsertQueryBuilder<Record<string, unknown>>) {
      if (this.getQuery().includes('pricing_audit_events') && JSON.stringify(this.getParameters()).includes('cost.outcome_delivered')) throw new Error('Synthetic delivery audit outage');
      return original.call(this);
    });
    expect((await request()).status).toBe(200); await runtime.waitForRequests();
    expect((await summary()).reservations[0].state).toBe('reserved'); expect(await db.query("SELECT * FROM pricing_runtime_outcomes WHERE state='pending'")).not.toHaveLength(0);
    fault.mockRestore(); const fresh = new CostLedgerService(db, h.app.get(BudgetService));
    await fresh.replayRuntimeOutcomes(new Date(Date.now() + 120000)); await fresh.reconcilePending(); await fresh.reconcileActualBudgets();
    expect((await summary()).budget_committed_usd).toBe('0.001200000000000000');
    await fresh.replayRuntimeOutcomes(new Date(Date.now() + 240000)); expect(await db.query("SELECT * FROM pricing_budget_effects WHERE kind='commit'")).toHaveLength(1);
    expect(h.fetchMock.calls).toHaveLength(1);
  });
  it('retains missing streamed usage as unknown actual expense, not a free completion', async () => {
    await actual(true);
    h.fetchMock.setHandler(async () => new Response('data: {"choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }));
    expect((await request()).status).toBe(200); const cost = await summary();
    expect(cost.amount).toBeNull(); expect(cost.reservations[0].state).toBe('reserved');
    expect(cost.attempts[0].cost?.status).toBe('missing_usage');
    expect(await db.query("SELECT * FROM pricing_budget_effects WHERE kind='commit'")).toHaveLength(0);
    expect((await db.query('SELECT state FROM pricing_runtime_outcomes')).every((row: { state: string }) => row.state === 'delivered')).toBe(true);
    expect(h.fetchMock.calls).toHaveLength(1);
  });
  it.each([false, true])('uses one final raw cumulative receipt despite repeated SSE usage frames (actual=%s)', async enabled => {
    await actual(enabled);
    h.fetchMock.setHandler(async () => new Response([2, 100, 100].map(output => `data: ${JSON.stringify({ id: 'synthetic', model: 'gpt-4o', choices: [], usage: { prompt_tokens: 1000, completion_tokens: output, prompt_tokens_details: { cached_tokens: 0 }, cache_creation_input_tokens: 0 } })}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }));
    expect((await request()).status).toBe(200); const cost = await summary();
    expect(cost.provider_attempts).toBe(1); expect(cost.budget_committed_usd).toBe('0.001200000000000000');
    expect(await db.query("SELECT * FROM pricing_runtime_outcomes WHERE kind='attempt'")).toHaveLength(1);
    expect(await db.query("SELECT * FROM pricing_budget_effects WHERE kind='commit'")).toHaveLength(1);
    expect(h.fetchMock.calls).toHaveLength(1);
  });
  it.each([false, true])('retries accounting, not the provider, after the first retention transaction rolls back (actual=%s)', async enabled => {
    await actual(enabled); const original = InsertQueryBuilder.prototype.execute; let failed = false;
    jest.spyOn(InsertQueryBuilder.prototype, 'execute').mockImplementation(function (this: InsertQueryBuilder<Record<string, unknown>>) {
      if (!failed && this.getQuery().includes('pricing_audit_events') && JSON.stringify(this.getParameters()).includes('cost.outcome_retained')) {
        failed = true; throw new Error('Synthetic first retention audit failure');
      }
      return original.call(this);
    });
    expect((await request()).status).toBe(200); expect(failed).toBe(true);
    expect((await summary()).budget_committed_usd).toBe('0.001200000000000000');
    expect(await db.query("SELECT * FROM pricing_runtime_outcomes WHERE kind='attempt'")).toHaveLength(1);
    expect(await db.query("SELECT * FROM pricing_budget_effects WHERE kind='commit'")).toHaveLength(1);
    expect(h.fetchMock.calls).toHaveLength(1);
  });
});

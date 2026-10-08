import * as assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { load, dump } from 'js-yaml';
import { DataSource } from 'typeorm';
import { API_KEY, createE2EHarness, FIXTURE_PATH, type E2EHarness } from '../e2e/setup';
import { applyPricingSchema, PRICING_TABLE_NAMES } from '../../src/pricing/pricing-schema';
import { PricingRecoveryService } from '../../src/pricing/pricing-recovery.service';
import { PricingRuntimeService } from '../../src/pricing/pricing-runtime.service';
import type { CostLedgerSummary, CostReservationRow } from '../../src/pricing/cost-ledger.types';
import type { CostComputation } from '../../src/pricing/pricing.types';
import type { PricingAdmissionPolicy } from '../../src/pricing/pricing-admission.types';
import { tokenBook, book, rate } from '../unit/pricing-fixtures';

const base = '/api/dashboard/pricing';
const microMoney = (micro: bigint) => `${micro / 1000000n}.${String(micro % 1000000n).padStart(6, '0')}000000000000`;
export const boundaryTarget = { node_id: 'mock-openai', model: 'gpt-4o', operation: 'chat_completions' };
export async function boundaryHarness(directory: string, frontendRoot?: string) {
  const config = load(readFileSync(FIXTURE_PATH, 'utf8')) as Record<string, unknown>;
  config.cache = { enabled: false }; config.semantic_cache = { enabled: false };
  config.budget = { daily_token_limit: 10000000, daily_cost_limit: 1000, alert_threshold: 0.8 };
  const routing = config.routing as Record<string, unknown>;
  routing.retry = { max_retries: 2, backoff_base_ms: 1, backoff_max_ms: 1, retryable_status: [500, 502, 503, 504] };
  routing.tiers = Object.fromEntries(['simple', 'standard', 'complex', 'reasoning'].map(tier => [tier, { primary: { node: boundaryTarget.node_id, model: boundaryTarget.model }, fallbacks: [] }]));
  Object.assign((config.nodes as Record<string, unknown>[])[0], { credentials: ['a', 'b', 'c'].map(id => ({ id, api_key: `synthetic-${id}` })), credential_pool: { enabled: true, strategy: 'round_robin', retry_on_status: [429, 503] } });
  const file = join(directory, 'config.yaml'); writeFileSync(file, dump(config));
  const h = await createE2EHarness(file, { frontendRoot }); await h.app.get(PricingRecoveryService).onModuleDestroy(); await applyPricingSchema(h.app.get(DataSource)); return h;
}
export async function boundaryState(h: E2EHarness) {
  const rows: Record<string, unknown> = {};
  for (const name of [...PRICING_TABLE_NAMES, 'budget_rules', 'call_logs']) rows[name] = await h.app.get(DataSource).query(`SELECT * FROM ${name}`);
  return { rows, provider_calls: h.fetchMock.calls.length };
}
export async function boundaryPublish(h: E2EHarness, content = tokenBook()) {
  const created = await h.agent.post(base + '/books').send({ name: 'Synthetic boundary rates', content }); assert.equal(created.status, 201, JSON.stringify(created.body));
  const head = (await h.agent.get(base + '/bindings')).body.head;
  const options = { draft_revision: 1, catalog_revision: head.revision, reason: 'Synthetic boundary fixture', confirm: true, targets: [{ level: 'node', ...boundaryTarget }] };
  const published = await h.agent.post(`${base}/drafts/${created.body.draft.id}/publish`).send(options); assert.equal(published.status, 201, JSON.stringify(published.body));
  return { bookId: created.body.book.id as string, versionId: published.body.version_id as string, content };
}
export async function boundaryPolicy(h: E2EHarness, policy: PricingAdmissionPolicy) {
  const head = (await h.agent.get(base + '/bindings')).body.head;
  const result = await h.agent.put(base + '/admission-policy').send({ catalog_revision: head.revision, scope: 'workspace', operation: boundaryTarget.operation, reason: 'Synthetic explicit policy', confirm: true, policy }); assert.equal(result.status, 200, JSON.stringify(result.body));
}
export function boundaryResponse(usage: Record<string, unknown> | null, stream: boolean, status = 200) {
  const body = { id: 'synthetic-boundary', model: boundaryTarget.model, ...(status === 200 ? { choices: [{ index: 0, message: { role: 'assistant', content: 'Synthetic boundary response' }, finish_reason: 'stop' }] } : { error: { message: 'Synthetic throttling' } }), ...(usage ? { usage } : {}) };
  return stream && status === 200 ? new Response(`data: ${JSON.stringify({ ...body, choices: [] })}\n\ndata: ${JSON.stringify({ ...body, choices: [] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } }) : new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
export async function boundaryCall(h: E2EHarness, stream = false) {
  const response = await h.agent.post('/v1/chat/completions').set('Authorization', `Bearer ${API_KEY}`).send({ model: boundaryTarget.model, max_tokens: 10, stream, messages: [{ role: 'user', content: 'x'.repeat(400) }] });
  assert.equal(response.status, 200); await h.app.get(PricingRuntimeService).waitForRequests();
  const log = await h.callLogRepo.findOne({ where: {}, order: { id: 'DESC' } }); assert.ok(log);
  const reply = await h.agent.get(`/api/dashboard/logs/${log.id}/cost-breakdown`); assert.equal(reply.status, 200);
  return { log: { id: log.id, request_id: log.request_id }, detail: reply.body as CostLedgerSummary };
}
export async function boundaryReport(h: E2EHarness, request: string) {
  const response = await h.agent.get(base + '/cost-report').query({ from: new Date(Date.now() - 86400000).toISOString(), to: new Date(Date.now() + 10000).toISOString() }); assert.equal(response.status, 200);
  const row = response.body.rows.find((row: { request_id: string }) => row.request_id === request); assert.ok(row); return row;
}
export const INVALID_USAGE_CASES = ['negative', 'not-a-number', 'unsafe-number', 'cache-over-total', 'large-exact-string'] as const;
export async function runInvalidUsage(h: E2EHarness, kind: typeof INVALID_USAGE_CASES[number], stream: boolean) {
  const published = await boundaryPublish(h), beforeCalls = h.fetchMock.calls.length;
  await boundaryPolicy(h, { mode: 'compatibility' });
  const raw: Record<string, unknown> = { prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: kind === 'cache-over-total' ? 20 : 0 }, cache_creation_input_tokens: 0 };
  if (kind === 'negative') raw.completion_tokens = -1;
  if (kind === 'not-a-number') raw.completion_tokens = 'NaN';
  if (kind === 'unsafe-number') raw.completion_tokens = Number.MAX_SAFE_INTEGER + 1;
  if (kind === 'large-exact-string') raw.completion_tokens = '9007199254740993';
  h.fetchMock.setHandler(async () => boundaryResponse(raw, stream));
  const actual = await boundaryCall(h, stream), cost = actual.detail.attempts[0].cost!;
  assert.equal(actual.detail.provider_attempts, 1); assert.equal(h.fetchMock.calls.length - beforeCalls, 1);
  const valid = kind === 'large-exact-string';
  if (valid) {
    assert.equal(cost.usage.quantities.output_tokens?.value, '9007199254740993');
    assert.equal(cost.amount, '18014398509.481996000');
  } else {
    assert.equal(cost.amount, null); assert.notEqual(cost.status, 'free');
    assert.ok(cost.diagnostics.some(d => d.code === (kind === 'cache-over-total' ? 'pricing_usage_conflict' : 'pricing_invalid_quantity')));
  }
  const values: Record<string, unknown> = { total_input_tokens: '10', uncached_input_tokens: kind === 'cache-over-total' ? null : '10', output_tokens: raw.completion_tokens, cache_read_tokens: kind === 'cache-over-total' ? '20' : '0', cache_write_tokens: '0', cache_write_5m_tokens: '0', cache_write_1h_tokens: '0' };
  const evidence = Object.entries(values).map(([dimension, value]) => ({ dimension, value, source: 'request_metadata', quality: value === null ? 'missing' : 'observed' }));
  const before = await boundaryState(h), quoted = await h.agent.post(base + '/quote').send({ book_id: published.bookId, version_id: published.versionId, report_currency: 'USD', evidence }); assert.equal(quoted.status, 201);
  assert.equal(quoted.body.cost.report_amount, cost.report_amount); assert.equal(quoted.body.cost.status, cost.status);
  const report = await boundaryReport(h, actual.log.request_id); assert.equal(report.amount_usd, actual.detail.amount);
  assert.deepEqual(await boundaryState(h), before);
  return { id: `calc14-${kind}-${stream}`, kind, stream, published, evidence, quote: quoted.body.cost as CostComputation, ...actual, report };
}
export async function runUnknownAttempts(h: E2EHarness, stream: boolean) {
  const published = await boundaryPublish(h); await boundaryPolicy(h, { mode: 'compatibility' });
  let calls = 0;
  const usage = { prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 0 }, cache_creation_input_tokens: 0 };
  h.fetchMock.setHandler(async () => boundaryResponse(++calls === 1 ? null : usage, stream, calls < 3 ? 429 : 200));
  const actual = await boundaryCall(h, stream);
  assert.equal(calls, 3); assert.equal(actual.detail.provider_attempts, 3); assert.equal(actual.detail.unknown_attempts, 1); assert.equal(actual.detail.amount, null); assert.equal(actual.detail.known_subtotal, '0.000040000000000000');
  const before = await boundaryState(h), quoted = [];
  for (const attempt of actual.detail.attempts) {
    const evidence = Object.values(attempt.cost!.usage.quantities).filter(q => q !== undefined).map(q => ({ dimension: q!.dimension, value: q!.value, source: q!.source, quality: q!.quality }));
    const response = await h.agent.post(base + '/quote').send({ book_id: published.bookId, version_id: published.versionId, report_currency: 'USD', evidence }); assert.equal(response.status, 201); assert.equal(response.body.cost.report_amount, attempt.cost!.report_amount); quoted.push({ evidence, quote: response.body.cost as CostComputation });
  }
  const report = await boundaryReport(h, actual.log.request_id); assert.equal(report.amount_usd, null); assert.equal(report.known_subtotal_usd, '0.000040000000000000'); assert.equal(report.unknown_attempts, 1);
  assert.deepEqual(await boundaryState(h), before);
  return { id: `calc18-three-attempts-${stream}`, stream, published, quoted, ...actual, report };
}
export async function runReservationBoundary(h: E2EHarness, mode: 'compatibility' | 'reserve_upper_bound', stream: boolean) {
  const content = tokenBook(); content.groups[0].rules[0].rates.find(rate => rate.component.dimension === 'cache_write_1h_tokens')!.component.amount = '20';
  content.groups.push({ id: 'long', order: 1, required: false, rules: [{ id: 'long-rate', priority: 1, mode: 'whole_request', condition: { input_tokens: { min: '201' } }, rates: [{ operation: 'replace', component: rate('long-input', 'uncached_input_tokens', '1000') }, { operation: 'replace', component: rate('long-write', 'cache_write_1h_tokens', '1000') }] }] });
  const published = await boundaryPublish(h, content);
  await boundaryPolicy(h, { mode, budget_basis: 'actual_upstream', ...(mode === 'reserve_upper_bound' ? { quantity_limits: { total_input_tokens: '200', output_tokens: '10' }, limit_reference: 'Synthetic bound200/10' } : {}) });
  let held: CostReservationRow | undefined, input = 0;
  h.fetchMock.setHandler(async () => {
    const rows = await h.app.get(DataSource).query("SELECT * FROM pricing_reservations WHERE state = 'reserved' ORDER BY created_at DESC"); held = rows[0] as CostReservationRow;
    const estimate = JSON.parse(held.estimate_json) as CostComputation;
    assert.equal(estimate.admission?.attempts, 9); input = mode === 'reserve_upper_bound' ? 200 : Number(estimate.usage.quantities.total_input_tokens!.value);
    assert.ok(input < 201 && input * 9 >= 201); assert.ok(!estimate.selected_rule_ids.includes('long-rate'));
    return boundaryResponse({ prompt_tokens: input, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 0 }, cache_creation_input_tokens: input, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: input } }, stream);
  });
  const actual = await boundaryCall(h, stream); assert.ok(held); const estimate = JSON.parse(held.estimate_json) as CostComputation;
  const expected = microMoney(BigInt(input) * 20n + 20n);
  assert.equal(actual.detail.amount, expected); assert.equal(actual.detail.budget_committed_usd, expected); assert.ok(!actual.detail.attempts[0].cost!.selected_rule_ids.includes('long-rate'));
  if (mode === 'reserve_upper_bound') assert.equal(held.reserved_cost_usd, '0.042660000000000000');
  else assert.equal(held.reserved_cost_usd, microMoney((BigInt(input) * 20n + 20n) * 9n));
  const before = await boundaryState(h), evidence = Object.values(estimate.usage.quantities).filter(q => q !== undefined).map(q => ({ dimension: q!.dimension, value: q!.value, source: q!.source, quality: q!.quality }));
  const preview = await h.agent.post(base + '/admission-preview').send({ target: boundaryTarget, attempts: 9, evidence }); assert.equal(preview.status, 201, JSON.stringify(preview.body));
  assert.equal(preview.body.assessment.reserved_cost_usd, held.reserved_cost_usd);
  const actualEvidence = Object.values(actual.detail.attempts[0].cost!.usage.quantities).filter(q => q !== undefined).map(q => ({ dimension: q!.dimension, value: q!.value, source: q!.source, quality: q!.quality }));
  const quote = await h.agent.post(base + '/quote').send({ book_id: published.bookId, version_id: published.versionId, evidence: actualEvidence, report_currency: 'USD' }); assert.equal(quote.status, 201); assert.equal(quote.body.cost.report_amount, actual.detail.attempts[0].cost!.report_amount);
  const report = await boundaryReport(h, actual.log.request_id); assert.equal(report.amount_usd, expected); assert.deepEqual(await boundaryState(h), before);
  return { id: `calc23-24-${mode}-${stream}`, mode, stream, published, held, estimate, evidence, actualEvidence, quote: quote.body.cost as CostComputation, preview: preview.body, ...actual, report };
}
export const REJECTED_PRICE_CASES = ['implicit-media', 'token-subset', 'rule-overlap', 'wrong-unit'] as const;
export async function runRejectedPrice(h: E2EHarness, kind: typeof REJECTED_PRICE_CASES[number]) {
  const published = await boundaryPublish(h); await boundaryPolicy(h, { mode: 'compatibility' });
  const content = kind === 'implicit-media' ? book([rate('image', 'image_count', '0.04', '1'), rate('output', 'output_tokens', '2')]) : kind === 'token-subset' ? { ...book([rate('output', 'output_tokens', '2'), rate('audio', 'audio_output_tokens', '3')]), allow_combined_media: true } : tokenBook();
  if (kind === 'wrong-unit') Object.assign(content.groups[0].rules[0].rates[0].component, { unit: 'second' });
  if (kind === 'rule-overlap') content.groups[0].rules.push({ ...content.groups[0].rules[0], id: 'ambiguous', rates: content.groups[0].rules[0].rates.map(entry => ({ ...entry, component: { ...entry.component, id: 'overlap-' + entry.component.id } })) });
  const before = await boundaryState(h), validation = await h.agent.post(base + '/import/validate').send({ format: 'siftgate-price-book-v1', content });
  assert.equal(validation.status, 400); const rejected = await h.agent.post(base + '/books').send({ name: 'Rejected candidate', content }); assert.equal(rejected.status, 400);
  assert.deepEqual(await boundaryState(h), before);
  h.fetchMock.setHandler(async () => boundaryResponse({ prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 0 }, cache_creation_input_tokens: 0 }, false));
  const actual = await boundaryCall(h); assert.equal(actual.detail.amount, '0.000020000000000000'); assert.equal(actual.detail.attempts[0].cost!.version_id, published.versionId);
  return { id: `calc15-state09-${kind}`, kind, published, content, validation: validation.body, ...actual };
}
export async function runOverlappingActivation(h: E2EHarness) {
  const published = await boundaryPublish(h); await boundaryPolicy(h, { mode: 'compatibility' });
  const created = await h.agent.post(base + '/books').send({ name: 'Synthetic future price', content: tokenBook() }); assert.equal(created.status, 201);
  const head = (await h.agent.get(base + '/bindings')).body.head;
  const future = new Date(Date.now() + 3600000).toISOString(), options = { draft_revision: 1, catalog_revision: head.revision, effective_from: future, reason: 'Synthetic future activation', confirm: true, targets: [{ level: 'node', ...boundaryTarget }] };
  const scheduled = await h.agent.post(`${base}/drafts/${created.body.draft.id}/publish`).send(options); assert.equal(scheduled.status, 201);
  const duplicate = await h.agent.post(base + '/books').send({ name: 'Synthetic overlapping candidate', content: tokenBook() }); assert.equal(duplicate.status, 201);
  const before = await boundaryState(h), rejected = await h.agent.post(`${base}/drafts/${duplicate.body.draft.id}/publish`).send({ ...options, catalog_revision: scheduled.body.head.revision });
  assert.equal(rejected.status, 409); assert.equal(rejected.body.error.code, 'pricing_activation_conflict'); assert.deepEqual(await boundaryState(h), before);
  h.fetchMock.setHandler(async () => boundaryResponse({ prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 0 }, cache_creation_input_tokens: 0 }, false));
  const actual = await boundaryCall(h); assert.equal(actual.detail.amount, '0.000020000000000000'); assert.equal(actual.detail.attempts[0].cost!.version_id, published.versionId);
  return { id: 'state09-overlap', published, candidate: duplicate.body, future, head: scheduled.body.head, ...actual };
}

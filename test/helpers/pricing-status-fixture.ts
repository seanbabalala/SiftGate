import * as assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { load, dump } from 'js-yaml';
import { DataSource } from 'typeorm';
import { API_KEY, createE2EHarness, FIXTURE_PATH, type E2EHarness } from '../e2e/setup';
import { applyPricingSchema, PRICING_TABLE_NAMES } from '../../src/pricing/pricing-schema';
import { PricingRecoveryService } from '../../src/pricing/pricing-recovery.service';
import { PricingRuntimeService } from '../../src/pricing/pricing-runtime.service';
import type { PricingLogCost } from '../../src/pricing/pricing-log.types';
import type { CostComputation, PriceBookContent, PricingContext, PricingStatus } from '../../src/pricing/pricing.types';
import { tokenBook, book, rate } from '../unit/pricing-fixtures';

export const STATUS_CASES = ['priced', 'estimated', 'partial', 'unpriced', 'missing_usage', 'free', 'legacy_estimate', 'pending', 'expired-calendar', 'unknown-media'] as const;
export type StatusCase = typeof STATUS_CASES[number];
const base = '/api/dashboard/pricing';
export async function statusHarness(directory: string, frontendRoot?: string) {
  const config = load(readFileSync(FIXTURE_PATH, 'utf8')) as Record<string, unknown>;
  config.cache = { enabled: false }; config.semantic_cache = { enabled: false };
  config.budget = { daily_token_limit: 10000000, daily_cost_limit: 1000, alert_threshold: 0.8 };
  (config.routing as Record<string, unknown>).retry = { max_retries: 0 };
  const node = (config.nodes as Record<string, unknown>[])[0];
  node.models = [...node.models as string[], ...STATUS_CASES.map(kind => `synthetic-state-${kind}`)];
  node.audio_models = [...node.audio_models as string[], 'synthetic-state-missing_usage'];
  node.video_models = [...node.video_models as string[], 'synthetic-state-pending'];
  node.image_models = [...node.image_models as string[], 'synthetic-state-unknown-media'];
  const path = join(directory, 'config.yaml'); writeFileSync(path, dump(config));
  const h = await createE2EHarness(path, { frontendRoot }); await h.app.get(PricingRecoveryService).onModuleDestroy(); await applyPricingSchema(h.app.get(DataSource)); return h;
}
export async function statusState(h: E2EHarness) {
  const rows: Record<string, unknown> = {};
  for (const name of [...PRICING_TABLE_NAMES, 'budget_rules', 'call_logs']) rows[name] = await h.app.get(DataSource).query(`SELECT * FROM ${name}`);
  return { rows, provider_calls: h.fetchMock.calls.length };
}
export async function runStatusScenario(h: E2EHarness, kind: StatusCase, stream = false) {
  const model = `synthetic-state-${kind}`;
  const operation = kind === 'missing_usage' ? 'audio_transcription' : kind === 'pending' ? 'video_generation' : kind === 'unknown-media' ? 'image_generation' : 'chat_completions';
  let content: PriceBookContent = tokenBook(), rawUsage: Record<string, unknown> = { prompt_tokens: 1000, completion_tokens: 500, prompt_tokens_details: { cached_tokens: 0 }, cache_creation_input_tokens: 0 };
  const expected: PricingStatus = kind === 'expired-calendar' || kind === 'unknown-media' ? 'unpriced' : kind;
  if (kind === 'estimated') rawUsage = { prompt_tokens: 1000, completion_tokens: 500 };
  if (kind === 'partial') rawUsage.completion_tokens = -1;
  if (kind === 'unpriced') content.currency = 'CNY';
  if (kind === 'free') for (const entry of content.groups[0].rules[0].rates) { entry.component.amount = '0'; entry.component.free = true; }
  if (kind === 'legacy_estimate') content.source.kind = 'legacy';
  if (kind === 'missing_usage') content = book([rate('audio', 'audio_input_seconds', '0.01', '1')]);
  if (kind === 'pending') content = book([rate('video', 'video_seconds', '0.1', '1')]);
  if (kind === 'unknown-media') {
    content = book([rate('image', 'image_count', '0.04', '1')]);
    content.groups.push({ id: 'quality', order: 1, required: true, rules: [
      { id: 'cheap-fallback', mode: 'whole_request', priority: 0, condition: {}, rates: [] },
      { id: 'standard', mode: 'whole_request', priority: 1, condition: { media: { quality: ['standard'] } }, rates: [] },
      { id: 'high', mode: 'whole_request', priority: 1, condition: { media: { quality: ['high'] } }, rates: [{ operation: 'replace', component: rate('high-image', 'image_count', '0.1', '1') }] },
    ] });
  }
  const year = new Date().getUTCFullYear();
  if (kind === 'expired-calendar') {
    content.calendar = { schema_version: 1, version_id: 'synthetic-calendar', time_zone: 'UTC', tzdb_version: process.versions.tz ?? 'unknown', valid_from: `${year}-01-01`, valid_to: `${year + 1}-01-01`, default_tag: 'cheap', weekly: [], holidays: [], date_overrides: [] };
    content.time_basis = 'attempt_dispatched_at';
    content.groups.push({ id: 'time', order: 1, required: true, rules: [{ id: 'cheap', priority: 0, mode: 'whole_request', condition: { time_tags: ['cheap'] }, rates: [] }] });
  }
  const created = await h.agent.post(base + '/books').send({ name: `Synthetic state ${kind}`, content }); assert.equal(created.status, 201, JSON.stringify(created.body));
  const head = (await h.agent.get(base + '/bindings')).body.head;
  const published = await h.agent.post(`${base}/drafts/${created.body.draft.id}/publish`).send({ draft_revision: 1, catalog_revision: head.revision, reason: 'Synthetic external status', confirm: true, targets: [{ level: kind === 'legacy_estimate' ? 'legacy' : 'model', model, operation }] }); assert.equal(published.status, 201, JSON.stringify(published.body));
  const policy = await h.agent.put(base + '/admission-policy').send({ catalog_revision: published.body.head.revision, scope: 'workspace', operation, reason: 'Synthetic state policy', confirm: true, policy: { mode: kind === 'pending' ? 'reserve_upper_bound' : 'compatibility', budget_basis: 'actual_upstream', ...(operation === 'chat_completions' ? {} : { token_budget: 'not_applicable' }), ...(kind === 'pending' ? { quantity_limits: { video_seconds: '8' }, limit_reference: 'Synthetic video cap' } : {}) } }); assert.equal(policy.status, 200, JSON.stringify(policy.body));
  const beforeCalls = h.fetchMock.calls.length;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  h.fetchMock.setHandler(async () => {
    if (kind === 'missing_usage') return json({ text: 'Synthetic transcription', usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
    if (kind === 'pending') return json({ id: 'synthetic-pending-job', status: 'queued' }, 202);
    if (kind === 'unknown-media') return json({ data: [{ b64_json: 'synthetic-image' }] });
    const body = { id: 'synthetic-state', model, choices: [{ index: 0, message: { role: 'assistant', content: 'Synthetic state' }, finish_reason: 'stop' }], usage: rawUsage };
    return stream ? new Response(`data: ${JSON.stringify({ ...body, choices: [] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } }) : json(body);
  });
  const now = Date.now;
  try {
    if (kind === 'expired-calendar') Date.now = () => Date.parse(`${year + 1}-01-01T00:00:00.000Z`);
    const path = operation === 'chat_completions' ? '/v1/chat/completions' : operation === 'audio_transcription' ? '/v1/audio/transcriptions' : operation === 'video_generation' ? '/v1/videos/generations' : '/v1/images/generations';
    const payload = operation === 'chat_completions' ? { model, max_tokens: 500, stream, messages: [{ role: 'user', content: 'Synthetic status' }] } : { model, ...(kind === 'pending' ? { seconds: 8, prompt: 'Synthetic video' } : kind === 'unknown-media' ? { n: 1, quality: 'unexpected', size: '1024x1024', prompt: 'Synthetic image' } : {}) };
    const reply = await h.agent.post(path).set('Authorization', `Bearer ${API_KEY}`).send(payload); assert.ok([200, 202].includes(reply.status), JSON.stringify(reply.body)); await h.app.get(PricingRuntimeService).waitForRequests();
  } finally { Date.now = now; }
  assert.equal(h.fetchMock.calls.length - beforeCalls, 1);
  const log = await h.callLogRepo.findOne({ where: { model }, order: { id: 'DESC' } }); assert.ok(log);
  const before = await statusState(h), detailResponse = await h.agent.get(`/api/dashboard/logs/${log.id}/cost-breakdown`); assert.equal(detailResponse.status, 200);
  const detail = detailResponse.body as PricingLogCost; assert.ok('attempts' in detail);
  const cost = detail.attempts[0].cost;
  assert.equal(detail.status, expected, `Request status ${kind}`);
  if (kind === 'pending') { assert.equal(detail.amount, null); assert.equal(detail.budget_reserved_usd, '0.800000000000000000'); assert.equal(detail.budget_committed_usd, '0.000000000000000000'); }
  else {
    assert.ok(cost); assert.equal(cost.status, expected, `Attempt status ${kind}`);
    if (kind === 'expired-calendar' || kind === 'unknown-media' || kind === 'unpriced') {
      assert.equal(detail.amount, null); assert.equal(cost.report_amount, null);
      const diagnostic = kind === 'expired-calendar' ? 'pricing_calendar_unavailable' : kind === 'unknown-media' ? 'pricing_unknown_variant' : 'pricing_fx_missing';
      assert.ok(cost.diagnostics.some(d => d.code === diagnostic));
    }
  }
  let quote: CostComputation | null = null;
  if (cost) {
    const evidence = Object.values(cost.usage.quantities).filter(q => q !== undefined).map(q => ({ dimension: q!.dimension, value: q!.value, source: q!.source, quality: q!.quality }));
    const selection = cost.selection;
    const context: PricingContext = { attempt_dispatched_at: detail.attempts[0].dispatched_at, ...(selection ? { requested_service_tier: selection.requested_service_tier ?? undefined, resolved_service_tier: selection.resolved_service_tier ?? undefined, media: selection.media } : {}) };
    const result = await h.agent.post(base + '/quote').send({ book_id: created.body.book.id, version_id: published.body.version_id, report_currency: 'USD', evidence, context }); assert.equal(result.status, 201); quote = result.body.cost;
    assert.equal(quote!.report_amount, cost.report_amount); assert.equal(quote!.status, cost.status);
  }
  const report = await h.agent.get(base + '/cost-report').query({ from: `${year}-01-01T00:00:00Z`, to: `${year + 1}-01-02T00:00:00Z` }); assert.equal(report.status, 200, JSON.stringify(report.body));
  const reportRow = report.body.rows.find((row: { request_id: string }) => row.request_id === log.request_id); assert.ok(reportRow); assert.equal(reportRow.status, expected); assert.equal(reportRow.amount_usd, detail.amount);
  const compact = await h.agent.get(base + '/log-cost-summaries').query({ ids: String(log.id) }); assert.equal(compact.status, 200); assert.equal(compact.body.rows[0].status, expected);
  assert.deepEqual(await statusState(h), before);
  return { kind, stream, expected, operation, model, content, bookId: created.body.book.id as string, versionId: published.body.version_id as string, log: { id: log.id, request_id: log.request_id }, detail, quote, reportRow };
}

import * as assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { load, dump } from 'js-yaml';
import { DataSource } from 'typeorm';
import { createE2EHarness, FIXTURE_PATH, API_KEY, type E2EHarness } from '../e2e/setup';
import { PricingRecoveryService } from '../../src/pricing/pricing-recovery.service';
import { PricingRuntimeService } from '../../src/pricing/pricing-runtime.service';
import { applyPricingSchema, PRICING_TABLE_NAMES } from '../../src/pricing/pricing-schema';
import type { PricingLogCost } from '../../src/pricing/pricing-log.types';
import { tokenBook } from '../unit/pricing-fixtures';

export async function cacheReferenceHarness(directory: string, frontendRoot?: string) {
  const config = load(readFileSync(FIXTURE_PATH, 'utf8')) as Record<string, unknown>;
  config.cache = { enabled: true, ttl_seconds: 300, max_entries: 100, exclude_tool_use: true };
  config.semantic_cache = { enabled: false };
  config.budget = { daily_token_limit: 10000000, daily_cost_limit: 1000, alert_threshold: 0.8 };
  (config.routing as Record<string, unknown>).retry = { max_retries: 0 };
  const file = join(directory, 'config.yaml'); writeFileSync(file, dump(config));
  const h = await createE2EHarness(file, { frontendRoot }); await h.app.get(PricingRecoveryService).onModuleDestroy(); await applyPricingSchema(h.app.get(DataSource)); return h;
}
export async function cacheReferenceState(h: E2EHarness) {
  const rows: Record<string, unknown> = {};
  for (const name of [...PRICING_TABLE_NAMES, 'budget_rules', 'call_logs']) rows[name] = await h.app.get(DataSource).query(`SELECT * FROM ${name}`);
  return { rows, provider_calls: h.fetchMock.calls.length };
}
export async function runCacheReferenceScenario(h: E2EHarness, mode: 'legacy_logical' | 'actual_upstream', currency = 'USD', free = false) {
  const base = '/api/dashboard/pricing', content = tokenBook(), id = `${mode}-${currency}-${free}`;
  content.currency = currency;
  if (free) for (const entry of content.groups[0].rules[0].rates) { entry.component.amount = '0'; entry.component.free = true; }
  async function publish(price = content) {
    const created = await h.agent.post(base + '/books').send({ name: `Synthetic cache ${id}`, content: price }); assert.equal(created.status, 201);
    const head = (await h.agent.get(base + '/bindings')).body.head;
    const published = await h.agent.post(`${base}/drafts/${created.body.draft.id}/publish`).send({ draft_revision: 1, catalog_revision: head.revision, reason: 'Synthetic cache fixture', confirm: true, targets: [{ level: 'model', model: 'gpt-4o', operation: 'chat_completions' }] }); assert.equal(published.status, 201);
    return { bookId: created.body.book.id as string, versionId: published.body.version_id as string };
  }
  const original = await publish();
  const head = (await h.agent.get(base + '/bindings')).body.head;
  assert.equal((await h.agent.put(base + '/admission-policy').send({ catalog_revision: head.revision, scope: 'workspace', operation: 'chat_completions', policy: { mode: 'compatibility', budget_basis: mode }, reason: 'Synthetic explicit policy', confirm: true })).status, 200);
  const providerBefore = h.fetchMock.calls.length;
  h.fetchMock.setHandler(async () => new Response(JSON.stringify({ id: 'synthetic-cache', model: 'gpt-4o', choices: [{ index: 0, message: { role: 'assistant', content: 'Synthetic response' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500, prompt_tokens_details: { cached_tokens: 0 }, cache_creation_input_tokens: 0 } }), { headers: { 'content-type': 'application/json' } }));
  for (let i = 0; i < 2; i++) {
    const response = await h.agent.post('/v1/chat/completions').set('Authorization', `Bearer ${API_KEY}`).send({ model: 'gpt-4o', max_tokens: 500, messages: [{ role: 'user', content: 'Synthetic cache ' + id }] }); assert.equal(response.status, 200); await h.app.get(PricingRuntimeService).waitForRequests();
  }
  assert.equal(h.fetchMock.calls.length - providerBefore, 1);
  const logs = await h.app.get(DataSource).query("SELECT id, request_id FROM call_logs WHERE node_id = 'cache' ORDER BY id DESC"); assert.ok(logs.length);
  const log = logs[0] as { id: number; request_id: string };
  const before = await cacheReferenceState(h), view = await h.agent.get(`/api/dashboard/logs/${log.id}/cost-breakdown`); assert.equal(view.status, 200);
  const body = view.body as PricingLogCost; assert.ok('attempts' in body);
  const amount = currency !== 'USD' ? null : free ? '0.000000000000000000' : '0.002000000000000000';
  assert.equal(body.amount, '0.000000000000000000'); assert.equal(body.provider_attempts, 0);
  assert.equal(body.local_cache_reference?.reference_cost_usd, amount); assert.equal(body.local_cache_reference?.hypothetical_savings_usd, amount);
  assert.equal(body.local_cache_reference?.state, amount === null ? 'unknown' : 'estimated');
  assert.equal(body.budget_committed_usd, mode === 'actual_upstream' ? '0.000000000000000000' : amount ?? '0.000000000000000000');
  assert.equal(body.log.stored_reference_cost_usd, null);
  const evidence = [['total_input_tokens', '1000'], ['uncached_input_tokens', '1000'], ['output_tokens', '500'], ['cache_read_tokens', '0'], ['cache_write_tokens', '0'], ['cache_write_5m_tokens', '0'], ['cache_write_1h_tokens', '0']].map(([dimension, value]) => ({ dimension, value, source: 'request_metadata', quality: 'observed' }));
  const quote = await h.agent.post(base + '/quote').send({ book_id: original.bookId, version_id: original.versionId, report_currency: 'USD', evidence }); assert.equal(quote.status, 201);
  assert.equal(quote.body.cost.report_amount, amount === null ? null : amount.slice(0, -9));
  const report = await h.agent.get(base + '/cost-report').query({ from: new Date(Date.now() - 86400000).toISOString(), to: new Date(Date.now() + 10000).toISOString() }); assert.equal(report.status, 200);
  const row = report.body.rows.find((row: { request_id: string }) => row.request_id === log.request_id); assert.equal(row.status, 'free'); assert.equal(row.amount_usd, '0.000000000000000000');
  assert.deepEqual(await cacheReferenceState(h), before);
  const next = tokenBook(); next.groups[0].rules[0].rates[0].component.amount = '999'; await publish(next);
  const afterPublish = await cacheReferenceState(h), unchanged = await h.agent.get(`/api/dashboard/logs/${log.id}/cost-breakdown`); assert.deepEqual(unchanged.body, body); assert.deepEqual(await cacheReferenceState(h), afterPublish);
  return { id, mode, currency, free, original, content, evidence, quote: quote.body.cost, log, detail: body, reportRow: row, provider_calls: h.fetchMock.calls.length - providerBefore };
}

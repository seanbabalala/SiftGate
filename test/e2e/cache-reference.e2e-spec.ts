import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import { createE2EHarness, E2EHarness, FIXTURE_PATH, API_KEY } from './setup';
import { CallLog } from '../../src/database/entities';
import { ConfigService } from '../../src/config/config.service';
import { PricingRecoveryService } from '../../src/pricing/pricing-recovery.service';
import { applyPricingSchema } from '../../src/pricing/pricing-schema';
import { book, rate } from '../unit/pricing-fixtures';

describe('read-only recorded cache comparisons through dashboard HTTP', () => {
  let h: E2EHarness, db: DataSource, directory: string;
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'cache-reference-http-'));
    const config = yaml.load(readFileSync(FIXTURE_PATH, 'utf8')) as Record<string, unknown>;
    config.cache = { enabled: false };
    config.budget = { daily_token_limit: 10000000, daily_cost_limit: 1000, alert_threshold: 0.8 };
    const file = join(directory, 'config.yaml'); writeFileSync(file, yaml.dump(config));
    h = await createE2EHarness(file); db = h.app.get(DataSource);
    await h.app.get(PricingRecoveryService).onModuleDestroy(); await applyPricingSchema(db);
  }, 30000);
  afterEach(async () => { jest.restoreAllMocks(); await h?.close(); rmSync(directory, { recursive: true, force: true }); });
  const report = () => h.agent.get('/api/dashboard/cache-savings?period=1d&group_by=node');
  const insert = (patch: Partial<CallLog> = {}) => db.getRepository(CallLog).save(db.getRepository(CallLog).create({
    request_id: randomUUID(), workspace_id: 'default-workspace', timestamp: new Date(), source_format: 'chat_completions',
    tier: 'direct', score: 0, node_id: 'synthetic-node', model: 'synthetic-cache', input_tokens: 100, output_tokens: 20,
    cache_read_input_tokens: 40, cache_creation_input_tokens: 30, cost_usd: 0.003, cost_without_cache_usd: 0.002,
    latency_ms: 1, stream: false, status_code: 200, is_fallback: false, ...patch,
  }));

  it('does not present a real priced media invocation as negative token-cache savings or change its fee', async () => {
    const base = '/api/dashboard/pricing';
    const content = { ...book([rate('duration', 'video_seconds', '0.1', '1'), rate('base', 'video_generation_count', '0.02', '1')]), allow_combined_media: true };
    const created = await h.agent.post(base + '/books').send({ name: 'Synthetic media comparison', content });
    expect(created.status).toBe(201);
    const revision = (await h.agent.get(base + '/bindings')).body.head.revision;
    expect((await h.agent.post(`${base}/drafts/${created.body.draft.id}/publish`).send({ draft_revision: 1, catalog_revision: revision, confirm: true, reason: 'Synthetic test', targets: [{ level: 'model', model: 'veo-3-preview', operation: 'video_generation' }] })).status).toBe(201);
    h.fetchMock.setHandler(async () => new Response(JSON.stringify({ id: 'synthetic-job', status: 'completed', usage: { video_seconds: '2.5', generation_count: 1 } }), { headers: { 'content-type': 'application/json' } }));
    expect((await h.agent.post('/v1/videos/generations').set('Authorization', `Bearer ${API_KEY}`).send({ model: 'veo-3-preview', seconds: 8, prompt: 'Synthetic media only' })).status).toBe(200);
    const before = await db.query('SELECT * FROM pricing_attempts');
    expect(JSON.parse(before[0].cost_json).report_amount).toBe('0.270000000');
    const priceRead = jest.spyOn(h.app.get(ConfigService), 'getModelPricing');
    const result = await report(); expect(result.status).toBe(200);
    expect(result.body.summary).toMatchObject({ comparison_status: 'unavailable', excluded_requests: 1, cache_eligible_requests: 0, savings_usd: null, savings_percentage: null, actual_cost_usd: null });
    expect(priceRead).not.toHaveBeenCalled();
    expect(await db.query('SELECT * FROM pricing_attempts')).toEqual(before);
    expect(h.fetchMock.calls).toHaveLength(1);
  });

  it('uses persisted paired values across current-price changes and preserves a negative recorded difference', async () => {
    await insert(); const before = await db.query('SELECT * FROM call_logs');
    const priceRead = jest.spyOn(h.app.get(ConfigService), 'getModelPricing').mockReturnValue({ input: 999, output: 999 });
    const first = await report(); expect(first.status).toBe(200);
    expect(first.body.summary).toMatchObject({ comparison_status: 'complete', actual_cost_usd: 0.003, hypothetical_no_cache_cost_usd: 0.002, savings_usd: -0.001, savings_percentage: -50, normal_input_cost_usd: null });
    priceRead.mockReturnValue({ input: 0, output: 0 });
    expect((await report()).body).toEqual(first.body);
    expect(priceRead).not.toHaveBeenCalled();
    expect(await db.query('SELECT * FROM call_logs')).toEqual(before);
  });

  it('keeps missing reference and stored zero distinct without recreating a baseline', async () => {
    await insert({ cost_usd: 0, cost_without_cache_usd: null });
    expect((await report()).body.summary).toMatchObject({ comparison_status: 'unavailable', unavailable_reference_requests: 1, savings_usd: null });
    await db.getRepository(CallLog).clear();
    await insert({ cost_usd: 0, cost_without_cache_usd: 0 });
    expect((await report()).body.summary).toMatchObject({ comparison_status: 'complete', savings_usd: 0, savings_percentage: null, exact: { comparable_savings_usd: '0.000000000000000000' } });
  });

  it('keeps mixed reference coverage and workspace scope explicit without mutating any row', async () => {
    await insert({ cost_usd: 0.001 });
    await insert({ cost_without_cache_usd: null });
    await insert({ source_format: 'image_generation', cost_usd: 20, cost_without_cache_usd: 0.001 });
    await insert({ workspace_id: 'foreign-workspace', cost_usd: 100, cost_without_cache_usd: 1000 });
    const before = await db.query('SELECT * FROM call_logs ORDER BY id');
    const result = await report(); expect(result.status).toBe(200);
    expect(result.body.summary).toMatchObject({ total_requests: 3, comparison_status: 'partial', comparable_requests: 1, cache_eligible_requests: 2, excluded_requests: 1, unavailable_reference_requests: 1, savings_usd: null, known_savings_usd: 0.001 });
    expect(result.body.groups).toHaveLength(1);
    expect(await db.query('SELECT * FROM call_logs ORDER BY id')).toEqual(before);
  });

  it('exposes the bounded scan rather than reporting a sampled period as complete', async () => {
    const config = h.app.get(ConfigService), limits = config.pricingLimits;
    jest.spyOn(config, 'pricingLimits', 'get').mockReturnValue({ ...limits, max_replay_rows: 2 });
    await insert(); await insert(); await insert();
    const result = await report(); expect(result.status).toBe(200);
    expect(result.body.scan).toEqual({ row_limit: 2, scanned_rows: 2, has_more: true });
    expect(result.body.summary).toMatchObject({ total_requests: 2, comparison_status: 'partial', savings_usd: null, cache_hit_rate: null });
    expect(result.body.daily_trend[0].savings_usd).toBeNull();
  });

  it('does not include future-dated logs in the current reporting period', async () => {
    await insert(); await insert({ timestamp: new Date(Date.now() + 86400000), cost_usd: 900 });
    const result = await report(); expect(result.status).toBe(200);
    expect(result.body.summary).toMatchObject({ total_requests: 1, actual_cost_usd: 0.003 });
    expect(result.body.daily_trend).toHaveLength(1);
  });
});

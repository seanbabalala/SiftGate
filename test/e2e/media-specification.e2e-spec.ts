import { createHmac } from 'node:crypto';
import { mediaSupplierSigningInput } from '../../src/pricing/media-supplier-event';
import type { MediaSupplierEvent } from '../../src/pricing/media-supplier.types';
import { DataSource } from 'typeorm';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mediaSpecificationHarness, specificationTariff, publishSpecification, SPEC_API as base } from '../helpers/media-specification-fixture';
import { API_KEY, type E2EHarness } from './setup';
import { PricingRuntimeService } from '../../src/pricing/pricing-runtime.service';
import { CostLedgerService } from '../../src/pricing/cost-ledger.service';
import { PRICING_TABLE_NAMES } from '../../src/pricing/pricing-schema';
import type { CostComputation } from '../../src/pricing/pricing.types';
import type { PricingInheritanceDefinition } from '../../src/pricing/pricing-inheritance.types';

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
describe('media specification contracts through isolated HTTP', () => {
  let h: E2EHarness, directory: string, db: DataSource;
  const secretName = 'SIFTGATE_MEDIA_EVENT_SPECIFICATION_TEST'; let oldSecret: string | undefined;
  beforeEach(async () => { oldSecret = process.env[secretName]; directory = mkdtempSync(join(tmpdir(), 'media-specification-http-')); h = await mediaSpecificationHarness(directory); db = h.app.get(DataSource); });
  afterEach(async () => { jest.restoreAllMocks(); await h?.app.get(PricingRuntimeService).waitForRequests(); await h?.close(); if (directory) rmSync(directory, { recursive: true, force: true }); if (oldSecret === undefined) delete process.env[secretName]; else process.env[secretName] = oldSecret; });
  async function snapshot() { const rows: Record<string, unknown> = {}; for (const table of [...PRICING_TABLE_NAMES, 'budget_rules', 'call_logs']) rows[table] = await db.query(`SELECT * FROM ${table}`); return rows; }
  const image = () => h.agent.post('/v1/images/generations').set('Authorization', 'Bearer ' + API_KEY).send({ model: 'gpt-image-1', size: '512x512', n: 2, prompt: 'SYNTHETIC-PRIVATE-PROMPT' });
  async function latest() {
    await h.app.get(PricingRuntimeService).waitForRequests();
    const log = (await h.callLogRepo.find({ order: { id: 'DESC' } }))[0];
    const response = await h.agent.get(`/api/dashboard/logs/${log.id}/cost-breakdown`);
    expect(response.status).toBe(200); return { log, summary: response.body, cost: response.body.attempts[0].cost as CostComputation };
  }
  it('uses the published model-fixed specification in quotes, actual receipts, budgets, logs and read-only replay', async () => {
    const content = specificationTariff('image_generation'), p = await publishSpecification(h, content);
    expect(p.preview.metering).toMatchObject({ registry_version: 'gateway-metering-v5', targets: [{ media_specification: { enabled: true, fixed: { size: '1024x1024' } } }] });
    const beforeQuote = await snapshot(), quoted = await h.agent.post(base + '/quote').send({ book_id: p.created.book.id, version_id: p.published.version_id, evidence: [{ dimension: 'image_count', value: '2', source: 'provider_job_result', quality: 'observed' }], context: { media: { size: '512x512' }, media_sources: { size: 'request_parameter' }, media_adapter: 'generic-v1' } });
    expect(quoted.status).toBe(201); expect(quoted.body.cost.amount).toBe('0.400000000'); expect(await snapshot()).toEqual(beforeQuote);
    h.fetchMock.setHandler(async () => json({ data: [{ b64_json: 'SYNTHETIC-PRIVATE-IMAGE' }, { b64_json: 'SYNTHETIC-PRIVATE-IMAGE' }] }));
    expect((await image()).status).toBe(200); const result = await latest();
    expect(result.cost).toMatchObject({ version_id: p.published.version_id, amount: '0.400000000', selection: { media: { size: '1024x1024' }, media_specification: { attributes: { size: { source: 'model_fixed', supplied_source: 'request_parameter', supplied_value: '512x512', value: '1024x1024', conflict: false } } } } });
    expect(result.summary.budget_committed_usd).toBe('0.400000000000000000'); expect(result.log.cost_usd).toBe(.4);
    const beforeRead = await snapshot(), replay = await h.agent.post(base + '/replay').send({ request_ids: [result.summary.request_id], content: specificationTariff('image_generation', null) });
    expect(replay.status).toBe(201); expect(replay.body.results[0].simulations[0].simulated.amount).toBe('0.200000000');
    expect(replay.body.results[0].simulations[0].simulated.selection.media_specification.attributes.size.source).toBe('request_parameter');
    const original = (await h.agent.get(`/api/dashboard/logs/${result.log.id}/cost-breakdown`)).body;
    expect(original).toEqual(result.summary); expect(await snapshot()).toEqual(beforeRead); expect(h.fetchMock.calls).toHaveLength(1);
    expect(JSON.stringify(await db.query('SELECT * FROM pricing_attempts'))).not.toContain('SYNTHETIC-PRIVATE');
  });
  it('preserves valid media delivery but records a contradictory provider result as unknown, never free', async () => {
    await publishSpecification(h, specificationTariff('image_generation'));
    const head = (await h.agent.get(base + '/bindings')).body.head;
    expect((await h.agent.put(base + '/admission-policy').send({ catalog_revision: head.revision, scope: 'workspace', operation: 'image_generation', reason: 'Synthetic actual expense', confirm: true, policy: { mode: 'compatibility', budget_basis: 'actual_upstream', token_budget: 'not_applicable' } })).status).toBe(200);
    h.fetchMock.setHandler(async () => json({ size: '512x512', data: [{ b64_json: 'SYNTHETIC-PRIVATE-IMAGE' }, { b64_json: 'SYNTHETIC-PRIVATE-IMAGE' }] }));
    const response = await image(); expect(response.status).toBe(200); expect(response.body.data).toHaveLength(2);
    const result = await latest(); expect(result.cost.status).toBe('unpriced'); expect(result.summary.amount).toBeNull();
    expect(result.cost.selection!.media_specification!.attributes.size).toMatchObject({ source: 'model_fixed', supplied_source: 'provider_result', value: '1024x1024', supplied_value: '512x512', conflict: true });
    expect(result.summary.reservations.some((r: { state: string }) => r.state === 'reserved')).toBe(true);
    expect(h.fetchMock.calls).toHaveLength(1);
  });
  it('pins the original fixed specification while an asynchronous task survives a later price publication', async () => {
    const p = await publishSpecification(h, specificationTariff('video_generation'), 'veo-3-preview', 'video_generation');
    let count = 0;
    h.fetchMock.setHandler(async (_url, init) => init?.method === 'GET' ? json({ id: 'specification-job', status: 'completed', usage: { generation_count: 1 } }) : ++count === 1 ? json({ id: 'specification-job', status: 'pending' }) : json({ id: 'new-specification-job', status: 'completed', usage: { generation_count: 1 } }));
    const call = () => h.agent.post('/v1/videos/generations').set('Authorization', 'Bearer ' + API_KEY).send({ model: 'veo-3-preview', size: '512x512', seconds: 8, prompt: 'Synthetic task' });
    expect((await call()).status).toBe(200);
    const task = (await db.query('SELECT * FROM pricing_media_tasks'))[0];
    await publishSpecification(h, specificationTariff('video_generation', '512x512'), 'veo-3-preview', 'video_generation');
    expect((await h.agent.get('/v1/videos/specification-job').set('Authorization', 'Bearer ' + API_KEY)).status).toBe(200);
    const first = (await h.app.get(CostLedgerService).summary(task.request_id, task.workspace_id))!;
    expect(first.attempts[0].cost).toMatchObject({ version_id: p.published.version_id, amount: '0.200000000', selection: { media: { size: '1024x1024' }, media_specification: { attributes: { size: { source: 'model_fixed', supplied_value: '512x512' } } } } });
    expect((await call()).status).toBe(200); const second = await latest();
    expect(second.cost.amount).toBe('0.100000000'); expect(second.cost.version_id).not.toBe(p.published.version_id);
    expect(await h.app.get(CostLedgerService).summary(task.request_id, task.workspace_id)).toEqual(first); expect(h.fetchMock.calls).toHaveLength(3);
  });
  it('treats signed callback specifications as provider evidence rather than inheriting the original request label', async () => {
    await publishSpecification(h, specificationTariff('video_generation'), 'veo-3-preview', 'video_generation');
    h.fetchMock.setHandler(async () => json({ id: 'signed-specification-job', status: 'pending' }));
    expect((await h.agent.post('/v1/videos/generations').set('Authorization', 'Bearer ' + API_KEY).send({ model: 'veo-3-preview', size: '512x512', seconds: 8, prompt: 'Synthetic signed result' })).status).toBe(200);
    const task = (await db.query('SELECT * FROM pricing_media_tasks'))[0], attempt = (await db.query('SELECT * FROM pricing_attempts'))[0];
    const credential = task.credential_id ?? JSON.parse(attempt.price_context_json).dispatch.credential_id;
    const secret = 'synthetic-media-specification-signing-key'; process.env[secretName] = secret;
    const configured = await h.agent.put(base + '/media-event-sources/specification-source').send({ revision: 0, node_id: task.node_id, credential_id: credential, secret_env: secretName, enabled: true, reason: 'Synthetic signed specification evidence', confirm: true });
    expect({ status: configured.status, error: configured.body.error }).toEqual({ status: 200, error: undefined });
    const event: MediaSupplierEvent = { schema_version: 1, event_id: 'specification-event', task_id: task.id, provider_job_id: task.provider_job_id, sequence: '1', status: 'completed', accepted_at: task.accepted_at ?? task.created_at, completed_at: new Date().toISOString(), time_quality: 'estimated', evidence: [{ dimension: 'video_generation_count', value: '1', quality: 'observed' }], media: { size: '512x512' } };
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = 'v1=' + createHmac('sha256', secret).update(mediaSupplierSigningInput('specification-source', '1', timestamp, event)).digest('hex');
    const delivered = await h.agent.post('/api/pricing/media-events/specification-source').set('x-siftgate-media-time', timestamp).set('x-siftgate-media-revision', '1').set('x-siftgate-media-signature', signature).send(event);
    expect(delivered.status).toBe(202);
    const result = (await h.app.get(CostLedgerService).summary(task.request_id, task.workspace_id))!;
    expect(result.amount).toBeNull(); expect(result.attempts[0].cost).toMatchObject({ status: 'unpriced', selection: { media_specification: { adapter: 'siftgate-media-event-v1', attributes: { size: { supplied_source: 'provider_result', supplied_value: '512x512', conflict: true } } } } });
    expect(h.fetchMock.calls).toHaveLength(1);
  });

  it('preserves fixed contracts through inherited draft edits, export and import without changing the parent', async () => {
    const parent = await publishSpecification(h, specificationTariff('image_generation'));
    const definition: PricingInheritanceDefinition = { schema_version: 1, parent: { book_id: parent.created.book.id, version_id: parent.published.version_id, content_hash: parent.published.content_hash }, inherit: 'all', source: { kind: 'manual' }, rate_overrides: [], removed_component_ids: [], replaced_groups: [], added_groups: [], removed_group_ids: [], settings: {}, calendar: { mode: 'inherit' } };
    const child = await h.agent.post(base + '/inherited-books').send({ name: 'Synthetic inherited specification', definition }); expect(child.status).toBe(201);
    expect(child.body.draft.content.media_specification.fixed.size).toBe('1024x1024');
    definition.settings.media_specification = { fixed: { size: '512x512' } };
    const updated = await h.agent.put(`${base}/drafts/${child.body.draft.id}/inheritance`).send({ revision: 1, definition }); expect(updated.status).toBe(200);
    expect(updated.body.content.media_specification.fixed.size).toBe('512x512');
    const source = await h.agent.get(`${base}/books/${parent.created.book.id}/versions/${parent.published.version_id}`);
    expect(source.body.content.media_specification.fixed.size).toBe('1024x1024');
    const exported = await h.agent.get(`${base}/books/${parent.created.book.id}/export`).query({ version_id: parent.published.version_id }); expect(exported.status).toBe(200);
    const imported = await h.agent.post(base + '/import/validate').send(exported.body); expect(imported.status).toBe(201);
    expect(imported.body.content.media_specification.fixed.size).toBe('1024x1024');
    const before = await snapshot(); definition.settings.media_specification = null;
    const preview = await h.agent.post(base + '/inheritance/preview').send({ definition }); expect(preview.status).toBe(201); expect(preview.body.content).not.toHaveProperty('media_specification'); expect(await snapshot()).toEqual(before);
  });
  it('rejects unsupported publication targets and malformed source declarations without consuming the draft', async () => {
    const created = await h.agent.post(base + '/books').send({ name: 'Synthetic invalid target', content: specificationTariff('image_generation') }); expect(created.status).toBe(201);
    const before = await snapshot();
    const response = await h.agent.post(`${base}/drafts/${created.body.draft.id}/publish`).send({ draft_revision: 1, catalog_revision: 0, reason: 'Synthetic', confirm: true, targets: [{ level: 'model', model: 'gpt-image-1' }] });
    expect(response.status).toBeGreaterThanOrEqual(400); expect(await snapshot()).toEqual(before);
    const malformed = await h.agent.post(base + '/quote').send({ content: specificationTariff('image_generation'), evidence: [], context: { media_adapter: 'unknown', media_sources: { size: 'model_fixed' } } });
    expect(malformed.status).toBe(400); expect(await snapshot()).toEqual(before);
  });
});

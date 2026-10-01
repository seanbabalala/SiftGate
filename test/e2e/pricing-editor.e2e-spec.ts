import { DataSource } from 'typeorm';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import { createE2EHarness, E2EHarness, FIXTURE_PATH } from './setup';
import { ConfigService } from '../../src/config/config.service';
import { applyPricingSchema } from '../../src/pricing/pricing-schema';
import { tokenBook } from '../unit/pricing-fixtures';

describe('pricing editor contracts on isolated HTTP', () => {
  let harness: E2EHarness, directory: string;
  const capabilities = { 'gpt-4o': { modalities: ['text', 'image'], max_context_tokens: 300000, supports_reasoning: true, pricing: { input: 1, output: 2, cache_read_input: 0.1, cache_creation_input: 1.25, image_per_generation: 0.04, video_per_second: 0.15 } }, inactive: { dimensions: [512, 1024], pricing: { input: 3, output: 4 } } };
  const base = '/api/dashboard/pricing';
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'pricing-editor-'));
    const config = yaml.load(readFileSync(FIXTURE_PATH, 'utf8')) as Record<string, unknown>;
    (config.nodes as Record<string, unknown>[])[0].model_capabilities = structuredClone(capabilities);
    const file = join(directory, 'config.yaml'); writeFileSync(file, yaml.dump(config));
    harness = await createE2EHarness(file); await applyPricingSchema(harness.app.get(DataSource));
  }, 30000);
  afterEach(async () => { await harness?.close(); rmSync(directory, { recursive: true, force: true }); });
  const current = () => harness.app.get(ConfigService).getNode('mock-openai')!.model_capabilities;

  it('preserves every stored capability and hidden price on unrelated node edits and patches only explicit base rates', async () => {
    const nodes = (await harness.agent.get('/api/dashboard/nodes')).body.nodes;
    expect(nodes[0].configured_pricing_models).toEqual(['gpt-4o', 'inactive']);
    expect((await harness.agent.put('/api/dashboard/nodes/mock-openai').send({ name: 'Renamed isolated node' })).status).toBe(200);
    expect(current()).toEqual(capabilities);
    expect((await harness.agent.put('/api/dashboard/nodes/mock-openai').send({ model_pricing_updates: [{ model: 'gpt-4o', action: 'set', input: 0, output: 3 }] })).status).toBe(200);
    expect(current()).toEqual({ ...capabilities, 'gpt-4o': { ...capabilities['gpt-4o'], pricing: { ...capabilities['gpt-4o'].pricing, input: 0, output: 3 } } });
  });

  it('requires explicit inheritance to remove all legacy prices but retains other model metadata', async () => {
    const result = await harness.agent.put('/api/dashboard/nodes/mock-openai').send({ model_pricing_updates: [{ model: 'gpt-4o', action: 'inherit' }] });
    expect(result.status).toBe(200); expect(current()?.['gpt-4o'].pricing).toBeUndefined(); expect(current()?.['gpt-4o'].max_context_tokens).toBe(300000); expect(current()?.inactive).toEqual(capabilities.inactive);
  });

  it.each([
    { model_pricing_updates: [{ model: 'gpt-4o', action: 'set', input: '', output: 2 }] },
    { model_pricing_updates: [{ model: 'gpt-4o', action: 'set', input: 1 }] },
    { model_pricing_updates: [{ model: 'gpt-4o', action: 'inherit', input: 0 }] },
    { model_pricing_updates: [{ model: 'gpt-4o', action: 'inherit' }, { model: 'gpt-4o', action: 'inherit' }] },
    { model_pricing_updates: [{ model: 'gpt-4o', action: 'inherit' }], model_capabilities: {} },
  ])('rejects ambiguous/blank/duplicate price edits without changing stored config: %j', async (body) => {
    expect((await harness.agent.put('/api/dashboard/nodes/mock-openai').send(body)).status).toBe(400); expect(current()).toEqual(capabilities);
  });

  it('previews policy and FX changes read-only, then publishes with revision/confirmation validation', async () => {
    const policy = { catalog_revision: 0, reason: 'Synthetic policy', confirm: true, scope: 'workspace', operation: 'chat_completions', policy: { mode: 'reject_unpriced' } };
    const rate = { fx: { from_currency: 'CNY', to_currency: 'USD', numerator: '1', denominator: '7', source: 'Synthetic FX', effective_at: '2026-01-01T00:00:00Z' } };
    const fx = { catalog_revision: 0, reason: 'Synthetic FX preview', confirm: true, scope: 'workspace', versions: [rate] };
    expect((await harness.agent.post(`${base}/admission-policy/preview`).send(policy)).body).toMatchObject({ dry_run: true, before: null, after: policy.policy });
    expect((await harness.agent.post(`${base}/fx/preview`).send(fx)).body).toMatchObject({ dry_run: true, before: [], head: { revision: 0 } });
    const source = harness.app.get(DataSource);
    expect(await source.query('SELECT * FROM pricing_catalog_revisions')).toHaveLength(0);
    expect(await source.query('SELECT * FROM pricing_audit_events')).toHaveLength(0);
    expect(await source.query('SELECT * FROM pricing_request_snapshots')).toHaveLength(0);
    expect((await harness.agent.post(`${base}/fx/preview`).send({ ...fx, versions: [{ fx: { ...rate.fx, denominator: '0' } }] })).status).toBe(400);
    expect((await harness.agent.post(`${base}/admission-policy/preview`).send({ ...policy, confirm: false })).status).toBe(400);
    expect((await harness.agent.post(`${base}/admission-policy/preview`).send({ ...policy, operation: 'unimplemented_live' })).status).toBe(400);
    expect((await harness.agent.post(`${base}/admission-policy/preview`).send({ ...policy, operation: 'realtime' })).status).toBe(201);
    expect((await harness.agent.post(`${base}/fx/preview`).set('Origin', 'https://untrusted.invalid').send(fx)).status).toBe(403);
    expect((await harness.agent.put(`${base}/admission-policy`).send(policy)).status).toBe(200);
    expect((await harness.agent.post(`${base}/fx/preview`).send(fx)).status).toBe(409);
    expect((await harness.agent.put(`${base}/fx`).send({ ...fx, catalog_revision: 1 })).status).toBe(200);
    expect((await harness.agent.get(`${base}/bindings`)).body.fx_versions[0].fx).toMatchObject({ ...rate.fx, effective_at: new Date(rate.fx.effective_at).toISOString() });
    expect(harness.fetchMock.calls).toHaveLength(0);
  });

  it('exposes the server timezone-data version and previews rollback without publishing or inserting request snapshots', async () => {
    const runtime = await harness.agent.get(`${base}/calendar/runtime`); expect(runtime.status).toBe(200); expect(runtime.body.tzdb_version).toBe(process.versions.tz ?? 'unknown');
    const created = await harness.agent.post(`${base}/books`).send({ name: 'UI version fixture', content: tokenBook() }); expect(created.status).toBe(201);
    const options = { draft_revision: 1, catalog_revision: 0, reason: 'test', confirm: true, targets: [{ level: 'model', model: 'gpt-4o' }] };
    const published = await harness.agent.post(`${base}/drafts/${created.body.draft.id}/publish`).send(options); expect(published.status).toBe(201);
    const detail = await harness.agent.get(`${base}/books/${created.body.book.id}`); expect(detail.status).toBe(200); expect(detail.body.versions[0].version_id).toBe(published.body.version_id);
    const source = harness.app.get(DataSource); const audit = await source.query('SELECT * FROM pricing_audit_events');
    const preview = await harness.agent.post(`${base}/books/${created.body.book.id}/preview-rollback`).send({ catalog_revision: 1, reason: 'preview', confirm: true, version_id: published.body.version_id, targets: options.targets });
    expect(preview.status).toBe(201); expect(preview.body.dry_run).toBe(true); expect(preview.body.bindings).toHaveLength(1);
    expect(await source.query('SELECT * FROM pricing_audit_events')).toEqual(audit); expect(await source.query('SELECT * FROM pricing_book_versions')).toHaveLength(1); expect(await source.query('SELECT * FROM pricing_request_snapshots')).toHaveLength(0); expect(harness.fetchMock.calls).toHaveLength(0);
  });
});

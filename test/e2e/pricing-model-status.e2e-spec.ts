import { DataSource } from 'typeorm';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createE2EHarness, FIXTURE_PATH, type E2EHarness } from './setup';
import { applyPricingSchema, PRICING_TABLE_NAMES } from '../../src/pricing/pricing-schema';
import { PricingRecoveryService } from '../../src/pricing/pricing-recovery.service';
import { WorkspaceMembershipService } from '../../src/auth/workspace-membership.service';
import { DEFAULT_ORGANIZATION_ID, DEFAULT_WORKSPACE_ID } from '../../src/workspaces/workspace.constants';
import { tokenBook } from '../unit/pricing-fixtures';

const endpoint = '/api/dashboard/pricing', target = { node_id: 'mock-openai', model: 'gpt-4o', operation: 'chat_completions' };
describe('model-list pricing metadata over isolated HTTP', () => {
  let h: E2EHarness, db: DataSource, directory: string, file: string;
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'model-price-http-')); file = join(directory, 'gateway.yaml'); copyFileSync(FIXTURE_PATH, file);
    h = await createE2EHarness(file); db = h.app.get(DataSource);
    await h.app.get(PricingRecoveryService).onModuleDestroy();
  }, 30000);
  afterEach(async () => { await h?.close(); rmSync(directory, { recursive: true, force: true }); });
  const inspect = (targets: unknown = [target]) => h.agent.post(`${endpoint}/model-status`).send({ targets });
  async function dump() {
    const state: Record<string, unknown> = {};
    for (const table of [...PRICING_TABLE_NAMES, 'budget_rules', 'call_logs']) state[table] = await db.query(`SELECT * FROM ${table}`);
    return state;
  }
  it('shows unmigrated legacy references without installing a schema, rewriting config or calling providers', async () => {
    const before = readFileSync(file, 'utf8');
    const response = await inspect([target, { ...target, model: 'text-embedding-3-small', operation: 'embeddings' }]);
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ workspace_id: DEFAULT_WORKSPACE_ID, schema_available: false, read_only: true, supplier_support_verified: false, head: null });
    expect(response.body.rows[1]).toMatchObject({ current: null, scheduled: [], legacy_reference: { source: 'node_model_config', currency: 'USD', review_required: true } });
    const runner = db.createQueryRunner(); try { expect(await runner.hasTable('pricing_schema_versions')).toBe(false); } finally { await runner.release(); }
    expect(readFileSync(file, 'utf8')).toBe(before); expect(h.fetchMock.calls).toHaveLength(0);
  });
  it('allows a viewer to inspect current/future versions and disallows publication without changing any pricing state', async () => {
    await applyPricingSchema(db);
    const content = tokenBook(); content.source = { kind: 'manual', reference: 'https://user:synthetic@example.test/prices?token=synthetic#private' };
    const created = await h.agent.post(`${endpoint}/books`).send({ name: 'Synthetic price', content }); expect(created.status).toBe(201);
    const publication = { draft_revision: 1, catalog_revision: 0, reason: 'Synthetic fixture', confirm: true, targets: [{ level: 'model', model: target.model, operation: target.operation }] };
    const published = await h.agent.post(`${endpoint}/drafts/${created.body.draft.id}/publish`).send(publication); expect(published.status).toBe(201);
    const next = await h.agent.post(`${endpoint}/books`).send({ name: 'Synthetic scheduled', content }); expect(next.status).toBe(201);
    const future = new Date(Date.now() + 3600000).toISOString();
    const scheduled = await h.agent.post(`${endpoint}/drafts/${next.body.draft.id}/publish`).send({ ...publication, catalog_revision: 1, effective_from: future }); expect(scheduled.status).toBe(201);
    const members = h.app.get(WorkspaceMembershipService);
    await members.ensureMembership({ userId: 'fixture-admin', organizationId: DEFAULT_ORGANIZATION_ID, workspaceId: DEFAULT_WORKSPACE_ID, role: 'admin' });
    await members.ensureMembership({ userId: 'dashboard', organizationId: DEFAULT_ORGANIZATION_ID, workspaceId: DEFAULT_WORKSPACE_ID, role: 'viewer' });
    const before = await dump(), config = readFileSync(file, 'utf8');
    const response = await inspect([target, { ...target, operation: 'responses' }]); expect(response.status).toBe(201);
    expect(response.body.rows[0]).toMatchObject({ current: { binding: { book_id: created.body.book.id, version_id: published.body.version_id }, source: { reference: 'https://example.test/prices' } }, scheduled: [{ effective_at: future, price: { binding: { book_id: next.body.book.id, version_id: scheduled.body.version_id } } }] });
    expect(response.body.rows[1]).toMatchObject({ current: null, scheduled: [] });
    expect((await h.agent.post(`${endpoint}/books`).send({ name: 'Forbidden', content })).status).toBe(403);
    expect(await dump()).toEqual(before); expect(readFileSync(file, 'utf8')).toBe(config); expect(h.fetchMock.calls).toHaveLength(0);
  });
  it('rejects spoofed scope, invalid targets, duplicates and untrusted origins', async () => {
    await applyPricingSchema(db); const before = await dump();
    for (const targets of [[], [null], [target, target], [{ ...target, role: 'admin' }], [{ ...target, operation: 'unknown' }], Array.from({ length: 21 }, (_, i) => ({ ...target, model: `model-${i}` }))]) expect((await inspect(targets)).status).toBe(400);
    for (const change of [{ node_id: 'unknown' }, { model: 'unknown' }]) expect((await inspect([{ ...target, ...change }])).status).toBe(404);
    expect((await h.agent.post(`${endpoint}/model-status`).send({ targets: [target], workspace_id: 'other' })).status).toBe(400);
    expect((await h.agent.post(`${endpoint}/model-status`).set('Origin', 'https://untrusted.example').send({ targets: [target] })).status).toBe(403);
    expect(await dump()).toEqual(before); expect(h.fetchMock.calls).toHaveLength(0);
  });
});

import { DataSource } from 'typeorm';
import { createE2EHarness, type E2EHarness } from './setup';
import { applyPricingSchema, PRICING_TABLE_NAMES } from '../../src/pricing/pricing-schema';
import { PricingRecoveryService } from '../../src/pricing/pricing-recovery.service';
import { WorkspaceService } from '../../src/workspaces/workspace.service';
import { WorkspaceMembershipService } from '../../src/auth/workspace-membership.service';
import { tokenBook } from '../unit/pricing-fixtures';

const base = '/api/dashboard/pricing';
const options = { draft_revision: 1, catalog_revision: 0, confirm: true, reason: 'Synthetic timing review', targets: [{ level: 'model', model: 'gpt-4o', operation: 'chat_completions' }] };
describe('publication time-basis management HTTP', () => {
  let h: E2EHarness, db: DataSource;
  beforeEach(async () => { h = await createE2EHarness(); await h.app.get(PricingRecoveryService).onModuleDestroy(); db = h.app.get(DataSource); await applyPricingSchema(db); });
  afterEach(async () => { await h?.close(); });
  const create = async (basis: 'completed_at' | 'provider_accepted_at' = 'completed_at') => {
    const content = tokenBook(); content.time_basis = basis; content.calendar = { schema_version: 1, version_id: 'synthetic-time', time_zone: 'UTC', tzdb_version: process.versions.tz!, valid_from: '2020-01-01', valid_to: '2030-01-01', default_tag: 'normal', weekly: [], holidays: [], date_overrides: [] }; content.groups[0].rules[0].condition.time_tags = ['normal'];
    const result = await h.agent.post(base + '/books').send({ name: 'Synthetic timing', scope: 'workspace', content }); expect(result.status).toBe(201); return result.body;
  };
  const snapshot = () => Promise.all(PRICING_TABLE_NAMES.map(table => db.query(`SELECT * FROM ${table}`)));
  it.each(['completed_at', 'provider_accepted_at'] as const)('requires explicit %s confirmation for direct API activation and audits it', async basis => {
    const created = await create(basis), before = await snapshot(), path = `${base}/drafts/${created.draft.id}`;
    const preview = await h.agent.post(path + '/preview-publication').send(options); expect(preview.status).toBe(201);
    expect(preview.body.time_basis_review).toMatchObject({ basis, requires_confirmation: true, supplier_verified: false }); expect(await snapshot()).toEqual(before);
    const rejected = await h.agent.post(path + '/publish').send(options); expect(rejected.status).toBe(400); expect(rejected.body.error.code).toBe('pricing_time_basis_review_required'); expect(await snapshot()).toEqual(before);
    const confirmation = { basis, content_hash: preview.body.content_hash, reference: 'SYNTHETIC-AGREEMENT-01', confirmed: true };
    const published = await h.agent.post(path + '/publish').send({ ...options, time_basis_confirmation: confirmation }); expect(published.status).toBe(201); expect(published.body.time_basis_confirmation).toEqual(confirmation);
    const audit = (await db.query("SELECT metadata_json FROM pricing_audit_events WHERE action = 'draft.published'"))[0]; expect(JSON.parse(audit.metadata_json)).toMatchObject({ time_basis_confirmation: confirmation }); expect(h.fetchMock.calls).toHaveLength(0);
    const rollbackOptions = { ...options, version_id: published.body.version_id, catalog_revision: 1 }; delete (rollbackOptions as { draft_revision?: number }).draft_revision;
    const rollback = `${base}/books/${created.book.id}`;
    expect((await h.agent.post(rollback + '/preview-rollback').send(rollbackOptions)).body.time_basis_review.basis).toBe(basis);
    expect((await h.agent.post(rollback + '/rollback').send(rollbackOptions)).status).toBe(400);
    const restored = await h.agent.post(rollback + '/rollback').send({ ...rollbackOptions, time_basis_confirmation: confirmation }); expect(restored.status).toBe(201); expect(restored.body.version_id).not.toBe(published.body.version_id);
  });
  it('rejects malformed attestations, stale hashes and request-supplied actor overrides', async () => {
    const created = await create(), path = `${base}/drafts/${created.draft.id}`, before = await snapshot();
    const preview = await h.agent.post(path + '/preview-publication').send(options); const valid = { basis: 'completed_at', content_hash: preview.body.content_hash, reference: 'SYNTHETIC-01', confirmed: true };
    for (const value of [null, false, {}, { ...valid, confirmed: false }, { ...valid, actor_id: 'foreign' }, { ...valid, reference: 'file:///private/contract' }, { ...valid, reference: 'secret text' }]) expect((await h.agent.post(path + '/publish').send({ ...options, time_basis_confirmation: value })).status).toBe(400);
    expect((await h.agent.post(path + '/publish').send({ ...options, time_basis_confirmation: { ...valid, content_hash: '0'.repeat(64) } })).status).toBe(409); expect(await snapshot()).toEqual(before); expect(h.fetchMock.calls).toHaveLength(0);
  });
  it('keeps timing confirmation behind stored workspace administration', async () => {
    const created = await create(), path = `${base}/drafts/${created.draft.id}`, preview = await h.agent.post(path + '/preview-publication').send(options);
    const foreign = await h.app.get(WorkspaceService).createWorkspace({ name: 'Synthetic other scope' }); await h.app.get(WorkspaceMembershipService).ensureMembership({ userId: 'dashboard', workspaceId: foreign.id, organizationId: foreign.organization_id, role: 'viewer' });
    const result = await h.agent.post(path + '/publish').set('x-siftgate-workspace-id', foreign.id).send({ ...options, time_basis_confirmation: { basis: 'completed_at', content_hash: preview.body.content_hash, reference: 'SYNTHETIC-FOREIGN', confirmed: true } }); expect([403, 404]).toContain(result.status); expect(await db.query('SELECT * FROM pricing_book_versions')).toEqual([]); expect(h.fetchMock.calls).toHaveLength(0);
  });
});

import { DataSource } from 'typeorm';
import { createE2EHarness, type E2EHarness } from './setup';
import { applyPricingSchema } from '../../src/pricing/pricing-schema';
import { PricingRecoveryService } from '../../src/pricing/pricing-recovery.service';
import { tokenBook } from '../unit/pricing-fixtures';

const base = '/api/dashboard/pricing';
const options = { draft_revision: 1, catalog_revision: 0, confirm: true, reason: 'Synthetic FX review', targets: [{ level: 'model', model: 'gpt-4o', operation: 'chat_completions' }] };
describe('publication FX review HTTP', () => {
  let h: E2EHarness, db: DataSource;
  beforeEach(async () => { h = await createE2EHarness(); await h.app.get(PricingRecoveryService).onModuleDestroy(); db = h.app.get(DataSource); await applyPricingSchema(db); });
  afterEach(async () => { await h?.close(); });
  const create = async (currency = 'CNY') => {
    const content = tokenBook(); content.currency = currency;
    return (await h.agent.post(base + '/books').send({ name: 'Synthetic price', scope: 'workspace', content })).body;
  };
  it('warns in read-only preview, accepts explicit missing-FX review, and preserves the review in audit', async () => {
    const created = await create();
    const before = await db.query('SELECT * FROM pricing_audit_events');
    const preview = await h.agent.post(`${base}/drafts/${created.draft.id}/preview-publication`).send(options);
    expect(preview.status).toBe(201); expect(preview.body.fx_review).toMatchObject({ status: 'incomplete', from_currency: 'CNY', report_currency: 'USD', diagnostics: [{ code: 'pricing_fx_missing' }] });
    expect(await db.query('SELECT * FROM pricing_audit_events')).toEqual(before);
    const published = await h.agent.post(`${base}/drafts/${created.draft.id}/publish`).send({ ...options, fx_review_status: preview.body.fx_review.status });
    expect(published.status).toBe(201); expect(published.body.fx_review.status).toBe('incomplete');
    const audit = (await db.query("SELECT metadata_json FROM pricing_audit_events WHERE action = 'draft.published'"))[0];
    expect(JSON.parse(audit.metadata_json)).toMatchObject({ fx_review_confirmed: true }); expect(h.fetchMock.calls).toHaveLength(0);
  });
  it('rejects malformed or inconsistent acknowledgments without consuming the draft', async () => {
    const created = await create();
    for (const status of ['', 'invented', true, null, { status: 'incomplete' }]) {
      expect((await h.agent.post(`${base}/drafts/${created.draft.id}/publish`).send({ ...options, fx_review_status: status })).status).toBe(400);
    }
    const wrong = await h.agent.post(`${base}/drafts/${created.draft.id}/publish`).send({ ...options, fx_review_status: 'covered' });
    expect(wrong.status).toBe(409); expect(wrong.body.error.code).toBe('pricing_version_conflict');
    expect(await db.query('SELECT * FROM pricing_book_versions')).toEqual([]); expect(await db.query('SELECT * FROM pricing_drafts')).toHaveLength(1); expect(h.fetchMock.calls).toHaveLength(0);
  });
  it('keeps original API clients compatible and reports no conversion needed for USD', async () => {
    const created = await create('USD');
    const preview = await h.agent.post(`${base}/drafts/${created.draft.id}/preview-publication`).send(options);
    expect(preview.body.fx_review).toMatchObject({ status: 'not_required', gaps: [], diagnostics: [] });
    const published = await h.agent.post(`${base}/drafts/${created.draft.id}/publish`).send(options);
    expect(published.status).toBe(201); expect(published.body.fx_review.status).toBe('not_required'); expect(h.fetchMock.calls).toHaveLength(0);
  });
});

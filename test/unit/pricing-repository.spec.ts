import { DataSource, EntityManager } from 'typeorm';
import type { CompiledPricingCatalog } from '../../src/pricing/pricing-catalog';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PricingRepository } from '../../src/pricing/pricing-repository';
import { applyPricingSchema } from '../../src/pricing/pricing-schema';
import type {
  PricingActor,
  PricingPublishOptions,
} from '../../src/pricing/pricing-repository.types';
import { tokenBook, tokens } from './pricing-fixtures';
import { mockConfigService } from '../helpers';
import * as admissionClock from '../../src/pricing/pricing-admission-clock';
import { PricingAdmissionClockWait } from '../../src/pricing/pricing-admission-clock';

const admin: PricingActor = {
  id: 'admin-a',
  workspace_id: 'workspace-a',
  role: 'admin',
  global_admin: true,
};
const other: PricingActor = {
  id: 'admin-b',
  workspace_id: 'workspace-b',
  role: 'admin',
  global_admin: false,
};
const target = { model: 'synthetic-model', node_id: 'node-a' };
const usage = () => tokens({ input_tokens: 1000, output_tokens: 0 });
const options = (draftRevision: number, catalogRevision: number): PricingPublishOptions => ({
  draft_revision: draftRevision,
  catalog_revision: catalogRevision,
  reason: 'synthetic publication',
  confirm: true,
  targets: [{ level: 'model', model: target.model }],
});

function repositoryContract(
  label: string,
  connect: () => Promise<{ dataSource: DataSource; cleanup: () => Promise<void> }>,
  run: (name: string, body: () => void) => void = describe,
) {
  run(label, () => {
    let dataSource: DataSource;
    let cleanup: () => Promise<void>;
    let repo: PricingRepository;
    beforeEach(async () => {
      ({ dataSource, cleanup } = await connect());
      repo = new PricingRepository(dataSource);
    });
    afterEach(async () => {
      if (dataSource?.isInitialized) await dataSource.destroy();
      await cleanup?.();
    });
    const create = async (actor = admin, scope: 'workspace' | 'global' = 'workspace') =>
      repo.createBook(actor, { name: 'Synthetic rates', scope, content: tokenBook() });

    it('publication FX reviews missing conversion without writes and preserves explicit unknown reporting', async () => {
      await applyPricingSchema(dataSource);
      const content = tokenBook(); content.currency = 'CNY';
      const created = await repo.createBook(admin, { name: 'Synthetic CNY', scope: 'workspace', content });
      const tables = ['pricing_catalog_head', 'pricing_catalog_revisions', 'pricing_book_versions', 'pricing_drafts', 'pricing_audit_events'];
      const dump = () => Promise.all(tables.map(table => dataSource.query(`SELECT * FROM ${table}`)));
      const before = await dump();
      const preview = await repo.previewPublish(admin, created.draft.id, options(1, 0));
      expect(preview).toMatchObject({ fx_review: { status: 'incomplete', from_currency: 'CNY', report_currency: 'USD', workspace_id: admin.workspace_id, diagnostics: [{ code: 'pricing_fx_missing' }] } });
      expect(await dump()).toEqual(before);
      // Existing API clients can still publish original-currency prices before configuring FX.
      const published = await repo.publishDraft(admin, created.draft.id, options(1, 0));
      expect(published).toMatchObject({ fx_review: { status: 'incomplete' } });
      const snapshot = (await repo.capture({ request_id: 'synthetic-missing-fx', workspace_id: admin.workspace_id, report_currency: 'USD' }))!;
      expect(snapshot.quote(target, usage()).cost).toMatchObject({ currency: 'CNY', amount: '0.001000000', report_amount: null, diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'pricing_fx_missing' })]) });
      const audit = (await dataSource.query("SELECT metadata_json FROM pricing_audit_events WHERE action = 'draft.published'"))[0];
      expect(JSON.parse(audit.metadata_json)).toMatchObject({ fx_review: { status: 'incomplete' }, fx_review_confirmed: false });
    });

    it('publication FX rejects an incorrect reviewed status atomically and audits explicit acknowledgment', async () => {
      await applyPricingSchema(dataSource);
      const content = tokenBook(); content.currency = 'CNY';
      const created = await repo.createBook(admin, { name: 'Synthetic CNY', scope: 'workspace', content });
      const reviewed = { ...options(1, 0), fx_review_status: 'covered' as const };
      await expect(repo.publishDraft(admin, created.draft.id, reviewed)).rejects.toMatchObject({ code: 'pricing_version_conflict', status: 409 });
      expect(await dataSource.query('SELECT * FROM pricing_book_versions')).toEqual([]);
      expect((await repo.listBindings(admin)).head.revision).toBe(0);
      const acknowledged = { ...reviewed, fx_review_status: 'incomplete' as const };
      await repo.publishDraft(admin, created.draft.id, acknowledged);
      const audit = (await dataSource.query("SELECT metadata_json FROM pricing_audit_events WHERE action = 'draft.published'"))[0];
      expect(JSON.parse(audit.metadata_json)).toMatchObject({ fx_review_confirmed: true, fx_review: { status: 'incomplete' } });
    });

    it('publication FX uses the proposed interval and catalog for scheduled publication and rollback', async () => {
      await applyPricingSchema(dataSource);
      const start = new Date(Date.now() + 60000).toISOString(), end = new Date(Date.now() + 120000).toISOString();
      const content = tokenBook(); content.currency = 'CNY';
      const created = await repo.createBook(admin, { name: 'Synthetic scheduled CNY', scope: 'workspace', content });
      await repo.updateFx(admin, { catalog_revision: 0, reason: 'Synthetic fixed FX', confirm: true, scope: 'global', versions: [{ fx: { version_id: 'synthetic-global', from_currency: 'CNY', to_currency: 'USD', numerator: '1', denominator: '7', effective_at: start, source: 'Synthetic only' }, effective_to: end }] });
      const scheduled = { ...options(1, 1), effective_from: start, effective_to: end };
      expect(await repo.previewPublish(admin, created.draft.id, scheduled)).toMatchObject({ fx_review: { status: 'covered', window: { effective_from: start, effective_to: end }, gaps: [] } });
      const published = await repo.publishDraft(admin, created.draft.id, scheduled);
      await repo.cancelScheduled(admin, published.bindings[0].id, 2, 'Synthetic cancellation');
      const rollback = { ...options(0, 3), effective_from: end, effective_to: undefined };
      expect(await repo.previewRollback(admin, created.book.id, published.version_id, rollback)).toMatchObject({ fx_review: { status: 'incomplete', gaps: [{ effective_from: end, effective_to: null }] } });
      const restored = await repo.rollback(admin, created.book.id, published.version_id, { ...rollback, fx_review_status: 'incomplete' } as PricingPublishOptions);
      expect(restored).toMatchObject({ fx_review: { status: 'incomplete' } });
      expect(restored.version_id).not.toBe(published.version_id);
    });

    it('publication FX fences a peer FX update and cannot borrow another workspace conversion', async () => {
      await applyPricingSchema(dataSource);
      const content = tokenBook(); content.currency = 'CNY';
      const created = await repo.createBook(admin, { name: 'Synthetic scoped CNY', scope: 'workspace', content });
      const before = await repo.previewPublish(admin, created.draft.id, options(1, 0));
      expect(before.fx_review.status).toBe('incomplete');
      const peer = new PricingRepository(dataSource);
      await peer.updateFx(other, { catalog_revision: 0, reason: 'Synthetic foreign FX', confirm: true, scope: 'workspace', versions: [{ fx: { version_id: 'synthetic-foreign', from_currency: 'CNY', to_currency: 'USD', numerator: '1', denominator: '7', effective_at: new Date(Date.now() - 1000).toISOString(), source: 'Synthetic' } }] });
      await expect(repo.publishDraft(admin, created.draft.id, { ...options(1, 0), fx_review_status: before.fx_review.status })).rejects.toMatchObject({ status: 409 });
      const after = await repo.previewPublish(admin, created.draft.id, options(1, 1));
      expect(after.fx_review).toMatchObject({ status: 'incomplete', fx_version_ids: [] });
      expect(await dataSource.query('SELECT * FROM pricing_book_versions')).toEqual([]);
      await expect(repo.previewPublish(other, created.draft.id, options(1, 1))).rejects.toMatchObject({ status: 404 });
    });

    it('retains unambiguous ordinary-fork ancestry after identical-price drafts are consumed', async () => {
      await applyPricingSchema(dataSource);
      const created = await create();
      const first = await repo.publishDraft(admin, created.draft.id, options(1, 0));
      const next = await repo.forkDraft(admin, created.book.id, first.version_id);
      const changed = tokenBook(); changed.groups[0].rules[0].rates[0].component.amount = '2';
      const nextSaved = await repo.updateDraft(admin, next.id, next.revision, changed);
      const second = await repo.publishDraft(admin, next.id, options(nextSaved.revision, 1));
      const originalVersions = await dataSource.query('SELECT * FROM pricing_book_versions ORDER BY version_id');
      const earlierAudits = await dataSource.query('SELECT * FROM pricing_audit_events ORDER BY id');
      const a = await repo.forkDraft(admin, created.book.id, first.version_id);
      const b = await repo.forkDraft(admin, created.book.id, second.version_id);
      changed.groups[0].rules[0].rates[0].component.amount = '3';
      const savedA = await repo.updateDraft(admin, a.id, a.revision, changed);
      const savedB = await repo.updateDraft(admin, b.id, b.revision, changed);
      // Publish in reverse fork order with identical content. Neither timestamps,
      // current activation nor content equality can substitute for a lineage edge.
      const publishedB = await repo.publishDraft(admin, b.id, options(savedB.revision, 2));
      const publishedA = await repo.publishDraft(admin, a.id, options(savedA.revision, 3));
      expect(publishedA.content_hash).toBe(publishedB.content_hash);
      const auditRows: Array<{ id: string; book_id: string; workspace_id: string; action: string; metadata_json: string }> =
        await dataSource.query('SELECT * FROM pricing_audit_events ORDER BY id');
      const events = auditRows.map(row => ({ ...row, metadata: JSON.parse(row.metadata_json) as Record<string, unknown> }));
      for (const [published, draft, source] of [[publishedA, a, first], [publishedB, b, second]] as const) {
        const publication = events.find(event => event.action === 'draft.published' && event.metadata.version_id === published.version_id)!;
        expect(publication).toMatchObject({ book_id: created.book.id, workspace_id: admin.workspace_id });
        expect(publication.metadata.draft_id).toBe(draft.id);
        const origin = events.find(event => event.action === 'draft.created' && event.metadata.draft_id === publication.metadata.draft_id)!;
        expect(origin).toMatchObject({ book_id: created.book.id, workspace_id: admin.workspace_id });
        expect(origin.metadata).toMatchObject({ version_id: source.version_id, content_hash: source.content_hash });
        // Restore through a fresh repository, not a cached draft or current price.
        const immutable = await new PricingRepository(dataSource).getVersion(admin, created.book.id, source.version_id);
        expect(immutable.content_hash).toBe(origin.metadata.content_hash);
      }
      expect(await dataSource.query('SELECT * FROM pricing_drafts')).toEqual([]);
      const versions: Array<{ version_id: string }> = await dataSource.query('SELECT * FROM pricing_book_versions ORDER BY version_id');
      for (const original of originalVersions) expect(versions.find(row => row.version_id === original.version_id)).toEqual(original);
      for (const original of earlierAudits) expect(auditRows.find(row => row.id === original.id)).toEqual(original);
      const rootPublication = events.find(event => event.action === 'draft.published' && event.metadata.version_id === first.version_id)!;
      const rootCreation = events.find(event => event.action === 'book.created')!;
      expect(rootPublication.metadata.draft_id).toBe(rootCreation.metadata.draft_id);
    });

    it('inspects unmigrated pricing read-only and rejects incomplete markers without implicit migration', async () => {
      const targets = [{ ...target, operation: 'chat_completions' }];
      const page = await repo.modelPricingStatus({ ...admin, role: 'viewer' }, targets);
      expect(page).toMatchObject({ schema_available: false, read_only: true, supplier_support_verified: false, head: null, rows: [{ target: targets[0], current: null, scheduled: [], legacy_reference: null, policy: { mode: 'compatibility', budget_basis: 'legacy_logical' } }] });
      const runner = dataSource.createQueryRunner();
      try { expect(await runner.hasTable('pricing_schema_versions')).toBe(false); } finally { await runner.release(); }
      await applyPricingSchema(dataSource);
      await dataSource.query('DELETE FROM pricing_schema_versions');
      await expect(new PricingRepository(dataSource).modelPricingStatus(admin, targets)).rejects.toMatchObject({ code: 'pricing_schema_required', status: 503 });
      expect(await dataSource.query('SELECT * FROM pricing_schema_versions')).toEqual([]);
    });

    it('rejects malformed, duplicate or unbounded model inspection targets before reading pricing state', async () => {
      const valid = { ...target, operation: 'chat_completions' };
      for (const targets of [[], [null], [valid, valid], [{ ...valid, role: 'admin' }], [{ ...valid, node_id: '' }], [{ ...valid, operation: 'unknown' }], Array.from({ length: 21 }, (_, i) => ({ ...valid, model: `model-${i}` }))]) {
        await expect(repo.modelPricingStatus(admin, targets as never)).rejects.toMatchObject({ status: 400 });
      }
    });

    it('restricts inspection to configured model identities and labels legacy data as reference only', async () => {
      const config = mockConfigService({ nodes: [{ id: 'node-a', models: [target.model], embedding_models: ['embedding'], model_aliases: { alias: target.model }, model_capabilities: { [target.model]: { pricing: { input: 1, output: 2 } } } }], modelsPricing: {} });
      config.getModelPricing.mockReturnValue({ input: 1, output: 2, currency: 'EUR' });
      const configured = new PricingRepository(dataSource, config);
      const result = await configured.modelPricingStatus(admin, [{ ...target, operation: 'chat_completions' }]);
      expect(result.rows[0].legacy_reference).toEqual({ source: 'node_model_config', currency: 'EUR', review_required: true });
      expect(result.rows[0].current).toBeNull();
      for (const change of [{ node_id: 'unknown' }, { model: 'unknown' }, { model: 'alias' }]) await expect(configured.modelPricingStatus(admin, [{ ...target, operation: 'chat_completions', ...change }])).rejects.toMatchObject({ status: 404 });
      expect((await configured.modelPricingStatus(admin, [{ ...target, model: 'embedding', operation: 'embeddings' }])).rows).toHaveLength(1);
    });

    it('reads current and scheduled inherited prices with quote parity and tenant isolation, without state writes', async () => {
      await applyPricingSchema(dataSource);
      const first = await create(admin, 'global');
      const parent = await repo.publishDraft(admin, first.draft.id, options(1, 0));
      const child = await repo.createInheritedBook(admin, { name: 'Synthetic child', scope: 'workspace', definition: {
        schema_version: 1, parent: { book_id: first.book.id, version_id: parent.version_id, content_hash: parent.content_hash }, inherit: 'all',
        source: { kind: 'manual', reference: 'https://user:synthetic@example.test/pricing?token=synthetic#private' }, rate_overrides: [], removed_component_ids: [], replaced_groups: [], added_groups: [], removed_group_ids: [], settings: {}, calendar: { mode: 'inherit' },
      } });
      const future = new Date(Date.now() + 3600000).toISOString(), expiry = new Date(Date.now() + 7200000).toISOString();
      const published = await repo.publishDraft(admin, child.draft.id, { ...options(1, 1), effective_from: future, effective_to: expiry, targets: [{ level: 'node', node_id: target.node_id, model: target.model, operation: 'chat_completions' }] });
      await repo.updateAdmissionPolicy(admin, { catalog_revision: 2, scope: 'workspace', operation: 'chat_completions', policy: { mode: 'reject_unpriced' }, reason: 'Synthetic policy', confirm: true });
      const inspectionTarget = { ...target, operation: 'chat_completions' };
      const snapshot = (await repo.capture({ request_id: 'before-inspection', workspace_id: admin.workspace_id, report_currency: 'USD' }))!;
      const tables = ['pricing_books', 'pricing_drafts', 'pricing_book_versions', 'pricing_version_inheritance', 'pricing_catalog_head', 'pricing_catalog_revisions', 'pricing_audit_events', 'pricing_request_snapshots'];
      const dump = async () => Promise.all(tables.map(name => dataSource.query(`SELECT * FROM ${name}`)));
      const before = await dump();
      const page = await repo.modelPricingStatus({ ...admin, role: 'viewer' }, [inspectionTarget, { ...inspectionTarget, operation: 'responses' }]);
      expect(page.rows[0].current?.binding.id).toBe(snapshot.quote(inspectionTarget, usage()).binding_id);
      expect(page.rows[0].policy.mode).toBe('reject_unpriced'); expect(page.rows[1].policy.mode).toBe('compatibility');
      expect(page.rows[0].scheduled).toMatchObject([
        { effective_at: future, price: { binding: { book_id: child.book.id, version_id: published.version_id }, parent: { book_id: first.book.id, version_id: parent.version_id }, source: { reference: 'https://example.test/pricing' } } },
        { effective_at: expiry, price: { binding: { book_id: first.book.id, version_id: parent.version_id } } },
      ]);
      expect(page.rows[1].scheduled).toEqual([]);
      const outsider = await repo.modelPricingStatus({ ...other, role: 'viewer' }, [inspectionTarget]);
      expect(outsider.rows[0].current?.binding.book_id).toBe(first.book.id); expect(outsider.rows[0].scheduled).toEqual([]);
      expect(JSON.stringify(outsider)).not.toContain(child.book.id);
      expect(JSON.stringify(page)).not.toContain('user:synthetic'); expect(JSON.stringify(page)).not.toContain('token=');
      expect(await dump()).toEqual(before);
      page.rows[0].current!.binding.id = 'mutated';
      expect((await repo.modelPricingStatus(admin, [inspectionTarget])).rows[0].current?.binding.id).not.toBe('mutated');
    });

    it('restores rule names from their original immutable catalog using a fresh database connection', async () => {
      await applyPricingSchema(dataSource);
      const content = tokenBook(); content.groups[0].rules[0].name = 'Original 名称';
      const first = await repo.createBook(admin, { name: 'Named fixture', scope: 'workspace', content });
      const original = await repo.publishDraft(admin, first.draft.id, options(1, 0));
      const captured = (await repo.capture({ request_id: 'named-history', workspace_id: admin.workspace_id, report_currency: 'USD' }))!;
      const originalCost = captured.quote(target, usage()).cost;
      const originalVersions = await dataSource.query('SELECT * FROM pricing_book_versions');
      const draft = await repo.forkDraft(admin, first.book.id, original.version_id);
      expect(draft.content.groups[0].rules[0].name).toBe('Original 名称');
      draft.content.groups[0].rules[0].name = 'New 名称';
      const updated = await repo.updateDraft(admin, draft.id, draft.revision, draft.content);
      await repo.publishDraft(admin, draft.id, options(updated.revision, 1));
      const connection = await new DataSource({ ...dataSource.options, synchronize: false }).initialize();
      try {
        const restored = new PricingRepository(connection);
        expect((await restored.restoreRequest('named-history', admin.workspace_id)).quote(target, usage()).cost).toEqual(originalCost);
        expect(originalCost.selection!.evaluations[0]).toMatchObject({ rule_id: 'base-rate', rule_name: 'Original 名称' });
        const next = (await restored.capture({ request_id: 'new-named-history', workspace_id: admin.workspace_id, report_currency: 'USD' }))!.quote(target, usage()).cost;
        expect(next.amount).toBe(originalCost.amount); expect(next.selection!.evaluations[0].rule_name).toBe('New 名称');
        expect((await restored.getVersion(admin, first.book.id, original.version_id)).content.groups[0].rules[0].name).toBe('Original 名称');
        const rows = await connection.query('SELECT * FROM pricing_book_versions');
        expect(rows.find((row: { version_id: string }) => row.version_id === original.version_id)).toEqual(originalVersions[0]);
      } finally { await connection.destroy(); }
    });

    it('captures immutable request identity and currency before the first asynchronous boundary', async () => {
      await applyPricingSchema(dataSource); const book = await create(); await repo.publishDraft(admin, book.draft.id, options(1, 0));
      const input = { request_id: 'original-request', workspace_id: admin.workspace_id, report_currency: 'USD' };
      const pending = repo.capture(input); input.request_id = 'mutated-request'; input.workspace_id = other.workspace_id; input.report_currency = 'CNY';
      const snapshot = await pending;
      expect(snapshot!.descriptor()).toMatchObject({ workspace_id: admin.workspace_id, report_currency: 'USD' });
      expect((await dataSource.query('SELECT request_id,workspace_id FROM pricing_request_snapshots'))).toEqual([{ request_id: 'original-request', workspace_id: admin.workspace_id }]);
    });
    if (label.startsWith('PostgreSQL')) {
      it('captures warm snapshots in four real transports while retaining the conditional head lock and fresh post-insert read', async () => {
        await applyPricingSchema(dataSource); const book = await create(); await repo.publishDraft(admin, book.draft.id, options(1, 0));
        await repo.capture({ request_id: 'warm', workspace_id: admin.workspace_id, report_currency: 'USD' });
        const queries = jest.spyOn(dataSource.logger, 'logQuery');
        try {
          const snapshot = await repo.capture({ request_id: 'four-transports', workspace_id: admin.workspace_id, report_currency: 'USD' });
          expect(snapshot!.quote(target, usage()).cost.amount).toBe('0.001000000');
          const sql = queries.mock.calls.map(([sql]) => sql);
          expect(sql).toHaveLength(4); expect(sql[0]).toContain('/* siftgate_transaction_read_prelude:1 */');
          expect(sql[1]).toContain('FROM "pricing_catalog_head"'); expect(sql[1]).toContain('FOR SHARE');
          expect(sql[2]).toContain('/* siftgate_snapshot_insert_read:2 */'); expect(sql[2]).toContain(';\nSELECT s.*'); expect(sql[3]).toBe('COMMIT');
          queries.mockClear(); await repo.capture({ request_id: 'four-transports', workspace_id: admin.workspace_id, report_currency: 'USD' });
          expect(queries.mock.calls.some(([sql]) => sql.includes('pricing_catalog_head'))).toBe(false);
        } finally { queries.mockRestore(); }
      });
      it.each(['corrupt-body', 'changed-workspace'] as const)('checks fresh %s AFTER-trigger effects before acknowledging admission', async defect => {
        await applyPricingSchema(dataSource); const book = await create(); await repo.publishDraft(admin, book.draft.id, options(1, 0));
        const assignment = defect === 'corrupt-body' ? "snapshot_hash='tampered-after-insert'" : "workspace_id='foreign-workspace'";
        await dataSource.query(`CREATE FUNCTION mutate_capture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE pricing_request_snapshots SET ${assignment} WHERE request_id=NEW.request_id; RETURN NULL; END $$`);
        await dataSource.query('CREATE TRIGGER mutate_capture AFTER INSERT ON pricing_request_snapshots FOR EACH ROW EXECUTE FUNCTION mutate_capture()');
        await expect(repo.capture({ request_id: 'after-trigger', workspace_id: admin.workspace_id, report_currency: 'USD' })).rejects.toMatchObject({ status: defect === 'corrupt-body' ? 503 : 403 });
        expect(await dataSource.query('SELECT * FROM pricing_request_snapshots')).toEqual([]);
      });
      it('concurrent snapshot admission restores one immutable winner and denies a foreign-workspace collision', async () => {
        await applyPricingSchema(dataSource); const book = await create(); await repo.publishDraft(admin, book.draft.id, options(1, 0));
        const input = { request_id: "request'\\metadata", workspace_id: admin.workspace_id, report_currency: 'USD' };
        const results = await Promise.all([repo.capture(input), new PricingRepository(dataSource).capture(input)]);
        expect(results[0]!.descriptor()).toEqual(results[1]!.descriptor());
        expect(await dataSource.query('SELECT * FROM pricing_request_snapshots')).toHaveLength(1);
        await expect(repo.capture({ ...input, workspace_id: other.workspace_id })).rejects.toMatchObject({ status: 403 });
        expect(await dataSource.query('SELECT * FROM pricing_request_snapshots')).toHaveLength(1);
      });
    }

    it('releases every admission lock during clock recovery and rechecks a concurrently published head', async () => {
      await applyPricingSchema(dataSource);
      const first = await create();
      await repo.publishDraft(admin, first.draft.id, options(1, 0));
      const before = await dataSource.query('SELECT * FROM pricing_catalog_revisions');
      const created = Date.parse(JSON.parse(before[0].manifest_json).created_at);
      let now = created - 53;
      const clock = jest.spyOn(admissionClock, 'readPricingAdmissionTime').mockImplementation(() => new Date(now));
      const originalWait = PricingAdmissionClockWait.prototype.wait;
      const wait = jest.spyOn(PricingAdmissionClockWait.prototype, 'wait').mockImplementationOnce(async function (this: PricingAdmissionClockWait, milliseconds) {
        expect(milliseconds).toBe(53);
        expect(await dataSource.query('SELECT * FROM pricing_request_snapshots')).toHaveLength(0);
        now = created + 10;
        // This independent writer deadlocks if either the transaction or the
        // shared SQLite serialization fence is still retained by admission.
        await new PricingRepository(dataSource).updateAdmissionPolicy(admin, {
          catalog_revision: 1, scope: 'workspace', reason: 'Synthetic concurrent publication', confirm: true,
          policy: { mode: 'reject_unpriced' },
        });
        const revisions = await dataSource.query('SELECT manifest_json FROM pricing_catalog_revisions');
        now = Math.max(...revisions.map((row: { manifest_json: string }) => Date.parse(JSON.parse(row.manifest_json).created_at))) + 10;
        await originalWait.call(this, milliseconds);
      });
      try {
        const captured = await repo.capture({ request_id: 'clock-publication', workspace_id: admin.workspace_id, report_currency: 'USD' });
        expect(wait).toHaveBeenCalledTimes(1);
        expect(captured!.admissionPolicy().mode).toBe('reject_unpriced');
        expect(captured!.descriptor().admitted_at).toBe(new Date(now).toISOString());
        expect(captured!.descriptor().catalog_revision_id).not.toBe(before[0].id);
        expect((await dataSource.query('SELECT * FROM pricing_catalog_revisions')).find((row: { id: string }) => row.id === before[0].id)).toEqual(before[0]);
      } finally { wait.mockRestore(); clock.mockRestore(); }
    });

    it('returns the concurrent idempotent winner after a clock wait instead of replacing its snapshot', async () => {
      await applyPricingSchema(dataSource);
      const first = await create(); await repo.publishDraft(admin, first.draft.id, options(1, 0));
      const rows = await dataSource.query('SELECT manifest_json FROM pricing_catalog_revisions');
      const created = Date.parse(JSON.parse(rows[0].manifest_json).created_at);
      let now = created - 53;
      const clock = jest.spyOn(admissionClock, 'readPricingAdmissionTime').mockImplementation(() => new Date(now));
      const input = { request_id: 'clock-idempotent', workspace_id: admin.workspace_id, report_currency: 'USD' };
      let winner: Awaited<ReturnType<PricingRepository['capture']>>;
      const wait = jest.spyOn(PricingAdmissionClockWait.prototype, 'wait').mockImplementationOnce(async () => {
        now = created + 10;
        winner = await new PricingRepository(dataSource).capture(input);
        now = created - 10001;
      });
      try {
        const result = await repo.capture(input);
        expect(result!.descriptor()).toEqual(winner!.descriptor());
        expect(wait).toHaveBeenCalledTimes(1);
        expect(await dataSource.query('SELECT * FROM pricing_request_snapshots')).toHaveLength(1);
      } finally { wait.mockRestore(); clock.mockRestore(); }
    });

    it('rejects excessive clock skew without catalog changes, request snapshots or repeated sleeps', async () => {
      await applyPricingSchema(dataSource);
      const first = await create(); await repo.publishDraft(admin, first.draft.id, options(1, 0));
      const rows = await dataSource.query('SELECT * FROM pricing_catalog_revisions');
      const created = Date.parse(JSON.parse(rows[0].manifest_json).created_at);
      const clock = jest.spyOn(admissionClock, 'readPricingAdmissionTime').mockImplementation(() => new Date(created - 10001));
      try {
        await expect(repo.capture({ request_id: 'clock-too-far', workspace_id: admin.workspace_id, report_currency: 'USD' })).rejects.toMatchObject({ statusCode: 503, code: 'pricing_clock_skew' });
        expect(await dataSource.query('SELECT * FROM pricing_request_snapshots')).toHaveLength(0);
        expect(await dataSource.query('SELECT * FROM pricing_catalog_revisions')).toEqual(rows);
      } finally { clock.mockRestore(); }
    });

    it('restores an existing snapshot unchanged during clock rollback and still rejects backdated tampering', async () => {
      await applyPricingSchema(dataSource);
      const first = await create(); await repo.publishDraft(admin, first.draft.id, options(1, 0));
      const input = { request_id: 'clock-existing', workspace_id: admin.workspace_id, report_currency: 'USD' };
      const original = await repo.capture(input);
      const rows = await dataSource.query('SELECT manifest_json FROM pricing_catalog_revisions');
      const created = Date.parse(JSON.parse(rows[0].manifest_json).created_at);
      const clock = jest.spyOn(admissionClock, 'readPricingAdmissionTime').mockImplementation(() => new Date(created - 10001));
      const wait = jest.spyOn(PricingAdmissionClockWait.prototype, 'wait');
      try {
        expect((await new PricingRepository(dataSource).capture(input))!.descriptor()).toEqual(original!.descriptor());
        expect(wait).not.toHaveBeenCalled();
        const altered = { ...original!.descriptor(), admitted_at: new Date(created - 1).toISOString() };
        await dataSource.createQueryBuilder().update('pricing_request_snapshots').set({ descriptor_json: JSON.stringify(altered) }).where('request_id = :id', { id: input.request_id }).execute();
        await expect(new PricingRepository(dataSource).restoreRequest(input.request_id, input.workspace_id)).rejects.toThrow();
        expect(wait).not.toHaveBeenCalled();
      } finally { wait.mockRestore(); clock.mockRestore(); }
    });

    it('enforces total published rules across workspaces while counting shared-version bindings once', async () => {
      await applyPricingSchema(dataSource);
      repo = new PricingRepository(dataSource, mockConfigService({ pricingLimits: { max_published_rules: 1 } }));
      const first = await create();
      await repo.publishDraft(admin, first.draft.id, { ...options(1, 0), targets: [
        { level: 'model', model: target.model }, { level: 'node', node_id: target.node_id, model: target.model },
      ] });
      const second = await create(other);
      const proposed = { ...options(1, 1), targets: [{ level: 'model' as const, model: 'another-model' }] };
      const before = await dataSource.query('SELECT * FROM pricing_catalog_head');
      const audits = await dataSource.query('SELECT * FROM pricing_audit_events ORDER BY id');
      await expect(repo.previewPublish(other, second.draft.id, proposed)).rejects.toMatchObject({ code: 'pricing_capacity_exceeded', status: 400 });
      await expect(repo.publishDraft(other, second.draft.id, proposed)).rejects.toMatchObject({ code: 'pricing_capacity_exceeded' });
      expect(await dataSource.query('SELECT * FROM pricing_catalog_head')).toEqual(before);
      expect(await dataSource.query('SELECT * FROM pricing_audit_events ORDER BY id')).toEqual(audits);
      expect(await dataSource.query('SELECT * FROM pricing_book_versions')).toHaveLength(1);
      expect((await repo.getDraft(other, second.draft.id)).revision).toBe(1);
    });

    it('includes scheduled prices, but allows cancellation after lowering the ceiling', async () => {
      await applyPricingSchema(dataSource);
      const limits = { max_published_rules: 2 };
      repo = new PricingRepository(dataSource, mockConfigService({ pricingLimits: limits }));
      const first = await create(); await repo.publishDraft(admin, first.draft.id, options(1, 0));
      const scheduled = await create();
      const change = await repo.publishDraft(admin, scheduled.draft.id, { ...options(1, 1), effective_from: new Date(Date.now() + 3600000).toISOString() });
      const frozen = await repo.capture({ request_id: 'before-limit-reduction', workspace_id: admin.workspace_id, report_currency: 'USD' });
      limits.max_published_rules = 1;
      const extra = await create();
      await expect(repo.previewPublish(admin, extra.draft.id, { ...options(1, 2), targets: [{ level: 'model', model: 'extra' }] })).rejects.toMatchObject({ code: 'pricing_capacity_exceeded' });
      expect(frozen!.quote(target, usage()).cost.amount).toBe('0.001000000');
      await repo.cancelScheduled(admin, change.bindings[0].id, 2, 'Cancel synthetic future activation');
      expect((await repo.listBindings(admin)).bindings).toHaveLength(1);
      expect(await dataSource.query('SELECT * FROM pricing_book_versions')).toHaveLength(2);
      const restored = await new PricingRepository(dataSource, mockConfigService({ pricingLimits: limits })).restoreRequest('before-limit-reduction', admin.workspace_id);
      expect(restored.quote(target, usage()).cost.amount).toBe('0.001000000');
    });

    it('does not bypass the ceiling through concurrent publication or a stale revision retry', async () => {
      await applyPricingSchema(dataSource);
      const config = mockConfigService({ pricingLimits: { max_published_rules: 1 } });
      repo = new PricingRepository(dataSource, config);
      const books = [await create(), await create()];
      const results = await Promise.allSettled(books.map((book, index) => new PricingRepository(dataSource, config)
        .publishDraft(admin, book.draft.id, { ...options(1, 0), targets: [{ level: 'model', model: `bounded-${index}` }] })));
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      const loser = results.findIndex(result => result.status === 'rejected');
      await expect(repo.publishDraft(admin, books[loser].draft.id, { ...options(1, 1), targets: [{ level: 'model', model: `bounded-${loser}` }] }))
        .rejects.toMatchObject({ code: 'pricing_capacity_exceeded' });
      expect((await repo.listBindings(admin)).head.revision).toBe(1);
      expect(await dataSource.query('SELECT * FROM pricing_book_versions')).toHaveLength(1);
    });

    it('preserves active and historical prices and non-price policy operations above a newly lowered limit', async () => {
      await applyPricingSchema(dataSource);
      const limits = { max_published_rules: 2 };
      const config = mockConfigService({ pricingLimits: limits });
      repo = new PricingRepository(dataSource, config);
      const first = await create(); await repo.publishDraft(admin, first.draft.id, options(1, 0));
      const second = await create(); await repo.publishDraft(admin, second.draft.id, { ...options(1, 1), targets: [{ level: 'model', model: 'other-model' }] });
      await repo.capture({ request_id: 'frozen-over-limit', workspace_id: admin.workspace_id, report_currency: 'USD' });
      limits.max_published_rules = 1;
      repo = new PricingRepository(dataSource, config);
      expect((await repo.restoreRequest('frozen-over-limit', admin.workspace_id)).quote(target, usage()).cost.amount).toBe('0.001000000');
      expect((await repo.capture({ request_id: 'new-over-limit', workspace_id: admin.workspace_id, report_currency: 'USD' }))!.quote(target, usage()).cost.amount).toBe('0.001000000');
      await repo.updateAdmissionPolicy(admin, { catalog_revision: 2, reason: 'Metadata remains manageable', confirm: true, scope: 'workspace', policy: { mode: 'compatibility' } });
      expect((await repo.status()).limits.max_published_rules).toBe(1);
      expect((await repo.listBindings(admin)).head.revision).toBe(3);
    });

    it('applies the same ceiling to rollback without removing the older published content', async () => {
      await applyPricingSchema(dataSource);
      const limits = { max_published_rules: 2 };
      repo = new PricingRepository(dataSource, mockConfigService({ pricingLimits: limits }));
      const content = tokenBook();
      content.groups[0].rules.push({ ...structuredClone(content.groups[0].rules[0]), id: 'alternate', priority: 1, condition: { input_tokens: { min: '1', max: '2' } } });
      for (const rate of content.groups[0].rules[1].rates) rate.component.id = `alternate-${rate.component.id}`;
      const created = await repo.createBook(admin, { name: 'Two rules', scope: 'workspace', content });
      const first = await repo.publishDraft(admin, created.draft.id, options(1, 0));
      const forked = await repo.forkDraft(admin, created.book.id, first.version_id);
      await repo.updateDraft(admin, forked.id, 1, tokenBook());
      await repo.publishDraft(admin, forked.id, options(2, 1));
      limits.max_published_rules = 1;
      await expect(repo.previewRollback(admin, created.book.id, first.version_id, options(0, 2))).rejects.toMatchObject({ code: 'pricing_capacity_exceeded' });
      await expect(repo.rollback(admin, created.book.id, first.version_id, options(0, 2))).rejects.toMatchObject({ code: 'pricing_capacity_exceeded' });
      expect((await repo.getVersion(admin, created.book.id, first.version_id)).content.groups[0].rules).toHaveLength(2);
      expect((await repo.listBindings(admin)).head.revision).toBe(2);
    });

    it('publishes scoped admission policies without requiring a price binding and freezes them for in-flight requests', async () => {
      await applyPricingSchema(dataSource);
      const changed = await repo.updateAdmissionPolicy(admin, { catalog_revision: 0, reason: 'Explicit synthetic policy', confirm: true, scope: 'workspace', operation: 'chat_completions', policy: { mode: 'reject_unpriced' } });
      expect(changed.head.revision).toBe(1);
      const captured = await repo.capture({ request_id: 'policy-request', workspace_id: admin.workspace_id, report_currency: 'USD' });
      expect(captured?.admissionPolicy('chat_completions').mode).toBe('reject_unpriced');
      expect(captured?.hasBindings()).toBe(false);
      expect((await repo.listAdmissionPolicies(other)).policies).toHaveLength(0);
      const created = await create(); await repo.publishDraft(admin, created.draft.id, options(1, 1));
      expect((await repo.listAdmissionPolicies(admin)).policies[0].policy.mode).toBe('reject_unpriced');
      await repo.updateAdmissionPolicy(admin, { catalog_revision: 2, reason: 'Synthetic compatibility policy', confirm: true, scope: 'workspace', operation: 'chat_completions', policy: { mode: 'compatibility' } });
      const restored = await new PricingRepository(dataSource).restoreRequest('policy-request', admin.workspace_id);
      expect(restored.admissionPolicy('chat_completions').mode).toBe('reject_unpriced');
      expect((await repo.capture({ request_id: 'new-policy-request', workspace_id: admin.workspace_id, report_currency: 'USD' }))!.admissionPolicy('chat_completions').mode).toBe('compatibility');
    });

    it('atomically audits policy CAS updates and rolls back policy/head publication if audit persistence fails', async () => {
      await applyPricingSchema(dataSource);
      const change = { catalog_revision: 0, reason: 'Synthetic policy', confirm: true as const, scope: 'workspace' as const, policy: { mode: 'reject_unpriced' as const } };
      const results = await Promise.allSettled([repo.updateAdmissionPolicy(admin, change), new PricingRepository(dataSource).updateAdmissionPolicy(admin, change)]);
      expect(results.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1);
      const before = await repo.listAdmissionPolicies(admin);
      const internals = repo as unknown as { audit: (...args: unknown[]) => Promise<void> };
      const fail = jest.spyOn(internals, 'audit').mockRejectedValueOnce(new Error('injected audit failure'));
      try { await expect(repo.updateAdmissionPolicy(admin, { ...change, catalog_revision: 1, policy: { mode: 'compatibility' } })).rejects.toThrow('injected audit failure'); }
      finally { fail.mockRestore(); }
      expect(await repo.listAdmissionPolicies(admin)).toEqual(before);
      expect(await dataSource.query("SELECT * FROM pricing_audit_events WHERE action = 'admission_policy.updated'")).toHaveLength(1);
      expect(await dataSource.query('SELECT * FROM pricing_catalog_revisions')).toHaveLength(1);
    });

    it('requires scoped administrator confirmation and validates every declared quantity-limit field', async () => {
      await applyPricingSchema(dataSource);
      const change = { catalog_revision: 0, reason: 'Synthetic policy', confirm: true as const, scope: 'workspace' as const, policy: { mode: 'reject_unpriced' as const } };
      await expect(repo.updateAdmissionPolicy({ ...admin, role: 'viewer' }, change)).rejects.toMatchObject({ status: 403 });
      await expect(repo.updateAdmissionPolicy(other, { ...change, scope: 'global' })).rejects.toMatchObject({ status: 403 });
      await expect(repo.updateAdmissionPolicy(admin, { ...change, confirm: false as true })).rejects.toMatchObject({ status: 400 });
      await expect(repo.updateAdmissionPolicy(admin, { ...change, policy: { mode: 'reserve_upper_bound', quantity_limits: { total_input_tokens: '-1' }, limit_reference: 'test' } })).rejects.toMatchObject({ status: 400 });
      await expect(repo.updateAdmissionPolicy(admin, { ...change, operation: 'unknown-provider-endpoint' })).rejects.toMatchObject({ status: 400 });
      expect((await repo.listAdmissionPolicies(admin)).head.revision).toBe(0);
      expect(await dataSource.query('SELECT * FROM pricing_catalog_revisions')).toHaveLength(0);
    });

    it('validates policy and FX previews without writes, checks CAS, and rejects invalid/scoped changes', async () => {
      await applyPricingSchema(dataSource);
      const policy = { catalog_revision: 0, reason: 'Preview synthetic policy', confirm: true as const, scope: 'workspace' as const, operation: 'chat_completions', policy: { mode: 'reserve_upper_bound' as const, quantity_limits: { total_input_tokens: '272001', output_tokens: '2000' }, limit_reference: 'Synthetic contract only' } };
      const preview = await repo.previewAdmissionPolicy(admin, policy);
      expect(preview).toMatchObject({ dry_run: true, head: { revision: 0 }, before: null, after: policy.policy });
      const rate = { fx: { version_id: 'synthetic-fx', source: 'Synthetic fixture', effective_at: '2026-01-01T00:00:00Z', from_currency: 'CNY', to_currency: 'USD', numerator: '1', denominator: '7' } };
      const fx = { catalog_revision: 0, reason: 'Preview synthetic FX', confirm: true as const, scope: 'workspace' as const, versions: [rate] };
      expect(await repo.previewFx(admin, fx)).toMatchObject({ dry_run: true, head: { revision: 0 }, before: [], after: [{ workspace_id: admin.workspace_id, fx: { numerator: '1', denominator: '7' } }] });
      expect(await dataSource.query('SELECT * FROM pricing_catalog_revisions')).toHaveLength(0);
      expect(await dataSource.query('SELECT * FROM pricing_audit_events')).toHaveLength(0);
      expect(await dataSource.query('SELECT * FROM pricing_request_snapshots')).toHaveLength(0);
      await expect(repo.previewAdmissionPolicy(other, { ...policy, scope: 'global' })).rejects.toMatchObject({ status: 403 });
      await expect(repo.previewFx({ ...admin, role: 'viewer' }, fx)).rejects.toMatchObject({ status: 403 });
      await expect(repo.previewFx(admin, { ...fx, versions: [rate, { ...rate, fx: { ...rate.fx, version_id: 'overlap' } }] })).rejects.toBeDefined();
      await expect(repo.previewAdmissionPolicy(admin, { ...policy, policy: { ...policy.policy, quantity_limits: { total_input_tokens: '' } } })).rejects.toMatchObject({ status: 400 });
      await repo.updateAdmissionPolicy(admin, policy);
      await expect(repo.previewFx(admin, fx)).rejects.toMatchObject({ status: 409 });
      await expect(repo.previewAdmissionPolicy(admin, policy)).rejects.toMatchObject({ status: 409 });
      expect(await repo.previewAdmissionPolicy(admin, { ...policy, catalog_revision: 1, policy: null })).toMatchObject({ before: policy.policy, after: null });
      await repo.updateFx(admin, { ...fx, catalog_revision: 1 });
      expect((await repo.listAdmissionPolicies(admin)).policies[0].policy).toEqual(policy.policy);
      expect((await repo.listBindings(other)).fx_versions).toHaveLength(0);
      expect(await dataSource.query('SELECT * FROM pricing_catalog_revisions')).toHaveLength(2);
    });

    it('never migrates at startup or during normal configuration operations', async () => {
      expect((await repo.status()).state).toBe('pending');
      await expect(create()).rejects.toMatchObject({
        code: 'pricing_schema_required',
        status: 503,
      });
      expect((await repo.status()).state).toBe('pending');
      await applyPricingSchema(dataSource);
      expect((await create()).draft.revision).toBe(1);
    });

    it('preserves full drafts, rejects stale revisions, and does not activate on save or preview', async () => {
      await applyPricingSchema(dataSource);
      const first = await create();
      const edited = tokenBook();
      edited.groups[0].rules[0].rates[0].component.amount = '2';
      const draft = await repo.updateDraft(admin, first.draft.id, 1, edited);
      expect(draft.revision).toBe(2);
      expect(draft.content.groups[0].rules[0].rates).toHaveLength(6);
      await expect(repo.updateDraft(admin, draft.id, 1, tokenBook())).rejects.toMatchObject({
        status: 409,
      });
      const preview = await repo.previewPublish(admin, draft.id, options(2, 0));
      expect(preview.dry_run).toBe(true);
      expect((await repo.listBindings(admin)).head.revision).toBe(0);
      expect(
        await repo.capture({
          request_id: 'before-publication',
          workspace_id: admin.workspace_id,
          report_currency: 'USD',
        }),
      ).toBeNull();
    });

    it('publishes atomically and reloads persisted snapshots without current-price recomputation', async () => {
      await applyPricingSchema(dataSource);
      const first = await create();
      const published = await repo.publishDraft(admin, first.draft.id, options(1, 0));
      const request = await repo.capture({
        request_id: 'r1',
        workspace_id: admin.workspace_id,
        report_currency: 'USD',
      });
      expect(request!.quote(target, usage()).cost.amount).toBe('0.001000000');
      const detail = await repo.getBook(admin, first.book.id);
      expect(detail.versions[0].version_id).toBe(published.version_id);
      expect(detail.versions[0]).not.toHaveProperty('content_json');
      const draft = await repo.forkDraft(admin, first.book.id, published.version_id);
      const content = draft.content;
      content.groups[0].rules[0].rates[0].component.amount = '10';
      await repo.updateDraft(admin, draft.id, 1, content);
      await repo.publishDraft(admin, draft.id, options(2, 1));
      expect(
        (await repo.capture({
          request_id: 'r2',
          workspace_id: admin.workspace_id,
          report_currency: 'USD',
        }))!.quote(target, usage()).cost.amount,
      ).toBe('0.010000000');
      const connectionOptions = dataSource.options;
      await dataSource.destroy();
      dataSource = await new DataSource(connectionOptions).initialize();
      repo = new PricingRepository(dataSource);
      expect(
        (await repo.restoreRequest('r1', admin.workspace_id)).quote(target, usage()).cost.amount,
      ).toBe('0.001000000');
      expect(
        (await repo.restoreRequest('r2', admin.workspace_id)).quote(target, usage()).cost.amount,
      ).toBe('0.010000000');
      const manifests = await dataSource.query(
        'SELECT manifest_json FROM pricing_catalog_revisions',
      );
      expect(JSON.parse(manifests[0].manifest_json).books[0]).not.toHaveProperty('content');
      expect(await dataSource.query('SELECT * FROM pricing_book_versions')).toHaveLength(2);
    });

    it('fences concurrent publishers and draft writers with revisions', async () => {
      await applyPricingSchema(dataSource);
      const first = await create();
      const secondRepo = new PricingRepository(dataSource);
      const edits = await Promise.allSettled([
        repo.updateDraft(admin, first.draft.id, 1, tokenBook()),
        secondRepo.updateDraft(admin, first.draft.id, 1, tokenBook()),
      ]);
      expect(edits.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1);
      const publications = await Promise.allSettled([
        repo.publishDraft(admin, first.draft.id, options(2, 0)),
        secondRepo.publishDraft(admin, first.draft.id, options(2, 0)),
      ]);
      expect(publications.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1);
      expect((await repo.listBindings(admin)).head.revision).toBe(1);
      expect(await dataSource.query('SELECT * FROM pricing_book_versions')).toHaveLength(1);
    });

    it('linearizes request admission before a competing price publication', async () => {
      await applyPricingSchema(dataSource);
      const first = await create();
      const published = await repo.publishDraft(admin, first.draft.id, options(1, 0));
      const draft = await repo.forkDraft(admin, first.book.id, published.version_id);
      const content = draft.content;
      content.groups[0].rules[0].rates[0].component.amount = '9';
      await repo.updateDraft(admin, draft.id, 1, content);
      const internals = repo as unknown as {
        loadCatalog: (manager: EntityManager, id: string) => Promise<CompiledPricingCatalog>;
      };
      const original = internals.loadCatalog.bind(repo);
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const reached = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const spy = jest
        .spyOn(internals, 'loadCatalog')
        .mockImplementationOnce(async (manager, id) => {
          entered();
          await gate;
          return original(manager, id);
        });
      const request = repo.capture({
        request_id: 'admission-race',
        workspace_id: admin.workspace_id,
        report_currency: 'USD',
      });
      let publication: Promise<unknown> | undefined;
      let publicationFinished = false;
      try {
        await reached;
        publication = new PricingRepository(dataSource)
          .publishDraft(admin, draft.id, options(2, 1))
          .then((result) => {
            publicationFinished = true;
            return result;
          });
        await new Promise<void>((resolve) => setTimeout(resolve, 30));
        expect(publicationFinished).toBe(false);
        release();
        const accepted = await request;
        await publication;
        expect(accepted!.quote(target, usage()).cost.amount).toBe('0.001000000');
        expect(
          (await repo.capture({
            request_id: 'after-admission-race',
            workspace_id: admin.workspace_id,
            report_currency: 'USD',
          }))!.quote(target, usage()).cost.amount,
        ).toBe('0.009000000');
      } finally {
        release();
        await Promise.allSettled([request, ...(publication ? [publication] : [])]);
        spy.mockRestore();
      }
    });

    it('rolls back version, activation, draft deletion and head revision if audit fails', async () => {
      await applyPricingSchema(dataSource);
      const first = await create();
      const audit = jest
        .spyOn(repo as unknown as { audit: (...args: unknown[]) => Promise<void> }, 'audit')
        .mockRejectedValueOnce(new Error('audit unavailable'));
      try {
        await expect(repo.publishDraft(admin, first.draft.id, options(1, 0))).rejects.toThrow(
          'audit unavailable',
        );
      } finally {
        audit.mockRestore();
      }
      expect((await repo.listBindings(admin)).head.revision).toBe(0);
      expect(await dataSource.query('SELECT * FROM pricing_book_versions')).toHaveLength(0);
      expect((await repo.getDraft(admin, first.draft.id)).revision).toBe(1);
      expect((await repo.publishDraft(admin, first.draft.id, options(1, 0))).head.revision).toBe(1);
    });

    it('enforces workspace ownership, viewer restrictions and separate global administration', async () => {
      await applyPricingSchema(dataSource);
      const privateBook = await create();
      const globalBook = await create(admin, 'global');
      await expect(repo.getBook(other, privateBook.book.id)).rejects.toMatchObject({ status: 404 });
      await expect(repo.getDraft(other, privateBook.draft.id)).rejects.toMatchObject({
        status: 404,
      });
      await expect(
        repo.createBook(other, { name: 'forbidden', scope: 'global', content: tokenBook() }),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        repo.updateDraft(other, globalBook.draft.id, 1, tokenBook()),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        repo.updateDraft({ ...admin, role: 'viewer' }, privateBook.draft.id, 1, tokenBook()),
      ).rejects.toMatchObject({ status: 403 });
      expect((await repo.listBooks(other)).books.map((entry) => entry.id)).toEqual([
        globalBook.book.id,
      ]);
    });

    it('cancels future activation without disturbing current or historical prices', async () => {
      await applyPricingSchema(dataSource);
      const first = await create();
      const published = await repo.publishDraft(admin, first.draft.id, options(1, 0));
      const draft = await repo.forkDraft(admin, first.book.id, published.version_id);
      const future = new Date(Date.now() + 3600000).toISOString();
      const scheduled = await repo.publishDraft(admin, draft.id, {
        ...options(1, 1),
        effective_from: future,
      });
      expect((await repo.listBindings(admin)).bindings).toHaveLength(2);
      const cancelled = await repo.cancelScheduled(
        admin,
        scheduled.bindings[0].id,
        2,
        'cancel test schedule',
      );
      expect(cancelled.head.revision).toBe(3);
      expect((await repo.listBindings(admin)).bindings).toHaveLength(1);
      expect(
        (await repo.capture({
          request_id: 'after-cancel',
          workspace_id: admin.workspace_id,
          report_currency: 'USD',
        }))!.quote(target, usage()).cost.version_id,
      ).toBe(published.version_id);
    });

    it('refuses activation with an already-expired time calendar', async () => {
      await applyPricingSchema(dataSource);
      const content = tokenBook();
      content.calendar = {
        schema_version: 1,
        version_id: 'expired',
        time_zone: 'UTC',
        tzdb_version: process.versions.tz ?? 'unknown',
        valid_from: '2020-01-01',
        valid_to: '2021-01-01',
        default_tag: 'offpeak',
        weekly: [],
        holidays: [],
        date_overrides: [],
      };
      content.groups.push({
        id: 'time',
        order: 1,
        required: true,
        rules: [
          {
            id: 'offpeak',
            priority: 0,
            mode: 'whole_request',
            condition: { time_tags: ['offpeak'] },
            rates: [],
          },
        ],
      });
      const created = await repo.createBook(admin, {
        name: 'expired test',
        scope: 'workspace',
        content,
      });
      await expect(repo.publishDraft(admin, created.draft.id, options(1, 0))).rejects.toMatchObject(
        { code: 'pricing_calendar_unavailable', status: 400 },
      );
      expect((await repo.listBindings(admin)).head.revision).toBe(0);
    });

    it('rejects silently replacing an existing future schedule', async () => {
      await applyPricingSchema(dataSource);
      const first = await create();
      const published = await repo.publishDraft(admin, first.draft.id, {
        ...options(1, 0),
        effective_from: new Date(Date.now() + 7200000).toISOString(),
      });
      const draft = await repo.forkDraft(admin, first.book.id, published.version_id);
      await expect(
        repo.publishDraft(admin, draft.id, {
          ...options(1, 1),
          effective_from: new Date(Date.now() + 3600000).toISOString(),
        }),
      ).rejects.toMatchObject({ status: 409, code: 'pricing_activation_conflict' });
      expect((await repo.listBindings(admin)).head.revision).toBe(1);
    });

    it('rolls back by publishing a new immutable version and retains audit records', async () => {
      await applyPricingSchema(dataSource);
      const first = await create();
      const original = await repo.publishDraft(admin, first.draft.id, options(1, 0));
      const rolledBack = await repo.rollback(
        admin,
        first.book.id,
        original.version_id,
        options(0, 1),
      );
      expect(rolledBack.version_id).not.toBe(original.version_id);
      expect(
        (await repo.listAudit(admin, first.book.id)).some(
          (event) => event.action === 'book.rolled_back',
        ),
      ).toBe(true);
      expect((await repo.getVersion(admin, first.book.id, original.version_id)).content_hash).toBe(
        original.content_hash,
      );
    });

    it('persists capture idempotently and denies cross-workspace restore', async () => {
      await applyPricingSchema(dataSource);
      const first = await create();
      await repo.publishDraft(admin, first.draft.id, options(1, 0));
      const input = {
        request_id: 'one-request',
        workspace_id: admin.workspace_id,
        report_currency: 'USD',
      };
      const [a, b] = await Promise.all([
        repo.capture(input),
        new PricingRepository(dataSource).capture(input),
      ]);
      expect(a!.descriptor()).toEqual(b!.descriptor());
      expect(await dataSource.query('SELECT * FROM pricing_request_snapshots')).toHaveLength(1);
      await expect(repo.restoreRequest('one-request', other.workspace_id)).rejects.toMatchObject({
        status: 404,
      });
      await expect(
        repo.capture({ ...input, workspace_id: other.workspace_id }),
      ).rejects.toMatchObject({ status: 403 });
    });

    it('stores FX versions under the authorized scope without affecting existing snapshots', async () => {
      await applyPricingSchema(dataSource);
      const content = tokenBook();
      content.currency = 'CNY';
      const first = await repo.createBook(admin, { name: 'CNY test', scope: 'workspace', content });
      await repo.publishDraft(admin, first.draft.id, options(1, 0));
      const fx = {
        version_id: 'ignored',
        source: 'synthetic',
        effective_at: new Date().toISOString(),
        from_currency: 'CNY',
        to_currency: 'USD',
        numerator: '1',
        denominator: '2',
      };
      await repo.updateFx(admin, {
        catalog_revision: 1,
        reason: 'set FX',
        confirm: true,
        scope: 'workspace',
        versions: [{ fx }],
      });
      const original = await repo.capture({
        request_id: 'fx-original',
        workspace_id: admin.workspace_id,
        report_currency: 'USD',
      });
      await repo.updateFx(admin, {
        catalog_revision: 2,
        reason: 'new FX',
        confirm: true,
        scope: 'workspace',
        versions: [{ fx: { ...fx, denominator: '4' } }],
      });
      expect(original!.quote(target, usage()).cost.report_amount).toBe('0.000500000');
      expect(
        (await repo.capture({
          request_id: 'fx-new',
          workspace_id: admin.workspace_id,
          report_currency: 'USD',
        }))!.quote(target, usage()).cost.report_amount,
      ).toBe('0.000250000');
    });
  });
}

repositoryContract('SQLite pricing repository', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pricing-repository-'));
  const dataSource = await new DataSource({
    type: 'better-sqlite3',
    database: join(dir, 'pricing.db'),
    synchronize: false,
    entities: [],
  }).initialize();
  return { dataSource, cleanup: async () => rmSync(dir, { recursive: true, force: true }) };
});

const pgUrl = process.env.SIFTGATE_PRICING_TEST_POSTGRES_URL;
if (pgUrl) {
  const url = new URL(pgUrl);
  if (url.hostname !== '127.0.0.1' || !/^\/pricing_goal_[a-z0-9_]+$/.test(url.pathname))
    throw new Error('Use an isolated loopback pricing_goal_* database');
}
repositoryContract(
  'PostgreSQL pricing repository',
  async () => {
    if (!pgUrl) throw new Error('No isolated PostgreSQL URL');
    const schema = `pricing_repo_${process.pid}_${Math.random().toString(16).slice(2)}`;
    const adminConnection = await new DataSource({
      type: 'postgres',
      url: pgUrl,
      synchronize: false,
    }).initialize();
    await adminConnection.query(`CREATE SCHEMA "${schema}"`);
    const dataSource = await new DataSource({
      type: 'postgres',
      url: pgUrl,
      schema,
      extra: { options: `-c search_path=${schema}` },
      synchronize: false,
    }).initialize();
    return {
      dataSource,
      cleanup: async () => {
        await adminConnection.query(`DROP SCHEMA "${schema}" CASCADE`);
        await adminConnection.destroy();
      },
    };
  },
  pgUrl ? describe : describe.skip,
);

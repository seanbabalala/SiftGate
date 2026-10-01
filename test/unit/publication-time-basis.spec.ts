import { DataSource, InsertQueryBuilder } from 'typeorm';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PricingRepository } from '../../src/pricing/pricing-repository';
import { applyPricingSchema, PRICING_TABLE_NAMES } from '../../src/pricing/pricing-schema';
import { pricingContentHash } from '../../src/pricing/pricing-json';
import type { PricingPublishOptions } from '../../src/pricing/pricing-repository.types';
import type { PriceBookContent } from '../../src/pricing/pricing.types';
import { tokenBook, tokens } from './pricing-fixtures';

const actor = { id: 'synthetic-time-reviewer', workspace_id: 'default-workspace', role: 'admin' as const, global_admin: true };
const options = (revision = 0): PricingPublishOptions => ({ draft_revision: 1, catalog_revision: revision, reason: 'Synthetic time contract review', confirm: true, targets: [{ level: 'model', model: 'synthetic-model', operation: 'chat_completions' }] });
const timed = (basis: 'completed_at' | 'provider_accepted_at' | 'attempt_dispatched_at' = 'completed_at'): PriceBookContent => {
  const content = tokenBook(); content.time_basis = basis;
  content.calendar = { schema_version: 1, version_id: 'synthetic-calendar', time_zone: 'UTC', tzdb_version: process.versions.tz!, valid_from: '2020-01-01', valid_to: '2030-01-01', default_tag: 'standard', weekly: [], holidays: [], date_overrides: [] };
  content.groups[0].rules[0].condition.time_tags = ['standard']; return content;
};
const confirmation = (content: PriceBookContent) => ({ basis: content.time_basis, content_hash: pricingContentHash(content), reference: 'SYNTHETIC-CONTRACT-01', confirmed: true });
const reviewed = (content: PriceBookContent, revision = 0) => ({ ...options(revision), time_basis_confirmation: confirmation(content) });
const pgUrl = process.env.SIFTGATE_PRICING_TEST_POSTGRES_URL;
if (pgUrl) { const u = new URL(pgUrl); if (u.hostname !== '127.0.0.1' || u.port === '2099' || !/^\/pricing_goal_[a-z0-9_]+$/.test(u.pathname)) throw Error('Isolated loopback PostgreSQL required'); }

for (const dialect of ['better-sqlite3', 'postgres'] as const) {
  (dialect === 'postgres' && !pgUrl ? describe.skip : describe)(`publication timing contract (${dialect})`, () => {
    let db: DataSource, admin: DataSource | undefined, directory: string | undefined, schema: string, repo: PricingRepository;
    beforeEach(async () => {
      if (dialect === 'postgres') {
        schema = 'time_contract_' + randomUUID().replaceAll('-', ''); admin = await new DataSource({ type: 'postgres', url: pgUrl }).initialize(); await admin.query(`CREATE SCHEMA "${schema}"`);
        db = await new DataSource({ type: 'postgres', url: pgUrl, schema, extra: { options: `-c search_path=${schema}` }, synchronize: false }).initialize();
      } else { directory = mkdtempSync(join(tmpdir(), 'time-contract-')); db = await new DataSource({ type: dialect, database: join(directory, 'test.sqlite'), synchronize: false }).initialize(); }
      await applyPricingSchema(db); repo = new PricingRepository(db);
    });
    afterEach(async () => { jest.restoreAllMocks(); if (db?.isInitialized) await db.destroy(); if (admin?.isInitialized) { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.destroy(); } if (directory) rmSync(directory, { recursive: true, force: true }); });
    const create = (content: PriceBookContent) => repo.createBook(actor, { name: 'Synthetic timing', scope: 'workspace', content });
    const snapshot = async () => Promise.all(PRICING_TABLE_NAMES.map(table => db.query(`SELECT * FROM ${table}`)));

    it.each(['completed_at', 'provider_accepted_at'] as const)('timing review blocks direct unconfirmed %s publication while keeping draft preview read-only', async basis => {
      const content = timed(basis), created = await create(content), before = await snapshot();
      const preview = await repo.previewPublish(actor, created.draft.id, options());
      expect(preview).toMatchObject({ time_basis_review: { basis, content_hash: pricingContentHash(content), requires_confirmation: true, uses_time_rules: true, supplier_verified: false } });
      expect(await snapshot()).toEqual(before);
      await expect(repo.publishDraft(actor, created.draft.id, options())).rejects.toMatchObject({ status: 400, code: 'pricing_time_basis_review_required' });
      expect(await snapshot()).toEqual(before);
    });

    it('timing review binds explicit administrator evidence to exact immutable content and preserves historical quote', async () => {
      const content = timed(), created = await create(content);
      const published = await repo.publishDraft(actor, created.draft.id, reviewed(content) as PricingPublishOptions);
      expect(published).toMatchObject({ time_basis_review: { basis: 'completed_at', requires_confirmation: true }, time_basis_confirmation: confirmation(content) });
      const audit = (await db.query("SELECT actor_id, metadata_json FROM pricing_audit_events WHERE action = 'draft.published'"))[0];
      expect(audit.actor_id).toBe(actor.id); expect(JSON.parse(audit.metadata_json)).toMatchObject({ time_basis_confirmation: confirmation(content), time_basis_review: { supplier_verified: false } });
      const frozen = (await repo.capture({ request_id: 'historical', workspace_id: actor.workspace_id, report_currency: 'USD' }))!;
      const usage = tokens({ input_tokens: 1000, output_tokens: 0 }), now = new Date().toISOString(), target = { model: 'synthetic-model', operation: 'chat_completions' };
      const cost = frozen.quote(target, usage, { completed_at: now }).cost;
      expect(cost.amount).toBe('0.001000000'); expect(frozen.quote(target, usage, {}).cost.amount).toBeNull();
      const fork = await repo.forkDraft(actor, created.book.id, published.version_id), changed = structuredClone(content); changed.groups[0].rules[0].rates[0].component.amount = '7';
      await repo.updateDraft(actor, fork.id, fork.revision, changed);
      await expect(repo.publishDraft(actor, fork.id, { ...reviewed(content, 1), draft_revision: 2 } as PricingPublishOptions)).rejects.toMatchObject({ status: 409 });
      await repo.publishDraft(actor, fork.id, { ...reviewed(changed, 1), draft_revision: 2 } as PricingPublishOptions);
      expect((await new PricingRepository(db).restoreRequest('historical', actor.workspace_id)).quote(target, usage, { completed_at: now }).cost).toEqual(cost);
    });

    it('timing review is required again for rollback and audit failure rolls back every publication write', async () => {
      const content = timed(), created = await create(content), first = await repo.publishDraft(actor, created.draft.id, reviewed(content) as PricingPublishOptions);
      const before = await snapshot();
      expect(await repo.previewRollback(actor, created.book.id, first.version_id, options(1))).toMatchObject({ time_basis_review: { requires_confirmation: true } });
      await expect(repo.rollback(actor, created.book.id, first.version_id, options(1))).rejects.toMatchObject({ code: 'pricing_time_basis_review_required' });
      expect(await snapshot()).toEqual(before);
      const insert = InsertQueryBuilder.prototype.execute;
      jest.spyOn(InsertQueryBuilder.prototype, 'execute').mockImplementation(function (this: InsertQueryBuilder<Record<string, unknown>>) { if (this.expressionMap.mainAlias?.tablePath === 'pricing_audit_events') throw Error('Synthetic timing audit failure'); return insert.call(this); });
      await expect(repo.rollback(actor, created.book.id, first.version_id, reviewed(content, 1) as PricingPublishOptions)).rejects.toThrow('Synthetic timing audit failure');
      expect(await snapshot()).toEqual(before); jest.restoreAllMocks();
      const rollback = await repo.rollback(actor, created.book.id, first.version_id, reviewed(content, 1) as PricingPublishOptions); expect(rollback.version_id).not.toBe(first.version_id);
    });

    it('timing review rejects malformed, foreign-content and wrong-basis confirmations without writes', async () => {
      const content = timed(), created = await create(content), before = await snapshot(), valid = confirmation(content);
      for (const value of [null, true, {}, { ...valid, confirmed: false }, { ...valid, actor: 'spoofed' }, { ...valid, reference: 'https://secret.internal/contract?token=x' }, { ...valid, reference: 'contract text with private rates' }, { ...valid, reference: '../secret' }, { ...valid, reference: '' }]) {
        await expect(repo.publishDraft(actor, created.draft.id, { ...options(), time_basis_confirmation: value } as unknown as PricingPublishOptions)).rejects.toMatchObject({ status: 400 });
      }
      for (const value of [{ ...valid, content_hash: '0'.repeat(64) }, { ...valid, basis: 'provider_accepted_at' }]) await expect(repo.publishDraft(actor, created.draft.id, { ...options(), time_basis_confirmation: value } as unknown as PricingPublishOptions)).rejects.toMatchObject({ status: 409 });
      expect(await snapshot()).toEqual(before);
    });

    it('timing review preserves default dispatch publication and cannot be bypassed by an unused calendar or inherited book', async () => {
      const initial = await create(tokenBook()); expect(await repo.publishDraft(actor, initial.draft.id, options())).toMatchObject({ time_basis_review: { basis: 'attempt_dispatched_at', requires_confirmation: false }, time_basis_confirmation: null });
      const content = timed(); content.groups[0].rules[0].condition = {}; const unused = await create(content);
      expect(await repo.previewPublish(actor, unused.draft.id, options(1))).toMatchObject({ time_basis_review: { uses_time_rules: false, requires_confirmation: true } });
      await expect(repo.publishDraft(actor, unused.draft.id, options(1))).rejects.toMatchObject({ code: 'pricing_time_basis_review_required' });
      const published = await repo.publishDraft(actor, unused.draft.id, reviewed(content, 1) as PricingPublishOptions);
      const inherited = await repo.createInheritedBook(actor, { name: 'Synthetic inherited timing', scope: 'workspace', definition: { schema_version: 1, parent: { book_id: unused.book.id, version_id: published.version_id, content_hash: published.content_hash }, inherit: 'all', source: { kind: 'manual' }, rate_overrides: [], removed_component_ids: [], replaced_groups: [], added_groups: [], removed_group_ids: [], settings: {}, calendar: { mode: 'inherit' } } });
      await expect(repo.publishDraft(actor, inherited.draft.id, options(2))).rejects.toMatchObject({ code: 'pricing_time_basis_review_required' });
    });
  });
}

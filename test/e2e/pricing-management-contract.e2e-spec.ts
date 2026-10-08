import { DataSource, InsertQueryBuilder } from 'typeorm';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import * as bcrypt from 'bcryptjs';
import * as request from 'supertest';
import { createE2EHarness, type E2EHarness, FIXTURE_PATH } from './setup';
import { AuthService } from '../../src/auth/auth.service';
import { DASHBOARD_SESSION_COOKIE } from '../../src/auth/dashboard-session-cookie';
import { WorkspaceMembershipService } from '../../src/auth/workspace-membership.service';
import { ConfigService } from '../../src/config/config.service';
import { resolvePricingLimits } from '../../src/config/pricing-limits';
import { DEFAULT_ORGANIZATION_ID, DEFAULT_WORKSPACE_ID } from '../../src/workspaces/workspace.constants';
import { applyPricingSchema, PRICING_TABLE_NAMES } from '../../src/pricing/pricing-schema';
import { PricingRepository } from '../../src/pricing/pricing-repository';
import { CostLedgerService } from '../../src/pricing/cost-ledger.service';
import { PricingRecoveryService } from '../../src/pricing/pricing-recovery.service';
import { tokenBook, tokens } from '../unit/pricing-fixtures';
import { conditionBook } from './pricing-conditions-fixtures';

const base = '/api/dashboard/pricing', workspace = DEFAULT_WORKSPACE_ID, other = 'management-contract-b';
const password = 'synthetic-management-contract-password';
const requiredOperations = ['books', 'book', 'create', 'fork', 'update', 'validate', 'quote', 'replay', 'publish', 'rollback', 'import', 'export', 'cost'] as const;
type OperationId = typeof requiredOperations[number];
interface Operation { id: OperationId; method: 'get' | 'post' | 'put'; path: string; body?: object; write?: boolean }

describe('original pricing management contract with real session and scoped HTTP', () => {
  let h: E2EHarness, source: DataSource, prices: PricingRepository, ledger: CostLedgerService, directory: string, file: string;
  let adminCookie: string, viewerCookie: string, otherCookie: string, adminToken: string;
  let bookId: string, draftId: string, versionId: string, otherBookId: string, logId: number;
  const actor = { id: 'dashboard', workspace_id: workspace, role: 'admin' as const, global_admin: true };
  const evidence = () => Object.values(tokens({ input_tokens: 1000, output_tokens: 100 }).quantities).map(q => ({ dimension: q!.dimension, value: q!.value }));
  const publication = (revision: number) => ({ draft_revision: 1, catalog_revision: revision, reason: 'Synthetic contract publication', confirm: true as const, targets: [{ level: 'model' as const, model: 'gpt-4o' }] });
  const headRevision = async () => (await call({ id: 'books', method: 'get', path: `${base}/bindings` })).body.head.revision as number;
  const call = (op: Operation, cookie = adminCookie, scope = workspace) => {
    const req = request(h.app.getHttpServer())[op.method](op.path).set('x-siftgate-workspace-id', scope);
    if (cookie) req.set('Cookie', cookie);
    if (op.body !== undefined) req.send(op.body);
    return req;
  };
  const operations = (): Operation[] => [
    { id: 'books', method: 'get', path: `${base}/books` },
    { id: 'book', method: 'get', path: `${base}/books/${bookId}` },
    { id: 'create', method: 'post', path: `${base}/books`, body: { name: 'Contract draft', content: tokenBook() }, write: true },
    { id: 'fork', method: 'post', path: `${base}/books/${bookId}/drafts`, body: { version_id: versionId }, write: true },
    { id: 'update', method: 'put', path: `${base}/drafts/${draftId}`, body: { revision: 1, content: tokenBook() }, write: true },
    { id: 'validate', method: 'post', path: `${base}/drafts/${draftId}/validate`, body: {} },
    { id: 'quote', method: 'post', path: `${base}/quote`, body: { book_id: bookId, version_id: versionId, evidence: evidence() } },
    { id: 'replay', method: 'post', path: `${base}/replay`, body: { request_ids: ['management-request'], book_id: bookId, version_id: versionId } },
    { id: 'publish', method: 'post', path: `${base}/drafts/${draftId}/publish`, body: publication(2), write: true },
    { id: 'rollback', method: 'post', path: `${base}/books/${bookId}/rollback`, body: { catalog_revision: 2, reason: 'Synthetic rollback', confirm: true, targets: [{ level: 'model', model: 'gpt-4o' }], version_id: versionId }, write: true },
    { id: 'import', method: 'post', path: `${base}/import/validate`, body: { format: 'siftgate-price-book-v1', content: tokenBook() } },
    { id: 'export', method: 'get', path: `${base}/books/${bookId}/export?version_id=${versionId}` },
    { id: 'cost', method: 'get', path: `/api/dashboard/logs/${logId}/cost-breakdown` },
  ];
  async function state() {
    const rows: Record<string, string[]> = {};
    for (const table of [...PRICING_TABLE_NAMES, 'budget_rules', 'call_logs']) rows[table] = (await source.query(`SELECT * FROM "${table}"`) as unknown[]).map(row => JSON.stringify(row)).sort();
    return { rows, config: createHash('sha256').update(readFileSync(file)).digest('hex'), providerCalls: h.fetchMock.calls.length };
  }
  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'pricing-management-contract-')); file = join(directory, 'config.yaml');
    const config = yaml.load(readFileSync(FIXTURE_PATH, 'utf8')) as Record<string, unknown>;
    config.dashboard = { auth_required: true, allow_legacy_token_auth: false, password: bcrypt.hashSync(password, 4), session_secret: 'synthetic-management-contract-session-secret-only' };
    writeFileSync(file, yaml.dump(config)); h = await createE2EHarness(file);
    await h.app.get(PricingRecoveryService).onModuleDestroy();
    source = h.app.get(DataSource); await applyPricingSchema(source); prices = h.app.get(PricingRepository); ledger = h.app.get(CostLedgerService);
    const login = await request(h.app.getHttpServer()).post('/api/auth/login').send({ password });
    expect(login.status).toBe(201); adminToken = login.body.token;
    const cookies = login.headers['set-cookie'] as unknown as string[];
    expect(cookies[0]).toContain('HttpOnly'); expect(cookies[0]).toContain('SameSite=Lax'); expect(cookies[0]).toContain('Path=/');
    adminCookie = cookies[0].split(';')[0];
    await h.workspaceRepo.save(h.workspaceRepo.create({ id: other, organization_id: DEFAULT_ORGANIZATION_ID, name: 'Contract B', slug: other, status: 'active', is_default: false }));
    const memberships = h.app.get(WorkspaceMembershipService);
    await memberships.ensureMembership({ userId: 'contract-viewer', organizationId: DEFAULT_ORGANIZATION_ID, workspaceId: workspace, role: 'viewer' });
    await memberships.ensureMembership({ userId: 'contract-b-admin', organizationId: DEFAULT_ORGANIZATION_ID, workspaceId: other, role: 'admin' });
    // These are real signed sessions; role/workspace claims are intentionally false.
    // The guard must derive authority from stored membership, not JWT/body claims.
    viewerCookie = `${DASHBOARD_SESSION_COOKIE}=${h.app.get(AuthService).generateToken('contract-viewer', { role: 'admin', workspace_id: other })}`;
    otherCookie = `${DASHBOARD_SESSION_COOKIE}=${h.app.get(AuthService).generateToken('contract-b-admin', { role: 'admin', global_admin: true, workspace_id: workspace })}`;
    const first = await prices.createBook(actor, { name: 'Private contract A', scope: 'workspace', content: tokenBook() }); bookId = first.book.id;
    versionId = (await prices.publishDraft(actor, first.draft.id, publication(0))).version_id;
    draftId = (await prices.forkDraft(actor, bookId, versionId)).id;
    const b = await prices.createBook({ id: 'contract-b-admin', workspace_id: other, role: 'admin', global_admin: false }, { name: 'Private contract B', scope: 'workspace', content: tokenBook() }); otherBookId = b.book.id;
    const target = { node_id: 'mock-openai', model: 'gpt-4o' };
    const snapshot = (await prices.capture({ request_id: 'management-request', workspace_id: workspace, report_currency: 'USD' }))!;
    const cost = snapshot.quote(target, tokens({ input_tokens: 1000, output_tokens: 100 })).cost;
    await ledger.reserve({ id: 'management-request', requestId: 'management-request', identity: { workspaceId: workspace, apiKeyId: null, apiKeyName: null, namespaceId: null, teamId: null }, target, estimate: cost, tokens: '1100', costUsd: '0.5', budgetBasis: 'legacy_logical', leaseOwner: 'fixture', leaseUntil: new Date(Date.now() + 3600000).toISOString() });
    await ledger.beginAttempt({ id: 'management-attempt', requestId: 'management-request', workspace, reservationId: 'management-request', target, feeSource: 'provider', dispatchedAt: new Date().toISOString(), priceContext: { context: {}, legacyPrice: null } });
    await ledger.completeAttempt('management-attempt', workspace, cost);
    await ledger.settle('management-request', workspace, 'commit', '1100', cost.report_amount!, 'legacy_logical');
    const log = h.callLogRepo.create({ request_id: 'management-request', workspace_id: workspace, source_format: 'chat_completions', tier: 'standard', score: 0, node_id: target.node_id, model: target.model, input_tokens: 1000, output_tokens: 100, cost_usd: 0.0012 });
    logId = (await ledger.persistCallLogs([log], true))![0].id;
  }, 30000);
  afterAll(async () => { jest.restoreAllMocks(); await h?.close(); if (directory) rmSync(directory, { recursive: true, force: true }); });

  it.each(requiredOperations)('requires a valid Dashboard session for original API operation %s', async id => {
    const before = await state(), op = operations().find(op => op.id === id)!;
    expect((await call(op, '')).status).toBe(401);
    expect((await call(op, `${DASHBOARD_SESSION_COOKIE}=synthetic-invalid-token`)).status).toBe(401);
    expect(await state()).toEqual(before);
  });
  it('accepts the real session cookie while rejecting disabled legacy bearer and query tokens', async () => {
    expect((await request(h.app.getHttpServer()).get(`${base}/books`).set('Authorization', `Bearer ${adminToken}`)).status).toBe(401);
    expect((await request(h.app.getHttpServer()).get(`${base}/books`).query({ token: adminToken })).status).toBe(401);
    expect((await call(operations()[0])).status).toBe(200);
  });
  it('allows viewer reads and simulations but refuses every original mutation despite forged role claims', async () => {
    const before = await state();
    for (const op of operations()) {
      const response = await call(op, viewerCookie);
      expect({ id: op.id, status: response.status }).toEqual({ id: op.id, status: op.write ? 403 : op.method === 'get' ? 200 : 201 });
      for (const secret of ['mock-openai-key', password, 'synthetic-management-contract-session-secret-only', adminToken])
        expect(JSON.stringify(response.body)).not.toContain(secret);
      if (op.write) expect(response.body.error.code).toBe('workspace_role_required');
      if (op.id === 'replay') expect(response.body).toMatchObject({ complete: true, historical_records_modified: false, results: [{ request_id: 'management-request', simulations: [{ simulated: { amount: '0.001200000' } }] }] });
      if (op.id === 'cost') expect(response.body).toMatchObject({ amount: '0.001200000000000000', budget_committed_usd: '0.001200000000000000' });
    }
    expect(await state()).toEqual(before);
  });
  it('filters books and fences every resource operation by actual membership and stored workspace ownership', async () => {
    const before = await state();
    const list = await call(operations()[0], otherCookie, other);
    expect(list.body.books.map((b: { id: string }) => b.id)).toContain(otherBookId);
    expect(list.body.books.map((b: { id: string }) => b.id)).not.toContain(bookId);
    const scoped = operations().filter(op => !['books', 'create', 'import'].includes(op.id));
    for (const op of scoped) expect({ id: op.id, status: (await call(op, otherCookie, other)).status }).toEqual({ id: op.id, status: 404 });
    expect((await call(operations()[0], otherCookie, workspace)).status).toBe(403);
    const global = await call({ id: 'create', method: 'post', path: `${base}/books`, body: { name: 'Forbidden global', scope: 'global', content: tokenBook() } }, otherCookie, other);
    expect(global.status).toBe(403); expect(global.body.error.code).toBe('pricing_permission_denied');
    const foreignReplay = await call({ id: 'replay', method: 'post', path: `${base}/replay`, body: { request_ids: ['management-request'], content: tokenBook() } }, otherCookie, other);
    expect(foreignReplay.body.results).toEqual([{ request_id: 'management-request', status: 'not_replayable' }]);
    expect(await state()).toEqual(before);
  });
  it('rejects cross-origin, cross-site and form actions across every original POST and PUT', async () => {
    const before = await state();
    for (const op of operations().filter(op => op.method !== 'get')) {
      for (const [name, value] of [['Origin', 'https://untrusted.invalid'], ['Sec-Fetch-Site', 'cross-site']]) {
        const response = await call(op).set(name, value);
        expect({ id: op.id, status: response.status }).toEqual({ id: op.id, status: 403 });
        expect(response.body.error.code).toBe('pricing_permission_denied');
      }
      const form = await request(h.app.getHttpServer())[op.method](op.path).set('Cookie', adminCookie).type('form').send({ content: 'synthetic' });
      expect(form.status).toBe(403);
    }
    expect(await state()).toEqual(before);
    expect(await h.managementAuditRepo.count({ where: { action: 'pricing.action.denied', result: 'denied' } })).toBeGreaterThan(0);
  });
  it('applies host JSON limits before every original POST and PUT and never publishes through GET', async () => {
    const before = await state();
    const limit = jest.spyOn(h.app.get(ConfigService), 'pricingLimits', 'get').mockReturnValue(resolvePricingLimits({ max_request_body_bytes: 1024 }));
    try {
      for (const op of operations().filter(op => op.method !== 'get')) {
        const response = await call({ ...op, body: { content: '界'.repeat(600) } });
        expect({ id: op.id, status: response.status }).toEqual({ id: op.id, status: 413 });
        expect(response.body.error.code).toBe('pricing_request_too_large');
      }
    } finally { limit.mockRestore(); }
    for (const op of operations().filter(op => op.write && op.method === 'post' && op.id !== 'create')) {
      expect((await call({ ...op, method: 'get', body: undefined })).status).toBe(404);
    }
    expect(await state()).toEqual(before);
  });
  it('rejects executable fields, private notes and workspace/actor overrides without losing hidden data', async () => {
    const before = await state();
    for (const content of [{ ...tokenBook(), script: 'process.exit(1)' }, { ...tokenBook(), private_note: 'synthetic-private-note' }, { ...tokenBook(), source: { kind: 'manual', credentials: 'synthetic-source-key' } }]) {
      const response = await call({ id: 'import', method: 'post', path: `${base}/import/validate`, body: { format: 'siftgate-price-book-v1', content } });
      expect(response.status).toBe(400); expect(response.body.error.code).toBe('pricing_invalid_document');
    }
    for (const op of operations().filter(op => op.write)) {
      const response = await call({ ...op, body: { ...op.body, workspace_id: other, actor_id: 'forged', role: 'admin' } });
      expect(response.status).toBe(400); expect(response.body.error.code).toBe('pricing_invalid_document');
    }
    expect(await state()).toEqual(before);
  });
  it('returns the required compiler and missing-evidence diagnostic vocabulary without pricing unknowns as zero', async () => {
    const before = await state();
    const conflict = tokenBook(); conflict.groups[0].rules.push({ id: 'collision', priority: 0, mode: 'whole_request', condition: {}, rates: [] });
    const unit = tokenBook(); unit.groups[0].rules[0].rates[0].component.unit = 'second';
    const mode = tokenBook(); (mode.groups[0].rules[0] as { mode: string }).mode = 'graduated';
    for (const [content, code] of [[conflict, 'pricing_rule_conflict'], [unit, 'pricing_unit_mismatch'], [mode, 'unsupported_rule_mode']] as const) {
      const response = await call({ id: 'quote', method: 'post', path: `${base}/quote`, body: { content, evidence: evidence() } });
      expect(response.status).toBe(400); expect(response.body.error).toMatchObject({ type: 'pricing_error', code });
      expect(response.body.diagnostics.some((d: { code: string }) => d.code === code)).toBe(true);
    }
    const calendar = conditionBook('weekday'); calendar.calendar!.tzdb_version = 'synthetic-unavailable-tzdb';
    for (const [body, code] of [
      [{ content: tokenBook(), evidence: [] }, 'pricing_dimension_missing'],
      [{ content: { ...tokenBook(), currency: 'CNY' }, evidence: evidence(), report_currency: 'USD' }, 'pricing_fx_missing'],
      [{ content: tokenBook(), evidence: evidence(), context: { requested_service_tier: 'priority' } }, 'pricing_unknown_variant'],
      [{ content: calendar, evidence: evidence(), context: { attempt_dispatched_at: '2026-09-25T10:00:00+08:00' } }, 'pricing_calendar_unavailable'],
    ] as const) {
      const response = await call({ id: 'quote', method: 'post', path: `${base}/quote`, body });
      expect(response.status).toBe(201); expect(response.body.cost.diagnostics.some((d: { code: string }) => d.code === code)).toBe(true);
      expect(response.body.cost.report_amount).toBeNull();
    }
    expect(await state()).toEqual(before);
  });
  it('exports portable immutable rules with no local paths, URL credentials, queries or private fragments', async () => {
    const references = [
      ['https://user:synthetic-credential@example.test/prices?token=synthetic#private-note', 'https://example.test/prices'],
      ['/private/contracts/pricing.yaml', undefined], ['file:///private/contracts/pricing.yaml', undefined],
      ['http://127.0.0.1/private', undefined], ['http://[::1]/private', undefined],
      ['https://rates.internal/private', undefined], ['https://rates.internal./private', undefined],
      ['https://gateway.local./private', undefined], ['https://gateway.localhost./private', undefined],
    ] as const;
    for (const [reference, expected] of references) {
      const content = tokenBook(); content.source = { kind: 'manual', reference, verified_at: '2026-09-25' };
      const created = await call({ id: 'create', method: 'post', path: `${base}/books`, body: { name: 'Synthetic export contract', content } });
      expect(created.status).toBe(201);
      const published = await call({ id: 'publish', method: 'post', path: `${base}/drafts/${created.body.draft.id}/publish`, body: publication(await headRevision()) });
      expect(published.status).toBe(201);
      const before = await state();
      const exported = await call({ id: 'export', method: 'get', path: `${base}/books/${created.body.book.id}/export?version_id=${published.body.version_id}` });
      expect(exported.status).toBe(200); expect(exported.body.content.source).toEqual({ kind: 'manual', ...(expected ? { reference: expected } : {}), verified_at: '2026-09-25' });
      expect(exported.body).toEqual({ format: 'siftgate-price-book-v1', content: { ...content, source: exported.body.content.source } });
      const imported = await call({ id: 'import', method: 'post', path: `${base}/import/validate`, body: exported.body });
      expect(imported.status).toBe(201); expect(imported.body.dry_run).toBe(true); expect(imported.body.content).toEqual(exported.body.content);
      expect(await state()).toEqual(before);
      expect((await prices.getVersion(actor, created.body.book.id, published.body.version_id)).content.source.reference).toBe(reference);
    }
  });
  it('keeps draft CAS, preview, audit rollback, scheduled activation and new-version rollback atomic', async () => {
    const created = await call({ id: 'create', method: 'post', path: `${base}/books`, body: { name: 'Lifecycle contract', content: tokenBook() } });
    expect(created.status).toBe(201); const id = created.body.book.id, draft = created.body.draft.id;
    const before = await state(), revision = await headRevision();
    const changed = tokenBook(); changed.groups[0].rules[0].rates[0].component.amount = '2';
    const updated = await call({ id: 'update', method: 'put', path: `${base}/drafts/${draft}`, body: { revision: 1, content: changed } });
    expect(updated.status).toBe(200); expect(updated.body.content).toEqual(changed);
    expect((await state()).rows.pricing_catalog_revisions).toEqual(before.rows.pricing_catalog_revisions);
    const edited = await state();
    const stale = await call({ id: 'update', method: 'put', path: `${base}/drafts/${draft}`, body: { revision: 1, content: tokenBook() } });
    expect(stale.status).toBe(409); expect(stale.body.error.code).toBe('pricing_version_conflict'); expect(await state()).toEqual(edited);
    const options = { ...publication(revision), draft_revision: 2, effective_from: new Date(Date.now() + 3600000).toISOString() };
    const preview = await call({ id: 'publish', method: 'post', path: `${base}/drafts/${draft}/preview-publication`, body: options });
    expect(preview.status).toBe(201); expect(preview.body.dry_run).toBe(true); expect(await state()).toEqual(edited);
    for (const denied of [{ ...options, confirm: false }, { ...options, reason: '' }]) expect((await call({ id: 'publish', method: 'post', path: `${base}/drafts/${draft}/publish`, body: denied })).status).toBe(400);
    expect(await state()).toEqual(edited);
    const execute = InsertQueryBuilder.prototype.execute;
    const failure = jest.spyOn(InsertQueryBuilder.prototype, 'execute').mockImplementation(function (this: InsertQueryBuilder<Record<string, unknown>>) {
      if (this.getQuery().includes('pricing_audit_events') && JSON.stringify(this.getParameters()).includes('draft.published')) throw new Error('Synthetic publication audit failure');
      return execute.call(this);
    });
    try { expect((await call({ id: 'publish', method: 'post', path: `${base}/drafts/${draft}/publish`, body: options })).status).toBe(500); }
    finally { failure.mockRestore(); }
    expect(await state()).toEqual(edited);
    const published = await call({ id: 'publish', method: 'post', path: `${base}/drafts/${draft}/publish`, body: options });
    expect(published.status).toBe(201);
    const detail = await call({ id: 'book', method: 'get', path: `${base}/books/${id}` });
    expect(detail.body.bindings.some((b: { effective_from: string }) => b.effective_from === options.effective_from)).toBe(true);
    const frozen = await state(), rollbackOptions = { version_id: published.body.version_id, catalog_revision: await headRevision(), reason: 'Synthetic rollback', confirm: true, targets: [{ level: 'model', model: 'gpt-4o-mini' }] };
    expect((await call({ id: 'rollback', method: 'post', path: `${base}/books/${id}/preview-rollback`, body: rollbackOptions })).body.dry_run).toBe(true);
    expect(await state()).toEqual(frozen);
    const rollback = await call({ id: 'rollback', method: 'post', path: `${base}/books/${id}/rollback`, body: rollbackOptions });
    expect(rollback.status).toBe(201); expect(rollback.body.version_id).not.toBe(published.body.version_id);
    expect((await prices.getVersion(actor, id, rollback.body.version_id)).content).toEqual(changed);
    expect((await state()).rows.budget_rules).toEqual(before.rows.budget_rules);
    expect((await state()).rows.call_logs).toEqual(before.rows.call_logs);
    expect((await state()).providerCalls).toBe(0);
  });
});

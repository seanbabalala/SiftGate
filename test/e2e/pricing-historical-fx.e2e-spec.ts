import { DataSource } from 'typeorm';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import * as bcrypt from 'bcryptjs';
import * as request from 'supertest';
import { createE2EHarness, type E2EHarness, FIXTURE_PATH } from './setup';
import { PricingRecoveryService } from '../../src/pricing/pricing-recovery.service';
import { PricingRepository } from '../../src/pricing/pricing-repository';
import { CostLedgerService } from '../../src/pricing/cost-ledger.service';
import { applyPricingSchema, PRICING_TABLE_NAMES } from '../../src/pricing/pricing-schema';
import { pricingContentHash } from '../../src/pricing/pricing-json';
import { WorkspaceService } from '../../src/workspaces/workspace.service';
import { WorkspaceMembershipService } from '../../src/auth/workspace-membership.service';
import { tokenBook, tokens } from '../unit/pricing-fixtures';

const workspace = 'default-workspace';
const actor = { id: 'dashboard', workspace_id: workspace, role: 'admin' as const, global_admin: true };
describe('historical receipt FX HTTP', () => {
  let directory: string;
  let h: E2EHarness, db: DataSource, prices: PricingRepository, ledger: CostLedgerService;
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'historical-fx-http-'));
    const config = yaml.load(readFileSync(FIXTURE_PATH, 'utf8')) as Record<string, unknown>;
    config.dashboard = { auth_required: true, allow_legacy_token_auth: false, password: bcrypt.hashSync('synthetic-fx-password', 4), session_secret: 'synthetic-fx-session-secret' };
    const file = join(directory, 'config.yaml'); writeFileSync(file, yaml.dump(config));
    h = await createE2EHarness(file); await h.app.get(PricingRecoveryService).onModuleDestroy();
    expect((await h.agent.post('/api/auth/login').send({ password: 'synthetic-fx-password' })).status).toBe(201);
    db = h.app.get(DataSource); await applyPricingSchema(db); prices = h.app.get(PricingRepository); ledger = h.app.get(CostLedgerService);
    const content = tokenBook(); content.currency = 'CNY';
    const created = await prices.createBook(actor, { name: 'Synthetic CNY', scope: 'workspace', content });
    await prices.publishDraft(actor, created.draft.id, { draft_revision: 1, catalog_revision: 0, reason: 'Synthetic', confirm: true, targets: [{ level: 'model', model: 'm' }] });
  });
  afterEach(async () => { await h?.close(); if (directory) rmSync(directory, { recursive: true, force: true }); });
  async function fx(denominator: string) {
    const head = (await prices.listBooks(actor)).head;
    await prices.updateFx(actor, { catalog_revision: head.revision, confirm: true, scope: 'workspace', reason: 'Synthetic', versions: [{ fx: { version_id: 'synthetic-input', from_currency: 'CNY', to_currency: 'USD', numerator: '1', denominator, source: 'Synthetic FX ' + denominator, effective_at: '2026-01-01T00:00:00Z' } }] });
  }
  async function receipt(id: string) {
    const snapshot = await prices.capture({ request_id: id, workspace_id: workspace, report_currency: 'USD' });
    const cost = snapshot!.quote({ model: 'm', node_id: 'n' }, tokens({ input_tokens: 1000, output_tokens: 0 })).cost;
    await ledger.beginAttempt({ id: 'attempt-' + id, requestId: id, workspace, target: { model: 'm', node_id: 'n' }, feeSource: 'provider', dispatchedAt: new Date().toISOString(), priceContext: { context: {}, legacyPrice: null } });
    await ledger.completeAttempt('attempt-' + id, workspace, cost); return { cost, hash: pricingContentHash(cost) };
  }
  const dump = async () => { const rows: Record<string, unknown> = {}; for (const t of [...PRICING_TABLE_NAMES, 'budget_rules', 'call_logs']) rows[t] = await db.query(`SELECT * FROM ${t}`); return rows; };
  it('shows the exact admitted FX after publication without rewriting receipts or finances', async () => {
    await fx('7'); const old = await receipt('old'); await fx('5'); const fresh = await receipt('new'); const before = await dump();
    const result = await h.agent.get(`/api/dashboard/pricing/requests/old/fx/${old.cost.fx_version_id}`).query({ cost_hash: old.hash });
    expect({ status: result.status, error: result.body.error }).toEqual({ status: 200, error: undefined });
    expect(result.body).toMatchObject({ schema_version: 1, read_only: true, workspace_id: workspace, request_id: 'old', receipt_hash: old.hash, fx: { version_id: old.cost.fx_version_id, numerator: '1', denominator: '7', source: 'Synthetic FX 7', source_redacted: false, from_currency: 'CNY', to_currency: 'USD' } });
    expect(result.body.fx.version_id).not.toBe(fresh.cost.fx_version_id);
    const { evidence_hash, ...body } = result.body; expect(evidence_hash).toBe(pricingContentHash(body));
    expect(await dump()).toEqual(before); expect(h.fetchMock.calls).toHaveLength(0);
  });
  it('allows a stored viewer but does not expose another workspace, request or unused FX reference', async () => {
    await fx('7'); const r = await receipt('private'); const other = await h.app.get(WorkspaceService).createWorkspace({ name: 'Other FX workspace' });
    const members = h.app.get(WorkspaceMembershipService);
    await members.ensureMembership({ userId: 'backup-admin', workspaceId: workspace, organizationId: 'default-org', role: 'admin' });
    await members.ensureMembership({ userId: 'dashboard', workspaceId: workspace, organizationId: 'default-org', role: 'viewer' });
    await members.ensureMembership({ userId: 'dashboard', workspaceId: other.id, organizationId: other.organization_id, role: 'viewer' });
    const path = `/api/dashboard/pricing/requests/private/fx/${r.cost.fx_version_id}`, before = await dump();
    expect((await h.agent.get(path).query({ cost_hash: r.hash })).status).toBe(200);
    expect((await h.agent.get(path).set('x-siftgate-workspace-id', other.id).query({ cost_hash: r.hash })).status).toBe(404);
    expect((await h.agent.get(path).query({ cost_hash: '0'.repeat(64) })).status).toBe(404);
    expect((await h.agent.get(path.replace('/private/', '/missing/')).query({ cost_hash: r.hash })).status).toBe(404);
    expect(await dump()).toEqual(before); expect(h.fetchMock.calls).toHaveLength(0);
  });
  it('returns structured invalid-input responses for missing hashes, extra fields and overlong identities', async () => {
    await fx('7'); const r = await receipt('input'), path = `/api/dashboard/pricing/requests/input/fx/${r.cost.fx_version_id}`;
    for (const query of [{}, { cost_hash: 'not-a-hash' }, { cost_hash: r.hash, workspace_id: 'forged' }]) {
      const response = await h.agent.get(path).query(query); expect(response.status).toBe(400); expect(response.body.error.type).toBe('pricing_error');
    }
    expect((await h.agent.get(path.replace('/input/', '/' + 'r'.repeat(129) + '/')).query({ cost_hash: r.hash })).status).toBe(400);
  });
  it('returns a structured conflict for a malformed admitted snapshot, without applying current FX', async () => {
    await fx('7'); const r = await receipt('corrupt'); await db.createQueryBuilder().update('pricing_request_snapshots').set({ descriptor_json: 'null' }).where('request_id = :id', { id: 'corrupt' }).execute();
    const before = await dump(), response = await h.agent.get(`/api/dashboard/pricing/requests/corrupt/fx/${r.cost.fx_version_id}`).query({ cost_hash: r.hash });
    expect(response.status).toBe(503); expect(response.body.error.type).toBe('pricing_error'); expect(await dump()).toEqual(before);
  });

  it('requires a real Dashboard session before exposing retained FX evidence', async () => {
    await fx('7'); const r = await receipt('authenticated'), path = `/api/dashboard/pricing/requests/authenticated/fx/${r.cost.fx_version_id}`;
    expect((await request(h.app.getHttpServer()).get(path).query({ cost_hash: r.hash })).status).toBe(401);
    expect((await request(h.app.getHttpServer()).get(path).set('Authorization', 'Bearer invalid').query({ cost_hash: r.hash })).status).toBe(401);
    expect((await h.agent.get(path).query({ cost_hash: r.hash })).status).toBe(200);
  });

});

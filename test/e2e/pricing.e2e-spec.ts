import { DataSource } from 'typeorm';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createE2EHarness, E2EHarness, FIXTURE_PATH } from './setup';
import { applyPricingSchema } from '../../src/pricing/pricing-schema';
import { PricingRepository } from '../../src/pricing/pricing-repository';
import { WorkspaceMembershipService } from '../../src/auth/workspace-membership.service';
import { AuthService } from '../../src/auth/auth.service';
import {
  DEFAULT_ORGANIZATION_ID,
  DEFAULT_WORKSPACE_ID,
} from '../../src/workspaces/workspace.constants';
import { tokenBook, tokens } from '../unit/pricing-fixtures';

describe('pricing administration with isolated state and mocked providers', () => {
  let harness: E2EHarness;
  let directory: string;
  const endpoint = '/api/dashboard/pricing';
  const publication = (draft: number, catalog: number) => ({
    draft_revision: draft,
    catalog_revision: catalog,
    reason: 'e2e fixture',
    confirm: true,
    targets: [{ level: 'model', model: 'gpt-4o' }],
  });
  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'pricing-api-'));
    const config = join(directory, 'gateway.yaml');
    copyFileSync(FIXTURE_PATH, config);
    harness = await createE2EHarness(config);
  }, 30000);
  afterAll(async () => {
    await harness?.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('starts without pricing schema and does not auto-migrate', async () => {
    const status = await harness.agent.get(`${endpoint}/status`);
    expect(status.status).toBe(200);
    expect(status.body.state).toBe('pending');
    const create = await harness.agent
      .post(`${endpoint}/books`)
      .send({ name: 'test', content: tokenBook() });
    expect(create.status).toBe(503);
    expect(create.body.error.code).toBe('pricing_schema_required');
    expect((await harness.agent.get(`${endpoint}/status`)).body.state).toBe('pending');
    await applyPricingSchema(harness.app.get(DataSource));
  });

  it('creates, edits, quotes, previews, publishes and restores old prices without model calls', async () => {
    harness.fetchMock.reset();
    const created = await harness.agent
      .post(`${endpoint}/books`)
      .send({ name: 'e2e book', content: tokenBook() });
    expect(created.status).toBe(201);
    const { book, draft } = created.body;
    const edited = tokenBook();
    edited.groups[0].rules[0].rates[0].component.amount = '2';
    expect(
      (
        await harness.agent
          .put(`${endpoint}/drafts/${draft.id}`)
          .send({ revision: 1, content: edited })
      ).status,
    ).toBe(200);
    expect(
      (
        await harness.agent
          .put(`${endpoint}/drafts/${draft.id}`)
          .send({ revision: 1, content: tokenBook() })
      ).status,
    ).toBe(409);
    const evidence = Object.values(
      tokens({ input_tokens: 1000, output_tokens: 500 }).quantities,
    ).map((entry) => ({ dimension: entry!.dimension, value: entry!.value }));
    const budgetBefore = await harness.app
      .get(DataSource)
      .query('SELECT * FROM budget_rules ORDER BY id');
    const quote = await harness.agent
      .post(`${endpoint}/quote`)
      .send({ draft_id: draft.id, evidence });
    expect(quote.status).toBe(201);
    expect(quote.body.simulation).toBe(true);
    expect(quote.body.cost.amount).toBe('0.003000000');
    expect(
      await harness.app.get(DataSource).query('SELECT * FROM budget_rules ORDER BY id'),
    ).toEqual(budgetBefore);
    expect(
      (await harness.agent.post(`${endpoint}/drafts/${draft.id}/validate`).send({})).body.valid,
    ).toBe(true);
    const preview = await harness.agent
      .post(`${endpoint}/drafts/${draft.id}/preview-publication`)
      .send(publication(2, 0));
    expect(preview.status).toBe(201);
    expect(preview.body.dry_run).toBe(true);
    expect((await harness.agent.get(`${endpoint}/bindings`)).body.head.revision).toBe(0);
    expect(
      (
        await harness.agent
          .post(`${endpoint}/drafts/${draft.id}/publish`)
          .send({ ...publication(2, 0), confirm: false })
      ).status,
    ).toBe(400);
    const published = await harness.agent
      .post(`${endpoint}/drafts/${draft.id}/publish`)
      .send(publication(2, 0));
    expect(published.status).toBe(201);
    expect(published.body.head.revision).toBe(1);
    const request = await harness.app.get(PricingRepository).capture({
      request_id: 'e2e-original',
      workspace_id: DEFAULT_WORKSPACE_ID,
      report_currency: 'USD',
    });
    const exported = await harness.agent
      .get(`${endpoint}/books/${book.id}/export`)
      .query({ version_id: published.body.version_id });
    expect(exported.status).toBe(200);
    expect(exported.body.content.groups[0].rules[0].rates).toHaveLength(6);
    const forked = await harness.agent
      .post(`${endpoint}/books/${book.id}/drafts`)
      .send({ version_id: published.body.version_id });
    expect(forked.status).toBe(201);
    const updated = structuredClone(forked.body.content);
    updated.groups[0].rules[0].rates[0].component.amount = '3';
    expect(
      (
        await harness.agent
          .put(`${endpoint}/drafts/${forked.body.id}`)
          .send({ revision: 1, content: updated })
      ).status,
    ).toBe(200);
    expect(
      (
        await harness.agent
          .post(`${endpoint}/drafts/${forked.body.id}/publish`)
          .send(publication(2, 1))
      ).status,
    ).toBe(201);
    expect(
      request!.quote({ model: 'gpt-4o' }, tokens({ input_tokens: 1000, output_tokens: 0 })).cost
        .amount,
    ).toBe('0.002000000');
    expect(
      (await harness.agent.get(`${endpoint}/audit`).query({ book_id: book.id })).body.some(
        (event: { action: string }) => event.action === 'draft.published',
      ),
    ).toBe(true);
    expect(harness.fetchMock.calls).toHaveLength(0);
    const rollback = await harness.agent.post(`${endpoint}/books/${book.id}/rollback`).send({
      version_id: published.body.version_id,
      catalog_revision: 2,
      confirm: true,
      reason: 'restore tested version',
      targets: [{ level: 'model', model: 'gpt-4o' }],
    });
    expect(rollback.status).toBe(201);
    expect(rollback.body.version_id).not.toBe(published.body.version_id);
  });

  it('blocks viewer mutation, body role spoofing, and untrusted cross-origin writes', async () => {
    const memberships = harness.app.get(WorkspaceMembershipService);
    // Keep a separate fixture admin before testing a downgraded Dashboard identity.
    await memberships.ensureMembership({ userId: 'synthetic-fixture-admin', organizationId: DEFAULT_ORGANIZATION_ID, workspaceId: DEFAULT_WORKSPACE_ID, role: 'admin' });
    await memberships.ensureMembership({
      userId: 'dashboard',
      organizationId: DEFAULT_ORGANIZATION_ID,
      workspaceId: DEFAULT_WORKSPACE_ID,
      role: 'viewer',
    });
    try {
      expect(
        (
          await harness.agent
            .post(`${endpoint}/books`)
            .send({ name: 'blocked', content: tokenBook(), role: 'admin' })
        ).status,
      ).toBe(403);
      expect(
        (await harness.agent.post(`${endpoint}/quote`).send({ content: tokenBook(), evidence: [] }))
          .status,
      ).toBe(201);
    } finally {
      await memberships.ensureMembership({
        userId: 'dashboard',
        organizationId: DEFAULT_ORGANIZATION_ID,
        workspaceId: DEFAULT_WORKSPACE_ID,
        role: 'admin',
      });
    }
    expect(
      (
        await harness.agent
          .post(`${endpoint}/books`)
          .set('Origin', 'https://untrusted.example')
          .send({ name: 'blocked', content: tokenBook() })
      ).status,
    ).toBe(403);
    expect(
      (await harness.agent.post(`${endpoint}/books`).type('form').send({ name: 'blocked' })).status,
    ).toBe(403);
    expect(
      (
        await harness.agent.post(`${endpoint}/books`).send({
          name: 'blocked',
          scope: 'workspace',
          workspace_id: 'someone-else',
          content: tokenBook(),
        })
      ).status,
    ).toBe(400);
    expect(
      await harness.managementAuditRepo.count({
        where: { action: 'pricing.action.denied', result: 'denied' },
      }),
    ).toBeGreaterThan(0);
  });

  it('requires a dashboard session when authentication is enabled', async () => {
    const required = jest
      .spyOn(harness.app.get(AuthService), 'isAuthRequired', 'get')
      .mockReturnValue(true);
    try {
      expect((await harness.agent.get(`${endpoint}/status`)).status).toBe(401);
    } finally {
      required.mockRestore();
    }
  });

  it('protects resource scope even when another workspace administrator knows its IDs', async () => {
    const created = await harness.agent
      .post(`${endpoint}/books`)
      .send({ name: 'private A', content: tokenBook() });
    const otherWorkspace = 'pricing-workspace-b';
    await harness.workspaceRepo.save(
      harness.workspaceRepo.create({
        id: otherWorkspace,
        organization_id: DEFAULT_ORGANIZATION_ID,
        name: 'Pricing B',
        slug: otherWorkspace,
        status: 'active',
        is_default: false,
      }),
    );
    await harness.app.get(WorkspaceMembershipService).ensureMembership({
      userId: 'dashboard',
      organizationId: DEFAULT_ORGANIZATION_ID,
      workspaceId: otherWorkspace,
      role: 'admin',
    });
    expect(
      (
        await harness.agent
          .get(`${endpoint}/books/${created.body.book.id}`)
          .set('x-siftgate-workspace-id', otherWorkspace)
      ).status,
    ).toBe(404);
    expect(
      (
        await harness.agent
          .put(`${endpoint}/drafts/${created.body.draft.id}`)
          .set('x-siftgate-workspace-id', otherWorkspace)
          .send({ revision: 1, content: tokenBook() })
      ).status,
    ).toBe(404);
    const memberships = harness.app.get(WorkspaceMembershipService);
    // Keep a separate fixture admin before testing a downgraded Dashboard identity.
    await memberships.ensureMembership({ userId: 'synthetic-fixture-admin', organizationId: DEFAULT_ORGANIZATION_ID, workspaceId: DEFAULT_WORKSPACE_ID, role: 'admin' });
    await memberships.ensureMembership({
      userId: 'dashboard',
      organizationId: DEFAULT_ORGANIZATION_ID,
      workspaceId: DEFAULT_WORKSPACE_ID,
      role: 'viewer',
    });
    try {
      expect(
        (
          await harness.agent
            .post(`${endpoint}/books`)
            .set('x-siftgate-workspace-id', otherWorkspace)
            .send({ name: 'forbidden global', scope: 'global', content: tokenBook() })
        ).status,
      ).toBe(403);
    } finally {
      await memberships.ensureMembership({
        userId: 'dashboard',
        organizationId: DEFAULT_ORGANIZATION_ID,
        workspaceId: DEFAULT_WORKSPACE_ID,
        role: 'admin',
      });
    }
  });

  it('rejects hidden unknown fields rather than stripping pricing configuration silently', async () => {
    const content = { ...tokenBook(), unsupported_billing_mode: 'future-mode' };
    const result = await harness.agent.post(`${endpoint}/books`).send({ name: 'invalid', content });
    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe('pricing_invalid_document');
    expect(
      (
        await harness.agent
          .post(`${endpoint}/import/validate`)
          .send({ format: 'legacy-token-pricing', content: { input: 1, output: 2 } })
      ).body.content.source.kind,
    ).toBe('legacy');
  });
});

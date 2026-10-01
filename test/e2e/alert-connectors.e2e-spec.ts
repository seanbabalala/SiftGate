import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createE2EHarness, E2EHarness, FIXTURE_PATH } from './setup';
import { WorkspaceMembershipService } from '../../src/auth/workspace-membership.service';
import { DEFAULT_ORGANIZATION_ID, DEFAULT_WORKSPACE_ID } from '../../src/workspaces/workspace.constants';

describe('Alert connector management (e2e, mocked outbound only)', () => {
  let harness: E2EHarness;
  let directory: string;
  const endpoint = '/api/dashboard/alerts/connectors';
  beforeAll(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'siftgate-alert-api-'));
    const config = path.join(directory, 'gateway.yaml');
    fs.copyFileSync(FIXTURE_PATH, config);
    harness = await createE2EHarness(config);
  }, 30000);
  afterAll(async () => { await harness?.close(); fs.rmSync(directory, { recursive: true, force: true }); });

  it('creates privately, tests explicitly, edits without leaking credentials, and deletes', async () => {
    const initial = await harness.agent.get(endpoint);
    expect(initial.status).toBe(200);
    expect(initial.body).toMatchObject({ enabled: false, channels: [], scope: 'gateway' });
    harness.fetchMock.reset();
    const created = await harness.agent.post(endpoint).send({ revision: initial.body.revision,
      channel: { type: 'wecom', name: 'ops', url: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=e2e-private-key' } });
    expect(created.status).toBe(201);
    expect(created.body.channels[0]).toMatchObject({ enabled: false, configured: { url: true } });
    expect(JSON.stringify(created.body)).not.toContain('e2e-private-key');
    expect(harness.fetchMock.calls).toHaveLength(0);
    const id = created.body.channels[0].id;
    const noConfirmation = await harness.agent.post(`${endpoint}/${id}/test`).send({ revision: created.body.revision });
    expect(noConfirmation.status).toBe(400);
    expect(harness.fetchMock.calls).toHaveLength(0);
    harness.fetchMock.setHandler(async () => new Response(JSON.stringify({ errcode: 0, errmsg: 'ok' })));
    const test = await harness.agent.post(`${endpoint}/${id}/test`).send({ revision: created.body.revision, confirm: true });
    expect(test.status).toBe(201);
    expect(test.body.status).toBe('sent');
    expect(harness.fetchMock.calls).toHaveLength(1);
    expect(harness.fetchMock.calls[0].body).toMatchObject({ msgtype: 'text', text: { content: expect.stringContaining('test message') } });
    const history = await harness.agent.get('/api/dashboard/alerts');
    expect(history.body.enabled).toBe(false);
    expect(history.body.recent[0]).toMatchObject({ event: 'test', status: 'sent' });
    const edited = await harness.agent.put(`${endpoint}/${id}`).send({ revision: created.body.revision, channel: { name: 'renamed', enabled: true } });
    expect(edited.status).toBe(200);
    expect(edited.body.channels[0].configured.url).toBe(true);
    expect(JSON.stringify(edited.body)).not.toContain('e2e-private-key');
    const stale = await harness.agent.put(`${endpoint}/${id}`).send({ revision: created.body.revision, channel: { name: 'stale edit' } });
    expect(stale.status).toBe(409);
    const removed = await harness.agent.delete(`${endpoint}/${id}`).send({ revision: edited.body.revision });
    expect(removed.status).toBe(200);
    expect(removed.body.channels).toEqual([]);
    expect(harness.fetchMock.calls).toHaveLength(1);
  });

  it('does not let a viewer read or change global connector credentials', async () => {
    const memberships = harness.app.get(WorkspaceMembershipService);
    // Keep a separate fixture admin before testing a downgraded Dashboard identity.
    await memberships.ensureMembership({ userId: 'synthetic-fixture-admin', organizationId: DEFAULT_ORGANIZATION_ID, workspaceId: DEFAULT_WORKSPACE_ID, role: 'admin' });
    await memberships.ensureMembership({ userId: 'dashboard', organizationId: DEFAULT_ORGANIZATION_ID, workspaceId: DEFAULT_WORKSPACE_ID, role: 'viewer' });
    try {
      expect((await harness.agent.get(endpoint)).status).toBe(403);
      expect((await harness.agent.post(endpoint).send({})).status).toBe(403);
    } finally {
      await memberships.ensureMembership({ userId: 'dashboard', organizationId: DEFAULT_ORGANIZATION_ID, workspaceId: DEFAULT_WORKSPACE_ID, role: 'admin' });
    }
  });

  it('rejects a workspace administrator without default-workspace administration', async () => {
    // Exercise the additional global-scope check independently of current role.
    const memberships = harness.app.get(WorkspaceMembershipService);
    // Keep a separate fixture admin before testing a downgraded Dashboard identity.
    await memberships.ensureMembership({ userId: 'synthetic-fixture-admin', organizationId: DEFAULT_ORGANIZATION_ID, workspaceId: DEFAULT_WORKSPACE_ID, role: 'admin' });
    const lookup = jest.spyOn(memberships, 'findActiveRole')
      .mockResolvedValueOnce('admin').mockResolvedValueOnce('viewer');
    try { expect((await harness.agent.get(endpoint)).status).toBe(403); }
    finally { lookup.mockRestore(); }
  });
});

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { createE2EHarness, E2EHarness, FIXTURE_PATH, API_KEY } from './setup';
import { AuthService } from '../../src/auth/auth.service';

// All provider traffic is intercepted by the shared FetchMock. No live keys/data/ports.
describe('Launchpad guided first request', () => {
  let h: E2EHarness;
  let directory: string;
  let key: { key: string; item: { id: string; key_prefix: string } };
  let prepared: any;
  let otherWorkspace: string;
  const selection = { node_id: 'mock-openai', model: 'gpt-4o' };
  const observe = async (keyId = '') => {
    const response = await h.agent.get('/api/dashboard/launchpad').query({ ...selection, ...(keyId ? { key_id: keyId } : {}) });
    expect(response.status).toBe(200); return response.body;
  };
  const review = (overview: any) => ({ ...selection, expected_digest: overview.selection.digest, timezone: overview.timezone, pricing_reviewed: true });
  beforeAll(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'siftgate-launchpad-e2e-'));
    const config = yaml.load(fs.readFileSync(FIXTURE_PATH, 'utf8')) as any;
    config.nodes[0].disabled = true;
    config.routing.circuit_breaker = { enabled: false };
    const file = path.join(directory, 'gateway.yaml'); fs.writeFileSync(file, yaml.dump(config));
    h = await createE2EHarness(file);
  }, 30000);
  afterAll(async () => { await h?.close(); if (directory) fs.rmSync(directory, { recursive: true, force: true }); });

  it('reads real environment and does not treat disabled sample nodes as ready', async () => {
    const before = h.fetchMock.calls.length;
    const status = await observe();
    expect(status.timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(status.selection.enabled).toBe(false);
    expect(status.keys).toHaveLength(0); expect(status.last_attempt).toBeNull();
    const response = await h.agent.post('/api/dashboard/launchpad/keys').send({ ...review(status), name: 'first-app', daily_token_limit: 10000, daily_cost_limit: 1, rate_limit_per_minute: 10 });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('launchpad_node_disabled');
    expect(h.fetchMock.calls.length).toBe(before);
  });

  it('really prevents provider dispatch even with the circuit breaker disabled', async () => {
    const before = h.fetchMock.calls.length;
    const result = await h.agent.post('/v1/chat/completions').set('Authorization', `Bearer ${API_KEY}`)
      .send({ model: 'mock-openai/gpt-4o', messages: [{ role: 'user', content: 'synthetic disabled node check' }], max_tokens: 16 });
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(h.fetchMock.calls.length).toBe(before);
  });

  it('enables only the explicitly selected node and rejects stale review/invalid limits', async () => {
    const old = await observe();
    const enabled = await h.agent.put('/api/dashboard/nodes/mock-openai').send({ disabled: false });
    expect(enabled.status).toBe(200);
    const status = await observe(); expect(status.selection.enabled).toBe(true);
    const body = { ...review(old), name: 'first-app', daily_token_limit: 10000, daily_cost_limit: 1, rate_limit_per_minute: 10 };
    expect((await h.agent.post('/api/dashboard/launchpad/keys').send(body)).status).toBe(409);
    expect((await h.agent.post('/api/dashboard/launchpad/keys').send({ ...body, ...review(status), daily_cost_limit: 0 })).status).toBe(400);
    expect((await h.agent.post('/api/dashboard/launchpad/keys').send({ ...body, ...review(status), pricing_reviewed: false })).status).toBe(400);
    expect((await h.agent.post('/api/dashboard/launchpad/keys').set('Sec-Fetch-Site', 'same-site').send({ ...body, ...review(status) })).status).toBe(403);
  });

  it('creates one limited key, ignoring attempts to widen permissions, and audits no plaintext', async () => {
    const status = await observe();
    const response = await h.agent.post('/api/dashboard/launchpad/keys').send({ ...review(status), name: 'first-app',
      daily_token_limit: 10000, daily_cost_limit: 1, rate_limit_per_minute: 10,
      allow_auto: true, allowed_nodes: [], allowed_models: [], allowed_endpoints: [] });
    expect(response.status).toBe(201); key = response.body;
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body.item).toMatchObject({ allow_auto: false, allow_direct: true, allowed_nodes: ['mock-openai'],
      allowed_models: ['gpt-4o'], allowed_endpoints: ['chat_completions'], allowed_modalities: ['text'], daily_token_limit: 10000, daily_cost_limit: 1, rate_limit_per_minute: 10 });
    expect((await h.agent.post('/api/dashboard/launchpad/keys').send({ ...review(status), name: 'first-app', daily_token_limit: 10000, daily_cost_limit: 1, rate_limit_per_minute: 10 })).status).toBe(400);
    const rows = await h.managementAuditRepo.find({ where: { action: 'launchpad.key.create' } });
    expect(rows.length).toBe(1);
    expect(JSON.stringify(rows)).not.toContain(key.key);
  });

  it('requires fresh cost consent and verifies the exact workspace key without calling a model', async () => {
    const status = await observe(key.item.id);
    const before = h.fetchMock.calls.length;
    const body = { ...review(status), key_id: key.item.id, key_secret: key.key, confirm_cost: false };
    expect((await h.agent.post('/api/dashboard/launchpad/prepare-test').send(body)).status).toBe(400);
    const mismatch = await h.agent.post('/api/dashboard/launchpad/prepare-test').send({ ...body, key_secret: API_KEY, confirm_cost: true });
    expect(mismatch.status).toBe(403); expect(mismatch.body.error.code).toBe('launchpad_key_mismatch');
    const result = await h.agent.post('/api/dashboard/launchpad/prepare-test').send({ ...body, confirm_cost: true });
    expect(result.status).toBe(201); prepared = result.body;
    expect(prepared.request.body.model).toBe('mock-openai/gpt-4o');
    expect(prepared.request.body.max_tokens).toBe(16);
    expect(h.fetchMock.calls.length).toBe(before);
    const receipt = await h.agent.get(`/api/dashboard/launchpad/attempts/${prepared.attempt_id}`);
    expect(receipt.status).toBe(200); expect(receipt.body.status).toBe('pending');
    expect(JSON.stringify(result.body)).not.toContain(key.key);
    const rows = await h.managementAuditRepo.find({ where: { action: 'launchpad.test.prepare' } });
    expect(JSON.stringify(rows)).not.toContain(key.key);
  });

  it('cannot fabricate completion from a UI flag or a foreign request', async () => {
    const before = h.fetchMock.calls.length;
    const receipt = await h.agent.get(`/api/dashboard/launchpad/attempts/${prepared.attempt_id}`).query({ status: 'verified' });
    expect(receipt.body.status).toBe('pending'); expect(receipt.body.evidence).toBeNull();
    const fake = await h.agent.get('/api/dashboard/launchpad/attempts/launchpad-00000000-0000-4000-8000-000000000000');
    expect(fake.status).toBe(404); expect(h.fetchMock.calls.length).toBe(before);
  });

  it('verifies a real key-authenticated request and persists metadata-only evidence for reloads', async () => {
    const result = await h.agent.post(prepared.request.path).set('Authorization', `Bearer ${key.key}`)
      .set('x-session-key', prepared.attempt_id).send(prepared.request.body);
    expect(result.status).toBe(200);
    const receipt = await h.agent.get(`/api/dashboard/launchpad/attempts/${prepared.attempt_id}`);
    expect(receipt.status).toBe(200);
    expect(receipt.body.status).toBe('verified');
    expect(receipt.body.evidence).toMatchObject({ node_id: 'mock-openai', model: 'gpt-4o', status_code: 200, input_tokens: 10, output_tokens: 5 });
    expect(JSON.stringify(receipt.body)).not.toMatch(/Reply with OK|Mock OpenAI response|key_secret/);
    const calls = h.fetchMock.calls.length;
    expect((await observe(key.item.id)).last_attempt.status).toBe('verified');
    expect(h.fetchMock.calls.length).toBe(calls);
  });

  it('keeps the restricted key away from other models and auto routing', async () => {
    const before = h.fetchMock.calls.length;
    for (const model of ['auto', 'mock-anthropic/claude-sonnet-4-20250514']) {
      const result = await h.agent.post('/v1/chat/completions').set('Authorization', `Bearer ${key.key}`)
        .send({ model, messages: [{ role: 'user', content: 'synthetic forbidden route' }], max_tokens: 16 });
      expect(result.status).toBeGreaterThanOrEqual(400);
    }
    expect(h.fetchMock.calls.length).toBe(before);
  });

  it('does not leak another workspace’s attempts or keys', async () => {
    const created = await h.agent.post('/api/dashboard/workspaces').send({ name: 'Launchpad Other', slug: 'launchpad-other' });
    expect(created.status).toBe(201); otherWorkspace = created.body.item.id;
    const receipt = await h.agent.get(`/api/dashboard/launchpad/attempts/${prepared.attempt_id}`).set('x-siftgate-workspace-id', otherWorkspace);
    expect(receipt.status).toBe(404);
    const keys = await h.agent.get('/api/dashboard/launchpad').set('x-siftgate-workspace-id', otherWorkspace).query({ ...selection, key_id: key.item.id });
    expect(keys.status).toBe(404);
  });

  it('invalidates old evidence on key policy or node configuration changes', async () => {
    const update = await h.agent.put(`/api/dashboard/api-keys/${key.item.id}`).send({ daily_cost_limit: 2 });
    expect(update.status).toBe(200);
    const receipt = await h.agent.get(`/api/dashboard/launchpad/attempts/${prepared.attempt_id}`);
    expect(receipt.body.status).toBe('stale'); expect(receipt.body.evidence).toBeNull();
    const disabled = await h.agent.put('/api/dashboard/nodes/mock-openai').send({ disabled: true });
    expect(disabled.status).toBe(200);
    expect((await observe(key.item.id)).selection.enabled).toBe(false);
  });

  it('enforces administrator permission, including for prepared requests', async () => {
    // An authenticated user without a membership cannot use the privileged route.
    const auth = h.app.get(AuthService);
    const original = jest.spyOn(auth, 'isAuthRequired', 'get').mockReturnValue(true);
    const verify = jest.spyOn(auth, 'verifyToken').mockReturnValue({ sub: 'untrusted-viewer' });
    try {
      const result = await h.agent.post('/api/dashboard/launchpad/prepare-test').set('Authorization', 'Bearer synthetic-nonadmin').send({});
      expect(result.status).toBe(403);
    } finally { original.mockRestore(); verify.mockRestore(); }
  });
});

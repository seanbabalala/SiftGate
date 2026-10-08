import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import * as request from 'supertest';
import { DashboardIdentityStore } from '../../src/auth/dashboard-identity-store';
import { createE2EHarness, E2EHarness, FIXTURE_PATH, API_KEY } from './setup';

describe('Customer managed identity (real application, synthetic data)', () => {
  let harness: E2EHarness;
  let directory: string;
  let file: string;
  let store: DashboardIdentityStore;
  let access: string;
  let token: string;
  const password = 'synthetic first passphrase';
  const next = 'synthetic second passphrase';
  beforeAll(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'siftgate-identity-e2e-'));
    fs.chmodSync(directory, 0o700);
    file = path.join(directory, 'dashboard-identity.json');
    store = new DashboardIdentityStore(file); store.initialize();
    access = fs.readFileSync(path.join(directory, 'activate-code.txt'), 'utf8').trim();
    const config = yaml.load(fs.readFileSync(FIXTURE_PATH, 'utf8')) as any;
    config.dashboard = { auth_required: true, identity_file: file };
    config.auth.rate_limit.login_requests_per_minute = 100;
    const configFile = path.join(directory, 'gateway.yaml');
    fs.writeFileSync(configFile, yaml.dump(config));
    harness = await createE2EHarness(configFile);
  }, 30000);
  afterAll(async () => {
    await harness?.close();
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  });

  it('only exposes public state and does not let the first web visitor claim the instance', async () => {
    const status = await harness.agent.get('/api/auth/status');
    expect(status.status).toBe(200);
    expect(status.headers['cache-control']).toBe('no-store');
    expect(status.body.identity).toEqual({ mode: 'managed', setupRequired: true, activationExpired: false });
    expect(status.body.authenticated).toBe(false);
    expect(JSON.stringify(status.body)).not.toMatch(/session_secret|password_hash|sg_activate_|code_file/);
    expect((await harness.agent.get('/api/dashboard/stats')).status).toBe(401);
    expect((await harness.agent.post('/api/auth/login').send({ password })).status).toBe(401);
    expect((await harness.agent.post('/api/auth/identity/activate').send({ code: 'wrong', password })).status).toBe(401);
  });

  it('rejects cross-site/sibling-origin changes and weak passwords without consuming the code', async () => {
    for (const site of ['cross-site', 'same-site']) {
      const res = await harness.agent.post('/api/auth/identity/activate').set('Sec-Fetch-Site', site).send({ code: access, password });
      expect(res.status).toBe(403);
    }
    expect((await harness.agent.post('/api/auth/identity/activate').set('Origin', 'https://evil.invalid').send({ code: access, password })).status).toBe(403);
    const weak = await harness.agent.post('/api/auth/identity/activate').send({ code: access, password: 'short' });
    expect(weak.status).toBe(400);
    expect(weak.body.error.code).toBe('password_policy');
  });

  it('activates once and requires a separate sign-in', async () => {
    const res = await harness.agent.post('/api/auth/identity/activate').send({ code: access, password });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ ok: true, signInRequired: true });
    expect(res.headers['set-cookie']).toBeUndefined();
    expect((await harness.agent.post('/api/auth/identity/activate').send({ code: access, password })).status).toBe(401);
    const login = await harness.agent.post('/api/auth/login').send({ password });
    expect(login.status).toBe(201); token = login.body.token;
    expect(login.headers['set-cookie'][0]).toContain('HttpOnly');
    expect((await harness.agent.get('/api/auth/status').set('Authorization', `Bearer ${token}`)).body.authenticated).toBe(true);
    expect((await harness.agent.get('/api/dashboard/stats').set('Authorization', `Bearer ${token}`)).status).toBe(200);
  });

  it('requires current credentials and a dashboard session for password changes', async () => {
    const res = await request(harness.app.getHttpServer()).post('/api/auth/identity/password').send({ password: next, current_password: password });
    expect(res.status).toBe(401);
    const wrong = await harness.agent.post('/api/auth/identity/password').set('Authorization', `Bearer ${token}`).send({ password: next, current_password: 'wrong' });
    expect(wrong.status).toBe(401);
    const changed = await harness.agent.post('/api/auth/identity/password').set('Authorization', `Bearer ${token}`).send({ password: next, current_password: password });
    expect(changed.status).toBe(201);
    expect((await harness.agent.get('/api/dashboard/stats').set('Authorization', `Bearer ${token}`)).status).toBe(401);
    expect((await harness.agent.post('/api/auth/login').send({ password })).status).toBe(401);
  });

  it('host-issued recovery revokes sessions, preserves API keys and never sends a real provider request', async () => {
    const login = await harness.agent.post('/api/auth/login').send({ password: next });
    expect(login.status).toBe(201); token = login.body.token;
    store.issueCode('recover');
    const recovery = fs.readFileSync(path.join(directory, 'recover-code.txt'), 'utf8').trim();
    const reset = await harness.agent.post('/api/auth/identity/recover').send({ code: recovery, password });
    expect(reset.status).toBe(201);
    expect((await harness.agent.get('/api/dashboard/stats').set('Authorization', `Bearer ${token}`)).status).toBe(401);
    expect((await harness.agent.post('/api/auth/identity/recover').send({ code: recovery, password })).status).toBe(401);
    const model = await harness.agent.post('/v1/chat/completions').set('Authorization', `Bearer ${API_KEY}`)
      .send({ model: 'gpt-4o', messages: [{ role: 'user', content: 'synthetic identity regression' }] });
    expect(model.status).toBe(200);
    expect(harness.fetchMock.calls.length).toBeGreaterThan(0);
    expect((await harness.agent.post('/api/auth/login').send({ password })).status).toBe(201);
  });

  it('fails closed on missing identity without re-opening setup or writing credentials', async () => {
    fs.renameSync(file, file + '.saved');
    try {
      expect((await harness.agent.get('/api/auth/status')).status).toBeGreaterThanOrEqual(500);
      expect((await harness.agent.post('/api/auth/identity/activate').send({ code: access, password })).status).toBe(503);
      expect(fs.existsSync(file)).toBe(false);
    } finally { fs.renameSync(file + '.saved', file); }
  });
});

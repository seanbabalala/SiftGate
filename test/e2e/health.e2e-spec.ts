/**
 * E2E tests — GET /health endpoint
 */

import { createE2EHarness, E2EHarness } from './setup';
import { DatabaseHealthService } from '../../src/database/database-health.service';

describe('Health (e2e)', () => {
  let harness: E2EHarness;

  beforeAll(async () => {
    harness = await createE2EHarness();
  }, 30_000);

  afterAll(async () => {
    await harness?.close();
  });

  it('GET /live is a lightweight liveness check, independent of database readiness', async () => {
    const database = harness.app.get(DatabaseHealthService);
    const check = jest.spyOn(database, 'check').mockResolvedValue({
      healthy: false, connected: false, type: 'sqlite', target: ':memory:',
      latency_ms: 0, checked_at: new Date().toISOString(), error: 'test unavailable', synchronize: false,
    });
    try {
      const live = await harness.agent.get('/live');
      expect(live.status).toBe(200);
      expect(live.body).toEqual({ status: 'alive' });
      expect(check).not.toHaveBeenCalled();
      expect((await harness.agent.get('/ready')).status).toBe(503);
    } finally { check.mockRestore(); }
  });

  it('GET /health → 200 with expected shape', async () => {
    const res = await harness.agent.get('/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBeDefined();
    expect(['healthy', 'degraded']).toContain(res.body.status);
    expect(typeof res.body.uptime_ms).toBe('number');
    expect(res.body.uptime_human).toBeDefined();
    expect(res.body.timestamp).toBeDefined();
    expect(res.body.database).toMatchObject({
      healthy: true,
      type: 'sqlite',
      connected: true,
    });
    expect(Array.isArray(res.body.nodes)).toBe(true);
    expect(res.body.nodes.length).toBeGreaterThanOrEqual(2);
  });

  it('GET /ready → 200 when the database is available', async () => {
    const res = await harness.agent.get('/ready');

    expect(res.status).toBe(200);
    expect(res.body.ready).toBe(true);
    expect(res.body.status).toBe('ready');
    expect(res.body.database).toMatchObject({
      healthy: true,
      type: 'sqlite',
      connected: true,
    });
  });

  it('GET /health — nodes have expected shape', async () => {
    const res = await harness.agent.get('/health');
    const node = res.body.nodes[0];

    expect(node.id).toBeDefined();
    expect(node.name).toBeDefined();
    expect(node.protocol).toBeDefined();
    expect(typeof node.healthy).toBe('boolean');
    expect(node.circuit).toBeDefined();
    expect(node.active_probe).toBeDefined();
    expect(node.active_probe.status).toBeDefined();
    expect(node.active_probe.last_checked_at).toBeDefined();
    expect(node.active_probe.failure_reason).toBeDefined();
  });

  it('GET /health — response includes helmet security headers', async () => {
    const res = await harness.agent.get('/health');

    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBeDefined();
  });
});

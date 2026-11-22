/**
 * E2E — governance denials: refusals decided by key permissions and per-key
 * rate limits are recorded as metadata-only denial rows, and never as call logs.
 */
import { createE2EHarness, E2EHarness } from './setup';

describe('Governance denials (e2e)', () => {
  let harness: E2EHarness;

  beforeAll(async () => {
    harness = await createE2EHarness();
  }, 30_000);

  afterAll(async () => {
    await harness?.close();
  });

  beforeEach(() => {
    harness.fetchMock.reset();
  });

  it('records endpoint and rate-limit refusals once per minute bucket, without call logs or content', async () => {
    const unique = Date.now();
    const created = await harness.agent.post('/api/dashboard/api-keys').send({
      name: `denial-probe-${unique}`,
      allowed_endpoints: ['embeddings'],
      rate_limit_per_minute: 2,
    });
    expect(created.status).toBe(201);
    const keyId: string = created.body.item.id;
    const secret: string = created.body.key;
    const callLogsBefore = await harness.callLogRepo.count();

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await harness.agent
        .post('/v1/chat/completions')
        .set('Authorization', `Bearer ${secret}`)
        .send({ model: 'auto', messages: [{ role: 'user', content: `secret prompt ${unique}` }] });
      statuses.push(res.status);
    }
    expect(statuses).toEqual([403, 403, 429, 429]);
    expect(harness.fetchMock.calls).toHaveLength(0);

    const summary = await harness.agent.get('/api/dashboard/governance/denials/summary?period=1h');
    expect(summary.status).toBe(200);
    const byReason = Object.fromEntries(
      summary.body.by_reason.map((row: { reason: string; requests: number }) => [row.reason, row.requests]),
    );
    expect(byReason.endpoint_not_allowed).toBeGreaterThanOrEqual(2);
    expect(byReason.rate_limited).toBeGreaterThanOrEqual(2);
    expect(summary.body.by_key).toEqual(
      expect.arrayContaining([expect.objectContaining({ api_key_id: keyId, requests: 4 })]),
    );

    const list = await harness.agent.get(`/api/dashboard/governance/denials?period=1h&api_key_id=${keyId}`);
    expect(list.status).toBe(200);
    // Two refusals of the same key and reason in one minute are one row.
    // A minute boundary between requests can split a reason into two rows.
    expect(list.body.data.length).toBeGreaterThanOrEqual(2);
    expect(list.body.data.length).toBeLessThanOrEqual(4);
    const endpointRows = list.body.data.filter((row: { reason: string }) => row.reason === 'endpoint_not_allowed');
    expect(endpointRows.reduce((sum: number, row: { request_count: number }) => sum + row.request_count, 0)).toBe(2);
    expect(endpointRows[0]).toMatchObject({
      status_code: 403,
      api_key_name: `denial-probe-${unique}`,
      source_format: 'chat_completions',
      requested_model: 'auto',
    });

    const reasonFilter = await harness.agent.get(
      `/api/dashboard/governance/denials?period=1h&api_key_id=${keyId}&reason=rate_limited`,
    );
    expect(reasonFilter.body.data.every((row: { reason: string }) => row.reason === 'rate_limited')).toBe(true);

    // Content and credentials never reach the denial records.
    const payload = JSON.stringify([summary.body, list.body]);
    expect(payload).not.toContain(`secret prompt ${unique}`);
    expect(payload).not.toContain(secret);

    // Refusals are not call logs: success rates, routing samples and cost reports are unaffected.
    expect(await harness.callLogRepo.count()).toBe(callLogsBefore);
  });

  it('keeps denials inside the active workspace', async () => {
    const created = await harness.agent
      .post('/api/dashboard/workspaces')
      .send({ name: `Denial isolation ${Date.now()}` });
    expect(created.status).toBe(201);
    const workspaceId: string = created.body.item.id;

    const defaultSummary = await harness.agent.get('/api/dashboard/governance/denials/summary?period=1h');
    expect(defaultSummary.body.total).toBeGreaterThan(0);

    const otherSummary = await harness.agent
      .get('/api/dashboard/governance/denials/summary?period=1h')
      .set('x-siftgate-workspace-id', workspaceId);
    expect(otherSummary.status).toBe(200);
    expect(otherSummary.body.total).toBe(0);

    const otherList = await harness.agent
      .get('/api/dashboard/governance/denials?period=1h')
      .set('x-siftgate-workspace-id', workspaceId);
    expect(otherList.status).toBe(200);
    expect(otherList.body.data).toEqual([]);
  });
});

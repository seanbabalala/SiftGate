import { DataSource } from 'typeorm';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import { createE2EHarness, type E2EHarness, FIXTURE_PATH, API_KEY } from './setup';
import { applyPricingSchema } from '../../src/pricing/pricing-schema';
import { PricingRepository } from '../../src/pricing/pricing-repository';
import { tokenBook, tokens } from '../unit/pricing-fixtures';
import { DEFAULT_PRICING_LIMITS } from '../../src/config/pricing-limits';

describe('configured pricing capacity on isolated HTTP', () => {
  let harness: E2EHarness, directory: string, source: DataSource;
  const base = '/api/dashboard/pricing';
  const evidence = () => Object.values(tokens({ input_tokens: 1000, output_tokens: 0 }).quantities)
    .map(entry => ({ dimension: entry!.dimension, value: entry!.value }));
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'pricing-limits-http-'));
    const config = yaml.load(readFileSync(FIXTURE_PATH, 'utf8')) as Record<string, unknown>;
    config.server = { ...(config.server as Record<string, unknown>), host: '127.0.0.1', port: 0 };
    config.pricing_limits = { max_published_rules: 1, max_request_body_bytes: 4096 };
    const file = join(directory, 'config.yaml'); writeFileSync(file, yaml.dump(config));
    harness = await createE2EHarness(file);
    source = harness.app.get(DataSource); await applyPricingSchema(source);
  }, 30000);
  afterEach(async () => { jest.restoreAllMocks(); await harness?.close(); rmSync(directory, { recursive: true, force: true }); });

  it('reports effective limits and accepts an ordinary read-only quote', async () => {
    const status = await harness.agent.get(`${base}/status`);
    expect(status.status).toBe(200);
    expect(status.body.limits).toEqual({ ...DEFAULT_PRICING_LIMITS, max_published_rules: 1, max_request_body_bytes: 4096, request_size_basis: 'parsed_json_utf8' });
    const before = await source.query('SELECT * FROM budget_rules ORDER BY id');
    const quote = await harness.agent.post(`${base}/quote`).send({ content: tokenBook(), evidence: evidence() });
    expect(quote.status).toBe(201);
    expect(quote.body.cost.amount).toBe('0.001000000');
    expect(await source.query('SELECT * FROM budget_rules ORDER BY id')).toEqual(before);
    expect(await source.query('SELECT * FROM pricing_catalog_revisions')).toHaveLength(0);
    expect(harness.fetchMock.calls).toHaveLength(0);
  });

  it.each(['quote', 'batch/quote', 'calendar/preview', 'admission-preview', 'inheritance/preview', 'import/validate'])
    ('rejects oversized UTF-8 JSON before %s parses or computes it', async route => {
      const validate = jest.spyOn(harness.app.get(PricingRepository), 'validateDraftContent');
      const response = await harness.agent.post(`${base}/${route}`).send({ value: '界'.repeat(1500) });
      expect(response.status).toBe(413);
      expect(response.body.error).toMatchObject({ type: 'pricing_error', code: 'pricing_request_too_large' });
      expect(validate).not.toHaveBeenCalled();
      expect(await source.query('SELECT * FROM pricing_catalog_revisions')).toHaveLength(0);
      expect(await source.query('SELECT * FROM pricing_audit_events')).toHaveLength(0);
      expect(harness.fetchMock.calls).toHaveLength(0);
    });

  it('retains origin rejection and does not apply pricing-management size limits to model ingress', async () => {
    const denied = await harness.agent.post(`${base}/quote`).set('Origin', 'https://untrusted.invalid').send({ value: 'x'.repeat(5000) });
    expect(denied.status).toBe(403);
    const response = await harness.agent.post('/v1/chat/completions').set('Authorization', `Bearer ${API_KEY}`)
      .send({ model: 'gpt-4o', messages: [{ role: 'user', content: 'synthetic '.repeat(600) }] });
    expect(response.status).toBe(200);
    expect(harness.fetchMock.calls).toHaveLength(1);
  });

  it('rejects over-capacity preview and publication while retaining the previous catalog and draft', async () => {
    const first = await harness.agent.post(`${base}/books`).send({ name: 'First', content: tokenBook() });
    expect(first.status).toBe(201);
    const options = { draft_revision: 1, catalog_revision: 0, confirm: true, reason: 'Isolated capacity test', targets: [{ level: 'model', model: 'gpt-4o' }] };
    expect((await harness.agent.post(`${base}/drafts/${first.body.draft.id}/publish`).send(options)).status).toBe(201);
    const second = await harness.agent.post(`${base}/books`).send({ name: 'Second', content: tokenBook() });
    const next = { ...options, catalog_revision: 1, targets: [{ level: 'model', model: 'gpt-4o-mini' }] };
    const audits = await source.query('SELECT * FROM pricing_audit_events ORDER BY id');
    for (const action of ['preview-publication', 'publish']) {
      const result = await harness.agent.post(`${base}/drafts/${second.body.draft.id}/${action}`).send(next);
      expect(result.status).toBe(400);
      expect(result.body.error.code).toBe('pricing_capacity_exceeded');
    }
    expect((await harness.agent.get(`${base}/bindings`)).body.head.revision).toBe(1);
    expect((await harness.agent.get(`${base}/drafts/${second.body.draft.id}`)).status).toBe(200);
    expect(await source.query('SELECT * FROM pricing_book_versions')).toHaveLength(1);
    expect(await source.query('SELECT * FROM pricing_audit_events ORDER BY id')).toEqual(audits);
    expect(harness.fetchMock.calls).toHaveLength(0);
  });
});

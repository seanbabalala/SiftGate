import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { E2EHarness } from './setup';
import { DataSource } from 'typeorm';
import { cacheReferenceHarness, cacheReferenceState, runCacheReferenceScenario } from '../helpers/pricing-cache-reference-fixture';

describe('CALC19 cache accounting reference, actual HTTP, quote and report', () => {
  let directory: string, h: E2EHarness;
  beforeEach(async () => { directory = mkdtempSync(join(tmpdir(), 'cache-reference-')); h = await cacheReferenceHarness(directory); }, 30000);
  afterEach(async () => { await h?.close(); rmSync(directory, { recursive: true, force: true }); });
  it.each((['legacy_logical', 'actual_upstream'] as const).flatMap(mode => [{ mode, currency: 'USD', free: false }, { mode, currency: 'USD', free: true }, { mode, currency: 'CNY', free: false }]))('$mode $currency free=$free preserves zero supplier, budget basis and frozen hypothetical reference', async ({ mode, currency, free }) => {
    const result = await runCacheReferenceScenario(h, mode, currency, free);
    expect(result.provider_calls).toBe(1);
  });
  it('keeps a corrupted reference unknown without hiding zero supplier cost or modifying budgets during reads', async () => {
    const result = await runCacheReferenceScenario(h, 'actual_upstream'), db = h.app.get(DataSource);
    const rows = await db.query('SELECT * FROM pricing_reservations WHERE request_id = ?', [result.log.request_id]);
    const estimate = JSON.parse(rows[0].estimate_json); estimate.report_amount = '999';
    await db.createQueryBuilder().update('pricing_reservations').set({ estimate_json: JSON.stringify(estimate) }).where('id = :id', { id: rows[0].id }).execute();
    const before = await cacheReferenceState(h), response = await h.agent.get(`/api/dashboard/logs/${result.log.id}/cost-breakdown`);
    expect(response.status).toBe(200); expect(response.body).toMatchObject({ amount: '0.000000000000000000', local_cache_reference: { state: 'invalid_reference', reference_cost_usd: null, hypothetical_savings_usd: null } });
    expect(await cacheReferenceState(h)).toEqual(before);
  });
});

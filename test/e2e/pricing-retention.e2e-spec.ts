import { DataSource } from 'typeorm';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import { createE2EHarness, type E2EHarness, FIXTURE_PATH } from './setup';
import { DashboardController } from '../../src/dashboard/dashboard.controller';
import { CallLog } from '../../src/database/entities/call-log.entity';
import { PricingRepository } from '../../src/pricing/pricing-repository';
import { CostLedgerService } from '../../src/pricing/cost-ledger.service';
import { PricingRecoveryService } from '../../src/pricing/pricing-recovery.service';
import { applyPricingSchema, PRICING_TABLE_NAMES } from '../../src/pricing/pricing-schema';
import { tokenBook, tokens } from '../unit/pricing-fixtures';

const workspace = 'default-workspace';
const actor = { id: 'dashboard', workspace_id: workspace, role: 'admin' as const, global_admin: true };
const target = { node_id: 'mock-openai', model: 'gpt-4o' };

describe('historical pricing HTTP after real log cleanup', () => {
  let harness: E2EHarness, directory: string, source: DataSource;
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'pricing-retention-http-'));
    const config = yaml.load(readFileSync(FIXTURE_PATH, 'utf8')) as Record<string, unknown>;
    config.database = { ...(config.database as Record<string, unknown>), log_retention_days: 1 };
    const file = join(directory, 'config.yaml'); writeFileSync(file, yaml.dump(config));
    harness = await createE2EHarness(file);
    await harness.app.get(PricingRecoveryService).onModuleDestroy();
    source = harness.app.get(DataSource); await applyPricingSchema(source);
  }, 30000);
  afterEach(async () => { await harness?.close(); rmSync(directory, { recursive: true, force: true }); });
  async function snapshot() {
    const result: Record<string, string[]> = {};
    for (const table of [...PRICING_TABLE_NAMES, 'budget_rules']) {
      const rows: unknown[] = await source.query(`SELECT * FROM "${table}"`);
      result[table] = rows.map(row => JSON.stringify(row)).sort();
    }
    return result;
  }

  it('keeps request-cost/report/replay endpoints usable without rewriting the original amount', async () => {
    const prices = harness.app.get(PricingRepository), ledger = harness.app.get(CostLedgerService);
    const publication = (revision: number) => ({ draft_revision: 1, catalog_revision: revision, reason: 'Synthetic HTTP retention',
      confirm: true as const, targets: [{ level: 'model' as const, model: target.model }] });
    const first = await prices.createBook(actor, { name: 'Original', scope: 'workspace', content: tokenBook() });
    const published = await prices.publishDraft(actor, first.draft.id, publication(0));
    const frozen = (await prices.capture({ request_id: 'retained-http-request', workspace_id: workspace, report_currency: 'USD' }))!;
    const cost = frozen.quote(target, tokens({ input_tokens: 1000, output_tokens: 100 })).cost;
    await ledger.beginAttempt({ id: 'retained-http-attempt', requestId: 'retained-http-request', workspace, target,
      feeSource: 'provider', dispatchedAt: new Date().toISOString(), priceContext: { context: {}, legacyPrice: null } });
    await ledger.completeAttempt('retained-http-attempt', workspace, cost);
    const log = await source.getRepository(CallLog).save({ request_id: 'retained-http-request', workspace_id: workspace,
      timestamp: new Date(Date.now() - 2 * 86400000), source_format: 'chat_completions', node_id: target.node_id,
      model: target.model, tier: 'standard', score: 0, cost_usd: 99 });
    const nextContent = tokenBook();
    for (const rate of nextContent.groups[0].rules[0].rates) {
      if (rate.component.dimension === 'uncached_input_tokens') rate.component.amount = '2';
      if (rate.component.dimension === 'output_tokens') rate.component.amount = '4';
    }
    const next = await prices.createBook(actor, { name: 'Replacement', scope: 'workspace', content: nextContent });
    await prices.publishDraft(actor, next.draft.id, publication(1));
    const before = await snapshot();
    await (harness.app.get(DashboardController) as unknown as { cleanupOldLogs(): Promise<void> }).cleanupOldLogs();
    expect(await source.getRepository(CallLog).findOneBy({ id: log.id })).toBeNull();
    expect(await snapshot()).toEqual(before);
    const detail = await harness.agent.get('/api/dashboard/pricing/requests/retained-http-request/cost');
    expect(detail.status).toBe(200); expect(detail.body.amount).toBe('0.001200000000000000');
    expect((await harness.agent.get(`/api/dashboard/logs/${log.id}/cost-breakdown`)).status).toBe(404);
    const report = await harness.agent.get('/api/dashboard/pricing/cost-report').query({
      from: new Date(Date.now() - 86400000).toISOString(), to: new Date(Date.now() + 60000).toISOString(), limit: '20',
    });
    expect(report.status).toBe(200);
    expect(report.body.rows).toEqual([expect.objectContaining({ request_id: 'retained-http-request', log_id: null,
      status: 'priced', basis: 'immutable_ledger', amount_usd: '0.001200000000000000', legacy_estimate_usd: null })]);
    const version = await harness.agent.get(`/api/dashboard/pricing/books/${first.book.id}/versions/${published.version_id}`);
    expect(version.status).toBe(200); expect(version.body.content_hash).toBe(published.content_hash);
    const replay = await harness.agent.post('/api/dashboard/pricing/replay').send({ request_ids: ['retained-http-request'], content: nextContent });
    expect(replay.status).toBe(201);
    expect(replay.body).toMatchObject({ simulation: true, historical_records_modified: false });
    expect(replay.body.results[0].original.amount).toBe('0.001200000000000000');
    expect(replay.body.results[0].simulations[0].simulated.amount).toBe('0.002400000');
    expect(await snapshot()).toEqual(before);
    expect(harness.fetchMock.calls).toHaveLength(0);
  });
});

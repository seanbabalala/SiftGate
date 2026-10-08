import { DataSource } from 'typeorm';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import { createE2EHarness, type E2EHarness, FIXTURE_PATH, API_KEY } from './setup';
import { PricingRepository } from '../../src/pricing/pricing-repository';
import { CostLedgerService } from '../../src/pricing/cost-ledger.service';
import { PipelineService } from '../../src/pipeline/pipeline.service';
import { BudgetRule } from '../../src/database/entities/budget-rule.entity';
import { applyPricingSchema } from '../../src/pricing/pricing-schema';
import { tokenBook } from '../unit/pricing-fixtures';

describe('SQLite receipt composition through actual HTTP', () => {
  let harness: E2EHarness, directory: string, source: DataSource, ledger: CostLedgerService;
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'sqlite-receipt-http-'));
    const config = yaml.load(readFileSync(FIXTURE_PATH, 'utf8')) as Record<string, unknown>;
    config.budget = { daily_token_limit: 10000000, daily_cost_limit: 1000, alert_threshold: .8 };
    config.cache = { enabled: false };
    const file = join(directory, 'gateway.yaml'); writeFileSync(file, yaml.dump(config));
    harness = await createE2EHarness(file); source = harness.app.get(DataSource);
    expect(source.options.type).toBe('better-sqlite3'); await applyPricingSchema(source);
    ledger = harness.app.get(CostLedgerService);
    const prices = harness.app.get(PricingRepository);
    const actor = { id: 'synthetic-sqlite-receipt-admin', workspace_id: 'default-workspace', role: 'admin' as const, global_admin: true };
    const book = await prices.createBook(actor, { name: 'Synthetic receipt composition', scope: 'workspace', content: tokenBook() });
    await prices.publishDraft(actor, book.draft.id, { draft_revision: 1, catalog_revision: 0, reason: 'Isolated SQLite test', confirm: true, targets: [{ level: 'model', model: 'gpt-4o' }] });
    harness.fetchMock.reset();
    harness.fetchMock.setHandler(async () => Response.json({ id: 'synthetic-receipt', model: 'gpt-4o',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Synthetic response' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1000, completion_tokens: 500, prompt_tokens_details: { cached_tokens: 0 }, cache_creation_input_tokens: 0 },
    }));
  }, 30000);
  afterEach(async () => { jest.restoreAllMocks(); await harness?.close(); if (directory) rmSync(directory, { recursive: true, force: true }); });
  const call = (text = 'synthetic first request') => harness.agent.post('/v1/chat/completions')
    .set('Authorization', `Bearer ${API_KEY}`).send({ model: 'gpt-4o', max_tokens: 20, messages: [{ role: 'user', content: text }] });
  async function expense() {
    const attempts = await source.query('SELECT request_id,state,cost_json FROM pricing_attempts');
    expect(attempts).toHaveLength(1); expect(attempts[0].state).toBe('terminal');
    expect(JSON.parse(attempts[0].cost_json)).toMatchObject({ status: 'priced', amount: '0.002000000', report_amount: '0.002000000' });
    expect((await ledger.summary(attempts[0].request_id, 'default-workspace'))?.known_subtotal).toBe('0.002000000000000000');
    expect(harness.fetchMock.calls.filter(row => row.method === 'POST' && row.url.includes('/chat/completions'))).toHaveLength(1);
  }

  it('retains both bodies before one receipt-and-budget application without separate attempt delivery', async () => {
    const prepare = jest.spyOn(ledger, 'prepareRuntimeReceipt'), separate = jest.spyOn(ledger, 'completeAttempt');
    const internal = ledger as unknown as { applyRuntimeSettlement(...args: unknown[]): Promise<void> };
    const original = internal.applyRuntimeSettlement.bind(ledger);
    let boundary: Array<{ type: string; state: string }> | undefined;
    jest.spyOn(internal, 'applyRuntimeSettlement').mockImplementation(async (...args) => {
      boundary = (await source.query('SELECT outcome_json,state FROM pricing_runtime_outcomes'))
        .map((row: { outcome_json: string; state: string }) => ({ type: JSON.parse(row.outcome_json).type as string, state: row.state }))
        .sort((a: { type: string }, b: { type: string }) => a.type.localeCompare(b.type));
      return original(...args);
    });
    expect((await call()).status).toBe(200); await expense();
    expect(prepare).toHaveBeenCalledTimes(1); expect(separate).not.toHaveBeenCalled();
    expect(boundary).toEqual([{ type: 'attempt', state: 'pending' }, { type: 'settlement', state: 'pending' }]);
    expect(await source.query("SELECT state FROM pricing_runtime_outcomes")).toEqual([{ state: 'delivered' }, { state: 'delivered' }]);
    expect(await source.query("SELECT * FROM pricing_budget_effects WHERE kind='commit'")).toHaveLength(1);
  });

  it('makes the actual expense above its reservation visible before the next HTTP admission', async () => {
    await source.getRepository(BudgetRule).update({ type: 'daily_cost' }, { limit_value: .0015 });
    expect((await call()).status).toBe(200); await expense();
    expect(await source.query("SELECT b.amount_decimal FROM pricing_budget_balances b JOIN budget_rules r ON r.id=b.rule_id WHERE r.type='daily_cost'"))
      .toEqual([{ amount_decimal: '0.002000000000000000' }]);
    const next = await call('synthetic next request'); expect(next.status).toBe(429); expect(next.body.error.type).toBe('budget_exceeded');
    await expense(); expect(await source.query("SELECT * FROM pricing_budget_effects WHERE kind='commit'")).toHaveLength(1);
  });

  it('drains its retained receipt after local response postprocessing fails without redispatch', async () => {
    const pipeline = harness.app.get(PipelineService) as unknown as { denormalizeForClient(...args: unknown[]): unknown };
    jest.spyOn(pipeline, 'denormalizeForClient').mockImplementation(() => { throw new Error('Synthetic local postprocess failure'); });
    const result = await call(); expect(result.status).toBeGreaterThanOrEqual(400);
    await expense(); expect((await source.query('SELECT state FROM pricing_runtime_outcomes')).every((row: { state: string }) => row.state === 'delivered')).toBe(true);
  });
});

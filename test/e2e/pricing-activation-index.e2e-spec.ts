import { DataSource } from 'typeorm';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import { createE2EHarness, type E2EHarness, FIXTURE_PATH, API_KEY } from './setup';
import { applyPricingSchema } from '../../src/pricing/pricing-schema';
import { PricingRepository } from '../../src/pricing/pricing-repository';
import { PricingRuntimeService } from '../../src/pricing/pricing-runtime.service';
import { PricingRecoveryService } from '../../src/pricing/pricing-recovery.service';
import { CostLedgerService } from '../../src/pricing/cost-ledger.service';
import { pricingBypassAuditId } from '../../src/pricing/pricing-bypass';
import * as admissionClock from '../../src/pricing/pricing-admission-clock';
import { tokenBook } from '../unit/pricing-fixtures';

const base = '/api/dashboard/pricing', workspace = 'default-workspace';
let start: number;
const instant = (offset: number) => new Date(start + offset).toISOString();

describe('indexed activation admission through actual JSON and SSE requests', () => {
  let h: E2EHarness, directory: string, db: DataSource, admittedAt: number;
  beforeEach(async () => {

    directory = mkdtempSync(join(tmpdir(), 'activation-index-http-'));
    const config = yaml.load(readFileSync(FIXTURE_PATH, 'utf8')) as Record<string, unknown>;
    config.cache = { enabled: false }; config.semantic_cache = { enabled: false };
    config.budget = { daily_token_limit: 10000000, daily_cost_limit: 1000, alert_threshold: .8 };
    const file = join(directory, 'config.yaml'); writeFileSync(file, yaml.dump(config));
    h = await createE2EHarness(file); db = h.app.get(DataSource);
    await h.app.get(PricingRecoveryService).onModuleDestroy(); await applyPricingSchema(db);
    start = Date.now() + 60000; admittedAt = start;
    // Change only the pricing admission clock, not TypeORM's Date constructor identity.
    jest.spyOn(admissionClock, 'readPricingAdmissionTime').mockImplementation(() => new Date(admittedAt));
  }, 30000);
  afterEach(async () => {
    try { jest.restoreAllMocks(); await h?.app.get(PricingRuntimeService).waitForRequests(); await h?.close(); }
    finally { if (directory) rmSync(directory, { recursive: true, force: true }); }
  });

  it.each([false, true].flatMap(stream => (['workspace', 'global'] as const).map(scope => ({ stream, scope }))))
    ('preserves scoped activation, expiry and compatibility bypass (stream=$stream, scope=$scope)', async ({ stream, scope }) => {
      const prices = h.app.get(PricingRepository);
      const foreign = { id: 'synthetic-foreign-admin', workspace_id: 'foreign-workspace', role: 'admin' as const, global_admin: false };
      const foreignBook = await prices.createBook(foreign, { name: 'Foreign active only', scope: 'workspace', content: tokenBook() });
      await prices.publishDraft(foreign, foreignBook.draft.id, { draft_revision: 1, catalog_revision: 0, reason: 'Synthetic scope control', confirm: true, targets: [{ level: 'model', model: 'gpt-4o' }] });
      const publish = async (name: string, model: string, from: number, to: number) => {
        const created = await h.agent.post(`${base}/books`).send({ name, content: tokenBook(), scope });
        expect(created.status).toBe(201);
        const head = (await h.agent.get(`${base}/bindings`)).body.head;
        const reply = await h.agent.post(`${base}/drafts/${created.body.draft.id}/publish`).send({ draft_revision: 1, catalog_revision: head.revision, effective_from: instant(from), effective_to: instant(to), confirm: true, reason: 'Synthetic interval fixture', targets: [{ level: 'model', model }] });
        expect(reply.status).toBe(201); return reply.body.version_id as string;
      };
      const version = await publish('Matching interval', 'gpt-4o', 1000, 2000);
      const unrelated = await publish('Other model interval', 'gpt-4o-mini', 4000, 5000);
      const versions = await db.query('SELECT * FROM pricing_book_versions');
      const catalogs = await db.query('SELECT * FROM pricing_catalog_revisions');
      h.fetchMock.setHandler(async () => {
        const usage = { prompt_tokens: 1000, completion_tokens: 500, prompt_tokens_details: { cached_tokens: 0 }, cache_creation_input_tokens: 0 };
        const response = { id: 'synthetic-activation', model: 'gpt-4o', choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }], usage };
        return stream ? new Response(`data: ${JSON.stringify({ ...response, choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } }) : Response.json(response);
      });
      const originals: Array<{ request: string; cost: string }> = [];
      for (const [offset, active] of [[999, false], [1000, true], [1999, true], [2000, false], [4000, true], [5000, false]] as const) {
        admittedAt = start + offset;
        const response = await h.agent.post('/v1/chat/completions').set('Authorization', `Bearer ${API_KEY}`).send({ model: 'gpt-4o', max_tokens: 500, stream, messages: [{ role: 'user', content: `Synthetic activation ${offset}` }] });
        expect(response.status).toBe(200); await h.app.get(PricingRuntimeService).waitForRequests();
        const log = await h.callLogRepo.findOne({ where: {}, order: { id: 'DESC' } }); expect(log).not.toBeNull();
        const requestId = log!.request_id!, frozen = await prices.restoreRequest(requestId, workspace);
        expect(frozen.hasBindings()).toBe(active);
        const bypass = await db.createQueryBuilder().select('a.*').from('pricing_audit_events', 'a').where('a.id = :id', { id: pricingBypassAuditId(workspace, requestId) }).getRawOne();
        if (!active) {
          expect(bypass).toMatchObject({ workspace_id: workspace, reason: 'no_active_bindings' });
          expect(await db.createQueryBuilder().select('r.id').from('pricing_reservations', 'r').where('r.request_id = :id', { id: requestId }).getRawMany()).toEqual([]);
        } else {
          expect(bypass).toBeUndefined();
          const summary = await h.app.get(CostLedgerService).summary(requestId, workspace); expect(summary?.attempts).toHaveLength(1);
          const cost = summary!.attempts[0].cost!;
          if (offset < 2000) { expect(cost.version_id).toBe(version); expect(cost.amount).toBe('0.002000000'); }
          else { expect(cost.version_id).not.toBe(unrelated); expect(cost.status).toBe('legacy_estimate'); }
          originals.push({ request: requestId, cost: JSON.stringify(cost) });
        }
        for (const saved of originals) {
          const old = await h.app.get(CostLedgerService).summary(saved.request, workspace);
          expect(JSON.stringify(old!.attempts[0].cost)).toBe(saved.cost);
        }
      }
      expect(h.fetchMock.calls).toHaveLength(6);
      expect(await db.query('SELECT * FROM pricing_book_versions')).toEqual(versions);
      expect(await db.query('SELECT * FROM pricing_catalog_revisions')).toEqual(catalogs);
      expect((await db.query("SELECT current_value FROM budget_rules WHERE type = 'daily_tokens'"))[0].current_value).toBe(9000);
      expect(await db.query('SELECT * FROM pricing_request_snapshots')).toHaveLength(6);
      expect(await db.query('SELECT * FROM pricing_reservations')).toHaveLength(3);
    });
});

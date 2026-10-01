import { pricingContentHash } from '../../src/pricing/pricing-json';
import { DataSource } from "typeorm";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { BudgetService } from "../../src/budget/budget.service";
import { BudgetRule, CallLog, RouteDecisionLog } from "../../src/database/entities";
import { WorkspaceContextService } from "../../src/workspaces/workspace-context.service";
import { CostLedgerService } from "../../src/pricing/cost-ledger.service";
import { PricingRepository } from "../../src/pricing/pricing-repository";
import { RealtimePricingService } from "../../src/pricing/realtime-pricing.service";
import { applyPricingSchema } from "../../src/pricing/pricing-schema";
import * as inbox from "../../src/pricing/pricing-outcome-inbox";
import { mockConfigService } from "../helpers";
import { book, rate } from "./pricing-fixtures";
import { asrActor, asrKey, asrModel, asrWorkspace as workspace, realtimeModel, configureAsrFixture, observeAsrFixture, asrReceipt } from "../helpers/realtime-transcription-fixture";
import { runRealtimePriceLifecycle, realtimeLifecycleCases, type RealtimeLifecycleAdmin } from "../helpers/realtime-price-lifecycle";

const entities = [BudgetRule, CallLog, RouteDecisionLog];
function contract(label: string, connect: () => Promise<{ db: DataSource; cleanup: () => Promise<void> }>, run = describe) {
  run(label, () => {
    let db: DataSource, cleanup: () => Promise<void>, prices: PricingRepository, ledger: CostLedgerService, service: RealtimePricingService;
    const makeLedger = (source = db) => new CostLedgerService(source, new BudgetService(mockConfigService(), new WorkspaceContextService(), source.getRepository(BudgetRule)));
    beforeEach(async () => {
      ({ db, cleanup } = await connect()); await applyPricingSchema(db);
      await db.getRepository(BudgetRule).save([
        { workspace_id: workspace, type: "daily_cost", limit_value: 100, current_value: 0, alert_threshold: 0.8, period_start: new Date(), is_active: true },
        { workspace_id: workspace, type: "daily_tokens", limit_value: 100000, current_value: 0, alert_threshold: 0.8, period_start: new Date(), is_active: true },
      ]);
      prices = new PricingRepository(db); ledger = makeLedger(); service = new RealtimePricingService(prices, ledger);
    });
    afterEach(async () => { jest.restoreAllMocks(); if (db?.isInitialized) await db.destroy(); await cleanup?.(); });
    const begin = (id = "asr-request") => service.begin(id, asrKey, "node", realtimeModel, 60000);
    const asrHold = async () => (await db.query("SELECT * FROM pricing_reservations") as Array<{ id: string; target_json: string; holds_json: string; reserved_tokens: string }>).find(row => JSON.parse(row.target_json).model === asrModel)!;

    const lifecycleAdmin = (): RealtimeLifecycleAdmin => ({
      async publish(model, operation, content) {
        const created = await prices.createBook(asrActor, { name: 'Synthetic lifecycle ' + model, scope: 'workspace', content });
        return (await prices.publishDraft(asrActor, created.draft.id, { draft_revision: 1, catalog_revision: (await prices.listBindings(asrActor)).head.revision,
          ...(content.time_basis && content.time_basis !== 'attempt_dispatched_at' ? { time_basis_confirmation: { basis: content.time_basis, content_hash: pricingContentHash(content), reference: 'SYNTHETIC-TIMING-CONTRACT', confirmed: true as const } } : {}), reason: 'Synthetic lifecycle', confirm: true, targets: [{ level: 'model', model, operation }] })).version_id;
      },
      async fx(denominator) {
        await prices.updateFx(asrActor, { catalog_revision: (await prices.listBindings(asrActor)).head.revision, scope: 'workspace', reason: 'Synthetic lifecycle FX', confirm: true,
          versions: denominator ? [{ fx: { version_id: 'synthetic-input-only', from_currency: 'CNY', to_currency: 'USD', numerator: '1', denominator, effective_at: '2020-01-01T00:00:00.000Z', source: 'Synthetic FX' } }] : [] });
        return (await prices.listBindings(asrActor)).fx_versions[0]?.fx.version_id ?? null;
      },
      async policy(operation, policy) {
        await prices.updateAdmissionPolicy(asrActor, { catalog_revision: (await prices.listBindings(asrActor)).head.revision, scope: 'workspace', operation, reason: 'Synthetic lifecycle limits', confirm: true, policy });
      },
    });

    it.each(realtimeLifecycleCases)('pins both models, FX and observation-time calendars across publication and cold replay (duration=$duration,actual=$actual,calendar=$calendar)', async ({ duration, actual, calendar }) => {
      const result = await runRealtimePriceLifecycle(lifecycleAdmin(), service, ledger, asrKey, 'node', duration, actual, false, calendar);
      const before = await db.query('SELECT * FROM pricing_budget_effects ORDER BY id');
      const connection = await new DataSource({ ...db.options, synchronize: false }).initialize();
      try {
        const restored = makeLedger(connection);
        await restored.replayRuntimeOutcomes(new Date(Date.now() + 600000)); await restored.reconcilePending(); await restored.reconcileActualBudgets();
        expect(await restored.summary('lifecycle-old', workspace)).toEqual(result.first);
        expect(await restored.summary('lifecycle-new', workspace)).toEqual(result.second);
        expect(await connection.query('SELECT * FROM pricing_budget_effects ORDER BY id')).toEqual(before);
        const holds = await connection.query('SELECT state FROM pricing_reservations') as Array<{ state: string }>;
        expect(holds.every(row => row.state === 'committed')).toBe(!calendar);
        if (calendar) expect(holds.some(row => row.state === 'reserved')).toBe(true);
      } finally { await connection.destroy(); }
    });

    it.each([false, true])('retains the old FX when current FX is removed, but refuses a new strict session (duration=%s)', async duration => {
      const result = await runRealtimePriceLifecycle(lifecycleAdmin(), service, ledger, asrKey, 'node', duration, true, true);
      expect(result.second).toBeNull();
      expect(await db.query("SELECT * FROM pricing_reservations WHERE request_id = 'lifecycle-new'")).toHaveLength(0);
      expect(await db.query("SELECT * FROM pricing_attempts WHERE request_id = 'lifecycle-new'")).toHaveLength(0);
      expect(await ledger.summary('lifecycle-old', workspace)).toEqual(result.first);
    });

    it.each([false, true].flatMap(duration => ["receipt-retained", "closure-retained", "closed", "missing"].map(mode => ({ duration, mode }))))("replays only durable ASR authority after actual child exit at $mode (duration=$duration)", async ({ duration, mode }) => {
      await configureAsrFixture(prices, duration);
      const child = spawnSync(process.execPath, ["-r", require.resolve("ts-node/register"), require.resolve("../helpers/realtime-transcription-crash-child")], {
        cwd: process.cwd(), env: { HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, PATH: process.env.PATH, NODE_OPTIONS: "--max-old-space-size=512", TS_NODE_TRANSPILE_ONLY: "true",
          PRICING_CHILD_DB: JSON.stringify(db.options), PRICING_CHILD_MODE: mode, PRICING_CHILD_DURATION: String(duration) }, encoding: "utf8", timeout: 20000,
      });
      expect({ status: child.status, signal: child.signal, error: child.error?.message, stderr: child.stderr }).toEqual({ status: 19, signal: null, error: undefined, stderr: "" });
      expect(JSON.parse(child.stdout.trim())).toMatchObject({ checkpoint: mode, database: db.options.type, duration, supplier_calls: 0 });
      const original = await db.query("SELECT * FROM pricing_attempts WHERE fee_source='provider' ORDER BY id");
      const connection = await new DataSource({ ...db.options, synchronize: false }).initialize();
      try {
        const restored = makeLedger(connection);
        await restored.replayRuntimeOutcomes(new Date(Date.now() + 120000)); await restored.reconcilePending(); await restored.reconcileActualBudgets();
        const result = (await restored.summary("crash-asr", workspace))!;
        const complete = mode === "closure-retained" || mode === "closed", charge = duration ? "0.640000000000000000" : "0.031000000000000000";
        expect(result.budget_committed_usd).toBe(complete ? charge : "0.000000000000000000");
        expect(result.amount).toBe(complete ? charge : null);
        expect(result.known_subtotal).toBe(mode === "missing" ? "0.000000000000000000" : charge);
        expect(result.reservations.find(row => row.id === (original.find((row: { model: string }) => row.model === asrModel)?.reservation_id))!.state).toBe(complete ? "committed" : "reserved");
        expect(JSON.stringify(result)).not.toContain("PRIVATE");
        const effects = await connection.query("SELECT * FROM pricing_budget_effects ORDER BY id");
        await restored.replayRuntimeOutcomes(new Date(Date.now() + 240000)); await restored.reconcileActualBudgets();
        expect(await restored.summary("crash-asr", workspace)).toEqual(result);
        expect(await connection.query("SELECT * FROM pricing_budget_effects ORDER BY id")).toEqual(effects);
        expect(await connection.query("SELECT * FROM pricing_attempts WHERE fee_source='provider' ORDER BY id")).toEqual(original);
      } finally { await connection.destroy(); }
    }, 30000);

    it("rolls the ASR debit and closure acknowledgement back together, then recovers from a fresh connection", async () => {
      await configureAsrFixture(prices); const handle = (await begin())!; await observeAsrFixture(handle, false);
      const hold = await asrHold(), transition = inbox.transitionRuntimeOutcome;
      const fault = jest.spyOn(inbox, "transitionRuntimeOutcome").mockImplementation(async (...args) => {
        if (args[1].kind === "actual_budget_closure" && args[1].reservation_id === hold.id && args[2] === "delivered") throw new Error("Synthetic ASR acknowledgement failure");
        return transition(...args);
      });
      await handle.close(false); fault.mockRestore();
      expect((await ledger.summary("asr-request", workspace))!.budget_committed_usd).toBe("0.000000000000000000");
      expect((await ledger.summary("asr-request", workspace))!.reservations.find(row => row.id === hold.id)!.state).toBe("reserved");
      const connection = await new DataSource({ ...db.options, synchronize: false }).initialize();
      try {
        const restored = makeLedger(connection); await restored.replayRuntimeOutcomes(new Date(Date.now() + 120000));
        expect((await restored.summary("asr-request", workspace))!.budget_committed_usd).toBe("0.031000000000000000");
        const before = await connection.query("SELECT * FROM budget_rules ORDER BY id");
        await restored.replayRuntimeOutcomes(new Date(Date.now() + 240000)); expect(await connection.query("SELECT * FROM budget_rules ORDER BY id")).toEqual(before);
      } finally { await connection.destroy(); }
    });

    it("keeps token ASR scoped to its own token allowance beside an explicitly token-exempt Realtime tariff", async () => {
      await configureAsrFixture(prices, false, true); const handle = (await begin())!;
      const hold = await asrHold(); expect(hold.reserved_tokens).toBe("240");
      expect(JSON.parse(hold.holds_json).some((row: { type: string }) => row.type === "daily_tokens")).toBe(true);
      await observeAsrFixture(handle, false); await handle.close(false);
      const result = (await ledger.summary("asr-request", workspace))!;
      expect(result.budget_committed_usd).toBe("0.031000000000000000");
      expect(result.reservations.find(row => row.id === hold.id)!.committed_tokens).toBe("22");
      expect(result.reservations.find(row => row.id !== hold.id)!.committed_tokens).toBe("0");
    });

    it("corrects confirmed ASR expense under its original tariff and budget epoch with atomic audit and idempotent replay", async () => {
      const version = await configureAsrFixture(prices); const handle = (await begin())!; await observeAsrFixture(handle, false); await handle.close(false);
      const original = (await ledger.summary("asr-request", workspace))!, attempt = original.attempts.find(row => row.model === asrModel && row.fee_source === "provider")!;
      const later = await prices.createBook(asrActor, { name: "Synthetic later ASR rate", scope: "workspace", content: book([rate("input", "uncached_input_tokens", "99", "1"), rate("output", "output_tokens", "99", "1")]) });
      await prices.publishDraft(asrActor, later.draft.id, { draft_revision: 1, catalog_revision: (await prices.listBindings(asrActor)).head.revision, reason: "Synthetic new price", confirm: true, targets: [{ level: "model", model: asrModel, operation: "audio_transcription" }] });
      const snapshot = await new PricingRepository(db).restoreRequest("asr-request", workspace);
      const cost = snapshot.quote({ node_id: "node", model: asrModel, operation: "audio_transcription" }, asrReceipt(false, 6).transcription!.usage, { attempt_dispatched_at: attempt.dispatched_at, time_estimated: true, media: { operation: "audio_transcription", audio_direction: "input" } }).cost;
      expect(cost.version_id).toBe(version); expect(cost.report_amount).toBe("0.024000000");
      const input = { id: "asr-confirmed-correction", attemptId: attempt.id, workspace, expectedCostHash: attempt.cost_hash!, cost, actorId: asrActor.id, reason: "Synthetic provider-confirmed ASR correction", source: "provider_usage" as const };
      await expect(ledger.adjustAttempt({ ...input, workspace: "foreign-workspace" })).rejects.toMatchObject({ status: 404 });
      await db.getRepository(BudgetRule).update({ workspace_id: workspace }, { current_value: 5, period_start: new Date(Date.now() + 86400000) });
      const active = await db.query("SELECT * FROM budget_rules ORDER BY id"), originalAttempts = await db.query("SELECT * FROM pricing_attempts ORDER BY id");
      const fault = jest.spyOn(ledger as unknown as { auditAdjustment: (...args: unknown[]) => Promise<void> }, "auditAdjustment").mockRejectedValueOnce(new Error("Synthetic ASR audit failure"));
      await expect(ledger.adjustAttempt(input)).rejects.toThrow("ASR audit failure"); fault.mockRestore();
      expect(await db.query("SELECT * FROM pricing_cost_adjustments")).toHaveLength(0);
      expect(await db.query("SELECT * FROM budget_rules ORDER BY id")).toEqual(active);
      const corrected = await ledger.adjustAttempt(input); expect(corrected.application.cost_delta).toBe("-0.007000000000000000");
      expect(await makeLedger().adjustAttempt(input)).toEqual(corrected);
      await makeLedger().replayRuntimeOutcomes(new Date(Date.now() + 120000)); await makeLedger().reconcileActualBudgets();
      expect((await makeLedger().summary("asr-request", workspace))!.budget_committed_usd).toBe("0.024000000000000000");
      expect(await db.query("SELECT * FROM budget_rules ORDER BY id")).toEqual(active);
      expect(await db.query("SELECT * FROM pricing_attempts ORDER BY id")).toEqual(originalAttempts);
    });
  });
}

contract("SQLite independent Realtime ASR ledger", async () => {
  const dir = mkdtempSync(join(tmpdir(), "realtime-asr-"));
  const db = await new DataSource({ type: "better-sqlite3", database: join(dir, "test.sqlite"), synchronize: true, entities }).initialize();
  await db.query("PRAGMA journal_mode=WAL"); await db.query("PRAGMA synchronous=FULL");
  return { db, cleanup: async () => rmSync(dir, { recursive: true, force: true }) };
});
const pg = process.env.SIFTGATE_PRICING_TEST_POSTGRES_URL;
if (pg && (new URL(pg).hostname !== "127.0.0.1" || new URL(pg).port === "2099" || !/^\/pricing_goal_[a-z0-9_]+$/.test(new URL(pg).pathname))) throw Error("Private PostgreSQL only");
contract("PostgreSQL independent Realtime ASR ledger", async () => {
  if (!pg) throw Error("Private PostgreSQL required");
  const schema = `realtime_asr_${process.pid}_${Math.random().toString(16).slice(2)}`, admin = await new DataSource({ type: "postgres", url: pg, synchronize: false }).initialize();
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const db = await new DataSource({ type: "postgres", url: pg, schema, extra: { max: 2, options: `-c search_path=${schema}` }, synchronize: true, entities }).initialize();
  return { db, cleanup: async () => { try { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await admin.destroy(); } } };
}, pg ? describe : describe.skip);

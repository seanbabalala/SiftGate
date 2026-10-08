import { DataSource } from "typeorm";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BudgetRule } from "../../src/database/entities/budget-rule.entity";
import { BudgetService } from "../../src/budget/budget.service";
import { WorkspaceContextService } from "../../src/workspaces/workspace-context.service";
import { CostLedgerService } from "../../src/pricing/cost-ledger.service";
import { PricingRepository } from "../../src/pricing/pricing-repository";
import { applyPricingSchema } from "../../src/pricing/pricing-schema";
import { normalizeQuantities } from "../../src/pricing/usage-normalizer";
import type { BillableDimension } from "../../src/pricing/pricing.types";
import { mockConfigService } from "../helpers";
import { book, rate } from "./pricing-fixtures";

const workspace = "default-workspace", actor = { id: "synthetic-admin", role: "admin" as const, workspace_id: workspace, global_admin: true };
const identity = { workspaceId: workspace, apiKeyId: null, apiKeyName: null, namespaceId: null, teamId: null };
const operations = ["audio_transcription", "audio_translation", "audio_speech", "rerank"] as const;
const dimension = (operation: string): BillableDimension => operation === "rerank" ? "rerank_search_units" : operation === "audio_speech" ? "text_characters" : "audio_input_seconds";
function contract(label: string, connect: () => Promise<{ source: DataSource; cleanup: () => Promise<void> }>, run = describe) {
  run(label, () => {
    let source: DataSource, prices: PricingRepository, ledger: CostLedgerService, cleanup: () => Promise<void>;
    const fresh = () => new CostLedgerService(source, new BudgetService(mockConfigService(), new WorkspaceContextService(), source.getRepository(BudgetRule)));
    beforeEach(async () => {
      ({ source, cleanup } = await connect()); await applyPricingSchema(source); prices = new PricingRepository(source); ledger = fresh();
      await source.getRepository(BudgetRule).save([
        { workspace_id: workspace, type: "daily_cost", limit_value: 1000, current_value: 0, alert_threshold: 0.8, period_start: new Date(), is_active: true },
        { workspace_id: workspace, type: "daily_tokens", limit_value: 1000000, current_value: 0, alert_threshold: 0.8, period_start: new Date(), is_active: true },
      ]);
    });
    afterEach(async () => { jest.restoreAllMocks(); if (source?.isInitialized) await source.destroy(); await cleanup?.(); });
    async function seed(operation: string, requireTokens = false) {
      const target = { node_id: "synthetic-node", model: "synthetic-model", operation };
      const created = await prices.createBook(actor, { name: "Synthetic quantity", scope: "workspace", content: book([rate("quantity", dimension(operation), "0.01", "1")]) });
      await prices.publishDraft(actor, created.draft.id, { catalog_revision: 0, draft_revision: 1, reason: "Synthetic quantity fixture", confirm: true, targets: [{ level: "model", model: target.model, operation }] });
      await prices.updateAdmissionPolicy(actor, { catalog_revision: 1, scope: "workspace", operation, reason: "Explicit synthetic quota", confirm: true, policy: { mode: "compatibility", budget_basis: "actual_upstream", token_budget: requireTokens ? "reported_tokens" : "not_applicable" } });
      const snapshot = (await prices.capture({ request_id: "request", workspace_id: workspace, report_currency: "USD" }))!;
      const usage = (value: string | null) => normalizeQuantities([{ dimension: dimension(operation), value }], { adapter_id: "synthetic-quantity-receipt", adapter_version: "1", source: "provider_usage" });
      const cost = (value: string | null) => snapshot.quote(target, usage(value)).cost;
      await ledger.reserve({ id: "reservation", requestId: "request", identity, target, tokens: "0", costUsd: "0.1", estimate: cost("10"), budgetBasis: "actual_upstream", leaseOwner: "synthetic-owner", leaseUntil: new Date(Date.now() + 60000).toISOString() });
      for (const id of ["a", "b"]) await ledger.beginAttempt({ id, requestId: "request", workspace, reservationId: "reservation", target, feeSource: "provider", dispatchedAt: new Date().toISOString(), priceContext: { context: {}, legacyPrice: null } });
      const receipt = (id: string, value: string | null, errorCode: string | null = null) => ledger.persistRuntimeOutcome({ type: "attempt", workspace, reservationId: "reservation", attemptId: id, cost: cost(value), errorCode });
      const close = () => ledger.persistRuntimeOutcome({ type: "actual_budget_closure", workspace, reservationId: "reservation", payload: { attempt_ids: ["a", "b"], receipts: [], missing_dispatch_evidence: false } });
      return { target, snapshot, cost, receipt, close };
    }
    it.each(operations)("settles both paid %s attempts without token holds and replays exactly once", async operation => {
      const fixture = await seed(operation); await fixture.receipt("a", "2", "http_error"); await fixture.receipt("b", "3"); await fixture.close();
      const first = await ledger.summary("request", workspace); expect(first?.budget_committed_usd).toBe("0.050000000000000000");
      const reservation = (await source.query("SELECT * FROM pricing_reservations"))[0]; expect(JSON.parse(reservation.holds_json).map((r: { type: string }) => r.type)).toEqual(["daily_cost"]);
      const effects = await source.query("SELECT * FROM pricing_budget_effects ORDER BY id");
      await fresh().replayRuntimeOutcomes(new Date(Date.now() + 120000)); await fixture.close();
      expect(await source.query("SELECT * FROM pricing_budget_effects ORDER BY id")).toEqual(effects);
    });
    it.each(operations)("preserves required token evidence for %s instead of silently exempting an existing policy", async operation => {
      const fixture = await seed(operation, true); await fixture.receipt("a", "2", "http_error"); await fixture.receipt("b", "3"); await fixture.close();
      expect((await source.query("SELECT * FROM pricing_reservations"))[0].state).toBe("reserved");
      expect(await fresh().reconcileActualBudgets()).toMatchObject({ applied: 0, pending: 1 });
      expect(await source.query("SELECT * FROM pricing_budget_effects WHERE kind = 'commit'")).toHaveLength(0);
    });
    it.each(operations)("records a late known %s correction against the original price and period without another initial debit", async operation => {
      const fixture = await seed(operation); await fixture.receipt("a", null, "http_error"); await fixture.receipt("b", "3"); await fixture.close();
      expect((await source.query("SELECT * FROM pricing_reservations"))[0].state).toBe("reserved");
      const attempt = (await source.query("SELECT * FROM pricing_attempts WHERE id = 'a'"))[0];
      const rule = (await source.getRepository(BudgetRule).find()).find(rule => rule.type === "daily_cost")!;
      await source.getRepository(BudgetRule).update(rule.id, { period_start: new Date(Date.now() + 86400000), current_value: 25 });
      await ledger.adjustAttempt({ id: "observed-correction", attemptId: "a", workspace, expectedCostHash: attempt.cost_hash, cost: fixture.cost("2"), actorId: "synthetic-supplier", reason: "Later observed quantity", source: "provider_usage" });
      expect(await fresh().reconcileActualBudgets()).toMatchObject({ applied: 1, pending: 0 });
      expect((await ledger.summary("request", workspace))?.budget_committed_usd).toBe("0.050000000000000000");
      expect((await source.getRepository(BudgetRule).findOneByOrFail({ id: rule.id })).current_value).toBe(25);
      expect((await source.query("SELECT * FROM pricing_attempts WHERE id = 'a'"))[0]).toEqual(attempt);
      await fixture.close(); expect(await source.query("SELECT * FROM pricing_budget_effects WHERE kind = 'commit'")).toHaveLength(1);
    });
  });
}
contract("SQLite actual quantity budgets", async () => {
  const directory = mkdtempSync(join(tmpdir(), "actual-quantity-budget-"));
  const source = await new DataSource({ type: "better-sqlite3", database: join(directory, "ledger.db"), entities: [BudgetRule], synchronize: true }).initialize();
  await source.query("PRAGMA journal_mode=WAL"); return { source, cleanup: async () => rmSync(directory, { recursive: true, force: true }) };
});
const pgUrl = process.env.SIFTGATE_PRICING_TEST_POSTGRES_URL;
if (pgUrl) { const url = new URL(pgUrl); if (url.hostname !== "127.0.0.1" || url.port === "2099" || !/^\/pricing_goal_[a-z0-9_]+$/.test(url.pathname)) throw new Error("Use isolated PostgreSQL test database"); }
contract("PostgreSQL actual quantity budgets", async () => {
  if (!pgUrl) throw new Error("No isolated PostgreSQL URL");
  const schema = `actual_quantity_${process.pid}_${Math.random().toString(16).slice(2)}`;
  const admin = await new DataSource({ type: "postgres", url: pgUrl, synchronize: false }).initialize(); await admin.query(`CREATE SCHEMA "${schema}"`);
  const source = await new DataSource({ type: "postgres", url: pgUrl, schema, extra: { options: `-c search_path=${schema}` }, entities: [BudgetRule], synchronize: true }).initialize();
  return { source, cleanup: async () => { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.destroy(); } };
}, pgUrl ? describe : describe.skip);

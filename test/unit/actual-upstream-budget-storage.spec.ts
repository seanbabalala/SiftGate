import { DataSource, SelectQueryBuilder } from "typeorm";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BudgetService } from "../../src/budget/budget.service";
import { BudgetRule } from "../../src/database/entities/budget-rule.entity";
import { WorkspaceContextService } from "../../src/workspaces/workspace-context.service";
import { CostLedgerService } from "../../src/pricing/cost-ledger.service";
import { PricingRepository } from "../../src/pricing/pricing-repository";
import { applyPricingSchema, PRICING_TABLE_NAMES } from "../../src/pricing/pricing-schema";
import { planActualBudgetAdjustment } from "../../src/pricing/actual-upstream-budget";
import { pricingContentHash } from "../../src/pricing/pricing-json";
import { mockConfigService } from "../helpers";
import { tokenBook, tokens } from "./pricing-fixtures";

const workspace = "default-workspace";
const actor = { id: "synthetic-admin", role: "admin" as const, workspace_id: workspace, global_admin: true };
const identity = { workspaceId: workspace, apiKeyName: null, apiKeyId: null, teamId: null, namespaceId: null };
const target = { model: "synthetic-model", node_id: "synthetic-node" };
function contract(label: string, connect: () => Promise<{ source: DataSource; cleanup: () => Promise<void> }>, run = describe) {
  run(label, () => {
    let source: DataSource, cleanup: () => Promise<void>, ledger: CostLedgerService, prices: PricingRepository;
    const makeLedger = () => new CostLedgerService(source, new BudgetService(mockConfigService(), new WorkspaceContextService(), source.getRepository(BudgetRule)));
    beforeEach(async () => {
      ({ source, cleanup } = await connect());
      await applyPricingSchema(source);
      await source.getRepository(BudgetRule).save([
        { workspace_id: workspace, type: "daily_cost", limit_value: 1000, current_value: 0, alert_threshold: 0.8, period_start: new Date(), is_active: true },
        { workspace_id: workspace, type: "daily_tokens", limit_value: 10000000, current_value: 0, alert_threshold: 0.8, period_start: new Date(), is_active: true },
      ]);
      ledger = makeLedger(); prices = new PricingRepository(source);
      const created = await prices.createBook(actor, { name: "Synthetic actual-budget comparison", scope: "workspace", content: tokenBook() });
      await prices.publishDraft(actor, created.draft.id, { draft_revision: 1, catalog_revision: 0, reason: "Synthetic fixture", confirm: true, targets: [{ level: "model", model: target.model }] });
    });
    afterEach(async () => {
      jest.restoreAllMocks();
      if (source?.isInitialized) await source.destroy();
      await cleanup?.();
    });
    const dump = async () => {
      const rows: Record<string, unknown> = {};
      for (const name of [...PRICING_TABLE_NAMES, "budget_rules"]) rows[name] = await source.query(`SELECT * FROM ${name}`);
      return rows;
    };
    async function seed(id = "request") {
      const snapshot = (await prices.capture({ request_id: id, workspace_id: workspace, report_currency: "USD" }))!;
      const first = snapshot.quote(target, tokens({ input_tokens: 1000, output_tokens: 100 })).cost;
      const second = snapshot.quote(target, tokens({ input_tokens: 2000, output_tokens: 100 })).cost;
      await ledger.reserve({ id, requestId: id, identity, target, estimate: first, tokens: "5000", costUsd: "0.1", budgetBasis: "legacy_logical", leaseOwner: "synthetic", leaseUntil: new Date(Date.now() + 60000).toISOString() });
      for (const name of ["failed", "success"])
        await ledger.beginAttempt({ id: `${id}-${name}`, requestId: id, workspace, reservationId: id, target, feeSource: "provider", dispatchedAt: new Date().toISOString(), priceContext: { context: {}, legacyPrice: null } });
      await ledger.completeAttempt(`${id}-failed`, workspace, first, "upstream_500");
      return { first, second, snapshot };
    }
    it("reads only this hold's complete failed/successful cohort and never changes legacy budgets", async () => {
      const { first, second } = await seed();
      await ledger.completeAttempt("request-success", workspace, second);
      const foreignHold = await seed("other");
      await ledger.completeAttempt("other-success", workspace, foreignHold.second);
      const before = await dump();
      const plan = await ledger.previewActualUpstreamBudget("request", workspace, true);
      expect(plan).toMatchObject({ read_only: true, activation_available: false, current_budget_basis: "legacy_logical", current_state: "reserved", plan: { state: "ready", require_upstream_tokens: true, cost_usd: "0.003400000000000000", upstream_tokens: "3200" } });
      expect(plan.plan.contributions.map(c => c.cost_hash)).toEqual([pricingContentHash(first), pricingContentHash(second)]);
      expect(await dump()).toEqual(before);
    });
    it("requires both observed dispatch closure and terminal receipt evidence, not process liveness", async () => {
      const { second } = await seed();
      expect((await ledger.previewActualUpstreamBudget("request", workspace, false)).plan.state).toBe("awaiting_dispatch_finality");
      expect((await ledger.previewActualUpstreamBudget("request", workspace, true)).plan).toMatchObject({ state: "awaiting_evidence", cost_usd: null, known_cost_usd: "0.001200000000000000", unresolved_cost_attempts: ["request-success"] });
      await ledger.completeAttempt("request-success", workspace, second);
      expect((await ledger.previewActualUpstreamBudget("request", workspace, true)).plan.state).toBe("ready");
    });
    it("restores a pure decision from durable evidence with a fresh service and fixed original prices", async () => {
      const { second } = await seed();
      await ledger.completeAttempt("request-success", workspace, second);
      const original = await ledger.previewActualUpstreamBudget("request", workspace, true);
      const book = tokenBook(); book.groups[0].rules[0].rates[0].component.amount = "99";
      const next = await prices.createBook(actor, { name: "Synthetic later price", scope: "workspace", content: book });
      await prices.publishDraft(actor, next.draft.id, { draft_revision: 1, catalog_revision: 1, confirm: true, reason: "Synthetic changed catalog", targets: [{ level: "model", model: target.model }] });
      ledger = makeLedger();
      const before = await dump();
      expect(await ledger.previewActualUpstreamBudget("request", workspace, true)).toEqual(original);
      expect(await dump()).toEqual(before);
    });
    it("sees effective corrections to a failed attempt without applying them to legacy winner budgets", async () => {
      const { first, second, snapshot } = await seed();
      await ledger.completeAttempt("request-success", workspace, second);
      await ledger.settle("request", workspace, "commit", "2100", second.report_amount!, "legacy_logical", { attemptId: "request-success", cost: second, errorCode: null }, [{ attemptId: "request-failed", cost: first, errorCode: "upstream_500" }]);
      const original = (await ledger.previewActualUpstreamBudget("request", workspace, true)).plan;
      const rules = await source.query("SELECT * FROM budget_rules ORDER BY id");
      await ledger.adjustAttempt({ id: "failed-usage-correction", attemptId: "request-failed", workspace, expectedCostHash: pricingContentHash(first), cost: snapshot.quote(target, tokens({ input_tokens: 500, output_tokens: 100 })).cost, actorId: actor.id, reason: "Synthetic corrected provider usage", source: "provider_usage" });
      const before = await dump();
      const changed = (await makeLedger().previewActualUpstreamBudget("request", workspace, true)).plan;
      expect(planActualBudgetAdjustment(original, changed)).toMatchObject({ state: "ready", cost_delta_usd: "-0.000500000000000000", tokens_delta: "-500", changed_attempt_ids: ["request-failed"] });
      expect(await source.query("SELECT * FROM budget_rules ORDER BY id")).toEqual(rules);
      expect(await dump()).toEqual(before);
    });
    it("rejects foreign scope and tampered receipt hashes without rewriting any evidence", async () => {
      await seed();
      const before = await dump();
      await expect(ledger.previewActualUpstreamBudget("request", "other-workspace", true)).rejects.toMatchObject({ status: 404 });
      expect(await dump()).toEqual(before);
      await source.createQueryBuilder().update("pricing_attempts").set({ cost_hash: "0".repeat(64) }).where("id = :id", { id: "request-failed" }).execute();
      const corrupted = await dump();
      await expect(ledger.previewActualUpstreamBudget("request", workspace, true)).rejects.toMatchObject({ status: 409 });
      expect(await dump()).toEqual(corrupted);
    });
    it("does not mistake a current policy or current budget-rule deletion for the original token requirement", async () => {
      await seed();
      await source.getRepository(BudgetRule).delete({ type: "daily_tokens" });
      expect((await ledger.previewActualUpstreamBudget("request", workspace, true)).plan.require_upstream_tokens).toBe(true);
    });
    it("rejects oversized stored receipts before selecting their full bodies", async () => {
      await seed();
      await source.createQueryBuilder().update("pricing_attempts").set({ cost_json: "x".repeat(8 * 1024 * 1024 + 1) }).where("id = :id", { id: "request-failed" }).execute();
      const get = SelectQueryBuilder.prototype.getRawMany;
      const load = jest.spyOn(SelectQueryBuilder.prototype, "getRawMany").mockImplementation(function () {
        if (this.expressionMap.mainAlias?.tablePath === "pricing_attempts" && this.expressionMap.selects.some((s: { selection: string }) => s.selection === "a.*"))
          throw new Error("Oversized bodies were loaded before preflight");
        return get.call(this);
      });
      await expect(ledger.previewActualUpstreamBudget("request", workspace, true)).rejects.toThrow("bounded inspection size");
      load.mockRestore();
      const intents = await source.query("SELECT COUNT(*) AS count FROM pricing_settlement_intents");
      expect(Number(intents[0].count)).toBe(0);
    });
  });
}
contract("SQLite actual-budget read-only evidence", async () => {
  const directory = mkdtempSync(join(tmpdir(), "actual-budget-"));
  const source = await new DataSource({ type: "better-sqlite3", database: join(directory, "ledger.db"), entities: [BudgetRule], synchronize: true }).initialize();
  await source.query("PRAGMA journal_mode=WAL"); await source.query("PRAGMA synchronous=FULL");
  return { source, cleanup: async () => rmSync(directory, { recursive: true, force: true }) };
});
const pgUrl = process.env.SIFTGATE_PRICING_TEST_POSTGRES_URL;
if (pgUrl && (new URL(pgUrl).hostname !== "127.0.0.1" || !/^\/pricing_goal_[a-z0-9_]+$/.test(new URL(pgUrl).pathname)))
  throw new Error("Use only an isolated test PostgreSQL database");
contract("PostgreSQL actual-budget read-only evidence", async () => {
  const schema = `actual_budget_${process.pid}_${Math.random().toString(16).slice(2)}`;
  const admin = await new DataSource({ type: "postgres", url: pgUrl }).initialize();
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const source = await new DataSource({ type: "postgres", url: pgUrl, schema, extra: { options: `-c search_path=${schema}` }, entities: [BudgetRule], synchronize: true }).initialize();
  return { source, cleanup: async () => { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.destroy(); } };
}, pgUrl ? describe : describe.skip);

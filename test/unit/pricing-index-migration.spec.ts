import { DataSource, InsertQueryBuilder, Table } from "typeorm";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { applyPricingSchema, planPricingSchema, PRICING_MIGRATIONS, PRICING_TABLE_NAMES, PRICING_INDEX_PLANS, removeEmptyPricingSchema } from "../../src/pricing/pricing-schema";
import { PricingRepository } from "../../src/pricing/pricing-repository";
import { CostLedgerService } from "../../src/pricing/cost-ledger.service";
import { BudgetService } from "../../src/budget/budget.service";
import { BudgetRule } from "../../src/database/entities/budget-rule.entity";
import { WorkspaceContextService } from "../../src/workspaces/workspace-context.service";
import { tokenBook, tokens } from "./pricing-fixtures";
import { mockConfigService } from "../helpers";

const indexName = "idx_pricing_task_reservation_state", version = "pricing-engine-018";
const actor = { id: "synthetic-admin", workspace_id: "default-workspace", role: "admin" as const, global_admin: true };
const indexPlan = [{ table: "pricing_media_tasks", name: indexName, column_names: ["workspace_id", "reservation_id", "state"] }];
function contract(label: string, connect: () => Promise<{ source: DataSource; cleanup(): Promise<void> }>, run = describe, postgres = false) {
  run(label, () => {
    let source: DataSource, cleanup: () => Promise<void>;
    beforeEach(async () => { ({ source, cleanup } = await connect()); });
    afterEach(async () => { jest.restoreAllMocks(); if (source?.isInitialized) await source.destroy(); await cleanup?.(); });
    const markers = () => source.query("SELECT * FROM pricing_schema_versions ORDER BY id");
    async function legacy() {
      const runner = source.createQueryRunner();
      try {
        for (const step of PRICING_MIGRATIONS.slice(0, 17)) {
          for (const definition of step.definitions) await runner.createTable(new Table(structuredClone(definition)), false, true, true);
          await runner.manager.createQueryBuilder().insert().into("pricing_schema_versions").values({ id: step.version, checksum: step.checksum, applied_at: "2026-09-29T00:00:00.000Z" }).execute();
        }
        await runner.manager.createQueryBuilder().insert().into("pricing_catalog_head").values({ id: "active", catalog_revision_id: null, revision: 0 }).execute();
      } finally { await runner.release(); }
    }
    const dropIndex = () => source.query(`DROP INDEX "${indexName}"`);
    async function dump() {
      const result: Record<string, string[]> = {};
      for (const table of [...PRICING_TABLE_NAMES, "budget_rules"]) {
        const rows: unknown[] = await source.query(`SELECT * FROM "${table}"`);
        result[table] = rows.map(row => JSON.stringify(row)).sort();
      }
      return result;
    }

    it("plans index creation on a fresh database without writes, then installs and verifies it idempotently", async () => {
      const runner = source.createQueryRunner();
      try {
        const before = (await runner.getTables()).map(table => table.name).sort();
        const plan = await planPricingSchema(source);
        expect(plan).toMatchObject({ state: "pending", create_indexes: indexPlan });
        expect((await runner.getTables()).map(table => table.name).sort()).toEqual(before);
      } finally { await runner.release(); }
      expect(PRICING_INDEX_PLANS).toEqual(indexPlan);
      expect((await applyPricingSchema(source)).create_indexes).toEqual([]);
      expect((await planPricingSchema(source)).state).toBe("applied");
      const before = await dump(); await applyPricingSchema(source); expect(await dump()).toEqual(before);
    });

    it("adds only the index/marker to version017 and preserves all seventeen previous migration records", async () => {
      await legacy();
      const before = await markers(), plan = await planPricingSchema(source);
      expect(plan).toMatchObject({ state: "pending", create_tables: [], create_indexes: indexPlan });
      expect(await markers()).toEqual(before);
      await applyPricingSchema(source);
      expect((await markers()).slice(0, 17)).toEqual(before);
      expect((await planPricingSchema(source)).state).toBe("applied");
    });

    it("preserves populated price, receipt, budget, audit and historical replay across the index-only upgrade", async () => {
      await applyPricingSchema(source);
      await source.getRepository(BudgetRule).save({ workspace_id: actor.workspace_id, type: "daily_cost", limit_value: 100, current_value: 0, alert_threshold: .8, period_start: new Date(), is_active: true });
      const prices = new PricingRepository(source), ledger = new CostLedgerService(source, new BudgetService(mockConfigService(), new WorkspaceContextService(), source.getRepository(BudgetRule)));
      const book = await prices.createBook(actor, { name: "Synthetic historical prices", scope: "workspace", content: tokenBook() });
      await prices.publishDraft(actor, book.draft.id, { draft_revision: 1, catalog_revision: 0, reason: "Synthetic price fixture", confirm: true, targets: [{ level: "model", model: "synthetic" }] });
      const target = { node_id: "synthetic-node", model: "synthetic" }, usage = tokens({ input_tokens: 1000, output_tokens: 100 });
      const request = (await prices.capture({ request_id: "request", workspace_id: actor.workspace_id, report_currency: "USD" }))!, cost = request.quote(target, usage).cost;
      await ledger.reserve({ id: "reservation", requestId: "request", identity: { workspaceId: actor.workspace_id, apiKeyId: null, apiKeyName: null, teamId: null, namespaceId: null }, target, estimate: cost, tokens: "1100", costUsd: cost.report_amount!, budgetBasis: "legacy_logical", leaseOwner: "synthetic", leaseUntil: new Date(Date.now() + 60000).toISOString() });
      await ledger.beginAttempt({ id: "attempt", requestId: "request", workspace: actor.workspace_id, reservationId: "reservation", target, feeSource: "provider", dispatchedAt: new Date().toISOString(), priceContext: { context: {}, legacyPrice: null } });
      await ledger.persistRuntimeOutcome({ type: "settlement", workspace: actor.workspace_id, reservationId: "reservation", payload: { kind: "commit", tokens: "1100", cost_usd: cost.report_amount!, budget_basis: "legacy_logical", receipt: { attemptId: "attempt", cost, errorCode: null } } });
      await ledger.applySettlement("reservation", actor.workspace_id);
      const summary = await ledger.summary("request", actor.workspace_id);
      // Index018 adds no data fields. Removing only its index/marker faithfully
      // reconstructs the017 schema around real candidate-generated records.
      await dropIndex(); await source.query("DELETE FROM pricing_schema_versions WHERE id = 'pricing-engine-018'");
      const before = await dump(), oldMarkers = await markers();
      expect((await planPricingSchema(source)).create_indexes).toEqual(indexPlan);
      await applyPricingSchema(source);
      const after = await dump(); delete before.pricing_schema_versions; delete after.pricing_schema_versions;
      expect(after).toEqual(before); expect((await markers()).slice(0, 17)).toEqual(oldMarkers);
      const cold = new PricingRepository(source);
      expect((await cold.restoreRequest("request", actor.workspace_id)).quote(target, usage).cost).toEqual(cost);
      expect(await ledger.summary("request", actor.workspace_id)).toEqual(summary);
      await expect(removeEmptyPricingSchema(source)).rejects.toThrow("nonempty");
    });

    it.each(["matching", "wrong-table", "name-collision"])("refuses an unmarked %s index/object instead of adopting or replacing it", async kind => {
      await legacy();
      if (kind === "name-collision") await source.query(`CREATE TABLE "${indexName}" (id integer)`);
      else await source.query(kind === "matching" ? `CREATE INDEX "${indexName}" ON pricing_media_tasks (workspace_id,reservation_id,state)` : `CREATE INDEX "${indexName}" ON pricing_reservations (workspace_id,id,state)`);
      const before = await dump();
      expect((await planPricingSchema(source)).state).toBe("conflict");
      await expect(applyPricingSchema(source)).rejects.toThrow("conflict");
      expect(await dump()).toEqual(before);
    });

    it.each(["missing", "reordered", "unique", "partial", "expression", "descending", "wrong-table", "collation", ...(postgres ? ["included", "operator-class", "null-order"] : [])])("rejects a marked but %s index without repairing it", async kind => {
      await applyPricingSchema(source); await dropIndex();
      const definition: Record<string, string> = {
        reordered: "ON pricing_media_tasks (reservation_id,workspace_id,state)",
        unique: "ON pricing_media_tasks (workspace_id,reservation_id,state)",
        partial: "ON pricing_media_tasks (workspace_id,reservation_id,state) WHERE state = 'submitted'",
        expression: "ON pricing_media_tasks (workspace_id,lower(reservation_id),state)",
        descending: "ON pricing_media_tasks (workspace_id,reservation_id,state DESC)",
        "wrong-table": "ON pricing_reservations (workspace_id,id,state)",
        collation: `ON pricing_media_tasks (workspace_id,reservation_id,state COLLATE ${postgres ? '"C"' : 'NOCASE'})`,
        included: "ON pricing_media_tasks (workspace_id,reservation_id,state) INCLUDE (id)",
        "operator-class": "ON pricing_media_tasks (workspace_id,reservation_id,state text_pattern_ops)",
        "null-order": "ON pricing_media_tasks (workspace_id,reservation_id,state NULLS FIRST)",
      };
      if (kind !== "missing") await source.query(`CREATE ${kind === "unique" ? "UNIQUE " : ""}INDEX "${indexName}" ${definition[kind]}`);
      const before = await markers(), plan = await planPricingSchema(source);
      expect(plan.state).toBe("conflict"); expect(plan.create_indexes).toEqual([]);
      await expect(applyPricingSchema(source)).rejects.toThrow("conflict");
      expect(await markers()).toEqual(before);
    });

    if (postgres) it("inspects only the selected schema even when another schema owns the same index name", async () => {
      await legacy();
      const other = `pricing_shadow_${randomUUID().replaceAll("-", "")}`;
      await source.query(`CREATE SCHEMA "${other}"`);
      try {
        await source.query(`CREATE TABLE "${other}".pricing_media_tasks (id integer)`);
        await source.query(`CREATE INDEX "${indexName}" ON "${other}".pricing_media_tasks (id DESC)`);
        const definition = () => source.query("SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND indexname = $2", [other, indexName]);
        const before = await definition(); expect(before).toHaveLength(1);
        expect(await planPricingSchema(source)).toMatchObject({ state: "pending", create_tables: [], create_indexes: indexPlan });
        await applyPricingSchema(source);
        expect((await planPricingSchema(source)).state).toBe("applied");
        expect(await definition()).toEqual(before);
        await dropIndex();
        expect((await planPricingSchema(source)).state).toBe("conflict");
        expect(await definition()).toEqual(before);
      } finally { await source.query(`DROP SCHEMA "${other}" CASCADE`); }
    });

    it("rejects checksum drift and an index marker without earlier migrations", async () => {
      await applyPricingSchema(source);
      await source.query("UPDATE pricing_schema_versions SET checksum = 'wrong' WHERE id = 'pricing-engine-018'");
      expect((await planPricingSchema(source)).state).toBe("conflict");
      await source.createQueryBuilder().update("pricing_schema_versions").set({ checksum: PRICING_MIGRATIONS.at(-1)!.checksum }).where("id = :id", { id: version }).execute();
      await source.query("DELETE FROM pricing_schema_versions WHERE id = 'pricing-engine-017'");
      expect((await planPricingSchema(source)).issues.some(issue => issue.includes("requires all earlier"))).toBe(true);
    });

    it("rolls index creation back if recording the marker fails, then permits a clean retry", async () => {
      await legacy(); const before = await markers(), original = InsertQueryBuilder.prototype.execute;
      const log = jest.spyOn(source.logger, "logQuery");
      const fault = jest.spyOn(InsertQueryBuilder.prototype, "execute").mockImplementation(function (this: InsertQueryBuilder<Record<string, unknown>>) {
        if (this.getQuery().includes("pricing_schema_versions") && Object.values(this.getParameters()).includes(version)) throw new Error("Synthetic marker failure");
        return original.call(this);
      });
      await expect(applyPricingSchema(source)).rejects.toThrow("Synthetic marker failure"); fault.mockRestore();
      expect(log.mock.calls.some(args => args[0].includes("CREATE INDEX") && args[0].includes(indexName))).toBe(true);
      expect(await markers()).toEqual(before);
      expect(await planPricingSchema(source)).toMatchObject({ state: "pending", create_indexes: indexPlan });
      await applyPricingSchema(source); expect((await planPricingSchema(source)).state).toBe("applied");
    });

    it("removes an intact unused installation including its index and can install again", async () => {
      await applyPricingSchema(source); await removeEmptyPricingSchema(source);
      expect(await planPricingSchema(source)).toMatchObject({ state: "pending", create_indexes: indexPlan });
      await applyPricingSchema(source); expect((await planPricingSchema(source)).state).toBe("applied");
    });
  });
}

contract("SQLite additive pricing index migration", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pricing-index-"));
  const source = await new DataSource({ type: "better-sqlite3", database: join(dir, "test.sqlite"), synchronize: true, entities: [BudgetRule] }).initialize();
  return { source, cleanup: async () => rmSync(dir, { recursive: true, force: true }) };
});
const url = process.env.SIFTGATE_PRICING_TEST_POSTGRES_URL;
if (url && (new URL(url).hostname !== "127.0.0.1" || !/^\/pricing_goal_[a-z0-9_]+$/.test(new URL(url).pathname))) throw new Error("Use a private loopback pricing_goal_* database");
contract("PostgreSQL additive pricing index migration", async () => {
  const admin = await new DataSource({ type: "postgres", url }).initialize(), schema = `pricing_index_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const source = await new DataSource({ type: "postgres", url, schema, extra: { options: `-c search_path=${schema}` }, synchronize: true, entities: [BudgetRule] }).initialize();
  return { source, cleanup: async () => { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.destroy(); } };
}, url ? describe : describe.skip, true);

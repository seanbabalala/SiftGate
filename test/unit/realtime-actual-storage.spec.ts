import { DataSource, InsertQueryBuilder } from "typeorm";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { BudgetService } from "../../src/budget/budget.service";
import {
  BudgetRule,
  CallLog,
  RouteDecisionLog,
} from "../../src/database/entities";
import { WorkspaceContextService } from "../../src/workspaces/workspace-context.service";
import { CostLedgerService } from "../../src/pricing/cost-ledger.service";
import { PricingRepository } from "../../src/pricing/pricing-repository";
import { RealtimePricingService } from "../../src/pricing/realtime-pricing.service";
import { realtimePricingEvent } from "../../src/pricing/realtime-metering";
import { applyPricingSchema } from "../../src/pricing/pricing-schema";
import { book, rate } from "./pricing-fixtures";
import { mockConfigService } from "../helpers";
import type { GatewayApiKeyContext } from "../../src/auth/gateway-api-key.service";

const workspace = "default-workspace";
const actor = {
  id: "synthetic",
  workspace_id: workspace,
  role: "admin" as const,
  global_admin: true,
};
const key = {
  id: "synthetic",
  name: "synthetic",
  workspace_id: workspace,
  namespace_id: null,
} as GatewayApiKeyContext;
const entities = [BudgetRule, CallLog, RouteDecisionLog];
const report = (id: string, amount = 10) =>
  realtimePricingEvent(
    JSON.stringify({
      type: "response.done",
      response: {
        id,
        status: "completed",
        usage: {
          input_tokens: 0,
          output_tokens: amount,
          total_tokens: amount,
          input_token_details: { cached_tokens: 0 },
        },
      },
    }),
  )!;
function contract(
  label: string,
  connect: () => Promise<{ db: DataSource; cleanup: () => Promise<void> }>,
  run = describe,
) {
  run(label, () => {
    let db: DataSource,
      cleanup: () => Promise<void>,
      prices: PricingRepository,
      ledger: CostLedgerService,
      service: RealtimePricingService;
    beforeEach(async () => {
      ({ db, cleanup } = await connect());
      await applyPricingSchema(db);
      await db
        .getRepository(BudgetRule)
        .save({
          workspace_id: workspace,
          type: "daily_cost",
          limit_value: 100,
          current_value: 0,
          alert_threshold: 0.8,
          period_start: new Date(),
          is_active: true,
        });
      const config = mockConfigService();
      ledger = new CostLedgerService(
        db,
        new BudgetService(
          config,
          new WorkspaceContextService(),
          db.getRepository(BudgetRule),
        ),
      );
      prices = new PricingRepository(db);
      service = new RealtimePricingService(prices, ledger);
      const created = await prices.createBook(actor, {
        name: "Synthetic RT",
        scope: "workspace",
        content: book([rate("output", "output_tokens", "0.01", "1")]),
      });
      await prices.publishDraft(actor, created.draft.id, {
        draft_revision: 1,
        catalog_revision: 0,
        reason: "Synthetic",
        confirm: true,
        targets: [
          { level: "model", model: "realtime-model", operation: "realtime" },
        ],
      });
      const revision = (await prices.listBindings(actor)).head.revision;
      await prices.updateAdmissionPolicy(actor, {
        catalog_revision: revision,
        scope: "workspace",
        operation: "realtime",
        reason: "Synthetic limits",
        confirm: true,
        policy: {
          mode: "reserve_upper_bound",
          budget_basis: "actual_upstream",
          realtime_max_responses: 2,
          quantity_limits: {
            total_input_tokens: "100",
            output_tokens: "40",
            session_seconds: "60",
          },
          limit_reference: "Synthetic",
        },
      });
    });
    afterEach(async () => {
      jest.restoreAllMocks();
      if (db?.isInitialized) await db.destroy();
      await cleanup?.();
    });
    const begin = (id: string) =>
      service.begin(id, key, "node", "realtime-model", 60000);
    it.each(["response-retained", "closure-retained", "closed", "independent-asr"])("recovers automatic audio custody after a real subprocess exits at %s", async mode => {
      const child = spawnSync(process.execPath, ["-r", require.resolve("ts-node/register"), require.resolve("../helpers/realtime-audio-crash-child")], {
        cwd: process.cwd(), env: { HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, PATH: process.env.PATH, NODE_OPTIONS: "--max-old-space-size=512", TS_NODE_TRANSPILE_ONLY: "true",
          PRICING_CHILD_DB: JSON.stringify(db.options), PRICING_CHILD_MODE: mode }, encoding: "utf8", timeout: 20000,
      });
      expect({ status: child.status, signal: child.signal, error: child.error?.message, stderr: child.stderr }).toEqual({ status: 19, signal: null, error: undefined, stderr: "" });
      expect(JSON.parse(child.stdout.trim())).toMatchObject({ checkpoint: mode, database: db.options.type, supplier_calls: 0 });
      const original = await db.query("SELECT * FROM pricing_attempts WHERE id LIKE 'rt-response-%'");
      expect(original).toHaveLength(1); expect(JSON.parse(original[0].cost_json).report_amount).toBe("0.100000000");
      const connection = await new DataSource({ ...db.options, synchronize: false }).initialize();
      const restored = new CostLedgerService(connection, new BudgetService(mockConfigService(), new WorkspaceContextService(), connection.getRepository(BudgetRule)));
      try {
        await restored.replayRuntimeOutcomes(new Date(Date.now() + 120000)); await restored.reconcilePending(); await restored.reconcileActualBudgets();
        const result = (await restored.summary("crash-audio", workspace))!;
        const complete = mode === "closure-retained" || mode === "closed";
        expect(result.reservations[0].state).toBe(complete ? "committed" : "reserved");
        expect(result.budget_committed_usd).toBe(complete ? "0.100000000000000000" : "0.000000000000000000");
        if (!complete) expect(result.amount).toBeNull();
        expect(result.known_subtotal).toBe("0.100000000000000000");
        const cohorts = await connection.query("SELECT * FROM pricing_actual_budget_cohorts");
        expect(cohorts).toHaveLength(mode === "response-retained" ? 0 : 1);
        if (mode === "independent-asr") expect(JSON.parse(cohorts[0].closure_json).missing_dispatch_evidence).toBe(true);
        await restored.replayRuntimeOutcomes(new Date(Date.now() + 240000)); await restored.reconcileActualBudgets();
        expect(await restored.summary("crash-audio", workspace)).toEqual(result);
        expect(await connection.query("SELECT * FROM pricing_budget_effects WHERE kind='commit'")).toHaveLength(complete ? 1 : 0);
        expect(await connection.query("SELECT * FROM pricing_attempts WHERE id LIKE 'rt-response-%'")).toEqual(original);
      } finally { await connection.destroy(); }
    }, 30000);
    it("rolls back a failed actual debit and recovers its retained closure with a fresh service", async () => {
      const handle = (await begin("rollback"))!; await handle.dispatched(); handle.opened(); await handle.observe(report("a"));
      const original = InsertQueryBuilder.prototype.execute;
      const fault = jest.spyOn(InsertQueryBuilder.prototype, "execute").mockImplementation(function (this: InsertQueryBuilder<Record<string, unknown>>) {
        if (this.getQuery().includes('pricing_budget_effects')) throw new Error("Synthetic atomic debit failure");
        return original.call(this);
      });
      await handle.close(false); expect((await ledger.summary("rollback", workspace))!.reservations[0].state).toBe("reserved");
      expect(await db.query("SELECT * FROM pricing_budget_effects WHERE kind = 'commit'")).toHaveLength(0); fault.mockRestore();
      const restored = new CostLedgerService(db, new BudgetService(mockConfigService(), new WorkspaceContextService(), db.getRepository(BudgetRule)));
      await restored.replayRuntimeOutcomes(new Date(Date.now() + 120000)); await restored.replayRuntimeOutcomes(new Date(Date.now() + 240000));
      expect((await restored.summary("rollback", workspace))!.budget_committed_usd).toBe("0.100000000000000000");
      expect(await db.query("SELECT * FROM pricing_budget_effects WHERE kind = 'commit'")).toHaveLength(1);
    });
    it("retains known paid response fees and a pending cohort when another created response has no usage", async () => {
      const handle = (await begin("missing"))!; await handle.dispatched(); handle.opened(); await handle.observe(report("a"));
      await handle.observe(realtimePricingEvent('{"type":"response.created","response":{"id":"b"}}')!); await handle.close(false);
      const result = (await ledger.summary("missing", workspace))!; expect(result.known_subtotal).toBe("0.100000000000000000"); expect(result.reservations[0].state).toBe("reserved");
      expect((await db.query("SELECT * FROM pricing_actual_budget_cohorts"))[0].state).toBe("pending");
      await ledger.reconcilePending(); expect((await ledger.summary("missing", workspace))!.budget_committed_usd).toBe("0.000000000000000000");
    });
    it("settles exact receipts idempotently and restores their original immutable snapshot cold", async () => {
      const handle = (await begin("session"))!;
      await handle.dispatched();
      handle.opened();
      await handle.observe(report("a"));
      await handle.observe(report("a"));
      await handle.close(false);
      const before = (await ledger.summary("session", workspace))!;
      expect(before.amount).toBe("0.100000000000000000");
      expect(before.provider_attempts).toBe(2);
      await ledger.reconcilePending();
      expect(await ledger.summary("session", workspace)).toEqual(before);
      const frozen = await new PricingRepository(db).restoreRequest(
        "session",
        workspace,
      );
      const receipt = before.attempts.find(
        (a) => a.fee_source === "provider" && a.id.startsWith("rt-response-"),
      )!.cost!;
      expect(
        frozen.quote(
          { model: "realtime-model", node_id: "node", operation: "realtime" },
          receipt.usage,
        ).cost.amount,
      ).toBe("0.100000000");
      await expect(
        new PricingRepository(db).restoreRequest("session", "foreign"),
      ).rejects.toMatchObject({ status: 404 });
    });
    it("preserves the durable dispatch witness and hold after process loss until explicit review", async () => {
      const handle = (await begin("lost-session"))!;
      await handle.dispatched();
      handle.opened();
      await handle.observe(
        realtimePricingEvent(
          '{"type":"response.created","response":{"id":"pending"}}',
        )!,
      );
      await db
        .createQueryBuilder()
        .update("pricing_reservations")
        .set({ lease_until: new Date(Date.now() - 60000).toISOString() })
        .where("request_id = :id", { id: "lost-session" })
        .execute();
      expect(await ledger.recoverUndispatched()).toBe(0);
      await ledger.reconcileDispatched();
      const result = (await ledger.summary("lost-session", workspace))!;
      expect(result.amount).toBeNull();
      expect(result.budget_reserved_usd).toBe("1.200000000000000000");
      expect(result.reservations[0].recovery_case).not.toBeNull();
    });
    it("uses exact budget reservations under concurrent session admission", async () => {
      await db
        .getRepository(BudgetRule)
        .update({ type: "daily_cost" }, { limit_value: 1.3 });
      const results = await Promise.allSettled([begin("a"), begin("b")]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
      const accepted = results.find(
        (r) => r.status === "fulfilled",
      ) as PromiseFulfilledResult<Awaited<ReturnType<typeof begin>>>;
      await accepted.value!.close(false);
    });
  });
}
contract("SQLite actual Realtime ledger", async () => {
  const dir = mkdtempSync(join(tmpdir(), "realtime-pricing-"));
  const db = await new DataSource({
    type: "better-sqlite3",
    database: join(dir, "test.sqlite"),
    synchronize: true,
    entities,
  }).initialize();
  await db.query("PRAGMA journal_mode=WAL");
  await db.query("PRAGMA synchronous=FULL");
  return {
    db,
    cleanup: async () => rmSync(dir, { recursive: true, force: true }),
  };
});
const pg = process.env.SIFTGATE_PRICING_TEST_POSTGRES_URL;
if (
  pg &&
  (new URL(pg).hostname !== "127.0.0.1" ||
    !/^\/pricing_goal_[a-z0-9_]+$/.test(new URL(pg).pathname))
)
  throw Error("Private PostgreSQL only");
contract(
  "PostgreSQL actual Realtime ledger",
  async () => {
    if (!pg) throw Error("Private PostgreSQL required");
    const schema = `realtime_actual_${process.pid}_${Math.random().toString(16).slice(2)}`,
      admin = await new DataSource({
        type: "postgres",
        url: pg,
        synchronize: false,
      }).initialize();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const db = await new DataSource({
      type: "postgres",
      url: pg,
      schema,
      extra: { max: 2, options: `-c search_path=${schema}` },
      synchronize: true,
      entities,
    }).initialize();
    return {
      db,
      cleanup: async () => {
        try {
          await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
        } finally {
          await admin.destroy();
        }
      },
    };
  },
  pg ? describe : describe.skip,
);

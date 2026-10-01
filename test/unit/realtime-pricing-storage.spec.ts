import { DataSource } from "typeorm";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    it("settles exact receipts idempotently and restores their original immutable snapshot cold", async () => {
      const handle = (await begin("session"))!;
      handle.dispatched();
      handle.opened();
      await handle.observe(report("a"));
      await handle.observe(report("a"));
      await handle.close(false);
      const before = (await ledger.summary("session", workspace))!;
      expect(before.amount).toBe("0.100000000000000000");
      expect(before.provider_attempts).toBe(1);
      await ledger.reconcilePending();
      expect(await ledger.summary("session", workspace)).toEqual(before);
      const frozen = await new PricingRepository(db).restoreRequest(
        "session",
        workspace,
      );
      const receipt = before.attempts.find(
        (a) => a.fee_source === "provider",
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
      handle.dispatched();
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
contract("SQLite Realtime ledger", async () => {
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
  "PostgreSQL Realtime ledger",
  async () => {
    if (!pg) throw Error("Private PostgreSQL required");
    const schema = `realtime_${process.pid}_${Math.random().toString(16).slice(2)}`,
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

import { DataSource, InsertQueryBuilder, type EntityManager, type QueryRunner } from "typeorm";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { BudgetService } from "../../src/budget/budget.service";
import { BudgetRule } from "../../src/database/entities/budget-rule.entity";
import { WorkspaceContextService } from "../../src/workspaces/workspace-context.service";
import { CostLedgerService } from "../../src/pricing/cost-ledger.service";
import { PricingRepository } from "../../src/pricing/pricing-repository";
import { PricingAttemptCorrectionService } from "../../src/pricing/pricing-attempt-correction.service";
import { applyPricingSchema } from "../../src/pricing/pricing-schema";
import { runtimeOutcomeDocument } from "../../src/pricing/pricing-outcome-document";
import { acknowledgeRuntimeOutcomes, prepareRuntimeOutcomeRetention, executePreparedRetentionTransaction, retainRuntimeOutcome, transitionRuntimeOutcome, verifyRuntimeOutcome, type RuntimeOutcomeRow } from "../../src/pricing/pricing-outcome-inbox";
import {
  PricingOutcomeRetryBuffer,
  type PricingOutcome,
} from "../../src/pricing/pricing-outcome-retry";
import { mockConfigService } from "../helpers";
import { tokenBook, tokens } from "./pricing-fixtures";
import {
  allocateBatchCost,
  batchShareCost,
} from "../../src/pricing/cost-allocation";

const workspace = "default-workspace",
  actor = {
    id: "test-admin",
    role: "admin" as const,
    workspace_id: workspace,
    global_admin: true,
  };
const target = { node_id: "test-node", model: "test-model" };
const identity = {
  workspaceId: workspace,
  apiKeyName: null,
  apiKeyId: null,
  teamId: null,
  namespaceId: null,
};
function contract(
  label: string,
  connect: () => Promise<{ source: DataSource; cleanup: () => Promise<void> }>,
  run = describe,
) {
  run(label, () => {
    let source: DataSource,
      cleanup: () => Promise<void>,
      ledger: CostLedgerService,
      prices: PricingRepository;
    const makeLedger = (connection: DataSource) =>
      new CostLedgerService(
        connection,
        new BudgetService(
          mockConfigService(),
          new WorkspaceContextService(),
          connection.getRepository(BudgetRule),
        ),
      );
    beforeEach(async () => {
      ({ source, cleanup } = await connect());
      await applyPricingSchema(source);
      await source.getRepository(BudgetRule).save({
        workspace_id: workspace,
        type: "daily_cost",
        limit_value: 100,
        current_value: 0,
        alert_threshold: 0.8,
        period_start: new Date(),
        is_active: true,
      });
      ledger = makeLedger(source);
      prices = new PricingRepository(source);
      const created = await prices.createBook(actor, {
        name: "Synthetic inbox",
        scope: "workspace",
        content: tokenBook(),
      });
      await prices.publishDraft(actor, created.draft.id, {
        draft_revision: 1,
        catalog_revision: 0,
        reason: "Fixture only",
        confirm: true,
        targets: [{ level: "model", model: target.model }],
      });
    });
    afterEach(async () => {
      jest.restoreAllMocks();
      if (source?.isInitialized) await source.destroy();
      await cleanup?.();
    });
    async function seed(id = "r1", scope = workspace) {
      const snapshot = (await prices.capture({
        request_id: id,
        workspace_id: scope,
        report_currency: "USD",
      }))!;
      const cost = snapshot.quote(
        target,
        tokens({ input_tokens: 1000, output_tokens: 100 }),
      ).cost;
      await ledger.reserve({
        id,
        requestId: id,
        identity: { ...identity, workspaceId: scope },
        target,
        estimate: cost,
        tokens: "1100",
        costUsd: "0.5",
        budgetBasis: "legacy_logical",
        leaseOwner: "synthetic-owner",
        leaseUntil: new Date(Date.now() - 60000).toISOString(),
      });
      await ledger.beginAttempt({
        id: `a-${id}`,
        requestId: id,
        workspace: scope,
        reservationId: id,
        target,
        feeSource: "provider",
        dispatchedAt: "2026-09-20T00:00:00Z",
        priceContext: { context: {}, legacyPrice: null },
      });
      const attempt: PricingOutcome = {
        type: "attempt",
        workspace: scope,
        reservationId: id,
        attemptId: `a-${id}`,
        cost,
        errorCode: null,
      };
      const settlement: PricingOutcome = {
        type: "settlement",
        workspace: scope,
        reservationId: id,
        payload: {
          kind: "commit",
          tokens: "1100",
          cost_usd: cost.report_amount!,
          budget_basis: "legacy_logical",
          receipt: { attemptId: `a-${id}`, cost, errorCode: null },
        },
      };
      const different: PricingOutcome = {
        ...attempt,
        cost: snapshot.quote(
          target,
          tokens({ input_tokens: 2000, output_tokens: 100 }),
        ).cost,
      };
      return { attempt, settlement, different, cost };
    }
    const rows = (): Promise<RuntimeOutcomeRow[]> =>
      source.query("SELECT * FROM pricing_runtime_outcomes ORDER BY id");
    async function rejectAudit(message: string, id?: string) {
      const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
      const condition = id ? `NEW.id = ${quote(id)}` : "1 = 1";
      const postgres = source.options.type === "postgres";
      if (postgres) {
        await source.query(`CREATE FUNCTION inbox_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${condition} THEN RAISE EXCEPTION ${quote(message)}; END IF; RETURN NEW; END; $$`);
        await source.query("CREATE TRIGGER inbox_audit_failure BEFORE INSERT ON pricing_audit_events FOR EACH ROW EXECUTE FUNCTION inbox_audit_failure()");
      } else await source.query(`CREATE TRIGGER inbox_audit_failure BEFORE INSERT ON pricing_audit_events WHEN ${condition} BEGIN SELECT RAISE(ABORT, ${quote(message)}); END`);
      return async () => {
        await source.query(postgres ? "DROP TRIGGER inbox_audit_failure ON pricing_audit_events" : "DROP TRIGGER inbox_audit_failure");
        if (postgres) await source.query("DROP FUNCTION inbox_audit_failure()");
      };
    }
    it("does not acknowledge a nested SQLite transaction as durable, while PostgreSQL retains independently", async () => {
      const { attempt } = await seed(), runner = source.createQueryRunner();
      await runner.startTransaction();
      try {
        if (source.options.type === "better-sqlite3") {
          await expect(ledger.retainRuntimeOutcome(attempt)).rejects.toThrow("independent SQLite transaction");
          expect(await rows()).toEqual([]);
        } else expect((await ledger.retainRuntimeOutcome(attempt)).state).toBe("pending");
        expect(runner.isTransactionActive).toBe(true);
      } finally { await runner.rollbackTransaction(); await runner.release(); }
      const retained = await ledger.retainRuntimeOutcome(attempt);
      expect((await rows()).map(row => row.id)).toEqual([retained.id]);
    });
    it("preserves scoped asynchronous ownership indicators with one combined lookup after locking the request", async () => {
      const variants = ["none", "empty-job", "submitted", "terminal", "synchronous", "foreign-task"];
      for (const [index, variant] of variants.entries()) {
        const id = `ownership-${index}`, { attempt } = await seed(id), now = new Date().toISOString();
        if (variant === "empty-job") await source.createQueryBuilder().update("pricing_reservations").set({ job_id: "" }).where("id = :id", { id }).execute();
        else if (variant !== "none") await source.createQueryBuilder().insert().into("pricing_media_tasks").values({
          id: `a-${id}`, request_id: id, reservation_id: id, workspace_id: variant === "foreign-task" ? "foreign" : workspace,
          node_id: target.node_id, model: target.model, operation: "video_generation", connection_hash: "synthetic",
          state: variant === "foreign-task" ? "submitted" : variant, context_json: "{}", context_hash: "synthetic",
          revision: 1, next_poll_at: now, created_at: now, updated_at: now,
        }).execute();
        const queries = jest.spyOn(source.logger, "logQuery");
        const retained = await ledger.retainRuntimeOutcome(attempt);
        expect(retained.state).toBe(["empty-job", "submitted", "terminal"].includes(variant) ? "review_required" : "pending");
        expect(queries.mock.calls.filter(args => (args[0].startsWith("SELECT") || args[0].startsWith("/* siftgate_transaction_read_prelude:2 */")) && args[0].includes("async_task"))).toHaveLength(1);
        queries.mockRestore();
      }
      expect(await source.query("SELECT * FROM pricing_budget_effects WHERE kind = 'commit'")).toEqual([]);
    });
    it("only factory-created retention callbacks can use a transaction prelude; wrapped callbacks retain the ordinary path", async () => {
      const { attempt } = await seed(), prepared = prepareRuntimeOutcomeRetention(attempt);
      const wrapped = Object.assign(jest.fn(async (manager: EntityManager) => {
        expect(manager.queryRunner!.isTransactionActive).toBe(true); return prepared(manager);
      }), prepared);
      const queries = jest.spyOn(source.logger, "logQuery");
      const row = await executePreparedRetentionTransaction(source, wrapped);
      expect(row.state).toBe("pending"); expect(wrapped).toHaveBeenCalledTimes(1);
      expect(queries.mock.calls.some(([sql]) => sql.includes("siftgate_transaction_read_prelude"))).toBe(false);
      expect(await rows()).toEqual([row]);
    });
    it("prepared retention transactions keep captured input immutable and revalidate existing database evidence", async () => {
      const { attempt } = await seed(), original = structuredClone(attempt), prepared = prepareRuntimeOutcomeRetention(attempt);
      attempt.workspace = "foreign"; attempt.cost.report_amount = "999";
      const retained = await executePreparedRetentionTransaction(source, prepared);
      expect(JSON.parse(retained.outcome_json)).toEqual(original);
      await source.createQueryBuilder().update("pricing_audit_events").set({ actor_id: "tampered" }).where("id = :id", { id: `${retained.id}:retained` }).execute();
      await expect(executePreparedRetentionTransaction(source, prepared)).rejects.toMatchObject({ status: 409 });
      expect((await rows())[0].outcome_json).toBe(retained.outcome_json);
    });
    if (label.startsWith("PostgreSQL")) {
      it.each(["async-owner", "moved-parent", "missing-receipt"] as const)("prelude retention observes fresh %s state after an actual request-lock wait", async change => {
        const { attempt } = await seed();
        if (change === "moved-parent") await seed("different");
        const writer = source.createQueryRunner(); await writer.startTransaction();
        const writerId = (await writer.query("SELECT pg_backend_pid() AS pid"))[0].pid;
        let pending: Promise<{ value?: RuntimeOutcomeRow; error?: unknown }> | undefined;
        try {
          await writer.query("SELECT request_id FROM pricing_request_snapshots WHERE request_id=$1 AND workspace_id=$2 FOR UPDATE", ["r1", workspace]);
          if (change === "async-owner") await writer.manager.createQueryBuilder().update("pricing_reservations").set({ job_id: "new-async-job" }).where("id = :id", { id: "r1" }).execute();
          if (change === "moved-parent") await writer.manager.createQueryBuilder().update("pricing_reservations").set({ request_id: "different" }).where("id = :id", { id: "r1" }).execute();
          if (change === "missing-receipt") await writer.manager.createQueryBuilder().delete().from("pricing_attempts").where("id = :id", { id: "a-r1" }).execute();
          let finished = false;
          pending = ledger.retainRuntimeOutcome(attempt).then(value => ({ value }), error => ({ error })).finally(() => { finished = true; });
          let blocked = false;
          for (let n = 0; n < 100; n++) {
            blocked = (await source.query("SELECT pid FROM pg_stat_activity WHERE query LIKE '/* siftgate_transaction_read_prelude:%' AND $1::int=ANY(pg_blocking_pids(pid))", [writerId])).length === 1;
            if (blocked) break; await new Promise(resolve => setTimeout(resolve, 10));
          }
          expect(blocked).toBe(true); expect(finished).toBe(false);
          await writer.commitTransaction();
          const result = await pending;
          if (change === "async-owner") {
            expect(result.error).toBeUndefined(); expect(result.value!.state).toBe("review_required");
            expect((await rows()).map(row => row.state)).toEqual(["review_required"]);
          } else {
            expect(result.error).toMatchObject({ status: change === "moved-parent" ? 409 : 404 });
            expect(result.value).toBeUndefined(); expect(await rows()).toEqual([]);
            expect(await source.query("SELECT * FROM pricing_audit_events WHERE action='cost.outcome_retained'")).toEqual([]);
          }
          expect(await source.query("SELECT * FROM pricing_budget_effects WHERE kind='commit'")).toEqual([]);
        } finally {
          if (writer.isTransactionActive) await writer.rollbackTransaction();
          if (pending) await pending; await writer.release();
        }
      });
      it("concurrent prepared retention commits preserve one exact body and one retained audit", async () => {
        const { attempt } = await seed(), prepared = prepareRuntimeOutcomeRetention(attempt);
        const queries = jest.spyOn(source.logger, "logQuery");
        const [first, second] = await Promise.all([executePreparedRetentionTransaction(source, prepared), executePreparedRetentionTransaction(source, prepared)]);
        expect(first).toEqual(second); expect(await rows()).toEqual([first]);
        expect(await source.query("SELECT * FROM pricing_audit_events WHERE action='cost.outcome_retained'")).toHaveLength(1);
        expect(queries.mock.calls.filter(([sql]) => sql.startsWith("/* siftgate_transaction_read_prelude:2 */"))).toHaveLength(2);
        expect(queries.mock.calls.filter(([sql]) => sql === "COMMIT")).toHaveLength(2);
        expect(await source.query("SELECT * FROM pricing_budget_effects WHERE kind='commit'")).toEqual([]);
      });
    }
    it("retention reads one bounded state after its request fence without joining budget application", async () => {
      const { attempt, settlement } = await seed();
      for (const outcome of [attempt, settlement]) {
        const queries = jest.spyOn(source.logger, "logQuery");
        const row = await ledger.retainRuntimeOutcome(outcome);
        const reads = queries.mock.calls.map(([sql]) => sql).filter(sql => sql.startsWith("SELECT") || sql.startsWith("/* siftgate_transaction_read_prelude:"));
        const postgres = source.options.type === "postgres";
        expect(reads).toHaveLength(postgres ? 1 : 3);
        if (postgres) {
          // One wire request now includes real START plus TWO separately executed SELECTs.
          const statements = reads[0].split(';\n');
          expect(statements).toHaveLength(3);
          expect(statements[0]).toBe("/* siftgate_transaction_read_prelude:2 */\nSTART TRANSACTION");
          expect(statements[1]).toContain('FOR UPDATE OF s');
          expect(statements[2]).toMatch(/^SELECT o\.\*/);
          expect(reads[0]).toContain('FROM "pricing_request_snapshots"');
          expect(reads[0]).toContain('SELECT r.request_id FROM pricing_reservations');
          expect(reads[0]).toContain('FOR UPDATE OF s');
        } else {
          expect(reads[0]).toContain('FROM "pricing_reservations"');
          expect(reads[1]).toContain('FROM "pricing_request_snapshots"');
        }
        expect(reads.at(-1)).toContain('"retention_request_id"');
        expect(reads.at(-1)).toContain('"retention_receipt_count"');
        expect(reads.every(sql => !sql.includes('budget_rules'))).toBe(true);
        expect(row.state).toBe("pending");
        queries.mockRestore();
      }
      expect(await source.query("SELECT * FROM pricing_budget_effects WHERE kind = 'commit'")).toEqual([]);
      expect(await source.query("SELECT * FROM pricing_settlement_intents")).toEqual([]);
      expect((await rows()).map(row => row.state)).toEqual(["pending", "pending"]);
    });
    it.each(["missing", "foreign", "different-request", "different-reservation"] as const)("retention state refuses %s receipt membership before inserting evidence", async defect => {
      const { attempt } = await seed();
      if (defect === "different-request" || defect === "different-reservation") await seed("different");
      if (defect === "missing") await source.createQueryBuilder().delete().from("pricing_attempts").where("id = :id", { id: "a-r1" }).execute();
      else await source.createQueryBuilder().update("pricing_attempts").set(
        defect === "foreign" ? { workspace_id: "foreign" } : defect === "different-request" ? { request_id: "different" } : { reservation_id: "different" },
      ).where("id = :id", { id: "a-r1" }).execute();
      await expect(ledger.retainRuntimeOutcome(attempt)).rejects.toMatchObject({ status: 404 });
      expect(await rows()).toEqual([]);
      expect(await source.query("SELECT * FROM pricing_audit_events WHERE action = 'cost.outcome_retained'")).toEqual([]);
    });
    it("retention rejects a changed request edge after locking rather than preserving stale ownership", async () => {
      const { attempt } = await seed();
      await seed("different");
      const runner = source.createQueryRunner(); await runner.connect(); await runner.startTransaction();
      const query = runner.query.bind(runner);
      let moved = false;
      const spy = jest.spyOn(runner, "query").mockImplementation(async (...args: Parameters<QueryRunner["query"]>) => {
        const result = await query(...args);
        if (!moved && args[0].startsWith("SELECT") && args[0].includes('FROM "pricing_request_snapshots"')) {
          moved = true;
          await runner.manager.createQueryBuilder().update("pricing_reservations").set({ request_id: "different" }).where("id = :id", { id: "r1" }).execute();
        }
        return result;
      });
      try {
        await expect(retainRuntimeOutcome(runner.manager, attempt)).rejects.toMatchObject({ status: 409 });
        expect(moved).toBe(true);
        expect(await runner.manager.createQueryBuilder().select("o.id").from("pricing_runtime_outcomes", "o").getRawMany()).toEqual([]);
      } finally { spy.mockRestore(); await runner.rollbackTransaction(); await runner.release(); }
    });
    it("requires an explicit transaction for the post-fence retention state", async () => {
      const { attempt } = await seed();
      await expect(retainRuntimeOutcome(source.manager, attempt)).rejects.toMatchObject({ status: 409 });
      expect(await rows()).toEqual([]);
    });
    it.each(["delivered", "review_required"] as const)("does not reconstruct a missing body behind an orphan %s marker", async state => {
      const { attempt } = await seed();
      const original = await ledger.retainRuntimeOutcome(attempt);
      await source.transaction(manager => transitionRuntimeOutcome(manager, original, state));
      await source.createQueryBuilder().delete().from("pricing_runtime_outcomes").where("id = :id", { id: original.id }).execute();
      const before = await source.query("SELECT * FROM pricing_audit_events ORDER BY id");
      await expect(ledger.retainRuntimeOutcome(attempt)).rejects.toMatchObject({ status: 409 });
      expect(await rows()).toEqual([]);
      expect(await source.query("SELECT * FROM pricing_audit_events ORDER BY id")).toEqual(before);
    });
    it.each(["actor", "action", "metadata"] as const)("rejects an orphan retained marker with different %s without rewriting it", async defect => {
      const { attempt } = await seed();
      const original = await ledger.retainRuntimeOutcome(attempt);
      await source.createQueryBuilder().delete().from("pricing_runtime_outcomes").where("id = :id", { id: original.id }).execute();
      await source.createQueryBuilder().update("pricing_audit_events").set(
        defect === "actor" ? { actor_id: "different" } : defect === "action" ? { action: "different" } : { metadata_json: "{}" },
      ).where("id = :id", { id: `${original.id}:retained` }).execute();
      const before = await source.query("SELECT * FROM pricing_audit_events ORDER BY id");
      await expect(ledger.retainRuntimeOutcome(attempt)).rejects.toMatchObject({ status: 409 });
      expect(await rows()).toEqual([]);
      expect(await source.query("SELECT * FROM pricing_audit_events ORDER BY id")).toEqual(before);
    });
    it("rechecks task ownership after the request fence without leaking joined fields into the outcome", async () => {
      const { attempt } = await seed();
      const runner = source.createQueryRunner(); await runner.connect(); await runner.startTransaction();
      const query = runner.query.bind(runner); let attached = false;
      const spy = jest.spyOn(runner, "query").mockImplementation(async (...args: Parameters<QueryRunner["query"]>) => {
        const result = await query(...args);
        if (!attached && args[0].startsWith("SELECT") && args[0].includes('FROM "pricing_request_snapshots"')) {
          attached = true;
          await runner.manager.createQueryBuilder().update("pricing_reservations").set({ job_id: "after-fence" }).where("id = :id", { id: "r1" }).execute();
        }
        return result;
      });
      try {
        const retained = await retainRuntimeOutcome(runner.manager, attempt);
        expect(retained.state).toBe("review_required");
        expect(Object.keys(retained).some(key => key.startsWith("retention_") || key === "async_task")).toBe(false);
        expect(await verifyRuntimeOutcome(runner.manager, retained)).toEqual(attempt);
      } finally { spy.mockRestore(); await runner.rollbackTransaction(); await runner.release(); }
    });
    it("captures before a deferred transaction without retaining caller-owned objects or mutable returned rows", async () => {
      const { attempt } = await seed();
      if (attempt.type !== "attempt") throw new Error("Expected attempt fixture");
      const original = runtimeOutcomeDocument(attempt), persist = prepareRuntimeOutcomeRetention(attempt);
      attempt.workspace = "foreign";
      attempt.cost.lines[0].rate = "999";
      attempt.cost.amount = "999";
      const row = await source.transaction(persist);
      expect(row.outcome_json).toBe(original.json); expect(row.outcome_hash).toBe(original.hash); expect(row.id).toBe(original.id);
      expect(JSON.parse(row.outcome_json)).toEqual(original.outcome);
      row.outcome_json = "{}"; row.outcome_hash = "forged"; row.state = "delivered";
      const again = await source.transaction(persist);
      expect(again).toMatchObject({ outcome_json: original.json, outcome_hash: original.hash, state: "pending" });
      expect(await rows()).toHaveLength(1);
      expect(await source.query("SELECT * FROM pricing_audit_events WHERE action = 'cost.outcome_retained'")).toHaveLength(1);
      expect(await source.query("SELECT * FROM pricing_budget_effects WHERE kind = 'commit'")).toEqual([]);
    });
    it("batched acknowledgements require an owned transaction, distinct identities and a bounded same-reservation set", async () => {
      const first = await seed(), second = await seed("r2");
      const a = await ledger.retainRuntimeOutcome(first.attempt), b = await ledger.retainRuntimeOutcome(second.attempt);
      const before = await dump(), queries = jest.spyOn(source.logger, "logQuery");
      await expect(acknowledgeRuntimeOutcomes(source.manager, [a])).rejects.toMatchObject({ status: 409 });
      expect(queries.mock.calls).toHaveLength(0); queries.mockRestore();
      for (const entries of [[], [a, a], [a, b], Array(130).fill(a)])
        await expect(source.transaction(manager => acknowledgeRuntimeOutcomes(manager, entries))).rejects.toMatchObject({ status: 409 });
      expect(await dump()).toEqual(before);
    });

    it("batched acknowledgements capture caller identities before waiting and revalidate delivered audit markers", async () => {
      const seeded = await seed(), attempt = await ledger.retainRuntimeOutcome(seeded.attempt), settlement = await ledger.retainRuntimeOutcome(seeded.settlement);
      const original = [{ ...attempt }, { ...settlement }];
      const acknowledged = await source.transaction(async manager => {
        const pending = acknowledgeRuntimeOutcomes(manager, original);
        original[0].outcome_json = "{}"; original[1].workspace_id = "foreign";
        return pending;
      });
      expect(acknowledged.map(row => row.state)).toEqual(["delivered", "delivered"]);
      const before = await dump();
      await source.transaction(manager => acknowledgeRuntimeOutcomes(manager, [attempt, settlement]));
      expect(await dump()).toEqual(before);
      await source.createQueryBuilder().delete().from("pricing_audit_events").where("id = :id", { id: `${attempt.id}:delivered` }).execute();
      await expect(source.transaction(manager => acknowledgeRuntimeOutcomes(manager, [attempt, settlement]))).rejects.toMatchObject({ status: 409 });
    });

    it.each(["body", "audit", "quarantine", "missing", "ownership"] as const)("batched acknowledgements reject later %s damage before any transition writes", async defect => {
      const seeded = await seed(), attempt = await ledger.retainRuntimeOutcome(seeded.attempt), settlement = await ledger.retainRuntimeOutcome(seeded.settlement);
      if (defect === "body") await source.createQueryBuilder().update("pricing_runtime_outcomes").set({ outcome_json: "{}" }).where("id = :id", { id: settlement.id }).execute();
      if (defect === "ownership") await source.createQueryBuilder().update("pricing_runtime_outcomes").set({ request_id: "foreign" }).where("id = :id", { id: settlement.id }).execute();
      if (defect === "audit") await source.createQueryBuilder().delete().from("pricing_audit_events").where("id = :id", { id: `${settlement.id}:retained` }).execute();
      if (defect === "missing") await source.createQueryBuilder().delete().from("pricing_runtime_outcomes").where("id = :id", { id: settlement.id }).execute();
      if (defect === "quarantine") await ledger.archiveRuntimeOutcome(seeded.settlement);
      const before = await dump(), queries = jest.spyOn(source.logger, "logQuery");
      await expect(source.transaction(manager => acknowledgeRuntimeOutcomes(manager, [attempt, settlement]))).rejects.toMatchObject({ status: defect === "missing" ? 404 : 409 });
      expect(queries.mock.calls.some(([sql]) => /^(INSERT|UPDATE|WITH pricing_outcome_updates)/.test(sql))).toBe(false);
      queries.mockRestore(); expect(await dump()).toEqual(before);
    });

    it("batched acknowledgements roll back earlier transition writes if a later audit insert fails", async () => {
      const seeded = await seed(), attempt = await ledger.retainRuntimeOutcome(seeded.attempt), settlement = await ledger.retainRuntimeOutcome(seeded.settlement), before = await dump();
      const restore = await rejectAudit("Synthetic batch audit failure", `${settlement.id}:delivered`);
      try {
        await expect(source.transaction(manager => acknowledgeRuntimeOutcomes(manager, [attempt, settlement]))).rejects.toThrow("Synthetic batch audit failure");
        expect(await dump()).toEqual(before);
      } finally { await restore(); }
    });

    it("transition audit inserts only after verifying all existing markers, without a redundant per-event lookup", async () => {
      const { attempt } = await seed(), retained = await ledger.retainRuntimeOutcome(attempt);
      const queries = jest.spyOn(source.logger, "logQuery");
      await source.transaction(manager => transitionRuntimeOutcome(manager, retained, "delivered"));
      const auditReads = queries.mock.calls.map(([sql]) => sql).filter(sql => sql.startsWith("SELECT") && sql.includes('FROM "pricing_audit_events"'));
      expect(auditReads).toHaveLength(1);
      expect(auditReads[0]).toContain("LIMIT 3");
      expect((await rows())[0].state).toBe("delivered");
      expect(await source.query("SELECT * FROM pricing_audit_events WHERE action = 'cost.outcome_delivered'")).toHaveLength(1);
    });
    it.each(["original-request", "original-workspace", "persisted-request"])("transition audit rejects mismatched %s ownership without delivery", async mismatch => {
      const { attempt } = await seed(), retained = await ledger.retainRuntimeOutcome(attempt);
      const proposed = { ...retained };
      if (mismatch === "original-request") proposed.request_id = "foreign-request";
      if (mismatch === "original-workspace") proposed.workspace_id = "foreign-workspace";
      if (mismatch === "persisted-request") {
        await source.createQueryBuilder().update("pricing_runtime_outcomes").set({ request_id: "foreign-request" }).where("id = :id", { id: retained.id }).execute();
        const marker = (await source.query("SELECT * FROM pricing_audit_events WHERE id = " + (source.options.type === "postgres" ? "$1" : "?"), [`${retained.id}:retained`]))[0];
        const metadata = { ...JSON.parse(marker.metadata_json), request_id: "foreign-request" };
        await source.createQueryBuilder().update("pricing_audit_events").set({ metadata_json: JSON.stringify(metadata) }).where("id = :id", { id: marker.id }).execute();
      }
      await expect(source.transaction(manager => transitionRuntimeOutcome(manager, proposed, "delivered"))).rejects.toMatchObject({ status: 409 });
      expect((await rows())[0].state).toBe("pending");
      expect(await source.query("SELECT * FROM pricing_audit_events WHERE action = 'cost.outcome_delivered'")).toEqual([]);
      expect((await ledger.summary("r1", workspace))!.attempts[0].cost).toBeNull();
    });
    it("transition audit rejects a missing stored outcome with a structured error", async () => {
      const { attempt } = await seed(), retained = await ledger.retainRuntimeOutcome(attempt);
      await source.createQueryBuilder().delete().from("pricing_runtime_outcomes").where("id = :id", { id: retained.id }).execute();
      await expect(source.transaction(manager => transitionRuntimeOutcome(manager, retained, "delivered"))).rejects.toMatchObject({ status: 404 });
      expect(await source.query("SELECT * FROM pricing_audit_events WHERE action = 'cost.outcome_delivered'")).toEqual([]);
    });
    it("rechecks persisted bytes and mandatory audit on every execution of a prepared retention", async () => {
      const { attempt } = await seed(), persist = prepareRuntimeOutcomeRetention(attempt);
      const row = await source.transaction(persist);
      await source.createQueryBuilder().update("pricing_runtime_outcomes").set({ outcome_json: "{}" }).where("id = :id", { id: row.id }).execute();
      await expect(source.transaction(persist)).rejects.toThrow();
      await source.createQueryBuilder().update("pricing_runtime_outcomes").set({ outcome_json: row.outcome_json }).where("id = :id", { id: row.id }).execute();
      await source.createQueryBuilder().delete().from("pricing_audit_events").where("id = :id", { id: `${row.id}:retained` }).execute();
      await expect(source.transaction(persist)).rejects.toMatchObject({ status: 409 });
      expect((await ledger.summary("r1", workspace))!.attempts[0].cost).toBeNull();
    });
    it("validates raw retention and the serialized stream kind before permitting prepared writes", async () => {
      const { attempt, settlement } = await seed();
      expect(() => prepareRuntimeOutcomeRetention({ ...attempt, provider_headers: { secret: "synthetic" } } as PricingOutcome)).toThrow();
      await expect(source.transaction(manager => retainRuntimeOutcome(manager, { ...attempt, raw_body: "synthetic" } as PricingOutcome))).rejects.toMatchObject({ status: 400 });
      expect(() => prepareRuntimeOutcomeRetention(settlement, false, "attempt")).toThrow("Stream retention requires an attempt receipt");
      const disguised = { ...attempt, toJSON: () => settlement } as PricingOutcome;
      await expect(ledger.prepareStreamReceipt(disguised as Extract<PricingOutcome, { type: "attempt" }>)).rejects.toMatchObject({ status: 409 });
      expect(await rows()).toEqual([]);
    });
    it("retains a stream receipt before delivery and applies only its captured body exactly once", async () => {
      const { attempt, cost } = await seed();
      if (attempt.type !== "attempt") throw new Error("Expected attempt fixture");
      const deliver = await ledger.prepareStreamReceipt(attempt);
      const retained = await rows(); expect(retained).toHaveLength(1); expect(retained[0].state).toBe("pending");
      expect((await source.query("SELECT state,cost_json FROM pricing_attempts"))[0]).toMatchObject({ state: "dispatched", cost_json: null });
      attempt.cost = { ...cost, amount: "999", report_amount: "999" };
      const first = deliver(); expect(deliver()).toBe(first); await first;
      expect((await rows())[0].state).toBe("delivered");
      expect(JSON.parse((await source.query("SELECT cost_json FROM pricing_attempts"))[0].cost_json).amount).toBe(cost.amount);
      expect(await source.query("SELECT * FROM pricing_budget_effects WHERE kind = 'commit'")).toHaveLength(0);
    });
    it("restores a retained stream receipt with a fresh service without its in-memory delivery callback", async () => {
      const { attempt, cost } = await seed(); if (attempt.type !== "attempt") throw new Error("Expected attempt fixture");
      await ledger.prepareStreamReceipt(attempt);
      const cold = makeLedger(source); await cold.replayRuntimeOutcomes(new Date(Date.now() + 120000));
      expect((await rows())[0].state).toBe("delivered");
      expect(JSON.parse((await source.query("SELECT cost_json FROM pricing_attempts"))[0].cost_json).amount).toBe(cost.amount);
      const before = await rows(); await cold.replayRuntimeOutcomes(new Date(Date.now() + 240000)); expect(await rows()).toEqual(before);
    });
    it("rolls back a stream delivery when its mandatory acknowledgement audit fails", async () => {
      const { attempt } = await seed(); if (attempt.type !== "attempt") throw new Error("Expected attempt fixture");
      const deliver = await ledger.prepareStreamReceipt(attempt), original = InsertQueryBuilder.prototype.execute;
      const fault = jest.spyOn(InsertQueryBuilder.prototype, "execute").mockImplementation(function (this: InsertQueryBuilder<Record<string, unknown>>) {
        if (this.getQuery().includes('pricing_audit_events') && JSON.stringify(this.getParameters()).includes('cost.outcome_delivered'))
          throw new Error("Synthetic delivery acknowledgement failed");
        return original.call(this);
      });
      await expect(deliver()).rejects.toThrow("Synthetic delivery acknowledgement failed"); fault.mockRestore();
      expect((await rows())[0].state).toBe("pending");
      expect((await source.query("SELECT state,cost_json FROM pricing_attempts"))[0]).toMatchObject({ state: "dispatched", cost_json: null });
      await makeLedger(source).replayRuntimeOutcomes(new Date(Date.now() + 120000)); expect((await rows())[0].state).toBe("delivered");
    });
    it("does not bypass a conflicting retained body or workspace ownership on prepared stream delivery", async () => {
      const { attempt, different } = await seed(); if (attempt.type !== "attempt" || different.type !== "attempt") throw new Error("Expected attempt fixture");
      await expect(ledger.prepareStreamReceipt({ ...attempt, workspace: "foreign" })).rejects.toMatchObject({ status: 404 });
      await ledger.persistRuntimeOutcome(attempt);
      const deliver = await ledger.prepareStreamReceipt(different);
      await expect(deliver()).rejects.toMatchObject({ status: 409 });
      expect((await rows()).some(row => row.state === "review_required")).toBe(true);
    });
    it("deduplicates prepared delivery racing fresh-connection replay", async () => {
      const { attempt } = await seed(); if (attempt.type !== "attempt") throw new Error("Expected attempt fixture");
      const deliver = await ledger.prepareStreamReceipt(attempt);
      const connection = await new DataSource({ ...source.options, synchronize: false }).initialize();
      try {
        const replay = makeLedger(connection);
        await Promise.all([deliver(), replay.replayRuntimeOutcomes(new Date(Date.now() + 120000))]);
        expect((await rows()).map(row => row.state)).toEqual(["delivered"]);
        expect(await source.query("SELECT * FROM pricing_audit_events WHERE action = 'cost.outcome_delivered'")).toHaveLength(1);
        expect((await ledger.summary("r1", workspace))!.attempts[0].cost).toEqual(attempt.cost);
      } finally { await connection.destroy(); }
    });
    it("does not clear quarantine applied after stream preparation", async () => {
      const { attempt } = await seed(); if (attempt.type !== "attempt") throw new Error("Expected attempt fixture");
      const deliver = await ledger.prepareStreamReceipt(attempt);
      await ledger.archiveRuntimeOutcome(attempt);
      await deliver();
      expect((await rows())[0].state).toBe("review_required");
      expect(await source.query("SELECT * FROM pricing_budget_effects WHERE kind = 'commit'")).toHaveLength(0);
    });
    const dump = async () => {
      const all: Record<string, unknown> = {};
      for (const name of [
        "pricing_runtime_outcomes",
        "pricing_audit_events",
        "pricing_attempts",
        "pricing_settlement_intents",
        "pricing_reservations",
        "pricing_budget_balances",
        "pricing_budget_effects",
        "pricing_cost_adjustments",
        "budget_rules",
      ])
        all[name] = await source.query(`SELECT * FROM ${name}`);
      return all;
    };
    it("retains before delivery with immutable hashes and no cost or budget effects", async () => {
      const { attempt } = await seed(),
        before = await dump(),
        row = await ledger.retainRuntimeOutcome(attempt);
      expect(row.state).toBe("pending");
      expect(row.source).toBe("gateway_runtime");
      const after = await dump();
      for (const table of [
        "pricing_attempts",
        "pricing_reservations",
        "pricing_budget_balances",
        "budget_rules",
      ])
        expect(after[table]).toEqual(before[table]);
      expect(await ledger.runtimeOutcome(row.id, workspace)).toMatchObject({
        outcome: JSON.parse(JSON.stringify(attempt)),
        supplier_confirmed: false,
        read_only: true,
      });
      const recorded = await dump();
      await ledger.retainRuntimeOutcome(attempt);
      expect(await dump()).toEqual(recorded);
    });
    it("delivers exact receipts/intents and replays without a second budget effect", async () => {
      const { attempt, settlement } = await seed();
      await ledger.retainRuntimeOutcome(attempt);
      await ledger.retainRuntimeOutcome(settlement);
      expect(
        await ledger.replayRuntimeOutcomes(new Date(Date.now() + 2000)),
      ).toMatchObject({ persisted: 2 });
      await ledger.reconcilePending();
      const before = await dump();
      await ledger.persistRuntimeOutcome(attempt);
      await ledger.persistRuntimeOutcome(settlement);
      await ledger.reconcilePending();
      expect(await dump()).toEqual(before);
      expect(
        (await ledger.summary("r1", workspace))!.budget_committed_usd,
      ).toBe("0.001200000000000000");
    });
    it.each(["attempt", "settlement"] as const)("uses two durable transactions for %s retention and acknowledged delivery", async (kind) => {
      const seeded = await seed();
      const before = await source.query("SELECT * FROM budget_rules");
      const transactions = jest.spyOn(source, "transaction");
      await ledger.persistRuntimeOutcome(seeded[kind]);
      expect(transactions).toHaveBeenCalledTimes(2);
      transactions.mockRestore();
      expect((await rows())[0].state).toBe("delivered");
      expect(await source.query("SELECT * FROM budget_rules")).toEqual(before);
      expect(await source.query("SELECT * FROM pricing_audit_events WHERE action = 'cost.outcome_retained'")).toHaveLength(1);
      expect(await source.query("SELECT * FROM pricing_audit_events WHERE action = 'cost.outcome_delivered'")).toHaveLength(1);
    });
    it.each([{ kind: "attempt", yieldAfterRetention: true }, { kind: "settlement", yieldAfterRetention: true }, { kind: "settlement", yieldAfterRetention: false }] as const)("commits $kind independently with an explicit I/O scheduling hint ($yieldAfterRetention)", async ({ kind, yieldAfterRetention }) => {
      const fixture = await seed(), outcome = fixture[kind];
      const internal = ledger as unknown as {
        retentionWrite(action: (manager: EntityManager) => Promise<RuntimeOutcomeRow>): Promise<RuntimeOutcomeRow>;
      };
      const write = internal.retentionWrite.bind(internal);
      let observed = false, transactionActive: boolean | undefined;
      let inspect!: () => void;
      const probe = new Promise<void>(resolve => { inspect = resolve; });
      jest.spyOn(internal, "retentionWrite").mockImplementationOnce(async action => {
        let runner: QueryRunner | undefined;
        const retained = await write(manager => {
          runner = manager.queryRunner;
          return action(manager);
        });
        setImmediate(() => {
          observed = true;
          transactionActive = runner?.isTransactionActive;
          inspect();
        });
        return retained;
      });
      const retained = await ledger.retainRuntimeOutcome(outcome, yieldAfterRetention);
      if (source.options.type === "better-sqlite3") expect(observed).toBe(yieldAfterRetention);
      await probe;
      expect(transactionActive).toBe(false);
      expect((await ledger.runtimeOutcome(retained.id, workspace)).outcome).toEqual(outcome);
      expect((await rows())[0].state).toBe("pending");
    });
    it.each(["attempt", "settlement"] as const)("rolls back %s delivery when its mandatory acknowledgement fails, retaining replayable evidence", async (kind) => {
      const seeded = await seed();
      const outcome = seeded[kind], before = await dump();
      const execute = InsertQueryBuilder.prototype.execute;
      const fail = jest.spyOn(InsertQueryBuilder.prototype, "execute").mockImplementation(function () {
        const values: Array<{ action?: unknown } | undefined> = Array.isArray(this.expressionMap.valuesSet) ? this.expressionMap.valuesSet : [this.expressionMap.valuesSet];
        if (this.expressionMap.mainAlias?.tablePath === "pricing_audit_events" && values.some(value => value?.action === "cost.outcome_delivered"))
          throw new Error("required delivery audit unavailable");
        return execute.call(this);
      });
      await expect(ledger.persistRuntimeOutcome(outcome)).rejects.toThrow("required delivery audit");
      fail.mockRestore();
      const after = await dump();
      for (const table of ["pricing_attempts", "pricing_settlement_intents", "pricing_reservations", "pricing_budget_balances", "budget_rules"])
        expect(after[table]).toEqual(before[table]);
      expect((await rows())[0]).toMatchObject({ state: "pending", last_error_code: "storage_unavailable", delivered_at: null });
      expect(JSON.parse((await rows())[0].outcome_json)).toEqual(outcome);
      expect(await source.query("SELECT * FROM pricing_audit_events WHERE action = 'cost.outcome_retained'")).toHaveLength(1);
      expect(await source.query("SELECT * FROM pricing_audit_events WHERE action = 'cost.outcome_delivered'")).toHaveLength(0);
      ledger = makeLedger(source);
      expect(await ledger.replayRuntimeOutcomes(new Date(Date.now() + 2000))).toMatchObject({ persisted: 1 });
      await ledger.reconcilePending();
      const recovered = await dump();
      await ledger.persistRuntimeOutcome(outcome);
      await ledger.reconcilePending();
      expect(await dump()).toEqual(recovered);
      expect((await ledger.summary("r1", workspace))!.attempts[0].cost).toEqual(seeded.cost);
    });
    it("rejects acknowledgement bodies that do not match the receipt, settlement or request being delivered", async () => {
      const { attempt, different, settlement } = await seed();
      const other = await seed("other");
      const receipt = await ledger.retainRuntimeOutcome(attempt);
      const intent = await ledger.retainRuntimeOutcome(settlement);
      const before = await dump();
      await expect(ledger.completeAttempt(attempt.attemptId, workspace, different.cost, null, receipt.id, receipt)).rejects.toMatchObject({ status: 409 });
      await expect(ledger.completeAttempt(other.attempt.attemptId, workspace, other.cost, null, receipt.id, receipt)).rejects.toMatchObject({ status: 409 });
      const p = settlement.payload;
      await expect(ledger.queueSettlement("r1", workspace, p.kind, p.tokens, "1", p.budget_basis, p.receipt, p.receipts, intent.id, p.budget_attempt_id, intent)).rejects.toMatchObject({ status: 409 });
      expect(await dump()).toEqual(before);
    });
    it("quarantines every differing terminal receipt without replacing original evidence", async () => {
      const { attempt, different } = await seed();
      await ledger.persistRuntimeOutcome(attempt);
      const original = await source.query("SELECT * FROM pricing_attempts");
      await expect(
        ledger.persistRuntimeOutcome(different),
      ).rejects.toMatchObject({ status: 409 });
      expect(await rows()).toHaveLength(2);
      expect((await rows()).map((row) => row.state).sort()).toEqual([
        "delivered",
        "review_required",
      ]);
      expect(await source.query("SELECT * FROM pricing_attempts")).toEqual(
        original,
      );
      expect(
        (
          await ledger.runtimeOutcome(
            runtimeOutcomeDocument(different).id,
            workspace,
          )
        ).outcome,
      ).toEqual(different);
    });
    it("preserves a conflicting arrival while the first writer is still running", async () => {
      const { attempt, different } = await seed();
      let release!: () => void, entered!: () => void;
      const gate = new Promise<void>((resolve) => {
          release = resolve;
        }),
        ready = new Promise<void>((resolve) => {
          entered = resolve;
        });
      const complete = ledger.completeAttempt.bind(ledger);
      jest
        .spyOn(ledger, "completeAttempt")
        .mockImplementationOnce(async (...args) => {
          entered();
          await gate;
          return complete(...args);
        });
      const buffer = new PricingOutcomeRetryBuffer(
        (outcome) => ledger.persistRuntimeOutcome(outcome),
        undefined,
        (outcome) => ledger.archiveRuntimeOutcome(outcome),
      );
      const first = buffer.persist(attempt);
      await ready;
      expect(await buffer.persist(different)).toBe("review_required");
      release();
      await first;
      expect(buffer.status()).toMatchObject({ entries: 0, archived: 1 });
      expect(await rows()).toHaveLength(2);
      expect(
        (
          await ledger.runtimeOutcome(
            runtimeOutcomeDocument(different).id,
            workspace,
          )
        ).state,
      ).toBe("review_required");
      expect((await ledger.summary("r1", workspace))!.attempts[0].cost).toEqual(
        attempt.cost,
      );
    });
    it("reconstructs a fresh service after a transient failure from durable evidence only", async () => {
      const { attempt } = await seed();
      const fail = jest
        .spyOn(ledger, "completeAttempt")
        .mockRejectedValueOnce(new Error("synthetic unavailable storage"));
      await expect(ledger.persistRuntimeOutcome(attempt)).rejects.toThrow(
        "synthetic",
      );
      fail.mockRestore();
      ledger = makeLedger(source);
      expect(
        await ledger.replayRuntimeOutcomes(new Date(Date.now() + 2000)),
      ).toMatchObject({ persisted: 1 });
      expect((await ledger.summary("r1", workspace))!.attempts[0].cost).toEqual(
        attempt.cost,
      );
    });
    it("recovers a delivered receipt whose journal acknowledgement was lost", async () => {
      const { attempt } = await seed();
      await ledger.retainRuntimeOutcome(attempt);
      await ledger.completeAttempt(attempt.attemptId, workspace, attempt.cost);
      const before = await source.query("SELECT * FROM pricing_attempts");
      ledger = makeLedger(source);
      await ledger.replayRuntimeOutcomes(new Date(Date.now() + 2000));
      expect(await source.query("SELECT * FROM pricing_attempts")).toEqual(
        before,
      );
      expect((await rows())[0].state).toBe("delivered");
    });
    it("does not let a late writer clear a durable quarantine", async () => {
      const { attempt } = await seed();
      let release!: () => void, entered!: () => void;
      const gate = new Promise<void>((resolve) => {
          release = resolve;
        }),
        ready = new Promise<void>((resolve) => {
          entered = resolve;
        });
      const complete = ledger.completeAttempt.bind(ledger);
      jest
        .spyOn(ledger, "completeAttempt")
        .mockImplementationOnce(async (...args) => {
          entered();
          await gate;
          return complete(...args);
        });
      const first = ledger.persistRuntimeOutcome(attempt);
      await ready;
      await ledger.archiveRuntimeOutcome(attempt);
      release();
      await first;
      expect((await rows())[0].state).toBe("review_required");
    });
    it("keeps supplier-runtime evidence when an administrator estimate won first", async () => {
      const { attempt, different, settlement } = await seed();
      await ledger.persistRuntimeOutcome(attempt);
      await ledger.persistRuntimeOutcome(settlement);
      await ledger.reconcilePending();
      const basis = await ledger.attemptCorrectionBasis(
        attempt.attemptId,
        workspace,
      );
      const corrected = await new PricingAttemptCorrectionService(
        ledger,
        prices,
      ).correct(
        actor,
        attempt.attemptId,
        {
          id: "manual-first",
          expected_basis_hash: basis.basis_hash,
          expected_cost_hash: basis.effective_cost_hash,
          confirm: true,
          reason: "Synthetic reviewed estimate",
          evidence: Object.values(different.cost.usage.quantities).map((q) => ({
            dimension: q!.dimension,
            value: q!.value,
          })),
        },
        false,
      );
      await expect(
        ledger.persistRuntimeOutcome(different),
      ).rejects.toMatchObject({ status: 409 });
      expect(
        (await ledger.summary("r1", workspace))!.attempts[0].effective_cost,
      ).toEqual(corrected.cost);
      expect(
        (
          await ledger.runtimeOutcome(
            runtimeOutcomeDocument(different).id,
            workspace,
          )
        ).outcome,
      ).toEqual(different);
    });
    it("rolls back the entire first retention when mandatory audit fails", async () => {
      const { attempt } = await seed(),
        before = await dump();
      const restore = await rejectAudit("required audit unavailable");
      try {
        await expect(ledger.retainRuntimeOutcome(attempt)).rejects.toThrow("required audit");
        expect(await dump()).toEqual(before);
      } finally { await restore(); }
    });
    it("rejects out-of-scope or mismatched attempt/hold evidence without retained rows", async () => {
      const { attempt } = await seed();
      await seed("other");
      const before = await dump();
      for (const value of [
        { ...attempt, workspace: "foreign" },
        { ...attempt, reservationId: "other" },
        { ...attempt, attemptId: "absent" },
      ])
        await expect(ledger.retainRuntimeOutcome(value)).rejects.toMatchObject({
          status: 404,
        });
      expect(await dump()).toEqual(before);
    });
    it("rejects non-allowlisted raw bodies, nested secrets, estimates and invalid error strings", async () => {
      const { attempt } = await seed(),
        before = await dump();
      const variants = [
        { ...attempt, raw_response: "PRIVATE" },
        {
          ...attempt,
          cost: { ...attempt.cost, headers: { authorization: "PRIVATE" } },
        },
        {
          ...attempt,
          cost: {
            ...attempt.cost,
            usage: { ...attempt.cost.usage, raw: "PRIVATE" },
          },
        },
        { ...attempt, cost: { ...attempt.cost, admission: {} } },
        { ...attempt, errorCode: "provider secret body" },
      ];
      for (const value of variants)
        await expect(
          ledger.retainRuntimeOutcome(value as PricingOutcome),
        ).rejects.toMatchObject({ status: 400 });
      expect(await dump()).toEqual(before);
    });
    it("fails closed on tampered receipt bytes or missing mandatory audit", async () => {
      const { attempt } = await seed(),
        row = await ledger.retainRuntimeOutcome(attempt);
      await source
        .createQueryBuilder()
        .update("pricing_runtime_outcomes")
        .set({ outcome_json: "{}" })
        .where("id = :id", { id: row.id })
        .execute();
      await expect(ledger.runtimeOutcome(row.id, workspace)).rejects.toThrow();
      await source
        .createQueryBuilder()
        .update("pricing_runtime_outcomes")
        .set({ outcome_json: row.outcome_json })
        .where("id = :id", { id: row.id })
        .execute();
      await source
        .createQueryBuilder()
        .delete()
        .from("pricing_audit_events")
        .where("id = :id", { id: `${row.id}:retained` })
        .execute();
      await expect(
        ledger.runtimeOutcome(row.id, workspace),
      ).rejects.toMatchObject({ status: 409 });
      expect(
        (await ledger.summary("r1", workspace))!.attempts[0].cost,
      ).toBeNull();
    });
    it("validates every runtime transition state with one bounded audit read", async () => {
      const { attempt } = await seed(), row = await ledger.retainRuntimeOutcome(attempt);
      const [retained] = await source.query("SELECT * FROM pricing_audit_events WHERE action = 'cost.outcome_retained'");
      const before = await dump();
      for (const state of ["pending", "delivered", "review_required"] as const) {
        for (const delivered of [false, true]) for (const reviewed of [false, true]) {
          const runner = source.createQueryRunner();
          await runner.startTransaction();
          try {
            for (const event of [delivered ? "delivered" : null, reviewed ? "review_required" : null]) {
              if (event) await runner.manager.createQueryBuilder().insert().into("pricing_audit_events").values({
                ...retained, id: `${row.id}:${event}`, action: `cost.outcome_${event}`,
              }).execute();
            }
            const queries = jest.spyOn(source.logger, "logQuery");
            try {
              const verification = verifyRuntimeOutcome(runner.manager, { ...row, state });
              const valid = state === "pending" ? !delivered && !reviewed : state === "delivered" ? delivered && !reviewed : reviewed;
              if (valid) await expect(verification).resolves.toEqual(attempt);
              else await expect(verification).rejects.toThrow("state differs from its transition audit");
              const selects = queries.mock.calls.filter(([sql]) => sql.startsWith("SELECT") && sql.includes('"pricing_audit_events"'));
              expect(selects).toHaveLength(1);
              expect(selects[0][0]).toContain("LIMIT 3");
              expect(selects[0][1]).toEqual(expect.arrayContaining([
                workspace, `${row.id}:retained`, `${row.id}:delivered`, `${row.id}:review_required`,
              ]));
            } finally { queries.mockRestore(); }
          } finally { await runner.rollbackTransaction(); await runner.release(); }
        }
      }
      expect(await dump()).toEqual(before);
    });
    it("rejects missing, foreign, impersonated or corrupt runtime audits for each mandatory event", async () => {
      const { attempt } = await seed(), row = await ledger.retainRuntimeOutcome(attempt);
      const [retained] = await source.query("SELECT * FROM pricing_audit_events WHERE action = 'cost.outcome_retained'");
      const before = await dump();
      for (const event of ["retained", "delivered", "review_required"] as const) {
        for (const defect of ["missing", "foreign", "actor", "action", "metadata", "malformed-json"] as const) {
          const runner = source.createQueryRunner();
          await runner.startTransaction();
          try {
            const id = `${row.id}:${event}`;
            if (event !== "retained") await runner.manager.createQueryBuilder().insert().into("pricing_audit_events").values({
              ...retained, id, action: `cost.outcome_${event}`,
            }).execute();
            if (defect === "missing") await runner.manager.createQueryBuilder().delete().from("pricing_audit_events").where("id = :id", { id }).execute();
            else {
              const patch = defect === "foreign" ? { workspace_id: "foreign" }
                : defect === "actor" ? { actor_id: "system:untrusted" }
                : defect === "action" ? { action: "cost.outcome_invalid" }
                : { metadata_json: defect === "malformed-json" ? "{" : JSON.stringify({ ...JSON.parse(retained.metadata_json), outcome_hash: "0".repeat(64) }) };
              await runner.manager.createQueryBuilder().update("pricing_audit_events").set(patch).where("id = :id", { id }).execute();
            }
            const state = event === "retained" ? "pending" : event;
            const verification = verifyRuntimeOutcome(runner.manager, { ...row, state });
            if (defect === "malformed-json") await expect(verification).rejects.toBeInstanceOf(SyntaxError);
            else await expect(verification).rejects.toMatchObject({ status: 409 });
          } finally { await runner.rollbackTransaction(); await runner.release(); }
        }
      }
      expect(await dump()).toEqual(before);
    });
    it("ignores other outcome identities, suffix lookalikes and foreign-workspace transition audits", async () => {
      const { attempt } = await seed(), row = await ledger.retainRuntimeOutcome(attempt);
      const [retained] = await source.query("SELECT * FROM pricing_audit_events WHERE action = 'cost.outcome_retained'");
      await source.createQueryBuilder().insert().into("pricing_audit_events").values([
        { ...retained, id: `${row.id}:delivered`, workspace_id: "foreign", action: "cost.outcome_delivered" },
        { ...retained, id: `${row.id}:lookalike:review_required`, action: "cost.outcome_review_required" },
        { ...retained, id: "other-outcome:delivered", action: "cost.outcome_delivered" },
      ]).execute();
      const before = await dump();
      await expect(ledger.runtimeOutcome(row.id, workspace)).resolves.toMatchObject({
        state: "pending", outcome: JSON.parse(row.outcome_json),
      });
      expect(await dump()).toEqual(before);
    });
    it("provides bounded scoped read-only inventory and exact-detail acknowledgement", async () => {
      const a = await seed(),
        b = await seed("r2"),
        other = await seed("r3", "foreign");
      await ledger.archiveRuntimeOutcome(a.attempt);
      await ledger.archiveRuntimeOutcome(b.attempt);
      await ledger.archiveRuntimeOutcome(other.attempt);
      const before = await dump(),
        first = await ledger.runtimeOutcomeInventory(
          workspace,
          "review_required",
          1,
        );
      expect(first.items).toHaveLength(1);
      expect(first.items[0]).not.toHaveProperty("outcome_json");
      const next = await ledger.runtimeOutcomeInventory(
        workspace,
        "review_required",
        1,
        first.next_cursor!,
      );
      expect(next.items).toHaveLength(1);
      expect(next.items[0].id).not.toBe(first.items[0].id);
      expect(next.next_cursor).toBeNull();
      await expect(
        ledger.runtimeOutcomeInventory(
          "foreign",
          "review_required",
          1,
          first.next_cursor!,
        ),
      ).rejects.toMatchObject({ status: 400 });
      await expect(
        ledger.runtimeOutcome(first.items[0].id, "foreign"),
      ).rejects.toMatchObject({ status: 404 });
      await ledger.runtimeOutcome(first.items[0].id, workspace);
      expect(await dump()).toEqual(before);
    });
    it("honors retry backoff and bounds replay without changing frozen cost", async () => {
      const a = await seed(),
        b = await seed("r2");
      await ledger.retainRuntimeOutcome(a.attempt);
      await ledger.retainRuntimeOutcome(b.attempt);
      expect(
        await ledger.replayRuntimeOutcomes(new Date(Date.now() + 100), 1),
      ).toMatchObject({ persisted: 1 });
      expect(
        (await ledger.runtimeOutcomeInventory(workspace, "pending", 10)).items,
      ).toHaveLength(1);
      const fail = jest
        .spyOn(ledger, "completeAttempt")
        .mockRejectedValue(new Error("storage"));
      await ledger.replayRuntimeOutcomes(new Date(Date.now() + 100), 1);
      expect(await ledger.replayRuntimeOutcomes(new Date())).toMatchObject({
        persisted: 0,
        pending: 0,
      });
      fail.mockRestore();
      expect(
        await ledger.replayRuntimeOutcomes(new Date(Date.now() + 120000)),
      ).toMatchObject({ persisted: 1 });
    });
    it("deduplicates independent-connection concurrent ingestion and delivery", async () => {
      const { attempt } = await seed();
      const other =
        source.options.type === "postgres"
          ? await new DataSource({
              ...source.options,
              synchronize: false,
            } as ConstructorParameters<typeof DataSource>[0]).initialize()
          : source;
      try {
        const independent = makeLedger(other);
        await Promise.all([
          ledger.persistRuntimeOutcome(attempt),
          independent.persistRuntimeOutcome(attempt),
        ]);
        expect(await rows()).toHaveLength(1);
        expect((await rows())[0].state).toBe("delivered");
      } finally {
        if (other !== source) await other.destroy();
      }
    });
    it.each([false, true])("survives a real child exit after retention before immutable receipt delivery (prepared stream=%s)", async prepared => {
      const { attempt } = await seed();
      const options = {
        ...source.options,
        entities: undefined,
        synchronize: false,
      };
      const child = spawnSync(
        process.execPath,
        [
          "-r",
          "ts-node/register",
          "-e",
          `
        const {DataSource}=require('typeorm');const {CostLedgerService}=require('./src/pricing/cost-ledger.service');
        (async()=>{const source=await new DataSource(${JSON.stringify(options)}).initialize();
        const ledger=new CostLedgerService(source,{enableExactLedger(){}});
        await ledger.${prepared ? "prepareStreamReceipt" : "retainRuntimeOutcome"}(${JSON.stringify(attempt)});process.exit(39)})().catch(e=>{console.error(e);process.exit(1)});
      `,
        ],
        {
          cwd: process.cwd(),
          env: { ...process.env, TS_NODE_TRANSPILE_ONLY: "true" },
          encoding: "utf8",
          timeout: 20000,
        },
      );
      expect({ status: child.status, stderr: child.stderr }).toEqual({
        status: 39,
        stderr: "",
      });
      expect((await rows())[0].state).toBe("pending");
      expect((await source.query("SELECT state,cost_json FROM pricing_attempts"))[0]).toMatchObject({ state: "dispatched", cost_json: null });
      const connection = await new DataSource({ ...source.options, synchronize: false }).initialize();
      try {
        const restored = makeLedger(connection);
        expect(await restored.replayRuntimeOutcomes(new Date(Date.now() + 2000))).toMatchObject({ persisted: 1 });
        await restored.reconcilePending(); await restored.reconcileActualBudgets();
        expect((await restored.summary("r1", workspace))!.attempts[0].cost).toEqual(attempt.cost);
        // Receipt custody is not proof that no further dispatch was possible.
        expect((await restored.summary("r1", workspace))!.reservations[0].state).toBe("reserved");
        expect(await source.query("SELECT * FROM pricing_settlement_intents")).toHaveLength(0);
        expect(await source.query("SELECT * FROM pricing_actual_budget_cohorts")).toHaveLength(0);
        expect(await source.query("SELECT * FROM pricing_budget_effects WHERE kind='commit'")).toHaveLength(0);
        expect(await restored.replayRuntimeOutcomes(new Date(Date.now() + 4000))).toMatchObject({ persisted: 0 });
      } finally { await connection.destroy(); }
    }, 30000);
    it("uses request-first reads during independent concurrent replay and inspection", async () => {
      const { attempt } = await seed();
      const row = await ledger.retainRuntimeOutcome(attempt);
      const other =
        source.options.type === "postgres"
          ? await new DataSource({
              ...source.options,
              synchronize: false,
            } as ConstructorParameters<typeof DataSource>[0]).initialize()
          : source;
      try {
        const independent = makeLedger(other);
        const results = await Promise.all([
          ledger.replayRuntimeOutcomes(new Date(Date.now() + 2000)),
          independent.replayRuntimeOutcomes(new Date(Date.now() + 2000)),
          independent.runtimeOutcome(row.id, workspace),
        ]);
        expect(results[0].review_required).toBe(0);
        expect(results[1].review_required).toBe(0);
        expect((await rows())[0].state).toBe("delivered");
        expect(
          await source.query("SELECT * FROM pricing_runtime_outcomes"),
        ).toHaveLength(1);
      } finally {
        if (other !== source) await other.destroy();
      }
    });
    it("preserves receipt-bearing budget proposals before retiring an audited superseded decision", async () => {
      const { settlement } = await seed();
      await ledger.reconcileDispatched();
      const basis = await ledger.recoveryBasis("r1", workspace);
      await ledger.resolveRecovery("r1", actor, {
        id: "explicit-release",
        expected_basis_hash: basis.basis_hash,
        reason: "Synthetic budget-only release",
        confirm: true,
        decisions: [{ reservation_id: "r1", action: "release" }],
      });
      expect(await ledger.outcomeSuperseded(settlement)).toBe(true);
      expect((await rows())[0].state).toBe("review_required");
      expect(
        (await ledger.runtimeOutcome((await rows())[0].id, workspace)).outcome,
      ).toEqual(settlement);
      expect(
        (await ledger.summary("r1", workspace))!.attempts[0].cost,
      ).toBeNull();
      expect(
        (await ledger.summary("r1", workspace))!.budget_committed_usd,
      ).toBe("0.000000000000000000");
    });
    it("blocks another reservation based on a persisted scoped backlog even with no memory buffer", async () => {
      const { attempt } = await seed();
      const row = await ledger.retainRuntimeOutcome(attempt);
      // Integrity-damaged rows still consume unresolved capacity; never scan or
      // deserialize every body merely to decide whether admission is safe.
      for (let offset = 0; offset < 999; offset += 100)
        await source
          .createQueryBuilder()
          .insert()
          .into("pricing_runtime_outcomes", Object.keys(row))
          .values(
            Array.from({ length: Math.min(100, 999 - offset) }, (_, index) => ({
              ...row,
              id: `runtime-outcome:${(offset + index + 1).toString(16).padStart(64, "0")}`,
            })),
          )
          .execute();
      expect(await source.query("SELECT state, workspace_id, COUNT(*) AS count FROM pricing_runtime_outcomes GROUP BY state, workspace_id")).toEqual([{ state: "pending", workspace_id: workspace, count: source.options.type === "postgres" ? "1000" : 1000 }]);
      await expect(
        ledger.assertRuntimeOutcomeCapacity(workspace),
      ).rejects.toMatchObject({
        code: "pricing_recovery_backpressure",
        status: 503,
      });
      await expect(
        ledger.assertRuntimeOutcomeCapacity("foreign"),
      ).resolves.toBeUndefined();
    });
    it("does not convert non-finite amounts to missing quantities or accept malformed documents", async () => {
      const { attempt } = await seed();
      for (const value of [
        null,
        [],
        { ...attempt, cost: { ...attempt.cost, report_amount: Infinity } },
        { ...attempt, cost: { ...attempt.cost, report_amount: NaN } },
      ])
        await expect(
          ledger.retainRuntimeOutcome(value as unknown as PricingOutcome),
        ).rejects.toMatchObject({ status: 400 });
      expect(await rows()).toHaveLength(0);
    });
    it("quarantines malformed pending rows once and continues replaying valid rows", async () => {
      const first = await seed(),
        second = await seed("r2");
      const row = await ledger.retainRuntimeOutcome(first.attempt);
      await ledger.retainRuntimeOutcome(second.attempt);
      await source
        .createQueryBuilder()
        .update("pricing_runtime_outcomes")
        .set({ outcome_json: "null" })
        .where("id = :id", { id: row.id })
        .execute();
      expect(
        await ledger.replayRuntimeOutcomes(new Date(Date.now() + 2000)),
      ).toMatchObject({ persisted: 1, review_required: 1 });
      expect((await rows()).find((r) => r.id === row.id)).toMatchObject({
        state: "review_required",
        last_error_code: "evidence_integrity_invalid",
        outcome_json: "null",
      });
      expect(
        await ledger.replayRuntimeOutcomes(new Date(Date.now() + 4000)),
      ).toMatchObject({ persisted: 0, review_required: 0 });
      await expect(ledger.runtimeOutcome(row.id, workspace)).rejects.toThrow();
    });
    it("does not trust a delivered marker without its mandatory transition audit", async () => {
      const { attempt } = await seed();
      await ledger.persistRuntimeOutcome(attempt);
      const row = (await rows())[0];
      await source
        .createQueryBuilder()
        .delete()
        .from("pricing_audit_events")
        .where("id = :id", { id: `${row.id}:delivered` })
        .execute();
      await expect(
        ledger.runtimeOutcome(row.id, workspace),
      ).rejects.toMatchObject({ status: 409 });
    });
    it("copies the original input before an asynchronous retention boundary", async () => {
      const { attempt } = await seed(),
        expected = structuredClone(attempt.cost);
      const pending = ledger.persistRuntimeOutcome(attempt);
      attempt.cost.report_amount = "999";
      await pending;
      expect((await ledger.summary("r1", workspace))!.attempts[0].cost).toEqual(
        expected,
      );
    });
    it("retains standalone physical batch shares and async-owned evidence for their dedicated lifecycle", async () => {
      const { attempt } = await seed();
      const allocation = allocateBatchCost("physical-1", attempt.cost, [
        {
          request_id: "r1",
          reservation_id: "r1",
          input_start: 0,
          input_count: 1,
          weight: "1",
          weight_basis: "token_input_count",
        },
      ]);
      const batch = {
        ...attempt,
        cost: batchShareCost(allocation, 0, "physical-attempt"),
      };
      await expect(ledger.persistRuntimeOutcome(batch)).rejects.toMatchObject({
        status: 409,
      });
      expect((await rows())[0].state).toBe("review_required");
      const other = await seed("async");
      await source
        .createQueryBuilder()
        .update("pricing_reservations")
        .set({ job_id: "synthetic-job" })
        .where("id = :id", { id: "async" })
        .execute();
      await expect(
        ledger.persistRuntimeOutcome(other.attempt),
      ).rejects.toMatchObject({ status: 409 });
      expect(
        (await ledger.summary("async", workspace))!.attempts[0].cost,
      ).toBeNull();
    });
  });
}
contract("SQLite WAL durable runtime evidence", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runtime-outcomes-"));
  const source = await new DataSource({
    type: "better-sqlite3",
    database: join(directory, "ledger.db"),
    entities: [BudgetRule],
    synchronize: true,
  }).initialize();
  await source.query("PRAGMA journal_mode=WAL");
  await source.query("PRAGMA synchronous=FULL");
  return {
    source,
    cleanup: async () => rmSync(directory, { recursive: true, force: true }),
  };
});
const pgUrl = process.env.SIFTGATE_PRICING_TEST_POSTGRES_URL;
if (
  pgUrl &&
  (new URL(pgUrl).hostname !== "127.0.0.1" ||
    !/^\/pricing_goal_[a-z0-9_]+$/.test(new URL(pgUrl).pathname))
)
  throw new Error("Use only an isolated test PostgreSQL database");
contract(
  "PostgreSQL durable runtime evidence",
  async () => {
    const schema = `runtime_outcomes_${process.pid}_${Math.random().toString(16).slice(2)}`,
      admin = await new DataSource({
        type: "postgres",
        url: pgUrl,
      }).initialize();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const source = await new DataSource({
      type: "postgres",
      url: pgUrl,
      schema,
      extra: { options: `-c search_path=${schema}` },
      entities: [BudgetRule],
      synchronize: true,
    }).initialize();
    return {
      source,
      cleanup: async () => {
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
        await admin.destroy();
      },
    };
  },
  pgUrl ? describe : describe.skip,
);

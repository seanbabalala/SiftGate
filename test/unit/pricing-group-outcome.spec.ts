import { transitionRuntimeGroupOutcome } from "../../src/pricing/pricing-group-outcome-inbox";
import { coordinatedRepositoryOperation } from "../../src/database/coordinated-repository";
import {
  DataSource,
  InsertQueryBuilder,
  UpdateQueryBuilder,
  type ObjectLiteral,
} from "typeorm";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { BudgetRule } from "../../src/database/entities/budget-rule.entity";
import { BudgetService } from "../../src/budget/budget.service";
import { WorkspaceContextService } from "../../src/workspaces/workspace-context.service";
import { CostLedgerService } from "../../src/pricing/cost-ledger.service";
import { PricingRepository } from "../../src/pricing/pricing-repository";
import { applyPricingSchema } from "../../src/pricing/pricing-schema";
import {
  allocateBatchCost,
  batchShareCost,
} from "../../src/pricing/cost-allocation";
import {
  runtimeGroupOutcomeDocument,
  readRuntimeGroupDocument,
} from "../../src/pricing/pricing-group-outcome-document";
import type {
  PricingGroupOutcome,
  GroupAttemptOutcome,
} from "../../src/pricing/pricing-group-outcome.types";
import { mockConfigService } from "../helpers";
import { tokenBook, tokens } from "./pricing-fixtures";
import { pricingContentHash } from "../../src/pricing/pricing-json";

const workspace = "default-workspace",
  target = { node_id: "synthetic", model: "synthetic-model" };
const actor = {
  id: "synthetic-admin",
  workspace_id: workspace,
  role: "admin" as const,
  global_admin: true,
};
type Fixture = { source: DataSource; cleanup(): Promise<void> };
function contract(
  name: string,
  connect: () => Promise<Fixture>,
  run = describe,
) {
  run(name, () => {
    let source: DataSource,
      cleanup: Fixture["cleanup"],
      ledger: CostLedgerService,
      prices: PricingRepository;
    const peers: DataSource[] = [];
    const makeLedger = (db: DataSource) =>
      new CostLedgerService(
        db,
        new BudgetService(
          mockConfigService(),
          new WorkspaceContextService(),
          db.getRepository(BudgetRule),
        ),
      );
    beforeEach(async () => {
      ({ source, cleanup } = await connect());
      await applyPricingSchema(source);
      await source
        .getRepository(BudgetRule)
        .save({
          workspace_id: workspace,
          type: "daily_cost",
          limit_value: 100,
          current_value: 0,
          period_start: new Date(),
          alert_threshold: 0.8,
          is_active: true,
        });
      ledger = makeLedger(source);
      prices = new PricingRepository(source);
      const book = await prices.createBook(actor, {
        name: "Synthetic group",
        scope: "workspace",
        content: tokenBook(),
      });
      await prices.publishDraft(actor, book.draft.id, {
        draft_revision: 1,
        catalog_revision: 0,
        reason: "Fixture only",
        confirm: true,
        targets: [{ level: "model", model: target.model }],
      });
    });
    afterEach(async () => {
      jest.restoreAllMocks();
      for (const peer of peers.splice(0))
        if (peer.isInitialized) await peer.destroy();
      if (source?.isInitialized) await source.destroy();
      await cleanup?.();
    });
    async function seed(count = 2, prefix = "one") {
      const members = Array.from({ length: count }, (_, index) => ({
        request_id: `${prefix}-request-${index}`,
        reservation_id: `${prefix}-hold-${index}`,
        input_start: index,
        input_count: 1,
        weight: "1",
        weight_basis: "text_token_estimate" as const,
      }));
      let physical!: GroupAttemptOutcome["cost"];
      for (const member of members) {
        const snapshot = (await prices.capture({
          request_id: member.request_id,
          workspace_id: workspace,
          report_currency: "USD",
        }))!;
        physical = snapshot.quote(
          target,
          tokens({ input_tokens: 1000, output_tokens: 100 }),
        ).cost;
        await ledger.reserve({
          id: member.reservation_id,
          requestId: member.request_id,
          identity: {
            workspaceId: workspace,
            apiKeyId: null,
            apiKeyName: null,
            teamId: null,
            namespaceId: null,
          },
          target,
          estimate: physical,
          tokens: "1100",
          costUsd: "0.5",
          budgetBasis: "legacy_logical",
          leaseOwner: "synthetic-owner",
          leaseUntil: new Date(Date.now() - 60000).toISOString(),
        });
      }
      const attempts = members.map((member, index) => ({
        id: `${prefix}-attempt-${index}`,
        requestId: member.request_id,
        workspace,
        reservationId: member.reservation_id,
        target,
        feeSource: "provider" as const,
        dispatchedAt: "2026-09-25T00:00:00.000Z",
        priceContext: {
          context: {},
          legacyPrice: null,
          batch: {
            batch_id: `${prefix}-batch`,
            physical_attempt_id: `${prefix}-physical`,
            member_index: index,
            request_ids: members.map((member) => member.request_id),
          },
        },
      }));
      await ledger.beginAttemptGroup(attempts, members);
      const allocation = allocateBatchCost(
        `${prefix}-batch`,
        physical,
        members,
      );
      const entries = attempts.map((attempt, index) => {
        const cost = batchShareCost(allocation, index, `${prefix}-physical`);
        return {
          id: attempt.id,
          cost,
          errorCode: undefined as string | undefined,
          settlement: {
            kind: "commit" as const,
            tokens: cost.usage.quantities.total_input_tokens!.value!,
            cost_usd: cost.report_amount!,
            budget_basis: "batch_allocated_legacy_logical",
            budget_attempt_id: attempt.id,
            receipt: null,
            receipts: [{ attemptId: attempt.id, cost, errorCode: null }],
          },
        };
      });
      return { type: "attempt_group" as const, workspace, entries };
    }
    const rows = () =>
      source.query("SELECT * FROM pricing_runtime_group_outcomes ORDER BY id");
    const receipts = () =>
      source.query("SELECT * FROM pricing_attempts ORDER BY id");
    const account = () =>
      source.query("SELECT * FROM pricing_budget_effects ORDER BY id");
    const failure = (table: string) => {
      const execute = InsertQueryBuilder.prototype.execute;
      return jest
        .spyOn(InsertQueryBuilder.prototype, "execute")
        .mockImplementation(function (this: InsertQueryBuilder<ObjectLiteral>) {
          if (
            this.expressionMap.mainAlias?.tablePath === table ||
            this.expressionMap.mainAlias?.tablePath?.endsWith(`.${table}`)
          )
            return Promise.reject(new Error("synthetic write failure"));
          return execute.call(this);
        });
    };
    const peer = async () => {
      if (source.options.type !== "postgres") return makeLedger(source);
      const db = await new DataSource({
        ...source.options,
        synchronize: false,
      }).initialize();
      peers.push(db);
      return makeLedger(db);
    };

    it("retains compact, lossless complete evidence without touching costs or budgets", async () => {
      const outcome = await seed(3),
        before = await receipts(),
        effects = await account();
      const document = runtimeGroupOutcomeDocument(outcome),
        packed = JSON.parse(document.json);
      expect(Object.keys(packed.blocks)).toHaveLength(1);
      expect(Object.keys(packed.costs)).toHaveLength(3);
      expect(document.json.length).toBeLessThan(JSON.stringify(outcome).length);
      expect(
        runtimeGroupOutcomeDocument(
          readRuntimeGroupDocument(document.json).outcome,
        ).hash,
      ).toBe(document.hash);
      const row = await ledger.retainRuntimeGroupOutcome(outcome);
      expect(row.state).toBe("pending");
      expect(await receipts()).toEqual(before);
      expect(await account()).toEqual(effects);
      expect(
        await source.query(
          "SELECT * FROM pricing_runtime_group_outcome_members",
        ),
      ).toHaveLength(3);
      expect(
        (await ledger.runtimeGroupOutcome(row.id, workspace))
          .supplier_confirmed,
      ).toBe(false);
    });
    it("replays all members and terminal intents after an actual child exits immediately after retention", async () => {
      const outcome = await seed();
      const child = spawnSync(
        process.execPath,
        [
          "-r",
          require.resolve("ts-node/register"),
          "-e",
          `require('reflect-metadata');const{DataSource}=require('typeorm');const{BudgetRule}=require('./src/database/entities/budget-rule.entity');const{BudgetService}=require('./src/budget/budget.service');const{WorkspaceContextService}=require('./src/workspaces/workspace-context.service');const{CostLedgerService}=require('./src/pricing/cost-ledger.service');(async()=>{const source=await new DataSource({...JSON.parse(process.env.GROUP_DB),entities:[BudgetRule],synchronize:false}).initialize();const ledger=new CostLedgerService(source,new BudgetService({},new WorkspaceContextService(),source.getRepository(BudgetRule)));await ledger.retainRuntimeGroupOutcome(JSON.parse(process.env.GROUP_BODY));process.exit(17)})().catch(e=>{console.error(e.message);process.exit(18)});`,
        ],
        {
          cwd: process.cwd(),
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            TMPDIR: process.env.TMPDIR,
            NODE_OPTIONS: "--max-old-space-size=512",
            TS_NODE_TRANSPILE_ONLY: "true",
            GROUP_DB: JSON.stringify(source.options),
            GROUP_BODY: JSON.stringify(outcome),
          },
          encoding: "utf8",
          timeout: 20000,
        },
      );
      expect({ status: child.status, stderr: child.stderr }).toMatchObject({
        status: 17,
      });
      expect(
        (await receipts()).every(
          (row: { state: string }) => row.state === "dispatched",
        ),
      ).toBe(true);
      const fresh = await peer();
      await Promise.all([
        ledger.replayRuntimeGroupOutcomes(),
        fresh.replayRuntimeGroupOutcomes(),
      ]);
      await Promise.all([ledger.reconcilePending(), fresh.reconcilePending()]);
      expect((await rows())[0].state).toBe("delivered");
      expect(
        (await receipts()).every(
          (row: { state: string }) => row.state === "terminal",
        ),
      ).toBe(true);
      expect(
        (await account()).filter(
          (row: { kind: string }) => row.kind === "commit",
        ),
      ).toHaveLength(2);
      expect(
        (
          await source
            .getRepository(BudgetRule)
            .findOneByOrFail({ type: "daily_cost" })
        ).current_value,
      ).toBeCloseTo(0.0012, 8);
    }, 30000);
    it.each(["pricing_audit_events", "pricing_runtime_group_outcome_members"])(
      "rolls back group custody when required%s insertion fails",
      async (table) => {
        const outcome = await seed(),
          before = await receipts();
        const fault = failure(table);
        await expect(ledger.retainRuntimeGroupOutcome(outcome)).rejects.toThrow(
          "synthetic write failure",
        );
        fault.mockRestore();
        expect(await rows()).toHaveLength(0);
        expect(
          await source.query(
            "SELECT * FROM pricing_runtime_group_outcome_members",
          ),
        ).toHaveLength(0);
        expect(await receipts()).toEqual(before);
      },
    );
    it("retains the entire body when one member terminal intent fails and retries without another dispatch", async () => {
      const outcome = await seed(),
        before = await receipts(),
        effects = await account();
      const fault = failure("pricing_settlement_intents");
      await expect(ledger.persistRuntimeGroupOutcome(outcome)).rejects.toThrow(
        "synthetic write failure",
      );
      fault.mockRestore();
      expect((await rows())[0].state).toBe("pending");
      expect(await receipts()).toEqual(before);
      expect(await account()).toEqual(effects);
      await ledger.replayRuntimeGroupOutcomes(new Date(Date.now() + 120000));
      await ledger.reconcilePending();
      expect((await rows())[0].state).toBe("delivered");
      expect(
        (await receipts()).filter(
          (row: { state: string }) => row.state === "terminal",
        ),
      ).toHaveLength(2);
    });
    it("distinguishes cost-only capture, partial terminal decisions and their complete superset", async () => {
      const terminal = await seed();
      const receipt = {
        ...terminal,
        entries: terminal.entries.map(({ settlement: _s, ...entry }) => entry),
      };
      await ledger.persistRuntimeGroupOutcome(receipt);
      expect(
        await source.query("SELECT * FROM pricing_settlement_intents"),
      ).toHaveLength(0);
      const partial = {
        ...terminal,
        entries: terminal.entries.map((entry, index) =>
          index ? { id: entry.id, cost: entry.cost } : entry,
        ),
      };
      await ledger.persistRuntimeGroupOutcome(partial);
      await ledger.persistRuntimeGroupOutcome(terminal);
      await ledger.reconcilePending();
      expect(await rows()).toHaveLength(3);
      expect(
        (await rows()).every(
          (row: { state: string }) => row.state === "delivered",
        ),
      ).toBe(true);
      expect(
        (await account()).filter(
          (row: { kind: string }) => row.kind === "commit",
        ),
      ).toHaveLength(2);
    });
    it("quarantines a differing complete cost body without replacing an earlier pending variant", async () => {
      const first = await seed();
      await ledger.retainRuntimeGroupOutcome(first);
      const other = structuredClone(first),
        physical = structuredClone(first.entries[0].cost.batch!.physical_cost);
      physical.attribution = undefined;
      physical.diagnostics.push({
        code: "pricing_invalid_quantity",
        path: "fixture",
        message: "Different evidence retained",
      });
      const allocation = allocateBatchCost(
        "one-batch",
        physical,
        first.entries[0].cost.batch!.members,
      );
      other.entries.forEach((entry, index) => {
        entry.cost = batchShareCost(allocation, index, "one-physical");
        entry.settlement.receipts[0].cost = entry.cost;
      });
      await expect(
        ledger.persistRuntimeGroupOutcome(other),
      ).rejects.toMatchObject({
        code: "pricing_group_outcome_review_required",
      });
      expect(
        (await rows()).map((row: { state: string }) => row.state).sort(),
      ).toEqual(["pending", "review_required"]);
      await ledger.replayRuntimeGroupOutcomes();
      expect(
        (await rows()).map((row: { state: string }) => row.state).sort(),
      ).toEqual(["delivered", "review_required"]);
    });
    it("keeps original receipts immutable and archives a delayed different group body", async () => {
      const outcome = await seed();
      await ledger.persistRuntimeGroupOutcome(outcome);
      const modified = structuredClone(outcome);
      modified.entries[0].errorCode = "different_error";
      await expect(
        ledger.persistRuntimeGroupOutcome(modified),
      ).rejects.toMatchObject({
        code: "pricing_group_outcome_review_required",
      });
      expect((await receipts())[0].error_code).toBeNull();
      expect(
        (await rows()).filter(
          (row: { state: string }) => row.state === "review_required",
        ),
      ).toHaveLength(1);
    });
    it("does not adopt incomplete physical groups or arbitrary client money", async () => {
      const outcome = await seed();
      await expect(
        ledger.retainRuntimeGroupOutcome({
          ...outcome,
          entries: outcome.entries.slice(0, 1),
        }),
      ).rejects.toMatchObject({ status: 400 });
      const changed = structuredClone(outcome);
      changed.entries[0].cost.report_amount = "999";
      await expect(
        ledger.retainRuntimeGroupOutcome(changed),
      ).rejects.toMatchObject({ status: 400 });
      expect(await rows()).toHaveLength(0);
    });
    it("retains legacy-manifest and async-owned groups for review rather than inventing dispatch authority", async () => {
      const outcome = await seed();
      await source
        .createQueryBuilder()
        .delete()
        .from("pricing_batch_manifests")
        .execute();
      await expect(
        ledger.persistRuntimeGroupOutcome(outcome),
      ).rejects.toMatchObject({
        code: "pricing_group_outcome_review_required",
      });
      expect(
        (await receipts()).every(
          (row: { state: string }) => row.state === "dispatched",
        ),
      ).toBe(true);
      const other = await seed(2, "async");
      await source
        .createQueryBuilder()
        .update("pricing_reservations")
        .set({ job_id: "owned-async-job" })
        .where("id = :id", { id: "async-hold-0" })
        .execute();
      await expect(
        ledger.persistRuntimeGroupOutcome(other),
      ).rejects.toMatchObject({
        code: "pricing_group_outcome_review_required",
      });
      expect(await rows()).toHaveLength(2);
    });
    it("rejects cross-workspace ownership and wrong delivery identities without writing a subset", async () => {
      const outcome = await seed();
      await expect(
        ledger.retainRuntimeGroupOutcome({ ...outcome, workspace: "foreign" }),
      ).rejects.toMatchObject({ status: 404 });
      const row = await ledger.retainRuntimeGroupOutcome(outcome);
      await expect(
        ledger.runtimeGroupOutcome(row.id, "foreign"),
      ).rejects.toMatchObject({ status: 404 });
      const other = structuredClone(outcome);
      other.entries[0].errorCode = "changed";
      await expect(
        ledger.completeAttemptGroup(workspace, other.entries, row.id),
      ).rejects.toMatchObject({ status: 409 });
      expect(
        (await receipts()).every(
          (row: { state: string }) => row.state === "dispatched",
        ),
      ).toBe(true);
    });
    it("uses exact retries after a successful target commit whose delivery acknowledgement is lost", async () => {
      const outcome = await seed(),
        execute = UpdateQueryBuilder.prototype.execute;
      const fault = jest
        .spyOn(UpdateQueryBuilder.prototype, "execute")
        .mockImplementation(function (this: UpdateQueryBuilder<ObjectLiteral>) {
          if (
            this.expressionMap.mainAlias?.tablePath ===
            "pricing_runtime_group_outcomes"
          )
            return Promise.reject(new Error("lost group acknowledgement"));
          return execute.call(this);
        });
      await expect(ledger.persistRuntimeGroupOutcome(outcome)).rejects.toThrow(
        "lost group acknowledgement",
      );
      fault.mockRestore();
      expect(
        (await receipts()).every(
          (row: { state: string }) => row.state === "terminal",
        ),
      ).toBe(true);
      await ledger.persistRuntimeGroupOutcome(outcome);
      await ledger.reconcilePending();
      await ledger.persistRuntimeGroupOutcome(outcome);
      await ledger.reconcilePending();
      expect(await rows()).toHaveLength(1);
      expect(
        (await account()).filter(
          (row: { kind: string }) => row.kind === "commit",
        ),
      ).toHaveLength(2);
    });
    it("keeps corrupted retained bytes and stops automatic replay with an integrity audit", async () => {
      const row = await ledger.retainRuntimeGroupOutcome(await seed());
      await source
        .createQueryBuilder()
        .update("pricing_runtime_group_outcomes")
        .set({ document_json: "{corrupted" })
        .where("id=:id", { id: row.id })
        .execute();
      expect((await ledger.replayRuntimeGroupOutcomes()).review_required).toBe(
        1,
      );
      const saved = (await rows())[0];
      expect(saved.document_json).toBe("{corrupted");
      expect(saved.state).toBe("review_required");
      await expect(
        ledger.runtimeGroupOutcome(row.id, workspace),
      ).rejects.toMatchObject({ status: 400 });
      expect(
        (await receipts()).every(
          (row: { state: string }) => row.state === "dispatched",
        ),
      ).toBe(true);
    });
    it("keeps cost/reference hashes and rejects unused/private or non-finite content", async () => {
      const outcome = await seed(),
        document = runtimeGroupOutcomeDocument(outcome),
        packed = JSON.parse(document.json);
      packed.blocks["private"] = "raw supplier body";
      expect(() => readRuntimeGroupDocument(JSON.stringify(packed))).toThrow();
      const tampered = JSON.parse(document.json);
      tampered.entries[0].cost_hash = "0".repeat(64);
      expect(() =>
        readRuntimeGroupDocument(JSON.stringify(tampered)),
      ).toThrow();
      const invalid = structuredClone(outcome);
      Object.assign(invalid.entries[0], {
        raw_headers: { Authorization: "NOT_A_REAL_SECRET" },
      });
      expect(() => runtimeGroupOutcomeDocument(invalid)).toThrow();
      Object.assign(outcome.entries[0].cost, { unknown_quantity: NaN });
      expect(() => runtimeGroupOutcomeDocument(outcome)).toThrow();
    });
    it("paginates metadata without duplicating physical bodies or crossing cursor scope", async () => {
      for (let index = 0; index < 3; index++)
        await ledger.retainRuntimeGroupOutcome(await seed(2, `page-${index}`));
      const first = await ledger.runtimeGroupOutcomeInventory(
        workspace,
        "pending",
        2,
      );
      expect(first.items).toHaveLength(2);
      expect(first.next_cursor).not.toBeNull();
      expect(JSON.stringify(first)).not.toContain("physical_cost");
      const second = await ledger.runtimeGroupOutcomeInventory(
        workspace,
        "pending",
        2,
        first.next_cursor!,
      );
      expect(second.items).toHaveLength(1);
      expect(second.next_cursor).toBeNull();
      await expect(
        ledger.runtimeGroupOutcomeInventory(
          "foreign",
          "pending",
          2,
          first.next_cursor!,
        ),
      ).rejects.toMatchObject({ status: 409 });
    });
    it("replays an undispatched release cohort without manufacturing supplier fees", async () => {
      const entries = [];
      for (const suffix of ["left", "right"]) {
        const requestId = `unsent-${suffix}`,
          snapshot = (await prices.capture({
            request_id: requestId,
            workspace_id: workspace,
            report_currency: "USD",
          }))!;
        await ledger.reserve({
          id: requestId,
          requestId,
          identity: {
            workspaceId: workspace,
            apiKeyId: null,
            apiKeyName: null,
            namespaceId: null,
            teamId: null,
          },
          target,
          estimate: snapshot.quote(target, tokens({ input_tokens: 1 })).cost,
          tokens: "1",
          costUsd: "0.1",
          budgetBasis: "legacy_logical",
          leaseOwner: "test",
          leaseUntil: new Date(Date.now() - 1000).toISOString(),
        });
        entries.push({
          reservationId: requestId,
          payload: {
            kind: "release" as const,
            tokens: "0",
            cost_usd: "0",
            budget_basis: "undispatched",
            receipt: null,
          },
        });
      }
      const outcome: PricingGroupOutcome = {
        type: "settlement_group",
        workspace,
        entries,
      };
      await ledger.retainRuntimeGroupOutcome(outcome);
      await ledger.replayRuntimeGroupOutcomes();
      await ledger.reconcilePending();
      expect(
        (await source.query("SELECT state FROM pricing_reservations")).every(
          (row: { state: string }) => row.state === "released",
        ),
      ).toBe(true);
      expect(await receipts()).toHaveLength(0);
      expect((await rows())[0].state).toBe("delivered");
    });
    it("never replays a purported undispatched cohort after a real physical dispatch", async () => {
      const group = await seed();
      const outcome: PricingGroupOutcome = {
        type: "settlement_group",
        workspace,
        entries: group.entries.map((entry) => ({
          reservationId:
            entry.cost.batch!.members[entry.cost.batch!.member_index]
              .reservation_id,
          payload: {
            kind: "release",
            tokens: "0",
            cost_usd: "0",
            budget_basis: "undispatched",
            receipt: null,
          },
        })),
      };
      await expect(
        ledger.persistRuntimeGroupOutcome(outcome),
      ).rejects.toMatchObject({
        code: "pricing_group_outcome_review_required",
      });
      expect((await rows())[0].state).toBe("review_required");
      expect(
        await source.query("SELECT * FROM pricing_settlement_intents"),
      ).toHaveLength(0);
    });
    it("includes durable complete groups in admission backpressure without preventing retention", async () => {
      const outcome = await seed(),
        row = await ledger.retainRuntimeGroupOutcome(outcome);
      for (let i = 0; i < 999; i++)
        await source
          .createQueryBuilder()
          .insert()
          .into("pricing_runtime_group_outcomes")
          .values({ ...row, id: `synthetic-capacity-${i}` })
          .execute();
      await expect(
        ledger.assertRuntimeOutcomeCapacity(workspace),
      ).rejects.toMatchObject({ status: 503 });
      await expect(
        ledger.assertRuntimeOutcomeCapacity("foreign"),
      ).resolves.toBeUndefined();
      expect((await ledger.retainRuntimeGroupOutcome(outcome)).id).toBe(row.id);
    });
    it("does not report delivered when a concurrent audited quarantine wins the final acknowledgement", async () => {
      const outcome = await seed(),
        original = ledger.completeAttemptGroup.bind(ledger);
      const fault = jest
        .spyOn(ledger, "completeAttemptGroup")
        .mockImplementation(async (...args) => {
          await original(...args);
          const row = (await rows())[0];
          await coordinatedRepositoryOperation(
            source.getRepository(BudgetRule),
            true,
            (manager) =>
              transitionRuntimeGroupOutcome(manager!, row, "review_required"),
          );
        });
      await expect(
        ledger.persistRuntimeGroupOutcome(outcome),
      ).rejects.toMatchObject({
        code: "pricing_group_outcome_review_required",
      });
      fault.mockRestore();
      expect((await rows())[0].state).toBe("review_required");
    });
    it("bounds repeated compact references before constructing their expanded receipt tree", async () => {
      const outcome = await seed(),
        physical = structuredClone(
          outcome.entries[0].cost.batch!.physical_cost,
        );
      physical.diagnostics = Array.from({ length: 100 }, () => ({
        code: "pricing_invalid_quantity",
        path: "fixture",
        message: "x".repeat(1000),
      }));
      const allocation = allocateBatchCost(
        "one-batch",
        physical,
        outcome.entries[0].cost.batch!.members,
      );
      outcome.entries.forEach((entry, index) => {
        entry.cost = batchShareCost(allocation, index, "one-physical");
        entry.settlement.receipts[0].cost = entry.cost;
      });
      const document = runtimeGroupOutcomeDocument(outcome),
        packed = JSON.parse(document.json);
      packed.entries[0].settlement.receipts = Array.from(
        { length: 500 },
        () => ({ ...packed.entries[0].settlement.receipts[0] }),
      );
      expect(() => readRuntimeGroupDocument(JSON.stringify(packed))).toThrow(
        "reference expansion",
      );
    });
    it("requires every carried historical receipt to be durable before a terminal group can replay it", async () => {
      const outcome = await seed(),
        members = outcome.entries[0].cost.batch!.members;
      const prior = outcome.entries.map((entry, index) => ({
        id: `older-${index}`,
        requestId: members[index].request_id,
        workspace,
        reservationId: members[index].reservation_id,
        target,
        feeSource: "provider" as const,
        dispatchedAt: "2026-09-24T00:00:00.000Z",
        priceContext: {
          context: {},
          legacyPrice: null,
          batch: {
            batch_id: "older-batch",
            physical_attempt_id: "older-physical",
            member_index: index,
            request_ids: members.map((member) => member.request_id),
          },
        },
      }));
      await ledger.beginAttemptGroup(prior, members);
      const allocation = allocateBatchCost(
        "older-batch",
        outcome.entries[0].cost.batch!.physical_cost,
        members,
      );
      outcome.entries.forEach((entry, index) =>
        entry.settlement.receipts.push({
          attemptId: prior[index].id,
          cost: batchShareCost(allocation, index, "older-physical"),
          errorCode: null,
        }),
      );
      await expect(
        ledger.persistRuntimeGroupOutcome(outcome),
      ).rejects.toMatchObject({
        code: "pricing_group_outcome_review_required",
      });
      expect(
        (await receipts()).every(
          (row: { state: string }) => row.state === "dispatched",
        ),
      ).toBe(true);
      expect(await rows()).toHaveLength(1);
    });
    it("rejects null or false terminal fields instead of silently erasing them", async () => {
      const outcome = await seed();
      for (const value of [null, false, 0]) {
        const invalid = structuredClone(outcome);
        Object.assign(invalid.entries[0], { settlement: value });
        expect(() => runtimeGroupOutcomeDocument(invalid)).toThrow();
      }
    });
    it("uses canonical immutable IDs for reversed arrival order", async () => {
      const outcome = await seed(),
        other = await peer();
      const reversed = { ...outcome, entries: [...outcome.entries].reverse() };
      const [first, second] = await Promise.all([
        ledger.retainRuntimeGroupOutcome(outcome),
        other.retainRuntimeGroupOutcome(reversed),
      ]);
      expect(first.id).toBe(second.id);
      expect(await rows()).toHaveLength(1);
      expect(first.document_hash).toBe(
        pricingContentHash(JSON.parse(first.document_json)),
      );
    });
  });
}
contract("SQLite WAL complete-group outcome custody", async () => {
  const directory = mkdtempSync(join(tmpdir(), "group-outcomes-"));
  const source = await new DataSource({
    type: "better-sqlite3",
    database: join(directory, "database.sqlite"),
    entities: [BudgetRule],
    synchronize: true,
  }).initialize();
  await source.query("PRAGMA journal_mode=WAL");
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
  throw new Error("Use only isolated PostgreSQL");
contract(
  "PostgreSQL complete-group outcome custody",
  async () => {
    if (!pgUrl) throw new Error("No isolated PostgreSQL URL");
    const schema = `group_outcomes_${process.pid}_${Math.random().toString(16).slice(2)}`;
    const admin = await new DataSource({
      type: "postgres",
      url: pgUrl,
      synchronize: false,
    }).initialize();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    let source: DataSource | undefined;
    try {
      source = await new DataSource({
        type: "postgres",
        url: pgUrl,
        schema,
        extra: { options: `-c search_path=${schema},public`, max: 6 },
        entities: [BudgetRule],
        synchronize: true,
      }).initialize();
      return {
        source,
        cleanup: async () => {
          try {
            await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
          } finally {
            await admin.destroy();
          }
        },
      };
    } catch (error) {
      if (source?.isInitialized) await source.destroy();
      try {
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      } finally {
        await admin.destroy();
      }
      throw error;
    }
  },
  pgUrl ? describe : describe.skip,
);

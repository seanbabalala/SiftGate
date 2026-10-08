import { spawnSync } from "node:child_process";
import { PricingCorrectionService } from "../../src/pricing/pricing-correction.service";
import { DataSource, InsertQueryBuilder, type ObjectLiteral } from "typeorm";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BudgetRule } from "../../src/database/entities/budget-rule.entity";
import { CallLog } from "../../src/database/entities/call-log.entity";
import { BudgetService } from "../../src/budget/budget.service";
import { WorkspaceContextService } from "../../src/workspaces/workspace-context.service";
import { CostLedgerService } from "../../src/pricing/cost-ledger.service";
import { PricingRepository } from "../../src/pricing/pricing-repository";
import { PricingGroupDispositionService } from "../../src/pricing/pricing-group-disposition.service";
import {
  applyPricingSchema,
  planPricingSchema,
  PRICING_MIGRATIONS,
} from "../../src/pricing/pricing-schema";
import { transitionRuntimeGroupOutcome } from "../../src/pricing/pricing-group-outcome-inbox";
import { coordinatedRepositoryOperation } from "../../src/database/coordinated-repository";
import {
  allocateBatchCost,
  batchShareCost,
} from "../../src/pricing/cost-allocation";
import { pricingContentHash } from "../../src/pricing/pricing-json";
import type { GroupDispositionInput } from "../../src/pricing/pricing-group-disposition.types";
import type { CostComputation } from "../../src/pricing/pricing.types";
import type { PricingGroupOutcome } from "../../src/pricing/pricing-group-outcome.types";
import { mockConfigService } from "../helpers";
import { tokenBook, tokens } from "./pricing-fixtures";

const workspace = "default-workspace",
  target = { node_id: "synthetic-node", model: "synthetic-model" };
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
      prices: PricingRepository,
      service: PricingGroupDispositionService,
      budgets: BudgetService;
    const peers: DataSource[] = [];
    const make = (db: DataSource) => {
      const budget = new BudgetService(
        mockConfigService(),
        new WorkspaceContextService(),
        db.getRepository(BudgetRule),
      );
      const cost = new CostLedgerService(db, budget),
        price = new PricingRepository(db);
      return {
        ledger: cost,
        prices: price,
        service: new PricingGroupDispositionService(cost, price),
        budgets: budget,
      };
    };
    beforeEach(async () => {
      ({ source, cleanup } = await connect());
      await applyPricingSchema(source);
      await source.getRepository(BudgetRule).save({
        workspace_id: workspace,
        type: "daily_cost",
        limit_value: 100,
        current_value: 0,
        period_start: new Date(),
        alert_threshold: 0.8,
        is_active: true,
      });
      ({ ledger, prices, service, budgets } = make(source));
      const book = await prices.createBook(actor, {
        name: "Synthetic group disposition",
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
      budgets?.onModuleDestroy();
      for (const peer of peers.splice(0))
        if (peer.isInitialized) await peer.destroy();
      if (source?.isInitialized) await source.destroy();
      await cleanup?.();
    });
    const peer = async () => {
      if (source.options.type !== "postgres") return make(source);
      const db = await new DataSource({
        ...source.options,
        synchronize: false,
      }).initialize();
      peers.push(db);
      return make(db);
    };
    async function seed(
      mode: "initial" | "reserved" | "settled" | "released" = "settled",
      quantity: number | null = 2000,
      count = 2,
      reported = false,
      originalUnknown = false,
    ) {
      const instant = new Date().toISOString(),
        context = {
          attempt_dispatched_at: instant,
          media: { operation: "embeddings" },
        };
      const dispatch = {
        node_id: target.node_id,
        wire_model: target.model,
        credential_id: "synthetic-credential",
        credential_strategy: "single",
        credential_retry_index: 0,
        compatibility_retry_index: 0,
        dispatch_index: 0,
        protocol: "chat_completions",
        dispatched_at: instant,
        invocation_id: "batch",
        requested_model: target.model,
        route_model: target.model,
      };
      const members = Array.from({ length: count }, (_, index) => ({
        request_id: `r-${index}`,
        reservation_id: `h-${index}`,
        input_start: index,
        input_count: 1,
        weight: "1",
        weight_basis: "text_token_estimate" as const,
      }));
      let initial!: CostComputation, replacement!: CostComputation;
      for (const member of members) {
        const snapshot = (await prices.capture({
          request_id: member.request_id,
          workspace_id: workspace,
          report_currency: "USD",
        }))!;
        initial = snapshot.quote(
          target,
          originalUnknown
            ? tokens({})
            : tokens({ input_tokens: 1000, output_tokens: 0 }),
          context,
        ).cost;
        replacement = snapshot.quote(
          target,
          quantity === null
            ? tokens({})
            : tokens({ input_tokens: quantity, output_tokens: 0 }),
          context,
        ).cost;
        if (reported) {
          initial.attribution = { ...dispatch, response_model: "reported-old" };
          replacement.attribution = {
            ...dispatch,
            response_model: "reported-new",
          };
        }
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
          estimate: initial,
          tokens: "1000",
          costUsd: "0.2",
          budgetBasis: "legacy_logical",
          leaseOwner: "synthetic-owner",
          leaseUntil: new Date(Date.now() - 60000).toISOString(),
        });
      }
      const attempts = members.map((member, index) => ({
        id: `a-${index}`,
        requestId: member.request_id,
        workspace,
        reservationId: member.reservation_id,
        target,
        feeSource: "provider" as const,
        dispatchedAt: instant,
        priceContext: {
          context,
          legacyPrice: null,
          ...(reported ? { dispatch } : {}),
          batch: {
            batch_id: "batch",
            physical_attempt_id: "physical",
            member_index: index,
            request_ids: members.map((member) => member.request_id),
          },
        },
      }));
      await ledger.beginAttemptGroup(attempts, members);
      const originalAllocation = allocateBatchCost("batch", initial, members),
        nextAllocation = allocateBatchCost("batch", replacement, members);
      const old = attempts.map((attempt, index) => ({
        id: attempt.id,
        cost: batchShareCost(originalAllocation, index, "physical"),
      }));
      if (mode !== "initial") {
        await ledger.completeAttemptGroup(
          workspace,
          old.map((entry) => ({
            ...entry,
            ...(mode === "reserved"
              ? {}
              : {
                  settlement: {
                    kind:
                      mode === "released"
                        ? ("release" as const)
                        : ("commit" as const),
                    tokens:
                      mode === "released"
                        ? "0"
                        : (entry.cost.usage.quantities.total_input_tokens
                            ?.value ?? "1000"),
                    cost_usd:
                      mode === "released"
                        ? "0"
                        : (entry.cost.report_amount ?? "0.2"),
                    budget_basis: "batch_allocated_legacy_logical",
                    ...(mode === "released"
                      ? {}
                      : { budget_attempt_id: entry.id }),
                    receipt: {
                      attemptId: entry.id,
                      cost: entry.cost,
                      errorCode: null,
                    },
                  },
                }),
          })),
        );
        if (mode !== "reserved") await ledger.reconcilePending();
      }
      await source.getRepository(CallLog).save(
        members.map((member) => ({
          request_id: member.request_id,
          workspace_id: workspace,
          source_format: "embeddings",
          tier: "direct",
          score: 0,
          node_id: target.node_id,
          model: target.model,
          cost_usd: 0,
        })),
      );
      const entries = attempts.map((attempt, index) => {
        const cost = batchShareCost(nextAllocation, index, "physical");
        return {
          id: attempt.id,
          cost,
          settlement: {
            kind: "commit" as const,
            tokens: "999",
            cost_usd: "99",
            budget_basis: "proposal_not_selected",
            budget_attempt_id: attempt.id,
            receipt: null,
            receipts: [{ attemptId: attempt.id, cost, errorCode: null }],
          },
        };
      });
      const outcome: PricingGroupOutcome = {
        type: "attempt_group",
        workspace,
        entries,
      };
      const row = await ledger.retainRuntimeGroupOutcome(outcome);
      if (row.state !== "review_required")
        await coordinatedRepositoryOperation(
          source.getRepository(BudgetRule),
          true,
          (manager) =>
            transitionRuntimeGroupOutcome(manager!, row, "review_required"),
        );
      return {
        row,
        outcome,
        entries,
        old,
        members,
        initial,
        replacement,
        context,
      };
    }
    async function secondGroup(
      fixture: Awaited<ReturnType<typeof seed>>,
      history: "partial" | "complete",
      historyQuantity: number,
      originalSecond: number | null = null,
    ) {
      const snapshot = await prices.restoreRequest("r-0", workspace);
      const physical = snapshot.quote(
        target,
        tokens({ input_tokens: 4000, output_tokens: 0 }),
        fixture.context,
      ).cost;
      const priorPhysical = snapshot.quote(
        target,
        tokens({ input_tokens: historyQuantity, output_tokens: 0 }),
        fixture.context,
      ).cost;
      const allocation = allocateBatchCost(
          "next-batch",
          physical,
          fixture.members,
        ),
        prior = allocateBatchCost("batch", priorPhysical, fixture.members);
      await ledger.beginAttemptGroup(
        fixture.members.map((member, index) => ({
          id: `b-${index}`,
          requestId: member.request_id,
          workspace,
          reservationId: member.reservation_id,
          target,
          feeSource: "provider",
          dispatchedAt: fixture.context.attempt_dispatched_at,
          priceContext: {
            context: fixture.context,
            legacyPrice: null,
            batch: {
              batch_id: "next-batch",
              physical_attempt_id: "next-physical",
              member_index: index,
              request_ids: fixture.members.map((member) => member.request_id),
            },
          },
        })),
        fixture.members,
      );
      if (originalSecond !== null) {
        const oldPhysical = snapshot.quote(
          target,
          tokens({ input_tokens: originalSecond, output_tokens: 0 }),
          fixture.context,
        ).cost;
        const oldAllocation = allocateBatchCost(
          "next-batch",
          oldPhysical,
          fixture.members,
        );
        await ledger.completeAttemptGroup(
          workspace,
          fixture.members.map((_member, index) => {
            const cost = batchShareCost(oldAllocation, index, "next-physical"),
              attemptId = `b-${index}`;
            return {
              id: attemptId,
              cost,
              settlement: {
                kind: "commit",
                tokens: cost.usage.quantities.total_input_tokens!.value!,
                cost_usd: cost.report_amount!,
                budget_basis: "batch_allocated_legacy_logical",
                budget_attempt_id: attemptId,
                receipt: null,
                receipts: [
                  {
                    attemptId: `a-${index}`,
                    cost: fixture.old[index].cost,
                    errorCode: null,
                  },
                  { attemptId, cost, errorCode: null },
                ],
              },
            };
          }),
        );
        await ledger.reconcilePending();
      }
      const entries = fixture.members.map((_member, index) => {
        const cost = batchShareCost(allocation, index, "next-physical");
        return {
          id: `b-${index}`,
          cost,
          settlement: {
            kind: "commit" as const,
            tokens: "999",
            cost_usd: "99",
            budget_basis: "proposal_not_selected",
            receipt: null,
            receipts: [
              { attemptId: `b-${index}`, cost, errorCode: null },
              ...(history === "complete" || index === 0
                ? [
                    {
                      attemptId: `a-${index}`,
                      cost: batchShareCost(prior, index, "physical"),
                      errorCode: null,
                    },
                  ]
                : []),
            ],
          },
        };
      });
      const row = await ledger.retainRuntimeGroupOutcome({
        type: "attempt_group",
        workspace,
        entries,
      });
      if (row.state !== "review_required")
        await coordinatedRepositoryOperation(
          source.getRepository(BudgetRule),
          true,
          (manager) =>
            transitionRuntimeGroupOutcome(manager!, row, "review_required"),
        );
      return row;
    }
    async function input(
      id: string,
      action: GroupDispositionInput["action"] = "accept_receipts",
      operation = "operation-one",
    ): Promise<GroupDispositionInput> {
      const basis = await ledger.groupDispositionBasis(id, workspace);
      return {
        id: operation,
        expected_basis_hash: basis.basis_hash,
        expected_outcome_hash: basis.outcome_hash,
        action,
        reason: "Synthetic complete group review",
        confirm: true,
      };
    }
    const dump = async () => {
      const result: Record<string, unknown> = {};
      for (const table of [
        "pricing_attempts",
        "pricing_reservations",
        "pricing_settlement_intents",
        "pricing_budget_effects",
        "pricing_budget_balances",
        "pricing_cost_adjustments",
        "pricing_adjustment_applications",
        "pricing_audit_events",
        "pricing_runtime_group_outcomes",
        "pricing_runtime_group_outcome_members",
        "pricing_runtime_group_dispositions",
        "budget_rules",
        "call_logs",
      ])
        result[table] = await source.query(`SELECT * FROM ${table}`);
      return result;
    };
    const balance = async () =>
      (
        await source
          .getRepository(BudgetRule)
          .findOneByOrFail({ type: "daily_cost" })
      ).current_value;
    const failInsert = (table: string, at = 1) => {
      let seen = 0;
      const execute = InsertQueryBuilder.prototype.execute;
      return jest
        .spyOn(InsertQueryBuilder.prototype, "execute")
        .mockImplementation(function (this: InsertQueryBuilder<ObjectLiteral>) {
          if (
            this.expressionMap.mainAlias?.tablePath?.endsWith(table) &&
            ++seen === at
          )
            return Promise.reject(
              new Error("synthetic required write failure"),
            );
          return execute.call(this);
        });
    };

    it("previews exact complete corrections without writes then applies one conserved revision", async () => {
      const fixture = await seed();
      const proposal = await input(fixture.row.id);
      const before = await dump();
      const preview = await service.dispose(
        actor,
        fixture.row.id,
        proposal,
        true,
      );
      expect(await dump()).toEqual(before);
      expect(preview.changes).toHaveLength(2);
      expect(
        preview.changes.every(
          (change) =>
            change.operation === "linked_correction" &&
            change.budget.cost_delta === "0.000500000000000000",
        ),
      ).toBe(true);
      const result = await service.dispose(
        actor,
        fixture.row.id,
        proposal,
        false,
      );
      expect(result.changes.map((change) => change.cost.report_amount)).toEqual(
        ["0.001000000000000000", "0.001000000000000000"],
      );
      expect(await balance()).toBeCloseTo(0.002, 8);
      expect(await source.query("SELECT * FROM pricing_attempts")).toEqual(
        before.pricing_attempts,
      );
      expect(
        await source.query("SELECT * FROM pricing_runtime_group_outcomes"),
      ).toEqual(before.pricing_runtime_group_outcomes);
      expect(
        await source.query("SELECT * FROM pricing_settlement_intents"),
      ).toEqual(before.pricing_settlement_intents);
      expect(
        (await source.getRepository(CallLog).find()).map((log) => log.cost_usd),
      ).toEqual([0.001, 0.001]);
    });
    it.each([
      "identity",
      "target",
      "catalog",
      "price",
      "fx",
      "policy",
      "dispatch_target",
      "dispatch_time",
    ] as const)(
      "refuses initial adoption when a member's %s authority differs",
      async (kind) => {
        const fixture = await seed("initial");
        const hold = (
          await source.query(
            "SELECT * FROM pricing_reservations WHERE id = 'h-1'",
          )
        )[0];
        if (kind === "catalog") {
          const otherBook = await prices.createBook(actor, {
            name: "Other synthetic catalog",
            scope: "workspace",
            content: tokenBook(),
          });
          await prices.publishDraft(actor, otherBook.draft.id, {
            draft_revision: 1,
            catalog_revision: 1,
            reason: "Other synthetic catalog",
            confirm: true,
            targets: [{ level: "model", model: target.model }],
          });
          await prices.capture({
            request_id: "other-catalog-request",
            workspace_id: workspace,
            report_currency: "USD",
          });
          const snapshot = (
            await source.query(
              "SELECT * FROM pricing_request_snapshots WHERE request_id = 'r-1'",
            )
          )[0];
          const catalogs = await source.query(
            "SELECT id FROM pricing_catalog_revisions",
          );
          const catalog = catalogs.find(
            (row: { id: string }) => row.id !== snapshot.catalog_revision_id,
          )!;
          const { snapshot_id: _old, ...descriptor } = JSON.parse(
            snapshot.descriptor_json,
          );
          descriptor.catalog_revision_id = catalog.id;
          const hash = pricingContentHash(descriptor);
          await source
            .createQueryBuilder()
            .update("pricing_request_snapshots")
            .set({
              catalog_revision_id: catalog.id,
              snapshot_hash: hash,
              descriptor_json: JSON.stringify({
                ...descriptor,
                snapshot_id: hash,
              }),
            })
            .where("request_id = :id", { id: "r-1" })
            .execute();
        } else if (kind === "dispatch_target" || kind === "dispatch_time") {
          await source
            .createQueryBuilder()
            .update("pricing_attempts")
            .set(
              kind === "dispatch_target"
                ? { model: "other-model" }
                : {
                    dispatched_at: new Date(
                      Date.parse(fixture.context.attempt_dispatched_at) + 1000,
                    ).toISOString(),
                  },
            )
            .where("id = :id", { id: "a-1" })
            .execute();
        } else {
          const field =
            kind === "identity"
              ? "identity_json"
              : kind === "target"
                ? "target_json"
                : "estimate_json";
          const value = JSON.parse(hold[field]);
          if (kind === "identity") value.teamId = "other-team";
          else if (kind === "target") value.model = "other-model";
          else if (kind === "price") value.version_id = "other-version";
          else if (kind === "fx") value.fx_version_id = "other-fx";
          else
            value.admission = {
              ...value.admission,
              policy_hash: "other-policy",
            };
          await source
            .createQueryBuilder()
            .update("pricing_reservations")
            .set({ [field]: JSON.stringify(value) })
            .where("id = :id", { id: "h-1" })
            .execute();
        }
        const basis = await ledger.groupDispositionBasis(
          fixture.row.id,
          workspace,
        );
        expect(basis.acceptance_blocked_reason).not.toBeNull();
        const before = await dump();
        await expect(
          service.dispose(
            actor,
            fixture.row.id,
            await input(fixture.row.id),
            false,
          ),
        ).rejects.toMatchObject({ status: 409 });
        expect(await dump()).toEqual(before);
        // Conflicting source authority is preserved, not repaired or charged.
        await service.dispose(
          actor,
          fixture.row.id,
          await input(fixture.row.id, "reject_evidence"),
          false,
        );
        expect(await source.query("SELECT * FROM pricing_attempts")).toEqual(
          before.pricing_attempts,
        );
      },
    );
    it.each([false, true])(
      "previews cumulative shared-budget underflow without writes (historical epoch: %s)",
      async (historical) => {
        const fixture = await seed("settled", 500);
        const rule = await source
          .getRepository(BudgetRule)
          .findOneByOrFail({ type: "daily_cost" });
        const period = new Date(rule.period_start).toISOString();
        if (historical) await budgets.resetRule(rule.id);
        else
          await source
            .getRepository(BudgetRule)
            .update(rule.id, { current_value: 0.0003 });
        await source
          .createQueryBuilder()
          .update("pricing_budget_balances")
          .set({
            amount_decimal: "0.000300000000000000",
            legacy_projection: String(
              source.options.type === "postgres" ? Math.fround(0.0003) : 0.0003,
            ),
          })
          .where("rule_id = :id AND period_start = :period", {
            id: rule.id,
            period,
          })
          .execute();
        const proposal = await input(fixture.row.id),
          before = await dump();
        // Each refund individually fits; the complete conserved group does not.
        await expect(
          service.dispose(actor, fixture.row.id, proposal, true),
        ).rejects.toThrow("underflow");
        expect(await dump()).toEqual(before);
        await expect(
          service.dispose(actor, fixture.row.id, proposal, false),
        ).rejects.toThrow("underflow");
        expect(await dump()).toEqual(before);
      },
    );
    it("adopts every initial member without applying a stored99USD budget proposal", async () => {
      const fixture = await seed("initial");
      const proposal = await input(fixture.row.id);
      const before = await balance();
      const result = await service.dispose(
        actor,
        fixture.row.id,
        proposal,
        false,
      );
      expect(
        result.changes.every(
          (change) => change.operation === "initial_receipt",
        ),
      ).toBe(true);
      expect(await balance()).toBe(before);
      expect(
        await source.query("SELECT * FROM pricing_settlement_intents"),
      ).toHaveLength(0);
      expect(
        (await source.query("SELECT state FROM pricing_attempts")).every(
          (row: { state: string }) => row.state === "terminal",
        ),
      ).toBe(true);
    });
    it.each(["reserved", "released"] as const)(
      "accepts cost-only%s changes without modifying logical holds",
      async (mode) => {
        const fixture = await seed(mode),
          before = await balance();
        const result = await service.dispose(
          actor,
          fixture.row.id,
          await input(fixture.row.id),
          false,
        );
        expect(
          result.changes.every(
            (change) => change.budget.budget_state === "not_applicable",
          ),
        ).toBe(true);
        expect(await balance()).toBe(before);
      },
    );
    it("rejects with complete custody and no monetary or original-record changes", async () => {
      const fixture = await seed(),
        before = await dump();
      const result = await service.dispose(
        actor,
        fixture.row.id,
        await input(fixture.row.id, "reject_evidence"),
        false,
      );
      expect(result.changes).toEqual([]);
      const after = await dump();
      for (const table of [
        "pricing_attempts",
        "pricing_reservations",
        "pricing_settlement_intents",
        "pricing_budget_effects",
        "pricing_budget_balances",
        "pricing_cost_adjustments",
        "pricing_runtime_group_outcomes",
      ])
        expect(after[table]).toEqual(before[table]);
      expect(
        (
          await ledger.runtimeGroupOutcomeInventory(
            workspace,
            "review_required",
            20,
          )
        ).items[0].disposition?.action,
      ).toBe("reject_evidence");
    });
    it("supports exact lost-response retry and read-only acknowledgement", async () => {
      const fixture = await seed(),
        proposal = await input(fixture.row.id);
      const first = await service.dispose(
          actor,
          fixture.row.id,
          proposal,
          false,
        ),
        before = await dump();
      const retry = await service.dispose(
        actor,
        fixture.row.id,
        proposal,
        false,
      );
      expect(retry.replayed).toBe(true);
      expect(retry.changes).toEqual(first.changes);
      expect(
        (
          await ledger.groupDispositionStatus(
            fixture.row.id,
            workspace,
            proposal.id,
          )
        ).result.changes,
      ).toEqual(first.changes);
      expect(await dump()).toEqual(before);
    });
    it("acknowledges a disposition after a later legitimate conserved correction", async () => {
      const fixture = await seed(),
        proposal = await input(fixture.row.id);
      const first = await service.dispose(
        actor,
        fixture.row.id,
        proposal,
        false,
      );
      const snapshot = await prices.restoreRequest("r-0", workspace);
      const next = snapshot.quote(
        target,
        tokens({ input_tokens: 3000, output_tokens: 0 }),
        fixture.context,
      ).cost;
      await ledger.adjustBatch({
        id: "later",
        attemptId: "a-0",
        workspace,
        expectedPhysicalCostHash: pricingContentHash(fixture.replacement),
        physicalCost: next,
        reason: "Later complete evidence",
        actorId: actor.id,
        source: "reconciliation",
      });
      expect(
        (
          await ledger.groupDispositionStatus(
            fixture.row.id,
            workspace,
            proposal.id,
          )
        ).result.changes,
      ).toEqual(first.changes);
      expect(await balance()).toBeCloseTo(0.003, 8);
    });
    it.each([
      "pricing_audit_events",
      "pricing_runtime_group_dispositions",
      "pricing_cost_adjustments",
    ])(
      "rolls back all members and budgets on required%s failure",
      async (table) => {
        const fixture = await seed(),
          proposal = await input(fixture.row.id),
          before = await dump();
        const fault = failInsert(
          table,
          table === "pricing_cost_adjustments" ? 2 : 1,
        );
        await expect(
          service.dispose(actor, fixture.row.id, proposal, false),
        ).rejects.toThrow("synthetic required write failure");
        fault.mockRestore();
        expect(await dump()).toEqual(before);
      },
    );
    it("fences a stale basis after sibling evidence changes and retains both bodies", async () => {
      const fixture = await seed(),
        proposal = await input(fixture.row.id);
      const variant = structuredClone(fixture.outcome);
      if (variant.type !== "attempt_group") throw new Error("fixture");
      variant.entries[0].errorCode = "later_error";
      await ledger.retainRuntimeGroupOutcome(variant);
      const before = await dump();
      await expect(
        service.dispose(actor, fixture.row.id, proposal, false),
      ).rejects.toMatchObject({ status: 409 });
      expect(await dump()).toEqual(before);
    });
    it("allows only one independent competing decision for the entire outcome", async () => {
      const fixture = await seed(),
        proposal = await input(fixture.row.id),
        other = await peer();
      const results = await Promise.allSettled([
        service.dispose(actor, fixture.row.id, proposal, false),
        other.service.dispose(
          actor,
          fixture.row.id,
          { ...proposal, id: "other-operation", action: "reject_evidence" },
          false,
        ),
      ]);
      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        await source.query("SELECT * FROM pricing_runtime_group_dispositions"),
      ).toHaveLength(1);
    });
    it("rejects forged client fields, foreign scope and non-admin writes", async () => {
      const fixture = await seed(),
        proposal = await input(fixture.row.id),
        before = await dump();
      await expect(
        service.dispose(
          { ...actor, role: "operator" },
          fixture.row.id,
          proposal,
          false,
        ),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        service.dispose(
          actor,
          fixture.row.id,
          { ...proposal, amount: "0" },
          false,
        ),
      ).rejects.toThrow();
      await expect(
        service.dispose(
          { ...actor, workspace_id: "foreign" },
          fixture.row.id,
          proposal,
          false,
        ),
      ).rejects.toMatchObject({ status: 404 });
      expect(await dump()).toEqual(before);
    });
    it("does not accept money that cannot reproduce from the original frozen tariff", async () => {
      const fixture = await seed();
      const falsePhysical = structuredClone(fixture.replacement);
      falsePhysical.lines[0].rate = "20";
      const allocation = allocateBatchCost(
        "batch",
        falsePhysical,
        fixture.members,
      );
      const variant = structuredClone(fixture.outcome);
      if (variant.type !== "attempt_group") throw new Error("fixture");
      variant.entries.forEach((entry, index) => {
        entry.cost = batchShareCost(allocation, index, "physical");
        entry.settlement!.receipts![0].cost = entry.cost;
      });
      const row = await ledger.retainRuntimeGroupOutcome(variant);
      await expect(
        service.dispose(actor, row.id, await input(row.id), false),
      ).rejects.toMatchObject({ status: 409 });
      expect(
        await source.query("SELECT * FROM pricing_runtime_group_dispositions"),
      ).toHaveLength(0);
    });
    it("does not apply an old-period refund to a reset current budget", async () => {
      const fixture = await seed("settled", 500);
      const rule = await source
        .getRepository(BudgetRule)
        .findOneByOrFail({ type: "daily_cost" });
      await budgets.resetRule(rule.id);
      const before = await balance();
      const result = await service.dispose(
        actor,
        fixture.row.id,
        await input(fixture.row.id),
        false,
      );
      expect(
        result.changes.every(
          (change) => change.budget.cost_delta === "-0.000250000000000000",
        ),
      ).toBe(true);
      expect(await balance()).toBe(before);
    });
    it("requires reread if a budget epoch changes after preview", async () => {
      const fixture = await seed(),
        proposal = await input(fixture.row.id);
      await service.dispose(actor, fixture.row.id, proposal, true);
      const rule = await source
        .getRepository(BudgetRule)
        .findOneByOrFail({ type: "daily_cost" });
      await budgets.resetRule(rule.id);
      await expect(
        service.dispose(actor, fixture.row.id, proposal, false),
      ).rejects.toMatchObject({ status: 409 });
      expect(
        await source.query("SELECT * FROM pricing_runtime_group_dispositions"),
      ).toHaveLength(0);
    });
    it("fences delayed direct delivery after rejection", async () => {
      const fixture = await seed("initial"),
        proposal = await input(fixture.row.id, "reject_evidence");
      await service.dispose(actor, fixture.row.id, proposal, false);
      const before = await dump();
      await expect(
        ledger.completeAttemptGroup(workspace, fixture.entries, fixture.row.id),
      ).rejects.toMatchObject({ status: 409 });
      expect(await dump()).toEqual(before);
    });
    it("preserves accepted reported-model evidence in subsequent normal correction APIs", async () => {
      const fixture = await seed("settled", 2000, 2, true),
        proposal = await input(fixture.row.id);
      const first = await service.dispose(
        actor,
        fixture.row.id,
        proposal,
        false,
      );
      expect(
        first.changes.every(
          (change) =>
            change.cost.attribution?.response_model === "reported-new",
        ),
      ).toBe(true);
      const correction = new PricingCorrectionService(ledger, prices);
      const result = await correction.correctBatch(
        actor,
        "a-0",
        {
          id: "ordinary-later",
          expectedPhysicalCostHash: pricingContentHash(fixture.replacement),
          reason: "New complete quantities",
          evidence: [
            {
              dimension: "total_input_tokens",
              value: "3000",
              source: "request_metadata",
            },
            {
              dimension: "uncached_input_tokens",
              value: "3000",
              source: "request_metadata",
            },
            {
              dimension: "output_tokens",
              value: "0",
              source: "request_metadata",
            },
          ],
        },
        false,
      );
      expect(
        result.changes.every(
          (change) =>
            change.cost.attribution?.response_model === "reported-new" &&
            change.cost.batch?.physical_cost.attribution?.response_model ===
              "reported-new",
        ),
      ).toBe(true);
      const snapshot = await prices.restoreRequest("r-0", workspace),
        newPhysical = snapshot.quote(
          target,
          tokens({ input_tokens: 4000, output_tokens: 0 }),
          fixture.context,
        ).cost;
      newPhysical.attribution = {
        ...fixture.replacement.attribution!,
        response_model: "reported-newer",
      };
      const allocation = allocateBatchCost(
        "batch",
        newPhysical,
        fixture.members,
      );
      const later = structuredClone(fixture.outcome);
      if (later.type !== "attempt_group") throw new Error("fixture");
      later.entries.forEach((entry, index) => {
        entry.cost = batchShareCost(allocation, index, "physical");
        entry.settlement!.receipts![0].cost = entry.cost;
      });
      const laterRow = await ledger.retainRuntimeGroupOutcome(later);
      await service.dispose(
        actor,
        laterRow.id,
        await input(laterRow.id, "accept_receipts", "runtime-later"),
        false,
      );
      const before = await balance();
      const retry = await correction.correctBatch(
        actor,
        "a-0",
        {
          id: "ordinary-later",
          expectedPhysicalCostHash: pricingContentHash(fixture.replacement),
          reason: "New complete quantities",
          evidence: [
            {
              dimension: "total_input_tokens",
              value: "3000",
              source: "request_metadata",
            },
            {
              dimension: "uncached_input_tokens",
              value: "3000",
              source: "request_metadata",
            },
            {
              dimension: "output_tokens",
              value: "0",
              source: "request_metadata",
            },
          ],
        },
        false,
      );
      expect(retry.replayed).toBe(true);
      expect(retry.changes).toEqual(result.changes);
      expect(await balance()).toBe(before);
    });
    it("acknowledges physically identical retained receipts without adding revisions", async () => {
      const fixture = await seed("settled", 1000),
        before = await balance();
      const result = await service.dispose(
        actor,
        fixture.row.id,
        await input(fixture.row.id),
        false,
      );
      expect(
        result.changes.every(
          (change) => change.operation === "already_recorded",
        ),
      ).toBe(true);
      expect(
        await source.query("SELECT * FROM pricing_cost_adjustments"),
      ).toHaveLength(0);
      expect(await balance()).toBe(before);
    });
    it("fills a compatible partially recorded group without changing its already recorded member", async () => {
      const fixture = await seed("initial", 1000);
      await ledger.completeAttempt("a-0", workspace, fixture.old[0].cost);
      const before = await balance();
      const result = await service.dispose(
        actor,
        fixture.row.id,
        await input(fixture.row.id),
        false,
      );
      expect(result.changes.map((change) => change.operation)).toEqual([
        "already_recorded",
        "initial_receipt",
      ]);
      expect(await balance()).toBe(before);
      expect(
        await source.query("SELECT * FROM pricing_cost_adjustments"),
      ).toHaveLength(0);
    });
    it("does not invent a coherent original lineage for incompatible partial records", async () => {
      const fixture = await seed("initial");
      await ledger.completeAttempt("a-0", workspace, fixture.old[0].cost);
      const basis = await ledger.groupDispositionBasis(
        fixture.row.id,
        workspace,
      );
      expect(basis.acceptance_blocked_reason).toBe(
        "inconsistent_group_history",
      );
      await expect(
        service.dispose(
          actor,
          fixture.row.id,
          await input(fixture.row.id),
          false,
        ),
      ).rejects.toMatchObject({ status: 409 });
      const before = await balance();
      await service.dispose(
        actor,
        fixture.row.id,
        await input(fixture.row.id, "reject_evidence"),
        false,
      );
      expect(await balance()).toBe(before);
    });
    it.each(["lease", "intent", "async"] as const)(
      "fences%s ownership before any disposition",
      async (kind) => {
        const fixture = await seed("initial");
        if (kind === "lease")
          await source
            .createQueryBuilder()
            .update("pricing_reservations")
            .set({ lease_until: new Date(Date.now() + 60000).toISOString() })
            .where("id = :id", { id: "h-0" })
            .execute();
        if (kind === "async")
          await source
            .createQueryBuilder()
            .update("pricing_reservations")
            .set({ job_id: "synthetic-media-job" })
            .where("id = :id", { id: "h-0" })
            .execute();
        if (kind === "intent")
          await ledger.queueSettlement("h-0", workspace, "release");
        const before = await dump();
        await expect(
          service.dispose(
            actor,
            fixture.row.id,
            await input(fixture.row.id, "reject_evidence"),
            false,
          ),
        ).rejects.toMatchObject({ status: 409 });
        expect(await dump()).toEqual(before);
      },
    );
    it("removes only an audited disposed row from the unresolved admission backlog", async () => {
      const fixture = await seed();
      const rows = await source.query(
        "SELECT * FROM pricing_runtime_group_outcomes",
      );
      for (let i = 0; i < 999; i++)
        await source
          .createQueryBuilder()
          .insert()
          .into("pricing_runtime_group_outcomes")
          .values({ ...rows[0], id: `synthetic-cap-${i}` })
          .execute();
      await expect(
        ledger.assertRuntimeOutcomeCapacity(workspace),
      ).rejects.toMatchObject({ status: 503 });
      await service.dispose(
        actor,
        fixture.row.id,
        await input(fixture.row.id, "reject_evidence"),
        false,
      );
      await expect(
        ledger.assertRuntimeOutcomeCapacity(workspace),
      ).resolves.toBeUndefined();
    });
    it("recovers an operation acknowledgement after an actual child exits immediately after commit", async () => {
      const fixture = await seed(),
        proposal = await input(fixture.row.id);
      const child = spawnSync(
        process.execPath,
        [
          "-r",
          require.resolve("ts-node/register"),
          "-e",
          `require('reflect-metadata');const{DataSource}=require('typeorm');const{BudgetRule}=require('./src/database/entities/budget-rule.entity');const{CallLog}=require('./src/database/entities/call-log.entity');const{BudgetService}=require('./src/budget/budget.service');const{WorkspaceContextService}=require('./src/workspaces/workspace-context.service');const{CostLedgerService}=require('./src/pricing/cost-ledger.service');const{PricingRepository}=require('./src/pricing/pricing-repository');const{PricingGroupDispositionService}=require('./src/pricing/pricing-group-disposition.service');(async()=>{const source=await new DataSource({...JSON.parse(process.env.REVIEW_DB),entities:[BudgetRule,CallLog],synchronize:false}).initialize();const ledger=new CostLedgerService(source,new BudgetService({},new WorkspaceContextService(),source.getRepository(BudgetRule)));await new PricingGroupDispositionService(ledger,new PricingRepository(source)).dispose(JSON.parse(process.env.REVIEW_ACTOR),process.env.REVIEW_ID,JSON.parse(process.env.REVIEW_INPUT),false);process.exit(17)})().catch(error=>{console.error(error.message);process.exit(18)});`,
        ],
        {
          cwd: process.cwd(),
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            TMPDIR: process.env.TMPDIR,
            NODE_OPTIONS: "--max-old-space-size=512",
            TS_NODE_TRANSPILE_ONLY: "true",
            REVIEW_DB: JSON.stringify(source.options),
            REVIEW_ACTOR: JSON.stringify(actor),
            REVIEW_ID: fixture.row.id,
            REVIEW_INPUT: JSON.stringify(proposal),
          },
          encoding: "utf8",
          timeout: 20000,
        },
      );
      expect({ status: child.status, stderr: child.stderr }).toMatchObject({
        status: 17,
      });
      const before = await dump();
      expect(
        (await service.dispose(actor, fixture.row.id, proposal, false))
          .replayed,
      ).toBe(true);
      expect(await dump()).toEqual(before);
    }, 30000);
    it("acknowledges unchanged partial historical evidence without adopting missing shares", async () => {
      const fixture = await seed("reserved"),
        row = await secondGroup(fixture, "partial", 1000);
      const before = await balance();
      const result = await service.dispose(
        actor,
        row.id,
        await input(row.id),
        false,
      );
      expect(result.changes).toHaveLength(3);
      expect(
        result.changes.filter(
          (change) => change.operation === "initial_receipt",
        ),
      ).toHaveLength(2);
      expect(
        result.changes.filter(
          (change) => change.operation === "already_recorded",
        ),
      ).toHaveLength(1);
      expect(await balance()).toBe(before);
    });
    it("blocks changed partial historical evidence but permits rejection with custody", async () => {
      const fixture = await seed("reserved"),
        row = await secondGroup(fixture, "partial", 2000);
      const basis = await ledger.groupDispositionBasis(row.id, workspace);
      expect(basis.acceptance_blocked_reason).toBe(
        "incomplete_historical_group",
      );
      const before = await dump();
      await expect(
        service.dispose(actor, row.id, await input(row.id), false),
      ).rejects.toMatchObject({ status: 409 });
      expect(await dump()).toEqual(before);
      await service.dispose(
        actor,
        row.id,
        await input(row.id, "reject_evidence"),
        false,
      );
    });
    it("handles multiple complete physical cohorts atomically while charging only the stored logical winner", async () => {
      const fixture = await seed("reserved"),
        row = await secondGroup(fixture, "complete", 2000, 3000);
      const proposal = await input(row.id),
        before = await dump();
      const preview = await service.dispose(actor, row.id, proposal, true);
      expect(await dump()).toEqual(before);
      expect(preview.changes).toHaveLength(4);
      const result = await service.dispose(actor, row.id, proposal, false);
      expect(
        result.changes.filter(
          (change) => change.budget.budget_state === "applied",
        ),
      ).toHaveLength(2);
      expect(await balance()).toBeCloseTo(0.004, 8);
      expect(
        (await source.getRepository(CallLog).find()).map((log) => log.cost_usd),
      ).toEqual([0.003, 0.003]);
      expect(
        (await ledger.groupDispositionStatus(row.id, workspace, proposal.id))
          .result.changes,
      ).toHaveLength(4);
    });
    it("corrects unknown physical usage against the charged estimate rather than zero", async () => {
      const fixture = await seed("settled", 2000, 2, false, true);
      expect(await balance()).toBeCloseTo(0.4, 8);
      const result = await service.dispose(
        actor,
        fixture.row.id,
        await input(fixture.row.id),
        false,
      );
      expect(
        result.changes.every(
          (change) => change.budget.cost_delta === "-0.199000000000000000",
        ),
      ).toBe(true);
      expect(await balance()).toBeCloseTo(0.002, 8);
    });
    it("keeps known charges when replacement usage is unknown", async () => {
      const fixture = await seed("settled", null);
      const before = await balance();
      const result = await service.dispose(
        actor,
        fixture.row.id,
        await input(fixture.row.id),
        false,
      );
      expect(
        result.changes.every(
          (change) =>
            change.cost.report_amount === null &&
            change.budget.budget_state === "pending",
        ),
      ).toBe(true);
      expect(await balance()).toBe(before);
    });
    it("preserves populated010 custody and accounting bytes during011 migration", async () => {
      await seed();
      const before = await dump(),
        markers = await source.query(
          "SELECT * FROM pricing_schema_versions ORDER BY id",
        );
      const runner = source.createQueryRunner();
      try {
        // Recreate an actual010 database, not one with a newer012 marker whose
        // prerequisite011 was removed. Never weaken migration ordering checks.
        for(const step of [...PRICING_MIGRATIONS.slice(11)].reverse()){
          for (const index of [...(step.indexes ?? [])].reverse()) await runner.dropIndex(index.table, index.definition.name!);
          for(const table of [...step.definitions].reverse())await runner.dropTable(table.name);
          await runner.manager.createQueryBuilder().delete().from("pricing_schema_versions").where("id = :id",{id:step.version}).execute();
        }
        await runner.dropTable("pricing_runtime_group_dispositions");
        await runner.manager
          .createQueryBuilder()
          .delete()
          .from("pricing_schema_versions")
          .where("id = :id", { id: "pricing-engine-011" })
          .execute();
      } finally {
        await runner.release();
      }
      expect((await planPricingSchema(source)).create_tables).toEqual(PRICING_MIGRATIONS.slice(10).flatMap(step=>step.definitions.map(table=>table.name)));
      await applyPricingSchema(source);
      expect(await dump()).toEqual(before);
      expect(
        (
          await source.query(
            "SELECT * FROM pricing_schema_versions ORDER BY id",
          )
        ).slice(0, 10),
      ).toEqual(markers.slice(0, 10));
    });
    it("keeps original price and FX after the current catalog and exchange schedule change", async () => {
      const content = tokenBook();
      content.currency = "CNY";
      const book = await prices.createBook(actor, {
        name: "Synthetic CNY",
        scope: "workspace",
        content,
      });
      await prices.publishDraft(actor, book.draft.id, {
        draft_revision: 1,
        catalog_revision: 1,
        reason: "Synthetic CNY",
        confirm: true,
        targets: [{ level: "model", model: target.model }],
      });
      await prices.updateFx(actor, {
        catalog_revision: 2,
        scope: "workspace",
        reason: "Synthetic FX",
        confirm: true,
        versions: [
          {
            fx: {
              version_id: "fixture-fx",
              source: "synthetic",
              effective_at: "2020-01-01T00:00:00Z",
              from_currency: "CNY",
              to_currency: "USD",
              numerator: "1",
              denominator: "7",
            },
          },
        ],
      });
      const fixture = await seed(),
        proposal = await input(fixture.row.id);
      await prices.updateFx(actor, {
        catalog_revision: 3,
        scope: "workspace",
        reason: "Remove current FX",
        confirm: true,
        versions: [],
      });
      const result = await service.dispose(
        actor,
        fixture.row.id,
        proposal,
        false,
      );
      expect(
        result.changes.every(
          (change) =>
            change.cost.fx_version_id === fixture.replacement.fx_version_id &&
            change.cost.currency === "CNY",
        ),
      ).toBe(true);
      expect(await balance()).toBeCloseTo(
        Number(fixture.replacement.report_amount),
        8,
      );
    });
    it("refuses acknowledgement without the mandatory physical correction audit", async () => {
      const fixture = await seed(),
        proposal = await input(fixture.row.id);
      const result = await service.dispose(
        actor,
        fixture.row.id,
        proposal,
        false,
      );
      const id = result.changes[0].cost.batch!.correction!.id;
      await source
        .createQueryBuilder()
        .delete()
        .from("pricing_audit_events")
        .where("id = :id", {
          id: `batch-correction:${pricingContentHash([workspace, id])}`,
        })
        .execute();
      await expect(
        ledger.groupDispositionStatus(fixture.row.id, workspace, proposal.id),
      ).rejects.toMatchObject({ status: 409 });
    });
  });
}
contract("SQLite WAL group disposition", async () => {
  const directory = mkdtempSync(join(tmpdir(), "group-disposition-"));
  const source = await new DataSource({
    type: "better-sqlite3",
    database: join(directory, "database.sqlite"),
    entities: [BudgetRule, CallLog],
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
  throw new Error("Use isolated PostgreSQL only");
contract(
  "PostgreSQL group disposition",
  async () => {
    if (!pgUrl) throw new Error("No isolated PostgreSQL URL");
    const schema = `group_disposition_${process.pid}_${Math.random().toString(16).slice(2)}`;
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
        entities: [BudgetRule, CallLog],
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

import { DataSource, InsertQueryBuilder } from "typeorm";
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
import {
  applyPricingSchema,
  planPricingSchema,
  PRICING_MIGRATIONS,
} from "../../src/pricing/pricing-schema";
import { runtimeOutcomeDocument } from "../../src/pricing/pricing-outcome-document";
import { PricingOutcomeDispositionService } from "../../src/pricing/pricing-outcome-disposition.service";
import type { OutcomeDispositionInput } from "../../src/pricing/pricing-outcome-disposition.types";
import { PricingCompileError } from "../../src/pricing/pricing-errors";
import { type PricingOutcome } from "../../src/pricing/pricing-outcome-retry";
import { mockConfigService } from "../helpers";
import { tokenBook, tokens, rate } from "./pricing-fixtures";
import { compilePriceBook } from "../../src/pricing/pricing-compiler";
import { calculateCost } from "../../src/pricing/cost-calculator";
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
      prices: PricingRepository,
      service: PricingOutcomeDispositionService;
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
      service = new PricingOutcomeDispositionService(ledger, prices);
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

    const dump = async () => {
      const all: Record<string, unknown> = {};
      for (const name of [
        "pricing_runtime_outcomes",
        "pricing_runtime_outcome_dispositions",
        "pricing_adjustment_applications",
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

    async function proposal(
      outcome: PricingOutcome,
      action: OutcomeDispositionInput["action"] = "accept_receipts",
      id = "review-1",
    ) {
      const outcomeId = runtimeOutcomeDocument(outcome).id;
      const basis = await ledger.outcomeDispositionBasis(outcomeId, workspace);
      return {
        outcomeId,
        basis,
        input: {
          id,
          action,
          expected_basis_hash: basis.basis_hash,
          expected_outcome_hash: basis.outcome_hash,
          reason: "Reviewed synthetic retained evidence",
          confirm: true as const,
        },
      };
    }
    async function reviewed(
      state: "committed" | "reserved" | "released" | "missing" = "committed",
    ) {
      const data = await seed();
      if (state !== "missing")
        await ledger.completeAttempt(
          data.attempt.attemptId,
          workspace,
          data.cost,
        );
      if (state === "committed")
        await ledger.settle(
          "r1",
          workspace,
          "commit",
          "1100",
          data.cost.report_amount!,
          "legacy_logical",
          { attemptId: data.attempt.attemptId, cost: data.cost },
        );
      if (state === "released") await ledger.settle("r1", workspace, "release");
      await ledger.archiveRuntimeOutcome(data.different);
      return { ...data, ...(await proposal(data.different)) };
    }
    it("previews exact cost and original-epoch budget deltas without any writes", async () => {
      const { outcomeId, input } = await reviewed(),
        before = await dump();
      const preview = await service.dispose(actor, outcomeId, input, true);
      expect(preview).toMatchObject({
        dry_run: true,
        supplier_confirmed: false,
        outcome_document_modified: false,
        budget_decision_unchanged: true,
      });
      expect(preview.changes[0]).toMatchObject({
        operation: "linked_correction",
        cost: { report_amount: "0.002200000", evidence_status: "observed" },
        adjustment: null,
        budget: { cost_delta: "0.001000000000000000", tokens_delta: "1000" },
      });
      expect(await dump()).toEqual(before);
      const result = await service.dispose(actor, outcomeId, input, false);
      expect(result.changes[0].budget).toEqual(preview.changes[0].budget);
      const after = await dump();
      expect(after.pricing_runtime_outcomes).toEqual(
        before.pricing_runtime_outcomes,
      );
      expect(after.pricing_attempts).toEqual(before.pricing_attempts);
      expect(after.pricing_settlement_intents).toEqual(
        before.pricing_settlement_intents,
      );
      expect(
        (await ledger.summary("r1", workspace))!.budget_committed_usd,
      ).toBe("0.002200000000000000");
    });
    it("rejects evidence with immutable custody, no guessed refund or budget release", async () => {
      const { different, outcomeId } = await reviewed("reserved"),
        { input } = await proposal(different, "reject_evidence"),
        before = await dump();
      expect(
        (await service.dispose(actor, outcomeId, input, true)).changes,
      ).toEqual([]);
      expect(await dump()).toEqual(before);
      expect(
        (await service.dispose(actor, outcomeId, input, false)).action,
      ).toBe("reject_evidence");
      const after = await dump();
      for (const key of [
        "pricing_runtime_outcomes",
        "pricing_attempts",
        "pricing_reservations",
        "pricing_budget_balances",
        "pricing_budget_effects",
        "budget_rules",
      ])
        expect(after[key]).toEqual(before[key]);
      const confirmed = await ledger.outcomeDispositionStatus(
        outcomeId,
        workspace,
        input.id,
      );
      expect(confirmed.result.replayed).toBe(true);
    });
    it.each(["reserved", "released"] as const)(
      "accepts %s cost evidence without choosing or changing the budget decision",
      async (state) => {
        const { outcomeId, input } = await reviewed(state),
          before = await dump();
        const result = await service.dispose(actor, outcomeId, input, false);
        expect(result.changes[0].budget.budget_state).toBe("not_applicable");
        const after = await dump();
        for (const key of [
          "pricing_reservations",
          "pricing_budget_balances",
          "pricing_budget_effects",
          "budget_rules",
        ])
          expect(after[key]).toEqual(before[key]);
      },
    );
    it("adopts a missing first runtime receipt without changing the unresolved hold", async () => {
      const { outcomeId, input, different } = await reviewed("missing"),
        before = await dump();
      const preview = await service.dispose(actor, outcomeId, input, true);
      expect(preview.changes[0].operation).toBe("initial_receipt");
      expect(await dump()).toEqual(before);
      const result = await service.dispose(actor, outcomeId, input, false);
      expect(result.changes[0].cost).toEqual(different.cost);
      expect((await ledger.summary("r1", workspace))!.amount).toBe(
        "0.002200000000000000",
      );
      expect((await dump()).pricing_reservations).toEqual(
        before.pricing_reservations,
      );
      expect(
        (await ledger.outcomeDispositionStatus(outcomeId, workspace, input.id))
          .result.changes[0].operation,
      ).toBe("initial_receipt");
    });
    it("acknowledges identical recorded evidence without another adjustment", async () => {
      const { attempt } = await seed();
      await ledger.completeAttempt(attempt.attemptId, workspace, attempt.cost);
      await ledger.archiveRuntimeOutcome(attempt);
      const { outcomeId, input } = await proposal(attempt),
        before = await dump();
      const result = await service.dispose(actor, outcomeId, input, false);
      expect(result.changes[0].operation).toBe("already_recorded");
      expect((await dump()).pricing_cost_adjustments).toEqual(
        before.pricing_cost_adjustments,
      );
    });
    it("binds exact retry and read-only acknowledgement to operation, actor and original reviewed result", async () => {
      const { outcomeId, input } = await reviewed();
      const result = await service.dispose(actor, outcomeId, input, false),
        after = await dump();
      expect(
        (await service.dispose(actor, outcomeId, input, false)).replayed,
      ).toBe(true);
      expect(
        (await ledger.outcomeDispositionStatus(outcomeId, workspace, input.id))
          .result,
      ).toEqual({ ...result, replayed: true });
      expect(await dump()).toEqual(after);
      await expect(
        service.dispose(
          { ...actor, id: "different-admin" },
          outcomeId,
          input,
          false,
        ),
      ).rejects.toMatchObject({ status: 409 });
      await expect(
        service.dispose(
          actor,
          outcomeId,
          { ...input, reason: "different" },
          false,
        ),
      ).rejects.toMatchObject({ status: 409 });
      await expect(
        service.dispose(actor, outcomeId, { ...input, id: "different" }, false),
      ).rejects.toMatchObject({ status: 409 });
    });
    it("preserves earlier acknowledgement after a newer correction without reversing effective history", async () => {
      const { outcomeId, input } = await reviewed();
      const result = await service.dispose(actor, outcomeId, input, false);
      const basis = await ledger.attemptCorrectionBasis("a-r1", workspace);
      await new PricingAttemptCorrectionService(ledger, prices).correct(
        actor,
        "a-r1",
        {
          id: "newer-manual",
          expected_basis_hash: basis.basis_hash,
          expected_cost_hash: basis.effective_cost_hash,
          confirm: true,
          reason: "Later manual estimate",
          evidence: Object.values(
            tokens({ input_tokens: 3000, output_tokens: 100 }).quantities,
          ).map((q) => ({ dimension: q!.dimension, value: q!.value })),
        },
        false,
      );
      const before = await dump();
      expect(
        (await service.dispose(actor, outcomeId, input, false)).changes,
      ).toEqual(result.changes);
      expect(await dump()).toEqual(before);
      expect(
        (await ledger.summary("r1", workspace))!.budget_committed_usd,
      ).toBe("0.003200000000000000");
    });
    it("detects a newly retained sibling between preview and apply", async () => {
      const { outcomeId, input, different } = await reviewed();
      await service.dispose(actor, outcomeId, input, true);
      await ledger.archiveRuntimeOutcome({
        ...different,
        errorCode: "later_variant",
      });
      await expect(
        service.dispose(actor, outcomeId, input, false),
      ).rejects.toMatchObject({ status: 409 });
      expect(
        await source.query(
          "SELECT * FROM pricing_runtime_outcome_dispositions",
        ),
      ).toEqual([]);
    });
    it("detects an administrator estimate committed after the basis was read", async () => {
      const { outcomeId, input } = await reviewed(),
        basis = await ledger.attemptCorrectionBasis("a-r1", workspace);
      await new PricingAttemptCorrectionService(ledger, prices).correct(
        actor,
        "a-r1",
        {
          id: "manual-first",
          expected_basis_hash: basis.basis_hash,
          expected_cost_hash: basis.effective_cost_hash,
          confirm: true,
          reason: "Independent estimate",
          evidence: Object.values(
            tokens({ input_tokens: 3000, output_tokens: 100 }).quantities,
          ).map((q) => ({ dimension: q!.dimension, value: q!.value })),
        },
        false,
      );
      await expect(
        service.dispose(actor, outcomeId, input, false),
      ).rejects.toMatchObject({ status: 409 });
    });
    it("preserves error/outcome history while correcting a retained cost observation", async () => {
      const { outcomeId, input } = await reviewed();
      await source
        .createQueryBuilder()
        .update("pricing_attempts")
        .set({ error_code: "supplier_outcome_unconfirmed" })
        .where("id = :id", { id: "a-r1" })
        .execute();
      const basis = await ledger.outcomeDispositionBasis(outcomeId, workspace);
      const result = await service.dispose(
        actor,
        outcomeId,
        { ...input, expected_basis_hash: basis.basis_hash },
        false,
      );
      expect(result.changes[0]).toMatchObject({
        error_code: "supplier_outcome_unconfirmed",
        original_error_preserved: true,
      });
    });
    it("refuses money/source/client quantity overrides and viewer writes", async () => {
      const { outcomeId, input } = await reviewed();
      for (const extra of [
        { money: "0" },
        { cost: {} },
        { source: "provider_usage" },
        { evidence: [] },
        { confirm: false },
      ])
        await expect(
          service.dispose(actor, outcomeId, { ...input, ...extra }, false),
        ).rejects.toBeInstanceOf(PricingCompileError);
      await expect(
        service.dispose(
          { ...actor, role: "operator" },
          outcomeId,
          input,
          false,
        ),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        service.dispose(
          { ...actor, workspace_id: "foreign" },
          outcomeId,
          input,
          false,
        ),
      ).rejects.toMatchObject({ status: 404 });
    });
    it("rejects computed-money tampering rather than trusting a retained hash as a calculator", async () => {
      const { different } = await seed();
      different.cost.report_amount = "999";
      await ledger.archiveRuntimeOutcome(different);
      const { outcomeId, input } = await proposal(different);
      await expect(
        service.dispose(actor, outcomeId, input, false),
      ).rejects.toMatchObject({ status: 409 });
      expect(
        (
          await service.dispose(
            actor,
            outcomeId,
            { ...input, action: "reject_evidence" },
            false,
          )
        ).changes,
      ).toEqual([]);
    });
    it("uses frozen prices after a new price publication", async () => {
      const { outcomeId, input } = await reviewed(),
        content = tokenBook();
      content.groups[0].rules[0].rates[0].component.amount = "99";
      const created = await prices.createBook(actor, {
        name: "New current price",
        scope: "workspace",
        content,
      });
      await prices.publishDraft(actor, created.draft.id, {
        draft_revision: 1,
        catalog_revision: 1,
        reason: "New test prices",
        confirm: true,
        targets: [{ level: "model", model: target.model }],
      });
      const result = await service.dispose(actor, outcomeId, input, false);
      expect(result.changes[0].cost.report_amount).toBe("0.002200000");
    });
    it("keeps an old-period refund out of today's reset balance", async () => {
      const { cost, attempt } = await seed();
      await ledger.completeAttempt(attempt.attemptId, workspace, cost);
      await ledger.settle(
        "r1",
        workspace,
        "commit",
        "1100",
        cost.report_amount!,
        "legacy_logical",
        { attemptId: attempt.attemptId, cost },
      );
      const rules = await source.getRepository(BudgetRule).find();
      await source.getRepository(BudgetRule).update(rules[0].id, {
        period_start: new Date(Date.now() + 3600000),
        current_value: 5,
      });
      const snap = await prices.restoreRequest("r1", workspace),
        decreased = {
          ...attempt,
          cost: snap.quote(
            target,
            tokens({ input_tokens: 500, output_tokens: 0 }),
          ).cost,
        };
      await ledger.archiveRuntimeOutcome(decreased);
      const { outcomeId, input } = await proposal(decreased),
        before = await source.query("SELECT * FROM budget_rules");
      const result = await service.dispose(actor, outcomeId, input, false);
      expect(result.changes[0].budget.cost_delta).toBe("-0.000700000000000000");
      expect(await source.query("SELECT * FROM budget_rules")).toEqual(before);
    });
    it.each(["lease", "intent", "async"])(
      "blocks %s ownership without side effects",
      async (kind) => {
        const { outcomeId, input, cost } = await reviewed("reserved");
        if (kind === "lease")
          await ledger.renew(
            "r1",
            workspace,
            "synthetic-owner",
            new Date(Date.now() + 60000).toISOString(),
          );
        if (kind === "intent")
          await ledger.queueSettlement(
            "r1",
            workspace,
            "commit",
            "1100",
            cost.report_amount!,
            "legacy_logical",
            { attemptId: "a-r1", cost },
          );
        if (kind === "async")
          await source
            .createQueryBuilder()
            .update("pricing_reservations")
            .set({ job_id: "synthetic-job" })
            .where("id = :id", { id: "r1" })
            .execute();
        const before = await dump(),
          basis = await ledger.outcomeDispositionBasis(outcomeId, workspace);
        expect(basis.blocked_reason).not.toBeNull();
        await expect(
          service.dispose(
            actor,
            outcomeId,
            { ...input, expected_basis_hash: basis.basis_hash },
            false,
          ),
        ).rejects.toMatchObject({ status: 409 });
        expect(await dump()).toEqual(before);
      },
    );
    it("does not adopt one member of a physical batch", async () => {
      const { attempt } = await seed();
      const allocated = allocateBatchCost("physical", attempt.cost, [
        {
          request_id: "r1",
          reservation_id: "r1",
          input_start: 0,
          input_count: 1,
          weight: "1",
          weight_basis: "token_input_count",
        },
      ]);
      const outcome = {
        ...attempt,
        cost: batchShareCost(allocated, 0, "physical-attempt"),
      };
      await ledger.archiveRuntimeOutcome(outcome);
      const { outcomeId, input, basis } = await proposal(outcome);
      expect(basis.blocked_reason).toBe("batch_group_required");
      await expect(
        service.dispose(actor, outcomeId, input, false),
      ).rejects.toMatchObject({ status: 409 });
    });
    it("accepts all independent receipts carried by one settlement without adopting its budget proposal", async () => {
      const data = await seed();
      await ledger.beginAttempt({
        id: "a2",
        requestId: "r1",
        workspace,
        reservationId: "r1",
        target,
        feeSource: "provider",
        dispatchedAt: "2026-09-20T00:00:00Z",
        priceContext: { context: {}, legacyPrice: null },
      });
      const outcome: PricingOutcome = {
        type: "settlement",
        workspace,
        reservationId: "r1",
        payload: {
          kind: "commit",
          tokens: "999",
          cost_usd: "99",
          budget_basis: "legacy_logical",
          receipt: { attemptId: "a-r1", cost: data.cost },
          receipts: [{ attemptId: "a2", cost: data.different.cost }],
        },
      };
      await ledger.archiveRuntimeOutcome(outcome);
      const { outcomeId, input } = await proposal(outcome),
        before = await dump();
      const result = await service.dispose(actor, outcomeId, input, false);
      expect(result.changes).toHaveLength(2);
      expect(
        result.changes.every((c) => c.operation === "initial_receipt"),
      ).toBe(true);
      expect((await dump()).pricing_reservations).toEqual(
        before.pricing_reservations,
      );
      expect(
        await source.query("SELECT * FROM pricing_settlement_intents"),
      ).toEqual([]);
    });
    it("rolls back every receipt when one retained computation cannot reproduce", async () => {
      const data = await seed();
      await ledger.beginAttempt({
        id: "a2",
        requestId: "r1",
        workspace,
        reservationId: "r1",
        target,
        feeSource: "provider",
        dispatchedAt: "2026-09-20T00:00:00Z",
        priceContext: { context: {}, legacyPrice: null },
      });
      const outcome: PricingOutcome = {
        type: "settlement",
        workspace,
        reservationId: "r1",
        payload: {
          kind: "release",
          tokens: "0",
          cost_usd: "0",
          budget_basis: "legacy_logical",
          receipt: null,
          receipts: [
            { attemptId: "a-r1", cost: data.cost },
            { attemptId: "a2", cost: { ...data.cost, report_amount: "99" } },
          ],
        },
      };
      await ledger.archiveRuntimeOutcome(outcome);
      const { outcomeId, input } = await proposal(outcome),
        before = await dump();
      await expect(
        service.dispose(actor, outcomeId, input, false),
      ).rejects.toMatchObject({ status: 409 });
      expect(await dump()).toEqual(before);
    });
    it("rolls back correction, exact budget and disposition if the mandatory audit fails", async () => {
      const { outcomeId, input } = await reviewed(),
        before = await dump(),
        execute = InsertQueryBuilder.prototype.execute;
      jest
        .spyOn(InsertQueryBuilder.prototype, "execute")
        .mockImplementation(function () {
          if (
            this.expressionMap.mainAlias?.tablePath === "pricing_audit_events"
          )
            throw new Error("required disposition audit unavailable");
          return execute.call(this);
        });
      await expect(
        service.dispose(actor, outcomeId, input, false),
      ).rejects.toThrow("required disposition audit");
      expect(await dump()).toEqual(before);
    });
    it("does not acknowledge a disposition whose required audit or adjustment chain was damaged", async () => {
      const { outcomeId, input } = await reviewed();
      await service.dispose(actor, outcomeId, input, false);
      const rows = await source.query(
        "SELECT * FROM pricing_runtime_outcome_dispositions",
      );
      await source
        .createQueryBuilder()
        .delete()
        .from("pricing_audit_events")
        .where("id = :id", { id: rows[0].audit_id })
        .execute();
      await expect(
        ledger.outcomeDispositionStatus(outcomeId, workspace, input.id),
      ).rejects.toMatchObject({ status: 409 });
    });
    it("deduplicates concurrent independent PostgreSQL reviewers without a second debit", async () => {
      const { outcomeId, input } = await reviewed(),
        other =
          source.options.type === "postgres"
            ? await new DataSource({
                ...source.options,
                synchronize: false,
              } as ConstructorParameters<typeof DataSource>[0]).initialize()
            : source;
      try {
        const independent = makeLedger(other),
          second = new PricingOutcomeDispositionService(
            independent,
            new PricingRepository(other),
          );
        const results = await Promise.all([
          service.dispose(actor, outcomeId, input, false),
          second.dispose(actor, outcomeId, input, false),
        ]);
        expect(results.filter((r) => r.replayed)).toHaveLength(1);
        expect(
          await source.query(
            "SELECT * FROM pricing_runtime_outcome_dispositions",
          ),
        ).toHaveLength(1);
        expect(
          (await ledger.summary("r1", workspace))!.budget_committed_usd,
        ).toBe("0.002200000000000000");
      } finally {
        if (other !== source) await other.destroy();
      }
    });
    it("fences a delayed rejected runtime write under the original request lock", async () => {
      const { different, outcomeId } = await reviewed("missing"),
        { input } = await proposal(different, "reject_evidence");
      await service.dispose(actor, outcomeId, input, false);
      await expect(
        ledger.completeAttempt(
          different.attemptId,
          workspace,
          different.cost,
          null,
          outcomeId,
        ),
      ).rejects.toMatchObject({ status: 409 });
      expect(
        (await ledger.summary("r1", workspace))!.attempts[0].cost,
      ).toBeNull();
    });
    it("survives a real child exit after atomic disposition commit and acknowledges without double charging", async () => {
      const { outcomeId, input } = await reviewed(),
        options = {
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
          `const {DataSource}=require('typeorm');const {BudgetRule}=require('./src/database/entities/budget-rule.entity');const {BudgetService}=require('./src/budget/budget.service');const {WorkspaceContextService}=require('./src/workspaces/workspace-context.service');const {CostLedgerService}=require('./src/pricing/cost-ledger.service');const {PricingRepository}=require('./src/pricing/pricing-repository');const {PricingOutcomeDispositionService}=require('./src/pricing/pricing-outcome-disposition.service');(async()=>{const source=await new DataSource({...${JSON.stringify(options)},entities:[BudgetRule]}).initialize();const budgets=new BudgetService({getSnapshot:()=>({config:{budget:{},nodes:[]}})},new WorkspaceContextService(),source.getRepository(BudgetRule));const service=new PricingOutcomeDispositionService(new CostLedgerService(source,budgets),new PricingRepository(source));await service.dispose(${JSON.stringify(actor)},${JSON.stringify(outcomeId)},${JSON.stringify(input)},false);process.exit(39)})().catch(e=>{console.error(e);process.exit(1)});`,
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
      expect(
        (await service.dispose(actor, outcomeId, input, false)).replayed,
      ).toBe(true);
      expect(
        (await ledger.summary("r1", workspace))!.budget_committed_usd,
      ).toBe("0.002200000000000000");
    }, 30000);
    it("keeps an unknown retained revision pending instead of refunding a guessed zero", async () => {
      const { attempt, cost } = await seed();
      await ledger.completeAttempt(attempt.attemptId, workspace, cost);
      await ledger.settle(
        "r1",
        workspace,
        "commit",
        "1100",
        cost.report_amount!,
        "legacy_logical",
        { attemptId: attempt.attemptId, cost },
      );
      const snap = await prices.restoreRequest("r1", workspace),
        unknown = {
          ...attempt,
          cost: snap.quote(target, tokens({ output_tokens: 100 })).cost,
        };
      await ledger.archiveRuntimeOutcome(unknown);
      const first = await proposal(unknown);
      const result = await service.dispose(
        actor,
        first.outcomeId,
        first.input,
        false,
      );
      expect(result.changes[0].budget).toMatchObject({
        budget_state: "pending",
        cost_delta: "0.000000000000000000",
      });
      const known = {
        ...attempt,
        cost: snap.quote(
          target,
          tokens({ input_tokens: 2000, output_tokens: 100 }),
        ).cost,
      };
      await ledger.archiveRuntimeOutcome(known);
      const next = await proposal(known, "accept_receipts", "known-next");
      const recovered = await service.dispose(
        actor,
        next.outcomeId,
        next.input,
        false,
      );
      expect(recovered.changes[0].budget.cost_delta).toBe(
        "0.001000000000000000",
      );
    });
    it("rejects a budget-only runtime proposal without using its guessed winning cost", async () => {
      const { attempt } = await seed(),
        outcome: PricingOutcome = {
          type: "settlement",
          workspace,
          reservationId: "r1",
          payload: {
            kind: "commit",
            tokens: "999",
            cost_usd: "99",
            budget_basis: "reserved_estimate",
            receipt: null,
          },
        };
      await ledger.archiveRuntimeOutcome(outcome);
      const review = await proposal(outcome);
      await expect(
        service.dispose(actor, review.outcomeId, review.input, false),
      ).rejects.toMatchObject({ status: 409 });
      const result = await service.dispose(
        actor,
        review.outcomeId,
        { ...review.input, action: "reject_evidence" },
        false,
      );
      expect(result.changes).toEqual([]);
      expect((await ledger.summary("r1", workspace))!.attempts[0].id).toBe(
        attempt.attemptId,
      );
      expect(
        (await ledger.summary("r1", workspace))!.attempts[0].cost,
      ).toBeNull();
    });
    it("rolls back first-receipt adoption if the disposition insert fails after required audit", async () => {
      const { outcomeId, input } = await reviewed("missing"),
        before = await dump(),
        execute = InsertQueryBuilder.prototype.execute;
      jest
        .spyOn(InsertQueryBuilder.prototype, "execute")
        .mockImplementation(function () {
          if (
            this.expressionMap.mainAlias?.tablePath ===
            "pricing_runtime_outcome_dispositions"
          )
            throw new Error("disposition insert failure");
          return execute.call(this);
        });
      await expect(
        service.dispose(actor, outcomeId, input, false),
      ).rejects.toThrow("disposition insert failure");
      expect(await dump()).toEqual(before);
    });
    it("does not reuse an operation id for another retained outcome", async () => {
      const { outcomeId, input, different } = await reviewed();
      await service.dispose(actor, outcomeId, input, false);
      const other = { ...different, errorCode: "late_report" };
      await ledger.archiveRuntimeOutcome(other);
      const second = await proposal(other);
      await expect(
        service.dispose(actor, second.outcomeId, second.input, false),
      ).rejects.toMatchObject({ status: 409 });
      expect(
        await source.query(
          "SELECT * FROM pricing_runtime_outcome_dispositions",
        ),
      ).toHaveLength(1);
    });
    it("validates dispatch attribution instead of accepting a different credential or node", async () => {
      const { different } = await seed();
      different.cost.attribution = {
        node_id: "other-node",
        wire_model: "other",
        credential_id: "other",
        credential_strategy: "single",
        credential_retry_index: 0,
        compatibility_retry_index: 0,
        dispatch_index: 0,
        protocol: "openai",
        dispatched_at: "2026-09-20T00:00:00Z",
        invocation_id: "other",
        requested_model: null,
        route_model: "other",
      };
      await ledger.archiveRuntimeOutcome(different);
      const { outcomeId, input } = await proposal(different);
      await expect(
        service.dispose(actor, outcomeId, input, false),
      ).rejects.toMatchObject({ status: 409 });
    });
    it("returns disposition identity in inventory while retaining the original review row", async () => {
      const { outcomeId, input } = await reviewed();
      await service.dispose(actor, outcomeId, input, false);
      const inventory = await ledger.runtimeOutcomeInventory(
        workspace,
        "review_required",
        20,
      );
      expect(inventory.items.find((r) => r.id === outcomeId)).toMatchObject({
        state: "review_required",
        disposition: {
          id: input.id,
          action: "accept_receipts",
          actor_id: actor.id,
        },
      });
    });
    it("reproduces a retained context-tier change inside the original version", async () => {
      const content = tokenBook();
      content.groups.push({
        id: "context",
        order: 1,
        required: true,
        rules: [
          {
            id: "short",
            priority: 0,
            mode: "whole_request",
            condition: { input_tokens: { min: "0", max: "1500" } },
            rates: [],
          },
          {
            id: "long",
            priority: 0,
            mode: "whole_request",
            condition: { input_tokens: { min: "1500" } },
            rates: [
              {
                operation: "replace",
                component: rate("long-input", "uncached_input_tokens", "9"),
              },
            ],
          },
        ],
      });
      const book = await prices.createBook(actor, {
        name: "Synthetic tiers",
        scope: "workspace",
        content,
      });
      await prices.publishDraft(actor, book.draft.id, {
        draft_revision: 1,
        catalog_revision: 1,
        reason: "Pinned tier fixture",
        confirm: true,
        targets: [{ level: "model", model: target.model }],
      });
      const { outcomeId, input } = await reviewed();
      const result = await service.dispose(actor, outcomeId, input, false);
      expect(result.changes[0].cost.selected_rule_ids).toContain("long");
      expect(result.changes[0].budget.cost_delta).toBe("0.017000000000000000");
    });
    it("retains original FX even after removing today's conversion schedule", async () => {
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
        reason: "Fixture",
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
              denominator: "2",
            },
          },
        ],
      });
      const { outcomeId, input, different } = await reviewed();
      await prices.updateFx(actor, {
        catalog_revision: 3,
        scope: "workspace",
        reason: "Remove current FX",
        confirm: true,
        versions: [],
      });
      const result = await service.dispose(actor, outcomeId, input, false);
      expect(result.changes[0].cost.fx_version_id).toBe(
        different.cost.fx_version_id,
      );
      expect(result.changes[0].budget.cost_delta).toBe("0.000500000000000000");
    });
    it("uses the recorded legacy price and original version rather than the current model catalog", async () => {
      await prices.capture({
        request_id: "legacy",
        workspace_id: workspace,
        report_currency: "USD",
      });
      const content = tokenBook(),
        compiled = compilePriceBook(content, {
          book_id: "legacy-config",
          version_id: "legacy-version-4",
        });
      const usage = tokens({ input_tokens: 1000, output_tokens: 100 }),
        original = calculateCost(usage, compiled.resolve(usage, {})),
        next = tokens({ input_tokens: 2000, output_tokens: 100 }),
        cost = calculateCost(next, compiled.resolve(next, {}));
      const legacyTarget = { node_id: target.node_id, model: "unbound-legacy" };
      await ledger.reserve({
        id: "legacy",
        requestId: "legacy",
        identity,
        target: legacyTarget,
        estimate: original,
        tokens: "1100",
        costUsd: "0.5",
        budgetBasis: "legacy_logical",
        leaseOwner: "owner",
        leaseUntil: new Date(Date.now() - 60000).toISOString(),
      });
      await ledger.beginAttempt({
        id: "legacy-attempt",
        requestId: "legacy",
        workspace,
        reservationId: "legacy",
        target: legacyTarget,
        feeSource: "provider",
        dispatchedAt: "2026-09-20T00:00:00Z",
        priceContext: { context: {}, legacyPrice: content },
      });
      await ledger.settle(
        "legacy",
        workspace,
        "commit",
        "1100",
        original.report_amount!,
        "legacy_logical",
        { attemptId: "legacy-attempt", cost: original },
      );
      const outcome: PricingOutcome = {
        type: "attempt",
        workspace,
        reservationId: "legacy",
        attemptId: "legacy-attempt",
        cost,
        errorCode: null,
      };
      await ledger.archiveRuntimeOutcome(outcome);
      const { outcomeId, input } = await proposal(outcome);
      const result = await service.dispose(actor, outcomeId, input, false);
      expect(result.changes[0].cost.version_id).toBe("legacy-version-4");
      expect(result.changes[0].budget.cost_delta).toBe("0.001000000000000000");
    });
    it("counts only undisposed backlog while missing disposition audits remain fail-closed", async () => {
      const { outcomeId, input } = await reviewed();
      const row = (
        await source.query("SELECT * FROM pricing_runtime_outcomes")
      )[0];
      for (let offset = 0; offset < 999; offset += 100)
        await source
          .createQueryBuilder()
          .insert()
          .into("pricing_runtime_outcomes", Object.keys(row))
          .values(
            Array.from({ length: Math.min(100, 999 - offset) }, (_, i) => ({
              ...row,
              id: `runtime-outcome:${(offset + i + 1).toString(16).padStart(64, "0")}`,
              request_id: row.request_id,
            })),
          )
          .execute();
      await expect(
        ledger.assertRuntimeOutcomeCapacity(workspace),
      ).rejects.toMatchObject({ status: 503 });
      const basis = await ledger.outcomeDispositionBasis(outcomeId, workspace);
      await service.dispose(
        actor,
        outcomeId,
        {
          ...input,
          expected_basis_hash: basis.basis_hash,
          action: "reject_evidence",
        },
        false,
      );
      await expect(
        ledger.assertRuntimeOutcomeCapacity(workspace),
      ).resolves.toBeUndefined();
      const decision = (
        await source.query("SELECT * FROM pricing_runtime_outcome_dispositions")
      )[0];
      await source
        .createQueryBuilder()
        .delete()
        .from("pricing_audit_events")
        .where("id = :id", { id: decision.audit_id })
        .execute();
      await expect(
        ledger.assertRuntimeOutcomeCapacity(workspace),
      ).rejects.toMatchObject({ status: 503 });
    });
    it("upgrades a populated 008 inbox without changing retained bytes or accounting history", async () => {
      await reviewed();
      const before = await dump();
      const runner = source.createQueryRunner();
      try {
        for (const step of PRICING_MIGRATIONS.slice(8).reverse()) {
          for (const index of [...(step.indexes ?? [])].reverse()) await runner.dropIndex(index.table, index.definition.name!);
          for (const definition of [...step.definitions].reverse()) await runner.dropTable(definition.name);
          await runner.manager.createQueryBuilder().delete().from('pricing_schema_versions').where('id = :id', { id: step.version }).execute();
        }
      } finally {
        await runner.release();
      }
      expect((await planPricingSchema(source)).create_tables).toEqual(PRICING_MIGRATIONS.slice(8).flatMap(step => step.definitions.map(table => table.name)));
      await applyPricingSchema(source);
      expect(await dump()).toEqual(before);
    });
    it("allows only one independent competing decision for an outcome", async () => {
      const { outcomeId, input } = await reviewed(),
        other =
          source.options.type === "postgres"
            ? await new DataSource({
                ...source.options,
                synchronize: false,
              } as ConstructorParameters<typeof DataSource>[0]).initialize()
            : source;
      try {
        const second = new PricingOutcomeDispositionService(
          makeLedger(other),
          new PricingRepository(other),
        );
        const results = await Promise.allSettled([
          service.dispose(actor, outcomeId, input, false),
          second.dispose(
            actor,
            outcomeId,
            { ...input, id: "competing-reject", action: "reject_evidence" },
            false,
          ),
        ]);
        expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
        expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
        expect(
          await source.query(
            "SELECT * FROM pricing_runtime_outcome_dispositions",
          ),
        ).toHaveLength(1);
        const rejected = results.find(
          (r) => r.status === "rejected",
        ) as PromiseRejectedResult;
        expect(rejected.reason).toMatchObject({ status: 409 });
      } finally {
        if (other !== source) await other.destroy();
      }
    });
    it("fences a runtime settlement already waiting to write when an operator rejects its body", async () => {
      const { settlement } = await seed(),
        write = ledger.queueSettlement.bind(ledger);
      let release!: () => void, entered!: () => void;
      const gate = new Promise<void>((r) => {
          release = r;
        }),
        ready = new Promise<void>((r) => {
          entered = r;
        });
      jest
        .spyOn(ledger, "queueSettlement")
        .mockImplementationOnce(async (...args) => {
          entered();
          await gate;
          return write(...args);
        });
      const pending = ledger.persistRuntimeOutcome(settlement).then(
        () => ({ ok: true }),
        (error) => ({ ok: false, error }),
      );
      await ready;
      await ledger.archiveRuntimeOutcome(settlement);
      const { outcomeId, input } = await proposal(
        settlement,
        "reject_evidence",
      );
      await service.dispose(actor, outcomeId, input, false);
      release();
      expect(await pending).toMatchObject({
        ok: false,
        error: { status: 409 },
      });
      expect(
        await source.query("SELECT * FROM pricing_settlement_intents"),
      ).toEqual([]);
      expect((await ledger.summary("r1", workspace))!.budget_reserved_usd).toBe(
        "0.500000000000000000",
      );
    });
    it("bounds selected history bytes before fetching or parsing large receipt bodies", async () => {
      const { outcomeId } = await reviewed();
      await source
        .createQueryBuilder()
        .update("pricing_attempts")
        .set({ price_context_json: "x".repeat(8 * 1024 * 1024 + 1) })
        .where("id = :id", { id: "a-r1" })
        .execute();
      await expect(
        ledger.outcomeDispositionBasis(outcomeId, workspace),
      ).rejects.toThrow("8 MiB");
    });
  });
}
contract("SQLite WAL retained outcome disposition", async () => {
  const directory = mkdtempSync(join(tmpdir(), "outcome-dispositions-"));
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
  "PostgreSQL retained outcome disposition",
  async () => {
    const schema = `outcome_dispositions_${process.pid}_${Math.random().toString(16).slice(2)}`,
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

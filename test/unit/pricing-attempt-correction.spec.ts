import { DataSource, InsertQueryBuilder, type ObjectLiteral } from "typeorm";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { BudgetService } from "../../src/budget/budget.service";
import { BudgetRule } from "../../src/database/entities/budget-rule.entity";
import { WorkspaceContextService } from "../../src/workspaces/workspace-context.service";
import { DEFAULT_WORKSPACE_ID } from "../../src/workspaces/workspace.constants";
import { CostLedgerService } from "../../src/pricing/cost-ledger.service";
import { PricingRepository } from "../../src/pricing/pricing-repository";
import { PricingAttemptCorrectionService } from "../../src/pricing/pricing-attempt-correction.service";
import { applyPricingSchema } from "../../src/pricing/pricing-schema";
import { pricingContentHash } from "../../src/pricing/pricing-json";
import type { AttemptCorrectionInput } from "../../src/pricing/attempt-correction.types";
import type { PriceBookContent } from "../../src/pricing/pricing.types";
import { compilePriceBook } from "../../src/pricing/pricing-compiler";
import { calculateCost } from "../../src/pricing/cost-calculator";
import { mockConfigService } from "../helpers";
import { tokenBook, tokens, book, rate } from "./pricing-fixtures";

const workspace = DEFAULT_WORKSPACE_ID;
const actor = {
  id: "synthetic-admin",
  role: "admin" as const,
  workspace_id: workspace,
  global_admin: true,
};
const target = { node_id: "node-a", model: "synthetic-model" };
const identity = {
  workspaceId: workspace,
  apiKeyName: null,
  apiKeyId: null,
  teamId: null,
  namespaceId: null,
};
const quantities = (
  input = "2000",
  output = "100",
): AttemptCorrectionInput["evidence"] => [
  { dimension: "total_input_tokens", value: input },
  { dimension: "uncached_input_tokens", value: input },
  { dimension: "output_tokens", value: output },
  { dimension: "cache_read_tokens", value: "0" },
  { dimension: "cache_write_tokens", value: "0" },
  { dimension: "cache_write_5m_tokens", value: "0" },
  { dimension: "cache_write_1h_tokens", value: "0" },
];
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
      budgets: BudgetService,
      service: PricingAttemptCorrectionService;
    beforeEach(async () => {
      ({ source, cleanup } = await connect());
      await applyPricingSchema(source);
      const rules = source.getRepository(BudgetRule);
      await rules.save(
        rules.create({
          workspace_id: workspace,
          type: "daily_cost",
          limit_value: 1000,
          current_value: 0,
          alert_threshold: 0.8,
          period_start: new Date(),
          is_active: true,
          api_key_name: null,
          api_key_id: null,
          team_id: null,
          namespace_id: null,
        }),
      );
      budgets = new BudgetService(
        mockConfigService(),
        new WorkspaceContextService(),
        rules,
      );
      ledger = new CostLedgerService(source, budgets);
      prices = new PricingRepository(source);
      service = new PricingAttemptCorrectionService(ledger, prices);
      await publish(tokenBook());
    });
    afterEach(async () => {
      jest.restoreAllMocks();
      if (source?.isInitialized) await source.destroy();
      await cleanup?.();
    });
    const publish = async (content: PriceBookContent) => {
      const created = await prices.createBook(actor, {
        name: "Synthetic corrections",
        scope: "workspace",
        content,
      });
      await prices.publishDraft(actor, created.draft.id, {
        draft_revision: 1,
        catalog_revision: (await prices.listBooks(actor)).head.revision,
        reason: "Synthetic fixture",
        confirm: true,
        targets: [{ level: "model", model: target.model }],
      });
    };
    const seed = async (
      state: "commit" | "release" | "reserved" = "commit",
      unknown = false,
    ) => {
      const snapshot = (await prices.capture({
        request_id: "r1",
        workspace_id: workspace,
        report_currency: "USD",
      }))!;
      const original = snapshot.quote(
        target,
        tokens({
          input_tokens: unknown ? undefined : 1000,
          output_tokens: 100,
        }),
      ).cost;
      await ledger.reserve({
        id: "hold",
        requestId: "r1",
        identity,
        target,
        estimate: original,
        tokens: "1100",
        costUsd: "0.5",
        budgetBasis: "legacy_logical",
        leaseOwner: "test-owner",
        leaseUntil: new Date(Date.now() - 60000).toISOString(),
      });
      await ledger.beginAttempt({
        id: "a1",
        requestId: "r1",
        workspace,
        reservationId: "hold",
        target,
        feeSource: "provider",
        dispatchedAt: "2026-09-20T10:00:00.000Z",
        priceContext: { context: {}, legacyPrice: null },
      });
      await ledger.completeAttempt("a1", workspace, original);
      if (state === "commit")
        await ledger.settle(
          "hold",
          workspace,
          "commit",
          "1100",
          original.report_amount ?? "0.5",
          "legacy_logical",
          { attemptId: "a1", cost: original },
        );
      if (state === "release")
        await ledger.settle("hold", workspace, "release");
      if (state === "reserved") await ledger.reconcileDispatched();
      return { original, body: await proposal() };
    };
    const proposal = async (
      id = "correction-1",
    ): Promise<AttemptCorrectionInput> => {
      const basis = await ledger.attemptCorrectionBasis("a1", workspace);
      return {
        id,
        expected_basis_hash: basis.basis_hash,
        expected_cost_hash: basis.effective_cost_hash,
        evidence: quantities(),
        reason: "Synthetic revised usage",
        confirm: true,
      };
    };
    const dump = async () => {
      const rows: Record<string, unknown> = {};
      for (const name of [
        "pricing_attempts",
        "pricing_reservations",
        "pricing_settlement_intents",
        "pricing_cost_adjustments",
        "pricing_adjustment_applications",
        "pricing_budget_balances",
        "budget_rules",
        "pricing_audit_events",
      ])
        rows[name] = await source.query(`SELECT * FROM ${name}`);
      return rows;
    };
    const current = async () => (await budgets.getStatus())[0].currentExact;

    it("previews exact winner budget deltas without writes and applies them exactly once", async () => {
      const { original, body } = await seed(),
        before = await dump();
      const preview = await service.correct(actor, "a1", body, true);
      expect(preview).toMatchObject({
        dry_run: true,
        supplier_confirmed: false,
        original_receipt_modified: false,
        adjustment: null,
        budget: {
          budget_state: "applied",
          cost_delta: "0.001000000000000000",
          tokens_delta: "1000",
          current_period_refund_not_guaranteed: true,
        },
      });
      expect(preview.cost).toMatchObject({
        status: "estimated",
        report_amount: "0.002200000",
        usage: { adapter_id: "administrator-attempt-correction" },
      });
      expect(await dump()).toEqual(before);
      const applied = await service.correct(actor, "a1", body, false);
      expect(applied.budget).toEqual(preview.budget);
      expect(await current()).toBe("0.002200000000000000");
      expect((await ledger.summary("r1", workspace))!.attempts[0].cost).toEqual(
        original,
      );
      expect(
        (await ledger.summary("r1", workspace))!.attempts[0].effective_cost,
      ).toEqual(applied.cost);
      expect((await dump()).pricing_attempts).toEqual(before.pricing_attempts);
      expect((await dump()).pricing_settlement_intents).toEqual(
        before.pricing_settlement_intents,
      );
      const after = await dump();
      expect((await service.correct(actor, "a1", body, false)).replayed).toBe(
        true,
      );
      expect(
        (await ledger.attemptCorrectionStatus(workspace, "a1", body.id)).result!
          .cost_hash,
      ).toBe(applied.cost_hash);
      expect(await dump()).toEqual(after);
    });

    it("uses historical prices despite publication and preserves both original and effective history", async () => {
      const { body } = await seed();
      await publish(
        book([
          rate("input", "uncached_input_tokens", "100"),
          rate("out", "output_tokens", "200"),
        ]),
      );
      const first = await service.correct(actor, "a1", body, false);
      expect(first.cost.report_amount).toBe("0.002200000");
      const secondBody = {
        ...(await proposal("correction-2")),
        evidence: quantities("3000"),
      };
      const second = await service.correct(actor, "a1", secondBody, false);
      expect(second.budget.cost_delta).toBe("0.001000000000000000");
      expect((await service.correct(actor, "a1", body, false)).cost_hash).toBe(
        first.cost_hash,
      );
      const summary = (await ledger.summary("r1", workspace))!;
      expect(summary.amount).toBe("0.003200000000000000");
      expect(summary.attempts[0].adjustments).toHaveLength(2);
    });

    it("keeps the original FX identity after the current FX schedule is removed", async () => {
      const content = tokenBook();
      content.currency = "CNY";
      await publish(content);
      await prices.updateFx(actor, {
        catalog_revision: (await prices.listBooks(actor)).head.revision,
        scope: "workspace",
        reason: "Synthetic original FX",
        confirm: true,
        versions: [
          {
            fx: {
              version_id: "original-fx",
              source: "synthetic",
              effective_at: "2020-01-01T00:00:00.000Z",
              from_currency: "CNY",
              to_currency: "USD",
              numerator: "1",
              denominator: "2",
            },
          },
        ],
      });
      const { body, original } = await seed();
      expect(original.report_amount).toBe("0.000600000");
      await prices.updateFx(actor, {
        catalog_revision: (await prices.listBooks(actor)).head.revision,
        scope: "workspace",
        reason: "Synthetic removal after admission",
        confirm: true,
        versions: [],
      });
      const result = await service.correct(actor, "a1", body, false);
      expect(result.cost).toMatchObject({
        currency: "CNY",
        amount: "0.002200000",
        report_currency: "USD",
        report_amount: "0.001100000",
        fx_version_id: original.fx_version_id,
      });
      expect(result.budget.cost_delta).toBe("0.000500000000000000");
    });

    it("reuses only the stored legacy price and version when correcting an unbound model", async () => {
      const legacy = tokenBook(),
        legacyTarget = { node_id: "node-a", model: "legacy-only" };
      await prices.capture({
        request_id: "r1",
        workspace_id: workspace,
        report_currency: "USD",
      });
      const usage = tokens({ input_tokens: 1000, output_tokens: 100 });
      const original = calculateCost(
        usage,
        compilePriceBook(legacy, {
          book_id: "legacy-config",
          version_id: "frozen-legacy-7",
        }).resolve(usage, {}),
      );
      await ledger.reserve({
        id: "hold",
        requestId: "r1",
        identity,
        target: legacyTarget,
        estimate: original,
        tokens: "1100",
        costUsd: "0.5",
        budgetBasis: "legacy_logical",
        leaseOwner: "test-owner",
        leaseUntil: new Date(Date.now() - 60000).toISOString(),
      });
      await ledger.beginAttempt({
        id: "a1",
        requestId: "r1",
        workspace,
        reservationId: "hold",
        target: legacyTarget,
        feeSource: "provider",
        dispatchedAt: "2026-09-20T10:00:00.000Z",
        priceContext: { context: {}, legacyPrice: legacy },
      });
      await ledger.settle(
        "hold",
        workspace,
        "commit",
        "1100",
        original.report_amount!,
        "legacy_logical",
        { attemptId: "a1", cost: original },
      );
      const result = await service.correct(
        actor,
        "a1",
        await proposal(),
        false,
      );
      expect(result.cost).toMatchObject({
        book_id: "legacy-config",
        version_id: "frozen-legacy-7",
        report_amount: "0.002200000",
      });
      expect(await current()).toBe("0.002200000000000000");
    });

    it("allows known revisions of terminal unknown receipts without treating the old estimate as free", async () => {
      const { body } = await seed("commit", true);
      expect(await current()).toBe("0.500000000000000000");
      const result = await service.correct(actor, "a1", body, false);
      expect(result.budget.cost_delta).toBe("-0.497800000000000000");
      expect(await current()).toBe("0.002200000000000000");
    });

    it("records cost-only revisions of expired unresolved holds and later commits the effective evidence once", async () => {
      const { body } = await seed("reserved", true);
      const result = await service.correct(actor, "a1", body, false);
      expect(result.budget).toMatchObject({
        budget_state: "not_applicable",
        cost_delta: "0.000000000000000000",
      });
      expect(await current()).toBe("0.500000000000000000");
      const basis = await ledger.recoveryBasis("hold", workspace);
      const resolved = await ledger.resolveRecovery("hold", actor, {
        id: "decide-effective",
        expected_basis_hash: basis.basis_hash,
        reason: "Separate internal budget decision",
        confirm: true,
        decisions: [
          { reservation_id: "hold", action: "commit", budget_attempt_id: "a1" },
        ],
      });
      expect(resolved.unknown_attempt_ids).toEqual([]);
      expect(await current()).toBe("0.002200000000000000");
      const next = await service.correct(
        actor,
        "a1",
        { ...(await proposal("second")), evidence: quantities("3000") },
        false,
      );
      expect(next.budget.cost_delta).toBe("0.001000000000000000");
      expect(await current()).toBe("0.003200000000000000");
    });

    it("keeps released holds released when terminal usage is revised", async () => {
      const { body } = await seed("release", true),
        effects = await source.query("SELECT * FROM pricing_budget_effects");
      const result = await service.correct(actor, "a1", body, false);
      expect(result.budget.budget_state).toBe("not_applicable");
      expect(await current()).toBe("0.000000000000000000");
      expect(
        await source.query("SELECT * FROM pricing_budget_effects"),
      ).toEqual(effects);
    });

    it("does not assign a corrected loser fee to the logical winner", async () => {
      const { original } = await seed("reserved");
      await ledger.beginAttempt({
        id: "winner",
        requestId: "r1",
        workspace,
        reservationId: "hold",
        target,
        feeSource: "provider",
        dispatchedAt: "2026-09-20T10:01:00.000Z",
        priceContext: { context: {}, legacyPrice: null },
      });
      await ledger.settle(
        "hold",
        workspace,
        "commit",
        "1100",
        original.report_amount!,
        "legacy_logical",
        { attemptId: "winner", cost: original },
      );
      const corrected = await service.correct(
        actor,
        "a1",
        await proposal(),
        false,
      );
      expect(corrected.budget.budget_state).toBe("not_applicable");
      expect(await current()).toBe("0.001200000000000000");
      expect((await ledger.summary("r1", workspace))!.amount).toBe(
        "0.003400000000000000",
      );
    });

    it("preserves charged budget for unknown revisions then uses the last applied amount on a known revision", async () => {
      const { body } = await seed();
      const unknown = await service.correct(
        actor,
        "a1",
        { ...body, evidence: [{ dimension: "output_tokens", value: null }] },
        false,
      );
      expect(unknown.cost.report_amount).toBeNull();
      expect(unknown.budget.budget_state).toBe("pending");
      expect(await current()).toBe("0.001200000000000000");
      const known = await service.correct(
        actor,
        "a1",
        await proposal("known-again"),
        false,
      );
      expect(known.budget.cost_delta).toBe("0.001000000000000000");
      expect(await current()).toBe("0.002200000000000000");
    });

    it("refunds the original epoch only and previews without changing either epoch", async () => {
      const { body } = await seed(),
        oldEpoch = (await budgets.getStatus())[0].periodStart;
      await source
        .getRepository(BudgetRule)
        .update(
          { workspace_id: workspace },
          { period_start: new Date(Date.now() + 86400000), current_value: 5 },
        );
      const next = { ...body, evidence: quantities("500", "0") },
        before = await dump();
      const preview = await service.correct(actor, "a1", next, true);
      expect(preview.budget.cost_delta).toBe("-0.000700000000000000");
      expect(await dump()).toEqual(before);
      await service.correct(actor, "a1", next, false);
      expect(await current()).toBe("5.000000000000000000");
      const balance = await source.manager
        .createQueryBuilder()
        .select("b.amount_decimal", "amount_decimal")
        .from("pricing_budget_balances", "b")
        .where("b.workspace_id = :workspace AND b.period_start = :period", {
          workspace,
          period: new Date(oldEpoch).toISOString(),
        })
        .getRawOne();
      expect(balance.amount_decimal).toBe("0.000500000000000000");
    });

    it("fails a read-only preview if the budget delta underflows and rolls back an apply failure", async () => {
      const { body } = await seed();
      await source
        .getRepository(BudgetRule)
        .update({ workspace_id: workspace }, { current_value: 0 });
      const before = await dump(),
        reduced = { ...body, evidence: quantities("0", "0") };
      await expect(service.correct(actor, "a1", reduced, true)).rejects.toThrow(
        "underflow",
      );
      expect(await dump()).toEqual(before);
      await expect(
        service.correct(actor, "a1", reduced, false),
      ).rejects.toThrow("underflow");
      expect(await dump()).toEqual(before);
    });

    it("rolls back monetary delta, both revision rows and audit on mandatory audit failure", async () => {
      const { body } = await seed(),
        before = await dump(),
        original = InsertQueryBuilder.prototype.execute;
      const fail = jest
        .spyOn(InsertQueryBuilder.prototype, "execute")
        .mockImplementation(function (this: InsertQueryBuilder<ObjectLiteral>) {
          if (
            this.expressionMap.mainAlias?.tablePath === "pricing_audit_events"
          )
            return Promise.reject(
              new Error("synthetic mandatory audit failed"),
            );
          return original.call(this);
        });
      await expect(service.correct(actor, "a1", body, false)).rejects.toThrow(
        "synthetic mandatory",
      );
      fail.mockRestore();
      expect(await dump()).toEqual(before);
    });

    it("rejects stale cost/basis, active owner, pending intent and body spoofing", async () => {
      const { body } = await seed("reserved");
      for (const bad of [
        { ...body, expected_cost_hash: "f".repeat(64) },
        { ...body, expected_basis_hash: "f".repeat(64) },
      ])
        await expect(
          service.correct(actor, "a1", bad, false),
        ).rejects.toMatchObject({ status: 409 });
      for (const bad of [
        { ...body, cost_usd: "0" },
        { ...body, actor_id: "forged" },
        { ...body, source: "provider_usage" },
        {
          ...body,
          evidence: [{ ...body.evidence[0], source: "provider_usage" }],
        },
        { ...body, confirm: false },
      ])
        await expect(
          service.correct(actor, "a1", bad, false),
        ).rejects.toThrow();
      await ledger.renew(
        "hold",
        workspace,
        "test-owner",
        new Date(Date.now() + 60000).toISOString(),
      );
      await expect(
        service.correct(actor, "a1", await proposal(), false),
      ).rejects.toMatchObject({ status: 409 });
      await source.manager
        .createQueryBuilder()
        .update("pricing_reservations")
        .set({ lease_until: new Date(Date.now() - 60000).toISOString() })
        .where("id = :id", { id: "hold" })
        .execute();
      await ledger.queueSettlement(
        "hold",
        workspace,
        "release",
        "0",
        "0",
        "synthetic",
      );
      await expect(
        service.correct(actor, "a1", await proposal(), false),
      ).rejects.toMatchObject({ status: 409 });
    });

    it("rejects renewed ownership during pricing and cannot overwrite other corrections", async () => {
      const { body } = await seed("reserved"),
        restore = prices.restoreRequest.bind(prices);
      jest
        .spyOn(prices, "restoreRequest")
        .mockImplementationOnce(async (...args) => {
          await ledger.renew(
            "hold",
            workspace,
            "test-owner",
            new Date(Date.now() + 60000).toISOString(),
          );
          return restore(...args);
        });
      await expect(
        service.correct(actor, "a1", body, false),
      ).rejects.toMatchObject({ status: 409 });
      expect(
        await source.query("SELECT * FROM pricing_cost_adjustments"),
      ).toEqual([]);
    });

    it("enforces role, workspace and complete audit identity on reads and retries", async () => {
      const { body } = await seed();
      await expect(
        service.correct({ ...actor, role: "operator" }, "a1", body, false),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        service.correct(
          { ...actor, workspace_id: "foreign" },
          "a1",
          body,
          false,
        ),
      ).rejects.toMatchObject({ status: 404 });
      await service.correct(actor, "a1", body, false);
      await expect(
        service.correct({ ...actor, id: "other-admin" }, "a1", body, false),
      ).rejects.toMatchObject({ status: 409 });
      await expect(
        service.correct(
          actor,
          "a1",
          { ...body, reason: "other reason" },
          false,
        ),
      ).rejects.toMatchObject({ status: 409 });
      await expect(
        ledger.attemptCorrectionStatus("foreign", "a1", body.id),
      ).rejects.toMatchObject({ status: 404 });
    });

    it("serializes identical corrections across independent PostgreSQL connections", async () => {
      const { body } = await seed();
      const other =
        source.options.type === "postgres"
          ? await new DataSource({
              ...source.options,
              synchronize: false,
            }).initialize()
          : source;
      const otherLedger = new CostLedgerService(
        other,
        new BudgetService(
          mockConfigService(),
          new WorkspaceContextService(),
          other.getRepository(BudgetRule),
        ),
      );
      try {
        const otherService = new PricingAttemptCorrectionService(
          otherLedger,
          new PricingRepository(other),
        );
        const results = await Promise.all([
          service.correct(actor, "a1", body, false),
          otherService.correct(actor, "a1", body, false),
        ]);
        expect(results.filter((row) => row.replayed)).toHaveLength(1);
        expect(await current()).toBe("0.002200000000000000");
        expect(
          await source.query("SELECT * FROM pricing_cost_adjustments"),
        ).toHaveLength(1);
      } finally {
        if (other !== source) await other.destroy();
      }
    });

    it("allows only one of two differing proposals at the same predecessor", async () => {
      const { body } = await seed();
      const results = await Promise.allSettled([
        service.correct(actor, "a1", body, false),
        service.correct(
          actor,
          "a1",
          { ...body, id: "different", evidence: quantities("3000") },
          false,
        ),
      ]);
      expect(results.filter((row) => row.status === "fulfilled")).toHaveLength(
        1,
      );
      expect(
        await source.query("SELECT * FROM pricing_cost_adjustments"),
      ).toHaveLength(1);
    });

    it("retains exact big integers and enforces explicit time offsets without guessing prices", async () => {
      const { body } = await seed("release");
      const result = await service.correct(
        actor,
        "a1",
        {
          ...body,
          evidence: quantities("9007199254740993"),
          conditions: {
            provider_accepted_at: "2026-09-20T02:00:01-08:00",
            completed_at: "2026-09-20T18:00:02+08:00",
          },
        },
        true,
      );
      expect(result.cost.report_amount).toBe("9007199254.741193000");
      await expect(
        service.correct(
          actor,
          "a1",
          {
            ...body,
            conditions: { completed_at: "2026-09-20T11:00:00+08:00" },
          },
          true,
        ),
      ).rejects.toMatchObject({ status: 409 });
      await expect(
        service.correct(
          actor,
          "a1",
          { ...body, evidence: [{ dimension: "output_tokens", value: "1.5" }] },
          true,
        ),
      ).rejects.toThrow();
    });

    it("cannot correct local-cache pricing or silently bypass the physical batch correction API", async () => {
      await seed("release");
      await source.manager
        .createQueryBuilder()
        .update("pricing_attempts")
        .set({ fee_source: "local_cache" })
        .where("id = :id", { id: "a1" })
        .execute();
      expect(
        (await ledger.attemptCorrectionBasis("a1", workspace)).blocked_reason,
      ).toBe("not_provider");
      await expect(
        service.correct(actor, "a1", await proposal(), false),
      ).rejects.toMatchObject({ status: 409 });
      await source.manager
        .createQueryBuilder()
        .update("pricing_attempts")
        .set({
          fee_source: "provider",
          price_context_json: JSON.stringify({
            context: {},
            legacyPrice: null,
            batch: {
              batch_id: "b",
              physical_attempt_id: "p",
              member_index: 0,
              request_ids: ["r1"],
            },
          }),
        })
        .where("id = :id", { id: "a1" })
        .execute();
      expect(
        (await ledger.attemptCorrectionBasis("a1", workspace)).blocked_reason,
      ).toBe("batch_group_required");
      await expect(
        service.correct(actor, "a1", await proposal(), false),
      ).rejects.toMatchObject({ status: 409 });
    });

    it("detects tampered revision/audit hashes before reporting an acknowledgement", async () => {
      const { body } = await seed();
      await service.correct(actor, "a1", body, false);
      await source.manager
        .createQueryBuilder()
        .update("pricing_adjustment_applications")
        .set({ cost_delta: "9" })
        .where("attempt_id = :id", { id: "a1" })
        .execute();
      await expect(
        ledger.attemptCorrectionStatus(workspace, "a1", body.id),
      ).rejects.toMatchObject({ status: 409 });
    });

    it("does not overwrite an asynchronously owned media receipt", async () => {
      await seed("reserved");
      const at = new Date().toISOString();
      await source.manager
        .createQueryBuilder()
        .insert()
        .into("pricing_media_tasks")
        .values({
          id: "a1",
          client_key_hash: null,
          request_id: "r1",
          reservation_id: "hold",
          workspace_id: workspace,
          node_id: target.node_id,
          model: target.model,
          operation: "video_generation",
          api_key_id: null,
          api_key_name: null,
          namespace_id: null,
          provider_job_id: "synthetic-job",
          credential_id: null,
          connection_hash: "synthetic",
          state: "uncertain",
          provider_status: null,
          context_json: "{}",
          context_hash: pricingContentHash({}),
          revision: 0,
          accepted_at: null,
          terminal_at: null,
          last_error: null,
          poll_owner: null,
          poll_until: null,
          next_poll_at: at,
          created_at: at,
          updated_at: at,
        })
        .execute();
      expect(
        (await ledger.attemptCorrectionBasis("a1", workspace)).blocked_reason,
      ).toBe("async_owned");
      await expect(
        service.correct(actor, "a1", await proposal(), false),
      ).rejects.toMatchObject({ status: 409 });
    });

    it("detects a corrupted original snapshot and original cost before taking correction authority", async () => {
      const { body } = await seed();
      await source.manager
        .createQueryBuilder()
        .update("pricing_attempts")
        .set({ cost_hash: "invalid" })
        .where("id = :id", { id: "a1" })
        .execute();
      await expect(
        service.correct(actor, "a1", body, false),
      ).rejects.toMatchObject({ status: 409 });
      await source.manager
        .createQueryBuilder()
        .update("pricing_request_snapshots")
        .set({ snapshot_hash: "invalid" })
        .where("request_id = :id", { id: "r1" })
        .execute();
      await expect(
        ledger.attemptCorrectionBasis("a1", workspace),
      ).rejects.toMatchObject({ status: 409 });
    });

    it("does not persist raw secrets in correction reasons or accept arbitrary evidence payloads", async () => {
      const { body } = await seed();
      await expect(
        service.correct(
          actor,
          "a1",
          { ...body, evidence_document: "untrusted raw document" },
          false,
        ),
      ).rejects.toThrow();
      const result = await service.correct(
        actor,
        "a1",
        {
          ...body,
          reason: "Synthetic Authorization: Bearer example-secret-token",
          evidence_digest: "b".repeat(64),
        },
        false,
      );
      expect(result.adjustment?.reason).not.toContain("example-secret-token");
      expect(
        JSON.stringify(
          await source.query("SELECT * FROM pricing_audit_events"),
        ),
      ).not.toContain("example-secret-token");
      expect(
        JSON.stringify(
          await source.query("SELECT * FROM pricing_cost_adjustments"),
        ),
      ).not.toContain("example-secret-token");
    });

    it("survives child exit after the full correction transaction and never doubles the debit", async () => {
      const { body } = await seed(),
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
          `
        require('reflect-metadata');const {DataSource}=require('typeorm');const {BudgetRule}=require('./src/database/entities/budget-rule.entity');const {BudgetService}=require('./src/budget/budget.service');const {WorkspaceContextService}=require('./src/workspaces/workspace-context.service');const {CostLedgerService}=require('./src/pricing/cost-ledger.service');const {PricingRepository}=require('./src/pricing/pricing-repository');const {PricingAttemptCorrectionService}=require('./src/pricing/pricing-attempt-correction.service');
        (async()=>{const ds=await new DataSource({...${JSON.stringify(options)},entities:[BudgetRule]}).initialize();const ledger=new CostLedgerService(ds,new BudgetService({},new WorkspaceContextService(),ds.getRepository(BudgetRule)));await new PricingAttemptCorrectionService(ledger,new PricingRepository(ds)).correct(${JSON.stringify(actor)},'a1',${JSON.stringify(body)},false);process.exit(37);})().catch(e=>{console.error(e);process.exit(1)});
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
        status: 37,
        stderr: "",
      });
      expect((await service.correct(actor, "a1", body, false)).replayed).toBe(
        true,
      );
      expect(await current()).toBe("0.002200000000000000");
    }, 30000);
  });
}
contract("SQLite WAL administrator attempt corrections", async () => {
  const directory = mkdtempSync(join(tmpdir(), "attempt-correction-"));
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
  throw new Error("Use only an explicit isolated PostgreSQL test database");
contract(
  "PostgreSQL administrator attempt corrections",
  async () => {
    const schema = `attempt_correction_${process.pid}_${Math.random().toString(16).slice(2)}`,
      admin = await new DataSource({
        type: "postgres",
        url: pgUrl,
        synchronize: false,
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

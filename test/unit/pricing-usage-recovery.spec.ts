import {
  DataSource,
  InsertQueryBuilder,
  UpdateQueryBuilder,
  type ObjectLiteral,
} from "typeorm";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { BudgetRule } from "../../src/database/entities/budget-rule.entity";
import { BudgetService } from "../../src/budget/budget.service";
import { WorkspaceContextService } from "../../src/workspaces/workspace-context.service";
import { DEFAULT_WORKSPACE_ID } from "../../src/workspaces/workspace.constants";
import { CostLedgerService } from "../../src/pricing/cost-ledger.service";
import { PricingRepository } from "../../src/pricing/pricing-repository";
import { PricingUsageRecoveryService } from "../../src/pricing/pricing-usage-recovery.service";
import { applyPricingSchema } from "../../src/pricing/pricing-schema";
import { pricingContentHash } from "../../src/pricing/pricing-json";
import { compilePriceBook } from "../../src/pricing/pricing-compiler";
import { calculateCost } from "../../src/pricing/cost-calculator";
import type { UsageRecoveryInput } from "../../src/pricing/pricing-usage-recovery.types";
import type { EmbeddingBatchMember } from "../../src/pricing/pricing-batch.types";
import type { PriceBookContent } from "../../src/pricing/pricing.types";
import { mockConfigService } from "../helpers";
import { tokenBook, tokens, book, rate } from "./pricing-fixtures";

const workspace = DEFAULT_WORKSPACE_ID;
const actor = {
  id: "synthetic-admin",
  workspace_id: workspace,
  role: "admin" as const,
  global_admin: true,
};
const target = { node_id: "node-a", model: "synthetic-model" };
const identity = {
  workspaceId: workspace,
  apiKeyName: null,
  apiKeyId: null,
  namespaceId: null,
  teamId: null,
};
const quantities: UsageRecoveryInput["evidence"] = [
  { dimension: "total_input_tokens", value: "1000" },
  { dimension: "output_tokens", value: "100" },
  { dimension: "uncached_input_tokens", value: "1000" },
  { dimension: "cache_read_tokens", value: "0" },
  { dimension: "cache_write_tokens", value: "0" },
  { dimension: "cache_write_5m_tokens", value: "0" },
  { dimension: "cache_write_1h_tokens", value: "0" },
];

function contracts(
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
      recovery: PricingUsageRecoveryService;
    beforeEach(async () => {
      ({ source, cleanup } = await connect());
      await applyPricingSchema(source);
      const rules = source.getRepository(BudgetRule);
      await rules.save(
        rules.create({
          workspace_id: workspace,
          type: "daily_cost",
          limit_value: 100,
          current_value: 0,
          alert_threshold: 0.8,
          period_start: new Date(),
          is_active: true,
          api_key_name: null,
          api_key_id: null,
          namespace_id: null,
          team_id: null,
        }),
      );
      budgets = new BudgetService(
        mockConfigService(),
        new WorkspaceContextService(),
        rules,
      );
      ledger = new CostLedgerService(source, budgets);
      prices = new PricingRepository(source);
      recovery = new PricingUsageRecoveryService(ledger, prices);
      await publish(tokenBook());
    });
    afterEach(async () => {
      jest.restoreAllMocks();
      if (source?.isInitialized) await source.destroy();
      await cleanup?.();
    });
    const publish = async (content: PriceBookContent) => {
      const created = await prices.createBook(actor, {
        name: "Synthetic recovered usage",
        content,
        scope: "workspace",
      });
      const head = (await prices.listBooks(actor)).head;
      return prices.publishDraft(actor, created.draft.id, {
        draft_revision: 1,
        catalog_revision: head.revision,
        reason: "Synthetic rates only",
        confirm: true,
        targets: [{ level: "model", model: target.model }],
      });
    };
    const hold = async (id = "r1") => {
      const snapshot = await prices.capture({
        request_id: id,
        workspace_id: workspace,
        report_currency: "USD",
      });
      const estimate = snapshot!.quote(
        target,
        tokens({ input_tokens: 1000, output_tokens: 100 }),
      ).cost;
      await ledger.reserve({
        id,
        requestId: id,
        identity,
        target,
        estimate,
        tokens: "1100",
        costUsd: "0.5",
        budgetBasis: "legacy_logical",
        leaseOwner: "synthetic-dead-owner",
        leaseUntil: new Date(Date.now() - 60000).toISOString(),
      });
    };
    const seed = async () => {
      await hold();
      await ledger.beginAttempt({
        id: "a1",
        requestId: "r1",
        workspace,
        reservationId: "r1",
        target,
        feeSource: "provider",
        dispatchedAt: "2026-09-20T10:00:00.000Z",
        priceContext: { context: {}, legacyPrice: null },
      });
      await ledger.reconcileDispatched();
      return proposal();
    };
    const proposal = async (
      attempt = "a1",
      anchor = "r1",
    ): Promise<UsageRecoveryInput> => ({
      id: "recover-1",
      attempt_id: attempt,
      expected_basis_hash: (await ledger.recoveryBasis(anchor, workspace))
        .basis_hash,
      reason: "Synthetic usage attestation",
      confirm: true,
      evidence: quantities,
    });
    const dump = async () => {
      const result: Record<string, unknown> = {};
      for (const table of [
        "pricing_attempts",
        "pricing_reservations",
        "pricing_budget_effects",
        "pricing_settlement_intents",
        "pricing_recovery_cases",
        "pricing_audit_events",
      ])
        result[table] = await source.query(`SELECT * FROM ${table}`);
      return result;
    };
    const shared = async (manifest = true) => {
      const members: EmbeddingBatchMember[] = [1, 2].map((index) => ({
        request_id: `r${index}`,
        reservation_id: `r${index}`,
        input_start: index - 1,
        input_count: 1,
        weight: index === 1 ? "1" : "3",
        weight_basis: "text_token_estimate",
      }));
      for (const member of members) await hold(member.request_id);
      await ledger.beginAttemptGroup(
        members.map((member, index) => ({
          id: `a${index + 1}`,
          requestId: member.request_id,
          workspace,
          reservationId: member.reservation_id,
          target,
          feeSource: "provider",
          dispatchedAt: "2026-09-20T10:00:00.000Z",
          priceContext: {
            context: {},
            legacyPrice: null,
            batch: {
              batch_id: "b1",
              physical_attempt_id: "p1",
              member_index: index,
              request_ids: ["r1", "r2"],
            },
          },
        })),
        manifest ? members : undefined,
      );
      await ledger.reconcileDispatched();
      return proposal("a2");
    };

    it("previews without writes, recovers only attested supplier cost, and leaves budget choice pending", async () => {
      const body = await seed(),
        before = await dump();
      const preview = await recovery.recover(actor, "r1", body, true);
      expect(await dump()).toEqual(before);
      expect(preview).toMatchObject({
        budget_changed: false,
        supplier_confirmed: false,
        source: "administrator_attestation",
        dry_run: true,
      });
      expect(preview.changes[0].cost).toMatchObject({
        status: "estimated",
        report_amount: "0.001200000",
        usage: { adapter_id: "administrator-usage-recovery" },
      });
      const applied = await recovery.recover(actor, "r1", body, false);
      expect(applied.changes).toEqual(preview.changes);
      expect((await budgets.getStatus())[0].currentExact).toBe(
        "0.500000000000000000",
      );
      expect(
        await source.query("SELECT * FROM pricing_settlement_intents"),
      ).toEqual([]);
      expect((await ledger.summary("r1", workspace))?.amount).toBe(
        "0.001200000000000000",
      );
      const after = await dump();
      expect((await recovery.recover(actor, "r1", body, false)).replayed).toBe(
        true,
      );
      expect(
        (await ledger.usageRecoveryStatus("r1", workspace, body.id)).result!
          .replayed,
      ).toBe(true);
      expect(await dump()).toEqual(after);
      await ledger.reconcileDispatched();
      expect((await ledger.recoveryCases(workspace))[0].reason).toBe(
        "settlement_decision_missing",
      );
    });

    it("retains the original price snapshot after publication and permits a separate explicit budget decision", async () => {
      const body = await seed();
      await publish(
        book([
          rate("input", "uncached_input_tokens", "100"),
          rate("output", "output_tokens", "200"),
        ]),
      );
      const result = await recovery.recover(actor, "r1", body, false);
      expect(result.changes[0].cost.report_amount).toBe("0.001200000");
      const basis = await ledger.recoveryBasis("r1", workspace);
      await ledger.resolveRecovery("r1", actor, {
        id: "budget-after-evidence",
        expected_basis_hash: basis.basis_hash,
        reason: "Separate synthetic internal allocation",
        confirm: true,
        decisions: [
          { reservation_id: "r1", action: "commit", budget_attempt_id: "a1" },
        ],
      });
      expect((await budgets.getStatus())[0].currentExact).toBe(
        "0.001200000000000000",
      );
      expect((await recovery.recover(actor, "r1", body, false)).replayed).toBe(
        true,
      );
    });

    it("recovers unknown supplier cost after an internal release without refunding or charging that budget again", async () => {
      const body = await seed();
      await ledger.resolveRecovery("r1", actor, {
        id: "release",
        expected_basis_hash: body.expected_basis_hash,
        reason: "Synthetic internal release",
        confirm: true,
        decisions: [{ reservation_id: "r1", action: "release" }],
      });
      const effects = await source.query(
        "SELECT * FROM pricing_budget_effects",
      );
      await recovery.recover(actor, "r1", await proposal(), false);
      expect((await ledger.summary("r1", workspace))?.amount).toBe(
        "0.001200000000000000",
      );
      expect(
        await source.query("SELECT * FROM pricing_budget_effects"),
      ).toEqual(effects);
      expect((await budgets.getStatus())[0].currentExact).toBe(
        "0.000000000000000000",
      );
    });

    it("prices one physical invocation and conserves all shares even when entered from its second member", async () => {
      const body = await shared(),
        before = await dump();
      const preview = await recovery.recover(actor, "r1", body, true);
      expect(await dump()).toEqual(before);
      expect(preview.changes.map((row) => row.cost.report_amount)).toEqual([
        "0.000300000000000000",
        "0.000900000000000000",
      ]);
      const result = await recovery.recover(actor, "r1", body, false);
      expect(result.changes).toHaveLength(2);
      expect(
        result.changes.map((row) => row.cost.batch?.physical_cost_hash),
      ).toEqual([
        result.changes[0].cost.batch!.physical_cost_hash,
        result.changes[0].cost.batch!.physical_cost_hash,
      ]);
      expect((await budgets.getStatus())[0].currentExact).toBe(
        "1.000000000000000000",
      );
      expect(
        await source.query(
          "SELECT * FROM pricing_audit_events WHERE action = 'cost.usage_recovered'",
        ),
      ).toHaveLength(1);
    });

    it("refuses legacy unknown batch allocations without inventing weights", async () => {
      const body = await shared(false),
        before = await dump();
      await expect(
        recovery.recover(actor, "r1", body, false),
      ).rejects.toMatchObject({ status: 409 });
      expect(await dump()).toEqual(before);
    });

    it("rejects corrupted batch manifests instead of guessing allocation weights", async () => {
      const body = await shared(),
        before = await dump();
      await source.manager
        .createQueryBuilder()
        .update("pricing_batch_manifests")
        .set({ manifest_hash: "invalid" })
        .execute();
      await expect(
        recovery.recover(actor, "r1", body, false),
      ).rejects.toMatchObject({ status: 409 });
      expect(await dump()).toEqual(before);
    });

    it("does not fill a partially completed physical group using independently guessed remaining shares", async () => {
      const body = await shared(),
        preview = await recovery.recover(actor, "r1", body, true);
      await ledger.completeAttempt("a1", workspace, preview.changes[0].cost);
      const current = await proposal("a2"),
        before = await dump();
      await expect(
        recovery.recover(actor, "r1", current, false),
      ).rejects.toMatchObject({ status: 409 });
      expect(await dump()).toEqual(before);
    });

    it("never treats local-cache or asynchronously owned media work as a missing provider receipt", async () => {
      const body = await seed();
      await source.manager
        .createQueryBuilder()
        .update("pricing_attempts")
        .set({ fee_source: "local_cache" })
        .where("id = :id", { id: "a1" })
        .execute();
      await expect(
        recovery.recover(actor, "r1", await proposal(), false),
      ).rejects.toMatchObject({ status: 409 });
      await source.manager
        .createQueryBuilder()
        .update("pricing_attempts")
        .set({ fee_source: "provider" })
        .where("id = :id", { id: "a1" })
        .execute();
      const at = new Date().toISOString();
      await source.manager
        .createQueryBuilder()
        .insert()
        .into("pricing_media_tasks")
        .values({
          id: "a1",
          client_key_hash: null,
          request_id: "r1",
          reservation_id: "r1",
          workspace_id: workspace,
          node_id: target.node_id,
          model: target.model,
          operation: "video_generation",
          api_key_id: null,
          api_key_name: null,
          namespace_id: null,
          provider_job_id: null,
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
      await expect(
        recovery.recover(actor, "r1", await proposal(), false),
      ).rejects.toMatchObject({ status: 409 });
      expect((await ledger.summary("r1", workspace))?.attempts[0].state).toBe(
        "dispatched",
      );
      expect(body.attempt_id).toBe("a1");
    });

    it("conserves exact quantities beyond Number precision and retains missing partitions instead of making them zero", async () => {
      const body = await seed();
      const large = "9007199254740993";
      const result = await recovery.recover(
        actor,
        "r1",
        {
          ...body,
          evidence: quantities.map((row) =>
            ["total_input_tokens", "uncached_input_tokens"].includes(
              row.dimension,
            )
              ? { ...row, value: large }
              : row,
          ),
        },
        true,
      );
      expect(
        result.changes[0].cost.usage.quantities.total_input_tokens?.value,
      ).toBe(large);
      expect(result.changes[0].cost.report_amount).toBe("9007199254.741193000");
      const incomplete = await recovery.recover(
        actor,
        "r1",
        {
          ...body,
          evidence: quantities.filter(
            (row) => row.dimension !== "cache_write_1h_tokens",
          ),
        },
        true,
      );
      expect(incomplete.changes[0].cost.report_amount).toBeNull();
    });

    it("uses the original legacy snapshot when no published binding existed, never current legacy configuration", async () => {
      const legacy = tokenBook();
      await prices.capture({
        request_id: "r1",
        workspace_id: workspace,
        report_currency: "USD",
      });
      const usage = tokens({ input_tokens: 1000, output_tokens: 100 });
      const estimate = calculateCost(
        usage,
        compilePriceBook(legacy, {
          book_id: "legacy-config",
          version_id: "legacy-snapshot-7",
        }).resolve(usage, {}),
      );
      const legacyTarget = { node_id: "node-a", model: "legacy-only" };
      await ledger.reserve({
        id: "r1",
        requestId: "r1",
        identity,
        target: legacyTarget,
        estimate,
        tokens: "1100",
        costUsd: "0.5",
        budgetBasis: "legacy_logical",
        leaseOwner: "synthetic-dead-owner",
        leaseUntil: new Date(Date.now() - 60000).toISOString(),
      });
      await ledger.beginAttempt({
        id: "a1",
        requestId: "r1",
        workspace,
        reservationId: "r1",
        target: legacyTarget,
        feeSource: "provider",
        dispatchedAt: "2026-09-20T10:00:00.000Z",
        priceContext: { context: {}, legacyPrice: legacy },
      });
      await ledger.reconcileDispatched();
      const result = await recovery.recover(
        actor,
        "r1",
        await proposal(),
        true,
      );
      expect(result.changes[0].cost).toMatchObject({
        book_id: "legacy-config",
        version_id: "legacy-snapshot-7",
        report_amount: "0.001200000",
      });
    });

    it("redacts the audit reason, stores only an evidence digest and rejects raw evidence documents", async () => {
      const body = await seed();
      await expect(
        recovery.recover(
          actor,
          "r1",
          { ...body, evidence_document: "not a metering field" },
          false,
        ),
      ).rejects.toThrow();
      await recovery.recover(
        actor,
        "r1",
        {
          ...body,
          reason: "Synthetic Authorization: Bearer example-secret-token",
          evidence_digest: "a".repeat(64),
        },
        false,
      );
      const rows = await source.query(
        "SELECT * FROM pricing_audit_events WHERE action = 'cost.usage_recovered'",
      );
      expect(JSON.stringify(rows)).not.toContain("example-secret-token");
      expect(JSON.parse(rows[0].metadata_json).evidence_digest).toBe(
        "a".repeat(64),
      );
    });

    it("rolls back every member if a later shared receipt write fails", async () => {
      const body = await shared(),
        before = await dump(),
        execute = UpdateQueryBuilder.prototype.execute;
      const fail = jest
        .spyOn(UpdateQueryBuilder.prototype, "execute")
        .mockImplementation(function (this: UpdateQueryBuilder<ObjectLiteral>) {
          if (
            this.expressionMap.mainAlias?.tablePath === "pricing_attempts" &&
            this.getParameters().id === "a2"
          )
            return Promise.reject(new Error("synthetic second receipt failed"));
          return execute.call(this);
        });
      await expect(recovery.recover(actor, "r1", body, false)).rejects.toThrow(
        "synthetic second receipt",
      );
      fail.mockRestore();
      expect(await dump()).toEqual(before);
    });

    it("rolls back recovered cost when mandatory audit fails", async () => {
      const body = await seed(),
        before = await dump(),
        execute = InsertQueryBuilder.prototype.execute;
      const fail = jest
        .spyOn(InsertQueryBuilder.prototype, "execute")
        .mockImplementation(function (this: InsertQueryBuilder<ObjectLiteral>) {
          if (
            this.expressionMap.mainAlias?.tablePath === "pricing_audit_events"
          )
            return Promise.reject(new Error("synthetic audit failed"));
          return execute.call(this);
        });
      await expect(recovery.recover(actor, "r1", body, false)).rejects.toThrow(
        "synthetic audit",
      );
      fail.mockRestore();
      expect(await dump()).toEqual(before);
    });

    it("competing proposals cannot overwrite each other or create duplicate receipts", async () => {
      const body = await seed();
      const results = await Promise.allSettled([
        recovery.recover(actor, "r1", body, false),
        recovery.recover(actor, "r1", { ...body, id: "different-id" }, false),
      ]);
      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        await source.query(
          "SELECT * FROM pricing_audit_events WHERE action = 'cost.usage_recovered'",
        ),
      ).toHaveLength(1);
    });

    it("serializes exact retries across independent PostgreSQL connections", async () => {
      const body = await seed();
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
        const second = new PricingUsageRecoveryService(
          otherLedger,
          new PricingRepository(other),
        );
        const results = await Promise.all([
          recovery.recover(actor, "r1", body, false),
          second.recover(actor, "r1", body, false),
        ]);
        expect(results.filter((result) => result.replayed)).toHaveLength(1);
        expect(results[0].changes).toEqual(results[1].changes);
        expect(
          await source.query(
            "SELECT * FROM pricing_audit_events WHERE action = 'cost.usage_recovered'",
          ),
        ).toHaveLength(1);
      } finally {
        if (other !== source) await other.destroy();
      }
    });

    it("rejects changed idempotency bodies, actors, foreign scope and forged source/money fields", async () => {
      const body = await seed();
      await recovery.recover(actor, "r1", body, false);
      await expect(
        recovery.recover(actor, "r1", { ...body, reason: "different" }, false),
      ).rejects.toMatchObject({ status: 409 });
      await expect(
        recovery.recover({ ...actor, id: "other-admin" }, "r1", body, false),
      ).rejects.toMatchObject({ status: 409 });
      await expect(
        recovery.recover({ ...actor, role: "operator" }, "r1", body, false),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        recovery.recover(
          { ...actor, workspace_id: "other" },
          "r1",
          body,
          false,
        ),
      ).rejects.toMatchObject({ status: 404 });
      for (const forged of [
        { ...body, cost_usd: "0" },
        { ...body, source: "provider_usage" },
        { ...body, evidence: [{ ...quantities[0], source: "provider_usage" }] },
        {
          ...body,
          conditions: { attempt_dispatched_at: "2000-01-01T00:00:00Z" },
        },
      ])
        await expect(
          recovery.recover(actor, "r1", forged, false),
        ).rejects.toThrow();
    });

    it("detects lease renewal between calculation and the atomic write", async () => {
      const body = await seed(),
        restore = prices.restoreRequest.bind(prices);
      jest
        .spyOn(prices, "restoreRequest")
        .mockImplementationOnce(async (...args) => {
          await ledger.renew(
            "r1",
            workspace,
            "synthetic-dead-owner",
            new Date(Date.now() + 60000).toISOString(),
          );
          return restore(...args);
        });
      await expect(
        recovery.recover(actor, "r1", body, false),
      ).rejects.toMatchObject({ status: 409 });
      expect((await ledger.summary("r1", workspace))?.attempts[0].state).toBe(
        "dispatched",
      );
    });

    it("does not override a pending immutable intent or an existing receipt", async () => {
      const body = await seed();
      await ledger.queueSettlement(
        "r1",
        workspace,
        "release",
        "0",
        "0",
        "synthetic",
      );
      await expect(
        recovery.recover(actor, "r1", await proposal(), false),
      ).rejects.toMatchObject({ status: 409 });
      await ledger.applySettlement("r1", workspace);
      await recovery.recover(actor, "r1", await proposal(), false);
      await expect(
        recovery.recover(
          actor,
          "r1",
          {
            ...body,
            id: "overwrite",
            expected_basis_hash: (await ledger.recoveryBasis("r1", workspace))
              .basis_hash,
          },
          false,
        ),
      ).rejects.toMatchObject({ status: 409 });
    });

    it("preserves missing vs zero and never labels manual numbers as provider-observed", async () => {
      const body = await seed();
      const missing = await recovery.recover(
        actor,
        "r1",
        { ...body, evidence: [{ dimension: "output_tokens", value: null }] },
        true,
      );
      expect(missing.changes[0].cost.report_amount).toBeNull();
      const zero = await recovery.recover(
        actor,
        "r1",
        {
          ...body,
          evidence: quantities.map((entry) => ({ ...entry, value: "0" })),
        },
        true,
      );
      expect(zero.changes[0].cost.report_amount).toBe("0.000000000");
      expect(
        Object.values(zero.changes[0].cost.usage.quantities).every(
          (row) =>
            row!.source === "request_metadata" && row!.quality !== "observed",
        ),
      ).toBe(true);
      expect(zero.supplier_confirmed).toBe(false);
    });

    it('compares attested times as absolute instants rather than lexicographic offset strings', async () => {
      const body = await seed();
      const preview = await recovery.recover(actor, 'r1', { ...body, conditions: { provider_accepted_at: '2026-09-20T02:00:01-08:00', completed_at: '2026-09-20T18:00:02+08:00' } }, true);
      expect(preview.dry_run).toBe(true);
      await expect(recovery.recover(actor, 'r1', { ...body, conditions: { provider_accepted_at: '2026-09-20T12:00:01+08:00' } }, true)).rejects.toMatchObject({ status: 409 });
      await expect(recovery.recover(actor, 'r1', { ...body, conditions: { provider_accepted_at: '2026-09-20T18:00:02+08:00', completed_at: '2026-09-20T02:00:01-08:00' } }, true)).rejects.toMatchObject({ status: 409 });
    });

    it("rejects negative/fractional tokens, overlapping partitions and invalid times without writes", async () => {
      const body = await seed(),
        before = await dump();
      for (const evidence of [
        [{ dimension: "output_tokens", value: "-1" }],
        [{ dimension: "output_tokens", value: "1.5" }],
        [...quantities, quantities[0]],
        quantities.map((row) =>
          row.dimension === "cache_read_tokens"
            ? { ...row, value: "2000" }
            : row,
        ),
      ])
        await expect(
          recovery.recover(actor, "r1", { ...body, evidence }, false),
        ).rejects.toThrow();
      await expect(
        recovery.recover(
          actor,
          "r1",
          { ...body, conditions: { completed_at: "2000-01-01T00:00:00Z" } },
          false,
        ),
      ).rejects.toMatchObject({ status: 409 });
      expect(await dump()).toEqual(before);
    });

    it("verifies audit and original receipt hashes before acknowledging a previous write", async () => {
      const body = await seed();
      await recovery.recover(actor, "r1", body, false);
      await source.manager
        .createQueryBuilder()
        .update("pricing_attempts")
        .set({ cost_hash: "altered" })
        .where("id = :id", { id: "a1" })
        .execute();
      await expect(
        ledger.usageRecoveryStatus("r1", workspace, body.id),
      ).rejects.toMatchObject({ status: 409 });
      await expect(
        recovery.recover(actor, "r1", body, false),
      ).rejects.toMatchObject({ status: 409 });
    });

    it("survives child exit after committed evidence without applying the budget or duplicating the audit", async () => {
      const body = await seed();
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
        require('reflect-metadata'); const {DataSource}=require('typeorm');
        const {BudgetService}=require('./src/budget/budget.service'); const {BudgetRule}=require('./src/database/entities/budget-rule.entity');
        const {WorkspaceContextService}=require('./src/workspaces/workspace-context.service');
        const {CostLedgerService}=require('./src/pricing/cost-ledger.service'); const {PricingRepository}=require('./src/pricing/pricing-repository'); const {PricingUsageRecoveryService}=require('./src/pricing/pricing-usage-recovery.service');
        (async()=>{ const ds=await new DataSource({...${JSON.stringify(options)},entities:[BudgetRule]}).initialize(); const b=new BudgetService({},new WorkspaceContextService(),ds.getRepository(BudgetRule)); const l=new CostLedgerService(ds,b); await new PricingUsageRecoveryService(l,new PricingRepository(ds)).recover(${JSON.stringify(actor)},'r1',${JSON.stringify(body)},false); process.exit(37); })().catch(e=>{console.error(e);process.exit(1)});
      `,
        ],
        {
          cwd: process.cwd(),
          env: { ...process.env, TS_NODE_TRANSPILE_ONLY: "true" },
          timeout: 20000,
          encoding: "utf8",
        },
      );
      expect({ status: child.status, stderr: child.stderr }).toEqual({
        status: 37,
        stderr: "",
      });
      expect((await recovery.recover(actor, "r1", body, false)).replayed).toBe(
        true,
      );
      expect(
        await source.query(
          "SELECT * FROM pricing_audit_events WHERE action = 'cost.usage_recovered'",
        ),
      ).toHaveLength(1);
      expect((await budgets.getStatus())[0].currentExact).toBe(
        "0.500000000000000000",
      );
    }, 30000);
  });
}

contracts("SQLite WAL missing-usage recovery", async () => {
  const directory = mkdtempSync(join(tmpdir(), "usage-recovery-"));
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
  throw new Error(
    "Only an explicitly isolated PostgreSQL database is permitted",
  );
contracts(
  "PostgreSQL missing-usage recovery",
  async () => {
    const schema = `usage_recovery_${process.pid}_${Math.random().toString(16).slice(2)}`;
    const admin = await new DataSource({
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

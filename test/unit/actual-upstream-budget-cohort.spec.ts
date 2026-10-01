import { DataSource } from "typeorm";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BudgetService } from "../../src/budget/budget.service";
import { BudgetRule } from "../../src/database/entities/budget-rule.entity";
import { WorkspaceContextService } from "../../src/workspaces/workspace-context.service";
import { CostLedgerService } from "../../src/pricing/cost-ledger.service";
import { PricingRepository } from "../../src/pricing/pricing-repository";
import { applyPricingSchema } from "../../src/pricing/pricing-schema";
import { pricingContentHash } from "../../src/pricing/pricing-json";
import { actualBudgetAdjustmentBasis } from "../../src/pricing/actual-upstream-budget-adjustments";
import * as actualEvidence from "../../src/pricing/actual-upstream-budget-evidence";
import * as inbox from "../../src/pricing/pricing-outcome-inbox";
import * as groupInbox from "../../src/pricing/pricing-group-outcome-inbox";
import { runtimeGroupOutcomeDocument, readRuntimeGroupDocument } from "../../src/pricing/pricing-group-outcome-document";
import { allocateBatchCost, batchShareCost } from "../../src/pricing/cost-allocation";
import type { PricingGroupOutcome } from "../../src/pricing/pricing-group-outcome.types";
import type { PricingOutcome } from "../../src/pricing/pricing-outcome-retry";
import { mockConfigService } from "../helpers";
import { tokenBook, tokens } from "./pricing-fixtures";
import type { RecoveryResolutionInput } from "../../src/pricing/pricing-resolution.types";

const workspace = "default-workspace";
const actor = { id: "synthetic-admin", role: "admin" as const, workspace_id: workspace, global_admin: true };
const identity = { workspaceId: workspace, apiKeyName: null, apiKeyId: null, teamId: null, namespaceId: null };
const target = { model: "synthetic-model", node_id: "synthetic-node", operation: "chat_completions" };
function contract(label: string, connect: () => Promise<{ source: DataSource; cleanup: () => Promise<void> }>, run = describe) {
  run(label, () => {
    let source: DataSource, cleanup: () => Promise<void>, ledger: CostLedgerService, prices: PricingRepository;
    const fresh = () => new CostLedgerService(source, new BudgetService(mockConfigService(), new WorkspaceContextService(), source.getRepository(BudgetRule)));
    beforeEach(async () => {
      ({ source, cleanup } = await connect()); await applyPricingSchema(source);
      await source.getRepository(BudgetRule).save([
        { workspace_id: workspace, type: "daily_cost", limit_value: 1000, current_value: 0, alert_threshold: 0.8, period_start: new Date(), is_active: true },
        { workspace_id: workspace, type: "daily_tokens", limit_value: 10000000, current_value: 0, alert_threshold: 0.8, period_start: new Date(), is_active: true },
      ]);
      ledger = fresh(); prices = new PricingRepository(source);
      const created = await prices.createBook(actor, { name: "Synthetic actual budget", scope: "workspace", content: tokenBook() });
      await prices.publishDraft(actor, created.draft.id, { draft_revision: 1, catalog_revision: 0, reason: "Synthetic fixture", confirm: true, targets: [{ level: "model", model: target.model }] });
      await prices.updateAdmissionPolicy(actor, { catalog_revision: 1, reason: "Synthetic actual policy", confirm: true, scope: "workspace", operation: target.operation, policy: { mode: "compatibility", budget_basis: "actual_upstream" } });
    });
    afterEach(async () => { jest.restoreAllMocks(); if (source?.isInitialized) await source.destroy(); await cleanup?.(); });
    async function seed(count = 2, requestId = "request") {
      const snapshot = (await prices.capture({ request_id: requestId, workspace_id: workspace, report_currency: "USD" }))!;
      const first = snapshot.quote(target, tokens({ input_tokens: 1000, output_tokens: 100 })).cost;
      const second = snapshot.quote(target, tokens({ input_tokens: 2000, output_tokens: 100 })).cost;
      const reservation = { id: requestId, requestId, identity, target, estimate: first, tokens: "5000", costUsd: "0.1", budgetBasis: "actual_upstream", leaseOwner: "synthetic-owner", leaseUntil: new Date(Date.now() + 60000).toISOString() };
      await ledger.reserve(reservation);
      const ids = Array.from({ length: count }, (_, i) => `${requestId === "request" ? "" : requestId + "-"}attempt-${i}`);
      for (const id of ids) await ledger.beginAttempt({ id, requestId, workspace, reservationId: requestId, target, feeSource: "provider", dispatchedAt: new Date().toISOString(), priceContext: { context: {}, legacyPrice: null } });
      const close: Extract<PricingOutcome, { type: "actual_budget_closure" }> = { type: "actual_budget_closure", workspace, reservationId: requestId, payload: { attempt_ids: ids, missing_dispatch_evidence: false, receipts: count ? [{ attemptId: ids[0], cost: first, errorCode: "upstream_500" }] : [] } };
      return { first, second, snapshot, reservation, close };
    }
    async function recovery(id = "operator-reconcile", expire = true): Promise<RecoveryResolutionInput> {
      if (expire) await source.createQueryBuilder().update("pricing_reservations").set({ lease_until: new Date(Date.now() - 60000).toISOString() }).where("id = :id", { id: "request" }).execute();
      const basis = await ledger.recoveryBasis("request", workspace);
      return { id, reason: "Synthetic operator recovery", confirm: true, expected_basis_hash: basis.basis_hash, decisions: [{ reservation_id: "request", action: "reconcile_actual" }] };
    }
    async function physicalFixture(unknown = false) {
      const a = await seed(0, "group-a"), b = await seed(0, "group-b");
      const members = ["group-a", "group-b"].map((id, index) => ({ request_id: id, reservation_id: id, input_start: index, input_count: 1, weight: String(index + 1), weight_basis: "token_input_count" as const }));
      const ids = members.map(member => member.request_id + "-physical");
      await ledger.beginAttemptGroup(members.map((member, index) => ({ id: ids[index], requestId: member.request_id, workspace, reservationId: member.reservation_id, target, feeSource: "provider" as const, dispatchedAt: new Date().toISOString(), priceContext: { context: {}, legacyPrice: null, batch: { batch_id: "fixture-batch", physical_attempt_id: "fixture-physical", member_index: index, request_ids: members.map(m => m.request_id) } } })), members);
      const physical = a.snapshot.quote(target, tokens(unknown ? {} : { input_tokens: 3000, output_tokens: 0 })).cost;
      const allocation = allocateBatchCost("fixture-batch", physical, members);
      const outcomes = members.map((_, index) => ({ id: ids[index], cost: batchShareCost(allocation, index, "fixture-physical") }));
      const closure: Extract<PricingGroupOutcome, { type: "actual_budget_closure_group" }> = { type: "actual_budget_closure_group", workspace, entries: members.map((m, index) => ({ reservationId: m.reservation_id, payload: { attempt_ids: [ids[index]], missing_dispatch_evidence: false, receipts: [] } })) };
      return { a, b, members, ids, outcomes, closure };
    }
    it("settles physical shares through an atomic actual closure group and replays without double charging", async () => {
      const { outcomes, closure } = await physicalFixture();
      await ledger.persistRuntimeGroupOutcome({ type: "attempt_group", workspace, entries: outcomes });
      const packed = runtimeGroupOutcomeDocument(closure);
      expect(readRuntimeGroupDocument(packed.json).hash).toBe(packed.hash);
      await ledger.persistRuntimeGroupOutcome(closure);
      const rows = await source.query("SELECT id,state,committed_tokens,committed_cost_usd FROM pricing_reservations ORDER BY id");
      expect(rows).toEqual([{ id: "group-a", state: "committed", committed_tokens: "1000", committed_cost_usd: "0.001000000000000000" }, { id: "group-b", state: "committed", committed_tokens: "2000", committed_cost_usd: "0.002000000000000000" }]);
      const rules = await source.query("SELECT * FROM budget_rules ORDER BY id");
      await fresh().persistRuntimeGroupOutcome({ ...closure, entries: [...closure.entries].reverse() });
      expect(await source.query("SELECT * FROM budget_rules ORDER BY id")).toEqual(rules);
      expect(await source.query("SELECT * FROM pricing_budget_effects WHERE kind = 'commit'")).toHaveLength(2);
      expect((await source.query("SELECT * FROM pricing_runtime_group_outcomes WHERE kind = 'actual_budget_closure_group'"))[0].state).toBe("delivered");
    });
    it("rolls every member fence and debit back if the grouped closure acknowledgement fails", async () => {
      const { outcomes, closure } = await physicalFixture();
      await ledger.persistRuntimeGroupOutcome({ type: "attempt_group", workspace, entries: outcomes });
      const before = await source.query("SELECT * FROM budget_rules ORDER BY id");
      const transition = groupInbox.transitionRuntimeGroupOutcome;
      const fault = jest.spyOn(groupInbox, "transitionRuntimeGroupOutcome").mockImplementation(async (...args) => {
        if (args[1].kind === "actual_budget_closure_group" && args[2] === "delivered") throw new Error("Synthetic grouped actual ack failure");
        return transition(...args);
      });
      await expect(ledger.persistRuntimeGroupOutcome(closure)).rejects.toThrow("grouped actual ack failure");fault.mockRestore();
      expect(await source.query("SELECT * FROM pricing_actual_budget_cohorts")).toHaveLength(0);
      expect(await source.query("SELECT * FROM pricing_budget_effects WHERE kind = 'commit'")).toHaveLength(0);
      expect(await source.query("SELECT * FROM budget_rules ORDER BY id")).toEqual(before);
      expect((await source.query("SELECT state FROM pricing_runtime_group_outcomes WHERE kind = 'actual_budget_closure_group'"))[0].state).toBe("pending");
      expect((await fresh().replayRuntimeGroupOutcomes(new Date(Date.now() + 120000))).persisted).toBe(1);
      expect(await source.query("SELECT * FROM pricing_budget_effects WHERE kind = 'commit'")).toHaveLength(2);
    });
    it("does not leave the first actual member debited if the second member budget write fails", async () => {
      const { outcomes, closure } = await physicalFixture();
      await ledger.persistRuntimeGroupOutcome({ type: "attempt_group", workspace, entries: outcomes });
      const before = await source.query("SELECT * FROM budget_rules ORDER BY id");
      const privateLedger = ledger as unknown as { applySettlementInTransaction: (...args: unknown[]) => Promise<unknown> };
      const apply = privateLedger.applySettlementInTransaction.bind(ledger); let calls = 0;
      const fault = jest.spyOn(privateLedger, "applySettlementInTransaction").mockImplementation(async (...args) => { if (++calls === 2) throw new Error("Synthetic second actual member failure"); return apply(...args); });
      await expect(ledger.persistRuntimeGroupOutcome(closure)).rejects.toThrow("second actual member failure");fault.mockRestore();
      expect(await source.query("SELECT * FROM pricing_actual_budget_cohorts")).toHaveLength(0);
      expect(await source.query("SELECT * FROM pricing_settlement_intents")).toHaveLength(0);
      expect(await source.query("SELECT * FROM budget_rules ORDER BY id")).toEqual(before);
      await fresh().persistRuntimeGroupOutcome(closure);
      expect(await source.query("SELECT * FROM pricing_budget_effects WHERE kind = 'commit'")).toHaveLength(2);
    });
    it.each([false, true])("applies later confirmed physical evidence to actual cohorts without double charging (initial unknown=%s)", async unknown => {
      const { a, outcomes, closure, ids } = await physicalFixture(unknown);
      await ledger.persistRuntimeGroupOutcome({ type: "attempt_group", workspace, entries: outcomes });
      await ledger.persistRuntimeGroupOutcome(closure);
      const input = { id: "confirmed-physical-update", attemptId: ids[0], workspace, expectedPhysicalCostHash: outcomes[0].cost.batch!.physical_cost_hash,
        physicalCost: a.snapshot.quote(target, tokens({ input_tokens: 6000, output_tokens: 0 })).cost,
        actorId: "synthetic-supplier-worker", reason: "Synthetic provider-confirmed usage", source: "provider_usage" as const };
      const changed = await ledger.adjustBatch(input);
      expect(changed.changes.every(change => change.adjustment!.application.budget_state === (unknown ? "pending" : "applied"))).toBe(true);
      await fresh().reconcileActualBudgets();
      expect((await fresh().summary("group-a", workspace))!.budget_committed_usd).toBe("0.002000000000000000");
      expect((await fresh().summary("group-b", workspace))!.budget_committed_usd).toBe("0.004000000000000000");
      const budget = await source.query("SELECT * FROM budget_rules ORDER BY id");
      await fresh().adjustBatch(input); await fresh().persistRuntimeGroupOutcome(closure);
      expect(await source.query("SELECT * FROM budget_rules ORDER BY id")).toEqual(budget);
      expect(await source.query("SELECT * FROM pricing_budget_effects WHERE kind = 'commit'")).toHaveLength(2);
    });
    it("preserves unknown physical costs and fences all members without guessing zero", async () => {
      const { outcomes, closure, ids } = await physicalFixture(true);
      await ledger.persistRuntimeGroupOutcome({ type: "attempt_group", workspace, entries: outcomes });
      await ledger.persistRuntimeGroupOutcome(closure);
      expect((await source.query("SELECT state FROM pricing_reservations")).every((r: { state: string }) => r.state === "reserved")).toBe(true);
      expect(await fresh().reconcileActualBudgets()).toEqual({ applied: 0, pending: 2, review_required: 0 });
      for (const reservation of ["group-a", "group-b"]) await expect(ledger.beginAttempt({ id: reservation + "-forbidden", requestId: reservation, workspace, reservationId: reservation, target, feeSource: "provider", dispatchedAt: new Date().toISOString(), priceContext: { context: {}, legacyPrice: null } })).rejects.toThrow("closed actual-upstream cohort");
      const basis = await ledger.recoveryBasis("group-a", workspace);
      expect(basis.request_ids).toEqual(["group-a", "group-b"]);
      const action = { id: "actual-physical-review", expected_basis_hash: basis.basis_hash, reason: "Synthetic unknown physical costs", confirm: true as const, decisions: closure.entries.map(e => ({ reservation_id: e.reservationId, action: "reconcile_actual" as const })) };
      const result = await ledger.resolveRecovery("group-a", actor, action);
      expect(result.unknown_attempt_ids.sort()).toEqual([...ids].sort());
      expect(result.changes.every(change => change.next_state === "reserved")).toBe(true);
      expect(await source.query("SELECT * FROM pricing_recovery_decisions")).toHaveLength(0);
    });
    it("refuses partial attempt membership and corrupted complete-group custody", async () => {
      const { outcomes, closure } = await physicalFixture();
      await ledger.persistRuntimeGroupOutcome({ type: "attempt_group", workspace, entries: outcomes });
      await expect(ledger.persistRuntimeGroupOutcome({ ...closure, entries: closure.entries.map(e => ({ ...e, payload: { ...e.payload, attempt_ids: [] } })) })).rejects.toMatchObject({ code: "pricing_group_outcome_review_required" });
      expect(await source.query("SELECT * FROM pricing_actual_budget_cohorts")).toHaveLength(0);
      await source.createQueryBuilder().delete().from("pricing_runtime_group_outcome_members").where("reservation_id = :id", { id: "group-b" }).execute();
      await expect(ledger.persistRuntimeGroupOutcome(closure)).rejects.toMatchObject({ status: 409 });
      expect(await source.query("SELECT * FROM pricing_budget_effects WHERE kind = 'commit'")).toHaveLength(0);
    });
    it("previews and applies all paid failed attempts without creating a fake runtime closure", async () => {
      const { first, second } = await seed();
      await ledger.completeAttempt("attempt-0", workspace, first, "upstream_500");
      await ledger.completeAttempt("attempt-1", workspace, second, "upstream_503");
      const input = await recovery(), before = await source.query("SELECT * FROM budget_rules ORDER BY id");
      const preview = await ledger.resolveRecovery("request", actor, input, true);
      expect(preview.changes[0]).toMatchObject({ action: "reconcile_actual", next_state: "committed", budget_tokens: "3200", budget_cost_usd: "0.003400000000000000", budget_attempt_id: null, pending_reasons: [] });
      expect(await source.query("SELECT * FROM pricing_actual_budget_cohorts")).toHaveLength(0);
      expect(await source.query("SELECT * FROM budget_rules ORDER BY id")).toEqual(before);
      const result = await ledger.resolveRecovery("request", actor, input);
      expect(result.changes).toEqual(preview.changes);
      expect(await source.query("SELECT * FROM pricing_runtime_outcomes")).toHaveLength(0);
      expect(await source.query("SELECT * FROM pricing_recovery_decisions")).toHaveLength(1);
      expect((await fresh().resolveRecovery("request", actor, input)).replayed).toBe(true);
      expect((await fresh().recoveryResolutionStatus("request", workspace, input.id)).result).toEqual(result);
      expect(await source.query("SELECT * FROM pricing_budget_effects WHERE kind = 'commit'")).toHaveLength(1);
    });
    it("fences unknown work without releasing its hold, then accepts a late original worker closure", async () => {
      const { first, second, close } = await seed();
      await ledger.completeAttempt("attempt-0", workspace, first, "upstream_500");
      const input = await recovery();
      const result = await ledger.resolveRecovery("request", actor, input);
      expect(result.changes[0]).toMatchObject({ next_state: "reserved", budget_cost_usd: "0.000000000000000000", pending_reasons: ["evidence_incomplete"] });
      expect(result.unknown_attempt_ids).toEqual(["attempt-1"]);
      expect(await source.query("SELECT * FROM pricing_recovery_decisions")).toHaveLength(0);
      expect((await ledger.recoveryInventory(workspace, { view: "open", limit: 10 })).items).toHaveLength(1);
      const closure = (await source.query("SELECT closure_json FROM pricing_actual_budget_cohorts"))[0].closure_json;
      await expect(ledger.beginAttempt({ id: "forbidden-new-attempt", requestId: "request", workspace, reservationId: "request", target, feeSource: "provider", dispatchedAt: new Date().toISOString(), priceContext: { context: {}, legacyPrice: null } })).rejects.toThrow("closed actual-upstream cohort");
      close.payload.receipts.push({ attemptId: "attempt-1", cost: second });
      await fresh().persistRuntimeOutcome(close);
      expect((await fresh().summary("request", workspace))!.budget_committed_usd).toBe("0.003400000000000000");
      expect((await source.query("SELECT closure_json FROM pricing_actual_budget_cohorts"))[0].closure_json).toBe(closure);
      expect((await fresh().recoveryResolutionStatus("request", workspace, input.id)).result).toEqual(result);
      expect((await fresh().resolveRecovery("request", actor, input)).replayed).toBe(true);
      await fresh().persistRuntimeOutcome(close);
      expect(await source.query("SELECT * FROM pricing_budget_effects WHERE kind = 'commit'")).toHaveLength(1);
    });
    it("allows evidence corrections after fencing but never promotes an administrator's estimate", async () => {
      const { first, second, snapshot } = await seed();
      const unknown = snapshot.quote(target, tokens({})).cost;
      await ledger.completeAttempt("attempt-0", workspace, first);
      await ledger.completeAttempt("attempt-1", workspace, unknown);
      await ledger.resolveRecovery("request", actor, await recovery());
      const estimate = structuredClone(second); estimate.status = "estimated"; estimate.evidence_status = "estimated";
      const changed = await ledger.adjustAttempt({ id: "operator-estimate", attemptId: "attempt-1", workspace, expectedCostHash: pricingContentHash(unknown), cost: estimate, actorId: actor.id, reason: "Synthetic estimate", source: "reconciliation" });
      expect(changed.application.budget_state).toBe("pending");
      expect((await fresh().reconcileActualBudgets()).applied).toBe(0);
      await ledger.adjustAttempt({ id: "later-supplier-evidence", attemptId: "attempt-1", workspace, expectedCostHash: changed.cost_hash, cost: second, actorId: actor.id, reason: "Synthetic observed evidence", source: "provider_usage" });
      expect((await fresh().reconcileActualBudgets()).applied).toBe(1);
    });
    it("releases a genuinely empty inactive population, not a missing-dispatch population", async () => {
      await seed(0);
      const result = await ledger.resolveRecovery("request", actor, await recovery());
      expect(result.changes[0]).toMatchObject({ next_state: "released", budget_tokens: "0", budget_cost_usd: "0.000000000000000000" });
      expect(await source.query("SELECT * FROM pricing_attempts")).toHaveLength(0);
    });
    it("retains missing-dispatch uncertainty and can acknowledge a pending runtime-owned fence", async () => {
      const { close } = await seed(0); close.payload.missing_dispatch_evidence = true;
      await ledger.persistRuntimeOutcome(close);
      const result = await ledger.resolveRecovery("request", actor, await recovery("missing-fence", false));
      expect(result.changes[0]).toMatchObject({ next_state: "reserved", pending_reasons: ["missing_dispatch_evidence"] });
      expect(await source.query("SELECT * FROM pricing_recovery_decisions")).toHaveLength(0);
      expect((await fresh().recoveryResolutionStatus("request", workspace, result.id)).result).toEqual(result);
    });
    it("blocks live unclosed owners and rejects winner/manual-token decisions", async () => {
      await seed();
      await expect(ledger.resolveRecovery("request", actor, await recovery("live", false))).rejects.toThrow("lease_active");
      const input = await recovery();
      for (const decision of [{ reservation_id: "request", action: "release" as const }, { reservation_id: "request", action: "reconcile_actual" as const, logical_tokens: "0" }, { reservation_id: "request", action: "reconcile_actual" as const, budget_attempt_id: "attempt-0" }])
        await expect(ledger.resolveRecovery("request", actor, { ...input, decisions: [decision] })).rejects.toThrow("logical winner or manual debit");
      await expect(ledger.resolveRecovery("request", { ...actor, role: "operator" }, input)).rejects.toMatchObject({ status: 403 });
    });
    it("includes retained outcome custody in CAS and keeps a known subtotal pending until delivery", async () => {
      const { first, second } = await seed();
      await ledger.completeAttempt("attempt-0", workspace, first);
      await ledger.completeAttempt("attempt-1", workspace, second);
      const input = await recovery();
      const retained: PricingOutcome = { type: "attempt", workspace, reservationId: "request", attemptId: "attempt-1", cost: second, errorCode: null };
      await ledger.retainRuntimeOutcome(retained);
      await expect(ledger.resolveRecovery("request", actor, input)).rejects.toThrow("reread and preview again");
      const result = await ledger.resolveRecovery("request", actor, await recovery("custody-fence"));
      expect(result.changes[0]).toMatchObject({ next_state: "reserved", pending_reasons: ["runtime_custody"] });
      expect((await fresh().reconcileActualBudgets()).applied).toBe(0);
      await ledger.persistRuntimeOutcome(retained);
      expect((await fresh().reconcileActualBudgets()).applied).toBe(1);
      expect((await fresh().recoveryResolutionStatus("request", workspace, result.id)).result).toEqual(result);
    });
    it("rolls a new operator fence, acknowledgement and budget effect back together", async () => {
      const { first, second } = await seed();
      await ledger.completeAttempt("attempt-0", workspace, first); await ledger.completeAttempt("attempt-1", workspace, second);
      const input = await recovery(), before = await source.query("SELECT * FROM budget_rules ORDER BY id");
      const fail = jest.spyOn(ledger as unknown as { applySettlementInTransaction: (...args: unknown[]) => Promise<void> }, "applySettlementInTransaction").mockRejectedValueOnce(new Error("Synthetic actual recovery failure"));
      await expect(ledger.resolveRecovery("request", actor, input)).rejects.toThrow("Synthetic actual recovery failure"); fail.mockRestore();
      expect(await source.query("SELECT * FROM pricing_audit_events WHERE action = 'cost.recovery_resolution'")).toHaveLength(0);
      expect(await source.query("SELECT * FROM pricing_actual_budget_cohorts")).toHaveLength(0);
      expect(await source.query("SELECT * FROM pricing_settlement_intents")).toHaveLength(0);
      expect(await source.query("SELECT * FROM budget_rules ORDER BY id")).toEqual(before);
      expect((await ledger.resolveRecovery("request", actor, input)).changes[0].next_state).toBe("committed");
    });
    it("preserves original period allocations and rejects a missing terminal decision link", async () => {
      const { first, second } = await seed();
      await ledger.completeAttempt("attempt-0", workspace, first); await ledger.completeAttempt("attempt-1", workspace, second);
      const input = await recovery();
      await source.getRepository(BudgetRule).update({ workspace_id: workspace }, { current_value: 5, period_start: new Date(Date.now() + 86400000) });
      const current = await source.query("SELECT * FROM budget_rules ORDER BY id");
      const result = await ledger.resolveRecovery("request", actor, input);
      expect(await source.query("SELECT * FROM budget_rules ORDER BY id")).toEqual(current);
      const originalHolds = JSON.parse((await source.query("SELECT holds_json FROM pricing_reservations"))[0].holds_json);
      const effect = JSON.parse((await source.query("SELECT allocations_json FROM pricing_budget_effects WHERE kind = 'commit'"))[0].allocations_json);
      expect(effect.map((entry: { ruleId: number; periodStart: string }) => [entry.ruleId, entry.periodStart])).toEqual(originalHolds.map((entry: { ruleId: number; periodStart: string }) => [entry.ruleId, entry.periodStart]));
      await source.createQueryBuilder().delete().from("pricing_recovery_decisions").where("reservation_id = :id", { id: "request" }).execute();
      await expect(fresh().recoveryResolutionStatus("request", workspace, result.id)).rejects.toThrow("membership is incomplete");
    });
    it("does not adopt newly added budget rules or the latest policy at actual recovery", async () => {
      const { first, second } = await seed();
      await ledger.completeAttempt("attempt-0", workspace, first); await ledger.completeAttempt("attempt-1", workspace, second);
      const input = await recovery();
      const extra = await source.getRepository(BudgetRule).save({ workspace_id: workspace, type: "daily_cost", limit_value: 1000, current_value: 7, alert_threshold: 0.8, period_start: new Date(), is_active: true });
      await prices.updateAdmissionPolicy(actor, { catalog_revision: 2, reason: "Synthetic later legacy policy", confirm: true, scope: "workspace", operation: target.operation, policy: { mode: "compatibility" } });
      expect((await ledger.resolveRecovery("request", actor, input)).changes[0].budget_cost_usd).toBe("0.003400000000000000");
      expect((await source.getRepository(BudgetRule).findOneByOrFail({ id: extra.id })).current_value).toBe(7);
    });
    it("does not acknowledge an operator fence whose authority audit is missing", async () => {
      await seed(); const input = await recovery();
      await ledger.resolveRecovery("request", actor, input);
      await source.createQueryBuilder().delete().from("pricing_audit_events").where("action = :action", { action: "cost.recovery_resolution" }).execute();
      await expect(fresh().recoveryBasis("request", workspace)).rejects.toThrow("immutable operator acknowledgement");
      expect((await source.query("SELECT state FROM pricing_reservations"))[0].state).toBe("reserved");
    });
    it("does not let a stale worker renew ownership after an actual fence", async () => {
      await seed(); await ledger.resolveRecovery("request", actor, await recovery());
      const before = await ledger.recoveryBasis("request", workspace);
      expect(await ledger.renew("request", workspace, "synthetic-owner", new Date(Date.now() + 60000).toISOString())).toBe(false);
      expect((await ledger.recoveryBasis("request", workspace)).basis_hash).toBe(before.basis_hash);
    });
    it("keeps complete-group custody pending instead of silently overriding a physical-group workflow", async () => {
      const { first, second } = await seed();
      await ledger.completeAttempt("attempt-0", workspace, first); await ledger.completeAttempt("attempt-1", workspace, second);
      await ledger.retainRuntimeGroupOutcome({ type: "settlement_group", workspace, entries: [{ reservationId: "request", payload: { kind: "release", tokens: "0", cost_usd: "0", budget_basis: "synthetic-runtime", receipt: null } }] });
      const result = await ledger.resolveRecovery("request", actor, await recovery());
      expect(result.changes[0]).toMatchObject({ next_state: "reserved", pending_reasons: ["runtime_group_custody"] });
      expect((await fresh().reconcileActualBudgets()).applied).toBe(0);
    });
    it("does not turn rejected runtime evidence into a zero-cost attempt", async () => {
      const { first, snapshot } = await seed();
      await ledger.completeAttempt("attempt-0", workspace, first);
      const unknown = snapshot.quote(target, tokens({})).cost;
      await ledger.completeAttempt("attempt-1", workspace, unknown);
      await recovery();
      await ledger.archiveRuntimeOutcome({ type: "attempt", workspace, reservationId: "request", attemptId: "attempt-1", cost: unknown, errorCode: null });
      const outcome = (await source.query("SELECT * FROM pricing_runtime_outcomes"))[0];
      await ledger.resolveRecovery("request", actor, await recovery("before-disposition"));
      const basis = await ledger.outcomeDispositionBasis(outcome.id, workspace);
      await ledger.disposeRuntimeOutcome(actor, outcome.id, { id: "reject-unknown", expected_basis_hash: basis.basis_hash, expected_outcome_hash: outcome.outcome_hash, action: "reject_evidence", reason: "Synthetic rejected evidence", confirm: true }, [], false);
      const result = await ledger.resolveRecovery("request", actor, await recovery("after-disposition"));
      expect(result.changes[0]).toMatchObject({ next_state: "reserved", pending_reasons: ["evidence_incomplete"] });
      expect(result.unknown_attempt_ids).toEqual(["attempt-1"]);
    });
    it("atomically settles the complete paid cohort and replays identical closure without a second debit", async () => {
      const { second, close } = await seed(); close.payload.receipts.push({ attemptId: "attempt-1", cost: second, errorCode: null });
      await ledger.persistRuntimeOutcome(close);
      expect((await ledger.summary("request", workspace))!.budget_committed_usd).toBe("0.003400000000000000");
      expect((await source.query("SELECT committed_tokens FROM pricing_reservations"))[0].committed_tokens).toBe("3200");
      const rules = await source.query("SELECT * FROM budget_rules ORDER BY id");
      await fresh().persistRuntimeOutcome(close);
      expect(await source.query("SELECT * FROM budget_rules ORDER BY id")).toEqual(rules);
      expect(await source.query("SELECT * FROM pricing_budget_effects WHERE kind = 'commit'")).toHaveLength(1);
    });
    it("holds an incomplete closed cohort, accepts a late original receipt and resumes with a fresh service", async () => {
      const { second, close } = await seed(); await ledger.persistRuntimeOutcome(close);
      expect((await source.query("SELECT state FROM pricing_reservations"))[0].state).toBe("reserved");
      expect((await source.query("SELECT state FROM pricing_actual_budget_cohorts"))[0].state).toBe("pending");
      await expect(ledger.beginAttempt({ id: "new-paid-attempt", requestId: "request", workspace, reservationId: "request", target, feeSource: "provider", dispatchedAt: new Date().toISOString(), priceContext: { context: {}, legacyPrice: null } })).rejects.toThrow("closed actual-upstream cohort");
      await fresh().completeAttempt("attempt-1", workspace, second);
      expect(await fresh().reconcileActualBudgets()).toEqual({ applied: 1, pending: 0, review_required: 0 });
      expect((await fresh().summary("request", workspace))!.budget_committed_usd).toBe("0.003400000000000000");
    });
    it("rolls back delivery, receipts and budget effects when closure acknowledgement fails, retaining the durable body", async () => {
      const { second, close } = await seed(); close.payload.receipts.push({ attemptId: "attempt-1", cost: second });
      const transition = inbox.transitionRuntimeOutcome;
      const fail = jest.spyOn(inbox, "transitionRuntimeOutcome").mockImplementation(async (...args) => {
        if (args[1].kind === "actual_budget_closure" && args[2] === "delivered") throw new Error("Synthetic acknowledgement failure");
        return transition(...args);
      });
      await expect(ledger.persistRuntimeOutcome(close)).rejects.toThrow("acknowledgement failure");
      expect(await source.query("SELECT * FROM pricing_actual_budget_cohorts")).toHaveLength(0);
      expect(await source.query("SELECT * FROM pricing_budget_effects WHERE kind = 'commit'")).toHaveLength(0);
      expect((await source.query("SELECT state FROM pricing_runtime_outcomes WHERE kind = 'actual_budget_closure'"))[0].state).toBe("pending");
      fail.mockRestore(); await fresh().replayRuntimeOutcomes(new Date(Date.now() + 120000));
      expect((await fresh().summary("request", workspace))!.budget_committed_usd).toBe("0.003400000000000000");
    });
    it("rejects incomplete cohort membership, foreign ownership and legacy winner settlement", async () => {
      const { first, close } = await seed();
      await expect(ledger.queueSettlement("request", workspace, "commit", "1100", first.report_amount!, "legacy_logical", { attemptId: "attempt-0", cost: first })).rejects.toThrow("verified complete expense cohort");
      await expect(ledger.persistRuntimeOutcome({ ...close, workspace: "foreign-workspace" })).rejects.toMatchObject({ status: 404 });
      await expect(ledger.persistRuntimeOutcome({ ...close, payload: { ...close.payload, attempt_ids: ["attempt-0"] } })).rejects.toThrow("complete dispatched cohort");
      expect(await source.query("SELECT * FROM pricing_settlement_intents")).toHaveLength(0);
      expect(await source.query("SELECT * FROM pricing_actual_budget_cohorts")).toHaveLength(0);
    });
    it("does not trust a rehashed policy identity during pending replay", async () => {
      const { close } = await seed(); await ledger.persistRuntimeOutcome(close);
      const row = (await source.query("SELECT * FROM pricing_actual_budget_cohorts"))[0];
      const policy_hash = "0".repeat(64);
      const closure_hash = pricingContentHash({ reservation_id: row.reservation_id, workspace_id: row.workspace_id, request_id: row.request_id, catalog_revision_id: row.catalog_revision_id, policy_hash, closure: JSON.parse(row.closure_json) });
      await source.createQueryBuilder().update("pricing_actual_budget_cohorts").set({ policy_hash, closure_hash }).where("reservation_id = :id", { id: "request" }).execute();
      expect(await fresh().reconcileActualBudgets()).toEqual({ applied: 0, pending: 0, review_required: 1 });
      expect((await source.query("SELECT state FROM pricing_actual_budget_cohorts"))[0].state).toBe("review_required");
      expect(await source.query("SELECT * FROM pricing_budget_effects WHERE kind = 'commit'")).toHaveLength(0);
    });
    it("keeps missing dispatch evidence unresolved and never lets expiry turn it into free usage", async () => {
      const { close } = await seed(0); close.payload.missing_dispatch_evidence = true;
      await ledger.persistRuntimeOutcome(close);
      expect(await fresh().recoverUndispatched(100, new Date(Date.now() + 120000))).toBe(0);
      expect(await fresh().reconcileActualBudgets()).toEqual({ applied: 0, pending: 1, review_required: 0 });
      expect((await fresh().summary("request", workspace))!.amount).toBeNull();
      expect((await source.query("SELECT state FROM pricing_reservations"))[0].state).toBe("reserved");
    });
    it("quarantines a corrupt cohort without blocking a later ready request", async () => {
      const bad = await seed(); await ledger.persistRuntimeOutcome(bad.close);
      const good = await seed(2, "second"); await ledger.persistRuntimeOutcome(good.close);
      await ledger.completeAttempt(good.close.payload.attempt_ids[1], workspace, good.second);
      await source.createQueryBuilder().update("pricing_actual_budget_cohorts").set({ closure_hash: "0".repeat(64) }).where("reservation_id = :id", { id: "request" }).execute();
      expect(await fresh().reconcileActualBudgets()).toEqual({ applied: 1, pending: 0, review_required: 1 });
      expect((await fresh().summary("second", workspace))!.budget_committed_usd).toBe("0.003400000000000000");
      expect((await source.query("SELECT state FROM pricing_reservations WHERE id = 'request'"))[0].state).toBe("reserved");
    });
    it("rejects rehashed applied-plan totals instead of acknowledging an inconsistent debit", async () => {
      const { second, close } = await seed(); close.payload.receipts.push({ attemptId: "attempt-1", cost: second });
      await ledger.persistRuntimeOutcome(close);
      const row = (await source.query("SELECT * FROM pricing_actual_budget_cohorts"))[0];
      const plan = JSON.parse(row.applied_plan_json); plan.cost_usd = "0.999000000000000000";
      const { plan_hash: _hash, ...body } = plan; plan.plan_hash = pricingContentHash(body);
      await source.createQueryBuilder().update("pricing_actual_budget_cohorts").set({ applied_plan_json: JSON.stringify(plan), applied_plan_hash: plan.plan_hash }).where("reservation_id = :id", { id: "request" }).execute();
      const rules = await source.query("SELECT * FROM budget_rules ORDER BY id");
      await expect(fresh().persistRuntimeOutcome(close)).rejects.toThrow("immutable settlement");
      expect(await source.query("SELECT * FROM budget_rules ORDER BY id")).toEqual(rules);
    });
    it("adjusts paid failed and successful attempts independently while conserving the complete accepted cohort", async () => {
      const { first, second, close, snapshot } = await seed(); close.payload.receipts.push({ attemptId: "attempt-1", cost: second });
      await ledger.persistRuntimeOutcome(close);
      const originalIntent = await source.query("SELECT * FROM pricing_settlement_intents"), originalAttempts = await source.query("SELECT * FROM pricing_attempts ORDER BY id");
      const failed = await ledger.adjustAttempt({ id: "failed-change", attemptId: "attempt-0", workspace, expectedCostHash: pricingContentHash(first), cost: snapshot.quote(target, tokens({ input_tokens: 500, output_tokens: 100 })).cost, actorId: actor.id, reason: "Synthetic later supplier evidence", source: "provider_usage" });
      expect(failed.application).toMatchObject({ budget_state: "applied", cost_delta: "-0.000500000000000000", tokens_delta: "-500" });
      const success = await ledger.adjustAttempt({ id: "success-change", attemptId: "attempt-1", workspace, expectedCostHash: pricingContentHash(second), cost: snapshot.quote(target, tokens({ input_tokens: 3000, output_tokens: 100 })).cost, actorId: actor.id, reason: "Synthetic later supplier evidence", source: "provider_usage" });
      expect(success.application.cost_delta).toBe("0.001000000000000000");
      expect((await fresh().summary("request", workspace))!.budget_committed_usd).toBe("0.003900000000000000");
      await fresh().persistRuntimeOutcome(close);
      expect((await fresh().summary("request", workspace))!.budget_committed_usd).toBe("0.003900000000000000");
      expect(await source.query("SELECT * FROM pricing_settlement_intents")).toEqual(originalIntent);
      expect(await source.query("SELECT * FROM pricing_attempts ORDER BY id")).toEqual(originalAttempts);
    });
    it("never promotes an estimated correction and still applies another attempt's independently confirmed change", async () => {
      const { first, second, close, snapshot } = await seed(); close.payload.receipts.push({ attemptId: "attempt-1", cost: second }); await ledger.persistRuntimeOutcome(close);
      const observed = snapshot.quote(target, tokens({ input_tokens: 5000, output_tokens: 100 })).cost;
      const estimated = structuredClone(observed); estimated.status = "estimated"; estimated.evidence_status = "estimated";
      for (const quantity of Object.values(estimated.usage.quantities)) if (quantity) { quantity.quality = "estimated"; quantity.source = "request_metadata"; }
      for (const line of estimated.lines) { line.evidence_quality = "estimated"; line.evidence_source = "request_metadata"; }
      const pending = await ledger.adjustAttempt({ id: "estimated-change", attemptId: "attempt-0", workspace, expectedCostHash: pricingContentHash(first), cost: estimated, actorId: actor.id, reason: "Synthetic unconfirmed estimate", source: "reconciliation" });
      expect(pending.application.budget_state).toBe("pending");
      await ledger.adjustAttempt({ id: "confirmed-other", attemptId: "attempt-1", workspace, expectedCostHash: pricingContentHash(second), cost: snapshot.quote(target, tokens({ input_tokens: 3000, output_tokens: 100 })).cost, actorId: actor.id, reason: "Synthetic observed counter", source: "provider_usage" });
      expect((await fresh().summary("request", workspace))!).toMatchObject({ budget_committed_usd: "0.004400000000000000", pending_budget_adjustments: 1 });
      await fresh().persistRuntimeOutcome(close);
      await ledger.adjustAttempt({ id: "confirmed-later", attemptId: "attempt-0", workspace, expectedCostHash: pending.cost_hash, cost: observed, actorId: actor.id, reason: "Synthetic observed counter", source: "provider_usage" });
      expect((await fresh().summary("request", workspace))!).toMatchObject({ budget_committed_usd: "0.008400000000000000", pending_budget_adjustments: 0 });
    });
    it("anchors pre-settlement corrections in the first actual debit and does not count their pending marker twice", async () => {
      const { second, close, snapshot } = await seed();
      const unknown = snapshot.quote(target, tokens({})).cost;
      expect(unknown.report_amount).toBeNull();
      await ledger.completeAttempt("attempt-1", workspace, unknown); await ledger.persistRuntimeOutcome(close);
      const fixed = await ledger.adjustAttempt({ id: "first-known", attemptId: "attempt-1", workspace, expectedCostHash: pricingContentHash(unknown), cost: second, actorId: actor.id, reason: "Synthetic recovered usage", source: "provider_usage" });
      expect(fixed.application.budget_state).toBe("pending");
      await fresh().reconcileActualBudgets();
      expect((await fresh().summary("request", workspace))!).toMatchObject({ budget_committed_usd: "0.003400000000000000", pending_budget_adjustments: 0 });
      await ledger.adjustAttempt({ id: "after-initial", attemptId: "attempt-1", workspace, expectedCostHash: fixed.cost_hash, cost: snapshot.quote(target, tokens({ input_tokens: 2500, output_tokens: 100 })).cost, actorId: actor.id, reason: "Synthetic later usage", source: "provider_usage" });
      await fresh().persistRuntimeOutcome(close);
      expect((await fresh().summary("request", workspace))!.budget_committed_usd).toBe("0.003900000000000000");
    });
    it("applies an actual refund only to the original budget period", async () => {
      const { first, second, close, snapshot } = await seed(); close.payload.receipts.push({ attemptId: "attempt-1", cost: second }); await ledger.persistRuntimeOutcome(close);
      await source.getRepository(BudgetRule).update({ workspace_id: workspace }, { current_value: 5, period_start: new Date(Date.now() + 86400000) });
      const active = await source.query("SELECT * FROM budget_rules ORDER BY id");
      const result = await ledger.adjustAttempt({ id: "old-period-refund", attemptId: "attempt-0", workspace, expectedCostHash: pricingContentHash(first), cost: snapshot.quote(target, tokens({ input_tokens: 500, output_tokens: 100 })).cost, actorId: actor.id, reason: "Synthetic old-period evidence", source: "provider_usage" });
      expect(result.application.cost_delta).toBe("-0.000500000000000000");
      expect(await source.query("SELECT * FROM budget_rules ORDER BY id")).toEqual(active);
      expect((await fresh().summary("request", workspace))!.budget_committed_usd).toBe("0.002900000000000000");
    });
    it("rolls an actual adjustment back with its audit and replays the same request once", async () => {
      const { first, second, close, snapshot } = await seed(); close.payload.receipts.push({ attemptId: "attempt-1", cost: second }); await ledger.persistRuntimeOutcome(close);
      const input = { id: "atomic-actual-change", attemptId: "attempt-0", workspace, expectedCostHash: pricingContentHash(first), cost: snapshot.quote(target, tokens({ input_tokens: 500, output_tokens: 100 })).cost, actorId: actor.id, reason: "Synthetic observed correction", source: "provider_usage" as const };
      const before = await source.query("SELECT * FROM budget_rules ORDER BY id");
      const fault = jest.spyOn(ledger as unknown as { auditAdjustment: (...args: unknown[]) => Promise<void> }, "auditAdjustment").mockRejectedValueOnce(new Error("Synthetic actual audit failure"));
      await expect(ledger.adjustAttempt(input)).rejects.toThrow("actual audit failure"); fault.mockRestore();
      expect(await source.query("SELECT * FROM budget_rules ORDER BY id")).toEqual(before);
      expect(await source.query("SELECT * FROM pricing_cost_adjustments")).toHaveLength(0);
      const result = await ledger.adjustAttempt(input); expect(await fresh().adjustAttempt(input)).toEqual(result);
      expect((await fresh().summary("request", workspace))!.budget_committed_usd).toBe("0.002900000000000000");
    });
    it("keeps the complete-cohort CAS hash stable when independent history groups arrive in another row order", async () => {
      const { first, second, close, snapshot } = await seed(); close.payload.receipts.push({ attemptId: "attempt-1", cost: second }); await ledger.persistRuntimeOutcome(close);
      for (const [id, prior, input] of [["attempt-0", first, 500], ["attempt-1", second, 2500]] as const)
        await ledger.adjustAttempt({ id: `ordered-${id}`, attemptId: id, workspace, expectedCostHash: pricingContentHash(prior), cost: snapshot.quote(target, tokens({ input_tokens: input, output_tokens: 100 })).cost, actorId: actor.id, reason: "Synthetic stable ordering", source: "provider_usage" });
      const reservation = (await source.query("SELECT * FROM pricing_reservations"))[0];
      const before = await source.transaction(manager => actualBudgetAdjustmentBasis(manager, reservation));
      const read = actualEvidence.readActualBudgetEvidence;
      jest.spyOn(actualEvidence, "readActualBudgetEvidence").mockImplementation(async (...args) => {
        const value = await read(...args); return { ...value, history: new Map([...value.history].reverse()) };
      });
      const after = await source.transaction(manager => actualBudgetAdjustmentBasis(manager, reservation));
      expect(after.basis_hash).toBe(before.basis_hash);
      expect(after.applied!.plan_hash).toBe(before.applied!.plan_hash);
    });
  });
}
contract("SQLite actual budget cohort writes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "actual-cohort-"));
  const source = await new DataSource({ type: "better-sqlite3", database: join(directory, "ledger.db"), entities: [BudgetRule], synchronize: true }).initialize();
  await source.query("PRAGMA journal_mode=WAL"); await source.query("PRAGMA synchronous=FULL");
  return { source, cleanup: async () => rmSync(directory, { recursive: true, force: true }) };
});
const pgUrl = process.env.SIFTGATE_PRICING_TEST_POSTGRES_URL;
if (pgUrl && (new URL(pgUrl).hostname !== "127.0.0.1" || !/^\/pricing_goal_[a-z0-9_]+$/.test(new URL(pgUrl).pathname))) throw new Error("Use only an isolated test PostgreSQL database");
contract("PostgreSQL actual budget cohort writes", async () => {
  const schema = `actual_cohort_${process.pid}_${Math.random().toString(16).slice(2)}`;
  const admin = await new DataSource({ type: "postgres", url: pgUrl }).initialize(); await admin.query(`CREATE SCHEMA "${schema}"`);
  const source = await new DataSource({ type: "postgres", url: pgUrl, schema, extra: { options: `-c search_path=${schema}` }, entities: [BudgetRule], synchronize: true }).initialize();
  return { source, cleanup: async () => { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.destroy(); } };
}, pgUrl ? describe : describe.skip);

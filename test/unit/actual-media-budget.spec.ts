// Real database lifecycle cases and their fixtures use bounded 30s execution
// budgets for schema setup, publication, settlement and cold recovery. Test
// bodies and monetary/data assertions are unchanged; these are not API SLOs.
import { DataSource } from "typeorm";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { spawnSync } from "node:child_process";
import { BudgetService } from "../../src/budget/budget.service";
import { BudgetRule } from "../../src/database/entities/budget-rule.entity";
import { WorkspaceContextService } from "../../src/workspaces/workspace-context.service";
import { CostLedgerService } from "../../src/pricing/cost-ledger.service";
import { MediaTaskService } from "../../src/pricing/media-task.service";
import { PricingRepository } from "../../src/pricing/pricing-repository";
import { applyPricingSchema } from "../../src/pricing/pricing-schema";
import { mediaPricingContext, meterMediaUsage } from "../../src/pricing/media-metering";
import { meterMediaTask } from "../../src/pricing/media-task-metering";
import { assessPricingAdmission } from "../../src/pricing/pricing-admission";
import { MediaSupplierService } from "../../src/pricing/media-supplier.service";
import { MediaEventDispositionService } from "../../src/pricing/media-event-disposition.service";
import { mediaSupplierSigningInput } from "../../src/pricing/media-supplier-event";
import type { MediaSupplierEvent } from "../../src/pricing/media-supplier.types";
import { runtimeOutcomeDocument } from "../../src/pricing/pricing-outcome-document";
import { MediaNormalizer } from "../../src/canonical/normalizers/media.normalizer";
import type { ConfigService } from "../../src/config/config.service";
import type { MediaTaskContext } from "../../src/pricing/media-task.types";
import { mockConfigService } from "../helpers";
import { book, rate } from "./pricing-fixtures";

const workspace = "default-workspace";
const actor = { id: "synthetic-admin", role: "admin" as const, workspace_id: workspace, global_admin: true };
const identity = { workspaceId: workspace, apiKeyName: null, apiKeyId: null, teamId: null, namespaceId: null };
const target = { model: "synthetic-video", node_id: "synthetic-node", operation: "video_generation" };
const canonical = new MediaNormalizer().normalize({ model: target.model, seconds: 8 }, {}, "video_generation");
const complete = (seconds = "6.4", status = "completed") => ({ id: "synthetic-job", status, usage: { video_seconds: seconds, generation_count: 1 } });

function contract(label: string, connect: () => Promise<{ source: DataSource; cleanup: () => Promise<void> }>, run = describe) {
  run(label, () => {
    let source: DataSource, cleanup: () => Promise<void>, ledger: CostLedgerService, prices: PricingRepository, tasks: MediaTaskService;
    const config = { getNode: (id: string) => id === target.node_id ? {
      id, name: "Synthetic media", protocol: "chat_completions", base_url: "http://synthetic.test", endpoint: "/generate",
      timeout_ms: 1000, models: [], api_key: "synthetic-media-key", video_status_endpoint: "/jobs/:id",
      video_cancel_endpoint: "/jobs/:id/cancel", video_content_endpoint: "/jobs/:id/content",
    } : undefined } as unknown as ConfigService;
    const fresh = () => new CostLedgerService(source, new BudgetService(mockConfigService(), new WorkspaceContextService(), source.getRepository(BudgetRule)));
    const summary = () => ledger.summary("request", workspace);
    const task = async () => (await tasks.get("attempt", workspace))!;
    beforeEach(async () => {
      ({ source, cleanup } = await connect());
      await applyPricingSchema(source);
      await source.getRepository(BudgetRule).save({ workspace_id: workspace, type: "daily_cost", limit_value: 1000, current_value: 0, alert_threshold: 0.8, period_start: new Date(), is_active: true });
      ledger = fresh(); prices = new PricingRepository(source); tasks = new MediaTaskService(source, prices, ledger, config);
      const content = { ...book([rate("duration", "video_seconds", "0.10", "1"), rate("base", "video_generation_count", "0.02", "1")]), allow_combined_media: true };
      const created = await prices.createBook(actor, { name: "Synthetic actual media", scope: "workspace", content });
      await prices.publishDraft(actor, created.draft.id, { draft_revision: 1, catalog_revision: 0, reason: "Synthetic fixture", confirm: true, targets: [{ level: "model", model: target.model, operation: target.operation }] });
      await prices.updateAdmissionPolicy(actor, { catalog_revision: 1, reason: "Synthetic actual media policy", confirm: true, scope: "workspace", operation: target.operation, policy: { mode: "compatibility", budget_basis: "actual_upstream" } });
    }, 30_000);
    afterEach(async () => {
      jest.restoreAllMocks();
      await tasks?.onModuleDestroy();
      if (source?.isInitialized) await source.destroy();
      await cleanup?.();
    }, 30_000);
    async function start() {
      const snapshot = (await prices.capture({ request_id: "request", workspace_id: workspace, report_currency: "USD" }))!;
      const context: MediaTaskContext = {
        identity, target, operation: "video_generation", pricing: { ...mediaPricingContext(canonical), attempt_dispatched_at: new Date().toISOString() },
        request_usage: meterMediaUsage(canonical, undefined, "result"), legacy_price: null, legacy_version: 1, logical_tokens: "0", fallback_cost_usd: "0.82",
      };
      await ledger.reserve({ id: "reservation", requestId: "request", identity, target, estimate: snapshot.quote(target, meterMediaUsage(canonical, undefined, "estimate")).cost, tokens: "0", costUsd: "0.82", budgetBasis: "actual_upstream", leaseOwner: "synthetic-owner", leaseUntil: new Date(Date.now() + 60000).toISOString() });
      await ledger.beginAttempt({ id: "attempt", requestId: "request", workspace, reservationId: "reservation", target, feeSource: "provider", dispatchedAt: new Date().toISOString(), priceContext: { context: context.pricing, legacyPrice: null }, mediaTask: tasks.descriptor("attempt", "request", "reservation", context, null) });
      await tasks.markSubmitted("attempt", workspace);
    }
    async function tokenPolicy(token_budget: "reported_tokens" | "not_applicable") {
      const { head } = await prices.listAdmissionPolicies(actor);
      await prices.updateAdmissionPolicy(actor, { catalog_revision: head.revision, reason: "Synthetic explicit token quota decision", confirm: true, scope: "workspace", operation: target.operation, policy: { mode: "compatibility", budget_basis: "actual_upstream", token_budget } });
    }
    async function tokenRule(overLimit = false) {
      return source.getRepository(BudgetRule).save({ workspace_id: workspace, type: "daily_tokens", limit_value: 1000, current_value: overLimit ? 1001 : 0, alert_threshold: 0.8, period_start: new Date(), is_active: true });
    }
    async function sibling(id = "sibling") {
      const context = JSON.parse((await task()).context_json) as MediaTaskContext;
      await ledger.beginAttempt({ id, requestId: "request", workspace, reservationId: "reservation", target, feeSource: "provider", dispatchedAt: new Date().toISOString(), priceContext: { context: context.pricing, legacyPrice: null }, mediaTask: tasks.descriptor(id, "request", "reservation", context, null) });
      await tasks.markSubmitted(id, workspace);
    }
    const siblingComplete = (seconds = "3.4", status = "completed") => ({ ...complete(seconds, status), id: "sibling-job" });
    it.each(["first-ack", "before-last-ack", "last-status-in-transaction", "last-commit"] as const)("recovers actual sibling accounting after a real subprocess exits at %s", async mode => {
      await start(); await sibling();
      if (mode !== "first-ack") await tasks.accept("attempt", workspace, complete());
      const child = spawnSync(process.execPath, ["-r", require.resolve("ts-node/register"), require.resolve("../helpers/actual-media-crash-child")], {
        cwd: process.cwd(), env: { HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, PATH: process.env.PATH, NODE_OPTIONS: "--max-old-space-size=512", TS_NODE_TRANSPILE_ONLY: "true",
          PRICING_CHILD_DB: JSON.stringify(source.options), PRICING_CHILD_NODE: JSON.stringify(config.getNode(target.node_id)), PRICING_CHILD_MODE: mode },
        encoding: "utf8", timeout: 20000,
      });
      expect({ status: child.status, signal: child.signal, error: child.error?.message, stderr: child.stderr }).toEqual({ status: 17, signal: null, error: undefined, stderr: "" });
      expect(JSON.parse(child.stdout.trim())).toMatchObject({ checkpoint: mode, database: source.options.type, supplier_calls: 0 });
      const attempts = await source.query("SELECT id,state FROM pricing_attempts ORDER BY id");
      expect(attempts).toEqual([{ id: "attempt", state: "terminal" }, { id: "sibling", state: mode === "last-commit" ? "terminal" : "dispatched" }]);
      expect(await source.query("SELECT * FROM pricing_actual_budget_cohorts")).toHaveLength(mode === "last-commit" ? 1 : 0);
      expect(await source.query("SELECT * FROM pricing_budget_effects WHERE kind = 'commit'")).toHaveLength(mode === "last-commit" ? 1 : 0);
      const original = await source.query("SELECT * FROM pricing_attempts WHERE id = 'attempt'");
      const connection = await new DataSource({ ...source.options, synchronize: false }).initialize();
      const replacementLedger = new CostLedgerService(connection, new BudgetService(mockConfigService(), new WorkspaceContextService(), connection.getRepository(BudgetRule)));
      const replacement = new MediaTaskService(connection, new PricingRepository(connection), replacementLedger, config);
      const fetch = jest.spyOn(globalThis, "fetch");
      try {
        if (mode === "first-ack") await replacement.accept("sibling", workspace, siblingComplete());
        else await replacement.process("sibling", workspace);
        await replacement.process("attempt", workspace);
        await replacement.process("sibling", workspace);
        expect((await replacementLedger.summary("request", workspace))?.budget_committed_usd).toBe("1.020000000000000000");
      } finally { await replacement.onModuleDestroy(); await connection.destroy(); }
      expect(fetch).not.toHaveBeenCalled();
      expect(await source.query("SELECT * FROM pricing_attempts WHERE id = 'attempt'")).toEqual(original);
      expect(await source.query("SELECT * FROM pricing_budget_effects WHERE kind = 'commit'")).toHaveLength(1);
      expect((await source.query("SELECT state FROM pricing_media_tasks ORDER BY id")).map((row: { state: string }) => row.state)).toEqual(["settled", "settled"]);
    }, 30_000);

    async function publishCny(seconds: string, base: string, denominator: string) {
      const content = { ...book([rate("duration", "video_seconds", seconds, "1"), rate("base", "video_generation_count", base, "1")]), currency: "CNY", allow_combined_media: true };
      const created = await prices.createBook(actor, { name: "Synthetic pinned media FX", scope: "workspace", content });
      const { head } = await prices.listAdmissionPolicies(actor);
      await prices.publishDraft(actor, created.draft.id, { draft_revision: 1, catalog_revision: head.revision, reason: "Synthetic CNY rates", confirm: true, targets: [{ level: "model", model: target.model, operation: target.operation }] });
      await prices.updateFx(actor, { catalog_revision: head.revision + 1, reason: "Synthetic FX", confirm: true, scope: "workspace", versions: [{ fx: {
        version_id: `synthetic-${denominator}`, source: "synthetic fixture", from_currency: "CNY", to_currency: "USD", numerator: "1", denominator, effective_at: new Date().toISOString(),
      } }] });
    }

    it("uses original price and FX for late sibling receipts and corrections after both rates change", async () => {
      await publishCny("0.70", "0.14", "7");
      await start(); await sibling();
      const snapshot = (await prices.restoreRequest("request", workspace)).descriptor();
      const metered = meterMediaTask(JSON.parse((await task()).context_json) as MediaTaskContext, complete(), "completed");
      const initialCost = (await prices.restoreRequest("request", workspace)).quote(target, metered.usage, metered.context).cost;
      expect(initialCost).toMatchObject({ currency: "CNY", amount: "4.620000000", report_amount: "0.660000000" });
      await publishCny("1.40", "0.28", "14");
      // A changed FX exactly cancels the changed price. Identity, not only the
      // coincidentally equal USD total, must prove the old snapshot was used.
      await tasks.accept("attempt", workspace, complete());
      await tasks.accept("sibling", workspace, siblingComplete());
      expect((await summary())?.budget_committed_usd).toBe("1.020000000000000000");
      const original = await source.query("SELECT * FROM pricing_attempts WHERE id = 'attempt'");
      expect(JSON.parse(original[0].cost_json)).toMatchObject({ amount: "4.620000000", report_amount: "0.660000000", version_id: initialCost.version_id, fx_version_id: initialCost.fx_version_id });
      await tasks.accept("attempt", workspace, complete("7.4"));
      const correction = (await source.query("SELECT * FROM pricing_cost_adjustments"))[0];
      expect(JSON.parse(correction.cost_json)).toMatchObject({ amount: "5.320000000", report_amount: "0.760000000", version_id: initialCost.version_id, fx_version_id: initialCost.fx_version_id });
      expect((await summary())?.budget_committed_usd).toBe("1.120000000000000000");
      expect(await source.query("SELECT * FROM pricing_attempts WHERE id = 'attempt'")).toEqual(original);
      expect((await prices.restoreRequest("request", workspace)).descriptor()).toEqual(snapshot);
      const next = (await prices.capture({ request_id: "new-rates-request", workspace_id: workspace, report_currency: "USD" }))!.quote(target, metered.usage, metered.context).cost;
      expect(next.amount).toBe("9.240000000");
      expect(next.version_id).not.toBe(initialCost.version_id); expect(next.fx_version_id).not.toBe(initialCost.fx_version_id);
    }, 30_000);
    const secretName = "SIFTGATE_MEDIA_EVENT_ACTUAL_SIBLING", signingKey = "synthetic-actual-sibling-signing-key-not-production";
    let priorSecret: string | undefined;
    beforeEach(() => { priorSecret = process.env[secretName]; process.env[secretName] = signingKey; }, 30_000);
    afterEach(() => { if (priorSecret === undefined) delete process.env[secretName]; else process.env[secretName] = priorSecret; }, 30_000);
    async function signedSibling() {
      await tasks.accept("sibling", workspace, { id: "sibling-job", status: "pending" });
      const svc = new MediaSupplierService(source, config, tasks, ledger);
      await svc.configure(actor, "sibling-source", { revision: 0, node_id: target.node_id, credential_id: "default", secret_env: secretName, enabled: true, reason: "Synthetic sibling custody", confirm: true });
      const member = (await tasks.get("sibling", workspace))!;
      const event: MediaSupplierEvent = { schema_version: 1, event_id: "sibling-event", task_id: "sibling", provider_job_id: "sibling-job", sequence: "1", status: "completed", accepted_at: member.accepted_at!, completed_at: new Date().toISOString(), time_quality: "observed", evidence: [{ dimension: "video_seconds", value: "3.4", quality: "observed" }, { dimension: "video_generation_count", value: "1", quality: "observed" }] };
      const send = (value: MediaSupplierEvent) => {
        const timestamp = String(Math.floor(Date.now() / 1000));
        return svc.receive("sibling-source", value, { timestamp, revision: "1", signature: "v1=" + createHmac("sha256", signingKey).update(mediaSupplierSigningInput("sibling-source", "1", timestamp, value)).digest("hex") });
      };
      await send(event);
      const alternative = await send({ ...event, event_id: "sibling-alternative", evidence: [{ dimension: "video_seconds", value: "4.4", quality: "observed" }, event.evidence[1]] });
      expect(alternative.decision).toBe("review_required");
      expect(alternative.processing_pending).toBe(true);
      return alternative;
    }

    it.each(["reject", "accept"] as const)("retains whole-reservation holds until a sibling's signed conflict is reviewed by %s", async action => {
      await start(); await sibling();
      const alternative = await signedSibling();
      await tasks.accept("attempt", workspace, complete());
      expect((await source.query("SELECT * FROM pricing_reservations"))[0].state).toBe("reserved");
      expect(await fresh().reconcileActualBudgets()).toMatchObject({ pending: 1, applied: 0 });
      const recovery = await ledger.recoveryBasis("reservation", workspace);
      expect(recovery.reservations[0].actual_budget).toMatchObject({ settlement_ready: false, pending_reasons: ["media_custody"] });
      const dispositions = new MediaEventDispositionService(tasks, prices, ledger);
      const basis = await dispositions.basis(actor, "sibling", alternative.id);
      const preview = await dispositions.preview(actor, "sibling", alternative.id, { action, ordering: action === "accept" ? "continue_ordered" : "unchanged", expected_basis_hash: basis.basis_hash, expected_event_hash: basis.event_hash });
      const input = { id: `review-${action}`, action, ordering: preview.ordering, expected_basis_hash: preview.basis_hash, expected_event_hash: preview.event_hash, expected_preview_hash: preview.preview_hash, reason: "Synthetic sibling evidence review", confirm: true };
      await dispositions.apply(actor, "sibling", alternative.id, input);
      await tasks.process("attempt", workspace);
      expect((await summary())?.budget_committed_usd).toBe(action === "accept" ? "1.120000000000000000" : "1.020000000000000000");
      const before = await source.query("SELECT * FROM pricing_budget_effects ORDER BY id");
      await dispositions.apply(actor, "sibling", alternative.id, input);
      expect(await source.query("SELECT * FROM pricing_budget_effects ORDER BY id")).toEqual(before);
      expect((await source.query("SELECT state FROM pricing_media_tasks ORDER BY id")).map((row: { state: string }) => row.state)).toEqual(["settled", "settled"]);
    }, 30_000);

    it("includes additional retained sibling evidence in the whole-reservation recovery fingerprint", async () => {
      await start(); await sibling(); await signedSibling();
      await tasks.accept("attempt", workspace, complete());
      const before = await ledger.recoveryBasis("reservation", workspace);
      await tasks.observe("sibling", workspace, siblingComplete("5.4"));
      const after = await ledger.recoveryBasis("reservation", workspace);
      expect(after.basis_hash).not.toBe(before.basis_hash);
      expect(after.reservations[0].actual_budget).toMatchObject({ settlement_ready: false, pending_reasons: ["media_custody"] });
      expect(await source.query("SELECT * FROM pricing_budget_effects WHERE kind = 'commit'")).toHaveLength(0);
    }, 30_000);

    it("keeps the last receipt, closure, debit and all task statuses atomic if the second status write fails", async () => {
      await start(); await sibling();
      await tasks.accept("attempt", workspace, complete());
      const original = await source.query("SELECT * FROM pricing_attempts ORDER BY id");
      const prototype = Object.getPrototypeOf(source.manager.createQueryBuilder().update()), execute = prototype.execute;
      const fault = jest.spyOn(prototype, "execute").mockImplementation(function (this: { expressionMap: { mainAlias?: { tablePath?: string }; valuesSet?: unknown; parameters: Record<string, unknown> } }) {
        if (this.expressionMap.mainAlias?.tablePath === "pricing_media_tasks" && this.expressionMap.parameters.id === "sibling" && JSON.stringify(this.expressionMap.valuesSet).includes('"state":"settled"')) throw new Error("Synthetic sibling completion marker failed");
        return execute.call(this);
      });
      await expect(tasks.accept("sibling", workspace, siblingComplete())).rejects.toThrow("sibling completion marker failed");
      fault.mockRestore();
      expect(await source.query("SELECT * FROM pricing_attempts ORDER BY id")).toEqual(original);
      expect(await source.query("SELECT * FROM pricing_actual_budget_cohorts")).toHaveLength(0);
      expect(await source.query("SELECT * FROM pricing_budget_effects WHERE kind = 'commit'")).toHaveLength(0);
      expect((await source.query("SELECT * FROM pricing_media_observations WHERE task_id = 'sibling'"))[0].processed).toBe(0);
      expect((await task()).state).toBe("terminal");
      await tasks.process("sibling", workspace);
      expect((await summary())?.budget_committed_usd).toBe("1.020000000000000000");
    }, 30_000);

    it("serializes concurrent sibling completion and replays through a fresh database connection", async () => {
      await start(); await sibling();
      const second = new MediaTaskService(source, prices, fresh(), config);
      try { await Promise.all([tasks.accept("attempt", workspace, complete()), second.accept("sibling", workspace, siblingComplete("3.4", "failed"))]); }
      finally { await second.onModuleDestroy(); }
      expect((await summary())?.budget_committed_usd).toBe("1.020000000000000000");
      const before = await source.query("SELECT * FROM pricing_budget_effects ORDER BY id");
      const connection = await new DataSource({ ...source.options, synchronize: false }).initialize();
      const replacementLedger = new CostLedgerService(connection, new BudgetService(mockConfigService(), new WorkspaceContextService(), connection.getRepository(BudgetRule)));
      const replacement = new MediaTaskService(connection, new PricingRepository(connection), replacementLedger, config);
      try {
        await replacement.process("sibling", workspace);
        for (const observation of await connection.query("SELECT * FROM pricing_media_observations")) expect(await replacementLedger.processActualMediaObservation(observation.task_id, workspace, observation.id)).toBe(true);
      } finally { await replacement.onModuleDestroy(); await connection.destroy(); }
      expect(await source.query("SELECT * FROM pricing_budget_effects ORDER BY id")).toEqual(before);
    }, 30_000);

    it("does not accept a storage-only sibling authority through the runtime receipt wire", async () => {
      await start(); await sibling();
      await tasks.accept("attempt", workspace, complete()); await tasks.accept("sibling", workspace, siblingComplete());
      const payload = JSON.parse((await source.query("SELECT * FROM pricing_actual_budget_cohorts"))[0].closure_json);
      expect(() => runtimeOutcomeDocument({ type: "actual_budget_closure", workspace, reservationId: "reservation", payload })).toThrow();
    }, 30_000);

    it("retains a finished member without closing dispatch while a sibling media task is still live", async () => {
      await start(); await sibling();
      await tasks.accept("attempt", workspace, complete());
      expect((await task()).state).toBe("terminal");
      expect((await tasks.get("sibling", workspace))?.state).toBe("submitted");
      expect(await source.query("SELECT * FROM pricing_actual_budget_cohorts")).toHaveLength(0);
      expect((await source.query("SELECT * FROM pricing_attempts WHERE id = 'attempt'"))[0].state).toBe("terminal");
      expect((await source.query("SELECT * FROM pricing_media_observations"))[0]).toMatchObject({ processed: 1, action: "initial" });
      const first = await source.query("SELECT * FROM pricing_attempts WHERE id = 'attempt'");
      await tasks.accept("sibling", workspace, siblingComplete());
      expect((await summary())?.budget_committed_usd).toBe("1.020000000000000000");
      expect((await source.query("SELECT state FROM pricing_media_tasks ORDER BY id")).map((row: { state: string }) => row.state)).toEqual(["settled", "settled"]);
      expect(await source.query("SELECT * FROM pricing_attempts WHERE id = 'attempt'")).toEqual(first);
      const closure = JSON.parse((await source.query("SELECT * FROM pricing_actual_budget_cohorts"))[0].closure_json);
      expect(closure.media_authority).toMatchObject({ task_id: "attempt", siblings: [expect.objectContaining({ task_id: "sibling" })] });
      expect(await source.query("SELECT * FROM pricing_budget_effects WHERE kind = 'commit'")).toHaveLength(1);
    }, 30_000);

    it("defers a finished member's correction until peer initial receipts establish finality", async () => {
      await start(); await sibling();
      await tasks.accept("attempt", workspace, complete());
      await tasks.accept("attempt", workspace, complete("7.4"));
      const pending = await source.query("SELECT * FROM pricing_media_observations ORDER BY revision");
      expect(pending.map((row: { processed: number }) => row.processed)).toEqual([1, 0]);
      expect(await source.query("SELECT * FROM pricing_cost_adjustments")).toHaveLength(0);
      await tasks.accept("sibling", workspace, siblingComplete());
      expect((await source.query("SELECT * FROM pricing_reservations"))[0].state).toBe("reserved");
      await tasks.process("attempt", workspace);
      expect((await summary())?.budget_committed_usd).toBe("1.120000000000000000");
      await tasks.accept("sibling", workspace, siblingComplete("4.4"));
      expect((await summary())?.budget_committed_usd).toBe("1.220000000000000000");
      for (const observation of await source.query("SELECT * FROM pricing_media_observations ORDER BY observed_at"))
        expect(await fresh().processActualMediaObservation(observation.task_id, workspace, observation.id)).toBe(true);
      expect(await source.query("SELECT * FROM pricing_budget_effects WHERE kind = 'commit'")).toHaveLength(1);
    }, 30_000);

    it("marks every media task settled when background budget reconciliation receives the last earlier receipt", async () => {
      await start(); await sibling();
      await ledger.beginAttempt({ id: "earlier-attempt", requestId: "request", workspace, reservationId: "reservation", target, feeSource: "provider", dispatchedAt: new Date().toISOString(), priceContext: { context: {}, legacyPrice: null } });
      await tasks.accept("attempt", workspace, complete());
      await tasks.accept("sibling", workspace, siblingComplete());
      expect((await source.query("SELECT state FROM pricing_media_tasks ORDER BY id")).map((row: { state: string }) => row.state)).toEqual(["terminal", "terminal"]);
      const metered = meterMediaTask(JSON.parse((await task()).context_json) as MediaTaskContext, complete("2"), "completed");
      const snapshot = await prices.restoreRequest("request", workspace);
      await ledger.completeAttempt("earlier-attempt", workspace, snapshot.quote(target, metered.usage, metered.context).cost, "upstream_500");
      expect(await fresh().reconcileActualBudgets()).toMatchObject({ applied: 1, pending: 0 });
      expect((await summary())?.budget_committed_usd).toBe("1.240000000000000000");
      expect((await source.query("SELECT state FROM pricing_media_tasks ORDER BY id")).map((row: { state: string }) => row.state)).toEqual(["settled", "settled"]);
    }, 30_000);

    it("retains an earlier synchronous media receipt without treating it as an asynchronous authority", async () => {
      await start(); await sibling("synchronous-prior");
      await tasks.markSynchronous("synchronous-prior", workspace);
      const snapshot = await prices.restoreRequest("request", workspace);
      const metered = meterMediaTask(JSON.parse((await task()).context_json) as MediaTaskContext, complete("3.4"), "completed");
      await ledger.completeAttempt("synchronous-prior", workspace, snapshot.quote(target, metered.usage, metered.context).cost);
      await tasks.accept("attempt", workspace, complete());
      expect((await summary())?.budget_committed_usd).toBe("1.020000000000000000");
      expect((await tasks.get("synchronous-prior", workspace))?.state).toBe("synchronous");
      const closure = JSON.parse((await source.query("SELECT * FROM pricing_actual_budget_cohorts"))[0].closure_json);
      expect(closure.attempt_ids).toEqual(["attempt", "synchronous-prior"]);
      expect(closure.media_authority.siblings).toBeUndefined();
    }, 30_000);

    it("does not accept a surviving anchor audit when a sibling's original acknowledgement is missing", async () => {
      await start(); await sibling();
      await tasks.accept("attempt", workspace, complete());
      await tasks.accept("sibling", workspace, siblingComplete());
      const audits = await source.query("SELECT * FROM pricing_audit_events WHERE action = 'cost.actual_media_observation'");
      const lost = audits.find((row: { metadata_json: string }) => JSON.parse(row.metadata_json).task_id === "sibling");
      await source.createQueryBuilder().delete().from("pricing_audit_events").where("id = :id", { id: lost.id }).execute();
      const before = await source.query("SELECT * FROM pricing_budget_effects ORDER BY id");
      await expect(tasks.process("attempt", workspace)).rejects.toThrow("acknowledgement");
      expect(await source.query("SELECT * FROM pricing_budget_effects ORDER BY id")).toEqual(before);
    }, 30_000);

    it("explicitly excludes token quotas without changing token rules, unknown counters or monetary settlement", async () => {
      const rule = await tokenRule(true), before = await source.getRepository(BudgetRule).findOneByOrFail({ id: rule.id });
      await tokenPolicy("not_applicable");
      await start();
      expect(JSON.parse((await source.query("SELECT * FROM pricing_reservations"))[0].holds_json).map((hold: { type: string }) => hold.type)).toEqual(["daily_cost"]);
      await tasks.accept("attempt", workspace, complete());
      await tasks.accept("attempt", workspace, complete("7.4"));
      expect((await task()).state).toBe("settled");
      expect((await summary())?.budget_committed_usd).toBe("0.760000000000000000");
      expect(await source.getRepository(BudgetRule).findOneByOrFail({ id: rule.id })).toEqual(before);
      for (const observation of await source.query("SELECT * FROM pricing_media_observations")) {
        const usage = JSON.parse(observation.usage_json);
        expect(usage.quantities.total_input_tokens?.value ?? null).toBeNull();
        expect(usage.quantities.output_tokens?.value ?? null).toBeNull();
      }
    }, 30_000);

    it("does not retrospectively exempt a task admitted before the non-token policy was published", async () => {
      await tokenRule();
      await start();
      const before = (await prices.restoreRequest("request", workspace)).descriptor();
      await tokenPolicy("not_applicable");
      await tasks.accept("attempt", workspace, complete());
      expect((await task()).state).toBe("terminal");
      expect((await source.query("SELECT * FROM pricing_reservations"))[0].state).toBe("reserved");
      expect((await prices.restoreRequest("request", workspace)).descriptor()).toEqual(before);
      expect(await fresh().reconcileActualBudgets()).toMatchObject({ applied: 0, pending: 1 });
    }, 30_000);

    it("explicit reported-token policy retains a zero-quantity token hold when counters are unknown", async () => {
      await tokenRule();
      await tokenPolicy("reported_tokens");
      await start();
      await tasks.accept("attempt", workspace, complete());
      expect((await task()).state).toBe("terminal");
      expect(JSON.parse((await source.query("SELECT * FROM pricing_reservations"))[0].holds_json).map((hold: { type: string }) => hold.type).sort()).toEqual(["daily_cost", "daily_tokens"]);
    }, 30_000);

    it("still rejects an exceeded monetary budget when token quota is explicitly inapplicable", async () => {
      await tokenPolicy("not_applicable");
      await source.getRepository(BudgetRule).update({ type: "daily_cost" }, { limit_value: 0.1 });
      await expect(start()).rejects.toThrow();
      expect(await source.query("SELECT * FROM pricing_reservations")).toHaveLength(0);
      expect(await source.query("SELECT * FROM pricing_attempts")).toHaveLength(0);
    }, 30_000);

    it("rejects token-mixed price books before reservation even if the token rate is explicitly free", async () => {
      await tokenPolicy("not_applicable");
      const content = { ...book([rate("duration", "video_seconds", "0.1", "1"), rate("base", "video_generation_count", "0.02", "1"), rate("tokens", "output_tokens", "0", "1")]), allow_combined_media: true };
      const created = await prices.createBook(actor, { name: "Synthetic mixed media", scope: "workspace", content });
      const { head } = await prices.listAdmissionPolicies(actor);
      await prices.publishDraft(actor, created.draft.id, { draft_revision: 1, catalog_revision: head.revision, reason: "Synthetic mixed price", confirm: true, targets: [{ level: "model", model: target.model, operation: target.operation }] });
      await expect(start()).rejects.toThrow("frozen non-token price contract");
      const snapshot = await prices.restoreRequest("request", workspace), usage = meterMediaUsage(canonical, undefined, "estimate");
      expect(assessPricingAdmission(snapshot, target, usage, usage, {}, 1).assessment).toMatchObject({ allowed: false, reason: "token_budget_incompatible", token_budget: "not_applicable", reserved_cost_usd: null });
      expect(await source.query("SELECT * FROM pricing_reservations")).toHaveLength(0);
    }, 30_000);

    it("does not allow a changed attempt target to bypass its frozen non-token price contract", async () => {
      await tokenPolicy("not_applicable");
      await start();
      await expect(ledger.beginAttempt({ id: "substituted", requestId: "request", workspace, reservationId: "reservation", target: { ...target, model: "unpriced-model" }, feeSource: "provider", dispatchedAt: new Date().toISOString(), priceContext: { context: {}, legacyPrice: null } })).rejects.toThrow("original non-token price contract");
      expect(await source.query("SELECT * FROM pricing_attempts")).toHaveLength(1);
    }, 30_000);

    it.each([undefined, "chat_completions"])("refuses non-token policy on unsupported operation %s without publishing", async operation => {
      const before = await prices.listAdmissionPolicies(actor);
      await expect(prices.updateAdmissionPolicy(actor, { catalog_revision: before.head.revision, reason: "Synthetic invalid policy", confirm: true, scope: "workspace", operation, policy: { mode: "compatibility", budget_basis: "actual_upstream", token_budget: "not_applicable" } })).rejects.toThrow();
      expect(await prices.listAdmissionPolicies(actor)).toEqual(before);
    }, 30_000);

    it.each(["completed", "failed", "cancelled"])("commits observed paid %s media use through terminal observation authority exactly once", async status => {
      await start();
      await tasks.accept("attempt", workspace, complete("6.4", status));
      expect((await summary())?.budget_committed_usd).toBe("0.660000000000000000");
      expect((await task()).state).toBe("settled");
      const reservations = await source.query("SELECT * FROM pricing_reservations");
      expect(reservations[0]).toMatchObject({ budget_basis: "actual_upstream", state: "committed", committed_cost_usd: "0.660000000000000000" });
      const cohorts = await source.query("SELECT * FROM pricing_actual_budget_cohorts");
      expect(cohorts).toHaveLength(1);
      expect(JSON.parse(cohorts[0].closure_json)).toMatchObject({ attempt_ids: ["attempt"], receipts: [], media_authority: { task_id: "attempt" } });
      expect(await source.query("SELECT * FROM pricing_audit_events WHERE action = 'cost.actual_media_observation'")).toHaveLength(1);
      const effects = await source.query("SELECT * FROM pricing_budget_effects ORDER BY id");
      const restored = new MediaTaskService(source, prices, fresh(), config);
      try {
        await Promise.all([tasks.accept("attempt", workspace, complete("6.4", status)), restored.accept("attempt", workspace, complete("6.4", status))]);
        await restored.process("attempt", workspace);
      } finally { await restored.onModuleDestroy(); }
      expect(await source.query("SELECT * FROM pricing_budget_effects ORDER BY id")).toEqual(effects);
      expect(await source.query("SELECT * FROM pricing_media_observations")).toHaveLength(1);
    }, 30_000);

    it("does not fabricate token evidence when an original zero-token hold still requires daily tokens", async () => {
      await source.getRepository(BudgetRule).save({ workspace_id: workspace, type: "daily_tokens", limit_value: 1000000, current_value: 0, alert_threshold: 0.8, period_start: new Date(), is_active: true });
      await start();
      await tasks.accept("attempt", workspace, complete());
      expect((await task()).state).toBe("terminal");
      expect((await source.query("SELECT * FROM pricing_reservations"))[0].state).toBe("reserved");
      const observation = (await source.query("SELECT * FROM pricing_media_observations"))[0];
      expect(observation.processed).toBe(1);
      const quantities = JSON.parse(observation.usage_json).quantities;
      expect(quantities.total_input_tokens?.value ?? null).toBeNull();
      expect(quantities.output_tokens?.value ?? null).toBeNull();
      expect(await source.query("SELECT * FROM pricing_budget_effects WHERE kind = 'commit'")).toHaveLength(0);
      expect(await fresh().reconcileActualBudgets()).toMatchObject({ pending: 1, applied: 0 });
    }, 30_000);

    it("keeps missing usage reserved, then applies later observed cost without changing the original receipt", async () => {
      await start();
      await tasks.accept("attempt", workspace, { id: "synthetic-job", status: "completed" });
      expect((await task()).state).toBe("terminal");
      expect((await source.query("SELECT * FROM pricing_reservations"))[0].state).toBe("reserved");
      const original = await source.query("SELECT * FROM pricing_attempts");
      await tasks.accept("attempt", workspace, complete());
      expect((await summary())?.budget_committed_usd).toBe("0.660000000000000000");
      expect((await task()).state).toBe("settled");
      expect(await source.query("SELECT * FROM pricing_attempts")).toEqual(original);
      expect(await source.query("SELECT * FROM pricing_cost_adjustments")).toHaveLength(1);
      expect(await source.query("SELECT * FROM pricing_budget_effects WHERE kind = 'commit'")).toHaveLength(1);
    }, 30_000);

    it("processes a retained observation backlog before releasing actual-cost holds", async () => {
      await start();
      await tasks.observe("attempt", workspace, complete());
      await tasks.observe("attempt", workspace, complete("7.4"));
      await tasks.process("attempt", workspace);
      expect((await summary())?.budget_committed_usd).toBe("0.760000000000000000");
      expect((await task()).state).toBe("settled");
      expect((await source.query("SELECT * FROM pricing_media_observations ORDER BY revision")).map((o: { processed: number }) => o.processed)).toEqual([1, 1]);
      expect(await source.query("SELECT * FROM pricing_budget_effects WHERE kind = 'commit'")).toHaveLength(1);
    }, 30_000);

    it("records late observed corrections without repeating the initial budget debit", async () => {
      await start();
      await tasks.accept("attempt", workspace, complete());
      const original = await source.query("SELECT * FROM pricing_attempts");
      await tasks.accept("attempt", workspace, complete("7.4"));
      expect((await summary())?.budget_committed_usd).toBe("0.760000000000000000");
      expect((await task()).state).toBe("settled");
      expect(await source.query("SELECT * FROM pricing_attempts")).toEqual(original);
      expect(await source.query("SELECT * FROM pricing_budget_effects WHERE kind = 'commit'")).toHaveLength(1);
      expect(await source.query("SELECT * FROM pricing_cost_adjustments")).toHaveLength(1);
      const observations = await source.query("SELECT * FROM pricing_media_observations ORDER BY revision");
      for (const observation of observations) expect(await fresh().processActualMediaObservation("attempt", workspace, observation.id)).toBe(true);
    }, 30_000);

    it("does not acknowledge a processed observation after its initial settlement intent is lost", async () => {
      await start();
      await tasks.accept("attempt", workspace, complete());
      const observation = (await source.query("SELECT * FROM pricing_media_observations"))[0];
      const effects = await source.query("SELECT * FROM pricing_budget_effects ORDER BY id");
      await source.createQueryBuilder().delete().from("pricing_settlement_intents").execute();
      await expect(fresh().processActualMediaObservation("attempt", workspace, observation.id)).rejects.toMatchObject({ code: "pricing_version_conflict", status: 409, message: "Applied actual correction is missing its initial intent" });
      expect(await source.query("SELECT * FROM pricing_budget_effects ORDER BY id")).toEqual(effects);
    }, 30_000);

    it("can settle a processed observation when the last earlier attempt receipt arrives later", async () => {
      await start();
      await ledger.beginAttempt({ id: "earlier-attempt", requestId: "request", workspace, reservationId: "reservation", target, feeSource: "provider", dispatchedAt: new Date().toISOString(), priceContext: { context: {}, legacyPrice: null } });
      await tasks.accept("attempt", workspace, complete());
      expect((await source.query("SELECT * FROM pricing_reservations"))[0].state).toBe("reserved");
      const snapshot = await prices.restoreRequest("request", workspace);
      const metered = meterMediaTask(JSON.parse((await task()).context_json) as MediaTaskContext, complete("2"), "completed");
      const earlierCost = snapshot.quote(target, metered.usage, metered.context).cost;
      await ledger.completeAttempt("earlier-attempt", workspace, earlierCost, "upstream_500");
      const observation = (await source.query("SELECT * FROM pricing_media_observations"))[0];
      expect(await fresh().processActualMediaObservation("attempt", workspace, observation.id)).toBe(true);
      expect((await summary())?.budget_committed_usd).toBe("0.880000000000000000");
      await tasks.process("attempt", workspace);
      expect((await task()).state).toBe("settled");
      expect(await source.query("SELECT * FROM pricing_budget_effects WHERE kind = 'commit'")).toHaveLength(1);
    }, 30_000);

    it("does not substitute an audit for a lost correction receipt during processed replay", async () => {
      await start();
      await tasks.accept("attempt", workspace, complete());
      await tasks.accept("attempt", workspace, complete("7.4"));
      const observation = (await source.query("SELECT * FROM pricing_media_observations ORDER BY revision DESC"))[0];
      await source.createQueryBuilder().delete().from("pricing_adjustment_applications").execute();
      await source.createQueryBuilder().delete().from("pricing_cost_adjustments").execute();
      await expect(fresh().processActualMediaObservation("attempt", workspace, observation.id)).rejects.toThrow("lost its correction effect");
    }, 30_000);

    it.each(["audit", "processed-marker"])("rolls back attempt, closure and debit when the %s cannot commit", async failure => {
      await start();
      const original = await source.query("SELECT * FROM pricing_attempts");
      const builder = source.manager.createQueryBuilder();
      const prototype = Object.getPrototypeOf(failure === "audit" ? builder.insert() : builder.update());
      const execute = prototype.execute;
      const fault = jest.spyOn(prototype, "execute").mockImplementation(function (this: { expressionMap: { mainAlias?: { tablePath?: string }; valuesSet?: unknown } }) {
        const table = this.expressionMap.mainAlias?.tablePath;
        const values = JSON.stringify(this.expressionMap.valuesSet);
        if ((failure === "audit" && table === "pricing_audit_events" && values.includes("cost.actual_media_observation")) ||
          (failure === "processed-marker" && table === "pricing_media_observations" && values.includes('"processed":1')))
          throw new Error("Synthetic actual media acknowledgement failure");
        return execute.call(this);
      });
      await expect(tasks.accept("attempt", workspace, complete())).rejects.toThrow("actual media acknowledgement failure");
      fault.mockRestore();
      expect(await source.query("SELECT * FROM pricing_attempts")).toEqual(original);
      expect(await source.query("SELECT * FROM pricing_actual_budget_cohorts")).toHaveLength(0);
      expect(await source.query("SELECT * FROM pricing_budget_effects WHERE kind = 'commit'")).toHaveLength(0);
      expect((await source.query("SELECT * FROM pricing_media_observations"))[0]).toMatchObject({ action: "initial", processed: 0 });
      expect(await source.query("SELECT * FROM pricing_audit_events WHERE action = 'cost.actual_media_observation'")).toHaveLength(0);
      const restored = new MediaTaskService(source, prices, fresh(), config);
      try { await restored.process("attempt", workspace); } finally { await restored.onModuleDestroy(); }
      expect((await summary())?.budget_committed_usd).toBe("0.660000000000000000");
      expect((await task()).state).toBe("settled");
    }, 30_000);

    it("refuses cross-workspace observation application without effects", async () => {
      await start();
      await tasks.observe("attempt", workspace, complete());
      const before = await source.query("SELECT * FROM pricing_attempts");
      const observation = (await source.query("SELECT * FROM pricing_media_observations"))[0];
      await expect(ledger.processActualMediaObservation("attempt", "another-workspace", observation.id)).rejects.toThrow();
      expect(await source.query("SELECT * FROM pricing_attempts")).toEqual(before);
      expect(await source.query("SELECT * FROM pricing_actual_budget_cohorts")).toHaveLength(0);
    }, 30_000);

    it("uses the original held period when the current daily cost rule has already rolled over", async () => {
      await start();
      const rule = (await source.getRepository(BudgetRule).find())[0];
      await source.getRepository(BudgetRule).update(rule.id, { period_start: new Date(Date.now() + 86400000), current_value: 25 });
      await tasks.accept("attempt", workspace, complete());
      expect((await source.getRepository(BudgetRule).findOneByOrFail({ id: rule.id })).current_value).toBe(25);
      expect((await summary())?.budget_committed_usd).toBe("0.660000000000000000");
      expect((await task()).state).toBe("settled");
    }, 30_000);
  });
}

contract("SQLite actual media budget", async () => {
  const directory = mkdtempSync(join(tmpdir(), "actual-media-budget-"));
  const source = await new DataSource({ type: "better-sqlite3", database: join(directory, "media.db"), entities: [BudgetRule], synchronize: true }).initialize();
  await source.query("PRAGMA journal_mode=WAL");
  await source.query("PRAGMA synchronous=FULL");
  return { source, cleanup: async () => rmSync(directory, { recursive: true, force: true }) };
});
const pgUrl = process.env.SIFTGATE_PRICING_TEST_POSTGRES_URL;
if (pgUrl) {
  const url = new URL(pgUrl);
  if (url.hostname !== "127.0.0.1" || !/^\/pricing_goal_[a-z0-9_]+$/.test(url.pathname) || url.port === "2099") throw new Error("Use the isolated PostgreSQL test database");
}
contract("PostgreSQL actual media budget", async () => {
  if (!pgUrl) throw new Error("No isolated PostgreSQL URL");
  const schema = `actual_media_${process.pid}_${Math.random().toString(16).slice(2)}`;
  const admin = await new DataSource({ type: "postgres", url: pgUrl, synchronize: false }).initialize();
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const source = await new DataSource({ type: "postgres", url: pgUrl, schema, extra: { options: `-c search_path=${schema}` }, entities: [BudgetRule], synchronize: true }).initialize();
  return { source, cleanup: async () => { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.destroy(); } };
}, pgUrl ? describe : describe.skip);

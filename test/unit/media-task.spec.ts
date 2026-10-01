import type { NativeVideoResultProfile } from "../../src/pricing/video-result-profile.types";
import { MediaEventDispositionService } from "../../src/pricing/media-event-disposition.service";
import type { MediaEventDispositionPreview } from "../../src/pricing/media-event-disposition.types";
import { MediaJobLookupService } from "../../src/pricing/media-job-lookup.service";
import { createHmac } from "node:crypto";
import { MediaSupplierService } from "../../src/pricing/media-supplier.service";
import { mediaSupplierSigningInput } from "../../src/pricing/media-supplier-event";
import type {
  MediaSupplierEvent,
  MediaSupplierSource,
} from "../../src/pricing/media-supplier.types";
import { spawnSync } from "node:child_process";
import { DataSource } from "typeorm";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BudgetRule } from "../../src/database/entities/budget-rule.entity";
import { BudgetService } from "../../src/budget/budget.service";
import { WorkspaceContextService } from "../../src/workspaces/workspace-context.service";
import { DEFAULT_WORKSPACE_ID as workspace } from "../../src/workspaces/workspace.constants";
import { PricingRepository } from "../../src/pricing/pricing-repository";
import { CostLedgerService } from "../../src/pricing/cost-ledger.service";
import { MediaTaskService } from "../../src/pricing/media-task.service";
import type {
  MediaTaskContext,
  MediaTaskRow,
} from "../../src/pricing/media-task.types";
import {
  applyPricingSchema,
  PRICING_MIGRATIONS,
  planPricingSchema,
} from "../../src/pricing/pricing-schema";
import { MediaNormalizer } from "../../src/canonical/normalizers/media.normalizer";
import {
  mediaPricingContext,
  meterMediaUsage,
} from "../../src/pricing/media-metering";
import type { ConfigService } from "../../src/config/config.service";
import type { GatewayApiKeyContext } from "../../src/auth/gateway-api-key.service";
import type { NodeConfig } from "../../src/config/gateway.config";
import { book, rate } from "./pricing-fixtures";
import { mockConfigService } from "../helpers";

function contract(
  label: string,
  connect: () => Promise<{ source: DataSource; cleanup: () => Promise<void> }>,
  run = describe,
) {
  run(label, () => {
    let source: DataSource,
      cleanup: () => Promise<void>,
      prices: PricingRepository,
      ledger: CostLedgerService,
      tasks: MediaTaskService;
    let context: MediaTaskContext, config: ConfigService, node: NodeConfig;
    const target = {
      node_id: "test-node",
      model: "synthetic-video",
      operation: "video_generation",
    };
    const identity = {
      workspaceId: workspace,
      apiKeyId: "key-a",
      apiKeyName: "alpha",
      namespaceId: "namespace-a",
      teamId: null,
    };
    const canonical = new MediaNormalizer().normalize(
      { model: target.model, seconds: 8, prompt: "PRIVATE-PROMPT" },
      { "idempotency-key": "PRIVATE-IDEMPOTENCY-KEY" },
      "video_generation",
    );
    canonical.metadata.api_key_id = identity.apiKeyId;
    canonical.metadata.api_key_name = identity.apiKeyName;
    canonical.metadata.namespace_id = identity.namespaceId;
    const complete = (seconds = "6.4") => ({
      id: "provider-task",
      status: "completed",
      usage: { video_seconds: seconds, generation_count: 1 },
    });
    const row = async () => (await tasks.get("attempt-a", workspace))!;
    const result = () => ledger.summary("request-a", workspace);
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
        }),
      );
      ledger = new CostLedgerService(
        source,
        new BudgetService(
          mockConfigService(),
          new WorkspaceContextService(),
          rules,
        ),
      );
      prices = new PricingRepository(source);
      node = {
        id: target.node_id,
        name: "test",
        protocol: "chat_completions",
        base_url: "http://synthetic.test",
        endpoint: "/generate",
        timeout_ms: 1000,
        models: [],
        api_key: "synthetic-secret",
        video_status_endpoint: "/jobs/:id",
        video_content_endpoint: "/jobs/:id/content",
        video_cancel_endpoint: "/jobs/:id/cancel",
      };
      config = {
        getNode: (id: string) => (id === node.id ? node : undefined),
      } as ConfigService;
      tasks = new MediaTaskService(source, prices, ledger, config);
      const actor = {
        id: "operator",
        workspace_id: workspace,
        role: "admin" as const,
        global_admin: true,
      };
      const content = {
        ...book([
          rate("seconds", "video_seconds", "0.10", "1"),
          rate("base", "video_generation_count", "0.02", "1"),
        ]),
        allow_combined_media: true,
      };
      const created = await prices.createBook(actor, {
        name: "synthetic",
        scope: "workspace",
        content,
      });
      await prices.publishDraft(actor, created.draft.id, {
        draft_revision: 1,
        catalog_revision: 0,
        reason: "isolated test",
        confirm: true,
        targets: [
          { level: "model", model: target.model, operation: target.operation },
        ],
      });
      await prices.capture({
        request_id: "request-a",
        workspace_id: workspace,
        report_currency: "USD",
      });
      context = {
        target,
        identity,
        operation: "video_generation",
        pricing: {
          ...mediaPricingContext(canonical),
          attempt_dispatched_at: new Date().toISOString(),
        },
        request_usage: meterMediaUsage(canonical, undefined, "result"),
        legacy_price: null,
        legacy_version: 1,
        logical_tokens: "0",
        fallback_cost_usd: "0.82",
      };
    });
    afterEach(async () => {
      jest.restoreAllMocks();
      await tasks?.onModuleDestroy();
      if (source?.isInitialized) await source.destroy();
      await cleanup?.();
    });
    async function start(clientKey: string | null = null, credential?: string) {
      const snapshot = await prices.restoreRequest("request-a", workspace);
      await ledger.reserve({
        id: "reservation-a",
        requestId: "request-a",
        identity,
        target,
        estimate: snapshot.quote(
          target,
          meterMediaUsage(canonical, undefined, "estimate"),
        ).cost,
        tokens: "0",
        costUsd: "0.82",
        budgetBasis: "legacy_logical",
        leaseOwner: "fixture-owner",
        leaseUntil: new Date(Date.now() + 60000).toISOString(),
      });
      const descriptor = tasks.descriptor(
        "attempt-a",
        "request-a",
        "reservation-a",
        context,
        clientKey,
      );
      const attempt = {
        id: "attempt-a",
        requestId: "request-a",
        workspace,
        reservationId: "reservation-a",
        target,
        feeSource: "provider" as const,
        dispatchedAt: new Date().toISOString(),
        priceContext: {
          context: context.pricing,
          legacyPrice: null,
          ...(credential
            ? {
                dispatch: {
                  node_id: node.id,
                  wire_model: target.model,
                  credential_id: credential,
                  credential_strategy: "fixture",
                  credential_retry_index: 0,
                  compatibility_retry_index: 0,
                  dispatch_index: 1,
                  protocol: node.protocol,
                  dispatched_at: new Date().toISOString(),
                  invocation_id: "invocation-a",
                  requested_model: target.model,
                  route_model: target.model,
                },
              }
            : {}),
        },
        mediaTask: descriptor,
      };
      await ledger.beginAttempt(attempt);
      await tasks.markSubmitted("attempt-a", workspace);
      return attempt;
    }

    const secretName = "SIFTGATE_MEDIA_EVENT_UNIT",
      signingKey = "synthetic-media-event-secret-not-production";
    let previousSecret: string | undefined;
    beforeEach(() => {
      previousSecret = process.env[secretName];
      process.env[secretName] = signingKey;
    });
    afterEach(() => {
      if (previousSecret === undefined) delete process.env[secretName];
      else process.env[secretName] = previousSecret;
    });
    const supplierActor = {
      id: "admin",
      workspace_id: workspace,
      role: "admin" as const,
      global_admin: false,
    };
    const sourceOptions = {
      revision: 0,
      node_id: "test-node",
      credential_id: "default",
      secret_env: secretName,
      enabled: true,
      reason: "Synthetic signed media integration",
      confirm: true,
    };
    const service = () =>
      new MediaSupplierService(source, config, tasks, ledger);
    async function supplierStart() {
      await start(null, "default");
      await service().configure(supplierActor, "signed-source", sourceOptions);
      return service();
    }
    const supplierEvent = (
      sequence = "1",
      seconds = "6.4",
    ): MediaSupplierEvent => ({
      schema_version: 1,
      event_id: `event-${sequence}`,
      task_id: "attempt-a",
      provider_job_id: "provider-task",
      sequence,
      status: "completed",
      accepted_at: context.pricing.attempt_dispatched_at!,
      completed_at: new Date().toISOString(),
      time_quality: "observed",
      evidence: [
        { dimension: "video_seconds", value: seconds, quality: "observed" },
        {
          dimension: "video_generation_count",
          value: "1",
          quality: "observed",
        },
      ],
    });
    function signature(
      event: MediaSupplierEvent,
      revision = "1",
      sourceId = "signed-source",
    ) {
      const timestamp = String(Math.floor(Date.now() / 1000));
      return {
        timestamp,
        revision,
        signature:
          "v1=" +
          createHmac("sha256", signingKey)
            .update(
              mediaSupplierSigningInput(sourceId, revision, timestamp, event),
            )
            .digest("hex"),
      };
    }
    const send = (svc: MediaSupplierService, event: MediaSupplierEvent) =>
      svc.receive("signed-source", event, signature(event));

    it("recovers a signed unknown-job submission using the original dispatch identity and immutable price", async () => {
      const svc = await supplierStart();
      await tasks.markUncertain("attempt-a", workspace);
      const fetch = jest.spyOn(globalThis, "fetch");
      const event = supplierEvent();
      const accepted = await send(svc, event);
      expect(accepted).toMatchObject({
        decision: "applied",
        origin: "authenticated_connector",
        supplier_invoice_confirmed: false,
        processing_pending: false,
      });
      expect(await row()).toMatchObject({
        state: "settled",
        provider_job_id: "provider-task",
        credential_id: "default",
      });
      expect((await result())?.amount).toBe("0.660000000000000000");
      await tasks.markUncertain("attempt-a", workspace);
      expect((await row()).state).toBe("settled");
      expect(fetch).not.toHaveBeenCalled();
      expect(
        (await svc.events(supplierActor, "attempt-a")).events,
      ).toHaveLength(1);
    });
    it("replays the same event exactly and rejects same-ID content substitution", async () => {
      const svc = await supplierStart(),
        event = supplierEvent();
      await send(svc, event);
      const before = await source.query("SELECT * FROM pricing_attempts");
      expect(await send(svc, event)).toMatchObject({ replayed: true });
      await expect(
        send(svc, {
          ...event,
          evidence: [
            { dimension: "video_seconds", value: "9", quality: "observed" },
          ],
        }),
      ).rejects.toThrow("reused");
      expect(await source.query("SELECT * FROM pricing_attempts")).toEqual(
        before,
      );
      expect(
        await source.query("SELECT * FROM pricing_media_supplier_events"),
      ).toHaveLength(1);
    });
    it("ignores old sequence numbers, quarantines same-sequence disagreements, and applies newer corrections", async () => {
      const svc = await supplierStart(),
        newer = supplierEvent("20", "7.4");
      await send(svc, newer);
      const before = await source.query("SELECT * FROM pricing_attempts");
      expect(await send(svc, supplierEvent("10", "6.4"))).toMatchObject({
        decision: "ignored_stale",
      });
      expect(
        await send(svc, {
          ...newer,
          event_id: "same-sequence-disagreement",
          evidence: supplierEvent("20", "9").evidence,
        }),
      ).toMatchObject({ decision: "review_required" });
      expect((await result())?.amount).toBe("0.760000000000000000");
      await send(svc, supplierEvent("21", "8.4"));
      expect((await result())?.amount).toBe("0.860000000000000000");
      expect(await source.query("SELECT * FROM pricing_attempts")).toEqual(
        before,
      );
      expect(
        await source.query("SELECT * FROM pricing_cost_adjustments"),
      ).toHaveLength(1);
    });
    it("does not regress a terminal task to pending even when the pending sequence is newer", async () => {
      const svc = await supplierStart();
      await send(svc, supplierEvent("1"));
      expect(
        await send(svc, {
          ...supplierEvent("3"),
          status: "pending",
          completed_at: null,
          evidence: [],
        }),
      ).toMatchObject({ decision: "ignored_regression" });
      expect(await send(svc, supplierEvent("2", "9"))).toMatchObject({
        decision: "ignored_stale",
      });
      expect((await row()).state).toBe("settled");
      expect((await result())?.amount).toBe("0.660000000000000000");
    });
    it("retains unordered polling alternatives without undoing an authenticated sequenced receipt", async () => {
      const svc = await supplierStart();
      await send(svc, supplierEvent("1", "7.4"));
      await tasks.accept("attempt-a", workspace, complete("6.4"));
      await tasks.accept("attempt-a", workspace, complete("6.4"));
      expect((await result())?.amount).toBe("0.760000000000000000");
      const events = await source.query(
        "SELECT * FROM pricing_media_supplier_events",
      );
      expect(events).toHaveLength(2);
      expect(
        events.find(
          (r: { origin: string }) => r.origin === "unversioned_observation",
        ),
      ).toMatchObject({ decision: "review_required" });
    });
    it("rechecks source revision and pinned credential and does not allow anonymous or cross-scope receipts", async () => {
      const svc = await supplierStart(),
        event = supplierEvent();
      await expect(
        svc.receive("signed-source", event, {
          ...signature(event),
          signature: "v1=" + "0".repeat(64),
        }),
      ).rejects.toThrow("authentication");
      await expect(
        send(svc, { ...event, task_id: "other-workspace-task" }),
      ).rejects.toThrow("workspace");
      const original = (await svc.sources(supplierActor))
        .sources[0] as MediaSupplierSource;
      await svc.configure(supplierActor, "signed-source", {
        ...sourceOptions,
        revision: 1,
        enabled: false,
      });
      await expect(tasks.receiveSupplierEvent(original, event)).rejects.toThrow(
        "changed",
      );
      await expect(send(svc, event)).rejects.toThrow("authentication");
      expect((await row()).provider_job_id).toBeNull();
    });
    it("rejects unverified dispatch credentials and synchronous ownership", async () => {
      await start();
      const svc = service();
      await svc.configure(supplierActor, "signed-source", sourceOptions);
      await expect(send(svc, supplierEvent())).rejects.toThrow("credential");
      await tasks.accept(
        "attempt-a",
        workspace,
        { id: "provider-task", status: "pending" },
        "default",
      );
      await tasks.markSynchronous("attempt-a", workspace);
      await expect(send(svc, supplierEvent())).rejects.toThrow("asynchronous");
    });
    it("rolls back observation, source head and receipt if a required media-event audit fails", async () => {
      const svc = await supplierStart(),
        create = source.manager.createQueryBuilder.bind(source.manager);
      const prototype = Object.getPrototypeOf(create().insert());
      const execute = prototype.execute;
      const spy = jest
        .spyOn(prototype, "execute")
        .mockImplementation(function (this: {
          expressionMap: {
            mainAlias?: { tablePath?: string };
            valuesSet?: unknown;
          };
        }) {
          if (
            this.expressionMap.mainAlias?.tablePath ===
              "pricing_audit_events" &&
            JSON.stringify(this.expressionMap.valuesSet).includes(
              "media.event_retained",
            )
          )
            throw new Error("event audit failed");
          return execute.call(this);
        });
      await expect(send(svc, supplierEvent())).rejects.toThrow(
        "event audit failed",
      );
      spy.mockRestore();
      expect(
        await source.query("SELECT * FROM pricing_media_supplier_events"),
      ).toHaveLength(0);
      expect(
        await source.query("SELECT * FROM pricing_media_observations"),
      ).toHaveLength(0);
      expect((await row()).provider_job_id).toBeNull();
    });
    it("preserves durable receipt custody across financial failure and resumes without another generation", async () => {
      const svc = await supplierStart(),
        event = supplierEvent();
      const fail = jest
        .spyOn(ledger, "settle")
        .mockRejectedValueOnce(new Error("synthetic storage unavailable"));
      expect(await send(svc, event)).toMatchObject({
        processing_pending: true,
      });
      fail.mockRestore();
      expect(
        await source.query("SELECT * FROM pricing_media_supplier_events"),
      ).toHaveLength(1);
      const restored = new MediaTaskService(source, prices, ledger, config);
      await restored.process("attempt-a", workspace);
      await restored.onModuleDestroy();
      expect((await result())?.budget_committed_usd).toBe(
        "0.660000000000000000",
      );
      expect(await send(svc, event)).toMatchObject({
        replayed: true,
        processing_pending: false,
      });
    });
    it("uses exact large sequence strings and keeps unknown charges distinct from free", async () => {
      const svc = await supplierStart();
      const missing = {
        ...supplierEvent("900719925474099312345"),
        evidence: [],
      };
      await send(svc, missing);
      expect((await result())?.amount).toBeNull();
      await send(svc, {
        ...supplierEvent("900719925474099312346", "0"),
        evidence: [
          { dimension: "video_seconds", value: "0", quality: "observed" },
          {
            dimension: "video_generation_count",
            value: "0",
            quality: "observed",
          },
        ],
      });
      expect((await result())?.amount).toBe("0.000000000000000000");
    });
    it("detects a missing ordering head rather than returning to unversioned automatic settlement", async () => {
      const svc = await supplierStart();
      await send(svc, supplierEvent());
      await source.query("DELETE FROM pricing_media_event_heads");
      await expect(
        tasks.accept("attempt-a", workspace, complete("9.4")),
      ).rejects.toThrow("head is missing");
      expect((await result())?.amount).toBe("0.660000000000000000");
    });
    it("configuration is scope/revision guarded and never persists signing key values", async () => {
      const svc = service();
      await expect(
        svc.configure(
          { ...supplierActor, role: "viewer" },
          "signed-source",
          sourceOptions,
        ),
      ).rejects.toThrow("administrator");
      await svc.configure(supplierActor, "signed-source", sourceOptions);
      await expect(
        svc.configure(supplierActor, "signed-source", sourceOptions),
      ).rejects.toThrow("revision");
      await expect(
        svc.configure(supplierActor, "signed-source", {
          ...sourceOptions,
          revision: 1,
          credential_id: "other",
        }),
      ).rejects.toThrow("retarget");
      const serialized =
        JSON.stringify(
          await source.query("SELECT * FROM pricing_media_event_sources"),
        ) +
        JSON.stringify(
          await source.query("SELECT * FROM pricing_audit_events"),
        );
      expect(serialized).not.toContain(signingKey);
      expect(
        (await svc.sources({ ...supplierActor, workspace_id: "other" }))
          .sources,
      ).toEqual([]);
    });

    it("keeps one financial result under concurrent signed event delivery from two service instances", async () => {
      const svc = await supplierStart(),
        event = supplierEvent();
      const secondTasks = new MediaTaskService(source, prices, ledger, config),
        second = new MediaSupplierService(source, config, secondTasks, ledger);
      const replies = await Promise.all([
        send(svc, event),
        send(second, event),
      ]);
      expect(replies.some((r) => r.replayed)).toBe(true);
      await tasks.process("attempt-a", workspace);
      expect((await result())?.budget_committed_usd).toBe(
        "0.660000000000000000",
      );
      expect(
        await source.query("SELECT * FROM pricing_media_supplier_events"),
      ).toHaveLength(1);
      expect(
        await source.query("SELECT * FROM pricing_settlement_intents"),
      ).toHaveLength(1);
      await secondTasks.onModuleDestroy();
    });
    it("retains original source authorization across signing-key configuration revisions", async () => {
      const svc = await supplierStart(),
        event = supplierEvent();
      await send(svc, event);
      await svc.configure(supplierActor, "signed-source", {
        ...sourceOptions,
        revision: 1,
      });
      expect(
        (await svc.events(supplierActor, "attempt-a")).events[0],
      ).toMatchObject({ source_revision: 1 });
      await expect(send(svc, event)).rejects.toThrow("authentication");
      expect(
        await svc.receive("signed-source", event, signature(event, "2")),
      ).toMatchObject({ replayed: true, source_revision: 1 });
    });
    it("keeps ordered pending work asynchronous and cannot be overridden by late synchronous completion", async () => {
      const svc = await supplierStart();
      await send(svc, {
        ...supplierEvent("1"),
        status: "pending",
        completed_at: null,
        evidence: [],
      });
      await tasks.markSynchronous("attempt-a", workspace);
      expect((await row()).state).toBe("pending");
      await tasks.accept("attempt-a", workspace, complete());
      expect((await result())?.amount).toBeNull();
      await send(svc, supplierEvent("2"));
      expect((await result())?.amount).toBe("0.660000000000000000");
    });
    it("refuses another source taking over an already ordered task", async () => {
      const svc = await supplierStart();
      await send(svc, supplierEvent());
      await svc.configure(supplierActor, "other-source", sourceOptions);
      const event = supplierEvent("2");
      await expect(
        svc.receive(
          "other-source",
          event,
          signature(event, "1", "other-source"),
        ),
      ).rejects.toThrow("different ordered evidence source");
      expect(
        await source.query("SELECT * FROM pricing_media_supplier_events"),
      ).toHaveLength(1);
    });
    it("survives an actual process exit after authenticated receipt custody but before financial processing", async () => {
      await supplierStart();
      const event = supplierEvent();
      const child = spawnSync(
        process.execPath,
        [
          "-r",
          "ts-node/register",
          "-e",
          `
        const {DataSource}=require('typeorm'),{BudgetRule}=require('./src/database/entities/budget-rule.entity'),{BudgetService}=require('./src/budget/budget.service'),{WorkspaceContextService}=require('./src/workspaces/workspace-context.service'),{CostLedgerService}=require('./src/pricing/cost-ledger.service'),{PricingRepository}=require('./src/pricing/pricing-repository'),{MediaTaskService}=require('./src/pricing/media-task.service'),{MediaSupplierService}=require('./src/pricing/media-supplier.service');
        (async()=>{const db=await new DataSource({...JSON.parse(process.env.SUPPLIER_CHILD_DB),entities:[BudgetRule],synchronize:false}).initialize();const ledger=new CostLedgerService(db,new BudgetService({},new WorkspaceContextService(),db.getRepository(BudgetRule))),prices=new PricingRepository(db),config={getNode:()=>JSON.parse(process.env.SUPPLIER_CHILD_NODE)},tasks=new MediaTaskService(db,prices,ledger,config);tasks.process=async()=>process.exit(17);const svc=new MediaSupplierService(db,config,tasks,ledger);await svc.receive('signed-source',JSON.parse(process.env.SUPPLIER_CHILD_EVENT),JSON.parse(process.env.SUPPLIER_CHILD_AUTH));process.exit(19)})().catch(e=>{process.stderr.write(e.stack);process.exit(18)});
      `,
        ],
        {
          cwd: process.cwd(),
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            TMPDIR: process.env.TMPDIR,
            NODE_OPTIONS: "--max-old-space-size=512",
            TS_NODE_TRANSPILE_ONLY: "true",
            SIFTGATE_MEDIA_EVENT_UNIT: signingKey,
            SUPPLIER_CHILD_DB: JSON.stringify(source.options),
            SUPPLIER_CHILD_NODE: JSON.stringify(node),
            SUPPLIER_CHILD_EVENT: JSON.stringify(event),
            SUPPLIER_CHILD_AUTH: JSON.stringify(signature(event)),
          },
          encoding: "utf8",
          timeout: 20000,
        },
      );
      expect({
        status: child.status,
        error: child.error?.message,
        stderr: child.stderr,
      }).toEqual({ status: 17, error: undefined, stderr: "" });
      expect(
        await source.query("SELECT * FROM pricing_media_supplier_events"),
      ).toHaveLength(1);
      expect((await row()).state).toBe("terminal");
      await tasks.process("attempt-a", workspace);
      expect((await result())?.budget_committed_usd).toBe(
        "0.660000000000000000",
      );
      expect(await send(service(), event)).toMatchObject({ replayed: true });
    });

    const lookups = () => new MediaJobLookupService(tasks, prices);
    async function unknown() {
      await start(null, "default");
      await tasks.markUncertain("attempt-a", workspace);
      return lookups();
    }
    const lookupPayload = (
      preview: Awaited<ReturnType<MediaJobLookupService["preview"]>>,
      id = "lookup-a",
    ) => ({
      id,
      provider_job_id: "provider-task",
      expected_basis_hash: preview.basis_hash,
      expected_observation_hash: preview.observation_hash,
      expected_cost_hash: preview.cost_hash,
      reason: "Administrator verified supplier job association",
      confirm: true,
    });
    const lookupTables = [
      "pricing_media_tasks",
      "pricing_media_observations",
      "pricing_media_job_reconciliations",
      "pricing_attempts",
      "pricing_reservations",
      "pricing_settlement_intents",
      "pricing_cost_adjustments",
      "pricing_audit_events",
    ];
    const lookupDump = async () => {
      const rows: Record<string, unknown> = {};
      for (const table of lookupTables)
        rows[table] = await source.query(`SELECT * FROM ${table}`);
      return rows;
    };
    const lookupFetch = (value: unknown = complete()) =>
      jest.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify(value), {
          headers: { "content-type": "application/json" },
        }),
      );
    async function previewLookup(svc: MediaJobLookupService) {
      const basis = await svc.basis(supplierActor, "attempt-a");
      return svc.preview(supplierActor, "attempt-a", {
        provider_job_id: "provider-task",
        expected_basis_hash: basis.basis_hash,
      });
    }

    it("previews a pinned authenticated job lookup without database writes or invented provider timestamps", async () => {
      const svc = await unknown(),
        before = await lookupDump(),
        fetch = lookupFetch();
      const preview = await previewLookup(svc);
      expect(await lookupDump()).toEqual(before);
      expect(preview).toMatchObject({
        dry_run: true,
        association_source: "administrator_attestation",
        supplier_invoice_confirmed: false,
        time_note: "unknown_provider_instants_not_invented",
      });
      expect(preview.observation.context.provider_accepted_at).toBeUndefined();
      expect(preview.observation.context.completed_at).toBeUndefined();
      expect(preview.cost.report_amount).toBe("0.660000000");
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch.mock.calls[0][0]).toBe(
        "http://synthetic.test/jobs/provider-task",
      );
      expect(fetch.mock.calls[0][1]).toMatchObject({
        method: "GET",
        headers: { Authorization: "Bearer synthetic-secret" },
        redirect: "error",
      });
    });
    it("applies the reviewed lookup once under original prices and returns exact retries without another provider call", async () => {
      const svc = await unknown();
      const fetch = jest
        .spyOn(globalThis, "fetch")
        .mockImplementation(
          async () => new Response(JSON.stringify(complete())),
        );
      const preview = await previewLookup(svc),
        input = lookupPayload(preview);
      const response = await svc.apply(supplierActor, "attempt-a", input);
      expect(response).toMatchObject({
        replayed: false,
        processing_pending: false,
      });
      expect(await row()).toMatchObject({
        provider_job_id: "provider-task",
        credential_id: "default",
        state: "settled",
      });
      expect((await result())?.amount).toBe("0.660000000000000000");
      const calls = fetch.mock.calls.length;
      expect(await svc.apply(supplierActor, "attempt-a", input)).toMatchObject({
        replayed: true,
        processing_pending: false,
      });
      expect(fetch).toHaveBeenCalledTimes(calls);
      expect(
        await svc.status(supplierActor, "attempt-a", input.id),
      ).toMatchObject({ record_hash: response.record_hash });
      expect(
        await source.query("SELECT * FROM pricing_media_job_reconciliations"),
      ).toHaveLength(1);
      await expect(
        svc.apply(supplierActor, "attempt-a", { ...input, reason: "changed" }),
      ).rejects.toThrow("reused");
    });
    it("refuses provider evidence that changes between preview and apply without linking the task", async () => {
      const svc = await unknown();
      const fetch = lookupFetch();
      const preview = await previewLookup(svc),
        before = await lookupDump();
      fetch.mockResolvedValueOnce(
        new Response(JSON.stringify(complete("8.4"))),
      );
      await expect(
        svc.apply(supplierActor, "attempt-a", lookupPayload(preview)),
      ).rejects.toThrow("changed after preview");
      expect(await lookupDump()).toEqual(before);
    });
    it("refuses response job-ID substitution, missing IDs, URLs and path traversal without trusting provider payloads", async () => {
      const svc = await unknown(),
        basis = await svc.basis(supplierActor, "attempt-a"),
        fetch = lookupFetch({ ...complete(), id: "other-job" });
      const request = {
        provider_job_id: "provider-task",
        expected_basis_hash: basis.basis_hash,
      };
      await expect(
        svc.preview(supplierActor, "attempt-a", request),
      ).rejects.toThrow("identify");
      fetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: "completed",
            usage: { video_seconds: "6.4" },
          }),
        ),
      );
      await expect(
        svc.preview(supplierActor, "attempt-a", request),
      ).rejects.toThrow("identify");
      const count = fetch.mock.calls.length;
      for (const id of [
        "..",
        "a/../b",
        "https://untrusted.example/job",
        "sk-private",
      ])
        await expect(
          svc.preview(supplierActor, "attempt-a", {
            ...request,
            provider_job_id: id,
          }),
        ).rejects.toThrow();
      expect(fetch).toHaveBeenCalledTimes(count);
    });
    it("locks job lookup to uncertain tasks and the original physical credential rather than an administrator-selected account", async () => {
      await start();
      await tasks.markUncertain("attempt-a", workspace);
      const svc = lookups(),
        basis = await svc.basis(supplierActor, "attempt-a"),
        fetch = lookupFetch();
      expect(basis.blocked_reason).toBe("dispatch_credential_unverified");
      await expect(
        svc.preview(supplierActor, "attempt-a", {
          provider_job_id: "provider-task",
          expected_basis_hash: basis.basis_hash,
        }),
      ).rejects.toThrow("cannot be linked");
      expect(fetch).not.toHaveBeenCalled();
      await expect(
        svc.basis({ ...supplierActor, workspace_id: "other" }, "attempt-a"),
      ).rejects.toThrow("workspace");
      await expect(
        svc.preview({ ...supplierActor, role: "viewer" }, "attempt-a", {}),
      ).rejects.toThrow("administrator");
    });
    it("detects a changed node connection before lookup or application and sends no request to a replacement node", async () => {
      const svc = await unknown(),
        basis = await svc.basis(supplierActor, "attempt-a"),
        fetch = lookupFetch();
      node.base_url = "http://different.test";
      await expect(
        svc.preview(supplierActor, "attempt-a", {
          provider_job_id: "provider-task",
          expected_basis_hash: basis.basis_hash,
        }),
      ).rejects.toThrow("configuration changed");
      expect(fetch).not.toHaveBeenCalled();
    });
    it("refuses a changed task basis after external lookup without holding a transaction across network IO", async () => {
      const svc = await unknown(),
        basis = await svc.basis(supplierActor, "attempt-a");
      jest.spyOn(globalThis, "fetch").mockImplementation(async () => {
        await tasks.accept(
          "attempt-a",
          workspace,
          { id: "concurrent-job", status: "pending" },
          "default",
        );
        return new Response(JSON.stringify(complete()));
      });
      await expect(
        svc.preview(supplierActor, "attempt-a", {
          provider_job_id: "provider-task",
          expected_basis_hash: basis.basis_hash,
        }),
      ).rejects.toThrow("changed during");
      expect((await row()).provider_job_id).toBe("concurrent-job");
      expect(
        await source.query("SELECT * FROM pricing_media_job_reconciliations"),
      ).toHaveLength(0);
    });
    it("requires the exact reviewed cost hash and preserves all original records on failed confirmation", async () => {
      const svc = await unknown();
      jest
        .spyOn(globalThis, "fetch")
        .mockImplementation(
          async () => new Response(JSON.stringify(complete())),
        );
      const preview = await previewLookup(svc),
        before = await lookupDump();
      await expect(
        svc.apply(supplierActor, "attempt-a", {
          ...lookupPayload(preview),
          expected_cost_hash: "f".repeat(64),
        }),
      ).rejects.toThrow("changed after");
      expect(await lookupDump()).toEqual(before);
      await expect(
        svc.apply(supplierActor, "attempt-a", {
          ...lookupPayload(preview),
          confirm: false,
        }),
      ).rejects.toThrow();
    });
    it("rolls back job association and observation when the required reconciliation audit fails", async () => {
      const svc = await unknown();
      jest
        .spyOn(globalThis, "fetch")
        .mockImplementation(
          async () => new Response(JSON.stringify(complete())),
        );
      const preview = await previewLookup(svc),
        before = await lookupDump(),
        prototype = Object.getPrototypeOf(
          source.manager.createQueryBuilder().insert(),
        ),
        execute = prototype.execute;
      const spy = jest
        .spyOn(prototype, "execute")
        .mockImplementation(function (this: {
          expressionMap: {
            mainAlias?: { tablePath?: string };
            valuesSet?: unknown;
          };
        }) {
          if (
            this.expressionMap.mainAlias?.tablePath ===
              "pricing_audit_events" &&
            JSON.stringify(this.expressionMap.valuesSet).includes(
              "media.job_reconciled",
            )
          )
            throw new Error("lookup audit failed");
          return execute.call(this);
        });
      await expect(
        svc.apply(supplierActor, "attempt-a", lookupPayload(preview)),
      ).rejects.toThrow("lookup audit failed");
      spy.mockRestore();
      expect(await lookupDump()).toEqual(before);
    });
    it("preserves lookup custody across failed financial processing and resumes with the same operation ID", async () => {
      const svc = await unknown();
      const fetch = jest
        .spyOn(globalThis, "fetch")
        .mockImplementation(
          async () => new Response(JSON.stringify(complete())),
        );
      const preview = await previewLookup(svc),
        input = lookupPayload(preview),
        fail = jest
          .spyOn(ledger, "settle")
          .mockRejectedValueOnce(new Error("storage unavailable"));
      expect(await svc.apply(supplierActor, "attempt-a", input)).toMatchObject({
        processing_pending: true,
      });
      fail.mockRestore();
      const calls = fetch.mock.calls.length;
      expect(await svc.apply(supplierActor, "attempt-a", input)).toMatchObject({
        replayed: true,
        processing_pending: false,
      });
      expect(fetch).toHaveBeenCalledTimes(calls);
      expect((await result())?.budget_committed_usd).toBe(
        "0.660000000000000000",
      );
    });
    it("detects altered reconciliation receipts instead of accepting a false retry acknowledgement", async () => {
      const svc = await unknown();
      jest
        .spyOn(globalThis, "fetch")
        .mockImplementation(
          async () => new Response(JSON.stringify(complete())),
        );
      const preview = await previewLookup(svc);
      await svc.apply(supplierActor, "attempt-a", lookupPayload(preview));
      await source.manager
        .createQueryBuilder()
        .update("pricing_media_job_reconciliations")
        .set({ cost_hash: "f".repeat(64) })
        .execute();
      await expect(
        svc.status(supplierActor, "attempt-a", "lookup-a"),
      ).rejects.toThrow("inconsistent");
    });
    it("leaves a linked pending job reserved for ordinary status recovery instead of prematurely settling", async () => {
      const svc = await unknown();
      jest
        .spyOn(globalThis, "fetch")
        .mockImplementation(
          async () =>
            new Response(
              JSON.stringify({ id: "provider-task", status: "pending" }),
            ),
        );
      const preview = await previewLookup(svc);
      await svc.apply(supplierActor, "attempt-a", lookupPayload(preview));
      expect(await row()).toMatchObject({
        state: "pending",
        provider_job_id: "provider-task",
      });
      expect((await result())?.budget_reserved_usd).toBe(
        "0.820000000000000000",
      );
      expect(
        await source.query("SELECT * FROM pricing_settlement_intents"),
      ).toHaveLength(0);
    });
    it("paginates source and event inventory with exact workspace/type-bound cursors and no skipped rows", async () => {
      const svc = await supplierStart();
      for (let i = 0; i < 4; i++)
        await svc.configure(supplierActor, `extra-source-${i}`, sourceOptions);
      const names: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await svc.sources(supplierActor, { limit: 2, cursor });
        names.push(...page.sources.map((s) => s!.id));
        cursor = page.next_cursor ?? undefined;
      } while (cursor);
      expect(new Set(names).size).toBe(5);
      for (let i = 0; i < 5; i++) await send(svc, supplierEvent(String(i)));
      const first = await svc.events(supplierActor, "attempt-a", { limit: 2 });
      expect(first.events).toHaveLength(2);
      expect(first.next_cursor).not.toBeNull();
      const second = await svc.events(supplierActor, "attempt-a", {
        limit: 2,
        cursor: first.next_cursor!,
      });
      expect(second.events).toHaveLength(2);
      expect(
        second.events.some((e) => first.events.some((f) => f.id === e.id)),
      ).toBe(false);
      await expect(
        svc.events({ ...supplierActor, workspace_id: "other" }, "attempt-a", {
          limit: 2,
          cursor: first.next_cursor!,
        }),
      ).rejects.toThrow("cursor");
      await expect(
        svc.sources(supplierActor, { limit: 2, cursor: first.next_cursor! }),
      ).rejects.toThrow("cursor");
      const detail = await svc.event(
        supplierActor,
        "attempt-a",
        first.events[0].id,
      );
      expect(detail.document).toBeTruthy();
      await expect(
        svc.event(
          { ...supplierActor, workspace_id: "other" },
          "attempt-a",
          first.events[0].id,
        ),
      ).rejects.toThrow("workspace");
    });
    it("lists only scoped persisted media tasks with status and review filtering, without exposing raw contexts", async () => {
      const svc = await supplierStart();
      await tasks.markUncertain("attempt-a", workspace);
      const inventory = await svc.inventory(supplierActor, {
        view: "uncertain",
        limit: 2,
      });
      expect(inventory.tasks).toHaveLength(1);
      expect(JSON.stringify(inventory)).not.toMatch(
        /context_json|PRIVATE-PROMPT|synthetic-secret/,
      );
      expect(
        (
          await svc.inventory(
            { ...supplierActor, workspace_id: "other" },
            { view: "all", limit: 2 },
          )
        ).tasks,
      ).toEqual([]);
      await send(svc, supplierEvent());
      await tasks.accept("attempt-a", workspace, complete("9.4"));
      expect(
        (
          await svc.inventory(supplierActor, {
            view: "review_required",
            limit: 2,
          })
        ).tasks,
      ).toHaveLength(1);
      expect(
        (await svc.detail(supplierActor, "attempt-a")).ledger?.amount,
      ).toBe("0.660000000000000000");
    });

    it("accepts only one lookup under concurrent independent connections and acknowledges the winning exact proposal", async () => {
      const svc = await unknown();
      jest
        .spyOn(globalThis, "fetch")
        .mockImplementation(
          async () => new Response(JSON.stringify(complete())),
        );
      const preview = await previewLookup(svc),
        input = lookupPayload(preview);
      const secondSource = await new DataSource({
        ...source.options,
        entities: [BudgetRule],
        synchronize: false,
      }).initialize();
      try {
        const secondLedger = new CostLedgerService(
            secondSource,
            new BudgetService(
              mockConfigService(),
              new WorkspaceContextService(),
              secondSource.getRepository(BudgetRule),
            ),
          ),
          secondPrices = new PricingRepository(secondSource),
          secondTasks = new MediaTaskService(
            secondSource,
            secondPrices,
            secondLedger,
            config,
          ),
          other = new MediaJobLookupService(secondTasks, secondPrices);
        const results = await Promise.allSettled([
          svc.apply(supplierActor, "attempt-a", input),
          other.apply(supplierActor, "attempt-a", input),
        ]);
        expect(results.some((r) => r.status === "fulfilled")).toBe(true);
        await expect(
          other.apply(supplierActor, "attempt-a", input),
        ).resolves.toMatchObject({ replayed: true });
        expect(
          await source.query("SELECT * FROM pricing_media_job_reconciliations"),
        ).toHaveLength(1);
        expect((await result())?.budget_committed_usd).toBe(
          "0.660000000000000000",
        );
        await secondTasks.onModuleDestroy();
      } finally {
        await secondSource.destroy();
      }
    });
    it("survives a process exit after lookup association commit and resumes by durable acknowledgement without fetching again", async () => {
      const svc = await unknown();
      const fetch = lookupFetch();
      const preview = await previewLookup(svc),
        input = lookupPayload(preview);
      fetch.mockRestore();
      const child = spawnSync(
        process.execPath,
        [
          "-r",
          "ts-node/register",
          "-e",
          `
        const {DataSource}=require('typeorm'),{BudgetRule}=require('./src/database/entities/budget-rule.entity'),{BudgetService}=require('./src/budget/budget.service'),{WorkspaceContextService}=require('./src/workspaces/workspace-context.service'),{CostLedgerService}=require('./src/pricing/cost-ledger.service'),{PricingRepository}=require('./src/pricing/pricing-repository'),{MediaTaskService}=require('./src/pricing/media-task.service'),{MediaJobLookupService}=require('./src/pricing/media-job-lookup.service');
        (async()=>{const db=await new DataSource({...JSON.parse(process.env.LOOKUP_CHILD_DB),entities:[BudgetRule],synchronize:false}).initialize(),ledger=new CostLedgerService(db,new BudgetService({},new WorkspaceContextService(),db.getRepository(BudgetRule))),prices=new PricingRepository(db),config={getNode:()=>JSON.parse(process.env.LOOKUP_CHILD_NODE)},tasks=new MediaTaskService(db,prices,ledger,config);tasks.process=async()=>process.exit(17);global.fetch=async()=>new Response(JSON.stringify({id:'provider-task',status:'completed',usage:{video_seconds:'6.4',generation_count:1}}));await new MediaJobLookupService(tasks,prices).apply(JSON.parse(process.env.LOOKUP_CHILD_ACTOR),'attempt-a',JSON.parse(process.env.LOOKUP_CHILD_INPUT));process.exit(19)})().catch(e=>{process.stderr.write(e.stack);process.exit(18)});
      `,
        ],
        {
          cwd: process.cwd(),
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            TMPDIR: process.env.TMPDIR,
            NODE_OPTIONS: "--max-old-space-size=512",
            TS_NODE_TRANSPILE_ONLY: "true",
            LOOKUP_CHILD_DB: JSON.stringify(source.options),
            LOOKUP_CHILD_NODE: JSON.stringify(node),
            LOOKUP_CHILD_ACTOR: JSON.stringify(supplierActor),
            LOOKUP_CHILD_INPUT: JSON.stringify(input),
          },
          encoding: "utf8",
          timeout: 20000,
        },
      );
      expect({
        status: child.status,
        error: child.error?.message,
        stderr: child.stderr,
      }).toEqual({ status: 17, error: undefined, stderr: "" });
      const noFetch = jest.spyOn(globalThis, "fetch");
      expect(await svc.apply(supplierActor, "attempt-a", input)).toMatchObject({
        replayed: true,
        processing_pending: false,
      });
      expect(noFetch).not.toHaveBeenCalled();
      expect((await result())?.budget_committed_usd).toBe(
        "0.660000000000000000",
      );
    });
    it("refuses a proposed job already owned by a different signed task without changing either ledger", async () => {
      const svc = await unknown();
      const existing = {
        ...(await row()),
        id: "existing-task",
        provider_job_id: "provider-task",
        credential_id: "default",
        state: "pending" as const,
      };
      await ledger.beginAttempt({
        id: existing.id,
        requestId: existing.request_id,
        workspace,
        reservationId: existing.reservation_id,
        target,
        feeSource: "provider",
        dispatchedAt: new Date().toISOString(),
        priceContext: { context: context.pricing, legacyPrice: null },
        mediaTask: existing,
      });
      jest
        .spyOn(globalThis, "fetch")
        .mockImplementation(
          async () => new Response(JSON.stringify(complete())),
        );
      const preview = await previewLookup(svc),
        before = await lookupDump();
      await expect(
        svc.apply(supplierActor, "attempt-a", lookupPayload(preview)),
      ).rejects.toThrow("already associated");
      expect(await lookupDump()).toEqual(before);
    });
    it("paginates tasks sharing a creation timestamp without skipping or duplicating them", async () => {
      const svc = await supplierStart(),
        original = await row();
      for (let i = 0; i < 4; i++) {
        const id = `extra-task-${i}`;
        await ledger.beginAttempt({
          id,
          requestId: original.request_id,
          workspace,
          reservationId: original.reservation_id,
          target,
          feeSource: "provider",
          dispatchedAt: new Date().toISOString(),
          priceContext: { context: context.pricing, legacyPrice: null },
          mediaTask: { ...original, id },
        });
      }
      let cursor: string | undefined;
      const ids: string[] = [];
      do {
        const page = await svc.inventory(supplierActor, {
          view: "all",
          limit: 2,
          cursor,
        });
        ids.push(...page.tasks.map((t) => t.id));
        cursor = page.next_cursor ?? undefined;
      } while (cursor);
      expect(ids).toHaveLength(5);
      expect(new Set(ids).size).toBe(5);
      const first = await svc.inventory(supplierActor, {
        view: "all",
        limit: 2,
      });
      await expect(
        svc.inventory(supplierActor, {
          view: "pending",
          limit: 2,
          cursor: first.next_cursor!,
        }),
      ).rejects.toThrow("cursor");
    });

    it("serializes manual and signed claims of the same provider job across separate tasks", async () => {
      const svc = await unknown(),
        first = await row();
      const descriptor = {
        ...first,
        id: "other-attempt",
        state: "submitted" as const,
      };
      await ledger.beginAttempt({
        id: descriptor.id,
        requestId: first.request_id,
        workspace,
        reservationId: first.reservation_id,
        target,
        feeSource: "provider",
        dispatchedAt: new Date().toISOString(),
        priceContext: {
          context: context.pricing,
          legacyPrice: null,
          dispatch: {
            node_id: node.id,
            wire_model: target.model,
            credential_id: "default",
            credential_strategy: "fixture",
            credential_retry_index: 0,
            compatibility_retry_index: 0,
            dispatch_index: 2,
            protocol: node.protocol,
            dispatched_at: new Date().toISOString(),
            invocation_id: "other-invocation",
            requested_model: target.model,
            route_model: target.model,
          },
        },
        mediaTask: descriptor,
      });
      const suppliers = service();
      await suppliers.configure(supplierActor, "signed-source", sourceOptions);
      jest
        .spyOn(globalThis, "fetch")
        .mockImplementation(
          async () => new Response(JSON.stringify(complete())),
        );
      const preview = await previewLookup(svc),
        event = { ...supplierEvent(), task_id: "other-attempt" };
      const results = await Promise.allSettled([
        svc.apply(supplierActor, "attempt-a", lookupPayload(preview)),
        suppliers.receive("signed-source", event, signature(event)),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
      const associated = await source.manager
        .createQueryBuilder()
        .select("t.id")
        .from("pricing_media_tasks", "t")
        .where("t.provider_job_id = :id", { id: "provider-task" })
        .getRawMany();
      expect(associated).toHaveLength(1);
    });
    it("does not turn absent recovery timestamps into a current completion-time tariff", async () => {
      const svc = await unknown();
      jest
        .spyOn(globalThis, "fetch")
        .mockImplementation(
          async () => new Response(JSON.stringify(complete())),
        );
      const preview = await previewLookup(svc);
      expect(preview.observation.context.time_estimated).toBe(true);
      expect(preview.observation.context.completed_at).toBeUndefined();
      await svc.apply(supplierActor, "attempt-a", lookupPayload(preview));
      const row = (
        await source.query("SELECT * FROM pricing_media_observations")
      )[0];
      expect(JSON.parse(row.context_json).completed_at).toBeUndefined();
      expect(JSON.parse(row.cost_json).usage).toEqual(preview.cost.usage);
    });

    it("preserves unknown provider instants during later polling of a manually linked job", async () => {
      const svc = await unknown();
      jest
        .spyOn(globalThis, "fetch")
        .mockImplementation(
          async () => new Response(JSON.stringify(complete())),
        );
      const preview = await previewLookup(svc);
      await svc.apply(supplierActor, "attempt-a", lookupPayload(preview));
      await tasks.accept("attempt-a", workspace, complete("7.4"));
      const rows = await source.query(
        "SELECT * FROM pricing_media_observations ORDER BY revision",
      );
      expect(rows).toHaveLength(2);
      for (const observed of rows) {
        expect(
          JSON.parse(observed.context_json).provider_accepted_at,
        ).toBeUndefined();
        expect(JSON.parse(observed.context_json).completed_at).toBeUndefined();
      }
      expect((await result())?.amount).toBe("0.760000000000000000");
    });

    it("refuses polling after a lookup receipt is lost instead of inventing old provider times", async () => {
      const svc = await unknown();
      jest
        .spyOn(globalThis, "fetch")
        .mockImplementation(
          async () => new Response(JSON.stringify(complete())),
        );
      const preview = await previewLookup(svc);
      await svc.apply(supplierActor, "attempt-a", lookupPayload(preview));
      await source.query("DELETE FROM pricing_media_job_reconciliations");
      const before = await source.query(
        "SELECT * FROM pricing_media_observations",
      );
      await expect(
        tasks.accept("attempt-a", workspace, complete("7.4")),
      ).rejects.toThrow("receipt is missing");
      expect(
        await source.query("SELECT * FROM pricing_media_observations"),
      ).toEqual(before);
    });

    it('revokes a source after node removal or changed connection without requiring an available signing key',async()=>{
      const svc=await supplierStart(),original=await svc.sourceDetail(supplierActor,'signed-source');delete process.env[secretName];node.base_url='http://changed.example';
      const disabled=await svc.configure(supplierActor,'signed-source',{...sourceOptions,revision:1,enabled:false});expect(disabled).toMatchObject({enabled:0,revision:2,connection_hash:original.connection_hash});
      await expect(svc.sourceDetail({...supplierActor,workspace_id:'other'},'signed-source')).rejects.toThrow('workspace');
      await expect(svc.configure(supplierActor,'signed-source',{...sourceOptions,revision:2,enabled:true})).rejects.toThrow('retarget');
      const noNode=new MediaSupplierService(source,{getNode:()=>undefined} as unknown as ConfigService,tasks,ledger);
      expect(await noNode.configure(supplierActor,'signed-source',{...sourceOptions,revision:2,enabled:false})).toMatchObject({enabled:0,revision:3,connection_hash:original.connection_hash});
      await expect(noNode.configure(supplierActor,'signed-source',{...sourceOptions,revision:3,enabled:false,credential_id:'replacement'})).rejects.toThrow('retarget');
    });


    const dispositions = () => new MediaEventDispositionService(tasks, prices, ledger);
    const dispositionInput = (preview: MediaEventDispositionPreview, id = "disposition-a") => ({
      id, action: preview.action, ordering: preview.ordering, expected_basis_hash: preview.basis_hash,
      expected_event_hash: preview.event_hash, expected_preview_hash: preview.preview_hash,
      reason: "Administrator reviewed retained normalized media evidence", confirm: true,
    });
    async function dispositionPreview(eventId: string, action: "accept" | "reject" = "accept", ordering: "continue_ordered" | "manual_review" | "unchanged" = action === "reject" ? "unchanged" : "continue_ordered") {
      const svc = dispositions(), basis = await svc.basis(supplierActor, "attempt-a", eventId);
      return svc.preview(supplierActor, "attempt-a", eventId, { action, ordering, expected_basis_hash: basis.basis_hash, expected_event_hash: basis.event_hash });
    }
    async function alternative(unversioned = false) {
      const svc = await supplierStart();
      await send(svc, supplierEvent("1", "6.4"));
      if (unversioned) {
        await tasks.observe("attempt-a", workspace, complete("8.4"));
        return (await svc.events(supplierActor, "attempt-a")).events.find(e => e.origin === "unversioned_observation")!;
      }
      return send(svc, { ...supplierEvent("1", "8.4"), event_id: "alternative-1" });
    }
    const dispositionDump = async () => {
      const rows = await lookupDump();
      for (const table of ["pricing_media_supplier_events", "pricing_media_event_heads", "pricing_media_event_dispositions", "pricing_media_event_authorities", "pricing_budget_balances", "pricing_budget_effects", "pricing_adjustment_applications", "budget_rules"])
        rows[table] = await source.query(`SELECT * FROM ${table}`);
      return rows;
    };
    it("previews original-price media alternative cost and original-period budget effects without any writes or supplier IO", async () => {
      const event = await alternative(), before = await dispositionDump(), fetch = jest.spyOn(globalThis, "fetch");
      const preview = await dispositionPreview(event.id);
      expect(preview).toMatchObject({ dry_run: true, supplier_invoice_confirmed: false, original_receipts_modified: false,
        previous_cost: { report_amount: "0.660000000" }, cost: { report_amount: "0.860000000" },
        impact: { operation: "adjustment", amount_delta: "0.200000000000000000", budget: { budget_cost_before: "0.660000000000000000", budget_cost_after: "0.860000000000000000", current_period_refund_not_guaranteed: true } } });
      expect(await dispositionDump()).toEqual(before);
      expect(fetch).not.toHaveBeenCalled();
    });
    it("accepts a same-sequence alternative separately from custody and retains the original head until a higher signed snapshot", async () => {
      const event = await alternative(), originalEvents = await source.query("SELECT * FROM pricing_media_supplier_events"), originalHead = await source.query("SELECT * FROM pricing_media_event_heads");
      const preview = await dispositionPreview(event.id), input = dispositionInput(preview), svc = dispositions();
      const accepted = await svc.apply(supplierActor, "attempt-a", event.id, input);
      expect(accepted).toMatchObject({ replayed: false, processing_pending: false, preview: { action: "accept", ordering: "continue_ordered" } });
      expect(await source.query("SELECT * FROM pricing_media_supplier_events")).toEqual(originalEvents);
      expect(await source.query("SELECT * FROM pricing_media_event_heads")).toEqual(originalHead);
      expect((await result())?.budget_committed_usd).toBe("0.860000000000000000");
      expect((await result())?.attempts[0].cost?.report_amount).toBe("0.660000000");
      expect((await result())?.attempts[0].adjustments[0].application).toMatchObject({ actor_id: "admin", source: "reconciliation" });
      expect((await service().inventory(supplierActor, { limit: 20, view: "review_required" })).tasks).toHaveLength(0);
      expect((await service().event(supplierActor, "attempt-a", event.id)).disposition).toMatchObject({ id: input.id, preview: { action: "accept" } });
      expect(await svc.status(supplierActor, "attempt-a", event.id, input.id)).toMatchObject({ record_hash: accepted.record_hash, replayed: true });
      const beforeRetry = await dispositionDump();
      expect(await svc.apply(supplierActor, "attempt-a", event.id, input)).toMatchObject({ replayed: true });
      expect(await dispositionDump()).toEqual(beforeRetry);
      await send(service(), supplierEvent("2", "9.4"));
      expect((await result())?.budget_committed_usd).toBe("0.960000000000000000");
      expect((await svc.status(supplierActor, "attempt-a", event.id, input.id)).record_hash).toBe(accepted.record_hash);
    });
    it("rejects alternatives without observation, financial processing, or authority changes", async () => {
      const event = await alternative(), preview = await dispositionPreview(event.id, "reject"), before = await dispositionDump(), process = jest.spyOn(tasks, "process");
      expect(preview.impact).toMatchObject({ operation: "none", amount_delta: "0.000000000000000000", budget: null });
      const accepted = await dispositions().apply(supplierActor, "attempt-a", event.id, dispositionInput(preview));
      expect(accepted.observation_id).toBeNull();
      expect(process).not.toHaveBeenCalled();
      const after = await dispositionDump();
      for (const table of Object.keys(before).filter(t => !["pricing_audit_events", "pricing_media_event_dispositions"].includes(t))) expect(after[table]).toEqual(before[table]);
      expect((await service().inventory(supplierActor, { limit: 20, view: "review_required" })).tasks).toHaveLength(0);
    });
    it("accepts unordered evidence only with a manual-review hold and can explicitly resume ordering from a reviewed signed sequence", async () => {
      const event = await alternative(true);
      await expect(dispositionPreview(event.id)).rejects.toThrow("Unversioned");
      const preview = await dispositionPreview(event.id, "accept", "manual_review");
      await dispositions().apply(supplierActor, "attempt-a", event.id, dispositionInput(preview));
      expect((await result())?.amount).toBe("0.860000000000000000");
      const next = await send(service(), supplierEvent("100", "9.4"));
      expect(next.decision).toBe("review_required");
      expect((await result())?.amount).toBe("0.860000000000000000");
      const resumed = await dispositionPreview(next.id);
      await dispositions().apply(supplierActor, "attempt-a", next.id, dispositionInput(resumed, "resume-100"));
      expect((await result())?.amount).toBe("0.960000000000000000");
      expect(await send(service(), supplierEvent("99", "99"))).toMatchObject({ decision: "ignored_stale" });
      expect(await send(service(), { ...supplierEvent("100", "1"), event_id: "other-100" })).toMatchObject({ decision: "review_required" });
      expect(await send(service(), supplierEvent("101", "10.4"))).toMatchObject({ decision: "applied" });
      expect((await result())?.amount).toBe("1.060000000000000000");
      expect((await source.query("SELECT * FROM pricing_media_event_heads"))[0].sequence).toBe("101");
    });
    it("retains exact operation identity, actor and decision and rejects ID reuse and cross-workspace access", async () => {
      const event = await alternative(), preview = await dispositionPreview(event.id), input = dispositionInput(preview), svc = dispositions();
      await svc.apply(supplierActor, "attempt-a", event.id, input);
      await expect(svc.apply(supplierActor, "attempt-a", event.id, { ...input, reason: "changed" })).rejects.toThrow("reused");
      await expect(svc.apply({ ...supplierActor, id: "other-admin" }, "attempt-a", event.id, input)).rejects.toThrow("reused");
      await expect(svc.apply(supplierActor, "attempt-a", event.id, { ...input, id: "other-id" })).rejects.toThrow("already_disposed");
      await expect(svc.status({ ...supplierActor, workspace_id: "other" }, "attempt-a", event.id, input.id)).rejects.toThrow("workspace");
      await expect(svc.preview({ ...supplierActor, role: "operator" }, "attempt-a", event.id, {})).rejects.toThrow("administrator");
      await expect(svc.basis({ ...supplierActor, role: "viewer" }, "attempt-a", event.id)).rejects.toThrow("operator");
    });
    it("refuses stale preview when a higher signed snapshot or another operator decision wins", async () => {
      const event = await alternative(), preview = await dispositionPreview(event.id), input = dispositionInput(preview);
      await send(service(), supplierEvent("2", "10"));
      const before = await dispositionDump();
      await expect(dispositions().apply(supplierActor, "attempt-a", event.id, input)).rejects.toThrow("stale_sequence");
      expect(await dispositionDump()).toEqual(before);
      const rejection = await dispositionPreview(event.id, "reject");
      await dispositions().apply(supplierActor, "attempt-a", event.id, dispositionInput(rejection, "reject-stale"));
      expect((await result())?.amount).toBe("1.020000000000000000");
    });
    it("keeps custody and original computed price through interrupted processing and resumes an exact retry without repricing", async () => {
      const event = await alternative(), preview = await dispositionPreview(event.id), input = dispositionInput(preview), fail = jest.spyOn(ledger, "adjustAttempt").mockRejectedValueOnce(new Error("simulated ledger failure"));
      const accepted = await dispositions().apply(supplierActor, "attempt-a", event.id, input);
      expect(accepted.processing_pending).toBe(true);
      expect((await row()).state).toBe("terminal");
      expect((await result())?.amount).toBe("0.660000000000000000");
      fail.mockRestore();
      const restore = jest.spyOn(prices, "restoreRequest").mockRejectedValue(new Error("must not reprice"));
      expect(await dispositions().apply(supplierActor, "attempt-a", event.id, input)).toMatchObject({ replayed: true, processing_pending: false });
      expect(restore).not.toHaveBeenCalled();
      expect((await result())?.amount).toBe("0.860000000000000000");
    });
    it("rolls back observation, authority, disposition and budget together when the decision audit cannot commit", async () => {
      const event = await alternative(), preview = await dispositionPreview(event.id), before = await dispositionDump();
      const prototype = Object.getPrototypeOf(source.createQueryBuilder().insert()), execute = prototype.execute;
      const spy = jest.spyOn(prototype, "execute").mockImplementation(function(this: { expressionMap: { mainAlias?: { tablePath?: string }; valuesSet?: unknown } }) {
        if (this.expressionMap.mainAlias?.tablePath === "pricing_audit_events" && JSON.stringify(this.expressionMap.valuesSet).includes("media.event_disposed")) throw new Error("disposition audit failed");
        return execute.call(this);
      });
      await expect(dispositions().apply(supplierActor, "attempt-a", event.id, dispositionInput(preview))).rejects.toThrow("disposition audit failed");
      spy.mockRestore(); expect(await dispositionDump()).toEqual(before);
    });
    it.each(["authority", "receipt", "audit", "observation"])("fails closed on a missing or inconsistent media disposition %s", async (kind) => {
      const event = await alternative(), preview = await dispositionPreview(event.id), input = dispositionInput(preview);
      const receipt = await dispositions().apply(supplierActor, "attempt-a", event.id, input);
      if (kind === "authority") await source.query("DELETE FROM pricing_media_event_authorities");
      else if (kind === "receipt") await source.createQueryBuilder().update("pricing_media_event_dispositions").set({ record_hash: "broken" }).execute();
      else if (kind === "audit") await source.createQueryBuilder().update("pricing_audit_events").set({ metadata_json: "{}" }).where("action = :action", { action: "media.event_disposed" }).execute();
      else await source.createQueryBuilder().update("pricing_media_observations").set({ observation_hash: "broken" }).where("id = :id", { id: receipt.observation_id }).execute();
      const before = await dispositionDump();
      await expect(send(service(), supplierEvent("2"))).rejects.toThrow();
      expect(await dispositionDump()).toEqual(before);
    });
    it("does not turn a terminal task back into pending, but permits explicit rejection of the regressive retained alternative", async () => {
      const event = await alternative(), pending = await send(service(), { ...supplierEvent("1"), event_id: "pending-alt", status: "pending", completed_at: null });
      expect(pending.decision).toBe("review_required");
      await expect(dispositionPreview(pending.id)).rejects.toThrow("terminal_regression");
      const reject = await dispositionPreview(pending.id, "reject");
      await dispositions().apply(supplierActor, "attempt-a", pending.id, dispositionInput(reject));
      expect((await row()).state).toBe("settled");
      expect((await service().inventory(supplierActor, { limit: 20, view: "review_required" })).tasks).toHaveLength(1);
      expect((await dispositions().basis(supplierActor, "attempt-a", event.id)).blocked_reason).toBeNull();
    });
    it("uses the captured catalog rather than newly published rates when accepting a retained alternative", async () => {
      const event = await alternative(), before = (await result())?.attempts[0].cost;
      const created = await prices.createBook(supplierActor, { name: "Replacement", scope: "workspace", content: book([rate("replacement", "video_seconds", "99", "1")]) });
      const catalog = await prices.listBindings(supplierActor);
      await prices.publishDraft(supplierActor, created.draft.id, { draft_revision: 1, catalog_revision: catalog.head.revision, reason: "Synthetic future rate", confirm: true,
        targets: [{ level: "model", model: target.model, operation: target.operation }] });
      const preview = await dispositionPreview(event.id);
      expect(preview.cost).toMatchObject({ version_id: before?.version_id, content_hash: before?.content_hash, report_amount: "0.860000000" });
      await dispositions().apply(supplierActor, "attempt-a", event.id, dispositionInput(preview));
      expect((await result())?.amount).toBe("0.860000000000000000");
    });

    it("accepts terminal evidence for a pending signed task through the original initial settlement", async () => {
      const svc = await supplierStart();
      await send(svc, { ...supplierEvent(), event_id: "initial-pending", status: "pending", completed_at: null, evidence: [] });
      const event = await send(svc, supplierEvent());
      expect(event.decision).toBe("review_required");
      const preview = await dispositionPreview(event.id);
      expect(preview).toMatchObject({ previous_cost: null, impact: { operation: "initial", amount_delta: null } });
      const accepted = await dispositions().apply(supplierActor, "attempt-a", event.id, dispositionInput(preview));
      expect(accepted.processing_pending).toBe(false);
      expect((await result())?.budget_committed_usd).toBe("0.660000000000000000");
      expect(await source.query("SELECT * FROM pricing_settlement_intents")).toHaveLength(1);
      expect(await source.query("SELECT * FROM pricing_cost_adjustments")).toHaveLength(0);
    });
    it("keeps accepted pending evidence nonfinancial until a subsequent signed terminal result", async () => {
      const svc = await supplierStart(), pending = { ...supplierEvent(), status: "pending" as const, completed_at: null, evidence: [] };
      await send(svc, pending);
      const event = await send(svc, { ...pending, event_id: "pending-conflict" });
      const preview = await dispositionPreview(event.id);
      expect(preview.impact).toMatchObject({ operation: "pending_only", amount_delta: "0.000000000000000000", budget: null });
      await dispositions().apply(supplierActor, "attempt-a", event.id, dispositionInput(preview));
      expect((await row()).state).toBe("pending");
      expect(await source.query("SELECT * FROM pricing_settlement_intents")).toHaveLength(0);
      await send(svc, supplierEvent("2"));
      expect((await result())?.budget_committed_usd).toBe("0.660000000000000000");
    });
    it("does not create a second decision when a rejected disposition receipt is lost but its audit survives", async () => {
      const event = await alternative(), preview = await dispositionPreview(event.id, "reject"), input = dispositionInput(preview);
      await dispositions().apply(supplierActor, "attempt-a", event.id, input);
      await source.query("DELETE FROM pricing_media_event_dispositions");
      const before = await dispositionDump();
      await expect(dispositions().apply(supplierActor, "attempt-a", event.id, input)).rejects.toThrow("receipt is missing");
      expect(await dispositionDump()).toEqual(before);
    });
    it("records one disposition under independent concurrent database connections and accepts the winner's same-ID retry", async () => {
      const event = await alternative(), preview = await dispositionPreview(event.id), input = dispositionInput(preview), svc = dispositions();
      const second = await new DataSource({ ...source.options, entities: [BudgetRule], synchronize: false }).initialize();
      const secondPrices = new PricingRepository(second), secondLedger = new CostLedgerService(second, new BudgetService(mockConfigService(), new WorkspaceContextService(), second.getRepository(BudgetRule))), secondTasks = new MediaTaskService(second, secondPrices, secondLedger, config);
      try {
        const other = new MediaEventDispositionService(secondTasks, secondPrices, secondLedger);
        const results = await Promise.allSettled([svc.apply(supplierActor, "attempt-a", event.id, input), other.apply(supplierActor, "attempt-a", event.id, input)]);
        expect(results.some(r => r.status === "fulfilled")).toBe(true);
        expect(await other.apply(supplierActor, "attempt-a", event.id, input)).toMatchObject({ replayed: true });
        expect(await source.query("SELECT * FROM pricing_media_event_dispositions")).toHaveLength(1);
        expect(await source.query("SELECT * FROM pricing_cost_adjustments")).toHaveLength(1);
        expect((await result())?.budget_committed_usd).toBe("0.860000000000000000");
      } finally { await secondTasks.onModuleDestroy(); await second.destroy(); }
    });
    it("recovers from an actual process exit after committing the disposition but before financial processing", async () => {
      const event = await alternative(), preview = await dispositionPreview(event.id), input = dispositionInput(preview);
      const child = spawnSync(process.execPath, ["-r", "ts-node/register", "-e", `
        const {DataSource}=require('typeorm'),{BudgetRule}=require('./src/database/entities/budget-rule.entity'),{BudgetService}=require('./src/budget/budget.service'),{WorkspaceContextService}=require('./src/workspaces/workspace-context.service'),{CostLedgerService}=require('./src/pricing/cost-ledger.service'),{PricingRepository}=require('./src/pricing/pricing-repository'),{MediaTaskService}=require('./src/pricing/media-task.service'),{MediaEventDispositionService}=require('./src/pricing/media-event-disposition.service');
        (async()=>{const db=await new DataSource({...JSON.parse(process.env.CHILD_DB),entities:[BudgetRule],synchronize:false}).initialize(),ledger=new CostLedgerService(db,new BudgetService({},new WorkspaceContextService(),db.getRepository(BudgetRule))),prices=new PricingRepository(db),tasks=new MediaTaskService(db,prices,ledger,{getNode:()=>JSON.parse(process.env.CHILD_NODE)});tasks.process=async()=>process.exit(17);await new MediaEventDispositionService(tasks,prices,ledger).apply(JSON.parse(process.env.CHILD_ACTOR),'attempt-a',process.env.CHILD_EVENT,JSON.parse(process.env.CHILD_INPUT));process.exit(19)})().catch(e=>{process.stderr.write(e.stack);process.exit(18)});
      `], { cwd: process.cwd(), env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, NODE_OPTIONS: "--max-old-space-size=512", TS_NODE_TRANSPILE_ONLY: "true", CHILD_DB: JSON.stringify(source.options), CHILD_NODE: JSON.stringify(node), CHILD_ACTOR: JSON.stringify(supplierActor), CHILD_EVENT: event.id, CHILD_INPUT: JSON.stringify(input) }, encoding: "utf8", timeout: 20000 });
      expect({ status: child.status, error: child.error?.message, stderr: child.stderr }).toEqual({ status: 17, error: undefined, stderr: "" });
      expect((await row()).state).toBe("terminal");
      expect(await dispositions().apply(supplierActor, "attempt-a", event.id, input)).toMatchObject({ replayed: true, processing_pending: false });
      expect((await result())?.budget_committed_usd).toBe("0.860000000000000000");
    });

    const nativeJob = (profile: NativeVideoResultProfile) => profile === 'gemini-veo-rest-v1' ? 'models/synthetic-veo/operations/task-1' : '17f20503-6c24-4c16-946b-35dbbce2af2f';
    const nativeResult = (profile: NativeVideoResultProfile, terminal: boolean, outputs = 2) => profile === 'gemini-veo-rest-v1'
      ? { name: nativeJob(profile), ...(terminal ? { done: true, response: { generateVideoResponse: { generatedSamples: Array.from({length:outputs},(_,i)=>({video:{uri:`https://private.invalid/output-${i}`}})) } } } : {}) }
      : { id: nativeJob(profile), ...(terminal ? { status: 'SUCCEEDED', createdAt: '2026-09-27T00:00:00Z', output: Array.from({length:outputs},(_,i)=>`https://private.invalid/output-${i}`), cost:{credits:999} } : {}) };
    it.each<NativeVideoResultProfile>(['gemini-veo-rest-v1','runway-task-v1'])('pins %s results across node profile changes and does not promote unknown duration to a fee', async profile => {
      node.video_result_profile = profile;
      await start(null, 'default');
      await tasks.accept('attempt-a', workspace, nativeResult(profile, false), 'default');
      expect((await row()).state).toBe('pending');
      expect(JSON.parse((await row()).context_json).video_result_profile).toBe(profile);
      node.video_result_profile = 'generic-v1';
      await tasks.accept('attempt-a', workspace, nativeResult(profile, true), 'default');
      const cost = (await result())?.attempts[0].effective_cost;
      expect(cost?.usage).toMatchObject({adapter_id:profile,quantities:{video_generation_count:{value:'2'},video_seconds:{value:null,quality:'unsupported'}}});
      expect(cost?.report_amount).toBeNull();
      expect(cost?.report_known_subtotal).toBe('0.040000000');
      expect((await row()).state).toBe('settled');
      const count = (await source.query('SELECT * FROM pricing_media_observations')).length;
      await tasks.accept('attempt-a', workspace, nativeResult(profile, true), 'default');
      expect(await source.query('SELECT * FROM pricing_media_observations')).toHaveLength(count);
      expect(await source.query('SELECT * FROM pricing_settlement_intents')).toHaveLength(1);
      expect(JSON.stringify(await source.query('SELECT * FROM pricing_media_observations'))).not.toMatch(/https:|private.invalid/);
    });
    it.each<NativeVideoResultProfile>(['gemini-veo-rest-v1','runway-task-v1'])('polls %s using original credentials and safe paths without inventing provider instants', async profile => {
      node.video_result_profile = profile;
      node.video_status_endpoint = profile === 'gemini-veo-rest-v1' ? '/v1beta/{id}' : '/v1/tasks/:id';
      await start(null, 'default');
      await tasks.accept('attempt-a', workspace, nativeResult(profile, false), 'default');
      const fetch = jest.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify(nativeResult(profile,true))));
      await tasks.refresh(await row());
      expect(fetch).toHaveBeenCalledTimes(1);
      const [url, options] = fetch.mock.calls[0];
      expect(String(url)).toBe(node.base_url + (profile === 'gemini-veo-rest-v1' ? '/v1beta/'+nativeJob(profile) : '/v1/tasks/'+nativeJob(profile)));
      expect(options?.method).toBe('GET');
      expect(options?.headers).toMatchObject({Authorization:'Bearer synthetic-secret'});
      const observations = await source.query('SELECT * FROM pricing_media_observations');
      for(const observation of observations) {
        const pricing = JSON.parse(observation.context_json);expect(pricing.provider_accepted_at).toBeUndefined();expect(pricing.completed_at).toBeUndefined();
      }
      await expect(tasks.cancel(await row())).rejects.toThrow('status metadata only');
      await expect(tasks.content(await row())).rejects.toThrow('status metadata only');
      expect(fetch).toHaveBeenCalledTimes(1);
    });
    it.each<NativeVideoResultProfile>(['gemini-veo-rest-v1','runway-task-v1'])('uses the pinned %s schema during no-write unknown-job lookup and preserves missing times on later polling', async profile => {
      node.video_result_profile = profile;
      await start(null,'default');await tasks.markUncertain('attempt-a',workspace);
      const svc = lookups(),basis = await svc.basis(supplierActor,'attempt-a');
      const fetch = jest.spyOn(globalThis,'fetch').mockImplementation(async()=>new Response(JSON.stringify(nativeResult(profile,true))));
      const before = await lookupDump();
      const preview = await svc.preview(supplierActor,'attempt-a',{provider_job_id:nativeJob(profile),expected_basis_hash:basis.basis_hash});
      expect(await lookupDump()).toEqual(before);
      expect(preview.observation.usage.adapter_id).toBe(profile);
      expect(preview.observation.context.provider_accepted_at).toBeUndefined();
      await svc.apply(supplierActor,'attempt-a',{...lookupPayload(preview),provider_job_id:nativeJob(profile)});
      node.video_result_profile = 'generic-v1';
      await tasks.refresh(await row());
      const observations = await source.query('SELECT * FROM pricing_media_observations');
      for(const observation of observations){const pricing=JSON.parse(observation.context_json);expect(pricing.provider_accepted_at).toBeUndefined();expect(pricing.completed_at).toBeUndefined()}
      expect(fetch).toHaveBeenCalledTimes(3);
    });
    it('retains native polling alternatives behind the existing signed ordering boundary', async () => {
      node.video_result_profile='runway-task-v1';await start(null,'default');await tasks.accept('attempt-a',workspace,nativeResult('runway-task-v1',false),'default');
      await service().configure(supplierActor,'signed-source',sourceOptions);
      const signed={...supplierEvent(),provider_job_id:nativeJob('runway-task-v1')};await send(service(),signed);
      await tasks.observe('attempt-a',workspace,nativeResult('runway-task-v1',true));
      expect((await result())?.amount).toBe('0.660000000000000000');
      const events=await service().events(supplierActor,'attempt-a');const retained=events.events.find(e=>e.origin==='unversioned_observation')!;
      expect(retained.decision).toBe('review_required');
      const preview=await dispositionPreview(retained.id,'accept','manual_review');
      expect(preview.cost?.usage.adapter_id).toBe('runway-task-v1');
      expect(preview.cost?.report_amount).toBeNull();
    });
    it('does not silently migrate generic historical tasks when a native profile is selected later', async () => {
      await start(null,'default');await tasks.accept('attempt-a',workspace,{id:'provider-task',status:'pending'},'default');
      node.video_result_profile='runway-task-v1';await tasks.accept('attempt-a',workspace,complete(),'default');
      expect(JSON.parse((await row()).context_json).video_result_profile).toBeUndefined();
      expect((await result())?.amount).toBe('0.660000000000000000');
    });
    it('does not turn a native control 204 into a new observation or accepted job time', async()=>{
      node.video_result_profile='runway-task-v1';await start(null,'default');await tasks.accept('attempt-a',workspace,nativeResult('runway-task-v1',false),'default');
      const before=await source.query('SELECT * FROM pricing_media_observations');jest.spyOn(globalThis,'fetch').mockResolvedValue(new Response(null,{status:204}));
      await tasks.refresh(await row());expect(await source.query('SELECT * FROM pricing_media_observations')).toEqual(before);expect((await row()).state).toBe('pending');
    });
    it("upgrades populated 004 through current additive steps without changing earlier catalog/snapshot content or markers", async () => {
      const before = await source.query(
        "SELECT * FROM pricing_request_snapshots",
      );
      const prior = await source.query(
        "SELECT * FROM pricing_schema_versions WHERE id <= 'pricing-engine-004' ORDER BY id",
      );
      const steps = PRICING_MIGRATIONS.slice(4);
      const runner = source.createQueryRunner();
      try {
        for (const step of [...steps].reverse()) {
          for (const index of [...(step.indexes ?? [])].reverse()) await runner.dropIndex(index.table, index.definition.name!);
          for (const definition of [...step.definitions].reverse())
            await runner.dropTable(definition.name);
          await runner.manager
            .createQueryBuilder()
            .delete()
            .from("pricing_schema_versions")
            .where("id = :id", { id: step.version })
            .execute();
        }
      } finally {
        await runner.release();
      }
      expect((await planPricingSchema(source)).create_tables).toEqual(
        steps.flatMap((step) => step.definitions.map((entry) => entry.name)),
      );
      await applyPricingSchema(source);
      expect(
        await source.query("SELECT * FROM pricing_request_snapshots"),
      ).toEqual(before);
      expect(
        await source.query(
          "SELECT * FROM pricing_schema_versions WHERE id <= 'pricing-engine-004' ORDER BY id",
        ),
      ).toEqual(prior);
      await start();
      await tasks.accept("attempt-a", workspace, complete());
      expect((await result())?.amount).toBe("0.660000000000000000");
    });

    it("replays a prepared task after an isolated child process exits before financial application", async () => {
      await start();
      const child = spawnSync(
        process.execPath,
        [
          "-r",
          require.resolve("ts-node/register"),
          "-e",
          `
        require('reflect-metadata');
        const { DataSource } = require('typeorm');
        const { BudgetRule } = require('./src/database/entities/budget-rule.entity');
        const { BudgetService } = require('./src/budget/budget.service');
        const { WorkspaceContextService } = require('./src/workspaces/workspace-context.service');
        const { CostLedgerService } = require('./src/pricing/cost-ledger.service');
        const { PricingRepository } = require('./src/pricing/pricing-repository');
        const { MediaTaskService } = require('./src/pricing/media-task.service');
        (async () => {
          const source = await new DataSource({ ...JSON.parse(process.env.PRICING_CHILD_DB), entities: [BudgetRule], synchronize: false }).initialize();
          const budgets = new BudgetService({}, new WorkspaceContextService(), source.getRepository(BudgetRule));
          const ledger = new CostLedgerService(source, budgets);
          ledger.settle = async () => { process.exit(17); };
          const node = JSON.parse(process.env.PRICING_CHILD_NODE);
          const tasks = new MediaTaskService(source, new PricingRepository(source), ledger, { getNode: () => node });
          await tasks.accept('attempt-a', process.env.PRICING_CHILD_WORKSPACE, { id: 'provider-task', status: 'completed', usage: { video_seconds: '6.4', generation_count: 1 } });
          process.exit(19);
        })().catch(() => process.exit(18));
      `,
        ],
        {
          cwd: process.cwd(),
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            TMPDIR: process.env.TMPDIR,
            NODE_OPTIONS: "--max-old-space-size=512",
            TS_NODE_TRANSPILE_ONLY: "true",
            PRICING_CHILD_DB: JSON.stringify(source.options),
            PRICING_CHILD_WORKSPACE: workspace,
            PRICING_CHILD_NODE: JSON.stringify(node),
          },
          encoding: "utf8",
          timeout: 20000,
        },
      );
      expect({
        status: child.status,
        error: child.error?.message,
        stderr: child.stderr,
      }).toEqual({ status: 17, error: undefined, stderr: "" });
      expect(
        (await source.query("SELECT * FROM pricing_media_observations"))[0],
      ).toMatchObject({ action: "initial", processed: 0 });
      await tasks.process("attempt-a", workspace);
      expect((await row()).state).toBe("settled");
      expect((await result())?.budget_committed_usd).toBe(
        "0.660000000000000000",
      );
      expect(
        await source.query("SELECT * FROM pricing_settlement_intents"),
      ).toHaveLength(1);
    });

    it("replays concurrent normalized completion exactly once and appends corrections without changing initial receipts", async () => {
      await start();
      await tasks.accept("attempt-a", workspace, {
        id: "provider-task",
        status: "pending",
      });
      const second = new MediaTaskService(source, prices, ledger, config);
      await Promise.all([
        tasks.accept("attempt-a", workspace, complete()),
        second.accept("attempt-a", workspace, complete()),
      ]);
      expect((await result())?.amount).toBe("0.660000000000000000");
      const initial = await source.query("SELECT * FROM pricing_attempts");
      await Promise.all([
        tasks.accept("attempt-a", workspace, complete("7.4")),
        second.accept("attempt-a", workspace, complete("7.4")),
      ]);
      expect((await result())?.amount).toBe("0.760000000000000000");
      expect((await result())?.budget_committed_usd).toBe(
        "0.760000000000000000",
      );
      expect(await source.query("SELECT * FROM pricing_attempts")).toEqual(
        initial,
      );
      expect(
        await source.query("SELECT * FROM pricing_cost_adjustments"),
      ).toHaveLength(1);
      await tasks.accept("attempt-a", workspace, complete()); // A later correction may legitimately restore an earlier amount.
      expect((await result())?.amount).toBe("0.660000000000000000");
      expect(
        await source.query("SELECT * FROM pricing_cost_adjustments"),
      ).toHaveLength(2);
    });

    it("reconstructs services after durable preparation and after ledger commit but before the processed marker", async () => {
      await start();
      const settle = jest
        .spyOn(ledger, "settle")
        .mockRejectedValueOnce(new Error("before ledger commit"));
      await expect(
        tasks.accept("attempt-a", workspace, complete()),
      ).rejects.toThrow("before ledger commit");
      settle.mockRestore();
      const second = new MediaTaskService(source, prices, ledger, config);
      const internals = second as unknown as {
        patch: (...args: unknown[]) => Promise<void>;
      };
      const original = internals.patch.bind(second);
      jest.spyOn(internals, "patch").mockImplementation(async (...args) => {
        if ((args[2] as Partial<MediaTaskRow>).state === "settled")
          throw new Error("after ledger commit");
        return original(...args);
      });
      await expect(second.process("attempt-a", workspace)).rejects.toThrow(
        "after ledger commit",
      );
      expect((await result())?.budget_committed_usd).toBe(
        "0.660000000000000000",
      );
      expect((await row()).state).toBe("terminal");
      await tasks.process("attempt-a", workspace);
      expect((await row()).state).toBe("settled");
      expect(
        await source.query("SELECT * FROM pricing_settlement_intents"),
      ).toHaveLength(1);
      expect((await result())?.budget_committed_usd).toBe(
        "0.660000000000000000",
      );
    });

    it("rejects corrupt normalized evidence and prepared cost metadata before budget mutation", async () => {
      await start();
      await tasks.observe("attempt-a", workspace, complete(), "default");
      const observed = (
        await source.query("SELECT * FROM pricing_media_observations")
      )[0];
      await source.manager
        .createQueryBuilder()
        .update("pricing_media_observations")
        .set({ context_json: "{}" })
        .where("id = :id", { id: observed.id })
        .execute();
      await expect(tasks.process("attempt-a", workspace)).rejects.toThrow(
        "integrity",
      );
      await source.manager
        .createQueryBuilder()
        .update("pricing_media_observations")
        .set({ context_json: observed.context_json })
        .where("id = :id", { id: observed.id })
        .execute();
      jest.spyOn(ledger, "settle").mockRejectedValueOnce(new Error("storage"));
      await expect(tasks.process("attempt-a", workspace)).rejects.toThrow(
        "storage",
      );
      await source.manager
        .createQueryBuilder()
        .update("pricing_media_observations")
        .set({ expected_hash: "tampered" })
        .where("id = :id", { id: observed.id })
        .execute();
      await expect(tasks.process("attempt-a", workspace)).rejects.toThrow(
        "processing integrity",
      );
      expect(
        await source.query("SELECT * FROM pricing_settlement_intents"),
      ).toHaveLength(0);
    });

    it("updates a late job identity even if pending metering is unchanged, and rejects identity changes", async () => {
      await start();
      await tasks.accept("attempt-a", workspace, { status: "pending" });
      expect((await row()).state).toBe("uncertain");
      await tasks.accept("attempt-a", workspace, {
        id: "provider-task",
        status: "pending",
      });
      expect(await row()).toMatchObject({
        state: "pending",
        provider_job_id: "provider-task",
      });
      expect(
        await source.query("SELECT * FROM pricing_media_observations"),
      ).toHaveLength(1);
      await expect(
        tasks.accept("attempt-a", workspace, {
          id: "other",
          status: "pending",
        }),
      ).rejects.toThrow("identity changed");
      await expect(
        tasks.accept("attempt-a", workspace, complete(), "another"),
      ).rejects.toThrow("credential identity");
    });

    it("pins workspace, key and namespace before matching provider IDs", async () => {
      await start();
      await tasks.accept("attempt-a", workspace, complete());
      const key = {
        id: "key-a",
        name: "alpha",
        workspace_id: workspace,
        namespace_id: "namespace-a",
      } as GatewayApiKeyContext;
      expect((await tasks.findOwned("provider-task", key))?.id).toBe(
        "attempt-a",
      );
      for (const altered of [
        { ...key, workspace_id: "elsewhere" },
        { ...key, id: "key-b" },
        { ...key, namespace_id: "namespace-b" },
        { ...key, namespace_id: null },
      ])
        expect(await tasks.findOwned("provider-task", altered)).toBeNull();
    });

    it("leases control requests and discards an overlapping stale response after newer observation", async () => {
      await start();
      await tasks.accept("attempt-a", workspace, {
        id: "provider-task",
        status: "pending",
      });
      let deliver!: (value: Response) => void;
      let began!: () => void;
      const beginning = new Promise<void>((resolve) => {
        began = resolve;
      });
      const fetch = jest
        .spyOn(globalThis, "fetch")
        .mockImplementation(async () => {
          began();
          return new Promise<Response>((resolve) => {
            deliver = resolve;
          });
        });
      const current = await row();
      const refresh = tasks.refresh(current);
      await beginning;
      await new MediaTaskService(source, prices, ledger, config).refresh(
        current,
      );
      expect(fetch).toHaveBeenCalledTimes(1);
      await tasks.accept("attempt-a", workspace, complete("9.4"));
      deliver(new Response(JSON.stringify(complete("6.4"))));
      await refresh;
      expect((await result())?.amount).toBe("0.960000000000000000");
      expect((await row()).poll_owner).toBeNull();
    });

    it("rejects control after connection configuration changes or pinned credential removal", async () => {
      await start();
      await tasks.accept("attempt-a", workspace, {
        id: "provider-task",
        status: "pending",
      });
      const fetch = jest.spyOn(globalThis, "fetch");
      node.auth_header_name = "Changed";
      await expect(tasks.refresh(await row())).rejects.toThrow(
        "configuration changed",
      );
      delete node.auth_header_name;
      delete node.api_key;
      await expect(tasks.refresh(await row())).rejects.toThrow(
        "Original media task credential",
      );
      expect(fetch).not.toHaveBeenCalled();
    });

    it("retains ambiguous dispatch holds during stale-process recovery without provider calls", async () => {
      await start();
      await source.manager
        .createQueryBuilder()
        .update("pricing_media_tasks")
        .set({ updated_at: new Date(Date.now() - 16 * 60000).toISOString() })
        .where("id = :id", { id: "attempt-a" })
        .execute();
      const fetch = jest.spyOn(globalThis, "fetch");
      await tasks.recover();
      expect((await row()).state).toBe("uncertain");
      expect(fetch).not.toHaveBeenCalled();
      expect((await result())?.status).toBe("pending");
      expect(
        await source.query("SELECT * FROM pricing_settlement_intents"),
      ).toHaveLength(0);
    });

    it("fences concurrent client claims, changed request bodies and expired claim takeover", async () => {
      await prices.capture({
        request_id: "request-b",
        workspace_id: workspace,
        report_currency: "USD",
      });
      const [first, second] = await Promise.all([
        tasks.claim(canonical, "request-a", workspace),
        tasks.claim(canonical, "request-b", workspace),
      ]);
      expect([first?.owner, second?.owner].sort()).toEqual([false, true]);
      const owner = first?.owner ? first : second;
      const different = {
        ...canonical,
        payload: { model: target.model, prompt: "different" },
      };
      await expect(
        tasks.claim(different, "request-b", workspace),
      ).rejects.toThrow("different request");
      await source.manager
        .createQueryBuilder()
        .update("pricing_media_submissions")
        .set({ lease_until: "2000-01-01T00:00:00.000Z" })
        .where("id = :id", { id: owner!.id })
        .execute();
      const newId =
        owner!.request_id === "request-a" ? "request-b" : "request-a";
      expect((await tasks.claim(canonical, newId, workspace))?.owner).toBe(
        true,
      );
      if (newId !== "request-a")
        await expect(start(owner!.id)).rejects.toThrow("ownership changed");
      else {
        await start(owner!.id);
        expect(
          (await tasks.claim(canonical, "request-b", workspace))?.owner,
        ).toBe(false);
      }
      expect(
        JSON.stringify(
          await source.query("SELECT * FROM pricing_media_submissions"),
        ),
      ).not.toMatch(/PRIVATE/);
    });
  });
}
contract("SQLite media tasks", async () => {
  const directory = mkdtempSync(join(tmpdir(), "media-task-db-"));
  const source = await new DataSource({
    type: "better-sqlite3",
    database: join(directory, "tasks.db"),
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
if (pgUrl) {
  const url = new URL(pgUrl);
  if (
    url.hostname !== "127.0.0.1" ||
    !/^\/pricing_goal_[a-z0-9_]+$/.test(url.pathname) ||
    url.port === "2099"
  )
    throw new Error("Use the isolated PostgreSQL test database");
}
contract(
  "PostgreSQL media tasks",
  async () => {
    if (!pgUrl) throw new Error("No isolated PostgreSQL URL");
    const schema = `media_task_${process.pid}_${Math.random().toString(16).slice(2)}`;
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

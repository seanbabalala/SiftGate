import { BudgetService } from "../../src/budget/budget.service";
import { PricingRepositoryError } from "../../src/pricing/pricing-repository.types";
import { WorkspaceMembershipService } from "../../src/auth/workspace-membership.service";
import {
  DEFAULT_ORGANIZATION_ID,
  DEFAULT_WORKSPACE_ID,
} from "../../src/workspaces/workspace.constants";
import type { CostLedgerSummary } from "../../src/pricing/cost-ledger.types";
import * as allocation from "../../src/pricing/cost-allocation";
import { DataSource } from "typeorm";
import { request as httpRequest } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as yaml from "js-yaml";
import {
  API_KEY,
  API_KEY_2,
  createE2EHarness,
  type E2EHarness,
  FIXTURE_PATH,
} from "./setup";
import { applyPricingSchema } from "../../src/pricing/pricing-schema";
import { CostLedgerService } from "../../src/pricing/cost-ledger.service";
import { PricingRuntimeService } from "../../src/pricing/pricing-runtime.service";
import { PricedEmbeddingBatchingService } from "../../src/pricing/priced-embedding-batching.service";
import { PricingRecoveryService } from "../../src/pricing/pricing-recovery.service";
import { ConfigService } from "../../src/config/config.service";
import { ExactDecimal } from "../../src/pricing/exact-decimal";
import { book, rate } from "../unit/pricing-fixtures";
import * as admissionClock from "../../src/pricing/pricing-admission-clock";
import { PricingRepository } from "../../src/pricing/pricing-repository";
import type { CompiledPricingCatalog } from "../../src/pricing/pricing-catalog";
import type { EntityManager } from "typeorm";

describe("priced embedding batch runtime on isolated requests", () => {
  let harness: E2EHarness, source: DataSource, directory: string;
  const model = "text-embedding-3-small",
    base = "/api/dashboard/pricing";
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "priced-batch-"));
    const config = yaml.load(readFileSync(FIXTURE_PATH, "utf8")) as Record<
      string,
      unknown
    >;
    config.cache = { enabled: false };
    config.budget = {
      daily_token_limit: 10000000,
      daily_cost_limit: 1000,
      alert_threshold: 0.8,
    };
    config.embedding_batching = {
      enabled: true,
      window_ms: 60,
      max_batch_size: 3,
      max_input_items: 8,
      max_queue: 100,
      timeout_ms: 2000,
    };
    (config.routing as Record<string, unknown>).retry = {
      max_retries: 1,
      backoff_base_ms: 1,
      backoff_max_ms: 1,
      retryable_status: [500, 502, 503, 504],
    };
    const file = join(directory, "config.yaml");
    writeFileSync(file, yaml.dump(config));
    harness = await createE2EHarness(file);
    source = harness.app.get(DataSource);
    await harness.app.get(PricingRecoveryService).onModuleDestroy();
    await applyPricingSchema(source);
  }, 30000);
  afterEach(async () => {
    jest.restoreAllMocks();
    await harness?.close();
    rmSync(directory, { recursive: true, force: true });
  });
  async function publish(
    content = book([rate("input", "uncached_input_tokens", "0.01", "1")]),
  ) {
    const created = await harness.agent
      .post(`${base}/books`)
      .send({ name: "Synthetic batch", content });
    expect(created.status).toBe(201);
    const head = (await harness.agent.get(`${base}/bindings`)).body.head;
    const result = await harness.agent
      .post(`${base}/drafts/${created.body.draft.id}/publish`)
      .send({
        draft_revision: 1,
        catalog_revision: head.revision,
        reason: "Isolated batch fixture",
        confirm: true,
        targets: [{ level: "model", model, operation: "embeddings" }],
      });
    expect(result.status).toBe(201);
    return result.body.version_id as string;
  }
  const call = (input: string | number[] = "abcd", key = API_KEY) =>
    harness.agent
      .post("/v1/embeddings")
      .set("Authorization", `Bearer ${key}`)
      .send({ model, input });
  const response = (count: number, tokens: number | null = 12, status = 200, completeEvidence = false) =>
    new Response(
      JSON.stringify({
        id: "synthetic-batch",
        model: "reported-embedding",
        data: Array.from({ length: count }, (_, index) => ({
          index,
          embedding: [index],
        })),
        ...(tokens === null
          ? {}
          : { usage: { prompt_tokens: tokens, total_tokens: tokens, ...(completeEvidence ? { prompt_tokens_details: { cached_tokens: 0 }, cache_creation_input_tokens: 0 } : {}) } }),
        ...(status === 200 ? {} : { error: { message: "synthetic retry" } }),
      }),
      { status, headers: { "content-type": "application/json" } },
    );
  const sum = (values: string[]) =>
    values
      .reduce(
        (sum, value) => sum.add(ExactDecimal.parse(value)),
        ExactDecimal.zero,
      )
      .toFixed(18);
  async function summaries(): Promise<Array<CostLedgerSummary | null>> {
    const snapshots = await source.query(
      "SELECT request_id, workspace_id FROM pricing_request_snapshots ORDER BY request_id",
    );
    return Promise.all(
      snapshots.map((entry: { request_id: string; workspace_id: string }) =>
        harness.app
          .get(CostLedgerService)
          .summary(entry.request_id, entry.workspace_id),
      ),
    );
  }
  async function actualPolicy() {
    const head = (await harness.agent.get(`${base}/bindings`)).body.head;
    const result = await harness.agent.put(`${base}/admission-policy`).send({ catalog_revision: head.revision, scope: "workspace", operation: "embeddings", policy: { mode: "compatibility", budget_basis: "actual_upstream" }, confirm: true, reason: "Synthetic explicit actual embedding policy" });
    expect(result.status === 200 ? 200 : result.body).toBe(200);
  }

  it.each([false, true])("dispatches once after every member intent is durable and prices the physical tier/base fee before allocation (actual=%s)", async actual => {
    const content = book([
      rate("input", "uncached_input_tokens", "0.01", "1"),
      rate("base", "request_count", "0.03", "1"),
    ]);
    content.groups.push({
      id: "large",
      order: 1,
      required: false,
      rules: [
        {
          id: "above-eight",
          priority: 0,
          mode: "whole_request",
          condition: { input_tokens: { min: "9" } },
          rates: [
            {
              operation: "replace",
              component: rate(
                "large-input",
                "uncached_input_tokens",
                "0.02",
                "1",
              ),
            },
          ],
        },
      ],
    });
    const version = await publish(content);
    if (actual) await actualPolicy();
    let dispatchRows = 0;
    harness.fetchMock.setHandler(async (_url, init) => {
      dispatchRows = (
        await source.query(
          "SELECT * FROM pricing_attempts WHERE state = 'dispatched'",
        )
      ).length;
      const body = JSON.parse(init.body as string);
      return response(body.input.length, 12, 200, actual);
    });
    const results = await Promise.all([
      call("aaaa"),
      call("bbbb"),
      call("cccc"),
    ]);
    expect(results.map((result) => result.status)).toEqual([200, 200, 200]);
    expect(harness.fetchMock.calls).toHaveLength(1);
    expect(dispatchRows).toBe(3);
    const costs = await summaries();
    expect(costs).toHaveLength(3);
    expect(sum(costs.map((cost) => cost!.amount!))).toBe(
      "0.270000000000000000",
    );
    expect(sum(costs.map((cost) => cost!.budget_committed_usd))).toBe(
      "0.270000000000000000",
    );
    const physical = new Set(
      costs.map((cost) => cost!.attempts[0].cost!.batch!.physical_attempt_id),
    );
    expect(physical.size).toBe(1);
    for (const cost of costs) {
      expect(cost!.amount).toBe("0.090000000000000000");
      expect(cost!.attempts[0].cost!.version_id).toBe(version);
      expect(cost!.attempts[0].cost!.batch!.physical_cost.amount).toBe(
        "0.270000000",
      );
      expect(cost!.reservations[0].state).toBe("committed");
      expect(cost!.pending_attempts).toBe(0);
    }
    for (const result of results)
      expect(JSON.stringify(result.body)).not.toContain("physical_attempt_id");
  });

  it.each([false, true])("allocates observed failed-credential costs without multiplying the shared physical total (actual=%s)", async actual => {
    await publish();
    if (actual) await actualPolicy();
    const node = harness.app.get(ConfigService).getNode("mock-openai")!;
    node.credentials = [
      { id: "a", api_key: "synthetic-a" },
      { id: "b", api_key: "synthetic-b" },
    ];
    node.credential_pool = {
      enabled: true,
      strategy: "least_in_flight",
      retry_on_status: [429],
    };
    let attempts = 0;
    harness.fetchMock.setHandler(async (_url, init) =>
      response(
        JSON.parse(init.body as string).input.length,
        12,
        ++attempts === 1 ? 429 : 200,
        actual,
      ),
    );
    expect(
      (await Promise.all([call(), call(), call()])).every(
        (result) => result.status === 200,
      ),
    ).toBe(true);
    const costs = await summaries();
    expect(harness.fetchMock.calls).toHaveLength(2);
    expect(sum(costs.map((cost) => cost!.amount!))).toBe(
      "0.240000000000000000",
    );
    expect(sum(costs.map((cost) => cost!.budget_committed_usd))).toBe(
      actual ? "0.240000000000000000" : "0.120000000000000000",
    );
    expect(costs.every((cost) => cost!.provider_attempts === 2)).toBe(true);
    if (actual) {
      expect(costs.every(cost => cost!.reservations[0].budget_basis === "actual_upstream")).toBe(true);
      expect((await source.query("SELECT state FROM pricing_runtime_group_outcomes WHERE kind = 'actual_budget_closure_group'"))[0].state).toBe("delivered");
      expect(await source.query("SELECT * FROM pricing_settlement_intents WHERE payload_json LIKE '%budget_attempt_id%'")).toHaveLength(0);
    }
  });

  it("does not mix price versions when a publication separates queue admissions", async () => {
    const firstVersion = await publish();
    let entered!: () => void;
    const queued = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const service = harness.app.get(PricedEmbeddingBatchingService);
    const enqueue = service.enqueue.bind(service);
    jest.spyOn(service, "enqueue").mockImplementationOnce((...args) => {
      const result = enqueue(...args);
      entered();
      return result;
    });
    harness.fetchMock.setHandler(async (_url, init) => {
      const input = JSON.parse(init.body as string).input;
      return response(typeof input === "string" ? 1 : input.length, 1);
    });
    const first = call("aaaa").then((value) => value);
    await queued;
    const secondVersion = await publish(
      book([rate("changed", "uncached_input_tokens", "0.02", "1")]),
    );
    const results = await Promise.all([first, call("bbbb")]);
    expect(results.every((result) => result.status === 200)).toBe(true);
    expect(harness.fetchMock.calls).toHaveLength(2);
    expect(
      new Set(
        (await summaries()).map((cost) => cost!.attempts[0].cost!.version_id),
      ),
    ).toEqual(new Set([firstVersion, secondVersion]));
  });

  it("uses the admitted FX and price after publication while the combined call is in flight", async () => {
    const content = book([rate("input", "uncached_input_tokens", "7", "1")]);
    content.currency = "CNY";
    const version = await publish(content);
    const head = (await harness.agent.get(`${base}/bindings`)).body.head;
    expect(
      (
        await harness.agent.put(`${base}/fx`).send({
          catalog_revision: head.revision,
          confirm: true,
          scope: "workspace",
          reason: "Synthetic FX",
          versions: [
            {
              fx: {
                from_currency: "CNY",
                to_currency: "USD",
                numerator: "1",
                denominator: "7",
                source: "fixture",
                effective_at: "2026-01-01T00:00:00Z",
              },
            },
          ],
        })
      ).status,
    ).toBe(200);
    let entered!: () => void;
    const enteredGate = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    harness.fetchMock.setHandler(async () => {
      entered();
      await gate;
      return response(3, 3);
    });
    const requests = Promise.all([call(), call(), call()]);
    const run = requests.then((value) => value);
    await enteredGate;
    await publish(book([rate("new", "uncached_input_tokens", "99", "1")]));
    const newHead = (await harness.agent.get(`${base}/bindings`)).body.head;
    await harness.agent.put(`${base}/fx`).send({
      catalog_revision: newHead.revision,
      confirm: true,
      scope: "workspace",
      reason: "Changed synthetic FX",
      versions: [],
    });
    release();
    expect((await run).every((response) => response.status === 200)).toBe(true);
    const costs = await summaries();
    expect(sum(costs.map((cost) => cost!.amount!))).toBe(
      "3.000000000000000000",
    );
    expect(
      costs.every(
        (cost) =>
          cost!.attempts[0].cost!.version_id === version &&
          cost!.attempts[0].cost!.fx_version_id,
      ),
    ).toBe(true);
  });

  it.each([false, true].flatMap(actual => [false, true].map(split => ({ actual, split }))))("keeps missing aggregate usage unknown rather than distributing a fabricated zero (actual=$actual,split=$split)", async ({ actual, split }) => {
    await publish();
    if (actual) await actualPolicy();
    harness.fetchMock.setHandler(async (_url, init) => {
      const input = JSON.parse(init.body as string).input as string | string[];
      return response(typeof input === "string" ? 1 : input.length, null);
    });
    // Force separate physical dispatches as well as concurrent admission; the
    // missing-usage contract must not depend on the runner's batching timing.
    const results = split
      ? [await call(), ...await Promise.all([call(), call()])]
      : await Promise.all([call(), call(), call()]);
    expect(results.map(result => result.status)).toEqual([200, 200, 200]);
    if (split) expect(harness.fetchMock.calls.length).toBeGreaterThanOrEqual(2);
    const costs = await summaries();
    expect(costs).toHaveLength(3);
    if (actual) {
      expect(costs.every(cost => cost!.reservations[0].state === "reserved")).toBe(true);
      expect(await harness.app.get(CostLedgerService).reconcileActualBudgets()).toEqual({ applied: 0, pending: 3, review_required: 0 });
    }
    expect(
      costs.every(
        (cost) => cost!.amount === null && cost!.unknown_attempts === 1,
      ),
    ).toBe(true);
  });

  it("keeps a successful provider response when allocation fails and records unknown cost without a paid retry", async () => {
    await publish();
    harness.fetchMock.setHandler(async () => response(3, 12));
    const original = allocation.allocateBatchCost;
    let once = true;
    jest
      .spyOn(allocation, "allocateBatchCost")
      .mockImplementation((...args) => {
        if (once) {
          once = false;
          throw new Error("synthetic allocation failure");
        }
        return original(...args);
      });
    const results = await Promise.all([call(), call(), call()]);
    expect(results.every((result) => result.status === 200)).toBe(true);
    expect(harness.fetchMock.calls).toHaveLength(1);
    expect(results.map((result) => result.body.usage.prompt_tokens)).toEqual([
      4, 4, 4,
    ]);
    const costs = await summaries();
    expect(
      costs.every(
        (cost) => cost!.amount === null && cost!.unknown_attempts === 1,
      ),
    ).toBe(true);
    expect(
      costs[0]!.attempts[0].cost!.batch!.physical_cost.diagnostics.some(
        (diagnostic) => diagnostic.path === "batch.allocation",
      ),
    ).toBe(true);
  });

  it("waits through a small wall-clock rollback before batching without changing the frozen timestamps or repeating paid work", async () => {
    await publish();
    const catalogs = await source.query("SELECT manifest_json FROM pricing_catalog_revisions");
    const createdAt = JSON.parse(catalogs[0].manifest_json).created_at as string;
    const created = Date.parse(createdAt);
    let now = created - 53;
    const clock = jest.spyOn(admissionClock, "readPricingAdmissionTime").mockImplementation(() => new Date(now));
    const repository = harness.app.get(PricingRepository) as unknown as {
      loadCatalog: (manager: EntityManager, id: string) => Promise<CompiledPricingCatalog>;
    };
    const load = repository.loadCatalog.bind(repository);
    let timer: ReturnType<typeof setTimeout> | undefined;
    jest.spyOn(repository, "loadCatalog").mockImplementationOnce(async (manager, id) => {
      const catalog = await load(manager, id);
      timer = setTimeout(() => { now = created + 10; }, 55);
      return catalog;
    });
    harness.fetchMock.setHandler(async (_url, init) => {
      const input = JSON.parse(String(init.body)).input;
      const count = Array.isArray(input) ? input.length : 1;
      return response(count, count * 4);
    });
    try {
      const results = await Promise.all([call("aaaa"), call("bbbb"), call("cccc")]);
      expect(results.map(result => result.status === 200 ? result.status : { status: result.status, body: result.body })).toEqual([200, 200, 200]);
      // Clock recovery can move requests across a batch window. Each original
      // input must be sent exactly once, whether coalesced or sent separately.
      expect(harness.fetchMock.calls.flatMap(call => call.body.input).sort()).toEqual(["aaaa", "bbbb", "cccc"]);
      const snapshots = await source.query("SELECT descriptor_json FROM pricing_request_snapshots");
      expect(snapshots).toHaveLength(3);
      for (const row of snapshots)
        expect(JSON.parse(row.descriptor_json).admitted_at).toBe(new Date(created + 10).toISOString());
      expect(await source.query("SELECT manifest_json FROM pricing_catalog_revisions")).toEqual(catalogs);
      const costs = await summaries();
      expect(costs.every(cost => cost!.reservations[0].state === "committed")).toBe(true);
    } finally {
      if (timer) clearTimeout(timer);
      clock.mockRestore();
    }
  });

  it("rejects excessive clock skew before provider dispatch with a stable unavailable code and no fabricated snapshot", async () => {
    await publish();
    const catalogs = await source.query("SELECT manifest_json FROM pricing_catalog_revisions");
    const created = Date.parse(JSON.parse(catalogs[0].manifest_json).created_at);
    const clock = jest.spyOn(admissionClock, "readPricingAdmissionTime").mockImplementation(() => new Date(created - 10001));
    try {
      const result = await call();
      expect(result.status).toBe(503);
      expect(result.body.error.code).toBe("pricing_clock_skew");
      expect(harness.fetchMock.calls).toHaveLength(0);
      expect(await source.query("SELECT * FROM pricing_request_snapshots")).toHaveLength(0);
      expect(await source.query("SELECT * FROM pricing_reservations")).toHaveLength(0);
      expect(await source.query("SELECT manifest_json FROM pricing_catalog_revisions")).toEqual(catalogs);
    } finally {
      clock.mockRestore();
    }
  });

  it("atomically retains the entire outcome when persistence fails, returns valid responses, then recovers without a second provider call", async () => {
    await publish();
    const ledger = harness.app.get(CostLedgerService);
    const original = ledger.completeAttemptGroup.bind(ledger);
    const write = jest
      .spyOn(ledger, "completeAttemptGroup")
      .mockRejectedValue(new Error("synthetic storage outage"));
    harness.fetchMock.setHandler(async () => response(3, 3));
    expect(
      (await Promise.all([call(), call(), call()])).every(
        (result) => result.status === 200,
      ),
    ).toBe(true);
    expect(
      (await summaries()).every(
        (cost) =>
          cost!.pending_attempts === 1 &&
          cost!.reservations[0].state === "reserved",
      ),
    ).toBe(true);
    expect(
      await harness.app.get(PricingRuntimeService).renewActiveLeases(),
    ).toBe(3);
    write.mockImplementation(original);
    await harness.app.get(PricedEmbeddingBatchingService).retryPending();
    expect(
      (await summaries()).every(
        (cost) =>
          cost!.pending_attempts === 0 &&
          cost!.reservations[0].state === "committed",
      ),
    ).toBe(true);
    expect(harness.fetchMock.calls).toHaveLength(1);
    expect(
      await harness.app.get(PricingRuntimeService).renewActiveLeases(),
    ).toBe(0);
  });

  it("recovers retained physical outcomes through a fresh ledger without its in-memory batch coordinator", async () => {
    await publish();
    const ledger = harness.app.get(CostLedgerService);
    const fault = jest
      .spyOn(ledger, "completeAttemptGroup")
      .mockRejectedValue(new Error("synthetic delivery outage"));
    harness.fetchMock.setHandler(async () => response(3, 3));
    expect(
      (await Promise.all([call(), call(), call()])).every(
        (result) => result.status === 200,
      ),
    ).toBe(true);
    const retained = await source.query(
      "SELECT * FROM pricing_runtime_group_outcomes",
    );
    expect(retained).toHaveLength(1);
    expect(retained[0].state).toBe("pending");
    const packed = JSON.parse(retained[0].document_json);
    expect(Object.keys(packed.blocks)).toHaveLength(1);
    fault.mockRestore();
    const fresh = new CostLedgerService(source, harness.app.get(BudgetService));
    await fresh.replayRuntimeGroupOutcomes(new Date(Date.now() + 120000));
    await fresh.reconcilePending();
    expect(
      (await summaries()).every(
        (cost) => cost?.reservations[0].state === "committed",
      ),
    ).toBe(true);
    await harness.app.get(PricedEmbeddingBatchingService).retryPending();
    expect(
      await harness.app.get(PricingRuntimeService).renewActiveLeases(),
    ).toBe(0);
    expect(harness.fetchMock.calls).toHaveLength(1);
    const inventory = await harness.agent.get(
      `${base}/runtime-group-outcomes?state=delivered`,
    );
    expect(inventory.status).toBe(200);
    expect(inventory.body.items).toHaveLength(1);
    expect(JSON.stringify(inventory.body)).not.toContain("physical_cost");
    const detail = await harness.agent.get(
      `${base}/runtime-group-outcomes/${retained[0].id}`,
    );
    expect(detail.status).toBe(200);
    expect(detail.body.supplier_confirmed).toBe(false);
    expect(detail.body.members).toHaveLength(3);
  });

  it("retains complete quarantined evidence without applying member budgets or renewing live ownership forever", async () => {
    await publish();
    const ledger = harness.app.get(CostLedgerService);
    const fault = jest
      .spyOn(ledger, "completeAttemptGroup")
      .mockRejectedValue(
        new PricingRepositoryError(
          "pricing_version_conflict",
          "synthetic immutable conflict",
          409,
        ),
      );
    harness.fetchMock.setHandler(async () => response(3, 3));
    expect(
      (await Promise.all([call(), call(), call()])).every(
        (result) => result.status === 200,
      ),
    ).toBe(true);
    fault.mockRestore();
    const retained = await source.query(
      "SELECT * FROM pricing_runtime_group_outcomes",
    );
    expect(retained).toHaveLength(1);
    expect(retained[0].state).toBe("review_required");
    expect(
      await source.query("SELECT * FROM pricing_settlement_intents"),
    ).toHaveLength(0);
    expect(
      (await summaries()).every(
        (cost) =>
          cost?.pending_attempts === 1 &&
          cost.reservations[0].state === "reserved",
      ),
    ).toBe(true);
    expect(
      await harness.app.get(PricingRuntimeService).renewActiveLeases(),
    ).toBe(0);
    expect(harness.fetchMock.calls).toHaveLength(1);
    const members = harness.app.get(WorkspaceMembershipService);
    await members.ensureMembership({
      userId: "synthetic-owner",
      organizationId: DEFAULT_ORGANIZATION_ID,
      workspaceId: DEFAULT_WORKSPACE_ID,
      role: "admin",
    });
    await members.ensureMembership({
      userId: "dashboard",
      organizationId: DEFAULT_ORGANIZATION_ID,
      workspaceId: DEFAULT_WORKSPACE_ID,
      role: "viewer",
    });
    expect(
      (await harness.agent.get(`${base}/runtime-group-outcomes`)).status,
    ).toBe(403);
    expect(
      (
        await harness.agent.get(
          `${base}/runtime-group-outcomes/${retained[0].id}`,
        )
      ).status,
    ).toBe(403);
  });

  it("keeps pre-retention failures in memory rather than claiming a durable recovery point", async () => {
    await publish();
    const ledger = harness.app.get(CostLedgerService);
    const fault = jest
      .spyOn(ledger, "retainRuntimeGroupOutcome")
      .mockRejectedValue(new Error("synthetic complete storage failure"));
    harness.fetchMock.setHandler(async () => response(3, 3));
    expect(
      (await Promise.all([call(), call(), call()])).every(
        (result) => result.status === 200,
      ),
    ).toBe(true);
    expect(
      await source.query("SELECT * FROM pricing_runtime_group_outcomes"),
    ).toHaveLength(0);
    expect(
      await harness.app.get(PricingRuntimeService).renewActiveLeases(),
    ).toBe(3);
    fault.mockRestore();
    await harness.app.get(PricedEmbeddingBatchingService).retryPending();
    expect(
      (await summaries()).every(
        (cost) => cost?.reservations[0].state === "committed",
      ),
    ).toBe(true);
    expect(harness.fetchMock.calls).toHaveLength(1);
  });

  it.each([false, true])("a cancelled client keeps its own fee share while the surviving member completes (actual=%s)", async actual => {
    await publish();
    if (actual) await actualPolicy();
    let entered!: () => void;
    const start = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let providerSignal: AbortSignal | null | undefined;
    harness.fetchMock.setHandler(async (_url, init) => {
      providerSignal = init.signal;
      entered();
      await gate;
      return response(2, 10, 200, actual);
    });
    const address = harness.app.getHttpServer().address();
    if (!address || typeof address === "string" || address.port === 2099)
      throw new Error("Invalid isolated listener");
    const cancelled = httpRequest({
      host: "127.0.0.1",
      port: address.port,
      method: "POST",
      path: "/v1/embeddings",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "content-type": "application/json",
      },
    });
    cancelled.on("error", () => undefined);
    cancelled.end(JSON.stringify({ model, input: "aaaa" }));
    const other = call("bbbb").then((value) => value);
    try {
      await start;
      cancelled.destroy();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(providerSignal?.aborted).toBe(false);
      expect(
        await harness.app.get(PricingRuntimeService).renewActiveLeases(),
      ).toBe(2);
      release();
      const result = await other;
      expect(result.status).toBe(200);
      expect(result.body.usage.prompt_tokens).toBe(5);
      const costs = await summaries();
      expect(sum(costs.map((cost) => cost!.amount!))).toBe(
        "0.100000000000000000",
      );
      expect(costs.map((cost) => cost!.reservations[0].state).sort()).toEqual(actual ? ["committed", "committed"] : ["committed", "released"]);
      expect(
        costs.some((cost) => cost!.attempts[0].error_code === "client_aborted"),
      ).toBe(true);
      expect(sum(costs.map((cost) => cost!.budget_committed_usd))).toBe(
        actual ? "0.100000000000000000" : "0.050000000000000000",
      );
    } finally {
      cancelled.destroy();
      release();
      await other;
    }
  });

  async function strictPolicy(limit = "100") {
    const head = (await harness.agent.get(`${base}/bindings`)).body.head;
    expect(
      (
        await harness.agent.put(`${base}/admission-policy`).send({
          catalog_revision: head.revision,
          confirm: true,
          scope: "workspace",
          operation: "embeddings",
          reason: "Synthetic strict batch policy",
          policy: {
            mode: "reserve_upper_bound",
            quantity_limits: {
              total_input_tokens: limit,
              output_tokens: "0",
            },
            limit_reference: "Synthetic supplier per-invocation cap",
          },
        })
      ).status,
    ).toBe(200);
  }

  it("combines only within declared physical limits and checks every allocated envelope against its reserved share", async () => {
    await publish();
    await strictPolicy("12");
    harness.fetchMock.setHandler(async (_url, init) => {
      const input = JSON.parse(init.body as string).input;
      return response(input.length, 12);
    });
    const results = await Promise.all([
      call([1, 2]),
      call([3, 4]),
      call([5, 6]),
    ]);
    expect(results.every((result) => result.status === 200)).toBe(true);
    expect(harness.fetchMock.calls).toHaveLength(1);
    const costs = await summaries();
    expect(
      costs.every(
        (cost) =>
          cost!.reservations[0].admission?.mode === "reserve_upper_bound",
      ),
    ).toBe(true);
    expect(sum(costs.map((cost) => cost!.amount!))).toBe(
      "0.120000000000000000",
    );
  });

  it("keeps independent requests when their combined input exceeds a physical supplier cap", async () => {
    await publish();
    await strictPolicy("4");
    harness.fetchMock.setHandler(async (_url, init) => {
      const input = JSON.parse(init.body as string).input;
      return response(typeof input[0] === "number" ? 1 : input.length, 2);
    });
    const results = await Promise.all([
      call([1, 2]),
      call([3, 4]),
      call([5, 6]),
    ]);
    expect(results.every((result) => result.status === 200)).toBe(true);
    expect(harness.fetchMock.calls).toHaveLength(3);
    expect(
      (await summaries()).every((cost) => !cost!.attempts[0].cost!.batch),
    ).toBe(true);
  });

  it("separates different API-key principals even when target and price are identical", async () => {
    await publish();
    harness.fetchMock.setHandler(async (_url, init) =>
      response(
        typeof JSON.parse(init.body as string).input === "string" ? 1 : 2,
        2,
      ),
    );
    const results = await Promise.all([
      call("aaaa", API_KEY),
      call("bbbb", API_KEY_2),
    ]);
    expect(results.every((result) => result.status === 200)).toBe(true);
    expect(harness.fetchMock.calls).toHaveLength(2);
  });

  it("preserves a missing member result’s allocated supplier fee without charging its logical budget", async () => {
    await publish();
    harness.app.get(ConfigService).getNode("mock-openai")!.embedding_models = [
      model,
    ];
    harness.fetchMock.setHandler(async () => response(2, 12));
    const results = await Promise.all([
      call("aaaa"),
      call("bbbb"),
      call("cccc"),
    ]);
    expect(results.filter((result) => result.status === 200)).toHaveLength(2);
    const costs = await summaries();
    expect(sum(costs.map((cost) => cost!.amount!))).toBe(
      "0.120000000000000000",
    );
    expect(
      costs.filter((cost) => cost!.reservations[0].state === "released"),
    ).toHaveLength(1);
    expect(sum(costs.map((cost) => cost!.budget_committed_usd))).toBe(
      "0.080000000000000000",
    );
  });

  it.each([false, true])("records outer retry batch attempts and never replaces a previous unknown fee with zero (actual=%s)", async actual => {
    await publish();
    if (actual) await actualPolicy();
    let count = 0;
    harness.fetchMock.setHandler(async () =>
      ++count === 1 ? response(3, null, 503) : response(3, 12, 200, actual),
    );
    expect(
      (await Promise.all([call(), call(), call()])).every(
        (result) => result.status === 200,
      ),
    ).toBe(true);
    const costs = await summaries();
    expect(harness.fetchMock.calls).toHaveLength(2);
    expect(
      costs.every(
        (cost) =>
          cost!.provider_attempts === 2 &&
          cost!.amount === null &&
          cost!.unknown_attempts === 1,
      ),
    ).toBe(true);
    expect(sum(costs.map((cost) => cost!.known_subtotal!))).toBe(
      "0.120000000000000000",
    );
    if (actual) expect(costs.every(cost => cost!.reservations[0].state === "reserved")).toBe(true);
  });

  it.each([false, true])("does not dispatch any member when the atomic preparation fails (actual=%s)", async actual => {
    await publish();
    if (actual) await actualPolicy();
    jest
      .spyOn(harness.app.get(CostLedgerService), "beginAttemptGroup")
      .mockRejectedValue(new Error("synthetic preparation failure"));
    const results = await Promise.all([call(), call(), call()]);
    expect(results.every((result) => result.status !== 200)).toBe(true);
    expect(harness.fetchMock.calls).toHaveLength(0);
    expect(await source.query("SELECT * FROM pricing_attempts")).toHaveLength(
      0,
    );
    expect(
      (await summaries()).every(
        (cost) => cost!.reservations[0].state === "released",
      ),
    ).toBe(true);
  });

  it("rejects isolated member corrections that would break batch conservation", async () => {
    await publish();
    harness.fetchMock.setHandler(async () => response(3, 12));
    await Promise.all([call(), call(), call()]);
    const original = (await summaries())[0]!;
    const attempt = original.attempts[0];
    const { randomUUID } = await import("node:crypto");
    await expect(
      harness.app.get(CostLedgerService).adjustAttempt({
        id: randomUUID(),
        attemptId: attempt.id,
        workspace: "default-workspace",
        expectedCostHash: attempt.cost_hash!,
        cost: attempt.cost!,
        actorId: "synthetic",
        source: "reconciliation",
        reason: "This must use group correction",
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it.each([false, true])("preserves unknown expense after all real clients cancel a shared in-flight request (actual=%s)", async actual => {
    await publish();
    if (actual) await actualPolicy();
    let entered!: () => void;
    const start = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let aborted = false;
    harness.fetchMock.setHandler(async (_url, init) => {
      entered();
      return new Promise((_resolve, reject) => {
        init.signal!.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(new DOMException("All clients cancelled", "AbortError"));
          },
          { once: true },
        );
      });
    });
    const address = harness.app.getHttpServer().address();
    if (!address || typeof address === "string" || address.port === 2099)
      throw new Error("Invalid test port");
    const clients = [0, 1].map(() => {
      const req = httpRequest({
        host: "127.0.0.1",
        port: address.port,
        method: "POST",
        path: "/v1/embeddings",
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          "content-type": "application/json",
        },
      });
      req.on("error", () => undefined);
      req.end(JSON.stringify({ model, input: "aaaa" }));
      return req;
    });
    try {
      await start;
      clients.forEach((req) => req.destroy());
      let costs = await summaries();
      for (
        let left = 100;
        left > 0 &&
        costs.some((cost) => cost!.reservations[0].state === "reserved");
        left--
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        costs = await summaries();
      }
      expect(aborted).toBe(true);
      expect(harness.fetchMock.calls).toHaveLength(1);
      expect(
        costs.every(
          (cost) =>
            cost!.amount === null &&
            cost!.unknown_attempts === 1 &&
            cost!.reservations[0].state === (actual ? "reserved" : "released"),
        ),
      ).toBe(true);
      expect(
        await harness.app.get(PricingRuntimeService).renewActiveLeases(),
      ).toBe(0);
    } finally {
      clients.forEach((req) => req.destroy());
    }
  });

  it("single-request base fees use the same successful invocation count as shared requests", async () => {
    await publish(
      book([
        rate("input", "uncached_input_tokens", "0.01", "1"),
        rate("base", "request_count", "0.03", "1"),
      ]),
    );
    harness.fetchMock.setHandler(async () => response(1, 4));
    expect((await call()).status).toBe(200);
    expect((await summaries())[0]!.amount).toBe("0.070000000000000000");
  });

  /** A correction fixture needs one physical batch, not a timing bet on HTTP admission within60ms. */
  async function alignedBatchCalls(inputs: string[]) {
    const batching = harness.app.get(PricedEmbeddingBatchingService);
    const enqueue = batching.enqueue.bind(batching);
    let arrived = 0, release!: () => void, reject!: (error: Error) => void;
    const ready = new Promise<void>((resolve, fail) => { release = resolve; reject = fail; });
    const timeout = setTimeout(() => reject(new Error("Synthetic batch members did not reach enqueue")), 2000);
    const gate = jest.spyOn(batching, "enqueue").mockImplementation(async (...args) => {
      arrived++;
      if (arrived === inputs.length) { clearTimeout(timeout); release(); }
      await ready;
      // The original method still captures each caller's async pricing context,
      // starts the real window timer, chooses groups and performs all persistence.
      return enqueue(...args);
    });
    try {
      const results = await Promise.all(inputs.map(input => call(input)));
      expect(arrived).toBe(inputs.length);
      expect(results.every(result => result.status === 200)).toBe(true);
      return results;
    } finally { clearTimeout(timeout); gate.mockRestore(); }
  }

  async function correctionFixture(completeEvidence = false) {
    const version = await publish();
    harness.fetchMock.setHandler(async (_url, init) => {
      expect(JSON.parse(String(init.body)).input).toHaveLength(3);
      return response(3, 12, 200, completeEvidence);
    });
    await alignedBatchCalls(["abcd", "abcd", "abcd"]);
    expect(harness.fetchMock.calls).toHaveLength(1);
    const costs = await summaries();
    expect(costs).toHaveLength(3);
    const attempt = costs[0]!.attempts[0];
    expect(costs.every(cost => cost!.attempts[0].cost!.batch!.physical_attempt_id === attempt.cost!.batch!.physical_attempt_id)).toBe(true);
    expect(attempt.cost!.batch!.members).toHaveLength(3);
    const body = {
      id: "http-batch-correction",
      expected_physical_cost_hash: attempt.cost!.batch!.physical_cost_hash,
      reason: "Synthetic administrator-verified usage",
      confirm: true,
      evidence: [
        {
          dimension: "total_input_tokens",
          value: "24",
          source: "request_metadata",
          quality: "observed",
        },
        {
          dimension: "uncached_input_tokens",
          value: "24",
          source: "request_metadata",
          quality: "observed",
        },
        {
          dimension: "output_tokens",
          value: "0",
          source: "request_metadata",
          quality: "observed",
        },
      ],
    };
    return {
      version,
      costs,
      attempt,
      body,
      path: `${base}/attempts/${attempt.id}/batch-correction`,
    };
  }

  it("recovers actual batch finality and receipts with a fresh ledger after coordinator delivery fails", async () => {
    await publish(); await actualPolicy();
    const ledger = harness.app.get(CostLedgerService);
    const fault = jest.spyOn(ledger, "completeAttemptGroup").mockRejectedValue(new Error("Synthetic actual group delivery outage"));
    harness.fetchMock.setHandler(async () => response(3, 12, 200, true));
    await alignedBatchCalls(["aaaa", "bbbb", "cccc"]);
    const retained = await source.query("SELECT kind,state FROM pricing_runtime_group_outcomes ORDER BY kind");
    expect(retained).toEqual([{ kind: "actual_budget_closure_group", state: "pending" }, { kind: "attempt_group", state: "pending" }]);
    expect((await summaries()).every(cost => cost!.reservations[0].state === "reserved")).toBe(true);
    fault.mockRestore();
    const fresh = new CostLedgerService(source, harness.app.get(BudgetService));
    await fresh.replayRuntimeGroupOutcomes(new Date(Date.now() + 120000));
    await fresh.reconcileActualBudgets();
    expect((await summaries()).every(cost => cost!.reservations[0].state === "committed")).toBe(true);
    expect(sum((await summaries()).map(cost => cost!.budget_committed_usd))).toBe("0.120000000000000000");
    await harness.app.get(PricedEmbeddingBatchingService).retryPending();
    await fresh.replayRuntimeGroupOutcomes(new Date(Date.now() + 240000));
    expect(await source.query("SELECT * FROM pricing_budget_effects WHERE kind = 'commit'")).toHaveLength(3);
    expect(harness.fetchMock.calls).toHaveLength(1);
  });

  it("charges actual paid shares even when a successful physical response omits one member result", async () => {
    await publish(); await actualPolicy();
    harness.app.get(ConfigService).getNode("mock-openai")!.embedding_models = [model];
    harness.fetchMock.setHandler(async () => response(2, 12, 200, true));
    const results = await Promise.all([call("aaaa"), call("bbbb"), call("cccc")]);
    expect(results.filter(result => result.status === 200)).toHaveLength(2);
    const costs = await summaries();
    expect(sum(costs.map(cost => cost!.known_subtotal!))).toBe("0.120000000000000000");
    const missing = costs.find(cost => cost!.attempts.some(attempt => attempt.error_code === "batch_member_result_missing"))!;
    const charged = missing.attempts.find(attempt => attempt.error_code === "batch_member_result_missing")!;
    expect(missing.reservations.find(row => row.id === charged.reservation_id)?.state).toBe("committed");
    expect(sum(costs.map(cost => cost!.budget_committed_usd))).toBe("0.120000000000000000");
    expect(harness.fetchMock.calls).toHaveLength(1);
  });

  it("preserves all paid retries in the actual batch budget and keeps an unknown prior failed attempt pending", async () => {
    await publish(); await actualPolicy();
    const node = harness.app.get(ConfigService).getNode("mock-openai")!;
    node.credentials = [{ id: "a", api_key: "synthetic-a" }, { id: "b", api_key: "synthetic-b" }];
    node.credential_pool = { enabled: true, strategy: "least_in_flight", retry_on_status: [429] };
    let calls = 0; harness.fetchMock.setHandler(async () => ++calls === 1 ? response(3, null, 429) : response(3, 12, 200, true));
    await alignedBatchCalls(["aaaa", "bbbb", "cccc"]);
    const costs = await summaries();
    expect(costs.every(cost => cost!.amount === null && cost!.reservations[0].state === "reserved" && cost!.provider_attempts === 2)).toBe(true);
    expect(sum(costs.map(cost => cost!.known_subtotal!))).toBe("0.120000000000000000");
    expect(await harness.app.get(CostLedgerService).reconcileActualBudgets()).toEqual({ applied: 0, pending: 3, review_required: 0 });
    expect(harness.fetchMock.calls).toHaveLength(2);
  });

  it("keeps manual physical corrections estimated under actual budget accounting", async () => {
    await actualPolicy();
    const { body, path } = await correctionFixture(true);
    const before = await source.query("SELECT * FROM budget_rules ORDER BY id");
    const preview = await harness.agent.post(`${path}/preview`).send(body);
    expect(preview.status === 201 ? 201 : preview.body).toBe(201);
    const result = await harness.agent.post(path).send(body);
    expect(result.status === 201 ? 201 : result.body).toBe(201);
    expect(await source.query("SELECT * FROM budget_rules ORDER BY id")).toEqual(before);
    expect(sum((await summaries()).map(cost => cost!.budget_committed_usd))).toBe("0.120000000000000000");
    expect(result.body.changes.every((change: { adjustment: { application: { budget_state: string } } }) => change.adjustment.application.budget_state === "pending")).toBe(true);
    expect(result.body.changes.every((change: { cost: { batch: { physical_cost: { evidence_status: string } } } }) => change.cost.batch.physical_cost.evidence_status === "estimated")).toBe(true);
    expect(harness.fetchMock.calls).toHaveLength(1);
  });
  it("keeps an uncached-input tariff estimated when an embedding response omits cache counters", async () => {
    await publish(); await actualPolicy();
    harness.fetchMock.setHandler(async () => response(3, 12));
    await alignedBatchCalls(["aaaa", "bbbb", "cccc"]);
    const costs = await summaries();
    expect(costs.every(cost => cost!.attempts[0].cost!.batch!.physical_cost.evidence_status === "estimated" && cost!.reservations[0].state === "reserved")).toBe(true);
    expect(sum(costs.map(cost => cost!.budget_committed_usd))).toBe("0.000000000000000000");
    expect(await harness.app.get(CostLedgerService).reconcileActualBudgets()).toEqual({ applied: 0, pending: 3, review_required: 0 });
    expect(harness.fetchMock.calls).toHaveLength(1);
  });
  it("commits paid failed actual batch attempts when every retry fails", async () => {
    await publish(); await actualPolicy();
    harness.app.get(ConfigService).getNode("mock-openai")!.embedding_models = [model];
    harness.fetchMock.setHandler(async () => response(3, 12, 503, true));
    const replies = await Promise.all([call("aaaa"), call("bbbb"), call("cccc")]);
    expect(replies.every(reply => reply.status >= 500)).toBe(true);
    const costs = await summaries();
    expect(harness.fetchMock.calls).toHaveLength(2);
    expect(costs.every(cost => cost!.provider_attempts === 2 && cost!.reservations[0].state === "committed")).toBe(true);
    expect(sum(costs.map(cost => cost!.budget_committed_usd))).toBe("0.240000000000000000");
    const closures = await source.query("SELECT state,outcome_json FROM pricing_runtime_outcomes WHERE kind = 'actual_budget_closure'");
    expect(closures).toHaveLength(3);
    for (const closure of closures) {
      expect(closure.state).toBe("delivered");
      expect(JSON.parse(closure.outcome_json).payload.receipts).toEqual([]);
      expect(JSON.parse(closure.outcome_json).payload.attempt_ids).toHaveLength(2);
    }
  });

  it("limits a correction to the actual two-member physical batch when another request arrives after its timer flush", async () => {
    await publish();
    harness.fetchMock.setHandler(async (_url, init) => {
      const input: unknown = JSON.parse(String(init.body)).input;
      const count = Array.isArray(input) ? input.length : 1;
      return response(count, count * 4);
    });
    // The real60ms window flushes these two entries. Only after they complete
    // does the third HTTP request arrive; no retry or artificial group merge.
    await alignedBatchCalls(["aaaa", "bbbb"]);
    const first = await summaries();
    expect(first).toHaveLength(2);
    expect(first.every(cost => cost!.attempts[0].cost!.batch!.members.length === 2)).toBe(true);
    expect((await call("cccc")).status).toBe(200);
    expect(harness.fetchMock.calls).toHaveLength(2);
    const all = await summaries();
    expect(all).toHaveLength(3);
    expect(sum(all.map(cost => cost!.amount!))).toBe("0.120000000000000000");
    const target = first[0]!.attempts[0];
    const preview = await harness.agent.post(`${base}/attempts/${target.id}/batch-correction/preview`).send({
      id: "two-member-window", expected_physical_cost_hash: target.cost!.batch!.physical_cost_hash,
      reason: "Synthetic physical batch scope", confirm: true,
      evidence: [
        { dimension: "total_input_tokens", value: "16", source: "request_metadata", quality: "observed" },
        { dimension: "uncached_input_tokens", value: "16", source: "request_metadata", quality: "observed" },
        { dimension: "output_tokens", value: "0", source: "request_metadata", quality: "observed" },
      ],
    });
    expect(preview.status).toBe(201);
    expect(preview.body.changes).toHaveLength(2);
    expect(preview.body.changes.map((change: { request_id: string }) => change.request_id).sort()).toEqual(first.map(cost => cost!.request_id).sort());
    expect(await summaries()).toEqual(all);
  });

  it("previews and applies a complete usage correction under the original price, updating every log once", async () => {
    const { version, attempt, body, path } = await correctionFixture();
    await publish(book([rate("changed", "uncached_input_tokens", "99", "1")]));
    const before = await source.query(
      "SELECT * FROM pricing_attempts ORDER BY id",
    );
    const previews = await source.query(
      "SELECT * FROM pricing_audit_events ORDER BY id",
    );
    const effects = await source.query(
      "SELECT * FROM pricing_adjustment_applications",
    );
    const preview = await harness.agent.post(`${path}/preview`).send(body);
    expect(preview.status).toBe(201);
    expect(preview.body.dry_run).toBe(true);
    expect(preview.body.changes).toHaveLength(3);
    expect(
      await source.query("SELECT * FROM pricing_attempts ORDER BY id"),
    ).toEqual(before);
    expect(
      await source.query("SELECT * FROM pricing_audit_events ORDER BY id"),
    ).toEqual(previews);
    expect(
      await source.query("SELECT * FROM pricing_adjustment_applications"),
    ).toEqual(effects);
    const applied = await harness.agent.post(path).send(body);
    expect(applied.status).toBe(201);
    expect(applied.body.replayed).toBe(false);
    const replay = await harness.agent.post(path).send(body);
    expect(replay.status).toBe(201);
    expect(replay.body.replayed).toBe(true);
    const costs = await summaries();
    expect(sum(costs.map((cost) => cost!.amount!))).toBe(
      "0.240000000000000000",
    );
    expect(sum(costs.map((cost) => cost!.budget_committed_usd))).toBe(
      "0.240000000000000000",
    );
    for (const cost of costs) {
      expect(cost!.attempts[0].cost!.version_id).toBe(version);
      expect(cost!.attempts[0].cost!.amount).toBe("0.040000000000000000");
      expect(cost!.attempts[0].effective_cost!.amount).toBe(
        "0.080000000000000000",
      );
      expect(cost!.attempts[0].adjustments).toHaveLength(1);
    }
    const logs = await source.query("SELECT cost_usd FROM call_logs");
    expect(logs).toHaveLength(3);
    expect(
      logs.every(
        (log: { cost_usd: number }) => Math.abs(log.cost_usd - 0.08) < 1e-10,
      ),
    ).toBe(true);
    expect(
      await source.query(
        "SELECT * FROM pricing_audit_events WHERE action = 'cost.batch_adjustment'",
      ),
    ).toHaveLength(1);
    expect(
      await source.query("SELECT * FROM pricing_attempts ORDER BY id"),
    ).toEqual(before);
    expect(harness.fetchMock.calls).toHaveLength(1);
    const originalHash = attempt.cost_hash;
    expect((await summaries())[0]!.attempts[0].cost_hash).toBe(originalHash);
  });

  it("rejects client-selected rates/members/actors, stale corrections and invalid physical quantities without writes", async () => {
    const { path, body } = await correctionFixture();
    for (const extra of [
      { workspace_id: "foreign" },
      { actorId: "other" },
      { physicalCost: {} },
      { members: [] },
      { confirm: false },
      { evidence: [{ dimension: "total_input_tokens", value: "-1" }] },
    ]) {
      expect(
        (await harness.agent.post(path).send({ ...body, ...extra })).status,
      ).toBe(400);
    }
    expect(
      (
        await harness.agent
          .post(path)
          .set("Origin", "https://foreign.invalid")
          .send(body)
      ).status,
    ).toBe(403);
    const changed = await harness.agent.post(path).send(body);
    expect(changed.status).toBe(201);
    expect(
      (await harness.agent.post(path).send({ ...body, id: "new-stale" }))
        .status,
    ).toBe(409);
    expect(
      (
        await harness.agent
          .post(path)
          .send({ ...body, reason: "Different idempotent evidence" })
      ).status,
    ).toBe(409);
    expect(
      await source.query("SELECT * FROM pricing_cost_adjustments"),
    ).toHaveLength(3);
    expect(harness.fetchMock.calls).toHaveLength(1);
  });

  it("never promotes administrator correction evidence to provider-reported provenance", async () => {
    const { path, body } = await correctionFixture();
    const result = await harness.agent.post(path).send({
      ...body,
      evidence: body.evidence.map((entry) => ({
        ...entry,
        source: "provider_usage",
      })),
    });
    expect(result.status).toBe(201);
    for (const change of result.body.changes) {
      const physical = change.cost.batch.physical_cost;
      expect(physical.usage.adapter_id).toBe("administrator-batch-correction");
      expect(
        Object.values(physical.usage.quantities).every(
          (quantity) =>
            (quantity as { source: string }).source === "request_metadata",
        ),
      ).toBe(true);
      expect(change.adjustment.application.source).toBe("reconciliation");
    }
    expect(harness.fetchMock.calls).toHaveLength(1);
  });

  it("requires administrator scope for both correction preview and mutation and hides foreign attempts", async () => {
    const { path, body, attempt } = await correctionFixture();
    const memberships = harness.app.get(WorkspaceMembershipService);
    // Keep a separate fixture admin before testing a downgraded Dashboard identity.
    await memberships.ensureMembership({
      userId: "synthetic-fixture-admin",
      organizationId: DEFAULT_ORGANIZATION_ID,
      workspaceId: DEFAULT_WORKSPACE_ID,
      role: "admin",
    });
    await memberships.ensureMembership({
      userId: "dashboard",
      organizationId: DEFAULT_ORGANIZATION_ID,
      workspaceId: DEFAULT_WORKSPACE_ID,
      role: "viewer",
    });
    try {
      expect(
        (await harness.agent.post(`${path}/preview`).send(body)).status,
      ).toBe(403);
      expect((await harness.agent.post(path).send(body)).status).toBe(403);
    } finally {
      await memberships.ensureMembership({
        userId: "dashboard",
        organizationId: DEFAULT_ORGANIZATION_ID,
        workspaceId: DEFAULT_WORKSPACE_ID,
        role: "admin",
      });
    }
    await source
      .createQueryBuilder()
      .update("pricing_attempts")
      .set({ workspace_id: "other-workspace" })
      .where("id = :id", { id: attempt.id })
      .execute();
    expect((await harness.agent.post(path).send(body)).status).toBe(404);
    expect(
      await source.query("SELECT * FROM pricing_cost_adjustments"),
    ).toHaveLength(0);
    expect(harness.fetchMock.calls).toHaveLength(1);
  });

  it("corrects the physical tier and preserves unsuccessful retry costs without charging them to the logical winner", async () => {
    const content = book([rate("input", "uncached_input_tokens", "0.01", "1")]);
    content.groups.push({
      id: "context",
      order: 1,
      required: false,
      rules: [
        {
          id: "large",
          priority: 0,
          mode: "whole_request",
          condition: { input_tokens: { min: "20" } },
          rates: [
            {
              operation: "replace",
              component: rate(
                "large-input",
                "uncached_input_tokens",
                "0.02",
                "1",
              ),
            },
          ],
        },
      ],
    });
    await publish(content);
    const node = harness.app.get(ConfigService).getNode("mock-openai")!;
    node.credentials = [
      { id: "a", api_key: "synthetic-a" },
      { id: "b", api_key: "synthetic-b" },
    ];
    node.credential_pool = {
      enabled: true,
      strategy: "least_in_flight",
      retry_on_status: [429],
    };
    let count = 0;
    harness.fetchMock.setHandler(async () =>
      response(3, 12, ++count === 1 ? 429 : 200),
    );
    await Promise.all([call(), call(), call()]);
    const costs = await summaries();
    const attempt = costs[0]!.attempts.find(
      (entry) => entry.error_code === "rate_limited",
    )!;
    const corrected = await harness.agent
      .post(`${base}/attempts/${attempt.id}/batch-correction`)
      .send({
        id: "failure-correction",
        expected_physical_cost_hash: attempt.cost!.batch!.physical_cost_hash,
        reason: "Synthetic billed failure usage",
        confirm: true,
        evidence: [
          { dimension: "uncached_input_tokens", value: "24" },
          { dimension: "total_input_tokens", value: "24" },
          { dimension: "output_tokens", value: "0" },
        ],
      });
    expect(corrected.status).toBe(201);
    const next = await summaries();
    expect(sum(next.map((cost) => cost!.amount!))).toBe("0.600000000000000000");
    expect(sum(next.map((cost) => cost!.budget_committed_usd))).toBe(
      "0.120000000000000000",
    );
    expect(harness.fetchMock.calls).toHaveLength(2);
  });

  it("does not apply batch budget corrections until original terminal effects finish", async () => {
    await publish();
    const ledger = harness.app.get(CostLedgerService);
    const apply = jest
      .spyOn(ledger, "applySettlement")
      .mockRejectedValue(new Error("original budget effect unavailable"));
    harness.fetchMock.setHandler(async () => response(3, 12));
    await Promise.all([call(), call(), call()]);
    const attempt = (await summaries())[0]!.attempts[0];
    const body = {
      id: "before-settlement",
      expected_physical_cost_hash: attempt.cost!.batch!.physical_cost_hash,
      reason: "synthetic",
      confirm: true,
      evidence: [{ dimension: "uncached_input_tokens", value: "24" }],
    };
    expect(
      (
        await harness.agent
          .post(`${base}/attempts/${attempt.id}/batch-correction`)
          .send(body)
      ).status,
    ).toBe(409);
    expect(
      await source.query("SELECT * FROM pricing_cost_adjustments"),
    ).toHaveLength(0);
    apply.mockRestore();
    await ledger.reconcilePending();
  });

  it("preserves the original FX version during actual administrator correction", async () => {
    const content = book([rate("cny", "uncached_input_tokens", "7", "1")]);
    content.currency = "CNY";
    await publish(content);
    let head = (await harness.agent.get(`${base}/bindings`)).body.head;
    await harness.agent.put(`${base}/fx`).send({
      catalog_revision: head.revision,
      scope: "workspace",
      reason: "synthetic FX",
      confirm: true,
      versions: [
        {
          fx: {
            from_currency: "CNY",
            to_currency: "USD",
            numerator: "1",
            denominator: "7",
            source: "synthetic",
            effective_at: "2026-01-01T00:00:00Z",
          },
        },
      ],
    });
    harness.fetchMock.setHandler(async () => response(3, 3));
    await Promise.all([call(), call(), call()]);
    const attempt = (await summaries())[0]!.attempts[0];
    head = (await harness.agent.get(`${base}/bindings`)).body.head;
    await harness.agent.put(`${base}/fx`).send({
      catalog_revision: head.revision,
      scope: "workspace",
      reason: "remove current FX",
      confirm: true,
      versions: [],
    });
    const changed = await harness.agent
      .post(`${base}/attempts/${attempt.id}/batch-correction`)
      .send({
        id: "frozen-fx",
        expected_physical_cost_hash: attempt.cost!.batch!.physical_cost_hash,
        reason: "Correct usage, not prices",
        confirm: true,
        evidence: [
          { dimension: "uncached_input_tokens", value: "6" },
          { dimension: "total_input_tokens", value: "6" },
          { dimension: "output_tokens", value: "0" },
        ],
      });
    expect(changed.status).toBe(201);
    const costs = await summaries();
    expect(sum(costs.map((cost) => cost!.amount!))).toBe(
      "6.000000000000000000",
    );
    expect(
      costs.every(
        (cost) =>
          cost!.attempts[0].effective_cost!.fx_version_id ===
          attempt.cost!.fx_version_id,
      ),
    ).toBe(true);
    expect(harness.fetchMock.calls).toHaveLength(1);
  });

  it("uses physical usage for read-only replay rather than repricing smaller shares", async () => {
    await publish();
    harness.fetchMock.setHandler(async () => response(3, 12));
    await Promise.all([call(), call(), call()]);
    const costs = await summaries();
    const content = book([rate("input", "uncached_input_tokens", "0.01", "1")]);
    content.groups.push({
      id: "tier",
      order: 1,
      required: false,
      rules: [
        {
          id: "large",
          priority: 0,
          mode: "whole_request",
          condition: { input_tokens: { min: "9" } },
          rates: [
            {
              operation: "replace",
              component: rate("large", "uncached_input_tokens", "0.02", "1"),
            },
          ],
        },
      ],
    });
    const before = await source.query("SELECT * FROM pricing_budget_effects");
    const replay = await harness.agent
      .post(`${base}/replay`)
      .send({ request_ids: costs.map((cost) => cost!.request_id), content });
    expect(replay.status).toBe(201);
    expect(
      sum(
        replay.body.results.map(
          (result: {
            simulations: { simulated: { report_amount: string } }[];
          }) => result.simulations[0].simulated.report_amount,
        ),
      ),
    ).toBe("0.240000000000000000");
    expect(await source.query("SELECT * FROM pricing_budget_effects")).toEqual(
      before,
    );
    expect(harness.fetchMock.calls).toHaveLength(1);
  });
});

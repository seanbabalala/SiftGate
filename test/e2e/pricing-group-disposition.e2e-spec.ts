import { DataSource } from "typeorm";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as yaml from "js-yaml";
import {
  createE2EHarness,
  API_KEY,
  FIXTURE_PATH,
  type E2EHarness,
} from "./setup";
import { applyPricingSchema } from "../../src/pricing/pricing-schema";
import { CostLedgerService } from "../../src/pricing/cost-ledger.service";
import { PricingRecoveryService } from "../../src/pricing/pricing-recovery.service";
import { PricedEmbeddingBatchingService } from "../../src/pricing/priced-embedding-batching.service";
import { WorkspaceMembershipService } from "../../src/auth/workspace-membership.service";
import { PricingRepository } from "../../src/pricing/pricing-repository";
import { PricingRepositoryError } from "../../src/pricing/pricing-repository.types";
import { readRuntimeGroupDocument } from "../../src/pricing/pricing-group-outcome-document";
import {
  allocateBatchCost,
  batchShareCost,
} from "../../src/pricing/cost-allocation";
import type {
  CostAttemptRow,
  AttemptPriceContext,
} from "../../src/pricing/cost-ledger.types";
import type { GroupDispositionResult } from "../../src/pricing/pricing-group-disposition.types";
import { book, rate } from "../unit/pricing-fixtures";

const root = "/api/dashboard/pricing",
  workspace = "default-workspace",
  model = "text-embedding-3-small";
describe("complete-group disposition over isolated real HTTP", () => {
  let harness: E2EHarness,
    source: DataSource,
    ledger: CostLedgerService,
    directory: string;
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "group-disposition-http-"));
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
      max_batch_size: 2,
      max_input_items: 8,
      max_queue: 100,
      timeout_ms: 2000,
    };
    const file = join(directory, "config.yaml");
    writeFileSync(file, yaml.dump(config));
    harness = await createE2EHarness(file);
    source = harness.app.get(DataSource);
    ledger = harness.app.get(CostLedgerService);
    await harness.app.get(PricingRecoveryService).onModuleDestroy();
    await applyPricingSchema(source);
    harness.fetchMock.setHandler(async (_url, init) => {
      const input = JSON.parse(init.body as string).input;
      return new Response(
        JSON.stringify({
          model,
          data: input.map((_: unknown, index: number) => ({
            index,
            embedding: [index],
          })),
          usage: { prompt_tokens: 12, total_tokens: 12 },
        }),
        { headers: { "content-type": "application/json" } },
      );
    });
  }, 30000);
  afterEach(async () => {
    jest.restoreAllMocks();
    await harness?.close();
    rmSync(directory, { recursive: true, force: true });
  });

  async function publish(currency = "USD", amount = "0.01") {
    const content = book([rate("input", "uncached_input_tokens", amount, "1")]);
    content.currency = currency;
    const created = await harness.agent
      .post(`${root}/books`)
      .send({ name: "Synthetic complete group", content });
    expect(created.status).toBe(201);
    const head = (await harness.agent.get(`${root}/bindings`)).body.head;
    const result = await harness.agent
      .post(`${root}/drafts/${created.body.draft.id}/publish`)
      .send({
        draft_revision: 1,
        catalog_revision: head.revision,
        reason: "Synthetic rates only",
        confirm: true,
        targets: [{ level: "model", model, operation: "embeddings" }],
      });
    expect(result.status).toBe(201);
  }
  async function fx(versions: unknown[]) {
    const head = (await harness.agent.get(`${root}/bindings`)).body.head;
    expect(
      (
        await harness.agent.put(`${root}/fx`).send({
          catalog_revision: head.revision,
          scope: "workspace",
          reason: "Synthetic FX only",
          confirm: true,
          versions,
        })
      ).status,
    ).toBe(200);
  }
  async function seed(missing = false, currency = "USD") {
    await publish(currency);
    if (currency === "CNY")
      await fx([
        {
          fx: {
            from_currency: "CNY",
            to_currency: "USD",
            numerator: "1",
            denominator: "7",
            source: "synthetic",
            effective_at: "2020-01-01T00:00:00Z",
          },
        },
      ]);
    // Gate initial admissions, not a wall-clock sleep; each await preserves its request context.
    const batching = harness.app.get(PricedEmbeddingBatchingService),
      enqueue = batching.enqueue.bind(batching);
    let entered = 0,
      release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    const barrier = jest
      .spyOn(batching, "enqueue")
      .mockImplementation(async (...args) => {
        if (++entered === 2) release();
        await ready;
        return enqueue(...args);
      });
    const fault = missing
      ? jest
          .spyOn(ledger, "completeAttemptGroup")
          .mockRejectedValue(
            new PricingRepositoryError(
              "pricing_version_conflict",
              "synthetic delivery quarantine",
              409,
            ),
          )
      : null;
    try {
      const call = () =>
        harness.agent
          .post("/v1/embeddings")
          .set("Authorization", `Bearer ${API_KEY}`)
          .send({ model, input: "PRIVATE_EMBEDDING_NOT_ACCOUNTING" });
      expect(
        (await Promise.all([call(), call()])).map(
          (response) => response.status,
        ),
      ).toEqual([200, 200]);
    } finally {
      barrier.mockRestore();
      fault?.mockRestore();
    }
    expect(harness.fetchMock.calls).toHaveLength(1);
    await source
      .createQueryBuilder()
      .update("pricing_reservations")
      .set({ lease_until: new Date(Date.now() - 60000).toISOString() })
      .execute();
    const retained = await source.query(
      "SELECT * FROM pricing_runtime_group_outcomes",
    );
    expect(retained).toHaveLength(1);
    const outcome = readRuntimeGroupDocument(retained[0].document_json).outcome;
    if (outcome.type !== "attempt_group")
      throw new Error("Expected physical group fixture");
    let id = retained[0].id as string;
    if (!missing) {
      const row = (await source
        .createQueryBuilder()
        .select("a.*")
        .from("pricing_attempts", "a")
        .where("a.id = :id", { id: outcome.entries[0].id })
        .getRawOne()) as CostAttemptRow;
      const context = JSON.parse(row.price_context_json) as AttemptPriceContext;
      const original = outcome.entries[0].cost.batch!.physical_cost;
      const usage = structuredClone(original.usage);
      usage.quantities.total_input_tokens!.value = "24";
      usage.quantities.uncached_input_tokens!.value = "24";
      const snapshot = await harness.app
        .get(PricingRepository)
        .restoreRequest(row.request_id, workspace);
      const cost = snapshot.quote(
        { node_id: row.node_id, model: row.model, operation: "embeddings" },
        usage,
        { ...context.context, attempt_dispatched_at: row.dispatched_at },
      ).cost;
      cost.attribution = original.attribution;
      const batch = outcome.entries[0].cost.batch!,
        allocation = allocateBatchCost(batch.batch_id, cost, batch.members);
      for (const entry of outcome.entries) {
        entry.cost = batchShareCost(
          allocation,
          entry.cost.batch!.member_index,
          batch.physical_attempt_id,
        );
        if (entry.settlement) {
          entry.settlement.cost_usd = "99"; // Custody, never an instruction to charge99.
          if (entry.settlement.receipt?.attemptId === entry.id)
            entry.settlement.receipt.cost = entry.cost;
          for (const receipt of entry.settlement.receipts ?? [])
            if (receipt.attemptId === entry.id) receipt.cost = entry.cost;
        }
      }
      id = (await ledger.retainRuntimeGroupOutcome(outcome)).id;
    }
    const path = `${root}/runtime-group-outcomes/${id}`;
    const basis = await harness.agent.get(`${path}/disposition-basis`);
    expect(basis.status).toBe(200);
    expect(basis.body.blocked_reason).toBeNull();
    expect(basis.body.acceptance_blocked_reason).toBeNull();
    expect(JSON.stringify(basis.body)).not.toContain(
      "PRIVATE_EMBEDDING_NOT_ACCOUNTING",
    );
    return {
      id,
      path,
      outcome,
      body: {
        id: "synthetic-group-operation",
        expected_basis_hash: basis.body.basis_hash,
        expected_outcome_hash: basis.body.outcome_hash,
        action: "accept_receipts",
        reason: "Reviewed the complete retained physical group",
        confirm: true,
      },
    };
  }
  async function dump() {
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
  }
  it("previews the whole physical group without writes and applies conserved original-price corrections", async () => {
    const { path, body } = await seed(),
      before = await dump();
    const preview = await harness.agent
      .post(`${path}/disposition/preview`)
      .send(body);
    expect({ status: preview.status, error: preview.body.error }).toEqual({
      status: 201,
      error: undefined,
    });
    expect(preview.body.changes).toHaveLength(2);
    expect(
      preview.body.changes.every(
        (change: GroupDispositionResult["changes"][number]) =>
          change.operation === "linked_correction" &&
          change.budget.cost_delta === "0.060000000000000000",
      ),
    ).toBe(true);
    expect(await dump()).toEqual(before);
    const result = await harness.agent.post(`${path}/disposition`).send(body);
    expect({ status: result.status, error: result.body.error }).toMatchObject({
      status: 201,
    });
    expect(
      result.body.changes.map(
        (change: GroupDispositionResult["changes"][number]) => change.budget,
      ),
    ).toEqual(
      preview.body.changes.map(
        (change: GroupDispositionResult["changes"][number]) => change.budget,
      ),
    );
    const after = await dump();
    for (const table of [
      "pricing_attempts",
      "pricing_settlement_intents",
      "pricing_runtime_group_outcomes",
      "pricing_runtime_group_outcome_members",
    ])
      expect(after[table]).toEqual(before[table]);
    expect(
      (await source.query("SELECT cost_usd FROM call_logs")).map(
        (log: { cost_usd: number }) => log.cost_usd,
      ),
    ).toEqual([0.12, 0.12]);
    expect(harness.fetchMock.calls).toHaveLength(1);
  });
  it("adopts missing complete receipts without applying retained member budget proposals", async () => {
    const { path, body } = await seed(true),
      before = await dump();
    const result = await harness.agent.post(`${path}/disposition`).send(body);
    expect(result.status).toBe(201);
    expect(
      result.body.changes.every(
        (change: GroupDispositionResult["changes"][number]) =>
          change.operation === "initial_receipt" &&
          change.budget.budget_state === "not_applicable",
      ),
    ).toBe(true);
    const after = await dump();
    for (const table of [
      "pricing_reservations",
      "pricing_settlement_intents",
      "pricing_budget_effects",
      "budget_rules",
    ])
      expect(after[table]).toEqual(before[table]);
    expect(
      (await source.query("SELECT state FROM pricing_attempts")).map(
        (row: { state: string }) => row.state,
      ),
    ).toEqual(["terminal", "terminal"]);
    expect(harness.fetchMock.calls).toHaveLength(1);
  });
  it("recovers a lost successful response using exact retry and a read-only group acknowledgement", async () => {
    const { path, body } = await seed(),
      write = ledger.disposeGroupOutcome.bind(ledger);
    jest
      .spyOn(ledger, "disposeGroupOutcome")
      .mockImplementationOnce(async (...args) => {
        await write(...args);
        throw new Error("synthetic lost group reply");
      });
    expect(
      (await harness.agent.post(`${path}/disposition`).send(body)).status,
    ).toBe(500);
    const before = await dump();
    const ack = await harness.agent.get(`${path}/dispositions/${body.id}`);
    expect(ack.status).toBe(200);
    expect(ack.body.result.replayed).toBe(true);
    const retry = await harness.agent.post(`${path}/disposition`).send(body);
    expect(retry.status).toBe(201);
    expect(retry.body.changes).toEqual(ack.body.result.changes);
    expect(await dump()).toEqual(before);
    expect(
      await source.query("SELECT * FROM pricing_cost_adjustments"),
    ).toHaveLength(2);
    expect(harness.fetchMock.calls).toHaveLength(1);
  });
  it("records a separate rejection while retaining source custody and accounting unchanged", async () => {
    const { path, body, id } = await seed(),
      before = await dump();
    const result = await harness.agent
      .post(`${path}/disposition`)
      .send({ ...body, action: "reject_evidence" });
    expect(result.status).toBe(201);
    expect(result.body.changes).toEqual([]);
    const after = await dump();
    for (const table of Object.keys(before).filter(
      (table) =>
        ![
          "pricing_audit_events",
          "pricing_runtime_group_dispositions",
        ].includes(table),
    ))
      expect(after[table]).toEqual(before[table]);
    const inventory = await harness.agent.get(`${root}/runtime-group-outcomes`);
    expect(
      inventory.body.items.find((row: { id: string }) => row.id === id)
        .disposition,
    ).toMatchObject({ id: body.id, action: "reject_evidence" });
  });
  it("rejects client money/source/actor/member subsets, missing consent and cross-origin writes", async () => {
    const { path, body } = await seed(),
      before = await dump();
    for (const extra of [
      { confirm: false },
      { cost: "0" },
      { source: "supplier_confirmed" },
      { actor_id: "other" },
      { attempt_ids: [] },
      { evidence: [] },
    ])
      expect(
        (
          await harness.agent
            .post(`${path}/disposition`)
            .send({ ...body, ...extra })
        ).status,
      ).toBe(400);
    for (const route of ["disposition/preview", "disposition"])
      expect(
        (
          await harness.agent
            .post(`${path}/${route}`)
            .set("Origin", "https://untrusted.example")
            .send(body)
        ).status,
      ).toBe(403);
    expect(await dump()).toEqual(before);
  });
  it("fences stale sibling evidence without selecting the latest variant automatically", async () => {
    const { path, body, outcome } = await seed();
    outcome.entries[0].errorCode = "synthetic-later-observation";
    await ledger.retainRuntimeGroupOutcome(outcome);
    const before = await dump();
    expect(
      (await harness.agent.post(`${path}/disposition`).send(body)).status,
    ).toBe(409);
    expect(await dump()).toEqual(before);
  });
  it("keeps original CNY price and FX when current rates are replaced and the FX is removed", async () => {
    const { path, body } = await seed(false, "CNY");
    await publish("USD", "2");
    await fx([]);
    const result = await harness.agent.post(`${path}/disposition`).send(body);
    expect(result.status).toBe(201);
    expect(
      result.body.changes.every(
        (change: GroupDispositionResult["changes"][number]) =>
          change.cost.currency === "CNY" &&
          change.cost.fx_version_id &&
          Number(change.cost.report_amount) < 0.02,
      ),
    ).toBe(true);
    expect(harness.fetchMock.calls).toHaveLength(1);
  });
  it("enforces workspace scope, operator read-only access and viewer denial", async () => {
    const { path, body } = await seed();
    expect(
      (await harness.agent.post(`${path}/disposition`).send(body)).status,
    ).toBe(201);
    const other = await harness.agent
      .post("/api/dashboard/workspaces")
      .send({ name: "Synthetic other group workspace" });
    expect(other.status).toBe(201);
    for (const route of ["disposition-basis", `dispositions/${body.id}`])
      expect(
        (
          await harness.agent
            .get(`${path}/${route}`)
            .set("x-siftgate-workspace-id", other.body.item.id)
        ).status,
      ).toBe(404);
    const members = harness.app.get(WorkspaceMembershipService);
    await members.ensureMembership({
      userId: "backup-admin",
      workspaceId: workspace,
      organizationId: "default-org",
      role: "admin",
    });
    await members.ensureMembership({
      userId: "dashboard",
      workspaceId: workspace,
      organizationId: "default-org",
      role: "operator",
    });
    for (const route of ["disposition-basis", `dispositions/${body.id}`])
      expect((await harness.agent.get(`${path}/${route}`)).status).toBe(200);
    for (const route of ["disposition/preview", "disposition"])
      expect(
        (await harness.agent.post(`${path}/${route}`).send(body)).status,
      ).toBe(403);
    await members.ensureMembership({
      userId: "dashboard",
      workspaceId: workspace,
      organizationId: "default-org",
      role: "viewer",
    });
    for (const route of ["disposition-basis", `dispositions/${body.id}`])
      expect((await harness.agent.get(`${path}/${route}`)).status).toBe(403);
  });
  it("rolls back every member and budget when mandatory log projection fails", async () => {
    const { path, body } = await seed(),
      before = await dump();
    const observer = ledger as unknown as {
      projectCallLogs(...args: unknown[]): Promise<void>;
    };
    jest
      .spyOn(observer, "projectCallLogs")
      .mockRejectedValueOnce(new Error("synthetic group projection outage"));
    expect(
      (await harness.agent.post(`${path}/disposition`).send(body)).status,
    ).toBe(500);
    expect(await dump()).toEqual(before);
    expect(
      (await harness.agent.post(`${path}/disposition`).send(body)).status,
    ).toBe(201);
    expect(harness.fetchMock.calls).toHaveLength(1);
  });
});

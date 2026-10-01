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
import { WorkspaceMembershipService } from "../../src/auth/workspace-membership.service";
import { PricingRepository } from "../../src/pricing/pricing-repository";
import { runtimeOutcomeDocument } from "../../src/pricing/pricing-outcome-document";
import type {
  CostAttemptRow,
  AttemptPriceContext,
} from "../../src/pricing/cost-ledger.types";
import type { CostComputation } from "../../src/pricing/pricing.types";
import type { PricingOutcome } from "../../src/pricing/pricing-outcome-retry";
import { tokenBook } from "../unit/pricing-fixtures";

const root = "/api/dashboard/pricing",
  workspace = "default-workspace";
describe("audited retained outcome disposition over isolated HTTP", () => {
  let harness: E2EHarness,
    source: DataSource,
    ledger: CostLedgerService,
    directory: string;
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "outcome-disposition-http-"));
    const config = yaml.load(readFileSync(FIXTURE_PATH, "utf8")) as Record<
      string,
      unknown
    >;
    config.budget = {
      daily_token_limit: 10000000,
      daily_cost_limit: 1000,
      alert_threshold: 0.8,
    };
    const file = join(directory, "config.yaml");
    writeFileSync(file, yaml.dump(config));
    harness = await createE2EHarness(file);
    source = harness.app.get(DataSource);
    ledger = harness.app.get(CostLedgerService);
    await harness.app.get(PricingRecoveryService).onModuleDestroy();
    await applyPricingSchema(source);
    const created = await harness.agent
      .post(`${root}/books`)
      .send({ name: "Synthetic runtime rates", content: tokenBook() });
    expect(created.status).toBe(201);
    expect(
      (
        await harness.agent
          .post(`${root}/drafts/${created.body.draft.id}/publish`)
          .send({
            draft_revision: 1,
            catalog_revision: 0,
            reason: "Synthetic test only",
            confirm: true,
            targets: [{ level: "model", model: "gpt-4o" }],
          })
      ).status,
    ).toBe(201);
    harness.fetchMock.setHandler(
      async () =>
        new Response(
          JSON.stringify({
            id: "synthetic",
            model: "gpt-4o",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: "PRIVATE_RESPONSE_NOT_ACCOUNTING",
                },
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 5,
              prompt_tokens_details: { cached_tokens: 0 },
              cache_creation_input_tokens: 0,
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
  }, 30000);
  afterEach(async () => {
    jest.restoreAllMocks();
    await harness?.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const call = () =>
    harness.agent
      .post("/v1/chat/completions")
      .set("Authorization", `Bearer ${API_KEY}`)
      .send({
        model: "gpt-4o",
        max_tokens: 20,
        messages: [{ role: "user", content: "PRIVATE_PROMPT_NOT_ACCOUNTING" }],
      });

  async function seed() {
    expect((await call()).status).toBe(200);
    await source
      .createQueryBuilder()
      .update("pricing_reservations")
      .set({ lease_until: new Date(Date.now() - 60000).toISOString() })
      .execute();
    const row = (
      await source.query("SELECT * FROM pricing_attempts")
    )[0] as CostAttemptRow;
    const original = JSON.parse(row.cost_json!) as CostComputation,
      context = JSON.parse(row.price_context_json) as AttemptPriceContext;
    const usage = structuredClone(original.usage);
    usage.quantities.total_input_tokens!.value = "20";
    usage.quantities.uncached_input_tokens!.value = "20";
    const snapshot = await harness.app
      .get(PricingRepository)
      .restoreRequest(row.request_id, workspace);
    const cost = snapshot.quote(
      { node_id: row.node_id, model: row.model },
      usage,
      { ...context.context, attempt_dispatched_at: row.dispatched_at },
    ).cost;
    cost.attribution = original.attribution;
    const outcome: PricingOutcome = {
      type: "attempt",
      workspace,
      reservationId: row.reservation_id!,
      attemptId: row.id,
      cost,
      errorCode: row.error_code,
    };
    await ledger.archiveRuntimeOutcome(outcome);
    const id = runtimeOutcomeDocument(outcome).id,
      path = `${root}/runtime-outcomes/${id}`;
    const basis = await harness.agent.get(`${path}/disposition-basis`);
    expect(basis.status).toBe(200);
    return {
      path,
      id,
      row,
      outcome,
      body: {
        id: "synthetic-disposition",
        action: "accept_receipts",
        expected_basis_hash: basis.body.basis_hash,
        expected_outcome_hash: basis.body.outcome_hash,
        reason: "Reviewed retained runtime observation",
        confirm: true,
      },
    };
  }
  async function dump() {
    const state: Record<string, unknown> = {};
    for (const table of [
      "pricing_runtime_outcomes",
      "pricing_runtime_outcome_dispositions",
      "pricing_audit_events",
      "pricing_attempts",
      "pricing_cost_adjustments",
      "pricing_adjustment_applications",
      "pricing_settlement_intents",
      "pricing_reservations",
      "pricing_budget_balances",
      "budget_rules",
      "call_logs",
    ])
      state[table] = await source.query(`SELECT * FROM ${table}`);
    return state;
  }
  it("previews without writes then atomically applies a linked correction and log projection", async () => {
    const { path, body, row } = await seed(),
      before = await dump();
    const preview = await harness.agent
      .post(`${path}/disposition/preview`)
      .send(body);
    expect(preview.status).toBe(201);
    expect(preview.body.changes[0]).toMatchObject({
      operation: "linked_correction",
      budget: { cost_delta: "0.000010000000000000", tokens_delta: "10" },
    });
    expect(await dump()).toEqual(before);
    const applied = await harness.agent.post(`${path}/disposition`).send(body);
    expect(applied.status).toBe(201);
    expect(applied.body).toMatchObject({
      supplier_confirmed: false,
      budget_decision_unchanged: true,
      outcome_document_modified: false,
    });
    expect(applied.body.changes[0].budget).toEqual(
      preview.body.changes[0].budget,
    );
    const after = await dump();
    for (const table of [
      "pricing_attempts",
      "pricing_settlement_intents",
      "pricing_runtime_outcomes",
    ])
      expect(after[table]).toEqual(before[table]);
    expect(
      (await ledger.summary(row.request_id, workspace))!.budget_committed_usd,
    ).toBe("0.000030000000000000");
    const logs = await source.query("SELECT * FROM call_logs");
    expect(logs[0].cost_usd).toBe(0.00003);
    expect(harness.fetchMock.calls).toHaveLength(1);
  });
  it("recovers a lost successful reply with exact retry and read-only acknowledgement", async () => {
    const { path, body } = await seed(),
      write = ledger.disposeRuntimeOutcome.bind(ledger);
    jest
      .spyOn(ledger, "disposeRuntimeOutcome")
      .mockImplementationOnce(async (...args) => {
        await write(...args);
        throw new Error("synthetic lost disposition response");
      });
    expect(
      (await harness.agent.post(`${path}/disposition`).send(body)).status,
    ).toBe(500);
    const before = await dump();
    expect(
      (await harness.agent.get(`${path}/dispositions/${body.id}`)).body.result
        .replayed,
    ).toBe(true);
    expect(
      (await harness.agent.post(`${path}/disposition`).send(body)).body
        .replayed,
    ).toBe(true);
    expect(await dump()).toEqual(before);
    expect(
      await source.query("SELECT * FROM pricing_cost_adjustments"),
    ).toHaveLength(1);
    expect(harness.fetchMock.calls).toHaveLength(1);
  });
  it("records rejection without changing original costs, budget or retained bytes", async () => {
    const { path, body } = await seed(),
      before = await dump();
    const result = await harness.agent
      .post(`${path}/disposition`)
      .send({ ...body, action: "reject_evidence" });
    expect(result.status).toBe(201);
    expect(result.body.changes).toEqual([]);
    const after = await dump();
    for (const table of [
      "pricing_runtime_outcomes",
      "pricing_attempts",
      "pricing_reservations",
      "budget_rules",
      "call_logs",
    ])
      expect(after[table]).toEqual(before[table]);
    const inventory = await harness.agent.get(`${root}/runtime-outcomes`);
    expect(inventory.body.items[0].disposition).toMatchObject({
      id: body.id,
      action: "reject_evidence",
    });
  });
  it("requires explicit confirmation and rejects client money/source/actor and untrusted origins", async () => {
    const { path, body } = await seed();
    for (const extra of [
      { confirm: false },
      { cost: { report_amount: "0" } },
      { source: "provider_usage" },
      { actor_id: "other" },
      { evidence: [] },
    ])
      expect(
        (
          await harness.agent
            .post(`${path}/disposition`)
            .send({ ...body, ...extra })
        ).status,
      ).toBe(400);
    expect(
      (
        await harness.agent
          .post(`${path}/disposition`)
          .set("Origin", "https://untrusted.example")
          .send(body)
      ).status,
    ).toBe(403);
    expect(
      await source.query("SELECT * FROM pricing_runtime_outcome_dispositions"),
    ).toEqual([]);
  });
  it("rejects a stale sibling basis rather than choosing the newest outcome automatically", async () => {
    const { path, body, outcome } = await seed();
    await ledger.archiveRuntimeOutcome({
      ...outcome,
      errorCode: "distinct-late",
    });
    expect(
      (await harness.agent.post(`${path}/disposition`).send(body)).status,
    ).toBe(409);
    expect(
      await source.query("SELECT * FROM pricing_runtime_outcome_dispositions"),
    ).toEqual([]);
    expect(harness.fetchMock.calls).toHaveLength(1);
  });
  it("enforces operator read-only and viewer denial for basis, preview, write and acknowledgement", async () => {
    const { path, body } = await seed(),
      members = harness.app.get(WorkspaceMembershipService);
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
    expect((await harness.agent.get(`${path}/disposition-basis`)).status).toBe(
      200,
    );
    expect(
      (await harness.agent.post(`${path}/disposition/preview`).send(body))
        .status,
    ).toBe(403);
    expect(
      (await harness.agent.post(`${path}/disposition`).send(body)).status,
    ).toBe(403);
    await members.ensureMembership({
      userId: "dashboard",
      workspaceId: workspace,
      organizationId: "default-org",
      role: "viewer",
    });
    expect((await harness.agent.get(`${path}/disposition-basis`)).status).toBe(
      403,
    );
    expect(
      (await harness.agent.get(`${path}/dispositions/${body.id}`)).status,
    ).toBe(403);
  });
  it("rolls back ledger and disposition when the mandatory log projection fails", async () => {
    const { path, body } = await seed(),
      before = await dump();
    const observer = ledger as unknown as {
      projectCallLogs(...args: unknown[]): Promise<void>;
    };
    jest
      .spyOn(observer, "projectCallLogs")
      .mockRejectedValueOnce(new Error("synthetic projection unavailable"));
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

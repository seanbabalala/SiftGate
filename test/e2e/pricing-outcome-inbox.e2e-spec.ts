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
import { PricingRuntimeService } from "../../src/pricing/pricing-runtime.service";
import { WorkspaceMembershipService } from "../../src/auth/workspace-membership.service";
import type { RuntimeOutcomeRow } from "../../src/pricing/pricing-outcome-inbox";
import type { PricingOutcome } from "../../src/pricing/pricing-outcome-retry";
import { tokenBook } from "../unit/pricing-fixtures";

const root = "/api/dashboard/pricing",
  workspace = "default-workspace";
describe("retained runtime outcome HTTP boundary", () => {
  let harness: E2EHarness,
    source: DataSource,
    ledger: CostLedgerService,
    directory: string;
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "runtime-outcome-http-"));
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
  const rows = (): Promise<RuntimeOutcomeRow[]> =>
    source.query("SELECT * FROM pricing_runtime_outcomes ORDER BY id");
  it("retains actual response accounting without prompts, provider secrets or supplier-confirmation claims", async () => {
    expect((await call()).status).toBe(200);
    const before = await rows();
    expect(before).toHaveLength(2);
    expect(before.every((row) => row.state === "delivered")).toBe(true);
    const list = await harness.agent.get(
      `${root}/runtime-outcomes?state=delivered&limit=1`,
    );
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).not.toHaveProperty("outcome_json");
    const detail = await harness.agent.get(
      `${root}/runtime-outcomes/${list.body.items[0].id}`,
    );
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({
      source: "gateway_runtime",
      supplier_confirmed: false,
      read_only: true,
    });
    expect(JSON.stringify(before)).not.toMatch(
      /PRIVATE_PROMPT_NOT_ACCOUNTING|PRIVATE_RESPONSE_NOT_ACCOUNTING/,
    );
    expect(JSON.stringify(before)).not.toContain(API_KEY);
    const runtime = harness.app.get(PricingRuntimeService);
    const internal = runtime as unknown as {
      persistOutcome(value: unknown): Promise<string>;
    };
    expect(
      await internal.persistOutcome({
        ...JSON.parse(before[0].outcome_json),
        raw_response: "PRIVATE_BUFFER_CONTENT",
      }),
    ).toBe("overflow");
    expect(runtime.outcomeRetryStatus()).toMatchObject({
      entries: 0,
      bytes: 0,
    });
    expect(await rows()).toEqual(before);
    expect(harness.fetchMock.calls).toHaveLength(1);
  });
  it("replays durable pending outcomes after losing all in-memory retry entries without another provider call", async () => {
    // Exercise the standalone recovery fallback after the normal joint-receipt
    // preparation fails; both durable bodies must still survive the memory loss.
    const failPreparation = jest
      .spyOn(ledger, "prepareRuntimeReceipt")
      .mockRejectedValueOnce(new Error("synthetic receipt preparation outage"));
    const failReceipt = jest
        .spyOn(ledger, "completeAttempt")
        .mockRejectedValueOnce(new Error("synthetic receipt outage")),
      failIntent = jest
        .spyOn(ledger as unknown as { writeSettlementIntent(): Promise<unknown> }, "writeSettlementIntent")
        .mockRejectedValueOnce(new Error("synthetic intent outage"));
    try {
      expect((await call()).status).toBe(200);
      expect(failPreparation).toHaveBeenCalledTimes(1);
      expect(failReceipt).toHaveBeenCalledTimes(1);
      expect(failIntent).toHaveBeenCalledTimes(1);
    } finally {
      failPreparation.mockRestore();
      failReceipt.mockRestore();
      failIntent.mockRestore();
    }
    expect((await rows()).every((row) => row.state === "pending")).toBe(true);
    const runtime = harness.app.get(PricingRuntimeService) as unknown as {
      outcomes: { entries: Map<string, unknown>; bytes: number };
    };
    runtime.outcomes.entries.clear();
    runtime.outcomes.bytes = 0;
    expect(
      await ledger.replayRuntimeOutcomes(new Date(Date.now() + 2000)),
    ).toMatchObject({ persisted: 2 });
    await ledger.reconcilePending();
    const log = (await harness.agent.get("/api/dashboard/logs")).body.data[0],
      detail = await harness.agent.get(
        `/api/dashboard/logs/${log.id}/cost-breakdown`,
      );
    expect(detail.body.budget_committed_usd).toBe("0.000020000000000000");
    expect(detail.body.amount).toBe(detail.body.budget_committed_usd);
    const before = await rows();
    await ledger.replayRuntimeOutcomes(new Date(Date.now() + 120000));
    expect(await rows()).toEqual(before);
    expect(harness.fetchMock.calls).toHaveLength(1);
  });
  it("exposes distinct quarantined runtime receipts read-only and does not accept an HTTP ingest or replay write", async () => {
    expect((await call()).status).toBe(200);
    const row = (await rows()).find((row) => row.kind === "attempt")!,
      outcome = JSON.parse(row.outcome_json) as PricingOutcome;
    if (outcome.type !== "attempt") throw new Error("Expected attempt");
    outcome.errorCode = "late_distinct_evidence";
    await expect(ledger.persistRuntimeOutcome(outcome)).rejects.toMatchObject({
      status: 409,
    });
    const before = await rows();
    const list = await harness.agent.get(`${root}/runtime-outcomes`);
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].state).toBe("review_required");
    expect(
      (await harness.agent.post(`${root}/runtime-outcomes`).send(outcome))
        .status,
    ).toBe(404);
    expect(
      (
        await harness.agent.get(
          `${root}/runtime-outcomes/${list.body.items[0].id}`,
        )
      ).body.outcome.errorCode,
    ).toBe("late_distinct_evidence");
    expect(await rows()).toEqual(before);
    expect(harness.fetchMock.calls).toHaveLength(1);
  });
  it("enforces operator/viewer and workspace boundaries for list, cursor and detail", async () => {
    expect((await call()).status).toBe(200);
    const row = (await rows())[0];
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
    expect(
      (await harness.agent.get(`${root}/runtime-outcomes?state=delivered`))
        .status,
    ).toBe(200);
    expect(
      (await harness.agent.get(`${root}/runtime-outcomes/${row.id}`)).status,
    ).toBe(200);
    await members.ensureMembership({
      userId: "dashboard",
      workspaceId: workspace,
      organizationId: "default-org",
      role: "viewer",
    });
    expect((await harness.agent.get(`${root}/runtime-outcomes`)).status).toBe(
      403,
    );
    expect(
      (await harness.agent.get(`${root}/runtime-outcomes/${row.id}`)).status,
    ).toBe(403);
    await expect(
      ledger.runtimeOutcome(row.id, "foreign"),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      (await ledger.runtimeOutcomeInventory("foreign", "delivered", 20)).items,
    ).toEqual([]);
  });
});

import { DataSource, InsertQueryBuilder, type ObjectLiteral } from "typeorm";
import { createE2EHarness, API_KEY, type E2EHarness } from "./setup";
import { CostLedgerService } from "../../src/pricing/cost-ledger.service";
import { PricingRepositoryError } from "../../src/pricing/pricing-repository.types";
import { PricingRecoveryService } from "../../src/pricing/pricing-recovery.service";
import { PricingRuntimeService } from "../../src/pricing/pricing-runtime.service";
import { WorkspaceMembershipService } from "../../src/auth/workspace-membership.service";
import { applyPricingSchema } from "../../src/pricing/pricing-schema";
import { tokenBook } from "../unit/pricing-fixtures";

const root = "/api/dashboard/pricing",
  workspace = "default-workspace";
describe("missing supplier usage recovery over isolated HTTP", () => {
  let harness: E2EHarness, source: DataSource, ledger: CostLedgerService;
  beforeEach(async () => {
    harness = await createE2EHarness();
    source = harness.app.get(DataSource);
    ledger = harness.app.get(CostLedgerService);
    await harness.app.get(PricingRecoveryService).onModuleDestroy();
    await applyPricingSchema(source);
  }, 30000);
  afterEach(async () => {
    jest.restoreAllMocks();
    await harness?.close();
  });
  const seed = async () => {
    const created = await harness.agent
      .post(`${root}/books`)
      .send({ name: "Synthetic recovered usage rates", content: tokenBook() });
    expect(created.status).toBe(201);
    expect(
      (
        await harness.agent
          .post(`${root}/drafts/${created.body.draft.id}/publish`)
          .send({
            draft_revision: 1,
            catalog_revision: 0,
            reason: "Synthetic fixture",
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
                message: { role: "assistant", content: "synthetic answer" },
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
    const failure = () =>
      new PricingRepositoryError(
        "synthetic_persistence_conflict",
        "Synthetic pre-durable outcome loss",
        409,
      );
    const receipt = jest
      .spyOn(ledger, "completeAttempt")
      .mockRejectedValueOnce(failure());
    const intent = jest
      .spyOn(ledger as unknown as { writeSettlementIntent(): Promise<unknown> }, "writeSettlementIntent")
      .mockRejectedValueOnce(failure());
    try {
      expect(
        (
          await harness.agent
            .post("/v1/chat/completions")
            .set("Authorization", `Bearer ${API_KEY}`)
            .send({
              model: "gpt-4o",
              max_tokens: 20,
              messages: [
                { role: "user", content: "Synthetic missing usage request" },
              ],
            })
        ).status,
      ).toBe(200);
    } finally {
      receipt.mockRestore();
      intent.mockRestore();
    }
    await source.manager
      .createQueryBuilder()
      .update("pricing_reservations")
      .set({ lease_until: new Date(Date.now() - 60000).toISOString() })
      .execute();
    await ledger.reconcileDispatched();
    const cases = (await harness.agent.get(`${root}/recovery-cases`)).body
      .items;
    expect(cases).toHaveLength(1);
    const anchor = cases[0].reservation_id,
      request = cases[0].request_id,
      path = `${root}/recovery-cases/${anchor}`;
    const basis = (await harness.agent.get(`${path}/basis`)).body;
    expect(basis.attempts[0].state).toBe("dispatched");
    return {
      anchor,
      request,
      path,
      body: {
        id: "synthetic-usage-recovery",
        attempt_id: basis.attempts[0].id,
        expected_basis_hash: basis.basis_hash,
        reason: "Synthetic independently reviewed usage",
        confirm: true,
        evidence: [
          { dimension: "total_input_tokens", value: "10" },
          { dimension: "uncached_input_tokens", value: "10" },
          { dimension: "output_tokens", value: "5" },
          { dimension: "cache_read_tokens", value: "0" },
          { dimension: "cache_write_tokens", value: "0" },
          { dimension: "cache_write_5m_tokens", value: "0" },
          { dimension: "cache_write_1h_tokens", value: "0" },
        ],
      },
    };
  };

  it("previews without writes, projects recovered usage into real logs and never repeats the provider call", async () => {
    const { path, body, request } = await seed();
    const retainedBefore = await source.query("SELECT * FROM pricing_runtime_outcomes ORDER BY id");
    const before = await source.query("SELECT * FROM pricing_audit_events"),
      effects = await source.query("SELECT * FROM pricing_budget_effects");
    const preview = await harness.agent
      .post(`${path}/missing-usage/preview`)
      .send(body);
    expect(preview.status).toBe(201);
    expect(preview.body).toMatchObject({
      dry_run: true,
      budget_changed: false,
      supplier_confirmed: false,
    });
    expect(await source.query("SELECT * FROM pricing_audit_events")).toEqual(
      before,
    );
    const applied = await harness.agent
      .post(`${path}/missing-usage`)
      .send(body);
    expect(applied.status).toBe(201);
    expect(applied.body.changes).toEqual(preview.body.changes);
    const result = await ledger.summary(request, workspace);
    expect(result).toMatchObject({
      status: "estimated",
      amount: "0.000020000000000000",
    });
    expect(await source.query("SELECT * FROM pricing_budget_effects")).toEqual(
      effects,
    );
    const log = await source.manager
      .createQueryBuilder()
      .select("l.*")
      .from("call_logs", "l")
      .where("l.request_id = :request", { request })
      .getRawOne();
    expect(log.cost_usd).toBe(0.00002);
    const detail = await harness.agent.get(
      `/api/dashboard/logs/${log.id}/cost-breakdown`,
    );
    expect(detail.status).toBe(200);
    expect(JSON.stringify(detail.body)).toContain(
      "administrator-usage-recovery",
    );
    expect(harness.fetchMock.calls).toHaveLength(1);
    // Archival frees memory, but the original observed receipt and proposal must
    // survive the administrator's different estimated evidence byte-for-byte.
    const runtime = harness.app.get(PricingRuntimeService);
    expect(runtime.outcomeRetryStatus()).toMatchObject({ entries: 0, archived: 2 });
    expect(retainedBefore).toHaveLength(2);
    expect(retainedBefore.every((row: { state: string }) => row.state === "review_required")).toBe(true);
    expect(JSON.parse(retainedBefore.find((row: { kind: string }) => row.kind === "attempt").outcome_json).cost.evidence_status).toBe("observed");
    await runtime.flushPendingOutcomes();
    expect(await source.query("SELECT * FROM pricing_runtime_outcomes ORDER BY id")).toEqual(retainedBefore);
  });

  it("recovers from an ambiguous post-commit response using the same id and read-only acknowledgement", async () => {
    const { path, body } = await seed(),
      original = ledger.recoverUsage.bind(ledger);
    jest
      .spyOn(ledger, "recoverUsage")
      .mockImplementationOnce(async (...args) => {
        await original(...args);
        throw new Error("synthetic lost usage acknowledgement");
      });
    expect(
      (await harness.agent.post(`${path}/missing-usage`).send(body)).status,
    ).toBe(500);
    const effects = await source.query("SELECT * FROM pricing_budget_effects");
    const ack = await harness.agent.get(`${path}/missing-usage/${body.id}`);
    expect(ack.status).toBe(200);
    expect(ack.body.result.replayed).toBe(true);
    const retry = await harness.agent.post(`${path}/missing-usage`).send(body);
    expect(retry.status).toBe(201);
    expect(retry.body.replayed).toBe(true);
    expect(
      await source.query(
        "SELECT * FROM pricing_audit_events WHERE action = 'cost.usage_recovered'",
      ),
    ).toHaveLength(1);
    expect(await source.query("SELECT * FROM pricing_budget_effects")).toEqual(
      effects,
    );
    expect(harness.fetchMock.calls).toHaveLength(1);
  });

  it("requires JSON, consent, exact evidence fields and same-origin authority", async () => {
    const { path, body } = await seed();
    for (const forged of [
      { ...body, confirm: false },
      { ...body, workspace_id: "forged" },
      { ...body, cost_usd: "0" },
      {
        ...body,
        evidence: [{ ...body.evidence[0], source: "provider_usage" }],
      },
      { ...body, conditions: { requested_service_tier: "forged" } },
    ])
      expect(
        (await harness.agent.post(`${path}/missing-usage`).send(forged)).status,
      ).toBe(400);
    expect(
      (
        await harness.agent
          .post(`${path}/missing-usage`)
          .set("Origin", "https://untrusted.example")
          .send(body)
      ).status,
    ).toBe(403);
    expect(
      (
        await harness.agent
          .post(`${path}/missing-usage`)
          .type("text")
          .send(JSON.stringify(body))
      ).status,
    ).toBe(403);
    expect(
      (
        await ledger.summary(
          (await source.query("SELECT request_id FROM pricing_attempts"))[0]
            .request_id,
          workspace,
        )
      )?.pending_attempts,
    ).toBe(1);
    expect(harness.fetchMock.calls).toHaveLength(1);
  });

  it("limits acknowledgement to operators and submission to administrators within the authorized workspace", async () => {
    const { path, body } = await seed();
    expect(
      (await harness.agent.post(`${path}/missing-usage`).send(body)).status,
    ).toBe(201);
    const foreign = await harness.agent
      .post("/api/dashboard/workspaces")
      .send({ name: "Synthetic other evidence workspace" });
    expect(foreign.status).toBe(201);
    expect(
      (
        await harness.agent
          .get(`${path}/missing-usage/${body.id}`)
          .set("x-siftgate-workspace-id", foreign.body.item.id)
      ).status,
    ).toBe(404);
    const members = harness.app.get(WorkspaceMembershipService);
    await members.ensureMembership({
      userId: "synthetic-backup-admin",
      organizationId: "default-org",
      workspaceId: workspace,
      role: "admin",
    });
    await members.ensureMembership({
      userId: "dashboard",
      organizationId: "default-org",
      workspaceId: workspace,
      role: "operator",
    });
    expect(
      (await harness.agent.get(`${path}/missing-usage/${body.id}`)).status,
    ).toBe(200);
    expect(
      (await harness.agent.post(`${path}/missing-usage/preview`).send(body))
        .status,
    ).toBe(403);
    expect(
      (await harness.agent.post(`${path}/missing-usage`).send(body)).status,
    ).toBe(403);
    await members.ensureMembership({
      userId: "dashboard",
      organizationId: "default-org",
      workspaceId: workspace,
      role: "viewer",
    });
    expect(
      (await harness.agent.get(`${path}/missing-usage/${body.id}`)).status,
    ).toBe(403);
  });

  it("rolls back live log projection and receipts when the mandatory usage-recovery audit fails", async () => {
    const { path, body, request } = await seed(),
      original = InsertQueryBuilder.prototype.execute;
    const failure = jest
      .spyOn(InsertQueryBuilder.prototype, "execute")
      .mockImplementation(function (this: InsertQueryBuilder<ObjectLiteral>) {
        if (this.expressionMap.mainAlias?.tablePath === "pricing_audit_events")
          return Promise.reject(
            new Error("synthetic evidence audit unavailable"),
          );
        return original.call(this);
      });
    expect(
      (await harness.agent.post(`${path}/missing-usage`).send(body)).status,
    ).toBe(500);
    failure.mockRestore();
    expect((await ledger.summary(request, workspace))?.pending_attempts).toBe(
      1,
    );
    expect(
      await source.query(
        "SELECT * FROM pricing_audit_events WHERE action = 'cost.usage_recovered'",
      ),
    ).toHaveLength(0);
    expect(
      (await harness.agent.post(`${path}/missing-usage`).send(body)).status,
    ).toBe(201);
    expect(harness.fetchMock.calls).toHaveLength(1);
  });
});

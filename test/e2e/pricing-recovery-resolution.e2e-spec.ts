import { DataSource, InsertQueryBuilder } from "typeorm";
import { createE2EHarness, type E2EHarness, API_KEY } from "./setup";
import { applyPricingSchema } from "../../src/pricing/pricing-schema";
import { CostLedgerService } from "../../src/pricing/cost-ledger.service";
import { PricingRuntimeService } from "../../src/pricing/pricing-runtime.service";
import { PricingRepositoryError } from "../../src/pricing/pricing-repository.types";
import { WorkspaceMembershipService } from "../../src/auth/workspace-membership.service";
import { BudgetService } from "../../src/budget/budget.service";
import { tokenBook } from "../unit/pricing-fixtures";

const root = "/api/dashboard/pricing";
describe("audited budget recovery over isolated HTTP", () => {
  let harness: E2EHarness, source: DataSource, ledger: CostLedgerService;
  beforeEach(async () => {
    harness = await createE2EHarness();
    source = harness.app.get(DataSource);
    ledger = harness.app.get(CostLedgerService);
    await applyPricingSchema(source);
  }, 30000);
  afterEach(async () => {
    jest.restoreAllMocks();
    await harness?.close();
  });
  const seed = async () => {
    const created = await harness.agent
      .post(`${root}/books`)
      .send({ name: "Synthetic recovery price", content: tokenBook() });
    expect(created.status).toBe(201);
    const head = (await harness.agent.get(`${root}/bindings`)).body.head;
    expect(
      (
        await harness.agent
          .post(`${root}/drafts/${created.body.draft.id}/publish`)
          .send({
            draft_revision: 1,
            catalog_revision: head.revision,
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
    const fail = jest
      .spyOn(ledger as unknown as { writeSettlementIntent(): Promise<unknown> }, "writeSettlementIntent")
      .mockRejectedValueOnce(
        new PricingRepositoryError(
          "synthetic_storage_conflict",
          "synthetic original decision unavailable",
          409,
        ),
      );
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
                { role: "user", content: "synthetic recovery fixture" },
              ],
            })
        ).status,
      ).toBe(200);
    } finally {
      fail.mockRestore();
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
    const path = `${root}/recovery-cases/${cases[0].reservation_id}`;
    const basis = (await harness.agent.get(`${path}/basis`)).body;
    return {
      path,
      basis,
      body: {
        id: "synthetic-resolution",
        expected_basis_hash: basis.basis_hash,
        reason: "Synthetic operator review",
        confirm: true,
        decisions: [
          {
            reservation_id: cases[0].reservation_id,
            action: "commit",
            budget_attempt_id: basis.attempts[0].id,
          },
        ],
      },
    };
  };
  it("previews without writes, applies one known debit and preserves the superseded proposal in durable review", async () => {
    const { path, body } = await seed();
    const before = await source.query("SELECT * FROM pricing_reservations");
    expect(
      (
        await harness.agent
          .post(`${path}/preview`)
          .send({ ...body, confirm: false })
      ).status,
    ).toBe(201);
    expect(await source.query("SELECT * FROM pricing_reservations")).toEqual(
      before,
    );
    expect(
      await source.query("SELECT * FROM pricing_recovery_decisions"),
    ).toHaveLength(0);
    const applied = await harness.agent.post(`${path}/resolve`).send(body);
    expect(applied.status).toBe(201);
    expect(applied.body).toMatchObject({
      budget_only: true,
      dry_run: false,
      unknown_attempt_ids: [],
    });
    expect(applied.body.changes[0].budget_cost_usd).toBe(
      "0.000020000000000000",
    );
    const runtime = harness.app.get(PricingRuntimeService);
    expect(runtime.outcomeRetryStatus()).toMatchObject({ entries: 0, archived: 1 });
    const archived = await source.query("SELECT * FROM pricing_runtime_outcomes WHERE kind = 'settlement'");
    expect(archived).toHaveLength(1);
    expect(archived[0].state).toBe("review_required");
    const retained = JSON.parse(archived[0].outcome_json);
    expect(retained.payload.receipt.attemptId).toBe(body.decisions[0].budget_attempt_id);
    expect(retained.payload.receipt.cost.report_amount).toBe("0.000020000");
    await runtime.flushPendingOutcomes();
    expect(runtime.outcomeRetryStatus()).toMatchObject({
      entries: 0,
      archived: 1,
    });
    expect(await source.query("SELECT * FROM pricing_runtime_outcomes WHERE kind = 'settlement'")).toEqual(archived);
    expect(
      (await harness.agent.post(`${path}/resolve`).send(body)).body,
    ).toMatchObject({ replayed: true });
    expect(
      await source.query(
        "SELECT * FROM pricing_audit_events WHERE action = 'cost.recovery_resolution'",
      ),
    ).toHaveLength(1);
    expect(harness.fetchMock.calls).toHaveLength(1);
  });
  it("recovers an ambiguous post-commit error by retrying the same proposal exactly once", async () => {
    const { path, body } = await seed();
    const fail = jest
      .spyOn(harness.app.get(BudgetService), "refreshAfterLedgerMutation")
      .mockRejectedValueOnce(new Error("synthetic lost acknowledgement"));
    try {
      expect(
        (await harness.agent.post(`${path}/resolve`).send(body)).status,
      ).toBe(500);
    } finally {
      fail.mockRestore();
    }
    const retry = await harness.agent.post(`${path}/resolve`).send(body);
    expect(retry.status).toBe(201);
    expect(retry.body.replayed).toBe(true);
    expect(
      await source.query("SELECT * FROM pricing_recovery_decisions"),
    ).toHaveLength(1);
    expect(harness.fetchMock.calls).toHaveLength(1);
  });
  it("rolls back all changes when the required audit fails", async () => {
    const { path, body } = await seed();
    const before = await source.query("SELECT * FROM pricing_reservations");
    const execute = InsertQueryBuilder.prototype.execute;
    const fail = jest
      .spyOn(InsertQueryBuilder.prototype, "execute")
      .mockImplementation(function (
        this: InsertQueryBuilder<Record<string, unknown>>,
      ) {
        if (this.expressionMap.mainAlias?.tablePath === "pricing_audit_events")
          return Promise.reject(new Error("synthetic audit outage"));
        return execute.call(this);
      });
    try {
      expect(
        (await harness.agent.post(`${path}/resolve`).send(body)).status,
      ).toBe(500);
    } finally {
      fail.mockRestore();
    }
    expect(await source.query("SELECT * FROM pricing_reservations")).toEqual(
      before,
    );
    expect(
      await source.query("SELECT * FROM pricing_recovery_decisions"),
    ).toHaveLength(0);
  });
  it("rejects stale previews, missing confirmation and body role spoofing", async () => {
    const { path, body } = await seed();
    expect(
      (
        await harness.agent
          .post(`${path}/resolve`)
          .send({ ...body, confirm: false })
      ).status,
    ).toBe(400);
    expect(
      (
        await harness.agent
          .post(`${path}/resolve`)
          .send({ ...body, actor_id: "fake-admin" })
      ).status,
    ).toBe(400);
    await ledger.renew(
      body.decisions[0].reservation_id,
      "default-workspace",
      (await source.query("SELECT lease_owner FROM pricing_reservations"))[0]
        .lease_owner,
      new Date(Date.now() + 60000).toISOString(),
    );
    expect(
      (await harness.agent.post(`${path}/resolve`).send(body)).status,
    ).toBe(409);
  });
  it("allows operator inspection but only administrators can preview or apply decisions", async () => {
    const { path, body } = await seed();
    const members = harness.app.get(WorkspaceMembershipService);
    await members.ensureMembership({
      userId: "fixture-backup-admin",
      organizationId: "default-org",
      workspaceId: "default-workspace",
      role: "admin",
    });
    await members.ensureMembership({
      userId: "dashboard",
      organizationId: "default-org",
      workspaceId: "default-workspace",
      role: "operator",
    });
    expect((await harness.agent.get(`${path}/basis`)).status).toBe(200);
    expect((await harness.agent.get(`${root}/recovery-inventory`)).status).toBe(200);
    expect((await harness.agent.get(`${path}/resolutions/${body.id}`)).status).toBe(404);
    expect(
      (await harness.agent.post(`${path}/preview`).send(body)).status,
    ).toBe(403);
    expect(
      (await harness.agent.post(`${path}/resolve`).send(body)).status,
    ).toBe(403);
    await members.ensureMembership({
      userId: "dashboard",
      organizationId: "default-org",
      workspaceId: "default-workspace",
      role: "viewer",
    });
    expect((await harness.agent.get(`${path}/basis`)).status).toBe(403);
    expect((await harness.agent.get(`${root}/recovery-inventory`)).status).toBe(403);
    expect((await harness.agent.get(`${path}/resolutions/${body.id}`)).status).toBe(403);
    expect(
      await source.query("SELECT * FROM pricing_recovery_decisions"),
    ).toHaveLength(0);
  });

  it('paginates scoped inventory and confirms an applied proposal without another mutation', async () => {
    const { path, body } = await seed();
    const inventory = await harness.agent.get(`${root}/recovery-inventory?view=all&limit=1`);
    expect(inventory.status).toBe(200);
    expect(inventory.body).toMatchObject({ coverage: 'recorded_recovery_cases', limit: 1, scanned: 1 });
    expect(inventory.body.items[0]).not.toHaveProperty('evidence_json');
    expect((await harness.agent.get(`${root}/recovery-inventory?view=wrong`)).status).toBe(400);
    expect((await harness.agent.get(`${root}/recovery-inventory?limit=99`)).status).toBe(400);
    expect((await harness.agent.get(`${path}/resolutions/${body.id}`)).status).toBe(404);
    const applied = await harness.agent.post(`${path}/resolve`).send(body);
    expect(applied.status).toBe(201);
    const before = await source.query('SELECT * FROM pricing_budget_effects');
    const status = await harness.agent.get(`${path}/resolutions/${body.id}`);
    expect(status.status).toBe(200); expect(status.body.result).toEqual(applied.body);
    expect(await source.query('SELECT * FROM pricing_budget_effects')).toEqual(before);
    const foreign = await harness.agent.post('/api/dashboard/workspaces').send({ name: 'Synthetic other recovery workspace' });
    expect(foreign.status).toBe(201);
    expect((await harness.agent.get(`${path}/resolutions/${body.id}`).set('x-siftgate-workspace-id', foreign.body.item.id)).status).toBe(404);
    expect(harness.fetchMock.calls).toHaveLength(1);
  });

});

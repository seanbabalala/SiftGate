import { DataSource, InsertQueryBuilder, type ObjectLiteral } from "typeorm";
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
import { tokenBook } from "../unit/pricing-fixtures";

const root = "/api/dashboard/pricing",
  workspace = "default-workspace";
describe("administrator attempt corrections over isolated HTTP", () => {
  let harness: E2EHarness,
    source: DataSource,
    ledger: CostLedgerService,
    directory: string;
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "attempt-correction-http-"));
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
  }, 30000);
  afterEach(async () => {
    jest.restoreAllMocks();
    await harness?.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const seed = async () => {
    const book = await harness.agent
      .post(`${root}/books`)
      .send({ name: "Synthetic correction prices", content: tokenBook() });
    expect(book.status).toBe(201);
    expect(
      (
        await harness.agent
          .post(`${root}/drafts/${book.body.draft.id}/publish`)
          .send({
            draft_revision: 1,
            catalog_revision: 0,
            reason: "Synthetic isolated prices",
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
    const response = await harness.agent
      .post("/v1/chat/completions")
      .set("Authorization", `Bearer ${API_KEY}`)
      .send({
        model: "gpt-4o",
        max_tokens: 20,
        messages: [{ role: "user", content: "Synthetic correction request" }],
      });
    expect(response.status).toBe(200);
    await source.manager
      .createQueryBuilder()
      .update("pricing_reservations")
      .set({ lease_until: new Date(Date.now() - 60000).toISOString() })
      .execute();
    const attempt = (await source.query("SELECT * FROM pricing_attempts"))[0];
    const basis = await harness.agent.get(
      `${root}/attempts/${attempt.id}/correction-basis`,
    );
    expect(basis.status).toBe(200);
    return {
      attempt,
      path: `${root}/attempts/${attempt.id}`,
      body: {
        id: "synthetic-correction",
        expected_basis_hash: basis.body.basis_hash,
        expected_cost_hash: basis.body.effective_cost_hash,
        reason: "Synthetic administrator review",
        confirm: true,
        evidence: [
          { dimension: "total_input_tokens", value: "20" },
          { dimension: "uncached_input_tokens", value: "20" },
          { dimension: "output_tokens", value: "10" },
          { dimension: "cache_read_tokens", value: "0" },
          { dimension: "cache_write_tokens", value: "0" },
          { dimension: "cache_write_5m_tokens", value: "0" },
          { dimension: "cache_write_1h_tokens", value: "0" },
        ],
      },
    };
  };
  const budgets = () => source.query("SELECT * FROM pricing_budget_balances");

  it("previews real budget deltas without writes and updates the actual request log from immutable history", async () => {
    const { path, body, attempt } = await seed();
    const before = await budgets(),
      audits = await source.query("SELECT * FROM pricing_audit_events");
    const preview = await harness.agent
      .post(`${path}/correction/preview`)
      .send(body);
    expect(preview.status).toBe(201);
    expect(preview.body.budget).toMatchObject({
      cost_delta: "0.000020000000000000",
      tokens_delta: "15",
    });
    expect(await budgets()).toEqual(before);
    expect(await source.query("SELECT * FROM pricing_audit_events")).toEqual(
      audits,
    );
    const applied = await harness.agent.post(`${path}/correction`).send(body);
    expect(applied.status).toBe(201);
    expect(applied.body.budget).toEqual(preview.body.budget);
    expect((await source.query("SELECT * FROM pricing_attempts"))[0]).toEqual(
      attempt,
    );
    const summary = (await ledger.summary(attempt.request_id, workspace))!;
    expect(summary.amount).toBe("0.000040000000000000");
    expect(summary.budget_committed_usd).toBe("0.000040000000000000");
    const log = await source.manager
      .createQueryBuilder()
      .select("l.*")
      .from("call_logs", "l")
      .where("l.request_id = :id", { id: attempt.request_id })
      .getRawOne();
    expect(log.cost_usd).toBe(0.00004);
    const detail = await harness.agent.get(
      `/api/dashboard/logs/${log.id}/cost-breakdown`,
    );
    expect(detail.status).toBe(200);
    expect(JSON.stringify(detail.body)).toContain(
      "administrator-attempt-correction",
    );
    expect(harness.fetchMock.calls).toHaveLength(1);
  });

  it("recovers from a lost successful reply with same-id retry and read-only acknowledgement", async () => {
    const { path, body } = await seed(),
      write = ledger.attestAttemptCorrection.bind(ledger);
    jest
      .spyOn(ledger, "attestAttemptCorrection")
      .mockImplementationOnce(async (...args) => {
        await write(...args);
        throw new Error("synthetic lost correction acknowledgement");
      });
    expect(
      (await harness.agent.post(`${path}/correction`).send(body)).status,
    ).toBe(500);
    const before = await budgets();
    const ack = await harness.agent.get(`${path}/corrections/${body.id}`);
    expect(ack.status).toBe(200);
    expect(ack.body.result.replayed).toBe(true);
    const retried = await harness.agent.post(`${path}/correction`).send(body);
    expect(retried.status).toBe(201);
    expect(retried.body.replayed).toBe(true);
    expect(await budgets()).toEqual(before);
    expect(
      await source.query("SELECT * FROM pricing_cost_adjustments"),
    ).toHaveLength(1);
    expect(harness.fetchMock.calls).toHaveLength(1);
  });

  it("rejects forged money, implicit permission, source labels and stale basis without paid retries", async () => {
    const { path, body } = await seed();
    for (const forged of [
      { ...body, cost_usd: "0" },
      { ...body, confirm: false },
      { ...body, workspace_id: "other" },
      {
        ...body,
        conditions: { attempt_dispatched_at: "2000-01-01T00:00:00Z" },
      },
      {
        ...body,
        evidence: [{ ...body.evidence[0], source: "provider_usage" }],
      },
    ])
      expect(
        (await harness.agent.post(`${path}/correction`).send(forged)).status,
      ).toBe(400);
    expect(
      (
        await harness.agent
          .post(`${path}/correction`)
          .set("Origin", "https://untrusted.example")
          .send(body)
      ).status,
    ).toBe(403);
    expect(
      (
        await harness.agent
          .post(`${path}/correction`)
          .send({ ...body, expected_basis_hash: "f".repeat(64) })
      ).status,
    ).toBe(409);
    expect(
      await source.query("SELECT * FROM pricing_cost_adjustments"),
    ).toEqual([]);
    expect(harness.fetchMock.calls).toHaveLength(1);
  });

  it("limits inspection to operators, writes to admins and records to their authorized workspace", async () => {
    const { path, body } = await seed();
    expect(
      (await harness.agent.post(`${path}/correction`).send(body)).status,
    ).toBe(201);
    const foreign = await harness.agent
      .post("/api/dashboard/workspaces")
      .send({ name: "Synthetic other correction workspace" });
    expect(foreign.status).toBe(201);
    expect(
      (
        await harness.agent
          .get(`${path}/correction-basis`)
          .set("x-siftgate-workspace-id", foreign.body.item.id)
      ).status,
    ).toBe(404);
    expect(
      (
        await harness.agent
          .get(`${path}/corrections/${body.id}`)
          .set("x-siftgate-workspace-id", foreign.body.item.id)
      ).status,
    ).toBe(404);
    const members = harness.app.get(WorkspaceMembershipService);
    await members.ensureMembership({
      userId: "test-backup-admin",
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
    expect((await harness.agent.get(`${path}/correction-basis`)).status).toBe(
      200,
    );
    expect(
      (await harness.agent.get(`${path}/corrections/${body.id}`)).status,
    ).toBe(200);
    expect(
      (await harness.agent.post(`${path}/correction/preview`).send(body))
        .status,
    ).toBe(403);
    expect(
      (await harness.agent.post(`${path}/correction`).send(body)).status,
    ).toBe(403);
    await members.ensureMembership({
      userId: "dashboard",
      organizationId: "default-org",
      workspaceId: workspace,
      role: "viewer",
    });
    expect((await harness.agent.get(`${path}/correction-basis`)).status).toBe(
      403,
    );
    expect(
      (await harness.agent.get(`${path}/corrections/${body.id}`)).status,
    ).toBe(403);
  });

  it("rolls budget, revision and log projection back when mandatory audit fails", async () => {
    const { path, body, attempt } = await seed(),
      before = await budgets(),
      execute = InsertQueryBuilder.prototype.execute;
    const fail = jest
      .spyOn(InsertQueryBuilder.prototype, "execute")
      .mockImplementation(function (this: InsertQueryBuilder<ObjectLiteral>) {
        if (this.expressionMap.mainAlias?.tablePath === "pricing_audit_events")
          return Promise.reject(new Error("synthetic audit unavailable"));
        return execute.call(this);
      });
    expect(
      (await harness.agent.post(`${path}/correction`).send(body)).status,
    ).toBe(500);
    fail.mockRestore();
    expect(await budgets()).toEqual(before);
    expect(
      await source.query("SELECT * FROM pricing_cost_adjustments"),
    ).toEqual([]);
    expect((await ledger.summary(attempt.request_id, workspace))!.amount).toBe(
      "0.000020000000000000",
    );
    expect(
      (await harness.agent.post(`${path}/correction`).send(body)).status,
    ).toBe(201);
    expect(harness.fetchMock.calls).toHaveLength(1);
  });
});

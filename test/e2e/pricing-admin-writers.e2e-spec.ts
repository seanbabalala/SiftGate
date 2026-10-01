import { DataSource, InsertQueryBuilder, type ObjectLiteral } from "typeorm";
import { createE2EHarness, type E2EHarness } from "./setup";
import { ConfigService } from "../../src/config/config.service";
import {
  BudgetRule,
  GatewayApiKey,
  LocalTeam,
  ManagementAuditEvent,
  ConfigAuditEvent,
} from "../../src/database/entities";
import { applyPricingSchema } from "../../src/pricing/pricing-schema";
import { tokenBook } from "../unit/pricing-fixtures";

describe("pricing budget administration over isolated HTTP", () => {
  let harness: E2EHarness, source: DataSource;
  beforeEach(async () => {
    harness = await createE2EHarness();
    source = harness.app.get(DataSource);
    await applyPricingSchema(source);
    const config = harness.app.get(ConfigService);
    jest
      .spyOn(config, "configAudit", "get")
      .mockReturnValue({ ...config.configAudit, enabled: true });
  }, 30000);
  afterEach(async () => {
    jest.restoreAllMocks();
    await harness?.close();
  });
  const create = async (name = "Synthetic admin key", teamId?: string) => {
    const response = await harness.agent.post("/api/dashboard/api-keys").send({
      name,
      allow_direct: true,
      daily_token_limit: 1000,
      daily_cost_limit: 10,
      team_id: teamId,
    });
    expect(response.status).toBe(201);
    return response.body as { key: string; item: { id: string; name: string } };
  };
  const failAudit = () => {
    const execute = InsertQueryBuilder.prototype.execute;
    return jest
      .spyOn(InsertQueryBuilder.prototype, "execute")
      .mockImplementation(function (this: InsertQueryBuilder<ObjectLiteral>) {
        if (
          this.expressionMap.mainAlias?.hasMetadata &&
          this.expressionMap.mainAlias.target === ManagementAuditEvent
        )
          return Promise.reject(
            new Error("synthetic mandatory audit unavailable"),
          );
        return execute.call(this);
      });
  };
  const publish = async () => {
    const created = await harness.agent
      .post("/api/dashboard/pricing/books")
      .send({ name: "Synthetic price", content: tokenBook() });
    expect(created.status).toBe(201);
    const head = (await harness.agent.get("/api/dashboard/pricing/bindings"))
      .body.head;
    expect(
      (
        await harness.agent
          .post(
            `/api/dashboard/pricing/drafts/${created.body.draft.id}/publish`,
          )
          .send({
            draft_revision: 1,
            catalog_revision: head.revision,
            reason: "Synthetic fixture",
            confirm: true,
            targets: [{ level: "model", model: "gpt-4o" }],
          })
      ).status,
    ).toBe(201);
  };
  const spend = async (key: string) => {
    harness.fetchMock.setHandler(
      async () =>
        new Response(
          JSON.stringify({
            id: "synthetic-admin-request",
            model: "gpt-4o",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "Synthetic fixture" },
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
    return harness.agent
      .post("/v1/chat/completions")
      .set("Authorization", `Bearer ${key}`)
      .send({
        model: "gpt-4o",
        max_tokens: 10,
        messages: [{ role: "user", content: "Synthetic admin writer fixture" }],
      });
  };
  const balance = async (keyId: string) => {
    const rule = await source
      .getRepository(BudgetRule)
      .findOneByOrFail({ api_key_id: keyId, type: "daily_cost" });
    const rows = await source.query(
      "SELECT amount_decimal FROM pricing_budget_balances WHERE rule_id = ?",
      [rule.id],
    );
    return { rule, amount: rows[0]?.amount_decimal as string | undefined };
  };

  it("preserves spent exact costs and epochs while changing key configuration", async () => {
    await publish();
    const owner = await create();
    expect((await spend(owner.key)).status).toBe(200);
    const before = await balance(owner.item.id);
    expect(before.amount).toBe("0.000020000000000000");
    expect(
      (
        await harness.agent
          .put(`/api/dashboard/api-keys/${owner.item.id}`)
          .send({ name: "Changed policy", daily_cost_limit: 20 })
      ).status,
    ).toBe(200);
    const after = await balance(owner.item.id);
    expect(after.amount).toBe(before.amount);
    expect(after.rule.period_start).toEqual(before.rule.period_start);
    expect(after.rule.limit_value).toBe(20);
    const event = await source
      .getRepository(ManagementAuditEvent)
      .findOneByOrFail({
        action: "api_key.update",
        resource_id: owner.item.id,
      });
    expect(JSON.parse(event.before_summary_json!).budget.daily_cost_limit).toBe(
      10,
    );
    expect(JSON.parse(event.after_summary_json!).budget.daily_cost_limit).toBe(
      20,
    );
    expect(event.actor_id).toBe("dashboard");
    expect(harness.fetchMock.calls).toHaveLength(1);
  });

  it("returns a failed create without leaving a key, budgets or partial config audit", async () => {
    const before = await source.getRepository(ManagementAuditEvent).count();
    const fail = failAudit();
    try {
      const response = await harness.agent
        .post("/api/dashboard/api-keys")
        .send({
          name: "Must not exist",
          daily_token_limit: 1000,
          daily_cost_limit: 10,
        });
      expect(response.status).toBe(500);
      expect(JSON.stringify(response.body)).not.toContain("gw_sk_live_");
    } finally {
      fail.mockRestore();
    }
    expect(
      await source
        .getRepository(GatewayApiKey)
        .count({ where: { name: "Must not exist" } }),
    ).toBe(0);
    expect(
      await source
        .getRepository(BudgetRule)
        .count({ where: { api_key_name: "Must not exist" } }),
    ).toBe(0);
    expect(
      await source
        .getRepository(ConfigAuditEvent)
        .count({ where: { action: "api_key.create" } }),
    ).toBe(0);
    expect(await source.getRepository(ManagementAuditEvent).count()).toBe(
      before,
    );
    expect(harness.fetchMock.calls).toHaveLength(0);
  });

  it("keeps the old key usable when rotation and its audit cannot commit", async () => {
    const owner = await create(),
      stored = await source
        .getRepository(GatewayApiKey)
        .findOneByOrFail({ id: owner.item.id });
    const fail = failAudit();
    try {
      expect(
        (
          await harness.agent
            .post(`/api/dashboard/api-keys/${owner.item.id}/rotate`)
            .send({})
        ).status,
      ).toBe(500);
    } finally {
      fail.mockRestore();
    }
    expect(
      (
        await source
          .getRepository(GatewayApiKey)
          .findOneByOrFail({ id: owner.item.id })
      ).key_hash,
    ).toBe(stored.key_hash);
    expect(
      await source
        .getRepository(ConfigAuditEvent)
        .count({ where: { action: "api_key.rotate" } }),
    ).toBe(0);
    expect((await spend(owner.key)).status).toBe(200);
  });

  it("does not reset spent budgets or change epochs if the authoritative reset audit fails", async () => {
    await publish();
    const owner = await create();
    expect((await spend(owner.key)).status).toBe(200);
    const before = await balance(owner.item.id),
      fail = failAudit();
    try {
      expect(
        (
          await harness.agent
            .post(`/api/dashboard/budget/${before.rule.id}/reset`)
            .send({})
        ).status,
      ).toBe(500);
    } finally {
      fail.mockRestore();
    }
    const after = await balance(owner.item.id);
    expect(after.amount).toBe(before.amount);
    expect(after.rule.period_start).toEqual(before.rule.period_start);
    expect(
      await source
        .getRepository(ManagementAuditEvent)
        .count({ where: { action: "budget.rule.reset" } }),
    ).toBe(0);
    expect(harness.fetchMock.calls).toHaveLength(1);
  });

  it("serializes concurrent policy changes and their before/after audit records", async () => {
    const owner = await create();
    const responses = await Promise.all([
      harness.agent
        .put(`/api/dashboard/api-keys/${owner.item.id}`)
        .send({ name: "Concurrent policy name" }),
      harness.agent
        .put(`/api/dashboard/api-keys/${owner.item.id}`)
        .send({ daily_cost_limit: 20 }),
    ]);
    expect(responses.map((result) => result.status)).toEqual([200, 200]);
    const row = await source
      .getRepository(GatewayApiKey)
      .findOneByOrFail({ id: owner.item.id });
    expect(row.name).toBe("Concurrent policy name");
    expect(row.daily_cost_limit).toBe(20);
    const audit = await source
      .getRepository(ManagementAuditEvent)
      .find({ where: { resource_id: owner.item.id }, order: { id: "ASC" } });
    expect(audit).toHaveLength(3);
    expect(audit[1].previous_hash).toBe(audit[0].event_hash);
    expect(audit[2].previous_hash).toBe(audit[1].event_hash);
    expect(JSON.parse(audit[2].before_summary_json!)).toEqual(
      JSON.parse(audit[1].after_summary_json!),
    );
    expect(
      await source
        .getRepository(BudgetRule)
        .count({ where: { api_key_id: owner.item.id } }),
    ).toBe(2);
  });

  it("rolls back team update/deletion and spent-budget changes when auditing fails", async () => {
    await publish();
    const created = await harness.agent
      .post("/api/dashboard/teams")
      .send({
        name: "Synthetic budget team",
        daily_token_limit: 1000,
        daily_cost_limit: 10,
      });
    expect(created.status).toBe(201);
    const teamId = created.body.item.id as string;
    const owner = await create("Team-bound key", teamId);
    expect((await spend(owner.key)).status).toBe(200);
    const original = await source
      .getRepository(BudgetRule)
      .findOneByOrFail({ team_id: teamId, type: "daily_cost" });
    const snapshot = await source.query(
      "SELECT amount_decimal FROM pricing_budget_balances WHERE rule_id = ?",
      [original.id],
    );
    expect(snapshot[0].amount_decimal).toBe("0.000020000000000000");
    for (const method of ["update", "delete"]) {
      const failure = failAudit();
      try {
        const response =
          method === "update"
            ? await harness.agent
                .put(`/api/dashboard/teams/${teamId}`)
                .send({ name: "Must roll back", daily_cost_limit: 20 })
            : await harness.agent.delete(`/api/dashboard/teams/${teamId}`);
        expect(response.status).toBe(500);
      } finally {
        failure.mockRestore();
      }
      const team = await source
        .getRepository(LocalTeam)
        .findOneByOrFail({ id: teamId });
      expect(team.name).toBe("Synthetic budget team");
      expect(team.daily_cost_limit).toBe(10);
      const rule = await source
        .getRepository(BudgetRule)
        .findOneByOrFail({ id: original.id });
      expect(rule.is_active).toBe(true);
      expect(rule.period_start).toEqual(original.period_start);
      expect(
        await source.query(
          "SELECT amount_decimal FROM pricing_budget_balances WHERE rule_id = ?",
          [original.id],
        ),
      ).toEqual(snapshot);
    }
    expect(
      await source
        .getRepository(ConfigAuditEvent)
        .count({
          where: [{ action: "team.update" }, { action: "team.delete" }],
        }),
    ).toBe(0);
    expect(harness.fetchMock.calls).toHaveLength(1);
  });

  it("keeps foreign-workspace keys and budgets hidden from administrator mutations", async () => {
    const owner = await create();
    await source
      .getRepository(GatewayApiKey)
      .update(owner.item.id, { workspace_id: "foreign-workspace" });
    await source
      .getRepository(BudgetRule)
      .update(
        { api_key_id: owner.item.id },
        { workspace_id: "foreign-workspace" },
      );
    const response = await harness.agent
      .put(`/api/dashboard/api-keys/${owner.item.id}`)
      .send({ daily_cost_limit: 100 });
    expect(response.status).toBe(404);
    expect(
      (
        await source
          .getRepository(GatewayApiKey)
          .findOneByOrFail({ id: owner.item.id })
      ).daily_cost_limit,
    ).toBe(10);
    expect(
      await source.getRepository(ManagementAuditEvent).count({
        where: { action: "api_key.update", resource_id: owner.item.id },
      }),
    ).toBe(0);
  });
});

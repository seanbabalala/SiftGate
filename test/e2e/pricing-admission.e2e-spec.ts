import { ConfigService } from "../../src/config/config.service";
import { CostLedgerService } from "../../src/pricing/cost-ledger.service";
import { DataSource } from "typeorm";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as yaml from "js-yaml";
import { createE2EHarness, E2EHarness, FIXTURE_PATH, API_KEY } from "./setup";
import { applyPricingSchema } from "../../src/pricing/pricing-schema";
import { PricingRecoveryService } from "../../src/pricing/pricing-recovery.service";
import { book, rate } from "../unit/pricing-fixtures";
import type { PriceBookContent } from "../../src/pricing/pricing.types";
import type { PricingAdmissionPolicy } from "../../src/pricing/pricing-admission.types";
import { WorkspaceMembershipService } from "../../src/auth/workspace-membership.service";
import {
  DEFAULT_ORGANIZATION_ID,
  DEFAULT_WORKSPACE_ID,
} from "../../src/workspaces/workspace.constants";

const rates = () =>
  book([
    rate("input", "uncached_input_tokens", "0.01", "1"),
    rate("output", "output_tokens", "0.02", "1"),
  ]);
const caps: PricingAdmissionPolicy = {
  mode: "reserve_upper_bound",
  quantity_limits: { total_input_tokens: "100", output_tokens: "40" },
  limit_reference: "Synthetic provider token limits",
};

describe("pricing admission policies on real isolated requests", () => {
  let harness: E2EHarness, source: DataSource, directory: string;
  const base = "/api/dashboard/pricing";
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "admission-e2e-"));
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
    (config.routing as Record<string, unknown>).retry = {
      max_retries: 1,
      backoff_base_ms: 1,
      backoff_max_ms: 1,
      retryable_status: [500, 502, 503, 504],
    };
    (config.nodes as Record<string, unknown>[])[0].credentials = [
      { id: "a", api_key: "synthetic-a" },
      { id: "b", api_key: "synthetic-b" },
    ];
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
  const chat = (extra: Record<string, unknown> = {}) =>
    harness.agent
      .post("/v1/chat/completions")
      .set("Authorization", `Bearer ${API_KEY}`)
      .send({
        model: "gpt-4o",
        messages: [{ role: "user", content: "synthetic" }],
        max_tokens: 20,
        ...extra,
      });
  const json = (
    usage = {
      prompt_tokens: 10,
      completion_tokens: 20,
      prompt_tokens_details: { cached_tokens: 0 },
    },
  ) =>
    new Response(
      JSON.stringify({
        id: "fixture",
        object: "chat.completion",
        model: "gpt-4o",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "ok" },
            finish_reason: "stop",
          },
        ],
        usage,
      }),
      { headers: { "content-type": "application/json" } },
    );
  async function publish(
    content: PriceBookContent = rates(),
    model = "gpt-4o",
    operation?: string,
  ) {
    const created = await harness.agent
      .post(`${base}/books`)
      .send({ name: "Synthetic admission fixture", content });
    expect(created.status).toBe(201);
    const revision = (await harness.agent.get(`${base}/bindings`)).body.head
      .revision;
    const result = await harness.agent
      .post(`${base}/drafts/${created.body.draft.id}/publish`)
      .send({
        draft_revision: 1,
        catalog_revision: revision,
        reason: "Synthetic test only",
        confirm: true,
        targets: [
          { level: "model", model, ...(operation ? { operation } : {}) },
        ],
      });
    expect(result.status).toBe(201);
  }
  async function update(
    policy: PricingAdmissionPolicy | null,
    operation = "chat_completions",
  ) {
    const revision = (await harness.agent.get(`${base}/admission-policies`))
      .body.head.revision;
    const response = await harness.agent.put(`${base}/admission-policy`).send({
      catalog_revision: revision,
      reason: "Explicit isolated policy change",
      confirm: true,
      scope: "workspace",
      operation,
      policy,
    });
    expect(response.status).toBe(200);
    return response;
  }
  async function detail() {
    const logs = (await harness.agent.get("/api/dashboard/logs")).body.data;
    const detail = await harness.agent.get(
      `/api/dashboard/logs/${logs[0].id}/cost-breakdown`,
    );
    expect(detail.status).toBe(200);
    return detail.body;
  }

  it("activates explicit rejection even with no price bindings, before any provider request or budget hold", async () => {
    await update({ mode: "reject_unpriced" });
    const result = await chat();
    expect(result.status).toBe(422);
    expect(result.body.error.code).toBe("pricing_admission_unpriced");
    expect(harness.fetchMock.calls).toHaveLength(0);
    expect(
      await source.query("SELECT * FROM pricing_reservations"),
    ).toHaveLength(0);
    // Removing the override inherits compatibility, rather than silently keeping a strict policy behind the editor.
    await update(null);
    expect((await chat()).status).toBe(200);
  });

  it.each([
    [
      "/v1/chat/completions",
      "chat_completions",
      {
        model: "gpt-4o",
        messages: [{ role: "user", content: "synthetic" }],
        stream: true,
      },
    ],
    [
      "/v1/responses",
      "responses",
      { model: "gpt-4o", input: "synthetic", stream: true },
    ],
    [
      "/v1/messages",
      "messages",
      {
        model: "claude-sonnet-4-20250514",
        messages: [{ role: "user", content: "synthetic" }],
        max_tokens: 20,
        stream: true,
      },
    ],
    [
      "/v1/embeddings",
      "embeddings",
      { model: "text-embedding-3-small", input: "synthetic" },
    ],
  ])(
    "rejects unpriced %s before flushing stream headers or calling the provider",
    async (path, operation, body) => {
      await update({ mode: "reject_unpriced" }, operation as string);
      const result = await harness.agent
        .post(path as string)
        .set("Authorization", `Bearer ${API_KEY}`)
        .send(body);
      expect(result.status).toBe(422);
      expect(result.body.error.code).toBe("pricing_admission_unpriced");
      expect(result.headers["content-type"]).toContain("application/json");
      expect(harness.fetchMock.calls).toHaveLength(0);
    },
  );

  it("allows compatible unknown FX with an explicit unknown cost, but rejects it when strict mode is enabled", async () => {
    await publish({ ...rates(), currency: "CNY" });
    harness.fetchMock.setHandler(async () => json());
    expect((await chat()).status).toBe(200);
    const before = await detail();
    expect(before.amount).toBeNull();
    expect(before.reservations[0].admission).toMatchObject({
      mode: "compatibility",
      guarantee: "estimate_only",
      per_attempt_cost_usd: null,
    });
    await update({ mode: "reject_unpriced" });
    const result = await chat();
    expect(result.status).toBe(422);
    expect(harness.fetchMock.calls).toHaveLength(1);
  });

  it("reserves all possible configured credential attempts, then settles actual usage instead of the conservative allowance", async () => {
    await publish();
    await update(caps);
    let held: string | undefined;
    harness.fetchMock.setHandler(async () => {
      held = (await source.query("SELECT * FROM pricing_reservations"))[0]
        .reserved_cost_usd;
      return json();
    });
    expect((await chat()).status).toBe(200);
    expect(held).toBe("7.200000000000000000"); // ($1 + $0.80) × two outer attempts × two credentials.
    const result = await detail();
    expect(result.amount).toBe("0.500000000000000000");
    expect(result.budget_committed_usd).toBe(result.amount);
    expect(result.reservations[0].admission).toMatchObject({
      attempts: 4,
      guarantee: "conditional_on_declared_limits",
      per_attempt_cost_usd: "1.800000000000000000",
    });
    expect(harness.fetchMock.calls).toHaveLength(1);
  });

  it("fences the credential-attempt allowance even if a node pool grows after reservation", async () => {
    await publish();
    await update(caps);
    const node = harness.app.get(ConfigService).getNode("mock-openai")!;
    node.credentials = [{ id: "initial-only", api_key: "synthetic-only" }];
    const ledger = harness.app.get(CostLedgerService);
    const reserve = ledger.reserve.bind(ledger);
    jest.spyOn(ledger, "reserve").mockImplementation(async (input) => {
      const result = await reserve(input);
      node.credentials!.push({ id: "added-later", api_key: "synthetic-added" });
      return result;
    });
    harness.fetchMock.setError(503, "synthetic retryable error");
    const response = await chat();
    expect(response.status).toBe(503);
    expect(harness.fetchMock.calls).toHaveLength(2); // Two outer attempts, one reserved credential attempt each.
    const reservations = await source.query(
      "SELECT * FROM pricing_reservations",
    );
    expect(JSON.parse(reservations[0].estimate_json).admission.attempts).toBe(
      2,
    );
  });

  it("refuses missing actual-media bounds and requested limits beyond the approved contract instead of reserving zero", async () => {
    await publish();
    await update({ mode: "reserve_upper_bound" });
    expect((await chat()).status).toBe(422);
    await update(caps);
    expect((await chat({ max_tokens: 41 })).body.error.code).toBe(
      "pricing_reservation_limit_exceeded",
    );
    await publish(
      book([rate("image", "image_count", "0.04", "1")]),
      "gpt-image-1",
      "image_generation",
    );
    await update({ mode: "reserve_upper_bound" }, "image_generation");
    const result = await harness.agent
      .post("/v1/images/generations")
      .set("Authorization", `Bearer ${API_KEY}`)
      .send({ model: "gpt-image-1", n: 3, prompt: "synthetic" });
    expect(result.status).toBe(422);
    expect(harness.fetchMock.calls).toHaveLength(0);
    expect(
      await source.query("SELECT * FROM pricing_reservations"),
    ).toHaveLength(0);
  });

  it("can conservatively reserve a declared image-output cap and never charges that cap as final actual image usage", async () => {
    await publish(
      book([rate("image", "image_count", "0.04", "1")]),
      "gpt-image-1",
      "image_generation",
    );
    await update(
      {
        mode: "reserve_upper_bound",
        quantity_limits: { image_count: "5" },
        limit_reference: "Synthetic output cap",
      },
      "image_generation",
    );
    let held: string | undefined;
    harness.fetchMock.setHandler(async () => {
      held = (await source.query("SELECT * FROM pricing_reservations"))[0]
        .reserved_cost_usd;
      return new Response(
        JSON.stringify({
          data: [{ b64_json: "fixture" }, { b64_json: "fixture" }],
        }),
        { headers: { "content-type": "application/json" } },
      );
    });
    const result = await harness.agent
      .post("/v1/images/generations")
      .set("Authorization", `Bearer ${API_KEY}`)
      .send({ model: "gpt-image-1", n: 3, prompt: "synthetic" });
    expect(result.status).toBe(200);
    expect(held).toBe("0.200000000000000000");
    expect((await detail()).amount).toBe("0.080000000000000000");
  });

  it("freezes admission policy with the request and does not lose incurred costs if provider usage exceeds declared caps", async () => {
    await publish();
    await update(caps);
    harness.fetchMock.setHandler(async () => {
      await update({
        ...caps,
        quantity_limits: { total_input_tokens: "1", output_tokens: "1" },
      });
      return json({
        prompt_tokens: 900,
        completion_tokens: 100,
        prompt_tokens_details: { cached_tokens: 0 },
      });
    });
    expect((await chat()).status).toBe(200);
    const result = await detail();
    expect(
      result.reservations[0].admission.quantity_bounds.total_input_tokens.value,
    ).toBe("100");
    expect(result.amount).toBe("11.000000000000000000");
    expect(result.budget_committed_usd).toBe(result.amount);
    expect(result.reservations[0].known_cost_overrun_usd).toBe(
      "3.800000000000000000",
    );
    expect(result.reservations[0].observed_limit_excesses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          dimension: "total_input_tokens",
          observed: "900",
          limit: "100",
        }),
      ]),
    );
    expect((await chat()).status).toBe(422);
    expect(harness.fetchMock.calls).toHaveLength(1);
  });

  it("exposes a read-only preview that shares the bound calculation without model/budget/snapshot writes", async () => {
    await publish();
    await update(caps);
    const before = await source.query("SELECT * FROM budget_rules");
    const response = await harness.agent
      .post(`${base}/admission-preview`)
      .send({
        target: {
          model: "gpt-4o",
          node_id: "mock-openai",
          operation: "chat_completions",
        },
        evidence: [
          { dimension: "uncached_input_tokens", value: "10" },
          { dimension: "output_tokens", value: "20" },
        ],
        attempts: 4,
      });
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      simulation: true,
      assessment: { allowed: true, reserved_cost_usd: "7.200000000000000000" },
    });
    expect(await source.query("SELECT * FROM budget_rules")).toEqual(before);
    expect(
      await source.query("SELECT * FROM pricing_request_snapshots"),
    ).toHaveLength(0);
    expect(harness.fetchMock.calls).toHaveLength(0);
  });

  it("previews an unpublished admission proposal without activating it", async () => {
    await publish();
    const before = (await harness.agent.get(`${base}/admission-policies`)).body;
    const result = await harness.agent.post(`${base}/admission-preview`).send({
      target: { model: "gpt-4o", operation: "chat_completions" },
      evidence: [
        { dimension: "uncached_input_tokens", value: "10" },
        { dimension: "output_tokens", value: "20" },
      ],
      policy: caps,
    });
    expect(result.status).toBe(201);
    expect(result.body.assessment).toMatchObject({
      mode: "reserve_upper_bound",
      policy_source: "simulation_override",
      reserved_cost_usd: "1.800000000000000000",
    });
    expect(
      (await harness.agent.get(`${base}/admission-policies`)).body,
    ).toEqual(before);
    expect(
      await source.query("SELECT * FROM pricing_request_snapshots"),
    ).toHaveLength(0);
    expect(harness.fetchMock.calls).toHaveLength(0);
  });

  it("rejects stale/unauthorized/spoofed policy publication and does not reset a policy when a price is published", async () => {
    await update(caps);
    await publish();
    const current = await harness.agent.get(`${base}/admission-policies`);
    expect(current.body.policies[0].policy.mode).toBe("reserve_upper_bound");
    const body = {
      catalog_revision: 0,
      reason: "stale",
      confirm: true,
      policy: { mode: "compatibility" },
    };
    expect(
      (await harness.agent.put(`${base}/admission-policy`).send(body)).status,
    ).toBe(409);
    expect(
      (
        await harness.agent.put(`${base}/admission-policy`).send({
          ...body,
          catalog_revision: current.body.head.revision,
          workspace_id: "someone-else",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await harness.agent
          .put(`${base}/admission-policy`)
          .set("Origin", "https://untrusted.example")
          .send(body)
      ).status,
    ).toBe(403);
    const memberships = harness.app.get(WorkspaceMembershipService);
    // Keep a separate fixture admin before testing a downgraded Dashboard identity.
    await memberships.ensureMembership({ userId: 'synthetic-fixture-admin', organizationId: DEFAULT_ORGANIZATION_ID, workspaceId: DEFAULT_WORKSPACE_ID, role: 'admin' });
    await memberships.ensureMembership({
      userId: "dashboard",
      organizationId: DEFAULT_ORGANIZATION_ID,
      workspaceId: DEFAULT_WORKSPACE_ID,
      role: "viewer",
    });
    try {
      expect(
        (await harness.agent.put(`${base}/admission-policy`).send(body)).status,
      ).toBe(403);
      expect(
        (await harness.agent.get(`${base}/admission-policies`)).status,
      ).toBe(200);
    } finally {
      await memberships.ensureMembership({
        userId: "dashboard",
        organizationId: DEFAULT_ORGANIZATION_ID,
        workspaceId: DEFAULT_WORKSPACE_ID,
        role: "admin",
      });
    }
  });
});

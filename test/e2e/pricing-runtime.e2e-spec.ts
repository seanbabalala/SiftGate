import { WorkspaceMembershipService } from "../../src/auth/workspace-membership.service";
import { PricingRepository } from "../../src/pricing/pricing-repository";
import { AlertService } from "../../src/alerts/alert.service";
import { BudgetRule } from "../../src/database/entities/budget-rule.entity";
import { tokens } from "../unit/pricing-fixtures";
import { PipelineService } from "../../src/pipeline/pipeline.service";
import { randomUUID } from "node:crypto";
import { CallLog } from "../../src/database/entities/call-log.entity";
import { PricingRecoveryService } from "../../src/pricing/pricing-recovery.service";
import { PricingRuntimeService } from "../../src/pricing/pricing-runtime.service";
import { DataSource, type EntityManager } from "typeorm";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as yaml from "js-yaml";
import { createE2EHarness, E2EHarness, FIXTURE_PATH, API_KEY } from "./setup";
import { applyPricingSchema } from "../../src/pricing/pricing-schema";
import { CostLedgerService } from "../../src/pricing/cost-ledger.service";
import { tokenBook, rate } from "../unit/pricing-fixtures";
import type { CostReservationRow, CostSettlementIntentRow, CostSettlementPayload } from "../../src/pricing/cost-ledger.types";

type SettlementInternals = {
  writeSettlementIntent(manager: EntityManager, row: CostReservationRow, payload: CostSettlementPayload): Promise<CostSettlementIntentRow>;
  applySettlementInTransaction(manager: EntityManager, row: CostReservationRow, intent: CostSettlementIntentRow): Promise<CostReservationRow>;
};

describe("real request pricing pipeline (isolated, mocked upstream)", () => {
  let harness: E2EHarness;
  let directory: string;
  const base = "/api/dashboard/pricing";
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "pricing-runtime-"));
    const config = yaml.load(readFileSync(FIXTURE_PATH, "utf8")) as Record<
      string,
      unknown
    >;
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
    config.cache = {
      enabled: true,
      ttl_seconds: 300,
      max_entries: 100,
      exclude_tool_use: true,
      stream_cache: { enabled: true },
    };
    const file = join(directory, "gateway.yaml");
    writeFileSync(file, yaml.dump(config));
    harness = await createE2EHarness(file);
    await applyPricingSchema(harness.app.get(DataSource));
  }, 30000);
  afterEach(async () => {
    await harness?.close();
    rmSync(directory, { recursive: true, force: true });
  });

  async function publish(content = tokenBook(), model = "gpt-4o") {
    const created = await harness.agent
      .post(`${base}/books`)
      .send({ name: "Runtime fixture", content });
    expect(created.status).toBe(201);
    const head = (await harness.agent.get(`${base}/bindings`)).body.head;
    const result = await harness.agent
      .post(`${base}/drafts/${created.body.draft.id}/publish`)
      .send({
        draft_revision: 1,
        catalog_revision: head.revision,
        reason: "test only",
        confirm: true,
        targets: [{ level: "model", model }],
      });
    expect(result.status).toBe(201);
    return { book: created.body.book, version: result.body.version_id };
  }
  const call = (text = "hello") =>
    harness.agent
      .post("/v1/chat/completions")
      .set("Authorization", `Bearer ${API_KEY}`)
      .send({
        model: "gpt-4o",
        max_tokens: 20,
        messages: [{ role: "user", content: text }],
      });
  const response = (input = 10, output = 5, cached = 0) =>
    new Response(
      JSON.stringify({
        id: "synthetic-response",
        model: "gpt-4o",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "synthetic answer" },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: input,
          completion_tokens: output,
          prompt_tokens_details: { cached_tokens: cached },
          cache_creation_input_tokens: 0,
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

  function contextBook() {
    const content = tokenBook();
    content.groups.push({
      id: "context",
      order: 1,
      required: true,
      rules: [
        {
          id: "short",
          priority: 0,
          mode: "whole_request",
          condition: { input_tokens: { min: "0", max: "272001" } },
          rates: [],
        },
        {
          id: "long",
          priority: 0,
          mode: "whole_request",
          condition: { input_tokens: { min: "272001" } },
          rates: [
            rate("long-input", "uncached_input_tokens", "2"),
            rate("long-read", "cache_read_tokens", "0.2"),
            rate("long-output", "output_tokens", "3"),
          ].map((component) => ({ operation: "replace", component })),
        },
      ],
    });
    return content;
  }

  async function quotePublished(
    published: { book: { id: string }; version: string },
    input: number,
    output: number,
    cached = 0,
    write5m = 0,
    write1h = 0,
  ) {
    const before = await harness.app.get(DataSource).query("SELECT * FROM budget_rules ORDER BY id");
    // Quote/UI evidence uses disjoint dimensions: cache_write_tokens is the
    // unknown-TTL remainder, not the total already assigned to 5m/1h counters.
    const evidence = [
      ["total_input_tokens", input],
      ["uncached_input_tokens", input - cached - write5m - write1h],
      ["cache_read_tokens", cached],
      ["cache_write_tokens", 0],
      ["cache_write_5m_tokens", write5m],
      ["cache_write_1h_tokens", write1h],
      ["output_tokens", output],
    ].map(([dimension, value]) => ({ dimension, value: String(value), source: "request_metadata", quality: "observed" }));
    const result = await harness.agent.post(`${base}/quote`).send({
      book_id: published.book.id,
      version_id: published.version,
      evidence,
    });
    expect(result.status).toBe(201);
    expect(result.body.simulation).toBe(true);
    expect(await harness.app.get(DataSource).query("SELECT * FROM budget_rules ORDER BY id")).toEqual(before);
    return result.body.cost;
  }

  it.each([
    { id: "CALC-01", input: 1000, output: 500, amount: "0.002000000" },
    { id: "CALC-03 lower boundary", input: 272000, output: 1000, amount: "0.274000000" },
    { id: "CALC-03 upper boundary", input: 272001, output: 1000, amount: "0.547002000" },
  ])("$id agrees between the management quote and actual request settlement", async ({ input, output, amount }) => {
    const published = await publish(contextBook());
    const simulated = await quotePublished(published, input, output);
    expect(simulated.amount).toBe(amount);
    expect(harness.fetchMock.calls).toHaveLength(0);
    harness.fetchMock.setHandler(async () => response(input, output));
    expect((await call()).status).toBe(200);
    const log = (await harness.agent.get("/api/dashboard/logs")).body.data[0];
    const detail = (await harness.agent.get(`/api/dashboard/logs/${log.id}/cost-breakdown`)).body;
    expect(detail.amount).toBe(`${amount}000000000`);
    expect(detail.budget_committed_usd).toBe(detail.amount);
    expect(detail.attempts[0].cost.amount).toBe(simulated.amount);
    expect(detail.attempts[0].cost.selected_rule_ids).toEqual(simulated.selected_rule_ids);
    expect(detail.attempts[0].cost.version_id).toBe(published.version);
    expect(harness.fetchMock.calls).toHaveLength(1);
  });

  it("settles long context using total cached-inclusive input and the same immutable receipt in logs", async () => {
    const published = await publish(contextBook());
    const simulated = await quotePublished(published, 300000, 10000, 280000);
    expect(simulated.amount).toBe("0.126000000");
    harness.fetchMock.setHandler(async () => response(300000, 10000, 280000));
    const result = await call();
    expect(result.status).toBe(200);
    expect(result.body.usage.prompt_tokens).toBe(300000);
    expect(JSON.stringify(result.body)).not.toContain("adapter_id");
    const log = (await harness.agent.get("/api/dashboard/logs")).body.data[0];
    expect(log.cost_usd).toBeCloseTo(0.126, 9);
    const detail = await harness.agent.get(
      `/api/dashboard/logs/${log.id}/cost-breakdown`,
    );
    expect(detail.status).toBe(200);
    expect(detail.body.amount).toBe("0.126000000000000000");
    expect(detail.body.attempts[0].cost.version_id).toBe(published.version);
    expect(detail.body.attempts[0].cost.selected_rule_ids).toContain("long");
    expect(detail.body.attempts[0].cost.amount).toBe(simulated.amount);
    expect(detail.body.attempts[0].cost.usage.quantities.uncached_input_tokens.value).toBe("20000");
    expect(detail.body.budget_reserved_usd).toBe("0.000000000000000000");
    expect(detail.body.budget_committed_usd).toBe("0.126000000000000000");
    expect(harness.fetchMock.calls).toHaveLength(1);
  });

  it("keeps an in-flight request on the old price and never reprices historical logs", async () => {
    const original = await publish();
    let changed = false;
    harness.fetchMock.setHandler(async () => {
      if (!changed) {
        changed = true;
        const next = tokenBook();
        next.groups[0].rules[0].rates[0].component.amount = "9";
        await publish(next);
      }
      return response();
    });
    expect((await call("old request")).status).toBe(200);
    const first = (await harness.agent.get("/api/dashboard/logs")).body.data[0];
    expect(first.cost_usd).toBeCloseTo(0.00002, 12);
    expect(
      (
        await harness.agent.get(
          `/api/dashboard/logs/${first.id}/cost-breakdown`,
        )
      ).body.attempts[0].cost.version_id,
    ).toBe(original.version);
    expect((await call("new request")).status).toBe(200);
    const logs = (await harness.agent.get("/api/dashboard/logs")).body.data;
    expect(
      logs.find((entry: { id: number }) => entry.id === first.id).cost_usd,
    ).toBe(first.cost_usd);
    expect(
      logs.find((entry: { id: number }) => entry.id !== first.id).cost_usd,
    ).toBeCloseTo(0.0001, 12);
  });

  it("records failed retry attempts as unknown rather than declaring all upstream cost known", async () => {
    await publish();
    let calls = 0;
    harness.fetchMock.setHandler(async () =>
      ++calls === 1
        ? new Response(
            JSON.stringify({ error: { message: "synthetic failure" } }),
            { status: 500 },
          )
        : response(),
    );
    const retried = await call();
    expect({
      status: retried.status,
      body: retried.body,
      calls: harness.fetchMock.calls.length,
    }).toMatchObject({ status: 200 });
    const log = (await harness.agent.get("/api/dashboard/logs")).body.data[0];
    const summary = (
      await harness.agent.get(`/api/dashboard/logs/${log.id}/cost-breakdown`)
    ).body;
    expect(summary.provider_attempts).toBe(2);
    expect(summary.unknown_attempts).toBe(1);
    expect(summary.status).toBe("partial");
    expect(summary.amount).toBeNull();
    expect(summary.known_subtotal).toBe("0.000020000000000000");
  });

  it("separates local-cache upstream zero from compatible logical budget usage", async () => {
    await publish();
    harness.fetchMock.setHandler(async () => response());
    expect((await call("cache sample")).status).toBe(200);
    harness.fetchMock.reset();
    expect((await call("cache sample")).status).toBe(200);
    expect(harness.fetchMock.calls).toHaveLength(0);
    const logs = (await harness.agent.get("/api/dashboard/logs")).body.data;
    const cached = logs.find((log: { tier: string }) => log.tier === "cached");
    expect(cached).toBeDefined();
    expect(cached.cost_usd).toBe(0);
    const detail = (
      await harness.agent.get(`/api/dashboard/logs/${cached.id}/cost-breakdown`)
    ).body;
    expect(detail.status).toBe("free");
    expect(detail.provider_attempts).toBe(0);
    expect(Number(detail.budget_committed_usd)).toBeGreaterThan(0);
  });

  it("uses composed settlement for ordinary JSON and local-cache calls without a second public application", async () => {
    await publish();
    harness.fetchMock.setHandler(async () => response());
    const ledger = harness.app.get(CostLedgerService), source = harness.app.get(DataSource);
    const composed = jest.spyOn(ledger, "persistAndApplyRuntimeSettlement");
    const separateApply = jest.spyOn(ledger, "applySettlement");
    try {
      expect((await call("composed cache request")).status).toBe(200);
      expect((await call("composed cache request")).status).toBe(200);
      await harness.app.get(PricingRuntimeService).waitForRequests();
      expect(composed).toHaveBeenCalledTimes(2);
      expect(separateApply).not.toHaveBeenCalled();
      expect(harness.fetchMock.calls).toHaveLength(1);
      const logs = await source.getRepository(CallLog).find();
      expect(logs).toHaveLength(2);
      for (const log of logs) {
        if (!log.workspace_id) throw new Error("Expected a workspace-scoped fixture log");
        const detail = await ledger.summary(log.request_id, log.workspace_id);
        expect(detail?.budget_committed_usd).toBe("0.000020000000000000");
        expect(detail?.budget_reserved_usd).toBe("0.000000000000000000");
        expect(detail?.amount).toBe(log.tier === "cached" ? "0.000000000000000000" : "0.000020000000000000");
        expect(log.cost_usd).toBe(log.tier === "cached" ? 0 : .00002);
      }
      expect(await source.query("SELECT * FROM pricing_budget_effects WHERE kind = 'commit'")).toHaveLength(2);
      expect((await source.query("SELECT state FROM pricing_settlement_intents")).map((row: { state: string }) => row.state)).toEqual(["applied", "applied"]);
    } finally { composed.mockRestore(); separateApply.mockRestore(); }
  });

  it("settles the final cumulative SSE usage once without using canonical fallback zeroes", async () => {
    await publish();
    const frame = (input: number, output: number) =>
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: input, completion_tokens: output, prompt_tokens_details: { cached_tokens: 30 }, cache_creation_input_tokens: 0 } })}\n\n`;
    harness.fetchMock.setHandler(
      async () =>
        new Response(
          frame(100, 2) + frame(100, 20) + frame(100, 20) + "data: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    const result = await harness.agent
      .post("/v1/chat/completions")
      .set("Authorization", `Bearer ${API_KEY}`)
      .send({
        model: "gpt-4o",
        stream: true,
        max_tokens: 20,
        messages: [{ role: "user", content: "stream evidence" }],
      });
    expect(result.status).toBe(200);
    // SSE ends after durable retention; final accounting remains tracked work.
    // Await that signal rather than assuming the next GET races behind it.
    await harness.app.get(PricingRuntimeService).waitForRequests();
    const logs = await harness.agent.get("/api/dashboard/logs");
    const detail = (
      await harness.agent.get(
        `/api/dashboard/logs/${logs.body.data[0].id}/cost-breakdown`,
      )
    ).body;
    expect(detail.amount).toBe("0.000113000000000000");
    expect(detail.budget_committed_usd).toBe(detail.amount);
    expect(detail.budget_reserved_usd).toBe("0.000000000000000000");
    expect(detail.attempts[0].cost.usage.quantities.output_tokens.value).toBe(
      "20",
    );
    expect(detail.provider_attempts).toBe(1);
  });

  it("keeps missing and malformed provider usage unknown while returning a valid model response", async () => {
    await publish();
    harness.fetchMock.setHandler(
      async () =>
        new Response(
          JSON.stringify({
            id: "missing-usage",
            model: "gpt-4o",
            choices: [
              {
                message: { role: "assistant", content: "answer" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: "not-a-counter", completion_tokens: 5 },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    expect((await call("missing usage")).status).toBe(200);
    const log = (await harness.agent.get("/api/dashboard/logs")).body.data[0];
    const detail = (
      await harness.agent.get(`/api/dashboard/logs/${log.id}/cost-breakdown`)
    ).body;
    expect(detail.amount).toBeNull();
    expect(detail.unknown_attempts).toBe(1);
    expect(detail.attempts[0].cost.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "pricing_invalid_quantity" }),
      ]),
    );
    expect(harness.fetchMock.calls).toHaveLength(1);
  });

  it("replays immutable evidence at a new price without mutating cost, budgets or making provider requests", async () => {
    await publish();
    harness.fetchMock.setHandler(async () => response());
    expect((await call("replay fixture")).status).toBe(200);
    const log = (await harness.agent.get("/api/dashboard/logs")).body.data[0];
    const before = (
      await harness.agent.get(`/api/dashboard/logs/${log.id}/cost-breakdown`)
    ).body;
    const next = tokenBook();
    next.groups[0].rules[0].rates[0].component.amount = "10";
    harness.fetchMock.reset();
    const replay = await harness.agent
      .post(`${base}/replay`)
      .send({ request_ids: [log.request_id], content: next });
    expect(replay.status).toBe(201);
    expect(replay.body.historical_records_modified).toBe(false);
    expect(replay.body.results[0].simulations[0].simulated.report_amount).toBe(
      "0.000110000",
    );
    expect(
      (await harness.agent.get(`/api/dashboard/logs/${log.id}/cost-breakdown`))
        .body,
    ).toEqual(before);
    expect(harness.fetchMock.calls).toHaveLength(0);
  });

  it("returns only allowlisted log metadata alongside immutable cost evidence", async () => {
    await publish();
    harness.fetchMock.setHandler(async () => response());
    expect((await call("synthetic private prompt sentinel")).status).toBe(200);
    const logs = harness.app.get(DataSource).getRepository(CallLog);
    const log = (await logs.find())[0];
    await logs.update(log.id, {
      error: "synthetic private error sentinel",
      reasoning_reason: "synthetic private rationale sentinel",
      api_key_name: "synthetic private key sentinel",
      cost_without_cache_usd: 0.123,
    });
    const result = await harness.agent.get(
      `/api/dashboard/logs/${log.id}/cost-breakdown`,
    );
    expect(result.status).toBe(200);
    expect(Object.keys(result.body.log).sort()).toEqual(
      [
        "id",
        "request_id",
        "timestamp",
        "model",
        "node_id",
        "source_format",
        "status_code",
        "input_tokens",
        "output_tokens",
        "stored_cost_usd",
        "stored_reference_cost_usd",
      ].sort(),
    );
    expect(result.body.log).toMatchObject({
      id: log.id,
      request_id: log.request_id,
      input_tokens: 10,
      output_tokens: 5,
      stored_reference_cost_usd: "0.123",
      stored_cost_usd: String(log.cost_usd),
    });
    expect(result.body.log.timestamp).toBe(log.timestamp.toISOString());
    expect(result.body.reservations[0]).toMatchObject({
      committed_tokens: "15",
    });
    expect(typeof result.body.reservations[0].reserved_tokens).toBe("string");
    expect(JSON.stringify(result.body)).not.toContain("sentinel");
    expect(harness.fetchMock.calls).toHaveLength(1);
  });

  it("does not turn an after-commit alert failure into a provider retry or failed response", async () => {
    await publish();
    const source = harness.app.get(DataSource);
    await source
      .getRepository(BudgetRule)
      .update({ type: "daily_cost" }, { alert_threshold: 0.00000001 });
    const emitter = jest
      .spyOn(harness.app.get(AlertService), "emit")
      .mockImplementation(() => {
        throw new Error("synthetic notification sink failure");
      });
    harness.fetchMock.setHandler(async () => response());
    try {
      expect((await call("post-commit notification fixture")).status).toBe(200);
      expect(
        emitter.mock.calls.some(([event]) => event.type === "budget_threshold"),
      ).toBe(true);
      expect(harness.fetchMock.calls).toHaveLength(1);
      const log = (await harness.agent.get("/api/dashboard/logs")).body.data[0];
      const cost = (
        await harness.agent.get(`/api/dashboard/logs/${log.id}/cost-breakdown`)
      ).body;
      expect(cost.amount).toBe("0.000020000000000000");
      expect(cost.budget_committed_usd).toBe("0.000020000000000000");
      expect(cost.reservations[0].settlement_status).toBe("applied");
    } finally {
      emitter.mockRestore();
    }
  });

  it("identifies cache replays as reference simulations without changing zero upstream cost", async () => {
    await publish();
    harness.fetchMock.setHandler(async () => response());
    expect((await call("cache replay fixture")).status).toBe(200);
    expect((await call("cache replay fixture")).status).toBe(200);
    const logs = (await harness.agent.get("/api/dashboard/logs")).body.data;
    const cached = logs.find(
      (log: { node_id: string }) => log.node_id === "cache",
    );
    expect(cached).toBeDefined();
    const before = (
      await harness.agent.get(`/api/dashboard/logs/${cached.id}/cost-breakdown`)
    ).body;
    const replay = await harness.agent
      .post(`${base}/replay`)
      .send({ request_ids: [cached.request_id], content: tokenBook() });
    expect(replay.status).toBe(201);
    expect(replay.body.results[0].simulations[0]).toMatchObject({
      fee_source: "local_cache",
      original: { report_amount: "0" },
    });
    expect(
      replay.body.results[0].simulations[0].simulated.report_amount,
    ).not.toBe("0");
    expect(
      (
        await harness.agent.get(
          `/api/dashboard/logs/${cached.id}/cost-breakdown`,
        )
      ).body,
    ).toEqual(before);
    expect(harness.fetchMock.calls).toHaveLength(1);
  });

  it("preserves legacy stored costs and reference null/zero without current-price reconstruction", async () => {
    const logs = harness.app.get(DataSource).getRepository(CallLog);
    const log = await logs.save(
      logs.create({
        request_id: "legacy-cost-metadata",
        source_format: "chat_completions",
        tier: "standard",
        score: 0,
        node_id: "mock-openai",
        model: "gpt-4o",
        cost_usd: 0.42,
        input_tokens: 100,
        output_tokens: 20,
        cost_without_cache_usd: null,
      }),
    );
    const before = await harness.agent.get(
      `/api/dashboard/logs/${log.id}/cost-breakdown`,
    );
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({
      status: "legacy_estimate",
      amount: "0.42",
      replayable: false,
      log: { stored_reference_cost_usd: null },
    });
    const next = tokenBook();
    next.groups[0].rules[0].rates[0].component.amount = "999";
    await publish(next);
    expect(
      (await harness.agent.get(`/api/dashboard/logs/${log.id}/cost-breakdown`))
        .body,
    ).toEqual(before.body);
    await logs.update(log.id, { cost_without_cache_usd: 0 });
    expect(
      (await harness.agent.get(`/api/dashboard/logs/${log.id}/cost-breakdown`))
        .body.log.stored_reference_cost_usd,
    ).toBe("0");
    const replay = await harness.agent
      .post(`${base}/replay`)
      .send({ request_ids: [log.request_id], content: next });
    expect(replay.body.results).toEqual([
      { request_id: log.request_id, status: "not_replayable" },
    ]);
    expect(harness.fetchMock.calls).toHaveLength(0);
  });

  it("does not expose foreign-workspace log metadata and rejects unsafe IDs", async () => {
    await publish();
    harness.fetchMock.setHandler(async () => response());
    expect((await call()).status).toBe(200);
    const logs = harness.app.get(DataSource).getRepository(CallLog),
      log = (await logs.find())[0];
    await logs.update(log.id, { workspace_id: "foreign-metadata-scope" });
    expect(
      (await harness.agent.get(`/api/dashboard/logs/${log.id}/cost-breakdown`))
        .status,
    ).toBe(404);
    for (const id of ["-1", "1.5", "NaN", "9007199254740992"])
      expect(
        (await harness.agent.get(`/api/dashboard/logs/${id}/cost-breakdown`))
          .status,
      ).toBe(400);
  });

  it.each([
    { id: "native Messages", uncached: 30, cached: 40, write5m: 20, write1h: 10, output: 5, amount: "0.000089000000000000" },
    { id: "CALC-02", uncached: 4500, cached: 4000, write5m: 1000, write1h: 500, output: 0, amount: "0.007150000000000000" },
  ])("$id settles raw SSE cache TTLs exactly and agrees with the quote", async ({ uncached, cached, write5m, write1h, output, amount }) => {
    const model = "claude-sonnet-4-20250514";
    const published = await publish(tokenBook(), model);
    const simulated = await quotePublished(published, uncached + cached + write5m + write1h, output, cached, write5m, write1h);
    const frame = (event: string, body: unknown) =>
      `event: ${event}\ndata: ${JSON.stringify(body)}\n\n`;
    const raw =
      frame("message_start", {
        type: "message_start",
        message: {
          id: "synthetic-message",
          model,
          usage: {
            input_tokens: uncached,
            output_tokens: 0,
            cache_read_input_tokens: cached,
            cache_creation_input_tokens: write5m + write1h,
            cache_creation: {
              ephemeral_5m_input_tokens: write5m,
              ephemeral_1h_input_tokens: write1h,
            },
          },
        },
      }) +
      frame("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: output },
      }) +
      frame("message_stop", { type: "message_stop" });
    harness.fetchMock.setHandler(
      async () =>
        new Response(raw, { headers: { "content-type": "text/event-stream" } }),
    );
    const result = await harness.agent
      .post("/v1/messages")
      .set("Authorization", `Bearer ${API_KEY}`)
      .send({
        model,
        stream: true,
        max_tokens: 20,
        messages: [{ role: "user", content: "Messages evidence" }],
      });
    expect(result.status).toBe(200);
    expect(result.text).toBe(raw);
    await harness.app.get(PricingRuntimeService).waitForRequests();
    const log = (await harness.agent.get("/api/dashboard/logs")).body.data[0];
    const detail = (
      await harness.agent.get(`/api/dashboard/logs/${log.id}/cost-breakdown`)
    ).body;
    expect(detail.amount).toBe(amount);
    expect(detail.budget_committed_usd).toBe(detail.amount);
    expect(detail.attempts[0].cost.amount).toBe(simulated.amount);
    expect(detail.attempts[0].cost.usage.quantities.uncached_input_tokens.value).toBe(String(uncached));
    expect(
      detail.attempts[0].cost.usage.quantities.cache_write_5m_tokens.value,
    ).toBe(String(write5m));
    expect(
      detail.attempts[0].cost.usage.quantities.cache_write_1h_tokens.value,
    ).toBe(String(write1h));
    expect(harness.fetchMock.calls).toHaveLength(1);
  });

  it("settles embeddings with observed input and an explicit output-zero operation", async () => {
    const model = "text-embedding-3-small";
    await publish(tokenBook(), model);
    harness.fetchMock.setHandler(
      async () =>
        new Response(
          JSON.stringify({
            object: "list",
            model,
            data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2] }],
            usage: { prompt_tokens: 100, total_tokens: 100 },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    const result = await harness.agent
      .post("/v1/embeddings")
      .set("Authorization", `Bearer ${API_KEY}`)
      .send({ model, input: "synthetic embedding" });
    expect(result.status).toBe(200);
    const log = (await harness.agent.get("/api/dashboard/logs")).body.data[0];
    const detail = (
      await harness.agent.get(`/api/dashboard/logs/${log.id}/cost-breakdown`)
    ).body;
    expect(detail.amount).toBe("0.000100000000000000");
    expect(detail.status).toBe("estimated");
    expect(detail.budget_committed_usd).toBe(detail.amount);
    expect(detail.attempts[0].cost.usage.quantities.output_tokens.value).toBe(
      "0",
    );
    expect(harness.fetchMock.calls).toHaveLength(1);
  });

  it.each(["before_budget", "after_budget"] as const)("recovers a composed %s failure from retained evidence without another provider call", async phase => {
    await publish();
    harness.fetchMock.setHandler(async () => response());
    const ledger = harness.app.get(CostLedgerService), source = harness.app.get(DataSource);
    const runtime = harness.app.get(PricingRuntimeService), internal = ledger as unknown as SettlementInternals;
    const apply = internal.applySettlementInTransaction.bind(ledger);
    const fail = jest.spyOn(internal, "applySettlementInTransaction").mockImplementationOnce(async (...args) => {
      if (phase === "after_budget") await apply(...args);
      throw new Error("synthetic application outage");
    });
    try {
      expect((await call("durable composed outcome")).status).toBe(200);
      expect(fail).toHaveBeenCalledTimes(1);
    } finally {
      fail.mockRestore();
    }
    const log = (await harness.agent.get("/api/dashboard/logs")).body.data[0];
    const before = (
      await harness.agent.get(`/api/dashboard/logs/${log.id}/cost-breakdown`)
    ).body;
    expect(before.reservations[0].state).toBe("reserved");
    expect(await source.query("SELECT * FROM pricing_settlement_intents")).toHaveLength(0);
    expect(await source.query("SELECT * FROM pricing_budget_effects WHERE kind = 'commit'")).toHaveLength(0);
    expect(await source.query("SELECT state FROM pricing_runtime_outcomes WHERE kind = 'settlement'")).toEqual([{ state: "pending" }]);
    expect(runtime.outcomeRetryStatus().pending).toBe(1);
    expect(Number(before.budget_reserved_usd)).toBeGreaterThan(0);
    expect(before.budget_committed_usd).toBe("0.000000000000000000");
    expect(harness.fetchMock.calls).toHaveLength(1);
    await runtime.flushPendingOutcomes(new Date(), true);
    await harness.app.get(PricingRecoveryService).runOnce();
    const after = (
      await harness.agent.get(`/api/dashboard/logs/${log.id}/cost-breakdown`)
    ).body;
    expect(after.reservations[0].settlement_status).toBe("applied");
    expect(after.budget_reserved_usd).toBe("0.000000000000000000");
    expect(after.budget_committed_usd).toBe(after.amount);
    expect(after.amount).toBe("0.000020000000000000");
    expect(await source.query("SELECT * FROM pricing_budget_effects WHERE kind = 'commit'")).toHaveLength(1);
    expect(harness.fetchMock.calls).toHaveLength(1);
    await harness.app.get(PricingRecoveryService).runOnce();
    expect(
      (await harness.agent.get(`/api/dashboard/logs/${log.id}/cost-breakdown`))
        .body,
    ).toEqual(after);
  });

  it('retries both pre-durable receipt and terminal-intent failures without changing price or dispatching again', async () => {
    const published = await publish();
    harness.fetchMock.setHandler(async () => response());
    const ledger = harness.app.get(CostLedgerService), runtime = harness.app.get(PricingRuntimeService), source = harness.app.get(DataSource);
    const prepare = jest.spyOn(ledger, 'prepareRuntimeReceipt').mockRejectedValueOnce(new Error('synthetic receipt preparation outage'));
    const receipt = jest.spyOn(ledger, 'completeAttempt').mockRejectedValueOnce(new Error('synthetic receipt persistence outage'));
    const intent = jest.spyOn(ledger as unknown as SettlementInternals, 'writeSettlementIntent').mockRejectedValueOnce(new Error('synthetic pre-durable intent outage'));
    try { expect((await call('synthetic-private-prompt-not-for-retry-buffer')).status).toBe(200); expect(prepare).toHaveBeenCalledTimes(1); }
    finally { prepare.mockRestore(); receipt.mockRestore(); intent.mockRestore(); }
    expect(runtime.outcomeRetryStatus()).toMatchObject({ pending: 2 });
    expect(await runtime.renewActiveLeases()).toBe(1);
    expect(await source.query('SELECT * FROM pricing_settlement_intents')).toHaveLength(0);
    const log = (await harness.agent.get('/api/dashboard/logs')).body.data[0];
    const newBook = tokenBook(); newBook.groups[0].rules[0].rates[0] = { operation: 'replace', component: rate('input', 'uncached_input_tokens', '99') };
    await publish(newBook);
    const retry = await runtime.flushPendingOutcomes(new Date(Date.now() + 2000));
    expect(retry.persisted).toBe(2);
    await harness.app.get(PricingRecoveryService).runOnce();
    const result = (await harness.agent.get(`/api/dashboard/logs/${log.id}/cost-breakdown`)).body;
    expect(result.amount).toBe('0.000020000000000000');
    expect(result.budget_committed_usd).toBe(result.amount);
    expect(result.budget_reserved_usd).toBe('0.000000000000000000');
    expect(result.attempts[0].cost.version_id).toBe(published.version);
    expect(harness.fetchMock.calls).toHaveLength(1);
    expect(runtime.outcomeRetryStatus()).toMatchObject({ entries: 0, bytes: 0 });
    expect(await source.query('SELECT * FROM pricing_budget_effects')).toHaveLength(2);
    await runtime.flushPendingOutcomes(new Date(Date.now() + 10000));
    await harness.app.get(PricingRecoveryService).runOnce();
    expect((await harness.agent.get(`/api/dashboard/logs/${log.id}/cost-breakdown`)).body).toEqual(result);
  });

  it('deduplicates a receipt retry already repaired by the durable settlement', async () => {
    await publish(); harness.fetchMock.setHandler(async () => response());
    const ledger = harness.app.get(CostLedgerService), runtime = harness.app.get(PricingRuntimeService), source = harness.app.get(DataSource);
    const prepare = jest.spyOn(ledger, 'prepareRuntimeReceipt').mockRejectedValueOnce(new Error('synthetic receipt preparation outage'));
    const fail = jest.spyOn(ledger, 'completeAttempt').mockRejectedValueOnce(new Error('synthetic receipt outage'));
    try { expect((await call('receipt repair')).status).toBe(200); expect(prepare).toHaveBeenCalledTimes(1); } finally { prepare.mockRestore(); fail.mockRestore(); }
    const before = await source.query('SELECT id, cost_hash, cost_json FROM pricing_attempts');
    expect(before[0].cost_hash).toBeTruthy();
    expect(runtime.outcomeRetryStatus().pending).toBe(1);
    await runtime.flushPendingOutcomes(new Date(Date.now() + 2000));
    expect(await source.query('SELECT id, cost_hash, cost_json FROM pricing_attempts')).toEqual(before);
    expect(await source.query('SELECT * FROM pricing_budget_effects')).toHaveLength(2);
    expect(harness.fetchMock.calls).toHaveLength(1);
  });

  it('applies bounded accounting backpressure before another provider dispatch', async () => {
    await publish(); harness.fetchMock.setHandler(async () => response());
    const ledger = harness.app.get(CostLedgerService), runtime = harness.app.get(PricingRuntimeService);
    const limits = (runtime as unknown as { outcomes: { limits: { entries: number } } }).outcomes.limits;
    limits.entries = 1;
    const receipt = jest.spyOn(ledger, 'completeAttempt').mockRejectedValue(new Error('synthetic receipt outage'));
    const intent = jest.spyOn(ledger as unknown as SettlementInternals, 'writeSettlementIntent').mockRejectedValue(new Error('synthetic intent outage'));
    try {
      expect((await call('first admitted request')).status).toBe(200);
      expect(runtime.outcomeRetryStatus()).toMatchObject({ entries: 1 });
      const next = await call('must not dispatch another request');
      expect(next.status).toBe(503);
      expect(harness.fetchMock.calls).toHaveLength(1);
    } finally { receipt.mockRestore(); intent.mockRestore(); limits.entries = 1000; }
    await runtime.flushPendingOutcomes(new Date(Date.now() + 2000));
    expect(runtime.outcomeRetryStatus()).toMatchObject({ entries: 0, bytes: 0 });
  });

  it('exposes scoped operator orphan status through a read-only API, never through a recovery GET side effect', async () => {
    await publish();
    const prices = harness.app.get(PricingRepository), ledger = harness.app.get(CostLedgerService), source = harness.app.get(DataSource);
    for (const workspace of ['default-workspace', 'foreign-workspace']) {
      const requestId = `synthetic-orphan-${workspace}`;
      const snapshot = (await prices.capture({ request_id: requestId, workspace_id: workspace, report_currency: 'USD' }))!;
      const target = { node_id: 'mock-openai', model: 'gpt-4o' };
      await ledger.reserve({ id: requestId, requestId, identity: { workspaceId: workspace, apiKeyName: null, apiKeyId: null, namespaceId: null, teamId: null }, target, estimate: snapshot.quote(target, tokens({ input_tokens: 10, output_tokens: 5 })).cost, tokens: '15', costUsd: '0.01', budgetBasis: 'legacy_logical', leaseOwner: 'synthetic-exited-owner', leaseUntil: new Date(Date.now() - 60000).toISOString() });
      await ledger.beginAttempt({ id: requestId, requestId, workspace, reservationId: requestId, target, feeSource: 'provider', dispatchedAt: new Date().toISOString(), priceContext: { context: {}, legacyPrice: null } });
    }
    const before = await source.query('SELECT * FROM pricing_budget_effects ORDER BY id');
    expect((await harness.agent.get(`${base}/recovery-cases`)).body.items).toEqual([]);
    await ledger.reconcileDispatched();
    const listed = await harness.agent.get(`${base}/recovery-cases`);
    expect(listed.status).toBe(200);
    expect(listed.body.items).toHaveLength(1);
    expect(listed.body.items[0]).toMatchObject({ workspace_id: 'default-workspace', state: 'open', reason: 'attempt_outcome_unknown' });
    expect(listed.body.items[0]).not.toHaveProperty('evidence_json');
    expect(await source.query('SELECT * FROM pricing_budget_effects ORDER BY id')).toEqual(before);
    const members = harness.app.get(WorkspaceMembershipService);
    await members.ensureMembership({ userId: 'synthetic-other-admin', organizationId: 'default-org', workspaceId: 'default-workspace', role: 'admin' });
    await members.ensureMembership({ userId: 'dashboard', organizationId: 'default-org', workspaceId: 'default-workspace', role: 'viewer' });
    expect((await harness.agent.get(`${base}/recovery-cases`)).status).toBe(403);
    expect(harness.fetchMock.calls).toHaveLength(0);
  });

  it("renews only in-flight request holds and releases the metadata lease after completion", async () => {
    await publish();
    const runtime = harness.app.get(PricingRuntimeService);
    harness.fetchMock.setHandler(async () => {
      const source = harness.app.get(DataSource);
      const before = (
        await source.query("SELECT lease_until FROM pricing_reservations")
      )[0].lease_until;
      expect(
        await runtime.renewActiveLeases(new Date(Date.now() + 60000)),
      ).toBe(1);
      const after = (
        await source.query("SELECT lease_until FROM pricing_reservations")
      )[0].lease_until;
      expect(Date.parse(after)).toBeGreaterThan(Date.parse(before));
      return response();
    });
    expect((await call("renewed in flight")).status).toBe(200);
    expect(await runtime.renewActiveLeases()).toBe(0);
    expect(harness.fetchMock.calls).toHaveLength(1);
  });

  it("projects a usage correction into logs while retaining the original receipt and frozen prices", async () => {
    await publish();
    harness.fetchMock.setHandler(async () => response());
    expect((await call("corrected usage")).status).toBe(200);
    const log = (await harness.agent.get("/api/dashboard/logs")).body.data[0];
    const ledger = harness.app.get(CostLedgerService);
    const before = (
      await harness.agent.get(`/api/dashboard/logs/${log.id}/cost-breakdown`)
    ).body;
    const changed = tokenBook();
    changed.groups[0].rules[0].rates[0].component.amount = "99";
    await publish(changed);
    const frozen = await harness.app
      .get(PricingRepository)
      .restoreRequest(log.request_id, log.workspace_id);
    const updated = frozen.quote(
      { node_id: "mock-openai", model: "gpt-4o" },
      tokens({ input_tokens: 20, output_tokens: 5 }),
    ).cost;
    await ledger.adjustAttempt({
      id: "e2e-usage-correction",
      workspace: log.workspace_id,
      attemptId: before.attempts[0].id,
      expectedCostHash: before.attempts[0].cost_hash,
      cost: updated,
      reason: "Synthetic corrected supplier usage",
      actorId: "system:test",
      source: "provider_usage",
    });
    const detail = (
      await harness.agent.get(`/api/dashboard/logs/${log.id}/cost-breakdown`)
    ).body;
    expect(detail.attempts[0].cost).toEqual(before.attempts[0].cost);
    expect(detail.amount).toBe("0.000030000000000000");
    expect(detail.budget_committed_usd).toBe(detail.amount);
    expect(detail.attempts[0].adjustments).toHaveLength(1);
    const afterLog = (
      await harness.agent.get("/api/dashboard/logs")
    ).body.data.find((entry: { id: number }) => entry.id === log.id);
    expect(afterLog.cost_usd).toBeCloseTo(0.00003, 12);
    const replay = await harness.agent
      .post(`${base}/replay`)
      .send({ request_ids: [log.request_id], content: tokenBook() });
    expect(replay.status).toBe(201);
    expect(replay.body.results[0].simulations[0].original.report_amount).toBe(
      "0.000030000",
    );
    expect(
      replay.body.results[0].simulations[0].initial_receipt.report_amount,
    ).toBe("0.000020000");
    expect(harness.fetchMock.calls).toHaveLength(1);
  });

  it("updates an existing log when a dispatched fallback receipt arrives after its logical hold was released", async () => {
    await publish();
    harness.fetchMock.setHandler(async () => response());
    expect((await call("late receipt")).status).toBe(200);
    const log = (await harness.agent.get("/api/dashboard/logs")).body.data[0];
    const ledger = harness.app.get(CostLedgerService);
    const frozen = await harness.app
      .get(PricingRepository)
      .restoreRequest(log.request_id, log.workspace_id);
    const cost = frozen.quote(
      { node_id: "mock-openai", model: "gpt-4o" },
      tokens({ input_tokens: 25, output_tokens: 0 }),
    ).cost;
    await ledger.reserve({
      id: "late-reservation",
      requestId: log.request_id,
      identity: {
        workspaceId: log.workspace_id,
        apiKeyName: null,
        apiKeyId: null,
        namespaceId: null,
        teamId: null,
      },
      target: { node_id: "mock-openai", model: "gpt-4o" },
      estimate: cost,
      tokens: "0",
      costUsd: "0",
      budgetBasis: "legacy_logical",
      leaseOwner: "test",
      leaseUntil: new Date(Date.now() + 60000).toISOString(),
    });
    await ledger.beginAttempt({
      id: "late-attempt",
      requestId: log.request_id,
      workspace: log.workspace_id,
      reservationId: "late-reservation",
      target: { node_id: "mock-openai", model: "gpt-4o" },
      feeSource: "provider",
      dispatchedAt: new Date().toISOString(),
      priceContext: { context: {}, legacyPrice: null },
    });
    await ledger.settle("late-reservation", log.workspace_id, "release");
    await ledger.completeAttempt("late-attempt", log.workspace_id, cost);
    const detail = (
      await harness.agent.get(`/api/dashboard/logs/${log.id}/cost-breakdown`)
    ).body;
    expect(detail.amount).toBe("0.000045000000000000");
    expect(detail.budget_committed_usd).toBe("0.000020000000000000");
    const afterLog = (
      await harness.agent.get("/api/dashboard/logs")
    ).body.data.find((entry: { id: number }) => entry.id === log.id);
    expect(afterLog.cost_usd).toBeCloseTo(0.000045, 12);
    expect(harness.fetchMock.calls).toHaveLength(1);
  });

  it("replaces a stale queued log projection under the same request fence", async () => {
    await publish();
    harness.fetchMock.setHandler(async () => response());
    expect((await call("queued log")).status).toBe(200);
    const source = harness.app.get(DataSource);
    const log = (await source.getRepository(CallLog).find())[0];
    log.cost_usd = 99;
    const saved = await harness.app
      .get(CostLedgerService)
      .persistCallLogs([log]);
    expect(saved?.[0].cost_usd).toBeCloseTo(0.00002, 12);
    expect(
      (await source.getRepository(CallLog).findOneByOrFail({ id: log.id }))
        .cost_usd,
    ).toBeCloseTo(0.00002, 12);
  });

  it("does not retry a successful provider call when cost receipt persistence fails", async () => {
    await publish();
    harness.fetchMock.setHandler(async () => response());
    const fail = jest
      .spyOn(harness.app.get(CostLedgerService), "completeAttempt")
      .mockRejectedValueOnce(new Error("synthetic accounting fault"));
    try {
      expect((await call()).status).toBe(200);
      expect(harness.fetchMock.calls).toHaveLength(1);
    } finally {
      fail.mockRestore();
    }
  });
});

// Real AppModule + PostgreSQL, never a production database. Each case owns a
// newly created database; only the existing synthetic provider fetch is mocked.
const joinedPostgresUrl = process.env.SIFTGATE_PRICING_TEST_POSTGRES_URL;
if (joinedPostgresUrl) {
  const url = new URL(joinedPostgresUrl);
  if (url.hostname !== '127.0.0.1' || url.port === '2099' || !/^\/pricing_goal_[a-z0-9_]+$/.test(url.pathname))
    throw Error('Joined logging tests require an isolated pricing_goal PostgreSQL URL');
}
(joinedPostgresUrl ? describe : describe.skip)('PostgreSQL joined request finalization', () => {
  let harness: E2EHarness | undefined, admin: DataSource, database: string, directory: string;
  let priorEnvFile: string | undefined;
  let pendingCleanup = Promise.resolve();
  beforeEach(async () => {
    await pendingCleanup;
    priorEnvFile = process.env.SIFTGATE_ENV_FILE;
    admin = await new DataSource({ type: 'postgres', url: joinedPostgresUrl }).initialize();
    database = 'pricing_goal_joined_' + randomUUID().replaceAll('-', '');
    await admin.query('CREATE DATABASE "' + database + '" TEMPLATE template0');
    directory = mkdtempSync(join(tmpdir(), 'joined-pg-flow-'));
    const emptyEnv = join(directory, 'empty.env'); writeFileSync(emptyEnv, ''); process.env.SIFTGATE_ENV_FILE = emptyEnv;
    const url = new URL(joinedPostgresUrl!); url.pathname = '/' + database;
    const config = yaml.load(readFileSync(FIXTURE_PATH, 'utf8')) as Record<string, unknown>;
    config.database = { type: 'postgres', url: url.toString(), synchronize: true, pool: { max: 4, min: 0 }, route_trace_write_behind: false };
    config.server = { host: '127.0.0.1', port: 0 };
    config.budget = { daily_token_limit: 10000000, daily_cost_limit: 1000 };
    config.cache = { enabled: false }; config.semantic_cache = { enabled: false };
    config.intelligence = { async_eval: { enabled: false } };
    config.hot_reload = { watch: false }; config.telemetry = { enabled: false };
    config.alerts = { enabled: false }; config.control_plane = { enabled: false };
    const file = join(directory, 'gateway.yaml'); writeFileSync(file, yaml.dump(config));
    harness = await createE2EHarness(file);
    const source = harness.app.get(DataSource); await applyPricingSchema(source);
    const prices = harness.app.get(PricingRepository);
    const actor = { id: 'synthetic-joined-admin', workspace_id: 'default-workspace', role: 'admin' as const, global_admin: true };
    const book = await prices.createBook(actor, { name: 'Synthetic joined logs', scope: 'workspace', content: tokenBook() });
    await prices.publishDraft(actor, book.draft.id, { draft_revision: 1, catalog_revision: 0, reason: 'isolated PostgreSQL HTTP test', confirm: true, targets: [{ level: 'model', model: 'gpt-4o' }] });
    harness.fetchMock.reset();
  }, 30000);
  afterEach(async () => {
    jest.restoreAllMocks();
    // Capture resource ownership before any await: a late fixture cleanup must
    // never close/drop a subsequent case's app, connection or database.
    const owned = { harness, admin, database, directory, priorEnvFile };
    harness = undefined;
    pendingCleanup = (async () => {
      const started = Date.now(); let appClosed = started;
      try { await owned.harness?.close(); appClosed = Date.now(); }
      finally {
        if (owned.admin?.isInitialized) {
          if (/^pricing_goal_joined_[a-f0-9]{32}$/.test(owned.database)) await owned.admin.query('DROP DATABASE IF EXISTS "' + owned.database + '" WITH (FORCE)');
          await owned.admin.destroy();
        }
        if (owned.directory) rmSync(owned.directory, { recursive: true, force: true });
        if (owned.priorEnvFile === undefined) delete process.env.SIFTGATE_ENV_FILE;
        else process.env.SIFTGATE_ENV_FILE = owned.priorEnvFile;
        console.info('Joined PostgreSQL fixture cleanup', { app_ms: appClosed - started, database_ms: Date.now() - appClosed });
      }
    })();
    await pendingCleanup;
  }, 30000);
  async function call() {
    return harness!.agent.post('/v1/chat/completions').set('Authorization', 'Bearer ' + API_KEY)
      .send({ model: 'gpt-4o', max_tokens: 32, messages: [{ role: 'user', content: 'synthetic joined request' }] }).expect(200);
  }
  async function settled(logs: number, traces: number) {
    const source = harness!.app.get(DataSource), ledger = harness!.app.get(CostLedgerService);
    const reservations = await source.query('SELECT request_id,state,committed_cost_usd FROM pricing_reservations');
    expect(reservations).toHaveLength(1);
    expect(reservations[0]).toMatchObject({ state: 'committed', committed_cost_usd: '0.000020000000000000' });
    expect((await ledger.summary(reservations[0].request_id, 'default-workspace'))?.known_subtotal).toBe('0.000020000000000000');
    expect(await source.query("SELECT * FROM pricing_budget_effects WHERE kind='commit'")).toHaveLength(1);
    expect(await harness!.callLogRepo.count()).toBe(logs); expect(await harness!.routeDecisionRepo.count()).toBe(traces);
    if (logs) expect((await harness!.callLogRepo.find())[0].cost_usd).toBeCloseTo(.00002, 9);
    expect(harness!.fetchMock.calls.filter(row => row.method === 'POST' && row.url.includes('/chat/completions'))).toHaveLength(1);
  }
  it('uses the joined ledger path for an actual authenticated HTTP model request', async () => {
    const joined = jest.spyOn(harness!.app.get(CostLedgerService), 'persistAndApplyRuntimeSettlementWithLogs');
    await call(); expect(joined).toHaveBeenCalledTimes(1); await settled(1, 1);
  });
  it('keeps its call log and money when actual route trace preparation fails', async () => {
    const pipeline = harness!.app.get(PipelineService) as unknown as { createRouteDecisionTraceLog(input: unknown): unknown };
    jest.spyOn(pipeline, 'createRouteDecisionTraceLog').mockImplementation(() => { throw Error('synthetic trace preparation failure'); });
    const joined = jest.spyOn(harness!.app.get(CostLedgerService), 'persistAndApplyRuntimeSettlementWithLogs');
    await call(); expect(joined).toHaveBeenCalledTimes(1); await settled(1, 0);
  });
  it.each(['call_logs', 'route_decisions'] as const)('keeps money and the other log when PostgreSQL rejects optional %s insertion', async table => {
    const source = harness!.app.get(DataSource);
    await source.query("CREATE FUNCTION joined_http_log_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic optional HTTP log failure'; END; $$");
    await source.query('CREATE TRIGGER joined_http_log_failure BEFORE INSERT ON ' + table + ' FOR EACH ROW EXECUTE FUNCTION joined_http_log_failure()');
    await call(); await settled(table === 'call_logs' ? 0 : 1, table === 'route_decisions' ? 0 : 1);
  });
  it('makes an actual fee above its small reservation visible before the next HTTP admission', async () => {
    const source = harness!.app.get(DataSource);
    if (source.options.type !== 'postgres') throw Error('Expected isolated PostgreSQL fixture');
    await source.query("UPDATE budget_rules SET limit_value=0.0015 WHERE type='daily_cost' AND is_active=true");
    harness!.fetchMock.setHandler(async () => Response.json({
      id: 'synthetic-over-reservation', model: 'gpt-4o',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Synthetic response' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1000, completion_tokens: 500, prompt_tokens_details: { cached_tokens: 0 }, cache_creation_input_tokens: 0 },
    }));
    const observer = await new DataSource({ type: 'postgres', url: source.options.url, synchronize: false, extra: { max: 1 } }).initialize();
    try {
      await call();
      expect((await observer.query("SELECT state,committed_cost_usd FROM pricing_reservations"))).toEqual([
        { state: 'committed', committed_cost_usd: '0.002000000000000000' },
      ]);
      const costs = await observer.query("SELECT b.amount_decimal FROM pricing_budget_balances b JOIN budget_rules r ON r.id=b.rule_id WHERE r.type='daily_cost'");
      expect(costs).toEqual([{ amount_decimal: '0.002000000000000000' }]);
      const second = await harness!.agent.post('/v1/chat/completions').set('Authorization', 'Bearer ' + API_KEY)
        .send({ model: 'gpt-4o', max_tokens: 32, messages: [{ role: 'user', content: 'Synthetic next request' }] });
      expect(second.status).toBe(429); expect(second.body.error.type).toBe('budget_exceeded');
      expect(harness!.fetchMock.calls.filter(row => row.method === 'POST' && row.url.includes('/chat/completions'))).toHaveLength(1);
      expect(await observer.query("SELECT * FROM pricing_budget_effects WHERE kind='commit'")).toHaveLength(1);
    } finally { await observer.destroy(); }
  });

});

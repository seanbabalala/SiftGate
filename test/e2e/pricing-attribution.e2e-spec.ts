import { PricingRuntimeService } from "../../src/pricing/pricing-runtime.service";
import { createServer } from "node:http";
import { DataSource } from "typeorm";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as yaml from "js-yaml";
import { API_KEY, createE2EHarness, E2EHarness, FIXTURE_PATH } from "./setup";
import { ConfigService } from "../../src/config/config.service";
import { CostLedgerService } from "../../src/pricing/cost-ledger.service";
import { PricingRecoveryService } from "../../src/pricing/pricing-recovery.service";
import { applyPricingSchema } from "../../src/pricing/pricing-schema";
import type { CostLedgerSummary } from "../../src/pricing/cost-ledger.types";
import { tokenBook, book, rate } from "../unit/pricing-fixtures";

describe("physical provider-attempt pricing attribution", () => {
  let harness: E2EHarness, directory: string, source: DataSource;
  const base = "/api/dashboard/pricing";
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "pricing-attribution-"));
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
    Object.assign((config.nodes as Record<string, unknown>[])[0], {
      credentials: [
        { id: "credential-a", api_key: "synthetic-key-a" },
        { id: "credential-b", api_key: "synthetic-key-b" },
      ],
      credential_pool: {
        enabled: true,
        strategy: "round_robin",
        retry_on_status: [429, 503],
      },
      upstream_model_aliases: { "gpt-4o": "synthetic-wire-model" },
    });
    const file = join(directory, "config.yaml");
    writeFileSync(file, yaml.dump(config));
    harness = await createE2EHarness(file);
    source = harness.app.get(DataSource);
    await harness.app.get(PricingRecoveryService).onModuleDestroy();
    await applyPricingSchema(source);
  }, 30000);
  afterEach(async () => {
    jest.restoreAllMocks();
    await harness?.app.get(PricingRuntimeService).waitForRequests();
    await harness?.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const node = () => harness.app.get(ConfigService).getNode("mock-openai")!;
  const call = (stream = false) =>
    harness.agent
      .post("/v1/chat/completions")
      .set("Authorization", `Bearer ${API_KEY}`)
      .send({
        model: "gpt-4o",
        max_tokens: 20,
        stream,
        messages: [{ role: "user", content: "private-prompt-not-for-ledger" }],
      });
  const json = (status = 200, observed = true) =>
    new Response(
      JSON.stringify({
        model: "synthetic-response-model",
        id: "fixture",
        ...(status === 200
          ? {
              choices: [
                {
                  index: 0,
                  message: {
                    role: "assistant",
                    content: "private-output-not-for-ledger",
                  },
                  finish_reason: "stop",
                },
              ],
            }
          : {
              error: {
                message: "synthetic rejected invocation",
                debug: "private-error-not-for-ledger",
              },
            }),
        ...(observed
          ? {
              usage: {
                prompt_tokens: 10,
                completion_tokens: 5,
                prompt_tokens_details: { cached_tokens: 0 },
                cache_creation_input_tokens: 0,
              },
            }
          : {}),
      }),
      { status, headers: { "content-type": "application/json" } },
    );
  async function publish(content = tokenBook(), model = "gpt-4o") {
    const created = await harness.agent
      .post(`${base}/books`)
      .send({ name: "Attribution synthetic fixture", content });
    expect(created.status).toBe(201);
    const head = (await harness.agent.get(`${base}/bindings`)).body.head;
    const result = await harness.agent
      .post(`${base}/drafts/${created.body.draft.id}/publish`)
      .send({
        draft_revision: 1,
        catalog_revision: head.revision,
        reason: "Synthetic attribution test",
        confirm: true,
        targets: [{ level: "model", model }],
      });
    expect(result.status).toBe(201);
    return result.body.version_id as string;
  }
  async function detail(): Promise<CostLedgerSummary> {
    const rows = await source.query(
      "SELECT request_id, workspace_id FROM pricing_request_snapshots",
    );
    expect(rows).toHaveLength(1);
    return (await harness.app
      .get(CostLedgerService)
      .summary(rows[0].request_id, rows[0].workspace_id))!;
  }

  it("persists each credential dispatch before fetch, fixes its model/credential evidence, and does not expose private content", async () => {
    const version = await publish();
    let calls = 0;
    const observed: Array<{
      attempts: Array<{ state: string; price_context_json: string }>;
      auth?: string;
    }> = [];
    harness.fetchMock.setHandler(async (_url, options) => {
      const attempts = await source.query("SELECT * FROM pricing_attempts");
      observed.push({
        attempts,
        auth: (options.headers as Record<string, string>).Authorization,
      });
      return json(++calls === 1 ? 429 : 200, calls !== 1);
    });
    const response = await call();
    expect({ status: response.status, body: response.body }).toMatchObject({
      status: 200,
    });
    observed.forEach((entry, index) => {
      expect(entry.attempts).toHaveLength(index + 1);
      const current = entry.attempts.find((row) => row.state === "dispatched");
      expect(current).toBeDefined();
      const dispatch = JSON.parse(current!.price_context_json).dispatch;
      expect(dispatch).toMatchObject({
        requested_model: "gpt-4o",
        route_model: "gpt-4o",
        wire_model: "synthetic-wire-model",
        dispatch_index: index,
      });
      expect(dispatch.credential_id).toBe(
        index === 0 ? "credential-a" : "credential-b",
      );
      expect(entry.auth).toBe(
        `Bearer synthetic-key-${index === 0 ? "a" : "b"}`,
      );
    });
    expect(response.body).not.toHaveProperty("attribution");
    expect(response.body.usage).not.toHaveProperty("resolvedModel");
    const summary = await detail();
    expect(summary).toMatchObject({
      provider_attempts: 2,
      unknown_attempts: 1,
      amount: null,
      known_subtotal: "0.000020000000000000",
    });
    const ordered = [...summary.attempts].sort(
      (a, b) => a.dispatch!.dispatch_index - b.dispatch!.dispatch_index,
    );
    expect(ordered[0].dispatch!.invocation_id).toBe(
      ordered[1].dispatch!.invocation_id,
    );
    expect(ordered[1].cost?.attribution).toMatchObject({
      credential_id: "credential-b",
      response_model: "synthetic-response-model",
    });
    for (const attempt of ordered)
      expect(attempt.cost?.version_id).toBe(version);
    const persisted = JSON.stringify(
      await source.query("SELECT * FROM pricing_attempts"),
    );
    for (const text of [
      "synthetic-key-a",
      "synthetic-key-b",
      "private-prompt-not-for-ledger",
      "private-output-not-for-ledger",
      "private-error-not-for-ledger",
      "Authorization",
    ])
      expect(persisted).not.toContain(text);
  });

  it("sums observed fees from a failed credential and final success, retaining compatibility logical budget separately", async () => {
    await publish();
    let count = 0;
    harness.fetchMock.setHandler(async () => json(++count === 1 ? 429 : 200));
    expect((await call()).status).toBe(200);
    const summary = await detail();
    expect(summary).toMatchObject({
      provider_attempts: 2,
      unknown_attempts: 0,
      amount: "0.000040000000000000",
      budget_committed_usd: "0.000020000000000000",
    });
    expect(
      summary.attempts.some(
        (entry) =>
          entry.error_code === "rate_limited" &&
          entry.cost?.report_amount === "0.000020000",
      ),
    ).toBe(true);
  });

  it("CALC-18 preserves the first unknown attempt while summing the two later observed attempts", async () => {
    node().credentials!.push({
      id: "credential-c",
      api_key: "synthetic-key-c",
    });
    await publish();
    let count = 0;
    harness.fetchMock.setHandler(async () =>
      json(++count < 3 ? 429 : 200, count !== 1),
    );
    expect((await call()).status).toBe(200);
    expect(await detail()).toMatchObject({
      provider_attempts: 3,
      pending_attempts: 0,
      unknown_attempts: 1,
      amount: null,
      known_subtotal: "0.000040000000000000",
    });
  });

  async function disconnectStream(observed: boolean) {
    await publish();
    let upstreamCancelled = false;
    let upstreamController:
      | ReadableStreamDefaultController<Uint8Array>
      | undefined;
    harness.fetchMock.setHandler(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              upstreamController = controller;
              controller.enqueue(
                new TextEncoder().encode(
                  `data: ${JSON.stringify({
                    id: "cancelled", model: "cancelled-reported",
                    choices: [{ index: 0, delta: { content: "synthetic partial" }, finish_reason: null }],
                    ...(observed ? { usage: { prompt_tokens: 10, completion_tokens: 5 } } : {}),
                  })}\n\n`,
                ),
              );
            },
            cancel() {
              upstreamCancelled = true;
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    const address = harness.app.getHttpServer().address();
    if (!address || typeof address === "string" || address.port === 2099)
      throw new Error("Invalid isolated gateway");
    const nativeFetch = (await import("undici")).fetch;
    const abort = new AbortController();
    try {
      const response = await nativeFetch(
        `http://127.0.0.1:${address.port}/v1/chat/completions`,
        {
          method: "POST",
          signal: abort.signal,
          headers: {
            Authorization: `Bearer ${API_KEY}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: "gpt-4o",
            stream: true,
            messages: [{ role: "user", content: "cancel synthetic stream" }],
          }),
        },
      );
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      expect((await reader.read()).done).toBe(false);
      await reader.cancel();
      abort.abort();
      let final = await detail();
      for (
        let left = 100;
        left > 0 &&
        (final.pending_attempts ||
          final.reservations.some((entry) => entry.state === "reserved"));
        left--
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        final = await detail();
      }
      expect(upstreamCancelled).toBe(true);
      expect(final).toMatchObject({
        provider_attempts: 1,
        pending_attempts: 0,
        amount: observed ? "0.000020000000000000" : null,
        unknown_attempts: observed ? 0 : 1,
      });
      expect(final.attempts[0].error_code).toBe("client_aborted");
      expect(final.attempts[0].cost?.attribution?.response_model).toBe(
        "cancelled-reported",
      );
      expect(
        final.reservations.every((entry) => entry.state !== "reserved"),
      ).toBe(true);
      expect(harness.fetchMock.calls).toHaveLength(1);
    } finally {
      abort.abort();
      if (!upstreamCancelled) {
        try {
          upstreamController?.close();
        } catch {
          /* Already closed. */
        }
      }
    }
  }

  it("retains reported stream usage when the real client disconnects before any stop event", () => disconnectStream(true));

  it("keeps missing usage unknown when the real client disconnects before any stop event", () => disconnectStream(false));

  it("counts all credential and outer retries rather than collapsing the two retry layers", async () => {
    await publish();
    let count = 0;
    harness.fetchMock.setHandler(async () =>
      json(++count < 4 ? 503 : 200, count === 4),
    );
    expect((await call()).status).toBe(200);
    const summary = await detail();
    expect(summary).toMatchObject({
      provider_attempts: 4,
      unknown_attempts: 3,
      pending_attempts: 0,
    });
    expect(
      new Set(summary.attempts.map((entry) => entry.dispatch!.invocation_id))
        .size,
    ).toBe(2);
    expect(
      summary.attempts.filter((entry) => entry.dispatch!.dispatch_index === 1),
    ).toHaveLength(2);
    expect(harness.fetchMock.calls).toHaveLength(4);
  });

  it("freezes the catalog for credential retries even when a new price is published between them", async () => {
    const version = await publish();
    let count = 0;
    harness.fetchMock.setHandler(async () => {
      if (++count === 1) {
        const changed = tokenBook();
        changed.groups[0].rules[0].rates[0].component.amount = "99";
        await publish(changed);
        return json(429);
      }
      return json();
    });
    expect((await call()).status).toBe(200);
    const summary = await detail();
    expect(summary.amount).toBe("0.000040000000000000");
    expect(summary.attempts.map((entry) => entry.cost?.version_id)).toEqual([
      version,
      version,
    ]);
  });

  it("recovers every known retry receipt from one terminal intent after individual writes fail", async () => {
    await publish();
    const ledger = harness.app.get(CostLedgerService);
    jest
      .spyOn(ledger, "completeAttempt")
      .mockRejectedValue(new Error("synthetic receipt storage interruption"));
    let count = 0;
    harness.fetchMock.setHandler(async () => json(++count === 1 ? 429 : 200));
    expect((await call()).status).toBe(200);
    const summary = await detail();
    expect(summary).toMatchObject({
      provider_attempts: 2,
      pending_attempts: 0,
      amount: "0.000040000000000000",
    });
    const intent = JSON.parse(
      (
        await source.query(
          "SELECT payload_json FROM pricing_settlement_intents",
        )
      )[0].payload_json,
    );
    expect(intent.receipts).toHaveLength(1);
    expect(intent.receipt).not.toBeNull();
    expect(harness.fetchMock.calls).toHaveLength(2);
  });

  it("retains billed failure receipts when all attempts fail and the logical budget is released", async () => {
    await publish();
    jest
      .spyOn(harness.app.get(CostLedgerService), "completeAttempt")
      .mockRejectedValue(new Error("synthetic write failure"));
    harness.fetchMock.setHandler(async () => json(503));
    expect((await call()).status).toBe(503);
    const summary = await detail();
    expect(summary).toMatchObject({
      provider_attempts: 4,
      pending_attempts: 0,
      amount: "0.000080000000000000",
      budget_committed_usd: "0.000000000000000000",
    });
    expect(summary.reservations[0].state).toBe("released");
    expect(
      JSON.parse(
        (
          await source.query(
            "SELECT payload_json FROM pricing_settlement_intents",
          )
        )[0].payload_json,
      ).receipts,
    ).toHaveLength(4);
  });

  it("does not make a provider call if the durable dispatch record cannot be created", async () => {
    await publish();
    jest
      .spyOn(harness.app.get(CostLedgerService), "beginAttempt")
      .mockRejectedValue(new Error("synthetic dispatch storage failure"));
    expect((await call()).status).toBe(502);
    expect(harness.fetchMock.calls).toHaveLength(0);
    expect(await source.query("SELECT * FROM pricing_attempts")).toHaveLength(
      0,
    );
  });

  it("records credential failures before a stream and settles only one final cumulative stream receipt", async () => {
    await publish();
    let count = 0;
    harness.fetchMock.setHandler(async () => {
      if (++count === 1) return json(429, false);
      return new Response(
        [
          'data: {"id":"stream","model":"reported-stream-model","choices":[{"delta":{"content":"private-stream-text"},"index":0,"finish_reason":null}]}\n\n',
          'data: {"model":"reported-stream-model","choices":[{"delta":{},"index":0,"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n',
          "data: [DONE]\n\n",
        ].join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    const response = await call(true);
    expect(response.status).toBe(200);
    expect(response.text).not.toContain("attribution");
    // HTTP completion guarantees retained evidence; delivery is request-drained.
    await harness.app.get(PricingRuntimeService).waitForRequests();
    const summary = await detail();
    expect(summary).toMatchObject({
      provider_attempts: 2,
      pending_attempts: 0,
      unknown_attempts: 1,
      known_subtotal: "0.000020000000000000",
    });
    expect(
      summary.attempts.find((entry) => entry.error_code === null)?.cost
        ?.attribution?.response_model,
    ).toBe("reported-stream-model");
    expect(JSON.stringify(summary)).not.toContain("private-stream-text");
  });

  it.each(
    ["/v1/responses", "/v1/chat/completions", "/v1/messages"].flatMap((path) =>
      ["observed", "missing", "malformed"].map((kind) => ({ path, kind })),
    ),
  )("retains failed Responses stream expense through $path with $kind usage", async ({ path, kind }) => {
    node().protocol = "responses";
    node().endpoint = "/v1/responses";
    node().credentials = [{ id: "one", api_key: "synthetic-one" }];
    const version = await publish();
    const usage = kind === "missing" ? undefined : {
      input_tokens: 100,
      output_tokens: kind === "malformed" ? "invalid" : 20,
      input_tokens_details: { cached_tokens: 30, cache_write_tokens: 0 },
    };
    const frame = (event: string, data: unknown) =>
      `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    const failed = frame("response.failed", {
      response: {
        id: "synthetic-failed-stream",
        status: "failed",
        model: "reported-failed-model",
        service_tier: "default",
        error: { code: "server_error", message: "Synthetic failed generation" },
        usage,
      },
    });
    const raw = frame("response.created", {
      response: { id: "synthetic-failed-stream", model: "reported-failed-model" },
    }) + frame("response.output_text.delta", { delta: "private-partial-output" }) +
      failed + failed + "data: [DONE]\n\n";
    harness.fetchMock.setHandler(async () => new Response(raw, {
      headers: { "content-type": "text/event-stream" },
    }));
    const response = await harness.agent.post(path)
      .set("Authorization", `Bearer ${API_KEY}`)
      .send({
        model: "gpt-4o", max_tokens: 20, stream: true,
        ...(path === "/v1/responses"
          ? { input: "private-failed-stream-prompt" }
          : { messages: [{ role: "user", content: "private-failed-stream-prompt" }] }),
      });
    expect(response.status).toBe(200);
    if (path === "/v1/responses") expect(response.text).toBe(raw);
    else expect(response.text).toContain("Synthetic failed generation");
    expect(response.text).not.toContain("adapter_id");
    await harness.app.get(PricingRuntimeService).waitForRequests();
    const summary = await detail();
    expect(summary).toMatchObject({
      provider_attempts: 1,
      pending_attempts: 0,
      unknown_attempts: kind === "observed" ? 0 : 1,
      amount: kind === "observed" ? "0.000113000000000000" : null,
    });
    const attempt = summary.attempts[0];
    expect(attempt.error_code).toBe("stream_failure");
    expect(attempt.cost?.version_id).toBe(version);
    expect(attempt.cost?.attribution?.response_model).toBe("reported-failed-model");
    if (kind === "observed") {
      expect(attempt.cost?.usage.quantities.total_input_tokens).toMatchObject({ value: "100", source: "provider_usage", quality: "observed" });
      expect(attempt.cost?.usage.quantities.uncached_input_tokens?.value).toBe("70");
      expect(attempt.cost?.usage.quantities.cache_read_tokens?.value).toBe("30");
      expect(attempt.cost?.usage.quantities.output_tokens?.value).toBe("20");
    } else expect(attempt.cost?.status).not.toBe("free");
    const persisted = JSON.stringify(await source.query("SELECT * FROM pricing_attempts"));
    expect(persisted).not.toContain("private-partial-output");
    expect(persisted).not.toContain("private-failed-stream-prompt");
    expect(harness.fetchMock.calls).toHaveLength(1);
  });

  it.each(
    [
      { protocol: "chat_completions", profile: "openai_compatible", endpoint: "/v1/chat/completions" },
      { protocol: "responses", profile: "openai_responses_compatible", endpoint: "/v1/responses" },
      { protocol: "messages", profile: "anthropic_messages_compatible", endpoint: "/v1/messages" },
      { protocol: "gemini", profile: "google_gemini_compatible", endpoint: "/v1beta/models/:model:generateContent" },
    ].flatMap((provider) =>
      ["/v1/chat/completions", "/v1/responses", "/v1/messages"].flatMap((path) =>
        [false, true].map((stream) => ({ ...provider, path, stream })),
      ),
    ),
  )("METER-03 normalizes $protocol through $path (stream=$stream) to the same exact receipt", async ({ protocol, profile, endpoint, path, stream }) => {
    node().protocol = protocol as ReturnType<typeof node>["protocol"];
    node().compatibility_profile = profile;
    node().endpoint = endpoint;
    node().credentials = [{ id: "one", api_key: "synthetic-one" }];
    const version = await publish();
    const frame = (data: unknown, event?: string) =>
      `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`;
    const text = "private-protocol-parity-output";
    const chat = {
      id: "synthetic-parity", model: "gpt-4o", object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 25, prompt_tokens_details: { cached_tokens: 40, cache_write_tokens: 0 } },
    };
    const responses = {
      id: "synthetic-parity", model: "gpt-4o", status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
      usage: { input_tokens: 100, output_tokens: 25, input_tokens_details: { cached_tokens: 40, cache_write_tokens: 0 } },
    };
    const messages = {
      id: "synthetic-parity", model: "gpt-4o", type: "message", role: "assistant", stop_reason: "end_turn",
      content: [{ type: "text", text }],
      usage: { input_tokens: 60, output_tokens: 25, cache_read_input_tokens: 40, cache_creation_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } },
    };
    const gemini = {
      responseId: "synthetic-parity", modelVersion: "gpt-4o",
      candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 100, cachedContentTokenCount: 40, candidatesTokenCount: 25, thoughtsTokenCount: 0, totalTokenCount: 125 },
    };
    let body: object;
    let raw: string;
    switch (protocol) {
      case "chat_completions":
        body = chat;
        raw = frame({ ...chat, choices: [{ index: 0, delta: { content: text } }], usage: { ...chat.usage, completion_tokens: 2 } }) +
          frame({ ...chat, choices: [] }) + frame({ ...chat, choices: [] }) + "data: [DONE]\n\n";
        break;
      case "responses":
        body = responses;
        raw = frame({ response: { id: responses.id, model: responses.model } }, "response.created") +
          frame({ delta: text }, "response.output_text.delta") +
          frame({ response: responses }, "response.completed") + frame({ response: responses }, "response.completed") + "data: [DONE]\n\n";
        break;
      case "messages":
        body = messages;
        raw = frame({ type: "message_start", message: { ...messages, content: [], usage: { ...messages.usage, output_tokens: 0 } } }, "message_start") +
          frame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }, "content_block_delta") +
          frame({ type: "message_delta", delta: {}, usage: { output_tokens: 2 } }, "message_delta") +
          frame({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 25 } }, "message_delta") +
          frame({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 25 } }, "message_delta") +
          frame({ type: "message_stop" }, "message_stop");
        break;
      default:
        body = gemini;
        raw = frame(gemini) + frame({ usageMetadata: gemini.usageMetadata }) + "data: [DONE]\n\n";
    }
    harness.fetchMock.setHandler(async () => new Response(stream ? raw : JSON.stringify(body), {
      headers: { "content-type": stream ? "text/event-stream" : "application/json" },
    }));
    const response = await harness.agent.post(path)
      .set("Authorization", `Bearer ${API_KEY}`)
      .send({
        model: "gpt-4o", max_tokens: 40, stream,
        ...(path === "/v1/responses" ? { input: "private-protocol-parity-prompt" }
          : { messages: [{ role: "user", content: "private-protocol-parity-prompt" }] }),
      });
    expect(response.status).toBe(200);
    expect(response.text).toContain(text);
    expect(response.text).not.toContain("adapter_id");
    expect(response.text).not.toContain("pricingUsage");
    if (stream && ((protocol === "responses" && path === "/v1/responses") ||
        (protocol === "messages" && path === "/v1/messages"))) expect(response.text).toBe(raw);
    await harness.app.get(PricingRuntimeService).waitForRequests();
    const summary = await detail();
    // Independent arithmetic: 60*1 + 40*0.1 + 25*2 = 114 micro-USD.
    expect(summary).toMatchObject({
      provider_attempts: 1, pending_attempts: 0, unknown_attempts: 0,
      amount: "0.000114000000000000", budget_committed_usd: "0.000114000000000000",
      budget_reserved_usd: "0.000000000000000000",
    });
    const receipt = summary.attempts[0].cost!;
    expect(receipt.version_id).toBe(version);
    expect(receipt.usage.quantities.total_input_tokens).toMatchObject({ value: "100", quality: "observed", source: "provider_usage" });
    expect(receipt.usage.quantities.uncached_input_tokens?.value).toBe("60");
    expect(receipt.usage.quantities.cache_read_tokens?.value).toBe("40");
    expect(receipt.usage.quantities.output_tokens?.value).toBe("25");
    expect(receipt.usage.diagnostics).toEqual([]);
    const stored = JSON.stringify(await source.query("SELECT * FROM pricing_attempts"));
    expect(stored).not.toContain(text);
    expect(stored).not.toContain("private-protocol-parity-prompt");
    expect(harness.fetchMock.calls).toHaveLength(1);
  });

  it("keeps embedding credential retries distinct with observed input usage on a failed response", async () => {
    await publish(
      book([rate("input", "uncached_input_tokens", "1", "1000000")]),
      "text-embedding-3-small",
    );
    let count = 0;
    harness.fetchMock.setHandler(async () =>
      ++count === 1
        ? json(429)
        : new Response(
            JSON.stringify({
              model: "embedding-reported",
              data: [{ index: 0, embedding: [0.1] }],
              usage: { prompt_tokens: 8, total_tokens: 8 },
            }),
            { headers: { "content-type": "application/json" } },
          ),
    );
    const response = await harness.agent
      .post("/v1/embeddings")
      .set("Authorization", `Bearer ${API_KEY}`)
      .send({
        model: "text-embedding-3-small",
        input: "private embedding input",
      });
    expect(response.status).toBe(200);
    expect(await detail()).toMatchObject({
      provider_attempts: 2,
      pending_attempts: 0,
      unknown_attempts: 0,
      amount: "0.000018000000000000",
    });
  });

  it("captures audio credential retries and explicit billed duration on an error without storing media", async () => {
    await publish(
      book([rate("audio", "audio_output_seconds", "1", "1")]),
      "tts-1",
    );
    let count = 0;
    harness.fetchMock.setHandler(
      async () =>
        new Response(
          JSON.stringify({
            usage: { audio_output_seconds: ++count === 1 ? "1.25" : "2.5" },
            text: "private audio payload",
          }),
          {
            status: count === 1 ? 429 : 200,
            headers: { "content-type": "application/json" },
          },
        ),
    );
    const response = await harness.agent
      .post("/v1/audio/speech")
      .set("Authorization", `Bearer ${API_KEY}`)
      .send({ model: "tts-1", input: "private tts input", voice: "synthetic" });
    expect(response.status).toBe(200);
    const summary = await detail();
    expect(summary).toMatchObject({
      provider_attempts: 2,
      unknown_attempts: 0,
      amount: "3.750000000000000000",
    });
    expect(JSON.stringify(summary)).not.toContain("private audio payload");
  });

  it("keeps a real late timeout-race loser billable at its frozen price after the client receives the winner", async () => {
    await publish();
    await publish(tokenBook(), "gpt-4o-mini");
    await publish(tokenBook(), "claude-sonnet-4-20250514");
    const config = harness.app.get(ConfigService);
    config.routing.fallback_policy = {
      timeout: { enabled: true, threshold_ms: 25, race_fallback: true },
    };
    config.routing.scoring = {
      ...config.routing.scoring,
      simple_max: -1,
      standard_max: 999,
      complex_max: 1000,
    };
    let releasePrimary!: () => void;
    const primaryGate = new Promise<void>((resolve) => {
      releasePrimary = resolve;
    });
    const server = createServer((req, res) => {
      req.resume();
      void (async () => {
        const messages = req.url?.includes("/messages");
        if (!messages) await primaryGate;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify(
            messages
              ? {
                  id: "race-fallback",
                  type: "message",
                  role: "assistant",
                  model: "fallback-reported",
                  content: [{ type: "text", text: "synthetic winner" }],
                  stop_reason: "end_turn",
                  usage: {
                    input_tokens: 10,
                    output_tokens: 5,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 0,
                  },
                }
              : {
                  id: "race-primary",
                  model: "primary-reported",
                  choices: [
                    {
                      index: 0,
                      message: {
                        role: "assistant",
                        content: "synthetic late answer",
                      },
                      finish_reason: "stop",
                    },
                  ],
                  usage: { prompt_tokens: 10, completion_tokens: 5 },
                },
          ),
        );
      })().catch(() => res.destroy());
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string" || address.port === 2099)
      throw new Error("Invalid isolated server");
    // This fetch implementation is used only for the explicit owned loopback URL below.
    const nativeFetch = (await import("undici")).fetch;
    harness.fetchMock.setHandler(
      async (url, init) =>
        nativeFetch(
          `http://127.0.0.1:${address.port}${new URL(url).pathname}`,
          {
            method: "POST",
            headers: init.headers as Record<string, string>,
            body: init.body as string,
            signal: init.signal,
          },
        ) as unknown as Promise<Response>,
    );
    try {
      const response = await harness.agent
        .post("/v1/chat/completions")
        .set("Authorization", `Bearer ${API_KEY}`)
        .send({
          model: "auto",
          max_tokens: 20,
          messages: [{ role: "user", content: "hello" }],
        });
      expect(response.status).toBe(200);
      expect(response.body.choices[0].message.content).toBe("synthetic winner");
      expect(await detail()).toMatchObject({
        provider_attempts: 2,
        pending_attempts: 1,
        amount: null,
        known_subtotal: "0.000020000000000000",
      });
      const changed = tokenBook();
      changed.groups[0].rules[0].rates[0].component.amount = "99";
      await publish(changed);
      await publish(changed, "gpt-4o-mini");
      expect(
        await harness.app
          .get(PricingRuntimeService)
          .renewActiveLeases(new Date(Date.now() + 60000)),
      ).toBe(1);
      releasePrimary();
      let final = await detail();
      for (
        let remaining = 100;
        remaining > 0 &&
        (final.pending_attempts ||
          final.reservations.some((entry) => entry.state === "reserved"));
        remaining--
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        final = await detail();
      }
      expect(final).toMatchObject({
        provider_attempts: 2,
        pending_attempts: 0,
        amount: "0.000040000000000000",
        budget_committed_usd: "0.000020000000000000",
      });
      expect(
        await harness.app.get(PricingRuntimeService).renewActiveLeases(),
      ).toBe(0);
      expect(final.reservations.map((entry) => entry.state).sort()).toEqual([
        "committed",
        "released",
      ]);
      expect(harness.fetchMock.calls).toHaveLength(2);
      expect(
        final.attempts
          .map((entry) => entry.cost?.attribution?.response_model)
          .sort(),
      ).toEqual(["fallback-reported", "primary-reported"]);
    } finally {
      releasePrimary();
      for (
        let left = 100;
        left > 0 && (await detail()).pending_attempts;
        left--
      )
        await new Promise((resolve) => setTimeout(resolve, 10));
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 15000);

  async function responsesRetry(strict: boolean) {
    node().protocol = "responses";
    node().endpoint = "/v1/responses";
    node().credentials = [{ id: "one", api_key: "synthetic-one" }];
    await publish();
    if (strict) {
      const head = (await harness.agent.get(`${base}/bindings`)).body.head;
      expect(
        (
          await harness.agent.put(`${base}/admission-policy`).send({
            catalog_revision: head.revision,
            scope: "workspace",
            reason: "Synthetic retry cap",
            confirm: true,
            policy: {
              mode: "reserve_upper_bound",
              quantity_limits: {
                total_input_tokens: "100",
                output_tokens: "100",
              },
              limit_reference: "Synthetic test limit",
            },
          })
        ).status,
      ).toBe(200);
    }
    let count = 0;
    harness.fetchMock.setHandler(async () =>
      ++count === 1
        ? new Response(
            JSON.stringify({
              error: {
                message:
                  "Invalid Value: 'tools'. Function 'collaboration.spawn_agent' is reserved for use by this model and must match the configured schema.",
              },
            }),
            { status: 400 },
          )
        : new Response(
            JSON.stringify({
              id: "response",
              model: "reported",
              status: "completed",
              output: [],
              usage: { input_tokens: 10, output_tokens: 5 },
            }),
            { headers: { "content-type": "application/json" } },
          ),
    );
    return harness.agent
      .post("/v1/responses")
      .set("Authorization", `Bearer ${API_KEY}`)
      .send({
        model: "gpt-4o",
        input: "synthetic",
        tools: [
          {
            type: "function",
            name: "collaboration.spawn_agent",
            parameters: { type: "object", properties: {} },
          },
        ],
      });
  }
  it("records the special compatibility replay as another physical attempt, never as a free hidden retry", async () => {
    expect((await responsesRetry(false)).status).toBe(200);
    const summary = await detail();
    expect(summary).toMatchObject({
      provider_attempts: 2,
      unknown_attempts: 1,
    });
    expect(
      summary.attempts.some(
        (entry) =>
          entry.dispatch?.compatibility_retry_index === 1 &&
          entry.dispatch.dispatch_index === 1,
      ),
    ).toBe(true);
  });
  it("does not reset a strict dispatch allowance on the special compatibility replay", async () => {
    expect((await responsesRetry(true)).status).toBe(400);
    expect(harness.fetchMock.calls).toHaveLength(1);
    expect((await detail()).provider_attempts).toBe(1);
  });
});

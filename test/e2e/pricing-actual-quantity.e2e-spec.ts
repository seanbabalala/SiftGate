import { DataSource } from "typeorm";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { request as httpRequest } from "node:http";
import * as yaml from "js-yaml";
import { API_KEY, API_KEY_2, createE2EHarness, type E2EHarness, FIXTURE_PATH } from "./setup";
import { CostLedgerService } from "../../src/pricing/cost-ledger.service";
import { PricingRuntimeService } from "../../src/pricing/pricing-runtime.service";
import { PricingRecoveryService } from "../../src/pricing/pricing-recovery.service";
import { ConfigService } from "../../src/config/config.service";
import { BudgetService } from "../../src/budget/budget.service";
import { applyPricingSchema } from "../../src/pricing/pricing-schema";
import { book, rate } from "../unit/pricing-fixtures";
import { wave } from "../unit/media-metering-fixtures";
import type { PriceBookContent } from "../../src/pricing/pricing.types";
import type { PricingAdmissionPolicy } from "../../src/pricing/pricing-admission.types";

const operations = ["audio_transcription", "audio_translation", "audio_speech", "rerank"] as const;
type Operation = typeof operations[number];
const model = (operation: Operation) => operation === "rerank" ? "rerank-english-v3" : operation === "audio_speech" ? "tts-1" : "gpt-4o-mini-transcribe";
const route = (operation: Operation) => `/v1/${operation === "rerank" ? "rerank" : operation === "audio_speech" ? "audio/speech" : operation === "audio_translation" ? "audio/translations" : "audio/transcriptions"}`;

describe("actual-upstream quantity operations", () => {
  let h: E2EHarness, source: DataSource, directory: string;
  const base = "/api/dashboard/pricing";
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "actual-quantity-http-"));
    const config = yaml.load(readFileSync(FIXTURE_PATH, "utf8")) as Record<string, unknown>;
    config.cache = { enabled: false }; config.budget = { daily_token_limit: 10000000, daily_cost_limit: 1000, alert_threshold: 0.8 };
    (config.routing as Record<string, unknown>).retry = { max_retries: 1, backoff_base_ms: 1, backoff_max_ms: 1, retryable_status: [500, 502, 503, 504] };
    const file = join(directory, "config.yaml"); writeFileSync(file, yaml.dump(config));
    h = await createE2EHarness(file); source = h.app.get(DataSource);
    await h.app.get(PricingRecoveryService).onModuleDestroy(); await applyPricingSchema(source);
  }, 30000);
  afterEach(async () => { jest.restoreAllMocks(); await h?.close(); if (directory) rmSync(directory, { recursive: true, force: true }); });
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const body = (operation: Operation) => ({ model: model(operation), ...(operation === "rerank" ? { query: "PRIVATE-QUERY", documents: ["PRIVATE-DOC-A", "PRIVATE-DOC-B", "PRIVATE-DOC-C"], top_n: 1 } : operation === "audio_speech" ? { input: "A😀中", response_format: "wav" } : {}) });
  const call = (operation: Operation, key = API_KEY) => h.agent.post(route(operation)).set("Authorization", `Bearer ${key}`).send(body(operation));
  async function publish(operation: Operation, content: PriceBookContent) {
    const created = await h.agent.post(`${base}/books`).send({ name: "Synthetic actual quantity", content }); expect(created.status).toBe(201);
    const head = (await h.agent.get(`${base}/bindings`)).body.head;
    const result = await h.agent.post(`${base}/drafts/${created.body.draft.id}/publish`).send({ draft_revision: 1, catalog_revision: head.revision, reason: "Synthetic quantity tariff", confirm: true, targets: [{ level: "model", model: model(operation), operation }] });
    expect({ status: result.status, error: result.body.error }).toEqual({ status: 201, error: undefined });
  }
  async function policy(operation: Operation, token_budget?: "not_applicable" | "reported_tokens", limits: Partial<PricingAdmissionPolicy> = {}) {
    const head = (await h.agent.get(`${base}/bindings`)).body.head;
    return h.agent.put(`${base}/admission-policy`).send({ catalog_revision: head.revision, reason: "Synthetic actual quantity policy", confirm: true, scope: "workspace", operation,
      policy: { mode: "compatibility", budget_basis: "actual_upstream", ...(token_budget ? { token_budget } : {}), ...limits } });
  }
  async function summary() {
    await h.app.get(PricingRuntimeService).waitForRequests();
    const requests = await source.query("SELECT request_id,workspace_id FROM pricing_request_snapshots ORDER BY created_at DESC");
    return (await h.app.get(CostLedgerService).summary(requests[0].request_id, requests[0].workspace_id))!;
  }
  const price = (operation: Operation) => book([rate("units", operation === "rerank" ? "rerank_document_count" : operation === "audio_speech" ? "audio_output_seconds" : "audio_input_seconds", "0.01", "1")]);
  const response = (operation: Operation) => operation === "rerank" ? json({ results: [{ index: 0, relevance_score: 0.9 }], usage: { document_count: 3 } }) : operation === "audio_speech" ? new Response(Uint8Array.from(wave(6.4)), { headers: { "content-type": "audio/wav" } }) : json({ text: "PRIVATE-TRANSCRIPT", usage: { type: "duration", seconds: 61 } });

  it.each(operations)("connects explicit actual policy for %s without changing default token rules", async operation => {
    await publish(operation, price(operation)); expect((await policy(operation, "not_applicable")).status).toBe(200);
    const tokens = await source.query("SELECT * FROM budget_rules WHERE type = 'daily_tokens' ORDER BY id"); expect(tokens.length).toBeGreaterThan(0);
    h.fetchMock.setHandler(async () => response(operation)); expect((await call(operation)).status).toBe(200);
    const result = await summary(), amount = operation === "rerank" ? "0.030000000000000000" : operation === "audio_speech" ? "0.064000000000000000" : "0.610000000000000000";
    expect(result.budget_committed_usd).toBe(amount); expect(result.reservations[0]).toMatchObject({ state: "committed", budget_basis: "actual_upstream" });
    expect(await source.query("SELECT * FROM budget_rules WHERE type = 'daily_tokens' ORDER BY id")).toEqual(tokens);
    expect(await source.query("SELECT * FROM pricing_media_tasks")).toHaveLength(0);
    expect(await source.query("SELECT * FROM pricing_actual_budget_cohorts")).toHaveLength(1);
    expect(h.fetchMock.calls).toHaveLength(1);
    expect(JSON.stringify(await source.query("SELECT cost_json,price_context_json FROM pricing_attempts"))).not.toMatch(/PRIVATE|relevance_score/);
  });

  it.each(operations)("keeps original token holds pending for %s when token counters are absent", async operation => {
    await publish(operation, price(operation)); expect((await policy(operation)).status).toBe(200);
    h.fetchMock.setHandler(async () => response(operation)); expect((await call(operation)).status).toBe(200);
    expect((await summary()).reservations[0].state).toBe("reserved");
    expect(await source.query("SELECT * FROM pricing_budget_effects WHERE kind = 'commit'")).toHaveLength(0);
  });

  it.each(["audio_transcription", "audio_translation"] as const)("meters uploaded PCM %s duration without retaining transcript or bytes", async operation => {
    await publish(operation, book([rate("seconds", "audio_input_seconds", "0.06", "60")])); await policy(operation, "not_applicable");
    h.fetchMock.setHandler(async () => json({ text: "PRIVATE-TRANSCRIPT" }));
    const result = await h.agent.post(route(operation)).set("Authorization", `Bearer ${API_KEY}`).field("model", model(operation)).attach("file", wave(61), "private-audio.wav");
    expect(result.status).toBe(200);
    const cost = await summary(); expect(cost.budget_committed_usd).toBe("0.061000000000000000");
    expect(cost.attempts[0].cost?.usage.quantities.audio_input_seconds).toMatchObject({ value: "61", source: "local_measurement", quality: "observed" });
    expect(JSON.stringify(await source.query("SELECT cost_json,price_context_json FROM pricing_attempts"))).not.toMatch(/PRIVATE-TRANSCRIPT|private-audio|RIFF/);
  });

  it("bills speech Unicode code points rather than bytes when the explicit price is per character", async () => {
    await publish("audio_speech", book([rate("characters", "text_characters", "0.01", "1")])); await policy("audio_speech", "not_applicable");
    h.fetchMock.setHandler(async () => new Response(Buffer.from("PRIVATE-OPAQUE-AUDIO"), { headers: { "content-type": "audio/mpeg" } }));
    expect((await call("audio_speech")).status).toBe(200);
    const result = await summary(); expect(result.budget_committed_usd).toBe("0.030000000000000000");
    expect(result.attempts[0].cost?.usage.quantities.text_characters).toMatchObject({ value: "3", source: "request_metadata", quality: "observed" });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE-OPAQUE|A😀中/);
  });

  it("does not use latency or requested seconds as actual duration for opaque speech", async () => {
    await publish("audio_speech", price("audio_speech")); await policy("audio_speech", "not_applicable");
    h.fetchMock.setHandler(async () => new Response(Buffer.from("PRIVATE-OPAQUE-AUDIO"), { headers: { "content-type": "audio/mpeg" } }));
    const reply = await h.agent.post(route("audio_speech")).set("Authorization", `Bearer ${API_KEY}`).send({ ...body("audio_speech"), seconds: 61 });
    expect(reply.status).toBe(200); const result = await summary(); expect(result.reservations[0].state).toBe("reserved");
    expect(result.attempts[0].cost?.usage.quantities.audio_output_seconds?.value).toBeNull();
  });

  it.each([
    ["rerank_request_count", "0.100000000000000000"], ["requested_rerank_document_count", "0.300000000000000000"],
    ["rerank_document_count", "0.300000000000000000"], ["rerank_search_units", "0.200000000000000000"],
  ] as const)("uses explicit rerank dimension %s without confusing result count with processed work", async (dimension, expected) => {
    await publish("rerank", book([rate("work", dimension, "0.1", "1")])); await policy("rerank", "not_applicable");
    h.fetchMock.setHandler(async () => json({ results: [{ index: 1, relevance_score: 0.9 }], meta: { document_count: 3, billed_units: { search_units: 2 } } }));
    expect((await call("rerank")).status).toBe(200); expect((await summary()).budget_committed_usd).toBe(expected);
  });

  it("does not infer processed rerank documents from top_n or requested input length", async () => {
    await publish("rerank", price("rerank")); await policy("rerank", "not_applicable");
    h.fetchMock.setHandler(async () => json({ results: [{ index: 1, relevance_score: 0.9 }] }));
    expect((await call("rerank")).status).toBe(200); const result = await summary();
    expect(result.reservations[0].state).toBe("reserved"); expect(result.attempts[0].cost?.usage.quantities.rerank_document_count?.value).toBeNull();
  });

  it.each(operations)("retains actual policy for an unbound %s target instead of silently taking a legacy bypass", async operation => {
    expect((await policy(operation)).status).toBe(200);
    h.fetchMock.setHandler(async () => response(operation)); expect((await call(operation)).status).toBe(200);
    expect((await summary()).reservations[0]).toMatchObject({ budget_basis: "actual_upstream", state: "reserved" });
  });

  it.each(operations)("rejects %s non-token exemption when its frozen binding is missing or mixed", async operation => {
    expect((await policy(operation, "not_applicable")).status).toBe(200);
    expect((await call(operation)).status).toBe(422); expect(h.fetchMock.calls).toHaveLength(0);
    await publish(operation, { ...book([rate("tokens", "output_tokens", "0", "1"), rate("count", "request_count", "0.01", "1")]), allow_combined_media: true });
    expect((await call(operation)).status).toBe(422); expect(h.fetchMock.calls).toHaveLength(0);
    expect(await source.query("SELECT * FROM pricing_reservations")).toHaveLength(0);
  });

  it.each(operations)("charges explicit token evidence for %s under the reported-token policy", async operation => {
    await publish(operation, book([rate("input", "uncached_input_tokens", "0.01", "1"), rate("output", "output_tokens", "0.02", "1")])); await policy(operation, "reported_tokens");
    const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    h.fetchMock.setHandler(async () => json(operation === "rerank" ? { results: [{ index: 1, relevance_score: 0.9 }], usage } : { text: "PRIVATE-TOKEN-TRANSCRIPT", usage }));
    expect((await call(operation)).status).toBe(200); const result = await summary();
    expect(result.budget_committed_usd).toBe("0.200000000000000000"); expect(result.reservations[0].committed_tokens).toBe("15");
  });

  it("settles an explicit token-plus-duration contract without double-counting token parents", async () => {
    await publish("audio_transcription", { ...book([
      rate("input", "uncached_input_tokens", "0.01", "1"),
      rate("output", "output_tokens", "0.02", "1"),
      rate("seconds", "audio_input_seconds", "0.01", "1"),
    ]), allow_combined_media: true });
    expect((await policy("audio_transcription", "reported_tokens")).status).toBe(200);
    h.fetchMock.setHandler(async () => json({ text: "PRIVATE-COMBINED", usage: {
      input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, seconds: 61,
    } }));
    expect((await call("audio_transcription")).status).toBe(200);
    const result = await summary(); expect(result.budget_committed_usd).toBe("0.810000000000000000");
    expect(result.reservations[0].committed_tokens).toBe("15");
    expect(result.attempts[0].cost?.lines).toHaveLength(3);
  });

  it.each(operations)("still rejects %s before dispatch when its monetary reservation exceeds the budget", async operation => {
    await publish(operation, book([rate("request", "request_count", "0.1", "1")]));
    expect((await policy(operation, "not_applicable", { mode: "reserve_upper_bound" })).status).toBe(200);
    await source.query("UPDATE budget_rules SET limit_value = 0.05 WHERE type = 'daily_cost'");
    const tokenRules = await source.query("SELECT * FROM budget_rules WHERE type = 'daily_tokens' ORDER BY id");
    expect((await call(operation)).status).toBe(429);
    expect(h.fetchMock.calls).toHaveLength(0);
    expect(await source.query("SELECT * FROM pricing_reservations")).toHaveLength(0);
    expect(await source.query("SELECT * FROM budget_rules WHERE type = 'daily_tokens' ORDER BY id")).toEqual(tokenRules);
  });

  it.each(operations)("does not let an exhausted unrelated token quota block explicit non-token %s pricing", async operation => {
    await publish(operation, price(operation)); expect((await policy(operation, "not_applicable")).status).toBe(200);
    await source.query("UPDATE budget_rules SET current_value = limit_value WHERE type = 'daily_tokens'");
    const tokens = await source.query("SELECT * FROM budget_rules WHERE type = 'daily_tokens' ORDER BY id");
    h.fetchMock.setHandler(async () => response(operation)); expect((await call(operation)).status).toBe(200);
    expect((await summary()).reservations[0].state).toBe("committed");
    expect(await source.query("SELECT * FROM budget_rules WHERE type = 'daily_tokens' ORDER BY id")).toEqual(tokens);
    // An explicit switch back must restore token checks for new requests.
    expect((await policy(operation, "reported_tokens")).status).toBe(200);
    expect((await call(operation)).status).toBe(429); expect(h.fetchMock.calls).toHaveLength(1);
  });

  it.each(["audio_transcription", "rerank"] as const)("reserves every credential and outer %s attempt but commits only actual paid work", async operation => {
    const node = h.app.get(ConfigService).getNode("mock-openai")!;
    Object.assign(node, { credentials: [{ id: "quantity-a", api_key: "synthetic-a" }, { id: "quantity-b", api_key: "synthetic-b" }],
      credential_pool: { enabled: true, strategy: "round_robin", retry_on_status: [503] } });
    await publish(operation, price(operation));
    const limits = operation === "rerank" ? { rerank_document_count: "100" } : { audio_input_seconds: "100" };
    expect((await policy(operation, "not_applicable", { mode: "reserve_upper_bound", quantity_limits: limits,
      limit_reference: "Synthetic supplier per-attempt cap" })).status).toBe(200);
    let count = 0, held: string | undefined;
    h.fetchMock.setHandler(async () => {
      held = (await source.query("SELECT reserved_cost_usd FROM pricing_reservations"))[0].reserved_cost_usd;
      return ++count < 3 ? json({ error: { message: "Synthetic paid credential failure" },
        usage: operation === "rerank" ? { document_count: 2 } : { seconds: 10 } }, 503) : response(operation);
    });
    expect((await call(operation)).status).toBe(200);
    const result = await summary(); expect(held).toBe("4.000000000000000000");
    expect(result.reservations[0].admission).toMatchObject({ attempts: 4, per_attempt_cost_usd: "1.000000000000000000" });
    expect(result.provider_attempts).toBe(3); expect(h.fetchMock.calls).toHaveLength(3);
    expect(result.budget_committed_usd).toBe(operation === "rerank" ? "0.070000000000000000" : "0.810000000000000000");
    expect(await source.query("SELECT * FROM pricing_budget_effects WHERE kind = 'commit'")).toHaveLength(1);
  });

  it.each(operations.flatMap(operation => [true, false].map(known => ({ operation, known }))))(
    "retains cancelled $operation expense with known=$known supplier evidence without redispatch",
    async ({ operation, known }) => {
      await publish(operation, price(operation)); expect((await policy(operation, "not_applicable")).status).toBe(200);
      let entered!: () => void, release!: () => void, aborted!: () => void;
      const start = new Promise<void>(resolve => { entered = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      const cancellation = new Promise<void>(resolve => { aborted = resolve; });
      h.fetchMock.setHandler(async (_url, init) => {
        if (init.signal?.aborted) aborted(); else init.signal?.addEventListener("abort", aborted, { once: true });
        entered(); await gate;
        // A supplier can race cancellation and still deliver its final usage.
        if (known) return response(operation);
        throw new DOMException("Synthetic client cancellation", "AbortError");
      });
      const address = h.app.getHttpServer().address();
      if (!address || typeof address === "string" || address.port === 2099) throw new Error("Invalid isolated listener");
      const client = httpRequest({ host: "127.0.0.1", port: address.port, method: "POST", path: route(operation),
        headers: { Authorization: `Bearer ${API_KEY}`, "content-type": "application/json" } });
      client.on("error", () => undefined); client.end(JSON.stringify(body(operation)));
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await start; client.destroy();
        await Promise.race([cancellation, new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error("Cancellation did not reach supplier transport")), 3000);
        })]);
        release(); const result = await summary();
        expect(result.provider_attempts).toBe(1); expect(h.fetchMock.calls).toHaveLength(1);
        expect(result.reservations[0].state).toBe(known ? "committed" : "reserved");
        expect(result.budget_committed_usd).toBe(!known ? "0.000000000000000000" : operation === "rerank"
          ? "0.030000000000000000" : operation === "audio_speech" ? "0.064000000000000000" : "0.610000000000000000");
        if (!known) expect(result.attempts[0].error_code).toBe("client_aborted");
      } finally { if (timeout) clearTimeout(timeout); client.destroy(); release(); await h.app.get(PricingRuntimeService).waitForRequests(); }
    },
  );

  it.each(["audio_transcription", "audio_translation", "audio_speech"] as const)("does not finalize an asynchronous %s acknowledgement as completed work", async operation => {
    await publish(operation, book([rate("request", "request_count", "0.1", "1")])); await policy(operation, "not_applicable");
    h.fetchMock.setHandler(async () => json({ id: "synthetic-pending-audio", status: "pending", usage: { seconds: 61 } }, 202));
    await call(operation); const result = await summary();
    expect(result.reservations[0].state).toBe("reserved"); expect(result.attempts[0].cost).toBeNull();
    expect(await source.query("SELECT * FROM pricing_media_tasks")).toHaveLength(0);
    expect(await source.query("SELECT * FROM pricing_budget_effects WHERE kind = 'commit'")).toHaveLength(0);
    const restored = new CostLedgerService(source, h.app.get(BudgetService));
    await restored.replayRuntimeOutcomes(new Date(Date.now() + 120000));
    expect(h.fetchMock.calls).toHaveLength(1); expect((await summary()).reservations[0].state).toBe("reserved");
  });

  it.each([{ status: 202, body: {} }, { status: 200, body: { status: "pending" } }, { status: 200, body: { done: false } }])(
    "does not turn a pending rerank acknowledgement into a finalized invocation fee: %j", async acknowledgement => {
      await publish("rerank", book([rate("request", "rerank_request_count", "0.1", "1")])); await policy("rerank", "not_applicable");
      h.fetchMock.setHandler(async () => json({ id: "synthetic-pending-rerank", usage: { document_count: 3 }, ...acknowledgement.body }, acknowledgement.status));
      await call("rerank"); const result = await summary();
      expect(result.reservations[0].state).toBe("reserved"); expect(result.attempts[0].cost).toBeNull();
      expect(await source.query("SELECT * FROM pricing_budget_effects WHERE kind = 'commit'")).toHaveLength(0);
      expect(h.fetchMock.calls).toHaveLength(1);
    },
  );

  it.each(["audio_transcription", "rerank"] as const)("includes a known paid failed %s attempt before the successful retry", async operation => {
    await publish(operation, price(operation)); await policy(operation, "not_applicable");
    let count = 0; h.fetchMock.setHandler(async () => ++count === 1 ? json({ error: { message: "Synthetic retry" }, usage: operation === "rerank" ? { document_count: 2 } : { seconds: 10 } }, 503) : response(operation));
    expect((await call(operation)).status).toBe(200); const result = await summary();
    expect(h.fetchMock.calls).toHaveLength(2); expect(result.provider_attempts).toBe(2);
    expect(result.budget_committed_usd).toBe(operation === "rerank" ? "0.050000000000000000" : "0.710000000000000000");
    expect(await source.query("SELECT * FROM pricing_budget_effects WHERE kind = 'commit'")).toHaveLength(1);
  });

  it.each(["audio_transcription", "rerank"] as const)("retains uncertainty for an unreported failed %s attempt even after retry succeeds", async operation => {
    await publish(operation, price(operation)); await policy(operation, "not_applicable");
    let count = 0; h.fetchMock.setHandler(async () => ++count === 1 ? json({ error: { message: "Synthetic unknown usage" } }, 503) : response(operation));
    expect((await call(operation)).status).toBe(200); const result = await summary();
    expect(result.provider_attempts).toBe(2); expect(result.reservations[0].state).toBe("reserved");
  });

  it("preserves supplier-reported character counts and request fees on a failed speech retry", async () => {
    await publish("audio_speech", { ...book([rate("characters", "text_characters", "0.01", "1"), rate("request", "request_count", "0.02", "1")]), allow_combined_media: true }); await policy("audio_speech", "not_applicable");
    let count = 0; h.fetchMock.setHandler(async () => ++count === 1 ? json({ error: { message: "Synthetic paid failure" }, usage: { text_characters: 2, request_count: 1 } }, 503) : response("audio_speech"));
    expect((await call("audio_speech")).status).toBe(200); expect((await summary()).budget_committed_usd).toBe("0.090000000000000000");
  });

  it("retains failed rerank request-count evidence without inventing it from an HTTP status", async () => {
    await publish("rerank", book([rate("request", "rerank_request_count", "0.1", "1")])); await policy("rerank", "not_applicable");
    let count = 0; h.fetchMock.setHandler(async () => ++count === 1 ? json({ error: { message: "Synthetic paid failure" }, usage: { rerank_request_count: 1 } }, 503) : response("rerank"));
    expect((await call("rerank")).status).toBe(200); expect((await summary()).budget_committed_usd).toBe("0.200000000000000000");
  });

  it("does not refund known quantity use when every supplier attempt fails", async () => {
    // The general media fixture also configures tts-1 as a fallback audio model.
    // This case isolates exhausted retries; unpriced fallback rejection is separate.
    h.app.get(ConfigService).getNode("mock-openai")!.audio_models = [model("audio_transcription")];
    await publish("audio_transcription", price("audio_transcription")); await policy("audio_transcription", "not_applicable");
    h.fetchMock.setHandler(async () => json({ error: { message: "Synthetic terminal failure" }, usage: { seconds: 10 } }, 503));
    expect((await call("audio_transcription")).status).toBeGreaterThanOrEqual(500);
    const result = await summary(); expect(h.fetchMock.calls).toHaveLength(2); expect(result.budget_committed_usd).toBe("0.200000000000000000");
  });

  it("preserves paid retries when a later unpriced fallback is rejected before dispatch", async () => {
    await publish("audio_transcription", price("audio_transcription")); await policy("audio_transcription", "not_applicable");
    h.fetchMock.setHandler(async () => json({ error: { message: "Synthetic terminal failure" }, usage: { seconds: 10 } }, 503));
    const failed = await call("audio_transcription"); expect(failed.status).toBe(422); expect(failed.body.error.code).toBe("pricing_token_budget_incompatible");
    expect(h.fetchMock.calls).toHaveLength(2); expect((await summary()).budget_committed_usd).toBe("0.200000000000000000");
  });

  it("keeps original prices across a paid retry while a new catalog is published", async () => {
    await publish("audio_transcription", price("audio_transcription")); await policy("audio_transcription", "not_applicable");
    let count = 0; h.fetchMock.setHandler(async () => {
      if (++count === 1) {
        await publish("audio_transcription", book([rate("units", "audio_input_seconds", "1", "1")]));
        return json({ error: { message: "Synthetic retry" }, usage: { seconds: 10 } }, 503);
      }
      return response("audio_transcription");
    });
    expect((await call("audio_transcription")).status).toBe(200); const old = await summary();
    expect(old.budget_committed_usd).toBe("0.710000000000000000"); expect(new Set(old.attempts.map(a => a.cost?.version_id)).size).toBe(1);
    expect((await call("audio_transcription")).status).toBe(200); const next = await summary(); expect(next.budget_committed_usd).toBe("61.000000000000000000");
    expect(next.attempts[0].cost?.version_id).not.toBe(old.attempts[0].cost?.version_id);
  });

  it("replays a retained quantity closure without redispatch and keeps original accounting workspace", async () => {
    await publish("audio_transcription", price("audio_transcription")); await policy("audio_transcription", "not_applicable");
    const ledger = h.app.get(CostLedgerService);
    const fault = jest.spyOn(ledger as unknown as { closeActualBudget: (...args: unknown[]) => Promise<void> }, "closeActualBudget").mockRejectedValue(new Error("Synthetic closure delivery failure"));
    h.fetchMock.setHandler(async () => response("audio_transcription")); expect((await call("audio_transcription", API_KEY_2)).status).toBe(200);
    expect((await summary()).reservations[0].state).toBe("reserved"); fault.mockRestore();
    const restored = new CostLedgerService(source, h.app.get(BudgetService));
    await restored.replayRuntimeOutcomes(new Date(Date.now() + 120000)); await restored.replayRuntimeOutcomes(new Date(Date.now() + 240000));
    expect((await summary()).budget_committed_usd).toBe("0.610000000000000000"); expect(h.fetchMock.calls).toHaveLength(1);
  });
});

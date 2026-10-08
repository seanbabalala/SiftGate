import { DataSource } from "typeorm";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as yaml from "js-yaml";
import { API_KEY, createE2EHarness, type E2EHarness, FIXTURE_PATH } from "./setup";
import { BudgetService } from "../../src/budget/budget.service";
import { ConfigService } from "../../src/config/config.service";
import { PricingRepository } from "../../src/pricing/pricing-repository";
import { CostLedgerService } from "../../src/pricing/cost-ledger.service";
import { PricingRecoveryService } from "../../src/pricing/pricing-recovery.service";
import { PricingRuntimeService } from "../../src/pricing/pricing-runtime.service";
import { applyPricingSchema } from "../../src/pricing/pricing-schema";
import { tokenBook, tokens } from "../unit/pricing-fixtures";
import type { PricingOutcome } from "../../src/pricing/pricing-outcome-retry";

describe("opt-in actual supplier expense on real text requests", () => {
  let h: E2EHarness, source: DataSource, directory: string;
  const base = "/api/dashboard/pricing";
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "actual-budget-http-"));
    const config = yaml.load(readFileSync(FIXTURE_PATH, "utf8")) as Record<string, unknown>;
    config.cache = { enabled: true, ttl_seconds: 300, max_entries: 100, exclude_tool_use: true };
    config.budget = { daily_token_limit: 10000000, daily_cost_limit: 1000, alert_threshold: 0.8 };
    (config.routing as Record<string, unknown>).retry = { max_retries: 1, backoff_base_ms: 1, backoff_max_ms: 1, retryable_status: [500, 502, 503, 504] };
    (config.routing as Record<string, unknown>).tiers = Object.fromEntries(["simple", "standard", "complex", "reasoning"].map(tier => [tier, { primary: { node: "mock-openai", model: "gpt-4o" }, fallbacks: [] }]));
    const file = join(directory, "gateway.yaml"); writeFileSync(file, yaml.dump(config));
    h = await createE2EHarness(file); source = h.app.get(DataSource);
    await h.app.get(PricingRecoveryService).onModuleDestroy();
    await applyPricingSchema(source);
  }, 30000);
  afterEach(async () => { jest.restoreAllMocks(); await h?.close(); if (directory) rmSync(directory, { recursive: true, force: true }); });
  async function publishFixture() {
    const book = await h.agent.post(`${base}/books`).send({ name: "Synthetic actual budget", content: tokenBook() });
    expect(book.status).toBe(201);
    expect((await h.agent.post(`${base}/drafts/${book.body.draft.id}/publish`).send({ draft_revision: 1, catalog_revision: 0, reason: "Synthetic rates only", confirm: true, targets: [{ level: "model", model: "gpt-4o" }] })).status).toBe(201);
  }
  async function policy(basis?: "actual_upstream" | "legacy_logical", operation = "chat_completions") {
    const head = (await h.agent.get(`${base}/bindings`)).body.head;
    return h.agent.put(`${base}/admission-policy`).send({ catalog_revision: head.revision, scope: "workspace", operation, reason: "Synthetic explicit budget decision", confirm: true, policy: { mode: "compatibility", ...(basis ? { budget_basis: basis } : {}) } });
  }
  const call = (content = "Synthetic expense", stream = false) => h.agent.post("/v1/chat/completions").set("Authorization", `Bearer ${API_KEY}`).send({ model: "gpt-4o", max_tokens: 20, stream, messages: [{ role: "user", content }] });
  const reply = (input = 10, output = 5, status = 200, usage = true) => new Response(JSON.stringify({
    id: "synthetic-actual", model: "gpt-4o", choices: [{ index: 0, message: { role: "assistant", content: "Synthetic response" }, finish_reason: "stop" }],
    ...(status === 200 ? {} : { error: { message: "Synthetic retry", type: "server_error" } }),
    ...(usage ? { usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output, prompt_tokens_details: { cached_tokens: 0 }, cache_creation_input_tokens: 0 } } : {}),
  }), { status, headers: { "content-type": "application/json" } });
  async function summary() {
    await h.app.get(PricingRuntimeService).waitForRequests();
    const rows = await source.query("SELECT request_id, workspace_id FROM pricing_request_snapshots ORDER BY created_at DESC");
    return (await h.app.get(CostLedgerService).summary(rows[0].request_id, rows[0].workspace_id))!;
  }

  describe("with an approved price binding", () => {
    beforeEach(publishFixture);
  it.each([false, true])("recovers a lost runtime closure through the administrator API without inventing unknown expense (%s)", async unknown => {
    expect((await policy("actual_upstream")).status).toBe(200);
    const ledger = h.app.get(CostLedgerService), persist = ledger.persistRuntimeOutcome.bind(ledger);
    let closure: PricingOutcome | undefined, count = 0;
    const loss = jest.spyOn(ledger, "persistRuntimeOutcome").mockImplementation(async outcome => {
      if (outcome.type === "actual_budget_closure") { closure = structuredClone(outcome); throw new Error("Synthetic unavailable closure storage"); }
      return persist(outcome);
    });
    h.fetchMock.setHandler(async () => ++count === 1 ? reply(10, 5, 503, !unknown) : reply(20, 5));
    expect((await call()).status).toBe(200); await h.app.get(PricingRuntimeService).waitForRequests();
    expect(closure).toBeDefined(); expect(await source.query("SELECT * FROM pricing_actual_budget_cohorts")).toHaveLength(0);
    const hold = (await source.query("SELECT * FROM pricing_reservations"))[0];
    await source.createQueryBuilder().update("pricing_reservations").set({ lease_until: new Date(Date.now() - 60000).toISOString() }).where("id = :id", { id: hold.id }).execute();
    const path = `${base}/recovery-cases/${encodeURIComponent(hold.id)}`;
    const basis = await h.agent.get(`${path}/basis`); expect(basis.status).toBe(200);
    expect(basis.body.reservations[0]).toMatchObject({ budget_basis: "actual_upstream", actual_budget: { dispatch_closed: false, settlement_ready: !unknown } });
    const input = { id: `synthetic-actual-recovery-${unknown}`, expected_basis_hash: basis.body.basis_hash, reason: "Synthetic explicit closure recovery", confirm: true, decisions: [{ reservation_id: hold.id, action: "reconcile_actual" }] };
    const original = await source.query("SELECT * FROM pricing_attempts ORDER BY id");
    expect((await h.agent.post(`${path}/preview`).send({ ...input, decisions: [{ ...input.decisions[0], logical_tokens: "0" }] })).status).toBe(400);
    const preview = await h.agent.post(`${path}/preview`).send(input); expect(preview.status).toBe(201);
    expect(await source.query("SELECT * FROM pricing_actual_budget_cohorts")).toHaveLength(0);
    const applied = await h.agent.post(`${path}/resolve`).send(input); expect(applied.status === 201 ? 201 : applied.body).toBe(201);
    expect(applied.body.changes).toEqual(preview.body.changes);
    expect(applied.body.changes[0]).toMatchObject({ next_state: unknown ? "reserved" : "committed", budget_attempt_id: null, budget_cost_usd: unknown ? "0.000000000000000000" : "0.000050000000000000" });
    expect((await h.agent.get(`${path}/resolutions/${input.id}`)).body.result).toEqual(applied.body);
    expect((await h.agent.post(`${path}/resolve`).send(input)).body.replayed).toBe(true);
    loss.mockRestore(); await ledger.persistRuntimeOutcome(closure!);
    expect(await source.query("SELECT * FROM pricing_attempts ORDER BY id")).toEqual(original);
    expect(h.fetchMock.calls).toHaveLength(2);
    expect((await h.agent.get(`${path}/resolutions/${input.id}`)).body.result).toEqual(applied.body);
  });
  it("keeps the legacy winner basis when the new field is absent", async () => {
    expect((await policy()).status).toBe(200);
    let count = 0; h.fetchMock.setHandler(async () => ++count === 1 ? reply(10, 5, 503) : reply(20, 5));
    expect((await call()).status).toBe(200);
    const result = await summary();
    expect(result.provider_attempts).toBe(2);
    expect(result.amount).toBe("0.000050000000000000");
    expect(result.budget_committed_usd).toBe("0.000030000000000000");
    expect(await source.query("SELECT * FROM pricing_actual_budget_cohorts")).toHaveLength(0);
  });
  it("rejects an incomplete installed migration chain before dispatch instead of silently taking the legacy path", async () => {
    const ledger = h.app.get(CostLedgerService) as unknown as { prices: PricingRepository };
    expect(ledger.prices).toBe(h.app.get(PricingRepository));
    await source.createQueryBuilder().delete().from("pricing_schema_versions").where("id = :id", { id: "pricing-engine-015" }).execute();
    const result = await call();
    expect(result.status).toBe(503); expect(result.body.error.code).toBe("pricing_schema_required");
    expect(h.fetchMock.calls).toHaveLength(0);
    expect(await source.query("SELECT * FROM pricing_request_snapshots")).toHaveLength(0);
  });
  it("commits every known paid retry exactly once under the opt-in policy", async () => {
    expect((await policy("actual_upstream")).status).toBe(200);
    let count = 0; h.fetchMock.setHandler(async () => ++count === 1 ? reply(10, 5, 503) : reply(20, 5));
    expect((await call()).status).toBe(200);
    const result = await summary();
    expect(h.fetchMock.calls).toHaveLength(2);
    expect(result.amount).toBe("0.000050000000000000");
    expect(result.budget_committed_usd).toBe(result.amount);
    expect(result.reservations).toEqual([expect.objectContaining({ state: "committed", budget_basis: "actual_upstream", committed_tokens: "40" })]);
    expect((await source.query("SELECT * FROM pricing_actual_budget_cohorts"))[0].state).toBe("applied");
    await h.app.get(CostLedgerService).reconcileActualBudgets();
    expect((await summary()).budget_committed_usd).toBe(result.amount);
    expect(h.fetchMock.calls).toHaveLength(2);
  });
  it("keeps an unknown failed expense pending and fences later attempts instead of declaring it free", async () => {
    expect((await policy("actual_upstream")).status).toBe(200);
    let count = 0; h.fetchMock.setHandler(async () => ++count === 1 ? reply(0, 0, 503, false) : reply(20, 5));
    expect((await call()).status).toBe(200);
    const result = await summary();
    expect(result.amount).toBeNull(); expect(result.known_subtotal).toBe("0.000030000000000000");
    expect(result.budget_committed_usd).toBe("0.000000000000000000"); expect(result.reservations[0].state).toBe("reserved");
    const cohort = (await source.query("SELECT * FROM pricing_actual_budget_cohorts"))[0]; expect(cohort.state).toBe("pending");
    await expect(h.app.get(CostLedgerService).beginAttempt({ id: "late-paid-attempt", requestId: result.request_id, workspace: cohort.workspace_id, reservationId: cohort.reservation_id, target: { model: "gpt-4o" }, feeSource: "provider", dispatchedAt: new Date().toISOString(), priceContext: { context: {}, legacyPrice: null } })).rejects.toThrow("closed actual-upstream cohort");
    expect(await h.app.get(CostLedgerService).reconcileActualBudgets()).toEqual({ applied: 0, pending: 1, review_required: 0 });
    expect(h.fetchMock.calls).toHaveLength(2);
  });
  it("commits confirmed paid attempts even when every retry fails to return a successful client response", async () => {
    expect((await policy("actual_upstream")).status).toBe(200);
    h.fetchMock.setHandler(async () => reply(10, 5, 503));
    expect((await call()).status).toBeGreaterThanOrEqual(500);
    const result = await summary(); expect(h.fetchMock.calls).toHaveLength(2);
    expect(result.amount).toBe("0.000040000000000000"); expect(result.budget_committed_usd).toBe(result.amount);
    expect(result.reservations[0]).toMatchObject({ state: "committed", committed_tokens: "30", budget_basis: "actual_upstream" });
  });
  it("uses the same complete expense cohort for a successful SSE response after a paid retry", async () => {
    expect((await policy("actual_upstream")).status).toBe(200);
    let count = 0;
    h.fetchMock.setHandler(async () => ++count === 1 ? reply(10, 5, 503) : new Response([
      `data: ${JSON.stringify({ id: "synthetic-stream", model: "gpt-4o", choices: [{ index: 0, delta: { content: "Synthetic streaming answer" }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ id: "synthetic-stream", model: "gpt-4o", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25, prompt_tokens_details: { cached_tokens: 0 }, cache_creation_input_tokens: 0 } })}\n\n`,
      "data: [DONE]\n\n",
    ].join(""), { headers: { "content-type": "text/event-stream" } }));
    const result = await call("Synthetic streamed expense", true); expect(result.status).toBe(200); expect(result.text).toContain("[DONE]");
    expect((await summary()).budget_committed_usd).toBe("0.000050000000000000"); expect(h.fetchMock.calls).toHaveLength(2);
  });
  it.each([
    { operation: "responses", path: "/v1/responses", body: { model: "gpt-4o", input: "Synthetic responses expense" } },
    { operation: "messages", path: "/v1/messages", body: { model: "gpt-4o", max_tokens: 20, messages: [{ role: "user", content: "Synthetic messages expense" }] } },
  ])("applies the explicitly selected policy for $operation ingress", async fixture => {
    expect((await policy("actual_upstream", fixture.operation)).status).toBe(200);
    h.fetchMock.setHandler(async () => reply(20, 5));
    const result = await h.agent.post(fixture.path).set("Authorization", `Bearer ${API_KEY}`).send(fixture.body);
    expect(result.status === 200 ? 200 : result.body).toBe(200);
    expect((await summary()).budget_committed_usd).toBe("0.000030000000000000"); expect(h.fetchMock.calls).toHaveLength(1);
  });
  it("settles native Gemini supplier usage through the existing chat ingress rather than inventing a Gemini ingress route", async () => {
    expect((await policy("actual_upstream")).status).toBe(200);
    const node = h.app.get(ConfigService).getNode("mock-openai")!;
    node.protocol = "gemini"; node.compatibility_profile = "google_gemini_compatible"; node.endpoint = "/v1beta/models/:model:generateContent";
    h.fetchMock.setHandler(async () => new Response(JSON.stringify({
      candidates: [{ content: { role: "model", parts: [{ text: "Synthetic Gemini response" }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 5, thoughtsTokenCount: 0, totalTokenCount: 25, cachedContentTokenCount: 0 },
    }), { headers: { "content-type": "application/json" } }));
    expect((await call()).status).toBe(200);
    expect(h.fetchMock.calls).toHaveLength(1); expect(h.fetchMock.calls[0].url).toContain(":generateContent");
    expect((await summary()).budget_committed_usd).toBe("0.000030000000000000");
  });
  it("charges no supplier budget for a local cache hit while preserving the logical response usage", async () => {
    expect((await policy("actual_upstream")).status).toBe(200);
    h.fetchMock.setHandler(async () => reply());
    const first = await call(), cached = await call(); expect(first.status).toBe(200); expect(cached.status).toBe(200);
    expect(cached.body.usage).toEqual(first.body.usage); expect(h.fetchMock.calls).toHaveLength(1);
    const local = (await source.query("SELECT * FROM pricing_reservations WHERE id LIKE 'local-%'"))[0];
    expect(local).toMatchObject({ state: "committed", budget_basis: "actual_upstream", committed_tokens: "0", committed_cost_usd: "0.000000000000000000" });
    const logical = JSON.parse(local.estimate_json); expect(logical.report_amount).not.toBe("0.000000000");
  });
  it("does not replace the in-flight actual policy when the administrator publishes legacy again", async () => {
    expect((await policy("actual_upstream")).status).toBe(200);
    let entered!: () => void, release!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    h.fetchMock.setHandler(async () => { entered(); await gate; return reply(); });
    const running = call().then(value => value);
    try { await reached; expect((await policy("legacy_logical")).status).toBe(200); }
    finally { release(); }
    expect((await running).status).toBe(200); expect((await summary()).reservations[0].budget_basis).toBe("actual_upstream");
  });
  it("replays a retained closure with a fresh ledger after delivery failure without repeating supplier work", async () => {
    expect((await policy("actual_upstream")).status).toBe(200);
    const ledger = h.app.get(CostLedgerService);
    const fault = jest.spyOn(ledger as unknown as { closeActualBudget: (...args: unknown[]) => Promise<void> }, "closeActualBudget").mockRejectedValue(new Error("Synthetic delivery failure"));
    h.fetchMock.setHandler(async () => reply());
    expect((await call()).status).toBe(200);
    expect((await summary()).reservations[0].state).toBe("reserved");
    fault.mockRestore();
    const fresh = new CostLedgerService(source, h.app.get(BudgetService));
    expect((await fresh.replayRuntimeOutcomes(new Date(Date.now() + 120000))).persisted).toBeGreaterThan(0);
    expect((await summary()).budget_committed_usd).toBe("0.000020000000000000");
    await fresh.replayRuntimeOutcomes(new Date(Date.now() + 240000));
    expect((await summary()).budget_committed_usd).toBe("0.000020000000000000"); expect(h.fetchMock.calls).toHaveLength(1);
  });
  it("does not activate an unsupported operation policy", async () => {
    expect((await policy("actual_upstream", "unknown_operation")).status).toBe(400);
    expect((await h.agent.get(`${base}/admission-policies`)).body.policies).toEqual([]);
  });
  it("allows scoped administrator correction of a closed actual request but keeps attestation estimated and its budget pending", async () => {
    expect((await policy("actual_upstream")).status).toBe(200); h.fetchMock.setHandler(async () => reply());
    expect((await call()).status).toBe(200);
    const result = await summary(), attempt = result.attempts[0], path = `${base}/attempts/${attempt.id}`;
    const basis = await h.agent.get(`${path}/correction-basis`);
    expect(basis.status).toBe(200); expect(basis.body.blocked_reason).toBeNull();
    const body = { id: "actual-admin-estimate", expected_basis_hash: basis.body.basis_hash, expected_cost_hash: basis.body.effective_cost_hash, reason: "Synthetic operator-attested quantities", confirm: true,
      evidence: [["total_input_tokens", "20"], ["uncached_input_tokens", "20"], ["output_tokens", "10"], ["cache_read_tokens", "0"], ["cache_write_tokens", "0"], ["cache_write_5m_tokens", "0"], ["cache_write_1h_tokens", "0"]].map(([dimension, value]) => ({ dimension, value })) };
    const tables = ["budget_rules", "pricing_cost_adjustments", "pricing_adjustment_applications", "pricing_budget_effects", "pricing_actual_budget_cohorts", "pricing_attempts", "pricing_reservations"];
    const dump = async () => { const rows: Record<string, unknown> = {}; for (const table of tables) rows[table] = await source.query(`SELECT * FROM ${table}`); return rows; };
    const before = await dump(); const preview = await h.agent.post(`${path}/correction/preview`).send(body);
    expect(preview.status === 201 ? 201 : preview.body).toBe(201); expect(await dump()).toEqual(before);
    expect(preview.body.budget).toMatchObject({ budget_state: "pending", cost_delta: "0.000000000000000000", tokens_delta: "0" });
    const corrected = await h.agent.post(`${path}/correction`).send(body);
    expect(corrected.status === 201 ? 201 : corrected.body).toBe(201);
    expect(corrected.body).toMatchObject({ supplier_confirmed: false, original_receipt_modified: false, cost: { evidence_status: "estimated" } });
    expect((await summary())).toMatchObject({ budget_committed_usd: "0.000020000000000000", pending_budget_adjustments: 1 });
    const replay = await h.agent.post(`${path}/correction`).send(body); expect(replay.status).toBe(201); expect(replay.body.cost_hash).toBe(corrected.body.cost_hash);
    expect(h.fetchMock.calls).toHaveLength(1);
  });
  it("invalidates an actual correction preview when another paid attempt changes the accepted cohort", async () => {
    expect((await policy("actual_upstream")).status).toBe(200);
    let count = 0; h.fetchMock.setHandler(async () => ++count === 1 ? reply(10, 5, 503) : reply(20, 5)); expect((await call()).status).toBe(200);
    const result = await summary(), failed = result.attempts.find(attempt => attempt.error_code)!, successful = result.attempts.find(attempt => !attempt.error_code)!;
    const path = `${base}/attempts/${failed.id}`, basis = await h.agent.get(`${path}/correction-basis`); expect(basis.status).toBe(200);
    const snapshot = await h.app.get(PricingRepository).restoreRequest(result.request_id, failed.workspace_id);
    const cost = snapshot.quote({ node_id: successful.node_id, model: successful.model, operation: "chat_completions" }, tokens({ input_tokens: 30, output_tokens: 5 })).cost;
    if (successful.cost!.attribution) cost.attribution = successful.cost!.attribution;
    await h.app.get(CostLedgerService).adjustAttempt({ id: "concurrent-supplier-change", attemptId: successful.id, workspace: successful.workspace_id, expectedCostHash: successful.cost_hash!, cost, actorId: "synthetic-supplier-reconciler", reason: "Synthetic observed supplier counters", source: "provider_usage" });
    const stale = await h.agent.post(`${path}/correction/preview`).send({ id: "stale-cohort-preview", expected_basis_hash: basis.body.basis_hash, expected_cost_hash: basis.body.effective_cost_hash, reason: "Synthetic stale review", confirm: true, evidence: [{ dimension: "total_input_tokens", value: "10" }, { dimension: "uncached_input_tokens", value: "10" }, { dimension: "output_tokens", value: "5" }] });
    expect(stale.status).toBe(409); expect((await summary()).budget_committed_usd).toBe("0.000060000000000000");
    expect(await source.query("SELECT * FROM pricing_cost_adjustments")).toHaveLength(1); expect(h.fetchMock.calls).toHaveLength(2);
  });
  });

  it("honors explicit actual budget policy with no approved bindings, preserving unknown provider cost and cache zero", async () => {
    expect((await policy("actual_upstream")).status).toBe(200);
    h.fetchMock.setHandler(async () => reply());
    const first = await call(); expect(first.status).toBe(200);
    const reservations = await source.query("SELECT * FROM pricing_reservations WHERE id NOT LIKE 'local-%'");
    expect(reservations).toHaveLength(1);
    const provider = reservations[0];
    expect(provider).toMatchObject({ budget_basis: "actual_upstream", state: "reserved" });
    const plan = await h.app.get(CostLedgerService).previewActualUpstreamBudget(provider.id, provider.workspace_id, true);
    expect(plan.plan).toMatchObject({ state: "awaiting_evidence", cost_usd: null });
    const held = await source.query("SELECT type, current_value FROM budget_rules ORDER BY id");
    const cached = await call(); expect(cached.status).toBe(200); expect(cached.body.usage).toEqual(first.body.usage);
    expect(h.fetchMock.calls).toHaveLength(1);
    expect(await source.query("SELECT type, current_value FROM budget_rules ORDER BY id")).toEqual(held);
    const local = (await source.query("SELECT * FROM pricing_reservations WHERE id LIKE 'local-%'"))[0];
    expect(local).toMatchObject({ budget_basis: "actual_upstream", state: "committed", committed_tokens: "0", committed_cost_usd: "0.000000000000000000" });
    expect(await source.query("SELECT * FROM pricing_books")).toHaveLength(0);
  });
  it("keeps absent budget basis legacy with no approved bindings, including logical cache budgeting", async () => {
    expect((await policy()).status).toBe(200); h.fetchMock.setHandler(async () => reply());
    expect((await call()).status).toBe(200);
    const before = (await source.query("SELECT current_value FROM budget_rules WHERE type = 'daily_tokens'"))[0].current_value;
    expect(Number(before)).toBe(15);
    expect((await call()).status).toBe(200); expect(h.fetchMock.calls).toHaveLength(1);
    const after = (await source.query("SELECT current_value FROM budget_rules WHERE type = 'daily_tokens'"))[0].current_value;
    expect(Number(after)).toBe(30);
    expect(await source.query("SELECT * FROM pricing_reservations")).toHaveLength(0);
  });

});

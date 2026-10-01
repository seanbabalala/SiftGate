import { strict as assert } from "node:assert";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as yaml from "js-yaml";
import { DataSource } from "typeorm";
import { API_KEY, createE2EHarness, FIXTURE_PATH, type E2EHarness } from "../e2e/setup";
import { applyPricingSchema } from "../../src/pricing/pricing-schema";
import { PricingRecoveryService } from "../../src/pricing/pricing-recovery.service";
import { PricingRuntimeService } from "../../src/pricing/pricing-runtime.service";
import type { CostLedgerSummary } from "../../src/pricing/cost-ledger.types";
import type { CostComputation } from "../../src/pricing/pricing.types";
import { book, rate } from "../unit/pricing-fixtures";

export const CONTRACT_MODEL = "gpt-4o";
const base = "/api/dashboard/pricing";
export interface NodeContractVersion { book_id: string; version_id: string; node_id: string }

/** Synthetic only: the harness mocks every supplier fetch and listens on port0. */
export async function createNodeContractHarness(directory: string, frontendRoot?: string): Promise<E2EHarness> {
  const config = yaml.load(readFileSync(FIXTURE_PATH, "utf8")) as Record<string, unknown>;
  config.nodes = ["a", "b"].map(id => ({
    id: `contract-${id}`, name: `Synthetic contract ${id.toUpperCase()}`,
    protocol: "chat_completions", base_url: `http://contract-${id}.test`, endpoint: "/v1/chat/completions",
    api_key: `synthetic-contract-${id}`, models: [CONTRACT_MODEL],
    upstream_model_aliases: { [CONTRACT_MODEL]: `synthetic-wire-${id}` },
    timeout_ms: 10000, health_check: { enabled: false }, credential_pool: { enabled: false },
  }));
  config.routing = {
    tiers: Object.fromEntries(["simple", "standard", "complex", "reasoning"].map(tier => [tier, {
      primary: { node: "contract-a", model: CONTRACT_MODEL }, fallbacks: [{ node: "contract-b", model: CONTRACT_MODEL }],
    }])),
    scoring: { simple_max: -1, standard_max: 999, complex_max: 1000 },
    retry: { max_retries: 0 }, circuit_breaker: { enabled: false }, cache_affinity: { enabled: false },
  };
  config.cache = { enabled: false };
  config.budget = { daily_token_limit: 10000000, daily_cost_limit: 1000, alert_threshold: 0.8 };
  const file = join(directory, "config.yaml"); writeFileSync(file, yaml.dump(config));
  const h = await createE2EHarness(file, { frontendRoot });
  await h.app.get(PricingRecoveryService).onModuleDestroy();
  await applyPricingSchema(h.app.get(DataSource));
  return h;
}

export async function publishNodeContract(h: E2EHarness, node: string, input: string, output: string, effectiveFrom?: string): Promise<NodeContractVersion> {
  const created = await h.agent.post(`${base}/books`).send({
    name: `Synthetic ${node} ${input}/${output}`, content: book([
      rate("input", "uncached_input_tokens", input, "1000000"),
      rate("output", "output_tokens", output, "1000000"),
    ]),
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const head = (await h.agent.get(`${base}/bindings`)).body.head;
  const published = await h.agent.post(`${base}/drafts/${created.body.draft.id}/publish`).send({
    draft_revision: 1, catalog_revision: head.revision, reason: "Synthetic node-specific contract", confirm: true,
    ...(effectiveFrom ? { effective_from: effectiveFrom } : {}),
    targets: [{ level: "node", node_id: node, model: CONTRACT_MODEL, operation: "chat_completions" }],
  });
  assert.equal(published.status, 201, JSON.stringify(published.body));
  return { book_id: created.body.book.id as string, version_id: published.body.version_id as string, node_id: node };
}

export async function quoteNodeContract(h: E2EHarness, version: NodeContractVersion): Promise<CostComputation> {
  const response = await h.agent.post(`${base}/quote`).send({
    book_id: version.book_id, version_id: version.version_id,
    evidence: [["total_input_tokens", "1000"], ["uncached_input_tokens", "1000"], ["cache_read_tokens", "0"],
      ["cache_write_tokens", "0"], ["cache_write_5m_tokens", "0"], ["cache_write_1h_tokens", "0"], ["output_tokens", "100"]]
      .map(([dimension, value]) => ({ dimension, value, source: "request_metadata", quality: "observed" })),
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  assert.equal(response.body.simulation, true);
  return response.body.cost as CostComputation;
}

/** Publish two contracts, change B during A's paid failure, then exercise old/new snapshots. */
export async function runNodeContractScenario(h: E2EHarness, actual: boolean, stream: boolean, scheduled?: { admittedAt: string; effectiveFrom: string; beforeRequest(): void; activate(): void }) {
  const a = await publishNodeContract(h, "contract-a", "1", "2", scheduled?.admittedAt);
  const b = await publishNodeContract(h, "contract-b", "3", "4", scheduled?.admittedAt);
  const db = h.app.get(DataSource), runtime = h.app.get(PricingRuntimeService);
  if (actual) {
    const head = (await h.agent.get(`${base}/bindings`)).body.head;
    const policy = await h.agent.put(`${base}/admission-policy`).send({
      catalog_revision: head.revision, scope: "workspace", operation: "chat_completions", reason: "Synthetic actual expense", confirm: true,
      policy: { mode: "compatibility", budget_basis: "actual_upstream" },
    });
    assert.equal(policy.status, 200, JSON.stringify(policy.body));
  }
  const quotes = { a: await quoteNodeContract(h, a), b: await quoteNodeContract(h, b) };
  let updated: NodeContractVersion | undefined;
  if (scheduled) updated = await publishNodeContract(h, "contract-b", "30", "40", scheduled.effectiveFrom);
  let primaryDispatched = false;
  const usage = { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100, prompt_tokens_details: { cached_tokens: 0 }, cache_creation_input_tokens: 0 };
  h.fetchMock.setHandler(async (url, init) => {
    const node = new URL(url).hostname === "contract-a.test" ? "a" : "b";
    assert.equal(new URL(url).hostname, `contract-${node}.test`);
    const body = JSON.parse(String(init.body)) as { model: string; stream?: boolean };
    assert.equal(body.model, `synthetic-wire-${node}`);
    if (node === "a") {
      assert.equal(primaryDispatched, false, "The fixture expects one primary dispatch");
      primaryDispatched = true;
      if (scheduled) scheduled.activate();
      else updated = await publishNodeContract(h, "contract-b", "30", "40");
      return new Response(JSON.stringify({ model: "supplier-a", error: { message: "Synthetic paid failure", type: "server_error" }, usage }), { status: 503, headers: { "content-type": "application/json" } });
    }
    if (body.stream) return new Response([
      { id: "synthetic", model: "supplier-b", choices: [{ index: 0, delta: { content: "Synthetic contract result" }, finish_reason: null }] },
      { id: "synthetic", model: "supplier-b", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      { id: "synthetic", model: "supplier-b", choices: [], usage },
    ].map(value => `data: ${JSON.stringify(value)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    return new Response(JSON.stringify({ id: "synthetic", model: "supplier-b", choices: [{ index: 0, message: { role: "assistant", content: "Synthetic contract result" }, finish_reason: "stop" }], usage }), { headers: { "content-type": "application/json" } });
  });
  const call = async (model: string) => {
    const response = await h.agent.post("/v1/chat/completions").set("Authorization", `Bearer ${API_KEY}`).send({
      model, stream, ...(stream ? { stream_options: { include_usage: true } } : {}), max_tokens: 100,
      messages: [{ role: "user", content: "Synthetic node contract comparison" }],
    });
    assert.equal(response.status, 200, response.text); if (stream) assert(response.text.includes("[DONE]"));
    await runtime.waitForRequests();
  };
  const detail = async (id: number) => {
    const response = await h.agent.get(`/api/dashboard/logs/${id}/cost-breakdown`);
    assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body as CostLedgerSummary;
  };
  scheduled?.beforeRequest();
  await call("auto");
  const firstLog = (await db.query("SELECT id,request_id,cost_usd FROM call_logs ORDER BY id"))[0] as { id: number; request_id: string; cost_usd: number };
  assert(firstLog); const first = await detail(firstLog.id); assert(updated);
  await call(`contract-b/${CONTRACT_MODEL}`);
  const logs = await db.query("SELECT id,request_id,cost_usd FROM call_logs ORDER BY id") as Array<{ id: number; request_id: string; cost_usd: number }>;
  assert.equal(logs.length, 2); const second = await detail(logs[1].id), unchanged = await detail(firstLog.id);
  const report = await h.agent.get(`${base}/cost-report`).query({ from: new Date(Date.now() - 60000).toISOString(), to: new Date(Date.now() + 1000).toISOString() });
  assert.equal(report.status, 200, JSON.stringify(report.body));
  return { a, b, updated, quotes, currentQuote: await quoteNodeContract(h, updated), first, second, unchanged, logs, report: report.body as { rows: Array<{ request_id: string; amount_usd: string | null; budget_committed_usd: string }> }, providerCalls: h.fetchMock.calls.length };
}

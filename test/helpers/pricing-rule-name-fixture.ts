import { strict as assert } from "node:assert";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { load, dump } from "js-yaml";
import { DataSource } from "typeorm";
import { createE2EHarness, API_KEY, FIXTURE_PATH, type E2EHarness } from "../e2e/setup";
import { PricingRuntimeService } from "../../src/pricing/pricing-runtime.service";
import { PricingRecoveryService } from "../../src/pricing/pricing-recovery.service";
import { applyPricingSchema } from "../../src/pricing/pricing-schema";
import type { CostLedgerSummary } from "../../src/pricing/cost-ledger.types";
import type { CostComputation, PriceBookContent } from "../../src/pricing/pricing.types";
import { tokenBook } from "../unit/pricing-fixtures";

const base = "/api/dashboard/pricing";
export const ORIGINAL_RULE_NAME = '基础费率 <strong>literal & text</strong>';
export const UPDATED_RULE_NAME = "Updated display label · 新名称";
export async function createRuleNameHarness(directory: string, frontendRoot?: string) {
  const config = load(readFileSync(FIXTURE_PATH, "utf8")) as Record<string, unknown>;
  config.cache = { enabled: false }; const file = join(directory, "config.yaml"); writeFileSync(file, dump(config));
  const h = await createE2EHarness(file, { frontendRoot }); await h.app.get(PricingRecoveryService).onModuleDestroy(); await applyPricingSchema(h.app.get(DataSource)); return h;
}
export async function runRuleNameScenario(h: E2EHarness, stream = false) {
  const content = tokenBook(); content.groups[0].rules[0].name = ORIGINAL_RULE_NAME;
  const created = await h.agent.post(base + "/books").send({ name: "Synthetic named rules", content }); assert.equal(created.status, 201);
  const bookId = created.body.book.id as string;
  async function publish(draft: string, revision: number) {
    const head = (await h.agent.get(base + "/bindings")).body.head;
    const response = await h.agent.post(`${base}/drafts/${draft}/publish`).send({ draft_revision: revision, catalog_revision: head.revision, reason: "Synthetic label change", confirm: true, targets: [{ level: "model", model: "gpt-4o", operation: "chat_completions" }] });
    assert.equal(response.status, 201, JSON.stringify(response.body)); return response.body.version_id as string;
  }
  const originalVersion = await publish(created.body.draft.id, 1); let updatedVersion = "", updatedContent: PriceBookContent | undefined;
  const evidence = [["total_input_tokens", "1000"], ["uncached_input_tokens", "1000"], ["output_tokens", "100"], ["cache_read_tokens", "0"], ["cache_write_tokens", "0"], ["cache_write_5m_tokens", "0"], ["cache_write_1h_tokens", "0"]]
    .map(([dimension, value]) => ({ dimension, value, source: "request_metadata", quality: "observed" }));
  async function quote(version: string): Promise<CostComputation> {
    const r = await h.agent.post(base + "/quote").send({ book_id: bookId, version_id: version, evidence }); assert.equal(r.status, 201); return r.body.cost as CostComputation;
  }
  const originalQuote = await quote(originalVersion);
  h.fetchMock.setHandler(async (_url, init) => {
    const body = JSON.parse(String(init.body)) as { stream?: boolean };
    if (!updatedVersion) {
      const fork = await h.agent.post(`${base}/books/${bookId}/drafts`).send({ version_id: originalVersion }); assert.equal(fork.status, 201);
      updatedContent = structuredClone(fork.body.content) as PriceBookContent; updatedContent.groups[0].rules[0].name = UPDATED_RULE_NAME;
      const update = await h.agent.put(`${base}/drafts/${fork.body.id}`).send({ revision: fork.body.revision, content: updatedContent }); assert.equal(update.status, 200, JSON.stringify(update.body));
      updatedVersion = await publish(fork.body.id, update.body.revision);
    }
    const usage = { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100, prompt_tokens_details: { cached_tokens: 0 }, cache_creation_input_tokens: 0 };
    if (body.stream) return new Response([
      { id: "synthetic", model: "gpt-4o", choices: [{ index: 0, delta: { content: "Synthetic response" }, finish_reason: null }] },
      { id: "synthetic", model: "gpt-4o", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      { id: "synthetic", model: "gpt-4o", choices: [], usage },
    ].map(value => `data: ${JSON.stringify(value)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    return new Response(JSON.stringify({ id: "synthetic", model: "gpt-4o", choices: [{ index: 0, message: { role: "assistant", content: "Synthetic response" }, finish_reason: "stop" }], usage }), { headers: { "content-type": "application/json" } });
  });
  for (const label of ["original", "new"]) {
    const response = await h.agent.post("/v1/chat/completions").set("Authorization", `Bearer ${API_KEY}`).send({ model: "gpt-4o", stream, max_tokens: 100, messages: [{ role: "user", content: "Synthetic named rule " + label }] });
    assert.equal(response.status, 200, response.text); await h.app.get(PricingRuntimeService).waitForRequests();
  }
  const logs = await h.app.get(DataSource).query("SELECT id,request_id,cost_usd FROM call_logs ORDER BY id") as Array<{ id: number; request_id: string; cost_usd: number }>;
  assert.equal(logs.length, 2);
  const results: CostLedgerSummary[] = [];
  for (const log of logs) { const r = await h.agent.get(`/api/dashboard/logs/${log.id}/cost-breakdown`); assert.equal(r.status, 200); results.push(r.body as CostLedgerSummary); }
  const exported = await h.agent.get(`${base}/books/${bookId}/export`).query({ version_id: originalVersion }); assert.equal(exported.status, 200);
  const imported = await h.agent.post(base + "/import/validate").send(exported.body); assert.equal(imported.status, 201, JSON.stringify(imported.body));
  const replay = await h.agent.post(base + "/replay").send({ request_ids: [logs[0].request_id], book_id: bookId, version_id: updatedVersion }); assert.equal(replay.status, 201);
  const unchanged = await h.agent.get(`/api/dashboard/logs/${logs[0].id}/cost-breakdown`); assert.equal(unchanged.status, 200);
  return { bookId, originalVersion, updatedVersion, originalContent: content, updatedContent: updatedContent!, originalQuote, updatedQuote: await quote(updatedVersion), first: results[0], second: results[1], logs,
    exported: exported.body as { format: string; content: PriceBookContent }, imported: imported.body as { content: PriceBookContent }, replay: replay.body as { historical_records_modified: boolean; results: Array<{ simulations: Array<{ original: CostComputation; simulated: CostComputation }> }> }, unchanged: unchanged.body as CostLedgerSummary, providerCalls: h.fetchMock.calls.length };
}

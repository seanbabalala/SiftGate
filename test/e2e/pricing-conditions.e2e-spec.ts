import { DataSource } from "typeorm";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as yaml from "js-yaml";
import { createE2EHarness, type E2EHarness, FIXTURE_PATH, API_KEY } from "./setup";
import { applyPricingSchema, PRICING_TABLE_NAMES } from "../../src/pricing/pricing-schema";
import { PricingRecoveryService } from "../../src/pricing/pricing-recovery.service";
import { PricingRuntimeService } from "../../src/pricing/pricing-runtime.service";
import { CostLedgerService } from "../../src/pricing/cost-ledger.service";
import { CONDITION_CASES, CONDITION_PUBLICATION_INSTANT, conditionBook, conditionContext, conditionEvidence, conditionResponse, installConditionClock } from "./pricing-conditions-fixtures";

describe("CALC-05–09 full HTTP conditions with a process-local synthetic Date and mocked supplier", () => {
  let h: E2EHarness, db: DataSource, directory: string, clock: ReturnType<typeof installConditionClock>;
  const base = "/api/dashboard/pricing";
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "pricing-conditions-"));
    const config = yaml.load(readFileSync(FIXTURE_PATH, "utf8")) as Record<string, unknown>;
    config.cache = { enabled: false };
    config.semantic_cache = { enabled: false };
    config.budget = { daily_token_limit: 10000000, daily_cost_limit: 1000, alert_threshold: 0.8 };
    (config.routing as Record<string, unknown>).retry = { max_retries: 0 };
    const file = join(directory, "gateway.yaml");
    writeFileSync(file, yaml.dump(config));
    h = await createE2EHarness(file);
    await h.app.get(PricingRecoveryService).onModuleDestroy();
    db = h.app.get(DataSource);
    await applyPricingSchema(db);
    clock = installConditionClock();
  }, 30000);
  afterEach(async () => {
    try { await h?.close(); }
    finally { clock?.restore(); if (directory) rmSync(directory, { recursive: true, force: true }); }
  });
  async function snapshot() {
    const rows: Record<string, unknown> = {};
    for (const name of [...PRICING_TABLE_NAMES, "budget_rules", "call_logs"])
      rows[name] = await db.query(`SELECT * FROM ${name}`);
    return rows;
  }
  it.each(CONDITION_CASES.flatMap(test => [false, true].map(stream => ({ ...test, stream }))))("$id stream=$stream matches the pinned quote, receipt and immutable selection reason", async test => {
    const content = conditionBook(test.book);
    const created = await h.agent.post(`${base}/books`).send({ name: `Synthetic ${test.id}`, content });
    expect(created.status).toBe(201);
    const published = await h.agent.post(`${base}/drafts/${created.body.draft.id}/publish`).send({ draft_revision: 1, catalog_revision: 0, effective_from: CONDITION_PUBLICATION_INSTANT, confirm: true, reason: "Synthetic fixture only", targets: [{ level: "model", model: "gpt-4o" }] });
    expect(published.status).toBe(201);
    clock.set(test.instant);
    const before = await snapshot();
    const quoted = await h.agent.post(`${base}/quote`).send({ book_id: created.body.book.id, version_id: published.body.version_id, evidence: conditionEvidence(), context: conditionContext(test) });
    expect(quoted.status).toBe(201);
    expect(quoted.body.cost.amount).toBe(test.expected);
    expect(await snapshot()).toEqual(before);
    expect(h.fetchMock.calls).toHaveLength(0);
    h.fetchMock.setHandler(async (_url, init) => {
      expect(JSON.parse(String(init.body)).service_tier).toBe(test.requestedTier);
      return conditionResponse(test, test.stream);
    });
    const response = await h.agent.post("/v1/chat/completions").set("Authorization", `Bearer ${API_KEY}`).send({ model: "gpt-4o", max_tokens: 1000, service_tier: test.requestedTier, stream: test.stream, messages: [{ role: "user", content: "Synthetic conditions fixture" }] });
    expect(response.status).toBe(200);
    await h.app.get(PricingRuntimeService).waitForRequests();
    expect(h.fetchMock.calls).toHaveLength(1);
    const log = await h.callLogRepo.findOne({ where: {}, order: { id: "DESC" } });
    const summary = (await h.app.get(CostLedgerService).summary(log!.request_id!, "default-workspace"))!;
    expect(summary.attempts).toHaveLength(1);
    const actual = summary.attempts[0].cost!;
    expect(actual.amount).toBe(test.expected);
    expect(actual.report_amount).toBe(quoted.body.cost.report_amount);
    expect(actual.version_id).toBe(published.body.version_id);
    expect(actual.content_hash).toBe(quoted.body.cost.content_hash);
    expect(actual.selected_rule_ids).toEqual(quoted.body.cost.selected_rule_ids);
    expect(actual.selection).toEqual(quoted.body.cost.selection);
    expect(actual.selection).toMatchObject({ requested_service_tier: test.requestedTier, resolved_service_tier: test.resolvedTier, effective_service_tier: test.resolvedTier, service_tier_basis: "resolved" });
    if (test.expected !== null) {
      expect(summary.amount).toBe(`${test.expected}000000000`);
      expect(summary.budget_committed_usd).toBe(summary.amount);
      expect(actual.status).toBe(test.expected === "0.000000000" ? "free" : "priced");
    } else {
      expect(summary.amount).toBeNull();
      expect(actual.status).toBe("unpriced");
      expect(actual.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: "pricing_unknown_variant" })]));
      expect(actual.status).not.toBe("free");
    }
    if (test.expectedRule) expect(actual.selected_rule_ids).toContain(test.expectedRule);
    if (test.calendar) {
      expect(actual.selection!.calendar_match).toMatchObject({ ...test.calendar, instant: new Date(test.instant).toISOString(), version_id: content.calendar!.version_id, time_zone: content.calendar!.time_zone, tzdb_version: content.calendar!.tzdb_version });
      expect(actual.selection!.evaluations.filter(rule => rule.selected && rule.group_id === "calendar")).toHaveLength(1);
    }
    const retained = await snapshot();
    const replay = await h.agent.post(`${base}/replay`).send({ request_ids: [summary.request_id], content });
    expect(replay.status).toBe(201);
    expect(replay.body.results[0].simulations[0].simulated.amount).toBe(actual.amount);
    expect(replay.body.results[0].simulations[0].simulated.selection).toEqual(actual.selection);
    expect(await snapshot()).toEqual(retained);
    expect(h.fetchMock.calls).toHaveLength(1);
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DataSource } from "typeorm";
import { createRuleNameHarness, runRuleNameScenario, ORIGINAL_RULE_NAME, UPDATED_RULE_NAME } from "../helpers/pricing-rule-name-fixture";
import type { E2EHarness } from "./setup";
import { tokenBook } from "../unit/pricing-fixtures";

describe("named rules retain immutable identity through actual HTTP pricing", () => {
  let h: E2EHarness, directory: string;
  beforeEach(async () => { directory = mkdtempSync(join(tmpdir(), "pricing-rule-name-")); h = await createRuleNameHarness(directory); });
  afterEach(async () => { await h?.close(); if (directory) rmSync(directory, { recursive: true, force: true }); });
  it.each([false, true])("freezes names during publication in flight and preserves export/replay/history (stream=%s)", async stream => {
    const result = await runRuleNameScenario(h, stream);
    expect(result.providerCalls).toBe(2);
    for (const [summary, quoted, name, version] of [[result.first, result.originalQuote, ORIGINAL_RULE_NAME, result.originalVersion], [result.second, result.updatedQuote, UPDATED_RULE_NAME, result.updatedVersion]] as const) {
      expect(summary.amount).toBe("0.001200000000000000"); expect(summary.budget_committed_usd).toBe(summary.amount);
      expect(summary.attempts[0].cost).toMatchObject({ version_id: version, amount: quoted.amount, selected_rule_ids: ["base-rate"], selection: { evaluations: [{ rule_id: "base-rate", rule_name: name, selected: true }] } });
      expect(summary.attempts[0].cost?.selection).toEqual(quoted.selection);
    }
    expect(result.first.attempts[0].cost?.content_hash).not.toBe(result.second.attempts[0].cost?.content_hash);
    expect(result.exported.content.groups[0].rules[0].name).toBe(ORIGINAL_RULE_NAME);
    expect(result.imported.content.groups[0].rules[0].name).toBe(ORIGINAL_RULE_NAME);
    expect(result.replay.historical_records_modified).toBe(false);
    expect(result.replay.results[0].simulations[0].original.selection!.evaluations[0].rule_name).toBe(ORIGINAL_RULE_NAME);
    expect(result.replay.results[0].simulations[0].simulated.selection!.evaluations[0].rule_name).toBe(UPDATED_RULE_NAME);
    expect(result.unchanged).toEqual(result.first);
    const before = await h.app.get(DataSource).query("SELECT * FROM pricing_attempts ORDER BY id");
    const head = (await h.agent.get("/api/dashboard/pricing/bindings")).body.head;
    const rollback = await h.agent.post(`/api/dashboard/pricing/books/${result.bookId}/rollback`).send({ version_id: result.originalVersion, catalog_revision: head.revision, reason: "Synthetic rollback", confirm: true, targets: [{ level: "model", model: "gpt-4o", operation: "chat_completions" }] });
    expect(rollback.status).toBe(201);
    const version = await h.agent.get(`/api/dashboard/pricing/books/${result.bookId}/versions/${rollback.body.version_id}`);
    expect(version.body.content.groups[0].rules[0]).toMatchObject({ id: "base-rate", name: ORIGINAL_RULE_NAME });
    expect(await h.app.get(DataSource).query("SELECT * FROM pricing_attempts ORDER BY id")).toEqual(before);
  });
  it("rejects invalid names without creating a book or silently dropping metadata", async () => {
    for (const name of ["", " ", "name\ncontrol", "x".repeat(129), null]) {
      const content = tokenBook(); Object.assign(content.groups[0].rules[0], { name });
      const response = await h.agent.post("/api/dashboard/pricing/books").send({ name: "Synthetic invalid", content });
      expect(response.status).toBe(400);
      expect(await h.app.get(DataSource).query("SELECT * FROM pricing_books")).toHaveLength(0);
    }
    expect(h.fetchMock.calls).toHaveLength(0);
  });
});

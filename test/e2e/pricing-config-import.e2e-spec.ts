import { DataSource } from "typeorm";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load, dump } from "js-yaml";
import { createE2EHarness, type E2EHarness, FIXTURE_PATH } from "./setup";
import { ConfigService } from "../../src/config/config.service";
import { PricingRecoveryService } from "../../src/pricing/pricing-recovery.service";
import { applyPricingSchema, PRICING_TABLE_NAMES } from "../../src/pricing/pricing-schema";
import { PricingRepository } from "../../src/pricing/pricing-repository";
import { WorkspaceMembershipService } from "../../src/auth/workspace-membership.service";
import { legacyNumberToDecimal } from "../../src/pricing/legacy-pricing-adapter";
import { pricingContentHash } from "../../src/pricing/pricing-json";
import { planPricingConfigImport } from "../../src/pricing/pricing-config-import";
import type { PricingConfigImportPlan } from "../../src/pricing/pricing-config-import.types";
import type { GatewayConfig } from "../../src/config/gateway.config";
import { pricingConfigImportFixture } from "../helpers/pricing-config-import-fixture";

const url = "/api/dashboard/pricing/import/validate", at = "2026-09-29T00:00:00Z";
describe("whole legacy gateway pricing import on isolated authenticated HTTP", () => {
  let h: E2EHarness, dir: string, file: string, input: ReturnType<typeof pricingConfigImportFixture>, config: GatewayConfig;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "pricing-config-import-http-")); input = pricingConfigImportFixture();
    for (const model of ["@cf/provider/model", "模型-v1", "model@revision", "sk-small"]) {
      Object.assign(input.models_pricing, { [model]: { input: 1, output: 2 } }); input.nodes[0].models.push(model);
    }
    const baseline = load(readFileSync(FIXTURE_PATH, "utf8")) as GatewayConfig;
    config = { ...baseline, models_pricing: { ...baseline.models_pricing, ...input.models_pricing } };
    // Add safe synthetic routing-independent nodes so ConfigService's real resolver
    // sees both inherited sources and explicit overrides. No provider is contacted.
    config.nodes.push(...input.nodes.map(node => ({ name: node.id, endpoint: "/v1/chat/completions", timeout_ms: 1000, ...node, base_url: "http://127.0.0.1:9", api_key: node.api_key || "synthetic-fixture-only" } as GatewayConfig["nodes"][number])));
    file = join(dir, "config.yaml"); writeFileSync(file, dump(config)); h = await createE2EHarness(file);
    await h.app.get(PricingRecoveryService).onModuleDestroy(); await applyPricingSchema(h.app.get(DataSource));
  });
  afterEach(async () => { await h?.close(); rmSync(dir, { recursive: true, force: true }); });
  async function state() { const data: Record<string, unknown> = {}; for (const table of [...PRICING_TABLE_NAMES, "budget_rules", "call_logs"]) data[table] = await h.app.get(DataSource).query(`SELECT * FROM ${table}`); return data; }
  it("matches the actual configured resolver across node contexts while preserving all state and input bytes", async () => {
    const original = readFileSync(file), before = await state(), version = h.app.get(ConfigService).getSnapshot().version;
    const response = await h.agent.post(url).send({ format: "legacy-gateway-config", content: input, evaluated_at: at });
    expect(response.status === 201 ? 201 : response.body).toBe(201); const result = response.body as PricingConfigImportPlan;
    expect(result).toMatchObject(planPricingConfigImport(input, { evaluated_at: at }));
    for (const row of result.entries.filter(row => row.target.node_id && row.token_draft)) {
      const price = h.app.get(ConfigService).getModelPricing(row.target.model, row.target.node_id)!;
      expect(row.effective_legacy?.input).toBe(legacyNumberToDecimal(price.input)); expect(row.effective_legacy?.output).toBe(legacyNumberToDecimal(price.output));
      expect(row.effective_legacy?.cache_read_input).toBe(price.cache_read_input === undefined ? undefined : legacyNumberToDecimal(price.cache_read_input));
      expect(row.effective_legacy?.cache_creation_input).toBe(price.cache_creation_input === undefined ? undefined : legacyNumberToDecimal(price.cache_creation_input));
    }
    expect(await state()).toEqual(before); expect(readFileSync(file)).toEqual(original); expect(h.app.get(ConfigService).getSnapshot().version).toBe(version); expect(h.fetchMock.calls).toHaveLength(0);
    expect(JSON.stringify(response.body)).not.toContain("synthetic-private-provider-key");
  });
  it("keeps imported estimates as unsaved drafts and does not treat source provenance as publication approval", async () => {
    const before = await state();
    const response = await h.agent.post(url).send({ format: "legacy-gateway-config", content: input, evaluated_at: at });
    expect(response.status).toBe(201); const plan = response.body as PricingConfigImportPlan;
    const draft = plan.entries.find(e => e.target.node_id === "node-b" && e.target.model === "shared")!.token_draft!;
    const quote = await h.agent.post("/api/dashboard/pricing/quote").send({ content: draft.content, evidence: [{ dimension: "total_input_tokens", value: "1000" }, { dimension: "uncached_input_tokens", value: "300" }, { dimension: "cache_read_tokens", value: "500" }, { dimension: "cache_write_tokens", value: "200" }, { dimension: "cache_write_5m_tokens", value: "0" }, { dimension: "cache_write_1h_tokens", value: "0" }, { dimension: "output_tokens", value: "100" }] });
    expect(quote.status === 201 ? 201 : quote.body).toBe(201); expect(quote.body.cost.status).toBe("legacy_estimate");
    expect(quote.body.cost.amount).toBe("0.002500000000000000");
    expect(await state()).toEqual(before); expect((await h.app.get(PricingRepository).listBindings({ id: "dashboard", workspace_id: "default-workspace", role: "admin", global_admin: true })).bindings).toHaveLength(0);
  });
  it("permits a viewer's pure supplied-file preview but rejects invalid inputs without leaking their content", async () => {
    const members = h.app.get(WorkspaceMembershipService);
    await members.ensureMembership({ userId: "backup-admin", workspaceId: "default-workspace", organizationId: "default-org", role: "admin" });
    await members.ensureMembership({ userId: "dashboard", workspaceId: "default-workspace", organizationId: "default-org", role: "viewer" });
    const before = await state();
    const valid = await h.agent.post(url).send({ format: "legacy-gateway-config", content: input, evaluated_at: at }); expect(valid.status).toBe(201);
    const invalid = await h.agent.post(url).send({ format: "legacy-gateway-config", content: { models_pricing: { model: { input: "PRIVATE", output: 1 } } } });
    expect(invalid.status).toBe(400); expect(invalid.body.error.code).toBe("pricing_invalid_document"); expect(JSON.stringify(invalid.body)).not.toContain("PRIVATE");
    expect(await state()).toEqual(before);
    const { plan_hash, valid: _valid, ...body } = valid.body; expect(pricingContentHash(body)).toBe(plan_hash); expect(h.fetchMock.calls).toHaveLength(0);
  });
});

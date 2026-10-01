import { planPricingConfigImport } from "../../src/pricing/pricing-config-import";
import { checkImportDocument, PricingConfigImportError } from "../../src/pricing/pricing-config-import-input";
import { pricingContentHash } from "../../src/pricing/pricing-json";
import { pricingConfigImportFixture, pricingCatalogImportFixture } from "../helpers/pricing-config-import-fixture";
import { quote, tokens } from "./pricing-fixtures";

const at = "2026-09-29T00:00:00Z";
const run = (config: unknown, catalog?: unknown) => planPricingConfigImport(config, { catalog, evaluated_at: at });
describe("whole gateway legacy pricing import planning", () => {
  it.each(["@cf/provider/model", "模型-v1", "model@revision", "sk-small"])("preserves the existing opaque model identifier %s", model => {
    const input = { models_pricing: { [model]: { input: 1, output: 2 } }, nodes: [{ id: "synthetic", protocol: "chat_completions", models: [model], model_aliases: { "简称": model } }] };
    const result = run(input), child = result.entries.find(e => e.target.node_id)!;
    expect(child.target.model).toBe(model); expect(child.inherits).toEqual({ kind: "gateway_config", model }); expect(child.aliases).toEqual(["简称"]);
    expect(child.declared?.input).toBe("1"); expect(child.token_draft?.content.source.kind).toBe("legacy");
  });
  it("preserves node override/inherited scope, alias context, hidden prices and exact cache differences without mutating input", () => {
    const input = pricingConfigImportFixture(), original = structuredClone(input), result = run(input);
    expect(input).toEqual(original); expect(run(input)).toEqual(result);
    const row = (node?: string) => result.entries.find(e => e.target.model === "shared" && e.target.node_id === node)!;
    expect(row().selected_source.kind).toBe("gateway_config"); expect(row().differences.map(d => d.after)).toEqual(["2.5", "2.5"]);
    expect(row("node-a").inherits).toEqual({ kind: "gateway_config", model: "shared" });
    expect(row("node-a").aliases).toEqual(["short"]); expect(row("node-a").effective_legacy?.cache_read_input).toBe("0.25");
    expect(row("node-b").effective_legacy).toMatchObject({ cache_read_input: "0.25", cache_creation_input: "3.125" });
    expect(row("override").selected_source).toEqual({ kind: "node_model_config", model: "shared", node_id: "override" });
    expect(row("override").effective_legacy).toMatchObject({ input: "3", output: "6", cache_read_input: "0.2", cache_creation_input: "1.5" });
    const hidden = result.entries.find(e => e.target.model === "hidden")!;
    expect(hidden.effective_legacy).toMatchObject({ input: "0", cache_read_per_1m_tokens: "0", cache_write_per_1m_tokens: "0" });
    expect(hidden.token_draft?.content.groups[0].rules[0].rates.find(r => r.component.dimension === "uncached_input_tokens")!.component.free).toBe(true);
    expect(hidden.media_references).toEqual([{ field: "image_per_generation", value: "0.04", metering_verified: false }]);
    expect(result.complete_source_resolution).toBe(false);
    expect(result.entries.find(e => e.target.model === "live-model")!.diagnostics).toContainEqual({ code: "external_catalog_unresolved", path: "selected_pricing" });
    const { plan_hash, ...body } = result; expect(pricingContentHash(body)).toBe(plan_hash);
  });
  it("keeps synthetic media references unapproved and preserves source/currency without pretending legacy USD is CNY", () => {
    const result = run(pricingConfigImportFixture()), foreign = result.entries.find(e => e.target.model === "foreign")!;
    expect(foreign.token_draft).toMatchObject({ legacy_currency: "USD", declared_currency: "CNY", publish_requires_review: true, content: { currency: "CNY", source: { kind: "legacy" } } });
    expect(foreign.diagnostics.some(d => d.code === "legacy_currency_mismatch")).toBe(true);
    const shared = result.entries.find(e => e.target.model === "shared")!;
    expect(shared.declared).toMatchObject({ pricing_confidence: "low", manual_review_required: true, source_type: "operator_override", source_url: "https://example.invalid/prices" });
    expect(shared.media_references).toEqual([{ field: "video_per_second", value: "0.1", metering_verified: false }]);
    const serialized = JSON.stringify(result);
    for (const value of ["synthetic-private-provider-key", "synthetic-private-gateway-key", "DO-NOT-OPEN", "NEVER EXECUTE", "private.invalid", "user:password", "token=secret"]) expect(serialized).not.toContain(value);
    expect(result).toMatchObject({ dry_run: true, database_access: false, modifies_files: false, activates_prices: false, secrets_resolved: false });
  });
  it("resolves only a supplied catalog using existing provider matching, preserves missing media-only token prices", () => {
    const config = pricingConfigImportFixture(), catalog = pricingCatalogImportFixture(), original = structuredClone(catalog), result = run(config, catalog);
    const entry = result.entries.find(e => e.target.model === "catalog-model")!;
    expect(entry.selected_source).toMatchObject({ kind: "catalog_snapshot", provider_id: "node-a" });
    expect(entry.effective_legacy).toMatchObject({ input: "1", output: "2", cache_read_input: "0.5", pricing_stale: false });
    expect(entry.token_draft?.content.source.kind).toBe("legacy");
    const media = result.entries.find(e => e.target.model === "live-model")!;
    expect(media.selected_source.kind).toBe("catalog_snapshot"); expect(media.token_draft).toBeNull();
    expect(media.media_references).toEqual([{ field: "realtime_per_minute", value: "0.12", metering_verified: false }]);
    expect(media.diagnostics.some(d => d.code === "missing_token_price")).toBe(true);
    expect(result.complete_source_resolution).toBe(true); expect(catalog).toEqual(original);
    expect(run(config, catalog)).toEqual(result);
  });
  it("computes draft legacy fees with inherited cache inference and retains decimal/exponent values exactly", () => {
    const config = pricingConfigImportFixture(); config.models_pricing.shared.input = 0.0000004;
    const result = run(config), value = result.entries.find(e => e.target.model === "shared" && e.target.node_id === "node-b")!;
    expect(value.declared?.input).toBe("0.0000004"); expect(value.effective_legacy?.cache_read_input).toBe("0");
    // The deployed six-place JS rounding also rounds this binary half-boundary
    // write price to zero. A migration preview must disclose, not silently fix it.
    expect(value.effective_legacy?.cache_creation_input).toBe("0");
    const cost = quote(value.token_draft!.content, tokens({ input_tokens: 1000, output_tokens: 0, cache_read_input_tokens: 500, cache_creation_input_tokens: 200 }));
    expect(cost.status).toBe("legacy_estimate"); expect(cost.amount).toBe("0.000000000120000000");
  });
  it.each([-1, NaN, Infinity, "1", Number.MAX_SAFE_INTEGER + 1])("rejects invalid price %p rather than coercing or overflowing", input => {
    expect(() => run({ models_pricing: { model: { input, output: 1 } } })).toThrow(PricingConfigImportError);
  });
  it("does not emit unknown pricing payloads or resolve environment references", () => {
    const result = run({ database: { url: "${DATABASE_URL}" }, models_pricing: { model: { input: 1, output: 2, source: "${env:PRICE_SOURCE}", unsupported_rule: { secret: "PRIVATE" } } } });
    const value = JSON.stringify(result); expect(value).not.toContain("PRIVATE"); expect(value).not.toContain("PRICE_SOURCE");
    expect(result.entries[0].diagnostics.some(d => d.code === "field_not_migrated")).toBe(true);
  });
  it.each(['https://price.internal./private', 'https://price.local./private', 'https://LOCALHOST./private'])("omits a DNS-root-dot internal source from import provenance: %s", source_url => {
    const result = run({ models_pricing: { model: { input: 1, output: 2, source_url, source: `Contract ${source_url}` } } });
    expect(JSON.stringify(result)).not.toContain(source_url);
    expect(result.entries[0].declared?.source).toBe('Contract [redacted URL]');
  });
  it("redacts configured opaque tokens even when copied into source provenance", () => {
    const result = run({ control_plane: { registration_token: "opaque-fixture-token" }, models_pricing: { model: { input: 1, output: 2, source: "Contract opaque-fixture-token" } } });
    expect(result.entries[0].declared?.source).toBe("Contract [redacted]"); expect(JSON.stringify(result)).not.toContain("opaque-fixture-token");
  });
  it("keeps media-only configured pricing visible without fabricating token defaults or usage", () => {
    const result = run({ models_pricing: { media: { video_per_second: 0.1, source: "Synthetic", currency: "USD" } } });
    expect(result.entries[0].token_draft).toBeNull(); expect(result.entries[0].effective_legacy).not.toHaveProperty("input");
    expect(result.entries[0].media_references).toEqual([{ field: "video_per_second", value: "0.1", metering_verified: false }]);
  });
  it("bounds aliased input graphs, refuses cycles/prototypes and never invokes getters", () => {
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    expect(() => run(cycle)).toThrow(PricingConfigImportError);
    expect(() => run(JSON.parse('{"models_pricing":{"__proto__":{"input":1,"output":1}}}'))).toThrow(PricingConfigImportError);
    const getter = jest.fn(() => "PRIVATE"), input = Object.defineProperty({}, "secret", { enumerable: true, get: getter });
    expect(() => checkImportDocument(input)).toThrow(PricingConfigImportError); expect(getter).not.toHaveBeenCalled();
    let graph: unknown = { input: 1, output: 2 }; for (let i = 0; i < 17; i++) graph = [graph, graph];
    expect(() => run(graph)).toThrow(PricingConfigImportError);
  });
  it("refuses control characters, URLs and credentials in identities instead of changing or exposing them", () => {
    for (const model of ["line\nmodel", "https://user:password@example.invalid/model", "sk-" + "a".repeat(30)])
      expect(() => run({ models_pricing: { [model]: { input: 1, output: 2 } } })).toThrow(PricingConfigImportError);
    expect(() => run({ auth: { api_key: "opaque-fixture-secret" }, models_pricing: { "opaque-fixture-secret": { input: 1, output: 2 } } })).toThrow("pricing_import_sensitive_identifier");
  });
});

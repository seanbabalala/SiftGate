import { selectConfiguredLegacyPricing, withLegacyCachePricing, type LegacyPricingNode } from "../../src/config/legacy-pricing-resolution";
import type { ModelPricing } from "../../src/config/gateway.config";

describe("legacy-only configured pricing resolution", () => {
  const pricing: ModelPricing = { input: 2.5, output: 10 };
  const node = (overrides: Partial<LegacyPricingNode> = {}): LegacyPricingNode => ({ id: "synthetic", protocol: "chat_completions", ...overrides });
  it.each([
    { model: "plain", node: undefined, read: undefined, write: undefined },
    { model: "gpt-example", node: undefined, read: 0.25, write: undefined },
    { model: "o3-example", node: undefined, read: 0.25, write: undefined },
    { model: "claude-example", node: undefined, read: 0.25, write: 3.125 },
    { model: "plain", node: node({ protocol: "messages" }), read: 0.25, write: 3.125 },
    { model: "plain", node: node({ compatibility_profile: ["custom-anthropic"] }), read: 0.25, write: 3.125 },
    { model: "plain", node: node({ compatibility_profile: "custom-openai" }), read: 0.25, write: undefined },
    { model: "alias", node: node({ upstream_model_aliases: { alias: "claude-upstream" } }), read: 0.25, write: 3.125 },
    { model: "alias", node: node({ upstream_model_aliases: { alias: "gpt-upstream" } }), read: 0.25, write: undefined },
  ])("retains contextual legacy inference for $model ($read/$write)", row => {
    const result = withLegacyCachePricing(pricing, row.model, row.node);
    expect(result.cache_read_input).toBe(row.read); expect(result.cache_creation_input).toBe(row.write); expect(pricing).toEqual({ input: 2.5, output: 10 });
  });
  it("never overrides explicit zero or cache alias rates, including mixed fields", () => {
    expect(withLegacyCachePricing({ ...pricing, cache_read_input: 0, cache_creation_input: 0 }, "claude-example")).toEqual({ ...pricing, cache_read_input: 0, cache_creation_input: 0 });
    const aliases = { ...pricing, cache_read_per_1m_tokens: 0, cache_write_per_1m_tokens: 7 };
    expect(withLegacyCachePricing(aliases, "claude-example")).toEqual(aliases);
    expect(withLegacyCachePricing({ ...pricing, cache_read_per_1m_tokens: 0 }, "claude-example")).toMatchObject({ cache_read_input: 0, cache_creation_input: 3.125 });
  });
  it("uses the whole selected node override rather than merging hidden fields from its model parent", () => {
    const models = { model: { input: 1, output: 2, cache_read_input: 0.7, source: "Synthetic parent" } };
    const override = node({ model_capabilities: { model: { pricing: { input: 0, output: 3 } } } });
    expect(selectConfiguredLegacyPricing(models, "model", override)).toEqual({ kind: "node_model_config", pricing: { input: 0, output: 3, source: "config:model_capabilities", pricing_used_from: "node_model_config", currency: "USD" } });
    expect(selectConfiguredLegacyPricing(models, "model", node())?.pricing.cache_read_input).toBe(0.7);
    expect(selectConfiguredLegacyPricing(models, "missing", node())).toBeUndefined();
  });
});

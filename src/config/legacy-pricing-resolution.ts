import type { ModelPricing, NodeConfig } from "./gateway.config";

/** Only the legacy compatibility formula uses model/profile cache inference. */
export type LegacyPricingNode = Pick<NodeConfig, "id" | "protocol" | "compatibility_profile" | "upstream_model_aliases" | "model_capabilities">;
export interface LegacyPricingSelection {
  kind: "node_model_config" | "gateway_config";
  pricing: ModelPricing;
}

export function selectConfiguredLegacyPricing(
  models: Record<string, ModelPricing>, model: string, node?: LegacyPricingNode,
): LegacyPricingSelection | undefined {
  const nodePricing = node?.model_capabilities?.[model]?.pricing;
  if (nodePricing) return { kind: "node_model_config", pricing: { ...nodePricing,
    source: nodePricing.source || "config:model_capabilities", pricing_used_from: "node_model_config", currency: nodePricing.currency || "USD" } };
  const configured = models[model];
  return configured ? { kind: "gateway_config", pricing: { ...configured,
    source: configured.source || "config:models_pricing", pricing_used_from: "gateway_config", currency: configured.currency || "USD" } } : undefined;
}

/** Preserve the existing six-decimal legacy rounding, including explicit zero and alias precedence. */
export function withLegacyCachePricing<T extends ModelPricing>(pricing: T, model: string, node?: LegacyPricingNode): T {
  const read = pricing.cache_read_input ?? pricing.cache_read_per_1m_tokens;
  const write = pricing.cache_creation_input ?? pricing.cache_write_per_1m_tokens;
  const normalized = `${model || ""}`.trim().toLowerCase();
  const upstream = `${node?.upstream_model_aliases?.[model] || ""}`.trim().toLowerCase();
  const profiles = Array.isArray(node?.compatibility_profile) ? node.compatibility_profile : node?.compatibility_profile ? [node.compatibility_profile] : [];
  if (normalized.startsWith("claude-") || profiles.some(profile => `${profile}`.includes("anthropic")) || node?.protocol === "messages" || upstream.startsWith("claude-")) {
    if (read !== undefined && write !== undefined) return pricing;
    return { ...pricing, cache_read_input: read ?? Number((pricing.input * 0.1).toFixed(6)), cache_creation_input: write ?? Number((pricing.input * 1.25).toFixed(6)) };
  }
  if (read === undefined && (normalized.startsWith("gpt-") || normalized.startsWith("o1") || normalized.startsWith("o3") || normalized.startsWith("o4") ||
    profiles.some(profile => `${profile}`.includes("openai")) || upstream.startsWith("gpt-")))
    return { ...pricing, cache_read_input: Number((pricing.input * 0.1).toFixed(6)) };
  return pricing;
}

/** Synthetic only: never load deployed configuration or private catalog prices. */
export function pricingConfigImportFixture() {
  return {
    server: { port: 2099 }, database: { path: "DO-NOT-OPEN.sqlite" },
    auth: { api_keys: ["synthetic-private-gateway-key"] },
    models_pricing: {
      shared: { input: 2.5, output: 10, video_per_second: 0.1, source: "Synthetic contract synthetic-private-provider-key", source_url: "https://user:password@example.invalid/prices?token=secret#fragment", currency: "USD", source_type: "operator_override", pricing_confidence: "low", manual_review_required: true, last_updated: "2026-09-01T00:00:00Z" },
      foreign: { input: 7, output: 14, currency: "CNY" },
    },
    nodes: [
      { id: "node-a", protocol: "chat_completions", compatibility_profile: "openai", base_url: "https://provider.invalid/v1", api_key: "synthetic-private-provider-key", models: ["shared", "catalog-model"], realtime_models: ["live-model"], upstream_model_aliases: { "live-model": "gpt-realtime-synthetic" }, model_aliases: { short: "shared" }, model_capabilities: { hidden: { supports_reasoning: true, pricing: { input: 0, output: 4, cache_read_per_1m_tokens: 0, cache_write_per_1m_tokens: 0, image_per_generation: 0.04 } } } },
      { id: "node-b", protocol: "messages", models: ["shared"] },
      { id: "override", protocol: "chat_completions", models: ["shared"], model_capabilities: { shared: { pricing: { input: 3, output: 6, cache_read_input: 0.2, cache_creation_input: 1.5 } } } },
    ],
    telemetry: { endpoint: "https://private.invalid/collect" }, plugins: [{ code: "NEVER EXECUTE THIS" }],
  };
}
export function pricingCatalogImportFixture() {
  return { version: 1, providers: [
    { id: "fallback-provider", models: [{ id: "catalog-model", modalities: ["text"], source: "builtin", pricing: { input: 99, output: 99, source: "Synthetic fallback", last_updated: "2026-09-01", manual_review_required: true } }] },
    { id: "node-a", aliases: ["matching-alias"], base_url: "https://provider.invalid/v1", models: [
      { id: "catalog-model", modalities: ["text"], source: "override", pricing: { input_per_1m_tokens: 1, output_per_1m_tokens: 2, cache_read_per_1m_tokens: 0.5, source: "Synthetic catalog", source_type: "operator_override", source_url: "https://example.invalid/catalog", last_updated: "2026-09-01", manual_review_required: true } },
      { id: "live-model", modalities: ["realtime"], pricing: { realtime_per_minute: 0.12, source: "Synthetic media", last_updated: "2026-09-01", manual_review_required: true } },
    ] },
  ] };
}

import type { ModelPricing, NodeConfig } from "../config/gateway.config";
import { selectConfiguredLegacyPricing, withLegacyCachePricing, type LegacyPricingNode } from "../config/legacy-pricing-resolution";
import { findCatalogModelForNode } from "../catalog/catalog.service";
import { catalogModelToGovernedModelPricing, catalogPricingIsStale, normalizeCatalogPricing } from "../catalog/pricing-governance";
import type { CatalogModel, CatalogPricing, CatalogProvider, ProviderCatalog } from "../catalog/catalog.types";
import { VALID_MODALITIES, type Modality } from "../config/modality";
import { legacyTokenPriceBook, legacyNumberToDecimal } from "./legacy-pricing-adapter";
import { compilePriceBook } from "./pricing-compiler";
import { pricingContentHash } from "./pricing-json";
import { parsePricingInstant } from "./pricing-time";
import { checkImportDocument, failImport, importIdentifier, importList, record, readImportPrice, portableImportPrice, MEDIA_PRICE_NUMBERS } from "./pricing-config-import-input";
import type { PricingConfigImportDiagnostic, PricingConfigImportEntry, PricingConfigImportPlan } from "./pricing-config-import.types";

interface ImportNode extends LegacyPricingNode { models: Set<string>; aliases: Map<string, string[]>; base_url?: string }
const buckets = ["models", "embedding_models", "rerank_models", "image_models", "audio_models", "video_models", "realtime_models", "batch_models"];
const own = (row: Record<string, unknown>, key: string) => Object.hasOwn(row, key) ? row[key] : undefined;
function strings(value: unknown, path: string): string[] { return importList(value, path).map(v => importIdentifier(v, path)); }
function source(value: unknown): "override" | "builtin" | "sync_cache" {
  if (value === undefined) return "override";
  if (!["override", "builtin", "sync_cache"].includes(String(value))) failImport("catalog.source");
  return value as "override" | "builtin" | "sync_cache";
}
function address(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > 2048) failImport(path);
  return value;
}

/** The optional catalog is a supplied resolved snapshot, never a path or ambient catalog lookup. */
function parseCatalog(value: unknown, diagnostics: Map<string, PricingConfigImportDiagnostic[]>): ProviderCatalog {
  const raw = record(value, "catalog"); if (raw.version !== 1) failImport("catalog.version");
  const seen = new Set<string>(); let total = 0;
  const providers = importList(raw.providers, "catalog.providers", 256).map((entry, index): CatalogProvider => {
    const path = `catalog.providers[${index}]`, row = record(entry, path), id = importIdentifier(row.id, path + ".id");
    if (seen.has(id)) failImport(path + ".id"); seen.add(id);
    const models = new Set<string>();
    return { id, name: id, aliases: row.aliases === undefined ? undefined : strings(row.aliases, path + ".aliases"), base_url: address(row.base_url, path + ".base_url") ?? "", auth_type: "none", endpoints: {}, source: source(row.source), overridden: row.overridden === true,
      models: importList(row.models, path + ".models").map((entry, number): CatalogModel => {
        if (++total > 4096) failImport("catalog.models", "pricing_import_capacity_exceeded");
        const at = `${path}.models[${number}]`, model = record(entry, at), name = importIdentifier(model.id, at + ".id");
        if (models.has(name) || model.provider !== undefined && model.provider !== id) failImport(at + ".id"); models.add(name);
        const issues: PricingConfigImportDiagnostic[] = []; diagnostics.set(JSON.stringify([id, name]), issues);
        let pricing: CatalogPricing | undefined;
        if (model.pricing !== undefined) {
          const rawPrice = record(model.pricing, at + ".pricing"), projected = readImportPrice(rawPrice, at + ".pricing", issues, true);
          // Preserve catalog aliases/units used by its existing governed resolver,
          // not just the legacy four-token fields. Every numeric alias is validated.
          const legacy: Partial<CatalogPricing> = {};
          for (const key of ["image", "audio", "video", "rerank", "embedding"] as const) if (rawPrice[key] !== undefined) {
            const v = rawPrice[key]; if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > Number.MAX_SAFE_INTEGER) failImport(at + ".pricing." + key);
            legacy[key] = v;
          }
          if (rawPrice.unit !== undefined) legacy.unit = address(rawPrice.unit, at + ".pricing.unit");
          if (rawPrice.units !== undefined) {
            const units = record(rawPrice.units, at + ".pricing.units"); legacy.units = {};
            for (const [key, unit] of Object.entries(units)) { importIdentifier(key, at + ".pricing.units"); legacy.units[key as keyof typeof legacy.units] = address(unit, at + ".pricing.units"); }
          }
          pricing = { ...projected, ...legacy, source: projected.source ?? "unspecified", last_updated: projected.last_updated ?? "", manual_review_required: projected.manual_review_required ?? true } as CatalogPricing;
        }
        const modalities = model.modalities === undefined ? [] : strings(model.modalities, at + ".modalities");
        if (modalities.some(m => !(VALID_MODALITIES as readonly string[]).includes(m))) failImport(at + ".modalities");
        return { id: name, provider: id, modalities: modalities as Modality[], endpoints: {}, capabilities: [], source: source(model.source ?? row.source), overridden: model.overridden === true, synced: model.synced === true,
          prompt_cache: model.prompt_cache === true, read_cache: model.read_cache === true, write_cache: model.write_cache === true, pricing };
      }),
    };
  });
  return { version: 1, generated_at: "", providers };
}

/** Read-only migration proposal; no activation, request, database, secret resolution or file access. */
export function planPricingConfigImport(value: unknown, options: { catalog?: unknown; evaluated_at: string }): PricingConfigImportPlan {
  const secrets = checkImportDocument(value);
  if (options.catalog !== undefined) for (const secret of checkImportDocument(options.catalog)) secrets.add(secret);
  let evaluated: string;
  try { evaluated = new Date(parsePricingInstant(options.evaluated_at)).toISOString(); } catch { return failImport("evaluated_at"); }
  const root = record(value, "config"), top = record(root.models_pricing ?? {}, "models_pricing"), modelPrices: Record<string, ModelPricing> = Object.create(null);
  const issues = new Map<string, PricingConfigImportDiagnostic[]>();
  const topEntries = Object.entries(top); if (topEntries.length > 4096) failImport("models_pricing", "pricing_import_capacity_exceeded");
  for (const [index, [model, pricing]] of topEntries.entries()) {
    importIdentifier(model, `models_pricing[${index}]`); const diagnostics: PricingConfigImportDiagnostic[] = [];
    modelPrices[model] = readImportPrice(pricing, `models_pricing[${index}]`, diagnostics) as ModelPricing; issues.set(model, diagnostics);
  }
  const nodeIds = new Set<string>();
  const nodes = importList(root.nodes ?? [], "nodes", 256).map((value, index): ImportNode => {
    const path = `nodes[${index}]`, row = record(value, path), id = importIdentifier(row.id, path + ".id");
    if (nodeIds.has(id)) failImport(path + ".id"); nodeIds.add(id);
    const protocol = importIdentifier(row.protocol, path + ".protocol") as NodeConfig["protocol"];
    const node: ImportNode = { id, protocol, models: new Set(), aliases: new Map(), model_capabilities: Object.create(null), upstream_model_aliases: Object.create(null), base_url: address(row.base_url, path + ".base_url") };
    if (row.compatibility_profile !== undefined) node.compatibility_profile = typeof row.compatibility_profile === "string" ? importIdentifier(row.compatibility_profile, path + ".compatibility_profile") : strings(row.compatibility_profile, path + ".compatibility_profile");
    for (const key of buckets) if (row[key] !== undefined) for (const model of strings(row[key], path + "." + key)) node.models.add(model);
    for (const [number, [model, capability]] of Object.entries(record(row.model_capabilities ?? {}, path + ".model_capabilities")).entries()) {
      importIdentifier(model, path + ".model_capabilities"); node.models.add(model);
      const raw = record(capability, path + ".model_capabilities"), at = `${path}.model_capabilities[${number}].pricing`;
      if (own(raw, "pricing") !== undefined) {
        const diagnostics: PricingConfigImportDiagnostic[] = [];
        node.model_capabilities![model] = { pricing: readImportPrice(raw.pricing, at, diagnostics) as ModelPricing }; issues.set(JSON.stringify([id, model]), diagnostics);
      }
    }
    for (const [alias, model] of Object.entries(record(row.model_aliases ?? {}, path + ".model_aliases"))) {
      importIdentifier(alias, path + ".model_aliases"); const name = importIdentifier(model, path + ".model_aliases"); node.models.add(name);
      node.aliases.set(name, [...node.aliases.get(name) ?? [], alias].sort());
    }
    for (const [model, upstream] of Object.entries(record(row.upstream_model_aliases ?? {}, path + ".upstream_model_aliases"))) {
      importIdentifier(model, path + ".upstream_model_aliases"); node.models.add(model); node.upstream_model_aliases![model] = importIdentifier(upstream, path + ".upstream_model_aliases");
    }
    return node;
  });
  const catalogIssues = new Map<string, PricingConfigImportDiagnostic[]>(), catalog = options.catalog === undefined ? undefined : parseCatalog(options.catalog, catalogIssues);
  const entries: PricingConfigImportEntry[] = [];
  function entry(model: string, node?: ImportNode): void {
    if (entries.length >= 8192) failImport("entries", "pricing_import_capacity_exceeded");
    for (const identity of [model, node?.id ?? "", ...node?.aliases.get(model) ?? []])
      if ([...secrets].some(secret => identity.includes(secret))) failImport("identity", "pricing_import_sensitive_identifier");
    const selected = selectConfiguredLegacyPricing(modelPrices, model, node);
    const matched = !selected && catalog ? findCatalogModelForNode(catalog, model, node) : undefined;
    let pricing = selected?.pricing ?? catalogModelToGovernedModelPricing(matched);
    // Freeze freshness in this proposal, rather than having its contents depend
    // on wall time in the existing catalog's convenience conversion helper.
    if (!selected && pricing && matched) pricing = { ...pricing, pricing_stale: catalogPricingIsStale(matched.pricing, new Date(evaluated)) };
    const diagnostics = [...(selected?.kind === "node_model_config" ? issues.get(JSON.stringify([node!.id, model])) : selected ? issues.get(model) : matched ? catalogIssues.get(JSON.stringify([matched.provider, model])) : []) ?? []];
    const target = { model, ...(node ? { node_id: node.id } : {}) };
    const kind = selected?.kind ?? (matched ? "catalog_snapshot" : "unresolved");
    const inherits: PricingConfigImportEntry["inherits"] = node && selected?.kind === "gateway_config" ? { kind: "gateway_config", model } : !selected ? { kind: matched ? "catalog_snapshot" : "external_catalog", model, ...(matched ? { provider_id: matched.provider } : {}) } : null;
    const declaredPrice = selected?.kind === "node_model_config" ? node!.model_capabilities![model].pricing : selected ? modelPrices[model] : matched?.pricing;
    const declared = declaredPrice ? portableImportPrice(readImportPrice(declaredPrice, "selected_pricing", [], Boolean(matched)), secrets, diagnostics, "selected_pricing") : null;
    if (inherits) diagnostics.push({ code: "contextual_inheritance", path: "inherits" });
    const result: PricingConfigImportEntry = { target, selected_source: { kind, model, ...(kind === "node_model_config" ? { node_id: node!.id } : {}), ...(matched ? { provider_id: matched.provider } : {}) }, inherits,
      aliases: node?.aliases.get(model) ?? [], declared, effective_legacy: null, differences: [], token_draft: null, media_references: [], diagnostics };
    const media = pricing ?? (matched ? normalizeCatalogPricing(matched.pricing) : undefined);
    for (const field of MEDIA_PRICE_NUMBERS) {
      const v = media?.[field]; if (typeof v === "number") result.media_references.push({ field, value: legacyNumberToDecimal(v), metering_verified: false });
    }
    if (result.media_references.length) diagnostics.push({ code: "media_requires_review", path: "media_references" });
    if (!pricing) diagnostics.push({ code: matched || catalog ? "missing_token_price" : "external_catalog_unresolved", path: "selected_pricing" });
    else {
      const numeric = typeof pricing.input === "number" && typeof pricing.output === "number";
      const effective = numeric ? withLegacyCachePricing(pricing, model, node) : pricing;
      result.effective_legacy = portableImportPrice(effective, secrets, diagnostics, "effective_legacy");
      if (numeric) {
        for (const field of ["cache_read_input", "cache_creation_input"] as const) {
          const resolved = effective[field] ?? (field === "cache_read_input" ? effective.cache_read_per_1m_tokens : effective.cache_write_per_1m_tokens) ?? effective.input;
          const before = pricing[field];
          if (before !== resolved) result.differences.push({ field, before: before === undefined ? null : legacyNumberToDecimal(before), after: legacyNumberToDecimal(resolved), basis: effective[field] !== pricing[field] ? "legacy_cache_inference" : "legacy_alias_or_input_fallback" });
        }
        if (result.differences.some(d => d.basis === "legacy_cache_inference")) diagnostics.push({ code: "implicit_legacy_cache", path: "differences" });
        const content = legacyTokenPriceBook(effective), currency = effective.currency || "USD";
        content.currency = currency;
        const reference = result.effective_legacy.source_url;
        if (typeof reference === "string") content.source.reference = reference;
        compilePriceBook(content, { book_id: "import-review", version_id: "unpublished" });
        result.token_draft = { format: "siftgate-price-book-v1", content, legacy_currency: "USD", declared_currency: currency, publish_requires_review: true };
        if (currency !== "USD") diagnostics.push({ code: "legacy_currency_mismatch", path: "token_draft.currency" });
      } else diagnostics.push({ code: "missing_token_price", path: "selected_pricing" });
    }
    result.diagnostics = [...new Map(diagnostics.map(d => [JSON.stringify(d), d])).values()]; entries.push(result);
  }
  for (const model of Object.keys(modelPrices).sort()) entry(model);
  for (const node of [...nodes].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) for (const model of [...node.models].sort()) entry(model, node);
  const body = { format: "siftgate-legacy-pricing-plan-v1" as const, schema_version: 1 as const, dry_run: true as const, activates_prices: false as const, modifies_files: false as const, database_access: false as const, secrets_resolved: false as const,
    evaluated_at: evaluated, input_hash: pricingContentHash({ config: value, catalog: options.catalog ?? null }), catalog: catalog ? "explicit_snapshot" as const : "not_provided" as const, entries,
    complete_source_resolution: entries.every(e => e.selected_source.kind !== "unresolved"), requires_review: true as const };
  if (Buffer.byteLength(JSON.stringify(body)) > 16 * 1024 * 1024) failImport("plan", "pricing_import_capacity_exceeded");
  return { ...body, plan_hash: pricingContentHash(body) };
}

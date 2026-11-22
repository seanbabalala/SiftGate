import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const app = readFileSync(
  fileURLToPath(new URL("../src/App.tsx", import.meta.url)),
  "utf8",
);
const sidebar = readFileSync(
  fileURLToPath(
    new URL("../src/lib/navigation.ts", import.meta.url),
  ),
  "utf8",
);
const page = readFileSync(
  fileURLToPath(
    new URL("../src/pages/ProviderCatalogPage.tsx", import.meta.url),
  ),
  "utf8",
);
const nodeForm = readFileSync(
  fileURLToPath(
    new URL("../src/components/nodes/NodeFormModal.tsx", import.meta.url),
  ),
  "utf8",
);
const apiTypes = readFileSync(
  fileURLToPath(new URL("../src/types/api.ts", import.meta.url)),
  "utf8",
);
const enNodes = readFileSync(
  fileURLToPath(new URL("../src/locales/en/nodes.json", import.meta.url)),
  "utf8",
);
const localeFiles = ["en", "zh", "zh-TW", "ja", "ko", "th", "es"].map(
  (locale) => ({
    locale,
    source: readFileSync(
      fileURLToPath(
        new URL(`../src/locales/${locale}/nodes.json`, import.meta.url),
      ),
      "utf8",
    ),
  }),
);

if (!app.includes("ProviderCatalogPage") || !app.includes('path="/catalog"')) {
  throw new Error("Provider Catalog page must be mounted at /catalog.");
}

if (
  !sidebar.includes("labelKey: 'nav.catalog'") ||
  !sidebar.includes("to: '/catalog'")
) {
  throw new Error("Provider Catalog page must be reachable from the sidebar.");
}

for (const expected of [
  "pricing_hygiene",
  "pricing_trust",
  "pricing_trust_summary",
  "aligned_estimate_models",
  "catalogPage.pricingTrust.aligned_estimate",
  "catalogSignals.alignedEstimate",
  "pricing_confidence",
  "stale_after_days",
  "source_url",
  "catalogPage.status.stale",
  "catalogPage.sources.openrouterApi",
  "catalogPage.confidenceLevels.high",
  "catalogPage.refreshSources.title",
  "catalogPage.refreshSources.modes.operator_local",
  "catalogPage.sync.title",
  "catalogPage.sync.status.fresh",
  "sync_status",
  "CatalogSyncStatus",
  "provider_type",
  "CatalogProviderFamily",
  "CatalogProviderType",
  "CatalogCompatibilityProfile",
  "model_buckets",
  "compatibility_profile",
  "logo_id",
  "batch",
  "compatibility_profiles",
  "ProviderCompatibilityProfile",
  "catalogPage.metrics.compatibilityProfiles",
  "provider_visibility",
  "CatalogProviderVisibilitySummary",
  "catalogPage.metrics.activeProviders",
  "catalogPage.metrics.transportOnly",
  "catalogPage.detail.runtimeSupport",
  "catalogPage.detail.hiddenReason",
]) {
  if (
    !page.includes(expected) &&
    !apiTypes.includes(expected) &&
    !enNodes.includes(expected)
  ) {
    throw new Error(
      `Provider Catalog price source status marker missing: ${expected}`,
    );
  }
}

for (const expected of [
  "PROVIDER_FAMILIES",
  "providerFamily(",
  "providerType(",
  "pricingStatus",
  "compatibility",
  "quickFilters",
  "ProviderFamilyGroup",
  "ProviderDetailPanel",
  "model_buckets",
  "hasCanonicalCoverage",
]) {
  if (!page.includes(expected)) {
    throw new Error(`Provider Catalog UX 2.0 marker missing: ${expected}`);
  }
}

for (const expected of [
  "useProviderCatalogProviders({",
  "showLegacy",
  "providerToPreset",
  "recommended_model_buckets",
  "defaultBuckets",
  "PROVIDER_FAMILY_FILTERS",
  "providerFamilyFilter",
  "preset.aliases",
  "max-h-[430px]",
]) {
  if (!nodeForm.includes(expected)) {
    throw new Error(
      `Add Node Wizard catalog-driven picker marker missing: ${expected}`,
    );
  }
}

for (const forbidden of [
  "const PROVIDER_PRESETS",
  "OPENAI_PROVIDER_LIST",
  "ANTHROPIC_PROVIDER_LIST",
]) {
  if (nodeForm.includes(forbidden) || page.includes(forbidden)) {
    throw new Error(
      `Dashboard must not hardcode provider preset lists: ${forbidden}`,
    );
  }
}

for (const expected of [
  "catalogPage.family.foundation",
  "catalogPage.family.aggregators",
  "catalogPage.family.cloud",
  "catalogPage.family.china",
  "catalogPage.family.self_hosted",
  "catalogPage.family.image_video",
  "catalogPage.family.speech_audio",
  "catalogPage.family.embedding_rerank",
  "catalogPage.providerTypes.aggregator",
  "catalogPage.providerTypes.local",
  "catalogPage.compatibility.openai-compatible",
  "catalogPage.filters.pricingStatus",
  "catalogPage.quickFilters.review",
  "form.providerFamilies.china",
  "form.providerTypes.compatible",
]) {
  for (const { locale, source } of localeFiles) {
    if (!source.includes(expected)) {
      throw new Error(
        `${locale}/nodes.json missing Provider Catalog UX key: ${expected}`,
      );
    }
  }
}

if (enNodes.includes("Pricing hygiene")) {
  throw new Error(
    'Provider Catalog page copy should use pricing source/status wording, not "pricing hygiene".',
  );
}

if (
  !nodeForm.includes("useProviderCatalogProviders") ||
  !nodeForm.includes("providerCatalog.data?.providers")
) {
  throw new Error(
    "Add Node wizard must load provider presets from the catalog API.",
  );
}

if (
  nodeForm.includes("const PROVIDER_PRESETS") ||
  nodeForm.includes("PROVIDER_PRESETS =")
) {
  throw new Error(
    "Add Node wizard must not keep a hardcoded provider preset list.",
  );
}

console.log(
  "Open-source Dashboard Provider Catalog source status page validated.",
);

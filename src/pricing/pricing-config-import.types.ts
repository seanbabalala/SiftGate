import type { ModelPricing } from "../config/gateway.config";
import type { PriceBookContent } from "./pricing.types";

export interface PricingConfigImportDiagnostic {
  code: "external_catalog_unresolved" | "missing_token_price" | "implicit_legacy_cache" | "legacy_currency_mismatch" | "media_requires_review" | "metadata_redacted" | "field_not_migrated" | "contextual_inheritance";
  path: string;
}
export interface PricingConfigImportEntry {
  target: { model: string; node_id?: string };
  /** Legacy source precedence, not a published price-book parent reference. */
  selected_source: { kind: "node_model_config" | "gateway_config" | "catalog_snapshot" | "unresolved"; model: string; node_id?: string; provider_id?: string };
  inherits: { kind: "gateway_config" | "catalog_snapshot" | "external_catalog"; model: string; provider_id?: string } | null;
  aliases: string[];
  /** Sanitized metadata; numeric values are decimal strings of the existing JS values. */
  declared: Record<string, string | boolean | string[]> | null;
  effective_legacy: Record<string, string | boolean | string[]> | null;
  differences: Array<{ field: string; before: string | null; after: string; basis: "legacy_cache_inference" | "legacy_alias_or_input_fallback" }>;
  token_draft: { format: "siftgate-price-book-v1"; content: PriceBookContent; legacy_currency: "USD"; declared_currency: string; publish_requires_review: true } | null;
  media_references: Array<{ field: keyof ModelPricing; value: string; metering_verified: false }>;
  diagnostics: PricingConfigImportDiagnostic[];
}
export interface PricingConfigImportPlan {
  format: "siftgate-legacy-pricing-plan-v1";
  schema_version: 1;
  dry_run: true;
  activates_prices: false;
  modifies_files: false;
  database_access: false;
  secrets_resolved: false;
  evaluated_at: string;
  input_hash: string;
  plan_hash: string;
  catalog: "explicit_snapshot" | "not_provided";
  entries: PricingConfigImportEntry[];
  complete_source_resolution: boolean;
  requires_review: true;
}

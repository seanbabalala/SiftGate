import type { PricingBinding } from "./pricing-catalog.types";
import type { PricingHead } from "./pricing-repository.types";
import type { BillableDimension, PricingSource } from "./pricing.types";
import type { PricingAdmissionPolicy } from "./pricing-admission.types";

export interface ModelPricingTarget { node_id: string; model: string; operation: string }
export interface ModelPriceVersion {
  binding: PricingBinding;
  book_name: string;
  content_hash: string;
  currency: string;
  source: PricingSource;
  dimensions: BillableDimension[];
  conditional: boolean;
  review_required: boolean;
  missing_rate_dimensions: BillableDimension[];
  parent: { book_id: string; version_id: string; content_hash: string } | null;
}
export interface ModelPricingStatus {
  target: ModelPricingTarget;
  current: ModelPriceVersion | null;
  scheduled: Array<{ effective_at: string; price: ModelPriceVersion | null }>;
  schedule_truncated: boolean;
  policy: { mode: PricingAdmissionPolicy["mode"]; budget_basis: "legacy_logical" | "actual_upstream" };
  /** Reference metadata only, not proof of active tariff, model support, or runtime expense. */
  legacy_reference: { source: "node_model_config" | "gateway_config" | "catalog"; currency: string | null; review_required: boolean } | null;
}
export interface ModelPricingStatusPage {
  workspace_id: string;
  evaluated_at: string;
  schema_available: boolean;
  read_only: true;
  supplier_support_verified: false;
  head: PricingHead | null;
  rows: ModelPricingStatus[];
}

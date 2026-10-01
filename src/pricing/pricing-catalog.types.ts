import type { CatalogAdmissionPolicy } from "./pricing-admission.types";
import type {
  CostComputation,
  FxSnapshot,
  PriceBookContent,
  PriceBookIdentity,
} from "./pricing.types";

export interface CatalogBookVersion extends PriceBookIdentity {
  workspace_id: string | null;
  content_hash: string;
  content: PriceBookContent;
}

export type PricingBindingLevel = "node" | "model" | "catalog" | "legacy";

export interface PricingBinding extends PriceBookIdentity {
  id: string;
  workspace_id: string | null;
  level: PricingBindingLevel;
  model: string;
  node_id?: string;
  operation?: string;
  effective_from: string;
  effective_to?: string;
}

export interface CatalogFxVersion {
  workspace_id: string | null;
  fx: FxSnapshot;
  effective_to?: string;
}

/** Transport/restore bundle; persistence stores immutable books separately from revision references. */
export interface PricingCatalogDocument {
  schema_version: 1;
  revision_id: string;
  created_at: string;
  books: CatalogBookVersion[];
  bindings: PricingBinding[];
  fx_versions: CatalogFxVersion[];
  admission_policies?: CatalogAdmissionPolicy[];
}

export interface PricingRequestSnapshot {
  schema_version: 1;
  snapshot_id: string;
  catalog_revision_id: string;
  catalog_content_hash: string;
  admitted_at: string;
  workspace_id: string;
  report_currency: string;
}

export interface PricingTarget {
  model: string;
  node_id?: string;
  operation?: string;
}

export interface SnapshotQuote {
  snapshot: PricingRequestSnapshot;
  binding_id: string | null;
  target: PricingTarget;
  cost: CostComputation;
}

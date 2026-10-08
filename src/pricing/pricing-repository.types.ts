import type { PricingAdmissionPolicy } from "./pricing-admission.types";
import type { PricingInheritanceView } from "./pricing-inheritance.types";
import type { PublicationFxStatus } from './publication-fx-review';
import type { TimeBasisConfirmation } from './publication-time-basis';
import type { PriceBookContent } from "./pricing.types";
import type {
  CatalogFxVersion,
  PricingBindingLevel,
} from "./pricing-catalog.types";

export interface PricingActor {
  id: string;
  workspace_id: string;
  role: "viewer" | "operator" | "admin";
  global_admin: boolean;
}

export interface PricingBookRow {
  id: string;
  workspace_id: string | null;
  name: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface PricingDraftRow {
  id: string;
  book_id: string;
  revision: number;
  content_json: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface PricingDraft extends Omit<PricingDraftRow, "content_json"> {
  content: PriceBookContent;
  inheritance?: PricingInheritanceView;
}

export interface PricingVersionRow {
  book_id: string;
  version_id: string;
  content_hash: string;
  content_json: string;
  published_by: string;
  published_at: string;
  reason: string;
}

export interface PricingHead {
  id: string;
  catalog_revision_id: string | null;
  revision: number;
}

export interface PricingPublishTarget {
  level: PricingBindingLevel;
  model: string;
  node_id?: string;
  operation?: string;
}

export interface PricingPublishOptions {
  draft_revision: number;
  catalog_revision: number;
  reason: string;
  confirm: true;
  targets: PricingPublishTarget[];
  /** Bind a reviewed capability assessment to publication, including selected native profiles. */
  metering_assessment_hash?: string;
  /** Optional for existing API clients; catalog/draft revisions fence reviewed FX state. */
  fx_review_status?: PublicationFxStatus;
  /** Required when activating an explicitly configured non-default time basis. */
  time_basis_confirmation?: TimeBasisConfirmation;
  effective_from?: string;
  effective_to?: string;
}

export interface PricingFxUpdate {
  catalog_revision: number;
  reason: string;
  confirm: true;
  versions: Array<Omit<CatalogFxVersion, "workspace_id">>;
  scope: "workspace" | "global";
}

export class PricingRepositoryError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "PricingRepositoryError";
  }
}

export interface PricingAdmissionPolicyUpdate {
  catalog_revision: number;
  reason: string;
  confirm: true;
  scope: "workspace" | "global";
  operation?: string;
  policy: PricingAdmissionPolicy | null;
}

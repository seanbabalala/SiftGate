/** Operational responsibility only; this label never grants access or sends notifications. */
export interface PricingBookOwner {
  book_id: string;
  owner: string | null;
  revision: number;
  updated_by: string | null;
  updated_at: string | null;
}

export interface PricingBookManagement extends PricingBookOwner {
  evaluated_at: string;
  catalog_revision: number;
  lifecycle: {
    state: "draft" | "active" | "scheduled" | "inactive";
    draft_count: number;
    version_count: number;
    active_bindings: number;
    scheduled_bindings: number;
  };
}

export interface PricingBookOwnerUpdate {
  revision: number;
  owner: string | null;
  reason: string;
  confirm: true;
}

/** A counterfactual reference, never a supplier charge or a budget adjustment. */
export interface LocalCacheReference {
  schema_version: 1;
  basis: "frozen_request_logical_estimate";
  state: "estimated" | "unknown" | "invalid_reference";
  report_currency: "USD";
  upstream_cost_usd: string | null;
  reference_cost_usd: string | null;
  hypothetical_savings_usd: string | null;
  logical_input_tokens: string | null;
  logical_output_tokens: string | null;
  book_id: string | null;
  version_id: string | null;
  content_hash: string | null;
  fx_version_id: string | null;
}

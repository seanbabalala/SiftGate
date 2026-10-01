/** Transport-safe recovery metadata. No database schema or ORM dependency. */
export interface PricingRecoveryCaseRow {
  reservation_id: string;
  workspace_id: string;
  request_id: string;
  state: "open" | "resolved";
  reason:
    | "attempt_outcome_unknown"
    | "settlement_decision_missing"
    | "attempt_evidence_invalid";
  revision: number;
  evidence_json: string;
  evidence_hash: string;
  created_at: string;
  updated_at: string;
  checked_at: string;
  resolved_at: string | null;
  resolution_code: string | null;
}

export type PricingRecoveryCaseSummary = Omit<
  PricingRecoveryCaseRow,
  "evidence_json"
>;

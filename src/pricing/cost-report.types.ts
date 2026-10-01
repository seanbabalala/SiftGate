export const COST_REPORT_STATUSES = ['priced', 'estimated', 'partial', 'unpriced', 'missing_usage', 'pending', 'free', 'legacy_estimate'] as const;
export type CostReportStatus = (typeof COST_REPORT_STATUSES)[number];
export interface CostReportRow {
  workspace_id: string;
  request_id: string;
  log_id: number | null;
  recorded_at: string;
  source_format: string | null;
  node_id: string | null;
  model: string | null;
  status: CostReportStatus;
  basis: 'immutable_ledger' | 'legacy_log' | 'missing_evidence' | 'invalid_evidence';
  amount_usd: string | null;
  known_subtotal_usd: string | null;
  legacy_estimate_usd: string | null;
  budget_reserved_usd: string | null;
  budget_committed_usd: string | null;
  pending_financial: boolean;
  unknown_attempts: number;
  pending_attempts: number;
  provider_attempts: number;
  local_cache: boolean;
  snapshot_hash: string | null;
  evidence_hash: string;
}
export interface CostReportTotals {
  requests: number;
  statuses: Record<CostReportStatus, number>;
  calculated_requests: number;
  known_amount_requests: number;
  unknown_amount_requests: number;
  legacy_requests: number;
  missing_log_requests: number;
  pending_financial_requests: number;
  calculated_usd: string;
  estimated_usd: string;
  legacy_estimate_usd: string;
  partial_known_usd: string;
}
export interface CostReportWindow { from: string; to: string }
export interface CostReportPage {
  workspace_id: string;
  window: CostReportWindow;
  limit: number;
  schema_available: boolean;
  population: 'retained_requests_and_legacy_logs';
  consistency: 'page_snapshot_live_between_pages';
  report_id: string;
  requested_cursor: string | null;
  next_cursor: string | null;
  scanned_at: string;
  rows: CostReportRow[];
  totals: CostReportTotals;
  page_hash: string;
}
export interface LogCostSummaryPage {
  workspace_id: string;
  rows: CostReportRow[];
  unavailable_log_ids: number[];
  scanned_at: string;
  read_only: true;
}

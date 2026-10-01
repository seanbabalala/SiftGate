export type CacheSavingsGroupBy = 'node' | 'model' | 'namespace' | 'team' | 'api_key';
export interface CacheSavingsScope { api_key?: string; api_key_id?: string; namespace?: string; team_id?: string }
export interface CacheSavingsMetrics {
  total_requests: number;
  provider_routed_requests: number;
  cache_eligible_requests: number;
  requests_with_provider_cache_hit: number;
  cache_hit_rate: number | null;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read_tokens: number;
  total_cache_creation_tokens: number;
  total_normal_input_tokens: number;
  comparison_status: 'empty' | 'complete' | 'partial' | 'unavailable';
  comparison_basis: 'recorded_log_estimates';
  comparable_requests: number;
  unavailable_reference_requests: number;
  excluded_requests: number;
  actual_cost_usd: number | null;
  hypothetical_no_cache_cost_usd: number | null;
  savings_usd: number | null;
  savings_percentage: number | null;
  known_actual_cost_usd: number;
  known_hypothetical_no_cache_cost_usd: number;
  known_savings_usd: number;
  exact: {
    comparable_actual_usd: string;
    comparable_no_cache_usd: string;
    comparable_savings_usd: string;
  };
  /** Log totals do not retain an immutable per-dimension price decomposition. */
  normal_input_cost_usd: number | null;
  cache_read_cost_usd: number | null;
  cache_creation_cost_usd: number | null;
  output_cost_usd: number | null;
}
export interface CacheSavingsGroupRow extends CacheSavingsMetrics { group_value: string; group_label: string }
export interface CacheSavingsTrendRow extends CacheSavingsMetrics { date: string }
export interface CacheSavingsSummaryResponse {
  period: string;
  period_days: number;
  group_by: CacheSavingsGroupBy;
  filters: { api_key_id: string | null; api_key_name: string | null; namespace_id: string | null; team_id: string | null };
  scan: { row_limit: number; scanned_rows: number; has_more: boolean };
  summary: CacheSavingsMetrics;
  groups: CacheSavingsGroupRow[];
  daily_trend: CacheSavingsTrendRow[];
}

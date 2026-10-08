import type { CostLedgerSummary } from './cost-ledger.types';
import type { CostReportRow, CostReportTotals } from './cost-report.types';
import { COST_REPORT_STATUSES } from './cost-report.types';
import { pricingContentHash } from './pricing-json';
import { legacyReportMoney, sumCostReportMoney } from './cost-report-money';

export interface ReportLog {
  id: number;
  request_id: string;
  timestamp: Date;
  workspace_id: string | null;
  source_format: string;
  node_id: string;
  model: string;
  cost_usd: number;
}
export function costReportRow(workspace: string, request: string, at: string, snapshot: string | null, log: ReportLog | null, summary: CostLedgerSummary | null, invalid = false): CostReportRow {
  const costs = summary?.attempts.map(a => a.effective_cost ?? a.cost) ?? [];
  const hasReceipt = costs.some(Boolean);
  const stored = log ? legacyReportMoney(log.cost_usd) : null;
  const basis: CostReportRow['basis'] = invalid ? 'invalid_evidence' : summary && (hasReceipt || summary.pending_attempts || summary.budget_reserved_usd !== '0.000000000000000000') ? 'immutable_ledger' : snapshot ? 'missing_evidence' : 'legacy_log';
  let status: CostReportRow['status'] = basis === 'legacy_log' ? 'legacy_estimate' : basis === 'immutable_ledger' ? summary!.status : 'unpriced';
  if (status === 'unpriced' && costs.length && costs.every(c => c?.status === 'missing_usage')) status = 'missing_usage';
  const amount = basis === 'immutable_ledger' ? summary!.amount : null;
  const row: CostReportRow = {
    workspace_id: workspace, request_id: request, recorded_at: at, log_id: log?.id ?? null,
    source_format: log?.source_format ?? null, node_id: log?.node_id ?? summary?.attempts[0]?.node_id ?? null, model: log?.model ?? summary?.attempts[0]?.model ?? null,
    basis, status, amount_usd: amount, known_subtotal_usd: basis === 'immutable_ledger' ? summary!.known_subtotal : null,
    legacy_estimate_usd: basis === 'legacy_log' ? stored : null,
    budget_reserved_usd: !invalid && summary ? summary.budget_reserved_usd : null,
    budget_committed_usd: !invalid && summary ? summary.budget_committed_usd : null,
    pending_financial: Boolean(summary && (summary.pending_budget_adjustments || summary.reservations.some(r => r.state === 'reserved' || r.settlement_status === 'pending'))),
    unknown_attempts: summary?.unknown_attempts ?? 0, pending_attempts: summary?.pending_attempts ?? 0, provider_attempts: summary?.provider_attempts ?? 0,
    local_cache: Boolean(summary?.attempts.length && summary.attempts.every(a => a.fee_source === 'local_cache')),
    snapshot_hash: snapshot,
    evidence_hash: '',
  };
  row.evidence_hash = pricingContentHash({ row: { ...row, evidence_hash: undefined }, receipts: summary?.attempts.map(a => [a.id, a.effective_cost_hash, a.adjustments.map(v => v.application.application_hash)]) ?? [] });
  return row;
}
export function costReportTotals(rows: CostReportRow[]): CostReportTotals {
  const totals: CostReportTotals = { requests: rows.length, statuses: Object.fromEntries(COST_REPORT_STATUSES.map(s => [s, 0])) as CostReportTotals['statuses'], calculated_requests: 0, known_amount_requests: 0, unknown_amount_requests: 0, legacy_requests: 0, missing_log_requests: 0, pending_financial_requests: 0, calculated_usd: '0.000000000000000000', estimated_usd: '0.000000000000000000', legacy_estimate_usd: '0.000000000000000000', partial_known_usd: '0.000000000000000000' };
  const add = (key: 'calculated_usd' | 'estimated_usd' | 'legacy_estimate_usd' | 'partial_known_usd', value: string) => { totals[key] = sumCostReportMoney(totals[key], value); };
  for (const row of rows) {
    totals.statuses[row.status]++;
    if (row.log_id === null) totals.missing_log_requests++;
    if (row.pending_financial) totals.pending_financial_requests++;
    if (row.basis === 'legacy_log') { totals.legacy_requests++; if (row.legacy_estimate_usd !== null) add('legacy_estimate_usd', row.legacy_estimate_usd); }
    if (row.amount_usd === null) { totals.unknown_amount_requests++; if (row.known_subtotal_usd !== null) add('partial_known_usd', row.known_subtotal_usd); }
    else {
      totals.known_amount_requests++;
      if (['priced', 'free'].includes(row.status)) { totals.calculated_requests++; add('calculated_usd', row.amount_usd); }
      else add('estimated_usd', row.amount_usd);
    }
  }
  return totals;
}

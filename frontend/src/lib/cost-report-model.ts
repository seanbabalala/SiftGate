import { costHash } from './usage-recovery-form'
import { sumCostReportMoney } from '../../../src/pricing/cost-report-money'
import { COST_REPORT_STATUSES } from '../../../src/pricing/cost-report.types'
import type { CostReportPage, CostReportRow, CostReportTotals, CostReportWindow, LogCostSummaryPage } from '@/types/pricing'

const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 256
const count = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0
const money = (v: unknown): boolean => v === null || typeof v === 'string' && /^\d{1,48}(?:\.\d{1,18})?$/.test(v)
const fail = (): never => { throw new Error('invalid_cost_report') }
export function verifyCostReportRow(row: CostReportRow, workspace: string): CostReportRow {
  if (!row || row.workspace_id !== workspace || !text(row.request_id) || !(row.log_id === null || count(row.log_id) && row.log_id > 0) ||
    !COST_REPORT_STATUSES.includes(row.status) || !['immutable_ledger', 'legacy_log', 'missing_evidence', 'invalid_evidence'].includes(row.basis) ||
    !Number.isFinite(Date.parse(row.recorded_at)) || !hash(row.evidence_hash) || !(row.snapshot_hash === null || typeof row.snapshot_hash === 'string') ||
    ![row.amount_usd, row.known_subtotal_usd, row.legacy_estimate_usd, row.budget_committed_usd, row.budget_reserved_usd].every(money) ||
    ![row.unknown_attempts, row.pending_attempts, row.provider_attempts].every(count) || typeof row.local_cache !== 'boolean' || typeof row.pending_financial !== 'boolean') fail()
  if (row.basis === 'legacy_log' ? row.status !== 'legacy_estimate' || row.amount_usd !== null || row.known_subtotal_usd !== null : row.legacy_estimate_usd !== null) fail()
  if (['missing_evidence', 'invalid_evidence'].includes(row.basis) && (row.status !== 'unpriced' || row.amount_usd !== null || row.known_subtotal_usd !== null)) fail()
  if (['partial', 'unpriced', 'missing_usage', 'pending'].includes(row.status) && row.amount_usd !== null) fail()
  if (row.status === 'free' && row.amount_usd !== '0.000000000000000000') fail()
  return row
}
export function emptyCostReportTotals(): CostReportTotals {
  return { requests: 0, statuses: Object.fromEntries(COST_REPORT_STATUSES.map(s => [s, 0])) as CostReportTotals['statuses'], calculated_requests: 0,
    known_amount_requests: 0, unknown_amount_requests: 0, legacy_requests: 0, missing_log_requests: 0, pending_financial_requests: 0,
    calculated_usd: '0.000000000000000000', estimated_usd: '0.000000000000000000', legacy_estimate_usd: '0.000000000000000000', partial_known_usd: '0.000000000000000000' }
}
export function reportTotalsForRows(rows: CostReportRow[]): CostReportTotals {
  const totals = emptyCostReportTotals()
  for (const row of rows) {
    totals.requests++; totals.statuses[row.status]++
    if (row.log_id === null) totals.missing_log_requests++
    if (row.pending_financial) totals.pending_financial_requests++
    if (row.basis === 'legacy_log') { totals.legacy_requests++; if (row.legacy_estimate_usd !== null) totals.legacy_estimate_usd = sumCostReportMoney(totals.legacy_estimate_usd, row.legacy_estimate_usd) }
    if (row.amount_usd === null) { totals.unknown_amount_requests++; if (row.known_subtotal_usd !== null) totals.partial_known_usd = sumCostReportMoney(totals.partial_known_usd, row.known_subtotal_usd) }
    else {
      totals.known_amount_requests++
      const exact = ['priced', 'free'].includes(row.status); if (exact) totals.calculated_requests++
      const key = exact ? 'calculated_usd' : 'estimated_usd'; totals[key] = sumCostReportMoney(totals[key], row.amount_usd)
    }
  }
  return totals
}
export function mergeCostReportTotals(left: CostReportTotals, right: CostReportTotals): CostReportTotals {
  const result = emptyCostReportTotals()
  for (const key of ['calculated_usd', 'estimated_usd', 'legacy_estimate_usd', 'partial_known_usd'] as const) result[key] = sumCostReportMoney(left[key], right[key])
  for (const key of ['requests', 'calculated_requests', 'known_amount_requests', 'unknown_amount_requests', 'legacy_requests', 'missing_log_requests', 'pending_financial_requests'] as const) {
    result[key] = left[key] + right[key]; if (!count(result[key])) fail()
  }
  for (const status of COST_REPORT_STATUSES) result.statuses[status] = left.statuses[status] + right.statuses[status]
  return result
}
export async function verifyCostReportPage(page: CostReportPage, workspace: string, window: CostReportWindow, cursor: string | null, reportId: string | null): Promise<CostReportPage> {
  if (!page || page.workspace_id !== workspace || page.window.from !== window.from || page.window.to !== window.to || page.limit !== 50 ||
    page.population !== 'retained_requests_and_legacy_logs' || page.consistency !== 'page_snapshot_live_between_pages' || !hash(page.report_id) ||
    reportId !== null && page.report_id !== reportId || page.requested_cursor !== cursor ||
    !(page.next_cursor === null || typeof page.next_cursor === 'string' && /^[A-Za-z0-9_-]{1,4096}$/.test(page.next_cursor) && page.next_cursor !== cursor) ||
    !Array.isArray(page.rows) || page.rows.length > 50 || !Number.isFinite(Date.parse(page.scanned_at)) || typeof page.schema_available !== 'boolean' || !hash(page.page_hash)) fail()
  const { page_hash: _hash, ...body } = page
  if (await costHash(body) !== page.page_hash || new Set(page.rows.map(r => r.request_id)).size !== page.rows.length) fail()
  for (const row of page.rows) verifyCostReportRow(row, workspace)
  if (await costHash(reportTotalsForRows(page.rows)) !== await costHash(page.totals)) fail()
  return page
}
export function verifyLogCostSummaries(page: LogCostSummaryPage, workspace: string, ids: number[]): LogCostSummaryPage {
  if (!page || page.workspace_id !== workspace || page.read_only !== true || !Array.isArray(page.rows) || !Array.isArray(page.unavailable_log_ids) ||
    page.rows.length + page.unavailable_log_ids.length !== ids.length || !Number.isFinite(Date.parse(page.scanned_at))) fail()
  const seen = new Set<number>()
  for (const row of page.rows) { verifyCostReportRow(row, workspace); if (row.log_id === null || !ids.includes(row.log_id) || seen.has(row.log_id)) fail(); seen.add(row.log_id!) }
  for (const id of page.unavailable_log_ids) { if (!ids.includes(id) || seen.has(id)) fail(); seen.add(id) }
  return page
}
export function reportWindowFromInputs(from: string, to: string): CostReportWindow {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(to)) fail()
  const a = new Date(`${from}:00Z`), b = new Date(`${to}:00Z`)
  if (!Number.isFinite(+a) || !Number.isFinite(+b) || a.toISOString().slice(0, 16) !== from || b.toISOString().slice(0, 16) !== to || +b <= +a || +b - +a > 366 * 86400000) fail()
  return { from: a.toISOString(), to: b.toISOString() }
}
export function formatReportTimestamp(value: string, locale?: string): string {
  // Match the explicitly UTC inputs; never silently shift the selected window.
  return `${new Date(value).toLocaleString(locale, { timeZone: 'UTC' })} UTC`
}

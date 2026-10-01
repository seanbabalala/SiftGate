import type { CostLedgerSummary } from '@/types/pricing'

/** Reference savings must not substitute the logical budget charge or current price. */
export function verifiedCacheReference(ledger: CostLedgerSummary) {
  const value = ledger.local_cache_reference
  if (!value || value.schema_version !== 1 || value.basis !== 'frozen_request_logical_estimate' || value.report_currency !== 'USD' || ledger.provider_attempts !== 0 || !ledger.attempts.length || ledger.attempts.some(row => row.fee_source !== 'local_cache') || value.upstream_cost_usd !== '0.000000000000000000') return null
  const money = (amount: string | null) => amount === null || /^\d{1,30}\.\d{18}$/.test(amount)
  if (!money(value.reference_cost_usd) || !money(value.hypothetical_savings_usd) || value.reference_cost_usd !== value.hypothetical_savings_usd || !['estimated', 'unknown', 'invalid_reference'].includes(value.state)) return null
  if ((value.state === 'estimated') !== (value.reference_cost_usd !== null)) return null
  if ([value.logical_input_tokens, value.logical_output_tokens].some(amount => amount !== null && !/^\d{1,30}$/.test(amount))) return null
  return value
}

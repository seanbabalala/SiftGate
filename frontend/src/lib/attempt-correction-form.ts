import { cleanUsageProposal, costHash, draftUsageProposal, usageDraft, type UsageDraft } from './usage-recovery-form'
import { parsePricingInstant } from '../../../src/pricing/pricing-time'
import { DIMENSION_UNITS, type AttemptCorrectionBasis, type AttemptCorrectionInput, type AttemptCorrectionResult, type CostComputation } from '@/types/pricing'

export interface CorrectionCostSummary {
  hash: string; amount: string | null; subtotal: string | null; currency: string; originalAmount: string | null; originalCurrency: string | null; version: string | null; fxVersion: string | null; status: string
  lines: Array<{ dimension: string; quantity: string; rate: string; unitSize: string; currency: string; amount: string | null; multipliers: string[] }>
}
export interface CorrectionPreview {
  requestId: string
  before: CorrectionCostSummary
  after: CorrectionCostSummary
  budget: AttemptCorrectionResult['budget']
}
export interface PendingAttemptCorrection { version: 1; workspace: string; actor: string; attemptId: string; proposal: AttemptCorrectionInput; preview: CorrectionPreview }
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const text = (value: unknown, max = 256): value is string => typeof value === 'string' && value.length > 0 && value.length <= max
const signed = (value: unknown): value is string => typeof value === 'string' && /^-?\d{1,30}(?:\.\d{1,18})?$/.test(value)
const decimal = (value: unknown): value is string => signed(value) && !value.startsWith('-')
const money = (value: unknown) => value === null || decimal(value)
const currency = (value: unknown): value is string => typeof value === 'string' && /^[A-Z]{3}$/.test(value)
const fail = (): never => { throw new Error('invalid_attempt_correction') }
const scaled = (value: string) => { const negative = value.startsWith('-'), [whole, fraction = ''] = value.replace(/^-/, '').split('.'); return BigInt(whole + fraction.padEnd(18, '0')) * (negative ? -1n : 1n) }
export function attemptDraft(basis: AttemptCorrectionBasis): UsageDraft {
  return { ...usageDraft(basis.attempt_id), quantities: Object.values(basis.current.usage.quantities).filter(row => row !== undefined).map(row => ({ dimension: row!.dimension, value: row!.value ?? '' })) }
}
function cleanProposal(proposal: AttemptCorrectionInput, attemptId: string): AttemptCorrectionInput {
  if (!hash(proposal?.expected_cost_hash)) fail()
  const { attempt_id: _attempt, ...body } = cleanUsageProposal({ ...proposal, attempt_id: attemptId })
  return { ...body, expected_cost_hash: proposal.expected_cost_hash }
}
export function attemptProposal(basis: AttemptCorrectionBasis, draft: UsageDraft, id: string = crypto.randomUUID()): AttemptCorrectionInput {
  if (basis.blocked_reason || basis.attempt_id !== draft.attemptId) fail()
  const { attempt_id: _attempt, ...body } = draftUsageProposal(basis.basis_hash, draft, id)
  return cleanProposal({ ...body, expected_cost_hash: basis.effective_cost_hash }, basis.attempt_id)
}
export function attemptReady(basis: AttemptCorrectionBasis | null, draft: UsageDraft) { try { if (!basis) return false; attemptProposal(basis, draft, 'validation-only'); return true } catch { return false } }
export function cleanSummary(row: CorrectionCostSummary): CorrectionCostSummary {
  if (!row || !hash(row.hash) || !money(row.amount) || !money(row.subtotal) || !money(row.originalAmount) || !currency(row.currency) || (row.originalCurrency !== null && !currency(row.originalCurrency)) || (row.version !== null && !text(row.version)) || (row.fxVersion !== null && !text(row.fxVersion)) || !['priced','estimated','partial','unpriced','missing_usage','pending','free','legacy_estimate'].includes(row.status) || !Array.isArray(row.lines) || row.lines.length > 4096) fail()
  const lines = row.lines.map(line => {
    if (!Object.hasOwn(DIMENSION_UNITS, line.dimension) || !decimal(line.quantity) || !decimal(line.rate) || !decimal(line.unitSize) || !currency(line.currency) || !money(line.amount) || !Array.isArray(line.multipliers) || line.multipliers.length > 128 || !line.multipliers.every(decimal)) fail()
    return { dimension: line.dimension, quantity: line.quantity, rate: line.rate, unitSize: line.unitSize, currency: line.currency, amount: line.amount, multipliers: [...line.multipliers] }
  })
  return { hash: row.hash, amount: row.amount, subtotal: row.subtotal, currency: row.currency, originalAmount: row.originalAmount, originalCurrency: row.originalCurrency, version: row.version, fxVersion: row.fxVersion, status: row.status, lines }
}
export async function correctionCost(cost: CostComputation, expectedHash: string): Promise<CorrectionCostSummary> {
  if (!cost || cost.batch || await costHash(cost) !== expectedHash) fail()
  return cleanSummary({ hash: expectedHash, amount: cost.report_amount, subtotal: cost.report_known_subtotal, currency: cost.report_currency, originalAmount: cost.amount, originalCurrency: cost.currency, version: cost.version_id, fxVersion: cost.fx_version_id, status: cost.status, lines: cost.lines.map(line => ({ dimension: line.dimension, quantity: line.billed_quantity, rate: line.rate, unitSize: line.unit_size, currency: line.currency, amount: line.report_amount, multipliers: line.multipliers })) })
}
export function cleanBudget(budget: AttemptCorrectionResult['budget'], workspace: string): AttemptCorrectionResult['budget'] {
  if (!budget || !['applied','applied_cost_only','not_applicable','pending'].includes(budget.budget_state) || budget.current_period_refund_not_guaranteed !== true || !money(budget.budget_cost_before) || !money(budget.budget_cost_after) || !money(budget.budget_tokens_before) || !money(budget.budget_tokens_after) || !signed(budget.cost_delta) || !signed(budget.tokens_delta) || !/^-?\d+$/.test(budget.tokens_delta) || !Array.isArray(budget.allocations) || budget.allocations.length > 4096) fail()
  const allocations = budget.allocations.map(row => {
    if (!Number.isSafeInteger(row.ruleId) || row.ruleId < 1 || row.workspaceId !== workspace || !text(row.periodStart) || !text(row.type, 128) || !signed(row.amount)) fail()
    parsePricingInstant(row.periodStart)
    return { ruleId: row.ruleId, workspaceId: row.workspaceId, periodStart: row.periodStart, type: row.type, amount: row.amount }
  })
  if (new Set(allocations.map(row => `${row.ruleId}/${row.periodStart}`)).size !== allocations.length) fail()
  for (const value of [budget.budget_tokens_before, budget.budget_tokens_after]) if (value !== null && !/^\d+(?:\.0+)?$/.test(value)) fail()
  if (budget.budget_cost_before !== null && budget.budget_cost_after !== null && scaled(budget.budget_cost_after) - scaled(budget.budget_cost_before) !== scaled(budget.cost_delta)) fail()
  if (budget.budget_tokens_before !== null && budget.budget_tokens_after !== null && scaled(budget.budget_tokens_after) - scaled(budget.budget_tokens_before) !== scaled(budget.tokens_delta)) fail()
  if (['pending','not_applicable'].includes(budget.budget_state) && (scaled(budget.cost_delta) !== 0n || scaled(budget.tokens_delta) !== 0n || allocations.length)) fail()
  return { budget_state: budget.budget_state, budget_cost_before: budget.budget_cost_before, budget_cost_after: budget.budget_cost_after, budget_tokens_before: budget.budget_tokens_before, budget_tokens_after: budget.budget_tokens_after, cost_delta: budget.cost_delta, tokens_delta: budget.tokens_delta, allocations, current_period_refund_not_guaranteed: true }
}
export async function attemptReply(result: AttemptCorrectionResult, proposal: AttemptCorrectionInput, workspace: string, attemptId: string, requestId: string, dryRun: boolean, preview?: CorrectionPreview): Promise<CorrectionPreview> {
  if (!result || result.id !== proposal.id || result.attempt_id !== attemptId || result.request_id !== requestId || result.basis_hash !== proposal.expected_basis_hash || result.previous_cost_hash !== proposal.expected_cost_hash || !hash(result.cost_hash) || result.dry_run !== dryRun || typeof result.replayed !== 'boolean' || result.supplier_confirmed !== false || result.original_receipt_modified !== false || JSON.stringify(result).length > 4 * 1024 * 1024) fail()
  const [before, after] = await Promise.all([correctionCost(result.previous_cost, proposal.expected_cost_hash), correctionCost(result.cost, result.cost_hash)])
  const budget = cleanBudget(result.budget, workspace)
  if (!dryRun && (!result.adjustment || result.adjustment.attempt_id !== attemptId || result.adjustment.workspace_id !== workspace || result.adjustment.previous_hash !== proposal.expected_cost_hash || result.adjustment.cost_hash !== after.hash || await costHash(result.adjustment.cost) !== after.hash)) fail()
  if (!dryRun) {
    const applied = result.adjustment!.application
    if (applied.workspace_id !== workspace || applied.request_id !== requestId || applied.attempt_id !== attemptId || applied.adjustment_id !== result.adjustment!.id || applied.source !== 'reconciliation' || JSON.stringify(cleanBudget({ ...applied, current_period_refund_not_guaranteed: true }, workspace)) !== JSON.stringify(budget)) fail()
  }
  // Epoch allocations are part of what was reviewed, not merely the rounded total.
  if (preview && (preview.after.hash !== after.hash || preview.before.hash !== before.hash || JSON.stringify(cleanBudget(preview.budget, workspace)) !== JSON.stringify(budget))) fail()
  return { requestId, before, after, budget }
}
export const pendingCorrectionKey = (workspace: string, actor: string, attemptId: string) => `siftgate:pending-attempt-correction:v1:${JSON.stringify([workspace, actor, attemptId])}`
function cleanRecord(value: PendingAttemptCorrection): PendingAttemptCorrection {
  const proposal = cleanProposal(value.proposal, value.attemptId)
  if (value.version !== 1 || !text(value.workspace, 128) || !text(value.actor, 128) || !text(value.attemptId, 160) || !text(value.preview?.requestId, 128)) fail()
  const preview = { requestId: value.preview.requestId, before: cleanSummary(value.preview.before), after: cleanSummary(value.preview.after), budget: cleanBudget(value.preview.budget, value.workspace) }
  if (preview.before.hash !== proposal.expected_cost_hash) fail()
  return { version: 1, workspace: value.workspace, actor: value.actor, attemptId: value.attemptId, proposal, preview }
}
export function savePendingCorrection(storage: Pick<Storage,'setItem'>, value: PendingAttemptCorrection) {
  const safe = cleanRecord(value), json = JSON.stringify(safe); if (json.length > 2 * 1024 * 1024) fail()
  storage.setItem(pendingCorrectionKey(safe.workspace, safe.actor, safe.attemptId), json)
}
export function loadPendingCorrection(storage: Pick<Storage,'getItem'>, workspace: string, actor: string, attemptId: string): PendingAttemptCorrection | null {
  const json = storage.getItem(pendingCorrectionKey(workspace, actor, attemptId)); if (json === null) return null
  if (json.length > 2 * 1024 * 1024) fail()
  const value = cleanRecord(JSON.parse(json) as PendingAttemptCorrection)
  if (value.workspace !== workspace || value.actor !== actor || value.attemptId !== attemptId) fail()
  return value
}

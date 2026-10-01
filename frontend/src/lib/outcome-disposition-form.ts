import { cleanBudget, cleanSummary, correctionCost, type CorrectionCostSummary } from './attempt-correction-form'
import { costHash } from './usage-recovery-form'
import type { OutcomeDispositionAction, OutcomeDispositionBasis, OutcomeDispositionInput, OutcomeDispositionResult } from '@/types/pricing'

export interface DispositionDraft { action: OutcomeDispositionAction | ''; reason: string }
export interface DispositionReceipt {
  attemptId: string
  operation: OutcomeDispositionResult['changes'][number]['operation']
  before: CorrectionCostSummary | null
  after: CorrectionCostSummary
  errorCode: string | null
  originalErrorPreserved: boolean
  budget: OutcomeDispositionResult['changes'][number]['budget']
}
export interface DispositionPreview { requestId: string; action: OutcomeDispositionAction; receipts: DispositionReceipt[] }
export interface PendingDisposition { version: 1; workspace: string; actor: string; outcomeId: string; proposal: OutcomeDispositionInput; preview: DispositionPreview }
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const text = (value: unknown, max = 160): value is string => typeof value === 'string' && value.length > 0 && value.length <= max
const action = (value: unknown): value is OutcomeDispositionAction => ['accept_receipts', 'reject_evidence'].includes(String(value))
const fail = (): never => { throw new Error('invalid_outcome_disposition') }
const errorCode = (value: unknown) => value === null || (typeof value === 'string' && value.length <= 160)
export function cleanDispositionProposal(value: OutcomeDispositionInput): OutcomeDispositionInput {
  if (!value || !text(value.id, 128) || !hash(value.expected_basis_hash) || !hash(value.expected_outcome_hash) || !action(value.action) || !text(value.reason, 1000) || !value.reason.trim() || value.confirm !== true) fail()
  return { id: value.id, expected_basis_hash: value.expected_basis_hash, expected_outcome_hash: value.expected_outcome_hash, action: value.action, reason: value.reason, confirm: true }
}
export function dispositionProposal(basis: OutcomeDispositionBasis, draft: DispositionDraft, id: string = crypto.randomUUID()): OutcomeDispositionInput {
  if (basis.blocked_reason || basis.disposition || (draft.action === 'accept_receipts' && !basis.receipts.length)) fail()
  return cleanDispositionProposal({ id, expected_basis_hash: basis.basis_hash, expected_outcome_hash: basis.outcome_hash, action: draft.action as OutcomeDispositionAction, reason: draft.reason.trim(), confirm: true })
}
export function dispositionReady(basis: OutcomeDispositionBasis | null, draft: DispositionDraft) { try { if (!basis) return false; dispositionProposal(basis, draft, 'validation-only'); return true } catch { return false } }

export async function validateDispositionBasis(basis: OutcomeDispositionBasis, outcomeId: string): Promise<OutcomeDispositionBasis> {
  if (!basis || basis.outcome_id !== outcomeId || outcomeId !== `runtime-outcome:${basis.outcome_hash}` || !hash(basis.outcome_hash) || !hash(basis.basis_hash) || !text(basis.request_id, 128) || !text(basis.reservation_id) || basis.source !== 'gateway_runtime' || basis.supplier_confirmed !== false || basis.budget_decision_unchanged !== true || ![null,'not_review_required','already_disposed','lease_active','pending_intent','async_owned','batch_group_required','not_provider'].includes(basis.blocked_reason) || !Array.isArray(basis.receipts) || basis.receipts.length > 128 || !Array.isArray(basis.related_outcomes) || basis.related_outcomes.length > 4096 || JSON.stringify(basis).length > 4 * 1024 * 1024) fail()
  if (new Set(basis.receipts.map(r => r.attempt_id)).size !== basis.receipts.length || new Set(basis.related_outcomes.map(r => r.id)).size !== basis.related_outcomes.length) fail()
  for (const row of basis.receipts) {
    if (!text(row.attempt_id) || !hash(row.retained_hash) || !row.retained || await costHash(row.retained) !== row.retained_hash || !errorCode(row.recorded_error) || !errorCode(row.retained_error)) fail()
    if (row.current === null ? row.current_hash !== null || row.original !== null : !row.original || !hash(row.current_hash) || await costHash(row.current) !== row.current_hash) fail()
  }
  for (const row of basis.related_outcomes) if (!hash(row.outcome_hash) || row.id !== `runtime-outcome:${row.outcome_hash}` || !['attempt','settlement'].includes(row.kind) || !['pending','delivered','review_required'].includes(row.state) || (row.disposition !== null && !action(row.disposition))) fail()
  if (!basis.related_outcomes.some(row => row.id === outcomeId)) fail()
  if (basis.disposition && (!text(basis.disposition.id,128) || !action(basis.disposition.action) || !text(basis.disposition.actor_id,128) || !hash(basis.disposition.result_hash) || basis.blocked_reason !== 'already_disposed')) fail()
  if (!basis.disposition && basis.blocked_reason === 'already_disposed') fail()
  return basis
}
function cleanPreview(preview: DispositionPreview, workspace: string): DispositionPreview {
  if (!preview || !text(preview.requestId,128) || !action(preview.action) || !Array.isArray(preview.receipts) || preview.receipts.length > 128 || new Set(preview.receipts.map(r => r.attemptId)).size !== preview.receipts.length || (preview.action === 'reject_evidence' ? preview.receipts.length !== 0 : preview.receipts.length === 0)) fail()
  const receipts = preview.receipts.map(row => {
    if (!text(row.attemptId) || !['initial_receipt','linked_correction','already_recorded'].includes(row.operation) || !errorCode(row.errorCode) || typeof row.originalErrorPreserved !== 'boolean') fail()
    const before = row.before === null ? null : cleanSummary(row.before), after = cleanSummary(row.after), budget = cleanBudget(row.budget, workspace)
    if (row.operation === 'initial_receipt' ? before !== null || row.originalErrorPreserved : before === null || !row.originalErrorPreserved) fail()
    if (row.operation === 'already_recorded' && before?.hash !== after.hash) fail()
    if (row.operation === 'linked_correction' && before?.hash === after.hash) fail()
    if (row.operation !== 'linked_correction' && (budget.budget_state !== 'not_applicable' || budget.allocations.length)) fail()
    return { attemptId: row.attemptId, operation: row.operation, before, after, budget, errorCode: row.errorCode, originalErrorPreserved: row.originalErrorPreserved }
  })
  return { requestId: preview.requestId, action: preview.action, receipts }
}

/** Exact receipt membership and reviewed epoch deltas must agree, not merely a success status. */
export async function dispositionReply(result: OutcomeDispositionResult, proposal: OutcomeDispositionInput, workspace: string, actor: string, outcomeId: string, requestId: string, dryRun: boolean, expected?: OutcomeDispositionBasis | DispositionPreview): Promise<DispositionPreview> {
  if (!result || result.id !== proposal.id || result.action !== proposal.action || result.outcome_id !== outcomeId || outcomeId !== `runtime-outcome:${proposal.expected_outcome_hash}` || result.outcome_hash !== proposal.expected_outcome_hash || result.basis_hash !== proposal.expected_basis_hash || result.request_id !== requestId || result.dry_run !== dryRun || typeof result.replayed !== 'boolean' || result.supplier_confirmed !== false || result.original_receipts_modified !== false || result.outcome_document_modified !== false || result.budget_decision_unchanged !== true || !Array.isArray(result.changes) || result.changes.length > 128 || JSON.stringify(result).length > 4 * 1024 * 1024) fail()
  const receipts: DispositionReceipt[] = []
  for (const row of result.changes) {
    if (!hash(row.cost_hash) || (row.previous_cost_hash !== null && !hash(row.previous_cost_hash)) || (row.previous_cost === null) !== (row.previous_cost_hash === null)) fail()
    const after = await correctionCost(row.cost, row.cost_hash), before = row.previous_cost ? await correctionCost(row.previous_cost, row.previous_cost_hash!) : null, budget = cleanBudget(row.budget, workspace)
    if (dryRun || row.operation !== 'linked_correction') { if (row.adjustment !== null) fail() }
    else {
      const a = row.adjustment, application = a?.application
      const expectedId = `outcome-adjustment:${await costHash([workspace, proposal.id, row.attempt_id])}`
      if (!a || !application || a.id !== expectedId || a.workspace_id !== workspace || a.attempt_id !== row.attempt_id || a.previous_hash !== row.previous_cost_hash || a.cost_hash !== row.cost_hash || await costHash(a.cost) !== row.cost_hash || application.actor_id !== actor || application.workspace_id !== workspace || application.request_id !== requestId || application.attempt_id !== row.attempt_id || application.adjustment_id !== expectedId || application.source !== 'reconciliation' || JSON.stringify(cleanBudget({ ...application, current_period_refund_not_guaranteed: true }, workspace)) !== JSON.stringify(budget)) fail()
    }
    receipts.push({ attemptId: row.attempt_id, operation: row.operation, before, after, budget, errorCode: row.error_code, originalErrorPreserved: row.original_error_preserved })
  }
  const preview = cleanPreview({ requestId, action: result.action, receipts }, workspace)
  if (expected && 'outcome_id' in expected) {
    const members = proposal.action === 'reject_evidence' ? [] : expected.receipts
    if (members.length !== receipts.length) fail()
    for (const row of receipts) {
      const original = members.find(r => r.attempt_id === row.attemptId)
      if (!original || row.after.hash !== original.retained_hash || (row.before?.hash ?? null) !== original.current_hash || row.errorCode !== (original.current ? original.recorded_error : original.retained_error)) fail()
    }
  } else if (expected && JSON.stringify(cleanPreview(expected,workspace)) !== JSON.stringify(preview)) fail()
  return preview
}
export async function dispositionAcknowledgement(result: OutcomeDispositionResult, basis: OutcomeDispositionBasis, workspace: string): Promise<DispositionPreview> {
  const record = basis.disposition
  if (!record) return fail()
  if (await costHash({ ...result, replayed: false }) !== record.result_hash || result.id !== record.id || result.action !== record.action) fail()
  return dispositionReply(result, { id:record.id, action:record.action, expected_basis_hash:result.basis_hash, expected_outcome_hash:basis.outcome_hash, reason:'acknowledgement-only',confirm:true },workspace,record.actor_id,basis.outcome_id,basis.request_id,false)
}
export const pendingDispositionKey = (workspace: string, actor: string, outcomeId: string) => `siftgate:pending-outcome-disposition:v1:${JSON.stringify([workspace,actor,outcomeId])}`
function cleanRecord(value: PendingDisposition): PendingDisposition {
  if (!value || value.version !== 1 || !text(value.workspace,128) || !text(value.actor,128)) fail()
  const proposal = cleanDispositionProposal(value.proposal), preview = cleanPreview(value.preview, value.workspace)
  if (value.outcomeId !== `runtime-outcome:${proposal.expected_outcome_hash}` || preview.action !== proposal.action) fail()
  return { version:1, workspace:value.workspace, actor:value.actor, outcomeId:value.outcomeId, proposal, preview }
}
export function savePendingDisposition(storage: Pick<Storage,'setItem'>, value: PendingDisposition) {
  const safe = cleanRecord(value), json = JSON.stringify(safe); if (json.length > 2 * 1024 * 1024) fail()
  storage.setItem(pendingDispositionKey(safe.workspace,safe.actor,safe.outcomeId),json)
}
export function loadPendingDisposition(storage: Pick<Storage,'getItem'>,workspace: string,actor: string,outcomeId: string): PendingDisposition | null {
  const json = storage.getItem(pendingDispositionKey(workspace,actor,outcomeId)); if (json === null) return null
  if (json.length > 2 * 1024 * 1024) fail()
  const value = cleanRecord(JSON.parse(json) as PendingDisposition)
  if (value.workspace !== workspace || value.actor !== actor || value.outcomeId !== outcomeId) fail()
  return value
}

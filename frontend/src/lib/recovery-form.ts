import type { RecoveryBasis, RecoveryDecision, RecoveryResolutionInput, RecoveryResolutionResult } from '@/types/pricing'

export interface RecoveryDraft { reason: string; decisions: Array<{ reservationId: string; action: RecoveryDecision['action'] | ''; attemptId: string; logicalTokens: string }> }
export interface PendingRecovery { version: 1; workspace: string; actor: string; anchor: string; proposal: RecoveryResolutionInput; preview: RecoveryResolutionResult }
const integer = (value: string) => /^\d+(?:\.0+)?$/.test(value) && value.length <= 128 ? BigInt(value.split('.')[0]).toString() : null
const money = (value: unknown): value is string => typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value) && value.length <= 128
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256

export function recoveryDraft(basis: RecoveryBasis, prior?: RecoveryDraft): RecoveryDraft {
  return { reason: prior?.reason ?? '', decisions: basis.reservations.filter((row) => row.state === 'reserved').map((row) => {
    const old = prior?.decisions.find((entry) => entry.reservationId === row.id)
    if (row.budget_basis === 'actual_upstream') return { reservationId: row.id, action: 'reconcile_actual', attemptId: '', logicalTokens: '' }
    if (row.intent_state) return { reservationId: row.id, action: 'apply_recorded', attemptId: '', logicalTokens: '' }
    const candidate = old?.attemptId && recoveryWinners(basis, row.id).some((attempt) => attempt.id === old.attemptId)
    return { reservationId: row.id, action: old?.action === 'release' ? 'release' : old?.action === 'commit' ? 'commit' : '', attemptId: candidate ? old!.attemptId : '', logicalTokens: candidate ? old!.logicalTokens : '' }
  }) }
}
export function recoveryWinners(basis: RecoveryBasis, reservationId: string) {
  if (basis.reservations.find(row => row.id === reservationId)?.budget_basis === 'actual_upstream') return []
  return basis.attempts.filter((attempt) => attempt.reservation_id === reservationId && attempt.state === 'terminal' && attempt.cost?.report_amount != null)
}
export function recoveryTokens(basis: RecoveryBasis, attemptId: string): string | null {
  const usage = basis.attempts.find((attempt) => attempt.id === attemptId)?.cost?.usage
  const input = usage?.quantities.total_input_tokens?.value, output = usage?.quantities.output_tokens?.value
  const a = input == null ? null : integer(input), b = output == null ? null : integer(output)
  return a === null || b === null ? null : (BigInt(a) + BigInt(b)).toString()
}
export function recoveryDraftReady(basis: RecoveryBasis, draft: RecoveryDraft): boolean {
  const rows = basis.reservations.filter((row) => row.state === 'reserved')
  if (!rows.length || rows.some((row) => row.blocked_reason) || !draft.reason.trim() || draft.reason.length > 1000 || draft.decisions.length !== rows.length) return false
  return rows.every((row) => {
    const decision = draft.decisions.find((entry) => entry.reservationId === row.id)
    if (!decision || !decision.action) return false
    if (row.budget_basis === 'actual_upstream') return Boolean(row.actual_budget) && decision.action === 'reconcile_actual' && decision.attemptId === '' && decision.logicalTokens === ''
    if (row.intent_state) return decision.action === 'apply_recorded'
    if (decision.action === 'release') return true
    if (decision.action !== 'commit' || !recoveryWinners(basis, row.id).some((entry) => entry.id === decision.attemptId)) return false
    return recoveryTokens(basis, decision.attemptId) !== null || integer(decision.logicalTokens.trim()) !== null
  })
}
export function recoveryProposal(basis: RecoveryBasis, draft: RecoveryDraft): RecoveryResolutionInput {
  if (!recoveryDraftReady(basis, draft)) throw new Error('invalid_recovery_form')
  return { id: crypto.randomUUID(), expected_basis_hash: basis.basis_hash, reason: draft.reason.trim(), confirm: true,
    decisions: draft.decisions.map((entry) => ({ reservation_id: entry.reservationId, action: entry.action as RecoveryDecision['action'],
      ...(entry.action === 'commit' ? { budget_attempt_id: entry.attemptId, ...(recoveryTokens(basis, entry.attemptId) === null ? { logical_tokens: integer(entry.logicalTokens.trim())! } : {}) } : {}),
    })).sort((a, b) => a.reservation_id.localeCompare(b.reservation_id)),
  }
}

/** Validate identity, complete membership and exact string amounts before acknowledging any write. */
export function recoveryResult(value: RecoveryResolutionResult, proposal: RecoveryResolutionInput, anchor: string, dryRun: boolean): RecoveryResolutionResult {
  if (!value || value.id !== proposal.id || value.anchor_reservation_id !== anchor || value.basis_hash !== proposal.expected_basis_hash || value.budget_only !== true || value.dry_run !== dryRun || typeof value.replayed !== 'boolean' || !Array.isArray(value.changes) || value.changes.length !== proposal.decisions.length || new Set(value.changes.map((row) => row.reservation_id)).size !== value.changes.length || !Array.isArray(value.unknown_attempt_ids) || value.unknown_attempt_ids.length > 4096 || !value.unknown_attempt_ids.every(id)) throw new Error('invalid_recovery_response')
  const changes = value.changes.map((row) => {
    const decision = proposal.decisions.find((entry) => entry.reservation_id === row.reservation_id)
    if (!decision || decision.action !== row.action || row.previous_state !== 'reserved' || !['released', 'committed', 'reserved'].includes(row.next_state) || !money(row.budget_cost_usd) || !money(row.reserved_cost_usd) || typeof row.budget_tokens !== 'string' || integer(row.budget_tokens) === null || row.current_balance_refund_not_guaranteed !== true || (row.budget_attempt_id !== null && !id(row.budget_attempt_id)) || (decision.action === 'release' && (row.next_state !== 'released' || row.budget_attempt_id !== null || !/^0+(?:\.0+)?$/.test(row.budget_cost_usd) || integer(row.budget_tokens) !== '0')) || (decision.action === 'commit' && (row.next_state !== 'committed' || row.budget_attempt_id !== decision.budget_attempt_id))) throw new Error('invalid_recovery_response')
    if (decision.action === 'reconcile_actual') {
      if (decision.budget_attempt_id !== undefined || decision.logical_tokens !== undefined || row.budget_attempt_id !== null || !/^[a-f0-9]{64}$/.test(row.actual_closure_hash ?? '') || !Array.isArray(row.pending_reasons) || row.pending_reasons.length > 5 || row.pending_reasons.some(reason => !['evidence_incomplete', 'runtime_custody', 'runtime_group_custody', 'missing_dispatch_evidence', 'media_custody'].includes(reason)) || (row.next_state === 'reserved' ? !row.pending_reasons.length || !/^0+(?:\.0+)?$/.test(row.budget_cost_usd) || integer(row.budget_tokens) !== '0' : row.pending_reasons.length !== 0)) throw new Error('invalid_recovery_response')
    } else if (row.next_state === 'reserved' || row.actual_closure_hash !== undefined || row.pending_reasons !== undefined) throw new Error('invalid_recovery_response')
    if (row.next_state === 'released' && (!/^0+(?:\.0+)?$/.test(row.budget_cost_usd) || integer(row.budget_tokens) !== '0')) throw new Error('invalid_recovery_response')
    return { reservation_id: row.reservation_id, action: row.action, previous_state: row.previous_state, next_state: row.next_state, budget_tokens: row.budget_tokens, budget_cost_usd: row.budget_cost_usd, budget_attempt_id: row.budget_attempt_id, reserved_cost_usd: row.reserved_cost_usd, current_balance_refund_not_guaranteed: true as const, ...(row.action === 'reconcile_actual' ? { actual_closure_hash: row.actual_closure_hash, pending_reasons: [...row.pending_reasons!] } : {}) }
  })
  return { id: value.id, anchor_reservation_id: value.anchor_reservation_id, basis_hash: value.basis_hash, budget_only: true, dry_run: dryRun, replayed: value.replayed === true, changes, unknown_attempt_ids: [...value.unknown_attempt_ids] }
}
export function pendingRecoveryKey(workspace: string, actor: string, anchor: string) { return `siftgate:pending-budget-recovery:v1:${JSON.stringify([workspace, actor, anchor])}` }
export function savePendingRecovery(storage: Pick<Storage, 'setItem'>, record: PendingRecovery): void {
  const safe: PendingRecovery = { version: 1, workspace: record.workspace, actor: record.actor, anchor: record.anchor, proposal: { id: record.proposal.id, expected_basis_hash: record.proposal.expected_basis_hash, reason: record.proposal.reason, confirm: true, decisions: record.proposal.decisions.map((entry) => ({ reservation_id: entry.reservation_id, action: entry.action, ...(entry.budget_attempt_id !== undefined ? { budget_attempt_id: entry.budget_attempt_id } : {}), ...(entry.logical_tokens !== undefined ? { logical_tokens: entry.logical_tokens } : {}) })) }, preview: recoveryResult(record.preview, record.proposal, record.anchor, true) }
  const serialized = JSON.stringify(safe)
  if (serialized.length > 2 * 1024 * 1024) throw new Error('recovery_storage_limit')
  storage.setItem(pendingRecoveryKey(record.workspace, record.actor, record.anchor), serialized)
}
export function loadPendingRecovery(storage: Pick<Storage, 'getItem'>, workspace: string, actor: string, anchor: string): PendingRecovery | null {
  const raw = storage.getItem(pendingRecoveryKey(workspace, actor, anchor))
  if (!raw) return null
  if (raw.length > 2 * 1024 * 1024) throw new Error('invalid_pending_recovery')
  const record = JSON.parse(raw) as PendingRecovery
  const proposal = record?.proposal
  if (record.version !== 1 || record.workspace !== workspace || record.actor !== actor || record.anchor !== anchor || !proposal || !id(proposal.id) || proposal.id.length > 128 || !/^[a-f0-9]{64}$/.test(proposal.expected_basis_hash) || typeof proposal.reason !== 'string' || !proposal.reason.trim() || proposal.reason.length > 1000 || proposal.confirm !== true || !Array.isArray(proposal.decisions) || proposal.decisions.length > 4096 || !proposal.decisions.length || new Set(proposal.decisions.map((row) => row.reservation_id)).size !== proposal.decisions.length) throw new Error('invalid_pending_recovery')
  const decisions = proposal.decisions.map((row) => {
    if (!id(row.reservation_id) || !['commit', 'release', 'apply_recorded', 'reconcile_actual'].includes(row.action) || (row.budget_attempt_id !== undefined && !id(row.budget_attempt_id)) || (row.logical_tokens !== undefined && (typeof row.logical_tokens !== 'string' || integer(row.logical_tokens) === null)) || (row.action === 'reconcile_actual' && (row.budget_attempt_id !== undefined || row.logical_tokens !== undefined))) throw new Error('invalid_pending_recovery')
    return { reservation_id: row.reservation_id, action: row.action, ...(row.budget_attempt_id !== undefined ? { budget_attempt_id: row.budget_attempt_id } : {}), ...(row.logical_tokens !== undefined ? { logical_tokens: row.logical_tokens } : {}) }
  })
  const clean = { id: proposal.id, expected_basis_hash: proposal.expected_basis_hash, reason: proposal.reason, confirm: true as const, decisions }
  return { version: 1, workspace, actor, anchor, proposal: clean, preview: recoveryResult(record.preview, clean, anchor, true) }
}

import { costHash } from './usage-recovery-form'
import { cleanBudget, correctionCost } from './attempt-correction-form'
import type { MediaEventDispositionBasis, MediaEventDispositionChoice, MediaEventDispositionInput, MediaEventDispositionPreview, MediaEventDispositionReceipt } from '@/types/pricing'

const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
const text = (v: unknown, max = 256): v is string => typeof v === 'string' && v.length > 0 && v.length <= max
const sequence = (v: unknown) => typeof v === 'string' && /^(0|[1-9]\d{0,29})$/.test(v)
const signed = (v: unknown): v is string => typeof v === 'string' && /^-?\d{1,30}(?:\.\d{1,18})?$/.test(v)
const scaled = (v: string) => { const [whole, fraction = ''] = v.replace(/^-/, '').split('.'); return BigInt(whole + fraction.padEnd(18, '0')) * (v.startsWith('-') ? -1n : 1n) }
const fail = (): never => { throw new Error('invalid_media_response') }
function choice(value: MediaEventDispositionChoice): MediaEventDispositionChoice {
  if (!value || !['accept', 'reject'].includes(value.action) ||
    !(value.action === 'accept' ? ['continue_ordered', 'manual_review'] : ['unchanged']).includes(value.ordering) ||
    ![value.expected_basis_hash, value.expected_event_hash].every(hash)) fail()
  return { action: value.action, ordering: value.ordering, expected_basis_hash: value.expected_basis_hash, expected_event_hash: value.expected_event_hash }
}
export function cleanMediaDisposition(value: MediaEventDispositionInput): MediaEventDispositionInput {
  const selected = choice(value)
  if (!text(value.id, 128) || !/^[A-Za-z0-9_-]+$/.test(value.id) || !hash(value.expected_preview_hash) || !text(value.reason, 1000) || !value.reason.trim() || value.confirm !== true) fail()
  return { ...selected, id: value.id, expected_preview_hash: value.expected_preview_hash, reason: value.reason, confirm: true }
}
export async function verifyMediaDispositionBasis(value: MediaEventDispositionBasis, workspace: string, task: string, event: string) {
  if (!value || value.workspace_id !== workspace || value.task_id !== task || value.event_id !== event || !hash(value.event_hash) || !hash(value.basis_hash) ||
    !text(value.request_id) || !['authenticated_connector', 'unversioned_observation'].includes(value.origin) ||
    !(value.sequence === null || sequence(value.sequence)) || !sequence(value.effective_sequence) ||
    ![null, 'not_review_required', 'already_disposed'].includes(value.blocked_reason) ||
    ![null, 'pending_processing', 'terminal_regression', 'stale_sequence', 'budget_decision_present', 'control_in_progress'].includes(value.accept_blocked_reason) ||
    !['reserved', 'committed', 'released'].includes(value.reservation_state)) fail()
  if (value.current_cost) await correctionCost(value.current_cost, value.current_cost_hash!)
  else if (value.current_cost_hash !== null) fail()
  if (value.authority && (!text(value.authority.disposition_id) || !text(value.authority.source_id) || !text(value.authority.provider_job_id) ||
    !sequence(value.authority.sequence) || !['continue_ordered', 'manual_review'].includes(value.authority.mode))) fail()
  if (value.disposition && (!text(value.disposition.id) || !text(value.disposition.actor_id) || !hash(value.disposition.record_hash) ||
    !['accept', 'reject'].includes(value.disposition.action) || value.blocked_reason !== 'already_disposed')) fail()
  return value
}
export function mediaDispositionChoice(basis: MediaEventDispositionBasis, action: string, ordering: string): MediaEventDispositionChoice {
  if (basis.blocked_reason || (action === 'accept' && (basis.accept_blocked_reason || (basis.sequence === null && ordering !== 'manual_review')))) fail()
  return choice({ action: action as MediaEventDispositionChoice['action'], ordering: ordering as MediaEventDispositionChoice['ordering'],
    expected_basis_hash: basis.basis_hash, expected_event_hash: basis.event_hash })
}
export async function verifyMediaDispositionPreview(value: MediaEventDispositionPreview, workspace: string, task: string, event: string, selected?: MediaEventDispositionChoice) {
  if (!value || JSON.stringify(value).length > 4 * 1024 * 1024 || value.task_id !== task || value.event_id !== event || !text(value.request_id) ||
    !text(value.source_id) || !sequence(value.next_sequence) || !hash(value.preview_hash) || value.dry_run !== true ||
    value.supplier_invoice_confirmed !== false || value.original_receipts_modified !== false || !value.observation ||
    !['pending', 'completed', 'failed', 'cancelled'].includes(value.observation.status) || !text(value.observation.provider_job_id) || !text(value.observation.credential_id)) fail()
  const { preview_hash: _hash, ...body } = value
  if (await costHash(body) !== value.preview_hash) fail()
  const actual = choice({ action: value.action, ordering: value.ordering, expected_basis_hash: value.basis_hash, expected_event_hash: value.event_hash })
  if (selected && JSON.stringify(actual) !== JSON.stringify(choice(selected))) fail()
  if (value.cost) await correctionCost(value.cost, value.cost_hash!)
  else if (value.cost_hash !== null) fail()
  if (value.previous_cost) await correctionCost(value.previous_cost, value.previous_cost_hash!)
  else if (value.previous_cost_hash !== null) fail()
  if (value.action === 'accept' && (!value.cost || await costHash(value.cost.usage) !== await costHash(value.observation.usage))) fail()
  const impact = value.impact
  if (!impact || !['initial', 'adjustment', 'noop', 'pending_only', 'none'].includes(impact.operation) || impact.processing_deferred !== true ||
    !text(impact.original_reservation_id) || !(impact.amount_delta === null || signed(impact.amount_delta)) ||
    impact.currency !== (value.cost?.report_currency ?? null)) fail()
  if (value.action === 'reject') {
    if (impact.operation !== 'none' || value.previous_cost_hash !== value.cost_hash || impact.budget !== null) fail()
  } else if (impact.operation === 'none' || (value.observation.status === 'pending') !== (impact.operation === 'pending_only')) fail()
  if (impact.budget) cleanBudget(impact.budget, workspace)
  if ((impact.operation === 'adjustment') !== Boolean(impact.budget)) fail()
  if (['none', 'noop', 'pending_only'].includes(impact.operation)) {
    if (!signed(impact.amount_delta) || scaled(impact.amount_delta) !== 0n) fail()
  } else if (value.cost?.report_amount != null && value.previous_cost?.report_amount != null && value.cost.report_currency === value.previous_cost.report_currency) {
    if (!signed(impact.amount_delta) || scaled(value.cost.report_amount) - scaled(value.previous_cost.report_amount) !== scaled(impact.amount_delta)) fail()
  } else if (impact.amount_delta !== null) fail()
  return value
}
export function mediaDispositionProposal(preview: MediaEventDispositionPreview, reason: string): MediaEventDispositionInput {
  return cleanMediaDisposition({ id: crypto.randomUUID(), action: preview.action, ordering: preview.ordering, expected_basis_hash: preview.basis_hash,
    expected_event_hash: preview.event_hash, expected_preview_hash: preview.preview_hash, reason: reason.trim(), confirm: true })
}
export async function verifyMediaDispositionReceipt(value: MediaEventDispositionReceipt, workspace: string, actor: string, task: string, event: string, input?: MediaEventDispositionInput) {
  if (!value || value.task_id !== task || value.event_id !== event || value.actor_id !== actor || !text(value.id, 128) || !hash(value.record_hash) || value.dry_run !== false ||
    typeof value.replayed !== 'boolean' || !(value.processing_pending === undefined || typeof value.processing_pending === 'boolean')) fail()
  const preview = await verifyMediaDispositionPreview(value.preview, workspace, task, event, input)
  if (input && (value.id !== input.id || preview.preview_hash !== input.expected_preview_hash)) fail()
  if (preview.action === 'accept' ? !text(value.observation_id) : value.observation_id !== null) fail()
  return value
}
export interface PendingMediaDisposition { version: 1; workspace: string; actor: string; task: string; event: string; proposal: MediaEventDispositionInput }
export const mediaDispositionPendingKey = (workspace: string, actor: string, task: string, event: string) => `pricing-media:disposition:v1:${JSON.stringify([workspace, actor, task, event])}`
export function saveMediaDisposition(storage: Pick<Storage, 'setItem'>, value: PendingMediaDisposition) {
  const safe = { version: 1, workspace: value.workspace, actor: value.actor, task: value.task, event: value.event, proposal: cleanMediaDisposition(value.proposal) }
  if (![safe.workspace, safe.actor, safe.task, safe.event].every(v => text(v))) fail()
  storage.setItem(mediaDispositionPendingKey(safe.workspace, safe.actor, safe.task, safe.event), JSON.stringify(safe))
}
export function loadMediaDisposition(storage: Pick<Storage, 'getItem'>, workspace: string, actor: string, task: string, event: string): PendingMediaDisposition | null {
  const raw = storage.getItem(mediaDispositionPendingKey(workspace, actor, task, event))
  if (raw === null) return null
  if (raw.length > 16384) fail()
  const value = JSON.parse(raw) as PendingMediaDisposition
  if (value.version !== 1 || value.workspace !== workspace || value.actor !== actor || value.task !== task || value.event !== event) fail()
  return { version: 1, workspace, actor, task, event, proposal: cleanMediaDisposition(value.proposal) }
}

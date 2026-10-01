import { DIMENSION_UNITS, MEDIA_ATTRIBUTES, type MeterDimension, type RecoveryBasis, type UsageRecoveryInput, type UsageRecoveryResult } from '@/types/pricing'
import { parsePricingInstant } from '../../../src/pricing/pricing-time'

export interface UsageDraft {
  attemptId: string
  reason: string
  digest: string
  quantities: Array<{ dimension: MeterDimension; value: string }>
  tier: string
  acceptedAt: string
  completedAt: string
  media: Record<string, string>
}
export interface UsageReceiptPreview {
  attemptId: string; requestId: string; reservationId: string; hash: string
  amount: string | null; subtotal: string | null; currency: string; status: string
  originalAmount: string | null; originalCurrency: string | null; versionId: string | null; fxVersionId: string | null
  physicalId: string | null; physicalAmount: string | null; weight: string | null; totalWeight: string | null
  lines: Array<{ dimension: MeterDimension; quantity: string; rate: string; unitSize: string; currency: string; amount: string | null; factors: string[] }>
}
export interface PendingUsageRecovery { version: 1; workspace: string; actor: string; anchor: string; proposal: UsageRecoveryInput; receipts: UsageReceiptPreview[] }
const defaults: MeterDimension[] = ['total_input_tokens', 'uncached_input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'cache_write_5m_tokens', 'cache_write_1h_tokens']
const statuses = ['priced', 'estimated', 'partial', 'unpriced', 'missing_usage', 'pending', 'free', 'legacy_estimate']
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const text = (value: unknown, max = 256): value is string => typeof value === 'string' && value.length > 0 && value.length <= max
const decimal = (value: unknown): value is string => typeof value === 'string' && /^\d{1,30}(?:\.\d{1,18})?$/.test(value)
const money = (value: unknown) => value === null || decimal(value)
const currency = (value: unknown): value is string => typeof value === 'string' && /^[A-Z]{3}$/.test(value)
const fail = (): never => { throw new Error('invalid_usage_recovery') }

export function usageDraft(attemptId = ''): UsageDraft { return { attemptId, reason: '', digest: '', quantities: defaults.map((dimension) => ({ dimension, value: '' })), tier: '', acceptedAt: '', completedAt: '', media: {} } }
export function usageMembers(basis: RecoveryBasis, attemptId: string) {
  const selected = basis.attempts.find((row) => row.id === attemptId)
  return !selected ? [] : selected.physical_attempt_id ? basis.attempts.filter((row) => row.physical_attempt_id === selected.physical_attempt_id) : [selected]
}
export function usageCandidates(basis: RecoveryBasis) {
  return basis.attempts.filter((row) => row.state === 'dispatched' && row.fee_source === 'provider' && row.cost === null)
}
export function usageBlocked(basis: RecoveryBasis, attemptId: string) {
  const members = usageMembers(basis, attemptId)
  return !members.length || members.some((row) => {
    const hold = basis.reservations.find((entry) => entry.id === row.reservation_id)
    return row.state !== 'dispatched' || row.fee_source !== 'provider' || row.cost !== null || !hold || Boolean(hold.blocked_reason) || (hold.intent_state !== null && hold.intent_state !== 'applied') || !Number.isFinite(Date.parse(hold.lease_until)) || Date.parse(hold.lease_until) > Date.now()
  })
}
function instant(value: string): boolean {
  try { parsePricingInstant(value); return true } catch { return false }
}
export function cleanUsageProposal(input: UsageRecoveryInput): UsageRecoveryInput {
  if (!input || !text(input.id, 128) || !text(input.attempt_id, 160) || !hash(input.expected_basis_hash) || !text(input.reason, 1000) || !input.reason.trim() || input.confirm !== true || !Array.isArray(input.evidence) || !input.evidence.length || input.evidence.length > Object.keys(DIMENSION_UNITS).length || new Set(input.evidence.map((row) => row.dimension)).size !== input.evidence.length) fail()
  const evidence = input.evidence.map((row) => {
    if (!Object.hasOwn(DIMENSION_UNITS, row.dimension) || (row.value !== null && (!decimal(row.value) || (DIMENSION_UNITS[row.dimension] !== 'second' && !/^\d+(?:\.0+)?$/.test(row.value))))) fail()
    return { dimension: row.dimension, value: row.value }
  })
  const conditions: NonNullable<UsageRecoveryInput['conditions']> = {}
  if (input.conditions) {
    if (input.conditions.resolved_service_tier !== undefined) { if (!text(input.conditions.resolved_service_tier, 128)) fail(); conditions.resolved_service_tier = input.conditions.resolved_service_tier }
    for (const field of ['provider_accepted_at', 'completed_at'] as const) {
      const value = input.conditions[field]
      if (value !== undefined) { if (typeof value !== 'string' || !instant(value)) fail(); conditions[field] = value }
    }
    if (input.conditions.media) {
      conditions.media = {}
      for (const [key, value] of Object.entries(input.conditions.media)) {
        if (!MEDIA_ATTRIBUTES.includes(key as typeof MEDIA_ATTRIBUTES[number]) || key === 'operation' || !text(value, 256)) fail()
        conditions.media[key as typeof MEDIA_ATTRIBUTES[number]] = value
      }
    }
  }
  if (input.evidence_digest !== undefined && !hash(input.evidence_digest)) fail()
  return { id: input.id, attempt_id: input.attempt_id, expected_basis_hash: input.expected_basis_hash, reason: input.reason, confirm: true, evidence, ...(Object.keys(conditions).length ? { conditions } : {}), ...(input.evidence_digest ? { evidence_digest: input.evidence_digest } : {}) }
}
export function usageProposal(basis: RecoveryBasis, draft: UsageDraft, id: string = crypto.randomUUID()): UsageRecoveryInput {
  if (usageBlocked(basis, draft.attemptId)) fail()
  return draftUsageProposal(basis.basis_hash, draft, id)
}
export function draftUsageProposal(basisHash: string, draft: UsageDraft, id: string = crypto.randomUUID()): UsageRecoveryInput {
  const media = Object.fromEntries(Object.entries(draft.media).filter(([, value]) => value.trim()).map(([key, value]) => [key, value.trim()]))
  const conditions = { ...(draft.tier.trim() ? { resolved_service_tier: draft.tier.trim() } : {}), ...(draft.acceptedAt.trim() ? { provider_accepted_at: draft.acceptedAt.trim() } : {}), ...(draft.completedAt.trim() ? { completed_at: draft.completedAt.trim() } : {}), ...(Object.keys(media).length ? { media } : {}) }
  return cleanUsageProposal({ id, attempt_id: draft.attemptId, expected_basis_hash: basisHash, reason: draft.reason.trim(), confirm: true, evidence: draft.quantities.map(({ dimension, value }) => ({ dimension, value: value.trim() || null })), conditions, ...(draft.digest.trim() ? { evidence_digest: draft.digest.trim() } : {}) })
}
export function usageReady(basis: RecoveryBasis, draft: UsageDraft) { try { usageProposal(basis, draft, 'validation-only'); return true } catch { return false } }
export function restoredUsageDraft(proposal: UsageRecoveryInput): UsageDraft {
  return { attemptId: proposal.attempt_id, reason: proposal.reason, digest: proposal.evidence_digest ?? '', quantities: proposal.evidence.map((row) => ({ dimension: row.dimension, value: row.value ?? '' })), tier: proposal.conditions?.resolved_service_tier ?? '', acceptedAt: proposal.conditions?.provider_accepted_at ?? '', completedAt: proposal.conditions?.completed_at ?? '', media: { ...proposal.conditions?.media } }
}

// Matches the server's canonical JSON; browser crypto only, never the Node-only hash module.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') { const record = value as Record<string, unknown>; return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}` }
  return JSON.stringify(value)
}
export async function costHash(value: unknown) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value)))), (byte) => byte.toString(16).padStart(2, '0')).join('') }
function cleanReceipts(rows: UsageReceiptPreview[]): UsageReceiptPreview[] {
  if (!Array.isArray(rows) || !rows.length || rows.length > 1024 || new Set(rows.map((row) => row.attemptId)).size !== rows.length) fail()
  return rows.map((row) => {
    if (!text(row.attemptId, 160) || !text(row.requestId, 128) || !text(row.reservationId, 160) || !hash(row.hash) || !money(row.amount) || !money(row.subtotal) || !currency(row.currency) || !statuses.includes(row.status) || !money(row.originalAmount) || (row.originalCurrency !== null && !currency(row.originalCurrency)) || (row.versionId !== null && !text(row.versionId)) || (row.fxVersionId !== null && !text(row.fxVersionId)) || (row.physicalId !== null && !text(row.physicalId)) || !money(row.physicalAmount) || !money(row.weight) || !money(row.totalWeight) || !Array.isArray(row.lines) || row.lines.length > 4096) fail()
    const lines = row.lines.map((line) => {
      if (!Object.hasOwn(DIMENSION_UNITS, line.dimension) || !decimal(line.quantity) || !decimal(line.rate) || !decimal(line.unitSize) || !currency(line.currency) || !money(line.amount) || !Array.isArray(line.factors) || line.factors.length > 128 || !line.factors.every(decimal)) fail()
      return { dimension: line.dimension, quantity: line.quantity, rate: line.rate, unitSize: line.unitSize, currency: line.currency, amount: line.amount, factors: [...line.factors] }
    })
    return { attemptId: row.attemptId, requestId: row.requestId, reservationId: row.reservationId, hash: row.hash, amount: row.amount, subtotal: row.subtotal, currency: row.currency, status: row.status, originalAmount: row.originalAmount, originalCurrency: row.originalCurrency, versionId: row.versionId, fxVersionId: row.fxVersionId, physicalId: row.physicalId, physicalAmount: row.physicalAmount, weight: row.weight, totalWeight: row.totalWeight, lines }
  })
}
export async function usageReply(value: UsageRecoveryResult, proposal: UsageRecoveryInput, anchor: string, dryRun: boolean, expected: Array<{ attemptId: string; requestId: string; reservationId: string; hash?: string }>): Promise<UsageReceiptPreview[]> {
  if (!value || value.id !== proposal.id || value.attempt_id !== proposal.attempt_id || value.anchor_reservation_id !== anchor || value.basis_hash !== proposal.expected_basis_hash || value.dry_run !== dryRun || typeof value.replayed !== 'boolean' || value.source !== 'administrator_attestation' || value.budget_changed !== false || value.supplier_confirmed !== false || !Array.isArray(value.changes) || value.changes.length !== expected.length || JSON.stringify(value).length > 4 * 1024 * 1024) fail()
  const rows = await Promise.all(value.changes.map(async (row) => {
    const member = expected.find((entry) => entry.attemptId === row.attempt_id)
    if (!member || member.requestId !== row.request_id || member.reservationId !== row.reservation_id || (member.hash && member.hash !== row.cost_hash) || !hash(row.cost_hash) || !row.cost || await costHash(row.cost) !== row.cost_hash) fail()
    const cost = row.cost, batch = cost.batch
    return { attemptId: row.attempt_id, requestId: row.request_id, reservationId: row.reservation_id, hash: row.cost_hash, amount: cost.report_amount, subtotal: cost.report_known_subtotal, currency: cost.report_currency, status: cost.status, originalAmount: cost.amount, originalCurrency: cost.currency, versionId: cost.version_id, fxVersionId: cost.fx_version_id, physicalId: batch?.physical_attempt_id ?? null, physicalAmount: batch?.physical_cost.report_amount ?? null, weight: batch?.members[batch.member_index]?.weight ?? null, totalWeight: batch?.weight_total ?? null, lines: cost.lines.map((line) => ({ dimension: line.dimension, quantity: line.billed_quantity, rate: line.rate, unitSize: line.unit_size, currency: line.currency, amount: line.report_amount, factors: line.multipliers })) }
  }))
  return cleanReceipts(rows)
}
export const pendingUsageKey = (workspace: string, actor: string, anchor: string) => `siftgate:pending-usage-recovery:v1:${JSON.stringify([workspace, actor, anchor])}`
export function savePendingUsage(storage: Pick<Storage, 'setItem'>, record: PendingUsageRecovery) {
  const safe = { version: 1, workspace: record.workspace, actor: record.actor, anchor: record.anchor, proposal: cleanUsageProposal(record.proposal), receipts: cleanReceipts(record.receipts) }
  const json = JSON.stringify(safe); if (json.length > 2 * 1024 * 1024) fail()
  storage.setItem(pendingUsageKey(record.workspace, record.actor, record.anchor), json)
}
export function loadPendingUsage(storage: Pick<Storage, 'getItem'>, workspace: string, actor: string, anchor: string): PendingUsageRecovery | null {
  const json = storage.getItem(pendingUsageKey(workspace, actor, anchor)); if (json === null) return null
  if (json.length > 2 * 1024 * 1024) fail()
  const value = JSON.parse(json) as PendingUsageRecovery
  if (!value || value.version !== 1 || value.workspace !== workspace || value.actor !== actor || value.anchor !== anchor) fail()
  const proposal = cleanUsageProposal(value.proposal), receipts = cleanReceipts(value.receipts)
  if (!receipts.some((row) => row.attemptId === proposal.attempt_id)) fail()
  return { version: 1, workspace, actor, anchor, proposal, receipts }
}

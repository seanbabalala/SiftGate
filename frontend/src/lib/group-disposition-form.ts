import { cleanBudget, cleanSummary, type CorrectionCostSummary } from './attempt-correction-form'
import { cleanDispositionProposal, type DispositionDraft } from './outcome-disposition-form'
import { costHash } from './usage-recovery-form'
import type {
  CostComputation,
  GroupDispositionBasis,
  GroupDispositionInput,
  GroupDispositionResult,
  OutcomeDispositionAction
} from '@/types/pricing'

type Budget = GroupDispositionResult['changes'][number]['budget']
export interface GroupPhysicalSummary {
  id: string
  batchId: string
  hash: string
  membersHash: string
  count: number
  index: number
  weight: string
  totalWeight: string
  cost: CorrectionCostSummary
}
export interface GroupReviewReceipt {
  attemptId: string
  requestId: string
  reservationId: string
  retainedHash: string
  operation: GroupDispositionResult['changes'][number]['operation']
  before: CorrectionCostSummary | null
  after: CorrectionCostSummary
  physical: GroupPhysicalSummary | null
  recordedError: string | null
  retainedError: string | null
  originalErrorPreserved: boolean
  budget: Budget
}
export interface GroupDispositionPreview {
  action: OutcomeDispositionAction
  receipts: GroupReviewReceipt[]
}
export interface PendingGroupDisposition {
  version: 1
  workspace: string
  actor: string
  outcomeId: string
  proposal: GroupDispositionInput
  preview: GroupDispositionPreview
}
function fail(): never {
  throw new Error('invalid_group_disposition')
}
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
const text = (v: unknown, max = 160): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= max
const errorCode = (v: unknown) => v === null || (typeof v === 'string' && v.length <= 160)
const positive = (v: unknown): v is string =>
  typeof v === 'string' && /^\d{1,34}$/.test(v) && BigInt(v) > 0n
const action = (v: unknown): v is OutcomeDispositionAction =>
  v === 'accept_receipts' || v === 'reject_evidence'
const same = async (a: unknown, b: unknown) => (await costHash(a)) === (await costHash(b))
function selectedShare(cost: CostComputation) {
  if (!cost.batch) return cost
  const { correction: _revision, ...batch } = cost.batch
  return { ...cost, batch }
}
function bounded(value: unknown) {
  const json = JSON.stringify(value)
  if (
    !json ||
    json.length > 32 * 1024 * 1024 ||
    new TextEncoder().encode(json).byteLength > 32 * 1024 * 1024
  )
    fail()
}
function scaled(value: string) {
  const [whole, fraction = ''] = value.split('.')
  return BigInt(whole + fraction.padEnd(18, '0'))
}

/** Compact numeric display only; member formulas are shown from full physical evidence, never a fictional per-member tariff. */
async function summary(cost: CostComputation, expected: string): Promise<CorrectionCostSummary> {
  if (!cost || !hash(expected) || (await costHash(cost)) !== expected) fail()
  return cleanSummary({
    hash: expected,
    amount: cost.report_amount,
    subtotal: cost.report_known_subtotal,
    currency: cost.report_currency,
    originalAmount: cost.amount,
    originalCurrency: cost.currency,
    version: cost.version_id,
    fxVersion: cost.fx_version_id,
    status: cost.status,
    lines: []
  })
}
async function physical(
  cost: CostComputation,
  requestId: string,
  reservationId: string
): Promise<GroupPhysicalSummary | null> {
  const batch = cost.batch
  if (!batch) return null
  if (
    batch.algorithm !== 'proportional_largest_remainder_v1' ||
    !text(batch.physical_attempt_id) ||
    !text(batch.batch_id) ||
    !hash(batch.physical_cost_hash) ||
    !batch.physical_cost ||
    batch.physical_cost.batch ||
    !Array.isArray(batch.members) ||
    !batch.members.length ||
    batch.members.length > 1024 ||
    !Number.isSafeInteger(batch.member_index) ||
    !positive(batch.weight_total)
  )
    fail()
  let weight = 0n,
    offset = 0
  const requests = new Set<string>(),
    holds = new Set<string>()
  for (const member of batch.members) {
    if (
      !text(member.request_id, 128) ||
      !text(member.reservation_id) ||
      requests.has(member.request_id) ||
      holds.has(member.reservation_id) ||
      member.input_start !== offset ||
      !Number.isSafeInteger(member.input_count) ||
      member.input_count < 1 ||
      !positive(member.weight) ||
      !['token_input_count', 'text_token_estimate'].includes(member.weight_basis)
    )
      fail()
    offset += member.input_count
    if (!Number.isSafeInteger(offset)) fail()
    weight += BigInt(member.weight)
    requests.add(member.request_id)
    holds.add(member.reservation_id)
  }
  const member = batch.members[batch.member_index]
  if (
    !member ||
    member.request_id !== requestId ||
    member.reservation_id !== reservationId ||
    String(weight) !== batch.weight_total
  )
    fail()
  const value = await summary(batch.physical_cost, batch.physical_cost_hash)
  if (
    cost.currency !== value.originalCurrency ||
    cost.report_currency !== value.currency ||
    cost.version_id !== value.version ||
    cost.fx_version_id !== value.fxVersion
  )
    fail()
  return {
    id: batch.physical_attempt_id,
    batchId: batch.batch_id,
    hash: batch.physical_cost_hash,
    membersHash: await costHash(batch.members),
    count: batch.members.length,
    index: batch.member_index,
    weight: member.weight,
    totalWeight: batch.weight_total,
    cost: value
  }
}
function cleanPhysical(v: GroupPhysicalSummary): GroupPhysicalSummary {
  if (
    !v ||
    !text(v.id) ||
    !text(v.batchId) ||
    !hash(v.hash) ||
    !hash(v.membersHash) ||
    !Number.isSafeInteger(v.count) ||
    v.count < 1 ||
    v.count > 1024 ||
    !Number.isSafeInteger(v.index) ||
    v.index < 0 ||
    v.index >= v.count ||
    !positive(v.weight) ||
    !positive(v.totalWeight) ||
    BigInt(v.weight) > BigInt(v.totalWeight)
  )
    fail()
  const cost = cleanSummary(v.cost)
  if (cost.hash !== v.hash || cost.lines.length) fail()
  return {
    id: v.id,
    batchId: v.batchId,
    hash: v.hash,
    membersHash: v.membersHash,
    count: v.count,
    index: v.index,
    weight: v.weight,
    totalWeight: v.totalWeight,
    cost
  }
}
export function groupDispositionProposal(
  basis: GroupDispositionBasis,
  draft: DispositionDraft,
  id: string = crypto.randomUUID()
): GroupDispositionInput {
  if (
    basis.blocked_reason ||
    basis.disposition ||
    (draft.action === 'accept_receipts' &&
      (basis.acceptance_blocked_reason || !basis.receipts.length))
  )
    fail()
  return cleanDispositionProposal({
    id,
    expected_basis_hash: basis.basis_hash,
    expected_outcome_hash: basis.outcome_hash,
    action: draft.action as OutcomeDispositionAction,
    reason: draft.reason.trim(),
    confirm: true
  })
}
export function groupDispositionReady(
  basis: GroupDispositionBasis | null,
  draft: DispositionDraft
) {
  try {
    if (!basis) return false
    groupDispositionProposal(basis, draft, 'validation-only')
    return true
  } catch {
    return false
  }
}

export async function validateGroupDispositionBasis(
  basis: GroupDispositionBasis,
  id: string
): Promise<GroupDispositionBasis> {
  bounded(basis)
  if (
    !basis ||
    basis.outcome_id !== id ||
    id !== `runtime-group:${basis.outcome_hash}` ||
    !hash(basis.outcome_hash) ||
    !hash(basis.basis_hash) ||
    basis.source !== 'gateway_runtime' ||
    basis.supplier_confirmed !== false ||
    basis.budget_decision_unchanged !== true ||
    ![
      null,
      'not_review_required',
      'already_disposed',
      'lease_active',
      'pending_intent',
      'async_owned',
      'not_provider'
    ].includes(basis.blocked_reason) ||
    ![
      null,
      'no_receipts',
      'ambiguous_receipts',
      'manifest_missing',
      'incomplete_historical_group',
      'inconsistent_group_history',
      'allocation_failure'
    ].includes(basis.acceptance_blocked_reason) ||
    !Array.isArray(basis.receipts) ||
    basis.receipts.length > 1024 ||
    !Array.isArray(basis.groups) ||
    basis.groups.length > 1024 ||
    !Array.isArray(basis.related_outcomes) ||
    basis.related_outcomes.length > 4096
  )
    fail()
  if (
    new Set(basis.receipts.map((r) => r.attempt_id)).size !== basis.receipts.length ||
    new Set(basis.groups.map((g) => g.physical_attempt_id)).size !== basis.groups.length ||
    new Set(basis.related_outcomes.map((r) => r.id)).size !== basis.related_outcomes.length
  )
    fail()
  const groups = new Map(basis.groups.map((g) => [g.physical_attempt_id, g]))
  for (const row of basis.receipts) {
    if (
      !text(row.attempt_id) ||
      !text(row.request_id, 128) ||
      !text(row.reservation_id) ||
      !errorCode(row.recorded_error) ||
      !errorCode(row.retained_error)
    )
      fail()
    await summary(row.retained, row.retained_hash)
    if (
      row.current === null
        ? row.current_hash !== null || row.original !== null
        : !row.original || !hash(row.current_hash)
    )
      fail()
    if (row.current) await summary(row.current, row.current_hash!)
    if (row.original) await summary(row.original, await costHash(row.original))
    const allocation = await physical(row.retained, row.request_id, row.reservation_id)
    if ((allocation?.id ?? null) !== row.physical_attempt_id) fail()
    if (
      allocation &&
      (!groups.has(allocation.id) ||
        (!basis.acceptance_blocked_reason &&
          groups.get(allocation.id)!.retained_physical_hash !== allocation.hash))
    )
      fail()
  }
  for (const group of basis.groups) {
    if (
      !text(group.physical_attempt_id) ||
      !text(group.batch_id) ||
      typeof group.complete !== 'boolean' ||
      !Array.isArray(group.represented_attempt_ids) ||
      !group.represented_attempt_ids.length ||
      new Set(group.represented_attempt_ids).size !== group.represented_attempt_ids.length ||
      group.retained_physical.batch
    )
      fail()
    await summary(group.retained_physical, group.retained_physical_hash)
    for (const old of [group.original_physical, group.current_physical])
      if (old) {
        if (old.batch) fail()
        await summary(old, await costHash(old))
      }
    const members = basis.receipts.filter(
      (row) => row.physical_attempt_id === group.physical_attempt_id
    )
    if (
      members.length !== group.represented_attempt_ids.length ||
      !members.every((row) => group.represented_attempt_ids.includes(row.attempt_id))
    )
      fail()
    if (
      !basis.acceptance_blocked_reason &&
      group.complete !== (members.length === members[0].retained.batch!.members.length)
    )
      fail()
  }
  for (const row of basis.related_outcomes)
    if (
      !hash(row.document_hash) ||
      row.id !== `runtime-group:${row.document_hash}` ||
      !['pending', 'delivered', 'review_required'].includes(row.state) ||
      (row.disposition !== null && !action(row.disposition))
    )
      fail()
  if (!basis.related_outcomes.some((row) => row.id === id)) fail()
  if (
    basis.disposition
      ? !text(basis.disposition.id, 128) ||
        !text(basis.disposition.actor_id, 128) ||
        !hash(basis.disposition.result_hash) ||
        !action(basis.disposition.action) ||
        basis.blocked_reason !== 'already_disposed'
      : basis.blocked_reason === 'already_disposed'
  )
    fail()
  return basis
}
function cleanPreview(value: GroupDispositionPreview, workspace: string): GroupDispositionPreview {
  if (
    !value ||
    !action(value.action) ||
    !Array.isArray(value.receipts) ||
    value.receipts.length > 1024 ||
    (value.action === 'reject_evidence'
      ? value.receipts.length !== 0
      : value.receipts.length === 0) ||
    new Set(value.receipts.map((r) => r.attemptId)).size !== value.receipts.length
  )
    fail()
  const receipts = value.receipts
    .map((row) => {
      if (
        !text(row.attemptId) ||
        !text(row.requestId, 128) ||
        !text(row.reservationId) ||
        !hash(row.retainedHash) ||
        !['initial_receipt', 'linked_correction', 'already_recorded'].includes(row.operation) ||
        !errorCode(row.recordedError) ||
        !errorCode(row.retainedError) ||
        typeof row.originalErrorPreserved !== 'boolean'
      )
        fail()
      const before = row.before === null ? null : cleanSummary(row.before),
        after = cleanSummary(row.after),
        allocation = row.physical === null ? null : cleanPhysical(row.physical),
        budget = cleanBudget(row.budget, workspace)
      if (
        after.lines.length ||
        before?.lines.length ||
        (row.operation === 'initial_receipt'
          ? before !== null || row.originalErrorPreserved || row.recordedError !== row.retainedError
          : before === null || !row.originalErrorPreserved)
      )
        fail()
      if (row.operation === 'already_recorded' && before?.hash !== after.hash) fail()
      if (row.operation === 'linked_correction' && before?.hash === after.hash) fail()
      if (!allocation && after.hash !== row.retainedHash) fail()
      if (
        row.operation !== 'linked_correction' &&
        (budget.budget_state !== 'not_applicable' || budget.allocations.length)
      )
        fail()
      return {
        attemptId: row.attemptId,
        requestId: row.requestId,
        reservationId: row.reservationId,
        retainedHash: row.retainedHash,
        operation: row.operation,
        before,
        after,
        physical: allocation,
        recordedError: row.recordedError,
        retainedError: row.retainedError,
        originalErrorPreserved: row.originalErrorPreserved,
        budget
      }
    })
    .sort((a, b) => a.attemptId.localeCompare(b.attemptId))
  return { action: value.action, receipts }
}

/** Verify membership and physical conservation against the reviewed basis or compact saved preview. */
export async function groupDispositionReply(
  result: GroupDispositionResult,
  proposal: GroupDispositionInput,
  workspace: string,
  actor: string,
  outcomeId: string,
  dryRun: boolean,
  expected?: GroupDispositionBasis | GroupDispositionPreview
): Promise<GroupDispositionPreview> {
  bounded(result)
  if (
    !result ||
    result.id !== proposal.id ||
    result.action !== proposal.action ||
    result.outcome_id !== outcomeId ||
    outcomeId !== `runtime-group:${proposal.expected_outcome_hash}` ||
    result.outcome_hash !== proposal.expected_outcome_hash ||
    result.basis_hash !== proposal.expected_basis_hash ||
    result.dry_run !== dryRun ||
    typeof result.replayed !== 'boolean' ||
    result.supplier_confirmed !== false ||
    result.outcome_document_modified !== false ||
    result.original_receipts_modified !== false ||
    result.budget_decision_unchanged !== true ||
    !Array.isArray(result.changes) ||
    result.changes.length > 1024
  )
    fail()
  const receipts: GroupReviewReceipt[] = []
  for (const row of result.changes) {
    if ((row.previous_cost === null) !== (row.previous_cost_hash === null)) fail()
    const before = row.previous_cost
        ? await summary(row.previous_cost, row.previous_cost_hash!)
        : null,
      after = await summary(row.cost, row.cost_hash),
      allocation = await physical(row.cost, row.request_id, row.reservation_id),
      budget = cleanBudget(row.budget, workspace)
    if ((allocation?.id ?? null) !== row.physical_attempt_id) fail()
    if (row.operation === 'linked_correction') {
      const batchId = allocation
        ? `group-review:${await costHash([workspace, proposal.id, allocation.id])}`
        : null
      const adjustmentId = batchId
        ? `batch-${await costHash([workspace, batchId, row.attempt_id])}`
        : `group-member:${await costHash([workspace, proposal.id, row.attempt_id])}`
      const a = row.adjustment,
        application = a?.application
      if (
        !a ||
        !application ||
        a.id !== adjustmentId ||
        a.workspace_id !== workspace ||
        a.attempt_id !== row.attempt_id ||
        a.previous_hash !== row.previous_cost_hash ||
        a.cost_hash !== row.cost_hash ||
        (await costHash(a.cost)) !== row.cost_hash ||
        application.actor_id !== actor ||
        application.workspace_id !== workspace ||
        application.request_id !== row.request_id ||
        application.reservation_id !== row.reservation_id ||
        application.attempt_id !== row.attempt_id ||
        application.adjustment_id !== adjustmentId ||
        application.source !== 'reconciliation' ||
        !hash(application.application_hash) ||
        !Number.isSafeInteger(application.revision) ||
        application.revision < 1 ||
        !(await same(
          cleanBudget({ ...application, current_period_refund_not_guaranteed: true }, workspace),
          budget
        ))
      )
        fail()
      if (
        batchId &&
        (row.cost.batch?.correction?.id !== batchId ||
          row.cost.batch.correction.revision !== application.revision ||
          row.cost.batch.correction.previous_physical_cost_hash !==
            row.previous_cost?.batch?.physical_cost_hash)
      )
        fail()
      const { cost, application: _application, ...adjustmentRow } = a,
        { allocations, application_hash, ...applicationBody } = application
      if (
        (await costHash({
          row: { ...adjustmentRow, cost_json: JSON.stringify(cost) },
          application: { ...applicationBody, allocations_json: JSON.stringify(allocations) }
        })) !== application_hash
      )
        fail()
    } else if (row.adjustment !== null) fail()
    receipts.push({
      attemptId: row.attempt_id,
      requestId: row.request_id,
      reservationId: row.reservation_id,
      retainedHash: row.retained_hash,
      operation: row.operation,
      before,
      after,
      physical: allocation,
      recordedError: row.recorded_error,
      retainedError: row.retained_error,
      originalErrorPreserved: row.original_error_preserved,
      budget
    })
  }
  const preview = cleanPreview({ action: result.action, receipts }, workspace)
  const cohorts = new Map<string, GroupReviewReceipt[]>()
  for (const row of preview.receipts)
    if (row.physical) {
      const group = cohorts.get(row.physical.id) ?? []
      group.push(row)
      cohorts.set(row.physical.id, group)
    }
  for (const group of cohorts.values()) {
    const first = group[0].physical!
    if (
      new Set(group.map((row) => row.physical!.index)).size !== group.length ||
      group.some(
        (row) =>
          row.physical!.hash !== first.hash ||
          row.physical!.membersHash !== first.membersHash ||
          row.physical!.batchId !== first.batchId
      )
    )
      fail()
    if (group.some((row) => row.operation === 'linked_correction') && group.length !== first.count)
      fail()
    if (group.length === first.count)
      for (const [memberField, physicalField] of [
        ['amount', 'amount'],
        ['subtotal', 'subtotal'],
        ['originalAmount', 'originalAmount']
      ] as const) {
        const amounts = group.map((row) => row.after[memberField]),
          total = first.cost[physicalField]
        if (
          total !== null &&
          (amounts.some((v) => v === null) ||
            amounts.reduce((sum, v) => sum + scaled(v!), 0n) !== scaled(total))
        )
          fail()
      }
  }
  if (expected && 'outcome_id' in expected) {
    const members = proposal.action === 'reject_evidence' ? [] : expected.receipts
    if (members.length !== preview.receipts.length) fail()
    const byId = new Map(members.map((row) => [row.attempt_id, row]))
    for (const row of preview.receipts) {
      const original = byId.get(row.attemptId)
      if (
        !original ||
        original.request_id !== row.requestId ||
        original.reservation_id !== row.reservationId ||
        original.retained_hash !== row.retainedHash ||
        (row.before?.hash ?? null) !== original.current_hash ||
        row.retainedError !== original.retained_error ||
        row.recordedError !== (original.current ? original.recorded_error : original.retained_error)
      )
        fail()
      const selected = await physical(
        original.retained,
        original.request_id,
        original.reservation_id
      )
      if (!(await same(selected, row.physical))) fail()
      const accepted = result.changes.find((change) => change.attempt_id === row.attemptId)!
      // Only the linked revision marker may differ. Merely conserving the total
      // would still allow moving money or quantities between member shares.
      if (!(await same(selectedShare(original.retained), selectedShare(accepted.cost)))) fail()
    }
  } else if (expected && !(await same(cleanPreview(expected, workspace), preview))) fail()
  return preview
}
export async function groupDispositionAcknowledgement(
  result: GroupDispositionResult,
  basis: GroupDispositionBasis,
  workspace: string
) {
  const record = basis.disposition
  if (
    !record ||
    (await costHash({ ...result, replayed: false })) !== record.result_hash ||
    result.id !== record.id ||
    result.action !== record.action
  )
    fail()
  return groupDispositionReply(
    result,
    {
      id: record.id,
      action: record.action,
      expected_basis_hash: result.basis_hash,
      expected_outcome_hash: basis.outcome_hash,
      reason: 'acknowledgement-only',
      confirm: true
    },
    workspace,
    record.actor_id,
    basis.outcome_id,
    false
  )
}
export const pendingGroupDispositionKey = (workspace: string, actor: string, outcomeId: string) =>
  `siftgate:pending-group-disposition:v1:${JSON.stringify([workspace, actor, outcomeId])}`
function cleanRecord(value: PendingGroupDisposition): PendingGroupDisposition {
  if (!value || value.version !== 1 || !text(value.workspace, 128) || !text(value.actor, 128))
    fail()
  const proposal = cleanDispositionProposal(value.proposal),
    preview = cleanPreview(value.preview, value.workspace)
  if (
    value.outcomeId !== `runtime-group:${proposal.expected_outcome_hash}` ||
    preview.action !== proposal.action
  )
    fail()
  return {
    version: 1,
    workspace: value.workspace,
    actor: value.actor,
    outcomeId: value.outcomeId,
    proposal,
    preview
  }
}
export function savePendingGroupDisposition(
  storage: Pick<Storage, 'setItem'>,
  value: PendingGroupDisposition
) {
  const safe = cleanRecord(value),
    json = JSON.stringify(safe)
  if (json.length > 2 * 1024 * 1024) fail()
  storage.setItem(pendingGroupDispositionKey(safe.workspace, safe.actor, safe.outcomeId), json)
}
export function loadPendingGroupDisposition(
  storage: Pick<Storage, 'getItem'>,
  workspace: string,
  actor: string,
  outcomeId: string
): PendingGroupDisposition | null {
  const json = storage.getItem(pendingGroupDispositionKey(workspace, actor, outcomeId))
  if (json === null) return null
  if (json.length > 2 * 1024 * 1024) fail()
  const value = cleanRecord(JSON.parse(json) as PendingGroupDisposition)
  if (value.workspace !== workspace || value.actor !== actor || value.outcomeId !== outcomeId)
    fail()
  return value
}

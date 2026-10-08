import { costHash } from './usage-recovery-form'
import type {
  MediaLookupBasis,
  MediaLookupInput,
  MediaLookupPreview,
  MediaSupplierSource,
} from '@/types/pricing'

const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
const text = (v: unknown, max = 256): v is string => typeof v === 'string' && v.length > 0 && v.length <= max
const money = (v: unknown) => v === null || (typeof v === 'string' && /^\d{1,30}(?:\.\d{1,18})?$/.test(v))
const fail = (): never => {
  throw new Error('invalid_media_response')
}
export const validJobId = (v: string) =>
  typeof v === 'string' &&
  v.length <= 160 &&
  /^[A-Za-z0-9_.:/-]+$/.test(v) &&
  !/\b(?:https?:|Bearer|gw_sk_|sk-)/i.test(v) &&
  !v.split('/').some((p) => p === '.' || p === '..')
export interface LookupReceipt {
  id: string
  task_id: string
  provider_job_id: string
  observation_id: string
  record_hash: string
  preview: MediaLookupPreview
  replayed: boolean
  dry_run: false
  processing_pending?: boolean
}
export interface PendingLookup {
  version: 1
  workspace: string
  actor: string
  task: string
  proposal: MediaLookupInput
}
export function cleanLookup(input: MediaLookupInput): MediaLookupInput {
  if (
    !input ||
    !text(input.id, 128) ||
    !/^[A-Za-z0-9_-]+$/.test(input.id) ||
    !validJobId(input.provider_job_id) ||
    ![input.expected_basis_hash, input.expected_observation_hash, input.expected_cost_hash].every(hash) ||
    !text(input.reason, 1000) ||
    !input.reason.trim() ||
    input.confirm !== true
  )
    fail()
  return {
    id: input.id,
    provider_job_id: input.provider_job_id,
    expected_basis_hash: input.expected_basis_hash,
    expected_observation_hash: input.expected_observation_hash,
    expected_cost_hash: input.expected_cost_hash,
    reason: input.reason,
    confirm: true,
  }
}
export async function verifyLookupPreview(
  value: MediaLookupPreview,
  expected: { task: string; basis: string; job: string; credential?: string | null },
): Promise<MediaLookupPreview> {
  if (
    !value ||
    value.dry_run !== true ||
    value.task_id !== expected.task ||
    value.basis_hash !== expected.basis ||
    value.observation?.provider_job_id !== expected.job ||
    !text(value.observation.credential_id) ||
    (expected.credential && value.observation.credential_id !== expected.credential) ||
    value.association_source !== 'administrator_attestation' ||
    value.supplier_invoice_confirmed !== false ||
    value.time_note !== 'unknown_provider_instants_not_invented' ||
    !hash(value.observation_hash) ||
    !hash(value.cost_hash)
  )
    fail()
  if (
    value.observation_hash !== (await costHash(value.observation)) ||
    value.cost_hash !== (await costHash(value.cost)) ||
    (await costHash(value.observation.usage)) !== (await costHash(value.cost.usage))
  )
    fail()
  if (
    !['pending', 'completed', 'failed', 'cancelled'].includes(value.observation.status) ||
    value.cost.report_currency !== 'USD' ||
    ![
      'priced',
      'estimated',
      'partial',
      'unpriced',
      'missing_usage',
      'pending',
      'free',
      'legacy_estimate',
    ].includes(value.cost.status) ||
    !money(value.cost.report_amount) ||
    !money(value.cost.amount) ||
    !money(value.cost.known_subtotal) ||
    !money(value.cost.report_known_subtotal) ||
    !Array.isArray(value.cost.lines) ||
    value.cost.lines.length > 4096 ||
    !Array.isArray(value.cost.diagnostics)
  )
    fail()
  return value
}
export async function verifyLookupReceipt(
  value: LookupReceipt,
  task: string,
  proposal: MediaLookupInput,
): Promise<LookupReceipt> {
  if (
    !value ||
    value.id !== proposal.id ||
    value.task_id !== task ||
    value.provider_job_id !== proposal.provider_job_id ||
    value.dry_run !== false ||
    typeof value.replayed !== 'boolean' ||
    !text(value.observation_id) ||
    !hash(value.record_hash) ||
    (value.processing_pending !== undefined && typeof value.processing_pending !== 'boolean')
  )
    fail()
  await verifyLookupPreview(value.preview, {
    task,
    basis: proposal.expected_basis_hash,
    job: proposal.provider_job_id,
  })
  if (
    value.preview.observation_hash !== proposal.expected_observation_hash ||
    value.preview.cost_hash !== proposal.expected_cost_hash
  )
    fail()
  return value
}
export function lookupProposal(
  basis: MediaLookupBasis,
  preview: MediaLookupPreview,
  reason: string,
): MediaLookupInput {
  if (basis.blocked_reason || basis.basis_hash !== preview.basis_hash || basis.task_id !== preview.task_id)
    fail()
  return cleanLookup({
    id: crypto.randomUUID(),
    provider_job_id: preview.observation.provider_job_id,
    expected_basis_hash: preview.basis_hash,
    expected_observation_hash: preview.observation_hash,
    expected_cost_hash: preview.cost_hash,
    reason: reason.trim(),
    confirm: true,
  })
}
const pendingKey = (kind: string, workspace: string, actor: string, id: string) =>
  `pricing-media:${kind}:${JSON.stringify([workspace, actor, id])}`
export const lookupPendingKey = (w: string, a: string, id: string) => pendingKey('lookup', w, a, id)
export function saveLookup(storage: Pick<Storage, 'setItem'>, value: PendingLookup) {
  const proposal = cleanLookup(value.proposal)
  storage.setItem(
    lookupPendingKey(value.workspace, value.actor, value.task),
    JSON.stringify({
      version: 1,
      workspace: value.workspace,
      actor: value.actor,
      task: value.task,
      proposal,
    }),
  )
}
export function loadLookup(
  storage: Pick<Storage, 'getItem'>,
  workspace: string,
  actor: string,
  task: string,
): PendingLookup | null {
  const raw = storage.getItem(lookupPendingKey(workspace, actor, task))
  if (!raw) return null
  if (raw.length > 16384) fail()
  const value = JSON.parse(raw) as PendingLookup
  if (value.version !== 1 || value.workspace !== workspace || value.actor !== actor || value.task !== task)
    fail()
  return { version: 1, workspace, actor, task, proposal: cleanLookup(value.proposal) }
}
export interface SourceInput {
  revision: number
  node_id: string
  credential_id: string
  secret_env: string
  enabled: boolean
  reason: string
  confirm: true
}
export interface SourceDraft {
  id: string
  node: string
  credential: string
  secretEnv: string
  enabled: boolean
  reason: string
}
export interface PendingSource {
  version: 1
  workspace: string
  actor: string
  id: string
  input: SourceInput
}
export function sourceDraft(source?: MediaSupplierSource): SourceDraft {
  return {
    id: source?.id ?? '',
    node: source?.node_id ?? '',
    credential: source?.credential_id ?? '',
    secretEnv: source?.secret_env ?? 'SIFTGATE_MEDIA_EVENT_',
    enabled: source?.enabled === 1,
    reason: '',
  }
}
export function cleanSource(input: SourceInput): SourceInput {
  if (
    !input ||
    !Number.isSafeInteger(input.revision) ||
    input.revision < 0 ||
    input.revision > 1000000000 ||
    !text(input.node_id, 128) ||
    !text(input.credential_id, 128) ||
    !/^SIFTGATE_MEDIA_EVENT_[A-Z0-9_]{1,96}$/.test(input.secret_env) ||
    typeof input.enabled !== 'boolean' ||
    !text(input.reason, 1000) ||
    !input.reason.trim() ||
    input.confirm !== true
  )
    fail()
  return {
    revision: input.revision,
    node_id: input.node_id,
    credential_id: input.credential_id,
    secret_env: input.secret_env,
    enabled: input.enabled,
    reason: input.reason,
    confirm: true,
  }
}
export function sourceInput(draft: SourceDraft, revision: number): SourceInput {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(draft.id)) fail()
  return cleanSource({
    revision,
    node_id: draft.node.trim(),
    credential_id: draft.credential.trim(),
    secret_env: draft.secretEnv.trim(),
    enabled: draft.enabled,
    reason: draft.reason.trim(),
    confirm: true,
  })
}
export async function verifySource(value: MediaSupplierSource, workspace: string, id: string) {
  if (
    !value ||
    value.workspace_id !== workspace ||
    value.id !== id ||
    !hash(value.connection_hash) ||
    !hash(value.config_hash) ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1 ||
    ![0, 1].includes(value.enabled) ||
    !text(value.audit_id) ||
    !text(value.node_id) ||
    !text(value.credential_id) ||
    !/^SIFTGATE_MEDIA_EVENT_[A-Z0-9_]{1,96}$/.test(value.secret_env)
  )
    fail()
  const { node_id, credential_id, connection_hash, secret_env, revision, enabled } = value
  if (
    (await costHash({
      id,
      workspace_id: workspace,
      node_id,
      credential_id,
      connection_hash,
      secret_env,
      revision,
      enabled,
    })) !== value.config_hash
  )
    fail()
  return value
}
export const matchesSource = (value: MediaSupplierSource, input: SourceInput) =>
  value.revision === input.revision + 1 &&
  value.node_id === input.node_id &&
  value.credential_id === input.credential_id &&
  value.secret_env === input.secret_env &&
  value.enabled === Number(input.enabled)
export const sourcePendingKey = (w: string, a: string, id: string) => pendingKey('source', w, a, id)
export function saveSource(storage: Pick<Storage, 'setItem'>, value: PendingSource, slot = value.id) {
  storage.setItem(
    sourcePendingKey(value.workspace, value.actor, slot),
    JSON.stringify({
      version: 1,
      workspace: value.workspace,
      actor: value.actor,
      id: value.id,
      input: cleanSource(value.input),
    }),
  )
}
export function loadSource(
  storage: Pick<Storage, 'getItem'>,
  workspace: string,
  actor: string,
  id: string,
): PendingSource | null {
  const raw = storage.getItem(sourcePendingKey(workspace, actor, id))
  if (!raw) return null
  if (raw.length > 16384) fail()
  const value = JSON.parse(raw) as PendingSource
  if (
    value.version !== 1 ||
    value.workspace !== workspace ||
    value.actor !== actor ||
    (id !== '$new' && value.id !== id) ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(value.id)
  )
    fail()
  return { version: 1, workspace, actor, id: value.id, input: cleanSource(value.input) }
}

export function verifyLookupBasis(
  value: MediaLookupBasis,
  workspace: string,
  task: string,
): MediaLookupBasis {
  if (
    !value ||
    value.workspace_id !== workspace ||
    value.task_id !== task ||
    !hash(value.basis_hash) ||
    !hash(value.connection_hash) ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    !(value.credential_id === null || text(value.credential_id)) ||
    !(value.blocked_reason === null || typeof value.blocked_reason === 'string')
  )
    fail()
  return value
}
export async function verifyMediaPage<T>(value: T, key: string, workspace: string): Promise<T> {
  const page = value as Record<string, unknown>,
    kind = key.split(':')[0],
    field = kind === 'tasks' ? 'tasks' : kind === 'events' ? 'events' : 'sources'
  if (
    !page ||
    !(
      page.next_cursor === null ||
      (typeof page.next_cursor === 'string' && /^[A-Za-z0-9_-]{1,2048}$/.test(page.next_cursor))
    ) ||
    !Array.isArray(page[field]) ||
    page[field].length > 20 ||
    page.limit !== 20 ||
    typeof page.has_more !== 'boolean' ||
    page.has_more !== Boolean(page.next_cursor)
  )
    fail()
  const ids = new Set<string>(),
    rows = page[field] as Array<Record<string, unknown>>
  for (const entry of rows) {
    if (!entry || !text(entry.id) || ids.has(entry.id as string)) fail()
    ids.add(entry.id as string)
    if (
      field === 'tasks' &&
      (entry.workspace_id !== workspace ||
        !['uncertain', 'pending', 'terminal', 'settled', 'reserved', 'submitted', 'synchronous'].includes(
          String(entry.state),
        ))
    )
      fail()
    if (
      field === 'events' &&
      (!['applied', 'ignored_stale', 'ignored_regression', 'review_required'].includes(
        String(entry.decision),
      ) ||
        entry.supplier_invoice_confirmed !== false ||
        !hash(entry.document_hash) ||
        !['authenticated_connector', 'unversioned_observation'].includes(String(entry.origin)))
    )
      fail()
    if (field === 'sources')
      await verifySource(entry as unknown as MediaSupplierSource, workspace, entry.id as string)
  }
  if (field === 'tasks' && (page.coverage !== 'persisted_media_tasks' || page.view !== key.slice(6))) fail()
  return value
}

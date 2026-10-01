import type { PricingBookManagement, PricingBookOwner, PricingBookOwnerUpdate } from '../../../src/pricing/pricing-book-management.types'

const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_response')
  return value as Record<string, unknown>
}
const integer = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0
const validOwner = (value: unknown): value is string | null => value === null || (typeof value === 'string' && value.length > 0 && value.length <= 128 && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value))

export function verifyBookManagement(value: unknown, bookId: string): PricingBookManagement {
  const row = record(value), lifecycle = record(row.lifecycle)
  if (row.book_id !== bookId || !validOwner(row.owner) || !integer(row.revision) || (row.revision as number) > 1000000000 ||
    !integer(row.catalog_revision) || typeof row.evaluated_at !== 'string' || !Number.isFinite(Date.parse(row.evaluated_at)) ||
    (row.revision === 0 ? row.owner !== null || row.updated_by !== null || row.updated_at !== null : typeof row.updated_by !== 'string' || !row.updated_by || typeof row.updated_at !== 'string' || !Number.isFinite(Date.parse(row.updated_at))) ||
    !['draft_count', 'version_count', 'active_bindings', 'scheduled_bindings'].every(key => integer(lifecycle[key]))) throw new Error('invalid_response')
  const expected = (lifecycle.active_bindings as number) > 0 ? 'active' : (lifecycle.scheduled_bindings as number) > 0 ? 'scheduled' : (lifecycle.version_count as number) > 0 ? 'inactive' : 'draft'
  if (lifecycle.state !== expected) throw new Error('invalid_response')
  return value as PricingBookManagement
}

export function bookOwnerUpdate(basis: PricingBookManagement, owner: string, reason: string, confirm: boolean): PricingBookOwnerUpdate {
  const normalized = owner.trim() || null
  if (!validOwner(normalized) || !integer(basis.revision) || basis.revision >= 1000000000 || !reason.trim() || reason.length > 1000 || !confirm) throw new Error('invalid_owner_update')
  return { owner: normalized, revision: basis.revision, reason: reason.trim(), confirm: true }
}

export function verifyBookOwnerAcknowledgement(value: unknown, basis: PricingBookManagement, input: PricingBookOwnerUpdate): PricingBookOwner {
  const row = record(value)
  if (row.book_id !== basis.book_id || row.owner !== input.owner || row.revision !== basis.revision + (basis.owner === input.owner ? 0 : 1) ||
    typeof row.updated_by !== 'string' || !row.updated_by || typeof row.updated_at !== 'string' || !Number.isFinite(Date.parse(row.updated_at))) throw new Error('invalid_response')
  return value as PricingBookOwner
}

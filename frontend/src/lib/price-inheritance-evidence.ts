import { costHash } from './usage-recovery-form'
import type {
  PriceBookContent,
  PriceBookParentReference,
  PricingInheritanceDefinition,
  PricingInheritanceView,
} from '@/types/pricing'

export interface ParentPrice extends PriceBookParentReference {
  content: PriceBookContent
  inheritance?: PricingInheritanceView
}
export interface InheritancePreview {
  dry_run: true
  content: PriceBookContent
  content_hash: string
  inheritance: PricingInheritanceView
  warnings: string[]
}
const canonical = (v: unknown): string =>
  Array.isArray(v)
    ? `[${v.map(canonical).join(',')}]`
    : v !== null && typeof v === 'object'
      ? `{${Object.keys(v)
          .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
          .join(',')}}`
      : JSON.stringify(v)
export const samePriceValue = (a: unknown, b: unknown) => canonical(a) === canonical(b)
export const inheritanceError = (): never => {
  throw new Error('invalid_price_inheritance')
}
export const parentReference = (parent: ParentPrice): PriceBookParentReference => ({
  book_id: parent.book_id,
  version_id: parent.version_id,
  content_hash: parent.content_hash,
})
const sorted = (content: PriceBookContent): PriceBookContent => ({
  ...content,
  groups: [...content.groups].sort((a, b) => a.order - b.order),
})
export async function verifyParentPrice(
  parent: ParentPrice,
  expected: PriceBookParentReference,
): Promise<ParentPrice> {
  if (
    !parent ||
    !samePriceValue(parentReference(parent), expected) ||
    (await costHash(parent.content)) !== expected.content_hash
  )
    inheritanceError()
  if (parent.inheritance) await verifyPriceInheritance(parent.inheritance, expected.content_hash)
  return parent
}
export async function verifyPriceInheritance(
  view: PricingInheritanceView,
  contentHash: string,
): Promise<void> {
  if (
    !view?.definition ||
    !view.provenance ||
    !Array.isArray(view.ancestors) ||
    !view.ancestors.length ||
    view.ancestors.length > 16 ||
    !samePriceValue(view.provenance.parent, view.definition.parent) ||
    view.provenance.definition_hash !== (await costHash(view.definition)) ||
    view.provenance.resolved_content_hash !== contentHash
  )
    inheritanceError()
  const { lineage_hash, ...payload } = view
  if (
    lineage_hash !== (await costHash(payload)) ||
    !samePriceValue({ ...view.ancestors[0], lineage_hash: undefined }, view.definition.parent)
  )
    inheritanceError()
  const ids = new Set<string>()
  for (const ancestor of view.ancestors) {
    const id = JSON.stringify([ancestor.book_id, ancestor.version_id])
    if (
      !ancestor.book_id ||
      !ancestor.version_id ||
      !/^[a-f0-9]{64}$/.test(ancestor.content_hash) ||
      !(ancestor.lineage_hash === null || /^[a-f0-9]{64}$/.test(ancestor.lineage_hash)) ||
      ids.has(id)
    )
      inheritanceError()
    ids.add(id)
  }
}
export async function verifyInheritancePreview(
  value: InheritancePreview,
  definition: PricingInheritanceDefinition,
  expected?: PriceBookContent,
): Promise<InheritancePreview> {
  if (
    !value ||
    value.dry_run !== true ||
    !value.inheritance ||
    !samePriceValue(value.inheritance.definition, definition) ||
    value.content_hash !== (await costHash(value.content)) ||
    !Array.isArray(value.warnings)
  )
    inheritanceError()
  await verifyPriceInheritance(value.inheritance, value.content_hash)
  if (expected && !samePriceValue(sorted(expected), value.content)) inheritanceError()
  return value
}

/** Publication creates a new version ID, but may not change previewed prices or lineage. */
export async function verifyPublishedPrice(
  value: {
    version_id: string
    content_hash: string
    inheritance?: PricingInheritanceView
    head: { revision: number }
  },
  expected: { content_hash: string; inheritance?: PricingInheritanceView; head: { revision: number } },
): Promise<void> {
  if (
    !value ||
    typeof value.version_id !== 'string' ||
    !value.version_id ||
    value.content_hash !== expected.content_hash ||
    !samePriceValue(value.inheritance, expected.inheritance) ||
    value.head?.revision !== expected.head.revision + 1
  )
    inheritanceError()
  if (value.inheritance) await verifyPriceInheritance(value.inheritance, value.content_hash)
}

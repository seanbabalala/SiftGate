import type { MeterDimension, NormalizedUsage } from '@/types/pricing'

export interface EvidenceField { dimension: MeterDimension; value: string; missing: boolean }

export function correctionFields(usage: NormalizedUsage): EvidenceField[] {
  return Object.values(usage.quantities).filter((quantity) => quantity !== undefined).map((quantity) => ({ dimension: quantity!.dimension, value: quantity!.value ?? '', missing: quantity!.value === null || quantity!.quality === 'missing' || quantity!.quality === 'unsupported' }))
}

/** Administrator attestation never inherits a provider-observed label merely by copying a form. */
export function correctionEvidence(fields: EvidenceField[]) {
  const seen = new Set<MeterDimension>()
  return fields.map((field) => {
    if (seen.has(field.dimension)) throw new Error('duplicate_dimension')
    seen.add(field.dimension)
    return { dimension: field.dimension, value: field.missing || !field.value.trim() ? null : field.value.trim(), source: 'request_metadata' as const, quality: field.missing || !field.value.trim() ? 'missing' as const : 'observed' as const }
  })
}

export function makeCorrectionProposal(hash: string, reason: string, fields: EvidenceField[]) {
  return { id: crypto.randomUUID(), expected_physical_cost_hash: hash, reason: reason.trim(), confirm: true as const, evidence: correctionEvidence(fields) }
}
export type CorrectionProposal = ReturnType<typeof makeCorrectionProposal>

const displayFormats = new Map<string, { integer: Intl.NumberFormat; decimal: string }>()

export function exactDisplay(value: string | null | undefined, locale: string): string {
  if (value === null || value === undefined) return '—'
  if (!/^-?\d+(?:\.\d+)?$/.test(value)) return value
  const [whole, fraction] = value.split('.')
  let formats = displayFormats.get(locale)
  if (!formats) {
    const integer = new Intl.NumberFormat(locale)
    formats = { integer, decimal: integer.formatToParts(1.1).find((part) => part.type === 'decimal')?.value ?? '.' }
    displayFormats.set(locale, formats)
  }
  const grouped = formats.integer.format(BigInt(whole))
  const negativeZero = whole.startsWith('-') && BigInt(whole) === 0n ? '-' : ''
  return `${negativeZero}${grouped}${fraction === undefined ? '' : formats.decimal + fraction}`
}

/** Remove scale padding, not significant digits. Never coerce ledger decimals to Number. */
export function compactExactDisplay(value: string | null | undefined, locale: string): string {
  if (typeof value !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(value)) return exactDisplay(value, locale)
  const trimmed = value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value
  return exactDisplay(/^-?0+$/.test(trimmed) ? '0' : trimmed, locale)
}

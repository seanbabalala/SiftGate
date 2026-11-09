export const legacyCacheFields = ['cache_read_input', 'cache_creation_input'] as const
export type LegacyCacheField = typeof legacyCacheFields[number]
export interface LegacyPricingRow {
  model: string
  input: string
  output: string
  cache_read_input?: string
  cache_creation_input?: string
  dirty?: boolean
  cache_dirty?: Partial<Record<LegacyCacheField, boolean>>
}

/** Catalog references are display-only until the corresponding field is edited. */
export function legacyPricingFields(pricing?: {
  input?: number | null; output?: number | null
  cache_read_input?: number | null; cache_creation_input?: number | null
  cache_read_per_1m_tokens?: number | null; cache_write_per_1m_tokens?: number | null
}) {
  return {
    input: String(pricing?.input ?? ''),
    output: String(pricing?.output ?? ''),
    cache_read_input: String(pricing?.cache_read_input ?? pricing?.cache_read_per_1m_tokens ?? ''),
    cache_creation_input: String(pricing?.cache_creation_input ?? pricing?.cache_write_per_1m_tokens ?? ''),
  }
}
export function legacyPriceNumber(value: string): number | undefined {
  const text = value.trim()
  if (!text || !/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) return undefined
  const parsed = Number(text)
  if (!Number.isFinite(parsed) || parsed < 0 || parsed === 0 && /[1-9]/.test(text.split(/e/i)[0])) return undefined
  return parsed
}
export function collectLegacyPricingUpdates(rows: LegacyPricingRow[], removed: string[]) {
  const edited = rows.filter((row) => row.dirty && (row.input.trim() || row.output.trim() || legacyCacheFields.some(field => row.cache_dirty?.[field])))
  const names = edited.map((row) => row.model.trim())
  if (names.some((name) => !name) || new Set(names).size !== names.length) throw new Error('invalid_legacy_prices')
  const values = edited.map((row) => {
    const input = legacyPriceNumber(row.input), output = legacyPriceNumber(row.output)
    if (input === undefined || output === undefined) throw new Error('invalid_legacy_prices')
    const cache: Partial<Record<LegacyCacheField, number | null>> = {}
    for (const field of legacyCacheFields) {
      if (!row.cache_dirty?.[field]) continue
      const text = row[field]?.trim() ?? ''
      const price = text ? legacyPriceNumber(text) : null
      if (price === undefined) throw new Error('invalid_legacy_prices')
      cache[field] = price
    }
    return { model: row.model.trim(), action: 'set' as const, input, output, ...cache }
  })
  return [...[...new Set(removed)].filter((model) => !names.includes(model)).map((model) => ({ model, action: 'inherit' as const })), ...values]
}

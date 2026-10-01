export interface LegacyPricingRow { model: string; input: string; output: string; dirty?: boolean }
export function legacyPriceNumber(value: string): number | undefined {
  const text = value.trim()
  if (!text || !/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) return undefined
  const parsed = Number(text)
  if (!Number.isFinite(parsed) || parsed < 0 || parsed === 0 && /[1-9]/.test(text.split(/e/i)[0])) return undefined
  return parsed
}
export function collectLegacyPricingUpdates(rows: LegacyPricingRow[], removed: string[]) {
  const edited = rows.filter((row) => row.dirty && (row.input.trim() || row.output.trim()))
  const names = edited.map((row) => row.model.trim())
  if (names.some((name) => !name) || new Set(names).size !== names.length) throw new Error('invalid_legacy_prices')
  const values = edited.map((row) => {
    const input = legacyPriceNumber(row.input), output = legacyPriceNumber(row.output)
    if (input === undefined || output === undefined) throw new Error('invalid_legacy_prices')
    return { model: row.model.trim(), action: 'set' as const, input, output }
  })
  return [...[...new Set(removed)].filter((model) => !names.includes(model)).map((model) => ({ model, action: 'inherit' as const })), ...values]
}

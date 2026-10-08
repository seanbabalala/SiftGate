import { DIMENSION_UNITS, type BillableDimension, type PriceBookContent, type PricingRule, type RateComponent } from '@/types/pricing'
export const pricingTabs = ['basic', 'context', 'time', 'media', 'simulate', 'versions'] as const
export type PricingTab = typeof pricingTabs[number]
export const billingDimensions = Object.keys(DIMENSION_UNITS).filter((key) => key !== 'total_input_tokens' && key !== 'reasoning_output_tokens') as BillableDimension[]
export const tokenDimensions = billingDimensions.filter((key) => DIMENSION_UNITS[key] === 'token')
export const mediaDimensions = billingDimensions.filter((key) => DIMENSION_UNITS[key] !== 'token')
export const newId = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 8)}`
export function newRule(): PricingRule { return { id: newId('rule'), priority: 0, mode: 'whole_request', condition: {}, rates: [] } }
/** Clearing a label removes only display metadata, never the stable rule ID. */
export function withRuleName(rule: PricingRule, value: string): PricingRule {
  const next = { ...rule }
  if (value === '') delete next.name
  else next.name = value
  return next
}
export function ruleLabel(rule: PricingRule): string { return rule.name ? `${rule.name} · ${rule.id}` : rule.id }
export function newPriceBook(family = 'token', currency = 'USD'): PriceBookContent {
  const dimensions: Record<string, BillableDimension[]> = { token: ['uncached_input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'cache_write_5m_tokens', 'cache_write_1h_tokens'], image: ['image_count'], audio: ['audio_input_seconds'], video: ['video_seconds'], rerank: ['rerank_request_count'] }
  return { schema_version: 1, currency, money_precision: 9, money_rounding: 'half_even', source: { kind: 'manual' }, billing_dimensions: dimensions[family] ?? dimensions.token, allow_combined_media: false, groups: [{ id: 'base', order: 0, required: true, rules: [newRule()] }] }
}
export function newRate(dimension: BillableDimension): RateComponent { return { id: newId('rate'), dimension, amount: '', unit: DIMENSION_UNITS[dimension], unit_size: DIMENSION_UNITS[dimension] === 'token' ? '1000000' : '1' } }
export function changedPaths(before: unknown, after: unknown, prefix = ''): string[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return []
  if (before && after && typeof before === 'object' && typeof after === 'object' && !Array.isArray(before) && !Array.isArray(after)) {
    const left = before as Record<string, unknown>, right = after as Record<string, unknown>
    return [...new Set([...Object.keys(left), ...Object.keys(right)])].flatMap((key) => changedPaths(left[key], right[key], prefix ? `${prefix}.${key}` : key))
  }
  return [prefix || '$']
}
export function portablePriceBook(content: PriceBookContent): PriceBookContent {
  const copy = structuredClone(content)
  if (copy.source.reference) {
    try {
      const url = new URL(copy.source.reference)
      // Normalize the optional DNS root dot before deciding whether a host is private.
      const host = url.hostname.replace(/\.+$/, '').toLowerCase()
      if (!['http:', 'https:'].includes(url.protocol) || !host.includes('.') || /^(?:[0-9.]+|\[.*\])$/.test(host) || /\.(?:localhost|local|internal)$/.test(host)) delete copy.source.reference
      else { url.username = ''; url.password = ''; url.search = ''; url.hash = ''; copy.source.reference = url.toString() }
    } catch { delete copy.source.reference }
  }
  return copy
}
export function downloadPricing(value: unknown, name: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }))
  const link = document.createElement('a'); link.href = url; link.download = `${name.replace(/[^a-z0-9_-]/gi, '_')}.json`; link.click(); URL.revokeObjectURL(url)
}

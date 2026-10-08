import { ExactDecimal } from '../../../src/pricing/exact-decimal'
import { normalizeMediaAttribute, pricingConditionsOverlap } from '../../../src/pricing/pricing-conditions'
import type { PriceBookContent, PricingRule } from '@/types/pricing'
import type { MediaAttribute } from '../../../src/pricing/pricing.types'

export const CONTEXT_ROWS_PER_PAGE = 16
export interface ContextRangeRow { index: number; rule: PricingRule; valid: boolean; conflicts: number[] }
function validRange(rule: PricingRule): boolean {
  if (!Number.isSafeInteger(rule.priority) || rule.priority < 0 || rule.priority > 100000) return false
  const range = rule.condition.input_tokens
  if (!range) return true
  try {
    const min = ExactDecimal.parse(range.min), max = range.max === undefined ? null : ExactDecimal.parse(range.max)
    return min.isInteger() && min.compare(ExactDecimal.zero) >= 0 && (max === null || max.isInteger() && max.compare(min) > 0)
  } catch { return false }
}
/** Advisory only: the same pure overlap predicate as publication, never a second pricing engine. */
export function contextRangeRows(rules: PricingRule[]): ContextRangeRow[] {
  if (rules.length > 128) throw Error('context_rule_limit')
  const conditions = rules.map(rule => {
    try {
      const condition = structuredClone(rule.condition)
      if (condition.media) for (const [key, values] of Object.entries(condition.media)) {
        const attribute = key as MediaAttribute
        condition.media[attribute] = values!.map(value => normalizeMediaAttribute(attribute, value))
      }
      return condition
    } catch { return null }
  })
  const rows = rules.map((rule, index) => ({ rule, index, valid: validRange(rule) && conditions[index] !== null, conflicts: [] as number[] }))
  for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
    const a = rows[i], b = rows[j]
    if (!a.valid || !b.valid || a.rule.priority !== b.rule.priority) continue
    try {
      if (pricingConditionsOverlap(conditions[i]!, conditions[j]!)) { a.conflicts.push(j); b.conflicts.push(i) }
    } catch { a.valid = false; b.valid = false }
  }
  return rows
}
export function editContextRange(content: PriceBookContent, group: number, index: number, range: PricingRule['condition']['input_tokens']): PriceBookContent {
  const next = structuredClone(content), condition = next.groups[group].rules[index].condition
  if (range === undefined) delete condition.input_tokens
  else condition.input_tokens = { ...range }
  return next
}

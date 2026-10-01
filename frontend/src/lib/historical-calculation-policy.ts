import type { CostComputation, PriceBookContent, RateComponent } from '@/types/pricing'
import type { ParentPrice } from './price-inheritance-evidence'

export interface HistoricalCalculationPolicy {
  basis: 'request' | 'physical_batch'
  money: { currency: string; precision: number; rounding: PriceBookContent['money_rounding'] }
  lines: Array<{
    component_id: string
    rule_id: string
    dimension: RateComponent['dimension']
    unit: RateComponent['unit']
    quantity: string
    billed_quantity: string
    minimum_quantity: string | null
    quantity_rounding: RateComponent['quantity_rounding'] | null
  }>
}

/** The caller must first verifyParentPrice against the receipt's version/hash.
 * Match recorded components only: never resolve today's rules or recalculate money.
 * Batch policies explain physical quantities, not the member's allocated usage. */
export function calculationPolicyFromVerifiedVersion(version: ParentPrice | undefined, cost: CostComputation): HistoricalCalculationPolicy | null {
  try {
    if (!version || cost.allocation_failure) return null
    const receipt = cost.batch?.physical_cost ?? cost
    const matches = (value: CostComputation) => value.book_id === version.book_id && value.version_id === version.version_id && value.content_hash === version.content_hash && value.currency === version.content.currency && value.calculator_version === '1'
    if (!matches(cost) || !matches(receipt) || receipt.batch || receipt.allocation_failure) return null
    const { money_precision: precision, money_rounding: rounding } = version.content
    if (!Number.isInteger(precision) || precision < 0 || precision > 18 || !['half_even', 'half_up', 'ceil', 'floor'].includes(rounding)) return null
    const components = new Map<string, { rule: string; component: RateComponent }>()
    for (const group of version.content.groups) for (const rule of group.rules) for (const { component } of rule.rates) {
      if (components.has(component.id)) return null
      components.set(component.id, { rule: rule.id, component })
    }
    const seen = new Set<string>(), lines: HistoricalCalculationPolicy['lines'] = []
    for (const line of receipt.lines) {
      const original = components.get(line.component_id), component = original?.component
      if (!original || !component || seen.has(line.component_id) || original.rule !== line.rule_id || !receipt.selected_rule_ids.includes(line.rule_id) ||
        component.dimension !== line.dimension || component.unit !== line.unit || component.unit_size !== line.unit_size || component.amount !== line.rate || line.currency !== version.content.currency) return null
      seen.add(line.component_id)
      lines.push({ component_id: line.component_id, rule_id: line.rule_id, dimension: line.dimension, unit: line.unit,
        quantity: line.quantity, billed_quantity: line.billed_quantity, minimum_quantity: component.minimum_quantity ?? null,
        quantity_rounding: component.quantity_rounding ? { ...component.quantity_rounding } : null })
    }
    return { basis: cost.batch ? 'physical_batch' : 'request', money: { currency: version.content.currency, precision, rounding }, lines }
  } catch {
    return null
  }
}

import {
  inheritanceError as fail,
  parentReference as ref,
  samePriceValue,
  type ParentPrice,
} from './price-inheritance-evidence'
export { samePriceValue, verifyInheritancePreview, verifyParentPrice } from './price-inheritance-evidence'
export type { ParentPrice, InheritancePreview } from './price-inheritance-evidence'
import { portablePriceBook } from './pricing-model'
import type {
  PriceBookContent,
  PricingInheritanceDefinition,
  PricingInheritanceView,
  PricingRuleGroup,
} from '@/types/pricing'

export interface PriceCopy {
  content: PriceBookContent
  inheritance?: PricingInheritanceView
}
export function newInheritanceDefinition(parent: ParentPrice): PricingInheritanceDefinition {
  return {
    schema_version: 1,
    parent: ref(parent),
    inherit: 'all',
    source: { kind: 'manual' },
    rate_overrides: [],
    removed_component_ids: [],
    replaced_groups: [],
    added_groups: [],
    removed_group_ids: [],
    settings: {},
    calendar: { mode: 'inherit' },
  }
}
function structure(group: PricingRuleGroup) {
  return {
    ...group,
    rules: group.rules.map(({ rates, ...rule }) => ({
      ...rule,
      rates: rates.map((r) => ({
        operation: r.operation,
        id: r.component.id,
        dimension: r.component.dimension,
        unit: r.component.unit,
      })),
    })),
  }
}
/** Build a declarative recipe from a full editor document. No price calculation or current-catalog lookup. */
export function inheritedDefinition(
  parent: ParentPrice,
  content: PriceBookContent,
  prior?: PriceCopy,
  reset?: { component?: string; group?: string; calendar?: boolean; specification?: boolean },
): PricingInheritanceDefinition {
  if (content.currency !== parent.content.currency) fail()
  const definition = newInheritanceDefinition(parent),
    before = prior?.inheritance?.definition
  definition.source = structuredClone(content.source)
  const previous = samePriceValue(before?.parent, ref(parent)) ? before : undefined
  const originalGroups = new Map(parent.content.groups.map((g) => [g.id, g])),
    afterGroups = new Map(content.groups.map((g) => [g.id, g]))
  if (afterGroups.size !== content.groups.length) fail()
  for (const old of parent.content.groups) {
    const next = afterGroups.get(old.id)
    if (!next) {
      definition.removed_group_ids.push(old.id)
      continue
    }
    const priorGroup = prior?.content.groups.find((g) => g.id === old.id)
    // A whole-group replacement is explicit intent, even if some rates happen
    // to equal the parent. Only the group reset action removes that intent.
    if (reset?.group !== old.id && previous?.replaced_groups.some((g) => g.id === old.id)) {
      definition.replaced_groups.push(structuredClone(next))
      continue
    }
    // Removing a component does not replace the entire group. New rates, moved
    // rules, changed conditions/multipliers/operations use explicit replacement.
    const remainingIds = new Set(next.rules.flatMap((r) => r.rates.map((e) => e.component.id)))
    const reduced = {
      ...old,
      rules: old.rules.map((rule) => ({
        ...rule,
        rates: rule.rates.filter((r) => remainingIds.has(r.component.id)),
      })),
    }
    if (!samePriceValue(structure(reduced), structure(next))) {
      definition.replaced_groups.push(structuredClone(next))
      continue
    }
    for (const rule of old.rules)
      for (const entry of rule.rates) {
        const updated = next.rules
          .find((r) => r.id === rule.id)
          ?.rates.find((r) => r.component.id === entry.component.id)
        if (!updated) {
          definition.removed_component_ids.push(entry.component.id)
          continue
        }
        const oldEdited = priorGroup?.rules
          .find((r) => r.id === rule.id)
          ?.rates.find((r) => r.component.id === entry.component.id)
        const keepExplicit =
          reset?.component !== entry.component.id &&
          reset?.group !== old.id &&
          previous?.rate_overrides.some((r) => r.id === entry.component.id) &&
          samePriceValue(oldEdited, updated)
        if (!samePriceValue(updated.component, entry.component) || keepExplicit)
          definition.rate_overrides.push(structuredClone(updated.component))
      }
  }
  for (const group of content.groups)
    if (!originalGroups.has(group.id)) definition.added_groups.push(structuredClone(group))
  for (const key of [
    'money_precision',
    'money_rounding',
    'billing_dimensions',
    'allow_combined_media',
  ] as const) {
    if (
      !samePriceValue(parent.content[key], content[key]) ||
      (previous?.settings[key] !== undefined && samePriceValue(prior?.content[key], content[key]))
    )
      Object.assign(definition.settings, { [key]: structuredClone(content[key]) })
  }
  if (!reset?.specification && (!samePriceValue(parent.content.media_specification, content.media_specification) ||
    previous?.settings.media_specification !== undefined && samePriceValue(prior?.content.media_specification, content.media_specification)))
    definition.settings.media_specification = content.media_specification ? structuredClone(content.media_specification) : null
  const unchangedCalendar = samePriceValue(
    [parent.content.calendar, parent.content.time_basis],
    [content.calendar, content.time_basis],
  )
  if (reset?.calendar) definition.calendar = { mode: 'inherit' }
  else if (
    previous &&
    samePriceValue(
      [prior?.content.calendar, prior?.content.time_basis],
      [content.calendar, content.time_basis],
    )
  )
    definition.calendar = structuredClone(previous.calendar)
  else if (!unchangedCalendar)
    definition.calendar = content.calendar
      ? {
          mode: 'replace',
          document: structuredClone(content.calendar),
          time_basis: content.time_basis ?? 'attempt_dispatched_at',
        }
      : { mode: 'remove' }
  return definition
}
export function portableInheritance(definition: PricingInheritanceDefinition, content: PriceBookContent) {
  return {
    ...structuredClone(definition),
    source: portablePriceBook({ ...content, source: definition.source }).source,
  }
}
export function priceExport(content: PriceBookContent, definition?: PricingInheritanceDefinition) {
  return definition
    ? { format: 'siftgate-inherited-price-book-v1', definition: portableInheritance(definition, content) }
    : { format: 'siftgate-price-book-v1', content: portablePriceBook(content) }
}
export function resetInheritedComponent(
  parent: ParentPrice,
  current: PriceBookContent,
  componentId: string,
): PriceBookContent {
  const next = structuredClone(current)
  for (const group of parent.content.groups)
    for (const rule of group.rules) {
      const original = rule.rates.find((r) => r.component.id === componentId)
      if (!original) continue
      const target = next.groups.find((g) => g.id === group.id)?.rules.find((r) => r.id === rule.id)
      if (!target) fail()
      for (const localGroup of next.groups)
        for (const localRule of localGroup.rules)
          if (localRule !== target)
            localRule.rates = localRule.rates.filter((r) => r.component.id !== componentId)
      const index = target!.rates.findIndex((r) => r.component.id === componentId)
      if (index < 0) {
        const before = rule.rates.slice(0, rule.rates.indexOf(original)).map((r) => r.component.id)
        const slot = target!.rates.findIndex((r) => !before.includes(r.component.id))
        target!.rates.splice(slot < 0 ? target!.rates.length : slot, 0, structuredClone(original))
      } else target!.rates[index] = structuredClone(original)
      return next
    }
  return fail()
}
export function resetInheritedGroup(parent: ParentPrice, current: PriceBookContent, id: string) {
  const group = parent.content.groups.find((g) => g.id === id)
  if (!group) fail()
  return {
    ...structuredClone(current),
    groups: [...current.groups.filter((g) => g.id !== id), structuredClone(group!)].sort(
      (a, b) => a.order - b.order,
    ),
  }
}

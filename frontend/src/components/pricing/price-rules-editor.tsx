import { useTranslation } from 'react-i18next'
import { Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { PriceInput, PriceSelect, PriceTokens } from './pricing-fields'
import { newId, newRate, newRule, billingDimensions, withRuleName, ruleLabel } from '@/lib/pricing-model'
import { DIMENSION_UNITS, MEDIA_ATTRIBUTES, type BillableDimension, type PriceBookContent, type PricingRule, type RateComponent } from '@/types/pricing'

export function RuleSelector({ content, groupIndex, ruleIndex, select, onChange, disabled }: { content: PriceBookContent; groupIndex: number; ruleIndex: number; select: (group: number, rule: number) => void; onChange: (next: PriceBookContent) => void; disabled: boolean }) {
  const { t } = useTranslation('pricing')
  const group = content.groups[groupIndex]
  return <div className="space-y-3 border-b border-[var(--border)] pb-5">
    <div className="grid items-end gap-3 sm:grid-cols-[1fr_1fr_auto]">
      <PriceSelect label={t('rule.group')} value={String(groupIndex)} options={content.groups.map((item, index) => ({ value: String(index), label: `${item.order} · ${item.id}` }))} onChange={(value) => select(Number(value), 0)} />
      <PriceSelect label={t('rule.selected')} value={String(ruleIndex)} options={(group?.rules ?? []).map((item, index) => ({ value: String(index), label: ruleLabel(item) }))} onChange={(value) => select(groupIndex, Number(value))} />
      <div className="flex gap-2"><Button size="sm" variant="outline" disabled={disabled || content.groups.length >= 16} onClick={() => { const order = Math.max(...content.groups.map((item) => item.order)) + 1; onChange({ ...content, groups: [...content.groups, { id: newId('group'), order, required: false, rules: [newRule()] }] }); select(content.groups.length, 0) }}>{t('rule.addGroup')}</Button>
        <Button size="sm" variant="outline" disabled={disabled || !group} onClick={() => { const next = structuredClone(content); const rule = newRule(); rule.priority = Math.max(...group.rules.map((item) => item.priority)) + 1; next.groups[groupIndex].rules.push(rule); onChange(next); select(groupIndex, group.rules.length) }}>{t('rule.addRule')}</Button></div>
    </div><p className="text-xs leading-5 text-[var(--foreground-muted)]">{t('rule.orderHelp')}</p>
  </div>
}

export function RuleConditionEditor({ content, groupIndex, ruleIndex, onChange, kind }: { content: PriceBookContent; groupIndex: number; ruleIndex: number; onChange: (next: PriceBookContent) => void; kind: 'context' | 'time' | 'media' }) {
  const { t } = useTranslation('pricing')
  const group = content.groups[groupIndex], rule = group.rules[ruleIndex]
  const patch = (change: Partial<PricingRule>) => { const next = structuredClone(content); next.groups[groupIndex].rules[ruleIndex] = { ...rule, ...change }; onChange(next) }
  return <div className="space-y-4">
    {kind === 'context' && <>
      <div className="grid gap-4 sm:grid-cols-2"><PriceInput label={t('rule.groupId')} value={group.id} onChange={(e) => { const next = structuredClone(content); next.groups[groupIndex].id = e.target.value; onChange(next) }} /><PriceInput label={t('rule.groupOrder')} type="number" min={0} max={1024} value={group.order} onChange={(e) => { const next = structuredClone(content); next.groups[groupIndex].order = Number(e.target.value); onChange(next) }} /></div>
      <div className="grid gap-4 sm:grid-cols-3"><PriceInput label={t('rule.id')} value={rule.id} maxLength={128} onChange={(e) => patch({ id: e.target.value })} />
        <PriceInput label={t('rule.priority')} type="number" value={rule.priority} onChange={(e) => patch({ priority: Number(e.target.value) })} />
        <PriceSelect label={t('rule.mode')} value={rule.mode} options={[{ value: 'whole_request', label: t('rule.wholeRequest') }]} onChange={() => {}} /></div>
      <PriceInput label={t('rule.name')} hint={t('rule.nameHelp')} value={rule.name ?? ''} maxLength={128} onChange={(e) => { const next = structuredClone(content); next.groups[groupIndex].rules[ruleIndex] = withRuleName(rule, e.target.value); onChange(next) }} />
      <p className="text-xs text-[var(--foreground-muted)]">{t('rule.segmentedUnavailable')}</p>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={Boolean(rule.condition.input_tokens)} onChange={(e) => { const condition = { ...rule.condition }; if (e.target.checked) condition.input_tokens = { min: '0' }; else delete condition.input_tokens; patch({ condition }) }} />{t('rule.contextCondition')}</label>
      {rule.condition.input_tokens && <div className="grid gap-4 sm:grid-cols-2"><PriceInput label={t('rule.minimumInput')} inputMode="numeric" value={rule.condition.input_tokens.min} onChange={(e) => patch({ condition: { ...rule.condition, input_tokens: { ...rule.condition.input_tokens!, min: e.target.value } } })} />
        <PriceInput label={t('rule.maximumInput')} hint={t('rule.exclusiveMax')} inputMode="numeric" value={rule.condition.input_tokens.max ?? ''} onChange={(e) => patch({ condition: { ...rule.condition, input_tokens: { ...rule.condition.input_tokens!, max: e.target.value || undefined } } })} /></div>}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border)] pt-4"><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={group.required} onChange={(e) => { const next = structuredClone(content); next.groups[groupIndex].required = e.target.checked; onChange(next) }} />{t('rule.required')}</label>
        <div className="flex gap-2"><Button size="sm" variant="ghost" disabled={group.rules.length <= 1} onClick={() => { if (!window.confirm(t('removeConfirm'))) return; const next = structuredClone(content); next.groups[groupIndex].rules.splice(ruleIndex, 1); onChange(next) }}>{t('rule.removeRule')}</Button>
          <Button size="sm" variant="ghost" disabled={content.groups.length <= 1} onClick={() => { if (!window.confirm(t('removeConfirm'))) return; const next = structuredClone(content); next.groups.splice(groupIndex, 1); onChange(next) }}>{t('rule.removeGroup')}</Button></div></div>
    </>}
    {kind === 'time' && <div className="grid gap-4 sm:grid-cols-2"><PriceTokens key={`${groupIndex}-${ruleIndex}-tiers`} label={t('rule.serviceTiers')} value={rule.condition.service_tiers ?? []} hint={t('rule.tierHelp')} onChange={(values) => patch({ condition: { ...rule.condition, service_tiers: values.length ? values : undefined } })} />
      <PriceTokens key={`${groupIndex}-${ruleIndex}-tags`} label={t('rule.timeTags')} value={rule.condition.time_tags ?? []} hint={t('rule.tagsHelp')} onChange={(values) => patch({ condition: { ...rule.condition, time_tags: values.length ? values : undefined } })} /></div>}
    {kind === 'media' && <details><summary className="cursor-pointer text-sm font-semibold">{t('rule.mediaConditions')}</summary><div className="mt-4 grid gap-4 sm:grid-cols-2">{MEDIA_ATTRIBUTES.map((attribute) => <PriceTokens key={`${groupIndex}-${ruleIndex}-${attribute}`} label={t(`media.${attribute}`)} value={rule.condition.media?.[attribute] ?? []} hint={t('rule.commaValues')} onChange={(values) => { const media = { ...rule.condition.media }; if (values.length) media[attribute] = values; else delete media[attribute]; patch({ condition: { ...rule.condition, media: Object.keys(media).length ? media : undefined } }) }} />)}</div></details>}
  </div>
}

export function PriceRatesEditor({ content, groupIndex, ruleIndex, onChange, dimensions }: { content: PriceBookContent; groupIndex: number; ruleIndex: number; onChange: (next: PriceBookContent) => void; dimensions: BillableDimension[] }) {
  const { t } = useTranslation('pricing')
  const rule = content.groups[groupIndex].rules[ruleIndex]
  const patchRule = (nextRule: PricingRule) => { const next = structuredClone(content); next.groups[groupIndex].rules[ruleIndex] = nextRule; onChange(next) }
  const patch = (index: number, component: RateComponent) => patchRule({ ...rule, rates: rule.rates.map((entry, i) => i === index ? { ...entry, component } : entry) })
  const rows = rule.rates.map((entry, index) => ({ ...entry, index })).filter((entry) => dimensions.includes(entry.component.dimension))
  return <section className="space-y-4" aria-label={t('rates.title')}>
    <div><h3 className="text-sm font-bold">{t('rates.title')}</h3><p className="mt-1 text-xs leading-5 text-[var(--foreground-muted)]">{t('rates.help')}</p></div>
    <div className="space-y-4">{rows.map(({ component: c, operation, index }) => <div key={c.id} className="rounded-lg border border-[var(--border-hover)] bg-[var(--background)] p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><div className="flex items-center gap-2"><h4 className="text-sm font-semibold">{t(`dimension.${c.dimension}`)}</h4>{c.free ? <Badge variant="emerald">{t('status.free')}</Badge> : !c.amount ? <Badge variant="amber">{t('status.unpriced')}</Badge> : null}<code className="text-[10px] text-[var(--foreground-muted)]">{c.id}</code></div><Button type="button" size="icon" variant="ghost" aria-label={t('rates.remove', { name: t(`dimension.${c.dimension}`) })} onClick={() => { if (window.confirm(t('removeConfirm'))) patchRule({ ...rule, rates: rule.rates.filter((_, i) => i !== index) }) }}><Trash2 className="h-4 w-4" /></Button></div>
      <div className="grid gap-3 sm:grid-cols-3"><PriceInput label={t('rates.amount', { currency: content.currency })} className="font-mono" inputMode="decimal" value={c.amount} disabled={c.free} onChange={(e) => patch(index, { ...c, amount: e.target.value })} />
        <PriceInput label={t('rates.unitSize', { unit: t(`unit.${c.unit}`) })} className="font-mono" inputMode="decimal" value={c.unit_size} onChange={(e) => patch(index, { ...c, unit_size: e.target.value })} />
        <PriceSelect label={t('rates.operation')} value={operation} options={['replace', 'add'].map((value) => ({ value, label: t(`rates.${value}`) }))} onChange={(value) => patchRule({ ...rule, rates: rule.rates.map((entry, i) => i === index ? { ...entry, operation: value as 'replace' | 'add' } : entry) })} /></div>
      <div className="mt-3 flex flex-wrap gap-4"><label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={Boolean(c.free)} onChange={(e) => patch(index, { ...c, free: e.target.checked || undefined, amount: e.target.checked ? '0' : '' })} />{t('rates.explicitFree')}</label></div>
      <details className="mt-3"><summary className="cursor-pointer text-xs text-[var(--foreground-muted)]">{t('rates.rounding')}</summary><div className="mt-3 grid gap-3 sm:grid-cols-3"><PriceInput label={t('rates.minimum')} inputMode="decimal" value={c.minimum_quantity ?? ''} onChange={(e) => patch(index, { ...c, minimum_quantity: e.target.value || undefined })} />
        <PriceSelect label={t('rates.roundMode')} value={c.quantity_rounding?.mode ?? 'none'} options={['none', 'ceil', 'floor', 'half_even', 'half_up'].map((value) => ({ value, label: t(`round.${value}`) }))} onChange={(value) => patch(index, { ...c, quantity_rounding: value === 'none' ? undefined : { increment: c.quantity_rounding?.increment ?? '1', mode: value as NonNullable<RateComponent['quantity_rounding']>['mode'] } })} />
        {c.quantity_rounding && <PriceInput label={t('rates.increment')} inputMode="decimal" value={c.quantity_rounding.increment} onChange={(e) => patch(index, { ...c, quantity_rounding: { ...c.quantity_rounding!, increment: e.target.value } })} />}</div></details>
    </div>)}</div>
    <div className="flex flex-wrap gap-2">{content.billing_dimensions.filter((dimension) => dimensions.includes(dimension)).map((dimension) => <Button key={dimension} type="button" variant="outline" size="sm" onClick={() => patchRule({ ...rule, rates: [...rule.rates, { operation: 'replace', component: newRate(dimension) }] })}><Plus className="h-3 w-3" />{t(`dimension.${dimension}`)}</Button>)}</div>
    <details><summary className="cursor-pointer text-xs font-semibold">{t('rates.multipliers')}</summary><div className="mt-3 space-y-3">{(rule.multipliers ?? []).map((item, index) => <div key={index} className="grid items-end gap-3 sm:grid-cols-[1fr_1fr_auto]"><PriceSelect label={t('rates.dimension')} value={item.dimension} options={content.billing_dimensions.map((value) => ({ value, label: t(`dimension.${value}`) }))} onChange={(value) => patchRule({ ...rule, multipliers: rule.multipliers!.map((old, i) => i === index ? { ...old, dimension: value as BillableDimension } : old) })} /><PriceInput label={t('rates.factor')} value={item.factor} inputMode="decimal" onChange={(e) => patchRule({ ...rule, multipliers: rule.multipliers!.map((old, i) => i === index ? { ...old, factor: e.target.value } : old) })} /><Button size="icon" variant="ghost" aria-label={t('remove')} onClick={() => { if (window.confirm(t('removeConfirm'))) patchRule({ ...rule, multipliers: rule.multipliers!.filter((_, i) => i !== index) }) }}><Trash2 className="h-4 w-4" /></Button></div>)}<Button variant="outline" size="sm" onClick={() => patchRule({ ...rule, multipliers: [...rule.multipliers ?? [], { dimension: content.billing_dimensions[0], factor: '' }] })}>{t('rates.addMultiplier')}</Button></div></details>
  </section>
}

export function BillingDimensionsEditor({ content, onChange, dimensions = billingDimensions }: { content: PriceBookContent; onChange: (content: PriceBookContent) => void; dimensions?: BillableDimension[] }) {
  const { t } = useTranslation('pricing')
  return <details><summary className="cursor-pointer text-sm font-semibold">{t('rates.billingDimensions')}</summary><p className="my-3 text-xs text-[var(--foreground-muted)]">{t('rates.dimensionHelp')}</p><div className="grid gap-2 sm:grid-cols-2">{dimensions.map((dimension) => <label key={dimension} className="flex gap-2 text-xs leading-5"><input type="checkbox" checked={content.billing_dimensions.includes(dimension)} onChange={(e) => {
    if (!e.target.checked && content.groups.some((g) => g.rules.some((r) => r.rates.some((entry) => entry.component.dimension === dimension) || r.multipliers?.some((entry) => entry.dimension === dimension)))) { window.alert(t('rates.removeRatesFirst')); return }
    onChange({ ...content, billing_dimensions: e.target.checked ? [...content.billing_dimensions, dimension] : content.billing_dimensions.filter((item) => item !== dimension) })
  }} />{t(`dimension.${dimension}`)} <span className="text-[var(--foreground-muted)]">{t(`unit.${DIMENSION_UNITS[dimension]}`)}</span></label>)}</div><label className="mt-4 flex gap-2 text-xs"><input type="checkbox" checked={content.allow_combined_media} onChange={(e) => onChange({ ...content, allow_combined_media: e.target.checked })} />{t('rates.combined')}</label></details>
}

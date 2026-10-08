import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { CONTEXT_ROWS_PER_PAGE, contextRangeRows, editContextRange } from '@/lib/context-range-table'
import { ruleLabel } from '@/lib/pricing-model'
import { PriceInput } from './pricing-fields'
import { CostValue } from './cost-metadata'
import type { PriceBookContent } from '@/types/pricing'

/** Paginated editing never removes off-screen rules or their other conditions/rates. */
export function ContextRangeTable({ content, groupIndex, ruleIndex, select, onChange, disabled }: { content: PriceBookContent; groupIndex: number; ruleIndex: number; select: (index: number) => void; onChange: (value: PriceBookContent) => void; disabled: boolean }) {
  const { t, i18n } = useTranslation('pricing'), rules = content.groups[groupIndex].rules
  const rows = useMemo(() => contextRangeRows(rules), [rules])
  const start = Math.floor(ruleIndex / CONTEXT_ROWS_PER_PAGE) * CONTEXT_ROWS_PER_PAGE, visible = rows.slice(start, start + CONTEXT_ROWS_PER_PAGE)
  const problems = rows.filter(row => !row.valid || row.conflicts.length).length
  return <section className="min-w-0 space-y-3" aria-label={t('contextTable.title')}>
    <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="text-sm font-semibold">{t('contextTable.title')}</h3><p role="status" className="text-xs">{t('contextTable.page', { from: (start + 1).toLocaleString(i18n.resolvedLanguage), to: Math.min(start + CONTEXT_ROWS_PER_PAGE, rows.length).toLocaleString(i18n.resolvedLanguage), count: rows.length.toLocaleString(i18n.resolvedLanguage) })}</p></div>
    <p className="text-xs leading-5 text-[var(--foreground-muted)]">{t('contextTable.help')}</p>
    {problems > 0 && <p role="alert" className="text-xs text-[var(--destructive)]">{t('contextTable.problems', { count: problems })}</p>}
    <div className="overflow-x-auto rounded-lg border border-[var(--border)]"><table className="w-full min-w-[760px] text-left text-xs">
      <thead><tr className="border-b border-[var(--border)]"><th className="p-3">{t('rule.selected')}</th><th className="p-3">{t('rule.minimumInput')}</th><th className="p-3">{t('rule.maximumInput')}</th><th className="p-3">{t('contextTable.review')}</th></tr></thead>
      <tbody>{visible.map(({ rule, index, valid, conflicts }) => {
        const range = rule.condition.input_tokens, update = (value: typeof range) => onChange(editContextRange(content, groupIndex, index, value))
        const peers = conflicts.map(index => ruleLabel(rules[index])).join(' · ')
        return <tr key={rule.id + ':' + index} className={`border-b border-[var(--border)] align-top ${index === ruleIndex ? 'bg-[var(--accent-muted)]' : ''}`}>
          <td className="w-56 space-y-2 p-3"><Button type="button" variant="link" size="sm" className="h-auto max-w-56 whitespace-normal break-all p-0 text-left" aria-current={index === ruleIndex ? 'true' : undefined} onClick={() => select(index)}>{ruleLabel(rule)}</Button><p>{t('rule.priority')}: {rule.priority.toLocaleString(i18n.resolvedLanguage)}</p><label className="flex items-center gap-2"><input type="checkbox" checked={Boolean(range)} disabled={disabled} onChange={e => update(e.target.checked ? { min: '0' } : undefined)} />{t('rule.contextCondition')}</label></td>
          <td className="w-40 p-3"><PriceInput label={t('contextTable.minimumFor', { rule: ruleLabel(rule) })} value={range?.min ?? ''} inputMode="numeric" maxLength={49} disabled={disabled || !range} aria-invalid={range ? !valid : undefined} onChange={e => update({ ...range!, min: e.target.value })} /></td>
          <td className="w-40 p-3"><PriceInput label={t('contextTable.maximumFor', { rule: ruleLabel(rule) })} value={range?.max ?? ''} inputMode="numeric" maxLength={49} disabled={disabled || !range} placeholder={t('contextTable.unbounded')} aria-invalid={range ? !valid : undefined} onChange={e => update({ ...range!, max: e.target.value || undefined })} /></td>
          <td className="max-w-xs space-y-2 p-3"><p className="font-mono">{range ? <>[<CostValue value={range.min} />, {range.max === undefined ? '∞' : <CostValue value={range.max} />})</> : t('contextTable.all')}</p>
            {!valid ? <p className="text-[var(--destructive)]">{t('contextTable.invalid')}</p> : conflicts.length ? <p className="break-all text-[var(--destructive)]">{t('contextTable.overlap', { rules: peers })}</p> : <p className="text-[var(--foreground-muted)]">{t('contextTable.noOverlap')}</p>}
            <p className="break-all text-[var(--foreground-muted)]">{rule.rates.map(rate => t(`dimension.${rate.component.dimension}`)).join(' · ')}</p>
          </td>
        </tr>
      })}</tbody></table></div>
    {rows.length > CONTEXT_ROWS_PER_PAGE && <div className="flex justify-between"><Button type="button" variant="outline" size="sm" disabled={start === 0} onClick={() => select(start - CONTEXT_ROWS_PER_PAGE)}>{t('previous')}</Button><Button type="button" variant="outline" size="sm" disabled={start + CONTEXT_ROWS_PER_PAGE >= rows.length} onClick={() => select(start + CONTEXT_ROWS_PER_PAGE)}>{t('next')}</Button></div>}
  </section>
}

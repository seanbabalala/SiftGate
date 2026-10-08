import { useTranslation } from 'react-i18next'
import { Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { PriceInput, PriceSelect } from './pricing-fields'
import { newId } from '@/lib/pricing-model'
import type { PricingCalendarDocument, CalendarWindow, CalendarDatePlan } from '@/types/pricing'

export function PriceCalendarEditor({ calendar, timeBasis, runtime, onChange, onBasis }: { calendar?: PricingCalendarDocument; timeBasis?: string; runtime?: { tzdb_version: string; today: string }; onChange: (value: PricingCalendarDocument | undefined) => void; onBasis: (value: string) => void }) {
  const { t } = useTranslation('pricing')
  const patch = (next: PricingCalendarDocument) => onChange({ ...next, version_id: newId('calendar') })
  return <section className="space-y-4 border-t border-[var(--border)] pt-5"><label className="flex items-center gap-2 text-sm font-semibold"><input type="checkbox" checked={Boolean(calendar)} disabled={!calendar && !runtime} onChange={(e) => {
    if (!e.target.checked) { if (window.confirm(t('calendar.removeConfirm'))) onChange(undefined); return }
    if (!runtime) return
    const date = new Date(`${runtime.today}T00:00:00Z`); date.setUTCFullYear(date.getUTCFullYear() + 1); const end = date.toISOString().slice(0, 10)
    onChange({ schema_version: 1, version_id: newId('calendar'), tzdb_version: runtime.tzdb_version, time_zone: 'UTC', valid_from: runtime.today, valid_to: end, default_tag: 'offpeak', weekly: [], holidays: [], date_overrides: [] })
  }} />{t('calendar.enabled')}</label><p className="text-xs leading-5 text-[var(--foreground-muted)]">{t('calendar.help')}</p>
    {calendar && <>
      <p className="text-xs leading-6 text-[var(--foreground-muted)]">{t('timeReview.editorHelp')}</p>
      <div className="grid gap-4 sm:grid-cols-2"><PriceInput label={t('calendar.timeZone')} value={calendar.time_zone} onChange={(e) => patch({ ...calendar, time_zone: e.target.value })} /><PriceInput label={t('calendar.defaultTag')} value={calendar.default_tag} onChange={(e) => patch({ ...calendar, default_tag: e.target.value })} />
        <PriceInput label={t('calendar.from')} type="date" value={calendar.valid_from} onChange={(e) => patch({ ...calendar, valid_from: e.target.value })} /><PriceInput label={t('calendar.to')} type="date" value={calendar.valid_to} onChange={(e) => patch({ ...calendar, valid_to: e.target.value })} />
        <PriceSelect label={t('calendar.timeBasis')} value={timeBasis ?? 'attempt_dispatched_at'} options={['attempt_dispatched_at', 'provider_accepted_at', 'completed_at'].map((value) => ({ value, label: t(`calendar.${value}`) }))} onChange={onBasis} /><PriceInput label={t('calendar.tzdb')} value={calendar.tzdb_version} onChange={(e) => patch({ ...calendar, tzdb_version: e.target.value })} /></div>
      {runtime && calendar.tzdb_version !== runtime.tzdb_version && <Button variant="outline" size="sm" onClick={() => patch({ ...calendar, tzdb_version: runtime.tzdb_version })}>{t('calendar.useRuntime', { version: runtime.tzdb_version })}</Button>}
      <div className="space-y-3"><h4 className="text-sm font-semibold">{t('calendar.weekly')}</h4>{calendar.weekly.map((item, index) => <div key={index} className="space-y-3 border-l-2 border-[var(--accent-muted)] pl-4"><div className="flex flex-wrap items-center gap-3">{[1,2,3,4,5,6,7].map((day) => <label key={day} className="flex gap-1 text-xs"><input type="checkbox" checked={item.weekdays.includes(day)} onChange={(e) => patch({ ...calendar, weekly: calendar.weekly.map((old, i) => i === index ? { ...old, weekdays: e.target.checked ? [...old.weekdays, day].sort() : old.weekdays.filter((value) => value !== day) } : old) })} />{t(`day.${day}`)}</label>)}<Button variant="ghost" size="icon" aria-label={t('remove')} onClick={() => { if (window.confirm(t('removeConfirm'))) patch({ ...calendar, weekly: calendar.weekly.filter((_, i) => i !== index) }) }}><Trash2 className="h-3 w-3" /></Button></div><Windows value={item.windows} onChange={(windows) => patch({ ...calendar, weekly: calendar.weekly.map((old, i) => i === index ? { ...old, windows } : old) })} /></div>)}
      <Button size="sm" variant="outline" onClick={() => patch({ ...calendar, weekly: [...calendar.weekly, { weekdays: [1,2,3,4,5], windows: [{ start: '09:00', end: '18:00', tag: 'peak' }] }] })}><Plus className="h-3 w-3" />{t('calendar.addWeek')}</Button></div>
      <DatePlans title={t('calendar.holidays')} value={calendar.holidays} today={runtime?.today ?? calendar.valid_from} onChange={(holidays) => patch({ ...calendar, holiday_version: newId('holidays'), holidays })} />
      <DatePlans title={t('calendar.overrides')} value={calendar.date_overrides} today={runtime?.today ?? calendar.valid_from} onChange={(date_overrides) => patch({ ...calendar, date_overrides })} />
    </>}
  </section>
}
function Windows({ value, onChange }: { value: CalendarWindow[]; onChange: (value: CalendarWindow[]) => void }) {
  const { t } = useTranslation('pricing')
  return <div className="space-y-2">{value.map((windowPlan, index) => <div key={index} className="grid items-end gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]"><PriceInput label={t('calendar.start')} maxLength={5} value={windowPlan.start} onChange={(e) => onChange(value.map((old, i) => i === index ? { ...old, start: e.target.value } : old))} /><PriceInput label={t('calendar.end')} maxLength={5} value={windowPlan.end} onChange={(e) => onChange(value.map((old, i) => i === index ? { ...old, end: e.target.value } : old))} /><PriceInput label={t('calendar.tag')} value={windowPlan.tag} onChange={(e) => onChange(value.map((old, i) => i === index ? { ...old, tag: e.target.value } : old))} /><Button variant="ghost" size="icon" aria-label={t('remove')} onClick={() => { if (window.confirm(t('removeConfirm'))) onChange(value.filter((_, i) => i !== index)) }}><Trash2 className="h-3 w-3" /></Button></div>)}<Button variant="ghost" size="sm" onClick={() => onChange([...value, { start: '00:00', end: '24:00', tag: 'offpeak' }])}>{t('calendar.addWindow')}</Button></div>
}
function DatePlans({ title, value, today, onChange }: { title: string; value: CalendarDatePlan[]; today: string; onChange: (value: CalendarDatePlan[]) => void }) {
  const { t } = useTranslation('pricing')
  return <details><summary className="cursor-pointer text-sm font-semibold">{title} <span className="font-mono text-xs">({value.length})</span></summary><div className="mt-4 space-y-4">{value.map((plan, index) => <div key={index} className="space-y-2 border-l-2 border-[var(--accent-muted)] pl-4"><div className="flex items-end gap-3"><PriceInput label={t('calendar.date')} type="date" value={plan.date} onChange={(e) => onChange(value.map((old, i) => i === index ? { ...old, date: e.target.value } : old))} /><Button variant="ghost" size="icon" aria-label={t('remove')} onClick={() => { if (window.confirm(t('removeConfirm'))) onChange(value.filter((_, i) => i !== index)) }}><Trash2 className="h-3 w-3" /></Button></div><Windows value={plan.windows} onChange={(windows) => onChange(value.map((old, i) => i === index ? { ...old, windows } : old))} /></div>)}<Button variant="outline" size="sm" onClick={() => onChange([...value, { date: today, windows: [] }])}>{t('calendar.addDate')}</Button></div></details>
}

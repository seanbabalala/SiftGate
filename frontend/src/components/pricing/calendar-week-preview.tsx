import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { PriceInput } from './pricing-fields'
import { pricingClient } from '@/lib/pricing-client'
import { pricingErrorKey } from '@/lib/pricing-errors'
import { CALENDAR_SEGMENTS_PER_PAGE, CALENDAR_SOURCES, calendarDateLabel, calendarMinute, pricingWeekDates, verifyCalendarWeek } from '@/lib/calendar-week'
import type { PricingCalendarDocument } from '@/types/pricing'
import type { CalendarWeekDay, CalendarWeekPreview as WeekView } from '../../../../src/pricing/pricing-calendar-week.types'

const colors = { date_override: 'bg-violet-500/40', holiday: 'bg-amber-500/40', weekly: 'bg-emerald-500/40', fallback: 'bg-slate-500/20' }
export function CalendarWeekPreview({ workspace, calendar }: { workspace: string; calendar: PricingCalendarDocument }) {
  const { t } = useTranslation('pricing'), request = useMemo(() => pricingClient(workspace), [workspace])
  const [date, setDate] = useState(calendar.valid_from), [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(null)
  const [result, setResult] = useState<{ signature: string; view: WeekView } | null>(null)
  const active = useRef<AbortController | null>(null), signature = JSON.stringify([workspace, calendar, date])
  useEffect(() => { active.current?.abort(); active.current = null; setBusy(false); setError(null) }, [signature])
  useEffect(() => () => { active.current?.abort() }, [])
  let valid = true
  try { pricingWeekDates(date) } catch { valid = false }
  const run = async () => {
    if (active.current || !valid) return
    const controller = new AbortController(); active.current = controller; setBusy(true); setError(null); setResult(null)
    const timeout = setTimeout(() => controller.abort(), 15000)
    try {
      const value = await request<WeekView>('/calendar/week-preview', { calendar, date }, 'POST', controller.signal)
      const view = await verifyCalendarWeek(value, calendar, date)
      if (!controller.signal.aborted) setResult({ signature, view })
    } catch (failure) { if (active.current === controller) setError(failure) }
    finally { clearTimeout(timeout); if (active.current === controller) { active.current = null; setBusy(false) } }
  }
  const current = result?.signature === signature ? result.view : null
  return <section className="min-w-0 space-y-4 border-t border-[var(--border)] pt-5" aria-label={t('calendarWeek.title')}>
    <div><h3 className="text-sm font-semibold">{t('calendarWeek.title')}</h3><p className="mt-2 text-xs leading-6 text-[var(--foreground-muted)]">{t('calendarWeek.help')}</p></div>
    <div className="flex flex-wrap items-end gap-3"><PriceInput type="date" label={t('calendarWeek.date')} value={date} onChange={e => setDate(e.target.value)} /><Button type="button" variant="outline" disabled={!valid || busy} onClick={() => void run()}>{t(busy ? 'working' : 'calendarWeek.run')}</Button>{busy && <Button type="button" variant="ghost" onClick={() => { active.current?.abort(); active.current = null; setBusy(false) }}>{t('calendarWeek.cancel')}</Button>}</div>
    <p className="break-all text-xs">{t('calendar.timeZone')}: <code>{calendar.time_zone}</code> · {t('calendar.tzdb')}: <code>{calendar.tzdb_version}</code></p>
    {!valid && <p role="alert" className="text-xs text-[var(--destructive)]">{t('calendarWeek.invalidDate')}</p>}
    {error !== null && <p role="alert" className="text-xs text-[var(--destructive)]">{t('calendarWeek.failed')} {t(pricingErrorKey(error))}</p>}
    {result && !current && <p role="status" className="text-xs text-[var(--warning)]">{t('calendarWeek.stale')}</p>}
    <p className="border-l-2 border-amber-500 pl-3 text-xs leading-6">{t('calendarWeek.civil')}</p>
    {current && <div className="space-y-3" aria-live="polite">
      <p role="status" className="text-sm font-medium">{t('calendarWeek.ready', { from: current.week_start, to: current.days[6].date })}</p>
      <p className="break-all font-mono text-[10px] text-[var(--foreground-muted)]">{current.calendar.version_id} · {current.calendar.content_hash}</p>
      <div className="flex flex-wrap gap-3 text-xs">{CALENDAR_SOURCES.map(source => <span key={source} className="inline-flex items-center gap-1"><span aria-hidden className={`h-2 w-2 rounded-sm ${colors[source]}`} />{t(`calendarWeek.source.${source}`)}</span>)}</div>
      {current.days.map(day => <CalendarDay key={`${current.evidence_hash}/${day.date}`} day={day} timeZone={current.calendar.time_zone} />)}
    </div>}
  </section>
}
function CalendarDay({ day, timeZone }: { day: CalendarWeekDay; timeZone: string }) {
  const { t, i18n } = useTranslation('pricing'), [offset, setOffset] = useState(0)
  return <section className="min-w-0 space-y-3 rounded-lg border border-[var(--border)] p-4" aria-label={day.date}>
    <h4 className="flex flex-wrap justify-between gap-2 text-sm font-semibold"><span>{calendarDateLabel(day.date, i18n.resolvedLanguage ?? i18n.language)}</span><code className="text-xs font-normal">{day.date}</code></h4>
    {!day.covered ? <p className="text-xs text-[var(--foreground-muted)]">{t('calendarWeek.uncovered')}</p> : <>
      <div aria-hidden className="flex h-3 overflow-hidden rounded-sm">{day.segments.map((segment, i) => <span key={i} className={`${colors[segment.source]} border-r border-[var(--background)]`} style={{ width: `${(calendarMinute(segment.end) - calendarMinute(segment.start)) / 14.4}%` }} />)}</div>
      <details className="min-w-0"><summary className="cursor-pointer text-xs font-semibold">{t('calendarWeek.details', { count: day.segments.length })}</summary><div className="mt-3 space-y-3">
        <p className="text-xs text-[var(--foreground-muted)]">{timeZone} · {t('calendarWeek.rows', { from: (offset + 1).toLocaleString(i18n.resolvedLanguage), to: Math.min(offset + CALENDAR_SEGMENTS_PER_PAGE, day.segments.length).toLocaleString(i18n.resolvedLanguage), count: day.segments.length.toLocaleString(i18n.resolvedLanguage) })}</p>
        <ol className="space-y-2">{day.segments.slice(offset, offset + CALENDAR_SEGMENTS_PER_PAGE).map((segment, index) => <li key={index} className="grid gap-x-3 gap-y-1 border-l-2 border-[var(--accent-muted)] pl-3 text-xs sm:grid-cols-[120px_1fr]">
          <code>[{segment.start}, {segment.end})</code><span className="break-all font-semibold">{segment.tag}</span><span className="text-[var(--foreground-muted)]">{t(`calendarWeek.source.${segment.source}`)}</span><span className="break-all text-[var(--foreground-muted)]">{t('calendarWeek.anchor')}: {segment.anchor_date}{segment.anchor_date !== day.date ? ` · ${t('calendarWeek.carry')}` : ''}</span>
        </li>)}</ol>
        {day.segments.length > CALENDAR_SEGMENTS_PER_PAGE && <div className="flex justify-between"><Button variant="outline" size="sm" disabled={!offset} onClick={() => setOffset(offset - CALENDAR_SEGMENTS_PER_PAGE)}>{t('previous')}</Button><Button variant="outline" size="sm" disabled={offset + CALENDAR_SEGMENTS_PER_PAGE >= day.segments.length} onClick={() => setOffset(offset + CALENDAR_SEGMENTS_PER_PAGE)}>{t('next')}</Button></div>}
      </div></details>
    </>}
  </section>
}

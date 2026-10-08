import { costHash } from './usage-recovery-form'
import { parsePricingDate, shiftPricingDate } from '../../../src/pricing/pricing-time'
import { pricingWeekDates } from '../../../src/pricing/pricing-week-dates'
import type { PricingCalendarDocument } from '@/types/pricing'
import type { CalendarWeekPreview } from '../../../src/pricing/pricing-calendar-week.types'
export { pricingWeekDates }
export const CALENDAR_SEGMENTS_PER_PAGE = 12
export const CALENDAR_SOURCES = ['date_override', 'holiday', 'weekly', 'fallback'] as const
const hash = (s: unknown): s is string => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s)
const fail = (): never => { throw Error('invalid_calendar_week') }
export function calendarMinute(text: string): number {
  if (text === '24:00') return 1440
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(text)) return fail()
  const [h, m] = text.split(':').map(Number); return h * 60 + m
}
export function calendarDateLabel(date: string, locale: string): string {
  return new Date(parsePricingDate(date)).toLocaleDateString(locale, { timeZone: 'UTC', weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' })
}
export async function verifyCalendarWeek(value: CalendarWeekPreview, input: PricingCalendarDocument, date: string): Promise<CalendarWeekPreview> {
  const days = pricingWeekDates(date)
  if (!value || value.schema_version !== 1 || value.simulation !== true || value.read_only !== true || value.complete !== true ||
    value.interpretation !== 'civil_schedule_not_elapsed_time' || value.requested_date !== date || value.week_start !== days[0] ||
    !hash(value.input_hash) || !hash(value.evidence_hash) || value.input_hash !== await costHash({ calendar: input, date }) ||
    !value.calendar || !hash(value.calendar.content_hash) || value.calendar.version_id !== input.version_id ||
    value.calendar.tzdb_version !== input.tzdb_version || value.calendar.holiday_version !== (input.holiday_version ?? null) ||
    value.calendar.valid_from !== input.valid_from || value.calendar.valid_to !== input.valid_to || !Array.isArray(value.days) || value.days.length !== 7) fail()
  const canonicalZone = (zone: string) => new Intl.DateTimeFormat('en', { timeZone: zone }).resolvedOptions().timeZone
  if (canonicalZone(value.calendar.time_zone) !== canonicalZone(input.time_zone)) fail()
  for (let i = 0; i < 7; i++) {
    const day = value.days[i], covered = days[i] >= input.valid_from && days[i] < input.valid_to
    if (!day || day.date !== days[i] || day.covered !== covered || !Array.isArray(day.segments) || day.segments.length > 1440 || (covered ? !day.segments.length : day.segments.length !== 0)) fail()
    let end = 0
    for (const segment of day.segments) {
      if (!segment || typeof segment.start !== 'string' || typeof segment.end !== 'string' || typeof segment.tag !== 'string' || !segment.tag.length || segment.tag.length > 128 ||
        !CALENDAR_SOURCES.includes(segment.source) || ![day.date, shiftPricingDate(day.date, -1)].includes(segment.anchor_date)) fail()
      const start = calendarMinute(segment.start), next = calendarMinute(segment.end)
      if (start !== end || next <= start) fail()
      end = next
    }
    if (covered && end !== 1440) fail()
  }
  const { evidence_hash, ...body } = value
  if (await costHash(body) !== evidence_hash) fail()
  return value
}

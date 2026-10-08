import { CompiledPricingCalendar } from './pricing-calendar';
import { pricingContentHash } from './pricing-json';
import { pricingWeekDates } from './pricing-week-dates';
import { PricingRepositoryError } from './pricing-repository.types';
import type { CalendarWeekPreview } from './pricing-calendar-week.types';

/** One compile, at most seven existing civil previews. No storage, provider, price or clock mutation. */
export function previewPricingCalendarWeek(value: unknown, date: string): CalendarWeekPreview {
  let dates: string[];
  try { dates = pricingWeekDates(date); } catch {
    throw new PricingRepositoryError('pricing_calendar_unavailable', 'Choose a valid civil date within supported calendar years', 400);
  }
  const compiled = CompiledPricingCalendar.compile(value), calendar = compiled.document();
  if (calendar.tzdb_version !== (process.versions.tz ?? 'unknown'))
    throw new PricingRepositoryError('pricing_calendar_unavailable', 'Calendar timezone data differs from this runtime; revalidate before previewing', 409);
  const body: Omit<CalendarWeekPreview, 'evidence_hash'> = {
    schema_version: 1, simulation: true, read_only: true, complete: true,
    interpretation: 'civil_schedule_not_elapsed_time', requested_date: date, week_start: dates[0],
    input_hash: pricingContentHash({ calendar: value, date }),
    calendar: { version_id: calendar.version_id, content_hash: compiled.contentHash, time_zone: calendar.time_zone,
      tzdb_version: calendar.tzdb_version, valid_from: calendar.valid_from, valid_to: calendar.valid_to, holiday_version: calendar.holiday_version ?? null },
    days: dates.map(day => {
      const covered = day >= calendar.valid_from && day < calendar.valid_to;
      return { date: day, covered, segments: covered ? compiled.previewDate(day) : [] };
    }),
  };
  return { ...body, evidence_hash: pricingContentHash(body) };
}

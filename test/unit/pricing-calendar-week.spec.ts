import { previewPricingCalendarWeek } from '../../src/pricing/pricing-calendar-week';
import { pricingWeekDates } from '../../src/pricing/pricing-week-dates';
import { CompiledPricingCalendar } from '../../src/pricing/pricing-calendar';
import { pricingContentHash } from '../../src/pricing/pricing-json';
import type { PricingCalendarDocument } from '../../src/pricing/pricing-calendar.types';
const calendar = (): PricingCalendarDocument => ({ schema_version: 1, version_id: 'week-fixture', time_zone: 'Asia/Shanghai', tzdb_version: process.versions.tz!, valid_from: '2026-01-01', valid_to: '2027-01-01', default_tag: 'offpeak', weekly: [{ weekdays: [7], windows: [{ start: '22:00', end: '02:00', tag: 'night' }] }, { weekdays: [1, 2, 3, 4, 5], windows: [{ start: '09:00', end: '12:00', tag: 'peak' }] }], holidays: [], date_overrides: [] });
describe('bounded normalized calendar week', () => {
  it('composes exactly seven original date previews, preserving midnight carry and immutable identities', () => {
    const doc = calendar(), before = JSON.stringify(doc), result = previewPricingCalendarWeek(doc, '2026-09-30'), compiled = CompiledPricingCalendar.compile(doc);
    expect(result.week_start).toBe('2026-09-28'); expect(result.days).toHaveLength(7);
    for (const day of result.days) expect(day.segments).toEqual(compiled.previewDate(day.date));
    expect(result.days[0].segments[0]).toMatchObject({ start: '00:00', end: '02:00', anchor_date: '2026-09-27', tag: 'night' });
    expect(result.input_hash).toBe(pricingContentHash({ calendar: doc, date: '2026-09-30' }));
    expect(result.calendar.content_hash).toBe(compiled.contentHash);
    const { evidence_hash, ...body } = result; expect(evidence_hash).toBe(pricingContentHash(body)); expect(JSON.stringify(doc)).toBe(before);
    result.days[0].segments[0].tag = 'mutated'; expect(previewPricingCalendarWeek(doc, '2026-09-30').days[0].segments[0].tag).toBe('night');
  });
  it('shows date overrides above holidays and previous-date carry above lower-priority holidays', () => {
    const doc = calendar(); doc.holiday_version = 'holiday-fixture'; doc.holidays = [{ date: '2026-09-29', windows: [] }, { date: '2026-10-01', windows: [] }];
    doc.date_overrides = [{ date: '2026-09-29', windows: [{ start: '10:00', end: '11:00', tag: 'special' }] }, { date: '2026-09-30', windows: [{ start: '22:00', end: '02:00', tag: 'special-night' }] }];
    const result = previewPricingCalendarWeek(doc, '2026-09-30');
    expect(result.days[1].segments.find(s => s.tag === 'special')?.source).toBe('date_override');
    expect(result.days[3].segments[0]).toMatchObject({ tag: 'special-night', source: 'date_override', anchor_date: '2026-09-30' });
    expect(result.days[3].segments[1]).toMatchObject({ start: '02:00', tag: 'offpeak', source: 'holiday', anchor_date: '2026-10-01' });
  });
  it('marks uncovered days without fabricating fallback/free coverage or failing the covered remainder', () => {
    const doc = calendar(); doc.valid_from = '2026-09-30'; doc.valid_to = '2026-10-02';
    const result = previewPricingCalendarWeek(doc, '2026-09-30');
    expect(result.days.map(d => d.covered)).toEqual([false, false, true, true, false, false, false]);
    expect(result.days.filter(d => !d.covered).every(d => d.segments.length === 0)).toBe(true);
  });
  it.each(['2026-03-08', '2026-11-01'])('labels DST week %s as civil schedule, never elapsed time', date => {
    const doc = calendar(); doc.time_zone = 'America/New_York'; const result = previewPricingCalendarWeek(doc, date);
    expect(result.interpretation).toBe('civil_schedule_not_elapsed_time');
    expect(result.days.at(-1)?.date).toBe(date);
    for (const day of result.days) { expect(day.segments[0].start).toBe('00:00'); expect(day.segments.at(-1)?.end).toBe('24:00'); }
  });
  it('refuses a timezone-data mismatch instead of showing an apparently ready schedule', () => {
    const doc = calendar(); doc.tzdb_version = 'unavailable'; expect(() => previewPricingCalendarWeek(doc, '2026-09-30')).toThrow(expect.objectContaining({ status: 409, code: 'pricing_calendar_unavailable' }));
  });
  it.each(['2026-02-30', '2026-09-30T00:00:00Z', '1969-12-31', '9999-01-01', 'bad'])('rejects invalid/unsupported civil input %s', date => {
    expect(() => previewPricingCalendarWeek(calendar(), date)).toThrow(expect.objectContaining({ status: 400 }));
  });
  it('handles year/leap boundaries by civil-date arithmetic without the process timezone', () => {
    expect(pricingWeekDates('2026-01-01')).toEqual(['2025-12-29', '2025-12-30', '2025-12-31', '2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04']);
    expect(pricingWeekDates('2028-02-29')).toContain('2028-02-29'); expect(pricingWeekDates('1970-01-01')[0]).toBe('1969-12-29');
  });
  it('retains original compiler overlap rejection and seven-day output bound', () => {
    const doc = calendar(); doc.weekly.push({ weekdays: [1], windows: [{ start: '01:00', end: '03:00', tag: 'overlap' }] });
    expect(() => previewPricingCalendarWeek(doc, '2026-09-30')).toThrow();
    expect(previewPricingCalendarWeek(calendar(), '2026-09-30').days.every(d => d.segments.length <= 1440)).toBe(true);
  });
});

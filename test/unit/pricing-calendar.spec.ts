import { CompiledPricingCalendar } from '../../src/pricing/pricing-calendar';
import { PricingCompileError } from '../../src/pricing/pricing-errors';
import { compilePriceBook } from '../../src/pricing/pricing-compiler';
import { calculateCost } from '../../src/pricing/cost-calculator';
import { parsePricingInstant } from '../../src/pricing/pricing-time';
import type { PricingCalendarDocument } from '../../src/pricing/pricing-calendar.types';
import { tokenBook, tokens } from './pricing-fixtures';

export function calendarFixture(): PricingCalendarDocument {
  return {
    schema_version: 1,
    version_id: 'synthetic-calendar-v1',
    time_zone: 'Asia/Shanghai',
    tzdb_version: process.versions.tz ?? 'unknown',
    valid_from: '2026-01-01',
    valid_to: '2027-01-01',
    default_tag: 'offpeak',
    weekly: [
      {
        weekdays: [1, 2, 3, 4, 5],
        windows: [
          { start: '09:00', end: '12:00', tag: 'peak' },
          { start: '14:00', end: '18:00', tag: 'peak' },
        ],
      },
    ],
    holidays: [],
    date_overrides: [],
  };
}

describe('versioned pricing calendars', () => {
  it.each([
    ['2026-09-25T08:59:59.999+08:00', 'offpeak'],
    ['2026-09-25T09:00:00+08:00', 'peak'],
    ['2026-09-25T11:59:59.999+08:00', 'peak'],
    ['2026-09-25T12:00:00+08:00', 'offpeak'],
    ['2026-09-25T14:00:00+08:00', 'peak'],
    ['2026-09-26T09:00:00+08:00', 'offpeak'],
  ])('CALC-07 uses half-open time windows for %s', (instant, expected) => {
    const result = CompiledPricingCalendar.compile(calendarFixture()).match(instant);
    expect(result.diagnostics).toEqual([]);
    expect(result.match?.tag).toBe(expected);
    expect(result.match?.utc_offset_seconds).toBe(28800);
  });

  it('does not depend on the timestamp offset or process local timezone', () => {
    const calendar = CompiledPricingCalendar.compile(calendarFixture());
    expect(calendar.match('2026-09-25T01:00:00Z')).toEqual(
      calendar.match('2026-09-25T09:00:00+08:00'),
    );
  });

  it('CALC-08 prioritizes explicit dates over holiday exceptions over weekdays', () => {
    const doc = calendarFixture();
    doc.holiday_version = 'synthetic-holidays-v1';
    doc.holidays = [{ date: '2026-09-25', windows: [] }];
    expect(
      CompiledPricingCalendar.compile(doc).match('2026-09-25T10:00:00+08:00').match,
    ).toMatchObject({ tag: 'offpeak', source: 'holiday' });
    doc.date_overrides = [
      { date: '2026-09-25', windows: [{ start: '09:00', end: '12:00', tag: 'special' }] },
    ];
    expect(
      CompiledPricingCalendar.compile(doc).match('2026-09-25T10:00:00+08:00').match,
    ).toMatchObject({ tag: 'special', source: 'date_override' });
  });

  it('supports an explicitly configured working-weekend date rather than guessing holiday policy', () => {
    const doc = calendarFixture();
    doc.date_overrides = [
      { date: '2026-09-26', windows: [{ start: '09:00', end: '17:00', tag: 'peak' }] },
    ];
    expect(CompiledPricingCalendar.compile(doc).match('2026-09-26T10:00:00+08:00').match?.tag).toBe(
      'peak',
    );
  });

  it('CALC-09 applies a Sunday overnight window to Monday before the end boundary', () => {
    const doc = calendarFixture();
    doc.weekly = [{ weekdays: [7], windows: [{ start: '22:00', end: '02:00', tag: 'night' }] }];
    const calendar = CompiledPricingCalendar.compile(doc);
    expect(calendar.match('2026-09-28T01:59:59.999+08:00').match).toMatchObject({
      tag: 'night',
      anchor_date: '2026-09-27',
    });
    expect(calendar.match('2026-09-28T02:00:00+08:00').match?.tag).toBe('offpeak');
  });

  it('cancels a weekly overnight carry when its start date was replaced by a holiday', () => {
    const doc = calendarFixture();
    doc.weekly = [{ weekdays: [7], windows: [{ start: '22:00', end: '02:00', tag: 'night' }] }];
    doc.holiday_version = 'synthetic-holidays';
    doc.holidays = [{ date: '2026-09-27', windows: [] }];
    expect(CompiledPricingCalendar.compile(doc).match('2026-09-28T01:00:00+08:00').match?.tag).toBe(
      'offpeak',
    );
  });

  it('supports exception carry and explicit target-date replacement without suppressing later weekdays', () => {
    const doc = calendarFixture();
    doc.date_overrides = [
      { date: '2026-09-24', windows: [{ start: '22:00', end: '02:00', tag: 'special-night' }] },
    ];
    let calendar = CompiledPricingCalendar.compile(doc);
    expect(calendar.match('2026-09-25T01:00:00+08:00').match?.tag).toBe('special-night');
    expect(calendar.match('2026-09-25T10:00:00+08:00').match?.tag).toBe('peak');
    doc.date_overrides.push({ date: '2026-09-25', windows: [] });
    calendar = CompiledPricingCalendar.compile(doc);
    expect(calendar.match('2026-09-25T01:00:00+08:00').match?.tag).toBe('offpeak');
  });

  it('does not confuse an exception morning window with its next-day overnight carry', () => {
    const doc = calendarFixture();
    doc.date_overrides = [
      {
        date: '2026-09-24',
        windows: [
          { start: '00:00', end: '01:00', tag: 'morning' },
          { start: '22:00', end: '02:00', tag: 'night' },
        ],
      },
    ];
    const calendar = CompiledPricingCalendar.compile(doc);
    expect(calendar.match('2026-09-24T00:30:00+08:00').match?.tag).toBe('morning');
    expect(calendar.match('2026-09-25T00:30:00+08:00').match?.tag).toBe('night');
  });

  it('higher-priority explicit carry wins over a lower-priority target-date holiday', () => {
    const doc = calendarFixture();
    doc.date_overrides = [
      { date: '2026-09-24', windows: [{ start: '22:00', end: '02:00', tag: 'special-night' }] },
    ];
    doc.holiday_version = 'synthetic-holidays';
    doc.holidays = [{ date: '2026-09-25', windows: [] }];
    expect(CompiledPricingCalendar.compile(doc).match('2026-09-25T01:00:00+08:00').match?.tag).toBe(
      'special-night',
    );
  });

  it('CALC-09 maps both fall-back occurrences to the same civil rule while retaining distinct instants and offsets', () => {
    const doc = calendarFixture();
    doc.time_zone = 'America/New_York';
    doc.weekly = [
      { weekdays: [7], windows: [{ start: '01:00', end: '02:00', tag: 'repeated-hour' }] },
    ];
    const calendar = CompiledPricingCalendar.compile(doc);
    const first = calendar.match('2026-11-01T05:30:00Z').match!;
    const second = calendar.match('2026-11-01T06:30:00Z').match!;
    expect(first.tag).toBe('repeated-hour');
    expect(second.tag).toBe('repeated-hour');
    expect(first.local_time).toBe(second.local_time);
    expect(first.utc_offset_seconds).toBe(-14400);
    expect(second.utc_offset_seconds).toBe(-18000);
    expect(first.instant).not.toBe(second.instant);
  });

  it('CALC-09 never manufactures a nonexistent spring-forward clock hour', () => {
    const doc = calendarFixture();
    doc.time_zone = 'America/New_York';
    doc.weekly = [
      { weekdays: [7], windows: [{ start: '02:00', end: '03:00', tag: 'skipped-hour' }] },
    ];
    const calendar = CompiledPricingCalendar.compile(doc);
    expect(calendar.match('2026-03-08T06:59:59Z').match?.local_time).toBe('01:59:59.000');
    expect(calendar.match('2026-03-08T07:00:00Z').match).toMatchObject({
      local_time: '03:00:00.000',
      tag: 'offpeak',
    });
  });

  it('STATE-10 refuses expired calendars and incompatible timezone-data versions', () => {
    const doc = calendarFixture();
    expect(
      CompiledPricingCalendar.compile(doc).match('2027-01-01T00:00:00+08:00').match,
    ).toBeNull();
    doc.tzdb_version = 'unavailable-tzdb';
    expect(
      CompiledPricingCalendar.compile(doc).match('2026-09-25T10:00:00+08:00').diagnostics[0]?.code,
    ).toBe('pricing_calendar_unavailable');
  });

  it('renders a normalized civil date preview with no gaps or ambiguous midnight carry', () => {
    const doc = calendarFixture();
    doc.weekly = [{ weekdays: [7], windows: [{ start: '22:00', end: '02:00', tag: 'night' }] }];
    expect(CompiledPricingCalendar.compile(doc).previewDate('2026-09-28')).toEqual([
      { start: '00:00', end: '02:00', tag: 'night', source: 'weekly', anchor_date: '2026-09-27' },
      {
        start: '02:00',
        end: '24:00',
        tag: 'offpeak',
        source: 'fallback',
        anchor_date: '2026-09-28',
      },
    ]);
  });

  it.each([
    (doc: PricingCalendarDocument) => {
      doc.time_zone = '+08:00';
    },
    (doc: PricingCalendarDocument) => {
      doc.time_zone = 'Not/AZone';
    },
    (doc: PricingCalendarDocument) => {
      doc.valid_from = '2026-02-30';
    },
    (doc: PricingCalendarDocument) => {
      doc.valid_to = '2025-01-01';
    },
    (doc: PricingCalendarDocument) => {
      doc.valid_to = '2050-01-01';
    },
    (doc: PricingCalendarDocument) => {
      doc.weekly[0].windows[0].start = '24:00';
    },
    (doc: PricingCalendarDocument) => {
      doc.weekly[0].windows[0].end = '09:00';
    },
    (doc: PricingCalendarDocument) => {
      doc.weekly[0].windows.push({ start: '11:00', end: '13:00', tag: 'overlap' });
    },
    (doc: PricingCalendarDocument) => {
      doc.weekly = [
        { weekdays: [7], windows: [{ start: '22:00', end: '02:00', tag: 'night' }] },
        { weekdays: [1], windows: [{ start: '01:00', end: '03:00', tag: 'overlap' }] },
      ];
    },
    (doc: PricingCalendarDocument) => {
      doc.holidays = [{ date: '2026-09-25', windows: [] }];
    },
    (doc: PricingCalendarDocument) => {
      doc.date_overrides = [
        { date: '2026-09-25', windows: [] },
        { date: '2026-09-25', windows: [] },
      ];
    },
    (doc: PricingCalendarDocument) => {
      doc.date_overrides = [{ date: '2027-09-25', windows: [] }];
    },
  ])('rejects malformed/ambiguous calendar mutation %#', (mutate) => {
    const doc = calendarFixture();
    mutate(doc);
    expect(() => CompiledPricingCalendar.compile(doc)).toThrow(PricingCompileError);
  });

  it.each([
    '2026-09-25T09:00:00',
    '2026-09-25',
    '2026-02-30T01:00:00Z',
    '2026-09-25T24:00:00Z',
    '2026-09-25T01:00:60Z',
    '2026-09-25T01:00:00+99:00',
  ])('rejects ambiguous or invalid instant %s', (instant) => {
    expect(() => parsePricingInstant(instant)).toThrow();
  });

  it('uses the declared completion-time basis but does not recompile the frozen calendar', () => {
    const content = tokenBook();
    content.calendar = calendarFixture();
    content.time_basis = 'completed_at';
    content.groups.push({
      id: 'time',
      order: 1,
      required: true,
      rules: [
        {
          id: 'peak',
          mode: 'whole_request',
          priority: 0,
          condition: { time_tags: ['peak'] },
          rates: [],
          multipliers: [{ dimension: 'uncached_input_tokens', factor: '2' }],
        },
        {
          id: 'offpeak',
          mode: 'whole_request',
          priority: 0,
          condition: { time_tags: ['offpeak'] },
          rates: [],
        },
      ],
    });
    const compiled = compilePriceBook(content, { book_id: 'time', version_id: '1' });
    const usage = tokens({ input_tokens: 1000, output_tokens: 0 });
    const context = {
      attempt_dispatched_at: '2026-09-25T08:59:00+08:00',
      completed_at: '2026-09-25T09:01:00+08:00',
    };
    const price = compiled.resolve(usage, context);
    expect(calculateCost(usage, price).amount).toBe('0.002000000');
    expect(price.selection.time_basis).toBe('completed_at');
    expect(price.selection.calendar_match?.version_id).toBe('synthetic-calendar-v1');
    expect(
      price.selection.evaluations.find((entry) => entry.rule_id === 'offpeak')?.reasons,
    ).toContain('calendar_tag_mismatch');
    expect(
      calculateCost(
        usage,
        compiled.resolve(usage, { attempt_dispatched_at: context.attempt_dispatched_at }),
      ).status,
    ).toBe('unpriced');
  });
});

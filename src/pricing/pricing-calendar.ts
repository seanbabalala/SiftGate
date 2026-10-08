import { PricingCompileError } from "./pricing-errors";
import { pricingContentHash } from "./pricing-json";
import { PricingSchemaReader } from "./pricing-schema-reader";
import {
  parsePricingDate,
  parsePricingInstant,
  shiftPricingDate,
} from "./pricing-time";
import type { PricingDiagnostic } from "./pricing.types";
import type {
  CalendarDatePlan,
  CalendarMatch,
  CalendarPreviewSegment,
  CalendarWindow,
  PricingCalendarDocument,
} from "./pricing-calendar.types";

interface Interval {
  start: number;
  end: number;
  window: CalendarWindow;
  anchor_offset: number;
}

interface CivilSelection {
  tag: string;
  source: CalendarMatch["source"];
  anchor_date: string;
  window: CalendarWindow | null;
}

export class CompiledPricingCalendar {
  readonly contentHash: string;
  private readonly content: PricingCalendarDocument;
  private readonly formatter: Intl.DateTimeFormat;
  private readonly weekly = new Map<number, CalendarWindow[]>();
  private readonly holidays: Map<string, CalendarWindow[]>;
  private readonly overrides: Map<string, CalendarWindow[]>;

  static compile(value: unknown): CompiledPricingCalendar {
    const parser = new CalendarParser();
    const content = parser.parse(value);
    if (parser.diagnostics.length)
      throw new PricingCompileError(parser.diagnostics);
    return new CompiledPricingCalendar(content);
  }

  private constructor(content: PricingCalendarDocument) {
    this.content = structuredClone(content);
    this.contentHash = pricingContentHash(this.content);
    this.formatter = makeFormatter(content.time_zone);
    for (let day = 1; day <= 7; day++)
      this.weekly.set(
        day,
        content.weekly.flatMap((plan) =>
          plan.weekdays.includes(day) ? plan.windows : [],
        ),
      );
    this.holidays = new Map(
      this.content.holidays.map((plan) => [plan.date, plan.windows]),
    );
    this.overrides = new Map(
      this.content.date_overrides.map((plan) => [plan.date, plan.windows]),
    );
  }

  document(): PricingCalendarDocument {
    return structuredClone(this.content);
  }

  tags(): string[] {
    return [
      ...new Set([
        this.content.default_tag,
        ...this.content.weekly.flatMap((plan) =>
          plan.windows.map((window) => window.tag),
        ),
        ...this.content.holidays.flatMap((plan) =>
          plan.windows.map((window) => window.tag),
        ),
        ...this.content.date_overrides.flatMap((plan) =>
          plan.windows.map((window) => window.tag),
        ),
      ]),
    ].sort();
  }

  match(instant: string): {
    match: CalendarMatch | null;
    diagnostics: PricingDiagnostic[];
  } {
    try {
      if (this.content.tzdb_version !== (process.versions.tz ?? "unknown"))
        throw new Error(
          "The frozen timezone-data version differs from this runtime; revalidation is required",
        );
      const epoch = parsePricingInstant(instant);
      const parts = Object.fromEntries(
        this.formatter
          .formatToParts(new Date(epoch))
          .map((part) => [part.type, part.value]),
      );
      const date = `${parts.year.padStart(4, "0")}-${parts.month}-${parts.day}`;
      this.requireCoveredDate(date);
      const selection = this.selectCivil(
        date,
        Number(parts.hour) * 60 + Number(parts.minute),
      );
      const civilEpoch = Date.UTC(
        Number(parts.year),
        Number(parts.month) - 1,
        Number(parts.day),
        Number(parts.hour),
        Number(parts.minute),
        Number(parts.second),
      );
      return {
        match: {
          version_id: this.content.version_id,
          content_hash: this.contentHash,
          tzdb_version: this.content.tzdb_version,
          time_zone: this.content.time_zone,
          instant: new Date(epoch).toISOString(),
          local_date: date,
          local_time: `${parts.hour}:${parts.minute}:${parts.second}.${String(new Date(epoch).getUTCMilliseconds()).padStart(3, "0")}`,
          utc_offset_seconds:
            (civilEpoch - Math.floor(epoch / 1000) * 1000) / 1000,
          ...structuredClone(selection),
        },
        diagnostics: [],
      };
    } catch (error) {
      return {
        match: null,
        diagnostics: [
          {
            code: "pricing_calendar_unavailable",
            path: "calendar",
            message: (error as Error).message,
          },
        ],
      };
    }
  }

  /** Civil schedule preview, not an assertion that every wall-clock minute exists during DST. */
  previewDate(date: string): CalendarPreviewSegment[] {
    this.requireCoveredDate(date);
    const segments: CalendarPreviewSegment[] = [];
    for (let minute = 0; minute < 1440; minute++) {
      const selection = this.selectCivil(date, minute);
      const last = segments.at(-1);
      if (
        last &&
        last.tag === selection.tag &&
        last.source === selection.source &&
        last.anchor_date === selection.anchor_date
      ) {
        last.end = minuteText(minute + 1);
      } else
        segments.push({
          start: minuteText(minute),
          end: minuteText(minute + 1),
          tag: selection.tag,
          source: selection.source,
          anchor_date: selection.anchor_date,
        });
    }
    return segments;
  }

  private requireCoveredDate(date: string): void {
    parsePricingDate(date);
    if (date < this.content.valid_from || date >= this.content.valid_to)
      throw new Error("The instant is outside the frozen calendar coverage");
  }

  private selectCivil(date: string, minute: number): CivilSelection {
    const previous = shiftPricingDate(date, -1);
    const explicit = this.exceptionSelection(
      this.overrides,
      date,
      previous,
      minute,
      "date_override",
      true,
    );
    if (explicit) return explicit;
    const holiday = this.exceptionSelection(
      this.holidays,
      date,
      previous,
      minute,
      "holiday",
      !this.overrides.has(previous),
    );
    if (holiday) return holiday;
    const weekday = new Date(parsePricingDate(date)).getUTCDay() || 7;
    const previousWeekday = weekday === 1 ? 7 : weekday - 1;
    const intervals = dayIntervals(this.weekly.get(weekday) ?? [], false);
    if (!this.overrides.has(previous) && !this.holidays.has(previous))
      intervals.push(
        ...dayIntervals(this.weekly.get(previousWeekday) ?? [], true),
      );
    const selected = intervals.find(
      (interval) => minute >= interval.start && minute < interval.end,
    );
    return selected
      ? {
          tag: selected.window.tag,
          source: "weekly",
          anchor_date: selected.anchor_offset ? previous : date,
          window: selected.window,
        }
      : {
          tag: this.content.default_tag,
          source: "fallback",
          anchor_date: date,
          window: null,
        };
  }

  private exceptionSelection(
    plans: Map<string, CalendarWindow[]>,
    date: string,
    previous: string,
    minute: number,
    source: "date_override" | "holiday",
    allowCarry: boolean,
  ): CivilSelection | null {
    const own = plans.get(date);
    if (own !== undefined) {
      const selected = dayIntervals(own, false).find(
        (interval) => minute >= interval.start && minute < interval.end,
      );
      return {
        tag: selected?.window.tag ?? this.content.default_tag,
        source,
        anchor_date: date,
        window: selected?.window ?? null,
      };
    }
    if (allowCarry) {
      const selected = dayIntervals(plans.get(previous) ?? [], true).find(
        (interval) => minute >= interval.start && minute < interval.end,
      );
      if (selected)
        return {
          tag: selected.window.tag,
          source,
          anchor_date: previous,
          window: selected.window,
        };
    }
    return null;
  }
}

function makeFormatter(timeZone: string): Intl.DateTimeFormat {
  if (!/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(timeZone))
    throw new Error("Use a named IANA time zone, not a numeric offset");
  return new Intl.DateTimeFormat("en-CA-u-ca-iso8601-nu-latn", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
}

function minuteValue(text: string, end: boolean): number {
  if (end && text === "24:00") return 1440;
  if (!/^\d{2}:\d{2}$/.test(text))
    throw new Error("Window times must use HH:mm");
  const [hour, minute] = text.split(":").map(Number);
  if (hour > 23 || minute > 59) throw new Error("Invalid window time");
  return hour * 60 + minute;
}

function minuteText(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

function dayIntervals(windows: CalendarWindow[], carry: boolean): Interval[] {
  return windows.flatMap((window) => {
    const start = minuteValue(window.start, false);
    const end = minuteValue(window.end, true);
    if (carry)
      return end < start && end > 0
        ? [{ start: 0, end, window, anchor_offset: -1 }]
        : [];
    return [{ start, end: end < start ? 1440 : end, window, anchor_offset: 0 }];
  });
}

function overlapping(intervals: Interval[]): boolean {
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  return sorted.some(
    (interval, index) => index > 0 && interval.start < sorted[index - 1].end,
  );
}

class CalendarParser extends PricingSchemaReader {
  parse(value: unknown): PricingCalendarDocument {
    const doc = this.object(value, "calendar", [
      "schema_version",
      "version_id",
      "time_zone",
      "tzdb_version",
      "valid_from",
      "valid_to",
      "default_tag",
      "weekly",
      "holiday_version",
      "holidays",
      "date_overrides",
    ]);
    if (doc.schema_version !== 1)
      this.invalid(
        "calendar.schema_version",
        "Only calendar schema 1 is supported",
      );
    const content: PricingCalendarDocument = {
      schema_version: 1,
      version_id: this.string(doc.version_id, "calendar.version_id"),
      time_zone: this.string(doc.time_zone, "calendar.time_zone"),
      tzdb_version:
        doc.tzdb_version === undefined
          ? (process.versions.tz ?? "unknown")
          : this.string(doc.tzdb_version, "calendar.tzdb_version"),
      valid_from: this.date(doc.valid_from, "calendar.valid_from"),
      valid_to: this.date(doc.valid_to, "calendar.valid_to"),
      default_tag: this.string(doc.default_tag, "calendar.default_tag"),
      weekly: this.array(doc.weekly, "calendar.weekly", 32).map(
        (item, index) => {
          const path = `calendar.weekly.${index}`;
          const plan = this.object(item, path, ["weekdays", "windows"]);
          const weekdays = this.array(plan.weekdays, `${path}.weekdays`, 7).map(
            (day, i) => this.integer(day, `${path}.weekdays.${i}`, 1, 7),
          );
          if (!weekdays.length || new Set(weekdays).size !== weekdays.length)
            this.invalid(path, "Weekdays must be nonempty and unique");
          return {
            weekdays: weekdays.sort((a, b) => a - b),
            windows: this.windows(plan.windows, `${path}.windows`),
          };
        },
      ),
      holidays: this.datePlans(doc.holidays ?? [], "calendar.holidays"),
      date_overrides: this.datePlans(
        doc.date_overrides ?? [],
        "calendar.date_overrides",
      ),
    };
    try {
      content.time_zone = makeFormatter(
        content.time_zone,
      ).resolvedOptions().timeZone;
    } catch (error) {
      this.invalid("calendar.time_zone", (error as Error).message);
    }
    if (doc.holiday_version !== undefined)
      content.holiday_version = this.string(
        doc.holiday_version,
        "calendar.holiday_version",
      );
    if (content.holidays.length && !content.holiday_version)
      this.invalid(
        "calendar.holiday_version",
        "Holiday exceptions require an explicit source version",
      );
    try {
      const days =
        (parsePricingDate(content.valid_to) -
          parsePricingDate(content.valid_from)) /
        86400000;
      if (days <= 0 || days > 3663)
        this.invalid(
          "calendar.valid_to",
          "Coverage must be a positive interval of at most ten years",
        );
    } catch {
      /* The date reader already reported invalid dates. */
    }
    for (const plan of [...content.holidays, ...content.date_overrides]) {
      if (plan.date < content.valid_from || plan.date >= content.valid_to)
        this.invalid(
          "calendar",
          "Exception dates must be within calendar coverage",
        );
    }
    try {
      for (let day = 1; day <= 7; day++) {
        const prev = day === 1 ? 7 : day - 1;
        const current = content.weekly.flatMap((plan) =>
          plan.weekdays.includes(day) ? dayIntervals(plan.windows, false) : [],
        );
        const carry = content.weekly.flatMap((plan) =>
          plan.weekdays.includes(prev) ? dayIntervals(plan.windows, true) : [],
        );
        if (overlapping([...current, ...carry]))
          this.invalid(
            `calendar.weekly.${day}`,
            "Weekly windows overlap, including previous-day carry",
            "pricing_rule_conflict",
          );
      }
    } catch {
      /* Window syntax diagnostics are collected by the window reader. */
    }
    return content;
  }

  private date(value: unknown, path: string): string {
    const text = this.string(value, path);
    try {
      parsePricingDate(text);
      if (text < "1970-01-01" || text > "9998-12-31")
        this.invalid(
          path,
          "Calendar dates must be within supported civil years 1970–9998",
        );
    } catch (error) {
      this.invalid(path, (error as Error).message);
    }
    return text;
  }

  private windows(value: unknown, path: string): CalendarWindow[] {
    const windows = this.array(value, path, 48).map((item, index) => {
      const p = `${path}.${index}`;
      const raw = this.object(item, p, ["start", "end", "tag"]);
      const window = {
        start: this.string(raw.start, `${p}.start`),
        end: this.string(raw.end, `${p}.end`),
        tag: this.string(raw.tag, `${p}.tag`),
      };
      try {
        if (minuteValue(window.start, false) === minuteValue(window.end, true))
          this.invalid(
            p,
            "Empty or ambiguous full-day window; use 00:00–24:00 explicitly",
          );
      } catch (error) {
        this.invalid(p, (error as Error).message);
      }
      return window;
    });
    try {
      if (
        overlapping(dayIntervals(windows, false)) ||
        overlapping(dayIntervals(windows, true))
      )
        this.invalid(
          path,
          "Windows overlap within a date plan",
          "pricing_rule_conflict",
        );
    } catch {
      /* Invalid time syntax is already reported. */
    }
    return windows.sort(
      (a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end),
    );
  }

  private datePlans(value: unknown, path: string): CalendarDatePlan[] {
    const plans = this.array(value, path, 3663).map((item, index) => {
      const p = `${path}.${index}`;
      const plan = this.object(item, p, ["date", "windows"]);
      return {
        date: this.date(plan.date, `${p}.date`),
        windows: this.windows(plan.windows, `${p}.windows`),
      };
    });
    if (new Set(plans.map((plan) => plan.date)).size !== plans.length)
      this.invalid(path, "A calendar layer cannot contain duplicate dates");
    return plans.sort((a, b) => a.date.localeCompare(b.date));
  }
}

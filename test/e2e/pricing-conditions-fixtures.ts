import type { PriceBookContent, PricingContext } from "../../src/pricing/pricing.types";
import type { PricingCalendarDocument, CalendarMatch } from "../../src/pricing/pricing-calendar.types";
import { book, rate } from "../unit/pricing-fixtures";

export const CONDITION_PUBLICATION_INSTANT = "2026-01-02T00:00:00.000Z";
export type ConditionBook = "tiers" | "missing-tier" | "free-tier" | "weekday" | "exceptions" | "overnight" | "fall-back" | "spring-forward";
export interface ConditionCase {
  id: string;
  book: ConditionBook;
  instant: string;
  requestedTier: string;
  resolvedTier: string;
  expected: string | null;
  expectedRule?: string;
  calendar?: Pick<CalendarMatch, "tag" | "source" | "anchor_date" | "local_time" | "utc_offset_seconds">;
}

export function conditionBook(kind: ConditionBook): PriceBookContent {
  const content = book([rate("input", "uncached_input_tokens", "1"), rate("output", "output_tokens", "2")]);
  if (kind === "missing-tier") return content;
  if (kind === "tiers" || kind === "free-tier") {
    content.groups.push({ id: "tier", order: 1, required: true, rules: [
      { id: "tier-default", priority: 0, mode: "whole_request", condition: { service_tiers: ["default"] }, rates: [] },
      { id: "tier-priority", priority: 0, mode: "whole_request", condition: { service_tiers: ["priority"] }, rates: [
        rate("priority-input", "uncached_input_tokens", kind === "free-tier" ? "0" : "5"),
        rate("priority-output", "output_tokens", kind === "free-tier" ? "0" : "6"),
      ].map(component => ({ operation: "replace", component })) },
    ] });
    return content;
  }
  const calendar: PricingCalendarDocument = {
    schema_version: 1, version_id: `synthetic-${kind}-v1`, time_zone: "Asia/Shanghai",
    tzdb_version: process.versions.tz ?? "unknown", valid_from: "2026-01-01", valid_to: "2027-01-01",
    default_tag: "offpeak", weekly: [{ weekdays: [1, 2, 3, 4, 5], windows: [{ start: "09:00", end: "12:00", tag: "peak" }] }],
    holidays: [], date_overrides: [],
  };
  if (kind === "exceptions") {
    calendar.holiday_version = "synthetic-holidays-v1";
    calendar.holidays = [{ date: "2026-09-25", windows: [] }, { date: "2026-09-28", windows: [] }];
    calendar.date_overrides = [
      { date: "2026-09-28", windows: [{ start: "09:00", end: "12:00", tag: "special" }] },
      { date: "2026-09-26", windows: [{ start: "09:00", end: "12:00", tag: "peak" }] },
    ];
  }
  if (kind === "overnight")
    calendar.weekly = [{ weekdays: [7], windows: [{ start: "22:00", end: "02:00", tag: "night" }] }];
  if (kind === "fall-back" || kind === "spring-forward") {
    calendar.time_zone = "America/New_York";
    calendar.weekly = [{ weekdays: [7], windows: [kind === "fall-back" ? { start: "01:00", end: "02:00", tag: "night" } : { start: "02:00", end: "03:00", tag: "night" }] }];
  }
  content.calendar = calendar;
  content.time_basis = "attempt_dispatched_at";
  const tags = [...new Set([calendar.default_tag, ...calendar.weekly.flatMap(day => day.windows.map(window => window.tag)), ...calendar.date_overrides.flatMap(day => day.windows.map(window => window.tag))])];
  const rates: Record<string, string> = { offpeak: "1", peak: "3", special: "7", night: "4" };
  content.groups.push({ id: "calendar", order: 1, required: true, rules: tags.map(tag => ({
    id: `time-${tag}`, priority: 0, mode: "whole_request", condition: { time_tags: [tag] },
    rates: [{ operation: "replace", component: rate(`${tag}-input`, "uncached_input_tokens", rates[tag]) }],
  })) });
  return content;
}

const tier = (id: string, kind: ConditionBook, resolvedTier: string, expected: string | null): ConditionCase => ({
  id, book: kind, instant: "2026-09-25T10:00:00+08:00", requestedTier: "priority", resolvedTier, expected,
  ...(kind === "missing-tier" ? {} : { expectedRule: `tier-${resolvedTier}` }),
});
const calendar = (id: string, kind: ConditionBook, instant: string, tag: string, source: CalendarMatch["source"], anchor_date: string, local_time: string, utc_offset_seconds = 28800): ConditionCase => ({
  id, book: kind, instant, requestedTier: "default", resolvedTier: "default",
  expected: { offpeak: "0.002000000", peak: "0.004000000", special: "0.008000000", night: "0.005000000" }[tag]!,
  expectedRule: `time-${tag}`, calendar: { tag, source, anchor_date, local_time, utc_offset_seconds },
});
export const CONDITION_CASES: ConditionCase[] = [
  tier("calc-05-resolved-default", "tiers", "default", "0.002000000"),
  tier("calc-05-resolved-priority", "tiers", "priority", "0.008000000"),
  tier("calc-06-missing-priority", "missing-tier", "priority", null),
  tier("calc-06-explicit-free", "free-tier", "priority", "0.000000000"),
  calendar("calc-07-before", "weekday", "2026-09-25T08:59:59.999+08:00", "offpeak", "fallback", "2026-09-25", "08:59:59.999"),
  calendar("calc-07-start", "weekday", "2026-09-25T09:00:00+08:00", "peak", "weekly", "2026-09-25", "09:00:00.000"),
  calendar("calc-07-last", "weekday", "2026-09-25T11:59:59.999+08:00", "peak", "weekly", "2026-09-25", "11:59:59.999"),
  calendar("calc-07-end", "weekday", "2026-09-25T12:00:00+08:00", "offpeak", "fallback", "2026-09-25", "12:00:00.000"),
  calendar("calc-08-holiday", "exceptions", "2026-09-25T10:00:00+08:00", "offpeak", "holiday", "2026-09-25", "10:00:00.000"),
  calendar("calc-08-date-priority", "exceptions", "2026-09-28T10:00:00+08:00", "special", "date_override", "2026-09-28", "10:00:00.000"),
  calendar("calc-08-working-weekend", "exceptions", "2026-09-26T10:00:00+08:00", "peak", "date_override", "2026-09-26", "10:00:00.000"),
  calendar("calc-08-weekend", "exceptions", "2026-09-27T10:00:00+08:00", "offpeak", "fallback", "2026-09-27", "10:00:00.000"),
  calendar("calc-09-overnight", "overnight", "2026-09-28T01:59:59.999+08:00", "night", "weekly", "2026-09-27", "01:59:59.999"),
  calendar("calc-09-overnight-end", "overnight", "2026-09-28T02:00:00+08:00", "offpeak", "fallback", "2026-09-28", "02:00:00.000"),
  calendar("calc-09-fall-first", "fall-back", "2026-11-01T05:30:00Z", "night", "weekly", "2026-11-01", "01:30:00.000", -14400),
  calendar("calc-09-fall-second", "fall-back", "2026-11-01T06:30:00Z", "night", "weekly", "2026-11-01", "01:30:00.000", -18000),
  calendar("calc-09-spring-before", "spring-forward", "2026-03-08T06:59:59Z", "offpeak", "fallback", "2026-03-08", "01:59:59.000", -18000),
  calendar("calc-09-spring-after", "spring-forward", "2026-03-08T07:00:00Z", "offpeak", "fallback", "2026-03-08", "03:00:00.000", -14400),
];

export function conditionEvidence() {
  return [["total_input_tokens", "1000"], ["uncached_input_tokens", "1000"], ["output_tokens", "500"]].map(([dimension, value]) => ({ dimension, value, source: "request_metadata", quality: "observed" }));
}
export function conditionContext(test: ConditionCase): PricingContext {
  return { requested_service_tier: test.requestedTier, resolved_service_tier: test.resolvedTier, attempt_dispatched_at: test.instant, provider_accepted_at: test.instant, completed_at: test.instant };
}

/** Process-local Date.now replacement only: constructor metadata, explicit dates, timers and host clock stay real. */
export function installConditionClock() {
  const originalNow = Date.now;
  let now = Date.parse(CONDITION_PUBLICATION_INSTANT);
  const clockNow = () => now;
  Date.now = clockNow;
  return {
    set(instant: string) {
      const parsed = Date.parse(instant);
      if (!Number.isFinite(parsed)) throw new Error("Invalid synthetic clock instant");
      now = parsed;
    },
    restore() {
      if (Date.now !== clockNow) throw new Error("Synthetic fixture clock was replaced unexpectedly");
      Date.now = originalNow;
    },
  };
}

export function conditionResponse(test: ConditionCase, stream: boolean) {
  const body = { id: "synthetic-conditions", model: "gpt-4o", service_tier: test.resolvedTier,
    choices: [{ index: 0, message: { role: "assistant", content: "Synthetic conditions response" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500, prompt_tokens_details: { cached_tokens: 0 }, cache_creation_input_tokens: 0 },
  };
  return stream
    ? new Response(`data: ${JSON.stringify({ ...body, choices: [] })}\n\ndata: ${JSON.stringify({ ...body, choices: [] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
    : new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

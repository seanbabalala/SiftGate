export type PricingTimeBasis =
  | "attempt_dispatched_at"
  | "provider_accepted_at"
  | "completed_at";

export interface CalendarWindow {
  start: string;
  end: string;
  tag: string;
}

export interface CalendarDatePlan {
  date: string;
  windows: CalendarWindow[];
}

export interface PricingCalendarDocument {
  schema_version: 1;
  version_id: string;
  time_zone: string;
  tzdb_version: string;
  valid_from: string;
  valid_to: string;
  default_tag: string;
  weekly: Array<{ weekdays: number[]; windows: CalendarWindow[] }>;
  holiday_version?: string;
  holidays: CalendarDatePlan[];
  date_overrides: CalendarDatePlan[];
}

export interface CalendarMatch {
  version_id: string;
  content_hash: string;
  tzdb_version: string;
  time_zone: string;
  instant: string;
  local_date: string;
  local_time: string;
  utc_offset_seconds: number;
  tag: string;
  source: "date_override" | "holiday" | "weekly" | "fallback";
  anchor_date: string;
  window: CalendarWindow | null;
}

export interface CalendarPreviewSegment {
  start: string;
  end: string;
  tag: string;
  source: CalendarMatch["source"];
  anchor_date: string;
}

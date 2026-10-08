import type { CalendarPreviewSegment } from './pricing-calendar.types';
export interface CalendarWeekDay {
  date: string;
  covered: boolean;
  segments: CalendarPreviewSegment[];
}
export interface CalendarWeekPreview {
  schema_version: 1;
  simulation: true;
  read_only: true;
  complete: true;
  interpretation: 'civil_schedule_not_elapsed_time';
  requested_date: string;
  week_start: string;
  input_hash: string;
  calendar: {
    version_id: string;
    content_hash: string;
    time_zone: string;
    tzdb_version: string;
    valid_from: string;
    valid_to: string;
    holiday_version: string | null;
  };
  days: CalendarWeekDay[];
  evidence_hash: string;
}

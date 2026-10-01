import type { MediaTaskRow } from "./media-task.types";

export interface MediaPageOptions {
  limit: number;
  cursor?: string;
}
export type MediaTaskView =
  | "all"
  | "uncertain"
  | "pending"
  | "terminal"
  | "settled"
  | "review_required";
export type MediaTaskSummary = Pick<
  MediaTaskRow,
  | "id"
  | "request_id"
  | "reservation_id"
  | "workspace_id"
  | "node_id"
  | "model"
  | "operation"
  | "state"
  | "provider_status"
  | "provider_job_id"
  | "credential_id"
  | "revision"
  | "accepted_at"
  | "terminal_at"
  | "last_error"
  | "created_at"
  | "updated_at"
>;

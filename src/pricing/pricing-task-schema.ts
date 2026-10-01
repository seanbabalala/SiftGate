import type { TableOptions } from "typeorm";
const str = (name: string, isNullable = false) => ({
  name,
  type: "varchar",
  isNullable,
});
const text = (name: string, isNullable = false) => ({
  name,
  type: "text",
  isNullable,
});
const pk = (name: string) => ({ ...str(name), isPrimary: true });
const reference = (
  name: string,
  column: string,
  table: string,
  target = "id",
) => ({
  name,
  columnNames: [column],
  referencedTableName: table,
  referencedColumnNames: [target],
  onDelete: "RESTRICT",
});
export const PRICING_TASK_DEFINITIONS: TableOptions[] = [
  {
    name: "pricing_media_submissions",
    columns: [
      pk("id"),
      str("workspace_id"),
      str("request_id"),
      str("fingerprint_hash"),
      str("state"),
      str("task_id", true),
      str("lease_until"),
      str("created_at"),
    ],
    foreignKeys: [
      reference(
        "fk_pricing_submission_snapshot",
        "request_id",
        "pricing_request_snapshots",
        "request_id",
      ),
    ],
    indices: [
      {
        name: "idx_pricing_submission_workspace",
        columnNames: ["workspace_id", "created_at"],
      },
    ],
  },
  {
    name: "pricing_media_tasks",
    columns: [
      pk("id"),
      str("client_key_hash", true),
      str("request_id"),
      str("reservation_id"),
      str("workspace_id"),
      str("node_id"),
      str("model"),
      str("operation"),
      str("api_key_id", true),
      str("api_key_name", true),
      str("namespace_id", true),
      str("provider_job_id", true),
      str("credential_id", true),
      str("connection_hash"),
      str("state"),
      str("provider_status", true),
      text("context_json"),
      str("context_hash"),
      { name: "revision", type: "integer" },
      str("accepted_at", true),
      str("terminal_at", true),
      str("last_error", true),
      str("poll_owner", true),
      str("poll_until", true),
      str("next_poll_at"),
      str("created_at"),
      str("updated_at"),
    ],
    foreignKeys: [
      reference("fk_pricing_task_attempt", "id", "pricing_attempts"),
      reference(
        "fk_pricing_task_reservation",
        "reservation_id",
        "pricing_reservations",
      ),
    ],
    indices: [
      {
        name: "idx_pricing_task_owner",
        columnNames: ["workspace_id", "api_key_id", "provider_job_id"],
      },
      {
        name: "idx_pricing_task_request",
        columnNames: ["workspace_id", "request_id"],
      },
      { name: "idx_pricing_task_poll", columnNames: ["state", "next_poll_at"] },
    ],
  },
  {
    name: "pricing_media_observations",
    columns: [
      pk("id"),
      str("task_id"),
      str("request_id"),
      str("workspace_id"),
      { name: "revision", type: "integer" },
      str("observation_hash"),
      str("status"),
      text("usage_json"),
      text("context_json"),
      str("observed_at"),
      str("action", true),
      str("expected_hash", true),
      text("cost_json", true),
      str("processing_hash", true),
      { name: "processed", type: "integer" },
    ],
    foreignKeys: [
      reference(
        "fk_pricing_observation_task",
        "task_id",
        "pricing_media_tasks",
      ),
    ],
    indices: [
      {
        name: "idx_pricing_observation_revision",
        columnNames: ["task_id", "revision"],
        isUnique: true,
      },
      {
        name: "idx_pricing_observation_identity",
        columnNames: ["task_id", "observation_hash"],
      },
      {
        name: "idx_pricing_observation_pending",
        columnNames: ["workspace_id", "processed"],
      },
    ],
  },
];

import type { TableOptions } from "typeorm";
const str = (name: string, isNullable = false) => ({
  name,
  type: "varchar",
  isNullable,
});
const pk = (name: string) => ({ ...str(name), isPrimary: true });
const ref = (name: string, column: string, table: string, target = "id") => ({
  name,
  columnNames: [column],
  referencedTableName: table,
  referencedColumnNames: [target],
  onDelete: "RESTRICT",
});
/** Additive 013 only. No changes to pre-existing task, cost or migration records. */
export const MEDIA_SUPPLIER_DEFINITIONS: TableOptions[] = [
  {
    name: "pricing_media_event_sources",
    columns: [
      pk("id"),
      ...[
        "workspace_id",
        "node_id",
        "credential_id",
        "connection_hash",
        "secret_env",
        "config_hash",
        "audit_id",
        "created_at",
        "updated_at",
      ].map((n) => str(n)),
      { name: "revision", type: "integer" },
      { name: "enabled", type: "integer" },
    ],
    foreignKeys: [
      ref("fk_media_source_audit", "audit_id", "pricing_audit_events"),
    ],
    indices: [
      { name: "idx_media_source_scope", columnNames: ["workspace_id", "id"] },
    ],
  },
  {
    name: "pricing_media_supplier_events",
    columns: [
      pk("id"),
      ...[
        "workspace_id",
        "task_id",
        "source_id",
        "source_audit_id",
        "event_id",
        "origin",
        "document_hash",
        "decision",
        "audit_id",
        "record_hash",
        "created_at",
      ].map((n) => str(n)),
      { name: "source_revision", type: "integer" },
      str("sequence", true),
      str("observation_id", true),
      { name: "document_json", type: "text" },
    ],
    foreignKeys: [
      ref("fk_media_event_source", "source_id", "pricing_media_event_sources"),
      ref("fk_media_event_task", "task_id", "pricing_media_tasks"),
      ref(
        "fk_media_event_observation",
        "observation_id",
        "pricing_media_observations",
      ),
      ref("fk_media_event_audit", "audit_id", "pricing_audit_events"),
      ref(
        "fk_media_event_source_audit",
        "source_audit_id",
        "pricing_audit_events",
      ),
    ],
    indices: [
      {
        name: "idx_media_event_identity",
        columnNames: ["source_id", "event_id"],
        isUnique: true,
      },
      {
        name: "idx_media_event_sequence",
        columnNames: ["task_id", "source_id", "sequence"],
      },
      {
        name: "idx_media_event_review",
        columnNames: ["workspace_id", "decision", "created_at"],
      },
    ],
  },
  {
    name: "pricing_media_event_heads",
    columns: [
      pk("task_id"),
      ...[
        "workspace_id",
        "source_id",
        "provider_job_id",
        "sequence",
        "event_record_id",
        "job_key",
      ].map((n) => str(n)),
    ],
    foreignKeys: [
      ref("fk_media_head_task", "task_id", "pricing_media_tasks"),
      ref(
        "fk_media_head_event",
        "event_record_id",
        "pricing_media_supplier_events",
      ),
      ref("fk_media_head_source", "source_id", "pricing_media_event_sources"),
    ],
    indices: [
      { name: "idx_media_head_job", columnNames: ["job_key"], isUnique: true },
    ],
  },
];

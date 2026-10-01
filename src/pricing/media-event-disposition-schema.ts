import type { TableOptions } from "typeorm";
const str = (name: string) => ({ name, type: "varchar" });
const ref = (name: string, column: string, table: string) => ({
  name,
  columnNames: [column],
  referencedTableName: table,
  referencedColumnNames: ["id"],
  onDelete: "RESTRICT",
});
/** Additive015. Custody receipts and original signed heads are never rewritten. */
export const MEDIA_EVENT_DISPOSITION_DEFINITIONS: TableOptions[] = [
  {
    name: "pricing_media_event_dispositions",
    columns: [
      { ...str("id"), isPrimary: true },
      ...[
        "operation_id",
        "task_id",
        "request_id",
        "workspace_id",
        "event_record_id",
        "actor_id",
        "action",
        "proposal_hash",
        "preview_hash",
        "audit_id",
        "record_hash",
        "created_at",
      ].map(str),
      { name: "revision", type: "integer" },
      { name: "document_json", type: "text" },
      { ...str("observation_id"), isNullable: true },
    ],
    foreignKeys: [
      ref("fk_media_disposition_task", "task_id", "pricing_media_tasks"),
      ref(
        "fk_media_disposition_event",
        "event_record_id",
        "pricing_media_supplier_events",
      ),
      ref(
        "fk_media_disposition_observation",
        "observation_id",
        "pricing_media_observations",
      ),
      ref("fk_media_disposition_audit", "audit_id", "pricing_audit_events"),
    ],
    indices: [
      {
        name: "idx_media_disposition_observation",
        columnNames: ["observation_id"],
        isUnique: true,
      },
      {
        name: "idx_media_disposition_operation",
        columnNames: ["workspace_id", "operation_id"],
        isUnique: true,
      },
      {
        name: "idx_media_disposition_event",
        columnNames: ["event_record_id"],
        isUnique: true,
      },
      {
        name: "idx_media_disposition_revision",
        columnNames: ["task_id", "revision"],
        isUnique: true,
      },
      {
        name: "idx_media_disposition_authority",
        columnNames: ["task_id", "action", "revision"],
      },
    ],
  },
  {
    name: "pricing_media_event_authorities",
    columns: [
      { ...str("task_id"), isPrimary: true },
      str("workspace_id"),
      str("disposition_id"),
    ],
    foreignKeys: [
      ref("fk_media_authority_task", "task_id", "pricing_media_tasks"),
      ref(
        "fk_media_authority_disposition",
        "disposition_id",
        "pricing_media_event_dispositions",
      ),
    ],
  },
];

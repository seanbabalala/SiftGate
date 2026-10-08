import type { TableOptions } from "typeorm";
const str = (name: string) => ({ name, type: "varchar" });
const ref = (name: string, column: string, table: string) => ({
  name,
  columnNames: [column],
  referencedTableName: table,
  referencedColumnNames: ["id"],
  onDelete: "RESTRICT",
});
/** Additive014: successful, audited job association receipts. Previews never write. */
export const MEDIA_JOB_LOOKUP_DEFINITIONS: TableOptions[] = [
  {
    name: "pricing_media_job_reconciliations",
    columns: [
      { ...str("id"), isPrimary: true },
      ...[
        "operation_id",
        "task_id",
        "request_id",
        "workspace_id",
        "actor_id",
        "provider_job_id",
        "credential_id",
        "connection_hash",
        "job_key",
        "basis_hash",
        "proposal_hash",
        "observation_hash",
        "cost_hash",
        "observation_id",
        "audit_id",
        "record_hash",
        "created_at",
      ].map(str),
      { name: "document_json", type: "text" },
    ],
    foreignKeys: [
      ref("fk_media_lookup_task", "task_id", "pricing_media_tasks"),
      ref(
        "fk_media_lookup_observation",
        "observation_id",
        "pricing_media_observations",
      ),
      ref("fk_media_lookup_audit", "audit_id", "pricing_audit_events"),
    ],
    indices: [
      {
        name: "idx_media_lookup_operation",
        columnNames: ["workspace_id", "operation_id"],
        isUnique: true,
      },
      {
        name: "idx_media_lookup_task",
        columnNames: ["task_id"],
        isUnique: true,
      },
      {
        name: "idx_media_lookup_job",
        columnNames: ["job_key"],
        isUnique: true,
      },
    ],
  },
];

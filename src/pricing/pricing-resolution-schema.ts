import type { TableOptions } from "typeorm";

/** Immutable link from an operator decision to its mandatory pricing audit. */
export const PRICING_RESOLUTION_DEFINITIONS: TableOptions[] = [
  {
    name: "pricing_recovery_decisions",
    columns: [
      { name: "reservation_id", type: "varchar", isPrimary: true },
      { name: "workspace_id", type: "varchar" },
      { name: "resolution_audit_id", type: "varchar" },
      { name: "payload_hash", type: "varchar" },
      { name: "created_at", type: "varchar" },
    ],
    foreignKeys: [
      {
        name: "fk_pricing_recovery_decision_reservation",
        columnNames: ["reservation_id"],
        referencedTableName: "pricing_reservations",
        referencedColumnNames: ["id"],
        onDelete: "RESTRICT",
      },
      {
        name: "fk_pricing_recovery_decision_audit",
        columnNames: ["resolution_audit_id"],
        referencedTableName: "pricing_audit_events",
        referencedColumnNames: ["id"],
        onDelete: "RESTRICT",
      },
    ],
    indices: [
      {
        name: "idx_pricing_recovery_decision_workspace",
        columnNames: ["workspace_id", "resolution_audit_id"],
      },
    ],
  },
  {
    name: "pricing_batch_manifests",
    columns: [
      { name: "physical_attempt_id", type: "varchar", isPrimary: true },
      { name: "workspace_id", type: "varchar" },
      { name: "batch_id", type: "varchar" },
      { name: "manifest_json", type: "text" },
      { name: "manifest_hash", type: "varchar" },
      { name: "created_at", type: "varchar" },
    ],
    indices: [
      {
        name: "idx_pricing_batch_manifest_workspace",
        columnNames: ["workspace_id", "created_at"],
      },
    ],
  },
];

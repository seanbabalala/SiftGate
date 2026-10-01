import type { TableOptions } from "typeorm";
const str = (name: string) => ({ name, type: "varchar" });
export const PRICING_GROUP_OUTCOME_DEFINITIONS: TableOptions[] = [
  {
    name: "pricing_runtime_group_outcomes",
    columns: [
      { ...str("id"), isPrimary: true },
      ...[
        "workspace_id",
        "kind",
        "subject_id",
        "document_hash",
        "members_hash",
        "state",
        "created_at",
        "updated_at",
        "next_attempt_at",
      ].map(str),
      { name: "document_json", type: "text" },
      { name: "member_count", type: "integer" },
      { name: "attempts", type: "integer" },
      { ...str("last_error_code"), isNullable: true },
      { ...str("delivered_at"), isNullable: true },
    ],
    indices: [
      {
        name: "idx_pricing_group_outcome_due",
        columnNames: ["state", "next_attempt_at", "id"],
      },
      {
        name: "idx_pricing_group_outcome_subject",
        columnNames: ["workspace_id", "kind", "subject_id"],
      },
      {
        name: "idx_pricing_group_outcome_inventory",
        columnNames: ["workspace_id", "state", "created_at", "id"],
      },
    ],
  },
  {
    name: "pricing_runtime_group_outcome_members",
    columns: [
      { ...str("outcome_id"), isPrimary: true },
      { ...str("reservation_id"), isPrimary: true },
      str("workspace_id"),
      str("request_id"),
    ],
    foreignKeys: [
      {
        name: "fk_pricing_group_outcome_member_parent",
        columnNames: ["outcome_id"],
        referencedTableName: "pricing_runtime_group_outcomes",
        referencedColumnNames: ["id"],
        onDelete: "RESTRICT",
      },
      {
        name: "fk_pricing_group_outcome_member_hold",
        columnNames: ["reservation_id"],
        referencedTableName: "pricing_reservations",
        referencedColumnNames: ["id"],
        onDelete: "RESTRICT",
      },
    ],
    indices: [
      {
        name: "idx_pricing_group_outcome_member_scope",
        columnNames: ["workspace_id", "reservation_id", "outcome_id"],
      },
    ],
  },
];

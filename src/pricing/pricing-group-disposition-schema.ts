import type { TableOptions } from "typeorm";
export const PRICING_GROUP_DISPOSITION_DEFINITIONS: TableOptions[] = [
  {
    name: "pricing_runtime_group_dispositions",
    columns: [
      { name: "outcome_id", type: "varchar", isPrimary: true },
      ...[
        "workspace_id",
        "operation_id",
        "actor_id",
        "action",
        "outcome_hash",
        "proposal_hash",
        "result_hash",
        "audit_id",
        "created_at",
      ].map((name) => ({ name, type: "varchar" })),
      { name: "result_json", type: "text" },
    ],
    foreignKeys: [
      {
        name: "fk_pricing_group_disposition_outcome",
        columnNames: ["outcome_id"],
        referencedTableName: "pricing_runtime_group_outcomes",
        referencedColumnNames: ["id"],
        onDelete: "RESTRICT",
      },
    ],
    indices: [
      {
        name: "idx_pricing_group_disposition_operation",
        columnNames: ["workspace_id", "operation_id"],
        isUnique: true,
      },
    ],
  },
];

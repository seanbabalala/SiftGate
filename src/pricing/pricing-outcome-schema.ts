import type { TableOptions } from "typeorm";

/** Internal runtime receipts, not a public supplier callback or an invoice ledger. */
export const PRICING_OUTCOME_DEFINITIONS: TableOptions[] = [
  {
    name: "pricing_runtime_outcomes",
    columns: [
      { name: "id", type: "varchar", isPrimary: true },
      ...[
        "workspace_id",
        "request_id",
        "reservation_id",
        "subject_id",
        "kind",
        "source",
        "outcome_hash",
        "state",
        "created_at",
        "updated_at",
        "next_attempt_at",
      ].map((name) => ({ name, type: "varchar" })),
      { name: "outcome_json", type: "text" },
      { name: "attempts", type: "integer" },
      { name: "last_error_code", type: "varchar", isNullable: true },
      { name: "delivered_at", type: "varchar", isNullable: true },
    ],
    foreignKeys: [
      {
        name: "fk_pricing_runtime_outcome_reservation",
        columnNames: ["reservation_id"],
        referencedTableName: "pricing_reservations",
        referencedColumnNames: ["id"],
        onDelete: "RESTRICT",
      },
    ],
    indices: [
      {
        name: "idx_pricing_runtime_outcome_due",
        columnNames: ["state", "next_attempt_at", "id"],
      },
      {
        name: "idx_pricing_runtime_outcome_subject",
        columnNames: ["workspace_id", "kind", "subject_id"],
      },
      {
        name: "idx_pricing_runtime_outcome_inventory",
        columnNames: ["workspace_id", "state", "created_at", "id"],
      },
    ],
  },
];

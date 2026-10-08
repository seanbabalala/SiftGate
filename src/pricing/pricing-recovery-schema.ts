import type { TableOptions } from "typeorm";

/** Additive step: neither catalog nor ledger migration checksums are rewritten. */
export const PRICING_RECOVERY_DEFINITIONS: TableOptions[] = [
  {
    name: "pricing_settlement_intents",
    columns: [
      { name: "reservation_id", type: "varchar", isPrimary: true },
      { name: "workspace_id", type: "varchar" },
      { name: "request_id", type: "varchar" },
      { name: "payload_json", type: "text" },
      { name: "payload_hash", type: "varchar" },
      { name: "state", type: "varchar" },
      { name: "attempt_count", type: "integer" },
      { name: "next_attempt_at", type: "varchar" },
      { name: "last_error_code", type: "varchar", isNullable: true },
      { name: "created_at", type: "varchar" },
      { name: "applied_at", type: "varchar", isNullable: true },
    ],
    foreignKeys: [
      {
        name: "fk_pricing_intent_reservation",
        columnNames: ["reservation_id"],
        referencedTableName: "pricing_reservations",
        referencedColumnNames: ["id"],
        onDelete: "RESTRICT",
      },
    ],
    indices: [
      {
        name: "idx_pricing_intent_retry",
        columnNames: ["state", "next_attempt_at"],
      },
      {
        name: "idx_pricing_intent_workspace_request",
        columnNames: ["workspace_id", "request_id"],
      },
    ],
  },
];

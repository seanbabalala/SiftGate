import type { TableOptions } from "typeorm";

const text = (name: string, isNullable = false) => ({
  name,
  type: "text",
  isNullable,
});
const str = (name: string, isNullable = false) => ({
  name,
  type: "varchar",
  isNullable,
});

/** Costs stay append-only; this table links each revision to its exact budget effect. */
export const PRICING_ADJUSTMENT_DEFINITIONS: TableOptions[] = [
  {
    name: "pricing_adjustment_applications",
    columns: [
      { ...str("adjustment_id"), isPrimary: true },
      str("workspace_id"),
      str("request_id"),
      str("attempt_id"),
      str("reservation_id", true),
      { name: "revision", type: "integer" },
      str("actor_id"),
      str("source"),
      str("budget_state"),
      str("application_hash"),
      text("budget_cost_before", true),
      text("budget_cost_after", true),
      text("budget_tokens_before", true),
      text("budget_tokens_after", true),
      text("cost_delta"),
      text("tokens_delta"),
      text("allocations_json"),
      str("created_at"),
    ],
    foreignKeys: [
      {
        name: "fk_pricing_adjustment_application",
        columnNames: ["adjustment_id"],
        referencedTableName: "pricing_cost_adjustments",
        referencedColumnNames: ["id"],
        onDelete: "RESTRICT",
      },
      {
        name: "fk_pricing_adjustment_reservation",
        columnNames: ["reservation_id"],
        referencedTableName: "pricing_reservations",
        referencedColumnNames: ["id"],
        onDelete: "RESTRICT",
      },
    ],
    indices: [
      {
        name: "idx_pricing_adjustment_revision",
        columnNames: ["workspace_id", "attempt_id", "revision"],
        isUnique: true,
      },
      {
        name: "idx_pricing_adjustment_request",
        columnNames: ["workspace_id", "request_id"],
      },
    ],
  },
];

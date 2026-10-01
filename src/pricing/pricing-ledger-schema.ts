import type { TableOptions } from "typeorm";

const text = (name: string, nullable = false) => ({
  name,
  type: "text",
  isNullable: nullable,
});
const str = (name: string, nullable = false) => ({
  name,
  type: "varchar",
  isNullable: nullable,
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

export const PRICING_LEDGER_DEFINITIONS: TableOptions[] = [
  {
    name: "pricing_budget_balances",
    columns: [
      { name: "rule_id", type: "integer", isPrimary: true },
      pk("period_start"),
      str("workspace_id"),
      text("amount_decimal"),
      str("legacy_projection"),
    ],
    indices: [
      {
        name: "idx_pricing_balance_workspace",
        columnNames: ["workspace_id", "rule_id"],
      },
    ],
  },
  {
    name: "pricing_reservations",
    columns: [
      pk("id"),
      str("request_id"),
      str("workspace_id"),
      str("state"),
      text("identity_json"),
      text("target_json"),
      text("estimate_json"),
      text("reserved_tokens"),
      text("reserved_cost_usd"),
      text("holds_json"),
      text("committed_tokens"),
      text("committed_cost_usd"),
      str("budget_basis"),
      str("lease_owner"),
      str("lease_until"),
      str("job_id", true),
      str("created_at"),
      str("updated_at"),
    ],
    foreignKeys: [
      reference(
        "fk_pricing_reservation_request",
        "request_id",
        "pricing_request_snapshots",
        "request_id",
      ),
    ],
    indices: [
      {
        name: "idx_pricing_reservation_workspace_request",
        columnNames: ["workspace_id", "request_id"],
      },
      {
        name: "idx_pricing_reservation_lease",
        columnNames: ["state", "lease_until"],
      },
    ],
  },
  {
    name: "pricing_budget_effects",
    columns: [
      pk("id"),
      str("reservation_id"),
      str("request_id"),
      str("workspace_id"),
      str("kind"),
      text("tokens_decimal"),
      text("cost_decimal"),
      text("allocations_json"),
      str("created_at"),
    ],
    foreignKeys: [
      reference(
        "fk_pricing_effect_reservation",
        "reservation_id",
        "pricing_reservations",
      ),
    ],
    indices: [
      {
        name: "idx_pricing_effect_workspace_request",
        columnNames: ["workspace_id", "request_id"],
      },
    ],
  },
  {
    name: "pricing_attempts",
    columns: [
      pk("id"),
      str("request_id"),
      str("workspace_id"),
      str("reservation_id", true),
      str("node_id"),
      str("model"),
      str("state"),
      str("fee_source"),
      str("dispatched_at"),
      str("completed_at", true),
      text("price_context_json"),
      text("cost_json", true),
      str("cost_hash", true),
      str("error_code", true),
    ],
    foreignKeys: [
      reference(
        "fk_pricing_attempt_request",
        "request_id",
        "pricing_request_snapshots",
        "request_id",
      ),
      reference(
        "fk_pricing_attempt_reservation",
        "reservation_id",
        "pricing_reservations",
      ),
    ],
    indices: [
      {
        name: "idx_pricing_attempt_workspace_request",
        columnNames: ["workspace_id", "request_id"],
      },
    ],
  },
  {
    name: "pricing_cost_adjustments",
    columns: [
      pk("id"),
      str("attempt_id"),
      str("workspace_id"),
      str("previous_hash"),
      str("cost_hash"),
      text("cost_json"),
      text("reason"),
      str("created_at"),
    ],
    foreignKeys: [
      reference(
        "fk_pricing_adjustment_attempt",
        "attempt_id",
        "pricing_attempts",
      ),
    ],
    indices: [
      {
        name: "idx_pricing_adjustment_attempt",
        columnNames: ["workspace_id", "attempt_id"],
      },
    ],
  },
];

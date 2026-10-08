import type { TableOptions } from "typeorm";

/** An observation/review journal, never a fabricated settlement or automatic release. */
export const PRICING_ORPHAN_DEFINITIONS: TableOptions[] = [
  {
    name: "pricing_recovery_cases",
    columns: [
      { name: "reservation_id", type: "varchar", isPrimary: true },
      { name: "workspace_id", type: "varchar" },
      { name: "request_id", type: "varchar" },
      { name: "state", type: "varchar" },
      { name: "reason", type: "varchar" },
      { name: "revision", type: "integer" },
      { name: "evidence_json", type: "text" },
      { name: "evidence_hash", type: "varchar" },
      { name: "created_at", type: "varchar" },
      { name: "updated_at", type: "varchar" },
      { name: "checked_at", type: "varchar" },
      { name: "resolved_at", type: "varchar", isNullable: true },
      { name: "resolution_code", type: "varchar", isNullable: true },
    ],
    foreignKeys: [
      {
        name: "fk_pricing_recovery_case_reservation",
        columnNames: ["reservation_id"],
        referencedTableName: "pricing_reservations",
        referencedColumnNames: ["id"],
        onDelete: "RESTRICT",
      },
    ],
    indices: [
      {
        name: "idx_pricing_recovery_case_workspace",
        columnNames: ["workspace_id", "state", "updated_at"],
      },
    ],
  },
];

export type { PricingRecoveryCaseRow, PricingRecoveryCaseSummary } from './pricing-orphan.types';

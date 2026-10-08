import type { TableOptions } from "typeorm";

/** Additive metadata only. No defaults/backfill that equate historical creators with owners. */
export const PRICING_BOOK_MANAGEMENT_DEFINITIONS: TableOptions[] = [{
  name: "pricing_book_management",
  columns: [
    { name: "book_id", type: "varchar", isPrimary: true },
    { name: "owner", type: "varchar", isNullable: true },
    { name: "revision", type: "integer" },
    { name: "updated_by", type: "varchar" },
    { name: "updated_at", type: "varchar" },
  ],
  foreignKeys: [{ name: "fk_pricing_management_book", columnNames: ["book_id"], referencedTableName: "pricing_books", referencedColumnNames: ["id"], onDelete: "RESTRICT" }],
}];

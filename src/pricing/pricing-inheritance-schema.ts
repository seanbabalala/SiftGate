import type { TableOptions } from "typeorm";

const text = (name: string) => ({ name, type: "text" });
const str = (name: string) => ({ name, type: "varchar" });
const parentKey = {
  columnNames: ["parent_book_id", "parent_version_id"],
  referencedTableName: "pricing_book_versions",
  referencedColumnNames: ["book_id", "version_id"],
  onDelete: "RESTRICT",
};
const shared = [
  ...[
    "parent_book_id",
    "parent_version_id",
    "parent_content_hash",
    "content_hash",
    "record_hash",
    "audit_id",
    "actor_id",
    "created_at",
  ].map(str),
  text("payload_json"),
];
/** Additive only: old version bodies and migration001–011 are never rewritten. */
export const PRICING_INHERITANCE_DEFINITIONS: TableOptions[] = [
  {
    name: "pricing_draft_inheritance",
    columns: [
      { ...str("draft_id"), isPrimary: true },
      str("book_id"),
      { name: "draft_revision", type: "integer" },
      ...shared,
    ],
    foreignKeys: [
      {
        name: "fk_pricing_inherited_draft",
        columnNames: ["draft_id"],
        referencedTableName: "pricing_drafts",
        referencedColumnNames: ["id"],
        onDelete: "RESTRICT",
      },
      { name: "fk_pricing_draft_parent", ...parentKey },
      {
        name: "fk_pricing_draft_inheritance_audit",
        columnNames: ["audit_id"],
        referencedTableName: "pricing_audit_events",
        referencedColumnNames: ["id"],
        onDelete: "RESTRICT",
      },
    ],
  },
  {
    name: "pricing_version_inheritance",
    columns: [
      { ...str("book_id"), isPrimary: true },
      { ...str("version_id"), isPrimary: true },
      ...shared,
    ],
    foreignKeys: [
      {
        name: "fk_pricing_inherited_version",
        columnNames: ["book_id", "version_id"],
        referencedTableName: "pricing_book_versions",
        referencedColumnNames: ["book_id", "version_id"],
        onDelete: "RESTRICT",
      },
      { name: "fk_pricing_version_parent", ...parentKey },
      {
        name: "fk_pricing_version_inheritance_audit",
        columnNames: ["audit_id"],
        referencedTableName: "pricing_audit_events",
        referencedColumnNames: ["id"],
        onDelete: "RESTRICT",
      },
    ],
    indices: [
      {
        name: "idx_pricing_inheritance_parent",
        columnNames: ["parent_book_id", "parent_version_id"],
      },
    ],
  },
];

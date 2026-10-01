import { MEDIA_EVENT_DISPOSITION_DEFINITIONS } from "./media-event-disposition-schema";
import { PRICING_BOOK_MANAGEMENT_DEFINITIONS } from "./pricing-book-management-schema";
import { ACTUAL_BUDGET_COHORT_DEFINITIONS } from "./actual-upstream-budget-cohort";
import { MEDIA_JOB_LOOKUP_DEFINITIONS } from "./media-job-lookup-schema";
import { MEDIA_SUPPLIER_DEFINITIONS } from "./media-supplier-schema";
import { PRICING_GROUP_DISPOSITION_DEFINITIONS } from "./pricing-group-disposition-schema";
import { PRICING_INHERITANCE_DEFINITIONS } from "./pricing-inheritance-schema";
import { PRICING_GROUP_OUTCOME_DEFINITIONS } from "./pricing-group-outcome-schema";
import { PRICING_RESOLUTION_DEFINITIONS } from "./pricing-resolution-schema";
import { PRICING_ORPHAN_DEFINITIONS } from "./pricing-orphan-schema";
import { PRICING_TASK_DEFINITIONS } from "./pricing-task-schema";
import { PRICING_ADJUSTMENT_DEFINITIONS } from "./pricing-adjustment-schema";
import { DataSource, QueryRunner, Table, TableIndex, type TableOptions, type EntityManager } from "typeorm";
import { PRICING_MEDIA_OWNERSHIP_INDEXES, inspectPricingIndexMigration, pricingIndexPlan, type PricingIndexAddition, type PricingIndexPlan } from "./pricing-index-migrations";
import { pricingContentHash } from "./pricing-json";
import { PRICING_LEDGER_DEFINITIONS } from "./pricing-ledger-schema";

import { PRICING_RECOVERY_DEFINITIONS } from "./pricing-recovery-schema";
import { PRICING_OUTCOME_DEFINITIONS } from "./pricing-outcome-schema";
import { PRICING_OUTCOME_DISPOSITION_DEFINITIONS } from "./pricing-outcome-disposition-schema";

export const PRICING_SCHEMA_VERSION = "pricing-engine-018";
export const PRICING_LEDGER_SCHEMA_VERSION = "pricing-engine-002";
export const PRICING_LEDGER_SCHEMA_CHECKSUM = pricingContentHash(
  PRICING_LEDGER_DEFINITIONS,
);

const stringColumn = (name: string, nullable = false) => ({
  name,
  type: "varchar",
  isNullable: nullable,
});
const textColumn = (name: string) => ({
  name,
  type: "text",
  isNullable: false,
});
const primaryColumn = (name: string) => ({
  ...stringColumn(name),
  isPrimary: true,
});
const relation = (
  name: string,
  columns: string[],
  table: string,
  referenced: string[],
) => ({
  name,
  columnNames: columns,
  referencedTableName: table,
  referencedColumnNames: referenced,
  onDelete: "RESTRICT" as const,
});

const DEFINITIONS: TableOptions[] = [
  {
    name: "pricing_schema_versions",
    columns: [
      primaryColumn("id"),
      stringColumn("checksum"),
      stringColumn("applied_at"),
    ],
  },
  {
    name: "pricing_books",
    columns: [
      primaryColumn("id"),
      stringColumn("workspace_id", true),
      stringColumn("name"),
      stringColumn("created_by"),
      stringColumn("created_at"),
      stringColumn("updated_at"),
    ],
    indices: [
      { name: "idx_pricing_books_workspace", columnNames: ["workspace_id"] },
    ],
  },
  {
    name: "pricing_drafts",
    columns: [
      primaryColumn("id"),
      stringColumn("book_id"),
      { name: "revision", type: "integer" },
      textColumn("content_json"),
      stringColumn("created_by"),
      stringColumn("created_at"),
      stringColumn("updated_at"),
    ],
    foreignKeys: [
      relation("fk_pricing_draft_book", ["book_id"], "pricing_books", ["id"]),
    ],
    indices: [{ name: "idx_pricing_drafts_book", columnNames: ["book_id"] }],
  },
  {
    name: "pricing_book_versions",
    columns: [
      primaryColumn("book_id"),
      primaryColumn("version_id"),
      stringColumn("content_hash"),
      textColumn("content_json"),
      stringColumn("published_by"),
      stringColumn("published_at"),
      textColumn("reason"),
    ],
    foreignKeys: [
      relation("fk_pricing_version_book", ["book_id"], "pricing_books", ["id"]),
    ],
  },
  {
    name: "pricing_catalog_revisions",
    columns: [
      primaryColumn("id"),
      stringColumn("parent_revision_id", true),
      stringColumn("content_hash"),
      textColumn("manifest_json"),
      stringColumn("published_by"),
      stringColumn("published_at"),
      textColumn("reason"),
    ],
    foreignKeys: [
      relation(
        "fk_pricing_catalog_parent",
        ["parent_revision_id"],
        "pricing_catalog_revisions",
        ["id"],
      ),
    ],
  },
  {
    name: "pricing_catalog_head",
    columns: [
      primaryColumn("id"),
      stringColumn("catalog_revision_id", true),
      { name: "revision", type: "integer" },
    ],
    foreignKeys: [
      relation(
        "fk_pricing_head_revision",
        ["catalog_revision_id"],
        "pricing_catalog_revisions",
        ["id"],
      ),
    ],
  },
  {
    name: "pricing_audit_events",
    columns: [
      primaryColumn("id"),
      stringColumn("workspace_id", true),
      stringColumn("book_id", true),
      stringColumn("actor_id"),
      stringColumn("action"),
      textColumn("reason"),
      textColumn("metadata_json"),
      stringColumn("created_at"),
    ],
    indices: [
      {
        name: "idx_pricing_audit_workspace_time",
        columnNames: ["workspace_id", "created_at"],
      },
    ],
  },
  {
    name: "pricing_request_snapshots",
    columns: [
      primaryColumn("request_id"),
      stringColumn("workspace_id"),
      stringColumn("catalog_revision_id"),
      stringColumn("snapshot_hash"),
      textColumn("descriptor_json"),
      stringColumn("created_at"),
    ],
    foreignKeys: [
      relation(
        "fk_pricing_snapshot_catalog",
        ["catalog_revision_id"],
        "pricing_catalog_revisions",
        ["id"],
      ),
    ],
    indices: [
      {
        name: "idx_pricing_snapshot_workspace_time",
        columnNames: ["workspace_id", "created_at"],
      },
    ],
  },
];

interface PricingMigration {
  version: string;
  definitions: TableOptions[];
  indexes?: PricingIndexAddition[];
  checksum: string;
}

export const PRICING_MIGRATIONS: PricingMigration[] = [
  {
    version: "pricing-engine-001",
    definitions: DEFINITIONS,
    checksum: pricingContentHash(DEFINITIONS),
  },
  {
    version: PRICING_LEDGER_SCHEMA_VERSION,
    definitions: PRICING_LEDGER_DEFINITIONS,
    checksum: PRICING_LEDGER_SCHEMA_CHECKSUM,
  },
  {
    version: "pricing-engine-003",
    definitions: PRICING_RECOVERY_DEFINITIONS,
    checksum: pricingContentHash(PRICING_RECOVERY_DEFINITIONS),
  },
  {
    version: "pricing-engine-004",
    definitions: PRICING_ADJUSTMENT_DEFINITIONS,
    checksum: pricingContentHash(PRICING_ADJUSTMENT_DEFINITIONS),
  },
  {
    version: "pricing-engine-005",
    definitions: PRICING_TASK_DEFINITIONS,
    checksum: pricingContentHash(PRICING_TASK_DEFINITIONS),
  },
  {
    version: "pricing-engine-006",
    definitions: PRICING_ORPHAN_DEFINITIONS,
    checksum: pricingContentHash(PRICING_ORPHAN_DEFINITIONS),
  },
  {
    version: "pricing-engine-007",
    definitions: PRICING_RESOLUTION_DEFINITIONS,
    checksum: pricingContentHash(PRICING_RESOLUTION_DEFINITIONS),
  },
  {
    version: "pricing-engine-008",
    definitions: PRICING_OUTCOME_DEFINITIONS,
    checksum: pricingContentHash(PRICING_OUTCOME_DEFINITIONS),
  },
  {
    version: "pricing-engine-009",
    definitions: PRICING_OUTCOME_DISPOSITION_DEFINITIONS,
    checksum: pricingContentHash(PRICING_OUTCOME_DISPOSITION_DEFINITIONS),
  },
  {
    version: "pricing-engine-010",
    definitions: PRICING_GROUP_OUTCOME_DEFINITIONS,
    checksum: pricingContentHash(PRICING_GROUP_OUTCOME_DEFINITIONS),
  },
  {
    version: "pricing-engine-011",
    definitions: PRICING_GROUP_DISPOSITION_DEFINITIONS,
    checksum: pricingContentHash(PRICING_GROUP_DISPOSITION_DEFINITIONS),
  },
  {
    version: "pricing-engine-012",
    definitions: PRICING_INHERITANCE_DEFINITIONS,
    checksum: pricingContentHash(PRICING_INHERITANCE_DEFINITIONS),
  },
  {
    version: "pricing-engine-013",
    definitions: MEDIA_SUPPLIER_DEFINITIONS,
    checksum: pricingContentHash(MEDIA_SUPPLIER_DEFINITIONS),
  },
  {
    version: "pricing-engine-014",
    definitions: MEDIA_JOB_LOOKUP_DEFINITIONS,
    checksum: pricingContentHash(MEDIA_JOB_LOOKUP_DEFINITIONS),
  },
  { version: "pricing-engine-015", definitions: MEDIA_EVENT_DISPOSITION_DEFINITIONS, checksum: pricingContentHash(MEDIA_EVENT_DISPOSITION_DEFINITIONS) },
  { version: "pricing-engine-016", definitions: ACTUAL_BUDGET_COHORT_DEFINITIONS, checksum: pricingContentHash(ACTUAL_BUDGET_COHORT_DEFINITIONS) },
  { version: "pricing-engine-017", definitions: PRICING_BOOK_MANAGEMENT_DEFINITIONS, checksum: pricingContentHash(PRICING_BOOK_MANAGEMENT_DEFINITIONS) },
  { version: "pricing-engine-018", definitions: [], indexes: PRICING_MEDIA_OWNERSHIP_INDEXES, checksum: pricingContentHash({ indexes: PRICING_MEDIA_OWNERSHIP_INDEXES }) },
];
export const PRICING_SCHEMA_CHECKSUM =
  PRICING_MIGRATIONS[PRICING_MIGRATIONS.length - 1].checksum;
export const PRICING_TABLE_NAMES = PRICING_MIGRATIONS.flatMap((step) =>
  step.definitions.map((table) => table.name),
);
export const PRICING_INDEX_PLANS = PRICING_MIGRATIONS.flatMap(step => (step.indexes ?? []).map(pricingIndexPlan));

/** Bounded startup/readiness check; the caller has already checked table existence. */
export async function pricingMigrationMarkersReady(manager: EntityManager): Promise<boolean> {
  const rows = await manager.createQueryBuilder().select(["m.id AS id", "m.checksum AS checksum"])
    .from("pricing_schema_versions", "m").limit(PRICING_MIGRATIONS.length + 1)
    .getRawMany<{ id: string; checksum: string }>();
  if (rows.length !== PRICING_MIGRATIONS.length) return false;
  const markers = new Map(rows.map(row => [row.id, row.checksum]));
  return markers.size === PRICING_MIGRATIONS.length && PRICING_MIGRATIONS.every(step => markers.get(step.version) === step.checksum);
}

export interface PricingSchemaPlan {
  version: string;
  checksum: string;
  state: "pending" | "applied" | "conflict";
  create_tables: string[];
  create_indexes?: PricingIndexPlan[];
  issues: string[];
}

/** Read-only inspection of an already initialized, explicitly selected database. */
export async function planPricingSchema(
  dataSource: DataSource,
): Promise<PricingSchemaPlan> {
  assertDatabase(dataSource);
  const runner = dataSource.createQueryRunner();
  try {
    return await inspect(runner);
  } finally {
    await runner.release();
  }
}

/** No module startup hook calls this. Operators must opt into the migration separately. */
export async function applyPricingSchema(
  dataSource: DataSource,
): Promise<PricingSchemaPlan> {
  assertDatabase(dataSource);
  const runner = dataSource.createQueryRunner();
  await runner.startTransaction();
  try {
    const plan = await inspect(runner);
    if (plan.state === "conflict")
      throw new Error(`Pricing schema conflict: ${plan.issues.join("; ")}`);
    for (const step of PRICING_MIGRATIONS) {
      const stepPlan = await inspectStep(runner, step);
      if (stepPlan.state !== "pending") continue;
      for (const definition of step.definitions)
        await runner.createTable(
          new Table(structuredClone(definition)),
          false,
          true,
          true,
        );
      for (const index of step.indexes ?? [])
        await runner.createIndex(index.table, new TableIndex(index.definition));
      await runner.manager
        .createQueryBuilder()
        .insert()
        .into("pricing_schema_versions")
        .values({
          id: step.version,
          checksum: step.checksum,
          applied_at: new Date().toISOString(),
        })
        .execute();
      if (step.version === "pricing-engine-001")
        await runner.manager
          .createQueryBuilder()
          .insert()
          .into("pricing_catalog_head")
          .values({ id: "active", catalog_revision_id: null, revision: 0 })
          .execute();
    }
    await runner.commitTransaction();
    return { ...plan, state: "applied", create_tables: [], create_indexes: [] };
  } catch (error) {
    if (runner.isTransactionActive) await runner.rollbackTransaction();
    throw error;
  } finally {
    await runner.release();
  }
}

/** Safe downgrade for an unused installation only; actual price/snapshot data requires a backup plan. */
export async function removeEmptyPricingSchema(
  dataSource: DataSource,
): Promise<void> {
  assertDatabase(dataSource);
  const runner = dataSource.createQueryRunner();
  await runner.startTransaction();
  try {
    const plan = await inspect(runner);
    if (plan.state !== "applied")
      throw new Error("Only an intact, empty pricing schema can be removed");
    for (const table of PRICING_TABLE_NAMES.filter(
      (name) =>
        name !== "pricing_schema_versions" && name !== "pricing_catalog_head",
    )) {
      const rows: Array<{ count: string | number }> = await runner.query(
        `SELECT COUNT(*) AS count FROM "${table}"`,
      );
      if (Number(rows[0].count) !== 0)
        throw new Error(`Refusing to remove nonempty pricing table ${table}`);
    }
    const head: Array<{
      catalog_revision_id: string | null;
      revision: number;
    }> = await runner.query(
      "SELECT catalog_revision_id, revision FROM pricing_catalog_head",
    );
    if (
      head.length !== 1 ||
      head[0].catalog_revision_id !== null ||
      Number(head[0].revision) !== 0
    )
      throw new Error("Refusing to remove an activated pricing catalog");
    for (const table of [...PRICING_TABLE_NAMES].reverse())
      await runner.dropTable(table, false, true, true);
    await runner.commitTransaction();
  } catch (error) {
    if (runner.isTransactionActive) await runner.rollbackTransaction();
    throw error;
  } finally {
    await runner.release();
  }
}

function assertDatabase(dataSource: DataSource): void {
  if (!dataSource.isInitialized)
    throw new Error(
      "Initialize the explicitly selected database before planning pricing migrations",
    );
  if (
    dataSource.options.type !== "better-sqlite3" &&
    dataSource.options.type !== "postgres"
  )
    throw new Error("Pricing migrations support SQLite and PostgreSQL only");
}

async function inspect(runner: QueryRunner): Promise<PricingSchemaPlan> {
  const parts: PricingSchemaPlan[] = [];
  for (const step of PRICING_MIGRATIONS)
    parts.push(await inspectStep(runner, step));
  const issues = parts.flatMap((part) => part.issues);
  for (let index = 1; index < parts.length; index++) {
    if (
      parts[index].state === "applied" &&
      parts.slice(0, index).some((part) => part.state !== "applied")
    )
      issues.push(
        `Migration ${parts[index].version} requires all earlier pricing migrations`,
      );
  }
  return {
    version: PRICING_SCHEMA_VERSION,
    checksum: PRICING_SCHEMA_CHECKSUM,
    state: issues.length
      ? "conflict"
      : parts.every((part) => part.state === "applied")
        ? "applied"
        : "pending",
    create_tables: parts.flatMap((part) => part.create_tables),
    create_indexes: parts.flatMap(part => part.create_indexes ?? []),
    issues,
  };
}

async function inspectStep(
  runner: QueryRunner,
  step: (typeof PRICING_MIGRATIONS)[number],
): Promise<PricingSchemaPlan> {
  if (step.indexes?.length) {
    if (step.definitions.length) throw new Error("Mixed table/index pricing migrations require an explicit migration strategy");
    const plan = await inspectPricingIndexMigration(runner, { ...step, indexes: step.indexes });
    return { version: step.version, checksum: step.checksum, create_tables: [], ...plan };
  }
  const names = step.definitions.map((table) => table.name);
  const plan: PricingSchemaPlan = {
    version: step.version,
    checksum: step.checksum,
    state: "pending",
    create_tables: [...names],
    issues: [],
  };
  const existing = await runner.getTables(names);
  if (existing.length === 0) {
    if (await runner.hasTable("pricing_schema_versions")) {
      const marker = await runner.manager
        .createQueryBuilder()
        .select("m.id")
        .from("pricing_schema_versions", "m")
        .where("m.id = :id", { id: step.version })
        .getRawOne();
      if (marker) {
        plan.state = "conflict";
        plan.issues.push(
          `Migration ${step.version} has a marker but its tables are missing`,
        );
      }
    }
    return plan;
  }
  plan.create_tables = names.filter(
    (name) => !existing.some((table) => table.name === name),
  );
  if (plan.create_tables.length)
    plan.issues.push(
      "Partial pricing schema exists; automatic repair or overwrite is not permitted",
    );
  for (const definition of step.definitions) {
    const table = existing.find((entry) => entry.name === definition.name);
    if (!table) continue;
    for (const column of definition.columns ?? []) {
      const actual = table.columns.find((entry) => entry.name === column.name);
      if (
        !actual ||
        normalizedType(actual.type) !== normalizedType(String(column.type)) ||
        actual.isPrimary !== Boolean(column.isPrimary) ||
        actual.isNullable !== Boolean(column.isNullable)
      )
        plan.issues.push(
          `Incompatible column ${definition.name}.${column.name}`,
        );
    }
    const indices = await orderedIndices(runner, table);
    for (const index of definition.indices ?? [])
      if (
        !indices.some(
          (actual) =>
            actual.name === index.name &&
            Boolean(actual.isUnique) === Boolean(index.isUnique) &&
            actual.columnNames.join(",") === index.columnNames?.join(","),
        )
      )
        plan.issues.push(`Missing index ${index.name}`);
    const foreignKeys = definition.foreignKeys?.length
      ? await orderedForeignKeys(runner, table)
      : [];
    for (const foreignKey of definition.foreignKeys ?? [])
      if (
        !foreignKeys.some(
          (actual) =>
            actual.name === foreignKey.name &&
            actual.columnNames.join(",") === foreignKey.columnNames.join(",") &&
            actual.referencedTableName === foreignKey.referencedTableName &&
            actual.referencedColumnNames.join(",") ===
              foreignKey.referencedColumnNames.join(","),
        )
      )
        plan.issues.push(`Missing relation ${foreignKey.name}`);
  }
  if (
    (await runner.hasTable("pricing_schema_versions")) &&
    !plan.issues.some((issue) => issue.includes("pricing_schema_versions"))
  ) {
    const rows: Array<{ id: string; checksum: string }> = await runner.query(
      "SELECT id, checksum FROM pricing_schema_versions",
    );
    if (
      !rows.some(
        (row) => row.id === step.version && row.checksum === step.checksum,
      )
    )
      plan.issues.push("Pricing migration checksum is missing or differs");
  }
  plan.state = plan.issues.length ? "conflict" : "applied";
  return plan;
}

function normalizedType(type: string): string {
  if (type === "character varying") return "varchar";
  if (type === "int4" || type === "int") return "integer";
  return type;
}

/** PostgreSQL restore can change the inspector's join order, not the constraint.
 * Keep each local/reference pair in catalog ordinality; never sort column sets.
 */
async function orderedForeignKeys(
  runner: QueryRunner,
  table: Table,
): Promise<Array<{
  name?: string;
  columnNames: string[];
  referencedTableName: string;
  referencedColumnNames: string[];
}>> {
  if (runner.connection.options.type !== "postgres") return table.foreignKeys;
  const rows: Array<{
    name: string;
    schema_name: string;
    referenced_schema_name: string;
    referenced_table_name: string;
    column_names: string[];
    referenced_column_names: string[];
  }> = await runner.query(
    `
    SELECT c.conname AS name, n.nspname AS schema_name,
           rn.nspname AS referenced_schema_name, rt.relname AS referenced_table_name,
           array_agg(a.attname::text ORDER BY k.ordinality) AS column_names,
           array_agg(ra.attname::text ORDER BY k.ordinality) AS referenced_column_names
    FROM pg_catalog.pg_constraint c
    JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
    JOIN pg_catalog.pg_class rt ON rt.oid = c.confrelid
    JOIN pg_catalog.pg_namespace rn ON rn.oid = rt.relnamespace
    CROSS JOIN LATERAL unnest(c.conkey, c.confkey)
      WITH ORDINALITY AS k(attnum, referenced_attnum, ordinality)
    JOIN pg_catalog.pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
    JOIN pg_catalog.pg_attribute ra ON ra.attrelid = rt.oid AND ra.attnum = k.referenced_attnum
    WHERE c.contype = 'f' AND c.convalidated
      AND n.nspname = COALESCE($1, current_schema()) AND t.relname = $2
    GROUP BY c.conname, n.nspname, rn.nspname, rt.relname`,
    [table.schema ?? null, table.name.split(".").pop()],
  );
  return rows.map(row => ({
    name: row.name,
    columnNames: row.column_names,
    referencedTableName: row.schema_name === row.referenced_schema_name
      ? row.referenced_table_name
      : `${row.referenced_schema_name}.${row.referenced_table_name}`,
    referencedColumnNames: row.referenced_column_names,
  }));
}

/** The pinned TypeORM PostgreSQL inspector loses multi-column index order.
 * Read key ordinality from the catalog instead of weakening the migration check.
 */
async function orderedIndices(
  runner: QueryRunner,
  table: Table,
): Promise<Array<{ name?: string; columnNames: string[]; isUnique: boolean }>> {
  if (runner.connection.options.type !== "postgres") return table.indices;
  const rows: Array<{
    name: string;
    column_names: string[];
    is_unique: boolean;
  }> = await runner.query(
    `
    SELECT i.relname AS name, array_agg(a.attname::text ORDER BY k.ordinality) AS column_names,
           x.indisunique AS is_unique
    FROM pg_catalog.pg_class t
    JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
    JOIN pg_catalog.pg_index x ON x.indrelid = t.oid
    JOIN pg_catalog.pg_class i ON i.oid = x.indexrelid
    CROSS JOIN LATERAL unnest(x.indkey) WITH ORDINALITY AS k(attnum, ordinality)
    JOIN pg_catalog.pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
    WHERE n.nspname = COALESCE($1, current_schema()) AND t.relname = $2
      AND x.indpred IS NULL AND x.indexprs IS NULL AND x.indisvalid AND x.indisready
      AND k.ordinality <= x.indnkeyatts
    GROUP BY i.relname, x.indisunique`,
    [table.schema ?? null, table.name.split(".").pop()],
  );
  return rows.map((row) => ({
    name: row.name,
    columnNames: row.column_names,
    isUnique: row.is_unique,
  }));
}

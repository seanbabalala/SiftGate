import type { QueryRunner, TableIndexOptions } from "typeorm";

export interface PricingIndexAddition {
  table: string;
  definition: TableIndexOptions;
}
export interface PricingIndexPlan {
  table: string;
  name: string;
  column_names: string[];
}

export const PRICING_MEDIA_OWNERSHIP_INDEXES: PricingIndexAddition[] = [{
  table: "pricing_media_tasks",
  definition: { name: "idx_pricing_task_reservation_state", columnNames: ["workspace_id", "reservation_id", "state"] },
}];

export function pricingIndexPlan(index: PricingIndexAddition): PricingIndexPlan {
  if (!index.definition.name || !index.definition.columnNames?.length) throw new Error("A pricing index migration requires an explicit name and ordered columns");
  return { table: index.table, name: index.definition.name, column_names: [...index.definition.columnNames] };
}

interface IndexShape {
  table: string;
  columns: string[];
  unique: boolean;
  plain: boolean;
}

/** Inspect names across the selected schema, not only the intended table. Never adopt or repair an existing object. */
async function indexShape(runner: QueryRunner, plan: PricingIndexPlan): Promise<IndexShape | null> {
  if (runner.connection.options.type === "better-sqlite3") {
    const objects: Array<{ type: string; tbl_name: string }> = await runner.query("SELECT type, tbl_name FROM sqlite_master WHERE name = ?", [plan.name]);
    if (!objects.length) return null;
    const object = objects[0], quotedTable = '"' + object.tbl_name.replace(/"/g, '""') + '"', quotedIndex = '"' + plan.name.replace(/"/g, '""') + '"';
    if (object.type !== "index") return { table: object.tbl_name, columns: [], unique: false, plain: false };
    const list: Array<{ name: string; unique: number; partial: number }> = await runner.query(`PRAGMA index_list(${quotedTable})`);
    const definition = list.find(item => item.name === plan.name);
    const info: Array<{ seqno: number; cid: number; name: string | null; desc: number; coll: string; key: number }> = await runner.query(`PRAGMA index_xinfo(${quotedIndex})`);
    const keys = info.filter(item => item.key === 1).sort((a, b) => a.seqno - b.seqno);
    return { table: object.tbl_name, columns: keys.map(item => item.name ?? ""), unique: definition?.unique === 1,
      plain: Boolean(definition && definition.partial === 0 && keys.length && keys.every(item => item.cid >= 0 && item.desc === 0 && item.coll === "BINARY")) };
  }
  if (runner.connection.options.type !== "postgres") throw new Error("Unsupported pricing index database");
  const rows: Array<{ kind: string; table_name: string | null; column_names: string[] | null; is_unique: boolean | null; plain: boolean | null }> = await runner.query(`
    SELECT c.relkind AS kind, t.relname AS table_name, x.indisunique AS is_unique,
      (SELECT array_agg(a.attname::text ORDER BY k.ordinality)
       FROM unnest(x.indkey) WITH ORDINALITY AS k(attnum, ordinality)
       JOIN pg_catalog.pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
       WHERE k.ordinality <= x.indnkeyatts) AS column_names,
      (c.relkind = 'i' AND am.amname = 'btree' AND x.indisvalid AND x.indisready
       AND x.indpred IS NULL AND x.indexprs IS NULL AND x.indnatts = x.indnkeyatts
       AND NOT EXISTS (SELECT 1 FROM unnest(x.indoption) AS opt(value) WHERE opt.value <> 0)
       AND NOT EXISTS (SELECT 1 FROM unnest(x.indclass) AS classes(class_id)
                       JOIN pg_catalog.pg_opclass oc ON oc.oid = classes.class_id WHERE NOT oc.opcdefault)
       AND NOT EXISTS (SELECT 1 FROM unnest(x.indcollation) WITH ORDINALITY AS ic(collation_id, ordinality)
                       JOIN unnest(x.indkey) WITH ORDINALITY AS k(attnum, ordinality) USING (ordinality)
                       JOIN pg_catalog.pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
                       WHERE ic.collation_id <> a.attcollation)) AS plain
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_catalog.pg_index x ON x.indexrelid = c.oid
    LEFT JOIN pg_catalog.pg_class t ON t.oid = x.indrelid
    LEFT JOIN pg_catalog.pg_am am ON am.oid = c.relam
    WHERE n.nspname = COALESCE($1, current_schema()) AND c.relname = $2`, [runner.connection.options.schema ?? null, plan.name]);
  if (!rows.length) return null;
  const row = rows[0];
  return { table: row.table_name ?? "", columns: row.column_names ?? [], unique: row.is_unique === true, plain: row.plain === true };
}

export async function inspectPricingIndexMigration(runner: QueryRunner, step: { version: string; checksum: string; indexes: PricingIndexAddition[] }) {
  const issues: string[] = [], create_indexes: PricingIndexPlan[] = [];
  let marker: { id: string; checksum: string } | undefined;
  if (await runner.hasTable("pricing_schema_versions")) marker = await runner.manager.createQueryBuilder().select(["m.id AS id", "m.checksum AS checksum"]).from("pricing_schema_versions", "m").where("m.id = :id", { id: step.version }).getRawOne();
  if (marker && marker.checksum !== step.checksum) issues.push(`Migration ${step.version} checksum differs`);
  for (const addition of step.indexes) {
    const plan = pricingIndexPlan(addition), existing = await indexShape(runner, plan);
    if (!marker) {
      if (existing) issues.push(`Index ${plan.name} already exists without its migration marker; automatic adoption is not permitted`);
      else create_indexes.push(plan);
      continue;
    }
    if (!(await runner.hasTable(plan.table)) || !existing) issues.push(`Migration ${step.version} has a marker but index ${plan.name} is missing`);
    else if (!existing.plain || existing.table !== plan.table || existing.unique !== Boolean(addition.definition.isUnique) || existing.columns.join(",") !== plan.column_names.join(","))
      issues.push(`Incompatible pricing index ${plan.name}`);
  }
  return { state: issues.length ? "conflict" as const : marker ? "applied" as const : "pending" as const,
    create_indexes: issues.length ? [] : create_indexes, issues };
}

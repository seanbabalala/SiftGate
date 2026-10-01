import { DataSource, Table, TableForeignKey, TableIndex } from "typeorm";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyPricingSchema,
  planPricingSchema,
  PRICING_MIGRATIONS,
} from "../../src/pricing/pricing-schema";

const postgresUrl = process.env.SIFTGATE_PRICING_TEST_POSTGRES_URL;
if (postgresUrl) {
  const url = new URL(postgresUrl);
  if (url.hostname !== "127.0.0.1" || url.port === "2099" || !/^\/pricing_goal_[a-z0-9_]+$/.test(url.pathname))
    throw new Error("Foreign-key tests require an isolated loopback pricing_goal_* database");
}

for (const dialect of ["better-sqlite3", "postgres"] as const) {
  const suite = dialect === "postgres" && !postgresUrl ? describe.skip : describe;
  suite(`pricing foreign-key inspection (${dialect})`, () => {
    let db: DataSource;
    let admin: DataSource | undefined;
    let directory: string | undefined;
    let schema: string;
    let foreignSchema: string;

    beforeEach(async () => {
      if (dialect === "better-sqlite3") {
        directory = mkdtempSync(join(tmpdir(), "pricing-fk-"));
        db = new DataSource({ type: dialect, database: join(directory, "gateway.sqlite"), synchronize: false });
      } else {
        schema = `pricing_fk_${process.pid}_${Math.random().toString(16).slice(2)}`;
        foreignSchema = `${schema}_foreign`;
        admin = new DataSource({ type: dialect, url: postgresUrl, synchronize: false });
        await admin.initialize();
        await admin.query(`CREATE SCHEMA "${schema}"`);
        db = new DataSource({ type: dialect, url: postgresUrl, schema, extra: { options: `-c search_path=${schema}` }, synchronize: false });
      }
      await db.initialize();
    });
    afterEach(async () => {
      await db?.destroy();
      if (admin?.isInitialized) {
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await admin.query(`DROP SCHEMA IF EXISTS "${foreignSchema}" CASCADE`);
        await admin.destroy();
      }
      if (directory) rmSync(directory, { recursive: true, force: true });
    });

    it("accepts equivalent constraints despite reversed physical column order without rewriting markers", async () => {
      const runner = db.createQueryRunner();
      try {
        for (const step of PRICING_MIGRATIONS) {
          for (const definition of step.definitions) {
            const copy = structuredClone(definition);
            copy.columns = [...(copy.columns ?? [])].reverse();
            await runner.createTable(new Table(copy), false, true, true);
          }
          for (const index of step.indexes ?? []) await runner.createIndex(index.table, new TableIndex(index.definition));
          await runner.manager.createQueryBuilder().insert().into("pricing_schema_versions").values({ id: step.version, checksum: step.checksum, applied_at: "2026-09-29T00:00:00.000Z" }).execute();
        }
      } finally { await runner.release(); }
      const before = await db.query("SELECT * FROM pricing_schema_versions ORDER BY id");
      expect(await planPricingSchema(db)).toMatchObject({ state: "applied", issues: [], create_tables: [], create_indexes: [] });
      expect(await applyPricingSchema(db)).toMatchObject({ state: "applied", create_tables: [], create_indexes: [] });
      expect(await db.query("SELECT * FROM pricing_schema_versions ORDER BY id")).toEqual(before);
    });

    async function replaceParent(localColumns: string[], targetColumns: string[]) {
      const runner = db.createQueryRunner();
      try {
        await runner.dropForeignKey("pricing_draft_inheritance", "fk_pricing_draft_parent");
        await runner.createForeignKey("pricing_draft_inheritance", new TableForeignKey({ name: "fk_pricing_draft_parent", columnNames: localColumns, referencedTableName: "pricing_book_versions", referencedColumnNames: targetColumns, onDelete: "RESTRICT" }));
      } finally { await runner.release(); }
    }

    it.each([
      ["referenced", ["parent_book_id", "parent_version_id"], ["version_id", "book_id"]],
      ["local", ["parent_version_id", "parent_book_id"], ["book_id", "version_id"]],
    ])("rejects reordered %s composite key columns without automatic repair", async (_label, local, target) => {
      await applyPricingSchema(db);
      const before = await db.query("SELECT * FROM pricing_schema_versions ORDER BY id");
      await replaceParent(local as string[], target as string[]);
      expect(await planPricingSchema(db)).toMatchObject({ state: "conflict", issues: expect.arrayContaining(["Missing relation fk_pricing_draft_parent"]) });
      await expect(applyPricingSchema(db)).rejects.toThrow("Missing relation fk_pricing_draft_parent");
      expect(await db.query("SELECT * FROM pricing_schema_versions ORDER BY id")).toEqual(before);
    });

    it("rejects a missing composite relation with surviving migration markers", async () => {
      await applyPricingSchema(db);
      const runner = db.createQueryRunner();
      try { await runner.dropForeignKey("pricing_draft_inheritance", "fk_pricing_draft_parent"); }
      finally { await runner.release(); }
      expect(await planPricingSchema(db)).toMatchObject({ state: "conflict", issues: expect.arrayContaining(["Missing relation fk_pricing_draft_parent"]) });
    });

    if (dialect === "postgres") {
      it("reads catalog key ordinality when TypeORM returns composite pairs in planner order", async () => {
        await applyPricingSchema(db);
        const before = await db.query("SELECT * FROM pricing_schema_versions ORDER BY id");
        const createRunner = db.createQueryRunner.bind(db);
        const factory = jest.spyOn(db, "createQueryRunner").mockImplementation(() => {
          const runner = createRunner();
          const getTables = runner.getTables.bind(runner);
          jest.spyOn(runner, "getTables").mockImplementation(async names => {
            const tables = await getTables(names);
            for (const table of tables) for (const key of table.foreignKeys) {
              if (key.columnNames.length > 1) {
                const definition = PRICING_MIGRATIONS.flatMap(step => step.definitions)
                  .flatMap(table => table.foreignKeys ?? []).find(item => item.name === key.name);
                if (!definition) throw new Error("Unknown composite fixture relation");
                key.columnNames = [...definition.columnNames].reverse();
                key.referencedColumnNames = [...definition.referencedColumnNames].reverse();
              }
            }
            return tables;
          });
          return runner;
        });
        try {
          expect(await planPricingSchema(db)).toMatchObject({ state: "applied", issues: [] });
        } finally { factory.mockRestore(); }
        expect(await db.query("SELECT * FROM pricing_schema_versions ORDER BY id")).toEqual(before);
      });

      it("rejects an identically named target table in another schema", async () => {
        await applyPricingSchema(db);
        await admin!.query(`CREATE SCHEMA "${foreignSchema}"`);
        await admin!.query(`CREATE TABLE "${foreignSchema}".pricing_book_versions (book_id varchar NOT NULL, version_id varchar NOT NULL, PRIMARY KEY (book_id, version_id))`);
        await db.query(`ALTER TABLE pricing_draft_inheritance DROP CONSTRAINT fk_pricing_draft_parent`);
        await db.query(`ALTER TABLE pricing_draft_inheritance ADD CONSTRAINT fk_pricing_draft_parent FOREIGN KEY (parent_book_id, parent_version_id) REFERENCES "${foreignSchema}".pricing_book_versions (book_id, version_id) ON DELETE RESTRICT`);
        expect(await planPricingSchema(db)).toMatchObject({ state: "conflict", issues: expect.arrayContaining(["Missing relation fk_pricing_draft_parent"]) });
      });

      it("rejects a NOT VALID relation rather than certifying unchecked historical data", async () => {
        await applyPricingSchema(db);
        await db.query(`ALTER TABLE pricing_draft_inheritance DROP CONSTRAINT fk_pricing_draft_parent`);
        await db.query(`ALTER TABLE pricing_draft_inheritance ADD CONSTRAINT fk_pricing_draft_parent FOREIGN KEY (parent_book_id, parent_version_id) REFERENCES pricing_book_versions (book_id, version_id) ON DELETE RESTRICT NOT VALID`);
        expect(await planPricingSchema(db)).toMatchObject({ state: "conflict", issues: expect.arrayContaining(["Missing relation fk_pricing_draft_parent"]) });
      });
    }
  });
}

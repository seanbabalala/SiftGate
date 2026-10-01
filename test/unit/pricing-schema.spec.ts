import { DataSource, Table, TableIndex } from "typeorm";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tokenBook } from "./pricing-fixtures";
import { pricingContentHash } from "../../src/pricing/pricing-json";
import {
  applyPricingSchema,
  planPricingSchema,
  PRICING_TABLE_NAMES,
  PRICING_MIGRATIONS,
  removeEmptyPricingSchema,
} from "../../src/pricing/pricing-schema";

function schemaContract(
  label: string,
  connect: () => Promise<{
    dataSource: DataSource;
    cleanup: () => Promise<void>;
  }>,
  run: (name: string, body: () => void) => void = describe,
) {
  run(label, () => {
    let dataSource: DataSource;
    let cleanup: () => Promise<void>;
    beforeEach(async () => {
      ({ dataSource, cleanup } = await connect());
    });
    afterEach(async () => {
      await dataSource?.destroy();
      await cleanup?.();
    });

    it("adds017 management metadata without changing populated sixteen-version state or assigning historical owners", async () => {
      expect(PRICING_MIGRATIONS[15]).toMatchObject({ version: "pricing-engine-016", checksum: "22318759470cf0db388f416b649df0ed1bf92c24cd98980a1a21d696cc9425cd" });
      const runner = dataSource.createQueryRunner(), now = "2026-09-01T00:00:00.000Z", content = tokenBook();
      try {
        for (const step of PRICING_MIGRATIONS.slice(0, 16)) {
          for (const definition of step.definitions) await runner.createTable(new Table(structuredClone(definition)), false, true, true);
          await runner.manager.createQueryBuilder().insert().into("pricing_schema_versions").values({ id: step.version, checksum: step.checksum, applied_at: now }).execute();
        }
        await runner.manager.createQueryBuilder().insert().into("pricing_catalog_head").values({ id: "active", catalog_revision_id: null, revision: 0 }).execute();
        await runner.manager.createQueryBuilder().insert().into("pricing_books").values({ id: "historical-book", workspace_id: "workspace-a", name: "Historical price", created_by: "former-author", created_at: now, updated_at: now }).execute();
        await runner.manager.createQueryBuilder().insert().into("pricing_book_versions").values({ book_id: "historical-book", version_id: "historical-version", content_hash: pricingContentHash(content), content_json: JSON.stringify(content), published_by: "former-publisher", published_at: now, reason: "Historical synthetic publication" }).execute();
        await runner.manager.createQueryBuilder().insert().into("pricing_drafts").values({ id: "historical-draft", book_id: "historical-book", revision: 8, content_json: JSON.stringify(content), created_by: "another-author", created_at: now, updated_at: now }).execute();
      } finally { await runner.release(); }
      const tables = PRICING_MIGRATIONS.slice(0, 16).flatMap(step => step.definitions.map(table => table.name));
      const before = await Promise.all(tables.map(table => dataSource.query(`SELECT * FROM ${table}`)));
      expect((await planPricingSchema(dataSource)).create_tables).toEqual(["pricing_book_management"]);
      expect(await Promise.all(tables.map(table => dataSource.query(`SELECT * FROM ${table}`)))).toEqual(before);
      await applyPricingSchema(dataSource);
      for (let index = 0; index < tables.length; index++) {
        const rows = await dataSource.query(`SELECT * FROM ${tables[index]}`);
        expect(tables[index] === "pricing_schema_versions" ? rows.slice(0, 16) : rows).toEqual(before[index]);
      }
      expect(await dataSource.query("SELECT * FROM pricing_book_management")).toEqual([]);
      expect((await applyPricingSchema(dataSource)).create_tables).toEqual([]);
    });

    it("adds016 closed actual-budget cohorts without changing fifteen prior migration records", async () => {
      expect(PRICING_MIGRATIONS[14]).toMatchObject({ version: "pricing-engine-015", checksum: "2d37ff30e6446adeba3e9aae5835886c9fcacb3b2354005f751e8ba92a193c74" });
      const runner = dataSource.createQueryRunner();
      try {
        for (const step of PRICING_MIGRATIONS.slice(0, 15)) {
          for (const definition of step.definitions) await runner.createTable(new Table(structuredClone(definition)), false, true, true);
          await runner.manager.createQueryBuilder().insert().into("pricing_schema_versions").values({ id: step.version, checksum: step.checksum, applied_at: "2026-09-28T00:00:00.000Z" }).execute();
        }
        await runner.manager.createQueryBuilder().insert().into("pricing_catalog_head").values({ id: "active", catalog_revision_id: null, revision: 0 }).execute();
      } finally { await runner.release(); }
      const before = await dataSource.query("SELECT * FROM pricing_schema_versions ORDER BY id");
      expect((await planPricingSchema(dataSource)).create_tables).toEqual(["pricing_actual_budget_cohorts", "pricing_book_management"]);
      await applyPricingSchema(dataSource);
      expect((await dataSource.query("SELECT * FROM pricing_schema_versions ORDER BY id")).slice(0, 15)).toEqual(before);
      expect((await planPricingSchema(dataSource)).state).toBe("applied");
      expect((await applyPricingSchema(dataSource)).state).toBe("applied");
      expect(await dataSource.query("SELECT * FROM pricing_actual_budget_cohorts")).toEqual([]);
    });

    it("adds015 event disposition without changing fourteen frozen migrations", async () => {
      expect(PRICING_MIGRATIONS[13]).toMatchObject({
        version: "pricing-engine-014",
        checksum:
          "7361a5d072c5a15dabab16239e76a12df7f6755e97bf691ab7c30555f44575cb",
      });
      const runner = dataSource.createQueryRunner();
      try {
        for (const step of PRICING_MIGRATIONS.slice(0, 14)) {
          for (const definition of step.definitions)
            await runner.createTable(
              new Table(structuredClone(definition)),
              false,
              true,
              true,
            );
          await runner.manager
            .createQueryBuilder()
            .insert()
            .into("pricing_schema_versions")
            .values({
              id: step.version,
              checksum: step.checksum,
              applied_at: "2026-09-27T00:00:00.000Z",
            })
            .execute();
        }
        await runner.manager
          .createQueryBuilder()
          .insert()
          .into("pricing_catalog_head")
          .values({ id: "active", catalog_revision_id: null, revision: 0 })
          .execute();
      } finally {
        await runner.release();
      }
      const before = await dataSource.query(
        "SELECT * FROM pricing_schema_versions ORDER BY id",
      );
      expect((await planPricingSchema(dataSource)).create_tables).toEqual([
        "pricing_media_event_dispositions",
        "pricing_media_event_authorities",
        "pricing_actual_budget_cohorts",
        "pricing_book_management",
      ]);
      await applyPricingSchema(dataSource);
      expect(
        (
          await dataSource.query(
            "SELECT * FROM pricing_schema_versions ORDER BY id",
          )
        ).slice(0, 14),
      ).toEqual(before);
      expect((await planPricingSchema(dataSource)).state).toBe("applied");
    });
    it("adds014 reconciliation custody without changing thirteen frozen migrations", async () => {
      expect(PRICING_MIGRATIONS[12]).toMatchObject({
        version: "pricing-engine-013",
        checksum:
          "9c2c2d9762002af0d372ab7aa4a273353808964d4a7b78987e0e3c353283de40",
      });
      const runner = dataSource.createQueryRunner();
      try {
        for (const step of PRICING_MIGRATIONS.slice(0, 13)) {
          for (const definition of step.definitions)
            await runner.createTable(
              new Table(structuredClone(definition)),
              false,
              true,
              true,
            );
          await runner.manager
            .createQueryBuilder()
            .insert()
            .into("pricing_schema_versions")
            .values({
              id: step.version,
              checksum: step.checksum,
              applied_at: "2026-09-27T00:00:00.000Z",
            })
            .execute();
        }
        await runner.manager
          .createQueryBuilder()
          .insert()
          .into("pricing_catalog_head")
          .values({ id: "active", catalog_revision_id: null, revision: 0 })
          .execute();
      } finally {
        await runner.release();
      }
      const before = await dataSource.query(
        "SELECT * FROM pricing_schema_versions ORDER BY id",
      );
      expect((await planPricingSchema(dataSource)).create_tables).toEqual([
        "pricing_media_job_reconciliations",
        "pricing_media_event_dispositions",
        "pricing_media_event_authorities",
        "pricing_actual_budget_cohorts",
        "pricing_book_management",
      ]);
      await applyPricingSchema(dataSource);
      expect(
        (
          await dataSource.query(
            "SELECT * FROM pricing_schema_versions ORDER BY id",
          )
        ).slice(0, 13),
      ).toEqual(before);
      expect((await planPricingSchema(dataSource)).state).toBe("applied");
    });
    it("adds supplier-event custody013 without changing the twelve prior migrations", async () => {
      expect(PRICING_MIGRATIONS[11].version).toBe("pricing-engine-012");
      expect(PRICING_MIGRATIONS[11].checksum).toBe(
        "b685c257e0f967d99dbe37016f3a6d56812ab21e3df583d44ba3ea8dfa203f80",
      );
      expect(new Set(PRICING_MIGRATIONS.map((s) => s.version)).size).toBe(
        PRICING_MIGRATIONS.length,
      );
      const runner = dataSource.createQueryRunner();
      try {
        for (const step of PRICING_MIGRATIONS.slice(0, 12)) {
          for (const definition of step.definitions)
            await runner.createTable(
              new Table(structuredClone(definition)),
              false,
              true,
              true,
            );
          await runner.manager
            .createQueryBuilder()
            .insert()
            .into("pricing_schema_versions")
            .values({
              id: step.version,
              checksum: step.checksum,
              applied_at: "2026-09-27T00:00:00.000Z",
            })
            .execute();
        }
        await runner.manager
          .createQueryBuilder()
          .insert()
          .into("pricing_catalog_head")
          .values({ id: "active", catalog_revision_id: null, revision: 0 })
          .execute();
      } finally {
        await runner.release();
      }
      const before = await dataSource.query(
        "SELECT * FROM pricing_schema_versions ORDER BY id",
      );
      expect((await planPricingSchema(dataSource)).create_tables).toEqual(
        PRICING_MIGRATIONS.slice(12).flatMap((step) =>
          step.definitions.map((table) => table.name),
        ),
      );
      await applyPricingSchema(dataSource);
      expect(
        (
          await dataSource.query(
            "SELECT * FROM pricing_schema_versions ORDER BY id",
          )
        ).slice(0, 12),
      ).toEqual(before);
      expect((await planPricingSchema(dataSource)).state).toBe("applied");
    });
    it("MIG-TEST-03 plans without writes, migrates explicitly, and checks idempotence", async () => {
      expect((await planPricingSchema(dataSource)).state).toBe("pending");
      expect((await planPricingSchema(dataSource)).create_tables).toEqual(
        PRICING_TABLE_NAMES,
      );
      const runner = dataSource.createQueryRunner();
      try {
        expect(await runner.hasTable("pricing_books")).toBe(false);
      } finally {
        await runner.release();
      }
      expect((await applyPricingSchema(dataSource)).state).toBe("applied");
      expect((await planPricingSchema(dataSource)).issues).toEqual([]);
      expect((await applyPricingSchema(dataSource)).state).toBe("applied");
      expect(
        await dataSource.query("SELECT * FROM pricing_catalog_head"),
      ).toHaveLength(1);
    });

    it("upgrades an existing 005 schema while preserving all five frozen migration checksums", async () => {
      const frozen = [
        {
          version: "pricing-engine-001",
          checksum:
            "cd7183321583fe8ec4e6878174e6c44e6e51f13889e7ef656d43af1884b7ea1c",
        },
        {
          version: "pricing-engine-002",
          checksum:
            "569a4a909b16ed20aba661598a9e9122c4ef360b649ed190db35f723ce6e7186",
        },
        {
          version: "pricing-engine-003",
          checksum:
            "8d33e4a393572fdf69a99c490ca9c8a7a796726a3260b47169b73c9d32af2d33",
        },
        {
          version: "pricing-engine-004",
          checksum:
            "0d8faeedf64f9464abfebe97688762e3ef315cf427a7e7fe61435fb5b708622a",
        },
        {
          version: "pricing-engine-005",
          checksum:
            "5092dbe401f9abd1cf427f992cd8390d09532a6aa7d2316f1262465824110c1f",
        },
      ];
      expect(
        PRICING_MIGRATIONS.slice(0, 5).map(({ version, checksum }) => ({
          version,
          checksum,
        })),
      ).toEqual(frozen);
      const runner = dataSource.createQueryRunner();
      try {
        for (const step of PRICING_MIGRATIONS.slice(0, 5)) {
          for (const definition of step.definitions)
            await runner.createTable(
              new Table(structuredClone(definition)),
              false,
              true,
              true,
            );
          await runner.manager
            .createQueryBuilder()
            .insert()
            .into("pricing_schema_versions")
            .values({
              id: step.version,
              checksum: step.checksum,
              applied_at: "2026-09-25T00:00:00.000Z",
            })
            .execute();
        }
        await runner.manager
          .createQueryBuilder()
          .insert()
          .into("pricing_catalog_head")
          .values({ id: "active", catalog_revision_id: null, revision: 0 })
          .execute();
      } finally {
        await runner.release();
      }
      expect((await planPricingSchema(dataSource)).create_tables).toEqual(
        PRICING_MIGRATIONS.slice(5).flatMap((step) =>
          step.definitions.map((entry) => entry.name),
        ),
      );
      await applyPricingSchema(dataSource);
      const rows = await dataSource.query(
        "SELECT * FROM pricing_schema_versions ORDER BY id",
      );
      expect(
        rows
          .slice(0, 5)
          .map((row: { id: string; checksum: string }) => ({
            version: row.id,
            checksum: row.checksum,
          })),
      ).toEqual(frozen);
      expect(rows).toHaveLength(PRICING_MIGRATIONS.length);
      expect((await planPricingSchema(dataSource)).state).toBe("applied");
    });

    it("preserves all six frozen migrations when adding audited resolution and physical manifests", async () => {
      const frozen = [
        {
          version: "pricing-engine-001",
          checksum:
            "cd7183321583fe8ec4e6878174e6c44e6e51f13889e7ef656d43af1884b7ea1c",
        },
        {
          version: "pricing-engine-002",
          checksum:
            "569a4a909b16ed20aba661598a9e9122c4ef360b649ed190db35f723ce6e7186",
        },
        {
          version: "pricing-engine-003",
          checksum:
            "8d33e4a393572fdf69a99c490ca9c8a7a796726a3260b47169b73c9d32af2d33",
        },
        {
          version: "pricing-engine-004",
          checksum:
            "0d8faeedf64f9464abfebe97688762e3ef315cf427a7e7fe61435fb5b708622a",
        },
        {
          version: "pricing-engine-005",
          checksum:
            "5092dbe401f9abd1cf427f992cd8390d09532a6aa7d2316f1262465824110c1f",
        },
        {
          version: "pricing-engine-006",
          checksum:
            "8e9028ae68abe8ecc7d9903f8a20f122f8ad793f81e16457abad9060d7a7ab3e",
        },
      ];
      expect(
        PRICING_MIGRATIONS.slice(0, 6).map(({ version, checksum }) => ({
          version,
          checksum,
        })),
      ).toEqual(frozen);
      const runner = dataSource.createQueryRunner();
      try {
        for (const step of PRICING_MIGRATIONS.slice(0, 6)) {
          for (const definition of step.definitions)
            await runner.createTable(
              new Table(structuredClone(definition)),
              false,
              true,
              true,
            );
          await runner.manager
            .createQueryBuilder()
            .insert()
            .into("pricing_schema_versions")
            .values({
              id: step.version,
              checksum: step.checksum,
              applied_at: "2026-09-25T00:00:00.000Z",
            })
            .execute();
        }
        await runner.manager
          .createQueryBuilder()
          .insert()
          .into("pricing_catalog_head")
          .values({ id: "active", catalog_revision_id: null, revision: 0 })
          .execute();
      } finally {
        await runner.release();
      }
      expect((await planPricingSchema(dataSource)).create_tables).toEqual(
        PRICING_MIGRATIONS.slice(6).flatMap((step) =>
          step.definitions.map((table) => table.name),
        ),
      );
      await applyPricingSchema(dataSource);
      const markers = await dataSource.query(
        "SELECT id, checksum FROM pricing_schema_versions ORDER BY id",
      );
      expect(
        markers
          .slice(0, 6)
          .map((row: { id: string; checksum: string }) => ({
            version: row.id,
            checksum: row.checksum,
          })),
      ).toEqual(frozen);
    });

    it("adds durable runtime evidence to 007 without changing seven historical checksums", async () => {
      const frozen = [
        {
          version: "pricing-engine-001",
          checksum:
            "cd7183321583fe8ec4e6878174e6c44e6e51f13889e7ef656d43af1884b7ea1c",
        },
        {
          version: "pricing-engine-002",
          checksum:
            "569a4a909b16ed20aba661598a9e9122c4ef360b649ed190db35f723ce6e7186",
        },
        {
          version: "pricing-engine-003",
          checksum:
            "8d33e4a393572fdf69a99c490ca9c8a7a796726a3260b47169b73c9d32af2d33",
        },
        {
          version: "pricing-engine-004",
          checksum:
            "0d8faeedf64f9464abfebe97688762e3ef315cf427a7e7fe61435fb5b708622a",
        },
        {
          version: "pricing-engine-005",
          checksum:
            "5092dbe401f9abd1cf427f992cd8390d09532a6aa7d2316f1262465824110c1f",
        },
        {
          version: "pricing-engine-006",
          checksum:
            "8e9028ae68abe8ecc7d9903f8a20f122f8ad793f81e16457abad9060d7a7ab3e",
        },
        {
          version: "pricing-engine-007",
          checksum:
            "126cf2a7259d0252ee7fce5eadf97ffdf8d653a28677d9cbc8043c0ed45a5828",
        },
      ];
      expect(
        PRICING_MIGRATIONS.slice(0, 7).map(({ version, checksum }) => ({
          version,
          checksum,
        })),
      ).toEqual(frozen);
      const runner = dataSource.createQueryRunner();
      try {
        for (const step of PRICING_MIGRATIONS.slice(0, 7)) {
          for (const definition of step.definitions)
            await runner.createTable(
              new Table(structuredClone(definition)),
              false,
              true,
              true,
            );
          await runner.manager
            .createQueryBuilder()
            .insert()
            .into("pricing_schema_versions")
            .values({
              id: step.version,
              checksum: step.checksum,
              applied_at: "2026-09-25T00:00:00.000Z",
            })
            .execute();
        }
        await runner.manager
          .createQueryBuilder()
          .insert()
          .into("pricing_catalog_head")
          .values({ id: "active", catalog_revision_id: null, revision: 0 })
          .execute();
      } finally {
        await runner.release();
      }
      const before = await dataSource.query(
        "SELECT * FROM pricing_schema_versions ORDER BY id",
      );
      expect((await planPricingSchema(dataSource)).create_tables).toEqual(
        PRICING_MIGRATIONS.slice(7).flatMap((step) =>
          step.definitions.map((table) => table.name),
        ),
      );
      await applyPricingSchema(dataSource);
      expect(
        (
          await dataSource.query(
            "SELECT * FROM pricing_schema_versions ORDER BY id",
          )
        ).slice(0, 7),
      ).toEqual(before);
      expect((await planPricingSchema(dataSource)).state).toBe("applied");
    });
    it("adds disposition 009 without changing eight historical migration markers", async () => {
      const frozen = [
        {
          version: "pricing-engine-001",
          checksum:
            "cd7183321583fe8ec4e6878174e6c44e6e51f13889e7ef656d43af1884b7ea1c",
        },
        {
          version: "pricing-engine-002",
          checksum:
            "569a4a909b16ed20aba661598a9e9122c4ef360b649ed190db35f723ce6e7186",
        },
        {
          version: "pricing-engine-003",
          checksum:
            "8d33e4a393572fdf69a99c490ca9c8a7a796726a3260b47169b73c9d32af2d33",
        },
        {
          version: "pricing-engine-004",
          checksum:
            "0d8faeedf64f9464abfebe97688762e3ef315cf427a7e7fe61435fb5b708622a",
        },
        {
          version: "pricing-engine-005",
          checksum:
            "5092dbe401f9abd1cf427f992cd8390d09532a6aa7d2316f1262465824110c1f",
        },
        {
          version: "pricing-engine-006",
          checksum:
            "8e9028ae68abe8ecc7d9903f8a20f122f8ad793f81e16457abad9060d7a7ab3e",
        },
        {
          version: "pricing-engine-007",
          checksum:
            "126cf2a7259d0252ee7fce5eadf97ffdf8d653a28677d9cbc8043c0ed45a5828",
        },
        {
          version: "pricing-engine-008",
          checksum:
            "d1853db0e7c88b824d7def263966ae26b93f9ac7ea9bd85535da8e819d864ef0",
        },
      ];
      expect(
        PRICING_MIGRATIONS.slice(0, 8).map(({ version, checksum }) => ({
          version,
          checksum,
        })),
      ).toEqual(frozen);
      const runner = dataSource.createQueryRunner();
      try {
        for (const step of PRICING_MIGRATIONS.slice(0, 8)) {
          for (const definition of step.definitions)
            await runner.createTable(
              new Table(structuredClone(definition)),
              false,
              true,
              true,
            );
          await runner.manager
            .createQueryBuilder()
            .insert()
            .into("pricing_schema_versions")
            .values({
              id: step.version,
              checksum: step.checksum,
              applied_at: "2026-09-25T00:00:00.000Z",
            })
            .execute();
        }
        await runner.manager
          .createQueryBuilder()
          .insert()
          .into("pricing_catalog_head")
          .values({ id: "active", catalog_revision_id: null, revision: 0 })
          .execute();
      } finally {
        await runner.release();
      }
      const before = await dataSource.query(
        "SELECT * FROM pricing_schema_versions ORDER BY id",
      );
      expect((await planPricingSchema(dataSource)).create_tables).toEqual(
        PRICING_MIGRATIONS.slice(8).flatMap((step) =>
          step.definitions.map((table) => table.name),
        ),
      );
      await applyPricingSchema(dataSource);
      expect(
        (
          await dataSource.query(
            "SELECT * FROM pricing_schema_versions ORDER BY id",
          )
        ).slice(0, 8),
      ).toEqual(before);
      expect((await planPricingSchema(dataSource)).state).toBe("applied");
    });
    it("adds complete-group custody to009 while preserving every prior marker", async () => {
      expect(PRICING_MIGRATIONS[8].checksum).toBe(
        "8aa568e9c08ae87a291cd11a59d15443c4390d082b9b2cc09ad02e5338e9a712",
      );
      const runner = dataSource.createQueryRunner();
      try {
        for (const step of PRICING_MIGRATIONS.slice(0, 9)) {
          for (const definition of step.definitions)
            await runner.createTable(
              new Table(structuredClone(definition)),
              false,
              true,
              true,
            );
          await runner.manager
            .createQueryBuilder()
            .insert()
            .into("pricing_schema_versions")
            .values({
              id: step.version,
              checksum: step.checksum,
              applied_at: "2026-09-25T00:00:00.000Z",
            })
            .execute();
        }
        await runner.manager
          .createQueryBuilder()
          .insert()
          .into("pricing_catalog_head")
          .values({ id: "active", catalog_revision_id: null, revision: 0 })
          .execute();
      } finally {
        await runner.release();
      }
      const before = await dataSource.query(
        "SELECT * FROM pricing_schema_versions ORDER BY id",
      );
      expect((await planPricingSchema(dataSource)).create_tables).toEqual(
        PRICING_MIGRATIONS.slice(9).flatMap((step) =>
          step.definitions.map((table) => table.name),
        ),
      );
      await applyPricingSchema(dataSource);
      expect(
        (
          await dataSource.query(
            "SELECT * FROM pricing_schema_versions ORDER BY id",
          )
        ).slice(0, 9),
      ).toEqual(before);
      expect((await planPricingSchema(dataSource)).state).toBe("applied");
    });
    it("adds011 dispositions without changing the ten frozen migration markers", async () => {
      expect(PRICING_MIGRATIONS[9].checksum).toBe(
        "01402546fad2f52fd5227cc799dd667f43562ed62b50d6c9ad84ee291bd871ce",
      );
      const runner = dataSource.createQueryRunner();
      try {
        for (const step of PRICING_MIGRATIONS.slice(0, 10)) {
          for (const definition of step.definitions)
            await runner.createTable(
              new Table(structuredClone(definition)),
              false,
              true,
              true,
            );
          await runner.manager
            .createQueryBuilder()
            .insert()
            .into("pricing_schema_versions")
            .values({
              id: step.version,
              checksum: step.checksum,
              applied_at: "2026-09-25T00:00:00.000Z",
            })
            .execute();
        }
        await runner.manager
          .createQueryBuilder()
          .insert()
          .into("pricing_catalog_head")
          .values({ id: "active", catalog_revision_id: null, revision: 0 })
          .execute();
      } finally {
        await runner.release();
      }
      const before = await dataSource.query(
        "SELECT * FROM pricing_schema_versions ORDER BY id",
      );
      expect((await planPricingSchema(dataSource)).create_tables).toEqual(
        PRICING_MIGRATIONS.slice(10).flatMap((step) =>
          step.definitions.map((table) => table.name),
        ),
      );
      await applyPricingSchema(dataSource);
      expect(
        (
          await dataSource.query(
            "SELECT * FROM pricing_schema_versions ORDER BY id",
          )
        ).slice(0, 10),
      ).toEqual(before);
    });
    it("adds012 parent lineage without changing eleven frozen markers", async () => {
      expect(PRICING_MIGRATIONS[10].checksum).toBe(
        "011ece9482b2598c000a0b0fae526c7795de98090d38f422abc8c7c90a98c0b9",
      );
      const runner = dataSource.createQueryRunner();
      try {
        for (const step of PRICING_MIGRATIONS.slice(0, 11)) {
          for (const definition of step.definitions)
            await runner.createTable(
              new Table(structuredClone(definition)),
              false,
              true,
              true,
            );
          await runner.manager
            .createQueryBuilder()
            .insert()
            .into("pricing_schema_versions")
            .values({
              id: step.version,
              checksum: step.checksum,
              applied_at: "2026-09-25T00:00:00.000Z",
            })
            .execute();
        }
        await runner.manager
          .createQueryBuilder()
          .insert()
          .into("pricing_catalog_head")
          .values({ id: "active", catalog_revision_id: null, revision: 0 })
          .execute();
      } finally {
        await runner.release();
      }
      const before = await dataSource.query(
        "SELECT * FROM pricing_schema_versions ORDER BY id",
      );
      expect((await planPricingSchema(dataSource)).create_tables).toEqual(
        PRICING_MIGRATIONS.slice(11).flatMap((step) =>
          step.definitions.map((table) => table.name),
        ),
      );
      await applyPricingSchema(dataSource);
      expect(
        (
          await dataSource.query(
            "SELECT * FROM pricing_schema_versions ORDER BY id",
          )
        ).slice(0, 11),
      ).toEqual(before);
    });
    it("rejects a missing012 lineage table with its surviving marker", async () => {
      await applyPricingSchema(dataSource);
      const runner = dataSource.createQueryRunner();
      try {
        await runner.dropTable("pricing_version_inheritance");
      } finally {
        await runner.release();
      }
      expect((await planPricingSchema(dataSource)).state).toBe("conflict");
      await expect(applyPricingSchema(dataSource)).rejects.toThrow("conflict");
    });
    it("rejects a missing011 disposition table with its surviving marker", async () => {
      await applyPricingSchema(dataSource);
      const runner = dataSource.createQueryRunner();
      try {
        await runner.dropTable("pricing_runtime_group_dispositions");
      } finally {
        await runner.release();
      }
      expect((await planPricingSchema(dataSource)).state).toBe("conflict");
      await expect(applyPricingSchema(dataSource)).rejects.toThrow("conflict");
    });

    it("detects missing010 membership custody instead of repairing a surviving marker", async () => {
      await applyPricingSchema(dataSource);
      const runner = dataSource.createQueryRunner();
      try {
        await runner.dropTable("pricing_runtime_group_outcome_members");
      } finally {
        await runner.release();
      }
      expect((await planPricingSchema(dataSource)).state).toBe("conflict");
      await expect(applyPricingSchema(dataSource)).rejects.toThrow("conflict");
    });

    it("detects missing disposition 009 tables rather than repairing surviving markers", async () => {
      await applyPricingSchema(dataSource);
      const runner = dataSource.createQueryRunner();
      try {
        await runner.dropTable("pricing_runtime_outcome_dispositions");
      } finally {
        await runner.release();
      }
      expect((await planPricingSchema(dataSource)).issues).toContain(
        "Migration pricing-engine-009 has a marker but its tables are missing",
      );
      await expect(applyPricingSchema(dataSource)).rejects.toThrow("conflict");
    });

    it("rejects a missing 008 inbox and a wrongly ordered outcome index", async () => {
      await applyPricingSchema(dataSource);
      const runner = dataSource.createQueryRunner();
      try {
        await runner.dropIndex(
          "pricing_runtime_outcomes",
          "idx_pricing_runtime_outcome_inventory",
        );
        await runner.createIndex(
          "pricing_runtime_outcomes",
          new TableIndex({
            name: "idx_pricing_runtime_outcome_inventory",
            columnNames: ["state", "workspace_id", "created_at", "id"],
          }),
        );
        expect((await planPricingSchema(dataSource)).issues).toContain(
          "Missing index idx_pricing_runtime_outcome_inventory",
        );
        await runner.dropTable("pricing_runtime_outcome_dispositions");
        await runner.dropTable("pricing_runtime_outcomes");
      } finally {
        await runner.release();
      }
      expect((await planPricingSchema(dataSource)).issues).toContain(
        "Migration pricing-engine-008 has a marker but its tables are missing",
      );
      await expect(applyPricingSchema(dataSource)).rejects.toThrow("conflict");
    });

    it("upgrades a populated 001 catalog through all additive steps without changing its original checksum or data", async () => {
      const first = PRICING_MIGRATIONS[0];
      const runner = dataSource.createQueryRunner();
      try {
        for (const definition of first.definitions)
          await runner.createTable(
            new Table(structuredClone(definition)),
            false,
            true,
            true,
          );
        await runner.manager
          .createQueryBuilder()
          .insert()
          .into("pricing_schema_versions")
          .values({
            id: first.version,
            checksum: first.checksum,
            applied_at: "2026-09-25T00:00:00Z",
          })
          .execute();
        await runner.manager
          .createQueryBuilder()
          .insert()
          .into("pricing_catalog_head")
          .values({ id: "active", catalog_revision_id: null, revision: 0 })
          .execute();
        await runner.manager
          .createQueryBuilder()
          .insert()
          .into("pricing_books")
          .values({
            id: "preserved-book",
            workspace_id: "workspace-a",
            name: "Existing fixture",
            created_by: "fixture",
            created_at: "2026-09-25T00:00:00Z",
            updated_at: "2026-09-25T00:00:00Z",
          })
          .execute();
      } finally {
        await runner.release();
      }
      const before = await dataSource.query("SELECT * FROM pricing_books");
      expect((await planPricingSchema(dataSource)).create_tables).toEqual(
        PRICING_MIGRATIONS.slice(1).flatMap((step) =>
          step.definitions.map((table) => table.name),
        ),
      );
      expect((await applyPricingSchema(dataSource)).state).toBe("applied");
      expect(await dataSource.query("SELECT * FROM pricing_books")).toEqual(
        before,
      );
      const markers = await dataSource.query(
        "SELECT * FROM pricing_schema_versions ORDER BY id",
      );
      expect(markers).toHaveLength(PRICING_MIGRATIONS.length);
      expect(markers[0]).toEqual({
        id: first.version,
        checksum: first.checksum,
        applied_at: "2026-09-25T00:00:00Z",
      });
      expect((await applyPricingSchema(dataSource)).create_tables).toEqual([]);
      await expect(removeEmptyPricingSchema(dataSource)).rejects.toThrow(
        "nonempty",
      );
    });

    it("upgrades an existing 002 ledger without changing exact balances or the earlier checksums", async () => {
      const runner = dataSource.createQueryRunner();
      try {
        for (const step of PRICING_MIGRATIONS.slice(0, 2)) {
          for (const definition of step.definitions)
            await runner.createTable(
              new Table(structuredClone(definition)),
              false,
              true,
              true,
            );
          await runner.manager
            .createQueryBuilder()
            .insert()
            .into("pricing_schema_versions")
            .values({
              id: step.version,
              checksum: step.checksum,
              applied_at: "2026-09-25T00:00:00Z",
            })
            .execute();
        }
        await runner.manager
          .createQueryBuilder()
          .insert()
          .into("pricing_catalog_head")
          .values({ id: "active", catalog_revision_id: null, revision: 0 })
          .execute();
        await runner.manager
          .createQueryBuilder()
          .insert()
          .into("pricing_budget_balances")
          .values({
            rule_id: 1,
            period_start: "2026-09-25T00:00:00Z",
            workspace_id: "workspace-a",
            amount_decimal: "1000000.000000000000000001",
            legacy_projection: "1000000",
          })
          .execute();
      } finally {
        await runner.release();
      }
      const before = await dataSource.query(
        "SELECT * FROM pricing_budget_balances",
      );
      const markers = await dataSource.query(
        "SELECT * FROM pricing_schema_versions ORDER BY id",
      );
      expect((await planPricingSchema(dataSource)).create_tables).toEqual([
        "pricing_settlement_intents",
        "pricing_adjustment_applications",
        "pricing_media_submissions",
        "pricing_media_tasks",
        "pricing_media_observations",
        "pricing_recovery_cases",
        "pricing_recovery_decisions",
        "pricing_batch_manifests",
        "pricing_runtime_outcomes",
        "pricing_runtime_outcome_dispositions",
        "pricing_runtime_group_outcomes",
        "pricing_runtime_group_outcome_members",
        "pricing_runtime_group_dispositions",
        "pricing_draft_inheritance",
        "pricing_version_inheritance",
        "pricing_media_event_sources",
        "pricing_media_supplier_events",
        "pricing_media_event_heads",
        "pricing_media_job_reconciliations",
        "pricing_media_event_dispositions",
        "pricing_media_event_authorities",
        "pricing_actual_budget_cohorts",
        "pricing_book_management",
      ]);
      await applyPricingSchema(dataSource);
      expect(
        await dataSource.query("SELECT * FROM pricing_budget_balances"),
      ).toEqual(before);
      expect(
        (
          await dataSource.query(
            "SELECT * FROM pricing_schema_versions ORDER BY id",
          )
        ).slice(0, 2),
      ).toEqual(markers);
      expect((await planPricingSchema(dataSource)).state).toBe("applied");
    });

    it("MIG-TEST-03 can roll back an unused schema, but refuses to erase actual data", async () => {
      await applyPricingSchema(dataSource);
      await removeEmptyPricingSchema(dataSource);
      expect((await planPricingSchema(dataSource)).state).toBe("pending");
      await applyPricingSchema(dataSource);
      await dataSource
        .createQueryBuilder()
        .insert()
        .into("pricing_books")
        .values({
          id: "book-a",
          workspace_id: "workspace-a",
          name: "Synthetic",
          created_by: "test",
          created_at: "2026-09-25T00:00:00Z",
          updated_at: "2026-09-25T00:00:00Z",
        })
        .execute();
      await expect(removeEmptyPricingSchema(dataSource)).rejects.toThrow(
        "nonempty",
      );
      expect(
        await dataSource.query("SELECT * FROM pricing_books"),
      ).toHaveLength(1);
    });

    it("rejects an applied 006 marker whose orphan review table was lost", async () => {
      await applyPricingSchema(dataSource);
      const runner = dataSource.createQueryRunner();
      try {
        await runner.dropTable("pricing_recovery_cases");
      } finally {
        await runner.release();
      }
      expect((await planPricingSchema(dataSource)).issues).toContain(
        "Migration pricing-engine-006 has a marker but its tables are missing",
      );
      await expect(applyPricingSchema(dataSource)).rejects.toThrow("conflict");
    });

    it("rejects a surviving migration marker when its recovery table is missing", async () => {
      await applyPricingSchema(dataSource);
      const runner = dataSource.createQueryRunner();
      try {
        await runner.dropTable("pricing_settlement_intents");
      } finally {
        await runner.release();
      }
      const plan = await planPricingSchema(dataSource);
      expect(plan.state).toBe("conflict");
      expect(plan.issues).toContain(
        "Migration pricing-engine-003 has a marker but its tables are missing",
      );
      await expect(applyPricingSchema(dataSource)).rejects.toThrow("conflict");
    });

    it("detects a reordered workspace index instead of treating its column set as equivalent", async () => {
      await applyPricingSchema(dataSource);
      const runner = dataSource.createQueryRunner();
      try {
        await runner.dropIndex(
          "pricing_reservations",
          "idx_pricing_reservation_workspace_request",
        );
        await runner.createIndex(
          "pricing_reservations",
          new TableIndex({
            name: "idx_pricing_reservation_workspace_request",
            columnNames: ["request_id", "workspace_id"],
          }),
        );
      } finally {
        await runner.release();
      }
      expect((await planPricingSchema(dataSource)).issues).toContain(
        "Missing index idx_pricing_reservation_workspace_request",
      );
      await expect(applyPricingSchema(dataSource)).rejects.toThrow("conflict");
    });

    it("refuses a partial or tampered schema instead of silently synchronizing it", async () => {
      await dataSource.query(
        "CREATE TABLE pricing_books (id varchar PRIMARY KEY)",
      );
      expect((await planPricingSchema(dataSource)).state).toBe("conflict");
      await expect(applyPricingSchema(dataSource)).rejects.toThrow("conflict");
    });

    it("enforces the book relation, version identity and persisted snapshot catalog reference", async () => {
      await applyPricingSchema(dataSource);
      await expect(
        dataSource
          .createQueryBuilder()
          .insert()
          .into("pricing_drafts")
          .values({
            id: "orphan",
            book_id: "missing",
            revision: 1,
            content_json: "{}",
            created_by: "test",
            created_at: "2026-09-25T00:00:00Z",
            updated_at: "2026-09-25T00:00:00Z",
          })
          .execute(),
      ).rejects.toThrow();
      await expect(
        dataSource
          .createQueryBuilder()
          .insert()
          .into("pricing_request_snapshots")
          .values({
            request_id: "orphan-request",
            workspace_id: "workspace-a",
            catalog_revision_id: "missing",
            snapshot_hash: "test",
            descriptor_json: "{}",
            created_at: "2026-09-25T00:00:00Z",
          })
          .execute(),
      ).rejects.toThrow();
      await dataSource
        .createQueryBuilder()
        .insert()
        .into("pricing_books")
        .values({
          id: "book-a",
          workspace_id: "workspace-a",
          name: "Synthetic",
          created_by: "test",
          created_at: "2026-09-25T00:00:00Z",
          updated_at: "2026-09-25T00:00:00Z",
        })
        .execute();
      const version = {
        book_id: "book-a",
        version_id: "v1",
        content_hash: "synthetic",
        content_json: "{}",
        published_by: "test",
        published_at: "2026-09-25T00:00:00Z",
        reason: "fixture",
      };
      await dataSource
        .createQueryBuilder()
        .insert()
        .into("pricing_book_versions")
        .values(version)
        .execute();
      await expect(
        dataSource
          .createQueryBuilder()
          .insert()
          .into("pricing_book_versions")
          .values(version)
          .execute(),
      ).rejects.toThrow();
    });
  });
}

schemaContract("isolated SQLite pricing schema", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pricing-schema-"));
  const dataSource = new DataSource({
    type: "better-sqlite3",
    database: join(dir, "pricing.db"),
    entities: [],
    synchronize: false,
  });
  await dataSource.initialize();
  await dataSource.query("PRAGMA foreign_keys = ON");
  return {
    dataSource,
    cleanup: async () => rmSync(dir, { recursive: true, force: true }),
  };
});

const postgresUrl = process.env.SIFTGATE_PRICING_TEST_POSTGRES_URL;
if (postgresUrl) {
  const url = new URL(postgresUrl);
  if (
    url.hostname !== "127.0.0.1" ||
    !/^\/pricing_goal_[a-z0-9_]+$/.test(url.pathname)
  )
    throw new Error(
      "Pricing PostgreSQL tests require an explicit isolated loopback pricing_goal_* database",
    );
}
schemaContract(
  "isolated PostgreSQL pricing schema",
  async () => {
    if (!postgresUrl)
      throw new Error("Isolated PostgreSQL URL is not configured");
    const schema = `pricing_schema_${process.pid}_${Math.random().toString(16).slice(2)}`;
    const admin = new DataSource({
      type: "postgres",
      url: postgresUrl,
      synchronize: false,
    });
    await admin.initialize();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const dataSource = new DataSource({
      type: "postgres",
      url: postgresUrl,
      schema,
      extra: { options: `-c search_path=${schema}` },
      synchronize: false,
    });
    await dataSource.initialize();
    return {
      dataSource,
      cleanup: async () => {
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
        await admin.destroy();
      },
    };
  },
  postgresUrl ? describe : describe.skip,
);

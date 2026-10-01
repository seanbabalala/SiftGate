import { DataSource, InsertQueryBuilder, type ObjectLiteral } from "typeorm";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PricingRepository } from "../../src/pricing/pricing-repository";
import {
  applyPricingSchema,
  planPricingSchema,
  PRICING_MIGRATIONS,
} from "../../src/pricing/pricing-schema";
import type {
  PricingActor,
  PricingPublishOptions,
} from "../../src/pricing/pricing-repository.types";
import type { PricingInheritanceDefinition } from "../../src/pricing/pricing-inheritance.types";
import { rate, tokenBook, tokens } from "./pricing-fixtures";

const actor: PricingActor = {
  id: "admin",
  workspace_id: "tenant-a",
  role: "admin",
  global_admin: true,
};
const other: PricingActor = {
  ...actor,
  id: "other",
  workspace_id: "tenant-b",
  global_admin: false,
};
const publish = (revision: number, model = "child"): PricingPublishOptions => ({
  draft_revision: 1,
  catalog_revision: revision,
  targets: [{ level: "model", model }],
  reason: "Synthetic publication only",
  confirm: true,
});
type Fixture = { source: DataSource; cleanup(): Promise<void> };
function contract(
  name: string,
  connect: () => Promise<Fixture>,
  run = describe,
) {
  run(name, () => {
    let source: DataSource,
      cleanup: Fixture["cleanup"],
      repo: PricingRepository;
    const peers: DataSource[] = [];
    beforeEach(async () => {
      ({ source, cleanup } = await connect());
      await applyPricingSchema(source);
      repo = new PricingRepository(source);
    });
    afterEach(async () => {
      jest.restoreAllMocks();
      for (const peer of peers.splice(0))
        if (peer.isInitialized) await peer.destroy();
      if (source?.isInitialized) await source.destroy();
      await cleanup?.();
    });
    async function peer() {
      if (source.options.type !== "postgres")
        return new PricingRepository(source);
      const db = await new DataSource({
        ...source.options,
        synchronize: false,
      }).initialize();
      peers.push(db);
      return new PricingRepository(db);
    }
    async function seed(scope: "workspace" | "global" = "workspace") {
      const parent = await repo.createBook(actor, {
        name: "Synthetic parent",
        scope,
        content: tokenBook(),
      });
      const version = await repo.publishDraft(
        actor,
        parent.draft.id,
        publish(0, "parent"),
      );
      const definition: PricingInheritanceDefinition = {
        schema_version: 1,
        parent: {
          book_id: parent.book.id,
          version_id: version.version_id,
          content_hash: version.content_hash,
        },
        inherit: "all",
        source: { kind: "manual" },
        rate_overrides: [rate("input", "uncached_input_tokens", "2")],
        removed_component_ids: [],
        replaced_groups: [],
        added_groups: [],
        removed_group_ids: [],
        settings: {},
        calendar: { mode: "inherit" },
      };
      return { parent, version, definition };
    }
    async function create(
      definition: PricingInheritanceDefinition,
      owner = actor,
      scope: "workspace" | "global" = "workspace",
    ) {
      return repo.createInheritedBook(owner, {
        name: "Synthetic child",
        scope,
        definition,
      });
    }
    async function dump() {
      const rows: Record<string, unknown> = {};
      for (const table of [
        "pricing_books",
        "pricing_drafts",
        "pricing_book_versions",
        "pricing_draft_inheritance",
        "pricing_version_inheritance",
        "pricing_catalog_revisions",
        "pricing_catalog_head",
        "pricing_request_snapshots",
        "pricing_audit_events",
      ])
        rows[table] = await source.query(`SELECT * FROM ${table}`);
      return rows;
    }
    function failInsert(table: string) {
      const execute = InsertQueryBuilder.prototype.execute;
      return jest
        .spyOn(InsertQueryBuilder.prototype, "execute")
        .mockImplementation(function (this: InsertQueryBuilder<ObjectLiteral>) {
          if (this.expressionMap.mainAlias?.tablePath?.endsWith(table))
            return Promise.reject(
              new Error("synthetic required inheritance write failure"),
            );
          return execute.call(this);
        });
    }

    it("previews without writes and persists an explicit complete draft recipe with provenance", async () => {
      const { definition } = await seed(),
        before = await dump();
      const preview = await repo.previewInheritance(actor, {
        scope: "workspace",
        definition,
      });
      expect(await dump()).toEqual(before);
      expect(
        preview.inheritance.provenance.components.find(
          (c) => c.component_id === "input",
        )?.origin,
      ).toBe("override");
      const child = await create(definition);
      expect(child.draft.inheritance?.definition).toEqual(definition);
      expect(child.draft.content).toEqual(preview.content);
      expect((await repo.getDraft(actor, child.draft.id)).inheritance).toEqual(
        child.draft.inheritance,
      );
      expect(
        (await repo.getBook(actor, child.book.id)).drafts[0].inheritance,
      ).toEqual(child.draft.inheritance);
      expect((await repo.listBindings(actor)).head.revision).toBe(1);
    });
    it("freezes inherited prices for publication and in-flight requests despite newer parent prices", async () => {
      const { parent, version, definition } = await seed(),
        child = await create(definition);
      const nextParent = await repo.forkDraft(
          actor,
          parent.book.id,
          version.version_id,
        ),
        changed = tokenBook();
      changed.groups[0].rules[0].rates[2].component.amount = "20";
      await repo.updateDraft(actor, nextParent.id, 1, changed);
      await repo.publishDraft(actor, nextParent.id, {
        ...publish(1, "parent"),
        draft_revision: 2,
      });
      const before = await dump(),
        preview = await repo.previewPublish(actor, child.draft.id, publish(2));
      expect(await dump()).toEqual(before);
      const published = await repo.publishDraft(
        actor,
        child.draft.id,
        publish(2),
      );
      expect(published.inheritance).toEqual(preview.inheritance);
      const frozen = (await repo.capture({
        request_id: "inflight",
        workspace_id: actor.workspace_id,
        report_currency: "USD",
      }))!;
      const usage = tokens({
        input_tokens: 1000,
        cache_read_input_tokens: 200,
        output_tokens: 100,
      });
      expect(frozen.quote({ model: "child" }, usage).cost.report_amount).toBe(
        "0.001820000",
      );
      const fork = await repo.forkDraft(
        actor,
        child.book.id,
        published.version_id,
      );
      const changedRecipe = structuredClone(definition);
      changedRecipe.rate_overrides[0].amount = "4";
      await repo.updateInheritedDraft(actor, fork.id, 1, changedRecipe);
      await repo.publishDraft(actor, fork.id, {
        ...publish(3),
        draft_revision: 2,
      });
      const restored = await new PricingRepository(source).restoreRequest(
        "inflight",
        actor.workspace_id,
      );
      expect(restored.quote({ model: "child" }, usage)).toEqual(
        frozen.quote({ model: "child" }, usage),
      );
      expect(
        (await repo.getVersion(actor, child.book.id, published.version_id))
          .inheritance?.definition.parent,
      ).toEqual(definition.parent);
    });
    it("preserves inherited recipes through fork, rollback and subsequent normal read-only quotes", async () => {
      const { definition } = await seed(),
        child = await create(definition),
        first = await repo.publishDraft(actor, child.draft.id, publish(1));
      const fork = await repo.forkDraft(actor, child.book.id, first.version_id);
      expect(fork.inheritance?.definition).toEqual(definition);
      const next = {
        ...definition,
        rate_overrides: [rate("input", "uncached_input_tokens", "4")],
      };
      await repo.updateInheritedDraft(actor, fork.id, 1, next);
      await repo.publishDraft(actor, fork.id, {
        ...publish(2),
        draft_revision: 2,
      });
      const before = await dump(),
        preview = await repo.previewRollback(
          actor,
          child.book.id,
          first.version_id,
          publish(3),
        );
      expect(await dump()).toEqual(before);
      const rolled = await repo.rollback(
        actor,
        child.book.id,
        first.version_id,
        publish(3),
      );
      expect(rolled.inheritance).toEqual(preview.inheritance);
      expect(
        (await repo.getVersion(actor, child.book.id, rolled.version_id))
          .inheritance?.definition,
      ).toEqual(definition);
    });
    it("refuses silent flattening, stale recipe updates and client-derived prices", async () => {
      const { definition } = await seed(),
        child = await create(definition),
        before = await dump();
      await expect(
        repo.updateDraft(actor, child.draft.id, 1, tokenBook()),
      ).rejects.toMatchObject({ status: 409 });
      await expect(
        repo.updateInheritedDraft(actor, child.draft.id, 2, definition),
      ).rejects.toMatchObject({ status: 409 });
      await expect(
        repo.updateInheritedDraft(actor, child.draft.id, 1, {
          ...definition,
          content: tokenBook(),
        }),
      ).rejects.toThrow();
      expect(await dump()).toEqual(before);
    });
    it("allows an explicit recipe attachment to a manual draft without publishing", async () => {
      const { definition } = await seed(),
        manual = await repo.createBook(actor, {
          name: "Attach",
          scope: "workspace",
          content: tokenBook(),
        });
      const attached = await repo.updateInheritedDraft(
        actor,
        manual.draft.id,
        1,
        definition,
      );
      expect(attached.revision).toBe(2);
      expect(attached.inheritance?.definition).toEqual(definition);
      expect((await repo.listBindings(actor)).head.revision).toBe(1);
    });
    it("prevents cross-tenant and global-to-private parents, while permitting approved global inheritance", async () => {
      const { definition } = await seed();
      const before = await dump();
      await expect(create(definition, other)).rejects.toMatchObject({
        status: 404,
      });
      await expect(create(definition, actor, "global")).rejects.toMatchObject({
        status: 404,
      });
      await expect(
        repo.previewInheritance(other, { scope: "workspace", definition }),
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        create(definition, { ...actor, role: "operator" }),
      ).rejects.toMatchObject({ status: 403 });
      expect(await dump()).toEqual(before);
      const global = await repo.createBook(actor, {
          name: "Global",
          scope: "global",
          content: tokenBook(),
        }),
        v = await repo.publishDraft(
          actor,
          global.draft.id,
          publish(1, "global"),
        );
      const child = await create(
        {
          ...definition,
          parent: {
            book_id: global.book.id,
            version_id: v.version_id,
            content_hash: v.content_hash,
          },
        },
        other,
      );
      expect(child.book.workspace_id).toBe(other.workspace_id);
      expect(child.draft.inheritance?.ancestors).toHaveLength(1);
    });
    it("enforces independent-connection CAS for concurrent inherited draft edits", async () => {
      const { definition } = await seed(),
        child = await create(definition),
        second = await peer();
      const results = await Promise.allSettled([
        repo.updateInheritedDraft(actor, child.draft.id, 1, definition),
        second.updateInheritedDraft(actor, child.draft.id, 1, {
          ...definition,
          rate_overrides: [rate("input", "uncached_input_tokens", "3")],
        }),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect((await repo.getDraft(actor, child.draft.id)).revision).toBe(2);
      expect(
        await source.query("SELECT * FROM pricing_draft_inheritance"),
      ).toHaveLength(1);
    });
    it.each(["pricing_draft_inheritance", "pricing_audit_events"])(
      "rolls creation back on required%s failure",
      async (table) => {
        const { definition } = await seed(),
          before = await dump(),
          fault = failInsert(table);
        await expect(create(definition)).rejects.toThrow(
          "synthetic required inheritance write failure",
        );
        fault.mockRestore();
        expect(await dump()).toEqual(before);
      },
    );
    it.each(["pricing_version_inheritance", "pricing_audit_events"])(
      "rolls publication and draft deletion back on required%s failure",
      async (table) => {
        const { definition } = await seed(),
          child = await create(definition),
          before = await dump(),
          fault = failInsert(table);
        await expect(
          repo.publishDraft(actor, child.draft.id, publish(1)),
        ).rejects.toThrow("synthetic required inheritance write failure");
        fault.mockRestore();
        expect(await dump()).toEqual(before);
        expect(
          (await repo.getDraft(actor, child.draft.id)).inheritance,
        ).toBeDefined();
      },
    );
    it("rejects lost draft recipes instead of silently treating them as manual prices", async () => {
      const { definition } = await seed(),
        child = await create(definition);
      await source
        .createQueryBuilder()
        .delete()
        .from("pricing_draft_inheritance")
        .where("draft_id = :id", { id: child.draft.id })
        .execute();
      await expect(repo.getDraft(actor, child.draft.id)).rejects.toMatchObject({
        status: 409,
      });
      await expect(
        repo.updateDraft(actor, child.draft.id, 1, tokenBook()),
      ).rejects.toMatchObject({ status: 409 });
      await expect(
        repo.publishDraft(actor, child.draft.id, publish(1)),
      ).rejects.toMatchObject({ status: 409 });
    });
    it("rejects a lost published lineage in source reads and cold request restoration", async () => {
      const { definition } = await seed(),
        child = await create(definition),
        v = await repo.publishDraft(actor, child.draft.id, publish(1));
      await repo.capture({
        request_id: "restore",
        workspace_id: actor.workspace_id,
        report_currency: "USD",
      });
      await source
        .createQueryBuilder()
        .delete()
        .from("pricing_version_inheritance")
        .where("book_id = :book", { book: child.book.id })
        .execute();
      await expect(
        repo.getVersion(actor, child.book.id, v.version_id),
      ).rejects.toMatchObject({ status: 409 });
      await expect(
        new PricingRepository(source).restoreRequest(
          "restore",
          actor.workspace_id,
        ),
      ).rejects.toMatchObject({ status: 409 });
    });
    it("keeps restrictive parent and mandatory audit references after publication", async () => {
      const { definition } = await seed(),
        child = await create(definition);
      await repo.publishDraft(actor, child.draft.id, publish(1));
      await expect(
        source
          .createQueryBuilder()
          .delete()
          .from("pricing_book_versions")
          .where("book_id = :book AND version_id = :version", {
            book: definition.parent.book_id,
            version: definition.parent.version_id,
          })
          .execute(),
      ).rejects.toThrow();
      const rows = await source.query(
        "SELECT audit_id FROM pricing_version_inheritance",
      );
      await expect(
        source
          .createQueryBuilder()
          .delete()
          .from("pricing_audit_events")
          .where("id = :id", { id: rows[0].audit_id })
          .execute(),
      ).rejects.toThrow();
    });
    it("detects changed materialized content and recipe/audit hashes without trusting metadata", async () => {
      const { definition } = await seed(),
        child = await create(definition);
      const changed = structuredClone(child.draft.content);
      changed.groups[0].rules[0].rates[0].component.amount = "777";
      await source
        .createQueryBuilder()
        .update("pricing_drafts")
        .set({ content_json: JSON.stringify(changed) })
        .where("id = :id", { id: child.draft.id })
        .execute();
      await expect(
        repo.previewPublish(actor, child.draft.id, publish(1)),
      ).rejects.toMatchObject({ status: 409 });
      await source
        .createQueryBuilder()
        .update("pricing_drafts")
        .set({ content_json: JSON.stringify(child.draft.content) })
        .where("id = :id", { id: child.draft.id })
        .execute();
      await source
        .createQueryBuilder()
        .update("pricing_draft_inheritance")
        .set({ record_hash: "0".repeat(64) })
        .where("draft_id = :id", { id: child.draft.id })
        .execute();
      await expect(repo.getDraft(actor, child.draft.id)).rejects.toMatchObject({
        status: 409,
      });
    });
    it("keeps a verifiable ancestor chain through multiple materialized parents", async () => {
      const { definition } = await seed(),
        first = await create(definition),
        v1 = await repo.publishDraft(actor, first.draft.id, publish(1));
      const next = {
        ...definition,
        parent: {
          book_id: first.book.id,
          version_id: v1.version_id,
          content_hash: v1.content_hash,
        },
        rate_overrides: [],
      };
      const grandchild = await create(next),
        v2 = await repo.publishDraft(
          actor,
          grandchild.draft.id,
          publish(2, "grandchild"),
        );
      const got = await repo.getVersion(
        actor,
        grandchild.book.id,
        v2.version_id,
      );
      expect(got.inheritance?.ancestors).toHaveLength(2);
      expect(got.inheritance?.ancestors[0].lineage_hash).toBe(
        first.draft.inheritance?.lineage_hash,
      );
      expect(got.inheritance?.ancestors[1]).toMatchObject(definition.parent);
    });
    it("bounds ancestry before creating an over-depth draft", async () => {
      const { definition } = await seed();
      let recipe = definition;
      for (let i = 1; i <= 16; i++) {
        const child = await create(recipe),
          v = await repo.publishDraft(
            actor,
            child.draft.id,
            publish(i, `depth-${i}`),
          );
        recipe = {
          ...definition,
          parent: {
            book_id: child.book.id,
            version_id: v.version_id,
            content_hash: v.content_hash,
          },
          rate_overrides: [],
        };
      }
      const before = await dump();
      await expect(create(recipe)).rejects.toMatchObject({ status: 409 });
      expect(await dump()).toEqual(before);
    }, 60000);

    it("upgrades populated011 without rewriting its published prices, catalog or audits", async () => {
      const { parent } = await seed();
      await repo.capture({
        request_id: "old-request",
        workspace_id: actor.workspace_id,
        report_currency: "USD",
      });
      const before = await dump(),
        markers = await source.query(
          "SELECT * FROM pricing_schema_versions ORDER BY id",
        );
      const runner = source.createQueryRunner();
      try {
        // Recreate an actual011 database, not a newer marker with missing012 tables.
        for (const step of [...PRICING_MIGRATIONS.slice(11)].reverse()) {
          for (const index of [...(step.indexes ?? [])].reverse()) await runner.dropIndex(index.table, index.definition.name!);
          for (const definition of [...step.definitions].reverse()) await runner.dropTable(definition.name);
          await runner.manager.createQueryBuilder().delete().from("pricing_schema_versions").where("id = :id", { id: step.version }).execute();
        }
      } finally {
        await runner.release();
      }
      expect((await planPricingSchema(source)).create_tables).toEqual(PRICING_MIGRATIONS.slice(11).flatMap(step => step.definitions.map(table => table.name)));
      await applyPricingSchema(source);
      expect(await dump()).toEqual(before);
      expect(
        (
          await source.query(
            "SELECT * FROM pricing_schema_versions ORDER BY id",
          )
        ).slice(0, 11),
      ).toEqual(markers.slice(0, 11));
      expect(PRICING_MIGRATIONS[10].checksum).toBe(
        "011ece9482b2598c000a0b0fae526c7795de98090d38f422abc8c7c90a98c0b9",
      );
      expect(
        (await new PricingRepository(source).getBook(actor, parent.book.id))
          .versions,
      ).toHaveLength(1);
    });

    it("rolls the recipe, materialized draft and required audit back together on update failure", async () => {
      const { definition } = await seed(),
        child = await create(definition),
        before = await dump(),
        fault = failInsert("pricing_draft_inheritance");
      await expect(
        repo.updateInheritedDraft(actor, child.draft.id, 1, {
          ...definition,
          rate_overrides: [rate("input", "uncached_input_tokens", "8")],
        }),
      ).rejects.toThrow("synthetic required inheritance write failure");
      fault.mockRestore();
      expect(await dump()).toEqual(before);
    });

    it("rejects tampered parent contents before draft preview/publication without writes", async () => {
      const { definition, parent, version } = await seed(),
        child = await create(definition);
      const content = structuredClone(parent.draft.content);
      content.groups[0].rules[0].rates[1].component.amount = "200";
      await source
        .createQueryBuilder()
        .update("pricing_book_versions")
        .set({ content_json: JSON.stringify(content) })
        .where("book_id = :book AND version_id = :version", {
          book: parent.book.id,
          version: version.version_id,
        })
        .execute();
      const before = await dump();
      await expect(
        repo.previewPublish(actor, child.draft.id, publish(1)),
      ).rejects.toMatchObject({ status: 409 });
      await expect(
        repo.publishDraft(actor, child.draft.id, publish(1)),
      ).rejects.toMatchObject({ status: 409 });
      expect(await dump()).toEqual(before);
    });
  });
}
contract("SQLite WAL inherited pricing repository", async () => {
  const dir = mkdtempSync(join(tmpdir(), "inheritance-repository-")),
    source = await new DataSource({
      type: "better-sqlite3",
      database: join(dir, "test.db"),
      synchronize: false,
    }).initialize();
  await source.query("PRAGMA journal_mode=WAL");
  return {
    source,
    cleanup: async () => rmSync(dir, { recursive: true, force: true }),
  };
});
const pgUrl = process.env.SIFTGATE_PRICING_TEST_POSTGRES_URL;
if (
  pgUrl &&
  (new URL(pgUrl).hostname !== "127.0.0.1" ||
    !/^\/pricing_goal_[a-z0-9_]+$/.test(new URL(pgUrl).pathname))
)
  throw Error("Use an isolated loopback pricing_goal database");
contract(
  "PostgreSQL inherited pricing repository",
  async () => {
    if (!pgUrl) throw Error("Missing isolated PostgreSQL URL");
    const schema = `inheritance_${process.pid}_${Math.random().toString(16).slice(2)}`,
      admin = await new DataSource({
        type: "postgres",
        url: pgUrl,
        synchronize: false,
      }).initialize();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    let source: DataSource | undefined;
    try {
      source = await new DataSource({
        type: "postgres",
        url: pgUrl,
        schema,
        extra: { options: `-c search_path=${schema},public`, max: 6 },
        synchronize: false,
      }).initialize();
      return {
        source,
        cleanup: async () => {
          try {
            await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
          } finally {
            await admin.destroy();
          }
        },
      };
    } catch (error) {
      if (source?.isInitialized) await source.destroy();
      try {
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      } finally {
        await admin.destroy();
      }
      throw error;
    }
  },
  pgUrl ? describe : describe.skip,
);

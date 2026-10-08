import { DataSource, type EntityManager } from "typeorm";
import { randomUUID } from "node:crypto";
import { PricingRepository } from "../../src/pricing/pricing-repository";
import { applyPricingSchema, PRICING_TABLE_NAMES } from "../../src/pricing/pricing-schema";
import { readBookManagement } from "../../src/pricing/pricing-book-management";
import type { PricingActor } from "../../src/pricing/pricing-repository.types";
import type { PricingBookOwnerUpdate } from "../../src/pricing/pricing-book-management.types";
import { tokenBook } from "./pricing-fixtures";

const admin: PricingActor = { id: "author-a", workspace_id: "workspace-a", role: "admin", global_admin: true };
const other = { ...admin, id: "author-b", workspace_id: "workspace-b", global_admin: false };
const update = (revision: number, owner: string | null): PricingBookOwnerUpdate => ({ revision, owner, reason: "Synthetic responsibility assignment", confirm: true });

function contract(label: string, connect: () => Promise<{ db: DataSource; cleanup(): Promise<void> }>, run = describe) {
  run(label, () => {
    let db: DataSource, cleanup: () => Promise<void>, repo: PricingRepository;
    beforeEach(async () => { ({ db, cleanup } = await connect()); await applyPricingSchema(db); repo = new PricingRepository(db); });
    afterEach(async () => { if (db?.isInitialized) await db.destroy(); await cleanup?.(); });
    const create = () => repo.createBook(admin, { name: "Synthetic managed book", scope: "workspace", content: tokenBook() });
    const dump = async (includeManagement = false) => {
      const result: Record<string, string[]> = {};
      for (const table of PRICING_TABLE_NAMES) {
        if (!includeManagement && ["pricing_book_management", "pricing_audit_events"].includes(table)) continue;
        const rows: unknown[] = await db.query(`SELECT * FROM ${table}`);
        result[table] = rows.map(row => JSON.stringify(row)).sort();
      }
      return result;
    };

    it("explicitly assigns new books to their creator and never persists a mutable lifecycle flag", async () => {
      const { book } = await create(), before = await dump(true);
      const info = await repo.getBookManagement({ ...admin, role: "viewer" }, book.id);
      expect(info).toMatchObject({ book_id: book.id, owner: admin.id, revision: 1, updated_by: admin.id, catalog_revision: 0,
        lifecycle: { state: "draft", draft_count: 1, version_count: 0, active_bindings: 0, scheduled_bindings: 0 } });
      expect(info.updated_at).toBe(book.created_at);
      expect(Number.isFinite(Date.parse(info.evaluated_at))).toBe(true);
      expect(await dump(true)).toEqual(before);
      const [record] = await db.query("SELECT * FROM pricing_book_management");
      expect(record.lifecycle).toBeUndefined();
      const [audit] = await db.query("SELECT * FROM pricing_audit_events");
      expect(JSON.parse(audit.metadata_json).owner).toBe(admin.id);
    });

    it("assigns inherited books independently instead of copying their parent's owner", async () => {
      const { book, draft } = await create();
      await repo.updateBookOwner(admin, book.id, update(1, "team:parent"));
      const parent = await repo.publishDraft(admin, draft.id, { draft_revision: 1, catalog_revision: 0, reason: "Synthetic parent", confirm: true, targets: [{ level: "model", model: "synthetic" }] });
      const author = { ...admin, id: "child-author" };
      const child = await repo.createInheritedBook(author, { name: "Child responsibility", scope: "workspace", definition: {
        schema_version: 1, parent: { book_id: book.id, version_id: parent.version_id, content_hash: parent.content_hash }, inherit: "all", source: { kind: "manual" },
        rate_overrides: [], removed_component_ids: [], replaced_groups: [], added_groups: [], removed_group_ids: [], settings: {}, calendar: { mode: "inherit" },
      } });
      expect(await repo.getBookManagement(admin, child.book.id)).toMatchObject({ owner: author.id, revision: 1, lifecycle: { state: "draft" } });
      expect((await repo.getBookManagement(admin, book.id)).owner).toBe("team:parent");
    });

    it("changes only owner metadata and its audit, with separate CAS and explicit clearing", async () => {
      const { book, draft } = await create();
      const published = await repo.publishDraft(admin, draft.id, { draft_revision: 1, catalog_revision: 0, reason: "Synthetic publication", confirm: true, targets: [{ level: "model", model: "synthetic" }] });
      const before = await dump();
      const next = await repo.updateBookOwner(admin, book.id, update(1, "team:finance <label>"));
      expect(next).toMatchObject({ revision: 2, owner: "team:finance <label>", updated_by: admin.id });
      expect(await dump()).toEqual(before);
      const snapshot = await dump(true);
      expect(await repo.updateBookOwner(admin, book.id, update(2, next.owner))).toEqual(next);
      expect(await dump(true)).toEqual(snapshot);
      await expect(repo.updateBookOwner(admin, book.id, update(1, "stale"))).rejects.toMatchObject({ code: "pricing_book_metadata_conflict", status: 409 });
      expect(await dump(true)).toEqual(snapshot);
      expect(await repo.updateBookOwner(admin, book.id, update(2, null))).toMatchObject({ owner: null, revision: 3 });
      expect(await dump()).toEqual(before);
      const cold = await new PricingRepository(db).getBookManagement(admin, book.id);
      expect(cold).toMatchObject({ owner: null, revision: 3, catalog_revision: 1, lifecycle: { state: "active", active_bindings: 1 } });
      expect((await repo.getVersion(admin, book.id, published.version_id)).content_hash).toBe(published.content_hash);
      const events = await db.query("SELECT * FROM pricing_audit_events WHERE action = 'book.owner_changed' ORDER BY created_at, id");
      expect(events).toHaveLength(2);
      expect(events.every((row: { actor_id: string; workspace_id: string; book_id: string }) => row.actor_id === admin.id && row.workspace_id === admin.workspace_id && row.book_id === book.id)).toBe(true);
    });

    it("allows exactly one concurrent writer for both existing and initially unassigned metadata", async () => {
      const { book } = await create();
      for (const absent of [false, true]) {
        if (absent) await db.createQueryBuilder().delete().from("pricing_book_management").where("book_id = :id", { id: book.id }).execute();
        const revision = absent ? 0 : 1;
        const results = await Promise.allSettled([repo.updateBookOwner(admin, book.id, update(revision, "team:a")), new PricingRepository(db).updateBookOwner(admin, book.id, update(revision, "team:b"))]);
        expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
        const failed = results.find(result => result.status === "rejected") as PromiseRejectedResult;
        expect(failed.reason).toMatchObject({ code: "pricing_book_metadata_conflict", status: 409 });
        expect((await repo.getBookManagement(admin, book.id)).revision).toBe(revision + 1);
      }
    });

    it("leaves historical creators unassigned until an explicit owner update", async () => {
      const id = randomUUID(), now = "2026-09-01T00:00:00.000Z";
      await db.createQueryBuilder().insert().into("pricing_books").values({ id, name: "Historical", workspace_id: admin.workspace_id, created_by: "former-author", created_at: now, updated_at: now }).execute();
      const before = await dump(true);
      expect(await repo.getBookManagement(admin, id)).toMatchObject({ owner: null, revision: 0, updated_by: null, updated_at: null });
      expect(await dump(true)).toEqual(before);
      expect(await repo.updateBookOwner(admin, id, update(0, "team:operations"))).toMatchObject({ owner: "team:operations", revision: 1 });
      expect((await repo.getBook(admin, id)).book.created_by).toBe("former-author");
    });

    it("enforces workspace/global ownership and roles without leaking inaccessible book metadata", async () => {
      const { book } = await create();
      for (const role of ["viewer", "operator"] as const) {
        expect((await repo.getBookManagement({ ...admin, role }, book.id)).owner).toBe(admin.id);
        await expect(repo.updateBookOwner({ ...admin, role }, book.id, update(1, "team:unauthorized"))).rejects.toMatchObject({ status: 403 });
      }
      await expect(repo.getBookManagement(other, book.id)).rejects.toMatchObject({ status: 404 });
      await expect(repo.updateBookOwner(other, book.id, update(1, "team:other"))).rejects.toMatchObject({ status: 404 });
      const global = await repo.createBook(admin, { name: "Global", scope: "global", content: tokenBook() });
      expect((await repo.getBookManagement(other, global.book.id)).owner).toBe(admin.id);
      await expect(repo.updateBookOwner(other, global.book.id, update(1, other.id))).rejects.toMatchObject({ status: 403 });
    });

    it("rejects unknown fields, invalid labels/revisions and unconfirmed changes before any write", async () => {
      const { book } = await create(), before = await dump(true);
      const invalid: unknown[] = [null, {}, { ...update(1, "x"), actor_id: "forged" }, { ...update(1, "x"), confirm: false }, update(-1, "x"), update(1.5, "x"), update(1000000000, "x"), update(1, ""), update(1, " x "), update(1, "x".repeat(129)), update(1, "x\ny"), { ...update(1, "x"), owner: {} }, { ...update(1, "x"), reason: " " }];
      for (const value of invalid) await expect(repo.updateBookOwner(admin, book.id, value as PricingBookOwnerUpdate)).rejects.toMatchObject({ status: 400 });
      expect(await dump(true)).toEqual(before);
    });

    it("rolls an owner change back if its audit cannot be saved", async () => {
      const { book } = await create(), before = await dump(true);
      const failure = jest.spyOn(repo as unknown as { audit(manager: EntityManager): Promise<void> }, "audit").mockRejectedValueOnce(new Error("synthetic audit failure"));
      await expect(repo.updateBookOwner(admin, book.id, update(1, "team:replacement"))).rejects.toThrow("synthetic audit failure");
      failure.mockRestore();
      expect(await dump(true)).toEqual(before);
    });

    it("derives all lifecycle states at half-open activation boundaries without hiding drafts", async () => {
      const { book, draft } = await create();
      const from = new Date(Date.now() + 60000).toISOString(), to = new Date(Date.now() + 120000).toISOString();
      const publication = await repo.publishDraft(admin, draft.id, { draft_revision: 1, catalog_revision: 0, confirm: true, reason: "Synthetic scheduled price", targets: [{ level: "model", model: "synthetic" }], effective_from: from, effective_to: to });
      await repo.forkDraft(admin, book.id, publication.version_id);
      expect((await repo.getBookManagement(admin, book.id)).lifecycle).toMatchObject({ state: "scheduled", draft_count: 1, version_count: 1, scheduled_bindings: 1, active_bindings: 0 });
      const before = await dump(true);
      for (const [time, state, active, scheduled] of [[new Date(Date.parse(from) - 1).toISOString(), "scheduled", 0, 1], [from, "active", 1, 0], [to, "inactive", 0, 0]] as const) {
        const info = await readBookManagement(db.manager, book, publication.bindings, 1, time);
        expect(info).toMatchObject({ evaluated_at: time, lifecycle: { state, draft_count: 1, version_count: 1, active_bindings: active, scheduled_bindings: scheduled } });
      }
      expect(await dump(true)).toEqual(before);
      await repo.cancelScheduled(admin, publication.bindings[0].id, 1, "Synthetic cancellation");
      expect((await repo.getBookManagement(admin, book.id)).lifecycle).toMatchObject({ state: "inactive", version_count: 1, draft_count: 1, active_bindings: 0, scheduled_bindings: 0 });
    });
  });
}

contract("SQLite book management", async () => ({ db: await new DataSource({ type: "better-sqlite3", database: ":memory:" }).initialize(), cleanup: async () => undefined }));
const pgUrl = process.env.SIFTGATE_PRICING_TEST_POSTGRES_URL;
if (pgUrl) { const url = new URL(pgUrl); if (url.hostname !== "127.0.0.1" || !/^\/pricing_goal_[a-z0-9_]+$/.test(url.pathname)) throw new Error("Use an isolated loopback pricing_goal_* database"); }
contract("PostgreSQL book management", async () => {
  const connection = await new DataSource({ type: "postgres", url: pgUrl }).initialize(), schema = `pricing_management_${randomUUID().replaceAll("-", "")}`;
  await connection.query(`CREATE SCHEMA "${schema}"`);
  const db = await new DataSource({ type: "postgres", url: pgUrl, schema, extra: { options: `-c search_path=${schema}` } }).initialize();
  return { db, cleanup: async () => { await connection.query(`DROP SCHEMA "${schema}" CASCADE`); await connection.destroy(); } };
}, pgUrl ? describe : describe.skip);

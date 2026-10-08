import type { EntityManager } from "typeorm";
import type { PricingBinding } from "./pricing-catalog.types";
import type { PricingActor, PricingBookRow } from "./pricing-repository.types";
import { PricingRepositoryError } from "./pricing-repository.types";
import type { PricingBookManagement, PricingBookOwner, PricingBookOwnerUpdate } from "./pricing-book-management.types";

const TABLE = "pricing_book_management";
const invalid = (): never => { throw new PricingRepositoryError("pricing_invalid_document", "Invalid price book owner update", 400); };
const conflict = (): never => { throw new PricingRepositoryError("pricing_book_metadata_conflict", "Price book responsibility changed; review the latest owner before editing again", 409); };

export function validateBookOwnerUpdate(input: PricingBookOwnerUpdate): void {
  if (!input || Object.keys(input).some(key => !["revision", "owner", "reason", "confirm"].includes(key)) ||
    !Number.isSafeInteger(input.revision) || input.revision < 0 || input.revision >= 1000000000 || input.confirm !== true ||
    typeof input.reason !== "string" || !input.reason.trim() || input.reason.length > 1000 ||
    (input.owner !== null && (typeof input.owner !== "string" || !input.owner.trim() || input.owner !== input.owner.trim() || input.owner.length > 128 || /[\u0000-\u001f\u007f]/u.test(input.owner)))) invalid();
}

/** Invoked only in the enclosing new-book transaction. Older books remain explicitly unassigned. */
export async function initializeBookOwner(manager: EntityManager, book: PricingBookRow, actor: PricingActor): Promise<void> {
  await manager.createQueryBuilder().insert().into(TABLE).values({ book_id: book.id, owner: actor.id, revision: 1, updated_by: actor.id, updated_at: book.created_at }).execute();
}

export async function readBookOwner(manager: EntityManager, bookId: string): Promise<PricingBookOwner> {
  const row = await manager.createQueryBuilder().select("m.*").from(TABLE, "m").where("m.book_id = :book", { book: bookId }).getRawOne<PricingBookOwner>();
  if (!row) return { book_id: bookId, owner: null, revision: 0, updated_by: null, updated_at: null };
  if (!Number.isSafeInteger(row.revision) || row.revision < 1 || row.revision > 1000000000 ||
    (row.owner !== null && (typeof row.owner !== "string" || !row.owner.trim() || row.owner.length > 128))) conflict();
  return row;
}

/** Caller first authorizes the book and opens a consistent read transaction. */
export async function readBookManagement(manager: EntityManager, book: PricingBookRow, bindings: readonly PricingBinding[], catalogRevision: number, now: string): Promise<PricingBookManagement> {
  const count = async (table: "pricing_drafts" | "pricing_book_versions") => {
    const row = await manager.createQueryBuilder().select("COUNT(*)", "count").from(table, "c").where("c.book_id = :book", { book: book.id }).getRawOne<{ count: string | number }>();
    const value = Number(row?.count ?? 0);
    if (!Number.isSafeInteger(value) || value < 0) conflict();
    return value;
  };
  const owner = await readBookOwner(manager, book.id);
  const draft_count = await count("pricing_drafts"), version_count = await count("pricing_book_versions");
  const timestamp = Date.parse(now);
  let active_bindings = 0, scheduled_bindings = 0;
  for (const binding of bindings) {
    if (binding.book_id !== book.id) continue;
    if (Date.parse(binding.effective_from) > timestamp) scheduled_bindings++;
    else if (!binding.effective_to || timestamp < Date.parse(binding.effective_to)) active_bindings++;
  }
  return { ...owner, evaluated_at: now, catalog_revision: catalogRevision, lifecycle: {
    state: active_bindings ? "active" : scheduled_bindings ? "scheduled" : version_count ? "inactive" : "draft",
    draft_count, version_count, active_bindings, scheduled_bindings,
  } };
}

/** Metadata has its own CAS revision. Never updates a price, binding, catalog head, or access role. */
export async function updateBookOwner(manager: EntityManager, actor: PricingActor, book: PricingBookRow, input: PricingBookOwnerUpdate): Promise<{ before: PricingBookOwner; after: PricingBookOwner; changed: boolean }> {
  validateBookOwnerUpdate(input);
  // Serialize the initial assignment too: there may be no metadata row to lock yet.
  const lock = manager.createQueryBuilder().select("b.id", "id").from("pricing_books", "b").where("b.id = :book", { book: book.id });
  if (manager.connection.options.type === "postgres") lock.setLock("pessimistic_write");
  if (!(await lock.getRawOne())) conflict();
  const before = await readBookOwner(manager, book.id);
  if (before.revision !== input.revision) conflict();
  if (before.owner === input.owner) return { before, after: before, changed: false };
  const after: PricingBookOwner = { book_id: book.id, owner: input.owner, revision: before.revision + 1, updated_by: actor.id, updated_at: new Date().toISOString() };
  if (before.revision === 0) await manager.createQueryBuilder().insert().into(TABLE).values(after).execute();
  else {
    const result = await manager.createQueryBuilder().update(TABLE).set(after).where("book_id = :book AND revision = :revision", { book: book.id, revision: before.revision }).execute();
    if (result.affected !== 1) conflict();
  }
  return { before, after, changed: true };
}

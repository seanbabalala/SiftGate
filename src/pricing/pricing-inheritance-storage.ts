import { randomUUID } from "node:crypto";
import type { EntityManager } from "typeorm";
import { compilePriceBook } from "./pricing-compiler";
import { pricingContentHash } from "./pricing-json";
import {
  parsePricingInheritance,
  resolvePricingInheritance,
} from "./pricing-inheritance";
import {
  PricingRepositoryError,
  type PricingActor,
  type PricingBookRow,
  type PricingDraftRow,
  type PricingVersionRow,
} from "./pricing-repository.types";
import type { PriceBookContent } from "./pricing.types";
import type {
  PricingInheritanceView,
  PriceBookParentReference,
} from "./pricing-inheritance.types";

const DRAFT_TABLE = "pricing_draft_inheritance",
  VERSION_TABLE = "pricing_version_inheritance";
const MAX_DEPTH = 16,
  MAX_BODY = 2 * 1024 * 1024;
type Payload = Omit<PricingInheritanceView, "lineage_hash">;
interface Stored {
  book_id: string;
  draft_id?: string;
  draft_revision?: number;
  version_id?: string;
  parent_book_id: string;
  parent_version_id: string;
  parent_content_hash: string;
  content_hash: string;
  record_hash: string;
  audit_id: string;
  actor_id: string;
  created_at: string;
  payload_json: string;
}
function conflict(message: string): never {
  throw new PricingRepositoryError("pricing_version_conflict", message, 409);
}
function missing(): never {
  throw new PricingRepositoryError(
    "pricing_not_found",
    "Parent price version is unavailable in the selected scope",
    404,
  );
}
function decode<T>(json: string): T {
  if (typeof json !== "string" || Buffer.byteLength(json) > MAX_BODY)
    conflict("Inheritance record exceeds its bound");
  try {
    return JSON.parse(json) as T;
  } catch {
    return conflict("Inheritance record is not valid JSON");
  }
}
const same = (a: unknown, b: unknown) =>
  pricingContentHash(a) === pricingContentHash(b);
const draftMarker = (id: string) => `inheritance-draft:${id}`;
const versionMarker = (book: string, version: string) =>
  `inheritance-version:${pricingContentHash([book, version])}`;
const hashPayload = (payload: Payload) => pricingContentHash(payload);

async function auditPresent(manager: EntityManager, id: string) {
  return manager
    .createQueryBuilder()
    .select("a.id", "id")
    .from("pricing_audit_events", "a")
    .where("a.id = :id", { id })
    .getRawOne();
}
async function readRow(
  manager: EntityManager,
  kind: "draft" | "version",
  book: string,
  id: string,
) {
  return manager
    .createQueryBuilder()
    .select("i.*")
    .from(kind === "draft" ? DRAFT_TABLE : VERSION_TABLE, "i")
    .where(
      kind === "draft"
        ? "i.book_id = :book AND i.draft_id = :id"
        : "i.book_id = :book AND i.version_id = :id",
      { book, id },
    )
    .getRawOne<Stored>();
}
async function verifyStored(
  manager: EntityManager,
  row: Stored,
  scope: string | null,
  kind: "draft" | "version",
): Promise<Payload> {
  const payload = decode<Payload>(row.payload_json);
  const { record_hash, ...body } = row;
  const audit = await manager
    .createQueryBuilder()
    .select("a.*")
    .from("pricing_audit_events", "a")
    .where("a.id = :id", { id: row.audit_id })
    .getRawOne<{
      workspace_id: string | null;
      book_id: string;
      actor_id: string;
      action: string;
      metadata_json: string;
    }>();
  if (
    !audit ||
    audit.workspace_id !== scope ||
    audit.book_id !== row.book_id ||
    audit.actor_id !== row.actor_id ||
    audit.action !== `${kind}.inheritance_saved` ||
    !same(decode(audit.metadata_json), { record_hash }) ||
    pricingContentHash(body) !== record_hash ||
    !payload.definition ||
    !payload.provenance ||
    !Array.isArray(payload.ancestors) ||
    !payload.ancestors.length ||
    payload.ancestors.length > MAX_DEPTH ||
    payload.definition.parent.book_id !== row.parent_book_id ||
    payload.definition.parent.version_id !== row.parent_version_id ||
    payload.definition.parent.content_hash !== row.parent_content_hash ||
    payload.provenance.resolved_content_hash !== row.content_hash
  )
    conflict("Inheritance record, scope or required audit is inconsistent");
  if (
    kind === "version" &&
    row.audit_id !== versionMarker(row.book_id, row.version_id!)
  )
    conflict("Published inheritance audit identity differs");
  if (
    kind === "draft" &&
    !(await auditPresent(manager, draftMarker(row.draft_id!)))
  )
    conflict("Inherited draft attachment audit is missing");
  return payload;
}

/** Verify one immutable source and its bounded ancestry. This is a configuration/hydration operation, not per-token pricing. */
async function versionSource(
  manager: EntityManager,
  bookId: string,
  versionId: string,
  scope: string | null,
  path: Set<string>,
): Promise<{
  reference: PriceBookParentReference;
  content: PriceBookContent;
  inheritance: PricingInheritanceView | null;
}> {
  const key = JSON.stringify([bookId, versionId]);
  if (path.has(key) || path.size > MAX_DEPTH)
    conflict("Price inheritance contains a cycle or exceeds16 ancestors");
  const next = new Set(path);
  next.add(key);
  const owner = await manager
    .createQueryBuilder()
    .select("b.workspace_id", "workspace_id")
    .from("pricing_books", "b")
    .where("b.id = :book", { book: bookId })
    .getRawOne<{ workspace_id: string | null }>();
  if (!owner || (owner.workspace_id !== null && owner.workspace_id !== scope))
    missing();
  const version = await manager
    .createQueryBuilder()
    .select("v.*")
    .from("pricing_book_versions", "v")
    .where("v.book_id = :book AND v.version_id = :version", {
      book: bookId,
      version: versionId,
    })
    .getRawOne<PricingVersionRow>();
  if (!version) missing();
  const content = compilePriceBook(decode(version.content_json), {
    book_id: bookId,
    version_id: versionId,
  }).document();
  if (pricingContentHash(content) !== version.content_hash)
    conflict("Parent version content hash differs");
  const inherited = await readVersionWithContent(
    manager,
    version,
    owner.workspace_id,
    content,
    next,
  );
  return {
    reference: {
      book_id: bookId,
      version_id: versionId,
      content_hash: version.content_hash,
    },
    content,
    inheritance: inherited,
  };
}

async function resolveInScope(
  manager: EntityManager,
  value: unknown,
  identity: { book_id: string; version_id: string },
  scope: string | null,
  path: Set<string>,
): Promise<{ content: PriceBookContent; view: PricingInheritanceView }> {
  const definition = parsePricingInheritance(value);
  const parent = await versionSource(
    manager,
    definition.parent.book_id,
    definition.parent.version_id,
    scope,
    path,
  );
  const expanded = resolvePricingInheritance(definition, parent, identity);
  const ancestors = [
    {
      ...parent.reference,
      lineage_hash: parent.inheritance?.lineage_hash ?? null,
    },
    ...(parent.inheritance?.ancestors ?? []),
  ];
  if (ancestors.length > MAX_DEPTH)
    conflict("Price inheritance exceeds16 ancestors");
  const payload: Payload = {
    definition: expanded.definition,
    provenance: expanded.provenance,
    ancestors,
  };
  return {
    content: expanded.content,
    view: { ...payload, lineage_hash: hashPayload(payload) },
  };
}

async function readVersionWithContent(
  manager: EntityManager,
  version: PricingVersionRow,
  scope: string | null,
  content: PriceBookContent,
  path: Set<string>,
): Promise<PricingInheritanceView | null> {
  const stored = await readRow(
    manager,
    "version",
    version.book_id,
    version.version_id,
  );
  if (!stored) {
    if (
      await auditPresent(
        manager,
        versionMarker(version.book_id, version.version_id),
      )
    )
      conflict("Published parent lineage is missing");
    return null;
  }
  const payload = await verifyStored(manager, stored, scope, "version");
  const resolved = await resolveInScope(
    manager,
    payload.definition,
    { book_id: version.book_id, version_id: version.version_id },
    scope,
    path,
  );
  const { lineage_hash, ...rebuilt } = resolved.view;
  if (
    !same(payload, rebuilt) ||
    !same(content, resolved.content) ||
    stored.content_hash !== version.content_hash
  )
    conflict(
      "Published inherited content no longer reproduces from its frozen parent",
    );
  return { ...payload, lineage_hash };
}
export async function resolveScopedInheritance(
  manager: EntityManager,
  value: unknown,
  book: Pick<PricingBookRow, "id" | "workspace_id">,
  versionId: string,
) {
  return resolveInScope(
    manager,
    value,
    { book_id: book.id, version_id: versionId },
    book.workspace_id,
    new Set([JSON.stringify([book.id, versionId])]),
  );
}
export async function readVersionInheritance(
  manager: EntityManager,
  version: PricingVersionRow,
  scope: string | null,
): Promise<PricingInheritanceView | null> {
  return readVersionWithContent(
    manager,
    version,
    scope,
    decode<PriceBookContent>(version.content_json),
    new Set([JSON.stringify([version.book_id, version.version_id])]),
  );
}

/** Preserve bulk catalog hydration for legacy/manual versions: two bounded metadata queries, not two per model. */
export async function verifyCatalogInheritance(
  manager: EntityManager,
  versions: Array<{ version: PricingVersionRow; scope: string | null }>,
): Promise<void> {
  for (let start = 0; start < versions.length; start += 400) {
    const entries = versions.slice(start, start + 400);
    const rows = await manager
      .createQueryBuilder()
      .select(["i.book_id AS book_id", "i.version_id AS version_id"])
      .from(VERSION_TABLE, "i")
      .where("i.book_id IN (:...books) AND i.version_id IN (:...versions)", {
        books: [...new Set(entries.map((e) => e.version.book_id))],
        versions: [...new Set(entries.map((e) => e.version.version_id))],
      })
      .getRawMany<{ book_id: string; version_id: string }>();
    const audits = await manager
      .createQueryBuilder()
      .select("a.id", "id")
      .from("pricing_audit_events", "a")
      .where("a.id IN (:...ids)", {
        ids: entries.map((e) =>
          versionMarker(e.version.book_id, e.version.version_id),
        ),
      })
      .getRawMany<{ id: string }>();
    const present = new Set(
        rows.map((r) => JSON.stringify([r.book_id, r.version_id])),
      ),
      markers = new Set(audits.map((r) => r.id));
    for (const entry of entries) {
      const v = entry.version;
      if (
        present.has(JSON.stringify([v.book_id, v.version_id])) ||
        markers.has(versionMarker(v.book_id, v.version_id))
      )
        await readVersionInheritance(manager, v, entry.scope);
    }
  }
}
export async function readDraftInheritance(
  manager: EntityManager,
  draft: PricingDraftRow,
  book: PricingBookRow,
): Promise<PricingInheritanceView | null> {
  const stored = await readRow(manager, "draft", book.id, draft.id);
  if (!stored) {
    if (await auditPresent(manager, draftMarker(draft.id)))
      conflict("Inherited draft recipe is missing; do not flatten it silently");
    return null;
  }
  const payload = await verifyStored(
    manager,
    stored,
    book.workspace_id,
    "draft",
  );
  if (stored.draft_revision !== draft.revision)
    conflict("Inherited draft recipe revision differs");
  const resolved = await resolveScopedInheritance(
    manager,
    payload.definition,
    book,
    draft.id,
  );
  const { lineage_hash, ...rebuilt } = resolved.view;
  if (
    !same(payload, rebuilt) ||
    !same(decode(draft.content_json), resolved.content) ||
    pricingContentHash(resolved.content) !== stored.content_hash
  )
    conflict("Inherited draft materialization differs from its recipe");
  return { ...payload, lineage_hash };
}

async function store(
  manager: EntityManager,
  kind: "draft" | "version",
  book: PricingBookRow,
  id: string,
  actor: PricingActor,
  view: PricingInheritanceView,
  revision?: number,
) {
  const { lineage_hash, ...payload } = view;
  if (lineage_hash !== hashPayload(payload))
    conflict("Inheritance payload hash differs before persistence");
  const row: Stored = {
    book_id: book.id,
    ...(kind === "draft"
      ? { draft_id: id, draft_revision: revision! }
      : { version_id: id }),
    parent_book_id: payload.definition.parent.book_id,
    parent_version_id: payload.definition.parent.version_id,
    parent_content_hash: payload.definition.parent.content_hash,
    content_hash: payload.provenance.resolved_content_hash,
    record_hash: "",
    audit_id: kind === "version" ? versionMarker(book.id, id) : randomUUID(),
    actor_id: actor.id,
    created_at: new Date().toISOString(),
    payload_json: JSON.stringify(payload),
  };
  const { record_hash: _hash, ...body } = row;
  row.record_hash = pricingContentHash(body);
  if (kind === "draft" && !(await auditPresent(manager, draftMarker(id))))
    await manager
      .createQueryBuilder()
      .insert()
      .into("pricing_audit_events")
      .values({
        id: draftMarker(id),
        workspace_id: book.workspace_id,
        book_id: book.id,
        actor_id: actor.id,
        action: "draft.inheritance_attached",
        reason: "Explicit immutable parent selected",
        metadata_json: JSON.stringify({ draft_id: id }),
        created_at: row.created_at,
      })
      .execute();
  await manager
    .createQueryBuilder()
    .insert()
    .into("pricing_audit_events")
    .values({
      id: row.audit_id,
      workspace_id: book.workspace_id,
      book_id: book.id,
      actor_id: actor.id,
      action: `${kind}.inheritance_saved`,
      reason: "Preserve verified immutable parent recipe and materialization",
      metadata_json: JSON.stringify({ record_hash: row.record_hash }),
      created_at: row.created_at,
    })
    .execute();
  const table = kind === "draft" ? DRAFT_TABLE : VERSION_TABLE;
  if (kind === "draft")
    await manager
      .createQueryBuilder()
      .delete()
      .from(table)
      .where("draft_id = :id AND book_id = :book", { id, book: book.id })
      .execute();
  await manager
    .createQueryBuilder()
    .insert()
    .into(table, Object.keys(row))
    .values(row)
    .execute();
}
export const storeDraftInheritance = (
  m: EntityManager,
  b: PricingBookRow,
  d: PricingDraftRow,
  a: PricingActor,
  v: PricingInheritanceView,
) => store(m, "draft", b, d.id, a, v, d.revision);
export const storeVersionInheritance = (
  m: EntityManager,
  b: PricingBookRow,
  id: string,
  a: PricingActor,
  v: PricingInheritanceView,
) => store(m, "version", b, id, a, v);
export async function deletePublishedDraftInheritance(
  manager: EntityManager,
  draftId: string,
) {
  await manager
    .createQueryBuilder()
    .delete()
    .from(DRAFT_TABLE)
    .where("draft_id = :id", { id: draftId })
    .execute();
}

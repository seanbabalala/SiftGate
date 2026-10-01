import {
  parseAdmissionPolicy,
  PRICING_ADMISSION_OPERATIONS,
} from "./pricing-admission-policy";
import type {
  CatalogAdmissionPolicy,
  PricingAdmissionPolicy,
  ReservationQuantityBounds,
} from "./pricing-admission.types";
import { NON_TOKEN_BUDGET_OPERATIONS } from "./pricing-admission.types";
import { calculateCost } from "./cost-calculator";
import { selectAdmissionPolicy } from "./pricing-admission-selection";
import { CompiledPriceBook, compilePriceBook } from "./pricing-compiler";
import { PricingCompileError } from "./pricing-errors";
import { pricingContentHash } from "./pricing-json";
import { PricingSchemaReader } from "./pricing-schema-reader";
import { parsePricingInstant } from "./pricing-time";
import type {
  FxSnapshot,
  NormalizedUsage,
  PricingContext,
  PricingDiagnostic,
} from "./pricing.types";
import type {
  CatalogBookVersion,
  CatalogFxVersion,
  PricingBinding,
  PricingBindingLevel,
  PricingCatalogDocument,
  PricingRequestSnapshot,
  PricingTarget,
  SnapshotQuote,
} from "./pricing-catalog.types";

const LEVEL_RANK: Record<PricingBindingLevel, number> = {
  node: 30,
  model: 20,
  catalog: 10,
  legacy: 0,
};
const versionKey = (bookId: string, versionId: string): string =>
  JSON.stringify([bookId, versionId]);

interface ActiveBindingWindow {
  from: number;
  to: number;
}

interface IndexedBinding {
  binding: PricingBinding;
  from: number;
  to: number;
}
interface IndexedFx {
  version: CatalogFxVersion;
  from: number;
  to: number;
}

/** An immutable revision. No current-time, current-price or network lookup occurs during a quote. */
export class CompiledPricingCatalog {
  readonly revisionId: string;
  readonly contentHash: string;
  private readonly content: PricingCatalogDocument;
  private readonly books = new Map<string, CompiledPriceBook>();
  private readonly bindings = new Map<string, IndexedBinding[]>();
  private readonly fx = new Map<string, IndexedFx[]>();
  private readonly activeWindows = new Map<string | null, ActiveBindingWindow[]>();

  static compile(value: unknown): CompiledPricingCatalog {
    const parser = new CatalogParser();
    const content = parser.parse(value);
    if (parser.diagnostics.length)
      throw new PricingCompileError(parser.diagnostics);
    return new CompiledPricingCatalog(content);
  }

  private constructor(content: PricingCatalogDocument) {
    this.content = structuredClone(content);
    this.revisionId = content.revision_id;
    this.contentHash = pricingContentHash(this.content);
    for (const version of content.books)
      this.books.set(
        versionKey(version.book_id, version.version_id),
        compilePriceBook(version.content, version),
      );
    for (const binding of this.content.bindings) {
      const entries = this.bindings.get(binding.model) ?? [];
      const indexed = {
        binding,
        from: parsePricingInstant(binding.effective_from),
        to: binding.effective_to
          ? parsePricingInstant(binding.effective_to)
          : Infinity,
      };
      entries.push(indexed);
      this.bindings.set(binding.model, entries);
      const windows = this.activeWindows.get(binding.workspace_id) ?? [];
      windows.push({ from: indexed.from, to: indexed.to });
      this.activeWindows.set(binding.workspace_id, windows);
    }
    for (const entries of this.bindings.values()) entries.sort((a, b) => bindingRank(b.binding) - bindingRank(a.binding));
    // Any active price is a workspace-level admission predicate, not model selection.
    // Union once at compilation so unrelated/expired models never get scanned per request.
    for (const [workspace, windows] of this.activeWindows) {
      windows.sort((a, b) => a.from - b.from);
      const merged: ActiveBindingWindow[] = [];
      for (const window of windows) {
        const previous = merged.at(-1);
        if (previous && window.from <= previous.to) previous.to = Math.max(previous.to, window.to);
        else merged.push({ ...window });
      }
      this.activeWindows.set(workspace, merged);
    }
    for (const version of this.content.fx_versions) {
      const key = JSON.stringify([
        version.fx.from_currency,
        version.fx.to_currency,
      ]);
      const entries = this.fx.get(key) ?? [];
      entries.push({
        version,
        from: parsePricingInstant(version.fx.effective_at),
        to: version.effective_to
          ? parsePricingInstant(version.effective_to)
          : Infinity,
      });
      this.fx.set(key, entries);
    }
  }

  hasBindings(workspace: string, admittedAt: string): boolean {
    const epoch = parsePricingInstant(admittedAt);
    return this.hasActiveWindow(null, epoch) || this.hasActiveWindow(workspace, epoch);
  }

  private hasActiveWindow(workspace: string | null, epoch: number): boolean {
    const windows = this.activeWindows.get(workspace);
    if (!windows) return false;
    let low = 0, high = windows.length;
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2);
      const window = windows[middle];
      if (epoch < window.from) high = middle;
      else if (epoch >= window.to) low = middle + 1;
      else return true;
    }
    return false;
  }

  document(): PricingCatalogDocument {
    return structuredClone(this.content);
  }

  get createdAt(): string {
    return this.content.created_at;
  }

  capture(input: {
    admitted_at: string;
    workspace_id: string;
    report_currency: string;
  }): FrozenPricingRequest {
    validateCapture(input);
    if (
      parsePricingInstant(input.admitted_at) <
      parsePricingInstant(this.content.created_at)
    )
      throw problem(
        "admitted_at",
        "A request cannot be admitted before its catalog revision was created",
      );
    const body = {
      schema_version: 1 as const,
      catalog_revision_id: this.revisionId,
      catalog_content_hash: this.contentHash,
      admitted_at: new Date(
        parsePricingInstant(input.admitted_at),
      ).toISOString(),
      workspace_id: input.workspace_id,
      report_currency: input.report_currency,
    };
    return new FrozenPricingRequest(this, {
      ...body,
      snapshot_id: pricingContentHash(body),
    });
  }

  restore(value: unknown, authorizedWorkspaceId: string): FrozenPricingRequest {
    const reader = new PricingSchemaReader();
    const raw = reader.object(value, "snapshot", [
      "schema_version",
      "snapshot_id",
      "catalog_revision_id",
      "catalog_content_hash",
      "admitted_at",
      "workspace_id",
      "report_currency",
    ]);
    if (raw.schema_version !== 1)
      reader.invalid(
        "snapshot.schema_version",
        "Only snapshot schema 1 is supported",
      );
    const input = {
      admitted_at: reader.string(raw.admitted_at, "snapshot.admitted_at"),
      workspace_id: reader.string(raw.workspace_id, "snapshot.workspace_id"),
      report_currency: reader.string(
        raw.report_currency,
        "snapshot.report_currency",
      ),
    };
    if (input.workspace_id !== authorizedWorkspaceId)
      reader.invalid(
        "snapshot.workspace_id",
        "Snapshot belongs to another workspace",
        "pricing_permission_denied",
      );
    if (
      raw.catalog_revision_id !== this.revisionId ||
      raw.catalog_content_hash !== this.contentHash
    )
      reader.invalid(
        "snapshot.catalog_revision_id",
        "Frozen catalog revision is unavailable or has changed",
        "pricing_version_conflict",
      );
    if (reader.diagnostics.length)
      throw new PricingCompileError(reader.diagnostics);
    const restored = this.capture(input);
    if (restored.descriptor().snapshot_id !== raw.snapshot_id)
      throw problem(
        "snapshot.snapshot_id",
        "Snapshot checksum does not match its immutable fields",
        "pricing_version_conflict",
      );
    return restored;
  }

  quote(
    snapshot: PricingRequestSnapshot,
    target: PricingTarget,
    usage: NormalizedUsage,
    context: PricingContext,
  ): SnapshotQuote {
    if (
      snapshot.catalog_revision_id !== this.revisionId ||
      snapshot.catalog_content_hash !== this.contentHash
    )
      throw problem(
        "snapshot",
        "Quote must use the frozen catalog revision",
        "pricing_version_conflict",
      );
    const binding = this.selectBinding(snapshot, target);
    const book = binding
      ? this.books.get(versionKey(binding.book_id, binding.version_id))!
      : null;
    const price = book?.resolve(usage, context) ?? null;
    const fx = this.selectFx(snapshot, price?.currency);
    const cost = calculateCost(usage, price, {
      report_currency: snapshot.report_currency,
      fx,
    });
    if (!binding)
      cost.diagnostics.push({
        code: "pricing_dimension_missing",
        path: "binding",
        message:
          "No price binding exists for this target in the frozen request catalog",
      });
    return {
      snapshot: structuredClone(snapshot),
      binding_id: binding?.id ?? null,
      target: { ...target },
      cost,
    };
  }
  admissionPolicy(
    workspace: string,
    operation?: string,
  ): PricingAdmissionPolicy {
    return selectAdmissionPolicy(this.content.admission_policies ?? [], workspace, operation);
  }

  reservationEnvelope(
    snapshot: PricingRequestSnapshot,
    target: PricingTarget,
    bounds: ReservationQuantityBounds,
  ) {
    const binding = this.selectBinding(snapshot, target);
    if (!binding) return null;
    const book = this.books.get(
      versionKey(binding.book_id, binding.version_id),
    )!;
    return book.reservationEnvelope(
      bounds,
      snapshot.report_currency,
      this.selectFx(snapshot, book.currency),
    );
  }

  billingDimensions(snapshot: PricingRequestSnapshot, target: PricingTarget) {
    const binding = this.selectBinding(snapshot, target);
    return binding ? this.books.get(versionKey(binding.book_id, binding.version_id))!.billingDimensions() : null;
  }

  private selectBinding(
    snapshot: PricingRequestSnapshot,
    target: PricingTarget,
  ): PricingBinding | undefined {
    if (
      snapshot.catalog_revision_id !== this.revisionId ||
      snapshot.catalog_content_hash !== this.contentHash
    )
      throw problem(
        "snapshot",
        "Quote must use the frozen catalog revision",
        "pricing_version_conflict",
      );
    return this.selectBindingAt(snapshot.workspace_id, target, parsePricingInstant(snapshot.admitted_at));
  }

  private matchingBindings(workspace: string, target: PricingTarget): IndexedBinding[] {
    return (this.bindings.get(target.model) ?? [])
      .filter(
        ({ binding }) =>
          (binding.workspace_id === null ||
            binding.workspace_id === workspace) &&
          (binding.node_id === undefined ||
            binding.node_id === target.node_id) &&
          (binding.operation === undefined ||
            binding.operation === target.operation),
      );
  }

  private selectBindingAt(workspace: string, target: PricingTarget, epoch: number): PricingBinding | undefined {
    return this.matchingBindings(workspace, target).find(({ from, to }) => from <= epoch && epoch < to)?.binding;
  }

  /** Read-only current/scheduled winners using exactly the request selector's precedence. */
  inspectBindings(workspace: string, target: PricingTarget, instant: string) {
    const epoch = parsePricingInstant(instant), matches = this.matchingBindings(workspace, target);
    const winner = (at: number) => matches.find(({ from, to }) => from <= at && at < to)?.binding ?? null;
    const current = winner(epoch), points = [...new Set(matches.flatMap(({ from, to }) => [from, to]).filter(at => Number.isFinite(at) && at > epoch))].sort((a, b) => a - b);
    const scheduled: Array<{ effective_at: string; binding: PricingBinding | null }> = [];
    let previous = current?.id, truncated = false;
    for (const at of points) {
      const binding = winner(at);
      if (binding?.id === previous) continue;
      if (scheduled.length === 8) { truncated = true; break; }
      scheduled.push({ effective_at: new Date(at).toISOString(), binding }); previous = binding?.id;
    }
    return structuredClone({ current, scheduled, truncated });
  }

  /** Small read-only evidence view; shares the quote selector and never uses the active catalog. */
  inspectFx(snapshot: PricingRequestSnapshot, currency: string): FxSnapshot | null {
    if (snapshot.catalog_revision_id !== this.revisionId || snapshot.catalog_content_hash !== this.contentHash)
      throw problem("snapshot", "FX evidence must use the frozen catalog revision", "pricing_version_conflict");
    return structuredClone(this.selectFx(snapshot, currency) ?? null);
  }

  private selectFx(
    snapshot: PricingRequestSnapshot,
    currency?: string,
  ): FxSnapshot | undefined {
    const epoch = parsePricingInstant(snapshot.admitted_at);
    return (
      this.fx.get(JSON.stringify([currency, snapshot.report_currency])) ?? []
    )
      .filter(
        ({ version, from, to }) =>
          from <= epoch &&
          epoch < to &&
          (version.workspace_id === null ||
            version.workspace_id === snapshot.workspace_id),
      )
      .sort(
        (a, b) =>
          Number(b.version.workspace_id !== null) -
          Number(a.version.workspace_id !== null),
      )[0]?.version.fx;
  }
}

/** Owned small descriptor plus a reference to the compiled revision; no full catalog copy per request. */
export class FrozenPricingRequest {
  private readonly snapshot: PricingRequestSnapshot;
  constructor(
    private readonly catalog: CompiledPricingCatalog,
    snapshot: PricingRequestSnapshot,
  ) {
    this.snapshot = structuredClone(snapshot);
  }
  hasBindings(): boolean {
    return this.catalog.hasBindings(
      this.snapshot.workspace_id,
      this.snapshot.admitted_at,
    );
  }
  admissionPolicy(operation?: string): PricingAdmissionPolicy {
    return this.catalog.admissionPolicy(this.snapshot.workspace_id, operation);
  }
  billingDimensions(target: PricingTarget) {
    return this.catalog.billingDimensions(this.snapshot, target);
  }
  reservationEnvelope(
    target: PricingTarget,
    bounds: ReservationQuantityBounds,
  ) {
    return this.catalog.reservationEnvelope(this.snapshot, target, bounds);
  }
  descriptor(): PricingRequestSnapshot {
    return structuredClone(this.snapshot);
  }
  inspectFx(currency: string): FxSnapshot | null {
    return this.catalog.inspectFx(this.snapshot, currency);
  }
  quote(
    target: PricingTarget,
    usage: NormalizedUsage,
    context: PricingContext = {},
  ): SnapshotQuote {
    return this.catalog.quote(this.snapshot, target, usage, context);
  }
}

/** Process-local publication view. Durable CAS/audit transactions belong to the repository layer. */
export class PricingCatalogRegistry {
  private active: CompiledPricingCatalog | null = null;
  private readonly revisions = new Map<string, CompiledPricingCatalog>();
  private readonly bookHashes = new Map<string, string>();
  private readonly fxHashes = new Map<string, string>();
  private readonly bookOwners = new Map<string, string | null>();

  activeRevisionId(): string | null {
    return this.active?.revisionId ?? null;
  }

  install(
    value: unknown,
    expectedRevisionId: string | null,
  ): CompiledPricingCatalog {
    const candidate = CompiledPricingCatalog.compile(value);
    if (this.activeRevisionId() !== expectedRevisionId)
      throw problem(
        "catalog.revision_id",
        "Catalog was changed by another publisher",
        "pricing_version_conflict",
      );
    this.rememberCompiled(candidate);
    this.active = candidate;
    return candidate;
  }

  remember(value: unknown): void {
    this.rememberCompiled(CompiledPricingCatalog.compile(value));
  }

  capture(input: {
    admitted_at: string;
    workspace_id: string;
    report_currency: string;
  }): FrozenPricingRequest {
    if (!this.active)
      throw problem(
        "catalog",
        "No published catalog is available",
        "pricing_version_conflict",
      );
    return this.active.capture(input);
  }

  restore(
    snapshot: PricingRequestSnapshot,
    authorizedWorkspaceId: string,
  ): FrozenPricingRequest {
    const revision = this.revisions.get(snapshot.catalog_revision_id);
    if (!revision)
      throw problem(
        "snapshot.catalog_revision_id",
        "The historical revision must be loaded; latest prices cannot substitute for it",
        "pricing_version_conflict",
      );
    return revision.restore(snapshot, authorizedWorkspaceId);
  }

  private rememberCompiled(candidate: CompiledPricingCatalog): void {
    const existing = this.revisions.get(candidate.revisionId);
    if (existing && existing.contentHash !== candidate.contentHash)
      throw problem(
        "catalog.revision_id",
        "Published revision IDs are immutable",
        "pricing_version_conflict",
      );
    const doc = candidate.document();
    for (const book of doc.books) {
      if (
        this.bookOwners.has(book.book_id) &&
        this.bookOwners.get(book.book_id) !== book.workspace_id
      )
        throw problem(
          "books.workspace_id",
          "A book cannot move between workspaces across versions",
          "pricing_permission_denied",
        );
      const previous = this.bookHashes.get(
        versionKey(book.book_id, book.version_id),
      );
      const fingerprint = pricingContentHash({
        workspace_id: book.workspace_id,
        content_hash: book.content_hash,
      });
      if (previous && previous !== fingerprint)
        throw problem(
          "books.version_id",
          "Published price versions and ownership are immutable",
          "pricing_version_conflict",
        );
    }
    for (const version of doc.fx_versions) {
      const previous = this.fxHashes.get(version.fx.version_id);
      const fingerprint = pricingContentHash({
        workspace_id: version.workspace_id,
        fx: version.fx,
      });
      if (previous && previous !== fingerprint)
        throw problem(
          "fx_versions.version_id",
          "Published FX versions and ownership are immutable",
          "pricing_version_conflict",
        );
    }
    for (const book of doc.books) {
      this.bookHashes.set(
        versionKey(book.book_id, book.version_id),
        pricingContentHash({
          workspace_id: book.workspace_id,
          content_hash: book.content_hash,
        }),
      );
      this.bookOwners.set(book.book_id, book.workspace_id);
    }
    for (const version of doc.fx_versions)
      this.fxHashes.set(
        version.fx.version_id,
        pricingContentHash({
          workspace_id: version.workspace_id,
          fx: version.fx,
        }),
      );
    this.revisions.set(candidate.revisionId, candidate);
  }
}

function validateCapture(input: {
  admitted_at: string;
  workspace_id: string;
  report_currency: string;
}): void {
  if (
    typeof input.workspace_id !== "string" ||
    !input.workspace_id.length ||
    input.workspace_id.length > 128
  )
    throw problem(
      "workspace_id",
      "A trusted workspace identity is required",
      "pricing_permission_denied",
    );
  if (!/^[A-Z]{3}$/.test(input.report_currency))
    throw problem(
      "report_currency",
      "Expected a three-letter uppercase currency",
    );
  try {
    parsePricingInstant(input.admitted_at);
  } catch (error) {
    throw problem("admitted_at", (error as Error).message);
  }
}

function problem(
  path: string,
  message: string,
  code: PricingDiagnostic["code"] = "pricing_invalid_document",
): PricingCompileError {
  return new PricingCompileError([{ path, message, code }]);
}

function bindingRank(binding: PricingBinding): number {
  return (
    (binding.workspace_id === null ? 0 : 100) +
    LEVEL_RANK[binding.level] +
    (binding.operation === undefined ? 0 : 1)
  );
}

function intervalsOverlap(
  aFrom: string,
  aTo: string | undefined,
  bFrom: string,
  bTo: string | undefined,
): boolean {
  return (
    parsePricingInstant(aFrom) < (bTo ? parsePricingInstant(bTo) : Infinity) &&
    parsePricingInstant(bFrom) < (aTo ? parsePricingInstant(aTo) : Infinity)
  );
}

class CatalogParser extends PricingSchemaReader {
  parse(value: unknown): PricingCatalogDocument {
    const raw = this.object(value, "catalog", [
      "schema_version",
      "revision_id",
      "created_at",
      "books",
      "bindings",
      "fx_versions",
      "admission_policies",
    ]);
    if (raw.schema_version !== 1)
      this.invalid(
        "catalog.schema_version",
        "Only catalog schema 1 is supported",
      );
    const doc: PricingCatalogDocument = {
      schema_version: 1,
      revision_id: this.string(raw.revision_id, "catalog.revision_id"),
      created_at: this.instant(raw.created_at, "catalog.created_at"),
      books: this.array(raw.books, "catalog.books", 2000).map((book, i) =>
        this.book(book, `books.${i}`),
      ),
      bindings: this.array(raw.bindings, "catalog.bindings", 20000).map(
        (binding, i) => this.binding(binding, `bindings.${i}`),
      ),
      fx_versions: this.array(raw.fx_versions, "catalog.fx_versions", 512).map(
        (version, i) => this.fxVersion(version, `fx_versions.${i}`),
      ),
    };
    if (raw.admission_policies !== undefined) {
      doc.admission_policies = this.array(
        raw.admission_policies,
        "catalog.admission_policies",
        1000,
      ).map((entry, index) => {
        const path = `catalog.admission_policies.${index}`;
        const item = this.object(entry, path, [
          "workspace_id",
          "operation",
          "policy",
        ]);
        const policy: CatalogAdmissionPolicy = {
          workspace_id:
            item.workspace_id === null
              ? null
              : this.string(item.workspace_id, `${path}.workspace_id`),
          policy: parseAdmissionPolicy(item.policy, this, `${path}.policy`),
        };
        if (item.operation !== undefined) {
          policy.operation = this.string(item.operation, `${path}.operation`);
          if (
            !(PRICING_ADMISSION_OPERATIONS as readonly string[]).includes(
              policy.operation,
            )
          )
            this.invalid(
              `${path}.operation`,
              "Operation is not integrated with pricing admission",
            );
        }
        if (policy.policy.token_budget === "not_applicable" && !NON_TOKEN_BUDGET_OPERATIONS.includes(policy.operation ?? ""))
          this.invalid(`${path}.policy.token_budget`, "Non-token quota requires an explicitly supported media operation");
        return policy;
      });
      if (
        new Set(
          doc.admission_policies.map((entry) =>
            JSON.stringify([entry.workspace_id, entry.operation ?? null]),
          ),
        ).size !== doc.admission_policies.length
      )
        this.invalid(
          "catalog.admission_policies",
          "Only one policy per workspace/operation scope is allowed",
        );
    }
    if (this.diagnostics.length) return doc;
    const versions = new Map(
      doc.books.map((book) => [
        versionKey(book.book_id, book.version_id),
        book,
      ]),
    );
    const owners = new Map<string, string | null>();
    for (const book of doc.books) {
      if (
        owners.has(book.book_id) &&
        owners.get(book.book_id) !== book.workspace_id
      )
        this.invalid(
          "books.workspace_id",
          "All versions of a book must have the same owner",
          "pricing_permission_denied",
        );
      owners.set(book.book_id, book.workspace_id);
    }
    if (versions.size !== doc.books.length)
      this.invalid("books", "Book versions must be unique");
    if (
      new Set(doc.bindings.map((binding) => binding.id)).size !==
      doc.bindings.length
    )
      this.invalid("bindings", "Binding activation IDs must be unique");
    if (
      new Set(doc.fx_versions.map((version) => version.fx.version_id)).size !==
      doc.fx_versions.length
    )
      this.invalid("fx_versions", "FX activation versions must be unique");
    const grouped = new Map<string, PricingBinding[]>();
    for (const binding of doc.bindings) {
      const book = versions.get(
        versionKey(binding.book_id, binding.version_id),
      );
      if (!book) {
        this.invalid("bindings", "Binding references an absent book version");
        continue;
      }
      if (
        book.workspace_id !== null &&
        book.workspace_id !== binding.workspace_id
      )
        this.invalid(
          "bindings",
          "A binding cannot reference another workspace's price book",
          "pricing_permission_denied",
        );
      const kind = book.content.source.kind;
      if (kind === "reference")
        this.invalid(
          "bindings",
          "Unapproved reference prices cannot be activated",
        );
      if (binding.level === "legacy" && kind !== "legacy")
        this.invalid("bindings", "Legacy bindings require legacy provenance");
      if (kind === "legacy" && binding.level !== "legacy")
        this.invalid(
          "bindings",
          "Legacy estimates cannot masquerade as approved manual prices",
        );
      if (binding.level === "catalog" && kind !== "approved_catalog")
        this.invalid(
          "bindings",
          "Catalog fallback requires approved catalog provenance",
        );
      const key = JSON.stringify([
        binding.workspace_id,
        binding.level,
        binding.model,
        binding.node_id ?? null,
        binding.operation ?? null,
      ]);
      const peers = grouped.get(key) ?? [];
      if (
        peers.some((peer) =>
          intervalsOverlap(
            peer.effective_from,
            peer.effective_to,
            binding.effective_from,
            binding.effective_to,
          ),
        )
      )
        this.invalid(
          "bindings",
          "Equivalent bindings have overlapping effective intervals",
          "pricing_rule_conflict",
        );
      peers.push(binding);
      grouped.set(key, peers);
    }
    const fxGroups = new Map<string, CatalogFxVersion[]>();
    for (const version of doc.fx_versions) {
      const key = JSON.stringify([
        version.workspace_id,
        version.fx.from_currency,
        version.fx.to_currency,
      ]);
      const peers = fxGroups.get(key) ?? [];
      if (
        peers.some((peer) =>
          intervalsOverlap(
            peer.fx.effective_at,
            peer.effective_to,
            version.fx.effective_at,
            version.effective_to,
          ),
        )
      )
        this.invalid(
          "fx_versions",
          "FX activation intervals overlap",
          "pricing_rule_conflict",
        );
      peers.push(version);
      fxGroups.set(key, peers);
    }
    return doc;
  }

  private book(value: unknown, path: string): CatalogBookVersion {
    const raw = this.object(value, path, [
      "book_id",
      "version_id",
      "workspace_id",
      "content_hash",
      "content",
    ]);
    const identity = {
      book_id: this.string(raw.book_id, `${path}.book_id`),
      version_id: this.string(raw.version_id, `${path}.version_id`),
    };
    const owner = this.workspace(raw.workspace_id, `${path}.workspace_id`);
    const expectedHash = this.string(raw.content_hash, `${path}.content_hash`);
    let content: CatalogBookVersion["content"];
    try {
      const compiled = compilePriceBook(raw.content, identity);
      content = compiled.document();
      if (expectedHash !== compiled.contentHash)
        this.invalid(
          `${path}.content_hash`,
          "Book content does not match the published hash",
          "pricing_version_conflict",
        );
    } catch (error) {
      if (error instanceof PricingCompileError)
        this.diagnostics.push(
          ...error.diagnostics.map((item) => ({
            ...item,
            path: `${path}.${item.path}`,
          })),
        );
      else this.invalid(path, (error as Error).message);
      // Invalid results are never constructed as a compiled catalog.
      content = raw.content as CatalogBookVersion["content"];
    }
    return {
      ...identity,
      workspace_id: owner,
      content_hash: expectedHash,
      content,
    };
  }

  private binding(value: unknown, path: string): PricingBinding {
    const raw = this.object(value, path, [
      "id",
      "workspace_id",
      "level",
      "model",
      "node_id",
      "operation",
      "book_id",
      "version_id",
      "effective_from",
      "effective_to",
    ]);
    const level = this.string(
      raw.level,
      `${path}.level`,
    ) as PricingBindingLevel;
    if (!Object.prototype.hasOwnProperty.call(LEVEL_RANK, level))
      this.invalid(`${path}.level`, "Unknown price binding level");
    const binding: PricingBinding = {
      id: this.string(raw.id, `${path}.id`),
      workspace_id: this.workspace(raw.workspace_id, `${path}.workspace_id`),
      level,
      model: this.string(raw.model, `${path}.model`, 256),
      book_id: this.string(raw.book_id, `${path}.book_id`),
      version_id: this.string(raw.version_id, `${path}.version_id`),
      effective_from: this.instant(
        raw.effective_from,
        `${path}.effective_from`,
      ),
    };
    if (raw.node_id !== undefined)
      binding.node_id = this.string(raw.node_id, `${path}.node_id`);
    if (raw.operation !== undefined)
      binding.operation = this.string(raw.operation, `${path}.operation`);
    if (level === "node" && !binding.node_id)
      this.invalid(path, "Node bindings require a node ID");
    if (level !== "node" && binding.node_id !== undefined)
      this.invalid(path, "Only node-level bindings have a node ID");
    if (raw.effective_to !== undefined)
      binding.effective_to = this.instant(
        raw.effective_to,
        `${path}.effective_to`,
      );
    this.interval(binding.effective_from, binding.effective_to, path);
    return binding;
  }

  private fxVersion(value: unknown, path: string): CatalogFxVersion {
    const raw = this.object(value, path, [
      "workspace_id",
      "fx",
      "effective_to",
    ]);
    const rawFx = this.object(raw.fx, `${path}.fx`, [
      "version_id",
      "source",
      "effective_at",
      "from_currency",
      "to_currency",
      "numerator",
      "denominator",
    ]);
    const fx: FxSnapshot = {
      version_id: this.string(rawFx.version_id, `${path}.fx.version_id`),
      source: this.string(rawFx.source, `${path}.fx.source`, 2048),
      effective_at: this.instant(rawFx.effective_at, `${path}.fx.effective_at`),
      from_currency: this.string(
        rawFx.from_currency,
        `${path}.fx.from_currency`,
      ),
      to_currency: this.string(rawFx.to_currency, `${path}.fx.to_currency`),
      numerator: this.decimal(rawFx.numerator, `${path}.fx.numerator`, true),
      denominator: this.decimal(
        rawFx.denominator,
        `${path}.fx.denominator`,
        true,
      ),
    };
    if (
      !/^[A-Z]{3}$/.test(fx.from_currency) ||
      !/^[A-Z]{3}$/.test(fx.to_currency) ||
      fx.from_currency === fx.to_currency
    )
      this.invalid(path, "FX needs two distinct uppercase currencies");
    const version: CatalogFxVersion = {
      workspace_id: this.workspace(raw.workspace_id, `${path}.workspace_id`),
      fx,
    };
    if (raw.effective_to !== undefined)
      version.effective_to = this.instant(
        raw.effective_to,
        `${path}.effective_to`,
      );
    this.interval(fx.effective_at, version.effective_to, path);
    return version;
  }

  private workspace(value: unknown, path: string): string | null {
    return value === null ? null : this.string(value, path);
  }

  private instant(value: unknown, path: string): string {
    const text = this.string(value, path);
    try {
      return new Date(parsePricingInstant(text)).toISOString();
    } catch (error) {
      this.invalid(path, (error as Error).message);
      return text;
    }
  }

  private interval(from: string, to: string | undefined, path: string): void {
    if (!to) return;
    try {
      if (parsePricingInstant(to) <= parsePricingInstant(from))
        this.invalid(path, "Effective interval must be positive");
    } catch {
      /* The timestamp reader already reported invalid timestamps. */
    }
  }
}

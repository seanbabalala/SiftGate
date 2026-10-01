import { createPostgresReadProgram, withPostgresReadPrelude, type PostgresTransactionReadPrelude } from "./postgres-read-program";
import { tryInsertPricingSnapshot } from "./postgres-snapshot-writer";
import { recordPricingBypass } from "./pricing-bypass";
import { initializeBookOwner, readBookManagement, updateBookOwner, validateBookOwnerUpdate } from "./pricing-book-management";
import type { PricingBookManagement, PricingBookOwnerUpdate } from "./pricing-book-management.types";
import type { ModelPricingTarget, ModelPricingStatusPage, ModelPricingStatus, ModelPriceVersion } from "./model-pricing-status.types";
import { modelPriceVersion } from "./model-price-version";
import { NON_TOKEN_BUDGET_OPERATIONS, type PricingAdmissionPolicy } from "./pricing-admission.types";
import type { PricingInheritanceView } from "./pricing-inheritance.types";
import {
  resolveScopedInheritance,
  readDraftInheritance,
  readVersionInheritance,
  storeDraftInheritance,
  storeVersionInheritance,
  deletePublishedDraftInheritance,
  verifyCatalogInheritance,
} from "./pricing-inheritance-storage";
import { assessPricingAdmission } from "./pricing-admission";
import {
  parseAdmissionPolicy,
  PRICING_ADMISSION_OPERATIONS,
  ACTUAL_UPSTREAM_BUDGET_OPERATIONS,
} from "./pricing-admission-policy";
import { PricingSchemaReader } from "./pricing-schema-reader";
import type { NormalizedUsage, PricingContext } from "./pricing.types";
import type { PricingTarget } from "./pricing-catalog.types";
import { Injectable, Optional } from "@nestjs/common";
import { ConfigService } from "../config/config.service";
import { resolvePricingLimits } from "../config/pricing-limits";
import { assertPriceBookRuleCapacity, assertPublishedRuleCapacity } from "./pricing-resource-limits";
import { assessPricingMetering } from "./pricing-metering";
import { PUBLICATION_FX_STATUSES, reviewPublicationFx } from './publication-fx-review';
import { publicationTimeBasisReview, parseTimeBasisConfirmation, confirmPublicationTimeBasis } from './publication-time-basis';
import { DataSource, EntityManager } from "typeorm";
import { serializeDatabaseAccess } from "../database/database-serialization";
import { randomUUID } from "node:crypto";
import { replayBudget } from "./pricing-replay-budget";
import { CompiledPriceBook, compilePriceBook } from "./pricing-compiler";
import { CompiledPricingCalendar } from "./pricing-calendar";
import {
  CompiledPricingCatalog,
  FrozenPricingRequest,
} from "./pricing-catalog";
import { pricingContentHash } from "./pricing-json";
import { parsePricingInstant } from "./pricing-time";
import { PricingAdmissionClockWait, readPricingAdmissionTime } from "./pricing-admission-clock";
import {
  planPricingSchema,
  pricingMigrationMarkersReady,
} from "./pricing-schema";
import type {
  CatalogBookVersion,
  CatalogFxVersion,
  PricingBinding,
  PricingCatalogDocument,
  PricingRequestSnapshot,
} from "./pricing-catalog.types";
import type { PriceBookContent } from "./pricing.types";
import {
  PricingActor,
  PricingBookRow,
  PricingDraft,
  PricingDraftRow,
  PricingHead,
  PricingPublishOptions,
  PricingRepositoryError,
  PricingVersionRow,
  PricingFxUpdate,
  PricingAdmissionPolicyUpdate,
} from "./pricing-repository.types";

interface CatalogRow {
  id: string;
  content_hash: string;
  manifest_json: string;
  published_at: string;
}
interface CatalogManifest extends Omit<PricingCatalogDocument, "books"> {
  books: Array<Omit<CatalogBookVersion, "content">>;
}
interface SnapshotRow {
  request_id: string;
  workspace_id: string;
  catalog_revision_id: string;
  snapshot_hash: string;
  descriptor_json: string;
  created_at: string;
}

@Injectable()
export class PricingRepository {
  private ready = false;
  private readonly catalogs = new Map<string, CompiledPricingCatalog>();

  constructor(private readonly dataSource: DataSource, @Optional() private readonly config?: ConfigService) {}

  async status() {
    return {
      ...await planPricingSchema(this.dataSource),
      limits: { ...this.resourceLimits(), request_size_basis: 'parsed_json_utf8' as const },
    };
  }

  private resourceLimits() { return resolvePricingLimits(this.config?.pricingLimits); }

  /** Bounded read-only catalog inspection; never creates request snapshots or quotes fees. */
  async modelPricingStatus(actor: PricingActor, targets: ModelPricingTarget[]): Promise<ModelPricingStatusPage> {
    this.actor(actor);
    if (!Array.isArray(targets) || targets.length < 1 || targets.length > 20) this.bad("Inspect 1–20 distinct model/operation targets");
    const references = targets.map(target => {
      if (!target || typeof target !== "object" || Array.isArray(target) || Object.keys(target).some(key => !["node_id", "model", "operation"].includes(key))) this.bad("Invalid model pricing target");
      this.text(target.node_id, "node_id", 128); this.text(target.model, "model", 256);
      if (!(PRICING_ADMISSION_OPERATIONS as readonly string[]).includes(target.operation)) this.bad("Unsupported operation");
      const node = this.config?.nodes.find(node => node.id === target.node_id);
      if (this.config && !node) this.notFound();
      if (node) {
        const models = new Set([...node.models, ...node.embedding_models ?? [], ...node.rerank_models ?? [], ...node.image_models ?? [], ...node.audio_models ?? [], ...node.video_models ?? [], ...node.realtime_models ?? [], ...Object.keys(node.model_capabilities ?? {}), ...Object.values(node.model_aliases ?? {})]);
        if (!models.has(target.model)) this.notFound();
      }
      const price = this.config?.getModelPricing(target.model, target.node_id);
      const source = node?.model_capabilities?.[target.model]?.pricing ? "node_model_config" : this.config?.modelsPricing[target.model] ? "gateway_config" : "catalog";
      return price ? { source, currency: /^[A-Z]{3}$/.test(price.currency ?? "USD") ? price.currency ?? "USD" : null, review_required: true } as NonNullable<ModelPricingStatus["legacy_reference"]> : null;
    });
    if (new Set(targets.map(target => JSON.stringify([target.node_id, target.model, target.operation]))).size !== targets.length) this.bad("Inspect distinct model/operation targets");
    return this.serialize(async () => {
      const evaluated_at = new Date().toISOString();
      const runner = this.dataSource.createQueryRunner(); let available: boolean;
      try { available = await runner.hasTable("pricing_schema_versions"); } finally { await runner.release(); }
      if (available) await this.ensureReady();
      const manager = this.dataSource.manager, head = available ? await this.head(manager) : null;
      const catalog = head?.catalog_revision_id ? await this.loadCatalog(manager, head.catalog_revision_id) : null;
      const views = new Map<string, Omit<ModelPriceVersion, "binding">>();
      const version = async (binding: PricingBinding | null): Promise<ModelPriceVersion | null> => {
        if (!binding) return null;
        const key = JSON.stringify([binding.book_id, binding.version_id]);
        let view = views.get(key);
        if (!view) {
          const book = await this.book(manager, actor, binding.book_id), stored = await this.version(manager, binding.book_id, binding.version_id);
          const inheritance = await readVersionInheritance(manager, stored, book.workspace_id);
          const { binding: _binding, ...summary } = modelPriceVersion(binding, book.name, stored.content_hash, JSON.parse(stored.content_json) as PriceBookContent, inheritance);
          view = summary; views.set(key, view);
        }
        return { ...view, binding };
      };
      const rows: ModelPricingStatus[] = [];
      for (const [index, target] of targets.entries()) {
        const selected = catalog?.inspectBindings(actor.workspace_id, target, evaluated_at);
        const policy = catalog?.admissionPolicy(actor.workspace_id, target.operation);
        const scheduled: ModelPricingStatus["scheduled"] = [];
        for (const change of selected?.scheduled ?? []) scheduled.push({ effective_at: change.effective_at, price: await version(change.binding) });
        rows.push({ target: { ...target }, current: await version(selected?.current ?? null), scheduled, schedule_truncated: selected?.truncated ?? false,
          policy: { mode: policy?.mode ?? "compatibility", budget_basis: policy?.budget_basis === "actual_upstream" ? "actual_upstream" : "legacy_logical" }, legacy_reference: references[index] });
      }
      const page: ModelPricingStatusPage = { workspace_id: actor.workspace_id, evaluated_at, schema_available: available, read_only: true, supplier_support_verified: false, head, rows };
      if (Buffer.byteLength(JSON.stringify(page)) > 1024 * 1024) this.bad("Model pricing status exceeds the response limit");
      return page;
    });
  }

  async listBooks(actor: PricingActor, limit = 100, offset = 0) {
    this.actor(actor);
    this.pagination(limit, offset);
    return this.read(async (manager) => {
      const books = await manager
        .createQueryBuilder()
        .select("b.*")
        .from("pricing_books", "b")
        .where("(b.workspace_id = :workspace OR b.workspace_id IS NULL)", {
          workspace: actor.workspace_id,
        })
        .orderBy("b.updated_at", "DESC")
        .addOrderBy("b.id", "ASC")
        .limit(limit)
        .offset(offset)
        .getRawMany<PricingBookRow>();
      return { books, head: await this.head(manager), limit, offset };
    });
  }

  async getBook(actor: PricingActor, id: string) {
    this.actor(actor);
    return this.read(async (manager) => {
      const book = await this.book(manager, actor, id);
      const drafts = await manager
        .createQueryBuilder()
        .select("d.*")
        .from("pricing_drafts", "d")
        .where("d.book_id = :id", { id })
        .orderBy("d.updated_at", "DESC")
        .limit(100)
        .getRawMany<PricingDraftRow>();
      const versions = await manager
        .createQueryBuilder()
        .select("v.book_id", "book_id")
        .addSelect("v.version_id", "version_id")
        .addSelect("v.content_hash", "content_hash")
        .addSelect("v.published_by", "published_by")
        .addSelect("v.published_at", "published_at")
        .addSelect("v.reason", "reason")
        .from("pricing_book_versions", "v")
        .where("v.book_id = :id", { id })
        .orderBy("published_at", "DESC")
        .addOrderBy("version_id", "DESC")
        .limit(100)
        .getRawMany<Omit<PricingVersionRow, "content_json">>();
      const head = await this.head(manager);
      const catalog = head.catalog_revision_id
        ? await this.loadCatalog(manager, head.catalog_revision_id)
        : null;
      const bindings =
        catalog
          ?.document()
          .bindings.filter(
            (binding) =>
              binding.book_id === id &&
              (binding.workspace_id === null ||
                binding.workspace_id === actor.workspace_id),
          ) ?? [];
      const hydratedDrafts: PricingDraft[] = [];
      for (const draft of drafts)
        hydratedDrafts.push(await this.hydrateDraft(manager, draft, book));
      return {
        book,
        drafts: hydratedDrafts,
        versions,
        bindings,
        head,
      };
    });
  }

  async getBookManagement(actor: PricingActor, id: string): Promise<PricingBookManagement> {
    this.actor(actor);
    return this.serialize(async () => {
      await this.ensureReady();
      return this.dataSource.transaction(this.dataSource.options.type === "postgres" ? "REPEATABLE READ" : "SERIALIZABLE", async manager => {
        const book = await this.book(manager, actor, id), head = await this.head(manager);
        const now = new Date().toISOString();
        const catalog = head.catalog_revision_id ? await this.loadCatalog(manager, head.catalog_revision_id) : null;
        const bindings = (catalog?.document().bindings ?? []).filter(binding => binding.workspace_id === null || binding.workspace_id === actor.workspace_id);
        return readBookManagement(manager, book, bindings, head.revision, now);
      });
    });
  }

  async updateBookOwner(actor: PricingActor, id: string, input: PricingBookOwnerUpdate) {
    this.admin(actor);
    validateBookOwnerUpdate(input);
    return this.write(async manager => {
      const book = await this.book(manager, actor, id, true);
      const change = await updateBookOwner(manager, actor, book, input);
      if (change.changed) await this.audit(manager, actor, book.workspace_id, id, "book.owner_changed", input.reason, {
        previous_owner: change.before.owner, owner: change.after.owner, previous_revision: change.before.revision, revision: change.after.revision,
      });
      return change.after;
    });
  }

  async createBook(
    actor: PricingActor,
    input: { name: string; scope: "workspace" | "global"; content: unknown },
  ) {
    this.admin(actor);
    this.text(input.name, "name", 128);
    const workspace = this.scope(actor, input.scope);
    const bookId = randomUUID();
    const draftId = randomUUID();
    const content = this.validateContent(
      input.content,
      bookId,
      draftId,
    ).document();
    return this.write(async (manager) => {
      const now = new Date().toISOString();
      const book: PricingBookRow = {
        id: bookId,
        workspace_id: workspace,
        name: input.name,
        created_by: actor.id,
        created_at: now,
        updated_at: now,
      };
      const draft: PricingDraftRow = {
        id: draftId,
        book_id: bookId,
        revision: 1,
        content_json: JSON.stringify(content),
        created_by: actor.id,
        created_at: now,
        updated_at: now,
      };
      await manager
        .createQueryBuilder()
        .insert()
        .into("pricing_books")
        .values(book)
        .execute();
      await initializeBookOwner(manager, book, actor);
      await manager
        .createQueryBuilder()
        .insert()
        .into("pricing_drafts")
        .values(draft)
        .execute();
      await this.audit(
        manager,
        actor,
        workspace,
        bookId,
        "book.created",
        "Create price book",
        {
          draft_id: draftId,
          owner: actor.id,
          content_hash: pricingContentHash(content),
        },
      );
      return {
        book,
        draft: this.decodeDraft(draft),
        head: await this.head(manager),
      };
    });
  }

  async forkDraft(actor: PricingActor, bookId: string, versionId: string) {
    this.admin(actor);
    return this.write(async (manager) => {
      const book = await this.book(manager, actor, bookId, true);
      const version = await this.version(manager, bookId, versionId);
      const inheritance = await readVersionInheritance(
        manager,
        version,
        book.workspace_id,
      );
      const draft: PricingDraftRow = {
        id: randomUUID(),
        book_id: bookId,
        revision: 1,
        content_json: version.content_json,
        created_by: actor.id,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await manager
        .createQueryBuilder()
        .insert()
        .into("pricing_drafts")
        .values(draft)
        .execute();
      if (inheritance)
        await storeDraftInheritance(manager, book, draft, actor, inheritance);
      await this.audit(
        manager,
        actor,
        book.workspace_id,
        bookId,
        "draft.created",
        "Fork immutable price version",
        { version_id: versionId, draft_id: draft.id, content_hash: version.content_hash },
      );
      return this.hydrateDraft(manager, draft, book);
    });
  }

  async getDraft(actor: PricingActor, draftId: string): Promise<PricingDraft> {
    this.actor(actor);
    return this.read(async (manager) => {
      const { draft, book } = await this.draft(manager, actor, draftId);
      return this.hydrateDraft(manager, draft, book);
    });
  }

  async updateDraft(
    actor: PricingActor,
    draftId: string,
    revision: number,
    input: unknown,
  ): Promise<PricingDraft> {
    this.admin(actor);
    this.revision(revision);
    const content = this.validateContent(
      input,
      "draft-validation",
      draftId,
    ).document();
    return this.write(async (manager) => {
      const { draft, book } = await this.draft(manager, actor, draftId, true);
      if (await readDraftInheritance(manager, draft, book))
        this.conflict(
          "This draft inherits an immutable parent; update its explicit recipe rather than replacing the materialized content",
        );
      const updatedAt = new Date().toISOString();
      const result = await manager
        .createQueryBuilder()
        .update("pricing_drafts")
        .set({
          content_json: JSON.stringify(content),
          revision: revision + 1,
          updated_at: updatedAt,
        })
        .where("id = :id AND revision = :revision", { id: draftId, revision })
        .execute();
      if (result.affected !== 1)
        this.conflict("Draft changed; reload before saving");
      await this.audit(
        manager,
        actor,
        book.workspace_id,
        book.id,
        "draft.updated",
        "Update price draft",
        {
          draft_id: draftId,
          revision: revision + 1,
          content_hash: pricingContentHash(content),
        },
      );
      return {
        ...this.decodeDraft(draft),
        content,
        revision: revision + 1,
        updated_at: updatedAt,
      };
    });
  }

  async getVersion(actor: PricingActor, bookId: string, versionId: string) {
    this.actor(actor);
    return this.read(async (manager) => {
      const book = await this.book(manager, actor, bookId);
      const version = await this.version(manager, bookId, versionId);
      const inheritance = await readVersionInheritance(
        manager,
        version,
        book.workspace_id,
      );
      const { content_json, ...metadata } = version;
      return {
        ...metadata,
        content: JSON.parse(content_json) as PriceBookContent,
        ...(inheritance ? { inheritance } : {}),
      };
    });
  }

  /** Replay owns a bounded, consistent read transaction; never open a nested read here. */
  async replayContent(manager: EntityManager, actor: PricingActor, input: { draftId?: string; bookId?: string; versionId?: string; content?: unknown }): Promise<unknown> {
    this.actor(actor);
    if (manager.connection !== this.dataSource || !manager.queryRunner?.isTransactionActive)
      this.conflict("Replay content requires an owned read snapshot");
    if (input.draftId) {
      const { draft, book } = await this.draft(manager, actor, input.draftId);
      return (await this.hydrateDraft(manager, draft, book)).content;
    }
    if (input.bookId && input.versionId) {
      const book = await this.book(manager, actor, input.bookId);
      const version = await this.version(manager, input.bookId, input.versionId);
      await readVersionInheritance(manager, version, book.workspace_id);
      return JSON.parse(version.content_json) as unknown;
    }
    return input.content;
  }

  compileReplayContent(content: unknown, bookId = "simulation", versionId = "replay") {
    return this.validateContent(content, bookId, versionId);
  }

  async publishDraft(
    actor: PricingActor,
    draftId: string,
    options: PricingPublishOptions,
  ) {
    this.admin(actor);
    this.publishOptions(options);
    return this.write(async (manager) => {
      const { draft, book } = await this.draft(manager, actor, draftId, true);
      if (draft.revision !== options.draft_revision)
        this.conflict("Draft changed before publication");
      const inheritance = await readDraftInheritance(manager, draft, book);
      assertPriceBookRuleCapacity(JSON.parse(draft.content_json), this.resourceLimits().max_published_rules);
      const compiled = this.validateContent(
        JSON.parse(draft.content_json),
        book.id,
        randomUUID(),
      );
      return this.publish(
        manager,
        actor,
        book,
        compiled.document(),
        options,
        draftId,
        draft.revision,
        undefined,
        inheritance ?? undefined,
      );
    });
  }

  async previewPublish(
    actor: PricingActor,
    draftId: string,
    options: PricingPublishOptions,
  ) {
    this.admin(actor);
    this.publishOptions(options);
    return this.read(async (manager) => {
      const { draft, book } = await this.draft(manager, actor, draftId, true);
      if (draft.revision !== options.draft_revision)
        this.conflict("Draft changed before preview");
      const inheritance = await readDraftInheritance(manager, draft, book);
      const head = await this.head(manager);
      if (head.revision !== options.catalog_revision)
        this.conflict("Catalog changed before preview");
      const plan = await this.preparePublication(
        manager,
        actor,
        book,
        JSON.parse(draft.content_json) as PriceBookContent,
        options,
        head,
      );
      return {
        head,
        version_id: plan.version.version_id,
        content_hash: plan.version.content_hash,
        bindings: plan.added,
        replaced_binding_ids: plan.replaced,
        warnings: this.coverageWarnings(plan.version.content),
        fx_review: plan.fxReview,
        time_basis_review: plan.timeReview,
        metering: this.meteringReview(plan.version.content, options.targets),
        dry_run: true,
        ...(inheritance ? { inheritance } : {}),
      };
    });
  }

  async previewRollback(
    actor: PricingActor,
    bookId: string,
    versionId: string,
    options: Omit<PricingPublishOptions, "draft_revision">,
  ) {
    this.admin(actor);
    const publication = { ...options, draft_revision: 0 };
    this.publishOptions(publication);
    return this.read(async (manager) => {
      const book = await this.book(manager, actor, bookId, true);
      const version = await this.version(manager, bookId, versionId);
      const inheritance = await readVersionInheritance(
        manager,
        version,
        book.workspace_id,
      );
      const head = await this.head(manager);
      if (head.revision !== options.catalog_revision)
        this.conflict("Catalog changed before rollback preview");
      const plan = await this.preparePublication(
        manager,
        actor,
        book,
        JSON.parse(version.content_json) as PriceBookContent,
        publication,
        head,
      );
      return {
        head,
        version_id: plan.version.version_id,
        content_hash: plan.version.content_hash,
        bindings: plan.added,
        replaced_binding_ids: plan.replaced,
        warnings: this.coverageWarnings(plan.version.content),
        fx_review: plan.fxReview,
        time_basis_review: plan.timeReview,
        metering: this.meteringReview(plan.version.content, options.targets),
        dry_run: true,
        ...(inheritance ? { inheritance } : {}),
      };
    });
  }

  async rollback(
    actor: PricingActor,
    bookId: string,
    versionId: string,
    options: PricingPublishOptions,
  ) {
    this.admin(actor);
    this.publishOptions(options);
    return this.write(async (manager) => {
      const book = await this.book(manager, actor, bookId, true);
      const old = await this.version(manager, bookId, versionId);
      const inheritance = await readVersionInheritance(
        manager,
        old,
        book.workspace_id,
      );
      return this.publish(
        manager,
        actor,
        book,
        JSON.parse(old.content_json) as PriceBookContent,
        options,
        undefined,
        undefined,
        versionId,
        inheritance ?? undefined,
      );
    });
  }

  async cancelScheduled(
    actor: PricingActor,
    bindingId: string,
    revision: number,
    reason: string,
  ) {
    this.admin(actor);
    this.revision(revision);
    this.text(reason, "reason", 1000);
    return this.write(async (manager) => {
      const head = await this.lockHead(manager, revision);
      if (!head.catalog_revision_id) this.notFound();
      const current = (
        await this.loadCatalog(manager, head.catalog_revision_id!)
      ).document();
      const binding = current.bindings.find((entry) => entry.id === bindingId);
      if (!binding) this.notFound();
      await this.book(manager, actor, binding!.book_id, true);
      this.owned(actor, binding!.workspace_id, true);
      if (parsePricingInstant(binding!.effective_from) <= Date.now())
        this.conflict(
          "Only a future activation can be cancelled; use a new publication to change active pricing",
        );
      const previous = current.bindings.find(
        (entry) =>
          sameTarget(entry, binding!) &&
          entry.effective_to === binding!.effective_from,
      );
      current.bindings = current.bindings.filter(
        (entry) => entry.id !== bindingId,
      );
      if (previous) {
        if (binding!.effective_to)
          previous.effective_to = binding!.effective_to;
        else delete previous.effective_to;
      }
      const catalog = await this.saveCatalog(
        manager,
        actor,
        head,
        current,
        reason,
      );
      await this.audit(
        manager,
        actor,
        binding!.workspace_id,
        binding!.book_id,
        "activation.cancelled",
        reason,
        { binding_id: bindingId, catalog_revision_id: catalog.revisionId },
      );
      return {
        head: {
          ...head,
          revision: revision + 1,
          catalog_revision_id: catalog.revisionId,
        },
      };
    });
  }

  async listBindings(actor: PricingActor) {
    this.actor(actor);
    return this.read(async (manager) => {
      const head = await this.head(manager);
      const doc = head.catalog_revision_id
        ? (await this.loadCatalog(manager, head.catalog_revision_id)).document()
        : null;
      return {
        head,
        bindings:
          doc?.bindings.filter(
            (entry) =>
              entry.workspace_id === null ||
              entry.workspace_id === actor.workspace_id,
          ) ?? [],
        fx_versions:
          doc?.fx_versions.filter(
            (entry) =>
              entry.workspace_id === null ||
              entry.workspace_id === actor.workspace_id,
          ) ?? [],
      };
    });
  }

  async listAdmissionPolicies(actor: PricingActor) {
    this.actor(actor);
    return this.read(async (manager) => {
      const head = await this.head(manager);
      const catalog = head.catalog_revision_id
        ? await this.loadCatalog(manager, head.catalog_revision_id)
        : null;
      return {
        head,
        default_policy: { mode: "compatibility" },
        policies: (catalog?.document().admission_policies ?? []).filter(
          (entry) =>
            entry.workspace_id === null ||
            entry.workspace_id === actor.workspace_id,
        ),
      };
    });
  }

  private admissionPolicyChange(
    actor: PricingActor,
    input: PricingAdmissionPolicyUpdate,
  ) {
    this.admin(actor);
    this.revision(input.catalog_revision);
    this.text(input.reason, "reason", 1000);
    if (input.confirm !== true)
      this.bad(
        "Explicit confirmation is required for pricing admission changes",
      );
    const workspace = this.scope(actor, input.scope);
    if (
      input.operation !== undefined &&
      !(PRICING_ADMISSION_OPERATIONS as readonly string[]).includes(
        input.operation,
      )
    )
      this.bad("Operation is not integrated with pricing admission");
    const reader = new PricingSchemaReader();
    const policy =
      input.policy === null ? null : parseAdmissionPolicy(input.policy, reader);
    if (policy?.budget_basis === "actual_upstream" && (!input.operation || !ACTUAL_UPSTREAM_BUDGET_OPERATIONS.includes(input.operation)))
      reader.invalid("policy.budget_basis", "Actual-upstream budget integration currently requires an explicitly supported operation; other lifecycles are not yet activated");
    if (policy?.token_budget === "not_applicable" && !NON_TOKEN_BUDGET_OPERATIONS.includes(input.operation ?? ""))
      reader.invalid("policy.token_budget", "Non-token quota requires an explicitly supported media operation");
    if (policy?.realtime_transcription && input.operation !== "realtime")
      reader.invalid("policy.realtime_transcription", "A transcription allowance requires an explicit Realtime operation policy");
    if (reader.diagnostics.length)
      this.bad(
        "Invalid pricing admission policy: " +
          reader.diagnostics
            .map((entry) => `${entry.path}: ${entry.message}`)
            .join("; "),
      );
    return { workspace, policy };
  }

  async previewAdmissionPolicy(
    actor: PricingActor,
    input: PricingAdmissionPolicyUpdate,
  ) {
    const { workspace, policy } = this.admissionPolicyChange(actor, input);
    return this.read(async (manager) => {
      const head = await this.head(manager);
      if (head.revision !== input.catalog_revision)
        this.conflict("Catalog changed before policy preview");
      const current = head.catalog_revision_id
        ? (await this.loadCatalog(manager, head.catalog_revision_id)).document()
        : this.emptyCatalog();
      const before =
        current.admission_policies?.find(
          (entry) =>
            entry.workspace_id === workspace &&
            entry.operation === input.operation,
        )?.policy ?? null;
      current.admission_policies = (current.admission_policies ?? []).filter(
        (entry) =>
          entry.workspace_id !== workspace ||
          entry.operation !== input.operation,
      );
      if (policy)
        current.admission_policies.push({
          workspace_id: workspace,
          operation: input.operation,
          policy,
        });
      CompiledPricingCatalog.compile(current);
      return {
        dry_run: true as const,
        head,
        scope: input.scope,
        operation: input.operation ?? null,
        before,
        after: policy,
      };
    });
  }

  async updateAdmissionPolicy(
    actor: PricingActor,
    input: PricingAdmissionPolicyUpdate,
  ) {
    const { workspace, policy } = this.admissionPolicyChange(actor, input);
    return this.write(async (manager) => {
      const head = await this.lockHead(manager, input.catalog_revision);
      const current = head.catalog_revision_id
        ? (await this.loadCatalog(manager, head.catalog_revision_id)).document()
        : this.emptyCatalog();
      current.admission_policies = (current.admission_policies ?? []).filter(
        (entry) =>
          entry.workspace_id !== workspace ||
          entry.operation !== input.operation,
      );
      if (policy)
        current.admission_policies.push({
          workspace_id: workspace,
          ...(input.operation !== undefined
            ? { operation: input.operation }
            : {}),
          policy,
        });
      const catalog = await this.saveCatalog(
        manager,
        actor,
        head,
        current,
        input.reason,
      );
      await this.audit(
        manager,
        actor,
        workspace,
        null,
        "admission_policy.updated",
        input.reason,
        {
          catalog_revision_id: catalog.revisionId,
          operation: input.operation ?? null,
          policy_hash: policy ? pricingContentHash(policy) : null,
          mode: policy?.mode ?? "inherit",
        },
      );
      return {
        head: {
          ...head,
          revision: head.revision + 1,
          catalog_revision_id: catalog.revisionId,
        },
      };
    });
  }

  async previewAdmission(
    actor: PricingActor,
    target: PricingTarget,
    usage: NormalizedUsage,
    context: PricingContext,
    attempts: number,
    policyOverride?: PricingAdmissionPolicy,
  ) {
    this.actor(actor);
    return this.read(async (manager) => {
      const head = await this.head(manager);
      const catalog = head.catalog_revision_id
        ? await this.loadCatalog(manager, head.catalog_revision_id)
        : CompiledPricingCatalog.compile(this.emptyCatalog());
      const now = new Date().toISOString();
      const snapshot = catalog.capture({
        admitted_at: now,
        workspace_id: actor.workspace_id,
        report_currency: "USD",
      });
      return {
        simulation: true,
        workspace_id: actor.workspace_id,
        evaluated_at: now,
        target: { ...target },
        head,
        ...assessPricingAdmission(
          snapshot,
          target,
          usage,
          usage,
          { attempt_dispatched_at: now, ...context },
          attempts,
          policyOverride,
        ),
      };
    });
  }

  private fxChangeScope(actor: PricingActor, input: PricingFxUpdate) {
    this.admin(actor);
    this.revision(input.catalog_revision);
    this.text(input.reason, "reason", 1000);
    if (
      input.confirm !== true ||
      !Array.isArray(input.versions) ||
      input.versions.length > 128
    )
      this.bad(
        "Explicit confirmation and at most 128 FX versions are required",
      );
    const workspace = this.scope(actor, input.scope);
    return workspace;
  }

  async previewFx(actor: PricingActor, input: PricingFxUpdate) {
    const workspace = this.fxChangeScope(actor, input);
    return this.read(async (manager) => {
      const head = await this.head(manager);
      if (head.revision !== input.catalog_revision)
        this.conflict("Catalog changed before FX preview");
      const current = head.catalog_revision_id
        ? (await this.loadCatalog(manager, head.catalog_revision_id)).document()
        : this.emptyCatalog();
      const before = current.fx_versions.filter(
        (entry) => entry.workspace_id === workspace,
      );
      const after = input.versions.map((entry) => ({
        ...entry,
        workspace_id: workspace,
        fx: { ...entry.fx, version_id: randomUUID() },
      }));
      current.fx_versions = [
        ...current.fx_versions.filter(
          (entry) => entry.workspace_id !== workspace,
        ),
        ...after,
      ];
      CompiledPricingCatalog.compile(current);
      return {
        dry_run: true as const,
        head,
        scope: input.scope,
        before,
        after,
      };
    });
  }

  async updateFx(actor: PricingActor, input: PricingFxUpdate) {
    const workspace = this.fxChangeScope(actor, input);
    return this.write(async (manager) => {
      const head = await this.lockHead(manager, input.catalog_revision);
      const current = head.catalog_revision_id
        ? (await this.loadCatalog(manager, head.catalog_revision_id)).document()
        : this.emptyCatalog();
      const versions: CatalogFxVersion[] = input.versions.map((entry) => ({
        workspace_id: workspace,
        fx: { ...entry.fx, version_id: randomUUID() },
        ...(entry.effective_to ? { effective_to: entry.effective_to } : {}),
      }));
      current.fx_versions = [
        ...current.fx_versions.filter(
          (entry) => entry.workspace_id !== workspace,
        ),
        ...versions,
      ];
      const catalog = await this.saveCatalog(
        manager,
        actor,
        head,
        current,
        input.reason,
      );
      await this.audit(
        manager,
        actor,
        workspace,
        null,
        "fx.updated",
        input.reason,
        {
          catalog_revision_id: catalog.revisionId,
          version_ids: versions.map((entry) => entry.fx.version_id),
        },
      );
      return {
        head: {
          ...head,
          revision: head.revision + 1,
          catalog_revision_id: catalog.revisionId,
        },
      };
    });
  }

  async listAudit(
    actor: PricingActor,
    bookId?: string,
    limit = 50,
    offset = 0,
  ) {
    this.actor(actor);
    this.pagination(limit, offset);
    return this.read(async (manager) => {
      if (bookId) await this.book(manager, actor, bookId);
      const query = manager
        .createQueryBuilder()
        .select("e.*")
        .from("pricing_audit_events", "e")
        .where("(e.workspace_id = :workspace OR e.workspace_id IS NULL)", {
          workspace: actor.workspace_id,
        });
      if (bookId) query.andWhere("e.book_id = :book", { book: bookId });
      return query
        .orderBy("e.created_at", "DESC")
        .addOrderBy("e.id", "ASC")
        .limit(limit)
        .offset(offset)
        .getRawMany<Record<string, unknown>>();
    });
  }

  async capture(input: {
    request_id: string;
    workspace_id: string;
    report_currency: string;
  }): Promise<FrozenPricingRequest | null> {
    // No caller-owned mutable object survives the first asynchronous boundary.
    input = { request_id: input.request_id, workspace_id: input.workspace_id, report_currency: input.report_currency };
    this.text(input.request_id, "request_id", 128);
    this.text(input.workspace_id, "workspace_id", 128);
    let clockWait: PricingAdmissionClockWait | undefined;
    for (;;) {
      const result = await this.write<FrozenPricingRequest | null | number>(
        manager => this.captureInTransaction(manager, input),
        manager => {
          const [sql, parameters] = this.snapshotQuery(manager, input.request_id, input.workspace_id).getQueryAndParameters();
          const program = createPostgresReadProgram([{ sql, parameters }]);
          return program ? { program, apply: (owner, rows) => {
            if (rows[0].length > 1) this.corrupt();
            return this.captureInTransaction(owner, input, { row: rows[0][0] as unknown as SnapshotRow | undefined });
          } } : null;
        },
      );
      if (typeof result !== "number") return result;
      // Release the transaction AND SQLite serialization fence while waiting.
      // The retry rechecks idempotency and the current head under a new fence.
      clockWait ??= new PricingAdmissionClockWait();
      await clockWait.wait(result);
    }
  }

  private async captureInTransaction(
    manager: EntityManager,
    input: Parameters<PricingRepository["capture"]>[0],
    preloaded?: { row: SnapshotRow | undefined },
  ): Promise<FrozenPricingRequest | null | number> {
    const prior = preloaded ? preloaded.row : await this.snapshotRow(
      manager,
      input.request_id,
      input.workspace_id,
    );
    if (prior) return this.restoreRow(manager, prior, input.workspace_id);
    const head = await this.head(manager, true);
    if (!head.catalog_revision_id) return null;
    const catalog = await this.loadCatalog(manager, head.catalog_revision_id);
    const admittedAt = readPricingAdmissionTime();
    const clockSkew = Date.parse(catalog.createdAt) - admittedAt.getTime();
    // A small wall-clock rollback is recoverable, but never clamp or backdate
    // immutable timestamps: calendar selection must use an actually observed instant.
    if (clockSkew > 0) return clockSkew;
    const request = catalog.capture({
      admitted_at: admittedAt.toISOString(),
      workspace_id: input.workspace_id,
      report_currency: input.report_currency,
    });
    const descriptor = request.descriptor();
    const stored: SnapshotRow = {
      request_id: input.request_id,
      workspace_id: input.workspace_id,
      catalog_revision_id: head.catalog_revision_id,
      snapshot_hash: descriptor.snapshot_id,
      descriptor_json: JSON.stringify(descriptor),
      created_at: descriptor.admitted_at,
    };
    const combined = await tryInsertPricingSnapshot(manager, stored);
    let row: SnapshotRow | undefined;
    if (combined) row = combined.row;
    else {
      await manager.createQueryBuilder().insert().into("pricing_request_snapshots").values(stored).orIgnore().execute();
      row = await this.snapshotRow(manager, input.request_id, input.workspace_id);
    }
    if (!row) this.denied();
    return this.restoreRow(manager, row!, input.workspace_id);
  }

  /** Admission-only marker: distinguish intentional compatibility from a lost active receipt. */
  async recordCompatibilityBypass(request: string, workspace: string, operation: string, reason: "no_active_bindings" | "no_media_binding") {
    return this.write(async manager => {
      const row = await this.snapshotRow(manager, request, workspace);
      if (!row) this.notFound();
      await recordPricingBypass(manager, workspace, request, row!.snapshot_hash, operation, reason);
    });
  }

  async restoreRequest(
    requestId: string,
    workspaceId: string,
  ): Promise<FrozenPricingRequest> {
    this.text(requestId, "request_id", 128);
    this.text(workspaceId, "workspace_id", 128);
    return this.read(async (manager) => {
      const row = await this.snapshotRow(manager, requestId, workspaceId);
      if (!row) this.notFound();
      return this.restoreRow(manager, row!, workspaceId);
    });
  }

  /** Internal callers already own the request transaction; never reacquire its serialization fence. */
  async restoreRequestInTransaction(manager: EntityManager, requestId: string, workspaceId: string): Promise<FrozenPricingRequest> {
    if (manager.connection !== this.dataSource || !manager.queryRunner?.isTransactionActive)
      this.conflict("Pricing restoration requires the caller's owned transaction");
    const row = await this.snapshotRow(manager, requestId, workspaceId);
    if (!row) this.notFound();
    return this.restoreRow(manager, row!, workspaceId);
  }

  validateDraftContent(content: unknown) {
    const compiled = this.validateContent(content, "validation", "draft");
    return {
      valid: true,
      content: compiled.document(),
      content_hash: compiled.contentHash,
      warnings: this.coverageWarnings(compiled.document()),
      metering: this.meteringReview(compiled.document(), [{ level: 'model', model: '*' }]),
    };
  }

  private async publish(
    manager: EntityManager,
    actor: PricingActor,
    book: PricingBookRow,
    content: PriceBookContent,
    options: PricingPublishOptions,
    draftId?: string,
    draftRevision?: number,
    rolledBackFrom?: string,
    inheritance?: PricingInheritanceView,
  ) {
    const head = await this.lockHead(manager, options.catalog_revision);
    const plan = await this.preparePublication(
      manager,
      actor,
      book,
      content,
      options,
      head,
    );
    const coverage = this.coverageWarnings(content);
    if (coverage.length)
      this.bad(
        "Cannot publish a billing basis with no rate for one or more dimensions",
      );
    const metering = this.meteringReview(content, options.targets);
    if (!metering.can_publish) throw new PricingRepositoryError('pricing_metering_unsupported', 'No integrated operation can collect the selected billing basis. Review metering in the publication preview.', 400);
    if (options.metering_assessment_hash !== undefined && options.metering_assessment_hash !== metering.assessment_hash) this.conflict('Metering assessment changed after preview; review the current operation/profile capabilities');
    if (options.fx_review_status !== undefined && options.fx_review_status !== plan.fxReview.status) this.conflict('FX coverage changed after preview; review the proposed activation interval again');
    const timeConfirmation = confirmPublicationTimeBasis(plan.timeReview, options.time_basis_confirmation);
    const version = plan.version;
    await manager
      .createQueryBuilder()
      .insert()
      .into("pricing_book_versions")
      .values({
        book_id: book.id,
        version_id: version.version_id,
        content_hash: version.content_hash,
        content_json: JSON.stringify(version.content),
        published_by: actor.id,
        published_at: plan.catalog.created_at,
        reason: options.reason,
      })
      .execute();
    if (inheritance) {
      const verified = await resolveScopedInheritance(
        manager,
        inheritance.definition,
        book,
        version.version_id,
      );
      if (
        verified.view.lineage_hash !== inheritance.lineage_hash ||
        pricingContentHash(verified.content) !== version.content_hash
      )
        this.conflict(
          "Inherited publication must reproduce its reviewed immutable parent and materialization",
        );
      await storeVersionInheritance(
        manager,
        book,
        version.version_id,
        actor,
        verified.view,
      );
    }
    const compiled = await this.saveCatalog(
      manager,
      actor,
      head,
      plan.catalog,
      options.reason,
      true,
    );
    if (draftId) {
      await deletePublishedDraftInheritance(manager, draftId);
      const result = await manager
        .createQueryBuilder()
        .delete()
        .from("pricing_drafts")
        .where("id = :id AND revision = :revision", {
          id: draftId,
          revision: draftRevision,
        })
        .execute();
      if (result.affected !== 1)
        this.conflict("Draft changed before publication committed");
    }
    await manager
      .createQueryBuilder()
      .update("pricing_books")
      .set({ updated_at: plan.catalog.created_at })
      .where("id = :id", { id: book.id })
      .execute();
    await this.audit(
      manager,
      actor,
      book.workspace_id,
      book.id,
      rolledBackFrom ? "book.rolled_back" : "draft.published",
      options.reason,
      {
        version_id: version.version_id,
        content_hash: version.content_hash,
        catalog_revision_id: compiled.revisionId,
        // The draft is consumed by publication. Keep the edge to its creation
        // audit so ordinary forks retain their immutable source-version lineage.
        ...(draftId ? { draft_id: draftId } : {}),
        rolled_back_from: rolledBackFrom ?? null,
        binding_ids: plan.added.map((entry) => entry.id),
        metering,
        metering_review_confirmed: options.metering_assessment_hash === metering.assessment_hash,
        fx_review: plan.fxReview,
        fx_review_confirmed: options.fx_review_status === plan.fxReview.status,
        time_basis_review: plan.timeReview,
        time_basis_confirmation: timeConfirmation,
        ...(inheritance
          ? {
              inheritance_hash: inheritance.lineage_hash,
              parent: inheritance.definition.parent,
            }
          : {}),
      },
    );
    return {
      version_id: version.version_id,
      content_hash: version.content_hash,
      head: {
        ...head,
        revision: options.catalog_revision + 1,
        catalog_revision_id: compiled.revisionId,
      },
      bindings: plan.added,
      metering,
      fx_review: plan.fxReview,
      time_basis_review: plan.timeReview,
      time_basis_confirmation: timeConfirmation,
      ...(inheritance ? { inheritance } : {}),
    };
  }

  private async preparePublication(
    manager: EntityManager,
    _actor: PricingActor,
    book: PricingBookRow,
    content: PriceBookContent,
    options: PricingPublishOptions,
    head: PricingHead,
  ) {
    assertPriceBookRuleCapacity(content, this.resourceLimits().max_published_rules);
    const current = head.catalog_revision_id
      ? (await this.loadCatalog(manager, head.catalog_revision_id)).document()
      : this.emptyCatalog();
    const now = new Date().toISOString();
    const from = options.effective_from
      ? new Date(parsePricingInstant(options.effective_from)).toISOString()
      : now;
    if (options.effective_from && parsePricingInstant(from) < Date.now() - 5000)
      this.bad("Backdated publication is not allowed");
    const to = options.effective_to
      ? new Date(parsePricingInstant(options.effective_to)).toISOString()
      : undefined;
    if (to && parsePricingInstant(to) <= parsePricingInstant(from))
      this.bad("Effective interval must be positive");
    if (to && parsePricingInstant(to) <= Date.now())
      this.bad("Publication must not already be expired");
    const compiled = this.validateContent(content, book.id, randomUUID());
    if (
      content.calendar &&
      content.groups.some((group) =>
        group.rules.some((rule) => rule.condition.time_tags),
      )
    ) {
      const calendar = CompiledPricingCalendar.compile(content.calendar);
      const end = to
        ? new Date(parsePricingInstant(to) - 1).toISOString()
        : null;
      if (
        calendar.match(from).diagnostics.length ||
        (end && calendar.match(end).diagnostics.length)
      ) {
        throw new PricingRepositoryError(
          "pricing_calendar_unavailable",
          "The activation interval is not covered by the frozen calendar and timezone-data version",
          400,
        );
      }
    }
    const version: CatalogBookVersion = {
      book_id: book.id,
      version_id: randomUUID(),
      workspace_id: book.workspace_id,
      content: compiled.document(),
      content_hash: compiled.contentHash,
    };
    const added: PricingBinding[] = options.targets.map((target) => ({
      ...target,
      id: randomUUID(),
      workspace_id: book.workspace_id,
      book_id: book.id,
      version_id: version.version_id,
      effective_from: from,
      ...(to ? { effective_to: to } : {}),
    }));
    const replaced: string[] = [];
    let bindings = current.bindings;
    for (const replacement of added) {
      const next: PricingBinding[] = [];
      for (const old of bindings) {
        if (!sameTarget(old, replacement) || !overlap(old, replacement)) {
          next.push(old);
          continue;
        }
        if (
          parsePricingInstant(old.effective_from) >=
            parsePricingInstant(from) &&
          parsePricingInstant(old.effective_from) > Date.now()
        )
          throw new PricingRepositoryError(
            "pricing_activation_conflict",
            "Cancel an overlapping future activation before replacing it",
            409,
          );
        replaced.push(old.id);
        if (parsePricingInstant(old.effective_from) < parsePricingInstant(from))
          next.push({ ...old, effective_to: from });
        if (
          to &&
          (!old.effective_to ||
            parsePricingInstant(old.effective_to) > parsePricingInstant(to))
        )
          next.push({ ...old, id: randomUUID(), effective_from: to });
      }
      next.push(replacement);
      bindings = next;
    }
    const catalog = compactCatalog({
      ...current,
      revision_id: randomUUID(),
      created_at: now,
      books: [...current.books, version],
      bindings,
    });
    // This validates selector scope, source approval, FX intervals and all references before any write.
    assertPublishedRuleCapacity(catalog.books, this.resourceLimits().max_published_rules);
    CompiledPricingCatalog.compile(catalog);
    const fxReview = reviewPublicationFx({ currency: version.content.currency, workspace_id: book.workspace_id,
      window: { effective_from: from, effective_to: to ?? null }, fx_versions: catalog.fx_versions });
    return { catalog, version, added, replaced, fxReview, timeReview: publicationTimeBasisReview(version.content, version.content_hash) };
  }

  private async saveCatalog(
    manager: EntityManager,
    actor: PricingActor,
    head: PricingHead,
    input: PricingCatalogDocument,
    reason: string,
    enforceRuleCapacity = false,
  ): Promise<CompiledPricingCatalog> {
    const doc = compactCatalog({
      ...input,
      revision_id: randomUUID(),
      created_at: new Date().toISOString(),
    });
    // Metadata-only changes/cancellation can still operate after a lowered limit;
    // all new price publication/rollback paths opt in and remain atomically bounded.
    if (enforceRuleCapacity) assertPublishedRuleCapacity(doc.books, this.resourceLimits().max_published_rules);
    const compiled = CompiledPricingCatalog.compile(doc);
    const normalized = compiled.document();
    const manifest: CatalogManifest = {
      ...normalized,
      books: normalized.books.map(
        ({ content: _content, ...reference }) => reference,
      ),
    };
    await manager
      .createQueryBuilder()
      .insert()
      .into("pricing_catalog_revisions")
      .values({
        id: compiled.revisionId,
        parent_revision_id: head.catalog_revision_id,
        content_hash: compiled.contentHash,
        manifest_json: JSON.stringify(manifest),
        published_by: actor.id,
        published_at: normalized.created_at,
        reason,
      })
      .execute();
    const updated = await manager
      .createQueryBuilder()
      .update("pricing_catalog_head")
      .set({ catalog_revision_id: compiled.revisionId })
      .where("id = :id AND revision = :revision", {
        id: "active",
        revision: head.revision + 1,
      })
      .execute();
    if (updated.affected !== 1)
      this.conflict("Catalog publication lost its revision lock");
    return compiled;
  }

  private async loadCatalog(
    manager: EntityManager,
    id: string,
  ): Promise<CompiledPricingCatalog> {
    const cached = this.catalogs.get(id);
    if (cached) return cached;
    const budget = replayBudget(manager), memoKey = `catalog:${id}`;
    const replayCached = budget?.memo.get(memoKey) as CompiledPricingCatalog | undefined;
    if (replayCached) return replayCached;
    const row = await manager
      .createQueryBuilder()
      .select("c.*")
      .from("pricing_catalog_revisions", "c")
      .where("c.id = :id", { id })
      .getRawOne<CatalogRow>();
    if (!row)
      throw new PricingRepositoryError(
        "pricing_version_conflict",
        "Historical catalog is unavailable; latest prices cannot replace it",
        503,
      );
    const manifest = JSON.parse(row.manifest_json) as CatalogManifest;
    if (!Array.isArray(manifest.books) || manifest.books.length > 2000)
      this.corrupt();
    const books: CatalogBookVersion[] = [];
    const inheritanceSources: Array<{
      version: PricingVersionRow;
      scope: string | null;
    }> = [];
    // System-owned catalog hydration is not a user listing. Public readers are separately scoped.
    // Batch immutable version/owner lookups to avoid one database query per model on a new revision.
    for (let offset = 0; offset < manifest.books.length; offset += 400) {
      const references = manifest.books.slice(offset, offset + 400);
      const rows = await manager
        .createQueryBuilder()
        .select("v.*")
        .addSelect("b.workspace_id", "owner_workspace")
        .from("pricing_book_versions", "v")
        .innerJoin("pricing_books", "b", "b.id = v.book_id")
        .where("v.book_id IN (:...books) AND v.version_id IN (:...versions)", {
          books: [...new Set(references.map((entry) => entry.book_id))],
          versions: [...new Set(references.map((entry) => entry.version_id))],
        })
        .getRawMany<PricingVersionRow & { owner_workspace: string | null }>();
      const index = new Map(
        rows.map((row) => [JSON.stringify([row.book_id, row.version_id]), row]),
      );
      for (const reference of references) {
        const stored = index.get(
          JSON.stringify([reference.book_id, reference.version_id]),
        );
        if (
          !stored ||
          stored.content_hash !== reference.content_hash ||
          stored.owner_workspace !== reference.workspace_id
        )
          this.corrupt();
        inheritanceSources.push({
          version: stored!,
          scope: reference.workspace_id,
        });
        books.push({
          ...reference,
          content: JSON.parse(stored!.content_json) as PriceBookContent,
        });
      }
    }
    await verifyCatalogInheritance(manager, inheritanceSources);
    const compiled = CompiledPricingCatalog.compile({ ...manifest, books });
    if (compiled.contentHash !== row.content_hash || compiled.revisionId !== id)
      this.corrupt();
    if (budget) budget.memo.set(memoKey, compiled);
    else {
      this.catalogs.set(id, compiled);
      if (this.catalogs.size > 32)
        this.catalogs.delete(this.catalogs.keys().next().value!);
    }
    return compiled;
  }

  private emptyCatalog(): PricingCatalogDocument {
    return {
      schema_version: 1,
      revision_id: randomUUID(),
      created_at: new Date().toISOString(),
      books: [],
      bindings: [],
      fx_versions: [],
    };
  }

  private async head(
    manager: EntityManager,
    freeze = false,
  ): Promise<PricingHead> {
    const query = manager
      .createQueryBuilder()
      .select("h.*")
      .from("pricing_catalog_head", "h")
      .where("h.id = :id", { id: "active" });
    if (freeze && this.dataSource.options.type === "postgres")
      query.setLock("pessimistic_read");
    const row = await query.getRawOne<PricingHead>();
    if (!row)
      throw new PricingRepositoryError(
        "pricing_schema_required",
        "Pricing schema is not initialized; run the explicit pricing migration",
        503,
      );
    return row;
  }

  private async lockHead(
    manager: EntityManager,
    revision: number,
  ): Promise<PricingHead> {
    const head = await this.head(manager);
    if (head.revision !== revision)
      this.conflict("Catalog changed; reload the publication preview");
    const updated = await manager
      .createQueryBuilder()
      .update("pricing_catalog_head")
      .set({ revision: revision + 1 })
      .where("id = :id AND revision = :revision", { id: "active", revision })
      .execute();
    if (updated.affected !== 1)
      this.conflict("Catalog changed; reload the publication preview");
    return head;
  }

  private async book(
    manager: EntityManager,
    actor: PricingActor,
    id: string,
    write = false,
  ): Promise<PricingBookRow> {
    this.text(id, "book_id", 128);
    const book = await manager
      .createQueryBuilder()
      .select("b.*")
      .from("pricing_books", "b")
      .where("b.id = :id", { id })
      .andWhere("(b.workspace_id = :workspace OR b.workspace_id IS NULL)", {
        workspace: actor.workspace_id,
      })
      .getRawOne<PricingBookRow>();
    if (!book) this.notFound();
    this.owned(actor, book!.workspace_id, write);
    return book!;
  }

  private async draft(
    manager: EntityManager,
    actor: PricingActor,
    id: string,
    write = false,
  ) {
    this.text(id, "draft_id", 128);
    const draft = await manager
      .createQueryBuilder()
      .select("d.*")
      .from("pricing_drafts", "d")
      .innerJoin("pricing_books", "b", "b.id = d.book_id")
      .where("d.id = :id", { id })
      .andWhere("(b.workspace_id = :workspace OR b.workspace_id IS NULL)", {
        workspace: actor.workspace_id,
      })
      .getRawOne<PricingDraftRow>();
    if (!draft) this.notFound();
    const book = await this.book(manager, actor, draft!.book_id, write);
    return { draft: draft!, book };
  }

  private async version(
    manager: EntityManager,
    bookId: string,
    versionId: string,
  ): Promise<PricingVersionRow> {
    this.text(versionId, "version_id", 128);
    const row = await manager
      .createQueryBuilder()
      .select("v.*")
      .from("pricing_book_versions", "v")
      .where("v.book_id = :book AND v.version_id = :version", {
        book: bookId,
        version: versionId,
      })
      .getRawOne<PricingVersionRow>();
    if (!row) this.notFound();
    const compiled = this.validateContent(
      JSON.parse(row!.content_json),
      bookId,
      versionId,
    );
    if (compiled.contentHash !== row!.content_hash) this.corrupt();
    return row!;
  }

  private decodeDraft(row: PricingDraftRow): PricingDraft {
    const { content_json, ...metadata } = row;
    return {
      ...metadata,
      content: JSON.parse(content_json) as PriceBookContent,
    };
  }

  private async hydrateDraft(
    manager: EntityManager,
    draft: PricingDraftRow,
    book: PricingBookRow,
  ): Promise<PricingDraft> {
    const inheritance = await readDraftInheritance(manager, draft, book);
    return {
      ...this.decodeDraft(draft),
      ...(inheritance ? { inheritance } : {}),
    };
  }

  /** No-write expansion of an explicitly selected immutable parent in the intended child scope. */
  async previewInheritance(
    actor: PricingActor,
    input: {
      scope: "workspace" | "global";
      definition: unknown;
      book_id?: string;
    },
  ) {
    this.admin(actor);
    return this.read(async (manager) => {
      const book = input.book_id
        ? await this.book(manager, actor, input.book_id, true)
        : {
            id: "inheritance-preview",
            workspace_id: this.scope(actor, input.scope),
          };
      const resolved = await resolveScopedInheritance(
        manager,
        input.definition,
        book,
        "preview",
      );
      return {
        dry_run: true,
        content: resolved.content,
        content_hash: pricingContentHash(resolved.content),
        inheritance: resolved.view,
        warnings: this.coverageWarnings(resolved.content),
        metering: this.meteringReview(resolved.content, [{ level: 'model', model: '*' }]),
      };
    });
  }

  async createInheritedBook(
    actor: PricingActor,
    input: { name: string; scope: "workspace" | "global"; definition: unknown },
  ) {
    this.admin(actor);
    this.text(input.name, "name", 128);
    const workspace = this.scope(actor, input.scope);
    return this.write(async (manager) => {
      const now = new Date().toISOString(),
        book: PricingBookRow = {
          id: randomUUID(),
          workspace_id: workspace,
          name: input.name,
          created_by: actor.id,
          created_at: now,
          updated_at: now,
        };
      const id = randomUUID(),
        resolved = await resolveScopedInheritance(
          manager,
          input.definition,
          book,
          id,
        );
      const draft: PricingDraftRow = {
        id,
        book_id: book.id,
        revision: 1,
        content_json: JSON.stringify(resolved.content),
        created_by: actor.id,
        created_at: now,
        updated_at: now,
      };
      await manager
        .createQueryBuilder()
        .insert()
        .into("pricing_books")
        .values(book)
        .execute();
      await initializeBookOwner(manager, book, actor);
      await manager
        .createQueryBuilder()
        .insert()
        .into("pricing_drafts")
        .values(draft)
        .execute();
      await storeDraftInheritance(manager, book, draft, actor, resolved.view);
      await this.audit(
        manager,
        actor,
        workspace,
        book.id,
        "book.created",
        "Create explicitly inherited price draft",
        {
          draft_id: id,
          owner: actor.id,
          content_hash: pricingContentHash(resolved.content),
          inheritance_hash: resolved.view.lineage_hash,
          parent: resolved.view.definition.parent,
        },
      );
      return {
        book,
        draft: await this.hydrateDraft(manager, draft, book),
        head: await this.head(manager),
      };
    });
  }

  /** A dedicated operation may attach or replace a recipe, never trust client-expanded monetary content. */
  async updateInheritedDraft(
    actor: PricingActor,
    id: string,
    revision: number,
    definition: unknown,
  ): Promise<PricingDraft> {
    this.admin(actor);
    this.revision(revision);
    return this.write(async (manager) => {
      const { draft, book } = await this.draft(manager, actor, id, true);
      if (draft.revision !== revision)
        this.conflict("Draft changed before parent update");
      await readDraftInheritance(manager, draft, book);
      const resolved = await resolveScopedInheritance(
        manager,
        definition,
        book,
        id,
      );
      const next = {
        ...draft,
        revision: revision + 1,
        content_json: JSON.stringify(resolved.content),
        updated_at: new Date().toISOString(),
      };
      const changed = await manager
        .createQueryBuilder()
        .update("pricing_drafts")
        .set({
          revision: next.revision,
          content_json: next.content_json,
          updated_at: next.updated_at,
        })
        .where("id = :id AND revision = :revision", { id, revision })
        .execute();
      if (changed.affected !== 1)
        this.conflict("Draft changed before parent update");
      await storeDraftInheritance(manager, book, next, actor, resolved.view);
      await this.audit(
        manager,
        actor,
        book.workspace_id,
        book.id,
        "draft.updated",
        "Update explicit parent recipe",
        {
          draft_id: id,
          revision: next.revision,
          content_hash: pricingContentHash(resolved.content),
          inheritance_hash: resolved.view.lineage_hash,
          parent: resolved.view.definition.parent,
        },
      );
      return this.hydrateDraft(manager, next, book);
    });
  }

  private snapshotQuery(manager: EntityManager, id: string, workspace: string) {
    return manager.createQueryBuilder().select("s.*").from("pricing_request_snapshots", "s")
      .where("s.request_id = :id AND s.workspace_id = :workspace", { id, workspace });
  }

  private async snapshotRow(manager: EntityManager, id: string, workspace: string) {
    return this.snapshotQuery(manager, id, workspace).getRawOne<SnapshotRow>();
  }

  private async restoreRow(
    manager: EntityManager,
    row: SnapshotRow,
    workspace: string,
  ) {
    let parsed: unknown;
    try { parsed = JSON.parse(row.descriptor_json); } catch { this.corrupt(); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) this.corrupt();
    const snapshot = parsed as PricingRequestSnapshot;
    if (
      snapshot.snapshot_id !== row.snapshot_hash ||
      snapshot.catalog_revision_id !== row.catalog_revision_id ||
      snapshot.admitted_at !== row.created_at
    )
      this.corrupt();
    return (await this.loadCatalog(manager, row.catalog_revision_id)).restore(
      snapshot,
      workspace,
    );
  }

  private async audit(
    manager: EntityManager,
    actor: PricingActor,
    workspace: string | null,
    bookId: string | null,
    action: string,
    reason: string,
    metadata: Record<string, unknown>,
  ) {
    await manager
      .createQueryBuilder()
      .insert()
      .into("pricing_audit_events")
      .values({
        id: randomUUID(),
        workspace_id: workspace,
        book_id: bookId,
        actor_id: actor.id,
        action,
        reason,
        metadata_json: JSON.stringify(metadata),
        created_at: new Date().toISOString(),
      })
      .execute();
  }

  private validateContent(
    value: unknown,
    bookId: string,
    versionId: string,
  ): CompiledPriceBook {
    const json = JSON.stringify(value);
    if (!json || Buffer.byteLength(json) > 512000)
      this.bad("Price content must fit within 500 KiB");
    return compilePriceBook(value, { book_id: bookId, version_id: versionId });
  }

  private coverageWarnings(content: PriceBookContent): string[] {
    const dimensions = new Set(
      content.groups.flatMap((group) =>
        group.rules.flatMap((rule) =>
          rule.rates.map((entry) => entry.component.dimension),
        ),
      ),
    );
    return content.billing_dimensions
      .filter((dimension) => !dimensions.has(dimension))
      .map((dimension) => `No rate for billing dimension ${dimension}`);
  }

  private meteringReview(content: PriceBookContent, targets: PricingPublishOptions['targets']) {
    return assessPricingMetering(content, targets, id => {
      const node = this.config?.nodes.find(value => value.id === id);
      return node ? node.video_result_profile ?? 'generic-v1' : undefined;
    });
  }

  private async ensureReady() {
    if (this.ready) return;
    const runner = this.dataSource.createQueryRunner();
    try {
      if (!(await runner.hasTable("pricing_schema_versions")))
        throw new PricingRepositoryError(
          "pricing_schema_required",
          "Run pricing-migrate explicitly before configuring prices",
          503,
        );
      if (!(await pricingMigrationMarkersReady(runner.manager)))
        throw new PricingRepositoryError(
          "pricing_schema_required",
          "Pricing schema version is missing or incompatible",
          503,
        );
      this.ready = true;
    } finally {
      await runner.release();
    }
  }

  private async read<T>(
    action: (manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    return this.serialize(async () => {
      await this.ensureReady();
      return action(this.dataSource.manager);
    });
  }

  private async write<T>(
    action: (manager: EntityManager) => Promise<T>,
    prepare?: (manager: EntityManager) => PostgresTransactionReadPrelude<T> | null,
  ): Promise<T> {
    return this.serialize(async () => {
      await this.ensureReady();
      return prepare && this.dataSource.options.type === "postgres"
        ? withPostgresReadPrelude(this.dataSource, prepare, action)
        : this.dataSource.transaction(action);
    });
  }

  private async serialize<T>(action: () => Promise<T>): Promise<T> {
    return serializeDatabaseAccess(this.dataSource, action);
  }

  private actor(actor: PricingActor) {
    this.text(actor.id, "actor", 128);
    this.text(actor.workspace_id, "workspace", 128);
    if (!["viewer", "operator", "admin"].includes(actor.role)) this.denied();
  }
  private admin(actor: PricingActor) {
    this.actor(actor);
    if (actor.role !== "admin") this.denied();
  }
  private scope(actor: PricingActor, scope: string) {
    if (scope !== "global" && scope !== "workspace")
      this.bad("Unknown pricing scope");
    if (scope === "global" && !actor.global_admin) this.denied();
    return scope === "global" ? null : actor.workspace_id;
  }
  private owned(actor: PricingActor, workspace: string | null, write: boolean) {
    if (workspace !== null && workspace !== actor.workspace_id) this.notFound();
    if (write) {
      this.admin(actor);
      if (workspace === null && !actor.global_admin) this.denied();
    }
  }
  private pagination(limit: number, offset: number) {
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 200 ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > 100000
    )
      this.bad("Invalid pagination");
  }
  private text(value: string, name: string, max: number) {
    if (typeof value !== "string" || !value.trim() || value.length > max)
      this.bad(
        `${name} must be a nonempty string of at most ${max} characters`,
      );
  }
  private revision(value: number) {
    if (!Number.isSafeInteger(value) || value < 0)
      this.bad("An explicit nonnegative revision is required");
  }
  private publishOptions(input: PricingPublishOptions) {
    parseTimeBasisConfirmation(input.time_basis_confirmation);
    if (input.fx_review_status !== undefined && !PUBLICATION_FX_STATUSES.includes(input.fx_review_status))
      this.bad('Invalid reviewed FX coverage status');
    this.revision(input.catalog_revision);
    this.revision(input.draft_revision);
    this.text(input.reason, "reason", 1000);
    if (
      input.confirm !== true ||
      !Array.isArray(input.targets) ||
      input.targets.length < 1 ||
      input.targets.length > 256
    )
      this.bad("Confirmed publication requires 1–256 explicit targets");
    const keys = input.targets.map((target) =>
      JSON.stringify([
        target.level,
        target.model,
        target.node_id ?? null,
        target.operation ?? null,
      ]),
    );
    if (new Set(keys).size !== keys.length)
      this.bad("Publication targets must be unique");
  }
  private bad(message: string): never {
    throw new PricingRepositoryError("pricing_invalid_document", message, 400);
  }
  private denied(): never {
    throw new PricingRepositoryError(
      "pricing_permission_denied",
      "Administrator access to the resource scope is required",
      403,
    );
  }
  private notFound(): never {
    throw new PricingRepositoryError(
      "pricing_not_found",
      "Pricing resource not found in this workspace",
      404,
    );
  }
  private conflict(message: string): never {
    throw new PricingRepositoryError("pricing_version_conflict", message, 409);
  }
  private corrupt(): never {
    throw new PricingRepositoryError(
      "pricing_version_conflict",
      "Stored pricing evidence failed integrity verification",
      503,
    );
  }
}

function sameTarget(a: PricingBinding, b: PricingBinding): boolean {
  return (
    a.workspace_id === b.workspace_id &&
    a.level === b.level &&
    a.model === b.model &&
    a.node_id === b.node_id &&
    a.operation === b.operation
  );
}
function overlap(a: PricingBinding, b: PricingBinding): boolean {
  return (
    parsePricingInstant(a.effective_from) <
      (b.effective_to ? parsePricingInstant(b.effective_to) : Infinity) &&
    parsePricingInstant(b.effective_from) <
      (a.effective_to ? parsePricingInstant(a.effective_to) : Infinity)
  );
}

function compactCatalog(input: PricingCatalogDocument): PricingCatalogDocument {
  const epoch = parsePricingInstant(input.created_at);
  const bindings = input.bindings.filter(
    (binding) =>
      !binding.effective_to ||
      parsePricingInstant(binding.effective_to) > epoch,
  );
  const references = new Set(
    bindings.map((binding) =>
      JSON.stringify([binding.book_id, binding.version_id]),
    ),
  );
  return {
    ...input,
    bindings,
    books: input.books.filter((book) =>
      references.has(JSON.stringify([book.book_id, book.version_id])),
    ),
    fx_versions: input.fx_versions.filter(
      (version) =>
        !version.effective_to ||
        parsePricingInstant(version.effective_to) > epoch,
    ),
  };
}

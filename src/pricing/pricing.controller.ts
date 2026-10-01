import { previewPricingCalendarWeek } from './pricing-calendar-week';
import {
  parseAdmissionPolicy,
  PRICING_ADMISSION_OPERATIONS,
} from "./pricing-admission-policy";
import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseFilters,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { DashboardGuard } from "../auth/dashboard.guard";
import { DashboardRbacGuard } from "../auth/dashboard-rbac.guard";
import { RequireDashboardRole } from "../auth/dashboard-rbac";
import { WorkspaceMembershipService } from "../auth/workspace-membership.service";
import { DEFAULT_WORKSPACE_ID } from "../workspaces/workspace.constants";
import { PricingRepository } from "./pricing-repository";
import {
  PricingActor,
  PricingRepositoryError,
} from "./pricing-repository.types";
import { PricingApiInput } from "./pricing-api-input";
import { PricingExceptionFilter } from "./pricing-exception.filter";
import { PricingWriteGuard } from "./pricing-write.guard";
import { compilePriceBook } from "./pricing-compiler";
import { calculateCost } from "./cost-calculator";
import { normalizeQuantities } from "./usage-normalizer";
import { CompiledPricingCalendar } from "./pricing-calendar";
import { legacyTokenPriceBook } from "./legacy-pricing-adapter";
import type { ModelPricing } from "../config/gateway.config";
import type { PriceBookContent } from "./pricing.types";
import type { PricingInheritanceView } from "./pricing-inheritance.types";
import { isIP } from "node:net";
import { allocateBatchCost } from "./cost-allocation";
import { pricingContentHash } from "./pricing-json";
import { planPricingConfigImport } from "./pricing-config-import";
import { PricingConfigImportError } from "./pricing-config-import-input";
import type { EmbeddingBatchMember } from "./pricing-batch.types";

interface PricingRequest {
  dashboardUserId?: string;
  workspaceId?: string;
  dashboardRole?: PricingActor["role"];
}

@Controller("api/dashboard/pricing")
@UseGuards(DashboardGuard, DashboardRbacGuard, PricingWriteGuard)
@UseFilters(PricingExceptionFilter)
@ApiTags("Pricing")
@ApiBearerAuth("dashboardSession")
export class PricingController {
  constructor(
    private readonly repository: PricingRepository,
    private readonly memberships: WorkspaceMembershipService,
  ) {}

  @Get("status")
  @ApiOperation({
    summary: "Inspect pricing schema readiness without migration or activation",
  })
  status() {
    return this.repository.status();
  }

  @Post("model-status")
  @RequireDashboardRole("viewer")
  async modelStatus(@Req() req: PricingRequest, @Body() value: unknown) {
    const input = new PricingApiInput(value), raw = input.body(["targets"]);
    const targets = input.array(raw.targets, "targets", 20).map((value, index) => {
      const path = `targets.${index}`, row = input.object(value, path, ["node_id", "model", "operation"]);
      return { node_id: input.string(row.node_id, path + ".node_id"), model: input.string(row.model, path + ".model", 256), operation: input.string(row.operation, path + ".operation") };
    });
    input.done(); return this.repository.modelPricingStatus(await this.actor(req), targets);
  }

  @Get("admission-policies")
  async admissionPolicies(@Req() req: PricingRequest) {
    return this.repository.listAdmissionPolicies(await this.actor(req));
  }

  @Put("admission-policy")
  async updateAdmissionPolicy(
    @Req() req: PricingRequest,
    @Body() value: unknown,
  ) {
    return this.repository.updateAdmissionPolicy(
      await this.actor(req),
      this.admissionPolicyInput(value),
    );
  }

  @Post("admission-policy/preview")
  async previewAdmissionPolicy(
    @Req() req: PricingRequest,
    @Body() value: unknown,
  ) {
    return this.repository.previewAdmissionPolicy(
      await this.actor(req),
      this.admissionPolicyInput(value),
    );
  }

  private admissionPolicyInput(
    value: unknown,
  ): import("./pricing-repository.types").PricingAdmissionPolicyUpdate {
    const input = new PricingApiInput(value);
    const raw = input.body([
      "catalog_revision",
      "reason",
      "confirm",
      "scope",
      "operation",
      "policy",
    ]);
    const revision = input.integer(
      raw.catalog_revision,
      "catalog_revision",
      0,
      1000000000,
    );
    const reason = input.string(raw.reason, "reason", 1000);
    const scope = raw.scope ?? "workspace";
    if (scope !== "workspace" && scope !== "global")
      input.invalid("scope", "Unknown pricing scope");
    if (raw.confirm !== true)
      input.invalid(
        "confirm",
        "Admission changes require explicit confirmation",
      );
    const operation =
      raw.operation === undefined
        ? undefined
        : input.string(raw.operation, "operation");
    if (
      operation !== undefined &&
      !(PRICING_ADMISSION_OPERATIONS as readonly string[]).includes(operation)
    )
      input.invalid(
        "operation",
        "Operation is not integrated with pricing admission",
      );
    const policy =
      raw.policy === null ? null : parseAdmissionPolicy(raw.policy, input);
    input.done();
    return {
      catalog_revision: revision,
      reason,
      confirm: true,
      scope: scope as "workspace" | "global",
      operation,
      policy,
    };
  }

  @Post("admission-preview")
  @RequireDashboardRole("viewer")
  async admissionPreview(@Req() req: PricingRequest, @Body() value: unknown) {
    const input = new PricingApiInput(value);
    const raw = input.body([
      "target",
      "evidence",
      "context",
      "attempts",
      "policy",
    ]);
    const target = input.object(raw.target, "target", [
      "node_id",
      "model",
      "operation",
    ]);
    const model = input.string(target.model, "target.model", 256);
    const operation = input.string(target.operation, "target.operation");
    if (
      !(PRICING_ADMISSION_OPERATIONS as readonly string[]).includes(operation)
    )
      input.invalid(
        "target.operation",
        "Operation is not integrated with pricing admission",
      );
    const nodeId =
      target.node_id === undefined
        ? undefined
        : input.string(target.node_id, "target.node_id");
    const evidence = input.evidence(raw.evidence);
    const context = input.context(raw.context ?? {});
    const attempts =
      raw.attempts === undefined
        ? 1
        : input.integer(raw.attempts, "attempts", 1, 1000);
    const policyOverride =
      raw.policy === undefined
        ? undefined
        : parseAdmissionPolicy(raw.policy, input);
    input.done();
    const usage = normalizeQuantities(evidence, {
      adapter_id: "admission-preview",
      adapter_version: "1",
      source: "request_metadata",
    });
    const result = await this.repository.previewAdmission(
      await this.actor(req),
      { model, node_id: nodeId, operation },
      usage,
      context,
      attempts,
      policyOverride,
    );
    const response = { ...result, request_hash: pricingContentHash(value) };
    return { ...response, response_hash: pricingContentHash(response) };
  }

  @Get("books")
  async books(
    @Req() req: PricingRequest,
    @Query("limit") limit = "100",
    @Query("offset") offset = "0",
  ) {
    return this.repository.listBooks(
      await this.actor(req),
      Number(limit),
      Number(offset),
    );
  }

  @Post("inheritance/preview")
  @RequireDashboardRole("admin")
  async previewInheritance(@Req() req: PricingRequest, @Body() value: unknown) {
    const input = new PricingApiInput(value),
      raw = input.body(["scope", "book_id", "definition"]);
    const scope = raw.scope ?? "workspace";
    if (scope !== "workspace" && scope !== "global")
      input.invalid("scope", "Unknown child price scope");
    const book =
      raw.book_id === undefined
        ? undefined
        : input.string(raw.book_id, "book_id");
    input.done();
    return this.repository.previewInheritance(await this.actor(req), {
      scope: scope as "workspace" | "global",
      book_id: book,
      definition: raw.definition,
    });
  }

  @Post("inherited-books")
  @RequireDashboardRole("admin")
  async createInherited(@Req() req: PricingRequest, @Body() value: unknown) {
    const input = new PricingApiInput(value),
      raw = input.body(["name", "scope", "definition"]);
    const name = input.string(raw.name, "name"),
      scope = raw.scope ?? "workspace";
    if (scope !== "workspace" && scope !== "global")
      input.invalid("scope", "Unknown child price scope");
    input.done();
    return this.repository.createInheritedBook(await this.actor(req), {
      name,
      scope: scope as "workspace" | "global",
      definition: raw.definition,
    });
  }

  @Put("drafts/:id/inheritance")
  @RequireDashboardRole("admin")
  async updateInherited(
    @Req() req: PricingRequest,
    @Param("id") id: string,
    @Body() value: unknown,
  ) {
    const input = new PricingApiInput(value),
      raw = input.body(["revision", "definition"]);
    const revision = input.integer(raw.revision, "revision", 1, 1000000000);
    input.done();
    return this.repository.updateInheritedDraft(
      await this.actor(req),
      id,
      revision,
      raw.definition,
    );
  }

  @Get("books/:id")
  async book(@Req() req: PricingRequest, @Param("id") id: string) {
    return this.repository.getBook(await this.actor(req), id);
  }

  @Post("books")
  async create(@Req() req: PricingRequest, @Body() value: unknown) {
    const input = new PricingApiInput(value);
    const raw = input.body(["name", "scope", "content"]);
    const name = input.string(raw.name, "name", 128);
    const scope = raw.scope ?? "workspace";
    if (scope !== "workspace" && scope !== "global")
      input.invalid("scope", "Unknown pricing scope");
    input.done();
    return this.repository.createBook(await this.actor(req), {
      name,
      scope: scope as "workspace" | "global",
      content: raw.content,
    });
  }

  @Get("books/:id/management")
  @RequireDashboardRole("viewer")
  async bookManagement(@Req() req: PricingRequest, @Param("id") id: string) {
    return this.repository.getBookManagement(await this.actor(req), id);
  }

  @Put("books/:id/owner")
  @RequireDashboardRole("admin")
  async bookOwner(@Req() req: PricingRequest, @Param("id") id: string, @Body() value: unknown) {
    const input = new PricingApiInput(value), raw = input.body(["revision", "owner", "reason", "confirm"]);
    const revision = input.integer(raw.revision, "revision", 0, 999999999);
    const owner = raw.owner === null ? null : input.string(raw.owner, "owner", 128);
    const reason = input.string(raw.reason, "reason", 1000);
    if (raw.confirm !== true) input.invalid("confirm", "Owner changes require explicit confirmation");
    input.done();
    return this.repository.updateBookOwner(await this.actor(req), id, { revision, owner, reason, confirm: true });
  }

  @Post("books/:id/drafts")
  async fork(
    @Req() req: PricingRequest,
    @Param("id") id: string,
    @Body() value: unknown,
  ) {
    const input = new PricingApiInput(value);
    const raw = input.body(["version_id"]);
    const version = input.string(raw.version_id, "version_id");
    input.done();
    return this.repository.forkDraft(await this.actor(req), id, version);
  }

  @Get("drafts/:id")
  async draft(@Req() req: PricingRequest, @Param("id") id: string) {
    return this.repository.getDraft(await this.actor(req), id);
  }

  @Put("drafts/:id")
  async update(
    @Req() req: PricingRequest,
    @Param("id") id: string,
    @Body() value: unknown,
  ) {
    const input = new PricingApiInput(value);
    const raw = input.body(["revision", "content"]);
    const revision = input.integer(raw.revision, "revision", 1, 1000000000);
    input.done();
    return this.repository.updateDraft(
      await this.actor(req),
      id,
      revision,
      raw.content,
    );
  }

  @Post("drafts/:id/validate")
  @RequireDashboardRole("viewer")
  async validate(@Req() req: PricingRequest, @Param("id") id: string) {
    const draft = await this.repository.getDraft(await this.actor(req), id);
    return {
      ...this.repository.validateDraftContent(draft.content),
      revision: draft.revision,
    };
  }

  @Post("drafts/:id/preview-publication")
  async preview(
    @Req() req: PricingRequest,
    @Param("id") id: string,
    @Body() value: unknown,
  ) {
    const input = new PricingApiInput(value);
    const { options } = input.publication();
    input.done();
    return this.repository.previewPublish(await this.actor(req), id, options);
  }

  @Post("drafts/:id/publish")
  async publish(
    @Req() req: PricingRequest,
    @Param("id") id: string,
    @Body() value: unknown,
  ) {
    const input = new PricingApiInput(value);
    const { options } = input.publication();
    input.done();
    return this.repository.publishDraft(await this.actor(req), id, options);
  }

  @Post("books/:id/preview-rollback")
  async previewRollback(
    @Req() req: PricingRequest,
    @Param("id") id: string,
    @Body() value: unknown,
  ) {
    const input = new PricingApiInput(value);
    const { options, raw } = input.publication(["version_id"], "rollback");
    const version = input.string(raw.version_id, "version_id");
    input.done();
    return this.repository.previewRollback(
      await this.actor(req),
      id,
      version,
      options,
    );
  }

  @Post("books/:id/rollback")
  async rollback(
    @Req() req: PricingRequest,
    @Param("id") id: string,
    @Body() value: unknown,
  ) {
    const input = new PricingApiInput(value);
    const { options, raw } = input.publication(["version_id"], "rollback");
    const version = input.string(raw.version_id, "version_id");
    input.done();
    return this.repository.rollback(
      await this.actor(req),
      id,
      version,
      options,
    );
  }

  @Get("books/:id/versions/:version")
  async version(
    @Req() req: PricingRequest,
    @Param("id") id: string,
    @Param("version") version: string,
  ) {
    return this.repository.getVersion(await this.actor(req), id, version);
  }

  @Get("bindings")
  async bindings(@Req() req: PricingRequest) {
    return this.repository.listBindings(await this.actor(req));
  }

  @Post("bindings/:id/cancel")
  async cancel(
    @Req() req: PricingRequest,
    @Param("id") id: string,
    @Body() value: unknown,
  ) {
    const input = new PricingApiInput(value);
    const raw = input.body(["catalog_revision", "reason", "confirm"]);
    const revision = input.integer(
      raw.catalog_revision,
      "catalog_revision",
      0,
      1000000000,
    );
    const reason = input.string(raw.reason, "reason", 1000);
    if (raw.confirm !== true)
      input.invalid("confirm", "Cancellation requires confirmation");
    input.done();
    return this.repository.cancelScheduled(
      await this.actor(req),
      id,
      revision,
      reason,
    );
  }

  @Post("fx/preview")
  async previewFx(@Req() req: PricingRequest, @Body() value: unknown) {
    const input = new PricingApiInput(value);
    const update = input.fxUpdate();
    input.done();
    return this.repository.previewFx(await this.actor(req), update);
  }

  @Put("fx")
  async fx(@Req() req: PricingRequest, @Body() value: unknown) {
    const input = new PricingApiInput(value);
    const update = input.fxUpdate();
    input.done();
    return this.repository.updateFx(await this.actor(req), update);
  }

  @Get("audit")
  @RequireDashboardRole("admin")
  async audit(
    @Req() req: PricingRequest,
    @Query("book_id") bookId?: string,
    @Query("limit") limit = "50",
    @Query("offset") offset = "0",
  ) {
    return this.repository.listAudit(
      await this.actor(req),
      bookId,
      Number(limit),
      Number(offset),
    );
  }

  @Post("quote")
  @RequireDashboardRole("viewer")
  @ApiOperation({
    summary:
      "Pure pricing simulation: no upstream request, budget mutation or publication",
  })
  async quote(@Req() req: PricingRequest, @Body() value: unknown) {
    const input = new PricingApiInput(value);
    const parsed = input.quote();
    input.done();
    const actor = await this.actor(req);
    let content = parsed.content;
    let inheritance: PricingInheritanceView | undefined;
    if (parsed.draftId) {
      const draft = await this.repository.getDraft(actor, parsed.draftId);
      content = draft.content;
      inheritance = draft.inheritance;
    }
    if (parsed.bookId && parsed.versionId) {
      const version = await this.repository.getVersion(
        actor,
        parsed.bookId,
        parsed.versionId,
      );
      content = version.content;
      inheritance = version.inheritance;
    }
    const validated = this.repository.validateDraftContent(content);
    const compiled = compilePriceBook(validated.content, {
      book_id: parsed.bookId ?? "simulation",
      version_id: parsed.versionId ?? parsed.draftId ?? "inline",
    });
    const usage = normalizeQuantities(parsed.evidence, {
      adapter_id: "dashboard-simulation",
      adapter_version: "1",
      source: "request_metadata",
    });
    return {
      simulation: true,
      cost: calculateCost(usage, compiled.resolve(usage, parsed.context), {
        report_currency: parsed.reportCurrency,
        fx: parsed.fx,
      }),
      warnings: validated.warnings,
      ...(inheritance ? { inheritance } : {}),
    };
  }

  @Post("batch/quote")
  @RequireDashboardRole("viewer")
  async batchQuote(@Req() req: PricingRequest, @Body() value: unknown) {
    const input = new PricingApiInput(value);
    const raw = input.body(["quote", "members"]);
    const members = input
      .array(raw.members, "members", 1024)
      .map((value, index): EmbeddingBatchMember => {
        const path = `members.${index}`;
        const entry = input.object(value, path, [
          "id",
          "input_count",
          "weight",
          "weight_basis",
        ]);
        const id = input.string(entry.id, `${path}.id`, 128);
        const basis = input.string(entry.weight_basis, `${path}.weight_basis`);
        if (basis !== "token_input_count" && basis !== "text_token_estimate")
          input.invalid(
            `${path}.weight_basis`,
            "Unknown batch allocation basis",
          );
        return {
          request_id: id,
          reservation_id: id,
          input_start: 0,
          input_count: input.integer(
            entry.input_count,
            `${path}.input_count`,
            1,
            1000000,
          ),
          weight: input.decimal(entry.weight, `${path}.weight`, true, true),
          weight_basis: basis as EmbeddingBatchMember["weight_basis"],
        };
      });
    input.done();
    let offset = 0;
    for (const member of members) {
      member.input_start = offset;
      offset += member.input_count;
    }
    // Same scope/price validation and calculator as a single quote; no provider or ledger side effects.
    const result = await this.quote(req, raw.quote);
    try {
      return {
        simulation: true,
        allocation: allocateBatchCost("simulation", result.cost, members),
        warnings: result.warnings,
      };
    } catch {
      throw new PricingRepositoryError(
        "pricing_invalid_document",
        "Invalid batch allocation quantities, membership or physical-cost evidence",
        400,
      );
    }
  }

  @Get("calendar/runtime")
  calendarRuntime() {
    return {
      tzdb_version: process.versions.tz ?? "unknown",
      today: new Date().toISOString().slice(0, 10),
    };
  }

  @Post("calendar/preview")
  @RequireDashboardRole("viewer")
  calendar(@Body() value: unknown) {
    const input = new PricingApiInput(value);
    const raw = input.body(["calendar", "date"]);
    const date = input.string(raw.date, "date");
    input.done();
    const calendar = CompiledPricingCalendar.compile(raw.calendar);
    try {
      return {
        simulation: true,
        calendar: calendar.document(),
        segments: calendar.previewDate(date),
      };
    } catch (error) {
      throw new PricingRepositoryError(
        "pricing_calendar_unavailable",
        (error as Error).message,
        400,
      );
    }
  }

  @Post("calendar/week-preview")
  @RequireDashboardRole("viewer")
  calendarWeek(@Body() value: unknown) {
    const input = new PricingApiInput(value), raw = input.body(["calendar", "date"]);
    const date = input.string(raw.date, "date", 10);
    input.done();
    return previewPricingCalendarWeek(raw.calendar, date);
  }

  @Post("import/validate")
  @RequireDashboardRole("viewer")
  async validateImport(@Req() req: PricingRequest, @Body() value: unknown) {
    const input = new PricingApiInput(value);
    const raw = input.body(["format", "content", "definition", "catalog", "evaluated_at"]);
    if (raw.format === "legacy-gateway-config") {
      if (raw.definition !== undefined) input.invalid("definition", "A gateway import is a proposal, not an existing immutable parent recipe");
      const evaluated = raw.evaluated_at === undefined ? new Date().toISOString() : input.string(raw.evaluated_at, "evaluated_at", 64);
      input.done();
      try { return { valid: true, ...planPricingConfigImport(raw.content, { catalog: raw.catalog, evaluated_at: evaluated }) }; }
      catch (error) { throw new PricingRepositoryError("pricing_invalid_document", error instanceof PricingConfigImportError ? error.message : "Gateway pricing import is invalid", 400); }
    }
    if (raw.catalog !== undefined || raw.evaluated_at !== undefined) input.invalid("format", "Catalog snapshots and evaluation time are only valid for whole gateway imports");
    if (raw.format === "siftgate-inherited-price-book-v1") {
      if (raw.content !== undefined)
        input.invalid(
          "content",
          "Inherited imports contain an explicit parent recipe, not trusted expanded prices",
        );
      input.done();
      const result = await this.repository.previewInheritance(
        await this.actor(req),
        { scope: "workspace", definition: raw.definition },
      );
      return { ...result, valid: true, format: raw.format };
    }
    if (raw.definition !== undefined)
      input.invalid(
        "definition",
        "Use the inherited-price import format rather than silently discarding a recipe",
      );
    if (
      raw.format !== "siftgate-price-book-v1" &&
      raw.format !== "legacy-token-pricing"
    )
      input.invalid("format", "Unsupported pricing import format");
    input.done();
    let content = raw.content;
    if (raw.format === "legacy-token-pricing") {
      const legacy = input.object(content, "content", [
        "input",
        "output",
        "cache_creation_input",
        "cache_read_input",
        "cache_write_per_1m_tokens",
        "cache_read_per_1m_tokens",
      ]);
      input.done();
      try {
        content = legacyTokenPriceBook(legacy as unknown as ModelPricing);
      } catch (error) {
        throw new PricingRepositoryError(
          "pricing_invalid_document",
          (error as Error).message,
          400,
        );
      }
    }
    return { dry_run: true, ...this.repository.validateDraftContent(content) };
  }

  @Get("books/:id/export")
  async export(
    @Req() req: PricingRequest,
    @Param("id") id: string,
    @Query("version_id") version: string,
  ) {
    if (!version)
      throw new PricingRepositoryError(
        "pricing_invalid_document",
        "Choose an immutable version to export",
        400,
      );
    const record = await this.repository.getVersion(
      await this.actor(req),
      id,
      version,
    );
    if (record.inheritance) {
      const definition = structuredClone(record.inheritance.definition);
      definition.source = portableSource(definition.source);
      return { format: "siftgate-inherited-price-book-v1", definition };
    }
    const content: PriceBookContent = structuredClone(record.content);
    content.source = portableSource(content.source);
    return { format: "siftgate-price-book-v1", content };
  }

  private async actor(req: PricingRequest): Promise<PricingActor> {
    if (!req.dashboardUserId || !req.workspaceId || !req.dashboardRole)
      throw new PricingRepositoryError(
        "pricing_permission_denied",
        "Authenticated workspace context is required",
        403,
      );
    return {
      id: req.dashboardUserId,
      workspace_id: req.workspaceId,
      role: req.dashboardRole,
      global_admin:
        (await this.memberships.findActiveRole(
          req.dashboardUserId,
          DEFAULT_WORKSPACE_ID,
        )) === "admin",
    };
  }
}

function portableSource(
  value: PriceBookContent["source"],
): PriceBookContent["source"] {
  const source = { ...value };
  if (source.reference)
    try {
      const url = new URL(source.reference);
      // Normalize the optional DNS root dot before deciding whether a host is private.
      const host = url.hostname.replace(/\.+$/, '').toLowerCase();
      if (
        !["https:", "http:"].includes(url.protocol) ||
        !host.includes(".") ||
        isIP(host.replace(/^\[|\]$/g, "")) ||
        /\.(localhost|local|internal)$/.test(host)
      )
        delete source.reference;
      else {
        url.username = "";
        url.password = "";
        url.search = "";
        url.hash = "";
        source.reference = url.toString();
      }
    } catch {
      delete source.reference;
    }
  return source;
}

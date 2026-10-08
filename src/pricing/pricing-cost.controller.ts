import { PricingReplayService } from "./pricing-replay.service";
import type { Request, Response } from "express";
import { CostReportService } from "./cost-report.service";
import { PricingGroupDispositionService } from "./pricing-group-disposition.service";
import { RECOVERY_VIEWS, type RecoveryView } from "./pricing-recovery-inventory";
import { PricingAttemptCorrectionService } from './pricing-attempt-correction.service';
import { PricingUsageRecoveryService } from './pricing-usage-recovery.service';
import { PricingResolutionService } from "./pricing-resolution.service";
import { PricingCorrectionService } from "./pricing-correction.service";
import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseFilters,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { DataSource } from "typeorm";
import { DashboardGuard } from "../auth/dashboard.guard";
import { DashboardRbacGuard } from "../auth/dashboard-rbac.guard";
import { RequireDashboardRole } from "../auth/dashboard-rbac";
import { CallLog } from "../database/entities/call-log.entity";
import { workspaceFindWhere } from "../workspaces/workspace-scope";
import { PricingRepositoryError } from "./pricing-repository.types";
import { PricingExceptionFilter } from "./pricing-exception.filter";
import { PricingWriteGuard } from "./pricing-write.guard";
import { CostLedgerService } from "./cost-ledger.service";
import { PricingRepository } from "./pricing-repository";
import { PricingApiInput } from "./pricing-api-input";
import type { PricingActor } from "./pricing-repository.types";
import type { PricingLogCost } from "./pricing-log.types";
import type { RuntimeOutcomeState } from "./pricing-outcome-inbox";
import { PricingOutcomeDispositionService } from "./pricing-outcome-disposition.service";

interface RequestActor {
  aborted?: boolean;
  once?: Request["once"];
  off?: Request["off"];
  res?: Response;
  dashboardUserId?: string;
  workspaceId?: string;
  dashboardRole?: PricingActor["role"];
}

@Controller("api/dashboard")
@UseGuards(DashboardGuard, DashboardRbacGuard, PricingWriteGuard)
@UseFilters(PricingExceptionFilter)
@ApiTags("Pricing")
@ApiBearerAuth("dashboardSession")
export class PricingCostController {
  constructor(
    private readonly ledger: CostLedgerService,
    private readonly prices: PricingRepository,
    private readonly dataSource: DataSource,
    private readonly corrections: PricingCorrectionService,
    private readonly resolutions: PricingResolutionService,
    private readonly usageRecovery: PricingUsageRecoveryService,
    private readonly attemptCorrections: PricingAttemptCorrectionService,
    private readonly outcomeDispositions: PricingOutcomeDispositionService,
    private readonly groupDispositions: PricingGroupDispositionService,
    private readonly reports: CostReportService,
    private readonly replays: PricingReplayService,
  ) {}

  @Get("pricing/runtime-group-outcomes")
  @RequireDashboardRole("operator")
  runtimeGroupOutcomes(
    @Req() req: RequestActor,
    @Query() query: Record<string, unknown>,
  ) {
    const reader = new PricingApiInput(query),
      raw = reader.body(["state", "limit", "cursor"]);
    const state =
      raw.state === undefined
        ? "review_required"
        : reader.string(raw.state, "state");
    const limit =
      raw.limit === undefined ? "20" : reader.string(raw.limit, "limit", 2);
    if (!["pending", "delivered", "review_required"].includes(state))
      reader.invalid("state", "Unsupported group outcome state");
    if (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 50)
      reader.invalid("limit", "Expected an integer from1 to50");
    const cursor =
      raw.cursor === undefined
        ? undefined
        : reader.string(raw.cursor, "cursor", 2048);
    reader.done();
    return this.ledger.runtimeGroupOutcomeInventory(
      this.actor(req).workspace_id,
      state as RuntimeOutcomeState,
      Number(limit),
      cursor,
    );
  }

  @Get("pricing/runtime-group-outcomes/:id")
  @RequireDashboardRole("operator")
  runtimeGroupOutcome(@Req() req: RequestActor, @Param("id") id: string) {
    return this.ledger.runtimeGroupOutcome(id, this.actor(req).workspace_id);
  }

  @Get("pricing/runtime-group-outcomes/:id/disposition-basis")
  @RequireDashboardRole("operator")
  groupDispositionBasis(@Req() req: RequestActor,@Param("id") id:string){return this.ledger.groupDispositionBasis(id,this.actor(req).workspace_id);}

  @Post("pricing/runtime-group-outcomes/:id/disposition/preview")
  @RequireDashboardRole("admin")
  previewGroupDisposition(@Req() req:RequestActor,@Param("id") id:string,@Body() value:unknown){return this.groupDispositions.dispose(this.actor(req),id,value,true);}

  @Post("pricing/runtime-group-outcomes/:id/disposition")
  @RequireDashboardRole("admin")
  disposeGroupOutcome(@Req() req:RequestActor,@Param("id") id:string,@Body() value:unknown){return this.groupDispositions.dispose(this.actor(req),id,value,false);}

  @Get("pricing/runtime-group-outcomes/:id/dispositions/:operationId")
  @RequireDashboardRole("operator")
  groupDispositionStatus(@Req() req:RequestActor,@Param("id") id:string,@Param("operationId") operationId:string){return this.ledger.groupDispositionStatus(id,this.actor(req).workspace_id,operationId);}

  @Get("pricing/runtime-outcomes")
  @RequireDashboardRole("operator")
  runtimeOutcomes(@Req() req: RequestActor, @Query() query: Record<string, unknown>) {
    const reader = new PricingApiInput(query), raw = reader.body(["state", "limit", "cursor"]);
    const state = raw.state === undefined ? "review_required" : reader.string(raw.state, "state");
    const limit = raw.limit === undefined ? "20" : reader.string(raw.limit, "limit", 2);
    if (!["pending", "delivered", "review_required"].includes(state)) reader.invalid("state", "Unsupported outcome state");
    if (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 50) reader.invalid("limit", "Expected an integer from 1 to 50");
    const cursor = raw.cursor === undefined ? undefined : reader.string(raw.cursor, "cursor", 2048); reader.done();
    return this.ledger.runtimeOutcomeInventory(this.actor(req).workspace_id, state as RuntimeOutcomeState, Number(limit), cursor);
  }

  @Get("pricing/runtime-outcomes/:id")
  @RequireDashboardRole("operator")
  runtimeOutcome(@Req() req: RequestActor, @Param("id") id: string) { return this.ledger.runtimeOutcome(id, this.actor(req).workspace_id); }

  @Get("pricing/runtime-outcomes/:id/disposition-basis")
  @RequireDashboardRole("operator")
  outcomeDispositionBasis(@Req() req: RequestActor, @Param("id") id: string) { return this.ledger.outcomeDispositionBasis(id, this.actor(req).workspace_id); }

  @Post("pricing/runtime-outcomes/:id/disposition/preview")
  @RequireDashboardRole("admin")
  previewOutcomeDisposition(@Req() req: RequestActor, @Param("id") id: string, @Body() value: unknown) { return this.outcomeDispositions.dispose(this.actor(req), id, value, true); }

  @Post("pricing/runtime-outcomes/:id/disposition")
  @RequireDashboardRole("admin")
  disposeOutcome(@Req() req: RequestActor, @Param("id") id: string, @Body() value: unknown) { return this.outcomeDispositions.dispose(this.actor(req), id, value, false); }

  @Get("pricing/runtime-outcomes/:id/dispositions/:operationId")
  @RequireDashboardRole("operator")
  outcomeDispositionStatus(@Req() req: RequestActor, @Param("id") id: string, @Param("operationId") operationId: string) { return this.ledger.outcomeDispositionStatus(id, this.actor(req).workspace_id, operationId); }

  @Get("pricing/recovery-cases")
  @RequireDashboardRole("operator")
  async recoveryCases(@Req() req: RequestActor) {
    const actor = this.actor(req);
    return { items: await this.ledger.recoveryCases(actor.workspace_id), limit: 100, read_only: true };
  }

  @Get("pricing/recovery-inventory")
  @RequireDashboardRole("operator")
  recoveryInventory(@Req() req: RequestActor, @Query() query: Record<string, unknown>) {
    const reader = new PricingApiInput(query);
    const raw = reader.body(["view", "limit", "cursor"]);
    const view = raw.view === undefined ? "open" : reader.string(raw.view, "view") as RecoveryView;
    if (!RECOVERY_VIEWS.includes(view)) reader.invalid("view", "Unsupported recovery inventory view");
    const text = raw.limit === undefined ? "20" : reader.string(raw.limit, "limit", 2);
    if (!/^\d+$/.test(text) || Number(text) < 1 || Number(text) > 50) reader.invalid("limit", "Expected an integer from 1 to 50");
    const cursor = raw.cursor === undefined ? undefined : reader.string(raw.cursor, "cursor", 2048);
    reader.done();
    return this.ledger.recoveryInventory(this.actor(req).workspace_id, { view, limit: Number(text), cursor });
  }

  @Get("pricing/recovery-cases/:id/resolutions/:resolutionId")
  @RequireDashboardRole("operator")
  recoveryResolutionStatus(@Req() req: RequestActor, @Param("id") id: string, @Param("resolutionId") resolutionId: string) {
    return this.ledger.recoveryResolutionStatus(id, this.actor(req).workspace_id, resolutionId);
  }

  @Get("pricing/recovery-cases/:id/basis")
  @RequireDashboardRole("operator")
  recoveryBasis(@Req() req: RequestActor, @Param("id") id: string) { return this.resolutions.basis(this.actor(req), id); }

  @Post('pricing/recovery-cases/:id/missing-usage/preview')
  @RequireDashboardRole('admin')
  previewRecoveredUsage(@Req() req: RequestActor, @Param('id') id: string, @Body() value: unknown) {
    return this.usageRecovery.recover(this.actor(req), id, value, true);
  }

  @Post('pricing/recovery-cases/:id/missing-usage')
  @RequireDashboardRole('admin')
  recoverMissingUsage(@Req() req: RequestActor, @Param('id') id: string, @Body() value: unknown) {
    return this.usageRecovery.recover(this.actor(req), id, value, false);
  }

  @Get('pricing/recovery-cases/:id/missing-usage/:recoveryId')
  @RequireDashboardRole('operator')
  recoveredUsageStatus(@Req() req: RequestActor, @Param('id') id: string, @Param('recoveryId') recoveryId: string) {
    return this.ledger.usageRecoveryStatus(id, this.actor(req).workspace_id, recoveryId);
  }

  @Post("pricing/recovery-cases/:id/preview")
  @RequireDashboardRole("admin")
  previewRecovery(@Req() req: RequestActor, @Param("id") id: string, @Body() value: unknown) { return this.resolutions.resolve(this.actor(req), id, value, true); }

  @Post("pricing/recovery-cases/:id/resolve")
  @RequireDashboardRole("admin")
  resolveRecovery(@Req() req: RequestActor, @Param("id") id: string, @Body() value: unknown) { return this.resolutions.resolve(this.actor(req), id, value, false); }

  @Get("logs/:id/cost-breakdown")
  async costBreakdown(
    @Req() req: RequestActor,
    @Param("id") id: string,
  ): Promise<PricingLogCost> {
    const actor = this.actor(req);
    if (!/^\d+$/.test(id) || !Number.isSafeInteger(Number(id)))
      throw new PricingRepositoryError(
        "pricing_invalid_document",
        "Invalid log ID",
        400,
      );
    const log = await this.dataSource.getRepository(CallLog).findOne({
      where: workspaceFindWhere(actor.workspace_id, { id: Number(id) }),
      select: [
        "id",
        "request_id",
        "timestamp",
        "model",
        "node_id",
        "source_format",
        "status_code",
        "input_tokens",
        "output_tokens",
        "cost_usd",
        "cost_without_cache_usd",
      ],
    });
    if (!log)
      throw new PricingRepositoryError(
        "pricing_not_found",
        "Log not found in this workspace",
        404,
      );
    const ledgerCost = await this.ledger.summary(log.request_id, actor.workspace_id);
    const compact = ledgerCost ? null : (await this.reports.logSummaries(actor, { ids: String(log.id) })).rows[0];
    const legacy = compact?.basis === "legacy_log";
    const cost = ledgerCost ?? {
      request_id: log.request_id,
      status: legacy ? "legacy_estimate" as const : "unpriced" as const,
      report_currency: "USD" as const,
      amount: legacy ? String(log.cost_usd) : null,
      replayable: false as const,
      reason: legacy ? "No immutable pricing evidence exists for this legacy record" : "Request snapshot exists but its cost evidence is not available",
    };
    return {
      ...cost,
      log: {
        id: log.id,
        request_id: log.request_id,
        timestamp: new Date(log.timestamp).toISOString(),
        model: log.model,
        node_id: log.node_id,
        source_format: log.source_format,
        status_code: log.status_code,
        input_tokens: log.input_tokens,
        output_tokens: log.output_tokens,
        stored_cost_usd: String(log.cost_usd),
        stored_reference_cost_usd:
          log.cost_without_cache_usd == null
            ? null
            : String(log.cost_without_cache_usd),
      },
    };
  }

  @Get("pricing/requests/:id/cost")
  async requestCost(@Req() req: RequestActor, @Param("id") id: string) {
    const result = await this.ledger.summary(id, this.actor(req).workspace_id);
    if (!result)
      throw new PricingRepositoryError(
        "pricing_not_found",
        "Request pricing evidence not found in this workspace",
        404,
      );
    return result;
  }

  @Post("pricing/replay")
  @RequireDashboardRole("viewer")
  async replay(@Req() req: RequestActor, @Body() value: unknown) {
    const abort = new AbortController();
    const cancelled = () => abort.abort();
    const closed = () => { if (!req.res?.writableEnded) cancelled(); };
    req.once?.("aborted", cancelled); req.res?.once("close", closed);
    if (req.aborted) cancelled();
    try { return await this.replays.replay(this.actor(req), value, abort.signal); }
    finally { req.off?.("aborted", cancelled); req.res?.off("close", closed); }
  }

  @Get('pricing/attempts/:id/correction-basis')
  @RequireDashboardRole('operator')
  attemptCorrectionBasis(@Req() req: RequestActor, @Param('id') id: string) { return this.ledger.attemptCorrectionBasis(id, this.actor(req).workspace_id); }

  @Post('pricing/attempts/:id/correction/preview')
  @RequireDashboardRole('admin')
  previewAttemptCorrection(@Req() req: RequestActor, @Param('id') id: string, @Body() value: unknown) { return this.attemptCorrections.correct(this.actor(req), id, value, true); }

  @Post('pricing/attempts/:id/correction')
  @RequireDashboardRole('admin')
  applyAttemptCorrection(@Req() req: RequestActor, @Param('id') id: string, @Body() value: unknown) { return this.attemptCorrections.correct(this.actor(req), id, value, false); }

  @Get('pricing/attempts/:id/corrections/:correctionId')
  @RequireDashboardRole('operator')
  attemptCorrectionStatus(@Req() req: RequestActor, @Param('id') id: string, @Param('correctionId') correctionId: string) { return this.ledger.attemptCorrectionStatus(this.actor(req).workspace_id, id, correctionId); }

  @Post("pricing/attempts/:id/batch-correction/preview")
  @RequireDashboardRole("admin")
  previewBatchCorrection(
    @Req() req: RequestActor,
    @Param("id") id: string,
    @Body() value: unknown,
  ) {
    return this.corrections.correctBatch(
      this.actor(req),
      id,
      this.batchCorrectionInput(value),
      true,
    );
  }

  @Post("pricing/attempts/:id/batch-correction")
  @RequireDashboardRole("admin")
  applyBatchCorrection(
    @Req() req: RequestActor,
    @Param("id") id: string,
    @Body() value: unknown,
  ) {
    return this.corrections.correctBatch(
      this.actor(req),
      id,
      this.batchCorrectionInput(value),
      false,
    );
  }

  private batchCorrectionInput(value: unknown) {
    const reader = new PricingApiInput(value);
    const raw = reader.body([
      "id",
      "expected_physical_cost_hash",
      "reason",
      "confirm",
      "evidence",
    ]);
    const id = reader.string(raw.id, "id", 128);
    const hash = reader.string(
      raw.expected_physical_cost_hash,
      "expected_physical_cost_hash",
      64,
    );
    if (!/^[a-f0-9]{64}$/.test(hash))
      reader.invalid(
        "expected_physical_cost_hash",
        "Expected a physical cost hash",
      );
    const reason = reader.string(raw.reason, "reason", 1000);
    if (!reason.trim())
      reader.invalid("reason", "A correction reason is required");
    if (raw.confirm !== true)
      reader.invalid("confirm", "Correction requires explicit confirmation");
    const evidence = reader.evidence(raw.evidence);
    reader.done();
    return { id, expectedPhysicalCostHash: hash, reason, evidence };
  }

  private actor(req: RequestActor): PricingActor {
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
      global_admin: false,
    };
  }
}

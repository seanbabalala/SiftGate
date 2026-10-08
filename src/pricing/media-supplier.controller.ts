import { MediaEventDispositionService } from "./media-event-disposition.service";
import { MediaJobLookupService } from "./media-job-lookup.service";
import { parseMediaPage } from "./media-inventory";
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseFilters,
  UseGuards,
} from "@nestjs/common";
import { DashboardGuard } from "../auth/dashboard.guard";
import { DashboardRbacGuard } from "../auth/dashboard-rbac.guard";
import { RequireDashboardRole } from "../auth/dashboard-rbac";
import { PricingWriteGuard } from "./pricing-write.guard";
import { PricingExceptionFilter } from "./pricing-exception.filter";
import { MediaSupplierService } from "./media-supplier.service";
import type { PricingActor } from "./pricing-repository.types";
import { mediaSupplierError } from "./media-supplier-event";

interface MediaRequest {
  dashboardUserId?: string;
  workspaceId?: string;
  dashboardRole?: PricingActor["role"];
}
@Controller("api/dashboard/pricing")
@UseGuards(DashboardGuard, DashboardRbacGuard, PricingWriteGuard)
@UseFilters(PricingExceptionFilter)
export class MediaSupplierManagementController {
  constructor(
    private readonly suppliers: MediaSupplierService,
    private readonly lookups: MediaJobLookupService,
    private readonly dispositions: MediaEventDispositionService,
  ) {}
  private actor(req: MediaRequest): PricingActor {
    return {
      id: req.dashboardUserId ?? "",
      workspace_id: req.workspaceId ?? "",
      role: req.dashboardRole ?? "viewer",
      global_admin: false,
    };
  }
  @Get("media-event-sources")
  @RequireDashboardRole("operator")
  sources(@Req() req: MediaRequest, @Query() query: Record<string, unknown>) {
    return this.suppliers.sources(this.actor(req), parseMediaPage(query));
  }
  @Get("media-event-sources/:id")
  @RequireDashboardRole("operator")
  source(@Req() req:MediaRequest,@Param('id') id:string){return this.suppliers.sourceDetail(this.actor(req),id);}
  @Put("media-event-sources/:id")
  @RequireDashboardRole("admin")
  configure(
    @Req() req: MediaRequest,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return this.suppliers.configure(this.actor(req), id, body);
  }
  @Get("media-tasks/:id/supplier-events")
  @RequireDashboardRole("operator")
  events(
    @Req() req: MediaRequest,
    @Param("id") id: string,
    @Query() query: Record<string, unknown>,
  ) {
    return this.suppliers.events(this.actor(req), id, parseMediaPage(query));
  }
  @Get("media-tasks")
  @RequireDashboardRole("operator")
  tasks(@Req() req: MediaRequest, @Query() query: Record<string, unknown>) {
    return this.suppliers.inventory(
      this.actor(req),
      parseMediaPage(query, true),
    );
  }
  @Get("media-tasks/:id")
  @RequireDashboardRole("operator")
  task(@Req() req: MediaRequest, @Param("id") id: string) {
    return this.suppliers.detail(this.actor(req), id);
  }
  @Get("media-tasks/:id/supplier-events/:eventId")
  @RequireDashboardRole("operator")
  event(
    @Req() req: MediaRequest,
    @Param("id") id: string,
    @Param("eventId") eventId: string,
  ) {
    return this.suppliers.event(this.actor(req), id, eventId);
  }

  @Get("media-tasks/:id/supplier-events/:eventId/disposition-basis")
  @RequireDashboardRole("operator")
  dispositionBasis(@Req() req: MediaRequest, @Param("id") id: string, @Param("eventId") event: string) {
    return this.dispositions.basis(this.actor(req), id, event);
  }
  @Post("media-tasks/:id/supplier-events/:eventId/disposition/preview")
  @RequireDashboardRole("admin")
  previewDisposition(@Req() req: MediaRequest, @Param("id") id: string, @Param("eventId") event: string, @Body() body: unknown) {
    return this.dispositions.preview(this.actor(req), id, event, body);
  }
  @Post("media-tasks/:id/supplier-events/:eventId/disposition")
  @RequireDashboardRole("admin")
  applyDisposition(@Req() req: MediaRequest, @Param("id") id: string, @Param("eventId") event: string, @Body() body: unknown) {
    return this.dispositions.apply(this.actor(req), id, event, body);
  }
  @Get("media-tasks/:id/supplier-events/:eventId/dispositions/:operationId")
  @RequireDashboardRole("admin")
  dispositionStatus(@Req() req: MediaRequest, @Param("id") id: string, @Param("eventId") event: string, @Param("operationId") operationId: string) {
    return this.dispositions.status(this.actor(req), id, event, operationId);
  }

  @Get("media-tasks/:id/job-lookup-basis")
  @RequireDashboardRole("operator")
  lookupBasis(@Req() req: MediaRequest, @Param("id") id: string) {
    return this.lookups.basis(this.actor(req), id);
  }
  @Post("media-tasks/:id/job-lookup/preview")
  @RequireDashboardRole("admin")
  previewLookup(
    @Req() req: MediaRequest,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return this.lookups.preview(this.actor(req), id, body);
  }
  @Post("media-tasks/:id/job-lookup")
  @RequireDashboardRole("admin")
  applyLookup(
    @Req() req: MediaRequest,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return this.lookups.apply(this.actor(req), id, body);
  }
  @Get("media-tasks/:id/job-lookups/:operationId")
  @RequireDashboardRole("admin")
  lookupStatus(
    @Req() req: MediaRequest,
    @Param("id") id: string,
    @Param("operationId") operationId: string,
  ) {
    return this.lookups.status(this.actor(req), id, operationId);
  }
}
/** No dashboard/gateway key substitutes for an authenticated source signature. No sources are enabled by default. */
@Controller("api/pricing/media-events")
@UseFilters(PricingExceptionFilter)
export class MediaSupplierEventController {
  constructor(private readonly suppliers: MediaSupplierService) {}
  @Post(":sourceId")
  @HttpCode(202)
  receive(
    @Param("sourceId") id: string,
    @Body() body: unknown,
    @Headers("content-type") contentType: string,
    @Headers("x-siftgate-media-time") timestamp: string,
    @Headers("x-siftgate-media-revision") revision: string,
    @Headers("x-siftgate-media-signature") signature: string,
  ) {
    if (
      typeof contentType !== "string" ||
      !/^application\/json(?:\s*;|$)/i.test(contentType) ||
      typeof timestamp !== "string" ||
      typeof revision !== "string" ||
      typeof signature !== "string"
    )
      mediaSupplierError("Media event authentication failed", 401);
    return this.suppliers.receive(id, body, { timestamp, revision, signature });
  }
}

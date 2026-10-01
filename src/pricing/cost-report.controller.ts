import { Controller, Get, Param, Query, Req, UseFilters, UseGuards } from '@nestjs/common';
import { DashboardGuard } from '../auth/dashboard.guard';
import { DashboardRbacGuard } from '../auth/dashboard-rbac.guard';
import { PricingExceptionFilter } from './pricing-exception.filter';
import { CostReportService } from './cost-report.service';
import { HistoricalFxService } from './historical-fx.service';
import type { PricingActor } from './pricing-repository.types';

@Controller('api/dashboard/pricing')
@UseGuards(DashboardGuard, DashboardRbacGuard)
@UseFilters(PricingExceptionFilter)
export class CostReportController {
  constructor(private readonly reports: CostReportService, private readonly historicalFx: HistoricalFxService) {}
  private actor(req: { dashboardUserId?: string; workspaceId?: string; dashboardRole?: PricingActor['role'] }): PricingActor {
    return { id: req.dashboardUserId ?? '', workspace_id: req.workspaceId ?? '', role: req.dashboardRole ?? 'viewer', global_admin: false };
  }
  @Get('cost-report')
  page(@Req() req: Parameters<CostReportController['actor']>[0], @Query() query: unknown) { return this.reports.page(this.actor(req), query); }
  @Get('log-cost-summaries')
  logs(@Req() req: Parameters<CostReportController['actor']>[0], @Query() query: unknown) { return this.reports.logSummaries(this.actor(req), query); }
  @Get('requests/:id/fx/:version')
  fx(@Req() req: Parameters<CostReportController['actor']>[0], @Param('id') id: string, @Param('version') version: string, @Query() query: unknown) {
    return this.historicalFx.read(this.actor(req), id, version, query);
  }
}

import { Body, Controller, Get, Header, Param, Post, Query, Req, ForbiddenException, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { DashboardGuard } from '../auth/dashboard.guard';
import { DashboardRbacGuard } from '../auth/dashboard-rbac.guard';
import { RequireDashboardRole } from '../auth/dashboard-rbac';
import { LaunchpadService } from './launchpad.service';
import { LaunchpadCreateKeyDto, LaunchpadPrepareDto, LaunchpadQueryDto } from './launchpad.dto';

@Controller('api/dashboard/launchpad')
@UseGuards(DashboardGuard, DashboardRbacGuard)
@ApiTags('Customer Launchpad')
@ApiBearerAuth('dashboardSession')
export class LaunchpadController {
  constructor(private readonly service: LaunchpadService) {}
  private sameOrigin(req: { headers: Record<string, string | string[] | undefined> }) {
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none') throw new ForbiddenException();
    const origin = req.headers.origin;
    if (origin) {
      try { if (typeof origin !== 'string' || new URL(origin).host !== req.headers.host) throw new Error(); }
      catch { throw new ForbiddenException(); }
    }
  }
  @Get() @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Observe scoped setup readiness; never calls a provider' })
  overview(@Query() query: LaunchpadQueryDto) { return this.service.overview(query); }

  @Post('keys') @RequireDashboardRole('admin') @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Create one bounded, node/model/text-only API key; secret returned once' })
  createKey(@Req() req: any, @Body() body: LaunchpadCreateKeyDto) { this.sameOrigin(req); return this.service.createKey(body); }

  @Post('prepare-test') @RequireDashboardRole('admin') @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Record explicit cost consent and a five-minute test intent; does NOT call a model' })
  prepare(@Req() req: any, @Body() body: LaunchpadPrepareDto) { this.sameOrigin(req); return this.service.prepare(body); }

  @Get('attempts/:id') @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Reconstruct test evidence from scoped audit and call records, without prompt/response bodies' })
  attempt(@Param('id') id: string) { return this.service.attempt(id); }
}

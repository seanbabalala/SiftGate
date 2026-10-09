import { Body, Controller, ForbiddenException, Get, Header, Post, Put, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { DashboardGuard } from '../auth/dashboard.guard';
import { DashboardRbacGuard } from '../auth/dashboard-rbac.guard';
import { RequireDashboardRole } from '../auth/dashboard-rbac';
import { ReleaseUpdatesService } from './release-updates.service';
@Controller('api/dashboard/release-updates')
@UseGuards(DashboardGuard, DashboardRbacGuard)
@ApiTags('Release notifications')
export class ReleaseUpdatesController {
  constructor(private readonly updates: ReleaseUpdatesService) {}
  private sameOrigin(req: Request) {
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none') throw new ForbiddenException();
    if (req.headers.origin) {
      try { if (new URL(req.headers.origin).host !== req.headers.host) throw new Error(); }
      catch { throw new ForbiddenException(); }
    }
  }
  @Get() @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Read cached public release notices. Does not contact GitHub or grant deployment authority.' })
  status() { return this.updates.status(); }
  @Post('check') @RequireDashboardRole('admin') @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Rate-limited public metadata check only; never downloads images or upgrades a gateway.' })
  check(@Req() req: Request) { this.sameOrigin(req); return this.updates.check(); }
  @Put('preferences') @RequireDashboardRole('admin') @Header('Cache-Control', 'no-store')
  preferences(@Req() req: Request, @Body() body: unknown) { this.sameOrigin(req); return this.updates.preferences(body); }
}

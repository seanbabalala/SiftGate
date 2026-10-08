import { Controller, Get, Header, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { DashboardGuard } from '../auth/dashboard.guard';
import { DashboardRbacGuard } from '../auth/dashboard-rbac.guard';
import { RequireDashboardRole } from '../auth/dashboard-rbac';
import { OperatorStatusService } from './operator-status.service';

@Controller('api/dashboard/operator')
@UseGuards(DashboardGuard, DashboardRbacGuard)
@RequireDashboardRole('admin')
@ApiTags('Host Operator observations')
export class OperatorStatusController {
  constructor(private readonly status: OperatorStatusService) {}
  @Get('status') @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Read sanitized instance-bound host operator metadata; does not grant upgrade or host execution permissions' })
  read() { return this.status.read(); }
}

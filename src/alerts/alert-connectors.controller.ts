import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Param, Post, Put, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { DashboardGuard } from '../auth/dashboard.guard';
import { DashboardRbacGuard } from '../auth/dashboard-rbac.guard';
import { RequireDashboardRole } from '../auth/dashboard-rbac';
import { WorkspaceMembershipService } from '../auth/workspace-membership.service';
import { DEFAULT_WORKSPACE_ID } from '../workspaces/workspace.constants';
import { ManagementAuditService } from '../audit/management-audit.service';
import { AlertConnectorsService } from './alert-connectors.service';
import { AlertService } from './alert.service';

interface ConnectorRequest { dashboardUserId?: string; workspaceId?: string; }

@Controller('api/dashboard/alerts/connectors')
@UseGuards(DashboardGuard, DashboardRbacGuard)
@RequireDashboardRole('admin')
@ApiTags('Dashboard')
@ApiBearerAuth('dashboardSession')
export class AlertConnectorsController {
  constructor(private readonly connectors: AlertConnectorsService, private readonly alerts: AlertService,
    private readonly memberships: WorkspaceMembershipService, private readonly audit: ManagementAuditService) {}

  private async authorize(req: ConnectorRequest): Promise<void> {
    // Configuration is gateway-wide. An admin of another workspace must not be
    // able to redirect notifications carrying other workspaces' metadata.
    if (!req.dashboardUserId || await this.memberships.findActiveRole(req.dashboardUserId, DEFAULT_WORKSPACE_ID) !== 'admin') {
      throw new ForbiddenException('Gateway alert connectors require administrator access to the default workspace.');
    }
  }

  @Get()
  @ApiOperation({ summary: 'Get credential-redacted gateway alert connector settings' })
  async list(@Req() req: ConnectorRequest) { await this.authorize(req); return this.connectors.snapshot(); }

  @Post()
  @ApiOperation({ summary: 'Create a disabled-by-default alert connector; does not send a message' })
  async create(@Req() req: ConnectorRequest, @Body() body: { revision?: unknown; channel?: unknown }) {
    await this.authorize(req);
    const result = await this.connectors.saveChannel(null, body?.channel, body?.revision);
    await this.record(req, 'created');
    return result;
  }

  @Put('enabled')
  @ApiOperation({ summary: 'Enable or pause gateway alert delivery without restarting the gateway' })
  async enabled(@Req() req: ConnectorRequest, @Body() body: { revision?: unknown; enabled?: unknown }) {
    await this.authorize(req);
    const result = await this.connectors.setEnabled(body?.enabled, body?.revision);
    await this.record(req, 'master_updated');
    return result;
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update a connector while preserving omitted credentials' })
  async update(@Req() req: ConnectorRequest, @Param('id') id: string, @Body() body: { revision?: unknown; channel?: unknown }) {
    await this.authorize(req);
    const result = await this.connectors.saveChannel(id, body?.channel, body?.revision);
    await this.record(req, 'updated', id);
    return result;
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Remove an alert connector' })
  async remove(@Req() req: ConnectorRequest, @Param('id') id: string, @Body() body: { revision?: unknown }) {
    await this.authorize(req);
    const result = await this.connectors.removeChannel(id, body?.revision);
    await this.record(req, 'deleted', id);
    return result;
  }

  @Post(':id/test')
  @ApiOperation({ summary: 'Explicitly send one test message to a saved connector, even when automatic alerts are paused' })
  async test(@Req() req: ConnectorRequest, @Param('id') id: string, @Body() body: { revision?: unknown; confirm?: unknown }) {
    await this.authorize(req);
    if (body?.confirm !== true) throw new BadRequestException('Explicit confirmation is required to send a real test message.');
    this.connectors.requireRevision(body.revision);
    const result = await this.alerts.testConnector(id, this.connectors.channel(id));
    await this.record(req, 'tested', id, result.status);
    return result;
  }

  private record(req: ConnectorRequest, action: string, id?: string, status?: string) {
    return this.audit.record({ actor: { type: 'dashboard', id: req.dashboardUserId }, workspaceId: DEFAULT_WORKSPACE_ID,
      action: `alerts.connector.${action}`, resourceType: 'alert_connector', resourceId: id,
      metadata: { delivery_status: status || null }, result: status === 'failed' ? 'failure' : 'success' });
  }
}

import {
  Controller,
  DefaultValuePipe,
  Get,
  ParseIntPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { DashboardGuard } from '../auth/dashboard.guard';
import { DashboardRbacGuard } from '../auth/dashboard-rbac.guard';
import { RequireDashboardRole } from '../auth/dashboard-rbac';
import { GATEWAY_DENIAL_REASONS } from '../database/entities/gateway-denial.entity';
import { WorkspaceContextService } from '../workspaces/workspace-context.service';
import { ConfigService } from '../config/config.service';
import { GatewayDenialService } from './gateway-denial.service';
import { computePrivacyPosture } from './privacy-posture';

const PERIOD_EXAMPLE = '24h';
const PERIOD_ENUM = ['1h', '24h', '7d', '30d'];

@Controller('api/dashboard/governance')
@UseGuards(DashboardGuard, DashboardRbacGuard)
@RequireDashboardRole('viewer')
@ApiTags('Governance')
@ApiBearerAuth('dashboardSession')
export class GovernanceController {
  constructor(
    private readonly denials: GatewayDenialService,
    private readonly workspaceContext: WorkspaceContextService,
    private readonly config: ConfigService,
  ) {}

  @Get('denials')
  @ApiOperation({ summary: 'List requests refused by a governance policy' })
  @ApiQuery({ name: 'period', required: false, enum: PERIOD_ENUM, example: PERIOD_EXAMPLE })
  @ApiQuery({ name: 'reason', required: false, enum: [...GATEWAY_DENIAL_REASONS] })
  @ApiQuery({ name: 'api_key_id', required: false })
  @ApiQuery({ name: 'page', required: false, example: 1 })
  @ApiQuery({ name: 'limit', required: false, example: 50 })
  @ApiOkResponse({
    description:
      'Metadata-only records of budget, key-permission and key rate-limit refusals in the active workspace. One row covers up to one minute of the same key and reason; request_count says how many requests it represents. No prompt, response, header or credential is stored.',
  })
  list(
    @Query('period') period: string | undefined,
    @Query('reason') reason: string | undefined,
    @Query('api_key_id') apiKeyId: string | undefined,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
  ) {
    return this.denials.list({
      workspaceId: this.workspaceContext.currentWorkspaceId(),
      period,
      reason,
      apiKeyId,
      page,
      limit,
    });
  }

  @Get('denials/summary')
  @ApiOperation({ summary: 'Count governance refusals by reason and key' })
  @ApiQuery({ name: 'period', required: false, enum: PERIOD_ENUM, example: PERIOD_EXAMPLE })
  @ApiOkResponse({ description: 'Total refused requests, grouped by reason and by gateway key (top 10).' })
  summary(@Query('period') period: string | undefined) {
    return this.denials.summary(this.workspaceContext.currentWorkspaceId(), period);
  }

  @Get('privacy-posture')
  @ApiOperation({ summary: 'Which content stores this gateway has turned on' })
  @ApiOkResponse({
    description:
      'Read-only. Lists every setting that keeps prompt or response content (response cache, semantic cache responses, prompt template bodies, evaluation and shadow samples, system prompt capture) and whether it is on, plus how many configured plugins this check cannot inspect. Returns configuration flags only, never values, paths or secrets.',
  })
  privacyPosture() {
    return computePrivacyPosture(this.config.getFullConfig());
  }
}

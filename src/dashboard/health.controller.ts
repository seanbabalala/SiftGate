// ===================================================================
// HealthController — GET /health
// ===================================================================
// Returns overall gateway health including:
//   - Database connectivity
//   - Per-node circuit breaker status
//   - Budget status
//   - Uptime
// ===================================================================

import {
  Controller,
  Get,
  Inject,
  Logger,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiServiceUnavailableResponse, ApiTags } from '@nestjs/swagger';
import { ConfigService } from '../config/config.service';
import { CircuitBreakerService, CircuitState } from '../routing/circuit-breaker.service';
import { ConcurrencyLimiterService } from '../routing/concurrency-limiter.service';
import { ActiveHealthProbeService } from '../routing/active-health-probe.service';
import { BudgetService, BudgetStatus } from '../budget/budget.service';
import { HealthResponseDto } from '../openapi/openapi.dto';
import { RealtimeProxyService } from '../realtime/realtime-proxy.service';
import { WorkspaceContextService } from '../workspaces/workspace-context.service';
import { DatabaseHealthService } from '../database/database-health.service';

@Controller()
@ApiTags('Health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);
  private readonly startedAt = Date.now();

  constructor(
    private readonly config: ConfigService,
    private readonly circuitBreaker: CircuitBreakerService,
    private readonly concurrencyLimiter: ConcurrencyLimiterService,
    private readonly activeHealth: ActiveHealthProbeService,
    private readonly budgetService: BudgetService,
    @Optional()
    @Inject(RealtimeProxyService)
    private readonly realtime?: RealtimeProxyService,
    @Optional()
    private readonly workspaceContext?: WorkspaceContextService,
    @Optional()
    private readonly databaseHealth?: DatabaseHealthService,
  ) {}

  @Get('live')
  @ApiOperation({ summary: 'Local HTTP liveness; independent of database and provider health' })
  @ApiOkResponse({ description: 'The gateway HTTP event loop can serve requests.' })
  live() {
    return { status: 'alive' };
  }

  @Get('health')
  @ApiOperation({ summary: 'Gateway health, database, budget, and circuit breaker status' })
  @ApiOkResponse({ type: HealthResponseDto })
  async check() {
    const database = await this.checkDatabase();
    const nodes = this.config.nodes.map((node) => {
      const cbStatus = this.circuitBreaker.getNodeStatus(node.id);
      const modelStatuses = this.circuitBreaker.getModelStatuses(node.id);
      const concurrency = this.concurrencyLimiter.getNodeStats(node);
      const activeProbe = this.activeHealth.getNodeStatus(node.id);

      // Build per-model circuit info
      const models: Record<string, {
        state: string;
        consecutiveFailures: number;
        lastFailureAt: string | null;
      }> = {};
      for (const [model, ms] of Object.entries(modelStatuses)) {
        models[model] = {
          state: ms.state,
          consecutiveFailures: ms.consecutiveFailures,
          lastFailureAt: ms.lastFailureAt
            ? new Date(ms.lastFailureAt).toISOString()
            : null,
        };
      }

      return {
        id: node.id,
        name: node.name,
        protocol: node.protocol,
        circuit: cbStatus.state,
        consecutiveFailures: cbStatus.consecutiveFailures,
        lastFailureAt: cbStatus.lastFailureAt
          ? new Date(cbStatus.lastFailureAt).toISOString()
          : null,
        concurrency,
        healthy: cbStatus.state !== CircuitState.OPEN && activeProbe.status !== 'unhealthy',
        active_probe: activeProbe,
        realtime: this.realtime?.getNodeStatus(
          node.id,
          this.workspaceContext?.currentWorkspaceId(),
        ) || {
          enabled: false,
          experimental: true,
          supported: false,
          endpoint: null,
          models: [],
          active_connections: 0,
          max_connections_per_node: 0,
          last_connected_at: null,
          last_closed_at: null,
          last_error: null,
        },
        models,
      };
    });

    const allHealthy = nodes.every((n) => n.healthy);

    let budget: BudgetStatus[];
    try {
      budget = await this.budgetService.getStatus();
    } catch {
      budget = [];
    }

    const uptimeMs = Date.now() - this.startedAt;

    return {
      status: database.healthy && allHealthy ? 'healthy' : 'degraded',
      uptime_ms: uptimeMs,
      uptime_human: this.formatUptime(uptimeMs),
      timestamp: new Date().toISOString(),
      database,
      nodes,
      budget: budget.map((b) => ({
        type: b.type,
        current: this.formatBudgetCurrent(b.type, b.current),
        limit: b.limit,
        percentage: Number((b.percentage * 100).toFixed(1)),
        exceeded: b.isExceeded,
        alert: b.isAlert,
      })),
    };
  }

  @Get('ready')
  @ApiOperation({ summary: 'Gateway readiness for load balancers and Kubernetes probes' })
  @ApiOkResponse({ description: 'Database is available and the gateway can accept traffic.' })
  @ApiServiceUnavailableResponse({
    description: 'Database is unavailable; provider health is intentionally not part of readiness.',
  })
  async ready() {
    const database = await this.checkDatabase();
    const response = {
      ready: database.healthy,
      status: database.healthy ? 'ready' : 'not_ready',
      timestamp: new Date().toISOString(),
      database,
    };
    if (!database.healthy) {
      throw new ServiceUnavailableException(response);
    }
    return response;
  }

  private formatUptime(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  }

  private formatBudgetCurrent(type: string, current: number): number {
    return Number(current.toFixed(type.includes('cost') ? 6 : 4));
  }

  private async checkDatabase() {
    if (this.databaseHealth) {
      return this.databaseHealth.check();
    }
    return {
      healthy: true,
      type: this.config.database.type,
      target:
        this.config.database.type === 'postgres'
          ? 'postgres'
          : this.config.database.path || './data/gateway.db',
      connected: true,
      latency_ms: null,
      checked_at: new Date().toISOString(),
      error: null,
      synchronize: this.config.database.synchronize ?? this.config.database.type === 'sqlite',
    };
  }
}

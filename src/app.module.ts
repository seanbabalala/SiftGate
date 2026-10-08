import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'path';
import { ConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { WorkspacesModule } from './workspaces/workspaces.module';
import { AuditModule } from './audit/audit.module';
import { IngestModule } from './ingest/ingest.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { AuthModule } from './auth/auth.module';
import { PluginModule } from './plugins/plugin.module';
import { TelemetryModule } from './telemetry/telemetry.module';
import { ControlPlaneModule } from './control-plane/control-plane.module';
import { AlertsModule } from './alerts/alerts.module';
import { StateModule } from './state/state.module';
import { ClusterModule } from './cluster/cluster.module';
import { RealtimeModule } from './realtime/realtime.module';
import { McpModule } from './mcp/mcp.module';
import { BatchModule } from './batch/batch.module';
import { EvaluationModule } from './evaluation/evaluation.module';
import { IntelligenceModule } from './intelligence/intelligence.module';
import { CostPlatformModule } from './cost-platform/cost-platform.module';
import { SemanticPlatformModule } from './semantic-platform/semantic-platform.module';
import { PublicGatewayExceptionFilter } from './http/public-gateway-exception.filter';
import { HttpListenerWatchdogService } from './http/http-listener-watchdog.service';
import { PricingModule } from './pricing/pricing.module';

@Module({
  imports: [
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, '..', 'frontend', 'dist'),
      exclude: ['/api{/*path}', '/v1{/*path}', '/mcp{/*path}', '/live{/*path}', '/health{/*path}', '/ready{/*path}', '/cluster{/*path}'],
    }),
    ConfigModule,
    StateModule,
    DatabaseModule,
    WorkspacesModule,
    AuditModule,
    TelemetryModule,
    ControlPlaneModule,
    AlertsModule,
    ClusterModule,
    RealtimeModule,
    McpModule,
    BatchModule,
    EvaluationModule,
    IntelligenceModule,
    CostPlatformModule,
    PricingModule,
    SemanticPlatformModule,
    PluginModule,
    AuthModule,
    IngestModule,
    DashboardModule,
  ],
  providers: [
    HttpListenerWatchdogService,
    {
      provide: APP_FILTER,
      useClass: PublicGatewayExceptionFilter,
    },
  ],
})
export class AppModule {}

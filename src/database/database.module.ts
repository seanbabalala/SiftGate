import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigService } from '../config/config.service';
import { CallLogSchemaPatchService } from './call-log-schema-patch.service';
import { PromptTemplateSchemaPatchService } from './prompt-template-schema-patch.service';
import { RouteFeedbackSchemaPatchService } from './route-feedback-schema-patch.service';
import { GatewayDenialSchemaPatchService } from './gateway-denial-schema-patch.service';
import { WorkspaceSchemaPatchService } from './workspace-schema-patch.service';
import {
  buildTypeOrmDatabaseOptions,
  databaseConnectionSummary,
} from './database-options';
import { DatabaseHealthService } from './database-health.service';
import { SqliteAnalyticsService } from './sqlite-analytics.service';
import {
  BudgetRule,
  CallLog,
  ConfigAuditEvent,
  ConfigVersion,
  AgentProfile,
  GatewayApiKey,
  LocalTeam,
  NodeStatus,
  Organization,
  ProviderCompatibilityResult,
  PromptTemplate,
  RouteDecisionLog,
  RouteFeedback,
  ShadowTrafficResult,
  BatchJob,
  EvalDataset,
  EvalExperimentRun,
  EvalSampleResult,
  VideoJob,
  ManagementAuditEvent,
  GatewayDenial,
  Workspace,
  WorkspaceInvitation,
  WorkspaceMembership,
} from './entities';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const shared = {
          entities: [
            CallLog,
            Organization,
            Workspace,
            WorkspaceInvitation,
            WorkspaceMembership,
            ConfigAuditEvent,
            ConfigVersion,
            BudgetRule,
            NodeStatus,
            AgentProfile,
            GatewayApiKey,
            LocalTeam,
            ShadowTrafficResult,
            RouteDecisionLog,
            RouteFeedback,
            ProviderCompatibilityResult,
            PromptTemplate,
            BatchJob,
            EvalDataset,
            EvalExperimentRun,
            EvalSampleResult,
            VideoJob,
            ManagementAuditEvent,
            GatewayDenial,
          ],
          // Default remains true for the OSS single-node SQLite/dev path.
          // Production PostgreSQL deployments should set database.synchronize=false.
          synchronize: config.database.synchronize ?? true,
          logging: false,
        };

        const summary = databaseConnectionSummary(config.database);
        if (summary.type === 'postgres') {
          console.info(
            [
              'SiftGate PostgreSQL production database configured:',
              `target=${summary.target}`,
              `pool=${summary.pool?.min ?? 0}-${summary.pool?.max ?? 10}`,
              `ssl=${summary.ssl ?? 'disabled'}`,
              `synchronize=${summary.synchronize}`,
            ].join(' '),
          );
        }

        return buildTypeOrmDatabaseOptions(config.database, shared);
      },
    }),
    TypeOrmModule.forFeature([
      CallLog,
      Organization,
      Workspace,
      WorkspaceInvitation,
      WorkspaceMembership,
      ConfigAuditEvent,
      ConfigVersion,
      BudgetRule,
      NodeStatus,
      AgentProfile,
      GatewayApiKey,
      LocalTeam,
      ShadowTrafficResult,
      RouteDecisionLog,
      ProviderCompatibilityResult,
      PromptTemplate,
      RouteFeedback,
      BatchJob,
      EvalDataset,
      EvalExperimentRun,
      EvalSampleResult,
      VideoJob,
      ManagementAuditEvent,
      GatewayDenial,
    ]),
  ],
  providers: [
    CallLogSchemaPatchService,
    PromptTemplateSchemaPatchService,
    RouteFeedbackSchemaPatchService,
    GatewayDenialSchemaPatchService,
    WorkspaceSchemaPatchService,
    DatabaseHealthService,
    SqliteAnalyticsService,
  ],
  exports: [TypeOrmModule, DatabaseHealthService, SqliteAnalyticsService],
})
export class DatabaseModule {}

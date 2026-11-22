import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '../config/config.module';
import { AuthModule } from '../auth/auth.module';
import { GatewayDenial } from '../database/entities/gateway-denial.entity';
import { GatewayDenialService } from './gateway-denial.service';
import { GovernanceController } from './governance.controller';

/**
 * Global so the pipeline and the per-key rate-limit guard can record denials
 * without importing this module (the guard lives in AuthModule).
 */
@Global()
@Module({
  imports: [ConfigModule, AuthModule, TypeOrmModule.forFeature([GatewayDenial])],
  controllers: [GovernanceController],
  providers: [GatewayDenialService],
  exports: [GatewayDenialService],
})
export class GovernanceModule {}

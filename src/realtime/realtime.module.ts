import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '../config/config.module';
import { AuthModule } from '../auth/auth.module';
import { TelemetryModule } from '../telemetry/telemetry.module';
import { RealtimeProxyService } from './realtime-proxy.service';
import { PricingModule } from '../pricing/pricing.module';

@Global()
@Module({
  imports: [ConfigModule, AuthModule, TelemetryModule, PricingModule],
  providers: [RealtimeProxyService],
  exports: [RealtimeProxyService],
})
export class RealtimeModule {}

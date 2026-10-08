import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '../config/config.module';
import { AuthModule } from '../auth/auth.module';
import { AlertService } from './alert.service';
import { AlertsController } from './alerts.controller';
import { AlertConnectorsController } from './alert-connectors.controller';
import { AlertConnectorsService } from './alert-connectors.service';

@Global()
@Module({
  imports: [ConfigModule, AuthModule],
  controllers: [AlertsController, AlertConnectorsController],
  providers: [AlertService, AlertConnectorsService],
  exports: [AlertService],
})
export class AlertsModule {}

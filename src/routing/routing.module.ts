import { PricingModule } from '../pricing/pricing.module';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RoutingService } from './routing.service';
import { CircuitBreakerService } from './circuit-breaker.service';
import { MomentumService } from './momentum.service';
import { ConcurrencyLimiterService } from './concurrency-limiter.service';
import { ActiveHealthProbeService } from './active-health-probe.service';
import { AdaptiveRoutingStatsService } from './adaptive-routing-stats.service';
import { RoutingRecommendationService } from './routing-recommendation.service';
import { CacheAffinityService } from './cache-affinity.service';
import { ConfigModule } from '../config/config.module';
import { CallLog } from '../database/entities/call-log.entity';
import { AlertsModule } from '../alerts/alerts.module';

@Module({
  imports: [ConfigModule, AlertsModule, PricingModule, TypeOrmModule.forFeature([CallLog])],
  providers: [
    RoutingService,
    CircuitBreakerService,
    MomentumService,
    ConcurrencyLimiterService,
    ActiveHealthProbeService,
    AdaptiveRoutingStatsService,
    RoutingRecommendationService,
    CacheAffinityService,
  ],
  exports: [
    RoutingService,
    CircuitBreakerService,
    MomentumService,
    ConcurrencyLimiterService,
    ActiveHealthProbeService,
    AdaptiveRoutingStatsService,
    RoutingRecommendationService,
    CacheAffinityService,
  ],
})
export class RoutingModule {}

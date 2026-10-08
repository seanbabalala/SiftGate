import { CostReportController } from "./cost-report.controller";
import { HistoricalFxService } from "./historical-fx.service";
import { PricingReplayService } from "./pricing-replay.service";
import { RealtimePricingService } from "./realtime-pricing.service";
import { CostReportService } from "./cost-report.service";
import { MediaEventDispositionService } from "./media-event-disposition.service";
import { MediaJobLookupService } from "./media-job-lookup.service";
import { MediaSupplierService } from "./media-supplier.service";
import {
  MediaSupplierManagementController,
  MediaSupplierEventController,
} from "./media-supplier.controller";
import { PricingGroupDispositionService } from "./pricing-group-disposition.service";
import { PricingResolutionService } from "./pricing-resolution.service";
import { PricingAttemptCorrectionService } from "./pricing-attempt-correction.service";
import { PricingOutcomeDispositionService } from "./pricing-outcome-disposition.service";
import { PricingUsageRecoveryService } from "./pricing-usage-recovery.service";
import { PricedEmbeddingBatchingService } from "./priced-embedding-batching.service";
import { PricingCorrectionService } from "./pricing-correction.service";
import { MediaTaskService } from "./media-task.service";
import { PricingRecoveryService } from "./pricing-recovery.service";
import { BudgetModule } from "../budget/budget.module";
import { CostLedgerService } from "./cost-ledger.service";
import { PricingRuntimeService } from "./pricing-runtime.service";
import { PricingCostController } from "./pricing-cost.controller";
import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { ConfigModule } from "../config/config.module";
import { PricingController } from "./pricing.controller";
import { PricingRepository } from "./pricing-repository";
import { PricingWriteGuard } from "./pricing-write.guard";
import { PricingExceptionFilter } from "./pricing-exception.filter";

@Module({
  imports: [AuthModule, ConfigModule, BudgetModule],
  controllers: [
    PricingController,
    CostReportController,
    PricingCostController,
    MediaSupplierManagementController,
    MediaSupplierEventController,
  ],
  providers: [
    HistoricalFxService,
    PricingReplayService,
    RealtimePricingService,
    MediaJobLookupService,
    CostReportService,
    MediaEventDispositionService,
    MediaSupplierService,
    PricingGroupDispositionService,
    PricingOutcomeDispositionService,
    PricingAttemptCorrectionService,
    PricingUsageRecoveryService,
    PricingResolutionService,
    PricingCorrectionService,
    PricingRepository,
    PricingWriteGuard,
    PricingExceptionFilter,
    CostLedgerService,
    PricingRuntimeService,
    PricingRecoveryService,
    PricedEmbeddingBatchingService,
    MediaTaskService,
  ],
  exports: [
    RealtimePricingService,
    MediaJobLookupService,
    CostReportService,
    MediaEventDispositionService,
    MediaSupplierService,
    PricingGroupDispositionService,
    PricingOutcomeDispositionService,
    PricingAttemptCorrectionService,
    PricingUsageRecoveryService,
    PricingResolutionService,
    PricingCorrectionService,
    PricingRepository,
    CostLedgerService,
    PricingRuntimeService,
    PricedEmbeddingBatchingService,
    MediaTaskService,
  ],
})
export class PricingModule {}

import { MediaTaskService } from "./media-task.service";
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from "@nestjs/common";
import { CostLedgerService } from "./cost-ledger.service";
import { PricingRuntimeService } from "./pricing-runtime.service";
import { RealtimePricingService } from "./realtime-pricing.service";

/** Internal maintenance. Never migrates a database or dispatches model generation; pinned job-status GETs may run. */
@Injectable()
export class PricingRecoveryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PricingRecoveryService.name);
  private timer?: ReturnType<typeof setInterval>;
  private inFlight?: Promise<void>;
  private stopped = false;

  constructor(
    private readonly ledger: CostLedgerService,
    private readonly runtime: PricingRuntimeService,
    @Optional() private readonly mediaTasks?: MediaTaskService,
    @Optional() private readonly realtime?: RealtimePricingService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.runSafely();
    this.timer = setInterval(() => {
      void this.runSafely();
    }, 30_000);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.inFlight?.catch(() => undefined);
    try { await this.runtime.flushPendingOutcomes(new Date(), true); }
    catch { this.logger.error("Final accounting persistence attempt failed; durable dispatches remain available for review."); }
    await this.realtime?.flush().catch(() => this.logger.error("Realtime persistence still requires review."));
  }

  runOnce(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.reconcile().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async reconcile(): Promise<void> {
    if (!(await this.ledger.available())) return;
    await this.runtime.flushPendingOutcomes();
    await this.realtime?.flush();
    await this.runtime.renewActiveLeases();
    const result = await this.ledger.reconcilePending();
    const actual = await this.ledger.reconcileActualBudgets();
    if (actual.review_required) this.logger.error(`Actual-upstream budget review required for ${actual.review_required} closed cohorts; no expense was erased or redispatched.`);
    await this.mediaTasks?.recover();
    const reclaimed = await this.ledger.recoverUndispatched();
    const orphans = await this.ledger.reconcileDispatched();
    if (orphans.opened || orphans.updated) this.logger.error(`Pricing orphan review required: ${orphans.opened} new and ${orphans.updated} changed cases; no holds were released or model requests repeated.`);
    if (result.review_required)
      this.logger.error(
        `Pricing settlement requires review: ${result.review_required} immutable evidence conflicts.`,
      );
    if (result.applied || reclaimed)
      this.logger.log(
        `Pricing recovery applied ${result.applied} terminal intents and released ${reclaimed} undispatched holds.`,
      );
  }

  private async runSafely(): Promise<void> {
    try {
      await this.runOnce();
    } catch {
      this.logger.error(
        "Pricing recovery remains pending; no model generation was redispatched or zero-cost settlement inferred.",
      );
    }
  }
}

import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from "@nestjs/common";
import { DataSource } from "typeorm";
import { ConfigService } from "../config/config.service";
import { CostLedgerService } from "./cost-ledger.service";
import { purgeSettledPricingEvidence, type PricingEvidenceCursor } from "./pricing-evidence-retention";

const FIRST_RUN_MS = 10 * 60_000;
const INTERVAL_MS = 30 * 60_000;
const REQUESTS_PER_RUN = 2000;

/** Opt-in: removes fully settled pricing evidence older than database.pricing_evidence_retention_days. */
@Injectable()
export class PricingEvidenceRetentionService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(PricingEvidenceRetentionService.name);
  private timer?: NodeJS.Timeout;
  private inFlight?: Promise<void>;
  private stopped = false;
  private cursor: PricingEvidenceCursor | null = null;

  constructor(
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
    private readonly ledger: CostLedgerService,
  ) {}

  onApplicationBootstrap(): void {
    this.schedule(FIRST_RUN_MS);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.inFlight?.catch(() => undefined);
  }

  runOnce(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.inFlight ??= this.purge().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async purge(): Promise<void> {
    const days = this.config.database.pricing_evidence_retention_days ?? 0;
    if (days <= 0 || !(await this.ledger.available())) return;
    const result = await purgeSettledPricingEvidence(this.dataSource, {
      before: new Date(Date.now() - days * 86_400_000),
      limit: REQUESTS_PER_RUN,
      after: this.cursor,
      shouldStop: () => this.stopped,
    });
    this.cursor = result.next;
    if (result.purged || result.blocked)
      this.logger.log(
        `Pricing evidence retention removed ${result.purged} settled requests older than ${days} days; ` +
          `kept ${result.kept} unsettled or referenced, ${result.blocked} rejected by database references.`,
      );
  }

  private schedule(delay: number): void {
    this.timer = setTimeout(() => {
      if (this.stopped) return;
      void this.runOnce()
        .catch((error) => this.logger.warn(`Pricing evidence retention failed: ${(error as Error).message}`))
        .finally(() => {
          if (!this.stopped) this.schedule(INTERVAL_MS);
        });
    }, delay);
    this.timer.unref();
  }
}

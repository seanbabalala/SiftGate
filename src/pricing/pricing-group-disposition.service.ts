import { Injectable } from "@nestjs/common";
import { CostLedgerService } from "./cost-ledger.service";
import { PricingRepository } from "./pricing-repository";
import {
  PricingRepositoryError,
  type PricingActor,
} from "./pricing-repository.types";
import { parseOutcomeDisposition } from "./pricing-outcome-disposition.service";
import { verifyRetainedComputation } from "./pricing-retained-cost";
import { pricingContentHash } from "./pricing-json";
import { recoveryConflict } from "./pricing-recovery-basis";

@Injectable()
export class PricingGroupDispositionService {
  constructor(
    private readonly ledger: CostLedgerService,
    private readonly prices: PricingRepository,
  ) {}
  async dispose(
    actor: PricingActor,
    id: string,
    value: unknown,
    dryRun: boolean,
  ) {
    if (actor.role !== "admin" || !actor.id || !actor.workspace_id)
      throw new PricingRepositoryError(
        "pricing_permission_denied",
        "Complete-group disposition requires workspace administration",
        403,
      );
    const input = parseOutcomeDisposition(value);
    const prior = await this.ledger.recordedGroupDisposition(actor, id, input);
    if (prior) return { ...prior, dry_run: dryRun };
    try {
      const basis = await this.ledger.groupDispositionContext(
        id,
        actor.workspace_id,
      );
      if (
        basis.view.blocked_reason ||
        basis.view.basis_hash !== input.expected_basis_hash ||
        basis.view.outcome_hash !== input.expected_outcome_hash ||
        (input.action === "accept_receipts" &&
          basis.view.acceptance_blocked_reason)
      )
        recoveryConflict(
          "Complete-group evidence or ownership changed; reread its basis",
        );
      const verified: Record<string, string> = {};
      if (input.action === "accept_receipts") {
        for (const group of basis.cohorts) {
          const snapshot = await this.prices.restoreRequest(
            group.anchor.request_id,
            actor.workspace_id,
          );
          verifyRetainedComputation(snapshot, {
            retained: group.retained,
            original: group.original,
            pricing: group.pricing,
            row: group.anchor,
            reservation: group.reservation,
            // The validated physical manifest is an embedding cohort. Earlier
            // runtime contexts did not place this operation in media metadata.
            operation: "embeddings",
          });
        }
        for (const entry of basis.entries) {
          if (!entry.retained.batch) {
            const snapshot = await this.prices.restoreRequest(
              entry.row.request_id,
              actor.workspace_id,
            );
            verifyRetainedComputation(snapshot, entry);
          }
          verified[entry.row.id] = pricingContentHash(entry.retained);
        }
      }
      return await this.ledger.disposeGroupOutcome(
        actor,
        id,
        input,
        verified,
        dryRun,
      );
    } catch (error) {
      if (
        error instanceof PricingRepositoryError &&
        [404, 409].includes(error.status)
      ) {
        const recorded = await this.ledger.recordedGroupDisposition(
          actor,
          id,
          input,
        );
        if (recorded) return { ...recorded, dry_run: dryRun };
      }
      throw error;
    }
  }
}

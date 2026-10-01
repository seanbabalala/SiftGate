import { recoveryConflict } from "./pricing-recovery-basis";
import { verifyRetainedComputation } from "./pricing-retained-cost";
import { Injectable } from "@nestjs/common";
import { CostLedgerService } from "./cost-ledger.service";
import { PricingRepository } from "./pricing-repository";
import {
  PricingRepositoryError,
  type PricingActor,
} from "./pricing-repository.types";
import { PricingApiInput } from "./pricing-api-input";
import type { CostComputation } from "./pricing.types";
import type { OutcomeDispositionInput } from "./pricing-outcome-disposition.types";

@Injectable()
export class PricingOutcomeDispositionService {
  constructor(
    private readonly ledger: CostLedgerService,
    private readonly prices: PricingRepository,
  ) {}

  async dispose(
    actor: PricingActor,
    outcomeId: string,
    value: unknown,
    dryRun: boolean,
  ) {
    if (actor.role !== "admin" || !actor.id || !actor.workspace_id)
      throw new PricingRepositoryError(
        "pricing_permission_denied",
        "Outcome disposition requires workspace administration",
        403,
      );
    const input = parseOutcomeDisposition(value);
    const prior = await this.ledger.recordedOutcomeDisposition(
      actor,
      outcomeId,
      input,
    );
    if (prior) return { ...prior, dry_run: dryRun };
    try {
      const basis = await this.ledger.outcomeDispositionContext(
        outcomeId,
        actor.workspace_id,
      );
      if (
        basis.view.blocked_reason ||
        basis.view.basis_hash !== input.expected_basis_hash ||
        basis.view.outcome_hash !== input.expected_outcome_hash
      )
        recoveryConflict(
          "Retained outcome or original evidence changed; reread the basis",
        );
      const verified: CostComputation[] = [];
      if (input.action === "accept_receipts") {
        const snapshot = await this.prices.restoreRequest(
          basis.outcome.request_id,
          actor.workspace_id,
        );
        for (const entry of basis.entries) {
          verifyRetainedComputation(snapshot, { ...entry, reservation: basis.reservation });
          verified.push(entry.retained);
        }
      }
      return await this.ledger.disposeRuntimeOutcome(
        actor,
        outcomeId,
        input,
        verified,
        dryRun,
      );
    } catch (error) {
      if (
        error instanceof PricingRepositoryError &&
        [404, 409].includes(error.status)
      ) {
        const recorded = await this.ledger.recordedOutcomeDisposition(
          actor,
          outcomeId,
          input,
        );
        if (recorded) return { ...recorded, dry_run: dryRun };
      }
      throw error;
    }
  }
}

export function parseOutcomeDisposition(
  value: unknown,
): OutcomeDispositionInput {
  const reader = new PricingApiInput(value),
    raw = reader.body([
      "id",
      "expected_basis_hash",
      "expected_outcome_hash",
      "action",
      "reason",
      "confirm",
    ]);
  const input: OutcomeDispositionInput = {
    id: reader.string(raw.id, "id", 128),
    expected_basis_hash: reader.string(
      raw.expected_basis_hash,
      "expected_basis_hash",
      64,
    ),
    expected_outcome_hash: reader.string(
      raw.expected_outcome_hash,
      "expected_outcome_hash",
      64,
    ),
    action: reader.string(
      raw.action,
      "action",
    ) as OutcomeDispositionInput["action"],
    reason: reader.string(raw.reason, "reason", 1000),
    confirm: true,
  };
  if (!["accept_receipts", "reject_evidence"].includes(input.action))
    reader.invalid("action", "Choose accept_receipts or reject_evidence");
  if (
    !/^[a-f0-9]{64}$/.test(input.expected_basis_hash) ||
    !/^[a-f0-9]{64}$/.test(input.expected_outcome_hash)
  )
    reader.invalid(
      "expected_basis_hash",
      "Exact current basis and retained outcome hashes are required",
    );
  if (!input.reason.trim() || raw.confirm !== true)
    reader.invalid(
      "confirm",
      "An explicit reason and review confirmation are required",
    );
  reader.done();
  return input;
}

import { Injectable } from "@nestjs/common";
import { CostLedgerService } from "./cost-ledger.service";
import { PricingRepository } from "./pricing-repository";
import {
  PricingRepositoryError,
  type PricingActor,
} from "./pricing-repository.types";
import { PricingApiInput } from "./pricing-api-input";
import { parseUsageRecoveryInput } from "./pricing-usage-recovery.service";
import type { AttemptCorrectionInput } from "./attempt-correction.types";
import { normalizeQuantities } from "./usage-normalizer";
import { recoveryConflict } from "./pricing-recovery-basis";
import { compilePriceBook } from "./pricing-compiler";
import { calculateCost } from "./cost-calculator";
import { parsePricingInstant } from "./pricing-time";
import type { PricingContext } from "./pricing.types";

@Injectable()
export class PricingAttemptCorrectionService {
  constructor(
    private readonly ledger: CostLedgerService,
    private readonly prices: PricingRepository,
  ) {}

  async correct(
    actor: PricingActor,
    attemptId: string,
    value: unknown,
    dryRun: boolean,
  ) {
    if (actor.role !== "admin" || !actor.id || !actor.workspace_id)
      throw new PricingRepositoryError(
        "pricing_permission_denied",
        "Attempt correction requires workspace administration",
        403,
      );
    const reader = new PricingApiInput(value);
    const raw = reader.body([
      "id",
      "expected_cost_hash",
      "expected_basis_hash",
      "reason",
      "confirm",
      "evidence",
      "conditions",
      "evidence_digest",
    ]);
    const expected = reader.string(
      raw.expected_cost_hash,
      "expected_cost_hash",
      64,
    );
    if (!/^[a-f0-9]{64}$/.test(expected))
      reader.invalid(
        "expected_cost_hash",
        "Expected the latest effective cost hash",
      );
    reader.done();
    const { expected_cost_hash: _expected, ...body } = raw;
    const { attempt_id: _attempt, ...parsed } = parseUsageRecoveryInput({
      ...body,
      attempt_id: attemptId,
    });
    const input: AttemptCorrectionInput = {
      ...parsed,
      expected_cost_hash: expected,
    };
    const prior = await this.ledger.recordedAttemptCorrection(
      actor,
      attemptId,
      input,
    );
    if (prior) return { ...prior, dry_run: dryRun };
    try {
      return await this.compute(actor, attemptId, input, dryRun);
    } catch (error) {
      if (
        error instanceof PricingRepositoryError &&
        [404, 409].includes(error.status)
      ) {
        const result = await this.ledger.recordedAttemptCorrection(
          actor,
          attemptId,
          input,
        );
        if (result) return { ...result, dry_run: dryRun };
      }
      throw error;
    }
  }

  private async compute(
    actor: PricingActor,
    attemptId: string,
    input: AttemptCorrectionInput,
    dryRun: boolean,
  ) {
    const basis = await this.ledger.attemptCorrectionContext(
      attemptId,
      actor.workspace_id,
    );
    if (
      basis.view.blocked_reason ||
      basis.view.basis_hash !== input.expected_basis_hash ||
      basis.view.effective_cost_hash !== input.expected_cost_hash
    )
      recoveryConflict(
        "Correction evidence changed or remains owned; reread the correction basis",
      );
    const usage = normalizeQuantities(
      input.evidence.map((entry) => ({
        ...entry,
        source: "request_metadata" as const,
        quality:
          entry.value === null ? ("missing" as const) : ("estimated" as const),
      })),
      {
        adapter_id: "administrator-attempt-correction",
        adapter_version: "1",
        source: "request_metadata",
        quality: "estimated",
      },
    );
    if (usage.diagnostics.length)
      throw new PricingRepositoryError(
        "pricing_invalid_quantity",
        "Correction quantities are inconsistent",
        400,
      );
    const selection = basis.view.current.selection;
    const context: PricingContext = {
      ...basis.pricing.context,
      resolved_service_tier:
        selection?.resolved_service_tier ??
        basis.pricing.context.resolved_service_tier,
      media: selection?.media ?? basis.pricing.context.media,
      ...(selection?.calendar_match && selection.time_basis
        ? { [selection.time_basis]: selection.calendar_match.instant }
        : {}),
      ...input.conditions,
      attempt_dispatched_at: basis.attempt.dispatched_at,
      ...(input.conditions?.media
        ? {
            media: {
              ...basis.pricing.context.media,
              ...selection?.media,
              ...input.conditions.media,
            },
            media_estimated: true,
          }
        : {}),
      ...(input.conditions?.provider_accepted_at ||
      input.conditions?.completed_at
        ? { time_estimated: true }
        : {}),
    };
    if (
      context.media?.operation !== basis.pricing.context.media?.operation &&
      input.conditions?.media?.operation
    )
      recoveryConflict("Correction cannot change the dispatched operation");
    for (const time of [context.provider_accepted_at, context.completed_at])
      if (
        time &&
        parsePricingInstant(time) <
          parsePricingInstant(basis.attempt.dispatched_at)
      )
        recoveryConflict("Corrected provider time precedes dispatch");
    if (
      context.provider_accepted_at &&
      context.completed_at &&
      parsePricingInstant(context.completed_at) <
        parsePricingInstant(context.provider_accepted_at)
    )
      recoveryConflict("Corrected completion precedes acceptance");
    const snapshot = await this.prices.restoreRequest(
      basis.attempt.request_id,
      actor.workspace_id,
    );
    const quote = snapshot.quote(basis.target, usage, context);
    let cost = quote.cost;
    if (basis.view.original.book_id === "legacy-config" && !quote.binding_id) {
      if (!basis.pricing.legacyPrice || !basis.view.original.version_id)
        recoveryConflict("The original legacy pricing evidence is unavailable");
      const compiled = compilePriceBook(basis.pricing.legacyPrice, {
        book_id: "legacy-config",
        version_id: basis.view.original.version_id,
      });
      cost = calculateCost(usage, compiled.resolve(usage, context), {
        report_currency: basis.view.original.report_currency,
      });
    }
    if (basis.view.original.attribution)
      cost.attribution = basis.view.original.attribution;
    cost.diagnostics.push({
      code: "pricing_usage_attested",
      path: "usage",
      message:
        "Administrator-attested correction, not supplier confirmation. Original receipts and request outcomes remain unchanged.",
    });
    return this.ledger.attestAttemptCorrection(
      actor,
      attemptId,
      input,
      cost,
      dryRun,
    );
  }
}

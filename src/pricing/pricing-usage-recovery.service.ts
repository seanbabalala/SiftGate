import { Injectable } from "@nestjs/common";
import { CostLedgerService } from "./cost-ledger.service";
import { PricingRepository } from "./pricing-repository";
import { PricingApiInput } from "./pricing-api-input";
import {
  PricingRepositoryError,
  type PricingActor,
} from "./pricing-repository.types";
import type { UsageRecoveryInput } from "./pricing-usage-recovery.types";
import {
  DIMENSION_UNITS,
  type MeterDimension,
  type PricingContext,
} from "./pricing.types";
import { normalizeQuantities } from "./usage-normalizer";
import { compilePriceBook } from "./pricing-compiler";
import { calculateCost } from "./cost-calculator";
import { recoveryConflict } from "./pricing-recovery-basis";
import { parsePricingInstant } from "./pricing-time";

@Injectable()
export class PricingUsageRecoveryService {
  constructor(
    private readonly ledger: CostLedgerService,
    private readonly prices: PricingRepository,
  ) {}

  async recover(
    actor: PricingActor,
    anchor: string,
    value: unknown,
    dryRun: boolean,
  ) {
    if (actor.role !== "admin" || !actor.id || !actor.workspace_id)
      throw new PricingRepositoryError(
        "pricing_permission_denied",
        "Usage attestation requires workspace administration",
        403,
      );
    const input = parseUsageRecoveryInput(value);
    // A successful previous write is replayed before re-reading a now-terminal basis.
    const prior = await this.ledger.recordedUsageRecovery(anchor, actor, input);
    if (prior) return { ...prior, dry_run: dryRun };
    try {
      return await this.computeAndRecover(actor, anchor, input, dryRun);
    } catch (error) {
      // An exact concurrent submit may commit between the lookup and basis read.
      // A fresh authoritative acknowledgement is safe; a different proposal still conflicts.
      if (
        error instanceof PricingRepositoryError &&
        [404, 409].includes(error.status)
      ) {
        const applied = await this.ledger.recordedUsageRecovery(
          anchor,
          actor,
          input,
        );
        if (applied) return { ...applied, dry_run: dryRun };
      }
      throw error;
    }
  }

  private async computeAndRecover(
    actor: PricingActor,
    anchor: string,
    input: UsageRecoveryInput,
    dryRun: boolean,
  ) {
    const basis = await this.ledger.usageRecoveryBasis(
      anchor,
      actor.workspace_id,
      input.attempt_id,
    );
    if (basis.basis_hash !== input.expected_basis_hash)
      recoveryConflict(
        "Usage recovery basis changed; reread before submitting",
      );
    const usage = normalizeQuantities(
      input.evidence.map((entry) => ({
        ...entry,
        source: "request_metadata" as const,
        quality:
          entry.value === null ? ("missing" as const) : ("estimated" as const),
      })),
      {
        adapter_id: "administrator-usage-recovery",
        adapter_version: "1",
        source: "request_metadata",
        quality: "estimated",
      },
    );
    if (usage.diagnostics.length)
      throw new PricingRepositoryError(
        "pricing_invalid_quantity",
        "Attested usage has invalid or inconsistent partitions",
        400,
      );
    if (
      input.conditions?.media?.operation &&
      input.conditions.media.operation !==
        basis.pricing.context.media?.operation
    )
      recoveryConflict("Usage recovery cannot change the dispatched operation");
    const context: PricingContext = {
      ...basis.pricing.context,
      ...input.conditions,
      attempt_dispatched_at: basis.dispatched_at,
      ...(input.conditions?.provider_accepted_at ||
      input.conditions?.completed_at
        ? { time_estimated: true }
        : {}),
      ...(input.conditions?.media
        ? {
            media: {
              ...basis.pricing.context.media,
              ...input.conditions.media,
            },
            media_estimated: true,
          }
        : {}),
    };
    for (const instant of [context.provider_accepted_at, context.completed_at])
      if (
        instant &&
        parsePricingInstant(instant) < parsePricingInstant(basis.dispatched_at)
      )
        recoveryConflict("Attested provider time precedes dispatch");
    if (
      context.provider_accepted_at &&
      context.completed_at &&
      parsePricingInstant(context.completed_at) <
        parsePricingInstant(context.provider_accepted_at)
    )
      recoveryConflict("Attested completion precedes acceptance");
    // No catalog head, current config, environment credentials or provider network call.
    const snapshot = await this.prices.restoreRequest(
      basis.request_id,
      actor.workspace_id,
    );
    const quote = snapshot.quote(basis.target, usage, context);
    let cost = quote.cost;
    if (!quote.binding_id && basis.pricing.legacyPrice) {
      if (!basis.legacy_version)
        recoveryConflict(
          "The legacy price version is unavailable; do not substitute current configuration",
        );
      const legacy = compilePriceBook(basis.pricing.legacyPrice, {
        book_id: "legacy-config",
        version_id: basis.legacy_version,
      });
      cost = calculateCost(usage, legacy.resolve(usage, context), {
        report_currency: "USD",
      });
    }
    if (basis.pricing.dispatch) cost.attribution = basis.pricing.dispatch;
    // Receipts carry explicit provenance even for all-missing or explicit-zero attestation.
    cost.diagnostics.push({
      code: "pricing_usage_attested",
      path: "usage",
      message:
        "Administrator-attested usage, not authenticated supplier evidence; provider outcome remains unconfirmed.",
    });
    return this.ledger.recoverUsage(anchor, actor, input, cost, dryRun);
  }
}

export function parseUsageRecoveryInput(value: unknown): UsageRecoveryInput {
  const reader = new PricingApiInput(value);
  const raw = reader.body([
    "id",
    "attempt_id",
    "expected_basis_hash",
    "reason",
    "confirm",
    "evidence",
    "conditions",
    "evidence_digest",
  ]);
  const input: UsageRecoveryInput = {
    id: reader.string(raw.id, "id", 128),
    attempt_id: reader.string(raw.attempt_id, "attempt_id", 160),
    expected_basis_hash: reader.string(
      raw.expected_basis_hash,
      "expected_basis_hash",
      64,
    ),
    reason: reader.string(raw.reason, "reason", 1000),
    confirm: true,
    evidence: reader
      .array(raw.evidence, "evidence", Object.keys(DIMENSION_UNITS).length)
      .map((entry, index) => {
        const path = `evidence.${index}`,
          item = reader.object(entry, path, ["dimension", "value"]);
        const dimension = reader.string(
          item.dimension,
          `${path}.dimension`,
        ) as MeterDimension;
        if (!Object.hasOwn(DIMENSION_UNITS, dimension))
          reader.invalid(`${path}.dimension`, "Unknown dimension");
        const quantity =
          item.value === null
            ? null
            : reader.decimal(
                item.value,
                `${path}.value`,
                false,
                DIMENSION_UNITS[dimension] !== "second",
              );
        return { dimension, value: quantity };
      }),
  };
  if (!input.evidence.length)
    reader.invalid(
      "evidence",
      "Supply explicit quantities or explicit missing values",
    );
  if (!/^[a-f0-9]{64}$/.test(input.expected_basis_hash))
    reader.invalid("expected_basis_hash", "Expected recovery basis hash");
  if (!input.reason.trim())
    reader.invalid("reason", "A non-sensitive attestation reason is required");
  if (raw.confirm !== true)
    reader.invalid("confirm", "Explicit attestation confirmation is required");
  if (raw.conditions !== undefined) {
    const conditions = reader.object(raw.conditions, "conditions", [
      "resolved_service_tier",
      "provider_accepted_at",
      "completed_at",
      "media",
    ]);
    input.conditions = reader.context(conditions);
  }
  if (raw.evidence_digest !== undefined) {
    input.evidence_digest = reader.string(
      raw.evidence_digest,
      "evidence_digest",
      64,
    );
    if (!/^[a-f0-9]{64}$/.test(input.evidence_digest))
      reader.invalid(
        "evidence_digest",
        "Expected document SHA-256, never document content or credentials",
      );
  }
  reader.done();
  return input;
}

import { Injectable } from "@nestjs/common";
import { CostLedgerService } from "./cost-ledger.service";
import { PricingRepository } from "./pricing-repository";
import { PricingRepositoryError } from "./pricing-repository.types";
import { compilePriceBook } from "./pricing-compiler";
import { calculateCost } from "./cost-calculator";
import { normalizeQuantities, type QuantityEvidence } from "./usage-normalizer";
import type { PricingActor } from "./pricing-repository.types";

@Injectable()
export class PricingCorrectionService {
  constructor(
    private readonly ledger: CostLedgerService,
    private readonly prices: PricingRepository,
  ) {}

  async correctBatch(
    actor: PricingActor,
    attemptId: string,
    input: {
      id: string;
      expectedPhysicalCostHash: string;
      reason: string;
      evidence: QuantityEvidence[];
    },
    dryRun: boolean,
  ) {
    if (actor.role !== "admin")
      throw new PricingRepositoryError(
        "pricing_permission_denied",
        "Batch correction requires workspace administration",
        403,
      );
    const basis = await this.ledger.batchCorrectionBasis(
      attemptId,
      actor.workspace_id,
      input.id,
    );
    // This API is administrator attestation, not an authenticated provider callback.
    // Do not allow a copied/forged client label to promote its evidence provenance.
    const usage = normalizeQuantities(
      input.evidence.map((item) => ({
        ...item,
        source: "request_metadata" as const,
        quality: item.value === null ? "missing" as const : "estimated" as const,
      })),
      {
        adapter_id: "administrator-batch-correction",
        adapter_version: "1",
        source: "request_metadata",
        quality: "estimated",
      },
    );
    if (usage.diagnostics.length)
      throw new PricingRepositoryError(
        "pricing_invalid_quantity",
        "Correction usage is invalid or has conflicting partitions",
        400,
      );
    const snapshot = await this.prices.restoreRequest(
      basis.request_id,
      actor.workspace_id,
    );
    const original = basis.initial_physical;
    // A retry uses its recorded evidence context even after later legitimate
    // corrections; a new operation inherits the latest accepted provider metadata.
    const evidenceContext = basis.recorded_physical ?? basis.physical;
    const selection = evidenceContext.selection;
    const context = {
      ...basis.pricing.context,
      resolved_service_tier: selection?.resolved_service_tier ?? undefined,
      ...(selection?.calendar_match
        ? {
            attempt_dispatched_at: selection.calendar_match.instant,
            provider_accepted_at: selection.calendar_match.instant,
            completed_at: selection.calendar_match.instant,
          }
        : {}),
      media: selection?.media ?? basis.pricing.context.media,
    };
    const quote = snapshot.quote(basis.target, usage, context);
    let physical = quote.cost;
    if (
      original.book_id === "legacy-config" &&
      basis.pricing.legacyPrice &&
      !quote.binding_id
    ) {
      const legacy = compilePriceBook(basis.pricing.legacyPrice, {
        book_id: original.book_id,
        version_id: original.version_id!,
      });
      physical = calculateCost(usage, legacy.resolve(usage, context), {
        report_currency: original.report_currency,
      });
    }
    if (evidenceContext.attribution) physical.attribution = evidenceContext.attribution;
    return this.ledger.adjustBatch(
      {
        id: input.id,
        attemptId,
        workspace: actor.workspace_id,
        actorId: actor.id,
        expectedPhysicalCostHash: input.expectedPhysicalCostHash,
        physicalCost: physical,
        reason: input.reason,
        source: "reconciliation",
      },
      dryRun,
    );
  }
}

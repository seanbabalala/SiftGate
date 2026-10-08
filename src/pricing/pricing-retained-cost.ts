import { recoveryConflict, recoveryDecode } from "./pricing-recovery-basis";
import { pricingContentHash } from "./pricing-json";
import { compilePriceBook } from "./pricing-compiler";
import { calculateCost, COST_CALCULATOR_VERSION } from "./cost-calculator";
import { normalizeQuantities } from "./usage-normalizer";
import type { CostComputation, PricingContext } from "./pricing.types";
import type {
  AttemptPriceContext,
  CostAttemptRow,
  CostReservationRow,
} from "./cost-ledger.types";
import type { FrozenPricingRequest } from "./pricing-catalog";
import { parsePricingInstant } from "./pricing-time";

/** Reproduce retained accounting evidence exactly; never modify quantities or promote its source. */
export function verifyRetainedComputation(
  snapshot: FrozenPricingRequest,
  input: {
    retained: CostComputation;
    original: CostComputation | null;
    pricing: AttemptPriceContext;
    row: Pick<CostAttemptRow, "node_id" | "model" | "dispatched_at">;
    reservation: Pick<CostReservationRow, "estimate_json">;
    /** Only a dedicated, validated lifecycle may supply an operation absent from old context metadata. */
    operation?: string;
  },
): void {
  const retained = input.retained,
    selection = retained.selection;
  if (
    retained.calculator_version !== COST_CALCULATOR_VERSION ||
    retained.batch ||
    retained.allocation_failure
  )
    recoveryConflict(
      "Retained calculation requires its dedicated version or physical-group lifecycle",
    );
  const normalized = normalizeQuantities(
    Object.values(retained.usage.quantities)
      .filter((q) => q !== undefined)
      .map((q) => ({
        dimension: q!.dimension,
        value: q!.value,
        source: q!.source,
        quality: q!.quality,
      })),
    {
      adapter_id: retained.usage.adapter_id,
      adapter_version: retained.usage.adapter_version,
      source: "provider_usage",
    },
  );
  if (
    normalized.diagnostics.length ||
    pricingContentHash(normalized.quantities) !==
      pricingContentHash(retained.usage.quantities)
  )
    recoveryConflict(
      "Retained quantities are not a valid normalized disjoint measurement",
    );
  const { response_model: _oldResponse, ...dispatch } =
    input.pricing.dispatch ?? input.original?.attribution ?? {};
  const { response_model: _newResponse, ...attribution } =
    retained.attribution ?? {};
  if (pricingContentHash(dispatch) !== pricingContentHash(attribution))
    recoveryConflict(
      "Retained evidence changes immutable dispatch attribution",
    );
  const originalContext = input.pricing.context;
  if (
    selection &&
    (selection.requested_service_tier !==
      (originalContext.requested_service_tier ?? null) ||
      (selection.media.operation ?? null) !==
        (originalContext.media?.operation ?? null))
  )
    recoveryConflict(
      "Retained evidence changes the original operation or requested service tier",
    );
  const context: PricingContext = {
    ...originalContext,
    attempt_dispatched_at: input.row.dispatched_at,
    ...(selection
      ? {
          resolved_service_tier: selection.resolved_service_tier ?? undefined,
          media: selection.media,
          ...(selection.calendar_match && selection.time_basis
            ? {
                [selection.time_basis]: selection.calendar_match.instant,
              }
            : {}),
        }
      : {}),
  };
  if (
    context.attempt_dispatched_at &&
    parsePricingInstant(context.attempt_dispatched_at) !==
      parsePricingInstant(input.row.dispatched_at)
  )
    recoveryConflict("Retained calendar changes the dispatch instant");
  for (const time of [context.provider_accepted_at, context.completed_at])
    if (
      time &&
      parsePricingInstant(time) < parsePricingInstant(input.row.dispatched_at)
    )
      recoveryConflict("Retained provider time precedes dispatch");
  if (
    context.provider_accepted_at &&
    context.completed_at &&
    parsePricingInstant(context.provider_accepted_at) >
      parsePricingInstant(context.completed_at)
  )
    recoveryConflict("Retained completion precedes acceptance");
  const target = {
    node_id: input.row.node_id,
    model: input.row.model,
    ...((input.operation ?? originalContext.media?.operation)
      ? { operation: input.operation ?? originalContext.media!.operation }
      : {}),
  };
  const expectedHash = pricingContentHash(retained);
  let matches = false;
  // Old receipt traces did not persist selection-estimated flags. Enumerate
  // their finite values only to reproduce the EXACT existing body/hash;
  // never promote its quality or change a rate/quantity to make it fit.
  for (const timeEstimated of [false, true])
    for (const mediaEstimated of [false, true]) {
      const checkContext = {
        ...context,
        time_estimated: timeEstimated,
        media_estimated: mediaEstimated,
      };
      const quoted = snapshot.quote(target, retained.usage, checkContext);
      let calculated = quoted.cost;
      if (!quoted.binding_id && input.pricing.legacyPrice) {
        const estimate = recoveryDecode<CostComputation>(
          input.reservation.estimate_json,
        );
        const version = input.original?.version_id ?? estimate.version_id;
        if (!version || retained.book_id !== "legacy-config")
          recoveryConflict("Original legacy version is unavailable");
        const legacy = compilePriceBook(input.pricing.legacyPrice, {
          book_id: "legacy-config",
          version_id: version,
        });
        calculated = calculateCost(
          retained.usage,
          legacy.resolve(retained.usage, checkContext),
          { report_currency: "USD" },
        );
      }
      if (retained.attribution) calculated.attribution = retained.attribution;
      matches ||= pricingContentHash(calculated) === expectedHash;
    }
  if (!matches)
    recoveryConflict(
      "Retained cost does not reproduce from the immutable request price, FX and evidence",
    );
}

import { calculateCost } from "./cost-calculator";
import { compilePriceBook } from "./pricing-compiler";
import { pricingContentHash } from "./pricing-json";
import { runtimeOutcomeDocument } from "./pricing-outcome-document";
import { ExactDecimal } from "./exact-decimal";
import type { FrozenPricingRequest } from "./pricing-catalog";
import type { AttemptPriceContext, CostAttemptRow, CostReservationRow } from "./cost-ledger.types";
import type { PricingTarget } from "./pricing-catalog.types";
import type { CostComputation, PricingContext } from "./pricing.types";
import type { LocalCacheReference } from "./local-cache-reference.types";

/** Validate the retained estimate against its original receipt and frozen catalog.
 * Reproduction is an integrity check only; it never replaces recorded values.
 */
export function localCacheReference(snapshot: FrozenPricingRequest | null, row: CostAttemptRow, reservation: CostReservationRow): LocalCacheReference {
  const result: LocalCacheReference = { schema_version: 1, basis: "frozen_request_logical_estimate", state: "invalid_reference", report_currency: "USD", upstream_cost_usd: null, reference_cost_usd: null, hypothetical_savings_usd: null, logical_input_tokens: null, logical_output_tokens: null, book_id: null, version_id: null, content_hash: null, fx_version_id: null };
  try {
    const receipt = row.cost_json ? JSON.parse(row.cost_json) as CostComputation : null;
    if (row.fee_source !== "local_cache" || row.state !== "terminal" || !receipt || pricingContentHash(receipt) !== row.cost_hash || receipt.status !== "free" || receipt.evidence_status !== "observed" || receipt.report_amount === null || ExactDecimal.parse(receipt.report_amount).compare(ExactDecimal.zero) !== 0 || receipt.lines.length !== 0) return result;
    result.upstream_cost_usd = "0.000000000000000000";
    if (!snapshot || row.reservation_id !== reservation.id || row.request_id !== reservation.request_id || row.workspace_id !== reservation.workspace_id || snapshot.descriptor().workspace_id !== row.workspace_id) return result;
    const target = JSON.parse(reservation.target_json) as PricingTarget;
    if ((target.node_id ?? "") !== row.node_id || target.model !== row.model) return result;
    const outcome = runtimeOutcomeDocument({ type: "attempt", workspace: row.workspace_id, reservationId: reservation.id, attemptId: row.id, cost: JSON.parse(reservation.estimate_json), errorCode: null }).outcome;
    if (outcome.type !== "attempt") return result;
    const reference = outcome.cost;
    // These immutable fields also survive the explicit zero-supplier receipt.
    const evidence = (cost: CostComputation) => [cost.calculator_version, cost.book_id, cost.version_id, cost.content_hash, cost.fx_version_id, cost.currency, cost.usage, cost.selected_rule_ids, cost.selection];
    if (pricingContentHash(evidence(receipt)) !== pricingContentHash(evidence(reference))) return result;
    const original = JSON.parse(row.price_context_json) as AttemptPriceContext;
    const selection = reference.selection;
    const context: PricingContext = { ...original.context,
      ...(selection ? { requested_service_tier: selection.requested_service_tier ?? undefined, resolved_service_tier: selection.resolved_service_tier ?? undefined, media: selection.media,
        ...(selection.time_basis && selection.calendar_match ? { [selection.time_basis]: selection.calendar_match.instant } : {}) } : {}),
    };
    let valid = false;
    for (const time_estimated of [false, true]) for (const media_estimated of [false, true]) {
      const candidateContext = { ...context, time_estimated, media_estimated };
      const quoted = snapshot.quote(target, reference.usage, candidateContext);
      let checked = quoted.cost;
      if (!quoted.binding_id && snapshot.admissionPolicy(target.operation).mode === "compatibility" && original.legacyPrice && reference.version_id && reference.book_id === "legacy-config") {
        const legacy = compilePriceBook(original.legacyPrice, { book_id: "legacy-config", version_id: reference.version_id });
        checked = calculateCost(reference.usage, legacy.resolve(reference.usage, candidateContext), { report_currency: "USD" });
      }
      valid ||= pricingContentHash(checked) === pricingContentHash(reference);
    }
    if (!valid) return result;
    const amount = reference.report_amount === null ? null : ExactDecimal.parse(reference.report_amount).toFixed(18);
    return { ...result, state: amount === null ? "unknown" : "estimated", reference_cost_usd: amount,
      // The verified supplier amount is zero, not the logical budget charge.
      hypothetical_savings_usd: amount,
      logical_input_tokens: reference.usage.quantities.total_input_tokens?.value ?? null,
      logical_output_tokens: reference.usage.quantities.output_tokens?.value ?? null,
      book_id: reference.book_id, version_id: reference.version_id, content_hash: reference.content_hash, fx_version_id: reference.fx_version_id };
  } catch { return result; }
}

import { ExactDecimal } from "./exact-decimal";
import { calculateComponentAmount, resolveFx } from "./cost-calculator";
import type {
  BillableDimension,
  FxSnapshot,
  PriceBookContent,
  PricingDiagnostic,
} from "./pricing.types";
import type {
  PricingRateEnvelope,
  ReservationQuantityBounds,
} from "./pricing-admission.types";

/** Interval arithmetic over ALL declared selectors, not the current/cheapest rule.
 * Quantities and rates are nonnegative; every rounding/minimum operation is monotone.
 * An independent envelope per dimension may over-reserve correlated variants, but cannot under-bound a declared path.
 */
export function priceBookRateEnvelope(
  content: PriceBookContent,
  bounds: ReservationQuantityBounds,
  reportCurrency: string,
  fx?: FxSnapshot,
): PricingRateEnvelope {
  const diagnostics: PricingDiagnostic[] = [];
  const result: PricingRateEnvelope = {
    algorithm: "nonnegative_rule_envelope_v1",
    currency: content.currency,
    report_currency: reportCurrency,
    report_amount: null,
    fx_version_id: null,
    dimensions: [],
    diagnostics,
  };
  const amounts = new Map<BillableDimension, ExactDecimal>();
  for (const dimension of content.billing_dimensions) {
    if (!bounds[dimension])
      diagnostics.push({
        code: "pricing_reservation_bound_missing",
        path: `bounds.${dimension}`,
        message:
          "No exact request quantity or approved supplier limit establishes this dimension bound",
      });
    amounts.set(dimension, ExactDecimal.zero);
  }
  const exchange = resolveFx(content.currency, reportCurrency, fx, diagnostics);
  if (exchange !== null && content.currency !== reportCurrency)
    result.fx_version_id = fx!.version_id;
  if (diagnostics.length) return result;
  for (const group of content.groups) {
    const alternatives = group.rules
      .filter((rule) => {
        const limit = bounds.total_input_tokens;
        return (
          !limit ||
          !rule.condition.input_tokens ||
          ExactDecimal.parse(rule.condition.input_tokens.min).compare(
            ExactDecimal.parse(limit.value),
          ) <= 0
        );
      })
      .map((rule) => {
        const state = new Map(amounts);
        for (const entry of rule.rates) {
          const { dimension } = entry.component;
          const quantity = ExactDecimal.parse(bounds[dimension]!.value);
          const { exact } = calculateComponentAmount(quantity, {
            ...entry.component,
            rule_id: rule.id,
            multipliers: [],
          });
          state.set(
            dimension,
            entry.operation === "replace"
              ? exact
              : (state.get(dimension) ?? ExactDecimal.zero).add(exact),
          );
        }
        for (const multiplier of rule.multipliers ?? [])
          state.set(
            multiplier.dimension,
            (state.get(multiplier.dimension) ?? ExactDecimal.zero).multiply(
              ExactDecimal.parse(multiplier.factor),
            ),
          );
        return state;
      });
    // Keeping the incoming envelope also covers an optional or unmatched group conservatively.
    for (const dimension of content.billing_dimensions)
      for (const candidate of alternatives) {
        const amount = candidate.get(dimension) ?? ExactDecimal.zero;
        if (amount.compare(amounts.get(dimension)!) > 0)
          amounts.set(dimension, amount);
      }
  }
  let total = ExactDecimal.zero;
  for (const [dimension, amount] of amounts) {
    total = total.add(amount);
    result.dimensions.push({ dimension, exact_amount: amount.toFraction() });
  }
  // Round outwards at the book's reporting precision, then preserve that bound in the exact ledger scale.
  result.report_amount = ExactDecimal.parse(
    total.multiply(exchange!).toFixed(content.money_precision, "ceil"),
  ).toFixed(18, "ceil");
  return result;
}

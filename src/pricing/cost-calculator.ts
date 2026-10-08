import { ExactDecimal } from "./exact-decimal";
import {
  ROUNDING_MODES,
  validateBillingBasis,
  validateRateComponent,
} from "./pricing-validation";
import {
  CostComputation,
  CostLine,
  DIMENSION_UNITS,
  FxSnapshot,
  NormalizedUsage,
  PricingDiagnostic,
  ResolvedPrice,
  SelectedRateComponent,
} from "./pricing.types";

export const COST_CALCULATOR_VERSION = "1";

export interface CostCalculationOptions {
  report_currency?: string;
  fx?: FxSnapshot;
}

/** Shared by actual pricing and reservation envelopes. A known zero never triggers a minimum charge. */
export function calculateComponentAmount(
  amount: ExactDecimal,
  rate: SelectedRateComponent,
): { billed: ExactDecimal; exact: ExactDecimal } {
  if (amount.compare(ExactDecimal.zero) === 0)
    return { billed: ExactDecimal.zero, exact: ExactDecimal.zero };
  let billed = amount;
  if (rate.minimum_quantity !== undefined) {
    const minimum = ExactDecimal.parse(rate.minimum_quantity);
    if (billed.compare(minimum) < 0) billed = minimum;
  }
  if (rate.quantity_rounding) {
    billed = billed.roundToIncrement(
      ExactDecimal.parse(rate.quantity_rounding.increment),
      rate.quantity_rounding.mode,
    );
    // A floor rule cannot defeat a contractually specified minimum.
    if (rate.minimum_quantity !== undefined) {
      const minimum = ExactDecimal.parse(rate.minimum_quantity);
      if (billed.compare(minimum) < 0) billed = minimum;
    }
  }
  const multiplier = rate.multipliers.reduce(
    (value, factor) => value.multiply(ExactDecimal.parse(factor)),
    ExactDecimal.one,
  );
  const exact = billed
    .multiply(ExactDecimal.parse(rate.amount))
    .multiply(multiplier)
    .divide(ExactDecimal.parse(rate.unit_size));
  return { billed, exact };
}

/** No I/O or current-price lookup: callers own and persist the supplied snapshot. */
export function calculateCost(
  usage: NormalizedUsage,
  price: ResolvedPrice | null,
  options: CostCalculationOptions = {},
): CostComputation {
  const result: CostComputation = {
    schema_version: 1,
    calculator_version: COST_CALCULATOR_VERSION,
    status: "unpriced",
    evidence_status: "incomplete",
    book_id: price?.book_id ?? null,
    version_id: price?.version_id ?? null,
    content_hash: price?.content_hash ?? null,
    selected_rule_ids: price ? [...price.selected_rule_ids] : [],
    selection: price ? structuredClone(price.selection) : null,
    usage: structuredClone(usage),
    currency: price?.currency ?? null,
    amount: null,
    known_subtotal: null,
    rounding_adjustment: null,
    report_currency: options.report_currency ?? price?.currency ?? "USD",
    report_amount: null,
    report_known_subtotal: null,
    report_rounding_adjustment: null,
    fx_version_id: null,
    lines: [],
    diagnostics: [...usage.diagnostics],
  };
  if (!price) {
    result.diagnostics.push({
      code: "pricing_dimension_missing",
      path: "price",
      message: "No approved price is available",
    });
    return result;
  }
  const priceProblems = validateSelectedPrice(price);
  result.diagnostics.push(...price.diagnostics, ...priceProblems);
  if (priceProblems.length || price.diagnostics.length) {
    if (
      price.diagnostics.some(
        (entry) =>
          entry.code === "pricing_dimension_missing" &&
          entry.path.startsWith("usage."),
      )
    )
      result.status = "missing_usage";
    return result;
  }

  const precision = price.money_precision;
  const rounding = price.money_rounding;
  const quantum = ExactDecimal.one.divide(
    ExactDecimal.parse(`1${"0".repeat(precision)}`),
  );
  let total = ExactDecimal.zero;
  let displayed = ExactDecimal.zero;
  let reportDisplayed = ExactDecimal.zero;
  let known = false;
  let missingQuantity = false;
  let missingRate = false;
  let estimated =
    price.source.kind === "reference" || price.selection_estimated;
  const fx = resolveFx(
    price.currency,
    result.report_currency,
    options.fx,
    result.diagnostics,
  );
  if (fx !== null && price.currency !== result.report_currency)
    result.fx_version_id = options.fx!.version_id;

  for (const dimension of price.billing_dimensions) {
    const quantity = usage.quantities[dimension];
    if (
      !quantity ||
      quantity.value === null ||
      quantity.quality === "missing" ||
      quantity.quality === "unsupported"
    ) {
      result.diagnostics.push({
        code: "pricing_dimension_missing",
        path: `usage.${dimension}`,
        message: "A required billing quantity is unavailable",
      });
      missingQuantity = true;
      continue;
    }
    let amount: ExactDecimal;
    try {
      amount = ExactDecimal.parse(quantity.value);
      if (
        quantity.unit !== DIMENSION_UNITS[dimension] ||
        amount.compare(ExactDecimal.zero) < 0 ||
        (quantity.unit !== "second" && !amount.isInteger())
      )
        throw new Error("Quantity has an invalid unit or value");
    } catch (error) {
      result.diagnostics.push({
        code: "pricing_invalid_quantity",
        path: `usage.${dimension}`,
        message: (error as Error).message,
      });
      missingQuantity = true;
      continue;
    }
    estimated ||=
      quantity.quality === "estimated" || quantity.source === "heuristic";
    if (amount.compare(ExactDecimal.zero) === 0) {
      known = true;
      continue;
    }
    const rates = price.components.filter(
      (component) => component.dimension === dimension,
    );
    if (rates.length === 0) {
      result.diagnostics.push({
        code: "pricing_dimension_missing",
        path: `rates.${dimension}`,
        message: "There is usage but no rate for this dimension",
      });
      missingRate = true;
      continue;
    }
    for (const rate of rates) {
      const { billed, exact } = calculateComponentAmount(amount, rate);
      const reportExact = fx === null ? null : exact.multiply(fx);
      const line: CostLine = {
        component_id: rate.id,
        rule_id: rate.rule_id,
        dimension,
        quantity: quantity.value,
        billed_quantity: billed
          .toFixed(18)
          .replace(/(\.\d*?)0+$/, "$1")
          .replace(/\.$/, ""),
        unit: rate.unit,
        unit_size: rate.unit_size,
        rate: rate.amount,
        multipliers: [...rate.multipliers],
        currency: price.currency,
        amount: exact.toFixed(precision, rounding),
        exact_amount: exact.toFraction(),
        report_amount: reportExact?.toFixed(precision, rounding) ?? null,
        evidence_source: quantity.source,
        evidence_quality: quantity.quality,
      };
      result.lines.push(line);
      total = total.add(exact);
      displayed = displayed.add(exact.roundToIncrement(quantum, rounding));
      if (reportExact !== null)
        reportDisplayed = reportDisplayed.add(
          reportExact.roundToIncrement(quantum, rounding),
        );
      known = true;
    }
  }

  const complete =
    !missingQuantity && !missingRate && usage.diagnostics.length === 0;
  if (known) {
    result.known_subtotal = total.toFixed(precision, rounding);
    result.rounding_adjustment = total
      .roundToIncrement(quantum, rounding)
      .subtract(displayed)
      .toFixed(precision, rounding);
    if (fx !== null) {
      const reportTotal = total.multiply(fx);
      result.report_known_subtotal = reportTotal.toFixed(precision, rounding);
      result.report_rounding_adjustment = reportTotal
        .roundToIncrement(quantum, rounding)
        .subtract(reportDisplayed)
        .toFixed(precision, rounding);
    }
  }
  if (complete) {
    result.amount = result.known_subtotal;
    result.report_amount = result.report_known_subtotal;
    result.status =
      fx === null
        ? "unpriced"
        : price.source.kind === "legacy"
          ? "legacy_estimate"
          : estimated
            ? "estimated"
            : total.compare(ExactDecimal.zero) === 0
              ? "free"
              : "priced";
    result.evidence_status =
      fx === null ? "incomplete" : estimated ? "estimated" : "observed";
  } else {
    result.status =
      result.lines.length > 0
        ? "partial"
        : missingRate
          ? "unpriced"
          : "missing_usage";
  }
  return result;
}

export function resolveFx(
  from: string,
  to: string,
  fx: FxSnapshot | undefined,
  diagnostics: PricingDiagnostic[],
): ExactDecimal | null {
  if (from === to) return ExactDecimal.one;
  try {
    if (
      !/^[A-Z]{3}$/.test(to) ||
      !fx ||
      !fx.version_id ||
      !fx.source ||
      !Number.isFinite(Date.parse(fx.effective_at)) ||
      fx.from_currency !== from ||
      fx.to_currency !== to
    )
      throw new Error("A matching versioned FX snapshot is required");
    const numerator = ExactDecimal.parse(fx.numerator);
    const denominator = ExactDecimal.parse(fx.denominator);
    if (
      numerator.compare(ExactDecimal.zero) <= 0 ||
      denominator.compare(ExactDecimal.zero) <= 0
    )
      throw new Error("FX ratio must be positive");
    return numerator.divide(denominator);
  } catch (error) {
    diagnostics.push({
      code: "pricing_fx_missing",
      path: "fx",
      message: (error as Error).message,
    });
    return null;
  }
}

function validateSelectedPrice(price: ResolvedPrice): PricingDiagnostic[] {
  const diagnostics = validateBillingBasis(
    price.billing_dimensions,
    price.allow_combined_media,
  );
  const invalid = (path: string, message: string): void => {
    diagnostics.push({ code: "pricing_invalid_document", path, message });
  };
  if (!/^[A-Z]{3}$/.test(price.currency))
    invalid("currency", "Expected a three-letter uppercase currency");
  if (
    !Number.isInteger(price.money_precision) ||
    price.money_precision < 0 ||
    price.money_precision > 18
  )
    invalid("money_precision", "Precision must be from 0 to 18");
  if (!ROUNDING_MODES.includes(price.money_rounding))
    invalid("money_rounding", "Unsupported rounding mode");
  const ids = new Set<string>();
  if (price.components.length > 256)
    invalid("components", "A resolved price must have at most 256 components");
  for (const rate of price.components) {
    diagnostics.push(...validateRateComponent(rate));
    if (ids.has(rate.id)) invalid("components", "Component IDs must be unique");
    ids.add(rate.id);
    if (!price.billing_dimensions.includes(rate.dimension))
      invalid("components", "Component is outside the declared billing basis");
    if (!Array.isArray(rate.multipliers) || rate.multipliers.length > 32) {
      invalid(
        "components.multipliers",
        "At most 32 explicit multipliers are allowed",
      );
      continue;
    }
    for (const factor of rate.multipliers) {
      try {
        if (ExactDecimal.parse(factor).compare(ExactDecimal.zero) <= 0)
          invalid(
            "components.multipliers",
            "Multiplier must be positive; use an explicitly free rate for zero",
          );
      } catch (error) {
        invalid("components.multipliers", (error as Error).message);
      }
    }
  }
  return diagnostics;
}

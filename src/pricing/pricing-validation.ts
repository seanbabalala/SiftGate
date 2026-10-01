import { ExactDecimal, RoundingMode } from "./exact-decimal";
import {
  BillableDimension,
  DIMENSION_UNITS,
  PricingDiagnostic,
  RateComponent,
} from "./pricing.types";

export const ROUNDING_MODES: RoundingMode[] = [
  "half_even",
  "half_up",
  "ceil",
  "floor",
];
export const BILLABLE_DIMENSIONS = Object.keys(DIMENSION_UNITS).filter(
  (dimension) =>
    dimension !== "total_input_tokens" &&
    dimension !== "reasoning_output_tokens",
) as BillableDimension[];

export function validateBillingBasis(
  dimensions: BillableDimension[],
  allowCombinedMedia: boolean,
): PricingDiagnostic[] {
  const diagnostics: PricingDiagnostic[] = [];
  const report = (message: string): void => {
    diagnostics.push({
      code: "pricing_invalid_document",
      path: "billing_dimensions",
      message,
    });
  };
  if (
    !Array.isArray(dimensions) ||
    dimensions.length === 0 ||
    dimensions.length > BILLABLE_DIMENSIONS.length
  ) {
    report("Declare a nonempty billing basis");
    return diagnostics;
  }
  if (new Set(dimensions).size !== dimensions.length)
    report("Billing dimensions must be unique");
  for (const dimension of dimensions)
    if (!BILLABLE_DIMENSIONS.includes(dimension))
      report(`Unsupported billing dimension: ${dimension}`);
  const parents: Array<[BillableDimension, BillableDimension[]]> = [
    [
      "uncached_input_tokens",
      [
        "uncached_text_input_tokens",
        "uncached_audio_input_tokens",
        "uncached_image_input_tokens",
      ],
    ],
    [
      "output_tokens",
      ["text_output_tokens", "audio_output_tokens", "image_output_tokens"],
    ],
  ];
  for (const [parent, children] of parents) {
    if (
      dimensions.includes(parent) &&
      children.some((child) => dimensions.includes(child))
    ) {
      report(`Parent ${parent} cannot be billed alongside its token subsets`);
    }
  }
  if (!allowCombinedMedia) {
    const has = (...items: BillableDimension[]): boolean =>
      items.some((item) => dimensions.includes(item));
    if (
      (has("image_count", "requested_image_count") &&
        has("output_tokens", "image_output_tokens")) ||
      (has("image_count") && has("requested_image_count")) ||
      (has("audio_input_seconds") && has("requested_audio_input_seconds")) ||
      (has("audio_output_seconds") && has("requested_audio_output_seconds")) ||
      (has("rerank_document_count") &&
        has("requested_rerank_document_count")) ||
      (has("rerank_request_count") && has("request_count")) ||
      (has("audio_output_seconds", "requested_audio_output_seconds") &&
        has("output_tokens", "audio_output_tokens")) ||
      (has("audio_input_seconds", "requested_audio_input_seconds") &&
        has("uncached_input_tokens", "uncached_audio_input_tokens")) ||
      (has("video_seconds", "requested_video_seconds") &&
        has("video_generation_count", "requested_video_generation_count")) ||
      (has("video_seconds") && has("requested_video_seconds")) ||
      (has("video_generation_count") &&
        has("requested_video_generation_count")) ||
      (has("session_seconds") &&
        (dimensions.some(dimension => dimension.endsWith("_tokens")) || has("audio_input_seconds", "audio_output_seconds")))
    ) {
      report(
        "Combined media billing requires an explicit additive declaration",
      );
    }
  }
  return diagnostics;
}

export function validateRateComponent(
  rate: RateComponent,
  path = "component",
): PricingDiagnostic[] {
  const diagnostics: PricingDiagnostic[] = [];
  const invalid = (field: string, message: string): void => {
    diagnostics.push({
      code: "pricing_invalid_rate",
      path: `${path}.${field}`,
      message,
    });
  };
  if (typeof rate.id !== "string" || !rate.id || rate.id.length > 128)
    invalid("id", "A component ID of 1–128 characters is required");
  if (!BILLABLE_DIMENSIONS.includes(rate.dimension))
    invalid("dimension", "Unsupported billing dimension");
  if (DIMENSION_UNITS[rate.dimension] !== rate.unit) {
    diagnostics.push({
      code: "pricing_unit_mismatch",
      path: `${path}.unit`,
      message: "Rate unit must match its canonical dimension",
    });
  }
  for (const [field, value, positive] of [
    ["amount", rate.amount, false],
    ["unit_size", rate.unit_size, true],
    ...(rate.minimum_quantity === undefined
      ? []
      : [["minimum_quantity", rate.minimum_quantity, false]]),
  ] as Array<[string, string, boolean]>) {
    try {
      const number = ExactDecimal.parse(value);
      if (number.compare(ExactDecimal.zero) < (positive ? 1 : 0))
        invalid(
          field,
          positive ? "Value must be positive" : "Value must not be negative",
        );
      if (
        field === "amount" &&
        number.compare(ExactDecimal.zero) === 0 &&
        rate.free !== true
      )
        invalid(field, "A zero price requires an explicit free flag");
      if (
        field === "amount" &&
        number.compare(ExactDecimal.zero) !== 0 &&
        rate.free === true
      )
        invalid(field, "A free rate must have zero amount");
      if (
        field === "minimum_quantity" &&
        rate.unit !== "second" &&
        !number.isInteger()
      )
        invalid(field, "Count minimums must be integral");
    } catch (error) {
      invalid(field, (error as Error).message);
    }
  }
  if (rate.quantity_rounding) {
    try {
      const increment = ExactDecimal.parse(rate.quantity_rounding.increment);
      if (increment.compare(ExactDecimal.zero) <= 0)
        invalid("quantity_rounding.increment", "Increment must be positive");
      if (rate.unit !== "second" && !increment.isInteger())
        invalid(
          "quantity_rounding.increment",
          "Count increments must be integral",
        );
    } catch (error) {
      invalid("quantity_rounding.increment", (error as Error).message);
    }
    if (!ROUNDING_MODES.includes(rate.quantity_rounding.mode))
      invalid("quantity_rounding.mode", "Unsupported rounding mode");
  }
  return diagnostics;
}

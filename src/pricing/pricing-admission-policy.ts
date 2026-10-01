import { PricingSchemaReader } from "./pricing-schema-reader";
import { ExactDecimal } from "./exact-decimal";
import {
  DIMENSION_UNITS,
  type MeterDimension,
  type NormalizedUsage,
  type PricingDiagnostic,
} from "./pricing.types";
import type {
  PricingAdmissionPolicy,
  ReservationQuantityBounds,
} from "./pricing-admission.types";

export { PRICING_ADMISSION_OPERATIONS, ACTUAL_UPSTREAM_BUDGET_OPERATIONS } from "./pricing-admission.types";

export function parseAdmissionPolicy(
  value: unknown,
  reader: PricingSchemaReader,
  path = "policy",
): PricingAdmissionPolicy {
  const raw = reader.object(value, path, [
    "mode",
    "quantity_limits",
    "limit_reference",
    "realtime_max_responses",
    "realtime_transcription",
    "budget_basis",
    "token_budget",
  ]);
  const mode = reader.string(
    raw.mode,
    `${path}.mode`,
  ) as PricingAdmissionPolicy["mode"];
  if (
    !["compatibility", "reject_unpriced", "reserve_upper_bound"].includes(mode)
  )
    reader.invalid(`${path}.mode`, "Unsupported pricing admission mode");
  const result: PricingAdmissionPolicy = { mode };
  if (raw.budget_basis !== undefined) {
    if (raw.budget_basis !== "legacy_logical" && raw.budget_basis !== "actual_upstream")
      reader.invalid(`${path}.budget_basis`, "Unsupported budget accounting basis");
    else result.budget_basis = raw.budget_basis;
  }
  if (raw.realtime_max_responses !== undefined)
    result.realtime_max_responses = reader.integer(raw.realtime_max_responses, `${path}.realtime_max_responses`, 1, 999);
  if (raw.realtime_transcription !== undefined) {
    const item = reader.object(raw.realtime_transcription, `${path}.realtime_transcription`, ["model", "max_items"]);
    const model = reader.string(item.model, `${path}.realtime_transcription.model`, 128);
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(model)) reader.invalid(`${path}.realtime_transcription.model`, "Expected an explicit model identifier");
    result.realtime_transcription = { model, max_items: reader.integer(item.max_items, `${path}.realtime_transcription.max_items`, 1, 999) };
  }
  if (raw.token_budget !== undefined) {
    if (raw.token_budget !== "reported_tokens" && raw.token_budget !== "not_applicable")
      reader.invalid(`${path}.token_budget`, "Unsupported token budget policy");
    else result.token_budget = raw.token_budget;
    if (result.budget_basis !== "actual_upstream")
      reader.invalid(`${path}.token_budget`, "Non-token quota selection requires explicit actual-upstream accounting");
  }
  if (raw.quantity_limits !== undefined) {
    const values = reader.object(
      raw.quantity_limits,
      `${path}.quantity_limits`,
      Object.keys(DIMENSION_UNITS),
    );
    result.quantity_limits = {};
    for (const [dimension, value] of Object.entries(values)) {
      if (!Object.prototype.hasOwnProperty.call(DIMENSION_UNITS, dimension))
        continue;
      const key = dimension as MeterDimension;
      result.quantity_limits[key] = reader.decimal(
        value,
        `${path}.quantity_limits.${key}`,
        false,
        DIMENSION_UNITS[key] !== "second",
      );
    }
    result.limit_reference = reader.string(
      raw.limit_reference,
      `${path}.limit_reference`,
      256,
    );
    if (!result.limit_reference.trim())
      reader.invalid(
        `${path}.limit_reference`,
        "An approved limit source/reference is required",
      );
  } else if (raw.limit_reference !== undefined)
    reader.invalid(
      `${path}.limit_reference`,
      "A limit reference requires quantity limits",
    );
  return result;
}

/** Never promote a tokenizer heuristic, requested media length or a returned top_n to actual upper-bound evidence. */
export function reservationQuantityBounds(
  policy: PricingAdmissionPolicy,
  exactRequest: NormalizedUsage,
  operation?: string,
): { bounds: ReservationQuantityBounds; diagnostics: PricingDiagnostic[] } {
  const bounds: ReservationQuantityBounds = {};
  const diagnostics: PricingDiagnostic[] = [];
  for (const [dimension, value] of Object.entries(policy.quantity_limits ?? {}))
    bounds[dimension as MeterDimension] = {
      value,
      basis: "administrator_declared_limit",
    };
  const exact = [
    "requested_image_count",
    "requested_audio_input_seconds",
    "requested_audio_output_seconds",
    "requested_video_seconds",
    "requested_video_generation_count",
    "text_characters",
    "requested_rerank_document_count",
  ] as const;
  for (const dimension of exact) {
    const quantity = exactRequest.quantities[dimension];
    if (
      !quantity ||
      quantity.value === null ||
      quantity.quality !== "observed" ||
      !["request_metadata", "local_measurement"].includes(quantity.source)
    )
      continue;
    if (
      bounds[dimension] &&
      ExactDecimal.parse(quantity.value).compare(
        ExactDecimal.parse(bounds[dimension]!.value),
      ) > 0
    )
      diagnostics.push({
        code: "pricing_reservation_limit_exceeded",
        path: `usage.${dimension}`,
        message:
          "Request quantity exceeds its explicitly approved per-attempt limit",
      });
    bounds[dimension] = {
      value: quantity.value,
      basis: "exact_request_quantity",
    };
  }
  for (const dimension of [
    "request_count",
    ...(operation === "rerank" ? ["rerank_request_count" as const] : []),
  ] as const) {
    if (
      bounds[dimension] &&
      ExactDecimal.parse(bounds[dimension]!.value).compare(ExactDecimal.one) < 0
    )
      diagnostics.push({
        code: "pricing_reservation_limit_exceeded",
        path: `usage.${dimension}`,
        message:
          "A dispatched invocation exceeds the declared zero request limit",
      });
    bounds[dimension] = { value: "1", basis: "single_invocation" };
  }
  for (const dimension of Object.keys(DIMENSION_UNITS) as MeterDimension[]) {
    const parent = [
      "uncached_input_tokens",
      "uncached_text_input_tokens",
      "uncached_audio_input_tokens",
      "uncached_image_input_tokens",
      "cache_read_tokens",
      "cache_write_tokens",
      "cache_write_5m_tokens",
      "cache_write_1h_tokens",
    ].includes(dimension)
      ? "total_input_tokens"
      : [
            "text_output_tokens",
            "audio_output_tokens",
            "image_output_tokens",
            "reasoning_output_tokens",
          ].includes(dimension)
        ? "output_tokens"
        : null;
    if (!parent || !bounds[parent]) continue;
    if (
      !bounds[dimension] ||
      ExactDecimal.parse(bounds[parent]!.value).compare(
        ExactDecimal.parse(bounds[dimension]!.value),
      ) < 0
    )
      bounds[dimension] = {
        value: bounds[parent]!.value,
        basis: "parent_quantity_limit",
        parent,
      };
  }
  return { bounds, diagnostics };
}

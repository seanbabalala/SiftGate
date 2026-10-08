import { calculateCost } from "./cost-calculator";
import { ExactDecimal } from "./exact-decimal";
import { pricingContentHash } from "./pricing-json";
import {
  DIMENSION_UNITS,
  type CostComputation,
  type NormalizedUsage,
  type PricingContext,
  type PricingDiagnostic,
} from "./pricing.types";
import type { FrozenPricingRequest } from "./pricing-catalog";
import type { PricingTarget } from "./pricing-catalog.types";
import type {
  PricingAdmissionAssessment,
  PricingAdmissionPolicy,
  PricingRateEnvelope,
} from "./pricing-admission.types";
import { reservationQuantityBounds } from "./pricing-admission-policy";
import { tokenBudgetCompatible } from "./pricing-token-budget";
import { normalizeCanonicalTokenUsage } from "./usage-normalizer";

/** Shared by real admission and the read-only administrative preview. */
export function assessPricingAdmission(
  snapshot: FrozenPricingRequest,
  target: PricingTarget,
  estimate: NormalizedUsage,
  exactRequest: NormalizedUsage,
  context: PricingContext,
  attempts: number,
  policyOverride?: PricingAdmissionPolicy,
): { cost: CostComputation; assessment: PricingAdmissionAssessment } {
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 1000)
    throw new Error(
      "Pricing admission requires a bounded positive attempt count",
    );
  const policy = policyOverride ?? snapshot.admissionPolicy(target.operation);
  const { bounds, diagnostics } = reservationQuantityBounds(
    policy,
    exactRequest,
    target.operation,
  );
  const usage = structuredClone(estimate);
  // A declared supplier cap may establish a reservation when final usage is necessarily not available yet.
  if (policy.mode === "reserve_upper_bound")
    for (const [dimension, bound] of Object.entries(bounds)) {
      const key = dimension as keyof typeof bounds;
      const quantity = usage.quantities[key];
      if (!quantity || quantity.value === null)
        usage.quantities[key] = {
          dimension: key,
          unit: DIMENSION_UNITS[key],
          value: bound!.value,
          source: "heuristic",
          quality: "estimated",
        };
    }
  const probeContext =
    policy.mode === "reserve_upper_bound"
      ? {
          ...context,
          provider_accepted_at:
            context.provider_accepted_at ?? context.attempt_dispatched_at,
          completed_at: context.completed_at ?? context.attempt_dispatched_at,
          time_estimated: true,
        }
      : context;
  let quote: ReturnType<FrozenPricingRequest["quote"]>;
  try {
    quote = snapshot.quote(target, usage, probeContext);
  } catch {
    quote = {
      snapshot: snapshot.descriptor(),
      target,
      binding_id: null,
      cost: calculateCost(usage, null, {
        report_currency: snapshot.descriptor().report_currency,
      }),
    };
  }
  let envelope: PricingRateEnvelope | null = null;
  const calculationDiagnostics: PricingDiagnostic[] = [];
  if (policy.mode === "reserve_upper_bound") {
    try {
      envelope = snapshot.reservationEnvelope(target, bounds);
    } catch {
      calculationDiagnostics.push({
        code: "pricing_reservation_bound_missing",
        path: "envelope",
        message: "A valid reservation bound could not be established",
      });
    }
  }
  const assessment: PricingAdmissionAssessment = {
    schema_version: 1,
    mode: policy.mode,
    ...(policy.budget_basis !== undefined ? { budget_basis: policy.budget_basis } : {}),
    ...(policy.token_budget !== undefined ? { token_budget: policy.token_budget } : {}),
    policy_hash: pricingContentHash(policy),
    policy_source: policyOverride ? "simulation_override" : "catalog",
    catalog_revision_id: snapshot.descriptor().catalog_revision_id,
    allowed: true,
    reason:
      policy.mode === "compatibility"
        ? "compatible_estimate"
        : "priced_estimate",
    guarantee: "estimate_only",
    attempts,
    per_attempt_cost_usd: quote.cost.report_amount,
    reserved_cost_usd: null,
    quantity_bounds: bounds,
    envelope,
    diagnostics: [
      ...quote.cost.diagnostics,
      ...diagnostics,
      ...calculationDiagnostics,
      ...(envelope?.diagnostics ?? []),
    ],
  };
  if (
    policy.mode !== "compatibility" &&
    (!quote.binding_id || quote.cost.report_amount === null)
  ) {
    assessment.allowed = false;
    assessment.reason = "pricing_unavailable";
    assessment.guarantee = "unavailable";
  }
  if (policy.mode === "reserve_upper_bound") {
    assessment.per_attempt_cost_usd = envelope?.report_amount ?? null;
    if (!envelope?.report_amount) {
      assessment.allowed = false;
      assessment.reason = "bound_unavailable";
      assessment.guarantee = "unavailable";
    } else if (assessment.allowed) {
      assessment.reason = "declared_limit_envelope";
      assessment.guarantee = "conditional_on_declared_limits";
    }
    if (diagnostics.length) {
      assessment.allowed = false;
      assessment.reason = "request_exceeds_declared_limit";
      assessment.guarantee = "unavailable";
    }
    if (target.operation === "realtime") {
      const duration = estimate.quantities.session_seconds?.value;
      const cap = policy.quantity_limits?.session_seconds;
      if (policy.realtime_max_responses === undefined || attempts !== policy.realtime_max_responses + 1 || cap === undefined || duration == null || ExactDecimal.parse(cap).compare(ExactDecimal.parse(duration)) < 0) {
        assessment.allowed = false;
        assessment.reason = "bound_unavailable";
        assessment.guarantee = "unavailable";
      }
    }
  }
  if (!tokenBudgetCompatible(snapshot, target, policy)) {
    assessment.allowed = false;
    assessment.reason = "token_budget_incompatible";
    assessment.guarantee = "unavailable";
    assessment.diagnostics.push({ code: "pricing_token_budget_incompatible", path: "policy.token_budget", message: "Non-token quota requires a supported media operation and a frozen price book with exclusively non-token billing dimensions" });
  }
  if (assessment.allowed && assessment.per_attempt_cost_usd !== null)
    assessment.reserved_cost_usd = ExactDecimal.parse(
      assessment.per_attempt_cost_usd,
    )
      .multiply(ExactDecimal.parse(String(attempts)))
      .toFixed(18, "ceil");
  if (target.operation === "realtime" && policy.realtime_transcription) {
    const extra = assessRealtimeTranscription(snapshot, target.node_id, policy.realtime_transcription, context.attempt_dispatched_at);
    assessment.transcription_allowance = extra;
    assessment.combined_reserved_cost_usd = assessment.reserved_cost_usd !== null && extra.assessment.reserved_cost_usd !== null
      ? ExactDecimal.parse(assessment.reserved_cost_usd).add(ExactDecimal.parse(extra.assessment.reserved_cost_usd)).toFixed(18) : null;
    if (!extra.assessment.allowed) { assessment.allowed = false; assessment.reason = "bound_unavailable"; assessment.guarantee = "unavailable"; assessment.reserved_cost_usd = null; assessment.combined_reserved_cost_usd = null; }
  }
  return { cost: quote.cost, assessment };
}

/** Same frozen ASR plan used by the read-only simulator and pre-connection admission. */
export function assessRealtimeTranscription(snapshot: FrozenPricingRequest, node: string | undefined, plan: NonNullable<PricingAdmissionPolicy["realtime_transcription"]>, at?: string): NonNullable<PricingAdmissionAssessment["transcription_allowance"]> {
  const policy = snapshot.admissionPolicy("audio_transcription");
  const empty = normalizeCanonicalTokenUsage({}, { adapter_id: "realtime-transcription-admission", adapter_version: "1", source: "heuristic", quality: "estimated" });
  const { cost, assessment } = assessPricingAdmission(snapshot, { node_id: node, model: plan.model, operation: "audio_transcription" }, empty, empty, { attempt_dispatched_at: at, media: { operation: "audio_transcription", audio_direction: "input" } }, plan.max_items);
  if (policy.budget_basis !== "actual_upstream" || policy.mode !== "reserve_upper_bound") {
    assessment.allowed = false; assessment.reason = "bound_unavailable"; assessment.guarantee = "unavailable"; assessment.reserved_cost_usd = null;
    assessment.diagnostics.push({ code: "pricing_reservation_bound_missing", path: "policy.audio_transcription", message: "Realtime ASR requires its own actual-upstream upper-bound policy" });
  }
  const reserved_tokens = policy.token_budget === "not_applicable" ? "0" : ExactDecimal.parse(policy.quantity_limits?.total_input_tokens ?? "0").add(ExactDecimal.parse(policy.quantity_limits?.output_tokens ?? "0")).multiply(ExactDecimal.parse(String(plan.max_items))).toFixed(0);
  return { model: plan.model, max_items: plan.max_items, reserved_tokens, assessment, cost };
}

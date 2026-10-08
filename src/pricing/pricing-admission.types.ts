import type { MeterDimension, PricingDiagnostic } from "./pricing.types";

export type PricingAdmissionMode =
  | "compatibility"
  | "reject_unpriced"
  | "reserve_upper_bound";
/** Temporary integration boundary; extend only after the corresponding actual lifecycle is connected. */
export const ACTUAL_UPSTREAM_BUDGET_OPERATIONS: readonly string[] = [
  "chat_completions", "responses", "messages", "embeddings",
  "image_generation", "image_edit", "image_variation", "video_generation",
  "audio_transcription", "audio_translation", "audio_speech", "rerank",
  "realtime",
];
export const NON_TOKEN_BUDGET_OPERATIONS: readonly string[] = [
  "image_generation", "image_edit", "image_variation", "video_generation",
  "audio_transcription", "audio_translation", "audio_speech", "rerank",
  "realtime",
];
export interface PricingAdmissionPolicy {
  mode: PricingAdmissionMode;
  /** Absent on historical policies: preserve the original logical budget basis. */
  budget_basis?: "legacy_logical" | "actual_upstream";
  /** Omission preserves historical token holds, including zero-quantity holds. */
  token_budget?: "reported_tokens" | "not_applicable";
  /** Per-attempt supplier/contract limits, not observed usage or an arbitrary money override. */
  quantity_limits?: Partial<Record<MeterDimension, string>>;
  limit_reference?: string;
  /** Realtime session response allowance; each response retains its own token limits. */
  realtime_max_responses?: number;
  /** Separate ASR contract, reserved before the Realtime supplier connection. */
  realtime_transcription?: { model: string; max_items: number };
}
export interface CatalogAdmissionPolicy {
  workspace_id: string | null;
  operation?: string;
  policy: PricingAdmissionPolicy;
}
export interface ReservationQuantityBound {
  value: string;
  basis:
    | "administrator_declared_limit"
    | "exact_request_quantity"
    | "parent_quantity_limit"
    | "single_invocation";
  parent?: MeterDimension;
}
export type ReservationQuantityBounds = Partial<
  Record<MeterDimension, ReservationQuantityBound>
>;
export interface PricingRateEnvelope {
  algorithm: "nonnegative_rule_envelope_v1";
  currency: string;
  report_currency: string;
  report_amount: string | null;
  fx_version_id: string | null;
  dimensions: Array<{
    dimension: MeterDimension;
    exact_amount: { numerator: string; denominator: string };
  }>;
  diagnostics: PricingDiagnostic[];
}
export interface PricingAdmissionAssessment {
  schema_version: 1;
  mode: PricingAdmissionMode;
  /** Historical assessments omit this just as their original policies did. */
  budget_basis?: PricingAdmissionPolicy["budget_basis"];
  token_budget?: PricingAdmissionPolicy["token_budget"];
  policy_hash: string;
  policy_source: "catalog" | "simulation_override";
  catalog_revision_id: string;
  allowed: boolean;
  reason:
    | "compatible_estimate"
    | "priced_estimate"
    | "declared_limit_envelope"
    | "pricing_unavailable"
    | "bound_unavailable"
    | "token_budget_incompatible"
    | "request_exceeds_declared_limit";
  guarantee: "estimate_only" | "conditional_on_declared_limits" | "unavailable";
  attempts: number;
  per_attempt_cost_usd: string | null;
  reserved_cost_usd: string | null;
  quantity_bounds: ReservationQuantityBounds;
  envelope: PricingRateEnvelope | null;
  diagnostics: PricingDiagnostic[];
  transcription_allowance?: {
    model: string;
    max_items: number;
    reserved_tokens: string;
    assessment: PricingAdmissionAssessment;
    cost: import("./pricing.types").CostComputation;
  };
  /** Sum of separate Realtime and ASR reservations; never a per-response rate. */
  combined_reserved_cost_usd?: string | null;
}

export const PRICING_ADMISSION_OPERATIONS = [
  "chat_completions",
  "responses",
  "messages",
  "gemini_generate_content",
  "embeddings",
  "rerank",
  "image_generation",
  "image_edit",
  "image_variation",
  "audio_transcription",
  "audio_translation",
  "audio_speech",
  "video_generation",
  "realtime",
] as const;

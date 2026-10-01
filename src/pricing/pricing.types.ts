import type { MediaContextSource, MediaSpecification, MediaSpecificationTrace, MediaSpecificationAdapter } from './media-specification.types';
import type { ProviderCostAttribution } from "../providers/provider-cost-attribution.types";
import type { BatchCostReceipt } from "./pricing-batch.types";
import type { PricingAdmissionAssessment } from "./pricing-admission.types";
import type { RoundingMode } from "./exact-decimal";
import type {
  CalendarMatch,
  PricingCalendarDocument,
  PricingTimeBasis,
} from "./pricing-calendar.types";

export const DIMENSION_UNITS = {
  total_input_tokens: "token",
  uncached_input_tokens: "token",
  uncached_text_input_tokens: "token",
  uncached_audio_input_tokens: "token",
  uncached_image_input_tokens: "token",
  cache_read_tokens: "token",
  cache_write_tokens: "token",
  cache_write_5m_tokens: "token",
  cache_write_1h_tokens: "token",
  output_tokens: "token",
  text_output_tokens: "token",
  audio_output_tokens: "token",
  image_output_tokens: "token",
  reasoning_output_tokens: "token",
  request_count: "request",
  image_count: "image",
  requested_image_count: "image",
  audio_input_seconds: "second",
  requested_audio_input_seconds: "second",
  audio_output_seconds: "second",
  requested_audio_output_seconds: "second",
  text_characters: "character",
  video_seconds: "second",
  requested_video_seconds: "second",
  video_generation_count: "generation",
  requested_video_generation_count: "generation",
  rerank_request_count: "request",
  rerank_document_count: "document",
  requested_rerank_document_count: "document",
  rerank_search_units: "search_unit",
  session_seconds: "second",
} as const;

export type MeterDimension = keyof typeof DIMENSION_UNITS;
export type BillableDimension = Exclude<
  MeterDimension,
  "total_input_tokens" | "reasoning_output_tokens"
>;
export type MeterUnit = (typeof DIMENSION_UNITS)[MeterDimension];
export type EvidenceSource =
  | "provider_usage"
  | "provider_job_result"
  | "request_metadata"
  | "local_measurement"
  | "heuristic";
export type EvidenceQuality =
  | "observed"
  | "estimated"
  | "missing"
  | "unsupported";

export interface MeterQuantity {
  dimension: MeterDimension;
  unit: MeterUnit;
  value: string | null;
  source: EvidenceSource;
  quality: EvidenceQuality;
  subset_of?: MeterDimension;
}

export interface PricingDiagnostic {
  code:
    | "pricing_invalid_quantity"
    | "pricing_dimension_missing"
    | "pricing_usage_conflict"
    | "pricing_usage_attested"
    | "pricing_rule_conflict"
    | "pricing_unit_mismatch"
    | "pricing_invalid_rate"
    | "pricing_fx_missing"
    | "pricing_unknown_variant"
    | "unsupported_rule_mode"
    | "pricing_invalid_document"
    | "pricing_calendar_unavailable"
    | "pricing_version_conflict"
    | "pricing_permission_denied"
    | "pricing_reservation_bound_missing"
    | "pricing_token_budget_incompatible"
    | "pricing_reservation_limit_exceeded";
  path: string;
  message: string;
}

export interface NormalizedUsage {
  schema_version: 1;
  adapter_id: string;
  adapter_version: string;
  quantities: Partial<Record<MeterDimension, MeterQuantity>>;
  diagnostics: PricingDiagnostic[];
}

export interface RateComponent {
  id: string;
  dimension: BillableDimension;
  amount: string;
  unit: MeterUnit;
  unit_size: string;
  free?: boolean;
  minimum_quantity?: string;
  quantity_rounding?: { increment: string; mode: RoundingMode };
}

export interface SelectedRateComponent extends RateComponent {
  rule_id: string;
  multipliers: string[];
}

export type PricingSourceKind =
  | "manual"
  | "approved_catalog"
  | "reference"
  | "legacy";

export interface PricingSource {
  kind: PricingSourceKind;
  reference?: string;
  verified_at?: string;
}

export interface ResolvedPrice {
  book_id: string;
  version_id: string;
  content_hash: string;
  currency: string;
  money_precision: number;
  money_rounding: RoundingMode;
  source: PricingSource;
  billing_dimensions: BillableDimension[];
  allow_combined_media: boolean;
  components: SelectedRateComponent[];
  selected_rule_ids: string[];
  selection_estimated: boolean;
  selection: PriceSelectionTrace;
  diagnostics: PricingDiagnostic[];
}

export interface FxSnapshot {
  version_id: string;
  source: string;
  effective_at: string;
  from_currency: string;
  to_currency: string;
  numerator: string;
  denominator: string;
}

export interface CostLine {
  component_id: string;
  rule_id: string;
  dimension: BillableDimension;
  quantity: string;
  billed_quantity: string;
  unit: MeterUnit;
  unit_size: string;
  rate: string;
  multipliers: string[];
  currency: string;
  amount: string;
  exact_amount: { numerator: string; denominator: string };
  report_amount: string | null;
  evidence_source: EvidenceSource;
  evidence_quality: EvidenceQuality;
}

export type PricingStatus =
  | "priced"
  | "estimated"
  | "partial"
  | "unpriced"
  | "missing_usage"
  | "pending"
  | "free"
  | "legacy_estimate";

export interface CostComputation {
  /** Safe normalized evidence retained when batch allocation fails, not a billable quantity substitute. */
  allocation_failure?: { usage: NormalizedUsage };
  /** Top-level totals are this member's share. Nested physical totals must not be added again. */
  batch?: BatchCostReceipt;
  attribution?: ProviderCostAttribution;
  /** Present on reservation estimates only, never an actual supplier fee. */
  admission?: PricingAdmissionAssessment;
  schema_version: 1;
  calculator_version: string;
  status: PricingStatus;
  evidence_status: "observed" | "estimated" | "incomplete";
  book_id: string | null;
  version_id: string | null;
  content_hash: string | null;
  selected_rule_ids: string[];
  selection: PriceSelectionTrace | null;
  usage: NormalizedUsage;
  currency: string | null;
  amount: string | null;
  known_subtotal: string | null;
  rounding_adjustment: string | null;
  report_currency: string;
  report_amount: string | null;
  report_known_subtotal: string | null;
  report_rounding_adjustment: string | null;
  fx_version_id: string | null;
  lines: CostLine[];
  diagnostics: PricingDiagnostic[];
}

export interface PricingRuleCondition {
  input_tokens?: { min: string; max?: string };
  service_tiers?: string[];
  time_tags?: string[];
  media?: Partial<Record<MediaAttribute, string[]>>;
}

export interface PricingRule {
  id: string;
  /** Optional administrator display name; never participates in rule matching. */
  name?: string;
  priority: number;
  mode: "whole_request";
  condition: PricingRuleCondition;
  rates: Array<{ operation: "replace" | "add"; component: RateComponent }>;
  multipliers?: Array<{ dimension: BillableDimension; factor: string }>;
}

export interface PricingRuleGroup {
  id: string;
  order: number;
  required: boolean;
  rules: PricingRule[];
}

export interface PriceBookContent {
  schema_version: 1;
  currency: string;
  money_precision: number;
  money_rounding: RoundingMode;
  source: PricingSource;
  billing_dimensions: BillableDimension[];
  allow_combined_media: boolean;
  groups: PricingRuleGroup[];
  media_specification?: MediaSpecification;
  calendar?: PricingCalendarDocument;
  time_basis?: PricingTimeBasis;
}

export interface PriceBookIdentity {
  book_id: string;
  version_id: string;
}

export interface PricingContext {
  requested_service_tier?: string;
  resolved_service_tier?: string;
  attempt_dispatched_at?: string;
  provider_accepted_at?: string;
  completed_at?: string;
  time_estimated?: boolean;
  media?: Partial<Record<MediaAttribute, string>>;
  media_estimated?: boolean;
  media_sources?: Partial<Record<MediaAttribute, MediaContextSource>>;
  media_adapter?: MediaSpecificationAdapter;
}

export const MEDIA_ATTRIBUTES = [
  "operation",
  "size",
  "width",
  "height",
  "quality",
  "resolution",
  "frame_rate",
  "audio_track",
  "audio_direction",
  "generation_count",
] as const;
export type MediaAttribute = (typeof MEDIA_ATTRIBUTES)[number];

export interface RuleEvaluation {
  group_id: string;
  rule_id: string;
  /** Captured from the selected immutable price version, never a current lookup. */
  rule_name?: string;
  matched: boolean;
  selected: boolean;
  reasons: string[];
}

export interface PriceSelectionTrace {
  requested_service_tier: string | null;
  resolved_service_tier: string | null;
  effective_service_tier: string;
  service_tier_basis: "resolved" | "requested" | "default";
  time_basis: PricingTimeBasis | null;
  calendar_match: CalendarMatch | null;
  media: Partial<Record<MediaAttribute, string>>;
  evaluations: RuleEvaluation[];
  media_specification?: MediaSpecificationTrace;
}

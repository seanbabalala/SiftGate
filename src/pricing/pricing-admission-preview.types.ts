import type { PricingAdmissionAssessment, PricingAdmissionPolicy } from './pricing-admission.types';
import type { PricingTarget } from './pricing-catalog.types';
import type { PricingHead } from './pricing-repository.types';
import type { CostComputation, EvidenceQuality, EvidenceSource, MeterDimension, PricingContext } from './pricing.types';

export interface PricingAdmissionPreviewInput {
  target: PricingTarget & { operation: string };
  evidence: Array<{ dimension: MeterDimension; value: string | null; source: EvidenceSource; quality: EvidenceQuality }>;
  context: PricingContext;
  attempts: number;
  policy?: PricingAdmissionPolicy;
}
export interface PricingAdmissionPreview {
  simulation: true;
  workspace_id: string;
  evaluated_at: string;
  target: PricingTarget;
  head: PricingHead;
  cost: CostComputation;
  assessment: PricingAdmissionAssessment;
  request_hash: string;
  response_hash: string;
}

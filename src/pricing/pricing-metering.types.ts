import type { MediaContextSource, MediaSpecification, MediaSpecificationAdapter } from './media-specification.types';
import type { BillableDimension, MediaAttribute } from './pricing.types';
import type { PricingPublishTarget } from './pricing-repository.types';
import type { VideoResultProfile } from './video-result-profile.types';

export const METERING_AVAILABILITIES = ['conditional', 'request_metadata', 'local_measurement', 'manual_only', 'unsupported'] as const;
export type MeteringAvailability = (typeof METERING_AVAILABILITIES)[number];
export const METERING_NOTICES = ['operation_unspecified', 'provider_evidence_required', 'modality_allocation_required', 'realtime_session_contract_required', 'request_basis_only', 'manual_evidence_required', 'supplier_contract_required', 'timestamp_contract_required', 'operation_unsupported', 'dimension_unsupported', 'limits_not_verified', 'model_support_unverified', 'video_profile_unspecified', 'media_specification_operation_required', 'model_fixed_specification'] as const;
export type MeteringNotice = (typeof METERING_NOTICES)[number];
export interface MeteringDimensionReview { dimension: BillableDimension; availability: MeteringAvailability }
export interface MeteringTargetReview {
  target: PricingPublishTarget;
  video_profile: VideoResultProfile | null;
  candidate_operations: string[];
  dimensions: MeteringDimensionReview[];
  notices: MeteringNotice[];
  can_publish: boolean;
  media_specification?: {
    enabled: boolean;
    fixed: MediaSpecification['fixed'];
    adapters: Array<{ operation: string; profile: MediaSpecificationAdapter; sources: Partial<Record<MediaAttribute, MediaContextSource[]>> }>;
  };
}
/** Adapter capability is not proof that a remote model supplied a complete receipt. */
export interface PricingMeteringReview {
  schema_version: 1;
  registry_version: 'gateway-metering-v1' | 'gateway-metering-v2' | 'gateway-metering-v3' | 'gateway-metering-v4' | 'gateway-metering-v5';
  content_hash: string;
  targets: MeteringTargetReview[];
  can_publish: boolean;
  supplier_support_verified: false;
  quantity_limits_verified: false;
  assessment_hash: string;
}

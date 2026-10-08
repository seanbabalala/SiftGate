import type { MediaAttribute } from './pricing.types';

export const MEDIA_SPECIFICATION_ADAPTERS = ['generic-v1', 'gemini-veo-rest-v1', 'runway-task-v1', 'siftgate-media-event-v1'] as const;
export type MediaSpecificationAdapter = (typeof MEDIA_SPECIFICATION_ADAPTERS)[number];

/** Operation, direction and output count are metering facts, never model-fixed overrides. */
export const FIXED_MEDIA_ATTRIBUTES = ['size', 'width', 'height', 'quality', 'resolution', 'frame_rate', 'audio_track'] as const;
export type FixedMediaAttribute = (typeof FIXED_MEDIA_ATTRIBUTES)[number];
export const MEDIA_CONTEXT_SOURCES = ['request_parameter', 'provider_result', 'operation'] as const;
export type MediaContextSource = (typeof MEDIA_CONTEXT_SOURCES)[number];
/** Explicit, immutable model contract. Omission preserves legacy adapter selection. */
export interface MediaSpecification {
  fixed: Partial<Record<FixedMediaAttribute, string>>;
}
export interface MediaSpecificationAttribute {
  source: MediaContextSource | 'model_fixed' | 'unspecified';
  value: string | null;
  supplied_value: string | null;
  supplied_source: MediaContextSource | null;
  conflict: boolean;
  supplied_invalid: boolean;
}
export interface MediaSpecificationTrace {
  resolver_version: '1';
  adapter: MediaSpecificationAdapter | null;
  attributes: Partial<Record<MediaAttribute, MediaSpecificationAttribute>>;
}

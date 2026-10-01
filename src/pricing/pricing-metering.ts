import { FIXED_MEDIA_ATTRIBUTES, type MediaContextSource, type MediaSpecificationAdapter } from './media-specification.types';
import { VIDEO_RESULT_PROFILES } from './video-result-profile.types';
import { PRICING_ADMISSION_OPERATIONS } from './pricing-admission.types';
import { pricingContentHash } from './pricing-json';
import type { BillableDimension, PriceBookContent, MediaAttribute } from './pricing.types';
import type { PricingPublishTarget } from './pricing-repository.types';
import type { VideoResultProfile } from './video-result-profile.types';
import type { MeteringAvailability, MeteringNotice, PricingMeteringReview } from './pricing-metering.types';

const TOKEN_DIMENSIONS: BillableDimension[] = ['uncached_input_tokens', 'cache_read_tokens', 'cache_write_tokens', 'cache_write_5m_tokens', 'cache_write_1h_tokens', 'output_tokens'];
const MODALITY_DIMENSIONS: BillableDimension[] = ['uncached_text_input_tokens', 'uncached_audio_input_tokens', 'uncached_image_input_tokens', 'text_output_tokens', 'audio_output_tokens', 'image_output_tokens'];
const CHAT_OPERATIONS = ['chat_completions', 'responses', 'messages'];
const MEDIA_OPERATIONS = ['image_generation', 'image_edit', 'image_variation', 'audio_transcription', 'audio_translation', 'audio_speech', 'video_generation'];
const FORMAT_DIMENSIONS: Record<string, BillableDimension[]> = {
  image_generation: ['image_count', 'requested_image_count'],
  image_edit: ['image_count', 'requested_image_count'],
  image_variation: ['image_count', 'requested_image_count'],
  audio_transcription: ['audio_input_seconds', 'requested_audio_input_seconds'],
  audio_translation: ['audio_input_seconds', 'requested_audio_input_seconds'],
  audio_speech: ['audio_output_seconds', 'requested_audio_output_seconds', 'text_characters'],
  video_generation: ['video_seconds', 'requested_video_seconds', 'video_generation_count', 'requested_video_generation_count'],
  rerank: ['rerank_request_count', 'rerank_document_count', 'requested_rerank_document_count', 'rerank_search_units'],
};

/** Inventory of implemented extraction paths, not a model-name/provider-price catalog. */
export function meteringAvailability(operation: string, dimension: BillableDimension, profile?: VideoResultProfile): MeteringAvailability {
  if (!(PRICING_ADMISSION_OPERATIONS as readonly string[]).includes(operation)) return 'unsupported';
  if (dimension === 'request_count') return 'local_measurement';
  if (operation === 'realtime') {
    if (dimension === 'session_seconds') return 'local_measurement';
    return TOKEN_DIMENSIONS.includes(dimension) || MODALITY_DIMENSIONS.includes(dimension) && dimension !== 'image_output_tokens' ? 'conditional' : 'unsupported';
  }
  if (operation === 'video_generation' && profile && profile !== 'generic-v1') {
    if (dimension.startsWith('requested_video_')) return 'request_metadata';
    if (dimension === 'video_generation_count') return 'conditional';
    // Native result translators deliberately do not synthesize actual seconds or token receipts.
    if (dimension === 'video_seconds') return 'manual_only';
    return 'unsupported';
  }
  if (TOKEN_DIMENSIONS.includes(dimension)) return 'conditional';
  // These are ingress formats: all can route to a Chat Completions upstream.
  // Raw Chat and native Gemini adapters cover these subsets conditionally.
  if (CHAT_OPERATIONS.includes(operation) && MODALITY_DIMENSIONS.includes(dimension)) return 'conditional';
  if (MEDIA_OPERATIONS.includes(operation) && MODALITY_DIMENSIONS.includes(dimension)) return 'conditional';
  if (!FORMAT_DIMENSIONS[operation]?.includes(dimension)) return 'unsupported';
  if (dimension.startsWith('requested_') || dimension === 'text_characters') return 'request_metadata';
  if (dimension === 'rerank_request_count') return 'local_measurement';
  return 'conditional';
}

/** Declaration of the actual extractor, not a vendor model-name inference. */
export function mediaSpecificationSources(operation: string, profile: MediaSpecificationAdapter): Partial<Record<MediaAttribute, MediaContextSource[]>> {
  if (!MEDIA_OPERATIONS.includes(operation)) return {};
  if (profile === 'siftgate-media-event-v1') return {
    ...Object.fromEntries(FIXED_MEDIA_ATTRIBUTES.map(key => [key, ['provider_result', 'request_parameter']])),
    operation: ['provider_result', 'operation'], audio_direction: ['provider_result', 'operation'], generation_count: ['provider_result', 'request_parameter'],
  };
  if (operation === 'video_generation' && profile !== 'generic-v1')
    return { operation: ['operation'], resolution: ['request_parameter'], size: ['request_parameter'], width: ['request_parameter'], height: ['request_parameter'] };
  return { operation: ['operation'], ...(operation.startsWith('audio_') ? { audio_direction: ['operation'] as MediaContextSource[] } : {}),
    ...Object.fromEntries(FIXED_MEDIA_ATTRIBUTES.map(key => [key, ['provider_result', 'request_parameter']])), generation_count: ['request_parameter'] };
}

export function assessPricingMetering(content: PriceBookContent, targets: PricingPublishTarget[], profileForNode: (id: string) => VideoResultProfile | undefined = () => undefined): PricingMeteringReview {
  const reviews = targets.map(target => {
    const profile = target.node_id ? profileForNode(target.node_id) : undefined;
    const operations = target.operation ? [target.operation] : [...PRICING_ADMISSION_OPERATIONS];
    const compatible = operations.filter(operation => (!content.media_specification || Boolean(target.operation) && MEDIA_OPERATIONS.includes(operation)) && content.billing_dimensions.every(dimension => meteringAvailability(operation, dimension, profile) !== 'unsupported'));
    const notices = new Set<MeteringNotice>(['model_support_unverified', 'limits_not_verified']);
    if (!target.operation) notices.add('operation_unspecified');
    if (target.operation && !(PRICING_ADMISSION_OPERATIONS as readonly string[]).includes(target.operation)) notices.add('operation_unsupported');
    const dimensions = content.billing_dimensions.map(dimension => {
      const alternatives = (compatible.length ? compatible : operations).map(operation => meteringAvailability(operation, dimension, profile));
      const availability: MeteringAvailability = alternatives.find(value => value !== 'unsupported') ?? 'unsupported';
      if (availability === 'unsupported') notices.add('dimension_unsupported');
      if (availability === 'conditional') notices.add('provider_evidence_required');
      if (availability !== 'unsupported' && MODALITY_DIMENSIONS.includes(dimension)) notices.add('modality_allocation_required');
      if (availability === 'manual_only') notices.add('manual_evidence_required');
      if (availability === 'request_metadata') notices.add('request_basis_only');
      return { dimension, availability };
    });
    if (!compatible.length) notices.add('dimension_unsupported');
    if (content.media_specification && (!target.operation || !MEDIA_OPERATIONS.includes(target.operation))) notices.add('media_specification_operation_required');
    if (Object.keys(content.media_specification?.fixed ?? {}).length) notices.add('model_fixed_specification');
    if (content.groups.some(group => group.rules.some(rule => rule.condition.service_tiers?.length))) notices.add('supplier_contract_required');
    if (content.time_basis && content.time_basis !== 'attempt_dispatched_at') notices.add('timestamp_contract_required');
    if (compatible.includes('realtime')) notices.add('realtime_session_contract_required');
    if (compatible.includes('video_generation') && !profile) notices.add('video_profile_unspecified');
    const profiles: MediaSpecificationAdapter[] = target.operation && MEDIA_OPERATIONS.includes(target.operation) ? target.operation === 'video_generation' ? profile ? [profile] : [...VIDEO_RESULT_PROFILES] : ['generic-v1'] : [];
    if (target.operation && ['image_generation', 'image_edit', 'image_variation', 'video_generation'].includes(target.operation)) profiles.push('siftgate-media-event-v1');
    const adapters = profiles.map(selected => ({ operation: target.operation!, profile: selected, sources: mediaSpecificationSources(target.operation!, selected) }));
    return { media_specification: { enabled: Boolean(content.media_specification), fixed: { ...content.media_specification?.fixed }, adapters }, target: { ...target }, video_profile: profile ?? null, candidate_operations: compatible, dimensions, notices: [...notices].sort(), can_publish: compatible.length > 0 };
  });
  const review: PricingMeteringReview = { schema_version: 1, registry_version: 'gateway-metering-v5', content_hash: pricingContentHash(content), targets: reviews, can_publish: reviews.every(row => row.can_publish), supplier_support_verified: false, quantity_limits_verified: false, assessment_hash: '' };
  review.assessment_hash = pricingContentHash({ ...review, assessment_hash: undefined });
  return review;
}

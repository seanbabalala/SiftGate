import type { PriceBookContent, PricingContext } from '@/types/pricing'
import type { FixedMediaAttribute, MediaContextSource, MediaSpecificationAdapter } from '../../../src/pricing/media-specification.types'

export function enableMediaSpecification(content: PriceBookContent, enabled: boolean): PriceBookContent {
  const next = structuredClone(content)
  if (enabled) next.media_specification ??= { fixed: {} }
  else delete next.media_specification
  return next
}
export function fixedMediaSpecification(content: PriceBookContent, attribute: FixedMediaAttribute, value: string | null): PriceBookContent {
  const next = enableMediaSpecification(content, true)
  if (value === null) delete next.media_specification!.fixed[attribute]
  else next.media_specification!.fixed[attribute] = value
  return next
}
export function simulatedMediaSources(media: PricingContext['media'], source: MediaContextSource, adapter: MediaSpecificationAdapter): Pick<PricingContext, 'media_sources' | 'media_adapter' | 'media_estimated'> {
  return { media_adapter: adapter, media_estimated: source === 'request_parameter', media_sources: Object.fromEntries(Object.keys(media ?? {}).map(key => [key, ['operation', 'audio_direction'].includes(key) ? 'operation' : key === 'generation_count' ? 'request_parameter' : source])) }
}

export function inheritedMediaSpecification(content: PriceBookContent, parent: PriceBookContent): PriceBookContent {
  const next = enableMediaSpecification(content, false)
  if (parent.media_specification) next.media_specification = structuredClone(parent.media_specification)
  return next
}

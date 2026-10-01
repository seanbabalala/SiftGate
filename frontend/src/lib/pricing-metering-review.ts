import { FIXED_MEDIA_ATTRIBUTES, MEDIA_CONTEXT_SOURCES, MEDIA_SPECIFICATION_ADAPTERS } from '../../../src/pricing/media-specification.types'
import { costHash } from './usage-recovery-form'
import { METERING_AVAILABILITIES, METERING_NOTICES } from '../../../src/pricing/pricing-metering.types'
import { DIMENSION_UNITS, MEDIA_ATTRIBUTES } from '../../../src/pricing/pricing.types'
import type { PricingMeteringReview } from '../../../src/pricing/pricing-metering.types'
import type { PricingPublishOptions } from '@/types/pricing'

export async function verifyMeteringReview(value: PricingMeteringReview, contentHash: string, targets: PricingPublishOptions['targets']): Promise<void> {
  const fail = (): never => { throw new Error('invalid_metering_review') }
  if (!value || value.schema_version !== 1 || !['gateway-metering-v1', 'gateway-metering-v2', 'gateway-metering-v3', 'gateway-metering-v4', 'gateway-metering-v5'].includes(value.registry_version) || value.content_hash !== contentHash || value.supplier_support_verified !== false || value.quantity_limits_verified !== false || !Array.isArray(value.targets) || value.targets.length !== targets.length || targets.length > 256 || typeof value.can_publish !== 'boolean') fail()
  const { assessment_hash, ...body } = value
  if (!/^[a-f0-9]{64}$/.test(assessment_hash) || await costHash(body) !== assessment_hash) fail()
  for (let i = 0; i < targets.length; i++) {
    const row = value.targets[i]
    if (!row || await costHash(row.target) !== await costHash(targets[i]) || !Array.isArray(row.dimensions) || row.dimensions.length > 30 || new Set(row.dimensions.map(d => d.dimension)).size !== row.dimensions.length || !Array.isArray(row.notices) || row.notices.some(n => !METERING_NOTICES.includes(n)) || !Array.isArray(row.candidate_operations) || row.candidate_operations.length > 14 || row.can_publish !== (row.candidate_operations.length > 0)) fail()
    const spec = row.media_specification
    if (value.registry_version === 'gateway-metering-v5' && !spec) fail()
    if (spec) {
      if (typeof spec.enabled !== 'boolean' || !spec.fixed || typeof spec.fixed !== 'object' || Array.isArray(spec.fixed) || Object.entries(spec.fixed).some(([key, v]) => !(FIXED_MEDIA_ATTRIBUTES as readonly string[]).includes(key) || typeof v !== 'string' || !v || v.length > 128) || !Array.isArray(spec.adapters) || spec.adapters.length > 4) fail()
      if (!spec.enabled && Object.keys(spec.fixed).length || new Set(spec.adapters.map(adapter => adapter.profile)).size !== spec.adapters.length) fail()
      for (const adapter of spec.adapters) {
        if (!adapter || adapter.operation !== row.target.operation || !MEDIA_SPECIFICATION_ADAPTERS.includes(adapter.profile) || !adapter.sources || typeof adapter.sources !== 'object' || Array.isArray(adapter.sources)) fail()
        for (const [key, sources] of Object.entries(adapter.sources)) if (!(MEDIA_ATTRIBUTES as readonly string[]).includes(key) || !Array.isArray(sources) || !sources.length || sources.length > 3 || new Set(sources).size !== sources.length || sources.some(source => !MEDIA_CONTEXT_SOURCES.includes(source))) fail()
      }
    }
    for (const dimension of row.dimensions) if (!(dimension.dimension in DIMENSION_UNITS) || !METERING_AVAILABILITIES.includes(dimension.availability)) fail()
  }
  if (value.can_publish !== value.targets.every(row => row.can_publish)) fail()
}

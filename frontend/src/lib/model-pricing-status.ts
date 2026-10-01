import type { NodeInfo } from '@/types/api'
import { PRICING_ADMISSION_OPERATIONS, type ModelPriceVersion, type ModelPricingStatusPage, type ModelPricingTarget } from '@/types/pricing'

export const MODEL_PRICING_PAGE_SIZE = 10
export function pricingModelIds(node: NodeInfo): string[] {
  return [...new Set([
    ...node.models, ...node.embedding_models ?? [], ...node.rerank_models ?? [],
    ...node.image_models ?? [], ...node.audio_models ?? [], ...node.video_models ?? [],
    ...node.realtime_models ?? [], ...node.realtime?.models ?? [],
    ...Object.keys(node.model_capabilities ?? {}), ...Object.values(node.aliases ?? {}),
  ])].sort()
}
export function pricingEditorLink(target: ModelPricingTarget, price?: Pick<ModelPriceVersion, 'binding'> | null): string {
  const params = new URLSearchParams({ node: target.node_id, model: target.model, operation: target.operation })
  if (price) { params.set('book', price.binding.book_id); params.set('version', price.binding.version_id) }
  return `/pricing?${params}`
}
export function pricingTargetContext(params: URLSearchParams): ModelPricingTarget | undefined {
  const node_id = params.get('node'), model = params.get('model'), operation = params.get('operation')
  if (!node_id?.trim() || node_id.length > 128 || !model?.trim() || model.length > 256 || !(PRICING_ADMISSION_OPERATIONS as readonly string[]).includes(operation ?? '')) return undefined
  return { node_id, model, operation: operation! }
}
export function priceFamilyForOperation(operation?: string): string {
  if (operation?.startsWith('image_')) return 'image'
  if (operation?.startsWith('audio_')) return 'audio'
  if (operation === 'video_generation') return 'video'
  return operation === 'rerank' ? 'rerank' : 'token'
}

/** Reject a response for another scope/page before displaying any model's metadata. */
export function verifyModelPricingStatus(value: ModelPricingStatusPage, workspace: string, targets: ModelPricingTarget[]): ModelPricingStatusPage {
  const invalid = () => { throw new Error('invalid_model_pricing_status') }
  if (value?.workspace_id !== workspace || value.read_only !== true || value.supplier_support_verified !== false || typeof value.schema_available !== 'boolean' || !Number.isFinite(Date.parse(value.evaluated_at)) || !Array.isArray(value.rows) || value.rows.length !== targets.length) invalid()
  for (const [index, row] of value.rows.entries()) {
    const target = targets[index]
    if (row.target?.node_id !== target.node_id || row.target?.model !== target.model || row.target?.operation !== target.operation || !Array.isArray(row.scheduled) || row.scheduled.length > 8 || typeof row.schedule_truncated !== 'boolean') invalid()
    if (!['compatibility', 'reject_unpriced', 'reserve_upper_bound'].includes(row.policy?.mode) || !['legacy_logical', 'actual_upstream'].includes(row.policy?.budget_basis)) invalid()
    const check = (price: ModelPriceVersion | null, at: number) => {
      if (price === null) return
      const binding = price?.binding
      if (!binding || !binding.book_id || !binding.version_id || !binding.id || binding.model !== target.model || (binding.node_id !== undefined && binding.node_id !== target.node_id) || (binding.operation !== undefined && binding.operation !== target.operation) || (binding.workspace_id !== null && binding.workspace_id !== workspace) || !['node', 'model', 'catalog', 'legacy'].includes(binding.level)) invalid()
      if (!(Date.parse(binding.effective_from) <= at) || (binding.effective_to && !(at < Date.parse(binding.effective_to)))) invalid()
      if (typeof price.book_name !== 'string' || !/^[a-f0-9]{64}$/.test(price.content_hash) || !/^[A-Z]{3}$/.test(price.currency) || !['manual', 'approved_catalog', 'reference', 'legacy'].includes(price.source?.kind) || !Array.isArray(price.dimensions) || !Array.isArray(price.missing_rate_dimensions) || typeof price.conditional !== 'boolean' || typeof price.review_required !== 'boolean') invalid()
      if (price.parent !== null && (!price.parent?.book_id || !price.parent.version_id || !/^[a-f0-9]{64}$/.test(price.parent.content_hash))) invalid()
    }
    check(row.current, Date.parse(value.evaluated_at))
    let previous = Date.parse(value.evaluated_at)
    for (const change of row.scheduled) {
      const at = Date.parse(change.effective_at)
      if (!(at > previous)) invalid()
      check(change.price, at); previous = at
    }
    if (!value.schema_available && (row.current || row.scheduled.length || value.head)) invalid()
    if (row.legacy_reference !== null && (!['node_model_config', 'gateway_config', 'catalog'].includes(row.legacy_reference?.source) || row.legacy_reference.review_required !== true || (row.legacy_reference.currency !== null && !/^[A-Z]{3}$/.test(row.legacy_reference.currency)))) invalid()
  }
  return value
}

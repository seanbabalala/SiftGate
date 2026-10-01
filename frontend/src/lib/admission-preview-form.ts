import { DIMENSION_UNITS, MEDIA_ATTRIBUTES, PRICING_ADMISSION_OPERATIONS } from '@/types/pricing'
import { costHash } from './usage-recovery-form'
import { correctionCost, type CorrectionCostSummary } from './attempt-correction-form'
import { admissionPolicyWithBasis, admissionPolicyWithTokenBudget, actualBudgetOperation, nonTokenBudgetOperation, type TokenBudgetChoice, type BudgetBasisChoice } from './admission-policy-form'
import { transcriptionDeclaration, validTranscriptionDeclaration } from './admission-policy-form'
import { parsePricingInstant } from '../../../src/pricing/pricing-time'
import type { EvidenceQuality, EvidenceSource, MeterDimension, PricingContext } from '../../../src/pricing/pricing.types'
import type { PricingAdmissionPolicy } from '../../../src/pricing/pricing-admission.types'
import type { PricingAdmissionPreview, PricingAdmissionPreviewInput } from '../../../src/pricing/pricing-admission-preview.types'

export const PREVIEW_SOURCES: EvidenceSource[] = ['heuristic', 'request_metadata', 'local_measurement', 'provider_usage', 'provider_job_result']
export const PREVIEW_QUALITIES: EvidenceQuality[] = ['estimated', 'observed', 'missing', 'unsupported']
export interface PreviewQuantity { dimension: MeterDimension; value: string; source: EvidenceSource; quality: EvidenceQuality }
export interface AdmissionScenario {
  model: string; node: string; operation: string; attempts: string;
  quantities: PreviewQuantity[];
  dispatchedAt: string; acceptedAt: string; completedAt: string;
  requestedTier: string; resolvedTier: string; media: Record<string, string>;
  override: boolean; mode: PricingAdmissionPolicy['mode']; limits: Partial<Record<MeterDimension, string>>; reference: string;
  realtimeMaxResponses?: string;
  transcriptionModel?: string;
  transcriptionLimit?: string;
  budgetBasis?: BudgetBasisChoice;
  tokenBudget?: TokenBudgetChoice;
}
function fail(): never { throw new Error('invalid_admission_preview') }
const decimal = (v: unknown): v is string => typeof v === 'string' && /^-?\d{1,30}(?:\.\d{1,18})?$/.test(v) && (!v.startsWith('-') || !/[1-9]/.test(v))
const money = (v: unknown) => v === null || typeof v === 'string' && /^\d{1,64}(?:\.\d{1,18})?$/.test(v)
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
const scaled = (value: string) => { const [whole, fraction = ''] = value.split('.'); return BigInt(whole + fraction.padEnd(18, '0')) }
const text = (v: unknown, max = 256): v is string => typeof v === 'string' && v.length > 0 && v.length <= max
const dimension = (v: string): v is MeterDimension => Object.hasOwn(DIMENSION_UNITS, v)
function quantity(value: string, key: MeterDimension) { if (!decimal(value) || DIMENSION_UNITS[key] !== 'second' && !/^-?\d+(?:\.0+)?$/.test(value)) fail(); return value }

export function previewQuantity(key: MeterDimension): PreviewQuantity {
  const request = key.startsWith('requested_') || key === 'text_characters'
  return { dimension: key, value: '', source: request ? 'request_metadata' : 'heuristic', quality: request ? 'observed' : 'estimated' }
}
export function previewDimensions(operation: string): MeterDimension[] {
  if (operation === 'realtime') return ['total_input_tokens', 'uncached_input_tokens', 'output_tokens', 'cache_read_tokens', 'session_seconds', 'request_count'];
  if (operation.startsWith('image_')) return ['requested_image_count', 'image_count', 'request_count']
  if (operation === 'video_generation') return ['requested_video_seconds', 'requested_video_generation_count', 'video_seconds', 'video_generation_count', 'request_count']
  if (operation === 'audio_speech') return ['text_characters', 'requested_audio_output_seconds', 'audio_output_seconds', 'request_count']
  if (operation.startsWith('audio_')) return ['requested_audio_input_seconds', 'audio_input_seconds', 'request_count']
  if (operation === 'rerank') return ['requested_rerank_document_count', 'rerank_document_count', 'rerank_search_units', 'rerank_request_count']
  return ['total_input_tokens', 'uncached_input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'cache_write_5m_tokens', 'cache_write_1h_tokens']
}
export function admissionScenario(): AdmissionScenario {
  return { model: '', node: '', operation: 'chat_completions', attempts: '1', quantities: previewDimensions('chat_completions').map(previewQuantity), dispatchedAt: new Date().toISOString(), acceptedAt: '', completedAt: '', requestedTier: 'default', resolvedTier: '', media: {}, override: false, mode: 'compatibility', limits: {}, reference: '' }
}
export function admissionPreviewInput(state: AdmissionScenario): PricingAdmissionPreviewInput {
  if (!text(state.model.trim()) || state.node.trim().length > 128 || !(PRICING_ADMISSION_OPERATIONS as readonly string[]).includes(state.operation) || !/^[1-9]\d{0,3}$/.test(state.attempts) || Number(state.attempts) > 1000 || state.quantities.length > Object.keys(DIMENSION_UNITS).length || new Set(state.quantities.map(q => q.dimension)).size !== state.quantities.length) fail()
  const evidence = state.quantities.map(row => {
    if (!dimension(row.dimension) || !PREVIEW_SOURCES.includes(row.source) || !PREVIEW_QUALITIES.includes(row.quality) || row.source === 'heuristic' && row.quality === 'observed') fail()
    const missing = !row.value.trim() || ['missing', 'unsupported'].includes(row.quality)
    return { dimension: row.dimension, value: missing ? null : quantity(row.value.trim(), row.dimension), source: row.source, quality: missing && row.quality !== 'unsupported' ? 'missing' as const : row.quality }
  })
  const context: PricingContext = {}
  for (const [key, value] of [['attempt_dispatched_at', state.dispatchedAt], ['provider_accepted_at', state.acceptedAt], ['completed_at', state.completedAt]] as const) if (value.trim()) { parsePricingInstant(value.trim()); context[key] = value.trim() }
  for (const [key, value] of [['requested_service_tier', state.requestedTier], ['resolved_service_tier', state.resolvedTier]] as const) if (value.trim()) { if (!text(value.trim(), 128)) fail(); context[key] = value.trim() }
  const media: PricingContext['media'] = {}
  for (const [key, value] of Object.entries(state.media)) if (value.trim()) { if (!MEDIA_ATTRIBUTES.includes(key as typeof MEDIA_ATTRIBUTES[number]) || !text(value.trim(), 128)) fail(); media[key as typeof MEDIA_ATTRIBUTES[number]] = value.trim() }
  if (Object.keys(media).length) context.media = media
  let policy: PricingAdmissionPolicy | undefined
  if (state.override) {
    if (!['compatibility', 'reject_unpriced', 'reserve_upper_bound'].includes(state.mode)) fail()
    const limits: NonNullable<PricingAdmissionPolicy['quantity_limits']> = {}
    for (const [key, value] of Object.entries(state.limits)) if (value?.trim()) { if (!dimension(key)) fail(); limits[key] = quantity(value.trim(), key) }
    policy = { mode: state.mode }
    if (state.budgetBasis === 'actual_upstream' && !actualBudgetOperation(state.operation)) fail()
    policy = admissionPolicyWithTokenBudget(admissionPolicyWithBasis(policy, state.budgetBasis ?? ''), state.tokenBudget ?? '')!
    if (policy.token_budget && (policy.budget_basis !== 'actual_upstream' || policy.token_budget === 'not_applicable' && !nonTokenBudgetOperation(state.operation))) fail()
    if (state.realtimeMaxResponses?.trim()) { if (!/^[1-9]\d{0,2}$/.test(state.realtimeMaxResponses.trim())) fail(); policy.realtime_max_responses = Number(state.realtimeMaxResponses) }
    const asr = transcriptionDeclaration(state.transcriptionModel ?? '', state.transcriptionLimit ?? '')
    if (asr) { if (state.operation !== 'realtime' || !validTranscriptionDeclaration(state.transcriptionModel ?? '', state.transcriptionLimit ?? '')) fail(); policy.realtime_transcription = asr }
    if (Object.keys(limits).length) { if (!text(state.reference.trim())) fail(); policy.quantity_limits = limits; policy.limit_reference = state.reference.trim() }
  }
  return { target: { model: state.model.trim(), ...(state.node.trim() ? { node_id: state.node.trim() } : {}), operation: state.operation }, evidence, context, attempts: Number(state.attempts), ...(policy ? { policy } : {}) }
}
export function admissionPreviewReady(state: AdmissionScenario) { try { admissionPreviewInput(state); return true } catch { return false } }

export interface AdmissionPreviewView { reply: PricingAdmissionPreview; quote: CorrectionCostSummary }
export async function verifyAdmissionPreview(reply: PricingAdmissionPreview, input: PricingAdmissionPreviewInput, workspace: string): Promise<AdmissionPreviewView> {
  if (!reply || reply.simulation !== true || reply.workspace_id !== workspace || !hash(reply.request_hash) || !hash(reply.response_hash) || JSON.stringify(reply).length > 4 * 1024 * 1024 || !reply.head || !Number.isSafeInteger(reply.head.revision) || reply.head.revision < 0 || !text(reply.evaluated_at)) fail()
  parsePricingInstant(reply.evaluated_at)
  const { response_hash, ...body } = reply
  if (await costHash(body) !== response_hash || await costHash(input) !== reply.request_hash || await costHash(input.target) !== await costHash(reply.target)) fail()
  const a = reply.assessment
  if (!a || a.schema_version !== 1 || !['compatibility', 'reject_unpriced', 'reserve_upper_bound'].includes(a.mode) || typeof a.allowed !== 'boolean' || !hash(a.policy_hash) || a.policy_source !== (input.policy ? 'simulation_override' : 'catalog') || a.attempts !== input.attempts || !text(a.catalog_revision_id) || reply.head.catalog_revision_id !== null && a.catalog_revision_id !== reply.head.catalog_revision_id || !['compatible_estimate', 'priced_estimate', 'declared_limit_envelope', 'pricing_unavailable', 'bound_unavailable', 'request_exceeds_declared_limit', 'token_budget_incompatible'].includes(a.reason) || !['estimate_only', 'conditional_on_declared_limits', 'unavailable'].includes(a.guarantee) || !money(a.per_attempt_cost_usd) || !money(a.reserved_cost_usd) || !Array.isArray(a.diagnostics) || a.diagnostics.length > 4096) fail()
  if (input.policy && (a.mode !== input.policy.mode || a.policy_hash !== await costHash(input.policy))) fail()
  if (a.budget_basis !== undefined && !['legacy_logical', 'actual_upstream'].includes(a.budget_basis)) fail()
  if (input.policy && a.budget_basis !== input.policy.budget_basis) fail()
  if (a.token_budget !== undefined && (!['reported_tokens', 'not_applicable'].includes(a.token_budget) || a.budget_basis !== 'actual_upstream')) fail()
  if (input.policy && a.token_budget !== input.policy.token_budget) fail()
  if (!a.allowed && (a.reserved_cost_usd !== null || a.guarantee !== 'unavailable')) fail()
  if (a.allowed && (a.guarantee === 'unavailable' || a.per_attempt_cost_usd === null && a.reserved_cost_usd !== null || a.per_attempt_cost_usd !== null && (a.reserved_cost_usd === null || scaled(a.reserved_cost_usd) !== scaled(a.per_attempt_cost_usd) * BigInt(input.attempts)))) fail()
  if (a.guarantee === 'conditional_on_declared_limits' && (a.mode !== 'reserve_upper_bound' || !a.allowed || a.reserved_cost_usd === null)) fail()
  if (!a.quantity_bounds || typeof a.quantity_bounds !== 'object' || Array.isArray(a.quantity_bounds) || Object.keys(a.quantity_bounds).length > Object.keys(DIMENSION_UNITS).length) fail()
  for (const [key, bound] of Object.entries(a.quantity_bounds)) { if (!dimension(key) || !bound || !decimal(bound.value) || !['administrator_declared_limit', 'exact_request_quantity', 'parent_quantity_limit', 'single_invocation'].includes(bound.basis) || bound.parent !== undefined && !dimension(bound.parent)) fail(); quantity(bound.value, key) }
  if (a.envelope) {
    if (a.envelope.algorithm !== 'nonnegative_rule_envelope_v1' || a.envelope.report_currency !== 'USD' || !/^[A-Z]{3}$/.test(a.envelope.currency) || !money(a.envelope.report_amount) || !Array.isArray(a.envelope.dimensions) || a.envelope.dimensions.length > Object.keys(DIMENSION_UNITS).length) fail()
    for (const row of a.envelope.dimensions) if (!dimension(row.dimension) || !/^\d{1,4096}$/.test(row.exact_amount?.numerator) || !/^[1-9]\d{0,4095}$/.test(row.exact_amount?.denominator)) fail()
  }
  if (a.mode === 'reserve_upper_bound' ? a.per_attempt_cost_usd !== (a.envelope?.report_amount ?? null) : a.envelope !== null) fail()
  if (a.transcription_allowance) {
    const extra = a.transcription_allowance, sub = extra.assessment
    if (input.target.operation !== 'realtime' || !text(extra.model, 128) || !Number.isSafeInteger(extra.max_items) || extra.max_items < 1 || extra.max_items > 999 || !decimal(extra.reserved_tokens) || !/^\d+$/.test(extra.reserved_tokens) || !sub || sub.transcription_allowance || sub.combined_reserved_cost_usd !== undefined || sub.attempts !== extra.max_items || sub.catalog_revision_id !== a.catalog_revision_id || !hash(sub.policy_hash) || typeof sub.allowed !== 'boolean' || !money(sub.per_attempt_cost_usd) || !money(sub.reserved_cost_usd) || !money(a.combined_reserved_cost_usd)) fail()
    if (sub.allowed && (sub.mode !== 'reserve_upper_bound' || sub.budget_basis !== 'actual_upstream' || sub.per_attempt_cost_usd === null || sub.reserved_cost_usd === null || scaled(sub.reserved_cost_usd) !== scaled(sub.per_attempt_cost_usd) * BigInt(extra.max_items))) fail()
    if (input.policy && (extra.model !== input.policy.realtime_transcription?.model || extra.max_items !== input.policy.realtime_transcription?.max_items)) fail()
    if (a.allowed ? !sub.allowed || a.reserved_cost_usd === null || sub.reserved_cost_usd === null || a.combined_reserved_cost_usd == null || scaled(a.combined_reserved_cost_usd) !== scaled(a.reserved_cost_usd) + scaled(sub.reserved_cost_usd) : a.combined_reserved_cost_usd !== null) fail()
    await correctionCost(extra.cost, await costHash(extra.cost))
  } else if (a.combined_reserved_cost_usd !== undefined || input.policy?.realtime_transcription) fail()
  const cost = reply.cost
  if (!cost || cost.report_currency !== 'USD' || cost.usage?.adapter_id !== 'admission-preview' || !cost.usage.quantities || !Array.isArray(cost.diagnostics) || cost.diagnostics.length > 4096 || cost.book_id !== null && !text(cost.book_id) || !Array.isArray(cost.selected_rule_ids) || cost.selected_rule_ids.length > 4096 || cost.selected_rule_ids.some(id => !text(id, 128))) fail()
  for (const [key, value] of Object.entries(cost.usage.quantities)) if (!dimension(key) || !value || value.dimension !== key || value.unit !== DIMENSION_UNITS[key] || !PREVIEW_SOURCES.includes(value.source) || !PREVIEW_QUALITIES.includes(value.quality) || value.value !== null && !decimal(value.value)) fail()
  const quote = await correctionCost(cost, await costHash(cost))
  return { reply, quote }
}

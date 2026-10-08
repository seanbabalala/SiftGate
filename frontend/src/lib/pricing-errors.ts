import { PricingApiError } from './pricing-client'

export function pricingErrorKey(error: unknown): string {
  if (!(error instanceof PricingApiError)) return 'error.request'
  if (error.code === 'workspace_changed') return 'error.workspace'
  if (error.code === 'pricing_time_basis_review_required') return 'timeReview.required'
  if (error.code === 'pricing_replay_limit_exceeded') return 'error.replayLimit'
  if (error.code === 'pricing_replay_timeout') return 'error.replayTimeout'
  if (error.code === 'pricing_replay_busy') return 'error.replayBusy'
  if (error.code === 'pricing_capacity_exceeded') return 'error.capacity'
  if (error.code === 'pricing_activation_conflict') return 'error.activationConflict'
  if (error.code === 'pricing_request_too_large' || error.status === 413) return 'error.requestTooLarge'
  if (error.status === 409) return 'error.conflict'
  if (error.status === 403) return 'error.denied'
  if (error.status === 404) return 'error.notFound'
  return error.status === 400 ? 'error.validation' : 'error.request'
}

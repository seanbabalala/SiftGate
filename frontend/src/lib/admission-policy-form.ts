import { ACTUAL_UPSTREAM_BUDGET_OPERATIONS, NON_TOKEN_BUDGET_OPERATIONS, PRICING_ADMISSION_OPERATIONS, type CatalogAdmissionPolicy, type PricingAdmissionPolicy } from '@/types/pricing'
import { selectAdmissionPolicy } from '../../../src/pricing/pricing-admission-selection'

export type BudgetBasisChoice = '' | NonNullable<PricingAdmissionPolicy['budget_basis']>
export type TokenBudgetChoice = '' | NonNullable<PricingAdmissionPolicy['token_budget']>
export const nonTokenBudgetOperation = (operation?: string) => NON_TOKEN_BUDGET_OPERATIONS.includes(operation ?? '')
export const actualBudgetOperation = (operation?: string) => ACTUAL_UPSTREAM_BUDGET_OPERATIONS.includes(operation ?? '')

export function transcriptionDeclaration(model: string, limit: string): PricingAdmissionPolicy['realtime_transcription'] {
  if (!model.trim() && !limit.trim()) return undefined
  return { model: model.trim(), max_items: /^[1-9]\d{0,2}$/.test(limit.trim()) ? Number(limit) : 0 }
}
export function validTranscriptionDeclaration(model: string, limit: string): boolean {
  const declaration = transcriptionDeclaration(model, limit)
  return !declaration || /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(declaration.model) && declaration.max_items > 0
}

/** Omission preserves legacy hashes; explicit clearing is not field-level inheritance. */
export function admissionPolicyWithBasis(policy: PricingAdmissionPolicy | null, choice: BudgetBasisChoice): PricingAdmissionPolicy | null {
  if (!['', 'legacy_logical', 'actual_upstream'].includes(choice)) throw new Error('invalid_budget_basis')
  if (!policy) return null
  const { mode, budget_basis: _basis, ...rest } = policy
  return { mode, ...(choice ? { budget_basis: choice } : {}), ...rest }
}

export function admissionPolicyWithTokenBudget(policy: PricingAdmissionPolicy | null, choice: TokenBudgetChoice): PricingAdmissionPolicy | null {
  if (!['', 'reported_tokens', 'not_applicable'].includes(choice)) throw new Error('invalid_token_budget')
  if (!policy) return null
  const { token_budget: _tokenBudget, ...rest } = policy
  return { ...rest, ...(choice ? { token_budget: choice } : {}) }
}

export function admissionPolicyEffects(policies: readonly CatalogAdmissionPolicy[], workspace: string | null, operation: string | undefined, policy: PricingAdmissionPolicy | null) {
  const next = policies.filter(entry => entry.workspace_id !== workspace || entry.operation !== operation)
  if (policy) next.push({ workspace_id: workspace, ...(operation ? { operation } : {}), policy })
  return (operation ? [operation] : [...PRICING_ADMISSION_OPERATIONS]).map(operation => ({
    operation, before: selectAdmissionPolicy(policies, workspace, operation), after: selectAdmissionPolicy(next, workspace, operation),
  }))
}

import type { FrozenPricingRequest } from "./pricing-catalog";
import type { PricingTarget } from "./pricing-catalog.types";
import { NON_TOKEN_BUDGET_OPERATIONS, type PricingAdmissionPolicy } from "./pricing-admission.types";
import { DIMENSION_UNITS } from "./pricing.types";

/** Inspect the whole frozen book, not just the rule selected for a guessed usage. */
export function tokenBudgetCompatible(snapshot: FrozenPricingRequest, target: PricingTarget, policy: PricingAdmissionPolicy): boolean {
  if (policy.token_budget !== "not_applicable") return true;
  if (policy.budget_basis !== "actual_upstream" || !NON_TOKEN_BUDGET_OPERATIONS.includes(target.operation ?? "")) return false;
  const dimensions = snapshot.billingDimensions(target);
  return Boolean(dimensions?.length && dimensions.every(dimension => DIMENSION_UNITS[dimension] !== "token"));
}

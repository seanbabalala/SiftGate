import type { TokenUsage } from "./canonical.types";
import type { NormalizedUsage, PricingContext } from "../pricing/pricing.types";

interface UsageEvidence {
  usage: NormalizedUsage;
  resolvedServiceTier?: string;
  resolvedModel?: string;
  pendingJob?: { providerJobId?: string };
  mediaContext?: Pick<PricingContext, "media" | "media_estimated">;
}
const evidence = new WeakMap<TokenUsage, UsageEvidence>();

/** Private side channel: billing evidence must not add fields to provider-compatible response JSON. */
export function attachUsageEvidence(
  usage: TokenUsage,
  detail: UsageEvidence,
): void {
  evidence.set(usage, detail);
}
export function getUsageEvidence(usage: TokenUsage): UsageEvidence | undefined {
  return evidence.get(usage);
}

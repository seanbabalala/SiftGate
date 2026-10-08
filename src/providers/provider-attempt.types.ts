import type { TokenUsage } from "../canonical/canonical.types";

import type { ProviderDispatchEvidence } from "./provider-cost-attribution.types";
export type {
  ProviderDispatchEvidence,
  ProviderCostAttribution,
} from "./provider-cost-attribution.types";

export interface ProviderAttemptReceipt {
  streamFinished?(
    usage: TokenUsage | undefined,
    code?: string,
    responseModel?: string,
  ): Promise<void>;
  failed(code: string, usage?: TokenUsage): Promise<void>;
}

/** begin must commit the dispatch intent before fetch; terminal accounting must not cause a paid retry. */
export interface ProviderAttemptObserver {
  begin(evidence: ProviderDispatchEvidence): Promise<ProviderAttemptReceipt>;
}

import type {
  CanonicalEmbeddingRequest,
  CanonicalEmbeddingResponse,
} from "../canonical/canonical.types";
import type {
  ProviderAttemptObserver,
  ProviderDispatchEvidence,
} from "../providers/provider-attempt.types";
import type {
  CostComputation,
  NormalizedUsage,
  PricingContext,
} from "./pricing.types";
import type { CostLedgerService } from "./cost-ledger.service";
import type { CostSettlementPayload } from "./cost-ledger.types";
import type { ActualBudgetClosurePayload } from "./actual-upstream-budget-cohort.types";
import type { FrozenPricingRequest } from "./pricing-catalog";
import type { PricingTarget } from "./pricing-catalog.types";

export interface PricingBatchParticipant {
  key: string;
  requestId: string;
  reservationId: string;
  workspace: string;
  requestedModel: string | null;
  target: PricingTarget;
  snapshot: FrozenPricingRequest;
  reservedCost: string;
  reservedTokens: string;
  attemptAllowance: number;
  credentialAttempts?: number;
  budgetBasis?: "actual_upstream";
  quote(usage: NormalizedUsage, context: PricingContext): CostComputation;
  pricingContext(): PricingContext;
  begin(
    id: string,
    invocationId: string,
    dispatch: ProviderDispatchEvidence,
  ): Parameters<CostLedgerService["beginAttempt"]>[0];
  dispatched(id: string): void;
  actualClosure(): ActualBudgetClosurePayload;
  retain(id: string, cost: CostComputation, code?: string): void;
  settlement(
    kind: "commit" | "release",
    cost?: CostComputation,
    logicalTokens?: string,
  ): CostSettlementPayload;
  hold(): void;
  finish(settlement?: CostSettlementPayload, custodyOnly?: boolean, actualClosed?: boolean): Promise<void>;
}

export type PricedEmbeddingDispatch = (
  request: CanonicalEmbeddingRequest,
  options: {
    signal?: AbortSignal;
    pricingAttempts?: ProviderAttemptObserver;
    credentialAttemptLimit?: number;
  },
) => Promise<CanonicalEmbeddingResponse>;

export class PricingBatchClientError extends Error {
  constructor(
    readonly statusCode: 499 | 504,
    message: string,
  ) {
    super(message);
    this.name = "PricingBatchClientError";
  }
}

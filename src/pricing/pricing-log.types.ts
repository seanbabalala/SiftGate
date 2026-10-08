import type { CostLedgerSummary } from "./cost-ledger.types";

/** Allowlisted log metadata, never prompts, outputs, headers or current-price reconstruction. */
export interface PricingLogMetadata {
  id: number;
  request_id: string;
  timestamp: string;
  model: string;
  node_id: string;
  source_format: string;
  status_code: number;
  input_tokens: number;
  output_tokens: number;
  stored_cost_usd: string;
  stored_reference_cost_usd: string | null;
}
export type PricingLogCost = (
  | CostLedgerSummary
  | {
      request_id: string;
      status: "legacy_estimate" | "unpriced";
      report_currency: "USD";
      amount: string | null;
      replayable: false;
      reason: string;
    }
) & { log: PricingLogMetadata };

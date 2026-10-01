import type {
  CostComputation,
  CostLine,
  NormalizedUsage,
  PricingStatus,
} from "./pricing.types";

export interface EmbeddingBatchMember {
  request_id: string;
  reservation_id: string;
  input_start: number;
  input_count: number;
  weight: string;
  weight_basis: "token_input_count" | "text_token_estimate";
}

/** This is an internal cost allocation, NOT an independently invoiced provider request. */
export interface BatchCostShare {
  member: EmbeddingBatchMember;
  physical_cost_hash: string;
  weight_total: string;
  status: PricingStatus;
  usage: NormalizedUsage;
  amount: string | null;
  known_subtotal: string | null;
  rounding_adjustment: string | null;
  report_amount: string | null;
  report_known_subtotal: string | null;
  report_rounding_adjustment: string | null;
  lines: Array<
    Pick<
      CostLine,
      | "component_id"
      | "rule_id"
      | "dimension"
      | "currency"
      | "amount"
      | "report_amount"
      | "exact_amount"
    >
  >;
}

export interface BatchCostAllocation {
  schema_version: 1;
  algorithm: "proportional_largest_remainder_v1";
  batch_id: string;
  physical_cost: CostComputation;
  physical_cost_hash: string;
  members: EmbeddingBatchMember[];
  shares: BatchCostShare[];
}

export interface BatchCostReceipt {
  algorithm: "proportional_largest_remainder_v1";
  batch_id: string;
  physical_attempt_id: string;
  weight_total: string;
  physical_cost: CostComputation;
  physical_cost_hash: string;
  members: EmbeddingBatchMember[];
  member_index: number;
  correction?: {
    id: string;
    revision: number;
    previous_physical_cost_hash: string;
  };
}

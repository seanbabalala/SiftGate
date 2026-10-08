import type { VideoResultProfile } from "./video-result-profile.types";
import type { BudgetLedgerIdentity } from "../budget/budget-ledger.types";
import type {
  NormalizedUsage,
  PriceBookContent,
  PricingContext,
} from "./pricing.types";
import type { PricingTarget } from "./pricing-catalog.types";

export type MediaTaskState =
  | "reserved"
  | "submitted"
  | "pending"
  | "terminal"
  | "settled"
  | "uncertain"
  | "synchronous";
export type MediaJobStatus = "pending" | "completed" | "failed" | "cancelled";
export interface MediaTaskContext {
  video_result_profile?: VideoResultProfile;
  target: PricingTarget;
  identity: BudgetLedgerIdentity;
  operation:
    | "video_generation"
    | "image_generation"
    | "image_edit"
    | "image_variation";
  pricing: PricingContext;
  request_usage: NormalizedUsage;
  legacy_price: PriceBookContent | null;
  legacy_version: number;
  logical_tokens: string;
  fallback_cost_usd: string;
}
export interface MediaTaskRow {
  client_key_hash: string | null;
  id: string;
  request_id: string;
  reservation_id: string;
  workspace_id: string;
  node_id: string;
  model: string;
  operation: string;
  api_key_id: string | null;
  api_key_name: string | null;
  namespace_id: string | null;
  provider_job_id: string | null;
  credential_id: string | null;
  connection_hash: string;
  state: MediaTaskState;
  provider_status: MediaJobStatus | null;
  context_json: string;
  context_hash: string;
  revision: number;
  accepted_at: string | null;
  terminal_at: string | null;
  last_error: string | null;
  poll_owner: string | null;
  poll_until: string | null;
  next_poll_at: string;
  created_at: string;
  updated_at: string;
}
export interface MediaTaskObservationRow {
  id: string;
  task_id: string;
  request_id: string;
  workspace_id: string;
  revision: number;
  observation_hash: string;
  status: MediaJobStatus;
  usage_json: string;
  context_json: string;
  observed_at: string;
  action: "initial" | "adjustment" | "noop" | null;
  expected_hash: string | null;
  cost_json: string | null;
  processing_hash: string | null;
  processed: number;
}
export class MediaDispatchUncertainError extends Error {
  readonly statusCode = 502;
  constructor(readonly requestId: string) {
    super(
      `Media submission outcome is uncertain for request ${requestId}; no additional generation was dispatched.`,
    );
    this.name = "MediaDispatchUncertainError";
  }
}

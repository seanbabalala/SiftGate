import type {
  EvidenceQuality,
  MeterDimension,
  PricingContext,
} from "./pricing.types";
import type { MediaJobStatus } from "./media-task.types";

/** Complete normalized snapshots, never supplier-specific deltas or invoice amounts. */
export interface MediaSupplierEvent {
  schema_version: 1;
  event_id: string;
  task_id: string;
  provider_job_id: string;
  sequence: string;
  status: MediaJobStatus;
  accepted_at: string;
  completed_at: string | null;
  time_quality: "observed" | "estimated";
  evidence: Array<{
    dimension: MeterDimension;
    value: string | null;
    quality: EvidenceQuality;
  }>;
  media?: PricingContext["media"];
  resolved_service_tier?: string;
}
export interface MediaSupplierSource {
  id: string;
  workspace_id: string;
  node_id: string;
  credential_id: string;
  connection_hash: string;
  secret_env: string;
  revision: number;
  enabled: number;
  config_hash: string;
  audit_id: string;
  created_at: string;
  updated_at: string;
}
export interface MediaSupplierAuthentication {
  timestamp: string;
  revision: string;
  signature: string;
}
export type MediaSupplierDecision =
  | "applied"
  | "ignored_stale"
  | "ignored_regression"
  | "review_required";
export interface MediaSupplierEventRow {
  id: string;
  workspace_id: string;
  task_id: string;
  source_id: string;
  source_revision: number;
  source_audit_id: string;
  event_id: string;
  sequence: string | null;
  origin: "authenticated_connector" | "unversioned_observation";
  document_hash: string;
  document_json: string;
  decision: MediaSupplierDecision;
  observation_id: string | null;
  audit_id: string;
  record_hash: string;
  created_at: string;
}
export interface MediaSupplierHead {
  task_id: string;
  workspace_id: string;
  source_id: string;
  provider_job_id: string;
  sequence: string;
  event_record_id: string;
  job_key: string;
}

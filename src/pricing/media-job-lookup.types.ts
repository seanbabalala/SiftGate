import type {
  CostComputation,
  NormalizedUsage,
  PricingContext,
} from "./pricing.types";
import type {
  MediaTaskRow,
  MediaTaskContext,
  MediaJobStatus,
} from "./media-task.types";
import type { CostAttemptRow, CostReservationRow } from "./cost-ledger.types";

export interface MediaLookupBasis {
  task_id: string;
  request_id: string;
  workspace_id: string;
  revision: number;
  state: MediaTaskRow["state"];
  node_id: string;
  model: string;
  operation: string;
  credential_id: string | null;
  connection_hash: string;
  basis_hash: string;
  blocked_reason: string | null;
}
export interface LockedMediaLookup {
  view: MediaLookupBasis;
  task: MediaTaskRow;
  context: MediaTaskContext;
  attempt: CostAttemptRow;
  reservation: CostReservationRow;
}
export interface MediaLookupObservation {
  provider_job_id: string;
  credential_id: string;
  status: MediaJobStatus;
  usage: NormalizedUsage;
  context: PricingContext;
  error_code: string | null;
}
export interface MediaLookupInput {
  id: string;
  provider_job_id: string;
  expected_basis_hash: string;
  expected_observation_hash: string;
  expected_cost_hash: string;
  reason: string;
  confirm: true;
}
export interface MediaLookupPreview {
  task_id: string;
  basis_hash: string;
  observation_hash: string;
  cost_hash: string;
  observation: MediaLookupObservation;
  cost: CostComputation;
  dry_run: true;
  association_source: "administrator_attestation";
  supplier_invoice_confirmed: false;
  time_note: "unknown_provider_instants_not_invented";
}
export interface MediaLookupRow {
  id: string;
  operation_id: string;
  task_id: string;
  request_id: string;
  workspace_id: string;
  actor_id: string;
  provider_job_id: string;
  credential_id: string;
  connection_hash: string;
  job_key: string;
  basis_hash: string;
  proposal_hash: string;
  observation_hash: string;
  cost_hash: string;
  document_json: string;
  observation_id: string;
  audit_id: string;
  record_hash: string;
  created_at: string;
}

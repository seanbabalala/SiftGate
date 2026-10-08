/** Allowlisted dispatch metadata only. Never include keys, headers, URLs or request/response bodies. */
export interface ProviderDispatchEvidence {
  node_id: string;
  wire_model: string | null;
  credential_id: string;
  credential_strategy: string;
  credential_retry_index: number;
  compatibility_retry_index: number;
  dispatch_index: number;
  protocol: string;
  dispatched_at: string;
}

export interface ProviderCostAttribution extends ProviderDispatchEvidence {
  invocation_id: string;
  requested_model: string | null;
  route_model: string;
  response_model?: string;
}

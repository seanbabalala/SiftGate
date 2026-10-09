import type { VideoResultProfile } from "../../../src/pricing/video-result-profile.types";
// ── Stats ──

export interface StatsTotal {
  calls: number;
  success: number;
  failed: number;
  successRate: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  avgLatencyMs: number;
  uniqueSessions: number;
}

export interface TierDistribution {
  tier: string;
  count: number;
}

export interface NodeDistribution {
  nodeId: string;
  count: number;
  avgLatencyMs: number;
}

export interface StatsResponse {
  period: number;
  total: StatsTotal;
  last24h: {
    calls: number;
    costUsd: number;
    tokens: number;
  };
  tierDistribution: TierDistribution[];
  nodeDistribution: NodeDistribution[];
}

// ── Cluster / Shared State ──

export type StateBackendType = "memory" | "redis";
export type StateUnavailablePolicy = "fail_open" | "fail_closed";
export type StateCategoryName =
  | "rate_limit"
  | "circuit_breaker"
  | "cache_affinity"
  | "momentum"
  | "prompt_cache"
  | "concurrency"
  | "health_probe"
  | "realtime_session";

export interface StateCategoryRuntimeStatus {
  name: StateCategoryName;
  unavailable_policy: StateUnavailablePolicy;
  ttl_seconds: number;
  shared: boolean;
}

export interface StateRuntimeStatus {
  backend: StateBackendType;
  configured_backend: StateBackendType;
  key_prefix: string;
  redis_available: boolean;
  unavailable_policy: StateUnavailablePolicy;
  degraded: boolean;
  last_error: string | null;
  recent_errors: Array<{
    category: StateCategoryName;
    message: string;
    at: string;
  }>;
  categories: Record<StateCategoryName, StateCategoryRuntimeStatus>;
}

export interface ClusterInstanceRecord {
  instance_id: string;
  status: "online" | "offline";
  started_at: string;
  last_seen_at: string;
  host: string;
  pid: number;
  config_version: number;
  config_loaded_at: string;
  node_count: number;
  node_ids: string[];
  route_tiers: string[];
}

export interface ClusterStatusResponse {
  enabled: boolean;
  mode: "single_instance" | "redis_pubsub";
  leader_election: false;
  local_node_id: string;
  redis: {
    status: "disabled" | "connecting" | "ready" | "error";
    url: string | null;
    prefix: string;
    last_error: string | null;
  };
  state: StateRuntimeStatus | null;
  reload_broadcast: boolean;
  heartbeat_interval_seconds: number;
  heartbeat_ttl_seconds: number;
  local_instance: ClusterInstanceRecord;
  instances: ClusterInstanceRecord[];
  instance_count: number;
  channels: {
    events: string | null;
  };
  last_heartbeat_at: string | null;
  last_event_at: string | null;
  last_inbound_reload_at: string | null;
  last_outbound_reload_at: string | null;
}

// ── MCP Tool Gateway ──

export interface McpToolSummary {
  name: string;
  description: string | null;
  has_input_schema: boolean;
}

export interface McpServerSummary {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  transport: string;
  endpoint: string;
  allowed_namespaces: string[];
  tools: McpToolSummary[];
  tags: string[];
  recent_calls: number;
  recent_errors: number;
  last_called_at: string | null;
}

export interface McpAuditEntry {
  id: string;
  timestamp: string;
  server_id: string;
  server_name: string;
  method: string;
  tool_name: string | null;
  batch_size: number;
  api_key_id: string | null;
  api_key_name: string | null;
  namespace_id: string | null;
  status_code: number;
  success: boolean;
  latency_ms: number;
  error_type: string | null;
  request_bytes: number;
}

export interface McpErrorSummary {
  server_id: string;
  error_type: string;
  count: number;
  last_seen_at: string;
}

export interface McpGatewayResponse {
  enabled: boolean;
  path: string;
  metadata_only: boolean;
  servers: McpServerSummary[];
  recent_calls: McpAuditEntry[];
  error_summary: McpErrorSummary[];
  totals: {
    servers: number;
    enabled_servers: number;
    tools: number;
    recent_calls: number;
    recent_errors: number;
  };
}

// ── Agent Platform Preview ──

export interface AgentPlatformPrivacyContract {
  metadata_only: true;
  stores_prompts: false;
  stores_responses: false;
  stores_source_code: false;
  stores_diffs: false;
  stores_tool_payloads: false;
  stores_raw_headers: false;
  stores_provider_keys: false;
  stores_gateway_key_plaintext: false;
  stores_media_bytes: false;
  stores_hidden_reasoning: false;
  stores_resolved_secrets: false;
}

export interface AgentPlatformAgent {
  id: string;
  name: string;
  description: string | null;
  connector: string;
  status: string;
  workspace_id: string;
  api_key_id: string | null;
  api_key_name: string | null;
  api_key_status: string | null;
  namespace_id: string | null;
  namespace_name: string | null;
  default_model: string;
  smart_model_id: string;
  virtual_model_aliases: string[];
  routing_hint: Record<string, unknown> | null;
  mcp_server_ids: string[];
  tool_count: number;
  permitted_tool_count: number;
  route_policy: {
    allow_auto: boolean | null;
    allow_direct: boolean | null;
    allowed_models: string[];
    allowed_endpoints: string[];
  };
}

export interface AgentPlatformA2aHub {
  enabled: true;
  mode: "workspace_registry";
  routing: {
    policy_enforced: true;
    backend_selection: "agent_profile_gateway_key";
    bypasses_gateway_policy: false;
  };
  agents: AgentPlatformAgent[];
}

export interface AgentPlatformTool {
  name: string;
  description: string | null;
  has_input_schema: boolean;
  permitted_profile_ids: string[];
  blocked_profile_ids: string[];
  permission: "permitted" | "blocked" | "unlinked";
  policy_reasons: string[];
}

export interface AgentPlatformToolServer {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  transport: string;
  endpoint: string;
  allowed_namespaces: string[];
  tags: string[];
  linked_profile_ids: string[];
  tools: AgentPlatformTool[];
}

export interface AgentPlatformToolRegistry {
  enabled: boolean;
  mode: "mcp_metadata_registry";
  injection: {
    metadata_only: true;
    auto_injection_available: true;
    stores_tool_payloads: false;
  };
  servers: AgentPlatformToolServer[];
}

export interface AgentPlatformWorkflow {
  id: string;
  name: string;
  description: string;
  status: "preview";
  runtime_enabled: false;
  profile_ids: string[];
  steps: Array<{
    id: string;
    profile_id: string;
    profile_name: string;
    connector: string;
    order: number;
  }>;
  edges: Array<{
    from: string;
    to: string;
    type: "ordered";
  }>;
}

export interface AgentPlatformWorkflowPreview {
  preview: true;
  runtime_enabled: false;
  mode: "metadata_only";
  promise: "preview_contract_only";
  workflows: AgentPlatformWorkflow[];
}

export interface AgentPlatformMemoryGateway {
  preview: true;
  enabled: false;
  content_storage_enabled: false;
  metadata_state: {
    session_ids_observed: number;
    turn_ids_observed: number;
    repo_labels_observed: number;
    project_labels_observed: number;
  };
  retention: {
    mode: "metadata_only";
    content_requires_explicit_opt_in: true;
    redaction_required: true;
  };
}

export interface AgentPlatformSpan {
  request_id: string;
  timestamp: string;
  connector: string | null;
  profile_id: string | null;
  profile_name: string | null;
  session_id: string | null;
  turn_id: string | null;
  repo: string | null;
  project: string | null;
  route_decision_id: string;
  fallback: boolean;
  retry_count: number;
  tokens: {
    input: number;
    output: number;
    total: number;
  };
  cost_usd: number;
  latency_ms: number;
  status_code: number;
}

export interface AgentPlatformResponse {
  version: "v1";
  preview: true;
  workspace_id: string;
  generated_at: string;
  a2a_hub: AgentPlatformA2aHub;
  tool_registry: AgentPlatformToolRegistry;
  workflow_preview: AgentPlatformWorkflowPreview;
  memory_gateway: AgentPlatformMemoryGateway;
  traces: {
    metadata_only: true;
    spans: AgentPlatformSpan[];
  };
  privacy: AgentPlatformPrivacyContract;
  totals: {
    agents: number;
    active_agents: number;
    tools: number;
    permitted_tools: number;
    workflows: number;
    recent_spans: number;
  };
}

// ── Cost And Chargeback Platform ──

export interface CostPlatformPrivacyContract {
  metadata_only: true;
  stores_prompts: false;
  stores_responses: false;
  stores_source_code: false;
  stores_diffs: false;
  stores_tool_payloads: false;
  stores_raw_headers: false;
  stores_provider_keys: false;
  stores_media_bytes: false;
  stores_hidden_reasoning: false;
  exports_content: false;
}

export interface CostPlatformUsageMetrics {
  requests: number;
  successful_requests: number;
  failed_requests: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_usd: number;
  estimated_savings_usd: number;
  fallback_count: number;
  optimizer_applied: number;
  quality_gate_failed: number;
  avg_latency_ms: number;
  success_rate: number;
}

export type CostPlatformGroupBy = "workspace" | "team" | "project" | "api_key" | "model" | "node";

export interface CostPlatformChargebackGroup extends CostPlatformUsageMetrics {
  group_by: CostPlatformGroupBy;
  group_value: string;
  group_label: string;
}

export interface CostPlatformDailyTrend extends CostPlatformUsageMetrics {
  date: string;
}

export interface CostPlatformInvoiceLineItem {
  description: string;
  quantity_requests: number;
  total_tokens: number;
  amount_usd: number;
}

export interface CostPlatformAnomaly {
  id: string;
  scope: CostPlatformGroupBy;
  key: string;
  severity: "warning" | "critical" | "info";
  rule: string;
  current_cost_usd: number;
  baseline_cost_usd: number;
  rate_of_change: number;
  message: string;
  recommended_policy: {
    action: string;
    automatic: boolean;
    reason: string;
  };
}

export interface CostPlatformPriceModelWarning {
  node_id: string;
  model: string;
  source: string;
  source_url: string | null;
  used_from: string;
  freshness: "fresh_or_configured" | "stale" | "missing";
  review_required: boolean;
  pricing_confidence: string | null;
  operator_override: boolean;
  auto_trusted: false;
}

export interface CostPlatformFeedbackRouteSummary {
  key: string;
  up: number;
  down: number;
  total: number;
  positive_rate: number;
}

export interface CostPlatformResponse {
  version: "v1";
  workspace_id: string;
  generated_at: string;
  period: {
    label: string;
    days: number;
    since: string;
    until: string;
  };
  filters: {
    group_by: CostPlatformGroupBy;
    team_id: string | null;
    project: string | null;
    api_key_id: string | null;
  };
  chargeback: {
    summary: CostPlatformUsageMetrics;
    groups: CostPlatformChargebackGroup[];
    daily_trend: CostPlatformDailyTrend[];
    budget_period_close: {
      period_label: string;
      close_status: "ready" | "near_budget" | "over_budget";
      requests: number;
      cost_usd: number;
      global_budget_limit_usd: number | null;
      variance_usd: number | null;
      invoice_ready: true;
      payment_collection: false;
      recharge_balance: false;
    };
    invoice_summary: {
      currency: "USD";
      line_items: CostPlatformInvoiceLineItem[];
      disclaimer: string;
    };
  };
  anomalies: CostPlatformAnomaly[];
  price_sync: {
    enabled: boolean;
    scheduled: boolean;
    write_to: string;
    supported_sources: string[];
    enabled_sources: string[];
    providers: Array<Record<string, unknown>>;
    configured_model_warnings: CostPlatformPriceModelWarning[];
    guardrails: {
      explicit_sources_only: true;
      never_overwrite_operator_overrides_silently: true;
      automatic_price_trust: false;
    };
  };
  feedback: {
    total: number;
    thumbs_up: number;
    thumbs_down: number;
    positive_rate: number;
    by_model: CostPlatformFeedbackRouteSummary[];
    by_node: CostPlatformFeedbackRouteSummary[];
    route_weight_evidence: {
      available: boolean;
      applied_to_routing: false;
      privacy_safe_aggregation: true;
    };
  };
  privacy: CostPlatformPrivacyContract;
  boundaries: {
    payments: false;
    recharge_balances: false;
    reseller_marketplace: false;
    public_api_marketplace: false;
  };
}

// ── Semantic Controls ──

export interface SemanticPlatformPrivacyContract {
  metadata_only: true;
  stores_prompts: false;
  stores_responses: false;
  stores_prompt_templates_by_default: false;
  stores_raw_headers: false;
  stores_provider_keys: false;
  stores_tool_payloads: false;
  stores_media_bytes: false;
  stores_hidden_reasoning: false;
  semantic_cache_response_storage_opt_in: boolean;
  prompt_registry_content_storage_opt_in: boolean;
}

export type SemanticIntentCategory =
  | "coding"
  | "task"
  | "security"
  | "reasoning"
  | "creative"
  | "multimodal"
  | "analysis"
  | "general";

export type SemanticContextStrategy = "metadata_only" | "trim" | "summarize";

export interface SemanticPlatformPromptTemplate {
  id: string;
  workspace_id: string;
  prompt_key: string;
  version: number;
  name: string | null;
  status: "active" | "archived";
  template_hash: string;
  variables: string[];
  route_policy_id: string | null;
  ab_metadata: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  content_storage_enabled: boolean;
  content_available: false;
  created_at: string;
  updated_at: string;
}

export interface SemanticPlatformResponse {
  version: "v1";
  workspace_id: string;
  generated_at: string;
  period: string;
  config: {
    enabled: boolean;
    semantic_cache: {
      enabled: boolean;
      backend: string;
      isolation: string;
      ttl_seconds: number;
      threshold: number;
      store_responses: boolean;
      response_storage_requires_header: boolean;
      explicit_response_storage_opt_in: boolean;
    };
    prompt_registry: {
      enabled: boolean;
      store_template_content: boolean;
      max_versions_per_key: number;
    };
    context_optimizer: {
      enabled: boolean;
      strategy: SemanticContextStrategy;
      max_context_ratio: number;
      allow_content_mutation: boolean;
    };
    intent_classification: {
      enabled: boolean;
      categories: SemanticIntentCategory[];
      min_confidence: number;
    };
    guardrails_v2: {
      enabled: boolean;
      metadata_only: boolean;
      input: {
        enabled: boolean;
        pii: boolean;
        toxicity: boolean;
        jailbreak: boolean;
        action: "observe" | "block" | "alert";
      };
      output: {
        enabled: boolean;
        pii: boolean;
        toxicity: boolean;
        jailbreak: boolean;
        action: "observe" | "block" | "alert";
      };
    };
  };
  semantic_cache: {
    enabled: boolean;
    backend: string;
    vectorBackend: string;
    entries: number;
    maxEntries: number;
    matches: number;
    hits: number;
    misses: number;
    threshold: number;
    storeResponses: boolean;
    ttlSeconds: number;
    isolation: string;
    responseStorageRequiresHeader: boolean;
    invalidations: number;
    workspace_isolated: boolean;
    key_isolated: boolean;
    model_isolated: boolean;
    explicit_response_storage_opt_in: boolean;
    recent_requests: number;
    recent_hits: number;
    recent_metadata_matches: number;
  };
  prompt_registry: {
    enabled: boolean;
    stores_template_content: boolean;
    templates: SemanticPlatformPromptTemplate[];
    total: number;
    active: number;
  };
  context_optimizer: {
    enabled: boolean;
    strategy: SemanticContextStrategy;
    mutation_allowed: boolean;
    actions: Record<string, number>;
    content_persistence: false;
  };
  intent_classification: {
    enabled: boolean;
    categories: SemanticIntentCategory[];
    observed: Record<string, number>;
  };
  guardrails_v2: {
    enabled: boolean;
    metadata_only: boolean;
    findings: Record<string, number>;
    blocked_by_default: false;
  };
  privacy: SemanticPlatformPrivacyContract;
}

export interface CreateSemanticPromptTemplateRequest {
  prompt_key: string;
  name?: string | null;
  template: string;
  variables?: string[];
  route_policy_id?: string | null;
  ab_metadata?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
}

export interface CreateSemanticPromptTemplateResponse {
  success: boolean;
  item: SemanticPlatformPromptTemplate;
  privacy: SemanticPlatformPrivacyContract;
}

// ── Logs ──

export interface CallLog {
  id: number;
  request_id: string;
  timestamp: string;
  source_format: string;
  client_source?: string | null;
  tier: string;
  score: number;
  node_id: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  cost_without_cache_usd?: number | null;
  latency_ms: number;
  stream?: boolean;
  status_code: number;
  is_fallback: boolean;
  fallback_reason: string | null;
  retry_count?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  semantic_cache_hit?: boolean;
  semantic_cache_score?: number | null;
  experiment_group?: string | null;
  structured_output_requested?: boolean;
  structured_output_type?: string | null;
  structured_output_strategy?: string | null;
  structured_output_supported?: boolean | null;
  structured_output_schema_name?: string | null;
  reasoning_requested?: boolean;
  reasoning_effort?: string | null;
  reasoning_strategy?: string | null;
  reasoning_supported?: boolean | null;
  reasoning_budget_tokens?: number | null;
  reasoning_source?: string | null;
  reasoning_reason?: string | null;
  media_type?: string | null;
  media_operation?: string | null;
  media_multipart?: boolean | null;
  media_file_count?: number | null;
  media_byte_size?: number | null;
  media_requested_format?: string | null;
  media_response_format?: string | null;
  media_provider_response_type?: string | null;
  session_id?: string | null;
  session_key: string | null;
  trace_id?: string | null;
  error: string | null;
  api_key_id?: string | null;
  api_key_name?: string | null;
  namespace_id?: string | null;
  credential_id?: string | null;
  credential_strategy?: string | null;
  credential_retry_count?: number;
}

export interface LogsPagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface LogsResponse {
  data: CallLog[];
  pagination: LogsPagination;
}

export interface LogSummaryMetrics {
  requests: number;
  input_tokens: number;
  output_tokens: number;
  tokens: number;
  cost_usd: number;
  successes: number;
  success_rate: number;
  cache_hits: number;
  cache_rate: number;
}

export interface LogKeySummary extends LogSummaryMetrics {
  api_key_id: string | null;
  api_key_name: string | null;
}

export interface LogHourlyTrendBucket {
  hour: number;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  tokens: number;
  cost_usd: number;
}

export interface LogsSummaryResponse {
  period: string | null;
  total: LogSummaryMetrics;
  by_key: LogKeySummary[];
  hourly_trend: LogHourlyTrendBucket[];
}

// ── Route Decisions ──

export interface RouteDecisionTarget {
  node: string;
  model: string;
}

export interface RouteDecisionCandidate {
  node: string;
  model: string;
  weight: number | null;
  position: number;
  circuit_state: string;
  circuit_available: boolean;
  selected: boolean;
  fallback: boolean;
  filter_reasons: string[];
  scores: {
    cost: number | null;
    latency: number | null;
    context: number | null;
    cache?: number | null;
  };
  metrics: {
    estimated_cost_usd: number | null;
    avg_latency_ms: number | null;
    p95_latency_ms: number | null;
    max_context_tokens: number | null;
    context_fit: "safe" | "near_limit" | "overflow" | "unknown";
    structured_output: boolean | null;
    reasoning?: boolean | null;
    provider_cache_hit_rate?: number | null;
    estimated_cache_savings_usd?: number | null;
  };
  capability_evidence?: {
    requested_modality: string | null;
    supported_modalities: string[];
    input_types: string[];
    output_types: string[];
    required_capabilities: string[];
    matched_capabilities: string[];
    missing_capabilities: string[];
    endpoint_strategy: string | null;
    endpoint_status: string;
    endpoint: string | null;
    file_count: number | null;
    byte_size: number | null;
    max_file_size: number | null;
    filtered_by_capability: boolean;
    filtered_by_file_size: boolean;
    pricing_source: string | null;
    pricing_confidence?: string | null;
    pricing_stale?: boolean | null;
    pricing_used_from?: string;
    missing_price_units?: string[];
    estimated_cost_basis?: string | null;
    catalog_source: string | null;
  };
  cache_evidence?: {
    local_prompt_cache_eligible: boolean;
    local_prompt_cache_hit: boolean;
    local_prompt_cache_lookup: "hit" | "miss" | "disabled" | "skipped" | null;
    provider_prompt_cache: boolean;
    provider_read_cache: boolean;
    provider_write_cache: boolean;
    supports_cache?: boolean;
    cache_type?: string | null;
    cache_min_tokens?: number | null;
    cache_read_discount?: number | null;
    observed_cache_hit_rate: number | null;
    observed_cache_read_tokens: number;
    observed_cache_creation_tokens: number;
    input_price_per_mtok: number | null;
    cache_read_price_per_mtok: number | null;
    cache_write_price_per_mtok: number | null;
    estimated_base_cost_usd: number | null;
    estimated_cache_adjusted_cost_usd: number | null;
    estimated_cache_savings_usd: number | null;
    cache_score: number | null;
    cache_affinity_active?: boolean;
    cache_affinity_reason?: string | null;
    cache_affinity_bonus?: number | null;
    provider_cache_ttl_seconds?: number | null;
    time_since_last_cache_hit_seconds?: number | null;
    estimated_cache_hit_probability?: number | null;
    reason: string;
  };
  compatibility_evidence?: RouteDecisionCompatibilityEvidence;
}

export interface RouteDecisionCompatibilityEvidence {
  provider_id: string | null;
  compatibility_profile: string[];
  endpoint_strategy: string | null;
  protocol_strategy: string | null;
  passthrough_fields: string[];
  downgraded_fields: string[];
  unsupported_fields: string[];
  selected_reason: string;
  filtered_by_profile_reason: string | null;
}

export interface RouteDecisionFilter {
  node: string;
  model: string;
  stage: string;
  reason: string;
}

export interface RouteDecisionTokenPredictionEvidence {
  enabled: boolean;
  estimated_input_tokens: number | null;
  estimated_output_tokens: number | null;
  estimated_context_tokens: number | null;
  estimated_cost_usd: number | null;
  budget_policy: "observe" | "reject" | "downgrade";
  budget_scope: "workspace" | "namespace" | "team" | "api_key" | "global" | "none";
  budget_limit_usd: number | null;
  budget_current_usd: number | null;
  budget_remaining_usd: number | null;
  budget_usage_ratio: number | null;
  risk: "unknown" | "within_budget" | "near_limit" | "over_limit";
  action: "observed" | "rejected" | "downgrade_requested" | "downgraded" | "skipped";
  reason: string;
}

export interface RouteDecisionCostOptimizerEvidence {
  enabled: boolean;
  action: "evidence_only" | "optimize";
  objective: "cost" | "balanced" | "latency" | "quality";
  applied: boolean;
  from: RouteDecisionTarget | null;
  to: RouteDecisionTarget | null;
  reason: string;
  budget_remaining_usd: number | null;
  quality_critical: boolean;
  candidates: Array<{
    node: string;
    model: string;
    estimated_cost_usd: number | null;
    cache_hit_probability: number | null;
    latency_ms: number | null;
    success_rate: number | null;
    quality_score: number | null;
    composite_score: number | null;
    selected: boolean;
    rejected_reasons: string[];
  }>;
}

export interface RouteDecisionAsyncEvalEvidence {
  enabled: boolean;
  queued: boolean;
  sample_rate: number;
  dimensions: string[];
  metadata_only: boolean;
  job_id: string | null;
  reason: string;
}

export interface RouteDecisionQualityGateEvidence {
  enabled: boolean;
  mode: "disabled" | "metadata_only" | "enforced";
  final_status: "passed" | "failed" | "skipped";
  events: Array<{
    rule_id: string;
    status: "passed" | "failed" | "skipped";
    actions: Array<"retry" | "fallback" | "alert">;
    failure_reasons: string[];
    selected_action: "none" | "retry" | "fallback" | "alert" | "skip";
    stream_started: boolean;
    retry_attempted: boolean;
    fallback_attempted: boolean;
  }>;
  reason: string;
}

export interface RouteDecisionIntelligenceEvidence {
  optimizer?: RouteDecisionCostOptimizerEvidence;
  token_prediction?: RouteDecisionTokenPredictionEvidence;
  async_eval?: RouteDecisionAsyncEvalEvidence;
  quality_gate?: RouteDecisionQualityGateEvidence;
}

export interface RouteDecisionSemanticPlatformEvidence {
  intent?: {
    enabled: boolean;
    category: string;
    confidence: number;
    signals: string[];
    route_hint: {
      preferred_capabilities: string[];
      quality_critical: boolean;
      security_sensitive: boolean;
    };
  };
  context_optimizer?: {
    enabled: boolean;
    strategy: string;
    action: string;
    mutation_allowed: boolean;
    estimated_context_tokens: number;
    max_context_tokens: number | null;
    context_ratio: number | null;
    threshold_ratio: number;
    route_target: RouteDecisionTarget | null;
    changed_content: false;
    reason: string;
  };
  guardrails_v2?: {
    enabled: boolean;
    metadata_only: boolean;
    findings: Array<{
      surface: string;
      kind: string;
      action: string;
      severity: string;
      match_count: number;
      metadata_only: true;
    }>;
    blocked: false;
    reason: string;
  };
  prompt_registry?: {
    enabled: boolean;
    prompt_key: string | null;
    version: number | null;
    template_hash: string | null;
    variables: string[];
    route_policy_id: string | null;
    ab_metadata: Record<string, unknown> | null;
    content_available: false;
    reason: string;
  };
}

export interface RouteDecisionTrace {
  version: 1;
  request_id?: string;
  session_id?: string | null;
  trace_id?: string | null;
  source_format?: string;
  requested_model?: string | null;
  mode: string;
  tier: string;
  score: number;
  domain_hints: {
    domain: string | null;
    modalities: string[];
    fast_path?: string | null;
  };
  scoring: {
    tier: string;
    score: number;
    momentum_adjusted: boolean;
  };
  constraints: {
    estimated_input_tokens: number | null;
    estimated_output_tokens: number | null;
    estimated_context_tokens: number | null;
    requires_structured_output: boolean;
    requires_reasoning?: boolean;
    reasoning_effort?: string | null;
    reasoning_budget_tokens?: number | null;
    reasoning_strategy?: string | null;
    local_prompt_cache_eligible?: boolean;
    local_prompt_cache_hit?: boolean;
    local_prompt_cache_lookup?: "hit" | "miss" | "disabled" | "skipped" | null;
  };
  modality_evidence?: {
    requested_modality: string | null;
    input_types: string[];
    output_types: string[];
    file_count: number | null;
    byte_size: number | null;
    required_capabilities: string[];
    endpoint_strategy: string | null;
    filtered_by_capability: Array<{
      node: string;
      model: string;
      reason: string;
      missing_capabilities?: string[];
      byte_size?: number | null;
      max_file_size?: number | null;
    }>;
    filtered_by_file_size: Array<{
      node: string;
      model: string;
      reason: string;
      missing_capabilities?: string[];
      byte_size?: number | null;
      max_file_size?: number | null;
    }>;
  };
  cache_evidence?: {
    local_prompt_cache_eligible: boolean;
    local_prompt_cache_hit: boolean;
    local_prompt_cache_lookup: "hit" | "miss" | "disabled" | "skipped" | null;
    semantic_cache_enabled?: boolean;
    semantic_cache_match?: boolean;
    semantic_cache_hit?: boolean;
    semantic_cache_score?: number | null;
    semantic_cache_threshold?: number | null;
    semantic_cache_metadata_only?: boolean;
    semantic_cache_reason?: string | null;
    cache_aware_routing: boolean;
    provider_cache_preference: boolean;
    notes: string[];
  };
  candidate_targets: RouteDecisionCandidate[];
  filters: RouteDecisionFilter[];
  load_balancing: {
    strategy: string;
    source: string;
    selected: RouteDecisionTarget | null;
    target_count: number;
    reason: string;
  };
  fallback_chain: RouteDecisionTarget[];
  cost_downgrade?: {
    applied: boolean;
    from: RouteDecisionTarget;
    to: RouteDecisionTarget;
    reason: string;
  } | null;
  intelligence?: RouteDecisionIntelligenceEvidence;
  semantic_platform?: RouteDecisionSemanticPlatformEvidence;
  final_selection: {
    node: string | null;
    model: string | null;
    reason: string | null;
    is_fallback: boolean;
    fallback_reason: string | null;
  };
  outcome?: {
    status_code: number;
    error: string | null;
  };
  privacy: {
    prompt: false;
    response: false;
    raw_headers: false;
    provider_keys: false;
  };
}

export interface RouteDecisionSummary {
  id: number;
  request_id: string;
  timestamp: string;
  source_format: string;
  tier: string;
  score: number;
  route_mode: string | null;
  strategy: string | null;
  selected: RouteDecisionTarget;
  final_selection: RouteDecisionTrace["final_selection"];
  domain_hint: string | null;
  candidate_count: number;
  filtered_count: number;
  status_code: number;
  is_fallback: boolean;
  fallback_reason: string | null;
  session_id?: string | null;
  trace_id?: string | null;
  api_key_name: string | null;
  api_key_id: string | null;
  namespace_id: string | null;
  summary: {
    reason: string | null;
    fallback_chain: RouteDecisionTarget[];
    filters: RouteDecisionFilter[];
    intelligence?: RouteDecisionIntelligenceEvidence | null;
    compatibility?: RouteDecisionCompatibilityEvidence | null;
    privacy: RouteDecisionTrace["privacy"];
  };
  trace?: RouteDecisionTrace | null;
}

export interface IntelligenceSummaryRow {
  key: string;
  requests: number;
  optimizer_applied: number;
  estimated_savings_usd: number;
  async_eval_queued: number;
  quality_gate_failed: number;
  near_or_over_budget: number;
}

export interface IntelligenceSummaryResponse {
  period: string;
  generated_at: string;
  summary: {
    total_requests: number;
    optimizer_applied: number;
    optimizer_applied_rate: number;
    estimated_savings_usd: number;
    async_eval_queued: number;
    token_risk: Record<string, number>;
    quality_gate: Record<string, number>;
    privacy: {
      prompt: false;
      response: false;
      raw_headers: false;
      provider_keys: false;
      tool_payloads: false;
      storage: string;
    };
  };
  by_agent: IntelligenceSummaryRow[];
  by_node: IntelligenceSummaryRow[];
}

export interface RouteDecisionsResponse {
  data: RouteDecisionSummary[];
  pagination: LogsPagination;
}

// ── Sessions / Trace View ──

export interface SessionSummary {
  session_id: string;
  first_seen_at: string | null;
  last_seen_at: string | null;
  request_count: number;
  error_count: number;
  fallback_count: number;
  model_switch_count: number;
  total_cost_usd: number;
  total_tokens: number;
  avg_latency_ms: number;
  models: string[];
  nodes: string[];
  source_formats: string[];
  trace_ids: string[];
  latest_request_id: string | null;
  latest_trace_id: string | null;
  latest_status_code: number | null;
  api_key_id: string | null;
  api_key_name: string | null;
  namespace_id: string | null;
  agent: CodingAgentSessionMetadata;
}

export interface CodingAgentSessionMetadata {
  connector: string | null;
  connectors?: string[];
  profile_id: string | null;
  profile_name: string | null;
  profiles?: string[];
  virtual_model: string | null;
  requested_model: string | null;
  session_id: string | null;
  turn_id: string | null;
  repo: string | null;
  repos?: string[];
  project: string | null;
  projects?: string[];
}

export interface SessionTimelineEvent {
  request_id: string;
  session_id: string | null;
  trace_id: string | null;
  timestamp: string;
  source_format: string;
  tier: string;
  score: number;
  node_id: string;
  model: string;
  status_code: number;
  latency_ms: number;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  is_fallback: boolean;
  fallback_reason: string | null;
  error: string | null;
  route_decision_link: string | null;
  has_route_decision: boolean;
  agent: CodingAgentSessionMetadata;
  route_decision: {
    id: number;
    selected_node_id: string | null;
    selected_model: string | null;
    candidate_count: number;
    filtered_count: number;
    route_mode: string | null;
    strategy: string | null;
    final_reason: string | null;
  } | null;
  shadow: {
    count: number;
    statuses: Record<string, number>;
    nodes: string[];
    models: string[];
    avg_latency_ms: number | null;
  };
  guardrails: {
    count: number;
    kinds: string[];
    actions: string[];
    rules: string[];
  };
}

export interface SessionPrivacy {
  prompt: false;
  response: false;
  raw_headers: false;
  provider_keys: false;
  media_bytes: false;
  video_bytes: false;
  source_code: false;
  diffs: false;
  tool_payloads: false;
  storage: "metadata_only";
}

export interface SessionsResponse {
  data: SessionSummary[];
  pagination: LogsPagination;
  filters: Record<string, string | null>;
  privacy: SessionPrivacy;
}

export interface SessionDetailResponse {
  session_id: string;
  summary: SessionSummary;
  timeline: SessionTimelineEvent[];
  filters: Record<string, string | null>;
  links: {
    route_decisions: number;
    shadow_results: number;
    guardrails_findings: number;
  };
  privacy: SessionPrivacy;
}

// ── Budget ──

export interface BudgetRule {
  id: number;
  type: string;
  scope: "global" | "api_key" | "namespace" | "team";
  scopeLabel?: string;
  sourceOfTruth?: "global_config" | "policy_namespace_config" | "team_policy" | "api_key_policy";
  source?: string;
  editableVia?: "config_file" | "policy_namespace_api" | "team_api" | "api_key_api";
  inherited?: boolean;
  unset?: boolean;
  blockingOrder?: number;
  blockingRuleScope?: "global" | "api_key" | "namespace" | "team" | null;
  apiKeyName: string | null;
  apiKeyId: string | null;
  namespaceId: string | null;
  teamId?: string | null;
  limit: number;
  current: number;
  percentage: number;
  alertThreshold?: number;
  exceeded: boolean;
  alert: boolean;
  periodStart: string;
  resetAt: string | null;
  dailyResetAt?: string | null;
}

export interface BudgetSelectedScope {
  scope: "global" | "api_key" | "namespace" | "team";
  label: string;
  targetId: string | null;
  sourceOfTruth: "global_config" | "policy_namespace_config" | "team_policy" | "api_key_policy";
  editableVia: "config_file" | "policy_namespace_api" | "team_api" | "api_key_api";
  configured: boolean;
  inherited: boolean;
  unset: boolean;
  blockingOrder: number;
  blockingRuleScope: "global" | "api_key" | "namespace" | "team" | null;
  dailyResetAt: string | null;
  alertThreshold: number | null;
}

export interface BudgetScopeChainItem {
  scope: "global" | "api_key" | "namespace" | "team";
  label: string;
  sourceOfTruth: string;
  editableVia: string;
  blockingOrder: number;
  activeForSelected: boolean;
}

export interface BudgetResponse {
  rules: BudgetRule[];
  namespaceRules?: BudgetRule[];
  teamRules?: BudgetRule[];
  perKeyRules?: BudgetRule[];
  namespaceId?: string | null;
  teamId?: string | null;
  apiKeyName?: string | null;
  apiKeyId?: string | null;
  selectedScope?: BudgetSelectedScope;
  scopeChain?: BudgetScopeChainItem[];
}

// ── Nodes ──

export interface CircuitBreaker {
  state: "CLOSED" | "OPEN" | "HALF_OPEN";
  consecutiveFailures: number;
  lastFailureAt: string | null;
}

export interface ConcurrencySnapshot {
  node: string;
  model?: string;
  max_concurrency: number | null;
  queue_timeout_ms: number;
  queue_policy: "wait" | "fallback" | "reject";
  active: number;
  queued: number;
}

export interface RealtimeNodeStatus {
  enabled: boolean;
  experimental: true;
  supported: boolean;
  endpoint: string | null;
  models: string[];
  active_connections: number;
  max_connections_per_node: number;
  last_connected_at: string | null;
  last_closed_at: string | null;
  last_error: string | null;
}

export type ProviderCompatibilityCapability =
  | "chat"
  | "responses"
  | "messages"
  | "embeddings"
  | "rerank"
  | "images"
  | "audio"
  | "video"
  | "realtime"
  | "batch";

export type ProviderCompatibilityStatus =
  | "pass"
  | "warning"
  | "fail"
  | "skipped";

export interface ProviderCompatibilityMatrixItem {
  capability: ProviderCompatibilityCapability;
  configured: boolean;
  tested: boolean;
  last_status: ProviderCompatibilityStatus | null;
  last_checked_at: string | null;
  failure_reason: string | null;
  latency_ms: number | null;
  status_code: number | null;
  test_mode: string | null;
  requires_confirmation: boolean;
  compatibility_profiles?: string[];
  profile_supported?: boolean;
}

export interface NodeInfo {
  enabled?: boolean;
  disabled?: boolean;
  id: string;
  name: string;
  protocol: "chat_completions" | "responses" | "messages" | "gemini";
  base_url: string;
  endpoint: string;
  timeout_ms: number;
  max_concurrency?: number | null;
  queue_timeout_ms?: number | null;
  queue_policy?: "wait" | "fallback" | "reject" | null;
  health_check?: HealthCheckRequest | null;
  auth_type?: "bearer" | "x-api-key" | "custom-header" | null;
  auth_header_name?: string | null;
  auth_header_prefix?: string | null;
  credentials?: ProviderCredentialInfo[];
  credential_pool?: CredentialPoolInfo;
  endpoints?: Record<string, string>;
  models: string[];
  embeddings_endpoint?: string | null;
  embedding_models?: string[];
  rerank_endpoint?: string | null;
  rerank_models?: string[];
  images_generations_endpoint?: string | null;
  images_edits_endpoint?: string | null;
  images_variations_endpoint?: string | null;
  image_models?: string[];
  audio_transcriptions_endpoint?: string | null;
  audio_translations_endpoint?: string | null;
  audio_speech_endpoint?: string | null;
  audio_models?: string[];
  video_generations_endpoint?: string | null;
  video_endpoint?: string | null;
  video_status_endpoint?: string | null;
  video_result_profile?: VideoResultProfile;
  video_content_endpoint?: string | null;
  video_cancel_endpoint?: string | null;
  video_models?: string[];
  batch_endpoint?: string | null;
  batch_status_endpoint?: string | null;
  batch_cancel_endpoint?: string | null;
  batch_result_endpoint?: string | null;
  compatibility_profile?: string[];
  resolved_compatibility_profiles?: string[];
  realtime_endpoint?: string | null;
  realtime_models?: string[];
  capabilities: string[];
  modalities: string[];
  model_capabilities?: Record<string, ModelCapabilityInfo>;
  configured_pricing_models?: string[];
  tags: string[];
  aliases: Record<string, string>;
  upstream_model_aliases?: Record<string, string>;
  request_compatibility?: NodeRequestCompatibility;
  model_prefixes: string[];
  circuit: CircuitBreaker;
  modelCircuits: Record<string, CircuitBreaker>;
  concurrency: ConcurrencySnapshot;
  realtime?: RealtimeNodeStatus;
  compatibility_matrix?: ProviderCompatibilityMatrixItem[];
  healthy: boolean;
}

export type CredentialPoolStrategy =
  | "least_in_flight"
  | "weighted_round_robin"
  | "cache_aware";
export type CredentialStickyBy =
  | "none"
  | "agent_session"
  | "api_key"
  | "team"
  | "namespace";

export interface ProviderCredentialInfo {
  id: string;
  enabled: boolean;
  weight: number;
  api_key?: string;
  api_key_secret_reference?: boolean;
}

export interface CredentialRuntimeStatus {
  id: string;
  enabled: boolean;
  weight: number;
  active: number;
  failures: number;
  cooldown_until: string | null;
  last_status: number | null;
  last_error: string | null;
  updated_at: string | null;
}

export interface CredentialPoolInfo {
  enabled: boolean;
  strategy: CredentialPoolStrategy;
  sticky_by: CredentialStickyBy;
  cooldown_ms: number;
  max_failures: number;
  retry_on_status: number[];
  credentials: CredentialRuntimeStatus[];
}

export interface ModelCapabilityInfo {
  modalities: string[];
  endpoints?: Record<string, string>;
  input_types?: string[];
  output_types?: string[];
  max_file_size?: number;
  supports_streaming?: boolean;
  supports_realtime?: boolean;
  supports_rerank?: boolean;
  supports_reasoning?: boolean | null;
  max_context_tokens?: number;
  structured_output: boolean | null;
  dimensions?: number | number[];
  pricing?: ModelPricing;
  quality_score?: number;
}

export interface NodeRequestCompatibility {
  messages_tool_result_content?: "native" | "string";
}

export type ConfigDiagnosticCode =
  | "duplicate_model_id"
  | "model_id_matches_node_id"
  | "alias_conflicts_with_model_id"
  | "alias_matches_node_id"
  | "duplicate_alias"
  | "duplicate_model_prefix"
  | "missing_model_pricing"
  | "route_references_unknown_node"
  | "route_references_unknown_model"
  | "split_overrides_targets"
  | "provider_compatibility_failed"
  | "provider_compatibility_untested";

export interface ConfigDiagnostic {
  severity: "warning";
  code: ConfigDiagnosticCode;
  message: string;
  nodes: string[];
  model?: string;
  alias?: string;
  matchingNodes?: string[];
  tier?: string;
  target?: string;
  capability?: string;
}

export interface NodesResponse {
  nodes: NodeInfo[];
  diagnostics: ConfigDiagnostic[];
}

// ── Provider Extensibility / Health ──

export interface ProviderHealthMetrics {
  calls: number;
  success: number;
  errors: number;
  error_rate: number;
  avg_latency_ms: number | null;
  p95_latency_ms: number | null;
  last_seen_at: string | null;
}

export interface ProviderHealthNode {
  node_id: string;
  provider_name: string;
  base_url_host: string;
  protocol: string;
  availability_status: "healthy" | "degraded" | "unhealthy" | "unknown";
  health_probe: {
    enabled: boolean;
    status: "disabled" | "unknown" | "healthy" | "unhealthy";
    method: string | null;
    target: string | null;
    last_checked_at: string | null;
    last_success_at: string | null;
    latency_ms: number | null;
    failure_reason: string | null;
    consecutive_failures: number;
  };
  circuit: {
    state: "CLOSED" | "OPEN" | "HALF_OPEN";
    consecutive_failures: number;
    last_failure_at: string | null;
  };
  metrics: ProviderHealthMetrics;
  compatibility_profiles: string[];
  pricing_warnings: string[];
  auth: {
    type: "bearer" | "x-api-key" | "custom-header" | string;
    custom_header_name: string | null;
    provider_key_returned: false;
  };
}

export interface ProviderHealthResponse {
  period: "1h" | "24h" | "7d";
  generated_at: string;
  workspace_id: string;
  totals: {
    nodes: number;
    healthy_nodes: number;
    degraded_nodes: number;
    unhealthy_nodes: number;
    calls: number;
    errors: number;
    error_rate: number;
    pricing_warning_count: number;
  };
  nodes: ProviderHealthNode[];
  privacy: {
    prompt: false;
    response: false;
    raw_headers: false;
    provider_keys: false;
    media_bytes: false;
    source_code: false;
    diffs: false;
    tool_payloads: false;
    hidden_reasoning: false;
    storage: "metadata_only";
  };
}

// ── Health ──

export interface HealthNodeStatus {
  id: string;
  name: string;
  protocol: string;
  circuit: string;
  consecutiveFailures: number;
  lastFailureAt: string | null;
  healthy: boolean;
  concurrency: ConcurrencySnapshot;
  realtime?: RealtimeNodeStatus;
}

export interface HealthBudgetStatus {
  type: string;
  current: number;
  limit: number;
  percentage: number;
  exceeded: boolean;
  alert: boolean;
}

export interface HealthDatabaseStatus {
  healthy: boolean;
  type: "sqlite" | "postgres";
  target: string;
  connected: boolean;
  latency_ms: number | null;
  checked_at: string;
  error: string | null;
  synchronize: boolean;
  pool?: {
    min: number;
    max: number;
    idle_timeout_ms: number;
    connection_timeout_ms: number;
    statement_timeout_ms?: number;
    query_timeout_ms?: number;
    max_uses?: number;
    application_name: string;
  };
  ssl?: "disabled" | "enabled" | "enabled-no-verify";
}

export interface HealthResponse {
  status: "healthy" | "degraded";
  uptime_ms: number;
  uptime_human: string;
  timestamp: string;
  database: HealthDatabaseStatus;
  nodes: HealthNodeStatus[];
  budget: HealthBudgetStatus[];
}

// ── Alerts ──

export type AlertEventType =
  | "release_available"
  | "budget_threshold"
  | "budget_exceeded"
  | "node_down"
  | "node_recovered"
  | "circuit_open"
  | "circuit_close"
  | "error_spike"
  | "latency_spike"
  | "quality_gate_failed" | "cost_anomaly" | "gateway_unavailable" | "gateway_recovered"
  | "gateway_restart_attempt" | "gateway_restart_failed" | "gateway_restart_unhealthy"
  | "restart_rate_limited" | "disk_space_low" | "database_size_high"
  | "disk_check_failed" | "database_size_check_failed" | "test";

export type AlertDeliveryState = "queued" | "sent" | "failed" | "debounced";

export interface AlertDeliveryStatus {
  id: string;
  event: AlertEventType;
  severity: "info" | "warning" | "critical";
  channel: string;
  status: AlertDeliveryState;
  attempts: number;
  timestamp: string;
  message: string;
  dedupe_key: string | null;
  last_error: string | null;
  sent_at: string | null;
}

export interface AlertChannelStatus {
  name: string;
  type: "webhook" | "feishu" | "wecom" | "telegram";
  events: AlertEventType[];
  last_status: AlertDeliveryState | null;
  last_error: string | null;
  last_event: AlertEventType | null;
  last_sent_at: string | null;
}

export interface AlertsResponse {
  enabled: boolean;
  configured_channels: number;
  channels: AlertChannelStatus[];
  recent: AlertDeliveryStatus[];
}

// ── Guardrails ──

export type GuardrailAction =
  | "audit"
  | "redact"
  | "block"
  | "allow"
  | "webhook";
export type GuardrailDeliveryState =
  | "queued"
  | "sent"
  | "failed"
  | "debounced"
  | "dropped";

export interface GuardrailFindingSummary {
  request_id?: string;
  direction: "input" | "output";
  kind: string;
  rule: string;
  action: GuardrailAction;
  severity: "low" | "medium" | "high";
  path: string;
  category?: string;
  match_count?: number;
  message?: string;
}

export interface GuardrailsWebhookStatus {
  id: string;
  status: GuardrailDeliveryState;
  attempts: number;
  timestamp: string;
  finding_count: number;
  rules: string[];
  actions: string[];
  last_error: string | null;
  sent_at: string | null;
}

export interface GuardrailsResponse {
  enabled: boolean;
  mode: "audit" | "redact" | "block";
  rules: {
    total: number;
    by_kind: Record<string, number>;
    by_action: Record<string, number>;
    schema: {
      input_enabled: boolean;
      output_enabled: boolean;
      input_strict: boolean;
      output_strict: boolean;
    };
  };
  findings: {
    total: number;
    by_kind: Record<string, number>;
    by_action: Record<string, number>;
    last_seen_at: string | null;
    recent: GuardrailFindingSummary[];
  };
  webhook: {
    enabled: boolean;
    configured: boolean;
    queue_depth: number;
    max_queue: number;
    drop_policy: "drop_newest" | "drop_oldest";
    dropped: number;
    last_status: GuardrailDeliveryState | null;
    last_error: string | null;
    last_sent_at: string | null;
    recent: GuardrailsWebhookStatus[];
  };
  privacy: {
    prompt: false;
    response: false;
    raw_headers: false;
    provider_keys: false;
    media_bytes: false;
  };
}

// ── Config ──

export interface SplitVariant {
  node: string;
  model: string;
  weight: number;
  name?: string;
}

export type LoadBalancingStrategy =
  | "weighted"
  | "round_robin"
  | "least_latency"
  | "random";
export type RoutingOptimization = "cost" | "latency" | "balanced" | "quality";

export interface WeightedRouteTarget {
  node: string;
  model: string;
  weight?: number;
  name?: string;
}

export interface TierRoute {
  primary?: { node: string; model: string };
  fallbacks?: { node: string; model: string }[];
  strategy?: LoadBalancingStrategy;
  targets?: WeightedRouteTarget[];
  split?: SplitVariant[];
}

export interface RoutingTargetMetrics {
  node: string;
  model: string;
  weight: number | null;
  samples: number;
  avg_latency_ms: number | null;
  p95_latency_ms: number | null;
  last_latency_ms: number | null;
  last_status_code: number | null;
}

export interface RoutingTierStatus {
  strategy:
    | LoadBalancingStrategy
    | RoutingOptimization
    | "primary_fallback"
    | "split";
  source: "primary_fallback" | "targets" | "split";
  targets: RoutingTargetMetrics[];
  last_selected: {
    node: string;
    model: string;
    selected_at: string;
    strategy:
      | LoadBalancingStrategy
      | RoutingOptimization
      | "primary_fallback"
      | "split";
    reason: string;
  } | null;
}

export interface RoutingConfig {
  tiers: Record<string, TierRoute>;
  scoring: {
    simple_max: number;
    standard_max: number;
    complex_max: number;
  };
  domain_preferences: Record<string, string[]>;
}

export interface ModelPricing {
  input: number;
  output: number;
  cache_creation_input?: number;
  cache_read_input?: number;
}

export interface ConfigResponse {
  server: { port: number; host: string };
  database: { type: string };
  auth: {
    api_keys: { name: string; key: string }[];
    managed_in_dashboard?: boolean;
  };
  nodes: {
    disabled?: boolean;
    id: string;
    name: string;
    protocol: string;
    base_url: string;
    models: string[];
    embedding_models?: string[];
    rerank_models?: string[];
    image_models?: string[];
    audio_models?: string[];
    video_models?: string[];
    realtime_models?: string[];
    model_capabilities?: Record<string, ModelCapabilityInfo>;
    tags: string[];
    api_key: string;
  }[];
  routing: RoutingConfig;
  routing_status?: Record<string, RoutingTierStatus>;
  budget: {
    daily_token_limit: number;
    daily_cost_limit: number;
    alert_threshold: number;
  };
  namespaces?: NamespaceInfo[];
  shadow?: ShadowTrafficStatus;
  config_audit?: {
    enabled: boolean;
    max_versions: number;
    max_events: number;
    capture_startup_snapshot: boolean;
    storage: string;
    secrets: string;
  };
  models_pricing: Record<string, ModelPricing>;
  diagnostics: ConfigDiagnostic[];
}

// ── Config Audit / Rollback ──

export interface ConfigAuditPrivacy {
  local_only: boolean;
  prompt_response_stored: boolean;
  raw_headers_stored: boolean;
  provider_keys_stored_in_audit: boolean;
  provider_keys_exposed_by_api: boolean;
  snapshot_storage: string;
}

export interface ConfigVersionSummary {
  id: number;
  version_id: string;
  created_at: string;
  created_by: string;
  source: "dashboard" | "cli" | "reload" | "rollback" | "system";
  checksum: string;
  config_path: string;
  runtime_version: number;
  node_count: number;
  node_ids: string[];
  route_tiers: string[];
  sanitized_summary: Record<string, unknown>;
}

export interface ConfigVersionDetail extends ConfigVersionSummary {
  sanitized_config: unknown;
  privacy: ConfigAuditPrivacy;
}

export interface ConfigVersionsResponse {
  data: ConfigVersionSummary[];
  pagination: { limit: number; count: number };
  privacy: ConfigAuditPrivacy;
}

export interface ConfigAuditEvent {
  id: number;
  event_id: string;
  timestamp: string;
  actor: string;
  action: string;
  target: string;
  before_summary: Record<string, unknown>;
  after_summary: Record<string, unknown>;
  result: "success" | "failure";
  failure_reason: string | null;
  source: string | null;
  version_id: string | null;
  previous_version_id: string | null;
  metadata: Record<string, unknown>;
}

export interface ConfigAuditEventsResponse {
  data: ConfigAuditEvent[];
  pagination: { limit: number; count: number };
  privacy: ConfigAuditPrivacy;
}

export interface ConfigRollbackResponse extends ActionResponse {
  target_version: ConfigVersionSummary;
  previous_version: ConfigVersionSummary | null;
  restored_version: ConfigVersionSummary | null;
  reload: unknown;
}

// ── Platform Management Audit ──

export type ManagementAuditResult = "success" | "failure" | "denied";

export interface ManagementAuditPrivacy {
  prompt_response_stored: boolean;
  raw_headers_stored: boolean;
  provider_keys_stored: boolean;
  tool_payloads_stored: boolean;
  hidden_reasoning_stored: boolean;
}

export interface ManagementAuditEvent {
  id: number;
  event_id: string;
  organization_id: string | null;
  workspace_id: string | null;
  timestamp: string;
  actor_type: string;
  actor_id: string;
  action: string;
  resource_type: string;
  resource_id: string | null;
  before_summary: Record<string, unknown>;
  after_summary: Record<string, unknown>;
  result: ManagementAuditResult;
  failure_reason: string | null;
  request_id: string | null;
  source: string | null;
  metadata: Record<string, unknown>;
  previous_hash: string | null;
  event_hash: string;
  schema_version: number;
}

export interface ManagementAuditEventsResponse {
  data: ManagementAuditEvent[];
  pagination: { limit: number; count: number };
  privacy: ManagementAuditPrivacy;
}

// ── SSE Events ──

export type SSEEvent =
  | { type: "connected"; timestamp: string }
  | {
      type: "activity";
      activity: {
        request_id: string;
        phase: "routed" | "streaming" | "completed" | "failed";
        timestamp: string;
        workspace_id: string;
        source_format: string;
        stream: boolean;
        node_id: string | null;
        model: string | null;
        input_tokens: number | null;
        output_tokens: number | null;
        cost_usd: number | null;
        latency_ms: number | null;
        status_code: number | null;
        estimated_usage?: boolean;
        is_fallback?: boolean;
        fallback_reason?: string | null;
        first_token_latency_ms?: number | null;
        tokens_per_second?: number | null;
      };
    }
  | { type: "log"; log: CallLog }
  | { type: "heartbeat"; timestamp: string };

// ── Cost Analytics ──

export interface CostAnalyticsDailyTrend {
  date: string;
  calls: number;
  cost: number;
  inputTokens: number;
  outputTokens: number;
}

export interface CostAnalyticsGroupItem {
  model?: string;
  nodeId?: string;
  tier?: string;
  calls: number;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  avgLatency?: number;
  avgCostPerCall?: number;
}

export interface CostAnalyticsResponse {
  period: number;
  total: {
    calls: number;
    cost: number;
    inputTokens: number;
    outputTokens: number;
    avgCostPerCall: number;
  };
  dailyTrend: CostAnalyticsDailyTrend[];
  byModel: CostAnalyticsGroupItem[];
  byNode: CostAnalyticsGroupItem[];
  byTier: CostAnalyticsGroupItem[];
}

export type {
  CacheSavingsMetrics,
  CacheSavingsGroupRow,
  CacheSavingsTrendRow,
  CacheSavingsSummaryResponse as CacheSavingsResponse,
} from "../../../src/dashboard/cache-savings.types";

// ── Benchmark Report ──

export type BenchmarkCheckStatus = "pass" | "warn" | "fail";

export interface BenchmarkLatencySummary {
  avg_ms: number;
  p50_ms: number;
  p75_ms: number;
  p95_ms: number;
  p99_ms: number;
  max_ms: number;
}

export interface BenchmarkThroughputEstimate {
  requests_per_minute: number;
  requests_per_second: number;
  period_requests_per_minute: number;
  basis: "observed_active_window";
}

export interface BenchmarkCostSummary {
  total_usd: number;
  avg_usd_per_request: number;
}

export interface BenchmarkTokenSummary {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  avg_tokens_per_request: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export interface BenchmarkCacheSummary {
  local_prompt_cache_hits: number;
  local_prompt_cache_hit_rate: number;
  provider_cache_read_hits: number;
  provider_cache_hit_rate: number;
  provider_cache_creation_hits: number;
  cache_aware_requests: number;
  cache_aware_request_rate: number;
  cache_read_token_ratio: number;
}

export interface BenchmarkMetrics {
  calls: number;
  total_requests: number;
  success: number;
  failed: number;
  success_rate: number;
  error_rate: number;
  fallback_rate: number;
  cache_hit_rate: number;
  cache_miss_rate: number;
  total_cost_usd: number;
  avg_cost_usd: number;
  total_tokens: number;
  avg_tokens: number;
  throughput_rpm: number;
  period_rpm: number;
  throughput: BenchmarkThroughputEstimate;
  cost_summary: BenchmarkCostSummary;
  token_summary: BenchmarkTokenSummary;
  cache_summary: BenchmarkCacheSummary;
  latency_ms: BenchmarkLatencySummary;
}

export interface BenchmarkCatalogEvidence {
  known_model: boolean;
  provider: string | null;
  modalities: string[];
  pricing_source: string | null;
  pricing_confidence?: string | null;
  pricing_stale?: boolean | null;
  pricing_used_from?: string | null;
  catalog_source: string | null;
}

export interface BenchmarkCheck {
  check:
    | "sample_size"
    | "success_rate"
    | "p95_latency"
    | "p99_latency"
    | "fallback_rate";
  status: BenchmarkCheckStatus;
  value: number;
  actual: string;
  target: string;
}

export interface BenchmarkGroup extends BenchmarkMetrics {
  node_id: string;
  model: string;
  source_formats: string[];
  status: BenchmarkCheckStatus;
  catalog: BenchmarkCatalogEvidence;
}

export interface BenchmarkStatusBucket {
  status_code: number;
  calls: number;
  rate: number;
}

export interface BenchmarkErrorBucket {
  error: string;
  calls: number;
}

export interface BenchmarkReportResponse {
  generated_at: string;
  period: "1h" | "24h" | "7d" | "30d" | "90d";
  window: {
    requested_since: string;
    observed_start: string | null;
    observed_end: string | null;
    active_minutes: number;
    sample_limit: number;
    truncated: boolean;
  };
  filters: {
    api_key: string | null;
    api_key_id: string | null;
    namespace: string | null;
    node: string | null;
    model: string | null;
    source_format: string | null;
  };
  summary: BenchmarkMetrics;
  checks: BenchmarkCheck[];
  by_node_model: BenchmarkGroup[];
  by_source_format: Array<
    BenchmarkMetrics & { source_format: string; source_family: string }
  >;
  by_source_family: Array<BenchmarkMetrics & { source_family: string }>;
  status_breakdown: BenchmarkStatusBucket[];
  top_errors: BenchmarkErrorBucket[];
  route_trace_coverage: {
    matched_requests: number;
    coverage_rate: number;
  };
  comparison_guidance: Array<{
    target: string;
    purpose: string;
    method: string;
  }>;
  methodology: {
    source: "call_logs";
    synthetic_run_script: string;
    direct_baseline_required: boolean;
    notes: string[];
  };
  privacy: {
    prompt_response_stored: false;
    raw_headers_stored: false;
    provider_keys_exposed: false;
    media_bytes_stored: false;
    metadata_only: true;
  };
}

// ── Batch Jobs ──

export interface BatchDashboardItem {
  id: number;
  request_id: string;
  provider_batch_id: string | null;
  node_id: string;
  model: string;
  endpoint: string | null;
  input_file_id: string | null;
  output_file_id: string | null;
  error_file_id: string | null;
  completion_window: string | null;
  metadata_keys: string[];
  request_counts: {
    total: number;
    completed: number;
    failed: number;
  };
  api_key_id: string | null;
  api_key_name: string | null;
  namespace_id: string | null;
  namespace_name: string | null;
  status: string;
  error: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface BatchDashboardResponse {
  metadata_only: true;
  items: BatchDashboardItem[];
  totals: {
    total: number;
    active: number;
    completed: number;
    failed: number;
    cancelled: number;
  };
  filters: {
    period: string;
    status: string | null;
    node: string | null;
    namespace: string | null;
    api_key_id: string | null;
  };
}

// ── Evaluation Reports ──

export type EvalRunStatus = "queued" | "running" | "completed" | "failed";
export type EvalWinner = "primary" | "candidate" | "tie" | null;

export interface EvalTargetReport {
  node_id: string | null;
  model: string;
  success_rate: number;
  avg_latency_ms: number;
  total_cost_usd: number;
  fallback_rate: number;
}

export interface EvalRunSummary {
  id: string;
  dataset_id: string | null;
  dataset_name: string;
  status: EvalRunStatus;
  sample_count: number;
  primary: EvalTargetReport;
  candidate: EvalTargetReport;
  judge: {
    node_id: string | null;
    model: string | null;
    avg_score: number | null;
  };
  winner: EvalWinner;
  summary: {
    success_delta?: number;
    latency_delta_ms?: number;
    cost_delta_usd?: number;
    fallback_delta?: number;
    judge_sample_coverage?: number;
    [key: string]: unknown;
  };
  privacy: EvalPrivacy;
  error: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface EvalPrivacy {
  prompt_response_stored: boolean;
  sample_previews_stored: boolean;
  raw_headers_stored: false;
  provider_keys_exposed: false;
  metadata_only: boolean;
  requires_explicit_sample_storage: true;
}

export interface EvalReportsResponse {
  generated_at: string;
  metadata_only: true;
  filters: {
    period: string;
    status: string | null;
    dataset_id: string | null;
  };
  totals: {
    runs: number;
    completed: number;
    failed: number;
    samples: number;
    avg_judge_score: number | null;
  };
  items: EvalRunSummary[];
  privacy: EvalPrivacy;
}

export interface EvalSampleSummary {
  id: number;
  sample_id: string | null;
  sample_hash: string;
  request_ids: {
    primary: string | null;
    candidate: string | null;
    judge: string | null;
  };
  primary: {
    status_code: number | null;
    success: boolean;
    latency_ms: number;
    cost_usd: number;
    fallback: boolean;
  };
  candidate: {
    status_code: number | null;
    success: boolean;
    latency_ms: number;
    cost_usd: number;
    fallback: boolean;
  };
  judge: {
    score: number | null;
    label: string | null;
    reason_summary: string | null;
  };
  error_type: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface EvalReportDetailResponse {
  generated_at: string;
  metadata_only: true;
  run: EvalRunSummary & {
    judge_config: Record<string, unknown>;
  };
  samples: EvalSampleSummary[];
  privacy: EvalPrivacy;
}

// ── Dashboard Playground ──

export type PlaygroundEndpoint =
  | "chat_completions"
  | "responses"
  | "messages"
  | "embeddings"
  | "rerank"
  | "images"
  | "audio"
  | "video"
  | "realtime";

export type PlaygroundOperation =
  | PlaygroundEndpoint
  | "image_generation"
  | "image_edit"
  | "image_variation"
  | "audio_speech"
  | "audio_transcription"
  | "audio_translation"
  | "video_generation"
  | "realtime_probe";

export interface PlaygroundRunRequest {
  endpoint: PlaygroundEndpoint;
  operation?: PlaygroundOperation;
  model: string;
  api_key_id?: string | null;
  namespace_id?: string | null;
  routing_hint?: unknown;
  stream?: boolean;
  body?: Record<string, unknown>;
}

export interface PlaygroundRunResponse {
  success: boolean;
  endpoint: PlaygroundEndpoint;
  operation: PlaygroundOperation;
  stream: boolean;
  request: {
    method: string;
    path: string;
    model: string;
    api_key_id: string | null;
    namespace_id: string | null;
    routing_hint: unknown;
    body_preview: string;
  };
  response_summary: {
    status_code: number;
    content_type: string;
    body_type: "json" | "text" | "sse" | "binary";
    body_preview: string;
    bytes: number;
    event_count: number;
    truncated: boolean;
  };
  usage: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
  cost_usd: number;
  latency_ms: number;
  status_code: number;
  route_decision: {
    request_id: string;
    link: string;
    available: boolean;
  } | null;
  privacy: {
    prompt_response_stored: false;
    raw_headers_stored: false;
    provider_keys_exposed: false;
    media_bytes_stored: false;
    standard_call_log_metadata: boolean;
  };
}

// ── Cache ──

export interface CacheStats {
  enabled: boolean;
  entries: number;
  maxEntries: number;
  hits: number;
  misses: number;
  hitRate: number;
  totalSizeBytes: number;
  memoryMb: number;
}

// ── Mutation Responses ──

export interface ActionResponse {
  success: boolean;
  message: string;
}

// ── Workspace RBAC ──

export type WorkspaceRole = "admin" | "operator" | "viewer";
export type WorkspaceMemberStatus = "active" | "disabled";
export type WorkspaceStatus = "active" | "disabled";

export interface WorkspacePermissions {
  can_read: boolean;
  can_operate: boolean;
  can_admin: boolean;
}

export interface WorkspaceAccess {
  user_id: string;
  role: WorkspaceRole;
  permissions: WorkspacePermissions;
}

export interface WorkspaceSummary {
  id: string;
  organization_id: string;
  name: string;
  slug: string;
  status: WorkspaceStatus;
  is_default: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface OrganizationSummary {
  id: string;
  name: string;
  slug: string;
  status: string;
  created_at?: string;
  updated_at?: string;
}

export interface WorkspaceState {
  organization: OrganizationSummary;
  active_workspace: WorkspaceSummary;
  default_workspace: WorkspaceSummary;
  workspaces: WorkspaceSummary[];
  access?: WorkspaceAccess;
}

export interface WorkspaceMutationResponse extends ActionResponse {
  item: WorkspaceSummary;
  state: WorkspaceState;
}

export interface WorkspaceMember {
  id: string;
  user_id: string;
  organization_id: string;
  workspace_id: string;
  role: WorkspaceRole;
  status: WorkspaceMemberStatus;
  created_at: string;
  updated_at: string;
}

export interface WorkspaceMembersResponse {
  items: WorkspaceMember[];
  roles: WorkspaceRole[];
  mode: "local_dashboard" | "local_dashboard_oidc";
}

export interface WorkspaceMemberMutationResponse extends ActionResponse {
  item: WorkspaceMember;
}

export type WorkspaceInvitationStatus = "pending" | "accepted" | "expired" | "revoked";

export interface WorkspaceInvitation {
  id: string;
  organization_id: string;
  workspace_id: string;
  role: WorkspaceRole;
  email: string | null;
  status: WorkspaceInvitationStatus;
  expires_at: string;
  accepted_at: string | null;
  accepted_by_user_id: string | null;
  created_by_user_id: string | null;
  created_at: string;
  updated_at: string;
  token?: string;
  accept_path?: string;
}

export interface WorkspaceInvitationsResponse {
  items: WorkspaceInvitation[];
}

export interface WorkspaceInvitationMutationResponse extends ActionResponse {
  item: WorkspaceInvitation;
}

// ── Node CRUD ──

export interface CreateNodeRequest {
  id: string;
  name: string;
  protocol: "chat_completions" | "responses" | "messages" | "gemini";
  base_url: string;
  endpoint: string;
  api_key?: string;
  credentials?: ProviderCredentialRequest[];
  credential_pool?: CredentialPoolRequest;
  models: string[];
  embeddings_endpoint?: string;
  embedding_models?: string[];
  rerank_endpoint?: string;
  rerank_models?: string[];
  images_generations_endpoint?: string;
  images_edits_endpoint?: string;
  images_variations_endpoint?: string;
  image_models?: string[];
  audio_transcriptions_endpoint?: string;
  audio_translations_endpoint?: string;
  audio_speech_endpoint?: string;
  audio_models?: string[];
  video_generations_endpoint?: string;
  video_status_endpoint?: string;
  video_result_profile?: VideoResultProfile;
  video_models?: string[];
  realtime_models?: string[];
  realtime_endpoint?: string;
  video_endpoint?: string;
  video_content_endpoint?: string;
  video_cancel_endpoint?: string;
  batch_endpoint?: string;
  batch_status_endpoint?: string;
  batch_cancel_endpoint?: string;
  batch_result_endpoint?: string;
  timeout_ms: number;
  max_concurrency?: number;
  queue_timeout_ms?: number;
  queue_policy?: "wait" | "fallback" | "reject";
  capabilities?: string[];
  modalities?: string[];
  tags?: string[];
  model_aliases?: Record<string, string>;
  upstream_model_aliases?: Record<string, string>;
  request_compatibility?: NodeRequestCompatibility;
  model_prefixes?: string[];
  headers?: Record<string, string>;
  model_capabilities?: Record<string, Partial<ModelCapabilityInfo>>;
  auth_type?: "bearer" | "x-api-key" | "custom-header";
  auth_header_name?: string;
  auth_header_prefix?: string;
  health_check?: HealthCheckRequest;
  compatibility_profile?: string[];
}

export interface UpdateNodeRequest {
  name?: string;
  protocol?: "chat_completions" | "responses" | "messages" | "gemini";
  base_url?: string;
  endpoint?: string;
  api_key?: string;
  credentials?: ProviderCredentialRequest[];
  credential_pool?: CredentialPoolRequest;
  models?: string[];
  embeddings_endpoint?: string;
  embedding_models?: string[];
  rerank_endpoint?: string;
  rerank_models?: string[];
  images_generations_endpoint?: string;
  images_edits_endpoint?: string;
  images_variations_endpoint?: string;
  image_models?: string[];
  audio_transcriptions_endpoint?: string;
  audio_translations_endpoint?: string;
  audio_speech_endpoint?: string;
  audio_models?: string[];
  video_generations_endpoint?: string;
  video_status_endpoint?: string;
  video_result_profile?: VideoResultProfile;
  video_models?: string[];
  realtime_models?: string[];
  realtime_endpoint?: string;
  video_endpoint?: string;
  video_content_endpoint?: string;
  video_cancel_endpoint?: string;
  batch_endpoint?: string;
  batch_status_endpoint?: string;
  batch_cancel_endpoint?: string;
  batch_result_endpoint?: string;
  timeout_ms?: number;
  max_concurrency?: number;
  queue_timeout_ms?: number;
  queue_policy?: "wait" | "fallback" | "reject";
  capabilities?: string[];
  modalities?: string[];
  tags?: string[];
  model_aliases?: Record<string, string>;
  upstream_model_aliases?: Record<string, string>;
  request_compatibility?: NodeRequestCompatibility;
  model_prefixes?: string[];
  headers?: Record<string, string>;
  model_capabilities?: Record<string, Partial<ModelCapabilityInfo>>;
  model_pricing_updates?: Array<{ model: string; action: 'set' | 'inherit'; input?: number; output?: number }>;
  auth_type?: "bearer" | "x-api-key" | "custom-header";
  auth_header_name?: string;
  auth_header_prefix?: string;
  health_check?: HealthCheckRequest;
  compatibility_profile?: string[];
}

export interface ProviderCredentialRequest {
  id: string;
  api_key: string;
  weight?: number;
  enabled?: boolean;
}

export interface CredentialPoolRequest {
  enabled?: boolean;
  strategy?: CredentialPoolStrategy;
  sticky_by?: CredentialStickyBy;
  cooldown_ms?: number;
  max_failures?: number;
  retry_on_status?: number[];
}

export interface HealthCheckRequest {
  enabled?: boolean;
  interval_seconds?: number;
  timeout_ms?: number;
  method?: "HEAD" | "GET" | "POST";
  path?: string;
  lightweight_model?: string;
}

export interface TestNodeRequest {
  protocol: "chat_completions" | "responses" | "messages" | "gemini";
  base_url: string;
  endpoint: string;
  api_key: string;
  model: string;
  auth_type?: "bearer" | "x-api-key" | "custom-header";
  auth_header_name?: string;
  auth_header_prefix?: string;
  headers?: Record<string, string>;
  capabilities?: ProviderCompatibilityCapability[];
  confirm_expensive?: boolean;
}

export interface TestNodeResponse {
  success: boolean;
  status: number;
  latency_ms: number;
  message: string;
  matrix?: ProviderCompatibilityMatrixItem[];
}

// ── Provider / Model Catalog ──

export type CatalogModality =
  | "text"
  | "vision"
  | "image"
  | "audio"
  | "video"
  | "embedding"
  | "rerank"
  | "realtime"
  | "batch"
  | "mcp";

export type CatalogEndpoint =
  | "chat_completions"
  | "responses"
  | "messages"
  | "gemini"
  | "embeddings"
  | "image_generations"
  | "image_edits"
  | "audio_transcriptions"
  | "audio_speech"
  | "video_generations"
  | "video_status"
  | "video_content"
  | "video_cancel"
  | "rerank"
  | "realtime"
  | "batch"
  | "mcp";

export type CatalogAuthType =
  | "bearer"
  | "x-api-key"
  | "custom-header"
  | "api-key-header"
  | "query-key"
  | "none"
  | "custom";

export interface CatalogPricing {
  input?: number | null;
  output?: number | null;
  image?: number | null;
  audio?: number | null;
  video?: number | null;
  rerank?: number | null;
  embedding?: number | null;
  cache_read_input?: number | null;
  cache_creation_input?: number | null;
  billing_unit?: string;
  input_per_1m_tokens?: number | null;
  output_per_1m_tokens?: number | null;
  cache_read_per_1m_tokens?: number | null;
  cache_write_per_1m_tokens?: number | null;
  embedding_per_1m_tokens?: number | null;
  rerank_per_1k_requests?: number | null;
  rerank_per_1k_docs?: number | null;
  image_per_generation?: number | null;
  image_per_edit?: number | null;
  audio_per_minute?: number | null;
  audio_per_1m_chars?: number | null;
  video_per_second?: number | null;
  video_per_generation?: number | null;
  realtime_per_minute?: number | null;
  batch_discount?: number | null;
  unit?: string;
  units?: Partial<Record<string, string>>;
  currency?: string;
  source_type?:
    | "official_docs"
    | "provider_api"
    | "aggregator_api"
    | "operator_override"
    | "docs_review"
    | "unknown";
  source: string;
  source_url?: string;
  last_updated: string;
  last_sync?: string;
  retrieved_at?: string;
  last_verified_at?: string;
  manual_review_required: boolean;
  review_reason?: string;
  stale_after_days?: number;
  pricing_confidence?: "high" | "medium" | "low" | "unknown";
  notes?: string;
}

export interface CatalogPricingHygiene {
  status:
    | "fresh"
    | "stale"
    | "placeholder"
    | "review_required"
    | "missing"
    | "invalid";
  currency: string | null;
  source_type?:
    | "official_docs"
    | "provider_api"
    | "aggregator_api"
    | "operator_override"
    | "docs_review"
    | "unknown"
    | null;
  source: string | null;
  source_url?: string | null;
  manual_review_required: boolean;
  review_reason?: string | null;
  pricing_confidence: "high" | "medium" | "low" | "unknown" | null;
  last_updated: string | null;
  last_verified_at?: string | null;
  retrieved_at?: string | null;
  age_days: number | null;
  stale_after_days: number | null;
  stale: boolean;
  placeholder: boolean;
  review_required?: boolean;
  source_missing?: boolean;
  source_url_missing?: boolean;
  missing_price_dimensions: string[];
  unit_mismatches: string[];
  warnings: string[];
}

export type CatalogPricingTrust =
  | "aligned_estimate"
  | "reference_estimate"
  | "review_required"
  | "missing";

export interface CatalogModel {
  id: string;
  name?: string;
  display_name?: string;
  provider?: string;
  provider_id: string;
  modalities: CatalogModality[];
  endpoints: CatalogEndpoint[];
  input_types: string[];
  output_types: string[];
  capabilities: string[];
  limits?: {
    max_context_tokens?: number;
    max_output_tokens?: number;
    max_file_size?: number;
    dimensions?: number[];
  };
  pricing: CatalogPricing;
  pricing_trust?: CatalogPricingTrust;
  pricing_hygiene?: CatalogPricingHygiene;
  structured_output?: boolean;
  supports_streaming?: boolean;
  supports_realtime?: boolean;
  supports_rerank?: boolean;
  manual_review_required?: boolean;
  canonical_id?: string;
  projection_source?:
    | "canonical_projection"
    | "catalog_override"
    | "sync_cache"
    | "builtin";
  lifecycle?: {
    release_date?: string;
    announcement_date?: string;
    knowledge_cutoff?: string;
  };
  specs?: {
    params?: number;
    training_tokens?: number;
    throughput?: number;
    multimodal?: boolean;
    license?: string;
    is_moe?: boolean;
  };
  benchmarks?: Record<string, number>;
  match_strategy?:
    | "exact_source_model_id"
    | "exact_canonical_slug"
    | "explicit_alias"
    | "strict_signature"
    | "strict_signature_release_date"
    | "ambiguous_candidate"
    | "unmatched";
  match_confidence?: "high" | "medium" | "low";
  pricing_sources?: {
    effective?: {
      source: string;
      source_type: string | null;
      source_url: string | null;
      pricing_confidence: string | null;
      manual_review_required: boolean;
      last_updated: string | null;
      retrieved_at: string | null;
      last_verified_at: string | null;
      has_pricing: boolean;
    };
    primary_reference?: {
      source: string;
      source_type: string | null;
      source_url: string | null;
      pricing_confidence: string | null;
      manual_review_required: boolean;
      last_updated: string | null;
      retrieved_at: string | null;
      last_verified_at: string | null;
      has_pricing: boolean;
    };
    secondary_reference?: {
      source: string;
      source_type: string | null;
      source_url: string | null;
      pricing_confidence: string | null;
      manual_review_required: boolean;
      last_updated: string | null;
      retrieved_at: string | null;
      last_verified_at: string | null;
      has_pricing: boolean;
    };
    effective_source: string | null;
    primary_reference_source: string | null;
    secondary_reference_source: string | null;
  };
  source?: "builtin" | "sync_cache" | "override";
  overridden?: boolean;
  synced?: boolean;
  enrichment?: {
    source: string;
    source_url?: string;
    synced_at?: string;
    enriched_from?: string;
    enriched_at?: string;
    match_strategy?:
      | "exact_source_model_id"
      | "exact_canonical_slug"
      | "explicit_alias"
      | "strict_signature"
      | "strict_signature_release_date"
      | "ambiguous_candidate"
      | "unmatched";
    match_confidence?: "high" | "medium" | "low";
    matched_from?: string[];
    match_notes?: string[];
    organization?: string;
    organization_id?: string;
    canonical_model_id?: string;
    release_date?: string;
    announcement_date?: string;
    multimodal?: boolean;
    throughput?: number;
    lifecycle?: {
      release_date?: string;
      announcement_date?: string;
      knowledge_cutoff?: string;
    };
    specs?: {
      params?: number;
      training_tokens?: number;
      throughput?: number;
      multimodal?: boolean;
      license?: string;
      is_moe?: boolean;
    };
    benchmarks?: Record<string, number>;
    secondary_pricing_reference?: CatalogPricing;
    metadata?: Record<string, unknown>;
  };
  notes?: string;
}

export type CatalogProviderFamily =
  | "foundation"
  | "aggregators"
  | "cloud"
  | "china"
  | "self_hosted"
  | "image_video"
  | "speech_audio"
  | "embedding_rerank";

export type CatalogProviderType =
  | "direct"
  | "aggregator"
  | "cloud"
  | "self_hosted"
  | "media"
  | "speech"
  | "local"
  | "custom"
  | "compatible";

export type CatalogProviderStatus =
  | "active"
  | "transport_only"
  | "deprecated"
  | "legacy_alias"
  | "custom";

export interface CatalogProviderVisibilitySummary {
  active: number;
  transport_only: number;
  custom: number;
  deprecated_legacy: number;
  deprecated: number;
  legacy_alias: number;
  default_visible: number;
  hidden_by_default: number;
  total: number;
}

export type CatalogCompatibilityProfile =
  | "native"
  | "openai-compatible"
  | "anthropic-compatible"
  | "google-compatible"
  | "local"
  | "custom";

export interface CatalogProviderModelBuckets {
  models: string[];
  embedding_models: string[];
  rerank_models: string[];
  image_models: string[];
  audio_models: string[];
  video_models: string[];
  realtime_models: string[];
  batch_models?: string[];
}

export interface CatalogRecommendedModelHint {
  primary_model: string;
  release_date?: string;
  has_pricing: boolean;
  source: "recommended" | "fallback";
}

export interface CatalogRecommendedModelEntry {
  bucket: keyof CatalogProviderModelBuckets;
  model_id: string;
  release_date?: string;
  has_pricing: boolean;
  source: "recommended" | "fallback";
}

export interface CatalogProvider {
  id: string;
  provider_id?: string;
  name: string;
  display_name?: string;
  description?: string;
  status?: CatalogProviderStatus;
  provider_status?: CatalogProviderStatus;
  default_visible?: boolean;
  replacement_provider_id?: string;
  replacement_note?: string;
  status_reason?: string;
  base_url: string;
  base_url_matchers: string[];
  protocols: Array<"chat_completions" | "responses" | "messages" | "gemini">;
  default_protocol: "chat_completions" | "responses" | "messages" | "gemini";
  endpoints: Partial<Record<CatalogEndpoint, string>>;
  compatibility_profiles?: string[];
  auth_type: CatalogAuthType;
  key_placeholder?: string;
  modalities: CatalogModality[];
  input_types?: string[];
  output_types?: string[];
  capabilities: string[];
  pricing: CatalogPricing;
  pricing_hygiene?: CatalogPricingHygiene;
  aliases?: string[];
  family?: CatalogProviderFamily;
  category?: CatalogProviderFamily | string;
  provider_type?: CatalogProviderType;
  compatibility_profile?: CatalogCompatibilityProfile | string;
  logo_id?: string;
  homepage_url?: string | null;
  docs_url?: string | null;
  pricing_url?: string | null;
  model_buckets?: CatalogProviderModelBuckets;
  recommended_model_buckets?: CatalogProviderModelBuckets;
  latest_model_hints?: Partial<
    Record<keyof CatalogProviderModelBuckets, CatalogRecommendedModelHint>
  >;
  recommended_models?: CatalogRecommendedModelEntry[];
  limits?: {
    model_count?: number;
    max_context_tokens?: number | null;
    max_file_size?: number | null;
  };
  canonical_model_coverage?: {
    total_models: number;
    canonicalized_models: number;
    projected_models: number;
    enriched_models: number;
    benchmarked_models: number;
    low_confidence_models: number;
    coverage_ratio: number;
  };
  pricing_coverage?: {
    total_models: number;
    priced_models: number;
    recommended_models: number;
    recommended_priced_models: number;
    manual_review_required_priced_models: number;
    estimate_ready_models?: number;
    aligned_estimate_models?: number;
    reference_estimate_models?: number;
    review_required_models?: number;
    missing_models?: number;
    coverage_ratio: number;
  };
  pricing_trust_summary?: {
    status: CatalogPricingTrust;
    total_models: number;
    estimate_ready_models: number;
    aligned_estimate_models: number;
    reference_estimate_models: number;
    review_required_models: number;
    missing_models: number;
  };
  pricing_units?: Record<string, string>;
  model_prefixes?: string[];
  tags?: string[];
  enrichment_summary?: {
    enriched_model_count: number;
    benchmarked_model_count: number;
    latest_enriched_at: string | null;
    sources: string[];
  };
  allows_unknown_models?: boolean;
  manual_review_required?: boolean;
  source?: "builtin" | "sync_cache" | "override";
  overridden?: boolean;
  synced?: boolean;
  models: CatalogModel[];
}

export interface ProviderCompatibilityProfile {
  profile_id: string;
  display_name: string;
  protocol_family: string;
  request_style: string;
  response_style: string;
  auth_strategy: string;
  endpoint_strategy: string;
  streaming_strategy: string;
  multipart_strategy: string;
  async_job_strategy: string;
  supported_source_formats: string[];
  supported_modalities: string[];
  passthrough_fields: string[];
  downgraded_fields: string[];
  unsupported_fields: string[];
  known_limitations: string[];
}

export interface CatalogSyncStatus {
  enabled: boolean;
  scheduled: boolean;
  write_to: "cache" | "override";
  interval_minutes: number;
  run_on_startup: boolean;
  cache_file: string;
  cache_found: boolean;
  override_file: string;
  override_found: boolean;
  supported_adapters: string[];
  enabled_adapters: string[];
  providers: Array<{
    provider: string;
    label: string;
    enabled: boolean;
    supported: boolean;
    automatic: boolean;
    status:
      | "disabled"
      | "fresh"
      | "stale"
      | "never_synced"
      | "manual_only"
      | "unsupported"
      | "failed"
      | "synced";
    last_sync: string | null;
    source_url: string;
    confidence: string | null;
    stale: boolean;
    stale_after_days: number | null;
    age_days: number | null;
    last_error: string | null;
  }>;
  issues: Array<{
    severity: string;
    code: string;
    message: string;
    path?: string;
  }>;
}

export interface CatalogProvidersResponse {
  version: string;
  source: "builtin_static";
  last_updated: string;
  auto_update: boolean;
  refresh_sources?: Array<{
    provider: string;
    label: string;
    mode: "public_api" | "authenticated_api" | "docs_review" | "operator_local";
    source_url: string;
    automatic: boolean;
    pricing: "live" | "docs_only" | "operator_required";
    notes: string;
  }>;
  provider_visibility?: CatalogProviderVisibilitySummary;
  sync_status?: CatalogSyncStatus;
  override_file?: string;
  override_found?: boolean;
  sync_cache_file?: string;
  sync_cache_found?: boolean;
  issues?: Array<{
    severity: string;
    code: string;
    message: string;
    path?: string;
  }>;
  compatibility_profiles?: ProviderCompatibilityProfile[];
  providers: CatalogProvider[];
}

export interface CatalogModelsResponse {
  version: string;
  source: "builtin_static";
  last_updated: string;
  auto_update: boolean;
  refresh_sources?: CatalogProvidersResponse["refresh_sources"];
  sync_status?: CatalogSyncStatus;
  override_file?: string;
  override_found?: boolean;
  sync_cache_file?: string;
  sync_cache_found?: boolean;
  issues?: Array<{
    severity: string;
    code: string;
    message: string;
    path?: string;
  }>;
  models: CatalogModel[];
}

// ── Capabilities ──

export interface CapabilityDefinition {
  id: string;
  label: { en: string; cn: string };
  icon: string;
  description: { en: string; cn: string };
  tierAffinity: {
    simple: number;
    standard: number;
    complex: number;
    reasoning: number;
  };
}

export interface CapabilitiesResponse {
  capabilities: CapabilityDefinition[];
}

export interface TierRecommendationItem {
  tier: string;
  score: number;
  suitable: boolean;
  label: string;
}

export interface TierRecommendationResponse {
  recommendations: TierRecommendationItem[];
}

export interface RoutingRecommendationItem {
  tier: string;
  primary: { node: string; model: string } | null;
  fallbacks: { node: string; model: string }[];
  score: number;
}

export interface RoutingRecommendationResponse {
  recommendations: RoutingRecommendationItem[];
}

// ── Adaptive Routing Recommendations ──

export interface AdaptiveRouteTargetStats {
  key: string;
  tier?: string;
  node: string;
  model: string;
  calls: number;
  successes: number;
  failures: number;
  success_rate: number;
  fallback_calls: number;
  fallback_rate: number;
  retry_count: number;
  avg_latency_ms: number;
  p50_latency_ms: number;
  p95_latency_ms: number;
  total_cost_usd: number;
  avg_cost_usd: number;
  cost_per_1k_calls_usd: number;
  first_seen_at: string | null;
  last_seen_at: string | null;
}

export interface AdaptiveTierStats {
  tier: string;
  calls: number;
  fallback_calls: number;
  fallback_rate: number;
  targets: AdaptiveRouteTargetStats[];
}

export interface AdaptiveRoutingStatsWindow {
  generated_at: string;
  window_hours: number;
  sample_limit: number;
  min_samples: number;
  observed_calls: number;
  targets: AdaptiveRouteTargetStats[];
  tiers: AdaptiveTierStats[];
}

export interface AdaptiveRoutingSavings {
  cost_usd_per_1k_calls: number;
  window_cost_usd: number;
  p50_latency_ms: number;
  p95_latency_ms: number;
}

export interface AdaptiveRoutingRecommendation {
  id: string;
  tier: string;
  type: "promote_primary" | "investigate_primary" | "collect_more_data";
  current_primary: { node: string; model: string };
  suggested_primary: { node: string; model: string } | null;
  suggested_fallbacks: { node: string; model: string }[];
  reasons: string[];
  confidence: number;
  potential_savings: AdaptiveRoutingSavings;
  risks: string[];
  evidence: {
    current: AdaptiveRouteTargetStats | null;
    candidate: AdaptiveRouteTargetStats | null;
    tier_calls: number;
  };
}

export interface AdaptiveRoutingRecommendationsResponse {
  mode: "recommendation_only";
  generated_at: string;
  stats: AdaptiveRoutingStatsWindow;
  recommendations: AdaptiveRoutingRecommendation[];
}

// ── Experiment Analytics ──

export interface ExperimentGroupStats {
  experimentGroup: string;
  calls: number;
  totalCost: number;
  avgCost: number;
  avgLatency: number;
  totalTokens: number;
  successCount: number;
  successRate: number;
}

export interface ExperimentDailyTrend {
  date: string;
  experimentGroup: string;
  calls: number;
  avgLatency: number;
  avgCost: number;
}

export interface ExperimentAnalyticsResponse {
  byGroup: ExperimentGroupStats[];
  dailyTrend: ExperimentDailyTrend[];
  activeSplits: Record<string, SplitVariant[]>;
  period: number;
}

// ── Budget Key Index ──

export interface BudgetKeyItem {
  id: string;
  name: string;
  key_prefix: string;
  daily_token_limit: number | null;
  daily_cost_limit: number | null;
  rate_limit_per_minute: number | null;
}

export interface BudgetKeysResponse {
  keys: string[];
  items: BudgetKeyItem[];
}

export interface ApiKeysResponse {
  keys: string[];
  items: GatewayApiKey[];
}

export interface LocalTeam {
  id: string;
  name: string;
  description: string | null;
  status: "active" | "disabled";
  namespace_id: string | null;
  namespace_name: string | null;
  allowed_nodes: string[];
  allowed_models: string[];
  allowed_endpoints: string[];
  allowed_modalities: string[];
  daily_token_limit: number | null;
  daily_cost_limit: number | null;
  rate_limit_per_minute: number | null;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
  today: {
    calls: number;
    errors: number;
    error_rate: number;
    cost_usd: number;
    input_tokens: number;
    output_tokens: number;
  };
}

export interface TeamsResponse {
  teams: LocalTeam[];
  mode: "local_only";
  enterprise_features: {
    workspace: boolean;
    sso: boolean;
    scim: boolean;
    org_billing: boolean;
  };
}

export interface CreateTeamRequest {
  name: string;
  description?: string | null;
  namespace_id?: string | null;
  allowed_nodes: string[];
  allowed_models: string[];
  allowed_endpoints: string[];
  allowed_modalities: string[];
  daily_token_limit?: number | null;
  daily_cost_limit?: number | null;
  rate_limit_per_minute?: number | null;
}

export type UpdateTeamRequest = Partial<CreateTeamRequest> & {
  status?: "active" | "disabled";
};

export interface TeamMutationResponse extends ActionResponse {
  item: LocalTeam;
}

// ── Gateway API Keys ──

export interface GatewayApiKey {
  id: string;
  name: string;
  description: string | null;
  key_prefix: string;
  status: "active" | "disabled";
  allow_auto: boolean;
  allow_direct: boolean;
  allowed_nodes: string[];
  allowed_models: string[];
  allowed_endpoints: string[];
  allowed_modalities: string[];
  namespace_id: string | null;
  namespace_name: string | null;
  team_id: string | null;
  team_name: string | null;
  daily_token_limit: number | null;
  daily_cost_limit: number | null;
  rate_limit_per_minute: number | null;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
  last_used_ip: string | null;
  today: {
    calls: number;
    errors: number;
    error_rate: number;
    cost_usd: number;
    input_tokens: number;
    output_tokens: number;
  };
}

export interface CreateGatewayApiKeyRequest {
  name: string;
  description?: string | null;
  allow_auto: boolean;
  allow_direct: boolean;
  allowed_nodes: string[];
  allowed_models: string[];
  allowed_endpoints: string[];
  allowed_modalities: string[];
  namespace_id?: string | null;
  team_id?: string | null;
  daily_token_limit?: number | null;
  daily_cost_limit?: number | null;
  rate_limit_per_minute?: number | null;
}

export type UpdateGatewayApiKeyRequest = Partial<CreateGatewayApiKeyRequest> & {
  status?: "active" | "disabled";
};

export interface GatewayApiKeyMutationResponse extends ActionResponse {
  item: GatewayApiKey;
  key?: string;
}

// ── Agent Gateway Profiles ──

export type AgentProfileConnector =
  | "cursor"
  | "cline"
  | "roo_code"
  | "continue"
  | "codex"
  | "claude_code"
  | "opencode"
  | "cherry_studio"
  | "hermes"
  | "openclaw"
  | "generic_openai"
  | "generic_anthropic";

export type AgentProfileStatus = "active" | "disabled";

export type AgentProfileBaseUrlMode = "openai_v1" | "anthropic_v1" | "root";

export interface AgentProfileGatewayKeySummary {
  id: string;
  name: string;
  key_prefix: string;
  status: string;
  allow_auto: boolean;
  allow_direct: boolean;
  allowed_models: string[];
  namespace_id: string | null;
  namespace_name: string | null;
}

export interface AgentProfile {
  id: string;
  name: string;
  description: string | null;
  connector: AgentProfileConnector;
  status: AgentProfileStatus;
  api_key_id: string | null;
  api_key: AgentProfileGatewayKeySummary | null;
  namespace_id: string | null;
  namespace_name: string | null;
  default_model: string;
  smart_model_id: string;
  virtual_model_aliases: string[];
  base_url_mode: AgentProfileBaseUrlMode;
  routing_hint: Record<string, unknown> | null;
  mcp_server_ids: string[];
  metadata: Record<string, unknown> | null;
  last_generated_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AgentProfilesResponse {
  items: AgentProfile[];
  connectors: AgentProfileConnector[];
  mode: "local_only";
}

export interface CreateAgentProfileRequest {
  name: string;
  description?: string | null;
  connector: AgentProfileConnector;
  status?: AgentProfileStatus;
  api_key_id?: string | null;
  namespace_id?: string | null;
  default_model?: string;
  smart_model_id?: string;
  base_url_mode?: AgentProfileBaseUrlMode;
  routing_hint?: Record<string, unknown> | null;
  mcp_server_ids?: string[] | null;
  metadata?: Record<string, unknown> | null;
}

export type UpdateAgentProfileRequest = Partial<CreateAgentProfileRequest>;

export interface AgentProfileMutationResponse extends ActionResponse {
  item: AgentProfile;
}

export interface RenderAgentProfileRequest {
  gateway_base_url?: string;
}

export interface AgentProfileRenderedGatewayKey {
  placeholder: string;
  key_prefix: string | null;
  name: string | null;
  status: string | null;
}

export interface AgentProfileRenderedCard {
  id: string;
  title: string;
  protocol: "openai" | "anthropic" | "root";
  fields: Record<
    string,
    | string
    | string[]
    | Record<string, unknown>
    | Array<Record<string, unknown>>
    | null
  >;
  env: Record<string, string>;
  snippet: string;
  notes: string[];
}

export interface AgentProfileRenderedConfig {
  connector: AgentProfileConnector;
  connector_label: string;
  profile_id: string;
  profile_name: string;
  status: AgentProfileStatus;
  base_url: string;
  base_url_mode: AgentProfileBaseUrlMode;
  smart_model_id: string;
  default_model: string;
  virtual_model_aliases: string[];
  gateway_api_key: AgentProfileRenderedGatewayKey;
  secrets_redacted: true;
  routing_hint: Record<string, unknown> | null;
  mcp_server_ids: string[];
  cards: AgentProfileRenderedCard[];
}

export interface AgentProfileRenderResponse extends ActionResponse {
  item: AgentProfileRenderedConfig;
}

// ── Local Namespaces + Shadow Traffic ──

export interface NamespaceInfo {
  id: string;
  name: string;
  allowed_nodes: string[];
  allowed_models: string[];
  rate_limit_per_minute: number | null;
  budget: {
    daily_token_limit?: number;
    daily_cost_limit?: number;
    alert_threshold?: number;
  } | null;
  budget_status: BudgetRule[];
  bindings: NamespaceBindings;
}

export interface NamespacesResponse {
  namespaces: NamespaceInfo[];
  counts: {
    total: number;
    with_budget: number;
    with_rate_limit: number;
    bound_api_keys: number;
    bound_teams: number;
  };
  mode: "local_only";
  enterprise_features: {
    workspace: boolean;
    sso: boolean;
    scim: boolean;
    org_billing: boolean;
  };
}

export interface NamespaceBindings {
  api_keys: Array<{
    id: string;
    name: string;
    status: string;
    key_prefix: string;
    team_id: string | null;
    source: "dashboard" | "config";
  }>;
  teams: Array<{
    id: string;
    name: string;
    status: string;
  }>;
  counts: {
    api_keys: number;
    teams: number;
    total: number;
  };
}

export interface NamespaceBudgetRequest {
  daily_token_limit?: number;
  daily_cost_limit?: number;
  alert_threshold?: number;
}

export interface NamespaceRateLimitRequest {
  requests_per_minute?: number;
}

export interface CreateNamespaceRequest {
  id: string;
  name?: string;
  allowed_nodes: string[];
  allowed_models: string[];
  budget?: NamespaceBudgetRequest | null;
  rate_limit?: NamespaceRateLimitRequest | null;
}

export type UpdateNamespaceRequest = Partial<Omit<CreateNamespaceRequest, "id">>;

export interface NamespaceMutationResponse extends ActionResponse {
  item?: NamespaceInfo | null;
  impact?: NamespaceBindings;
}

export interface ShadowTrafficStatus {
  enabled: boolean;
  sample_rate: number;
  target_node: string | null;
  target_model: string | null;
  timeout_ms: number | null;
  max_recent_results: number;
  compare: {
    store_prompts: boolean;
    store_responses: boolean;
    sample_max_chars?: number;
  };
  privacy: {
    stores_prompts: boolean;
    stores_responses: boolean;
    raw_headers: boolean;
    provider_keys: boolean;
    media_bytes?: boolean;
    video_bytes?: boolean;
    sample_redaction?: boolean;
  };
}

export interface ShadowTrafficResult {
  id: number;
  timestamp: string;
  request_id: string;
  kind: "chat" | "embeddings";
  namespace_id: string | null;
  api_key_id: string | null;
  api_key_name: string | null;
  source_format: string;
  primary_node: string;
  primary_model: string;
  shadow_node: string;
  shadow_model: string;
  status: "sent" | "failed" | "skipped";
  latency_ms: number | null;
  status_code: number | null;
  error: string | null;
  input_tokens: number;
  output_tokens: number;
  prompt_sample: string | null;
  response_sample: string | null;
}

export interface ShadowReportFilters {
  namespace?: string;
  api_key?: string;
  api_key_id?: string;
  node?: string;
  model?: string;
  period?: string;
  source_format?: string;
}

export interface ShadowConfidence {
  level: "low" | "medium" | "high";
  score: number;
}

export interface ShadowComparisonPair {
  primary_node: string;
  primary_model: string;
  shadow_node: string;
  shadow_model: string;
  calls: number;
  primary_success_rate: number | null;
  shadow_success_rate: number | null;
  primary_p50_latency_ms: number | null;
  shadow_p50_latency_ms: number | null;
  primary_p95_latency_ms: number | null;
  shadow_p95_latency_ms: number | null;
  cost_delta_usd: number;
  token_delta: number;
  fallback_delta: number;
}

export interface ShadowComparisonReport {
  generated_at: string;
  filters: {
    namespace_id: string | null;
    api_key_id: string | null;
    api_key_name: string | null;
    node: string | null;
    model: string | null;
    period: string;
    source_format: string | null;
  };
  window: {
    start_at: string;
    end_at: string;
    rows: number;
    comparable: number;
    missing_primary_logs: number;
  };
  primary_success_rate: number | null;
  shadow_success_rate: number | null;
  latency_delta_ms: number | null;
  p50_latency_comparison: {
    primary_ms: number | null;
    shadow_ms: number | null;
    delta_ms: number | null;
  };
  p95_latency_comparison: {
    primary_ms: number | null;
    shadow_ms: number | null;
    delta_ms: number | null;
  };
  cost_delta_usd: number;
  potential_savings_usd: number;
  token_delta: number;
  fallback_delta: number;
  quality_sample_coverage: number;
  confidence: ShadowConfidence;
  risk_notes: string[];
  primary: {
    calls: number;
    success_rate: number | null;
    p50_latency_ms: number | null;
    p95_latency_ms: number | null;
    total_cost_usd: number;
    total_tokens: number;
    fallback_rate: number | null;
  };
  shadow: {
    calls: number;
    success_rate: number | null;
    p50_latency_ms: number | null;
    p95_latency_ms: number | null;
    total_cost_usd: number;
    total_tokens: number;
    fallback_rate: number | null;
    pricing_missing: number;
  };
  pairs: ShadowComparisonPair[];
  privacy: ShadowTrafficStatus["privacy"];
}

export interface ShadowResultComparison {
  result_id: number;
  request_id: string;
  timestamp: string;
  source_format: string;
  namespace_id: string | null;
  api_key_id: string | null;
  api_key_name: string | null;
  primary: {
    node: string;
    model: string;
    success: boolean | null;
    status_code: number | null;
    latency_ms: number | null;
    cost_usd: number | null;
    input_tokens: number;
    output_tokens: number;
    is_fallback: boolean | null;
    fallback_reason: string | null;
  };
  shadow: {
    node: string;
    model: string;
    success: boolean;
    status: string;
    status_code: number | null;
    latency_ms: number | null;
    estimated_cost_usd: number;
    input_tokens: number;
    output_tokens: number;
    error: string | null;
  };
  deltas: {
    latency_ms: number | null;
    cost_usd: number | null;
    tokens: number | null;
    fallback: number | null;
  };
  samples: {
    prompt_stored: boolean;
    response_stored: boolean;
    prompt_preview: string | null;
    response_preview: string | null;
  };
  risk_notes: string[];
  privacy: ShadowTrafficStatus["privacy"];
}

export interface ShadowTrafficResponse {
  status: ShadowTrafficStatus;
  recent: ShadowTrafficResult[];
}

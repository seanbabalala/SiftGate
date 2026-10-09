import type { VideoResultProfile } from "../pricing/video-result-profile.types";
// ===================================================================
// Gateway Configuration — Type Definitions
// ===================================================================
// Types matching the structure of gateway.config.yaml
// ===================================================================

import type {
  CapabilityEndpoint,
  CapabilityIOType,
  Modality,
} from './modality';
import type { PluginConfigEntry } from '../plugins/types';
import type { SourceFormat, Tier } from '../canonical/canonical.types';

export interface GatewayConfig {
  server: ServerConfig;
  database: DatabaseConfig;
  auth: AuthConfig;
  dashboard?: DashboardConfig;
  catalog?: CatalogConfig;
  nodes: NodeConfig[];
  routing: RoutingConfig;
  budget: BudgetConfig;
  cache?: CacheConfig;
  models_pricing: Record<string, ModelPricing>;

  /** Host-wide pricing-management capacity limits; no effect on frozen request prices. */
  pricing_limits?: PricingLimitsConfig;

  /** Plugin declarations — loaded at startup in order */
  plugins?: PluginConfigEntry[];

  /** OpenTelemetry observability — disabled by default */
  telemetry?: TelemetryConfig;

  /** Runtime config reload behavior — watcher disabled by default */
  hot_reload?: HotReloadConfig;

  /** Optional OSS-local embeddings request batching — disabled by default */
  embedding_batching?: EmbeddingBatchingConfig;

  /** Experimental OpenAI Realtime-compatible WebSocket preview — disabled by default */
  realtime?: RealtimeConfig;

  /** Experimental OSS-local MCP server proxy preview — disabled by default */
  mcp?: McpGatewayConfig;

  /** Optional shared state backend; memory remains the default single-node mode */
  state?: StateBackendConfig;

  /** Optional multi-instance cluster mode; enabled explicitly or by state.backend=redis */
  cluster?: ClusterConfig;

  /** Optional OSS-local alerting channels — disabled by default */
  alerts?: AlertsConfig;

  /** Optional external call-log sinks — disabled by default */
  logging?: LoggingConfig;

  /** Optional OSS-local namespaces — no enterprise workspace/org features */
  namespaces?: NamespaceConfig[];

  /** Optional async shadow traffic mirror — disabled by default */
  shadow?: ShadowTrafficConfig;

  /** Optional local evaluation framework metadata and sample-storage controls. */
  evaluation?: EvaluationConfig;

  /** Optional v2 intelligence loop controls: cost optimizer, token prediction, async eval metadata, and quality gates. */
  intelligence?: IntelligenceConfig;

  /** Optional semantic caching preview. Disabled by default and metadata-only unless explicitly configured. */
  semantic_cache?: SemanticCacheConfig;

  /** Optional v2.7 semantic platform controls: cache v2, prompt registry, context optimization, intent, and guardrails v2. */
  semantic_platform?: SemanticPlatformConfig;

  /** Optional local config audit log and rollback history. */
  config_audit?: ConfigAuditConfig;

  /** Optional secret reference backends; env references are enabled by default */
  secret_manager?: SecretManagerConfig;

  /** Optional hosted control-plane connection — disabled by default */
  control_plane?: ControlPlaneConfig;
}

export interface PricingLimitsConfig {
  /** Rules across unique current/scheduled price versions; default: 20000, hard maximum: 100000. */
  max_published_rules?: number;
  /** UTF-8 bytes of parsed JSON for pricing management actions; default/hard maximum: 1048576. */
  max_request_body_bytes?: number;
  /** Cumulative rows read by one historical replay. Default: 4096. */
  max_replay_rows?: number;
  /** Selected field UTF-8 bytes plus 64 bytes per field/read for metadata. Default: 64 MiB. */
  max_replay_source_bytes?: number;
  /** Complete replay response size. Default: 8 MiB. */
  max_replay_result_bytes?: number;
  /** Bounded replay calculation/serialization work. Default: 250000 units. */
  max_replay_work?: number;
  /** Cooperative replay deadline, including database queue/read time. Default: 2000 ms. */
  max_replay_ms?: number;
}

export interface CatalogConfig {
  /** Local model/provider catalog override file. Defaults to catalog.override.yaml. */
  override_file?: string;
  /** Optional model/pricing sync. Disabled by default and requires explicit provider adapters. */
  sync?: CatalogSyncConfig;
}

export interface CatalogSyncConfig {
  /** Master switch for scheduled model/pricing sync (default: false). */
  enabled?: boolean;
  /** Scheduler interval in minutes (default: 1440). */
  interval_minutes?: number;
  /** Run once on startup when enabled (default: false). */
  run_on_startup?: boolean;
  /** Where automatic sync writes data. cache is safest and never overwrites user overrides. */
  write_to?: 'cache' | 'override';
  /** SiftGate-managed local catalog cache path. Defaults to .siftgate/catalog-sync-cache.yaml. */
  cache_file?: string;
  /** Optional override output path when write_to=override. Defaults to catalog.override_file. */
  override_file?: string;
  /** Explicit provider adapters. Only openrouter is supported in v1.2. */
  adapters?: Record<string, CatalogSyncAdapterConfig>;
}

export interface CatalogSyncAdapterConfig {
  enabled?: boolean;
}

// ===== Config Audit / Rollback =====
export interface ConfigAuditConfig {
  /** Master switch for local config audit/version history (default: true). */
  enabled?: boolean;
  /** Maximum stored config versions before oldest versions are pruned (default: 50). */
  max_versions?: number;
  /** Maximum audit events returned by Dashboard APIs (default: 200). */
  max_events?: number;
  /** Capture a startup baseline snapshot on boot (default: false). */
  capture_startup_snapshot?: boolean;
}

// ===== Secret References =====
export type SecretManagerFailurePolicy = 'fail_closed' | 'fail_open_for_optional';

export interface SecretManagerConfig {
  /** Local in-process cache TTL for resolved references (default: 300 seconds). */
  cache_ttl_seconds?: number;
  /** Runtime behavior when a reference fails to resolve (default: fail_closed). */
  failure_policy?: SecretManagerFailurePolicy;
  /** Env is enabled by default. Vault/AWS/GCP are disabled unless explicitly enabled. */
  backends?: SecretManagerBackendsConfig;
}

export interface SecretManagerBackendsConfig {
  env?: {
    enabled?: boolean;
  };
  vault?: VaultSecretManagerConfig;
  aws_sm?: AwsSecretsManagerConfig;
  gcp_sm?: GcpSecretManagerConfig;
}

export interface VaultSecretManagerConfig {
  enabled?: boolean;
  /** Vault address, for example https://vault.example.com. May use ${env:VAULT_ADDR}. */
  address?: string;
  /** Vault token. May use ${env:VAULT_TOKEN}; never returned by Dashboard APIs. */
  token?: string;
  /** KV mount name used when a reference does not already include /data/. */
  mount?: string;
  /** Vault KV version (default: 2). */
  kv_version?: 1 | 2;
  timeout_ms?: number;
}

export interface AwsSecretsManagerConfig {
  enabled?: boolean;
  region?: string;
  /** Optional custom endpoint for local/mocked Secrets Manager-compatible services. */
  endpoint?: string;
  access_key_id?: string;
  secret_access_key?: string;
  session_token?: string;
  timeout_ms?: number;
}

export interface GcpSecretManagerConfig {
  enabled?: boolean;
  project_id?: string;
  /** Optional custom endpoint for local/mocked Secret Manager-compatible services. */
  endpoint?: string;
  access_token?: string;
  /** Allow Compute metadata token lookup when access_token is omitted (default: true). */
  use_metadata?: boolean;
  timeout_ms?: number;
}

// ===== Shared State Backend =====
export type StateBackendType = 'memory' | 'redis';
export type StateUnavailablePolicy = 'fail_open' | 'fail_closed';

export interface StateBackendConfig {
  /** Runtime state backend (default: memory). Redis is optional for multi-instance deployments. */
  backend?: StateBackendType;
  /** Behavior when Redis is configured but unavailable (default: fail_open). */
  unavailable_policy?: StateUnavailablePolicy;
  redis?: RedisStateBackendConfig;
  /**
   * Optional per-category runtime state policy. Defaults keep v1.9 behavior:
   * safety gates such as rate limits and circuit breakers inherit
   * unavailable_policy; metadata/affinity/cache state fails open.
   */
  categories?: Partial<Record<StateCategoryName, StateCategoryConfig>>;
}

export interface RedisStateBackendConfig {
  /** redis:// or rediss:// URL. May use ${REDIS_URL}. */
  url?: string;
  /** Key prefix used for all SiftGate runtime state (default: siftgate:state:). */
  prefix?: string;
  /** Per-command timeout in milliseconds (default: 500). */
  timeout_ms?: number;
  /** Poll interval for sync-only local mirrors such as circuit/momentum (default: 2000). */
  sync_interval_ms?: number;
}

export type StateCategoryName =
  | 'rate_limit'
  | 'circuit_breaker'
  | 'cache_affinity'
  | 'momentum'
  | 'prompt_cache'
  | 'semantic_cache'
  | 'concurrency'
  | 'health_probe'
  | 'realtime_session';

export interface StateCategoryConfig {
  /** Redis unavailable behavior for this category. Defaults by category. */
  unavailable_policy?: StateUnavailablePolicy;
  /** Default TTL for category entries when callers do not supply one. */
  ttl_seconds?: number;
}

// ===== Hot Reload =====
export interface HotReloadConfig {
  /** Watch gateway.config.yaml for changes (default: false) */
  watch?: boolean;
  /** Debounce file watcher reloads in milliseconds (default: 500) */
  debounce_ms?: number;
}

// ===== Cluster =====
export interface ClusterConfig {
  /** Explicit cluster switch. state.backend=redis also enables cluster status/heartbeats. */
  enabled?: boolean;
  /** Stable instance id. Defaults to hostname + process id. */
  instance_id?: string;
  /** Redis override for cluster Pub/Sub. Falls back to state.redis. */
  redis?: RedisStateBackendConfig;
  /** Heartbeat publish/write interval in seconds (default: 10). */
  heartbeat_interval_seconds?: number;
  /** Instance heartbeat TTL in seconds (default: max(30, interval*3)). */
  heartbeat_ttl_seconds?: number;
  /** Broadcast successful local config reloads to peers (default: true). */
  reload_broadcast?: boolean;
}

// ===== Alerts =====
export type AlertEventType =
  | "release_available"
  | 'budget_threshold'
  | 'budget_exceeded'
  | 'node_down'
  | 'node_recovered'
  | 'circuit_open'
  | 'circuit_close'
  | 'error_spike'
  | 'latency_spike'
  | 'quality_gate_failed'
  | 'cost_anomaly'
  | 'gateway_unavailable' | 'gateway_recovered' | 'gateway_restart_attempt'
  | 'gateway_restart_failed' | 'gateway_restart_unhealthy' | 'restart_rate_limited'
  | 'disk_space_low' | 'database_size_high' | 'disk_check_failed' | 'database_size_check_failed'
  | 'test';

export type AlertConnectorType = 'webhook' | 'feishu' | 'wecom' | 'telegram';

export interface AlertsConfig {
  /** Master switch for local alert dispatch (default: false) */
  enabled?: boolean;
  /** Operator-configured outbound connectors. Empty by default. */
  channels?: AlertChannelConfig[];
  /** Recent alert delivery records retained for Dashboard (default: 50) */
  history_size?: number;
  /** Local sliding-window rule for error spikes. */
  error_spike?: AlertSpikeRuleConfig;
  /** Local sliding-window rule for p95 latency spikes. */
  latency_spike?: AlertLatencySpikeRuleConfig;
}

export interface AlertChannelConfig {
  type: AlertConnectorType;
  id?: string;
  /** Legacy YAML channels are enabled unless explicitly disabled. */
  enabled?: boolean;
  /** Stable display name used in Dashboard and debounce keys. */
  name?: string;
  url?: string;
  signing_secret?: string;
  bot_token?: string;
  chat_id?: string;
  /** Optional outbound headers. Values may use environment references. */
  headers?: Record<string, string>;
  /** Events delivered by this channel. Unset means all supported events. */
  events?: AlertEventType[];
  /** Per-channel debounce window in seconds (default: 300). */
  debounce_seconds?: number;
  /** Webhook retry and timeout controls. */
  retry?: AlertWebhookRetryConfig;
}

/** Backward-compatible public type for existing generic webhook integrations. */
export interface WebhookAlertChannelConfig extends AlertChannelConfig {
  type: 'webhook';
  url: string;
}

export interface AlertWebhookRetryConfig {
  /** Total delivery attempts, including the first attempt (default: 3). */
  attempts?: number;
  /** Delay between failed attempts in milliseconds (default: 1000). */
  backoff_ms?: number;
  /** Per-attempt HTTP timeout in milliseconds (default: 5000). */
  timeout_ms?: number;
}

export interface AlertSpikeRuleConfig {
  /** Enable this detector when alerting is enabled (default: true). */
  enabled?: boolean;
  /** Sliding window in seconds (default: 300). */
  window_seconds?: number;
  /** Minimum samples before evaluating (default: 20). */
  min_requests?: number;
  /** Error-rate threshold as 0-1 (default: 0.1). */
  error_rate?: number;
}

export interface AlertLatencySpikeRuleConfig {
  /** Enable this detector when alerting is enabled (default: true). */
  enabled?: boolean;
  /** Sliding window in seconds (default: 300). */
  window_seconds?: number;
  /** Minimum samples before evaluating (default: 20). */
  min_requests?: number;
  /** p95 latency threshold in milliseconds (default: 10000). */
  p95_ms?: number;
}

// ===== External Log Sinks =====
export type LogSinkType = 'file' | 'webhook' | 's3' | 'elasticsearch';
export type LogSinkOverflowPolicy = 'drop_oldest' | 'drop_newest';

export interface LoggingConfig {
  /** Master switch for local external log sinks (default: false) */
  enabled?: boolean;
  /** External sink list. SQLite/Postgres call_log remains authoritative. */
  sinks?: LogSinkConfig[];
}

export interface LogSinkRetryConfig {
  /** Total delivery attempts, including the first attempt (default: 3). */
  attempts?: number;
  /** Delay between failed attempts in milliseconds (default: 1000). */
  backoff_ms?: number;
  /** Per-attempt HTTP timeout in milliseconds (default: 5000). */
  timeout_ms?: number;
}

export interface BaseLogSinkConfig {
  type: LogSinkType;
  /** Stable name used in logs, stats, and queue state. */
  name?: string;
  /** Disable one sink without deleting it (default: true). */
  enabled?: boolean;
  /** Records delivered per flush (default: 100). */
  batch_size?: number;
  /** Background flush interval in milliseconds (default: 5000). */
  flush_interval_ms?: number;
  /** Per-sink in-memory queue limit (default: 10000). */
  max_queue?: number;
  /** Queue overflow behavior (default: drop_oldest). */
  overflow?: LogSinkOverflowPolicy;
  /** Optional allow-list of output fields. Empty/unset means all safe fields. */
  fields?: string[];
  /** Optional deny-list applied after fields. */
  exclude_fields?: string[];
  /** Delivery retry controls. */
  retry?: LogSinkRetryConfig;
}

export interface FileLogSinkConfig extends BaseLogSinkConfig {
  type: 'file';
  /** JSONL output path. Parent directories are created automatically. */
  path: string;
}

export interface WebhookLogSinkConfig extends BaseLogSinkConfig {
  type: 'webhook';
  url: string;
  /** Optional outbound headers. Values may use environment references. */
  headers?: Record<string, string>;
}

export interface S3LogSinkConfig extends BaseLogSinkConfig {
  type: 's3';
  bucket: string;
  region?: string;
  prefix?: string;
}

export interface ElasticsearchLogSinkConfig extends BaseLogSinkConfig {
  type: 'elasticsearch';
  url: string;
  index: string;
  headers?: Record<string, string>;
}

export type LogSinkConfig =
  | FileLogSinkConfig
  | WebhookLogSinkConfig
  | S3LogSinkConfig
  | ElasticsearchLogSinkConfig;

// ===== Dashboard =====
export interface DashboardConfig {
  /** Explicit customer-kit identity file. Never inferred; incompatible with legacy password/OIDC. */
  identity_file?: string;
  /** Set false only for trusted local/dev networks. Default: true. */
  auth_required?: boolean;
  /** Accept legacy Dashboard JWTs from Authorization Bearer and ?token=. Default: true during migration. */
  allow_legacy_token_auth?: boolean;
  password?: string;
  /** Optional stable JWT secret for Dashboard sessions. May use ${env:SIFTGATE_DASHBOARD_SESSION_SECRET}. */
  session_secret?: string;
  /** Optional generic OIDC login. Disabled by default and runs alongside local password auth. */
  oidc?: DashboardOidcConfig;
}

export interface DashboardOidcConfig {
  /** Enable generic OIDC login for the local Dashboard. */
  enabled?: boolean;
  /** OIDC issuer URL. SiftGate discovers /.well-known/openid-configuration from this issuer. */
  issuer?: string;
  /** OIDC client id. */
  client_id?: string;
  /** Secret reference or literal for the OIDC client secret. Prefer ${env:OIDC_CLIENT_SECRET}. */
  client_secret?: string;
  /** Redirect URI registered with the identity provider. */
  redirect_uri?: string;
  /** Optional email-domain allow-list. Empty means any verified OIDC identity may use the default mapping. */
  allowed_domains?: string[];
  /** Role assigned to first-time OIDC users when no invite is used. Defaults to viewer. */
  default_role?: 'admin' | 'operator' | 'viewer';
  /** Workspace assigned to first-time OIDC users when no invite is used. Defaults to default-workspace. */
  default_workspace_id?: string;
  /** Optional scope override. Defaults to "openid email profile". */
  scopes?: string[];
  /** Timeout for OIDC discovery, token, userinfo, and JWKS calls. Defaults to 10000. */
  timeout_ms?: number;
}

// ===== Server =====
export interface CorsConfig {
  origin: boolean | string | string[];  // false = same-origin only, true = all origins, string[] = whitelist
  credentials?: boolean;                // default: false
}

export interface ServerConfig {
  port: number;
  host: string;
  cors?: CorsConfig;              // default: { origin: false, credentials: false }
  trust_proxy?: boolean | string; // default: false
  body_limit?: string;            // default: '1mb'
  shutdown_timeout_ms?: number;   // default: 5000
  helmet?: boolean;               // default: true
}

// ===== Database =====
export interface DatabaseConfig {
  type: 'sqlite' | 'postgres';
  path?: string; // SQLite file path
  url?: string; // PostgreSQL connection URL
  synchronize?: boolean; // TypeORM schema sync; keep true for local dev, set false in production Postgres
  pool?: {
    max?: number; // PostgreSQL pool max clients (default: 10)
    min?: number; // PostgreSQL pool min clients (default: 0)
    idle_timeout_ms?: number; // PostgreSQL idle client timeout (default: 30000)
    connection_timeout_ms?: number; // PostgreSQL connect timeout (default: 5000)
    statement_timeout_ms?: number; // PostgreSQL statement timeout, 0 disables
    query_timeout_ms?: number; // PostgreSQL client query timeout, 0 disables
    max_uses?: number; // PostgreSQL client recycle count, 0 disables
    application_name?: string; // PostgreSQL pg_stat_activity name
  };
  ssl?:
    | boolean
    | {
        reject_unauthorized?: boolean;
        ca?: string;
        cert?: string;
        key?: string;
        servername?: string;
  };
  log_retention_days?: number; // Auto-delete logs older than N days (default: 30)
  sqlite_synchronous?: 'OFF' | 'NORMAL' | 'FULL' | 'EXTRA'; // SQLite durability mode (default: FULL)
  route_trace_write_behind?: boolean; // Queue full route traces after the response path (default: false)
}

// ===== Auth =====
export interface AuthConfig {
  api_keys: ApiKeyEntry[];
  rate_limit?: RateLimitConfig;
}

export interface ApiKeyBudgetOverride {
  daily_token_limit?: number;   // per-key token limit (unset = no per-key token limit)
  daily_cost_limit?: number;    // per-key cost limit (unset = no per-key cost limit)
  alert_threshold?: number;     // defaults to global alert_threshold
}

export interface ApiKeyEntry {
  key: string;
  name: string;
  namespace_id?: string;
  budget?: ApiKeyBudgetOverride;  // optional per-key budget limits
}

/**
 * Rate limiting configuration.
 * Uses in-memory sliding window counters.
 */
export interface RateLimitConfig {
  /** Max requests per minute per API key (default: 60) */
  requests_per_minute: number;
  /** Max requests per minute per IP when no API key (default: 30) */
  requests_per_minute_ip: number;
  /** Max tracked IPs/keys in sliding-window map (default: 10000, FIFO eviction) */
  max_entries?: number;
  /** Max login attempts per IP per minute (default: 5) */
  login_requests_per_minute?: number;
}

// ===== Local Namespaces (OSS Data Plane) =====
export interface NamespaceBudgetConfig {
  daily_token_limit?: number;
  daily_cost_limit?: number;
  alert_threshold?: number;
}

export interface NamespaceRateLimitConfig {
  requests_per_minute?: number;
}

export interface NamespaceConfig {
  /** Stable local namespace id. This is not a Cloud workspace/org id. */
  id: string;
  name?: string;
  allowed_nodes?: string[];
  allowed_models?: string[];
  budget?: NamespaceBudgetConfig;
  rate_limit?: NamespaceRateLimitConfig;
}

// ===== MCP Gateway Preview =====
export type McpServerTransport = 'http_json_rpc' | 'streamable_http' | 'sse' | 'stdio';

export interface McpToolConfig {
  /** Tool name advertised in Dashboard metadata. */
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
}

export interface McpServerConfig {
  /** Stable local server id used by /mcp/:serverId. */
  id: string;
  name?: string;
  description?: string;
  /** Disable one server without removing it. Default: true. */
  enabled?: boolean;
  /** Upstream MCP HTTP endpoint. Required for HTTP transports. Values may use secret references in headers, not URL query secrets. */
  url?: string;
  /** Preview supports HTTP JSON-RPC, Streamable HTTP, legacy HTTP+SSE, and local stdio MCP process forwarding. Default: http_json_rpc. */
  transport?: McpServerTransport;
  /** Optional outbound headers. Values may use runtime secret references. */
  headers?: Record<string, string>;
  /** Optional legacy HTTP+SSE message endpoint. When omitted, SiftGate waits for the upstream endpoint event. */
  message_url?: string;
  /** Stdio MCP command, for example uvx. Required when transport is stdio. */
  command?: string;
  /** Stdio MCP command arguments. Values may use runtime secret references. */
  args?: string[];
  /** Optional stdio MCP process environment. Values may use runtime secret references. */
  env?: Record<string, string>;
  /** Extra parent environment variable names to pass to stdio MCP processes. */
  env_allowlist?: string[];
  /** Legacy escape hatch to pass the full parent environment. Default: false. */
  inherit_env?: boolean;
  /** Optional stdio MCP process working directory. */
  cwd?: string;
  /** Optional namespace allow-list. Empty/unset allows all namespaces. */
  allowed_namespaces?: string[];
  /** Optional static tool metadata for Dashboard. Tool inputs/outputs are never stored by default. */
  tools?: McpToolConfig[];
  timeout_ms?: number;
  max_request_bytes?: number;
  tags?: string[];
}

export interface McpGatewayConfig {
  /** Master switch. Disabled by default because MCP proxying is experimental. */
  enabled?: boolean;
  /** Local proxy prefix. Default: /mcp. */
  path?: string;
  /** Registered local MCP upstreams. */
  servers?: McpServerConfig[];
  /** Recent metadata-only audit entries kept in memory for Dashboard. Default: 100. */
  max_recent_calls?: number;
}

// ===== Shadow Traffic =====
export interface ShadowTrafficCompareConfig {
  /** Store sanitized prompt/input samples for comparison. Default: false. */
  store_prompts?: boolean;
  /** Store sanitized response samples for comparison. Default: false. */
  store_responses?: boolean;
  /** Maximum stored sample characters after built-in redaction. Default: 4000. */
  sample_max_chars?: number;
}

export interface ShadowTrafficConfig {
  /** Master switch. Disabled by default. */
  enabled?: boolean;
  /** 0-1 fraction of eligible successful requests to mirror. Default: 0. */
  sample_rate?: number;
  /** Test node that receives shadow traffic asynchronously. */
  target_node?: string;
  /** Optional target model. Defaults to the primary response/request model. */
  target_model?: string;
  /** Per-shadow request timeout. Default: target node timeout. */
  timeout_ms?: number;
  /** Recent result rows retained for Dashboard. Default: 100. */
  max_recent_results?: number;
  /** Explicit comparison storage opt-in. Defaults keep prompt/response out. */
  compare?: ShadowTrafficCompareConfig;
}

// ===== Node (AI Provider) =====
export type NodeProtocol = 'chat_completions' | 'responses' | 'messages' | 'gemini';

export type AuthType = 'bearer' | 'x-api-key' | 'custom-header';

export type QueuePolicy = 'wait' | 'fallback' | 'reject';

export type HealthCheckMethod = 'HEAD' | 'GET' | 'POST';

export type CredentialPoolStrategy =
  | 'least_in_flight'
  | 'weighted_round_robin'
  | 'cache_aware';

export type CredentialStickyBy =
  | 'none'
  | 'agent_session'
  | 'api_key'
  | 'team'
  | 'namespace';

export interface NodeCredentialConfig {
  /** Stable label for observability. The secret value is never logged or returned by Dashboard APIs. */
  id: string;
  /** Provider API key or secret reference for this credential. */
  api_key: string;
  /** Relative selection weight. Defaults to 1. */
  weight?: number;
  /** Disable a credential without deleting it. Defaults to true. */
  enabled?: boolean;
}

export interface CredentialPoolConfig {
  /** Enables multi-credential selection for this node. Defaults to true when credentials are configured. */
  enabled?: boolean;
  /** Selection strategy. Defaults to least_in_flight. */
  strategy?: CredentialPoolStrategy;
  /** Optional affinity key for reducing provider-side session churn. Defaults to agent_session. */
  sticky_by?: CredentialStickyBy;
  /** Cooldown duration after retryable failures. Defaults to 60000. */
  cooldown_ms?: number;
  /** Consecutive retryable failures before a credential is considered unhealthy. Defaults to 3. */
  max_failures?: number;
  /** HTTP statuses that trigger another credential attempt inside the same node. */
  retry_on_status?: number[];
}

export interface ModelCapabilityConfig {
  /** Explicit modalities supported by this model. "vision" remains supported as the legacy image-input alias. */
  modalities?: Modality[];
  /** Endpoint paths or absolute URLs used by future protocol-specific provider calls. */
  endpoints?: Partial<Record<CapabilityEndpoint, string>>;
  /** Input media/data types accepted by this model. */
  input_types?: CapabilityIOType[] | string[];
  /** Output media/data types emitted by this model. */
  output_types?: CapabilityIOType[] | string[];
  /** Maximum accepted uploaded or inline file size in bytes. */
  max_file_size?: number;
  /** Whether this model supports streaming responses. */
  supports_streaming?: boolean;
  /** Whether this model supports realtime sessions/events. */
  supports_realtime?: boolean;
  /** Whether this model supports rerank requests. */
  supports_rerank?: boolean;
  /** Whether this model supports explicit reasoning/thinking controls. */
  supports_reasoning?: boolean;
  /** Whether this model/provider supports prompt caching in any form. */
  prompt_cache?: boolean;
  /** Whether this model/provider can read previously cached prompt tokens. */
  read_cache?: boolean;
  /** Whether this model/provider can write prompt/context tokens into provider cache. */
  write_cache?: boolean;
  /** Maximum total context window for this model, including input and reserved output tokens. */
  max_context_tokens?: number;
  /** Whether this model should be considered safe for structured output requests. */
  structured_output?: boolean;
  /** Supported embedding output dimensions for embedding models. */
  dimensions?: number | number[];
  /** Optional per-node/model pricing override used by routing and cost accounting. */
  pricing?: ModelPricing;
  /** Optional operator-supplied quality hint; higher values win for optimization: quality. */
  quality_score?: number;
}

export interface NodeHealthCheckConfig {
  /** Enable active background probes for this node (default: false) */
  enabled?: boolean;
  /** Probe interval in seconds (default: 30) */
  interval_seconds?: number;
  /** Probe timeout in milliseconds (default: min(node.timeout_ms, 5000)) */
  timeout_ms?: number;
  /** Probe HTTP method (default: POST when lightweight_model is set, otherwise HEAD) */
  method?: HealthCheckMethod;
  /** Probe path relative to base_url (default: node.endpoint) */
  path?: string;
  /** Optional cheap model to probe with a synthetic 1-token request */
  lightweight_model?: string;
}

export interface NodeConnectionConfig {
  /** Enable undici per-node pooling when this block is present (default: true). */
  enabled?: boolean;
  /** Keep upstream sockets alive between requests (default: true). */
  keep_alive?: boolean;
  /** Maximum open upstream sockets for this node (default: 10). */
  pool_size?: number;
  /** Idle keep-alive timeout in milliseconds (default: 60000). */
  keep_alive_ms?: number;
  /** Timeout while waiting for upstream response headers in milliseconds. */
  headers_timeout_ms?: number;
  /** Timeout between upstream response body chunks in milliseconds; 0 disables. */
  body_timeout_ms?: number;
  /** Maximum total duration for one upstream stream in milliseconds; 0 disables. */
  stream_max_duration_ms?: number;
  /** Experimental HTTP/2 ALPN support through undici allowH2 (default: false). */
  http2?: boolean;
}

export interface NodeRequestCompatibilityConfig {
  /**
   * Some Anthropic-compatible upstreams only accept string content inside
   * tool_result blocks. The default "native" keeps Anthropic content blocks.
   */
  messages_tool_result_content?: 'native' | 'string';
  /**
   * Some OpenAI-compatible upstreams strictly validate historical tool-call
   * ordering. The default "native" keeps chat tool messages unchanged.
   */
  chat_tool_messages?: 'native' | 'stringify_as_user' | 'drop';
  /** Request body fields to omit before forwarding to this upstream node. */
  drop_parameters?: string[];
  /** Request body fields to add when the client did not provide them; plain objects merge by missing nested keys. */
  default_parameters?: Record<string, unknown>;
}

export interface NodeConfig {
  /** Explicit operator switch. Distinct from the ignored pre-Launchpad enabled field. */
  disabled?: boolean;
  id: string;
  name: string;
  protocol: NodeProtocol;
  base_url: string;
  endpoint: string;
  api_key?: string;
  /** Optional pool of upstream credentials used by the provider client before node-level fallback. */
  credentials?: NodeCredentialConfig[];
  credential_pool?: CredentialPoolConfig;
  auth_type?: AuthType; // Default: 'bearer' for chat_completions/responses, 'x-api-key' for messages
  /** Header name used when auth_type=custom-header. The api_key value is inserted into this header. */
  auth_header_name?: string;
  /** Optional prefix added before api_key when auth_type=custom-header, for example "Bearer". */
  auth_header_prefix?: string;
  models: string[];
  /**
   * Optional mapping from SiftGate-facing model IDs to upstream provider model IDs.
   * Use this when the public route name must be unique or client-compatible, but
   * the provider expects a different model value in the forwarded request body.
   *
   * Example:
   *   models: ["claude-opus-4-7-ada"]
   *   upstream_model_aliases:
   *     claude-opus-4-7-ada: claude-opus-4-7
   */
  upstream_model_aliases?: Record<string, string>;
  /** Optional OpenAI-compatible embeddings endpoint path (default: /v1/embeddings). */
  embeddings_endpoint?: string;
  /** Embedding-capable model IDs exposed by this node. */
  embedding_models?: string[];
  /** Optional OpenAI/common-compatible rerank endpoint path (default: /v1/rerank). */
  rerank_endpoint?: string;
  /** Rerank-capable model IDs exposed by this node. */
  rerank_models?: string[];
  /** Optional OpenAI-compatible image generation endpoint path (default: /v1/images/generations). */
  images_generations_endpoint?: string;
  images_status_endpoint?: string;
  images_content_endpoint?: string;
  images_cancel_endpoint?: string;
  /** Optional OpenAI-compatible image edit endpoint path (default: /v1/images/edits). */
  images_edits_endpoint?: string;
  /** Optional OpenAI-compatible image variation endpoint path (default: /v1/images/variations). */
  images_variations_endpoint?: string;
  /** Image-capable model IDs exposed by this node. */
  image_models?: string[];
  /** Optional OpenAI-compatible audio transcription endpoint path (default: /v1/audio/transcriptions). */
  audio_transcriptions_endpoint?: string;
  /** Optional OpenAI-compatible audio translation endpoint path (default: /v1/audio/translations). */
  audio_translations_endpoint?: string;
  /** Optional OpenAI-compatible text-to-speech endpoint path (default: /v1/audio/speech). */
  audio_speech_endpoint?: string;
  /** Audio-capable model IDs exposed by this node. */
  audio_models?: string[];
  /** Optional OpenAI-compatible video generation endpoint path reserved for video-capable providers. */
  video_generations_endpoint?: string;
  /** Experimental video generation endpoint path (default: /v1/videos/generations). */
  video_endpoint?: string;
  /** Optional endpoint path for async video job status lookups. */
  video_status_endpoint?: string;
  /** Explicit versioned interpretation of video results; existing tasks retain their pinned profile. */
  video_result_profile?: VideoResultProfile;
  /** Optional endpoint path for async video content retrieval. */
  video_content_endpoint?: string;
  /** Optional endpoint path for async video job cancellation. */
  video_cancel_endpoint?: string;
  /** Video-capable model IDs exposed by this node. */
  video_models?: string[];
  /** Optional OpenAI-compatible batch creation endpoint path (default: /v1/batches for compatible nodes). */
  batch_endpoint?: string;
  /** Optional endpoint path for batch status lookups. */
  batch_status_endpoint?: string;
  /** Optional endpoint path for batch cancellation. */
  batch_cancel_endpoint?: string;
  /** Optional endpoint path for batch output/error file content download. */
  batch_result_endpoint?: string;
  /** Experimental OpenAI-compatible realtime WebSocket endpoint path (default: /v1/realtime). */
  realtime_endpoint?: string;
  /** Realtime-capable model IDs exposed by this node. */
  realtime_models?: string[];
  timeout_ms: number;
  max_concurrency?: number; // Optional per-node upstream concurrency limit
  queue_timeout_ms?: number; // Default: 10000 when max_concurrency is set
  queue_policy?: QueuePolicy; // wait (default) | fallback | reject
  headers?: Record<string, string>;
  health_check?: NodeHealthCheckConfig;
  /** Optional per-node upstream HTTP connection pooling and timeout controls. */
  connection?: NodeConnectionConfig;
  /** Optional per-node request shape compatibility overrides. */
  request_compatibility?: NodeRequestCompatibilityConfig;
  /** Node-level default context window used when a model-specific value is omitted. */
  max_context_tokens?: number;
  /** Node-level default structured-output support flag. */
  structured_output?: boolean;
  /** Node-level default multimodal capability declarations. */
  endpoints?: Partial<Record<CapabilityEndpoint, string>>;
  input_types?: CapabilityIOType[] | string[];
  output_types?: CapabilityIOType[] | string[];
  max_file_size?: number;
  supports_streaming?: boolean;
  supports_realtime?: boolean;
  supports_rerank?: boolean;
  supports_reasoning?: boolean;
  /** Node-level default provider prompt-cache support flag. */
  prompt_cache?: boolean;
  /** Node-level default provider prompt-cache read support flag. */
  read_cache?: boolean;
  /** Node-level default provider prompt-cache write support flag. */
  write_cache?: boolean;
  /** Optional per-model capability and pricing metadata. Keys are model IDs. */
  model_capabilities?: Record<string, ModelCapabilityConfig>;
  /** Optional explicit compatibility profile override. Defaults are inferred from Provider Catalog/provider identity. */
  compatibility_profile?: string | string[];

  /**
   * Structured capability tags — describe what this node is good at.
   * Used for tier recommendation and routing suggestions.
   *
   * Valid capability IDs:
   *   coding, coding_frontend, coding_backend, reasoning, analysis,
   *   creative, long_context, tool_use, fast, multilingual, vision
   *
   * Example: capabilities: ["coding", "coding_backend", "reasoning"]
   */
  capabilities?: string[];

  /**
   * Explicitly declare which modalities this node supports.
   * When set, this takes highest priority over model-name inference and capability fallback.
   *
   * Valid modalities: "text", "vision", "image", "audio", "video", "embedding", "rerank", "realtime"
   * "vision" is kept for backwards compatibility and is treated as compatible with "image".
   *
   * If omitted, modalities are inferred from model names or capabilities.
   * Unknown models default to ["text"] (text-only).
   *
   * Example: modalities: ["text", "vision"]
   */
  modalities?: Modality[];

  /**
   * Free-text tags — describe what this node is good at.
   * Used by domain-hint routing to prefer nodes matching the request domain.
   * If `capabilities` is not set, capabilities are inferred from tags.
   *
   * Common tags:
   *   frontend, backend, reasoning, creative, fast, cheap,
   *   code, math, multilingual, vision, long-context
   *
   * Example: tags: ["backend", "reasoning", "code"]
   */
  tags?: string[];

  /**
   * Model aliases — user-friendly short names that map to actual model IDs.
   * Allows users to send e.g. "claude" instead of "claude-opus-4-6-v1".
   *
   * Users can also send arbitrary model names using the "nodeId/model" prefix syntax
   * (e.g. "claude/my-fine-tuned-model") without needing to register them here.
   * The gateway will route to the correct node and pass the model name through.
   *
   * Example:
   *   model_aliases:
   *     claude: claude-opus-4-6-v1
   *     opus: claude-opus-4-6-v1
   */
  model_aliases?: Record<string, string>;

  /**
   * Model pass-through prefixes handled by this node.
   * Use this when the node id is a stable provider/channel id (e.g. "anthropic-prod")
   * but clients should still be able to direct-route model families like
   * "claude-sonnet-..." without registering every future model id.
   *
   * Example:
   *   model_prefixes: ["claude"]
   */
  model_prefixes?: string[];
}

// ===== Routing =====
export interface RoutingConfig {
  tiers: Record<string, TierConfig>;
  scoring: ScoringThresholds;
  retry?: RetryConfig;
  /** Optional v0.3 same-capability optimization mode for automatic routing. */
  optimization?: RoutingOptimization;
  /** Optional v0.3 fallback trigger policies. */
  fallback_policy?: FallbackPolicyConfig;
  /** Optional provider-cache session affinity bonus for cache-aware routing. */
  cache_affinity?: CacheAffinityRoutingConfig;
  /** Optional per-model circuit breaker tuning. */
  circuit_breaker?: CircuitBreakerRoutingConfig;

  /**
   * Domain-based node preference.
   * Maps a domain hint (from scoring) → ordered list of preferred node IDs.
   *
   * When a request is scored with a domain hint (e.g. "frontend"),
   * the routing engine reorders available nodes to prefer those listed here.
   *
   * Example:
   *   domain_preferences:
   *     frontend: [gemini, gpt]
   *     backend: [claude, gpt]
   *     math: [claude]
   *     creative: [gpt, gemini]
   *
   * If not configured, nodes with matching tags are auto-preferred.
   */
  domain_preferences?: Record<string, string[]>;
}

export interface CircuitBreakerRoutingConfig {
  /**
   * Set false to keep every target routable regardless of its failure history.
   * Defaults to true.
   */
  enabled?: boolean;
  /** Consecutive failures before a node+model circuit opens. Defaults to 3. */
  failure_threshold?: number;
  /** Time a circuit stays OPEN before allowing a probe. Defaults to 30000. */
  cooldown_ms?: number;
  /** Probe requests allowed while HALF_OPEN. Defaults to 1. */
  half_open_max?: number;
}

export interface CacheAffinityRoutingConfig {
  /** Enable session-level provider-cache affinity (default: true). */
  enabled?: boolean;
  /** Consecutive same-target successes required before affinity can activate. */
  min_consecutive_hits?: number;
  /** Bonus weight applied to the matching candidate during cache-aware routing. */
  bonus_weight?: number;
  /** Safety multiplier applied to provider cache TTL before affinity expires. */
  ttl_safety_margin?: number;
}

/**
 * v0.3 fallback policy controls.
 * Defaults are conservative: existing retry/fallback behavior is preserved unless
 * a policy is explicitly enabled.
 */
export interface FallbackPolicyConfig {
  /** Skip same-node retries on HTTP 429 and immediately try the next fallback. */
  immediate_429?: boolean;
  /** Timeout-driven fallback behavior for upstream calls. */
  timeout?: TimeoutFallbackConfig;
  /** Validate structured-output responses and fallback on invalid JSON/schema. */
  structured_output?: StructuredOutputFallbackConfig;
  /** Downgrade to a cheaper fallback before calling upstream when estimated cost is high. */
  cost_downgrade?: CostDowngradeFallbackConfig;
}

export interface TimeoutFallbackConfig {
  /** Enable timeout fallback (default: false). */
  enabled?: boolean;
  /** Per-upstream attempt timeout before falling back. Defaults to the node timeout. */
  threshold_ms?: number;
  /**
   * Start the first fallback while the primary is still running after threshold_ms.
   * Disabled by default because it can create extra provider cost.
   */
  race_fallback?: boolean;
}

export interface StructuredOutputFallbackConfig {
  /** Enable structured-output parse/schema validation (default: false). */
  enabled?: boolean;
  /** Fallback when JSON parsing fails (default: true). */
  fallback_on_parse_error?: boolean;
  /** Fallback when a simple JSON schema check fails (default: true). */
  fallback_on_schema_error?: boolean;
}

export interface CostDowngradeFallbackConfig {
  /** Enable pre-upstream cost downgrade (default: false). */
  enabled?: boolean;
  /** Estimated request cost threshold in USD. Required when enabled. */
  max_estimated_cost_usd?: number;
}

// ===== Intelligence Loop =====
export type IntelligenceBudgetPolicy = 'observe' | 'reject' | 'downgrade';
export type IntelligenceOptimizerAction = 'evidence_only' | 'optimize';
export type IntelligenceOptimizerObjective = 'cost' | 'balanced' | 'latency' | 'quality';
export type IntelligenceQualityGateAction = 'retry' | 'fallback' | 'alert';

export interface IntelligenceConfig {
  /** Real-time cost optimizer v1. Defaults to metadata-only evidence when enabled. */
  cost_optimizer?: IntelligenceCostOptimizerConfig;
  /** Pre-upstream token/cost risk prediction. Safe by default: observe only. */
  token_prediction?: IntelligenceTokenPredictionConfig;
  /** Async eval metadata queue. Never stores prompts/responses unless other explicit eval sample controls do. */
  async_eval?: IntelligenceAsyncEvalConfig;
  /** Opt-in quality gates for critical non-streaming routes. Disabled by default. */
  quality_gate?: IntelligenceQualityGateConfig;
}

export interface IntelligenceCostOptimizerConfig {
  enabled?: boolean;
  action?: IntelligenceOptimizerAction;
  objective?: IntelligenceOptimizerObjective;
  history_window_hours?: number;
  min_samples?: number;
  min_savings_ratio?: number;
  max_latency_penalty_ratio?: number;
  max_quality_penalty?: number;
  allow_quality_critical_downgrade?: boolean;
}

export interface IntelligenceTokenPredictionConfig {
  enabled?: boolean;
  budget_policy?: IntelligenceBudgetPolicy;
  near_limit_ratio?: number;
  allow_quality_critical_downgrade?: boolean;
}

export interface IntelligenceAsyncEvalConfig {
  enabled?: boolean;
  sample_rate?: number;
  dimensions?: string[];
  metadata_only?: boolean;
  max_recent_jobs?: number;
}

export interface IntelligenceQualityGateConfig {
  enabled?: boolean;
  rules?: IntelligenceQualityGateRuleConfig[];
}

export interface IntelligenceQualityGateRuleConfig {
  id: string;
  enabled?: boolean;
  source_formats?: SourceFormat[];
  tiers?: Tier[];
  models?: string[];
  agent_virtual_models?: string[];
  require_text?: boolean;
  min_output_tokens?: number;
  fail_on_stop_reasons?: string[];
  max_latency_ms?: number;
  actions?: IntelligenceQualityGateAction[];
}

/**
 * Retry configuration for upstream provider calls.
 * Controls how the gateway retries failed requests before moving to the next fallback.
 */
export interface RetryConfig {
  /** Max retries per node (default: 0 = no retry, only fallback) */
  max_retries: number;
  /** Initial backoff delay in ms (default: 500) */
  backoff_base_ms: number;
  /** Maximum backoff delay in ms (default: 5000) */
  backoff_max_ms: number;
  /** HTTP status codes eligible for retry (default: [429, 502, 503]) */
  retryable_status: number[];
}

export interface SplitVariant {
  node: string;
  model: string;
  weight: number;      // 1-100, all variants in a tier must sum to 100
  name?: string;       // optional alias (e.g. "control", "challenger"), defaults to "node:model"
}

export type LoadBalancingStrategy = 'weighted' | 'round_robin' | 'least_latency' | 'random';

export type RoutingOptimization = 'cost' | 'latency' | 'balanced' | 'quality';

export interface WeightedRouteTarget extends RouteTarget {
  weight?: number;      // used by weighted strategy; defaults to 1
  name?: string;        // optional display label
}

export interface TierConfig {
  /** Legacy schema: still supported and used when targets is omitted. */
  primary?: RouteTarget;
  fallbacks?: RouteTarget[];
  /** New unified load-balancing schema. Ignored while split is configured. */
  strategy?: LoadBalancingStrategy;
  targets?: WeightedRouteTarget[];
  split?: SplitVariant[];  // A/B testing: when set, overrides primary/fallbacks with weighted routing
}

export interface RouteTarget {
  node: string;
  model: string;
}

export interface ScoringThresholds {
  simple_max: number;
  standard_max: number;
  complex_max: number;
  // anything above complex_max → reasoning

  /**
   * Override default dimension weights.
   * Keys match dimension names: simpleIndicators, codeGeneration, codeFrontend,
   * codeBackend, formalLogic, technicalTerms, multiStep, analyticalReasoning,
   * tokenCount, toolCount, conversationDepth, constraintDensity, expectedOutputLength, codeToProse.
   *
   * Example: { formalLogic: 0.15, codeGeneration: 0.12 }
   */
  weights?: Record<string, number>;

  /**
   * Custom keywords to inject into existing dimension tries.
   * Each entry adds keywords to the specified dimension's trie.
   *
   * Example:
   *   custom_keywords:
   *     - pattern: "kubernetes|k8s|helm"
   *       dimension: codeBackend
   *       weight: 1.0
   *     - pattern: "legal|contract|compliance"
   *       dimension: analyticalReasoning
   *       weight: 1.0
   */
  custom_keywords?: CustomKeywordEntry[];
}

export interface CustomKeywordEntry {
  /** Pipe-separated keywords: "keyword1|keyword2|keyword3" */
  pattern: string;
  /** Target dimension name */
  dimension: string;
  /** Weight for these keywords (default: 1.0) */
  weight?: number;
}

// ===== Budget =====
export interface BudgetConfig {
  daily_token_limit: number;
  daily_cost_limit: number;
  alert_threshold: number;
}

// ===== Cache =====
export interface CacheConfig {
  /** Master switch (default: false) */
  enabled: boolean;
  /** Cache TTL in seconds (default: 300 = 5 minutes) */
  ttl_seconds: number;
  /** Max cache entries, LRU eviction (default: 1000) */
  max_entries: number;
  /** Skip caching responses with tool_use stop reason (default: true) */
  exclude_tool_use: boolean;
  /** Explicit stream-cache controls. Disabled by default even when cache.enabled=true. */
  stream_cache?: StreamCacheConfig;
}

export interface StreamCacheConfig {
  /** Cache and replay completed stream responses as SSE (default: false). */
  enabled?: boolean;
}

// ===== Semantic Cache Preview =====
export interface SemanticCacheConfig {
  /** Master switch (default: false). */
  enabled?: boolean;
  /** First preview supports local memory by default; redis/vector are reserved optional backends. */
  backend?: 'memory' | 'redis' | 'vector';
  /** Cosine similarity threshold for a metadata match. Default 0.92. */
  similarity_threshold?: number;
  /** Entry TTL in seconds. Default 3600. */
  ttl_seconds?: number;
  /** Max local entries before LRU eviction. Default 500. */
  max_entries?: number;
  /** Hashing-vector dimensions. Default 256. */
  vector_dimensions?: number;
  /** Explicitly store replayable responses. Default false for privacy. */
  store_responses?: boolean;
  /** Maximum serialized response bytes when store_responses=true. Default 65536. */
  max_response_bytes?: number;
  /** Optional explicit isolation level. Default: workspace_api_key_model. */
  isolation?: 'workspace_api_key_model' | 'workspace_model' | 'workspace';
  /** Require an explicit per-request opt-in header for response replay. Default true. */
  response_storage_requires_header?: boolean;
}

// ===== Semantic Platform =====
export type ContextOptimizerStrategy = 'metadata_only' | 'trim' | 'summarize';
export type SemanticIntentCategory =
  | 'coding'
  | 'task'
  | 'security'
  | 'reasoning'
  | 'creative'
  | 'multimodal'
  | 'analysis'
  | 'general';

export interface SemanticPlatformConfig {
  enabled?: boolean;
  prompt_registry?: PromptRegistryConfig;
  context_optimizer?: ContextOptimizerConfig;
  intent_classification?: IntentClassificationConfig;
  guardrails_v2?: GuardrailsV2Config;
}

export interface PromptRegistryConfig {
  /** Enable workspace-scoped prompt template metadata. Default false. */
  enabled?: boolean;
  /** Persist template body only by explicit opt-in. Default false stores hash+metadata only. */
  store_template_content?: boolean;
  /** Retained versions per prompt key. Default 20. */
  max_versions_per_key?: number;
}

export interface ContextOptimizerConfig {
  enabled?: boolean;
  /** Default metadata-only keeps request text unchanged and records evidence only. */
  strategy?: ContextOptimizerStrategy;
  /** Trigger when estimated context exceeds this ratio of selected model context window. Default 0.8. */
  max_context_ratio?: number;
  /** Allow request mutation for trim/summarize strategies. Default false. */
  allow_content_mutation?: boolean;
}

export interface IntentClassificationConfig {
  enabled?: boolean;
  categories?: SemanticIntentCategory[];
  /** Minimum confidence before intent is used as route evidence. Default 0.5. */
  min_confidence?: number;
}

export interface GuardrailsV2Config {
  enabled?: boolean;
  input?: GuardrailsV2PolicyConfig;
  output?: GuardrailsV2PolicyConfig;
  metadata_only?: boolean;
}

export interface GuardrailsV2PolicyConfig {
  enabled?: boolean;
  pii?: boolean;
  toxicity?: boolean;
  jailbreak?: boolean;
  action?: 'observe' | 'block' | 'alert';
}

// ===== Evaluation Framework =====
export interface EvaluationConfig {
  /** Enable local experiment execution helpers. Dashboard reports remain read-only. */
  enabled?: boolean;
  /** Store redacted sample prompt/response previews. Default false. */
  store_samples?: boolean;
  /** Maximum characters retained per redacted preview when store_samples=true. */
  max_sample_chars?: number;
  /** Default judge model used by local runners when omitted. */
  judge_model?: string;
  /** Default judge prompt rubric. Stored as a hash in run metadata. */
  judge_rubric?: string;
  /** Retain evaluation metadata for this many days. Default follows DB retention. */
  retention_days?: number;
}

// ===== Model Pricing =====
export interface ModelPricing {
  input: number; // cost per 1M input tokens (USD)
  output: number; // cost per 1M output tokens (USD)
  cache_creation_input?: number; // cost per 1M cache-write tokens (e.g. Anthropic: 1.25x input)
  cache_read_input?: number;     // cost per 1M cache-read tokens (e.g. Anthropic: 0.1x input; OpenAI: 0.5x)
  billing_unit?: string;
  input_per_1m_tokens?: number;
  output_per_1m_tokens?: number;
  cache_read_per_1m_tokens?: number;
  cache_write_per_1m_tokens?: number;
  embedding_per_1m_tokens?: number;
  rerank_per_1k_requests?: number;
  rerank_per_1k_docs?: number;
  image_per_generation?: number;
  image_per_edit?: number;
  audio_per_minute?: number;
  audio_per_1m_chars?: number;
  video_per_second?: number;
  video_per_generation?: number;
  realtime_per_minute?: number;
  batch_discount?: number;
  source?: string;
  source_type?: string;
  source_url?: string;
  currency?: string;
  catalog_source?: string;
  pricing_used_from?: string;
  manual_review_required?: boolean;
  review_reason?: string;
  pricing_confidence?: string;
  pricing_stale?: boolean;
  last_updated?: string;
  last_verified_at?: string;
  retrieved_at?: string;
  stale_after_days?: number;
  missing_price_units?: string[];
}

// ===== Embedding Batching =====
export interface EmbeddingBatchingConfig {
  /** Master switch (default: false). */
  enabled?: boolean;
  /** Short collection window before dispatching a merged upstream batch. */
  window_ms?: number;
  /** Maximum upstream input items per merged batch. */
  max_batch_size?: number;
  /** Only requests with this many input items or fewer are batched. */
  max_input_items?: number;
  /** Maximum queued embedding requests across local in-memory batches. */
  max_queue?: number;
  /** Per-request queue/dispatch timeout. */
  timeout_ms?: number;
}

// ===== Experimental Realtime Preview =====
export interface RealtimeConfig {
  /** Master switch for the experimental WebSocket proxy. Disabled by default. */
  enabled?: boolean;
  /** Local WebSocket path exposed by the gateway (default: /v1/realtime). */
  path?: string;
  /** Maximum concurrent realtime client connections across this gateway instance. */
  max_connections?: number;
  /** Maximum concurrent realtime connections to a single upstream node. */
  max_connections_per_node?: number;
  /** Close idle client/upstream sessions after this many milliseconds. */
  idle_timeout_ms?: number;
  /** Timeout while opening the upstream realtime WebSocket. */
  upstream_connect_timeout_ms?: number;
  /** Hard cap for a realtime session lifetime. */
  max_session_ms?: number;
  /** Optional default node used when model=auto or no model is supplied. */
  default_node?: string;
  /** Optional default realtime model used when model=auto or no model is supplied. */
  default_model?: string;
}

// ===== Telemetry (OpenTelemetry) =====
export interface TelemetryConfig {
  /** Master switch — when false (default), SDK is not initialized, all calls are no-op */
  enabled: boolean;
  /** OTel service name (default: 'siftgate') */
  service_name?: string;
  /** Trace export configuration */
  traces?: {
    /** OTLP endpoint for traces (default: 'http://localhost:4318/v1/traces') */
    endpoint?: string;
    /** Sampling rate 0.0–1.0 (default: 1.0 = sample everything) */
    sample_rate?: number;
  };
  /** Metrics export configuration */
  metrics?: {
    /** Port for Prometheus scrape endpoint (default: 9464) */
    prometheus_port?: number;
    /** Optional OTLP endpoint for metrics push */
    otlp_endpoint?: string;
  };
}

// ===== Hosted Control Plane (Connected Gateway) =====
export interface ControlPlaneTelemetryConfig {
  /** Batch upload interval in seconds (default: 30) */
  upload_interval_seconds?: number;
  /** Never enabled by default. Reserved for explicit enterprise opt-in. */
  include_prompt?: boolean;
  /** Never enabled by default. Reserved for explicit enterprise opt-in. */
  include_response?: boolean;
}

export interface ControlPlaneConfig {
  /** Master switch. When false/omitted, the gateway never contacts a control plane. */
  enabled?: boolean;
  /** Hosted control-plane base URL, e.g. https://cloud.example.com */
  url?: string;
  /** Stable local gateway identifier shown in the hosted fleet view. */
  gateway_id?: string;
  /** One-time or long-lived registration token issued by the hosted control plane. */
  registration_token?: string;
  /** Metadata upload privacy and batching settings. */
  telemetry?: ControlPlaneTelemetryConfig;
}

import { VIDEO_RESULT_PROFILES } from "../pricing/video-result-profile.types";
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import type { GatewayConfig } from './gateway.config';
import { pricingLimitsIssues } from './pricing-limits';
import { ALERT_EVENTS as CONNECTOR_EVENTS, CONNECTOR_TYPES, validateChannel } from '../alerts/alert-connector-runtime';
import { buildNodeModelDiagnostics } from './config-diagnostics';
import {
  assessCatalogPricing,
  catalogModelToModelPricing,
  findCatalogProviderForNode,
  findCatalogModel,
  findCatalogModelForNode,
  flattenCatalogModels,
  loadMergedCatalog,
} from '../catalog/catalog.service';
import type { CatalogIssue, ProviderCatalog } from '../catalog/catalog.types';
import {
  compatibilityProfileSupportsModality,
  compatibilityProfileSupportsSourceFormat,
  getCompatibilityProfile,
  isCompatibilityProfileId,
  resolveNodeCompatibilityProfiles,
} from '../catalog/compatibility-profiles';
import {
  VALID_CAPABILITY_ENDPOINTS,
  VALID_CAPABILITY_IO_TYPES,
  VALID_MODALITIES,
} from './modality';
import { diagnoseNodeAgainstCatalog } from '../catalog/provider-catalog.service';
import {
  SecretReferenceBackend,
  scanSecretReferences,
} from './secret-references';

export type ConfigValidationSeverity = 'error' | 'warning' | 'info';

export interface ConfigValidationIssue {
  severity: ConfigValidationSeverity;
  code: string;
  message: string;
  path?: string;
}

export interface ConfigValidationResult {
  configPath: string;
  ok: boolean;
  issues: ConfigValidationIssue[];
  errors: ConfigValidationIssue[];
  warnings: ConfigValidationIssue[];
  info: ConfigValidationIssue[];
  config?: GatewayConfig;
}

export interface ValidateConfigFileOptions {
  configPath?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface ValidateConfigObjectOptions {
  configPath?: string;
  env?: NodeJS.ProcessEnv;
  catalog?: ProviderCatalog;
  catalogIssues?: CatalogIssue[];
}

const DEFAULT_CONFIG_FILE = 'gateway.config.yaml';
const NODE_PROTOCOLS = new Set(['chat_completions', 'responses', 'messages', 'gemini']);
const CREDENTIAL_POOL_STRATEGIES = new Set(['least_in_flight', 'weighted_round_robin', 'cache_aware']);
const CREDENTIAL_STICKY_MODES = new Set(['none', 'agent_session', 'api_key', 'team', 'namespace']);
const LOAD_BALANCING_STRATEGIES = new Set(['weighted', 'round_robin', 'least_latency', 'random']);
const ROUTING_OPTIMIZATIONS = new Set(['cost', 'latency', 'balanced', 'quality']);
const ALERT_EVENTS = new Set([
  ...CONNECTOR_EVENTS,
  'budget_threshold',
  'budget_exceeded',
  'node_down',
  'node_recovered',
  'circuit_open',
  'circuit_close',
  'error_spike',
  'latency_spike',
  'quality_gate_failed',
  'cost_anomaly',
]);
const LOG_SINK_TYPES = new Set(['file', 'webhook', 's3', 'elasticsearch']);
const LOG_SINK_OVERFLOW_POLICIES = new Set(['drop_oldest', 'drop_newest']);
const STATE_BACKENDS = new Set(['memory', 'redis']);
const STATE_UNAVAILABLE_POLICIES = new Set(['fail_open', 'fail_closed']);
const WORKSPACE_ROLES = new Set(['admin', 'operator', 'viewer']);
const INTELLIGENCE_BUDGET_POLICIES = new Set(['observe', 'reject', 'downgrade']);
const INTELLIGENCE_OPTIMIZER_ACTIONS = new Set(['evidence_only', 'optimize']);
const INTELLIGENCE_OBJECTIVES = new Set(['cost', 'balanced', 'latency', 'quality']);
const INTELLIGENCE_QUALITY_GATE_ACTIONS = new Set(['retry', 'fallback', 'alert']);
const INTELLIGENCE_SOURCE_FORMATS = new Set([
  'chat_completions',
  'responses',
  'messages',
  'embeddings',
  'rerank',
  'image_generation',
  'image_edit',
  'image_variation',
  'audio_transcription',
  'audio_translation',
  'audio_speech',
  'video_generation',
  'batch',
]);
const INTELLIGENCE_TIERS = new Set([
  'simple',
  'standard',
  'complex',
  'reasoning',
  'direct',
  'cached',
]);
const SEMANTIC_CACHE_ISOLATION = new Set([
  'workspace_api_key_model',
  'workspace_model',
  'workspace',
]);
const SEMANTIC_CONTEXT_STRATEGIES = new Set([
  'metadata_only',
  'trim',
  'summarize',
]);
const SEMANTIC_INTENT_CATEGORIES = new Set([
  'coding',
  'task',
  'security',
  'reasoning',
  'creative',
  'multimodal',
  'analysis',
  'general',
]);
const GUARDRAILS_V2_ACTIONS = new Set(['observe', 'block', 'alert']);
const STATE_CATEGORIES = new Set([
  'rate_limit',
  'circuit_breaker',
  'cache_affinity',
  'momentum',
  'prompt_cache',
  'semantic_cache',
  'concurrency',
  'health_probe',
  'realtime_session',
]);
const HAS_CONFIG_REF_PATTERN = /\$\{[^}]*\}/;
const NODE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const CAPABILITY_ENDPOINTS = new Set<string>(VALID_CAPABILITY_ENDPOINTS);
const CAPABILITY_MODALITIES = new Set<string>(VALID_MODALITIES);
const CAPABILITY_IO_TYPES = new Set<string>(VALID_CAPABILITY_IO_TYPES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNumberLike(value: unknown): boolean {
  if (isFiniteNumber(value)) return true;
  if (typeof value !== 'string' || value.trim() === '') return false;
  return Number.isFinite(Number(value));
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter(isNonEmptyString) : [];
}

function isLocalhostUrl(url: URL): boolean {
  return ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
}

function issue(
  severity: ConfigValidationSeverity,
  code: string,
  message: string,
  issuePath?: string,
): ConfigValidationIssue {
  return { severity, code, message, path: issuePath };
}

function finalizeResult(
  configPath: string,
  issues: ConfigValidationIssue[],
  config?: GatewayConfig,
): ConfigValidationResult {
  const errors = issues.filter((item) => item.severity === 'error');
  const warnings = issues.filter((item) => item.severity === 'warning');
  const info = issues.filter((item) => item.severity === 'info');
  return {
    configPath,
    ok: errors.length === 0,
    issues,
    errors,
    warnings,
    info,
    config,
  };
}

function resolveConfigPath(options: ValidateConfigFileOptions): string {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const requested =
    options.configPath || env.GATEWAY_CONFIG_PATH || DEFAULT_CONFIG_FILE;
  return path.isAbsolute(requested) ? requested : path.resolve(cwd, requested);
}

export function validateConfigFile(
  options: ValidateConfigFileOptions = {},
): ConfigValidationResult {
  const configPath = resolveConfigPath(options);
  const issues: ConfigValidationIssue[] = [];

  if (!fs.existsSync(configPath)) {
    issues.push(
      issue(
        'error',
        'config_file_not_found',
        `Configuration file not found: ${configPath}`,
      ),
    );
    return finalizeResult(configPath, issues);
  }

  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (error) {
    issues.push(
      issue(
        'error',
        'config_file_read_failed',
        error instanceof Error
          ? `Could not read configuration file: ${error.message}`
          : 'Could not read configuration file.',
      ),
    );
    return finalizeResult(configPath, issues);
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(raw);
  } catch (error) {
    issues.push(
      issue(
        'error',
        'yaml_parse_error',
        error instanceof Error
          ? error.message
          : 'YAML parser rejected the file.',
      ),
    );
    return finalizeResult(configPath, issues);
  }

  const catalogLoad = loadMergedCatalog({
    cwd: options.cwd,
    env: options.env,
    config: parsed,
  });

  return validateConfigObject(parsed, {
    configPath,
    env: options.env,
    catalog: catalogLoad.catalog,
    catalogIssues: catalogLoad.issues,
  });
}

export function validateConfigObject(
  value: unknown,
  options: ValidateConfigObjectOptions = {},
): ConfigValidationResult {
  const configPath = options.configPath ?? DEFAULT_CONFIG_FILE;
  const env = options.env ?? process.env;
  const issues: ConfigValidationIssue[] = [];

  if (!isRecord(value)) {
    issues.push(
      issue(
        'error',
        'config_root_invalid',
        'Configuration root must be a YAML object.',
      ),
    );
    return finalizeResult(configPath, issues);
  }

  const config = value as Partial<GatewayConfig> & Record<string, unknown>;

  validateTopLevel(config, issues);
  validateSecretReferences(config, env, issues, '', secretBackendState(config.secret_manager));
  validateServer(config.server, issues);
  validateDatabase(config.database, issues);
  validateDashboard(config.dashboard, issues);
  validateAuth(config.auth, config.namespaces, issues);
  validateNodes(config.nodes, issues, config.models_pricing, {
    skipLegacyCatalogDiagnostics: Boolean(options.catalog),
  });
  validateNamespaces(config.namespaces, config.nodes, issues);
  validateRouting(config.routing, config.nodes, issues);
  validateBudget(config.budget, issues);
  validateCache(config.cache, issues);
  validateSemanticCache(config.semantic_cache, issues);
  validateSemanticPlatform(config.semantic_platform, issues);
  validateEmbeddingBatching(config.embedding_batching, issues);
  validateRealtime(config.realtime, config.nodes, issues);
  validateMcpGateway(config.mcp, config.namespaces, issues);
  validateShadow(config.shadow, config.nodes, issues);
  validateEvaluation(config.evaluation, config.nodes, issues);
  validateIntelligence(config.intelligence, issues);
  validateAlerts(config.alerts, issues);
  validateLogging(config.logging, issues);
  validateState(config.state, issues);
  validateCluster(config.cluster, config.state, issues);
  validateSecretManager(config.secret_manager, issues);
  validatePricing(config.models_pricing, issues);
  for (const entry of pricingLimitsIssues(config.pricing_limits)) {
    issues.push(issue('error', 'invalid_pricing_limits', entry.message, entry.path));
  }
  validateCatalogConfig(config.catalog, issues);
  validateConfigAudit(config.config_audit, issues);
  validateControlPlane(config.control_plane, issues);
  addSharedDiagnostics(config, issues, options.catalog);
  addCatalogIssues(options.catalogIssues, issues);
  validateConfigAgainstCatalog(config, options.catalog, issues);

  const nodeCount = Array.isArray(config.nodes) ? config.nodes.length : 0;
  const tierCount =
    isRecord(config.routing) && isRecord(config.routing.tiers)
      ? Object.keys(config.routing.tiers).length
      : 0;
  issues.push(
    issue(
      'info',
      'config_summary',
      `Validated ${nodeCount} node(s) and ${tierCount} routing tier(s).`,
    ),
  );

  return finalizeResult(configPath, issues, config as GatewayConfig);
}

function validateDashboard(
  dashboard: unknown,
  issues: ConfigValidationIssue[],
): void {
  if (dashboard === undefined) return;
  if (!isRecord(dashboard)) {
    issues.push(
      issue(
        'error',
        'invalid_section_type',
        'dashboard must be an object.',
        'dashboard',
      ),
    );
    return;
  }
  if (
    dashboard.auth_required !== undefined &&
    typeof dashboard.auth_required !== 'boolean'
  ) {
    issues.push(
      issue(
        'error',
        'invalid_dashboard_auth_required',
        'dashboard.auth_required must be a boolean.',
        'dashboard.auth_required',
      ),
    );
  }
  if (
    dashboard.allow_legacy_token_auth !== undefined &&
    typeof dashboard.allow_legacy_token_auth !== 'boolean'
  ) {
    issues.push(
      issue(
        'error',
        'invalid_dashboard_legacy_token_auth',
        'dashboard.allow_legacy_token_auth must be a boolean.',
        'dashboard.allow_legacy_token_auth',
      ),
    );
  }
  if (dashboard.oidc !== undefined) {
    validateDashboardOidc(dashboard.oidc, dashboard, issues);
  }
}

function validateDashboardOidc(
  oidc: unknown,
  dashboard: Record<string, unknown>,
  issues: ConfigValidationIssue[],
): void {
  if (!isRecord(oidc)) {
    issues.push(
      issue(
        'error',
        'invalid_dashboard_oidc',
        'dashboard.oidc must be an object.',
        'dashboard.oidc',
      ),
    );
    return;
  }
  if (oidc.enabled !== undefined && !isBoolean(oidc.enabled)) {
    issues.push(issue('error', 'invalid_dashboard_oidc', 'dashboard.oidc.enabled must be a boolean.', 'dashboard.oidc.enabled'));
  }
  const enabled = oidc.enabled === true;
  for (const field of ['issuer', 'client_id', 'redirect_uri']) {
    if (enabled && !isNonEmptyString(oidc[field])) {
      issues.push(
        issue(
          'error',
          'missing_required_field',
          `dashboard.oidc.${field} is required when OIDC is enabled.`,
          `dashboard.oidc.${field}`,
        ),
      );
    }
  }
  if (isNonEmptyString(oidc.issuer) && !HAS_CONFIG_REF_PATTERN.test(oidc.issuer)) {
    validateHttpUrl(oidc.issuer, 'dashboard.oidc.issuer', 'invalid_dashboard_oidc_url', issues);
  }
  if (isNonEmptyString(oidc.redirect_uri) && !HAS_CONFIG_REF_PATTERN.test(oidc.redirect_uri)) {
    validateHttpUrl(oidc.redirect_uri, 'dashboard.oidc.redirect_uri', 'invalid_dashboard_oidc_url', issues);
  }
  if (oidc.allowed_domains !== undefined) {
    if (!Array.isArray(oidc.allowed_domains) || !oidc.allowed_domains.every(isNonEmptyString)) {
      issues.push(issue('error', 'invalid_dashboard_oidc', 'dashboard.oidc.allowed_domains must be an array of non-empty domain strings.', 'dashboard.oidc.allowed_domains'));
    }
  }
  if (oidc.scopes !== undefined) {
    if (!Array.isArray(oidc.scopes) || !oidc.scopes.every(isNonEmptyString)) {
      issues.push(issue('error', 'invalid_dashboard_oidc', 'dashboard.oidc.scopes must be an array of non-empty strings.', 'dashboard.oidc.scopes'));
    }
  }
  if (
    oidc.timeout_ms !== undefined &&
    (!isNumberLike(oidc.timeout_ms) || Number(oidc.timeout_ms) <= 0)
  ) {
    issues.push(issue('error', 'invalid_dashboard_oidc', 'dashboard.oidc.timeout_ms must be a positive number.', 'dashboard.oidc.timeout_ms'));
  }
  if (oidc.default_role !== undefined && (!isNonEmptyString(oidc.default_role) || !WORKSPACE_ROLES.has(oidc.default_role))) {
    issues.push(issue('error', 'invalid_dashboard_oidc', 'dashboard.oidc.default_role must be admin, operator, or viewer.', 'dashboard.oidc.default_role'));
  }
  if (oidc.default_workspace_id !== undefined && !isNonEmptyString(oidc.default_workspace_id)) {
    issues.push(issue('error', 'invalid_dashboard_oidc', 'dashboard.oidc.default_workspace_id must be a non-empty string.', 'dashboard.oidc.default_workspace_id'));
  }
  if (enabled && !isNonEmptyString(dashboard.password) && !isNonEmptyString(dashboard.session_secret)) {
    issues.push(
      issue(
        'error',
        'missing_dashboard_session_secret',
        'dashboard.session_secret is required when OIDC is enabled without a local dashboard password.',
        'dashboard.session_secret',
      ),
    );
  }
}

function validateTopLevel(
  config: Record<string, unknown>,
  issues: ConfigValidationIssue[],
): void {
  const requiredSections = [
    'server',
    'database',
    'auth',
    'nodes',
    'routing',
    'budget',
    'models_pricing',
  ];

  for (const section of requiredSections) {
    if (config[section] === undefined) {
      issues.push(
        issue(
          'error',
          'missing_required_section',
          `Missing required top-level section "${section}".`,
          section,
        ),
      );
    }
  }
}

function validateServer(
  server: unknown,
  issues: ConfigValidationIssue[],
): void {
  if (server === undefined) return;
  if (!isRecord(server)) {
    issues.push(
      issue(
        'error',
        'invalid_section_type',
        'server must be an object.',
        'server',
      ),
    );
    return;
  }

  if (!isFiniteNumber(server.port)) {
    issues.push(
      issue(
        'error',
        'missing_required_field',
        'server.port must be a number.',
        'server.port',
      ),
    );
  }

  if (!isNonEmptyString(server.host)) {
    issues.push(
      issue(
        'error',
        'missing_required_field',
        'server.host must be a non-empty string.',
        'server.host',
      ),
    );
  }
}

function validateDatabase(
  database: unknown,
  issues: ConfigValidationIssue[],
): void {
  if (database === undefined) return;
  if (!isRecord(database)) {
    issues.push(
      issue(
        'error',
        'invalid_section_type',
        'database must be an object.',
        'database',
      ),
    );
    return;
  }

  if (database.type !== 'sqlite' && database.type !== 'postgres') {
    issues.push(
      issue(
        'error',
        'invalid_database_type',
        'database.type must be "sqlite" or "postgres".',
        'database.type',
      ),
    );
    return;
  }

  if (database.type === 'sqlite' && !isNonEmptyString(database.path)) {
    issues.push(
      issue(
        'error',
        'missing_required_field',
        'database.path is required for sqlite.',
        'database.path',
      ),
    );
  }
  if (database.type === 'postgres' && !isNonEmptyString(database.url)) {
    issues.push(
      issue(
        'error',
        'missing_required_field',
        'database.url is required for postgres.',
        'database.url',
      ),
    );
  } else if (
    database.type === 'postgres' &&
    isNonEmptyString(database.url) &&
    !HAS_CONFIG_REF_PATTERN.test(database.url)
  ) {
    try {
      const parsed = new URL(database.url);
      if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
        issues.push(
          issue(
            'error',
            'invalid_postgres_url',
            'database.url must use postgres:// or postgresql://.',
            'database.url',
          ),
        );
      }
      if (!parsed.password) {
        issues.push(
          issue(
            'warning',
            'postgres_url_without_password',
            'database.url has no password. Use a secret-backed DATABASE_URL for production PostgreSQL.',
            'database.url',
          ),
        );
      }
    } catch {
      issues.push(
        issue(
          'error',
          'invalid_postgres_url',
          'database.url must be a valid PostgreSQL connection URL.',
          'database.url',
        ),
      );
    }
  }
  if (
    database.synchronize !== undefined &&
    !isBoolean(database.synchronize)
  ) {
    issues.push(
      issue(
        'error',
        'invalid_database_synchronize',
        'database.synchronize must be a boolean when set.',
        'database.synchronize',
      ),
    );
  }
  if (
    database.route_trace_write_behind !== undefined &&
    !isBoolean(database.route_trace_write_behind)
  ) {
    issues.push(
      issue(
        'error',
        'invalid_route_trace_write_behind',
        'database.route_trace_write_behind must be a boolean when set.',
        'database.route_trace_write_behind',
      ),
    );
  }
  if (
    database.sqlite_synchronous !== undefined &&
    (typeof database.sqlite_synchronous !== 'string' ||
      !['OFF', 'NORMAL', 'FULL', 'EXTRA'].includes(database.sqlite_synchronous))
  ) {
    issues.push(
      issue(
        'error',
        'invalid_sqlite_synchronous',
        'database.sqlite_synchronous must be OFF, NORMAL, FULL, or EXTRA when set.',
        'database.sqlite_synchronous',
      ),
    );
  }
  if (
    database.type === 'postgres' &&
    database.synchronize !== false
  ) {
    issues.push(
      issue(
        'warning',
        'postgres_synchronize_enabled',
        'For production PostgreSQL, initialize/migrate schema first and set database.synchronize: false.',
        'database.synchronize',
      ),
    );
  }
  if (database.type === 'postgres') {
    validatePostgresPool(database.pool, issues);
    validatePostgresSsl(database.ssl, issues);
  } else if (database.pool !== undefined || database.ssl !== undefined) {
    issues.push(
      issue(
        'warning',
        'sqlite_ignores_postgres_options',
        'database.pool and database.ssl apply only when database.type is postgres.',
        'database',
      ),
    );
  }
  if (database.type === 'postgres' && database.sqlite_synchronous !== undefined) {
    issues.push(
      issue(
        'warning',
        'postgres_ignores_sqlite_synchronous',
        'database.sqlite_synchronous applies only when database.type is sqlite.',
        'database.sqlite_synchronous',
      ),
    );
  }
}

function validatePostgresPool(
  pool: unknown,
  issues: ConfigValidationIssue[],
): void {
  if (pool === undefined) return;
  if (!isRecord(pool)) {
    issues.push(
      issue(
        'error',
        'invalid_postgres_pool',
        'database.pool must be an object when set.',
        'database.pool',
      ),
    );
    return;
  }

  validateOptionalInteger(pool.max, 'database.pool.max', 1, 500, issues);
  validateOptionalInteger(pool.min, 'database.pool.min', 0, 500, issues);
  if (
    Number.isInteger(pool.min) &&
    Number.isInteger(pool.max) &&
    (pool.min as number) > (pool.max as number)
  ) {
    issues.push(
      issue(
        'error',
        'invalid_postgres_pool',
        'database.pool.min cannot exceed database.pool.max.',
        'database.pool.min',
      ),
    );
  }
  validateOptionalInteger(
    pool.idle_timeout_ms,
    'database.pool.idle_timeout_ms',
    1000,
    3_600_000,
    issues,
  );
  validateOptionalInteger(
    pool.connection_timeout_ms,
    'database.pool.connection_timeout_ms',
    100,
    300_000,
    issues,
  );
  validateOptionalInteger(
    pool.statement_timeout_ms,
    'database.pool.statement_timeout_ms',
    0,
    3_600_000,
    issues,
  );
  validateOptionalInteger(
    pool.query_timeout_ms,
    'database.pool.query_timeout_ms',
    0,
    3_600_000,
    issues,
  );
  validateOptionalInteger(
    pool.max_uses,
    'database.pool.max_uses',
    0,
    1_000_000,
    issues,
  );
  if (
    pool.application_name !== undefined &&
    !isNonEmptyString(pool.application_name)
  ) {
    issues.push(
      issue(
        'error',
        'invalid_postgres_pool',
        'database.pool.application_name must be a non-empty string when set.',
        'database.pool.application_name',
      ),
    );
  }
}

function validatePostgresSsl(
  ssl: unknown,
  issues: ConfigValidationIssue[],
): void {
  if (ssl === undefined) return;
  if (typeof ssl === 'boolean') return;
  if (!isRecord(ssl)) {
    issues.push(
      issue(
        'error',
        'invalid_postgres_ssl',
        'database.ssl must be a boolean or object when set.',
        'database.ssl',
      ),
    );
    return;
  }
  if (ssl.reject_unauthorized !== undefined && !isBoolean(ssl.reject_unauthorized)) {
    issues.push(
      issue(
        'error',
        'invalid_postgres_ssl',
        'database.ssl.reject_unauthorized must be a boolean when set.',
        'database.ssl.reject_unauthorized',
      ),
    );
  }
  if (ssl.reject_unauthorized === false) {
    issues.push(
      issue(
        'warning',
        'postgres_ssl_no_verify',
        'database.ssl.reject_unauthorized=false disables certificate verification. Use only for trusted private networks or local testing.',
        'database.ssl.reject_unauthorized',
      ),
    );
  }
  for (const key of ['ca', 'cert', 'key', 'servername']) {
    if (ssl[key] !== undefined && !isNonEmptyString(ssl[key])) {
      issues.push(
        issue(
          'error',
          'invalid_postgres_ssl',
          `database.ssl.${key} must be a non-empty string when set.`,
          `database.ssl.${key}`,
        ),
      );
    }
  }
}

function validateOptionalInteger(
  value: unknown,
  path: string,
  min: number,
  max: number,
  issues: ConfigValidationIssue[],
): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    issues.push(
      issue(
        'error',
        'invalid_postgres_pool',
        `${path} must be an integer between ${min} and ${max}.`,
        path,
      ),
    );
  }
}

function validateAuth(
  auth: unknown,
  namespaces: unknown,
  issues: ConfigValidationIssue[],
): void {
  if (auth === undefined) return;
  if (!isRecord(auth)) {
    issues.push(
      issue('error', 'invalid_section_type', 'auth must be an object.', 'auth'),
    );
    return;
  }

  if (!Array.isArray(auth.api_keys)) {
    issues.push(
      issue(
        'error',
        'missing_required_field',
        'auth.api_keys must be an array.',
        'auth.api_keys',
      ),
    );
    return;
  }

  const namespaceIds = new Set<string>(
    Array.isArray(namespaces)
      ? namespaces
          .filter(isRecord)
          .map((namespace) => namespace.id)
          .filter(isNonEmptyString)
      : [],
  );

  auth.api_keys.forEach((entry, index) => {
    const basePath = `auth.api_keys[${index}]`;
    if (!isRecord(entry)) {
      issues.push(
        issue(
          'error',
          'invalid_api_key_entry',
          'auth.api_keys entries must be objects.',
          basePath,
        ),
      );
      return;
    }
    if (!isNonEmptyString(entry.key)) {
      issues.push(
        issue(
          'error',
          'missing_required_field',
          'Gateway API key entry requires key.',
          `${basePath}.key`,
        ),
      );
    }
    if (!isNonEmptyString(entry.name)) {
      issues.push(
        issue(
          'error',
          'missing_required_field',
          'Gateway API key entry requires name.',
          `${basePath}.name`,
        ),
      );
    }
    if (entry.namespace_id !== undefined) {
      if (!isNonEmptyString(entry.namespace_id)) {
        issues.push(
          issue(
            'error',
            'invalid_namespace_reference',
            'auth.api_keys[].namespace_id must be a non-empty string when set.',
            `${basePath}.namespace_id`,
          ),
        );
      } else if (!namespaceIds.has(entry.namespace_id)) {
        issues.push(
          issue(
            'error',
            'unknown_namespace_reference',
            `API key "${entry.name || index}" references unknown namespace "${entry.namespace_id}".`,
            `${basePath}.namespace_id`,
          ),
        );
      }
    }
  });
}

function validateNamespaces(
  namespaces: unknown,
  nodes: unknown,
  issues: ConfigValidationIssue[],
): void {
  if (namespaces === undefined) return;
  if (!Array.isArray(namespaces)) {
    issues.push(
      issue(
        'error',
        'invalid_section_type',
        'namespaces must be an array when set.',
        'namespaces',
      ),
    );
    return;
  }

  const nodeIds = new Set<string>(
    Array.isArray(nodes)
      ? nodes.filter(isRecord).map((node) => node.id).filter(isNonEmptyString)
      : [],
  );
  const modelIds = new Set<string>();
  if (Array.isArray(nodes)) {
    for (const node of nodes) {
      if (!isRecord(node)) continue;
      for (const model of Array.isArray(node.models) ? node.models : []) {
        if (isNonEmptyString(model)) modelIds.add(model);
      }
      for (const model of Array.isArray(node.embedding_models) ? node.embedding_models : []) {
        if (isNonEmptyString(model)) modelIds.add(model);
      }
      for (const model of Array.isArray(node.rerank_models) ? node.rerank_models : []) {
        if (isNonEmptyString(model)) modelIds.add(model);
      }
      for (const model of Array.isArray(node.image_models) ? node.image_models : []) {
        if (isNonEmptyString(model)) modelIds.add(model);
      }
      for (const model of Array.isArray(node.audio_models) ? node.audio_models : []) {
        if (isNonEmptyString(model)) modelIds.add(model);
      }
      for (const model of Array.isArray(node.video_models) ? node.video_models : []) {
        if (isNonEmptyString(model)) modelIds.add(model);
      }
      for (const model of Array.isArray(node.realtime_models) ? node.realtime_models : []) {
        if (isNonEmptyString(model)) modelIds.add(model);
      }
    }
  }

  const seen = new Set<string>();
  namespaces.forEach((namespace, index) => {
    const basePath = `namespaces[${index}]`;
    if (!isRecord(namespace)) {
      issues.push(
        issue(
          'error',
          'invalid_namespace_entry',
          'Namespace entries must be objects.',
          basePath,
        ),
      );
      return;
    }

    if (!isNonEmptyString(namespace.id)) {
      issues.push(
        issue(
          'error',
          'missing_required_field',
          'namespaces[].id is required.',
          `${basePath}.id`,
        ),
      );
    } else {
      if (seen.has(namespace.id)) {
        issues.push(
          issue(
            'error',
            'duplicate_namespace_id',
            `Namespace id "${namespace.id}" is already used.`,
            `${basePath}.id`,
          ),
        );
      }
      seen.add(namespace.id);
    }

    validateReferenceArray(
      namespace.allowed_nodes,
      `${basePath}.allowed_nodes`,
      nodeIds,
      'unknown_namespace_node',
      'Namespace allowed_nodes references unknown node',
      issues,
    );
    validateReferenceArray(
      namespace.allowed_models,
      `${basePath}.allowed_models`,
      modelIds,
      'unknown_namespace_model',
      'Namespace allowed_models references unknown model',
      issues,
    );

    if (namespace.budget !== undefined) {
      if (!isRecord(namespace.budget)) {
        issues.push(issue('error', 'invalid_namespace_budget', 'namespace.budget must be an object.', `${basePath}.budget`));
      } else {
        validateOptionalPositiveNumber(namespace.budget.daily_token_limit, `${basePath}.budget.daily_token_limit`, 'invalid_namespace_budget', issues);
        validateOptionalPositiveNumber(namespace.budget.daily_cost_limit, `${basePath}.budget.daily_cost_limit`, 'invalid_namespace_budget', issues);
        if (
          namespace.budget.alert_threshold !== undefined &&
          (!isFiniteNumber(namespace.budget.alert_threshold) ||
            namespace.budget.alert_threshold <= 0 ||
            namespace.budget.alert_threshold > 1)
        ) {
          issues.push(issue('error', 'invalid_namespace_budget', 'namespace.budget.alert_threshold must be between 0 and 1.', `${basePath}.budget.alert_threshold`));
        }
      }
    }

    if (namespace.rate_limit !== undefined) {
      if (!isRecord(namespace.rate_limit)) {
        issues.push(issue('error', 'invalid_namespace_rate_limit', 'namespace.rate_limit must be an object.', `${basePath}.rate_limit`));
      } else {
        const rpm = namespace.rate_limit.requests_per_minute;
        if (rpm !== undefined && (!Number.isInteger(rpm) || typeof rpm !== 'number' || rpm < 1)) {
          issues.push(issue('error', 'invalid_namespace_rate_limit', 'namespace.rate_limit.requests_per_minute must be a positive integer.', `${basePath}.rate_limit.requests_per_minute`));
        }
      }
    }
  });
}

function validateReferenceArray(
  value: unknown,
  issuePath: string,
  knownValues: Set<string>,
  code: string,
  messagePrefix: string,
  issues: ConfigValidationIssue[],
): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    issues.push(issue('error', code, `${issuePath} must be an array.`, issuePath));
    return;
  }
  value.forEach((item, index) => {
    const itemPath = `${issuePath}[${index}]`;
    if (!isNonEmptyString(item)) {
      issues.push(issue('error', code, `${issuePath} entries must be non-empty strings.`, itemPath));
      return;
    }
    if (!knownValues.has(item)) {
      issues.push(issue('error', code, `${messagePrefix} "${item}".`, itemPath));
    }
  });
}

function validateOptionalPositiveNumber(
  value: unknown,
  issuePath: string,
  code: string,
  issues: ConfigValidationIssue[],
): void {
  if (value === undefined) return;
  if (!isFiniteNumber(value) || value <= 0) {
    issues.push(issue('error', code, `${issuePath} must be a positive number.`, issuePath));
  }
}

function validateOptionalBoolean(
  value: unknown,
  issuePath: string,
  code: string,
  issues: ConfigValidationIssue[],
): void {
  if (value === undefined) return;
  if (!isBoolean(value)) {
    issues.push(issue('error', code, `${issuePath} must be a boolean.`, issuePath));
  }
}

function validateOptionalEnum(
  value: unknown,
  knownValues: Set<string>,
  issuePath: string,
  code: string,
  issues: ConfigValidationIssue[],
): void {
  if (value === undefined) return;
  if (!isNonEmptyString(value) || !knownValues.has(value)) {
    issues.push(
      issue(
        'error',
        code,
        `${issuePath} must be one of: ${[...knownValues].join(', ')}.`,
        issuePath,
      ),
    );
  }
}

function validateOptionalEnumArray(
  value: unknown,
  knownValues: Set<string>,
  issuePath: string,
  code: string,
  issues: ConfigValidationIssue[],
): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    issues.push(issue('error', code, `${issuePath} must be an array.`, issuePath));
    return;
  }
  for (const [index, item] of value.entries()) {
    if (!isNonEmptyString(item) || !knownValues.has(item)) {
      issues.push(
        issue(
          'error',
          code,
          `${issuePath} entries must be one of: ${[...knownValues].join(', ')}.`,
          `${issuePath}[${index}]`,
        ),
      );
    }
  }
}

function validateOptionalStringArray(
  value: unknown,
  issuePath: string,
  code: string,
  issues: ConfigValidationIssue[],
): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || !value.every(isNonEmptyString)) {
    issues.push(
      issue(
        'error',
        code,
        `${issuePath} must be an array of non-empty strings.`,
        issuePath,
      ),
    );
  }
}

function validateOptionalRatio(
  value: unknown,
  issuePath: string,
  code: string,
  issues: ConfigValidationIssue[],
): void {
  if (value === undefined) return;
  if (!isFiniteNumber(value) || value < 0 || value > 1) {
    issues.push(issue('error', code, `${issuePath} must be a number between 0 and 1.`, issuePath));
  }
}

function validateNodes(
  nodes: unknown,
  issues: ConfigValidationIssue[],
  modelsPricing?: unknown,
  options: { skipLegacyCatalogDiagnostics?: boolean } = {},
): void {
  if (nodes === undefined) return;
  if (!Array.isArray(nodes)) {
    issues.push(
      issue(
        'error',
        'invalid_section_type',
        'nodes must be an array.',
        'nodes',
      ),
    );
    return;
  }
  if (nodes.length === 0) {
    issues.push(
      issue(
        'error',
        'missing_required_field',
        'nodes must include at least one upstream node.',
        'nodes',
      ),
    );
  }

  const nodeIds = new Map<string, string>();

  nodes.forEach((node, index) => {
    const basePath = `nodes[${index}]`;
    if (!isRecord(node)) {
      issues.push(
        issue(
          'error',
          'invalid_node_entry',
          'Each node entry must be an object.',
          basePath,
        ),
      );
      return;
    }

    if (!isNonEmptyString(node.id)) {
      issues.push(
        issue(
          'error',
          'missing_required_field',
          'nodes[].id is required.',
          `${basePath}.id`,
        ),
      );
    } else {
      if (!NODE_ID_PATTERN.test(node.id)) {
        issues.push(
          issue(
            'error',
            'invalid_node_id',
            'Node id must start with a letter or number and contain only letters, numbers, dots, underscores, or dashes.',
            `${basePath}.id`,
          ),
        );
      }
      const existingPath = nodeIds.get(node.id);
      if (existingPath) {
        issues.push(
          issue(
            'error',
            'duplicate_node_id',
            `Node id "${node.id}" is already used at ${existingPath}.`,
            `${basePath}.id`,
          ),
        );
      } else {
        nodeIds.set(node.id, `${basePath}.id`);
      }
    }

    if (!isNonEmptyString(node.name)) {
      issues.push(
        issue(
          'error',
          'missing_required_field',
          'nodes[].name is required.',
          `${basePath}.name`,
        ),
      );
    }
    if (
      !isNonEmptyString(node.protocol) ||
      !NODE_PROTOCOLS.has(node.protocol)
    ) {
      issues.push(
        issue(
          'error',
          'invalid_node_protocol',
          'nodes[].protocol must be one of chat_completions, responses, messages, or gemini.',
          `${basePath}.protocol`,
        ),
      );
    }
    if (!isNonEmptyString(node.base_url)) {
      issues.push(
        issue(
          'error',
          'missing_required_field',
          'nodes[].base_url is required.',
          `${basePath}.base_url`,
        ),
      );
    } else {
      validateHttpUrl(
        node.base_url,
        `${basePath}.base_url`,
        'invalid_node_base_url',
        issues,
      );
    }
    if (!isNonEmptyString(node.endpoint)) {
      issues.push(
        issue(
          'error',
          'missing_required_field',
          'nodes[].endpoint is required.',
          `${basePath}.endpoint`,
        ),
      );
    } else if (!node.endpoint.startsWith('/')) {
      issues.push(
        issue(
          'error',
          'invalid_node_endpoint',
          'nodes[].endpoint should start with "/".',
          `${basePath}.endpoint`,
        ),
      );
    }
    if (
      node.embeddings_endpoint !== undefined &&
      (!isNonEmptyString(node.embeddings_endpoint) || !node.embeddings_endpoint.startsWith('/'))
    ) {
      issues.push(
        issue(
          'error',
          'invalid_node_endpoint',
          'nodes[].embeddings_endpoint should be a non-empty path starting with "/".',
          `${basePath}.embeddings_endpoint`,
        ),
      );
    }
    if (
      node.rerank_endpoint !== undefined &&
      (!isNonEmptyString(node.rerank_endpoint) || !node.rerank_endpoint.startsWith('/'))
    ) {
      issues.push(
        issue(
          'error',
          'invalid_node_endpoint',
          'nodes[].rerank_endpoint should be a non-empty path starting with "/".',
          `${basePath}.rerank_endpoint`,
        ),
      );
    }
    if (
      node.realtime_endpoint !== undefined &&
      !isValidRealtimeEndpoint(node.realtime_endpoint)
    ) {
      issues.push(
        issue(
          'error',
          'invalid_node_endpoint',
          'nodes[].realtime_endpoint should be a non-empty path starting with "/" or a ws/wss URL.',
          `${basePath}.realtime_endpoint`,
        ),
      );
    }
    validateOptionalEndpoint(node, basePath, 'images_generations_endpoint', issues);
    validateOptionalEndpoint(node, basePath, 'images_edits_endpoint', issues);
    validateOptionalEndpoint(node, basePath, 'images_variations_endpoint', issues);
    validateOptionalEndpoint(node, basePath, 'audio_transcriptions_endpoint', issues);
    validateOptionalEndpoint(node, basePath, 'audio_translations_endpoint', issues);
    validateOptionalEndpoint(node, basePath, 'audio_speech_endpoint', issues);
    validateOptionalEndpoint(node, basePath, 'video_generations_endpoint', issues);
    validateOptionalEndpoint(node, basePath, 'video_endpoint', issues);
    validateOptionalEndpoint(node, basePath, 'video_status_endpoint', issues);
    if (node.video_result_profile !== undefined && !(VIDEO_RESULT_PROFILES as readonly unknown[]).includes(node.video_result_profile)) {
      issues.push(issue('error', 'invalid_video_result_profile', 'Choose a supported versioned video result profile.', `${basePath}.video_result_profile`));
    }
    validateOptionalEndpoint(node, basePath, 'video_content_endpoint', issues);
    validateOptionalEndpoint(node, basePath, 'video_cancel_endpoint', issues);
    validateOptionalEndpoint(node, basePath, 'batch_endpoint', issues);
    validateOptionalEndpoint(node, basePath, 'batch_status_endpoint', issues);
    validateOptionalEndpoint(node, basePath, 'batch_cancel_endpoint', issues);
    validateOptionalEndpoint(node, basePath, 'batch_result_endpoint', issues);
    const hasCredentials =
      Array.isArray(node.credentials) &&
      node.credentials.some(
        (credential) => isRecord(credential) && isNonEmptyString(credential.api_key),
      );
    if (!isNonEmptyString(node.api_key) && !hasCredentials) {
      issues.push(
        issue(
          'error',
          'missing_required_field',
          'nodes[].api_key or nodes[].credentials is required.',
          `${basePath}.api_key`,
        ),
      );
    } else if (isNonEmptyString(node.api_key)) {
      validateProviderApiKey(node, node.api_key, basePath, issues);
    }
    validateNodeCredentials(node, basePath, issues);
    validateNodeAuthMapping(node, basePath, issues);
    const hasSpecializedModels = [
      'embedding_models',
      'rerank_models',
      'image_models',
      'audio_models',
      'video_models',
      'realtime_models',
    ].some((key) =>
      Array.isArray(node[key]) &&
      (node[key] as unknown[]).some(isNonEmptyString),
    );
    if (!Array.isArray(node.models)) {
      issues.push(
        issue(
          'error',
          'missing_required_field',
          'nodes[].models must be an array. Use [] for specialized-only nodes.',
          `${basePath}.models`,
        ),
      );
    } else if (node.models.length === 0 && !hasSpecializedModels) {
      issues.push(
        issue(
          'error',
          'missing_required_field',
          'nodes[].models must contain at least one model id unless a specialized model bucket is configured.',
          `${basePath}.models`,
        ),
      );
    } else {
      const modelIds = new Set<string>();
      node.models.forEach((model, modelIndex) => {
        const modelPath = `${basePath}.models[${modelIndex}]`;
        if (!isNonEmptyString(model)) {
          issues.push(
            issue(
              'error',
              'invalid_model_id',
              'Node model ids must be non-empty strings.',
              modelPath,
            ),
          );
          return;
        }
        if (modelIds.has(model)) {
          issues.push(
            issue(
              'error',
              'duplicate_model_id_in_node',
              `Model "${model}" is listed more than once in this node.`,
              modelPath,
            ),
          );
        }
        modelIds.add(model);
      });
    }
    validateNodeEmbeddingModels(node, basePath, issues);
    validateNodeRerankModels(node, basePath, issues);
    validateNodeMediaModels(node, basePath, 'image_models', 'Image', issues);
    validateNodeMediaModels(node, basePath, 'audio_models', 'Audio', issues);
    validateNodeMediaModels(node, basePath, 'video_models', 'Video', issues);
    validateNodeRealtimeModels(node, basePath, issues);
    if (!isFiniteNumber(node.timeout_ms) || node.timeout_ms <= 0) {
      issues.push(
        issue(
          'error',
          'missing_required_field',
          'nodes[].timeout_ms must be a positive number.',
          `${basePath}.timeout_ms`,
        ),
      );
    }

    validateNodeAliases(node, basePath, issues);
    validateNodeUpstreamModelAliases(node, basePath, issues);
    validateNodeConnection(node, basePath, issues);
    validateNodeRequestCompatibility(node, basePath, issues);
    validateNodeRoutingCapabilities(node, basePath, issues);
    validateNodeCompatibilityProfileShape(node, basePath, issues);
    if (!options.skipLegacyCatalogDiagnostics) {
      addCatalogDiagnostics(
        node,
        basePath,
        isRecord(modelsPricing)
          ? (modelsPricing as Record<string, unknown>)
          : undefined,
        issues,
      );
    }
  });
}

function validateNodeUpstreamModelAliases(
  node: Record<string, unknown>,
  basePath: string,
  issues: ConfigValidationIssue[],
): void {
  if (node.upstream_model_aliases === undefined) return;

  if (!isRecord(node.upstream_model_aliases)) {
    issues.push(
      issue(
        'error',
        'invalid_upstream_model_aliases',
        'nodes[].upstream_model_aliases must be an object.',
        `${basePath}.upstream_model_aliases`,
      ),
    );
    return;
  }

  const models = new Set(
    Array.isArray(node.models) ? node.models.filter(isNonEmptyString) : [],
  );

  for (const [publicModel, upstreamModel] of Object.entries(
    node.upstream_model_aliases,
  )) {
    const aliasPath = `${basePath}.upstream_model_aliases.${publicModel}`;
    if (!isNonEmptyString(publicModel)) {
      issues.push(
        issue(
          'error',
          'invalid_upstream_model_alias',
          'Upstream model alias keys must be non-empty.',
          aliasPath,
        ),
      );
    }
    if (!isNonEmptyString(upstreamModel)) {
      issues.push(
        issue(
          'error',
          'invalid_upstream_model_alias_target',
          'Upstream model alias targets must be non-empty strings.',
          aliasPath,
        ),
      );
    }
    if (models.size > 0 && !models.has(publicModel)) {
      issues.push(
        issue(
          'warning',
          'upstream_model_alias_not_listed',
          `Upstream model alias "${publicModel}" is not listed under this node's models.`,
          aliasPath,
        ),
      );
    }
  }
}

function validateNodeCompatibilityProfileShape(
  node: Record<string, unknown>,
  basePath: string,
  issues: ConfigValidationIssue[],
): void {
  const value = node.compatibility_profile;
  if (value === undefined) return;
  const entries = Array.isArray(value) ? value : [value];
  entries.forEach((entry, index) => {
    const issuePath = Array.isArray(value)
      ? `${basePath}.compatibility_profile[${index}]`
      : `${basePath}.compatibility_profile`;
    if (!isNonEmptyString(entry)) {
      issues.push(
        issue(
          'error',
          'invalid_compatibility_profile',
          'nodes[].compatibility_profile must be a non-empty string or array of strings.',
          issuePath,
        ),
      );
      return;
    }
    if (!isCompatibilityProfileId(entry)) {
      issues.push(
        issue(
          'error',
          'unknown_compatibility_profile',
          `Compatibility profile "${entry}" is not built in.`,
          issuePath,
        ),
      );
    }
  });
}

function addCatalogDiagnostics(
  node: Record<string, unknown>,
  basePath: string,
  modelsPricing: Record<string, unknown> | undefined,
  issues: ConfigValidationIssue[],
): void {
  for (const diagnostic of diagnoseNodeAgainstCatalog(node, basePath, {
    modelsPricing,
  })) {
    issues.push(
      issue(
        diagnostic.severity,
        diagnostic.code,
        diagnostic.message,
        diagnostic.path,
      ),
    );
  }
}

function validateNodeRequestCompatibility(
  node: Record<string, unknown>,
  basePath: string,
  issues: ConfigValidationIssue[],
): void {
  if (node.request_compatibility === undefined) return;
  if (!isRecord(node.request_compatibility)) {
    issues.push(
      issue(
        'error',
        'invalid_node_request_compatibility',
        'nodes[].request_compatibility must be an object when set.',
        `${basePath}.request_compatibility`,
      ),
    );
    return;
  }

  const compatibility = node.request_compatibility;
  const mode = compatibility.messages_tool_result_content;
  if (
    mode !== undefined &&
    mode !== 'native' &&
    mode !== 'string'
  ) {
    issues.push(
      issue(
        'error',
        'invalid_node_request_compatibility_mode',
        'nodes[].request_compatibility.messages_tool_result_content must be "native" or "string".',
        `${basePath}.request_compatibility.messages_tool_result_content`,
      ),
    );
  }

  const chatToolMessages = compatibility.chat_tool_messages;
  if (
    chatToolMessages !== undefined &&
    chatToolMessages !== 'native' &&
    chatToolMessages !== 'stringify_as_user' &&
    chatToolMessages !== 'drop'
  ) {
    issues.push(
      issue(
        'error',
        'invalid_node_request_compatibility_chat_tool_messages',
        'nodes[].request_compatibility.chat_tool_messages must be "native", "stringify_as_user", or "drop".',
        `${basePath}.request_compatibility.chat_tool_messages`,
      ),
    );
  }

  if (compatibility.drop_parameters !== undefined) {
    if (
      !Array.isArray(compatibility.drop_parameters) ||
      compatibility.drop_parameters.some(
        (parameter) => typeof parameter !== 'string' || parameter.trim().length === 0,
      )
    ) {
      issues.push(
        issue(
          'error',
          'invalid_node_request_compatibility_drop_parameters',
          'nodes[].request_compatibility.drop_parameters must be an array of non-empty strings.',
          `${basePath}.request_compatibility.drop_parameters`,
        ),
      );
    }
  }

  if (
    compatibility.default_parameters !== undefined &&
    !isRecord(compatibility.default_parameters)
  ) {
    issues.push(
      issue(
        'error',
        'invalid_node_request_compatibility_default_parameters',
        'nodes[].request_compatibility.default_parameters must be an object when set.',
        `${basePath}.request_compatibility.default_parameters`,
      ),
    );
  }
}

function validateNodeConnection(
  node: Record<string, unknown>,
  basePath: string,
  issues: ConfigValidationIssue[],
): void {
  if (node.connection === undefined) return;
  if (!isRecord(node.connection)) {
    issues.push(
      issue(
        'error',
        'invalid_node_connection',
        'nodes[].connection must be an object when set.',
        `${basePath}.connection`,
      ),
    );
    return;
  }

  const connection = node.connection;
  for (const key of ['enabled', 'keep_alive', 'http2']) {
    if (connection[key] !== undefined && !isBoolean(connection[key])) {
      issues.push(
        issue(
          'error',
          'invalid_node_connection_flag',
          `nodes[].connection.${key} must be a boolean when set.`,
          `${basePath}.connection.${key}`,
        ),
      );
    }
  }

  for (const key of ['pool_size', 'keep_alive_ms']) {
    if (
      connection[key] !== undefined &&
      (!isFiniteNumber(connection[key]) || connection[key] <= 0)
    ) {
      issues.push(
        issue(
          'error',
          'invalid_node_connection_value',
          `nodes[].connection.${key} must be a positive number when set.`,
          `${basePath}.connection.${key}`,
        ),
      );
    }
  }

  for (const key of ['headers_timeout_ms', 'body_timeout_ms', 'stream_max_duration_ms']) {
    if (
      connection[key] !== undefined &&
      (!isFiniteNumber(connection[key]) || connection[key] < 0)
    ) {
      issues.push(
        issue(
          'error',
          'invalid_node_connection_value',
          `nodes[].connection.${key} must be a non-negative number when set.`,
          `${basePath}.connection.${key}`,
        ),
      );
    }
  }

  if (connection.http2 === true) {
    issues.push(
      issue(
        'warning',
        'experimental_http2_connection_pool',
        'nodes[].connection.http2 is experimental; leave it disabled unless the upstream is known to work with undici HTTP/2.',
        `${basePath}.connection.http2`,
      ),
    );
  }
}

function validateOptionalEndpoint(
  node: Record<string, unknown>,
  basePath: string,
  key: string,
  issues: ConfigValidationIssue[],
): void {
  const value = node[key];
  if (value === undefined) return;
  if (!isNonEmptyString(value) || !value.startsWith('/')) {
    issues.push(
      issue(
        'error',
        'invalid_node_endpoint',
        `nodes[].${key} should be a non-empty path starting with "/".`,
        `${basePath}.${key}`,
      ),
    );
  }
}

function validateNodeEmbeddingModels(
  node: Record<string, unknown>,
  basePath: string,
  issues: ConfigValidationIssue[],
): void {
  if (node.embedding_models === undefined) return;
  if (!Array.isArray(node.embedding_models)) {
    issues.push(
      issue(
        'error',
        'invalid_embedding_models',
        'nodes[].embedding_models must be an array of model ids when set.',
        `${basePath}.embedding_models`,
      ),
    );
    return;
  }

  const modelIds = new Set<string>();
  node.embedding_models.forEach((model, modelIndex) => {
    const modelPath = `${basePath}.embedding_models[${modelIndex}]`;
    if (!isNonEmptyString(model)) {
      issues.push(
        issue(
          'error',
          'invalid_model_id',
          'Embedding model ids must be non-empty strings.',
          modelPath,
        ),
      );
      return;
    }
    if (modelIds.has(model)) {
      issues.push(
        issue(
          'error',
          'duplicate_model_id_in_node',
          `Embedding model "${model}" is listed more than once in this node.`,
          modelPath,
        ),
      );
    }
    modelIds.add(model);
  });
}

function validateNodeRerankModels(
  node: Record<string, unknown>,
  basePath: string,
  issues: ConfigValidationIssue[],
): void {
  if (node.rerank_models === undefined) return;
  if (!Array.isArray(node.rerank_models)) {
    issues.push(
      issue(
        'error',
        'invalid_rerank_models',
        'nodes[].rerank_models must be an array of model ids when set.',
        `${basePath}.rerank_models`,
      ),
    );
    return;
  }

  const modelIds = new Set<string>();
  node.rerank_models.forEach((model, modelIndex) => {
    const modelPath = `${basePath}.rerank_models[${modelIndex}]`;
    if (!isNonEmptyString(model)) {
      issues.push(
        issue(
          'error',
          'invalid_model_id',
          'Rerank model ids must be non-empty strings.',
          modelPath,
        ),
      );
      return;
    }
    if (modelIds.has(model)) {
      issues.push(
        issue(
          'error',
          'duplicate_model_id_in_node',
          `Rerank model "${model}" is listed more than once in this node.`,
          modelPath,
        ),
      );
    }
    modelIds.add(model);
  });
}

function validateNodeRealtimeModels(
  node: Record<string, unknown>,
  basePath: string,
  issues: ConfigValidationIssue[],
): void {
  if (node.realtime_models === undefined) return;
  if (!Array.isArray(node.realtime_models)) {
    issues.push(
      issue(
        'error',
        'invalid_realtime_models',
        'nodes[].realtime_models must be an array of model ids when set.',
        `${basePath}.realtime_models`,
      ),
    );
    return;
  }

  const modelIds = new Set<string>();
  node.realtime_models.forEach((model, modelIndex) => {
    const modelPath = `${basePath}.realtime_models[${modelIndex}]`;
    if (!isNonEmptyString(model)) {
      issues.push(
        issue(
          'error',
          'invalid_model_id',
          'Realtime model ids must be non-empty strings.',
          modelPath,
        ),
      );
      return;
    }
    if (modelIds.has(model)) {
      issues.push(
        issue(
          'error',
          'duplicate_model_id_in_node',
          `Realtime model "${model}" is listed more than once in this node.`,
          modelPath,
        ),
      );
    }
    modelIds.add(model);
  });
}

function validateNodeMediaModels(
  node: Record<string, unknown>,
  basePath: string,
  key: 'image_models' | 'audio_models' | 'video_models',
  label: string,
  issues: ConfigValidationIssue[],
): void {
  if (node[key] === undefined) return;
  if (!Array.isArray(node[key])) {
    issues.push(
      issue(
        'error',
        `invalid_${key}`,
        `nodes[].${key} must be an array of model ids when set.`,
        `${basePath}.${key}`,
      ),
    );
    return;
  }

  const modelIds = new Set<string>();
  (node[key] as unknown[]).forEach((model, modelIndex) => {
    const modelPath = `${basePath}.${key}[${modelIndex}]`;
    if (!isNonEmptyString(model)) {
      issues.push(
        issue(
          'error',
          'invalid_model_id',
          `${label} model ids must be non-empty strings.`,
          modelPath,
        ),
      );
      return;
    }
    if (modelIds.has(model)) {
      issues.push(
        issue(
          'error',
          'duplicate_model_id_in_node',
          `${label} model "${model}" is listed more than once in this node.`,
          modelPath,
        ),
      );
    }
    modelIds.add(model);
  });
}

function validateNodeRoutingCapabilities(
  node: Record<string, unknown>,
  basePath: string,
  issues: ConfigValidationIssue[],
): void {
  if (
    node.max_context_tokens !== undefined &&
    (!isFiniteNumber(node.max_context_tokens) || node.max_context_tokens <= 0)
  ) {
    issues.push(
      issue(
        'error',
        'invalid_max_context_tokens',
        'nodes[].max_context_tokens must be a positive number when set.',
        `${basePath}.max_context_tokens`,
      ),
    );
  }

  if (
    node.structured_output !== undefined &&
    typeof node.structured_output !== 'boolean'
  ) {
    issues.push(
      issue(
        'error',
        'invalid_structured_output_flag',
        'nodes[].structured_output must be a boolean when set.',
        `${basePath}.structured_output`,
      ),
    );
  }

  validateCapabilitySchemaFields(node, basePath, 'nodes[]', issues);

  if (node.model_capabilities === undefined) return;
  if (!isRecord(node.model_capabilities)) {
    issues.push(
      issue(
        'error',
        'invalid_model_capabilities',
        'nodes[].model_capabilities must be an object keyed by model id.',
        `${basePath}.model_capabilities`,
      ),
    );
    return;
  }

  const listedModels = new Set(
    [
      ...(Array.isArray(node.models) ? node.models.filter(isNonEmptyString) : []),
      ...(Array.isArray(node.embedding_models) ? node.embedding_models.filter(isNonEmptyString) : []),
      ...(Array.isArray(node.rerank_models) ? node.rerank_models.filter(isNonEmptyString) : []),
      ...(Array.isArray(node.image_models) ? node.image_models.filter(isNonEmptyString) : []),
      ...(Array.isArray(node.audio_models) ? node.audio_models.filter(isNonEmptyString) : []),
      ...(Array.isArray(node.video_models) ? node.video_models.filter(isNonEmptyString) : []),
      ...(Array.isArray(node.realtime_models) ? node.realtime_models.filter(isNonEmptyString) : []),
    ],
  );

  for (const [model, capability] of Object.entries(node.model_capabilities)) {
    const capabilityPath = `${basePath}.model_capabilities.${model}`;
    if (!isRecord(capability)) {
      issues.push(
        issue(
          'error',
          'invalid_model_capability_entry',
          'Model capability entries must be objects.',
          capabilityPath,
        ),
      );
      continue;
    }

    if (listedModels.size > 0 && !listedModels.has(model)) {
      issues.push(
        issue(
          'warning',
          'model_capability_model_not_listed',
          `Model capability "${model}" is not listed under this node's models.`,
          capabilityPath,
        ),
      );
    }

    validateCapabilitySchemaFields(
      capability,
      capabilityPath,
      'model_capabilities[]',
      issues,
    );

    if (
      capability.max_context_tokens !== undefined &&
      (!isFiniteNumber(capability.max_context_tokens) || capability.max_context_tokens <= 0)
    ) {
      issues.push(
        issue(
          'error',
          'invalid_max_context_tokens',
          'model_capabilities[].max_context_tokens must be a positive number when set.',
          `${capabilityPath}.max_context_tokens`,
        ),
      );
    }

    if (
      capability.structured_output !== undefined &&
      typeof capability.structured_output !== 'boolean'
    ) {
      issues.push(
        issue(
          'error',
          'invalid_structured_output_flag',
          'model_capabilities[].structured_output must be a boolean when set.',
          `${capabilityPath}.structured_output`,
        ),
      );
    }

    if (
      capability.quality_score !== undefined &&
      (!isFiniteNumber(capability.quality_score) || capability.quality_score < 0)
    ) {
      issues.push(
        issue(
          'error',
          'invalid_quality_score',
          'model_capabilities[].quality_score must be a non-negative number when set.',
          `${capabilityPath}.quality_score`,
        ),
      );
    }

    if (capability.dimensions !== undefined) {
      validateEmbeddingDimensions(
        capability.dimensions,
        `${capabilityPath}.dimensions`,
        issues,
      );
    }

    if (capability.pricing !== undefined) {
      validatePricingEntry(
        capability.pricing,
        `${capabilityPath}.pricing`,
        issues,
      );
    }
  }
}

function validateCapabilitySchemaFields(
  capability: Record<string, unknown>,
  capabilityPath: string,
  label: string,
  issues: ConfigValidationIssue[],
): void {
  validateModalityArray(capability.modalities, `${capabilityPath}.modalities`, issues);
  validateEndpointMap(capability.endpoints, `${capabilityPath}.endpoints`, issues);
  validateCapabilityIOArray(
    capability.input_types,
    `${capabilityPath}.input_types`,
    `${label}.input_types`,
    issues,
  );
  validateCapabilityIOArray(
    capability.output_types,
    `${capabilityPath}.output_types`,
    `${label}.output_types`,
    issues,
  );

  if (
    capability.max_file_size !== undefined &&
    (!isFiniteNumber(capability.max_file_size) || capability.max_file_size <= 0)
  ) {
    issues.push(
      issue(
        'error',
        'invalid_max_file_size',
        `${label}.max_file_size must be a positive number of bytes when set.`,
        `${capabilityPath}.max_file_size`,
      ),
    );
  }

  for (const key of [
    'supports_streaming',
    'supports_realtime',
    'supports_rerank',
    'supports_reasoning',
    'prompt_cache',
    'read_cache',
    'write_cache',
  ]) {
    if (capability[key] !== undefined && !isBoolean(capability[key])) {
      issues.push(
        issue(
          'error',
          'invalid_capability_support_flag',
          `${label}.${key} must be a boolean when set.`,
          `${capabilityPath}.${key}`,
        ),
      );
    }
  }
}

function validateModalityArray(
  value: unknown,
  valuePath: string,
  issues: ConfigValidationIssue[],
): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length === 0) {
    issues.push(
      issue(
        'error',
        'invalid_capability_modalities',
        'modalities must be a non-empty array when set.',
        valuePath,
      ),
    );
    return;
  }
  value.forEach((modality, index) => {
    const itemPath = `${valuePath}[${index}]`;
    if (!isNonEmptyString(modality)) {
      issues.push(
        issue(
          'error',
          'invalid_capability_modalities',
          'modalities entries must be non-empty strings.',
          itemPath,
        ),
      );
      return;
    }
    if (!CAPABILITY_MODALITIES.has(modality)) {
      issues.push(
        issue(
          'error',
          'invalid_capability_modalities',
          `Unsupported modality "${modality}". Supported values: ${VALID_MODALITIES.join(', ')}.`,
          itemPath,
        ),
      );
    }
  });
}

function validateEndpointMap(
  value: unknown,
  valuePath: string,
  issues: ConfigValidationIssue[],
): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    issues.push(
      issue(
        'error',
        'invalid_capability_endpoints',
        'endpoints must be an object keyed by capability endpoint when set.',
        valuePath,
      ),
    );
    return;
  }

  for (const [endpointName, endpointValue] of Object.entries(value)) {
    const endpointPath = `${valuePath}.${endpointName}`;
    if (!CAPABILITY_ENDPOINTS.has(endpointName)) {
      issues.push(
        issue(
          'error',
          'invalid_capability_endpoints',
          `Unsupported capability endpoint "${endpointName}". Supported values: ${VALID_CAPABILITY_ENDPOINTS.join(', ')}.`,
          endpointPath,
        ),
      );
      continue;
    }
    if (
      !isNonEmptyString(endpointValue) ||
      !isEndpointReference(endpointValue)
    ) {
      issues.push(
        issue(
          'error',
          'invalid_capability_endpoints',
          'Capability endpoint values must be paths starting with "/" or absolute http(s)/ws(s) URLs.',
          endpointPath,
        ),
      );
    }
  }
}

function validateCapabilityIOArray(
  value: unknown,
  valuePath: string,
  label: string,
  issues: ConfigValidationIssue[],
): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length === 0) {
    issues.push(
      issue(
        'error',
        'invalid_capability_io_types',
        `${label} must be a non-empty array when set.`,
        valuePath,
      ),
    );
    return;
  }
  value.forEach((item, index) => {
    if (!isNonEmptyString(item)) {
      issues.push(
        issue(
          'error',
          'invalid_capability_io_types',
          `${label} entries must be non-empty strings.`,
          `${valuePath}[${index}]`,
        ),
      );
      return;
    }
    if (!CAPABILITY_IO_TYPES.has(item)) {
      issues.push(
        issue(
          'error',
          'invalid_capability_io_types',
          `Unsupported capability I/O type "${item}". Supported values: ${VALID_CAPABILITY_IO_TYPES.join(', ')}.`,
          `${valuePath}[${index}]`,
        ),
      );
    }
  });
}

function isEndpointReference(value: string): boolean {
  if (HAS_CONFIG_REF_PATTERN.test(value)) return true;
  if (value.startsWith('/')) return true;
  try {
    const url = new URL(value);
    return ['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol);
  } catch {
    return false;
  }
}

function validateEmbeddingDimensions(
  value: unknown,
  valuePath: string,
  issues: ConfigValidationIssue[],
): void {
  if (isFiniteNumber(value) && Number.isInteger(value) && value > 0) {
    return;
  }
  if (Array.isArray(value) && value.length > 0) {
    const invalidIndex = value.findIndex(
      (item) => !isFiniteNumber(item) || !Number.isInteger(item) || item <= 0,
    );
    if (invalidIndex === -1) return;
    issues.push(
      issue(
        'error',
        'invalid_embedding_dimensions',
        'model_capabilities[].dimensions must contain only positive integers.',
        `${valuePath}[${invalidIndex}]`,
      ),
    );
    return;
  }
  issues.push(
    issue(
      'error',
      'invalid_embedding_dimensions',
      'model_capabilities[].dimensions must be a positive integer or a non-empty array of positive integers.',
      valuePath,
    ),
  );
}

function validateNodeAliases(
  node: Record<string, unknown>,
  basePath: string,
  issues: ConfigValidationIssue[],
): void {
  if (node.model_aliases !== undefined && !isRecord(node.model_aliases)) {
    issues.push(
      issue(
        'error',
        'invalid_model_aliases',
        'nodes[].model_aliases must be an object.',
        `${basePath}.model_aliases`,
      ),
    );
    return;
  }
  if (isRecord(node.model_aliases)) {
    const models = new Set(
      Array.isArray(node.models) ? node.models.filter(isNonEmptyString) : [],
    );
    for (const [alias, target] of Object.entries(node.model_aliases)) {
      const aliasPath = `${basePath}.model_aliases.${alias}`;
      if (!isNonEmptyString(alias)) {
        issues.push(
          issue(
            'error',
            'invalid_model_alias',
            'Model alias keys must be non-empty.',
            aliasPath,
          ),
        );
      }
      if (!isNonEmptyString(target)) {
        issues.push(
          issue(
            'error',
            'invalid_model_alias_target',
            'Model alias targets must be non-empty strings.',
            aliasPath,
          ),
        );
      } else if (models.size > 0 && !models.has(target)) {
        issues.push(
          issue(
            'warning',
            'model_alias_target_not_listed',
            `Model alias "${alias}" points to "${target}", which is not listed under this node's models.`,
            aliasPath,
          ),
        );
      }
    }
  }

  if (
    node.model_prefixes !== undefined &&
    !Array.isArray(node.model_prefixes)
  ) {
    issues.push(
      issue(
        'error',
        'invalid_model_prefixes',
        'nodes[].model_prefixes must be an array.',
        `${basePath}.model_prefixes`,
      ),
    );
  } else if (Array.isArray(node.model_prefixes)) {
    node.model_prefixes.forEach((prefix, index) => {
      if (!isNonEmptyString(prefix)) {
        issues.push(
          issue(
            'error',
            'invalid_model_prefix',
            'Model prefixes must be non-empty strings.',
            `${basePath}.model_prefixes[${index}]`,
          ),
        );
      }
    });
  }
}

function validateRouting(
  routing: unknown,
  nodes: unknown,
  issues: ConfigValidationIssue[],
): void {
  if (routing === undefined) return;
  if (!isRecord(routing)) {
    issues.push(
      issue(
        'error',
        'invalid_section_type',
        'routing must be an object.',
        'routing',
      ),
    );
    return;
  }

  if (!isRecord(routing.tiers)) {
    issues.push(
      issue(
        'error',
        'missing_required_field',
        'routing.tiers must be an object.',
        'routing.tiers',
      ),
    );
  } else if (Object.keys(routing.tiers).length === 0) {
    issues.push(
      issue(
        'error',
        'missing_required_field',
        'routing.tiers must include at least one tier.',
        'routing.tiers',
      ),
    );
  } else {
    for (const [tierName, tierValue] of Object.entries(routing.tiers)) {
      validateTier(tierName, tierValue, issues);
    }
  }

  if (!isRecord(routing.scoring)) {
    issues.push(
      issue(
        'error',
        'missing_required_field',
        'routing.scoring must be an object.',
        'routing.scoring',
      ),
    );
  } else {
    for (const key of ['simple_max', 'standard_max', 'complex_max']) {
      if (!isFiniteNumber(routing.scoring[key])) {
        issues.push(
          issue(
            'error',
            'missing_required_field',
            `routing.scoring.${key} must be a number.`,
            `routing.scoring.${key}`,
          ),
        );
      }
    }
  }

  if (
    routing.optimization !== undefined &&
    (!isNonEmptyString(routing.optimization) ||
      !ROUTING_OPTIMIZATIONS.has(routing.optimization))
  ) {
    issues.push(
      issue(
        'error',
        'invalid_routing_optimization',
        'routing.optimization must be one of cost, latency, balanced, or quality.',
        'routing.optimization',
      ),
    );
  }

  validateFallbackPolicy(routing.fallback_policy, issues);
  validateCacheAffinityRouting(routing.cache_affinity, issues);
  validateDomainPreferences(routing.domain_preferences, nodes, issues);
  validateCircuitBreakerRouting(routing.circuit_breaker, issues);
}

function validateCircuitBreakerRouting(
  circuitBreaker: unknown,
  issues: ConfigValidationIssue[],
): void {
  if (circuitBreaker === undefined) return;
  const basePath = 'routing.circuit_breaker';
  if (!isRecord(circuitBreaker)) {
    issues.push(
      issue(
        'error',
        'invalid_circuit_breaker_config',
        'routing.circuit_breaker must be an object when configured.',
        basePath,
      ),
    );
    return;
  }

  if (
    circuitBreaker.enabled !== undefined &&
    !isBoolean(circuitBreaker.enabled)
  ) {
    issues.push(
      issue(
        'error',
        'invalid_circuit_breaker_config',
        `${basePath}.enabled must be a boolean.`,
        `${basePath}.enabled`,
      ),
    );
  }

  for (const key of ['failure_threshold', 'half_open_max']) {
    const value = circuitBreaker[key];
    if (
      value !== undefined &&
      (!isFiniteNumber(value) || !Number.isInteger(value) || value < 1)
    ) {
      issues.push(
        issue(
          'error',
          'invalid_circuit_breaker_config',
          `${basePath}.${key} must be a positive integer.`,
          `${basePath}.${key}`,
        ),
      );
    }
  }

  const cooldownMs = circuitBreaker.cooldown_ms;
  if (
    cooldownMs !== undefined &&
    (!isFiniteNumber(cooldownMs) || cooldownMs < 0)
  ) {
    issues.push(
      issue(
        'error',
        'invalid_circuit_breaker_config',
        `${basePath}.cooldown_ms must be a non-negative number.`,
        `${basePath}.cooldown_ms`,
      ),
    );
  }
}

function validateCacheAffinityRouting(
  cacheAffinity: unknown,
  issues: ConfigValidationIssue[],
): void {
  if (cacheAffinity === undefined) return;
  const basePath = 'routing.cache_affinity';
  if (!isRecord(cacheAffinity)) {
    issues.push(
      issue(
        'error',
        'invalid_cache_affinity_config',
        'routing.cache_affinity must be an object when configured.',
        basePath,
      ),
    );
    return;
  }

  if (
    cacheAffinity.enabled !== undefined &&
    !isBoolean(cacheAffinity.enabled)
  ) {
    issues.push(
      issue(
        'error',
        'invalid_cache_affinity_config',
        'routing.cache_affinity.enabled must be a boolean.',
        `${basePath}.enabled`,
      ),
    );
  }

  if (
    cacheAffinity.min_consecutive_hits !== undefined &&
    (!isFiniteNumber(cacheAffinity.min_consecutive_hits) ||
      !Number.isInteger(cacheAffinity.min_consecutive_hits) ||
      cacheAffinity.min_consecutive_hits < 1)
  ) {
    issues.push(
      issue(
        'error',
        'invalid_cache_affinity_config',
        'routing.cache_affinity.min_consecutive_hits must be a positive integer.',
        `${basePath}.min_consecutive_hits`,
      ),
    );
  }

  if (
    cacheAffinity.bonus_weight !== undefined &&
    (!isFiniteNumber(cacheAffinity.bonus_weight) ||
      cacheAffinity.bonus_weight < 0)
  ) {
    issues.push(
      issue(
        'error',
        'invalid_cache_affinity_config',
        'routing.cache_affinity.bonus_weight must be a non-negative number.',
        `${basePath}.bonus_weight`,
      ),
    );
  }

  if (
    cacheAffinity.ttl_safety_margin !== undefined &&
    (!isFiniteNumber(cacheAffinity.ttl_safety_margin) ||
      cacheAffinity.ttl_safety_margin <= 0 ||
      cacheAffinity.ttl_safety_margin > 1)
  ) {
    issues.push(
      issue(
        'error',
        'invalid_cache_affinity_config',
        'routing.cache_affinity.ttl_safety_margin must be greater than 0 and at most 1.',
        `${basePath}.ttl_safety_margin`,
      ),
    );
  }
}

function validateFallbackPolicy(
  fallbackPolicy: unknown,
  issues: ConfigValidationIssue[],
): void {
  if (fallbackPolicy === undefined) return;
  const basePath = 'routing.fallback_policy';
  if (!isRecord(fallbackPolicy)) {
    issues.push(
      issue(
        'error',
        'invalid_fallback_policy',
        'routing.fallback_policy must be an object when configured.',
        basePath,
      ),
    );
    return;
  }

  if (
    fallbackPolicy.immediate_429 !== undefined &&
    !isBoolean(fallbackPolicy.immediate_429)
  ) {
    issues.push(
      issue(
        'error',
        'invalid_fallback_policy',
        'routing.fallback_policy.immediate_429 must be a boolean.',
        `${basePath}.immediate_429`,
      ),
    );
  }

  validateTimeoutFallbackPolicy(fallbackPolicy.timeout, issues);
  validateStructuredOutputFallbackPolicy(
    fallbackPolicy.structured_output,
    issues,
  );
  validateCostDowngradeFallbackPolicy(
    fallbackPolicy.cost_downgrade,
    issues,
  );
}

function validateTimeoutFallbackPolicy(
  timeoutPolicy: unknown,
  issues: ConfigValidationIssue[],
): void {
  if (timeoutPolicy === undefined) return;
  const basePath = 'routing.fallback_policy.timeout';
  if (!isRecord(timeoutPolicy)) {
    issues.push(
      issue(
        'error',
        'invalid_fallback_timeout_policy',
        'routing.fallback_policy.timeout must be an object.',
        basePath,
      ),
    );
    return;
  }

  if (
    timeoutPolicy.enabled !== undefined &&
    !isBoolean(timeoutPolicy.enabled)
  ) {
    issues.push(
      issue(
        'error',
        'invalid_fallback_timeout_policy',
        'routing.fallback_policy.timeout.enabled must be a boolean.',
        `${basePath}.enabled`,
      ),
    );
  }
  if (
    timeoutPolicy.race_fallback !== undefined &&
    !isBoolean(timeoutPolicy.race_fallback)
  ) {
    issues.push(
      issue(
        'error',
        'invalid_fallback_timeout_policy',
        'routing.fallback_policy.timeout.race_fallback must be a boolean.',
        `${basePath}.race_fallback`,
      ),
    );
  }
  if (
    timeoutPolicy.threshold_ms !== undefined &&
    (!isFiniteNumber(timeoutPolicy.threshold_ms) ||
      timeoutPolicy.threshold_ms <= 0)
  ) {
    issues.push(
      issue(
        'error',
        'invalid_fallback_timeout_policy',
        'routing.fallback_policy.timeout.threshold_ms must be a positive number.',
        `${basePath}.threshold_ms`,
      ),
    );
  }
  if (timeoutPolicy.race_fallback === true && timeoutPolicy.threshold_ms === undefined) {
    issues.push(
      issue(
        'error',
        'fallback_race_requires_threshold',
        'routing.fallback_policy.timeout.race_fallback requires an explicit threshold_ms because it can create extra upstream cost.',
        `${basePath}.threshold_ms`,
      ),
    );
  }
}

function validateStructuredOutputFallbackPolicy(
  structuredPolicy: unknown,
  issues: ConfigValidationIssue[],
): void {
  if (structuredPolicy === undefined) return;
  const basePath = 'routing.fallback_policy.structured_output';
  if (!isRecord(structuredPolicy)) {
    issues.push(
      issue(
        'error',
        'invalid_structured_output_fallback_policy',
        'routing.fallback_policy.structured_output must be an object.',
        basePath,
      ),
    );
    return;
  }

  for (const key of [
    'enabled',
    'fallback_on_parse_error',
    'fallback_on_schema_error',
  ]) {
    if (
      structuredPolicy[key] !== undefined &&
      !isBoolean(structuredPolicy[key])
    ) {
      issues.push(
        issue(
          'error',
          'invalid_structured_output_fallback_policy',
          `routing.fallback_policy.structured_output.${key} must be a boolean.`,
          `${basePath}.${key}`,
        ),
      );
    }
  }
}

function validateCostDowngradeFallbackPolicy(
  costPolicy: unknown,
  issues: ConfigValidationIssue[],
): void {
  if (costPolicy === undefined) return;
  const basePath = 'routing.fallback_policy.cost_downgrade';
  if (!isRecord(costPolicy)) {
    issues.push(
      issue(
        'error',
        'invalid_cost_downgrade_policy',
        'routing.fallback_policy.cost_downgrade must be an object.',
        basePath,
      ),
    );
    return;
  }

  if (costPolicy.enabled !== undefined && !isBoolean(costPolicy.enabled)) {
    issues.push(
      issue(
        'error',
        'invalid_cost_downgrade_policy',
        'routing.fallback_policy.cost_downgrade.enabled must be a boolean.',
        `${basePath}.enabled`,
      ),
    );
  }
  if (
    costPolicy.max_estimated_cost_usd !== undefined &&
    (!isFiniteNumber(costPolicy.max_estimated_cost_usd) ||
      costPolicy.max_estimated_cost_usd <= 0)
  ) {
    issues.push(
      issue(
        'error',
        'invalid_cost_downgrade_policy',
        'routing.fallback_policy.cost_downgrade.max_estimated_cost_usd must be a positive number.',
        `${basePath}.max_estimated_cost_usd`,
      ),
    );
  }
  if (costPolicy.enabled === true && costPolicy.max_estimated_cost_usd === undefined) {
    issues.push(
      issue(
        'error',
        'cost_downgrade_requires_limit',
        'routing.fallback_policy.cost_downgrade.enabled requires max_estimated_cost_usd.',
        `${basePath}.max_estimated_cost_usd`,
      ),
    );
  }
}

function validateTier(
  tierName: string,
  tierValue: unknown,
  issues: ConfigValidationIssue[],
): void {
  const tierPath = `routing.tiers.${tierName}`;
  if (!isRecord(tierValue)) {
    issues.push(
      issue(
        'error',
        'invalid_routing_tier',
        'Routing tier must be an object.',
        tierPath,
      ),
    );
    return;
  }

  const hasTargets = Array.isArray(tierValue.targets) && tierValue.targets.length > 0;
  const hasSplit = Array.isArray(tierValue.split) && tierValue.split.length > 0;
  const hasPrimary = tierValue.primary !== undefined;
  if (!hasPrimary && !hasTargets && !hasSplit) {
    issues.push(
      issue(
        'error',
        'missing_route_primary_or_targets',
        'Routing tier must define primary, targets, or split.',
        tierPath,
      ),
    );
  }
  if (hasPrimary) {
    validateRouteTargetShape(tierValue.primary, `${tierPath}.primary`, issues);
  }

  if (
    tierValue.strategy !== undefined &&
    (!isNonEmptyString(tierValue.strategy) ||
      !LOAD_BALANCING_STRATEGIES.has(tierValue.strategy))
  ) {
    issues.push(
      issue(
        'error',
        'invalid_routing_strategy',
        'Routing tier strategy must be one of weighted, round_robin, least_latency, or random.',
        `${tierPath}.strategy`,
      ),
    );
  }

  if (!hasTargets && !hasSplit && !Array.isArray(tierValue.fallbacks)) {
    issues.push(
      issue(
        'error',
        'missing_required_field',
        'Routing tier fallbacks must be an array.',
        `${tierPath}.fallbacks`,
      ),
    );
  } else if (tierValue.fallbacks !== undefined) {
    if (!Array.isArray(tierValue.fallbacks)) {
      issues.push(
        issue(
          'error',
          'missing_required_field',
          'Routing tier fallbacks must be an array.',
          `${tierPath}.fallbacks`,
        ),
      );
    } else {
      tierValue.fallbacks.forEach((fallback, index) =>
        validateRouteTargetShape(
          fallback,
          `${tierPath}.fallbacks[${index}]`,
          issues,
        ),
      );
    }
  }

  if (tierValue.split !== undefined) {
    if (!Array.isArray(tierValue.split) || tierValue.split.length === 0) {
      issues.push(
        issue(
          'error',
          'invalid_split',
          'Routing tier split must be a non-empty array when present.',
          `${tierPath}.split`,
        ),
      );
    } else {
      let totalWeight = 0;
      tierValue.split.forEach((variant, index) => {
        const variantPath = `${tierPath}.split[${index}]`;
        validateRouteTargetShape(variant, variantPath, issues);
        if (
          !isRecord(variant) ||
          !isFiniteNumber(variant.weight) ||
          variant.weight <= 0
        ) {
          issues.push(
            issue(
              'error',
              'invalid_split_weight',
              'Split variant weight must be a positive number.',
              `${variantPath}.weight`,
            ),
          );
        } else {
          totalWeight += variant.weight;
        }
      });
      if (totalWeight !== 100) {
        issues.push(
          issue(
            'error',
            'invalid_split_weight_total',
            `Routing tier "${tierName}" split weights must sum to 100, got ${totalWeight}.`,
            `${tierPath}.split`,
          ),
        );
      }
    }
  }

  if (tierValue.targets !== undefined) {
    if (!Array.isArray(tierValue.targets) || tierValue.targets.length === 0) {
      issues.push(
        issue(
          'error',
          'invalid_targets',
          'Routing tier targets must be a non-empty array when present.',
          `${tierPath}.targets`,
        ),
      );
    } else {
      tierValue.targets.forEach((target, index) => {
        const targetPath = `${tierPath}.targets[${index}]`;
        validateRouteTargetShape(target, targetPath, issues);
        if (
          isRecord(target) &&
          target.weight !== undefined &&
          (!isFiniteNumber(target.weight) || target.weight <= 0)
        ) {
          issues.push(
            issue(
              'error',
              'invalid_target_weight',
              'Routing target weight must be a positive number when set.',
              `${targetPath}.weight`,
            ),
          );
        }
      });
    }
  }
}

function validateRouteTargetShape(
  target: unknown,
  targetPath: string,
  issues: ConfigValidationIssue[],
): void {
  if (!isRecord(target)) {
    issues.push(
      issue(
        'error',
        'invalid_route_target',
        'Route target must be an object with node and model.',
        targetPath,
      ),
    );
    return;
  }
  if (!isNonEmptyString(target.node)) {
    issues.push(
      issue(
        'error',
        'missing_required_field',
        'Route target node is required.',
        `${targetPath}.node`,
      ),
    );
  }
  if (!isNonEmptyString(target.model)) {
    issues.push(
      issue(
        'error',
        'missing_required_field',
        'Route target model is required.',
        `${targetPath}.model`,
      ),
    );
  }
}

function validateDomainPreferences(
  domainPreferences: unknown,
  nodes: unknown,
  issues: ConfigValidationIssue[],
): void {
  if (domainPreferences === undefined) return;
  if (!isRecord(domainPreferences)) {
    issues.push(
      issue(
        'error',
        'invalid_domain_preferences',
        'routing.domain_preferences must be an object.',
        'routing.domain_preferences',
      ),
    );
    return;
  }

  const nodeIds = new Set<string>();
  if (Array.isArray(nodes)) {
    for (const node of nodes) {
      if (isRecord(node) && isNonEmptyString(node.id)) {
        nodeIds.add(node.id);
      }
    }
  }

  for (const [domain, preferredNodes] of Object.entries(domainPreferences)) {
    const preferencePath = `routing.domain_preferences.${domain}`;
    if (!Array.isArray(preferredNodes)) {
      issues.push(
        issue(
          'error',
          'invalid_domain_preference',
          'Domain preference must be an array of node ids.',
          preferencePath,
        ),
      );
      continue;
    }
    preferredNodes.forEach((nodeId, index) => {
      const nodePath = `${preferencePath}[${index}]`;
      if (!isNonEmptyString(nodeId)) {
        issues.push(
          issue(
            'error',
            'invalid_domain_preference_node',
            'Domain preference node ids must be non-empty strings.',
            nodePath,
          ),
        );
      } else if (!nodeIds.has(nodeId)) {
        issues.push(
          issue(
            'error',
            'domain_preference_unknown_node',
            `Domain preference references unknown node "${nodeId}".`,
            nodePath,
          ),
        );
      }
    });
  }
}

function validateBudget(
  budget: unknown,
  issues: ConfigValidationIssue[],
): void {
  if (budget === undefined) return;
  if (!isRecord(budget)) {
    issues.push(
      issue(
        'error',
        'invalid_section_type',
        'budget must be an object.',
        'budget',
      ),
    );
    return;
  }

  for (const key of [
    'daily_token_limit',
    'daily_cost_limit',
    'alert_threshold',
  ]) {
    if (!isFiniteNumber(budget[key])) {
      issues.push(
        issue(
          'error',
          'missing_required_field',
          `budget.${key} must be a number.`,
          `budget.${key}`,
        ),
      );
    }
  }
}

function validateCache(
  cache: unknown,
  issues: ConfigValidationIssue[],
): void {
  if (cache === undefined) return;
  if (!isRecord(cache)) {
    issues.push(
      issue(
        'error',
        'invalid_section_type',
        'cache must be an object.',
        'cache',
      ),
    );
    return;
  }

  if (cache.enabled !== undefined && !isBoolean(cache.enabled)) {
    issues.push(
      issue(
        'error',
        'invalid_cache_config',
        'cache.enabled must be a boolean.',
        'cache.enabled',
      ),
    );
  }
  if (
    cache.ttl_seconds !== undefined &&
    (!isFiniteNumber(cache.ttl_seconds) || cache.ttl_seconds <= 0)
  ) {
    issues.push(
      issue(
        'error',
        'invalid_cache_config',
        'cache.ttl_seconds must be a positive number.',
        'cache.ttl_seconds',
      ),
    );
  }
  if (
    cache.max_entries !== undefined &&
    (!isFiniteNumber(cache.max_entries) || cache.max_entries <= 0)
  ) {
    issues.push(
      issue(
        'error',
        'invalid_cache_config',
        'cache.max_entries must be a positive number.',
        'cache.max_entries',
      ),
    );
  }
  if (
    cache.exclude_tool_use !== undefined &&
    !isBoolean(cache.exclude_tool_use)
  ) {
    issues.push(
      issue(
        'error',
        'invalid_cache_config',
        'cache.exclude_tool_use must be a boolean.',
        'cache.exclude_tool_use',
      ),
    );
  }
  if (cache.stream_cache !== undefined) {
    if (!isRecord(cache.stream_cache)) {
      issues.push(
        issue(
          'error',
          'invalid_stream_cache_config',
          'cache.stream_cache must be an object when set.',
          'cache.stream_cache',
        ),
      );
      return;
    }
    if (
      cache.stream_cache.enabled !== undefined &&
      !isBoolean(cache.stream_cache.enabled)
    ) {
      issues.push(
        issue(
          'error',
          'invalid_stream_cache_config',
          'cache.stream_cache.enabled must be a boolean.',
          'cache.stream_cache.enabled',
        ),
      );
    }
  }
}

function validateSemanticCache(
  semanticCache: unknown,
  issues: ConfigValidationIssue[],
): void {
  if (semanticCache === undefined) return;
  if (!isRecord(semanticCache)) {
    issues.push(
      issue(
        'error',
        'invalid_semantic_cache_config',
        'semantic_cache must be an object.',
        'semantic_cache',
      ),
    );
    return;
  }

  if (
    semanticCache.enabled !== undefined &&
    !isBoolean(semanticCache.enabled)
  ) {
    issues.push(
      issue(
        'error',
        'invalid_semantic_cache_config',
        'semantic_cache.enabled must be a boolean.',
        'semantic_cache.enabled',
      ),
    );
  }

  if (
    semanticCache.backend !== undefined &&
    semanticCache.backend !== 'memory' &&
    semanticCache.backend !== 'redis' &&
    semanticCache.backend !== 'vector'
  ) {
    issues.push(
      issue(
        'error',
        'invalid_semantic_cache_config',
        'semantic_cache.backend must be memory, redis, or vector.',
        'semantic_cache.backend',
      ),
    );
  }

  if (
    semanticCache.backend !== undefined &&
    semanticCache.backend !== 'memory'
  ) {
    issues.push(
      issue(
        'warning',
        'semantic_cache_backend_preview',
        'semantic_cache backend support beyond memory is preview-only; memory remains the default local backend.',
        'semantic_cache.backend',
      ),
    );
  }

  if (
    semanticCache.similarity_threshold !== undefined &&
    (!isFiniteNumber(semanticCache.similarity_threshold) ||
      semanticCache.similarity_threshold <= 0 ||
      semanticCache.similarity_threshold > 1)
  ) {
    issues.push(
      issue(
        'error',
        'invalid_semantic_cache_config',
        'semantic_cache.similarity_threshold must be a number greater than 0 and at most 1.',
        'semantic_cache.similarity_threshold',
      ),
    );
  }

  validateOptionalPositiveNumber(
    semanticCache.ttl_seconds,
    'semantic_cache.ttl_seconds',
    'invalid_semantic_cache_config',
    issues,
  );
  validateOptionalPositiveNumber(
    semanticCache.max_entries,
    'semantic_cache.max_entries',
    'invalid_semantic_cache_config',
    issues,
  );
  validateOptionalPositiveNumber(
    semanticCache.vector_dimensions,
    'semantic_cache.vector_dimensions',
    'invalid_semantic_cache_config',
    issues,
  );
  validateOptionalPositiveNumber(
    semanticCache.max_response_bytes,
    'semantic_cache.max_response_bytes',
    'invalid_semantic_cache_config',
    issues,
  );

  if (
    semanticCache.store_responses !== undefined &&
    !isBoolean(semanticCache.store_responses)
  ) {
    issues.push(
      issue(
        'error',
        'invalid_semantic_cache_config',
        'semantic_cache.store_responses must be a boolean.',
        'semantic_cache.store_responses',
      ),
    );
  }

  if (
    semanticCache.isolation !== undefined &&
    !SEMANTIC_CACHE_ISOLATION.has(String(semanticCache.isolation))
  ) {
    issues.push(
      issue(
        'error',
        'invalid_semantic_cache_config',
        'semantic_cache.isolation must be workspace_api_key_model, workspace_model, or workspace.',
        'semantic_cache.isolation',
      ),
    );
  }

  if (
    semanticCache.response_storage_requires_header !== undefined &&
    !isBoolean(semanticCache.response_storage_requires_header)
  ) {
    issues.push(
      issue(
        'error',
        'invalid_semantic_cache_config',
        'semantic_cache.response_storage_requires_header must be a boolean.',
        'semantic_cache.response_storage_requires_header',
      ),
    );
  }

  if (semanticCache.store_responses === true) {
    issues.push(
      issue(
        'warning',
        'semantic_cache_response_storage_enabled',
        'semantic_cache.store_responses=true can retain replayable response bodies locally; keep it disabled unless explicitly needed and documented.',
        'semantic_cache.store_responses',
      ),
    );
  }

  if (
    semanticCache.store_responses === true &&
    semanticCache.response_storage_requires_header === false
  ) {
    issues.push(
      issue(
        'warning',
        'semantic_cache_response_storage_header_disabled',
        'semantic_cache response replay is enabled without a per-request opt-in header; avoid this for sensitive workspaces.',
        'semantic_cache.response_storage_requires_header',
      ),
    );
  }
}

function validateSemanticPlatform(
  semanticPlatform: unknown,
  issues: ConfigValidationIssue[],
): void {
  if (semanticPlatform === undefined) return;
  if (!isRecord(semanticPlatform)) {
    issues.push(
      issue(
        'error',
        'invalid_semantic_platform_config',
        'semantic_platform must be an object.',
        'semantic_platform',
      ),
    );
    return;
  }

  validateOptionalBoolean(
    semanticPlatform.enabled,
    'semantic_platform.enabled',
    'invalid_semantic_platform_config',
    issues,
  );

  validatePromptRegistryConfig(semanticPlatform.prompt_registry, issues);
  validateContextOptimizerConfig(semanticPlatform.context_optimizer, issues);
  validateIntentClassificationConfig(semanticPlatform.intent_classification, issues);
  validateGuardrailsV2Config(semanticPlatform.guardrails_v2, issues);
}

function validatePromptRegistryConfig(
  promptRegistry: unknown,
  issues: ConfigValidationIssue[],
): void {
  if (promptRegistry === undefined) return;
  if (!isRecord(promptRegistry)) {
    issues.push(issue('error', 'invalid_semantic_platform_config', 'semantic_platform.prompt_registry must be an object.', 'semantic_platform.prompt_registry'));
    return;
  }
  validateOptionalBoolean(promptRegistry.enabled, 'semantic_platform.prompt_registry.enabled', 'invalid_semantic_platform_config', issues);
  validateOptionalBoolean(promptRegistry.store_template_content, 'semantic_platform.prompt_registry.store_template_content', 'invalid_semantic_platform_config', issues);
  validateOptionalPositiveNumber(promptRegistry.max_versions_per_key, 'semantic_platform.prompt_registry.max_versions_per_key', 'invalid_semantic_platform_config', issues);
  if (promptRegistry.store_template_content === true) {
    issues.push(issue(
      'warning',
      'prompt_registry_content_storage_enabled',
      'semantic_platform.prompt_registry.store_template_content=true stores template bodies; keep it disabled unless redaction and retention are documented.',
      'semantic_platform.prompt_registry.store_template_content',
    ));
  }
}

function validateContextOptimizerConfig(
  contextOptimizer: unknown,
  issues: ConfigValidationIssue[],
): void {
  if (contextOptimizer === undefined) return;
  if (!isRecord(contextOptimizer)) {
    issues.push(issue('error', 'invalid_semantic_platform_config', 'semantic_platform.context_optimizer must be an object.', 'semantic_platform.context_optimizer'));
    return;
  }
  validateOptionalBoolean(contextOptimizer.enabled, 'semantic_platform.context_optimizer.enabled', 'invalid_semantic_platform_config', issues);
  if (
    contextOptimizer.strategy !== undefined &&
    !SEMANTIC_CONTEXT_STRATEGIES.has(String(contextOptimizer.strategy))
  ) {
    issues.push(issue(
      'error',
      'invalid_semantic_platform_config',
      'semantic_platform.context_optimizer.strategy must be metadata_only, trim, or summarize.',
      'semantic_platform.context_optimizer.strategy',
    ));
  }
  if (
    contextOptimizer.max_context_ratio !== undefined &&
    (!isFiniteNumber(contextOptimizer.max_context_ratio) ||
      contextOptimizer.max_context_ratio <= 0 ||
      contextOptimizer.max_context_ratio > 1)
  ) {
    issues.push(issue(
      'error',
      'invalid_semantic_platform_config',
      'semantic_platform.context_optimizer.max_context_ratio must be a number greater than 0 and at most 1.',
      'semantic_platform.context_optimizer.max_context_ratio',
    ));
  }
  validateOptionalBoolean(contextOptimizer.allow_content_mutation, 'semantic_platform.context_optimizer.allow_content_mutation', 'invalid_semantic_platform_config', issues);
  if (
    (contextOptimizer.strategy === 'trim' || contextOptimizer.strategy === 'summarize') &&
    contextOptimizer.allow_content_mutation !== true
  ) {
    issues.push(issue(
      'warning',
      'context_optimizer_mutation_disabled',
      'context optimizer trim/summarize strategies will record evidence only until allow_content_mutation=true is explicitly set.',
      'semantic_platform.context_optimizer.allow_content_mutation',
    ));
  }
}

function validateIntentClassificationConfig(
  intentClassification: unknown,
  issues: ConfigValidationIssue[],
): void {
  if (intentClassification === undefined) return;
  if (!isRecord(intentClassification)) {
    issues.push(issue('error', 'invalid_semantic_platform_config', 'semantic_platform.intent_classification must be an object.', 'semantic_platform.intent_classification'));
    return;
  }
  validateOptionalBoolean(intentClassification.enabled, 'semantic_platform.intent_classification.enabled', 'invalid_semantic_platform_config', issues);
  if (intentClassification.categories !== undefined) {
    if (!Array.isArray(intentClassification.categories)) {
      issues.push(issue('error', 'invalid_semantic_platform_config', 'semantic_platform.intent_classification.categories must be an array.', 'semantic_platform.intent_classification.categories'));
    } else {
      for (const [index, category] of intentClassification.categories.entries()) {
        if (!SEMANTIC_INTENT_CATEGORIES.has(String(category))) {
          issues.push(issue(
            'error',
            'invalid_semantic_platform_config',
            `semantic_platform.intent_classification.categories[${index}] is not supported.`,
            `semantic_platform.intent_classification.categories[${index}]`,
          ));
        }
      }
    }
  }
  if (
    intentClassification.min_confidence !== undefined &&
    (!isFiniteNumber(intentClassification.min_confidence) ||
      intentClassification.min_confidence < 0 ||
      intentClassification.min_confidence > 1)
  ) {
    issues.push(issue(
      'error',
      'invalid_semantic_platform_config',
      'semantic_platform.intent_classification.min_confidence must be a number between 0 and 1.',
      'semantic_platform.intent_classification.min_confidence',
    ));
  }
}

function validateGuardrailsV2Config(
  guardrails: unknown,
  issues: ConfigValidationIssue[],
): void {
  if (guardrails === undefined) return;
  if (!isRecord(guardrails)) {
    issues.push(issue('error', 'invalid_semantic_platform_config', 'semantic_platform.guardrails_v2 must be an object.', 'semantic_platform.guardrails_v2'));
    return;
  }
  validateOptionalBoolean(guardrails.enabled, 'semantic_platform.guardrails_v2.enabled', 'invalid_semantic_platform_config', issues);
  validateOptionalBoolean(guardrails.metadata_only, 'semantic_platform.guardrails_v2.metadata_only', 'invalid_semantic_platform_config', issues);
  validateGuardrailsV2Policy(guardrails.input, 'semantic_platform.guardrails_v2.input', issues);
  validateGuardrailsV2Policy(guardrails.output, 'semantic_platform.guardrails_v2.output', issues);
}

function validateGuardrailsV2Policy(
  policy: unknown,
  pathPrefix: string,
  issues: ConfigValidationIssue[],
): void {
  if (policy === undefined) return;
  if (!isRecord(policy)) {
    issues.push(issue('error', 'invalid_semantic_platform_config', `${pathPrefix} must be an object.`, pathPrefix));
    return;
  }
  for (const field of ['enabled', 'pii', 'toxicity', 'jailbreak']) {
    validateOptionalBoolean(policy[field], `${pathPrefix}.${field}`, 'invalid_semantic_platform_config', issues);
  }
  if (policy.action !== undefined && !GUARDRAILS_V2_ACTIONS.has(String(policy.action))) {
    issues.push(issue(
      'error',
      'invalid_semantic_platform_config',
      `${pathPrefix}.action must be observe, block, or alert.`,
      `${pathPrefix}.action`,
    ));
  }
}

function validateEvaluation(
  evaluation: unknown,
  nodes: unknown,
  issues: ConfigValidationIssue[],
): void {
  if (evaluation === undefined) return;
  if (!isRecord(evaluation)) {
    issues.push(
      issue(
        'error',
        'invalid_evaluation_config',
        'evaluation must be an object.',
        'evaluation',
      ),
    );
    return;
  }

  if (evaluation.enabled !== undefined && !isBoolean(evaluation.enabled)) {
    issues.push(
      issue(
        'error',
        'invalid_evaluation_config',
        'evaluation.enabled must be a boolean.',
        'evaluation.enabled',
      ),
    );
  }
  if (
    evaluation.store_samples !== undefined &&
    !isBoolean(evaluation.store_samples)
  ) {
    issues.push(
      issue(
        'error',
        'invalid_evaluation_config',
        'evaluation.store_samples must be a boolean.',
        'evaluation.store_samples',
      ),
    );
  }

  validateOptionalPositiveNumber(
    evaluation.max_sample_chars,
    'evaluation.max_sample_chars',
    'invalid_evaluation_config',
    issues,
  );
  validateOptionalPositiveNumber(
    evaluation.retention_days,
    'evaluation.retention_days',
    'invalid_evaluation_config',
    issues,
  );

  if (
    evaluation.judge_model !== undefined &&
    isNonEmptyString(evaluation.judge_model) &&
    Array.isArray(nodes)
  ) {
    const knownModels = new Set<string>();
    for (const node of nodes) {
      if (!isRecord(node)) continue;
      for (const model of Array.isArray(node.models) ? node.models : []) {
        if (isNonEmptyString(model)) knownModels.add(model);
      }
    }
    if (!knownModels.has(evaluation.judge_model)) {
      issues.push(
        issue(
          'warning',
          'unknown_evaluation_judge_model',
          `evaluation.judge_model "${evaluation.judge_model}" is not in nodes[].models; eval runners may fall back to auto routing.`,
          'evaluation.judge_model',
        ),
      );
    }
  }

  if (evaluation.store_samples === true) {
    issues.push(
      issue(
        'warning',
        'evaluation_sample_storage_enabled',
        'evaluation.store_samples=true can retain redacted prompt/response previews locally; keep it disabled unless explicitly needed.',
        'evaluation.store_samples',
      ),
    );
  }
}

function validateIntelligence(
  intelligence: unknown,
  issues: ConfigValidationIssue[],
): void {
  if (intelligence === undefined) return;
  if (!isRecord(intelligence)) {
    issues.push(
      issue(
        'error',
        'invalid_intelligence_config',
        'intelligence must be an object.',
        'intelligence',
      ),
    );
    return;
  }

  validateIntelligenceCostOptimizer(intelligence.cost_optimizer, issues);
  validateIntelligenceTokenPrediction(intelligence.token_prediction, issues);
  validateIntelligenceAsyncEval(intelligence.async_eval, issues);
  validateIntelligenceQualityGate(intelligence.quality_gate, issues);
}

function validateIntelligenceCostOptimizer(
  optimizer: unknown,
  issues: ConfigValidationIssue[],
): void {
  if (optimizer === undefined) return;
  const basePath = 'intelligence.cost_optimizer';
  if (!isRecord(optimizer)) {
    issues.push(issue('error', 'invalid_intelligence_cost_optimizer', `${basePath} must be an object.`, basePath));
    return;
  }
  validateOptionalBoolean(optimizer.enabled, `${basePath}.enabled`, 'invalid_intelligence_cost_optimizer', issues);
  validateOptionalEnum(
    optimizer.action,
    INTELLIGENCE_OPTIMIZER_ACTIONS,
    `${basePath}.action`,
    'invalid_intelligence_cost_optimizer',
    issues,
  );
  validateOptionalEnum(
    optimizer.objective,
    INTELLIGENCE_OBJECTIVES,
    `${basePath}.objective`,
    'invalid_intelligence_cost_optimizer',
    issues,
  );
  validateOptionalPositiveNumber(optimizer.history_window_hours, `${basePath}.history_window_hours`, 'invalid_intelligence_cost_optimizer', issues);
  validateOptionalPositiveNumber(optimizer.min_samples, `${basePath}.min_samples`, 'invalid_intelligence_cost_optimizer', issues);
  validateOptionalRatio(optimizer.min_savings_ratio, `${basePath}.min_savings_ratio`, 'invalid_intelligence_cost_optimizer', issues);
  validateOptionalRatio(optimizer.max_latency_penalty_ratio, `${basePath}.max_latency_penalty_ratio`, 'invalid_intelligence_cost_optimizer', issues);
  validateOptionalRatio(optimizer.max_quality_penalty, `${basePath}.max_quality_penalty`, 'invalid_intelligence_cost_optimizer', issues);
  validateOptionalBoolean(optimizer.allow_quality_critical_downgrade, `${basePath}.allow_quality_critical_downgrade`, 'invalid_intelligence_cost_optimizer', issues);
}

function validateIntelligenceTokenPrediction(
  tokenPrediction: unknown,
  issues: ConfigValidationIssue[],
): void {
  if (tokenPrediction === undefined) return;
  const basePath = 'intelligence.token_prediction';
  if (!isRecord(tokenPrediction)) {
    issues.push(issue('error', 'invalid_intelligence_token_prediction', `${basePath} must be an object.`, basePath));
    return;
  }
  validateOptionalBoolean(tokenPrediction.enabled, `${basePath}.enabled`, 'invalid_intelligence_token_prediction', issues);
  validateOptionalEnum(
    tokenPrediction.budget_policy,
    INTELLIGENCE_BUDGET_POLICIES,
    `${basePath}.budget_policy`,
    'invalid_intelligence_token_prediction',
    issues,
  );
  validateOptionalRatio(tokenPrediction.near_limit_ratio, `${basePath}.near_limit_ratio`, 'invalid_intelligence_token_prediction', issues);
  validateOptionalBoolean(tokenPrediction.allow_quality_critical_downgrade, `${basePath}.allow_quality_critical_downgrade`, 'invalid_intelligence_token_prediction', issues);
}

function validateIntelligenceAsyncEval(
  asyncEval: unknown,
  issues: ConfigValidationIssue[],
): void {
  if (asyncEval === undefined) return;
  const basePath = 'intelligence.async_eval';
  if (!isRecord(asyncEval)) {
    issues.push(issue('error', 'invalid_intelligence_async_eval', `${basePath} must be an object.`, basePath));
    return;
  }
  validateOptionalBoolean(asyncEval.enabled, `${basePath}.enabled`, 'invalid_intelligence_async_eval', issues);
  validateOptionalRatio(asyncEval.sample_rate, `${basePath}.sample_rate`, 'invalid_intelligence_async_eval', issues);
  validateOptionalBoolean(asyncEval.metadata_only, `${basePath}.metadata_only`, 'invalid_intelligence_async_eval', issues);
  validateOptionalPositiveNumber(asyncEval.max_recent_jobs, `${basePath}.max_recent_jobs`, 'invalid_intelligence_async_eval', issues);
  if (
    asyncEval.dimensions !== undefined &&
    (!Array.isArray(asyncEval.dimensions) || !asyncEval.dimensions.every(isNonEmptyString))
  ) {
    issues.push(
      issue(
        'error',
        'invalid_intelligence_async_eval',
        'intelligence.async_eval.dimensions must be an array of non-empty strings.',
        `${basePath}.dimensions`,
      ),
    );
  }
  if (asyncEval.metadata_only === false) {
    issues.push(
      issue(
        'warning',
        'intelligence_async_eval_content_storage',
        'intelligence.async_eval.metadata_only=false can require content access; keep it true unless evaluation sample storage is explicitly approved.',
        `${basePath}.metadata_only`,
      ),
    );
  }
}

function validateIntelligenceQualityGate(
  qualityGate: unknown,
  issues: ConfigValidationIssue[],
): void {
  if (qualityGate === undefined) return;
  const basePath = 'intelligence.quality_gate';
  if (!isRecord(qualityGate)) {
    issues.push(issue('error', 'invalid_intelligence_quality_gate', `${basePath} must be an object.`, basePath));
    return;
  }
  validateOptionalBoolean(qualityGate.enabled, `${basePath}.enabled`, 'invalid_intelligence_quality_gate', issues);
  if (qualityGate.rules === undefined) return;
  if (!Array.isArray(qualityGate.rules)) {
    issues.push(
      issue(
        'error',
        'invalid_intelligence_quality_gate',
        'intelligence.quality_gate.rules must be an array.',
        `${basePath}.rules`,
      ),
    );
    return;
  }
  for (const [index, rule] of qualityGate.rules.entries()) {
    const rulePath = `${basePath}.rules[${index}]`;
    if (!isRecord(rule)) {
      issues.push(issue('error', 'invalid_intelligence_quality_gate_rule', `${rulePath} must be an object.`, rulePath));
      continue;
    }
    if (!isNonEmptyString(rule.id)) {
      issues.push(issue('error', 'invalid_intelligence_quality_gate_rule', `${rulePath}.id must be a non-empty string.`, `${rulePath}.id`));
    }
    validateOptionalBoolean(rule.enabled, `${rulePath}.enabled`, 'invalid_intelligence_quality_gate_rule', issues);
    validateOptionalEnumArray(rule.source_formats, INTELLIGENCE_SOURCE_FORMATS, `${rulePath}.source_formats`, 'invalid_intelligence_quality_gate_rule', issues);
    validateOptionalEnumArray(rule.tiers, INTELLIGENCE_TIERS, `${rulePath}.tiers`, 'invalid_intelligence_quality_gate_rule', issues);
    validateOptionalStringArray(rule.models, `${rulePath}.models`, 'invalid_intelligence_quality_gate_rule', issues);
    validateOptionalStringArray(rule.agent_virtual_models, `${rulePath}.agent_virtual_models`, 'invalid_intelligence_quality_gate_rule', issues);
    validateOptionalBoolean(rule.require_text, `${rulePath}.require_text`, 'invalid_intelligence_quality_gate_rule', issues);
    validateOptionalPositiveNumber(rule.min_output_tokens, `${rulePath}.min_output_tokens`, 'invalid_intelligence_quality_gate_rule', issues);
    validateOptionalPositiveNumber(rule.max_latency_ms, `${rulePath}.max_latency_ms`, 'invalid_intelligence_quality_gate_rule', issues);
    validateOptionalStringArray(rule.fail_on_stop_reasons, `${rulePath}.fail_on_stop_reasons`, 'invalid_intelligence_quality_gate_rule', issues);
    validateOptionalEnumArray(rule.actions, INTELLIGENCE_QUALITY_GATE_ACTIONS, `${rulePath}.actions`, 'invalid_intelligence_quality_gate_rule', issues);
  }
}

function validateEmbeddingBatching(
  batching: unknown,
  issues: ConfigValidationIssue[],
): void {
  if (batching === undefined) return;
  if (!isRecord(batching)) {
    issues.push(
      issue(
        'error',
        'invalid_embedding_batching_config',
        'embedding_batching must be an object.',
        'embedding_batching',
      ),
    );
    return;
  }

  if (batching.enabled !== undefined && !isBoolean(batching.enabled)) {
    issues.push(
      issue(
        'error',
        'invalid_embedding_batching_config',
        'embedding_batching.enabled must be a boolean.',
        'embedding_batching.enabled',
      ),
    );
  }

  for (const key of [
    'window_ms',
    'max_batch_size',
    'max_input_items',
    'max_queue',
    'timeout_ms',
  ]) {
    if (
      batching[key] !== undefined &&
      (!isFiniteNumber(batching[key]) || batching[key] <= 0)
    ) {
      issues.push(
        issue(
          'error',
          'invalid_embedding_batching_config',
          `embedding_batching.${key} must be a positive number.`,
          `embedding_batching.${key}`,
        ),
      );
    }
  }
}

function validateRealtime(
  realtime: unknown,
  nodes: unknown,
  issues: ConfigValidationIssue[],
): void {
  if (realtime === undefined) return;
  if (!isRecord(realtime)) {
    issues.push(
      issue(
        'error',
        'invalid_section_type',
        'realtime must be an object when set.',
        'realtime',
      ),
    );
    return;
  }

  if (realtime.enabled !== undefined && !isBoolean(realtime.enabled)) {
    issues.push(
      issue(
        'error',
        'invalid_realtime_config',
        'realtime.enabled must be a boolean.',
        'realtime.enabled',
      ),
    );
  }
  if (
    realtime.path !== undefined &&
    (!isNonEmptyString(realtime.path) || !realtime.path.startsWith('/'))
  ) {
    issues.push(
      issue(
        'error',
        'invalid_realtime_config',
        'realtime.path must be a non-empty path starting with "/".',
        'realtime.path',
      ),
    );
  }

  for (const key of [
    'max_connections',
    'max_connections_per_node',
    'idle_timeout_ms',
    'upstream_connect_timeout_ms',
    'max_session_ms',
  ]) {
    validateOptionalPositiveNumber(
      realtime[key],
      `realtime.${key}`,
      'invalid_realtime_config',
      issues,
    );
  }

  if (realtime.default_node !== undefined && !isNonEmptyString(realtime.default_node)) {
    issues.push(
      issue(
        'error',
        'invalid_realtime_config',
        'realtime.default_node must be a non-empty string when set.',
        'realtime.default_node',
      ),
    );
  }
  if (realtime.default_model !== undefined && !isNonEmptyString(realtime.default_model)) {
    issues.push(
      issue(
        'error',
        'invalid_realtime_config',
        'realtime.default_model must be a non-empty string when set.',
        'realtime.default_model',
      ),
    );
  }

  const realtimeTargets: Array<{ node: string; model: string }> = [];
  if (Array.isArray(nodes)) {
    for (const node of nodes) {
      if (!isRecord(node) || !isNonEmptyString(node.id)) continue;
      for (const model of Array.isArray(node.realtime_models) ? node.realtime_models : []) {
        if (isNonEmptyString(model)) {
          realtimeTargets.push({ node: node.id, model });
        }
      }
    }
  }

  if (realtime.enabled === true && realtimeTargets.length === 0) {
    issues.push(
      issue(
        'error',
        'realtime_no_models',
        'realtime.enabled requires at least one nodes[].realtime_models entry.',
        'realtime.enabled',
      ),
    );
  }

  if (isNonEmptyString(realtime.default_node)) {
    const nodeTargets = realtimeTargets.filter(
      (target) => target.node === realtime.default_node,
    );
    if (nodeTargets.length === 0) {
      issues.push(
        issue(
          'error',
          'realtime_default_target_invalid',
          `realtime.default_node "${realtime.default_node}" does not expose realtime_models.`,
          'realtime.default_node',
        ),
      );
    } else if (
      isNonEmptyString(realtime.default_model) &&
      realtime.default_model !== 'auto' &&
      !nodeTargets.some((target) => target.model === realtime.default_model)
    ) {
      issues.push(
        issue(
          'error',
          'realtime_default_target_invalid',
          `realtime.default_model "${realtime.default_model}" is not listed under node "${realtime.default_node}" realtime_models.`,
          'realtime.default_model',
        ),
      );
    }
  } else if (
    isNonEmptyString(realtime.default_model) &&
    realtime.default_model !== 'auto' &&
    !realtimeTargets.some((target) => target.model === realtime.default_model)
  ) {
    issues.push(
      issue(
        'error',
        'realtime_default_target_invalid',
        `realtime.default_model "${realtime.default_model}" is not listed in any nodes[].realtime_models.`,
        'realtime.default_model',
      ),
    );
  }

  if (realtime.enabled === true) {
    issues.push(
      issue(
        'info',
        'realtime_experimental',
        'realtime is experimental: it performs WebSocket pass-through only and does not process audio locally.',
        'realtime.enabled',
      ),
    );
  }
}

function validateMcpGateway(
  mcp: unknown,
  namespaces: unknown,
  issues: ConfigValidationIssue[],
): void {
  if (mcp === undefined) return;
  if (!isRecord(mcp)) {
    issues.push(
      issue('error', 'invalid_mcp_config', 'mcp must be an object.', 'mcp'),
    );
    return;
  }

  if (mcp.enabled !== undefined && typeof mcp.enabled !== 'boolean') {
    issues.push(
      issue(
        'error',
        'invalid_mcp_config',
        'mcp.enabled must be a boolean.',
        'mcp.enabled',
      ),
    );
  }

  if (mcp.path !== undefined) {
    if (!isNonEmptyString(mcp.path) || !mcp.path.startsWith('/')) {
      issues.push(
        issue(
          'error',
          'invalid_mcp_config',
          'mcp.path must be an absolute HTTP path such as /mcp.',
          'mcp.path',
        ),
      );
    } else if (mcp.path !== '/mcp') {
      issues.push(
        issue(
          'warning',
          'mcp_custom_path_preview',
          'MCP Gateway preview currently exposes /mcp/:serverId; custom paths should be handled by a reverse proxy.',
          'mcp.path',
        ),
      );
    }
  }

  validateOptionalPositiveNumber(
    mcp.max_recent_calls,
    'mcp.max_recent_calls',
    'invalid_mcp_config',
    issues,
  );

  const namespaceIds = new Set<string>(
    Array.isArray(namespaces)
      ? namespaces.filter(isRecord).map((namespace) => namespace.id).filter(isNonEmptyString)
      : [],
  );

  if (mcp.servers === undefined) {
    if (mcp.enabled === true) {
      issues.push(
        issue(
          'warning',
          'mcp_no_servers',
          'mcp.enabled is true but no MCP servers are registered.',
          'mcp.servers',
        ),
      );
    }
    return;
  }

  if (!Array.isArray(mcp.servers)) {
    issues.push(
      issue(
        'error',
        'invalid_mcp_config',
        'mcp.servers must be an array when set.',
        'mcp.servers',
      ),
    );
    return;
  }

  const seenServerIds = new Set<string>();
  mcp.servers.forEach((server, index) => {
    const basePath = `mcp.servers[${index}]`;
    if (!isRecord(server)) {
      issues.push(
        issue(
          'error',
          'invalid_mcp_server',
          'MCP server entries must be objects.',
          basePath,
        ),
      );
      return;
    }

    if (!isNonEmptyString(server.id)) {
      issues.push(
        issue(
          'error',
          'missing_required_field',
          'mcp.servers[].id is required.',
          `${basePath}.id`,
        ),
      );
    } else {
      if (seenServerIds.has(server.id)) {
        issues.push(
          issue(
            'error',
            'duplicate_mcp_server_id',
            `MCP server id "${server.id}" is already used.`,
            `${basePath}.id`,
          ),
        );
      }
      seenServerIds.add(server.id);
    }

    if (server.enabled !== undefined && typeof server.enabled !== 'boolean') {
      issues.push(
        issue(
          'error',
          'invalid_mcp_server',
          'mcp.servers[].enabled must be a boolean.',
          `${basePath}.enabled`,
        ),
      );
    }

    const transport = typeof server.transport === 'string' ? server.transport : 'http_json_rpc';
    if (transport === 'stdio') {
      if (!isNonEmptyString(server.command)) {
        issues.push(
          issue(
            'error',
            'missing_required_field',
            'mcp.servers[].command is required when transport is stdio.',
            `${basePath}.command`,
          ),
        );
      }
    } else if (!isNonEmptyString(server.url)) {
      issues.push(
        issue(
          'error',
          'missing_required_field',
          'mcp.servers[].url is required for HTTP MCP transports.',
          `${basePath}.url`,
        ),
      );
    } else {
      validateHttpUrl(
        server.url,
        `${basePath}.url`,
        'invalid_mcp_server_url',
        issues,
      );
    }

    if (
      server.transport !== undefined &&
      server.transport !== 'http_json_rpc' &&
      server.transport !== 'streamable_http' &&
      server.transport !== 'sse' &&
      server.transport !== 'stdio'
    ) {
      issues.push(
        issue(
          'error',
          'invalid_mcp_server',
          'mcp.servers[].transport must be http_json_rpc, streamable_http, sse, or stdio.',
          `${basePath}.transport`,
        ),
      );
    }

    if (server.message_url !== undefined) {
      if (!isNonEmptyString(server.message_url)) {
        issues.push(
          issue(
            'error',
            'invalid_mcp_server_url',
            'mcp.servers[].message_url must be a non-empty HTTP URL or relative path when set.',
            `${basePath}.message_url`,
          ),
        );
      } else if (!server.message_url.startsWith('/')) {
        validateHttpUrl(
          server.message_url,
          `${basePath}.message_url`,
          'invalid_mcp_server_url',
          issues,
        );
      }
    }

    if (server.args !== undefined) {
      if (!Array.isArray(server.args) || !server.args.every((item) => typeof item === 'string')) {
        issues.push(
          issue(
            'error',
            'invalid_mcp_server',
            'mcp.servers[].args must be an array of strings when set.',
            `${basePath}.args`,
          ),
        );
      }
    }

    if (server.env !== undefined && !isRecord(server.env)) {
      issues.push(
        issue(
          'error',
          'invalid_mcp_server',
          'mcp.servers[].env must be an object.',
          `${basePath}.env`,
        ),
      );
    } else if (isRecord(server.env)) {
      for (const [envName, envValue] of Object.entries(server.env)) {
        if (!isNonEmptyString(envName) || typeof envValue !== 'string') {
          issues.push(
            issue(
              'error',
              'invalid_mcp_server',
              'MCP stdio env entries must be string key/value pairs.',
              `${basePath}.env.${envName}`,
            ),
          );
        }
      }
    }

    if (
      server.env_allowlist !== undefined &&
      (!Array.isArray(server.env_allowlist) || !server.env_allowlist.every(isNonEmptyString))
    ) {
      issues.push(
        issue(
          'error',
          'invalid_mcp_server',
          'mcp.servers[].env_allowlist must be an array of non-empty environment variable names when set.',
          `${basePath}.env_allowlist`,
        ),
      );
    }

    if (server.inherit_env !== undefined && typeof server.inherit_env !== 'boolean') {
      issues.push(
        issue(
          'error',
          'invalid_mcp_server',
          'mcp.servers[].inherit_env must be a boolean when set.',
          `${basePath}.inherit_env`,
        ),
      );
    } else if (transport === 'stdio' && server.inherit_env === true) {
      issues.push(
        issue(
          'warning',
          'mcp_stdio_inherit_env',
          'mcp.servers[].inherit_env=true passes the full gateway process environment to the stdio MCP server.',
          `${basePath}.inherit_env`,
        ),
      );
    }

    if (server.cwd !== undefined && !isNonEmptyString(server.cwd)) {
      issues.push(
        issue(
          'error',
          'invalid_mcp_server',
          'mcp.servers[].cwd must be a non-empty string when set.',
          `${basePath}.cwd`,
        ),
      );
    }

    validateReferenceArray(
      server.allowed_namespaces,
      `${basePath}.allowed_namespaces`,
      namespaceIds,
      'unknown_mcp_namespace',
      'MCP server allowed_namespaces references unknown namespace',
      issues,
    );

    if (server.headers !== undefined && !isRecord(server.headers)) {
      issues.push(
        issue(
          'error',
          'invalid_mcp_server',
          'mcp.servers[].headers must be an object.',
          `${basePath}.headers`,
        ),
      );
    } else if (isRecord(server.headers)) {
      for (const [headerName, headerValue] of Object.entries(server.headers)) {
        if (!isNonEmptyString(headerName) || typeof headerValue !== 'string') {
          issues.push(
            issue(
              'error',
              'invalid_mcp_server',
              'MCP server headers must be string key/value pairs.',
              `${basePath}.headers.${headerName}`,
            ),
          );
        }
      }
    }

    validateOptionalPositiveNumber(
      server.timeout_ms,
      `${basePath}.timeout_ms`,
      'invalid_mcp_server',
      issues,
    );
    validateOptionalPositiveNumber(
      server.max_request_bytes,
      `${basePath}.max_request_bytes`,
      'invalid_mcp_server',
      issues,
    );

    if (server.tools !== undefined) {
      if (!Array.isArray(server.tools)) {
        issues.push(
          issue(
            'error',
            'invalid_mcp_tools',
            'mcp.servers[].tools must be an array when set.',
            `${basePath}.tools`,
          ),
        );
      } else {
        const seenTools = new Set<string>();
        server.tools.forEach((tool, toolIndex) => {
          const toolPath = `${basePath}.tools[${toolIndex}]`;
          if (!isRecord(tool)) {
            issues.push(
              issue(
                'error',
                'invalid_mcp_tools',
                'MCP tool entries must be objects.',
                toolPath,
              ),
            );
            return;
          }
          if (!isNonEmptyString(tool.name)) {
            issues.push(
              issue(
                'error',
                'missing_required_field',
                'mcp.servers[].tools[].name is required.',
                `${toolPath}.name`,
              ),
            );
          } else {
            if (seenTools.has(tool.name)) {
              issues.push(
                issue(
                  'warning',
                  'duplicate_mcp_tool_name',
                  `MCP tool "${tool.name}" is listed more than once for this server.`,
                  `${toolPath}.name`,
                ),
              );
            }
            seenTools.add(tool.name);
          }
          if (tool.input_schema !== undefined && !isRecord(tool.input_schema)) {
            issues.push(
              issue(
                'error',
                'invalid_mcp_tools',
                'mcp.servers[].tools[].input_schema must be an object when set.',
                `${toolPath}.input_schema`,
              ),
            );
          }
        });
      }
    }
  });
}

function validateShadow(
  shadow: unknown,
  nodes: unknown,
  issues: ConfigValidationIssue[],
): void {
  if (shadow === undefined) return;
  if (!isRecord(shadow)) {
    issues.push(issue('error', 'invalid_section_type', 'shadow must be an object.', 'shadow'));
    return;
  }

  if (shadow.enabled !== undefined && !isBoolean(shadow.enabled)) {
    issues.push(issue('error', 'invalid_shadow_config', 'shadow.enabled must be a boolean.', 'shadow.enabled'));
  }
  if (
    shadow.sample_rate !== undefined &&
    (!isFiniteNumber(shadow.sample_rate) || shadow.sample_rate < 0 || shadow.sample_rate > 1)
  ) {
    issues.push(issue('error', 'invalid_shadow_config', 'shadow.sample_rate must be between 0 and 1.', 'shadow.sample_rate'));
  }
  if (
    shadow.timeout_ms !== undefined &&
    (!isFiniteNumber(shadow.timeout_ms) || shadow.timeout_ms <= 0)
  ) {
    issues.push(issue('error', 'invalid_shadow_config', 'shadow.timeout_ms must be a positive number.', 'shadow.timeout_ms'));
  }
  if (shadow.max_recent_results !== undefined) {
    const maxRecent = shadow.max_recent_results;
    if (!Number.isInteger(maxRecent) || typeof maxRecent !== 'number' || maxRecent < 1) {
      issues.push(issue('error', 'invalid_shadow_config', 'shadow.max_recent_results must be a positive integer.', 'shadow.max_recent_results'));
    }
  }

  const nodeList = Array.isArray(nodes) ? nodes.filter(isRecord) : [];
  const targetNode = isNonEmptyString(shadow.target_node)
    ? nodeList.find((node) => node.id === shadow.target_node)
    : undefined;

  if (shadow.enabled === true) {
    if (!isNonEmptyString(shadow.target_node)) {
      issues.push(issue('error', 'missing_shadow_target', 'shadow.target_node is required when shadow.enabled is true.', 'shadow.target_node'));
    } else if (!targetNode) {
      issues.push(issue('error', 'unknown_shadow_target_node', `shadow.target_node references unknown node "${shadow.target_node}".`, 'shadow.target_node'));
    }
  } else if (shadow.target_node !== undefined && !isNonEmptyString(shadow.target_node)) {
    issues.push(issue('error', 'invalid_shadow_config', 'shadow.target_node must be a non-empty string when set.', 'shadow.target_node'));
  } else if (shadow.target_node !== undefined && !targetNode) {
    issues.push(issue('error', 'unknown_shadow_target_node', `shadow.target_node references unknown node "${shadow.target_node}".`, 'shadow.target_node'));
  }

  if (shadow.target_model !== undefined) {
    if (!isNonEmptyString(shadow.target_model)) {
      issues.push(issue('error', 'invalid_shadow_config', 'shadow.target_model must be a non-empty string when set.', 'shadow.target_model'));
    } else if (targetNode) {
      const models = [
        ...(Array.isArray(targetNode.models) ? targetNode.models : []),
        ...(Array.isArray(targetNode.embedding_models) ? targetNode.embedding_models : []),
        ...(Array.isArray(targetNode.rerank_models) ? targetNode.rerank_models : []),
        ...(Array.isArray(targetNode.image_models) ? targetNode.image_models : []),
        ...(Array.isArray(targetNode.audio_models) ? targetNode.audio_models : []),
        ...(Array.isArray(targetNode.video_models) ? targetNode.video_models : []),
      ].filter(isNonEmptyString);
      if (models.length > 0 && !models.includes(shadow.target_model)) {
        issues.push(issue('warning', 'shadow_model_not_listed', `shadow.target_model "${shadow.target_model}" is not listed on node "${targetNode.id}". It will be passed through to the provider.`, 'shadow.target_model'));
      }
    }
  }

  if (shadow.compare !== undefined) {
    if (!isRecord(shadow.compare)) {
      issues.push(issue('error', 'invalid_shadow_config', 'shadow.compare must be an object.', 'shadow.compare'));
    } else {
      if (shadow.compare.store_prompts !== undefined && !isBoolean(shadow.compare.store_prompts)) {
        issues.push(issue('error', 'invalid_shadow_config', 'shadow.compare.store_prompts must be a boolean.', 'shadow.compare.store_prompts'));
      }
      if (shadow.compare.store_responses !== undefined && !isBoolean(shadow.compare.store_responses)) {
        issues.push(issue('error', 'invalid_shadow_config', 'shadow.compare.store_responses must be a boolean.', 'shadow.compare.store_responses'));
      }
      if (shadow.compare.sample_max_chars !== undefined) {
        const sampleMaxChars = shadow.compare.sample_max_chars;
        if (!Number.isInteger(sampleMaxChars) || typeof sampleMaxChars !== 'number' || sampleMaxChars < 100 || sampleMaxChars > 100000) {
          issues.push(issue('error', 'invalid_shadow_config', 'shadow.compare.sample_max_chars must be an integer between 100 and 100000.', 'shadow.compare.sample_max_chars'));
        }
      }
      if (shadow.compare.store_prompts === true || shadow.compare.store_responses === true) {
        issues.push(issue('warning', 'shadow_compare_storage_enabled', 'Shadow comparison storage is enabled. Samples are redacted and truncated, but prompts/responses are stored only because this was explicitly configured.', 'shadow.compare'));
      }
    }
  }
}

function validateCluster(
  cluster: unknown,
  state: unknown,
  issues: ConfigValidationIssue[],
): void {
  if (cluster === undefined) return;
  if (!isRecord(cluster)) {
    issues.push(
      issue(
        'error',
        'invalid_section_type',
        'cluster must be an object.',
        'cluster',
      ),
    );
    return;
  }

  if (cluster.enabled !== undefined && !isBoolean(cluster.enabled)) {
    issues.push(
      issue(
        'error',
        'invalid_cluster_config',
        'cluster.enabled must be a boolean.',
        'cluster.enabled',
      ),
    );
  }
  if (
    cluster.reload_broadcast !== undefined &&
    !isBoolean(cluster.reload_broadcast)
  ) {
    issues.push(
      issue(
        'error',
        'invalid_cluster_config',
        'cluster.reload_broadcast must be a boolean.',
        'cluster.reload_broadcast',
      ),
    );
  }
  if (
    cluster.instance_id !== undefined &&
    !isNonEmptyString(cluster.instance_id)
  ) {
    issues.push(
      issue(
        'error',
        'invalid_cluster_config',
        'cluster.instance_id must be a non-empty string when set.',
        'cluster.instance_id',
      ),
    );
  }

  validatePositiveNumber(
    cluster.heartbeat_interval_seconds,
    'cluster.heartbeat_interval_seconds',
    'invalid_cluster_config',
    issues,
  );
  validatePositiveNumber(
    cluster.heartbeat_ttl_seconds,
    'cluster.heartbeat_ttl_seconds',
    'invalid_cluster_config',
    issues,
  );

  if (
    isFiniteNumber(cluster.heartbeat_interval_seconds) &&
    isFiniteNumber(cluster.heartbeat_ttl_seconds) &&
    cluster.heartbeat_ttl_seconds <= cluster.heartbeat_interval_seconds
  ) {
    issues.push(
      issue(
        'warning',
        'cluster_heartbeat_ttl_short',
        'cluster.heartbeat_ttl_seconds should be greater than cluster.heartbeat_interval_seconds.',
        'cluster.heartbeat_ttl_seconds',
      ),
    );
  }

  if (cluster.redis !== undefined) {
    validateRedisConnection(cluster.redis, 'cluster.redis', issues);
  }

  const enabledByCluster = cluster.enabled === true;
  const enabledByState = isRecord(state) && state.backend === 'redis';
  if (enabledByCluster || enabledByState) {
    const redis = isRecord(cluster.redis)
      ? cluster.redis
      : isRecord(state) && isRecord(state.redis)
        ? state.redis
        : undefined;
    if (redis?.url !== undefined) {
      validateRedisUrl(
        redis.url,
        enabledByCluster ? 'cluster.redis.url' : 'state.redis.url',
        issues,
      );
    }
  }
}

function validateRedisConnection(
  redis: unknown,
  redisPath: string,
  issues: ConfigValidationIssue[],
): void {
  if (!isRecord(redis)) {
    issues.push(
      issue(
        'error',
        'invalid_redis_config',
        `${redisPath} must be an object.`,
        redisPath,
      ),
    );
    return;
  }
  if (redis.url !== undefined) {
    validateRedisUrl(redis.url, `${redisPath}.url`, issues);
  }
  if (redis.prefix !== undefined && !isNonEmptyString(redis.prefix)) {
    issues.push(
      issue(
        'error',
        'invalid_redis_config',
        `${redisPath}.prefix must be a non-empty string when set.`,
        `${redisPath}.prefix`,
      ),
    );
  }
}

function validateRedisUrl(
  value: unknown,
  valuePath: string,
  issues: ConfigValidationIssue[],
): void {
  if (!isNonEmptyString(value)) {
    issues.push(
      issue(
        'error',
        'invalid_redis_config',
        `${valuePath} must be a non-empty Redis URL when set.`,
        valuePath,
      ),
    );
    return;
  }
  if (containsEnvReference(value)) return;
  try {
    const url = new URL(value);
    if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') {
      issues.push(
        issue(
          'error',
          'invalid_redis_url',
          `${valuePath} must use redis:// or rediss://.`,
          valuePath,
        ),
      );
    }
  } catch {
    issues.push(
      issue(
        'error',
        'invalid_redis_url',
        `${valuePath} must be a valid Redis URL.`,
        valuePath,
      ),
    );
  }
}

function validateAlerts(
  alerts: unknown,
  issues: ConfigValidationIssue[],
): void {
  if (alerts === undefined) return;
  if (!isRecord(alerts)) {
    issues.push(
      issue(
        'error',
        'invalid_section_type',
        'alerts must be an object.',
        'alerts',
      ),
    );
    return;
  }

  if (alerts.enabled !== undefined && typeof alerts.enabled !== 'boolean') {
    issues.push(
      issue(
        'error',
        'invalid_alerts_config',
        'alerts.enabled must be a boolean.',
        'alerts.enabled',
      ),
    );
  }

  if (
    alerts.history_size !== undefined &&
    (!isFiniteNumber(alerts.history_size) || alerts.history_size <= 0)
  ) {
    issues.push(
      issue(
        'error',
        'invalid_alerts_config',
        'alerts.history_size must be a positive number.',
        'alerts.history_size',
      ),
    );
  }

  validateAlertSpikeRule(alerts.error_spike, 'alerts.error_spike', 'error_rate', issues);
  validateAlertSpikeRule(alerts.latency_spike, 'alerts.latency_spike', 'p95_ms', issues);
  validateAlertChannels(alerts.channels, issues);
}

function validateAlertSpikeRule(
  rule: unknown,
  rulePath: string,
  thresholdKey: 'error_rate' | 'p95_ms',
  issues: ConfigValidationIssue[],
): void {
  if (rule === undefined) return;
  if (!isRecord(rule)) {
    issues.push(
      issue(
        'error',
        'invalid_alert_spike_rule',
        `${rulePath} must be an object.`,
        rulePath,
      ),
    );
    return;
  }
  if (rule.enabled !== undefined && typeof rule.enabled !== 'boolean') {
    issues.push(
      issue(
        'error',
        'invalid_alert_spike_rule',
        `${rulePath}.enabled must be a boolean.`,
        `${rulePath}.enabled`,
      ),
    );
  }
  for (const key of ['window_seconds', 'min_requests']) {
    if (
      rule[key] !== undefined &&
      (!isFiniteNumber(rule[key]) || rule[key] <= 0)
    ) {
      issues.push(
        issue(
          'error',
          'invalid_alert_spike_rule',
          `${rulePath}.${key} must be a positive number.`,
          `${rulePath}.${key}`,
        ),
      );
    }
  }
  if (
    rule[thresholdKey] !== undefined &&
    (!isFiniteNumber(rule[thresholdKey]) || rule[thresholdKey] <= 0)
  ) {
    issues.push(
      issue(
        'error',
        'invalid_alert_spike_rule',
        `${rulePath}.${thresholdKey} must be a positive number.`,
        `${rulePath}.${thresholdKey}`,
      ),
    );
  }
  if (
    thresholdKey === 'error_rate' &&
    isFiniteNumber(rule.error_rate) &&
    rule.error_rate > 1
  ) {
    issues.push(
      issue(
        'error',
        'invalid_alert_spike_rule',
        'alerts.error_spike.error_rate must be between 0 and 1.',
        'alerts.error_spike.error_rate',
      ),
    );
  }
}

function validateAlertChannels(
  channels: unknown,
  issues: ConfigValidationIssue[],
): void {
  if (channels === undefined) return;
  if (!Array.isArray(channels)) {
    issues.push(
      issue(
        'error',
        'invalid_alert_channel',
        'alerts.channels must be an array.',
        'alerts.channels',
      ),
    );
    return;
  }

  channels.forEach((channel, index) => {
    const channelPath = `alerts.channels[${index}]`;
    if (!isRecord(channel)) {
      issues.push(
        issue(
          'error',
          'invalid_alert_channel',
          'Alert channel entries must be objects.',
          channelPath,
        ),
      );
      return;
    }
    if (!CONNECTOR_TYPES.includes(channel.type as never)) {
      issues.push(
        issue(
          'error',
          'invalid_alert_channel_type',
          'Supported alert connectors: webhook, feishu, wecom, telegram.',
          `${channelPath}.type`,
        ),
      );
    }
    if (channel.type !== 'telegram' && !isNonEmptyString(channel.url)) {
      issues.push(
        issue(
          'error',
          'missing_required_field',
          'Webhook alert channels require url.',
          `${channelPath}.url`,
        ),
      );
    } else if (isNonEmptyString(channel.url) && !containsEnvReference(channel.url)) {
      validateHttpUrl(
        channel.url,
        `${channelPath}.url`,
        'invalid_alert_webhook_url',
        issues,
      );
    }
    if (channel.name !== undefined && !isNonEmptyString(channel.name)) {
      issues.push(
        issue(
          'error',
          'invalid_alert_channel',
          'alerts.channels[].name must be a non-empty string when set.',
          `${channelPath}.name`,
        ),
      );
    }
    if (
      channel.debounce_seconds !== undefined &&
      (!isFiniteNumber(channel.debounce_seconds) || channel.debounce_seconds < 0)
    ) {
      issues.push(
        issue(
          'error',
          'invalid_alert_channel',
          'alerts.channels[].debounce_seconds must be a non-negative number.',
          `${channelPath}.debounce_seconds`,
        ),
      );
    }
    validateAlertChannelHeaders(channel.headers, channelPath, issues);
    validateAlertChannelEvents(channel.events, channelPath, issues);
    validateAlertChannelRetry(channel.retry, channelPath, issues);
    try { validateChannel(channel, { allowReferences: true }); } catch (error) {
      issues.push(issue('error', 'invalid_alert_channel', (error as Error).message, channelPath));
    }
  });
}

function validateAlertChannelHeaders(
  headers: unknown,
  channelPath: string,
  issues: ConfigValidationIssue[],
): void {
  if (headers === undefined) return;
  if (!isRecord(headers)) {
    issues.push(
      issue(
        'error',
        'invalid_alert_channel_headers',
        'alerts.channels[].headers must be an object.',
        `${channelPath}.headers`,
      ),
    );
    return;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (!isNonEmptyString(key) || !isNonEmptyString(value)) {
      issues.push(
        issue(
          'error',
          'invalid_alert_channel_headers',
          'Webhook alert headers must be non-empty string key/value pairs.',
          `${channelPath}.headers.${key}`,
        ),
      );
    }
  }
}

function validateAlertChannelEvents(
  events: unknown,
  channelPath: string,
  issues: ConfigValidationIssue[],
): void {
  if (events === undefined) return;
  if (!Array.isArray(events)) {
    issues.push(
      issue(
        'error',
        'invalid_alert_channel_events',
        'alerts.channels[].events must be an array.',
        `${channelPath}.events`,
      ),
    );
    return;
  }
  events.forEach((event, eventIndex) => {
    if (!isNonEmptyString(event) || !ALERT_EVENTS.has(event)) {
      issues.push(
        issue(
          'error',
          'invalid_alert_channel_event',
          `Unsupported alert event "${String(event)}".`,
          `${channelPath}.events[${eventIndex}]`,
        ),
      );
    }
  });
}

function validateAlertChannelRetry(
  retry: unknown,
  channelPath: string,
  issues: ConfigValidationIssue[],
): void {
  if (retry === undefined) return;
  if (!isRecord(retry)) {
    issues.push(
      issue(
        'error',
        'invalid_alert_channel_retry',
        'alerts.channels[].retry must be an object.',
        `${channelPath}.retry`,
      ),
    );
    return;
  }
  for (const key of ['attempts', 'timeout_ms']) {
    if (
      retry[key] !== undefined &&
      (!isFiniteNumber(retry[key]) || retry[key] <= 0)
    ) {
      issues.push(
        issue(
          'error',
          'invalid_alert_channel_retry',
          `alerts.channels[].retry.${key} must be a positive number.`,
          `${channelPath}.retry.${key}`,
        ),
      );
    }
  }
  if (
    retry.backoff_ms !== undefined &&
    (!isFiniteNumber(retry.backoff_ms) || retry.backoff_ms < 0)
  ) {
    issues.push(
      issue(
        'error',
        'invalid_alert_channel_retry',
        'alerts.channels[].retry.backoff_ms must be a non-negative number.',
        `${channelPath}.retry.backoff_ms`,
      ),
    );
  }
}

function validateLogging(
  logging: unknown,
  issues: ConfigValidationIssue[],
): void {
  if (logging === undefined) return;
  if (!isRecord(logging)) {
    issues.push(
      issue(
        'error',
        'invalid_section_type',
        'logging must be an object.',
        'logging',
      ),
    );
    return;
  }

  if (logging.enabled !== undefined && typeof logging.enabled !== 'boolean') {
    issues.push(
      issue(
        'error',
        'invalid_logging_config',
        'logging.enabled must be a boolean.',
        'logging.enabled',
      ),
    );
  }

  if (logging.sinks === undefined) return;
  if (!Array.isArray(logging.sinks)) {
    issues.push(
      issue(
        'error',
        'invalid_log_sinks',
        'logging.sinks must be an array.',
        'logging.sinks',
      ),
    );
    return;
  }

  logging.sinks.forEach((sink, index) =>
    validateLogSink(sink, `logging.sinks[${index}]`, issues),
  );
}

function validateState(
  state: unknown,
  issues: ConfigValidationIssue[],
): void {
  if (state === undefined) return;
  if (!isRecord(state)) {
    issues.push(
      issue(
        'error',
        'invalid_section_type',
        'state must be an object.',
        'state',
      ),
    );
    return;
  }

  const backend = state.backend ?? 'memory';
  if (!isNonEmptyString(backend) || !STATE_BACKENDS.has(backend)) {
    issues.push(
      issue(
        'error',
        'invalid_state_backend',
        'state.backend must be "memory" or "redis".',
        'state.backend',
      ),
    );
  }

  if (
    state.unavailable_policy !== undefined &&
    (!isNonEmptyString(state.unavailable_policy) ||
      !STATE_UNAVAILABLE_POLICIES.has(state.unavailable_policy))
  ) {
    issues.push(
      issue(
        'error',
        'invalid_state_unavailable_policy',
        'state.unavailable_policy must be "fail_open" or "fail_closed".',
        'state.unavailable_policy',
      ),
    );
  }

  if (state.redis !== undefined && !isRecord(state.redis)) {
    issues.push(
      issue(
        'error',
        'invalid_state_redis',
        'state.redis must be an object.',
        'state.redis',
      ),
    );
    return;
  }

  const redis = isRecord(state.redis) ? state.redis : undefined;
  if (redis?.url !== undefined) {
    if (isNonEmptyString(redis.url)) {
      validateRedisStateUrl(redis.url, issues);
    } else {
      issues.push(
        issue(
          'error',
          'invalid_state_redis_url',
          'state.redis.url must be a non-empty redis:// or rediss:// URL.',
          'state.redis.url',
        ),
      );
    }
  } else if (backend === 'redis') {
    issues.push(
      issue(
        'error',
        'missing_required_field',
        'state.redis.url is required when state.backend is "redis".',
        'state.redis.url',
      ),
    );
  }

  if (
    redis?.prefix !== undefined &&
    (!isNonEmptyString(redis.prefix) || redis.prefix.includes(' '))
  ) {
    issues.push(
      issue(
        'error',
        'invalid_state_redis_prefix',
        'state.redis.prefix must be a non-empty string without spaces.',
        'state.redis.prefix',
      ),
    );
  }

  for (const field of ['timeout_ms', 'sync_interval_ms']) {
    if (
      redis?.[field] !== undefined &&
      (!isFiniteNumber(redis[field]) || redis[field] <= 0)
    ) {
      issues.push(
        issue(
          'error',
          'invalid_state_redis_number',
          `state.redis.${field} must be a positive number.`,
          `state.redis.${field}`,
        ),
      );
    }
  }

  if (state.categories !== undefined) {
    if (!isRecord(state.categories)) {
      issues.push(
        issue(
          'error',
          'invalid_state_categories',
          'state.categories must be an object keyed by known state categories.',
          'state.categories',
        ),
      );
      return;
    }

    for (const [category, config] of Object.entries(state.categories)) {
      const basePath = `state.categories.${category}`;
      if (!STATE_CATEGORIES.has(category)) {
        issues.push(
          issue(
            'error',
            'invalid_state_category',
            `Unknown state category "${category}".`,
            basePath,
          ),
        );
        continue;
      }
      if (!isRecord(config)) {
        issues.push(
          issue(
            'error',
            'invalid_state_category',
            `${basePath} must be an object.`,
            basePath,
          ),
        );
        continue;
      }
      if (
        config.unavailable_policy !== undefined &&
        (!isNonEmptyString(config.unavailable_policy) ||
          !STATE_UNAVAILABLE_POLICIES.has(config.unavailable_policy))
      ) {
        issues.push(
          issue(
            'error',
            'invalid_state_category_policy',
            `${basePath}.unavailable_policy must be "fail_open" or "fail_closed".`,
            `${basePath}.unavailable_policy`,
          ),
        );
      }
      if (
        config.ttl_seconds !== undefined &&
        (!isFiniteNumber(config.ttl_seconds) || config.ttl_seconds <= 0)
      ) {
        issues.push(
          issue(
            'error',
            'invalid_state_category_ttl',
            `${basePath}.ttl_seconds must be a positive number.`,
            `${basePath}.ttl_seconds`,
          ),
        );
      }
    }
  }
}

function validateRedisStateUrl(
  value: string,
  issues: ConfigValidationIssue[],
): void {
  if (HAS_CONFIG_REF_PATTERN.test(value)) return;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    issues.push(
      issue(
        'error',
        'invalid_state_redis_url',
        'state.redis.url must be a valid redis:// or rediss:// URL.',
        'state.redis.url',
      ),
    );
    return;
  }
  if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') {
    issues.push(
      issue(
        'error',
        'invalid_state_redis_url',
        'state.redis.url must use redis:// or rediss://.',
        'state.redis.url',
      ),
    );
  }
  if (url.protocol === 'redis:' && !isLocalhostUrl(url)) {
    issues.push(
      issue(
        'warning',
        'insecure_state_redis_url',
        'state.redis.url uses plain redis:// outside localhost; use rediss:// or a private network for shared state.',
        'state.redis.url',
      ),
    );
  }
}

function validateLogSink(
  sink: unknown,
  sinkPath: string,
  issues: ConfigValidationIssue[],
): void {
  if (!isRecord(sink)) {
    issues.push(
      issue(
        'error',
        'invalid_log_sink',
        'Log sink entries must be objects.',
        sinkPath,
      ),
    );
    return;
  }

  if (!isNonEmptyString(sink.type) || !LOG_SINK_TYPES.has(sink.type)) {
    issues.push(
      issue(
        'error',
        'invalid_log_sink_type',
        'Log sink type must be one of file, webhook, s3, elasticsearch.',
        `${sinkPath}.type`,
      ),
    );
  }
  if (sink.enabled !== undefined && typeof sink.enabled !== 'boolean') {
    issues.push(
      issue(
        'error',
        'invalid_log_sink',
        'logging.sinks[].enabled must be a boolean.',
        `${sinkPath}.enabled`,
      ),
    );
  }
  if (sink.name !== undefined && !isNonEmptyString(sink.name)) {
    issues.push(
      issue(
        'error',
        'invalid_log_sink',
        'logging.sinks[].name must be a non-empty string when set.',
        `${sinkPath}.name`,
      ),
    );
  }
  validatePositiveNumber(sink.batch_size, `${sinkPath}.batch_size`, 'invalid_log_sink_batching', issues);
  validatePositiveNumber(sink.flush_interval_ms, `${sinkPath}.flush_interval_ms`, 'invalid_log_sink_batching', issues);
  validatePositiveNumber(sink.max_queue, `${sinkPath}.max_queue`, 'invalid_log_sink_queue', issues);
  if (
    sink.overflow !== undefined &&
    (!isNonEmptyString(sink.overflow) || !LOG_SINK_OVERFLOW_POLICIES.has(sink.overflow))
  ) {
    issues.push(
      issue(
        'error',
        'invalid_log_sink_queue',
        'logging.sinks[].overflow must be drop_oldest or drop_newest.',
        `${sinkPath}.overflow`,
      ),
    );
  }

  validateLogSinkFields(sink.fields, `${sinkPath}.fields`, issues);
  validateLogSinkFields(sink.exclude_fields, `${sinkPath}.exclude_fields`, issues);
  validateLogSinkRetry(sink.retry, sinkPath, issues);

  if (sink.type === 'file') {
    if (!isNonEmptyString(sink.path)) {
      issues.push(
        issue(
          'error',
          'missing_log_sink_field',
          'file log sinks require path.',
          `${sinkPath}.path`,
        ),
      );
    }
  } else if (sink.type === 'webhook') {
    validateLogSinkUrl(sink.url, `${sinkPath}.url`, 'invalid_log_sink_url', issues);
    validateLogSinkHeaders(sink.headers, `${sinkPath}.headers`, issues);
  } else if (sink.type === 'elasticsearch') {
    validateLogSinkUrl(sink.url, `${sinkPath}.url`, 'invalid_log_sink_url', issues);
    if (!isNonEmptyString(sink.index)) {
      issues.push(
        issue(
          'error',
          'missing_log_sink_field',
          'elasticsearch log sinks require index.',
          `${sinkPath}.index`,
        ),
      );
    }
    validateLogSinkHeaders(sink.headers, `${sinkPath}.headers`, issues);
  } else if (sink.type === 's3') {
    if (!isNonEmptyString(sink.bucket)) {
      issues.push(
        issue(
          'error',
          'missing_log_sink_field',
          's3 log sinks require bucket.',
          `${sinkPath}.bucket`,
        ),
      );
    }
    if (sink.enabled !== false) {
      issues.push(
        issue(
          'warning',
          'log_sink_interface_only',
          's3 log sink config is reserved as an interface placeholder in the OSS data plane.',
          sinkPath,
        ),
      );
    }
  }
}

function validatePositiveNumber(
  value: unknown,
  valuePath: string,
  code: string,
  issues: ConfigValidationIssue[],
): void {
  if (value === undefined) return;
  if (!isFiniteNumber(value) || value <= 0) {
    issues.push(
      issue(
        'error',
        code,
        `${valuePath} must be a positive number.`,
        valuePath,
      ),
    );
  }
}

function validateLogSinkUrl(
  value: unknown,
  valuePath: string,
  code: string,
  issues: ConfigValidationIssue[],
): void {
  if (!isNonEmptyString(value)) {
    issues.push(
      issue(
        'error',
        'missing_log_sink_field',
        `${valuePath} is required.`,
        valuePath,
      ),
    );
    return;
  }
  if (!containsEnvReference(value)) {
    validateHttpUrl(value, valuePath, code, issues);
  }
}

function validateLogSinkHeaders(
  headers: unknown,
  headerPath: string,
  issues: ConfigValidationIssue[],
): void {
  if (headers === undefined) return;
  if (!isRecord(headers)) {
    issues.push(
      issue(
        'error',
        'invalid_log_sink_headers',
        'log sink headers must be an object.',
        headerPath,
      ),
    );
    return;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (!isNonEmptyString(key) || !isNonEmptyString(value)) {
      issues.push(
        issue(
          'error',
          'invalid_log_sink_headers',
          'log sink headers must be non-empty string key/value pairs.',
          `${headerPath}.${key}`,
        ),
      );
    }
  }
}

function validateLogSinkFields(
  fields: unknown,
  fieldPath: string,
  issues: ConfigValidationIssue[],
): void {
  if (fields === undefined) return;
  if (!Array.isArray(fields)) {
    issues.push(
      issue(
        'error',
        'invalid_log_sink_fields',
        `${fieldPath} must be an array.`,
        fieldPath,
      ),
    );
    return;
  }
  fields.forEach((field, index) => {
    const itemPath = `${fieldPath}[${index}]`;
    if (!isNonEmptyString(field)) {
      issues.push(
        issue(
          'error',
          'invalid_log_sink_fields',
          'log sink field names must be non-empty strings.',
          itemPath,
        ),
      );
      return;
    }
    if (isSensitiveLogField(field)) {
      issues.push(
        issue(
          'warning',
          'log_sink_sensitive_field_ignored',
          `Sensitive log sink field "${field}" will be ignored by the sanitizer.`,
          itemPath,
        ),
      );
    }
  });
}

function validateLogSinkRetry(
  retry: unknown,
  sinkPath: string,
  issues: ConfigValidationIssue[],
): void {
  if (retry === undefined) return;
  if (!isRecord(retry)) {
    issues.push(
      issue(
        'error',
        'invalid_log_sink_retry',
        'logging.sinks[].retry must be an object.',
        `${sinkPath}.retry`,
      ),
    );
    return;
  }
  for (const key of ['attempts', 'timeout_ms']) {
    validatePositiveNumber(
      retry[key],
      `${sinkPath}.retry.${key}`,
      'invalid_log_sink_retry',
      issues,
    );
  }
  if (
    retry.backoff_ms !== undefined &&
    (!isFiniteNumber(retry.backoff_ms) || retry.backoff_ms < 0)
  ) {
    issues.push(
      issue(
        'error',
        'invalid_log_sink_retry',
        'logging.sinks[].retry.backoff_ms must be a non-negative number.',
        `${sinkPath}.retry.backoff_ms`,
      ),
    );
  }
}

function isSensitiveLogField(field: string): boolean {
  const normalized = field.toLowerCase().replace(/[^a-z0-9]/g, '');
  return new Set([
    'prompt',
    'response',
    'requestbody',
    'responsebody',
    'messages',
    'content',
    'rawheaders',
    'headers',
    'authorization',
    'providerkey',
    'providerapikey',
    'apikey',
    'password',
    'secret',
    'token',
    'bearer',
  ]).has(normalized);
}

function validatePricing(
  pricing: unknown,
  issues: ConfigValidationIssue[],
): void {
  if (pricing === undefined) return;
  if (!isRecord(pricing)) {
    issues.push(
      issue(
        'error',
        'invalid_section_type',
        'models_pricing must be an object.',
        'models_pricing',
      ),
    );
    return;
  }

  for (const [model, entry] of Object.entries(pricing)) {
    const pricingPath = `models_pricing.${model}`;
    validatePricingEntry(entry, pricingPath, issues);
  }
}

function validatePricingEntry(
  entry: unknown,
  pricingPath: string,
  issues: ConfigValidationIssue[],
): void {
  if (!isRecord(entry)) {
    issues.push(
      issue(
        'error',
        'invalid_pricing_entry',
        'Pricing entry must be an object.',
        pricingPath,
      ),
    );
    return;
  }
  for (const key of ['input', 'output']) {
    if (!isFiniteNumber(entry[key]) || entry[key] < 0) {
      issues.push(
        issue(
          'error',
          'invalid_pricing_entry',
          `${pricingPath}.${key} must be a non-negative number.`,
          `${pricingPath}.${key}`,
        ),
      );
    }
  }
  for (const key of [
    'cache_creation_input',
    'cache_read_input',
    'input_per_1m_tokens',
    'output_per_1m_tokens',
    'cache_read_per_1m_tokens',
    'cache_write_per_1m_tokens',
    'embedding_per_1m_tokens',
    'rerank_per_1k_requests',
    'rerank_per_1k_docs',
    'image_per_generation',
    'image_per_edit',
    'audio_per_minute',
    'audio_per_1m_chars',
    'video_per_second',
    'video_per_generation',
    'realtime_per_minute',
    'batch_discount',
  ]) {
    if (entry[key] !== undefined && (!isFiniteNumber(entry[key]) || entry[key] < 0)) {
      issues.push(
        issue(
          'error',
          'invalid_pricing_entry',
          `${pricingPath}.${key} must be a non-negative number when set.`,
          `${pricingPath}.${key}`,
        ),
      );
    }
  }
}

function validateSecretManager(
  secretManager: unknown,
  issues: ConfigValidationIssue[],
): void {
  if (secretManager === undefined) return;
  if (!isRecord(secretManager)) {
    issues.push(
      issue(
        'error',
        'invalid_secret_manager',
        'secret_manager must be an object when configured.',
        'secret_manager',
      ),
    );
    return;
  }

  if (
    secretManager.cache_ttl_seconds !== undefined &&
    (!isFiniteNumber(secretManager.cache_ttl_seconds) ||
      secretManager.cache_ttl_seconds < 0)
  ) {
    issues.push(
      issue(
        'error',
        'invalid_secret_manager_cache_ttl',
        'secret_manager.cache_ttl_seconds must be a non-negative number.',
        'secret_manager.cache_ttl_seconds',
      ),
    );
  }

  if (
    secretManager.failure_policy !== undefined &&
    secretManager.failure_policy !== 'fail_closed' &&
    secretManager.failure_policy !== 'fail_open_for_optional'
  ) {
    issues.push(
      issue(
        'error',
        'invalid_secret_manager_failure_policy',
        'secret_manager.failure_policy must be fail_closed or fail_open_for_optional.',
        'secret_manager.failure_policy',
      ),
    );
  }

  const backends = secretManager.backends;
  if (backends === undefined) return;
  if (!isRecord(backends)) {
    issues.push(
      issue(
        'error',
        'invalid_secret_manager_backends',
        'secret_manager.backends must be an object when configured.',
        'secret_manager.backends',
      ),
    );
    return;
  }

  validateSecretBackendEnabled(backends.env, 'secret_manager.backends.env', issues);
  validateSecretBackendEnabled(backends.vault, 'secret_manager.backends.vault', issues);
  validateSecretBackendEnabled(backends.aws_sm, 'secret_manager.backends.aws_sm', issues);
  validateSecretBackendEnabled(backends.gcp_sm, 'secret_manager.backends.gcp_sm', issues);

  if (isRecord(backends.vault)) {
    validateSecretManagerCredential(
      backends.vault.token,
      'secret_manager.backends.vault.token',
      issues,
    );
    if (
      backends.vault.kv_version !== undefined &&
      backends.vault.kv_version !== 1 &&
      backends.vault.kv_version !== 2
    ) {
      issues.push(
        issue(
          'error',
          'invalid_secret_manager_vault_kv_version',
          'secret_manager.backends.vault.kv_version must be 1 or 2.',
          'secret_manager.backends.vault.kv_version',
        ),
      );
    }
    validateOptionalPositiveNumber(
      backends.vault.timeout_ms,
      'secret_manager.backends.vault.timeout_ms',
      'invalid_secret_manager_timeout',
      issues,
    );
  }

  if (isRecord(backends.aws_sm)) {
    validateSecretManagerCredential(
      backends.aws_sm.secret_access_key,
      'secret_manager.backends.aws_sm.secret_access_key',
      issues,
    );
    validateSecretManagerCredential(
      backends.aws_sm.session_token,
      'secret_manager.backends.aws_sm.session_token',
      issues,
    );
    validateOptionalPositiveNumber(
      backends.aws_sm.timeout_ms,
      'secret_manager.backends.aws_sm.timeout_ms',
      'invalid_secret_manager_timeout',
      issues,
    );
  }

  if (isRecord(backends.gcp_sm)) {
    validateSecretManagerCredential(
      backends.gcp_sm.access_token,
      'secret_manager.backends.gcp_sm.access_token',
      issues,
    );
    validateOptionalPositiveNumber(
      backends.gcp_sm.timeout_ms,
      'secret_manager.backends.gcp_sm.timeout_ms',
      'invalid_secret_manager_timeout',
      issues,
    );
    if (
      backends.gcp_sm.use_metadata !== undefined &&
      !isBoolean(backends.gcp_sm.use_metadata)
    ) {
      issues.push(
        issue(
          'error',
          'invalid_secret_manager_gcp_metadata',
          'secret_manager.backends.gcp_sm.use_metadata must be a boolean.',
          'secret_manager.backends.gcp_sm.use_metadata',
        ),
      );
    }
  }
}

function validateSecretManagerCredential(
  value: unknown,
  issuePath: string,
  issues: ConfigValidationIssue[],
): void {
  if (!isNonEmptyString(value)) return;
  if (containsEnvReference(value)) return;
  if (!looksLikeSecret(value)) return;
  issues.push(
    issue(
      'warning',
      'literal_secret_manager_credential',
      `${issuePath} looks like a literal secret; use an env reference such as \${env:SECRET_MANAGER_TOKEN}.`,
      issuePath,
    ),
  );
}

function validateSecretBackendEnabled(
  backend: unknown,
  issuePath: string,
  issues: ConfigValidationIssue[],
): void {
  if (backend === undefined) return;
  if (!isRecord(backend)) {
    issues.push(
      issue(
        'error',
        'invalid_secret_manager_backend',
        `${issuePath} must be an object when configured.`,
        issuePath,
      ),
    );
    return;
  }
  if (backend.enabled !== undefined && !isBoolean(backend.enabled)) {
    issues.push(
      issue(
        'error',
        'invalid_secret_manager_backend_enabled',
        `${issuePath}.enabled must be a boolean when set.`,
        `${issuePath}.enabled`,
      ),
    );
  }
}

function secretBackendState(
  secretManager: unknown,
): Record<SecretReferenceBackend, boolean> {
  if (!isRecord(secretManager)) {
    return {
      env: true,
      vault: false,
      'aws-sm': false,
      'gcp-sm': false,
    };
  }
  const backends = isRecord(secretManager.backends)
    ? secretManager.backends
    : {};
  return {
    env: isRecord(backends.env) ? backends.env.enabled !== false : true,
    vault: isRecord(backends.vault) ? backends.vault.enabled === true : false,
    'aws-sm': isRecord(backends.aws_sm)
      ? backends.aws_sm.enabled === true
      : false,
    'gcp-sm': isRecord(backends.gcp_sm)
      ? backends.gcp_sm.enabled === true
      : false,
  };
}

function validateCatalogConfig(
  catalog: unknown,
  issues: ConfigValidationIssue[],
): void {
  if (catalog === undefined) return;
  if (!isRecord(catalog)) {
    issues.push(
      issue(
        'error',
        'invalid_catalog_config',
        'catalog must be an object when set.',
        'catalog',
      ),
    );
    return;
  }
  if (
    catalog.override_file !== undefined &&
    !isNonEmptyString(catalog.override_file)
  ) {
    issues.push(
      issue(
        'error',
        'invalid_catalog_override_file',
        'catalog.override_file must be a non-empty path when set.',
        'catalog.override_file',
      ),
    );
  }
  const sync = catalog.sync;
  if (sync === undefined) return;
  if (!isRecord(sync)) {
    issues.push(
      issue(
        'error',
        'invalid_catalog_sync_config',
        'catalog.sync must be an object when set.',
        'catalog.sync',
      ),
    );
    return;
  }
  if (sync.enabled !== undefined && typeof sync.enabled !== 'boolean') {
    issues.push(
      issue(
        'error',
        'invalid_catalog_sync_enabled',
        'catalog.sync.enabled must be a boolean.',
        'catalog.sync.enabled',
      ),
    );
  }
  if (
    sync.interval_minutes !== undefined &&
    (!isFiniteNumber(sync.interval_minutes) || sync.interval_minutes <= 0)
  ) {
    issues.push(
      issue(
        'error',
        'invalid_catalog_sync_interval',
        'catalog.sync.interval_minutes must be a positive number.',
        'catalog.sync.interval_minutes',
      ),
    );
  }
  if (sync.run_on_startup !== undefined && typeof sync.run_on_startup !== 'boolean') {
    issues.push(
      issue(
        'error',
        'invalid_catalog_sync_run_on_startup',
        'catalog.sync.run_on_startup must be a boolean.',
        'catalog.sync.run_on_startup',
      ),
    );
  }
  if (
    sync.write_to !== undefined &&
    sync.write_to !== 'cache' &&
    sync.write_to !== 'override'
  ) {
    issues.push(
      issue(
        'error',
        'invalid_catalog_sync_write_to',
        'catalog.sync.write_to must be cache or override.',
        'catalog.sync.write_to',
      ),
    );
  }
  for (const key of ['cache_file', 'override_file']) {
    if (sync[key] !== undefined && !isNonEmptyString(sync[key])) {
      issues.push(
        issue(
          'error',
          'invalid_catalog_sync_path',
          `catalog.sync.${key} must be a non-empty path when set.`,
          `catalog.sync.${key}`,
        ),
      );
    }
  }
  if (sync.adapters !== undefined && !isRecord(sync.adapters)) {
    issues.push(
      issue(
        'error',
        'invalid_catalog_sync_adapters',
        'catalog.sync.adapters must be an object keyed by provider id.',
        'catalog.sync.adapters',
      ),
    );
  }
  const adapters = isRecord(sync.adapters) ? sync.adapters : {};
  const automaticCatalogSyncAdapters = new Set(['openrouter', 'zeroeval']);
  let enabledSupportedAdapters = 0;
  for (const [provider, adapter] of Object.entries(adapters)) {
    if (!isRecord(adapter)) {
      issues.push(
        issue(
          'error',
          'invalid_catalog_sync_adapter',
          `catalog.sync.adapters.${provider} must be an object.`,
          `catalog.sync.adapters.${provider}`,
        ),
      );
      continue;
    }
    if (adapter.enabled !== undefined && typeof adapter.enabled !== 'boolean') {
      issues.push(
        issue(
          'error',
          'invalid_catalog_sync_adapter_enabled',
          `catalog.sync.adapters.${provider}.enabled must be a boolean.`,
          `catalog.sync.adapters.${provider}.enabled`,
        ),
      );
    }
    if (adapter.enabled === true && automaticCatalogSyncAdapters.has(provider)) {
      enabledSupportedAdapters += 1;
    } else if (adapter.enabled === true) {
      issues.push(
        issue(
          'warning',
          'catalog_sync_adapter_manual_only',
          `catalog.sync adapter "${provider}" is not automatic yet; use docs review or local override.`,
          `catalog.sync.adapters.${provider}`,
        ),
      );
    }
  }
  if (sync.enabled === true && enabledSupportedAdapters === 0) {
    issues.push(
      issue(
        'warning',
        'catalog_sync_no_enabled_adapter',
        'catalog.sync.enabled is true but no supported provider adapter is explicitly enabled.',
        'catalog.sync.adapters',
      ),
    );
  }
}

function addCatalogIssues(
  catalogIssues: CatalogIssue[] | undefined,
  issues: ConfigValidationIssue[],
): void {
  for (const catalogIssue of catalogIssues || []) {
    issues.push(
      issue(
        catalogIssue.severity,
        catalogIssue.code,
        catalogIssue.message,
        catalogIssue.path,
      ),
    );
  }
}

function validateConfigAgainstCatalog(
  config: Partial<GatewayConfig> & Record<string, unknown>,
  catalog: ProviderCatalog | undefined,
  issues: ConfigValidationIssue[],
): void {
  if (!catalog || !Array.isArray(config.nodes)) return;

  const catalogModelIds = new Set(
    flattenCatalogModels(catalog).map((model) => model.id),
  );
  const costOptimization = isRecord(config.routing) &&
    (config.routing.optimization === 'cost' || config.routing.optimization === 'balanced');

  config.nodes.forEach((nodeValue, nodeIndex) => {
    if (!isRecord(nodeValue)) return;
    const node = nodeValue as Record<string, unknown>;
    const basePath = `nodes[${nodeIndex}]`;
    const provider = catalogProviderForNode(catalog, node);
    if (!provider) {
      issues.push(
        issue(
          'info',
          'catalog_unknown_provider',
          `Node "${String(node.id || '')}" does not match a built-in provider catalog entry. SiftGate will treat it as a custom provider; add catalog.override.yaml metadata for model, endpoint, and pricing validation.`,
          `${basePath}.base_url`,
        ),
      );
    } else {
      validateCatalogAuthTypeMatch(node, provider, basePath, issues);
    }
    validateNodeCompatibilityAgainstCatalog(node, provider, catalog, basePath, issues);

    validateCatalogEndpointMatch(
      node,
      provider,
      node.protocol,
      node.endpoint,
      `${basePath}.endpoint`,
      issues,
    );
    validateCatalogEndpointMatch(
      node,
      provider,
      'embeddings',
      node.embeddings_endpoint,
      `${basePath}.embeddings_endpoint`,
      issues,
    );
    validateCatalogEndpointMatch(
      node,
      provider,
      'rerank',
      node.rerank_endpoint,
      `${basePath}.rerank_endpoint`,
      issues,
    );
    validateCatalogEndpointMatch(
      node,
      provider,
      'image',
      node.images_generations_endpoint,
      `${basePath}.images_generations_endpoint`,
      issues,
    );
    validateCatalogEndpointMatch(
      node,
      provider,
      'audio',
      node.audio_transcriptions_endpoint,
      `${basePath}.audio_transcriptions_endpoint`,
      issues,
    );
    validateCatalogEndpointMatch(
      node,
      provider,
      'realtime',
      node.realtime_endpoint,
      `${basePath}.realtime_endpoint`,
      issues,
    );
    validateCatalogEndpointMatch(
      node,
      provider,
      'batch',
      node.batch_endpoint,
      `${basePath}.batch_endpoint`,
      issues,
    );

    validateCatalogModelsForBucket(
      catalog,
      catalogModelIds,
      stringArray(node.models),
      `${basePath}.models`,
      ['text', 'vision'],
      config,
      node,
      costOptimization,
      issues,
    );
    validateCatalogModelsForBucket(
      catalog,
      catalogModelIds,
      stringArray(node.embedding_models),
      `${basePath}.embedding_models`,
      ['embedding'],
      config,
      node,
      costOptimization,
      issues,
    );
    validateCatalogModelsForBucket(
      catalog,
      catalogModelIds,
      stringArray(node.rerank_models),
      `${basePath}.rerank_models`,
      ['rerank'],
      config,
      node,
      costOptimization,
      issues,
    );
    validateCatalogModelsForBucket(
      catalog,
      catalogModelIds,
      stringArray(node.image_models),
      `${basePath}.image_models`,
      ['image', 'vision'],
      config,
      node,
      costOptimization,
      issues,
    );
    validateCatalogModelsForBucket(
      catalog,
      catalogModelIds,
      stringArray(node.audio_models),
      `${basePath}.audio_models`,
      ['audio'],
      config,
      node,
      costOptimization,
      issues,
    );
    validateCatalogModelsForBucket(
      catalog,
      catalogModelIds,
      stringArray(node.video_models),
      `${basePath}.video_models`,
      ['video'],
      config,
      node,
      costOptimization,
      issues,
    );
    validateCatalogModelsForBucket(
      catalog,
      catalogModelIds,
      stringArray(node.realtime_models),
      `${basePath}.realtime_models`,
      ['realtime'],
      config,
      node,
      costOptimization,
      issues,
    );
  });
}

function validateCatalogAuthTypeMatch(
  node: Record<string, unknown>,
  provider: ProviderCatalog['providers'][number],
  basePath: string,
  issues: ConfigValidationIssue[],
): void {
  if (!isNonEmptyString(node.auth_type)) return;
  const expected = provider.auth_type;
  if (!isNonEmptyString(expected) || expected === 'none') return;
  if (node.auth_type !== expected) {
    issues.push(
      issue(
        'warning',
        'catalog_auth_type_mismatch',
        `Node "${String(node.id || '')}" auth_type "${node.auth_type}" differs from catalog provider "${provider.id}" auth_type "${expected}".`,
        `${basePath}.auth_type`,
      ),
    );
  }
}

function validateNodeCompatibilityAgainstCatalog(
  node: Record<string, unknown>,
  provider: ProviderCatalog['providers'][number] | undefined,
  catalog: ProviderCatalog,
  basePath: string,
  issues: ConfigValidationIssue[],
): void {
  const profileEntries = Array.isArray(node.compatibility_profile)
    ? stringArray(node.compatibility_profile)
    : isNonEmptyString(node.compatibility_profile)
      ? [node.compatibility_profile]
      : [];
  const profiles = resolveNodeCompatibilityProfiles(node as Partial<GatewayConfig['nodes'][number]>, catalog);
  if (profileEntries.length > 0 && provider?.compatibility_profiles?.length) {
    for (const profileId of profileEntries) {
      if (!provider.compatibility_profiles.includes(profileId)) {
        issues.push(
          issue(
            'warning',
            'compatibility_profile_provider_mismatch',
            `Node "${String(node.id || '')}" overrides compatibility_profile="${profileId}", which is not listed for catalog provider "${provider.id}".`,
            `${basePath}.compatibility_profile`,
          ),
        );
      }
    }
  }

  const protocol = isNonEmptyString(node.protocol) ? node.protocol : null;
  if (
    protocol &&
    !profiles.some((profile) => compatibilityProfileSupportsSourceFormat(profile, protocol))
  ) {
    issues.push(
      issue(
        'warning',
        'compatibility_profile_source_format_mismatch',
        `Node "${String(node.id || '')}" protocol "${protocol}" is not supported by its compatibility_profile.`,
        `${basePath}.protocol`,
      ),
    );
  }

  for (const [key, endpointPath] of [
    ['embeddings', 'embeddings_endpoint'],
    ['rerank', 'rerank_endpoint'],
    ['image_generation', 'images_generations_endpoint'],
    ['image_edit', 'images_edits_endpoint'],
    ['image_variation', 'images_variations_endpoint'],
    ['audio_transcription', 'audio_transcriptions_endpoint'],
    ['audio_translation', 'audio_translations_endpoint'],
    ['audio_speech', 'audio_speech_endpoint'],
    ['video_generation', 'video_endpoint'],
    ['batch', 'batch_endpoint'],
    ['realtime', 'realtime_endpoint'],
  ] as const) {
    if (
      node[endpointPath] !== undefined &&
      !profiles.some((profile) => compatibilityProfileSupportsSourceFormat(profile, key))
    ) {
      issues.push(
        issue(
          'warning',
          'compatibility_profile_endpoint_mismatch',
          `Node "${String(node.id || '')}" configures ${endpointPath}, but its compatibility_profile does not support ${key}.`,
          `${basePath}.${endpointPath}`,
        ),
      );
    }
  }

  for (const [bucket, modality] of [
    ['models', 'text'],
    ['embedding_models', 'embedding'],
    ['rerank_models', 'rerank'],
    ['image_models', 'image'],
    ['audio_models', 'audio'],
    ['video_models', 'video'],
    ['realtime_models', 'realtime'],
  ] as const) {
    if (
      stringArray(node[bucket]).length > 0 &&
      !profiles.some((profile) => compatibilityProfileSupportsModality(profile, modality))
    ) {
      issues.push(
        issue(
          'warning',
          'compatibility_profile_modality_mismatch',
          `Node "${String(node.id || '')}" configures ${bucket}, but its compatibility_profile does not support ${modality}.`,
          `${basePath}.${bucket}`,
        ),
      );
    }
  }

  if (
    provider &&
    provider.compatibility_profiles?.some((profileId) => !getCompatibilityProfile(profileId))
  ) {
    issues.push(
      issue(
        'info',
        'catalog_compatibility_profile_operator_managed',
        `Catalog provider "${provider.id}" includes operator-managed compatibility profiles; verify routing behavior with Dashboard tests.`,
        `${basePath}.compatibility_profile`,
      ),
    );
  }

  const matchedProvider = findCatalogProviderForNode(catalog, node);
  if (!matchedProvider && profileEntries.length === 0) {
    issues.push(
      issue(
        'info',
        'compatibility_profile_inferred',
        `Node "${String(node.id || '')}" does not match a catalog provider; SiftGate inferred compatibility from protocol and endpoints.`,
        basePath,
      ),
    );
  }
}

function catalogProviderForNode(
  catalog: ProviderCatalog,
  node: Record<string, unknown>,
) {
  const nodeId = isNonEmptyString(node.id) ? node.id : '';
  const baseUrl = isNonEmptyString(node.base_url)
    ? normalizeComparableUrl(node.base_url)
    : '';
  return catalog.providers.find((provider) => {
    if (provider.id === nodeId) return true;
    return normalizeComparableUrl(provider.base_url) === baseUrl;
  });
}

function validateCatalogEndpointMatch(
  node: Record<string, unknown>,
  provider: ProviderCatalog['providers'][number] | undefined,
  endpointKey: unknown,
  configuredEndpoint: unknown,
  endpointPath: string,
  issues: ConfigValidationIssue[],
): void {
  if (!provider || !isNonEmptyString(endpointKey) || !isNonEmptyString(configuredEndpoint)) {
    return;
  }
  const catalogEndpoint = provider.endpoints[endpointKey];
  if (!isNonEmptyString(catalogEndpoint)) return;
  const configured = normalizeEndpointPath(configuredEndpoint);
  const expected = normalizeEndpointPath(catalogEndpoint);
  if (configured !== expected) {
    issues.push(
      issue(
        'warning',
        'catalog_endpoint_mismatch',
        `Node "${String(node.id || '')}" endpoint "${configuredEndpoint}" differs from catalog provider "${provider.id}" ${endpointKey} endpoint "${catalogEndpoint}".`,
        endpointPath,
      ),
    );
  }
}

function validateCatalogModelsForBucket(
  catalog: ProviderCatalog,
  catalogModelIds: Set<string>,
  models: string[],
  basePath: string,
  expectedModalities: string[],
  config: Partial<GatewayConfig> & Record<string, unknown>,
  node: Record<string, unknown>,
  costOptimization: boolean,
  issues: ConfigValidationIssue[],
): void {
  models.forEach((modelId, index) => {
    const modelPath = `${basePath}[${index}]`;
    if (!catalogModelIds.has(modelId)) {
      issues.push(
        issue(
          'warning',
          'catalog_unknown_model',
          `Model "${modelId}" is not in the merged provider catalog. Add it to catalog.override.yaml if this is intentional.`,
          modelPath,
        ),
      );
      return;
    }

    const catalogModel = findCatalogModelForNode(catalog, modelId, {
      id: isNonEmptyString(node.id) ? node.id : undefined,
      base_url: isNonEmptyString(node.base_url) ? node.base_url : undefined,
    }) || findCatalogModel(catalog, modelId);
    if (!catalogModel) return;
    if (
      !expectedModalities.some((modality) =>
        (catalogModel.modalities as string[]).includes(modality),
      )
    ) {
      issues.push(
        issue(
          'warning',
          'catalog_modality_mismatch',
          `Model "${modelId}" is listed in ${basePath} but catalog modalities are ${catalogModel.modalities.join(', ')}.`,
          modelPath,
        ),
      );
    }
    if (catalogModel.pricing?.manual_review_required) {
      issues.push(
        issue(
          'info',
          'catalog_pricing_manual_review',
          `Catalog pricing for "${modelId}" is marked manual_review_required; verify before relying on cost routing.`,
          modelPath,
        ),
      );
    }
    validateCatalogPricingForConfiguredModel(
      catalogModel,
      expectedModalities,
      config,
      node,
      modelPath,
      costOptimization,
      issues,
    );
  });
}

function validateCatalogPricingForConfiguredModel(
  catalogModel: NonNullable<ReturnType<typeof findCatalogModel>>,
  expectedModalities: string[],
  config: Partial<GatewayConfig> & Record<string, unknown>,
  node: Record<string, unknown>,
  modelPath: string,
  costOptimization: boolean,
  issues: ConfigValidationIssue[],
): void {
  if (hasExplicitPricing(config, node, catalogModel.id)) return;

  const hygiene = assessCatalogPricing(catalogModel.pricing, expectedModalities);
  if (hygiene.missing_price_dimensions.length > 0) {
    issues.push(
      issue(
        'warning',
        'catalog_pricing_missing',
        `Catalog pricing for "${catalogModel.id}" is missing ${hygiene.missing_price_dimensions.join(', ')} price metadata.`,
        modelPath,
      ),
    );
  }
  if (hygiene.placeholder) {
    issues.push(
      issue(
        'warning',
        'catalog_pricing_review_required',
        `Catalog pricing for "${catalogModel.id}" needs review; add explicit pricing for production cost routing.`,
        modelPath,
      ),
    );
  }
  if (hygiene.source_missing) {
    issues.push(
      issue(
        'warning',
        'catalog_pricing_source_missing',
        `Catalog pricing for "${catalogModel.id}" is missing price source metadata.`,
        modelPath,
      ),
    );
  }
  if (hygiene.source_url_missing) {
    issues.push(
      issue(
        'warning',
        'catalog_pricing_source_url_missing',
        `Catalog pricing for "${catalogModel.id}" is missing a reviewable source_url.`,
        modelPath,
      ),
    );
  }
  if (hygiene.stale) {
    issues.push(
      issue(
        'warning',
        'catalog_pricing_stale',
        `Catalog pricing for "${catalogModel.id}" is ${hygiene.age_days} day(s) old; refresh catalog.override.yaml or verify manually.`,
        modelPath,
      ),
    );
  }
  if (hygiene.unit_mismatches.length > 0) {
    issues.push(
      issue(
        'warning',
        'catalog_pricing_unit_mismatch',
        `Catalog pricing units for "${catalogModel.id}" do not fully match ${hygiene.unit_mismatches.join(', ')} workloads.`,
        modelPath,
      ),
    );
  }
  const cacheReadPrice =
    catalogModel.pricing?.cache_read_per_1m_tokens ?? catalogModel.pricing?.cache_read_input;
  const cacheWritePrice =
    catalogModel.pricing?.cache_write_per_1m_tokens ?? catalogModel.pricing?.cache_creation_input;
  if (
    costOptimization &&
    (catalogModel.prompt_cache || catalogModel.read_cache || catalogModel.write_cache) &&
    (!isFiniteNumber(cacheReadPrice) || (catalogModel.write_cache && !isFiniteNumber(cacheWritePrice)))
  ) {
    issues.push(
      issue(
        'warning',
        'cache_routing_pricing_missing',
        `Cache-aware cost routing for "${catalogModel.id}" needs cache_read/cache_write pricing when prompt cache capability is configured.`,
        modelPath,
      ),
    );
  }
  for (const modality of ['image', 'audio', 'video'] as const) {
    if (
      expectedModalities.includes(modality) &&
      hygiene.missing_price_dimensions.includes(modality)
    ) {
      issues.push(
        issue(
          'warning',
          'media_pricing_unit_missing',
          `Catalog pricing for "${catalogModel.id}" is missing ${modality} price units for the configured media endpoint.`,
          modelPath,
        ),
      );
    }
  }
  if (costOptimization && !catalogModelToModelPricing(catalogModel)) {
    issues.push(
      issue(
        'warning',
        'cost_routing_pricing_missing',
        `routing.optimization=cost/balanced needs input/output token pricing for "${catalogModel.id}" or an explicit models_pricing override.`,
        modelPath,
      ),
    );
  }
}

function hasExplicitPricing(
  config: Partial<GatewayConfig> & Record<string, unknown>,
  node: Record<string, unknown>,
  modelId: string,
): boolean {
  const topLevelPricing = config.models_pricing;
  if (isRecord(topLevelPricing) && isRecord(topLevelPricing[modelId])) {
    return true;
  }
  const modelCapabilities = node.model_capabilities;
  if (!isRecord(modelCapabilities)) return false;
  const capability = modelCapabilities[modelId];
  return isRecord(capability) && isRecord(capability.pricing);
}

function normalizeEndpointPath(value: string): string {
  if (/^https?:\/\//i.test(value) || /^wss?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      return url.pathname.replace(/\/+$/, '') || '/';
    } catch {
      return value.replace(/\/+$/, '');
    }
  }
  return value.replace(/\/+$/, '') || '/';
}

function normalizeComparableUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`.replace(/\/+$/, '');
  } catch {
    return value.replace(/\/+$/, '');
  }
}

function validateConfigAudit(
  audit: unknown,
  issues: ConfigValidationIssue[],
): void {
  if (audit === undefined) return;
  if (!isRecord(audit)) {
    issues.push(
      issue(
        'error',
        'invalid_config_audit_config',
        'config_audit must be an object.',
        'config_audit',
      ),
    );
    return;
  }

  if (audit.enabled !== undefined && !isBoolean(audit.enabled)) {
    issues.push(
      issue(
        'error',
        'invalid_config_audit_config',
        'config_audit.enabled must be a boolean.',
        'config_audit.enabled',
      ),
    );
  }

  if (
    audit.capture_startup_snapshot !== undefined &&
    !isBoolean(audit.capture_startup_snapshot)
  ) {
    issues.push(
      issue(
        'error',
        'invalid_config_audit_config',
        'config_audit.capture_startup_snapshot must be a boolean.',
        'config_audit.capture_startup_snapshot',
      ),
    );
  }

  validatePositiveNumber(
    audit.max_versions,
    'config_audit.max_versions',
    'invalid_config_audit_config',
    issues,
  );
  validatePositiveNumber(
    audit.max_events,
    'config_audit.max_events',
    'invalid_config_audit_config',
    issues,
  );
}

function validateControlPlane(
  controlPlane: unknown,
  issues: ConfigValidationIssue[],
): void {
  if (controlPlane === undefined) {
    issues.push(
      issue(
        'info',
        'control_plane_disabled',
        'control_plane is not configured; the data plane will run standalone.',
        'control_plane',
      ),
    );
    return;
  }
  if (!isRecord(controlPlane)) {
    issues.push(
      issue(
        'error',
        'invalid_control_plane',
        'control_plane must be an object when configured.',
        'control_plane',
      ),
    );
    return;
  }

  if (controlPlane.enabled !== true) {
    issues.push(
      issue(
        'info',
        'control_plane_disabled',
        'control_plane.enabled is false; Cloud remains an optional control plane.',
        'control_plane.enabled',
      ),
    );
    return;
  }

  if (!isNonEmptyString(controlPlane.url)) {
    issues.push(
      issue(
        'error',
        'missing_control_plane_field',
        'control_plane.url is required when enabled.',
        'control_plane.url',
      ),
    );
  } else {
    validateControlPlaneUrl(controlPlane.url, issues);
  }
  if (!isNonEmptyString(controlPlane.gateway_id)) {
    issues.push(
      issue(
        'error',
        'missing_control_plane_field',
        'control_plane.gateway_id is required when enabled.',
        'control_plane.gateway_id',
      ),
    );
  }
  if (!isNonEmptyString(controlPlane.registration_token)) {
    issues.push(
      issue(
        'error',
        'missing_control_plane_field',
        'control_plane.registration_token is required when enabled.',
        'control_plane.registration_token',
      ),
    );
  } else if (!containsEnvReference(controlPlane.registration_token)) {
    issues.push(
      issue(
        'warning',
        'literal_control_plane_token',
        'control_plane.registration_token is literal; use an environment reference for production.',
        'control_plane.registration_token',
      ),
    );
  }

  const telemetry = controlPlane.telemetry;
  if (telemetry !== undefined && !isRecord(telemetry)) {
    issues.push(
      issue(
        'error',
        'invalid_control_plane_telemetry',
        'control_plane.telemetry must be an object.',
        'control_plane.telemetry',
      ),
    );
  } else if (isRecord(telemetry)) {
    if (telemetry.include_prompt === true) {
      issues.push(
        issue(
          'warning',
          'control_plane_prompt_upload_enabled',
          'control_plane.telemetry.include_prompt is enabled; prompts may leave the local data plane.',
          'control_plane.telemetry.include_prompt',
        ),
      );
    }
    if (telemetry.include_response === true) {
      issues.push(
        issue(
          'warning',
          'control_plane_response_upload_enabled',
          'control_plane.telemetry.include_response is enabled; responses may leave the local data plane.',
          'control_plane.telemetry.include_response',
        ),
      );
    }
  }
}

function validateHttpUrl(
  value: string,
  issuePath: string,
  code: string,
  issues: ConfigValidationIssue[],
): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      issues.push(
        issue('error', code, 'URL must use http or https.', issuePath),
      );
      return null;
    }
    return url;
  } catch {
    issues.push(issue('error', code, 'Value must be a valid URL.', issuePath));
    return null;
  }
}

function isValidRealtimeEndpoint(value: unknown): value is string {
  if (!isNonEmptyString(value)) return false;
  if (value.startsWith('/')) return true;
  try {
    const url = new URL(value);
    return url.protocol === 'ws:' || url.protocol === 'wss:';
  } catch {
    return false;
  }
}

function validateControlPlaneUrl(
  value: string,
  issues: ConfigValidationIssue[],
): void {
  const url = validateHttpUrl(
    value,
    'control_plane.url',
    'invalid_control_plane_url',
    issues,
  );
  if (!url) return;

  if (url.protocol === 'http:' && !isLocalhostUrl(url)) {
    issues.push(
      issue(
        'warning',
        'insecure_control_plane_url',
        'control_plane.url uses plain HTTP outside localhost; use HTTPS for hosted control planes.',
        'control_plane.url',
      ),
    );
  }
}

function validateSecretReferences(
  value: unknown,
  env: NodeJS.ProcessEnv,
  issues: ConfigValidationIssue[],
  currentPath = '',
  backends: Record<SecretReferenceBackend, boolean>,
): void {
  if (typeof value === 'string') {
    // Endpoint slots are literal routing tokens, not secret references. Protect
    // actual ${...} expressions first; malformed/nested expressions still fail.
    const videoGeneration = /^nodes\[\d+\]\.video_(?:endpoint|generations_endpoint)$/.test(currentPath);
    const videoControl = /^nodes\[\d+\]\.video_(?:status|content|cancel)_endpoint$/.test(currentPath);
    const scanned = videoGeneration || videoControl
      ? value.replace(/\$\{[^}]*\}|\{(?:id|model)\}/g, token => {
          if (token.startsWith('${')) return token;
          return (videoGeneration && token === '{model}') || (videoControl && token === '{id}') ? '__VIDEO_ENDPOINT_SLOT__' : token;
        })
      : value;
    const scan = scanSecretReferences(scanned);
    for (const invalid of scan.invalid) {
      const envLike = invalid.reason.startsWith('Environment references');
      issues.push(
        issue(
          'error',
          envLike ? 'malformed_env_reference' : 'malformed_secret_reference',
          `${envLike ? 'Environment' : 'Secret'} reference ${invalid.raw} is invalid: ${invalid.reason}`,
          currentPath,
        ),
      );
    }
    for (const ref of scan.references) {
      if (!backends[ref.backend]) {
        issues.push(
          issue(
            'error',
            'secret_backend_disabled',
            `Secret reference ${ref.raw} uses backend "${ref.backend}", but that backend is not enabled.`,
            currentPath,
          ),
        );
        continue;
      }
      if (
        ref.backend === 'env' &&
        ref.defaultValue === undefined &&
        env[ref.target] === undefined
      ) {
        issues.push(
          issue(
            'warning',
            'env_reference_unset',
            `Environment variable ${ref.target} is not set and has no default.`,
            currentPath,
          ),
        );
      }
    }
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      validateSecretReferences(
        item,
        env,
        issues,
        `${currentPath}[${index}]`,
        backends,
      ),
    );
    return;
  }

  if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      const childPath = currentPath ? `${currentPath}.${key}` : key;
      validateSecretReferences(child, env, issues, childPath, backends);
    }
  }
}

function containsEnvReference(value: string): boolean {
  return HAS_CONFIG_REF_PATTERN.test(value);
}

function validateProviderApiKey(
  node: Record<string, unknown>,
  apiKey: string,
  nodePath: string,
  issues: ConfigValidationIssue[],
): void {
  if (containsEnvReference(apiKey) || isPlaceholderApiKey(apiKey)) {
    return;
  }

  if (looksLikeSecret(apiKey) || !isLocalNode(node)) {
    issues.push(
      issue(
        'warning',
        'literal_provider_api_key',
        'Provider api_key is literal; use an environment reference such as ${PROVIDER_API_KEY} for production.',
        `${nodePath}.api_key`,
      ),
    );
  }
}

function validateNodeCredentials(
  node: Record<string, unknown>,
  basePath: string,
  issues: ConfigValidationIssue[],
): void {
  if (node.credentials !== undefined) {
    if (!Array.isArray(node.credentials)) {
      issues.push(
        issue(
          'error',
          'invalid_node_credentials',
          'nodes[].credentials must be an array when set.',
          `${basePath}.credentials`,
        ),
      );
    } else {
      const seen = new Map<string, string>();
      node.credentials.forEach((credential, index) => {
        const credentialPath = `${basePath}.credentials[${index}]`;
        if (!isRecord(credential)) {
          issues.push(
            issue(
              'error',
              'invalid_node_credential',
              'nodes[].credentials[] must be an object.',
              credentialPath,
            ),
          );
          return;
        }
        if (!isNonEmptyString(credential.id)) {
          issues.push(
            issue(
              'error',
              'missing_credential_id',
              'nodes[].credentials[].id is required.',
              `${credentialPath}.id`,
            ),
          );
        } else {
          if (!NODE_ID_PATTERN.test(credential.id)) {
            issues.push(
              issue(
                'error',
                'invalid_credential_id',
                'Credential id must start with a letter or number and contain only letters, numbers, dots, underscores, or dashes.',
                `${credentialPath}.id`,
              ),
            );
          }
          const previous = seen.get(credential.id);
          if (previous) {
            issues.push(
              issue(
                'error',
                'duplicate_credential_id',
                `Credential id "${credential.id}" is already used at ${previous}.`,
                `${credentialPath}.id`,
              ),
            );
          } else {
            seen.set(credential.id, `${credentialPath}.id`);
          }
        }
        if (!isNonEmptyString(credential.api_key)) {
          issues.push(
            issue(
              'error',
              'missing_credential_api_key',
              'nodes[].credentials[].api_key is required.',
              `${credentialPath}.api_key`,
            ),
          );
        } else {
          validateProviderApiKey(node, credential.api_key, credentialPath, issues);
        }
        if (
          credential.weight !== undefined &&
          (!isNumberLike(credential.weight) || Number(credential.weight) <= 0)
        ) {
          issues.push(
            issue(
              'error',
              'invalid_credential_weight',
              'nodes[].credentials[].weight must be a positive number when set.',
              `${credentialPath}.weight`,
            ),
          );
        }
        if (
          credential.enabled !== undefined &&
          typeof credential.enabled !== 'boolean'
        ) {
          issues.push(
            issue(
              'error',
              'invalid_credential_enabled',
              'nodes[].credentials[].enabled must be a boolean when set.',
              `${credentialPath}.enabled`,
            ),
          );
        }
      });
    }
  }

  if (node.credential_pool !== undefined) {
    if (!isRecord(node.credential_pool)) {
      issues.push(
        issue(
          'error',
          'invalid_credential_pool',
          'nodes[].credential_pool must be an object when set.',
          `${basePath}.credential_pool`,
        ),
      );
      return;
    }
    const pool = node.credential_pool;
    if (pool.enabled !== undefined && typeof pool.enabled !== 'boolean') {
      issues.push(
        issue(
          'error',
          'invalid_credential_pool_enabled',
          'nodes[].credential_pool.enabled must be a boolean when set.',
          `${basePath}.credential_pool.enabled`,
        ),
      );
    }
    if (
      pool.strategy !== undefined &&
      (!isNonEmptyString(pool.strategy) || !CREDENTIAL_POOL_STRATEGIES.has(pool.strategy))
    ) {
      issues.push(
        issue(
          'error',
          'invalid_credential_pool_strategy',
          'nodes[].credential_pool.strategy must be least_in_flight, weighted_round_robin, or cache_aware.',
          `${basePath}.credential_pool.strategy`,
        ),
      );
    }
    if (
      pool.sticky_by !== undefined &&
      (!isNonEmptyString(pool.sticky_by) || !CREDENTIAL_STICKY_MODES.has(pool.sticky_by))
    ) {
      issues.push(
        issue(
          'error',
          'invalid_credential_pool_sticky_by',
          'nodes[].credential_pool.sticky_by must be none, agent_session, api_key, team, or namespace.',
          `${basePath}.credential_pool.sticky_by`,
        ),
      );
    }
    for (const [key, min] of [
      ['cooldown_ms', 0],
      ['max_failures', 1],
    ] as const) {
      if (
        pool[key] !== undefined &&
        (!isNumberLike(pool[key]) || Number(pool[key]) < min)
      ) {
        issues.push(
          issue(
            'error',
            'invalid_credential_pool_number',
            `nodes[].credential_pool.${key} must be a number >= ${min}.`,
            `${basePath}.credential_pool.${key}`,
          ),
        );
      }
    }
    if (pool.retry_on_status !== undefined) {
      if (
        !Array.isArray(pool.retry_on_status) ||
        !pool.retry_on_status.every(
          (value) => Number.isInteger(Number(value)) && Number(value) >= 100 && Number(value) <= 599,
        )
      ) {
        issues.push(
          issue(
            'error',
            'invalid_credential_pool_retry_status',
            'nodes[].credential_pool.retry_on_status must be an array of HTTP status codes.',
            `${basePath}.credential_pool.retry_on_status`,
          ),
        );
      }
    }
  }
}

function validateNodeAuthMapping(
  node: Record<string, unknown>,
  basePath: string,
  issues: ConfigValidationIssue[],
): void {
  const authType = node.auth_type;
  if (authType === undefined) return;
  if (!['bearer', 'x-api-key', 'custom-header'].includes(String(authType))) {
    issues.push(
      issue(
        'error',
        'invalid_node_auth_type',
        'nodes[].auth_type must be bearer, x-api-key, or custom-header.',
        `${basePath}.auth_type`,
      ),
    );
    return;
  }
  if (authType === 'custom-header') {
    if (!isNonEmptyString(node.auth_header_name)) {
      issues.push(
        issue(
          'error',
          'missing_custom_auth_header_name',
          'nodes[].auth_header_name is required when auth_type is custom-header.',
          `${basePath}.auth_header_name`,
        ),
      );
    } else if (isSensitiveHeaderName(node.auth_header_name)) {
      issues.push(
        issue(
          'warning',
          'custom_auth_header_sensitive_name',
          'nodes[].auth_header_name uses a sensitive header name; SiftGate will redact it from UI and generated artifacts.',
          `${basePath}.auth_header_name`,
        ),
      );
    }
    if (
      node.auth_header_prefix !== undefined &&
      !isNonEmptyString(node.auth_header_prefix)
    ) {
      issues.push(
        issue(
          'error',
          'invalid_custom_auth_header_prefix',
          'nodes[].auth_header_prefix must be a non-empty string when set.',
          `${basePath}.auth_header_prefix`,
        ),
      );
    }
  } else if (
    node.auth_header_name !== undefined ||
    node.auth_header_prefix !== undefined
  ) {
    issues.push(
      issue(
        'warning',
        'custom_auth_header_ignored',
        'nodes[].auth_header_name/auth_header_prefix are only used when auth_type is custom-header.',
        `${basePath}.auth_type`,
      ),
    );
  }
}

function isPlaceholderApiKey(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return (
    normalized === 'not-needed' ||
    normalized === 'none' ||
    normalized === 'dummy' ||
    normalized === 'test' ||
    normalized.includes('dummy') ||
    normalized.includes('local')
  );
}

function looksLikeSecret(value: string): boolean {
  return /^(sk-|sk_|xox|api_|key_)/i.test(value) || value.length >= 32;
}

function isSensitiveHeaderName(value: unknown): boolean {
  if (!isNonEmptyString(value)) return false;
  return isSensitiveLogField(value);
}

function isLocalNode(node: Record<string, unknown>): boolean {
  if (!isNonEmptyString(node.base_url)) return false;
  try {
    const url = new URL(node.base_url);
    return isLocalhostUrl(url);
  } catch {
    return false;
  }
}

function addSharedDiagnostics(
  config: Partial<GatewayConfig>,
  issues: ConfigValidationIssue[],
  catalog?: ProviderCatalog,
): void {
  for (const diagnostic of buildNodeModelDiagnostics(config)) {
    if (
      catalog &&
      diagnostic.code === 'missing_model_pricing' &&
      diagnostic.model &&
      catalogModelToModelPricing(findCatalogModel(catalog, diagnostic.model))
    ) {
      continue;
    }
    const severity = diagnostic.code.startsWith('route_references_')
      ? 'error'
      : 'warning';
    issues.push(
      issue(
        severity,
        diagnostic.code,
        diagnostic.message,
        diagnosticPath(diagnostic.tier, diagnostic.target),
      ),
    );
  }
}

function diagnosticPath(tier?: string, target?: string): string | undefined {
  if (!tier) return undefined;
  let targetPath = '';
  if (target === 'primary') {
    targetPath = '.primary';
  } else if (target?.startsWith('fallback[')) {
    targetPath = `.fallbacks${target.slice('fallback'.length)}`;
  } else if (target?.startsWith('split[')) {
    targetPath = `.split${target.slice('split'.length)}`;
  } else if (target?.startsWith('targets[')) {
    targetPath = `.${target}`;
  } else if (target) {
    targetPath = `.${target}`;
  }
  return `routing.tiers.${tier}${targetPath}`;
}

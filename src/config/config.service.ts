import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { Subject, Subscription } from 'rxjs';
import {
  GatewayConfig,
  NodeConfig,
  RoutingConfig,
  RetryConfig,
  BudgetConfig,
  CacheConfig,
  SemanticCacheConfig,
  LoggingConfig,
  LogSinkConfig,
  ControlPlaneConfig,
  HotReloadConfig,
  EmbeddingBatchingConfig,
  ClusterConfig,
  AlertsConfig,
  AlertChannelConfig,
  AlertSpikeRuleConfig,
  AlertLatencySpikeRuleConfig,
  NamespaceConfig,
  ShadowTrafficConfig,
  ModelPricing,
  ServerConfig,
  DatabaseConfig,
  AuthConfig,
  DashboardConfig,
  DashboardOidcConfig,
  FallbackPolicyConfig,
  CacheAffinityRoutingConfig,
  StateBackendConfig,
  StateCategoryConfig,
  StateCategoryName,
  StateUnavailablePolicy,
  RealtimeConfig,
  McpGatewayConfig,
  ConfigAuditConfig,
  SecretManagerConfig,
  SecretManagerFailurePolicy,
  VaultSecretManagerConfig,
  AwsSecretsManagerConfig,
  GcpSecretManagerConfig,
  CatalogConfig,
  IntelligenceConfig,
  SemanticPlatformConfig,
} from './gateway.config';
import { buildNodeModelDiagnostics } from './config-diagnostics';
import type { ConfigDiagnostic } from './config-diagnostics';
import type { EventBusService } from '../plugins/event-bus.service';
import { containsSecretReference, isTypedSecretReferenceExpression } from './secret-references';
import { loadLocalEnvFiles } from './local-env';
import { validateChannel } from '../alerts/alert-connector-runtime';
import type { ProviderCatalog } from '../catalog/catalog.types';
import { resolvePricingLimits } from './pricing-limits';
import { selectConfiguredLegacyPricing, withLegacyCachePricing } from './legacy-pricing-resolution';

export type { ConfigDiagnostic, ConfigDiagnosticSeverity } from './config-diagnostics';

export type ConfigReloadSource =
  | 'manual'
  | 'dashboard'
  | 'cli'
  | 'rollback'
  | 'system'
  | 'sighup'
  | 'watcher'
  | 'cluster';

export interface ConfigSnapshot {
  version: number;
  loaded_at: string;
  path: string;
  node_count: number;
  node_ids: string[];
  route_tiers: string[];
  control_plane_enabled: boolean;
  hot_reload_watch: boolean;
}

export interface ConfigChangeSummary {
  nodes_added: string[];
  nodes_removed: string[];
  nodes_changed: boolean;
  namespaces_changed: boolean;
  routing_changed: boolean;
  budget_changed: boolean;
  pricing_changed: boolean;
  control_plane_changed: boolean;
  hot_reload_changed: boolean;
  state_changed: boolean;
  cluster_changed: boolean;
  realtime_changed: boolean;
}

export interface ConfigReloadResult {
  success: boolean;
  source: ConfigReloadSource;
  message: string;
  previous: ConfigSnapshot;
  current: ConfigSnapshot;
  changed: ConfigChangeSummary;
  rolled_back: boolean;
  error?: {
    name: string;
    message: string;
  };
}

export interface ConfigReloadOptions {
  source?: ConfigReloadSource;
  throwOnError?: boolean;
}

interface LoadedConfig {
  resolved: GatewayConfig;
  original: GatewayConfig;
}

export class MissingRequiredEnvVarError extends Error {
  constructor(
    public readonly envName: string,
    public readonly configPath: string,
  ) {
    super(
      `Missing required environment variable "${envName}" referenced at ${configPath}. ` +
        'Use ${VAR:-default} for a startup default or ${env:VAR} for runtime secret resolution.',
    );
    this.name = 'MissingRequiredEnvVarError';
  }
}

export class ConfigReloadError extends Error {
  constructor(public readonly result: ConfigReloadResult) {
    super(result.message);
    this.name = 'ConfigReloadError';
  }
}

@Injectable()
export class ConfigService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ConfigService.name);
  private config!: GatewayConfig;
  private configPath!: string;
  private configVersion = 0;
  private loadedAt = new Date(0);
  private eventBus?: EventBusService;
  private readonly reloadSubject = new Subject<ConfigReloadResult>();
  private sighupHandler?: NodeJS.SignalsListener;
  private configWatcher?: fs.FSWatcher;
  private watcherDebounceTimer?: NodeJS.Timeout;
  private watcherDebounceMs = 0;
  private catalogPricingCache?: { configVersion: number; catalog: ProviderCatalog };
  private originalConfigForPersistence?: GatewayConfig;
  private resolvedConfigForPersistence?: GatewayConfig;

  constructor() {
    // Load eagerly in constructor so config is available during module initialization
    // (e.g. TypeORM's forRootAsync factory needs database config before onModuleInit)
    loadLocalEnvFiles();
    this.loadConfig();
  }

  onModuleInit(): void {
    this.registerSighupHandler();
    this.syncConfigWatcher();
  }

  onModuleDestroy(): void {
    this.unregisterSighupHandler();
    this.stopConfigWatcher();
    this.reloadSubject.complete();
  }

  setEventBus(eventBus: EventBusService): void {
    this.eventBus = eventBus;
  }

  private loadConfig(): void {
    this.configPath = this.resolveConfigPath();
    const nextConfig = this.loadConfigFromDisk();
    this.commitConfig(nextConfig);

    this.logger.log(
      `Configuration loaded from ${this.configPath} — ${this.config.nodes.length} node(s) configured`,
    );
  }

  private resolveConfigPath(): string {
    return (
      process.env.GATEWAY_CONFIG_PATH ||
      path.resolve(process.cwd(), 'gateway.config.yaml')
    );
  }

  private loadConfigFromDisk(): LoadedConfig {
    loadLocalEnvFiles({ configPath: this.configPath });
    if (!fs.existsSync(this.configPath)) {
      throw new Error(`Configuration file not found: ${this.configPath}`);
    }
    const raw = fs.readFileSync(this.configPath, 'utf8');
    return this.loadConfigFromYaml(raw);
  }

  private loadConfigFromYaml(raw: string): LoadedConfig {
    const parsed = yaml.load(raw) as GatewayConfig;
    const resolved = this.resolveEnvVars(parsed) as GatewayConfig;
    this.normalizeConfig(resolved);
    this.validateConfigShape(resolved);
    return { resolved, original: parsed };
  }

  /**
   * Recursively resolve startup-time ${ENV_VAR} references in string values.
   * `${ENV_VAR}` is now required and fails fast when missing.
   * `${ENV_VAR:-default}` keeps its default-value semantics.
   * Typed runtime secret references such as `${env:VAR}` remain untouched.
   */
  private resolveEnvVars<T>(obj: T, location = '$'): T {
    if (typeof obj === 'string') {
      return obj.replace(
        /\$\{([^}]+)\}/g,
        (_match: string, expr: string) => {
          if (isTypedSecretReferenceExpression(expr)) {
            return _match;
          }
          const separatorIndex = expr.indexOf(':-');
          const envKey =
            separatorIndex === -1 ? expr.trim() : expr.slice(0, separatorIndex).trim();
          const defaultValue =
            separatorIndex === -1 ? undefined : expr.slice(separatorIndex + 2);
          const value = process.env[envKey];
          if (value !== undefined) return value;
          if (defaultValue !== undefined) return defaultValue;
          throw new MissingRequiredEnvVarError(envKey, location);
        },
      ) as T;
    }

    if (Array.isArray(obj)) {
      return obj.map((item, index) => this.resolveEnvVars(item, `${location}[${index}]`)) as T;
    }

    if (obj !== null && typeof obj === 'object') {
      const resolved: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(obj)) {
        resolved[key] = this.resolveEnvVars(value, `${location}.${key}`);
      }
      return resolved as T;
    }

    return obj;
  }

  private normalizeConfig(config: GatewayConfig): void {
    if (config && typeof config === 'object') {
      config.auth ??= { api_keys: [] };
      config.models_pricing ??= {};
      config.namespaces ??= [];
      if (config.routing?.tiers) {
        for (const tier of Object.values(config.routing.tiers)) {
          tier.fallbacks ??= [];
        }
      }
    }
  }

  private validateConfigShape(config: GatewayConfig): void {
    if (!config || typeof config !== 'object') {
      throw new Error('Invalid configuration: YAML root must be an object');
    }
    resolvePricingLimits(config.pricing_limits);
    if (!config.server || typeof config.server !== 'object') {
      throw new Error('Invalid configuration: server is required');
    }
    if (!config.database || typeof config.database !== 'object') {
      throw new Error('Invalid configuration: database is required');
    }
    if (!Array.isArray(config.nodes) || config.nodes.length === 0) {
      throw new Error('Invalid configuration: nodes must be a non-empty array');
    }
    for (const [idx, node] of config.nodes.entries()) {
      if (!node?.id || !node.name || !node.protocol || !node.base_url || !node.endpoint) {
        throw new Error(`Invalid configuration: nodes[${idx}] is missing required fields`);
      }
      if (
        !node.api_key &&
        (!Array.isArray(node.credentials) || node.credentials.length === 0)
      ) {
        throw new Error(`Invalid configuration: node "${node.id}" must define api_key or credentials`);
      }
      const hasSpecializedModels = [
        node.embedding_models,
        node.rerank_models,
        node.image_models,
        node.audio_models,
        node.video_models,
        node.realtime_models,
      ].some((models) =>
        Array.isArray(models) && models.some(
          (model) => typeof model === 'string' && model.trim().length > 0,
        ),
      );
      if (!Array.isArray(node.models) || (node.models.length === 0 && !hasSpecializedModels)) {
        throw new Error(`Invalid configuration: node "${node.id}" must define at least one model`);
      }
    }
    if (!config.routing?.tiers || typeof config.routing.tiers !== 'object') {
      throw new Error('Invalid configuration: routing.tiers is required');
    }
    if (!config.routing.scoring || typeof config.routing.scoring !== 'object') {
      throw new Error('Invalid configuration: routing.scoring is required');
    }
    for (const [tierName, tier] of Object.entries(config.routing.tiers)) {
      const hasPrimary = Boolean(tier?.primary?.node && tier.primary.model);
      const hasTargets = Array.isArray(tier?.targets) && tier.targets.length > 0;
      const hasSplit = Array.isArray(tier?.split) && tier.split.length > 0;
      if (!hasPrimary && !hasTargets && !hasSplit) {
        throw new Error(`Invalid configuration: routing.tiers.${tierName} must define primary, targets, or split`);
      }
      if (!hasTargets && !hasSplit && !Array.isArray(tier.fallbacks)) {
        throw new Error(`Invalid configuration: routing.tiers.${tierName}.fallbacks must be an array`);
      }
      if (tier?.fallbacks !== undefined && !Array.isArray(tier.fallbacks)) {
        throw new Error(`Invalid configuration: routing.tiers.${tierName}.fallbacks must be an array`);
      }
    }
    if (!config.budget || typeof config.budget !== 'object') {
      throw new Error('Invalid configuration: budget is required');
    }
    if (config.state !== undefined) {
      if (typeof config.state !== 'object' || Array.isArray(config.state)) {
        throw new Error('Invalid configuration: state must be an object');
      }
      const backend = config.state.backend ?? 'memory';
      if (backend !== 'memory' && backend !== 'redis') {
        throw new Error('Invalid configuration: state.backend must be memory or redis');
      }
      const policy = config.state.unavailable_policy ?? 'fail_open';
      if (policy !== 'fail_open' && policy !== 'fail_closed') {
        throw new Error('Invalid configuration: state.unavailable_policy must be fail_open or fail_closed');
      }
      if (backend === 'redis' && config.state.redis?.url !== undefined) {
        try {
          const redisUrl = new URL(config.state.redis.url);
          if (redisUrl.protocol !== 'redis:' && redisUrl.protocol !== 'rediss:') {
            throw new Error('invalid protocol');
          }
        } catch {
          throw new Error('Invalid configuration: state.redis.url must be redis:// or rediss://');
        }
      }
    }
  }

  private commitConfig(loaded: LoadedConfig): void {
    this.config = loaded.resolved;
    this.originalConfigForPersistence = this.cloneConfig(loaded.original);
    this.resolvedConfigForPersistence = this.cloneConfig(loaded.resolved);
    this.configVersion += 1;
    this.loadedAt = new Date();
    this.warnAboutNodeModelResolutionConflicts();
  }

  /** Reload configuration from disk with atomic swap and rollback-on-failure semantics. */
  reload(options: ConfigReloadOptions = {}): ConfigReloadResult {
    const source = options.source ?? 'manual';
    const throwOnError = options.throwOnError ?? true;
    const previousConfig = this.config;
    const previous = this.getSnapshot();

    try {
      const nextConfig = this.loadConfigFromDisk();
      const changed = this.describeChanges(previousConfig, nextConfig.resolved);
      this.commitConfig(nextConfig);
      const current = this.getSnapshot();
      const result: ConfigReloadResult = {
        success: true,
        source,
        message: 'Configuration reloaded',
        previous,
        current,
        changed,
        rolled_back: false,
      };

      this.logger.log(
        `Configuration reloaded from ${this.configPath} — version ${current.version}`,
      );
      this.emitReloadResult(result);
      this.syncConfigWatcher();
      return result;
    } catch (err) {
      const error = err as Error;
      const current = this.getSnapshot();
      const result: ConfigReloadResult = {
        success: false,
        source,
        message: `Configuration reload failed; retained previous config: ${error.message}`,
        previous,
        current,
        changed: this.emptyChangeSummary(),
        rolled_back: true,
        error: {
          name: error.name || 'Error',
          message: error.message,
        },
      };

      this.logger.error(result.message);
      this.emitReloadResult(result);
      if (throwOnError) {
        throw new ConfigReloadError(result);
      }
      return result;
    }
  }

  /**
   * Restore a candidate YAML snapshot with the same atomic validation semantics
   * as reload(). The file is written only after parsing and validation succeed.
   */
  restoreFromYaml(rawYaml: string, options: ConfigReloadOptions = {}): ConfigReloadResult {
    const source = options.source ?? 'rollback';
    const throwOnError = options.throwOnError ?? true;
    const previousConfig = this.config;
    const previous = this.getSnapshot();

    try {
      const nextConfig = this.loadConfigFromYaml(rawYaml);
      const changed = this.describeChanges(previousConfig, nextConfig.resolved);
      this.writeConfigFileAtomic(rawYaml);
      this.commitConfig(nextConfig);
      const current = this.getSnapshot();
      const result: ConfigReloadResult = {
        success: true,
        source,
        message: 'Configuration restored',
        previous,
        current,
        changed,
        rolled_back: false,
      };

      this.logger.log(
        `Configuration restored to ${this.configPath} — version ${current.version}`,
      );
      this.emitReloadResult(result);
      this.syncConfigWatcher();
      return result;
    } catch (err) {
      const error = err as Error;
      const current = this.getSnapshot();
      const result: ConfigReloadResult = {
        success: false,
        source,
        message: `Configuration restore failed; retained previous config: ${error.message}`,
        previous,
        current,
        changed: this.emptyChangeSummary(),
        rolled_back: true,
        error: {
          name: error.name || 'Error',
          message: error.message,
        },
      };

      this.logger.error(result.message);
      this.emitReloadResult(result);
      if (throwOnError) {
        throw new ConfigReloadError(result);
      }
      return result;
    }
  }

  onReload(
    handler: (result: ConfigReloadResult) => void | Promise<void>,
  ): Subscription {
    return this.reloadSubject.subscribe((result) => {
      try {
        const maybePromise = handler(result);
        if (maybePromise && typeof maybePromise.then === 'function') {
          maybePromise.catch((err) => {
            this.logger.error(`Config reload handler failed: ${(err as Error).message}`);
          });
        }
      } catch (err) {
        this.logger.error(`Config reload handler failed: ${(err as Error).message}`);
      }
    });
  }

  onReloadSuccess(
    handler: (result: ConfigReloadResult) => void | Promise<void>,
  ): Subscription {
    return this.onReload((result) => {
      if (result.success) {
        return handler(result);
      }
      return undefined;
    });
  }

  onReloadFailed(
    handler: (result: ConfigReloadResult) => void | Promise<void>,
  ): Subscription {
    return this.onReload((result) => {
      if (!result.success) {
        return handler(result);
      }
      return undefined;
    });
  }

  getSnapshot(): ConfigSnapshot {
    return {
      version: this.configVersion,
      loaded_at: this.loadedAt.toISOString(),
      path: this.configPath,
      node_count: this.config.nodes.length,
      node_ids: this.config.nodes.map((node) => node.id),
      route_tiers: Object.keys(this.config.routing.tiers || {}),
      control_plane_enabled: Boolean(this.config.control_plane?.enabled),
      hot_reload_watch: Boolean(this.config.hot_reload?.watch),
    };
  }

  private emitReloadResult(result: ConfigReloadResult): void {
    this.reloadSubject.next(result);
    const topic = result.success ? 'config.reload.success' : 'config.reload.failed';
    try {
      this.eventBus?.emit(topic, result);
    } catch (err) {
      this.logger.error(`Failed to emit ${topic}: ${(err as Error).message}`);
    }
  }

  private registerSighupHandler(): void {
    if (this.sighupHandler) return;
    this.sighupHandler = () => {
      this.logger.log('SIGHUP received; reloading configuration');
      this.reload({ source: 'sighup', throwOnError: false });
    };
    process.on('SIGHUP', this.sighupHandler);
  }

  private unregisterSighupHandler(): void {
    if (!this.sighupHandler) return;
    process.off('SIGHUP', this.sighupHandler);
    this.sighupHandler = undefined;
  }

  private syncConfigWatcher(): void {
    const hotReload = this.hotReload;
    if (!hotReload.watch) {
      this.stopConfigWatcher();
      return;
    }
    if (this.configWatcher && this.watcherDebounceMs === hotReload.debounce_ms) {
      return;
    }
    this.stopConfigWatcher();
    this.startConfigWatcher(hotReload.debounce_ms);
  }

  private startConfigWatcher(debounceMs: number): void {
    try {
      this.configWatcher = fs.watch(this.configPath, { persistent: false }, () => {
        if (this.watcherDebounceTimer) {
          clearTimeout(this.watcherDebounceTimer);
        }
        this.watcherDebounceTimer = setTimeout(() => {
          this.reload({ source: 'watcher', throwOnError: false });
        }, debounceMs);
        this.watcherDebounceTimer.unref?.();
      });
      this.configWatcher.on('error', (err) => {
        this.logger.warn(`Config watcher error: ${err.message}`);
      });
      this.watcherDebounceMs = debounceMs;
      this.logger.log(`Config file watcher enabled (${debounceMs}ms debounce)`);
    } catch (err) {
      this.logger.warn(`Failed to start config watcher: ${(err as Error).message}`);
    }
  }

  private stopConfigWatcher(): void {
    if (this.watcherDebounceTimer) {
      clearTimeout(this.watcherDebounceTimer);
      this.watcherDebounceTimer = undefined;
    }
    if (this.configWatcher) {
      this.configWatcher.close();
      this.configWatcher = undefined;
      this.watcherDebounceMs = 0;
    }
  }

  private describeChanges(
    previous: GatewayConfig,
    next: GatewayConfig,
  ): ConfigChangeSummary {
    const previousNodeIds = new Set(previous.nodes.map((node) => node.id));
    const nextNodeIds = new Set(next.nodes.map((node) => node.id));
    return {
      nodes_added: [...nextNodeIds].filter((id) => !previousNodeIds.has(id)),
      nodes_removed: [...previousNodeIds].filter((id) => !nextNodeIds.has(id)),
      nodes_changed: JSON.stringify(previous.nodes) !== JSON.stringify(next.nodes),
      namespaces_changed: JSON.stringify(previous.namespaces || []) !== JSON.stringify(next.namespaces || []),
      routing_changed: JSON.stringify(previous.routing) !== JSON.stringify(next.routing),
      budget_changed: JSON.stringify(previous.budget) !== JSON.stringify(next.budget),
      pricing_changed: JSON.stringify(previous.models_pricing) !== JSON.stringify(next.models_pricing) ||
        JSON.stringify(previous.pricing_limits ?? {}) !== JSON.stringify(next.pricing_limits ?? {}),
      control_plane_changed: JSON.stringify(previous.control_plane || null) !== JSON.stringify(next.control_plane || null),
      hot_reload_changed: JSON.stringify(previous.hot_reload || null) !== JSON.stringify(next.hot_reload || null),
      state_changed: JSON.stringify(previous.state || null) !== JSON.stringify(next.state || null),
      cluster_changed: JSON.stringify(previous.cluster || null) !== JSON.stringify(next.cluster || null),
      realtime_changed: JSON.stringify(previous.realtime || null) !== JSON.stringify(next.realtime || null),
    };
  }

  private emptyChangeSummary(): ConfigChangeSummary {
    return {
      nodes_added: [],
      nodes_removed: [],
      nodes_changed: false,
      namespaces_changed: false,
      routing_changed: false,
      budget_changed: false,
      pricing_changed: false,
      control_plane_changed: false,
      hot_reload_changed: false,
      state_changed: false,
      cluster_changed: false,
      realtime_changed: false,
    };
  }

  // ===== Accessors =====

  get server(): ServerConfig {
    return this.config.server;
  }

  get database(): DatabaseConfig {
    return this.config.database;
  }

  get pricingLimits() {
    return resolvePricingLimits(this.config.pricing_limits);
  }

  get auth(): AuthConfig {
    return this.config.auth;
  }

  get dashboard(): DashboardConfig | undefined {
    return this.config.dashboard;
  }

  get dashboardOidc(): Required<Omit<DashboardOidcConfig, 'client_secret'>> & {
    client_secret?: string;
  } {
    const oidc = this.config.dashboard?.oidc;
    return {
      enabled: oidc?.enabled ?? false,
      issuer: oidc?.issuer ?? '',
      client_id: oidc?.client_id ?? '',
      client_secret: oidc?.client_secret,
      redirect_uri: oidc?.redirect_uri ?? '',
      allowed_domains: oidc?.allowed_domains ?? [],
      default_role: oidc?.default_role ?? 'viewer',
      default_workspace_id: oidc?.default_workspace_id ?? 'default-workspace',
      scopes: oidc?.scopes ?? ['openid', 'email', 'profile'],
      timeout_ms: oidc?.timeout_ms ?? 10_000,
    };
  }

  get catalog(): CatalogConfig | undefined {
    return this.config.catalog;
  }

  /** Return the merged Provider Catalog cached for this config version. */
  getMergedCatalog(): ProviderCatalog | undefined {
    return this.getMergedCatalogForPricing();
  }

  /** Get the dashboard password hash (if set) */
  get dashboardPasswordHash(): string | undefined {
    return this.config.dashboard?.password;
  }

  /** Update the dashboard password hash and persist to YAML */
  setDashboardPasswordHash(hash: string): void {
    if (!this.config.dashboard) {
      this.config.dashboard = {};
    }
    this.config.dashboard.password = hash;
    this.saveConfig();
    this.logger.log('Dashboard password hash updated');
  }

  get nodes(): NodeConfig[] {
    return this.config.nodes;
  }

  get routing(): RoutingConfig {
    return this.config.routing;
  }

  /** Get retry config with defaults */
  get retry(): RetryConfig {
    const r = this.config.routing.retry;
    return {
      max_retries: r?.max_retries ?? 0,
      backoff_base_ms: r?.backoff_base_ms ?? 500,
      backoff_max_ms: r?.backoff_max_ms ?? 5000,
      retryable_status: r?.retryable_status ?? [429, 502, 503],
    };
  }

  /** Get v0.3 fallback policy with conservative defaults. */
  get fallbackPolicy(): Required<FallbackPolicyConfig> & {
    timeout: {
      enabled: boolean;
      threshold_ms?: number;
      race_fallback: boolean;
    };
    structured_output: {
      enabled: boolean;
      fallback_on_parse_error: boolean;
      fallback_on_schema_error: boolean;
    };
    cost_downgrade: {
      enabled: boolean;
      max_estimated_cost_usd?: number;
    };
  } {
    const policy = this.config.routing.fallback_policy;
    return {
      immediate_429: policy?.immediate_429 ?? false,
      timeout: {
        enabled: policy?.timeout?.enabled ?? false,
        threshold_ms: policy?.timeout?.threshold_ms,
        race_fallback: policy?.timeout?.race_fallback ?? false,
      },
      structured_output: {
        enabled: policy?.structured_output?.enabled ?? false,
        fallback_on_parse_error:
          policy?.structured_output?.fallback_on_parse_error ?? true,
        fallback_on_schema_error:
          policy?.structured_output?.fallback_on_schema_error ?? true,
      },
      cost_downgrade: {
        enabled: policy?.cost_downgrade?.enabled ?? false,
        max_estimated_cost_usd:
          policy?.cost_downgrade?.max_estimated_cost_usd,
      },
    };
  }

  get budget(): BudgetConfig {
    return this.config.budget;
  }

  get cacheAffinity(): Required<CacheAffinityRoutingConfig> {
    const affinity = this.config.routing.cache_affinity;
    return {
      enabled: affinity?.enabled ?? true,
      min_consecutive_hits: affinity?.min_consecutive_hits ?? 2,
      bonus_weight: affinity?.bonus_weight ?? 0.35,
      ttl_safety_margin: affinity?.ttl_safety_margin ?? 0.8,
    };
  }

  /** Get cache config with defaults */
  get cache(): CacheConfig {
    const c = this.config.cache;
    return {
      enabled: c?.enabled ?? false,
      ttl_seconds: c?.ttl_seconds ?? 300,
      max_entries: c?.max_entries ?? 1000,
      exclude_tool_use: c?.exclude_tool_use ?? true,
      stream_cache: {
        enabled: c?.stream_cache?.enabled ?? false,
      },
    };
  }

  /** Get semantic cache preview config with privacy-safe defaults. */
  get semanticCache(): Required<SemanticCacheConfig> {
    const semantic = this.config.semantic_cache;
    return {
      enabled: semantic?.enabled ?? false,
      backend: semantic?.backend ?? 'memory',
      similarity_threshold: semantic?.similarity_threshold ?? 0.92,
      ttl_seconds: semantic?.ttl_seconds ?? 3600,
      max_entries: semantic?.max_entries ?? 500,
      vector_dimensions: semantic?.vector_dimensions ?? 256,
      store_responses: semantic?.store_responses ?? false,
      max_response_bytes: semantic?.max_response_bytes ?? 65_536,
      isolation: semantic?.isolation ?? 'workspace_api_key_model',
      response_storage_requires_header:
        semantic?.response_storage_requires_header ?? true,
    };
  }

  /** Get v2.7 semantic platform config with metadata-only defaults. */
  get semanticPlatform(): {
    enabled: boolean;
    prompt_registry: Required<NonNullable<SemanticPlatformConfig['prompt_registry']>>;
    context_optimizer: Required<NonNullable<SemanticPlatformConfig['context_optimizer']>>;
    intent_classification: {
      enabled: boolean;
      categories: NonNullable<NonNullable<SemanticPlatformConfig['intent_classification']>['categories']>;
      min_confidence: number;
    };
    guardrails_v2: {
      enabled: boolean;
      metadata_only: boolean;
      input: Required<NonNullable<NonNullable<SemanticPlatformConfig['guardrails_v2']>['input']>>;
      output: Required<NonNullable<NonNullable<SemanticPlatformConfig['guardrails_v2']>['output']>>;
    };
  } {
    const semantic = this.config.semantic_platform;
    const guardrails = semantic?.guardrails_v2;
    const defaultPolicy = {
      enabled: false,
      pii: true,
      toxicity: true,
      jailbreak: true,
      action: 'observe' as const,
    };
    return {
      enabled: semantic?.enabled ?? false,
      prompt_registry: {
        enabled: semantic?.prompt_registry?.enabled ?? false,
        store_template_content:
          semantic?.prompt_registry?.store_template_content ?? false,
        max_versions_per_key:
          semantic?.prompt_registry?.max_versions_per_key ?? 20,
      },
      context_optimizer: {
        enabled: semantic?.context_optimizer?.enabled ?? false,
        strategy: semantic?.context_optimizer?.strategy ?? 'metadata_only',
        max_context_ratio:
          semantic?.context_optimizer?.max_context_ratio ?? 0.8,
        allow_content_mutation:
          semantic?.context_optimizer?.allow_content_mutation ?? false,
      },
      intent_classification: {
        enabled: semantic?.intent_classification?.enabled ?? false,
        categories: semantic?.intent_classification?.categories ?? [
          'coding',
          'task',
          'security',
          'reasoning',
          'creative',
          'multimodal',
          'analysis',
          'general',
        ],
        min_confidence:
          semantic?.intent_classification?.min_confidence ?? 0.5,
      },
      guardrails_v2: {
        enabled: guardrails?.enabled ?? false,
        metadata_only: guardrails?.metadata_only ?? true,
        input: { ...defaultPolicy, ...(guardrails?.input || {}) },
        output: { ...defaultPolicy, ...(guardrails?.output || {}) },
      },
    };
  }

  /** Get v2 intelligence loop config with privacy-safe, opt-in defaults. */
  get intelligence(): {
    cost_optimizer: Required<NonNullable<IntelligenceConfig['cost_optimizer']>>;
    token_prediction: Required<NonNullable<IntelligenceConfig['token_prediction']>>;
    async_eval: Required<NonNullable<IntelligenceConfig['async_eval']>>;
    quality_gate: {
      enabled: boolean;
      rules: NonNullable<IntelligenceConfig['quality_gate']>['rules'];
    };
  } {
    const intelligence = this.config.intelligence;
    return {
      cost_optimizer: {
        enabled: intelligence?.cost_optimizer?.enabled ?? false,
        action: intelligence?.cost_optimizer?.action ?? 'evidence_only',
        objective: intelligence?.cost_optimizer?.objective ?? 'balanced',
        history_window_hours:
          intelligence?.cost_optimizer?.history_window_hours ?? 24,
        min_samples: intelligence?.cost_optimizer?.min_samples ?? 5,
        min_savings_ratio:
          intelligence?.cost_optimizer?.min_savings_ratio ?? 0.05,
        max_latency_penalty_ratio:
          intelligence?.cost_optimizer?.max_latency_penalty_ratio ?? 0.5,
        max_quality_penalty:
          intelligence?.cost_optimizer?.max_quality_penalty ?? 0.15,
        allow_quality_critical_downgrade:
          intelligence?.cost_optimizer?.allow_quality_critical_downgrade ?? false,
      },
      token_prediction: {
        enabled: intelligence?.token_prediction?.enabled ?? false,
        budget_policy: intelligence?.token_prediction?.budget_policy ?? 'observe',
        near_limit_ratio: intelligence?.token_prediction?.near_limit_ratio ?? 0.9,
        allow_quality_critical_downgrade:
          intelligence?.token_prediction?.allow_quality_critical_downgrade ?? false,
      },
      async_eval: {
        enabled: intelligence?.async_eval?.enabled ?? false,
        sample_rate: intelligence?.async_eval?.sample_rate ?? 0,
        dimensions: intelligence?.async_eval?.dimensions ?? [
          'latency',
          'toxicity',
          'relevance',
          'format',
        ],
        metadata_only: intelligence?.async_eval?.metadata_only ?? true,
        max_recent_jobs: intelligence?.async_eval?.max_recent_jobs ?? 200,
      },
      quality_gate: {
        enabled: intelligence?.quality_gate?.enabled ?? false,
        rules: intelligence?.quality_gate?.rules ?? [],
      },
    };
  }

  get embeddingBatching(): Required<EmbeddingBatchingConfig> {
    const batching = this.config.embedding_batching;
    return {
      enabled: batching?.enabled ?? false,
      window_ms: batching?.window_ms ?? 10,
      max_batch_size: batching?.max_batch_size ?? 64,
      max_input_items: batching?.max_input_items ?? 8,
      max_queue: batching?.max_queue ?? 1000,
      timeout_ms: batching?.timeout_ms ?? 10000,
    };
  }

  /** Get experimental realtime preview config with conservative defaults. */
  get realtime(): Required<RealtimeConfig> {
    const realtime = this.config.realtime;
    return {
      enabled: realtime?.enabled ?? false,
      path: realtime?.path ?? '/v1/realtime',
      max_connections: realtime?.max_connections ?? 25,
      max_connections_per_node:
        realtime?.max_connections_per_node ?? realtime?.max_connections ?? 25,
      idle_timeout_ms: realtime?.idle_timeout_ms ?? 300_000,
      upstream_connect_timeout_ms:
        realtime?.upstream_connect_timeout_ms ?? 10_000,
      max_session_ms: realtime?.max_session_ms ?? 1_800_000,
      default_node: realtime?.default_node ?? '',
      default_model: realtime?.default_model ?? 'auto',
    };
  }

  /** Get experimental MCP Gateway preview config with safe local-only defaults. */
  get mcpGateway(): Required<Omit<McpGatewayConfig, 'servers'>> & {
    servers: NonNullable<McpGatewayConfig['servers']>;
  } {
    const mcp = this.config.mcp;
    return {
      enabled: mcp?.enabled ?? false,
      path: mcp?.path ?? '/mcp',
      max_recent_calls: mcp?.max_recent_calls ?? 100,
      servers: mcp?.servers ?? [],
    };
  }

  get hotReload(): Required<HotReloadConfig> {
    const hotReload = this.config.hot_reload;
    return {
      watch: hotReload?.watch ?? false,
      debounce_ms: hotReload?.debounce_ms ?? 500,
    };
  }

  /** Get local webhook alerting config with conservative defaults. */
  get alerts(): Required<Omit<AlertsConfig, 'error_spike' | 'latency_spike'>> & {
    error_spike: Required<AlertSpikeRuleConfig>;
    latency_spike: Required<AlertLatencySpikeRuleConfig>;
  } {
    const alerts = this.config.alerts;
    return {
      enabled: alerts?.enabled ?? false,
      channels: alerts?.channels ?? [],
      history_size: alerts?.history_size ?? 50,
      error_spike: {
        enabled: alerts?.error_spike?.enabled ?? true,
        window_seconds: alerts?.error_spike?.window_seconds ?? 300,
        min_requests: alerts?.error_spike?.min_requests ?? 20,
        error_rate: alerts?.error_spike?.error_rate ?? 0.1,
      },
      latency_spike: {
        enabled: alerts?.latency_spike?.enabled ?? true,
        window_seconds: alerts?.latency_spike?.window_seconds ?? 300,
        min_requests: alerts?.latency_spike?.min_requests ?? 20,
        p95_ms: alerts?.latency_spike?.p95_ms ?? 10_000,
      },
    };
  }

  /** Get external log sink config with safe disabled-by-default behavior. */
  get logSinks(): Required<LoggingConfig> & { sinks: LogSinkConfig[] } {
    const logging = this.config.logging;
    return {
      enabled: logging?.enabled ?? false,
      sinks: logging?.sinks ?? [],
    };
  }

  /** Get shared state backend config with memory-safe defaults. */
  get state(): Required<Omit<StateBackendConfig, 'redis'>> & {
    redis: {
      url: string;
      prefix: string;
      timeout_ms: number;
      sync_interval_ms: number;
    };
    categories: Record<StateCategoryName, Required<StateCategoryConfig>>;
  } {
    const state = this.config.state;
    const unavailablePolicy = state?.unavailable_policy ?? 'fail_open';
    return {
      backend: state?.backend ?? 'memory',
      unavailable_policy: unavailablePolicy,
      redis: {
        url: state?.redis?.url ?? 'redis://localhost:6379',
        prefix: this.normalizeRedisPrefix(
          state?.redis?.prefix,
          'siftgate:state:',
        ),
        timeout_ms: state?.redis?.timeout_ms ?? 500,
        sync_interval_ms: state?.redis?.sync_interval_ms ?? 2000,
      },
      categories: this.normalizeStateCategories(
        state?.categories,
        unavailablePolicy,
      ),
    };
  }

  get cluster(): Required<Omit<ClusterConfig, 'redis'>> & {
    redis: {
      url: string;
      prefix: string;
    };
  } {
    const state = this.state;
    const cluster = this.config.cluster;
    const heartbeatInterval = cluster?.heartbeat_interval_seconds ?? 10;
    return {
      enabled: cluster?.enabled ?? state.backend === 'redis',
      instance_id:
        cluster?.instance_id ||
        process.env.SIFTGATE_INSTANCE_ID ||
        `${os.hostname()}-${process.pid}`,
      heartbeat_interval_seconds: heartbeatInterval,
      heartbeat_ttl_seconds:
        cluster?.heartbeat_ttl_seconds ?? Math.max(30, heartbeatInterval * 3),
      reload_broadcast: cluster?.reload_broadcast ?? true,
      redis: {
        url: cluster?.redis?.url ?? state.redis.url,
        prefix: this.normalizeRedisPrefix(
          cluster?.redis?.prefix ?? state.redis.prefix,
          state.redis.prefix,
        ),
      },
    };
  }

  get namespaces(): NamespaceConfig[] {
    return this.config.namespaces ?? [];
  }

  getNamespace(namespaceId?: string | null): NamespaceConfig | undefined {
    if (!namespaceId) return undefined;
    return this.namespaces.find((namespace) => namespace.id === namespaceId);
  }

  createNamespace(namespace: NamespaceConfig): ConfigReloadResult {
    const normalized = this.normalizeNamespaceForPersist(namespace, true);
    if (this.getNamespace(normalized.id)) {
      throw new Error(`Namespace with id "${normalized.id}" already exists`);
    }
    return this.replaceNamespaces([...this.namespaces, normalized]);
  }

  updateNamespace(
    namespaceId: string,
    updates: Partial<Omit<NamespaceConfig, 'id'>>,
  ): ConfigReloadResult {
    const id = this.normalizeNamespaceId(namespaceId);
    const idx = this.namespaces.findIndex((namespace) => namespace.id === id);
    if (idx === -1) {
      throw new Error(`Namespace "${id}" not found`);
    }
    const next = this.namespaces.map((namespace, index) =>
      index === idx
        ? this.normalizeNamespaceForPersist({ ...namespace, ...updates, id }, false)
        : namespace,
    );
    return this.replaceNamespaces(next);
  }

  deleteNamespace(namespaceId: string): ConfigReloadResult {
    const id = this.normalizeNamespaceId(namespaceId);
    if (!this.getNamespace(id)) {
      throw new Error(`Namespace "${id}" not found`);
    }
    return this.replaceNamespaces(this.namespaces.filter((namespace) => namespace.id !== id));
  }

  get shadowTraffic(): Required<Omit<ShadowTrafficConfig, 'target_node' | 'target_model' | 'compare'>> & {
    target_node?: string;
    target_model?: string;
    compare: {
      store_prompts: boolean;
      store_responses: boolean;
      sample_max_chars: number;
    };
  } {
    const shadow = this.config.shadow;
    return {
      enabled: shadow?.enabled ?? false,
      sample_rate: shadow?.sample_rate ?? 0,
      target_node: shadow?.target_node,
      target_model: shadow?.target_model,
      timeout_ms: shadow?.timeout_ms ?? 0,
      max_recent_results: shadow?.max_recent_results ?? 100,
      compare: {
        store_prompts: shadow?.compare?.store_prompts ?? false,
        store_responses: shadow?.compare?.store_responses ?? false,
        sample_max_chars: shadow?.compare?.sample_max_chars ?? 4000,
      },
    };
  }

  get secretManager(): Required<SecretManagerConfig> & {
    failure_policy: SecretManagerFailurePolicy;
    backends: {
      env: { enabled: boolean };
      vault: Required<VaultSecretManagerConfig>;
      aws_sm: Required<AwsSecretsManagerConfig>;
      gcp_sm: Required<GcpSecretManagerConfig>;
    };
  } {
    const secrets = this.config.secret_manager;
    return {
      cache_ttl_seconds: secrets?.cache_ttl_seconds ?? 300,
      failure_policy: secrets?.failure_policy ?? 'fail_closed',
      backends: {
        env: {
          enabled: secrets?.backends?.env?.enabled ?? true,
        },
        vault: {
          enabled: secrets?.backends?.vault?.enabled ?? false,
          address: secrets?.backends?.vault?.address ?? '',
          token: secrets?.backends?.vault?.token ?? '',
          mount: secrets?.backends?.vault?.mount ?? 'secret',
          kv_version: secrets?.backends?.vault?.kv_version ?? 2,
          timeout_ms: secrets?.backends?.vault?.timeout_ms ?? 5000,
        },
        aws_sm: {
          enabled: secrets?.backends?.aws_sm?.enabled ?? false,
          region: secrets?.backends?.aws_sm?.region ?? '',
          endpoint: secrets?.backends?.aws_sm?.endpoint ?? '',
          access_key_id: secrets?.backends?.aws_sm?.access_key_id ?? '',
          secret_access_key: secrets?.backends?.aws_sm?.secret_access_key ?? '',
          session_token: secrets?.backends?.aws_sm?.session_token ?? '',
          timeout_ms: secrets?.backends?.aws_sm?.timeout_ms ?? 5000,
        },
        gcp_sm: {
          enabled: secrets?.backends?.gcp_sm?.enabled ?? false,
          project_id: secrets?.backends?.gcp_sm?.project_id ?? '',
          endpoint: secrets?.backends?.gcp_sm?.endpoint ?? '',
          access_token: secrets?.backends?.gcp_sm?.access_token ?? '',
          use_metadata: secrets?.backends?.gcp_sm?.use_metadata ?? true,
          timeout_ms: secrets?.backends?.gcp_sm?.timeout_ms ?? 5000,
        },
      },
    };
  }

  get modelsPricing(): Record<string, ModelPricing> {
    return this.config.models_pricing;
  }

  get configAudit(): Required<ConfigAuditConfig> {
    const audit = this.config.config_audit;
    return {
      enabled: audit?.enabled ?? true,
      max_versions: audit?.max_versions ?? 50,
      max_events: audit?.max_events ?? 200,
      capture_startup_snapshot: audit?.capture_startup_snapshot ?? false,
    };
  }

  getConfigPath(): string {
    return this.configPath;
  }

  readRawConfigYaml(): string {
    return fs.readFileSync(this.configPath, 'utf8');
  }

  private replaceNamespaces(namespaces: NamespaceConfig[]): ConfigReloadResult {
    const rawYaml = this.buildYamlWithNamespaces(namespaces);
    this.validateCandidateConfigYaml(rawYaml);
    const result = this.restoreFromYaml(rawYaml, {
      source: 'dashboard',
      throwOnError: false,
    });
    if (!result.success) {
      throw new Error(result.error?.message || result.message);
    }
    return result;
  }

  private buildYamlWithNamespaces(namespaces: NamespaceConfig[]): string {
    const parsed = yaml.load(this.readRawConfigYaml());
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Invalid configuration: YAML root must be an object');
    }
    const next = parsed as GatewayConfig;
    next.namespaces = namespaces.map((namespace) => this.normalizeNamespaceForPersist(namespace, false));
    return yaml.dump(next, {
      indent: 2,
      lineWidth: 120,
      noRefs: true,
      sortKeys: false,
    });
  }

  private validateCandidateConfigYaml(rawYaml: string): void {
    const parsed = yaml.load(rawYaml);
    const validator = require('./config-validator') as typeof import('./config-validator');
    const result = validator.validateConfigObject(parsed, {
      configPath: this.configPath,
      env: process.env,
    });
    if (!result.ok) {
      const message = result.errors
        .slice(0, 5)
        .map((item) => `${item.path ? `${item.path}: ` : ''}${item.message}`)
        .join(' ');
      throw new Error(message || 'Configuration validation failed');
    }
  }

  private normalizeNamespaceForPersist(namespace: NamespaceConfig, creating: boolean): NamespaceConfig {
    const normalized: NamespaceConfig = {
      id: this.normalizeNamespaceId(namespace.id),
    };
    if (creating && this.namespaces.some((item) => item.id === normalized.id)) {
      throw new Error(`Namespace with id "${normalized.id}" already exists`);
    }
    const name = this.normalizeOptionalString(namespace.name);
    if (name) normalized.name = name;
    const allowedNodes = this.normalizeStringArray(namespace.allowed_nodes);
    if (allowedNodes.length > 0) normalized.allowed_nodes = allowedNodes;
    const allowedModels = this.normalizeStringArray(namespace.allowed_models);
    if (allowedModels.length > 0) normalized.allowed_models = allowedModels;
    const budget = this.normalizeNamespaceBudget(namespace.budget);
    if (budget) normalized.budget = budget;
    const rateLimit = this.normalizeNamespaceRateLimit(namespace.rate_limit);
    if (rateLimit) normalized.rate_limit = rateLimit;
    return normalized;
  }

  private normalizeNamespaceId(id: string | undefined): string {
    const normalized = (id || '').trim();
    if (!normalized) {
      throw new Error('Namespace id is required');
    }
    if (normalized.length > 80) {
      throw new Error('Namespace id must be 80 characters or fewer');
    }
    return normalized;
  }

  private normalizeOptionalString(value: string | undefined): string | undefined {
    const normalized = (value || '').trim();
    return normalized || undefined;
  }

  private normalizeStringArray(values: string[] | undefined): string[] {
    if (!Array.isArray(values)) return [];
    return [...new Set(values.map((value) => String(value).trim()).filter(Boolean))];
  }

  private normalizeNamespaceBudget(
    budget: NamespaceConfig['budget'] | null | undefined,
  ): NamespaceConfig['budget'] | undefined {
    if (!budget) return undefined;
    const normalized: NonNullable<NamespaceConfig['budget']> = {};
    if (budget.daily_token_limit !== undefined) {
      normalized.daily_token_limit = Number(budget.daily_token_limit);
    }
    if (budget.daily_cost_limit !== undefined) {
      normalized.daily_cost_limit = Number(budget.daily_cost_limit);
    }
    if (budget.alert_threshold !== undefined) {
      normalized.alert_threshold = Number(budget.alert_threshold);
    }
    return Object.keys(normalized).length > 0 ? normalized : undefined;
  }

  private normalizeNamespaceRateLimit(
    rateLimit: NamespaceConfig['rate_limit'] | null | undefined,
  ): NamespaceConfig['rate_limit'] | undefined {
    if (!rateLimit) return undefined;
    const rpm = rateLimit.requests_per_minute;
    return rpm === undefined ? undefined : { requests_per_minute: Number(rpm) };
  }

  private normalizeRedisPrefix(prefix: string | undefined, fallback = 'siftgate:'): string {
    const value = prefix && prefix.length > 0 ? prefix : fallback;
    return value.endsWith(':') ? value : `${value}:`;
  }

  private normalizeStateCategories(
    categories: StateBackendConfig['categories'],
    unavailablePolicy: StateUnavailablePolicy,
  ): Record<StateCategoryName, Required<StateCategoryConfig>> {
    const defaults: Record<StateCategoryName, Required<StateCategoryConfig>> = {
      rate_limit: { unavailable_policy: unavailablePolicy, ttl_seconds: 60 },
      circuit_breaker: { unavailable_policy: unavailablePolicy, ttl_seconds: 3600 },
      cache_affinity: { unavailable_policy: 'fail_open', ttl_seconds: 1800 },
      momentum: { unavailable_policy: 'fail_open', ttl_seconds: 1800 },
      prompt_cache: { unavailable_policy: 'fail_open', ttl_seconds: 300 },
      semantic_cache: { unavailable_policy: 'fail_open', ttl_seconds: 3600 },
      concurrency: { unavailable_policy: unavailablePolicy, ttl_seconds: 120 },
      health_probe: { unavailable_policy: 'fail_open', ttl_seconds: 120 },
      realtime_session: { unavailable_policy: 'fail_open', ttl_seconds: 1800 },
    };
    for (const key of Object.keys(defaults) as StateCategoryName[]) {
      const override = categories?.[key];
      defaults[key] = {
        unavailable_policy:
          override?.unavailable_policy ?? defaults[key].unavailable_policy,
        ttl_seconds: override?.ttl_seconds ?? defaults[key].ttl_seconds,
      };
    }
    return defaults;
  }

  /** Get hosted control-plane config with safe privacy-preserving defaults. */
  get controlPlane(): Required<ControlPlaneConfig> & {
    telemetry: {
      upload_interval_seconds: number;
      include_prompt: boolean;
      include_response: boolean;
    };
  } {
    const cp = this.config.control_plane;
    return {
      enabled: cp?.enabled ?? false,
      url: cp?.url ?? '',
      gateway_id: cp?.gateway_id ?? '',
      registration_token: cp?.registration_token ?? '',
      telemetry: {
        upload_interval_seconds: cp?.telemetry?.upload_interval_seconds ?? 30,
        include_prompt: cp?.telemetry?.include_prompt ?? false,
        include_response: cp?.telemetry?.include_response ?? false,
      },
    };
  }

  /** Get a specific node by ID */
  getNode(nodeId: string): NodeConfig | undefined {
    return this.config.nodes.find((n) => n.id === nodeId);
  }

  /** Get pricing for a specific model, preferring node/model overrides when a node is supplied. */
  getModelPricing(model: string, nodeId?: string): (ModelPricing & {
    source?: string;
    currency?: string;
    catalog_source?: string;
    manual_review_required?: boolean;
    pricing_confidence?: string;
  }) | undefined {
    const node = nodeId ? this.getNode(nodeId) : undefined;
    const configured = selectConfiguredLegacyPricing(this.config.models_pricing, model, node);
    const price = configured?.pricing ?? this.getCatalogPricingFallback(model, nodeId);
    return price ? withLegacyCachePricing(price, model, node) : undefined;
  }

  private getCatalogPricingFallback(
    model: string,
    nodeId?: string,
  ): (ModelPricing & {
    source?: string;
    currency?: string;
    catalog_source?: string;
    manual_review_required?: boolean;
    pricing_confidence?: string;
  }) | undefined {
    const catalog = this.getMergedCatalogForPricing();
    if (!catalog) return undefined;
    try {
      const catalogModule = require('../catalog/catalog.service') as typeof import('../catalog/catalog.service');
      const catalogModel = catalogModule.findCatalogModelForNode(
        catalog,
        model,
        nodeId ? this.getNode(nodeId) : undefined,
      );
      return catalogModule.catalogModelToModelPricing(catalogModel);
    } catch (error) {
      this.logger.warn(
        error instanceof Error
          ? `Catalog pricing fallback failed: ${error.message}`
          : 'Catalog pricing fallback failed.',
      );
      return undefined;
    }
  }

  private getMergedCatalogForPricing(): ProviderCatalog | undefined {
    if (this.catalogPricingCache?.configVersion === this.configVersion) {
      return this.catalogPricingCache.catalog;
    }
    try {
      const catalogModule = require('../catalog/catalog.service') as typeof import('../catalog/catalog.service');
      const loaded = catalogModule.loadMergedCatalog({
        cwd: process.cwd(),
        env: process.env,
        config: this.config,
      });
      this.catalogPricingCache = {
        configVersion: this.configVersion,
        catalog: loaded.catalog,
      };
      return loaded.catalog;
    } catch (error) {
      this.logger.warn(
        error instanceof Error
          ? `Could not load provider catalog for pricing fallback: ${error.message}`
          : 'Could not load provider catalog for pricing fallback.',
      );
      return undefined;
    }
  }

  /** Resolve a user-provided embedding model name to a node/model pair. */
  resolveEmbeddingModel(name: string): { nodeId: string; model: string } | null {
    for (const node of this.config.nodes) {
      if (node.embedding_models?.includes(name)) {
        return { nodeId: node.id, model: name };
      }
    }

    const nodeById = this.config.nodes.find((node) => node.id === name);
    if (nodeById?.embedding_models?.length) {
      return { nodeId: nodeById.id, model: nodeById.embedding_models[0] };
    }

    for (const separator of ['/', ':']) {
      const idx = name.indexOf(separator);
      if (idx <= 0) continue;
      const prefix = name.substring(0, idx);
      const modelPart = name.substring(idx + 1);
      const prefixNode = this.config.nodes.find((node) => node.id === prefix);
      if (prefixNode?.embedding_models?.length && modelPart) {
        return { nodeId: prefixNode.id, model: modelPart };
      }
    }

    return null;
  }

  /** Resolve a user-provided rerank model name to a node/model pair. */
  resolveRerankModel(name: string): { nodeId: string; model: string } | null {
    for (const node of this.config.nodes) {
      if (node.rerank_models?.includes(name)) {
        return { nodeId: node.id, model: name };
      }
    }

    const nodeById = this.config.nodes.find((node) => node.id === name);
    if (nodeById?.rerank_models?.length) {
      return { nodeId: nodeById.id, model: nodeById.rerank_models[0] };
    }

    for (const separator of ['/', ':']) {
      const idx = name.indexOf(separator);
      if (idx <= 0) continue;
      const prefix = name.substring(0, idx);
      const modelPart = name.substring(idx + 1);
      const prefixNode = this.config.nodes.find((node) => node.id === prefix);
      if (prefixNode?.rerank_models?.length && modelPart) {
        return { nodeId: prefixNode.id, model: modelPart };
      }
    }

    return null;
  }

  /** Resolve a user-provided realtime model name to a node/model pair. */
  resolveRealtimeModel(name: string): { nodeId: string; model: string } | null {
    for (const node of this.config.nodes) {
      if (node.realtime_models?.includes(name)) {
        return { nodeId: node.id, model: name };
      }
    }

    const nodeById = this.config.nodes.find((node) => node.id === name);
    if (nodeById?.realtime_models?.length) {
      return { nodeId: nodeById.id, model: nodeById.realtime_models[0] };
    }

    for (const separator of ['/', ':']) {
      const idx = name.indexOf(separator);
      if (idx <= 0) continue;
      const prefix = name.substring(0, idx);
      const modelPart = name.substring(idx + 1);
      const prefixNode = this.config.nodes.find((node) => node.id === prefix);
      if (prefixNode?.realtime_models?.includes(modelPart)) {
        return { nodeId: prefixNode.id, model: modelPart };
      }
    }

    return null;
  }

  /** Resolve a user-provided image model name to a node/model pair. */
  resolveImageModel(name: string): { nodeId: string; model: string } | null {
    for (const node of this.config.nodes) {
      if (node.image_models?.includes(name)) {
        return { nodeId: node.id, model: name };
      }
    }

    const nodeById = this.config.nodes.find((node) => node.id === name);
    if (nodeById?.image_models?.length) {
      return { nodeId: nodeById.id, model: nodeById.image_models[0] };
    }

    for (const separator of ['/', ':']) {
      const idx = name.indexOf(separator);
      if (idx <= 0) continue;
      const prefix = name.substring(0, idx);
      const modelPart = name.substring(idx + 1);
      const prefixNode = this.config.nodes.find((node) => node.id === prefix);
      if (prefixNode?.image_models?.length && modelPart) {
        return { nodeId: prefixNode.id, model: modelPart };
      }
    }

    return null;
  }

  /** Resolve a user-provided audio model name to a node/model pair. */
  resolveAudioModel(name: string): { nodeId: string; model: string } | null {
    for (const node of this.config.nodes) {
      if (node.audio_models?.includes(name)) {
        return { nodeId: node.id, model: name };
      }
    }

    const nodeById = this.config.nodes.find((node) => node.id === name);
    if (nodeById?.audio_models?.length) {
      return { nodeId: nodeById.id, model: nodeById.audio_models[0] };
    }

    for (const separator of ['/', ':']) {
      const idx = name.indexOf(separator);
      if (idx <= 0) continue;
      const prefix = name.substring(0, idx);
      const modelPart = name.substring(idx + 1);
      const prefixNode = this.config.nodes.find((node) => node.id === prefix);
      if (prefixNode?.audio_models?.length && modelPart) {
        return { nodeId: prefixNode.id, model: modelPart };
      }
    }

    return null;
  }

  /** Resolve a user-provided video model name to a node/model pair. */
  resolveVideoModel(name: string): { nodeId: string; model: string } | null {
    for (const node of this.config.nodes) {
      if (node.video_models?.includes(name)) {
        return { nodeId: node.id, model: name };
      }
    }

    const nodeById = this.config.nodes.find((node) => node.id === name);
    if (nodeById?.video_models?.length) {
      return { nodeId: nodeById.id, model: nodeById.video_models[0] };
    }

    for (const separator of ['/', ':']) {
      const idx = name.indexOf(separator);
      if (idx <= 0) continue;
      const prefix = name.substring(0, idx);
      const modelPart = name.substring(idx + 1);
      const prefixNode = this.config.nodes.find((node) => node.id === prefix);
      if (prefixNode?.video_models?.length && modelPart) {
        return { nodeId: prefixNode.id, model: modelPart };
      }
    }

    return null;
  }

  /** Get the full raw config (for dashboard API) */
  getFullConfig(): GatewayConfig {
    return this.config;
  }

  /** Preserve raw secret references while editing/reordering connector entries. */
  getAlertSettingsForEditing(): AlertsConfig {
    return this.cloneConfig(this.prepareConfigForPersistence().alerts || {});
  }

  updateAlertSettings(enabled: boolean, channels: AlertChannelConfig[]): void {
    if (typeof enabled !== 'boolean' || channels.length > 20) throw new Error('Invalid alert configuration');
    channels.forEach((channel) => validateChannel(channel, { allowReferences: true }));
    const previous = this.config.alerts;
    this.config.alerts = { ...previous, enabled, channels: this.cloneConfig(channels) };
    try { this.saveConfig(true); } catch {
      this.config.alerts = previous;
      throw new Error('Unable to persist alert settings; the previous configuration remains active.');
    }
  }

  /** Get structured node/model naming diagnostics for dashboard and tests. */
  getNodeModelDiagnostics(): ConfigDiagnostic[] {
    return buildNodeModelDiagnostics(this.config);
  }

  // ===== Model Resolution =====

  /**
   * Resolve a user-provided model name to { nodeId, model }.
   *
   * Resolution order:
   *   1. Exact match: model ID exists in some node's `models[]`
   *   2. Alias match: model name matches some node's `model_aliases`
   *   3. Node ID shortcut: model name matches a node's `id` → use that node's first model
   *   4. Node prefix match: model name starts with a node's `id` + separator (e.g. "anthropic-prod/my-custom")
   *      → route to that node, pass-through the model name as-is
   *   5. Model-family prefix match: model name starts with the node id or an explicit
   *      `model_prefixes[]` entry followed by "-" (e.g. "claude-opus-4-6")
   *      → route to that node, pass model through as-is
   *   6. null: truly unknown — will fall through to auto routing
   *
   * This design allows users to send ANY model name. If it can be associated
   * with a node, it gets routed there with the model name passed through
   * to the upstream API. The upstream decides if the model is valid.
   */
  resolveModel(name: string): { nodeId: string; model: string } | null {
    // 1. Exact match against node models[]
    for (const node of this.config.nodes) {
      if (node.models.includes(name)) {
        return { nodeId: node.id, model: name };
      }
    }

    // 2. Alias match against node model_aliases
    for (const node of this.config.nodes) {
      if (node.model_aliases) {
        const resolved = node.model_aliases[name];
        if (resolved) {
          return { nodeId: node.id, model: resolved };
        }
      }
    }

    // 3. Node ID shortcut — "claude" → claude node's first model
    const nodeById = this.config.nodes.find((n) => n.id === name);
    if (nodeById) {
      return { nodeId: nodeById.id, model: nodeById.models[0] };
    }

    // 4. Prefix match — "gpt/my-custom-model" or "claude:my-ft" → route to node, pass model through
    const separators = ['/', ':'];
    for (const sep of separators) {
      const idx = name.indexOf(sep);
      if (idx > 0) {
        const prefix = name.substring(0, idx);
        const modelPart = name.substring(idx + 1);
        const prefixNode = this.config.nodes.find((n) => n.id === prefix);
        if (prefixNode && modelPart) {
          return { nodeId: prefixNode.id, model: modelPart };
        }
      }
    }

    // 5. Model-family prefix match — "claude-opus-4-6" → anthropic node, pass model through
    for (const node of this.config.nodes) {
      const prefixes = [node.id, ...(node.model_prefixes || [])];
      for (const prefix of prefixes) {
        if (prefix && name.startsWith(`${prefix}-`)) {
          return { nodeId: node.id, model: name };
        }
      }
    }

    // 6. Not found
    return null;
  }

  /**
   * Get all available models (for GET /v1/models endpoint).
   * Returns model IDs, aliases, and node ID shortcuts.
   */
  listModels(): {
    id: string;
    node: string;
    nodeName: string;
    upstreamModel?: string;
    aliases: string[];
    isAlias: boolean;
  }[] {
    const models: {
      id: string;
      node: string;
      nodeName: string;
      upstreamModel?: string;
      aliases: string[];
      isAlias: boolean;
    }[] = [];

    for (const node of this.config.nodes) {
      for (const modelId of Array.from(new Set([
        ...node.models,
        ...(node.embedding_models || []),
        ...(node.rerank_models || []),
        ...(node.image_models || []),
        ...(node.audio_models || []),
        ...(node.video_models || []),
      ]))) {
        // Collect all aliases pointing to this model
        const aliases: string[] = [];
        if (node.model_aliases) {
          for (const [alias, target] of Object.entries(node.model_aliases)) {
            if (target === modelId) {
              aliases.push(alias);
            }
          }
        }
        // Node ID is always an implicit alias for models[0]
        if (modelId === node.models[0]) {
          aliases.push(node.id);
        }

        models.push({
          id: modelId,
          node: node.id,
          nodeName: node.name,
          upstreamModel: node.upstream_model_aliases?.[modelId],
          aliases,
          isAlias: false,
        });
      }
    }

    return models;
  }

  // ===== Config Persistence =====

  /**
   * Write the current in-memory config back to the YAML file.
   * Startup-time ${VAR} references are resolved in memory, so we overlay the
   * last loaded raw references when the user did not edit that value.
   */
  private saveConfig(privateFile = false): void {
    const configToPersist = this.prepareConfigForPersistence();
    const yamlStr = yaml.dump(configToPersist, {
      indent: 2,
      lineWidth: 120,
      noRefs: true,
      sortKeys: false,
    });
    this.writeConfigFileAtomic(yamlStr, privateFile ? 0o600 : undefined);
    this.originalConfigForPersistence = this.cloneConfig(configToPersist);
    this.resolvedConfigForPersistence = this.cloneConfig(this.config);
    this.logger.log(`Configuration saved to ${this.configPath}`);
  }

  private writeConfigFileAtomic(contents: string, modeOverride?: number): void {
    const dir = path.dirname(this.configPath);
    const base = path.basename(this.configPath);
    const tempPath = path.join(
      dir,
      `.${base}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
    );
    const mode = modeOverride ?? this.configFileMode();
    let wroteTemp = false;

    try {
      const fd = fs.openSync(tempPath, 'w', mode);
      try {
        fs.writeFileSync(fd, contents, 'utf8');
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.chmodSync(tempPath, mode);
      wroteTemp = true;
      fs.renameSync(tempPath, this.configPath);
      this.fsyncDirectoryBestEffort(dir);
    } catch (err) {
      if (wroteTemp || fs.existsSync(tempPath)) {
        try {
          fs.unlinkSync(tempPath);
        } catch {
          // Best effort cleanup only; preserve the original write failure.
        }
      }
      throw err;
    }
  }

  private configFileMode(): number {
    try {
      return fs.statSync(this.configPath).mode & 0o777;
    } catch {
      return 0o600;
    }
  }

  private fsyncDirectoryBestEffort(dir: string): void {
    try {
      const fd = fs.openSync(dir, 'r');
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      // Some platforms/filesystems do not allow opening directories.
    }
  }

  private prepareConfigForPersistence(): GatewayConfig {
    return this.preserveUneditedSecretReferences(
      this.config,
      this.originalConfigForPersistence,
      this.resolvedConfigForPersistence,
    ) as GatewayConfig;
  }

  private preserveUneditedSecretReferences(
    current: unknown,
    original: unknown,
    resolved: unknown,
  ): unknown {
    if (
      typeof current === 'string' &&
      typeof original === 'string' &&
      typeof resolved === 'string' &&
      containsSecretReference(original) &&
      current === resolved
    ) {
      return original;
    }

    if (Array.isArray(current)) {
      const originalArray = Array.isArray(original) ? original : [];
      const resolvedArray = Array.isArray(resolved) ? resolved : [];
      return current.map((item, index) => {
        const itemId = this.objectId(item);
        const originalItem = itemId
          ? originalArray.find((candidate) => this.objectId(candidate) === itemId)
          : originalArray[index];
        const resolvedItem = itemId
          ? resolvedArray.find((candidate) => this.objectId(candidate) === itemId)
          : resolvedArray[index];
        return this.preserveUneditedSecretReferences(item, originalItem, resolvedItem);
      });
    }

    if (current !== null && typeof current === 'object') {
      const originalObject = this.asRecord(original);
      const resolvedObject = this.asRecord(resolved);
      const output: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(current)) {
        output[key] = this.preserveUneditedSecretReferences(
          value,
          originalObject?.[key],
          resolvedObject?.[key],
        );
      }
      return output;
    }

    return current;
  }

  private objectId(value: unknown): string | undefined {
    if (value !== null && typeof value === 'object') {
      const id = (value as Record<string, unknown>).id;
      return typeof id === 'string' ? id : undefined;
    }
    return undefined;
  }

  private asRecord(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  }

  private cloneConfig<T>(config: T): T {
    return yaml.load(yaml.dump(config, { noRefs: true })) as T;
  }

  // ===== Node CRUD =====

  /** Add a new node. Throws if a node with the same ID already exists. */
  addNode(node: NodeConfig): void {
    if (this.config.nodes.some((n) => n.id === node.id)) {
      throw new Error(`Node with id "${node.id}" already exists`);
    }
    this.config.nodes.push(node);
    this.warnAboutNodeModelResolutionConflicts();
    this.saveConfig();
    this.logger.log(`Node "${node.id}" added`);
  }

  /**
   * Update an existing node. The `id` field cannot be changed.
   * Only provided fields are merged; omitted fields keep their current value.
   */
  updateNode(nodeId: string, updates: Partial<Omit<NodeConfig, 'id'>>): void {
    const idx = this.config.nodes.findIndex((n) => n.id === nodeId);
    if (idx === -1) {
      throw new Error(`Node "${nodeId}" not found`);
    }
    this.config.nodes[idx] = { ...this.config.nodes[idx], ...updates, id: nodeId };
    this.warnAboutNodeModelResolutionConflicts();
    this.saveConfig();
    this.logger.log(`Node "${nodeId}" updated`);
  }

  /**
   * Delete a node by ID. Also cleans up routing references.
   * Throws if trying to delete the last remaining node.
   */
  deleteNode(nodeId: string): void {
    const idx = this.config.nodes.findIndex((n) => n.id === nodeId);
    if (idx === -1) {
      throw new Error(`Node "${nodeId}" not found`);
    }
    if (this.config.nodes.length <= 1) {
      throw new Error('Cannot delete the last remaining node');
    }

    this.config.nodes.splice(idx, 1);
    this.cleanupRoutingReferences(nodeId);
    this.saveConfig();
    this.logger.log(`Node "${nodeId}" deleted`);
  }

  /**
   * Remove a deleted node from all routing tier references.
   * - If the node is a fallback, simply remove it from the fallbacks array
   * - If the node is the primary, promote the first fallback to primary
   * - If no fallbacks remain, assign the first available node
   */
  private cleanupRoutingReferences(deletedNodeId: string): void {
    const tiers = this.config.routing.tiers;
    const firstAvailableNodeId = this.config.nodes[0]?.id;

    for (const [tierName, tierConfig] of Object.entries(tiers)) {
      // Remove from fallbacks
      tierConfig.fallbacks = (tierConfig.fallbacks || []).filter(
        (fb) => fb.node !== deletedNodeId,
      );

      // If primary was the deleted node, promote
      if (tierConfig.primary?.node === deletedNodeId) {
        if (tierConfig.fallbacks.length > 0) {
          tierConfig.primary = tierConfig.fallbacks.shift()!;
        } else if (firstAvailableNodeId) {
          // Assign first available node with its first model
          const fallbackNode = this.config.nodes[0];
          tierConfig.primary = {
            node: fallbackNode.id,
            model: fallbackNode.models[0],
          };
        }
        this.logger.warn(
          `Tier "${tierName}": primary was deleted node "${deletedNodeId}", promoted new primary`,
        );
      }

      // Clean up split variants referencing the deleted node
      if (tierConfig.split) {
        tierConfig.split = tierConfig.split.filter(v => v.node !== deletedNodeId);
        if (tierConfig.split.length === 0) {
          delete tierConfig.split;  // All variants removed, disable split
        } else {
          // Renormalize weights to sum to 100
          const total = tierConfig.split.reduce((s, v) => s + v.weight, 0);
          if (total !== 100 && total > 0) {
            tierConfig.split.forEach(v => { v.weight = Math.round(v.weight * 100 / total); });
          }
        }
      }

      if (tierConfig.targets) {
        tierConfig.targets = tierConfig.targets.filter(t => t.node !== deletedNodeId);
        if (tierConfig.targets.length === 0) {
          delete tierConfig.targets;
        }
      }
    }

    // Clean up domain_preferences
    if (this.config.routing.domain_preferences) {
      for (const [domain, nodeIds] of Object.entries(
        this.config.routing.domain_preferences,
      )) {
        this.config.routing.domain_preferences[domain] = nodeIds.filter(
          (id) => id !== deletedNodeId,
        );
      }
    }
  }

  /**
   * Direct model resolution is intentionally permissive, but ambiguous names
   * are hard for users to reason about. Warn instead of throwing so existing
   * configs keep working while operators get a clear fix path.
   */
  private warnAboutNodeModelResolutionConflicts(): void {
    for (const diagnostic of buildNodeModelDiagnostics(this.config)) {
      if (
        diagnostic.code === 'missing_model_pricing' &&
        diagnostic.model &&
        this.getCatalogPricingFallback(diagnostic.model)
      ) {
        continue;
      }
      this.logger.warn(diagnostic.message);
    }
  }
  // ===== Model Pricing CRUD =====

  /** Set or update pricing for a model. */
  setModelPricing(model: string, pricing: ModelPricing): void {
    this.config.models_pricing[model] = pricing;
    this.saveConfig();
    this.logger.log(`Pricing set for model "${model}"`);
  }

  /** Delete pricing for a model. */
  deleteModelPricing(model: string): void {
    if (!(model in this.config.models_pricing)) {
      throw new Error(`Pricing for model "${model}" not found`);
    }
    delete this.config.models_pricing[model];
    this.saveConfig();
    this.logger.log(`Pricing deleted for model "${model}"`);
  }

  // ===== Routing Update =====

  /** Update routing configuration (tiers, scoring thresholds, domain preferences). */
  updateRouting(updates: {
    tiers?: Record<string, {
      primary?: { node: string; model: string };
      fallbacks?: { node: string; model: string }[];
      strategy?: 'weighted' | 'round_robin' | 'least_latency' | 'random';
      targets?: { node: string; model: string; weight?: number; name?: string }[];
      split?: { node: string; model: string; weight: number; name?: string }[];
    }>;
    scoring?: { simple_max: number; standard_max: number; complex_max: number };
    optimization?: 'cost' | 'latency' | 'balanced' | 'quality';
    domain_preferences?: Record<string, string[]>;
  }): void {
    if (updates.tiers) {
      // Validate all referenced nodes exist
      for (const [tierName, tier] of Object.entries(updates.tiers)) {
        if (!tier.primary && (!tier.targets || tier.targets.length === 0)) {
          throw new Error(`Tier "${tierName}" must define primary or targets`);
        }
        if (tier.strategy && !['weighted', 'round_robin', 'least_latency', 'random'].includes(tier.strategy)) {
          throw new Error(`Tier "${tierName}" strategy "${tier.strategy}" is not supported`);
        }
        if (tier.primary) {
          this.validateRouteTarget(tier.primary, tierName, 'primary');
        }
        (tier.fallbacks || []).forEach((fb, i) => this.validateRouteTarget(fb, tierName, `fallback[${i}]`));
        if (tier.targets) {
          if (tier.targets.length === 0) {
            throw new Error(`Tier "${tierName}" targets must not be empty`);
          }
          let totalWeight = 0;
          for (const [idx, target] of tier.targets.entries()) {
            this.validateRouteTarget(target, tierName, `targets[${idx}]`);
            const weight = target.weight ?? 1;
            if (weight < 0) {
              throw new Error(`Tier "${tierName}" targets[${idx}] weight must be >= 0`);
            }
            totalWeight += weight;
          }
          if ((tier.strategy || 'weighted') === 'weighted' && totalWeight <= 0) {
            throw new Error(`Tier "${tierName}" weighted targets must have total weight > 0`);
          }
        }

        // Validate split variants if present
        if (tier.split) {
          const totalWeight = tier.split.reduce((sum, v) => sum + v.weight, 0);
          if (totalWeight !== 100) {
            throw new Error(`Tier "${tierName}" split weights must sum to 100, got ${totalWeight}`);
          }
          for (const v of tier.split) {
            this.validateRouteTarget({ node: v.node, model: v.model }, tierName, 'split variant');
          }
        }
      }
      this.config.routing.tiers = updates.tiers;
    }
    if (updates.scoring) {
      this.config.routing.scoring = updates.scoring;
    }
    if (updates.optimization !== undefined) {
      if (!['cost', 'latency', 'balanced', 'quality'].includes(updates.optimization)) {
        throw new Error(`Routing optimization "${updates.optimization}" is not supported`);
      }
      this.config.routing.optimization = updates.optimization;
    }
    if (updates.domain_preferences !== undefined) {
      this.config.routing.domain_preferences = updates.domain_preferences;
    }
    this.saveConfig();
    this.logger.log('Routing configuration updated');
  }

  private validateRouteTarget(
    target: { node: string; model: string },
    tierName: string,
    label: string,
  ): void {
    const node = this.config.nodes.find((n) => n.id === target.node);
    if (!node) {
      throw new Error(`Tier "${tierName}" ${label}: node "${target.node}" not found`);
    }
  }
}

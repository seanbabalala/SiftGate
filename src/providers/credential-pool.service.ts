import { Injectable, Optional } from '@nestjs/common';
import {
  CredentialPoolConfig,
  CredentialPoolStrategy,
  CredentialStickyBy,
  NodeConfig,
  NodeCredentialConfig,
} from '../config/gateway.config';
import { CanonicalRequestMetadata, TokenUsage } from '../canonical/canonical.types';
import { StateBackendService } from '../state/state-backend.service';

const DEFAULT_RETRY_STATUSES = [429, 500, 502, 503, 504];
const AUTH_FAILURE_STATUSES = [401, 403];
const CACHE_AFFINITY_TTL_MS = 60 * 60 * 1000;
const CACHE_AFFINITY_STATE_TTL_SECONDS = Math.ceil(CACHE_AFFINITY_TTL_MS / 1000);
const CACHE_AFFINITY_STATE_PREFIX = 'credential:';

export interface CredentialSelection {
  nodeId: string;
  credential: NodeCredentialConfig;
  strategy: CredentialPoolStrategy;
  stickyBy: CredentialStickyBy;
  cooldownMs: number;
  maxFailures: number;
  retryOnStatus: number[];
  synthetic: boolean;
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

interface CredentialState {
  active: number;
  failures: number;
  cooldownUntil: number;
  lastStatus: number | null;
  lastError: string | null;
  updatedAt: number | null;
}

interface SelectionContext {
  metadata?: CanonicalRequestMetadata;
  triedCredentialIds?: Set<string>;
}

interface ReportResult {
  statusCode?: number;
  failureType?: string;
  error?: string | null;
  retryAfter?: string | null;
}

interface CredentialCacheAffinity {
  credentialId: string;
  updatedAt: number;
  lastCacheReadTokens: number;
  lastCacheCreationTokens: number;
  workspaceId?: string | null;
}

@Injectable()
export class CredentialPoolService {
  private readonly states = new Map<string, CredentialState>();
  private readonly roundRobinCursors = new Map<string, number>();
  private readonly stickyAssignments = new Map<string, string>();
  private readonly cacheAffinities = new Map<string, CredentialCacheAffinity>();

  constructor(
    @Optional() private readonly stateBackend?: StateBackendService,
  ) {}

  async select(node: NodeConfig, context: SelectionContext = {}): Promise<CredentialSelection> {
    if (node.disabled === true) throw new Error(`Node "${node.id}" is disabled`);
    const credentials = this.listCredentials(node);
    if (credentials.length === 0) {
      throw new Error(`Node "${node.id}" must define api_key or credentials`);
    }

    const pool = this.resolvePool(node);
    const enabled = credentials.filter((entry) => entry.enabled !== false);
    if (enabled.length === 0) {
      throw new Error(`Node "${node.id}" has no enabled provider credentials`);
    }

    const tried = context.triedCredentialIds || new Set<string>();
    const untried = enabled.filter((entry) => !tried.has(entry.id));
    const candidates = this.availableCredentials(node.id, untried.length ? untried : enabled);
    const stickyKey = this.stickyKey(node.id, pool.sticky_by, context.metadata);
    if (pool.strategy === 'cache_aware') {
      const cacheAffinityKeys = this.cacheAffinityKeys(node.id, pool.sticky_by, context.metadata);
      await this.hydrateCacheAffinities(cacheAffinityKeys, context.metadata);
      const cached = this.selectCacheAware(node.id, candidates, cacheAffinityKeys);
      if (cached) {
        if (stickyKey) {
          this.stickyAssignments.set(stickyKey, cached.id);
        }
        this.markActive(node.id, cached.id);
        return this.toSelection(node, cached, pool, credentials);
      }
    }

    if (stickyKey) {
      const assignedId = this.stickyAssignments.get(stickyKey);
      const assigned = assignedId
        ? candidates.find((entry) => entry.id === assignedId)
        : undefined;
      if (assigned) {
        this.markActive(node.id, assigned.id);
        return this.toSelection(node, assigned, pool, credentials);
      }
    }

    const selected = this.selectFallback(node.id, candidates, pool.strategy);

    if (stickyKey) {
      this.stickyAssignments.set(stickyKey, selected.id);
    }
    this.markActive(node.id, selected.id);
    return this.toSelection(node, selected, pool, credentials);
  }

  complete(selection: CredentialSelection, result: ReportResult): void {
    const state = this.stateFor(selection.nodeId, selection.credential.id);
    state.active = Math.max(0, state.active - 1);

    const statusCode = result.statusCode ?? null;
    state.lastStatus = statusCode;
    state.lastError = result.error || null;
    state.updatedAt = Date.now();

    if (statusCode !== null && statusCode >= 200 && statusCode < 400) {
      state.failures = 0;
      state.cooldownUntil = 0;
      return;
    }

    if (statusCode === 400 || statusCode === 499) {
      return;
    }

    const pool = this.resolvePoolFromSelection(selection);
    if (
      statusCode !== null &&
      AUTH_FAILURE_STATUSES.includes(statusCode)
    ) {
      state.failures = Math.max(state.failures + 1, pool.max_failures);
      state.cooldownUntil = Date.now() + Math.max(pool.cooldown_ms, 300_000);
      this.clearCacheAffinitiesForCredential(selection.nodeId, selection.credential.id);
      return;
    }

    if (
      result.failureType === 'timeout' ||
      result.failureType === 'network_error' ||
      statusCode === 0 ||
      (statusCode !== null && pool.retry_on_status.includes(statusCode))
    ) {
      state.failures += 1;
      const retryAfterMs = parseRetryAfterMs(result.retryAfter);
      const baseCooldown = retryAfterMs ?? pool.cooldown_ms;
      state.cooldownUntil = Date.now() + Math.max(0, baseCooldown);
    }
  }

  recordUsage(
    selection: CredentialSelection,
    usage: Pick<TokenUsage, 'cache_read_input_tokens' | 'cache_creation_input_tokens'> | undefined,
    metadata?: CanonicalRequestMetadata,
  ): void {
    if (selection.strategy !== 'cache_aware') return;

    const cacheReadTokens = Math.max(0, Number(usage?.cache_read_input_tokens || 0));
    const cacheCreationTokens = Math.max(0, Number(usage?.cache_creation_input_tokens || 0));
    if (cacheReadTokens <= 0 && cacheCreationTokens <= 0) return;

    const keys = this.cacheAffinityKeys(selection.nodeId, selection.stickyBy, metadata);
    if (keys.length === 0) return;

    const affinity: CredentialCacheAffinity = {
      credentialId: selection.credential.id,
      updatedAt: Date.now(),
      lastCacheReadTokens: cacheReadTokens,
      lastCacheCreationTokens: cacheCreationTokens,
      workspaceId: metadata?.workspace_id ?? null,
    };
    for (const key of keys) {
      this.cacheAffinities.set(key, affinity);
      void this.persistCacheAffinity(key, affinity, metadata).catch(() => undefined);
    }
  }

  shouldRetry(
    node: NodeConfig,
    statusCode: number,
    failureType?: string,
  ): boolean {
    const credentials = this.listCredentials(node).filter((entry) => entry.enabled !== false);
    if (credentials.length <= 1 || this.resolvePool(node).enabled === false) return false;
    if (AUTH_FAILURE_STATUSES.includes(statusCode)) return true;
    if (failureType === 'timeout' || failureType === 'network_error') return true;
    return this.resolvePool(node).retry_on_status.includes(statusCode);
  }

  attemptLimit(node: NodeConfig): number {
    const credentials = this.listCredentials(node).filter((entry) => entry.enabled !== false);
    if (credentials.length <= 1 || this.resolvePool(node).enabled === false) return 1;
    return credentials.length;
  }

  getNodeStatus(node: NodeConfig): {
    enabled: boolean;
    strategy: CredentialPoolStrategy;
    sticky_by: CredentialStickyBy;
    cooldown_ms: number;
    max_failures: number;
    retry_on_status: number[];
    credentials: CredentialRuntimeStatus[];
  } {
    const pool = this.resolvePool(node);
    return {
      enabled: pool.enabled !== false && this.listCredentials(node).length > 1,
      strategy: pool.strategy,
      sticky_by: pool.sticky_by,
      cooldown_ms: pool.cooldown_ms,
      max_failures: pool.max_failures,
      retry_on_status: [...pool.retry_on_status],
      credentials: this.listCredentials(node).map((credential) => {
        const state = this.stateFor(node.id, credential.id);
        return {
          id: credential.id,
          enabled: credential.enabled !== false,
          weight: this.weightOf(credential),
          active: state.active,
          failures: state.failures,
          cooldown_until:
            state.cooldownUntil > Date.now()
              ? new Date(state.cooldownUntil).toISOString()
              : null,
          last_status: state.lastStatus,
          last_error: state.lastError,
          updated_at: state.updatedAt
            ? new Date(state.updatedAt).toISOString()
            : null,
        };
      }),
    };
  }

  listCredentials(node: NodeConfig): NodeCredentialConfig[] {
    if (Array.isArray(node.credentials) && node.credentials.length > 0) {
      return node.credentials.map((credential) => ({
        ...credential,
        weight: this.weightOf(credential),
        enabled: credential.enabled !== false,
      }));
    }
    if (typeof node.api_key === 'string' && node.api_key.trim()) {
      return [
        {
          id: 'default',
          api_key: node.api_key,
          weight: 1,
          enabled: true,
        },
      ];
    }
    return [];
  }

  private availableCredentials(
    nodeId: string,
    credentials: NodeCredentialConfig[],
  ): NodeCredentialConfig[] {
    const now = Date.now();
    const available = credentials.filter(
      (credential) => this.stateFor(nodeId, credential.id).cooldownUntil <= now,
    );
    return available.length > 0 ? available : credentials;
  }

  private selectLeastInFlight(
    nodeId: string,
    credentials: NodeCredentialConfig[],
  ): NodeCredentialConfig {
    return [...credentials].sort((a, b) => {
      const aState = this.stateFor(nodeId, a.id);
      const bState = this.stateFor(nodeId, b.id);
      const aScore = aState.active / this.weightOf(a);
      const bScore = bState.active / this.weightOf(b);
      return (
        aScore - bScore ||
        aState.failures - bState.failures ||
        (aState.updatedAt || 0) - (bState.updatedAt || 0) ||
        a.id.localeCompare(b.id)
      );
    })[0];
  }

  private selectWeightedRoundRobin(
    nodeId: string,
    credentials: NodeCredentialConfig[],
  ): NodeCredentialConfig {
    const totalWeight = credentials.reduce(
      (sum, credential) => sum + this.weightOf(credential),
      0,
    );
    const nextCursor = (this.roundRobinCursors.get(nodeId) || 0) % totalWeight;
    this.roundRobinCursors.set(nodeId, nextCursor + 1);

    let seen = 0;
    for (const credential of credentials) {
      seen += this.weightOf(credential);
      if (nextCursor < seen) return credential;
    }
    return credentials[0];
  }

  private selectFallback(
    nodeId: string,
    credentials: NodeCredentialConfig[],
    strategy: CredentialPoolStrategy,
  ): NodeCredentialConfig {
    return strategy === 'weighted_round_robin'
      ? this.selectWeightedRoundRobin(nodeId, credentials)
      : this.selectLeastInFlight(nodeId, credentials);
  }

  private selectCacheAware(
    nodeId: string,
    credentials: NodeCredentialConfig[],
    affinityKeys: string[],
  ): NodeCredentialConfig | null {
    if (affinityKeys.length === 0) return null;
    const now = Date.now();
    for (const key of affinityKeys) {
      const affinity = this.cacheAffinities.get(key);
      if (!affinity) continue;
      if (now - affinity.updatedAt > CACHE_AFFINITY_TTL_MS) {
        this.cacheAffinities.delete(key);
        continue;
      }
      const candidate = credentials.find((entry) => entry.id === affinity.credentialId);
      if (!candidate) continue;
      if (this.stateFor(nodeId, candidate.id).cooldownUntil > now) continue;
      return candidate;
    }
    return null;
  }

  private markActive(nodeId: string, credentialId: string): void {
    this.stateFor(nodeId, credentialId).active += 1;
  }

  private toSelection(
    node: NodeConfig,
    credential: NodeCredentialConfig,
    pool: Required<CredentialPoolConfig>,
    allCredentials: NodeCredentialConfig[],
  ): CredentialSelection {
    return {
      nodeId: node.id,
      credential,
      strategy: pool.strategy,
      stickyBy: pool.sticky_by,
      cooldownMs: pool.cooldown_ms,
      maxFailures: pool.max_failures,
      retryOnStatus: [...pool.retry_on_status],
      synthetic: allCredentials.length === 1 && credential.id === 'default' && !node.credentials?.length,
    };
  }

  private stickyKey(
    nodeId: string,
    stickyBy: CredentialStickyBy,
    metadata?: CanonicalRequestMetadata,
  ): string | null {
    if (!metadata || stickyBy === 'none') return null;
    const value =
      stickyBy === 'agent_session'
        ? metadata.agent_session_id || metadata.session_id || metadata.session_key
        : stickyBy === 'api_key'
          ? metadata.api_key_id || metadata.api_key_name
          : stickyBy === 'team'
            ? metadata.team_id || metadata.team_name
            : metadata.namespace_id || metadata.namespace_name;
    return value ? `${nodeId}:${stickyBy}:${value}` : null;
  }

  private cacheAffinityKeys(
    nodeId: string,
    stickyBy: CredentialStickyBy,
    metadata?: CanonicalRequestMetadata,
  ): string[] {
    if (!metadata) return [];

    const orderedModes: CredentialStickyBy[] = [];
    if (stickyBy !== 'none') {
      orderedModes.push(stickyBy);
    }
    for (const mode of ['api_key', 'agent_session', 'team', 'namespace'] as CredentialStickyBy[]) {
      if (!orderedModes.includes(mode)) orderedModes.push(mode);
    }

    const keys = orderedModes
      .map((mode) => this.stickyKey(nodeId, mode, metadata))
      .filter((key): key is string => Boolean(key));

    const sourceKey =
      metadata.client_source || metadata.agent_profile_id || metadata.agent_connector;
    if (sourceKey) {
      keys.push(`${nodeId}:client:${sourceKey}`);
    }
    return [...new Set(keys)];
  }

  private clearCacheAffinitiesForCredential(nodeId: string, credentialId: string): void {
    for (const [key, affinity] of this.cacheAffinities) {
      if (key.startsWith(`${nodeId}:`) && affinity.credentialId === credentialId) {
        this.cacheAffinities.delete(key);
        void this.stateBackend
          ?.delete('cache_affinity', this.stateKey(key), { workspaceId: affinity.workspaceId })
          .catch(() => undefined);
      }
    }
  }

  private async hydrateCacheAffinities(
    keys: string[],
    metadata?: CanonicalRequestMetadata,
  ): Promise<void> {
    if (!this.stateBackend || keys.length === 0) return;
    const missingKeys = keys.filter((key) => !this.cacheAffinities.has(key));
    if (missingKeys.length === 0) return;

    await Promise.all(
      missingKeys.map(async (key) => {
        try {
          const affinity = await this.stateBackend?.getJson<CredentialCacheAffinity>(
            'cache_affinity',
            this.stateKey(key),
            { workspaceId: metadata?.workspace_id },
          );
          if (this.isValidCacheAffinity(affinity)) {
            this.cacheAffinities.set(key, affinity);
          }
        } catch {
          // Provider credential affinity is an optimization; request routing remains fail-open.
        }
      }),
    );
  }

  private async persistCacheAffinity(
    key: string,
    affinity: CredentialCacheAffinity,
    metadata?: CanonicalRequestMetadata,
  ): Promise<void> {
    await this.stateBackend?.setJson(
      'cache_affinity',
      this.stateKey(key),
      affinity,
      CACHE_AFFINITY_STATE_TTL_SECONDS,
      { workspaceId: metadata?.workspace_id },
    );
  }

  private stateKey(key: string): string {
    return `${CACHE_AFFINITY_STATE_PREFIX}${key}`;
  }

  private isValidCacheAffinity(value: unknown): value is CredentialCacheAffinity {
    if (!value || typeof value !== 'object') return false;
    const typed = value as Partial<CredentialCacheAffinity>;
    return (
      typeof typed.credentialId === 'string' &&
      typeof typed.updatedAt === 'number' &&
      Number.isFinite(typed.updatedAt)
    );
  }

  private resolvePool(node: NodeConfig): Required<CredentialPoolConfig> {
    const configured = node.credential_pool || {};
    return {
      enabled: configured.enabled ?? true,
      strategy: configured.strategy || 'least_in_flight',
      sticky_by: configured.sticky_by || 'agent_session',
      cooldown_ms: configured.cooldown_ms ?? 60_000,
      max_failures: configured.max_failures ?? 3,
      retry_on_status: configured.retry_on_status || DEFAULT_RETRY_STATUSES,
    };
  }

  private resolvePoolFromSelection(
    selection: CredentialSelection,
  ): Required<CredentialPoolConfig> {
    return {
      enabled: true,
      strategy: selection.strategy,
      sticky_by: selection.stickyBy,
      cooldown_ms: selection.cooldownMs,
      max_failures: selection.maxFailures,
      retry_on_status: selection.retryOnStatus,
    };
  }

  private stateFor(nodeId: string, credentialId: string): CredentialState {
    const key = `${nodeId}:${credentialId}`;
    let state = this.states.get(key);
    if (!state) {
      state = {
        active: 0,
        failures: 0,
        cooldownUntil: 0,
        lastStatus: null,
        lastError: null,
        updatedAt: null,
      };
      this.states.set(key, state);
    }
    return state;
  }

  private weightOf(credential: NodeCredentialConfig): number {
    const value = Number(credential.weight ?? 1);
    return Number.isFinite(value) && value > 0 ? value : 1;
  }
}

function parseRetryAfterMs(value?: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  return null;
}

// ===================================================================
// CircuitBreakerService — Per-model circuit breaker for health tracking
// ===================================================================
// States: CLOSED → OPEN → HALF_OPEN → CLOSED
//
//   CLOSED:    Normal operation, track consecutive failures
//   OPEN:      Model is unhealthy, skip all requests
//   HALF_OPEN: Cooldown expired, allow one probe request
//
// Key scheme: "${nodeId}:${model}" — each node+model pair has its own
// circuit breaker. Node-level status is aggregated from model-level:
//   - Any model OPEN → node is "degraded"
//   - All models CLOSED → node is "healthy"
// ===================================================================

import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { AlertService } from '../alerts/alert.service';
import { TelemetryService } from '../telemetry/telemetry.service';
import { ConfigService } from '../config/config.service';
import { StateBackendService } from '../state/state-backend.service';

export enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN',
}

interface CircuitStatus {
  state: CircuitState;
  consecutiveFailures: number;
  lastFailureAt: number;
  openedAt: number;
  halfOpenProbes: number; // number of in-flight probes in HALF_OPEN
}

interface CircuitBreakerConfig {
  enabled: boolean;         // false = never gate routing on failure history
  failureThreshold: number; // consecutive failures to trigger OPEN
  cooldownMs: number;       // time in OPEN before moving to HALF_OPEN
  halfOpenMax: number;      // max probe requests in HALF_OPEN
}

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  enabled: true,
  failureThreshold: 3,
  cooldownMs: 30_000,   // 30 seconds
  halfOpenMax: 1,
};

@Injectable()
export class CircuitBreakerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CircuitBreakerService.name);
  private readonly circuits = new Map<string, CircuitStatus>();
  private syncInterval?: ReturnType<typeof setInterval>;
  private lastFailClosedLogAt = 0;

  constructor(
    @Optional() private readonly alerts?: AlertService,
    @Optional() private readonly telemetry?: TelemetryService,
    @Optional() private readonly stateBackend?: StateBackendService,
    @Optional() private readonly configService?: ConfigService,
  ) {
    this.registerMetrics();
  }

  /**
   * Resolve thresholds on every read so `routing.circuit_breaker` edits take
   * effect on config reload instead of requiring a restart.
   */
  private get config(): CircuitBreakerConfig {
    const configured = this.configService?.routing?.circuit_breaker;
    return {
      enabled: configured?.enabled ?? DEFAULT_CONFIG.enabled,
      failureThreshold: configured?.failure_threshold ?? DEFAULT_CONFIG.failureThreshold,
      cooldownMs: configured?.cooldown_ms ?? DEFAULT_CONFIG.cooldownMs,
      halfOpenMax: configured?.half_open_max ?? DEFAULT_CONFIG.halfOpenMax,
    };
  }

  async onModuleInit(): Promise<void> {
    if (!this.stateBackend?.isRedisConfigured()) return;
    await this.hydrateFromStateBackend();
    const intervalMs = this.configService?.state.redis.sync_interval_ms ?? 2000;
    this.syncInterval = setInterval(
      () => void this.hydrateFromStateBackend(),
      intervalMs,
    );
    this.syncInterval.unref?.();
  }

  onModuleDestroy(): void {
    if (this.syncInterval) clearInterval(this.syncInterval);
  }

  /** Build the internal key for a node+model pair */
  private buildKey(nodeId: string, model?: string): string {
    return model ? `${nodeId}:${model}` : nodeId;
  }

  /**
   * Check if a node+model pair is available (not in OPEN state).
   * Returns true if requests should be forwarded.
   */
  isAvailable(nodeId: string, model?: string): boolean {
    if (this.configService?.getNode?.(nodeId)?.disabled === true) return false;
    if (!this.config.enabled) {
      return true;
    }
    if (this.stateBackend?.shouldFailClosed()) {
      const now = Date.now();
      if (now - this.lastFailClosedLogAt > 30_000) {
        this.lastFailClosedLogAt = now;
        this.logger.warn('Circuit breaker unavailable because Redis state backend is fail_closed');
      }
      return false;
    }
    const key = this.buildKey(nodeId, model);
    const status = this.getStatus(key);

    switch (status.state) {
      case CircuitState.CLOSED:
        return true;

      case CircuitState.OPEN:
        // Check if cooldown has elapsed → transition to HALF_OPEN
        if (Date.now() - status.openedAt >= this.config.cooldownMs) {
          status.state = CircuitState.HALF_OPEN;
          status.halfOpenProbes = 0;
          this.logger.log(`Circuit HALF_OPEN for "${key}" (cooldown elapsed)`);
          this.persistStatus(key, status);
          return true;
        }
        return false;

      case CircuitState.HALF_OPEN:
        // Allow limited probe requests
        if (status.halfOpenProbes < this.config.halfOpenMax) {
          status.halfOpenProbes++;
          this.persistStatus(key, status);
          return true;
        }
        return false;
    }
  }

  /**
   * Record a successful request to a node+model.
   * Resets the circuit to CLOSED if it was HALF_OPEN.
   */
  recordSuccess(nodeId: string, model?: string): void {
    const key = this.buildKey(nodeId, model);
    const status = this.getStatus(key);
    const previousState = status.state;

    if (status.state === CircuitState.HALF_OPEN) {
      this.logger.log(`Circuit CLOSED for "${key}" (probe succeeded)`);
    }

    // Reset to healthy state
    status.state = CircuitState.CLOSED;
    status.consecutiveFailures = 0;
    status.halfOpenProbes = 0;
    status.lastFailureAt = 0;
    status.openedAt = 0;
    this.persistStatus(key, status);

    if (previousState !== CircuitState.CLOSED) {
      this.alerts?.emit({
        type: 'circuit_close',
        severity: 'info',
        message: `Circuit closed for ${key}.`,
        dedupeKey: key,
        details: {
          node_id: nodeId,
          model: model || null,
          previous_state: previousState,
          state: CircuitState.CLOSED,
        },
      });
    }
  }

  /**
   * Record a successful active health probe.
   * OPEN circuits briefly transition through HALF_OPEN before closing so the
   * recovery path stays aligned with the normal breaker state machine.
   */
  recordProbeSuccess(nodeId: string, model?: string): void {
    const key = this.buildKey(nodeId, model);
    const status = this.getStatus(key);

    if (status.state === CircuitState.OPEN) {
      status.state = CircuitState.HALF_OPEN;
      status.halfOpenProbes = 0;
      this.logger.log(`Circuit HALF_OPEN for "${key}" (active probe recovered)`);
      this.persistStatus(key, status);
    }

    this.recordSuccess(nodeId, model);
  }

  /**
   * Record a failed request to a node+model.
   * May trigger OPEN state if threshold is reached.
   */
  recordFailure(nodeId: string, model?: string): void {
    const key = this.buildKey(nodeId, model);
    const status = this.getStatus(key);

    if (!this.config.enabled) {
      // Keep the counters for observability, but never open a circuit that
      // would gate routing or raise a circuit_open alert.
      status.consecutiveFailures++;
      status.lastFailureAt = Date.now();
      this.persistStatus(key, status);
      return;
    }

    const previousState = status.state;
    status.consecutiveFailures++;
    status.lastFailureAt = Date.now();

    if (status.state === CircuitState.HALF_OPEN) {
      // Probe failed → back to OPEN
      status.state = CircuitState.OPEN;
      status.openedAt = Date.now();
      this.logger.warn(`Circuit re-OPENED for "${key}" (probe failed)`);
      this.persistStatus(key, status);
      this.alertCircuitOpen(nodeId, model, key, status, previousState, 'probe failed');
      return;
    }

    if (
      status.state === CircuitState.CLOSED &&
      status.consecutiveFailures >= this.config.failureThreshold
    ) {
      status.state = CircuitState.OPEN;
      status.openedAt = Date.now();
      this.logger.warn(
        `Circuit OPENED for "${key}" (${status.consecutiveFailures} consecutive failures)`,
      );
      this.persistStatus(key, status);
      this.alertCircuitOpen(
        nodeId,
        model,
        key,
        status,
        previousState,
        `${status.consecutiveFailures} consecutive failures`,
      );
    } else {
      this.persistStatus(key, status);
    }
  }

  /**
   * Mark a node+model unavailable from an active health probe.
   * This opens the circuit immediately because probes are already out-of-band
   * and should prevent routing to a known-unhealthy upstream.
   */
  markUnavailable(nodeId: string, model?: string, reason = 'active probe failed'): void {
    if (!this.config.enabled) return;
    const key = this.buildKey(nodeId, model);
    const status = this.getStatus(key);
    const previousState = status.state;
    status.state = CircuitState.OPEN;
    status.consecutiveFailures = Math.max(
      status.consecutiveFailures + 1,
      this.config.failureThreshold,
    );
    status.lastFailureAt = Date.now();
    status.openedAt = Date.now();
    status.halfOpenProbes = 0;
    this.logger.warn(`Circuit OPENED for "${key}" (${reason})`);
    this.persistStatus(key, status);
    if (previousState !== CircuitState.OPEN) {
      this.alertCircuitOpen(nodeId, model, key, status, previousState, reason);
    }
  }

  /**
   * Get the current circuit state for a node+model.
   */
  getCircuitState(nodeId: string, model?: string): CircuitState {
    return this.getStatus(this.buildKey(nodeId, model)).state;
  }

  /**
   * Get aggregated node-level status (for backward compatibility).
   * Aggregates across all models for the given node:
   *   - state: OPEN if any model is OPEN, HALF_OPEN if any is HALF_OPEN, else CLOSED
   *   - consecutiveFailures: max across all models
   *   - lastFailureAt: most recent across all models
   */
  getNodeStatus(nodeId: string): {
    state: CircuitState;
    consecutiveFailures: number;
    lastFailureAt: number | null;
  } {
    const prefix = `${nodeId}:`;
    let worstState = CircuitState.CLOSED;
    let maxFailures = 0;
    let latestFailure: number | null = null;

    for (const [key, status] of this.circuits) {
      if (key === nodeId || key.startsWith(prefix)) {
        // State priority: OPEN > HALF_OPEN > CLOSED
        if (status.state === CircuitState.OPEN) {
          worstState = CircuitState.OPEN;
        } else if (status.state === CircuitState.HALF_OPEN && worstState !== CircuitState.OPEN) {
          worstState = CircuitState.HALF_OPEN;
        }

        if (status.consecutiveFailures > maxFailures) {
          maxFailures = status.consecutiveFailures;
        }

        if (status.lastFailureAt && (!latestFailure || status.lastFailureAt > latestFailure)) {
          latestFailure = status.lastFailureAt;
        }
      }
    }

    return {
      state: worstState,
      consecutiveFailures: maxFailures,
      lastFailureAt: latestFailure || null,
    };
  }

  /**
   * Get per-model circuit status for a node (for dashboard).
   * Returns a map of model → circuit info.
   */
  getModelStatuses(nodeId: string): Record<string, {
    state: CircuitState;
    consecutiveFailures: number;
    lastFailureAt: number | null;
  }> {
    const prefix = `${nodeId}:`;
    const result: Record<string, {
      state: CircuitState;
      consecutiveFailures: number;
      lastFailureAt: number | null;
    }> = {};

    for (const [key, status] of this.circuits) {
      if (key.startsWith(prefix)) {
        const model = key.slice(prefix.length);
        result[model] = {
          state: status.state,
          consecutiveFailures: status.consecutiveFailures,
          lastFailureAt: status.lastFailureAt || null,
        };
      }
    }

    return result;
  }

  /**
   * Get status for all tracked circuits (for dashboard).
   */
  getAllStatuses(): Map<string, { state: CircuitState; consecutiveFailures: number }> {
    const result = new Map<string, { state: CircuitState; consecutiveFailures: number }>();
    for (const [key, status] of this.circuits) {
      result.set(key, {
        state: status.state,
        consecutiveFailures: status.consecutiveFailures,
      });
    }
    return result;
  }

  /**
   * Reset circuit breaker.
   * - reset(nodeId) — resets ALL models for that node
   * - reset(nodeId, model) — resets only the specific model
   */
  reset(nodeId: string, model?: string): void {
    if (model) {
      // Reset specific model
      const key = this.buildKey(nodeId, model);
      this.circuits.delete(key);
      this.deletePersistedStatus(key);
      this.logger.log(`Circuit reset for "${key}"`);
    } else {
      // Reset all models for this node
      const prefix = `${nodeId}:`;
      const keysToDelete: string[] = [];
      for (const key of this.circuits.keys()) {
        if (key === nodeId || key.startsWith(prefix)) {
          keysToDelete.push(key);
        }
      }
      for (const key of keysToDelete) {
        this.circuits.delete(key);
        this.deletePersistedStatus(key);
      }
      this.logger.log(`Circuit reset for node "${nodeId}" (${keysToDelete.length} circuits cleared)`);
    }
  }

  /**
   * Reset all circuit breakers.
   */
  resetAll(): void {
    this.circuits.clear();
    this.clearPersistedStatuses();
    this.logger.log('All circuits reset');
  }

  private getStatus(key: string): CircuitStatus {
    if (!this.circuits.has(key)) {
      this.circuits.set(key, {
        state: CircuitState.CLOSED,
        consecutiveFailures: 0,
        lastFailureAt: 0,
        openedAt: 0,
        halfOpenProbes: 0,
      });
    }
    return this.circuits.get(key)!;
  }

  private async hydrateFromStateBackend(): Promise<void> {
    if (!this.stateBackend?.isRedisConfigured()) return;
    try {
      const statuses = await this.stateBackend.getHashAllJson<CircuitStatus>(
        'circuit_breaker',
        'circuits',
      );
      for (const [key, status] of statuses.entries()) {
        if (this.isCircuitStatus(status)) {
          this.circuits.set(key, status);
        }
      }
    } catch (err) {
      this.logger.warn(`Circuit breaker state sync skipped: ${(err as Error).message}`);
    }
  }

  private persistStatus(key: string, status: CircuitStatus): void {
    if (!this.stateBackend?.isRedisConfigured()) return;
    this.stateBackend
      .setHashJson('circuit_breaker', 'circuits', key, status)
      .catch((err) =>
        this.logger.warn(`Circuit breaker state write skipped: ${(err as Error).message}`),
      );
  }

  private deletePersistedStatus(key: string): void {
    if (!this.stateBackend?.isRedisConfigured()) return;
    this.stateBackend
      .deleteHashField('circuit_breaker', 'circuits', key)
      .catch((err) =>
        this.logger.warn(`Circuit breaker state delete skipped: ${(err as Error).message}`),
      );
  }

  private clearPersistedStatuses(): void {
    if (!this.stateBackend?.isRedisConfigured()) return;
    this.stateBackend
      .clearHash('circuit_breaker', 'circuits')
      .catch((err) =>
        this.logger.warn(`Circuit breaker state clear skipped: ${(err as Error).message}`),
      );
  }

  private isCircuitStatus(value: unknown): value is CircuitStatus {
    const status = value as CircuitStatus;
    return (
      status !== null &&
      typeof status === 'object' &&
      Object.values(CircuitState).includes(status.state) &&
      typeof status.consecutiveFailures === 'number' &&
      typeof status.lastFailureAt === 'number' &&
      typeof status.openedAt === 'number' &&
      typeof status.halfOpenProbes === 'number'
    );
  }

  private registerMetrics(): void {
    const gauge = this.telemetry?.meter.createObservableGauge(
      'siftgate_circuit_breaker_state',
      {
        description: 'Circuit breaker state by node and model: CLOSED=0, HALF_OPEN=0.5, OPEN=1',
        unit: '1',
      },
    );
    gauge?.addCallback((observable) => {
      for (const [key, status] of this.circuits.entries()) {
        const { node, model } = this.parseKey(key);
        observable.observe(this.stateValue(status.state), { node, model });
      }
    });
  }

  private parseKey(key: string): { node: string; model: string } {
    const separator = key.indexOf(':');
    if (separator < 0) {
      return { node: key, model: 'all' };
    }
    return {
      node: key.slice(0, separator),
      model: key.slice(separator + 1) || 'unknown',
    };
  }

  private stateValue(state: CircuitState): number {
    if (state === CircuitState.OPEN) return 1;
    if (state === CircuitState.HALF_OPEN) return 0.5;
    return 0;
  }

  private alertCircuitOpen(
    nodeId: string,
    model: string | undefined,
    key: string,
    status: CircuitStatus,
    previousState: CircuitState,
    reason: string,
  ): void {
    this.alerts?.emit({
      type: 'circuit_open',
      severity: 'critical',
      message: `Circuit opened for ${key}: ${reason}.`,
      dedupeKey: key,
      details: {
        node_id: nodeId,
        model: model || null,
        previous_state: previousState,
        state: CircuitState.OPEN,
        consecutive_failures: status.consecutiveFailures,
        reason,
      },
    });
  }
}

// ===================================================================
// BudgetService — Daily token & cost budget enforcement
// ===================================================================
// Checks budget before each request and records usage after.
// Auto-resets daily counters at period boundary.
// Supports global, namespace, local team, and per-key budgets.
// ===================================================================

import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository, IsNull, In, SelectQueryBuilder } from 'typeorm';
import { RawSqlResultsToEntityTransformer } from 'typeorm/query-builder/transformer/RawSqlResultsToEntityTransformer';
import { createPostgresReadProgram, withPostgresReadPrelude, type PostgresTransactionReadPrelude } from '../pricing/postgres-read-program';
import { Subscription } from 'rxjs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ConfigService } from '../config/config.service';
import { BudgetRule } from '../database/entities/budget-rule.entity';
import { AlertService } from '../alerts/alert.service';
import { ManagementAuditService } from '../audit/management-audit.service';
import { TelemetryService } from '../telemetry/telemetry.service';
import type {
  BudgetReservationMetricEvent,
  BudgetReservationMetricScope,
} from '../telemetry/telemetry.service';
import { WorkspaceContextService } from '../workspaces/workspace-context.service';
import { DEFAULT_WORKSPACE_ID } from '../workspaces/workspace.constants';
import { serializeDatabaseAccess } from '../database/database-serialization';
import { PRICING_LEDGER_SCHEMA_CHECKSUM, PRICING_LEDGER_SCHEMA_VERSION } from '../pricing/pricing-schema';
import { ExactDecimal } from '../pricing/exact-decimal';
import { persistPostgresBudgetCounters } from './budget-counter-batch';
import { legacyNumberToDecimal } from '../pricing/legacy-pricing-adapter';
import type { BudgetLedgerHold, BudgetLedgerIdentity, BudgetLedgerPreview } from './budget-ledger.types';
import {
  applyWorkspaceQueryScope,
  normalizeWorkspaceId,
  workspaceFindWhere,
} from '../workspaces/workspace-scope';

const defaultBudgetSelectMethods = {
  getMany: SelectQueryBuilder.prototype.getMany,
  getRawAndEntities: SelectQueryBuilder.prototype.getRawAndEntities,
  getQueryAndParameters: SelectQueryBuilder.prototype.getQueryAndParameters,
};

export interface BudgetStatus {
  id: number;
  type: string;
  scope: 'global' | 'api_key' | 'namespace' | 'team';
  apiKeyName: string | null;
  apiKeyId: string | null;
  namespaceId: string | null;
  teamId: string | null;
  limit: number;
  current: number;
  currentExact?: string;
  percentage: number;
  alertThreshold: number;
  isExceeded: boolean;
  isAlert: boolean;
  periodStart: Date;
  resetAt: Date | null;
}

export interface BudgetReservation {
  tokens: number;
  costUsd: number;
  commit(actualTokens: number, actualCostUsd: number): Promise<void>;
  release(): Promise<void>;
}

interface BudgetRuleScope {
  rules: BudgetRule[];
  apiKeyName: string | null;
  apiKeyId: string | null;
  namespaceId: string | null;
  teamId: string | null;
}

interface BudgetReservationMetricDimension {
  scope: BudgetReservationMetricScope;
  budgetType: string;
}

interface BudgetMutationContext {
  repo: Repository<BudgetRule>;
  lockActiveRules: boolean;
  skipRuleHydration?: boolean;
  lockedRules?: Map<number, BudgetRule>;
}

interface CommittedBudgetChange {
  before: ExactDecimal;
  after: ExactDecimal;
  rule: BudgetRule;
}

interface BudgetMutationEffects {
  changes: Map<string, CommittedBudgetChange>;
  metrics?: BudgetStatus[];
  refreshLedgerMetrics?: boolean;
  rejection?: { error: BudgetExceededError; rule: BudgetRule };
}

export class BudgetExceededError extends Error {
  public readonly scope: 'global' | 'api_key' | 'namespace' | 'team';
  public readonly resetAt: Date | null;

  constructor(
    public readonly budgetType: string,
    public readonly current: number,
    public readonly limit: number,
    public readonly apiKeyName?: string | null,
    public readonly apiKeyId?: string | null,
    public readonly namespaceId?: string | null,
    public readonly teamId?: string | null,
    periodStart?: Date | null,
  ) {
    const scope = namespaceId
      ? `namespace "${namespaceId}"`
      : teamId
      ? `team "${teamId}"`
      : apiKeyName
      ? `key "${apiKeyName}"`
      : apiKeyId
      ? `key id "${apiKeyId}"`
      : 'global';
    super(`Budget exceeded (${scope}): ${budgetType} (${current.toFixed(2)} / ${limit.toFixed(2)})`);
    this.name = 'BudgetExceededError';
    this.scope = namespaceId ? 'namespace' : teamId ? 'team' : apiKeyName || apiKeyId ? 'api_key' : 'global';
    this.resetAt = periodStart ? BudgetExceededError.nextDailyReset(periodStart) : null;
  }

  toDetails() {
    return {
      scope: this.scope,
      api_key_id: this.apiKeyId || null,
      api_key_name: this.apiKeyName || null,
      namespace_id: this.namespaceId || null,
      team_id: this.teamId || null,
      budget_type: this.budgetType,
      current: Number(this.current.toFixed(6)),
      limit: Number(this.limit.toFixed(6)),
      reset_at: this.resetAt?.toISOString() || null,
    };
  }

  private static nextDailyReset(periodStart: Date): Date | null {
    const reset = new Date(periodStart);
    reset.setHours(0, 0, 0, 0);
    reset.setDate(reset.getDate() + 1);
    return reset;
  }
}

@Injectable()
export class BudgetService implements OnModuleInit, OnModuleDestroy {
  private readonly checkedScopeRows = new WeakMap<BudgetMutationContext, { key: string; rows: BudgetRule[] }>();
  private readonly logger = new Logger(BudgetService.name);
  private configReloadSub?: Subscription;
  private mutationQueue: Promise<void> = Promise.resolve();
  private readonly mutationEffects = new AsyncLocalStorage<BudgetMutationEffects>();
  private exactLedgerEnabled = false;
  private budgetMetricSnapshot: Array<{
    ratio: number;
    attrs: { scope: 'global' | 'api_key' | 'namespace' | 'team'; budget_type: string };
  }> = [];

  constructor(
    private readonly config: ConfigService,
    private readonly workspaceContext: WorkspaceContextService,
    @InjectRepository(BudgetRule)
    private readonly budgetRepo: Repository<BudgetRule>,
    @Optional() private readonly alerts?: AlertService,
    @Optional() private readonly telemetry?: TelemetryService,
    @Optional() private readonly managementAudit?: ManagementAuditService,
  ) {
    this.registerMetrics();
  }

  async onModuleInit(): Promise<void> {
    await this.detectExactLedger();
    await this.syncRulesFromConfig();
    this.configReloadSub = this.config.onReloadSuccess(() => this.syncRulesFromConfig());
  }

  onModuleDestroy(): void {
    this.configReloadSub?.unsubscribe();
  }

  /** Read-only startup inspection: existing exact balances must precede legacy budget writes. */
  private async detectExactLedger(): Promise<void> {
    const source = this.budgetRepo.manager?.connection;
    if (!source?.isInitialized) return;
    await serializeDatabaseAccess(source, async () => {
      const runner = source.createQueryRunner();
      try {
        if (!await runner.hasTable('pricing_schema_versions') || !await runner.hasTable('pricing_budget_balances')) return;
        const marker = await runner.manager.createQueryBuilder().select('m.checksum', 'checksum').from('pricing_schema_versions', 'm')
          .where('m.id = :id', { id: PRICING_LEDGER_SCHEMA_VERSION }).getRawOne<{ checksum: string }>();
        if (marker?.checksum === PRICING_LEDGER_SCHEMA_CHECKSUM) this.enableExactLedger();
      } finally { await runner.release(); }
    });
  }

  /** Called only after the explicit pricing-ledger migration is verified. */
  enableExactLedger(): void { this.exactLedgerEnabled = true; }

  /** The supplied operation includes its transaction commit/rollback, not just its callback. */
  async withCommittedBudgetEffects<T>(
    operation: () => Promise<T>,
    options: { refreshLedgerMetrics?: boolean } = {},
  ): Promise<T> {
    const parent = this.mutationEffects.getStore();
    const effects: BudgetMutationEffects = { changes: new Map() };
    let result: T;
    try {
      result = await this.mutationEffects.run(effects, operation);
    } catch (error) {
      // Rejection is a real admission decision, not a committed balance change.
      // It can be reported only once the rejecting transaction has rolled back.
      const rejection = effects.rejection;
      if (rejection && rejection.error === error) {
        if (parent) parent.rejection = rejection;
        else this.publishBudgetRejection(rejection.rule);
      }
      throw error;
    }
    // Receipt, intent and replay-only writes do not change budget telemetry.
    // Keep refresh requests inside the commit boundary, including savepoints.
    if (options.refreshLedgerMetrics && effects.changes.size > 0) {
      effects.refreshLedgerMetrics = true;
    }
    if (parent) {
      for (const [key, change] of effects.changes) {
        const previous = parent.changes.get(key);
        parent.changes.set(key, { ...change, before: previous?.before ?? change.before });
      }
      if (effects.metrics) parent.metrics = effects.metrics;
      if (effects.refreshLedgerMetrics) parent.refreshLedgerMetrics = true;
      return result;
    }
    // Side effects cannot turn an already committed settlement into a failure.
    for (const change of effects.changes.values()) this.publishBudgetChange(change);
    if (effects.metrics) this.updateBudgetMetricSnapshot(effects.metrics);
    if (effects.refreshLedgerMetrics) await this.refreshAfterLedgerMutation();
    return result;
  }

  private observeBudgetChange(rule: BudgetRule, before: ExactDecimal): void {
    const effects = this.mutationEffects.getStore();
    if (!effects) return; // Never guess that an externally owned transaction committed.
    const frozen = this.freezeBudgetRule(rule);
    const key = JSON.stringify([frozen.workspace_id, frozen.id, frozen.period_start.toISOString()]);
    const previous = effects.changes.get(key);
    effects.changes.set(key, { before: previous?.before ?? before, after: this.exactCurrent(rule), rule: frozen });
  }

  private freezeBudgetRule(rule: BudgetRule): BudgetRule {
    return { ...rule, workspace_id: this.workspaceId(), period_start: new Date(rule.period_start), current_value_exact: this.exactCurrent(rule).toFixed(18) };
  }

  private rejectBudget(rule: BudgetRule, error: BudgetExceededError): never {
    const effects = this.mutationEffects.getStore();
    if (effects) effects.rejection = { rule: this.freezeBudgetRule(rule), error };
    throw error;
  }

  private publishBudgetChange({ before, after, rule }: CommittedBudgetChange): void {
    if (rule.limit_value <= 0 || after.compare(before) <= 0) return;
    const threshold = this.exactNumber(rule.limit_value).multiply(this.exactNumber(rule.alert_threshold));
    if (before.compare(threshold) >= 0 || after.compare(threshold) < 0) return;
    try {
      const percentage = Number(after.divide(this.exactNumber(rule.limit_value)).toFixed(18));
      this.logger.warn(`Committed budget threshold reached: ${rule.type}.`);
      this.alertBudgetThreshold(rule, percentage, rule.api_key_name, rule.api_key_id ?? undefined, rule.namespace_id ?? undefined, rule.team_id ?? undefined);
    } catch {
      this.logger.warn('Budget notification could not be queued after commit; the committed balance is unchanged.');
    }
  }

  private publishBudgetRejection(rule: BudgetRule): void {
    try {
      this.alertBudgetExceeded(rule, rule.api_key_name, rule.api_key_id ?? undefined, rule.namespace_id, rule.team_id);
    } catch {
      this.logger.warn('Budget rejection notification could not be queued; the admission decision is unchanged.');
    }
  }

  async reserveLedger(manager: EntityManager, identity: BudgetLedgerIdentity, tokens: string, costUsd: string, includeTokenRules = true): Promise<BudgetLedgerHold[]> {
    if (typeof includeTokenRules !== 'boolean') throw new Error('Explicit token rule selection must be boolean');
    return this.workspaceContext.run({ workspaceId: identity.workspaceId }, async () => {
      this.enableExactLedger();
      const context: BudgetMutationContext = { repo: manager.getRepository(BudgetRule), lockActiveRules: manager.connection.options.type === 'postgres' };
      const scopes = (await this.loadRuleScopes(identity.apiKeyName, identity.apiKeyId, identity.namespaceId, identity.teamId, context))
        .map(scope => ({ ...scope, rules: scope.rules.filter(rule => includeTokenRules || rule.type !== 'daily_tokens') }));
      const holds: BudgetLedgerHold[] = [];
      for (const scope of scopes) {
        await this.resetExpiredPeriods(scope.rules, context.repo);
        for (const rule of scope.rules) {
          // Scope hydration already used this transaction's locked/serialized rows.
          // A period reset deletes the transient value and requires a fresh epoch read.
          if (rule.current_value_exact === undefined) await this.hydrateExactRule(rule, context.repo);
          const increment = rule.type === 'daily_tokens' ? ExactDecimal.parse(tokens) : rule.type === 'daily_cost' ? ExactDecimal.parse(costUsd) : ExactDecimal.zero;
          const projected = this.exactCurrent(rule).add(increment);
          if (projected.compare(this.exactNumber(rule.limit_value)) > 0) {
            this.rejectBudget({ ...rule, current_value: Number(projected.toFixed(18)), current_value_exact: projected.toFixed(18) }, new BudgetExceededError(rule.type, Number(projected.toFixed(18)), rule.limit_value, identity.apiKeyName, identity.apiKeyId, identity.namespaceId, identity.teamId, rule.period_start));
          }
          holds.push({ ruleId: rule.id, workspaceId: identity.workspaceId, periodStart: new Date(rule.period_start).toISOString(), amount: increment.toFixed(18), type: rule.type });
        }
      }
      const changes = scopes.flatMap(scope => scope.rules.map(rule => {
        const increment = rule.type === 'daily_tokens' ? ExactDecimal.parse(tokens) : rule.type === 'daily_cost' ? ExactDecimal.parse(costUsd) : ExactDecimal.zero;
        const before = this.exactCurrent(rule);
        return { rule, before, value: before.add(increment) };
      }));
      if (context.lockActiveRules) await persistPostgresBudgetCounters(context.repo, this.workspaceId(), changes);
      else for (const change of changes) await this.saveExactRule(change.rule, change.value, context.repo);
      for (const { rule, before } of changes) this.observeBudgetChange(rule, before);
      return holds;
    });
  }

  async settleLedger(manager: EntityManager, identity: BudgetLedgerIdentity, holds: BudgetLedgerHold[], tokens: string, costUsd: string): Promise<BudgetLedgerHold[]> {
    return this.workspaceContext.run({ workspaceId: identity.workspaceId }, async () => {
      this.enableExactLedger();
      const repo = manager.getRepository(BudgetRule);
      // Lock active scopes in the same order as reservations before releasing old-period holds.
      const context: BudgetMutationContext = { repo, lockActiveRules: manager.connection.options.type === 'postgres', lockedRules: new Map() };
      const scopes = await this.loadRuleScopes(identity.apiKeyName, identity.apiKeyId, identity.namespaceId, identity.teamId, context, holds.map((hold) => hold.ruleId));
      for (const scope of scopes) await this.resetExpiredPeriods(scope.rules, repo);
      if (context.lockActiveRules) return this.settleLockedLedger(repo, identity, scopes, context.lockedRules!, holds, tokens, costUsd);
      for (const hold of [...holds].sort((a, b) => a.ruleId - b.ruleId)) {
        if (hold.workspaceId !== identity.workspaceId) throw new Error('Budget hold workspace mismatch');
        const rule = await repo.findOne({ where: workspaceFindWhere(identity.workspaceId, { id: hold.ruleId }), ...(manager.connection.options.type === 'postgres' ? { lock: { mode: 'pessimistic_write' as const } } : {}) });
        if (!rule || new Date(rule.period_start).toISOString() !== hold.periodStart) continue;
        await this.hydrateExactRule(rule, repo);
        const before = this.exactCurrent(rule);
        const remaining = before.subtract(ExactDecimal.parse(hold.amount));
        await this.saveExactRule(rule, remaining.compare(ExactDecimal.zero) < 0 ? ExactDecimal.zero : remaining, repo);
        this.observeBudgetChange(rule, before);
      }
      const allocations: BudgetLedgerHold[] = [];
      for (const scope of scopes) for (const original of scope.rules) {
        const rule = await repo.findOne({ where: workspaceFindWhere(identity.workspaceId, { id: original.id }) });
        if (!rule) continue;
        await this.hydrateExactRule(rule, repo);
        const increment = rule.type === 'daily_tokens' ? ExactDecimal.parse(tokens) : rule.type === 'daily_cost' ? ExactDecimal.parse(costUsd) : ExactDecimal.zero;
        const before = this.exactCurrent(rule);
        await this.saveExactRule(rule, before.add(increment), repo);
        this.observeBudgetChange(rule, before);
        allocations.push({ ruleId: rule.id, workspaceId: identity.workspaceId, periodStart: new Date(rule.period_start).toISOString(), amount: increment.toFixed(18), type: rule.type });
      }
      return allocations;
    });
  }

  /** PostgreSQL rows remain locked through commit. Fold only this settlement's
   * ordered release/reapply arithmetic; never combine requests or release locks early. */
  private async settleLockedLedger(repo: Repository<BudgetRule>, identity: BudgetLedgerIdentity, scopes: BudgetRuleScope[], locked: Map<number, BudgetRule>, holds: BudgetLedgerHold[], tokens: string, costUsd: string): Promise<BudgetLedgerHold[]> {
    const changes = new Map<number, { rule: BudgetRule; before: ExactDecimal; after: ExactDecimal }>();
    const current = async (id: number, period?: string) => {
      const pending = changes.get(id);
      if (pending) return period && new Date(pending.rule.period_start).toISOString() !== period ? null : pending;
      // Missing rows were not lock targets. Preserve the former second lookup
      // for that unusual case, rather than assuming absence is immutable.
      const rule = locked.get(id) ?? await repo.findOne({ where: workspaceFindWhere(identity.workspaceId, { id }), lock: { mode: 'pessimistic_write' } });
      if (!rule) return null;
      if (period && new Date(rule.period_start).toISOString() !== period) return null;
      if (rule.current_value_exact === undefined) await this.hydrateExactRule(rule, repo);
      const before = this.exactCurrent(rule);
      const value = { rule, before, after: before };
      changes.set(id, value);
      return value;
    };
    for (const hold of [...holds].sort((a, b) => a.ruleId - b.ruleId)) {
      if (hold.workspaceId !== identity.workspaceId) throw new Error('Budget hold workspace mismatch');
      const rule = locked.get(hold.ruleId);
      // An old epoch must not refund today's newly reset counter.
      if (rule && new Date(rule.period_start).toISOString() !== hold.periodStart) continue;
      const change = await current(hold.ruleId, hold.periodStart);
      if (!change) continue;
      const remaining = change.after.subtract(ExactDecimal.parse(hold.amount));
      change.after = remaining.compare(ExactDecimal.zero) < 0 ? ExactDecimal.zero : remaining;
    }
    const allocations: BudgetLedgerHold[] = [];
    for (const scope of scopes) for (const original of scope.rules) {
      const change = await current(original.id);
      if (!change) continue;
      const { rule } = change;
      const increment = rule.type === 'daily_tokens' ? ExactDecimal.parse(tokens) : rule.type === 'daily_cost' ? ExactDecimal.parse(costUsd) : ExactDecimal.zero;
      change.after = change.after.add(increment);
      allocations.push({ ruleId: rule.id, workspaceId: identity.workspaceId, periodStart: new Date(rule.period_start).toISOString(), amount: increment.toFixed(18), type: rule.type });
    }
    const ordered = [...changes.values()].sort((a, b) => a.rule.id - b.rule.id);
    await persistPostgresBudgetCounters(repo, this.workspaceId(), ordered.map(({ rule, after }) => ({ rule, value: after })));
    for (const { rule, before } of ordered) this.observeBudgetChange(rule, before);
    return allocations;
  }

  /** Replace a retained actual-expense hold in its original scopes/epochs, never today's newly selected rules. */
  async settleOriginalLedger(manager: EntityManager, identity: BudgetLedgerIdentity, holds: BudgetLedgerHold[], tokens: string, costUsd: string): Promise<BudgetLedgerHold[]> {
    if (!manager.queryRunner?.isTransactionActive || new Set(holds.map(hold => hold.ruleId)).size !== holds.length)
      throw new Error('Original budget settlement requires unique owned holds in a transaction');
    const allocations: BudgetLedgerHold[] = [];
    for (const hold of [...holds].sort((a, b) => a.ruleId - b.ruleId)) {
      const amount = ExactDecimal.parse(hold.type === 'daily_tokens' ? tokens : hold.type === 'daily_cost' ? costUsd : '0');
      const delta = amount.subtract(ExactDecimal.parse(hold.amount));
      if (amount.compare(ExactDecimal.zero) < 0 || hold.type === 'daily_tokens' && !amount.isInteger()) throw new Error('Invalid original budget settlement quantity');
      await this.adjustLedger(manager, identity, [hold], hold.type === 'daily_tokens' ? delta.toFixed(0) : '0', hold.type === 'daily_cost' ? delta.toFixed(18) : '0');
      allocations.push({ ...hold, amount: amount.toFixed(18) });
    }
    return allocations;
  }

  /** Apply a signed correction only to the original committed scopes/epochs. */
  async adjustLedger(manager: EntityManager, identity: BudgetLedgerIdentity, allocations: BudgetLedgerHold[], tokensDelta: string, costDelta: string, dryRun = false, preview?: BudgetLedgerPreview): Promise<BudgetLedgerHold[]> {
    if (preview && !dryRun) throw new Error('Virtual budget balances are only valid for a no-write preview');
    return this.workspaceContext.run({ workspaceId: identity.workspaceId }, async () => {
      this.enableExactLedger();
      const tokens = ExactDecimal.parse(tokensDelta); const cost = ExactDecimal.parse(costDelta);
      if (!tokens.isInteger()) throw new Error('Adjustment token delta must be integral');
      const repo = manager.getRepository(BudgetRule); const result: BudgetLedgerHold[] = [];
      const seen = new Set<number>();
      for (const allocation of [...allocations].sort((a, b) => a.ruleId - b.ruleId)) {
        if (allocation.workspaceId !== identity.workspaceId || seen.has(allocation.ruleId)) throw new Error('Invalid adjustment budget scope');
        seen.add(allocation.ruleId);
        const rule = await repo.findOne({ where: workspaceFindWhere(identity.workspaceId, { id: allocation.ruleId }), ...(manager.connection.options.type === 'postgres' ? { lock: { mode: 'pessimistic_write' as const } } : {}) });
        const delta = allocation.type === 'daily_tokens' ? tokens : allocation.type === 'daily_cost' ? cost : ExactDecimal.zero;
        const previewKey = JSON.stringify([identity.workspaceId, allocation.ruleId, allocation.periodStart]);
        if (rule && new Date(rule.period_start).toISOString() === allocation.periodStart) {
          await this.hydrateExactRule(rule, repo);
          const before = preview?.has(previewKey) ? ExactDecimal.parse(preview.get(previewKey)!) : this.exactCurrent(rule);
          const amount = before.add(delta);
          if (amount.compare(ExactDecimal.zero) < 0) throw new Error('Budget correction would underflow its original epoch');
          if (dryRun) preview?.set(previewKey, amount.toFixed(18));
          if (!dryRun) {
            await this.saveExactRule(rule, amount, repo);
            this.observeBudgetChange(rule, before);
          }
        } else {
          // A new day or manual reset must not receive a refund for yesterday's usage.
          const balanceQuery = manager.createQueryBuilder().select('b.amount_decimal', 'amount_decimal').from('pricing_budget_balances', 'b')
            .where('b.rule_id = :id AND b.workspace_id = :workspace AND b.period_start = :period', { id: allocation.ruleId, workspace: identity.workspaceId, period: allocation.periodStart });
          if (manager.connection.options.type === 'postgres') balanceQuery.setLock('pessimistic_write');
          const balance = await balanceQuery.getRawOne<{ amount_decimal: string }>();
          if (!balance) throw new Error('Original budget epoch is unavailable for correction');
          const amount = ExactDecimal.parse(preview?.get(previewKey) ?? balance.amount_decimal).add(delta);
          if (amount.compare(ExactDecimal.zero) < 0) throw new Error('Budget correction would underflow its original epoch');
          if (dryRun) preview?.set(previewKey, amount.toFixed(18));
          if (!dryRun) await manager.createQueryBuilder().update('pricing_budget_balances').set({ amount_decimal: amount.toFixed(18) })
            .where('rule_id = :id AND workspace_id = :workspace AND period_start = :period', { id: allocation.ruleId, workspace: identity.workspaceId, period: allocation.periodStart }).execute();
        }
        result.push({ ...allocation, amount: delta.toFixed(18) });
      }
      return result;
    });
  }

  async refreshAfterLedgerMutation(): Promise<void> {
    const source = this.budgetRepo.manager?.connection;
    if (source) await serializeDatabaseAccess(source, () => this.refreshBudgetMetricSnapshot());
    else await this.refreshBudgetMetricSnapshot();
  }

  /**
   * Create default global budget rules from config if they don't exist yet.
   */
  private async ensureDefaultRules(repo: Repository<BudgetRule> = this.budgetRepo): Promise<void> {
    const workspaceId = this.workspaceId();
    const allGlobal = await repo.find({
      where: workspaceFindWhere(workspaceId, {
        api_key_name: IsNull(),
        api_key_id: IsNull(),
        namespace_id: IsNull(),
        team_id: IsNull(),
      }),
    });
    const budget = this.config.budget;
    const now = this.startOfDay(new Date());
    const desired = [
      { type: 'daily_tokens', limit: budget.daily_token_limit },
      { type: 'daily_cost', limit: budget.daily_cost_limit },
    ];

    for (const item of desired) {
      const existing = allGlobal.find((rule) => rule.type === item.type);
      if (existing) {
        existing.limit_value = item.limit;
        existing.alert_threshold = budget.alert_threshold;
        existing.is_active = true;
        await repo.save(existing);
      } else {
        await repo.save(repo.create({
          type: item.type,
          limit_value: item.limit,
          alert_threshold: budget.alert_threshold,
          current_value: 0,
          period_start: now,
          is_active: true,
          api_key_name: null,
          api_key_id: null,
          namespace_id: null,
          team_id: null,
          workspace_id: workspaceId,
        }));
      }
    }

    await this.resetExpiredPeriods(allGlobal, repo);

    this.logger.log(
      `Budget rules initialized: tokens=${budget.daily_token_limit}, cost=$${budget.daily_cost_limit}`,
    );
  }

  /**
   * Create per-key budget rules from config for API keys that have `budget` set.
   */
  private async ensurePerKeyRules(repo: Repository<BudgetRule> = this.budgetRepo): Promise<void> {
    const workspaceId = this.workspaceId();
    const apiKeys = this.config.auth?.api_keys || [];
    const globalAlertThreshold = this.config.budget.alert_threshold;
    const now = this.startOfDay(new Date());

    for (const keyEntry of apiKeys) {
      if (!keyEntry.budget) continue;
      const keyName = keyEntry.name;
      const keyBudget = keyEntry.budget;

      const existingRules = await repo.find({
        where: workspaceFindWhere(workspaceId, {
          api_key_name: keyName,
          api_key_id: IsNull(),
          namespace_id: IsNull(),
          team_id: IsNull(),
        }),
      });

      // Upsert daily_token rule for this key
      if (keyBudget.daily_token_limit !== undefined) {
        const existing = existingRules.find((r) => r.type === 'daily_tokens');
        if (existing) {
          existing.limit_value = keyBudget.daily_token_limit;
          existing.alert_threshold = keyBudget.alert_threshold ?? globalAlertThreshold;
          existing.is_active = true;
          await repo.save(existing);
        } else {
          await repo.save(repo.create({
            type: 'daily_tokens',
            limit_value: keyBudget.daily_token_limit,
            alert_threshold: keyBudget.alert_threshold ?? globalAlertThreshold,
            current_value: 0,
            period_start: now,
            is_active: true,
            api_key_name: keyName,
            api_key_id: null,
            namespace_id: null,
            team_id: null,
            workspace_id: workspaceId,
          }));
        }
      }

      // Upsert daily_cost rule for this key
      if (keyBudget.daily_cost_limit !== undefined) {
        const existing = existingRules.find((r) => r.type === 'daily_cost');
        if (existing) {
          existing.limit_value = keyBudget.daily_cost_limit;
          existing.alert_threshold = keyBudget.alert_threshold ?? globalAlertThreshold;
          existing.is_active = true;
          await repo.save(existing);
        } else {
          await repo.save(repo.create({
            type: 'daily_cost',
            limit_value: keyBudget.daily_cost_limit,
            alert_threshold: keyBudget.alert_threshold ?? globalAlertThreshold,
            current_value: 0,
            period_start: now,
            is_active: true,
            api_key_name: keyName,
            api_key_id: null,
            namespace_id: null,
            team_id: null,
            workspace_id: workspaceId,
          }));
        }
      }
    }
  }

  /**
   * Create local namespace budget rules from config. This is OSS-local only:
   * namespaces are a lightweight policy scope, not enterprise workspaces.
   */
  private async ensureNamespaceRules(repo: Repository<BudgetRule> = this.budgetRepo): Promise<void> {
    const workspaceId = this.workspaceId();
    const namespaces = this.config.namespaces || [];
    const globalAlertThreshold = this.config.budget.alert_threshold;
    const now = this.startOfDay(new Date());

    for (const namespace of namespaces) {
      const budget = namespace.budget;
      const existingRules = await repo.find({
        where: workspaceFindWhere(workspaceId, {
          namespace_id: namespace.id,
          is_active: true,
        }),
      });

      await this.upsertNamespaceRule(
        namespace.id,
        'daily_tokens',
        budget?.daily_token_limit,
        budget?.alert_threshold ?? globalAlertThreshold,
        existingRules,
        now,
        workspaceId,
        repo,
      );
      await this.upsertNamespaceRule(
        namespace.id,
        'daily_cost',
        budget?.daily_cost_limit,
        budget?.alert_threshold ?? globalAlertThreshold,
        existingRules,
        now,
        workspaceId,
        repo,
      );
    }
  }

  private async upsertNamespaceRule(
    namespaceId: string,
    type: string,
    limit: number | undefined,
    alertThreshold: number,
    existingRules: BudgetRule[],
    periodStart: Date,
    workspaceId = this.workspaceId(),
    repo: Repository<BudgetRule> = this.budgetRepo,
  ): Promise<void> {
    const existing = existingRules.find((rule) => rule.type === type);
    if (limit === undefined) {
      if (existing) {
        existing.is_active = false;
        await repo.save(existing);
      }
      return;
    }

    if (existing) {
      existing.limit_value = limit;
      existing.alert_threshold = alertThreshold;
      existing.is_active = true;
      await repo.save(existing);
      return;
    }

    await repo.save(repo.create({
      type,
      limit_value: limit,
      alert_threshold: alertThreshold,
      current_value: 0,
      period_start: periodStart,
      is_active: true,
      api_key_name: null,
      api_key_id: null,
      namespace_id: namespaceId,
      team_id: null,
      workspace_id: workspaceId,
    }));
  }

  /**
   * Deactivate per-key rules whose key has been removed from config.
   */
  private async deactivateOrphanedRules(repo: Repository<BudgetRule> = this.budgetRepo): Promise<void> {
    const apiKeys = this.config.auth?.api_keys || [];
    const configKeyNames = new Set(
      apiKeys.filter((k) => k.budget).map((k) => k.name),
    );

    // Find legacy per-key active rules. DB-managed Gateway API key rules have
    // api_key_id set and are owned by GatewayApiKeyService, so they must not be
    // deactivated just because they are not listed in YAML auth.api_keys.
    const allPerKeyRules = await repo
      .createQueryBuilder('rule')
      .where('rule.api_key_name IS NOT NULL');
    applyWorkspaceQueryScope(allPerKeyRules, 'rule', this.workspaceId());
    const rows = await allPerKeyRules
      .andWhere('rule.api_key_id IS NULL')
      .andWhere('rule.namespace_id IS NULL')
      .andWhere('rule.team_id IS NULL')
      .andWhere('rule.is_active = :active', { active: true })
      .getMany();

    for (const rule of rows) {
      if (!configKeyNames.has(rule.api_key_name!)) {
        rule.is_active = false;
        await repo.save(rule);
        this.logger.log(`Deactivated orphaned per-key budget rule: ${rule.type} for key "${rule.api_key_name}"`);
      }
    }
  }

  private async deactivateOrphanedNamespaceRules(repo: Repository<BudgetRule> = this.budgetRepo): Promise<void> {
    const configNamespaces = new Set((this.config.namespaces || []).map((namespace) => namespace.id));
    const namespaceRules = await repo
      .createQueryBuilder('rule')
      .where('rule.namespace_id IS NOT NULL');
    applyWorkspaceQueryScope(namespaceRules, 'rule', this.workspaceId());
    const rows = await namespaceRules
      .andWhere('rule.is_active = :active', { active: true })
      .getMany();

    for (const rule of rows) {
      if (!rule.namespace_id || configNamespaces.has(rule.namespace_id)) {
        continue;
      }
      rule.is_active = false;
      await repo.save(rule);
      this.logger.log(`Deactivated orphaned namespace budget rule: ${rule.type} for namespace "${rule.namespace_id}"`);
    }
  }

  private async syncRulesFromConfig(): Promise<void> {
    await this.withBudgetMutation(async (context) => {
      // Config reloads share the ledger lock order and connection. Saving stale
      // full entities outside that transaction could overwrite live balances.
      if (context.lockActiveRules) {
        const rules = await context.repo.find({ where: workspaceFindWhere(this.workspaceId(), {}) });
        for (const rule of [...rules].sort((a, b) => a.id - b.id)) await context.repo.findOne({
          where: workspaceFindWhere(this.workspaceId(), { id: rule.id }),
          lock: { mode: 'pessimistic_write' },
        });
      }
      await this.ensureDefaultRules(context.repo);
      await this.ensurePerKeyRules(context.repo);
      await this.ensureNamespaceRules(context.repo);
      await this.deactivateOrphanedRules(context.repo);
      await this.deactivateOrphanedNamespaceRules(context.repo);
      await this.refreshBudgetMetricSnapshot(context.repo);
    });
  }

  /**
   * Check if the request can proceed within budget limits.
   * When apiKeyName is provided, checks both global AND per-key limits.
   * Throws BudgetExceededError if any active budget is exceeded.
   */
  async check(apiKeyName?: string, apiKeyId?: string, namespaceId?: string | null, teamId?: string | null): Promise<void> {
    const args = { apiKeyName: apiKeyName || null, apiKeyId, namespaceId, teamId };
    const check = async (context: BudgetMutationContext) => {
      const scopes = await this.loadRuleScopes(args.apiKeyName, args.apiKeyId, args.namespaceId, args.teamId, context);
      for (const scope of scopes) {
        await this.resetExpiredPeriods(scope.rules, context.repo);
        this.evaluateRules(scope.rules, scope.apiKeyName, scope.apiKeyId || null, scope.namespaceId || null, scope.teamId || null);
      }
    };
    await this.withBudgetMutation(check, context => this.prepareCheckPrelude(context, args, check));
  }

  /**
   * Reserve estimated usage before dispatching a provider request.
   *
   * PostgreSQL deployments run the mutation in a transaction and lock matching
   * budget rows before evaluating projections. Other storage backends keep the
   * process-local queue while preserving the same reservation contract.
   */
  async reserve(
    estimatedTokens: number,
    estimatedCostUsd: number,
    apiKeyName?: string,
    apiKeyId?: string,
    namespaceId?: string | null,
    teamId?: string | null,
  ): Promise<BudgetReservation> {
    const safeTokens = this.sanitizeCounterValue(estimatedTokens);
    const safeCostUsd = this.sanitizeCounterValue(estimatedCostUsd);
    const identity = {
      apiKeyName: apiKeyName || null,
      apiKeyId: apiKeyId || null,
      namespaceId: namespaceId || null,
      teamId: teamId || null,
    };

    let metricDimensions: BudgetReservationMetricDimension[] = [];

    try {
      await this.withBudgetMutation(async (context) => {
        const scopes = await this.loadRuleScopes(
          identity.apiKeyName,
          identity.apiKeyId,
          identity.namespaceId,
          identity.teamId,
          context,
        );

        for (const scope of scopes) {
          await this.resetExpiredPeriods(scope.rules, context.repo);
          this.evaluateRuleProjections(scope, safeTokens, safeCostUsd);
        }

        for (const scope of scopes) {
          await this.applyUsageToRules(scope, safeTokens, safeCostUsd, true, context.repo);
        }

        metricDimensions = this.collectReservationMetricDimensions(
          scopes,
          safeTokens,
          safeCostUsd,
        );
        await this.refreshBudgetMetricSnapshot(context.repo);
      });
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        this.recordReservationMetrics('rejected', [{
          scope: err.scope,
          budgetType: err.budgetType,
        }]);
        await this.recordBudgetReservationRejectedAudit(err);
      }
      throw err;
    }

    this.recordReservationMetrics('reserve', metricDimensions);

    let settlement: Promise<void> | null = null;
    const settle = (fn: () => Promise<void>): Promise<void> => {
      if (!settlement) {
        settlement = fn();
      }
      return settlement;
    };

    return {
      tokens: safeTokens,
      costUsd: safeCostUsd,
      commit: (actualTokens: number, actualCostUsd: number) =>
        settle(async () => {
          const tokenDelta = this.sanitizeCounterValue(actualTokens) - safeTokens;
          const costDelta = this.sanitizeCounterValue(actualCostUsd) - safeCostUsd;
          await this.adjustReservation(tokenDelta, costDelta, identity);
          this.recordReservationMetrics('commit', metricDimensions);
        }),
      release: () =>
        settle(async () => {
          await this.adjustReservation(-safeTokens, -safeCostUsd, identity);
          this.recordReservationMetrics('release', metricDimensions);
        }),
    };
  }

  /**
   * Record token and cost usage after a successful call.
   * Updates both global rules and per-key rules if apiKeyName is provided.
   */
  async record(tokens: number, costUsd: number, apiKeyName?: string, apiKeyId?: string, namespaceId?: string | null, teamId?: string | null): Promise<void> {
    const safeTokens = this.sanitizeCounterValue(tokens);
    const safeCostUsd = this.sanitizeCounterValue(costUsd);
    await this.withBudgetMutation(async (context) => {
      const scopes = await this.loadRuleScopes(
        apiKeyName || null,
        apiKeyId || null,
        namespaceId || null,
        teamId || null,
        context,
      );

      for (const scope of scopes) {
        await this.resetExpiredPeriods(scope.rules, context.repo);
        await this.applyUsageToRules(scope, safeTokens, safeCostUsd, true, context.repo);
      }

      await this.refreshBudgetMetricSnapshot(context.repo);
    });
  }

  /**
   * Get current budget status for rules.
   * No apiKeyName = global rules only; with apiKeyName = that key's rules.
   */
  async getStatus(apiKeyName?: string | null, apiKeyId?: string | null, namespaceId?: string | null, teamId?: string | null): Promise<BudgetStatus[]> {
    return this.withBudgetMutation(async (context) => {
    const targetKeyName = apiKeyName === undefined ? null : apiKeyName;
    const rules = namespaceId
      ? await this.loadActiveRules(null, null, namespaceId, null, context)
      : teamId
      ? await this.loadActiveRules(null, null, null, teamId, context)
      : apiKeyId
      ? await this.loadActiveRules(null, apiKeyId, null, null, context)
      : targetKeyName === null
      ? await this.loadActiveRules(null, null, null, null, context)
      : await this.loadActiveRules(targetKeyName, null, null, null, context);

    await this.resetExpiredPeriods(rules, context.repo);

    const statuses: BudgetStatus[] = rules.map((r) => ({
      id: r.id,
      type: r.type,
      scope: r.namespace_id ? 'namespace' : r.team_id ? 'team' : r.api_key_id || r.api_key_name ? 'api_key' : 'global',
      apiKeyName: r.api_key_name,
      apiKeyId: r.api_key_id,
      namespaceId: r.namespace_id,
      teamId: r.team_id,
      limit: r.limit_value,
      current: Number(r.current_value_exact ?? r.current_value),
      ...(r.current_value_exact === undefined ? {} : { currentExact: r.current_value_exact }),
      percentage: this.rulePercentage(r),
      alertThreshold: r.alert_threshold,
      isExceeded: this.ruleExceeded(r),
      isAlert: this.ruleAlert(r),
      periodStart: r.period_start,
      resetAt: this.nextResetAt(r),
    }));

    await this.refreshBudgetMetricSnapshot(context.repo);
    return statuses;
    });
  }

  /**
   * Reset a budget rule's counter (manual reset).
   */
  async resetRule(ruleId: number): Promise<void> {
    await this.withBudgetMutation(async (context) => {
    const rule = await context.repo.findOne({
      where: workspaceFindWhere(this.workspaceId(), { id: ruleId }),
      ...(context.lockActiveRules ? { lock: { mode: 'pessimistic_write' as const } } : {}),
    });
    if (rule) {
      await this.hydrateExactRule(rule, context.repo);
      const beforeSummary = this.budgetRuleAuditSummary(rule);
      rule.current_value = 0;
      delete rule.current_value_exact;
      // A manual reset is a new ledger epoch even within the same civil day.
      rule.period_start = this.exactLedgerEnabled ? new Date(Math.max(Date.now(), new Date(rule.period_start).getTime() + 1)) : this.startOfDay(new Date());
      if (this.exactLedgerEnabled) await this.saveExactRule(rule, ExactDecimal.zero, context.repo, true);
      else await context.repo.save(rule);
      await this.refreshBudgetMetricSnapshot(context.repo);
      await this.recordBudgetRuleResetAudit(rule, beforeSummary, context.repo.manager);
      this.logger.log(`Budget rule ${rule.type} manually reset`);
    }
    });
  }

  /**
   * Get list of API key names that have active per-key budget rules.
   */
  async getKeysWithBudgets(): Promise<string[]> {
    const results = await this.budgetRepo
      .createQueryBuilder('rule')
      .select('DISTINCT rule.api_key_name', 'api_key_name')
      .where('rule.api_key_name IS NOT NULL')
      .andWhere(
        this.workspaceId() === DEFAULT_WORKSPACE_ID
          ? '(rule.workspace_id = :workspaceId OR rule.workspace_id IS NULL)'
          : 'rule.workspace_id = :workspaceId',
        { workspaceId: this.workspaceId() },
      )
      .andWhere('rule.namespace_id IS NULL')
      .andWhere('rule.team_id IS NULL')
      .andWhere('rule.is_active = :active', { active: true })
      .getRawMany();

    return results.map((r) => r.api_key_name);
  }

  // ── Private helpers ───────────────────────────────────────

  private async withBudgetMutation<T>(
    operation: (context: BudgetMutationContext) => Promise<T>,
    prepare?: (context: BudgetMutationContext) => PostgresTransactionReadPrelude<T> | null,
  ): Promise<T> {
    const previous = this.mutationQueue;
    let release!: () => void;
    this.mutationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await this.withCommittedBudgetEffects(async () => {
      const connection = this.budgetRepo.manager?.connection;
      if (connection?.options?.type === 'better-sqlite3') {
        return await serializeDatabaseAccess(connection, () => connection.transaction(async (manager) =>
          operation({ repo: manager.getRepository(BudgetRule), lockActiveRules: false })));
      }
      const transactionManager = this.transactionManager(this.budgetRepo);
      if (prepare && connection instanceof DataSource && transactionManager === connection.manager &&
        connection.transaction === DataSource.prototype.transaction && transactionManager.transaction === EntityManager.prototype.transaction) {
        return withPostgresReadPrelude(connection,
          manager => prepare({ repo: manager.getRepository(BudgetRule), lockActiveRules: true }),
          manager => operation({ repo: manager.getRepository(BudgetRule), lockActiveRules: true }),
          'READ COMMITTED');
      }
      if (transactionManager) {
        return await transactionManager.transaction('READ COMMITTED', async (manager) =>
          operation({
            repo: manager.getRepository(BudgetRule),
            lockActiveRules: true,
          }),
        );
      }

      return await operation({
        repo: this.budgetRepo,
        lockActiveRules: false,
      });
      });
    } finally {
      release();
    }
  }

  private transactionManager(repo: Repository<BudgetRule>): EntityManager | null {
    const manager = repo.manager;
    const dataSource = manager?.connection;
    if (dataSource?.options?.type !== 'postgres') return null;
    if (typeof manager?.transaction !== 'function') return null;
    return manager;
  }

  private async loadRuleScopes(
    apiKeyName: string | null,
    apiKeyId?: string | null,
    namespaceId?: string | null,
    teamId?: string | null,
    context: BudgetMutationContext = {
      repo: this.budgetRepo,
      lockActiveRules: false,
    },
    additionalRuleIds: number[] = [],
  ): Promise<BudgetRuleScope[]> {
    if (context.lockActiveRules && context.repo.manager.connection.options.type === 'postgres')
      return this.loadLockedRuleScopes(apiKeyName, apiKeyId, namespaceId, teamId, context, additionalRuleIds);
    // Discover all overlapping scopes before locking; inactive holds participate in
    // the same global ID order so concurrent settlement cannot invert lock order.
    const readContext = { ...context, lockActiveRules: false, skipRuleHydration: true };
    const scopes: BudgetRuleScope[] = [
      {
        rules: await this.loadActiveRules(null, null, null, null, readContext),
        apiKeyName: null,
        apiKeyId: null,
        namespaceId: null,
        teamId: null,
      },
    ];

    if (namespaceId) {
      scopes.push({
        rules: await this.loadActiveRules(null, null, namespaceId, null, readContext),
        apiKeyName: null,
        apiKeyId: null,
        namespaceId,
        teamId: null,
      });
    }

    if (teamId) {
      scopes.push({
        rules: await this.loadActiveRules(null, null, null, teamId, readContext),
        apiKeyName: null,
        apiKeyId: null,
        namespaceId: null,
        teamId,
      });
    }

    if (apiKeyName || apiKeyId) {
      scopes.push({
        rules: await this.loadActiveRules(apiKeyName, apiKeyId, null, null, readContext),
        apiKeyName,
        apiKeyId: apiKeyId || null,
        namespaceId: null,
        teamId: null,
      });
    }

    const seen = new Set<number>();
    for (const scope of scopes) scope.rules = scope.rules.filter((rule) => {
      if (seen.has(rule.id)) return false;
      seen.add(rule.id); return true;
    });
    if (context.lockActiveRules) {
      const ids = new Set([...seen, ...additionalRuleIds]);
      const locked = new Map<number, BudgetRule>();
      if (ids.size) {
        const query = context.repo.createQueryBuilder('rule')
          .where('rule.id IN (:...ids)', { ids: [...ids].sort((a, b) => a - b) })
          .orderBy('rule.id', 'ASC').setLock('pessimistic_write');
        applyWorkspaceQueryScope(query, 'rule', this.workspaceId());
        for (const rule of await query.getMany()) {
          context.lockedRules?.set(rule.id, rule);
          if (rule.is_active) locked.set(rule.id, rule);
        }
      }
      for (const scope of scopes) scope.rules = scope.rules.flatMap((rule) => locked.has(rule.id) ? [locked.get(rule.id)!] : []);
    }
    await this.hydrateExactRules(scopes.flatMap(scope => scope.rules), context.repo);
    return scopes;
  }

  /** One ordered locking query discovers all matching scopes and old holds.
   * Exact balances still use a NEW statement after lock acquisition: a joined
   * balance snapshot could predate a lock wait and lose sub-float precision. */
  private async loadLockedRuleScopes(
    apiKeyName: string | null, apiKeyId: string | null | undefined,
    namespaceId: string | null | undefined, teamId: string | null | undefined,
    context: BudgetMutationContext, additionalRuleIds: number[],
  ): Promise<BudgetRuleScope[]> {
    if (!context.repo.manager.queryRunner?.isTransactionActive)
      throw new Error('Locked budget scope discovery requires an owning transaction');
    const { specs, query } = this.lockedScopePlan(apiKeyName, apiKeyId, namespaceId, teamId, context, additionalRuleIds);
    const prepared = this.checkedScopeRows.get(context);
    this.checkedScopeRows.delete(context);
    if (prepared && prepared.key !== this.scopeReadKey(apiKeyName, apiKeyId, namespaceId, teamId, additionalRuleIds))
      throw new Error('Budget check scope changed after its locked read');
    const rows = prepared ? prepared.rows : await query.getMany();
    for (const rule of rows) context.lockedRules?.set(rule.id, rule);
    const seen = new Set<number>();
    const scopes = specs.map(({ shape, scope }) => ({ ...scope, rules: rows.filter(rule => {
      if (!rule.is_active || seen.has(rule.id) ||
        !Object.entries(shape).every(([key, value]) => rule[key as keyof BudgetRule] === value)) return false;
      seen.add(rule.id); return true;
    }) }));
    await this.hydrateExactRules(scopes.flatMap(scope => scope.rules), context.repo);
    return scopes;
  }

  private scopeReadKey(name: string | null, key: string | null | undefined, namespace: string | null | undefined, team: string | null | undefined, extra: number[]): string {
    return JSON.stringify([this.workspaceId(), name, key ?? null, namespace ?? null, team ?? null, [...new Set(extra)].sort((a, b) => a - b)]);
  }

  private lockedScopePlan(
    apiKeyName: string | null, apiKeyId: string | null | undefined,
    namespaceId: string | null | undefined, teamId: string | null | undefined,
    context: BudgetMutationContext, additionalRuleIds: number[],
  ) {
    type Shape = Partial<Pick<BudgetRule, 'api_key_name' | 'api_key_id' | 'namespace_id' | 'team_id'>>;
    const specs: Array<{ shape: Shape; scope: Omit<BudgetRuleScope, 'rules'> }> = [{
      shape: { api_key_name: null, api_key_id: null, namespace_id: null, team_id: null },
      scope: { apiKeyName: null, apiKeyId: null, namespaceId: null, teamId: null },
    }];
    if (namespaceId) specs.push({ shape: { namespace_id: namespaceId, team_id: null },
      scope: { apiKeyName: null, apiKeyId: null, namespaceId, teamId: null } });
    if (teamId) specs.push({ shape: { team_id: teamId, api_key_name: null, api_key_id: null, namespace_id: null },
      scope: { apiKeyName: null, apiKeyId: null, namespaceId: null, teamId } });
    if (apiKeyName || apiKeyId) specs.push({
      shape: apiKeyId ? { api_key_id: apiKeyId, team_id: null }
        : { api_key_name: apiKeyName, api_key_id: null, namespace_id: null, team_id: null },
      scope: { apiKeyName, apiKeyId: apiKeyId || null, namespaceId: null, teamId: null },
    });
    // The same shapes produce SQL predicates AND post-lock scope membership.
    // This preserves namespace/key overlap precedence without stale discovery.
    const conditions: Array<Record<string, unknown>> = specs.flatMap(({ shape }) => {
      const scoped = workspaceFindWhere(this.workspaceId(), {
        ...Object.fromEntries(Object.entries(shape).map(([key, value]) => [key, value === null ? IsNull() : value])),
        is_active: true,
      });
      return Array.isArray(scoped) ? scoped : [scoped];
    });
    if (additionalRuleIds.length) {
      const scoped = workspaceFindWhere(this.workspaceId(), { id: In([...new Set(additionalRuleIds)]) });
      conditions.push(...(Array.isArray(scoped) ? scoped : [scoped]));
    }
    const query = context.repo.createQueryBuilder('rule').where(conditions)
      .orderBy('rule.id', 'ASC').setLock('pessimistic_write');
    return { specs, query };
  }

  /** Coalesce real BEGIN + isolation + the ordered rule lock for check(). The
   * exact-balance SELECT deliberately stays AFTER the lock and TypeORM entity
   * hydration, preserving every rule/epoch pair without SQL timezone guesses.
   */
  private prepareCheckPrelude<T>(
    context: BudgetMutationContext,
    args: { apiKeyName: string | null; apiKeyId?: string | null; namespaceId?: string | null; teamId?: string | null },
    operation: (context: BudgetMutationContext) => Promise<T>,
  ): PostgresTransactionReadPrelude<T> | null {
    const repo = context.repo, metadata = repo.metadata;
    if (!metadata || metadata.listeners.length || metadata.relations.length || repo.manager.connection.options.cache ||
      repo.createQueryBuilder !== Repository.prototype.createQueryBuilder) return null;
    const { query } = this.lockedScopePlan(args.apiKeyName, args.apiKeyId, args.namespaceId, args.teamId, context, []);
    if (Object.getPrototypeOf(query) !== SelectQueryBuilder.prototype ||
      Object.entries(defaultBudgetSelectMethods).some(([name, method]) => query[name as keyof typeof defaultBudgetSelectMethods] !== method) ||
      query.expressionMap.joinAttributes.length ||
      query.expressionMap.relationIdAttributes.length || query.expressionMap.relationCountAttributes.length) return null;
    // Match getRawAndEntities/getMany using the installed TypeORM transformer,
    // not a handwritten Date/boolean/column mapping or a cached rule object.
    query.expressionMap.queryEntity = true;
    const [sql, parameters] = query.getQueryAndParameters();
    const program = createPostgresReadProgram([{ sql, parameters }]);
    if (!program) return null;
    const key = this.scopeReadKey(args.apiKeyName, args.apiKeyId, args.namespaceId, args.teamId, []);
    return { program, apply: async (manager, results) => {
      if (repo.manager !== manager || !manager.queryRunner?.isTransactionActive)
        throw new Error('Budget check prelude lost its owning transaction');
      const transformer = new RawSqlResultsToEntityTransformer(query.expressionMap, manager.connection.driver, [], [], manager.queryRunner);
      const rows = transformer.transform(results[0], query.expressionMap.mainAlias!) as BudgetRule[];
      if (rows.length !== results[0].length) throw new Error('Budget check prelude returned incomplete entities');
      this.checkedScopeRows.set(context, { key, rows });
      try { return await operation(context); }
      finally { this.checkedScopeRows.delete(context); }
    } };
  }

  /**
   * Load active rules for a given scope (null = global, string = per-key).
   */
  private async loadActiveRules(
    apiKeyName: string | null,
    apiKeyId?: string | null,
    namespaceId?: string | null,
    teamId?: string | null,
    context: BudgetMutationContext = {
      repo: this.budgetRepo,
      lockActiveRules: false,
    },
  ): Promise<BudgetRule[]> {
    const repo = context.repo;
    let rules: BudgetRule[];
    if (namespaceId) {
      rules = await repo.find({
        where: workspaceFindWhere(this.workspaceId(), {
          namespace_id: namespaceId,
          team_id: IsNull(),
          is_active: true,
        }),
      });
      return this.lockRulesForMutation(rules, context);
    }
    if (teamId) {
      rules = await repo.find({
        where: workspaceFindWhere(this.workspaceId(), {
          team_id: teamId,
          api_key_name: IsNull(),
          api_key_id: IsNull(),
          namespace_id: IsNull(),
          is_active: true,
        }),
      });
      return this.lockRulesForMutation(rules, context);
    }
    if (apiKeyId) {
      rules = await repo.find({
        where: workspaceFindWhere(this.workspaceId(), {
          api_key_id: apiKeyId,
          team_id: IsNull(),
          is_active: true,
        }),
      });
      return this.lockRulesForMutation(rules, context);
    }
    rules = await repo.find({
      where: workspaceFindWhere(this.workspaceId(), {
        api_key_name: apiKeyName === null ? IsNull() : apiKeyName,
        api_key_id: IsNull(),
        namespace_id: IsNull(),
        team_id: IsNull(),
        is_active: true,
      }),
    });
    return this.lockRulesForMutation(rules, context);
  }

  private async lockRulesForMutation(
    rules: BudgetRule[],
    context: BudgetMutationContext,
  ): Promise<BudgetRule[]> {
    if (!context.lockActiveRules || rules.length === 0) {
      if (!context.skipRuleHydration) await this.hydrateExactRules(rules, context.repo);
      return rules;
    }

    const lockedRules: BudgetRule[] = [];
    for (const rule of [...rules].sort((a, b) => a.id - b.id)) {
      const locked = await context.repo.findOne({
        where: workspaceFindWhere(this.workspaceId(), {
          id: rule.id,
          is_active: true,
        }),
        lock: { mode: 'pessimistic_write' },
      });
      if (locked) lockedRules.push(locked);
    }

    await this.hydrateExactRules(lockedRules, context.repo);
    return lockedRules;
  }

  /**
   * Evaluate a set of rules, throwing BudgetExceededError if any is exceeded.
   */
  private evaluateRules(
    rules: BudgetRule[],
    apiKeyName: string | null,
    apiKeyId: string | null,
    namespaceId: string | null,
    teamId: string | null,
  ): void {
    for (const rule of rules) {
      if (this.exactLedgerEnabled ? this.exactCurrent(rule).compare(this.exactNumber(rule.limit_value)) >= 0 : rule.current_value >= rule.limit_value) {
        this.rejectBudget(rule, new BudgetExceededError(
          rule.type,
          rule.current_value,
          rule.limit_value,
          apiKeyName || rule.api_key_name,
          apiKeyId || rule.api_key_id,
          namespaceId || rule.namespace_id,
          teamId || rule.team_id,
          rule.period_start,
        ));
      }
    }
  }

  private evaluateRuleProjections(scope: BudgetRuleScope, tokens: number, costUsd: number): void {
    for (const rule of scope.rules) {
      const increment = this.ruleIncrement(rule, tokens, costUsd);
      const exactProjected = this.exactLedgerEnabled ? this.exactCurrent(rule).add(this.exactNumber(increment)) : null;
      const projectedValue = exactProjected ? Number(exactProjected.toFixed(18)) : rule.current_value + increment;
      if (exactProjected ? exactProjected.compare(this.exactNumber(rule.limit_value)) > 0 : projectedValue > rule.limit_value) {
        const projectedRule: BudgetRule = { ...rule, current_value: projectedValue, current_value_exact: (exactProjected ?? this.exactNumber(projectedValue)).toFixed(18) };
        this.rejectBudget(projectedRule, new BudgetExceededError(
          rule.type,
          projectedValue,
          rule.limit_value,
          scope.apiKeyName || rule.api_key_name,
          scope.apiKeyId || rule.api_key_id,
          scope.namespaceId || rule.namespace_id,
          scope.teamId || rule.team_id,
          rule.period_start,
        ));
      }
    }
  }

  private async adjustReservation(
    tokenDelta: number,
    costDelta: number,
    identity: {
      apiKeyName: string | null;
      apiKeyId: string | null;
      namespaceId: string | null;
      teamId: string | null;
    },
  ): Promise<void> {
    if (tokenDelta === 0 && costDelta === 0) return;

    await this.withBudgetMutation(async (context) => {
      const scopes = await this.loadRuleScopes(
        identity.apiKeyName,
        identity.apiKeyId,
        identity.namespaceId,
        identity.teamId,
        context,
      );

      for (const scope of scopes) {
        await this.resetExpiredPeriods(scope.rules, context.repo);
        await this.applyUsageToRules(
          scope,
          tokenDelta,
          costDelta,
          tokenDelta > 0 || costDelta > 0,
          context.repo,
        );
      }

      await this.refreshBudgetMetricSnapshot(context.repo);
    });
  }

  private async applyUsageToRules(
    scope: BudgetRuleScope,
    tokens: number,
    costUsd: number,
    emitThresholdAlerts: boolean,
    repo: Repository<BudgetRule> = this.budgetRepo,
  ): Promise<void> {
    for (const rule of scope.rules) {
      if (this.exactLedgerEnabled) await this.hydrateExactRule(rule, repo);
      const before = this.exactCurrent(rule);
      const increment = this.ruleIncrement(rule, tokens, costUsd);
      if (this.exactLedgerEnabled) {
        const value = before.add(this.exactNumber(increment));
        await this.saveExactRule(rule, value.compare(ExactDecimal.zero) < 0 ? ExactDecimal.zero : value, repo);
      } else rule.current_value = Math.max(0, rule.current_value + increment);
      if (!this.exactLedgerEnabled) await repo.save(rule);
      if (emitThresholdAlerts || increment <= 0) this.observeBudgetChange(rule, before);
    }
  }

  private rulePercentage(rule: BudgetRule): number {
    if (rule.limit_value <= 0) return 0;
    return this.exactLedgerEnabled ? Number(this.exactCurrent(rule).divide(this.exactNumber(rule.limit_value)).toFixed(18)) : rule.current_value / rule.limit_value;
  }

  private ruleExceeded(rule: BudgetRule): boolean {
    return this.exactLedgerEnabled ? this.exactCurrent(rule).compare(this.exactNumber(rule.limit_value)) >= 0 : rule.current_value >= rule.limit_value;
  }

  private ruleAlert(rule: BudgetRule): boolean {
    if (rule.limit_value <= 0) return false;
    return this.exactLedgerEnabled ? this.exactCurrent(rule).compare(this.exactNumber(rule.limit_value).multiply(this.exactNumber(rule.alert_threshold))) >= 0 : rule.current_value / rule.limit_value >= rule.alert_threshold;
  }

  private exactNumber(value: number): ExactDecimal {
    if (!Number.isFinite(value)) throw new Error('Budget counters must be finite');
    try { return ExactDecimal.parse((value < 0 ? '-' : '') + legacyNumberToDecimal(Math.abs(value))); }
    catch (error) {
      // Legacy JS arithmetic can expand a valid micro-cost to >18 fractional
      // digits (for example 4 / 1e6 * 5). Round only that legacy bridge; new
      // decimal-string prices and exact calculator outputs never use this path.
      if (Math.abs(value) >= 1e21) throw error;
      return ExactDecimal.parse(value.toFixed(18));
    }
  }

  private exactCurrent(rule: BudgetRule): ExactDecimal {
    return rule.current_value_exact === undefined ? this.exactNumber(rule.current_value) : ExactDecimal.parse(rule.current_value_exact);
  }

  private async hydrateExactRule(rule: BudgetRule, repo: Repository<BudgetRule>): Promise<void> {
    await this.hydrateExactRules([rule], repo);
  }

  /** Fresh transaction-local hydration only; never cache balances across commits.
   * Match exact rule/epoch pairs, not a cross-product or a workspace-wide scan. */
  private async hydrateExactRules(rules: BudgetRule[], repo: Repository<BudgetRule>): Promise<void> {
    if (!this.exactLedgerEnabled || rules.length === 0) return;
    // At most 501 bind parameters and 250 OR branches, including on older SQLite.
    const chunkSize = 250;
    for (let offset = 0; offset < rules.length; offset += chunkSize) {
      const chunk = rules.slice(offset, offset + chunkSize);
      const parameters: Record<string, string | number> = { workspace: this.workspaceId() };
      const pairs = chunk.map((rule, index) => {
        parameters[`id${index}`] = rule.id;
        parameters[`period${index}`] = new Date(rule.period_start).toISOString();
        return `(b.rule_id = :id${index} AND b.period_start = :period${index})`;
      });
      const rows = await repo.manager.createQueryBuilder().select('b.*').from('pricing_budget_balances', 'b')
        .where(`b.workspace_id = :workspace AND (${pairs.join(' OR ')})`, parameters)
        .getRawMany<{ rule_id: number; period_start: string; amount_decimal: string; legacy_projection: string }>();
      const balances = new Map(rows.map(row => [`${row.rule_id}:${row.period_start}`, row]));
      for (const rule of chunk) {
        const period = new Date(rule.period_start).toISOString();
        const balance = balances.get(`${rule.id}:${period}`);
        const observed = String(repo.manager.connection.options.type === 'postgres' ? Math.fround(rule.current_value) : rule.current_value);
        rule.current_value_exact = balance && balance.legacy_projection === observed
          ? balance.amount_decimal : this.exactNumber(rule.current_value).toFixed(18);
      }
    }
  }

  private async saveExactRule(rule: BudgetRule, value: ExactDecimal, repo: Repository<BudgetRule>, resetPeriod = false): Promise<void> {
    const amount = value.toFixed(18);
    const numeric = Number(amount);
    if (!Number.isFinite(numeric)) throw new Error('Budget projection overflow');
    // PostgreSQL's legacy real column is float4. Preserve its actual representation only as a projection.
    const projection = repo.manager.connection.options.type === 'postgres' ? Math.fround(numeric) : numeric;
    if (!Number.isFinite(projection)) throw new Error('Legacy budget projection overflow');
    rule.current_value = projection;
    rule.current_value_exact = amount;
    if (repo.manager.connection.options.type === 'postgres') {
      // The caller already read/locked this row. Do not re-read and save the
      // full entity (including configuration fields) for a counter mutation.
      const saved = await repo.update(workspaceFindWhere(this.workspaceId(), { id: rule.id }), { current_value: projection, ...(resetPeriod ? { period_start: rule.period_start } : {}) });
      if (saved.affected !== 1) throw new Error('Budget counter row changed or is outside the workspace');
    } else await repo.save(rule);
    const key = { rule_id: rule.id, period_start: new Date(rule.period_start).toISOString() };
    const updated = await repo.manager.createQueryBuilder().update('pricing_budget_balances')
      .set({ amount_decimal: amount, legacy_projection: String(projection) })
      .where('rule_id = :id AND period_start = :period AND workspace_id = :workspace', { id: rule.id, period: key.period_start, workspace: this.workspaceId() }).execute();
    if (!updated.affected) await repo.manager.createQueryBuilder().insert().into('pricing_budget_balances')
      .values({ ...key, workspace_id: this.workspaceId(), amount_decimal: amount, legacy_projection: String(projection) }).execute();
  }

  private ruleIncrement(rule: BudgetRule, tokens: number, costUsd: number): number {
    if (rule.type === 'daily_tokens') return tokens;
    if (rule.type === 'daily_cost') return costUsd;
    return 0;
  }

  /**
   * Reset counters for rules whose period has expired (new day).
   */
  private async resetExpiredPeriods(
    rules: BudgetRule[],
    repo: Repository<BudgetRule> = this.budgetRepo,
  ): Promise<void> {
    const todayStart = this.startOfDay(new Date());

    for (const rule of rules) {
      if (rule.type.startsWith('daily_')) {
        const ruleStart = this.startOfDay(new Date(rule.period_start));
        if (ruleStart.getTime() < todayStart.getTime()) {
          this.logger.log(`Daily budget reset: ${rule.type} (was ${rule.current_value.toFixed(2)})`);
          rule.current_value = 0;
          delete rule.current_value_exact;
          rule.period_start = todayStart;
          await repo.save(rule);
        }
      }
    }
  }

  private startOfDay(date: Date): Date {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  private nextResetAt(rule: BudgetRule): Date | null {
    if (!rule.type.startsWith('daily_')) return null;
    const reset = this.startOfDay(new Date(rule.period_start));
    reset.setDate(reset.getDate() + 1);
    return reset;
  }

  private sanitizeCounterValue(value: number): number {
    if (!Number.isFinite(value) || value < 0) return 0;
    return value;
  }

  private registerMetrics(): void {
    this.telemetry?.budgetUsageRatio.addCallback((observable) => {
      for (const item of this.budgetMetricSnapshot) {
        observable.observe(item.ratio, item.attrs);
      }
    });
  }

  private async refreshBudgetMetricSnapshot(
    repo: Repository<BudgetRule> = this.budgetRepo,
  ): Promise<void> {
    try {
      const rules = await repo.find({
        where: workspaceFindWhere(this.workspaceId(), { is_active: true }),
      });
      const statuses: BudgetStatus[] = rules.map((r) => ({
        id: r.id,
        type: r.type,
        scope: r.namespace_id ? 'namespace' as const : r.team_id ? 'team' as const : r.api_key_id || r.api_key_name ? 'api_key' as const : 'global' as const,
        apiKeyName: r.api_key_name,
        apiKeyId: r.api_key_id,
        namespaceId: r.namespace_id,
        teamId: r.team_id,
        limit: r.limit_value,
        current: r.current_value,
        percentage: this.rulePercentage(r),
        alertThreshold: r.alert_threshold,
        isExceeded: this.ruleExceeded(r),
        isAlert: this.ruleAlert(r),
        periodStart: r.period_start,
        resetAt: this.nextResetAt(r),
      }));
      this.updateBudgetMetricSnapshot(statuses);
    } catch (err) {
      this.logger.warn(`Failed to refresh budget metrics: ${(err as Error).message}`);
    }
  }

  private updateBudgetMetricSnapshot(statuses: BudgetStatus[]): void {
    const effects = this.mutationEffects.getStore();
    if (effects) { effects.metrics = structuredClone(statuses); return; }
    const aggregates = new Map<string, {
      ratio: number;
      attrs: { scope: 'global' | 'api_key' | 'namespace' | 'team'; budget_type: string };
    }>();
    for (const status of statuses) {
      const key = `${status.scope}:${status.type}`;
      const current = aggregates.get(key);
      if (!current || status.percentage > current.ratio) {
        aggregates.set(key, {
          ratio: Math.max(0, status.percentage || 0),
          attrs: {
            scope: status.scope,
            budget_type: status.type,
          },
        });
      }
    }
    this.budgetMetricSnapshot = [...aggregates.values()];
  }

  private collectReservationMetricDimensions(
    scopes: BudgetRuleScope[],
    tokens: number,
    costUsd: number,
  ): BudgetReservationMetricDimension[] {
    const dimensions: BudgetReservationMetricDimension[] = [];
    for (const scope of scopes) {
      for (const rule of scope.rules) {
        if (this.ruleIncrement(rule, tokens, costUsd) <= 0) continue;
        dimensions.push({
          scope: this.metricScope(scope),
          budgetType: rule.type,
        });
      }
    }
    return dimensions;
  }

  private recordReservationMetrics(
    event: BudgetReservationMetricEvent,
    dimensions: BudgetReservationMetricDimension[],
  ): void {
    for (const dimension of dimensions) {
      this.telemetry?.recordBudgetReservation?.({
        event,
        scope: dimension.scope,
        budgetType: dimension.budgetType,
      });
    }
  }

  private async recordBudgetReservationRejectedAudit(err: BudgetExceededError): Promise<void> {
    if (!this.managementAudit) return;
    await this.managementAudit.record({
      action: 'budget.reservation.rejected',
      resourceType: 'budget_rule',
      resourceId: null,
      result: 'denied',
      failureReason: `${err.budgetType} budget exceeded`,
      afterSummary: {
        rejected: true,
        scope: err.scope,
        budget_type: err.budgetType,
        current: Number(err.current.toFixed(6)),
        limit: Number(err.limit.toFixed(6)),
        reset_at: err.resetAt?.toISOString() ?? null,
      },
      metadata: {
        scope: err.scope,
        budget_type: err.budgetType,
      },
      source: 'budget',
    });
  }

  private async recordBudgetRuleResetAudit(
    rule: BudgetRule,
    beforeSummary: Record<string, unknown>,
    manager?: EntityManager,
  ): Promise<void> {
    if (!this.managementAudit) return;
    const input = {
      action: 'budget.rule.reset',
      resourceType: 'budget_rule',
      resourceId: String(rule.id),
      beforeSummary,
      afterSummary: this.budgetRuleAuditSummary(rule),
      metadata: {
        scope: this.budgetRuleScope(rule),
        budget_type: rule.type,
      },
      source: 'budget',
    };
    if (manager) await this.managementAudit.record(input, manager);
    else await this.managementAudit.record(input);
  }

  private budgetRuleAuditSummary(rule: BudgetRule): Record<string, unknown> {
    return {
      scope: this.budgetRuleScope(rule),
      budget_type: rule.type,
      current: Number(rule.current_value.toFixed(6)),
      ...(rule.current_value_exact === undefined ? {} : { current_exact: rule.current_value_exact }),
      limit: Number(rule.limit_value.toFixed(6)),
      alert_threshold: rule.alert_threshold,
      reset_at: this.nextResetAt(rule)?.toISOString() ?? null,
    };
  }

  private budgetRuleScope(rule: BudgetRule): BudgetReservationMetricScope {
    if (rule.namespace_id) return 'namespace';
    if (rule.team_id) return 'team';
    if (rule.api_key_name || rule.api_key_id) return 'api_key';
    return 'global';
  }

  private metricScope(scope: BudgetRuleScope): BudgetReservationMetricScope {
    if (scope.namespaceId) return 'namespace';
    if (scope.teamId) return 'team';
    if (scope.apiKeyName || scope.apiKeyId) return 'api_key';
    return 'global';
  }

  private alertBudgetThreshold(
    rule: BudgetRule,
    percentage: number,
    apiKeyName?: string | null,
    apiKeyId?: string,
    namespaceId?: string,
    teamId?: string,
  ): void {
    this.alerts?.emit({
      type: 'budget_threshold',
      severity: 'warning',
      message: `Budget threshold reached for ${rule.type}: ${(percentage * 100).toFixed(1)}%.`,
      dedupeKey: this.budgetDedupeKey(rule, 'threshold'),
      details: this.budgetAlertDetails(rule, apiKeyName, apiKeyId, namespaceId, teamId, percentage),
    });
  }

  private alertBudgetExceeded(
    rule: BudgetRule,
    apiKeyName: string | null,
    apiKeyId?: string,
    namespaceId?: string | null,
    teamId?: string | null,
  ): void {
    const percentage = rule.limit_value > 0
      ? rule.current_value / rule.limit_value
      : 0;
    this.alerts?.emit({
      type: 'budget_exceeded',
      severity: 'critical',
      message: `Budget exceeded for ${rule.type}: ${rule.current_value.toFixed(2)} / ${rule.limit_value.toFixed(2)}.`,
      dedupeKey: this.budgetDedupeKey(rule, 'exceeded'),
      details: this.budgetAlertDetails(
        rule,
        apiKeyName || rule.api_key_name,
        apiKeyId || rule.api_key_id || undefined,
        namespaceId || rule.namespace_id || undefined,
        teamId || rule.team_id || undefined,
        percentage,
      ),
    });
  }

  private budgetAlertDetails(
    rule: BudgetRule,
    apiKeyName?: string | null,
    apiKeyId?: string,
    namespaceId?: string,
    teamId?: string,
    percentage?: number,
  ): Record<string, unknown> {
    return {
      workspace_id: normalizeWorkspaceId(rule.workspace_id),
      scope: namespaceId || rule.namespace_id ? 'namespace' : teamId || rule.team_id ? 'team' : apiKeyName || apiKeyId ? 'api_key' : 'global',
      api_key_name: apiKeyName || null,
      api_key_id: apiKeyId || null,
      namespace_id: namespaceId || rule.namespace_id || null,
      team_id: teamId || rule.team_id || null,
      budget_type: rule.type,
      current: Number(rule.current_value.toFixed(6)),
      current_exact: this.exactCurrent(rule).toFixed(18),
      basis: 'reserved_and_committed_budget',
      period_start: new Date(rule.period_start).toISOString(),
      limit: Number(rule.limit_value.toFixed(6)),
      limit_exact: this.exactNumber(rule.limit_value).toFixed(18),
      percentage: Number(((percentage ?? 0) * 100).toFixed(2)),
      alert_threshold: rule.alert_threshold,
      reset_at: this.nextResetAt(rule)?.toISOString() || null,
    };
  }

  private budgetDedupeKey(rule: BudgetRule, suffix: string): string {
    return [
      normalizeWorkspaceId(rule.workspace_id),
      rule.id,
      rule.namespace_id || rule.team_id || rule.api_key_id || rule.api_key_name || 'global',
      rule.type,
      suffix,
      new Date(rule.period_start).toISOString(),
    ].join(':');
  }

  private workspaceId(): string {
    return normalizeWorkspaceId(this.workspaceContext.currentWorkspaceId());
  }
}

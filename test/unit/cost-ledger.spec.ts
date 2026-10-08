import type { RecoveryResolutionInput } from "../../src/pricing/pricing-resolution.types";
import { PricingResolutionService } from "../../src/pricing/pricing-resolution.service";
import type { BatchCostAdjustmentInput } from "../../src/pricing/cost-adjustment.types";
import type { AlertService } from "../../src/alerts/alert.service";
import {
  allocateBatchCost,
  batchShareCost,
} from "../../src/pricing/cost-allocation";
import { pricingContentHash } from "../../src/pricing/pricing-json";
import type { CostComputation } from "../../src/pricing/pricing.types";
import { spawnSync } from "node:child_process";
import { DataSource, InsertQueryBuilder, SelectQueryBuilder, type ObjectLiteral } from "typeorm";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BudgetService,
  BudgetExceededError,
} from "../../src/budget/budget.service";
import { BudgetRule } from "../../src/database/entities/budget-rule.entity";
import { WorkspaceContextService } from "../../src/workspaces/workspace-context.service";
import { DEFAULT_WORKSPACE_ID } from "../../src/workspaces/workspace.constants";
import { PricingRepository } from "../../src/pricing/pricing-repository";
import { CostLedgerService } from "../../src/pricing/cost-ledger.service";
import {
  applyPricingSchema,
  PRICING_MIGRATIONS,
} from "../../src/pricing/pricing-schema";
import type { CostReservationInput } from "../../src/pricing/cost-ledger.types";
import { mockConfigService } from "../helpers";
import { tokenBook, tokens } from "./pricing-fixtures";

const workspace = DEFAULT_WORKSPACE_ID;
const identity = {
  workspaceId: workspace,
  apiKeyName: null,
  apiKeyId: null,
  namespaceId: null,
  teamId: null,
};
const target = { node_id: "node-a", model: "synthetic-model" };

function ledgerContract(
  label: string,
  connect: () => Promise<{ source: DataSource; cleanup: () => Promise<void> }>,
  run: (name: string, body: () => void) => void = describe,
) {
  run(label, () => {
    let source: DataSource;
    let cleanup: () => Promise<void>;
    let budgets: BudgetService;
    let ledger: CostLedgerService;
    let prices: PricingRepository;
    let input: CostReservationInput;
    beforeEach(async () => {
      ({ source, cleanup } = await connect());
      await applyPricingSchema(source);
      const rules = source.getRepository(BudgetRule);
      await rules.save(
        rules.create({
          workspace_id: workspace,
          type: "daily_cost",
          limit_value: 10000000,
          current_value: 0,
          alert_threshold: 0.8,
          period_start: new Date(),
          is_active: true,
          api_key_name: null,
          api_key_id: null,
          namespace_id: null,
          team_id: null,
        }),
      );
      budgets = new BudgetService(
        mockConfigService(),
        new WorkspaceContextService(),
        rules,
      );
      ledger = new CostLedgerService(source, budgets);
      prices = new PricingRepository(source);
      const actor = {
        id: "operator",
        workspace_id: workspace,
        role: "admin" as const,
        global_admin: true,
      };
      const created = await prices.createBook(actor, {
        name: "synthetic",
        scope: "workspace",
        content: tokenBook(),
      });
      await prices.publishDraft(actor, created.draft.id, {
        draft_revision: 1,
        catalog_revision: 0,
        reason: "test fixture",
        confirm: true,
        targets: [{ level: "model", model: target.model }],
      });
      const request = await prices.capture({
        request_id: "request-a",
        workspace_id: workspace,
        report_currency: "USD",
      });
      input = {
        id: "reservation-a",
        requestId: "request-a",
        identity,
        target,
        estimate: request!.quote(
          target,
          tokens({ input_tokens: 1000, output_tokens: 0 }),
        ).cost,
        tokens: "1000",
        costUsd: "0.5",
        budgetBasis: "legacy_logical",
        leaseOwner: "test-process",
        leaseUntil: new Date(Date.now() + 60000).toISOString(),
      };
    });
    afterEach(async () => {
      jest.restoreAllMocks();
      if (source?.isInitialized) await source.destroy();
      await cleanup?.();
    });
    const current = async () => (await budgets.getStatus())[0];

    it.each(['all_missing', 'unknown_price', 'pending', 'known'] as const)('keeps missing usage distinct without losing mixed-request precedence: %s', async kind => {
      await ledger.reserve(input);
      const missing: CostComputation = { ...input.estimate, status: 'missing_usage', evidence_status: 'incomplete', amount: null, known_subtotal: null, report_amount: null, report_known_subtotal: null, rounding_adjustment: null, report_rounding_adjustment: null, lines: [], diagnostics: [{ code: 'pricing_dimension_missing', path: 'usage', message: 'Synthetic missing usage' }] };
      await ledger.beginAttempt({ id: 'first-missing', requestId: input.requestId, workspace, reservationId: input.id, target, feeSource: 'provider', dispatchedAt: new Date().toISOString(), priceContext: { context: {}, legacyPrice: null } });
      await ledger.completeAttempt('first-missing', workspace, missing);
      if (kind !== 'all_missing') {
        await ledger.beginAttempt({ id: 'second-state', requestId: input.requestId, workspace, reservationId: input.id, target, feeSource: 'provider', dispatchedAt: new Date().toISOString(), priceContext: { context: {}, legacyPrice: null } });
        if (kind !== 'pending') await ledger.completeAttempt('second-state', workspace, kind === 'known' ? input.estimate : { ...missing, status: 'unpriced' });
      }
      const before = await source.query('SELECT * FROM pricing_attempts ORDER BY id'), budget = await current();
      const result = await ledger.summary(input.requestId, workspace);
      expect(result).toMatchObject({ status: { all_missing: 'missing_usage', unknown_price: 'unpriced', pending: 'pending', known: 'partial' }[kind], amount: null, known_subtotal: kind === 'known' ? '0.001000000000000000' : null, unknown_attempts: kind === 'unknown_price' ? 2 : 1, pending_attempts: kind === 'pending' ? 1 : 0 });
      expect(await source.query('SELECT * FROM pricing_attempts ORDER BY id')).toEqual(before); expect(await current()).toEqual(budget);
    });

    const orphan = async (id = input.id, attemptId = 'orphan-attempt', options: { active?: boolean; job?: string } = {}) => {
      const leaseUntil = new Date(Date.now() + (options.active ? 60000 : -60000)).toISOString();
      await ledger.reserve({ ...input, id, leaseUntil, ...(options.job ? { jobId: options.job } : {}) });
      await ledger.beginAttempt({ id: attemptId, requestId: input.requestId, workspace, reservationId: id, target, feeSource: 'provider', dispatchedAt: new Date().toISOString(), priceContext: { context: {}, legacyPrice: null } });
      return attemptId;
    };
    it('refreshes budget metrics for actual ledger balance changes, not attempts, intents or idempotent replays', async () => {
      const refresh = jest.spyOn(budgets, 'refreshAfterLedgerMutation');
      const id = await orphan();
      expect(refresh).toHaveBeenCalledTimes(1);
      await ledger.reserve({ ...input, leaseUntil: new Date(Date.now() - 60000).toISOString() });
      await ledger.completeAttempt(id, workspace, input.estimate);
      await ledger.queueSettlement(input.id, workspace, 'commit', '1000', input.estimate.report_amount!, 'legacy_logical', { attemptId: id, cost: input.estimate });
      expect(refresh).toHaveBeenCalledTimes(1);
      await ledger.applySettlement(input.id, workspace);
      expect(refresh).toHaveBeenCalledTimes(2);
      await ledger.applySettlement(input.id, workspace);
      expect(refresh).toHaveBeenCalledTimes(2);
      expect((await current()).currentExact).toBe('0.001000000000000000');
    });
    it('records a durable unknown-outcome case once without releasing or guessing any cost', async () => {
      await orphan();
      const before = await current();
      const result = await Promise.all([ledger.reconcileDispatched(), new CostLedgerService(source, budgets).reconcileDispatched()]);
      expect(result.reduce((sum, item) => sum + item.opened, 0)).toBe(1);
      expect((await current()).currentExact).toBe(before.currentExact);
      const summary = await ledger.summary(input.requestId, workspace);
      expect(summary).toMatchObject({ amount: null, status: 'pending', budget_reserved_usd: '0.500000000000000000', budget_committed_usd: '0.000000000000000000' });
      expect(summary!.reservations[0].recovery_case).toMatchObject({ state: 'open', reason: 'attempt_outcome_unknown', revision: 1 });
      expect(await ledger.recoveryCases('foreign-workspace')).toEqual([]);
      const cases = await ledger.recoveryCases(workspace);
      expect(cases).toHaveLength(1);
      expect(cases[0]).not.toHaveProperty('evidence_json');
      expect((await source.query('SELECT * FROM pricing_budget_effects'))).toHaveLength(1);
      expect((await source.query('SELECT * FROM pricing_settlement_intents'))).toHaveLength(0);
    });
    it('waits for an actual budget decision even when all attempt receipts are terminal', async () => {
      const id = await orphan();
      await ledger.completeAttempt(id, workspace, input.estimate);
      await ledger.reconcileDispatched();
      expect((await ledger.recoveryCases(workspace))[0]).toMatchObject({ reason: 'settlement_decision_missing', state: 'open' });
      expect((await current()).currentExact).toBe('0.500000000000000000');
      expect((await ledger.summary(input.requestId, workspace))!.amount).toBe("0.001000000000000000");
    });
    it('updates changed evidence with a revision but does not churn an unchanged case', async () => {
      const id = await orphan();
      await ledger.reconcileDispatched();
      const first = (await ledger.recoveryCases(workspace))[0];
      await ledger.reconcileDispatched(100, new Date(Date.now() + 10));
      expect((await ledger.recoveryCases(workspace))[0]).toMatchObject({ revision: first.revision, evidence_hash: first.evidence_hash });
      await ledger.completeAttempt(id, workspace, input.estimate);
      expect(await ledger.reconcileDispatched(100, new Date(Date.now() + 20))).toMatchObject({ updated: 1 });
      expect((await ledger.recoveryCases(workspace))[0]).toMatchObject({ reason: 'settlement_decision_missing', revision: 2 });
    });
    it('does not mistake corrupt immutable evidence for a trustworthy outcome', async () => {
      const id = await orphan();
      await ledger.completeAttempt(id, workspace, input.estimate);
      await source.manager.createQueryBuilder().update('pricing_attempts').set({ cost_json: '{invalid' }).where('id = :id', { id }).execute();
      await ledger.reconcileDispatched();
      expect((await ledger.recoveryCases(workspace))[0].reason).toBe('attempt_evidence_invalid');
      expect((await current()).currentExact).toBe('0.500000000000000000');
    });
    it('excludes active leases, asynchronous jobs and durable pending intents from orphan guesses', async () => {
      await orphan('active', 'active-attempt', { active: true });
      await orphan('async', 'async-attempt', { job: 'synthetic-job' });
      await orphan('uncertain', 'uncertain-attempt');
      const at = new Date().toISOString();
      await source.manager.createQueryBuilder().insert().into('pricing_media_tasks').values({ id: 'uncertain-attempt', client_key_hash: null, request_id: input.requestId, reservation_id: 'uncertain', workspace_id: workspace, node_id: target.node_id, model: target.model, operation: 'video_generation', api_key_id: null, api_key_name: null, namespace_id: null, provider_job_id: null, credential_id: null, connection_hash: 'synthetic', state: 'uncertain', provider_status: null, context_json: '{}', context_hash: pricingContentHash({}), revision: 0, accepted_at: null, terminal_at: null, last_error: null, poll_owner: null, poll_until: null, next_poll_at: at, created_at: at, updated_at: at }).execute();
      await orphan('intent', 'intent-attempt');
      await ledger.queueSettlement('intent', workspace, 'release');
      expect(await ledger.reconcileDispatched()).toMatchObject({ opened: 0, updated: 0 });
      expect(await ledger.recoveryCases(workspace)).toEqual([]);
    });
    it('prioritizes unseen cases and rotates existing observations under the sweep bound', async () => {
      await orphan('a', 'a-attempt');
      await orphan('b', 'b-attempt');
      await orphan('c', 'c-attempt');
      const now = Date.now();
      for (let i = 0; i < 3; i++) expect(await ledger.reconcileDispatched(1, new Date(now + i * 10))).toMatchObject({ opened: 1 });
      expect(await ledger.recoveryCases(workspace)).toHaveLength(3);
      for (let i = 0; i < 3; i++) expect(await ledger.reconcileDispatched(1, new Date(now + 100 + i * 10))).toMatchObject({ unchanged: 1 });
      const rows = await source.query('SELECT checked_at, revision FROM pricing_recovery_cases');
      expect(rows.every((row: { checked_at: string; revision: number }) => Date.parse(row.checked_at) >= now + 100 && row.revision === 1)).toBe(true);
    });
    it('resolves a review case atomically when the original late terminal decision applies', async () => {
      const id = await orphan();
      await ledger.reconcileDispatched();
      await ledger.queueSettlement(input.id, workspace, 'commit', '1000', input.estimate.report_amount!, 'legacy_logical', { attemptId: id, cost: input.estimate });
      const original = budgets.settleLedger.bind(budgets);
      const fail = jest.spyOn(budgets, 'settleLedger').mockRejectedValueOnce(new Error('synthetic budget outage'));
      await expect(ledger.applySettlement(input.id, workspace)).rejects.toThrow('synthetic budget outage');
      fail.mockImplementation(original);
      expect((await ledger.recoveryCases(workspace))[0].state).toBe('open');
      await ledger.reconcilePending();
      expect(await ledger.recoveryCases(workspace)).toEqual([]);
      const resolved = (await ledger.summary(input.requestId, workspace))!.reservations[0].recovery_case;
      expect(resolved).toMatchObject({ state: 'resolved', revision: 2, resolution_code: 'settlement_applied' });
      await ledger.reconcilePending();
      expect((await ledger.summary(input.requestId, workspace))!.reservations[0].recovery_case).toEqual(resolved);
      fail.mockRestore();
    });

    it('opens review after an isolated writer exits with a dispatch but no durable terminal outcome', async () => {
      await ledger.reserve({ ...input, leaseUntil: new Date(Date.now() - 60000).toISOString() });
      const child = spawnSync(process.execPath, ['-r', require.resolve('ts-node/register'), '-e', `
        require('reflect-metadata');
        const { DataSource } = require('typeorm');
        const { BudgetRule } = require('./src/database/entities/budget-rule.entity');
        const { BudgetService } = require('./src/budget/budget.service');
        const { WorkspaceContextService } = require('./src/workspaces/workspace-context.service');
        const { CostLedgerService } = require('./src/pricing/cost-ledger.service');
        (async () => {
          const source = await new DataSource({ ...JSON.parse(process.env.PRICING_CHILD_DB), entities: [BudgetRule], synchronize: false }).initialize();
          const ledger = new CostLedgerService(source, new BudgetService({}, new WorkspaceContextService(), source.getRepository(BudgetRule)));
          await ledger.beginAttempt(JSON.parse(process.env.PRICING_CHILD_ATTEMPT));
          process.exit(17);
        })().catch(() => process.exit(18));
      `], {
        cwd: process.cwd(), encoding: 'utf8', timeout: 20000,
        env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, NODE_OPTIONS: '--max-old-space-size=512', TS_NODE_TRANSPILE_ONLY: 'true', PRICING_CHILD_DB: JSON.stringify(source.options), PRICING_CHILD_ATTEMPT: JSON.stringify({ id: 'lost-attempt', requestId: input.requestId, workspace, reservationId: input.id, target, feeSource: 'provider', dispatchedAt: new Date().toISOString(), priceContext: { context: {}, legacyPrice: null } }) },
      });
      expect(child.error).toBeUndefined();
      expect(child.status).toBe(17);
      const afterRestart = new CostLedgerService(source, budgets);
      expect(await afterRestart.recoverUndispatched()).toBe(0);
      expect(await afterRestart.reconcileDispatched()).toMatchObject({ opened: 1 });
      expect((await afterRestart.recoveryCases(workspace))[0].reason).toBe('attempt_outcome_unknown');
      expect((await current()).currentExact).toBe('0.500000000000000000');
      expect((await afterRestart.summary(input.requestId, workspace))!.amount).toBeNull();
    }, 30000);

    const recoveryActor = { id: 'synthetic-recovery-admin', role: 'admin' as const, workspace_id: workspace, global_admin: false };
    const expire = async () => source.manager.createQueryBuilder().update('pricing_reservations').set({ lease_until: new Date(Date.now() - 60000).toISOString() }).execute();
    const recoveryInput = async (decisions: RecoveryResolutionInput['decisions'], id = 'synthetic-resolution'): Promise<RecoveryResolutionInput> => ({ id, expected_basis_hash: (await ledger.recoveryBasis(input.id, workspace)).basis_hash, reason: 'Synthetic recovery review', confirm: true, decisions });
    const pendingBatch = async (known = false) => {
      const entries = await physicalBatchOutcomes();
      if (known) await ledger.completeAttemptGroup(workspace, entries.map(({ id, cost }) => ({ id, cost })));
      await expire(); await ledger.reconcileDispatched();
      return entries;
    };
    it('previews and releases an unknown hold without inventing free upstream cost', async () => {
      await orphan(); await ledger.reconcileDispatched();
      const request = await recoveryInput([{ reservation_id: input.id, action: 'release' }]);
      const before = await source.query('SELECT * FROM pricing_reservations');
      const preview = await ledger.resolveRecovery(input.id, recoveryActor, request, true);
      expect(preview).toMatchObject({ dry_run: true, budget_only: true, unknown_attempt_ids: ['orphan-attempt'] });
      expect(await source.query('SELECT * FROM pricing_reservations')).toEqual(before);
      expect(await source.query('SELECT * FROM pricing_recovery_decisions')).toHaveLength(0);
      const applied = await ledger.resolveRecovery(input.id, recoveryActor, request);
      expect(applied.changes[0]).toMatchObject({ next_state: 'released', budget_cost_usd: '0.000000000000000000' });
      expect((await ledger.summary(input.requestId, workspace))!).toMatchObject({ amount: null, status: 'pending', pending_attempts: 1, budget_reserved_usd: '0.000000000000000000' });
      expect((await current()).currentExact).toBe('0.000000000000000000');
      expect((await ledger.summary(input.requestId, workspace))!.reservations[0].recovery_case).toMatchObject({ resolution_code: 'operator_budget_resolved' });
      expect(await ledger.resolveRecovery(input.id, recoveryActor, request)).toEqual({ ...applied, replayed: true });
      expect(await source.query("SELECT * FROM pricing_audit_events WHERE action = 'cost.recovery_resolution'")).toHaveLength(1);
    });
    it('commits the explicit known logical winner, not all provider attempts', async () => {
      const id = await orphan(); await ledger.completeAttempt(id, workspace, input.estimate); await ledger.reconcileDispatched();
      const request = await recoveryInput([{ reservation_id: input.id, action: 'commit', budget_attempt_id: id }]);
      expect((await ledger.resolveRecovery(input.id, recoveryActor, request)).changes[0]).toMatchObject({ budget_cost_usd: '0.001000000000000000', budget_tokens: '1000', budget_attempt_id: id });
      expect((await current()).currentExact).toBe('0.001000000000000000');
    });
    it('rejects inferred unknown debits, arbitrary amounts and mismatching logical tokens', async () => {
      const id = await orphan(); await ledger.reconcileDispatched();
      await expect(ledger.resolveRecovery(input.id, recoveryActor, await recoveryInput([{ reservation_id: input.id, action: 'commit', budget_attempt_id: id }]))).rejects.toMatchObject({ status: 409 });
      const service = new PricingResolutionService(ledger);
      expect(() => service.resolve(recoveryActor, input.id, { ...( { id: 'id', expected_basis_hash: 'a'.repeat(64), reason: 'test', confirm: true } ), decisions: [{ reservation_id: input.id, action: 'commit', cost_usd: '0' }] }, false)).toThrow();
      await ledger.completeAttempt(id, workspace, input.estimate);
      await expect(ledger.resolveRecovery(input.id, recoveryActor, await recoveryInput([{ reservation_id: input.id, action: 'commit', budget_attempt_id: id, logical_tokens: '0' }]))).rejects.toMatchObject({ status: 409 });
    });
    it('retains logical-cache budget cost separately from its confirmed upstream zero', async () => {
      await ledger.reserve({ ...input, budgetBasis: 'legacy_logical_cache', leaseUntil: new Date(Date.now() - 60000).toISOString() });
      await ledger.beginAttempt({ id: 'cache', requestId: input.requestId, workspace, reservationId: input.id, target, feeSource: 'local_cache', dispatchedAt: new Date().toISOString(), priceContext: { context: {}, legacyPrice: null } });
      const free = { ...input.estimate, status: 'free' as const, amount: '0', report_amount: '0', known_subtotal: '0', report_known_subtotal: '0', rounding_adjustment: '0', report_rounding_adjustment: '0', lines: [] };
      await ledger.completeAttempt('cache', workspace, free); await ledger.reconcileDispatched();
      await ledger.resolveRecovery(input.id, recoveryActor, await recoveryInput([{ reservation_id: input.id, action: 'commit', budget_attempt_id: 'cache' }]));
      expect(await ledger.summary(input.requestId, workspace)).toMatchObject({ amount: '0.000000000000000000', budget_committed_usd: '0.001000000000000000' });
    });
    it('requires a fresh CAS after late evidence and refuses a resumed live lease', async () => {
      const id = await orphan(); await ledger.reconcileDispatched();
      const old = await recoveryInput([{ reservation_id: input.id, action: 'release' }]);
      await ledger.completeAttempt(id, workspace, input.estimate);
      await expect(ledger.resolveRecovery(input.id, recoveryActor, old)).rejects.toMatchObject({ status: 409 });
      await ledger.renew(input.id, workspace, input.leaseOwner, new Date(Date.now() + 60000).toISOString());
      await expect(ledger.resolveRecovery(input.id, recoveryActor, await recoveryInput([{ reservation_id: input.id, action: 'release' }]))).rejects.toThrow('lease_active');
    });
    it('does not let observation polling alone invalidate a prepared proposal', async () => {
      await orphan(); await ledger.reconcileDispatched();
      const request = await recoveryInput([{ reservation_id: input.id, action: 'release' }]);
      await ledger.reconcileDispatched(100, new Date(Date.now() + 100));
      expect((await ledger.recoveryBasis(input.id, workspace)).basis_hash).toBe(request.expected_basis_hash);
      await ledger.resolveRecovery(input.id, recoveryActor, request);
    });
    it('only applies an existing immutable intent instead of replacing it', async () => {
      const id = await orphan(); await ledger.reconcileDispatched();
      await ledger.queueSettlement(input.id, workspace, 'commit', '1000', '0.001', 'legacy_logical', { attemptId: id, cost: input.estimate });
      await expect(ledger.resolveRecovery(input.id, recoveryActor, await recoveryInput([{ reservation_id: input.id, action: 'release' }]))).rejects.toThrow('only be applied');
      const result = await ledger.resolveRecovery(input.id, recoveryActor, await recoveryInput([{ reservation_id: input.id, action: 'apply_recorded' }]));
      expect(result.unknown_attempt_ids).toEqual([]);
      expect((await current()).currentExact).toBe('0.001000000000000000');
    });
    it('rejects foreign scope, non-admin mutation and reused identities with another body or actor', async () => {
      await orphan(); await ledger.reconcileDispatched();
      await expect(ledger.recoveryBasis(input.id, 'foreign')).rejects.toMatchObject({ status: 404 });
      const request = await recoveryInput([{ reservation_id: input.id, action: 'release' }]);
      await expect(ledger.resolveRecovery(input.id, { ...recoveryActor, role: 'operator' }, request)).rejects.toMatchObject({ status: 403 });
      await ledger.resolveRecovery(input.id, recoveryActor, request);
      await expect(ledger.resolveRecovery(input.id, { ...recoveryActor, id: 'another-admin' }, request)).rejects.toMatchObject({ status: 409 });
      await expect(ledger.resolveRecovery(input.id, recoveryActor, { ...request, reason: 'different' })).rejects.toMatchObject({ status: 409 });
    });
    it('serializes two different operator proposals on the same fresh basis', async () => {
      await orphan(); await ledger.reconcileDispatched();
      const request = await recoveryInput([{ reservation_id: input.id, action: 'release' }]);
      const result = await Promise.allSettled([ledger.resolveRecovery(input.id, recoveryActor, request), new CostLedgerService(source, budgets).resolveRecovery(input.id, recoveryActor, { ...request, id: 'other-resolution' })]);
      expect(result.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1);
      expect(result.find((entry) => entry.status === 'rejected')).toMatchObject({ reason: { status: 409 } });
      expect(await source.query('SELECT * FROM pricing_recovery_decisions')).toHaveLength(1);
    });
    it('refuses partial physical-group decisions and preserves conserved known shares', async () => {
      const entries = await pendingBatch(true);
      const decisions = entries.map((entry, index) => ({ reservation_id: index ? 'reservation-b' : input.id, action: 'commit' as const, budget_attempt_id: entry.id }));
      const request = await recoveryInput(decisions);
      await expect(ledger.resolveRecovery(input.id, recoveryActor, { ...request, decisions: decisions.slice(0, 1) })).rejects.toThrow('every unresolved hold');
      await ledger.resolveRecovery(input.id, recoveryActor, request);
      expect((await current()).currentExact).toBe('0.001000000000000000');
      expect(await source.query('SELECT * FROM pricing_recovery_decisions')).toHaveLength(2);
      expect((await ledger.summary('request-a', workspace))!.amount).toBe('0.000500000000000000');
      expect((await ledger.summary('request-b', workspace))!.amount).toBe('0.000500000000000000');
    });
    it('persists one pre-dispatch manifest and detects tampered allocation weights', async () => {
      await pendingBatch();
      const rows = await source.query('SELECT * FROM pricing_batch_manifests');
      expect(rows).toHaveLength(1);
      const before = await ledger.recoveryBasis(input.id, workspace);
      expect(before.request_ids).toEqual(['request-a', 'request-b']);
      const body = JSON.parse(rows[0].manifest_json); body.members[0].weight = '999';
      await source.manager.createQueryBuilder().update('pricing_batch_manifests').set({ manifest_json: JSON.stringify(body) }).where('physical_attempt_id = :id', { id: 'physical-test' }).execute();
      await expect(ledger.recoveryBasis(input.id, workspace)).rejects.toThrow('manifest integrity');
    });
    it('retains a late physical cost after operator release without applying the superseded budget decision', async () => {
      const entries = await pendingBatch();
      const request = await recoveryInput([{ reservation_id: input.id, action: 'release' }, { reservation_id: 'reservation-b', action: 'release' }]);
      await ledger.resolveRecovery(input.id, recoveryActor, request);
      const intents = await source.query('SELECT * FROM pricing_settlement_intents ORDER BY reservation_id');
      await ledger.completeAttemptGroup(workspace, entries);
      expect(await source.query('SELECT * FROM pricing_settlement_intents ORDER BY reservation_id')).toEqual(intents);
      expect((await current()).currentExact).toBe('0.000000000000000000');
      expect((await ledger.summary('request-a', workspace))!.amount).toBe('0.000500000000000000');
      expect((await ledger.summary('request-b', workspace))!.amount).toBe('0.000500000000000000');
    });
    it('rolls back all member writes if the required resolution audit fails', async () => {
      await pendingBatch();
      const request = await recoveryInput([{ reservation_id: input.id, action: 'release' }, { reservation_id: 'reservation-b', action: 'release' }]);
      const execute = InsertQueryBuilder.prototype.execute;
      const fail = jest.spyOn(InsertQueryBuilder.prototype, 'execute').mockImplementation(function (this: InsertQueryBuilder<BudgetRule>) {
        if (this.expressionMap.mainAlias?.tablePath === 'pricing_audit_events') return Promise.reject(new Error('synthetic resolution audit failure'));
        return execute.call(this);
      });
      try { await expect(ledger.resolveRecovery(input.id, recoveryActor, request)).rejects.toThrow('synthetic resolution audit failure'); } finally { fail.mockRestore(); }
      expect((await current()).currentExact).toBe('1.000000000000000000');
      expect(await source.query('SELECT * FROM pricing_settlement_intents')).toHaveLength(0);
      expect(await source.query('SELECT * FROM pricing_recovery_decisions')).toHaveLength(0);
      expect((await ledger.recoveryCases(workspace)).every((entry) => entry.state === 'open')).toBe(true);
    });
    it('retires only an audited superseded local budget decision, never the usage receipt', async () => {
      await orphan(); await ledger.reconcileDispatched();
      const outcome = { type: 'settlement' as const, workspace, reservationId: input.id, payload: { kind: 'commit' as const, tokens: '1000', cost_usd: '0.5', budget_basis: 'legacy_logical', receipt: null } };
      expect(await ledger.outcomeSuperseded(outcome)).toBe(false);
      await ledger.resolveRecovery(input.id, recoveryActor, await recoveryInput([{ reservation_id: input.id, action: 'release' }]));
      expect(await ledger.outcomeSuperseded(outcome)).toBe(true);
      expect(await ledger.outcomeSuperseded({ ...outcome, workspace: 'foreign' })).toBe(false);
      expect(await ledger.outcomeSuperseded({ type: 'attempt', workspace, reservationId: input.id, attemptId: 'orphan-attempt', cost: input.estimate, errorCode: null })).toBe(false);
      await source.manager.createQueryBuilder().update('pricing_recovery_decisions').set({ payload_hash: 'a'.repeat(64) }).where('reservation_id = :id', { id: input.id }).execute();
      expect(await ledger.outcomeSuperseded(outcome)).toBe(false);
    });

    it('includes linked effective-cost revisions elsewhere in the recovery group in its fresh CAS', async () => {
      await pendingBatch(true);
      await ledger.reserve({ ...input, id: 'prior-hold' });
      await ledger.beginAttempt({ id: 'prior-attempt', requestId: input.requestId, workspace, reservationId: 'prior-hold', target, feeSource: 'provider', dispatchedAt: new Date().toISOString(), priceContext: { context: {}, legacyPrice: null } });
      await ledger.completeAttempt('prior-attempt', workspace, input.estimate);
      await ledger.settle('prior-hold', workspace, 'commit', '1000', '0.001', 'legacy_logical', { attemptId: 'prior-attempt', cost: input.estimate });
      const request = await recoveryInput([{ reservation_id: input.id, action: 'release' }, { reservation_id: 'reservation-b', action: 'release' }]);
      const changed = (await prices.restoreRequest(input.requestId, workspace)).quote(target, tokens({ input_tokens: 2000, output_tokens: 0 })).cost;
      await ledger.adjustAttempt({ id: 'prior-adjustment', attemptId: 'prior-attempt', workspace, expectedCostHash: pricingContentHash(input.estimate), cost: changed, actorId: recoveryActor.id, reason: 'Synthetic late usage', source: 'reconciliation' });
      await expect(ledger.resolveRecovery(input.id, recoveryActor, request)).rejects.toMatchObject({ status: 409 });
      const fresh = await recoveryInput(request.decisions);
      expect(fresh.expected_basis_hash).not.toBe(request.expected_basis_hash);
    });
    it('follows transitive physical membership and requires the entire connected group', async () => {
      for (const name of ['request-a', 'request-b', 'request-c']) {
        if (name !== input.requestId) await prices.capture({ request_id: name, workspace_id: workspace, report_currency: 'USD' });
        await ledger.reserve({ ...input, id: name === input.requestId ? input.id : `hold-${name}`, requestId: name });
      }
      for (const [index, requests] of [['request-a', 'request-b'], ['request-b', 'request-c']].entries()) {
        const members = requests.map((request, at) => ({ request_id: request, reservation_id: request === input.requestId ? input.id : `hold-${request}`, input_start: at, input_count: 1, weight: '1', weight_basis: 'text_token_estimate' as const }));
        const attempts = members.map((member, at) => ({ id: `connected-${index}-${at}`, requestId: member.request_id, workspace, reservationId: member.reservation_id, target, feeSource: 'provider' as const, dispatchedAt: new Date().toISOString(), priceContext: { context: {}, legacyPrice: null, batch: { batch_id: `group-${index}`, physical_attempt_id: `physical-${index}`, member_index: at, request_ids: requests } } }));
        await ledger.beginAttemptGroup(attempts, members);
      }
      await expire(); await ledger.reconcileDispatched();
      const basis = await ledger.recoveryBasis(input.id, workspace);
      expect(basis.request_ids).toEqual(['request-a', 'request-b', 'request-c']);
      const request = await recoveryInput(basis.reservations.map((row) => ({ reservation_id: row.id, action: 'release' })));
      await expect(ledger.resolveRecovery(input.id, recoveryActor, { ...request, decisions: request.decisions.slice(0, 2) })).rejects.toMatchObject({ status: 409 });
      expect((await ledger.resolveRecovery(input.id, recoveryActor, request)).unknown_attempt_ids).toHaveLength(4);
      expect((await current()).currentExact).toBe('0.000000000000000000');
    });
    it('rolls back the first member if the second budget application fails', async () => {
      await pendingBatch(true);
      const request = await recoveryInput([{ reservation_id: input.id, action: 'release' }, { reservation_id: 'reservation-b', action: 'release' }]);
      const original = budgets.settleLedger.bind(budgets); let count = 0;
      const fail = jest.spyOn(budgets, 'settleLedger').mockImplementation(async (...args) => { if (++count === 2) throw new Error('synthetic second-member failure'); return original(...args); });
      try { await expect(ledger.resolveRecovery(input.id, recoveryActor, request)).rejects.toThrow('second-member failure'); } finally { fail.mockRestore(); }
      expect((await current()).currentExact).toBe('1.000000000000000000');
      expect(await source.query('SELECT * FROM pricing_recovery_decisions')).toHaveLength(0);
      expect(await source.query('SELECT * FROM pricing_settlement_intents')).toHaveLength(0);
    });

    it('replays an operator decision after an isolated child exits after commit', async () => {
      await orphan(); await ledger.reconcileDispatched();
      const request = await recoveryInput([{ reservation_id: input.id, action: 'release' }]);
      const child = spawnSync(process.execPath, ['-r', require.resolve('ts-node/register'), '-e', `
        require('reflect-metadata');
        const { DataSource } = require('typeorm');
        const { BudgetRule } = require('./src/database/entities/budget-rule.entity');
        const { BudgetService } = require('./src/budget/budget.service');
        const { WorkspaceContextService } = require('./src/workspaces/workspace-context.service');
        const { CostLedgerService } = require('./src/pricing/cost-ledger.service');
        (async () => {
          const source = await new DataSource({ ...JSON.parse(process.env.PRICING_CHILD_DB), entities: [BudgetRule], synchronize: false }).initialize();
          const ledger = new CostLedgerService(source, new BudgetService({}, new WorkspaceContextService(), source.getRepository(BudgetRule)));
          await ledger.resolveRecovery('reservation-a', JSON.parse(process.env.PRICING_CHILD_ACTOR), JSON.parse(process.env.PRICING_CHILD_PROPOSAL));
          process.exit(17);
        })().catch(() => process.exit(18));
      `], { cwd: process.cwd(), encoding: 'utf8', timeout: 20000, env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, NODE_OPTIONS: '--max-old-space-size=512', TS_NODE_TRANSPILE_ONLY: 'true', PRICING_CHILD_DB: JSON.stringify(source.options), PRICING_CHILD_ACTOR: JSON.stringify(recoveryActor), PRICING_CHILD_PROPOSAL: JSON.stringify(request) } });
      expect({ status: child.status, error: child.error?.message, stderr: child.stderr }).toMatchObject({ status: 17 });
      expect((await new CostLedgerService(source, budgets).resolveRecovery(input.id, recoveryActor, request)).replayed).toBe(true);
      expect(await source.query("SELECT * FROM pricing_audit_events WHERE action = 'cost.recovery_resolution'")).toHaveLength(1);
      expect((await current()).currentExact).toBe('0.000000000000000000');
    }, 30000);

    it('bounds membership and correction-history retrieval in the database query', async () => {
      await orphan(); await ledger.reconcileDispatched();
      const original = SelectQueryBuilder.prototype.getRawMany;
      let membership = 0, history = 0;
      const inspect = jest.spyOn(SelectQueryBuilder.prototype, 'getRawMany').mockImplementation(function (this: SelectQueryBuilder<ObjectLiteral>) {
        const alias = this.expressionMap.mainAlias;
        const memberQuery = alias?.name === 'r' && this.expressionMap.wheres.some((entry) => typeof entry.condition === 'string' && entry.condition.includes('r.request_id IN'));
        if (memberQuery || alias?.name === 'h') {
          expect(this.expressionMap.limit).toBeGreaterThan(0);
          expect(this.expressionMap.limit).toBeLessThanOrEqual(4097);
          if (alias.name === 'r') membership++; else history++;
        }
        return original.call(this);
      });
      try { await ledger.recoveryBasis(input.id, workspace); } finally { inspect.mockRestore(); }
      expect(membership).toBeGreaterThan(0); expect(history).toBe(2);
    });

    it('keeps budget-resolved unknown fees in the paginated unresolved-cost inventory', async () => {
      const attemptId = await orphan(); await ledger.reconcileDispatched();
      await ledger.resolveRecovery(input.id, recoveryActor, await recoveryInput([{ reservation_id: input.id, action: 'release' }]));
      const before = await source.query('SELECT * FROM pricing_budget_effects');
      expect((await ledger.recoveryInventory(workspace, { view: 'open', limit: 20 })).items).toHaveLength(0);
      const unknown = await ledger.recoveryInventory(workspace, { view: 'unresolved_cost', limit: 20 });
      expect(unknown.items).toHaveLength(1);
      expect(unknown.items[0]).toMatchObject({ budget_state: 'released', supplier_state: 'unknown', request_amount_usd: null });
      expect(unknown.items[0]).not.toHaveProperty('evidence_json');
      await ledger.completeAttempt(attemptId, workspace, input.estimate);
      expect((await ledger.recoveryInventory(workspace, { view: 'unresolved_cost', limit: 20 })).items).toHaveLength(0);
      expect((await ledger.recoveryInventory(workspace, { view: 'resolved', limit: 20 })).items[0]).toMatchObject({ supplier_state: 'known', request_amount_usd: '0.001000000000000000' });
      expect(await source.query('SELECT * FROM pricing_budget_effects')).toEqual(before);
    });
    it('uses scoped keyset cursors without skipping filtered candidates', async () => {
      for (let index = 0; index < 4; index++) {
        const requestId = `inventory-${index}`, reservationId = `hold-${index}`;
        await prices.capture({ request_id: requestId, workspace_id: workspace, report_currency: 'USD' });
        await ledger.reserve({ ...input, requestId, id: reservationId, leaseUntil: new Date(Date.now() - 60000).toISOString() });
        await ledger.beginAttempt({ id: `attempt-${index}`, requestId, workspace, reservationId, target, feeSource: 'provider', dispatchedAt: new Date().toISOString(), priceContext: { context: {}, legacyPrice: null } });
        if (index % 2 === 0) await ledger.completeAttempt(`attempt-${index}`, workspace, input.estimate);
      }
      await ledger.reconcileDispatched();
      await source.manager.createQueryBuilder().update('pricing_recovery_cases').set({ created_at: '2026-09-25T00:00:00.000Z' }).execute();
      const first = await ledger.recoveryInventory(workspace, { view: 'all', limit: 2 });
      expect(first.items.map((row) => row.reservation_id)).toEqual(['hold-0', 'hold-1']);
      const second = await ledger.recoveryInventory(workspace, { view: 'all', limit: 2, cursor: first.next_cursor! });
      expect(second.items.map((row) => row.reservation_id)).toEqual(['hold-2', 'hold-3']);
      expect(second.next_cursor).toBeNull();
      const unknown = await ledger.recoveryInventory(workspace, { view: 'unresolved_cost', limit: 1 });
      expect(unknown.items[0].reservation_id).toBe('hold-1'); expect(unknown.scanned).toBe(2);
      const last = await ledger.recoveryInventory(workspace, { view: 'unresolved_cost', limit: 1, cursor: unknown.next_cursor! });
      expect(last.items[0].reservation_id).toBe('hold-3'); expect(last.next_cursor).toBeNull();
      await expect(ledger.recoveryInventory('foreign', { view: 'all', limit: 2, cursor: first.next_cursor! })).rejects.toMatchObject({ status: 400 });
      await expect(ledger.recoveryInventory(workspace, { view: 'open', limit: 2, cursor: first.next_cursor! })).rejects.toMatchObject({ status: 400 });
      await expect(ledger.recoveryInventory(workspace, { view: 'all', limit: 20, cursor: 'invalid' })).rejects.toMatchObject({ status: 400 });
      expect((await ledger.recoveryInventory('foreign', { view: 'all', limit: 20 })).items).toEqual([]);
    });
    it('reports invalid evidence as unresolved rather than zero in the recovery inventory', async () => {
      const id = await orphan(); await ledger.completeAttempt(id, workspace, input.estimate); await ledger.reconcileDispatched();
      await source.manager.createQueryBuilder().update('pricing_attempts').set({ cost_hash: 'invalid' }).where('id = :id', { id }).execute();
      const page = await ledger.recoveryInventory(workspace, { view: 'unresolved_cost', limit: 20 });
      expect(page.items[0]).toMatchObject({ supplier_state: 'evidence_invalid', request_amount_usd: null });
      expect((await current()).currentExact).toBe('0.500000000000000000');
    });
    it('verifies read-only resolution acknowledgements and rejects wrong scope or corrupted links', async () => {
      await orphan(); await ledger.reconcileDispatched();
      const request = await recoveryInput([{ reservation_id: input.id, action: 'release' }]);
      await expect(ledger.recoveryResolutionStatus(input.id, workspace, request.id)).rejects.toMatchObject({ status: 404 });
      const resolved = await ledger.resolveRecovery(input.id, recoveryActor, request);
      const before = await source.query('SELECT * FROM pricing_budget_effects');
      expect(await ledger.recoveryResolutionStatus(input.id, workspace, request.id)).toEqual({ recorded: true, actor_id: recoveryActor.id, result: resolved });
      await expect(ledger.recoveryResolutionStatus(input.id, 'foreign', request.id)).rejects.toMatchObject({ status: 404 });
      await expect(ledger.recoveryResolutionStatus('wrong-anchor', workspace, request.id)).rejects.toMatchObject({ status: 404 });
      expect(await source.query('SELECT * FROM pricing_budget_effects')).toEqual(before);
      await source.manager.createQueryBuilder().update('pricing_recovery_decisions').set({ payload_hash: 'invalid' }).where('reservation_id = :id', { id: input.id }).execute();
      await expect(ledger.recoveryResolutionStatus(input.id, workspace, request.id)).rejects.toMatchObject({ status: 409 });
    });

    it("publishes budget thresholds only after durable ledger effects and never repeats them on idempotent replay", async () => {
      const rules = source.getRepository(BudgetRule);
      const rule = (await rules.find())[0];
      await rules.update(rule.id, { limit_value: 1, alert_threshold: 0.5 });
      const alerts = { emit: jest.fn() };
      budgets = new BudgetService(
        mockConfigService(),
        new WorkspaceContextService(),
        rules,
        alerts as unknown as AlertService,
      );
      ledger = new CostLedgerService(source, budgets);
      const fail = jest
        .spyOn(
          ledger as unknown as {
            effect: (...args: unknown[]) => Promise<void>;
          },
          "effect",
        )
        .mockRejectedValueOnce(new Error("synthetic effect insert failure"));
      const high = { ...input, costUsd: "0.9" };
      try {
        await expect(ledger.reserve(high)).rejects.toThrow(
          "effect insert failure",
        );
      } finally {
        fail.mockRestore();
      }
      expect(alerts.emit).not.toHaveBeenCalled();
      expect((await current()).current).toBe(0);
      await ledger.reserve(high);
      expect(alerts.emit).toHaveBeenCalledTimes(1);
      await ledger.reserve(high);
      await ledger.settle(high.id, workspace, "commit", "1000", "0.9");
      await ledger.settle(high.id, workspace, "commit", "1000", "0.9");
      expect(alerts.emit).toHaveBeenCalledTimes(1);
      expect((await current()).currentExact).toBe("0.900000000000000000");
      expect(alerts.emit.mock.calls[0][0]).toMatchObject({
        type: "budget_threshold",
        details: {
          workspace_id: workspace,
          current_exact: "0.900000000000000000",
        },
      });
    });

    const repriceUsage = async (inputCount?: number, outputCount = 0) =>
      (await prices.restoreRequest(input.requestId, workspace)).quote(
        target,
        tokens({ input_tokens: inputCount, output_tokens: outputCount }),
      ).cost;
    const finishAdjustable = async (
      cost: CostComputation = input.estimate,
      kind: "commit" | "release" = "commit",
    ) => {
      await ledger.reserve(input);
      await ledger.beginAttempt({
        id: "adjustable-attempt",
        requestId: input.requestId,
        workspace,
        reservationId: input.id,
        target,
        feeSource: "provider",
        dispatchedAt: new Date().toISOString(),
        priceContext: { context: {}, legacyPrice: null },
      });
      await ledger.completeAttempt("adjustable-attempt", workspace, cost);
      if (kind === "commit")
        await ledger.settle(
          input.id,
          workspace,
          "commit",
          cost.usage.quantities.total_input_tokens?.value ?? "1000",
          cost.report_amount ?? "0.5",
          "legacy_logical",
          { attemptId: "adjustable-attempt", cost },
        );
      else await ledger.settle(input.id, workspace, "release");
      return {
        id: "adjustment-a",
        attemptId: "adjustable-attempt",
        workspace,
        expectedCostHash: pricingContentHash(cost),
        cost: await repriceUsage(2000),
        reason: "Synthetic final usage correction",
        actorId: "system:test",
        source: "provider_usage" as const,
      };
    };

    it("appends an immutable cost correction and applies its exact budget delta only once", async () => {
      const adjustment = await finishAdjustable();
      const original = (
        await source.query("SELECT * FROM pricing_attempts")
      )[0];
      const intent = (
        await source.query("SELECT * FROM pricing_settlement_intents")
      )[0];
      const [first, duplicate] = await Promise.all([
        ledger.adjustAttempt(adjustment),
        ledger.adjustAttempt(adjustment),
      ]);
      expect(first).toEqual(duplicate);
      expect(first.application).toMatchObject({
        revision: 1,
        budget_state: "applied",
        cost_delta: "0.001000000000000000",
        tokens_delta: "1000",
      });
      expect((await current()).currentExact).toBe("0.002000000000000000");
      expect((await source.query("SELECT * FROM pricing_attempts"))[0]).toEqual(
        original,
      );
      expect(
        (await source.query("SELECT * FROM pricing_settlement_intents"))[0],
      ).toEqual(intent);
      const summary = await ledger.summary(input.requestId, workspace);
      expect(summary?.amount).toBe("0.002000000000000000");
      expect(summary?.budget_committed_usd).toBe(summary?.amount);
      expect(summary?.attempts[0].cost?.report_amount).toBe("0.001000000");
      expect(summary?.attempts[0].effective_cost?.report_amount).toBe(
        "0.002000000",
      );
      expect(
        await source.query(
          "SELECT * FROM pricing_audit_events WHERE action = 'cost.adjustment'",
        ),
      ).toHaveLength(1);
      await expect(
        ledger.adjustAttempt({
          ...adjustment,
          workspace: "not-this-workspace",
        }),
      ).rejects.toMatchObject({ status: 404 });
    });

    it("fences competing corrections and rejects edits to the frozen rate identity", async () => {
      const adjustment = await finishAdjustable();
      await expect(
        ledger.adjustAttempt({
          ...adjustment,
          cost: { ...adjustment.cost, version_id: "current-price-instead" },
        }),
      ).rejects.toMatchObject({ status: 409 });
      const results = await Promise.allSettled([
        ledger.adjustAttempt(adjustment),
        ledger.adjustAttempt({
          ...adjustment,
          id: "adjustment-b",
          cost: await repriceUsage(3000),
        }),
      ]);
      expect(
        results.filter((entry) => entry.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        results.filter((entry) => entry.status === "rejected"),
      ).toHaveLength(1);
      expect(
        await source.query("SELECT * FROM pricing_cost_adjustments"),
      ).toHaveLength(1);
      expect((await current()).currentExact).toBe(
        (await ledger.summary(input.requestId, workspace))?.amount,
      );
    });

    it("refunds only the original budget epoch after a new day or manual reset", async () => {
      const adjustment = await finishAdjustable(await repriceUsage(2000));
      const epoch = (await current()).periodStart;
      await source
        .getRepository(BudgetRule)
        .update(
          { workspace_id: workspace },
          { current_value: 5, period_start: new Date(Date.now() + 86400000) },
        );
      const result = await ledger.adjustAttempt({
        ...adjustment,
        cost: await repriceUsage(500),
      });
      expect(result.application.cost_delta).toBe("-0.001500000000000000");
      expect((await current()).currentExact).toBe("5.000000000000000000");
      const old = await source
        .createQueryBuilder()
        .select("b.amount_decimal", "amount_decimal")
        .from("pricing_budget_balances", "b")
        .where("b.workspace_id = :workspace AND b.period_start = :period", {
          workspace,
          period: new Date(epoch).toISOString(),
        })
        .getRawOne();
      expect(old.amount_decimal).toBe("0.000500000000000000");
    });

    it("corrects a reserved estimate when missing usage becomes known, without treating the old unknown cost as zero", async () => {
      const adjustment = await finishAdjustable(await repriceUsage(undefined));
      expect((await current()).currentExact).toBe("0.500000000000000000");
      const result = await ledger.adjustAttempt(adjustment);
      expect(result.application.cost_delta).toBe("-0.498000000000000000");
      expect((await current()).currentExact).toBe("0.002000000000000000");
      expect(
        (await ledger.summary(input.requestId, workspace))?.unknown_attempts,
      ).toBe(0);
    });

    it("retains budget evidence for an unknown correction and resolves it with a later known revision", async () => {
      const adjustment = await finishAdjustable();
      const unknown = await ledger.adjustAttempt({
        ...adjustment,
        cost: await repriceUsage(undefined),
      });
      expect(unknown.application.budget_state).toBe("pending");
      expect((await current()).currentExact).toBe("0.001000000000000000");
      expect(
        (await ledger.summary(input.requestId, workspace))
          ?.pending_budget_adjustments,
      ).toBe(1);
      await ledger.adjustAttempt({
        ...adjustment,
        id: "known-revision",
        expectedCostHash: unknown.cost_hash,
      });
      const summary = await ledger.summary(input.requestId, workspace);
      expect(summary?.pending_budget_adjustments).toBe(0);
      expect(summary?.attempts[0].adjustments).toHaveLength(2);
      expect(summary?.budget_committed_usd).toBe("0.002000000000000000");
    });

    it("does not charge a released logical reservation when late upstream evidence is corrected", async () => {
      const adjustment = await finishAdjustable(input.estimate, "release");
      const result = await ledger.adjustAttempt(adjustment);
      expect(result.application.budget_state).toBe("not_applicable");
      expect((await current()).currentExact).toBe("0.000000000000000000");
      expect((await ledger.summary(input.requestId, workspace))?.amount).toBe(
        "0.002000000000000000",
      );
    });

    it("rolls the budget delta and correction back if its audit cannot be persisted", async () => {
      const adjustment = await finishAdjustable();
      const fail = jest
        .spyOn(
          ledger as unknown as {
            auditAdjustment: (...args: unknown[]) => Promise<void>;
          },
          "auditAdjustment",
        )
        .mockRejectedValueOnce(new Error("synthetic audit outage"));
      try {
        await expect(ledger.adjustAttempt(adjustment)).rejects.toThrow(
          "synthetic audit outage",
        );
      } finally {
        fail.mockRestore();
      }
      expect(
        await source.query("SELECT * FROM pricing_cost_adjustments"),
      ).toHaveLength(0);
      expect(
        await source.query("SELECT * FROM pricing_adjustment_applications"),
      ).toHaveLength(0);
      expect((await current()).currentExact).toBe("0.001000000000000000");
      await ledger.adjustAttempt(adjustment);
      expect((await current()).currentExact).toBe("0.002000000000000000");
    });

    it("upgrades a populated 003 outbox without altering its frozen terminal intent", async () => {
      await ledger.reserve(input);
      await ledger.queueSettlement(
        input.id,
        workspace,
        "commit",
        "10",
        "0.001",
      );
      const before = await source.query(
        "SELECT * FROM pricing_settlement_intents",
      );
      const runner = source.createQueryRunner();
      try {
        for (const step of [...PRICING_MIGRATIONS.slice(3)].reverse()) {
          for (const index of [...(step.indexes ?? [])].reverse()) await runner.dropIndex(index.table, index.definition.name!);
          for (const definition of [...step.definitions].reverse())
            await runner.dropTable(definition.name);
          await runner.manager
            .createQueryBuilder()
            .delete()
            .from("pricing_schema_versions")
            .where("id = :id", { id: step.version })
            .execute();
        }
      } finally {
        await runner.release();
      }
      await applyPricingSchema(source);
      expect(
        await source.query("SELECT * FROM pricing_settlement_intents"),
      ).toEqual(before);
      expect((await current()).currentExact).toBe("0.500000000000000000");
      await new CostLedgerService(source, budgets).reconcilePending();
      expect((await current()).currentExact).toBe("0.001000000000000000");
    });

    it("detects a corrupted adjustment application instead of using its altered budget delta", async () => {
      const adjustment = await finishAdjustable();
      await ledger.adjustAttempt(adjustment);
      await source
        .createQueryBuilder()
        .update("pricing_adjustment_applications")
        .set({ cost_delta: "999" })
        .where("adjustment_id = :id AND workspace_id = :workspace", {
          id: adjustment.id,
          workspace,
        })
        .execute();
      await expect(
        ledger.summary(input.requestId, workspace),
      ).rejects.toMatchObject({ status: 409 });
      expect((await current()).currentExact).toBe("0.002000000000000000");
    });

    async function groupedReservations() {
      await ledger.reserve(input);
      await prices.capture({
        request_id: "request-b",
        workspace_id: workspace,
        report_currency: "USD",
      });
      const second = { ...input, id: "reservation-b", requestId: "request-b" };
      await ledger.reserve(second);
      const dispatchedAt = new Date().toISOString();
      const attempts = [input, second].map((reservation, index) => ({
        id: `batch-attempt-${index}`,
        requestId: reservation.requestId,
        workspace,
        reservationId: reservation.id,
        target,
        feeSource: "provider" as const,
        dispatchedAt,
        priceContext: { context: {}, legacyPrice: null },
      }));
      return { second, attempts };
    }

    async function physicalBatchOutcomes() {
      const { attempts } = await groupedReservations();
      const members = attempts.map((entry, index) => ({
        request_id: entry.requestId,
        reservation_id: entry.reservationId,
        input_start: index,
        input_count: 1,
        weight: "1",
        weight_basis: "text_token_estimate" as const,
      }));
      const prepared = attempts.map((entry, index) => ({
        ...entry,
        priceContext: {
          ...entry.priceContext,
          batch: {
            batch_id: "batch-test",
            physical_attempt_id: "physical-test",
            member_index: index,
            request_ids: members.map((member) => member.request_id),
          },
        },
      }));
      await ledger.beginAttemptGroup(prepared, members);
      const allocation = allocateBatchCost(
        "batch-test",
        input.estimate,
        members,
      );
      return prepared.map((entry, index) => {
        const cost = batchShareCost(allocation, index, "physical-test");
        return {
          id: entry.id,
          cost,
          settlement: {
            kind: "commit" as const,
            tokens: "500",
            cost_usd: cost.report_amount!,
            budget_basis: "batch-allocated",
            receipt: { attemptId: entry.id, cost },
          },
        };
      });
    }

    async function batchForCorrection(
      options: {
        released?: number;
        missing?: boolean;
        legacyWinner?: boolean;
      } = {},
    ) {
      const entries = await physicalBatchOutcomes();
      if (options.missing) {
        const allocation = allocateBatchCost(
          "batch-test",
          await repriceUsage(undefined),
          entries[0].cost.batch!.members,
        );
        entries.forEach((entry, index) => {
          entry.cost = batchShareCost(allocation, index, "physical-test");
          entry.settlement.receipt.cost = entry.cost;
        });
      }
      const completed = entries.map((entry, index) => ({
        ...entry,
        settlement:
          index === options.released
            ? {
                ...entry.settlement,
                kind: "release" as const,
                tokens: "0",
                cost_usd: "0",
              }
            : {
                ...entry.settlement,
                receipt: null,
                receipts: [entry.settlement.receipt],
                ...(options.legacyWinner
                  ? {}
                  : { budget_attempt_id: entry.id }),
              },
      }));
      await ledger.completeAttemptGroup(workspace, completed);
      await ledger.reconcilePending();
      const correction: BatchCostAdjustmentInput = {
        id: "batch-correction-a",
        attemptId: entries[0].id,
        workspace,
        expectedPhysicalCostHash: entries[0].cost.batch!.physical_cost_hash,
        physicalCost: await repriceUsage(2000),
        actorId: "synthetic-operator",
        reason: "Synthetic verified batch metering",
        source: "reconciliation",
      };
      return { entries, correction };
    }

    it("corrects all physical batch shares and exact logical budgets atomically with stable idempotent replay", async () => {
      const { entries, correction } = await batchForCorrection();
      const original = await source.query(
        "SELECT * FROM pricing_attempts ORDER BY id",
      );
      const preview = await ledger.adjustBatch(correction, true);
      expect(preview).toMatchObject({ dry_run: true, revision: 1 });
      expect(preview.changes).toHaveLength(2);
      expect(
        await source.query("SELECT * FROM pricing_cost_adjustments"),
      ).toHaveLength(0);
      expect(
        await source.query(
          "SELECT * FROM pricing_audit_events WHERE action = 'cost.batch_adjustment'",
        ),
      ).toHaveLength(0);
      const results = await Promise.all([
        ledger.adjustBatch(correction),
        new CostLedgerService(source, budgets).adjustBatch({
          ...correction,
          attemptId: entries[1].id,
        }),
      ]);
      expect(results.map((result) => result.replayed).sort()).toEqual([
        false,
        true,
      ]);
      expect((await current()).currentExact).toBe("0.002000000000000000");
      expect(
        (await ledger.summary("request-a", workspace))?.budget_committed_usd,
      ).toBe("0.001000000000000000");
      expect(
        await source.query("SELECT * FROM pricing_attempts ORDER BY id"),
      ).toEqual(original);
      expect(
        await source.query("SELECT * FROM pricing_cost_adjustments"),
      ).toHaveLength(2);
      expect(
        await source.query(
          "SELECT * FROM pricing_audit_events WHERE action = 'cost.batch_adjustment'",
        ),
      ).toHaveLength(1);
      const second = await ledger.adjustBatch({
        ...correction,
        id: "batch-correction-b",
        expectedPhysicalCostHash: results[0].physical_cost_hash,
        physicalCost: await repriceUsage(3000),
      });
      expect(second.revision).toBe(2);
      expect((await current()).currentExact).toBe("0.003000000000000000");
      const replay = await ledger.adjustBatch(correction);
      expect(replay.replayed).toBe(true);
      expect(replay.revision).toBe(1);
      expect((await current()).currentExact).toBe("0.003000000000000000");
    });

    it("rolls back every share, effect and projection if the second member or audit write fails", async () => {
      const { correction } = await batchForCorrection();
      const adjust = budgets.adjustLedger.bind(budgets);
      let count = 0;
      const fail = jest
        .spyOn(budgets, "adjustLedger")
        .mockImplementation(async (...args) => {
          if (++count === 2) throw new Error("second correction failed");
          return adjust(...args);
        });
      await expect(ledger.adjustBatch(correction)).rejects.toThrow(
        "second correction",
      );
      fail.mockRestore();
      expect((await current()).currentExact).toBe("0.001000000000000000");
      expect(
        await source.query("SELECT * FROM pricing_cost_adjustments"),
      ).toHaveLength(0);
      expect(
        await source.query("SELECT * FROM pricing_adjustment_applications"),
      ).toHaveLength(0);
      await ledger.adjustBatch(correction);
      expect((await current()).currentExact).toBe("0.002000000000000000");
    });

    it("rolls back the entire batch correction when its final audit insert fails", async () => {
      const { correction } = await batchForCorrection();
      const execute = InsertQueryBuilder.prototype.execute;
      const fail = jest
        .spyOn(InsertQueryBuilder.prototype, "execute")
        .mockImplementation(function (
          this: InsertQueryBuilder<Record<string, unknown>>,
        ) {
          if (
            this.expressionMap.mainAlias?.tablePath ===
              "pricing_audit_events" &&
            (this.expressionMap.valuesSet as { action?: string }).action ===
              "cost.batch_adjustment"
          )
            return Promise.reject(new Error("batch audit unavailable"));
          return execute.call(this);
        });
      try {
        await expect(ledger.adjustBatch(correction)).rejects.toThrow(
          "batch audit unavailable",
        );
      } finally {
        fail.mockRestore();
      }
      expect(
        await source.query("SELECT * FROM pricing_cost_adjustments"),
      ).toHaveLength(0);
      expect(
        await source.query("SELECT * FROM pricing_adjustment_applications"),
      ).toHaveLength(0);
      expect((await current()).currentExact).toBe("0.001000000000000000");
    });

    it("allows exactly one of two competing physical corrections and rejects incomplete prepared membership", async () => {
      const { entries, correction } = await batchForCorrection();
      const competing = {
        ...correction,
        id: "competing-physical",
        physicalCost: await repriceUsage(3000),
      };
      const result = await Promise.allSettled([
        ledger.adjustBatch(correction),
        new CostLedgerService(source, budgets).adjustBatch(competing),
      ]);
      expect(
        result.filter((entry) => entry.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        result.filter((entry) => entry.status === "rejected"),
      ).toHaveLength(1);
      expect(
        await source.query("SELECT * FROM pricing_cost_adjustments"),
      ).toHaveLength(2);
      const row = await source
        .createQueryBuilder()
        .select("a.price_context_json", "price_context_json")
        .from("pricing_attempts", "a")
        .where("a.id = :id", { id: entries[1].id })
        .getRawOne();
      const context = JSON.parse(row.price_context_json);
      context.batch.member_index = 0;
      await source
        .createQueryBuilder()
        .update("pricing_attempts")
        .set({ price_context_json: JSON.stringify(context) })
        .where("id = :id", { id: entries[1].id })
        .execute();
      await expect(ledger.adjustBatch(correction)).rejects.toMatchObject({
        status: 409,
      });
      expect(
        await source.query("SELECT * FROM pricing_cost_adjustments"),
      ).toHaveLength(2);
    });

    it("replays an entire correction idempotently after the applying child process exits", async () => {
      const { correction } = await batchForCorrection();
      const child = spawnSync(
        process.execPath,
        [
          "-r",
          require.resolve("ts-node/register"),
          "-e",
          `
        require('reflect-metadata'); const { DataSource } = require('typeorm');
        const { BudgetRule } = require('./src/database/entities/budget-rule.entity'); const { BudgetService } = require('./src/budget/budget.service');
        const { WorkspaceContextService } = require('./src/workspaces/workspace-context.service'); const { CostLedgerService } = require('./src/pricing/cost-ledger.service');
        (async () => { const source = await new DataSource({ ...JSON.parse(process.env.PRICING_CHILD_DB), entities: [BudgetRule], synchronize: false }).initialize();
          const ledger = new CostLedgerService(source, new BudgetService({}, new WorkspaceContextService(), source.getRepository(BudgetRule)));
          await ledger.adjustBatch(JSON.parse(process.env.PRICING_CHILD_CORRECTION)); process.exit(17);
        })().catch(() => process.exit(18));
      `,
        ],
        {
          cwd: process.cwd(),
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            TMPDIR: process.env.TMPDIR,
            NODE_OPTIONS: "--max-old-space-size=512",
            TS_NODE_TRANSPILE_ONLY: "true",
            PRICING_CHILD_DB: JSON.stringify(source.options),
            PRICING_CHILD_CORRECTION: JSON.stringify(correction),
          },
          encoding: "utf8",
          timeout: 20000,
        },
      );
      expect({ status: child.status, stderr: child.stderr }).toMatchObject({
        status: 17,
      });
      const replay = await new CostLedgerService(source, budgets).adjustBatch(
        correction,
      );
      expect(replay.replayed).toBe(true);
      expect((await current()).currentExact).toBe("0.002000000000000000");
      expect(
        await source.query("SELECT * FROM pricing_cost_adjustments"),
      ).toHaveLength(2);
    }, 30000);

    it("rejects stale, cross-workspace, different-price, changed-membership and reused-id batch corrections", async () => {
      const { entries, correction } = await batchForCorrection();
      await expect(
        ledger.adjustBatch({ ...correction, workspace: "foreign" }),
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        ledger.adjustBatch({
          ...correction,
          physicalCost: { ...correction.physicalCost, version_id: "new-price" },
        }),
      ).rejects.toMatchObject({ status: 409 });
      await expect(
        ledger.adjustBatch({ ...correction, physicalCost: entries[0].cost }),
      ).rejects.toMatchObject({ status: 409 });
      await ledger.adjustBatch(correction);
      await expect(
        ledger.adjustBatch({ ...correction, id: "stale-new-id" }),
      ).rejects.toMatchObject({ status: 409 });
      await expect(
        ledger.adjustBatch({ ...correction, reason: "different reason" }),
      ).rejects.toMatchObject({ status: 409 });
      const other = await repriceUsage(3000);
      await expect(
        ledger.adjustBatch({ ...correction, physicalCost: other }),
      ).rejects.toMatchObject({ status: 409 });
      expect(
        await source.query("SELECT * FROM pricing_cost_adjustments"),
      ).toHaveLength(2);
    });

    it("reconciles unknown physical usage and older unambiguous batch winner intents without double charging", async () => {
      const { correction } = await batchForCorrection({
        missing: true,
        legacyWinner: true,
      });
      const changed = await ledger.adjustBatch(correction);
      expect(
        changed.changes.every(
          (change) => change.adjustment?.application.budget_state === "applied",
        ),
      ).toBe(true);
      expect((await current()).currentExact).toBe("0.002000000000000000");
      expect(
        (await ledger.summary("request-b", workspace))?.unknown_attempts,
      ).toBe(0);
    });

    it("preserves unknown revisions, then resumes exact budget correction from the last charged amount", async () => {
      const { correction } = await batchForCorrection();
      const unknown = await ledger.adjustBatch({
        ...correction,
        physicalCost: await repriceUsage(undefined),
      });
      expect(
        unknown.changes.every(
          (change) => change.adjustment?.application.budget_state === "pending",
        ),
      ).toBe(true);
      expect((await current()).currentExact).toBe("0.001000000000000000");
      await ledger.adjustBatch({
        ...correction,
        id: "known-batch",
        expectedPhysicalCostHash: unknown.physical_cost_hash,
      });
      expect((await current()).currentExact).toBe("0.002000000000000000");
      expect(
        (await ledger.summary("request-a", workspace))
          ?.pending_budget_adjustments,
      ).toBe(0);
    });

    it("updates released members’ supplier shares without converting their release into a charge", async () => {
      const { correction } = await batchForCorrection({ released: 1 });
      const result = await ledger.adjustBatch(correction);
      expect(result.changes[1].adjustment?.application.budget_state).toBe(
        "not_applicable",
      );
      expect((await current()).currentExact).toBe("0.001000000000000000");
      expect(await ledger.summary("request-b", workspace)).toMatchObject({
        amount: "0.001000000000000000",
        budget_committed_usd: "0.000000000000000000",
      });
    });

    it("does not refund a newer budget epoch when the old physical batch is corrected downwards", async () => {
      const { correction } = await batchForCorrection();
      await source
        .getRepository(BudgetRule)
        .update(
          { workspace_id: workspace },
          { current_value: 5, period_start: new Date(Date.now() + 86400000) },
        );
      await ledger.adjustBatch({
        ...correction,
        physicalCost: await repriceUsage(0),
      });
      expect(
        (
          await source
            .getRepository(BudgetRule)
            .findOneByOrFail({ workspace_id: workspace })
        ).current_value,
      ).toBe(5);
    });

    it("commits a tiny physical correction as a full group even when one monetary share remains zero", async () => {
      const { correction } = await batchForCorrection();
      const tiny = {
        ...correction.physicalCost,
        amount: "0.000000000000000001",
        known_subtotal: "0.000000000000000001",
        report_amount: "0.000000000000000001",
        report_known_subtotal: "0.000000000000000001",
        rounding_adjustment: "0.000000000000000001",
        report_rounding_adjustment: "0.000000000000000001",
        lines: [],
      };
      const result = await ledger.adjustBatch({
        ...correction,
        physicalCost: tiny,
      });
      expect(result.changes).toHaveLength(2);
      expect(
        result.changes.map((change) => change.cost.report_amount).sort(),
      ).toEqual(["0.000000000000000000", "0.000000000000000001"]);
      expect(
        await source.query("SELECT * FROM pricing_cost_adjustments"),
      ).toHaveLength(2);
    });

    it("atomically persists conserved physical shares and rejects partial or tampered member outcomes", async () => {
      const entries = await physicalBatchOutcomes();
      await expect(
        ledger.completeAttemptGroup(workspace, [entries[0]]),
      ).rejects.toMatchObject({ status: 409 });
      await expect(
        ledger.completeAttemptGroup(workspace, [
          entries[0],
          { ...entries[1], cost: { ...entries[1].cost, report_amount: "999" } },
        ]),
      ).rejects.toMatchObject({ status: 409 });
      expect(
        await source.query(
          "SELECT * FROM pricing_attempts WHERE state = 'terminal'",
        ),
      ).toHaveLength(0);
      const internal = ledger as unknown as {
        queueSettlementInTransaction: (...args: unknown[]) => Promise<unknown>;
      };
      const original = internal.queueSettlementInTransaction.bind(ledger);
      let count = 0;
      const fail = jest
        .spyOn(internal, "queueSettlementInTransaction")
        .mockImplementation(async (...args) => {
          if (++count === 2)
            throw new Error("second member persistence failed");
          return original(...args);
        });
      await expect(
        ledger.completeAttemptGroup(workspace, entries),
      ).rejects.toThrow("second member");
      fail.mockRestore();
      expect(
        await source.query(
          "SELECT * FROM pricing_attempts WHERE state = 'terminal'",
        ),
      ).toHaveLength(0);
      expect(
        await source.query("SELECT * FROM pricing_settlement_intents"),
      ).toHaveLength(0);
      await Promise.all([
        ledger.completeAttemptGroup(workspace, entries),
        new CostLedgerService(source, budgets).completeAttemptGroup(
          workspace,
          [...entries].reverse(),
        ),
      ]);
      await Promise.all([
        ledger.reconcilePending(),
        new CostLedgerService(source, budgets).reconcilePending(),
      ]);
      expect((await current()).currentExact).toBe("0.001000000000000000");
      expect((await ledger.summary("request-a", workspace))?.amount).toBe(
        "0.000500000000000000",
      );
      expect((await ledger.summary("request-b", workspace))?.amount).toBe(
        "0.000500000000000000",
      );
      expect(
        await source.query("SELECT * FROM pricing_budget_effects"),
      ).toHaveLength(4);
    });

    it("recovers conserved physical batch outcomes after a child exits before budget application", async () => {
      const entries = await physicalBatchOutcomes();
      const child = spawnSync(
        process.execPath,
        [
          "-r",
          require.resolve("ts-node/register"),
          "-e",
          `
        require('reflect-metadata'); const { DataSource } = require('typeorm');
        const { BudgetRule } = require('./src/database/entities/budget-rule.entity'); const { BudgetService } = require('./src/budget/budget.service');
        const { WorkspaceContextService } = require('./src/workspaces/workspace-context.service'); const { CostLedgerService } = require('./src/pricing/cost-ledger.service');
        (async () => { const source = await new DataSource({ ...JSON.parse(process.env.PRICING_CHILD_DB), entities: [BudgetRule], synchronize: false }).initialize();
          const ledger = new CostLedgerService(source, new BudgetService({}, new WorkspaceContextService(), source.getRepository(BudgetRule)));
          await ledger.completeAttemptGroup(process.env.PRICING_CHILD_WORKSPACE, JSON.parse(process.env.PRICING_CHILD_BATCH)); process.exit(17);
        })().catch(() => process.exit(18));
      `,
        ],
        {
          cwd: process.cwd(),
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            TMPDIR: process.env.TMPDIR,
            NODE_OPTIONS: "--max-old-space-size=512",
            TS_NODE_TRANSPILE_ONLY: "true",
            PRICING_CHILD_DB: JSON.stringify(source.options),
            PRICING_CHILD_WORKSPACE: workspace,
            PRICING_CHILD_BATCH: JSON.stringify(entries),
          },
          encoding: "utf8",
          timeout: 20000,
        },
      );
      expect({ status: child.status, stderr: child.stderr }).toMatchObject({
        status: 17,
      });
      expect(
        await source.query(
          "SELECT * FROM pricing_settlement_intents WHERE state = 'pending'",
        ),
      ).toHaveLength(2);
      await Promise.all([
        ledger.reconcilePending(),
        new CostLedgerService(source, budgets).reconcilePending(),
      ]);
      expect((await current()).currentExact).toBe("0.001000000000000000");
      expect((await ledger.summary("request-b", workspace))?.amount).toBe(
        "0.000500000000000000",
      );
    }, 30000);

    it("prepares all shared-dispatch participants atomically and rejects different tenant/price snapshots", async () => {
      const { attempts } = await groupedReservations();
      await expect(
        ledger.beginAttemptGroup([
          attempts[0],
          { ...attempts[1], target: { ...target, model: "other" } },
        ]),
      ).rejects.toMatchObject({ status: 409 });
      expect(await source.query("SELECT * FROM pricing_attempts")).toHaveLength(
        0,
      );
      await source
        .createQueryBuilder()
        .update("pricing_reservations")
        .set({
          identity_json: JSON.stringify({
            ...identity,
            apiKeyId: "another-key",
          }),
        })
        .where("id = :id", { id: "reservation-b" })
        .execute();
      await expect(ledger.beginAttemptGroup(attempts)).rejects.toMatchObject({
        status: 409,
      });
      expect(await source.query("SELECT * FROM pricing_attempts")).toHaveLength(
        0,
      );
      await source
        .createQueryBuilder()
        .update("pricing_reservations")
        .set({ identity_json: JSON.stringify(identity) })
        .where("id = :id", { id: "reservation-b" })
        .execute();
      await Promise.all([
        ledger.beginAttemptGroup(attempts),
        new CostLedgerService(source, budgets).beginAttemptGroup(
          [...attempts].reverse(),
        ),
      ]);
      expect(await source.query("SELECT * FROM pricing_attempts")).toHaveLength(
        2,
      );
      expect(
        (await ledger.summary("request-a", workspace))?.pending_attempts,
      ).toBe(1);
      expect(
        (await ledger.summary("request-b", workspace))?.pending_attempts,
      ).toBe(1);
    });

    it("queues every member outcome or none, including cancellation with known upstream cost", async () => {
      const { attempts } = await groupedReservations();
      await ledger.beginAttemptGroup(attempts);
      const entries = attempts.map((attempt, index) => ({
        reservationId: attempt.reservationId,
        payload: {
          kind: index === 0 ? ("commit" as const) : ("release" as const),
          tokens: index === 0 ? "1000" : "0",
          cost_usd: index === 0 ? "0.001" : "0",
          budget_basis: "batch-allocation",
          receipt: {
            attemptId: attempt.id,
            cost: input.estimate,
            errorCode: index === 0 ? null : "client_aborted",
          },
        },
      }));
      await expect(
        ledger.queueSettlementGroup(workspace, [
          entries[0],
          { ...entries[1], payload: { ...entries[1].payload, tokens: "0.1" } },
        ]),
      ).rejects.toMatchObject({ status: 400 });
      expect(
        await source.query("SELECT * FROM pricing_settlement_intents"),
      ).toHaveLength(0);
      await expect(
        ledger.queueSettlementGroup("other-workspace", entries),
      ).rejects.toMatchObject({ status: 404 });
      expect(
        await source.query("SELECT * FROM pricing_settlement_intents"),
      ).toHaveLength(0);
      await Promise.all([
        ledger.queueSettlementGroup(workspace, entries),
        ledger.queueSettlementGroup(workspace, [...entries].reverse()),
      ]);
      expect(
        await source.query("SELECT * FROM pricing_settlement_intents"),
      ).toHaveLength(2);
      await Promise.all([
        ledger.reconcilePending(),
        new CostLedgerService(source, budgets).reconcilePending(),
      ]);
      expect((await current()).currentExact).toBe("0.001000000000000000");
      expect(
        await source.query("SELECT * FROM pricing_budget_effects"),
      ).toHaveLength(4);
      expect(await ledger.summary("request-b", workspace)).toMatchObject({
        amount: "0.001000000000000000",
        budget_committed_usd: "0.000000000000000000",
        pending_attempts: 0,
      });
    });

    it("recovers both members after a child exits immediately after their atomic outcome commit", async () => {
      const { attempts } = await groupedReservations();
      await ledger.beginAttemptGroup(attempts);
      const entries = attempts.map((attempt) => ({
        reservationId: attempt.reservationId,
        payload: {
          kind: "commit",
          tokens: "1000",
          cost_usd: "0.001",
          budget_basis: "batch-allocation",
          receipt: { attemptId: attempt.id, cost: input.estimate },
        },
      }));
      const child = spawnSync(
        process.execPath,
        [
          "-r",
          require.resolve("ts-node/register"),
          "-e",
          `
        require('reflect-metadata');
        const { DataSource } = require('typeorm'); const { BudgetRule } = require('./src/database/entities/budget-rule.entity');
        const { BudgetService } = require('./src/budget/budget.service'); const { WorkspaceContextService } = require('./src/workspaces/workspace-context.service');
        const { CostLedgerService } = require('./src/pricing/cost-ledger.service');
        (async () => {
          const source = await new DataSource({ ...JSON.parse(process.env.PRICING_CHILD_DB), entities: [BudgetRule], synchronize: false }).initialize();
          const ledger = new CostLedgerService(source, new BudgetService({}, new WorkspaceContextService(), source.getRepository(BudgetRule)));
          await ledger.queueSettlementGroup(process.env.PRICING_CHILD_WORKSPACE, JSON.parse(process.env.PRICING_CHILD_BATCH));
          process.exit(17);
        })().catch(() => process.exit(18));
      `,
        ],
        {
          cwd: process.cwd(),
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            TMPDIR: process.env.TMPDIR,
            NODE_OPTIONS: "--max-old-space-size=512",
            TS_NODE_TRANSPILE_ONLY: "true",
            PRICING_CHILD_DB: JSON.stringify(source.options),
            PRICING_CHILD_WORKSPACE: workspace,
            PRICING_CHILD_BATCH: JSON.stringify(entries),
          },
          encoding: "utf8",
          timeout: 20000,
        },
      );
      expect({ status: child.status, stderr: child.stderr }).toMatchObject({
        status: 17,
      });
      expect(
        await source.query(
          "SELECT * FROM pricing_settlement_intents WHERE state = 'pending'",
        ),
      ).toHaveLength(2);
      await Promise.all([
        ledger.reconcilePending(),
        new CostLedgerService(source, budgets).reconcilePending(),
      ]);
      expect((await current()).currentExact).toBe("0.002000000000000000");
      expect(
        await source.query(
          "SELECT * FROM pricing_attempts WHERE state = 'terminal'",
        ),
      ).toHaveLength(2);
      expect(
        await source.query("SELECT * FROM pricing_budget_effects"),
      ).toHaveLength(4);
    }, 30000);

    it("repairs all retry receipts atomically after a child exits with a durable multi-receipt intent", async () => {
      await ledger.reserve(input);
      const receipts = [];
      for (const id of ["physical-first", "physical-second"]) {
        await ledger.beginAttempt({
          id,
          requestId: input.requestId,
          workspace,
          reservationId: input.id,
          target,
          feeSource: "provider",
          dispatchedAt: new Date().toISOString(),
          priceContext: { context: {}, legacyPrice: null },
        });
        receipts.push({
          attemptId: id,
          cost: input.estimate,
          errorCode: id === "physical-first" ? "http_error" : null,
        });
      }
      const child = spawnSync(
        process.execPath,
        [
          "-r",
          require.resolve("ts-node/register"),
          "-e",
          `
        require('reflect-metadata');
        const { DataSource } = require('typeorm');
        const { BudgetRule } = require('./src/database/entities/budget-rule.entity');
        const { BudgetService } = require('./src/budget/budget.service');
        const { WorkspaceContextService } = require('./src/workspaces/workspace-context.service');
        const { CostLedgerService } = require('./src/pricing/cost-ledger.service');
        (async () => {
          const source = await new DataSource({ ...JSON.parse(process.env.PRICING_CHILD_DB), entities: [BudgetRule], synchronize: false }).initialize();
          const ledger = new CostLedgerService(source, new BudgetService({}, new WorkspaceContextService(), source.getRepository(BudgetRule)));
          await ledger.queueSettlement('reservation-a', process.env.PRICING_CHILD_WORKSPACE, 'commit', '1000', '0.001', 'legacy_logical', undefined, JSON.parse(process.env.PRICING_CHILD_RECEIPTS));
          process.exit(17);
        })().catch(() => process.exit(18));
      `,
        ],
        {
          cwd: process.cwd(),
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            TMPDIR: process.env.TMPDIR,
            NODE_OPTIONS: "--max-old-space-size=512",
            TS_NODE_TRANSPILE_ONLY: "true",
            PRICING_CHILD_DB: JSON.stringify(source.options),
            PRICING_CHILD_WORKSPACE: workspace,
            PRICING_CHILD_RECEIPTS: JSON.stringify(receipts),
          },
          encoding: "utf8",
          timeout: 20000,
        },
      );
      expect({ status: child.status, stderr: child.stderr }).toMatchObject({
        status: 17,
      });
      expect(
        (await ledger.summary(input.requestId, workspace))?.pending_attempts,
      ).toBe(2);
      const update = jest
        .spyOn(budgets, "settleLedger")
        .mockRejectedValueOnce(new Error("synthetic budget effect failure"));
      await expect(ledger.applySettlement(input.id, workspace)).rejects.toThrow(
        "synthetic budget effect failure",
      );
      update.mockRestore();
      expect(
        (await ledger.summary(input.requestId, workspace))?.pending_attempts,
      ).toBe(2);
      await Promise.all([
        new CostLedgerService(source, budgets).reconcilePending(),
        ledger.reconcilePending(),
      ]);
      expect(await ledger.summary(input.requestId, workspace)).toMatchObject({
        provider_attempts: 2,
        pending_attempts: 0,
        amount: "0.002000000000000000",
        budget_committed_usd: "0.001000000000000000",
      });
      expect(
        await source.query("SELECT * FROM pricing_budget_effects"),
      ).toHaveLength(2);
      expect((await current()).currentExact).toBe("0.001000000000000000");
    }, 30000);

    it("rejects duplicate and foreign-reservation retry receipts without queuing partial outcomes", async () => {
      await ledger.reserve(input);
      await ledger.beginAttempt({
        id: "physical",
        requestId: input.requestId,
        workspace,
        reservationId: input.id,
        target,
        feeSource: "provider",
        dispatchedAt: new Date().toISOString(),
        priceContext: { context: {}, legacyPrice: null },
      });
      const receipt = { attemptId: "physical", cost: input.estimate };
      await expect(
        ledger.queueSettlement(
          input.id,
          workspace,
          "release",
          "0",
          "0",
          undefined,
          receipt,
          [receipt],
        ),
      ).rejects.toMatchObject({ status: 409 });
      await expect(
        ledger.queueSettlement(
          input.id,
          workspace,
          "release",
          "0",
          "0",
          undefined,
          undefined,
          [{ ...receipt, attemptId: "unknown" }],
        ),
      ).rejects.toMatchObject({ status: 404 });
      expect(
        await source.query("SELECT * FROM pricing_settlement_intents"),
      ).toHaveLength(0);
      expect((await current()).currentExact).toBe("0.500000000000000000");
    });

    it("replays a terminal intent after an isolated child process exits before applying it", async () => {
      await ledger.reserve(input);
      const child = spawnSync(
        process.execPath,
        [
          "-r",
          require.resolve("ts-node/register"),
          "-e",
          `
        require('reflect-metadata');
        const { DataSource } = require('typeorm');
        const { BudgetRule } = require('./src/database/entities/budget-rule.entity');
        const { BudgetService } = require('./src/budget/budget.service');
        const { WorkspaceContextService } = require('./src/workspaces/workspace-context.service');
        const { CostLedgerService } = require('./src/pricing/cost-ledger.service');
        (async () => {
          const source = await new DataSource({ ...JSON.parse(process.env.PRICING_CHILD_DB), entities: [BudgetRule], synchronize: false }).initialize();
          const budgets = new BudgetService({}, new WorkspaceContextService(), source.getRepository(BudgetRule));
          const ledger = new CostLedgerService(source, budgets);
          await ledger.queueSettlement('reservation-a', process.env.PRICING_CHILD_WORKSPACE, 'commit', '10', '0.001');
          process.exit(17); // Deliberate isolated process interruption after durable intent.
        })().catch(() => process.exit(18));
      `,
        ],
        {
          cwd: process.cwd(),
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            TMPDIR: process.env.TMPDIR,
            NODE_OPTIONS: "--max-old-space-size=512",
            TS_NODE_TRANSPILE_ONLY: "true",
            PRICING_CHILD_DB: JSON.stringify(source.options),
            PRICING_CHILD_WORKSPACE: workspace,
          },
          encoding: "utf8",
          timeout: 20000,
        },
      );
      expect({
        status: child.status,
        error: child.error?.message,
        stderr: child.stderr,
      }).toMatchObject({ status: 17 });
      expect((await current()).currentExact).toBe("0.500000000000000000");
      expect(
        (await source.query("SELECT state FROM pricing_settlement_intents"))[0]
          .state,
      ).toBe("pending");
      const recovered = new CostLedgerService(
        source,
        new BudgetService(
          mockConfigService(),
          new WorkspaceContextService(),
          source.getRepository(BudgetRule),
        ),
      );
      await Promise.all([
        recovered.reconcilePending(),
        ledger.reconcilePending(),
      ]);
      expect((await current()).currentExact).toBe("0.001000000000000000");
      expect(
        await source.query("SELECT * FROM pricing_budget_effects"),
      ).toHaveLength(2);
      expect(
        (await source.query("SELECT state FROM pricing_settlement_intents"))[0]
          .state,
      ).toBe("applied");
      expect(await recovered.reconcilePending()).toEqual({
        applied: 0,
        pending: 0,
        review_required: 0,
      });
    }, 30000);

    it("keeps receipt repair and the applied marker pending after rollback, then retries without duplicate debit", async () => {
      await ledger.reserve(input);
      await ledger.beginAttempt({
        id: "repair-attempt",
        requestId: input.requestId,
        workspace,
        reservationId: input.id,
        target,
        feeSource: "provider",
        dispatchedAt: new Date().toISOString(),
        priceContext: { context: {}, legacyPrice: null },
      });
      await ledger.queueSettlement(
        input.id,
        workspace,
        "commit",
        "1000",
        "0.001",
        "legacy_logical",
        { attemptId: "repair-attempt", cost: input.estimate },
      );
      await expect(
        ledger.queueSettlement(input.id, workspace, "release"),
      ).rejects.toMatchObject({ status: 409 });
      await expect(
        ledger.applySettlement(input.id, "other-workspace"),
      ).rejects.toMatchObject({ status: 404 });
      const fail = jest
        .spyOn(
          ledger as unknown as {
            effect: (...args: unknown[]) => Promise<void>;
          },
          "effect",
        )
        .mockRejectedValueOnce(
          new Error("simulated database outage; secret must not be persisted"),
        );
      const now = new Date();
      try {
        expect(await ledger.reconcilePending(100, now)).toEqual({
          applied: 0,
          pending: 1,
          review_required: 0,
        });
      } finally {
        fail.mockRestore();
      }
      const pending = (
        await source.query("SELECT * FROM pricing_settlement_intents")
      )[0];
      expect(pending).toMatchObject({
        state: "pending",
        attempt_count: 1,
        last_error_code: "pricing_storage_failure",
        applied_at: null,
      });
      expect(JSON.stringify(pending)).not.toContain("secret");
      expect(
        (
          await source.query("SELECT state, cost_json FROM pricing_attempts")
        )[0],
      ).toEqual({ state: "dispatched", cost_json: null });
      expect((await current()).currentExact).toBe("0.500000000000000000");
      expect(await ledger.reconcilePending(100, now)).toEqual({
        applied: 0,
        pending: 0,
        review_required: 0,
      });
      expect(
        await ledger.reconcilePending(100, new Date(now.getTime() + 1001)),
      ).toEqual({ applied: 1, pending: 0, review_required: 0 });
      expect((await current()).currentExact).toBe("0.001000000000000000");
      expect(
        (await ledger.summary(input.requestId, workspace))?.reservations[0]
          .settlement_status,
      ).toBe("applied");
    });

    it("quarantines tampered terminal intents without rewriting evidence or budget", async () => {
      await ledger.reserve(input);
      await ledger.queueSettlement(input.id, workspace, "release");
      await source
        .createQueryBuilder()
        .update("pricing_settlement_intents")
        .set({ payload_json: "{}" })
        .where("reservation_id = :id", { id: input.id })
        .execute();
      expect(await ledger.reconcilePending()).toEqual({
        applied: 0,
        pending: 0,
        review_required: 1,
      });
      expect((await current()).currentExact).toBe("0.500000000000000000");
      expect(
        (await source.query("SELECT * FROM pricing_settlement_intents"))[0],
      ).toMatchObject({
        state: "review_required",
        last_error_code: "pricing_version_conflict",
        applied_at: null,
      });
      expect(await ledger.reconcilePending()).toEqual({
        applied: 0,
        pending: 0,
        review_required: 0,
      });
    });

    it("renews only owned live leases, never shortens them, and fences dispatch after a queued terminal decision", async () => {
      await ledger.reserve(input);
      const until = new Date(Date.now() + 120000).toISOString();
      expect(
        await ledger.renew(input.id, workspace, "not-the-owner", until),
      ).toBe(false);
      expect(
        await ledger.renew(input.id, workspace, input.leaseOwner, until),
      ).toBe(true);
      expect(
        await ledger.renew(
          input.id,
          workspace,
          input.leaseOwner,
          input.leaseUntil,
        ),
      ).toBe(true);
      expect(
        (await source.query("SELECT lease_until FROM pricing_reservations"))[0]
          .lease_until,
      ).toBe(until);
      expect(
        await ledger.recoverUndispatched(100, new Date(Date.now() + 90000)),
      ).toBe(0);
      await ledger.queueSettlement(input.id, workspace, "release");
      expect(
        await ledger.renew(input.id, workspace, input.leaseOwner, until),
      ).toBe(false);
      await expect(
        ledger.beginAttempt({
          id: "fenced-attempt",
          requestId: input.requestId,
          workspace,
          reservationId: input.id,
          target,
          feeSource: "provider",
          dispatchedAt: new Date().toISOString(),
          priceContext: { context: {}, legacyPrice: null },
        }),
      ).rejects.toMatchObject({ status: 409 });
    });

    it("releases expired undispatched synchronous holds once but preserves dispatched and async jobs", async () => {
      const expired = new Date(Date.now() - 60000).toISOString();
      await ledger.reserve({ ...input, leaseUntil: expired });
      await ledger.reserve({
        ...input,
        id: "async-reservation",
        leaseUntil: expired,
        jobId: "async-job",
      });
      await ledger.reserve({
        ...input,
        id: "dispatched-reservation",
        leaseUntil: expired,
      });
      await ledger.beginAttempt({
        id: "dispatched-attempt",
        requestId: input.requestId,
        workspace,
        reservationId: "dispatched-reservation",
        target,
        feeSource: "provider",
        dispatchedAt: expired,
        priceContext: { context: {}, legacyPrice: null },
      });
      await Promise.all([
        ledger.recoverUndispatched(),
        ledger.recoverUndispatched(),
      ]);
      expect((await current()).currentExact).toBe("1.000000000000000000");
      expect(
        await source.query(
          "SELECT id, state FROM pricing_reservations ORDER BY id",
        ),
      ).toEqual([
        { id: "async-reservation", state: "reserved" },
        { id: "dispatched-reservation", state: "reserved" },
        { id: input.id, state: "released" },
      ]);
      expect(await ledger.recoverUndispatched()).toBe(0);
      expect(
        (await ledger.summary(input.requestId, workspace))?.pending_attempts,
      ).toBe(1);
    });

    it("serializes orphan recovery against a concurrent first dispatch", async () => {
      await ledger.reserve({
        ...input,
        leaseUntil: new Date(Date.now() - 1).toISOString(),
      });
      const results = await Promise.allSettled([
        ledger.recoverUndispatched(),
        ledger.beginAttempt({
          id: "racing-attempt",
          requestId: input.requestId,
          workspace,
          reservationId: input.id,
          target,
          feeSource: "provider",
          dispatchedAt: new Date().toISOString(),
          priceContext: { context: {}, legacyPrice: null },
        }),
      ]);
      expect(results[0].status).toBe("fulfilled");
      const reservation = (
        await source.query("SELECT state FROM pricing_reservations")
      )[0];
      const attempts = await source.query("SELECT * FROM pricing_attempts");
      if (reservation.state === "released") {
        expect(results[1].status).toBe("rejected");
        expect(attempts).toHaveLength(0);
      } else {
        expect(results[1].status).toBe("fulfilled");
        expect(attempts).toHaveLength(1);
      }
    });

    it("reserves, commits and retries settlement without duplicate budget effects", async () => {
      await ledger.reserve(input);
      expect((await current()).currentExact).toBe("0.500000000000000000");
      await Promise.all([
        ledger.settle(input.id, workspace, "commit", "10", "0.001"),
        ledger.settle(input.id, workspace, "commit", "10", "0.001"),
      ]);
      expect((await current()).currentExact).toBe("0.001000000000000000");
      expect(
        await source.query("SELECT * FROM pricing_budget_effects"),
      ).toHaveLength(2);
      await expect(
        ledger.settle(input.id, workspace, "release"),
      ).rejects.toMatchObject({ status: 409 });
    });

    it("fences concurrent identical reservations before budget mutation, including independent service instances", async () => {
      const otherBudgets = new BudgetService(
        mockConfigService(),
        new WorkspaceContextService(),
        source.getRepository(BudgetRule),
      );
      const other = new CostLedgerService(source, otherBudgets);
      const rows = await Promise.all([
        ledger.reserve(input),
        other.reserve({ ...input, tokens: "1000.0" }),
        ledger.reserve(input),
      ]);
      expect(rows.map((row) => row.id)).toEqual([input.id, input.id, input.id]);
      expect((await current()).currentExact).toBe("0.500000000000000000");
      expect(
        await source.query("SELECT * FROM pricing_budget_effects"),
      ).toHaveLength(1);
      await expect(
        other.reserve({
          ...input,
          identity: { ...identity, apiKeyId: "different-key" },
        }),
      ).rejects.toMatchObject({ status: 409 });
      await expect(
        other.reserve({
          ...input,
          target: { ...target, node_id: "different-node" },
        }),
      ).rejects.toMatchObject({ status: 409 });
    });

    it("fences duplicate dispatch and rejects new dispatch after terminal settlement", async () => {
      await ledger.reserve(input);
      const attempt = {
        id: "attempt-a",
        requestId: input.requestId,
        workspace,
        reservationId: input.id,
        target,
        feeSource: "provider" as const,
        dispatchedAt: new Date().toISOString(),
        priceContext: { context: {}, legacyPrice: null },
      };
      await Promise.all([
        ledger.beginAttempt(attempt),
        ledger.beginAttempt(attempt),
      ]);
      expect(await source.query("SELECT * FROM pricing_attempts")).toHaveLength(
        1,
      );
      await expect(
        ledger.beginAttempt({ ...attempt, feeSource: "local_cache" }),
      ).rejects.toMatchObject({ status: 409 });
      await ledger.completeAttempt(attempt.id, workspace, input.estimate);
      await ledger.settle(
        input.id,
        workspace,
        "commit",
        "1000",
        "0.001",
        undefined,
        { attemptId: attempt.id, cost: input.estimate },
      );
      await expect(
        ledger.beginAttempt({ ...attempt, id: "late-dispatch" }),
      ).rejects.toMatchObject({ status: 409 });
      await expect(
        ledger.settle(
          input.id,
          workspace,
          "commit",
          "1000",
          "0.001",
          undefined,
          { attemptId: attempt.id, cost: { ...input.estimate, amount: "99" } },
        ),
      ).rejects.toMatchObject({ status: 409 });
      await expect(
        ledger.settle(input.id, workspace, "release", "1"),
      ).rejects.toMatchObject({ status: 409 });
    });

    it("uses the exact shadow when the float projection has already rounded to the budget limit", async () => {
      await source
        .getRepository(BudgetRule)
        .update(
          { workspace_id: workspace },
          { current_value: 999999, limit_value: 1000000, alert_threshold: 1 },
        );
      await ledger.reserve({ ...input, costUsd: "0.999999999999999999" });
      const status = await current();
      expect(status.currentExact).toBe("999999.999999999999999999");
      expect(status.isExceeded).toBe(false);
      expect(status.isAlert).toBe(false);
      await budgets.check();
      await budgets.resetRule(status.id);
      expect((await current()).currentExact).toBe("0.000000000000000000");
    });

    it("releases once and isolates workspace identities", async () => {
      await ledger.reserve(input);
      await expect(
        ledger.settle(input.id, "other-workspace", "release"),
      ).rejects.toMatchObject({ status: 404 });
      await ledger.settle(input.id, workspace, "release");
      await ledger.settle(input.id, workspace, "release");
      expect((await current()).currentExact).toBe("0.000000000000000000");
    });

    it("rolls back all budget scopes and ledger rows if reservation exceeds a limit", async () => {
      await source
        .getRepository(BudgetRule)
        .update({ workspace_id: workspace }, { limit_value: 0.25 });
      await expect(ledger.reserve(input)).rejects.toBeInstanceOf(
        BudgetExceededError,
      );
      expect((await current()).current).toBe(0);
      expect(
        await source.query("SELECT * FROM pricing_reservations"),
      ).toHaveLength(0);
      expect(
        await source.query("SELECT * FROM pricing_budget_effects"),
      ).toHaveLength(0);
    });

    it("restores the exact balance before a legacy writer runs after service initialization", async () => {
      await source
        .getRepository(BudgetRule)
        .update({ workspace_id: workspace }, { current_value: 1000000 });
      await ledger.reserve({ ...input, costUsd: "0.00000005" });
      const restarted = new BudgetService(
        mockConfigService({
          budget: {
            daily_token_limit: 10000000,
            daily_cost_limit: 10000000,
            alert_threshold: 0.8,
          },
        }),
        new WorkspaceContextService(),
        source.getRepository(BudgetRule),
      );
      try {
        await restarted.onModuleInit();
        await restarted.record(0, 0.00000001);
        const cost = (await restarted.getStatus()).find(
          (rule) => rule.type === "daily_cost",
        );
        expect(cost?.currentExact).toBe("1000000.000000060000000000");
      } finally {
        restarted.onModuleDestroy();
      }
    });

    it("coordinates config budget synchronization with concurrent exact ledger mutations", async () => {
      const configured = new BudgetService(
        mockConfigService({
          budget: {
            daily_token_limit: 10000000,
            daily_cost_limit: 10000000,
            alert_threshold: 0.8,
          },
        }),
        new WorkspaceContextService(),
        source.getRepository(BudgetRule),
      );
      try {
        await configured.onModuleInit();
        await Promise.all([
          ledger.reserve(input),
          (
            configured as unknown as {
              syncRulesFromConfig: () => Promise<void>;
            }
          ).syncRulesFromConfig(),
          configured.record(1, 0.00000001),
        ]);
        const cost = (await configured.getStatus()).find(
          (rule) => rule.type === "daily_cost",
        );
        expect(cost?.currentExact).toBe("0.500000010000000000");
        await ledger.settle(input.id, workspace, "commit", "1000", "0.001");
        expect(
          (await configured.getStatus()).find(
            (rule) => rule.type === "daily_cost",
          )?.currentExact,
        ).toBe("0.001000010000000000");
      } finally {
        configured.onModuleDestroy();
      }
    });

    it("accepts legacy arithmetic micro-costs without rejecting overlong binary-float decimal expansions", async () => {
      await ledger.available();
      const micro = (4 / 1000000) * 5;
      const held = await budgets.reserve(1, micro * 2);
      await held.commit(1, micro);
      expect((await current()).currentExact).toBe("0.000020000000000000");
      await budgets.record(1, 0.1);
      expect((await current()).currentExact).toBe("0.100020000000000000");
    });

    it("keeps sub-float4 increments in the exact balance instead of losing them at large totals", async () => {
      await source
        .getRepository(BudgetRule)
        .update({ workspace_id: workspace }, { current_value: 1000000 });
      await ledger.reserve({ ...input, costUsd: "0.000000100000000000" });
      await ledger.settle(
        input.id,
        workspace,
        "commit",
        "1",
        "0.000000050000000000",
      );
      expect((await current()).currentExact).toBe("1000000.000000050000000000");
      await budgets.record(0, 0.00000001);
      expect((await current()).currentExact).toBe("1000000.000000060000000000");
    });

    it("does not subtract an old-period reservation from a new-period budget", async () => {
      await ledger.reserve(input);
      await source
        .getRepository(BudgetRule)
        .update(
          { workspace_id: workspace },
          { current_value: 2, period_start: new Date(Date.now() + 86400000) },
        );
      await ledger.settle(input.id, workspace, "commit", "3", "0.1");
      expect((await current()).currentExact).toBe("2.100000000000000000");
    });

    it("does not release pre-reset holds from usage recorded after a manual same-day reset", async () => {
      await ledger.reserve(input);
      const status = await current();
      await budgets.resetRule(status.id);
      await budgets.record(1, 0.2);
      await ledger.settle(input.id, workspace, "release");
      expect((await current()).currentExact).toBe("0.200000000000000000");
    });

    it("atomically repairs a missing receipt with the budget commit, and rolls both back on effect failure", async () => {
      await ledger.reserve(input);
      await ledger.beginAttempt({
        id: "attempt-a",
        requestId: input.requestId,
        workspace,
        reservationId: input.id,
        target,
        feeSource: "provider",
        dispatchedAt: new Date().toISOString(),
        priceContext: { context: {}, legacyPrice: null },
      });
      const fail = jest
        .spyOn(
          ledger as unknown as {
            effect: (...args: unknown[]) => Promise<void>;
          },
          "effect",
        )
        .mockRejectedValueOnce(new Error("simulated write failure"));
      try {
        await expect(
          ledger.settle(
            input.id,
            workspace,
            "commit",
            "1000",
            "0.001",
            undefined,
            { attemptId: "attempt-a", cost: input.estimate },
          ),
        ).rejects.toThrow("simulated write failure");
      } finally {
        fail.mockRestore();
      }
      expect((await current()).currentExact).toBe("0.500000000000000000");
      expect(
        (
          await source.query("SELECT state, cost_json FROM pricing_attempts")
        )[0],
      ).toMatchObject({ state: "dispatched", cost_json: null });
      await ledger.settle(
        input.id,
        workspace,
        "commit",
        "1000",
        "0.001",
        undefined,
        { attemptId: "attempt-a", cost: input.estimate },
      );
      expect((await current()).currentExact).toBe("0.001000000000000000");
      expect((await ledger.summary(input.requestId, workspace))?.amount).toBe(
        "0.001000000000000000",
      );
    });

    it("restores immutable receipts after reopening the connection and rejects overwritten usage", async () => {
      await ledger.reserve(input);
      await ledger.beginAttempt({
        id: "attempt-a",
        requestId: input.requestId,
        workspace,
        reservationId: input.id,
        target,
        feeSource: "provider",
        dispatchedAt: new Date().toISOString(),
        priceContext: { context: {}, legacyPrice: null },
      });
      await ledger.completeAttempt("attempt-a", workspace, input.estimate);
      await ledger.completeAttempt("attempt-a", workspace, input.estimate);
      const options = source.options;
      await source.destroy();
      source = await new DataSource(options).initialize();
      budgets = new BudgetService(
        mockConfigService(),
        new WorkspaceContextService(),
        source.getRepository(BudgetRule),
      );
      ledger = new CostLedgerService(source, budgets);
      expect(
        (await ledger.summary(input.requestId, workspace))?.attempts[0].cost
          ?.content_hash,
      ).toBe(input.estimate.content_hash);
      await expect(
        ledger.completeAttempt("attempt-a", workspace, {
          ...input.estimate,
          amount: "99",
        }),
      ).rejects.toMatchObject({ status: 409 });
      expect(
        await ledger.summary(input.requestId, "other-workspace"),
      ).toBeNull();
    });
  });
}

ledgerContract("SQLite cost ledger", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cost-ledger-"));
  const source = await new DataSource({
    type: "better-sqlite3",
    database: join(directory, "ledger.db"),
    entities: [BudgetRule],
    synchronize: true,
  }).initialize();
  await source.query("PRAGMA journal_mode=WAL");
  await source.query("PRAGMA synchronous=FULL");
  return {
    source,
    cleanup: async () => rmSync(directory, { recursive: true, force: true }),
  };
});
const pgUrl = process.env.SIFTGATE_PRICING_TEST_POSTGRES_URL;
if (pgUrl) {
  const url = new URL(pgUrl);
  if (
    url.hostname !== "127.0.0.1" ||
    !/^\/pricing_goal_[a-z0-9_]+$/.test(url.pathname)
  )
    throw new Error("Use the explicit isolated PostgreSQL test database");
}
ledgerContract(
  "PostgreSQL cost ledger",
  async () => {
    if (!pgUrl) throw new Error("No isolated PostgreSQL URL");
    const schema = `cost_ledger_${process.pid}_${Math.random().toString(16).slice(2)}`;
    const admin = await new DataSource({
      type: "postgres",
      url: pgUrl,
      synchronize: false,
    }).initialize();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const source = await new DataSource({
      type: "postgres",
      url: pgUrl,
      schema,
      extra: { options: `-c search_path=${schema}` },
      entities: [BudgetRule],
      synchronize: true,
    }).initialize();
    return {
      source,
      cleanup: async () => {
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
        await admin.destroy();
      },
    };
  },
  pgUrl ? describe : describe.skip,
);

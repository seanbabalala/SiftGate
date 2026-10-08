import { createPostgresReadProgram, withPostgresReadPrelude, type PostgresTransactionReadPrelude } from "./postgres-read-program";
import { tryWriteSettlementMetadata, type SettlementReservationPatch } from "./settlement-metadata-writer";
import { canInsertSettlementLogPair, insertSettlementLogPair } from "./settlement-log-pair";
import { readRequestLogSnapshot } from "./request-log-snapshot";
import { readActualBudgetEvidence } from "./actual-upstream-budget-evidence";
import { PricingReplayLimitError } from "./pricing-replay-budget";
import { localCacheReference } from "./local-cache-reference";
import { tokenBudgetCompatible } from "./pricing-token-budget";
import { actualBudgetAdjustmentBasis } from "./actual-upstream-budget-adjustments";
import { loadGroupDisposition, applyGroupDisposition } from "./pricing-group-disposition";
import { ACTUAL_BUDGET_COHORT_TABLE, actualBudgetClosure, retainActualBudgetCohort, readActualBudgetCohort, type ActualBudgetCohortRow } from "./actual-upstream-budget-cohort";
import { actualBudgetCustody, recordPendingActualRecovery } from "./actual-upstream-budget-recovery";
import { actualMediaAuditId, actualMediaAuditMetadata, actualMediaCustodyPending, verifyActualMediaAuthority, verifyActualMediaAcknowledgement, actualMediaClosureAuthority } from "./actual-media-budget-evidence";
import { readActualMediaTasks } from "./actual-media-budget-scope";
import { verifyMediaObservation, mediaTaskContext } from "./media-observation-evidence";
import { readMediaDispositionRecord } from "./media-event-disposition-record";
import { compilePriceBook } from "./pricing-compiler";
import { calculateCost } from "./cost-calculator";
import type { ActualBudgetStoredClosure } from "./actual-upstream-budget-cohort.types";
import { PricingRepository } from "./pricing-repository";
import { planActualUpstreamBudget } from "./actual-upstream-budget";
import type { ActualUpstreamBudgetPlan } from "./actual-upstream-budget.types";
import { GROUP_DISPOSITION_TABLE, GROUP_DISPOSITION_ACTION, groupDispositionAuditId, groupDispositionSignature, recordedGroupDisposition as readRecordedGroupDisposition, readGroupDispositionRow, verifyGroupDispositionRecord } from "./pricing-group-disposition-record";
import type { GroupDispositionInput } from "./pricing-group-disposition.types";
import {
  GROUP_OUTCOME_TABLE,
  retainRuntimeGroupOutcome,
  readRuntimeGroupOutcome,
  transitionRuntimeGroupOutcome,
  assertRuntimeGroupDeliverable,
  quarantineInvalidGroupOutcome,
  runtimeGroupOutcomeInventory,
} from "./pricing-group-outcome-inbox";
import {
  runtimeGroupOutcomeDocument,
  readRuntimeGroupDocument,
} from "./pricing-group-outcome-document";
import type {
  PricingGroupOutcome,
  GroupOutcomeRow,
  GroupOutcomeState,
} from "./pricing-group-outcome.types";
import { recoveryInventory, type RecoveryView } from "./pricing-recovery-inventory";
import { loadAttemptCorrection, recordedAttemptCorrection, applyAttestedAttemptCorrection, attemptCorrectionAuditId, attemptCorrectionSignature } from './attempt-correction';
import type { AttemptCorrectionInput } from './attempt-correction.types';
import { loadUsageRecoveryBasis, recordedUsageRecovery, usageRecoveryAuditId, usageRecoveryProposalHash, writeRecoveredUsage } from './pricing-usage-recovery';
import type { UsageRecoveryInput } from './pricing-usage-recovery.types';
import { prepareBatchManifest } from "./pricing-batch-manifest";
import type { EmbeddingBatchMember } from "./pricing-batch.types";
import { loadRecoveryBasis, recoveryDecode, recoveryConflict } from "./pricing-recovery-basis";
import { buildRecoveryResolution } from "./pricing-resolution-plan";
import type { RecoveryResolutionInput, RecoveryResolutionResult } from "./pricing-resolution.types";
import type { PricingActor } from "./pricing-repository.types";
import type { PricingOutcome } from "./pricing-outcome-retry";
import { runtimeOutcomeDocument } from "./pricing-outcome-document";
import { loadOutcomeDisposition, recordedOutcomeDisposition, applyOutcomeDisposition, dispositionSignature, dispositionAuditId, assertOutcomeUndisposed, OUTCOME_DISPOSITION_TABLE } from "./pricing-outcome-disposition";
import type { OutcomeDispositionInput } from "./pricing-outcome-disposition.types";
import { acknowledgeSettlementReceipts, prepareRuntimeOutcomeRetention, executePreparedRetentionTransaction, transitionRuntimeOutcome, readRuntimeOutcome, verifyRuntimeOutcome, quarantineInvalidRuntimeOutcome, runtimeOutcomeInventory, type RuntimeOutcomeRow, type RuntimeOutcomeState } from "./pricing-outcome-inbox";
import { redactErrorText } from "../security/error-redaction";
import { observeDispatchedOrphan, recoveryCaseSummary, resolveRecoveryCase } from "./pricing-orphan-recovery";
import type { PricingRecoveryCaseRow, PricingRecoveryCaseSummary } from "./pricing-orphan.types";
import {
  appendBatchCostAdjustment,
  loadBatchAdjustmentGroup,
} from "./batch-cost-adjustments";
import type {
  BatchCostAdjustmentInput,
  BatchCostAdjustmentResult,
} from "./cost-adjustment.types";
import { validateBatchShare } from "./cost-allocation";
import type { MediaTaskRow, MediaTaskObservationRow } from "./media-task.types";
import { appendCostAdjustment, loadCostAdjustments } from "./cost-adjustments";
import type {
  CostAdjustmentInput,
  CostAdjustmentView,
} from "./cost-adjustment.types";
import { CallLog } from "../database/entities/call-log.entity";
import { RouteDecisionLog } from "../database/entities/route-decision-log.entity";
import {
  normalizeWorkspaceId,
  workspaceFindWhere,
} from "../workspaces/workspace-scope";
import { Injectable, Optional } from "@nestjs/common";
import { DataSource, EntityManager } from "typeorm";
import { BudgetService } from "../budget/budget.service";
import type {
  BudgetLedgerHold,
  BudgetLedgerIdentity,
} from "../budget/budget-ledger.types";
import { serializeDatabaseAccess } from "../database/database-serialization";
import { ExactDecimal } from "./exact-decimal";

/** Internal pipeline input, not part of the durable outcome document. New rows
 * only. Generated IDs may be assigned even after rollback/lost commit response;
 * they identify the same optional log on fallback, NOT successful accounting. */
export interface RuntimeSettlementLogs {
  call: CallLog;
  route?: RouteDecisionLog;
}
interface PendingSettlementLogs {
  input: RuntimeSettlementLogs;
  saved: CallLog | null;
}
import { pricingContentHash } from "./pricing-json";
import {
  pricingMigrationMarkersReady,
} from "./pricing-schema";
import { PricingRepositoryError } from "./pricing-repository.types";
import { parsePricingInstant } from "./pricing-time";
import type { CostComputation, NormalizedUsage, PricingContext } from "./pricing.types";
import type { PricingTarget } from "./pricing-catalog.types";
import type {
  AttemptPriceContext,
  CostAttemptRow,
  CostLedgerSummary,
  CostReservationInput,
  CostReservationRow,
  CostSettlementPayload,
  CostSettlementIntentRow,
  CostRecoveryResult,
} from "./cost-ledger.types";

/** Only the verified log subtotal crosses the budget mutation, never a stale budget summary. */
interface CallLogCostProjection {
  costUsd: number;
}

type ReceiptAttemptState = Pick<CostAttemptRow, "id" | "state" | "cost_hash" | "error_code">;

@Injectable()
export class CostLedgerService {
  private ready = false;
  private readonly prices: PricingRepository;
  constructor(
    private readonly dataSource: DataSource,
    private readonly budgets: BudgetService,
    @Optional() prices?: PricingRepository,
  ) { this.prices = prices ?? new PricingRepository(dataSource); }

  async available(): Promise<boolean> {
    if (this.ready) return true;
    return serializeDatabaseAccess(this.dataSource, async () => {
      const runner = this.dataSource.createQueryRunner();
      try {
        if (!(await runner.hasTable("pricing_schema_versions"))) return false;
        if (!(await pricingMigrationMarkersReady(runner.manager)))
          throw Object.assign(new PricingRepositoryError(
            "pricing_schema_required", "Installed pricing migrations are incomplete or incompatible; inspect and migrate explicitly before serving priced requests", 503,
          ), { body: { error: { type: "pricing_error", code: "pricing_schema_required" } } });
        this.ready = true;
        this.budgets.enableExactLedger();
        return true;
      } finally {
        await runner.release();
      }
    });
  }

  async reserve(input: CostReservationInput): Promise<CostReservationRow> {
    this.quantity(input.tokens, true);
    this.quantity(input.costUsd);
    this.text(input.id);
    this.text(input.requestId);
    this.text(input.identity.workspaceId);
    this.text(input.leaseOwner);
    const leaseUntil = new Date(
      parsePricingInstant(input.leaseUntil),
    ).toISOString();
    return this.write(async (manager) => {
      // The persisted request is an existing lock target even before the reservation exists.
      // This fences concurrent idempotent admission on PostgreSQL without a double debit.
      await this.requireRequest(
        manager,
        input.requestId,
        input.identity.workspaceId,
        true,
      );
      const snapshot = await this.prices.restoreRequestInTransaction(manager, input.requestId, input.identity.workspaceId);
      const policy = snapshot.admissionPolicy(input.target.operation);
      const actual = policy.budget_basis === "actual_upstream";
      if (actual !== (input.budgetBasis === "actual_upstream"))
        this.conflict("Reservation budget basis differs from its immutable admission policy");
      if (!tokenBudgetCompatible(snapshot, input.target, policy) || policy.token_budget === "not_applicable" && ExactDecimal.parse(input.tokens).compare(ExactDecimal.zero) !== 0)
        this.conflict("Token budget selection differs from the frozen non-token price contract");
      const prior = await this.reservation(
        manager,
        input.id,
        input.identity.workspaceId,
        false,
      );
      if (prior) {
        if (
          prior.request_id !== input.requestId ||
          (actual && prior.budget_basis !== "actual_upstream") ||
          ExactDecimal.parse(prior.reserved_tokens).compare(
            ExactDecimal.parse(input.tokens),
          ) !== 0 ||
          ExactDecimal.parse(prior.reserved_cost_usd).compare(
            ExactDecimal.parse(input.costUsd),
          ) !== 0 ||
          pricingContentHash(JSON.parse(prior.identity_json)) !==
            pricingContentHash(input.identity) ||
          pricingContentHash(JSON.parse(prior.target_json)) !==
            pricingContentHash(input.target) ||
          pricingContentHash(JSON.parse(prior.estimate_json)) !==
            pricingContentHash(input.estimate) ||
          prior.job_id !== (input.jobId ?? null)
        )
          this.conflict(
            "Reservation identity was reused with different values",
          );
        return prior;
      }
      const holds = await this.budgets.reserveLedger(
        manager,
        input.identity,
        input.tokens,
        input.costUsd,
        policy.token_budget !== "not_applicable",
      );
      const now = new Date().toISOString();
      const row: CostReservationRow = {
        id: input.id,
        request_id: input.requestId,
        workspace_id: input.identity.workspaceId,
        state: "reserved",
        identity_json: JSON.stringify(input.identity),
        target_json: JSON.stringify(input.target),
        estimate_json: JSON.stringify(input.estimate),
        reserved_tokens: input.tokens,
        reserved_cost_usd: input.costUsd,
        holds_json: JSON.stringify(holds),
        committed_tokens: "0",
        committed_cost_usd: "0",
        budget_basis: input.budgetBasis,
        lease_owner: input.leaseOwner,
        lease_until: leaseUntil,
        job_id: input.jobId ?? null,
        created_at: now,
        updated_at: now,
      };
      await manager
        .createQueryBuilder()
        .insert()
        .into("pricing_reservations")
        .values(row)
        .execute();
      await this.effect(
        manager,
        row,
        "reserve",
        input.tokens,
        input.costUsd,
        holds,
      );
      return row;
    });
  }

  async settle(
    id: string,
    workspace: string,
    kind: "commit" | "release",
    tokens = "0",
    costUsd = "0",
    basis?: string,
    receipt?: CostSettlementPayload["receipt"],
    receipts?: CostSettlementPayload["receipts"],
  ): Promise<CostReservationRow> {
    await this.queueSettlement(
      id,
      workspace,
      kind,
      tokens,
      costUsd,
      basis,
      receipt,
      receipts,
    );
    return this.applySettlement(id, workspace);
  }

  /** Durable terminal-intent boundary. This method never applies budget usage. */
  async queueSettlement(
    id: string,
    workspace: string,
    kind: "commit" | "release",
    tokens = "0",
    costUsd = "0",
    basis?: string,
    receipt?: CostSettlementPayload["receipt"],
    receipts?: CostSettlementPayload["receipts"],
    runtimeOutcomeId?: string,
    budgetAttemptId?: string,
    delivery?: RuntimeOutcomeRow,
  ): Promise<CostSettlementIntentRow> {
    this.quantity(tokens, true);
    this.quantity(costUsd);
    if (receipt) this.validateCost(receipt.cost);
    return this.write(async (manager) => {
      const row = await this.reservation(manager, id, workspace, true);
      if (!row) this.missing();
      await assertOutcomeUndisposed(manager, runtimeOutcomeId, workspace);
      const payload = this.normalizeSettlementPayload({
        kind,
        tokens,
        cost_usd: costUsd,
        budget_basis: basis ?? row.budget_basis,
        ...(budgetAttemptId ? { budget_attempt_id: budgetAttemptId } : {}),
        receipt: receipt ?? null,
        ...(receipts ? { receipts } : {}),
      });
      const intent = await this.queueSettlementInTransaction(manager, row, payload);
      if (delivery) {
        const outcome = this.deliveryOutcome(delivery, runtimeOutcomeId, row);
        if (
          outcome.type !== "settlement" ||
          pricingContentHash(this.normalizeSettlementPayload(outcome.payload)) !== intent.payload_hash
        )
          this.conflict("Runtime acknowledgement differs from the delivered settlement");
        await transitionRuntimeOutcome(manager, delivery, "delivered");
      }
      return intent;
    });
  }

  /** Persist a complete shared-dispatch outcome before any member applies its budget effect. */
  async queueSettlementGroup(
    workspace: string,
    entries: Array<{ reservationId: string; payload: CostSettlementPayload }>,
    runtimeGroupOutcomeId?: string,
  ): Promise<CostSettlementIntentRow[]> {
    if (
      !entries.length ||
      entries.length > 1024 ||
      new Set(entries.map((entry) => entry.reservationId)).size !==
        entries.length
    )
      this.conflict("Invalid batch settlement identities");
    this.text(workspace);
    return this.write(async (manager) => {
      await assertRuntimeGroupDeliverable(manager, runtimeGroupOutcomeId, {
        type: "settlement_group",
        workspace,
        entries,
      });
      const rows = await manager
        .createQueryBuilder()
        .select("r.request_id", "request_id")
        .from("pricing_reservations", "r")
        .where("r.workspace_id = :workspace AND r.id IN (:...ids)", {
          workspace,
          ids: entries.map((entry) => entry.reservationId),
        })
        .getRawMany<{ request_id: string }>();
      if (
        rows.length !== entries.length ||
        new Set(rows.map((row) => row.request_id)).size !== rows.length
      )
        this.missing();
      // Same order as grouped dispatch: request locks, reservation locks, then intent locks.
      for (const requestId of rows.map((row) => row.request_id).sort())
        await this.requireRequest(manager, requestId, workspace, true);
      const intents: CostSettlementIntentRow[] = [];
      for (const entry of [...entries].sort((a, b) =>
        a.reservationId < b.reservationId ? -1 : 1,
      )) {
        const row = await this.reservation(
          manager,
          entry.reservationId,
          workspace,
          true,
        );
        if (!row) this.missing();
        const { payload } = entry;
        this.quantity(payload.tokens, true);
        this.quantity(payload.cost_usd);
        intents.push(
          await this.queueSettlementInTransaction(manager, row, {
            ...payload,
            tokens: ExactDecimal.parse(payload.tokens).toFixed(0),
            cost_usd: ExactDecimal.parse(payload.cost_usd).toFixed(18),
            receipt: payload.receipt
              ? {
                  ...payload.receipt,
                  errorCode: payload.receipt.errorCode ?? null,
                }
              : null,
            ...(payload.receipts?.length
              ? {
                  receipts: payload.receipts
                    .map((receipt) => ({
                      ...receipt,
                      errorCode: receipt.errorCode ?? null,
                    }))
                    .sort((a, b) => (a.attemptId < b.attemptId ? -1 : 1)),
                }
              : {}),
          }),
        );
      }
      return intents;
    });
  }

  /** Second durable boundary. Receipt, budget effect and applied marker are atomic. */
  async applySettlement(
    id: string,
    workspace: string,
  ): Promise<CostReservationRow> {
    return this.write(async (manager) => {
      const row = await this.reservation(manager, id, workspace, true);
      if (!row) this.missing();
      const intent = await this.settlementIntent(manager, id, workspace, true);
      if (!intent) this.missing();
      return this.applySettlementInTransaction(manager, row, intent);
    });
  }

  private async queueSettlementInTransaction(
    manager: EntityManager,
    row: CostReservationRow,
    payload: CostSettlementPayload,
    actualBudgetAuthorized = false,
  ): Promise<CostSettlementIntentRow> {
    const receipts = this.validateSettlementProposal(row, payload, actualBudgetAuthorized);
    const attempts = await this.receiptAttemptsUnderRequest(manager, row, receipts);
    for (const receipt of receipts) {
      const attempt = attempts.get(receipt.attemptId)!;
      if (
        attempt.state === "terminal" &&
        (attempt.cost_hash !== pricingContentHash(receipt.cost) ||
          attempt.error_code !== (receipt.errorCode ?? null))
      )
        this.conflict(
          "Settlement receipt differs from immutable attempt evidence",
        );
    }
    return this.writeSettlementIntent(manager, row, payload);
  }

  private validateSettlementProposal(
    row: CostReservationRow,
    payload: CostSettlementPayload,
    actualBudgetAuthorized = false,
  ): Array<NonNullable<CostSettlementPayload["receipt"]>> {
    if ((row.budget_basis === "actual_upstream" || payload.budget_basis === "actual_upstream") && !actualBudgetAuthorized)
      this.conflict("Actual-upstream holds require a verified complete expense cohort, not a logical winner or release");
    this.quantity(payload.tokens, true);
    this.quantity(payload.cost_usd);
    this.text(payload.budget_basis);
    if (payload.kind !== "commit" && payload.kind !== "release")
      this.conflict("Unknown settlement kind");
    if (
      payload.kind === "release" &&
      (ExactDecimal.parse(payload.tokens).compare(ExactDecimal.zero) !== 0 ||
        ExactDecimal.parse(payload.cost_usd).compare(ExactDecimal.zero) !== 0)
    )
      this.conflict("A release cannot commit usage");
    const receipts = this.settlementReceipts(payload);
    for (const receipt of receipts) this.validateCost(receipt.cost);
    if (
      row.state !== "reserved" &&
      (row.state !== (payload.kind === "commit" ? "committed" : "released") ||
        ExactDecimal.parse(row.committed_tokens).compare(
          ExactDecimal.parse(payload.tokens),
        ) !== 0 ||
        ExactDecimal.parse(row.committed_cost_usd).compare(
          ExactDecimal.parse(payload.cost_usd),
        ) !== 0)
    )
      this.conflict("Terminal budget settlement is immutable");
    return receipts;
  }

  /** Internal storage step. Queue-only callers preflight receipts; composed callers
   * must apply/validate them before this same owned transaction may commit. */
  private async writeSettlementIntent(
    manager: EntityManager,
    row: CostReservationRow,
    payload: CostSettlementPayload,
  ): Promise<CostSettlementIntentRow> {
    const hash = pricingContentHash(payload);
    const prior = await this.settlementIntent(
      manager,
      row.id,
      row.workspace_id,
      true,
    );
    if (prior) {
      if (prior.payload_hash !== hash)
        this.conflict(
          "A durable terminal intent cannot be replaced with different usage or outcome",
        );
      return prior;
    }
    const now = new Date().toISOString();
    const intent: CostSettlementIntentRow = {
      reservation_id: row.id,
      request_id: row.request_id,
      workspace_id: row.workspace_id,
      payload_json: JSON.stringify(payload),
      payload_hash: hash,
      state: "pending",
      attempt_count: 0,
      next_attempt_at: now,
      last_error_code: null,
      created_at: now,
      applied_at: null,
    };
    await manager
      .createQueryBuilder()
      .insert()
      .into("pricing_settlement_intents")
      .values(intent)
      .execute();
    return intent;
  }

  private normalizeSettlementPayload(
    payload: CostSettlementPayload,
  ): CostSettlementPayload {
    return {
      kind: payload.kind,
      tokens: ExactDecimal.parse(payload.tokens).toFixed(0),
      cost_usd: ExactDecimal.parse(payload.cost_usd).toFixed(18),
      budget_basis: payload.budget_basis,
      ...(payload.budget_attempt_id
        ? { budget_attempt_id: payload.budget_attempt_id }
        : {}),
      receipt: payload.receipt
        ? { ...payload.receipt, errorCode: payload.receipt.errorCode ?? null }
        : null,
      ...(payload.receipts?.length
        ? {
            receipts: payload.receipts
              .map(entry => ({ ...entry, errorCode: entry.errorCode ?? null }))
              .sort((a, b) => a.attemptId.localeCompare(b.attemptId)),
          }
        : {}),
    };
  }

  /** Bind an internal acknowledgement to the exact retained request/hold, never just a caller-supplied row ID. */
  private deliveryOutcome(
    delivery: RuntimeOutcomeRow,
    id: string | undefined,
    reservation: Pick<CostReservationRow, "id" | "request_id" | "workspace_id">,
  ): PricingOutcome {
    const outcome = JSON.parse(delivery.outcome_json) as PricingOutcome;
    if (
      delivery.id !== id ||
      delivery.workspace_id !== reservation.workspace_id ||
      delivery.request_id !== reservation.request_id ||
      delivery.reservation_id !== reservation.id ||
      outcome.workspace !== reservation.workspace_id ||
      outcome.reservationId !== reservation.id
    )
      this.conflict("Runtime acknowledgement differs from the delivered reservation");
    return outcome;
  }

  private async applySettlementInTransaction(
    manager: EntityManager,
    row: CostReservationRow,
    intent: CostSettlementIntentRow,
    acknowledgeReceipts = false,
    jointDelivery?: RuntimeOutcomeRow,
    completion?: PendingSettlementLogs,
  ): Promise<CostReservationRow> {
    let payload: CostSettlementPayload;
    try {
      payload = JSON.parse(intent.payload_json) as CostSettlementPayload;
    } catch {
      this.conflict("Settlement intent is not valid JSON");
    }
    if (
      pricingContentHash(payload) !== intent.payload_hash ||
      intent.request_id !== row.request_id
    )
      this.conflict("Settlement intent integrity check failed");
    this.quantity(payload.tokens, true);
    this.quantity(payload.cost_usd);
    for (const receipt of this.settlementReceipts(payload))
      this.validateCost(receipt.cost);
    if (intent.state === "applied" && row.state === "reserved")
      this.conflict(
        "Applied intent is inconsistent with its reservation state",
      );
    return this.settleInTransaction(manager, row, intent, payload, acknowledgeReceipts, jointDelivery, completion);
  }

  /** These owner-only records remain tentative until the same transaction also
   * applies its budget counters/effect and commits. Do not retain globally shared
   * budget locks while writing unrelated request metadata. */
  private async writeSettlementCompletion(
    manager: EntityManager,
    row: CostReservationRow,
    intent: CostSettlementIntentRow,
    logProjection: CallLogCostProjection | null,
    completion?: PendingSettlementLogs,
    patch?: SettlementReservationPatch,
  ): Promise<void> {
    if (!(await tryWriteSettlementMetadata(manager, row, intent, logProjection, patch))) {
      if (patch) await manager.createQueryBuilder().update("pricing_reservations").set(patch)
        .where("id = :id AND workspace_id = :workspace AND state = :state", {
          id: row.id, workspace: row.workspace_id, state: "reserved",
        }).execute();
      if (intent.state !== "applied")
        await manager
          .createQueryBuilder()
          .update("pricing_settlement_intents")
          .set({
            state: "applied",
            applied_at: new Date().toISOString(),
            last_error_code: null,
          })
          .where("reservation_id = :id AND workspace_id = :workspace", {
            id: row.id,
            workspace: row.workspace_id,
          })
          .execute();
      await resolveRecoveryCase(manager, row.id, row.workspace_id);
      await this.writeCallLogProjection(manager, row.request_id, row.workspace_id, logProjection);
    }
    // The projection was validated from the full receipt/history graph inside
    // THIS request transaction. Never reuse it across a commit boundary.
    if (completion && row.state === "reserved" && logProjection)
      await this.writeSettlementLogs(manager, row, logProjection, completion);
  }

  private async writeSettlementLogs(
    manager: EntityManager,
    row: CostReservationRow,
    projection: CallLogCostProjection,
    completion: PendingSettlementLogs,
  ): Promise<void> {
    const { call, route } = completion.input;
    for (const log of route ? [call, route] : [call]) {
      if (log.request_id !== row.request_id || normalizeWorkspaceId(log.workspace_id) !== row.workspace_id)
        this.conflict("Joined logging differs from the settlement request");
    }
    call.cost_usd = projection.costUsd;
    call.cost_without_cache_usd = null;
    try {
      // Optional logging must not abort confirmed expense settlement. An actual
      // savepoint, not a swallowed PostgreSQL error, restores transaction health.
      completion.saved = await manager.transaction(async nested => {
        if (canInsertSettlementLogPair(nested, completion.input))
          return (await insertSettlementLogPair(nested, completion.input)).call;
        if (route) await nested.getRepository(RouteDecisionLog).save(route);
        return nested.getRepository(CallLog).save(call);
      });
    } catch {
      completion.saved = null;
      // Fallback logging runs after the owning settlement, with a fresh ledger
      // projection. A failed savepoint/connection still fails later money writes.
      if (!manager.queryRunner?.isTransactionActive)
        this.conflict("Joined log rollback lost the owning transaction");
    }
  }

  private async settleInTransaction(
    manager: EntityManager,
    row: CostReservationRow,
    intent: CostSettlementIntentRow,
    payload: CostSettlementPayload,
    acknowledgeReceipts = false,
    jointDelivery?: RuntimeOutcomeRow,
    completion?: PendingSettlementLogs,
  ): Promise<CostReservationRow> {
    const { kind, tokens, cost_usd: costUsd, budget_basis: basis } = payload;
    const workspace = row.workspace_id;
    const state = kind === "commit" ? "committed" : "released";
    const receipts = this.settlementReceipts(payload);
    const attempts = await this.receiptAttemptsUnderRequest(manager, row, receipts);
    if (row!.state !== "reserved") {
      if (
        row!.state !== state ||
        ExactDecimal.parse(row!.committed_tokens).compare(
          ExactDecimal.parse(tokens),
        ) !== 0 ||
        ExactDecimal.parse(row!.committed_cost_usd).compare(
          ExactDecimal.parse(costUsd),
        ) !== 0
      )
        this.conflict("Terminal budget settlement is immutable");
      for (const receipt of receipts) {
        const attempt = attempts.get(receipt.attemptId)!;
        if (
          attempt.state !== "terminal" ||
          attempt.cost_hash !== pricingContentHash(receipt.cost) ||
          attempt.error_code !== (receipt.errorCode ?? null)
        )
          this.conflict(
            "Terminal settlement cannot accept different or missing receipt evidence",
          );
      }
      if (acknowledgeReceipts) await this.settlementRuntimeReceipts(manager, row, receipts, true, jointDelivery);
      const logProjection = await this.prepareCallLogProjection(manager, row.request_id, workspace);
      await this.writeSettlementCompletion(manager, row, intent, logProjection, completion);
      return row;
    }
    const identity = JSON.parse(row!.identity_json) as BudgetLedgerIdentity;
    if (identity.workspaceId !== workspace) this.missing();
    const pendingReceipts: typeof receipts = [];
    for (const receipt of receipts) {
      const attempt = attempts.get(receipt.attemptId)!;
      const hash = pricingContentHash(receipt.cost);
      if (
        attempt!.state === "terminal" &&
        (attempt!.cost_hash !== hash ||
          attempt!.error_code !== (receipt.errorCode ?? null))
      )
        this.conflict(
          "Committed usage differs from the immutable attempt receipt",
        );
      if (attempt!.state !== "terminal") pendingReceipts.push(receipt);
    }
    // A pending attempt may already have an independently retained immutable
    // receipt. Never replace it with a different proposal merely because its
    // terminal projection has not been delivered yet.
    await this.settlementRuntimeReceipts(manager, row, acknowledgeReceipts ? receipts : pendingReceipts, acknowledgeReceipts, jointDelivery);
    for (const receipt of pendingReceipts) {
      await manager
          .createQueryBuilder()
          .update("pricing_attempts")
          .set({
            state: "terminal",
            completed_at: new Date().toISOString(),
            cost_json: JSON.stringify(receipt.cost),
            cost_hash: pricingContentHash(receipt.cost),
            error_code: receipt.errorCode ?? null,
          })
          .where("id = :attempt AND workspace_id = :workspace", {
            attempt: receipt.attemptId,
            workspace,
          })
          .execute();
    }
    // Request ownership already fences all receipt/adjustment writers. Verify
    // the same full cost evidence before taking globally shared budget locks.
    // The following request-owned writes and the later budget mutation share one
    // commit/rollback boundary; none can advertise completion independently.
    const logProjection = await this.prepareCallLogProjection(manager, row.request_id, workspace);
    const patch = {
      state,
      committed_tokens: tokens,
      committed_cost_usd: costUsd,
      budget_basis: basis ?? row!.budget_basis,
      updated_at: new Date().toISOString(),
    } as const;
    await this.writeSettlementCompletion(manager, row, intent, logProjection, completion, patch);
    // Scope discovery, epoch checks and balance hydration still happen freshly
    // inside the budget writer, after this metadata phase, never from a plan
    // captured while another budget writer could still be active.
    const allocations = await (row.budget_basis === "actual_upstream" ? this.budgets.settleOriginalLedger.bind(this.budgets) : this.budgets.settleLedger.bind(this.budgets))(
      manager,
      identity,
      JSON.parse(row.holds_json) as BudgetLedgerHold[],
      tokens,
      costUsd,
    );
    await this.effect(manager, row, kind, tokens, costUsd, allocations);
    return { ...row, ...patch };
  }

  /** Called under the reservation's request fence, before shared budget locks. */
  private async settlementRuntimeReceipts(
    manager: EntityManager,
    reservation: CostReservationRow,
    receipts: Array<NonNullable<CostSettlementPayload["receipt"]>>,
    acknowledge: boolean,
    jointDelivery?: RuntimeOutcomeRow,
  ): Promise<void> {
    if (acknowledge) {
      for (let offset = 0; offset < receipts.length; offset += 128)
        await acknowledgeSettlementReceipts(manager, reservation, receipts.slice(offset, offset + 128), offset === 0 ? jointDelivery : undefined);
      if (!receipts.length && jointDelivery) await acknowledgeSettlementReceipts(manager, reservation, [], jointDelivery);
      return;
    }
    const chunkSize = 900;
    for (let offset = 0; offset < receipts.length; offset += chunkSize) {
      const chunk = receipts.slice(offset, offset + chunkSize);
      // Discover bounded identities without loading every alternate body. Only
      // the exact expected document for each subject may be read and applied.
      const subjects = await manager.createQueryBuilder().select("o.subject_id", "subject_id").distinct(true).from("pricing_runtime_outcomes", "o")
        .where("o.workspace_id = :workspace AND o.kind = :kind AND o.subject_id IN (:...ids)", {
          workspace: reservation.workspace_id, kind: "attempt", ids: chunk.map(receipt => receipt.attemptId),
        }).getRawMany<{ subject_id: string }>();
      const identities = new Set(subjects.map(row => row.subject_id));
      // Direct durable intents need not have an inbox predecessor.
      const expected = chunk.filter(receipt => identities.has(receipt.attemptId)).map(receipt => runtimeOutcomeDocument({
        type: "attempt", workspace: reservation.workspace_id, reservationId: reservation.id,
        attemptId: receipt.attemptId, cost: receipt.cost, errorCode: receipt.errorCode ?? null,
      }));
      if (!expected.length) continue;
      const retained = await manager.createQueryBuilder().select("o.*").from("pricing_runtime_outcomes", "o")
        .where("o.workspace_id = :workspace AND o.id IN (:...ids)", {
          workspace: reservation.workspace_id, ids: expected.map(document => document.id),
        }).getRawMany<RuntimeOutcomeRow>();
      const byId = new Map(retained.map(row => [row.id, row]));
      for (const document of expected) {
        const retainedReceipt = byId.get(document.id);
        if (!retainedReceipt) this.conflict("Settlement differs from independently retained receipt evidence");
        this.deliveryOutcome(retainedReceipt, document.id, reservation);
        await assertOutcomeUndisposed(manager, retainedReceipt.id, reservation.workspace_id);
        await verifyRuntimeOutcome(manager, retainedReceipt);
        if (retainedReceipt.state === "review_required") this.conflict("Retained receipt requires review before settlement");
      }
    }
  }

  async beginAttempt(input: {
    id: string;
    requestId: string;
    workspace: string;
    reservationId?: string;
    target: PricingTarget;
    feeSource: CostAttemptRow["fee_source"];
    dispatchedAt: string;
    priceContext: AttemptPriceContext;
    mediaTask?: MediaTaskRow;
  }): Promise<void> {
    // Capture before availability/serialization can yield. The request whose
    // fence is acquired must remain the owner of the eventual dispatch row.
    const captured = structuredClone(input);
    await this.write(
      manager => this.beginAttemptInTransaction(manager, captured),
      manager => this.prepareDispatchPrelude(manager, captured),
    );
  }

  /** Prepare every participant before a shared provider dispatch; any invalid member rolls back the whole group. */
  async beginAttemptGroup(
    inputs: Array<Parameters<CostLedgerService["beginAttempt"]>[0]>,
    members?: EmbeddingBatchMember[],
  ): Promise<void> {
    if (!inputs.length || inputs.length > 1024)
      this.conflict("Invalid batch dispatch size");
    inputs = structuredClone(inputs);
    const workspace = inputs[0].workspace;
    const requests = new Set<string>(),
      reservations = new Set<string>(),
      ids = new Set<string>();
    for (const input of inputs) {
      if (
        input.workspace !== workspace ||
        !input.reservationId ||
        input.mediaTask ||
        input.feeSource !== "provider" ||
        requests.has(input.requestId) ||
        reservations.has(input.reservationId) ||
        ids.has(input.id)
      )
        this.conflict(
          "Batch dispatch requires distinct, same-workspace reserved requests",
        );
      requests.add(input.requestId);
      reservations.add(input.reservationId);
      ids.add(input.id);
    }
    await this.write(async (manager) => {
      for (const requestId of [...requests].sort())
        await this.requireRequest(manager, requestId, workspace, true);
      let signature: string | undefined;
      for (const input of [...inputs].sort((a, b) =>
        a.reservationId! < b.reservationId! ? -1 : 1,
      )) {
        const reservation = await this.reservation(
          manager,
          input.reservationId!,
          workspace,
          true,
        );
        if (!reservation || reservation.request_id !== input.requestId)
          this.missing();
        const estimate = JSON.parse(
          reservation.estimate_json,
        ) as CostComputation;
        const snapshot = await manager
          .createQueryBuilder()
          .select("s.catalog_revision_id", "catalog_revision_id")
          .from("pricing_request_snapshots", "s")
          .where("s.request_id = :request AND s.workspace_id = :workspace", {
            request: input.requestId,
            workspace,
          })
          .getRawOne<{ catalog_revision_id: string }>();
        const current = pricingContentHash({
          identity: JSON.parse(reservation.identity_json),
          target: JSON.parse(reservation.target_json),
          catalog: snapshot?.catalog_revision_id,
          price: [
            estimate.book_id,
            estimate.version_id,
            estimate.content_hash,
            estimate.fx_version_id,
          ],
          policy: estimate.admission?.policy_hash ?? null,
        });
        if (signature !== undefined && signature !== current)
          this.conflict(
            "Batch members have different tenant, target, price, FX or policy snapshots",
          );
        signature = current;
        if (
          pricingContentHash(input.target) !==
          pricingContentHash(JSON.parse(reservation.target_json))
        )
          this.conflict("Batch dispatch target differs from its reservation");
      }
      if (members) inputs = await prepareBatchManifest(manager, inputs, members);
      for (const input of [...inputs].sort((a, b) => (a.id < b.id ? -1 : 1)))
        await this.beginAttemptInTransaction(manager, input);
    });
  }

  /** Single dispatches already name their request. Keep the real request fence
   * first, then read the complete scoped reservation/attempt/intent in separate
   * server statements before application validation. No generic child-to-parent
   * lookup shortcut, cross-transaction cache or prevalidated caller rows.
   */
  private prepareDispatchPrelude(
    manager: EntityManager,
    input: Parameters<CostLedgerService["beginAttempt"]>[0],
  ): PostgresTransactionReadPrelude<void> | null {
    if (!input.reservationId) return null;
    this.text(input.id); this.text(input.workspace); parsePricingInstant(input.dispatchedAt);
    const parameters = { request: input.requestId, workspace: input.workspace, reservation: input.reservationId, attempt: input.id };
    const hasRequest = "EXISTS (SELECT 1 FROM pricing_request_snapshots owner WHERE owner.request_id = :request AND owner.workspace_id = :workspace)";
    const hasReservation = "EXISTS (SELECT 1 FROM pricing_reservations hold WHERE hold.id = :reservation AND hold.request_id = :request AND hold.workspace_id = :workspace)";
    const selects = [
      manager.createQueryBuilder().select("s.request_id", "request_id").from("pricing_request_snapshots", "s")
        .where("s.request_id = :request AND s.workspace_id = :workspace", parameters).setLock("pessimistic_write"),
      manager.createQueryBuilder().select("r.*").from("pricing_reservations", "r")
        .where("r.id = :reservation AND r.request_id = :request AND r.workspace_id = :workspace", parameters)
        .andWhere(hasRequest).setLock("pessimistic_write", undefined, ["r"]),
      manager.createQueryBuilder().select("a.*").from("pricing_attempts", "a")
        .where("a.id = :attempt AND a.workspace_id = :workspace", parameters).andWhere(hasRequest).andWhere(hasReservation),
      manager.createQueryBuilder().select("i.*").from("pricing_settlement_intents", "i")
        .where("i.reservation_id = :reservation AND i.workspace_id = :workspace", parameters).andWhere(hasRequest).andWhere(hasReservation),
    ];
    const program = createPostgresReadProgram(selects.map(query => {
      const [sql, parameters] = query.getQueryAndParameters(); return { sql, parameters };
    }));
    return program ? { program, apply: (owner, rows) => this.beginAttemptInTransaction(owner, input, rows) } : null;
  }

  private async beginAttemptInTransaction(
    manager: EntityManager,
    input: Parameters<CostLedgerService["beginAttempt"]>[0],
    preloaded?: Record<string, unknown>[][],
  ): Promise<void> {
    this.text(input.id);
    this.text(input.workspace);
    parsePricingInstant(input.dispatchedAt);
    if (preloaded) {
      this.requireLockTransaction(manager);
      if (preloaded.length !== 4 || preloaded.some(rows => rows.length > 1))
        this.conflict("Dispatch prelude returned ambiguous ownership");
      if (!preloaded[0].length) this.missing();
    } else await this.requireRequest(manager, input.requestId, input.workspace, true);
    const reservation = input.reservationId
      ? preloaded ? preloaded[1][0] as unknown as CostReservationRow | undefined
        : await this.reservationUnderRequest(manager, input.reservationId, input.requestId, input.workspace)
      : undefined;
    if (input.reservationId) {
      if (!reservation) this.missing();
    }
    const existing = preloaded ? preloaded[2][0] as unknown as CostAttemptRow | undefined
      : await this.attempt(manager, input.id, input.workspace);
    const context = JSON.stringify(input.priceContext);
    if (existing) {
      if (
        existing.request_id !== input.requestId ||
        pricingContentHash(JSON.parse(existing.price_context_json)) !==
          pricingContentHash(input.priceContext) ||
        existing.reservation_id !== (input.reservationId ?? null) ||
        existing.node_id !== (input.target.node_id ?? "") ||
        existing.model !== input.target.model ||
        existing.fee_source !== input.feeSource ||
        existing.dispatched_at !== input.dispatchedAt
      )
        this.conflict("Attempt identity was reused");
      return;
    }
    if (input.reservationId) {
      if (reservation?.state !== "reserved")
        this.conflict("A terminal reservation cannot dispatch another attempt");
      if (reservation!.budget_basis === "actual_upstream") {
        const snapshot = await this.prices.restoreRequestInTransaction(manager, reservation!.request_id, input.workspace);
        const originalTarget = JSON.parse(reservation!.target_json) as PricingTarget;
        const policy = snapshot.admissionPolicy(originalTarget.operation);
        if (policy.token_budget === "not_applicable" && (originalTarget.operation !== input.target.operation || !tokenBudgetCompatible(snapshot, input.target, policy)))
          this.conflict("Attempt cannot bypass its original non-token price contract");
      }
      if (reservation!.budget_basis === "actual_upstream" && await readActualBudgetCohort(manager, input.reservationId, input.workspace))
        this.conflict("A closed actual-upstream cohort cannot dispatch another attempt");
      if (
        preloaded ? preloaded[3][0] : await this.settlementIntent(
          manager,
          input.reservationId,
          input.workspace,
          false,
        )
      )
        this.conflict("A queued terminal settlement fences further dispatch");
    }
    const row: CostAttemptRow = {
      id: input.id,
      request_id: input.requestId,
      workspace_id: input.workspace,
      reservation_id: input.reservationId ?? null,
      node_id: input.target.node_id ?? "",
      model: input.target.model,
      state: "dispatched",
      fee_source: input.feeSource,
      dispatched_at: input.dispatchedAt,
      completed_at: null,
      price_context_json: context,
      cost_json: null,
      cost_hash: null,
      error_code: null,
    };
    await manager
      .createQueryBuilder()
      .insert()
      .into("pricing_attempts")
      .values(row)
      .execute();
    if (input.mediaTask) {
      const task = input.mediaTask;
      if (
        task.id !== input.id ||
        task.request_id !== input.requestId ||
        task.workspace_id !== input.workspace ||
        task.reservation_id !== input.reservationId
      )
        this.conflict("Media task does not match its reserved attempt");
      if (task.client_key_hash) {
        const claim = manager
          .createQueryBuilder()
          .select("c.*")
          .from("pricing_media_submissions", "c")
          .where("c.id = :id AND c.workspace_id = :workspace", {
            id: task.client_key_hash,
            workspace: task.workspace_id,
          });
        if (this.dataSource.options.type === "postgres")
          claim.setLock("pessimistic_write");
        const owner = await claim.getRawOne<{
          request_id: string;
          task_id: string | null;
        }>();
        if (!owner || owner.request_id !== task.request_id || owner.task_id)
          this.conflict("Media submission ownership changed before dispatch");
        await manager
          .createQueryBuilder()
          .update("pricing_media_submissions")
          .set({ task_id: task.id, state: "dispatched" })
          .where("id = :id AND workspace_id = :workspace", {
            id: task.client_key_hash,
            workspace: task.workspace_id,
          })
          .execute();
      }
      await manager
        .createQueryBuilder()
        .insert()
        .into("pricing_media_tasks")
        .values(task)
        .execute();
    }
  }

  /** Trusted metering/reconciliation callers supply a computation from the frozen request context. */
  async adjustAttempt(input: CostAdjustmentInput): Promise<CostAdjustmentView> {
    return this.computeAttemptAdjustment(input, false);
  }

  /** Same original-reservation calculation, without writes, budget observers or log projection. */
  async previewAttemptAdjustment(input: CostAdjustmentInput): Promise<CostAdjustmentView> {
    return this.computeAttemptAdjustment(input, true);
  }

  private async computeAttemptAdjustment(input: CostAdjustmentInput, dryRun: boolean): Promise<CostAdjustmentView> {
    if (!(await this.available())) this.missing();
    this.text(input.id);
    this.text(input.actorId);
    this.text(input.attemptId);
    this.text(input.workspace);
    if (
      !/^[a-f0-9]{64}$/.test(input.expectedCostHash) ||
      typeof input.reason !== "string" ||
      !input.reason.trim() ||
      input.reason.length > 1000 ||
      !["provider_usage", "provider_job_result", "reconciliation"].includes(
        input.source,
      )
    )
      throw new PricingRepositoryError(
        "pricing_invalid_document",
        "Invalid adjustment provenance",
        400,
      );
    this.validateCost(input.cost);
    const run = async (manager: EntityManager) => {
      const initial = await this.attempt(
        manager,
        input.attemptId,
        input.workspace,
      );
      if (!initial) this.missing();
      await this.requireRequest(
        manager,
        initial.request_id,
        input.workspace,
        true,
      );
      const reservation = initial.reservation_id
        ? await this.reservation(
            manager,
            initial.reservation_id,
            input.workspace,
            true,
          )
        : null;
      const attempt = await this.attempt(
        manager,
        input.attemptId,
        input.workspace,
        true,
      );
      if (!attempt) this.missing();
      if ((JSON.parse(attempt.price_context_json) as AttemptPriceContext).batch)
        this.conflict(
          "Batch corrections require a conserved physical group adjustment, not an independent member overwrite",
        );
      const intent = reservation
        ? await this.settlementIntent(
            manager,
            reservation.id,
            input.workspace,
            true,
          )
        : null;
      const reused = await manager
        .createQueryBuilder()
        .select("a.attempt_id", "attempt_id")
        .from("pricing_cost_adjustments", "a")
        .where("a.id = :id AND a.workspace_id = :workspace", {
          id: input.id,
          workspace: input.workspace,
        })
        .getRawOne<{ attempt_id: string }>();
      if (reused && reused.attempt_id !== attempt.id)
        this.conflict("Adjustment identity belongs to another attempt");
      const result = await appendCostAdjustment(
        manager,
        this.budgets,
        input,
        attempt,
        reservation ?? null,
        intent ?? null,
        { dryRun },
      );
      if (result.created)
        await this.auditAdjustment(manager, input, attempt.request_id);
      if (!dryRun) await this.projectCallLogs(manager, attempt.request_id, input.workspace);
      return result.view;
    };
    return dryRun ? serializeDatabaseAccess(this.dataSource, () => this.dataSource.transaction(run)) : this.write(run);
  }

  async attemptCorrectionContext(attemptId: string, workspace: string) {
    this.text(attemptId); this.text(workspace);
    if (!(await this.available())) this.missing();
    return serializeDatabaseAccess(this.dataSource, () => this.dataSource.transaction((manager) => loadAttemptCorrection(manager, workspace, attemptId)));
  }

  async attemptCorrectionBasis(attemptId: string, workspace: string) {
    return (await this.attemptCorrectionContext(attemptId, workspace)).view;
  }

  async recordedAttemptCorrection(actor: PricingActor, attemptId: string, input: AttemptCorrectionInput) {
    if (!(await this.available())) this.missing();
    return serializeDatabaseAccess(this.dataSource, () => this.dataSource.transaction((manager) => recordedAttemptCorrection(manager, actor.workspace_id, attemptId, input.id, attemptCorrectionSignature(actor, attemptId, input))));
  }

  async attemptCorrectionStatus(workspace: string, attemptId: string, id: string) {
    this.text(workspace); this.text(attemptId); this.text(id);
    if (!(await this.available())) this.missing();
    const result = await serializeDatabaseAccess(this.dataSource, () => this.dataSource.transaction((manager) => recordedAttemptCorrection(manager, workspace, attemptId, id)));
    if (!result) this.missing();
    return { recorded: true as const, result };
  }

  /** Admin-normalized computation; the HTTP surface never accepts arbitrary prices or amounts. */
  async attestAttemptCorrection(actor: PricingActor, attemptId: string, input: AttemptCorrectionInput, cost: CostComputation, dryRun: boolean) {
    if (actor.role !== 'admin' || !actor.id || !actor.workspace_id) throw new PricingRepositoryError('pricing_permission_denied', 'Attempt correction requires workspace administration', 403);
    this.text(attemptId); this.text(input.id); this.validateCost(cost);
    if (!(await this.available())) this.missing();
    const run = async (manager: EntityManager) => {
      if (manager.connection.options.type === 'postgres') await manager.query('SELECT pg_advisory_xact_lock(hashtext($1::text), hashtext($2::text))', ['siftgate.attempt-attestation', `${manager.connection.options.schema ?? ''}:${attemptCorrectionAuditId(actor.workspace_id, input.id)}`]);
      const prior = await recordedAttemptCorrection(manager, actor.workspace_id, attemptId, input.id, attemptCorrectionSignature(actor, attemptId, input));
      if (prior) return { ...prior, dry_run: dryRun };
      const basis = await loadAttemptCorrection(manager, actor.workspace_id, attemptId);
      const result = await applyAttestedAttemptCorrection(manager, this.budgets, actor, attemptId, input, basis, cost, dryRun);
      if (!dryRun) await this.projectCallLogs(manager, basis.attempt.request_id, actor.workspace_id);
      return result;
    };
    return dryRun ? serializeDatabaseAccess(this.dataSource, () => this.dataSource.transaction(run)) : this.write(run);
  }

  /** Read-only correction basis; original membership and every member's latest revision are checked. */
  async batchCorrectionBasis(attemptId: string, workspace: string, correctionId?: string) {
    this.text(attemptId);
    this.text(workspace);
    if (!(await this.available())) this.missing();
    return serializeDatabaseAccess(this.dataSource, () =>
      this.dataSource.transaction(async (manager) => {
        const group = await loadBatchAdjustmentGroup(
          manager,
          workspace,
          attemptId,
          true,
        );
        const anchor = group.members.find(
          (member) => member.attempt.id === attemptId,
        )!;
        return {
          request_id: anchor.attempt.request_id,
          target: JSON.parse(anchor.reservation.target_json) as PricingTarget,
          pricing: JSON.parse(
            anchor.attempt.price_context_json,
          ) as AttemptPriceContext,
          physical: group.physical,
          ...(correctionId ? { recorded_physical: anchor.history.find(view=>view.cost.batch?.correction?.id===correctionId)?.cost.batch?.physical_cost ?? null } : {}),
          initial_physical: anchor.initial.batch!.physical_cost,
          physical_cost_hash: group.physicalHash,
        };
      }),
    );
  }

  /** A correction cannot change one share independently of the physical invocation. */
  async adjustBatch(
    input: BatchCostAdjustmentInput,
    dryRun = false,
  ): Promise<BatchCostAdjustmentResult> {
    this.text(input.id);
    this.text(input.attemptId);
    this.text(input.workspace);
    this.text(input.actorId);
    if (
      !/^[a-f0-9]{64}$/.test(input.expectedPhysicalCostHash) ||
      typeof input.reason !== "string" ||
      !input.reason.trim() ||
      input.reason.length > 1000 ||
      !["provider_usage", "provider_job_result", "reconciliation"].includes(
        input.source,
      )
    )
      throw new PricingRepositoryError(
        "pricing_invalid_document",
        "Invalid batch correction provenance",
        400,
      );
    this.validateCost(input.physicalCost);
    if (!(await this.available())) this.missing();
    const run = async (manager: EntityManager) => {
      const { result } = await appendBatchCostAdjustment(
        manager,
        this.budgets,
        input,
        dryRun,
      );
      if (!dryRun)
        for (const requestId of result.changes
          .map((change) => change.request_id)
          .sort())
          await this.projectCallLogs(manager, requestId, input.workspace);
      return result;
    };
    return dryRun
      ? serializeDatabaseAccess(this.dataSource, () =>
          this.dataSource.transaction(run),
        )
      : this.write(run);
  }

  /** Returns null for an unmigrated installation, so ordinary legacy logging is unchanged. */
  async persistCallLogs(logs: CallLog[], requireSnapshot = false): Promise<CallLog[] | null> {
    if (!(await this.available())) return null;
    return this.write(async (manager) => {
      const keys = new Map(
        logs.map((log) => [
          JSON.stringify([
            normalizeWorkspaceId(log.workspace_id),
            log.request_id,
          ]),
          {
            workspace: normalizeWorkspaceId(log.workspace_id),
            request: log.request_id,
          },
        ]),
      );
      const summaries = new Map<string, Pick<CostLedgerSummary, "known_subtotal"> | null>();
      // Batches lock requests in a stable order before touching log rows.
      for (const [key, identity] of [...keys].sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
      )) {
        const present = await manager
          .createQueryBuilder()
          .select("s.request_id")
          .from("pricing_request_snapshots", "s")
          .where("s.request_id = :id AND s.workspace_id = :workspace", {
            id: identity.request,
            workspace: identity.workspace,
          })
          .getRawOne();
        if (!present) {
          if (requireSnapshot) this.missing();
          continue;
        }
        await this.requireRequest(
          manager,
          identity.request,
          identity.workspace,
          true,
        );
        summaries.set(
          key,
          await this.summaryInTransaction(
            manager,
            identity.request,
            identity.workspace,
            "log",
          ),
        );
      }
      for (const log of logs) {
        const summary = summaries.get(
          JSON.stringify([
            normalizeWorkspaceId(log.workspace_id),
            log.request_id,
          ]),
        );
        if (summary || requireSnapshot) {
          log.cost_usd = Number(summary?.known_subtotal ?? "0");
          log.cost_without_cache_usd = null;
        }
      }
      return manager.getRepository(CallLog).save(logs);
    });
  }

  private async projectCallLogs(
    manager: EntityManager,
    requestId: string,
    workspace: string,
  ): Promise<void> {
    const projection = await this.prepareCallLogProjection(manager, requestId, workspace);
    await this.writeCallLogProjection(manager, requestId, workspace, projection);
  }

  private async prepareCallLogProjection(
    manager: EntityManager,
    requestId: string,
    workspace: string,
  ): Promise<CallLogCostProjection | null> {
    if (!this.dataSource.hasMetadata(CallLog)) return null;
    const summary = await this.summaryInTransaction(
      manager,
      requestId,
      workspace,
      "log",
    );
    return summary ? { costUsd: Number(summary.known_subtotal ?? "0") } : null;
  }

  private async writeCallLogProjection(
    manager: EntityManager,
    requestId: string,
    workspace: string,
    projection: CallLogCostProjection | null,
  ): Promise<void> {
    if (!projection) return;
    await manager
      .getRepository(CallLog)
      .update(workspaceFindWhere(workspace, { request_id: requestId }), {
        cost_usd: projection.costUsd,
        cost_without_cache_usd: null,
      });
  }

  private async auditAdjustment(
    manager: EntityManager,
    input: CostAdjustmentInput,
    request: string,
  ): Promise<void> {
    await manager
      .createQueryBuilder()
      .insert()
      .into("pricing_audit_events")
      .values({
        id: `cost-adjustment:${input.id}`,
        workspace_id: input.workspace,
        book_id: null,
        actor_id: input.actorId,
        action: "cost.adjustment",
        reason: input.reason,
        created_at: new Date().toISOString(),
        metadata_json: JSON.stringify({
          adjustment_id: input.id,
          request_id: request,
          attempt_id: input.attemptId,
          previous_hash: input.expectedCostHash,
          cost_hash: pricingContentHash(input.cost),
          source: input.source,
        }),
      })
      .execute();
  }

  async completeAttempt(
    id: string,
    workspace: string,
    cost: CostComputation,
    errorCode: string | null = null,
    runtimeOutcomeId?: string,
    delivery?: RuntimeOutcomeRow,
  ): Promise<void> {
    this.validateCost(cost);
    const costHash = pricingContentHash(cost);
    await this.write(async (manager) => {
      const row = await this.attempt(manager, id, workspace, true);
      if (!row) this.missing();
      await assertOutcomeUndisposed(manager, runtimeOutcomeId, workspace);
      if (delivery) {
        if (!row.reservation_id)
          this.conflict("Runtime acknowledgement requires an owned reservation");
        const outcome = this.deliveryOutcome(delivery, runtimeOutcomeId, {
          id: row.reservation_id,
          request_id: row.request_id,
          workspace_id: workspace,
        });
        if (
          outcome.type !== "attempt" ||
          outcome.attemptId !== id ||
          pricingContentHash(outcome.cost) !== costHash ||
          (outcome.errorCode ?? null) !== errorCode
        )
          this.conflict("Runtime acknowledgement differs from the delivered receipt");
      }
      if (row!.state === "terminal") {
        if (row!.cost_hash !== costHash || row!.error_code !== errorCode)
          this.conflict(
            "Use a linked adjustment for revised usage; terminal cost is immutable",
          );
        await this.projectCallLogs(manager, row!.request_id, workspace);
        if (delivery) await transitionRuntimeOutcome(manager, delivery, "delivered");
        return;
      }
      await manager
        .createQueryBuilder()
        .update("pricing_attempts")
        .set({
          state: "terminal",
          completed_at: new Date().toISOString(),
          cost_json: JSON.stringify(cost),
          cost_hash: costHash,
          error_code: errorCode,
        })
        .where("id = :id AND workspace_id = :workspace", { id, workspace })
        .execute();
      await this.projectCallLogs(manager, row!.request_id, workspace);
      if (delivery) await transitionRuntimeOutcome(manager, delivery, "delivered");
    });
  }

  /** Runtime-owned finality is retained before this delivery; missing usage keeps its hold pending. */
  private async closeActualBudget(outcome: Extract<PricingOutcome, { type: "actual_budget_closure" }>, delivery: RuntimeOutcomeRow): Promise<void> {
    await this.write(async manager => {
      const row = await this.reservation(manager, outcome.reservationId, outcome.workspace, true);
      if (!row) this.missing();
      if (row.budget_basis !== "actual_upstream") this.conflict("Closure is not authorized by the original budget basis");
      const acknowledged = this.deliveryOutcome(delivery, delivery.id, row);
      if (pricingContentHash(acknowledged) !== pricingContentHash(outcome)) this.conflict("Actual closure acknowledgement differs");
      await assertOutcomeUndisposed(manager, delivery.id, outcome.workspace);
      const cohort = await this.prepareActualBudgetCohort(manager, row, outcome.payload);
      await this.settleActualBudgetInTransaction(manager, row, cohort, delivery.id);
      await transitionRuntimeOutcome(manager, delivery, "delivered");
    });
  }

  /** Shared single/group runtime delivery; authority is checked by the owning delivery before entry. */
  private async prepareActualBudgetCohort(manager: EntityManager, row: CostReservationRow, payload: ActualBudgetStoredClosure): Promise<ActualBudgetCohortRow> {
    if (row.budget_basis !== "actual_upstream") this.conflict("Original budget policy does not authorize actual closure");
    const { media_authority: _authority, operator_authority, ...wire } = payload;
    if (operator_authority) this.conflict("Runtime/media preparation cannot forge operator authority");
    runtimeOutcomeDocument({ type: "actual_budget_closure", workspace: row.workspace_id, reservationId: row.id, payload: wire });
      const snapshot = await this.prices.restoreRequestInTransaction(manager, row.request_id, row.workspace_id);
      const policy = snapshot.admissionPolicy((JSON.parse(row.target_json) as PricingTarget).operation);
      if (policy.budget_basis !== "actual_upstream") this.conflict("The frozen policy does not authorize actual expenses");
      const ids = await manager.createQueryBuilder().select("a.id", "id").from("pricing_attempts", "a")
        .where("a.reservation_id = :id AND a.workspace_id = :workspace AND a.request_id = :request", { id: row.id, workspace: row.workspace_id, request: row.request_id })
        .orderBy("a.id", "ASC").limit(1025).getRawMany<{ id: string }>();
      if (ids.length > 1024 || pricingContentHash(ids.map(entry => entry.id)) !== pricingContentHash(payload.attempt_ids))
        this.conflict("Actual closure must include the complete dispatched cohort");
      const identity = { reservation_id: row.id, workspace_id: row.workspace_id, request_id: row.request_id, catalog_revision_id: snapshot.descriptor().catalog_revision_id, policy_hash: pricingContentHash(policy), closure: payload };
      const hash = pricingContentHash(identity);
      let cohort = await readActualBudgetCohort(manager, row.id, row.workspace_id);
      if (cohort && cohort.closure_hash !== hash) {
        const stored = actualBudgetClosure(cohort);
        if (!stored.operator_authority || pricingContentHash(stored.attempt_ids) !== pricingContentHash(payload.attempt_ids) ||
          (payload.missing_dispatch_evidence && !stored.missing_dispatch_evidence))
          this.conflict("A closed expense cohort cannot be replaced");
        // A late original worker can supply receipts only for the fenced population.
        // It cannot replace operator finality, its immutable audit or a budget debit.
      }
      for (const receipt of payload.receipts) {
        const attempt = await this.attempt(manager, receipt.attemptId, row.workspace_id, true);
        if (!attempt || attempt.reservation_id !== row.id || attempt.request_id !== row.request_id) this.missing();
        const costHash = pricingContentHash(receipt.cost), errorCode = receipt.errorCode ?? null;
        if (attempt.state === "terminal") {
          if (attempt.cost_hash !== costHash || attempt.error_code !== errorCode) this.conflict("Closure differs from immutable attempt evidence");
        } else await manager.createQueryBuilder().update("pricing_attempts").set({ state: "terminal", cost_json: JSON.stringify(receipt.cost), cost_hash: costHash, error_code: errorCode, completed_at: new Date().toISOString() })
          .where("id = :id AND workspace_id = :workspace", { id: receipt.attemptId, workspace: row.workspace_id }).execute();
      }
      if (!cohort) {
        const now = new Date().toISOString();
        cohort = { reservation_id: row.id, workspace_id: row.workspace_id, request_id: row.request_id, catalog_revision_id: identity.catalog_revision_id, policy_hash: identity.policy_hash, closure_hash: hash, closure_json: JSON.stringify(payload), state: "pending", created_at: now, updated_at: now, applied_plan_json: null, applied_plan_hash: null, last_error_code: null };
        await retainActualBudgetCohort(manager, cohort);
      }
    return cohort;
  }

  /** Every member fence and ready debit, plus the delivery acknowledgement, commit together. */
  private async closeActualBudgetGroup(outcome: Extract<PricingGroupOutcome, { type: "actual_budget_closure_group" }>, delivery: GroupOutcomeRow): Promise<void> {
    await this.write(async manager => {
      await assertRuntimeGroupDeliverable(manager, delivery.id, outcome);
      const prepared: Array<{ row: CostReservationRow; cohort: ActualBudgetCohortRow }> = [];
      for (const entry of [...outcome.entries].sort((a, b) => a.reservationId.localeCompare(b.reservationId))) {
        const row = await this.reservation(manager, entry.reservationId, outcome.workspace, true);
        if (!row) this.missing();
        prepared.push({ row, cohort: await this.prepareActualBudgetCohort(manager, row, entry.payload) });
      }
      for (const { row, cohort } of prepared) {
        await this.settleActualBudgetInTransaction(manager, row, cohort, delivery.id);
        await this.projectCallLogs(manager, row.request_id, row.workspace_id);
      }
      const acknowledged = await transitionRuntimeGroupOutcome(manager, delivery, "delivered");
      if (acknowledged.state !== "delivered") this.conflict("Actual group acknowledgement requires complete delivery");
    });
  }

  private async settleActualBudgetInTransaction(manager: EntityManager, row: CostReservationRow, cohort: ActualBudgetCohortRow, deliveringId?: string): Promise<boolean> {
    if (cohort.state === "review_required") this.conflict("Actual expense cohort requires explicit review before delivery");
    const closure = actualBudgetClosure(cohort);
    if (cohort.request_id !== row.request_id || cohort.workspace_id !== row.workspace_id || cohort.reservation_id !== row.id) this.conflict("Actual budget cohort scope differs");
    const snapshot = await this.prices.restoreRequestInTransaction(manager, row.request_id, row.workspace_id);
    const policy = snapshot.admissionPolicy((JSON.parse(row.target_json) as PricingTarget).operation);
    if (policy.budget_basis !== "actual_upstream" || row.budget_basis !== "actual_upstream" ||
      snapshot.descriptor().catalog_revision_id !== cohort.catalog_revision_id || pricingContentHash(policy) !== cohort.policy_hash)
      this.conflict("Actual budget replay differs from its immutable admission policy");
    if (cohort.state === "applied") {
      const intent = await this.settlementIntent(manager, row.id, row.workspace_id, true);
      if (!intent || intent.state !== "applied" || row.state === "reserved") this.conflict("Applied cohort is missing its budget effect");
      const plan = JSON.parse(cohort.applied_plan_json!) as ActualUpstreamBudgetPlan;
      const payload = JSON.parse(intent.payload_json) as CostSettlementPayload;
      if (pricingContentHash(payload) !== intent.payload_hash || payload.budget_basis !== "actual_upstream" || payload.kind !== plan.terminal_kind ||
        payload.cost_usd !== plan.cost_usd || payload.tokens !== (plan.upstream_tokens ?? "0") ||
        row.committed_cost_usd !== payload.cost_usd || row.committed_tokens !== payload.tokens ||
        row.state !== (plan.terminal_kind === "commit" ? "committed" : "released") ||
        (await actualBudgetAdjustmentBasis(manager, row)).base?.plan_hash !== plan.plan_hash)
        this.conflict("Applied actual budget evidence differs from its immutable settlement");
      return true;
    }
    const defer = async () => {
      // A permanently unknown old cohort must not starve later ready work.
      await manager.createQueryBuilder().update(ACTUAL_BUDGET_COHORT_TABLE).set({ updated_at: new Date().toISOString() })
        .where("reservation_id = :id AND workspace_id = :workspace", { id: row.id, workspace: row.workspace_id }).execute();
      return false;
    };
    const custody = await actualBudgetCustody(manager, row, deliveringId);
    if (closure.missing_dispatch_evidence || custody.missingDispatch || custody.pending.length) return defer();
    const mediaTask = await verifyActualMediaAuthority(manager, cohort, closure);
    if (mediaTask && await actualMediaCustodyPending(manager, mediaTask)) return defer();
    const plan = await this.actualBudgetPlan(manager, row, true);
    if (pricingContentHash(plan.contributions.map(entry => entry.attempt_id)) !== pricingContentHash(closure.attempt_ids)) this.conflict("Closed attempt membership changed");
    if (plan.state !== "ready" || plan.cost_usd === null || !plan.terminal_kind) return defer();
    const intent = await this.queueSettlementInTransaction(manager, row, {
      kind: plan.terminal_kind, tokens: plan.upstream_tokens ?? "0", cost_usd: plan.cost_usd,
      budget_basis: "actual_upstream", receipt: null, receipts: closure.receipts,
    }, true);
    await this.applySettlementInTransaction(manager, row, intent);
    await manager.createQueryBuilder().update(ACTUAL_BUDGET_COHORT_TABLE).set({ state: "applied", applied_plan_json: JSON.stringify(plan), applied_plan_hash: plan.plan_hash, updated_at: new Date().toISOString() })
      .where("reservation_id = :id AND workspace_id = :workspace", { id: row.id, workspace: row.workspace_id }).execute();
    return true;
  }

  /** Media task service passes only identities. Amounts and authority are re-read from the retained observation. */
  async processActualMediaObservation(taskId: string, workspace: string, observationId?: string): Promise<boolean | "deferred"> {
    this.text(taskId); this.text(workspace); if (observationId) this.text(observationId);
    if (!(await this.available())) this.missing();
    return this.write(async manager => {
      const initial = await manager.createQueryBuilder().select("t.*").from("pricing_media_tasks", "t")
        .where("t.id = :id AND t.workspace_id = :workspace", { id: taskId, workspace }).getRawOne<MediaTaskRow>();
      if (!initial) this.missing();
      const reservation = await this.reservation(manager, initial.reservation_id, workspace, true);
      if (!reservation || reservation.request_id !== initial.request_id) this.missing();
      if (reservation.budget_basis !== "actual_upstream") return false;
      const query = manager.createQueryBuilder().select("t.*").from("pricing_media_tasks", "t")
        .where("t.id = :id AND t.workspace_id = :workspace", { id: taskId, workspace });
      if (manager.connection.options.type === "postgres") query.setLock("pessimistic_write");
      const task = await query.getRawOne<MediaTaskRow>();
      if (!task || task.reservation_id !== reservation.id || task.request_id !== reservation.request_id || task.state === "synchronous") this.conflict("Actual media ownership differs");
      const frame = mediaTaskContext(task);
      if (!observationId && !task.terminal_at) return true;
      const snapshot = await this.prices.restoreRequestInTransaction(manager, task.request_id, workspace);
      if (snapshot.admissionPolicy(frame.operation).budget_basis !== "actual_upstream") this.conflict("Media task's original policy does not authorize actual expenses");
      let cohort = await readActualBudgetCohort(manager, reservation.id, workspace);
      if (observationId) {
        const observation = await manager.createQueryBuilder().select("o.*").from("pricing_media_observations", "o")
          .where("o.id = :id AND o.task_id = :task AND o.workspace_id = :workspace", { id: observationId, task: task.id, workspace }).getRawOne<MediaTaskObservationRow>();
        if (!observation) this.missing();
        verifyMediaObservation(task, observation);
        if (!task.terminal_at || observation.status === "pending" || !observation.cost_json || !observation.action || !observation.processing_hash)
          this.conflict("Actual media processing requires a prepared terminal observation");
        const auditId = actualMediaAuditId(workspace, observation.id), auditMetadata = actualMediaAuditMetadata(task, observation);
        const oldAudit = await manager.createQueryBuilder().select("a.metadata_json", "metadata_json").from("pricing_audit_events", "a")
          .where("a.id = :id AND a.workspace_id = :workspace AND a.action = :action", { id: auditId, workspace, action: "cost.actual_media_observation" }).getRawOne<{ metadata_json: string }>();
        if (observation.processed) {
          await verifyActualMediaAcknowledgement(manager, task, observation);
          if (cohort) await actualBudgetAdjustmentBasis(manager, reservation);
        } else {
        if (oldAudit) this.conflict("Actual media acknowledgement precedes its observation effect");
        const earlier = await manager.createQueryBuilder().select("o.id", "id").from("pricing_media_observations", "o")
          .where("o.task_id = :task AND o.workspace_id = :workspace AND o.processed = 0 AND o.revision < :revision", { task: task.id, workspace, revision: observation.revision }).limit(1).getRawOne();
        if (earlier) this.conflict("Process earlier retained media observations first");
        const usage = JSON.parse(observation.usage_json) as NormalizedUsage, context = JSON.parse(observation.context_json) as PricingContext;
        const quoted = snapshot.quote(frame.target, usage, context);
        const expected = !quoted.binding_id && frame.legacy_price ? calculateCost(usage, compilePriceBook(frame.legacy_price, { book_id: "legacy-config", version_id: `legacy-${frame.legacy_version}` }).resolve(usage, context), { report_currency: "USD" }) : quoted.cost;
        const cost = JSON.parse(observation.cost_json) as CostComputation;
        this.validateCost(cost);
        if (pricingContentHash(cost) !== pricingContentHash(expected)) this.conflict("Prepared media cost differs from its immutable price and observed context");
        const attempt = await this.attempt(manager, task.id, workspace, true);
        if (!attempt || attempt.request_id !== task.request_id || attempt.reservation_id !== reservation.id || attempt.fee_source !== "provider") this.conflict("Media attempt ownership differs");
        if (observation.action === "initial") {
          if (cohort || attempt.state !== "dispatched" || observation.expected_hash !== null) this.conflict("Initial actual media observation cannot replace an existing receipt or closure");
          await manager.createQueryBuilder().update("pricing_attempts").set({ state: "terminal", completed_at: new Date().toISOString(), cost_json: observation.cost_json,
            cost_hash: pricingContentHash(cost), error_code: observation.status === "completed" ? null : `media_job_${observation.status}` })
            .where("id = :id AND workspace_id = :workspace", { id: attempt.id, workspace }).execute();
        } else {
          if (!cohort) cohort = await this.closeReadyActualMediaCohort(manager, reservation);
          // A peer can still be submitting or awaiting its original receipt.
          // Keep this prepared correction durable; never invent dispatch finality.
          if (!cohort) return "deferred";
          if (observation.action === "adjustment") {
            const link = await manager.createQueryBuilder().select("d.event_record_id", "event_record_id").from("pricing_media_event_dispositions", "d")
              .where("d.observation_id = :id AND d.task_id = :task AND d.workspace_id = :workspace", { id: observation.id, task: task.id, workspace }).getRawOne<{ event_record_id: string }>();
            const disposition = link ? await readMediaDispositionRecord(manager, workspace, task.id, link.event_record_id) : null;
            const input: CostAdjustmentInput = { id: `media:${observation.id}`, attemptId: task.id, workspace, expectedCostHash: observation.expected_hash!, cost,
              actorId: disposition?.row.actor_id ?? "system:media-task", reason: disposition ? (JSON.parse(disposition.row.document_json) as { input: { reason: string } }).input.reason : "Provider task usage observation",
              source: disposition ? "reconciliation" : "provider_job_result" };
            const intent = await this.settlementIntent(manager, reservation.id, workspace, true);
            const changed = await appendCostAdjustment(manager, this.budgets, input, attempt, reservation, intent ?? null);
            if (changed.created) await this.auditAdjustment(manager, input, task.request_id);
          } else if (observation.action === "noop") {
            const history = await loadCostAdjustments(manager, task.request_id, workspace, [attempt]);
            if (pricingContentHash(cost) !== (history.get(attempt.id)?.at(-1)?.cost_hash ?? attempt.cost_hash)) this.conflict("No-op media observation differs from its effective receipt");
          } else this.conflict("Unsupported actual media processing action");
        }
        await manager.createQueryBuilder().insert().into("pricing_audit_events").values({ id: auditId, workspace_id: workspace, book_id: null, actor_id: "system:media-task",
          action: "cost.actual_media_observation", reason: "Apply a retained media observation under its original actual-budget policy", metadata_json: JSON.stringify(auditMetadata), created_at: new Date().toISOString() }).execute();
        await manager.createQueryBuilder().update("pricing_media_observations").set({ processed: 1 }).where("id = :id AND workspace_id = :workspace", { id: observation.id, workspace }).execute();
        }
      }
      if (!cohort) cohort = await this.closeReadyActualMediaCohort(manager, reservation);
      if (cohort) {
        const authority = actualBudgetClosure(cohort).media_authority;
        if (!authority || ![authority.task_id, ...(authority.siblings ?? []).map(member => member.task_id)].includes(task.id))
          this.conflict("Media task is outside the original closure authority");
        await this.settleActualBudgetInTransaction(manager, reservation, cohort);
        await this.refreshActualMediaTaskStates(manager, reservation);
      }
      await this.projectCallLogs(manager, task.request_id, workspace);
      return true;
    });
  }

  private async closeReadyActualMediaCohort(manager: EntityManager, reservation: CostReservationRow): Promise<ActualBudgetCohortRow | null> {
    const authority = await actualMediaClosureAuthority(manager, reservation.id, reservation.workspace_id, reservation.request_id);
    if (!authority) return null;
    const ids = await manager.createQueryBuilder().select("a.id", "id").from("pricing_attempts", "a")
      .where("a.reservation_id = :id AND a.workspace_id = :workspace", { id: reservation.id, workspace: reservation.workspace_id }).orderBy("a.id", "ASC").limit(1025).getRawMany<{ id: string }>();
    if (ids.length > 1024) this.conflict("Actual media population exceeds the closed-cohort bound");
    return this.prepareActualBudgetCohort(manager, reservation, { attempt_ids: ids.map(row => row.id), missing_dispatch_evidence: false, receipts: [], media_authority: authority });
  }

  /** Settlement can finish in the background, without another status poll of the anchor task. */
  private async refreshActualMediaTaskStates(manager: EntityManager, reservation: CostReservationRow): Promise<void> {
    const tasks = await readActualMediaTasks(manager, reservation.id, reservation.workspace_id, reservation.request_id);
    if (!tasks.length) return;
    const current = await this.reservation(manager, reservation.id, reservation.workspace_id, false);
    if (!current) this.missing();
    const basis = await actualBudgetAdjustmentBasis(manager, current);
    const complete = basis.cohort.state === "applied" && basis.effective.state === "ready" &&
      !await actualMediaCustodyPending(manager, { reservation_id: reservation.id, workspace_id: reservation.workspace_id, request_id: reservation.request_id });
    for (const task of tasks) {
      if (task.state === "synchronous" || !task.terminal_at) continue;
      await manager.createQueryBuilder().update("pricing_media_tasks").set({ state: complete ? "settled" : "terminal", updated_at: new Date().toISOString() })
        .where("id = :id AND workspace_id = :workspace", { id: task.id, workspace: task.workspace_id }).execute();
    }
  }

  /** Rechecks retained closures, never discovers or repeats supplier calls. */
  async reconcileActualBudgets(limit = 100): Promise<{ applied: number; pending: number; review_required: number }> {
    if (!(await this.available())) return { applied: 0, pending: 0, review_required: 0 };
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) this.conflict("Invalid actual-budget replay bound");
    const candidates = await serializeDatabaseAccess(this.dataSource, () => this.dataSource.manager.createQueryBuilder().select("c.reservation_id", "id").addSelect("c.workspace_id", "workspace")
      .from(ACTUAL_BUDGET_COHORT_TABLE, "c").where("c.state = :state", { state: "pending" }).orderBy("c.updated_at", "ASC").addOrderBy("c.reservation_id", "ASC").limit(limit).getRawMany<{ id: string; workspace: string }>());
    const result = { applied: 0, pending: 0, review_required: 0 };
    for (const item of candidates) {
      try {
      const applied = await this.write(async manager => {
        const row = await this.reservation(manager, item.id, item.workspace, true), cohort = await readActualBudgetCohort(manager, item.id, item.workspace);
        if (!row || !cohort) this.missing();
        const settled = await this.settleActualBudgetInTransaction(manager, row, cohort);
        if (actualBudgetClosure(cohort).media_authority) await this.refreshActualMediaTaskStates(manager, row);
        return settled;
      });
      if (applied) result.applied++; else result.pending++;
      } catch (error) {
        if (error instanceof PricingRepositoryError && [400, 404, 409].includes(error.status)) {
          // Quarantine this scoped record, without suppressing recovery of other requests.
          await this.write(async manager => {
            await this.reservation(manager, item.id, item.workspace, true);
            await manager.createQueryBuilder().update(ACTUAL_BUDGET_COHORT_TABLE).set({ state: "review_required", last_error_code: error.code, updated_at: new Date().toISOString() })
              .where("reservation_id = :id AND workspace_id = :workspace AND state = :pending", { id: item.id, workspace: item.workspace, pending: "pending" }).execute();
          });
          result.review_required++;
        } else result.pending++;
      }
    }
    return result;
  }

  /** Shared physical outcome and optional terminal member intents commit together, never a partial allocation. */
  async completeAttemptGroup(
    workspace: string,
    entries: Array<{
      id: string;
      cost: CostComputation;
      errorCode?: string;
      settlement?: CostSettlementPayload;
    }>,
    runtimeGroupOutcomeId?: string,
  ): Promise<void> {
    if (
      !entries.length ||
      entries.length > 1024 ||
      new Set(entries.map((entry) => entry.id)).size !== entries.length
    )
      this.conflict("Invalid shared outcome group");
    for (const entry of entries) this.validateCost(entry.cost);
    const batch = entries[0].cost.batch;
    if (!batch || batch.members.length !== entries.length)
      this.conflict("Incomplete shared physical outcome");
    const membershipHash = pricingContentHash(batch.members);
    if (
      entries.some(
        (entry) =>
          !entry.cost.batch ||
          entry.cost.batch.physical_attempt_id !== batch.physical_attempt_id ||
          entry.cost.batch.physical_cost_hash !== batch.physical_cost_hash ||
          pricingContentHash(entry.cost.batch.members) !== membershipHash,
      ) ||
      new Set(entries.map((entry) => entry.cost.batch!.member_index)).size !==
        entries.length
    )
      this.conflict("Inconsistent shared physical outcome");
    await this.write(async (manager) => {
      await assertRuntimeGroupDeliverable(manager, runtimeGroupOutcomeId, {
        type: "attempt_group",
        workspace,
        entries,
      });
      for (const member of [...batch.members].sort((a, b) =>
        a.request_id < b.request_id ? -1 : 1,
      ))
        await this.requireRequest(manager, member.request_id, workspace, true);
      const reservations = new Map<string, CostReservationRow>();
      for (const member of [...batch.members].sort((a, b) =>
        a.reservation_id < b.reservation_id ? -1 : 1,
      )) {
        const reservation = await this.reservation(
          manager,
          member.reservation_id,
          workspace,
          true,
        );
        if (!reservation || reservation.request_id !== member.request_id)
          this.missing();
        reservations.set(member.reservation_id, reservation);
      }
      for (const entry of [...entries].sort((a, b) => (a.id < b.id ? -1 : 1))) {
        const member = batch.members[entry.cost.batch!.member_index];
        const row = await this.attempt(manager, entry.id, workspace, true);
        if (
          !row ||
          row.request_id !== member.request_id ||
          row.reservation_id !== member.reservation_id
        )
          this.missing();
        const dispatch = (
          JSON.parse(row.price_context_json) as AttemptPriceContext
        ).batch;
        if (
          !dispatch ||
          dispatch.physical_attempt_id !== batch.physical_attempt_id ||
          dispatch.batch_id !== batch.batch_id ||
          dispatch.member_index !== entry.cost.batch!.member_index ||
          pricingContentHash(dispatch.request_ids) !==
            pricingContentHash(batch.members.map((member) => member.request_id))
        )
          this.conflict("Outcome differs from prepared batch membership");
        const hash = pricingContentHash(entry.cost);
        if (
          row.state === "terminal" &&
          (row.cost_hash !== hash ||
            row.error_code !== (entry.errorCode ?? null))
        )
          this.conflict("Shared terminal receipt is immutable");
        if (row.state !== "terminal")
          await manager
            .createQueryBuilder()
            .update("pricing_attempts")
            .set({
              state: "terminal",
              completed_at: new Date().toISOString(),
              cost_json: JSON.stringify(entry.cost),
              cost_hash: hash,
              error_code: entry.errorCode ?? null,
            })
            .where("id = :id AND workspace_id = :workspace", {
              id: entry.id,
              workspace,
            })
            .execute();
      }
      for (const entry of [...entries].sort((a, b) =>
        batch.members[a.cost.batch!.member_index].reservation_id <
        batch.members[b.cost.batch!.member_index].reservation_id
          ? -1
          : 1,
      )) {
        if (!entry.settlement) continue;
        const member = batch.members[entry.cost.batch!.member_index];
        // A stale live coordinator may report genuine cost after an operator has
        // resolved the logical holds. Keep the cost, not its superseded decision.
        if (
          !(await this.operatorDecisionApplied(
            manager,
            member.reservation_id,
            workspace,
          ))
        )
          await this.queueSettlementInTransaction(
            manager,
            reservations.get(member.reservation_id)!,
            entry.settlement,
          );
      }
      for (const member of batch.members)
        await this.projectCallLogs(manager, member.request_id, workspace);
    });
  }

  async summary(
    requestId: string,
    workspace: string,
  ): Promise<CostLedgerSummary | null> {
    if (!(await this.available())) return null;
    return serializeDatabaseAccess(this.dataSource, () =>
      this.summaryInTransaction(this.dataSource.manager, requestId, workspace),
    );
  }

  /**
   * Internal, read-only accounting comparison. No controller/policy activation uses
   * this yet. A future settlement caller must establish dispatch closure before
   * passing true; the database alone cannot prove that no new attempt will begin.
   */
  async previewActualUpstreamBudget(
    reservationId: string,
    workspace: string,
    dispatchComplete: boolean,
  ): Promise<{
    read_only: true;
    activation_available: false;
    current_budget_basis: string;
    current_state: CostReservationRow["state"];
    plan: ActualUpstreamBudgetPlan;
  }> {
    if (!(await this.available())) this.missing();
    this.text(reservationId);
    this.text(workspace);
    if (typeof dispatchComplete !== "boolean") this.conflict("An explicit dispatch finality observation is required");
    return serializeDatabaseAccess(this.dataSource, () => this.dataSource.transaction(async manager => {
      // Use the same request-first fence as receipt/correction writers; do not
      // combine an old original receipt with a newer half-read adjustment chain.
      const row = await this.reservation(manager, reservationId, workspace, true);
      if (!row) this.missing();
      const plan = await this.actualBudgetPlan(manager, row, dispatchComplete);
      return { read_only: true, activation_available: false, current_budget_basis: row.budget_basis, current_state: row.state, plan };
    }));
  }

  private async actualBudgetPlan(manager: EntityManager, row: CostReservationRow, dispatchComplete: boolean): Promise<ActualUpstreamBudgetPlan> {
    const evidence = await readActualBudgetEvidence(manager, row);
    return planActualUpstreamBudget({ workspace_id: row.workspace_id, request_id: row.request_id, reservation_id: row.id,
      dispatch_complete: dispatchComplete, require_upstream_tokens: evidence.requireTokens }, evidence.effective);
  }

  /** Read-only report projection inside the caller's short consistent database snapshot. */
  async reportSummary(manager: EntityManager, requestId: string, workspace: string): Promise<CostLedgerSummary | null> {
    if (manager.connection !== this.dataSource || !manager.queryRunner?.isTransactionActive)
      this.conflict("Report reads require an owned database snapshot");
    return this.summaryInTransaction(manager, requestId, workspace);
  }

  private summaryInTransaction(manager: EntityManager, requestId: string, workspace: string, mode?: "detail"): Promise<CostLedgerSummary | null>;
  private summaryInTransaction(manager: EntityManager, requestId: string, workspace: string, mode: "log"): Promise<Pick<CostLedgerSummary, "known_subtotal"> | null>;
  /** Both views run the same receipt/history/amount validation. Log projection
   * alone omits intent and recovery metadata that never contribute to cost. */
  private async summaryInTransaction(
    manager: EntityManager,
    requestId: string,
    workspace: string,
    mode: "detail" | "log" = "detail",
  ): Promise<CostLedgerSummary | Pick<CostLedgerSummary, "known_subtotal"> | null> {
    const snapshot = mode === "log" && manager.connection.options.type === "postgres" && manager.queryRunner?.isTransactionActive
      ? await readRequestLogSnapshot(manager, requestId, workspace) : null;
    const rows = snapshot?.attempts ?? await manager
      .createQueryBuilder()
      .select("a.*")
      .from("pricing_attempts", "a")
      .where("a.request_id = :request AND a.workspace_id = :workspace", {
        request: requestId,
        workspace,
      })
      .orderBy("a.dispatched_at", "ASC")
      .addOrderBy("a.id", "ASC")
      .getRawMany<CostAttemptRow>();
    const reservations = snapshot?.reservations ?? await manager
      .createQueryBuilder()
      .select("r.*")
      .from("pricing_reservations", "r")
      .where("r.request_id = :request AND r.workspace_id = :workspace", {
        request: requestId,
        workspace,
      })
      .getRawMany<CostReservationRow>();
    if (!rows.length && !reservations.length) return null;
    const intents = mode === "log" ? [] : await manager
      .createQueryBuilder()
      .select("i.*")
      .from("pricing_settlement_intents", "i")
      .where("i.request_id = :request AND i.workspace_id = :workspace", {
        request: requestId,
        workspace,
      })
      .getRawMany<CostSettlementIntentRow>();
    const cases = mode === "log" ? [] : await manager.createQueryBuilder().select("c.*").from("pricing_recovery_cases", "c").where("c.request_id = :request AND c.workspace_id = :workspace", { request: requestId, workspace }).getRawMany<PricingRecoveryCaseRow>();
    const casesById = new Map(cases.map((entry) => [entry.reservation_id, recoveryCaseSummary(entry)]));
    const intentsById = new Map(
      intents.map((intent) => [intent.reservation_id, intent]),
    );
    const adjustmentGroups = snapshot?.history ?? await loadCostAdjustments(
      manager,
      requestId,
      workspace,
      rows,
    );
    const initialActualCosts = new Map<string, string | null>();
    for (const reservation of reservations.filter(row => row.budget_basis === "actual_upstream")) {
      const cohort = await readActualBudgetCohort(manager, reservation.id, workspace);
      if (cohort?.state === "applied" && cohort.applied_plan_json)
        for (const contribution of (JSON.parse(cohort.applied_plan_json) as ActualUpstreamBudgetPlan).contributions)
          initialActualCosts.set(contribution.attempt_id, contribution.cost_hash);
    }
    let pendingAdjustments = 0;
    let budgetCorrections = ExactDecimal.zero;
    let total = ExactDecimal.zero;
    let known = false;
    let unknown = 0;
    let pending = 0;
    let estimated = false;
    let legacy = false;
    const attempts = rows.map((row) => {
      const { cost_json, price_context_json: _context, ...metadata } = row;
      const cost = cost_json
        ? (JSON.parse(cost_json) as CostComputation)
        : null;
      if (cost && pricingContentHash(cost) !== row.cost_hash)
        this.conflict("Cost receipt integrity check failed");
      const adjustments = adjustmentGroups.get(row.id) ?? [];
      const effective = adjustments.at(-1)?.cost ?? cost;
      if (adjustments.at(-1)?.application.budget_state === "pending" && initialActualCosts.get(row.id) !== adjustments.at(-1)?.cost_hash)
        pendingAdjustments++;
      for (const view of adjustments) {
        if (view.application.budget_state !== "pending")
          budgetCorrections = budgetCorrections.add(
            ExactDecimal.parse(view.application.cost_delta),
          );
      }
      if (row.state !== "terminal") pending++;
      else if (!effective || effective.report_amount === null) unknown++;
      if (
        effective?.report_known_subtotal !== null &&
        effective?.report_known_subtotal !== undefined
      ) {
        total = total.add(ExactDecimal.parse(effective.report_known_subtotal));
        known = true;
      }
      estimated ||= effective?.status === "estimated";
      legacy ||= effective?.status === "legacy_estimate";
      return {
        ...metadata,
        dispatch:
          (JSON.parse(_context) as AttemptPriceContext).dispatch ?? null,
        cost,
        effective_cost: effective,
        effective_cost_hash: adjustments.at(-1)?.cost_hash ?? row.cost_hash,
        adjustments,
      };
    });
    let committed = ExactDecimal.zero;
    let reserved = ExactDecimal.zero;
    for (const row of reservations) {
      if (row.state === "reserved")
        reserved = reserved.add(ExactDecimal.parse(row.reserved_cost_usd));
      else if (row.state === "committed")
        committed = committed.add(ExactDecimal.parse(row.committed_cost_usd));
    }
    const awaitingDispatch =
      rows.length === 0 && reservations.some((row) => row.state === "reserved");
    const onlyMissingUsage = attempts.length > 0 && attempts.every(attempt => attempt.effective_cost?.status === "missing_usage");
    const status =
      pending || awaitingDispatch
        ? known
          ? "partial"
          : "pending"
        : unknown
          ? known
            ? "partial"
            : onlyMissingUsage ? "missing_usage" : "unpriced"
          : estimated
            ? "estimated"
            : legacy
              ? "legacy_estimate"
              : total.compare(ExactDecimal.zero) === 0
                ? "free"
                : "priced";
    let cacheReference: CostLedgerSummary["local_cache_reference"];
    if (rows.length === 1 && rows[0].fee_source === "local_cache" && rows[0].state === "terminal" && attempts[0].adjustments.length === 0) {
      const reservation = reservations.find(value => value.id === rows[0].reservation_id);
      if (reservation) {
        try {
          const snapshot = manager.queryRunner?.isTransactionActive
            ? await this.prices.restoreRequestInTransaction(manager, requestId, workspace)
            : await this.dataSource.transaction(transaction => this.prices.restoreRequestInTransaction(transaction, requestId, workspace));
          cacheReference = localCacheReference(snapshot, rows[0], reservation);
        } catch (error) {
          // A missing reference must not hide the independently retained cache
          // receipt. It is displayed as unavailable, never rebuilt at new prices.
          if (error instanceof PricingReplayLimitError) throw error;
          cacheReference = localCacheReference(null, rows[0], reservation);
        }
      }
    }
    const summary: CostLedgerSummary = {
      ...(cacheReference ? { local_cache_reference: cacheReference } : {}),
      request_id: requestId,
      status,
      report_currency: "USD",
      amount: pending || unknown || awaitingDispatch ? null : total.toFixed(18),
      known_subtotal: known ? total.toFixed(18) : null,
      pending_attempts: pending,
      unknown_attempts: unknown,
      provider_attempts: rows.filter((row) => row.fee_source === "provider")
        .length,
      budget_committed_usd: committed.add(budgetCorrections).toFixed(18),
      pending_budget_adjustments: pendingAdjustments,
      budget_reserved_usd: reserved.toFixed(18),
      attempts,
      reservations: reservations.map((row) => {
        const admission =
          (JSON.parse(row.estimate_json) as CostComputation).admission ?? null;
        let knownCosts = ExactDecimal.zero;
        const excesses: Array<{
          attempt_id: string;
          dimension: string;
          observed: string;
          limit: string;
        }> = [];
        for (const attempt of attempts.filter(
          (entry) => entry.reservation_id === row.id,
        )) {
          const cost = attempt.effective_cost;
          if (cost?.report_known_subtotal != null)
            knownCosts = knownCosts.add(
              ExactDecimal.parse(cost.report_known_subtotal),
            );
          if (admission?.mode !== "reserve_upper_bound") continue;
          for (const [dimension, bound] of Object.entries(
            admission.quantity_bounds,
          )) {
            const quantity = (cost?.batch?.physical_cost ?? cost)?.usage
              .quantities[
              dimension as keyof NonNullable<typeof cost>["usage"]["quantities"]
            ];
            if (
              quantity?.value != null &&
              quantity.quality === "observed" &&
              ["provider_usage", "provider_job_result"].includes(
                quantity.source,
              ) &&
              ExactDecimal.parse(quantity.value).compare(
                ExactDecimal.parse(bound!.value),
              ) > 0
            )
              excesses.push({
                attempt_id: attempt.id,
                dimension,
                observed: quantity.value,
                limit: bound!.value,
              });
          }
        }
        const reservedCost = ExactDecimal.parse(row.reserved_cost_usd);
        return {
          id: row.id,
          state: row.state,
          reserved_cost_usd: row.reserved_cost_usd,
          committed_cost_usd: row.committed_cost_usd,
          reserved_tokens: row.reserved_tokens,
          committed_tokens: row.committed_tokens,
          budget_basis: row.budget_basis,
          admission,
          known_cost_overrun_usd:
            knownCosts.compare(reservedCost) > 0
              ? knownCosts.subtract(reservedCost).toFixed(18)
              : ExactDecimal.zero.toFixed(18),
          observed_limit_excesses: excesses,
          recovery_case: casesById.get(row.id) ?? null,
          settlement_status: intentsById.get(row.id)?.state ?? null,
          settlement_error_code:
            intentsById.get(row.id)?.last_error_code ?? null,
          lease_until: row.lease_until,
        };
      }),
    };
    // Keep the decimal/JSON/allowance checks above identical, but do not return
    // an incomplete report to a caller expecting reservation/display metadata.
    return mode === "log" ? { known_subtotal: summary.known_subtotal } : summary;
  }

  async renew(
    id: string,
    workspace: string,
    leaseOwner: string,
    leaseUntil: string,
    jobId?: string,
  ): Promise<boolean> {
    const until = new Date(parsePricingInstant(leaseUntil)).toISOString();
    if (Date.parse(until) <= Date.now())
      this.conflict("Renewal must extend into the future");
    return this.write(async (manager) => {
      const row = await this.reservation(manager, id, workspace, true);
      if (
        !row ||
        row.state !== "reserved" ||
        row.lease_owner !== leaseOwner ||
        (await this.settlementIntent(manager, id, workspace, false))
      )
        return false;
      if (row.budget_basis === "actual_upstream" && await readActualBudgetCohort(manager, id, workspace)) return false;
      if (jobId && row.job_id && row.job_id !== jobId)
        this.conflict("Reservation job identity is immutable");
      const effectiveUntil =
        Date.parse(until) > Date.parse(row.lease_until)
          ? until
          : row.lease_until;
      if (
        effectiveUntil === row.lease_until &&
        (!jobId || row.job_id === jobId)
      )
        return true;
      await manager
        .createQueryBuilder()
        .update("pricing_reservations")
        .set({
          lease_until: effectiveUntil,
          ...(jobId ? { job_id: jobId } : {}),
          updated_at: new Date().toISOString(),
        })
        .where("id = :id AND workspace_id = :workspace", { id, workspace })
        .execute();
      return true;
    });
  }

  /** Internal worker only: bounded across workspaces, each mutation is re-scoped and locked. */
  async reconcilePending(
    limit = 100,
    now = new Date(),
  ): Promise<CostRecoveryResult> {
    const result: CostRecoveryResult = {
      applied: 0,
      pending: 0,
      review_required: 0,
    };
    if (!(await this.available())) return result;
    const count = Math.max(1, Math.min(100, Math.trunc(limit)));
    const intents = await serializeDatabaseAccess(this.dataSource, () =>
      this.dataSource.manager
        .createQueryBuilder()
        .select("i.*")
        .from("pricing_settlement_intents", "i")
        .where("i.state = :state AND i.next_attempt_at <= :now", {
          state: "pending",
          now: now.toISOString(),
        })
        .orderBy("i.next_attempt_at", "ASC")
        .addOrderBy("i.reservation_id", "ASC")
        .limit(count)
        .getRawMany<CostSettlementIntentRow>(),
    );
    for (const intent of intents) {
      try {
        await this.applySettlement(intent.reservation_id, intent.workspace_id);
        result.applied++;
      } catch (error) {
        const needsReview =
          error instanceof PricingRepositoryError &&
          [400, 404, 409].includes(error.status);
        const code =
          error instanceof PricingRepositoryError
            ? error.code
            : "pricing_storage_failure";
        await this.write(async (manager) => {
          const row = await this.reservation(
            manager,
            intent.reservation_id,
            intent.workspace_id,
            true,
          );
          if (!row) return;
          const current = await this.settlementIntent(
            manager,
            row.id,
            row.workspace_id,
            true,
          );
          if (!current || current.state !== "pending") return;
          const attempts = Math.min(current.attempt_count + 1, 1000000);
          await manager
            .createQueryBuilder()
            .update("pricing_settlement_intents")
            .set({
              state: needsReview ? "review_required" : "pending",
              attempt_count: attempts,
              last_error_code: code,
              next_attempt_at: new Date(
                now.getTime() +
                  Math.min(60000, 1000 * 2 ** Math.min(attempts - 1, 6)),
              ).toISOString(),
            })
            .where("reservation_id = :id AND workspace_id = :workspace", {
              id: row.id,
              workspace: row.workspace_id,
            })
            .execute();
        });
        if (needsReview) result.review_required++;
        else result.pending++;
      }
    }
    return result;
  }

  /** Reclaim only proven undispatched synchronous holds. Async jobs and ambiguous dispatches are never declared free. */
  async recoverUndispatched(limit = 100, now = new Date()): Promise<number> {
    if (!(await this.available())) return 0;
    const candidates = await serializeDatabaseAccess(this.dataSource, () =>
      this.dataSource.manager
        .createQueryBuilder()
        .select("r.*")
        .from("pricing_reservations", "r")
        .where(
          "r.state = :state AND r.lease_until <= :now AND r.job_id IS NULL",
          { state: "reserved", now: now.toISOString() },
        )
        .andWhere(
          "NOT EXISTS (SELECT 1 FROM pricing_attempts a WHERE a.reservation_id = r.id AND a.workspace_id = r.workspace_id)",
        )
        .andWhere(
          "NOT EXISTS (SELECT 1 FROM pricing_settlement_intents i WHERE i.reservation_id = r.id AND i.workspace_id = r.workspace_id)",
        )
        .andWhere("r.budget_basis <> :actual", { actual: "actual_upstream" })
        .orderBy("r.lease_until", "ASC")
        .addOrderBy("r.id", "ASC")
        .limit(Math.max(1, Math.min(100, Math.trunc(limit))))
        .getRawMany<CostReservationRow>(),
    );
    let recovered = 0;
    for (const candidate of candidates) {
      const changed = await this.write(async (manager) => {
        const row = await this.reservation(
          manager,
          candidate.id,
          candidate.workspace_id,
          true,
        );
        if (
          !row ||
          row.state !== "reserved" ||
          row.budget_basis === "actual_upstream" ||
          row.job_id ||
          Date.parse(row.lease_until) > now.getTime() ||
          (await this.settlementIntent(manager, row.id, row.workspace_id, true))
        )
          return false;
        const dispatched = await manager
          .createQueryBuilder()
          .select("a.id")
          .from("pricing_attempts", "a")
          .where("a.reservation_id = :id AND a.workspace_id = :workspace", {
            id: row.id,
            workspace: row.workspace_id,
          })
          .getRawOne();
        if (dispatched) return false;
        const intent = await this.queueSettlementInTransaction(manager, row, {
          kind: "release",
          tokens: "0",
          cost_usd: "0.000000000000000000",
          budget_basis: "recovery_no_dispatch",
          receipt: null,
        });
        await this.applySettlementInTransaction(manager, row, intent);
        return true;
      });
      if (changed) recovered++;
    }
    return recovered;
  }

  /** Stale dispatched work becomes an explicit review case, never inferred free or redispatched. */
  async reconcileDispatched(limit = 100, now = new Date()) {
    const result = { opened: 0, updated: 0, unchanged: 0, skipped: 0 };
    if (!(await this.available())) return result;
    const candidates = await serializeDatabaseAccess(this.dataSource, () => this.dataSource.manager.createQueryBuilder()
      .select("r.*").from("pricing_reservations", "r")
      .leftJoin("pricing_recovery_cases", "c", "c.reservation_id = r.id AND c.workspace_id = r.workspace_id")
      .where("r.state = :state AND r.lease_until <= :now AND r.job_id IS NULL", { state: "reserved", now: now.toISOString() })
      .andWhere("EXISTS (SELECT 1 FROM pricing_attempts a WHERE a.reservation_id = r.id AND a.workspace_id = r.workspace_id)")
      .andWhere("NOT EXISTS (SELECT 1 FROM pricing_settlement_intents i WHERE i.reservation_id = r.id AND i.workspace_id = r.workspace_id)")
      .andWhere("NOT EXISTS (SELECT 1 FROM pricing_media_tasks t WHERE t.reservation_id = r.id AND t.workspace_id = r.workspace_id AND t.state <> :sync)", { sync: "synchronous" })
      .orderBy("CASE WHEN c.reservation_id IS NULL THEN 0 ELSE 1 END", "ASC")
      .addOrderBy("c.checked_at", "ASC").addOrderBy("r.lease_until", "ASC").addOrderBy("r.id", "ASC")
      .limit(Math.max(1, Math.min(100, Math.trunc(limit)))).getRawMany<CostReservationRow>());
    for (const candidate of candidates) {
      const outcome = await this.write(async (manager) => {
        const row = await this.reservation(manager, candidate.id, candidate.workspace_id, true);
        return row ? observeDispatchedOrphan(manager, row, now.toISOString()) : "skipped" as const;
      });
      result[outcome]++;
    }
    return result;
  }

  /** Read-only, workspace-scoped view. Reading never sweeps or modifies budget state. */
  async recoveryCases(workspace: string, limit = 100): Promise<PricingRecoveryCaseSummary[]> {
    if (!(await this.available())) return [];
    return serializeDatabaseAccess(this.dataSource, async () => {
      const rows = await this.dataSource.manager.createQueryBuilder().select("c.*").from("pricing_recovery_cases", "c")
        .where("c.workspace_id = :workspace AND c.state = :state", { workspace, state: "open" })
        .orderBy("c.created_at", "ASC").addOrderBy("c.reservation_id", "ASC")
        .limit(Math.max(1, Math.min(100, Math.trunc(limit)))).getRawMany<PricingRecoveryCaseRow>();
      return rows.map(recoveryCaseSummary);
    });
  }

  async recoveryInventory(workspace: string, options: { view: RecoveryView; limit: number; cursor?: string }) {
    if (!(await this.available())) throw new PricingRepositoryError("pricing_schema_required", "Explicit pricing migration is required", 503);
    return serializeDatabaseAccess(this.dataSource, () => this.dataSource.transaction((manager) => recoveryInventory(manager, workspace, options, (id) => this.summaryInTransaction(manager, id, workspace))));
  }

  /** Read-only acknowledgement lookup, including verification of every linked terminal decision. */
  async recoveryResolutionStatus(anchor: string, workspace: string, id: string) {
    this.text(anchor); this.text(workspace); this.text(id);
    if (!(await this.available())) this.missing();
    const auditId = `recovery-resolution:${pricingContentHash([workspace, id])}`;
    return serializeDatabaseAccess(this.dataSource, () => this.dataSource.transaction(async (manager) => {
      const row = await manager.createQueryBuilder().select(['a.metadata_json AS metadata_json', 'a.actor_id AS actor_id']).from("pricing_audit_events", "a")
        .where("a.id = :id AND a.workspace_id = :workspace AND a.action = :action", { id: auditId, workspace, action: "cost.recovery_resolution" }).getRawOne<{ metadata_json: string; actor_id: string }>();
      if (!row) this.missing();
      const stored = recoveryDecode<{ result: RecoveryResolutionResult; result_hash: string }>(row.metadata_json);
      if (stored.result.anchor_reservation_id !== anchor || stored.result.id !== id) this.missing();
      if (pricingContentHash(stored.result) !== stored.result_hash) this.conflict("Recovery acknowledgement integrity check failed");
      await this.verifyRecoveryAcknowledgement(manager, auditId, workspace, stored.result);
      return { recorded: true as const, actor_id: row.actor_id, result: stored.result };
    }));
  }

  async usageRecoveryBasis(anchor: string, workspace: string, attemptId: string) {
    this.text(anchor); this.text(workspace); this.text(attemptId);
    if (!(await this.available())) this.missing();
    return serializeDatabaseAccess(this.dataSource, () => this.dataSource.transaction((manager) => loadUsageRecoveryBasis(manager, anchor, workspace, attemptId)));
  }

  async recordedUsageRecovery(anchor: string, actor: PricingActor, input: UsageRecoveryInput) {
    if (!(await this.available())) this.missing();
    return serializeDatabaseAccess(this.dataSource, () => this.dataSource.transaction((manager) => recordedUsageRecovery(manager, anchor, actor.workspace_id, input.id, usageRecoveryProposalHash(anchor, actor, input))));
  }

  async usageRecoveryStatus(anchor: string, workspace: string, id: string) {
    this.text(anchor); this.text(workspace); this.text(id);
    if (!(await this.available())) this.missing();
    const result = await serializeDatabaseAccess(this.dataSource, () => this.dataSource.transaction((manager) => recordedUsageRecovery(manager, anchor, workspace, id)));
    if (!result) this.missing();
    return { recorded: true as const, result };
  }

  /** Internal normalized computation only; HTTP callers cannot supply a monetary result. */
  async recoverUsage(anchor: string, actor: PricingActor, input: UsageRecoveryInput, cost: CostComputation, dryRun: boolean) {
    if (actor.role !== 'admin' || !actor.id || !actor.workspace_id) throw new PricingRepositoryError('pricing_permission_denied', 'Usage recovery requires workspace administration', 403);
    this.text(anchor); this.text(input.id); this.text(input.attempt_id); this.validateCost(cost);
    if (!(await this.available())) this.missing();
    const run = async (manager: EntityManager) => {
      if (manager.connection.options.type === 'postgres') await manager.query('SELECT pg_advisory_xact_lock(hashtext($1::text), hashtext($2::text))', ['siftgate.usage-recovery', `${manager.connection.options.schema ?? ''}:${usageRecoveryAuditId(actor.workspace_id, input.id)}`]);
      const prior = await recordedUsageRecovery(manager, anchor, actor.workspace_id, input.id, usageRecoveryProposalHash(anchor, actor, input));
      if (prior) return { ...prior, dry_run: dryRun };
      const basis = await loadUsageRecoveryBasis(manager, anchor, actor.workspace_id, input.attempt_id);
      const result = await writeRecoveredUsage(manager, anchor, actor, input, basis, cost, dryRun);
      if (!dryRun) for (const requestId of [...new Set(result.changes.map((entry) => entry.request_id))].sort()) await this.projectCallLogs(manager, requestId, actor.workspace_id);
      return result;
    };
    return dryRun ? serializeDatabaseAccess(this.dataSource, () => this.dataSource.transaction(run)) : this.write(run);
  }

  async recoveryBasis(id: string, workspace: string) {
    this.text(id); this.text(workspace);
    if (!(await this.available())) this.missing();
    return serializeDatabaseAccess(this.dataSource, () => this.dataSource.transaction(async (manager) => (await loadRecoveryBasis(manager, id, workspace)).view));
  }

  async resolveRecovery(anchor: string, actor: PricingActor, input: RecoveryResolutionInput, dryRun = false): Promise<RecoveryResolutionResult> {
    if (actor.role !== "admin" || !actor.id || !actor.workspace_id) throw new PricingRepositoryError("pricing_permission_denied", "Workspace administrator context is required", 403);
    this.text(anchor); this.text(input.id); this.text(actor.id); this.text(actor.workspace_id);
    if (!input.confirm || !input.reason.trim() || input.reason.length > 1000 || !/^[a-f0-9]{64}$/.test(input.expected_basis_hash) || !Array.isArray(input.decisions) || input.decisions.length > 4096) throw new PricingRepositoryError("pricing_invalid_document", "Invalid recovery proposal", 400);
    const proposalHash = pricingContentHash({ anchor, actor: actor.id, workspace: actor.workspace_id, id: input.id, expected_basis_hash: input.expected_basis_hash, reason: input.reason, decisions: [...input.decisions].sort((a, b) => a.reservation_id.localeCompare(b.reservation_id)) });
    const auditId = `recovery-resolution:${pricingContentHash([actor.workspace_id, input.id])}`;
    const operation = async (manager: EntityManager) => {
      if (manager.connection.options.type === "postgres") await manager.query("SELECT pg_advisory_xact_lock(hashtext($1::text), hashtext($2::text))", ["siftgate.recovery-resolution", `${manager.connection.options.schema ?? ""}:${auditId}`]);
      const prior = await manager.createQueryBuilder().select("a.metadata_json", "metadata_json").from("pricing_audit_events", "a").where("a.id = :id AND a.workspace_id = :workspace AND a.action = :action", { id: auditId, workspace: actor.workspace_id, action: "cost.recovery_resolution" }).getRawOne<{ metadata_json: string }>();
      if (prior) {
        const stored = recoveryDecode<{ proposal_hash: string; result: RecoveryResolutionResult; result_hash: string }>(prior.metadata_json);
        if (stored.proposal_hash !== proposalHash || pricingContentHash(stored.result) !== stored.result_hash) recoveryConflict("Recovery resolution identity was reused or its audit evidence changed");
        await this.verifyRecoveryAcknowledgement(manager, auditId, actor.workspace_id, stored.result);
        return { ...stored.result, dry_run: dryRun, replayed: true };
      }
      const basis = await loadRecoveryBasis(manager, anchor, actor.workspace_id);
      const plan = buildRecoveryResolution(basis, input, dryRun);
      for (const entry of plan.payloads) for (const receipt of this.settlementReceipts(entry.payload)) this.validateCost(receipt.cost);
      if (dryRun) return plan.result;
      // Authority and effects share a transaction. Persist authority first so that
      // a new actual fence can validate its reference; failures roll everything back.
      await manager.createQueryBuilder().insert().into("pricing_audit_events").values({ id: auditId, workspace_id: actor.workspace_id, book_id: null, actor_id: actor.id, action: "cost.recovery_resolution", reason: redactErrorText(input.reason, { maxLength: 1000 }), created_at: new Date().toISOString(), metadata_json: JSON.stringify({ proposal_hash: proposalHash, result_hash: pricingContentHash(plan.result), result: plan.result }) }).execute();
      const applied: Array<{ reservation_id: string; payload_hash: string }> = [];
      for (const entry of plan.payloads) {
        const intent = entry.recorded ? basis.intents.get(entry.reservation.id)! : await this.queueSettlementInTransaction(manager, entry.reservation, entry.payload);
        await this.applySettlementInTransaction(manager, entry.reservation, intent);
        applied.push({ reservation_id: entry.reservation.id, payload_hash: intent.payload_hash });
      }
      for (const entry of plan.actual ?? []) {
        const prior = await readActualBudgetCohort(manager, entry.reservation.id, actor.workspace_id);
        if (!prior) await retainActualBudgetCohort(manager, entry.cohort);
        else if (prior.closure_hash !== entry.cohort.closure_hash) recoveryConflict("Actual recovery fence changed");
        if (entry.cohort.state === "review_required") {
          await manager.createQueryBuilder().update(ACTUAL_BUDGET_COHORT_TABLE).set({ state: "pending", last_error_code: null })
            .where("reservation_id = :id AND workspace_id = :workspace", { id: entry.reservation.id, workspace: actor.workspace_id }).execute();
          entry.cohort.state = "pending";
        }
        const settled = await this.settleActualBudgetInTransaction(manager, entry.reservation, entry.cohort);
        const expected = plan.result.changes.find(change => change.reservation_id === entry.reservation.id)!;
        const current = await this.reservation(manager, entry.reservation.id, actor.workspace_id, false);
        if (!current || current.state !== expected.next_state || settled !== (expected.next_state !== "reserved")) recoveryConflict("Actual recovery changed during application");
        if (settled) {
          const intent = await this.settlementIntent(manager, current.id, actor.workspace_id, false);
          if (!intent || current.committed_tokens !== expected.budget_tokens || current.committed_cost_usd !== expected.budget_cost_usd) recoveryConflict("Actual recovery debit differs from its preview");
          applied.push({ reservation_id: current.id, payload_hash: intent.payload_hash });
        } else await recordPendingActualRecovery(manager, current, entry.cohort, expected.pending_reasons ?? []);
        await this.projectCallLogs(manager, entry.reservation.request_id, actor.workspace_id);
      }
      for (const entry of applied) {
        await manager.createQueryBuilder().insert().into("pricing_recovery_decisions").values({ ...entry, workspace_id: actor.workspace_id, resolution_audit_id: auditId, created_at: new Date().toISOString() }).execute();
        await manager.createQueryBuilder().update("pricing_recovery_cases").set({ resolution_code: "operator_budget_resolved" }).where("reservation_id = :id AND workspace_id = :workspace AND state = :state", { id: entry.reservation_id, workspace: actor.workspace_id, state: "resolved" }).execute();
      }
      await this.verifyRecoveryAcknowledgement(manager, auditId, actor.workspace_id, plan.result);
      return plan.result;
    };
    if (!(await this.available())) this.missing();
    return dryRun ? serializeDatabaseAccess(this.dataSource, () => this.dataSource.transaction(operation)) : this.write(operation);
  }

  /** A local failed settlement may be retired only after matching an authoritative operator decision. */
  async outcomeSuperseded(outcome: PricingOutcome): Promise<boolean> {
    if (outcome.type !== "settlement" || !(await this.available())) return false;
    const superseded = await serializeDatabaseAccess(this.dataSource, () => this.operatorDecisionApplied(this.dataSource.manager, outcome.reservationId, outcome.workspace));
    // Retiring a budget decision cannot erase receipts carried by its old body.
    if (superseded) await this.archiveRuntimeOutcome(outcome);
    return superseded;
  }

  /** Capture all physical shares (or an undispatched release cohort) before delivery. */
  async retainRuntimeGroupOutcome(
    outcome: PricingGroupOutcome,
  ): Promise<GroupOutcomeRow> {
    const captured = runtimeGroupOutcomeDocument(outcome).outcome;
    return this.outcomeWrite((manager) =>
      retainRuntimeGroupOutcome(manager, captured),
    );
  }

  async persistRuntimeGroupOutcome(
    outcome: PricingGroupOutcome,
  ): Promise<void> {
    const row = await this.retainRuntimeGroupOutcome(outcome);
    const captured = readRuntimeGroupDocument(row.document_json).outcome;
    const review = () =>
      new PricingRepositoryError(
        "pricing_group_outcome_review_required",
        "Complete-group evidence is durably retained for review; no supplier or budget decision is inferred",
        409,
      );
    if (row.state === "review_required") throw review();
    if (row.state === "delivered" && captured.type !== "actual_budget_closure_group") return;
    try {
      if (captured.type === "actual_budget_closure_group") {
        await this.closeActualBudgetGroup(captured, row);
        return;
      }
      if (captured.type === "attempt_group")
        await this.completeAttemptGroup(
          captured.workspace,
          captured.entries,
          row.id,
        );
      else
        await this.queueSettlementGroup(
          captured.workspace,
          captured.entries,
          row.id,
        );
    } catch (error) {
      const needsReview =
        error instanceof PricingRepositoryError &&
        [400, 404, 409].includes(error.status);
      // A custody-only acknowledgement must itself be committed before a live owner may retire memory.
      try {
        const retained = await this.outcomeWrite((manager) =>
          transitionRuntimeGroupOutcome(
            manager,
            row,
            needsReview ? "review_required" : "pending",
          ),
        );
        if (retained.state === "review_required") throw review();
      } catch (transitionError) {
        if (
          transitionError instanceof PricingRepositoryError &&
          transitionError.code === "pricing_group_outcome_review_required"
        )
          throw transitionError;
      }
      throw error;
    }
    const delivered = await this.outcomeWrite((manager) =>
      transitionRuntimeGroupOutcome(manager, row, "delivered"),
    );
    if (delivered.state !== "delivered") throw review();
  }

  async replayRuntimeGroupOutcomes(now = new Date(), limit = 100) {
    const result = {
      persisted: 0,
      pending: 0,
      review_required: 0,
      overflow: 0,
    };
    if (!(await this.available())) return result;
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 1000 ||
      !Number.isFinite(now.getTime())
    )
      this.conflict("Invalid group replay bound");
    // Load metadata only; a page must not materialize 100 potentially large group bodies.
    const rows = await serializeDatabaseAccess(this.dataSource, () =>
      this.dataSource.manager
        .createQueryBuilder()
        .select(["o.id AS id", "o.workspace_id AS workspace_id"])
        .from(GROUP_OUTCOME_TABLE, "o")
        .where("o.state = :state AND o.next_attempt_at <= :now", {
          state: "pending",
          now: now.toISOString(),
        })
        .orderBy("o.next_attempt_at", "ASC")
        .addOrderBy("o.id", "ASC")
        .limit(limit)
        .getRawMany<Pick<GroupOutcomeRow, "id" | "workspace_id">>(),
    );
    for (const row of rows) {
      let verified = false;
      try {
        const current = await this.outcomeWrite((manager) =>
          readRuntimeGroupOutcome(manager, row.id, row.workspace_id),
        );
        verified = true;
        if (current.row.state !== "pending") continue;
        await this.persistRuntimeGroupOutcome(current.document.outcome);
        result.persisted++;
      } catch (error) {
        if (
          error instanceof SyntaxError ||
          (error instanceof PricingRepositoryError &&
            [400, 404, 409].includes(error.status))
        ) {
          if (!verified)
            await this.outcomeWrite((manager) =>
              quarantineInvalidGroupOutcome(manager, row),
            ).catch(() => undefined);
          result.review_required++;
        } else result.pending++;
      }
    }
    return result;
  }

  runtimeGroupOutcomeInventory(
    workspace: string,
    state: GroupOutcomeState,
    limit: number,
    cursor?: string,
  ) {
    return this.outcomeWrite((manager) =>
      runtimeGroupOutcomeInventory(manager, workspace, state, limit, cursor),
    );
  }

  runtimeGroupOutcome(id: string, workspace: string) {
    return this.outcomeWrite(async (manager) => {
      const { row, document, members } = await readRuntimeGroupOutcome(
        manager,
        id,
        workspace,
      );
      const { document_json: _body, ...metadata } = row;
      const disposition = await readGroupDispositionRow(manager,id,workspace);
      if (disposition) await verifyGroupDispositionRecord(manager,disposition);
      return {
        disposition: disposition ? {id:disposition.operation_id,action:disposition.action,actor_id:disposition.actor_id,result_hash:disposition.result_hash} : null,
        ...metadata,
        document: JSON.parse(document.json) as unknown,
        members,
        read_only: true,
        supplier_confirmed: false,
      };
    });
  }

  groupDispositionContext(id: string, workspace: string) {
    return this.outcomeWrite(manager => loadGroupDisposition(manager,id,workspace));
  }

  async groupDispositionBasis(id: string, workspace: string) {
    const basis = (await this.groupDispositionContext(id,workspace)).view;
    if (Buffer.byteLength(JSON.stringify(basis)) > 32*1024*1024) this.conflict("Complete-group basis exceeds the review bound");
    return basis;
  }

  recordedGroupDisposition(actor: PricingActor, id: string, input: GroupDispositionInput) {
    return this.outcomeWrite(async manager => {
      const retained = await readRuntimeGroupOutcome(manager,id,actor.workspace_id);
      const result = await readRecordedGroupDisposition(manager,id,actor.workspace_id,input.id,groupDispositionSignature(actor.workspace_id,actor.id,id,input),retained.document.outcome);
      if (result && result.outcome_hash !== retained.row.document_hash) this.conflict("Group disposition differs from retained evidence");
      return result;
    });
  }

  groupDispositionStatus(id: string, workspace: string, operation: string) {
    return this.outcomeWrite(async manager => {
      const retained = await readRuntimeGroupOutcome(manager,id,workspace);
      const result = await readRecordedGroupDisposition(manager,id,workspace,operation,undefined,retained.document.outcome);
      if (!result) this.missing();
      if (result.outcome_hash !== retained.row.document_hash) this.conflict("Group disposition differs from retained evidence");
      return {recorded:true,result};
    });
  }

  disposeGroupOutcome(actor: PricingActor, id: string, input: GroupDispositionInput, verified: Record<string,string>, dryRun: boolean) {
    if (actor.role !== "admin" || !actor.id || !actor.workspace_id) throw new PricingRepositoryError("pricing_permission_denied","Group review requires workspace administration",403);
    if (!input.confirm || !["accept_receipts","reject_evidence"].includes(input.action) || !input.reason.trim() || input.reason.length>1000 || !/^[a-f0-9]{64}$/.test(input.expected_basis_hash) || !/^[a-f0-9]{64}$/.test(input.expected_outcome_hash)) this.conflict("Invalid group disposition input");
    const run = async (manager: EntityManager) => {
      if (manager.connection.options.type === "postgres") await manager.query("SELECT pg_advisory_xact_lock(hashtext($1::text),hashtext($2::text))",["siftgate.group-disposition",`${manager.connection.options.schema??""}:${groupDispositionAuditId(actor.workspace_id,input.id)}`]);
      const used = await manager.createQueryBuilder().select("d.outcome_id","id").from(GROUP_DISPOSITION_TABLE,"d").where("d.workspace_id = :workspace AND d.operation_id = :id",{workspace:actor.workspace_id,id:input.id}).getRawOne<{id:string}>();
      if (used && used.id !== id) this.conflict("Group operation identity belongs to another outcome");
      const retained = await readRuntimeGroupOutcome(manager,id,actor.workspace_id);
      const prior = await readRecordedGroupDisposition(manager,id,actor.workspace_id,input.id,groupDispositionSignature(actor.workspace_id,actor.id,id,input),retained.document.outcome);
      if (prior) return {...prior,dry_run:dryRun};
      const basis = await loadGroupDisposition(manager,id,actor.workspace_id);
      const result = await applyGroupDisposition(manager,this.budgets,actor,input,basis,verified,dryRun);
      if (!dryRun && input.action === "accept_receipts") for (const request of [...new Set(basis.entries.map(entry=>entry.row.request_id))].sort()) await this.projectCallLogs(manager,request,actor.workspace_id);
      return result;
    };
    return dryRun ? this.outcomeWrite(run) : this.write(run);
  }

  /** The first durable boundary. Never claims delivery, supplier authentication or budget settlement. */
  async retainRuntimeOutcome(outcome: PricingOutcome, yieldAfterRetention = true): Promise<RuntimeOutcomeRow> {
    const retain = prepareRuntimeOutcomeRetention(outcome);
    const retained = await this.retentionWrite(retain);
    // The normal path gives pending HTTP I/O a turn only after durable commit
    // and fence release. A live stream that already performed its explicit
    // delivery I/O turn can omit a second scheduling gap for its final decision.
    if (this.dataSource.options.type === "better-sqlite3" && yieldAfterRetention)
      await new Promise<void>(resolve => setImmediate(resolve));
    return retained;
  }

  /** Archival acknowledgement is the only authority for dropping a review entry from memory. */
  async archiveRuntimeOutcome(outcome: PricingOutcome): Promise<boolean> {
    const retain = prepareRuntimeOutcomeRetention(outcome, true);
    await this.retentionWrite(retain);
    return true;
  }

  async persistRuntimeOutcome(outcome: PricingOutcome, yieldAfterRetention = true): Promise<void> {
    const row = await this.retainRuntimeOutcome(outcome, yieldAfterRetention);
    await this.deliverRuntimeOutcome(row);
  }

  /** Retention remains independent; a successful return also guarantees budget application. */
  async persistAndApplyRuntimeSettlement(
    outcome: Extract<PricingOutcome, { type: "settlement" }>,
    yieldAfterRetention = true,
    acknowledgeReceipts = false,
  ): Promise<void> {
    if (outcome?.type !== "settlement") this.conflict("Composed delivery requires a settlement outcome");
    const row = await this.retainRuntimeOutcome(outcome, yieldAfterRetention);
    if (acknowledgeReceipts) await this.deliverRuntimeOutcome(row, true, true);
    else await this.deliverRuntimeOutcome(row, true);
  }

  /** Prepare optional rows within the first settlement, before shared budget
   * locks. The pipeline must still wait for this method and use ordinary scoped
   * logging when it returns null. Outcome retention remains independent.
   * Already-terminal settlements do not create another log. */
  async persistAndApplyRuntimeSettlementWithLogs(
    outcome: Extract<PricingOutcome, { type: "settlement" }>,
    logs: RuntimeSettlementLogs,
    acknowledgeReceipts = false,
  ): Promise<CallLog | null> {
    const input = structuredClone(logs);
    if (!input?.call || outcome?.type !== "settlement") this.conflict("Joined logging requires a settlement and new call row");
    for (const log of input.route ? [input.call, input.route] : [input.call]) {
      if (log.id != null || normalizeWorkspaceId(log.workspace_id) !== outcome.workspace)
        this.conflict("Joined logging requires new rows in the outcome workspace");
    }
    // PostgreSQL sequences reserve identities even when a savepoint rolls back.
    // SQLite rowids may be reused after rollback, so it must keep ordinary
    // settlement/logging and must not receive a provisional generated ID.
    if (this.dataSource.options.type !== "postgres") {
      await this.persistAndApplyRuntimeSettlement(outcome, true, acknowledgeReceipts);
      return null;
    }
    const completion: PendingSettlementLogs = { input, saved: null };
    try {
      const row = await this.retainRuntimeOutcome(outcome);
      await this.deliverRuntimeOutcome(row, true, acknowledgeReceipts, completion);
      return completion.saved;
    } finally {
      // Match Repository.save identity semantics. The sequence-allocated ID
      // lets the ordinary scoped fallback update a committed row after a lost
      // acknowledgement, or insert that same ID after rollback, without a second
      // log. Do not publish a cost/state or infer commit from these IDs.
      if (Number.isSafeInteger(input.call.id)) logs.call.id = input.call.id;
      if (logs.route && input.route && Number.isSafeInteger(input.route.id)) logs.route.id = input.route.id;
    }
  }

  private async applyRuntimeSettlement(delivery: RuntimeOutcomeRow, acknowledgeReceipts = false, completion?: PendingSettlementLogs): Promise<void> {
    await this.write(async manager => {
      const row = await this.reservation(manager, delivery.reservation_id, delivery.workspace_id, true);
      if (!row) this.missing();
      if (completion) for (const log of completion.input.route ? [completion.input.call, completion.input.route] : [completion.input.call]) {
        if (log.request_id !== row.request_id || normalizeWorkspaceId(log.workspace_id) !== row.workspace_id)
          this.conflict("Joined logging differs from the settlement request");
      }
      await assertOutcomeUndisposed(manager, delivery.id, delivery.workspace_id);
      const outcome = this.deliveryOutcome(delivery, delivery.id, row);
      if (outcome.type !== "settlement") this.conflict("Composed delivery requires a settlement outcome");
      const payload = this.normalizeSettlementPayload(outcome.payload);
      this.validateSettlementProposal(row, payload);
      // Unlike the queue-only API, this intent cannot commit before application.
      // Inspect the current stored receipts once in applySettlementInTransaction;
      // any identity, integrity or acknowledgement failure rolls this intent back.
      const intent = await this.writeSettlementIntent(manager, row, payload);
      // Both acknowledgement and application commit together. Validate/write
      // the acknowledgement before acquiring shared budget-row locks so those
      // locks are not held across unrelated inbox/audit work.
      if (acknowledgeReceipts) {
        await this.applySettlementInTransaction(manager, row, intent, true, delivery, completion);
      } else {
        const acknowledged = await transitionRuntimeOutcome(manager, delivery, "delivered");
        if (acknowledged.state !== "delivered") this.conflict("Composed settlement remains quarantined for review");
        await this.applySettlementInTransaction(manager, row, intent, false, undefined, completion);
      }
    });
  }

  /**
   * Commit a stream's immutable receipt before ending HTTP. The owning runtime
   * must drain the returned delivery before settlement, reuse or request teardown.
   * The closure contains only the retained allowlisted document, never a request.
   */
  async prepareStreamReceipt(outcome: Extract<PricingOutcome, { type: "attempt" }>): Promise<() => Promise<void>> {
    return this.prepareRuntimeReceipt(outcome);
  }

  /** The owning request must deliver this receipt or include it in an acknowledged settlement. */
  async prepareRuntimeReceipt(outcome: Extract<PricingOutcome, { type: "attempt" }>): Promise<() => Promise<void>> {
    const retain = prepareRuntimeOutcomeRetention(outcome, false, "attempt");
    const row = await this.retentionWrite(retain);
    let delivery: Promise<void> | undefined;
    return () => delivery ??= this.deliverRuntimeOutcome(row);
  }

  private async deliverRuntimeOutcome(row: RuntimeOutcomeRow, applySettlement = false, acknowledgeReceipts = false, completion?: PendingSettlementLogs): Promise<void> {
    // Apply the immutable retained copy, not a caller-owned object after an await.
    const outcome = JSON.parse(row.outcome_json) as PricingOutcome;
    if (row.state === "review_required") this.conflict("Distinct runtime evidence is durably retained for review");
    if (applySettlement && outcome.type !== "settlement") this.conflict("Composed delivery requires a settlement outcome");
    try {
      // Retention has already committed. Delivery and its mandatory acknowledgement
      // share the next transaction; acknowledgement failure cannot leave a half-delivery.
      if (outcome.type === "attempt") await this.completeAttempt(outcome.attemptId, outcome.workspace, outcome.cost, outcome.errorCode, row.id, row);
      else if (outcome.type === "actual_budget_closure") await this.closeActualBudget(outcome, row);
      else {
        const p = outcome.payload;
        if (applySettlement) await this.applyRuntimeSettlement(row, acknowledgeReceipts, completion);
        else await this.queueSettlement(outcome.reservationId, outcome.workspace, p.kind, p.tokens, p.cost_usd, p.budget_basis, p.receipt, p.receipts, row.id, p.budget_attempt_id, row);
      }
    } catch (error) {
      const review = error instanceof PricingRepositoryError && [400, 404, 409].includes(error.status);
      // Failure to record retry metadata must not replace the original error or erase the durable body.
      await this.outcomeWrite(manager => transitionRuntimeOutcome(manager, row, review ? "review_required" : "pending")).catch(() => undefined);
      throw error;
    }
  }

  /** Replay retained pending bodies only; no model dispatch, fresh pricing or automatic conflict choice. */
  async replayRuntimeOutcomes(now = new Date(), limit = 100) {
    const result = { persisted: 0, pending: 0, review_required: 0, overflow: 0 };
    if (!(await this.available())) return result;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000 || !Number.isFinite(now.getTime())) this.conflict("Invalid runtime replay bound");
    const rows = await serializeDatabaseAccess(this.dataSource, () => this.dataSource.manager.createQueryBuilder().select("o.*").from("pricing_runtime_outcomes", "o")
      .where("o.state = :state AND o.next_attempt_at <= :now", { state: "pending", now: now.toISOString() }).orderBy("o.next_attempt_at", "ASC").addOrderBy("o.id", "ASC").limit(limit).getRawMany<RuntimeOutcomeRow>());
    for (const row of rows) {
      let verified = false;
      try {
        const current = await this.outcomeWrite(manager => readRuntimeOutcome(manager, row.id, row.workspace_id));
        verified = true;
        if (current.row.state !== "pending") continue;
        await this.persistRuntimeOutcome(current.outcome); result.persisted++;
      } catch (error) {
        if (error instanceof SyntaxError || (error instanceof PricingRepositoryError && [400, 404, 409].includes(error.status))) {
          if (!verified) await this.outcomeWrite(manager => quarantineInvalidRuntimeOutcome(manager, row)).catch(() => undefined);
          result.review_required++;
        }
        else result.pending++;
      }
    }
    return result;
  }

  async runtimeOutcomeInventory(workspace: string, state: RuntimeOutcomeState, limit: number, cursor?: string) {
    if (!(await this.available())) this.missing();
    return serializeDatabaseAccess(this.dataSource, () => runtimeOutcomeInventory(this.dataSource.manager, workspace, state, limit, cursor));
  }

  async assertRuntimeOutcomeCapacity(workspace: string): Promise<void> {
    if (!(await this.available())) return;
    const rows = await serializeDatabaseAccess(this.dataSource, () =>
      this.dataSource.manager
        .createQueryBuilder()
        .select("o.id", "id")
        .from("pricing_runtime_outcomes", "o")
        .where("o.workspace_id = :workspace AND o.state IN (:...states)", {
          workspace,
          states: ["pending", "review_required"],
        })
        .andWhere(
          `NOT EXISTS (SELECT 1 FROM ${OUTCOME_DISPOSITION_TABLE} d INNER JOIN pricing_audit_events a ON a.id = d.audit_id AND a.workspace_id = d.workspace_id AND a.actor_id = d.actor_id AND a.action = :action WHERE d.outcome_id = o.id AND d.workspace_id = o.workspace_id AND d.outcome_hash = o.outcome_hash)`,
          { action: "cost.runtime_outcome_disposition" },
        )
        .limit(1000)
        .getRawMany(),
    );
    const groups =
      rows.length >= 1000
        ? []
        : await serializeDatabaseAccess(this.dataSource, () =>
            this.dataSource.manager
              .createQueryBuilder()
              .select("o.id", "id")
              .from(GROUP_OUTCOME_TABLE, "o")
              .where(
                "o.workspace_id = :workspace AND o.state IN (:...states)",
                { workspace, states: ["pending", "review_required"] },
              )
               .andWhere(`NOT EXISTS (SELECT 1 FROM ${GROUP_DISPOSITION_TABLE} d INNER JOIN pricing_audit_events a ON a.id = d.audit_id AND a.workspace_id = d.workspace_id AND a.actor_id = d.actor_id AND a.action = :action WHERE d.outcome_id = o.id AND d.workspace_id = o.workspace_id AND d.outcome_hash = o.document_hash)`,{action:GROUP_DISPOSITION_ACTION})
              .limit(1000 - rows.length)
              .getRawMany(),
          );
    if (rows.length + groups.length >= 1000)
      throw new PricingRepositoryError(
        "pricing_recovery_backpressure",
        "Retained accounting evidence requires recovery before another priced dispatch",
        503,
      );
  }

  async runtimeOutcome(id: string, workspace: string) {
    if (!(await this.available())) this.missing();
    return this.outcomeWrite(async manager => {
      const { row, outcome } = await readRuntimeOutcome(manager, id, workspace);
      const { outcome_json: _json, ...metadata } = row;
      return { ...metadata, outcome, read_only: true, supplier_confirmed: false };
    });
  }

  async outcomeDispositionContext(id: string, workspace: string) {
    return this.outcomeWrite(manager => loadOutcomeDisposition(manager, id, workspace));
  }

  async outcomeDispositionBasis(id: string, workspace: string) {
    const view = (await this.outcomeDispositionContext(id, workspace)).view;
    if (Buffer.byteLength(JSON.stringify(view)) > 4 * 1024 * 1024) this.conflict("Outcome disposition basis exceeds the 4 MiB review bound");
    return view;
  }

  async recordedOutcomeDisposition(actor: PricingActor, id: string, input: OutcomeDispositionInput) {
    return this.outcomeWrite(manager => recordedOutcomeDisposition(manager, id, actor.workspace_id, input.id, dispositionSignature(actor.workspace_id, actor.id, id, input)));
  }

  async outcomeDispositionStatus(id: string, workspace: string, operationId: string) {
    const result = await this.outcomeWrite(manager => recordedOutcomeDisposition(manager, id, workspace, operationId));
    if (!result) this.missing(); return { recorded: true, result };
  }

  async disposeRuntimeOutcome(actor: PricingActor, id: string, input: OutcomeDispositionInput, costs: CostComputation[], dryRun: boolean) {
    if (actor.role !== "admin" || !actor.id || !actor.workspace_id) throw new PricingRepositoryError("pricing_permission_denied", "Outcome review requires workspace administration", 403);
    if (!input.confirm || !["accept_receipts", "reject_evidence"].includes(input.action) || !input.reason.trim() || input.reason.length > 1000 || !/^[a-f0-9]{64}$/.test(input.expected_basis_hash) || !/^[a-f0-9]{64}$/.test(input.expected_outcome_hash)) this.conflict("Invalid outcome disposition input");
    const run = async (manager: EntityManager) => {
      if (manager.connection.options.type === "postgres") await manager.query("SELECT pg_advisory_xact_lock(hashtext($1::text), hashtext($2::text))", ["siftgate.outcome-disposition", `${manager.connection.options.schema ?? ""}:${dispositionAuditId(actor.workspace_id, input.id)}`]);
      const used = await manager.createQueryBuilder().select("d.outcome_id", "id").from(OUTCOME_DISPOSITION_TABLE, "d").where("d.operation_id = :id AND d.workspace_id = :workspace", { id: input.id, workspace: actor.workspace_id }).getRawOne<{ id: string }>();
      if (used && used.id !== id) this.conflict("Disposition retry identity belongs to another outcome");
      const prior = await recordedOutcomeDisposition(manager, id, actor.workspace_id, input.id, dispositionSignature(actor.workspace_id, actor.id, id, input));
      if (prior) return { ...prior, dry_run: dryRun };
      const basis = await loadOutcomeDisposition(manager, id, actor.workspace_id);
      for (const cost of costs) this.validateCost(cost);
      const result = await applyOutcomeDisposition(manager, this.budgets, actor, input, basis, costs, dryRun);
      if (!dryRun && input.action === "accept_receipts") await this.projectCallLogs(manager, basis.outcome.request_id, actor.workspace_id);
      return result;
    };
    return dryRun ? this.outcomeWrite(run) : this.write(run);
  }

  private async outcomeWrite<T>(action: (manager: EntityManager) => Promise<T>): Promise<T> {
    if (!(await this.available())) throw new PricingRepositoryError("pricing_schema_required", "Explicit runtime-outcome migration is required", 503);
    return serializeDatabaseAccess(this.dataSource, () => this.dataSource.transaction(action));
  }

  private async retentionWrite(action: (manager: EntityManager) => Promise<RuntimeOutcomeRow>): Promise<RuntimeOutcomeRow> {
    if (!(await this.available())) throw new PricingRepositoryError("pricing_schema_required", "Explicit runtime-outcome migration is required", 503);
    return serializeDatabaseAccess(this.dataSource, () => {
      // A nested SQLite RELEASE is not a durable acknowledgement of the receipt.
      if (this.dataSource.options.type === "better-sqlite3" && this.dataSource.createQueryRunner().isTransactionActive)
        throw new Error("Runtime retention requires an independent SQLite transaction");
      return executePreparedRetentionTransaction(this.dataSource, action);
    });
  }

  private async verifyRecoveryAcknowledgement(manager: EntityManager, auditId: string, workspace: string, result: RecoveryResolutionResult): Promise<void> {
    const links = await manager.createQueryBuilder().select("d.reservation_id", "reservation_id").from("pricing_recovery_decisions", "d")
      .where("d.resolution_audit_id = :id AND d.workspace_id = :workspace", { id: auditId, workspace }).getRawMany<{ reservation_id: string }>();
    const terminal = result.changes.filter(change => change.next_state !== "reserved");
    if (pricingContentHash(links.map(link => link.reservation_id).sort()) !== pricingContentHash(terminal.map(change => change.reservation_id).sort()))
      this.conflict("Recovery acknowledgement membership is incomplete");
    for (const link of links) if (!(await this.operatorDecisionApplied(manager, link.reservation_id, workspace))) this.conflict("Recovery acknowledgement is not applied");
    for (const change of result.changes) {
      if (change.action !== "reconcile_actual") {
        if (change.next_state === "reserved" || change.actual_closure_hash) this.conflict("Legacy recovery cannot retain an actual fence");
        continue;
      }
      const cohort = await readActualBudgetCohort(manager, change.reservation_id, workspace);
      const reservation = await this.reservation(manager, change.reservation_id, workspace, false);
      if (!cohort || !reservation || reservation.budget_basis !== "actual_upstream" || cohort.request_id !== reservation.request_id || cohort.closure_hash !== change.actual_closure_hash || (change.next_state === "reserved" && (change.budget_attempt_id !== null || ExactDecimal.parse(change.budget_cost_usd).compare(ExactDecimal.zero) !== 0 || change.budget_tokens !== "0")))
        this.conflict("Recovery acknowledgement is missing its actual budget fence");
    }
  }

  private async operatorDecisionApplied(manager: EntityManager, reservationId: string, workspace: string): Promise<boolean> {
      const link = await manager.createQueryBuilder().select("d.*").from("pricing_recovery_decisions", "d").where("d.reservation_id = :id AND d.workspace_id = :workspace", { id: reservationId, workspace: workspace }).getRawOne<{ resolution_audit_id: string; payload_hash: string }>();
      if (!link) return false;
      const row = await this.reservation(manager, reservationId, workspace, false);
      const intent = await this.settlementIntent(manager, reservationId, workspace, false);
      if (!row || row.state === "reserved" || !intent || intent.state !== "applied" || intent.payload_hash !== link.payload_hash || pricingContentHash(recoveryDecode(intent.payload_json)) !== intent.payload_hash) return false;
      const audit = await manager.createQueryBuilder().select("a.metadata_json", "metadata_json").from("pricing_audit_events", "a").where("a.id = :id AND a.workspace_id = :workspace AND a.action = :action", { id: link.resolution_audit_id, workspace: workspace, action: "cost.recovery_resolution" }).getRawOne<{ metadata_json: string }>();
      if (!audit) return false;
      const stored = recoveryDecode<{ result: RecoveryResolutionResult; result_hash: string }>(audit.metadata_json);
      return pricingContentHash(stored.result) === stored.result_hash && stored.result.changes.some((change) => change.reservation_id === row.id && change.next_state === row.state && ExactDecimal.parse(change.budget_cost_usd).compare(ExactDecimal.parse(row.committed_cost_usd)) === 0 && ExactDecimal.parse(change.budget_tokens).compare(ExactDecimal.parse(row.committed_tokens)) === 0);
  }

  private async settlementIntent(
    manager: EntityManager,
    id: string,
    workspace: string,
    lock: boolean,
  ): Promise<CostSettlementIntentRow | undefined> {
    const query = manager
      .createQueryBuilder()
      .select("i.*")
      .from("pricing_settlement_intents", "i")
      .where("i.reservation_id = :id AND i.workspace_id = :workspace", {
        id,
        workspace,
      });
    if (lock && this.dataSource.options.type === "postgres")
      query.setLock("pessimistic_write");
    return query.getRawOne<CostSettlementIntentRow>();
  }

  private async effect(
    manager: EntityManager,
    row: CostReservationRow,
    kind: string,
    tokens: string,
    cost: string,
    allocations: BudgetLedgerHold[],
  ) {
    await manager
      .createQueryBuilder()
      .insert()
      .into("pricing_budget_effects")
      .values({
        id: `${row.id}:${kind}`,
        reservation_id: row.id,
        request_id: row.request_id,
        workspace_id: row.workspace_id,
        kind,
        tokens_decimal: tokens,
        cost_decimal: cost,
        allocations_json: JSON.stringify(allocations),
        created_at: new Date().toISOString(),
      })
      .execute();
  }

  private requireLockTransaction(manager: EntityManager): void {
    if (this.dataSource.options.type === "postgres" &&
      (manager.connection !== this.dataSource || !manager.queryRunner?.isTransactionActive))
      this.conflict("Pricing row locks require an active transaction on the owning database");
  }

  /** Internal dispatch callers already hold this request's fence. Read and lock
   * its complete reservation now, not a previously discovered child snapshot. */
  private async reservationUnderRequest(
    manager: EntityManager,
    id: string,
    request: string,
    workspace: string,
  ): Promise<CostReservationRow | undefined> {
    if (manager.connection !== this.dataSource || !manager.queryRunner?.isTransactionActive)
      this.conflict("Owned reservation reads require the caller's request transaction");
    const query = manager.createQueryBuilder().select("r.*").from("pricing_reservations", "r")
      .where("r.id = :id AND r.request_id = :request AND r.workspace_id = :workspace", { id, request, workspace });
    if (this.dataSource.options.type === "postgres") query.setLock("pessimistic_write");
    return query.getRawOne<CostReservationRow>();
  }

  /** Queue/application callers hold the reservation's request fence before this
   * fresh read. Keep full child rows and PostgreSQL row locks, but acquire them in
   * bounded ID order instead of rediscovering and relocking the same parent per
   * receipt. Only small state/hash fields survive each read chunk; large stored
   * bodies are not accumulated in the map. Nothing is cached across transactions. */
  private async receiptAttemptsUnderRequest(
    manager: EntityManager,
    reservation: CostReservationRow,
    receipts: Array<NonNullable<CostSettlementPayload["receipt"]>>,
  ): Promise<Map<string, ReceiptAttemptState>> {
    if (manager.connection !== this.dataSource || !manager.queryRunner?.isTransactionActive)
      this.conflict("Owned receipt reads require the caller's request transaction");
    const ids = receipts.map(receipt => receipt.attemptId).sort();
    if (new Set(ids).size !== ids.length) this.conflict("Duplicate settlement receipt identity");
    const result = new Map<string, ReceiptAttemptState>();
    for (let offset = 0; offset < ids.length; offset += 128) {
      const chunk = ids.slice(offset, offset + 128);
      const query = manager.createQueryBuilder().select("a.*").from("pricing_attempts", "a")
        .where("a.id IN (:...ids) AND a.request_id = :request AND a.reservation_id = :reservation AND a.workspace_id = :workspace", {
          ids: chunk, request: reservation.request_id, reservation: reservation.id, workspace: reservation.workspace_id,
        }).orderBy("a.id", "ASC");
      if (this.dataSource.options.type === "postgres") query.setLock("pessimistic_write");
      const rows = await query.getRawMany<CostAttemptRow>();
      if (rows.length !== chunk.length) this.missing();
      for (const row of rows) result.set(row.id, {
        id: row.id, state: row.state, cost_hash: row.cost_hash, error_code: row.error_code,
      });
    }
    return result;
  }

  private async requireRequest(
    manager: EntityManager,
    id: string,
    workspace: string,
    lock = false,
  ) {
    if (lock) this.requireLockTransaction(manager);
    const query = manager
      .createQueryBuilder()
      .select("s.request_id")
      .from("pricing_request_snapshots", "s")
      .where("s.request_id = :id AND s.workspace_id = :workspace", {
        id,
        workspace,
      });
    if (lock && this.dataSource.options.type === "postgres")
      query.setLock("pessimistic_write");
    const row = await query.getRawOne();
    if (!row) this.missing();
  }
  private async reservation(
    manager: EntityManager,
    id: string,
    workspace: string,
    lock: boolean,
  ): Promise<CostReservationRow | undefined> {
    if (lock) this.requireLockTransaction(manager);
    const query = manager
      .createQueryBuilder()
      .select("r.*")
      .from("pricing_reservations", "r")
      .where("r.id = :id AND r.workspace_id = :workspace", { id, workspace });
    let owner: string | undefined;
    if (lock) {
      const initial = await query.getRawOne<CostReservationRow>();
      if (!initial) return undefined;
      // A missing/foreign child must not touch any parent. A discovered child's
      // missing/foreign parent is an ownership error, not an absent child.
      owner = initial.request_id;
      await this.requireRequest(manager, owner, workspace, true);
      if (this.dataSource.options.type === "postgres")
        query.setLock("pessimistic_write");
    }
    const row = await query.getRawOne<CostReservationRow>();
    if (lock && row && row.request_id !== owner)
      this.conflict("Owned row changed parents after the request fence");
    return row;
  }
  private async attempt(
    manager: EntityManager,
    id: string,
    workspace: string,
    lock = false,
  ): Promise<CostAttemptRow | undefined> {
    if (lock) this.requireLockTransaction(manager);
    const query = manager
      .createQueryBuilder()
      .select("a.*")
      .from("pricing_attempts", "a")
      .where("a.id = :id AND a.workspace_id = :workspace", { id, workspace });
    let owner: string | undefined;
    if (lock) {
      const initial = await query.getRawOne<CostAttemptRow>();
      if (!initial) return undefined;
      owner = initial.request_id;
      await this.requireRequest(manager, owner, workspace, true);
      if (this.dataSource.options.type === "postgres")
        query.setLock("pessimistic_write");
    }
    const row = await query.getRawOne<CostAttemptRow>();
    if (lock && row && row.request_id !== owner)
      this.conflict("Owned row changed parents after the request fence");
    return row;
  }
  private async write<T>(
    action: (manager: EntityManager) => Promise<T>,
    prepare?: (manager: EntityManager) => PostgresTransactionReadPrelude<T> | null,
  ): Promise<T> {
    if (!(await this.available()))
      throw new PricingRepositoryError(
        "pricing_schema_required",
        "Explicit pricing-ledger migration is required",
        503,
      );
    return this.budgets.withCommittedBudgetEffects(
      () => serializeDatabaseAccess(this.dataSource, () =>
        prepare && this.dataSource.options?.type === "postgres"
          ? withPostgresReadPrelude(this.dataSource, prepare, action)
          : this.dataSource.transaction(action),
      ),
      { refreshLedgerMetrics: true },
    );
  }
  private settlementReceipts(
    payload: CostSettlementPayload,
  ): Array<NonNullable<CostSettlementPayload["receipt"]>> {
    if (
      payload.receipts !== undefined &&
      (!Array.isArray(payload.receipts) || payload.receipts.length > 10000)
    )
      this.conflict("Invalid settlement receipt list");
    const receipts = [
      ...(payload.receipts ?? []),
      ...(payload.receipt ? [payload.receipt] : []),
    ].sort((a, b) => a.attemptId.localeCompare(b.attemptId));
    const ids = new Set<string>();
    for (const entry of receipts) {
      this.text(entry.attemptId);
      if (ids.has(entry.attemptId))
        this.conflict("Duplicate settlement receipt identity");
      ids.add(entry.attemptId);
    }
    if (payload.budget_attempt_id !== undefined) {
      this.text(payload.budget_attempt_id);
      if (
        payload.kind !== "commit" ||
        !receipts.some((entry) => entry.attemptId === payload.budget_attempt_id)
      )
        this.conflict(
          "Logical budget winner must reference an included committed receipt",
        );
    }
    return receipts;
  }

  private validateCost(cost: CostComputation): void {
    try {
      validateBatchShare(cost);
    } catch {
      this.conflict(
        "Batch cost does not match its physical receipt and deterministic allocation",
      );
    }
    if (cost.report_currency !== "USD")
      throw new PricingRepositoryError(
        "pricing_invalid_document",
        "Budget ledger uses an explicitly frozen USD report currency",
        400,
      );
    if (cost.report_amount !== null) this.quantity(cost.report_amount);
    if (cost.report_known_subtotal !== null)
      this.quantity(cost.report_known_subtotal);
  }
  private quantity(value: string, integral = false): void {
    const number = ExactDecimal.parse(value);
    if (
      number.compare(ExactDecimal.zero) < 0 ||
      (integral && !number.isInteger())
    )
      throw new PricingRepositoryError(
        "pricing_invalid_quantity",
        "Invalid budget quantity",
        400,
      );
  }
  private text(value: string): void {
    if (typeof value !== "string" || !value || value.length > 160)
      throw new PricingRepositoryError(
        "pricing_invalid_document",
        "Invalid ledger identity",
        400,
      );
  }
  private missing(): never {
    throw new PricingRepositoryError(
      "pricing_not_found",
      "Ledger resource not found in this workspace",
      404,
    );
  }
  private conflict(message: string): never {
    throw new PricingRepositoryError("pricing_version_conflict", message, 409);
  }
}

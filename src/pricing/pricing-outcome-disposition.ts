import type { EntityManager } from "typeorm";
import type { BudgetService } from "../budget/budget.service";
import {
  readRuntimeOutcome,
  type RuntimeOutcomeRow,
} from "./pricing-outcome-inbox";
import { pricingContentHash } from "./pricing-json";
import { recoveryConflict, recoveryDecode } from "./pricing-recovery-basis";
import {
  PricingRepositoryError,
  type PricingActor,
} from "./pricing-repository.types";
import { appendCostAdjustment, loadCostAdjustments } from "./cost-adjustments";
import { parsePricingInstant } from "./pricing-time";
import { redactErrorText } from "../security/error-redaction";
import type {
  AttemptPriceContext,
  CostAttemptRow,
  CostReservationRow,
  CostSettlementIntentRow,
} from "./cost-ledger.types";
import type { CostComputation } from "./pricing.types";
import type { CostAdjustmentView } from "./cost-adjustment.types";
import type {
  OutcomeDispositionBasis,
  OutcomeDispositionInput,
  OutcomeDispositionResult,
  OutcomeDispositionRow,
} from "./pricing-outcome-disposition.types";

export const OUTCOME_DISPOSITION_TABLE = "pricing_runtime_outcome_dispositions";
const ACTION = "cost.runtime_outcome_disposition";
const MAX_RECEIPTS = 128;
const adjustmentId = (workspace: string, id: string, attempt: string) =>
  `outcome-adjustment:${pricingContentHash([workspace, id, attempt])}`;
export const dispositionAuditId = (workspace: string, id: string) =>
  `outcome-disposition:${pricingContentHash([workspace, id])}`;
export const dispositionSignature = (
  workspace: string,
  actor: string,
  outcome: string,
  input: OutcomeDispositionInput,
) => pricingContentHash({ workspace, actor, outcome, input });
const missing = (): never => {
  throw new PricingRepositoryError(
    "pricing_not_found",
    "Retained evidence is not available in this workspace",
    404,
  );
};

export interface LockedOutcomeDisposition {
  view: OutcomeDispositionBasis;
  outcome: RuntimeOutcomeRow;
  reservation: CostReservationRow;
  intent: CostSettlementIntentRow | null;
  entries: Array<{
    row: CostAttemptRow;
    pricing: AttemptPriceContext;
    history: CostAdjustmentView[];
    retained: CostComputation;
    retainedError: string | null;
    original: CostComputation | null;
    current: CostComputation | null;
  }>;
}

export async function readDispositionRow(
  manager: EntityManager,
  outcomeId: string,
  workspace: string,
): Promise<OutcomeDispositionRow | null> {
  return (
    (await manager
      .createQueryBuilder()
      .select("d.*")
      .from(OUTCOME_DISPOSITION_TABLE, "d")
      .where("d.outcome_id = :id AND d.workspace_id = :workspace", {
        id: outcomeId,
        workspace,
      })
      .getRawOne<OutcomeDispositionRow>()) ?? null
  );
}
export async function verifyDispositionRecord(
  manager: EntityManager,
  row: OutcomeDispositionRow,
): Promise<OutcomeDispositionResult> {
  const result = recoveryDecode<OutcomeDispositionResult>(row.result_json);
  const audit = await manager
    .createQueryBuilder()
    .select(["a.metadata_json AS metadata_json", "a.actor_id AS actor_id"])
    .from("pricing_audit_events", "a")
    .where(
      "a.id = :id AND a.workspace_id = :workspace AND a.action = :action",
      { id: row.audit_id, workspace: row.workspace_id, action: ACTION },
    )
    .getRawOne<{ metadata_json: string; actor_id: string }>();
  const expected = {
    outcome_id: row.outcome_id,
    outcome_hash: row.outcome_hash,
    operation_id: row.operation_id,
    proposal_hash: row.proposal_hash,
    result_hash: row.result_hash,
    action: row.action,
    request_id: row.request_id,
  };
  if (
    !audit ||
    audit.actor_id !== row.actor_id ||
    row.audit_id !== dispositionAuditId(row.workspace_id, row.operation_id) ||
    pricingContentHash(recoveryDecode(audit.metadata_json)) !==
      pricingContentHash(expected) ||
    pricingContentHash(result) !== row.result_hash ||
    result.outcome_id !== row.outcome_id ||
    result.outcome_hash !== row.outcome_hash ||
    result.id !== row.operation_id ||
    result.request_id !== row.request_id ||
    result.action !== row.action ||
    result.dry_run ||
    result.supplier_confirmed !== false ||
    result.outcome_document_modified !== false ||
    result.original_receipts_modified !== false ||
    result.budget_decision_unchanged !== true
  )
    recoveryConflict("Outcome disposition record/audit differs");
  return result;
}

/** Calling writer owns the original request lock. A completed review fences a delayed runtime delivery. */
export async function assertOutcomeUndisposed(
  manager: EntityManager,
  id: string | undefined,
  workspace: string,
): Promise<void> {
  if (!id) return;
  const row = await readDispositionRow(manager, id, workspace);
  if (row) {
    await verifyDispositionRecord(manager, row);
    recoveryConflict(
      "Retained outcome already has an immutable operator disposition",
    );
  }
}

export async function loadOutcomeDisposition(
  manager: EntityManager,
  id: string,
  workspace: string,
): Promise<LockedOutcomeDisposition> {
  const { row: outcome, outcome: document } = await readRuntimeOutcome(
    manager,
    id,
    workspace,
  );
  const snapshot = await manager
    .createQueryBuilder()
    .select("s.*")
    .from("pricing_request_snapshots", "s")
    .where("s.request_id = :id AND s.workspace_id = :workspace", {
      id: outcome.request_id,
      workspace,
    })
    .getRawOne<{
      descriptor_json: string;
      snapshot_hash: string;
      catalog_revision_id: string;
    }>();
  if (!snapshot) return missing();
  const { snapshot_id, ...descriptor } = recoveryDecode<
    Record<string, unknown>
  >(snapshot.descriptor_json);
  if (
    snapshot_id !== snapshot.snapshot_hash ||
    pricingContentHash(descriptor) !== snapshot.snapshot_hash ||
    descriptor.workspace_id !== workspace ||
    descriptor.catalog_revision_id !== snapshot.catalog_revision_id
  )
    recoveryConflict("Pinned outcome price snapshot differs");
  const holdQuery = manager
    .createQueryBuilder()
    .select("r.*")
    .from("pricing_reservations", "r")
    .where("r.id = :id AND r.workspace_id = :workspace", {
      id: outcome.reservation_id,
      workspace,
    });
  if (manager.connection.options.type === "postgres")
    holdQuery.setLock("pessimistic_write");
  const reservation = await holdQuery.getRawOne<CostReservationRow>();
  if (!reservation || reservation.request_id !== outcome.request_id)
    return missing();
  if (
    recoveryDecode<{ workspaceId: string }>(reservation.identity_json)
      ?.workspaceId !== workspace
  )
    recoveryConflict("Outcome reservation identity differs");
  const receipts = (
    document.type === "attempt"
      ? [
          {
            attemptId: document.attemptId,
            cost: document.cost,
            errorCode: document.errorCode,
          },
        ]
      : [
          ...(document.payload.receipts ?? []),
          ...(document.payload.receipt ? [document.payload.receipt] : []),
        ]
  ).sort((a, b) => a.attemptId.localeCompare(b.attemptId));
  if (receipts.length > MAX_RECEIPTS)
    recoveryConflict("Outcome review exceeds the 128 receipt bound");
  const query = manager
    .createQueryBuilder()
    .select(
      [
        "id",
        "request_id",
        "reservation_id",
        "state",
        "cost_hash",
        "error_code",
        "node_id",
        "model",
        "dispatched_at",
      ].map((name) => `a.${name} AS ${name}`),
    )
    .from("pricing_attempts", "a")
    .where("a.request_id = :request AND a.workspace_id = :workspace", {
      request: outcome.request_id,
      workspace,
    })
    .orderBy("a.id", "ASC")
    .limit(4097);
  if (manager.connection.options.type === "postgres")
    query.setLock("pessimistic_write");
  const allAttempts =
    await query.getRawMany<
      Pick<
        CostAttemptRow,
        | "id"
        | "request_id"
        | "reservation_id"
        | "state"
        | "cost_hash"
        | "error_code"
        | "node_id"
        | "model"
        | "dispatched_at"
      >
    >();
  if (allAttempts.length > 4096)
    recoveryConflict("Outcome attempt history exceeds bounded review");
  const intentQuery = manager
    .createQueryBuilder()
    .select("i.*")
    .from("pricing_settlement_intents", "i")
    .where("i.reservation_id = :id AND i.workspace_id = :workspace", {
      id: reservation.id,
      workspace,
    });
  if (manager.connection.options.type === "postgres")
    intentQuery.setLock("pessimistic_write");
  const intent =
    (await intentQuery.getRawOne<CostSettlementIntentRow>()) ?? null;
  if (
    intent &&
    (intent.request_id !== outcome.request_id ||
      pricingContentHash(recoveryDecode(intent.payload_json)) !==
        intent.payload_hash)
  )
    recoveryConflict("Outcome original budget intent differs");
  const applications = await manager
    .createQueryBuilder()
    .select("a.adjustment_id", "id")
    .from("pricing_adjustment_applications", "a")
    .where("a.request_id = :request AND a.workspace_id = :workspace", {
      request: outcome.request_id,
      workspace,
    })
    .limit(4097)
    .getRawMany();
  if (applications.length > 4096)
    recoveryConflict("Outcome correction history exceeds bounded review");
  for (const receipt of receipts) {
    const row = allAttempts.find(
      (row) =>
        row.id === receipt.attemptId && row.reservation_id === reservation.id,
    );
    if (!row) return missing();
  }
  const ids = receipts.map((receipt) => receipt.attemptId);
  const byteSize = (column: string) =>
    manager.connection.options.type === "postgres"
      ? `OCTET_LENGTH(COALESCE(${column}, ''))`
      : `LENGTH(CAST(COALESCE(${column}, '') AS BLOB))`;
  if (ids.length) {
    const rawSize = await manager
      .createQueryBuilder()
      .select(
        `SUM(${byteSize("a.cost_json")} + ${byteSize("a.price_context_json")})`,
        "size",
      )
      .from("pricing_attempts", "a")
      .where("a.id IN (:...ids) AND a.workspace_id = :workspace", {
        ids,
        workspace,
      })
      .getRawOne<{ size: string | number }>();
    const historySize = await manager
      .createQueryBuilder()
      .select(`SUM(${byteSize("a.cost_json")})`, "size")
      .from("pricing_cost_adjustments", "a")
      .where("a.attempt_id IN (:...ids) AND a.workspace_id = :workspace", {
        ids,
        workspace,
      })
      .getRawOne<{ size: string | number }>();
    if (
      Number(rawSize?.size ?? 0) + Number(historySize?.size ?? 0) >
      8 * 1024 * 1024
    )
      recoveryConflict(
        "Selected receipt history exceeds the 8 MiB inspection bound",
      );
  }
  const complete = ids.length
    ? await manager
        .createQueryBuilder()
        .select("a.*")
        .from("pricing_attempts", "a")
        .where("a.id IN (:...ids) AND a.workspace_id = :workspace", {
          ids,
          workspace,
        })
        .getRawMany<CostAttemptRow>()
    : [];
  const selected = receipts.map((receipt) => {
    const row = complete.find((row) => row.id === receipt.attemptId);
    if (!row) return missing();
    return row;
  });
  const history = await loadCostAdjustments(
    manager,
    outcome.request_id,
    workspace,
    selected,
  );
  const entries = receipts.map((receipt, index) => {
    const row = selected[index],
      revisions = history.get(row.id) ?? [],
      original =
        row.cost_json === null
          ? null
          : recoveryDecode<CostComputation>(row.cost_json);
    if (
      !["terminal", "dispatched"].includes(row.state) ||
      (row.state === "terminal" &&
        (!original || pricingContentHash(original) !== row.cost_hash)) ||
      (row.state !== "terminal" &&
        (original || row.cost_hash || revisions.length))
    )
      recoveryConflict("Original outcome attempt evidence is inconsistent");
    const pricing = recoveryDecode<AttemptPriceContext>(row.price_context_json);
    if (
      !pricing ||
      typeof pricing !== "object" ||
      !pricing.context ||
      typeof pricing.context !== "object"
    )
      recoveryConflict("Original attempt pricing context is unavailable");
    return {
      row,
      pricing,
      history: revisions,
      retained: receipt.cost,
      retainedError: receipt.errorCode ?? null,
      original,
      current: revisions.at(-1)?.cost ?? original,
    };
  });
  const media = await manager
    .createQueryBuilder()
    .select([
      "t.id AS id",
      "t.state AS state",
      "t.revision AS revision",
      "t.context_hash AS context_hash",
    ])
    .from("pricing_media_tasks", "t")
    .where("t.reservation_id = :id AND t.workspace_id = :workspace", {
      id: reservation.id,
      workspace,
    })
    .limit(1025)
    .getRawMany<{ state: string }>();
  if (media.length > 1024)
    recoveryConflict("Outcome media history exceeds bounded review");
  const relatives = await manager
    .createQueryBuilder()
    .select([
      "o.id AS id",
      "o.kind AS kind",
      "o.state AS state",
      "o.outcome_hash AS outcome_hash",
      "d.action AS disposition",
      "d.result_hash AS disposition_hash",
    ])
    .from("pricing_runtime_outcomes", "o")
    .leftJoin(
      OUTCOME_DISPOSITION_TABLE,
      "d",
      "d.outcome_id = o.id AND d.workspace_id = o.workspace_id",
    )
    .where("o.request_id = :request AND o.workspace_id = :workspace", {
      request: outcome.request_id,
      workspace,
    })
    .orderBy("o.id", "ASC")
    .limit(4097)
    .getRawMany<
      OutcomeDispositionBasis["related_outcomes"][number] & {
        disposition_hash: string | null;
      }
    >();
  if (relatives.length > 4096)
    recoveryConflict("Related outcome history exceeds bounded review");
  const disposition = await readDispositionRow(manager, id, workspace);
  if (disposition) await verifyDispositionRecord(manager, disposition);
  const blocked: OutcomeDispositionBasis["blocked_reason"] = disposition
    ? "already_disposed"
    : outcome.state !== "review_required"
      ? "not_review_required"
      : parsePricingInstant(reservation.lease_until) > Date.now()
        ? "lease_active"
        : intent &&
            (intent.state !== "applied" || reservation.state === "reserved")
          ? "pending_intent"
          : reservation.job_id ||
              media.some((row) => row.state !== "synchronous")
            ? "async_owned"
            : entries.some(
                  (e) =>
                    e.pricing.batch ||
                    e.retained.batch ||
                    e.retained.allocation_failure ||
                    e.original?.batch,
                )
              ? "batch_group_required"
              : entries.some((e) => e.row.fee_source !== "provider")
                ? "not_provider"
                : null;
  const basisHash = pricingContentHash({
    outcome,
    snapshot,
    reservation,
    intent,
    attempts: allAttempts,
    selected,
    media,
    history: entries.map((e) =>
      e.history.map((r) => r.application.application_hash),
    ),
    relatives,
    disposition,
  });
  return {
    outcome,
    reservation,
    intent,
    entries,
    view: {
      outcome_id: id,
      outcome_hash: outcome.outcome_hash,
      request_id: outcome.request_id,
      reservation_id: reservation.id,
      basis_hash: basisHash,
      source: "gateway_runtime",
      supplier_confirmed: false,
      related_outcomes: relatives.map(
        ({ disposition_hash: _hash, ...row }) => row,
      ),
      disposition: disposition
        ? {
            id: disposition.operation_id,
            action: disposition.action,
            actor_id: disposition.actor_id,
            result_hash: disposition.result_hash,
          }
        : null,
      blocked_reason: blocked,
      receipts: entries.map((e) => ({
        attempt_id: e.row.id,
        original: e.original,
        current: e.current,
        current_hash: e.history.at(-1)?.cost_hash ?? e.row.cost_hash,
        retained: e.retained,
        retained_hash: pricingContentHash(e.retained),
        recorded_error: e.row.error_code,
        retained_error: e.retainedError,
      })),
      budget_decision_unchanged: true,
    },
  };
}

/** Acknowledgement verifies immutable custody, required audit and every recorded receipt/revision. */
export async function recordedOutcomeDisposition(
  manager: EntityManager,
  id: string,
  workspace: string,
  operationId: string,
  signature?: string,
): Promise<OutcomeDispositionResult | null> {
  const disposition = await readDispositionRow(manager, id, workspace);
  if (!disposition) return null;
  if (
    disposition.operation_id !== operationId ||
    (signature && disposition.proposal_hash !== signature)
  )
    recoveryConflict("Outcome disposition identity was reused");
  const { row: outcome } = await readRuntimeOutcome(manager, id, workspace);
  const result = await verifyDispositionRecord(manager, disposition);
  if (
    outcome.outcome_hash !== disposition.outcome_hash ||
    outcome.request_id !== disposition.request_id
  )
    recoveryConflict("Disposition retained evidence differs");
  const basis = await loadOutcomeDisposition(manager, id, workspace);
  if (result.action === "reject_evidence" && result.changes.length)
    recoveryConflict("Rejected evidence cannot have monetary effects");
  if (
    result.action === "accept_receipts" &&
    result.changes.length !== basis.entries.length
  )
    recoveryConflict("Disposition receipt membership differs");
  for (const change of result.changes) {
    const entry = basis.entries.find((e) => e.row.id === change.attempt_id);
    if (
      !entry ||
      pricingContentHash(change.cost) !== change.cost_hash ||
      change.cost_hash !== pricingContentHash(entry.retained)
    )
      recoveryConflict("Disposition selected receipt differs");
    if (change.operation === "initial_receipt") {
      if (
        entry.row.cost_hash !== change.cost_hash ||
        entry.row.error_code !== change.error_code
      )
        recoveryConflict("Selected initial receipt differs");
    } else if (change.operation === "linked_correction") {
      const revision = entry.history.find(
        (r) => r.id === adjustmentId(workspace, operationId, change.attempt_id),
      );
      if (
        !revision ||
        pricingContentHash(revision) !==
          pricingContentHash(change.adjustment) ||
        revision.cost_hash !== change.cost_hash ||
        revision.previous_hash !== change.previous_cost_hash
      )
        recoveryConflict("Selected linked correction differs");
    } else if (change.operation === "already_recorded") {
      if (
        entry.row.cost_hash !== change.cost_hash &&
        !entry.history.some((r) => r.cost_hash === change.cost_hash)
      )
        recoveryConflict("No unchanged receipt backs the disposition");
    } else recoveryConflict("Unknown disposition receipt operation");
  }
  return { ...result, replayed: true };
}

const noBudget = (): OutcomeDispositionResult["changes"][number]["budget"] => ({
  budget_state: "not_applicable",
  budget_cost_before: null,
  budget_cost_after: null,
  budget_tokens_before: null,
  budget_tokens_after: null,
  cost_delta: "0.000000000000000000",
  tokens_delta: "0",
  allocations: [],
  current_period_refund_not_guaranteed: true,
});
export async function applyOutcomeDisposition(
  manager: EntityManager,
  budgets: BudgetService,
  actor: PricingActor,
  input: OutcomeDispositionInput,
  basis: LockedOutcomeDisposition,
  verifiedCosts: CostComputation[],
  dryRun: boolean,
): Promise<OutcomeDispositionResult> {
  if (
    basis.view.blocked_reason ||
    basis.view.basis_hash !== input.expected_basis_hash ||
    basis.view.outcome_hash !== input.expected_outcome_hash
  )
    recoveryConflict("Outcome review is stale or owned; reread its basis");
  if (
    input.action === "accept_receipts" &&
    (!basis.entries.length || verifiedCosts.length !== basis.entries.length)
  )
    recoveryConflict(
      "Accept complete receipt evidence, not a budget-only proposal",
    );
  const changes: OutcomeDispositionResult["changes"] = [];
  if (input.action === "accept_receipts")
    for (const [index, entry] of basis.entries.entries()) {
      const cost = verifiedCosts[index],
        costHash = pricingContentHash(cost),
        previous = entry.current,
        previousHash = previous ? pricingContentHash(previous) : null;
      if (costHash !== pricingContentHash(entry.retained))
        recoveryConflict(
          "Verified cost differs from immutable retained evidence",
        );
      let operation: OutcomeDispositionResult["changes"][number]["operation"] =
          "already_recorded",
        adjustment: CostAdjustmentView | null = null,
        budget = noBudget();
      if (!previous) {
        operation = "initial_receipt";
        if (!dryRun) {
          const inserted = await manager
            .createQueryBuilder()
            .update("pricing_attempts")
            .set({
              state: "terminal",
              cost_json: JSON.stringify(cost),
              cost_hash: costHash,
              error_code: entry.retainedError,
              completed_at: new Date().toISOString(),
            })
            .where(
              "id = :id AND workspace_id = :workspace AND state = :state AND cost_hash IS NULL AND cost_json IS NULL",
              {
                id: entry.row.id,
                workspace: actor.workspace_id,
                state: "dispatched",
              },
            )
            .execute();
          if (inserted.affected !== 1)
            recoveryConflict(
              "Original missing receipt changed before adoption",
            );
        }
      } else if (previousHash !== costHash) {
        operation = "linked_correction";
        const { view } = await appendCostAdjustment(
          manager,
          budgets,
          {
            id: adjustmentId(actor.workspace_id, input.id, entry.row.id),
            workspace: actor.workspace_id,
            attemptId: entry.row.id,
            expectedCostHash: previousHash!,
            cost,
            reason: redactErrorText(input.reason, { maxLength: 1000 }),
            actorId: actor.id,
            source: "reconciliation",
          },
          entry.row,
          basis.reservation,
          basis.intent,
          { dryRun, allowUnsettled: true },
        );
        const a = view.application;
        budget = {
          budget_state: a.budget_state,
          budget_cost_before: a.budget_cost_before,
          budget_cost_after: a.budget_cost_after,
          budget_tokens_before: a.budget_tokens_before,
          budget_tokens_after: a.budget_tokens_after,
          cost_delta: a.cost_delta,
          tokens_delta: a.tokens_delta,
          allocations: a.allocations,
          current_period_refund_not_guaranteed: true,
        };
        adjustment = dryRun ? null : view;
      }
      changes.push({
        attempt_id: entry.row.id,
        operation,
        previous_cost: previous,
        previous_cost_hash: previousHash,
        cost,
        cost_hash: costHash,
        error_code: previous ? entry.row.error_code : entry.retainedError,
        original_error_preserved: Boolean(previous),
        adjustment,
        budget,
      });
    }
  const result: OutcomeDispositionResult = {
    id: input.id,
    outcome_id: basis.outcome.id,
    outcome_hash: basis.outcome.outcome_hash,
    request_id: basis.outcome.request_id,
    basis_hash: input.expected_basis_hash,
    action: input.action,
    dry_run: dryRun,
    replayed: false,
    supplier_confirmed: false,
    outcome_document_modified: false,
    original_receipts_modified: false,
    budget_decision_unchanged: true,
    changes,
  };
  if (Buffer.byteLength(JSON.stringify(result)) > 4 * 1024 * 1024)
    recoveryConflict("Outcome disposition review exceeds 4 MiB");
  if (dryRun) return result;
  const row: OutcomeDispositionRow = {
    outcome_id: basis.outcome.id,
    workspace_id: actor.workspace_id,
    request_id: basis.outcome.request_id,
    operation_id: input.id,
    actor_id: actor.id,
    action: input.action,
    outcome_hash: basis.outcome.outcome_hash,
    proposal_hash: dispositionSignature(
      actor.workspace_id,
      actor.id,
      basis.outcome.id,
      input,
    ),
    result_hash: pricingContentHash(result),
    audit_id: dispositionAuditId(actor.workspace_id, input.id),
    created_at: new Date().toISOString(),
    result_json: JSON.stringify(result),
  };
  await manager
    .createQueryBuilder()
    .insert()
    .into("pricing_audit_events")
    .values({
      id: row.audit_id,
      workspace_id: actor.workspace_id,
      book_id: null,
      actor_id: actor.id,
      action: ACTION,
      reason: redactErrorText(input.reason, { maxLength: 1000 }),
      created_at: row.created_at,
      metadata_json: JSON.stringify({
        outcome_id: row.outcome_id,
        outcome_hash: row.outcome_hash,
        operation_id: row.operation_id,
        proposal_hash: row.proposal_hash,
        result_hash: row.result_hash,
        action: row.action,
        request_id: row.request_id,
      }),
    })
    .execute();
  await manager
    .createQueryBuilder()
    .insert()
    .into(OUTCOME_DISPOSITION_TABLE)
    .values(row)
    .execute();
  return result;
}

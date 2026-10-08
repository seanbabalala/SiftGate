import type { EntityManager } from "typeorm";
import type { BudgetService } from "../budget/budget.service";
import type {
  CostAttemptRow,
  CostReservationRow,
  CostSettlementIntentRow,
  AttemptPriceContext,
} from "./cost-ledger.types";
import type { CostComputation } from "./pricing.types";
import type { PricingActor } from "./pricing-repository.types";
import type { PricingTarget } from "./pricing-catalog.types";
import type {
  AttemptCorrectionInput,
  AttemptCorrectionResult,
  LockedAttemptCorrection,
} from "./attempt-correction.types";
import { loadCostAdjustments, appendCostAdjustment } from "./cost-adjustments";
import { recoveryConflict, recoveryDecode } from "./pricing-recovery-basis";
import { pricingContentHash } from "./pricing-json";
import { PricingRepositoryError } from "./pricing-repository.types";
import { redactErrorText } from "../security/error-redaction";
import { parsePricingInstant } from "./pricing-time";
import { actualBudgetAdjustmentBasis } from "./actual-upstream-budget-adjustments";

const action = "cost.attempt_attestation";
export const attemptCorrectionAuditId = (workspace: string, id: string) =>
  `attempt-attestation:${pricingContentHash([workspace, id])}`;
const adjustmentId = (workspace: string, id: string) =>
  `single-${pricingContentHash([workspace, id])}`;
export const attemptCorrectionSignature = (
  actor: PricingActor,
  attemptId: string,
  input: AttemptCorrectionInput,
) =>
  pricingContentHash({
    workspace: actor.workspace_id,
    actor: actor.id,
    attemptId,
    input,
  });
function missing(): never {
  throw new PricingRepositoryError(
    "pricing_not_found",
    "Attempt correction is not available in this workspace",
    404,
  );
}

/** All callers use the existing request -> reservation -> attempt -> intent lock order. */
export async function loadAttemptCorrection(
  manager: EntityManager,
  workspace: string,
  id: string,
): Promise<LockedAttemptCorrection> {
  const getAttempt = () =>
    manager
      .createQueryBuilder()
      .select("a.*")
      .from("pricing_attempts", "a")
      .where("a.id = :id AND a.workspace_id = :workspace", { id, workspace });
  const first = await getAttempt().getRawOne<CostAttemptRow>();
  if (!first) missing();
  const snapshotQuery = manager
    .createQueryBuilder()
    .select("s.*")
    .from("pricing_request_snapshots", "s")
    .where("s.request_id = :request AND s.workspace_id = :workspace", {
      request: first.request_id,
      workspace,
    });
  if (manager.connection.options.type === "postgres")
    snapshotQuery.setLock("pessimistic_write");
  const snapshot = await snapshotQuery.getRawOne<{
    descriptor_json: string;
    snapshot_hash: string;
    catalog_revision_id: string;
  }>();
  if (!snapshot) missing();
  const { snapshot_id, ...body } = recoveryDecode<Record<string, unknown>>(
    snapshot.descriptor_json,
  );
  if (
    snapshot_id !== snapshot.snapshot_hash ||
    pricingContentHash(body) !== snapshot.snapshot_hash ||
    body.workspace_id !== workspace ||
    body.catalog_revision_id !== snapshot.catalog_revision_id
  )
    recoveryConflict("Original request price snapshot is invalid");
  let reservation: CostReservationRow | null = null;
  if (first.reservation_id) {
    const query = manager
      .createQueryBuilder()
      .select("r.*")
      .from("pricing_reservations", "r")
      .where("r.id = :id AND r.workspace_id = :workspace", {
        id: first.reservation_id,
        workspace,
      });
    if (manager.connection.options.type === "postgres")
      query.setLock("pessimistic_write");
    reservation = (await query.getRawOne<CostReservationRow>()) ?? null;
    if (!reservation || reservation.request_id !== first.request_id) missing();
    if (
      recoveryDecode<{ workspaceId: string }>(reservation.identity_json)
        ?.workspaceId !== workspace
    )
      recoveryConflict("Reservation budget identity is outside this workspace");
  }
  const locked = getAttempt();
  if (manager.connection.options.type === "postgres")
    locked.setLock("pessimistic_write");
  const attempt = await locked.getRawOne<CostAttemptRow>();
  if (
    !attempt ||
    attempt.request_id !== first.request_id ||
    attempt.reservation_id !== first.reservation_id
  )
    recoveryConflict("Attempt identity changed while acquiring locks");
  if (attempt.state !== "terminal" || !attempt.cost_json || !attempt.cost_hash)
    recoveryConflict(
      "Missing first receipts must use usage recovery before correction",
    );
  const original = recoveryDecode<CostComputation>(attempt.cost_json);
  if (pricingContentHash(original) !== attempt.cost_hash)
    recoveryConflict("Original receipt integrity check failed");
  let intent: CostSettlementIntentRow | null = null;
  if (reservation) {
    const query = manager
      .createQueryBuilder()
      .select("i.*")
      .from("pricing_settlement_intents", "i")
      .where("i.reservation_id = :id AND i.workspace_id = :workspace", {
        id: reservation.id,
        workspace,
      });
    if (manager.connection.options.type === "postgres")
      query.setLock("pessimistic_write");
    intent = (await query.getRawOne<CostSettlementIntentRow>()) ?? null;
    if (
      intent &&
      (intent.request_id !== first.request_id ||
        pricingContentHash(recoveryDecode(intent.payload_json)) !==
          intent.payload_hash)
    )
      recoveryConflict("Original settlement intent is invalid");
  }
  // Bound the shared history loader before it fetches any complete revision chain.
  const count = await manager
    .createQueryBuilder()
    .select("h.adjustment_id")
    .from("pricing_adjustment_applications", "h")
    .where("h.request_id = :request AND h.workspace_id = :workspace", {
      request: first.request_id,
      workspace,
    })
    .limit(4097)
    .getRawMany();
  const revisions = await manager
    .createQueryBuilder()
    .select("h.id")
    .from("pricing_cost_adjustments", "h")
    .where("h.attempt_id = :id AND h.workspace_id = :workspace", {
      id,
      workspace,
    })
    .limit(4097)
    .getRawMany();
  if (count.length > 4096 || revisions.length > 4096)
    recoveryConflict("Correction history exceeds bounded inspection");
  const history =
    (
      await loadCostAdjustments(manager, first.request_id, workspace, [attempt])
    ).get(id) ?? [];
  const current = history.at(-1)?.cost ?? original;
  const pricing = recoveryDecode<AttemptPriceContext>(
    attempt.price_context_json,
  );
  if (
    !pricing ||
    !pricing.context ||
    typeof pricing.context !== "object" ||
    Array.isArray(pricing.context)
  )
    recoveryConflict("Recorded pricing context is invalid");
  const media = await manager
    .createQueryBuilder()
    .select([
      "t.id",
      "t.reservation_id",
      "t.state",
      "t.revision",
      "t.context_hash",
    ])
    .from("pricing_media_tasks", "t")
    .where("t.workspace_id = :workspace AND t.request_id = :request", {
      workspace,
      request: first.request_id,
    })
    .limit(1025)
    .getRawMany<{
      id: string;
      reservation_id: string;
      state: string;
      revision: number;
      context_hash: string;
    }>();
  if (media.length > 1024)
    recoveryConflict("Media ownership exceeds bounded inspection");
  const actual = reservation?.budget_basis === "actual_upstream" ? await actualBudgetAdjustmentBasis(manager, reservation) : null;
  const blocked =
    pricing.batch || original.batch
      ? "batch_group_required"
      : attempt.fee_source !== "provider"
        ? "not_provider"
        : reservation?.job_id ||
            media.some(
              (row) =>
                (row.id === id || row.reservation_id === reservation?.id) &&
                row.state !== "synchronous",
            )
          ? "async_owned"
          : intent &&
              (intent.state !== "applied" || reservation?.state === "reserved")
            ? "pending_intent"
            : reservation &&
                !actual &&
                parsePricingInstant(reservation.lease_until) > Date.now()
              ? "lease_active"
              : null;
  const basisHash = pricingContentHash({
    attempt,
    reservation,
    intent,
    snapshot,
    history: history.map((row) => [
      row.id,
      row.cost_hash,
      row.application.application_hash,
    ]),
    media,
    ...(actual ? { actual_budget_basis_hash: actual.basis_hash } : {}),
  });
  return {
    view: {
      attempt_id: id,
      request_id: attempt.request_id,
      basis_hash: basisHash,
      effective_cost_hash: history.at(-1)?.cost_hash ?? attempt.cost_hash,
      original,
      current,
      revision: history.length,
      reservation_state: reservation?.state ?? null,
      blocked_reason: blocked,
    },
    attempt,
    reservation,
    intent,
    history,
    pricing,
    target: {
      node_id: attempt.node_id,
      model: attempt.model,
      ...(pricing.context.media?.operation
        ? { operation: pricing.context.media.operation }
        : {}),
      ...(reservation && recoveryDecode<PricingTarget>(reservation.target_json).operation
        ? { operation: recoveryDecode<PricingTarget>(reservation.target_json).operation }
        : {}),
    } satisfies PricingTarget,
  };
}

export async function recordedAttemptCorrection(
  manager: EntityManager,
  workspace: string,
  attemptId: string,
  id: string,
  signature?: string,
): Promise<AttemptCorrectionResult | null> {
  const row = await manager
    .createQueryBuilder()
    .select("e.metadata_json", "metadata_json")
    .from("pricing_audit_events", "e")
    .where(
      "e.id = :id AND e.workspace_id = :workspace AND e.action = :action",
      { id: attemptCorrectionAuditId(workspace, id), workspace, action },
    )
    .getRawOne<{ metadata_json: string }>();
  if (!row) return null;
  const stored = recoveryDecode<{
      signature: string;
      result: AttemptCorrectionResult;
      result_hash: string;
    }>(row.metadata_json),
    result = stored?.result;
  if (
    !result ||
    result.id !== id ||
    result.attempt_id !== attemptId ||
    (signature && stored.signature !== signature)
  )
    recoveryConflict("Correction identity was reused");
  if (
    result.dry_run ||
    result.supplier_confirmed !== false ||
    result.original_receipt_modified !== false ||
    pricingContentHash(result) !== stored.result_hash ||
    !result.adjustment
  )
    recoveryConflict("Correction acknowledgement integrity failed");
  const basis = await loadAttemptCorrection(manager, workspace, attemptId);
  const revision = basis.history.find(
    (entry) => entry.id === adjustmentId(workspace, id),
  );
  if (
    !revision ||
    pricingContentHash(revision) !== pricingContentHash(result.adjustment) ||
    revision.previous_hash !== result.previous_cost_hash ||
    revision.cost_hash !== result.cost_hash ||
    pricingContentHash(result.cost) !== result.cost_hash
  )
    recoveryConflict("Audited correction is missing or differs from its chain");
  return { ...result, replayed: true };
}

export async function applyAttestedAttemptCorrection(
  manager: EntityManager,
  budgets: BudgetService,
  actor: PricingActor,
  attemptId: string,
  input: AttemptCorrectionInput,
  basis: LockedAttemptCorrection,
  cost: CostComputation,
  dryRun: boolean,
): Promise<AttemptCorrectionResult> {
  if (
    basis.view.blocked_reason ||
    basis.view.basis_hash !== input.expected_basis_hash ||
    basis.view.effective_cost_hash !== input.expected_cost_hash
  )
    recoveryConflict(
      `Correction basis changed or is blocked: ${basis.view.blocked_reason ?? "stale_evidence"}`,
    );
  if (
    cost.batch ||
    pricingContentHash(cost.attribution ?? null) !==
      pricingContentHash(basis.view.original.attribution ?? null)
  )
    recoveryConflict("Correction cannot rewrite physical dispatch attribution");
  const { view } = await appendCostAdjustment(
    manager,
    budgets,
    {
      id: adjustmentId(actor.workspace_id, input.id),
      workspace: actor.workspace_id,
      attemptId,
      expectedCostHash: input.expected_cost_hash,
      cost,
      reason: redactErrorText(input.reason, { maxLength: 1000 }),
      actorId: actor.id,
      source: "reconciliation",
    },
    basis.attempt,
    basis.reservation,
    basis.intent,
    { dryRun, allowUnsettled: true },
  );
  const a = view.application;
  const result: AttemptCorrectionResult = {
    id: input.id,
    attempt_id: attemptId,
    request_id: basis.attempt.request_id,
    basis_hash: input.expected_basis_hash,
    previous_cost_hash: input.expected_cost_hash,
    cost_hash: view.cost_hash,
    previous_cost: basis.view.current,
    cost,
    dry_run: dryRun,
    replayed: false,
    supplier_confirmed: false,
    original_receipt_modified: false,
    adjustment: dryRun ? null : view,
    budget: {
      budget_state: a.budget_state,
      budget_cost_before: a.budget_cost_before,
      budget_cost_after: a.budget_cost_after,
      budget_tokens_before: a.budget_tokens_before,
      budget_tokens_after: a.budget_tokens_after,
      cost_delta: a.cost_delta,
      tokens_delta: a.tokens_delta,
      allocations: a.allocations,
      current_period_refund_not_guaranteed: true,
    },
  };
  if (Buffer.byteLength(JSON.stringify(result)) > 4 * 1024 * 1024)
    recoveryConflict("Correction review exceeds the bounded 4 MiB size");
  if (!dryRun)
    await manager
      .createQueryBuilder()
      .insert()
      .into("pricing_audit_events")
      .values({
        id: attemptCorrectionAuditId(actor.workspace_id, input.id),
        workspace_id: actor.workspace_id,
        book_id: null,
        actor_id: actor.id,
        action,
        reason: redactErrorText(input.reason, { maxLength: 1000 }),
        created_at: new Date().toISOString(),
        metadata_json: JSON.stringify({
          signature: attemptCorrectionSignature(actor, attemptId, input),
          result,
          result_hash: pricingContentHash(result),
          evidence_digest: input.evidence_digest ?? null,
        }),
      })
      .execute();
  return result;
}

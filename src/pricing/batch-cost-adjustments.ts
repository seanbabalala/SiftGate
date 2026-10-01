import { parsePricingInstant } from "./pricing-time";
import type { EntityManager } from "typeorm";
import type { BudgetService } from "../budget/budget.service";
import type { BudgetLedgerPreview } from "../budget/budget-ledger.types";
import type {
  BatchCostAdjustmentInput,
  BatchCostAdjustmentResult,
  CostAdjustmentInput,
  CostAdjustmentView,
} from "./cost-adjustment.types";
import type {
  AttemptPriceContext,
  CostAttemptRow,
  CostReservationRow,
  CostSettlementIntentRow,
} from "./cost-ledger.types";
import type { CostComputation } from "./pricing.types";
import {
  allocateBatchCost,
  batchShareCost,
  validateBatchShare,
} from "./cost-allocation";
import { appendCostAdjustment, loadCostAdjustments } from "./cost-adjustments";
import { pricingContentHash } from "./pricing-json";
import { PricingRepositoryError } from "./pricing-repository.types";
import { readActualBudgetCohort, actualBudgetClosure } from "./actual-upstream-budget-cohort";

function conflict(message: string): never {
  throw new PricingRepositoryError("pricing_version_conflict", message, 409);
}
function missing(): never {
  throw new PricingRepositoryError(
    "pricing_not_found",
    "Batch cost evidence not found in this workspace",
    404,
  );
}
function decode<T>(json: string): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return conflict("Batch cost evidence is not valid JSON");
  }
}
function checked(cost: CostComputation) {
  try {
    if (!cost.batch) throw new Error("Missing batch");
    validateBatchShare(cost);
  } catch {
    conflict("Batch member has invalid physical/allocation evidence");
  }
  return cost;
}
function same<T>(a: T, b: T) {
  return pricingContentHash(a) === pricingContentHash(b);
}

export interface BatchAdjustmentMember {
  attempt: CostAttemptRow;
  reservation: CostReservationRow;
  intent: CostSettlementIntentRow | null;
  initial: CostComputation;
  current: CostComputation;
  hash: string;
  history: CostAdjustmentView[];
}
export interface BatchAdjustmentGroup {
  members: BatchAdjustmentMember[];
  physical: CostComputation;
  physicalHash: string;
  revision: number;
}

/** Internal retained-evidence workflow options; normal correction APIs keep strict defaults. */
export interface BatchAdjustmentOptions {
  allowUnsettled?: boolean;
  allowResponseModelUpdate?: boolean;
  previewBudget?: boolean;
  budgetPreview?: BudgetLedgerPreview;
}

/** Read only the known batch's bounded member set. Lock order matches grouped dispatch/outcome paths. */
export async function loadBatchAdjustmentGroup(
  manager: EntityManager,
  workspace: string,
  attemptId: string,
  lock: boolean,
  options: BatchAdjustmentOptions = {},
): Promise<BatchAdjustmentGroup> {
  const postgres = manager.connection.options.type === "postgres";
  const initialRow = await manager
    .createQueryBuilder()
    .select("a.*")
    .from("pricing_attempts", "a")
    .where("a.id = :id AND a.workspace_id = :workspace", {
      id: attemptId,
      workspace,
    })
    .getRawOne<CostAttemptRow>();
  if (!initialRow) missing();
  if (
    initialRow.state !== "terminal" ||
    !initialRow.cost_json ||
    !initialRow.cost_hash
  )
    conflict("Only a recorded terminal batch can be corrected");
  const anchor = checked(decode<CostComputation>(initialRow.cost_json));
  if (pricingContentHash(anchor) !== initialRow.cost_hash)
    conflict("Initial batch cost hash mismatch");
  const batch = anchor.batch!;
  const ids = batch.members.map((member) => member.request_id);
  const reservations = new Map<string, CostReservationRow>();
  const intents = new Map<string, CostSettlementIntentRow | null>();
  let identityHash: string | undefined;
  for (const requestId of [...ids].sort()) {
    const query = manager
      .createQueryBuilder()
      .select("s.*")
      .from("pricing_request_snapshots", "s")
      .where("s.request_id = :id AND s.workspace_id = :workspace", {
        id: requestId,
        workspace,
      });
    if (lock && postgres) query.setLock("pessimistic_write");
    const snapshot = await query.getRawOne<{ catalog_revision_id: string }>();
    if (!snapshot) missing();
    if (identityHash === undefined) identityHash = snapshot.catalog_revision_id;
    else if (identityHash !== snapshot.catalog_revision_id)
      conflict("Batch snapshots diverged");
  }
  let scopes: string | undefined;
  for (const member of [...batch.members].sort((a, b) =>
    a.reservation_id < b.reservation_id ? -1 : 1,
  )) {
    const query = manager
      .createQueryBuilder()
      .select("r.*")
      .from("pricing_reservations", "r")
      .where("r.id = :id AND r.workspace_id = :workspace", {
        id: member.reservation_id,
        workspace,
      });
    if (lock && postgres) query.setLock("pessimistic_write");
    const row = await query.getRawOne<CostReservationRow>();
    if (!row || row.request_id !== member.request_id) missing();
    const actual = row.budget_basis === "actual_upstream" ? await readActualBudgetCohort(manager, row.id, workspace) : null;
    const actualClosed = actual && actual.state !== "review_required" && !actualBudgetClosure(actual).missing_dispatch_evidence;
    if (
      row.state === "reserved" &&
      (row.job_id || (!actualClosed && (!options.allowUnsettled || parsePricingInstant(row.lease_until) > Date.now())))
    )
      conflict(
        "Settle every original batch member before correcting the physical cost",
      );
    const scope = pricingContentHash([
      decode(row.identity_json),
      decode(row.target_json),
    ]);
    if (scopes === undefined) scopes = scope;
    else if (scopes !== scope)
      conflict("Batch member tenant or target differs");
    reservations.set(row.id, row);
  }
  const query = manager
    .createQueryBuilder()
    .select("a.*")
    .from("pricing_attempts", "a")
    .where("a.workspace_id = :workspace AND a.request_id IN (:...ids)", {
      workspace,
      ids,
    })
    .andWhere(
      postgres
        ? "(a.price_context_json::jsonb #>> '{batch,physical_attempt_id}') = :physical"
        : "json_extract(a.price_context_json, '$.batch.physical_attempt_id') = :physical",
      { physical: batch.physical_attempt_id },
    )
    .orderBy("a.id", "ASC")
    .limit(batch.members.length + 1);
  if (lock && postgres) query.setLock("pessimistic_write");
  const rows = await query.getRawMany<CostAttemptRow>();
  if (rows.length !== batch.members.length)
    conflict("Physical batch membership is incomplete or duplicated");
  for (const member of [...batch.members].sort((a, b) =>
    a.reservation_id < b.reservation_id ? -1 : 1,
  )) {
    const query = manager
      .createQueryBuilder()
      .select("i.*")
      .from("pricing_settlement_intents", "i")
      .where("i.reservation_id = :id AND i.workspace_id = :workspace", {
        id: member.reservation_id,
        workspace,
      });
    if (lock && postgres) query.setLock("pessimistic_write");
    const intent = await query.getRawOne<CostSettlementIntentRow>();
    if (
      intent &&
      (intent.state !== "applied" ||
        reservations.get(member.reservation_id)?.state === "reserved" ||
        intent.payload_hash !== pricingContentHash(decode(intent.payload_json)))
    )
      conflict("Original member settlement is not applied or is corrupted");
    intents.set(member.reservation_id, intent ?? null);
  }
  const members: BatchAdjustmentMember[] = [];
  for (const [index, member] of batch.members.entries()) {
    const attempts = rows.filter(
      (row) =>
        row.request_id === member.request_id &&
        row.reservation_id === member.reservation_id,
    );
    if (attempts.length !== 1)
      conflict("Batch member attempt association is ambiguous");
    const attempt = attempts[0];
    if (
      attempt.state !== "terminal" ||
      !attempt.cost_json ||
      !attempt.cost_hash
    )
      conflict("A batch member outcome is not terminal");
    const initial = checked(decode<CostComputation>(attempt.cost_json));
    const dispatch = decode<AttemptPriceContext>(
      attempt.price_context_json,
    ).batch;
    if (
      pricingContentHash(initial) !== attempt.cost_hash ||
      !same(initial.batch!.members, batch.members) ||
      initial.batch!.member_index !== index ||
      initial.batch!.physical_cost_hash !== batch.physical_cost_hash ||
      initial.batch!.batch_id !== batch.batch_id ||
      initial.batch!.physical_attempt_id !== batch.physical_attempt_id ||
      !dispatch ||
      dispatch.member_index !== index ||
      dispatch.batch_id !== batch.batch_id ||
      !same(dispatch.request_ids, ids)
    )
      conflict("Batch receipt differs from its prepared physical membership");
    const history =
      (
        await loadCostAdjustments(manager, member.request_id, workspace, [
          attempt,
        ])
      ).get(attempt.id) ?? [];
    const current = checked(history.at(-1)?.cost ?? initial);
    if (
      !same(current.batch!.members, batch.members) ||
      current.batch!.batch_id !== batch.batch_id ||
      current.batch!.physical_attempt_id !== batch.physical_attempt_id ||
      current.batch!.member_index !== index
    )
      conflict("Corrected batch membership is invalid");
    members.push({
      attempt,
      reservation: reservations.get(member.reservation_id)!,
      intent: intents.get(member.reservation_id) ?? null,
      initial,
      current,
      hash: history.at(-1)?.cost_hash ?? attempt.cost_hash,
      history,
    });
  }
  const head = members[0].current.batch!;
  for (const member of members) {
    if (member.history.length !== members[0].history.length)
      conflict("Batch correction histories have different lengths");
    let previousPhysicalHash = batch.physical_cost_hash;
    for (const [index, view] of member.history.entries()) {
      const revision = view.cost.batch;
      const reference = members[0].history[index].cost.batch;
      if (
        !revision ||
        !reference ||
        revision.correction?.revision !== index + 1 ||
        revision.correction.previous_physical_cost_hash !==
          previousPhysicalHash ||
        !same(revision.correction, reference.correction) ||
        revision.physical_cost_hash !== reference.physical_cost_hash ||
        !same(revision.members, batch.members) ||
        revision.batch_id !== batch.batch_id ||
        revision.physical_attempt_id !== batch.physical_attempt_id
      )
        conflict("Batch physical revision chain is discontinuous");
      previousPhysicalHash = revision.physical_cost_hash;
    }
    const current = member.current.batch!;
    if (
      current.physical_cost_hash !== head.physical_cost_hash ||
      !same(current.correction ?? null, head.correction ?? null)
    )
      conflict("Physical batch correction is incomplete across members");
  }
  return {
    members,
    physical: head.physical_cost,
    physicalHash: head.physical_cost_hash,
    revision: head.correction?.revision ?? 0,
  };
}

export async function appendBatchCostAdjustment(
  manager: EntityManager,
  budgets: BudgetService,
  input: BatchCostAdjustmentInput,
  dryRun: boolean,
  options: BatchAdjustmentOptions = {},
): Promise<{ result: BatchCostAdjustmentResult; created: boolean }> {
  const group = await loadBatchAdjustmentGroup(
    manager,
    input.workspace,
    input.attemptId,
    true,
    options,
  );
  const original = group.members[0].initial.batch!;
  if (input.physicalCost.batch)
    conflict("Supply physical evidence, not another allocated share");
  const newPhysicalHash = pricingContentHash(input.physicalCost);
  const signature = pricingContentHash({
    id: input.id,
    workspace: input.workspace,
    physical: original.physical_attempt_id,
    expected: input.expectedPhysicalCostHash,
    next: newPhysicalHash,
    actor: input.actorId,
    source: input.source,
    reason: input.reason,
  });
  const auditId = `batch-correction:${pricingContentHash([input.workspace, input.id])}`;
  const prior = await manager
    .createQueryBuilder()
    .select("e.metadata_json", "metadata_json")
    .from("pricing_audit_events", "e")
    .where(
      "e.id = :id AND e.workspace_id = :workspace AND e.action = :action",
      {
        id: auditId,
        workspace: input.workspace,
        action: "cost.batch_adjustment",
      },
    )
    .getRawOne<{ metadata_json: string }>();
  const changeId = (id: string) =>
    `batch-${pricingContentHash([input.workspace, input.id, id])}`;
  if (prior) {
    const metadata = decode<{
      signature: string;
      revision: number;
      adjustment_ids: string[];
    }>(prior.metadata_json);
    if (
      metadata.signature !== signature ||
      !same(
        metadata.adjustment_ids,
        group.members.map((member) => changeId(member.attempt.id)),
      )
    )
      conflict("Batch correction identity was reused with different evidence");
    const changes = group.members.map((member) => {
      const index = member.history.findIndex(
        (view) => view.id === changeId(member.attempt.id),
      );
      if (index < 0)
        return conflict(
          "An idempotent group correction is missing a member revision",
        );
      const view = member.history[index];
      if (
        view.cost.batch?.correction?.id !== input.id ||
        view.cost.batch.correction.revision !== metadata.revision ||
        view.cost.batch.correction.previous_physical_cost_hash !==
          input.expectedPhysicalCostHash ||
        view.cost.batch?.physical_cost_hash !== newPhysicalHash
      )
        conflict("Stored group correction evidence is inconsistent");
      return {
        request_id: member.attempt.request_id,
        attempt_id: member.attempt.id,
        previous_cost_hash: view.previous_hash,
        previous_cost: index ? member.history[index - 1].cost : member.initial,
        cost: view.cost,
        adjustment: view,
      };
    });
    return {
      created: false,
      result: {
        id: input.id,
        batch_id: original.batch_id,
        physical_attempt_id: original.physical_attempt_id,
        revision: metadata.revision,
        previous_physical_cost_hash: input.expectedPhysicalCostHash,
        physical_cost_hash: newPhysicalHash,
        dry_run: dryRun,
        replayed: true,
        changes,
      },
    };
  }
  if (input.expectedPhysicalCostHash !== group.physicalHash)
    conflict("Correction must compare against the latest physical batch hash");
  if (newPhysicalHash === group.physicalHash)
    conflict("Physical correction must supply changed evidence");
  const initialPhysical = original.physical_cost;
  if (
    initialPhysical.version_id !== null &&
    !same(
      [
        input.physicalCost.book_id,
        input.physicalCost.version_id,
        input.physicalCost.content_hash,
        input.physicalCost.currency,
        input.physicalCost.fx_version_id,
      ],
      [
        initialPhysical.book_id,
        initialPhysical.version_id,
        initialPhysical.content_hash,
        initialPhysical.currency,
        initialPhysical.fx_version_id,
      ],
    )
  )
    conflict("Correction cannot change the frozen batch price or FX");
  const immutableAttribution = (cost: CostComputation) => {
    if (!options.allowResponseModelUpdate) return cost.attribution ?? null;
    const { response_model: _reported, ...immutable } = cost.attribution ?? {};
    return immutable;
  };
  if (
    !same(
      immutableAttribution(input.physicalCost),
      immutableAttribution(group.physical),
    )
  )
    conflict("Correction cannot rewrite physical dispatch attribution");
  const allocation = allocateBatchCost(
    original.batch_id,
    input.physicalCost,
    original.members,
  );
  const revision = group.revision + 1;
  const changes: BatchCostAdjustmentResult["changes"] = [];
  const budgetPreview =
    options.budgetPreview ??
    (dryRun && options.previewBudget ? new Map<string, string>() : undefined);
  for (const [index, member] of group.members.entries()) {
    const cost = batchShareCost(
      allocation,
      index,
      original.physical_attempt_id,
    );
    if (member.initial.attribution) {
      const { response_model: _reported, ...immutable } =
        member.initial.attribution;
      cost.attribution = options.allowResponseModelUpdate
        ? {
            ...immutable,
            ...(input.physicalCost.attribution?.response_model === undefined
              ? {}
              : {
                  response_model: input.physicalCost.attribution.response_model,
                }),
          }
        : member.current.attribution;
    }
    cost.batch!.correction = {
      id: input.id,
      revision,
      previous_physical_cost_hash: group.physicalHash,
    };
    validateBatchShare(cost);
    const adjustmentInput: CostAdjustmentInput = {
      id: changeId(member.attempt.id),
      workspace: input.workspace,
      attemptId: member.attempt.id,
      expectedCostHash: member.hash,
      cost,
      reason: input.reason,
      actorId: input.actorId,
      source: input.source,
    };
    let view: CostAdjustmentView | null = null;
    if (!dryRun || options.previewBudget) {
      const reused = await manager
        .createQueryBuilder()
        .select("a.attempt_id", "attempt_id")
        .from("pricing_cost_adjustments", "a")
        .where("a.id = :id", { id: adjustmentInput.id })
        .getRawOne<{ attempt_id: string }>();
      if (reused)
        conflict(
          "A batch member correction identity already exists without its group audit",
        );
      view = (
        await appendCostAdjustment(
          manager,
          budgets,
          adjustmentInput,
          member.attempt,
          member.reservation,
          member.intent,
          { dryRun, allowUnsettled: options.allowUnsettled, budgetPreview },
        )
      ).view;
    }
    changes.push({
      request_id: member.attempt.request_id,
      attempt_id: member.attempt.id,
      previous_cost_hash: member.hash,
      previous_cost: member.current,
      cost,
      adjustment: view,
    });
  }
  if (!dryRun)
    await manager
      .createQueryBuilder()
      .insert()
      .into("pricing_audit_events")
      .values({
        id: auditId,
        workspace_id: input.workspace,
        book_id: null,
        actor_id: input.actorId,
        action: "cost.batch_adjustment",
        reason: input.reason,
        created_at: new Date().toISOString(),
        metadata_json: JSON.stringify({
          signature,
          adjustment_id: input.id,
          physical_attempt_id: original.physical_attempt_id,
          batch_id: original.batch_id,
          previous_hash: group.physicalHash,
          physical_cost_hash: newPhysicalHash,
          revision,
          adjustment_ids: changes.map((change) => change.adjustment!.id),
          source: input.source,
        }),
      })
      .execute();
  return {
    created: !dryRun,
    result: {
      id: input.id,
      batch_id: original.batch_id,
      physical_attempt_id: original.physical_attempt_id,
      revision,
      previous_physical_cost_hash: group.physicalHash,
      physical_cost_hash: newPhysicalHash,
      dry_run: dryRun,
      replayed: false,
      changes,
    },
  };
}

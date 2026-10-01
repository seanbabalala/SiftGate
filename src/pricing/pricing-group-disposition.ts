import { In, type EntityManager } from "typeorm";
import { workspaceFindWhere } from "../workspaces/workspace-scope";
import type { BudgetService } from "../budget/budget.service";
import { BudgetRule } from "../database/entities/budget-rule.entity";
import { readRuntimeGroupOutcome } from "./pricing-group-outcome-inbox";
import { groupOutcomeReceipts } from "./pricing-group-outcome-document";
import { runtimeOutcomeDocument } from "./pricing-outcome-document";
import { pricingContentHash } from "./pricing-json";
import { recoveryConflict, recoveryDecode } from "./pricing-recovery-basis";
import { parsePricingInstant } from "./pricing-time";
import { loadCostAdjustments, appendCostAdjustment } from "./cost-adjustments";
import {
  appendBatchCostAdjustment,
  loadBatchAdjustmentGroup,
} from "./batch-cost-adjustments";
import { validateBatchShare } from "./cost-allocation";
import { redactErrorText } from "../security/error-redaction";
import {
  PricingRepositoryError,
  type PricingActor,
} from "./pricing-repository.types";
import {
  GROUP_DISPOSITION_TABLE,
  GROUP_DISPOSITION_ACTION,
  groupDispositionAuditId,
  groupDispositionMetadata,
  groupDispositionSignature,
  readGroupDispositionRow,
  verifyGroupDispositionRecord,
} from "./pricing-group-disposition-record";
import type {
  AttemptPriceContext,
  CostAttemptRow,
  CostReservationRow,
  CostSettlementIntentRow,
} from "./cost-ledger.types";
import type { CostComputation } from "./pricing.types";
import type { CostAdjustmentView } from "./cost-adjustment.types";
import type { GroupOutcomeRow } from "./pricing-group-outcome.types";
import type {
  GroupDispositionAcceptanceBlocked,
  GroupDispositionBasis,
  GroupDispositionInput,
  GroupDispositionResult,
  GroupDispositionRow,
} from "./pricing-group-disposition.types";

const MAX_RECEIPTS = 1024;
const adjustmentId = (workspace: string, id: string, attempt: string) =>
  `group-member:${pricingContentHash([workspace, id, attempt])}`;
const batchId = (workspace: string, id: string, physical: string) =>
  `group-review:${pricingContentHash([workspace, id, physical])}`;
const missing = (): never => {
  throw new PricingRepositoryError(
    "pricing_not_found",
    "Retained group evidence is not available in this workspace",
    404,
  );
};
interface Entry {
  row: CostAttemptRow;
  pricing: AttemptPriceContext;
  reservation: CostReservationRow;
  intent: CostSettlementIntentRow | null;
  retained: CostComputation;
  retainedError: string | null;
  original: CostComputation | null;
  current: CostComputation | null;
  history: CostAdjustmentView[];
}
interface Cohort {
  id: string;
  entries: Entry[];
  complete: boolean;
  retained: CostComputation;
  original: CostComputation | null;
  current: CostComputation | null;
  anchor: CostAttemptRow;
  pricing: AttemptPriceContext;
  reservation: CostReservationRow;
  mode: "initial" | "fill" | "unchanged" | "adjust" | "blocked";
  evidenceHash: string;
}
export interface LockedGroupDisposition {
  outcome: GroupOutcomeRow;
  entries: Entry[];
  cohorts: Cohort[];
  view: GroupDispositionBasis;
}

function validateCost(cost: CostComputation, workspace: string) {
  runtimeOutcomeDocument({
    type: "attempt",
    workspace,
    reservationId: "review",
    attemptId: "review",
    cost,
    errorCode: null,
  });
}
/** Lock the whole retained roster first; a paged UI never narrows this decision scope. */
export async function loadGroupDisposition(
  manager: EntityManager,
  id: string,
  workspace: string,
): Promise<LockedGroupDisposition> {
  const retained = await readRuntimeGroupOutcome(manager, id, workspace),
    postgres = manager.connection.options.type === "postgres";
  const holdIds = retained.members
    .map((member) => member.reservation_id)
    .sort();
  const holdQuery = manager
    .createQueryBuilder()
    .select("r.*")
    .from("pricing_reservations", "r")
    .where("r.workspace_id = :workspace AND r.id IN (:...ids)", {
      workspace,
      ids: holdIds,
    })
    .orderBy("r.id", "ASC");
  if (postgres) holdQuery.setLock("pessimistic_write");
  const holds = await holdQuery.getRawMany<CostReservationRow>(),
    byHold = new Map(holds.map((row) => [row.id, row]));
  if (holds.length !== holdIds.length) missing();
  for (const row of holds)
    if (
      recoveryDecode<{ workspaceId: string }>(row.identity_json).workspaceId !==
      workspace
    )
      recoveryConflict("Group reservation scope differs");
  const snapshots = [];
  for (const requestId of [
    ...new Set(retained.members.map((member) => member.request_id)),
  ].sort()) {
    const snapshot = await manager
      .createQueryBuilder()
      .select("s.*")
      .from("pricing_request_snapshots", "s")
      .where("s.request_id = :id AND s.workspace_id = :workspace", {
        id: requestId,
        workspace,
      })
      .getRawOne<{
        request_id: string;
        descriptor_json: string;
        snapshot_hash: string;
        catalog_revision_id: string;
      }>();
    if (!snapshot) missing();
    const { snapshot_id, ...descriptor } = recoveryDecode<
      Record<string, unknown>
    >(snapshot!.descriptor_json);
    if (
      snapshot_id !== snapshot!.snapshot_hash ||
      pricingContentHash(descriptor) !== snapshot!.snapshot_hash ||
      descriptor.workspace_id !== workspace ||
      descriptor.catalog_revision_id !== snapshot!.catalog_revision_id
    )
      recoveryConflict("Pinned group price snapshot differs");
    snapshots.push(snapshot!);
  }
  const bySnapshot = new Map(
    snapshots.map((snapshot) => [snapshot.request_id, snapshot]),
  );
  const raw = groupOutcomeReceipts(retained.document.outcome),
    unique = new Map<string, (typeof raw)[number]>();
  let acceptance: GroupDispositionAcceptanceBlocked = null;
  for (const receipt of raw) {
    const before = unique.get(receipt.attemptId);
    if (
      before &&
      (pricingContentHash(before.cost) !== pricingContentHash(receipt.cost) ||
        before.errorCode !== receipt.errorCode)
    )
      acceptance = "ambiguous_receipts";
    else unique.set(receipt.attemptId, receipt);
  }
  if (unique.size > MAX_RECEIPTS)
    recoveryConflict("Complete group review exceeds the1024 receipt bound");
  if (!unique.size) acceptance = "no_receipts";
  const ids = [...unique.keys()].sort();
  const allQuery = manager
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
      ].map((column) => `a.${column} AS ${column}`),
    )
    .from("pricing_attempts", "a")
    .where("a.workspace_id = :workspace AND a.reservation_id IN (:...ids)", {
      workspace,
      ids: holdIds,
    })
    .orderBy("a.id", "ASC")
    .limit(8193);
  if (postgres) allQuery.setLock("pessimistic_write");
  const allAttempts =
    await allQuery.getRawMany<
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
  if (allAttempts.length > 8192)
    recoveryConflict("Group attempt history exceeds bounded review");
  const intentsQuery = manager
    .createQueryBuilder()
    .select("i.*")
    .from("pricing_settlement_intents", "i")
    .where("i.workspace_id = :workspace AND i.reservation_id IN (:...ids)", {
      workspace,
      ids: holdIds,
    })
    .orderBy("i.reservation_id", "ASC");
  if (postgres) intentsQuery.setLock("pessimistic_write");
  const intents = await intentsQuery.getRawMany<CostSettlementIntentRow>(),
    byIntent = new Map(intents.map((row) => [row.reservation_id, row]));
  for (const intent of intents)
    if (
      byHold.get(intent.reservation_id)?.request_id !== intent.request_id ||
      pricingContentHash(recoveryDecode(intent.payload_json)) !==
        intent.payload_hash
    )
      recoveryConflict("Group terminal intent integrity differs");
  const rows = ids.length
    ? await manager
        .createQueryBuilder()
        .select("a.*")
        .from("pricing_attempts", "a")
        .where("a.workspace_id = :workspace AND a.id IN (:...ids)", {
          workspace,
          ids,
        })
        .getRawMany<CostAttemptRow>()
    : [];
  if (rows.length !== ids.length) missing();
  const entries: Entry[] = [];
  for (const row of rows.sort((a, b) => a.id.localeCompare(b.id))) {
    const incoming = unique.get(row.id)!,
      reservation = byHold.get(incoming.reservationId);
    if (
      !reservation ||
      row.request_id !== reservation.request_id ||
      row.reservation_id !== reservation.id
    )
      missing();
    const original = row.cost_json
      ? recoveryDecode<CostComputation>(row.cost_json)
      : null;
    if (original) {
      if (
        row.state !== "terminal" ||
        pricingContentHash(original) !== row.cost_hash
      )
        recoveryConflict("Original group receipt hash differs");
      validateCost(original, workspace);
    } else if (row.state !== "dispatched" || row.cost_hash !== null)
      acceptance = "inconsistent_group_history";
    const count = await manager
      .createQueryBuilder()
      .select("a.id", "id")
      .from("pricing_cost_adjustments", "a")
      .where("a.attempt_id = :id AND a.workspace_id = :workspace", {
        id: row.id,
        workspace,
      })
      .limit(257)
      .getRawMany();
    if (count.length > 256)
      recoveryConflict("Group revision history exceeds bounded review");
    const history =
      (
        await loadCostAdjustments(manager, row.request_id, workspace, [row])
      ).get(row.id) ?? [];
    const current = history.at(-1)?.cost ?? original;
    if (current) validateCost(current, workspace);
    entries.push({
      row,
      pricing: recoveryDecode<AttemptPriceContext>(row.price_context_json),
      reservation: reservation!,
      intent: byIntent.get(reservation!.id) ?? null,
      retained: incoming.cost,
      retainedError: incoming.errorCode,
      original,
      current,
      history,
    });
    if (
      incoming.cost.allocation_failure ||
      incoming.cost.batch?.physical_cost.allocation_failure
    )
      acceptance = "allocation_failure";
  }
  const physical = new Map<string, Entry[]>();
  for (const entry of entries) {
    const batch = entry.retained.batch;
    if (batch) {
      const group = physical.get(batch.physical_attempt_id) ?? [];
      group.push(entry);
      physical.set(batch.physical_attempt_id, group);
    } else if (entry.pricing.batch || entry.original?.batch)
      acceptance = "inconsistent_group_history";
  }
  const cohorts: Cohort[] = [];
  for (const [physicalId, represented] of physical) {
    const first = represented[0].retained.batch!,
      members = first.members,
      hash = pricingContentHash(members);
    if (
      represented.some(
        (entry) =>
          entry.retained.batch!.batch_id !== first.batch_id ||
          entry.retained.batch!.physical_cost_hash !==
            first.physical_cost_hash ||
          pricingContentHash(entry.retained.batch!.members) !== hash,
      )
    )
      acceptance = "ambiguous_receipts";
    const complete =
      represented.length === members.length &&
      new Set(represented.map((entry) => entry.retained.batch!.member_index))
        .size === members.length;
    const preparedRows = await manager
      .createQueryBuilder()
      .select("a.*")
      .from("pricing_attempts", "a")
      .where("a.workspace_id = :workspace AND a.reservation_id IN (:...ids)", {
        workspace,
        ids: members.map((member) => member.reservation_id),
      })
      .andWhere(
        postgres
          ? "(a.price_context_json::jsonb #>> '{batch,physical_attempt_id}') = :physical"
          : "json_extract(a.price_context_json,'$.batch.physical_attempt_id') = :physical",
        { physical: physicalId },
      )
      .orderBy("a.id", "ASC")
      .limit(members.length + 1)
      .getRawMany<CostAttemptRow>();
    const manifest = await manager
      .createQueryBuilder()
      .select("m.*")
      .from("pricing_batch_manifests", "m")
      .where(
        "m.workspace_id = :workspace AND m.physical_attempt_id = :physical",
        { workspace, physical: physicalId },
      )
      .getRawOne<{ manifest_hash: string; manifest_json: string }>();
    const expectedManifest = {
      workspace_id: workspace,
      batch_id: first.batch_id,
      physical_attempt_id: physicalId,
      members,
    };
    const manifestHash = pricingContentHash(expectedManifest);
    if (
      !manifest ||
      manifest.manifest_hash !== manifestHash ||
      pricingContentHash(recoveryDecode(manifest.manifest_json)) !==
        manifestHash ||
      preparedRows.length !== members.length
    )
      acceptance = "manifest_missing";
    const anchor =
      preparedRows.find(
        (row) => row.reservation_id === members[0].reservation_id,
      ) ?? represented[0].row;
    const pricing = recoveryDecode<AttemptPriceContext>(
      anchor.price_context_json,
    );
    let authority: string | undefined;
    for (const [index, member] of members.entries()) {
      const row = preparedRows.find(
          (row) => row.reservation_id === member.reservation_id,
        ),
        context = row
          ? recoveryDecode<AttemptPriceContext>(row.price_context_json)
          : null;
      if (
        !row ||
        row.request_id !== member.request_id ||
        context?.batch?.member_index !== index ||
        context.batch.manifest_hash !== manifestHash ||
        context.batch.batch_id !== first.batch_id ||
        pricingContentHash(context.batch.request_ids) !==
          pricingContentHash(members.map((value) => value.request_id)) ||
        pricingContentHash(context.context) !==
          pricingContentHash(pricing.context) ||
        pricingContentHash(context.legacyPrice) !==
          pricingContentHash(pricing.legacyPrice)
      )
        acceptance = "manifest_missing";
      const hold = byHold.get(member.reservation_id),
        snapshot = bySnapshot.get(member.request_id);
      if (!hold || !snapshot || !row) {
        acceptance = "inconsistent_group_history";
        continue;
      }
      const estimate = recoveryDecode<CostComputation>(hold.estimate_json);
      const target = recoveryDecode<{ node_id?: string; model: string }>(
        hold.target_json,
      );
      // Repeat dispatch-time authority checks for every prepared member. An
      // anchor's valid quote cannot authorize a different tenant, tariff or FX.
      const signature = pricingContentHash({
        identity: recoveryDecode(hold.identity_json),
        target,
        catalog: snapshot.catalog_revision_id,
        price: [
          estimate.book_id,
          estimate.version_id,
          estimate.content_hash,
          estimate.fx_version_id,
        ],
        policy: estimate.admission?.policy_hash ?? null,
      });
      if (
        (authority !== undefined && authority !== signature) ||
        hold.request_id !== member.request_id ||
        row.node_id !== (target.node_id ?? "") ||
        row.model !== target.model ||
        row.node_id !== anchor.node_id ||
        row.model !== anchor.model ||
        row.fee_source !== "provider" ||
        row.dispatched_at !== anchor.dispatched_at
      )
        acceptance = "inconsistent_group_history";
      authority = signature;
    }
    const reservation = byHold.get(anchor.reservation_id!);
    if (!reservation) missing();
    let original: CostComputation | null = null,
      current: CostComputation | null = null,
      mode: Cohort["mode"] = "blocked";
    const allMissing = represented.every((entry) => !entry.original),
      someMissing = represented.some((entry) => !entry.original);
    if (complete && allMissing) {
      mode = "initial";
      if (represented.some((entry) => entry.retained.batch?.correction))
        acceptance = "inconsistent_group_history";
    } else if (complete && someMissing) {
      const known = represented.filter((entry) => entry.original);
      const compatible = known.every(
        (entry) =>
          !entry.history.length &&
          entry.original?.batch?.physical_cost_hash ===
            first.physical_cost_hash &&
          pricingContentHash(entry.original) ===
            pricingContentHash(entry.retained),
      );
      if (compatible) {
        mode = "fill";
        original = known[0].original!.batch!.physical_cost;
        current = original;
      } else acceptance = "inconsistent_group_history";
    } else {
      try {
        const group = await loadBatchAdjustmentGroup(
          manager,
          workspace,
          anchor.id,
          true,
          { allowUnsettled: true },
        );
        original = group.members[0].initial.batch!.physical_cost;
        current = group.physical;
        validateCost(original, workspace);
        validateCost(current, workspace);
        if (!complete) {
          if (
            represented.every(
              (entry) =>
                entry.current &&
                pricingContentHash(entry.current) ===
                  pricingContentHash(entry.retained),
            )
          )
            mode = "unchanged";
          else acceptance = "incomplete_historical_group";
        } else
          mode =
            group.physicalHash === first.physical_cost_hash
              ? "unchanged"
              : "adjust";
      } catch (error) {
        if (
          error instanceof PricingRepositoryError &&
          [404, 409].includes(error.status)
        )
          acceptance = complete
            ? "inconsistent_group_history"
            : "incomplete_historical_group";
        else throw error;
      }
    }
    for (const entry of represented) {
      validateBatchShare(entry.retained);
      const batch = entry.retained.batch!;
      const member = members[batch.member_index];
      if (
        !member ||
        entry.row.request_id !== member.request_id ||
        entry.row.reservation_id !== member.reservation_id
      )
        recoveryConflict("Retained group share belongs to another member");
      const { response_model: _old, ...expected } =
        entry.pricing.dispatch ?? entry.original?.attribution ?? {};
      const { response_model: reported, ...actual } =
        entry.retained.attribution ?? {};
      if (
        pricingContentHash(expected) !== pricingContentHash(actual) ||
        (reported ?? null) !==
          (first.physical_cost.attribution?.response_model ?? null)
      )
        acceptance = "manifest_missing";
    }
    cohorts.push({
      id: physicalId,
      entries: represented,
      complete,
      retained: first.physical_cost,
      original,
      current,
      anchor,
      pricing,
      reservation: reservation!,
      mode,
      evidenceHash: pricingContentHash(preparedRows),
    });
  }
  const media = await manager
    .createQueryBuilder()
    .select([
      "t.id AS id",
      "t.reservation_id AS reservation_id",
      "t.state AS state",
    ])
    .from("pricing_media_tasks", "t")
    .where("t.workspace_id = :workspace AND t.reservation_id IN (:...ids)", {
      workspace,
      ids: holdIds,
    })
    .orderBy("t.id", "ASC")
    .limit(4097)
    .getRawMany<{ id: string; reservation_id: string; state: string }>();
  if (media.length > 4096)
    recoveryConflict("Group task ownership exceeds bounded review");
  const effects = await manager
    .createQueryBuilder()
    .select("e.*")
    .from("pricing_budget_effects", "e")
    .where(
      "e.workspace_id = :workspace AND e.reservation_id IN (:...ids) AND e.kind = :kind",
      { workspace, ids: holdIds, kind: "commit" },
    )
    .getRawMany<{ allocations_json: string }>();
  const ruleIds = [
    ...new Set(
      effects.flatMap((effect) =>
        recoveryDecode<Array<{ ruleId: number }>>(effect.allocations_json).map(
          (value) => value.ruleId,
        ),
      ),
    ),
  ];
  const epochQuery = manager
    .getRepository(BudgetRule)
    .createQueryBuilder("b")
    .select(
      ["id", "workspace_id", "type", "period_start", "is_active"].map(
        (column) => `b.${column} AS ${column}`,
      ),
    )
    .where(workspaceFindWhere(workspace, { id: In(ruleIds) }))
    .orderBy("b.id", "ASC");
  if (postgres) epochQuery.setLock("pessimistic_write");
  const epochRows = ruleIds.length
    ? await epochQuery.getRawMany<{
        id: number;
        workspace_id: string | null;
        type: string;
        period_start: Date | string;
        is_active: boolean | number;
      }>()
    : [];
  // PostgreSQL raw timestamps are Date objects. Canonical pricing documents
  // intentionally use strings, otherwise a Date hashes as an empty object.
  const epochs = epochRows.map((row) => ({
    ...row,
    period_start: new Date(row.period_start).toISOString(),
  }));
  const related = await manager
    .createQueryBuilder()
    .select([
      "o.id AS id",
      "o.state AS state",
      "o.document_hash AS document_hash",
      "d.action AS disposition",
      "d.result_hash AS disposition_hash",
    ])
    .distinct(true)
    .from("pricing_runtime_group_outcomes", "o")
    .innerJoin(
      "pricing_runtime_group_outcome_members",
      "m",
      "m.outcome_id = o.id AND m.workspace_id = o.workspace_id",
    )
    .leftJoin(
      GROUP_DISPOSITION_TABLE,
      "d",
      "d.outcome_id = o.id AND d.workspace_id = o.workspace_id",
    )
    .where("o.workspace_id = :workspace AND m.reservation_id IN (:...ids)", {
      workspace,
      ids: holdIds,
    })
    .orderBy("o.id", "ASC")
    .limit(4097)
    .getRawMany<
      GroupDispositionBasis["related_outcomes"][number] & {
        disposition_hash: string | null;
      }
    >();
  if (related.length > 4096)
    recoveryConflict("Related group variants exceed bounded review");
  const disposition = await readGroupDispositionRow(manager, id, workspace);
  if (disposition) await verifyGroupDispositionRecord(manager, disposition);
  const blocked: GroupDispositionBasis["blocked_reason"] = disposition
    ? "already_disposed"
    : retained.row.state !== "review_required"
      ? "not_review_required"
      : holds.some((row) => parsePricingInstant(row.lease_until) > Date.now())
        ? "lease_active"
        : intents.some(
              (intent) =>
                intent.state !== "applied" ||
                byHold.get(intent.reservation_id)?.state === "reserved",
            )
          ? "pending_intent"
          : holds.some((row) => row.job_id) ||
              media.some((row) => row.state !== "synchronous")
            ? "async_owned"
            : entries.some((entry) => entry.row.fee_source !== "provider")
              ? "not_provider"
              : null;
  const basisHash = pricingContentHash({
    outcome: retained.row,
    snapshots,
    holds,
    intents,
    allAttempts,
    entries: entries.map((entry) => ({
      id: entry.row.id,
      original: entry.row.cost_hash,
      pricing: entry.pricing,
      history: entry.history.map((view) => view.application.application_hash),
    })),
    cohorts: cohorts.map((group) => group.evidenceHash),
    effects,
    epochs,
    media,
    related,
    disposition,
  });
  const view: GroupDispositionBasis = {
    outcome_id: id,
    outcome_hash: retained.row.document_hash,
    basis_hash: basisHash,
    source: "gateway_runtime",
    supplier_confirmed: false,
    budget_decision_unchanged: true,
    blocked_reason: blocked,
    acceptance_blocked_reason: acceptance,
    disposition: disposition
      ? {
          id: disposition.operation_id,
          action: disposition.action,
          actor_id: disposition.actor_id,
          result_hash: disposition.result_hash,
        }
      : null,
    related_outcomes: related.map(({ disposition_hash: _hash, ...row }) => row),
    groups: cohorts.map((group) => ({
      physical_attempt_id: group.id,
      batch_id: group.entries[0].retained.batch!.batch_id,
      complete: group.complete,
      represented_attempt_ids: group.entries.map((entry) => entry.row.id),
      retained_physical_hash: pricingContentHash(group.retained),
      original_physical: group.original,
      current_physical: group.current,
      retained_physical: group.retained,
    })),
    receipts: entries.map((entry) => ({
      attempt_id: entry.row.id,
      request_id: entry.row.request_id,
      reservation_id: entry.reservation.id,
      physical_attempt_id: entry.retained.batch?.physical_attempt_id ?? null,
      original: entry.original,
      current: entry.current,
      retained: entry.retained,
      retained_hash: pricingContentHash(entry.retained),
      current_hash: entry.current ? pricingContentHash(entry.current) : null,
      recorded_error: entry.row.error_code,
      retained_error: entry.retainedError,
    })),
  };
  return { outcome: retained.row, entries, cohorts, view };
}

const noBudget = (): GroupDispositionResult["changes"][number]["budget"] => ({
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
function budgetView(view: CostAdjustmentView | null) {
  if (!view) return noBudget();
  const a = view.application;
  return {
    budget_state: a.budget_state,
    budget_cost_before: a.budget_cost_before,
    budget_cost_after: a.budget_cost_after,
    budget_tokens_before: a.budget_tokens_before,
    budget_tokens_after: a.budget_tokens_after,
    cost_delta: a.cost_delta,
    tokens_delta: a.tokens_delta,
    allocations: a.allocations,
    current_period_refund_not_guaranteed: true as const,
  };
}
export async function applyGroupDisposition(
  manager: EntityManager,
  budgets: BudgetService,
  actor: PricingActor,
  input: GroupDispositionInput,
  basis: LockedGroupDisposition,
  verified: Record<string, string>,
  dryRun: boolean,
): Promise<GroupDispositionResult> {
  if (
    basis.view.blocked_reason ||
    basis.view.basis_hash !== input.expected_basis_hash ||
    basis.view.outcome_hash !== input.expected_outcome_hash
  )
    recoveryConflict(
      "Group review is stale or owned; reread the complete basis",
    );
  if (
    input.action === "accept_receipts" &&
    (basis.view.acceptance_blocked_reason ||
      !basis.entries.length ||
      Object.keys(verified).length !== basis.entries.length ||
      basis.entries.some(
        (entry) =>
          verified[entry.row.id] !== pricingContentHash(entry.retained),
      ))
  )
    recoveryConflict(
      "Accept only the complete verified receipt set; unresolved historical groups need full evidence",
    );
  const result: GroupDispositionResult = {
    id: input.id,
    outcome_id: basis.outcome.id,
    outcome_hash: basis.outcome.document_hash,
    basis_hash: basis.view.basis_hash,
    action: input.action,
    dry_run: dryRun,
    replayed: false,
    supplier_confirmed: false,
    outcome_document_modified: false,
    original_receipts_modified: false,
    budget_decision_unchanged: true,
    changes: [],
  };
  const selected = new Map<
    string,
    { cost: CostComputation; adjustment: CostAdjustmentView | null }
  >();
  const reason = redactErrorText(input.reason, { maxLength: 1000 });
  // Every cohort and independent receipt shares the same simulated epochs.
  const budgetPreview = dryRun ? new Map<string, string>() : undefined;
  if (input.action === "accept_receipts") {
    for (const group of basis.cohorts) {
      if (group.mode === "blocked")
        recoveryConflict("Physical group history cannot be safely adopted");
      if (group.mode !== "adjust") continue;
      const correction = await appendBatchCostAdjustment(
        manager,
        budgets,
        {
          id: batchId(actor.workspace_id, input.id, group.id),
          attemptId: group.anchor.id,
          workspace: actor.workspace_id,
          expectedPhysicalCostHash: pricingContentHash(group.current!),
          physicalCost: group.retained,
          reason,
          actorId: actor.id,
          source: "reconciliation",
        },
        dryRun,
        {
          allowUnsettled: true,
          allowResponseModelUpdate: true,
          previewBudget: true,
          budgetPreview,
        },
      );
      if (correction.result.changes.length !== group.entries.length)
        recoveryConflict(
          "Conserved group correction returned incomplete membership",
        );
      for (const change of correction.result.changes)
        selected.set(change.attempt_id, {
          cost: change.cost,
          adjustment: change.adjustment,
        });
    }
    for (const entry of basis.entries) {
      let operation: GroupDispositionResult["changes"][number]["operation"] =
          "already_recorded",
        cost = entry.current ?? entry.retained,
        adjustment: CostAdjustmentView | null = null;
      const physicalId = entry.retained.batch?.physical_attempt_id ?? null;
      if (!entry.original) {
        operation = "initial_receipt";
        cost = entry.retained;
        if (!dryRun) {
          const changed = await manager
            .createQueryBuilder()
            .update("pricing_attempts")
            .set({
              state: "terminal",
              cost_json: JSON.stringify(cost),
              cost_hash: pricingContentHash(cost),
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
          if (changed.affected !== 1)
            recoveryConflict("A missing group receipt changed before adoption");
        }
      } else if (selected.has(entry.row.id)) {
        operation = "linked_correction";
        ({ cost, adjustment } = selected.get(entry.row.id)!);
      } else if (
        !physicalId &&
        pricingContentHash(entry.current) !== pricingContentHash(entry.retained)
      ) {
        operation = "linked_correction";
        cost = entry.retained;
        adjustment = (
          await appendCostAdjustment(
            manager,
            budgets,
            {
              id: adjustmentId(actor.workspace_id, input.id, entry.row.id),
              workspace: actor.workspace_id,
              attemptId: entry.row.id,
              expectedCostHash: pricingContentHash(entry.current!),
              cost,
              reason,
              actorId: actor.id,
              source: "reconciliation",
            },
            entry.row,
            entry.reservation,
            entry.intent,
            { dryRun, allowUnsettled: true, budgetPreview },
          )
        ).view;
      }
      result.changes.push({
        attempt_id: entry.row.id,
        request_id: entry.row.request_id,
        reservation_id: entry.reservation.id,
        physical_attempt_id: physicalId,
        operation,
        previous_cost: entry.current,
        previous_cost_hash: entry.current
          ? pricingContentHash(entry.current)
          : null,
        retained_hash: pricingContentHash(entry.retained),
        cost,
        cost_hash: pricingContentHash(cost),
        retained_error: entry.retainedError,
        recorded_error:
          operation === "initial_receipt"
            ? entry.retainedError
            : entry.row.error_code,
        original_error_preserved: operation !== "initial_receipt",
        adjustment,
        budget: budgetView(adjustment),
      });
    }
  }
  result.changes.sort((a, b) => a.attempt_id.localeCompare(b.attempt_id));
  const json = JSON.stringify(result);
  if (Buffer.byteLength(json) > 32 * 1024 * 1024)
    recoveryConflict("Group disposition result exceeds bounded review");
  if (!dryRun) {
    const row: GroupDispositionRow = {
      outcome_id: basis.outcome.id,
      workspace_id: actor.workspace_id,
      operation_id: input.id,
      actor_id: actor.id,
      action: input.action,
      outcome_hash: basis.outcome.document_hash,
      proposal_hash: groupDispositionSignature(
        actor.workspace_id,
        actor.id,
        basis.outcome.id,
        input,
      ),
      result_hash: pricingContentHash(result),
      audit_id: groupDispositionAuditId(actor.workspace_id, input.id),
      created_at: new Date().toISOString(),
      result_json: json,
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
        action: GROUP_DISPOSITION_ACTION,
        reason,
        metadata_json: JSON.stringify(groupDispositionMetadata(row)),
        created_at: row.created_at,
      })
      .execute();
    await manager
      .createQueryBuilder()
      .insert()
      .into(GROUP_DISPOSITION_TABLE, Object.keys(row))
      .values(row)
      .execute();
  }
  return result;
}

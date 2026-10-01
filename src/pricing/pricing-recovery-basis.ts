import type { EntityManager } from "typeorm";
import type {
  AttemptPriceContext,
  CostAttemptRow,
  CostReservationRow,
  CostSettlementIntentRow,
} from "./cost-ledger.types";
import type {
  LockedRecoveryBasis,
  RecoveryBasis,
} from "./pricing-resolution.types";
import type { PricingRecoveryCaseRow } from "./pricing-orphan.types";
import type { MediaTaskRow } from "./media-task.types";
import type { CostComputation } from "./pricing.types";
import { loadCostAdjustments } from "./cost-adjustments";
import { validateBatchShare } from "./cost-allocation";
import { pricingContentHash } from "./pricing-json";
import { PricingRepositoryError } from "./pricing-repository.types";
import { readActualRecoveryBasis } from "./actual-upstream-budget-recovery";

export function recoveryConflict(message: string): never {
  throw new PricingRepositoryError("pricing_version_conflict", message, 409);
}
function missing(): never {
  throw new PricingRepositoryError(
    "pricing_not_found",
    "Recovery evidence is unavailable in this workspace",
    404,
  );
}
export function recoveryDecode<T>(text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return recoveryConflict("Recovery evidence is invalid JSON");
  }
}
async function rowsForRequests<T>(
  manager: EntityManager,
  table: string,
  workspace: string,
  requests: string[],
): Promise<T[]> {
  const rows: T[] = [];
  for (let index = 0; index < requests.length; index += 100) {
    rows.push(
      ...(await manager
        .createQueryBuilder()
        .select("r.*")
        .from(table, "r")
        .where("r.workspace_id = :workspace AND r.request_id IN (:...ids)", {
          workspace,
          ids: requests.slice(index, index + 100),
        })
        .limit(4097 - rows.length)
        .getRawMany<T>()),
    );
    if (rows.length > 4096)
      recoveryConflict("Recovery group exceeds the bounded inspection limit");
  }
  return rows;
}
function batchContext(attempt: CostAttemptRow) {
  const context = recoveryDecode<AttemptPriceContext>(
    attempt.price_context_json,
  );
  if (!context || typeof context !== "object" || Array.isArray(context))
    recoveryConflict("Attempt pricing context is invalid");
  const batch = context.batch;
  if (
    batch &&
    (!Array.isArray(batch.request_ids) ||
      !batch.request_ids.length ||
      batch.request_ids.length > 1024 ||
      new Set(batch.request_ids).size !== batch.request_ids.length ||
      batch.request_ids.some(
        (id) => typeof id !== "string" || !id || id.length > 128,
      ) ||
      !batch.physical_attempt_id ||
      !batch.batch_id)
  )
    recoveryConflict("Prepared physical membership is invalid");
  return context;
}
/** Follow shared physical attempts transitively; never let one sibling be charged independently. */
async function discover(
  manager: EntityManager,
  workspace: string,
  anchorRequest: string,
): Promise<string[]> {
  const requests = new Set([anchorRequest]);
  const inspected = new Set<string>();
  for (;;) {
    const pending = [...requests].filter((id) => !inspected.has(id));
    if (!pending.length) return [...requests].sort();
    for (const id of pending) inspected.add(id);
    const rows = await rowsForRequests<CostAttemptRow>(
      manager,
      "pricing_attempts",
      workspace,
      pending,
    );
    for (const row of rows)
      for (const id of batchContext(row).batch?.request_ids ?? [])
        requests.add(id);
    if (requests.size > 1024)
      recoveryConflict("Recovery graph exceeds the bounded request limit");
  }
}

/** Caller owns a database transaction. All cooperating request/attempt writers use these same request locks. */
export async function loadRecoveryBasis(
  manager: EntityManager,
  anchor: string,
  workspace: string,
  now = new Date(),
): Promise<LockedRecoveryBasis> {
  const initial = await manager
    .createQueryBuilder()
    .select("r.*")
    .from("pricing_reservations", "r")
    .where("r.id = :id AND r.workspace_id = :workspace", {
      id: anchor,
      workspace,
    })
    .getRawOne<CostReservationRow>();
  if (!initial) missing();
  const caseRow = await manager
    .createQueryBuilder()
    .select("c.*")
    .from("pricing_recovery_cases", "c")
    .where("c.reservation_id = :id AND c.workspace_id = :workspace", {
      id: anchor,
      workspace,
    })
    .getRawOne<PricingRecoveryCaseRow>();
  if (!caseRow && initial.budget_basis !== "actual_upstream") missing();
  const requestIds = await discover(manager, workspace, initial.request_id);
  const snapshots: Array<{
    request_id: string;
    catalog_revision_id: string;
    snapshot_hash: string;
  }> = [];
  for (const id of requestIds) {
    const query = manager
      .createQueryBuilder()
      .select("s.*")
      .from("pricing_request_snapshots", "s")
      .where("s.request_id = :id AND s.workspace_id = :workspace", {
        id,
        workspace,
      });
    if (manager.connection.options.type === "postgres")
      query.setLock("pessimistic_write");
    const row = await query.getRawOne<{
      request_id: string;
      catalog_revision_id: string;
      snapshot_hash: string;
      descriptor_json: string;
    }>();
    if (!row) missing();
    const descriptor = recoveryDecode<Record<string, unknown>>(
      row.descriptor_json,
    );
    if (
      !descriptor ||
      typeof descriptor !== "object" ||
      Array.isArray(descriptor)
    )
      recoveryConflict("Request snapshot is invalid");
    const { snapshot_id, ...body } = descriptor;
    if (
      snapshot_id !== row.snapshot_hash ||
      pricingContentHash(body) !== row.snapshot_hash ||
      body.workspace_id !== workspace ||
      body.catalog_revision_id !== row.catalog_revision_id
    )
      recoveryConflict("Request snapshot integrity check failed");
    snapshots.push({
      request_id: row.request_id,
      catalog_revision_id: row.catalog_revision_id,
      snapshot_hash: row.snapshot_hash,
    });
  }
  if (
    pricingContentHash(
      await discover(manager, workspace, initial.request_id),
    ) !== pricingContentHash(requestIds)
  )
    recoveryConflict(
      "Physical recovery group changed while its locks were acquired; reread the group",
    );
  const reservations = (
    await rowsForRequests<CostReservationRow>(
      manager,
      "pricing_reservations",
      workspace,
      requestIds,
    )
  ).sort((a, b) => a.id.localeCompare(b.id));
  const rows = (
    await rowsForRequests<CostAttemptRow>(
      manager,
      "pricing_attempts",
      workspace,
      requestIds,
    )
  ).sort((a, b) => a.id.localeCompare(b.id));
  // Request locks already fence cooperating mutation and new members; take row locks in canonical order too.
  if (manager.connection.options.type === "postgres") {
    for (const [table, items] of [
      ["pricing_reservations", reservations],
      ["pricing_attempts", rows],
    ] as const) {
      for (const item of items)
        await manager
          .createQueryBuilder()
          .select("r.id")
          .from(table, "r")
          .where("r.id = :id AND r.workspace_id = :workspace", {
            id: item.id,
            workspace,
          })
          .setLock("pessimistic_write")
          .getRawOne();
    }
  }
  const intents = new Map(
    (
      await rowsForRequests<CostSettlementIntentRow>(
        manager,
        "pricing_settlement_intents",
        workspace,
        requestIds,
      )
    ).map((row) => [row.reservation_id, row]),
  );
  for (const intent of intents.values())
    if (
      pricingContentHash(recoveryDecode(intent.payload_json)) !==
      intent.payload_hash
    )
      recoveryConflict("Settlement intent integrity check failed");
  const media = await rowsForRequests<MediaTaskRow>(
    manager,
    "pricing_media_tasks",
    workspace,
    requestIds,
  );
  const cases = await rowsForRequests<PricingRecoveryCaseRow>(
    manager,
    "pricing_recovery_cases",
    workspace,
    requestIds,
  );
  const attempts: LockedRecoveryBasis["attempts"] = [];
  let remainingHistory = 4096;
  for (const request of requestIds) {
    const own = rows.filter((row) => row.request_id === request);
    if (own.length) {
      // Bound retrieval in SQL, not after potentially loading an unbounded history.
      // The request locks prevent cooperating correction writers changing this set.
      const applications = await manager
        .createQueryBuilder()
        .select("h.adjustment_id")
        .from("pricing_adjustment_applications", "h")
        .where("h.request_id = :request AND h.workspace_id = :workspace", {
          request,
          workspace,
        })
        .limit(remainingHistory + 1)
        .getRawMany();
      const adjustments = await manager
        .createQueryBuilder()
        .select("h.id")
        .from("pricing_cost_adjustments", "h")
        .where("h.attempt_id IN (:...ids) AND h.workspace_id = :workspace", {
          ids: own.map((row) => row.id),
          workspace,
        })
        .limit(remainingHistory + 1)
        .getRawMany();
      if (
        applications.length > remainingHistory ||
        adjustments.length > remainingHistory
      )
        recoveryConflict(
          "Recovery adjustment history exceeds the bounded inspection limit",
        );
      if (applications.length !== adjustments.length)
        recoveryConflict("Recovery adjustment evidence is incomplete");
      remainingHistory -= applications.length;
    }
    const histories = await loadCostAdjustments(
      manager,
      request,
      workspace,
      own,
    );
    for (const row of own) {
      const context = batchContext(row);
      const cost = row.cost_json
        ? recoveryDecode<CostComputation>(row.cost_json)
        : null;
      if (
        row.state === "terminal" &&
        (!cost || !row.cost_hash || pricingContentHash(cost) !== row.cost_hash)
      )
        recoveryConflict("Original terminal evidence is missing or corrupted");
      const history = histories.get(row.id) ?? [];
      const effective = history.at(-1)?.cost ?? cost;
      if (effective) {
        try {
          validateBatchShare(effective);
        } catch {
          recoveryConflict("Physical allocation evidence is invalid");
        }
      }
      attempts.push({ row, context, cost: effective, history });
    }
  }
  const physical = new Map<string, typeof attempts>();
  for (const attempt of attempts)
    if (attempt.context.batch) {
      const id = attempt.context.batch.physical_attempt_id;
      physical.set(id, [...(physical.get(id) ?? []), attempt]);
    }
  for (const members of physical.values()) {
    const prepared = members[0].context.batch!;
    if (members.length !== prepared.request_ids.length)
      recoveryConflict(
        "Physical membership is incomplete; individual-member resolution is forbidden",
      );
    let manifestMembers: unknown;
    if (prepared.manifest_hash) {
      const manifest = await manager
        .createQueryBuilder()
        .select("m.*")
        .from("pricing_batch_manifests", "m")
        .where("m.physical_attempt_id = :id AND m.workspace_id = :workspace", {
          id: prepared.physical_attempt_id,
          workspace,
        })
        .getRawOne<{ manifest_hash: string; manifest_json: string }>();
      if (!manifest) recoveryConflict("Prepared physical manifest is missing");
      const body = recoveryDecode<{
        workspace_id: string;
        batch_id: string;
        physical_attempt_id: string;
        members: Array<{ request_id: string; reservation_id: string }>;
      }>(manifest.manifest_json);
      if (
        manifest.manifest_hash !== prepared.manifest_hash ||
        pricingContentHash(body) !== prepared.manifest_hash ||
        body.workspace_id !== workspace ||
        body.batch_id !== prepared.batch_id ||
        body.physical_attempt_id !== prepared.physical_attempt_id ||
        pricingContentHash(body.members.map((entry) => entry.request_id)) !==
          pricingContentHash(prepared.request_ids)
      )
        recoveryConflict("Prepared physical manifest integrity check failed");
      manifestMembers = body.members;
    }
    const indexes = new Set<number>();
    let physicalHash: string | undefined;
    for (const member of members) {
      const batch = member.context.batch!;
      if (
        batch.manifest_hash !== prepared.manifest_hash ||
        batch.batch_id !== prepared.batch_id ||
        pricingContentHash(batch.request_ids) !==
          pricingContentHash(prepared.request_ids) ||
        !Number.isInteger(batch.member_index) ||
        prepared.request_ids[batch.member_index] !== member.row.request_id ||
        indexes.has(batch.member_index) ||
        !member.row.reservation_id
      )
        recoveryConflict("Prepared physical membership is inconsistent");
      indexes.add(batch.member_index);
      if (member.cost) {
        const allocation = member.cost.batch;
        if (
          (manifestMembers &&
            allocation &&
            pricingContentHash(allocation.members) !==
              pricingContentHash(manifestMembers)) ||
          !allocation ||
          allocation.physical_attempt_id !== batch.physical_attempt_id ||
          allocation.batch_id !== batch.batch_id ||
          allocation.member_index !== batch.member_index ||
          pricingContentHash(
            allocation.members.map((entry) => entry.request_id),
          ) !== pricingContentHash(prepared.request_ids) ||
          allocation.members[batch.member_index]?.reservation_id !==
            member.row.reservation_id
        )
          recoveryConflict("Physical receipt differs from its prepared member");
        if (
          physicalHash !== undefined &&
          physicalHash !== allocation.physical_cost_hash
        )
          recoveryConflict("Effective physical costs have diverged");
        physicalHash = allocation.physical_cost_hash;
      }
    }
  }
  const actual: NonNullable<LockedRecoveryBasis["actual"]> = new Map();
  for (const row of reservations)
    if (row.budget_basis === "actual_upstream" && row.state === "reserved")
      actual.set(row.id, await readActualRecoveryBasis(manager, row));
  const view: RecoveryBasis = {
    anchor_reservation_id: anchor,
    basis_hash: "",
    request_ids: requestIds,
    budget_only: true,
    reservations: reservations.map((row) => ({
      id: row.id,
      request_id: row.request_id,
      state: row.state,
      budget_basis: row.budget_basis,
      ...(actual.has(row.id) ? { actual_budget: {
        dispatch_closed: Boolean(actual.get(row.id)!.cohort),
        known_cost_usd: actual.get(row.id)!.plan.known_cost_usd,
        settlement_ready: actual.get(row.id)!.pending.length === 0,
        pending_reasons: actual.get(row.id)!.pending,
        unresolved_attempt_ids: [...new Set([...actual.get(row.id)!.plan.unresolved_cost_attempts, ...actual.get(row.id)!.plan.unresolved_token_attempts])].sort(),
      } } : {}),
      reserved_cost_usd: row.reserved_cost_usd,
      reserved_tokens: row.reserved_tokens,
      committed_cost_usd: row.committed_cost_usd,
      committed_tokens: row.committed_tokens,
      lease_until: row.lease_until,
      intent_state: intents.get(row.id)?.state ?? null,
      blocked_reason:
        row.state !== "reserved"
          ? null
          : row.job_id ||
              media.some(
                (task) =>
                  task.reservation_id === row.id &&
                  task.state !== "synchronous",
              )
            ? "asynchronous_task_owned"
            : !intents.has(row.id) && !actual.get(row.id)?.cohort && row.lease_until > now.toISOString()
              ? "lease_active"
              : null,
    })),
    attempts: attempts.map(({ row, context, cost, history }) => ({
      id: row.id,
      request_id: row.request_id,
      reservation_id: row.reservation_id,
      state: row.state,
      fee_source: row.fee_source,
      node_id: row.node_id, model: row.model, error_code: row.error_code, dispatched_at: row.dispatched_at,
      effective_cost_hash: history.at(-1)?.cost_hash ?? row.cost_hash,
      cost,
      physical_attempt_id: context.batch?.physical_attempt_id ?? null,
    })),
  };
  // Do not include observation timestamps: polling a case must not itself invalidate a proposal.
  view.basis_hash = pricingContentHash({
    anchor,
    workspace,
    snapshots,
    reservations,
    attempts: attempts.map(({ row, history }) => ({
      row,
      adjustments: history.map((entry) => [
        entry.id,
        entry.cost_hash,
        entry.application.application_hash,
      ]),
    })),
    intents: [...intents.values()]
      .sort((a, b) => a.reservation_id.localeCompare(b.reservation_id))
      .map((entry) => [
        entry.reservation_id,
        entry.request_id,
        entry.state,
        entry.payload_hash,
        entry.payload_json,
      ]),
    media: media
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((task) => [task.id, task.state, task.revision, task.context_hash]),
    cases: cases
      .sort((a, b) => a.reservation_id.localeCompare(b.reservation_id))
      .map((entry) => [
        entry.reservation_id,
        entry.state,
        entry.resolution_code,
      ]),
    actual: [...actual].map(([id, entry]) => [id, entry.identity, entry.cohort?.closure_hash ?? null, entry.cohort?.state ?? null, entry.plan.plan_hash, entry.pending, entry.custody_hash]),
  });
  return { view, reservations, attempts, intents, cases, actual };
}

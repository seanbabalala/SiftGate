import { assertGroupOutcomeUndisposed, readGroupDispositionRow, verifyGroupDispositionRecord } from "./pricing-group-disposition-record";
import type { EntityManager } from "typeorm";
import { pricingContentHash } from "./pricing-json";
import { PricingRepositoryError } from "./pricing-repository.types";
import {
  groupOutcomeDeclaredMembers,
  groupOutcomeReceipts,
  readRuntimeGroupDocument,
  runtimeGroupOutcomeDocument,
  type GroupOutcomeDocument,
} from "./pricing-group-outcome-document";
import type {
  GroupOutcomeMember,
  GroupOutcomeRow,
  GroupOutcomeState,
  PricingGroupOutcome,
} from "./pricing-group-outcome.types";
import type {
  AttemptPriceContext,
  CostAttemptRow,
  CostReservationRow,
} from "./cost-ledger.types";

export const GROUP_OUTCOME_TABLE = "pricing_runtime_group_outcomes";
const MEMBERS = "pricing_runtime_group_outcome_members";
const conflict = (message: string): never => {
  throw new PricingRepositoryError("pricing_version_conflict", message, 409);
};
const missing = (): never => {
  throw new PricingRepositoryError(
    "pricing_not_found",
    "Complete-group runtime evidence not found in this workspace",
    404,
  );
};
function decoded<T>(json: string): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return conflict("Stored group ownership metadata is invalid");
  }
}
const memberHash = (members: GroupOutcomeMember[]) =>
  pricingContentHash(
    members
      .slice()
      .sort((a, b) => a.reservation_id.localeCompare(b.reservation_id)),
  );

/** Request-first locks cover every declared physical member, including historical groups. */
async function ownership(
  manager: EntityManager,
  document: GroupOutcomeDocument,
  lockRequests = true,
) {
  const outcome = document.outcome,
    declared = groupOutcomeDeclaredMembers(outcome);
  if (!declared.length || declared.length > 4096)
    conflict("Invalid complete-group ownership");
  const lookup = () =>
    manager
      .createQueryBuilder()
      .select("r.*")
      .from("pricing_reservations", "r")
      .where("r.id IN (:...ids) AND r.workspace_id = :workspace", {
        ids: declared.map((member) => member.reservation_id),
        workspace: outcome.workspace,
      })
      .getRawMany<CostReservationRow>();
  let holds = await lookup();
  if (holds.length !== declared.length) missing();
  for (const request of [
    ...new Set(holds.map((row) => row.request_id)),
  ].sort()) {
    const query = manager
      .createQueryBuilder()
      .select("s.request_id", "request_id")
      .from("pricing_request_snapshots", "s")
      .where("s.request_id = :id AND s.workspace_id = :workspace", {
        id: request,
        workspace: outcome.workspace,
      });
    if (lockRequests && manager.connection.options.type === "postgres")
      query.setLock("pessimistic_write");
    if (!(await query.getRawOne())) missing();
  }
  holds = await lookup();
  const byId = new Map(holds.map((row) => [row.id, row]));
  const members = declared
    .map((member) => {
      const row = byId.get(member.reservation_id);
      if (!row || (member.request_id && member.request_id !== row.request_id))
        missing();
      return { reservation_id: row!.id, request_id: row!.request_id };
    })
    .sort((a, b) => a.reservation_id.localeCompare(b.reservation_id));
  let review = holds.some((row) => row.job_id !== null);
  const task = await manager
    .createQueryBuilder()
    .select("t.id", "id")
    .from("pricing_media_tasks", "t")
    .where(
      "t.workspace_id = :workspace AND t.reservation_id IN (:...ids) AND t.state <> :state",
      {
        workspace: outcome.workspace,
        ids: members.map((member) => member.reservation_id),
        state: "synchronous",
      },
    )
    .limit(1)
    .getRawOne();
  review ||= Boolean(task);
  const receipts = groupOutcomeReceipts(outcome),
    ids = [...new Set(receipts.map((receipt) => receipt.attemptId))];
  const attempts = ids.length
    ? await manager
        .createQueryBuilder()
        .select("a.*")
        .from("pricing_attempts", "a")
        .where("a.id IN (:...ids) AND a.workspace_id = :workspace", {
          ids,
          workspace: outcome.workspace,
        })
        .getRawMany<CostAttemptRow>()
    : [];
  const attemptsById = new Map(attempts.map((row) => [row.id, row]));
  const manifests = new Map<
    string,
    { manifest_hash: string; manifest_json: string } | null
  >();
  for (const receipt of receipts) {
    const row = attemptsById.get(receipt.attemptId),
      hold = byId.get(receipt.reservationId);
    if (
      !row ||
      !hold ||
      row.reservation_id !== hold.id ||
      row.request_id !== hold.request_id
    )
      missing();
    const costHash = pricingContentHash(receipt.cost);
    if (
      !receipt.primary &&
      (row!.state !== "terminal" ||
        row!.cost_hash !== costHash ||
        row!.error_code !== receipt.errorCode)
    ) {
      // A receipt in this same primary complete group may be supplied again by its terminal payload.
      const samePrimary = receipts.some(
        (other) =>
          other.primary &&
          other.attemptId === receipt.attemptId &&
          pricingContentHash(other.cost) === costHash &&
          other.errorCode === receipt.errorCode,
      );
      if (!samePrimary) review = true;
    }
    if (
      row!.state === "terminal" &&
      (row!.cost_hash !== costHash || row!.error_code !== receipt.errorCode)
    )
      review = true;
    const batch = receipt.cost.batch;
    const prepared = decoded<AttemptPriceContext>(
      row!.price_context_json,
    ).batch;
    if (batch) {
      const member = batch.members[batch.member_index];
      if (
        !member ||
        member.reservation_id !== hold!.id ||
        member.request_id !== hold!.request_id
      )
        conflict("Receipt share differs from its owner");
      const body = {
        workspace_id: outcome.workspace,
        batch_id: batch.batch_id,
        physical_attempt_id: batch.physical_attempt_id,
        members: batch.members,
      };
      const hash = pricingContentHash(body);
      if (!manifests.has(batch.physical_attempt_id))
        manifests.set(
          batch.physical_attempt_id,
          (await manager
            .createQueryBuilder()
            .select("m.*")
            .from("pricing_batch_manifests", "m")
            .where(
              "m.physical_attempt_id = :id AND m.workspace_id = :workspace",
              { id: batch.physical_attempt_id, workspace: outcome.workspace },
            )
            .getRawOne()) ?? null,
        );
      const manifest = manifests.get(batch.physical_attempt_id);
      if (
        !manifest ||
        manifest.manifest_hash !== hash ||
        pricingContentHash(decoded(manifest.manifest_json)) !== hash ||
        !prepared ||
        prepared.manifest_hash !== hash ||
        prepared.batch_id !== batch.batch_id ||
        prepared.physical_attempt_id !== batch.physical_attempt_id ||
        prepared.member_index !== batch.member_index ||
        pricingContentHash(prepared.request_ids) !==
          pricingContentHash(batch.members.map((value) => value.request_id))
      )
        review = true;
    } else if (prepared) review = true;
  }
  if (outcome.type === "settlement_group") {
    const dispatch = await manager
      .createQueryBuilder()
      .select("a.id", "id")
      .from("pricing_attempts", "a")
      .where("a.workspace_id = :workspace AND a.reservation_id IN (:...ids)", {
        workspace: outcome.workspace,
        ids: members.map((member) => member.reservation_id),
      })
      .limit(1)
      .getRawOne();
    review ||=
      Boolean(dispatch) ||
      receipts.length > 0 ||
      outcome.entries.some(
        (entry) =>
          entry.payload.kind !== "release" ||
          Number(entry.payload.tokens) !== 0 ||
          Number(entry.payload.cost_usd) !== 0,
      );
  }
  if (outcome.type === "actual_budget_closure_group") {
    if (holds.some(hold => hold.budget_basis !== "actual_upstream")) review = true;
    for (const entry of outcome.entries) {
      const population = await manager.createQueryBuilder().select("a.id", "id").from("pricing_attempts", "a")
        .where("a.reservation_id = :id AND a.workspace_id = :workspace", { id: entry.reservationId, workspace: outcome.workspace })
        .orderBy("a.id", "ASC").limit(1025).getRawMany<{ id: string }>();
      if (population.length > 1024 || pricingContentHash(population.map(row => row.id)) !== pricingContentHash(entry.payload.attempt_ids)) review = true;
    }
  }
  return { members, review };
}
function metadata(row: GroupOutcomeRow) {
  return {
    outcome_id: row.id,
    workspace_id: row.workspace_id,
    kind: row.kind,
    subject_id: row.subject_id,
    document_hash: row.document_hash,
    members_hash: row.members_hash,
    member_count: row.member_count,
    source: "gateway_runtime",
  };
}
async function audit(
  manager: EntityManager,
  row: GroupOutcomeRow,
  state: "retained" | "delivered" | "review_required",
) {
  const id = `${row.id}:${state}`,
    action = `cost.group_outcome_${state}`;
  const prior = await manager
    .createQueryBuilder()
    .select("a.metadata_json", "metadata_json")
    .from("pricing_audit_events", "a")
    .where(
      "a.id = :id AND a.workspace_id = :workspace AND a.action = :action AND a.actor_id = :actor",
      {
        id,
        workspace: row.workspace_id,
        action,
        actor: "system:runtime-group-outcome",
      },
    )
    .getRawOne<{ metadata_json: string }>();
  if (prior) {
    if (
      pricingContentHash(decoded(prior.metadata_json)) !==
      pricingContentHash(metadata(row))
    )
      conflict("Group outcome audit differs");
    return;
  }
  await manager
    .createQueryBuilder()
    .insert()
    .into("pricing_audit_events", [
      "id",
      "workspace_id",
      "book_id",
      "actor_id",
      "action",
      "reason",
      "metadata_json",
      "created_at",
    ])
    .values({
      id,
      workspace_id: row.workspace_id,
      book_id: null,
      actor_id: "system:runtime-group-outcome",
      action,
      reason:
        "Internal complete-group outcome custody; not supplier confirmation",
      metadata_json: JSON.stringify(metadata(row)),
      created_at: new Date().toISOString(),
    })
    .execute();
}
async function verifyAudit(
  manager: EntityManager,
  row: GroupOutcomeRow,
  state: "retained" | "delivered" | "review_required",
) {
  const entry = await manager
    .createQueryBuilder()
    .select("a.metadata_json", "metadata_json")
    .from("pricing_audit_events", "a")
    .where(
      "a.id = :id AND a.workspace_id = :workspace AND a.action = :action AND a.actor_id = :actor",
      {
        id: `${row.id}:${state}`,
        workspace: row.workspace_id,
        action: `cost.group_outcome_${state}`,
        actor: "system:runtime-group-outcome",
      },
    )
    .getRawOne<{ metadata_json: string }>();
  if (
    !entry ||
    pricingContentHash(decoded(entry.metadata_json)) !==
      pricingContentHash(metadata(row))
  )
    conflict("Group outcome lacks its required audit");
}
export async function verifyRuntimeGroupOutcome(manager: EntityManager, row: GroupOutcomeRow, lockRequests = true) {
  const document = readRuntimeGroupDocument(row.document_json);
  if (
    row.id !== document.id ||
    row.document_hash !== document.hash ||
    row.kind !== document.outcome.type ||
    row.workspace_id !== document.outcome.workspace ||
    row.subject_id !== document.subject ||
    !["pending", "delivered", "review_required"].includes(row.state) ||
    !Number.isSafeInteger(row.attempts) ||
    row.attempts < 0 ||
    !Number.isFinite(Date.parse(row.created_at)) ||
    !Number.isFinite(Date.parse(row.next_attempt_at))
  )
    conflict("Group outcome identity differs");
  const owned = await ownership(manager, document, lockRequests);
  const links = await manager
    .createQueryBuilder()
    .select([
      "m.request_id AS request_id",
      "m.reservation_id AS reservation_id",
    ])
    .from(MEMBERS, "m")
    .where("m.outcome_id = :id AND m.workspace_id = :workspace", {
      id: row.id,
      workspace: row.workspace_id,
    })
    .getRawMany<GroupOutcomeMember>();
  if (
    row.members_hash !== memberHash(owned.members) ||
    row.member_count !== owned.members.length ||
    memberHash(links) !== row.members_hash
  )
    conflict("Complete-group custody membership differs");
  await verifyAudit(manager, row, "retained");
  if (row.state !== "pending") await verifyAudit(manager, row, row.state);
  return { row, document, ...owned };
}
export async function readRuntimeGroupOutcome(
  manager: EntityManager,
  id: string,
  workspace: string,
) {
  const row = await manager
    .createQueryBuilder()
    .select("o.*")
    .from(GROUP_OUTCOME_TABLE, "o")
    .where("o.id = :id AND o.workspace_id = :workspace", { id, workspace })
    .getRawOne<GroupOutcomeRow>();
  if (!row) missing();
  return verifyRuntimeGroupOutcome(manager, row!);
}
export async function retainRuntimeGroupOutcome(
  manager: EntityManager,
  input: PricingGroupOutcome,
) {
  const document = runtimeGroupOutcomeDocument(input),
    owned = await ownership(manager, document);
  const existing = await manager
    .createQueryBuilder()
    .select("o.*")
    .from(GROUP_OUTCOME_TABLE, "o")
    .where("o.id = :id AND o.workspace_id = :workspace", {
      id: document.id,
      workspace: input.workspace,
    })
    .getRawOne<GroupOutcomeRow>();
  if (existing) {
    await verifyRuntimeGroupOutcome(manager, existing);
    return existing;
  }
  const sibling = await manager
    .createQueryBuilder()
    .select("o.id", "id")
    .from(GROUP_OUTCOME_TABLE, "o")
    .where(
      "o.workspace_id = :workspace AND o.kind = :kind AND o.subject_id = :subject",
      {
        workspace: input.workspace,
        kind: input.type,
        subject: document.subject,
      },
    )
    .limit(1)
    .getRawOne();
  const now = new Date().toISOString();
  const row: GroupOutcomeRow = {
    id: document.id,
    workspace_id: input.workspace,
    kind: input.type,
    subject_id: document.subject,
    document_hash: document.hash,
    document_json: document.json,
    members_hash: memberHash(owned.members),
    member_count: owned.members.length,
    state: owned.review || sibling ? "review_required" : "pending",
    created_at: now,
    updated_at: now,
    next_attempt_at: now,
    attempts: 0,
    last_error_code: null,
    delivered_at: null,
  };
  await manager
    .createQueryBuilder()
    .insert()
    .into(GROUP_OUTCOME_TABLE, Object.keys(row))
    .values(row)
    .execute();
  await manager
    .createQueryBuilder()
    .insert()
    .into(MEMBERS, [
      "outcome_id",
      "reservation_id",
      "workspace_id",
      "request_id",
    ])
    .values(
      owned.members.map((member) => ({
        outcome_id: row.id,
        reservation_id: member.reservation_id,
        workspace_id: row.workspace_id,
        request_id: member.request_id,
      })),
    )
    .execute();
  await audit(manager, row, "retained");
  if (row.state === "review_required") await audit(manager, row, row.state);
  return row;
}
export async function transitionRuntimeGroupOutcome(
  manager: EntityManager,
  original: GroupOutcomeRow,
  state: GroupOutcomeState,
) {
  const { row } = await readRuntimeGroupOutcome(
    manager,
    original.id,
    original.workspace_id,
  );
  if (row.document_hash !== original.document_hash)
    conflict("Group outcome changed during delivery");
  if (
    row.state === "review_required" ||
    (row.state === "delivered" && state !== "review_required")
  )
    return row;
  const now = new Date(),
    attempts = Math.min(row.attempts + 1, 1000000);
  const next = {
    ...row,
    state,
    attempts,
    updated_at: now.toISOString(),
    next_attempt_at: new Date(
      now.getTime() + Math.min(60000, 1000 * 2 ** Math.min(attempts - 1, 6)),
    ).toISOString(),
    delivered_at: state === "delivered" ? now.toISOString() : row.delivered_at,
    last_error_code:
      state === "pending"
        ? "storage_unavailable"
        : state === "review_required"
          ? "evidence_requires_review"
          : null,
  };
  if (state !== "pending") await audit(manager, next, state);
  const { document_json: _body, ...values } = next;
  await manager
    .createQueryBuilder()
    .update(GROUP_OUTCOME_TABLE)
    .set(values)
    .where("id = :id AND workspace_id = :workspace", {
      id: row.id,
      workspace: row.workspace_id,
    })
    .execute();
  return next;
}
/** Called inside the complete group's write transaction, before any member mutation. */
export async function assertRuntimeGroupDeliverable(
  manager: EntityManager,
  id: string | undefined,
  outcome: PricingGroupOutcome,
) {
  if (!id) return;
  if (runtimeGroupOutcomeDocument(outcome).id !== id)
    conflict("Group delivery does not match the retained body");
  const retained = await readRuntimeGroupOutcome(
    manager,
    id,
    outcome.workspace,
  );
  await assertGroupOutcomeUndisposed(manager,id,outcome.workspace);
  if (retained.row.state === "review_required" || retained.review)
    conflict("Retained group evidence requires complete-group review");
}
export async function quarantineInvalidGroupOutcome(
  manager: EntityManager,
  original: Pick<GroupOutcomeRow, "id" | "workspace_id">,
) {
  // Healthy delivery locks requests before touching an outcome row. Preserve that
  // order even if this body's JSON is corrupt: the separately retained roster
  // still supplies bounded lock targets and never authorizes a financial write.
  const links = await manager
    .createQueryBuilder()
    .select(["m.request_id AS request_id"])
    .from(MEMBERS, "m")
    .where("m.outcome_id = :id AND m.workspace_id = :workspace", {
      id: original.id,
      workspace: original.workspace_id,
    })
    .limit(4097)
    .getRawMany<{ request_id: string }>();
  if (links.length > 4096)
    conflict("Corrupt group membership exceeds the lock bound");
  for (const requestId of [
    ...new Set(links.map((link) => link.request_id)),
  ].sort()) {
    const owner = manager
      .createQueryBuilder()
      .select("s.request_id", "request_id")
      .from("pricing_request_snapshots", "s")
      .where("s.request_id = :id AND s.workspace_id = :workspace", {
        id: requestId,
        workspace: original.workspace_id,
      });
    if (manager.connection.options.type === "postgres")
      owner.setLock("pessimistic_write");
    await owner.getRawOne();
  }

  const query = manager
    .createQueryBuilder()
    .select("o.*")
    .from(GROUP_OUTCOME_TABLE, "o")
    .where("o.id = :id AND o.workspace_id = :workspace", {
      id: original.id,
      workspace: original.workspace_id,
    });
  if (manager.connection.options.type === "postgres")
    query.setLock("pessimistic_write");
  const row = await query.getRawOne<GroupOutcomeRow>();
  if (!row || row.state !== "pending") return;
  // Do not decode, replace, or promote corrupt financial evidence. Record only its observed body digest.
  const observation = {
    ...metadata(row),
    observed_body_hash: pricingContentHash(row.document_json),
  };
  await manager
    .createQueryBuilder()
    .insert()
    .into("pricing_audit_events", [
      "id",
      "workspace_id",
      "book_id",
      "actor_id",
      "action",
      "reason",
      "metadata_json",
      "created_at",
    ])
    .values({
      id: `${row.id}:integrity:${observation.observed_body_hash}`,
      workspace_id: row.workspace_id,
      book_id: null,
      actor_id: "system:runtime-group-outcome",
      action: "cost.group_outcome_integrity",
      reason: "Retained bytes preserved; automatic replay stopped",
      metadata_json: JSON.stringify(observation),
      created_at: new Date().toISOString(),
    })
    .execute();
  await audit(manager, row, "review_required");
  await manager
    .createQueryBuilder()
    .update(GROUP_OUTCOME_TABLE)
    .set({
      state: "review_required",
      last_error_code: "evidence_integrity_invalid",
      updated_at: new Date().toISOString(),
    })
    .where("id = :id AND workspace_id = :workspace AND state = :state", {
      id: row.id,
      workspace: row.workspace_id,
      state: "pending",
    })
    .execute();
}
export async function runtimeGroupOutcomeInventory(
  manager: EntityManager,
  workspace: string,
  state: GroupOutcomeState,
  limit: number,
  cursor?: string,
) {
  if (
    !["pending", "delivered", "review_required"].includes(state) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 50
  )
    conflict("Invalid group inventory bound");
  const query = manager
    .createQueryBuilder()
    .select(
      [
        "id",
        "workspace_id",
        "kind",
        "subject_id",
        "document_hash",
        "members_hash",
        "member_count",
        "state",
        "created_at",
        "updated_at",
        "next_attempt_at",
        "attempts",
        "last_error_code",
        "delivered_at",
      ].map((column) => `o.${column} AS ${column}`),
    )
    .from(GROUP_OUTCOME_TABLE, "o")
    .where("o.workspace_id = :workspace AND o.state = :state", {
      workspace,
      state,
    });
  if (cursor) {
    if (cursor.length > 2048) conflict("Invalid group inventory cursor");
    const value = decoded<{
      workspace: string;
      state: string;
      created_at: string;
      id: string;
    }>(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      !value ||
      value.workspace !== workspace ||
      value.state !== state ||
      !Number.isFinite(Date.parse(value.created_at)) ||
      typeof value.id !== "string" ||
      value.id.length > 160
    )
      conflict("Group inventory cursor belongs to another scope");
    query.andWhere(
      "(o.created_at > :created OR (o.created_at = :created AND o.id > :id))",
      { created: value.created_at, id: value.id },
    );
  }
  const items = await query
    .orderBy("o.created_at", "ASC")
    .addOrderBy("o.id", "ASC")
    .limit(limit + 1)
    .getRawMany<Omit<GroupOutcomeRow, "document_json">>();
  const hasMore = items.length > limit;
  if (hasMore) items.pop();
  const last = items.at(-1);
  const projected=[];
  for(const item of items){
    const disposition=await readGroupDispositionRow(manager,item.id,workspace);
    if(disposition)await verifyGroupDispositionRecord(manager,disposition);
    projected.push({...item,disposition:disposition?{id:disposition.operation_id,action:disposition.action,actor_id:disposition.actor_id,result_hash:disposition.result_hash}:null});
  }
  return {
    read_only: true,
    supplier_confirmed: false,
    items: projected,
    next_cursor:
      hasMore && last
        ? Buffer.from(
            JSON.stringify({
              workspace,
              state,
              created_at: last.created_at,
              id: last.id,
            }),
          ).toString("base64url")
        : null,
  };
}

import type { EntityManager } from "typeorm";
import type { CostAttemptRow } from "./cost-ledger.types";
import type { CostComputation } from "./pricing.types";
import type { PricingActor } from "./pricing-repository.types";
import type { EmbeddingBatchMember } from "./pricing-batch.types";
import type {
  UsageRecoveryBasis,
  UsageRecoveryInput,
  UsageRecoveryResult,
} from "./pricing-usage-recovery.types";
import {
  loadRecoveryBasis,
  recoveryConflict,
  recoveryDecode,
} from "./pricing-recovery-basis";
import { pricingContentHash } from "./pricing-json";
import { allocateBatchCost, batchShareCost } from "./cost-allocation";
import { redactErrorText } from "../security/error-redaction";
import { PricingRepositoryError } from "./pricing-repository.types";

export const USAGE_RECOVERY_ERROR = "supplier_outcome_unconfirmed";
const action = "cost.usage_recovered";
export const usageRecoveryAuditId = (workspace: string, id: string) =>
  `usage-recovery:${pricingContentHash([workspace, id])}`;
export const usageRecoveryProposalHash = (
  anchor: string,
  actor: PricingActor,
  input: UsageRecoveryInput,
) =>
  pricingContentHash({
    anchor,
    actor: actor.id,
    workspace: actor.workspace_id,
    input,
  });

/** Locks the entire connected graph; only the selected physical invocation receives new usage. */
export async function loadUsageRecoveryBasis(
  manager: EntityManager,
  anchor: string,
  workspace: string,
  attemptId: string,
): Promise<UsageRecoveryBasis> {
  const group = await loadRecoveryBasis(manager, anchor, workspace);
  const selected = group.attempts.find((entry) => entry.row.id === attemptId);
  if (!selected)
    throw new PricingRepositoryError(
      "pricing_not_found",
      "Attempt is not in this scoped recovery group",
      404,
    );
  const batch = selected.context.batch;
  const attempts = (
    batch
      ? group.attempts.filter(
          (entry) =>
            entry.context.batch?.physical_attempt_id ===
            batch.physical_attempt_id,
        )
      : [selected]
  ).sort(
    (a, b) =>
      (a.context.batch?.member_index ?? 0) -
      (b.context.batch?.member_index ?? 0),
  );
  for (const entry of attempts) {
    const row = entry.row,
      reservation = group.reservations.find(
        (hold) => hold.id === row.reservation_id,
      );
    if (!reservation || row.fee_source !== "provider")
      recoveryConflict(
        "Usage recovery requires a recorded provider dispatch and reservation",
      );
    if (
      row.state !== "dispatched" ||
      row.cost_json !== null ||
      row.cost_hash !== null ||
      entry.history.length
    )
      recoveryConflict(
        "An existing receipt must use linked correction, not missing-usage recovery",
      );
    // Even a terminal hold can have a paused owner or an independently owned media job.
    // Do not convert task settlement or a durable pending intent into manual recovery.
    if (
      reservation.job_id ||
      reservation.lease_until > new Date().toISOString()
    )
      recoveryConflict(
        "The dispatch may still be owned by an active request or job",
      );
    const intent = group.intents.get(reservation.id);
    if (intent && intent.state !== "applied")
      recoveryConflict(
        "Apply the existing immutable settlement intent before recovering usage",
      );
    const task = await manager
      .createQueryBuilder()
      .select("t.id")
      .from("pricing_media_tasks", "t")
      .where(
        "t.workspace_id = :workspace AND t.reservation_id = :id AND t.state <> :state",
        { workspace, id: reservation.id, state: "synchronous" },
      )
      .limit(1)
      .getRawOne();
    if (task)
      recoveryConflict(
        "Asynchronous media evidence belongs to the task lifecycle",
      );
    if (
      row.node_id !== selected.row.node_id ||
      row.model !== selected.row.model ||
      pricingContentHash(entry.context.context) !==
        pricingContentHash(selected.context.context) ||
      pricingContentHash(entry.context.legacyPrice) !==
        pricingContentHash(selected.context.legacyPrice)
    )
      recoveryConflict(
        "Physical members disagree about their price target or context",
      );
  }
  let physical: UsageRecoveryBasis["physical"] = null;
  if (batch) {
    // Missing legacy weights are not inferred from equal shares or current request payloads.
    if (!batch.manifest_hash)
      recoveryConflict(
        "Recovering unknown batch usage requires its durable allocation manifest",
      );
    const manifest = await manager
      .createQueryBuilder()
      .select("m.manifest_json", "manifest_json")
      .addSelect("m.manifest_hash", "manifest_hash")
      .from("pricing_batch_manifests", "m")
      .where("m.physical_attempt_id = :id AND m.workspace_id = :workspace", {
        id: batch.physical_attempt_id,
        workspace,
      })
      .getRawOne<{ manifest_json: string; manifest_hash: string }>();
    if (!manifest || manifest.manifest_hash !== batch.manifest_hash)
      recoveryConflict("Allocation manifest is unavailable");
    const body = recoveryDecode<{
      workspace_id: string;
      batch_id: string;
      physical_attempt_id: string;
      members: EmbeddingBatchMember[];
    }>(manifest.manifest_json);
    if (
      pricingContentHash(body) !== batch.manifest_hash ||
      !Array.isArray(body.members) ||
      body.members.length !== attempts.length
    )
      recoveryConflict("Allocation manifest integrity failed");
    for (const [index, entry] of attempts.entries()) {
      const member = body.members[index];
      if (
        member.request_id !== entry.row.request_id ||
        member.reservation_id !== entry.row.reservation_id
      )
        recoveryConflict(
          "Allocation manifest differs from dispatched membership",
        );
    }
    physical = {
      batch_id: batch.batch_id,
      physical_attempt_id: batch.physical_attempt_id,
      members: body.members,
    };
  }
  const first = attempts[0]; // Canonical physical anchor, independent of which member the operator selected.
  const reservation = group.reservations.find(
    (row) => row.id === first.row.reservation_id,
  )!;
  const estimate = recoveryDecode<CostComputation>(reservation.estimate_json);
  return {
    basis_hash: group.view.basis_hash,
    request_id: first.row.request_id,
    target: {
      node_id: first.row.node_id,
      model: first.row.model,
      ...(first.context.context.media?.operation
        ? { operation: first.context.context.media.operation }
        : {}),
    },
    pricing: first.context,
    dispatched_at: first.row.dispatched_at,
    legacy_version:
      estimate.book_id === "legacy-config" ? estimate.version_id : null,
    physical,
    attempts: attempts.map(({ row }) => ({
      id: row.id,
      request_id: row.request_id,
      reservation_id: row.reservation_id!,
    })),
  };
}

/** Read-only acknowledgement verifies the original receipts, not a later latest-price computation. */
export async function recordedUsageRecovery(
  manager: EntityManager,
  anchor: string,
  workspace: string,
  id: string,
  proposalHash?: string,
): Promise<UsageRecoveryResult | null> {
  const audit = await manager
    .createQueryBuilder()
    .select("a.metadata_json", "metadata_json")
    .from("pricing_audit_events", "a")
    .where(
      "a.id = :id AND a.workspace_id = :workspace AND a.action = :action",
      { id: usageRecoveryAuditId(workspace, id), workspace, action },
    )
    .getRawOne<{ metadata_json: string }>();
  if (!audit) return null;
  const stored = recoveryDecode<{
    proposal_hash: string;
    result_hash: string;
    result: UsageRecoveryResult;
  }>(audit.metadata_json);
  const result = stored?.result;
  if (
    !result ||
    result.id !== id ||
    result.anchor_reservation_id !== anchor ||
    (proposalHash && stored.proposal_hash !== proposalHash)
  )
    recoveryConflict("Usage recovery identity was reused");
  if (
    pricingContentHash(result) !== stored.result_hash ||
    result.source !== "administrator_attestation" ||
    result.supplier_confirmed !== false ||
    result.budget_changed !== false ||
    result.dry_run !== false ||
    !Array.isArray(result.changes) ||
    !result.changes.length ||
    result.changes.length > 1024 ||
    new Set(result.changes.map((row) => row.attempt_id)).size !==
      result.changes.length
  )
    recoveryConflict("Usage recovery acknowledgement integrity failed");
  for (const change of result.changes) {
    const row = await manager
      .createQueryBuilder()
      .select("a.*")
      .from("pricing_attempts", "a")
      .where("a.id = :id AND a.workspace_id = :workspace", {
        id: change.attempt_id,
        workspace,
      })
      .getRawOne<CostAttemptRow>();
    if (
      !row ||
      row.state !== "terminal" ||
      row.request_id !== change.request_id ||
      row.reservation_id !== change.reservation_id ||
      row.cost_hash !== change.cost_hash ||
      row.error_code !== USAGE_RECOVERY_ERROR ||
      !row.cost_json ||
      pricingContentHash(recoveryDecode(row.cost_json)) !== change.cost_hash ||
      pricingContentHash(change.cost) !== change.cost_hash
    )
      recoveryConflict(
        "Recovered receipt is missing or differs from its audit",
      );
  }
  return { ...result, replayed: true };
}

/** Caller owns the normal database transaction and connected request/attempt locks. */
export async function writeRecoveredUsage(
  manager: EntityManager,
  anchor: string,
  actor: PricingActor,
  input: UsageRecoveryInput,
  basis: UsageRecoveryBasis,
  physicalCost: CostComputation,
  dryRun: boolean,
): Promise<UsageRecoveryResult> {
  if (input.expected_basis_hash !== basis.basis_hash)
    recoveryConflict("Recovery evidence changed; reread and preview again");
  if (physicalCost.batch)
    recoveryConflict(
      "Recover physical usage once, not an already allocated share",
    );
  const allocation = basis.physical
    ? allocateBatchCost(
        basis.physical.batch_id,
        physicalCost,
        basis.physical.members,
      )
    : null;
  const result: UsageRecoveryResult = {
    id: input.id,
    anchor_reservation_id: anchor,
    attempt_id: input.attempt_id,
    basis_hash: basis.basis_hash,
    dry_run: dryRun,
    replayed: false,
    source: "administrator_attestation",
    supplier_confirmed: false,
    budget_changed: false,
    changes: basis.attempts.map((row, index) => {
      const cost = allocation
        ? batchShareCost(allocation, index, basis.physical!.physical_attempt_id)
        : physicalCost;
      return {
        attempt_id: row.id,
        request_id: row.request_id,
        reservation_id: row.reservation_id,
        cost_hash: pricingContentHash(cost),
        cost,
      };
    }),
  };
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > 4 * 1024 * 1024)
    recoveryConflict(
      "Recovered receipt group exceeds the bounded 4 MiB review size",
    );
  if (dryRun) return result;
  for (const change of result.changes) {
    const updated = await manager
      .createQueryBuilder()
      .update("pricing_attempts")
      .set({
        state: "terminal",
        completed_at: new Date().toISOString(),
        cost_json: JSON.stringify(change.cost),
        cost_hash: change.cost_hash,
        error_code: USAGE_RECOVERY_ERROR,
      })
      .where("id = :id AND workspace_id = :workspace AND state = :state", {
        id: change.attempt_id,
        workspace: actor.workspace_id,
        state: "dispatched",
      })
      .execute();
    if (updated.affected !== 1)
      recoveryConflict("Attempt changed while recording recovered evidence");
  }
  await manager
    .createQueryBuilder()
    .insert()
    .into("pricing_audit_events")
    .values({
      id: usageRecoveryAuditId(actor.workspace_id, input.id),
      workspace_id: actor.workspace_id,
      book_id: null,
      actor_id: actor.id,
      action,
      reason: redactErrorText(input.reason, { maxLength: 1000 }),
      created_at: new Date().toISOString(),
      metadata_json: JSON.stringify({
        proposal_hash: usageRecoveryProposalHash(anchor, actor, input),
        result_hash: pricingContentHash(result),
        result,
        evidence_digest: input.evidence_digest ?? null,
      }),
    })
    .execute();
  return result;
}

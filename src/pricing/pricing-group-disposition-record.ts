import { groupOutcomeReceipts } from "./pricing-group-outcome-document";
import { validateBatchShare } from "./cost-allocation";
import type { PricingGroupOutcome } from "./pricing-group-outcome.types";
import type { EntityManager } from "typeorm";
import { pricingContentHash } from "./pricing-json";
import { recoveryConflict, recoveryDecode } from "./pricing-recovery-basis";
import { loadCostAdjustments } from "./cost-adjustments";
import type { CostAttemptRow } from "./cost-ledger.types";
import type {
  GroupDispositionInput,
  GroupDispositionResult,
  GroupDispositionRow,
} from "./pricing-group-disposition.types";

export const GROUP_DISPOSITION_TABLE = "pricing_runtime_group_dispositions";
export const GROUP_DISPOSITION_ACTION = "cost.runtime_group_disposition";
export const groupDispositionAuditId = (workspace: string, id: string) =>
  `group-disposition:${pricingContentHash([workspace, id])}`;
export const groupDispositionSignature = (
  workspace: string,
  actor: string,
  outcome: string,
  input: GroupDispositionInput,
) => pricingContentHash({ workspace, actor, outcome, input });
export const groupDispositionMetadata = (row: GroupDispositionRow) => ({
  outcome_id: row.outcome_id,
  outcome_hash: row.outcome_hash,
  operation_id: row.operation_id,
  proposal_hash: row.proposal_hash,
  result_hash: row.result_hash,
  action: row.action,
});
export async function readGroupDispositionRow(
  manager: EntityManager,
  id: string,
  workspace: string,
): Promise<GroupDispositionRow | null> {
  return (
    (await manager
      .createQueryBuilder()
      .select("d.*")
      .from(GROUP_DISPOSITION_TABLE, "d")
      .where("d.outcome_id = :id AND d.workspace_id = :workspace", {
        id,
        workspace,
      })
      .getRawOne<GroupDispositionRow>()) ?? null
  );
}
export async function verifyGroupDispositionRecord(
  manager: EntityManager,
  row: GroupDispositionRow,
): Promise<GroupDispositionResult> {
  const result = recoveryDecode<GroupDispositionResult>(row.result_json);
  const audit = await manager
    .createQueryBuilder()
    .select(["a.metadata_json AS metadata_json", "a.actor_id AS actor_id"])
    .from("pricing_audit_events", "a")
    .where(
      "a.id = :id AND a.workspace_id = :workspace AND a.action = :action",
      {
        id: row.audit_id,
        workspace: row.workspace_id,
        action: GROUP_DISPOSITION_ACTION,
      },
    )
    .getRawOne<{ metadata_json: string; actor_id: string }>();
  if (
    !audit ||
    audit.actor_id !== row.actor_id ||
    row.audit_id !==
      groupDispositionAuditId(row.workspace_id, row.operation_id) ||
    pricingContentHash(recoveryDecode(audit.metadata_json)) !==
      pricingContentHash(groupDispositionMetadata(row)) ||
    pricingContentHash(result) !== row.result_hash ||
    result.id !== row.operation_id ||
    result.outcome_id !== row.outcome_id ||
    result.outcome_hash !== row.outcome_hash ||
    result.action !== row.action ||
    result.dry_run ||
    result.replayed ||
    !["accept_receipts", "reject_evidence"].includes(row.action) ||
    result.supplier_confirmed !== false ||
    result.outcome_document_modified !== false ||
    result.original_receipts_modified !== false ||
    result.budget_decision_unchanged !== true ||
    !Array.isArray(result.changes) ||
    result.changes.length > 1024
  )
    recoveryConflict("Group disposition record or required audit differs");
  return result;
}
export async function assertGroupOutcomeUndisposed(
  manager: EntityManager,
  id: string,
  workspace: string,
) {
  const row = await readGroupDispositionRow(manager, id, workspace);
  if (row) {
    await verifyGroupDispositionRecord(manager, row);
    recoveryConflict(
      "Retained group already has an immutable operator disposition",
    );
  }
}
/** The ledger verifies the original retained body before using this acknowledgement. */
export async function recordedGroupDisposition(
  manager: EntityManager,
  outcomeId: string,
  workspace: string,
  operationId: string,
  signature?: string,
  retained?: PricingGroupOutcome,
) {
  const row = await readGroupDispositionRow(manager, outcomeId, workspace);
  if (!row) return null;
  if (
    row.operation_id !== operationId ||
    (signature && row.proposal_hash !== signature)
  )
    recoveryConflict("Group disposition operation identity was reused");
  const result = await verifyGroupDispositionRecord(manager, row);
  if (result.action === "reject_evidence" && result.changes.length)
    recoveryConflict("Rejected group disposition contains financial changes");
  const expected = new Map<
    string,
    ReturnType<typeof groupOutcomeReceipts>[number]
  >();
  if (retained)
    for (const receipt of groupOutcomeReceipts(retained)) {
      const prior = expected.get(receipt.attemptId);
      if (
        result.action === "accept_receipts" &&
        prior &&
        (pricingContentHash(prior.cost) !== pricingContentHash(receipt.cost) ||
          prior.errorCode !== receipt.errorCode)
      )
        recoveryConflict(
          "Accepted group body contains conflicting receipt variants",
        );
      expected.set(receipt.attemptId, receipt);
    }
  if (
    result.action === "accept_receipts" &&
    retained &&
    expected.size !== result.changes.length
  )
    recoveryConflict("Acknowledgement omits a retained group receipt");
  const seen = new Set<string>();
  const groups = new Map<string, GroupDispositionResult["changes"]>();
  for (const change of result.changes) {
    if (
      seen.has(change.attempt_id) ||
      pricingContentHash(change.cost) !== change.cost_hash
    )
      recoveryConflict("Group disposition receipt set differs");
    seen.add(change.attempt_id);
    const incoming = expected.get(change.attempt_id);
    if (
      retained &&
      (!incoming ||
        pricingContentHash(incoming.cost) !== change.retained_hash ||
        incoming.errorCode !== change.retained_error)
    )
      recoveryConflict("Acknowledgement differs from retained group evidence");
    if (incoming?.cost.batch) {
      validateBatchShare(change.cost);
      const actual = change.cost.batch,
        selected = incoming.cost.batch;
      if (
        !actual ||
        actual.physical_attempt_id !== selected.physical_attempt_id ||
        actual.batch_id !== selected.batch_id ||
        actual.physical_cost_hash !== selected.physical_cost_hash ||
        actual.member_index !== selected.member_index ||
        pricingContentHash(actual.members) !==
          pricingContentHash(selected.members)
      )
        recoveryConflict(
          "Acknowledged cost does not conserve the selected physical group",
        );
    } else if (incoming && change.cost_hash !== change.retained_hash)
      recoveryConflict(
        "Acknowledged independent cost differs from retained evidence",
      );
    const attempt = await manager
      .createQueryBuilder()
      .select("a.*")
      .from("pricing_attempts", "a")
      .where(
        "a.id = :id AND a.workspace_id = :workspace AND a.request_id = :request AND a.reservation_id = :reservation",
        {
          id: change.attempt_id,
          workspace,
          request: change.request_id,
          reservation: change.reservation_id,
        },
      )
      .getRawOne<CostAttemptRow>();
    const member = await manager
      .createQueryBuilder()
      .select("m.outcome_id", "id")
      .from("pricing_runtime_group_outcome_members", "m")
      .where(
        "m.outcome_id = :outcome AND m.workspace_id = :workspace AND m.request_id = :request AND m.reservation_id = :reservation",
        {
          outcome: outcomeId,
          workspace,
          request: change.request_id,
          reservation: change.reservation_id,
        },
      )
      .getRawOne();
    if (
      !attempt ||
      !member ||
      attempt.state !== "terminal" ||
      !attempt.cost_json ||
      !attempt.cost_hash ||
      pricingContentHash(recoveryDecode(attempt.cost_json)) !==
        attempt.cost_hash ||
      attempt.error_code !== change.recorded_error
    )
      recoveryConflict("Recorded group member or original receipt differs");
    const history =
      (
        await loadCostAdjustments(manager, attempt!.request_id, workspace, [
          attempt!,
        ])
      ).get(attempt!.id) ?? [];
    if (change.operation === "initial_receipt") {
      if (
        attempt!.cost_hash !== change.cost_hash ||
        change.previous_cost_hash !== null ||
        change.adjustment
      )
        recoveryConflict("Group initial receipt acknowledgement differs");
    } else if (change.operation === "already_recorded") {
      if (
        change.adjustment ||
        (attempt!.cost_hash !== change.cost_hash &&
          !history.some((view) => view.cost_hash === change.cost_hash))
      )
        recoveryConflict("Group unchanged receipt acknowledgement differs");
    } else if (change.operation === "linked_correction") {
      const view = history.find((view) => view.id === change.adjustment?.id);
      if (
        !view ||
        view.cost_hash !== change.cost_hash ||
        view.previous_hash !== change.previous_cost_hash ||
        view.application.actor_id !== row.actor_id ||
        view.application.source !== "reconciliation" ||
        view.application.application_hash !==
          change.adjustment?.application.application_hash ||
        pricingContentHash(view) !== pricingContentHash(change.adjustment)
      )
        recoveryConflict("Group linked adjustment acknowledgement differs");
      const a = view!.application;
      const budget = {
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
      if (pricingContentHash(budget) !== pricingContentHash(change.budget))
        recoveryConflict(
          "Group budget acknowledgement differs from its exact application",
        );
      if (view!.cost.batch) {
        const correction = view!.cost.batch.correction;
        if (!correction)
          recoveryConflict(
            "Group adjustment lacks a conserved revision marker",
          );
        const list = groups.get(correction!.id) ?? [];
        list.push(change);
        groups.set(correction!.id, list);
      }
    } else recoveryConflict("Unknown group disposition operation");
  }
  for (const [id, changes] of groups) {
    const first = changes[0],
      batch = first.cost.batch!,
      correction = batch.correction!;
    if (
      changes.length !== batch.members.length ||
      new Set(changes.map((change) => change.cost.batch!.member_index)).size !==
        batch.members.length
    )
      recoveryConflict("Acknowledged correction omits a physical member");
    const audit = await manager
      .createQueryBuilder()
      .select("a.metadata_json", "metadata_json")
      .from("pricing_audit_events", "a")
      .where(
        "a.id = :id AND a.workspace_id = :workspace AND a.action = :action AND a.actor_id = :actor",
        {
          id: `batch-correction:${pricingContentHash([workspace, id])}`,
          workspace,
          action: "cost.batch_adjustment",
          actor: row.actor_id,
        },
      )
      .getRawOne<{ metadata_json: string }>();
    if (!audit)
      recoveryConflict(
        "Acknowledged group correction lacks its required audit",
      );
    const metadata = recoveryDecode<{
      signature: string;
      adjustment_ids: string[];
      revision: number;
    }>(audit!.metadata_json);
    const signature = pricingContentHash({
      id,
      workspace,
      physical: batch.physical_attempt_id,
      expected: correction.previous_physical_cost_hash,
      next: batch.physical_cost_hash,
      actor: row.actor_id,
      source: "reconciliation",
      reason: first.adjustment!.reason,
    });
    const ordered = changes
      .slice()
      .sort((a, b) => a.cost.batch!.member_index - b.cost.batch!.member_index);
    if (
      metadata.signature !== signature ||
      metadata.revision !== correction.revision ||
      pricingContentHash(metadata.adjustment_ids) !==
        pricingContentHash(ordered.map((change) => change.adjustment!.id))
    )
      recoveryConflict("Acknowledged physical audit membership differs");
  }
  return { ...result, replayed: true };
}

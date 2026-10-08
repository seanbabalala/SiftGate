import { actualMediaCustody } from "./actual-media-budget-evidence";
import type { EntityManager } from "typeorm";
import type { CostReservationRow } from "./cost-ledger.types";
import type { PricingTarget } from "./pricing-catalog.types";
import type { ActualRecoveryBasis } from "./actual-upstream-budget-cohort.types";
import type { RuntimeOutcomeRow } from "./pricing-outcome-inbox.types";
import type { GroupOutcomeRow } from "./pricing-group-outcome.types";
import { readActualBudgetEvidence } from "./actual-upstream-budget-evidence";
import { actualBudgetClosure, actualBudgetCohortIdentity, readActualBudgetCohort, type ActualBudgetCohortRow, type ActualBudgetStoredClosure } from "./actual-upstream-budget-cohort";
import { planActualUpstreamBudget } from "./actual-upstream-budget";
import { PricingRepository } from "./pricing-repository";
import { PricingRepositoryError } from "./pricing-repository.types";
import { pricingContentHash } from "./pricing-json";
import { verifyRuntimeOutcome } from "./pricing-outcome-inbox";
import { readDispositionRow, verifyDispositionRecord } from "./pricing-outcome-disposition";
import { verifyRuntimeGroupOutcome } from "./pricing-group-outcome-inbox";
import { readGroupDispositionRow, verifyGroupDispositionRecord } from "./pricing-group-disposition-record";

const conflict = (message: string): never => { throw new PricingRepositoryError("pricing_version_conflict", message, 409); };

/** Read custody before settling, not just before the human preview. Poll timestamps are excluded from CAS. */
export async function actualBudgetCustody(manager: EntityManager, row: CostReservationRow, deliveringId?: string) {
  const scope = { id: row.id, workspace: row.workspace_id };
  const bytes = (column: string) => manager.connection.options.type === "postgres" ? `OCTET_LENGTH(${column})` : `LENGTH(CAST(${column} AS BLOB))`;
  const select = () => manager.createQueryBuilder().from("pricing_runtime_outcomes", "o")
    .where("o.reservation_id = :id AND o.workspace_id = :workspace", scope);
  const size = await select().select("COUNT(*)", "count").addSelect(`SUM(${bytes("o.outcome_json")})`, "bytes").getRawOne<{ count: string; bytes: string }>();
  if (Number(size?.count ?? 0) > 2048 || Number(size?.bytes ?? 0) > 16 * 1024 * 1024) conflict("Actual recovery custody exceeds its bounded inspection");
  const rows = await select().select("o.*").orderBy("o.id", "ASC").getRawMany<RuntimeOutcomeRow>();
  const signatures: unknown[] = [], pending = new Set<string>();
  let missingDispatch = false;
  for (const item of rows) {
    const outcome = await verifyRuntimeOutcome(manager, item);
    if (item.request_id !== row.request_id || item.reservation_id !== row.id) conflict("Actual recovery custody scope differs");
    const disposition = await readDispositionRow(manager, item.id, row.workspace_id);
    if (disposition) {
      await verifyDispositionRecord(manager, disposition);
      if (disposition.outcome_hash !== item.outcome_hash || disposition.request_id !== row.request_id) conflict("Actual recovery disposition identity differs");
    }
    signatures.push([item.id, item.outcome_hash, item.state, disposition?.result_hash ?? null]);
    if (outcome.type === "actual_budget_closure" && outcome.payload.missing_dispatch_evidence) missingDispatch = true;
    if (item.id !== deliveringId && item.state !== "delivered" && !disposition) pending.add("runtime_custody");
  }
  // The caller's request lock fences every cooperating full-group writer. Verify
  // siblings without taking new out-of-order locks during single-hold recovery.
  const groups = () => manager.createQueryBuilder().from("pricing_runtime_group_outcomes", "g")
    .innerJoin("pricing_runtime_group_outcome_members", "m", "m.outcome_id = g.id AND m.workspace_id = g.workspace_id")
    .where("m.reservation_id = :id AND m.workspace_id = :workspace", scope);
  const groupSize = await groups().select("COUNT(*)", "count").addSelect(`SUM(${bytes("g.document_json")})`, "bytes").getRawOne<{ count: string; bytes: string }>();
  if (Number(groupSize?.count ?? 0) > 2048 || Number(groupSize?.bytes ?? 0) > 16 * 1024 * 1024) conflict("Actual recovery group custody exceeds its bounded inspection");
  for (const group of await groups().select("g.*").orderBy("g.id", "ASC").getRawMany<GroupOutcomeRow>()) {
    const verified = await verifyRuntimeGroupOutcome(manager, group, false);
    const document = verified.document;
    if (!verified.members.some(member => member.reservation_id === row.id && member.request_id === row.request_id)) conflict("Actual recovery group custody scope differs");
    const disposition = await readGroupDispositionRow(manager, group.id, row.workspace_id);
    if (disposition) {
      await verifyGroupDispositionRecord(manager, disposition);
      if (disposition.outcome_hash !== group.document_hash) conflict("Actual recovery group disposition identity differs");
    }
    signatures.push([group.id, group.document_hash, group.members_hash, group.state, disposition?.result_hash ?? null]);
    if (document.outcome.type === "actual_budget_closure_group" && document.outcome.entries.some(entry => entry.reservationId === row.id && entry.payload.missing_dispatch_evidence)) missingDispatch = true;
    if (group.id !== deliveringId && !disposition && (group.state !== "delivered" || verified.review)) pending.add("runtime_group_custody");
  }
  const media = await actualMediaCustody(manager, { reservation_id: row.id, workspace_id: row.workspace_id, request_id: row.request_id });
  if (media.hasTasks) signatures.push(["media", media.signature]);
  if (media.pending) pending.add("media_custody");
  return { signature: pricingContentHash(signatures), pending: [...pending].sort(), missingDispatch };
}

/** Original policy and every attempt are server-owned; no winner/quantity/money override is accepted. */
export async function readActualRecoveryBasis(manager: EntityManager, row: CostReservationRow): Promise<ActualRecoveryBasis> {
  const cohort = await readActualBudgetCohort(manager, row.id, row.workspace_id);
  const snapshot = await new PricingRepository(manager.connection).restoreRequestInTransaction(manager, row.request_id, row.workspace_id);
  const policy = snapshot.admissionPolicy((JSON.parse(row.target_json) as PricingTarget).operation);
  if (row.budget_basis !== "actual_upstream" || policy.budget_basis !== "actual_upstream") conflict("Original policy does not authorize actual expense recovery");
  const identity = { reservation_id: row.id, workspace_id: row.workspace_id, request_id: row.request_id, catalog_revision_id: snapshot.descriptor().catalog_revision_id, policy_hash: pricingContentHash(policy) };
  const evidence = await readActualBudgetEvidence(manager, row);
  const ids = evidence.records.map(attempt => attempt.id);
  const custody = await actualBudgetCustody(manager, row);
  const closure: ActualBudgetStoredClosure = cohort ? actualBudgetClosure(cohort) : {
    attempt_ids: ids, missing_dispatch_evidence: custody.missingDispatch,
    receipts: evidence.records.filter(attempt => attempt.state === "terminal" && attempt.cost_json).map(attempt => ({ attemptId: attempt.id, cost: JSON.parse(attempt.cost_json!), errorCode: attempt.error_code })),
  };
  if (cohort && (cohort.applied_plan_json || cohort.state === "applied" || cohort.closure_hash !== pricingContentHash(actualBudgetCohortIdentity(identity, closure)) || pricingContentHash(ids) !== pricingContentHash(closure.attempt_ids)))
    conflict("Actual recovery closure differs from its original policy or complete population");
  const plan = planActualUpstreamBudget({ workspace_id: row.workspace_id, request_id: row.request_id, reservation_id: row.id, dispatch_complete: true, require_upstream_tokens: evidence.requireTokens }, evidence.effective);
  const pending = [...custody.pending];
  if (closure.missing_dispatch_evidence || custody.missingDispatch) pending.push("missing_dispatch_evidence");
  if (plan.state !== "ready") pending.push("evidence_incomplete");
  return { cohort, closure, identity, plan, pending, custody_hash: custody.signature };
}

export function operatorActualBudgetCohort(basis: ActualRecoveryBasis, resolutionId: string): ActualBudgetCohortRow {
  if (basis.cohort) return basis.cohort;
  const closure: ActualBudgetStoredClosure = { ...basis.closure, operator_authority: { resolution_id: resolutionId, audit_id: `recovery-resolution:${pricingContentHash([basis.identity.workspace_id, resolutionId])}` } };
  const now = new Date().toISOString();
  return { ...basis.identity, closure_hash: pricingContentHash(actualBudgetCohortIdentity(basis.identity, closure)), closure_json: JSON.stringify(closure), state: "pending", created_at: now, updated_at: now, applied_plan_json: null, applied_plan_hash: null, last_error_code: null };
}

/** Pending operator fences must be visible even when there were no dispatched attempt rows. */
export async function recordPendingActualRecovery(manager: EntityManager, row: CostReservationRow, cohort: ActualBudgetCohortRow, pending: string[]): Promise<void> {
  const scope = { id: row.id, workspace: row.workspace_id };
  const prior = await manager.createQueryBuilder().select("c.reservation_id").from("pricing_recovery_cases", "c")
    .where("c.reservation_id = :id AND c.workspace_id = :workspace", scope).getRawOne();
  if (prior) return;
  const now = new Date().toISOString();
  const evidence = { version: 1, request_id: row.request_id, reservation_id: row.id, budget_basis: "actual_upstream", closure_hash: cohort.closure_hash, pending_reasons: pending };
  await manager.createQueryBuilder().insert().into("pricing_recovery_cases").values({ reservation_id: row.id, workspace_id: row.workspace_id, request_id: row.request_id,
    state: "open", reason: pending.includes("missing_dispatch_evidence") || pending.includes("evidence_incomplete") ? "attempt_outcome_unknown" : "settlement_decision_missing",
    revision: 1, evidence_json: JSON.stringify(evidence), evidence_hash: pricingContentHash(evidence), created_at: now, updated_at: now, checked_at: now, resolved_at: null, resolution_code: null,
  }).execute();
}

import type { EntityManager } from "typeorm";
import type { CostReservationRow, CostSettlementPayload } from "./cost-ledger.types";
import type { ActualBudgetAttempt, ActualUpstreamBudgetPlan } from "./actual-upstream-budget.types";
import type { CostComputation } from "./pricing.types";
import type { PricingTarget } from "./pricing-catalog.types";
import { readActualBudgetCohort, type ActualBudgetClosurePayload } from "./actual-upstream-budget-cohort";
import { readActualBudgetEvidence } from "./actual-upstream-budget-evidence";
import { planActualUpstreamBudget, planActualBudgetAdjustment } from "./actual-upstream-budget";
import { PricingRepository } from "./pricing-repository";
import { PricingRepositoryError } from "./pricing-repository.types";
import { pricingContentHash } from "./pricing-json";
import { ExactDecimal } from "./exact-decimal";

const conflict = (message: string): never => { throw new PricingRepositoryError("pricing_version_conflict", message, 409); };
const appliedStates = new Set(["applied", "applied_cost_only"]);

/** Reconstruct budget-accepted evidence separately from the latest (possibly estimated) report. */
export async function actualBudgetAdjustmentBasis(manager: EntityManager, reservation: CostReservationRow) {
  if (!manager.queryRunner?.isTransactionActive || reservation.budget_basis !== "actual_upstream") conflict("Actual budget correction requires its owned transaction and original policy");
  const cohort = await readActualBudgetCohort(manager, reservation.id, reservation.workspace_id);
  if (!cohort || cohort.state === "review_required") return conflict("Actual budget correction requires a retained, non-quarantined closed cohort");
  const closure = JSON.parse(cohort.closure_json) as ActualBudgetClosurePayload;
  if (closure.missing_dispatch_evidence) conflict("Missing dispatch evidence must be resolved before expense correction");
  const snapshot = await new PricingRepository(manager.connection).restoreRequestInTransaction(manager, reservation.request_id, reservation.workspace_id);
  const policy = snapshot.admissionPolicy((JSON.parse(reservation.target_json) as PricingTarget).operation);
  if (policy.budget_basis !== "actual_upstream" || pricingContentHash(policy) !== cohort.policy_hash || snapshot.descriptor().catalog_revision_id !== cohort.catalog_revision_id)
    conflict("Actual correction differs from the immutable admission policy");
  const evidence = await readActualBudgetEvidence(manager, reservation);
  if (pricingContentHash(evidence.records.map(row => row.id)) !== pricingContentHash(closure.attempt_ids)) conflict("Closed correction cohort membership differs");
  const scope = { workspace_id: reservation.workspace_id, request_id: reservation.request_id, reservation_id: reservation.id, dispatch_complete: true, require_upstream_tokens: evidence.requireTokens };
  const effective = planActualUpstreamBudget(scope, evidence.effective);
  const baseRevisions = new Map<string, number>();
  let base: ActualUpstreamBudgetPlan | null = null, applied: ActualUpstreamBudgetPlan | null = null;
  let charged = evidence.effective;
  if (cohort.state === "applied") {
    const stored = JSON.parse(cohort.applied_plan_json!) as ActualUpstreamBudgetPlan;
    const anchors: ActualBudgetAttempt[] = evidence.records.map(record => {
      const contribution = stored.contributions.find(row => row.attempt_id === record.id);
      if (!contribution) return conflict("Original applied plan lost a cohort member");
      const history = evidence.history.get(record.id) ?? [];
      const anchor = history.find(view => view.cost_hash === contribution.cost_hash);
      const cost = record.cost_hash === contribution.cost_hash && record.cost_json
        ? JSON.parse(record.cost_json) as CostComputation : anchor?.cost;
      if (!cost) return conflict("The original applied cost is missing from immutable receipt history");
      baseRevisions.set(record.id, record.cost_hash === contribution.cost_hash ? 0 : anchor!.application.revision);
      return { id: record.id, request_id: record.request_id, workspace_id: record.workspace_id, reservation_id: record.reservation_id, state: record.state, fee_source: record.fee_source, error_code: record.error_code, cost, cost_hash: contribution.cost_hash };
    });
    base = planActualUpstreamBudget(scope, anchors);
    if (base.state !== "ready" || base.plan_hash !== stored.plan_hash) conflict("The original applied cohort cannot be reproduced");
    const intent = await manager.createQueryBuilder().select("i.*").from("pricing_settlement_intents", "i")
      .where("i.reservation_id = :id AND i.workspace_id = :workspace", { id: reservation.id, workspace: reservation.workspace_id })
      .getRawOne<{ request_id: string; state: string; payload_hash: string; payload_json: string }>();
    if (!intent || intent.request_id !== reservation.request_id || intent.state !== "applied") conflict("Applied actual correction is missing its initial intent");
    const payload = JSON.parse(intent!.payload_json) as CostSettlementPayload;
    if (pricingContentHash(payload) !== intent!.payload_hash || payload.budget_basis !== "actual_upstream" || payload.kind !== base.terminal_kind || payload.cost_usd !== base.cost_usd || payload.tokens !== (base.upstream_tokens ?? "0") || reservation.committed_cost_usd !== payload.cost_usd || reservation.committed_tokens !== payload.tokens || reservation.state !== (payload.kind === "commit" ? "committed" : "released"))
      conflict("Original actual budget effect differs from its pinned cohort");
    charged = anchors.map(anchor => {
      const last = (evidence.history.get(anchor.id) ?? []).filter(view => view.application.revision > baseRevisions.get(anchor.id)! && appliedStates.has(view.application.budget_state)).at(-1);
      return last ? { ...anchor, cost: last.cost, cost_hash: last.cost_hash } : anchor;
    });
    applied = planActualUpstreamBudget(scope, charged);
    const delta = planActualBudgetAdjustment(base, applied);
    let costDelta = ExactDecimal.zero, tokenDelta = ExactDecimal.zero;
    for (const [id, history] of evidence.history) for (const view of history) {
      const app = view.application;
      if (app.revision <= baseRevisions.get(id)! || !appliedStates.has(app.budget_state)) continue;
      if (app.reservation_id !== reservation.id || app.budget_cost_before === null || app.budget_cost_after === null || app.budget_tokens_before === null || app.budget_tokens_after === null ||
        ExactDecimal.parse(app.budget_cost_after).subtract(ExactDecimal.parse(app.budget_cost_before)).toFixed(18) !== app.cost_delta ||
        ExactDecimal.parse(app.budget_tokens_after).subtract(ExactDecimal.parse(app.budget_tokens_before)).toFixed(0) !== app.tokens_delta)
        conflict("Actual adjustment amounts differ from their immutable application");
      costDelta = costDelta.add(ExactDecimal.parse(app.cost_delta)); tokenDelta = tokenDelta.add(ExactDecimal.parse(app.tokens_delta));
    }
    if (delta.state !== "ready" || delta.cost_delta_usd !== costDelta.toFixed(18) || (delta.tokens_delta ?? "0") !== tokenDelta.toFixed(0))
      conflict("Applied actual correction history does not conserve the complete cohort");
  } else if (reservation.state !== "reserved" || cohort.applied_plan_json) conflict("Pending actual cohort is inconsistent with its reservation");
  const basis_hash = pricingContentHash({ closure: cohort.closure_hash, base: base?.plan_hash ?? null, applied: applied?.plan_hash ?? null, effective: effective.plan_hash,
    history: [...evidence.history].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([id, views]) => [id, views.map(view => [view.id, view.cost_hash, view.application.application_hash])]) });
  return { cohort, scope, evidence, base, applied, charged, effective, baseRevisions, basis_hash };
}

export function actualCorrectionPlan(basis: Awaited<ReturnType<typeof actualBudgetAdjustmentBasis>>, attemptId: string, cost: CostComputation) {
  if (!basis.charged.some(row => row.id === attemptId)) conflict("Correction is outside the closed cohort");
  const next = planActualUpstreamBudget(basis.scope, basis.charged.map(row => row.id === attemptId ? { ...row, cost, cost_hash: pricingContentHash(cost) } : row));
  return { next, delta: basis.applied ? planActualBudgetAdjustment(basis.applied, next) : null };
}

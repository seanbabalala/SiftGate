import { readCostAdjustmentHistory } from "./cost-adjustment-history";
import { actualBudgetAdjustmentBasis, actualCorrectionPlan } from "./actual-upstream-budget-adjustments";
import type { EntityManager } from "typeorm";
import type { BudgetService } from "../budget/budget.service";
import type {
  BudgetLedgerHold,
  BudgetLedgerIdentity,
  BudgetLedgerPreview,
} from "../budget/budget-ledger.types";
import type {
  CostAttemptRow,
  CostReservationRow,
  CostSettlementIntentRow,
  CostSettlementPayload,
} from "./cost-ledger.types";
import type {
  CostAdjustmentInput,
  CostAdjustmentRow,
  CostAdjustmentApplication,
  CostAdjustmentView,
} from "./cost-adjustment.types";
import { ExactDecimal } from "./exact-decimal";
import { pricingContentHash } from "./pricing-json";
import { PricingRepositoryError } from "./pricing-repository.types";
import { parsePricingInstant } from "./pricing-time";

function conflict(message: string): never {
  throw new PricingRepositoryError("pricing_version_conflict", message, 409);
}

/** Backwards-compatible reader export; verification lives in the shared history module. */
export function loadCostAdjustments(...args: Parameters<typeof readCostAdjustmentHistory>) {
  return readCostAdjustmentHistory(...args);
}

/** Caller holds the request, reservation and attempt locks, in that order. */
export async function appendCostAdjustment(
  manager: EntityManager,
  budgets: BudgetService,
  input: CostAdjustmentInput,
  attempt: CostAttemptRow,
  reservation: CostReservationRow | null,
  intent: CostSettlementIntentRow | null,
  options: {
    dryRun?: boolean;
    allowUnsettled?: boolean;
    budgetPreview?: BudgetLedgerPreview;
  } = {},
): Promise<{ view: CostAdjustmentView; created: boolean }> {
  const actual = reservation?.budget_basis === "actual_upstream" ? await actualBudgetAdjustmentBasis(manager, reservation) : null;
  if (attempt.state !== "terminal" || !attempt.cost_json || !attempt.cost_hash)
    conflict("Only a recorded terminal receipt can be adjusted");
  if (reservation?.state === "reserved" && !options.allowUnsettled && !actual)
    conflict(
      "Apply the original terminal settlement before recording its correction",
    );
  if (
    reservation?.state === "reserved" &&
    !actual &&
    options.allowUnsettled &&
    (intent ||
      reservation.job_id ||
      parsePricingInstant(reservation.lease_until) > Date.now() ||
      attempt.fee_source !== "provider")
  )
    conflict(
      "An unsettled cost-only correction cannot override a live owner, job or immutable intent",
    );
  const history = actual ? actual.evidence.history.get(attempt.id) ?? [] :
    (
      await loadCostAdjustments(manager, attempt.request_id, input.workspace, [
        attempt,
      ])
    ).get(attempt.id) ?? [];
  const hash = pricingContentHash(input.cost);
  const prior = history.find((view) => view.id === input.id);
  if (prior) {
    if (
      prior.previous_hash !== input.expectedCostHash ||
      prior.cost_hash !== hash ||
      prior.reason !== input.reason ||
      prior.application.actor_id !== input.actorId ||
      prior.application.source !== input.source
    )
      conflict(
        "Adjustment idempotency identity was reused with different evidence",
      );
    return { view: prior, created: false };
  }
  const original = JSON.parse(attempt.cost_json) as CostAdjustmentView["cost"];
  if (pricingContentHash(original) !== attempt.cost_hash)
    conflict("Original cost receipt integrity check failed");
  const currentHash = history.at(-1)?.cost_hash ?? attempt.cost_hash;
  if (input.expectedCostHash !== currentHash)
    conflict("Adjustment must compare against the latest effective cost hash");
  if (hash === currentHash)
    conflict("New adjustment must supply changed evidence");
  if (
    (original.version_id !== null || actual) &&
    (input.cost.book_id !== original.book_id ||
      input.cost.version_id !== original.version_id ||
      input.cost.content_hash !== original.content_hash ||
      input.cost.currency !== original.currency ||
      input.cost.fx_version_id !== original.fx_version_id)
  )
    conflict("Usage correction cannot replace the frozen price or FX version");
  const now = new Date().toISOString();
  const row: CostAdjustmentRow = {
    id: input.id,
    workspace_id: input.workspace,
    attempt_id: input.attemptId,
    previous_hash: currentHash,
    cost_hash: hash,
    cost_json: JSON.stringify(input.cost),
    reason: input.reason,
    created_at: now,
  };
  const application: CostAdjustmentApplication = {
    adjustment_id: input.id,
    workspace_id: input.workspace,
    request_id: attempt.request_id,
    attempt_id: attempt.id,
    reservation_id: reservation?.id ?? null,
    revision: history.length + 1,
    actor_id: input.actorId,
    source: input.source,
    budget_state: "not_applicable",
    application_hash: "",
    budget_cost_before: null,
    budget_cost_after: null,
    budget_tokens_before: null,
    budget_tokens_after: null,
    cost_delta: "0.000000000000000000",
    tokens_delta: "0",
    allocations_json: "[]",
    created_at: now,
  };
  let allocations: BudgetLedgerHold[] = [];
  if (actual && reservation) {
    const { next, delta } = actualCorrectionPlan(actual, attempt.id, input.cost);
    application.budget_state = "pending";
    if (actual.applied) {
      application.budget_cost_before = actual.applied.cost_usd;
      application.budget_tokens_before = actual.applied.upstream_tokens ?? "0";
      application.budget_cost_after = application.budget_cost_before;
      application.budget_tokens_after = application.budget_tokens_before;
      if (delta?.state === "ready") {
        application.budget_cost_after = next.cost_usd;
        application.budget_tokens_after = next.upstream_tokens ?? application.budget_tokens_before;
        application.cost_delta = delta.cost_delta_usd!;
        application.tokens_delta = delta.tokens_delta ?? "0";
        const effect = await manager.createQueryBuilder().select("e.allocations_json", "allocations_json").from("pricing_budget_effects", "e")
          .where("e.id = :id AND e.workspace_id = :workspace AND e.kind = :kind", { id: `${reservation.id}:commit`, workspace: input.workspace, kind: "commit" })
          .getRawOne<{ allocations_json: string }>();
        if (!effect) conflict("Original actual budget allocation is missing");
        allocations = await budgets.adjustLedger(manager, JSON.parse(reservation.identity_json) as BudgetLedgerIdentity, JSON.parse(effect!.allocations_json) as BudgetLedgerHold[], application.tokens_delta, application.cost_delta, options.dryRun, options.budgetPreview);
        application.allocations_json = JSON.stringify(allocations);
        application.budget_state = delta.tokens_delta === null ? "applied_cost_only" : "applied";
      }
    }
  } else if (reservation?.state === "committed") {
    const payload = intent
      ? (JSON.parse(intent.payload_json) as CostSettlementPayload)
      : null;
    if (payload && pricingContentHash(payload) !== intent!.payload_hash)
      conflict("Original settlement intent integrity check failed");
    // New batch intents explicitly name the logical winner. Older batch intents
    // can be resolved only when exactly one successful batch receipt exists.
    const receipts = [
      ...(payload?.receipts ?? []),
      ...(payload?.receipt ? [payload.receipt] : []),
    ];
    let winner = payload?.budget_attempt_id ?? payload?.receipt?.attemptId;
    if (
      payload?.budget_attempt_id &&
      !receipts.some((entry) => entry.attemptId === payload.budget_attempt_id)
    )
      conflict("Logical budget winner is not included in the settlement");
    if (!winner && payload) {
      const candidates = receipts.filter(
        (entry) => entry.cost.batch && !entry.errorCode,
      );
      if (candidates.length === 1) winner = candidates[0].attemptId;
    }
    if (!winner) application.budget_state = "pending";
    else if (winner === attempt.id) {
      const previous = [...history]
        .reverse()
        .find((view) =>
          ["applied", "applied_cost_only"].includes(
            view.application.budget_state,
          ),
        )?.application;
      application.budget_cost_before =
        previous?.budget_cost_after ?? reservation.committed_cost_usd;
      application.budget_tokens_before =
        previous?.budget_tokens_after ?? reservation.committed_tokens;
      application.budget_cost_after = application.budget_cost_before;
      application.budget_tokens_after = application.budget_tokens_before;
      if (input.cost.report_amount === null)
        application.budget_state = "pending";
      else {
        application.budget_cost_after = ExactDecimal.parse(
          input.cost.report_amount,
        ).toFixed(18);
        const inTokens = input.cost.usage.quantities.total_input_tokens?.value;
        const outTokens = input.cost.usage.quantities.output_tokens?.value;
        const knownTokens =
          inTokens !== undefined &&
          inTokens !== null &&
          outTokens !== undefined &&
          outTokens !== null;
        if (knownTokens)
          application.budget_tokens_after = ExactDecimal.parse(inTokens)
            .add(ExactDecimal.parse(outTokens))
            .toFixed(0);
        application.cost_delta = ExactDecimal.parse(
          application.budget_cost_after,
        )
          .subtract(ExactDecimal.parse(application.budget_cost_before))
          .toFixed(18);
        application.tokens_delta = ExactDecimal.parse(
          application.budget_tokens_after,
        )
          .subtract(ExactDecimal.parse(application.budget_tokens_before))
          .toFixed(0);
        const effect = await manager
          .createQueryBuilder()
          .select("e.allocations_json", "allocations_json")
          .from("pricing_budget_effects", "e")
          .where(
            "e.id = :id AND e.workspace_id = :workspace AND e.kind = :kind",
            {
              id: `${reservation.id}:commit`,
              workspace: input.workspace,
              kind: "commit",
            },
          )
          .getRawOne<{ allocations_json: string }>();
        if (!effect) conflict("Original budget allocation is missing");
        allocations = await budgets.adjustLedger(
          manager,
          JSON.parse(reservation.identity_json) as BudgetLedgerIdentity,
          JSON.parse(effect!.allocations_json) as BudgetLedgerHold[],
          application.tokens_delta,
          application.cost_delta,
          options.dryRun,
          options.budgetPreview,
        );
        application.allocations_json = JSON.stringify(allocations);
        application.budget_state = knownTokens
          ? "applied"
          : "applied_cost_only";
      }
    }
  }
  const { application_hash: _hash, ...applicationBody } = application;
  application.application_hash = pricingContentHash({
    row,
    application: applicationBody,
  });
  if (!options.dryRun)
    await manager
      .createQueryBuilder()
      .insert()
      .into("pricing_cost_adjustments")
      .values(row)
      .execute();
  if (!options.dryRun)
    await manager
      .createQueryBuilder()
      .insert()
      .into("pricing_adjustment_applications")
      .values(application)
      .execute();
  const { cost_json: _raw, ...metadata } = row;
  const { allocations_json: _allocations, ...effect } = application;
  return {
    view: {
      ...metadata,
      cost: input.cost,
      application: { ...effect, allocations },
    },
    created: !options.dryRun,
  };
}

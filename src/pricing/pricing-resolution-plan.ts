import type { CostSettlementPayload } from "./cost-ledger.types";
import type {
  LockedRecoveryBasis,
  RecoveryResolutionInput,
  RecoveryResolutionPlan,
} from "./pricing-resolution.types";
import { ExactDecimal } from "./exact-decimal";
import { recoveryConflict, recoveryDecode } from "./pricing-recovery-basis";
import { pricingContentHash } from "./pricing-json";
import { operatorActualBudgetCohort } from "./actual-upstream-budget-recovery";

function integral(value: string): string {
  const parsed = ExactDecimal.parse(value);
  if (
    parsed.compare(ExactDecimal.zero) < 0 ||
    parsed.compare(ExactDecimal.parse(parsed.toFixed(0))) !== 0
  )
    recoveryConflict("Logical token usage must be a nonnegative integer");
  return parsed.toFixed(0);
}
/** This plan resolves internal budget holds only. No new supplier usage is invented. */
export function buildRecoveryResolution(
  basis: LockedRecoveryBasis,
  input: RecoveryResolutionInput,
  dryRun: boolean,
): RecoveryResolutionPlan {
  if (input.expected_basis_hash !== basis.view.basis_hash)
    recoveryConflict(
      "Recovery evidence, lease or physical membership changed; reread and preview again",
    );
  const pending = basis.reservations.filter((row) => row.state === "reserved");
  if (!pending.length)
    recoveryConflict(
      "No unresolved budget holds remain in this recovery group",
    );
  const decisions = new Map(
    input.decisions.map((decision) => [decision.reservation_id, decision]),
  );
  if (
    decisions.size !== input.decisions.length ||
    decisions.size !== pending.length ||
    pending.some((row) => !decisions.has(row.id))
  )
    recoveryConflict(
      "Supply exactly one decision for every unresolved hold in the complete recovery group",
    );
  const blocked = basis.view.reservations.find(
    (row) => row.state === "reserved" && row.blocked_reason,
  );
  if (blocked)
    recoveryConflict(
      `Recovery group is still owned by ${blocked.blocked_reason}`,
    );
  const payloads: RecoveryResolutionPlan["payloads"] = [];
  const changes: RecoveryResolutionPlan["result"]["changes"] = [];
  const actual: NonNullable<RecoveryResolutionPlan["actual"]> = [];
  for (const row of pending) {
    const decision = decisions.get(row.id)!;
    if (row.budget_basis === "actual_upstream") {
      if (decision.action !== "reconcile_actual" || decision.budget_attempt_id !== undefined || decision.logical_tokens !== undefined)
        recoveryConflict("Actual recovery derives every paid attempt; a logical winner or manual debit is forbidden");
      const evidence = basis.actual?.get(row.id);
      if (!evidence) recoveryConflict("Complete actual recovery evidence is required");
      const cohort = operatorActualBudgetCohort(evidence, input.id), ready = evidence.pending.length === 0;
      if (ready && (evidence.plan.cost_usd === null || !evidence.plan.terminal_kind)) recoveryConflict("Actual recovery plan is incomplete");
      actual.push({ reservation: row, cohort });
      changes.push({ reservation_id: row.id, action: decision.action, previous_state: row.state,
        next_state: ready ? evidence.plan.terminal_kind === "commit" ? "committed" : "released" : "reserved",
        budget_tokens: ready ? evidence.plan.upstream_tokens ?? "0" : "0", budget_cost_usd: ready ? evidence.plan.cost_usd! : "0.000000000000000000",
        budget_attempt_id: null, reserved_cost_usd: row.reserved_cost_usd, current_balance_refund_not_guaranteed: true,
        actual_closure_hash: cohort.closure_hash, pending_reasons: evidence.pending,
      });
      continue;
    }
    if (decision.action === "reconcile_actual") recoveryConflict("Actual reconciliation is not authorized by this hold's original budget basis");
    const recorded = basis.intents.get(row.id);
    const own = basis.attempts.filter(
      (attempt) => attempt.row.reservation_id === row.id,
    );
    let payload: CostSettlementPayload;
    if (recorded) {
      if (
        decision.action !== "apply_recorded" ||
        decision.budget_attempt_id !== undefined ||
        decision.logical_tokens !== undefined
      )
        recoveryConflict(
          "An existing immutable intent can only be applied, never replaced",
        );
      payload = recoveryDecode<CostSettlementPayload>(recorded.payload_json);
      if (pricingContentHash(payload) !== recorded.payload_hash)
        recoveryConflict("Recorded terminal intent was altered");
    } else {
      if (decision.action === "apply_recorded")
        recoveryConflict("No recorded terminal intent exists");
      const receipts = own
        .filter(
          (attempt) =>
            attempt.row.state === "terminal" && attempt.row.cost_json,
        )
        .map((attempt) => ({
          attemptId: attempt.row.id,
          cost: recoveryDecode<
            NonNullable<CostSettlementPayload["receipt"]>["cost"]
          >(attempt.row.cost_json!),
          errorCode: attempt.row.error_code,
        }));
      if (decision.action === "release") {
        if (
          decision.budget_attempt_id !== undefined ||
          decision.logical_tokens !== undefined
        )
          recoveryConflict(
            "A release cannot declare a logical winner or debit",
          );
        payload = {
          kind: "release",
          tokens: "0",
          cost_usd: "0.000000000000000000",
          budget_basis: "operator_recovery_release",
          receipt: null,
          ...(receipts.length ? { receipts } : {}),
        };
      } else {
        const winner = own.find(
          (attempt) => attempt.row.id === decision.budget_attempt_id,
        );
        if (
          decision.action !== "commit" ||
          !winner ||
          winner.row.state !== "terminal" ||
          !winner.cost ||
          winner.cost.report_amount === null
        )
          recoveryConflict(
            "A commit requires a recorded, priced winner for this unresolved hold; unknown supplier cost cannot be guessed",
          );
        // A cache hit's upstream receipt is zero, but the preserved logical budget is not.
        const logical =
          winner.row.fee_source === "local_cache" &&
          row.budget_basis === "legacy_logical_cache"
            ? recoveryDecode<
                NonNullable<CostSettlementPayload["receipt"]>["cost"]
              >(row.estimate_json)
            : winner.cost;
        if (logical.report_amount === null)
          recoveryConflict(
            "The original logical cache estimate is unavailable",
          );
        const amount = ExactDecimal.parse(logical.report_amount);
        if (amount.compare(ExactDecimal.zero) < 0)
          recoveryConflict("A recovery debit cannot be negative");
        const inputTokens =
          winner.cost.usage.quantities.total_input_tokens?.value;
        const outputTokens = winner.cost.usage.quantities.output_tokens?.value;
        let tokens: string;
        if (inputTokens != null && outputTokens != null) {
          tokens = integral(
            ExactDecimal.parse(inputTokens)
              .add(ExactDecimal.parse(outputTokens))
              .toFixed(18),
          );
          if (
            decision.logical_tokens !== undefined &&
            integral(decision.logical_tokens) !== tokens
          )
            recoveryConflict(
              "Explicit logical tokens differ from the immutable receipt",
            );
        } else {
          if (decision.logical_tokens === undefined)
            recoveryConflict(
              "The receipt lacks logical token totals; an explicit internal token attestation is required",
            );
          tokens = integral(decision.logical_tokens);
        }
        payload = {
          kind: "commit",
          tokens,
          cost_usd: amount.toFixed(18),
          budget_basis:
            winner.row.fee_source === "local_cache"
              ? "operator_recovery_legacy_logical_cache"
              : decision.logical_tokens !== undefined &&
                  (inputTokens == null || outputTokens == null)
                ? "operator_recovery_attested_logical_tokens"
                : "operator_recovery_legacy_logical",
          receipt: null,
          receipts,
          budget_attempt_id: winner.row.id,
        };
      }
    }
    if (!["commit", "release"].includes(payload.kind))
      recoveryConflict("Recorded terminal intent has an invalid kind");
    const tokens = integral(payload.tokens),
      amount = ExactDecimal.parse(payload.cost_usd);
    if (
      amount.compare(ExactDecimal.zero) < 0 ||
      (payload.kind === "release" &&
        (tokens !== "0" || amount.compare(ExactDecimal.zero) !== 0))
    )
      recoveryConflict("Recorded terminal intent has an invalid debit");
    const receipts = [
      ...(payload.receipts ?? []),
      ...(payload.receipt ? [payload.receipt] : []),
    ];
    if (
      new Set(receipts.map((entry) => entry.attemptId)).size !== receipts.length
    )
      recoveryConflict("Duplicate recovery receipt");
    for (const receipt of receipts) {
      const attempt = own.find((entry) => entry.row.id === receipt.attemptId);
      if (
        !attempt ||
        (attempt.row.state === "terminal" &&
          (attempt.row.cost_hash !== pricingContentHash(receipt.cost) ||
            attempt.row.error_code !== (receipt.errorCode ?? null)))
      )
        recoveryConflict(
          "Recovery receipt conflicts with immutable attempt evidence",
        );
    }
    if (
      payload.budget_attempt_id &&
      (payload.kind !== "commit" ||
        !receipts.some(
          (entry) => entry.attemptId === payload.budget_attempt_id,
        ))
    )
      recoveryConflict("Recorded logical winner is not a member receipt");
    payloads.push({ reservation: row, payload, recorded: Boolean(recorded) });
    changes.push({
      reservation_id: row.id,
      action: decision.action,
      previous_state: row.state,
      next_state: payload.kind === "commit" ? "committed" : "released",
      budget_tokens: tokens,
      budget_cost_usd: amount.toFixed(18),
      budget_attempt_id:
        payload.budget_attempt_id ?? payload.receipt?.attemptId ?? null,
      reserved_cost_usd: row.reserved_cost_usd,
      current_balance_refund_not_guaranteed: true,
    });
  }
  return {
    payloads,
    actual,
    result: {
      id: input.id,
      anchor_reservation_id: basis.view.anchor_reservation_id,
      basis_hash: basis.view.basis_hash,
      budget_only: true,
      dry_run: dryRun,
      replayed: false,
      changes,
      unknown_attempt_ids: basis.attempts
        .filter((attempt) => {
          const actual = attempt.row.reservation_id ? basis.actual?.get(attempt.row.reservation_id) : undefined;
          if (actual) return actual.plan.unresolved_cost_attempts.includes(attempt.row.id) || actual.plan.unresolved_token_attempts.includes(attempt.row.id);
          const repaired = payloads
            .flatMap(({ payload }) => [
              ...(payload.receipts ?? []),
              ...(payload.receipt ? [payload.receipt] : []),
            ])
            .find((receipt) => receipt.attemptId === attempt.row.id);
          // Intent receipts preserve the immutable initial receipt. A terminal
          // attempt's linked revision is its effective evidence, not that old copy.
          const cost =
            attempt.row.state === "terminal"
              ? attempt.cost
              : (repaired?.cost ?? attempt.cost);
          return (
            (attempt.row.state !== "terminal" && !repaired) ||
            !cost ||
            cost.report_amount === null
          );
        })
        .map((attempt) => attempt.row.id),
    },
  };
}

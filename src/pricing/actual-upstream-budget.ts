import { ExactDecimal } from "./exact-decimal";
import { pricingContentHash } from "./pricing-json";
import { runtimeOutcomeDocument } from "./pricing-outcome-document";
import { PricingRepositoryError } from "./pricing-repository.types";
import type { CostComputation } from "./pricing.types";
import type {
  ActualBudgetAttempt, ActualBudgetContribution, ActualBudgetScope,
  ActualUpstreamBudgetPlan, ActualBudgetAdjustmentPlan,
} from "./actual-upstream-budget.types";

const invalid = (message: string): never => {
  throw new PricingRepositoryError("pricing_version_conflict", message, 409);
};
const money = (value: string): string => {
  const decimal = ExactDecimal.parse(value);
  if (decimal.compare(ExactDecimal.zero) < 0) invalid("Actual expense cannot be negative");
  const fixed = decimal.toFixed(18);
  if (ExactDecimal.parse(fixed).compare(decimal) !== 0)
    invalid("Actual expense exceeds the ledger precision");
  return fixed;
};
const add = (values: string[], precision: number): string => {
  const result = values.reduce((sum, value) => sum.add(ExactDecimal.parse(value)), ExactDecimal.zero).toFixed(precision);
  // Bound totals as well as individual contributions before a future ledger write.
  ExactDecimal.parse(result);
  return result;
};

/** Never derive actual tokens from heuristics, sum both a parent and its subsets, or invent absent counters. */
function reportedTokens(cost: CostComputation, allocated: boolean): string | null {
  const input = cost.usage.quantities.total_input_tokens;
  const output = cost.usage.quantities.output_tokens;
  if (!input || !output || input.value === null || output.value === null ||
    (!allocated && (input.quality !== "observed" || output.quality !== "observed")) ||
    cost.usage.diagnostics.length)
    return null;
  for (const value of [input.value, output.value]) {
    const quantity = ExactDecimal.parse(value);
    if (!quantity.isInteger() || quantity.compare(ExactDecimal.zero) < 0)
      invalid("Actual upstream token totals must be nonnegative integers");
  }
  return add([input.value, output.value], 0);
}

function contribution(attempt: ActualBudgetAttempt): ActualBudgetContribution {
  const base: ActualBudgetContribution = {
    attempt_id: attempt.id, cost_hash: attempt.cost_hash, price_identity_hash: null,
    fee_source: attempt.fee_source, error_code: attempt.error_code,
    cost_usd: null, known_cost_usd: null, upstream_tokens: null, state: "pending", evidence_basis: "unresolved",
  };
  if (attempt.state !== "terminal") {
    if (attempt.cost || attempt.cost_hash) invalid("Pending attempt cannot carry a terminal cost");
    return base;
  }
  if (Boolean(attempt.cost) !== Boolean(attempt.cost_hash)) invalid("Incomplete terminal receipt identity");
  if (!attempt.cost || !attempt.cost_hash) return { ...base, state: "missing_cost" };
  // Reuse the existing bounded allowlist, including nested batch evidence, instead
  // of introducing a second permissive path for raw provider data or invalid numbers.
  const doc = runtimeOutcomeDocument({
    type: "attempt", workspace: attempt.workspace_id,
    reservationId: attempt.reservation_id!, attemptId: attempt.id,
    cost: attempt.cost, errorCode: attempt.error_code,
  });
  if (doc.outcome.type !== "attempt") return invalid("Expected attempt evidence");
  const cost = doc.outcome.cost;
  if (pricingContentHash(cost) !== attempt.cost_hash)
    invalid("Actual budget evidence hash differs");
  if (cost.report_currency !== "USD") invalid("Actual budget requires frozen USD reporting evidence");
  base.price_identity_hash = pricingContentHash({
    book_id: cost.book_id, version_id: cost.version_id, content_hash: cost.content_hash,
    currency: cost.currency, fx_version_id: cost.fx_version_id,
  });
  const allocated = Boolean(cost.batch && cost.batch.physical_cost.evidence_status === "observed");
  if (cost.batch) {
    const member = cost.batch.members[cost.batch.member_index];
    if (member?.request_id !== attempt.request_id || member.reservation_id !== attempt.reservation_id)
      invalid("Physical allocation belongs to a different request or reservation");
  }
  const tokens = reportedTokens(cost, allocated);
  const partialObserved = cost.report_amount === null && cost.lines.length > 0 &&
    cost.lines.every(line => line.evidence_quality === "observed") && !cost.usage.diagnostics.length;
  const observed = (cost.evidence_status === "observed" || partialObserved || allocated) && !cost.usage.diagnostics.length;
  if (attempt.fee_source !== "provider") {
    // Cached logical counts are not supplier work. Nonzero local/synthetic costs
    // require a separate classification and must not silently enter supplier spend.
    if (cost.report_amount !== null && ExactDecimal.parse(cost.report_amount).compare(ExactDecimal.zero) === 0 &&
      cost.status === "free" && cost.report_known_subtotal !== null &&
      ExactDecimal.parse(cost.report_known_subtotal).compare(ExactDecimal.zero) === 0)
      return { ...base, state: "local_zero", evidence_basis: "local_zero", cost_usd: money("0"), known_cost_usd: money("0"), upstream_tokens: "0" };
    return { ...base, state: "unclassified_local_cost" };
  }
  // A computable estimate is not promoted to observed supplier expense. Valid
  // partial receipts retain their known observed subtotal without claiming a total.
  if (!observed || cost.status === "legacy_estimate") return { ...base, state: "estimated_cost", upstream_tokens: tokens };
  const subtotal = cost.report_known_subtotal === null ? null : money(cost.report_known_subtotal);
  if (cost.report_amount === null) return { ...base, state: "missing_cost", known_cost_usd: subtotal, upstream_tokens: tokens };
  if (!["priced", "free", ...(allocated ? ["estimated"] : [])].includes(cost.status))
    invalid("A complete actual amount has an inconsistent pricing status");
  const amount = money(cost.report_amount);
  if (subtotal === null || amount !== subtotal ||
    (cost.status === "free" && ExactDecimal.parse(amount).compare(ExactDecimal.zero) !== 0))
    invalid("Complete actual expense differs from its known subtotal");
  return { ...base, state: "known", evidence_basis: allocated ? "allocated_physical_receipt" : "receipt", cost_usd: amount, known_cost_usd: amount, upstream_tokens: tokens };
}

/**
 * Pure, bounded planning only. No current-price read, SQL write, policy activation
 * or logical-winner filter. Callers must establish dispatch finality themselves.
 */
export function planActualUpstreamBudget(scope: ActualBudgetScope, attempts: ActualBudgetAttempt[]): ActualUpstreamBudgetPlan {
  if (!scope || Object.keys(scope).some(key => !["workspace_id", "request_id", "reservation_id", "dispatch_complete", "require_upstream_tokens"].includes(key)))
    invalid("Unexpected actual budget scope fields");
  for (const id of [scope.workspace_id, scope.request_id, scope.reservation_id])
    if (typeof id !== "string" || !id.length || id.length > 256) invalid("Invalid actual budget scope");
  if (typeof scope.dispatch_complete !== "boolean" || typeof scope.require_upstream_tokens !== "boolean" ||
    !Array.isArray(attempts) || attempts.length > 1024 || new Set(attempts.map(a => a.id)).size !== attempts.length)
    invalid("Invalid or duplicate actual budget evidence");
  let bytes = 0;
  for (const attempt of attempts) {
    if (!attempt || Object.keys(attempt).some(key => !["id", "workspace_id", "request_id", "reservation_id", "state", "fee_source", "error_code", "cost", "cost_hash"].includes(key)))
      invalid("Unexpected actual budget attempt fields");
    if (attempt.workspace_id !== scope.workspace_id || attempt.request_id !== scope.request_id || attempt.reservation_id !== scope.reservation_id ||
      typeof attempt.id !== "string" || !attempt.id.length || attempt.id.length > 256 ||
      !["provider", "local_cache", "synthetic"].includes(attempt.fee_source) ||
      !["terminal", "dispatched"].includes(attempt.state))
      invalid("Actual budget evidence crosses its reservation scope");
    if (attempt.error_code !== null && (typeof attempt.error_code !== "string" || !/^[A-Za-z0-9_.:-]{1,160}$/.test(attempt.error_code)))
      invalid("Invalid actual budget error metadata");
    bytes += Buffer.byteLength(JSON.stringify(attempt), "utf8");
    if (bytes > 8 * 1024 * 1024) invalid("Actual budget evidence exceeds 8 MiB");
  }
  const contributions = [...attempts].sort((a, b) => a.id < b.id ? -1 : 1).map(contribution);
  const unresolvedCost = contributions.filter(c => c.cost_usd === null).map(c => c.attempt_id);
  const unresolvedTokens = contributions.filter(c => c.upstream_tokens === null).map(c => c.attempt_id);
  const known = contributions.flatMap(c => c.known_cost_usd === null ? [] : [c.known_cost_usd]);
  const amount = unresolvedCost.length ? null : add(contributions.map(c => c.cost_usd!), 18);
  const tokens = unresolvedTokens.length ? null : add(contributions.map(c => c.upstream_tokens!), 0);
  const ready = scope.dispatch_complete && amount !== null && (!scope.require_upstream_tokens || tokens !== null);
  const body: Omit<ActualUpstreamBudgetPlan, "plan_hash"> = {
    schema_version: 1, basis: "actual_upstream", report_currency: "USD",
    workspace_id: scope.workspace_id, request_id: scope.request_id, reservation_id: scope.reservation_id,
    dispatch_complete: scope.dispatch_complete, require_upstream_tokens: scope.require_upstream_tokens,
    state: !scope.dispatch_complete ? "awaiting_dispatch_finality" : ready ? "ready" : "awaiting_evidence",
    terminal_kind: ready ? contributions.length ? "commit" : "release" : null,
    // A zero current sample while dispatch is still open is not a known zero final cost.
    cost_usd: scope.dispatch_complete ? amount : null,
    known_cost_usd: known.length || !contributions.length ? add(known, 18) : null,
    upstream_tokens: scope.dispatch_complete ? tokens : null,
    contributions, unresolved_cost_attempts: unresolvedCost, unresolved_token_attempts: unresolvedTokens,
  };
  return { ...body, plan_hash: pricingContentHash(body) };
}

/** Plans correction of the complete expense cohort, including failed attempts, without mutating the original plan. */
export function planActualBudgetAdjustment(previous: ActualUpstreamBudgetPlan, next: ActualUpstreamBudgetPlan): ActualBudgetAdjustmentPlan {
  for (const plan of [previous, next]) {
    const { plan_hash, ...body } = plan;
    if (pricingContentHash(body) !== plan_hash) invalid("Actual budget plan integrity differs");
    if (plan.basis !== "actual_upstream" || plan.schema_version !== 1 || plan.report_currency !== "USD")
      invalid("Unsupported actual budget plan");
    // A content hash is integrity metadata, not authority. Recheck all derived
    // totals so a caller cannot simply rehash a hand-edited debit or status.
    if (plan.contributions.length > 1024 || new Set(plan.contributions.map(c => c.attempt_id)).size !== plan.contributions.length)
      invalid("Actual budget plan has invalid contribution identities");
    const ordered = [...plan.contributions].sort((a, b) => a.attempt_id < b.attempt_id ? -1 : 1);
    if (JSON.stringify(ordered) !== JSON.stringify(plan.contributions)) invalid("Actual budget plan order differs");
    const unknownCost = plan.contributions.filter(c => c.cost_usd === null).map(c => c.attempt_id);
    const unknownTokens = plan.contributions.filter(c => c.upstream_tokens === null).map(c => c.attempt_id);
    for (const c of plan.contributions) {
      if (c.cost_usd !== null) money(c.cost_usd);
      if (c.known_cost_usd !== null) money(c.known_cost_usd);
      if (c.upstream_tokens !== null && (!ExactDecimal.parse(c.upstream_tokens).isInteger() || ExactDecimal.parse(c.upstream_tokens).compare(ExactDecimal.zero) < 0))
        invalid("Actual budget plan has invalid token units");
    }
    const sumCost = plan.dispatch_complete && !unknownCost.length ? add(plan.contributions.map(c => c.cost_usd!), 18) : null;
    const sumTokens = plan.dispatch_complete && !unknownTokens.length ? add(plan.contributions.map(c => c.upstream_tokens!), 0) : null;
    const known = plan.contributions.flatMap(c => c.known_cost_usd === null ? [] : [c.known_cost_usd]);
    const sumKnown = known.length || !plan.contributions.length ? add(known, 18) : null;
    const ready = plan.dispatch_complete && sumCost !== null && (!plan.require_upstream_tokens || sumTokens !== null);
    const expectedState = !plan.dispatch_complete ? "awaiting_dispatch_finality" : ready ? "ready" : "awaiting_evidence";
    if (plan.cost_usd !== sumCost || plan.upstream_tokens !== sumTokens || plan.known_cost_usd !== sumKnown || plan.state !== expectedState ||
      plan.terminal_kind !== (ready ? plan.contributions.length ? "commit" : "release" : null) ||
      JSON.stringify(unknownCost) !== JSON.stringify(plan.unresolved_cost_attempts) || JSON.stringify(unknownTokens) !== JSON.stringify(plan.unresolved_token_attempts))
      invalid("Actual budget plan totals or derived state differ");
  }
  if (previous.state !== "ready" || previous.cost_usd === null ||
    previous.workspace_id !== next.workspace_id || previous.request_id !== next.request_id || previous.reservation_id !== next.reservation_id ||
    previous.require_upstream_tokens !== next.require_upstream_tokens ||
    JSON.stringify(previous.contributions.map(c => [c.attempt_id, c.fee_source])) !== JSON.stringify(next.contributions.map(c => [c.attempt_id, c.fee_source])))
    invalid("Actual budget correction changes the settled evidence cohort");
  const ready = next.state === "ready" && next.cost_usd !== null;
  for (const [index, entry] of next.contributions.entries()) {
    if (entry.error_code !== previous.contributions[index].error_code ||
      (entry.cost_usd !== null && entry.price_identity_hash !== previous.contributions[index].price_identity_hash))
      invalid("Actual budget correction changes price, FX or original attempt outcome");
  }
  return {
    basis: "actual_upstream", previous_plan_hash: previous.plan_hash, next_plan_hash: next.plan_hash,
    state: ready ? "ready" : "awaiting_evidence",
    cost_delta_usd: ready ? ExactDecimal.parse(next.cost_usd!).subtract(ExactDecimal.parse(previous.cost_usd!)).toFixed(18) : null,
    tokens_delta: ready && previous.upstream_tokens !== null && next.upstream_tokens !== null
      ? ExactDecimal.parse(next.upstream_tokens).subtract(ExactDecimal.parse(previous.upstream_tokens)).toFixed(0) : null,
    changed_attempt_ids: next.contributions.filter((c, index) => c.cost_hash !== previous.contributions[index].cost_hash).map(c => c.attempt_id),
  };
}

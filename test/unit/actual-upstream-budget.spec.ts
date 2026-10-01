import { planActualUpstreamBudget, planActualBudgetAdjustment } from "../../src/pricing/actual-upstream-budget";
import type { ActualBudgetAttempt, ActualBudgetScope } from "../../src/pricing/actual-upstream-budget.types";
import { pricingContentHash } from "../../src/pricing/pricing-json";
import { calculateCost } from "../../src/pricing/cost-calculator";
import { normalizeQuantities } from "../../src/pricing/usage-normalizer";
import { allocateBatchCost, batchShareCost } from "../../src/pricing/cost-allocation";
import { book, quote, rate, tokenBook, tokens } from "./pricing-fixtures";
import type { CostComputation } from "../../src/pricing/pricing.types";

const scope: ActualBudgetScope = { workspace_id: "workspace", request_id: "request", reservation_id: "hold", dispatch_complete: true, require_upstream_tokens: true };
function attempt(id = "a", input = 1000, error: string | null = null): ActualBudgetAttempt {
  const cost = quote(tokenBook(), tokens({ input_tokens: input, output_tokens: 100 }));
  return { id, workspace_id: scope.workspace_id, request_id: scope.request_id, reservation_id: scope.reservation_id, state: "terminal", fee_source: "provider", error_code: error, cost, cost_hash: pricingContentHash(cost) };
}
function costAttempt(cost: CostComputation, id = "a"): ActualBudgetAttempt {
  return { ...attempt(id), cost, cost_hash: pricingContentHash(cost) };
}
const plan = (values: ActualBudgetAttempt[], override: Partial<ActualBudgetScope> = {}) => planActualUpstreamBudget({ ...scope, ...override }, values);

describe("actual upstream budget planning (internal only, no activated policy)", () => {
  it("adds every known failed and successful attempt exactly, without a logical-winner filter", () => {
    const result = plan([attempt("retry", 1000, "upstream_500"), attempt("success", 2000)]);
    expect(result).toMatchObject({ state: "ready", terminal_kind: "commit", cost_usd: "0.003400000000000000", upstream_tokens: "3200" });
    expect(result.contributions[0].error_code).toBe("upstream_500");
  });
  it("does not release known expense just because the only attempt failed", () => {
    expect(plan([attempt("failed", 1000, "upstream_500")])).toMatchObject({ state: "ready", terminal_kind: "commit", cost_usd: "0.001200000000000000" });
  });
  it("does not infer final zero while dispatch can still start, even with no current attempts", () => {
    expect(plan([], { dispatch_complete: false })).toMatchObject({ state: "awaiting_dispatch_finality", terminal_kind: null, cost_usd: null, upstream_tokens: null });
    expect(plan([])).toMatchObject({ state: "ready", terminal_kind: "release", cost_usd: "0.000000000000000000", upstream_tokens: "0" });
  });
  it("keeps known contributions while a dispatched or missing-price attempt prevents final settlement", () => {
    const pending: ActualBudgetAttempt = { ...attempt("pending"), state: "dispatched", cost: null, cost_hash: null };
    const result = plan([pending, attempt("known")]);
    expect(result).toMatchObject({ state: "awaiting_evidence", terminal_kind: null, cost_usd: null, known_cost_usd: "0.001200000000000000", unresolved_cost_attempts: ["pending"], unresolved_token_attempts: ["pending"] });
  });
  it("never labels an unknown original receipt as explicitly free", () => {
    const missing = calculateCost(tokens({ input_tokens: 1000, output_tokens: 100 }), null);
    expect(plan([costAttempt(missing)])).toMatchObject({ state: "awaiting_evidence", cost_usd: null, known_cost_usd: null, upstream_tokens: "1100" });
  });
  it("retains a validated observed partial subtotal without inventing the missing remainder", () => {
    const content = tokenBook(); content.groups[0].rules[0].rates = content.groups[0].rules[0].rates.filter(r => r.component.dimension !== "output_tokens");
    const partial = quote(content, tokens({ input_tokens: 1000, output_tokens: 100 }));
    expect(plan([costAttempt(partial)])).toMatchObject({ state: "awaiting_evidence", cost_usd: null, known_cost_usd: "0.001000000000000000" });
  });
  it("does not promote a computed heuristic estimate to actual expense", () => {
    const cost = quote(tokenBook(), tokens({ input_tokens: 1000, output_tokens: 100 }));
    cost.status = "estimated"; cost.evidence_status = "estimated";
    expect(plan([costAttempt(cost)])).toMatchObject({ state: "awaiting_evidence", cost_usd: null, known_cost_usd: null });
  });
  it("retains valid legacy estimates as unresolved instead of declaring them invalid or actual", () => {
    const content = tokenBook(); content.source = { kind: "legacy" };
    const cost = quote(content, tokens({ input_tokens: 1000, output_tokens: 100 }));
    expect(cost.status).toBe("legacy_estimate");
    expect(plan([costAttempt(cost)])).toMatchObject({ state: "awaiting_evidence", cost_usd: null, contributions: [expect.objectContaining({ state: "estimated_cost" })] });
  });
  it("distinguishes a provider's observed zero from a local-cache logical-token reference", () => {
    const free = quote(book([rate("free", "uncached_input_tokens", "0")]), tokens({ input_tokens: 1000, output_tokens: 100 }));
    expect(plan([costAttempt(free)])).toMatchObject({ state: "ready", cost_usd: "0.000000000000000000", upstream_tokens: "1100" });
    const cached = { ...costAttempt(free), fee_source: "local_cache" as const };
    expect(plan([cached])).toMatchObject({ state: "ready", cost_usd: "0.000000000000000000", upstream_tokens: "0" });
    expect(free.usage.quantities.total_input_tokens!.value).toBe("1000");
  });
  it.each(["local_cache", "synthetic"] as const)("does not count an unclassified %s nonzero fee as supplier expense", fee_source => {
    expect(plan([{ ...attempt(), fee_source }])).toMatchObject({ state: "awaiting_evidence", known_cost_usd: null, contributions: [expect.objectContaining({ state: "unclassified_local_cost" })] });
  });
  it("does not invent media token totals; cost-only plans can be ready only when no token hold requires them", () => {
    const usage = normalizeQuantities([{ dimension: "image_count", value: 3 }], { adapter_id: "image-test", adapter_version: "1", source: "provider_job_result" });
    const cost = quote(book([rate("image", "image_count", "0.04", "1")]), usage);
    expect(plan([costAttempt(cost)])).toMatchObject({ state: "awaiting_evidence", cost_usd: "0.120000000000000000", upstream_tokens: null });
    expect(plan([costAttempt(cost)], { require_upstream_tokens: false })).toMatchObject({ state: "ready", cost_usd: "0.120000000000000000", upstream_tokens: null });
  });
  it("does not charge token modality, cache or reasoning subset counters a second time", () => {
    const cost = quote(tokenBook(), tokens({ input_tokens: 10000, output_tokens: 500, cache_read_input_tokens: 4000, cache_creation_input_tokens: 1500, cache_creation_5m_input_tokens: 1000, cache_creation_1h_input_tokens: 500, reasoning_output_tokens: 200 }));
    expect(plan([costAttempt(cost)]).upstream_tokens).toBe("10500");
    expect(plan([costAttempt(cost)]).cost_usd).toBe("0.008150000000000000");
  });
  it("uses the allocated physical-batch share, never the nested full physical cost again", () => {
    const physical = quote(tokenBook(), tokens({ input_tokens: 3000, output_tokens: 300 }));
    const members = [{ request_id: scope.request_id, reservation_id: scope.reservation_id, input_start: 0, input_count: 1, weight: "1", weight_basis: "text_token_estimate" as const }, { request_id: "other", reservation_id: "other-hold", input_start: 1, input_count: 1, weight: "2", weight_basis: "text_token_estimate" as const }];
    const batch = allocateBatchCost("batch", physical, members);
    const share = batchShareCost(batch, 0, "physical");
    expect(plan([costAttempt(share)])).toMatchObject({ state: "ready", cost_usd: "0.001200000000000000", upstream_tokens: "1100" });
  });
  it("is order-independent, content-addressed and detached from later input mutation", () => {
    const a = attempt("a"), b = attempt("b", 2000);
    const first = plan([a, b]), second = plan([b, a]);
    expect(first).toEqual(second);
    a.cost!.report_amount = "999";
    expect(first.cost_usd).toBe("0.003400000000000000");
    expect(planActualBudgetAdjustment(first, JSON.parse(JSON.stringify(first)))).toMatchObject({ state: "ready", cost_delta_usd: "0.000000000000000000", tokens_delta: "0", changed_attempt_ids: [] });
  });
  it("computes the delta of a corrected failed attempt rather than replacing the entire successful budget", () => {
    const previous = plan([attempt("failed", 1000, "upstream_500"), attempt("success", 2000)]);
    const next = plan([attempt("failed", 500, "upstream_500"), attempt("success", 2000)]);
    expect(planActualBudgetAdjustment(previous, next)).toMatchObject({ state: "ready", cost_delta_usd: "-0.000500000000000000", tokens_delta: "-500", changed_attempt_ids: ["failed"] });
  });
  it("does not apply a correction whose new evidence becomes unknown", () => {
    const previous = plan([attempt()]);
    const unknown = costAttempt(calculateCost(tokens({ input_tokens: 1000, output_tokens: 100 }), null));
    expect(planActualBudgetAdjustment(previous, plan([unknown]))).toMatchObject({ state: "awaiting_evidence", cost_delta_usd: null, tokens_delta: null });
  });
  it.each(["workspace_id", "request_id", "reservation_id"] as const)("rejects evidence from a different %s", key => {
    expect(() => plan([{ ...attempt(), [key]: "foreign" }])).toThrow("scope");
  });
  it("rejects duplicate identities rather than deduplicating conflicting fees silently", () => {
    expect(() => plan([attempt(), attempt()])).toThrow("duplicate");
  });
  it("rejects tampered receipt bytes and inconsistent total/status metadata", () => {
    const a = attempt(); a.cost!.report_amount = "1";
    expect(() => plan([a])).toThrow("hash");
    a.cost_hash = pricingContentHash(a.cost);
    expect(() => plan([a])).toThrow("subtotal");
  });
  it("rejects a foreign currency even if it has an apparently usable amount", () => {
    const a = attempt(); a.cost!.report_currency = "CNY"; a.cost_hash = pricingContentHash(a.cost);
    expect(() => plan([a])).toThrow("accounting evidence");
  });
  it("rejects raw/private fields at both the scope and nested cost boundary", () => {
    expect(() => planActualUpstreamBudget({ ...scope, api_key: "not-allowed" } as ActualBudgetScope, [])).toThrow("scope fields");
    const a = attempt(); Object.assign(a.cost!, { raw_body: "not-allowed" }); a.cost_hash = pricingContentHash(a.cost);
    expect(() => plan([a])).toThrow();
  });
  it("rejects more than1024attempts before unbounded work", () => {
    expect(() => plan(Array.from({ length: 1025 }, (_, i) => ({ ...attempt(String(i)), cost: null, cost_hash: null })))).toThrow();
  });
  it("rejects a corrected cohort that drops, adds or reassigns an attempt", () => {
    const original = plan([attempt()]);
    expect(() => planActualBudgetAdjustment(original, plan([]))).toThrow("cohort");
    expect(() => planActualBudgetAdjustment(original, plan([attempt(), attempt("new")]))).toThrow("cohort");
    expect(() => planActualBudgetAdjustment(original, { ...original, plan_hash: "0".repeat(64) })).toThrow("integrity");
  });
  it("rejects a correction that tries to reprice an already settled cohort", () => {
    const original = plan([attempt()]);
    const changed = attempt(); changed.cost!.version_id = "new-price";
    changed.cost_hash = pricingContentHash(changed.cost);
    expect(() => planActualBudgetAdjustment(original, plan([changed]))).toThrow("price, FX");
  });
  it("rejects rehashed forged totals rather than treating a hash as authorization", () => {
    const original = plan([attempt()]);
    const changed = { ...original, cost_usd: "999.000000000000000000" };
    const { plan_hash: _hash, ...body } = changed;
    changed.plan_hash = pricingContentHash(body);
    expect(() => planActualBudgetAdjustment(original, changed)).toThrow("totals");
  });
  it("bounds aggregate amounts and rejects fractional upstream-token counters", () => {
    const cost = quote(book([rate("request", "request_count", "999999999999999999999999999999", "1")]), normalizeQuantities([{ dimension: "request_count", value: 1 }], { adapter_id: "fixture", adapter_version: "1", source: "provider_usage" }));
    expect(() => plan([costAttempt(cost, "a"), costAttempt(cost, "b")], { require_upstream_tokens: false })).toThrow();
    const a = attempt(); a.cost!.usage.quantities.total_input_tokens!.value = "1.5"; a.cost_hash = pricingContentHash(a.cost);
    expect(() => plan([a])).toThrow();
  });
});

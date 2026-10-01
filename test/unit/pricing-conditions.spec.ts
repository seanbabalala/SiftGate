import { calculateCost } from "../../src/pricing/cost-calculator";
import { compilePriceBook } from "../../src/pricing/pricing-compiler";
import { CONDITION_CASES, conditionBook, conditionContext, installConditionClock } from "../e2e/pricing-conditions-fixtures";
import { tokens } from "./pricing-fixtures";

describe("synthetic cross-layer service-tier and calendar amount fixtures", () => {
  it.each(CONDITION_CASES)("$id has the specified exact amount and selection", test => {
    const content = conditionBook(test.book);
    const usage = tokens({ input_tokens: 1000, output_tokens: 500 });
    const compiled = compilePriceBook(content, { book_id: "synthetic", version_id: "frozen" });
    const cost = calculateCost(usage, compiled.resolve(usage, conditionContext(test)));
    expect(cost.amount).toBe(test.expected);
    expect(cost.version_id).toBe("frozen");
    expect(cost.selection).toMatchObject({ requested_service_tier: test.requestedTier, resolved_service_tier: test.resolvedTier, effective_service_tier: test.resolvedTier });
    if (test.calendar) expect(cost.selection!.calendar_match).toMatchObject(test.calendar);
    if (test.expectedRule) expect(cost.selected_rule_ids).toContain(test.expectedRule);
    if (test.expected === null) expect(cost.status).toBe("unpriced");
    if (test.book === "tiers") expect(content.groups.every(group => group.rules.every(rule => !rule.multipliers?.length))).toBe(true);
  });
  it("replaces only Date.now inside the fixture, preserving constructor identity and real timers", async () => {
    const original = Date, now = Date.now, explicit = new Date("2026-03-08T07:00:00Z");
    const clock = installConditionClock();
    try {
      clock.set("2026-11-01T06:30:00Z");
      expect(Date).toBe(original);
      expect(new Date(Date.now()).toISOString()).toBe("2026-11-01T06:30:00.000Z");
      expect(explicit instanceof Date).toBe(true);
      expect(explicit.toISOString()).toBe("2026-03-08T07:00:00.000Z");
      await new Promise<void>(resolve => setTimeout(resolve, 1));
    } finally { clock.restore(); }
    expect(Date.now).toBe(now);
  });
});

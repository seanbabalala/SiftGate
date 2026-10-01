import { compilePriceBook } from "../../src/pricing/pricing-compiler";
import { allocateExact } from "../../src/pricing/exact-allocation";
import {
  allocateBatchCost,
  allocateBatchUsage,
} from "../../src/pricing/cost-allocation";
import { ExactDecimal } from "../../src/pricing/exact-decimal";
import { calculateCost } from "../../src/pricing/cost-calculator";
import { normalizeQuantities } from "../../src/pricing/usage-normalizer";
import type {
  BatchCostAllocation,
  EmbeddingBatchMember,
} from "../../src/pricing/pricing-batch.types";
import { book, rate, quote, tokenBook, tokens } from "./pricing-fixtures";

const weights = [
  { id: "a", weight: "1" },
  { id: "b", weight: "1" },
  { id: "c", weight: "1" },
];
const members = (values = ["1", "1", "1"]): EmbeddingBatchMember[] =>
  values.map((weight, index) => ({
    request_id: String.fromCharCode(97 + index),
    reservation_id: `r-${index}`,
    input_start: index,
    input_count: 1,
    weight,
    weight_basis: "text_token_estimate",
  }));
const sum = (values: string[]) =>
  values
    .reduce(
      (sum, value) => sum.add(ExactDecimal.parse(value)),
      ExactDecimal.zero,
    )
    .toFixed(18);
function conserved(allocation: BatchCostAllocation) {
  for (const key of [
    "amount",
    "known_subtotal",
    "rounding_adjustment",
    "report_amount",
    "report_known_subtotal",
    "report_rounding_adjustment",
  ] as const) {
    if (allocation.physical_cost[key] === null)
      expect(allocation.shares.map((share) => share[key])).toEqual(
        allocation.shares.map(() => null),
      );
    else
      expect(sum(allocation.shares.map((share) => share[key]!))).toBe(
        ExactDecimal.parse(allocation.physical_cost[key]!).toFixed(18),
      );
  }
  allocation.physical_cost.lines.forEach((line, index) => {
    expect(
      sum(allocation.shares.map((share) => share.lines[index].amount)),
    ).toBe(ExactDecimal.parse(line.amount).toFixed(18));
    if (line.report_amount !== null)
      expect(
        sum(
          allocation.shares.map((share) => share.lines[index].report_amount!),
        ),
      ).toBe(ExactDecimal.parse(line.report_amount).toFixed(18));
  });
  for (const share of allocation.shares) {
    if (share.known_subtotal !== null)
      expect(
        sum([
          ...share.lines.map((line) => line.amount),
          share.rounding_adjustment!,
        ]),
      ).toBe(share.known_subtotal);
    if (share.report_known_subtotal !== null)
      expect(
        sum([
          ...share.lines.map((line) => line.report_amount!),
          share.report_rounding_adjustment!,
        ]),
      ).toBe(share.report_known_subtotal);
  }
}

describe("exact conserved batch allocation", () => {
  it("allocates tiny, negative and large values without lost units or floating point", () => {
    expect(allocateExact("2", weights, 0)).toEqual(["1", "1", "0"]);
    expect(allocateExact("0.000000000000000001", weights)).toEqual([
      "0.000000000000000001",
      "0.000000000000000000",
      "0.000000000000000000",
    ]);
    expect(sum(allocateExact("-0.000000003", weights))).toBe(
      "-0.000000003000000000",
    );
    const large = "999999999999999999999999999999.123456789012345678";
    expect(sum(allocateExact(large, weights))).toBe(large);
    expect(allocateExact("2", [...weights].reverse(), 0)).toEqual([
      "0",
      "1",
      "1",
    ]);
  });
  it("accepts exact integral decimal weight spellings without converting through floating point", () => {
    const physical = quote(
      tokenBook(),
      tokens({ input_tokens: 3, output_tokens: 0 }),
    );
    const allocation = allocateBatchCost(
      "decimal-weights",
      physical,
      members(["1.0", "2.000", "03"]),
    );
    expect(allocation.shares[0].lines[0].exact_amount).toEqual({
      numerator: "1",
      denominator: "2000000",
    });
    conserved(allocation);
  });

  it("respects per-member capacity instead of allowing cache partitions to exceed input allocations", () => {
    expect(
      allocateExact(
        "8",
        [
          { id: "a", weight: "100" },
          { id: "b", weight: "1" },
        ],
        0,
        ["2", "8"],
      ),
    ).toEqual(["2", "6"]);
    const physical = tokens({
      input_tokens: 3,
      output_tokens: 2,
      cache_read_input_tokens: 1,
      cache_creation_input_tokens: 1,
    });
    const allocations = allocateBatchUsage(physical, weights);
    for (const allocated of allocations)
      expect(allocated.diagnostics).toEqual([]);
    for (const dimension of [
      "total_input_tokens",
      "uncached_input_tokens",
      "cache_read_tokens",
      "cache_write_tokens",
      "output_tokens",
    ] as const) {
      expect(
        sum(
          allocations.map(
            (allocation) => allocation.quantities[dimension]!.value!,
          ),
        ),
      ).toBe(
        ExactDecimal.parse(physical.quantities[dimension]!.value!).toFixed(18),
      );
    }
    for (const allocated of allocations) {
      const q = allocated.quantities;
      expect(
        sum([
          q.uncached_input_tokens!.value!,
          q.cache_read_tokens!.value!,
          q.cache_write_tokens!.value!,
        ]),
      ).toBe(ExactDecimal.parse(q.total_input_tokens!.value!).toFixed(18));
    }
  });
  it("keeps reasoning overlapping output rather than charging it as another disjoint modality", () => {
    const physical = normalizeQuantities(
      [
        { dimension: "output_tokens", value: 2 },
        { dimension: "text_output_tokens", value: 2 },
        { dimension: "audio_output_tokens", value: 0 },
        { dimension: "image_output_tokens", value: 0 },
        { dimension: "reasoning_output_tokens", value: 2 },
      ],
      { adapter_id: "fixture", adapter_version: "1", source: "provider_usage" },
    );
    const allocations = allocateBatchUsage(physical, weights);
    allocations.forEach((usage) => {
      expect(usage.diagnostics).toEqual([]);
      expect(usage.quantities.reasoning_output_tokens?.value).toBe(
        usage.quantities.output_tokens?.value,
      );
    });
  });
  it("charges the combined context tier once and allocates that physical price, not three cheaper standalone prices", () => {
    const content = tokenBook();
    content.groups.push({
      id: "context",
      order: 1,
      required: false,
      rules: [
        {
          id: "large",
          priority: 0,
          mode: "whole_request",
          condition: { input_tokens: { min: "272001" } },
          rates: [
            {
              operation: "replace",
              component: rate(
                "large-input",
                "uncached_input_tokens",
                "2",
                "1000000",
              ),
            },
          ],
          multipliers: [],
        },
      ],
    });
    const physical = quote(
      content,
      tokens({ input_tokens: 300000, output_tokens: 0 }),
    );
    expect(physical.amount).toBe("0.600000000");
    const allocation = allocateBatchCost(
      "combined-context",
      physical,
      members(),
    );
    expect(allocation.shares.map((share) => share.amount)).toEqual([
      "0.200000000000000000",
      "0.200000000000000000",
      "0.200000000000000000",
    ]);
    expect(
      quote(content, tokens({ input_tokens: 100000, output_tokens: 0 })).amount,
    ).toBe("0.100000000");
    expect(allocation.physical_cost.selected_rule_ids).toContain("large");
    expect(
      allocation.shares.every((share) => share.status === "estimated"),
    ).toBe(true);
    conserved(allocation);
  });
  it("allocates a shared invocation base fee only once alongside token usage and keeps every component reconcilable", () => {
    const content = book([
      rate("input", "uncached_input_tokens", "0.01", "1"),
      rate("invocation", "request_count", "0.02", "1"),
    ]);
    const usage = normalizeQuantities(
      [
        { dimension: "total_input_tokens", value: 3 },
        { dimension: "uncached_input_tokens", value: 3 },
        { dimension: "request_count", value: 1 },
      ],
      { adapter_id: "fixture", adapter_version: "1", source: "provider_usage" },
    );
    const physical = quote(content, usage);
    const before = JSON.stringify(physical);
    const allocation = allocateBatchCost("base-fee", physical, members());
    expect(physical.amount).toBe("0.050000000");
    conserved(allocation);
    expect(JSON.stringify(physical)).toBe(before);
    expect(sum(allocation.shares.map((share) => share.lines[1].amount))).toBe(
      "0.020000000000000000",
    );
    expect(allocation.shares[0].lines[1].exact_amount).toEqual({
      numerator: "1",
      denominator: "150",
    });
  });
  it("preserves source/report currency, frozen FX, rounding differences and exact unrounded ratios", () => {
    const content = book([
      rate("one", "request_count", "0.0000000007", "1"),
      rate("two", "uncached_input_tokens", "0.0000000007", "1"),
    ]);
    content.currency = "CNY";
    const usage = normalizeQuantities(
      [
        { dimension: "request_count", value: 1 },
        { dimension: "uncached_input_tokens", value: 1 },
      ],
      { adapter_id: "fixture", adapter_version: "1", source: "provider_usage" },
    );
    const physical = calculateCost(
      usage,
      compilePriceBook(content, {
        book_id: "fixture",
        version_id: "v1",
      }).resolve(usage),
      {
        fx: {
          version_id: "synthetic-fx",
          source: "fixture",
          from_currency: "CNY",
          to_currency: "USD",
          effective_at: "2026-01-01T00:00:00Z",
          numerator: "1",
          denominator: "7",
        },
        report_currency: "USD",
      },
    );
    const allocation = allocateBatchCost(
      "rounding-fx",
      physical,
      members(["1", "2", "3"]),
    );
    expect(allocation.physical_cost.fx_version_id).toBe("synthetic-fx");
    expect(physical.rounding_adjustment).toBe("-0.000000001");
    conserved(allocation);
  });
  it("does not confuse missing prices/usage/FX, known-zero cost and an explicitly free tariff", () => {
    const usage = tokens({ input_tokens: 10, output_tokens: 2 });
    const unpriced = allocateBatchCost(
      "unpriced",
      calculateCost(usage, null, { report_currency: "USD" }),
      members(),
    );
    expect(
      unpriced.shares.every(
        (share) => share.amount === null && share.status === "unpriced",
      ),
    ).toBe(true);
    const free = allocateBatchCost(
      "free",
      quote(book([rate("free", "uncached_input_tokens", "0", "1")]), usage),
      members(),
    );
    expect(
      free.shares.every(
        (share) =>
          share.amount === "0.000000000000000000" && share.status === "free",
      ),
    ).toBe(true);
    const cny = tokenBook();
    cny.currency = "CNY";
    const noFx = allocateBatchCost(
      "no-fx",
      calculateCost(
        usage,
        compilePriceBook(cny, { book_id: "fixture", version_id: "v1" }).resolve(
          usage,
        ),
        { report_currency: "USD" },
      ),
      members(),
    );
    expect(
      noFx.shares.every(
        (share) => share.amount !== null && share.report_amount === null,
      ),
    ).toBe(true);
    conserved(noFx);
    const missing = allocateBatchCost(
      "missing",
      quote(tokenBook(), tokens({ output_tokens: 1 })),
      members(),
    );
    expect(
      missing.shares.every(
        (share) => share.amount === null && share.status === "partial",
      ),
    ).toBe(true);
    conserved(missing);
  });
  it("rejects malformed identities, source rounding, overlap and corrupted physical sums", () => {
    for (const invalid of [
      [{ id: "a", weight: "0" }],
      [{ id: "a", weight: "0.5" }],
      [weights[0], weights[0]],
    ])
      expect(() => allocateExact("1", invalid)).toThrow();
    expect(() => allocateExact("0.5", weights, 0)).toThrow("round");
    expect(() => allocateExact("10", weights, 0, ["1", "1", "1"])).toThrow(
      "parent",
    );
    const physical = quote(
      tokenBook(),
      tokens({ input_tokens: 1000, output_tokens: 0 }),
    );
    expect(() =>
      allocateBatchCost(
        "bad",
        physical,
        members().map((member) => ({ ...member, input_start: 0 })),
      ),
    ).toThrow();
    expect(() =>
      allocateBatchCost(
        "bad",
        { ...physical, known_subtotal: "999" },
        members(),
      ),
    ).toThrow();
    expect(() =>
      allocateBatchCost(
        "bad",
        calculateCost(tokens({}), null),
        members(["0", "1", "1"]),
      ),
    ).toThrow();
  });
  it("bounds output expansion before allocating a large member-by-component matrix", () => {
    const physical = quote(
      tokenBook(),
      tokens({ input_tokens: 1, output_tokens: 1 }),
    );
    const large = {
      ...physical,
      lines: Array.from({ length: 65 }, () => physical.lines[0]),
    };
    expect(() =>
      allocateBatchCost("oversized", large, members(Array(1024).fill("1"))),
    ).toThrow("size");
    expect(() =>
      allocateBatchUsage(tokens({}), [{ id: "invalid", weight: "0" }]),
    ).toThrow("positive");
  });

  it("conserves hundreds of deterministic synthetic quantities and nested cache partitions", () => {
    for (let n = 1; n <= 250; n++) {
      const syntheticWeights = [
        { id: "a", weight: String((n % 7) + 1) },
        { id: "b", weight: String((n % 11) + 1) },
        { id: "c", weight: String((n % 5) + 1) },
      ];
      expect(sum(allocateExact(String(n), syntheticWeights, 0))).toBe(
        ExactDecimal.parse(String(n)).toFixed(18),
      );
      const physical = tokens({
        input_tokens: n,
        output_tokens: n % 5,
        cache_read_input_tokens: Math.floor(n / 3),
        cache_creation_input_tokens: Math.floor(n / 4),
      });
      for (const child of allocateBatchUsage(physical, syntheticWeights))
        expect(child.diagnostics).toEqual([]);
      conserved(
        allocateBatchCost(
          `case-${n}`,
          quote(tokenBook(), physical),
          members(syntheticWeights.map((entry) => entry.weight)),
        ),
      );
    }
  });
});

import { compilePriceBook } from "../../src/pricing/pricing-compiler";
import { calculateCost } from "../../src/pricing/cost-calculator";
import { pricingContentHash } from "../../src/pricing/pricing-json";
import {
  parsePricingInheritance,
  resolvePricingInheritance,
} from "../../src/pricing/pricing-inheritance";
import type { PricingInheritanceDefinition } from "../../src/pricing/pricing-inheritance.types";
import { book, rate, tokenBook, tokens } from "./pricing-fixtures";

describe("explicit immutable parent price expansion", () => {
  const child = { book_id: "child", version_id: "child-v1" };
  function fixture() {
    const content = compilePriceBook(tokenBook(), {
      book_id: "parent",
      version_id: "v1",
    }).document();
    const reference = {
      book_id: "parent",
      version_id: "v1",
      content_hash: pricingContentHash(content),
    };
    const definition: PricingInheritanceDefinition = {
      schema_version: 1,
      parent: reference,
      inherit: "all",
      source: { kind: "manual", reference: "https://example.test/contract" },
      rate_overrides: [],
      removed_component_ids: [],
      replaced_groups: [],
      added_groups: [],
      removed_group_ids: [],
      settings: {},
      calendar: { mode: "inherit" },
    };
    return { parent: { reference, content }, definition };
  }
  it("materializes inherited cache/output rates while overriding only the explicit input component", () => {
    const f = fixture(),
      before = JSON.stringify(f);
    f.definition.rate_overrides = [rate("input", "uncached_input_tokens", "2")];
    const submitted = JSON.stringify(f);
    const result = resolvePricingInheritance(f.definition, f.parent, child);
    expect(JSON.stringify(f)).toBe(submitted);
    expect(before).not.toBe(submitted);
    const price = compilePriceBook(result.content, child),
      cost = calculateCost(
        tokens({
          input_tokens: 1000,
          cache_read_input_tokens: 200,
          output_tokens: 100,
        }),
        price.resolve(
          tokens({
            input_tokens: 1000,
            cache_read_input_tokens: 200,
            output_tokens: 100,
          }),
        ),
      );
    expect(cost.report_amount).toBe("0.001820000");
    expect(
      result.provenance.components.find((c) => c.component_id === "read")
        ?.origin,
    ).toBe("parent");
    expect(
      result.provenance.components.find((c) => c.component_id === "input")
        ?.origin,
    ).toBe("override");
    expect(result.provenance.resolved_content_hash).toBe(price.contentHash);
    expect(result.provenance.parent).toEqual(f.parent.reference);
  });
  it("does not silently replace a frozen parent with newer catalog prices", () => {
    const f = fixture(),
      first = resolvePricingInheritance(f.definition, f.parent, child);
    const newer = structuredClone(f.parent);
    newer.reference.version_id = "v2";
    newer.content.groups[0].rules[0].rates[0].component.amount = "90";
    newer.reference.content_hash = pricingContentHash(newer.content);
    expect(() =>
      resolvePricingInheritance(f.definition, newer, child),
    ).toThrow();
    expect(resolvePricingInheritance(f.definition, f.parent, child)).toEqual(
      first,
    );
  });
  it("does not guess a removed cache price or report missing pricing as free", () => {
    const f = fixture();
    f.definition.removed_component_ids = ["read"];
    const result = resolvePricingInheritance(f.definition, f.parent, child),
      price = compilePriceBook(result.content, child),
      usage = tokens({
        input_tokens: 1000,
        cache_read_input_tokens: 200,
        output_tokens: 0,
      });
    const cost = calculateCost(usage, price.resolve(usage));
    expect(cost.report_amount).toBeNull();
    expect(cost.status).toBe("partial");
    expect(
      result.provenance.components.some((c) => c.component_id === "read"),
    ).toBe(false);
  });
  it("requires explicit zero/free evidence on a zero override", () => {
    const f = fixture();
    f.definition.rate_overrides = [
      { ...rate("input", "uncached_input_tokens", "0"), free: undefined },
    ];
    expect(() =>
      resolvePricingInheritance(f.definition, f.parent, child),
    ).toThrow();
    f.definition.rate_overrides[0].free = true;
    expect(
      resolvePricingInheritance(f.definition, f.parent, child).content.groups[0]
        .rules[0].rates[0].component.free,
    ).toBe(true);
  });
  it("supports explicit whole-group replacement and marks its rates local", () => {
    const f = fixture();
    f.definition.replaced_groups = book([
      rate("only-input", "uncached_input_tokens", "3"),
    ]).groups;
    f.definition.settings.billing_dimensions = ["uncached_input_tokens"];
    const result = resolvePricingInheritance(f.definition, f.parent, child);
    expect(result.content.groups[0].rules[0].rates).toHaveLength(1);
    expect(result.provenance.components[0].origin).toBe("local");
  });
  it("adds an explicit context-tier group without losing inherited cache dimensions", () => {
    const f = fixture();
    f.definition.added_groups = [
      {
        id: "large",
        order: 1,
        required: false,
        rules: [
          {
            id: "large-input",
            priority: 0,
            mode: "whole_request",
            condition: { input_tokens: { min: "272001" } },
            rates: [],
            multipliers: [{ dimension: "uncached_input_tokens", factor: "2" }],
          },
        ],
      },
    ];
    const result = resolvePricingInheritance(f.definition, f.parent, child),
      price = compilePriceBook(result.content, child);
    for (const [quantity, expected] of [
      [272000, "0.272000000"],
      [272001, "0.544002000"],
    ] as const) {
      const usage = tokens({ input_tokens: quantity, output_tokens: 0 });
      expect(calculateCost(usage, price.resolve(usage)).report_amount).toBe(
        expected,
      );
    }
    expect(result.content.billing_dimensions).toEqual(
      f.parent.content.billing_dimensions,
    );
  });
  it.each([
    { inherit: "implicit" },
    { currency: "CNY" },
    { source: { kind: "manual", secret: "no" } },
    { settings: { currency: "CNY" } },
    { rate_overrides: [rate("unknown", "uncached_input_tokens", "1")] },
    { rate_overrides: [rate("input", "output_tokens", "1")] },
    {
      removed_component_ids: ["input"],
      rate_overrides: [rate("input", "uncached_input_tokens", "1")],
    },
    { removed_component_ids: ["missing"] },
    { removed_group_ids: ["missing"] },
    { added_groups: tokenBook().groups },
    { removed_group_ids: ["base"], replaced_groups: tokenBook().groups },
    {
      replaced_groups: tokenBook().groups,
      rate_overrides: [rate("input", "uncached_input_tokens", "4")],
    },
    { calendar: { mode: "inherit", time_basis: "completed_at" } },
    { calendar: { mode: "replace" } },
  ])("rejects ambiguous or unsupported inheritance: %j", (patch) => {
    const f = fixture();
    expect(() =>
      resolvePricingInheritance({ ...f.definition, ...patch }, f.parent, child),
    ).toThrow();
  });
  it("rejects changed parent contents and self-version cycles", () => {
    const f = fixture();
    const altered = structuredClone(f.parent);
    altered.content.groups[0].rules[0].rates[0].component.amount = "10";
    expect(() =>
      resolvePricingInheritance(f.definition, altered, child),
    ).toThrow();
    expect(() =>
      resolvePricingInheritance(f.definition, f.parent, f.parent.reference),
    ).toThrow();
  });
  it("does not promote a reference-only parent into a live inherited tariff", () => {
    const f = fixture();
    f.parent.content.source.kind = "reference";
    f.parent.reference.content_hash = pricingContentHash(f.parent.content);
    expect(() =>
      resolvePricingInheritance(f.definition, f.parent, child),
    ).toThrow();
  });
  it("freezes the parent calendar unless explicitly replaced, and refuses dangling time rules", () => {
    const f = fixture();
    f.parent.content.calendar = {
      schema_version: 1,
      version_id: "parent-calendar",
      time_zone: "Asia/Shanghai",
      tzdb_version: process.versions.tz ?? "unknown",
      valid_from: "2026-01-01",
      valid_to: "2027-01-01",
      default_tag: "offpeak",
      weekly: [
        {
          weekdays: [1, 2, 3, 4, 5],
          windows: [{ start: "09:00", end: "17:00", tag: "peak" }],
        },
      ],
      holidays: [],
      date_overrides: [],
    };
    f.parent.content.time_basis = "attempt_dispatched_at";
    f.parent.content.groups.push({
      id: "peak",
      order: 1,
      required: false,
      rules: [
        {
          id: "peak-rate",
          priority: 0,
          mode: "whole_request",
          condition: { time_tags: ["peak"] },
          rates: [],
          multipliers: [{ dimension: "uncached_input_tokens", factor: "2" }],
        },
      ],
    });
    f.parent.reference.content_hash = compilePriceBook(
      f.parent.content,
      f.parent.reference,
    ).contentHash;
    const inherited = resolvePricingInheritance(f.definition, f.parent, child);
    expect(inherited.content.calendar).toEqual(f.parent.content.calendar);
    expect(inherited.provenance.calendar).toBe("parent");
    const usage = tokens({ input_tokens: 1000, output_tokens: 0 }),
      price = compilePriceBook(inherited.content, child);
    expect(
      calculateCost(
        usage,
        price.resolve(usage, { attempt_dispatched_at: "2026-09-25T01:00:00Z" }),
      ).report_amount,
    ).toBe("0.002000000");
    f.definition.calendar = { mode: "remove" };
    expect(() =>
      resolvePricingInheritance(f.definition, f.parent, child),
    ).toThrow();
    f.definition.removed_group_ids = ["peak"];
    expect(
      resolvePricingInheritance(f.definition, f.parent, child).provenance
        .calendar,
    ).toBe("none");
    f.definition.removed_group_ids = [];
    f.definition.calendar = {
      mode: "replace",
      document: {
        ...f.parent.content.calendar,
        version_id: "child-calendar",
        date_overrides: [{ date: "2026-09-25", windows: [] }],
      },
      time_basis: "completed_at",
    };
    const replacement = resolvePricingInheritance(
      f.definition,
      f.parent,
      child,
    );
    expect(replacement.provenance.calendar).toBe("local");
    const changed = compilePriceBook(replacement.content, child);
    expect(
      calculateCost(
        usage,
        changed.resolve(usage, { completed_at: "2026-09-25T01:00:00Z" }),
      ).report_amount,
    ).toBe("0.001000000");
    expect(f.parent.content.calendar.version_id).toBe("parent-calendar");
  });

  it("copies the recipe and rejects duplicate/oversized input without evaluating code", () => {
    const f = fixture();
    const parsed = parsePricingInheritance(f.definition);
    parsed.settings.money_precision = 3;
    expect(f.definition.settings).toEqual({});
    expect(() =>
      parsePricingInheritance({
        ...f.definition,
        removed_component_ids: ["read", "read"],
      }),
    ).toThrow();
    expect(() =>
      parsePricingInheritance({ ...f.definition, unknown: "x".repeat(512000) }),
    ).toThrow();
    expect(() =>
      parsePricingInheritance({ ...f.definition, rate_overrides: [null] }),
    ).toThrow();
  });
});

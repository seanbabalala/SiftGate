import { CompiledPricingCatalog } from "../../src/pricing/pricing-catalog";
import { compilePriceBook } from "../../src/pricing/pricing-compiler";
import { calculateCost } from "../../src/pricing/cost-calculator";
import { assessPricingAdmission } from "../../src/pricing/pricing-admission";
import {
  parseAdmissionPolicy,
  reservationQuantityBounds,
} from "../../src/pricing/pricing-admission-policy";
import { PricingSchemaReader } from "../../src/pricing/pricing-schema-reader";
import { ExactDecimal } from "../../src/pricing/exact-decimal";
import { normalizeQuantities } from "../../src/pricing/usage-normalizer";
import type { PriceBookContent } from "../../src/pricing/pricing.types";
import type {
  CatalogAdmissionPolicy,
  PricingAdmissionPolicy,
} from "../../src/pricing/pricing-admission.types";
import { book, rate, tokenBook, tokens } from "./pricing-fixtures";

const when = "2026-09-25T01:00:00.000Z";
const target = {
  model: "synthetic",
  node_id: "node-a",
  operation: "chat_completions",
};
const cap: PricingAdmissionPolicy = {
  mode: "reserve_upper_bound",
  quantity_limits: { total_input_tokens: "9", output_tokens: "3" },
  limit_reference: "Synthetic supplier limits",
};
const empty = () =>
  normalizeQuantities([], {
    adapter_id: "test",
    adapter_version: "1",
    source: "request_metadata",
  });
function catalog(content = tokenBook(), policies?: CatalogAdmissionPolicy[]) {
  const compiled = compilePriceBook(content, {
    book_id: "synthetic",
    version_id: "v1",
  });
  return CompiledPricingCatalog.compile({
    schema_version: 1,
    revision_id: "catalog-1",
    created_at: when,
    books: [
      {
        book_id: "synthetic",
        version_id: "v1",
        workspace_id: null,
        content_hash: compiled.contentHash,
        content: compiled.document(),
      },
    ],
    bindings: [
      {
        id: "binding",
        workspace_id: null,
        level: "model",
        model: target.model,
        book_id: "synthetic",
        version_id: "v1",
        effective_from: when,
      },
    ],
    fx_versions: [],
    ...(policies ? { admission_policies: policies } : {}),
  });
}
const capture = (compiled: CompiledPricingCatalog, workspace = "workspace-a") =>
  compiled.capture({
    admitted_at: when,
    workspace_id: workspace,
    report_currency: "USD",
  });
const policy = (value: PricingAdmissionPolicy): CatalogAdmissionPolicy[] => [
  { workspace_id: "workspace-a", policy: value },
];

describe("explicit pricing admission and conservative rate envelopes", () => {
  it("leaves old catalog documents/hashes unchanged and defaults to compatibility", () => {
    const doc = catalog().document();
    expect(doc).not.toHaveProperty("admission_policies");
    expect(
      capture(CompiledPricingCatalog.compile(doc)).admissionPolicy(),
    ).toEqual({ mode: "compatibility" });
    expect(
      CompiledPricingCatalog.compile(JSON.parse(JSON.stringify(doc)))
        .contentHash,
    ).toBe(catalog().contentHash);
  });

  it("selects workspace before global policy, operation-specific before generic, without exposing another workspace", () => {
    const compiled = catalog(tokenBook(), [
      { workspace_id: null, policy: { mode: "reject_unpriced" } },
      { workspace_id: "workspace-a", policy: { mode: "compatibility" } },
      {
        workspace_id: "workspace-a",
        operation: "chat_completions",
        policy: cap,
      },
    ]);
    const first = capture(compiled);
    expect(first.admissionPolicy("chat_completions").mode).toBe(
      "reserve_upper_bound",
    );
    expect(first.admissionPolicy("embeddings").mode).toBe("compatibility");
    expect(
      capture(compiled, "workspace-b").admissionPolicy("chat_completions").mode,
    ).toBe("reject_unpriced");
    const altered = first.admissionPolicy("chat_completions");
    altered.quantity_limits!.output_tokens = "900";
    expect(
      first.admissionPolicy("chat_completions").quantity_limits!.output_tokens,
    ).toBe("3");
  });

  it.each([
    { mode: "silent_zero" },
    {
      mode: "reserve_upper_bound",
      quantity_limits: { output_tokens: 10 },
      limit_reference: "synthetic",
    },
    {
      mode: "reserve_upper_bound",
      quantity_limits: { output_tokens: "-1" },
      limit_reference: "synthetic",
    },
    {
      mode: "reserve_upper_bound",
      quantity_limits: { output_tokens: "1.5" },
      limit_reference: "synthetic",
    },
    {
      mode: "reserve_upper_bound",
      quantity_limits: { unknown: "1" },
      limit_reference: "synthetic",
    },
    { mode: "reserve_upper_bound", quantity_limits: { output_tokens: "1" } },
    { mode: "reserve_upper_bound", fallback_money_override: "0" },
  ])(
    "rejects invalid or unapproved bounds rather than coercing an unknown/free price: %j",
    (input) => {
      const reader = new PricingSchemaReader();
      parseAdmissionPolicy(input, reader);
      expect(reader.diagnostics.length).toBeGreaterThan(0);
    },
  );

  it("never treats a requested media duration/count or an input-token heuristic as actual quantity bounds", () => {
    const request = normalizeQuantities(
      [
        { dimension: "requested_video_seconds", value: "6.4" },
        { dimension: "requested_image_count", value: "4" },
        {
          dimension: "total_input_tokens",
          value: "100",
          quality: "estimated",
          source: "heuristic",
        },
      ],
      { adapter_id: "test", adapter_version: "1", source: "request_metadata" },
    );
    const { bounds } = reservationQuantityBounds(
      { mode: "reserve_upper_bound" },
      request,
    );
    expect(bounds.requested_video_seconds?.value).toBe("6.4");
    expect(bounds.requested_image_count?.value).toBe("4");
    expect(bounds.video_seconds).toBeUndefined();
    expect(bounds.image_count).toBeUndefined();
    expect(bounds.total_input_tokens).toBeUndefined();
    const inherited = reservationQuantityBounds(cap, request).bounds;
    expect(inherited.cache_write_1h_tokens).toEqual({
      value: "9",
      basis: "parent_quantity_limit",
      parent: "total_input_tokens",
    });
  });

  it("distinguishes missing price/FX, compatible estimates, declared bounds and observed free prices", () => {
    const content = book([rate("input", "uncached_input_tokens", "1", "1")]);
    const usage = tokens({ input_tokens: 2, output_tokens: 0 });
    for (const mode of [
      "compatibility",
      "reject_unpriced",
      "reserve_upper_bound",
    ] as const) {
      const cny = { ...content, currency: "CNY" };
      const { assessment } = assessPricingAdmission(
        capture(catalog(cny, policy({ ...cap, mode }))),
        target,
        usage,
        empty(),
        { attempt_dispatched_at: when },
        1,
      );
      expect(assessment.allowed).toBe(mode === "compatibility");
      expect(assessment.per_attempt_cost_usd).toBeNull();
    }
    const free = book([rate("free", "uncached_input_tokens", "0", "1")]);
    const result = assessPricingAdmission(
      capture(catalog(free, policy(cap))),
      target,
      usage,
      empty(),
      {},
      2,
    );
    expect(result.assessment).toMatchObject({
      allowed: true,
      guarantee: "conditional_on_declared_limits",
      reserved_cost_usd: "0.000000000000000000",
    });
    const noBounds = assessPricingAdmission(
      capture(catalog(content, policy({ mode: "reserve_upper_bound" }))),
      target,
      usage,
      empty(),
      {},
      1,
    );
    expect(noBounds.assessment).toMatchObject({
      allowed: false,
      reason: "bound_unavailable",
    });
  });

  it("degrades a pure pricing failure to unknown under compatibility, but never admits it under strict policy", () => {
    for (const mode of [
      "compatibility",
      "reject_unpriced",
      "reserve_upper_bound",
    ] as const) {
      const snapshot = capture(catalog(tokenBook(), policy({ ...cap, mode })));
      jest.spyOn(snapshot, "quote").mockImplementation(() => {
        throw new Error("injected calculator error");
      });
      const result = assessPricingAdmission(
        snapshot,
        target,
        tokens({ input_tokens: 2, output_tokens: 1 }),
        empty(),
        {},
        1,
      );
      expect(result.assessment.allowed).toBe(mode === "compatibility");
      expect(result.cost.report_amount).toBeNull();
      expect(JSON.stringify(result)).not.toContain("injected calculator error");
    }
  });

  it("bounds all cache partitions, input tiers, time windows and service levels instead of only the current price", () => {
    const content = tokenBook();
    content.calendar = {
      schema_version: 1,
      version_id: "calendar-test",
      time_zone: "UTC",
      tzdb_version: process.versions.tz ?? "unknown",
      valid_from: "2026-01-01",
      valid_to: "2027-01-01",
      default_tag: "offpeak",
      weekly: [
        {
          weekdays: [1, 2, 3, 4, 5, 6, 7],
          windows: [{ start: "09:00", end: "12:00", tag: "peak" }],
        },
      ],
      holidays: [],
      date_overrides: [],
    };
    content.groups.push({
      id: "context",
      order: 1,
      required: false,
      rules: [
        {
          id: "long",
          priority: 1,
          mode: "whole_request",
          condition: { input_tokens: { min: "5" } },
          rates: [
            {
              operation: "replace",
              component: {
                ...rate("long-input", "uncached_input_tokens", "4"),
                minimum_quantity: "3",
                quantity_rounding: { increment: "2", mode: "ceil" },
              },
            },
          ],
        },
      ],
    });
    content.groups.push({
      id: "time",
      order: 2,
      required: false,
      rules: [
        {
          id: "peak",
          priority: 0,
          mode: "whole_request",
          condition: { time_tags: ["peak"] },
          rates: [],
          multipliers: [
            { dimension: "uncached_input_tokens", factor: "2.5" },
            { dimension: "cache_write_1h_tokens", factor: "3" },
          ],
        },
      ],
    });
    content.groups.push({
      id: "tier",
      order: 3,
      required: false,
      rules: [
        {
          id: "priority",
          priority: 0,
          mode: "whole_request",
          condition: { service_tiers: ["priority"] },
          rates: [
            {
              operation: "add",
              component: rate("priority-extra", "output_tokens", "4"),
            },
          ],
        },
      ],
    });
    const compiled = compilePriceBook(content, {
      book_id: "test",
      version_id: "v1",
    });
    const envelope = compiled.reservationEnvelope(
      reservationQuantityBounds(cap, empty()).bounds,
      "USD",
    );
    expect(envelope.report_amount).not.toBeNull();
    const upper = ExactDecimal.parse(envelope.report_amount!);
    for (const input of [0, 1, 4, 5, 9])
      for (const output of [0, 1, 3])
        for (const cache of [0, Math.floor(input / 2), input])
          for (const kind of ["read", "write", "5m", "1h"])
            for (const hour of ["01", "10"])
              for (const tier of ["default", "priority"]) {
                const usage = tokens({
                  input_tokens: input,
                  output_tokens: output,
                  ...(kind === "read"
                    ? { cache_read_input_tokens: cache }
                    : {
                        cache_creation_input_tokens: cache,
                        ...(kind === "5m"
                          ? { cache_creation_5m_input_tokens: cache }
                          : kind === "1h"
                            ? { cache_creation_1h_input_tokens: cache }
                            : {}),
                      }),
                });
                const cost = calculateCost(
                  usage,
                  compiled.resolve(usage, {
                    attempt_dispatched_at: `2026-09-25T${hour}:00:00.000Z`,
                    requested_service_tier: tier,
                  }),
                );
                expect(cost.report_amount).not.toBeNull();
                expect(
                  ExactDecimal.parse(cost.report_amount!).compare(upper),
                ).toBeLessThanOrEqual(0);
              }
  });

  it("handles media minimums/rounding, replacements and discounts with outward FX rounding", () => {
    const content: PriceBookContent = {
      ...book([
        rate("seconds", "video_seconds", "0.10", "1"),
        rate("base", "video_generation_count", "0.02", "1"),
      ]),
      allow_combined_media: true,
      currency: "CNY",
    };
    content.groups[0].rules[0].rates[0].component.quantity_rounding = {
      increment: "1",
      mode: "ceil",
    };
    content.groups.push({
      id: "discount",
      order: 1,
      required: false,
      rules: [
        {
          id: "silent",
          priority: 0,
          mode: "whole_request",
          condition: { media: { audio_track: ["false"] } },
          rates: [],
          multipliers: [{ dimension: "video_seconds", factor: "0.5" }],
        },
      ],
    });
    const compiled = compilePriceBook(content, {
      book_id: "video",
      version_id: "v1",
    });
    const bounds = reservationQuantityBounds(
      {
        ...cap,
        quantity_limits: { video_seconds: "6.4", video_generation_count: "1" },
      },
      empty(),
    ).bounds;
    const fx = {
      version_id: "fx",
      source: "synthetic",
      effective_at: when,
      from_currency: "CNY",
      to_currency: "USD",
      numerator: "1",
      denominator: "7",
    };
    const envelope = compiled.reservationEnvelope(bounds, "USD", fx);
    expect(envelope.report_amount).toBe("0.102857143000000000");
    expect(envelope.fx_version_id).toBe("fx");
    const usage = normalizeQuantities(
      [
        { dimension: "video_seconds", value: "6.4" },
        { dimension: "video_generation_count", value: "1" },
      ],
      { adapter_id: "test", adapter_version: "1", source: "provider_usage" },
    );
    const actual = calculateCost(
      usage,
      compiled.resolve(usage, { media: { audio_track: "false" } }),
      { report_currency: "USD", fx },
    );
    expect(
      ExactDecimal.parse(actual.report_amount!).compare(
        ExactDecimal.parse(envelope.report_amount!),
      ),
    ).toBeLessThan(0);
  });

  it("does not move the input-tier boundary by multiplying quantities for retry allowances", () => {
    const content = book([rate("input", "uncached_input_tokens", "1", "1")]);
    content.groups.push({
      id: "long",
      order: 1,
      required: false,
      rules: [
        {
          id: "higher",
          priority: 0,
          mode: "whole_request",
          condition: { input_tokens: { min: "10" } },
          rates: [
            {
              operation: "replace",
              component: rate("longer", "uncached_input_tokens", "5", "1"),
            },
          ],
        },
      ],
    });
    const result = assessPricingAdmission(
      capture(catalog(content, policy(cap))),
      target,
      tokens({ input_tokens: 9, output_tokens: 0 }),
      empty(),
      {},
      3,
    );
    expect(result.cost.selected_rule_ids).not.toContain("higher");
    expect(result.assessment.per_attempt_cost_usd).toBe("9.000000000000000000");
    expect(result.assessment.reserved_cost_usd).toBe(
      ExactDecimal.parse(result.assessment.per_attempt_cost_usd!)
        .multiply(ExactDecimal.parse("3"))
        .toFixed(18),
    );
  });
});

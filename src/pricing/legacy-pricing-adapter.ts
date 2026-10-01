import type { ModelPricing } from "../config/gateway.config";
import { ExactDecimal } from "./exact-decimal";
import { PriceBookContent, RateComponent } from "./pricing.types";

/** Convert the existing formula, including its cache fallback, without inventing vendor ratios. */
export function legacyTokenPriceBook(pricing: ModelPricing): PriceBookContent {
  const cacheWrite =
    pricing.cache_creation_input ??
    pricing.cache_write_per_1m_tokens ??
    pricing.input;
  const cacheRead =
    pricing.cache_read_input ??
    pricing.cache_read_per_1m_tokens ??
    pricing.input;
  const prices: Array<[RateComponent["dimension"], number]> = [
    ["uncached_input_tokens", pricing.input],
    ["cache_read_tokens", cacheRead],
    ["cache_write_tokens", cacheWrite],
    ["cache_write_5m_tokens", cacheWrite],
    ["cache_write_1h_tokens", cacheWrite],
    ["output_tokens", pricing.output],
  ];
  return {
    schema_version: 1,
    currency: "USD",
    money_precision: 18,
    money_rounding: "half_even",
    source: { kind: "legacy" },
    allow_combined_media: false,
    billing_dimensions: prices.map(([dimension]) => dimension),
    groups: [
      {
        id: "legacy",
        order: 0,
        required: true,
        rules: [
          {
            id: "legacy-token-formula",
            priority: 0,
            mode: "whole_request",
            condition: {},
            rates: prices.map(([dimension, value]) => ({
              operation: "replace",
              component: {
                id: `legacy-${dimension}`,
                dimension,
                amount: legacyNumberToDecimal(value),
                unit: "token",
                unit_size: "1000000",
                free: value === 0,
              },
            })),
          },
        ],
      },
    ],
  };
}

/** Expand the shortest decimal preserving the JS numeric value; avoid toFixed binary artifacts. */
export function legacyNumberToDecimal(value: number): string {
  if (!Number.isFinite(value) || value < 0)
    throw new Error("Legacy prices must be finite nonnegative numbers");
  const raw = String(value);
  const [mantissa, exponentText] = raw.toLowerCase().split("e");
  let decimal = raw;
  if (exponentText !== undefined) {
    const exponent = Number(exponentText);
    const [whole, fraction = ""] = mantissa.split(".");
    const digits = whole + fraction;
    const point = whole.length + exponent;
    decimal =
      point <= 0
        ? `0.${"0".repeat(-point)}${digits}`
        : point >= digits.length
          ? digits + "0".repeat(point - digits.length)
          : `${digits.slice(0, point)}.${digits.slice(point)}`;
  }
  ExactDecimal.parse(decimal);
  return decimal;
}

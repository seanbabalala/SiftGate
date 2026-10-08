import { createHash } from "node:crypto";

export function canonicalPricingJson(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map(canonicalPricingJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalPricingJson(record[key])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function pricingContentHash(value: unknown): string {
  return createHash("sha256").update(canonicalPricingJson(value)).digest("hex");
}

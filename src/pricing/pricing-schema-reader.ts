import { ExactDecimal, RoundingMode } from "./exact-decimal";
import { ROUNDING_MODES } from "./pricing-validation";
import type { PricingDiagnostic } from "./pricing.types";

/** Small allowlist reader shared by versioned pricing documents. Never coerces JSON values. */
export class PricingSchemaReader {
  readonly diagnostics: PricingDiagnostic[] = [];

  invalid(
    path: string,
    message: string,
    code: PricingDiagnostic["code"] = "pricing_invalid_document",
  ): void {
    this.diagnostics.push({ path, message, code });
  }

  object(
    value: unknown,
    path: string,
    keys: readonly string[],
  ): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      this.invalid(path, "Expected an object");
      return {};
    }
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record))
      if (!keys.includes(key))
        this.invalid(`${path}.${key}`, "Unknown field is not supported");
    return record;
  }

  string(value: unknown, path: string, max = 128): string {
    if (typeof value !== "string" || !value.length || value.length > max) {
      this.invalid(
        path,
        `Expected a nonempty string of at most ${max} characters`,
      );
      return "";
    }
    return value;
  }

  boolean(value: unknown, path: string): boolean {
    if (typeof value !== "boolean")
      this.invalid(path, "Expected an explicit boolean");
    return value === true;
  }

  integer(value: unknown, path: string, min: number, max: number): number {
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < min ||
      value > max
    ) {
      this.invalid(path, `Expected an integer from ${min} to ${max}`);
      return min;
    }
    return value;
  }

  array(value: unknown, path: string, max: number): unknown[] {
    if (!Array.isArray(value) || value.length > max) {
      this.invalid(path, `Expected an array of at most ${max} items`);
      return [];
    }
    return value;
  }

  rounding(value: unknown, path: string): RoundingMode {
    if (!ROUNDING_MODES.includes(value as RoundingMode))
      this.invalid(path, "Unsupported rounding mode");
    return value as RoundingMode;
  }

  decimal(
    value: unknown,
    path: string,
    positive: boolean,
    integral = false,
  ): string {
    const text = this.string(value, path);
    try {
      const parsed = ExactDecimal.parse(text);
      if (
        parsed.compare(ExactDecimal.zero) < (positive ? 1 : 0) ||
        (integral && !parsed.isInteger())
      ) {
        this.invalid(
          path,
          "Decimal has an invalid sign or integral requirement",
        );
      }
    } catch (error) {
      this.invalid(path, (error as Error).message);
    }
    return text;
  }
}

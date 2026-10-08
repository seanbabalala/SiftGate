import type { PricingDiagnostic } from "./pricing.types";

export class PricingCompileError extends Error {
  constructor(readonly diagnostics: PricingDiagnostic[]) {
    super(
      diagnostics.map((entry) => `${entry.path}: ${entry.message}`).join("; "),
    );
    this.name = "PricingCompileError";
  }
}

/** Display metadata only. Absence stays absent to preserve historical hashes. */
export function validPricingRuleName(value: unknown): value is string {
  return typeof value === "string" && value.length <= 128 && value.trim().length > 0 && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}

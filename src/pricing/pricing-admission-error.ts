import { PublicGatewayError } from "../http/public-error-handling";
import type { PricingAdmissionAssessment } from "./pricing-admission.types";

export class PricingAdmissionError extends PublicGatewayError {
  constructor(assessment: PricingAdmissionAssessment) {
    super(
      "Request rejected by the configured pricing admission policy; an approved price, supported variant and applicable quantity bounds are required.",
      {
        statusCode: 422,
        type: "pricing_error",
        code:
          assessment.reason === "token_budget_incompatible"
            ? "pricing_token_budget_incompatible"
            : assessment.reason === "pricing_unavailable"
            ? "pricing_admission_unpriced"
            : assessment.reason === "request_exceeds_declared_limit"
              ? "pricing_reservation_limit_exceeded"
              : "pricing_reservation_bound_missing",
        // Public callers do not receive the administrator's rate envelope or private contract reference.
        details: {
          reason: assessment.reason,
          diagnostics: assessment.diagnostics.map(({ code, path }) => ({
            code,
            path,
          })),
        },
      },
    );
  }
}

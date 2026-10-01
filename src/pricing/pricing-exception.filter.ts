import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  Injectable,
} from "@nestjs/common";
import type { Response } from "express";
import { PricingCompileError } from "./pricing-errors";
import { PricingRepositoryError } from "./pricing-repository.types";
import { ManagementAuditService } from "../audit/management-audit.service";

@Injectable()
@Catch(PricingCompileError, PricingRepositoryError)
export class PricingExceptionFilter implements ExceptionFilter {
  constructor(private readonly audit: ManagementAuditService) {}
  async catch(
    error: PricingCompileError | PricingRepositoryError,
    host: ArgumentsHost,
  ): Promise<void> {
    const status = error instanceof PricingRepositoryError ? error.status : 400;
    const code =
      error instanceof PricingRepositoryError
        ? error.code
        : (error.diagnostics[0]?.code ?? "pricing_invalid_document");
    if (status === 403) {
      const request = host
        .switchToHttp()
        .getRequest<{
          dashboardUserId?: string;
          workspaceId?: string;
          path?: string;
        }>();
      await this.audit.recordDenied({
        actor: { type: "dashboard", id: request.dashboardUserId },
        workspaceId: request.workspaceId,
        action: "pricing.action.denied",
        resourceType: "pricing",
        resourceId: request.path,
        reason: error.message,
      });
    }
    host
      .switchToHttp()
      .getResponse<Response>()
      .status(status)
      .json({
        error: { type: "pricing_error", code, message: error.message },
        ...(error instanceof PricingCompileError
          ? { diagnostics: error.diagnostics }
          : {}),
      });
  }
}

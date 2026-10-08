import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import type { Request } from "express";
import { ConfigService } from "../config/config.service";
import { PricingRepositoryError } from "./pricing-repository.types";
import { resolvePricingLimits } from "../config/pricing-limits";
import { assertPricingRequestSize } from "./pricing-resource-limits";

@Injectable()
export class PricingWriteGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (req.method === "GET" || req.method === "HEAD") return true;
    if (!req.is("application/json"))
      this.reject("Pricing actions require an application/json body");
    const origin = req.get("origin");
    const allowed = this.config.server.cors?.origin;
    const explicitlyAllowed =
      typeof origin === "string" &&
      (typeof allowed === "string"
        ? allowed === origin
        : Array.isArray(allowed) && allowed.includes(origin));
    if (origin) {
      let sameHost = false;
      try {
        const url = new URL(origin);
        sameHost =
          (url.protocol === "https:" || url.protocol === "http:") &&
          url.host === req.get("host");
      } catch {
        /* Invalid origins are rejected below. */
      }
      if (!sameHost && !explicitlyAllowed)
        this.reject("Cross-origin pricing actions are not allowed");
    }
    if (req.get("sec-fetch-site") === "cross-site" && !explicitlyAllowed)
      this.reject("Cross-site pricing actions are not allowed");
    assertPricingRequestSize(req.body, resolvePricingLimits(this.config.pricingLimits));
    return true;
  }
  private reject(message: string): never {
    throw new PricingRepositoryError("pricing_permission_denied", message, 403);
  }
}

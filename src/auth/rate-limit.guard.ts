import {
  CanActivate,
  ExecutionContext,
  Injectable,
  HttpException,
  HttpStatus,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '../config/config.service';
import { StateBackendService } from '../state/state-backend.service';
import { normalizeWorkspaceId } from '../workspaces/workspace-scope';
import { GatewayDenialService } from '../governance/gateway-denial.service';

interface WindowEntry {
  timestamps: number[];
}

/**
 * Sliding-window rate limiter.
 * Rate limits by immutable Gateway API key id (if authenticated) or by IP.
 * Runs AFTER ApiKeyGuard so req.gatewayApiKey/request api key fields are available.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  // key → sliding window timestamps
  private readonly windows = new Map<string, WindowEntry>();
  private lastCleanup = Date.now();

  constructor(
    private readonly config: ConfigService,
    @Optional() private readonly state?: StateBackendService,
    @Optional() private readonly denials?: GatewayDenialService,
  ) {}

  /**
   * A per-key limit is a governance control, so its refusals are recorded.
   * Anonymous per-IP limits are not: there is no governed identity, and
   * recording them would let unauthenticated traffic drive database writes.
   */
  private recordKeyRateLimit(request: {
    apiKeyId?: string;
    apiKeyName?: string;
    workspaceId?: string;
    gatewayApiKey?: {
      id?: string;
      name?: string;
      workspace_id?: string | null;
      namespace_id?: string | null;
      team_id?: string | null;
    };
  }): void {
    const apiKeyId = request.apiKeyId || request.gatewayApiKey?.id;
    const apiKeyName = request.apiKeyName || request.gatewayApiKey?.name;
    if (!this.denials || (!apiKeyId && !apiKeyName)) return;
    this.denials.record({
      reason: 'rate_limited',
      statusCode: HttpStatus.TOO_MANY_REQUESTS,
      workspaceId: request.workspaceId || request.gatewayApiKey?.workspace_id || null,
      apiKeyId: apiKeyId || null,
      apiKeyName: apiKeyName || null,
      namespaceId: request.gatewayApiKey?.namespace_id || null,
      teamId: request.gatewayApiKey?.team_id || null,
    });
  }

  canActivate(context: ExecutionContext): boolean | Promise<boolean> {
    if (this.state?.isRedisConfigured()) {
      return this.canActivateShared(context);
    }
    return this.canActivateMemory(context);
  }

  private async canActivateShared(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const response = context.switchToHttp().getResponse();
    const rateLimit = this.config.auth?.rate_limit;
    const gatewayApiKey:
      | { id?: string; name: string; rate_limit_per_minute: number | null; workspace_id?: string | null }
      | undefined = request.gatewayApiKey;

    const apiKeyId: string | undefined = request.apiKeyId || gatewayApiKey?.id;
    const apiKeyName: string | undefined = request.apiKeyName;
    const ip: string = request.ip || request.connection?.remoteAddress || 'unknown';
    const workspaceId = normalizeWorkspaceId(request.workspaceId || gatewayApiKey?.workspace_id);

    const key = apiKeyId ? `key:${apiKeyId}` : apiKeyName ? `key-name:${apiKeyName}` : `ip:${ip}`;
    const limit = gatewayApiKey?.rate_limit_per_minute
      ?? (apiKeyName ? rateLimit?.requests_per_minute : rateLimit?.requests_per_minute_ip);
    if (!limit) return true; // Not configured → no limit

    const now = Date.now();
    const windowMs = 60_000; // 1 minute
    const result = await this.state!.hitRateLimit('rate_limit', key, limit, windowMs, now, {
      workspaceId,
    });

    response.setHeader('X-RateLimit-Limit', String(limit));
    response.setHeader('X-RateLimit-Remaining', String(result.remaining));
    response.setHeader('X-RateLimit-Reset', String(result.resetAt));
    if (result.degraded) {
      response.setHeader('X-RateLimit-State-Backend', 'degraded');
    }

    if (!result.allowed) {
      response.setHeader('Retry-After', String(Math.max(1, result.retryAfterSec)));
      this.recordKeyRateLimit(request);
      throw new HttpException(
        {
          error: {
            message: this.state!.shouldFailClosed()
              ? 'Rate limit state backend unavailable.'
              : `Rate limit exceeded. Max ${limit} requests per minute.`,
            type: 'rate_limit_exceeded',
          },
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return true;
  }

  private canActivateMemory(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const response = context.switchToHttp().getResponse();
    const rateLimit = this.config.auth?.rate_limit;
    const gatewayApiKey:
      | { id?: string; name: string; rate_limit_per_minute: number | null }
      | undefined = request.gatewayApiKey;

    const apiKeyId: string | undefined = request.apiKeyId || gatewayApiKey?.id;
    const apiKeyName: string | undefined = request.apiKeyName;
    const ip: string = request.ip || request.connection?.remoteAddress || 'unknown';

    const key = apiKeyId ? `key:${apiKeyId}` : apiKeyName ? `key-name:${apiKeyName}` : `ip:${ip}`;
    const limit = gatewayApiKey?.rate_limit_per_minute
      ?? (apiKeyName ? rateLimit?.requests_per_minute : rateLimit?.requests_per_minute_ip);
    if (!limit) return true; // Not configured → no limit

    const now = Date.now();
    const windowMs = 60_000; // 1 minute
    const windowStart = now - windowMs;

    // Periodic cleanup of stale entries (every 2 minutes)
    if (now - this.lastCleanup > 120_000) {
      this.cleanup(windowStart);
      this.lastCleanup = now;
    }

    // Get or create window
    let entry = this.windows.get(key);
    if (!entry) {
      // Enforce max_entries cap with FIFO eviction
      const maxEntries = rateLimit?.max_entries ?? 10_000;
      if (this.windows.size >= maxEntries) {
        const oldest = this.windows.keys().next().value;
        if (oldest !== undefined) {
          this.windows.delete(oldest);
        }
      }
      entry = { timestamps: [] };
      this.windows.set(key, entry);
    }

    // Trim timestamps outside the window
    entry.timestamps = entry.timestamps.filter((t) => t > windowStart);

    // Check limit
    const remaining = Math.max(0, limit - entry.timestamps.length);
    const resetAt = entry.timestamps.length > 0
      ? Math.ceil((entry.timestamps[0] + windowMs) / 1000)
      : Math.ceil((now + windowMs) / 1000);

    // Set standard rate limit headers
    response.setHeader('X-RateLimit-Limit', String(limit));
    response.setHeader('X-RateLimit-Remaining', String(remaining));
    response.setHeader('X-RateLimit-Reset', String(resetAt));

    if (entry.timestamps.length >= limit) {
      const retryAfterSec = Math.ceil((entry.timestamps[0] + windowMs - now) / 1000);
      response.setHeader('Retry-After', String(Math.max(1, retryAfterSec)));
      this.recordKeyRateLimit(request);
      throw new HttpException(
        {
          error: {
            message: `Rate limit exceeded. Max ${limit} requests per minute.`,
            type: 'rate_limit_exceeded',
          },
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // Record this request
    entry.timestamps.push(now);
    // Update remaining after recording
    response.setHeader('X-RateLimit-Remaining', String(remaining - 1));

    return true;
  }

  /** Remove entries that have no recent timestamps */
  private cleanup(windowStart: number): void {
    for (const [key, entry] of this.windows) {
      entry.timestamps = entry.timestamps.filter((t) => t > windowStart);
      if (entry.timestamps.length === 0) {
        this.windows.delete(key);
      }
    }
  }
}

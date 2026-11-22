import { HttpException, HttpStatus } from '@nestjs/common';
import { RateLimitGuard } from '../../src/auth/rate-limit.guard';
import { mockConfigService } from '../helpers';

function makeContext(overrides: {
  apiKeyId?: string;
  apiKeyName?: string;
  ip?: string;
  gatewayApiKey?: { id?: string; name: string; rate_limit_per_minute: number | null };
} = {}): any {
  const request: any = {
    apiKeyId: overrides.apiKeyId,
    apiKeyName: overrides.apiKeyName,
    gatewayApiKey: overrides.gatewayApiKey,
    ip: overrides.ip || '127.0.0.1',
    connection: { remoteAddress: overrides.ip || '127.0.0.1' },
  };
  const headers: Record<string, string> = {};
  const response: any = {
    setHeader: jest.fn((name: string, value: string) => { headers[name] = value; }),
    _headers: headers,
  };
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
    _response: response,
    _headers: headers,
  };
}

describe('RateLimitGuard', () => {
  it('should allow all requests when rate_limit is not configured', () => {
    const config = mockConfigService({ auth: { api_keys: [], rate_limit: undefined } });
    const guard = new RateLimitGuard(config);
    const ctx = makeContext();
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('should allow requests within the limit', () => {
    const config = mockConfigService({
      auth: {
        api_keys: [],
        rate_limit: { requests_per_minute: 5, requests_per_minute_ip: 3 },
      },
    });
    const guard = new RateLimitGuard(config);

    for (let i = 0; i < 3; i++) {
      const ctx = makeContext({ ip: '10.0.0.1' });
      expect(guard.canActivate(ctx)).toBe(true);
    }
  });

  it('should throw 429 when limit is exceeded', () => {
    const config = mockConfigService({
      auth: {
        api_keys: [],
        rate_limit: { requests_per_minute: 60, requests_per_minute_ip: 2 },
      },
    });
    const guard = new RateLimitGuard(config);

    // Use 2 allowed requests
    guard.canActivate(makeContext({ ip: '10.0.0.1' }));
    guard.canActivate(makeContext({ ip: '10.0.0.1' }));

    // 3rd request should fail
    try {
      guard.canActivate(makeContext({ ip: '10.0.0.1' }));
      fail('Expected HttpException');
    } catch (e) {
      expect(e).toBeInstanceOf(HttpException);
      expect((e as HttpException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    }
  });

  it('should use per-key limit when API key name is present', () => {
    const config = mockConfigService({
      auth: {
        api_keys: [],
        rate_limit: { requests_per_minute: 3, requests_per_minute_ip: 1 },
      },
    });
    const guard = new RateLimitGuard(config);

    // Per-key limit is 3 (not the per-IP limit of 1)
    expect(guard.canActivate(makeContext({ apiKeyName: 'my-app', ip: '10.0.0.1' }))).toBe(true);
    expect(guard.canActivate(makeContext({ apiKeyName: 'my-app', ip: '10.0.0.1' }))).toBe(true);
    expect(guard.canActivate(makeContext({ apiKeyName: 'my-app', ip: '10.0.0.1' }))).toBe(true);

    // 4th request with same key should fail
    try {
      guard.canActivate(makeContext({ apiKeyName: 'my-app', ip: '10.0.0.1' }));
      fail('Expected HttpException');
    } catch (e) {
      expect(e).toBeInstanceOf(HttpException);
    }
  });

  it('should track generated Gateway API keys by immutable id', () => {
    const config = mockConfigService({
      auth: {
        api_keys: [],
        rate_limit: { requests_per_minute: 2, requests_per_minute_ip: 1 },
      },
    });
    const guard = new RateLimitGuard(config);

    expect(guard.canActivate(makeContext({ apiKeyId: 'key_a', apiKeyName: 'same-name' }))).toBe(true);
    expect(guard.canActivate(makeContext({ apiKeyId: 'key_a', apiKeyName: 'same-name' }))).toBe(true);
    expect(guard.canActivate(makeContext({ apiKeyId: 'key_b', apiKeyName: 'same-name' }))).toBe(true);

    try {
      guard.canActivate(makeContext({ apiKeyId: 'key_a', apiKeyName: 'same-name' }));
      fail('Expected HttpException');
    } catch (e) {
      expect(e).toBeInstanceOf(HttpException);
      expect((e as HttpException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    }
  });

  it('should use a Gateway API key specific RPM override when configured', () => {
    const config = mockConfigService({
      auth: {
        api_keys: [],
        rate_limit: { requests_per_minute: 60, requests_per_minute_ip: 1 },
      },
    });
    const guard = new RateLimitGuard(config);
    const gatewayApiKey = { id: 'key_limited', name: 'limited', rate_limit_per_minute: 1 };

    expect(guard.canActivate(makeContext({ gatewayApiKey, apiKeyId: 'key_limited', apiKeyName: 'limited' }))).toBe(true);
    expect(() =>
      guard.canActivate(makeContext({ gatewayApiKey, apiKeyId: 'key_limited', apiKeyName: 'limited' })),
    ).toThrow(HttpException);
  });

  it('should set rate limit headers', () => {
    const config = mockConfigService({
      auth: {
        api_keys: [],
        rate_limit: { requests_per_minute: 60, requests_per_minute_ip: 10 },
      },
    });
    const guard = new RateLimitGuard(config);
    const ctx = makeContext({ ip: '10.0.0.2' });

    guard.canActivate(ctx);

    const setHeader = ctx._response.setHeader;
    expect(setHeader).toHaveBeenCalledWith('X-RateLimit-Limit', '10');
    expect(setHeader).toHaveBeenCalledWith('X-RateLimit-Remaining', expect.any(String));
    expect(setHeader).toHaveBeenCalledWith('X-RateLimit-Reset', expect.any(String));
  });

  it('should track different IPs separately', () => {
    const config = mockConfigService({
      auth: {
        api_keys: [],
        rate_limit: { requests_per_minute: 60, requests_per_minute_ip: 1 },
      },
    });
    const guard = new RateLimitGuard(config);

    // Each IP gets 1 request
    expect(guard.canActivate(makeContext({ ip: '10.0.0.1' }))).toBe(true);
    expect(guard.canActivate(makeContext({ ip: '10.0.0.2' }))).toBe(true);

    // Second request from same IP should fail
    try {
      guard.canActivate(makeContext({ ip: '10.0.0.1' }));
      fail('Expected HttpException');
    } catch (e) {
      expect(e).toBeInstanceOf(HttpException);
    }
  });

  // ===== max_entries cap tests =====

  it('should evict oldest entry when max_entries is reached', () => {
    const config = mockConfigService({
      auth: {
        api_keys: [],
        rate_limit: {
          requests_per_minute: 60,
          requests_per_minute_ip: 10,
          max_entries: 3,
        },
      },
    });
    const guard = new RateLimitGuard(config);

    // Fill up 3 entries (the max)
    guard.canActivate(makeContext({ ip: '10.0.0.1' }));
    guard.canActivate(makeContext({ ip: '10.0.0.2' }));
    guard.canActivate(makeContext({ ip: '10.0.0.3' }));

    // 4th unique IP should work — evicts '10.0.0.1'
    expect(guard.canActivate(makeContext({ ip: '10.0.0.4' }))).toBe(true);

    // Access the internal windows map to verify eviction
    const windows = (guard as any).windows as Map<string, unknown>;
    expect(windows.has('ip:10.0.0.1')).toBe(false);
    expect(windows.has('ip:10.0.0.4')).toBe(true);
    expect(windows.size).toBeLessThanOrEqual(3);
  });

  it('should still work correctly after eviction', () => {
    const config = mockConfigService({
      auth: {
        api_keys: [],
        rate_limit: {
          requests_per_minute: 60,
          requests_per_minute_ip: 2,
          max_entries: 2,
        },
      },
    });
    const guard = new RateLimitGuard(config);

    // Fill both entries
    guard.canActivate(makeContext({ ip: '10.0.0.1' }));
    guard.canActivate(makeContext({ ip: '10.0.0.2' }));

    // New IP evicts oldest, then should track correctly
    guard.canActivate(makeContext({ ip: '10.0.0.3' }));
    guard.canActivate(makeContext({ ip: '10.0.0.3' })); // 2nd request for this IP

    // 3rd request for 10.0.0.3 should be rate-limited
    try {
      guard.canActivate(makeContext({ ip: '10.0.0.3' }));
      fail('Expected HttpException');
    } catch (e) {
      expect(e).toBeInstanceOf(HttpException);
      expect((e as HttpException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    }
  });

  it('should default to 10000 max_entries when not configured', () => {
    const config = mockConfigService({
      auth: {
        api_keys: [],
        rate_limit: {
          requests_per_minute: 60,
          requests_per_minute_ip: 10,
          // no max_entries — should default to 10000
        },
      },
    });
    const guard = new RateLimitGuard(config);

    // Just verify it doesn't evict with a small number of entries
    for (let i = 0; i < 50; i++) {
      guard.canActivate(makeContext({ ip: `10.0.${Math.floor(i / 256)}.${i % 256}` }));
    }

    const windows = (guard as any).windows as Map<string, unknown>;
    expect(windows.size).toBe(50);
  });

  it('should use shared state backend when Redis is configured', async () => {
    const config = mockConfigService({
      auth: {
        api_keys: [],
        rate_limit: { requests_per_minute: 60, requests_per_minute_ip: 2 },
      },
    });
    const state = {
      isRedisConfigured: jest.fn().mockReturnValue(true),
      shouldFailClosed: jest.fn().mockReturnValue(false),
      hitRateLimit: jest.fn().mockResolvedValue({
        allowed: false,
        count: 3,
        limit: 2,
        remaining: 0,
        resetAt: 123,
        retryAfterSec: 30,
        degraded: false,
      }),
    };
    const guard = new RateLimitGuard(config, state as any);

    await expect(
      guard.canActivate(makeContext({ ip: '10.0.0.9' })) as Promise<boolean>,
    ).rejects.toBeInstanceOf(HttpException);
    expect(state.hitRateLimit).toHaveBeenCalledWith(
      'rate_limit',
      'ip:10.0.0.9',
      2,
      60_000,
      expect.any(Number),
      { workspaceId: 'default-workspace' },
    );
  });

  describe('governance denial records', () => {
    const limited = () =>
      mockConfigService({ auth: { api_keys: [], rate_limit: { requests_per_minute: 60, requests_per_minute_ip: 1 } } });

    it('records a per-key rate-limit refusal with the key identity only', () => {
      const denials = { record: jest.fn() };
      const guard = new RateLimitGuard(limited(), undefined, denials as any);
      const key = { id: 'key-1', name: 'ci-agent', rate_limit_per_minute: 1, workspace_id: 'ws-a', namespace_id: 'ns-1', team_id: 'team-1' };
      guard.canActivate(makeContext({ apiKeyId: 'key-1', apiKeyName: 'ci-agent', gatewayApiKey: key as any }));
      expect(() =>
        guard.canActivate(makeContext({ apiKeyId: 'key-1', apiKeyName: 'ci-agent', gatewayApiKey: key as any })),
      ).toThrow(HttpException);
      expect(denials.record).toHaveBeenCalledTimes(1);
      expect(denials.record).toHaveBeenCalledWith({
        reason: 'rate_limited',
        statusCode: 429,
        // The key's own workspace when the request carries none.
        workspaceId: 'ws-a',
        apiKeyId: 'key-1',
        apiKeyName: 'ci-agent',
        namespaceId: 'ns-1',
        teamId: 'team-1',
      });
    });

    it('does not record anonymous per-IP refusals', () => {
      const denials = { record: jest.fn() };
      const guard = new RateLimitGuard(limited(), undefined, denials as any);
      guard.canActivate(makeContext({ ip: '10.9.9.9' }));
      expect(() => guard.canActivate(makeContext({ ip: '10.9.9.9' }))).toThrow(HttpException);
      expect(denials.record).not.toHaveBeenCalled();
    });

    it('does not record allowed requests', () => {
      const denials = { record: jest.fn() };
      const guard = new RateLimitGuard(limited(), undefined, denials as any);
      guard.canActivate(makeContext({ apiKeyId: 'key-2', apiKeyName: 'ok', gatewayApiKey: { id: 'key-2', name: 'ok', rate_limit_per_minute: 5 } }));
      expect(denials.record).not.toHaveBeenCalled();
    });
  });
});

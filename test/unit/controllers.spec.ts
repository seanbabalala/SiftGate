/**
 * Controller-layer unit tests.
 *
 * Tests AuthController, HealthController, and ModelsController
 * in isolation with mocked dependencies.
 */

import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { AuthController } from '../../src/auth/auth.controller';
import { HealthController } from '../../src/dashboard/health.controller';
import { ModelsController } from '../../src/ingest/models.controller';
import { CircuitState } from '../../src/routing/circuit-breaker.service';
import { mockConfigService } from '../helpers';

// ═══════════════════════════════════════════════════════════
// AuthController
// ═══════════════════════════════════════════════════════════

describe('AuthController', () => {
  function makeAuthService(overrides: Record<string, unknown> = {}): any {
    return {
      isAuthRequired: true,
      isLocalPasswordAuthEnabled: true,
      verifyPassword: jest.fn().mockResolvedValue(true),
      generateToken: jest.fn().mockReturnValue('jwt-token-123'),
      verifyToken: jest.fn().mockReturnValue(null),
      config: { dashboardPasswordHash: '$2b$10$hashedvalue' },
      ...overrides,
    };
  }

  function makeReq(ip = '127.0.0.1'): any {
    return { ip, connection: { remoteAddress: ip } };
  }

  it('should return empty token when auth is not required', async () => {
    const authService = makeAuthService({
      isAuthRequired: false,
      isLocalPasswordAuthEnabled: false,
    });
    const config = mockConfigService();
    const controller = new AuthController(authService, config);
    const result = await controller.login(makeReq(), { password: 'anything' });
    expect(result).toEqual({ token: '' });
  });

  it('should reject local login when auth requires OIDC', async () => {
    const authService = makeAuthService({
      isAuthRequired: true,
      isLocalPasswordAuthEnabled: false,
    });
    const config = mockConfigService();
    const controller = new AuthController(authService, config);
    await expect(
      controller.login(makeReq(), { password: 'anything' }),
    ).rejects.toMatchObject({
      response: {
        error: {
          type: 'local_login_disabled',
        },
      },
    });
  });

  it('should throw UnauthorizedException when password is missing', async () => {
    const authService = makeAuthService();
    const config = mockConfigService();
    const controller = new AuthController(authService, config);
    await expect(controller.login(makeReq(), {})).rejects.toThrow(UnauthorizedException);
  });

  it('should throw UnauthorizedException for invalid password', async () => {
    const authService = makeAuthService({
      verifyPassword: jest.fn().mockResolvedValue(false),
    });
    const config = mockConfigService();
    const controller = new AuthController(authService, config);
    await expect(controller.login(makeReq(), { password: 'wrong' })).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('should return JWT token for valid password', async () => {
    const authService = makeAuthService();
    const config = mockConfigService();
    const controller = new AuthController(authService, config);
    const result = await controller.login(makeReq(), { password: 'correct' });
    expect(result.token).toBe('jwt-token-123');
    expect(authService.verifyPassword).toHaveBeenCalledWith(
      'correct',
      '$2b$10$hashedvalue',
    );
    expect(authService.generateToken).toHaveBeenCalled();
  });

  it('GET /api/auth/status should return authRequired status', () => {
    const authService = makeAuthService({ isAuthRequired: true });
    const config = mockConfigService();
    const controller = new AuthController(authService, config);
    expect(controller.getStatus()).toEqual({
      identity: { mode: 'legacy', setupRequired: false, activationExpired: false },
      authRequired: true,
      authenticated: false,
      localLoginEnabled: true,
      oidc: {
        enabled: false,
        issuer: null,
        client_id: null,
        scopes: [],
      },
    });
  });

  it('GET /api/auth/status should reflect no-auth config', () => {
    const authService = makeAuthService({
      isAuthRequired: false,
      isLocalPasswordAuthEnabled: false,
    });
    const config = mockConfigService();
    const controller = new AuthController(authService, config);
    expect(controller.getStatus()).toEqual({
      identity: { mode: 'legacy', setupRequired: false, activationExpired: false },
      authRequired: false,
      authenticated: false,
      localLoginEnabled: false,
      oidc: {
        enabled: false,
        issuer: null,
        client_id: null,
        scopes: [],
      },
    });
  });
});

// ═══════════════════════════════════════════════════════════
// HealthController
// ═══════════════════════════════════════════════════════════

describe('HealthController', () => {
  function makeCircuitBreaker(
    nodeStates: Record<string, CircuitState> = {},
  ): any {
    return {
      getNodeStatus: jest.fn().mockImplementation((nodeId: string) => ({
        state: nodeStates[nodeId] || CircuitState.CLOSED,
        consecutiveFailures: nodeStates[nodeId] === CircuitState.OPEN ? 3 : 0,
        lastFailureAt: nodeStates[nodeId] === CircuitState.OPEN ? Date.now() : null,
      })),
      getModelStatuses: jest.fn().mockReturnValue({}),
    };
  }

  function makeBudgetService(status: any[] = []): any {
    return {
      getStatus: jest.fn().mockResolvedValue(status),
    };
  }

  function makeConcurrencyLimiter(): any {
    return {
      getNodeStats: jest.fn().mockImplementation((node: any) => ({
        node: node.id,
        max_concurrency: node.max_concurrency ?? null,
        queue_timeout_ms: node.queue_timeout_ms ?? 10000,
        queue_policy: node.queue_policy ?? 'wait',
        active: 0,
        queued: 0,
      })),
    };
  }

  function makeActiveHealthService(
    statuses: Record<string, any> = {},
  ): any {
    return {
      getNodeStatus: jest.fn().mockImplementation((nodeId: string) => ({
        enabled: false,
        status: 'disabled',
        method: null,
        target: null,
        last_checked_at: null,
        last_success_at: null,
        latency_ms: null,
        failure_reason: null,
        consecutive_failures: 0,
        ...statuses[nodeId],
      })),
    };
  }

  it('should return healthy when all nodes are CLOSED', async () => {
    const config = mockConfigService({
      nodes: [
        { id: 'openai', name: 'OpenAI', protocol: 'chat_completions', models: ['gpt-4o'] },
        { id: 'claude', name: 'Claude', protocol: 'messages', models: ['claude-3-opus'] },
      ],
    });
    const cb = makeCircuitBreaker();
    const activeHealth = makeActiveHealthService();
    const budget = makeBudgetService();

    const controller = new HealthController(config, cb, makeConcurrencyLimiter(), activeHealth, budget);
    const result = await controller.check();

    expect(result.status).toBe('healthy');
    expect(result.nodes).toHaveLength(2);
    expect(result.nodes[0].healthy).toBe(true);
    expect(result.nodes[1].healthy).toBe(true);
    expect(result.nodes[0].concurrency).toEqual(
      expect.objectContaining({ active: 0, queued: 0 }),
    );
    expect(result.uptime_ms).toBeGreaterThanOrEqual(0);
    expect(result.uptime_human).toBeDefined();
    expect(result.timestamp).toBeDefined();
    expect(result.database).toMatchObject({
      healthy: true,
      type: 'sqlite',
      connected: true,
    });
  });

  it('should report degraded health but not conflate provider and database readiness', async () => {
    const config = mockConfigService({
      nodes: [{ id: 'n1', name: 'N1', protocol: 'chat_completions', models: ['m1'] }],
    });
    const cb = makeCircuitBreaker({ n1: CircuitState.OPEN });
    const activeHealth = makeActiveHealthService();
    const budget = makeBudgetService();
    const databaseHealth = {
      check: jest.fn().mockResolvedValue({
        healthy: true,
        type: 'sqlite',
        target: ':memory:',
        connected: true,
        latency_ms: 1,
        checked_at: '2026-05-09T00:00:00.000Z',
        error: null,
        synchronize: true,
      }),
    };

    const controller = new HealthController(
      config,
      cb,
      makeConcurrencyLimiter(),
      activeHealth,
      budget,
      undefined,
      undefined,
      databaseHealth as any,
    );

    const health = await controller.check();
    const ready = await controller.ready();

    expect(health.status).toBe('degraded');
    expect(health.database.healthy).toBe(true);
    expect(ready).toMatchObject({ ready: true, status: 'ready' });
  });

  it('should fail readiness when the database is unavailable', async () => {
    const config = mockConfigService({
      nodes: [{ id: 'n1', name: 'N1', protocol: 'chat_completions', models: ['m1'] }],
    });
    const cb = makeCircuitBreaker();
    const activeHealth = makeActiveHealthService();
    const budget = makeBudgetService();
    const databaseHealth = {
      check: jest.fn().mockResolvedValue({
        healthy: false,
        type: 'postgres',
        target: 'postgresql://siftgate:***@db:5432/siftgate',
        connected: false,
        latency_ms: null,
        checked_at: '2026-05-09T00:00:00.000Z',
        error: 'connect ECONNREFUSED',
        synchronize: false,
      }),
    };
    const controller = new HealthController(
      config,
      cb,
      makeConcurrencyLimiter(),
      activeHealth,
      budget,
      undefined,
      undefined,
      databaseHealth as any,
    );

    const health = await controller.check();
    await expect(controller.ready()).rejects.toMatchObject({ status: 503 });
    expect(health.status).toBe('degraded');
    expect(health.database).toMatchObject({
      healthy: false,
      type: 'postgres',
      connected: false,
    });
  });

  it('should return degraded when a node is OPEN', async () => {
    const config = mockConfigService({
      nodes: [
        { id: 'openai', name: 'OpenAI', protocol: 'chat_completions', models: ['gpt-4o'] },
        { id: 'claude', name: 'Claude', protocol: 'messages', models: ['claude-3-opus'] },
      ],
    });
    const cb = makeCircuitBreaker({ openai: CircuitState.OPEN });
    const activeHealth = makeActiveHealthService();
    const budget = makeBudgetService();

    const controller = new HealthController(config, cb, makeConcurrencyLimiter(), activeHealth, budget);
    const result = await controller.check();

    expect(result.status).toBe('degraded');
    expect(result.nodes[0].healthy).toBe(false);
    expect(result.nodes[0].circuit).toBe(CircuitState.OPEN);
    expect(result.nodes[1].healthy).toBe(true);
  });

  it('should include budget status', async () => {
    const config = mockConfigService({
      nodes: [{ id: 'n1', name: 'N1', protocol: 'chat_completions', models: ['m1'] }],
    });
    const cb = makeCircuitBreaker();
    const activeHealth = makeActiveHealthService();
    const budget = makeBudgetService([
      { type: 'tokens', current: 500, limit: 1000, percentage: 0.5, isExceeded: false, isAlert: false },
    ]);

    const controller = new HealthController(config, cb, makeConcurrencyLimiter(), activeHealth, budget);
    const result = await controller.check();

    expect(result.budget).toHaveLength(1);
    expect(result.budget[0].type).toBe('tokens');
    expect(result.budget[0].percentage).toBe(50);
    expect(result.budget[0].exceeded).toBe(false);
  });

  it('should handle budget service errors gracefully', async () => {
    const config = mockConfigService({
      nodes: [{ id: 'n1', name: 'N1', protocol: 'chat_completions', models: ['m1'] }],
    });
    const cb = makeCircuitBreaker();
    const activeHealth = makeActiveHealthService();
    const budget = {
      getStatus: jest.fn().mockRejectedValue(new Error('DB down')),
    };

    const controller = new HealthController(config, cb, makeConcurrencyLimiter(), activeHealth, budget as any);
    const result = await controller.check();

    expect(result.status).toBe('healthy');
    expect(result.budget).toEqual([]);
  });

  it('should include node metadata', async () => {
    const config = mockConfigService({
      nodes: [
        { id: 'openai', name: 'OpenAI GPT', protocol: 'chat_completions', models: ['gpt-4o'] },
      ],
    });
    const cb = makeCircuitBreaker();
    const activeHealth = makeActiveHealthService({
      openai: {
        enabled: true,
        status: 'healthy',
        method: 'HEAD',
        target: 'HEAD /health',
        last_checked_at: '2026-05-02T00:00:00.000Z',
      },
    });
    const budget = makeBudgetService();

    const controller = new HealthController(config, cb, makeConcurrencyLimiter(), activeHealth, budget);
    const result = await controller.check();

    expect(result.nodes[0].id).toBe('openai');
    expect(result.nodes[0].name).toBe('OpenAI GPT');
    expect(result.nodes[0].protocol).toBe('chat_completions');
    expect(result.nodes[0].active_probe.status).toBe('healthy');
  });

  it('should degrade when active health probing reports unhealthy', async () => {
    const config = mockConfigService({
      nodes: [{ id: 'n1', name: 'N1', protocol: 'chat_completions', models: ['m1'] }],
    });
    const cb = makeCircuitBreaker();
    const activeHealth = makeActiveHealthService({
      n1: {
        enabled: true,
        status: 'unhealthy',
        method: 'HEAD',
        target: 'HEAD /healthz',
        failure_reason: 'HTTP 503',
      },
    });
    const budget = makeBudgetService();

    const controller = new HealthController(config, cb, makeConcurrencyLimiter(), activeHealth, budget);
    const result = await controller.check();

    expect(result.status).toBe('degraded');
    expect(result.nodes[0].healthy).toBe(false);
    expect(result.nodes[0].active_probe.failure_reason).toBe('HTTP 503');
  });
});

// ═══════════════════════════════════════════════════════════
// ModelsController
// ═══════════════════════════════════════════════════════════

describe('ModelsController', () => {
  function makeAgentProfiles(overrides: Record<string, any> = {}) {
    return {
      hasActiveProfileForApiKey: jest.fn().mockResolvedValue(false),
      listVirtualModelsForApiKey: jest.fn().mockResolvedValue([]),
      ...overrides,
    };
  }

  it('should return OpenAI-compatible model list with "auto"', async () => {
    const config = mockConfigService({
      listModels: jest.fn().mockReturnValue([
        { id: 'gpt-4o', node: 'openai', nodeName: 'OpenAI', aliases: ['openai'] },
        { id: 'claude-3-opus', node: 'claude', nodeName: 'Claude', aliases: ['claude'] },
      ]),
    });
    const controller = new ModelsController(config, makeAgentProfiles() as any);
    const result = await controller.list();

    expect(result.object).toBe('list');
    expect(Array.isArray(result.data)).toBe(true);

    // First entry should be "auto"
    expect(result.data[0].id).toBe('auto');
    expect(result.data[0].owned_by).toBe('siftgate');

    // Real models follow
    const gpt4o = result.data.find((m: any) => m.id === 'gpt-4o');
    expect(gpt4o).toBeDefined();
    expect(gpt4o!.owned_by).toBe('openai');
    expect(gpt4o!.object).toBe('model');

    const claude = result.data.find((m: any) => m.id === 'claude-3-opus');
    expect(claude).toBeDefined();
    expect(claude!.owned_by).toBe('claude');
  });

  it('should include alias entries', async () => {
    const config = mockConfigService({
      listModels: jest.fn().mockReturnValue([
        { id: 'gpt-4o', node: 'openai', nodeName: 'OpenAI', aliases: ['openai', 'gpt'] },
      ]),
    });
    const controller = new ModelsController(config, makeAgentProfiles() as any);
    const result = await controller.list();

    const aliasEntries = result.data.filter((m: any) => m.is_alias);
    expect(aliasEntries.length).toBe(2);

    const openaiAlias = aliasEntries.find((m: any) => m.id === 'openai');
    expect(openaiAlias).toBeDefined();
    expect((openaiAlias as any).resolves_to).toBe('gpt-4o');

    const gptAlias = aliasEntries.find((m: any) => m.id === 'gpt');
    expect(gptAlias).toBeDefined();
    expect((gptAlias as any).resolves_to).toBe('gpt-4o');
  });

  it('should deduplicate aliases across models', async () => {
    const config = mockConfigService({
      listModels: jest.fn().mockReturnValue([
        { id: 'gpt-4o', node: 'openai', nodeName: 'OpenAI', aliases: ['shared-alias'] },
        { id: 'gpt-4o-mini', node: 'openai', nodeName: 'OpenAI', aliases: ['shared-alias'] },
      ]),
    });
    const controller = new ModelsController(config, makeAgentProfiles() as any);
    const result = await controller.list();

    const aliasEntries = result.data.filter((m: any) => m.is_alias);
    expect(aliasEntries.length).toBe(1);
    expect(aliasEntries[0].id).toBe('shared-alias');
  });

  it('should return empty data array (besides auto) when no models configured', async () => {
    const config = mockConfigService({
      listModels: jest.fn().mockReturnValue([]),
    });
    const controller = new ModelsController(config, makeAgentProfiles() as any);
    const result = await controller.list();

    expect(result.data).toHaveLength(1); // only "auto"
    expect(result.data[0].id).toBe('auto');
  });

  it('should filter model list by Dashboard-managed API key permissions', async () => {
    const config = mockConfigService({
      listModels: jest.fn().mockReturnValue([
        { id: 'gpt-4o', node: 'openai', nodeName: 'OpenAI', aliases: ['openai'] },
        { id: 'claude-3-opus', node: 'claude', nodeName: 'Claude', aliases: ['claude'] },
      ]),
    });
    const controller = new ModelsController(config, makeAgentProfiles() as any);
    const result = await controller.list({
      gatewayApiKey: {
        id: 'key_123',
        name: 'production',
        status: 'active',
        allow_auto: false,
        allow_direct: true,
        allowed_nodes: ['openai'],
        allowed_models: ['gpt-4o'],
        allowed_endpoints: ['models'],
        allowed_modalities: [],
        namespace_id: null,
        namespace_name: null,
        rate_limit_per_minute: null,
      },
    } as any);

    expect(result.data.map((model: any) => model.id)).toEqual(['gpt-4o', 'openai']);
  });

  it('does not expose direct models when an API key is smart-router only', async () => {
    const config = mockConfigService({
      listModels: jest.fn().mockReturnValue([
        { id: 'gpt-4o', node: 'openai', nodeName: 'OpenAI', aliases: ['openai'] },
        { id: 'claude-3-opus', node: 'claude', nodeName: 'Claude', aliases: ['claude'] },
      ]),
    });
    const controller = new ModelsController(config, makeAgentProfiles() as any);
    const result = await controller.list({
      gatewayApiKey: {
        id: 'key_123',
        name: 'agent',
        status: 'active',
        allow_auto: true,
        allow_direct: false,
        allowed_nodes: [],
        allowed_models: [],
        allowed_endpoints: ['models'],
        allowed_modalities: [],
        namespace_id: null,
        namespace_name: null,
        rate_limit_per_minute: null,
      },
    } as any);

    expect(result.data.map((model: any) => model.id)).toEqual(['auto']);
    expect(result.data.some((model: any) => model.is_alias)).toBe(false);
  });

  it('hides node shortcut aliases for Agent Profile-bound API keys', async () => {
    const config = mockConfigService({
      listModels: jest.fn().mockReturnValue([
        { id: 'gpt-4o', node: 'openai', nodeName: 'OpenAI', aliases: ['openai', 'gpt'] },
      ]),
    });
    const agentProfiles = makeAgentProfiles({
      hasActiveProfileForApiKey: jest.fn().mockResolvedValue(true),
    });
    const controller = new ModelsController(config, agentProfiles as any);
    const result = await controller.list({
      gatewayApiKey: {
        id: 'key_123',
        name: 'agent',
        status: 'active',
        allow_auto: true,
        allow_direct: true,
        allowed_nodes: [],
        allowed_models: [],
        allowed_endpoints: ['models'],
        allowed_modalities: [],
        namespace_id: null,
        namespace_name: null,
        rate_limit_per_minute: null,
      },
    } as any);

    expect(agentProfiles.hasActiveProfileForApiKey).toHaveBeenCalledWith('key_123');
    expect(result.data.map((model: any) => model.id)).toEqual(['auto', 'gpt-4o']);
    expect(result.data.some((model: any) => model.is_alias)).toBe(false);
    expect(result.data.find((model: any) => model.id === 'gpt-4o')).toEqual(
      expect.objectContaining({ aliases: [] }),
    );
  });

  it('exposes profile virtual models only for matching active profile and API key context', async () => {
    const config = mockConfigService({
      listModels: jest.fn().mockReturnValue([
        { id: 'gpt-4o', node: 'openai', nodeName: 'OpenAI', aliases: [] },
      ]),
    });
    const agentProfiles = makeAgentProfiles({
      listVirtualModelsForApiKey: jest.fn().mockResolvedValue([
        {
          id: 'claude-siftgate-auto',
          object: 'model',
          created: 0,
          owned_by: 'siftgate',
          description: 'SiftGate Agent Profile smart routing model scoped to this Gateway API key.',
          agent_profile_id: 'profile-1',
          agent_profile_name: 'Claude Code',
          agent_connector: 'claude_code',
          agent_virtual_model: 'claude-siftgate-auto',
          is_agent_profile_model: true,
        },
      ]),
    });
    const controller = new ModelsController(config, agentProfiles as any);

    const result = await controller.list({
      gatewayApiKey: {
        id: 'key_123',
        name: 'agent',
        status: 'active',
        allow_auto: true,
        allow_direct: false,
        allowed_nodes: [],
        allowed_models: [],
        allowed_endpoints: ['models'],
        allowed_modalities: [],
        namespace_id: null,
        namespace_name: null,
        rate_limit_per_minute: null,
      },
    } as any);

    expect(agentProfiles.listVirtualModelsForApiKey).toHaveBeenCalledWith(
      'key_123',
      { allow_auto: true, allowed_models: [] },
    );
    expect(result.data).toContainEqual(expect.objectContaining({
      id: 'claude-siftgate-auto',
      agent_profile_id: 'profile-1',
      is_agent_profile_model: true,
    }));
  });

  it('does not expose disabled profile virtual models returned as empty by the service', async () => {
    const config = mockConfigService({ listModels: jest.fn().mockReturnValue([]) });
    const agentProfiles = makeAgentProfiles();
    const controller = new ModelsController(config, agentProfiles as any);
    const result = await controller.list({
      gatewayApiKey: {
        id: 'key_123',
        allow_auto: true,
        allow_direct: false,
        allowed_nodes: [],
        allowed_models: [],
        allowed_endpoints: ['models'],
        allowed_modalities: [],
      },
    } as any);

    expect(result.data.map((model: any) => model.id)).not.toContain('claude-siftgate-auto');
  });

  it('should reject model list when API key endpoint permissions exclude models', async () => {
    const config = mockConfigService({ listModels: jest.fn().mockReturnValue([]) });
    const controller = new ModelsController(config, makeAgentProfiles() as any);

    await expect(controller.list({
      gatewayApiKey: {
        allow_auto: true,
        allow_direct: true,
        allowed_nodes: [],
        allowed_models: [],
        allowed_endpoints: ['chat_completions'],
        allowed_modalities: [],
      },
    } as any)).rejects.toThrow(ForbiddenException);
  });
});

/**
 * DashboardController unit tests.
 *
 * Tests all dashboard REST endpoints with mocked TypeORM QueryBuilder
 * and service dependencies.
 */

import { HttpException } from "@nestjs/common";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DashboardController } from "../../src/dashboard/dashboard.controller";
import { DashboardGuard } from "../../src/auth/dashboard.guard";
import { DASHBOARD_REQUIRED_ROLE_KEY } from "../../src/auth/dashboard-rbac";
import { CircuitState } from "../../src/routing/circuit-breaker.service";
import { mockConfigService } from "../helpers";
import { TelemetryService } from "../../src/telemetry/telemetry.service";
import { loadMergedCatalog } from "../../src/catalog/catalog.service";

const MISSING_CATALOG_OVERRIDE = "/tmp/siftgate-missing-catalog.override.yaml";
const MISSING_CATALOG_SYNC_CACHE = "/tmp/siftgate-missing-catalog-sync-cache.yaml";

// ── Mock Query Builder Factory ──────────────────────────

function mockQueryBuilder(
  rawResult: any = {},
  rawMany: any[] = [],
  manyAndCount: [any[], number] = [[], 0],
) {
  const qb: any = {
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    setParameters: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    delete: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({ affected: 0 }),
    getRawOne: jest.fn().mockResolvedValue(rawResult),
    getRawMany: jest.fn().mockResolvedValue(rawMany),
    getMany: jest.fn().mockResolvedValue(manyAndCount[0]),
    getManyAndCount: jest.fn().mockResolvedValue(manyAndCount),
  };
  return qb;
}

function mockRepo(qb: any) {
  return {
    count: jest.fn().mockResolvedValue(0),
    createQueryBuilder: jest.fn().mockReturnValue(qb),
  };
}

const ADMIN_TEST_MANAGER = { transaction_fixture: true };

function makeDashboard(overrides: Record<string, any> = {}) {
  const config = mockConfigService({
    nodes: [
      {
        id: "openai",
        name: "OpenAI",
        protocol: "chat_completions",
        base_url: "https://api.openai.com",
        endpoint: "/v1/chat/completions",
        embeddings_endpoint: "/v1/embeddings",
        endpoints: { image: "/v1/images/generations" },
        models: ["gpt-4o"],
        embedding_models: ["text-embedding-3-small"],
        timeout_ms: 60000,
        max_concurrency: 3,
        queue_timeout_ms: 250,
        queue_policy: "fallback",
        api_key: "sk-test12345678rest",
        tags: [],
        model_aliases: {},
      },
      {
        id: "claude",
        name: "Claude",
        protocol: "messages",
        base_url: "https://api.anthropic.com",
        endpoint: "/v1/messages",
        models: ["claude-3-opus"],
        api_key: "sk-ant-12345678rest",
        tags: [],
        model_aliases: {},
      },
    ],
    database: { type: "sqlite", path: ":memory:", log_retention_days: 30 },
    getFullConfig: jest.fn().mockReturnValue({
      server: { port: 3000 },
      database: { type: "sqlite" },
      auth: { api_keys: [{ name: "default", key: "gw_sk_dev_default_rest" }] },
      nodes: [
        {
          id: "openai",
          name: "OpenAI",
          api_key: "sk-test12345678rest",
          models: ["gpt-4o"],
        },
      ],
      routing: {},
      budget: {},
      models_pricing: {},
    }),
    reload: jest.fn().mockReturnValue({
      success: true,
      message: "Configuration reloaded",
      current: { version: 2 },
      previous: { version: 1 },
      changed: {},
      rolled_back: false,
    }),
    addNode: jest.fn(),
    updateNode: jest.fn(),
    deleteNode: jest.fn(),
    updateRouting: jest.fn(),
    getNodeModelDiagnostics: jest.fn().mockReturnValue([]),
    ...overrides.config,
  });

  const capabilityService = {
    getRegistry: jest.fn().mockReturnValue([]),
    getNodeCapabilities: jest.fn().mockReturnValue([]),
    resolveNodeModalities: jest.fn().mockReturnValue(["text"]),
    resolveModelRoutingCapabilities: jest
      .fn()
      .mockImplementation((_nodeId: string, model: string) => ({
        modalities: model.includes("embedding")
          ? ["text", "embedding"]
          : ["text", "image"],
        structured_output: model.includes("embedding") ? null : true,
        dimensions: model.includes("embedding") ? [512, 1536] : undefined,
        supports_streaming: !model.includes("embedding"),
        pricing: model.includes("embedding")
          ? { input: 0.02, output: 0 }
          : { input: 2.5, output: 10 },
      })),
    recommendTiers: jest.fn().mockReturnValue({}),
    recommendRouting: jest.fn().mockReturnValue({}),
    ...overrides.capabilityService,
  };

  const routingService = {
    getRoutingStatus: jest.fn().mockReturnValue({
      standard: {
        strategy: "weighted",
        source: "targets",
        targets: [],
        last_selected: null,
      },
    }),
    ...overrides.routingService,
  };

  const circuitBreaker = {
    getNodeStatus: jest
      .fn()
      .mockReturnValue({
        state: CircuitState.CLOSED,
        consecutiveFailures: 0,
        lastFailureAt: null,
      }),
    getModelStatuses: jest.fn().mockReturnValue({}),
    reset: jest.fn(),
    ...overrides.circuitBreaker,
  };

  const concurrencyLimiter = {
    getNodeStats: jest.fn().mockImplementation((node: any) => ({
      node: node.id,
      max_concurrency: node.max_concurrency ?? null,
      queue_timeout_ms: node.queue_timeout_ms ?? 10000,
      queue_policy: node.queue_policy ?? "wait",
      active: 0,
      queued: 0,
    })),
    ...overrides.concurrencyLimiter,
  };

  const activeHealth = {
    getNodeStatus: jest.fn().mockReturnValue({
      enabled: false,
      status: "disabled",
      method: null,
      target: null,
      last_checked_at: null,
      last_success_at: null,
      latency_ms: null,
      failure_reason: null,
      consecutive_failures: 0,
    }),
    refreshSchedules: jest.fn(),
    ...overrides.activeHealth,
  };

  const budgetService = {
    getStatus: jest.fn().mockResolvedValue([]),
    resetRule: jest.fn().mockResolvedValue(undefined),
    getKeysWithBudgets: jest.fn().mockResolvedValue([]),
    ...overrides.budgetService,
  };

  const cacheService = {
    getStats: jest.fn().mockReturnValue({ entries: 0, hits: 0, misses: 0 }),
    clear: jest.fn(),
    ...overrides.cacheService,
  };

  const logEventBus = {
    events$: { pipe: jest.fn().mockReturnValue({ pipe: jest.fn() }) },
    ...overrides.logEventBus,
  };

  const gatewayApiKeys = {
    withTransaction: jest.fn(async (action: (service: unknown, manager?: unknown) => Promise<unknown>): Promise<unknown> => action(gatewayApiKeys, ADMIN_TEST_MANAGER)),
    list: jest.fn().mockResolvedValue([]),
    getSummary: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    rotate: jest.fn(),
    remove: jest.fn(),
    ...overrides.gatewayApiKeys,
  };
  const agentProfiles = {
    list: jest.fn().mockResolvedValue([]),
    create: jest.fn(),
    update: jest.fn(),
    remove: jest.fn(),
    render: jest.fn(),
    ...overrides.agentProfiles,
  };
  const agentPlatform = {
    getDashboardSummary: jest.fn().mockResolvedValue({
      version: "v1",
      preview: true,
      workspace_id: "default-workspace",
      a2a_hub: { agents: [] },
      tool_registry: { servers: [] },
      workflow_preview: { runtime_enabled: false, workflows: [] },
      memory_gateway: { content_storage_enabled: false },
      traces: { metadata_only: true, spans: [] },
      privacy: { metadata_only: true, stores_tool_payloads: false },
      totals: {
        agents: 0,
        active_agents: 0,
        tools: 0,
        permitted_tools: 0,
        workflows: 0,
        recent_spans: 0,
      },
    }),
    ...overrides.agentPlatform,
  };
  const teams = {
    withTransaction: jest.fn(async (action: (service: unknown, manager?: unknown) => Promise<unknown>): Promise<unknown> => action(teams, ADMIN_TEST_MANAGER)),
    list: jest.fn().mockResolvedValue([]),
    getSummary: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    remove: jest.fn(),
    ...overrides.teams,
  };
  const shadowTraffic = {
    getStatus: jest.fn().mockReturnValue({
      enabled: false,
      sample_rate: 0,
      target_node: null,
      target_model: null,
      timeout_ms: null,
      max_recent_results: 100,
      compare: { store_prompts: false, store_responses: false },
      privacy: {
        stores_prompts: false,
        stores_responses: false,
        raw_headers: false,
        provider_keys: false,
      },
    }),
    recent: jest.fn().mockResolvedValue([]),
    comparisonReport: jest.fn().mockResolvedValue({
      primary_success_rate: null,
      shadow_success_rate: null,
      latency_delta_ms: null,
      p50_latency_comparison: {
        primary_ms: null,
        shadow_ms: null,
        delta_ms: null,
      },
      p95_latency_comparison: {
        primary_ms: null,
        shadow_ms: null,
        delta_ms: null,
      },
      cost_delta_usd: 0,
      potential_savings_usd: 0,
      token_delta: 0,
      fallback_delta: 0,
      quality_sample_coverage: 0,
      confidence: { level: "low", score: 0 },
      risk_notes: [],
      pairs: [],
    }),
    comparisonForResult: jest.fn().mockResolvedValue(null),
    ...overrides.shadowTraffic,
  };

  const routingRecommendations = {
    getRecommendations: jest.fn().mockResolvedValue({
      mode: "recommendation_only",
      stats: { observed_calls: 0, targets: [], tiers: [] },
      recommendations: [],
    }),
    ...overrides.routingRecommendations,
  };
  const catalog = {
    load: jest.fn().mockReturnValue({
      catalog: {
        providers: [
          {
            id: "openai",
            name: "OpenAI",
            base_url: "https://api.openai.com",
            auth_type: "bearer",
            endpoints: { chat_completions: "/v1/chat/completions" },
            models: [
              {
                id: "gpt-4o",
                provider: "openai",
                modalities: ["text", "vision"],
                endpoints: { chat_completions: "/v1/chat/completions" },
                capabilities: ["streaming"],
                pricing: {
                  input: 2.5,
                  output: 10,
                  input_per_1m_tokens: 2.5,
                  output_per_1m_tokens: 10,
                  source: "builtin-reference",
                  source_type: "docs_review",
                  source_url: "https://example.com/openai-pricing",
                  last_updated: "2026-05-05",
                  last_verified_at: "2026-05-05",
                  manual_review_required: true,
                  pricing_confidence: "low",
                  stale_after_days: 90,
                },
                source: "builtin",
                overridden: false,
              },
              {
                id: "text-embedding-3-small",
                provider: "openai",
                modalities: ["embedding"],
                endpoints: { embeddings: "/v1/embeddings" },
                capabilities: ["embedding"],
                source: "builtin",
                overridden: false,
              },
            ],
            source: "builtin",
            overridden: false,
          },
          {
            id: "anthropic",
            name: "Anthropic",
            base_url: "https://api.anthropic.com",
            auth_type: "x-api-key",
            endpoints: { messages: "/v1/messages" },
            models: [],
            source: "builtin",
            overridden: false,
          },
          {
            id: "openai-compatible",
            name: "OpenAI Compatible",
            base_url: "https://provider.example",
            auth_type: "bearer",
            endpoints: { chat_completions: "/v1/chat/completions" },
            models: [],
            source: "builtin",
            overridden: false,
          },
        ],
      },
      overridePath: "catalog.override.yaml",
      overrideFound: false,
      syncCachePath: ".siftgate/catalog-sync-cache.yaml",
      syncCacheFound: false,
      issues: [],
    }),
    ...overrides.catalog,
  };

  const dataSource = {
    options: { type: "better-sqlite3" },
    ...overrides.dataSource,
  };

  const qb = overrides.qb || mockQueryBuilder();
  const callLogRepo = overrides.callLogRepo || mockRepo(qb);
  const routeDecisionRepo = overrides.routeDecisionRepo || {
    ...mockRepo(qb),
    findOne: jest.fn().mockResolvedValue(null),
    find: jest.fn().mockResolvedValue([]),
  };
  const shadowTrafficRepo = overrides.shadowTrafficRepo || {
    ...mockRepo(qb),
    find: jest.fn().mockResolvedValue([]),
  };
  const cacheSavings = {
    getSummary: jest.fn().mockResolvedValue({
      period: "7d",
      period_days: 7,
      group_by: "node",
      filters: {
        api_key_id: null,
        api_key_name: null,
        namespace_id: null,
        team_id: null,
      },
      summary: {
        total_requests: 0,
        provider_routed_requests: 0,
        requests_with_provider_cache_hit: 0,
        cache_hit_rate: 0,
        total_input_tokens: 0,
        total_output_tokens: 0,
        total_cache_read_tokens: 0,
        total_cache_creation_tokens: 0,
        total_normal_input_tokens: 0,
        actual_cost_usd: 0,
        hypothetical_no_cache_cost_usd: 0,
        savings_usd: 0,
        savings_percentage: 0,
        normal_input_cost_usd: 0,
        cache_read_cost_usd: 0,
        cache_creation_cost_usd: 0,
        output_cost_usd: 0,
      },
      groups: [],
      daily_trend: [],
    }),
    ...overrides.cacheSavings,
  };
  const providerCompatibility = {
    matrixForNodes: jest.fn().mockResolvedValue({}),
    compatibilityDiagnostics: jest.fn().mockReturnValue([]),
    runNodeMatrix: jest.fn().mockResolvedValue({
      success: true,
      status: 200,
      latency_ms: 1,
      message: "Compatibility checks completed",
      matrix: [],
    }),
    ...overrides.providerCompatibility,
  };
  const configAudit = {
    recordReload: jest.fn().mockResolvedValue(null),
    listVersions: jest
      .fn()
      .mockResolvedValue({
        data: [],
        pagination: { limit: 50, count: 0 },
        privacy: {},
      }),
    getVersion: jest.fn().mockResolvedValue(null),
    rollbackToVersion: jest.fn(),
    listEvents: jest
      .fn()
      .mockResolvedValue({
        data: [],
        pagination: { limit: 100, count: 0 },
        privacy: {},
      }),
    recordManagementEvent: jest.fn().mockResolvedValue(null),
    trackChange: jest.fn((_input, mutation) => mutation()),
    ...overrides.configAudit,
  };
  const managementAudit = {
    record: jest.fn().mockResolvedValue(null),
    recordDenied: jest.fn().mockResolvedValue(null),
    list: jest.fn().mockResolvedValue({
      data: [],
      pagination: { limit: 100, count: 0 },
      privacy: {},
    }),
    ...overrides.managementAudit,
  };
  const batchJobs = {
    dashboardSummary: jest.fn().mockResolvedValue({
      metadata_only: true,
      items: [],
      totals: { total: 0, active: 0, completed: 0, failed: 0, cancelled: 0 },
      filters: {
        period: "24h",
        status: null,
        node: null,
        namespace: null,
        api_key_id: null,
      },
    }),
    ...overrides.batchJobs,
  };
  const workspaces = {
    withTransaction: jest.fn(),
    lockWorkspace: jest.fn().mockResolvedValue(undefined),
    getState: jest.fn().mockResolvedValue({
      organization: {
        id: "default-org",
        name: "Default Organization",
        slug: "default-org",
        status: "active",
      },
      active_workspace: {
        id: "default-workspace",
        organization_id: "default-org",
        name: "Default Workspace",
        slug: "default-workspace",
        status: "active",
        is_default: true,
      },
      default_workspace: {
        id: "default-workspace",
        organization_id: "default-org",
        name: "Default Workspace",
        slug: "default-workspace",
        status: "active",
        is_default: true,
      },
      workspaces: [
        {
          id: "default-workspace",
          organization_id: "default-org",
          name: "Default Workspace",
          slug: "default-workspace",
          status: "active",
          is_default: true,
        },
      ],
    }),
    requireWorkspace: jest.fn().mockResolvedValue({
      id: "default-workspace",
      organization_id: "default-org",
      name: "Default Workspace",
      slug: "default-workspace",
      status: "active",
      is_default: true,
    }),
    createWorkspace: jest.fn().mockResolvedValue({
      id: "ws_test",
      organization_id: "default-org",
      name: "Test Workspace",
      slug: "test-workspace",
      status: "active",
      is_default: false,
    }),
    renameWorkspace: jest.fn().mockResolvedValue({
      id: "ws_test",
      organization_id: "default-org",
      name: "Renamed Workspace",
      slug: "renamed-workspace",
      status: "active",
      is_default: false,
    }),
    setWorkspaceStatus: jest.fn().mockImplementation((id: string, status: string) =>
      Promise.resolve({
        id,
        organization_id: "default-org",
        name: "Test Workspace",
        slug: "test-workspace",
        status,
        is_default: false,
      }),
    ),
    ...overrides.workspaces,
  };
  const memberships = {
    withTransaction: jest.fn(),
    lockWorkspace: jest.fn().mockResolvedValue(undefined),
    list: jest.fn().mockResolvedValue([]),
    listForUser: jest.fn().mockResolvedValue([
      {
        id: "membership-default-dashboard-admin",
        user_id: "dashboard",
        organization_id: "default-org",
        workspace_id: "default-workspace",
        role: "admin",
        status: "active",
      },
    ]),
    findActiveRole: jest.fn().mockResolvedValue("admin"),
    ensureMembership: jest.fn().mockResolvedValue({
      id: "membership-test",
      user_id: "dashboard",
      organization_id: "default-org",
      workspace_id: "ws_test",
      role: "admin",
      status: "active",
    }),
    update: jest.fn(),
    ...overrides.memberships,
  };
  const invitations = {
    withTransaction: jest.fn(),
    list: jest.fn().mockResolvedValue([]),
    create: jest.fn(),
    revoke: jest.fn(),
    ...overrides.invitations,
  };
  for (const service of [workspaces, memberships, invitations]) {
    service.withTransaction.mockImplementation((action: (scoped: unknown, manager: unknown) => unknown, manager?: unknown) => {
      if (manager) expect(manager).toBe(ADMIN_TEST_MANAGER);
      return action(service, manager ?? ADMIN_TEST_MANAGER);
    });
  }
  const workspaceContext = {
    currentWorkspaceId: jest.fn(() => "default-workspace"),
    ...overrides.workspaceContext,
  };
  const cluster = {
    getDashboardStatus: jest.fn().mockResolvedValue({
      enabled: false,
      mode: "single_instance",
      local_node_id: "test-instance",
    }),
    ...overrides.cluster,
  };
  const providerExtensibility = overrides.providerExtensibility || {
    previewCustomProviderTemplate: jest.fn().mockReturnValue({ ok: true }),
    generateProviderSdk: jest.fn().mockReturnValue({ beta: true }),
    providerHealthSummary: jest.fn().mockResolvedValue({ period: "24h" }),
  };

  const controller = new DashboardController(
    config,
    capabilityService as any,
    routingService as any,
    circuitBreaker as any,
    concurrencyLimiter as any,
    activeHealth as any,
    budgetService as any,
    cacheService as any,
    logEventBus as any,
    new TelemetryService(),
    routingRecommendations as any,
    gatewayApiKeys as any,
    agentProfiles as any,
    agentPlatform as any,
    teams as any,
    shadowTraffic as any,
    cacheSavings as any,
    providerCompatibility as any,
    configAudit as any,
    managementAudit as any,
    catalog as any,
    providerExtensibility as any,
    batchJobs as any,
    workspaces as any,
    workspaceContext as any,
    cluster as any,
    overrides.realtime as any,
    dataSource as any,
    callLogRepo as any,
    routeDecisionRepo as any,
    shadowTrafficRepo as any,
    overrides.secretResolver as any,
    overrides.benchmarkReports as any,
    overrides.plugins as any,
    overrides.mcp as any,
    memberships as any,
    invitations as any,
    overrides.credentialPool as any,
    overrides.sqliteAnalytics as any,
  );

  return {
    controller,
    config,
    routingService,
    circuitBreaker,
    concurrencyLimiter,
    activeHealth,
    budgetService,
    cacheService,
    gatewayApiKeys,
    agentProfiles,
    agentPlatform,
    teams,
    shadowTraffic,
    cacheSavings,
    providerCompatibility,
    configAudit,
    managementAudit,
    batchJobs,
    workspaces,
    memberships,
    invitations,
    workspaceContext,
    cluster,
    providerExtensibility,
    callLogRepo,
    routeDecisionRepo,
    shadowTrafficRepo,
    qb,
    capabilityService,
    routingRecommendations,
    catalog,
  };
}

function controllerMethod(name: keyof DashboardController): Function {
  return DashboardController.prototype[name] as unknown as Function;
}

// ═══════════════════════════════════════════════════════════
// Stats
// ═══════════════════════════════════════════════════════════

describe("DashboardController — automatic log retention", () => {
  beforeEach(() => jest.useFakeTimers({ doNotFake: ['setImmediate'] }));
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

  it('runs after one minute, repeats six hours later, and stops on shutdown', async () => {
    const { controller, callLogRepo } = makeDashboard();
    await jest.advanceTimersByTimeAsync(59_999);
    expect(callLogRepo.createQueryBuilder).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(callLogRepo.createQueryBuilder).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(6 * 60 * 60_000);
    expect(callLogRepo.createQueryBuilder).toHaveBeenCalledTimes(2);
    await controller.beforeApplicationShutdown();
    await jest.advanceTimersByTimeAsync(6 * 60 * 60_000);
    expect(callLogRepo.createQueryBuilder).toHaveBeenCalledTimes(2);
  });

  it('honors explicit keep-forever instead of silently enabling deletion', async () => {
    const { controller, callLogRepo, routeDecisionRepo } = makeDashboard({
      config: { database: { type: 'sqlite', log_retention_days: 0 } },
    });
    await jest.advanceTimersByTimeAsync(60_000);
    expect(callLogRepo.createQueryBuilder).not.toHaveBeenCalled();
    expect(routeDecisionRepo.createQueryBuilder).not.toHaveBeenCalled();
    await controller.beforeApplicationShutdown();
  });

  it('defaults to thirty days and stops additional batches when shutting down', async () => {
    const qb = mockQueryBuilder({}, [{ id: 1 }]);
    const repo = { ...mockRepo(qb), delete: jest.fn() };
    const { controller, routeDecisionRepo } = makeDashboard({
      config: { database: { type: 'sqlite' } }, callLogRepo: repo,
    });
    repo.delete.mockImplementation(async () => {
      await controller.beforeApplicationShutdown();
      return { affected: 1 };
    });
    const before = Date.now();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(qb.take).toHaveBeenCalledWith(500);
    expect(qb.where).toHaveBeenCalledWith('log.timestamp < :cutoff', {
      cutoff: new Date(before + 60_000 - 30 * 86_400_000),
    });
    expect(repo.delete).toHaveBeenCalledTimes(1);
    expect(routeDecisionRepo.createQueryBuilder).not.toHaveBeenCalled();
  });
});

describe("DashboardController — getStats", () => {
  it("should return aggregated stats", async () => {
    const qb = mockQueryBuilder(
      {
        totalCalls: "10",
        successCalls: "8",
        totalInputTokens: "1000",
        totalOutputTokens: "500",
        totalCost: "0.5",
        avgLatency: "200",
        uniqueSessions: "3",
        recentCalls: "4",
        recentCost: "0.2",
        recentTokens: "600",
      },
      [{ tier: "standard", count: "5" }],
    );
    const repo = mockRepo(qb);

    const { controller } = makeDashboard({ callLogRepo: repo, qb });
    const result = await controller.getStats();

    expect(result.total.calls).toBe(10);
    expect(result.total.success).toBe(8);
    expect(result.total.failed).toBe(2);
    expect(result.total.successRate).toBe(80);
    expect(result.total.inputTokens).toBe(1000);
    expect(result.total.outputTokens).toBe(500);
  });

  it("should handle zero calls gracefully", async () => {
    const qb = mockQueryBuilder({
      totalCalls: "0",
      successCalls: "0",
      totalInputTokens: null,
      totalOutputTokens: null,
      totalCost: null,
      avgLatency: null,
      uniqueSessions: null,
      recentCalls: null,
      recentCost: null,
      recentTokens: null,
    });
    const repo = mockRepo(qb);

    const { controller } = makeDashboard({ callLogRepo: repo, qb });
    const result = await controller.getStats();

    expect(result.total.calls).toBe(0);
    expect(result.total.successRate).toBe(0);
    expect(result.total.inputTokens).toBe(0);
  });

  it("runs SQLite stats in the analytics worker and caches the result", async () => {
    const sqliteAnalytics = {
      available: true,
      queryAll: jest.fn().mockResolvedValue([
        {
          kind: "total",
          groupKey: "",
          totalCalls: 10,
          successCalls: 9,
          totalInputTokens: 100,
          totalOutputTokens: 50,
          totalCost: 0.25,
          avgLatency: 120,
          uniqueSessions: 3,
          cacheCreationTokens: 5,
          cacheReadTokens: 20,
          recentCalls: 10,
          recentCost: 0.25,
          recentTokens: 150,
        },
        { kind: "tier", groupKey: "standard", totalCalls: 10 },
        {
          kind: "node",
          groupKey: "openai",
          totalCalls: 10,
          avgLatency: 120,
        },
      ]),
    };
    const { controller, callLogRepo } = makeDashboard({ sqliteAnalytics });

    const first = await controller.getStats();
    const second = await controller.getStats();

    expect(first.period).toBe(1);
    expect(first.total.calls).toBe(10);
    expect(first.tierDistribution).toEqual([{ tier: "standard", count: 10 }]);
    expect(first.nodeDistribution).toEqual([
      { nodeId: "openai", count: 10, avgLatencyMs: 120 },
    ]);
    expect(second).toBe(first);
    expect(sqliteAnalytics.queryAll).toHaveBeenCalledTimes(1);
    expect(callLogRepo.createQueryBuilder).not.toHaveBeenCalled();
  });
});

describe("DashboardController — cluster status", () => {
  it("should expose privacy-safe cluster and shared state status", async () => {
    const clusterStatus = {
      enabled: true,
      mode: "redis_pubsub",
      local_node_id: "pod-a",
      redis: {
        status: "ready",
        url: "redis://redacted@redis:6379/",
        prefix: "siftgate:state:",
        last_error: null,
      },
      state: {
        backend: "redis",
        configured_backend: "redis",
        key_prefix: "siftgate:state:",
        redis_available: true,
        unavailable_policy: "fail_open",
        degraded: false,
        last_error: null,
        recent_errors: [],
        categories: {
          rate_limit: {
            name: "rate_limit",
            unavailable_policy: "fail_open",
            ttl_seconds: 60,
            shared: true,
          },
        },
      },
      instance_count: 2,
    };
    const { controller, cluster } = makeDashboard({
      cluster: {
        getDashboardStatus: jest.fn().mockResolvedValue(clusterStatus),
      },
    });

    await expect(controller.getClusterStatus()).resolves.toBe(clusterStatus);
    expect(cluster.getDashboardStatus).toHaveBeenCalledTimes(1);
  });
});

describe("DashboardController — workspaces", () => {
  it("returns only workspaces accessible to the current Dashboard identity", async () => {
    const workspaces = {
      getState: jest.fn().mockResolvedValue({
        organization: { id: "default-org", name: "Default Organization" },
        active_workspace: { id: "default-workspace" },
        default_workspace: { id: "default-workspace" },
        workspaces: [{ id: "default-workspace" }, { id: "agents" }],
      }),
    };
    const { controller, memberships } = makeDashboard({
      workspaces,
      memberships: {
        listForUser: jest.fn().mockResolvedValue([
          {
            user_id: "dashboard",
            workspace_id: "default-workspace",
            role: "admin",
            status: "active",
          },
          {
            user_id: "dashboard",
            workspace_id: "agents",
            role: "viewer",
            status: "active",
          },
          {
            user_id: "dashboard",
            workspace_id: "disabled-membership",
            role: "admin",
            status: "disabled",
          },
        ]),
        findActiveRole: jest.fn().mockResolvedValue("admin"),
      },
    });

    await expect(
      controller.getWorkspaces({
        dashboardUserId: "dashboard",
        dashboardRole: "admin",
        workspaceId: "default-workspace",
      } as any),
    ).resolves.toMatchObject({
      access: { user_id: "dashboard", role: "admin" },
    });

    expect(memberships.listForUser).toHaveBeenCalledWith("dashboard");
    expect(workspaces.getState).toHaveBeenCalledWith("default-workspace", {
      includeDisabled: true,
      workspaceIds: ["default-workspace", "agents"],
    });
  });

  it("creates a workspace and grants the creator admin membership", async () => {
    const created = {
      id: "ws_agents",
      organization_id: "default-org",
      name: "Agent Ops",
      slug: "agent-ops",
      status: "active",
      is_default: false,
    };
    const { controller, workspaces, memberships, managementAudit } = makeDashboard({
      workspaces: {
        createWorkspace: jest.fn().mockResolvedValue(created),
        getState: jest.fn().mockResolvedValue({
          organization: { id: "default-org" },
          active_workspace: created,
          default_workspace: { id: "default-workspace" },
          workspaces: [{ id: "default-workspace" }, created],
        }),
      },
      memberships: {
        listForUser: jest.fn().mockResolvedValue([
          {
            user_id: "dashboard",
            workspace_id: "default-workspace",
            role: "admin",
            status: "active",
          },
          {
            user_id: "dashboard",
            workspace_id: "ws_agents",
            role: "admin",
            status: "active",
          },
        ]),
        findActiveRole: jest.fn().mockResolvedValue("admin"),
        ensureMembership: jest.fn().mockResolvedValue({
          user_id: "dashboard",
          workspace_id: "ws_agents",
          role: "admin",
          status: "active",
        }),
      },
    });

    await expect(
      controller.createWorkspace({ dashboardUserId: "dashboard" } as any, {
        name: "Agent Ops",
      }),
    ).resolves.toMatchObject({
      success: true,
      item: created,
      state: { active_workspace: created },
    });

    expect(workspaces.createWorkspace).toHaveBeenCalledWith({
      name: "Agent Ops",
      slug: undefined,
    });
    expect(memberships.ensureMembership).toHaveBeenCalledWith({
      userId: "dashboard",
      organizationId: "default-org",
      workspaceId: "ws_agents",
      role: "admin",
    });
    expect(managementAudit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "workspace.create",
        resourceType: "workspace",
        resourceId: "ws_agents",
        workspaceId: "ws_agents",
      }),
      ADMIN_TEST_MANAGER,
    );
  });

  it("rejects switching to a workspace without active membership", async () => {
    const { controller } = makeDashboard({
      workspaces: {
        requireWorkspace: jest.fn().mockResolvedValue({
          id: "private-workspace",
          organization_id: "default-org",
          name: "Private",
          slug: "private",
          status: "active",
          is_default: false,
        }),
      },
      memberships: {
        listForUser: jest.fn().mockResolvedValue([]),
        findActiveRole: jest.fn().mockResolvedValue(null),
      },
    });

    await expect(
      controller.switchWorkspace({ dashboardUserId: "dashboard" } as any, {
        workspace_id: "private-workspace",
      }),
    ).rejects.toMatchObject({
      status: 403,
    });
  });
});

// ═══════════════════════════════════════════════════════════
// Cost Analytics
// ═══════════════════════════════════════════════════════════

describe("DashboardController — getCostAnalytics", () => {
  it("should return cost analytics for default 7d period", async () => {
    const qb = mockQueryBuilder(
      {
        calls: "10",
        cost: "1.5",
        inputTokens: "5000",
        outputTokens: "2000",
        avgCostPerCall: "0.15",
      },
      [
        {
          model: "gpt-4o",
          calls: "10",
          cost: "1.5",
          inputTokens: "5000",
          outputTokens: "2000",
          avgLatency: "200",
        },
      ],
    );
    const repo = mockRepo(qb);

    const { controller } = makeDashboard({ callLogRepo: repo, qb });
    const result = await controller.getCostAnalytics("7d", "model");

    expect(result.period).toBe(7);
    expect(result.total.calls).toBe(10);
    expect(result.total.cost).toBe(1.5);
  });

  it("should handle 30d period", async () => {
    const qb = mockQueryBuilder({
      calls: "0",
      cost: "0",
      inputTokens: "0",
      outputTokens: "0",
      avgCostPerCall: "0",
    });
    const repo = mockRepo(qb);

    const { controller } = makeDashboard({ callLogRepo: repo, qb });
    const result = await controller.getCostAnalytics("30d", "model");

    expect(result.period).toBe(30);
  });
});

describe("DashboardController — cache savings analytics", () => {
  it("keeps DashboardGuard auth on the cache-savings endpoint", () => {
    const guards =
      Reflect.getMetadata(GUARDS_METADATA, DashboardController) || [];

    expect(guards).toEqual(expect.arrayContaining([DashboardGuard]));
  });

  it("returns provider-cache savings summary and forwards filters to the service", async () => {
    const cacheSavings = {
      getSummary: jest.fn().mockResolvedValue({
        period: "30d",
        period_days: 30,
        group_by: "team",
        filters: {
          api_key_id: "key_1",
          api_key_name: null,
          namespace_id: "team-a",
          team_id: "ops",
        },
        summary: {
          total_requests: 12,
          provider_routed_requests: 10,
          requests_with_provider_cache_hit: 6,
          cache_hit_rate: 60,
          total_input_tokens: 120000,
          total_output_tokens: 18000,
          total_cache_read_tokens: 42000,
          total_cache_creation_tokens: 3000,
          total_normal_input_tokens: 75000,
          actual_cost_usd: 1.23,
          hypothetical_no_cache_cost_usd: 1.52,
          savings_usd: 0.29,
          savings_percentage: 19.08,
          normal_input_cost_usd: 0.68,
          cache_read_cost_usd: 0.11,
          cache_creation_cost_usd: 0.04,
          output_cost_usd: 0.4,
        },
        groups: [
          {
            group_value: "ops",
            group_label: "ops",
            total_requests: 12,
            provider_routed_requests: 10,
            requests_with_provider_cache_hit: 6,
            cache_hit_rate: 60,
            total_input_tokens: 120000,
            total_output_tokens: 18000,
            total_cache_read_tokens: 42000,
            total_cache_creation_tokens: 3000,
            total_normal_input_tokens: 75000,
            actual_cost_usd: 1.23,
            hypothetical_no_cache_cost_usd: 1.52,
            savings_usd: 0.29,
            savings_percentage: 19.08,
            normal_input_cost_usd: 0.68,
            cache_read_cost_usd: 0.11,
            cache_creation_cost_usd: 0.04,
            output_cost_usd: 0.4,
          },
        ],
        daily_trend: [],
      }),
    };
    const { controller } = makeDashboard({ cacheSavings });

    const result = await controller.getCacheSavings(
      "30d",
      "team",
      undefined,
      "key_1",
      "team-a",
      "ops",
    );

    expect(cacheSavings.getSummary).toHaveBeenCalledWith("30d", "team", {
      api_key: undefined,
      api_key_id: "key_1",
      namespace: "team-a",
      team_id: "ops",
    });
    expect(result.summary.savings_usd).toBe(0.29);
    expect(result.groups[0].group_value).toBe("ops");
  });
});

describe("DashboardController — intelligence summary", () => {
  it("summarizes optimizer, token prediction, async eval, and quality gate metadata", async () => {
    const logs = [
      {
        timestamp: new Date(),
        request_id: "req-1",
        node_id: "openai",
        model: "gpt-4o",
        agent_virtual_model: "coding-auto",
        agent_connector: "cursor",
        intelligence_optimizer_applied: true,
        intelligence_estimated_savings_usd: 0.0123456,
        async_eval_queued: true,
        token_prediction_risk: "near_limit",
        quality_gate_status: "passed",
      },
      {
        timestamp: new Date(),
        request_id: "req-2",
        node_id: "anthropic",
        model: "claude-sonnet",
        agent_virtual_model: null,
        agent_connector: null,
        intelligence_optimizer_applied: false,
        intelligence_estimated_savings_usd: null,
        async_eval_queued: false,
        token_prediction_risk: "over_limit",
        quality_gate_status: "failed",
      },
      {
        timestamp: new Date(),
        request_id: "req-3",
        node_id: "openai",
        model: "gpt-4o-mini",
        agent_virtual_model: "coding-auto",
        agent_connector: "cursor",
        intelligence_optimizer_applied: true,
        intelligence_estimated_savings_usd: 0.001,
        async_eval_queued: false,
        token_prediction_risk: "within_budget",
        quality_gate_status: "skipped",
      },
    ];
    const qb = mockQueryBuilder([logs, logs.length]);
    const repo: any = mockRepo(qb);
    repo.find = jest.fn().mockResolvedValue(logs);
    const { controller } = makeDashboard({ callLogRepo: repo, qb });

    const result = await controller.getIntelligenceSummary(
      "1d",
      undefined,
      undefined,
      undefined,
    );

    expect(repo.find).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          intelligence_optimizer_applied: true,
          quality_gate_status: true,
        }),
        take: 5000,
        where: expect.objectContaining({ timestamp: expect.anything() }),
      }),
    );
    expect(result.period).toBe("1d");
    expect(result.summary).toEqual(
      expect.objectContaining({
        total_requests: 3,
        optimizer_applied: 2,
        optimizer_applied_rate: 0.6667,
        estimated_savings_usd: 0.013346,
        async_eval_queued: 1,
        token_risk: {
          near_limit: 1,
          over_limit: 1,
          within_budget: 1,
        },
        quality_gate: {
          passed: 1,
          failed: 1,
          skipped: 1,
        },
      }),
    );
    expect(result.summary.privacy).toEqual(
      expect.objectContaining({
        prompt: false,
        response: false,
        raw_headers: false,
        provider_keys: false,
        tool_payloads: false,
        storage: "metadata_only",
      }),
    );
    expect(result.by_agent[0]).toEqual(
      expect.objectContaining({
        key: "coding-auto",
        requests: 2,
        optimizer_applied: 2,
        near_or_over_budget: 1,
      }),
    );
    expect(result.by_node).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "anthropic:claude-sonnet",
          quality_gate_failed: 1,
          near_or_over_budget: 1,
        }),
      ]),
    );
  });
});

describe("DashboardController — benchmark report", () => {
  it("should return a read-only benchmark report with filters", async () => {
    const benchmarkReports = {
      getReport: jest.fn().mockResolvedValue({
        summary: { total_requests: 0, success_rate: 0 },
        by_node_model: [],
        by_source_format: [],
      }),
    };
    const { controller } = makeDashboard({ benchmarkReports });

    const result = await controller.getBenchmarkReport(
      "7d",
      "team-alpha",
      undefined,
      "key_123",
      "openai",
      "gpt-4o",
      "chat_completions",
      "250",
    );

    expect(result.summary.total_requests).toBe(0);
    expect(benchmarkReports.getReport).toHaveBeenCalledWith({
      period: "7d",
      namespace: "team-alpha",
      api_key: undefined,
      api_key_id: "key_123",
      node: "openai",
      model: "gpt-4o",
      source_format: "chat_completions",
      limit: 250,
    });
  });
});

describe("DashboardController — guardrails status", () => {
  it("should return metadata-only MCP Tool Gateway status", () => {
    const mcp = {
      getDashboardSummary: jest.fn().mockReturnValue({
        enabled: true,
        path: "/mcp",
        metadata_only: true,
        servers: [
          {
            id: "local-tools",
            name: "Local Tools",
            tools: [{ name: "search_docs" }],
          },
        ],
        recent_calls: [
          {
            id: "req_1",
            server_id: "local-tools",
            tool_name: "search_docs",
            method: "tools/call",
          },
        ],
        error_summary: [],
        denial_summary: [],
        totals: {
          servers: 1,
          enabled_servers: 1,
          tools: 1,
          recent_calls: 1,
          recent_errors: 0,
        },
      }),
    };
    const { controller } = makeDashboard({ mcp });

    const result = controller.getMcpGateway() as any;

    expect(mcp.getDashboardSummary).toHaveBeenCalled();
    expect(result.metadata_only).toBe(true);
    expect(result.servers[0].id).toBe("local-tools");
    expect(JSON.stringify(result)).not.toContain("tool arguments");
    expect(JSON.stringify(result)).not.toContain("Authorization");
  });

  it("should return privacy-safe guardrails plugin status", () => {
    const plugins = {
      getPluginStatus: jest.fn().mockReturnValue({
        enabled: true,
        mode: "audit",
        findings: {
          total: 2,
          recent: [{ rule: "secret.aws", action: "webhook" }],
        },
        webhook: {
          enabled: true,
          last_status: "sent",
          recent: [{ id: "delivery_1", status: "sent" }],
        },
        privacy: {
          prompt: false,
          response: false,
          raw_headers: false,
          provider_keys: false,
          media_bytes: false,
        },
      }),
    };
    const { controller } = makeDashboard({ plugins });

    const result = controller.getGuardrailsStatus() as any;

    expect(plugins.getPluginStatus).toHaveBeenCalledWith("guardrails");
    expect(result.enabled).toBe(true);
    expect(JSON.stringify(result)).not.toContain("https://hooks.example");
    expect(JSON.stringify(result)).not.toContain("Authorization");
  });
});

describe("DashboardController — sessions", () => {
  const logRows = [
    {
      id: 1,
      request_id: "req_1",
      session_id: "sess_1",
      session_key: "sess_1",
      trace_id: "trace_1",
      timestamp: new Date("2026-05-05T01:00:00Z"),
      source_format: "chat_completions",
      tier: "standard",
      score: 0.42,
      node_id: "openai",
      model: "gpt-4o",
      input_tokens: 100,
      output_tokens: 20,
      cost_usd: 0.001,
      latency_ms: 120,
      status_code: 200,
      is_fallback: false,
      fallback_reason: null,
      error: null,
      api_key_id: "key_1",
      api_key_name: "default",
      namespace_id: "team-a",
    },
    {
      id: 2,
      request_id: "req_2",
      session_id: "sess_1",
      session_key: "sess_1",
      trace_id: "trace_1",
      timestamp: new Date("2026-05-05T01:01:00Z"),
      source_format: "responses",
      tier: "reasoning",
      score: 0.91,
      node_id: "claude",
      model: "claude-3-opus",
      input_tokens: 80,
      output_tokens: 40,
      cost_usd: 0.002,
      latency_ms: 240,
      status_code: 502,
      is_fallback: true,
      fallback_reason: "upstream_error",
      error: "upstream failed",
      api_key_id: "key_1",
      api_key_name: "default",
      namespace_id: "team-a",
    },
  ];

  it("should list sessions grouped by session id with privacy metadata", async () => {
    const qb = mockQueryBuilder({}, [], [logRows, logRows.length]);
    qb.getMany.mockResolvedValue(logRows);
    const repo = mockRepo(qb);
    const { controller } = makeDashboard({ callLogRepo: repo, qb });

    const result = await controller.getSessions(
      "24h",
      "team-a",
      undefined,
      "key_1",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      1,
      25,
    );

    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toMatchObject({
      session_id: "sess_1",
      request_count: 2,
      error_count: 1,
      fallback_count: 1,
      model_switch_count: 1,
      total_tokens: 240,
    });
    expect(result.privacy).toMatchObject({
      prompt: false,
      response: false,
      raw_headers: false,
      provider_keys: false,
    });
    expect(qb.andWhere).toHaveBeenCalledWith(
      "log.namespace_id = :namespaceId",
      {
        namespaceId: "team-a",
      },
    );
  });

  it("should return a session timeline enriched with route, shadow, and guardrails metadata", async () => {
    const qb = mockQueryBuilder({}, [], [logRows, logRows.length]);
    qb.getMany.mockResolvedValue(logRows);
    const repo = mockRepo(qb);
    const routeDecisionRepo = {
      ...mockRepo(qb),
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([
        {
          id: 10,
          request_id: "req_2",
          trace_id: "trace_1",
          selected_node_id: "claude",
          selected_model: "claude-3-opus",
          candidate_count: 3,
          filtered_count: 1,
          route_mode: "auto",
          strategy: "weighted",
          trace_json: JSON.stringify({
            trace_id: "trace_1",
            final_selection: { reason: "fallback selected" },
          }),
        },
      ]),
    };
    const shadowTrafficRepo = {
      ...mockRepo(qb),
      find: jest.fn().mockResolvedValue([
        {
          request_id: "req_2",
          status: "sent",
          shadow_node: "shadow-openai",
          shadow_model: "gpt-4o-mini",
          latency_ms: 90,
        },
      ]),
    };
    const plugins = {
      getPluginStatus: jest.fn().mockReturnValue({
        findings: {
          recent: [
            {
              request_id: "req_2",
              kind: "pii",
              action: "audit",
              rule: "pii.email",
            },
          ],
        },
      }),
    };
    const { controller } = makeDashboard({
      callLogRepo: repo,
      routeDecisionRepo,
      shadowTrafficRepo,
      plugins,
      qb,
    });

    const result = await controller.getSessionDetail(
      "sess_1",
      "7d",
      "team-a",
      undefined,
      "key_1",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      200,
    );

    expect(result.summary.request_count).toBe(2);
    expect(result.timeline[1]).toMatchObject({
      request_id: "req_2",
      route_decision_link: "/route-decisions/req_2",
      has_route_decision: true,
      shadow: { count: 1 },
      guardrails: { count: 1, kinds: ["pii"] },
    });
    expect(JSON.stringify(result)).not.toContain("sk-test");
    expect(JSON.stringify(result)).not.toContain("Bearer ");
  });

  it("should return 404 when a session has no matching logs", async () => {
    const qb = mockQueryBuilder({}, [], [[], 0]);
    qb.getMany.mockResolvedValue([]);
    const repo = mockRepo(qb);
    const { controller } = makeDashboard({ callLogRepo: repo, qb });

    await expect(controller.getSessionDetail("missing")).rejects.toBeInstanceOf(
      HttpException,
    );
  });
});

// ═══════════════════════════════════════════════════════════
// Logs
// ═══════════════════════════════════════════════════════════

describe("DashboardController — getLogs", () => {
  it("should aggregate filtered log metrics and per-key usage", async () => {
    const summaryQb = mockQueryBuilder({}, [
      {
        apiKeyId: "key_alpha",
        apiKeyName: "Alpha",
        requestCount: "4",
        inputTokens: "100",
        outputTokens: "50",
        costUsd: "1.2345678",
        successCount: "3",
        cacheHitCount: "2",
      },
      {
        apiKeyId: null,
        apiKeyName: null,
        requestCount: "1",
        inputTokens: "10",
        outputTokens: "10",
        costUsd: "0.1",
        successCount: "1",
        cacheHitCount: "0",
      },
    ]);
    const trendQb = mockQueryBuilder({}, [
      {
        hour: "0",
        requestCount: "2",
        inputTokens: "40",
        outputTokens: "10",
        costUsd: "0.1234567",
      },
      {
        hour: "13",
        requestCount: "3",
        inputTokens: "70",
        outputTokens: "50",
        costUsd: "1.2111111",
      },
    ]);
    const repo = {
      count: jest.fn().mockResolvedValue(0),
      createQueryBuilder: jest
        .fn()
        .mockReturnValueOnce(summaryQb)
        .mockReturnValueOnce(trendQb),
    };
    const { controller } = makeDashboard({ callLogRepo: repo });

    const result = await controller.getLogsSummary(
      "standard",
      "openai",
      "200",
      undefined,
      undefined,
      undefined,
      "today",
    );

    expect(result.total).toEqual({
      requests: 5,
      input_tokens: 110,
      output_tokens: 60,
      tokens: 170,
      cost_usd: 1.334568,
      successes: 4,
      success_rate: 80,
      cache_hits: 2,
      cache_rate: 40,
    });
    expect(result.by_key[0]).toMatchObject({
      api_key_id: "key_alpha",
      api_key_name: "Alpha",
      requests: 4,
      tokens: 150,
      cost_usd: 1.234568,
      success_rate: 75,
      cache_rate: 50,
    });
    expect(result.hourly_trend).toHaveLength(24);
    expect(result.hourly_trend.map((bucket) => bucket.hour)).toEqual(
      Array.from({ length: 24 }, (_, hour) => hour),
    );
    expect(result.hourly_trend[0]).toEqual({
      hour: 0,
      requests: 2,
      input_tokens: 40,
      output_tokens: 10,
      tokens: 50,
      cost_usd: 0.123457,
    });
    expect(result.hourly_trend[1]).toEqual({
      hour: 1,
      requests: 0,
      input_tokens: 0,
      output_tokens: 0,
      tokens: 0,
      cost_usd: 0,
    });
    expect(result.hourly_trend[13]).toMatchObject({
      requests: 3,
      tokens: 120,
      cost_usd: 1.211111,
    });
    expect(summaryQb.andWhere).toHaveBeenCalledWith("log.tier = :tier", {
      tier: "standard",
    });
    expect(summaryQb.andWhere).toHaveBeenCalledWith("log.timestamp < :until", {
      until: expect.any(Date),
    });
    expect(summaryQb.andWhere).toHaveBeenCalledWith("log.node_id = :node", {
      node: "openai",
    });
    expect(summaryQb.andWhere).toHaveBeenCalledWith("log.status_code = :status", {
      status: 200,
    });
    expect(summaryQb.addSelect).toHaveBeenCalledWith(
      expect.stringContaining("client_closed_after_tool_call"),
      "successCount",
    );
    expect(trendQb.where).toHaveBeenCalledWith(
      "log.timestamp >= :trendStart AND log.timestamp < :trendEnd",
      { trendStart: expect.any(Date), trendEnd: expect.any(Date) },
    );
    expect(trendQb.select).toHaveBeenCalledWith(
      expect.stringContaining("WHEN log.timestamp >= :hourStart0"),
      "hour",
    );
    expect(trendQb.groupBy).toHaveBeenCalledWith("hour");
    expect(trendQb.andWhere).toHaveBeenCalledWith("log.tier = :tier", {
      tier: "standard",
    });
    expect(trendQb.andWhere).toHaveBeenCalledWith("log.node_id = :node", {
      node: "openai",
    });
    expect(trendQb.andWhere).toHaveBeenCalledWith(
      "log.status_code = :status",
      { status: 200 },
    );
    expect(trendQb.andWhere).toHaveBeenCalledWith(
      "(log.workspace_id = :workspaceId OR log.workspace_id IS NULL)",
      { workspaceId: "default-workspace" },
    );
  });

  it("should only query and return hourly trend buckets for today", async () => {
    const qb = mockQueryBuilder({}, []);
    const repo = mockRepo(qb);
    const { controller } = makeDashboard({ callLogRepo: repo, qb });

    const result = await controller.getLogsSummary(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "7d",
    );

    expect(result.hourly_trend).toEqual([]);
    expect(repo.createQueryBuilder).toHaveBeenCalledTimes(1);
  });

  it("should return paginated logs", async () => {
    const logs = [
      {
        id: 1,
        model: "gpt-4o",
        reasoning_requested: true,
        reasoning_effort: "high",
        reasoning_strategy: "passthrough",
        reasoning_supported: true,
      },
      { id: 2, model: "claude-3-opus" },
    ];
    const qb = mockQueryBuilder();
    qb.getManyAndCount.mockResolvedValue([logs, 50]);
    const repo = mockRepo(qb);

    const { controller } = makeDashboard({ callLogRepo: repo, qb });
    const result = await controller.getLogs(1, 50);

    expect(result.data).toHaveLength(2);
    expect(result.data[0]).toMatchObject({
      reasoning_requested: true,
      reasoning_effort: "high",
      reasoning_strategy: "passthrough",
      reasoning_supported: true,
    });
    expect(result.pagination.page).toBe(1);
    expect(result.pagination.total).toBe(50);
    expect(result.pagination.totalPages).toBe(1);
  });

  it("should apply filters", async () => {
    const qb = mockQueryBuilder();
    qb.getManyAndCount.mockResolvedValue([[], 0]);
    const repo = mockRepo(qb);

    const { controller } = makeDashboard({ callLogRepo: repo, qb });
    await controller.getLogs(1, 50, "standard", "openai", "200");

    expect(qb.andWhere).toHaveBeenCalledTimes(4);
  });

  it("should clamp limit to max 200", async () => {
    const qb = mockQueryBuilder();
    qb.getManyAndCount.mockResolvedValue([[], 0]);
    const repo = mockRepo(qb);

    const { controller } = makeDashboard({ callLogRepo: repo, qb });
    const result = await controller.getLogs(1, 999);

    expect(result.pagination.limit).toBe(200);
  });
});

describe("DashboardController — route decisions", () => {
  const trace = {
    version: 1,
    mode: "auto",
    tier: "standard",
    score: 0.45,
    domain_hints: { domain: "backend", modalities: ["text"] },
    scoring: { tier: "standard", score: 0.45, momentum_adjusted: false },
    constraints: {
      estimated_input_tokens: 12,
      estimated_output_tokens: 100,
      estimated_context_tokens: 112,
      requires_structured_output: false,
    },
    modality_evidence: {
      requested_modality: "image",
      input_types: ["text"],
      output_types: ["image"],
      file_count: 1,
      byte_size: 2048,
      required_capabilities: ["image"],
      endpoint_strategy: "image_generation",
      filtered_by_capability: [],
      filtered_by_file_size: [],
    },
    candidate_targets: [
      {
        node: "openai",
        model: "gpt-4o",
        weight: 70,
        position: 0,
        circuit_state: "CLOSED",
        circuit_available: true,
        selected: true,
        fallback: false,
        filter_reasons: [],
        scores: { cost: 0.99, latency: 0.8, context: 0.99 },
        metrics: {
          estimated_cost_usd: 0.001,
          avg_latency_ms: 100,
          p95_latency_ms: 150,
          max_context_tokens: 128000,
          context_fit: "safe",
          structured_output: true,
        },
        capability_evidence: {
          requested_modality: "image",
          supported_modalities: ["text", "vision", "image"],
          input_types: ["text", "image"],
          output_types: ["image"],
          required_capabilities: ["image"],
          matched_capabilities: ["image"],
          missing_capabilities: [],
          endpoint_strategy: "image_generation",
          endpoint_status: "default",
          endpoint: "/v1/images/generations",
          file_count: 1,
          byte_size: 2048,
          max_file_size: 10_000_000,
          filtered_by_capability: false,
          filtered_by_file_size: false,
          pricing_source: "config",
          catalog_source: "config",
        },
      },
    ],
    filters: [],
    load_balancing: {
      strategy: "balanced",
      source: "targets",
      selected: { node: "openai", model: "gpt-4o" },
      target_count: 1,
      reason: "balanced local cost and latency score",
    },
    fallback_chain: [],
    cost_downgrade: null,
    final_selection: {
      node: "openai",
      model: "gpt-4o",
      reason: "balanced local cost and latency score",
      is_fallback: false,
      fallback_reason: null,
    },
    privacy: {
      prompt: false,
      response: false,
      raw_headers: false,
      provider_keys: false,
    },
  };

  it("should list paginated route decision summaries", async () => {
    const item = {
      id: 1,
      request_id: "req-1",
      timestamp: new Date(),
      source_format: "chat_completions",
      tier: "standard",
      score: 0.45,
      route_mode: "auto",
      strategy: "balanced",
      selected_node_id: "openai",
      selected_model: "gpt-4o",
      domain_hint: "backend",
      candidate_count: 1,
      filtered_count: 0,
      status_code: 200,
      is_fallback: false,
      fallback_reason: null,
      api_key_name: "prod",
      api_key_id: "key_1",
      namespace_id: "team-alpha",
      trace_json: JSON.stringify(trace),
    };
    const qb = mockQueryBuilder();
    qb.getManyAndCount.mockResolvedValue([[item], 1]);
    const routeDecisionRepo = {
      ...mockRepo(qb),
      findOne: jest.fn(),
    };
    const { controller } = makeDashboard({ routeDecisionRepo, qb });

    const result = await controller.getRouteDecisions(
      1,
      50,
      "standard",
      "openai",
      "chat_completions",
    );

    expect(result.data[0]).toMatchObject({
      request_id: "req-1",
      selected: { node: "openai", model: "gpt-4o" },
      summary: {
        reason: "balanced",
      },
    });
    expect(result.data[0]).not.toHaveProperty("trace");
    expect(qb.select).toHaveBeenCalledWith(
      expect.not.arrayContaining(["decision.trace_json"]),
    );
    expect(qb.andWhere).toHaveBeenCalledWith("decision.tier = :tier", {
      tier: "standard",
    });
    expect(qb.andWhere).toHaveBeenCalledWith(
      "decision.selected_node_id = :node",
      { node: "openai" },
    );
    expect(qb.andWhere).toHaveBeenCalledWith(
      "decision.source_format = :sourceFormat",
      { sourceFormat: "chat_completions" },
    );
  });

  it("should return a full route decision trace by request id", async () => {
    const routeDecisionRepo = {
      ...mockRepo(mockQueryBuilder()),
      findOne: jest.fn().mockResolvedValue({
        id: 1,
        request_id: "req-1",
        timestamp: new Date(),
        source_format: "chat_completions",
        tier: "standard",
        score: 0.45,
        route_mode: "auto",
        strategy: "balanced",
        selected_node_id: "openai",
        selected_model: "gpt-4o",
        domain_hint: "backend",
        candidate_count: 1,
        filtered_count: 0,
        status_code: 200,
        is_fallback: false,
        fallback_reason: null,
        api_key_name: null,
        api_key_id: null,
        namespace_id: null,
        trace_json: JSON.stringify(trace),
      }),
    };
    const { controller } = makeDashboard({ routeDecisionRepo });

    const result = await controller.getRouteDecision("req-1");

    expect(routeDecisionRepo.findOne).toHaveBeenCalledWith({
      where: {
        workspace_id: "default-workspace",
        request_id: "req-1",
      },
    });
    expect(result.trace).toMatchObject({
      modality_evidence: {
        requested_modality: "image",
        byte_size: 2048,
      },
      candidate_targets: expect.any(Array),
      privacy: {
        prompt: false,
        response: false,
        raw_headers: false,
        provider_keys: false,
      },
    });
  });
});

describe("DashboardController — catalog", () => {
  it("returns merged provider catalog metadata for Dashboard forms", () => {
    const { controller } = makeDashboard();

    const result = controller.getCatalogProviders();

    expect(result.override_file).toBe("catalog.override.yaml");
    expect(result.override_found).toBe(false);
    expect(result.sync_status).toMatchObject({
      enabled: false,
      scheduled: false,
      write_to: "cache",
    });
    expect(result.providers[0]).toMatchObject({
      id: "openai",
      provider_id: "openai",
      provider_status: "active",
      default_visible: true,
      family: "foundation",
      provider_type: "direct",
      compatibility_profile: "openai-compatible",
      logo_id: "openai",
      aliases: expect.arrayContaining(["openai"]),
      model_buckets: expect.objectContaining({
        models: expect.arrayContaining(["gpt-4o"]),
        embedding_models: expect.arrayContaining(["text-embedding-3-small"]),
      }),
      recommended_model_buckets: expect.objectContaining({
        models: expect.arrayContaining(["gpt-4o"]),
        embedding_models: expect.arrayContaining(["text-embedding-3-small"]),
      }),
      latest_model_hints: expect.objectContaining({
        models: expect.objectContaining({
          primary_model: "gpt-4o",
          source: "fallback",
        }),
      }),
      overridden: false,
      pricing_hygiene: expect.objectContaining({
        status: expect.any(String),
        source_type: expect.any(String),
        source_url_missing: false,
      }),
      canonical_model_coverage: expect.objectContaining({
        total_models: expect.any(Number),
        coverage_ratio: expect.any(Number),
      }),
      pricing_coverage: expect.objectContaining({
        total_models: expect.any(Number),
        priced_models: expect.any(Number),
        recommended_models: expect.any(Number),
      }),
    });
  });

  it("filters catalog models by provider and modality", () => {
    const { controller } = makeDashboard();

    const result = controller.getCatalogModels("openai", "vision");

    expect(result.models).toEqual([
      expect.objectContaining({
        id: "gpt-4o",
        provider: "openai",
        pricing_hygiene: expect.objectContaining({
          status: expect.any(String),
          source_type: expect.any(String),
        }),
        pricing: expect.objectContaining({
          source_type: expect.any(String),
          input_per_1m_tokens: expect.any(Number),
        }),
      }),
    ]);
  });

  it("returns v1.8 provider catalog entries from the merged catalog API shape, including legacy rows behind show_legacy", () => {
    const loaded = loadMergedCatalog({
      cwd: process.cwd(),
      overridePath: MISSING_CATALOG_OVERRIDE,
      syncCachePath: MISSING_CATALOG_SYNC_CACHE,
      env: {},
    });
    const { controller } = makeDashboard({
      catalog: {
        load: jest.fn().mockReturnValue(loaded),
      },
    });

    const result = controller.getCatalogProviders("true");
    const providerIds = result.providers.map((provider: any) => provider.id);
    const huggingFace = result.providers.find(
      (provider: any) => provider.id === "huggingface",
    );

    expect(providerIds.length).toBeGreaterThanOrEqual(50);
    expect(providerIds).toEqual(
      expect.arrayContaining([
        "huggingface",
        "cloudflare-workers-ai",
        "deepgram",
        "xinference",
      ]),
    );
    expect(huggingFace).toMatchObject({
      provider_type: "aggregator",
      logo_id: "huggingface",
      status: "transport_only",
      provider_status: "transport_only",
      default_visible: false,
      model_buckets: {
        models: expect.arrayContaining([
          "meta-llama/Llama-3.3-70B-Instruct",
          "sentence-transformers/all-MiniLM-L6-v2",
        ]),
        embedding_models: ["sentence-transformers/all-MiniLM-L6-v2"],
        rerank_models: [],
        image_models: [],
        audio_models: [],
        video_models: [],
        realtime_models: [],
        batch_models: [],
      },
    });
  });

  it("shows active providers by default and reveals transport-only rows only with show_legacy", () => {
    const loaded = loadMergedCatalog({
      cwd: process.cwd(),
      overridePath: MISSING_CATALOG_OVERRIDE,
      syncCachePath: MISSING_CATALOG_SYNC_CACHE,
      env: {},
    });
    const { controller } = makeDashboard({
      catalog: {
        load: jest.fn().mockReturnValue(loaded),
      },
    });

    const activeOnly = controller.getCatalogProviders();
    const withLegacy = controller.getCatalogProviders("true");

    expect(activeOnly.providers.map((provider: any) => provider.id)).toEqual(
      expect.arrayContaining(["openai", "anthropic", "openrouter"]),
    );
    expect(activeOnly.providers.map((provider: any) => provider.id)).not.toEqual(
      expect.arrayContaining([
        "deepgram",
        "huggingface",
        "xinference",
        "openai-compatible",
      ]),
    );
    expect(withLegacy.providers.map((provider: any) => provider.id)).toEqual(
      expect.arrayContaining([
        "deepgram",
        "huggingface",
        "xinference",
        "openai-compatible",
      ]),
    );

    const huggingFace = withLegacy.providers.find(
      (provider: any) => provider.id === "huggingface",
    );
    expect(huggingFace).toMatchObject({
      status: "transport_only",
      provider_status: "transport_only",
      default_visible: false,
    });
  });

  it("surfaces v1.7 catalog enrichment metadata through provider and model catalog APIs", () => {
    const cwd = fs.mkdtempSync(
      path.join(os.tmpdir(), "siftgate-dashboard-catalog-enrichment-"),
    );
    const syncCachePath = path.join(cwd, ".siftgate/catalog-sync-cache.yaml");
    fs.mkdirSync(path.dirname(syncCachePath), { recursive: true });
    fs.writeFileSync(
      syncCachePath,
      [
        "version: 1",
        "providers:",
        "  openai:",
        "    models:",
        "      - id: gpt-4o",
        "        enrichment:",
        "          source: zeroeval",
        "          enriched_from: zeroeval",
        "          source_url: https://api.zeroeval.com/leaderboard/models/full?justCanonicals=false",
        "          synced_at: 2026-05-06T00:00:00.000Z",
        "          enriched_at: 2026-05-06T00:00:00.000Z",
        "          organization: OpenAI",
        "          organization_id: openai",
        "          canonical_model_id: chatgpt-4o-latest",
        "          release_date: 2024-05-13",
        "          announcement_date: 2024-05-13",
        "          multimodal: true",
        "          throughput: 132",
        "          lifecycle:",
        "            release_date: 2024-05-13",
        "            announcement_date: 2024-05-13",
        "          specs:",
        "            throughput: 132",
        "            multimodal: true",
        "            params: 200000000000",
        "          benchmarks:",
        "            gpqa_score: 0.84",
        "        pricing:",
        "          input: 2.5",
        "          output: 10",
        "          source: zeroeval",
        "          source_url: https://api.zeroeval.com/leaderboard/models/full?justCanonicals=false",
        "          last_updated: 2026-05-06",
        "          last_sync: 2026-05-06T00:00:00.000Z",
        "          manual_review_required: true",
        "          stale_after_days: 7",
        "          pricing_confidence: medium",
        "          currency: USD",
        "",
      ].join("\n"),
      "utf8",
    );
    const loaded = loadMergedCatalog({ cwd, env: {} });
    const { controller } = makeDashboard({
      config: {
        getFullConfig: jest.fn().mockReturnValue({
          server: { port: 3000 },
          database: { type: "sqlite" },
          auth: {
            api_keys: [{ name: "default", key: "gw_sk_dev_default_rest" }],
          },
          nodes: [
            {
              id: "openai",
              name: "OpenAI",
              api_key: "sk-test12345678rest",
              models: ["gpt-4o"],
            },
          ],
          routing: {},
          budget: {},
          models_pricing: {},
          catalog: {
            sync: {
              cache_file: syncCachePath,
            },
          },
        }),
      },
      catalog: {
        load: jest.fn().mockReturnValue(loaded),
      },
    });

    const providers = controller.getCatalogProviders();
    const models = controller.getCatalogModels("openai");
    const openai = providers.providers.find(
      (provider: any) => provider.id === "openai",
    );
    const gpt4o = models.models.find((model: any) => model.id === "gpt-4o");

    expect(openai).toMatchObject({
      provider_status: "active",
      default_visible: true,
      canonical_model_coverage: expect.objectContaining({
        total_models: expect.any(Number),
        canonicalized_models: expect.any(Number),
        enriched_models: expect.any(Number),
      }),
      pricing_coverage: expect.objectContaining({
        total_models: expect.any(Number),
        priced_models: expect.any(Number),
        recommended_priced_models: expect.any(Number),
      }),
      enrichment_summary: {
        enriched_model_count: expect.any(Number),
        benchmarked_model_count: expect.any(Number),
        latest_enriched_at: "2026-05-06T00:00:00.000Z",
        sources: ["zeroeval"],
      },
      recommended_model_buckets: {
        models: expect.arrayContaining(["gpt-4o"]),
        embedding_models: expect.arrayContaining(["text-embedding-3-small"]),
      },
      latest_model_hints: expect.objectContaining({
        models: expect.objectContaining({
          primary_model: "gpt-4o",
          release_date: "2024-05-13",
          source: "recommended",
        }),
      }),
    });
    expect(gpt4o).toMatchObject({
      canonical_id: "chatgpt-4o-latest",
      projection_source: "sync_cache",
      lifecycle: {
        release_date: "2024-05-13",
        announcement_date: "2024-05-13",
      },
      specs: {
        throughput: 132,
        multimodal: true,
        params: 200000000000,
      },
      benchmarks: {
        gpqa_score: 0.84,
      },
      match_confidence: undefined,
      pricing_sources: {
        effective: expect.objectContaining({
          source: "zeroeval",
          has_pricing: true,
        }),
        effective_source: "zeroeval",
        primary_reference: undefined,
        primary_reference_source: null,
        secondary_reference: undefined,
        secondary_reference_source: null,
      },
      enrichment: {
        source: "zeroeval",
        enriched_from: "zeroeval",
        organization: "OpenAI",
        organization_id: "openai",
        canonical_model_id: "chatgpt-4o-latest",
        lifecycle: {
          release_date: "2024-05-13",
          announcement_date: "2024-05-13",
        },
        specs: {
          throughput: 132,
          multimodal: true,
          params: 200000000000,
        },
        benchmarks: {
          gpqa_score: 0.84,
        },
      },
    });
    expect(openai?.recommended_models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          bucket: "models",
          model_id: "gpt-4o",
          source: "recommended",
        }),
      ]),
    );
  });

  it("surfaces canonical projection and pricing source layering through dashboard catalog APIs", () => {
    const catalogLoad = {
      catalog: {
        providers: [
          {
            id: "openai",
            name: "OpenAI",
            base_url: "https://api.openai.com",
            auth_type: "bearer",
            endpoints: { chat_completions: "/v1/chat/completions" },
            models: [
              {
                id: "gpt-4.1",
                provider: "openai",
                modalities: ["text"],
                endpoints: { chat_completions: "/v1/chat/completions" },
                capabilities: ["streaming"],
                pricing: {
                  input: 1.9,
                  output: 7.5,
                  input_per_1m_tokens: 1.9,
                  output_per_1m_tokens: 7.5,
                  source: "catalog-override",
                  source_type: "operator_override",
                  last_updated: "2026-05-06",
                  manual_review_required: false,
                },
                enrichment: {
                  source: "zeroeval",
                  enriched_from: "zeroeval",
                  match_strategy: "exact_canonical_slug",
                  match_confidence: "high",
                  lifecycle: {
                    release_date: "2026-04-14",
                  },
                  benchmarks: {
                    gpqa_score: 0.91,
                  },
                  secondary_pricing_reference: {
                    input: 2.1,
                    output: 8.1,
                    input_per_1m_tokens: 2.1,
                    output_per_1m_tokens: 8.1,
                    source: "zeroeval",
                    source_type: "aggregator_api",
                    source_url:
                      "https://api.zeroeval.com/leaderboard/models/full?justCanonicals=false",
                    last_updated: "2026-05-06",
                    manual_review_required: true,
                    pricing_confidence: "medium",
                  },
                },
                source: "override",
                overridden: true,
                synced: true,
              },
            ],
            source: "sync_cache",
            overridden: false,
          },
        ],
      },
      overridePath: "catalog.override.yaml",
      overrideFound: false,
      syncCachePath: ".siftgate/catalog-sync-cache.yaml",
      syncCacheFound: true,
      internal: {
        canonical_registry: {
          version: 1,
          primary_source: "openrouter",
          source_url: "https://openrouter.ai/api/v1/models?output_modalities=all",
          generated_at: "2026-05-06T00:00:00.000Z",
          model_count: 1,
          models: [
            {
              canonical_id: "openai/gpt-4.1",
              source_model_id: "openai/gpt-4.1",
              source_provider_slug: "openai",
              display_name: "GPT-4.1",
              canonical_slug: "gpt-4.1",
              context_length: 1048576,
              pricing_reference: {
                input: 2,
                output: 8,
                input_per_1m_tokens: 2,
                output_per_1m_tokens: 8,
                source: "openrouter-public-api",
                source_type: "aggregator_api",
                source_url:
                  "https://openrouter.ai/api/v1/models?output_modalities=all",
                last_updated: "2026-05-06",
                manual_review_required: true,
                pricing_confidence: "medium",
              },
              enrichment: {
                source: "zeroeval",
                enriched_from: "zeroeval",
                lifecycle: {
                  release_date: "2026-04-14",
                },
                benchmarks: {
                  gpqa_score: 0.91,
                },
              },
              source_metadata: {
                source: "openrouter",
                source_url:
                  "https://openrouter.ai/api/v1/models?output_modalities=all",
                synced_at: "2026-05-06T00:00:00.000Z",
                dataset_role: "canonical_primary",
              },
            },
          ],
        },
      },
      issues: [],
    };
    const { controller } = makeDashboard({
      catalog: {
        load: jest.fn().mockReturnValue(catalogLoad),
      },
    });

    const providers = controller.getCatalogProviders();
    const models = controller.getCatalogModels("openai");
    const openai = providers.providers.find(
      (provider: any) => provider.id === "openai",
    );
    const gpt41 = models.models.find((model: any) => model.id === "gpt-4.1");

    expect(openai).toMatchObject({
      provider_status: "active",
      default_visible: true,
      canonical_model_coverage: {
        total_models: 1,
        canonicalized_models: 1,
        projected_models: 1,
        enriched_models: 1,
        benchmarked_models: 1,
        low_confidence_models: 0,
        coverage_ratio: 1,
      },
      pricing_coverage: {
        total_models: 1,
        priced_models: 1,
        recommended_models: 1,
        recommended_priced_models: 1,
        manual_review_required_priced_models: 0,
        estimate_ready_models: 1,
        aligned_estimate_models: 0,
        reference_estimate_models: 1,
        review_required_models: 0,
        missing_models: 0,
        coverage_ratio: 1,
      },
      pricing_trust_summary: {
        status: "reference_estimate",
        total_models: 1,
        estimate_ready_models: 1,
        aligned_estimate_models: 0,
        reference_estimate_models: 1,
        review_required_models: 0,
        missing_models: 0,
      },
    });
    expect(gpt41).toMatchObject({
      canonical_id: "openai/gpt-4.1",
      projection_source: "canonical_projection",
      lifecycle: {
        release_date: "2026-04-14",
      },
      benchmarks: {
        gpqa_score: 0.91,
      },
      match_confidence: "high",
      pricing_trust: "reference_estimate",
      pricing_sources: {
        effective: expect.objectContaining({
          source: "catalog-override",
          source_type: "operator_override",
          has_pricing: true,
        }),
        primary_reference: expect.objectContaining({
          source: "openrouter-public-api",
          source_type: "aggregator_api",
          has_pricing: true,
        }),
        secondary_reference: expect.objectContaining({
          source: "zeroeval",
          source_type: "aggregator_api",
          has_pricing: true,
        }),
        effective_source: "catalog-override",
        primary_reference_source: "openrouter-public-api",
        secondary_reference_source: "zeroeval",
      },
    });
  });

  it("marks OpenRouter canonical numeric pricing as aligned estimate instead of review-required", () => {
    const catalogLoad = {
      catalog: {
        providers: [
          {
            id: "anthropic",
            name: "Anthropic",
            base_url: "https://api.anthropic.com",
            auth_type: "x-api-key",
            endpoints: { messages: "/v1/messages" },
            models: [
              {
                id: "claude-3-7-sonnet-20250219",
                provider: "anthropic",
                modalities: ["text"],
                endpoints: { messages: "/v1/messages" },
                capabilities: ["streaming"],
                pricing: {
                  input: 3,
                  output: 15,
                  input_per_1m_tokens: 3,
                  output_per_1m_tokens: 15,
                  source: "openrouter-public-api",
                  source_type: "aggregator_api",
                  last_updated: "2026-05-06",
                  manual_review_required: true,
                  pricing_confidence: "medium",
                },
                enrichment: {
                  source: "zeroeval",
                  enriched_from: "zeroeval",
                  match_strategy: "exact_source_model_id",
                  match_confidence: "high",
                  canonical_model_id: "anthropic/claude-3-7-sonnet-20250219",
                },
                source: "sync_cache",
                synced: true,
              },
            ],
            source: "sync_cache",
            overridden: false,
          },
        ],
      },
      overridePath: "catalog.override.yaml",
      overrideFound: false,
      syncCachePath: ".siftgate/catalog-sync-cache.yaml",
      syncCacheFound: true,
      internal: {
        canonical_registry: {
          version: 1,
          primary_source: "openrouter",
          source_url: "https://openrouter.ai/api/v1/models?output_modalities=all",
          generated_at: "2026-05-06T00:00:00.000Z",
          model_count: 1,
          models: [
            {
              canonical_id: "anthropic/claude-3-7-sonnet-20250219",
              source_model_id: "anthropic/claude-3-7-sonnet-20250219",
              source_provider_slug: "anthropic",
              display_name: "Claude 3.7 Sonnet",
              canonical_slug: "claude-3-7-sonnet-20250219",
              source_metadata: {
                source: "openrouter",
                synced_at: "2026-05-06T00:00:00.000Z",
                dataset_role: "canonical_primary",
              },
            },
          ],
        },
      },
      issues: [],
    };
    const { controller } = makeDashboard({
      catalog: {
        load: jest.fn().mockReturnValue(catalogLoad),
      },
    });

    const providers = controller.getCatalogProviders();
    const models = controller.getCatalogModels("anthropic");
    const anthropic = providers.providers.find(
      (provider: any) => provider.id === "anthropic",
    );
    const sonnet = models.models.find(
      (model: any) => model.id === "claude-3-7-sonnet-20250219",
    );

    expect(sonnet).toMatchObject({
      canonical_id: "anthropic/claude-3-7-sonnet-20250219",
      pricing_trust: "aligned_estimate",
      pricing_sources: {
        effective: expect.objectContaining({
          source: "openrouter-public-api",
          has_pricing: true,
        }),
      },
    });
    expect(anthropic).toMatchObject({
      manual_review_required: false,
      pricing_trust_summary: {
        status: "aligned_estimate",
        total_models: 1,
        estimate_ready_models: 1,
        aligned_estimate_models: 1,
        reference_estimate_models: 0,
        review_required_models: 0,
        missing_models: 0,
      },
      pricing_coverage: expect.objectContaining({
        estimate_ready_models: 1,
        aligned_estimate_models: 1,
        review_required_models: 0,
        missing_models: 0,
      }),
    });
    expect(anthropic?.pricing_trust_summary?.status).not.toBe(
      "review_required",
    );
  });

  it("keeps docs-only provider references without numeric values in review buckets", () => {
    const catalogLoad = {
      catalog: {
        providers: [
          {
            id: "01ai",
            name: "01.AI",
            base_url: "https://api.01.ai",
            auth_type: "bearer",
            endpoints: { chat_completions: "/v1/chat/completions" },
            models: [
              {
                id: "yi-large",
                provider: "01ai",
                modalities: ["text"],
                endpoints: { chat_completions: "/v1/chat/completions" },
                capabilities: ["streaming"],
                pricing: {
                  source: "provider-reference",
                  source_type: "docs_review",
                  source_url: "https://platform.01.ai/docs",
                  last_updated: "2026-05-06",
                  manual_review_required: true,
                  pricing_confidence: "low",
                },
                source: "builtin",
              },
            ],
            source: "builtin",
            overridden: false,
          },
        ],
      },
      overridePath: "catalog.override.yaml",
      overrideFound: false,
      syncCachePath: ".siftgate/catalog-sync-cache.yaml",
      syncCacheFound: false,
      issues: [],
    };
    const { controller } = makeDashboard({
      catalog: {
        load: jest.fn().mockReturnValue(catalogLoad),
      },
    });

    const providers = controller.getCatalogProviders();
    const models = controller.getCatalogModels("01ai");
    const provider = providers.providers.find(
      (entry: any) => entry.id === "01ai",
    );
    const yi = models.models.find((model: any) => model.id === "yi-large");

    expect(yi).toMatchObject({
      pricing_trust: "review_required",
      pricing_sources: {
        effective: expect.objectContaining({
          source: "provider-reference",
          has_pricing: false,
        }),
      },
    });
    expect(provider).toMatchObject({
      manual_review_required: true,
      pricing_trust_summary: expect.objectContaining({
        status: "review_required",
        estimate_ready_models: 0,
        aligned_estimate_models: 0,
        reference_estimate_models: 0,
        review_required_models: 1,
        missing_models: 0,
      }),
      pricing_coverage: expect.objectContaining({
        estimate_ready_models: 0,
        review_required_models: 1,
        missing_models: 0,
      }),
    });
  });

  it("prefers enriched latest stable models over alphabetical old variants for fresh defaults", () => {
    const catalogLoad = {
      catalog: {
        providers: [
          {
            id: "anthropic",
            name: "Anthropic",
            base_url: "https://api.anthropic.com",
            auth_type: "x-api-key",
            endpoints: { messages: "/v1/messages" },
            models: [
              {
                id: "claude-3-5-sonnet-20240620",
                provider: "anthropic",
                modalities: ["text"],
                endpoints: { messages: "/v1/messages" },
                capabilities: ["streaming"],
                pricing: {
                  input: 3,
                  output: 15,
                  input_per_1m_tokens: 3,
                  output_per_1m_tokens: 15,
                  source: "zeroeval",
                  last_updated: "2026-05-06",
                  manual_review_required: true,
                },
                enrichment: {
                  source: "zeroeval",
                  enriched_from: "zeroeval",
                  release_date: "2024-06-21",
                  canonical_model_id: "claude-sonnet",
                },
                source: "sync_cache",
                overridden: false,
              },
              {
                id: "claude-3-7-sonnet-preview",
                provider: "anthropic",
                modalities: ["text"],
                endpoints: { messages: "/v1/messages" },
                capabilities: ["streaming"],
                pricing: {
                  input: 3,
                  output: 15,
                  input_per_1m_tokens: 3,
                  output_per_1m_tokens: 15,
                  source: "zeroeval",
                  last_updated: "2026-05-06",
                  manual_review_required: true,
                },
                enrichment: {
                  source: "zeroeval",
                  enriched_from: "zeroeval",
                  release_date: "2025-02-25",
                  canonical_model_id: "claude-sonnet",
                },
                source: "sync_cache",
                overridden: false,
              },
              {
                id: "claude-3-7-sonnet-20250219",
                provider: "anthropic",
                modalities: ["text"],
                endpoints: { messages: "/v1/messages" },
                capabilities: ["streaming"],
                pricing: {
                  input: 3,
                  output: 15,
                  input_per_1m_tokens: 3,
                  output_per_1m_tokens: 15,
                  source: "zeroeval",
                  last_updated: "2026-05-06",
                  manual_review_required: true,
                },
                enrichment: {
                  source: "zeroeval",
                  enriched_from: "zeroeval",
                  release_date: "2025-02-24",
                  canonical_model_id: "claude-sonnet",
                },
                source: "sync_cache",
                overridden: false,
              },
              {
                id: "claude-3-5-haiku-20241022",
                provider: "anthropic",
                modalities: ["text"],
                endpoints: { messages: "/v1/messages" },
                capabilities: ["streaming"],
                pricing: {
                  input: 0.8,
                  output: 4,
                  input_per_1m_tokens: 0.8,
                  output_per_1m_tokens: 4,
                  source: "zeroeval",
                  last_updated: "2026-05-06",
                  manual_review_required: true,
                },
                enrichment: {
                  source: "zeroeval",
                  enriched_from: "zeroeval",
                  release_date: "2024-10-22",
                  canonical_model_id: "claude-haiku",
                },
                source: "sync_cache",
                overridden: false,
              },
            ],
            source: "sync_cache",
            overridden: false,
          },
        ],
      },
      overridePath: "catalog.override.yaml",
      overrideFound: false,
      syncCachePath: ".siftgate/catalog-sync-cache.yaml",
      syncCacheFound: true,
      issues: [],
    };
    const { controller } = makeDashboard({
      catalog: {
        load: jest.fn().mockReturnValue(catalogLoad),
      },
    });

    const result = controller.getCatalogProviders();
    const anthropic = result.providers.find(
      (provider: any) => provider.id === "anthropic",
    );
    expect(anthropic?.recommended_model_buckets?.models).toEqual([
      "claude-3-7-sonnet-20250219",
      "claude-3-5-haiku-20241022",
    ]);
    expect(anthropic?.recommended_model_buckets?.models).not.toContain(
      "claude-3-7-sonnet-preview",
    );
    expect(anthropic?.latest_model_hints?.models).toMatchObject({
      primary_model: "claude-3-7-sonnet-20250219",
      release_date: "2025-02-24",
      source: "recommended",
    });
  });

  it("keeps low-confidence zeroeval matches out of recommended default buckets", () => {
    const catalogLoad = {
      catalog: {
        providers: [
          {
            id: "anthropic",
            name: "Anthropic",
            base_url: "https://api.anthropic.com",
            auth_type: "x-api-key",
            endpoints: { messages: "/v1/messages" },
            models: [
              {
                id: "claude-3-7-sonnet-20250219",
                provider: "anthropic",
                modalities: ["text"],
                endpoints: { messages: "/v1/messages" },
                capabilities: ["streaming"],
                pricing: {
                  input: 3,
                  output: 15,
                  input_per_1m_tokens: 3,
                  output_per_1m_tokens: 15,
                  source: "openrouter-public-api",
                  last_updated: "2026-05-06",
                  manual_review_required: true,
                },
                enrichment: {
                  source: "zeroeval",
                  enriched_from: "zeroeval",
                  match_strategy: "strict_signature_release_date",
                  match_confidence: "high",
                  release_date: "2025-02-24",
                  canonical_model_id: "anthropic/claude-3-7-sonnet-20250219",
                },
                source: "sync_cache",
                overridden: false,
              },
              {
                id: "claude-sonnet-4-6-candidate",
                provider: "anthropic",
                modalities: ["text"],
                endpoints: { messages: "/v1/messages" },
                capabilities: ["streaming"],
                pricing: {
                  input: 3,
                  output: 15,
                  input_per_1m_tokens: 3,
                  output_per_1m_tokens: 15,
                  source: "zeroeval",
                  last_updated: "2026-05-06",
                  manual_review_required: true,
                },
                enrichment: {
                  source: "zeroeval",
                  enriched_from: "zeroeval",
                  match_strategy: "ambiguous_candidate",
                  match_confidence: "low",
                  release_date: "2026-02-17",
                  canonical_model_id: "anthropic/claude-4.6-sonnet",
                },
                source: "sync_cache",
                overridden: false,
              },
            ],
            source: "sync_cache",
            overridden: false,
          },
        ],
      },
      overridePath: "catalog.override.yaml",
      overrideFound: false,
      syncCachePath: ".siftgate/catalog-sync-cache.yaml",
      syncCacheFound: true,
      internal: {
        diagnostics: {
          zeroeval_overlay: {
            source: "zeroeval",
            source_url:
              "https://api.zeroeval.com/leaderboard/models/full?justCanonicals=false",
            synced_at: "2026-05-06T00:00:00.000Z",
            canonical_model_count: 2,
            zeroeval_model_count: 2,
            matched_model_count: 1,
            projected_model_count: 1,
            high_confidence_match_count: 1,
            medium_confidence_match_count: 0,
            low_confidence_match_count: 1,
            unmatched_model_count: 0,
            ambiguous_match_count: 1,
          },
        },
      },
      issues: [],
    };
    const { controller } = makeDashboard({
      catalog: {
        load: jest.fn().mockReturnValue(catalogLoad),
      },
    });

    const result = controller.getCatalogProviders();
    const anthropic = result.providers.find(
      (provider: any) => provider.id === "anthropic",
    );
    const models = controller.getCatalogModels("anthropic");
    const lowConfidence = models.models.find(
      (model: any) => model.id === "claude-sonnet-4-6-candidate",
    );

    expect(anthropic?.recommended_model_buckets?.models).toEqual([
      "claude-3-7-sonnet-20250219",
    ]);
    expect(anthropic?.recommended_model_buckets?.models).not.toContain(
      "claude-sonnet-4-6-candidate",
    );
    expect(anthropic?.recommended_models).toEqual(
      expect.not.arrayContaining([
        expect.objectContaining({
          model_id: "claude-sonnet-4-6-candidate",
        }),
      ]),
    );
    expect(lowConfidence).toMatchObject({
      match_confidence: "low",
      pricing_trust: "review_required",
    });
    expect(lowConfidence?.pricing_trust).not.toBe("aligned_estimate");
    expect(anthropic).toMatchObject({
      pricing_coverage: expect.objectContaining({
        aligned_estimate_models: 1,
        reference_estimate_models: 0,
        review_required_models: 1,
        missing_models: 0,
      }),
      pricing_trust_summary: expect.objectContaining({
        status: "aligned_estimate",
        estimate_ready_models: 1,
        aligned_estimate_models: 1,
        review_required_models: 1,
      }),
    });
  });
});

// ═══════════════════════════════════════════════════════════
// Log Export
// ═══════════════════════════════════════════════════════════

describe("DashboardController — exportLogs", () => {
  it("should export as JSON", async () => {
    const logs = [{ id: 1, model: "gpt-4o", timestamp: new Date() }];
    const qb = mockQueryBuilder();
    qb.getMany.mockResolvedValue(logs);
    const repo = mockRepo(qb);

    const { controller } = makeDashboard({ callLogRepo: repo, qb });
    const res: any = { setHeader: jest.fn(), send: jest.fn() };
    await controller.exportLogs(
      "json",
      "7d",
      7,
      undefined,
      undefined,
      undefined,
      res,
    );

    expect(res.setHeader).toHaveBeenCalledWith(
      "Content-Type",
      "application/json",
    );
    expect(res.send).toHaveBeenCalled();
  });

  it("should export as CSV by default", async () => {
    const qb = mockQueryBuilder();
    qb.getMany.mockResolvedValue([]);
    const repo = mockRepo(qb);

    const { controller } = makeDashboard({ callLogRepo: repo, qb });
    const res: any = { setHeader: jest.fn(), send: jest.fn() };
    await controller.exportLogs("csv", "7d", 7, undefined, undefined, undefined, res);

    expect(res.setHeader).toHaveBeenCalledWith("Content-Type", "text/csv");
    const csv = res.send.mock.calls[0][0] as string;
    expect(csv).toContain("timestamp,request_id,client_source");
  });
});

// ═══════════════════════════════════════════════════════════
// Budget
// ═══════════════════════════════════════════════════════════

describe("DashboardController — budget", () => {
  it("should return budget status", async () => {
    const { controller } = makeDashboard({
      budgetService: {
        getStatus: jest
          .fn()
          .mockResolvedValue([
            {
              id: 1,
              type: "tokens",
              scope: "global",
              apiKeyName: null,
              apiKeyId: null,
              namespaceId: null,
              teamId: null,
              current: 500,
              limit: 1000,
              percentage: 0.5,
              alertThreshold: 0.75,
              isExceeded: false,
              isAlert: false,
              periodStart: new Date(),
              resetAt: new Date(),
            },
          ]),
        resetRule: jest.fn(),
      },
    });
    const result = await controller.getBudget();
    expect(result.rules).toHaveLength(1);
    expect(result.rules[0]).toMatchObject({
      percentage: 50,
      alertThreshold: 75,
      sourceOfTruth: "global_config",
      editableVia: "config_file",
      blockingOrder: 1,
      dailyResetAt: expect.any(Date),
    });
    expect((result as any).selectedScope).toMatchObject({
      scope: "global",
      sourceOfTruth: "global_config",
      configured: true,
      inherited: false,
    });
    expect((result as any).scopeChain).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: "global",
          activeForSelected: true,
        }),
        expect.objectContaining({
          scope: "api_key",
          activeForSelected: false,
        }),
      ]),
    );
  });

  it("should reset a budget rule", async () => {
    const { controller, budgetService } = makeDashboard();
    const result = await controller.resetBudget(1);
    expect(result.success).toBe(true);
    expect(budgetService.resetRule).toHaveBeenCalledWith(1);
  });
});

// ═══════════════════════════════════════════════════════════
// Cache
// ═══════════════════════════════════════════════════════════

describe("DashboardController — cache", () => {
  it("should return cache stats", () => {
    const { controller } = makeDashboard();
    const result = controller.getCacheStats();
    expect(result).toHaveProperty("entries");
  });

  it("should clear cache", async () => {
    const { controller, cacheService } = makeDashboard();
    const result = await controller.clearCache();
    expect(result.success).toBe(true);
    expect(cacheService.clear).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════
// Config
// ═══════════════════════════════════════════════════════════

describe("DashboardController — config", () => {
  it("should return sanitized config and keep client keys dashboard-managed", () => {
    const { controller } = makeDashboard();
    const result = controller.getConfig();

    expect(result.nodes[0].api_key).toContain("...");
    expect(result.nodes[0].api_key).not.toBe("sk-test12345678rest");
    expect(result.auth.api_keys).toEqual([]);
    expect(result.auth.managed_in_dashboard).toBe(true);
    expect(result.diagnostics).toEqual([]);
    expect(result.routing_status.standard.strategy).toBe("weighted");
  });

  it("should include config diagnostics", () => {
    const diagnostics = [
      {
        severity: "warning",
        code: "duplicate_model_id",
        message: "Duplicate",
        nodes: ["a", "b"],
        model: "m",
      },
    ];
    const { controller } = makeDashboard({
      config: {
        getNodeModelDiagnostics: jest.fn().mockReturnValue(diagnostics),
      },
    });
    expect(controller.getConfig().diagnostics).toBe(diagnostics);
  });

  it("should reload config", async () => {
    const { controller, config, activeHealth, configAudit } = makeDashboard();
    const result = await controller.reloadConfig();
    expect(result.success).toBe(true);
    expect(config.reload).toHaveBeenCalledWith({
      source: "dashboard",
      throwOnError: false,
    });
    expect(configAudit.recordReload).toHaveBeenCalled();
    expect(activeHealth.refreshSchedules).toHaveBeenCalled();
  });

  it("should handle reload failure", async () => {
    const { controller } = makeDashboard({
      config: {
        reload: jest.fn().mockReturnValue({
          success: false,
          message:
            "Configuration reload failed; retained previous config: Invalid YAML",
          error: { name: "YAMLException", message: "Invalid YAML" },
          current: { version: 1 },
          previous: { version: 1 },
          changed: {},
          rolled_back: true,
        }),
      },
    });
    await expect(controller.reloadConfig()).rejects.toThrow(HttpException);
  });

  it("should expose config version and audit event APIs", async () => {
    const { controller, configAudit } = makeDashboard({
      configAudit: {
        listVersions: jest
          .fn()
          .mockResolvedValue({
            data: [{ version_id: "cfgv_1" }],
            pagination: { count: 1 },
          }),
        getVersion: jest
          .fn()
          .mockResolvedValue({
            version_id: "cfgv_1",
            sanitized_config: { nodes: [] },
          }),
        rollbackToVersion: jest.fn().mockResolvedValue({
          success: true,
          message: "Rolled back",
          target_version: { version_id: "cfgv_1" },
          previous_version: null,
          restored_version: { version_id: "cfgv_2" },
          reload: { success: true },
        }),
        listEvents: jest
          .fn()
          .mockResolvedValue({
            data: [{ event_id: "cfge_1" }],
            pagination: { count: 1 },
          }),
      },
    });

    await expect(controller.getConfigVersions(25)).resolves.toEqual({
      data: [{ version_id: "cfgv_1" }],
      pagination: { count: 1 },
    });
    await expect(controller.getConfigVersion("cfgv_1")).resolves.toEqual({
      version_id: "cfgv_1",
      sanitized_config: { nodes: [] },
    });
    await expect(
      controller.rollbackConfigVersion("cfgv_1", { reason: "test" }),
    ).resolves.toEqual(
      expect.objectContaining({ success: true, message: "Rolled back" }),
    );
    await expect(
      controller.getConfigAuditEvents(10, "config.node.create"),
    ).resolves.toEqual({
      data: [{ event_id: "cfge_1" }],
      pagination: { count: 1 },
    });
    expect(configAudit.rollbackToVersion).toHaveBeenCalledWith("cfgv_1", {
      reason: "test",
      actor: { type: "dashboard", id: "dashboard" },
      source: "dashboard",
    });
  });

  it("should return 404 for missing config versions", async () => {
    const { controller } = makeDashboard({
      configAudit: { getVersion: jest.fn().mockResolvedValue(null) },
    });
    await expect(controller.getConfigVersion("missing")).rejects.toThrow(
      HttpException,
    );
  });
});

// ═══════════════════════════════════════════════════════════
// Config Mutation Audit
// ═══════════════════════════════════════════════════════════

describe("DashboardController — config mutation audit", () => {
  const reload = {
    success: true,
    message: "Configuration restored",
    source: "dashboard",
    current: { version: 2 },
    previous: { version: 1 },
    changed: {},
    rolled_back: false,
  };

  const expectConfigAuditTrack = (
    configAudit: any,
    expected: Record<string, unknown>,
  ) => {
    expect(configAudit.trackChange).toHaveBeenCalledTimes(1);
    expect(configAudit.trackChange).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "dashboard",
        actor: { type: "dashboard", id: "dashboard" },
        ...expected,
      }),
      expect.any(Function),
    );
  };

  const namespaceConfig = () => ({
    namespaces: [
      {
        id: "team-alpha",
        name: "Team Alpha",
        allowed_nodes: ["openai"],
        allowed_models: ["gpt-4o"],
        budget: { daily_token_limit: 1000 },
        rate_limit: { requests_per_minute: 60 },
      },
      {
        id: "team-delete",
        name: "Team Delete",
        allowed_nodes: ["claude"],
      },
    ],
    auth: {
      api_keys: [
        {
          name: "config-bound",
          key: "gw_sk_dev_bound",
          namespace_id: "team-delete",
        },
      ],
    },
    createNamespace: jest.fn().mockReturnValue(reload),
    updateNamespace: jest.fn().mockReturnValue(reload),
    deleteNamespace: jest.fn().mockReturnValue(reload),
  });

  const mutationCases = [
    {
      name: "node creation",
      setup: () => {
        const dashboard = makeDashboard();
        const dto = {
          id: "audit-node",
          name: "Audit Node",
          protocol: "chat_completions",
          base_url: "https://audit.example.com",
          endpoint: "/v1/chat/completions",
          api_key: "sk-audit",
          models: ["gpt-4o-mini"],
          realtime_models: ["gpt-4o-realtime-preview"],
          compatibility_profile: "openai",
        } as any;
        return {
          ...dashboard,
          run: () => dashboard.controller.createNode(dto),
          expected: {
            action: "config.node.create",
            target: "node:audit-node",
            metadata: expect.objectContaining({
              protocol: "chat_completions",
              models: ["gpt-4o-mini"],
              realtime_models: ["gpt-4o-realtime-preview"],
              compatibility_profile: "openai",
            }),
          },
          verify: () => {
            expect(dashboard.config.addNode).toHaveBeenCalledWith(
              expect.objectContaining({
                id: "audit-node",
                realtime_models: ["gpt-4o-realtime-preview"],
                compatibility_profile: "openai",
              }),
            );
          },
        };
      },
    },
    {
      name: "node update",
      setup: () => {
        const dashboard = makeDashboard();
        return {
          ...dashboard,
          run: () =>
            dashboard.controller.updateNode("openai", {
              name: "OpenAI Audit",
              api_key: "",
              timeout_ms: 45000,
            } as any),
          expected: {
            action: "config.node.update",
            target: "node:openai",
            metadata: { fields: ["name", "timeout_ms"] },
          },
          verify: () => {
            expect(dashboard.config.updateNode).toHaveBeenCalledWith(
              "openai",
              { name: "OpenAI Audit", timeout_ms: 45000 },
            );
          },
        };
      },
    },
    {
      name: "node deletion",
      setup: () => {
        const dashboard = makeDashboard();
        return {
          ...dashboard,
          run: () => dashboard.controller.deleteNode("openai"),
          expected: {
            action: "config.node.delete",
            target: "node:openai",
          },
          verify: () => {
            expect(dashboard.circuitBreaker.reset).toHaveBeenCalledWith(
              "openai",
            );
            expect(dashboard.config.deleteNode).toHaveBeenCalledWith("openai");
          },
        };
      },
    },
    {
      name: "routing update",
      setup: () => {
        const dashboard = makeDashboard();
        const body = {
          scoring: {
            simple_max: 0.25,
            standard_max: 0.6,
            complex_max: 0.9,
          },
          domain_preferences: { code: ["openai"] },
        };
        return {
          ...dashboard,
          run: () => dashboard.controller.updateRouting(body),
          expected: {
            action: "config.routing.update",
            target: "routing",
            metadata: { fields: ["scoring", "domain_preferences"] },
          },
          verify: () => {
            expect(dashboard.config.updateRouting).toHaveBeenCalledWith(body);
          },
        };
      },
    },
    {
      name: "namespace creation",
      setup: () => {
        const config = namespaceConfig();
        const dashboard = makeDashboard({ config });
        return {
          ...dashboard,
          run: () =>
            dashboard.controller.createNamespace({
              id: "team-beta",
              name: "Team Beta",
              allowed_nodes: ["openai", "claude", "openai", ""],
              allowed_models: ["gpt-4o", ""],
              budget: { daily_token_limit: 2000 },
              rate_limit: { requests_per_minute: 120 },
            }),
          expected: {
            action: "config.namespace.create",
            target: "namespace:team-beta",
            metadata: {
              allowed_nodes_count: 2,
              allowed_models_count: 1,
              has_budget: true,
              has_rate_limit: true,
            },
          },
          verify: () => {
            expect(config.createNamespace).toHaveBeenCalledWith(
              expect.objectContaining({
                id: "team-beta",
                allowed_nodes: ["openai", "claude"],
                allowed_models: ["gpt-4o"],
              }),
            );
          },
        };
      },
    },
    {
      name: "namespace update",
      setup: () => {
        const config = namespaceConfig();
        const dashboard = makeDashboard({ config });
        return {
          ...dashboard,
          run: () =>
            dashboard.controller.updateNamespace("team-alpha", {
              name: "Team Alpha Audit",
              allowed_nodes: ["claude"],
              budget: null,
              rate_limit: { requests_per_minute: 30 },
            }),
          expected: {
            action: "config.namespace.update",
            target: "namespace:team-alpha",
            metadata: expect.objectContaining({
              fields: ["name", "allowed_nodes", "budget", "rate_limit"],
              before: expect.objectContaining({
                id: "team-alpha",
                budget: { daily_token_limit: 1000 },
                rate_limit: { requests_per_minute: 60 },
              }),
            }),
          },
          verify: () => {
            expect(config.updateNamespace).toHaveBeenCalledWith("team-alpha", {
              name: "Team Alpha Audit",
              allowed_nodes: ["claude"],
              budget: undefined,
              rate_limit: { requests_per_minute: 30 },
            });
          },
        };
      },
    },
    {
      name: "namespace deletion",
      setup: () => {
        const config = namespaceConfig();
        const dashboard = makeDashboard({ config });
        return {
          ...dashboard,
          run: () =>
            dashboard.controller.deleteNamespace("team-delete", {
              confirm_impact: true,
            }),
          expected: {
            action: "config.namespace.delete",
            target: "namespace:team-delete",
            metadata: expect.objectContaining({
              confirm_impact: true,
              impact: expect.objectContaining({
                counts: { api_keys: 1, teams: 0, total: 1 },
              }),
            }),
          },
          verify: () => {
            expect(config.deleteNamespace).toHaveBeenCalledWith("team-delete");
          },
        };
      },
    },
  ];

  it.each(mutationCases)(
    "tracks $name through configAudit.trackChange",
    async ({ setup }) => {
      const { configAudit, expected, run, verify } = setup();

      await expect(run()).resolves.toEqual(
        expect.objectContaining({ success: true }),
      );

      expectConfigAuditTrack(configAudit, expected);
      verify();
    },
  );

  it("keeps dashboard precondition failures outside configAudit.trackChange", async () => {
    const config = namespaceConfig();
    const { controller, configAudit } = makeDashboard({ config });

    await expect(
      controller.updateNamespace("missing", { name: "Missing" }),
    ).rejects.toThrow(HttpException);
    await expect(controller.deleteNamespace("missing", {})).rejects.toThrow(
      HttpException,
    );
    await expect(controller.deleteNamespace("team-delete", {})).rejects.toThrow(
      HttpException,
    );

    expect(configAudit.trackChange).not.toHaveBeenCalled();
    expect(config.updateNamespace).not.toHaveBeenCalled();
    expect(config.deleteNamespace).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "duplicate node creation",
      setup: () => {
        const dashboard = makeDashboard({
          config: {
            addNode: jest.fn().mockImplementation(() => {
              throw new Error("Node already exists");
            }),
          },
        });
        return {
          ...dashboard,
          run: () =>
            dashboard.controller.createNode({
              id: "openai",
              name: "Duplicate",
              protocol: "chat_completions",
              base_url: "https://api.example.com",
              endpoint: "/v1/chat/completions",
              api_key: "sk-dup",
              models: ["gpt-4o-mini"],
            } as any),
          expected: {
            action: "config.node.create",
            target: "node:openai",
          },
        };
      },
    },
    {
      name: "invalid routing update",
      setup: () => {
        const dashboard = makeDashboard({
          config: {
            updateRouting: jest.fn().mockImplementation(() => {
              throw new Error("Invalid node reference");
            }),
          },
        });
        return {
          ...dashboard,
          run: () => dashboard.controller.updateRouting({ tiers: {} as any }),
          expected: {
            action: "config.routing.update",
            target: "routing",
            metadata: { fields: ["tiers"] },
          },
        };
      },
    },
  ])(
    "wraps $name in configAudit.trackChange before surfacing failure",
    async ({ setup }) => {
      const { configAudit, expected, run } = setup();

      await expect(run()).rejects.toThrow(HttpException);

      expectConfigAuditTrack(configAudit, expected);
    },
  );
});

// ═══════════════════════════════════════════════════════════
// Nodes
// ═══════════════════════════════════════════════════════════

describe("DashboardController — nodes", () => {
  it("should return node list with circuit and capability info", async () => {
    const { controller } = makeDashboard();
    const result = await controller.getNodes();

    expect(result.nodes).toHaveLength(2);
    expect(result.nodes[0].id).toBe("openai");
    expect(result.nodes[0].healthy).toBe(true);
    expect(result.nodes[0]).toEqual(
      expect.objectContaining({
        timeout_ms: 60000,
        max_concurrency: 3,
        queue_timeout_ms: 250,
        queue_policy: "fallback",
      }),
    );
    expect(result.nodes[0].capabilities).toBeDefined();
    expect(result.nodes[0].modalities).toBeDefined();
    expect(result.nodes[0].embedding_models).toEqual([
      "text-embedding-3-small",
    ]);
    expect(result.nodes[0].endpoints).toEqual(
      expect.objectContaining({
        default: "/v1/chat/completions",
        embeddings: "/v1/embeddings",
        image: "/v1/images/generations",
      }),
    );
    expect(result.nodes[0].model_capabilities["gpt-4o"]).toEqual(
      expect.objectContaining({
        modalities: ["text", "image"],
        supports_streaming: true,
      }),
    );
    expect(
      result.nodes[0].model_capabilities["text-embedding-3-small"],
    ).toEqual(
      expect.objectContaining({
        modalities: ["text", "embedding"],
        dimensions: [512, 1536],
      }),
    );
    expect(result.nodes[0].concurrency).toEqual(
      expect.objectContaining({ active: 0, queued: 0 }),
    );
    expect(result.nodes[0].active_probe.status).toBe("disabled");
    expect(result.nodes[0].compatibility_matrix).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });

  it("should include active probe state in node list", async () => {
    const { controller } = makeDashboard({
      activeHealth: {
        getNodeStatus: jest.fn().mockReturnValue({
          enabled: true,
          status: "unhealthy",
          method: "GET",
          target: "GET /ready",
          last_checked_at: "2026-05-02T00:00:00.000Z",
          last_success_at: null,
          latency_ms: 42,
          failure_reason: "HTTP 503",
          consecutive_failures: 2,
        }),
      },
    });
    const result = await controller.getNodes();

    expect(result.nodes[0].healthy).toBe(false);
    expect(result.nodes[0].active_probe.failure_reason).toBe("HTTP 503");
    expect(result.nodes[0].active_probe.last_checked_at).toBe(
      "2026-05-02T00:00:00.000Z",
    );
  });

  it("should show unhealthy when circuit is OPEN", async () => {
    const { controller } = makeDashboard({
      circuitBreaker: {
        getNodeStatus: jest
          .fn()
          .mockReturnValue({
            state: CircuitState.OPEN,
            consecutiveFailures: 3,
            lastFailureAt: Date.now(),
          }),
        getModelStatuses: jest.fn().mockReturnValue({}),
        reset: jest.fn(),
      },
    });
    const result = await controller.getNodes();
    expect(result.nodes[0].healthy).toBe(false);
  });

  it("should reset circuit breaker for a node", async () => {
    const { controller, circuitBreaker } = makeDashboard();
    const result = await controller.resetNodeCircuit("openai");
    expect(result.success).toBe(true);
    expect(circuitBreaker.reset).toHaveBeenCalledWith("openai");
  });

  it("should reset circuit breaker for a specific model", async () => {
    const { controller, circuitBreaker } = makeDashboard();
    const result = await controller.resetNodeCircuit("openai", "gpt-4o");
    expect(result.success).toBe(true);
    expect(circuitBreaker.reset).toHaveBeenCalledWith("openai", "gpt-4o");
  });

  it("should refresh active health schedules after node mutations", async () => {
    const { controller, activeHealth } = makeDashboard();

    await controller.createNode({
      id: "new-node",
      name: "New Node",
      protocol: "chat_completions",
      base_url: "https://api.example.com",
      endpoint: "/v1/chat/completions",
      api_key: "sk-test",
      models: ["gpt-4o-mini"],
      timeout_ms: 1000,
      health_check: { enabled: true, method: "HEAD", path: "/healthz" },
    });
    await controller.updateNode("openai", { health_check: { enabled: false } });
    await controller.deleteNode("openai");

    expect(activeHealth.refreshSchedules).toHaveBeenCalledTimes(3);
  });
});

// ═══════════════════════════════════════════════════════════
// Node CRUD
// ═══════════════════════════════════════════════════════════

describe("DashboardController — Node CRUD", () => {
  it("should create a node", async () => {
    const { controller, config, configAudit } = makeDashboard();
    const dto = {
      id: "new-node",
      name: "New",
      protocol: "chat_completions",
      base_url: "https://example.com",
      endpoint: "/v1/chat/completions",
      api_key: "sk-new",
      models: ["model-1"],
      video_generations_endpoint: "/v1/videos/generations",
      video_status_endpoint: "/v1/videos/{id}",
      video_models: ["video-1"],
      model_capabilities: {
        "video-1": { pricing: { input: 0.1, output: 0.2 } },
      },
      max_concurrency: 3,
      queue_timeout_ms: 250,
      queue_policy: "fallback",
    } as any;
    const result = await controller.createNode(dto);

    expect(result.success).toBe(true);
    expect(configAudit.trackChange).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "config.node.create",
        target: "node:new-node",
      }),
      expect.any(Function),
    );
    expect(config.addNode).toHaveBeenCalledWith(
      expect.objectContaining({
        max_concurrency: 3,
        queue_timeout_ms: 250,
        queue_policy: "fallback",
        video_generations_endpoint: "/v1/videos/generations",
        video_status_endpoint: "/v1/videos/{id}",
        video_models: ["video-1"],
        model_capabilities: {
          "video-1": { pricing: { input: 0.1, output: 0.2 } },
        },
      }),
    );
  });

  it("should throw on duplicate node creation", async () => {
    const { controller } = makeDashboard({
      config: {
        addNode: jest.fn().mockImplementation(() => {
          throw new Error("Node already exists");
        }),
      },
    });
    const dto = { id: "openai", name: "Dup" } as any;
    await expect(controller.createNode(dto)).rejects.toThrow(HttpException);
  });

  it("should update a node", async () => {
    const { controller, config } = makeDashboard();
    const result = await controller.updateNode("openai", {
      name: "Updated OpenAI",
    } as any);
    expect(result.success).toBe(true);
    expect(config.updateNode).toHaveBeenCalled();
  });

  it("should not pass empty api_key on update", async () => {
    const { controller, config } = makeDashboard();
    await controller.updateNode("openai", {
      name: "Updated",
      api_key: "",
    } as any);
    const updateArgs = config.updateNode.mock.calls[0][1];
    expect(updateArgs.api_key).toBeUndefined();
  });

  it.each([undefined, "", "   "])("preserves an existing pool secret when the edit sends %p", async (apiKey) => {
    const existing = {
      id: "openai",
      credentials: [{ id: "primary", api_key: "${env:EXISTING_KEY}", weight: 1 }],
    };
    const { controller, config } = makeDashboard({
      config: { getNode: jest.fn().mockReturnValue(existing) },
    });

    await controller.updateNode("openai", {
      models: ["claude-kr-claude-sonnet-5[1M]"],
      credentials: [{ id: "primary", api_key: apiKey, weight: 2, enabled: true }],
    });

    expect(config.updateNode).toHaveBeenCalledWith("openai", {
      models: ["claude-kr-claude-sonnet-5[1M]"],
      credentials: [{ id: "primary", api_key: "${env:EXISTING_KEY}", weight: 2, enabled: true }],
    });
    expect(existing.credentials[0].weight).toBe(1);
  });

  it("accepts explicit replacement secrets and new credentials", async () => {
    const { controller, config } = makeDashboard({
      config: { getNode: jest.fn().mockReturnValue({
        credentials: [{ id: "primary", api_key: "original-key" }],
      }) },
    });

    await controller.updateNode("openai", {
      credentials: [
        { id: "primary", api_key: "replacement-key" },
        { id: "secondary", api_key: "second-key" },
      ],
    });

    expect(config.updateNode.mock.calls[0][1].credentials).toEqual([
      { id: "primary", api_key: "replacement-key" },
      { id: "secondary", api_key: "second-key" },
    ]);
  });

  it.each([undefined, "", "   "])("rejects a new pool credential without a usable secret (%p) before mutation", async (apiKey) => {
    const { controller, config, configAudit } = makeDashboard({
      config: { getNode: jest.fn().mockReturnValue({
        api_key: "node-level-key-must-not-be-inherited",
        credentials: [{ id: "primary", api_key: "original-key" }],
      }) },
    });

    await expect(controller.updateNode("openai", {
      credentials: [
        { id: "primary", api_key: "" },
        { id: "unknown", api_key: apiKey },
      ],
    })).rejects.toMatchObject({ status: 400 });
    expect(config.updateNode).not.toHaveBeenCalled();
    expect(configAudit.trackChange).not.toHaveBeenCalled();
  });

  it("does not borrow a matching credential ID from a different node", async () => {
    const { controller, config } = makeDashboard({
      config: { getNode: jest.fn().mockImplementation((id: string) => ({
        id,
        credentials: id === "other" ? [{ id: "primary", api_key: "other-node-secret" }] : [],
      })) },
    });

    await expect(controller.updateNode("openai", {
      credentials: [{ id: "primary", api_key: "" }],
    })).rejects.toMatchObject({ status: 400 });
    expect(config.getNode).toHaveBeenCalledWith("openai");
    expect(config.updateNode).not.toHaveBeenCalled();
  });

  it("preserves not-found status for credential edits on an unknown node", async () => {
    const { controller, config } = makeDashboard({
      config: { getNode: jest.fn().mockReturnValue(undefined) },
    });

    await expect(controller.updateNode("missing", {
      credentials: [{ id: "primary", api_key: "" }],
    })).rejects.toMatchObject({ status: 404 });
    expect(config.updateNode).not.toHaveBeenCalled();
  });

  it("should delete a node", async () => {
    const { controller, config, circuitBreaker } = makeDashboard();
    const result = await controller.deleteNode("openai");
    expect(result.success).toBe(true);
    expect(circuitBreaker.reset).toHaveBeenCalledWith("openai");
    expect(config.deleteNode).toHaveBeenCalledWith("openai");
  });

  it("should throw on deleting last node", async () => {
    const { controller } = makeDashboard({
      config: {
        deleteNode: jest.fn().mockImplementation(() => {
          throw new Error("Cannot delete the last remaining node");
        }),
      },
    });
    await expect(controller.deleteNode("openai")).rejects.toThrow(
      HttpException,
    );
  });
});

// ═══════════════════════════════════════════════════════════
// Capabilities & Routing
// ═══════════════════════════════════════════════════════════

describe("DashboardController — capabilities & routing", () => {
  it("should return provider catalog entries", () => {
    const { controller } = makeDashboard();
    const result = controller.getCatalogProviders();
    expect(result.source).toBe("builtin_static");
    expect(result.auto_update).toBe(false);
    expect(result.providers.map((provider) => provider.id)).toEqual(
      expect.arrayContaining(["openai", "anthropic", "openai-compatible"]),
    );
  });

  it("should return filtered catalog models", () => {
    const { controller } = makeDashboard();
    const result = controller.getCatalogModels("openai", "embedding");
    expect(result.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider_id: "openai",
          modalities: expect.arrayContaining(["embedding"]),
        }),
      ]),
    );
  });

  it("should return capabilities registry", () => {
    const { controller } = makeDashboard();
    const result = controller.getCapabilities();
    expect(result).toHaveProperty("capabilities");
  });

  it("should recommend tiers", () => {
    const { controller, capabilityService } = makeDashboard();
    controller.recommendTiers({
      capabilities: ["reasoning", "code"],
    });
    expect(capabilityService.recommendTiers).toHaveBeenCalledWith([
      "reasoning",
      "code",
    ]);
  });

  it("should recommend routing", () => {
    const { controller } = makeDashboard();
    const result = controller.recommendRouting();
    expect(result).toHaveProperty("recommendations");
  });

  it("should return read-only adaptive routing recommendations", async () => {
    const { controller, routingRecommendations } = makeDashboard();
    const result = await controller.getAdaptiveRoutingRecommendations(12, 500);
    expect(result.mode).toBe("recommendation_only");
    expect(routingRecommendations.getRecommendations).toHaveBeenCalledWith({
      windowHours: 12,
      sampleLimit: 500,
    });
  });

  it("should update routing config", async () => {
    const { controller, config } = makeDashboard();
    const result = await controller.updateRouting({
      scoring: { simple_max: 0.3, standard_max: 0.6, complex_max: 0.85 },
    });
    expect(result.success).toBe(true);
    expect(config.updateRouting).toHaveBeenCalled();
  });

  it("should throw on invalid routing update", async () => {
    const { controller } = makeDashboard({
      config: {
        updateRouting: jest.fn().mockImplementation(() => {
          throw new Error("Invalid node reference");
        }),
      },
    });
    await expect(
      controller.updateRouting({ tiers: {} as any }),
    ).rejects.toThrow(HttpException);
  });
});

// ═══════════════════════════════════════════════════════════
// Per-Key Budget + API Key Filtering
// ═══════════════════════════════════════════════════════════

describe("DashboardController — per-key budget", () => {
  it("should return global + perKey rules when api_key query provided", async () => {
    const { controller } = makeDashboard({
      budgetService: {
        getStatus: jest.fn().mockImplementation((keyName?: string) => {
          if (keyName === "intern") {
            return Promise.resolve([
              {
                id: 2,
                type: "daily_cost",
                scope: "api_key",
                apiKeyName: "intern",
                apiKeyId: null,
                current: 3,
                limit: 5,
                percentage: 0.6,
                isExceeded: false,
                isAlert: false,
                periodStart: new Date(),
                resetAt: new Date(),
              },
            ]);
          }
          return Promise.resolve([
            {
              id: 1,
              type: "daily_cost",
              scope: "global",
              apiKeyName: null,
              apiKeyId: null,
              current: 10,
              limit: 100,
              percentage: 0.1,
              isExceeded: false,
              isAlert: false,
              periodStart: new Date(),
              resetAt: new Date(),
            },
          ]);
        }),
        resetRule: jest.fn(),
        getKeysWithBudgets: jest.fn().mockResolvedValue(["intern", "sean"]),
      },
    });

    const result = await controller.getBudget("intern");
    expect(result.rules).toHaveLength(1);
    expect((result as any).perKeyRules).toHaveLength(1);
    expect((result as any).apiKeyName).toBe("intern");
    expect((result as any).perKeyRules[0].limit).toBe(5);
  });

  it("should query per-key budget by api_key_id when provided", async () => {
    const getStatus = jest
      .fn()
      .mockImplementation((_keyName?: string | null, keyId?: string | null) => {
        if (keyId === "key_123") {
          return Promise.resolve([
            {
              id: 7,
              type: "daily_tokens",
              scope: "api_key",
              apiKeyName: "production",
              apiKeyId: "key_123",
              current: 2500,
              limit: 10000,
              percentage: 0.25,
              isExceeded: false,
              isAlert: false,
              periodStart: new Date(),
              resetAt: new Date(),
            },
          ]);
        }
        return Promise.resolve([
          {
            id: 1,
            type: "daily_tokens",
            scope: "global",
            apiKeyName: null,
            apiKeyId: null,
            current: 5000,
            limit: 100000,
            percentage: 0.05,
            isExceeded: false,
            isAlert: false,
            periodStart: new Date(),
            resetAt: new Date(),
          },
        ]);
      });
    const { controller } = makeDashboard({
      budgetService: {
        getStatus,
        resetRule: jest.fn(),
        getKeysWithBudgets: jest.fn().mockResolvedValue([]),
      },
    });

    const result = await controller.getBudget(undefined, "key_123");
    expect(getStatus).toHaveBeenCalledWith(null, "key_123");
    expect((result as any).apiKeyName).toBe("production");
    expect((result as any).apiKeyId).toBe("key_123");
    expect((result as any).perKeyRules[0]).toMatchObject({
      id: 7,
      apiKeyId: "key_123",
      percentage: 25,
    });
  });

  it("should return only global rules when no api_key query", async () => {
    const { controller } = makeDashboard({
      budgetService: {
        getStatus: jest
          .fn()
          .mockResolvedValue([
            {
              type: "daily_tokens",
              current: 50000,
              limit: 100000,
              percentage: 0.5,
              isExceeded: false,
              isAlert: false,
              periodStart: new Date(),
            },
          ]),
        resetRule: jest.fn(),
        getKeysWithBudgets: jest.fn().mockResolvedValue([]),
      },
    });

    const result = await controller.getBudget();
    expect(result.rules).toHaveLength(1);
    expect((result as any).perKeyRules).toBeUndefined();
  });

  it("should return budget keys via GET /budget/keys", async () => {
    const { controller } = makeDashboard({
      budgetService: {
        getStatus: jest.fn().mockResolvedValue([]),
        resetRule: jest.fn(),
        getKeysWithBudgets: jest.fn().mockResolvedValue(["intern", "sean"]),
      },
      gatewayApiKeys: {
        list: jest.fn().mockResolvedValue([
          {
            id: "key_123",
            name: "production",
            key_prefix: "gw_sk_live_abcd...1234",
            daily_token_limit: 10000,
            daily_cost_limit: 5,
            rate_limit_per_minute: 60,
          },
        ]),
      },
    });

    const result = await controller.getBudgetKeys();
    expect(result.keys).toEqual(["intern", "sean", "production"]);
    expect(result.items[0]).toMatchObject({
      id: "key_123",
      name: "production",
      daily_token_limit: 10000,
    });
  });

  it("should return namespace budget source metadata and inherited state", async () => {
    const getStatus = jest
      .fn()
      .mockImplementation(
        (
          _keyName?: string | null,
          _keyId?: string | null,
          namespaceId?: string | null,
        ) => {
          if (namespaceId === "team-alpha") {
            return Promise.resolve([
              {
                id: 9,
                type: "daily_cost",
                scope: "namespace",
                apiKeyName: null,
                apiKeyId: null,
                namespaceId: "team-alpha",
                teamId: null,
                current: 1,
                limit: 2,
                percentage: 0.5,
                alertThreshold: 0.7,
                isExceeded: false,
                isAlert: false,
                periodStart: new Date(),
                resetAt: new Date(),
              },
            ]);
          }
          return Promise.resolve([]);
        },
      );
    const { controller } = makeDashboard({
      budgetService: {
        getStatus,
        resetRule: jest.fn(),
        getKeysWithBudgets: jest.fn().mockResolvedValue([]),
      },
    });

    const result = await controller.getBudget(undefined, undefined, "team-alpha");
    expect(getStatus).toHaveBeenCalledWith(null, null, "team-alpha");
    expect((result as any).namespaceRules[0]).toMatchObject({
      sourceOfTruth: "policy_namespace_config",
      editableVia: "policy_namespace_api",
      alertThreshold: 70,
      blockingOrder: 2,
    });
    expect((result as any).selectedScope).toMatchObject({
      scope: "namespace",
      configured: true,
      inherited: false,
    });
  });

  it("should mark team budget response as inherited when no team rule is configured", async () => {
    const getStatus = jest.fn().mockResolvedValue([]);
    const { controller } = makeDashboard({
      budgetService: {
        getStatus,
        resetRule: jest.fn(),
        getKeysWithBudgets: jest.fn().mockResolvedValue([]),
      },
    });

    const result = await controller.getBudget(undefined, undefined, undefined, "team_123");
    expect(getStatus).toHaveBeenCalledWith(null, null, null, "team_123");
    expect((result as any).teamRules).toEqual([]);
    expect((result as any).selectedScope).toMatchObject({
      scope: "team",
      configured: false,
      inherited: true,
      editableVia: "team_api",
    });
    expect((result as any).scopeChain).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scope: "global", activeForSelected: true }),
        expect.objectContaining({ scope: "namespace", activeForSelected: true }),
        expect.objectContaining({ scope: "team", activeForSelected: true }),
        expect.objectContaining({ scope: "api_key", activeForSelected: false }),
      ]),
    );
  });
});

describe("DashboardController — api-keys", () => {
  const keySummary = {
    id: "key_123",
    name: "production",
    status: "active",
    key_prefix: "gw_sk_live_abcd...1234",
    namespace_id: "team-alpha",
    allow_auto: true,
    allow_direct: true,
    allowed_nodes: ["openai"],
    allowed_models: ["gpt-4o"],
    allowed_endpoints: ["chat_completions", "responses"],
    allowed_modalities: ["text"],
    daily_token_limit: 10000,
    daily_cost_limit: 5,
    rate_limit_per_minute: 60,
  };

  it("should return managed gateway api keys", async () => {
    const { controller } = makeDashboard({
      gatewayApiKeys: {
        list: jest.fn().mockResolvedValue([
          { id: "1", name: "sean" },
          { id: "2", name: "intern" },
        ]),
      },
    });
    const result = await controller.getApiKeyNames();
    expect(result.keys).toEqual(["sean", "intern"]);
    expect(result.items).toHaveLength(2);
  });

  it("should create API keys with endpoint and modality permissions and audit redacted metadata", async () => {
    const gatewayApiKeys = {
      create: jest.fn().mockResolvedValue({
        key: "gw_sk_live_full_secret_value",
        item: keySummary,
      }),
    };
    const { controller, configAudit } = makeDashboard({ gatewayApiKeys });

    const result = await controller.createApiKey({
      name: "production",
      allow_auto: true,
      allow_direct: true,
      allowed_nodes: ["openai"],
      allowed_models: ["gpt-4o"],
      allowed_endpoints: ["chat_completions", "responses"],
      allowed_modalities: ["text"],
      namespace_id: "team-alpha",
    });

    expect(result.key).toBe("gw_sk_live_full_secret_value");
    expect(gatewayApiKeys.create).toHaveBeenCalledWith(
      expect.objectContaining({
        allowed_endpoints: ["chat_completions", "responses"],
        allowed_modalities: ["text"],
        namespace_id: "team-alpha",
      }),
    );
    expect(configAudit.recordManagementEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "api_key.create",
        afterSummary: expect.objectContaining({
          key_prefix: "gw_sk_live_abcd...1234",
          allowed_endpoints: ["chat_completions", "responses"],
          allowed_modalities: ["text"],
          secret: "redacted",
        }),
      }),
      ADMIN_TEST_MANAGER,
    );
    const auditPayload = JSON.stringify(
      configAudit.recordManagementEvent.mock.calls[0][0],
    );
    expect(auditPayload).not.toContain("gw_sk_live_full_secret_value");
  });

  it("should audit API key policy updates with before and after summaries", async () => {
    const before = { ...keySummary, allowed_endpoints: ["chat_completions"] };
    const after = {
      ...keySummary,
      allowed_endpoints: ["embeddings"],
      allowed_modalities: ["embedding"],
    };
    const gatewayApiKeys = {
      getSummary: jest.fn().mockResolvedValue(before),
      update: jest.fn().mockResolvedValue(after),
    };
    const { controller, configAudit } = makeDashboard({ gatewayApiKeys });

    const result = await controller.updateApiKey("key_123", {
      allowed_endpoints: ["embeddings"],
      allowed_modalities: ["embedding"],
      daily_cost_limit: 10,
    });

    expect(result.item).toBe(after);
    expect(gatewayApiKeys.getSummary).toHaveBeenCalledWith("key_123");
    expect(configAudit.recordManagementEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "api_key.update",
        target: "api_key:key_123",
        beforeSummary: expect.objectContaining({
          allowed_endpoints: ["chat_completions"],
          secret: "redacted",
        }),
        afterSummary: expect.objectContaining({
          allowed_endpoints: ["embeddings"],
          allowed_modalities: ["embedding"],
          secret: "redacted",
        }),
        metadata: {
          fields: [
            "allowed_endpoints",
            "allowed_modalities",
            "daily_cost_limit",
          ],
        },
      }),
      ADMIN_TEST_MANAGER,
    );
  });

  it("should audit API key rotation and deletion without storing the one-time secret", async () => {
    const gatewayApiKeys = {
      getSummary: jest.fn().mockResolvedValue(keySummary),
      rotate: jest.fn().mockResolvedValue({
        key: "gw_sk_live_rotated_secret_value",
        item: { ...keySummary, key_prefix: "gw_sk_live_efgh...5678" },
      }),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    const { controller, configAudit } = makeDashboard({ gatewayApiKeys });

    await controller.rotateApiKey("key_123");
    await controller.deleteApiKey("key_123");

    expect(configAudit.recordManagementEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "api_key.rotate",
        beforeSummary: expect.objectContaining({ secret: "redacted" }),
        afterSummary: expect.objectContaining({
          key_prefix: "gw_sk_live_efgh...5678",
          secret: "redacted",
        }),
      }),
      ADMIN_TEST_MANAGER,
    );
    expect(configAudit.recordManagementEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "api_key.delete",
        beforeSummary: expect.objectContaining({
          key_prefix: "gw_sk_live_abcd...1234",
          secret: "redacted",
        }),
      }),
      ADMIN_TEST_MANAGER,
    );
    const auditPayload = JSON.stringify(
      configAudit.recordManagementEvent.mock.calls,
    );
    expect(auditPayload).not.toContain("gw_sk_live_rotated_secret_value");
  });
});

describe("DashboardController — local teams", () => {
  const teamSummary = {
    id: "team_123",
    name: "platform",
    description: "Shared backend limits",
    status: "active",
    namespace_id: "team-alpha",
    namespace_name: "Team Alpha",
    allowed_nodes: ["openai"],
    allowed_models: ["gpt-4o"],
    allowed_endpoints: ["chat_completions", "responses"],
    allowed_modalities: ["text"],
    daily_token_limit: 100000,
    daily_cost_limit: 25,
    rate_limit_per_minute: 120,
    today: {
      calls: 0,
      errors: 0,
      error_rate: 0,
      cost_usd: 0,
      input_tokens: 0,
      output_tokens: 0,
    },
  };

  it("should list local teams with OSS-only enterprise markers", async () => {
    const { controller } = makeDashboard({
      teams: {
        list: jest.fn().mockResolvedValue([teamSummary]),
      },
    });

    const result = await controller.getTeams();

    expect(result.mode).toBe("local_only");
    expect(result.enterprise_features.sso).toBe(false);
    expect(result.teams[0]).toMatchObject({ id: "team_123", name: "platform" });
  });

  it("should audit team create/update/delete without secret material", async () => {
    const teams = {
      list: jest.fn().mockResolvedValue([]),
      getSummary: jest.fn().mockResolvedValue(teamSummary),
      create: jest.fn().mockResolvedValue(teamSummary),
      update: jest
        .fn()
        .mockResolvedValue({ ...teamSummary, status: "disabled" }),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    const { controller, configAudit } = makeDashboard({ teams });

    await controller.createTeam({
      name: "platform",
      namespace_id: "team-alpha",
      allowed_endpoints: ["responses"],
      allowed_modalities: ["text"],
    });
    await controller.updateTeam("team_123", { status: "disabled" });
    await controller.deleteTeam("team_123");

    expect(configAudit.recordManagementEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "team.create",
        afterSummary: expect.objectContaining({
          id: "team_123",
          secret: "not_applicable",
          enterprise: expect.objectContaining({ sso: false, scim: false }),
        }),
      }),
      ADMIN_TEST_MANAGER,
    );
    expect(configAudit.recordManagementEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "team.update",
        beforeSummary: expect.objectContaining({ status: "active" }),
        afterSummary: expect.objectContaining({ status: "disabled" }),
      }),
      ADMIN_TEST_MANAGER,
    );
    expect(configAudit.recordManagementEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "team.delete",
        beforeSummary: expect.objectContaining({ secret: "not_applicable" }),
      }),
      ADMIN_TEST_MANAGER,
    );
    expect(
      JSON.stringify(configAudit.recordManagementEvent.mock.calls),
    ).not.toContain("gw_sk_live");
  });
});

describe("DashboardController — api_key filtering on logs", () => {
  it("should apply api_key filter on getLogs", async () => {
    const qb = mockQueryBuilder();
    qb.getManyAndCount.mockResolvedValue([[], 0]);
    const repo = mockRepo(qb);

    const { controller } = makeDashboard({ callLogRepo: repo, qb });
    await controller.getLogs(1, 50, undefined, undefined, undefined, "sean");

    // Should have been called with api_key filter
    expect(qb.andWhere).toHaveBeenCalledWith("log.api_key_name = :apiKey", {
      apiKey: "sean",
    });
  });

  it("should prefer api_key_id filter on getLogs", async () => {
    const qb = mockQueryBuilder();
    qb.getManyAndCount.mockResolvedValue([[], 0]);
    const repo = mockRepo(qb);

    const { controller } = makeDashboard({ callLogRepo: repo, qb });
    await controller.getLogs(
      1,
      50,
      undefined,
      undefined,
      undefined,
      "renamed-key",
      "key_123",
    );

    expect(qb.andWhere).toHaveBeenCalledWith("log.api_key_id = :apiKeyId", {
      apiKeyId: "key_123",
    });
    expect(qb.andWhere).not.toHaveBeenCalledWith("log.api_key_name = :apiKey", {
      apiKey: "renamed-key",
    });
  });

  it("should apply namespace filter on getLogs", async () => {
    const qb = mockQueryBuilder();
    qb.getManyAndCount.mockResolvedValue([[], 0]);
    const repo = mockRepo(qb);

    const { controller } = makeDashboard({ callLogRepo: repo, qb });
    await controller.getLogs(
      1,
      50,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "team-alpha",
    );

    expect(qb.andWhere).toHaveBeenCalledWith(
      "log.namespace_id = :namespaceId",
      { namespaceId: "team-alpha" },
    );
  });
});

describe("DashboardController — namespaces and shadow traffic", () => {
  it("keeps Policy Namespace mutations admin-only", () => {
    expect(
      Reflect.getMetadata(
        DASHBOARD_REQUIRED_ROLE_KEY,
        controllerMethod("createNamespace"),
      ),
    ).toBe("admin");
    expect(
      Reflect.getMetadata(
        DASHBOARD_REQUIRED_ROLE_KEY,
        controllerMethod("updateNamespace"),
      ),
    ).toBe("admin");
    expect(
      Reflect.getMetadata(
        DASHBOARD_REQUIRED_ROLE_KEY,
        controllerMethod("deleteNamespace"),
      ),
    ).toBe("admin");
  });

  it("should return local namespaces with budget status and binding impact", async () => {
    const { controller, budgetService, gatewayApiKeys, teams } = makeDashboard({
      config: {
        namespaces: [
          { id: "team-alpha", name: "Team Alpha", allowed_nodes: ["openai"] },
        ],
        auth: {
          api_keys: [
            {
              name: "config-key",
              key: "gw_sk_dev_config",
              namespace_id: "team-alpha",
            },
          ],
        },
      },
      gatewayApiKeys: {
        list: jest.fn().mockResolvedValue([
          {
            id: "key-1",
            name: "Dashboard Key",
            status: "active",
            key_prefix: "gw_sk_live_1234",
            namespace_id: "team-alpha",
            team_id: null,
          },
          {
            id: "key-2",
            name: "Team Key",
            status: "active",
            key_prefix: "gw_sk_live_5678",
            namespace_id: null,
            team_id: "team-1",
          },
        ]),
      },
      teams: {
        list: jest.fn().mockResolvedValue([
          {
            id: "team-1",
            name: "Platform",
            status: "active",
            namespace_id: "team-alpha",
          },
        ]),
      },
      budgetService: {
        getStatus: jest.fn().mockResolvedValue([]),
      },
    });

    const result = await controller.getNamespaces();

    expect(result.mode).toBe("local_only");
    expect(result.namespaces[0]).toEqual(
      expect.objectContaining({
        id: "team-alpha",
        allowed_nodes: ["openai"],
        bindings: expect.objectContaining({
          counts: { api_keys: 3, teams: 1, total: 4 },
          api_keys: expect.arrayContaining([
            expect.objectContaining({
              id: "key-1",
              source: "dashboard",
            }),
            expect.objectContaining({
              id: "key-2",
              source: "dashboard",
            }),
            expect.objectContaining({
              id: "config-key",
              source: "config",
            }),
          ]),
          teams: [
            {
              id: "team-1",
              name: "Platform",
              status: "active",
            },
          ],
        }),
      }),
    );
    expect(result.counts).toEqual({
      total: 1,
      with_budget: 0,
      with_rate_limit: 0,
      bound_api_keys: 3,
      bound_teams: 1,
    });
    expect(budgetService.getStatus).toHaveBeenCalledWith(
      null,
      null,
      "team-alpha",
    );
    expect(gatewayApiKeys.list).toHaveBeenCalled();
    expect(teams.list).toHaveBeenCalled();
  });

  it("should create and update config-backed policy namespaces through audit tracking", async () => {
    const reload = {
      success: true,
      message: "Configuration restored",
      source: "dashboard",
      current: { version: 2 },
      previous: { version: 1 },
      changed: { namespaces_changed: true },
      rolled_back: false,
    };
    const config: any = {
      namespaces: [] as any[],
      createNamespace: jest.fn().mockImplementation((namespace: any) => {
        config.namespaces = [namespace];
        return reload;
      }),
      updateNamespace: jest.fn().mockImplementation((id: string, updates: any) => {
        config.namespaces = config.namespaces.map((namespace: any) =>
          namespace.id === id ? { ...namespace, ...updates } : namespace,
        );
        return reload;
      }),
      getNamespace: jest.fn((id?: string | null) =>
        id ? config.namespaces.find((namespace: any) => namespace.id === id) : undefined,
      ),
    };
    const { controller, configAudit, activeHealth } = makeDashboard({ config });

    await expect(
      controller.createNamespace({
        id: "team-alpha",
        name: "Team Alpha",
        allowed_nodes: ["openai", "openai", ""],
        allowed_models: ["gpt-4o"],
        budget: { daily_token_limit: 1000 },
        rate_limit: { requests_per_minute: 60 },
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        success: true,
        message: 'Policy Namespace "team-alpha" created',
        reload,
      }),
    );
    expect(configAudit.trackChange).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "config.namespace.create",
        target: "namespace:team-alpha",
      }),
      expect.any(Function),
    );
    expect(config.createNamespace).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "team-alpha",
        allowed_nodes: ["openai"],
        budget: { daily_token_limit: 1000 },
      }),
    );

    await expect(
      controller.updateNamespace("team-alpha", {
        name: "Team Alpha Updated",
        allowed_nodes: [],
        allowed_models: ["gpt-4o-mini"],
        budget: null,
        rate_limit: { requests_per_minute: 30 },
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        success: true,
        message: 'Policy Namespace "team-alpha" updated',
        reload,
      }),
    );
    expect(configAudit.trackChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: "config.namespace.update",
        target: "namespace:team-alpha",
      }),
      expect.any(Function),
    );
    expect(config.updateNamespace).toHaveBeenCalledWith("team-alpha", {
      name: "Team Alpha Updated",
      allowed_nodes: [],
      allowed_models: ["gpt-4o-mini"],
      budget: undefined,
      rate_limit: { requests_per_minute: 30 },
    });
    expect(activeHealth.refreshSchedules).toHaveBeenCalledTimes(2);
  });

  it("should require explicit impact confirmation before deleting a bound namespace", async () => {
    const config = {
      namespaces: [{ id: "team-alpha", name: "Team Alpha" }],
      auth: { api_keys: [] },
      getNamespace: jest.fn((id?: string | null) =>
        id === "team-alpha" ? { id: "team-alpha", name: "Team Alpha" } : undefined,
      ),
      deleteNamespace: jest.fn().mockReturnValue({
        success: true,
        message: "Configuration restored",
        source: "dashboard",
        current: { version: 2 },
        previous: { version: 1 },
        changed: { namespaces_changed: true },
        rolled_back: false,
      }),
    };
    const { controller, configAudit } = makeDashboard({
      config,
      gatewayApiKeys: {
        list: jest.fn().mockResolvedValue([
          {
            id: "key-1",
            name: "Production",
            status: "active",
            key_prefix: "gw_sk_live_1234",
            namespace_id: "team-alpha",
            team_id: null,
          },
        ]),
      },
    });

    await expect(controller.deleteNamespace("team-alpha", {})).rejects.toThrow(HttpException);
    expect(config.deleteNamespace).not.toHaveBeenCalled();
    expect(configAudit.trackChange).not.toHaveBeenCalled();

    await expect(
      controller.deleteNamespace("team-alpha", { confirm_impact: true }),
    ).resolves.toEqual(
      expect.objectContaining({
        success: true,
        message: 'Policy Namespace "team-alpha" deleted',
        impact: expect.objectContaining({
          counts: { api_keys: 1, teams: 0, total: 1 },
        }),
      }),
    );
    expect(configAudit.trackChange).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "config.namespace.delete",
        target: "namespace:team-alpha",
        metadata: expect.objectContaining({
          confirm_impact: true,
          impact: expect.objectContaining({
            counts: { api_keys: 1, teams: 0, total: 1 },
          }),
        }),
      }),
      expect.any(Function),
    );
    expect(config.deleteNamespace).toHaveBeenCalledWith("team-alpha");
  });

  it("should return 404 for missing namespace mutations", async () => {
    const { controller } = makeDashboard({
      config: {
        getNamespace: jest.fn().mockReturnValue(undefined),
      },
    });

    await expect(controller.updateNamespace("missing", {})).rejects.toThrow(HttpException);
    await expect(controller.deleteNamespace("missing", {})).rejects.toThrow(HttpException);
  });

  it("should return read-only shadow traffic status and recent rows", async () => {
    const { controller, shadowTraffic } = makeDashboard({
      shadowTraffic: {
        recent: jest
          .fn()
          .mockResolvedValue([
            { id: 1, status: "sent", namespace_id: "team-alpha" },
          ]),
      },
    });

    const result = await controller.getShadowTraffic("team-alpha", 10);

    expect(shadowTraffic.recent).toHaveBeenCalledWith("team-alpha", 10);
    expect(result.recent).toHaveLength(1);
    expect(result.status.privacy.provider_keys).toBe(false);
  });

  it("should return shadow comparison report with filters", async () => {
    const { controller, shadowTraffic } = makeDashboard({
      shadowTraffic: {
        comparisonReport: jest.fn().mockResolvedValue({
          primary_success_rate: 1,
          shadow_success_rate: 0.9,
          latency_delta_ms: -20,
          p50_latency_comparison: {
            primary_ms: 120,
            shadow_ms: 100,
            delta_ms: -20,
          },
          p95_latency_comparison: {
            primary_ms: 300,
            shadow_ms: 260,
            delta_ms: -40,
          },
          cost_delta_usd: -0.02,
          potential_savings_usd: 0.02,
          token_delta: -50,
          fallback_delta: -0.1,
          quality_sample_coverage: 0,
          confidence: { level: "medium", score: 0.62 },
          risk_notes: ["quality_samples_disabled"],
          pairs: [],
        }),
      },
    });

    const result = await controller.getShadowComparisonReport(
      "team-alpha",
      "default",
      "key-1",
      "shadow-openai",
      "gpt-4o-mini",
      "24h",
      "chat_completions",
    );

    expect(shadowTraffic.comparisonReport).toHaveBeenCalledWith({
      namespaceId: "team-alpha",
      apiKeyName: "default",
      apiKeyId: "key-1",
      node: "shadow-openai",
      model: "gpt-4o-mini",
      period: "24h",
      sourceFormat: "chat_completions",
    });
    expect(result.potential_savings_usd).toBe(0.02);
  });

  it("should return one shadow result comparison or 404", async () => {
    const { controller, shadowTraffic } = makeDashboard({
      shadowTraffic: {
        comparisonForResult: jest
          .fn()
          .mockResolvedValueOnce({ result_id: 12, request_id: "req-12" })
          .mockResolvedValueOnce(null),
      },
    });

    await expect(controller.getShadowResultComparison(12)).resolves.toEqual({
      result_id: 12,
      request_id: "req-12",
    });
    expect(shadowTraffic.comparisonForResult).toHaveBeenCalledWith(12);
    await expect(
      controller.getShadowResultComparison(404),
    ).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe("DashboardController — api_key filtering on stats", () => {
  it("should accept api_key param on getStats", async () => {
    const qb = mockQueryBuilder(
      {
        totalCalls: "5",
        successCalls: "4",
        totalInputTokens: "500",
        totalOutputTokens: "200",
        totalCost: "0.1",
        avgLatency: "100",
        uniqueSessions: "1",
        recentCalls: "2",
        recentCost: "0.05",
        recentTokens: "200",
      },
      [{ tier: "simple", count: "2" }],
    );
    const repo = mockRepo(qb);

    const { controller } = makeDashboard({ callLogRepo: repo, qb });
    const result = await controller.getStats("sean");

    expect(result.total.calls).toBe(5);
  });

  it("should prefer api_key_id param on getStats", async () => {
    const qb = mockQueryBuilder(
      {
        totalCalls: "5",
        successCalls: "4",
        totalInputTokens: "500",
        totalOutputTokens: "200",
        totalCost: "0.1",
        avgLatency: "100",
        uniqueSessions: "1",
        recentCalls: "2",
        recentCost: "0.05",
        recentTokens: "200",
      },
      [{ tier: "simple", count: "2" }],
    );
    const repo = mockRepo(qb);

    const { controller } = makeDashboard({ callLogRepo: repo, qb });
    await controller.getStats("renamed-key", "key_123");

    expect(qb.andWhere).toHaveBeenCalledWith(
      "(log.workspace_id = :workspaceId OR log.workspace_id IS NULL)",
      { workspaceId: "default-workspace" },
    );
    expect(qb.andWhere).toHaveBeenCalledWith("log.api_key_id = :apiKeyId", {
      apiKeyId: "key_123",
    });
  });
});

describe("DashboardController — provider extensibility", () => {
  it("delegates custom provider preview, SDK generation, and health summary", async () => {
    const providerExtensibility = {
      previewCustomProviderTemplate: jest.fn().mockReturnValue({ ok: true }),
      generateProviderSdk: jest.fn().mockReturnValue({
        beta: true,
        manual_review_required: true,
      }),
      providerHealthSummary: jest.fn().mockResolvedValue({ period: "24h" }),
    };
    const { controller } = makeDashboard({ providerExtensibility });

    const previewDto = {
      provider_id: "custom-acme",
      provider_name: "Acme AI",
      base_url: "https://api.acme.test",
      protocol: "chat_completions" as const,
      models: ["acme-chat"],
    };

    expect(controller.previewCustomProviderTemplate(previewDto as any)).toEqual({
      ok: true,
    });
    expect(controller.generateProviderSdk(previewDto as any)).toEqual({
      beta: true,
      manual_review_required: true,
    });
    await expect(controller.getProviderHealth("24h")).resolves.toEqual({
      period: "24h",
    });
    expect(providerExtensibility.previewCustomProviderTemplate).toHaveBeenCalledWith(
      previewDto,
    );
    expect(providerExtensibility.generateProviderSdk).toHaveBeenCalledWith(
      previewDto,
    );
    expect(providerExtensibility.providerHealthSummary).toHaveBeenCalledWith(
      "24h",
    );
  });
});

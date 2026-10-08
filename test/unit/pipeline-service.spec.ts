/**
 * PipelineService unit tests.
 *
 * Tests resolveSmartRoute (via process), budget enforcement,
 * cache integration, retry logic, and error formatting.
 *
 * Uses heavy mocking since PipelineService has 10 dependencies.
 */

import { PipelineService } from '../../src/pipeline/pipeline.service';
import { ProviderError } from '../../src/providers/provider-client.service';
import { ConcurrencyLimitError } from '../../src/routing/concurrency-limiter.service';
import { BudgetExceededError } from '../../src/budget/budget.service';
import { makeRequest, makeCanonicalResponse, mockConfigService } from '../helpers';
import { CanonicalMediaRequest } from '../../src/canonical/canonical.types';
import { createNoOpHookExecutor } from '../../src/plugins/testing';
import { TelemetryService } from '../../src/telemetry/telemetry.service';
import { MessagesNormalizer } from '../../src/canonical/normalizers/messages.normalizer';
import { CallLog } from '../../src/database/entities/call-log.entity';

function makeBudgetReservation(tokens = 0, costUsd = 0) {
  return {
    tokens,
    costUsd,
    commit: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
  };
}

async function reservedBudgetAt(mocks: Record<string, any>, index = 0) {
  return mocks.budgetService.reserve.mock.results[index]?.value;
}

function makePipeline(overrides: Record<string, any> = {}): {
  pipeline: PipelineService;
  mocks: Record<string, any>;
} {
  const config = mockConfigService({
    nodes: [
      {
        id: 'openai', name: 'OpenAI', protocol: 'chat_completions',
        models: ['gpt-4o', 'gpt-4o-mini'], model_aliases: {},
        image_models: ['gpt-image-1'],
        audio_models: ['tts-1'],
      },
      {
        id: 'claude', name: 'Claude', protocol: 'messages',
        models: ['claude-3-opus', 'claude-3-sonnet'], model_aliases: {},
      },
    ],
    retry: { max_retries: 2, backoff_base_ms: 10, backoff_max_ms: 100, retryable_status: [429, 502, 503] },
    resolveModel: jest.fn().mockImplementation((model: string) => {
      if (model === 'gpt-4o') return { nodeId: 'openai', model: 'gpt-4o' };
      if (model === 'claude-3-opus') return { nodeId: 'claude', model: 'claude-3-opus' };
      if (model.startsWith('openai/')) return { nodeId: 'openai', model: model.replace('openai/', '') };
      return null;
    }),
    resolveEmbeddingModel: jest.fn().mockImplementation((model: string) => {
      if (model === 'text-embedding-3-small') {
        return { nodeId: 'openai', model: 'text-embedding-3-small' };
      }
      return null;
    }),
    resolveImageModel: jest.fn().mockImplementation((model: string) => {
      if (model === 'gpt-image-1') {
        return { nodeId: 'openai', model: 'gpt-image-1' };
      }
      return null;
    }),
    resolveAudioModel: jest.fn().mockImplementation((model: string) => {
      if (model === 'tts-1') {
        return { nodeId: 'openai', model: 'tts-1' };
      }
      return null;
    }),
    getModelPricing: jest.fn().mockReturnValue({ input: 5, output: 15 }),
    ...overrides.config,
  });
  if (!overrides.config?.getNode) {
    config.getNode.mockImplementation((nodeId: string) =>
      config.nodes.find((node: { id: string }) => node.id === nodeId),
    );
  }

  const capabilityService = {
    resolveModelModalities: jest.fn().mockReturnValue(['text']),
    resolveNodeModalities: jest.fn().mockReturnValue(['text']),
    resolveModelRoutingCapabilities: jest.fn().mockImplementation(
      (_nodeId: string, model: string) => ({
        max_context_tokens: 128000,
        structured_output: null,
        pricing: config.getModelPricing(model),
      }),
    ),
    ...overrides.capabilityService,
  };

  const providerClient = {
    forward: jest.fn().mockResolvedValue(
      makeCanonicalResponse({ model: 'gpt-4o' }),
    ),
    forwardEmbeddings: jest.fn().mockResolvedValue({
      id: 'emb-test',
      object: 'list',
      data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }],
      usage: { input_tokens: 8, output_tokens: 0 },
      model: 'text-embedding-3-small',
      routing: {
        tier: 'standard',
        node: 'openai',
        latency_ms: 42,
        score: 0,
        is_fallback: false,
      },
    }),
    forwardRerank: jest.fn().mockResolvedValue({
      id: 'rerank-test',
      object: 'rerank',
      results: [{ index: 0, relevance_score: 0.97 }],
      usage: { input_tokens: 12, output_tokens: 0 },
      model: 'rerank-english-v3',
      routing: {
        tier: 'standard',
        node: 'openai',
        latency_ms: 35,
        score: 0,
        is_fallback: false,
      },
    }),
    forwardMedia: jest.fn().mockResolvedValue({
      id: 'media-test',
      body: {
        created: 123,
        data: [{ url: 'https://example.test/generated.png' }],
      },
      content_type: 'application/json',
      provider_response_type: 'application/json',
      usage: { input_tokens: 6, output_tokens: 0 },
      model: 'gpt-image-1',
      routing: {
        tier: 'standard',
        node: 'openai',
        latency_ms: 42,
        score: 0,
        is_fallback: false,
      },
    }),
    forwardStream: jest.fn(),
    ...overrides.providerClient,
  };

  const scoringService = {
    score: jest.fn().mockReturnValue({
      tier: 'standard',
      score: 0.45,
      domainHint: undefined,
      modalityHints: undefined,
      fastPath: undefined,
    }),
    onModuleInit: jest.fn(),
    ...overrides.scoringService,
  };

  const routingService = {
    resolve: jest.fn().mockReturnValue({
      primary: { node: 'openai', model: 'gpt-4o' },
      fallbacks: [{ node: 'claude', model: 'claude-3-opus' }],
      tier: 'standard',
      momentumAdjusted: false,
      experimentGroup: null,
      experimentGroupsByTarget: {},
      loadBalancing: {
        strategy: 'primary_fallback',
        source: 'primary_fallback',
        selected: { node: 'openai', model: 'gpt-4o' },
        target_count: 2,
      },
    }),
    resolveEmbeddingRoute: jest.fn().mockReturnValue({
      primary: { node: 'openai', model: 'text-embedding-3-small' },
      fallbacks: [],
      mode: 'auto',
    }),
    resolveRerankRoute: jest.fn().mockReturnValue({
      primary: { node: 'openai', model: 'rerank-english-v3' },
      fallbacks: [],
      mode: 'auto',
    }),
    resolveMediaRoute: jest.fn().mockReturnValue({
      primary: { node: 'openai', model: 'gpt-image-1' },
      fallbacks: [],
      mode: 'auto',
    }),
    recordTargetResult: jest.fn(),
    recordSessionRouteResult: jest.fn(),
    ...overrides.routingService,
  };

  const circuitBreaker = {
    isAvailable: jest.fn().mockReturnValue(true),
    recordSuccess: jest.fn(),
    recordFailure: jest.fn(),
    ...overrides.circuitBreaker,
  };

  const concurrencyLimiter = {
    acquire: jest.fn().mockResolvedValue({ release: jest.fn() }),
    getNodeStats: jest.fn().mockReturnValue({
      node: 'openai',
      max_concurrency: null,
      queue_timeout_ms: 10000,
      queue_policy: 'wait',
      active: 0,
      queued: 0,
    }),
    ...overrides.concurrencyLimiter,
  };

  const budgetService = {
    check: jest.fn().mockResolvedValue(undefined),
    reserve: jest.fn().mockImplementation((tokens: number, costUsd: number) =>
      Promise.resolve(makeBudgetReservation(tokens, costUsd)),
    ),
    record: jest.fn().mockResolvedValue(undefined),
    getStatus: jest.fn().mockResolvedValue([]),
    ...overrides.budgetService,
  };

  const cacheService = {
    shouldCache: jest.fn().mockReturnValue(false),
    lookup: jest.fn().mockReturnValue(null),
    store: jest.fn(),
    ...overrides.cacheService,
  };

  const logEventBus = {
    emit: jest.fn(),
    emitActivity: jest.fn(),
    ...overrides.logEventBus,
  };

  const hooks = overrides.hooks || createNoOpHookExecutor();
  const telemetryUploader = {
    enqueue: jest.fn(),
    ...overrides.telemetryUploader,
  };
  const telemetry = overrides.telemetry || new TelemetryService();
  const alerts = {
    recordCall: jest.fn(),
    ...overrides.alerts,
  };
  const logSinks = {
    enqueue: jest.fn(),
    ...overrides.logSinks,
  };
  const embeddingBatching = overrides.embeddingBatching;
  const shadowTraffic = {
    enqueueChat: jest.fn(),
    enqueueEmbeddings: jest.fn(),
    ...overrides.shadowTraffic,
  };
  const agentProfiles = {
    matchVirtualModel: jest.fn().mockResolvedValue(null),
    ...overrides.agentProfiles,
  };

  const callLogRepo = {
    create: jest.fn().mockImplementation((data: any) => data),
    save: jest.fn().mockImplementation((data: any) => Promise.resolve({ id: 1, ...data })),
    ...overrides.callLogRepo,
  };
  const routeDecisionRepo = {
    create: jest.fn().mockImplementation((data: any) => data),
    save: jest.fn().mockImplementation((data: any) => Promise.resolve({ id: 1, ...data })),
    ...overrides.routeDecisionRepo,
  };

  const pipeline = new PipelineService(
    config,
    capabilityService as any,
    providerClient as any,
    scoringService as any,
    routingService as any,
    circuitBreaker as any,
    concurrencyLimiter as any,
    budgetService as any,
    cacheService as any,
    logEventBus as any,
    hooks as any,
    telemetry as any,
    telemetryUploader as any,
    callLogRepo as any,
    routeDecisionRepo as any,
    { currentWorkspaceId: jest.fn(() => 'default-workspace') } as any,
    alerts as any,
    logSinks as any,
    embeddingBatching as any,
    shadowTraffic as any,
    agentProfiles as any,
    undefined,
    undefined,
    overrides.pricingRuntime,
  );

  return {
    pipeline,
    mocks: {
      config, capabilityService, providerClient, scoringService,
      routingService, circuitBreaker, concurrencyLimiter, budgetService, cacheService,
      logEventBus, hooks, telemetry, telemetryUploader, callLogRepo, routeDecisionRepo, alerts, logSinks,
      embeddingBatching,
      shadowTraffic,
      agentProfiles,
    },
  };
}

function makeMediaRequest(
  overrides: Partial<CanonicalMediaRequest> = {},
): CanonicalMediaRequest {
  return {
    model: 'auto',
    source_format: 'image_generation',
    payload: { model: 'auto', prompt: 'Draw SiftGate' },
    content_type: 'application/json',
    is_multipart: false,
    media: {
      media_type: 'image',
      operation: 'generation',
      multipart: false,
      file_count: 0,
      byte_size: 42,
      requested_format: null,
      response_format: null,
    },
    metadata: {
      source_format: 'image_generation',
      original_model: 'auto',
      raw_headers: {},
      media: {
        media_type: 'image',
        operation: 'generation',
        multipart: false,
        file_count: 0,
        byte_size: 42,
        requested_format: null,
        response_format: null,
      },
    },
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════
// Direct Model Routing
// ═══════════════════════════════════════════════════════════

describe('PipelineService — direct routing', () => {
  it('should route directly when model matches a known model', async () => {
    const { pipeline, mocks } = makePipeline();
    const request = makeRequest('Hello', { originalModel: 'gpt-4o' });

    const result = await pipeline.process(request);

    expect(result.statusCode).toBe(200);
    expect(result.requestId).toBeDefined();
    expect(mocks.providerClient.forward).toHaveBeenCalledWith(
      request, 'openai', 'gpt-4o',
      expect.objectContaining({ tier: 'direct', is_fallback: false }),
    );
    expect(mocks.logEventBus.emitActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: 'routed',
        workspace_id: 'default-workspace',
        source_format: 'chat_completions',
        stream: false,
        node_id: 'openai',
        model: 'gpt-4o',
      }),
    );
    const savedLog = mocks.callLogRepo.create.mock.calls[0][0];
    expect(result.requestId).toBe(savedLog.request_id);
    // Scoring engine should NOT be called for direct routing
    expect(mocks.scoringService.score).not.toHaveBeenCalled();
  });

  it('allows direct public model aliases when permissions list the upstream model', async () => {
    const { pipeline, mocks } = makePipeline({
      config: {
        nodes: [
          {
            id: 'anthropic-ada',
            name: 'Anthropic via Ada',
            protocol: 'messages',
            models: ['claude-opus-4-7-ada'],
            model_aliases: {},
            upstream_model_aliases: {
              'claude-opus-4-7-ada': 'claude-opus-4-7',
            },
          },
        ],
        resolveModel: jest.fn().mockReturnValue({
          nodeId: 'anthropic-ada',
          model: 'claude-opus-4-7-ada',
        }),
      },
    });
    const request = makeRequest('Hello', {
      originalModel: 'claude-opus-4-7-ada',
    });
    request.metadata.api_key_permissions = {
      allow_auto: true,
      allow_direct: true,
      allowed_nodes: [],
      allowed_models: ['claude-opus-4-7'],
      allowed_endpoints: [],
      allowed_modalities: [],
    };

    const result = await pipeline.process(request);

    expect(result.statusCode).toBe(200);
    expect(mocks.providerClient.forward).toHaveBeenCalledWith(
      request,
      'anthropic-ada',
      'claude-opus-4-7-ada',
      expect.objectContaining({ tier: 'direct', is_fallback: false }),
    );
  });

  it('does not fallback to another model for an explicit direct route', async () => {
    const { pipeline, mocks } = makePipeline();
    mocks.providerClient.forward.mockRejectedValue(
      new ProviderError('Direct model failed', 400, 'openai'),
    );
    const request = makeRequest('Hello', { originalModel: 'gpt-4o' });

    const result = await pipeline.process(request);

    expect(result.statusCode).toBe(400);
    expect(mocks.providerClient.forward).toHaveBeenCalledTimes(1);
    expect(mocks.providerClient.forward).toHaveBeenCalledWith(
      request,
      'openai',
      'gpt-4o',
      expect.objectContaining({ tier: 'direct', is_fallback: false }),
    );
  });

  it('preserves a clear Messages 400 for explicitly incompatible thinking and forced tools', async () => {
    const { pipeline, mocks } = makePipeline();
    const message = 'Thinking mode does not support this tool_choice.';
    mocks.providerClient.forward.mockRejectedValue(new ProviderError(message, 400, 'claude'));
    const request = new MessagesNormalizer().normalize({
      model: 'claude-3-opus', max_tokens: 4096,
      messages: [{ role: 'user', content: 'Probe' }],
      thinking: { type: 'enabled', budget_tokens: 2048 },
      tool_choice: { type: 'any' },
    }, {});

    const result = await pipeline.process(request);

    expect(result.statusCode).toBe(400);
    expect(result.body).toEqual({ type: 'error', error: { type: 'invalid_request_error', message } });
    expect(mocks.providerClient.forward).toHaveBeenCalledTimes(1);
    expect(request.thinking?.raw).toEqual({ type: 'enabled', budget_tokens: 2048 });
  });

  it('should fall through to auto routing for unknown models', async () => {
    const { pipeline, mocks } = makePipeline();
    const request = makeRequest('Hello', { originalModel: 'unknown-model-xyz' });

    await pipeline.process(request);

    // Should have called scoring engine (auto routing)
    expect(mocks.scoringService.score).toHaveBeenCalled();
    expect(mocks.routingService.resolve).toHaveBeenCalled();
  });

  it('should use auto routing when model is "auto"', async () => {
    const { pipeline, mocks } = makePipeline();
    const request = makeRequest('Hello', { originalModel: 'auto' });

    await pipeline.process(request);

    expect(mocks.scoringService.score).toHaveBeenCalled();
    expect(mocks.routingService.resolve).toHaveBeenCalled();
  });

  it('maps a profile-scoped Claude Code virtual model to auto routing when allow_auto is enabled', async () => {
    const { pipeline, mocks } = makePipeline({
      agentProfiles: {
        matchVirtualModel: jest.fn().mockResolvedValue({
          profile: {
            id: 'profile-1',
            name: 'Claude Code',
            connector: 'claude_code',
          },
          virtual_model: 'coding-deep',
          requested_model: 'coding-deep',
          internal_model: 'auto',
          routing_hint: { mode: 'coding', depth: 'deep' },
        }),
      },
    });
    const request = makeRequest('Hello', { originalModel: 'coding-deep' });
    request.metadata.api_key_id = 'key-1';
    request.metadata.agent_session_id = 'agent-sess-1';
    request.metadata.agent_turn_id = 'turn-1';
    request.metadata.agent_repo = 'siftgate';
    request.metadata.agent_project = 'platform';
    request.metadata.api_key_permissions = {
      allow_auto: true,
      allow_direct: false,
      allowed_nodes: [],
      allowed_models: [],
      allowed_endpoints: [],
      allowed_modalities: [],
    };

    const result = await pipeline.process(request);

    expect(result.statusCode).toBe(200);
    expect(mocks.agentProfiles.matchVirtualModel).toHaveBeenCalledWith(
      'key-1',
      'coding-deep',
    );
    expect(request.metadata.original_model).toBe('auto');
    expect(request.metadata).toMatchObject({
      agent_profile_id: 'profile-1',
      agent_profile_name: 'Claude Code',
      agent_connector: 'claude_code',
      agent_virtual_model: 'coding-deep',
      agent_requested_model: 'coding-deep',
      agent_routing_hint: { mode: 'coding', depth: 'deep' },
    });
    expect(mocks.scoringService.score).toHaveBeenCalled();
    expect(mocks.routingService.resolve).toHaveBeenCalled();
    expect(mocks.providerClient.forward).toHaveBeenCalledWith(
      request,
      'openai',
      'gpt-4o',
      expect.objectContaining({ tier: 'standard', is_fallback: false }),
    );
    const savedLog = mocks.callLogRepo.create.mock.calls[0][0];
    expect(savedLog).toMatchObject({
      agent_connector: 'claude_code',
      agent_profile_id: 'profile-1',
      agent_virtual_model: 'coding-deep',
      agent_requested_model: 'coding-deep',
      agent_session_id: 'agent-sess-1',
      agent_turn_id: 'turn-1',
      agent_repo: 'siftgate',
      agent_project: 'platform',
    });
    const routeDecision = mocks.routeDecisionRepo.create.mock.calls[0][0];
    expect(routeDecision).toMatchObject({
      agent_connector: 'claude_code',
      agent_session_id: 'agent-sess-1',
    });
    const trace = JSON.parse(routeDecision.trace_json);
    expect(trace.agent).toMatchObject({
      connector: 'claude_code',
      profile_id: 'profile-1',
      virtual_model: 'coding-deep',
      session_id: 'agent-sess-1',
      repo: 'siftgate',
      project: 'platform',
      routing_hint: { mode: 'coding', depth: 'deep' },
    });
    expect(JSON.stringify(trace)).not.toContain('Bearer ');
  });

  it('rejects profile virtual smart routing when allow_auto is disabled', async () => {
    const { pipeline, mocks } = makePipeline({
      agentProfiles: {
        matchVirtualModel: jest.fn().mockResolvedValue({
          profile: {
            id: 'profile-1',
            name: 'Claude Code',
            connector: 'claude_code',
          },
          virtual_model: 'claude-siftgate-auto',
          requested_model: 'claude-siftgate-auto',
          internal_model: 'auto',
        }),
      },
    });
    const request = makeRequest('Hello', { originalModel: 'claude-siftgate-auto' });
    request.metadata.api_key_id = 'key-1';
    request.metadata.api_key_permissions = {
      allow_auto: false,
      allow_direct: false,
      allowed_nodes: [],
      allowed_models: [],
      allowed_endpoints: [],
      allowed_modalities: [],
    };

    const result = await pipeline.process(request);

    expect(result.statusCode).toBe(403);
    expect(mocks.providerClient.forward).not.toHaveBeenCalled();
    expect(mocks.scoringService.score).not.toHaveBeenCalled();
  });

  it('should reject chat requests when API key endpoint permissions exclude chat', async () => {
    const { pipeline, mocks } = makePipeline();
    const request = makeRequest('Hello', { originalModel: 'auto' });
    request.metadata.api_key_permissions = {
      allow_auto: true,
      allow_direct: true,
      allowed_nodes: [],
      allowed_models: [],
      allowed_endpoints: ['embeddings'],
      allowed_modalities: [],
    };

    const result = await pipeline.process(request);

    expect(result.statusCode).toBe(403);
    expect(mocks.providerClient.forward).not.toHaveBeenCalled();
    expect(mocks.scoringService.score).not.toHaveBeenCalled();
  });

  it('should reject vision requests when API key modality permissions only allow text', async () => {
    const { pipeline, mocks } = makePipeline();
    const request = makeRequest('', {
      originalModel: 'gpt-4o',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'describe this image' },
            {
              type: 'image',
              source: {
                type: 'url',
                media_type: 'image/png',
                data: 'https://example.test/image.png',
              },
            },
          ],
        },
      ],
    });
    request.metadata.api_key_permissions = {
      allow_auto: true,
      allow_direct: true,
      allowed_nodes: [],
      allowed_models: [],
      allowed_endpoints: ['chat_completions'],
      allowed_modalities: ['text'],
    };

    const result = await pipeline.process(request);

    expect(result.statusCode).toBe(403);
    expect(mocks.providerClient.forward).not.toHaveBeenCalled();
  });

  it('should reject a direct route when the configured context window is too small', async () => {
    const { pipeline, mocks } = makePipeline({
      capabilityService: {
        resolveModelRoutingCapabilities: jest.fn().mockReturnValue({
          max_context_tokens: 10,
          structured_output: null,
          pricing: { input: 5, output: 15 },
        }),
      },
    });
    const request = makeRequest('Hello', { originalModel: 'gpt-4o' });

    const result = await pipeline.process(request);

    expect(result.statusCode).toBe(400);
    expect(String(((result.body as Record<string, any>).error as any).message)).toContain('max_context_tokens=10');
    expect(mocks.providerClient.forward).not.toHaveBeenCalled();
  });

  it('should pass token estimates into automatic routing', async () => {
    const { pipeline, mocks } = makePipeline();
    const request = makeRequest('Hello', { originalModel: 'auto', maxTokens: 25 });

    await pipeline.process(request);

    expect(mocks.routingService.resolve).toHaveBeenCalledWith(
      'standard',
      0.45,
      undefined,
      undefined,
      undefined,
      expect.objectContaining({
        estimated_input_tokens: expect.any(Number),
        estimated_output_tokens: 25,
        estimated_context_tokens: expect.any(Number),
      }),
    );
  });

  it('should persist a privacy-safe route decision trace', async () => {
    const { pipeline, mocks } = makePipeline({
      routingService: {
        resolve: jest.fn().mockReturnValue({
          primary: { node: 'openai', model: 'gpt-4o' },
          fallbacks: [{ node: 'claude', model: 'claude-3-opus' }],
          tier: 'standard',
          momentumAdjusted: false,
          domainHint: 'backend',
          experimentGroup: null,
          experimentGroupsByTarget: {},
          loadBalancing: {
            strategy: 'balanced',
            source: 'targets',
            selected: { node: 'openai', model: 'gpt-4o' },
            target_count: 2,
          },
          trace: {
            version: 1,
            mode: 'auto',
            tier: 'standard',
            score: 0.45,
            domain_hints: { domain: 'backend', modalities: ['text'] },
            scoring: { tier: 'standard', score: 0.45, momentum_adjusted: false },
            constraints: {
              estimated_input_tokens: 10,
              estimated_output_tokens: 25,
              estimated_context_tokens: 35,
              requires_structured_output: false,
            },
            candidate_targets: [
              {
                node: 'openai',
                model: 'gpt-4o',
                weight: 70,
                position: 0,
                circuit_state: 'CLOSED',
                circuit_available: true,
                selected: true,
                fallback: false,
                filter_reasons: [],
                scores: { cost: 0.9, latency: 0.8, context: 0.99 },
                metrics: {
                  estimated_cost_usd: 0.001,
                  avg_latency_ms: 120,
                  p95_latency_ms: 200,
                  max_context_tokens: 128000,
                  context_fit: 'safe',
                  structured_output: true,
                },
              },
            ],
            filters: [],
            load_balancing: {
              strategy: 'balanced',
              source: 'targets',
              selected: { node: 'openai', model: 'gpt-4o' },
              target_count: 2,
              reason: 'balanced local cost and latency score',
            },
            fallback_chain: [{ node: 'claude', model: 'claude-3-opus' }],
            cost_downgrade: null,
            final_selection: {
              node: 'openai',
              model: 'gpt-4o',
              reason: 'balanced local cost and latency score',
              is_fallback: false,
              fallback_reason: null,
            },
            privacy: {
              prompt: false,
              response: false,
              raw_headers: false,
              provider_keys: false,
            },
          },
        }),
      },
    });
    const request = makeRequest('do backend work', { originalModel: 'auto', maxTokens: 25 });
    request.metadata.raw_headers = { authorization: 'Bearer gw_sk_secret' };

    await pipeline.process(request);

    expect(mocks.routeDecisionRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        request_id: expect.any(String),
        source_format: 'chat_completions',
        selected_node_id: 'openai',
        selected_model: 'gpt-4o',
        route_mode: 'auto',
        strategy: 'balanced',
      }),
    );
    const saved = mocks.routeDecisionRepo.create.mock.calls[0][0];
    const trace = JSON.parse(saved.trace_json);
    expect(trace.request_id).toBe(saved.request_id);
    expect(trace.final_selection).toMatchObject({ node: 'openai', model: 'gpt-4o' });
    expect(JSON.stringify(trace)).not.toContain('gw_sk_secret');
    expect(trace.privacy).toEqual({
      prompt: false,
      response: false,
      raw_headers: false,
      provider_keys: false,
    });
  });

  it('should write full route traces behind the response path when configured', async () => {
    const { pipeline, mocks } = makePipeline({
      config: {
        database: {
          type: 'sqlite',
          path: ':memory:',
          route_trace_write_behind: true,
        },
      },
    });

    await pipeline.process(makeRequest('Hello', { originalModel: 'gpt-4o' }));

    expect(mocks.routeDecisionRepo.create).toHaveBeenCalled();
    expect(mocks.routeDecisionRepo.save).not.toHaveBeenCalled();
    await pipeline.beforeApplicationShutdown();
    expect(mocks.routeDecisionRepo.save).toHaveBeenCalledTimes(1);
  });

  it('batches disk-backed SQLite call logs behind the response path', async () => {
    const { pipeline, mocks } = makePipeline({
      config: {
        database: {
          type: 'sqlite',
          path: './data/gateway.db',
          route_trace_write_behind: true,
        },
      },
    });

    await pipeline.process(makeRequest('Hello', { originalModel: 'gpt-4o' }));

    expect(mocks.callLogRepo.save).not.toHaveBeenCalled();
    await pipeline.beforeApplicationShutdown();
    expect(mocks.callLogRepo.save).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ request_id: expect.any(String) })]),
    );
  });
});

describe('PipelineService — namespace and shadow traffic', () => {
  it('passes namespace scope to budget accounting and call logs', async () => {
    const { pipeline, mocks } = makePipeline();
    const request = makeRequest('Hello', { originalModel: 'gpt-4o' });
    request.metadata.namespace_id = 'team-alpha';

    await pipeline.process(request);

    expect(mocks.budgetService.check).toHaveBeenCalledWith(
      undefined,
      undefined,
      'team-alpha',
    );
    expect(mocks.budgetService.reserve).toHaveBeenCalledWith(
      expect.any(Number),
      expect.any(Number),
      undefined,
      undefined,
      'team-alpha',
    );
    const reservation = await reservedBudgetAt(mocks);
    expect(reservation.commit).toHaveBeenCalledWith(15, expect.any(Number));
    expect(mocks.budgetService.record).not.toHaveBeenCalled();
    expect(mocks.callLogRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ namespace_id: 'team-alpha' }),
    );
  });

  it('enqueues shadow traffic after a successful non-stream request', async () => {
    const { pipeline, mocks } = makePipeline();
    const request = makeRequest('Hello', { originalModel: 'gpt-4o' });

    await pipeline.process(request);

    expect(mocks.shadowTraffic.enqueueChat).toHaveBeenCalledWith(
      expect.any(String),
      request,
      expect.objectContaining({ model: 'gpt-4o' }),
      'openai',
      'gpt-4o',
    );
  });
});

// ═══════════════════════════════════════════════════════════
// Embeddings
// ═══════════════════════════════════════════════════════════

describe('PipelineService — embeddings', () => {
  function makeEmbeddingRequest(overrides: Record<string, any> = {}) {
    return {
      model: 'auto',
      input: ['hello', 'world'],
      metadata: {
        source_format: 'embeddings',
        original_model: 'auto',
        raw_headers: {},
        api_key_name: 'test-key',
        api_key_id: 'key_123',
        api_key_permissions: {
          allow_auto: true,
          allow_direct: true,
          allowed_nodes: [],
          allowed_models: [],
          allowed_endpoints: [],
          allowed_modalities: [],
        },
      },
      ...overrides,
    } as any;
  }

  it('should route OpenAI-compatible embeddings and record usage/cost', async () => {
    const { pipeline, mocks } = makePipeline();
    const request = makeEmbeddingRequest();

    const result = await pipeline.processEmbeddings(request);

    expect(result.statusCode).toBe(200);
    expect(result.body).toMatchObject({
      object: 'list',
      model: 'text-embedding-3-small',
      usage: { prompt_tokens: 8, total_tokens: 8 },
    });
    expect(((result.body as Record<string, any>).data as any[])[0]).toMatchObject({
      object: 'embedding',
      index: 0,
      embedding: [0.1, 0.2, 0.3],
    });
    expect(mocks.routingService.resolveEmbeddingRoute).toHaveBeenCalledWith(
      'auto',
      undefined,
      expect.any(Function),
    );
    expect(mocks.providerClient.forwardEmbeddings).toHaveBeenCalledWith(
      request,
      'openai',
      'text-embedding-3-small',
      expect.objectContaining({ tier: 'standard', is_fallback: false }),
      {},
    );
    expect(mocks.budgetService.reserve).toHaveBeenCalledWith(
      expect.any(Number),
      expect.any(Number),
      'test-key',
      'key_123',
    );
    const reservation = await reservedBudgetAt(mocks);
    expect(reservation.commit).toHaveBeenCalledWith(8, expect.any(Number));
    expect(mocks.budgetService.record).not.toHaveBeenCalled();
    expect(mocks.callLogRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        source_format: 'embeddings',
        node_id: 'openai',
        model: 'text-embedding-3-small',
        input_tokens: 8,
        output_tokens: 0,
        status_code: 200,
      }),
    );
  });

  it('should use embedding batching service when configured', async () => {
    const embeddingBatching = {
      enqueue: jest.fn().mockImplementation(
        async (
          canonical: any,
          nodeId: string,
          model: string,
          routingMeta: any,
          dispatch: any,
        ) => dispatch(canonical, nodeId, model, routingMeta),
      ),
    };
    const { pipeline, mocks } = makePipeline({ embeddingBatching });
    const request = makeEmbeddingRequest({ input: ['tiny'] });

    const result = await pipeline.processEmbeddings(request);

    expect(result.statusCode).toBe(200);
    expect(embeddingBatching.enqueue).toHaveBeenCalledWith(
      request,
      'openai',
      'text-embedding-3-small',
      expect.objectContaining({ tier: 'standard' }),
      expect.any(Function),
      {},
    );
    expect(mocks.concurrencyLimiter.acquire).toHaveBeenCalledTimes(1);
    expect(mocks.providerClient.forwardEmbeddings).toHaveBeenCalledTimes(1);
  });

  it('should return 400 for invalid embeddings input without calling upstream', async () => {
    const { pipeline, mocks } = makePipeline();
    const request = makeEmbeddingRequest({ input: { bad: true } });

    const result = await pipeline.processEmbeddings(request);

    expect(result.statusCode).toBe(400);
    expect(result.body).toMatchObject({
      error: expect.objectContaining({
        type: 'server_error',
      }),
    });
    expect(mocks.providerClient.forwardEmbeddings).not.toHaveBeenCalled();
  });

  it('should reject embeddings when API key endpoint permissions exclude embeddings', async () => {
    const { pipeline, mocks } = makePipeline();
    const request = makeEmbeddingRequest();
    request.metadata.api_key_permissions.allowed_endpoints = ['chat_completions'];

    const result = await pipeline.processEmbeddings(request);

    expect(result.statusCode).toBe(403);
    expect(mocks.providerClient.forwardEmbeddings).not.toHaveBeenCalled();
  });

  it('should try embedding fallbacks and preserve fallback_reason in call logs', async () => {
    const { pipeline, mocks } = makePipeline({
      config: {
        retry: { max_retries: 0, backoff_base_ms: 10, backoff_max_ms: 100, retryable_status: [429, 502, 503] },
      },
      routingService: {
        resolveEmbeddingRoute: jest.fn().mockReturnValue({
          primary: { node: 'openai', model: 'text-embedding-3-large' },
          fallbacks: [{ node: 'openai', model: 'text-embedding-3-small' }],
          mode: 'auto',
        }),
      },
      providerClient: {
        forwardEmbeddings: jest
          .fn()
          .mockRejectedValueOnce(new ProviderError('rate limited', 429, 'openai'))
          .mockResolvedValueOnce({
            id: 'emb-fallback',
            object: 'list',
            data: [{ index: 0, embedding: [0.4] }],
            usage: { input_tokens: 4, output_tokens: 0 },
            model: 'text-embedding-3-small',
            routing: {
              tier: 'standard',
              node: 'openai',
              latency_ms: 25,
              score: 0,
              is_fallback: true,
              fallback_reason: 'rate_limited',
            },
          }),
      },
    });

    const result = await pipeline.processEmbeddings(makeEmbeddingRequest());

    expect(result.statusCode).toBe(200);
    expect(mocks.providerClient.forwardEmbeddings).toHaveBeenCalledTimes(2);
    expect(mocks.callLogRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        is_fallback: true,
        fallback_reason: 'rate_limited',
        model: 'text-embedding-3-small',
      }),
    );
  });
});

// ═══════════════════════════════════════════════════════════
// Rerank
// ═══════════════════════════════════════════════════════════

describe('PipelineService — rerank', () => {
  function makeRerankRequest(overrides: Record<string, any> = {}) {
    return {
      model: 'auto',
      query: 'what is siftgate?',
      documents: ['SiftGate routes AI traffic.', 'SQLite stores local logs.'],
      top_n: 1,
      metadata: {
        source_format: 'rerank',
        original_model: 'auto',
        raw_headers: {},
        api_key_name: 'test-key',
        api_key_id: 'key_123',
        api_key_permissions: {
          allow_auto: true,
          allow_direct: true,
          allowed_nodes: [],
          allowed_models: [],
          allowed_endpoints: [],
          allowed_modalities: [],
        },
      },
      ...overrides,
    } as any;
  }

  it('should route rerank requests and record usage/cost/logs', async () => {
    const { pipeline, mocks } = makePipeline();
    const request = makeRerankRequest();

    const result = await pipeline.processRerank(request);

    expect(result.statusCode).toBe(200);
    expect(result.body).toMatchObject({
      object: 'rerank',
      model: 'rerank-english-v3',
      usage: { prompt_tokens: 12, total_tokens: 12 },
    });
    const body = result.body as any;
    expect((body.results as any[])[0]).toMatchObject({
      index: 0,
      relevance_score: 0.97,
    });
    expect(mocks.routingService.resolveRerankRoute).toHaveBeenCalledWith(
      'auto',
      expect.any(Function),
      expect.objectContaining({
        requested_modality: 'rerank',
        input_types: ['text', 'documents'],
        output_types: ['ranked_documents'],
      }),
    );
    expect(mocks.providerClient.forwardRerank).toHaveBeenCalledWith(
      request,
      'openai',
      'rerank-english-v3',
      expect.objectContaining({ tier: 'standard', is_fallback: false }),
      {},
    );
    expect(mocks.callLogRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        source_format: 'rerank',
        node_id: 'openai',
        model: 'rerank-english-v3',
        input_tokens: 12,
        output_tokens: 0,
        status_code: 200,
      }),
    );
    const routeTrace = JSON.parse(mocks.routeDecisionRepo.create.mock.calls[0][0].trace_json);
    expect(routeTrace.modality_evidence).toMatchObject({
      requested_modality: 'rerank',
      required_capabilities: ['rerank'],
    });
    expect(routeTrace.candidate_targets[0].capability_evidence).toMatchObject({
      requested_modality: 'rerank',
      pricing_source: 'config',
      pricing_used_from: 'gateway_config',
    });
  });

  it('should return 400 for invalid rerank requests without calling upstream', async () => {
    const { pipeline, mocks } = makePipeline();
    const request = makeRerankRequest({ query: '', documents: [] });

    const result = await pipeline.processRerank(request);

    expect(result.statusCode).toBe(400);
    expect(mocks.providerClient.forwardRerank).not.toHaveBeenCalled();
  });

  it('should try rerank fallbacks and preserve fallback_reason in call logs', async () => {
    const { pipeline, mocks } = makePipeline({
      config: {
        retry: { max_retries: 0, backoff_base_ms: 10, backoff_max_ms: 100, retryable_status: [429, 502, 503] },
      },
      routingService: {
        resolveRerankRoute: jest.fn().mockReturnValue({
          primary: { node: 'openai', model: 'rerank-large' },
          fallbacks: [{ node: 'openai', model: 'rerank-english-v3' }],
          mode: 'auto',
        }),
      },
      providerClient: {
        forwardRerank: jest
          .fn()
          .mockRejectedValueOnce(new ProviderError('rate limited', 429, 'openai'))
          .mockResolvedValueOnce({
            id: 'rerank-fallback',
            object: 'rerank',
            results: [{ index: 1, relevance_score: 0.8 }],
            usage: { input_tokens: 10, output_tokens: 0 },
            model: 'rerank-english-v3',
            routing: {
              tier: 'standard',
              node: 'openai',
              latency_ms: 22,
              score: 0,
              is_fallback: true,
              fallback_reason: 'rate_limited',
            },
          }),
      },
    });

    const result = await pipeline.processRerank(makeRerankRequest());

    expect(result.statusCode).toBe(200);
    expect(mocks.providerClient.forwardRerank).toHaveBeenCalledTimes(2);
    expect(mocks.callLogRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        is_fallback: true,
        fallback_reason: 'rate_limited',
        model: 'rerank-english-v3',
      }),
    );
  });
});

// ═══════════════════════════════════════════════════════════
// Budget Enforcement
// ═══════════════════════════════════════════════════════════

describe('PipelineService — budget enforcement', () => {
  it('should return 429 when budget is exceeded', async () => {
    const { pipeline } = makePipeline({
      budgetService: {
        check: jest.fn().mockRejectedValue(new BudgetExceededError('tokens', 1_500_000, 1_000_000)),
        record: jest.fn(),
        getStatus: jest.fn(),
      },
    });

    const request = makeRequest('Hello');
    const result = await pipeline.process(request);

    expect(result.statusCode).toBe(429);
    expect(result.body).toHaveProperty('error');
  });

  it('should return 429 when budget reservation is exceeded before upstream dispatch', async () => {
    const { pipeline, mocks } = makePipeline({
      budgetService: {
        reserve: jest.fn().mockRejectedValue(
          new BudgetExceededError('tokens', 999, 500),
        ),
      },
    });

    const request = makeRequest('Hello', { originalModel: 'gpt-4o' });
    const result = await pipeline.process(request);

    expect(result.statusCode).toBe(429);
    expect(mocks.budgetService.reserve).toHaveBeenCalled();
    expect(mocks.providerClient.forward).not.toHaveBeenCalled();
  });

  it('should commit reserved usage after successful response', async () => {
    const { pipeline, mocks } = makePipeline();
    const response = makeCanonicalResponse({
      usage: { input_tokens: 100, output_tokens: 50 },
    });
    mocks.providerClient.forward.mockResolvedValue(response);

    const request = makeRequest('Hello', { originalModel: 'gpt-4o' });
    await pipeline.process(request);

    expect(mocks.budgetService.reserve).toHaveBeenCalledWith(
      expect.any(Number),
      expect.any(Number),
      undefined,
    );
    const reservation = await reservedBudgetAt(mocks);
    expect(reservation.commit).toHaveBeenCalledWith(150, expect.any(Number));
    expect(mocks.budgetService.record).not.toHaveBeenCalled();
  });

  it('should pass api_key_name to budget check and reservation', async () => {
    const { pipeline, mocks } = makePipeline();
    const response = makeCanonicalResponse({
      usage: { input_tokens: 100, output_tokens: 50 },
    });
    mocks.providerClient.forward.mockResolvedValue(response);

    const request = makeRequest('Hello', { originalModel: 'gpt-4o' });
    request.metadata.api_key_name = 'sean';
    await pipeline.process(request);

    expect(mocks.budgetService.check).toHaveBeenCalledWith('sean');
    expect(mocks.budgetService.reserve).toHaveBeenCalledWith(
      expect.any(Number),
      expect.any(Number),
      'sean',
    );
    const reservation = await reservedBudgetAt(mocks);
    expect(reservation.commit).toHaveBeenCalledWith(150, expect.any(Number));
    expect(mocks.budgetService.record).not.toHaveBeenCalled();
  });

  it('should not pass apiKeyName when api_key_name is undefined', async () => {
    const { pipeline, mocks } = makePipeline();
    const response = makeCanonicalResponse({
      usage: { input_tokens: 100, output_tokens: 50 },
    });
    mocks.providerClient.forward.mockResolvedValue(response);

    const request = makeRequest('Hello', { originalModel: 'gpt-4o' });
    request.metadata.api_key_name = undefined;
    await pipeline.process(request);

    expect(mocks.budgetService.check).toHaveBeenCalledWith(undefined);
    expect(mocks.budgetService.reserve).toHaveBeenCalledWith(
      expect.any(Number),
      expect.any(Number),
      undefined,
    );
    const reservation = await reservedBudgetAt(mocks);
    expect(reservation.commit).toHaveBeenCalledWith(150, expect.any(Number));
    expect(mocks.budgetService.record).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════
// Cache Integration
// ═══════════════════════════════════════════════════════════

describe('PipelineService — caching', () => {
  it('should return cached response without calling provider', async () => {
    const cachedResponse = makeCanonicalResponse({
      model: 'gpt-4o',
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const { pipeline, mocks } = makePipeline({
      cacheService: {
        shouldCache: jest.fn().mockReturnValue(true),
        shouldCacheStream: jest.fn().mockReturnValue(true),
        lookup: jest.fn().mockReturnValue(cachedResponse),
        store: jest.fn(),
      },
    });

    const request = makeRequest('Hello', { originalModel: 'gpt-4o' });
    const result = await pipeline.process(request);

    expect(result.statusCode).toBe(200);
    expect(mocks.providerClient.forward).not.toHaveBeenCalled();
    expect(mocks.budgetService.record).toHaveBeenCalledWith(
      15,
      expect.any(Number),
      undefined,
    );
  });

  it('should store response in cache after successful call', async () => {
    const { pipeline, mocks } = makePipeline({
      cacheService: {
        shouldCache: jest.fn().mockReturnValue(true),
        shouldCacheStream: jest.fn().mockReturnValue(true),
        lookup: jest.fn().mockReturnValue(null),
        store: jest.fn(),
      },
    });

    const request = makeRequest('Hello', { originalModel: 'gpt-4o' });
    await pipeline.process(request);

    expect(mocks.cacheService.store).toHaveBeenCalledWith(
      request,
      expect.objectContaining({ model: 'gpt-4o' }),
    );
  });
});

// ═══════════════════════════════════════════════════════════
// Retry + Fallback
// ═══════════════════════════════════════════════════════════

describe('PipelineService — retry and fallback', () => {
  it('should retry on retryable status codes', async () => {
    const { pipeline, mocks } = makePipeline();
    mocks.providerClient.forward
      .mockRejectedValueOnce(new ProviderError('Rate limited', 429, 'openai'))
      .mockRejectedValueOnce(new ProviderError('Rate limited', 429, 'openai'))
      .mockResolvedValueOnce(makeCanonicalResponse());

    const request = makeRequest('Hello', { originalModel: 'gpt-4o' });
    const result = await pipeline.process(request);

    expect(result.statusCode).toBe(200);
    expect(mocks.providerClient.forward).toHaveBeenCalledTimes(3);
  });

  it('should not retry on non-retryable status codes', async () => {
    const { pipeline, mocks } = makePipeline();
    mocks.providerClient.forward.mockRejectedValue(
      new ProviderError('Bad Request', 400, 'openai'),
    );

    const request = makeRequest('Hello', { originalModel: 'gpt-4o' });
    const result = await pipeline.process(request);

    // 400 is not retryable, so only 1 attempt on primary, then fallback(s)
    expect(result.statusCode).toBe(400);
  });

  it('should try fallback nodes after primary exhausts retries', async () => {
    const fallbackResponse = makeCanonicalResponse({ model: 'claude-3-opus' });
    const { pipeline, mocks } = makePipeline();
    mocks.providerClient.forward
      // Primary fails all retries
      .mockRejectedValueOnce(new ProviderError('Rate limited', 429, 'openai'))
      .mockRejectedValueOnce(new ProviderError('Rate limited', 429, 'openai'))
      .mockRejectedValueOnce(new ProviderError('Rate limited', 429, 'openai'))
      // Fallback succeeds
      .mockResolvedValueOnce(fallbackResponse);

    const request = makeRequest('Hello', { originalModel: 'auto' });
    const result = await pipeline.process(request);

    expect(result.statusCode).toBe(200);
  });

  it('should return 502 when all nodes fail', async () => {
    const { pipeline, mocks } = makePipeline();
    mocks.providerClient.forward.mockRejectedValue(
      new ProviderError('Server Error', 502, 'openai'),
    );

    const request = makeRequest('Hello', { originalModel: 'auto' });
    const result = await pipeline.process(request);

    expect(result.statusCode).toBe(502);
    expect(result.body).toHaveProperty('error');
  });

  it('should preserve the last upstream status when all nodes fail', async () => {
    const { pipeline, mocks } = makePipeline();
    mocks.providerClient.forward
      .mockRejectedValueOnce(new ProviderError('Rate limited', 429, 'openai'))
      .mockRejectedValueOnce(new ProviderError('Rate limited', 429, 'openai'))
      .mockRejectedValueOnce(new ProviderError('Rate limited', 429, 'openai'))
      .mockRejectedValueOnce(new ProviderError('Forbidden', 403, 'claude'));

    const request = makeRequest('Hello', { originalModel: 'auto' });
    const result = await pipeline.process(request);

    expect(result.statusCode).toBe(403);
  });

  it('should record circuit breaker success on successful call', async () => {
    const { pipeline, mocks } = makePipeline();
    const request = makeRequest('Hello', { originalModel: 'gpt-4o' });

    await pipeline.process(request);

    expect(mocks.circuitBreaker.recordSuccess).toHaveBeenCalled();
  });

  it('should feed upstream latency results back to routing metrics', async () => {
    const response = makeCanonicalResponse({
      model: 'gpt-4o',
      routing: {
        tier: 'standard',
        node: 'openai',
        latency_ms: 123,
        score: 0.45,
        is_fallback: false,
      },
    });
    const { pipeline, mocks } = makePipeline({
      providerClient: {
        forward: jest.fn().mockResolvedValue(response),
      },
    });
    const request = makeRequest('Hello', { originalModel: 'auto' });

    await pipeline.process(request);

    expect(mocks.routingService.recordTargetResult).toHaveBeenCalledWith(
      'openai',
      'gpt-4o',
      123,
      200,
    );
  });

  it('should record circuit breaker failure when node fails', async () => {
    const { pipeline, mocks } = makePipeline();
    mocks.providerClient.forward.mockRejectedValue(
      new ProviderError('Bad Request', 400, 'openai'),
    );

    const request = makeRequest('Hello', { originalModel: 'gpt-4o' });
    await pipeline.process(request);

    expect(mocks.circuitBreaker.recordFailure).toHaveBeenCalled();
  });
});

describe('PipelineService — fallback policies', () => {
  it('should immediately fallback on 429 when policy is enabled', async () => {
    const fallbackResponse = makeCanonicalResponse({ model: 'claude-3-opus' });
    const { pipeline, mocks } = makePipeline({
      config: {
        fallbackPolicy: {
          immediate_429: true,
          timeout: { enabled: false, threshold_ms: undefined, race_fallback: false },
          structured_output: {
            enabled: false,
            fallback_on_parse_error: true,
            fallback_on_schema_error: true,
          },
          cost_downgrade: { enabled: false, max_estimated_cost_usd: undefined },
        },
      },
      providerClient: {
        forward: jest.fn().mockImplementation((_request, nodeId: string) => {
          if (nodeId === 'openai') {
            throw new ProviderError('Rate limited', 429, 'openai', 'rate_limited');
          }
          return Promise.resolve(fallbackResponse);
        }),
        forwardStream: jest.fn(),
      },
    });

    const request = makeRequest('Hello', { originalModel: 'auto' });
    const result = await pipeline.process(request);

    expect(result.statusCode).toBe(200);
    expect(mocks.providerClient.forward).toHaveBeenCalledTimes(2);
    expect(mocks.providerClient.forward.mock.calls[0][1]).toBe('openai');
    expect(mocks.providerClient.forward.mock.calls[1][1]).toBe('claude');
    const savedLog = mocks.callLogRepo.create.mock.calls[0][0];
    expect(savedLog.is_fallback).toBe(true);
    expect(savedLog.fallback_reason).toBe('rate_limited');
  });

  it('should release a failed primary reservation and commit fallback usage', async () => {
    const primaryReservation = makeBudgetReservation();
    const fallbackReservation = makeBudgetReservation();
    const fallbackResponse = makeCanonicalResponse({
      model: 'claude-3-opus',
      usage: { input_tokens: 11, output_tokens: 7 },
    });
    const { pipeline, mocks } = makePipeline({
      config: {
        retry: { max_retries: 0, backoff_base_ms: 10, backoff_max_ms: 100, retryable_status: [429, 502, 503] },
      },
      budgetService: {
        reserve: jest.fn()
          .mockResolvedValueOnce(primaryReservation)
          .mockResolvedValueOnce(fallbackReservation),
      },
      providerClient: {
        forward: jest.fn()
          .mockRejectedValueOnce(new ProviderError('Rate limited', 429, 'openai'))
          .mockResolvedValueOnce(fallbackResponse),
        forwardStream: jest.fn(),
      },
    });

    const request = makeRequest('Hello', { originalModel: 'auto' });
    const result = await pipeline.process(request);

    expect(result.statusCode).toBe(200);
    expect(mocks.budgetService.reserve).toHaveBeenCalledTimes(2);
    expect(primaryReservation.release).toHaveBeenCalled();
    expect(primaryReservation.commit).not.toHaveBeenCalled();
    expect(fallbackReservation.commit).toHaveBeenCalledWith(18, expect.any(Number));
    expect(fallbackReservation.release).not.toHaveBeenCalled();
  });

  it('should fallback on policy timeout without retrying the timed-out node', async () => {
    const fallbackResponse = makeCanonicalResponse({ model: 'claude-3-opus' });
    const { pipeline, mocks } = makePipeline({
      config: {
        fallbackPolicy: {
          immediate_429: false,
          timeout: { enabled: true, threshold_ms: 25, race_fallback: false },
          structured_output: {
            enabled: false,
            fallback_on_parse_error: true,
            fallback_on_schema_error: true,
          },
          cost_downgrade: { enabled: false, max_estimated_cost_usd: undefined },
        },
      },
      providerClient: {
        forward: jest.fn().mockImplementation((_request, nodeId: string) => {
          if (nodeId === 'openai') {
            throw new ProviderError('Timed out', 504, 'openai', 'timeout');
          }
          return Promise.resolve(fallbackResponse);
        }),
        forwardStream: jest.fn(),
      },
    });

    const request = makeRequest('Hello', { originalModel: 'auto' });
    const result = await pipeline.process(request);

    expect(result.statusCode).toBe(200);
    expect(mocks.providerClient.forward).toHaveBeenCalledTimes(2);
    expect(mocks.providerClient.forward.mock.calls[0][4]).toEqual({ timeoutMs: 25 });
    const savedLog = mocks.callLogRepo.create.mock.calls[0][0];
    expect(savedLog.fallback_reason).toBe('timeout');
  });

  it('should fallback when structured output is not valid JSON', async () => {
    const badJson = makeCanonicalResponse({
      model: 'gpt-4o',
      content: [{ type: 'text', text: 'not json' }],
    });
    const goodJson = makeCanonicalResponse({
      model: 'claude-3-opus',
      content: [{ type: 'text', text: '{"ok":true}' }],
    });
    const { pipeline, mocks } = makePipeline({
      config: {
        fallbackPolicy: {
          immediate_429: false,
          timeout: { enabled: false, threshold_ms: undefined, race_fallback: false },
          structured_output: {
            enabled: true,
            fallback_on_parse_error: true,
            fallback_on_schema_error: true,
          },
          cost_downgrade: { enabled: false, max_estimated_cost_usd: undefined },
        },
      },
    });
    mocks.providerClient.forward
      .mockResolvedValueOnce(badJson)
      .mockResolvedValueOnce(goodJson);

    const request = makeRequest('Return JSON', { originalModel: 'auto' });
    request.metadata.raw_body = { response_format: { type: 'json_object' } };
    const result = await pipeline.process(request);

    expect(result.statusCode).toBe(200);
    expect(mocks.providerClient.forward).toHaveBeenCalledTimes(2);
    const savedLog = mocks.callLogRepo.create.mock.calls[0][0];
    expect(savedLog.fallback_reason).toBe('structured_output_parse_failed');
    expect(savedLog.structured_output_requested).toBe(true);
    expect(savedLog.structured_output_type).toBe('json_object');
    expect(savedLog.structured_output_strategy).toBe('native');
  });

  it('should fallback when structured output JSON schema validation fails', async () => {
    const schema = {
      type: 'object',
      required: ['ok'],
      properties: { ok: { type: 'boolean' } },
      additionalProperties: false,
    };
    const schemaMiss = makeCanonicalResponse({
      model: 'gpt-4o',
      content: [{ type: 'text', text: '{"message":"missing ok"}' }],
    });
    const schemaHit = makeCanonicalResponse({
      model: 'claude-3-opus',
      content: [{ type: 'text', text: '{"ok":true}' }],
    });
    const { pipeline, mocks } = makePipeline({
      config: {
        fallbackPolicy: {
          immediate_429: false,
          timeout: { enabled: false, threshold_ms: undefined, race_fallback: false },
          structured_output: {
            enabled: true,
            fallback_on_parse_error: true,
            fallback_on_schema_error: true,
          },
          cost_downgrade: { enabled: false, max_estimated_cost_usd: undefined },
        },
      },
    });
    mocks.providerClient.forward
      .mockResolvedValueOnce(schemaMiss)
      .mockResolvedValueOnce(schemaHit);

    const request = makeRequest('Return schema JSON', { originalModel: 'auto' });
    request.metadata.raw_body = {
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'Result', schema },
      },
    };
    const result = await pipeline.process(request);

    expect(result.statusCode).toBe(200);
    const savedLog = mocks.callLogRepo.create.mock.calls[0][0];
    expect(savedLog.fallback_reason).toBe('structured_output_schema_failed');
    expect(savedLog.structured_output_requested).toBe(true);
    expect(savedLog.structured_output_type).toBe('json_schema');
    expect(savedLog.structured_output_schema_name).toBe('Result');
  });

  it('should log structured output passthrough strategy for native OpenAI chat', async () => {
    const { pipeline, mocks } = makePipeline();
    mocks.providerClient.forward.mockResolvedValueOnce(makeCanonicalResponse({
      model: 'gpt-4o',
      content: [{ type: 'text', text: '{"ok":true}' }],
    }));

    const request = makeRequest('Return JSON', { originalModel: 'auto' });
    request.metadata.raw_body = { response_format: { type: 'json_object' } };
    const result = await pipeline.process(request);

    expect(result.statusCode).toBe(200);
    const savedLog = mocks.callLogRepo.create.mock.calls[0][0];
    expect(savedLog.structured_output_requested).toBe(true);
    expect(savedLog.structured_output_type).toBe('json_object');
    expect(savedLog.structured_output_strategy).toBe('passthrough');
    expect(savedLog.structured_output_supported).toBe(true);
  });

  it('should route and log reasoning effort metadata', async () => {
    const { pipeline, mocks } = makePipeline({
      capabilityService: {
        resolveModelRoutingCapabilities: jest.fn().mockImplementation(
          (_nodeId: string, model: string) => ({
            max_context_tokens: 128000,
            structured_output: null,
            supports_reasoning: model === 'gpt-4o',
            pricing: { input: 5, output: 15 },
          }),
        ),
      },
    });
    mocks.providerClient.forward.mockResolvedValueOnce(makeCanonicalResponse({
      model: 'gpt-4o',
    }));

    const request = makeRequest('Solve carefully', { originalModel: 'auto' });
    request.reasoning_effort = 'high';
    request.reasoning = {
      requested: true,
      source: 'chat_completions.reasoning_effort',
      effort: 'high',
      raw: 'high',
    };
    request.metadata.raw_body = { reasoning_effort: 'high' };

    const result = await pipeline.process(request);

    expect(result.statusCode).toBe(200);
    expect(mocks.routingService.resolve).toHaveBeenCalledWith(
      'standard',
      0.45,
      undefined,
      undefined,
      undefined,
      expect.objectContaining({
        requires_reasoning: true,
        reasoning_effort: 'high',
        required_capabilities: ['text', 'reasoning'],
      }),
    );
    const savedLog = mocks.callLogRepo.create.mock.calls[0][0];
    expect(savedLog.reasoning_requested).toBe(true);
    expect(savedLog.reasoning_effort).toBe('high');
    expect(savedLog.reasoning_strategy).toBe('passthrough');
    expect(savedLog.reasoning_supported).toBe(true);
  });

  it('should downgrade to a cheaper fallback before upstream when estimated cost exceeds policy', async () => {
    const cheapResponse = makeCanonicalResponse({ model: 'gpt-4o-mini' });
    const { pipeline, mocks } = makePipeline({
      config: {
        fallbackPolicy: {
          immediate_429: false,
          timeout: { enabled: false, threshold_ms: undefined, race_fallback: false },
          structured_output: {
            enabled: false,
            fallback_on_parse_error: true,
            fallback_on_schema_error: true,
          },
          cost_downgrade: { enabled: true, max_estimated_cost_usd: 0.01 },
        },
        getModelPricing: jest.fn().mockImplementation((model: string) => {
          if (model === 'gpt-4o') return { input: 500, output: 500 };
          if (model === 'gpt-4o-mini') return { input: 0.01, output: 0.01 };
          return { input: 5, output: 15 };
        }),
      },
      routingService: {
        resolve: jest.fn().mockReturnValue({
          primary: { node: 'openai', model: 'gpt-4o' },
          fallbacks: [{ node: 'openai', model: 'gpt-4o-mini' }],
          tier: 'standard',
          momentumAdjusted: false,
          experimentGroup: null,
          experimentGroupsByTarget: {},
        }),
      },
      providerClient: {
        forward: jest.fn().mockResolvedValue(cheapResponse),
        forwardStream: jest.fn(),
      },
    });

    const request = makeRequest('Long prompt', {
      originalModel: 'auto',
      maxTokens: 20_000,
    });
    const result = await pipeline.process(request);

    expect(result.statusCode).toBe(200);
    expect(mocks.providerClient.forward).toHaveBeenCalledTimes(1);
    expect(mocks.providerClient.forward.mock.calls[0][2]).toBe('gpt-4o-mini');
    const savedLog = mocks.callLogRepo.create.mock.calls[0][0];
    expect(savedLog.is_fallback).toBe(true);
    expect(savedLog.fallback_reason).toBe('cost_downgrade');
  });
});

// ═══════════════════════════════════════════════════════════
// Concurrency Limiter
// ═══════════════════════════════════════════════════════════

describe('PipelineService — concurrency limiter', () => {
  it('should release the concurrency slot after a successful upstream call', async () => {
    const release = jest.fn();
    const { pipeline, mocks } = makePipeline({
      concurrencyLimiter: {
        acquire: jest.fn().mockResolvedValue({ release }),
      },
    });

    const request = makeRequest('Hello', { originalModel: 'gpt-4o' });
    await pipeline.process(request);

    expect(mocks.concurrencyLimiter.acquire).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'openai' }),
      'gpt-4o',
    );
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('should release the concurrency slot when upstream throws', async () => {
    const release = jest.fn();
    const { pipeline } = makePipeline({
      concurrencyLimiter: {
        acquire: jest.fn().mockResolvedValue({ release }),
      },
      providerClient: {
        forward: jest.fn().mockRejectedValue(new ProviderError('Bad Request', 400, 'openai')),
        forwardStream: jest.fn(),
      },
    });

    const request = makeRequest('Hello', { originalModel: 'gpt-4o' });
    await pipeline.process(request);

    expect(release).toHaveBeenCalledTimes(1);
  });

  it('should skip to fallback when a saturated node allows fallback', async () => {
    const fallbackResponse = makeCanonicalResponse({ model: 'claude-3-opus' });
    const { pipeline, mocks } = makePipeline({
      concurrencyLimiter: {
        acquire: jest.fn().mockImplementation((node: { id: string }, model: string) => {
          if (node.id === 'openai') {
            throw new ConcurrencyLimitError(
              'openai saturated',
              node.id,
              model,
              503,
              'fallback',
              true,
            );
          }
          return Promise.resolve({ release: jest.fn() });
        }),
      },
      providerClient: {
        forward: jest.fn().mockResolvedValue(fallbackResponse),
        forwardStream: jest.fn(),
      },
    });

    const request = makeRequest('Hello', { originalModel: 'auto' });
    const result = await pipeline.process(request);

    expect(result.statusCode).toBe(200);
    expect(mocks.providerClient.forward).toHaveBeenCalledWith(
      expect.any(Object),
      'claude',
      'claude-3-opus',
      expect.objectContaining({ is_fallback: true }),
    );
    expect(mocks.circuitBreaker.recordFailure).not.toHaveBeenCalledWith('openai', 'gpt-4o');
  });

  it('should return 429 when a saturated node rejects immediately', async () => {
    const { pipeline, mocks } = makePipeline({
      concurrencyLimiter: {
        acquire: jest.fn().mockImplementation((node: { id: string }, model: string) => {
          throw new ConcurrencyLimitError(
            'openai saturated',
            node.id,
            model,
            429,
            'reject',
            false,
          );
        }),
      },
    });

    const request = makeRequest('Hello', { originalModel: 'gpt-4o' });
    const result = await pipeline.process(request);

    expect(result.statusCode).toBe(429);
    expect(mocks.providerClient.forward).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════
// Error Formatting
// ═══════════════════════════════════════════════════════════

describe('PipelineService — error formatting', () => {
  it('should format chat_completions errors correctly', async () => {
    const { pipeline } = makePipeline({
      budgetService: {
        check: jest.fn().mockRejectedValue(new BudgetExceededError('tokens', 1_500_000, 1_000_000)),
        record: jest.fn(),
        getStatus: jest.fn(),
      },
    });

    const request = makeRequest('Hello');
    // Default source_format is 'chat_completions'
    const result = await pipeline.process(request);

    expect(result.body).toEqual({
      error: {
        message: expect.stringContaining('Budget exceeded'),
        type: 'budget_exceeded',
        code: 'tokens',
        details: expect.objectContaining({
          scope: 'global',
          api_key_id: null,
          budget_type: 'tokens',
          current: 1_500_000,
          limit: 1_000_000,
        }),
      },
    });
  });

  it('should format messages errors in Anthropic style', async () => {
    const { pipeline } = makePipeline({
      budgetService: {
        check: jest.fn().mockRejectedValue(new BudgetExceededError('tokens', 1_500_000, 1_000_000)),
        record: jest.fn(),
        getStatus: jest.fn(),
      },
    });

    const request = makeRequest('Hello');
    request.metadata.source_format = 'messages';
    const result = await pipeline.process(request);

    expect(result.body).toEqual({
      type: 'error',
      error: {
        type: 'budget_exceeded',
        message: expect.stringContaining('Budget exceeded'),
        details: expect.objectContaining({
          scope: 'global',
          api_key_id: null,
          budget_type: 'tokens',
        }),
      },
    });
  });
});

// ═══════════════════════════════════════════════════════════
// Call Logging
// ═══════════════════════════════════════════════════════════

describe('PipelineService — call logging', () => {
  function projectedLogging(database = { type: 'postgres', path: ':memory:' }, owned = true) {
    const pricing = {
      active: jest.fn(() => true),
      ownsLogContext: jest.fn(() => owned),
      estimate: jest.fn(() => null),
      logSummary: jest.fn(async () => ({ known_subtotal: '0.0003' })),
      persistCallLogs: jest.fn(async (logs: CallLog[], _required?: boolean): Promise<CallLog[] | null> =>
        logs.map(log => ({ ...log, id: 1, cost_usd: 0.004, cost_without_cache_usd: null }))),
    };
    const { pipeline, mocks } = makePipeline({ config: { database }, pricingRuntime: pricing });
    jest.spyOn(mocks.telemetry, 'recordCallMetrics');
    const params: Parameters<PipelineService['logCall']>[0] = {
      requestId: 'synthetic-log', canonical: makeRequest('synthetic'), tier: 'standard', score: 0,
      nodeId: 'openai', model: 'gpt-4o', statusCode: 200, isFallback: false,
      latencyMs: 10, usage: { input_tokens: 10, output_tokens: 5 }, error: null,
    };
    return { pipeline, mocks, pricing, params };
  }

  it('records the committed PostgreSQL log projection without a preliminary summary read', async () => {
    const { pipeline, mocks, pricing, params } = projectedLogging();
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { reached = resolve; });
    pricing.persistCallLogs.mockImplementationOnce(async logs => {
      reached(); await gate;
      return logs.map(log => ({ ...log, id: 1, cost_usd: 0.004 }));
    });
    const task = pipeline.logCall(params);
    try {
      await started;
      expect(mocks.telemetry.recordCallMetrics).not.toHaveBeenCalled();
      expect(mocks.logEventBus.emit).not.toHaveBeenCalled();
    } finally { release(); await task; }
    expect(pricing.logSummary).not.toHaveBeenCalled();
    expect(pricing.persistCallLogs).toHaveBeenCalledWith(expect.any(Array), true);
    expect(mocks.telemetry.recordCallMetrics).toHaveBeenCalledTimes(1);
    expect(mocks.telemetry.recordCallMetrics).toHaveBeenCalledWith(expect.objectContaining({ costUsd: 0.004, statusCode: 200 }));
    expect(mocks.callLogRepo.save).not.toHaveBeenCalled();
    expect(mocks.logEventBus.emit).toHaveBeenCalledTimes(1);
  });

  it('publishes a joined committed log without a second log or route write', async () => {
    const { pipeline, mocks, pricing, params } = projectedLogging();
    let released!: () => void, reached!: () => void;
    const entered = new Promise<void>(resolve => { reached = resolve; });
    const wait = new Promise<void>(resolve => { released = resolve; });
    const joining = pipeline.logCall(params, async ({ call }) => {
      reached(); await wait; return { ...call, id: 41, cost_usd: .004 };
    });
    try {
      await entered;
      expect(mocks.logEventBus.emit).not.toHaveBeenCalled();
      expect(mocks.telemetry.recordCallMetrics).not.toHaveBeenCalled();
    } finally { released(); await joining; }
    expect(pricing.persistCallLogs).not.toHaveBeenCalled();
    expect(mocks.routeDecisionRepo.save).not.toHaveBeenCalled();
    expect(pricing.logSummary).not.toHaveBeenCalled();
    expect(mocks.telemetry.recordCallMetrics).toHaveBeenCalledWith(expect.objectContaining({ costUsd: .004 }));
    expect(mocks.logEventBus.emit).toHaveBeenCalledTimes(1);
  });

  it('keeps sequence-allocated identities when joined logging falls back after an uncertain commit', async () => {
    const { pipeline, mocks, pricing, params } = projectedLogging();
    await pipeline.logCall(params, async ({ call, route }) => {
      call.id = 71; route!.id = 72; return null;
    });
    expect(pricing.persistCallLogs).toHaveBeenCalledWith([expect.objectContaining({ id: 71 })], true);
    expect(mocks.routeDecisionRepo.save).toHaveBeenCalledWith(expect.objectContaining({ id: 72 }));
    expect(mocks.logEventBus.emit).toHaveBeenCalledTimes(1);
  });

  it.each(['preparation', 'unavailable', 'callback-failure'] as const)('records budget exactly once when joined logging has %s failure', async failure => {
    const { pipeline, mocks, pricing, params } = projectedLogging();
    const budgetResult = jest.fn(async () => ({ costUsd: .004, totalTokens: 15 }));
    const budgetResultWithLogs = jest.fn(async () => {
      if (failure === 'callback-failure') throw Error('synthetic joined callback failure');
      return null;
    });
    Object.assign(pricing, { budgetResult, budgetResultWithLogs });
    if (failure === 'preparation') mocks.callLogRepo.create.mockImplementationOnce(() => { throw Error('synthetic log preparation failure'); });
    const coordinator = pipeline as unknown as {
      recordBudgetAndLog(canonical: typeof params.canonical, usage: typeof params.usage, model: string, node: string, reservation: null, logParams: typeof params): Promise<{ costUsd: number; totalTokens: number }>;
    };
    await expect(coordinator.recordBudgetAndLog(params.canonical, params.usage, params.model, params.nodeId, null, params)).resolves.toEqual({ costUsd: .004, totalTokens: 15 });
    expect(budgetResult).toHaveBeenCalledTimes(1);
    expect(budgetResultWithLogs).toHaveBeenCalledTimes(failure === 'preparation' ? 0 : 1);
    expect(mocks.providerClient.forward).not.toHaveBeenCalled();
  });

  it.each([false, true])('joined route preparation failure still persists the call and never retries trace preparation (fallback=%s)', async fallback => {
    const { pipeline, mocks, pricing, params } = projectedLogging();
    pricing.estimate.mockImplementationOnce(() => { throw Error('synthetic route preparation failure'); });
    const settle = jest.fn(async ({ call, route }: { call: CallLog; route?: unknown }) => {
      expect(route).toBeUndefined();
      return fallback ? null : { ...call, id: 91, cost_usd: .004 };
    });
    await pipeline.logCall(params, settle);
    expect(settle).toHaveBeenCalledTimes(1);
    expect(pricing.estimate).toHaveBeenCalledTimes(1);
    expect(mocks.routeDecisionRepo.save).not.toHaveBeenCalled();
    expect(pricing.persistCallLogs).toHaveBeenCalledTimes(fallback ? 1 : 0);
    expect(mocks.logEventBus.emit).toHaveBeenCalledTimes(1);
    expect(mocks.telemetry.recordCallMetrics).toHaveBeenCalledWith(expect.objectContaining({ costUsd: .004 }));
  });

  it.each([0, 0.004])('uses the projected known subtotal for failed calls without inferring a new price (%s)', async amount => {
    const { pipeline, mocks, pricing, params } = projectedLogging();
    pricing.persistCallLogs.mockImplementationOnce(async logs => logs.map(log => ({ ...log, cost_usd: amount })));
    await pipeline.logCall({ ...params, statusCode: 502, error: 'synthetic upstream failure' });
    expect(pricing.logSummary).not.toHaveBeenCalled();
    expect(mocks.telemetry.recordCallMetrics).toHaveBeenCalledWith(expect.objectContaining({ costUsd: amount, statusCode: 502 }));
  });

  it.each(['rejected', 'unavailable'] as const)('keeps call metrics but never writes a placeholder when projection is %s', async failure => {
    const { pipeline, mocks, pricing, params } = projectedLogging();
    if (failure === 'rejected') pricing.persistCallLogs.mockRejectedValueOnce(new Error('synthetic persistence failure'));
    else pricing.persistCallLogs.mockResolvedValueOnce(null);
    await expect(pipeline.logCall(params)).resolves.toBeUndefined();
    expect(pricing.logSummary).toHaveBeenCalledTimes(1);
    expect(mocks.telemetry.recordCallMetrics).toHaveBeenCalledTimes(1);
    expect(mocks.telemetry.recordCallMetrics).toHaveBeenCalledWith(expect.objectContaining({ costUsd: 0.0003 }));
    expect(mocks.callLogRepo.save).not.toHaveBeenCalled();
    expect(mocks.logEventBus.emit).not.toHaveBeenCalled();
  });

  it('retains call-count metrics when a routing observer fails before log persistence', async () => {
    const { pipeline, mocks, pricing, params } = projectedLogging();
    mocks.routingService.recordTargetUsage = jest.fn(() => { throw new Error('synthetic observer failure'); });
    await expect(pipeline.logCall(params)).resolves.toBeUndefined();
    expect(pricing.persistCallLogs).not.toHaveBeenCalled();
    expect(pricing.logSummary).toHaveBeenCalledTimes(1);
    expect(mocks.telemetry.recordCallMetrics).toHaveBeenCalledTimes(1);
  });

  it.each(['publisher', 'telemetry'] as const)('never emits a second metric when the %s throws after persistence', async failure => {
    const { pipeline, mocks, pricing, params } = projectedLogging();
    const fault = () => { throw new Error('synthetic post-persistence failure'); };
    if (failure === 'publisher') mocks.logEventBus.emit.mockImplementation(fault);
    else mocks.telemetry.recordCallMetrics.mockImplementation(fault);
    await expect(pipeline.logCall(params)).resolves.toBeUndefined();
    expect(pricing.persistCallLogs).toHaveBeenCalledTimes(1);
    expect(pricing.logSummary).not.toHaveBeenCalled();
    expect(mocks.telemetry.recordCallMetrics).toHaveBeenCalledTimes(1);
  });

  it('does not dispatch another provider call when fallback summary and telemetry are unavailable', async () => {
    const { pipeline, mocks, pricing, params } = projectedLogging();
    pricing.persistCallLogs.mockRejectedValueOnce(new Error('synthetic save failure'));
    pricing.logSummary.mockRejectedValueOnce(new Error('synthetic read failure'));
    await expect(pipeline.logCall(params)).resolves.toBeUndefined();
    expect(mocks.providerClient.forward).not.toHaveBeenCalled();
    expect(mocks.telemetry.recordCallMetrics).not.toHaveBeenCalled();
    expect(mocks.callLogRepo.save).not.toHaveBeenCalled();
  });

  it.each(['sqlite', 'unowned'] as const)('keeps the preliminary summary for the %s path', async mode => {
    const { pipeline, mocks, pricing, params } = projectedLogging({ type: mode === 'sqlite' ? 'sqlite' : 'postgres', path: ':memory:' }, mode !== 'unowned');
    await pipeline.logCall(params);
    expect(pricing.logSummary).toHaveBeenCalledTimes(1);
    expect(pricing.persistCallLogs).toHaveBeenCalledWith(expect.any(Array));
    expect(mocks.telemetry.recordCallMetrics).toHaveBeenCalledWith(expect.objectContaining({ costUsd: 0.0003 }));
  });

  it('publishes the known cost before SQLite write-behind rather than a projection placeholder', async () => {
    const { pipeline, mocks, pricing, params } = projectedLogging({ type: 'sqlite', path: '/synthetic/not-opened.sqlite' });
    const queued: CallLog[] = [];
    jest.spyOn(pipeline as unknown as { enqueueCallLogWrite(log: CallLog): void }, 'enqueueCallLogWrite').mockImplementation(log => { queued.push(log); });
    await pipeline.logCall(params);
    expect(queued).toHaveLength(1); expect(queued[0].cost_usd).toBe(0.0003);
    expect(pricing.logSummary).toHaveBeenCalledTimes(1);
    expect(pricing.persistCallLogs).not.toHaveBeenCalled();
    expect(mocks.telemetry.recordCallMetrics).toHaveBeenCalledTimes(1);
  });

  it('should log successful calls', async () => {
    const { pipeline, mocks } = makePipeline();
    const request = makeRequest('Hello', { originalModel: 'gpt-4o' });

    await pipeline.process(request);

    expect(mocks.callLogRepo.save).toHaveBeenCalled();
    expect(mocks.logEventBus.emit).toHaveBeenCalled();
  });

  it('should log failed calls', async () => {
    const { pipeline, mocks } = makePipeline();
    mocks.providerClient.forward.mockRejectedValue(
      new ProviderError('Server Error', 400, 'openai'),
    );

    const request = makeRequest('Hello', { originalModel: 'gpt-4o' });
    await pipeline.process(request);

    expect(mocks.callLogRepo.save).toHaveBeenCalled();
    const savedLog = mocks.callLogRepo.create.mock.calls[0][0];
    expect(savedLog.error).toBeTruthy();
    expect(savedLog.status_code).not.toBe(200);
  });

  it('should not throw if logging fails', async () => {
    const { pipeline } = makePipeline({
      callLogRepo: {
        create: jest.fn().mockImplementation((data: any) => data),
        save: jest.fn().mockRejectedValue(new Error('DB write failed')),
      },
    });

    const request = makeRequest('Hello', { originalModel: 'gpt-4o' });
    // Should not throw
    const result = await pipeline.process(request);
    expect(result.statusCode).toBe(200);
  });

  it('should record business metrics from the call log path without API key labels', async () => {
    const telemetry = new TelemetryService();
    jest.spyOn(telemetry, 'recordCallMetrics');
    const { pipeline, mocks } = makePipeline({ telemetry });
    const request = makeRequest('Hello', { originalModel: 'gpt-4o' });
    request.metadata.api_key_name = 'production-key';
    request.metadata.api_key_id = 'key_secret_123';

    await pipeline.process(request);

    expect(mocks.telemetry.recordCallMetrics).toHaveBeenCalledWith(
      expect.objectContaining({
        tier: 'direct',
        node: 'openai',
        model: 'gpt-4o',
        statusCode: 200,
        inputTokens: 10,
        outputTokens: 5,
        isFallback: false,
      }),
    );
    const metricInput = mocks.telemetry.recordCallMetrics.mock.calls[0][0];
    expect(Object.keys(metricInput)).not.toContain('apiKeyName');
    expect(Object.values(metricInput)).not.toContain('production-key');
    expect(Object.values(metricInput)).not.toContain('key_secret_123');
  });

  it('should persist normalized client source in call logs', async () => {
    const { pipeline, mocks } = makePipeline();
    const request = makeRequest('Hello', { originalModel: 'gpt-4o' });
    request.metadata.client_source = 'curl';
    request.metadata.raw_headers = { 'user-agent': 'curl/8.4.0' };

    await pipeline.process(request);

    const savedLog = mocks.callLogRepo.create.mock.calls[0][0];
    expect(savedLog.client_source).toBe('curl');
    expect(savedLog).not.toHaveProperty('raw_headers');
    expect(JSON.stringify(savedLog)).not.toContain('curl/8.4.0');
  });

  it('should prefer agent connector over generic user-agent source', async () => {
    const { pipeline, mocks } = makePipeline();
    const request = makeRequest('Hello', { originalModel: 'gpt-4o' });
    request.metadata.client_source = 'http_client';
    request.metadata.agent_connector = 'claude_code';

    await pipeline.process(request);

    const savedLog = mocks.callLogRepo.create.mock.calls[0][0];
    expect(savedLog.client_source).toBe('claude_code');
  });

  it('should mark fallback responses in business metrics', async () => {
    const telemetry = new TelemetryService();
    jest.spyOn(telemetry, 'recordCallMetrics');
    const { pipeline, mocks } = makePipeline({ telemetry });
    mocks.providerClient.forward
      .mockRejectedValueOnce(new ProviderError('Rate limited', 429, 'openai'))
      .mockRejectedValueOnce(new ProviderError('Rate limited', 429, 'openai'))
      .mockRejectedValueOnce(new ProviderError('Rate limited', 429, 'openai'))
      .mockResolvedValueOnce(makeCanonicalResponse({ model: 'claude-3-opus' }));

    await pipeline.process(makeRequest('Hello', { originalModel: 'auto' }));

    expect(mocks.telemetry.recordCallMetrics).toHaveBeenCalledWith(
      expect.objectContaining({
        node: 'claude',
        model: 'claude-3-opus',
        statusCode: 200,
        isFallback: true,
      }),
    );
  });

  it('should attribute experiment group to the actual fallback target', async () => {
    const { pipeline, mocks } = makePipeline({
      routingService: {
        resolve: jest.fn().mockReturnValue({
          primary: { node: 'openai', model: 'gpt-4o' },
          fallbacks: [{ node: 'claude', model: 'claude-3-opus' }],
          tier: 'standard',
          momentumAdjusted: false,
          experimentGroup: 'standard:control',
          experimentGroupsByTarget: {
            'openai:gpt-4o': 'standard:control',
            'claude:claude-3-opus': 'standard:challenger',
          },
        }),
      },
    });
    mocks.providerClient.forward
      .mockRejectedValueOnce(new ProviderError('Rate limited', 429, 'openai'))
      .mockRejectedValueOnce(new ProviderError('Rate limited', 429, 'openai'))
      .mockRejectedValueOnce(new ProviderError('Rate limited', 429, 'openai'))
      .mockResolvedValueOnce(makeCanonicalResponse({ model: 'claude-3-opus' }));

    const request = makeRequest('Hello', { originalModel: 'auto' });
    await pipeline.process(request);

    const savedLog = mocks.callLogRepo.create.mock.calls[0][0];
    expect(savedLog.experiment_group).toBe('standard:challenger');
  });
});

// ═══════════════════════════════════════════════════════════
// Plugin Hooks
// ═══════════════════════════════════════════════════════════

describe('PipelineService — plugin hooks', () => {
  it('should execute preUpstream hooks before forwarding', async () => {
    const hooks = {
      isEmpty: jest.fn().mockReturnValue(false),
      run: jest.fn().mockImplementation(async (hookName: string, data: Record<string, unknown>) => {
        if (hookName === 'preRequest') {
          return { data };
        }
        if (hookName === 'preUpstream') {
          return {
            data: {
              ...data,
              request: {
                ...(data.request as Record<string, unknown>),
                messages: [{ role: 'user', content: 'Redacted prompt' }],
              },
            },
          };
        }
        return { data };
      }),
    };

    const { pipeline, mocks } = makePipeline({ hooks });
    const request = makeRequest('Sensitive prompt', { originalModel: 'gpt-4o' });
    await pipeline.process(request);

    expect(mocks.providerClient.forward).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [{ role: 'user', content: 'Redacted prompt' }],
      }),
      'openai',
      'gpt-4o',
      expect.any(Object),
    );
  });

  it('should recover from pipeline errors via onError hook', async () => {
    const recovered = makeCanonicalResponse({
      id: 'recovered',
      model: 'gpt-4o',
      content: [{ type: 'text', text: 'Recovered response' }],
    });
    const hooks = {
      isEmpty: jest.fn().mockReturnValue(false),
      run: jest.fn().mockImplementation(async (hookName: string, data: Record<string, unknown>) => {
        if (hookName === 'preRequest') {
          return { data };
        }
        if (hookName === 'onError') {
          return { shortCircuit: recovered };
        }
        return { data };
      }),
    };

    const { pipeline, mocks } = makePipeline({
      hooks,
      providerClient: {
        forward: jest.fn().mockRejectedValue(new Error('upstream exploded')),
        forwardStream: jest.fn(),
      },
    });

    const request = makeRequest('Hello', { originalModel: 'gpt-4o' });
    const result = await pipeline.process(request);

    expect(result.statusCode).toBe(200);
    expect(result.body).toEqual(
      expect.objectContaining({
        choices: expect.any(Array),
      }),
    );
    expect(mocks.budgetService.record).toHaveBeenCalledWith(
      expect.any(Number),
      expect.any(Number),
      undefined,
    );
    expect(mocks.callLogRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        node_id: 'hook',
        model: 'gpt-4o',
        status_code: 200,
        error: null,
      }),
    );
  });
});

// ═══════════════════════════════════════════════════════════
// Native Messages Pinning
// ═══════════════════════════════════════════════════════════

describe('PipelineService — messages pinning', () => {
  it('should pin messages-format requests with Claude user-agent to claude node', async () => {
    const { pipeline, mocks } = makePipeline({
      config: {
        getNode: jest.fn().mockImplementation((id: string) => {
          if (id === 'claude') return {
            id: 'claude', name: 'Claude', protocol: 'messages',
            models: ['claude-3-opus'], model_aliases: {},
          };
          return undefined;
        }),
      },
    });

    const request = makeRequest('Hello', { originalModel: 'auto' });
    request.metadata.source_format = 'messages';
    request.metadata.raw_headers = { 'user-agent': 'Claude-Code/1.0' };

    await pipeline.process(request);

    expect(mocks.providerClient.forward).toHaveBeenCalledWith(
      request, 'claude', 'claude-3-opus',
      expect.objectContaining({ tier: 'direct' }),
    );
  });
});

// ═══════════════════════════════════════════════════════════
// processStream
// ═══════════════════════════════════════════════════════════

function mockResponse(): any {
  const chunks: string[] = [];
  const listeners = new Map<string, Function[]>();
  const response: any = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
    setHeader: jest.fn(),
    flushHeaders: jest.fn(),
    write: jest.fn((chunk: string) => {
      chunks.push(chunk);
      return true;
    }),
    end: jest.fn(() => {
      response.writableEnded = true;
      response.emit('close');
    }),
    on: jest.fn((event: string, listener: Function) => {
      listeners.set(event, [...(listeners.get(event) || []), listener]);
      return response;
    }),
    once: jest.fn((event: string, listener: Function) => {
      const onceListener = (...args: unknown[]) => {
        response.off(event, onceListener);
        listener(...args);
      };
      listeners.set(event, [...(listeners.get(event) || []), onceListener]);
      return response;
    }),
    off: jest.fn((event: string, listener: Function) => {
      listeners.set(
        event,
        (listeners.get(event) || []).filter((item) => item !== listener),
      );
      return response;
    }),
    emit: jest.fn((event: string, ...args: unknown[]) => {
      for (const listener of listeners.get(event) || []) {
        listener(...args);
      }
      return true;
    }),
    headersSent: false,
    writableEnded: false,
    _chunks: chunks,
  };
  return response;
}

describe('PipelineService — processStream', () => {
  it('should return 429 when budget exceeded in stream mode', async () => {
    const { pipeline } = makePipeline({
      budgetService: {
        check: jest.fn().mockRejectedValue(new BudgetExceededError('tokens', 1_500_000, 1_000_000)),
        record: jest.fn(),
        getStatus: jest.fn(),
      },
    });

    const request = makeRequest('Hello');
    request.stream = true;
    const res = mockResponse();

    await pipeline.processStream(request, res);

    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalled();
  });

  it('should replay cached response as synthetic SSE stream', async () => {
    const cachedResponse = makeCanonicalResponse({
      id: 'cached-1',
      model: 'gpt-4o',
      content: [{ type: 'text', text: 'Cached answer' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const { pipeline } = makePipeline({
      cacheService: {
        shouldCache: jest.fn().mockReturnValue(true),
        shouldCacheStream: jest.fn().mockReturnValue(true),
        lookup: jest.fn().mockReturnValue(cachedResponse),
        store: jest.fn(),
      },
    });

    const request = makeRequest('Hello', { originalModel: 'gpt-4o' });
    request.stream = true;
    const res = mockResponse();

    await pipeline.processStream(request, res);

    // Should set SSE headers
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
    expect(res.flushHeaders).toHaveBeenCalled();
    // Should write start + delta + stop events
    expect(res.write).toHaveBeenCalled();
    expect(res.end).toHaveBeenCalled();
    // Should NOT call provider
    expect(res._chunks.length).toBeGreaterThanOrEqual(2);
  });

  it('should not use prompt cache for streams unless stream cache is enabled', async () => {
    async function* mockStream() {
      yield { type: 'start' as const, id: 'live-1', model: 'gpt-4o' };
      yield { type: 'delta' as const, content: { type: 'text' as const, text: 'Live' } };
      yield { type: 'stop' as const, stop_reason: 'end_turn', usage: { input_tokens: 2, output_tokens: 1 } };
    }
    const cachedResponse = makeCanonicalResponse({
      content: [{ type: 'text', text: 'Cached answer' }],
    });
    const { pipeline, mocks } = makePipeline({
      providerClient: {
        forward: jest.fn(),
        forwardStream: jest.fn().mockReturnValue(mockStream()),
      },
      cacheService: {
        shouldCache: jest.fn().mockReturnValue(true),
        shouldCacheStream: jest.fn().mockReturnValue(false),
        lookup: jest.fn().mockReturnValue(cachedResponse),
        store: jest.fn(),
      },
    });

    const request = makeRequest('Hello', { originalModel: 'gpt-4o' });
    request.stream = true;
    const res = mockResponse();

    await pipeline.processStream(request, res);

    expect(mocks.cacheService.lookup).not.toHaveBeenCalled();
    expect(mocks.cacheService.store).not.toHaveBeenCalled();
    expect(mocks.providerClient.forwardStream).toHaveBeenCalled();
    expect(res._chunks.join('')).toContain('Live');
  });

  it('should stream events from provider to response', async () => {
    async function* mockStream() {
      yield { type: 'start' as const, id: 'stream-1', model: 'gpt-4o' };
      yield { type: 'delta' as const, content: { type: 'text' as const, text: 'Hello' } };
      yield { type: 'stop' as const, stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } };
    }

    const { pipeline, mocks } = makePipeline({
      providerClient: {
        forward: jest.fn(),
        forwardStream: jest.fn().mockReturnValue(mockStream()),
      },
    });

    const request = makeRequest('Hello', { originalModel: 'gpt-4o' });
    request.stream = true;
    const res = mockResponse();

    await pipeline.processStream(request, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
    expect(res.write).toHaveBeenCalled();
    expect(res.end).toHaveBeenCalled();
    expect(mocks.circuitBreaker.recordSuccess).toHaveBeenCalled();
    expect(mocks.logEventBus.emitActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: 'streaming',
        estimated_usage: true,
        input_tokens: expect.any(Number),
        output_tokens: expect.any(Number),
      }),
    );
    expect(mocks.logEventBus.emitActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: 'streaming',
        first_token_latency_ms: expect.any(Number),
        tokens_per_second: expect.any(Number),
      }),
    );
    expect(mocks.logEventBus.emit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        firstTokenLatencyMs: expect.any(Number),
      }),
    );
    const reservation = await reservedBudgetAt(mocks);
    expect(reservation.commit).toHaveBeenCalledWith(15, expect.any(Number));
    expect(mocks.budgetService.record).not.toHaveBeenCalled();
  });

  it('should wait for response drain when stream backpressure is applied', async () => {
    async function* mockStream() {
      yield { type: 'start' as const, id: 'stream-1', model: 'gpt-4o' };
      yield { type: 'delta' as const, content: { type: 'text' as const, text: 'Hello' } };
      yield { type: 'stop' as const, stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } };
    }
    const { pipeline } = makePipeline({
      providerClient: {
        forward: jest.fn(),
        forwardStream: jest.fn().mockReturnValue(mockStream()),
      },
    });
    const request = makeRequest('Hello', { originalModel: 'gpt-4o' });
    request.stream = true;
    const res = mockResponse();
    let writes = 0;
    res.write.mockImplementation((chunk: string) => {
      res._chunks.push(chunk);
      writes += 1;
      if (writes === 1) {
        setImmediate(() => res.emit('drain'));
        return false;
      }
      return true;
    });

    await pipeline.processStream(request, res);

    expect(res.once).toHaveBeenCalledWith('drain', expect.any(Function));
    expect(res.end).toHaveBeenCalled();
  });

  it('does not write another stream event when post-response budget accounting fails', async () => {
    async function* mockStream() {
      yield { type: 'start' as const, id: 'stream-1', model: 'gpt-4o' };
      yield { type: 'delta' as const, content: { type: 'text' as const, text: 'Hello' } };
      yield { type: 'stop' as const, stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } };
    }
    const reservation = makeBudgetReservation();
    reservation.commit.mockRejectedValueOnce(new Error('budget store unavailable'));
    const { pipeline, mocks } = makePipeline({
      providerClient: {
        forward: jest.fn(),
        forwardStream: jest.fn().mockReturnValue(mockStream()),
      },
      budgetService: {
        reserve: jest.fn().mockResolvedValue(reservation),
      },
    });
    const request = makeRequest('Hello', { originalModel: 'gpt-4o' });
    request.stream = true;
    const res = mockResponse();
    let wroteAfterEnd = false;
    res.write.mockImplementation((chunk: string) => {
      if (res.writableEnded) wroteAfterEnd = true;
      res._chunks.push(chunk);
      return true;
    });

    await pipeline.processStream(request, res);

    expect(res.end).toHaveBeenCalledTimes(1);
    expect(wroteAfterEnd).toBe(false);
    expect(mocks.circuitBreaker.recordFailure).not.toHaveBeenCalled();
    expect(reservation.release).toHaveBeenCalledTimes(1);
  });

  it('should write native Responses raw SSE without reconstructing function call events', async () => {
    const upstreamSse =
      'event: response.output_item.added\n' +
      'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"edit_file","arguments":"","status":"in_progress"}}\n\n' +
      'event: response.function_call_arguments.delta\n' +
      'data: {"type":"response.function_call_arguments.delta","output_index":0,"item_id":"fc_1","call_id":"call_1","delta":"{\\"path\\":\\"a.ts\\"}"}\n\n' +
      'event: response.function_call_arguments.done\n' +
      'data: {"type":"response.function_call_arguments.done","output_index":0,"item_id":"fc_1","call_id":"call_1","arguments":"{\\"path\\":\\"a.ts\\"}"}\n\n' +
      'event: response.output_item.done\n' +
      'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"edit_file","arguments":"{\\"path\\":\\"a.ts\\"}","status":"completed"}}\n\n' +
      'event: response.completed\n' +
      'data: {"type":"response.completed","response":{"id":"resp_1","model":"gpt-5.5","status":"completed","usage":{"input_tokens":12,"output_tokens":7}}}\n\n';
    async function* mockStream() {
      yield {
        type: 'raw_sse' as const,
        text: upstreamSse,
        events: [
          { type: 'start' as const, id: 'resp_1', model: 'gpt-5.5' },
          {
            type: 'stop' as const,
            stop_reason: 'end_turn',
            usage: { input_tokens: 12, output_tokens: 7 },
          },
        ],
      };
    }
    const hooks = {
      isEmpty: jest.fn().mockReturnValue(false),
      run: jest.fn(async (_hookName: string, data: any) => ({ data })),
    };
    const { pipeline, mocks } = makePipeline({
      hooks,
      providerClient: {
        forward: jest.fn(),
        forwardStream: jest.fn().mockReturnValue(mockStream()),
      },
    });

    const request = makeRequest('Use a tool', { originalModel: 'gpt-4o' });
    request.stream = true;
    request.metadata.source_format = 'responses';
    request.metadata.raw_body = { model: 'gpt-4o', stream: true, input: 'Use a tool' };
    const res = mockResponse();

    await pipeline.processStream(request, res);

    const allChunks = res._chunks.join('');
    expect(allChunks).toBe(upstreamSse);
    expect(allChunks).toContain('event: response.function_call_arguments.done');
    expect(allChunks).toContain('"output_index":0');
    expect(allChunks).not.toContain('event: response.content_part.added');
    expect(hooks.run).not.toHaveBeenCalledWith(
      'streamEvent',
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    const reservation = await reservedBudgetAt(mocks);
    expect(reservation.commit).toHaveBeenCalledWith(19, expect.any(Number));
    expect(mocks.budgetService.record).not.toHaveBeenCalled();
    const savedLog = mocks.callLogRepo.create.mock.calls[0][0];
    expect(savedLog.input_tokens).toBe(12);
    expect(savedLog.output_tokens).toBe(7);
  });

  it('should write split native Responses raw SSE chunks unchanged', async () => {
    const chunkA =
      'event: response.output_text.delta\n' +
      'data: {"type":"response.output_text.delta","delta":"hel';
    const chunkB =
      'lo"}\n\n' +
      'event: response.completed\n' +
      'data: {"type":"response.completed","response":{"id":"resp_1","model":"gpt-5.5","status":"completed","usage":{"input_tokens":3,"output_tokens":1}}}\n\n';
    async function* mockStream() {
      yield {
        type: 'raw_sse' as const,
        text: chunkA,
        events: [],
      };
      yield {
        type: 'raw_sse' as const,
        text: chunkB,
        events: [
          { type: 'delta' as const, content: { type: 'text' as const, text: 'hello' } },
          {
            type: 'stop' as const,
            stop_reason: 'end_turn',
            usage: { input_tokens: 3, output_tokens: 1 },
          },
        ],
      };
    }
    const hooks = {
      isEmpty: jest.fn().mockReturnValue(false),
      run: jest.fn(async (_hookName: string, data: any) => ({ data })),
    };
    const { pipeline, mocks } = makePipeline({
      hooks,
      providerClient: {
        forward: jest.fn(),
        forwardStream: jest.fn().mockReturnValue(mockStream()),
      },
    });

    const request = makeRequest('Say hello', { originalModel: 'gpt-5.5' });
    request.stream = true;
    request.metadata.source_format = 'responses';
    request.metadata.raw_body = { model: 'gpt-5.5', stream: true, input: 'Say hello' };
    const res = mockResponse();

    await pipeline.processStream(request, res);

    expect(res._chunks).toEqual([chunkA, chunkB]);
    expect(res._chunks.join('')).toBe(chunkA + chunkB);
    expect(hooks.run).not.toHaveBeenCalledWith(
      'streamEvent',
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    const reservation = await reservedBudgetAt(mocks);
    expect(reservation.commit).toHaveBeenCalledWith(4, expect.any(Number));
    expect(mocks.budgetService.record).not.toHaveBeenCalled();
  });

  it('should record native Responses stream failure events as upstream failures', async () => {
    const upstreamSse =
      'event: response.created\n' +
      'data: {"type":"response.created","response":{"id":"resp_fail","model":"gpt-5.5","status":"in_progress"}}\n\n' +
      'event: response.failed\n' +
      'data: {"type":"response.failed","response":{"id":"resp_fail","model":"gpt-5.5","status":"failed","error":{"message":"The system is currently experiencing high demand","code":"no_capacity","type":"too_many_requests","status_code":429}}}\n\n';
    async function* mockStream() {
      yield {
        type: 'raw_sse' as const,
        text: upstreamSse,
        events: [
          { type: 'start' as const, id: 'resp_fail', model: 'gpt-5.5' },
          {
            type: 'error' as const,
            error: {
              message: 'The system is currently experiencing high demand',
              code: 'no_capacity',
              type: 'too_many_requests',
              status_code: 429,
            },
          },
        ],
      };
    }
    const { pipeline, mocks } = makePipeline({
      providerClient: {
        forward: jest.fn(),
        forwardStream: jest.fn().mockReturnValue(mockStream()),
      },
    });

    const request = makeRequest('Say hello', { originalModel: 'gpt-5.5' });
    request.stream = true;
    request.metadata.source_format = 'responses';
    request.metadata.raw_body = { model: 'gpt-5.5', stream: true, input: 'Say hello' };
    const res = mockResponse();

    await pipeline.processStream(request, res);

    expect(res._chunks.join('')).toBe(upstreamSse);
    expect(mocks.circuitBreaker.recordFailure).toHaveBeenCalledWith(
      'openai',
      'gpt-4o',
    );
    expect(mocks.circuitBreaker.recordSuccess).not.toHaveBeenCalled();
    expect(mocks.routingService.recordTargetResult).toHaveBeenCalledWith(
      'openai',
      'gpt-4o',
      expect.any(Number),
      429,
    );
    const savedLog = mocks.callLogRepo.create.mock.calls[0][0];
    expect(savedLog.status_code).toBe(429);
    expect(savedLog.error).toContain('high demand');
    expect(savedLog.error).toContain('no_capacity');
  });

  it('should write native Messages raw SSE without reconstructing Anthropic events', async () => {
    const upstreamSse =
      'event: message_start\n' +
      'data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-sonnet-4","content":[],"stop_reason":null,"usage":{"input_tokens":8,"output_tokens":1}}}\n\n' +
      'event: content_block_start\n' +
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"read_file","input":{}}}\n\n' +
      'event: content_block_delta\n' +
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"a.ts\\"}"}}\n\n' +
      'event: content_block_stop\n' +
      'data: {"type":"content_block_stop","index":0}\n\n' +
      'event: message_delta\n' +
      'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":5}}\n\n' +
      'event: message_stop\n' +
      'data: {"type":"message_stop"}\n\n';
    async function* mockStream() {
      yield {
        type: 'raw_sse' as const,
        text: upstreamSse,
        events: [
          { type: 'start' as const, id: 'msg_1', model: 'claude-sonnet-4' },
          {
            type: 'stop' as const,
            stop_reason: 'tool_use',
            usage: { input_tokens: 8, output_tokens: 5 },
          },
        ],
      };
    }
    const hooks = {
      isEmpty: jest.fn().mockReturnValue(false),
      run: jest.fn(async (_hookName: string, data: any) => ({ data })),
    };
    const { pipeline, mocks } = makePipeline({
      hooks,
      providerClient: {
        forward: jest.fn(),
        forwardStream: jest.fn().mockReturnValue(mockStream()),
      },
    });

    const request = makeRequest('Use a tool', { originalModel: 'claude-sonnet-4' });
    request.stream = true;
    request.metadata.source_format = 'messages';
    request.metadata.raw_body = {
      model: 'claude-sonnet-4',
      stream: true,
      messages: [{ role: 'user', content: 'Use a tool' }],
      max_tokens: 100,
    };
    const res = mockResponse();

    await pipeline.processStream(request, res);

    const allChunks = res._chunks.join('');
    expect(allChunks).toBe(upstreamSse);
    expect(allChunks).toContain('event: content_block_start');
    expect(allChunks).toContain('"type":"tool_use"');
    expect(allChunks).not.toContain('event: response.output_item.added');
    expect(hooks.run).not.toHaveBeenCalledWith(
      'streamEvent',
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    const reservation = await reservedBudgetAt(mocks);
    expect(reservation.commit).toHaveBeenCalledWith(13, expect.any(Number));
    expect(mocks.budgetService.record).not.toHaveBeenCalled();
    const savedLog = mocks.callLogRepo.create.mock.calls[0][0];
    expect(savedLog.input_tokens).toBe(8);
    expect(savedLog.output_tokens).toBe(5);
  });

  it('should release the concurrency slot after stream completion', async () => {
    const release = jest.fn();
    async function* mockStream() {
      yield { type: 'start' as const, id: 'stream-release', model: 'gpt-4o' };
      yield { type: 'stop' as const, stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } };
    }

    const { pipeline } = makePipeline({
      concurrencyLimiter: {
        acquire: jest.fn().mockResolvedValue({ release }),
      },
      providerClient: {
        forward: jest.fn(),
        forwardStream: jest.fn().mockReturnValue(mockStream()),
      },
    });

    const request = makeRequest('Hello', { originalModel: 'gpt-4o' });
    request.stream = true;
    const res = mockResponse();

    await pipeline.processStream(request, res);

    expect(release).toHaveBeenCalledTimes(1);
  });

  it('should try fallback in stream mode when primary connection fails', async () => {
    let callCount = 0;
    async function* fallbackStream() {
      yield { type: 'start' as const, id: 'fb-1', model: 'claude-3-opus' };
      yield { type: 'stop' as const, stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 3 } };
    }

    const { pipeline, mocks } = makePipeline({
      providerClient: {
        forward: jest.fn(),
        forwardStream: jest.fn().mockImplementation(() => {
          callCount++;
          if (callCount <= 3) throw new ProviderError('Connection refused', 502, 'openai');
          return fallbackStream();
        }),
      },
    });

    const request = makeRequest('Hello', { originalModel: 'auto' });
    request.stream = true;
    const res = mockResponse();

    await pipeline.processStream(request, res);

    expect(res.end).toHaveBeenCalled();
    // After primary exhausts retries (3 attempts for 502), recordFailure is called
    expect(mocks.circuitBreaker.recordFailure).toHaveBeenCalled();
  });

  it('should try fallback when primary stream generator fails before first event', async () => {
    async function* failingBeforeFirstEvent() {
      throw new ProviderError('Reader failed before first event', 502, 'openai');
    }
    async function* fallbackStream() {
      yield { type: 'start' as const, id: 'fb-async-read', model: 'claude-3-opus' };
      yield { type: 'delta' as const, content: { type: 'text' as const, text: 'Fallback live' } };
      yield { type: 'stop' as const, stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 3 } };
    }

    const { pipeline, mocks } = makePipeline({
      providerClient: {
        forward: jest.fn(),
        forwardStream: jest.fn().mockImplementation((_canonical, nodeId: string) => {
          if (nodeId === 'openai') return failingBeforeFirstEvent();
          return fallbackStream();
        }),
      },
    });

    const request = makeRequest('Hello', { originalModel: 'auto' });
    request.stream = true;
    const res = mockResponse();

    await pipeline.processStream(request, res);

    expect(mocks.providerClient.forwardStream).toHaveBeenCalledWith(
      expect.any(Object),
      'claude',
      'claude-3-opus',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(res._chunks.join('')).toContain('Fallback live');
    expect(mocks.circuitBreaker.recordFailure).toHaveBeenCalledWith('openai', 'gpt-4o');
  });

  it('should try fallback in stream mode when primary is saturated', async () => {
    async function* fallbackStream() {
      yield { type: 'start' as const, id: 'fb-limiter', model: 'claude-3-opus' };
      yield { type: 'stop' as const, stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 3 } };
    }

    const { pipeline, mocks } = makePipeline({
      concurrencyLimiter: {
        acquire: jest.fn().mockImplementation((node: { id: string }, model: string) => {
          if (node.id === 'openai') {
            throw new ConcurrencyLimitError(
              'openai saturated',
              node.id,
              model,
              503,
              'fallback',
              true,
            );
          }
          return Promise.resolve({ release: jest.fn() });
        }),
      },
      providerClient: {
        forward: jest.fn(),
        forwardStream: jest.fn().mockReturnValue(fallbackStream()),
      },
    });

    const request = makeRequest('Hello', { originalModel: 'auto' });
    request.stream = true;
    const res = mockResponse();

    await pipeline.processStream(request, res);

    expect(res.end).toHaveBeenCalled();
    expect(mocks.providerClient.forwardStream).toHaveBeenCalledWith(
      expect.any(Object),
      'claude',
      'claude-3-opus',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(mocks.circuitBreaker.recordFailure).not.toHaveBeenCalledWith('openai', 'gpt-4o');
  });

  it('should send error event when all stream nodes fail', async () => {
    const { pipeline } = makePipeline({
      providerClient: {
        forward: jest.fn(),
        forwardStream: jest.fn().mockImplementation(() => {
          throw new ProviderError('Server Error', 500, 'openai');
        }),
      },
    });

    const request = makeRequest('Hello', { originalModel: 'auto' });
    request.stream = true;
    const res = mockResponse();

    await pipeline.processStream(request, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalled();
    expect(res.write).not.toHaveBeenCalled();
  });

  it('should store stream result in cache when caching enabled', async () => {
    async function* mockStream() {
      yield { type: 'start' as const, id: 'cache-stream', model: 'gpt-4o' };
      yield { type: 'delta' as const, content: { type: 'text' as const, text: 'Cached ' } };
      yield { type: 'delta' as const, content: { type: 'text' as const, text: 'text' } };
      yield { type: 'stop' as const, stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 3 } };
    }

    const { pipeline, mocks } = makePipeline({
      providerClient: {
        forward: jest.fn(),
        forwardStream: jest.fn().mockReturnValue(mockStream()),
      },
      cacheService: {
        shouldCache: jest.fn().mockReturnValue(true),
        shouldCacheStream: jest.fn().mockReturnValue(true),
        lookup: jest.fn().mockReturnValue(null),
        store: jest.fn(),
      },
    });

    const request = makeRequest('Hello', { originalModel: 'gpt-4o' });
    request.stream = true;
    const res = mockResponse();

    await pipeline.processStream(request, res);

    expect(mocks.cacheService.store).toHaveBeenCalledWith(
      request,
      expect.objectContaining({
        content: [{ type: 'text', text: 'Cached text' }],
      }),
    );
  });

  it('should not cache partial streams when the client disconnects', async () => {
    async function* cancellableStream(
      _request: any,
      _nodeId: string,
      _model: string,
      options: { signal?: AbortSignal },
    ) {
      yield { type: 'start' as const, id: 'cancel-stream', model: 'gpt-4o' };
      if (options.signal?.aborted) {
        throw new Error('aborted');
      }
      await new Promise((_resolve, reject) => {
        options.signal?.addEventListener(
          'abort',
          () => reject(new Error('aborted')),
          { once: true },
        );
      });
    }

    const { pipeline, mocks } = makePipeline({
      providerClient: {
        forward: jest.fn(),
        forwardStream: jest.fn().mockImplementation(cancellableStream),
      },
      cacheService: {
        shouldCache: jest.fn().mockReturnValue(true),
        shouldCacheStream: jest.fn().mockReturnValue(true),
        lookup: jest.fn().mockReturnValue(null),
        store: jest.fn(),
      },
    });

    const request = makeRequest('Hello', { originalModel: 'gpt-4o' });
    request.stream = true;
    const res = mockResponse();
    res.write.mockImplementation((chunk: string) => {
      res._chunks.push(chunk);
      res.emit('close');
      return true;
    });

    await pipeline.processStream(request, res);

    expect(mocks.cacheService.store).not.toHaveBeenCalled();
    expect(mocks.callLogRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ status_code: 499 }),
    );
    const reservation = await reservedBudgetAt(mocks);
    expect(reservation.release).toHaveBeenCalled();
    expect(reservation.commit).not.toHaveBeenCalled();
  });

  it('should drain briefly and capture usage after a completed tool call disconnect', async () => {
    async function* toolCallStream() {
      yield {
        type: 'raw_sse' as const,
        text:
          'event: response.output_item.done\n' +
          'data: {"item":{"type":"function_call","call_id":"call_1","status":"completed"}}\n\n',
        events: [
          {
            type: 'tool_call_complete' as const,
            id: 'call_1',
            tool_type: 'function_call',
          },
        ],
      };
      await new Promise((resolve) => setTimeout(resolve, 10));
      yield {
        type: 'raw_sse' as const,
        text:
          'event: response.completed\n' +
          'data: {"response":{"status":"completed","usage":{"input_tokens":42,"output_tokens":7}}}\n\n',
        events: [
          {
            type: 'stop' as const,
            stop_reason: 'end_turn',
            usage: { input_tokens: 42, output_tokens: 7 },
          },
        ],
      };
    }

    const { pipeline, mocks } = makePipeline({
      providerClient: {
        forward: jest.fn(),
        forwardStream: jest.fn().mockReturnValue(toolCallStream()),
      },
    });
    const request = makeRequest('Use a tool', { originalModel: 'gpt-4o' });
    request.stream = true;
    request.metadata.source_format = 'responses';
    const res = mockResponse();
    res.write.mockImplementation((chunk: string) => {
      res._chunks.push(chunk);
      res.emit('close');
      return true;
    });

    await pipeline.processStream(request, res);

    expect(res._chunks).toHaveLength(1);
    expect(mocks.callLogRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        status_code: 499,
        error: 'client_closed_after_tool_call',
        input_tokens: 42,
        output_tokens: 7,
      }),
    );
    const reservation = await reservedBudgetAt(mocks);
    expect(reservation.commit).toHaveBeenCalledWith(49, expect.any(Number));
    expect(mocks.budgetService.record).not.toHaveBeenCalled();
    expect(mocks.circuitBreaker.recordSuccess).toHaveBeenCalled();
    expect(res.end).not.toHaveBeenCalled();
  });

  it('should stop draining when usage does not arrive within the grace period', async () => {
    async function* slowToolCallStream(
      _request: unknown,
      _nodeId: string,
      _model: string,
      options: { signal?: AbortSignal },
    ) {
      yield {
        type: 'raw_sse' as const,
        text:
          'event: response.output_item.done\n' +
          'data: {"item":{"type":"custom_tool_call","call_id":"call_1","status":"completed"}}\n\n',
        events: [
          {
            type: 'tool_call_complete' as const,
            id: 'call_1',
            tool_type: 'custom_tool_call',
          },
        ],
      };
      await new Promise<void>((resolve) => {
        options.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
    }

    const { pipeline, mocks } = makePipeline({
      providerClient: {
        forward: jest.fn(),
        forwardStream: jest.fn().mockImplementation(slowToolCallStream),
      },
    });
    const request = makeRequest('Use a custom tool', { originalModel: 'gpt-4o' });
    request.stream = true;
    request.metadata.source_format = 'responses';
    const res = mockResponse();
    res.write.mockImplementation((chunk: string) => {
      res._chunks.push(chunk);
      res.emit('close');
      return true;
    });

    const startedAt = Date.now();
    await pipeline.processStream(request, res);

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_400);
    expect(mocks.callLogRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        status_code: 499,
        error: 'client_closed_after_tool_call',
        input_tokens: 0,
        output_tokens: 0,
      }),
    );
    expect(mocks.circuitBreaker.recordSuccess).not.toHaveBeenCalled();
  });

  it('should not fallback after a structured-output stream has started', async () => {
    async function* invalidJsonStream() {
      yield { type: 'start' as const, id: 'json-stream', model: 'gpt-4o' };
      yield { type: 'delta' as const, content: { type: 'text' as const, text: 'not json' } };
      yield { type: 'stop' as const, stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 2 } };
    }

    const { pipeline, mocks } = makePipeline({
      config: {
        fallbackPolicy: {
          immediate_429: false,
          timeout: { enabled: false, threshold_ms: undefined, race_fallback: false },
          structured_output: {
            enabled: true,
            fallback_on_parse_error: true,
            fallback_on_schema_error: true,
          },
          cost_downgrade: { enabled: false, max_estimated_cost_usd: undefined },
        },
      },
      providerClient: {
        forward: jest.fn(),
        forwardStream: jest.fn().mockReturnValue(invalidJsonStream()),
      },
    });

    const request = makeRequest('Stream JSON', { originalModel: 'auto' });
    request.stream = true;
    request.metadata.raw_body = { response_format: { type: 'json_object' } };
    const res = mockResponse();

    await pipeline.processStream(request, res);

    expect(mocks.providerClient.forwardStream).toHaveBeenCalledTimes(1);
    const savedLog = mocks.callLogRepo.create.mock.calls[0][0];
    expect(savedLog.is_fallback).toBe(false);
    expect(savedLog.fallback_reason).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════
// processStream — transmission-phase errors
// ═══════════════════════════════════════════════════════════

describe('PipelineService — processStream transmission-phase errors', () => {
  it('should send stream_error event when stream breaks mid-transmission', async () => {
    async function* breakingStream() {
      yield { type: 'start' as const, id: 'break-1', model: 'gpt-4o' };
      yield { type: 'delta' as const, content: { type: 'text' as const, text: 'Hello' } };
      throw new Error('Connection reset by peer');
    }

    const { pipeline, mocks } = makePipeline({
      providerClient: {
        forward: jest.fn(),
        forwardStream: jest.fn().mockReturnValue(breakingStream()),
      },
    });

    const request = makeRequest('Hello', { originalModel: 'gpt-4o' });
    request.stream = true;
    const res = mockResponse();

    await pipeline.processStream(request, res);

    // Should write error event and end
    const allChunks = res._chunks.join('');
    expect(allChunks).toContain('stream_error');
    expect(res.end).toHaveBeenCalled();
    // Should NOT try fallback — transmission errors don't fallback
    expect(mocks.circuitBreaker.recordFailure).toHaveBeenCalled();
  });

  it('redacts provider secrets from transmission-phase stream errors', async () => {
    async function* breakingStream() {
      yield { type: 'start' as const, id: 'break-redact', model: 'gpt-4o' };
      yield { type: 'delta' as const, content: { type: 'text' as const, text: 'Hello' } };
      throw new Error(
        'Connection reset Bearer sk-secret-provider-token api_key=sk-query-secret-token',
      );
    }

    const { pipeline, mocks } = makePipeline({
      providerClient: {
        forward: jest.fn(),
        forwardStream: jest.fn().mockReturnValue(breakingStream()),
      },
    });

    const request = makeRequest('Hello', { originalModel: 'gpt-4o' });
    request.stream = true;
    const res = mockResponse();

    await pipeline.processStream(request, res);

    const allChunks = res._chunks.join('');
    const savedLog = mocks.callLogRepo.create.mock.calls[0][0];

    expect(allChunks).toContain('[REDACTED]');
    expect(allChunks).not.toContain('sk-secret-provider-token');
    expect(allChunks).not.toContain('sk-query-secret-token');
    expect(savedLog.error).toContain('[REDACTED]');
    expect(savedLog.error).not.toContain('sk-secret-provider-token');
    expect(savedLog.error).not.toContain('sk-query-secret-token');
  });

  it('should call circuitBreaker.recordFailure on transmission error', async () => {
    async function* breakingStream() {
      yield { type: 'start' as const, id: 'break-2', model: 'gpt-4o' };
      throw new Error('Stream reset');
    }

    const { pipeline, mocks } = makePipeline({
      providerClient: {
        forward: jest.fn(),
        forwardStream: jest.fn().mockReturnValue(breakingStream()),
      },
    });

    const request = makeRequest('Hello', { originalModel: 'gpt-4o' });
    request.stream = true;
    const res = mockResponse();

    await pipeline.processStream(request, res);

    expect(mocks.circuitBreaker.recordFailure).toHaveBeenCalledWith('openai', 'gpt-4o');
  });

  it('should release the concurrency slot when stream transmission fails', async () => {
    const release = jest.fn();
    async function* breakingStream() {
      yield { type: 'start' as const, id: 'break-release', model: 'gpt-4o' };
      throw new Error('Stream reset');
    }

    const { pipeline } = makePipeline({
      concurrencyLimiter: {
        acquire: jest.fn().mockResolvedValue({ release }),
      },
      providerClient: {
        forward: jest.fn(),
        forwardStream: jest.fn().mockReturnValue(breakingStream()),
      },
    });

    const request = makeRequest('Hello', { originalModel: 'gpt-4o' });
    request.stream = true;
    const res = mockResponse();

    await pipeline.processStream(request, res);

    expect(release).toHaveBeenCalledTimes(1);
  });

  it('should log statusCode 502 for transmission-phase errors', async () => {
    async function* breakingStream() {
      yield { type: 'start' as const, id: 'break-3', model: 'gpt-4o' };
      throw new Error('Broken pipe');
    }

    const { pipeline, mocks } = makePipeline({
      providerClient: {
        forward: jest.fn(),
        forwardStream: jest.fn().mockReturnValue(breakingStream()),
      },
    });

    const request = makeRequest('Hello', { originalModel: 'gpt-4o' });
    request.stream = true;
    const res = mockResponse();

    await pipeline.processStream(request, res);

    const savedLog = mocks.callLogRepo.create.mock.calls[0][0];
    expect(savedLog.status_code).toBe(502);
    expect(savedLog.error).toContain('Broken pipe');
  });

  it('should mark isFallback correctly for transmission errors on fallback node', async () => {
    // First call (primary) fails at connection phase (non-retryable 400)
    let callCount = 0;
    async function* fallbackBreakingStream() {
      yield { type: 'start' as const, id: 'fb-break', model: 'claude-3-opus' };
      throw new Error('Fallback stream broke');
    }

    const { pipeline, mocks } = makePipeline({
      providerClient: {
        forward: jest.fn(),
        forwardStream: jest.fn().mockImplementation(() => {
          callCount++;
          if (callCount <= 1) throw new ProviderError('Bad Request', 400, 'openai');
          return fallbackBreakingStream();
        }),
      },
    });

    const request = makeRequest('Hello', { originalModel: 'auto' });
    request.stream = true;
    const res = mockResponse();

    await pipeline.processStream(request, res);

    const savedLog = mocks.callLogRepo.create.mock.calls[0][0];
    expect(savedLog.is_fallback).toBe(true);
    expect(savedLog.status_code).toBe(502);
  });
});

// ═══════════════════════════════════════════════════════════
// Control-Plane Telemetry Metadata
// ═══════════════════════════════════════════════════════════

describe('PipelineService — control-plane telemetry metadata', () => {
  it('should enqueue external log sinks after the local call log is saved', async () => {
    const { pipeline, mocks } = makePipeline();

    await pipeline.process(makeRequest('Hello'));

    expect(mocks.callLogRepo.save).toHaveBeenCalled();
    expect(mocks.logSinks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 1,
        node_id: 'openai',
        model: 'gpt-4o',
      }),
    );
  });

  it('should enqueue domain and modality metadata without request bodies', async () => {
    const { pipeline, mocks } = makePipeline({
      scoringService: {
        score: jest.fn().mockReturnValue({
          tier: 'standard',
          score: 0.42,
          domainHint: 'backend',
          modalityHints: ['text', 'vision'],
          fastPath: undefined,
        }),
      },
    });

    const request = makeRequest('Build an API endpoint', { originalModel: 'auto' });
    await pipeline.process(request);

    expect(mocks.telemetryUploader.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        node_id: 'openai',
        model: 'gpt-4o',
        tier: 'standard',
      }),
      expect.objectContaining({
        domainHint: 'backend',
        modalities: ['text', 'vision'],
      }),
    );

    const payload = JSON.stringify(mocks.telemetryUploader.enqueue.mock.calls[0]);
    expect(payload).not.toContain('messages');
    expect(payload).not.toContain('Build an API endpoint');
    expect(payload).not.toContain('sk-');
  });
});

// ═══════════════════════════════════════════════════════════
// Images / Audio
// ═══════════════════════════════════════════════════════════

describe('PipelineService — images and audio', () => {
  it('should process media requests through routing, budget, telemetry, and call logs', async () => {
    const { pipeline, mocks } = makePipeline();
    const request = makeMediaRequest();

    const result = await pipeline.processMedia(request);

    expect(result.statusCode).toBe(200);
    expect(result.body).toMatchObject({
      data: [{ url: 'https://example.test/generated.png' }],
    });
    expect(mocks.budgetService.check).toHaveBeenCalled();
    expect(mocks.routingService.resolveMediaRoute).toHaveBeenCalledWith(
      'image_generation',
      'auto',
      expect.any(Function),
      expect.objectContaining({
        requested_modality: 'image',
        output_types: ['image'],
        source_format: 'image_generation',
      }),
    );
    expect(mocks.providerClient.forwardMedia).toHaveBeenCalledWith(
      request,
      'openai',
      'gpt-image-1',
      expect.objectContaining({ tier: 'standard', is_fallback: false }),
      expect.objectContaining({ signal: undefined }),
    );
    expect(mocks.callLogRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        source_format: 'image_generation',
        node_id: 'openai',
        model: 'gpt-image-1',
        status_code: 200,
        media_type: 'image',
        media_operation: 'generation',
        media_byte_size: 42,
        media_provider_response_type: 'application/json',
      }),
    );
    const routeTrace = JSON.parse(mocks.routeDecisionRepo.create.mock.calls[0][0].trace_json);
    expect(routeTrace.modality_evidence).toMatchObject({
      requested_modality: 'image',
      output_types: ['image'],
    });
    expect(routeTrace.candidate_targets[0].capability_evidence).toMatchObject({
      requested_modality: 'image',
      endpoint_status: 'default',
    });
  });

  it('should pass binary audio speech bodies through with provider content type', async () => {
    const { pipeline, mocks } = makePipeline({
      routingService: {
        resolveMediaRoute: jest.fn().mockReturnValue({
          primary: { node: 'openai', model: 'tts-1' },
          fallbacks: [],
          mode: 'direct',
        }),
      },
      providerClient: {
        forwardMedia: jest.fn().mockResolvedValue({
          id: 'speech-test',
          body: Buffer.from('audio-bytes'),
          content_type: 'audio/mpeg',
          provider_response_type: 'audio/mpeg',
          usage: { input_tokens: 4, output_tokens: 0 },
          model: 'tts-1',
          routing: {
            tier: 'direct',
            node: 'openai',
            latency_ms: 25,
            score: 0,
            is_fallback: false,
          },
        }),
      },
    });
    const request = makeMediaRequest({
      model: 'tts-1',
      source_format: 'audio_speech',
      payload: { model: 'tts-1', input: 'hello', voice: 'alloy' },
      media: {
        media_type: 'audio',
        operation: 'speech',
        multipart: false,
        file_count: 0,
        byte_size: 52,
        requested_format: null,
        response_format: null,
      },
      metadata: {
        source_format: 'audio_speech',
        original_model: 'tts-1',
        raw_headers: {},
        media: {
          media_type: 'audio',
          operation: 'speech',
          multipart: false,
          file_count: 0,
          byte_size: 52,
          requested_format: null,
          response_format: null,
        },
      },
    });

    const result = await pipeline.processMedia(request);

    expect(result.statusCode).toBe(200);
    expect(Buffer.isBuffer(result.body)).toBe(true);
    expect(result.contentType).toBe('audio/mpeg');
    expect(mocks.callLogRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ source_format: 'audio_speech' }),
    );
  });

  it('should reject media requests when API key modality permissions exclude the media type', async () => {
    const { pipeline, mocks } = makePipeline();
    const request = makeMediaRequest();
    request.metadata.api_key_permissions = {
      allow_auto: true,
      allow_direct: true,
      allowed_nodes: [],
      allowed_models: [],
      allowed_endpoints: ['images'],
      allowed_modalities: ['text'],
    };

    const result = await pipeline.processMedia(request);

    expect(result.statusCode).toBe(403);
    expect(mocks.providerClient.forwardMedia).not.toHaveBeenCalled();
  });

  it('should use fallback media targets after an upstream failure', async () => {
    const { pipeline, mocks } = makePipeline({
      routingService: {
        resolveMediaRoute: jest.fn().mockReturnValue({
          primary: { node: 'openai', model: 'gpt-image-1' },
          fallbacks: [{ node: 'claude', model: 'fallback-image' }],
          mode: 'auto',
        }),
      },
      providerClient: {
        forwardMedia: jest.fn()
          .mockRejectedValueOnce(new ProviderError('temporary media failure', 502, 'openai'))
          .mockResolvedValueOnce({
            id: 'media-fallback',
            body: { data: [{ url: 'https://example.test/fallback.png' }] },
            content_type: 'application/json',
            provider_response_type: 'application/json',
            usage: { input_tokens: 8, output_tokens: 0 },
            model: 'fallback-image',
            routing: {
              tier: 'standard',
              node: 'claude',
              latency_ms: 60,
              score: 0,
              is_fallback: true,
              fallback_reason: 'upstream_error',
            },
          }),
      },
      config: {
        retry: { max_retries: 0, backoff_base_ms: 1, backoff_max_ms: 1, retryable_status: [502] },
      },
    });

    const result = await pipeline.processMedia(makeMediaRequest());

    expect(result.statusCode).toBe(200);
    expect(mocks.providerClient.forwardMedia).toHaveBeenCalledTimes(2);
    expect(mocks.callLogRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        is_fallback: true,
        fallback_reason: 'upstream_error',
        model: 'fallback-image',
      }),
    );
  });
});

// ═══════════════════════════════════════════════════════════
// Cache-Aware Cost Calculation
// ═══════════════════════════════════════════════════════════

describe('PipelineService — cache-aware cost calculation', () => {
  it('should apply cache pricing when cache tokens are present', async () => {
    const { pipeline, mocks } = makePipeline({
      config: {
        getModelPricing: jest.fn().mockReturnValue({
          input: 3.0,    // $3/MTok normal input
          output: 15.0,   // $15/MTok output
          cache_creation_input: 3.75, // $3.75/MTok (1.25x for cache writes)
          cache_read_input: 0.30,     // $0.30/MTok (0.1x for cache reads)
        }),
      },
      providerClient: {
        forward: jest.fn().mockResolvedValue(
          makeCanonicalResponse({
            model: 'claude-3-sonnet',
            usage: {
              input_tokens: 1000,
              output_tokens: 200,
              cache_creation_input_tokens: 300,
              cache_read_input_tokens: 200,
            },
          }),
        ),
        forwardStream: jest.fn(),
      },
    });

    const request = makeRequest('Hello', { originalModel: 'claude-3-sonnet' });
    await pipeline.process(request);

    const savedLog = mocks.callLogRepo.create.mock.calls[0][0];
    // Normal input: 1000 - 300 - 200 = 500 → (500/1M) * 3.0
    // Cache create: 300 → (300/1M) * 3.75
    // Cache read: 200 → (200/1M) * 0.30
    // Output: 200 → (200/1M) * 15.0
    const expectedCost =
      (500 / 1_000_000) * 3.0 +
      (300 / 1_000_000) * 3.75 +
      (200 / 1_000_000) * 0.30 +
      (200 / 1_000_000) * 15.0;
    const expectedNoCacheCost =
      (1000 / 1_000_000) * 3.0 +
      (200 / 1_000_000) * 15.0;
    expect(savedLog.cost_usd).toBeCloseTo(expectedCost, 10);
    expect(savedLog.cost_without_cache_usd).toBeCloseTo(
      expectedNoCacheCost,
      10,
    );
  });

  it('should persist cache tokens in call log', async () => {
    const recordTargetUsage = jest.fn();
    const { pipeline, mocks } = makePipeline({
      routingService: { recordTargetUsage },
      providerClient: {
        forward: jest.fn().mockResolvedValue(
          makeCanonicalResponse({
            model: 'gpt-4o',
            usage: {
              input_tokens: 500,
              output_tokens: 100,
              cache_read_input_tokens: 200,
            },
          }),
        ),
        forwardStream: jest.fn(),
      },
    });

    const request = makeRequest('Hello', { originalModel: 'gpt-4o' });
    await pipeline.process(request);

    const savedLog = mocks.callLogRepo.create.mock.calls[0][0];
    expect(savedLog.cache_read_input_tokens).toBe(200);
    expect(savedLog.cache_creation_input_tokens).toBe(0);
    expect(recordTargetUsage).toHaveBeenCalledWith(
      'openai',
      'gpt-4o',
      expect.objectContaining({ cache_read_input_tokens: 200 }),
    );
  });

  it('should record session cache-affinity state after a successful provider response', async () => {
    const recordSessionRouteResult = jest.fn();
    const { pipeline } = makePipeline({
      routingService: { recordSessionRouteResult },
      providerClient: {
        forward: jest.fn().mockResolvedValue(
          makeCanonicalResponse({
            model: 'gpt-4o',
            usage: {
              input_tokens: 500,
              output_tokens: 100,
              cache_read_input_tokens: 150,
            },
          }),
        ),
        forwardStream: jest.fn(),
      },
    });

    const request = makeRequest('Hello', {
      originalModel: 'gpt-4o',
      sessionKey: 'session-123',
    });
    await pipeline.process(request);

    expect(recordSessionRouteResult).toHaveBeenCalledWith(
      'session-123',
      'openai',
      'gpt-4o',
      expect.objectContaining({ cache_read_input_tokens: 150 }),
      'default-workspace',
    );
  });

  it('should use default input pricing when cache pricing not specified', async () => {
    const { pipeline, mocks } = makePipeline({
      config: {
        getModelPricing: jest.fn().mockReturnValue({
          input: 5.0, output: 15.0,
          // No cache_creation_input or cache_read_input specified
        }),
      },
      providerClient: {
        forward: jest.fn().mockResolvedValue(
          makeCanonicalResponse({
            model: 'gpt-4o',
            usage: {
              input_tokens: 1000,
              output_tokens: 100,
              cache_read_input_tokens: 500,
            },
          }),
        ),
        forwardStream: jest.fn(),
      },
    });

    const request = makeRequest('Hello', { originalModel: 'gpt-4o' });
    await pipeline.process(request);

    const savedLog = mocks.callLogRepo.create.mock.calls[0][0];
    // Without cache pricing, falls back to normal input rate
    // Normal: (1000 - 500) / 1M * 5 + 500/1M * 5 + 100/1M * 15 = 1000/1M * 5 + 100/1M * 15
    const expectedCost = (1000 / 1_000_000) * 5.0 + (100 / 1_000_000) * 15.0;
    const expectedNoCacheCost = expectedCost;
    expect(savedLog.cost_usd).toBeCloseTo(expectedCost, 10);
    expect(savedLog.cost_without_cache_usd).toBeCloseTo(
      expectedNoCacheCost,
      10,
    );
  });
});

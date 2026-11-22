/**
 * E2E tests — Dashboard API endpoints
 */

import * as fs from 'fs';
import { createE2EHarness, E2EHarness, API_KEY, FIXTURE_PATH } from './setup';
import { DEFAULT_WORKSPACE_ID } from '../../src/workspaces/workspace.constants';
import { ConfigService } from '../../src/config/config.service';

describe('Dashboard (e2e)', () => {
  let harness: E2EHarness;

  beforeAll(async () => {
    harness = await createE2EHarness();
  }, 30_000);

  afterAll(async () => {
    await harness?.close();
  });

  beforeEach(() => {
    harness.fetchMock.reset();
  });

  // ══════════════════════════════════════════════════════
  // Stats & Logs
  // ══════════════════════════════════════════════════════

  it('GET /api/dashboard/stats → returns correct shape', async () => {
    const res = await harness.agent.get('/api/dashboard/stats');

    expect(res.status).toBe(200);
    expect(res.body.total).toBeDefined();
    expect(typeof res.body.total.calls).toBe('number');
    expect(typeof res.body.total.success).toBe('number');
    expect(typeof res.body.total.failed).toBe('number');
    expect(res.body.total.successRate).toBeDefined();
    expect(res.body.last24h).toBeDefined();
    expect(Array.isArray(res.body.tierDistribution)).toBe(true);
    expect(Array.isArray(res.body.nodeDistribution)).toBe(true);
  });

  it('GET /api/dashboard/logs → { data: [], pagination }', async () => {
    const res = await harness.agent.get('/api/dashboard/logs');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.pagination).toBeDefined();
    expect(typeof res.body.pagination.page).toBe('number');
    expect(typeof res.body.pagination.limit).toBe('number');
    expect(typeof res.body.pagination.total).toBe('number');
    expect(typeof res.body.pagination.totalPages).toBe('number');
  });

  it('GET /api/dashboard/logs?page=1&limit=5 → pagination works', async () => {
    const res = await harness.agent.get('/api/dashboard/logs?page=1&limit=5');

    expect(res.status).toBe(200);
    expect(res.body.pagination.page).toBe(1);
    expect(res.body.pagination.limit).toBe(5);
  });

  it('GET /api/dashboard/logs?period=15m → filters recent logs and returns client source', async () => {
    const timestamp = Date.now();
    await harness.callLogRepo.save([
      harness.callLogRepo.create({
        request_id: `logs-period-new-${timestamp}`,
        source_format: 'chat_completions',
        client_source: 'curl',
        tier: 'standard',
        score: 0.5,
        node_id: 'mock-openai',
        model: 'gpt-4o-mini',
        input_tokens: 1,
        output_tokens: 1,
        cost_usd: 0,
        latency_ms: 10,
        status_code: 200,
        workspace_id: DEFAULT_WORKSPACE_ID,
      }),
      harness.callLogRepo.create({
        request_id: `logs-period-old-${timestamp}`,
        timestamp: new Date(Date.now() - 60 * 60_000),
        source_format: 'chat_completions',
        client_source: 'postman',
        tier: 'standard',
        score: 0.5,
        node_id: 'mock-openai',
        model: 'gpt-4o-mini',
        input_tokens: 1,
        output_tokens: 1,
        cost_usd: 0,
        latency_ms: 10,
        status_code: 200,
        workspace_id: DEFAULT_WORKSPACE_ID,
      }),
    ]);

    const res = await harness.agent.get('/api/dashboard/logs?period=15m&limit=50');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          request_id: `logs-period-new-${timestamp}`,
          client_source: 'curl',
        }),
      ]),
    );
    expect(res.body.data).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ request_id: `logs-period-old-${timestamp}` }),
      ]),
    );
  });

  it('GET /api/dashboard/logs?search= → matches metadata case-insensitively and treats wildcards literally', async () => {
    const marker = `srch${Date.now()}`;
    const base = {
      source_format: 'chat_completions',
      tier: 'standard',
      score: 0.5,
      input_tokens: 1,
      output_tokens: 1,
      cost_usd: 0,
      latency_ms: 10,
      status_code: 200,
      workspace_id: DEFAULT_WORKSPACE_ID,
    };
    await harness.callLogRepo.save([
      harness.callLogRepo.create({
        ...base,
        request_id: `${marker}-by-model`,
        node_id: 'mock-openai',
        model: `${marker}_Model-X`,
      }),
      harness.callLogRepo.create({
        ...base,
        request_id: `${marker}-by-key`,
        node_id: 'mock-openai',
        model: 'gpt-4o-mini',
        api_key_name: `${marker}-Team-Key`,
      }),
      harness.callLogRepo.create({
        ...base,
        request_id: `${marker}-wildcard-decoy`,
        node_id: 'mock-openai',
        model: `${marker}AModel-X`,
      }),
      harness.callLogRepo.create({
        ...base,
        request_id: `${marker}-other-workspace`,
        node_id: 'mock-openai',
        model: `${marker}_Model-X`,
        workspace_id: 'workspace-search-isolation',
      }),
    ]);

    const byModel = await harness.agent
      .get('/api/dashboard/logs')
      .query({ period: '15m', limit: 50, search: `${marker.toUpperCase()}_MODEL` });
    expect(byModel.status).toBe(200);
    // `_` is literal: the decoy with `A` in that position must not match, and
    // the identical row in another workspace stays out of scope.
    expect(byModel.body.data.map((log: { request_id: string }) => log.request_id)).toEqual([
      `${marker}-by-model`,
    ]);

    const byKey = await harness.agent
      .get('/api/dashboard/logs')
      .query({ period: '15m', limit: 50, search: `  ${marker}-team-key  ` });
    expect(byKey.status).toBe(200);
    expect(byKey.body.data.map((log: { request_id: string }) => log.request_id)).toEqual([
      `${marker}-by-key`,
    ]);

    const percent = await harness.agent
      .get('/api/dashboard/logs')
      .query({ period: '15m', limit: 50, search: `${marker}%` });
    expect(percent.status).toBe(200);
    expect(percent.body.data).toEqual([]);

    const summary = await harness.agent
      .get('/api/dashboard/logs/summary')
      .query({ period: 'today', search: marker });
    expect(summary.status).toBe(200);
    expect(summary.body.total.requests).toBe(3);
    expect(
      summary.body.hourly_trend.reduce(
        (sum: number, bucket: { requests: number }) => sum + bucket.requests,
        0,
      ),
    ).toBe(3);
  });

  it('GET /api/dashboard/workspaces → returns default organization and workspace', async () => {
    const res = await harness.agent.get('/api/dashboard/workspaces');

    expect(res.status).toBe(200);
    expect(res.body.organization.id).toBe('default-org');
    expect(res.body.active_workspace.id).toBe(DEFAULT_WORKSPACE_ID);
    expect(res.body.default_workspace.id).toBe(DEFAULT_WORKSPACE_ID);
    expect(res.body.fallback.legacy_resources_map_to_default_workspace).toBe(true);
    expect(res.body.access).toMatchObject({
      user_id: 'dashboard',
      role: 'admin',
      permissions: {
        can_read: true,
        can_operate: true,
        can_admin: true,
      },
    });
  });

  it('GET /api/dashboard/members → returns default local Dashboard admin', async () => {
    const res = await harness.agent.get('/api/dashboard/members');

    expect(res.status).toBe(200);
    expect(res.body.roles).toEqual(['admin', 'operator', 'viewer']);
    expect(res.body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          user_id: 'dashboard',
          workspace_id: DEFAULT_WORKSPACE_ID,
          role: 'admin',
          status: 'active',
        }),
      ]),
    );
  });

  it('workspace lifecycle → admin can create, switch, rename, disable, and reactivate', async () => {
    const unique = Date.now();
    const createRes = await harness.agent
      .post('/api/dashboard/workspaces')
      .send({ name: `E2E Workspace ${unique}` });
    expect(createRes.status).toBe(201);
    expect(createRes.body.item).toMatchObject({
      organization_id: 'default-org',
      name: `E2E Workspace ${unique}`,
      slug: `e2e-workspace-${unique}`,
      status: 'active',
      is_default: false,
    });
    const workspaceId = createRes.body.item.id;
    await expect(
      harness.membershipRepo.findOneByOrFail({
        user_id: 'dashboard',
        workspace_id: workspaceId,
      }),
    ).resolves.toMatchObject({ role: 'admin', status: 'active' });

    const switchRes = await harness.agent
      .post('/api/dashboard/workspaces/switch')
      .send({ workspace_id: workspaceId });
    expect(switchRes.status).toBe(201);
    expect(switchRes.body.state.active_workspace.id).toBe(workspaceId);
    expect(switchRes.body.state.access.role).toBe('admin');

    const renameRes = await harness.agent
      .put(`/api/dashboard/workspaces/${workspaceId}`)
      .set('x-siftgate-workspace-id', workspaceId)
      .send({ name: `Renamed Workspace ${unique}`, slug: `renamed-${unique}` });
    expect(renameRes.status).toBe(200);
    expect(renameRes.body.item).toMatchObject({
      id: workspaceId,
      name: `Renamed Workspace ${unique}`,
      slug: `renamed-${unique}`,
    });

    const disableRes = await harness.agent
      .post(`/api/dashboard/workspaces/${workspaceId}/disable`)
      .set('x-siftgate-workspace-id', workspaceId);
    expect(disableRes.status).toBe(201);
    expect(disableRes.body.item.status).toBe('disabled');

    const disabledSwitchRes = await harness.agent
      .post('/api/dashboard/workspaces/switch')
      .send({ workspace_id: workspaceId });
    expect(disabledSwitchRes.status).toBe(404);

    const reactivateRes = await harness.agent
      .post(`/api/dashboard/workspaces/${workspaceId}/reactivate`)
      .set('x-siftgate-workspace-id', workspaceId);
    expect(reactivateRes.status).toBe(201);
    expect(reactivateRes.body.item.status).toBe('active');

    const auditRes = await harness.agent
      .get(`/api/dashboard/audit?resource_type=workspace&resource_id=${workspaceId}&limit=10`)
      .set('x-siftgate-workspace-id', workspaceId);
    expect(auditRes.status).toBe(200);
    expect(auditRes.body.data.map((event: any) => event.action)).toEqual(
      expect.arrayContaining([
        'workspace.create',
        'workspace.rename',
        'workspace.disable',
        'workspace.reactivate',
      ]),
    );
  });

  it('workspace lifecycle → non-admin cannot mutate workspaces', async () => {
    await harness.membershipRepo.update(
      { user_id: 'dashboard', workspace_id: DEFAULT_WORKSPACE_ID },
      { role: 'viewer' },
    );
    try {
      const res = await harness.agent
        .post('/api/dashboard/workspaces')
        .send({ name: `Denied Workspace ${Date.now()}` });
      expect(res.status).toBe(403);
      expect(res.body.required_role).toBe('admin');
    } finally {
      await harness.membershipRepo.update(
        { user_id: 'dashboard', workspace_id: DEFAULT_WORKSPACE_ID },
        { role: 'admin' },
      );
    }
  });

  it('GET /api/dashboard/audit → returns metadata-only management audit events with filters', async () => {
    const timestamp = Date.now();
    const created = await harness.managementAuditRepo.save(
      harness.managementAuditRepo.create({
        event_id: `mgmt_e2e_${timestamp}`,
        organization_id: 'default-org',
        workspace_id: DEFAULT_WORKSPACE_ID,
        actor_type: 'dashboard',
        actor_id: 'dashboard',
        action: 'e2e.audit.seed',
        resource_type: 'e2e_resource',
        resource_id: `seed-${timestamp}`,
        before_summary_json: null,
        after_summary_json: JSON.stringify({ safe: true }),
        result: 'success',
        failure_reason: null,
        request_id: `req-e2e-${timestamp}`,
        source: 'dashboard',
        metadata_json: JSON.stringify({ note: 'seed' }),
        previous_hash: null,
        event_hash: 'a'.repeat(64),
        schema_version: 1,
      }),
    );

    const res = await harness.agent
      .get(`/api/dashboard/audit?action=e2e.audit.seed&resource_type=e2e_resource&actor_id=dashboard&result=success`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      expect.objectContaining({
        event_id: created.event_id,
        workspace_id: DEFAULT_WORKSPACE_ID,
        action: 'e2e.audit.seed',
        resource_type: 'e2e_resource',
        resource_id: `seed-${timestamp}`,
        actor_id: 'dashboard',
        result: 'success',
        after_summary: { safe: true },
        metadata: { note: 'seed' },
      }),
    ]);
    expect(res.body.privacy).toMatchObject({
      prompt_response_stored: false,
      raw_headers_stored: false,
      provider_keys_stored: false,
      tool_payloads_stored: false,
      hidden_reasoning_stored: false,
    });
  });

  it('GET /api/dashboard/agent-platform → returns metadata-only Agent Platform preview state', async () => {
    const res = await harness.agent.get('/api/dashboard/agent-platform');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        version: 'v1',
        preview: true,
        workspace_id: DEFAULT_WORKSPACE_ID,
      }),
    );
    expect(res.body.a2a_hub.routing).toMatchObject({
      policy_enforced: true,
      backend_selection: 'agent_profile_gateway_key',
      bypasses_gateway_policy: false,
    });
    expect(res.body.workflow_preview).toMatchObject({
      preview: true,
      runtime_enabled: false,
      mode: 'metadata_only',
    });
    expect(res.body.memory_gateway).toMatchObject({
      preview: true,
      enabled: false,
      content_storage_enabled: false,
    });
    expect(res.body.privacy).toMatchObject({
      metadata_only: true,
      stores_prompts: false,
      stores_responses: false,
      stores_source_code: false,
      stores_tool_payloads: false,
      stores_raw_headers: false,
      stores_provider_keys: false,
      stores_resolved_secrets: false,
    });
    expect(JSON.stringify(res.body)).not.toContain('mock-openai-key');
    expect(JSON.stringify(res.body)).not.toContain('tool arguments');
  });

  it('GET /api/dashboard/cost-platform → returns internal chargeback and privacy-safe governance metadata', async () => {
    const timestamp = Date.now();
    await harness.callLogRepo.save([
      harness.callLogRepo.create({
        request_id: `cost-e2e-a-${timestamp}`,
        source_format: 'chat_completions',
        tier: 'standard',
        score: 0.5,
        node_id: 'mock-openai',
        model: 'gpt-4o',
        input_tokens: 120,
        output_tokens: 40,
        cost_usd: 1.25,
        latency_ms: 220,
        status_code: 200,
        workspace_id: DEFAULT_WORKSPACE_ID,
        api_key_id: 'key-e2e',
        api_key_name: 'e2e-key',
        team_id: 'team-platform',
        agent_project: 'gateway',
        intelligence_optimizer_applied: true,
        intelligence_estimated_savings_usd: 0.15,
      }),
      harness.callLogRepo.create({
        request_id: `cost-e2e-b-${timestamp}`,
        source_format: 'chat_completions',
        tier: 'standard',
        score: 0.5,
        node_id: 'mock-openai',
        model: 'gpt-4o-mini',
        input_tokens: 80,
        output_tokens: 20,
        cost_usd: 0.5,
        latency_ms: 180,
        status_code: 500,
        workspace_id: DEFAULT_WORKSPACE_ID,
        api_key_id: 'key-e2e',
        api_key_name: 'e2e-key',
        team_id: 'team-platform',
        agent_project: 'gateway',
      }),
    ]);

    const res = await harness.agent.get('/api/dashboard/cost-platform?period=30d&group_by=team');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      version: 'v1',
      workspace_id: DEFAULT_WORKSPACE_ID,
      chargeback: {
        summary: expect.objectContaining({
          requests: expect.any(Number),
          cost_usd: expect.any(Number),
        }),
        budget_period_close: expect.objectContaining({
          invoice_ready: true,
          payment_collection: false,
          recharge_balance: false,
        }),
        invoice_summary: expect.objectContaining({
          currency: 'USD',
        }),
      },
      price_sync: {
        guardrails: {
          explicit_sources_only: true,
          never_overwrite_operator_overrides_silently: true,
          automatic_price_trust: false,
        },
      },
      privacy: {
        metadata_only: true,
        stores_prompts: false,
        stores_responses: false,
        stores_source_code: false,
        stores_diffs: false,
        stores_tool_payloads: false,
        stores_raw_headers: false,
        stores_provider_keys: false,
        stores_media_bytes: false,
        stores_hidden_reasoning: false,
        exports_content: false,
      },
      boundaries: {
        payments: false,
        recharge_balances: false,
        reseller_marketplace: false,
        public_api_marketplace: false,
      },
    });
    expect(res.body.chargeback.groups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          group_by: 'team',
          group_value: 'team-platform',
          cost_usd: 1.75,
        }),
      ]),
    );
    expect(JSON.stringify(res.body)).not.toContain('mock-openai-key');
    expect(JSON.stringify(res.body)).not.toContain('Hello');
  });

  it('GET /api/dashboard/cost-platform/export → exports CSV chargeback rows', async () => {
    const timestamp = Date.now();
    await harness.callLogRepo.save(
      harness.callLogRepo.create({
        request_id: `cost-export-e2e-${timestamp}`,
        source_format: 'chat_completions',
        tier: 'standard',
        score: 0.5,
        node_id: 'mock-openai',
        model: 'gpt-4o-mini',
        input_tokens: 12,
        output_tokens: 3,
        cost_usd: 0.123,
        latency_ms: 100,
        status_code: 200,
        workspace_id: DEFAULT_WORKSPACE_ID,
        api_key_id: 'key-export',
        api_key_name: 'export-key',
        team_id: 'team-export',
        agent_project: 'gateway',
      }),
    );

    const res = await harness.agent.get('/api/dashboard/cost-platform/export?period=30d&group_by=team&format=csv');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.text).toContain('group,label,requests');
    expect(res.text).toContain('team-export');
    expect(res.headers['x-siftgate-privacy']).toBe('metadata-only');
  });

  it('GET /api/dashboard/semantic-platform → returns metadata-only semantic controls and privacy contract', async () => {
    const timestamp = Date.now();
    await harness.promptTemplateRepo.save(
      harness.promptTemplateRepo.create({
        id: `pt-e2e-${timestamp}`,
        workspace_id: DEFAULT_WORKSPACE_ID,
        prompt_key: 'e2e-review',
        version: 1,
        name: 'E2E Review',
        status: 'active',
        template_content: null,
        template_hash: 'b'.repeat(64),
        variables_json: JSON.stringify(['diff']),
        route_policy_id: 'policy-review',
        ab_metadata_json: JSON.stringify({ arm: 'a' }),
        metadata_json: null,
        content_storage_enabled: false,
      }),
    );
    await harness.routeDecisionRepo.save(
      harness.routeDecisionRepo.create({
        request_id: `semantic-e2e-${timestamp}`,
        source_format: 'chat_completions',
        tier: 'standard',
        score: 0.5,
        route_mode: 'auto',
        strategy: 'balanced',
        selected_node_id: 'mock-openai',
        selected_model: 'gpt-4o-mini',
        candidate_count: 1,
        filtered_count: 0,
        status_code: 200,
        workspace_id: DEFAULT_WORKSPACE_ID,
        trace_json: JSON.stringify({
          semantic_platform: {
            intent: { category: 'coding' },
            context_optimizer: { action: 'metadata_only' },
            guardrails_v2: { findings: [{ kind: 'pii' }] },
          },
        }),
      }),
    );

    const res = await harness.agent.get('/api/dashboard/semantic-platform?period=30d');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      version: 'v1',
      workspace_id: DEFAULT_WORKSPACE_ID,
      period: '30d',
      config: {
        enabled: true,
        semantic_cache: {
          enabled: true,
          backend: 'memory',
          isolation: 'workspace_api_key_model',
          explicit_response_storage_opt_in: true,
        },
      },
      prompt_registry: {
        enabled: true,
        stores_template_content: false,
      },
      context_optimizer: {
        enabled: true,
        content_persistence: false,
      },
      intent_classification: {
        observed: { coding: expect.any(Number) },
      },
      guardrails_v2: {
        metadata_only: true,
        blocked_by_default: false,
      },
      privacy: {
        metadata_only: true,
        stores_prompts: false,
        stores_responses: false,
        stores_prompt_templates_by_default: false,
        stores_raw_headers: false,
        stores_provider_keys: false,
        stores_tool_payloads: false,
        stores_hidden_reasoning: false,
      },
    });
    expect(res.body.prompt_registry.templates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          prompt_key: 'e2e-review',
          content_available: false,
          template_hash: 'b'.repeat(64),
        }),
      ]),
    );
    expect(JSON.stringify(res.body)).not.toContain('mock-openai-key');
    expect(JSON.stringify(res.body)).not.toContain('Check {{diff}}');
  });

  it('POST /api/dashboard/semantic-platform/prompt-templates → stores template hash only', async () => {
    const res = await harness.agent
      .post('/api/dashboard/semantic-platform/prompt-templates')
      .send({
        prompt_key: `route-review-${Date.now()}`,
        name: 'Route Review',
        template: 'Review {{diff}} and summarize risk.',
        variables: ['diff'],
        route_policy_id: 'coding-review',
        ab_metadata: { arm: 'stable' },
      });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      success: true,
      item: {
        workspace_id: DEFAULT_WORKSPACE_ID,
        version: 1,
        content_storage_enabled: false,
        content_available: false,
        variables: ['diff'],
        route_policy_id: 'coding-review',
      },
      privacy: {
        metadata_only: true,
        stores_prompt_templates_by_default: false,
      },
    });
    expect(res.body.item.template_hash).toHaveLength(64);
    expect(JSON.stringify(res.body)).not.toContain('Review {{diff}}');
  });

  it('route trace includes semantic platform evidence for prompt registry, intent, context, and guardrails', async () => {
    const promptKey = `semantic-trace-${Date.now()}`;
    await harness.agent
      .post('/api/dashboard/semantic-platform/prompt-templates')
      .send({
        prompt_key: promptKey,
        template: 'Classify {{diff}} safely.',
        variables: ['diff'],
      })
      .expect(201);

    const chatRes = await harness.agent
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${API_KEY}`)
      .set('x-siftgate-prompt-key', promptKey)
      .send({
        model: 'auto',
        messages: [
          {
            role: 'user',
            content: 'Review this TypeScript diff for CVE risk and email admin@example.com.',
          },
        ],
      });

    expect(chatRes.status).toBe(200);
    const latest = await harness.routeDecisionRepo.findOneOrFail({
      where: { workspace_id: DEFAULT_WORKSPACE_ID },
      order: { id: 'DESC' },
    });
    const trace = JSON.parse(latest.trace_json!);

    expect(trace.semantic_platform).toMatchObject({
      intent: {
        category: 'security',
        route_hint: {
          security_sensitive: true,
        },
      },
      context_optimizer: {
        enabled: true,
        changed_content: false,
      },
      guardrails_v2: {
        metadata_only: true,
        findings: expect.arrayContaining([
          expect.objectContaining({ kind: 'pii', metadata_only: true }),
        ]),
      },
      prompt_registry: {
        prompt_key: promptKey,
        version: 1,
        content_available: false,
      },
    });
    expect(JSON.stringify(trace)).not.toContain('Classify {{diff}} safely');
    expect(JSON.stringify(trace)).not.toContain('mock-openai-key');
  });

  it('POST /v1/feedback → stores thumbs feedback metadata without content fields', async () => {
    const requestId = `feedback-e2e-${Date.now()}`;
    await harness.callLogRepo.save(
      harness.callLogRepo.create({
        request_id: requestId,
        source_format: 'chat_completions',
        tier: 'standard',
        score: 0.5,
        node_id: 'mock-openai',
        model: 'gpt-4o-mini',
        input_tokens: 12,
        output_tokens: 3,
        cost_usd: 0.01,
        latency_ms: 100,
        status_code: 200,
        workspace_id: DEFAULT_WORKSPACE_ID,
        api_key_id: 'seed-key',
        api_key_name: 'seed',
        team_id: 'team-feedback',
        agent_project: 'gateway',
      }),
    );
    await harness.routeDecisionRepo.save(
      harness.routeDecisionRepo.create({
        request_id: requestId,
        source_format: 'chat_completions',
        tier: 'standard',
        score: 0.5,
        route_mode: 'auto',
        strategy: 'balanced',
        selected_node_id: 'mock-openai',
        selected_model: 'gpt-4o-mini',
        candidate_count: 2,
        filtered_count: 0,
        status_code: 200,
        workspace_id: DEFAULT_WORKSPACE_ID,
        api_key_id: 'seed-key',
        api_key_name: 'seed',
        intelligence_optimizer_applied: true,
        trace_json: JSON.stringify({
          candidate_targets: [
            {
              node: 'mock-openai',
              model: 'gpt-4o-mini',
              selected: true,
              weight: 0.9,
              scores: { cost: 0.95 },
            },
          ],
          intelligence: {
            optimizer: {
              applied: true,
              objective: 'balanced',
              reason: 'cost efficient',
            },
          },
        }),
      }),
    );

    const res = await harness.agent
      .post('/v1/feedback')
      .set('Authorization', `Bearer ${API_KEY}`)
      .send({
        request_id: requestId,
        value: 'down',
        reason_code: 'wrong_tone',
        prompt: 'should be ignored by DTO and never stored',
        response: 'should be ignored by DTO and never stored',
      });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      success: true,
      request_id: requestId,
      value: 'down',
      metadata_only: true,
      route_weight_evidence: {
        metadata_only: true,
        selected_node: 'mock-openai',
        selected_model: 'gpt-4o-mini',
        selected_weight: 0.9,
      },
      privacy: {
        stores_prompts: false,
        stores_responses: false,
        stores_tool_payloads: false,
        stores_raw_headers: false,
        stores_provider_keys: false,
      },
    });

    const stored = await harness.routeFeedbackRepo.findOneByOrFail({ request_id: requestId });
    expect(stored).toMatchObject({
      workspace_id: DEFAULT_WORKSPACE_ID,
      request_id: requestId,
      value: 'down',
      reason_code: 'wrong_tone',
      source: 'gateway_api',
      api_key_name: 'test-default',
      team_id: 'team-feedback',
    });
    expect(JSON.stringify(stored)).not.toContain('should be ignored');
  });

  it('RBAC → Viewer can read but cannot write Dashboard resources', async () => {
    await harness.membershipRepo.update(
      { user_id: 'dashboard', workspace_id: DEFAULT_WORKSPACE_ID },
      { role: 'viewer' },
    );
    try {
      const readRes = await harness.agent.get('/api/dashboard/logs');
      expect(readRes.status).toBe(200);

      const writeRes = await harness.agent
        .post('/api/dashboard/nodes/test')
        .send({
          protocol: 'chat_completions',
          base_url: 'http://test.example',
          endpoint: '/v1/chat/completions',
          api_key: 'test-key',
          model: 'gpt-4o-mini',
        });
      expect(writeRes.status).toBe(403);
      expect(writeRes.body.error.type).toBe('dashboard_permission_denied');
      expect(writeRes.body.required_role).toBe('operator');
      expect(writeRes.body.current_role).toBe('viewer');

      const auditRes = await harness.agent.get('/api/dashboard/audit?result=denied&resource_type=dashboard_endpoint');
      expect(auditRes.status).toBe(200);
      expect(auditRes.body.data).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: 'dashboard.post.denied',
            resource_type: 'dashboard_endpoint',
            result: 'denied',
          }),
        ]),
      );
    } finally {
      await harness.membershipRepo.update(
        { user_id: 'dashboard', workspace_id: DEFAULT_WORKSPACE_ID },
        { role: 'admin' },
      );
    }
  });

  it('RBAC → Operator can manage operations but cannot manage API keys, members, budgets, or destructive deletes', async () => {
    await harness.membershipRepo.update(
      { user_id: 'dashboard', workspace_id: DEFAULT_WORKSPACE_ID },
      { role: 'operator' },
    );
    try {
      const opRes = await harness.agent.post('/api/dashboard/nodes/mock-openai/reset');
      expect(opRes.status).toBe(201);
      expect(opRes.body.success).toBe(true);

      const keyRes = await harness.agent
        .post('/api/dashboard/api-keys')
        .send({ name: `operator-denied-${Date.now()}` });
      expect(keyRes.status).toBe(403);
      expect(keyRes.body.required_role).toBe('admin');

      const membersRes = await harness.agent.get('/api/dashboard/members');
      expect(membersRes.status).toBe(403);

      const budgetRes = await harness.agent.post('/api/dashboard/budget/1/reset');
      expect(budgetRes.status).toBe(403);

      const deleteRes = await harness.agent.delete('/api/dashboard/nodes/mock-openai');
      expect(deleteRes.status).toBe(403);
    } finally {
      await harness.membershipRepo.update(
        { user_id: 'dashboard', workspace_id: DEFAULT_WORKSPACE_ID },
        { role: 'admin' },
      );
    }
  });

  it('RBAC → Admin can perform admin operations', async () => {
    const res = await harness.agent
      .post('/api/dashboard/api-keys')
      .send({ name: `admin-rbac-${Date.now()}` });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.item.name).toContain('admin-rbac-');
  });

  it('management audit → records API key create, update, rotate, and delete without storing plaintext keys', async () => {
    const unique = Date.now();
    const createRes = await harness.agent
      .post('/api/dashboard/api-keys')
      .send({
        name: `audit-key-${unique}`,
        allow_auto: true,
        allow_direct: false,
        allowed_endpoints: ['chat_completions'],
      });
    expect(createRes.status).toBe(201);
    const keyId = createRes.body.item.id;
    const createdPlaintext = createRes.body.key;

    const updateRes = await harness.agent
      .put(`/api/dashboard/api-keys/${keyId}`)
      .send({ description: 'audit updated', rate_limit_per_minute: 60 });
    expect(updateRes.status).toBe(200);

    const rotateRes = await harness.agent.post(`/api/dashboard/api-keys/${keyId}/rotate`);
    expect(rotateRes.status).toBe(201);
    const rotatedPlaintext = rotateRes.body.key;

    const deleteRes = await harness.agent.delete(`/api/dashboard/api-keys/${keyId}`);
    expect(deleteRes.status).toBe(200);

    const auditRes = await harness.agent.get(`/api/dashboard/audit?resource_type=api_key&resource_id=${keyId}&limit=20`);
    expect(auditRes.status).toBe(200);
    const actions = auditRes.body.data.map((event: any) => event.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'api_key.create',
        'api_key.update',
        'api_key.rotate',
        'api_key.delete',
      ]),
    );
    const payload = JSON.stringify(auditRes.body);
    expect(payload).not.toContain(createdPlaintext);
    expect(payload).not.toContain(rotatedPlaintext);
    expect(payload).toContain('[redacted]');
  });

  it('management audit → records workspace member and invitation changes', async () => {
    const unique = Date.now();
    const member = await harness.membershipRepo.save(
      harness.membershipRepo.create({
        user_id: `audit-user-${unique}`,
        organization_id: 'default-org',
        workspace_id: DEFAULT_WORKSPACE_ID,
        role: 'viewer',
        status: 'active',
      }),
    );

    const updateRes = await harness.agent
      .put(`/api/dashboard/members/${member.id}`)
      .send({ role: 'operator' });
    expect(updateRes.status).toBe(200);

    const inviteRes = await harness.agent
      .post('/api/dashboard/members/invitations')
      .send({ email: `audit-${unique}@example.com`, role: 'viewer' });
    expect(inviteRes.status).toBe(201);
    const inviteId = inviteRes.body.item.id;
    const inviteToken = inviteRes.body.item.token;

    const revokeRes = await harness.agent.delete(`/api/dashboard/members/invitations/${inviteId}`);
    expect(revokeRes.status).toBe(200);

    const memberAudit = await harness.agent.get(`/api/dashboard/audit?action=workspace_member.update&resource_id=${member.id}`);
    expect(memberAudit.status).toBe(200);
    expect(memberAudit.body.data).toEqual([
      expect.objectContaining({
        action: 'workspace_member.update',
        resource_type: 'workspace_member',
        result: 'success',
      }),
    ]);

    const inviteAudit = await harness.agent.get(`/api/dashboard/audit?resource_type=workspace_invitation&resource_id=${inviteId}&limit=10`);
    expect(inviteAudit.status).toBe(200);
    expect(inviteAudit.body.data.map((event: any) => event.action)).toEqual(
      expect.arrayContaining([
        'workspace_invitation.create',
        'workspace_invitation.revoke',
      ]),
    );
    expect(JSON.stringify(inviteAudit.body)).not.toContain(inviteToken);
  });

  it('GET /api/dashboard/logs — active workspace header filters dashboard results', async () => {
    await harness.callLogRepo.save([
      harness.callLogRepo.create({
        request_id: `workspace-default-${Date.now()}`,
        source_format: 'chat_completions',
        workspace_id: DEFAULT_WORKSPACE_ID,
        tier: 'standard',
        score: 0.5,
        node_id: 'mock-openai',
        model: 'gpt-4o',
        input_tokens: 1,
        output_tokens: 1,
        cost_usd: 0,
        latency_ms: 1,
        status_code: 200,
        api_key_name: 'workspace-default',
      }),
      harness.callLogRepo.create({
        request_id: `workspace-other-${Date.now()}`,
        source_format: 'chat_completions',
        workspace_id: 'other-workspace',
        tier: 'standard',
        score: 0.5,
        node_id: 'mock-openai',
        model: 'gpt-4o',
        input_tokens: 1,
        output_tokens: 1,
        cost_usd: 0,
        latency_ms: 1,
        status_code: 200,
        api_key_name: 'workspace-other',
      }),
    ]);

    const res = await harness.agent
      .get('/api/dashboard/logs?limit=20')
      .set('x-siftgate-workspace-id', DEFAULT_WORKSPACE_ID);

    expect(res.status).toBe(200);
    expect(res.body.data.some((log: any) => log.api_key_name === 'workspace-default')).toBe(true);
    expect(res.body.data.some((log: any) => log.api_key_name === 'workspace-other')).toBe(false);
  });

  it('GET /api/dashboard/logs — created workspace does not leak default workspace logs', async () => {
    const unique = Date.now();
    const workspace = await harness.workspaceRepo.save(
      harness.workspaceRepo.create({
        id: `ws-e2e-isolated-${unique}`,
        organization_id: 'default-org',
        name: `Isolated ${unique}`,
        slug: `isolated-${unique}`,
        status: 'active',
        is_default: false,
      }),
    );
    await harness.membershipRepo.save(
      harness.membershipRepo.create({
        user_id: 'dashboard',
        organization_id: 'default-org',
        workspace_id: workspace.id,
        role: 'admin',
        status: 'active',
      }),
    );
    await harness.callLogRepo.save([
      harness.callLogRepo.create({
        request_id: `workspace-isolation-default-${unique}`,
        source_format: 'chat_completions',
        workspace_id: DEFAULT_WORKSPACE_ID,
        tier: 'standard',
        score: 0.5,
        node_id: 'mock-openai',
        model: 'gpt-4o',
        input_tokens: 1,
        output_tokens: 1,
        cost_usd: 0,
        latency_ms: 1,
        status_code: 200,
        api_key_name: 'workspace-isolation-default',
      }),
      harness.callLogRepo.create({
        request_id: `workspace-isolation-created-${unique}`,
        source_format: 'chat_completions',
        workspace_id: workspace.id,
        tier: 'standard',
        score: 0.5,
        node_id: 'mock-openai',
        model: 'gpt-4o',
        input_tokens: 1,
        output_tokens: 1,
        cost_usd: 0,
        latency_ms: 1,
        status_code: 200,
        api_key_name: 'workspace-isolation-created',
      }),
    ]);

    const res = await harness.agent
      .get('/api/dashboard/logs?limit=50')
      .set('x-siftgate-workspace-id', workspace.id);

    expect(res.status).toBe(200);
    expect(res.body.data.some((log: any) => log.api_key_name === 'workspace-isolation-created')).toBe(true);
    expect(res.body.data.some((log: any) => log.api_key_name === 'workspace-isolation-default')).toBe(false);
  });

  // ══════════════════════════════════════════════════════
  // Budget
  // ══════════════════════════════════════════════════════

  it('GET /api/dashboard/budget → { rules: [...] }', async () => {
    const res = await harness.agent.get('/api/dashboard/budget');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.rules)).toBe(true);
    // Should have token + cost rules based on our config
    expect(res.body.rules.length).toBeGreaterThanOrEqual(1);

    const rule = res.body.rules[0];
    expect(rule.type).toBeDefined();
    expect(typeof rule.limit).toBe('number');
    expect(typeof rule.current).toBe('number');
    expect(typeof rule.percentage).toBe('number');
  });

  // ══════════════════════════════════════════════════════
  // Nodes CRUD
  // ══════════════════════════════════════════════════════

  it('GET /api/dashboard/nodes → returns mock-openai + mock-claude', async () => {
    const res = await harness.agent.get('/api/dashboard/nodes');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.nodes)).toBe(true);
    const nodeIds = res.body.nodes.map((n: any) => n.id);
    expect(nodeIds).toContain('mock-openai');
    expect(nodeIds).toContain('mock-claude');
    expect(res.body.nodes[0].active_probe).toBeDefined();
    expect(res.body.nodes[0].active_probe.status).toBeDefined();
  });

  it('POST /api/dashboard/nodes → create + GET verify + DELETE', async () => {
    // Create (timeout_ms is required by DTO)
    const createRes = await harness.agent
      .post('/api/dashboard/nodes')
      .send({
        id: 'test-node-crud',
        name: 'Test CRUD Node',
        protocol: 'chat_completions',
        base_url: 'http://test.example',
        endpoint: '/v1/chat/completions',
        api_key: 'test-key',
        models: ['test-model'],
        timeout_ms: 30000,
      });

    expect(createRes.status).toBe(201);
    expect(createRes.body.success).toBe(true);

    // Verify it exists
    const listRes = await harness.agent.get('/api/dashboard/nodes');
    const nodeIds = listRes.body.nodes.map((n: any) => n.id);
    expect(nodeIds).toContain('test-node-crud');

    // Delete
    const deleteRes = await harness.agent.delete('/api/dashboard/nodes/test-node-crud');
    expect(deleteRes.status).toBe(200);
    expect(deleteRes.body.success).toBe(true);

    // Verify it's gone
    const listRes2 = await harness.agent.get('/api/dashboard/nodes');
    const nodeIds2 = listRes2.body.nodes.map((n: any) => n.id);
    expect(nodeIds2).not.toContain('test-node-crud');

    const auditRes = await harness.agent.get('/api/dashboard/audit?resource_type=node&resource_id=test-node-crud&limit=10');
    expect(auditRes.status).toBe(200);
    expect(auditRes.body.data.map((event: any) => event.action)).toEqual(
      expect.arrayContaining([
        'config.node.create',
        'config.node.delete',
      ]),
    );
    expect(JSON.stringify(auditRes.body)).not.toContain('test-key');
  });

  it('PUT /api/dashboard/nodes/:id → update node', async () => {
    const res = await harness.agent
      .put('/api/dashboard/nodes/mock-openai')
      .send({
        name: 'Updated Mock OpenAI',
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // Restore original name
    await harness.agent
      .put('/api/dashboard/nodes/mock-openai')
      .send({ name: 'Mock OpenAI' });

    const auditRes = await harness.agent.get('/api/dashboard/audit?action=config.node.update&resource_type=node&resource_id=mock-openai');
    expect(auditRes.status).toBe(200);
    expect(auditRes.body.data.length).toBeGreaterThan(0);
  });

  it('PUT pooled node preserves blank or omitted secrets and exact bracketed model IDs', async () => {
    const id = 'test-pooled-provider';
    const secret = 'test-preserved-pool-secret';
    const config = harness.app.get(ConfigService);
    const create = await harness.agent.post('/api/dashboard/nodes').send({
      id,
      name: 'Pooled Provider',
      protocol: 'messages',
      base_url: 'http://test.example',
      endpoint: '/v1/messages',
      auth_type: 'bearer',
      headers: { 'anthropic-version': '2023-06-01' },
      models: ['old-model'],
      model_aliases: { old: 'old-model' },
      upstream_model_aliases: { 'old-model': 'old-upstream-model' },
      model_prefixes: ['old-model'],
      credentials: [{ id: 'primary', api_key: secret, weight: 1, enabled: true }],
      timeout_ms: 30000,
    });
    expect(create.status).toBe(201);
    try {
      const models = ['claude-kr-claude-opus-5[1M]', 'claude-kr-claude-sonnet-5[1M]'];
      for (const apiKey of ['', undefined]) {
        const update = await harness.agent.put(`/api/dashboard/nodes/${id}`).send({
          models,
          endpoint: '/coding-plan/v1/messages',
          model_aliases: {},
          upstream_model_aliases: {},
          model_prefixes: [],
          credentials: [{ id: 'primary', api_key: apiKey, weight: 2, enabled: true }],
        });
        expect(update.status).toBe(200);
        expect(update.body.success).toBe(true);
        expect(config.getNode(id)?.credentials).toEqual([
          { id: 'primary', api_key: secret, weight: 2, enabled: true },
        ]);
      }
      const nodes = await harness.agent.get('/api/dashboard/nodes');
      const displayed = nodes.body.nodes.find((node: { id: string }) => node.id === id);
      expect(displayed.models).toEqual(models);
      expect(JSON.stringify(nodes.body)).not.toContain(secret);
      expect(config.getNode(id)?.model_aliases).toEqual({});
      expect(config.getNode(id)?.upstream_model_aliases).toEqual({});
      expect(config.getNode(id)?.model_prefixes).toEqual([]);

      for (const model of models) {
        const completion = await harness.agent.post('/v1/messages')
          .set('Authorization', `Bearer ${API_KEY}`)
          .send({ model, max_tokens: 1024, messages: [{ role: 'user', content: 'hello' }] });
        expect(completion.status).toBe(200);
        const upstream = harness.fetchMock.calls[harness.fetchMock.calls.length - 1];
        expect(upstream.url).toBe('http://test.example/coding-plan/v1/messages');
        expect(upstream.body.model).toBe(model);
        expect(upstream.headers.Authorization).toBe(`Bearer ${secret}`);
        expect(upstream.headers['anthropic-version']).toBe('2023-06-01');
      }
      const audit = await harness.agent.get(`/api/dashboard/audit?action=config.node.update&resource_type=node&resource_id=${id}`);
      expect(audit.status).toBe(200);
      expect(audit.body.data.length).toBeGreaterThan(0);
      expect(JSON.stringify(audit.body)).not.toContain(secret);

      // Both in-memory and on-disk state must remain intact after a bad update.
      const before = JSON.stringify(config.getNode(id));
      const fileBefore = fs.readFileSync(FIXTURE_PATH, 'utf8');
      for (const apiKey of ['', undefined, '   ']) {
        const rejected = await harness.agent.put(`/api/dashboard/nodes/${id}`).send({
          name: 'Must not persist',
          credentials: [
            { id: 'primary', api_key: 'would-replace-secret' },
            { id: 'new-credential', api_key: apiKey },
          ],
        });
        expect(rejected.status).toBe(400);
        expect(JSON.stringify(rejected.body)).not.toContain(secret);
        expect(JSON.stringify(rejected.body)).not.toContain('would-replace-secret');
        expect(JSON.stringify(config.getNode(id))).toBe(before);
        expect(fs.readFileSync(FIXTURE_PATH, 'utf8')).toBe(fileBefore);
      }

      const replacement = await harness.agent.put(`/api/dashboard/nodes/${id}`).send({
        credentials: [
          { id: 'primary', api_key: 'updated-pool-secret', weight: 3 },
          { id: 'secondary', api_key: 'new-pool-secret', weight: 1 },
        ],
      });
      expect(replacement.status).toBe(200);
      expect(config.getNode(id)?.credentials?.map((credential) => credential.api_key))
        .toEqual(['updated-pool-secret', 'new-pool-secret']);
    } finally {
      await harness.agent.delete(`/api/dashboard/nodes/${id}`);
    }
  });

  it('POST node creation continues rejecting blank pooled secrets', async () => {
    const response = await harness.agent.post('/api/dashboard/nodes').send({
      id: 'test-invalid-pool',
      name: 'Invalid Pool',
      protocol: 'messages',
      base_url: 'http://test.example',
      endpoint: '/v1/messages',
      models: ['test-model'],
      credentials: [{ id: 'primary', api_key: '' }],
      timeout_ms: 30000,
    });
    expect(response.status).toBe(400);
    expect(harness.app.get(ConfigService).getNode('test-invalid-pool')).toBeUndefined();
  });

  it('POST /api/dashboard/nodes/:id/reset → reset circuit breaker', async () => {
    const res = await harness.agent
      .post('/api/dashboard/nodes/mock-openai/reset');

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);

    const auditRes = await harness.agent.get('/api/dashboard/audit?action=circuit_breaker.reset&resource_id=mock-openai');
    expect(auditRes.status).toBe(200);
    expect(auditRes.body.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          resource_type: 'node_circuit',
          result: 'success',
        }),
      ]),
    );
  });

  it('POST /api/dashboard/nodes/:id/test → returns compatibility matrix without secrets', async () => {
    const res = await harness.agent
      .post('/api/dashboard/nodes/mock-openai/test')
      .send({ capabilities: ['chat', 'embeddings', 'images', 'video', 'realtime'] });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.matrix)).toBe(true);
    expect(res.body.matrix).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ capability: 'chat', configured: true, tested: true }),
        expect.objectContaining({ capability: 'embeddings', configured: true, tested: true }),
        expect.objectContaining({ capability: 'images', configured: true, tested: true }),
        expect.objectContaining({ capability: 'video', configured: true, tested: true }),
        expect.objectContaining({ capability: 'realtime', configured: true, tested: true }),
      ]),
    );
    expect(JSON.stringify(res.body)).not.toContain('mock-openai-key');

    const nodes = await harness.agent.get('/api/dashboard/nodes');
    const openai = nodes.body.nodes.find((node: { id: string }) => node.id === 'mock-openai');
    expect(openai.compatibility_matrix).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ capability: 'chat', last_status: 'pass' }),
      ]),
    );
  });

  // ══════════════════════════════════════════════════════
  // Config
  // ══════════════════════════════════════════════════════

  it('GET /api/dashboard/config → returns config with sanitized keys', async () => {
    const res = await harness.agent.get('/api/dashboard/config');

    expect(res.status).toBe(200);
    expect(res.body.server).toBeDefined();
    expect(res.body.nodes).toBeDefined();
    expect(res.body.routing).toBeDefined();
    expect(res.body.auth).toBeDefined();

    // API keys should be sanitized
    if (res.body.auth.api_keys?.length) {
      const key = res.body.auth.api_keys[0].key;
      expect(key).toContain('...');
    }

    // Node API keys should be sanitized
    if (res.body.nodes?.length) {
      const nodeKey = res.body.nodes[0].api_key;
      expect(nodeKey).toContain('...');
    }
  });

  it('POST /api/dashboard/config/reload → success', async () => {
    const res = await harness.agent.post('/api/dashboard/config/reload');

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);

    const auditRes = await harness.agent.get('/api/dashboard/audit?action=config.reload.dashboard&resource_type=config');
    expect(auditRes.status).toBe(200);
    expect(auditRes.body.data.length).toBeGreaterThan(0);
  });

  it('POST /api/dashboard/config/reload → failure keeps previous config', async () => {
    const original = fs.readFileSync(FIXTURE_PATH, 'utf8');
    const before = await harness.agent.get('/api/dashboard/config');
    const beforeNodeIds = before.body.nodes.map((node: any) => node.id);

    try {
      fs.writeFileSync(FIXTURE_PATH, 'nodes: [', 'utf8');
      const res = await harness.agent.post('/api/dashboard/config/reload');

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.rolled_back).toBe(true);
      expect(res.body.message).toContain('retained previous config');

      const auditRes = await harness.agent.get('/api/dashboard/audit?action=config.reload.dashboard&resource_type=config&result=failure');
      expect(auditRes.status).toBe(200);
      expect(auditRes.body.data).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: 'config.reload.dashboard',
            result: 'failure',
          }),
        ]),
      );

      const after = await harness.agent.get('/api/dashboard/config');
      expect(after.body.nodes.map((node: any) => node.id)).toEqual(beforeNodeIds);
    } finally {
      fs.writeFileSync(FIXTURE_PATH, original, 'utf8');
      await harness.agent.post('/api/dashboard/config/reload');
    }
  });

  it('POST /api/dashboard/config/reload → missing required env is rejected and previous config stays active', async () => {
    const original = fs.readFileSync(FIXTURE_PATH, 'utf8');
    const before = await harness.agent.get('/api/dashboard/config');
    const beforeNodeIds = before.body.nodes.map((node: any) => node.id);

    delete process.env.DASHBOARD_RELOAD_OPENAI_KEY;

    try {
      fs.writeFileSync(
        FIXTURE_PATH,
        original.replace('mock-openai-key', '${DASHBOARD_RELOAD_OPENAI_KEY}'),
        'utf8',
      );
      const res = await harness.agent.post('/api/dashboard/config/reload');

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.rolled_back).toBe(true);
      expect(res.body.message).toContain('DASHBOARD_RELOAD_OPENAI_KEY');

      const after = await harness.agent.get('/api/dashboard/config');
      expect(after.body.nodes.map((node: any) => node.id)).toEqual(beforeNodeIds);
    } finally {
      fs.writeFileSync(FIXTURE_PATH, original, 'utf8');
      await harness.agent.post('/api/dashboard/config/reload');
      delete process.env.DASHBOARD_RELOAD_OPENAI_KEY;
    }
  });

  // ══════════════════════════════════════════════════════
  // Routing
  // ══════════════════════════════════════════════════════

  it('PUT /api/dashboard/routing → update tiers', async () => {
    const res = await harness.agent
      .put('/api/dashboard/routing')
      .send({
        tiers: {
          simple: {
            primary: { node: 'mock-openai', model: 'gpt-4o-mini' },
            fallbacks: [{ node: 'mock-claude', model: 'claude-sonnet-4-20250514' }],
          },
          standard: {
            primary: { node: 'mock-openai', model: 'gpt-4o' },
            fallbacks: [{ node: 'mock-claude', model: 'claude-sonnet-4-20250514' }],
          },
          complex: {
            primary: { node: 'mock-claude', model: 'claude-sonnet-4-20250514' },
            fallbacks: [{ node: 'mock-openai', model: 'gpt-4o' }],
          },
          reasoning: {
            primary: { node: 'mock-claude', model: 'claude-sonnet-4-20250514' },
            fallbacks: [{ node: 'mock-openai', model: 'gpt-4o' }],
          },
        },
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('GET /api/dashboard/routing/recommendations → read-only recommendation mode', async () => {
    const res = await harness.agent.get('/api/dashboard/routing/recommendations?window_hours=24&sample_limit=1000');

    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('recommendation_only');
    expect(res.body.stats).toBeDefined();
    expect(Array.isArray(res.body.stats.targets)).toBe(true);
    expect(Array.isArray(res.body.recommendations)).toBe(true);
    expect(res.body.recommendations[0]).toHaveProperty('reasons');
    expect(res.body.recommendations[0]).toHaveProperty('confidence');
    expect(res.body.recommendations[0]).toHaveProperty('potential_savings');
    expect(res.body.recommendations[0]).toHaveProperty('risks');
  });

  // ══════════════════════════════════════════════════════
  // Cache & Analytics
  // ══════════════════════════════════════════════════════

  it('GET /api/dashboard/cache → cache stats shape', async () => {
    const res = await harness.agent.get('/api/dashboard/cache');

    expect(res.status).toBe(200);
    // Cache service returns stats object
    expect(res.body).toBeDefined();
  });

  it('management audit → records budget reset and cache clear operations', async () => {
    const budget = await harness.agent.get('/api/dashboard/budget');
    expect(budget.status).toBe(200);
    const ruleId = budget.body.rules[0]?.id;
    expect(typeof ruleId).toBe('number');

    const budgetReset = await harness.agent.post(`/api/dashboard/budget/${ruleId}/reset`);
    expect(budgetReset.status).toBe(201);

    const cacheClear = await harness.agent.post('/api/dashboard/cache/clear');
    expect(cacheClear.status).toBe(201);

    const budgetAudit = await harness.agent.get(`/api/dashboard/audit?action=budget.reset&resource_id=${ruleId}`);
    expect(budgetAudit.status).toBe(200);
    expect(budgetAudit.body.data).toEqual([
      expect.objectContaining({
        resource_type: 'budget_rule',
        result: 'success',
      }),
    ]);

    const cacheAudit = await harness.agent.get('/api/dashboard/audit?action=cache.clear&resource_type=prompt_cache');
    expect(cacheAudit.status).toBe(200);
    expect(cacheAudit.body.data).toEqual([
      expect.objectContaining({
        resource_id: 'default',
        result: 'success',
      }),
    ]);
  });

  it('GET /api/dashboard/analytics/cost → analytics shape', async () => {
    const res = await harness.agent.get('/api/dashboard/analytics/cost');

    expect(res.status).toBe(200);
    expect(res.body.period).toBeDefined();
    expect(res.body.total).toBeDefined();
    expect(Array.isArray(res.body.dailyTrend)).toBe(true);
    expect(Array.isArray(res.body.byModel)).toBe(true);
    expect(Array.isArray(res.body.byNode)).toBe(true);
  });

  it('GET /api/dashboard/benchmarks/report → benchmark report shape', async () => {
    const res = await harness.agent.get('/api/dashboard/benchmarks/report?period=24h&limit=100');

    expect(res.status).toBe(200);
    expect(res.body.summary).toBeDefined();
    expect(typeof res.body.summary.total_requests).toBe('number');
    expect(res.body.summary.latency_ms).toHaveProperty('p50_ms');
    expect(res.body.summary.latency_ms).toHaveProperty('p75_ms');
    expect(res.body.summary.latency_ms).toHaveProperty('p95_ms');
    expect(res.body.summary.latency_ms).toHaveProperty('p99_ms');
    expect(res.body.summary).toHaveProperty('cost_summary');
    expect(res.body.summary).toHaveProperty('token_summary');
    expect(Array.isArray(res.body.by_node_model)).toBe(true);
    expect(Array.isArray(res.body.by_source_format)).toBe(true);
    expect(Array.isArray(res.body.by_source_family)).toBe(true);
    expect(res.body.by_source_family.map((item: any) => item.source_family)).toEqual(
      expect.arrayContaining(['chat', 'responses', 'messages', 'embeddings', 'rerank', 'images', 'audio', 'video', 'realtime']),
    );
    expect(res.body.privacy).toMatchObject({
      prompt_response_stored: false,
      raw_headers_stored: false,
      provider_keys_exposed: false,
      media_bytes_stored: false,
      metadata_only: true,
    });
  });
});

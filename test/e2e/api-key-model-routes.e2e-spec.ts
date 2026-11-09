import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as yaml from 'js-yaml';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '../../src/config/config.service';
import { GatewayApiKey, LocalTeam } from '../../src/database/entities';
import { CircuitBreakerService } from '../../src/routing/circuit-breaker.service';
import { createE2EHarness, E2EHarness, API_KEY, FIXTURE_PATH } from './setup';

const chatTargets = ['mock-openai', 'mock-openai-b'];
const responseTargets = ['mock-responses-a', 'mock-responses-b'];
const rules = (model = 'gpt-4o', nodes = chatTargets) => [
  {
    model,
    strategy: 'round_robin',
    targets: nodes.map((node) => ({ node, weight: 1 })),
  },
];

function upstream(url: string, init: RequestInit): Response {
  const body = JSON.parse(init.body as string);
  if (url.endsWith('/v1/responses')) {
    const response = {
      id: 'resp-mock',
      object: 'response',
      status: 'completed',
      model: body.model,
      output: [
        {
          type: 'message',
          id: 'msg-mock',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'pool ok', annotations: [] }],
        },
      ],
      usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
    };
    return body.stream
      ? new Response(
          `event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'pool ok' })}\n\nevent: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response })}\n\n`,
          { headers: { 'Content-Type': 'text/event-stream' } },
        )
      : new Response(JSON.stringify(response), {
          headers: { 'Content-Type': 'application/json' },
        });
  }
  if (body.stream) {
    return new Response(
      `data: ${JSON.stringify({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { content: 'pool ok' }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } })}\n\ndata: [DONE]\n\n`,
      { headers: { 'Content-Type': 'text/event-stream' } },
    );
  }
  return new Response(
    JSON.stringify({
      id: 'chatcmpl-mock',
      object: 'chat.completion',
      model: body.model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'pool ok' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );
}

describe('Per-key model routing E2E', () => {
  let harness: E2EHarness;
  let dir: string;
  let keyRepo: Repository<GatewayApiKey>;
  let config: ConfigService;
  let sequence = 0;
  const postChat = (
    key: string,
    model = 'gpt-4o',
    extra: Record<string, unknown> = {},
  ) =>
    harness.agent
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${key}`)
      .send({
        model,
        messages: [{ role: 'user', content: `hello ${++sequence}` }],
        max_tokens: 8,
        ...extra,
      });
  const postResponses = (
    key: string,
    model = 'response-model',
    extra: Record<string, unknown> = {},
  ) =>
    harness.agent
      .post('/v1/responses')
      .set('Authorization', `Bearer ${key}`)
      .send({
        model,
        input: `hello ${++sequence}`,
        max_output_tokens: 8,
        ...extra,
      });

  async function createKey(extra: Record<string, unknown> = {}) {
    const result = await harness.agent
      .post('/api/dashboard/api-keys')
      .send({
        name: `pool-${++sequence}`,
        allow_auto: false,
        allow_direct: true,
        allowed_nodes: chatTargets,
        allowed_models: ['gpt-4o'],
        model_routes: rules(),
        ...extra,
      });
    expect(result.status).toBe(201);
    expect(result.body.item.model_routes).toBeDefined();
    return result.body as { key: string; item: { id: string } };
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'siftgate-model-pool-e2e-'));
    const fixture = yaml.load(readFileSync(FIXTURE_PATH, 'utf8')) as any;
    fixture.nodes.push({
      ...fixture.nodes[0],
      id: 'mock-openai-b',
      name: 'Backup',
      base_url: 'http://mock-backup.test',
    });
    for (const id of responseTargets)
      fixture.nodes.push({
        id,
        name: id,
        base_url: `http://${id}.test`,
        protocol: 'responses',
        endpoint: '/v1/responses',
        api_key: 'mock-key',
        models: ['response-model'],
        timeout_ms: 5000,
        model_capabilities: {
          'response-model': { modalities: ['text', 'vision'] },
        },
      });
    fixture.retry = {
      max_retries: 0,
      backoff_base_ms: 1,
      backoff_max_ms: 5,
      retryable_status: [429, 502, 503],
    };
    fixture.semantic_cache.enabled = false;
    const file = join(dir, 'gateway.yaml');
    writeFileSync(file, yaml.dump(fixture));
    harness = await createE2EHarness(file);
    keyRepo = harness.app.get(getRepositoryToken(GatewayApiKey));
    config = harness.app.get(ConfigService);
  }, 60000);

  beforeEach(() => {
    harness.fetchMock.reset();
    harness.fetchMock.setHandler(async (url, init) => upstream(url, init));
    const breaker = harness.app.get(CircuitBreakerService);
    for (const node of config.nodes) {
      breaker.reset(node.id);
      node.disabled = false;
    }
  });

  afterAll(async () => {
    if (harness) await harness.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('round-robins 20 concurrent requests 10/10 without requiring auto permission', async () => {
    const { key } = await createKey();
    let active = 0;
    let peak = 0;
    harness.fetchMock.setHandler(async (url, init) => {
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => setTimeout(resolve, 25));
      active--;
      return upstream(url, init);
    });
    const results = await Promise.all(
      Array.from({ length: 20 }, () => postChat(key)),
    );
    expect(results.map((result) => result.status)).toEqual(Array(20).fill(200));
    expect(
      harness.fetchMock.calls.filter((call) =>
        call.url.includes('mock-upstream.test'),
      ),
    ).toHaveLength(10);
    expect(
      harness.fetchMock.calls.filter((call) =>
        call.url.includes('mock-backup.test'),
      ),
    ).toHaveLength(10);
    expect(peak).toBeGreaterThan(1);
    expect(
      harness.fetchMock.calls.every((call) => call.body.model === 'gpt-4o'),
    ).toBe(true);
  });

  it('keeps counters isolated per key, and preserves direct lookup on non-opted-in keys', async () => {
    const a = await createKey();
    const b = await createKey();
    expect((await postChat(a.key)).status).toBe(200);
    expect((await postChat(b.key)).status).toBe(200);
    expect((await postChat(a.key)).status).toBe(200);
    expect(
      harness.fetchMock.calls.map((call) => new URL(call.url).host),
    ).toEqual(['mock-upstream.test', 'mock-upstream.test', 'mock-backup.test']);
    harness.fetchMock.calls = [];
    for (let i = 0; i < 3; i++)
      expect(
        (
          await postChat(API_KEY, 'gpt-4o', {
            metadata: { api_key_model_routes: rules(), api_key_id: 'spoof' },
          })
        ).status,
      ).toBe(200);
    expect(
      harness.fetchMock.calls.every((call) =>
        call.url.includes('mock-upstream.test'),
      ),
    ).toBe(true);
  });

  it('preserves explicit node forms and existing auto routing', async () => {
    const { key } = await createKey();
    for (const model of [
      'mock-openai-b/gpt-4o',
      'mock-openai-b:gpt-4o',
      'mock-openai-b',
    ])
      expect((await postChat(key, model)).status).toBe(200);
    expect(
      harness.fetchMock.calls.every((call) =>
        call.url.includes('mock-backup.test'),
      ),
    ).toBe(true);
    expect((await postChat(key, 'auto')).status).toBe(403);
    expect((await postChat(API_KEY, 'auto')).status).toBe(200);
  });

  it('streams Chat and Responses requests through both selected targets', async () => {
    const chat = await createKey();
    for (let i = 0; i < 2; i++) {
      const result = await postChat(chat.key, 'gpt-4o', { stream: true });
      expect(result.status).toBe(200);
      expect(result.text).toContain('pool ok');
      expect(result.text).toContain('[DONE]');
    }
    const responses = await createKey({
      allowed_nodes: responseTargets,
      allowed_models: ['response-model'],
      model_routes: rules('response-model', responseTargets),
    });
    for (let i = 0; i < 2; i++) {
      const result = await postResponses(responses.key, 'response-model', {
        stream: true,
      });
      expect(result.status).toBe(200);
      expect(result.text).toContain('response.completed');
      expect(result.text).toContain('pool ok');
    }
    expect(
      new Set(harness.fetchMock.calls.map((call) => new URL(call.url).host))
        .size,
    ).toBe(4);
  });

  it('uses native Responses nonstream and rejects previous_response_id only on pooled requests', async () => {
    const { key } = await createKey({
      allowed_nodes: responseTargets,
      allowed_models: ['response-model'],
      model_routes: rules('response-model', responseTargets),
    });
    expect((await postResponses(key)).status).toBe(200);
    expect((await postResponses(key)).status).toBe(200);
    expect(new Set(harness.fetchMock.calls.map((call) => call.url)).size).toBe(
      2,
    );
    const before = harness.fetchMock.calls.length;
    expect(
      (
        await postResponses(key, 'response-model', {
          previous_response_id: 'resp-provider-owned',
        })
      ).status,
    ).toBe(400);
    expect(harness.fetchMock.calls).toHaveLength(before);
    expect(
      (
        await postResponses(key, 'mock-responses-a/response-model', {
          previous_response_id: 'resp-provider-owned',
        })
      ).status,
    ).toBe(200);
    expect(harness.fetchMock.calls.at(-1)?.body.previous_response_id).toBe(
      'resp-provider-owned',
    );
  });

  it('fails over within the same-model pool on 503 without trying unrelated global nodes', async () => {
    const { key } = await createKey();
    harness.fetchMock.setHandler(async (url, init) =>
      url.includes('mock-upstream.test')
        ? new Response(JSON.stringify({ error: { message: 'busy' } }), {
            status: 503,
          })
        : upstream(url, init),
    );
    expect((await postChat(key)).status).toBe(200);
    expect(
      harness.fetchMock.calls.map((call) => new URL(call.url).host),
    ).toEqual(['mock-upstream.test', 'mock-backup.test']);
  });

  it('supports connection-phase fallback for streaming requests', async () => {
    const { key } = await createKey();
    harness.fetchMock.setHandler(async (url, init) =>
      url.includes('mock-upstream.test')
        ? new Response(JSON.stringify({ error: { message: 'busy' } }), {
            status: 503,
          })
        : upstream(url, init),
    );
    const result = await postChat(key, 'gpt-4o', { stream: true });
    expect(result.status).toBe(200);
    expect(result.text).toContain('pool ok');
    expect(
      harness.fetchMock.calls.some((call) =>
        call.url.includes('mock-backup.test'),
      ),
    ).toBe(true);
    expect(
      harness.fetchMock.calls.every((call) => call.body.model === 'gpt-4o'),
    ).toBe(true);
  });

  it('filters a disabled target and returns 503 instead of escaping an empty pool', async () => {
    const { key } = await createKey();
    config.getNode('mock-openai')!.disabled = true;
    expect((await postChat(key)).status).toBe(200);
    expect(harness.fetchMock.calls.at(-1)?.url).toContain('mock-backup.test');
    config.getNode('mock-openai-b')!.disabled = true;
    expect((await postChat(key)).status).toBe(503);
    expect(harness.fetchMock.calls).toHaveLength(1);
  });

  it('rechecks effective team permissions before selection and fails closed when all are revoked', async () => {
    const teamRepo = harness.app.get<Repository<LocalTeam>>(
      getRepositoryToken(LocalTeam),
    );
    const team = await teamRepo.save({
      name: 'pool-team',
      status: 'active',
      workspace_id: 'default-workspace',
      allowed_nodes: chatTargets,
    });
    const { key } = await createKey({ team_id: team.id });
    await teamRepo.update(team.id, { allowed_nodes: ['mock-openai-b'] });
    expect((await postChat(key)).status).toBe(200);
    expect(harness.fetchMock.calls.at(-1)?.url).toContain('mock-backup.test');
    await teamRepo.update(team.id, { allowed_nodes: ['mock-claude'] });
    expect((await postChat(key)).status).toBe(403);
    expect(harness.fetchMock.calls).toHaveLength(1);
  });

  it('rejects invalid updates atomically and clearing a binding restores existing direct selection', async () => {
    const { key, item } = await createKey();
    const invalid = await harness.agent
      .put(`/api/dashboard/api-keys/${item.id}`)
      .send({ allowed_nodes: ['mock-openai'] });
    expect(invalid.status).toBe(400);
    expect(
      (await keyRepo.findOneByOrFail({ id: item.id })).allowed_nodes,
    ).toEqual(chatTargets);
    expect(
      (
        await harness.agent
          .put(`/api/dashboard/api-keys/${item.id}`)
          .send({ description: 'keep routes' })
      ).status,
    ).toBe(200);
    expect(
      (await keyRepo.findOneByOrFail({ id: item.id })).model_routes,
    ).toEqual(rules());
    expect(
      (
        await harness.agent
          .put(`/api/dashboard/api-keys/${item.id}`)
          .send({ model_routes: null })
      ).status,
    ).toBe(200);
    for (let i = 0; i < 2; i++) expect((await postChat(key)).status).toBe(200);
    expect(
      harness.fetchMock.calls.every((call) =>
        call.url.includes('mock-upstream.test'),
      ),
    ).toBe(true);
  });
});

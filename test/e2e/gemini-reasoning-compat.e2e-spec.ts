import { isDeepStrictEqual } from 'node:util';
import { createE2EHarness, E2EHarness, API_KEY } from './setup';
import { ConfigService } from '../../src/config/config.service';
import { NodeConfig } from '../../src/config/gateway.config';
import { PromptCacheService } from '../../src/cache/prompt-cache.service';
import { CircuitBreakerService } from '../../src/routing/circuit-breaker.service';
import { RoutingService } from '../../src/routing/routing.service';
import { ProviderClientService } from '../../src/providers/provider-client.service';

type Body = Record<string, any>;
const models = ['gemini-4-argon', 'gemini-3.8-flash', 'gemini-2.5-flash', 'reasoning-public-alias'];
const user = { role: 'user', content: 'Synthetic reasoning regression fixture.' };
const control = (dialect: string, effort: string) => dialect === 'openai' ? { reasoning_effort: effort } : { reasoning: { effort } };
const google = (config: Body) => ({ extra_body: { google: { thinking_config: config } } });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const reject = (message: string) => json({ error: { type: 'invalid_request_error', message } }, 400);
const frame = (delta: Body, finish_reason: string | null = null) => ({ id: 'synthetic', model: models[0], choices: [{ index: 0, delta, finish_reason }] });
function sse(frames: unknown[], done = true) {
  const bytes = new TextEncoder().encode(frames.map((data) => `data: ${JSON.stringify(data)}\r\n\r\n`).join('') + (done ? 'data: [DONE]\n\n' : ''));
  return new Response(new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i += 11) controller.enqueue(bytes.slice(i, i + 11));
    controller.close();
  } }), { headers: { 'content-type': 'text/event-stream' } });
}
function answer(stream: boolean) {
  return stream ? sse([frame({ content: 'Reasoning accepted.' }), { ...frame({}, 'stop'), usage: { prompt_tokens: 5, completion_tokens: 3 } }])
    : json({ id: 'synthetic', model: models[0], choices: [{ message: { role: 'assistant', content: 'Reasoning accepted.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3 } });
}
function hasLevel(body: Body, level: string) {
  return body.reasoning_effort === undefined && body.reasoning === undefined && body.thinking_config === undefined
    && body.extra_body?.google?.thinking_config?.thinking_level === level
    && body.extra_body.google.thinking_config.thinking_budget === undefined;
}

describe('Gemini reasoning HTTP compatibility', () => {
  let h: E2EHarness;
  let node: NodeConfig;
  let failureSpy: jest.SpyInstance;
  let resultSpy: jest.SpyInstance;
  let forwardSpy: jest.SpyInstance;
  let streamSpy: jest.SpyInstance;
  beforeAll(async () => {
    h = await createE2EHarness();
    node = h.app.get(ConfigService).getNode('mock-openai')!;
    node.models.push(...models);
  }, 30_000);
  afterAll(async () => { await h?.close(); });
  beforeEach(() => {
    h.fetchMock.reset();
    h.app.get(PromptCacheService).clear();
    node.protocol = 'chat_completions';
    node.base_url = 'http://mock-upstream.test';
    node.endpoint = '/v1/chat/completions';
    node.request_compatibility = { chat_reasoning_format: 'google-thinking-level' };
    node.upstream_model_aliases = {};
    failureSpy = jest.spyOn(h.app.get(CircuitBreakerService), 'recordFailure');
    resultSpy = jest.spyOn(h.app.get(RoutingService), 'recordTargetResult');
    forwardSpy = jest.spyOn(h.app.get(ProviderClientService), 'forward');
    streamSpy = jest.spyOn(h.app.get(ProviderClientService), 'forwardStream');
  });
  afterEach(() => { for (const spy of [failureSpy, resultSpy, forwardSpy, streamSpy]) spy.mockRestore(); });

  function expectLocalRejectionIsolation() {
    expect(h.fetchMock.calls).toHaveLength(0);
    expect(failureSpy).not.toHaveBeenCalled();
    expect(resultSpy).not.toHaveBeenCalled();
    const attemptedNodes = [...forwardSpy.mock.calls, ...streamSpy.mock.calls].map((call) => call[1]);
    expect(attemptedNodes.every((id) => id === 'mock-openai')).toBe(true);
    expect(attemptedNodes.length).toBeLessThanOrEqual(1); // No retries or fallback attempts for a local request error.
  }
  const send = (body: Body) => h.agent.post('/v1/chat/completions').set('Authorization', `Bearer ${API_KEY}`)
    .send({ model: models[0], messages: [user], ...body }).buffer(true);

  it.each(models.slice(0, 2).flatMap((model) => ['openai', 'openrouter'].flatMap((dialect) =>
    ['low', 'medium', 'high'].flatMap((effort) => [false, true].map((stream) => ({ model, dialect, effort, stream }))))))
 ('$model $dialect $effort stream=$stream passes a strict level-only upstream', async ({ model, dialect, effort, stream }) => {
    h.fetchMock.setHandler(async (_url, init) => {
      const body = JSON.parse(init.body as string);
      if (!hasLevel(body, effort)) return reject('This fixture rejects reasoning_effort and requires the requested thinking_level.');
      return answer(stream);
    });
    const response = await send({ model, ...control(dialect, effort), stream });
    expect({ status: response.status, error: response.body.error }).toEqual({ status: 200, error: undefined });
    expect(stream ? response.text : response.body.choices[0].message.content).toContain('Reasoning accepted.');
    expect(h.fetchMock.calls).toHaveLength(1);
    expect(h.fetchMock.calls[0].body.model).toBe(model);
    if (stream) expect(response.text.match(/\[DONE\]/g)).toHaveLength(1);
  });

  it.each([false, true])('detects the actual upstream alias, stream=%s', async (stream) => {
    node.upstream_model_aliases = { 'reasoning-public-alias': 'gemini-4-argon' };
    node.base_url = 'https://generativelanguage.googleapis.com/v1beta/openai';
    node.request_compatibility = {};
    h.fetchMock.setHandler(async (_url, init) => {
      const body = JSON.parse(init.body as string);
      return body.model === 'gemini-4-argon' && hasLevel(body, 'high') ? answer(stream) : reject('Wrong wire model or reasoning dialect');
    });
    expect((await send({ model: 'reasoning-public-alias', reasoning_effort: 'high', stream })).status).toBe(200);
    expect(h.fetchMock.calls).toHaveLength(1);
  });

  it.each([false, true])('supports a strict official Google Chat endpoint, stream=%s', async (stream) => {
    node.base_url = 'https://generativelanguage.googleapis.com/v1beta/openai';
    node.request_compatibility = {};
    node.endpoint = '/chat/completions';
    h.fetchMock.setHandler(async (_url, init) => hasLevel(JSON.parse(init.body as string), 'medium') ? answer(stream) : reject('Invalid official Google controls'));
    const response = await send({ reasoning: { effort: 'medium' }, stream });
    expect(response.status).toBe(200);
    expect(h.fetchMock.calls[0].url).toBe('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
  });

  it.each([
    { effort: 'high', enabled: true, exclude: true },
    { max_tokens: 4096, enabled: true, exclude: false },
    { enabled: false },
  ].flatMap((reasoning) => [false, true].map((stream) => ({ reasoning, stream }))))
 ('keeps OR controls $reasoning intact on exact OR endpoint, stream=$stream', async ({ reasoning, stream }) => {
    node.base_url = 'https://openrouter.ai/api/v1';
    node.request_compatibility = {};
    node.endpoint = '/chat/completions';
    h.fetchMock.setHandler(async (_url, init) => {
      const body = JSON.parse(init.body as string);
      return isDeepStrictEqual(body.reasoning, reasoning) && body.reasoning_effort === undefined && body.extra_body?.google === undefined
        ? answer(stream) : reject('OR controls were changed');
    });
    const response = await send({ reasoning, stream });
    expect(response.status).toBe(200);
    expect(h.fetchMock.calls[0].body.reasoning).toEqual(reasoning);
  });

  it.each([false, true])('supports an explicit private OR override, stream=%s', async (stream) => {
    node.request_compatibility = { chat_reasoning_format: 'openrouter' };
    h.fetchMock.setHandler(async (_url, init) => {
      const body = JSON.parse(init.body as string);
      return body.reasoning?.effort === 'high' && body.reasoning_effort === undefined ? answer(stream) : reject('Private OR dialect required');
    });
    expect((await send({ reasoning_effort: 'high', stream })).status).toBe(200);
  });

  it.each([false, true])('retains legacy Gemini 2.5 reasoning_effort, stream=%s', async (stream) => {
    node.request_compatibility = {};
    h.fetchMock.setHandler(async (_url, init) => {
      const body = JSON.parse(init.body as string);
      return body.reasoning_effort === 'medium' && body.extra_body?.google === undefined ? answer(stream) : reject('Legacy semantics changed');
    });
    expect((await send({ model: 'gemini-2.5-flash', reasoning: { effort: 'medium' }, stream })).status).toBe(200);
  });

  it.each([false, true])('unknown upstream auto policy remains OpenAI-compatible, stream=%s', async (stream) => {
    node.request_compatibility = { chat_reasoning_format: 'auto' };
    h.fetchMock.setHandler(async (_url, init) => {
      const body = JSON.parse(init.body as string);
      return body.reasoning_effort === 'high' && body.extra_body?.google === undefined ? answer(stream) : reject('Unknown proxy auto behavior changed');
    });
    expect((await send({ reasoning: { effort: 'high' }, stream })).status).toBe(200);
    expect(h.fetchMock.calls).toHaveLength(1);
  });

  it.each([false, true])('preserves explicit Google config and records reasoning_requested, stream=%s', async (stream) => {
    const config = { thinking_level: 'high', include_thoughts: true, custom_option: 'untouched' };
    const extra_body = { google: { thinking_config: config, custom_google: true }, unrelated: ['keep'] };
    h.fetchMock.setHandler(async (_url, init) => {
      const body = JSON.parse(init.body as string);
      return isDeepStrictEqual(body.extra_body, extra_body) && body.reasoning_effort === undefined
        ? answer(stream) : reject('Explicit Google config was altered');
    });
    const response = await send({ extra_body, stream });
    expect(response.status).toBe(200);
    expect(h.fetchMock.calls[0].body.extra_body).toEqual(extra_body);
    const requestId = response.headers['x-siftgate-request-id'] || response.headers['x-request-id'];
    expect(requestId).toEqual(expect.any(String));
    let log = await h.callLogRepo.findOneBy({ request_id: requestId });
    for (let attempt = 0; !log && attempt < 40; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      log = await h.callLogRepo.findOneBy({ request_id: requestId });
    }
    expect(log).toMatchObject({ reasoning_requested: true, reasoning_source: 'gemini.thinking_config', reasoning_effort: 'high' });
  });

  it.each([
    { reasoning_effort: 'high', ...google({ thinking_level: 'low' }) },
    { reasoning: { effort: 'high' }, ...google({ thinking_budget: 4096 }) },
    { reasoning_effort: 'low', thinking_config: { thinking_budget: 2048 } },
    google({ thinking_level: 'high', thinking_budget: 2048 }),
    { reasoning_effort: 'high', reasoning: { effort: 'low' } },
    { reasoning_effort: 'none' },
    { reasoning: { effort: 'none' } },
    { reasoning: { enabled: false } },
    { thinking: { type: 'disabled' } },
  ].flatMap((fields) => [false, true].map((stream) => ({ fields, stream }))))
 ('rejects conflicting/disabled controls $fields as HTTP400 before headers/inference (stream=$stream)', async ({ fields, stream }) => {
    const response = await send({ ...fields, stream });
    expect(response.status).toBe(400);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.body.error).toBeDefined();
    expectLocalRejectionIsolation();
    expect(response.text).not.toContain('data: [DONE]');
  });

  it.each([
    { ...google({ thinking_level: 'low' }), thinking_config: { thinking_level: 'high' } },
    { ...google({ thinking_budget: 0 }), thinkingConfig: { thinkingBudget: 2048 } },
    { generationConfig: { thinkingConfig: { thinkingLevel: 'high' } }, generation_config: { thinking_config: { thinking_level: 'low' } } },
    { ...google({ include_thoughts: true }), thinking_config: { thinking_budget: 0 }, reasoning_effort: 'high' },
  ].flatMap((fields) => [false, true].map((stream) => ({ fields, stream }))))
 ('rejects conflicting native envelopes $fields before inference (stream=$stream)', async ({ fields, stream }) => {
    const response = await send({ ...fields, stream });
    expect(response.status).toBe(400);
    expect(response.headers['content-type']).toContain('application/json');
    expectLocalRejectionIsolation();
  });

  it.each(['openai', 'openrouter'].flatMap((dialect) => [false, true].map((stream) => ({ dialect, stream }))))
 ('client $dialect high beats default low/budget0 while preserving include_thoughts (stream=$stream)', async ({ dialect, stream }) => {
    node.request_compatibility = { chat_reasoning_format: 'google-thinking-level', default_parameters: {
      extra_body: { google: { thinking_config: { thinking_level: 'low', thinking_budget: 0, include_thoughts: true }, sibling: 'keep' }, unrelated: ['keep'] },
    } };
    const defaults = JSON.stringify(node.request_compatibility.default_parameters);
    h.fetchMock.setHandler(async (_url, init) => {
      const body = JSON.parse(init.body as string);
      const expected = { google: { thinking_config: { thinking_level: 'high', include_thoughts: true }, sibling: 'keep' }, unrelated: ['keep'] };
      return hasLevel(body, 'high') && isDeepStrictEqual(body.extra_body, expected) ? answer(stream) : reject('Client controls lost to defaults');
    });
    expect((await send({ ...control(dialect, 'high'), stream })).status).toBe(200);
    expect(h.fetchMock.calls).toHaveLength(1);
    expect(JSON.stringify(node.request_compatibility.default_parameters)).toBe(defaults);
  });

  it.each([false, true])('local disable error never attempts an available fallback or penalizes targets, stream=%s', async (stream) => {
    const routing = h.app.get(RoutingService);
    const originalResolve = routing.resolve.bind(routing);
    // Fix route selection so the test isolates local-error/fallback behavior,
    // rather than the auto router's separate capability-based target promotion.
    const resolve = jest.spyOn(routing, 'resolve').mockImplementation((...args) => ({
      ...originalResolve(...args),
      primary: { node: 'mock-openai', model: 'gemini-4-argon' },
      fallbacks: [{ node: 'mock-claude', model: 'claude-sonnet-4-20250514' }],
    }));
    try {
      const response = await send({ model: 'auto', reasoning: { enabled: false }, stream });
      expect(resolve).toHaveBeenCalled();
      expect(resolve.mock.results[0].value).toMatchObject({ primary: { node: 'mock-openai', model: 'gemini-4-argon' } });
      expect({ status: response.status, attempts: [...forwardSpy.mock.calls, ...streamSpy.mock.calls].map((call) => ({ node: call[1], model: call[2] })) }).toMatchObject({ status: 400 });
      expect(resolve.mock.results[0].value.fallbacks).toContainEqual({ node: 'mock-claude', model: 'claude-sonnet-4-20250514' });
      expectLocalRejectionIsolation();
      const attemptedNodes = [...forwardSpy.mock.calls, ...streamSpy.mock.calls].map((call) => call[1]);
      expect(attemptedNodes).toEqual(['mock-openai']);
    } finally {
      resolve.mockRestore();
    }
  });

  it.each(['google', 'openrouter', 'native'].flatMap((target) => [false, true].flatMap((stream) => [
    { target, stream, dialect: 'OR + Google', fields: { reasoning: { effort: 'high' }, ...google({ include_thoughts: false }) } },
    { target, stream, dialect: 'OpenAI + OR', fields: { reasoning_effort: 'high', reasoning: { exclude: true } } },
  ])))('mixed $dialect keeps strength and visibility on $target, stream=$stream', async ({ target, stream, fields }) => {
    if (target === 'native') { node.protocol = 'gemini'; node.endpoint = '/v1beta/models/:model:generateContent'; }
    else node.request_compatibility = { chat_reasoning_format: target === 'google' ? 'google-thinking-level' : 'openrouter' };
    h.fetchMock.setHandler(async (_url, init) => {
      const body = JSON.parse(init.body as string);
      const valid = target === 'native'
        ? isDeepStrictEqual(body.generationConfig?.thinkingConfig, { thinkingLevel: 'high', includeThoughts: false })
        : target === 'google' ? hasLevel(body, 'high') && body.extra_body.google.thinking_config.include_thoughts === false
          : isDeepStrictEqual(body.reasoning, { effort: 'high', exclude: true }) && body.reasoning_effort === undefined && body.extra_body?.google?.thinking_config === undefined;
      if (!valid) return reject('Mixed reasoning strength or visibility was lost');
      if (target !== 'native') return answer(stream);
      const result = { candidates: [{ content: { role: 'model', parts: [{ text: 'Reasoning accepted.' }] }, finishReason: 'STOP' }] };
      return stream ? sse([result], false) : json(result);
    });
    const response = await send({ ...fields, stream });
    expect(response.status).toBe(200);
    expect(h.fetchMock.calls).toHaveLength(1);
    expect(stream ? response.text : response.body.choices[0].message.content).toContain('Reasoning accepted.');
  });

  it.each(['google', 'openrouter'].flatMap((target) => [false, true].flatMap((stream) => [
    { target, stream, config: { thinking_level: 'high' }, expectedRouter: { effort: 'high', exclude: true } },
    { target, stream, config: { thinking_budget: 2048 }, expectedRouter: { max_tokens: 2048, exclude: true } },
  ])))('native Google $config + OR exclude survives $target HTTP (stream=$stream)', async ({ target, stream, config, expectedRouter }) => {
    node.request_compatibility = { chat_reasoning_format: target === 'google' ? 'google-thinking-level' : 'openrouter' };
    h.fetchMock.setHandler(async (_url, init) => {
      const body = JSON.parse(init.body as string);
      const valid = target === 'google'
        ? isDeepStrictEqual(body.extra_body?.google?.thinking_config, { ...config, include_thoughts: false }) && body.reasoning === undefined
        : isDeepStrictEqual(body.reasoning, expectedRouter) && body.extra_body?.google?.thinking_config === undefined;
      return valid && body.reasoning_effort === undefined ? answer(stream) : reject('Native strength or OR visibility lost');
    });
    expect((await send({ ...google(config), reasoning: { exclude: true }, stream })).status).toBe(200);
    expect(h.fetchMock.calls).toHaveLength(1);
  });

  it.each(['google', 'openrouter'].flatMap((target) => [false, true].map((stream) => ({ target, stream }))))
 ('disabled + Google include-only never silently enables $target HTTP (stream=$stream)', async ({ target, stream }) => {
    node.request_compatibility = { chat_reasoning_format: target === 'google' ? 'google-thinking-level' : 'openrouter' };
    h.fetchMock.setHandler(async (_url, init) => {
      const body = JSON.parse(init.body as string);
      return target === 'openrouter' && isDeepStrictEqual(body.reasoning, { effort: 'none', exclude: true })
        ? answer(stream) : reject('Disabled reasoning was lost');
    });
    const response = await send({ thinking: { type: 'disabled' }, ...google({ include_thoughts: false }), stream });
    expect(response.status).toBe(target === 'google' ? 400 : 200);
    if (target === 'google') expectLocalRejectionIsolation();
    else expect(h.fetchMock.calls).toHaveLength(1);
  });

  it.each([false, true])('does not disguise an upstream-rejected explicit budget as a successful level, stream=%s', async (stream) => {
    h.fetchMock.setHandler(async (_url, init) => {
      const body = JSON.parse(init.body as string);
      if (body.extra_body?.google?.thinking_config?.thinking_budget !== 4096) return reject('Budget was lost');
      return reject('This model does not support an explicit thinking budget');
    });
    const response = await send({ reasoning: { max_tokens: 4096 }, stream });
    expect(response.status).toBe(400);
    expect(h.fetchMock.calls).toHaveLength(1);
    expect((h.fetchMock.calls[0].body.extra_body as Body).google.thinking_config).toEqual({ thinking_budget: 4096 });
    expect(response.text).toContain('thinking budget');
  });

  it.each([0, -1, 4096])('preserves explicit budget %s on a budget-compatible node', async (budget) => {
    node.request_compatibility = { chat_reasoning_format: 'google-thinking-budget' };
    h.fetchMock.setHandler(async (_url, init) => {
      const body = JSON.parse(init.body as string);
      return body.extra_body?.google?.thinking_config?.thinking_budget === budget ? answer(false) : reject('Budget changed');
    });
    expect((await send({ model: 'gemini-2.5-flash', ...google({ thinking_budget: budget }) })).status).toBe(200);
    expect(h.fetchMock.calls).toHaveLength(1);
  });

  it.each([false, true].flatMap((stream) => ['gemini-4-argon', 'gemini-2.5-flash'].map((model) => ({ stream, model }))))
 ('native Gemini endpoint gets generationConfig for $model, stream=$stream', async ({ model, stream }) => {
    node.protocol = 'gemini';
    node.endpoint = '/v1beta/models/:model:generateContent';
    h.fetchMock.setHandler(async (_url, init) => {
      const body = JSON.parse(init.body as string);
      const config = body.generationConfig?.thinkingConfig;
      const valid = model === 'gemini-4-argon' ? config?.thinkingLevel?.toLowerCase() === 'high' && config.thinkingBudget === undefined
        : config?.thinkingBudget === 3072 && config.thinkingLevel === undefined;
      if (!valid || body.reasoning_effort !== undefined || body.extra_body !== undefined) return reject('Wrong Gemini native generationConfig');
      const result = { candidates: [{ content: { role: 'model', parts: [{ text: 'Native reasoning accepted.' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 } };
      return stream ? sse([result], false) : json(result);
    });
    const response = await send({ model, reasoning_effort: 'high', stream });
    expect(response.status).toBe(200);
    expect(stream ? response.text : response.body.choices[0].message.content).toContain('Native reasoning accepted.');
    expect(h.fetchMock.calls[0].url).toContain(`/models/${model}:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`);
  });

  it.each([false, true])('reasoning and late parallel signatures survive two HTTP turns, stream=%s', async (stream) => {
    const signatures = [' synthetic:first+/==\n签名\t', 'synthetic:second+/=='];
    const calls = signatures.map((signature, index) => ({ id: `call_${index}`, type: 'function', function: { name: 'lookup', arguments: JSON.stringify({ city: `TestCity${index}` }) }, extra_content: { google: { thought_signature: signature } } }));
    const statuses: number[] = [];
    h.fetchMock.setHandler(async (_url, init) => {
      const body = JSON.parse(init.body as string);
      if (!hasLevel(body, 'high')) { statuses.push(400); return reject('Reasoning control lost'); }
      const assistant = body.messages.find((message: Body) => message.role === 'assistant');
      if (assistant) {
        const valid = calls.every((call, index) => assistant.tool_calls?.find((tool: Body) => tool.id === call.id)?.extra_content?.google?.thought_signature === signatures[index]);
        if (!valid) { statuses.push(400); return reject('Signature lost or cross-associated'); }
        statuses.push(200);
        return answer(stream);
      }
      statuses.push(200);
      return stream ? sse([
        frame({ tool_calls: calls.map(({ extra_content: _signature, ...call }, index) => ({ ...call, index })) }),
        frame({}, 'tool_calls'),
        frame({ tool_calls: calls.map((call, index) => ({ index, extra_content: call.extra_content })).reverse() }),
      ]) : json({ id: 'synthetic', model: models[0], choices: [{ message: { role: 'assistant', content: null, tool_calls: calls }, finish_reason: 'tool_calls' }] });
    });
    const first = await send({ reasoning_effort: 'high', stream });
    expect(first.status).toBe(200);
    let assistant: Body;
    if (stream) {
      const tools = new Map<number, Body>();
      const details: Body[] = [];
      for (const line of first.text.split('\n').filter((line: string) => line.startsWith('data: {'))) {
        const delta = JSON.parse(line.slice(6)).choices?.[0]?.delta;
        for (const call of delta?.tool_calls || []) {
          const { index, ...fields } = call;
          const previous = tools.get(index) || {};
          tools.set(index, { ...previous, ...fields, function: { ...previous.function, ...fields.function } });
        }
        details.push(...delta?.reasoning_details || []);
      }
      assistant = { role: 'assistant', content: null, tool_calls: [...tools].sort(([a], [b]) => a - b).map(([, call]) => call), reasoning_details: details };
    } else assistant = first.body.choices[0].message;
    expect(assistant.tool_calls).toEqual(calls);
    for (const [index, call] of calls.entries()) expect(assistant.reasoning_details.find((detail: Body) => detail.id === call.id)?.data).toBe(signatures[index]);
    // Pi only replays OR envelopes; do not mask a broken bridge by replaying both dialects.
    for (const call of assistant.tool_calls) delete call.extra_content;
    const second = await send({ reasoning: { effort: 'high' }, stream,
      messages: [user, assistant, ...calls.map((call) => ({ role: 'tool', tool_call_id: call.id, content: '23' }))] });
    expect(second.status).toBe(200);
    expect(statuses).toEqual([200, 200]);
    expect(h.fetchMock.calls).toHaveLength(2);
  });
});

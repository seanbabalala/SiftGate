import { readFileSync } from 'node:fs';
import * as yaml from 'js-yaml';
import { ChatCompletionsNormalizer } from '../../src/canonical/normalizers/chat-completions.normalizer';
import { GeminiDenormalizer } from '../../src/canonical/denormalizers/gemini.denormalizer';
import { resolveReasoningForwarding } from '../../src/canonical/reasoning-effort';
import { ConfigService } from '../../src/config/config.service';
import { NodeConfig } from '../../src/config/gateway.config';
import { validateConfigObject } from '../../src/config/config-validator';
import { ProviderClientService } from '../../src/providers/provider-client.service';
import { TelemetryService } from '../../src/telemetry/telemetry.service';

type Body = Record<string, any>;
type Mode = 'auto' | 'openai' | 'openrouter' | 'google-thinking-level' | 'google-thinking-budget';
const normalizer = new ChatCompletionsNormalizer();
const gemini = new GeminiDenormalizer();
const routing = { tier: 'standard' as const, score: 0, is_fallback: false };
const inputs = ['openai', 'openrouter'] as const;
const efforts = ['low', 'medium', 'high'] as const;
const levelModels = ['gemini-4-argon', 'gemini-3.8-flash', 'gemini-3.8-pro', 'gemini-3-pro-preview', 'gemini-3-flash-preview'];
const control = (dialect: string, effort: string): Body => dialect === 'openai' ? { reasoning_effort: effort } : { reasoning: { effort } };
const google = (thinking: Body): Body => ({ extra_body: { google: { thinking_config: thinking } } });
const request = (fields: Body = {}): Body => ({ model: 'gemini-4-argon', messages: [{ role: 'user', content: 'Synthetic reasoning fixture.' }], ...fields });

// Provider forwarding legitimately adds credential-attempt telemetry to metadata;
// input, canonical reasoning/messages and source/raw data must remain unchanged.
function sourceSnapshot(canonical: ReturnType<typeof normalizer.normalize>): string {
  return JSON.stringify({ messages: canonical.messages, reasoning: canonical.reasoning,
    reasoning_effort: canonical.reasoning_effort, thinking: canonical.thinking, budget_tokens: canonical.budget_tokens,
    source: canonical.metadata.source_format, original_model: canonical.metadata.original_model,
    raw_body: canonical.metadata.raw_body, raw_headers: canonical.metadata.raw_headers });
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

function nodeFor(options: { model?: string; wireModel?: string; base?: string; mode?: Mode; defaults?: Body; protocol?: 'chat_completions' | 'gemini' } = {}): NodeConfig {
  const model = options.model || 'gemini-4-argon';
  return {
    id: 'reasoning-fixture', name: 'Synthetic reasoning fixture', protocol: options.protocol || 'chat_completions',
    base_url: options.base || 'https://generativelanguage.googleapis.com/v1beta/openai', endpoint: '/chat/completions',
    api_key: 'synthetic-upstream-key', models: [model], timeout_ms: 1000,
    ...(options.wireModel ? { upstream_model_aliases: { [model]: options.wireModel } } : {}),
    request_compatibility: { chat_reasoning_format: options.mode, default_parameters: options.defaults },
  } as NodeConfig;
}

function client(node: NodeConfig) {
  return new ProviderClientService({ getNode: () => node } as unknown as ConfigService, new TelemetryService());
}

describe('Gemini reasoning wire compatibility', () => {
  let fetchMock: jest.SpyInstance;
  beforeEach(() => {
    fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
      id: 'synthetic', choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
    }), { headers: { 'content-type': 'application/json' } }));
  });
  afterEach(() => { fetchMock.mockRestore(); });

  async function forward(fields: Body, options: Parameters<typeof nodeFor>[0] = {}): Promise<Body> {
    const node = nodeFor(options);
    await client(node).forward(normalizer.normalize(request(fields), {}), node.id, options.model || 'gemini-4-argon', routing);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    return JSON.parse(fetchMock.mock.calls[0][1].body);
  }

  it.each(levelModels.flatMap((model) => inputs.flatMap((dialect) => efforts.map((effort) => ({ model, dialect, effort })))))
 ('auto converts $model $dialect $effort into native Google level', async ({ model, dialect, effort }) => {
    const wire = await forward(control(dialect, effort), { model });
    expect(wire.extra_body.google.thinking_config).toEqual({ thinking_level: effort });
    expect(wire).not.toHaveProperty('reasoning_effort');
    expect(wire).not.toHaveProperty('reasoning');
    expect(wire).not.toHaveProperty('thinking_config');
  });

  it.each(['gemini-4-argon', 'gemini-3.8-flash', 'gemini-3.8-pro', 'gemini-3-pro-preview'].flatMap((model) =>
    [['minimal', 'low'], ['xhigh', 'high'], ['max', 'high']].map(([effort, level]) => ({ model, effort, level }))))
 ('maps $model $effort to supported level $level', async ({ model, effort, level }) => {
    expect((await forward({ reasoning_effort: effort }, { model })).extra_body.google.thinking_config).toEqual({ thinking_level: level });
  });

  it.each(['gemini-3-flash-preview', 'gemini-3.1-flash-lite-preview'])('preserves minimal for capable Flash model %s', async (model) => {
    expect((await forward({ reasoning_effort: 'minimal' }, { model })).extra_body.google.thinking_config).toEqual({ thinking_level: 'minimal' });
  });

  it.each(['gpt-4o', 'gemini-2.5-flash', 'gemini-2.5-pro', 'opaque-alias', 'my-gemini-4-argon', 'gemini-30-pro'].flatMap((model) =>
    inputs.map((dialect) => ({ model, dialect }))))('does not change legacy $model $dialect Chat semantics', async ({ model, dialect }) => {
    const wire = await forward(control(dialect, 'high'), { model });
    expect(wire.reasoning_effort).toBe('high');
    expect(wire.extra_body?.google?.thinking_config).toBeUndefined();
    expect(wire.reasoning).toBeUndefined();
  });

  it.each([
    { model: 'public-alias', wireModel: 'gemini-4-argon', level: true },
    { model: 'gemini-4-argon', wireModel: 'opaque-upstream-alias', level: false },
    { model: 'gemini-4-argon', wireModel: 'gemini-2.5-pro', level: false },
  ])('selects by WIRE model $wireModel, not public name $model', async ({ model, wireModel, level }) => {
    const wire = await forward({ reasoning_effort: 'high' }, { model, wireModel });
    expect(wire.model).toBe(wireModel);
    if (level) {
      expect(wire.extra_body.google.thinking_config.thinking_level).toBe('high');
      expect(wire.reasoning_effort).toBeUndefined();
    } else {
      expect(wire.reasoning_effort).toBe('high');
      expect(wire.extra_body?.google?.thinking_config).toBeUndefined();
    }
  });

  it.each(['https://openrouter.ai/api/v1', 'https://OPENROUTER.AI/api/v1'].flatMap((base) => inputs.map((dialect) => ({ base, dialect }))))
 ('keeps $dialect reasoning native at exact OpenRouter host $base', async ({ base, dialect }) => {
    const wire = await forward(control(dialect, 'high'), { base });
    expect(wire.reasoning).toEqual({ effort: 'high' });
    expect(wire.reasoning_effort).toBeUndefined();
    expect(wire.extra_body?.google?.thinking_config).toBeUndefined();
  });

  it.each(['https://openrouter.ai.example.invalid/api/v1', 'https://proxy.example.invalid/openrouter.ai', 'https://openrouter.ai@proxy.example.invalid'])
 ('does not infer OpenRouter from a lookalike URL %s', async (base) => {
    const wire = await forward({ reasoning: { effort: 'high' } }, { base });
    expect(wire.reasoning_effort).toBe('high');
    expect(wire.extra_body?.google?.thinking_config).toBeUndefined();
    expect(wire.reasoning).toBeUndefined();
  });

  it.each([
    'https://generativelanguage.googleapis.com/v1beta/openai',
    'https://aiplatform.googleapis.com/v1',
    'https://us-central1-aiplatform.googleapis.com/v1',
  ])('automatically selects Google level only on official host %s', async (base) => {
    const wire = await forward({ reasoning_effort: 'high' }, { base });
    expect(wire.extra_body.google.thinking_config).toEqual({ thinking_level: 'high' });
    expect(wire.reasoning_effort).toBeUndefined();
  });

  it.each([
    'https://private-proxy.invalid/v1',
    'https://generativelanguage.googleapis.com.attacker.invalid',
    'https://attacker.invalid/generativelanguage.googleapis.com',
    'https://aiplatform.googleapis.com.attacker.invalid',
  ])('unknown/lookalike host %s retains historical Chat effort in auto mode', async (base) => {
    const wire = await forward({ reasoning_effort: 'high' }, { base });
    expect(wire.reasoning_effort).toBe('high');
    expect(wire.extra_body?.google?.thinking_config).toBeUndefined();
  });

  it.each([
    { mode: 'auto', model: 'gemini-4-argon', base: 'https://synthetic.invalid', expected: 'openai' },
    { mode: 'openai', model: 'gemini-4-argon', base: 'https://synthetic.invalid', expected: 'openai' },
    { mode: 'openai', model: 'gemini-4-argon', base: 'https://openrouter.ai/api/v1', expected: 'openai' },
    { mode: 'openrouter', model: 'opaque-alias', base: 'https://private-router.invalid', expected: 'openrouter' },
    { mode: 'google-thinking-level', model: 'opaque-alias', base: 'https://synthetic.invalid', expected: 'level' },
    { mode: 'google-thinking-level', model: 'gemini-4-argon', base: 'https://openrouter.ai/api/v1', expected: 'level' },
    { mode: 'google-thinking-budget', model: 'opaque-alias', base: 'https://synthetic.invalid', expected: 'budget' },
  ])('honors explicit $mode override for $model at $base', async ({ mode, model, base, expected }) => {
    const wire = await forward({ reasoning: { effort: 'high' } }, { mode: mode as Mode, model, base });
    if (expected === 'openai') expect(wire.reasoning_effort).toBe('high');
    else if (expected === 'openrouter') expect(wire.reasoning).toEqual({ effort: 'high' });
    else expect(wire.extra_body.google.thinking_config).toEqual(expected === 'level' ? { thinking_level: 'high' } : { thinking_budget: 3072 });
  });

  it.each([
    { effort: 'high', enabled: true, exclude: true },
    { max_tokens: 4096, enabled: true, exclude: false },
    { enabled: false, exclude: true },
    { effort: 'none' },
  ])('preserves complete native OR controls %j without mutation', async (reasoning) => {
    const body = freeze(request({ reasoning, extra_body: { vendor: { untouched: [1, 2] } } }));
    const before = JSON.stringify(body);
    const canonical = normalizer.normalize(body, {});
    const node = nodeFor({ base: 'https://openrouter.ai/api/v1' });
    await client(node).forward(canonical, node.id, 'gemini-4-argon', routing);
    const wire = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(wire.reasoning).toEqual(reasoning);
    expect(wire.reasoning_effort).toBeUndefined();
    expect(wire.extra_body).toEqual(body.extra_body);
    expect(JSON.stringify(body)).toBe(before);
  });

  it('merges the level without losing unrelated extra_body/google fields or mutating input/canonical', async () => {
    const body = freeze(request({ reasoning_effort: 'high', extra_body: { vendor: { labels: ['fixture'] }, google: { custom_option: 'retained' } } }));
    const canonical = normalizer.normalize(body, {});
    const before = sourceSnapshot(canonical);
    const node = nodeFor();
    await client(node).forward(canonical, node.id, 'gemini-4-argon', routing);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).extra_body).toEqual({
      vendor: { labels: ['fixture'] }, google: { custom_option: 'retained', thinking_config: { thinking_level: 'high' } },
    });
    expect(sourceSnapshot(canonical)).toBe(before);
  });

  it.each(inputs)('client %s high overrides conflicting DEFAULT strengths without losing default include_thoughts', async (dialect) => {
    const wire = await forward(control(dialect, 'high'), { defaults: {
      extra_body: { google: { thinking_config: { thinking_level: 'low', thinking_budget: 0, include_thoughts: true }, sibling: 'keep' }, unrelated: ['keep'] },
    } });
    expect(wire.extra_body).toEqual({ google: { thinking_config: { thinking_level: 'high', include_thoughts: true }, sibling: 'keep' }, unrelated: ['keep'] });
    expect(wire.reasoning_effort).toBeUndefined();
    expect(wire.reasoning).toBeUndefined();
  });

  it('explicit visibility beats a semantically equivalent default in a different dialect', async () => {
    const wire = await forward({ reasoning: { effort: 'high', exclude: true } }, { defaults: google({ thinking_level: 'low', include_thoughts: true }) });
    expect(wire.extra_body.google.thinking_config).toEqual({ thinking_level: 'high', include_thoughts: false });
  });

  it('explicit native budget replaces a default level without inventing a level or losing include_thoughts', async () => {
    const wire = await forward(google({ thinking_budget: -1 }), { defaults: google({ thinking_level: 'low', include_thoughts: true }) });
    expect(wire.extra_body.google.thinking_config).toEqual({ thinking_budget: -1, include_thoughts: true });
  });

  it.each([
    { thinking_level: 'low', include_thoughts: true },
    { thinking_level: 'high', include_thoughts: false, provider_extension: 'opaque' },
  ])('preserves explicit Google config %j and recognizes its reasoning intent', async (config) => {
    const fields = google(config);
    const canonical = normalizer.normalize(request(fields), {});
    expect(canonical.reasoning?.requested).toBe(true);
    expect(canonical.reasoning?.source).toBe('gemini.thinking_config');
    expect(resolveReasoningForwarding(canonical.reasoning, 'chat_completions', 'chat_completions', null).requested).toBe(true);
    expect((await forward(fields)).extra_body.google.thinking_config).toEqual(config);
  });

  it.each(['google', 'openrouter', 'native'].flatMap((target) => [true, false].flatMap((include) => [
    { target, include, dialect: 'OR effort + Google visibility', fields: { reasoning: { effort: 'high' }, ...google({ include_thoughts: include }) } },
    { target, include, dialect: 'OpenAI effort + OR visibility', fields: { reasoning_effort: 'high', reasoning: { exclude: !include } } },
  ])))('preserves mixed $dialect strength AND visibility=$include on $target', async ({ target, include, fields }) => {
    const mixed: Body = fields;
    const wire = await forward({ ...mixed, extra_body: { ...mixed.extra_body, vendor: { keep: ['fixture'] } } },
      target === 'native' ? { protocol: 'gemini' } : { mode: target === 'google' ? 'google-thinking-level' : 'openrouter' });
    if (target === 'native') {
      expect(wire.generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'high', includeThoughts: include });
      expect(wire.reasoning).toBeUndefined();
      expect(wire.extra_body).toBeUndefined();
    } else {
      expect(wire.extra_body.vendor).toEqual({ keep: ['fixture'] });
      if (target === 'google') {
        expect(wire.extra_body.google.thinking_config).toEqual({ thinking_level: 'high', include_thoughts: include });
        expect(wire.reasoning).toBeUndefined();
      } else {
        expect(wire.reasoning).toEqual({ effort: 'high', exclude: !include });
        expect(wire.extra_body.google?.thinking_config).toBeUndefined();
      }
    }
    expect(wire.reasoning_effort).toBeUndefined();
  });

  it.each(['google', 'openrouter'].flatMap((target) => [
    { target, config: { thinking_level: 'high' }, expectedRouter: { effort: 'high', exclude: true } },
    { target, config: { thinking_budget: 2048 }, expectedRouter: { max_tokens: 2048, exclude: true } },
  ]))('native Google $config plus OR exclude preserves strength/visibility on $target', async ({ target, config, expectedRouter }) => {
    const wire = await forward({ ...google(config), reasoning: { exclude: true } }, { mode: target === 'google' ? 'google-thinking-level' : 'openrouter' });
    if (target === 'google') {
      expect(wire.extra_body.google.thinking_config).toEqual({ ...config, include_thoughts: false });
      expect(wire.reasoning).toBeUndefined();
    } else {
      expect(wire.reasoning).toEqual(expectedRouter);
      expect(wire.extra_body?.google?.thinking_config).toBeUndefined();
    }
    expect(wire.reasoning_effort).toBeUndefined();
  });

  it.each(['google', 'openrouter'])('explicit disabled is not shadowed by Google include-only config on %s', async (target) => {
    const fields = { thinking: { type: 'disabled' }, ...google({ include_thoughts: false }) };
    expect(normalizer.normalize(request(fields), {}).reasoning).toMatchObject({ requested: true, effort: 'none' });
    if (target === 'google') {
      await expect(forward(fields, { mode: 'google-thinking-level' })).rejects.toMatchObject({ statusCode: 400 });
      expect(fetchMock).not.toHaveBeenCalled();
    } else {
      const wire = await forward(fields, { mode: 'openrouter' });
      expect(wire.reasoning).toEqual({ effort: 'none', exclude: true });
      expect(wire.extra_body?.google?.thinking_config).toBeUndefined();
      expect(wire.reasoning_effort).toBeUndefined();
    }
  });

  it.each([0, -1, 4096])('recognizes and preserves native Google budget sentinel/value %s', async (budget) => {
    const config = { thinking_budget: budget, include_thoughts: false };
    const canonical = normalizer.normalize(request(google(config)), {});
    expect(canonical.reasoning).toMatchObject({ requested: true, budget_tokens: budget });
    expect(resolveReasoningForwarding(canonical.reasoning, 'chat_completions', 'gemini', null).budget_tokens).toBe(budget);
    const wire = await forward(google(config), { model: 'gemini-2.5-flash', mode: 'google-thinking-budget' });
    expect(wire.extra_body.google.thinking_config).toEqual(config);
    expect(wire.reasoning_effort).toBeUndefined();
  });

  it.each([
    { reasoning_effort: 'high', ...google({ thinking_level: 'low' }) },
    { reasoning: { effort: 'high' }, ...google({ thinking_budget: 2048 }) },
    { reasoning_effort: 'high', thinking_config: { thinking_budget: 1024 } },
    { reasoning_effort: 'high', reasoning: { effort: 'low' } },
    { reasoning_effort: 'none' },
    { reasoning: { effort: 'none' } },
    { reasoning: { enabled: false } },
    { thinking: { type: 'disabled' } },
  ])('rejects conflicting/unrepresentable level-only controls %j BEFORE inference', async (fields) => {
    await expect(forward(fields)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { ...google({ thinking_level: 'low' }), thinking_config: { thinking_level: 'high' } },
    { ...google({ thinking_budget: 0 }), thinkingConfig: { thinkingBudget: 2048 } },
    { generationConfig: { thinkingConfig: { thinkingLevel: 'high' } }, generation_config: { thinking_config: { thinking_level: 'low' } } },
    { thinking_config: { thinking_level: 'high' }, thinkingConfig: { thinkingBudget: 4096 } },
    { ...google({ include_thoughts: true }), thinking_config: { includeThoughts: false } },
    { ...google({ include_thoughts: true }), thinking_config: { thinking_budget: 0 }, reasoning_effort: 'high' },
    google({ thinking_level: 'high', thinkingLevel: 'low' }),
    google({ thinking_budget: 0, thinkingBudget: -1 }),
    google({ include_thoughts: true, includeThoughts: false }),
  ])('rejects conflicting native envelopes/aliases %j without choosing the first one', (fields) => {
    const body = freeze(request(fields));
    const before = JSON.stringify(body);
    expect(() => normalizer.normalize(body, {})).toThrow();
    expect(JSON.stringify(body)).toBe(before);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([0, -1, 4096])('keeps explicit native budget %s provider-validated even on level models', async (budget) => {
    const wire = await forward(google({ thinking_budget: budget }));
    expect(wire.extra_body.google.thinking_config).toEqual({ thinking_budget: budget });
    expect(wire.extra_body.google.thinking_config).not.toHaveProperty('thinking_level');
  });

  it('preserves explicit OR max_tokens as a budget, never as a supposedly exact level', async () => {
    const wire = await forward({ reasoning: { max_tokens: 4096, enabled: true, exclude: true } });
    expect(wire.extra_body.google.thinking_config).toEqual({ thinking_budget: 4096, include_thoughts: false });
    expect(wire.reasoning).toBeUndefined();
    expect(wire.reasoning_effort).toBeUndefined();
  });

  it('uses the provider default when OR only enables reasoning on a level model', async () => {
    const wire = await forward({ reasoning: { enabled: true } });
    expect(wire.extra_body?.google?.thinking_config?.thinking_level).toBeUndefined();
    expect(wire.extra_body?.google?.thinking_config?.thinking_budget).toBeUndefined();
    expect(wire.reasoning).toBeUndefined();
    expect(wire.reasoning_effort).toBeUndefined();
  });

  it.each(levelModels.flatMap((model) => efforts.map((effort) => ({ model, effort }))))
 ('native Gemini $model uses thinkingLevel for $effort, never a fabricated budget', ({ model, effort }) => {
    const canonical = normalizer.normalize(request({ reasoning_effort: effort }), {});
    const body = gemini.denormalize(canonical, model) as Body;
    expect(body.generationConfig.thinkingConfig.thinkingLevel.toLowerCase()).toBe(effort);
    expect(body.generationConfig.thinkingConfig).not.toHaveProperty('thinkingBudget');
    expect(body).not.toHaveProperty('extra_body');
  });

  it.each(['gemini-2.5-pro', 'gemini-2.5-flash'].flatMap((model) =>
    [['none', 0], ['low', 1024], ['medium', 2048], ['high', 3072]].map(([effort, budget]) => ({ model, effort, budget }))))
 ('native older Gemini $model retains $effort budget $budget', ({ model, effort, budget }) => {
    const body = gemini.denormalize(normalizer.normalize(request({ reasoning_effort: effort }), {}), model) as Body;
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingBudget: budget });
  });

  it.each([0, -1, 4096])('native Gemini preserves explicit budget %s and includeThoughts', (budget) => {
    const body = gemini.denormalize(normalizer.normalize(request(google({ thinking_budget: budget, include_thoughts: true })), {}), 'gemini-2.5-flash') as Body;
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingBudget: budget, includeThoughts: true });
  });

  it.each(['google', 'openrouter'])('reasoning adaptation never changes raw/source %s tool signatures', async (dialect) => {
    const signature = ' synthetic:+/opaque==\n签名\t';
    const call = { id: 'call_0', type: 'function', function: { name: 'lookup', arguments: '{"value":1}' },
      ...(dialect === 'google' ? { extra_content: { google: { thought_signature: signature } } } : {}) };
    const assistant = { role: 'assistant', content: null, tool_calls: [call],
      ...(dialect === 'openrouter' ? { reasoning_details: [{ type: 'reasoning.encrypted', id: call.id, data: signature, format: 'google-gemini-v1', index: 7 }] } : {}) };
    const body = freeze(request({ reasoning: { effort: 'high' }, messages: [assistant, { role: 'tool', tool_call_id: call.id, content: '1' }] }));
    const canonical = normalizer.normalize(body, {});
    const before = sourceSnapshot(canonical);
    const node = nodeFor();
    await client(node).forward(canonical, node.id, 'gemini-4-argon', routing);
    const wire = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(wire.extra_body.google.thinking_config.thinking_level).toBe('high');
    expect(wire.messages[0].tool_calls[0].extra_content.google.thought_signature).toBe(signature);
    expect(canonical.metadata.raw_body).toEqual(body);
    expect(canonical.metadata.source_format).toBe('chat_completions');
    expect(sourceSnapshot(canonical)).toBe(before);
  });

  it.each([false, true])('reuses one canonical safely across Google → OR → Google forwarding (first fails=%s)', async (failFirst) => {
    const signature = ' synthetic:replayed+/==\n签名\t';
    const detail = { type: 'reasoning.encrypted', id: 'call_repeat', data: signature, format: 'google-gemini-v1', index: 9 };
    const body = freeze(request({ reasoning: { effort: 'high', exclude: true }, extra_body: { vendor: { preserved: ['fixture'] } }, messages: [
      { role: 'assistant', content: null, tool_calls: [{ id: detail.id, type: 'function', function: { name: 'lookup', arguments: '{"value":1}' } }], reasoning_details: [detail] },
      { role: 'tool', tool_call_id: detail.id, content: '1' },
    ] }));
    const canonical = normalizer.normalize(body, {});
    const before = sourceSnapshot(canonical);
    const googleNode = nodeFor({ defaults: google({ thinking_level: 'low', thinking_budget: 0, include_thoughts: true }) });
    const routerNode = nodeFor({ base: 'https://openrouter.ai/api/v1' });
    if (failFirst) fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({ error: { message: 'Synthetic upstream refusal' } }), { status: 400 }));
    const first = client(googleNode).forward(canonical, googleNode.id, 'gemini-4-argon', routing);
    if (failFirst) await expect(first).rejects.toMatchObject({ statusCode: 400 });
    else await first;
    expect(sourceSnapshot(canonical)).toBe(before);
    await client(routerNode).forward(canonical, routerNode.id, 'gemini-4-argon', { ...routing, is_fallback: failFirst });
    expect(sourceSnapshot(canonical)).toBe(before);
    await client(googleNode).forward(canonical, googleNode.id, 'gemini-4-argon', routing);
    expect(sourceSnapshot(canonical)).toBe(before);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const wires = fetchMock.mock.calls.map((call) => JSON.parse(call[1].body));
    expect(wires[0]).toEqual(wires[2]);
    expect(wires[0].extra_body.google.thinking_config).toEqual({ thinking_level: 'high', include_thoughts: false });
    expect(wires[0].messages[0].tool_calls[0].extra_content.google.thought_signature).toBe(signature);
    expect(wires[1].reasoning).toEqual({ effort: 'high', exclude: true });
    expect(wires[1].extra_body).toEqual({ vendor: { preserved: ['fixture'] } });
    expect(wires[1].messages[0].reasoning_details).toEqual([detail]);
    expect(wires[1].messages[0].tool_calls[0].extra_content).toBeUndefined();
    expect(wires[1].reasoning_effort).toBeUndefined();
    expect(googleNode.request_compatibility?.default_parameters).toEqual(google({ thinking_level: 'low', thinking_budget: 0, include_thoughts: true }));
  });

  it('does not add reasoning controls to a request that did not ask for them', async () => {
    const wire = await forward({});
    expect(wire).not.toHaveProperty('reasoning');
    expect(wire).not.toHaveProperty('reasoning_effort');
    expect(wire.extra_body?.google?.thinking_config).toBeUndefined();
  });

  it.each(['auto', 'openai', 'openrouter', 'google-thinking-level', 'google-thinking-budget', 'google', '', null, [], 42])
 ('validates chat_reasoning_format=%j', (mode) => {
    const config = yaml.load(readFileSync('test/fixtures/config-validator/valid.gateway.yaml', 'utf8')) as { nodes: Body[] };
    config.nodes[0].request_compatibility = { chat_reasoning_format: mode };
    const errors = validateConfigObject(config, { env: {} }).errors;
    expect(errors.some((error) => `${error.code} ${error.path}`.includes('chat_reasoning_format')))
      .toBe(!['auto', 'openai', 'openrouter', 'google-thinking-level', 'google-thinking-budget'].includes(String(mode)));
  });
});

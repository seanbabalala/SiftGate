import { createE2EHarness, E2EHarness, API_KEY } from './setup';
import { ConfigService } from '../../src/config/config.service';
import { PromptCacheService } from '../../src/cache/prompt-cache.service';
import { isDeepStrictEqual } from 'node:util';

const model = 'gemini-signature-test';
// Synthetic opaque state. The mock provider rejects missing/changed signatures.
const signatures = ['  synthetic:first+/==\n签名\t', 'synthetic:second=='];
const standard = (thought_signature: string) => ({ extra_content: { google: { thought_signature } } });
const alternate = (thought_signature: string) => ({ provider_specific_fields: { thought_signature } });
const calls = signatures.map((signature, index) => ({
  id: `call_${index}`, type: 'function',
  function: { name: 'get_temperature', arguments: JSON.stringify({ city: `TestCity${index}` }) },
  ...standard(signature),
}));
const user = { role: 'user', content: 'Compare temperatures using both tool results.' };
const tools = [{ type: 'function', function: {
  name: 'get_temperature', description: 'Synthetic temperature lookup',
  parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
} }];

function sse(objects: unknown[], done = true) {
  const wire = objects.map((object) => `data: ${JSON.stringify(object)}\n\n`).join('')
    + (done ? 'data: [DONE]\n\n' : '');
  return new Response(new ReadableStream({
    start(controller) {
      const bytes = new TextEncoder().encode(wire);
      for (let i = 0; i < bytes.length; i += 13) controller.enqueue(bytes.slice(i, i + 13));
      controller.close();
    },
  }), { headers: { 'Content-Type': 'text/event-stream' } });
}

function frame(tool_calls: unknown[]) {
  return { id: 'test', model, choices: [{ delta: { tool_calls }, finish_reason: null }] };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function collectTools(wire: string) {
  const collected: Record<string, unknown>[] = [];
  for (const line of wire.split('\n')) {
    if (!line.startsWith('data: {')) continue;
    const chunk = JSON.parse(line.slice(6));
    for (const delta of chunk.choices?.[0]?.delta?.tool_calls || []) {
      const tool = collected[delta.index] ??= { function: { name: '', arguments: '' } };
      if (delta.id) tool.id = delta.id;
      if (delta.type) tool.type = delta.type;
      const fn = tool.function as { name: string; arguments: string };
      if (delta.function?.name) fn.name += delta.function.name;
      if (delta.function?.arguments) fn.arguments += delta.function.arguments;
      if (delta.extra_content !== undefined) tool.extra_content = delta.extra_content;
    }
  }
  return collected;
}

describe('Gemini Chat Completions signature two-turn HTTP contract', () => {
  let h: E2EHarness;
  beforeAll(async () => {
    h = await createE2EHarness();
    h.app.get(ConfigService).getNode('mock-openai')!.models.push(model);
  }, 30_000);
  afterAll(async () => { await h?.close(); });
  beforeEach(() => {
    h.fetchMock.reset();
    h.app.get(PromptCacheService).clear();
  });

  it.each([
    ['JSON standard', false, 'standard', true],
    ['JSON alternate', false, 'alternate', true],
    ['JSON both', false, 'both', true],
    ['SSE late parallel', true, 'both', true],
    ['SSE late parallel EOF', true, 'both', false],
  ] as const)('%s preserves signatures and returns 200 on the second turn', async (_label, stream, path, done) => {
    h.fetchMock.setHandler(async (_url, init) => {
      const body = JSON.parse(init.body as string);
      if (body.messages.some((message: { role: string }) => message.role === 'tool')) {
        const history = body.messages.find((message: { role: string }) => message.role === 'assistant');
        const toolResults = body.messages.filter((message: { role: string }) => message.role === 'tool');
        // Existing schema compatibility may add function.parameters to history.
        const replayed = history?.tool_calls?.map((call: typeof calls[number]) => ({
          id: call.id, type: call.type,
          function: { name: call.function.name, arguments: call.function.arguments },
          extra_content: call.extra_content,
        }));
        if (!isDeepStrictEqual(replayed, calls)
          || toolResults.length !== 2 || toolResults.some((result: { tool_call_id: string }, i: number) => result.tool_call_id !== calls[i].id)) {
          return json({ error: { message: 'Missing or changed tool thought signature', type: 'invalid_request_error' } }, 400);
        }
        const usage = { prompt_tokens: 8, completion_tokens: 4 };
        return stream ? sse([
          { id: 'final', model, choices: [{ delta: { content: 'Both temperatures received.' }, finish_reason: null }] },
          { id: 'final', model, choices: [{ delta: {}, finish_reason: 'stop' }], usage },
        ]) : json({ id: 'final', model, choices: [{ message: { role: 'assistant', content: 'Both temperatures received.' }, finish_reason: 'stop' }], usage });
      }
      if (stream) {
        return sse([
          // Signature before ID, parallel calls with the same function name.
          frame([{ index: 1, ...alternate(signatures[1]) }]),
          frame(calls.map(({ extra_content: _signature, ...call }, index) => ({
            ...call, index, function: { ...call.function, arguments: '{"city":' },
          }))),
          frame([{ index: 1, function: { arguments: '"TestCity1"}' } }]),
          frame([{ id: 'call_0', function: { arguments: '"TestCity0"}' } }]),
          { id: 'test', model, choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 8, completion_tokens: 4 } },
          // This signature arrives after finish_reason and usage, not with args.
          frame([{ index: 0, ...standard(signatures[0]), ...alternate(signatures[0]) }]),
        ], done);
      }
      return json({ id: 'test', model, choices: [{
        message: { role: 'assistant', content: null, tool_calls: calls.map(({ extra_content: _signature, ...call }, index) => ({
          ...call, ...(path !== 'alternate' ? standard(signatures[index]) : {}),
          ...(path !== 'standard' ? alternate(signatures[index]) : {}),
        })) }, finish_reason: 'tool_calls',
      }], usage: { prompt_tokens: 8, completion_tokens: 4 } });
    });

    const first = await h.agent.post('/v1/chat/completions').set('Authorization', `Bearer ${API_KEY}`)
      .send({ model, messages: [user], tools, stream }).buffer(true);
    expect(first.status).toBe(200);
    const assistant = stream
      ? { role: 'assistant', content: null, tool_calls: collectTools(first.text) }
      : first.body.choices[0].message;
    expect(assistant.tool_calls).toEqual(calls);
    if (stream) {
      expect(first.text.lastIndexOf('thought_signature')).toBeLessThan(first.text.indexOf('[DONE]'));
      expect(first.text.match(/\[DONE\]/g)).toHaveLength(1);
    }
    const history = [user, assistant, ...calls.map((call, i) => ({ role: 'tool', tool_call_id: call.id, content: `${20 + i}` }))];
    const second = await h.agent.post('/v1/chat/completions').set('Authorization', `Bearer ${API_KEY}`)
      .send({ model, messages: history, tools, stream }).buffer(true);
    // Google upstreams receive only the Google extension; dual client output
    // must not send an OpenRouter-only message field to a strict Google API.
    expect(h.fetchMock.calls[1].body.messages).toMatchObject(history.map((message) => {
      const expected = { ...message };
      delete expected.reasoning_details;
      return expected;
    }));
    expect(second.status).toBe(200);
    expect(stream ? second.text : second.body.choices[0].message.content).toContain('Both temperatures received.');
    expect(h.fetchMock.calls).toHaveLength(2);
    if (!stream && path === 'standard') {
      const unsigned = JSON.parse(JSON.stringify(history));
      delete unsigned[1].tool_calls[0].extra_content;
      delete unsigned[1].reasoning_details;
      const rejected = await h.agent.post('/v1/chat/completions').set('Authorization', `Bearer ${API_KEY}`)
        .send({ model, messages: unsigned, tools, stream });
      expect(rejected.status).toBe(400);
    }
  });
});

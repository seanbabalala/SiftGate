import { createE2EHarness, E2EHarness, API_KEY } from './setup';
import { ConfigService } from '../../src/config/config.service';
import { PromptCacheService } from '../../src/cache/prompt-cache.service';

const model = 'gemini-router-signature-test';
const signatures = [' synthetic:first+/==\n签名\t', 'synthetic:second=='];
const google = (signature: string) => ({ extra_content: { google: { thought_signature: signature } } });
const calls = signatures.map((_signature, index) => ({ id: `call_${index}`, type: 'function', function: { name: 'lookup', arguments: JSON.stringify({ city: `TestCity${index}` }) } }));
const details = calls.map((call, index) => ({ type: 'reasoning.encrypted', id: call.id, data: signatures[index], format: 'google-gemini-v1', index: index ? 1 : 8 }));
const tools = [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }];
const user = { role: 'user', content: 'Compare synthetic cities.' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const chunk = (delta: Record<string, unknown>, finish_reason: string | null = null) => ({ id: 'test', model, choices: [{ index: 0, delta, finish_reason }] });
function sse(frames: unknown[]) {
  const wire = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(new ReadableStream({ start(controller) {
    const data = new TextEncoder().encode(wire);
    for (let offset = 0; offset < data.length; offset += 7) controller.enqueue(data.slice(offset, offset + 7));
    controller.close();
  } }), { headers: { 'content-type': 'text/event-stream' } });
}

describe('OpenRouter/Google signature HTTP compatibility', () => {
  let h: E2EHarness;
  beforeAll(async () => {
    h = await createE2EHarness();
    h.app.get(ConfigService).getNode('mock-openai')!.models.push(model);
  }, 30_000);
  afterAll(async () => { await h?.close(); });
  beforeEach(() => { h.fetchMock.reset(); h.app.get(PromptCacheService).clear(); });

  it.each(['google', 'openrouter'].flatMap((upstream) => ['google', 'openrouter'].flatMap((client) =>
    [false, true].map((stream) => ({ upstream, client, stream })),
  )))('$upstream upstream → $client client, stream=$stream completes both turns', async ({ upstream, client, stream }) => {
    const node = h.app.get(ConfigService).getNode('mock-openai')!;
    node.request_compatibility = { chat_tool_signatures: upstream as 'google' | 'openrouter' };
    h.fetchMock.setHandler(async (_url, init) => {
      const body = JSON.parse(init.body as string);
      const assistant = body.messages.find((message: { role: string }) => message.role === 'assistant');
      if (assistant) {
        const replay = calls.map((call) => upstream === 'google'
          ? assistant.tool_calls?.find((c: { id: string }) => c.id === call.id)?.extra_content?.google?.thought_signature
          : assistant.reasoning_details?.find((d: { id: string }) => d.id === call.id)?.data);
        const unexpected = upstream === 'google' ? assistant.reasoning_details !== undefined
          : assistant.tool_calls.some((call: { extra_content?: unknown }) => call.extra_content !== undefined);
        if (unexpected || !replay.every((signature, index) => signature === signatures[index]))
          return json({ error: { type: 'invalid_request_error', message: 'Missing/changed signature or wrong upstream dialect' } }, 400);
        return stream ? sse([chunk({ content: 'Both results received.' }, 'stop')])
          : json({ id: 'final', model, choices: [{ message: { role: 'assistant', content: 'Both results received.' }, finish_reason: 'stop' }] });
      }
      if (!stream) return json({ id: 'test', model, choices: [{ message: {
        role: 'assistant', content: null,
        tool_calls: calls.map((call, index) => ({ ...call, ...(upstream === 'google' ? google(signatures[index]) : {}) })),
        ...(upstream === 'openrouter' ? { reasoning_details: [...details].reverse() } : {}),
      }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 7, completion_tokens: 4 } });
      return sse([
        // Both dialects can deliver signatures before the tool ID/name frame.
        chunk(upstream === 'google' ? { tool_calls: signatures.map((signature, index) => ({ index, ...google(signature) })) }
          : { reasoning_details: [...details].reverse() }),
        chunk({ tool_calls: calls.map((call, index) => ({ ...call, index })) }),
        { ...chunk({}, 'tool_calls'), usage: { prompt_tokens: 7, completion_tokens: 4 } },
      ]);
    });
    const first = await h.agent.post('/v1/chat/completions').set('Authorization', `Bearer ${API_KEY}`)
      .send({ model, messages: [user], tools, stream }).buffer(true);
    expect(first.status).toBe(200);
    let assistant: Record<string, unknown>;
    if (stream) {
      const collected = new Map<number, Record<string, unknown>>();
      const reasoning: unknown[] = [];
      for (const line of first.text.split('\n').filter((line: string) => line.startsWith('data: {'))) {
        const delta = JSON.parse(line.slice(6)).choices?.[0]?.delta;
        if (!delta) continue;
        for (const call of delta.tool_calls || []) {
          const { index, ...fields } = call;
          collected.set(index, { ...collected.get(index), ...fields });
        }
        reasoning.push(...delta.reasoning_details || []);
      }
      assistant = { role: 'assistant', content: null, tool_calls: [...collected].sort(([a], [b]) => a - b).map(([, call]) => call), reasoning_details: reasoning };
      expect(first.text.indexOf('reasoning_details')).toBeLessThan(first.text.indexOf('[DONE]'));
      expect(first.text.match(/\[DONE\]/g)).toHaveLength(1);
    } else assistant = first.body.choices[0].message;
    expect(assistant.tool_calls).toEqual(calls.map((call, index) => ({ ...call, ...google(signatures[index]) })));
    expect(assistant.reasoning_details).toEqual(expect.arrayContaining(calls.map((call, index) => expect.objectContaining({ id: call.id, data: signatures[index] }))));
    // Emulate clients which only understand ONE dialect; do not let dual input mask a lost signature.
    if (client === 'google') delete assistant.reasoning_details;
    else assistant.tool_calls = calls;
    const messages = [user, assistant, ...calls.map((call) => ({ role: 'tool', tool_call_id: call.id, content: '23' }))];
    const second = await h.agent.post('/v1/chat/completions').set('Authorization', `Bearer ${API_KEY}`)
      .send({ model, messages, tools, stream }).buffer(true);
    expect(second.status).toBe(200);
    expect(stream ? second.text : second.body.choices[0].message.content).toContain('Both results received.');
    expect(h.fetchMock.calls).toHaveLength(2);
  });
});

import { readFileSync } from 'node:fs';
import * as yaml from 'js-yaml';
import { CanonicalStreamEvent } from '../../src/canonical/canonical.types';
import { ChatCompletionsNormalizer } from '../../src/canonical/normalizers/chat-completions.normalizer';
import { ChatCompletionsDenormalizer } from '../../src/canonical/denormalizers/chat-completions.denormalizer';
import { toolThoughtSignature, toolSignatureDetails } from '../../src/canonical/tool-thought-signature';
import { ConfigService } from '../../src/config/config.service';
import { NodeConfig } from '../../src/config/gateway.config';
import { validateConfigObject } from '../../src/config/config-validator';
import { ProviderClientService } from '../../src/providers/provider-client.service';
import { ChatCompletionsStreamParser } from '../../src/providers/stream/chat-completions.stream';
import { ChatCompletionsStreamSerializer } from '../../src/providers/stream/stream-serializers';
import { TelemetryService } from '../../src/telemetry/telemetry.service';

const signatures = [' synthetic:+/first==\n签名\t', 'synthetic:second=='];
const google = (value: string) => ({ extra_content: { google: { thought_signature: value } } });
const detail = (id: string, data: string, fields: Record<string, unknown> = {}) => ({ type: 'reasoning.encrypted', id, data, format: 'google-gemini-v1', ...fields });
const calls = signatures.map((signature, index) => ({ id: `call_${index}`, type: 'function', function: { name: 'lookup', arguments: '{"value":1}' }, ...google(signature) }));
const normalizer = new ChatCompletionsNormalizer();
const denormalizer = new ChatCompletionsDenormalizer();
const provider = new ProviderClientService({} as ConfigService, new TelemetryService());
const plainCalls = () => calls.map(({ extra_content: _signature, ...call }) => call);

function message(path: string) {
  return { role: 'assistant', content: null,
    tool_calls: path === 'openrouter' ? plainCalls() : calls,
    ...(path === 'google' ? {} : { reasoning_details: [
      detail('call_1', signatures[1], { index: 40 }), detail('call_0', signatures[0], { index: 99 }),
    ] }),
  };
}

function frame(delta: Record<string, unknown>, finish_reason: string | null = null, usage?: unknown) {
  return `data: ${JSON.stringify({ id: 'test', model: 'gemini-test', choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) })}\r\n\r\n`;
}

function stream(wire: string) {
  const parser = new ChatCompletionsStreamParser();
  const serializer = new ChatCompletionsStreamSerializer();
  const events: CanonicalStreamEvent[] = [];
  let output = '';
  const forward = (event: CanonicalStreamEvent) => { events.push(event); output += serializer.serialize(event); };
  for (let offset = 0; offset < wire.length; offset += 11) for (const event of parser.parse(wire.slice(offset, offset + 11))) forward(event);
  for (const event of parser.flush()) forward(event);
  const chunks = output.split('\n').filter((line) => line.startsWith('data: {')).map((line) => JSON.parse(line.slice(6)));
  return { events, output, chunks, details: chunks.flatMap((chunk) => chunk.choices?.[0]?.delta?.reasoning_details || []) };
}

describe('Google/OpenRouter tool signature bridge', () => {
  it.each(['history', 'response'])('indexes %s signatures once for large parallel batches', (path) => {
    let reads = 0;
    const count = 200;
    const batch = Array.from({ length: count }, (_, index) => ({ ...plainCalls()[0], id: `batch_${index}` }));
    const reasoning_details = batch.map((call) => ({
      type: 'reasoning.encrypted', id: call.id,
      get data() { reads++; return 'synthetic-parallel'; },
      format: 'google-gemini-v1',
    }));
    const message = { role: 'assistant', content: null, tool_calls: batch, reasoning_details };
    const content = path === 'history'
      ? normalizer.normalize({ messages: [message] }, {}).messages[0].content
      : provider['normalizeChatCompletionsResponse']({ choices: [{ message, finish_reason: 'tool_calls' }] },
        { tier: 'standard', score: 0, is_fallback: false }, 'test', 'gemini-test', 0).content;
    expect(reads).toBe(count * 2); // Validation + copy, not a scan for every tool.
    expect(content).toHaveLength(count);
  });
  it.each(['google', 'openrouter', 'both'])('normalizes %s JSON responses and request history by call ID, never reasoning index', (path) => {
    const source = message(path);
    const response = provider['normalizeChatCompletionsResponse']({ id: 'test', choices: [{ message: source, finish_reason: 'tool_calls' }] },
      { tier: 'standard', score: 0, is_fallback: false }, 'test', 'gemini-test', 0);
    const client = (denormalizer.denormalizeResponse(response).choices as { message: Record<string, unknown> }[])[0].message;
    expect(client.tool_calls).toEqual(calls);
    expect(client.reasoning_details).toEqual(path === 'google' ? calls.map((call, index) => detail(call.id, signatures[index]))
      : [detail('call_1', signatures[1], { index: 40 }), detail('call_0', signatures[0], { index: 99 })]);
    const canonical = normalizer.normalize({ messages: [source] }, {});
    expect(canonical.messages[0].content).toEqual(response.content);
    expect(denormalizer.denormalize(canonical, 'gemini-test').messages).toEqual([client]);
  });

  it.each([undefined, null, 'unknown', 'google-gemini-v1'])('accepts optional compatible format %s without changing it', (format) => {
    const source: Record<string, unknown> = detail('call_0', signatures[0], { format, index: 42 });
    if (format === undefined) delete source.format;
    const canonical = toolThoughtSignature(plainCalls()[0], [source]);
    expect(canonical).toEqual({ thought_signature: signatures[0], thought_signature_detail: source, thought_signature_detail_order: 0 });
  });

  it('never decodes, coerces, trims or copies unrelated reasoning/provider fields', () => {
    const source = detail('call_0', signatures[0], { private_field: 'not-forwarded' });
    expect(toolSignatureDetails([source])).toEqual([detail('call_0', signatures[0])]);
    for (const invalid of [null, false, {}, { ...source, type: 'reasoning.text' }, { ...source, data: 42 },
      { ...source, id: null }, { ...source, id: '' }, { ...source, format: 'anthropic-claude-v1' },
      { ...source, format: 'openai-responses-v1' }]) {
      expect(toolThoughtSignature(plainCalls()[0], [invalid])).toEqual({});
    }
    expect(toolThoughtSignature(plainCalls()[0], [detail('unrelated', 'no', { index: 0 })])).toEqual({});
    expect(toolThoughtSignature(plainCalls()[0], [detail('call_0', '')])).toMatchObject({ thought_signature: '' });
    const big = 'synthetic/long+'.repeat(4000);
    expect(toolThoughtSignature(plainCalls()[0], [detail('call_0', big)]).thought_signature).toBe(big);
  });

  it('uses the Google signature consistently if an alias conflicts', () => {
    const canonical = normalizer.normalize({ messages: [{ role: 'assistant', tool_calls: [calls[0]], reasoning_details: [detail('call_0', 'conflict')] }] }, {});
    const output = denormalizer.denormalize(canonical, 'gemini-test').messages as Record<string, unknown>[];
    expect(output[0].tool_calls).toEqual([calls[0]]);
    expect(output[0].reasoning_details).toEqual([detail('call_0', signatures[0])]);
  });

  it.each([
    ['https://generativelanguage.googleapis.com/v1beta/openai', undefined, 'google'],
    ['https://openrouter.ai/api/v1', undefined, 'openrouter'],
    ['https://openrouter.ai.example.invalid/v1', undefined, 'google'],
    ['https://proxy.example.invalid/v1', 'openrouter', 'openrouter'],
    ['https://proxy.example.invalid/v1', 'both', 'both'],
    ['https://openrouter.ai/api/v1', 'google', 'google'],
  ] as const)('serializes upstream dialect for %s (%s)', (base_url, override, expected) => {
    const canonical = normalizer.normalize({ messages: [message('openrouter')] }, {});
    const body = denormalizer.denormalize(canonical, 'gemini-test');
    provider['applyNodeRequestCompatibility']({ base_url, protocol: 'chat_completions', request_compatibility: { chat_tool_signatures: override } } as NodeConfig, body);
    const output = (body.messages as Record<string, unknown>[])[0];
    if (expected === 'google') expect(output).not.toHaveProperty('reasoning_details');
    else expect(output.reasoning_details).toEqual([detail('call_1', signatures[1], { index: 40 }), detail('call_0', signatures[0], { index: 99 })]);
    for (const [i, call] of (output.tool_calls as Record<string, unknown>[]).entries()) {
      if (expected === 'openrouter') expect(call).not.toHaveProperty('extra_content');
      else expect(call).toMatchObject(google(signatures[i]));
    }
  });

  it.each(['drop', 'stringify_as_user'] as const)('does not resurrect signatures when tool history is removed by %s policy', (mode) => {
    const body = denormalizer.denormalize(normalizer.normalize({ messages: [message('both')] }, {}), 'test');
    provider['applyNodeRequestCompatibility']({ base_url: 'https://openrouter.ai', protocol: 'chat_completions', request_compatibility: { chat_tool_messages: mode } } as NodeConfig, body);
    expect(JSON.stringify(body)).not.toContain('reasoning.encrypted');
    expect(JSON.stringify(body)).not.toContain('thought_signature');
  });

  it.each(['early', 'same', 'late'])('bridges %s OpenRouter SSE details with reversed reasoning indexes and preserves metadata', (when) => {
    const details = [detail('call_1', signatures[1], { index: 0 }), detail('call_0', signatures[0], { index: 7 })];
    const tool_calls = plainCalls().map((call, index) => ({ ...call, index }));
    const wire = (when === 'early' ? frame({ reasoning_details: details }) : '')
      + frame({ tool_calls, ...(when === 'same' ? { reasoning_details: details } : {}) })
      + frame({}, 'tool_calls', { prompt_tokens: 9, completion_tokens: 3 })
      + (when === 'late' ? frame({ reasoning_details: details }) : '') + 'data: [DONE]\n\n';
    const result = stream(wire);
    expect(result.details).toEqual(details);
    const sigDeltas = result.chunks.flatMap((chunk) => chunk.choices?.[0]?.delta?.tool_calls || []).filter((call) => call.extra_content);
    expect(sigDeltas).toHaveLength(2);
    for (const call of sigDeltas) expect(call.extra_content.google.thought_signature).toBe(signatures[call.index]);
    expect(result.output.indexOf('reasoning_details')).toBeLessThan(result.output.indexOf('[DONE]'));
    expect(result.events.at(-1)).toMatchObject({ type: 'stop', usage: { input_tokens: 9, output_tokens: 3 } });
  });

  it.each([true, false])('buffers Google signatures until late IDs for pi, emits one envelope per call (DONE=%s)', (done) => {
    const wire = frame({ tool_calls: [{ index: 1, ...google(signatures[1]) }, { index: 0, ...google(signatures[0]) }] })
      + frame({ tool_calls: plainCalls().map((call, index) => ({ ...call, index })) })
      + frame({}, 'tool_calls', { prompt_tokens: 9, completion_tokens: 3 })
      + frame({ reasoning_details: [detail('call_0', signatures[0], { index: 77 }), detail('call_0', signatures[0], { index: 77 })] })
      + frame({ tool_calls: [{ index: 1, ...google(signatures[1]) }] })
      + (done ? 'data: [DONE]\n\n' : '');
    const result = stream(wire);
    expect(result.details).toEqual([detail('call_0', signatures[0], { index: 77 }), detail('call_1', signatures[1])]);
    expect(result.output.lastIndexOf('"id":"call_1"')).toBeLessThan(result.output.indexOf('[DONE]'));
    expect(result.chunks.findIndex((chunk) => chunk.choices?.[0]?.delta?.reasoning_details)).toBeGreaterThan(
      result.chunks.findIndex((chunk) => chunk.choices?.[0]?.delta?.tool_calls?.some((call: { id?: string }) => call.id === 'call_1')));
    expect(result.output.match(/\[DONE\]/g)).toHaveLength(1);
  });

  it('never returns orphan encrypted state or reasoning text as tool signatures', () => {
    const result = stream(frame({ tool_calls: plainCalls().map((call, index) => ({ ...call, index })) })
      + frame({ reasoning_details: [detail('missing', 'not-returned', { index: 0 }), { type: 'reasoning.text', text: 'not-returned' }] })
      + 'data: [DONE]\n\n');
    expect(result.details).toEqual([]);
    expect(result.output).not.toContain('not-returned');
    expect(result.output).not.toContain('thought_signature');
  });

  it.each(['google', 'openrouter', 'both', 'invalid', null, [], 42])('validates explicit upstream dialect %j', (mode) => {
    const config = yaml.load(readFileSync('test/fixtures/config-validator/valid.gateway.yaml', 'utf8')) as { nodes: Array<Record<string, unknown>> };
    config.nodes[0].request_compatibility = { chat_tool_signatures: mode };
    const errors = validateConfigObject(config, { env: {} }).errors;
    expect(errors.some((error) => error.code === 'invalid_node_request_compatibility_chat_tool_signatures')).toBe(!['google', 'openrouter', 'both'].includes(String(mode)));
  });
});

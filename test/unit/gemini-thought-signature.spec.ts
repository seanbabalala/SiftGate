import { CanonicalStreamEvent } from '../../src/canonical/canonical.types';
import { ChatCompletionsNormalizer } from '../../src/canonical/normalizers/chat-completions.normalizer';
import { ChatCompletionsDenormalizer } from '../../src/canonical/denormalizers/chat-completions.denormalizer';
import { ConfigService } from '../../src/config/config.service';
import { ProviderClientService } from '../../src/providers/provider-client.service';
import { ChatCompletionsStreamParser } from '../../src/providers/stream/chat-completions.stream';
import { ChatCompletionsStreamSerializer } from '../../src/providers/stream/stream-serializers';
import { TelemetryService } from '../../src/telemetry/telemetry.service';

// Synthetic opaque strings, deliberately not valid base64. Never real model state.
const signature = '  synthetic:+/opaque==\n签名\t';
const standard = (value: unknown) => ({ extra_content: { google: { thought_signature: value } } });
const alternate = (value: unknown) => ({ provider_specific_fields: { thought_signature: value } });
const call = (fields: Record<string, unknown> = {}) => ({
  id: 'call_1', type: 'function',
  function: { name: 'get_temperature', arguments: '{"city":"TestCity"}' },
  ...fields,
});
const normalizer = new ChatCompletionsNormalizer();
const denormalizer = new ChatCompletionsDenormalizer();

function response(toolCall: Record<string, unknown>) {
  const service = new ProviderClientService({} as ConfigService, new TelemetryService());
  return service['normalizeChatCompletionsResponse']({
    id: 'test', model: 'gemini-test',
    choices: [{ message: { tool_calls: [toolCall] }, finish_reason: 'tool_calls' }],
  }, { tier: 'standard', score: 0, is_fallback: false }, 'test', 'gemini-test', 0);
}

function frame(toolCalls: Record<string, unknown>[], extra: Record<string, unknown> = {}) {
  return `data: ${JSON.stringify({
    id: 'test', model: 'gemini-test',
    choices: [{ delta: { tool_calls: toolCalls }, finish_reason: null }], ...extra,
  })}\r\n\r\n`;
}

function roundTripStream(wire: string) {
  const parser = new ChatCompletionsStreamParser();
  const serializer = new ChatCompletionsStreamSerializer();
  const events: CanonicalStreamEvent[] = [];
  for (let i = 0; i < wire.length; i += 7) events.push(...parser.parse(wire.slice(i, i + 7)));
  events.push(...parser.flush());
  const output = events.map((event) => serializer.serialize(event)).join('');
  const chunks = output.split('\n').filter((line) => line.startsWith('data: {'))
    .map((line) => JSON.parse(line.slice(6)));
  const tools = chunks.flatMap((chunk) => chunk.choices?.[0]?.delta?.tool_calls || []);
  return { events, output, tools };
}

describe('Gemini opaque Chat Completions tool signatures', () => {
  it.each([
    ['standard', standard(signature), signature],
    ['alternate', alternate(signature), signature],
    ['both', { ...standard(signature), ...alternate(signature) }, signature],
    ['standard wins', { ...standard(signature), ...alternate('other') }, signature],
    ['empty is preserved', { ...standard(''), ...alternate('other') }, ''],
    ['invalid standard falls back', { ...standard(123), ...alternate(signature) }, signature],
    ['long opaque value', standard('synthetic/'.repeat(4096)), 'synthetic/'.repeat(4096)],
  ])('preserves %s through upstream response, client history and next request', (_label, fields, expected) => {
    const canonicalResponse = response(call(fields as Record<string, unknown>));
    expect(canonicalResponse.content[0]).toMatchObject({ thought_signature: expected });
    const clientBody = denormalizer.denormalizeResponse(canonicalResponse);
    const message = (clientBody.choices as { message: Record<string, unknown> }[])[0].message;
    expect(message.tool_calls).toEqual([call(standard(expected))]);
    // Exercise both inbound aliases independently of the standard client output.
    for (const history of [message, { role: 'assistant', tool_calls: [call(fields as Record<string, unknown>)] }]) {
      const request = normalizer.normalize({ messages: [history] }, {});
      expect(request.messages[0].content).toEqual(canonicalResponse.content);
      expect(denormalizer.denormalize(request, 'gemini-test').messages).toEqual([
        { role: 'assistant', content: null, tool_calls: [call(standard(expected))] },
      ]);
    }
  });

  it.each([{}, standard(null), standard(123), standard({}), alternate(false),
    { extra_content: null, provider_specific_fields: [] },
  ])('does not fabricate signatures for absent or malformed fields: %j', (fields) => {
    const canonical = response(call(fields));
    expect(canonical.content[0]).not.toHaveProperty('thought_signature');
    const output = denormalizer.denormalizeResponse(canonical);
    expect((output.choices as { message: { tool_calls: unknown[] } }[])[0].message.tool_calls).toEqual([call()]);
    const request = normalizer.normalize({ messages: [{ role: 'assistant', tool_calls: [call(fields)] }] }, {});
    expect(request.messages[0].content).toEqual(canonical.content);
  });

  it.each([true, false])('keeps late parallel signatures before stop (DONE=%s)', (done) => {
    const wire = frame([
      { ...call(), index: 0 },
      { ...call(), index: 1, id: 'call_2' }, // identical function names must not alias
    ]) + frame([], {
      choices: [{ delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 8, completion_tokens: 4 },
    }) + frame([{ index: 1, ...alternate('second') }])
      + frame([{ id: 'call_1', ...standard(signature) }])
      + (done ? 'data: [DONE]\n\n' : '');
    const { output, tools, events } = roundTripStream(wire);
    expect(tools).toEqual([
      { ...call(), index: 0 }, { ...call(), index: 1, id: 'call_2' },
      { index: 1, ...standard('second') }, { index: 0, ...standard(signature) },
    ]);
    expect(output.indexOf('thought_signature')).toBeLessThan(output.indexOf('[DONE]'));
    expect(output.match(/\[DONE\]/g)).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: 'stop', stop_reason: 'tool_use', usage: { input_tokens: 8, output_tokens: 4 } });
  });

  it('keeps signatures before IDs and interleaved arguments on their explicit indexes', () => {
    const { tools } = roundTripStream(
      frame([{ index: 1, ...standard('second') }, { index: 0, ...alternate(signature) }])
      + frame([{ index: 0, id: 'call_1', function: { name: 'search', arguments: '{"q":' } }])
      + frame([{ index: 1, id: 'call_2', function: { name: 'search', arguments: '{"q":' } }])
      + frame([{ id: 'call_2', function: { arguments: '"b"}' } }])
      + frame([{ index: 0, function: { arguments: '"a"}' } }])
      + 'data: [DONE]\n\n',
    );
    expect(tools).toEqual([
      { index: 1, ...standard('second') }, { index: 0, ...standard(signature) },
      { index: 0, id: 'call_1', type: 'function', function: { name: 'search', arguments: '{"q":' } },
      { index: 1, id: 'call_2', type: 'function', function: { name: 'search', arguments: '{"q":' } },
      { index: 1, function: { arguments: '"b"}' } },
      { index: 0, function: { arguments: '"a"}' } },
    ]);
  });

  it('does not attach an unaddressed signature to the last of parallel calls', () => {
    const { tools } = roundTripStream(frame([
      { ...call(), index: 0 }, { ...call(), index: 1, id: 'call_2' },
    ]) + frame([standard('unaddressed')]) + 'data: [DONE]\n\n');
    expect(tools).toHaveLength(2);
    expect(JSON.stringify(tools)).not.toContain('thought_signature');
  });

  it('preserves ID-only streams and does not repeat signatures on argument deltas', () => {
    const { tools } = roundTripStream(frame([
      { ...call(standard(signature)), function: { name: 'search', arguments: '' } },
      { ...call(alternate('second')), id: 'call_2' },
    ]) + frame([{ id: 'call_1', function: { arguments: '{}' } }]) + 'data: [DONE]\n\n');
    expect(tools.map((tool) => tool.index)).toEqual([0, 1, 0]);
    expect(tools[0]).toMatchObject(standard(signature));
    expect(tools[1]).toMatchObject(standard('second'));
    expect(tools[2]).toEqual({ index: 0, function: { arguments: '{}' } });
  });

  it('flushes a final signature frame without a trailing newline', () => {
    const { tools, output } = roundTripStream(frame([{ ...call(), index: 0 }])
      + frame([], { choices: [{ delta: {}, finish_reason: 'tool_calls' }] })
      + frame([{ index: 0, ...standard(signature) }]).trimEnd());
    expect(tools.at(-1)).toEqual({ index: 0, ...standard(signature) });
    expect(output.match(/\[DONE\]/g)).toHaveLength(1);
  });

  it('does not add signature fields to unsigned parallel calls', () => {
    const { tools } = roundTripStream(frame([
      { ...call(standard(signature)), index: 0 }, { ...call(), index: 1, id: 'call_2' },
    ]) + frame([{ index: 1, function: { arguments: ' ' } }]) + 'data: [DONE]\n\n');
    expect(tools[1]).toEqual({ ...call(), index: 1, id: 'call_2' });
    expect(tools[2]).toEqual({ index: 1, function: { arguments: ' ' } });
  });
});

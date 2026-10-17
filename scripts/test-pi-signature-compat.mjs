// Real, unmodified pi clients against an isolated loopback gateway/provider.
// Install pi separately, set PI_AI_PACKAGE_DIR, and build SiftGate first.
// No production keys, configuration, database, or external inference is used.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Logger } = require('@nestjs/common');
Logger.overrideLogger(false);
const { ChatCompletionsNormalizer } = require('../dist/canonical/normalizers/chat-completions.normalizer');
const { ChatCompletionsDenormalizer } = require('../dist/canonical/denormalizers/chat-completions.denormalizer');
const { ChatCompletionsStreamSerializer } = require('../dist/providers/stream/stream-serializers');
const { ProviderClientService } = require('../dist/providers/provider-client.service');
const { TelemetryService } = require('../dist/telemetry/telemetry.service');

assert(process.env.PI_AI_PACKAGE_DIR, 'Set PI_AI_PACKAGE_DIR to an independently installed pi-ai package directory');
const piRoot = resolve(process.env.PI_AI_PACKAGE_DIR);
const piPackage = JSON.parse(readFileSync(resolve(piRoot, 'package.json'), 'utf8'));
const legacy = existsSync(resolve(piRoot, 'dist/providers/openai-completions.js'));
const pi = await import(pathToFileURL(resolve(piRoot, legacy ? 'dist/providers/openai-completions.js' : 'dist/api/openai-completions.js')));
const streamPi = pi.streamOpenAICompletions ?? pi.stream;
const normalizeContext = legacy ? (value) => value
  : (await import(pathToFileURL(resolve(piRoot, 'dist/utils/transcript.js')))).normalizeContext;
assert.equal(typeof streamPi, 'function');
const signatures = [' synthetic:first+/==\n签名\t', 'synthetic:second+/=='];
const details = signatures.map((data, index) => ({ type: 'reasoning.encrypted', id: `call_${index}`, data, format: 'google-gemini-v1', index: index ? 3 : 17 }));
const google = (signature) => ({ extra_content: { google: { thought_signature: signature } } });
const calls = signatures.map((_signature, index) => ({ id: `call_${index}`, type: 'function', function: { name: 'lookup', arguments: JSON.stringify({ city: `TestCity${index}` }) } }));
const modelId = 'gemini-test';
const tools = [{ name: 'lookup', description: 'Synthetic lookup', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }];
const user = { role: 'user', content: 'Compare two synthetic cities.', timestamp: 1 };
const normalizer = new ChatCompletionsNormalizer();
const denormalizer = new ChatCompletionsDenormalizer();

function chunk(delta, finish_reason = null, usage) {
  return { id: 'test', model: modelId, choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) };
}

async function runCase(dialect, when, bridge = true, clientProvider = 'siftgate-fixture') {
  const requests = [];
  const upstreamStatuses = [];
  const failures = [];
  let provider;
  const server = createServer(async (request, response) => {
    try {
      let raw = '';
      for await (const part of request) raw += part;
      const body = JSON.parse(raw);
      if (request.url === '/upstream/chat/completions') {
        const assistant = body.messages.find((message) => message.role === 'assistant' && message.tool_calls);
        if (assistant) {
          const replay = dialect === 'google'
            ? assistant.tool_calls.map((call) => call.extra_content?.google?.thought_signature)
            : calls.map((call) => assistant.reasoning_details?.find((detail) => detail.id === call.id)?.data);
          if (!replay.every((signature, index) => signature === signatures[index])) {
            upstreamStatuses.push(400);
            response.writeHead(400, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'Missing or changed synthetic signature' } }));
            return;
          }
          if (dialect === 'google') assert.equal(assistant.reasoning_details, undefined, 'Strict Google endpoint must not receive an OpenRouter-only field');
          else assert(assistant.tool_calls.every((call) => !call.extra_content), 'OpenRouter mode must not depend on Google fields');
          assert.deepEqual(assistant.tool_calls.map((call) => call.id), calls.map((call) => call.id));
          assert.deepEqual(assistant.tool_calls.map((call) => JSON.parse(call.function.arguments)), calls.map((call) => JSON.parse(call.function.arguments)));
          if (dialect === 'openrouter') for (const expected of details)
            assert.deepEqual(assistant.reasoning_details.find((detail) => detail.id === expected.id), expected);
          upstreamStatuses.push(200);
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          response.end(`data: ${JSON.stringify(chunk({ content: 'Both tools received.' }))}\n\n`
            + `data: ${JSON.stringify(chunk({}, 'stop', { prompt_tokens: 9, completion_tokens: 3 }))}\n\ndata: [DONE]\n\n`);
          return;
        }
        upstreamStatuses.push(200);
        const signed = dialect === 'google'
          ? { tool_calls: signatures.map((signature, index) => ({ index, ...google(signature) })) }
          : { reasoning_details: [...details].reverse() };
        const first = [];
        if (when === 'early') first.push(chunk(signed));
        first.push(chunk({ tool_calls: calls.map((call, index) => ({ ...call, index, function: { name: call.function.name, arguments: '{"city":' } })) }));
        first.push(chunk({ tool_calls: [{ index: 1, function: { arguments: '"TestCity1"}' } }, { id: 'call_0', function: { arguments: '"TestCity0"}' } }] }));
        first.push(chunk({}, 'tool_calls', { prompt_tokens: 8, completion_tokens: 4 }));
        if (when === 'late') first.push(chunk(signed), chunk(signed)); // aliases/repeated complete state must not concatenate
        const wire = first.map((frame) => `data: ${JSON.stringify(frame)}\r\n\r\n`).join('') + 'data: [DONE]\n\n';
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        const bytes = Buffer.from(wire);
        for (let offset = 0; offset < bytes.length; offset += 13) response.write(bytes.subarray(offset, offset + 13));
        response.end();
        return;
      }
      assert.equal(request.url, '/v1/chat/completions');
      requests.push(body);
      const canonical = normalizer.normalize(body, {});
      if (!body.stream) {
        const result = await provider.forward(canonical, 'fixture', modelId, { tier: 'standard', score: 0, is_fallback: false });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(denormalizer.denormalizeResponse(result)));
        return;
      }
      const serializer = new ChatCompletionsStreamSerializer();
      const events = provider.forwardStream(canonical, 'fixture', modelId);
      // Connect before committing headers so a missing-signature 400 remains HTTP 400.
      const first = await events.next();
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const write = (event) => {
        let wire = serializer.serialize(event);
        if (!bridge) wire = wire.split('\n').map((line) => {
          if (!line.startsWith('data: {')) return line;
          const frame = JSON.parse(line.slice(6));
          for (const choice of frame.choices || []) if (choice.delta) delete choice.delta.reasoning_details;
          return `data: ${JSON.stringify(frame)}`;
        }).join('\n');
        response.write(wire);
      };
      if (!first.done) write(first.value);
      for await (const event of events) write(event);
      response.end();
    } catch (error) {
      if (error.statusCode !== 400) failures.push(error);
      if (!response.headersSent) response.writeHead(error.statusCode || 500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Synthetic gateway error' } }));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  provider = new ProviderClientService({ getNode: () => ({
    id: 'fixture', protocol: 'chat_completions', base_url: `${base}/upstream`, endpoint: '/chat/completions',
    api_key: 'synthetic-upstream-key', models: [modelId], timeout_ms: 10000,
    request_compatibility: { chat_tool_signatures: dialect },
  }) }, new TelemetryService());
  const model = { id: modelId, name: 'Synthetic Gemini', api: 'openai-completions', provider: clientProvider, baseUrl: `${base}/v1`,
    reasoning: true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4096 };
  try {
    const first = await streamPi(model, normalizeContext({ messages: [user], tools }), { apiKey: 'synthetic-client-key' }).result();
    assert.equal(first.stopReason, 'toolUse', first.errorMessage);
    const toolCalls = first.content.filter((block) => block.type === 'toolCall');
    assert.deepEqual(toolCalls.map((tool) => tool.id).sort(), calls.map((call) => call.id));
    for (const tool of toolCalls) assert.deepEqual(tool.arguments, JSON.parse(calls.find((call) => call.id === tool.id).function.arguments));
    const results = toolCalls.map((tool) => ({ role: 'toolResult', toolCallId: tool.id, toolName: tool.name, content: [{ type: 'text', text: '23' }], isError: false, timestamp: 2 }));
    const second = await streamPi(model, normalizeContext({ messages: [user, first, ...results], tools }), { apiKey: 'synthetic-client-key' }).result();
    assert.equal(requests.length, 2);
    const replay = requests[1].messages.find((message) => message.role === 'assistant' && message.tool_calls);
    if (bridge) {
      assert.notEqual(second.stopReason, 'error', second.errorMessage);
      assert.deepEqual(upstreamStatuses, [200, 200]);
      assert.equal(replay.reasoning_details.length, 2);
      for (const [index, call] of calls.entries()) assert.equal(replay.reasoning_details.find((detail) => detail.id === call.id).data, signatures[index]);
    } else {
      assert.equal(second.stopReason, 'error');
      assert.deepEqual(upstreamStatuses, [200, 400]);
      assert.equal(replay.reasoning_details, undefined);
    }
    assert.deepEqual(failures, []);
    console.log(JSON.stringify({ pi: `${piPackage.name}@${piPackage.version}`, clientProvider, dialect, when, bridge, upstreamStatuses, calls: 2 }));
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

await runCase('google', 'late', false);
for (const dialect of ['google', 'openrouter']) for (const when of ['early', 'late']) await runCase(dialect, when);
await runCase('google', 'late', true, 'openrouter');

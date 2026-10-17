// Run separately installed, unmodified pi-ai clients through SiftGate's real Chat
// normalizer/provider/SSE serializer. No external inference, production config,
// database, or credentials are used. The signature harness remains mandatory.
// Build SiftGate first, then set PI_AI_PACKAGE_DIR to either pi-ai installation.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Logger } = require('@nestjs/common');
Logger.overrideLogger(false);
const { ChatCompletionsNormalizer } = require('../dist/canonical/normalizers/chat-completions.normalizer');
const { ChatCompletionsStreamSerializer } = require('../dist/providers/stream/stream-serializers');
const { ProviderClientService } = require('../dist/providers/provider-client.service');
const { TelemetryService } = require('../dist/telemetry/telemetry.service');

assert(process.env.PI_AI_PACKAGE_DIR, 'Set PI_AI_PACKAGE_DIR to an independently installed pi-ai package directory');
const piRoot = resolve(process.env.PI_AI_PACKAGE_DIR);
const packageInfo = JSON.parse(readFileSync(resolve(piRoot, 'package.json'), 'utf8'));
const legacy = existsSync(resolve(piRoot, 'dist/providers/openai-completions.js'));
const adapter = await import(pathToFileURL(resolve(piRoot, legacy ? 'dist/providers/openai-completions.js' : 'dist/api/openai-completions.js')));
const streamSimple = adapter.streamSimpleOpenAICompletions ?? adapter.streamSimple;
const normalizeContext = legacy ? (value) => value
  : (await import(pathToFileURL(resolve(piRoot, 'dist/utils/transcript.js')))).normalizeContext;
assert.equal(typeof streamSimple, 'function', 'Exercise pi streamSimple, not an already-built reasoningEffort payload');
const normalizer = new ChatCompletionsNormalizer();
const message = { role: 'user', content: 'Return the synthetic reasoning fixture response.', timestamp: 1 };
const results = [];

async function runCase(modelId, reasoning, clientProvider, override = true, upstreamDialect = 'google') {
  const clientRequests = [];
  const upstreamRequests = [];
  const upstreamStatuses = [];
  const unexpectedErrors = [];
  const chunk = (delta, finish_reason = null) => ({
    id: 'reasoning-fixture', model: modelId, choices: [{ index: 0, delta, finish_reason }],
  });
  const server = createServer(async (request, response) => {
    try {
      let raw = '';
      for await (const part of request) raw += part;
      const body = JSON.parse(raw);
      if (request.url === '/upstream/chat/completions') {
        upstreamRequests.push(body);
        const config = body.extra_body?.google?.thinking_config;
        const valid = body.reasoning_effort === undefined && (upstreamDialect === 'openrouter'
          ? body.reasoning?.effort === reasoning && config === undefined
          : body.reasoning === undefined && config?.thinking_level === reasoning && config.thinking_budget === undefined);
        if (!valid) {
          upstreamStatuses.push(400);
          response.writeHead(400, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: { type: 'invalid_request_error', message: `Synthetic ${upstreamDialect} endpoint rejects incorrect reasoning dialect` } }));
          return;
        }
        upstreamStatuses.push(200);
        const wire = [chunk({ role: 'assistant', content: 'Reasoning ' }), chunk({ content: `${reasoning} accepted.` }),
          { ...chunk({}, 'stop'), usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }]
          .map((frame) => `data: ${JSON.stringify(frame)}\r\n\r\n`).join('') + 'data: [DONE]\n\n';
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        const bytes = Buffer.from(wire);
        for (let offset = 0; offset < bytes.length; offset += 13) response.write(bytes.subarray(offset, offset + 13));
        response.end();
        return;
      }
      assert.equal(request.url, '/v1/chat/completions', 'No route may access an external upstream');
      assert.equal(body.stream, true);
      clientRequests.push(structuredClone(body));
      const before = JSON.stringify(body);
      const canonical = normalizer.normalize(body, {});
      assert.equal(canonical.reasoning?.requested, true, 'pi controls must be recognized for reasoning logs');
      assert.equal(canonical.reasoning?.effort, reasoning);
      const events = provider.forwardStream(canonical, 'reasoning-fixture', modelId);
      // Do not commit SSE headers until upstream validation succeeds.
      const first = await events.next();
      const serializer = new ChatCompletionsStreamSerializer();
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      if (!first.done) response.write(serializer.serialize(first.value));
      for await (const event of events) response.write(serializer.serialize(event));
      assert.equal(JSON.stringify(body), before, 'Gateway must not mutate pi input or source/raw metadata');
      response.end();
    } catch (error) {
      const status = error.statusCode ?? error.getStatus?.() ?? 500;
      if (status !== 400) unexpectedErrors.push(error);
      if (!response.headersSent) response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Synthetic reasoning gateway error' } }));
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  // Unknown/private endpoints intentionally retain OpenAI semantics in auto.
  // The current level-only private upstream needs this explicit node override;
  // official Google-host auto selection is covered in unit and full HTTP tests.
  const provider = new ProviderClientService({ getNode: () => ({
    id: 'reasoning-fixture', protocol: 'chat_completions', base_url: `${base}/upstream`, endpoint: '/chat/completions',
    api_key: 'synthetic-upstream-key', models: [modelId], timeout_ms: 10000,
    request_compatibility: { chat_reasoning_format: override ? (upstreamDialect === 'openrouter' ? 'openrouter' : 'google-thinking-level') : 'auto' },
  }) }, new TelemetryService());
  const model = {
    id: modelId, name: 'Synthetic Gemini reasoning', api: 'openai-completions', provider: clientProvider, baseUrl: `${base}/v1`,
    reasoning: true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4096,
  };
  try {
    const result = await streamSimple(model, normalizeContext({ messages: [message] }), {
      apiKey: 'synthetic-client-key', reasoning, signal: AbortSignal.timeout(15000),
    }).result();
    assert.equal(clientRequests.length, 1);
    assert.equal(upstreamRequests.length, 1);
    const outgoing = clientRequests[0];
    if (clientProvider === 'openrouter') {
      assert.deepEqual(outgoing.reasoning, { effort: reasoning }, 'Unmodified pi OpenRouter mode must exercise nested reasoning.effort');
      assert.equal(outgoing.reasoning_effort, undefined);
    } else {
      assert.equal(outgoing.reasoning_effort, reasoning, 'Unmodified custom pi mode must exercise reasoning_effort');
      assert.equal(outgoing.reasoning, undefined);
    }
    if (override) {
      assert.notEqual(result.stopReason, 'error', result.errorMessage);
      assert.deepEqual(upstreamStatuses, [200]);
      assert.equal(result.content.filter((part) => part.type === 'text').map((part) => part.text).join(''), `Reasoning ${reasoning} accepted.`);
      if (upstreamDialect === 'openrouter') {
        assert.deepEqual(upstreamRequests[0].reasoning, { effort: reasoning });
        assert.equal(upstreamRequests[0].extra_body?.google?.thinking_config, undefined);
      } else assert.deepEqual(upstreamRequests[0].extra_body.google.thinking_config, { thinking_level: reasoning });
    } else {
      assert.equal(result.stopReason, 'error', 'Negative control must reproduce the current private upstream rejection');
      assert.deepEqual(upstreamStatuses, [400]);
      assert.equal(upstreamRequests[0].reasoning_effort, reasoning);
      assert.equal(upstreamRequests[0].extra_body?.google?.thinking_config, undefined);
    }
    assert.deepEqual(unexpectedErrors, []);
    const summary = { pi: `${packageInfo.name}@${packageInfo.version}`, model: modelId, clientProvider, reasoning,
      upstreamDialect, nodeFormat: override ? (upstreamDialect === 'openrouter' ? 'openrouter' : 'google-thinking-level') : 'auto', expectedNegativeControl: !override, upstreamStatuses };
    results.push(summary);
    console.log(JSON.stringify(summary));
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

for (const clientProvider of ['siftgate-fixture', 'openrouter']) {
  await runCase('gemini-4-argon', 'high', clientProvider, false);
  for (const upstreamDialect of ['google', 'openrouter'])
    for (const model of ['gemini-4-argon', 'gemini-3.8-flash'])
      for (const reasoning of ['low', 'medium', 'high']) await runCase(model, reasoning, clientProvider, true, upstreamDialect);
}
assert.equal(results.length, 26);
console.log(JSON.stringify({ pi: `${packageInfo.name}@${packageInfo.version}`, cases: results.length, externalInference: false, status: 'passed' }));

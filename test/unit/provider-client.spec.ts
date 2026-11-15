import { ProviderClientService, ProviderError } from '../../src/providers/provider-client.service';
import { Tier, CanonicalMediaRequest, CanonicalRequest } from '../../src/canonical/canonical.types';
import { TelemetryService } from '../../src/telemetry/telemetry.service';
import { BUILTIN_PROVIDER_CATALOG } from '../../src/catalog/built-in-catalog';
import { CredentialPoolService } from '../../src/providers/credential-pool.service';

const routingMeta = { tier: 'standard' as Tier, score: 0.1, is_fallback: false };

function makeService(): ProviderClientService {
  return new ProviderClientService({} as any, new TelemetryService());
}

function makeServiceWithNode(
  nodeOverrides: Record<string, any> = {},
  telemetry: TelemetryService = new TelemetryService(),
): ProviderClientService {
  const node = {
    id: 'openai', name: 'OpenAI', protocol: 'chat_completions',
    base_url: 'https://api.openai.com', endpoint: '/v1/chat/completions',
    api_key: 'sk-test', models: ['gpt-4o'], model_aliases: {},
    timeout_ms: 5000,
    ...nodeOverrides,
  };
  return new ProviderClientService({
    getNode: jest.fn().mockReturnValue(node),
  } as any, telemetry);
}

function makeServiceWithConfig(
  configOverrides: Record<string, any>,
  nodeOverrides: Record<string, any> = {},
): ProviderClientService {
  const node = {
    id: 'openai', name: 'OpenAI', protocol: 'chat_completions',
    base_url: 'https://api.openai.com', endpoint: '/v1/chat/completions',
    api_key: 'sk-test', models: ['gpt-4o'], model_aliases: {},
    timeout_ms: 5000,
    ...nodeOverrides,
  };
  return new ProviderClientService({
    getNode: jest.fn().mockReturnValue(node),
    ...configOverrides,
  } as any, new TelemetryService());
}

function makeServiceWithPool(
  nodeOverrides: Record<string, any>,
  pool: { getDispatcher: jest.Mock },
): ProviderClientService {
  const node = {
    id: 'openai', name: 'OpenAI', protocol: 'chat_completions',
    base_url: 'https://api.openai.com', endpoint: '/v1/chat/completions',
    api_key: 'sk-test', models: ['gpt-4o'], model_aliases: {},
    timeout_ms: 5000,
    ...nodeOverrides,
  };
  return new ProviderClientService({
    getNode: jest.fn().mockReturnValue(node),
  } as any, new TelemetryService(), pool as any);
}

function makeServiceWithCredentialPool(nodeOverrides: Record<string, any> = {}): ProviderClientService {
  const node = {
    id: 'openai',
    name: 'OpenAI',
    protocol: 'chat_completions',
    base_url: 'https://api.openai.com',
    endpoint: '/v1/chat/completions',
    api_key: 'sk-test',
    models: ['gpt-4o'],
    model_aliases: {},
    timeout_ms: 5000,
    ...nodeOverrides,
  };
  return new ProviderClientService(
    {
      getNode: jest.fn().mockReturnValue(node),
    } as any,
    new TelemetryService(),
    undefined,
    undefined,
    new CredentialPoolService(),
  );
}

function makeCanonical(overrides: Partial<CanonicalRequest> = {}): CanonicalRequest {
  return {
    messages: [{ role: 'user', content: 'Hi' }],
    stream: false,
    metadata: { source_format: 'chat_completions', raw_headers: {} },
    ...overrides,
  };
}

function makeStreamTelemetryMock() {
  return {
    recordStreamLifecycle: jest.fn(),
  };
}

function makeMediaCanonical(
  overrides: Partial<CanonicalMediaRequest> = {},
): CanonicalMediaRequest {
  return {
    model: 'gpt-image-1',
    source_format: 'image_generation',
    payload: { model: 'gpt-image-1', prompt: 'Draw SiftGate' },
    content_type: 'application/json',
    is_multipart: false,
    media: {
      media_type: 'image',
      operation: 'generation',
      multipart: false,
      file_count: 0,
      byte_size: 48,
      requested_format: null,
      response_format: null,
    },
    metadata: {
      source_format: 'image_generation',
      original_model: 'gpt-image-1',
      raw_headers: {},
      media: {
        media_type: 'image',
        operation: 'generation',
        multipart: false,
        file_count: 0,
        byte_size: 48,
        requested_format: null,
        response_format: null,
      },
    },
    ...overrides,
  };
}

describe('ProviderClientService', () => {
  // ── Response Normalization ──────────────────────────────

  describe('normalizeResponse — chat_completions', () => {
    it('should normalize a simple text response', () => {
      const svc = makeService();
      const body = {
        id: 'chatcmpl-1',
        model: 'gpt-4o',
        choices: [
          { message: { role: 'assistant', content: 'Hello!' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      };
      const result = svc.normalizeResponse(body, 'chat_completions', routingMeta, 'openai', 'gpt-4o', 150);
      expect(result.id).toBe('chatcmpl-1');
      expect(result.content[0]).toEqual({ type: 'text', text: 'Hello!' });
      expect(result.stop_reason).toBe('end_turn');
      expect(result.usage).toEqual(expect.objectContaining({ input_tokens: 10, output_tokens: 5 }));
      expect(result.model).toBe('gpt-4o');
      expect(result.routing.node).toBe('openai');
      expect(result.routing.latency_ms).toBe(150);
    });

    it('should normalize tool_calls', () => {
      const svc = makeService();
      const body = {
        id: 'chatcmpl-2',
        model: 'gpt-4o',
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                { id: 'call_1', function: { name: 'search', arguments: '{"q":"test"}' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 20, completion_tokens: 10 },
      };
      const result = svc.normalizeResponse(body, 'chat_completions', routingMeta, 'openai', 'gpt-4o', 200);
      expect(result.stop_reason).toBe('tool_use');
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('tool_use');
      if (result.content[0].type === 'tool_use') {
        expect(result.content[0].name).toBe('search');
        expect(result.content[0].input).toEqual({ q: 'test' });
      }
    });

    it('should map finish_reason "length" to "max_tokens"', () => {
      const svc = makeService();
      const body = {
        id: 'x', model: 'gpt-4o',
        choices: [{ message: { content: 'partial...' }, finish_reason: 'length' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      };
      const result = svc.normalizeResponse(body, 'chat_completions', routingMeta, 'n', 'm', 100);
      expect(result.stop_reason).toBe('max_tokens');
    });
  });

  describe('normalizeResponse — messages', () => {
    it('should normalize Anthropic Messages response', () => {
      const svc = makeService();
      const body = {
        id: 'msg_1',
        model: 'claude-3-opus',
        content: [
          { type: 'text', text: 'Hello from Claude' },
        ],
        stop_reason: 'end_turn',
        usage: { input_tokens: 100, output_tokens: 50 },
      };
      const result = svc.normalizeResponse(body, 'messages', routingMeta, 'claude', 'claude-3-opus', 300);
      expect(result.id).toBe('msg_1');
      expect(result.content[0]).toEqual({ type: 'text', text: 'Hello from Claude' });
      expect(result.stop_reason).toBe('end_turn');
      expect(result.usage).toEqual(expect.objectContaining({ input_tokens: 100, output_tokens: 50 }));
    });

    it('should handle tool_use blocks', () => {
      const svc = makeService();
      const body = {
        id: 'msg_2', model: 'claude-3-opus',
        content: [
          { type: 'tool_use', id: 'toolu_1', name: 'search', input: { query: 'test' } },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 50, output_tokens: 30 },
      };
      const result = svc.normalizeResponse(body, 'messages', routingMeta, 'claude', 'claude-3-opus', 200);
      expect(result.content[0].type).toBe('tool_use');
      if (result.content[0].type === 'tool_use') {
        expect(result.content[0].name).toBe('search');
        expect(result.content[0].input).toEqual({ query: 'test' });
      }
    });
  });

  describe('normalizeResponse — responses', () => {
    it('should normalize OpenAI Responses API response', () => {
      const svc = makeService();
      const body = {
        id: 'resp_1',
        model: 'gpt-5.4',
        status: 'completed',
        output: [
          { type: 'message', content: [{ type: 'output_text', text: 'Answer here' }] },
        ],
        usage: { input_tokens: 30, output_tokens: 20 },
      };
      const result = svc.normalizeResponse(body, 'responses', routingMeta, 'openai', 'gpt-5.4', 250);
      expect(result.id).toBe('resp_1');
      expect(result.content[0]).toEqual({ type: 'text', text: 'Answer here' });
      expect(result.stop_reason).toBe('end_turn');
    });

    it('should handle function_call outputs', () => {
      const svc = makeService();
      const body = {
        id: 'resp_2', model: 'gpt-5.4', status: 'completed',
        output: [
          { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"NYC"}' },
        ],
        usage: { input_tokens: 10, output_tokens: 5 },
      };
      const result = svc.normalizeResponse(body, 'responses', routingMeta, 'openai', 'gpt-5.4', 100);
      expect(result.content[0].type).toBe('tool_use');
      if (result.content[0].type === 'tool_use') {
        expect(result.content[0].name).toBe('get_weather');
        expect(result.content[0].input).toEqual({ city: 'NYC' });
      }
    });

    it('should map incomplete status to max_tokens', () => {
      const svc = makeService();
      const body = {
        id: 'resp_3', model: 'gpt-5.4', status: 'incomplete',
        output: [{ type: 'message', content: [{ type: 'output_text', text: '...' }] }],
        usage: { input_tokens: 10, output_tokens: 4096 },
      };
      const result = svc.normalizeResponse(body, 'responses', routingMeta, 'openai', 'gpt-5.4', 100);
      expect(result.stop_reason).toBe('max_tokens');
    });
  });

  describe('normalizeResponse — gemini', () => {
    it('should normalize Gemini GenerateContent text responses', () => {
      const svc = makeService();
      const body = {
        responseId: 'gemini-resp-1',
        modelVersion: 'gemini-2.5-flash',
        candidates: [
          {
            content: { parts: [{ text: 'Hello from Gemini' }] },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: {
          promptTokenCount: 12,
          candidatesTokenCount: 7,
          totalTokenCount: 19,
          cachedContentTokenCount: 3,
        },
      };

      const result = svc.normalizeResponse(
        body,
        'gemini',
        routingMeta,
        'google',
        'gemini-2.5-flash',
        180,
      );

      expect(result.id).toBe('gemini-resp-1');
      expect(result.model).toBe('gemini-2.5-flash');
      expect(result.content[0]).toEqual({ type: 'text', text: 'Hello from Gemini' });
      expect(result.stop_reason).toBe('end_turn');
      expect(result.usage).toEqual(expect.objectContaining({
        input_tokens: 12,
        output_tokens: 7,
        cache_read_input_tokens: 3,
      }));
    });

    it('should normalize Gemini function calls as tool_use blocks', () => {
      const svc = makeService();
      const body = {
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: {
                    name: 'get_weather',
                    args: { city: 'Paris' },
                  },
                },
              ],
            },
            finishReason: 'MALFORMED_FUNCTION_CALL',
          },
        ],
        usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2 },
      };

      const result = svc.normalizeResponse(
        body,
        'gemini',
        routingMeta,
        'google',
        'gemini-2.5-pro',
        100,
      );

      expect(result.content[0].type).toBe('tool_use');
      if (result.content[0].type === 'tool_use') {
        expect(result.content[0].name).toBe('get_weather');
        expect(result.content[0].input).toEqual({ city: 'Paris' });
      }
      expect(result.stop_reason).toBe('tool_use');
    });
  });

  describe('denormalizeRequest — gemini', () => {
    it('should build a native Gemini GenerateContent request', () => {
      const svc = makeService();
      const canonical = makeCanonical({
        messages: [
          { role: 'system', content: 'Be concise.' },
          { role: 'user', content: 'Hello!' },
        ],
        max_tokens: 32,
        temperature: 0.3,
        top_p: 0.9,
        stop: ['END'],
        response_format: {
          type: 'json_schema',
          source: 'chat_completions.response_format',
          raw: {},
          json_schema: {
            schema: {
              type: 'object',
              properties: { answer: { type: 'string' } },
            },
          },
        },
        reasoning: {
          requested: true,
          source: 'chat_completions.reasoning_effort',
          effort: 'medium',
          raw: 'medium',
        },
      });

      const body = (svc as any).denormalizeRequest(
        canonical,
        'gemini',
        'gemini-2.5-flash',
      );

      expect(body).toMatchObject({
        systemInstruction: { parts: [{ text: 'Be concise.' }] },
        contents: [{ role: 'user', parts: [{ text: 'Hello!' }] }],
        generationConfig: {
          maxOutputTokens: 32,
          temperature: 0.3,
          topP: 0.9,
          stopSequences: ['END'],
          responseMimeType: 'application/json',
          responseSchema: {
            type: 'object',
            properties: { answer: { type: 'string' } },
          },
          thinkingConfig: { thinkingBudget: 2048 },
        },
      });
      expect(body.model).toBeUndefined();
      expect(body.stream).toBeUndefined();
    });

    it('should map web search and functions to Gemini native tools', () => {
      const svc = makeService();
      const canonical = makeCanonical({
        tools: [
          {
            name: 'lookup',
            description: 'Lookup local data',
            parameters: { type: 'object', properties: {} },
          },
        ],
        tool_choice: { name: 'lookup' },
        metadata: {
          source_format: 'responses',
          raw_headers: {},
          raw_body: {
            tools: [{ type: 'web_search_preview' }],
          },
        },
      });

      const body = (svc as any).denormalizeRequest(
        canonical,
        'gemini',
        'gemini-2.5-pro',
      );

      expect(body.tools).toEqual([
        {
          functionDeclarations: [
            {
              name: 'lookup',
              description: 'Lookup local data',
              parameters: { type: 'object', properties: {} },
            },
          ],
        },
        { googleSearch: {} },
      ]);
      expect(body.toolConfig).toEqual({
        functionCallingConfig: {
          mode: 'ANY',
          allowedFunctionNames: ['lookup'],
        },
      });
    });

    it('should map tool results back to Gemini functionResponse names', () => {
      const svc = makeService();
      const canonical = makeCanonical({
        messages: [
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'call_1',
                name: 'get_weather',
                input: { city: 'Paris' },
              },
            ],
          },
          {
            role: 'tool',
            content: [
              { type: 'tool_result', tool_use_id: 'call_1', content: '22C' },
            ],
          },
        ],
      });

      const body = (svc as any).denormalizeRequest(
        canonical,
        'gemini',
        'gemini-2.5-pro',
      );

      expect(body.contents).toEqual([
        {
          role: 'model',
          parts: [
            {
              functionCall: {
                name: 'get_weather',
                args: { city: 'Paris' },
              },
            },
          ],
        },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'get_weather',
                response: { output: '22C' },
              },
            },
          ],
        },
      ]);
    });
  });

  describe('Gemini upstream forwarding', () => {
    const originalFetch = global.fetch;

    afterEach(() => {
      global.fetch = originalFetch;
      jest.restoreAllMocks();
    });

    it('should use Gemini native endpoints and x-goog-api-key auth', async () => {
      const fetchMock = jest.fn().mockResolvedValue(
        new Response(JSON.stringify({
          responseId: 'gemini-forward',
          modelVersion: 'gemini-2.5-flash',
          candidates: [
            {
              content: { parts: [{ text: 'ok' }] },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
        }), { status: 200 }),
      );
      global.fetch = fetchMock as any;
      const svc = makeServiceWithNode({
        id: 'google',
        protocol: 'gemini',
        base_url: 'https://generativelanguage.googleapis.com',
        endpoint: '/v1beta/models/:model:generateContent',
        api_key: 'gk-test',
        models: ['gemini-2.5-flash'],
      });

      const result = await svc.forward(
        makeCanonical(),
        'google',
        'gemini-2.5-flash',
        routingMeta,
      );

      expect(result.content[0]).toEqual({ type: 'text', text: 'ok' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toBe(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
      );
      const init = fetchMock.mock.calls[0][1];
      expect(init.headers['x-goog-api-key']).toBe('gk-test');
      expect(init.headers.Authorization).toBeUndefined();
      expect(JSON.parse(init.body)).toEqual({
        contents: [{ role: 'user', parts: [{ text: 'Hi' }] }],
      });
    });

    it('should use x-goog-api-key for Google OpenAI-compatible endpoints too', async () => {
      const fetchMock = jest.fn().mockResolvedValue(
        new Response(JSON.stringify({
          id: 'chatcmpl-google',
          model: 'gemini-2.5-flash',
          choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }), { status: 200 }),
      );
      global.fetch = fetchMock as any;
      const svc = makeServiceWithNode({
        id: 'google',
        protocol: 'chat_completions',
        base_url: 'https://generativelanguage.googleapis.com',
        endpoint: '/v1beta/openai/chat/completions',
        auth_type: 'x-api-key',
        api_key: 'gk-test',
        models: ['gemini-2.5-flash'],
      });

      await svc.forward(
        makeCanonical(),
        'google',
        'gemini-2.5-flash',
        routingMeta,
      );

      const init = fetchMock.mock.calls[0][1];
      expect(init.headers['x-goog-api-key']).toBe('gk-test');
      expect(init.headers['x-api-key']).toBeUndefined();
      expect(init.headers['anthropic-version']).toBeUndefined();
    });

    it('should switch Gemini stream requests to streamGenerateContent SSE', () => {
      const svc = makeService();
      const node = {
        protocol: 'gemini',
        endpoint: '/v1beta/models/:model:generateContent',
      };

      expect((svc as any).resolveRequestEndpoint(node, 'gemini-2.5-pro', false))
        .toBe('/v1beta/models/gemini-2.5-pro:generateContent');
      expect((svc as any).resolveRequestEndpoint(node, 'gemini-2.5-pro', true))
        .toBe('/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse');
    });
  });

  // ── Transport failure reporting ─────────────────────────
  describe('transport failure reporting', () => {
    const originalFetch = global.fetch;

    afterEach(() => {
      global.fetch = originalFetch;
    });

    function rejectWithCause(cause: unknown): void {
      global.fetch = jest.fn().mockRejectedValue(
        Object.assign(new TypeError('fetch failed'), { cause }),
      ) as any;
    }

    it('should surface the underlying cause code instead of a bare "fetch failed"', async () => {
      rejectWithCause(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));
      const svc = makeServiceWithNode({ id: 'aigw', timeout_ms: 5000 });

      await expect(
        svc.forward(makeCanonical(), 'aigw', 'gpt-4o', routingMeta),
      ).rejects.toThrow('Failed to connect to aigw: fetch failed (ECONNRESET: read ECONNRESET)');
    });

    it('should list every address family failure from an AggregateError cause', async () => {
      rejectWithCause(
        new AggregateError(
          [
            Object.assign(new Error('connect ENETUNREACH 198.18.0.6:80'), { code: 'ENETUNREACH' }),
            Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:80'), { code: 'ECONNREFUSED' }),
          ],
          'all addresses failed',
        ),
      );
      const svc = makeServiceWithNode({ id: 'aigw', timeout_ms: 5000 });

      await expect(
        svc.forward(makeCanonical(), 'aigw', 'gpt-4o', routingMeta),
      ).rejects.toThrow(
        'Failed to connect to aigw: fetch failed (ENETUNREACH: connect ENETUNREACH 198.18.0.6:80; ECONNREFUSED: connect ECONNREFUSED 127.0.0.1:80)',
      );
    });
  });

  // ── ProviderError ───────────────────────────────────────

  describe('ProviderError', () => {
    it('should have statusCode and nodeId', () => {
      const err = new ProviderError('test error', 429, 'openai');
      expect(err.message).toBe('test error');
      expect(err.statusCode).toBe(429);
      expect(err.nodeId).toBe('openai');
      expect(err.name).toBe('ProviderError');
      expect(err instanceof Error).toBe(true);
    });
  });

  describe('credential pool', () => {
    const originalFetch = global.fetch;

    afterEach(() => {
      global.fetch = originalFetch;
      jest.restoreAllMocks();
    });

    it('retries another credential inside the same node on rate limits', async () => {
      const fetchMock = jest.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'busy' }), { status: 429 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({
          id: 'chatcmpl-credential-pool',
          model: 'gpt-4o',
          choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3, completion_tokens: 2 },
        }), { status: 200 }));
      global.fetch = fetchMock as any;

      const svc = makeServiceWithCredentialPool({
        api_key: undefined,
        credentials: [
          { id: 'a', api_key: 'sk-a', weight: 1, enabled: true },
          { id: 'b', api_key: 'sk-b', weight: 1, enabled: true },
        ],
        credential_pool: {
          enabled: true,
          strategy: 'least_in_flight',
          retry_on_status: [429, 500, 502, 503, 504],
        },
      });

      const response = await svc.forward(
        makeCanonical(),
        'openai',
        'gpt-4o',
        routingMeta,
      );

      expect(response.content[0]).toEqual({ type: 'text', text: 'ok' });
      expect(response.routing.credential_id).toBe('b');
      expect(response.routing.credential_strategy).toBe('least_in_flight');
      expect(response.routing.credential_retry_count).toBe(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect((fetchMock.mock.calls[0][1].headers as Record<string, string>).Authorization).toBe('Bearer sk-a');
      expect((fetchMock.mock.calls[1][1].headers as Record<string, string>).Authorization).toBe('Bearer sk-b');
    });

    it('does not retry client-shape 400 responses across credentials', async () => {
      const fetchMock = jest.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'bad request' }), { status: 400 }),
      );
      global.fetch = fetchMock as any;
      const svc = makeServiceWithCredentialPool({
        api_key: undefined,
        credentials: [
          { id: 'a', api_key: 'sk-a' },
          { id: 'b', api_key: 'sk-b' },
        ],
      });

      await expect(
        svc.forward(makeCanonical(), 'openai', 'gpt-4o', routingMeta),
      ).rejects.toMatchObject({ statusCode: 400, credentialId: 'a' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('keeps cache-aware requests on the provider credential that created cache', async () => {
      const fetchMock = jest.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({
          id: 'chatcmpl-cache-primer',
          model: 'gpt-4o',
          choices: [{ message: { role: 'assistant', content: 'warm' }, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 2,
            prompt_tokens_details: { cached_tokens: 64 },
          },
        }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({
          id: 'chatcmpl-cache-affinity',
          model: 'gpt-4o',
          choices: [{ message: { role: 'assistant', content: 'still warm' }, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: 80,
            completion_tokens: 2,
            prompt_tokens_details: { cached_tokens: 48 },
          },
        }), { status: 200 }));
      global.fetch = fetchMock as any;

      const svc = makeServiceWithCredentialPool({
        api_key: undefined,
        credentials: [
          { id: 'a', api_key: 'sk-a', weight: 1, enabled: true },
          { id: 'b', api_key: 'sk-b', weight: 1, enabled: true },
        ],
        credential_pool: {
          enabled: true,
          strategy: 'cache_aware',
          sticky_by: 'agent_session',
        },
      });

      const metadata = {
        source_format: 'chat_completions' as const,
        raw_headers: {},
        api_key_name: 'claude-code',
      };

      const first = await svc.forward(
        makeCanonical({ metadata: { ...metadata } }),
        'openai',
        'gpt-4o',
        routingMeta,
      );
      const second = await svc.forward(
        makeCanonical({ metadata: { ...metadata } }),
        'openai',
        'gpt-4o',
        routingMeta,
      );

      expect(first.routing.credential_id).toBe('a');
      expect(second.routing.credential_id).toBe('a');
      expect(second.routing.credential_strategy).toBe('cache_aware');
      expect((fetchMock.mock.calls[0][1].headers as Record<string, string>).Authorization).toBe('Bearer sk-a');
      expect((fetchMock.mock.calls[1][1].headers as Record<string, string>).Authorization).toBe('Bearer sk-a');
    });

    it('fails over from a cache-aware credential when the preferred key is rate limited', async () => {
      const fetchMock = jest.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({
          id: 'chatcmpl-cache-primer',
          model: 'gpt-4o',
          choices: [{ message: { role: 'assistant', content: 'warm' }, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 2,
            prompt_tokens_details: { cached_tokens: 64 },
          },
        }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'busy' }), { status: 429 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({
          id: 'chatcmpl-cache-fallback',
          model: 'gpt-4o',
          choices: [{ message: { role: 'assistant', content: 'fallback' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 8, completion_tokens: 2 },
        }), { status: 200 }));
      global.fetch = fetchMock as any;

      const svc = makeServiceWithCredentialPool({
        api_key: undefined,
        credentials: [
          { id: 'a', api_key: 'sk-a', weight: 1, enabled: true },
          { id: 'b', api_key: 'sk-b', weight: 1, enabled: true },
        ],
        credential_pool: {
          enabled: true,
          strategy: 'cache_aware',
          retry_on_status: [429, 500, 502, 503, 504],
        },
      });

      const metadata = {
        source_format: 'chat_completions' as const,
        raw_headers: {},
        api_key_name: 'claude-code',
      };

      await svc.forward(
        makeCanonical({ metadata: { ...metadata } }),
        'openai',
        'gpt-4o',
        routingMeta,
      );
      const fallback = await svc.forward(
        makeCanonical({ metadata: { ...metadata } }),
        'openai',
        'gpt-4o',
        routingMeta,
      );

      expect(fallback.content[0]).toEqual({ type: 'text', text: 'fallback' });
      expect(fallback.routing.credential_id).toBe('b');
      expect(fallback.routing.credential_retry_count).toBe(1);
      expect((fetchMock.mock.calls[1][1].headers as Record<string, string>).Authorization).toBe('Bearer sk-a');
      expect((fetchMock.mock.calls[2][1].headers as Record<string, string>).Authorization).toBe('Bearer sk-b');
    });
  });

  describe('request compatibility', () => {
    it('drops configured request parameters before forwarding', () => {
      const svc = makeService();
      const canonical = makeCanonical({
        top_p: 0.8,
        temperature: 0.2,
        metadata: {
          source_format: 'chat_completions',
          raw_headers: {},
        },
      });
      const body = (svc as any).denormalizeRequest(
        canonical,
        'responses',
        'gpt-5.5-2026-04-24',
      );

      (svc as any).applyNodeRequestCompatibility(
        {
          id: 'compat-gpt',
          protocol: 'responses',
          request_compatibility: { drop_parameters: ['top_p'] },
        },
        body,
      );

      expect(body.top_p).toBeUndefined();
      expect(body.temperature).toBe(0.2);
    });

    it('adds configured default parameters without overriding client values', () => {
      const svc = makeService();
      const body: Record<string, unknown> = {
        model: 'gemini-3.1-pro-preview',
        extra_body: {
          google: {
            thinking_config: { include_thoughts: true },
          },
        },
      };

      (svc as any).applyNodeRequestCompatibility(
        {
          id: 'gemini',
          protocol: 'chat_completions',
          request_compatibility: {
            default_parameters: {
              extra_body: {
                google: {
                  thinking_config: {
                    thinking_budget: 0,
                    include_thoughts: false,
                  },
                },
              },
            },
          },
        },
        body,
      );

      expect(body.extra_body).toEqual({
        google: {
          thinking_config: {
            include_thoughts: true,
            thinking_budget: 0,
          },
        },
      });
    });

    it('normalizes invalid chat function parameter schemas before forwarding', () => {
      const svc = makeService();
      const body: Record<string, unknown> = {
        model: 'gpt-4o',
        tools: [
          {
            type: 'function',
            function: {
              name: 'automation_update',
              description: 'Update automation state',
              parameters: {
                type: 'None',
                anyOf: [{ type: 'object' }, { type: 'null' }],
                enum: ['bad'],
              },
            },
          },
          {
            type: 'function',
            function: {
              name: 'no_args',
              description: 'No argument tool',
            },
          },
        ],
      };

      (svc as any).applyNodeRequestCompatibility(
        {
          id: 'azure-compatible',
          protocol: 'chat_completions',
        },
        body,
      );

      const tools = body.tools as any[];
      expect(tools[0].function.parameters).toEqual({
        type: 'object',
        properties: {},
      });
      expect(tools[0].function.parameters.anyOf).toBeUndefined();
      expect(tools[0].function.parameters.enum).toBeUndefined();
      expect(tools[1].function.parameters).toEqual({
        type: 'object',
        properties: {},
      });
    });

    it('normalizes nested Responses function schemas from Codex tool containers', () => {
      const svc = makeService();
      const body: Record<string, unknown> = {
        model: 'gpt-5.5-2026-04-24',
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Run the task' }],
            tools: [
              {
                type: 'tool_search',
                tools: [
                  {
                    name: 'automation_update',
                    description: 'Update automation state',
                    parameters: {
                      type: 'object',
                      oneOf: [{ required: ['id'] }],
                      properties: { id: { type: 'string' } },
                    },
                  },
                  {
                    type: 'function',
                    name: 'valid_tool',
                    parameters: {
                      type: 'object',
                      properties: { id: { type: 'string' } },
                    },
                  },
                ],
              },
            ],
          },
        ],
        tools: [
          { type: 'web_search_preview' },
          { type: 'function', name: 'top_level', parameters: null },
        ],
      };

      (svc as any).applyNodeRequestCompatibility(
        {
          id: 'public-aigw',
          protocol: 'responses',
        },
        body,
      );

      const input = body.input as any[];
      const nestedTool = input[0].tools[0].tools[0];
      const validTool = input[0].tools[0].tools[1];
      const topLevelTools = body.tools as any[];
      expect(nestedTool.parameters).toEqual({
        type: 'object',
        properties: { id: { type: 'string' } },
      });
      expect(nestedTool.parameters.oneOf).toBeUndefined();
      expect(validTool.parameters).toEqual({
        type: 'object',
        properties: { id: { type: 'string' } },
      });
      expect(topLevelTools[0]).toEqual({ type: 'web_search_preview' });
      expect(topLevelTools[1].parameters).toEqual({
        type: 'object',
        properties: {},
      });
    });

    it('fills empty descriptions in native Responses tool containers', () => {
      const svc = makeService();
      const body: Record<string, unknown> = {
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Run the task' }],
            tools: [
              {
                name: 'nested_tool',
                description: '',
                parameters: { type: 'object', properties: {} },
              },
              {
                type: 'custom',
                name: 'nested_custom_tool',
                description: '   ',
                format: { type: 'text' },
              },
            ],
          },
        ],
        tools: [
          {
            type: 'function',
            name: 'top_level_tool',
            description: '   ',
            parameters: { type: 'object', properties: {} },
          },
          {
            type: 'custom',
            name: 'top_level_custom_tool',
            description: '',
            format: { type: 'text' },
          },
        ],
      };

      (svc as any).applyNodeRequestCompatibility(
        {
          id: 'public-aigw',
          protocol: 'responses',
        },
        body,
        true,
      );

      const input = body.input as any[];
      const topLevelTools = body.tools as any[];
      expect(input[0].tools[0].description).toBe('Tool nested_tool');
      expect(input[0].tools[1].description).toBe('Tool nested_custom_tool');
      expect(topLevelTools[0].description).toBe('Tool top_level_tool');
      expect(topLevelTools[1].description).toBe('Tool top_level_custom_tool');
    });
  });

  // ── Native Messages Passthrough (via private methods accessed indirectly) ──

  describe('denormalizeRequest — native messages passthrough', () => {
    it('should passthrough raw_body for messages → messages', () => {
      const svc = makeService();
      const canonical = {
        messages: [{ role: 'user' as const, content: 'Hi' }],
        stream: false,
        metadata: {
          source_format: 'messages' as const,
          original_model: 'claude-3-opus',
          raw_headers: {},
          raw_body: {
            model: 'claude-3-opus',
            stream: false,
            messages: [{ role: 'user', content: 'Hi' }],
            max_tokens: 100,
          },
        },
      };
      // Access private method via any cast (matching existing test patterns)
      const body = (svc as any).denormalizeRequest(canonical, 'messages', 'claude-3-opus-20240229');
      expect(body.model).toBe('claude-3-opus-20240229'); // remapped to target model
      expect(body.stream).toBe(false);
      expect(body.messages).toBeDefined();
      expect(body.max_tokens).toBe(100);
    });

    it('should sanitize empty text blocks in native passthrough', () => {
      const svc = makeService();
      const canonical = {
        messages: [{ role: 'user' as const, content: 'Hi' }],
        stream: true,
        metadata: {
          source_format: 'messages' as const,
          original_model: 'claude-3-opus',
          raw_headers: {},
          raw_body: {
            model: 'claude-3-opus',
            stream: true,
            messages: [
              {
                role: 'assistant',
                content: [
                  { type: 'text', text: '' },
                  { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { cmd: 'ls' } },
                ],
              },
            ],
          },
        },
      };
      const body = (svc as any).denormalizeRequest(canonical, 'messages', 'claude-3-opus');
      // Empty text block should be removed
      expect(body.messages[0].content).toHaveLength(1);
      expect(body.messages[0].content[0].type).toBe('tool_use');
    });

    it('should preserve signed thinking blocks in native passthrough', () => {
      const svc = makeService();
      const canonical = {
        messages: [{ role: 'user' as const, content: 'Hi' }],
        stream: true,
        metadata: {
          source_format: 'messages' as const,
          original_model: 'claude-3-opus',
          raw_headers: {},
          raw_body: {
            model: 'claude-3-opus',
            stream: true,
            messages: [
              {
                role: 'assistant',
                content: [
                  {
                    type: 'thinking',
                    thinking: 'short prior thought',
                    signature: 'sig_123',
                  },
                  {
                    type: 'redacted_thinking',
                    data: 'opaque',
                  },
                  { type: 'text', text: 'hello' },
                ],
              },
            ],
          },
        },
      };

      const body = (svc as any).denormalizeRequest(canonical, 'messages', 'claude-3-opus');

      expect(body.messages[0].content).toEqual(canonical.metadata.raw_body.messages[0].content);
    });

    it('should coerce invalid native content fields to Anthropic-compatible values', () => {
      const svc = makeService();
      const canonical = {
        messages: [{ role: 'user' as const, content: 'Hi' }],
        stream: true,
        metadata: {
          source_format: 'messages' as const,
          original_model: 'claude-3-opus',
          raw_headers: {},
          raw_body: {
            model: 'claude-3-opus',
            stream: true,
            messages: [
              { role: 'assistant', content: null },
              {
                role: 'user',
                content: [
                  {
                    type: 'tool_result',
                    tool_use_id: 'toolu_1',
                    content: null,
                  },
                  {
                    type: 'tool_result',
                    tool_use_id: 'toolu_2',
                    content: { ok: true },
                  },
                ],
              },
            ],
          },
        },
      };

      const body = (svc as any).denormalizeRequest(canonical, 'messages', 'claude-3-opus');

      expect(body.messages[0].content).toBe('');
      expect(body.messages[1].content[0].content).toBe('');
      expect(body.messages[1].content[1].content).toBe('{"ok":true}');
    });

    it('should normalize invalid native content blocks after compaction', () => {
      const svc = makeService();
      const canonical = {
        messages: [{ role: 'user' as const, content: 'Hi' }],
        stream: true,
        metadata: {
          source_format: 'messages' as const,
          original_model: 'claude-3-opus',
          raw_headers: {},
          raw_body: {
            model: 'claude-3-opus',
            stream: true,
            system: [{}, null, 'system note'],
            messages: [
              {
                role: 'user',
                content: [
                  null,
                  'plain text',
                  7,
                  {},
                  { type: 'text', text: null },
                  { type: 'text', text: 123 },
                  { type: 'thinking', thinking: 'hidden', signature: 'sig' },
                ],
              },
              {
                role: 'assistant',
                content: [{ type: 'thinking', thinking: 'hidden', signature: 'sig' }],
              },
            ],
          },
        },
      };

      const body = (svc as any).denormalizeRequest(canonical, 'messages', 'claude-3-opus');

      expect(body.system).toEqual([
        { type: 'text', text: '{}' },
        { type: 'text', text: 'system note' },
      ]);
      expect(body.messages[0].content).toEqual([
        { type: 'text', text: 'plain text' },
        { type: 'text', text: '7' },
        { type: 'text', text: '{}' },
        { type: 'text', text: '123' },
        { type: 'thinking', thinking: 'hidden', signature: 'sig' },
      ]);
      expect(body.messages[1].content).toEqual([
        { type: 'thinking', thinking: 'hidden', signature: 'sig' },
      ]);
    });

    it('should drop invalid native messages before passthrough', () => {
      const svc = makeService();
      const canonical = {
        messages: [{ role: 'user' as const, content: 'Hi' }],
        stream: true,
        metadata: {
          source_format: 'messages' as const,
          original_model: 'claude-3-opus',
          raw_headers: {},
          raw_body: {
            model: 'claude-3-opus',
            stream: true,
            messages: [
              null,
              { role: 'system', content: 'bad role' },
              { role: 'user', content: 'keep' },
            ],
          },
        },
      };

      const body = (svc as any).denormalizeRequest(canonical, 'messages', 'claude-3-opus');

      expect(body.messages).toEqual([{ role: 'user', content: 'keep' }]);
    });

    it('should preserve native Anthropic structured-output output_config in passthrough', () => {
      const schema = {
        type: 'object',
        properties: { ok: { type: 'boolean' } },
        required: ['ok'],
      };
      const svc = makeService();
      const canonical = {
        messages: [{ role: 'user' as const, content: 'Hi' }],
        stream: false,
        response_format: {
          type: 'json_schema' as const,
          source: 'messages.output_config.format' as const,
          raw: { type: 'json_schema', schema },
          json_schema: { schema },
        },
        structured_output: {
          requested: true,
          type: 'json_schema' as const,
          source: 'messages.output_config.format' as const,
          schema,
        },
        metadata: {
          source_format: 'messages' as const,
          original_model: 'claude-3-opus',
          raw_headers: {},
          raw_body: {
            model: 'claude-3-opus',
            stream: false,
            messages: [{ role: 'user', content: 'Hi' }],
            output_config: { format: { type: 'json_schema', schema } },
          },
        },
      };

      const body = (svc as any).denormalizeRequest(canonical, 'messages', 'claude-3-opus');

      expect(body.output_config).toEqual({
        format: { type: 'json_schema', schema },
      });
      expect(body.response_format).toBeUndefined();
      expect(body.text).toBeUndefined();
    });

    it('should preserve native Anthropic thinking in messages passthrough', () => {
      const svc = makeService();
      const thinking = { type: 'enabled', budget_tokens: 1024 };
      const canonical = {
        messages: [{ role: 'user' as const, content: 'Hi' }],
        stream: false,
        thinking: {
          source: 'messages.thinking' as const,
          raw: thinking,
          type: 'enabled',
          budget_tokens: 1024,
        },
        reasoning: {
          requested: true,
          source: 'messages.thinking' as const,
          effort: 'unknown' as const,
          budget_tokens: 1024,
          thinking: {
            source: 'messages.thinking' as const,
            raw: thinking,
            type: 'enabled',
            budget_tokens: 1024,
          },
          raw: thinking,
        },
        metadata: {
          source_format: 'messages' as const,
          original_model: 'claude-3-opus',
          raw_headers: {},
          raw_body: {
            model: 'claude-3-opus',
            stream: false,
            messages: [{ role: 'user', content: 'Hi' }],
            thinking,
          },
        },
      };

      const body = (svc as any).denormalizeRequest(canonical, 'messages', 'claude-3-opus');

      expect(body.thinking).toEqual(thinking);
    });
  });

  describe('denormalizeRequest — native responses passthrough', () => {
    it('should preserve built-in Responses tools such as web_search_preview', () => {
      const svc = makeService();
      const canonical = makeCanonical({
        stream: true,
        metadata: {
          source_format: 'responses',
          original_model: 'gpt-5.5-2026-04-24',
          raw_headers: {},
          raw_body: {
            model: 'gpt-5.5-2026-04-24',
            stream: true,
            input: 'Search the web',
            tools: [
              { type: 'web_search_preview', search_context_size: 'low' },
              {
                type: 'function',
                name: 'lookup',
                description: 'Lookup local data',
                parameters: { type: 'object' },
              },
            ],
            tool_choice: 'auto',
            include: ['web_search_call.action.sources'],
            parallel_tool_calls: true,
          },
        },
        tools: [
          {
            name: 'lookup',
            description: 'Lookup local data',
            parameters: { type: 'object' },
          },
        ],
      });

      const body = (svc as any).denormalizeRequest(
        canonical,
        'responses',
        'gpt-5.5-2026-04-24',
      );

      expect(body.tools).toEqual([
        { type: 'web_search_preview', search_context_size: 'low' },
        {
          type: 'function',
          name: 'lookup',
          description: 'Lookup local data',
          parameters: { type: 'object' },
        },
      ]);
      expect(body.tool_choice).toBe('auto');
      expect(body.include).toEqual(['web_search_call.action.sources']);
      expect(body.parallel_tool_calls).toBe(true);
    });

    it('should preserve non-function Responses tool_choice objects', () => {
      const svc = makeService();
      const canonical = makeCanonical({
        metadata: {
          source_format: 'responses',
          original_model: 'gpt-5.5-2026-04-24',
          raw_headers: {},
          raw_body: {
            model: 'gpt-5.5-2026-04-24',
            input: 'Search the web',
            tools: [{ type: 'web_search_preview' }],
            tool_choice: { type: 'web_search_preview' },
          },
        },
      });

      const body = (svc as any).denormalizeRequest(
        canonical,
        'responses',
        'gpt-5.5-2026-04-24',
      );

      expect(body.tools).toEqual([{ type: 'web_search_preview' }]);
      expect(body.tool_choice).toEqual({ type: 'web_search_preview' });
    });

    it('should clone native Responses request bodies for responses → responses routes', () => {
      const svc = makeService();
      const rawBody = {
        model: 'gpt-5.5-2026-04-24',
        stream: true,
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Use a tool' }],
          },
        ],
        tools: [{ type: 'function', name: 'edit_file', parameters: { type: 'object' } }],
        tool_choice: 'auto',
        previous_response_id: 'resp_prev',
        parallel_tool_calls: true,
        truncation: 'auto',
        include: ['reasoning.encrypted_content'],
        reasoning: { effort: 'ultra' },
        metadata: { codex: 'true' },
        extra_native_field: { preserved: true },
      };
      const canonical = makeCanonical({
        stream: true,
        metadata: {
          source_format: 'responses',
          original_model: 'gpt-5.5-2026-04-24',
          raw_headers: {},
          raw_body: rawBody,
        },
      });

      const body = (svc as any).denormalizeRequest(
        canonical,
        'responses',
        'gpt-5.5-2026-04-24-upstream',
      );

      expect(body).toEqual({
        ...rawBody,
        model: 'gpt-5.5-2026-04-24-upstream',
        stream: true,
      });
      expect(body).not.toBe(rawBody);
      expect(body.input).not.toBe(rawBody.input);
    });
  });

  describe('denormalizeRequest — native chat completions passthrough', () => {
    it('should preserve provider-specific reasoning efforts on native Chat routes', () => {
      const svc = makeService();
      const canonical = makeCanonical({
        reasoning_effort: 'unknown',
        reasoning: {
          requested: true,
          source: 'chat_completions.reasoning_effort',
          effort: 'unknown',
          raw: 'ultra',
        },
        metadata: {
          source_format: 'chat_completions',
          original_model: 'gpt-5.6',
          raw_headers: {},
          raw_body: {
            model: 'gpt-5.6',
            messages: [{ role: 'user', content: 'Solve carefully' }],
            reasoning_effort: 'ultra',
          },
        },
      });

      const body = (svc as any).denormalizeRequest(
        canonical,
        'chat_completions',
        'gpt-5.6',
      );

      expect(body.reasoning_effort).toBe('ultra');
    });

    it('should preserve Chat-specific top-level fields for chat → chat forwarding', () => {
      const svc = makeService();
      const canonical = makeCanonical({
        stream: true,
        max_tokens: 128,
        metadata: {
          source_format: 'chat_completions',
          original_model: 'gpt-4o',
          raw_headers: {},
          raw_body: {
            model: 'gpt-4o',
            messages: [{ role: 'user', content: 'Hi' }],
            stream: true,
            max_completion_tokens: 128,
            stream_options: { include_usage: true },
            parallel_tool_calls: true,
            seed: 42,
            user: 'u_123',
            logprobs: true,
            top_logprobs: 2,
          },
        },
      });

      const body = (svc as any).denormalizeRequest(
        canonical,
        'chat_completions',
        'gpt-4o',
      );

      expect(body.max_tokens).toBeUndefined();
      expect(body.max_completion_tokens).toBe(128);
      expect(body.stream_options).toEqual({ include_usage: true });
      expect(body.parallel_tool_calls).toBe(true);
      expect(body.seed).toBe(42);
      expect(body.user).toBe('u_123');
      expect(body.logprobs).toBe(true);
      expect(body.top_logprobs).toBe(2);
    });

    it('should preserve explicit Chat stream_options over gateway usage defaults', () => {
      const svc = makeService();
      const canonical = makeCanonical({
        stream: true,
        metadata: {
          source_format: 'chat_completions',
          original_model: 'gpt-4o',
          raw_headers: {},
          raw_body: {
            model: 'gpt-4o',
            messages: [{ role: 'user', content: 'Hi' }],
            stream: true,
            stream_options: { include_usage: false },
          },
        },
      });

      const body = (svc as any).denormalizeRequest(
        canonical,
        'chat_completions',
        'gpt-4o',
      );

      expect(body.stream_options).toEqual({ include_usage: false });
    });
  });

  // ── Header extraction ──────────────────────────────────

  describe('extractNativeMessageHeaders', () => {
    it('should forward anthropic-version header', () => {
      const svc = makeService();
      const canonical = {
        messages: [],
        stream: false,
        metadata: {
          source_format: 'messages' as const,
          raw_headers: { 'anthropic-version': '2023-06-01' },
        },
      };
      const headers = (svc as any).extractNativeMessageHeaders(canonical);
      expect(headers['anthropic-version']).toBe('2023-06-01');
    });

    it('should filter anthropic-beta to allowed values only', () => {
      const svc = makeService();
      const canonical = {
        messages: [],
        stream: false,
        metadata: {
          source_format: 'messages' as const,
          raw_headers: {
            'anthropic-beta': 'claude-code-20250219,some-unknown-beta,context-management-2025-06-27,fast-mode-2026-02-01',
          },
        },
      };
      const headers = (svc as any).extractNativeMessageHeaders(canonical);
      expect(headers['anthropic-beta']).toBe('claude-code-20250219,context-management-2025-06-27,fast-mode-2026-02-01');
    });

    it('should not set anthropic-beta if all betas are filtered out', () => {
      const svc = makeService();
      const canonical = {
        messages: [],
        stream: false,
        metadata: {
          source_format: 'messages' as const,
          raw_headers: { 'anthropic-beta': 'unknown-beta-1,unknown-beta-2' },
        },
      };
      const headers = (svc as any).extractNativeMessageHeaders(canonical);
      expect(headers['anthropic-beta']).toBeUndefined();
    });
  });

  // ── Cache Token Extraction ──────────────────────────────

  describe('normalizeResponse — cache token extraction', () => {
    it('should extract cache tokens from Anthropic Messages response', () => {
      const svc = makeService();
      const body = {
        id: 'msg_cache', model: 'claude-3-sonnet',
        content: [{ type: 'text', text: 'Cached response' }],
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 1000, output_tokens: 200,
          cache_creation_input_tokens: 500,
          cache_read_input_tokens: 300,
        },
      };
      const result = svc.normalizeResponse(body, 'messages', routingMeta, 'claude', 'claude-3-sonnet', 100);
      expect(result.usage.cache_creation_input_tokens).toBe(500);
      expect(result.usage.cache_read_input_tokens).toBe(300);
    });

    it('should extract cached_tokens from OpenAI Chat Completions response', () => {
      const svc = makeService();
      const body = {
        id: 'chatcmpl-cache', model: 'gpt-4o',
        choices: [{ message: { content: 'Hello' }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 500, completion_tokens: 50,
          prompt_tokens_details: { cached_tokens: 200 },
        },
      };
      const result = svc.normalizeResponse(body, 'chat_completions', routingMeta, 'openai', 'gpt-4o', 100);
      expect(result.usage.cache_read_input_tokens).toBe(200);
    });

    it('should extract cached_tokens from OpenAI Responses API response', () => {
      const svc = makeService();
      const body = {
        id: 'resp_cache', model: 'gpt-4.1', status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'Answer' }] }],
        usage: {
          input_tokens: 800, output_tokens: 100,
          input_token_details: { cached_tokens: 400 },
        },
      };
      const result = svc.normalizeResponse(body, 'responses', routingMeta, 'openai', 'gpt-4.1', 100);
      expect(result.usage.cache_read_input_tokens).toBe(400);
    });

    it('should extract cached_tokens from OpenAI Responses input_tokens_details', () => {
      const svc = makeService();
      const body = {
        id: 'resp_cache_modern', model: 'gpt-5.4', status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'Answer' }] }],
        usage: {
          input_tokens: 800, output_tokens: 100,
          input_tokens_details: { cached_tokens: 640 },
        },
      };
      const result = svc.normalizeResponse(body, 'responses', routingMeta, 'tokenflux', 'gpt-5.4', 100);
      expect(result.usage.cache_read_input_tokens).toBe(640);
    });

    it('should default cache tokens to 0 when not present', () => {
      const svc = makeService();
      const body = {
        id: 'msg_no_cache', model: 'claude-3-opus',
        content: [{ type: 'text', text: 'No cache' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 100, output_tokens: 50 },
      };
      const result = svc.normalizeResponse(body, 'messages', routingMeta, 'claude', 'claude-3-opus', 100);
      expect(result.usage.cache_creation_input_tokens).toBe(0);
      expect(result.usage.cache_read_input_tokens).toBe(0);
    });
  });

  // ── Forward (end-to-end with mocked fetch) ────────────────

  describe('forward — with mocked fetch', () => {
    const originalFetch = global.fetch;
    afterEach(() => { global.fetch = originalFetch; });

    it('should forward request and return normalized response', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: jest.fn().mockResolvedValue({
          id: 'chatcmpl-test', model: 'gpt-4o',
          choices: [{ message: { content: 'Hello!' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      }) as any;

      const svc = makeServiceWithNode();
      const result = await svc.forward(makeCanonical(), 'openai', 'gpt-4o', routingMeta);
      expect(result.id).toBe('chatcmpl-test');
      expect(result.content[0]).toEqual({ type: 'text', text: 'Hello!' });
    });

    it('should send the upstream model when a public route model is aliased', async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: jest.fn().mockResolvedValue({
          id: 'chatcmpl-alias',
          model: 'claude-opus-4-7',
          choices: [{ message: { content: 'Hello!' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      });
      global.fetch = fetchMock as any;

      const svc = makeServiceWithNode({
        models: ['claude-opus-4-7-ada'],
        upstream_model_aliases: {
          'claude-opus-4-7-ada': 'claude-opus-4-7',
        },
      });
      const result = await svc.forward(
        makeCanonical(),
        'openai',
        'claude-opus-4-7-ada',
        routingMeta,
      );

      const [, opts] = fetchMock.mock.calls[0];
      expect(JSON.parse(opts.body as string).model).toBe('claude-opus-4-7');
      expect(result.model).toBe('claude-opus-4-7');
    });

    it('should preserve reserved tool schemas when forwarding native Responses requests', async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: jest.fn().mockResolvedValue({
          id: 'resp_reserved_tool',
          model: 'gpt-5.6-sol-2026-07-09',
          status: 'completed',
          output: [
            {
              type: 'message',
              content: [{ type: 'output_text', text: 'Delegated' }],
            },
          ],
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      });
      global.fetch = fetchMock as any;
      const reservedTool = {
        type: 'function',
        name: 'collaboration.spawn_agent',
        description: 'Spawn a collaborating agent',
        parameters: {
          type: 'object',
          properties: {
            task_name: { type: 'string' },
            message: { type: 'string' },
          },
          required: ['task_name', 'message'],
          oneOf: [
            { required: ['task_name', 'message'] },
            { required: ['task_name', 'message', 'fork_turns'] },
          ],
          additionalProperties: false,
        },
        strict: true,
      };
      const malformedTool = {
        type: 'function',
        name: 'legacy_tool',
        parameters: {
          type: 'None',
          anyOf: [{ type: 'object' }, { type: 'null' }],
        },
      };
      const canonical = makeCanonical({
        metadata: {
          source_format: 'responses',
          original_model: 'gpt-5.6-sol',
          raw_headers: {},
          raw_body: {
            model: 'gpt-5.6-sol',
            stream: false,
            input: 'Delegate this task',
            tools: [reservedTool, malformedTool],
          },
        },
      });
      const svc = makeServiceWithNode({
        id: 'gpt-5.6-responses',
        protocol: 'responses',
        endpoint: '/v1/responses',
        models: ['gpt-5.6-sol-2026-07-09'],
        request_compatibility: { drop_parameters: ['top_p'] },
      });

      await svc.forward(
        canonical,
        'gpt-5.6-responses',
        'gpt-5.6-sol-2026-07-09',
        routingMeta,
      );

      const [, options] = fetchMock.mock.calls[0];
      const upstreamBody = JSON.parse(options.body as string);
      expect(upstreamBody.tools[0]).toEqual(reservedTool);
      expect(upstreamBody.tools[1].parameters).toEqual({
        type: 'object',
        properties: {},
      });
    });

    it('should retry an intermittent reserved collaboration tool schema mismatch once', async () => {
      const schemaMismatch = {
        error: {
          message:
            "Invalid Value: 'tools'. Function 'collaboration.spawn_agent' is reserved for use by this model and must match the configured schema.",
          type: 'invalid_request_error',
          param: 'tools',
        },
      };
      const fetchMock = jest
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify(schemaMismatch), { status: 400 }),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              id: 'resp_reserved_tool_retry',
              model: 'gpt-5.6-sol-2026-07-09',
              status: 'completed',
              output: [
                {
                  type: 'message',
                  content: [{ type: 'output_text', text: 'Recovered' }],
                },
              ],
              usage: { input_tokens: 10, output_tokens: 2 },
            }),
            { status: 200 },
          ),
        );
      global.fetch = fetchMock as any;
      const reservedTool = {
        type: 'namespace',
        name: 'collaboration',
        description: 'Tools for spawning and managing sub-agents.',
        tools: [
          {
            type: 'function',
            name: 'spawn_agent',
            description: 'Spawn a collaborating agent',
            parameters: {
              type: 'object',
              properties: {
                task_name: { type: 'string' },
                message: { type: 'string' },
                model: { type: 'string' },
                reasoning_effort: { type: 'string' },
              },
              required: ['task_name', 'message'],
              additionalProperties: false,
            },
            strict: false,
          },
        ],
      };
      const canonical = makeCanonical({
        metadata: {
          source_format: 'responses',
          original_model: 'gpt-5.6-sol',
          raw_headers: {},
          raw_body: {
            model: 'gpt-5.6-sol',
            stream: false,
            input: 'Delegate this task',
            tools: [reservedTool],
          },
        },
      });
      const svc = makeServiceWithNode({
        id: 'gpt-5.6-responses',
        protocol: 'responses',
        endpoint: '/v1/responses',
      });

      const result = await svc.forward(
        canonical,
        'gpt-5.6-responses',
        'gpt-5.6-sol-2026-07-09',
        routingMeta,
      );

      expect(result.content[0]).toEqual({ type: 'text', text: 'Recovered' });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const firstBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
      const retryBody = JSON.parse(fetchMock.mock.calls[1][1].body as string);
      expect(retryBody).toEqual(firstBody);
      expect(retryBody.tools[0]).toEqual(reservedTool);
    });

    it('should stop after one reserved collaboration tool schema retry', async () => {
      const errorBody = JSON.stringify({
        error: {
          message:
            "Invalid Value: 'tools'. Function 'collaboration.spawn_agent' is reserved for use by this model and must match the configured schema.",
        },
      });
      const fetchMock = jest.fn().mockImplementation(() =>
        Promise.resolve(new Response(errorBody, { status: 400 })),
      );
      global.fetch = fetchMock as any;
      const canonical = makeCanonical({
        metadata: {
          source_format: 'responses',
          original_model: 'gpt-5.6-sol',
          raw_headers: {},
          raw_body: {
            model: 'gpt-5.6-sol',
            stream: false,
            input: 'Delegate this task',
            tools: [
              {
                type: 'function',
                name: 'collaboration.spawn_agent',
                parameters: { type: 'object', properties: {} },
              },
            ],
          },
        },
      });
      const svc = makeServiceWithNode({
        id: 'gpt-5.6-responses',
        protocol: 'responses',
        endpoint: '/v1/responses',
      });

      await expect(
        svc.forward(
          canonical,
          'gpt-5.6-responses',
          'gpt-5.6-sol-2026-07-09',
          routingMeta,
        ),
      ).rejects.toMatchObject({ statusCode: 400 });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('should stringify Anthropic tool result content blocks when the node requests compatibility mode', async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: jest.fn().mockResolvedValue({
          id: 'msg_compat',
          model: 'claude-opus-4-7',
          content: [{ type: 'text', text: 'OK' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      });
      global.fetch = fetchMock as any;

      const svc = makeServiceWithNode({
        protocol: 'messages',
        base_url: 'https://anthropic-compatible.example.com',
        endpoint: '/v1/messages',
        models: ['claude-opus-4-7'],
        request_compatibility: {
          messages_tool_result_content: 'string',
        },
      });
      await svc.forward(
        makeCanonical({
          stream: false,
          metadata: {
            source_format: 'messages',
            raw_headers: {},
            raw_body: {
              model: 'claude-opus-4-7',
              stream: false,
              messages: [
                {
                  role: 'user',
                  content: [
                    {
                      type: 'tool_result',
                      tool_use_id: 'toolu_1',
                      content: [{ type: 'text', text: 'ok' }],
                    },
                  ],
                },
              ],
            },
          },
        }),
        'anthropic-compatible',
        'claude-opus-4-7',
        routingMeta,
      );

      const [, opts] = fetchMock.mock.calls[0];
      const body = JSON.parse(opts.body as string);
      expect(body.messages[0].content[0]).toEqual({
        type: 'tool_result',
        tool_use_id: 'toolu_1',
        content: 'ok',
      });
    });

    it('should stringify chat tool history when the node requests compatibility mode', async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: jest.fn().mockResolvedValue({
          id: 'chatcmpl_tool_compat',
          model: 'MiniMax-M3',
          choices: [{ message: { content: 'pong' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      });
      global.fetch = fetchMock as any;

      const svc = makeServiceWithNode({
        id: 'minimax',
        name: 'MiniMax',
        protocol: 'chat_completions',
        base_url: 'https://api.minimaxi.com',
        endpoint: '/v1/chat/completions',
        models: ['MiniMax-M3'],
        request_compatibility: {
          drop_parameters: ['tools', 'tool_choice', 'parallel_tool_calls'],
          chat_tool_messages: 'stringify_as_user',
        },
      });
      await svc.forward(
        makeCanonical({
          messages: [
            { role: 'user', content: 'Hi' },
            {
              role: 'assistant',
              content: [
                {
                  type: 'tool_use',
                  id: 'call_1',
                  name: 'lookup',
                  input: { q: 'status' },
                },
              ],
            },
            {
              role: 'tool',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'call_1',
                  content: [{ type: 'text', text: 'ok' }],
                },
              ],
            },
            { role: 'user', content: 'Reply exactly: pong' },
          ],
          tools: [
            {
              name: 'lookup',
              description: 'Lookup status',
              parameters: { type: 'object' },
            },
          ],
          tool_choice: 'auto',
        }),
        'minimax',
        'MiniMax-M3',
        routingMeta,
      );

      const [, opts] = fetchMock.mock.calls[0];
      const body = JSON.parse(opts.body as string);
      expect(body.tools).toBeUndefined();
      expect(body.tool_choice).toBeUndefined();
      expect(body.messages[1]).toEqual({
        role: 'assistant',
        content: '[Tool call call_1] lookup: {"q":"status"}',
      });
      expect(body.messages[2]).toEqual({
        role: 'user',
        content: '[Tool result call_1]\nok',
      });
    });

    it('should keep native Anthropic tool result content blocks by default', async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: jest.fn().mockResolvedValue({
          id: 'msg_native',
          model: 'claude-opus-4-7',
          content: [{ type: 'text', text: 'OK' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      });
      global.fetch = fetchMock as any;

      const svc = makeServiceWithNode({
        protocol: 'messages',
        base_url: 'https://api.anthropic.com',
        endpoint: '/v1/messages',
        models: ['claude-opus-4-7'],
      });
      await svc.forward(
        makeCanonical({
          stream: false,
          metadata: {
            source_format: 'messages',
            raw_headers: {},
            raw_body: {
              model: 'claude-opus-4-7',
              stream: false,
              messages: [
                {
                  role: 'user',
                  content: [
                    {
                      type: 'tool_result',
                      tool_use_id: 'toolu_1',
                      content: [{ type: 'text', text: 'ok' }],
                    },
                  ],
                },
              ],
            },
          },
        }),
        'anthropic',
        'claude-opus-4-7',
        routingMeta,
      );

      const [, opts] = fetchMock.mock.calls[0];
      const body = JSON.parse(opts.body as string);
      expect(body.messages[0].content[0]).toEqual({
        type: 'tool_result',
        tool_use_id: 'toolu_1',
        content: [{ type: 'text', text: 'ok' }],
      });
    });

    it('should add an empty input object to native Anthropic tool_use blocks when missing', async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: jest.fn().mockResolvedValue({
          id: 'msg_tool_use',
          model: 'claude-opus-4-7',
          content: [{ type: 'text', text: 'OK' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      });
      global.fetch = fetchMock as any;

      const svc = makeServiceWithNode({
        protocol: 'messages',
        base_url: 'https://api.anthropic.com',
        endpoint: '/v1/messages',
        models: ['claude-opus-4-7'],
      });
      await svc.forward(
        makeCanonical({
          stream: false,
          metadata: {
            source_format: 'messages',
            raw_headers: {},
            raw_body: {
              model: 'claude-opus-4-7',
              stream: false,
              messages: [
                {
                  role: 'assistant',
                  content: [
                    {
                      type: 'tool_use',
                      id: 'toolu_missing_input',
                      name: 'lookup',
                    },
                  ],
                },
              ],
            },
          },
        }),
        'anthropic',
        'claude-opus-4-7',
        routingMeta,
      );

      const [, opts] = fetchMock.mock.calls[0];
      const body = JSON.parse(opts.body as string);
      expect(body.messages[0].content[0]).toEqual({
        type: 'tool_use',
        id: 'toolu_missing_input',
        name: 'lookup',
        input: {},
      });
    });

    it('should add an empty input object to nested native tool_use blocks when missing', async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: jest.fn().mockResolvedValue({
          id: 'msg_nested_tool_use',
          model: 'claude-opus-4-7',
          content: [{ type: 'text', text: 'OK' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      });
      global.fetch = fetchMock as any;

      const svc = makeServiceWithNode({
        protocol: 'messages',
        base_url: 'https://api.anthropic.com',
        endpoint: '/v1/messages',
        models: ['claude-opus-4-7'],
      });
      await svc.forward(
        makeCanonical({
          stream: false,
          metadata: {
            source_format: 'messages',
            raw_headers: {},
            raw_body: {
              model: 'claude-opus-4-7',
              stream: false,
              messages: [
                {
                  role: 'assistant',
                  content: [
                    {
                      tool_use: {
                        id: 'toolu_nested_missing_input',
                        name: 'lookup',
                      },
                    },
                  ],
                },
              ],
            },
          },
        }),
        'anthropic',
        'claude-opus-4-7',
        routingMeta,
      );

      const [, opts] = fetchMock.mock.calls[0];
      const body = JSON.parse(opts.body as string);
      expect(body.messages[0].content[0]).toEqual({
        tool_use: {
          id: 'toolu_nested_missing_input',
          name: 'lookup',
          input: {},
        },
      });
    });

    it('should resolve DeepSeek cache usage through the usage schema registry', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: jest.fn().mockResolvedValue({
          id: 'chatcmpl-deepseek',
          model: 'deepseek-chat',
          choices: [{ message: { content: 'Hello from DeepSeek' }, finish_reason: 'stop' }],
          usage: {
            completion_tokens: 12,
            prompt_cache_hit_tokens: 90,
            prompt_cache_miss_tokens: 30,
            total_tokens: 132,
          },
        }),
      }) as any;

      const svc = makeServiceWithConfig(
        {
          getMergedCatalog: jest.fn().mockReturnValue({
            version: 1,
            generated_at: '2026-05-05',
            providers: BUILTIN_PROVIDER_CATALOG,
          }),
        },
        {
          id: 'deepseek',
          name: 'DeepSeek',
          base_url: 'https://api.deepseek.com',
          api_key: 'sk-deepseek',
          models: ['deepseek-chat'],
        },
      );

      const result = await svc.forward(
        makeCanonical(),
        'deepseek',
        'deepseek-chat',
        routingMeta,
      );

      expect(result.usage).toEqual(
        expect.objectContaining({
          input_tokens: 120,
          output_tokens: 12,
          cache_read_input_tokens: 90,
        }),
      );
    });

    it('should fall back to the legacy hardcoded parser when no usage schema is available', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: jest.fn().mockResolvedValue({
          id: 'chatcmpl-custom',
          model: 'custom-model',
          choices: [{ message: { content: 'Legacy parser still works' }, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: 40,
            completion_tokens: 5,
            prompt_tokens_details: { cached_tokens: 10 },
          },
        }),
      }) as any;

      const svc = makeServiceWithConfig(
        {},
        {
          id: 'custom-openai',
          name: 'Custom OpenAI-Compatible',
          base_url: 'https://custom.example.com',
          api_key: 'sk-custom',
          models: ['custom-model'],
        },
      );

      const result = await svc.forward(
        makeCanonical(),
        'custom-openai',
        'custom-model',
        routingMeta,
      );

      expect(result.usage).toEqual(
        expect.objectContaining({
          input_tokens: 40,
          output_tokens: 5,
          cache_read_input_tokens: 10,
        }),
      );
    });

    it('should route the v2.4 OpenAI-compatible provider batch through standard chat transport', async () => {
      const providers = BUILTIN_PROVIDER_CATALOG.filter((provider) =>
        ['deepinfra', 'nebius', 'novita', 'friendli'].includes(provider.id),
      );

      for (const provider of providers) {
        const model = provider.models.find((entry) => entry.endpoints.chat_completions);
        const fetchMock = jest.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: jest.fn().mockResolvedValue({
            id: `chatcmpl-${provider.id}`,
            model: model?.id,
            choices: [{ message: { content: `Hello from ${provider.name}` }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 3, completion_tokens: 4 },
          }),
        });
        global.fetch = fetchMock as any;

        const svc = makeServiceWithConfig(
          {
            getMergedCatalog: jest.fn().mockReturnValue({
              version: 1,
              generated_at: '2026-05-09',
              providers: BUILTIN_PROVIDER_CATALOG,
            }),
          },
          {
            id: provider.id,
            name: provider.name,
            protocol: 'chat_completions',
            base_url: provider.base_url,
            endpoint: provider.endpoints.chat_completions,
            api_key: 'sk-v24-test',
            models: provider.model_buckets?.models || [],
          },
        );

        const result = await svc.forward(
          makeCanonical(),
          provider.id,
          model?.id || 'test-model',
          routingMeta,
        );

        const [url, opts] = fetchMock.mock.calls[0];
        expect(url).toBe(`${provider.base_url}${provider.endpoints.chat_completions}`);
        expect(opts.headers.Authorization).toBe('Bearer sk-v24-test');
        expect(JSON.parse(opts.body)).toMatchObject({
          model: model?.id,
          stream: false,
        });
        expect(result.routing.node).toBe(provider.id);
        expect(result.content[0]).toEqual({ type: 'text', text: `Hello from ${provider.name}` });
      }
    });

    it('should forward embeddings to the embeddings endpoint', async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: jest.fn().mockResolvedValue({
          object: 'list',
          model: 'text-embedding-3-small',
          data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2] }],
          usage: { prompt_tokens: 12, total_tokens: 12 },
        }),
      });
      global.fetch = fetchMock as any;

      const svc = makeServiceWithNode({
        embedding_models: ['text-embedding-3-small'],
        embeddings_endpoint: '/v1/embeddings',
      });
      const result = await svc.forwardEmbeddings(
        {
          model: 'text-embedding-3-small',
          input: ['hello', 'world'],
          dimensions: 1536,
          metadata: { source_format: 'embeddings', raw_headers: {} },
        } as any,
        'openai',
        'text-embedding-3-small',
        routingMeta,
      );

      expect(result.data[0]).toEqual({ index: 0, embedding: [0.1, 0.2] });
      expect(result.usage.input_tokens).toBe(12);
      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.openai.com/v1/embeddings');
      expect(JSON.parse(opts.body)).toMatchObject({
        model: 'text-embedding-3-small',
        input: ['hello', 'world'],
        dimensions: 1536,
      });
    });

    it('should forward rerank requests to the rerank endpoint', async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: jest.fn().mockResolvedValue({
          id: 'rerank-1',
          object: 'rerank',
          model: 'rerank-english-v3',
          results: [{ index: 1, relevance_score: 0.92 }],
          usage: { prompt_tokens: 18, total_tokens: 18 },
        }),
      });
      global.fetch = fetchMock as any;

      const svc = makeServiceWithNode({
        rerank_models: ['rerank-english-v3'],
        rerank_endpoint: '/v1/rerank',
      });
      const result = await svc.forwardRerank(
        {
          model: 'rerank-english-v3',
          query: 'what is siftgate?',
          documents: ['gateway', 'migration'],
          top_n: 1,
          metadata: { source_format: 'rerank', raw_headers: {} },
        } as any,
        'openai',
        'rerank-english-v3',
        routingMeta,
      );

      expect(result.results[0]).toEqual({ index: 1, relevance_score: 0.92 });
      expect(result.usage.input_tokens).toBe(18);
      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.openai.com/v1/rerank');
      expect(JSON.parse(opts.body)).toMatchObject({
        model: 'rerank-english-v3',
        query: 'what is siftgate?',
        documents: ['gateway', 'migration'],
        top_n: 1,
      });
    });

    it('should forward image generation JSON to the configured media endpoint', async () => {
      const fetchMock = jest.fn().mockResolvedValue(new Response(JSON.stringify({
        created: 123,
        model: 'upstream-image-model',
        data: [{ url: 'https://example.test/image.png' }],
        usage: { prompt_tokens: 7, total_tokens: 7 },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
      global.fetch = fetchMock as any;

      const svc = makeServiceWithNode({
        image_models: ['gpt-image-1'],
        images_generations_endpoint: '/v1/images/generations',
      });
      const result = await svc.forwardMedia(
        makeMediaCanonical({ model: 'auto' }),
        'openai',
        'gpt-image-1',
        routingMeta,
      );

      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.openai.com/v1/images/generations');
      expect(JSON.parse(opts.body)).toMatchObject({
        model: 'gpt-image-1',
        prompt: 'Draw SiftGate',
      });
      expect(result.body).toMatchObject({
        data: [{ url: 'https://example.test/image.png' }],
      });
      expect(result.usage.input_tokens).toBe(7);
      expect(result.provider_response_type).toBe('application/json');
    });

    it('sends scoped media identity only when opted in and overrides conflicting static header casing', async () => {
      const fetchMock = jest.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({
        created: 123, data: [{ b64_json: 'ZmFrZQ==' }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
      global.fetch = fetchMock as any;
      const canonical = makeMediaCanonical();
      canonical.metadata.api_key_id = 'gateway-caller';
      canonical.metadata.raw_headers = { authorization: 'Bearer PRIVATE_GATEWAY_KEY', 'idempotency-key': 'client-operation' };
      const svc = makeServiceWithNode({ media_idempotency: true, headers: { 'idempotency-key': 'wrong-static-key' } });
      await svc.forwardMedia(canonical, 'openai', 'gpt-image-1', routingMeta);
      await svc.forwardMedia(canonical, 'openai', 'gpt-image-1', routingMeta);
      const first = fetchMock.mock.calls[0][1].headers;
      expect(first['Idempotency-Key']).toMatch(/^sg_media_[a-f0-9]{64}$/);
      expect(first['idempotency-key']).toBeUndefined();
      expect(first.Authorization).toBe('Bearer sk-test');
      expect(first['Idempotency-Key']).toBe(fetchMock.mock.calls[1][1].headers['Idempotency-Key']);
      expect(JSON.stringify(first)).not.toContain('PRIVATE_GATEWAY_KEY');
      const legacy = makeServiceWithNode();
      await legacy.forwardMedia(canonical, 'openai', 'gpt-image-1', routingMeta);
      expect(fetchMock.mock.calls[2][1].headers['Idempotency-Key']).toBeUndefined();
    });

    it('should forward image variations and audio translations to their configured endpoints', async () => {
      const fetchMock = jest.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({
        created: 123,
        data: [{ b64_json: 'ZmFrZQ==' }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      })));
      global.fetch = fetchMock as any;

      const svc = makeServiceWithNode({
        image_models: ['gpt-image-1'],
        audio_models: ['gpt-4o-mini-transcribe'],
        images_variations_endpoint: '/v1/images/variations',
        audio_translations_endpoint: '/v1/audio/translations',
      });

      await svc.forwardMedia(
        makeMediaCanonical({
          source_format: 'image_variation',
          media: {
            media_type: 'image',
            operation: 'variation',
            multipart: false,
            file_count: 0,
            byte_size: 48,
            requested_format: null,
            response_format: null,
          },
          metadata: {
            source_format: 'image_variation',
            original_model: 'gpt-image-1',
            raw_headers: {},
            media: {
              media_type: 'image',
              operation: 'variation',
              multipart: false,
              file_count: 0,
              byte_size: 48,
              requested_format: null,
              response_format: null,
            },
          },
        }),
        'openai',
        'gpt-image-1',
        routingMeta,
      );
      await svc.forwardMedia(
        makeMediaCanonical({
          model: 'gpt-4o-mini-transcribe',
          source_format: 'audio_translation',
          payload: { model: 'gpt-4o-mini-transcribe', response_format: 'json' },
          media: {
            media_type: 'audio',
            operation: 'translation',
            multipart: false,
            file_count: 0,
            byte_size: 58,
            requested_format: 'json',
            response_format: 'json',
          },
          metadata: {
            source_format: 'audio_translation',
            original_model: 'gpt-4o-mini-transcribe',
            raw_headers: {},
            media: {
              media_type: 'audio',
              operation: 'translation',
              multipart: false,
              file_count: 0,
              byte_size: 58,
              requested_format: 'json',
              response_format: 'json',
            },
          },
        }),
        'openai',
        'gpt-4o-mini-transcribe',
        routingMeta,
      );

      expect(fetchMock.mock.calls[0][0]).toBe('https://api.openai.com/v1/images/variations');
      expect(fetchMock.mock.calls[1][0]).toBe('https://api.openai.com/v1/audio/translations');
    });

    it('should return binary audio speech responses with content type', async () => {
      global.fetch = jest.fn().mockResolvedValue(new Response(Buffer.from('audio-bytes'), {
        status: 200,
        headers: { 'Content-Type': 'audio/mpeg' },
      })) as any;

      const svc = makeServiceWithNode({
        audio_models: ['tts-1'],
        audio_speech_endpoint: '/v1/audio/speech',
      });
      const result = await svc.forwardMedia(
        makeMediaCanonical({
          model: 'tts-1',
          source_format: 'audio_speech',
          payload: { model: 'tts-1', input: 'hello', voice: 'alloy' },
          media: {
            media_type: 'audio',
            operation: 'speech',
            multipart: false,
            file_count: 0,
            byte_size: 52,
            requested_format: null,
            response_format: null,
          },
          metadata: {
            source_format: 'audio_speech',
            original_model: 'tts-1',
            raw_headers: {},
            media: {
              media_type: 'audio',
              operation: 'speech',
              multipart: false,
              file_count: 0,
              byte_size: 52,
              requested_format: null,
              response_format: null,
            },
          },
        }),
        'openai',
        'tts-1',
        routingMeta,
      );

      expect(Buffer.isBuffer(result.body)).toBe(true);
      expect(result.content_type).toBe('audio/mpeg');
      expect(result.provider_response_type).toBe('audio/mpeg');
      expect((result.body as Buffer).toString()).toBe('audio-bytes');
    });

    it('should throw ProviderError for non-OK response', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 429,
        text: jest.fn().mockResolvedValue('Rate limited'),
      }) as any;

      const svc = makeServiceWithNode();
      await expect(svc.forward(makeCanonical(), 'openai', 'gpt-4o', routingMeta))
        .rejects.toThrow(ProviderError);
    });

    it('redacts sensitive provider error bodies before logging and throwing', async () => {
      const errorBody = JSON.stringify({
        error: {
          message: 'Authorization failed for Bearer sk-secret-provider-token',
          api_key: 'sk-secret-provider-token',
          access_token: 'access-token-secret',
        },
        url: 'https://provider.test/v1/chat?api_key=sk-query-secret-token',
      });
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 401,
        headers: { get: jest.fn() },
        text: jest.fn().mockResolvedValue(errorBody),
      }) as any;

      const svc = makeServiceWithNode();
      const warnSpy = jest.spyOn((svc as any).logger, 'warn').mockImplementation();

      try {
        let thrown: unknown;
        try {
          await svc.forward(makeCanonical(), 'openai', 'gpt-4o', routingMeta);
        } catch (err: unknown) {
          thrown = err;
        }

        expect(thrown).toBeInstanceOf(ProviderError);
        const message = (thrown as Error).message;
        const logged = warnSpy.mock.calls.flat().join('\n');
        expect(message).toContain('[REDACTED]');
        expect(logged).toContain('[REDACTED]');
        expect(`${message}\n${logged}`).not.toContain('sk-secret-provider-token');
        expect(`${message}\n${logged}`).not.toContain('access-token-secret');
        expect(`${message}\n${logged}`).not.toContain('sk-query-secret-token');
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('should throw ProviderError for network errors', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('fetch failed')) as any;

      const svc = makeServiceWithNode();
      await expect(svc.forward(makeCanonical(), 'openai', 'gpt-4o', routingMeta))
        .rejects.toThrow(ProviderError);
    });

    it('should pass a configured dispatcher to fetch', async () => {
      const dispatcher = { dispatch: jest.fn() };
      const pool = { getDispatcher: jest.fn().mockReturnValue(dispatcher) };
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: jest.fn().mockResolvedValue({
          id: 'chatcmpl-test', model: 'gpt-4o',
          choices: [{ message: { content: 'Hello!' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      });
      global.fetch = fetchMock as any;

      const svc = makeServiceWithPool({
        connection: { pool_size: 4, keep_alive_ms: 30000 },
      }, pool);
      await svc.forward(makeCanonical(), 'openai', 'gpt-4o', routingMeta);

      expect(pool.getDispatcher).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'openai' }),
      );
      expect(fetchMock.mock.calls[0][1].dispatcher).toBe(dispatcher);
    });

    it('should map undici headers/body timeouts to ProviderError timeouts', async () => {
      const timeout = new Error('headers timeout');
      (timeout as any).name = 'HeadersTimeoutError';
      (timeout as any).code = 'UND_ERR_HEADERS_TIMEOUT';
      global.fetch = jest.fn().mockRejectedValue(timeout) as any;

      const svc = makeServiceWithNode();
      await expect(svc.forward(makeCanonical(), 'openai', 'gpt-4o', routingMeta))
        .rejects.toMatchObject({
          statusCode: 504,
          failureType: 'timeout',
        });
    });

    it('should map body read timeouts to ProviderError timeouts', async () => {
      const timeout = new Error('body timeout');
      (timeout as any).name = 'BodyTimeoutError';
      (timeout as any).code = 'UND_ERR_BODY_TIMEOUT';
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: jest.fn().mockRejectedValue(timeout),
      }) as any;

      const svc = makeServiceWithNode();
      await expect(svc.forward(makeCanonical(), 'openai', 'gpt-4o', routingMeta))
        .rejects.toMatchObject({
          statusCode: 504,
          failureType: 'timeout',
        });
    });

    it('should throw for unknown node', async () => {
      const svc = new ProviderClientService({
        getNode: jest.fn().mockReturnValue(undefined),
      } as any, new TelemetryService());
      await expect(svc.forward(makeCanonical(), 'unknown', 'model', routingMeta))
        .rejects.toThrow('Node not found');
    });

    it('should use x-api-key auth for messages protocol', async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true, status: 200,
        json: jest.fn().mockResolvedValue({
          id: 'msg_1', model: 'claude-3-opus',
          content: [{ type: 'text', text: 'Hi' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      });
      global.fetch = fetchMock as any;

      const svc = makeServiceWithNode({
        protocol: 'messages',
        base_url: 'https://api.anthropic.com',
        endpoint: '/v1/messages',
        api_key: 'sk-ant-test',
      });
      const canonical = makeCanonical();
      canonical.metadata.source_format = 'messages';
      await svc.forward(canonical, 'openai', 'claude-3-opus', routingMeta);

      const [, opts] = fetchMock.mock.calls[0];
      expect(opts.headers['x-api-key']).toBe('sk-ant-test');
    });

    it('should use custom header auth for compatible providers', async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: jest.fn().mockResolvedValue({
          id: 'chatcmpl-test',
          model: 'custom-model',
          choices: [{ message: { content: 'Hello!' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      });
      global.fetch = fetchMock as any;

      const svc = makeServiceWithNode({
        auth_type: 'custom-header',
        auth_header_name: 'api-key',
        auth_header_prefix: 'Token',
        api_key: 'sk-custom-provider',
      });
      await svc.forward(makeCanonical(), 'openai', 'custom-model', routingMeta);

      const [, opts] = fetchMock.mock.calls[0];
      expect(opts.headers['api-key']).toBe('Token sk-custom-provider');
      expect(opts.headers.Authorization).toBeUndefined();
      expect(opts.headers['x-api-key']).toBeUndefined();
    });

    it('should send debug message body when GATEWAY_DEBUG_MESSAGES_BODY is set', async () => {
      process.env.GATEWAY_DEBUG_MESSAGES_BODY = '1';
      global.fetch = jest.fn().mockResolvedValue({
        ok: false, status: 400,
        text: jest.fn().mockResolvedValue('Bad request'),
      }) as any;

      const svc = makeServiceWithNode({ protocol: 'messages' });
      try {
        await svc.forward(makeCanonical(), 'openai', 'gpt-4o', routingMeta);
      } catch { /* expected */ }
      delete process.env.GATEWAY_DEBUG_MESSAGES_BODY;
    });
  });

  // ── ForwardStream (with mocked fetch returning ReadableStream) ──

  describe('forwardStream — with mocked fetch', () => {
    const originalFetch = global.fetch;
    afterEach(() => { global.fetch = originalFetch; });

    it('should stream events from provider', async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(
            'data: {"id":"chatcmpl-1","model":"gpt-4o","choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}\n\n' +
            'data: {"id":"chatcmpl-1","choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}\n\n' +
            'data: {"id":"chatcmpl-1","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n' +
            'data: [DONE]\n\n',
          ));
          controller.close();
        },
      });
      global.fetch = jest.fn().mockResolvedValue({
        ok: true, status: 200,
        body: stream,
      }) as any;

      const svc = makeServiceWithNode();
      const events = [];
      for await (const event of svc.forwardStream(makeCanonical({ stream: true }), 'openai', 'gpt-4o')) {
        events.push(event);
      }
      expect(events.length).toBeGreaterThanOrEqual(3);
      expect(events[0].type).toBe('start');
    });

    it('should abort the upstream fetch signal when a stream is canceled after headers', async () => {
      let fetchSignal: AbortSignal | undefined;
      const stream = new ReadableStream<Uint8Array>({
        start() {
          // Keep the body open until the downstream abort cancels the reader.
        },
      });
      global.fetch = jest.fn().mockImplementation((_url, opts: RequestInit) => {
        fetchSignal = opts.signal as AbortSignal;
        return Promise.resolve({
          ok: true,
          status: 200,
          body: stream,
        });
      }) as any;

      const telemetry = makeStreamTelemetryMock();
      const svc = makeServiceWithNode({}, telemetry as any);
      const abortController = new AbortController();
      const iterator = svc.forwardStream(
        makeCanonical({ stream: true }),
        'openai',
        'gpt-4o',
        { signal: abortController.signal },
      );
      const nextEvent = iterator.next();
      await new Promise((resolve) => setImmediate(resolve));

      expect(fetchSignal).toBeDefined();
      expect(fetchSignal?.aborted).toBe(false);
      abortController.abort();
      await expect(nextEvent).resolves.toMatchObject({ done: true });
      expect(fetchSignal?.aborted).toBe(true);
      expect(telemetry.recordStreamLifecycle).toHaveBeenCalledWith({
        event: 'abort',
        reason: 'client_aborted',
        phase: 'pre_first_chunk',
        node: 'openai',
        model: 'gpt-4o',
      });
    });

    it('should pass through native Responses SSE chunks with side parsed usage', async () => {
      const upstreamSse =
        'event: response.created\n' +
        'data: {"type":"response.created","response":{"id":"resp_1","model":"gpt-5.5","status":"in_progress"}}\n\n' +
        'event: response.output_item.added\n' +
        'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"edit_file","arguments":"","status":"in_progress"}}\n\n' +
        'event: response.function_call_arguments.delta\n' +
        'data: {"type":"response.function_call_arguments.delta","output_index":0,"item_id":"fc_1","call_id":"call_1","delta":"{\\"path\\":\\"a.ts\\"}"}\n\n' +
        'event: response.function_call_arguments.done\n' +
        'data: {"type":"response.function_call_arguments.done","output_index":0,"item_id":"fc_1","call_id":"call_1","arguments":"{\\"path\\":\\"a.ts\\"}"}\n\n' +
        'event: response.output_item.done\n' +
        'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"edit_file","arguments":"{\\"path\\":\\"a.ts\\"}","status":"completed"}}\n\n' +
        'event: response.completed\n' +
        'data: {"type":"response.completed","response":{"id":"resp_1","model":"gpt-5.5","status":"completed","usage":{"input_tokens":12,"output_tokens":7}}}\n\n';
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(upstreamSse));
          controller.close();
        },
      });
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        body: stream,
      });
      global.fetch = fetchMock as any;

      const svc = makeServiceWithNode({
        protocol: 'responses',
        endpoint: '/v1/responses',
      });
      const canonical = makeCanonical({
        stream: true,
        metadata: {
          source_format: 'responses',
          original_model: 'gpt-5.5',
          raw_headers: {},
          raw_body: {
            model: 'gpt-5.5',
            stream: true,
            input: 'Use a tool',
            parallel_tool_calls: true,
          },
        },
      });

      const events = [];
      for await (const event of svc.forwardStream(canonical, 'openai', 'gpt-5.5')) {
        events.push(event);
      }

      expect(events).toHaveLength(1);
      const rawEvent = events[0];
      expect(rawEvent).toMatchObject({ type: 'raw_sse', text: upstreamSse });
      expect(rawEvent.type).toBe('raw_sse');
      if (rawEvent.type !== 'raw_sse') throw new Error('expected raw_sse');
      expect(rawEvent.events).toContainEqual({
        type: 'tool_call_complete',
        id: 'call_1',
        tool_type: 'function_call',
      });
      expect(rawEvent.events?.some((event: any) => event.type === 'stop')).toBe(true);
      const [, opts] = fetchMock.mock.calls[0];
      expect(JSON.parse(opts.body as string)).toEqual({
        model: 'gpt-5.5',
        stream: true,
        input: 'Use a tool',
        parallel_tool_calls: true,
      });
    });

    it('should preserve split native Responses SSE chunks for direct HTTP requests', async () => {
      const chunkA =
        'event: response.output_text.delta\n' +
        'data: {"type":"response.output_text.delta","delta":"hel';
      const chunkB =
        'lo"}\n\n' +
        'event: response.completed\n' +
        'data: {"type":"response.completed","response":{"id":"resp_1","model":"gpt-5.5","status":"completed","usage":{"input_tokens":3,"output_tokens":1}}}\n\n';
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(chunkA));
          controller.enqueue(encoder.encode(chunkB));
          controller.close();
        },
      });
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        body: stream,
      });
      global.fetch = fetchMock as any;

      const svc = makeServiceWithNode({
        protocol: 'responses',
        endpoint: '/v1/responses',
      });
      const canonical = makeCanonical({
        stream: true,
        metadata: {
          source_format: 'responses',
          original_model: 'gpt-5.5',
          raw_headers: { 'content-type': 'application/json' },
          raw_body: {
            model: 'gpt-5.5',
            stream: true,
            input: 'Say hello',
          },
        },
      });

      const events = [];
      for await (const event of svc.forwardStream(canonical, 'openai', 'gpt-5.5')) {
        events.push(event);
      }

      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({ type: 'raw_sse', text: chunkA });
      expect(events[1]).toMatchObject({ type: 'raw_sse', text: chunkB });
      const second = events[1];
      expect(second.type).toBe('raw_sse');
      if (second.type !== 'raw_sse') throw new Error('expected raw_sse');
      expect(second.events?.some((event: any) => event.type === 'delta')).toBe(true);
      expect(second.events?.some((event: any) => event.type === 'stop')).toBe(true);
      const [, opts] = fetchMock.mock.calls[0];
      expect(JSON.parse(opts.body as string)).toEqual({
        model: 'gpt-5.5',
        stream: true,
        input: 'Say hello',
      });
    });

    it('should complete response credentials with failed stream status codes', async () => {
      const upstreamSse =
        'event: response.failed\n' +
        'data: {"type":"response.failed","response":{"status":"failed","error":{"message":"The system is currently experiencing high demand","code":"no_capacity","type":"too_many_requests","status_code":429}}}\n\n';
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(upstreamSse));
          controller.close();
        },
      });
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        body: stream,
      });
      const credentialPool = {
        attemptLimit: jest.fn().mockReturnValue(1),
        shouldRetry: jest.fn().mockReturnValue(false),
        select: jest.fn().mockResolvedValue({
          nodeId: 'openai',
          credential: {
            id: 'cred-a',
            api_key: 'sk-test',
            weight: 1,
            enabled: true,
          },
          strategy: 'least_in_flight',
          stickyBy: 'none',
          cooldownMs: 60_000,
          maxFailures: 3,
          retryOnStatus: [429, 500, 502, 503, 504],
        }),
        complete: jest.fn(),
        recordUsage: jest.fn(),
      };

      const svc = new ProviderClientService(
        {
          getNode: jest.fn().mockReturnValue({
            id: 'openai',
            name: 'OpenAI',
            base_url: 'https://api.openai.com',
          protocol: 'responses',
          endpoint: '/v1/responses',
            api_key: 'sk-test',
            models: ['gpt-5.5'],
            model_aliases: {},
            timeout_ms: 5000,
          }),
        } as any,
        new TelemetryService(),
        undefined,
        undefined,
        credentialPool as any,
      );
      const canonical = makeCanonical({
        stream: true,
        metadata: {
          source_format: 'responses',
          original_model: 'gpt-5.5',
          raw_headers: { 'content-type': 'application/json' },
          raw_body: {
            model: 'gpt-5.5',
            stream: true,
            input: 'Say hello',
          },
        },
      });

      const events = [];
      for await (const event of svc.forwardStream(canonical, 'openai', 'gpt-5.5')) {
        events.push(event);
      }

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'raw_sse',
        events: [
          {
            type: 'error',
            error: {
              code: 'no_capacity',
              status_code: 429,
              type: 'too_many_requests',
            },
          },
        ],
      });
      expect(credentialPool.complete).toHaveBeenCalledWith(
        expect.objectContaining({
          credential: expect.objectContaining({ id: 'cred-a' }),
        }),
        expect.objectContaining({
          statusCode: 429,
          failureType: 'rate_limited',
        }),
      );
    });

    it('should passthrough native Messages SSE chunks without reserializing', async () => {
      const upstreamSse =
        'event: message_start\n' +
        'data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-sonnet-4","content":[],"stop_reason":null,"usage":{"input_tokens":8,"output_tokens":1}}}\n\n' +
        'event: content_block_start\n' +
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
        'event: content_block_delta\n' +
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}\n\n' +
        'event: message_delta\n' +
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n' +
        'event: message_stop\n' +
        'data: {"type":"message_stop"}\n\n';
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(upstreamSse));
          controller.close();
        },
      });
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        body: stream,
      });
      global.fetch = fetchMock as any;

      const svc = makeServiceWithNode({
        protocol: 'messages',
        endpoint: '/v1/messages',
      });
      const canonical = makeCanonical({
        stream: true,
        metadata: {
          source_format: 'messages',
          original_model: 'claude-sonnet-4',
          raw_headers: {},
          raw_body: {
            model: 'claude-sonnet-4',
            stream: true,
            messages: [{ role: 'user', content: 'Hi' }],
            max_tokens: 100,
          },
        },
      });

      const events = [];
      for await (const event of svc.forwardStream(canonical, 'openai', 'claude-sonnet-4')) {
        events.push(event);
      }

      expect(events).toHaveLength(1);
      const rawEvent = events[0];
      expect(rawEvent).toMatchObject({ type: 'raw_sse', text: upstreamSse });
      expect(rawEvent.type).toBe('raw_sse');
      if (rawEvent.type !== 'raw_sse') throw new Error('expected raw_sse');
      expect(rawEvent.events?.some((event: any) => event.type === 'delta')).toBe(true);
      expect(rawEvent.events?.some((event: any) => event.type === 'stop')).toBe(true);
      const [, opts] = fetchMock.mock.calls[0];
      expect(JSON.parse(opts.body as string)).toEqual({
        model: 'claude-sonnet-4',
        stream: true,
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: 100,
      });
    });

    it('should send the upstream model for aliased streaming routes', async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        },
      });
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true, status: 200,
        body: stream,
      });
      global.fetch = fetchMock as any;

      const svc = makeServiceWithNode({
        models: ['claude-opus-4-7-ada'],
        upstream_model_aliases: {
          'claude-opus-4-7-ada': 'claude-opus-4-7',
        },
      });
      for await (const _event of svc.forwardStream(
        makeCanonical({ stream: true }),
        'openai',
        'claude-opus-4-7-ada',
      )) {
        // drain stream
      }

      const [, opts] = fetchMock.mock.calls[0];
      expect(JSON.parse(opts.body as string).model).toBe('claude-opus-4-7');
    });

    it('should stream through a configured dispatcher', async () => {
      const dispatcher = { dispatch: jest.fn() };
      const pool = { getDispatcher: jest.fn().mockReturnValue(dispatcher) };
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        },
      });
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true, status: 200, body: stream,
      });
      global.fetch = fetchMock as any;

      const svc = makeServiceWithPool({
        connection: { pool_size: 4, body_timeout_ms: 300000 },
      }, pool);
      const events = [];
      for await (const event of svc.forwardStream(makeCanonical({ stream: true }), 'openai', 'gpt-4o')) {
        events.push(event);
      }

      expect(pool.getDispatcher).toHaveBeenCalled();
      expect(fetchMock.mock.calls[0][1].dispatcher).toBe(dispatcher);
    });

    it('should throw for missing response body', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true, status: 200,
        body: null,
      }) as any;

      const svc = makeServiceWithNode();
      await expect(async () => {
        for await (const _ of svc.forwardStream(makeCanonical({ stream: true }), 'openai', 'gpt-4o')) {
          // should throw before yielding
        }
      }).rejects.toThrow('No response body');
    });

    it('should throw ProviderError when stream read fails before any chunk', async () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.error(new Error('Stream read failed Bearer sk-secret-provider-token'));
        },
      });
      global.fetch = jest.fn().mockResolvedValue({
        ok: true, status: 200,
        body: stream,
      }) as any;

      const svc = makeServiceWithNode();
      const events = [];
      let thrown: unknown;
      try {
        for await (const event of svc.forwardStream(makeCanonical({ stream: true }), 'openai', 'gpt-4o')) {
          events.push(event);
        }
      } catch (err) {
        thrown = err;
      }

      expect(events).toHaveLength(0);
      expect(thrown).toBeInstanceOf(ProviderError);
      expect(thrown).toMatchObject({
        statusCode: 502,
        failureType: 'http_error',
        nodeId: 'openai',
      });
      const message = thrown instanceof Error ? thrown.message : '';
      expect(message).toContain('[REDACTED]');
      expect(message).not.toContain('sk-secret-provider-token');
    });

    it('should emit error event on stream read failure after first chunk', async () => {
      const encoder = new TextEncoder();
      let readCount = 0;
      const stream = new ReadableStream({
        pull(controller) {
          readCount += 1;
          if (readCount === 1) {
            controller.enqueue(encoder.encode(
              'data: {"id":"chatcmpl-read-failure","model":"gpt-4o","choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
            ));
            return;
          }
          controller.error(new Error('Stream read failed Bearer sk-secret-provider-token'));
        },
      });
      global.fetch = jest.fn().mockResolvedValue({
        ok: true, status: 200,
        body: stream,
      }) as any;

      const svc = makeServiceWithNode();
      const events = [];
      for await (const event of svc.forwardStream(makeCanonical({ stream: true }), 'openai', 'gpt-4o')) {
        events.push(event);
      }
      expect(events.length).toBeGreaterThanOrEqual(2);
      const errorEvent = events.find(e => e.type === 'error');
      expect(errorEvent).toBeDefined();
      expect(errorEvent?.type === 'error' ? errorEvent.error.message : '').toContain('[REDACTED]');
      expect(errorEvent?.type === 'error' ? errorEvent.error.message : '').not.toContain('sk-secret-provider-token');
    });

    it('should emit timeout error when stream body stalls between chunks', async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(
            'data: {"id":"chatcmpl-stall","model":"gpt-4o","choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}\n\n',
          ));
        },
      });
      global.fetch = jest.fn().mockResolvedValue({
        ok: true, status: 200,
        body: stream,
      }) as any;

      const telemetry = makeStreamTelemetryMock();
      const svc = makeServiceWithNode({
        connection: { body_timeout_ms: 10 },
      }, telemetry as any);
      const events = [];
      for await (const event of svc.forwardStream(makeCanonical({ stream: true }), 'openai', 'gpt-4o')) {
        events.push(event);
      }

      const errorEvent = events.find(e => e.type === 'error');
      expect(errorEvent).toMatchObject({
        type: 'error',
        error: {
          code: 'timeout',
          status_code: 504,
        },
      });
      expect(telemetry.recordStreamLifecycle).toHaveBeenCalledWith({
        event: 'timeout',
        reason: 'idle_timeout',
        phase: 'transmission',
        node: 'openai',
        model: 'gpt-4o',
      });
    });

    it('should throw ProviderError when stream exceeds max duration before first chunk', async () => {
      const stream = new ReadableStream({
        start() {
          // Keep the stream open without producing data.
        },
      });
      global.fetch = jest.fn().mockResolvedValue({
        ok: true, status: 200,
        body: stream,
      }) as any;

      const telemetry = makeStreamTelemetryMock();
      const svc = makeServiceWithNode({
        connection: { body_timeout_ms: 0, stream_max_duration_ms: 10 },
      }, telemetry as any);
      const events = [];
      let thrown: unknown;
      try {
        for await (const event of svc.forwardStream(makeCanonical({ stream: true }), 'openai', 'gpt-4o')) {
          events.push(event);
        }
      } catch (err) {
        thrown = err;
      }

      expect(events).toHaveLength(0);
      expect(thrown).toBeInstanceOf(ProviderError);
      expect(thrown).toMatchObject({
        statusCode: 504,
        failureType: 'timeout',
        nodeId: 'openai',
      });
      expect(thrown instanceof Error ? thrown.message : '').toContain('exceeded max duration');
      expect(telemetry.recordStreamLifecycle).toHaveBeenCalledWith({
        event: 'timeout',
        reason: 'max_duration',
        phase: 'pre_first_chunk',
        node: 'openai',
        model: 'gpt-4o',
      });
    });

    it('should emit timeout error when stream exceeds max duration after first chunk', async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(
            'data: {"id":"chatcmpl-max-duration","model":"gpt-4o","choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}\n\n',
          ));
        },
      });
      global.fetch = jest.fn().mockResolvedValue({
        ok: true, status: 200,
        body: stream,
      }) as any;

      const telemetry = makeStreamTelemetryMock();
      const svc = makeServiceWithNode({
        connection: { body_timeout_ms: 0, stream_max_duration_ms: 10 },
      }, telemetry as any);
      const events = [];
      for await (const event of svc.forwardStream(makeCanonical({ stream: true }), 'openai', 'gpt-4o')) {
        events.push(event);
      }

      const errorEvent = events.find(e => e.type === 'error');
      expect(errorEvent).toMatchObject({
        type: 'error',
        error: {
          code: 'timeout',
          status_code: 504,
        },
      });
      expect(errorEvent?.type === 'error' ? errorEvent.error.message : '').toContain('exceeded max duration');
      expect(telemetry.recordStreamLifecycle).toHaveBeenCalledWith({
        event: 'timeout',
        reason: 'max_duration',
        phase: 'transmission',
        node: 'openai',
        model: 'gpt-4o',
      });
    });
  });
});

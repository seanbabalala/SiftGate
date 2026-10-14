import { ConfigService } from "../../src/config/config.service";
import type {
  CanonicalRequest,
  CanonicalResponse,
  CanonicalStreamEvent,
} from "../../src/canonical/canonical.types";
import { ChatCompletionsNormalizer } from "../../src/canonical/normalizers/chat-completions.normalizer";
import { ChatCompletionsDenormalizer } from "../../src/canonical/denormalizers/chat-completions.denormalizer";
import {
  hasGeminiNativeTools,
  mergeGeminiNativeTools,
  nativeChatMetadata,
} from "../../src/canonical/gemini-native-tools";
import { ChatCompletionsStreamParser } from "../../src/providers/stream/chat-completions.stream";
import {
  ChatCompletionsStreamSerializer,
  MessagesStreamSerializer,
  ResponsesStreamSerializer,
} from "../../src/providers/stream/stream-serializers";
import { ProviderClientService } from "../../src/providers/provider-client.service";
import { TelemetryService } from "../../src/telemetry/telemetry.service";
import { PromptCacheService } from "../../src/cache/prompt-cache.service";

const nativeTools = [
  { googleSearch: {} },
  { enterpriseWebSearch: {} },
  { urlContext: {} },
  { codeExecution: {} },
  { googleMaps: { enableWidget: "ENABLE_WIDGET" } },
  { GoogleSearchRetrieval: {} },
  { google_search: {} },
  { url_context: {} },
  { code_execution: {} },
  { google_maps: {} },
  { enterprise_web_search: {} },
  { googleSearchRetrieval: {} },
  { google_search_retrieval: {} },
];
const metadata = {
  vertex_ai_grounding_metadata: [
    {
      webSearchQueries: ["synthetic query"],
      groundingChunks: [
        { web: { uri: "https://example.com/", title: "Example" } },
      ],
    },
  ],
  vertex_ai_url_context_metadata: [
    {
      urlMetadata: [
        {
          retrievedUrl: "https://example.com/",
          urlRetrievalStatus: "URL_RETRIEVAL_STATUS_SUCCESS",
        },
      ],
    },
  ],
};
function request(tools: unknown[] = [{ googleSearch: {} }]): CanonicalRequest {
  return new ChatCompletionsNormalizer().normalize(
    {
      model: "gemini-test",
      messages: [{ role: "user", content: "Find a source" }],
      tools,
      max_tokens: 2048,
    },
    {},
  );
}

describe("Gemini native Chat Completions tools", () => {
  it.each(nativeTools)("preserves %j including nested options", (tool) => {
    const canonical = request([tool]);
    expect(hasGeminiNativeTools(canonical)).toBe(true);
    const tools = mergeGeminiNativeTools(canonical, undefined);
    expect(tools).toEqual([tool]);
    expect(tools[0]).not.toBe(tool);
    expect(canonical.tools).toBeUndefined();
  });

  it("merges functions in order without restoring functions removed by policy", () => {
    const canonical = request([
      { googleSearch: {} },
      {
        type: "function",
        function: { name: "keep", parameters: { type: "object" } },
      },
      { type: "function", function: { name: "removed", parameters: {} } },
      { urlContext: {} },
    ]);
    canonical.tools = canonical.tools?.filter((tool) => tool.name === "keep");
    const normalized = new ChatCompletionsDenormalizer().denormalize(
      canonical,
      "gemini-test",
    );
    expect(mergeGeminiNativeTools(canonical, normalized.tools)).toEqual([
      { googleSearch: {} },
      {
        type: "function",
        function: {
          name: "keep",
          description: "",
          parameters: { type: "object" },
        },
      },
      { urlContext: {} },
    ]);
  });

  it("does not infer native tools from ordinary function names or malformed bodies", () => {
    expect(
      hasGeminiNativeTools(
        request([{ type: "function", function: { name: "googleSearch" } }]),
      ),
    ).toBe(false);
    for (const body of [
      null,
      [],
      {},
      { tools: [null, [], 42, { unsupported: {} }] },
    ]) {
      const canonical = request([]);
      canonical.metadata.raw_body = body;
      expect(hasGeminiNativeTools(canonical)).toBe(false);
    }
  });

  it("whitelists and deep-clones response metadata without copying provider secrets", () => {
    const copied = nativeChatMetadata({
      ...metadata,
      api_key: "synthetic-not-returned",
      arbitrary: "not-returned",
    });
    expect(copied).toEqual(metadata);
    expect(copied?.vertex_ai_grounding_metadata).not.toBe(
      metadata.vertex_ai_grounding_metadata,
    );
    expect(nativeChatMetadata({ usage: {} })).toBeUndefined();
    const response = {
      id: "test",
      model: "gemini-test",
      content: [{ type: "text", text: "Answer" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 2, output_tokens: 3 },
      routing: {
        tier: "direct",
        node: "gemini",
        score: 0,
        latency_ms: 1,
        is_fallback: false,
      },
      native_chat_metadata: copied,
    } satisfies CanonicalResponse;
    const body = new ChatCompletionsDenormalizer().denormalizeResponse(
      response,
    );
    expect(body).toMatchObject(metadata);
    expect(body.api_key).toBeUndefined();
    expect(body.usage).toEqual({
      prompt_tokens: 2,
      completion_tokens: 3,
      total_tokens: 5,
    });
  });

  it.each(nativeTools)(
    "bypasses exact, streaming and semantic caches for %j",
    (tool) => {
      const cache = new PromptCacheService({
        cache: { enabled: true, stream_cache: { enabled: true } },
        semanticCache: { enabled: true },
      } as unknown as ConfigService);
      const canonical = request([tool]);
      expect(cache.shouldCache(canonical)).toBe(false);
      expect(cache.shouldCacheStream(canonical)).toBe(false);
      expect(cache.shouldSemanticCache(canonical)).toBe(false);
      expect(cache.shouldCache(request([]))).toBe(true);
    },
  );

  describe("stream metadata", () => {
    it.each([true, false])(
      "keeps late metadata ahead of the terminal event (DONE=%s)",
      (done) => {
        const parser = new ChatCompletionsStreamParser(undefined, true);
        const serializer = new ChatCompletionsStreamSerializer();
        const stream =
          [
            {
              id: "test",
              model: "gemini-test",
              choices: [{ delta: { content: "Answer" }, finish_reason: null }],
            },
            {
              id: "test",
              choices: [{ delta: {}, finish_reason: "stop" }],
              usage: { prompt_tokens: 7, completion_tokens: 4 },
            },
            { id: "test", model: "gemini-test", choices: [], ...metadata },
          ]
            .map((value) => `data:${JSON.stringify(value)}\r\n\r\n`)
            .join("") + (done ? "data: [DONE]\n\n" : "");
        const events: CanonicalStreamEvent[] = [];
        for (let offset = 0; offset < stream.length; offset += 11)
          events.push(...parser.parse(stream.slice(offset, offset + 11)));
        events.push(...parser.flush());
        expect(
          events.filter((event) => event.type === "chat_metadata"),
        ).toEqual([{ type: "chat_metadata", metadata }]);
        expect(events.filter((event) => event.type === "stop")).toEqual([
          {
            type: "stop",
            stop_reason: "end_turn",
            usage: {
              input_tokens: 7,
              output_tokens: 4,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
          },
        ]);
        const output = events
          .map((event) => serializer.serialize(event))
          .join("");
        expect(output.indexOf("vertex_ai_grounding_metadata")).toBeLessThan(
          output.indexOf("[DONE]"),
        );
        expect(output.match(/\[DONE\]/g)).toHaveLength(1);
        expect(output).toContain("URL_RETRIEVAL_STATUS_SUCCESS");
        expect(
          new ResponsesStreamSerializer().serialize({
            type: "chat_metadata",
            metadata,
          }),
        ).toBe("");
        expect(
          new MessagesStreamSerializer().serialize({
            type: "chat_metadata",
            metadata,
          }),
        ).toBe("");
      },
    );
  });

  it.each(["responses", "messages"])(
    "rejects cross-protocol %s targets before network I/O",
    async (protocol) => {
      const service = new ProviderClientService(
        {
          getNode: () => ({ id: "other", protocol }),
        } as unknown as ConfigService,
        new TelemetryService(),
      );
      await expect(
        service.forward(request(), "other", "other", {
          tier: "direct",
          score: 0,
          is_fallback: false,
        }),
      ).rejects.toMatchObject({ statusCode: 400 });
      const stream = service.forwardStream(request(), "other", "other");
      await expect(stream.next()).rejects.toMatchObject({ statusCode: 400 });
    },
  );
});

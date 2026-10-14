import { createE2EHarness, E2EHarness, API_KEY } from "./setup";
import { ConfigService } from "../../src/config/config.service";
import { PromptCacheService } from "../../src/cache/prompt-cache.service";

const tools = [
  { googleSearch: {} },
  { enterpriseWebSearch: {} },
  { urlContext: {} },
  { codeExecution: {} },
  { googleMaps: { enableWidget: "ENABLE_WIDGET" } },
];
const models = ["gemini-test-flash", "gemini-test-argon"];
const metadata = {
  vertex_ai_grounding_metadata: [
    {
      webSearchQueries: ["example"],
      groundingSupports: [{ groundingChunkIndices: [0] }],
      groundingChunks: [
        { web: { uri: "https://example.com/", title: "Example" } },
      ],
    },
  ],
  vertex_ai_url_context_metadata: [
    { urlMetadata: [{ urlRetrievalStatus: "URL_RETRIEVAL_STATUS_SUCCESS" }] },
  ],
};

describe("Gemini native tools over HTTP", () => {
  let h: E2EHarness;
  beforeAll(async () => {
    h = await createE2EHarness();
    h.app
      .get(ConfigService)
      .getNode("mock-openai")!
      .models.push(...models);
  }, 30_000);
  afterAll(async () => {
    await h?.close();
  });
  beforeEach(() => {
    h.fetchMock.reset();
    h.app.get(PromptCacheService).clear();
  });

  it.each(
    models.flatMap((model) => tools.map((tool) => [model, tool] as const)),
  )("preserves %s tool %j and metadata", async (model, tool) => {
    h.fetchMock.setHandler(
      async () =>
        new Response(
          JSON.stringify({
            id: "test",
            model,
            choices: [
              {
                message: { role: "assistant", content: "Grounded answer" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 3, completion_tokens: 2 },
            ...metadata,
            private_provider_field: "never-return",
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
    );
    const response = await h.agent
      .post("/v1/chat/completions")
      .set("Authorization", `Bearer ${API_KEY}`)
      .send({
        model,
        messages: [{ role: "user", content: "Find a source" }],
        tools: [tool],
        max_tokens: 2048,
      });
    expect(response.status).toBe(200);
    expect(h.fetchMock.calls.at(-1)?.body.tools).toEqual([tool]);
    expect(h.fetchMock.calls.at(-1)?.body.max_tokens).toBe(2048);
    expect(response.body).toMatchObject(metadata);
    expect(response.body.private_provider_field).toBeUndefined();
  });

  it.each(models)(
    "preserves late SSE metadata and usage for %s",
    async (model) => {
      h.fetchMock.setHandler(async () => {
        const wire =
          [
            {
              id: "test",
              model,
              choices: [
                { delta: { content: "Grounded answer" }, finish_reason: null },
              ],
            },
            {
              id: "test",
              model,
              choices: [{ delta: {}, finish_reason: "stop" }],
              usage: { prompt_tokens: 8, completion_tokens: 4 },
            },
            { id: "test", model, choices: [], ...metadata },
          ]
            .map((value) => `data: ${JSON.stringify(value)}\n\n`)
            .join("") + "data: [DONE]\n\n";
        return new Response(
          new ReadableStream({
            start(controller) {
              const encoded = new TextEncoder().encode(wire);
              for (let i = 0; i < encoded.length; i += 13)
                controller.enqueue(encoded.slice(i, i + 13));
              controller.close();
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      });
      const response = await h.agent
        .post("/v1/chat/completions")
        .set("Authorization", `Bearer ${API_KEY}`)
        .send({
          model,
          messages: [{ role: "user", content: "Find a source" }],
          tools: [{ googleSearch: {} }],
          stream: true,
        })
        .buffer(true);
      expect(response.status).toBe(200);
      expect(h.fetchMock.calls.at(-1)?.body.tools).toEqual([
        { googleSearch: {} },
      ]);
      expect(response.text).toContain("vertex_ai_grounding_metadata");
      expect(response.text).toContain("URL_RETRIEVAL_STATUS_SUCCESS");
      expect(response.text).toContain('"prompt_tokens":8');
      expect(response.text).toContain('"completion_tokens":4');
      expect(
        response.text.indexOf("vertex_ai_grounding_metadata"),
      ).toBeLessThan(response.text.indexOf("[DONE]"));
      expect(response.text.match(/\[DONE\]/g)).toHaveLength(1);
    },
  );

  it("preserves the upstream rejection of a deprecated tool", async () => {
    h.fetchMock.setError(
      400,
      "google_search_retrieval is not supported; use google_search",
    );
    const response = await h.agent
      .post("/v1/chat/completions")
      .set("Authorization", `Bearer ${API_KEY}`)
      .send({
        model: models[0],
        messages: [{ role: "user", content: "Search" }],
        tools: [{ GoogleSearchRetrieval: {} }],
      });
    expect(response.status).toBe(400);
    expect(h.fetchMock.calls[0].body.tools).toEqual([
      { GoogleSearchRetrieval: {} },
    ]);
    expect(JSON.stringify(response.body)).toContain("google_search_retrieval");
  });

  it("does not fabricate metadata when the upstream omits it from SSE", async () => {
    h.fetchMock.setStreamingChatResponse(["Answer without provider metadata"]);
    const response = await h.agent
      .post("/v1/chat/completions")
      .set("Authorization", `Bearer ${API_KEY}`)
      .send({
        model: models[0],
        messages: [{ role: "user", content: "Find a source" }],
        tools: [{ googleSearch: {} }],
        stream: true,
      })
      .buffer(true);
    expect(response.status).toBe(200);
    expect(h.fetchMock.calls.at(-1)?.body.tools).toEqual([
      { googleSearch: {} },
    ]);
    expect(response.text).not.toContain("vertex_ai_grounding_metadata");
    expect(response.text).not.toContain("vertex_ai_url_context_metadata");
    expect(response.text).toContain('"prompt_tokens":10');
    expect(response.text.match(/\[DONE\]/g)).toHaveLength(1);
  });

  it("does not serve a cached plain answer for a native-tool request", async () => {
    const body = {
      model: models[0],
      messages: [{ role: "user", content: "Same prompt" }],
      temperature: 0,
    };
    await h.agent
      .post("/v1/chat/completions")
      .set("Authorization", `Bearer ${API_KEY}`)
      .send(body);
    const previous = h.fetchMock.calls.length;
    for (let i = 0; i < 2; i++) {
      const response = await h.agent
        .post("/v1/chat/completions")
        .set("Authorization", `Bearer ${API_KEY}`)
        .send({ ...body, tools: [{ googleSearch: {} }] });
      expect(response.status).toBe(200);
    }
    expect(h.fetchMock.calls).toHaveLength(previous + 2);
  });
});

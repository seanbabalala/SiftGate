import { ChatCompletionsStreamParser } from "../../src/providers/stream/chat-completions.stream";
import { ResponsesStreamParser } from "../../src/providers/stream/responses.stream";
import { MessagesStreamParser } from "../../src/providers/stream/messages.stream";
import { GeminiStreamParser } from "../../src/providers/stream/gemini.stream";
import { getUsageEvidence } from "../../src/canonical/usage-evidence";
import { getCompatibilityProfile } from "../../src/catalog/compatibility-profiles";

const frame = (body: unknown, event?: string) =>
  `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(body)}\n\n`;

describe("private stream usage evidence", () => {
  it("retains exact chat modality usage through fragmented and duplicate cumulative SSE reports", () => {
    const parser = new ChatCompletionsStreamParser();
    const usage = { prompt_tokens: 10, completion_tokens: 25, prompt_tokens_details: { text_tokens: 8, audio_tokens: 2, image_tokens: 0, cached_tokens: 0, cache_write_tokens: 0 }, completion_tokens_details: { text_tokens: 5, audio_tokens: 20 } };
    const raw = frame({ choices: [], usage: { ...usage, completion_tokens: 2, completion_tokens_details: { text_tokens: 1, audio_tokens: 1 } } }) + frame({ choices: [], usage }) + frame({ choices: [], usage }) + "data: [DONE]\n\n";
    const events = [];
    for (let offset = 0; offset < raw.length; offset += 7) events.push(...parser.parse(raw.slice(offset, offset + 7)));
    const evidence = getUsageEvidence(parser.getPricingUsage()!)!.usage;
    expect(events.filter(event => event.type === "stop")).toHaveLength(1);
    expect(evidence.quantities.audio_output_tokens?.value).toBe("20");
    expect(evidence.quantities.uncached_audio_input_tokens?.value).toBe("2");
    expect(evidence.diagnostics).toEqual([]);
  });

  it("keeps the final cumulative chat report after the stop frame without summing duplicates", () => {
    const parser = new ChatCompletionsStreamParser();
    const events = [
      ...parser.parse(
        frame({
          choices: [],
          usage: { prompt_tokens: 100, completion_tokens: 2 },
        }) +
          frame({
            choices: [],
            usage: { prompt_tokens: 100, completion_tokens: 5 },
          }) +
          frame({
            choices: [],
            usage: { prompt_tokens: 100, completion_tokens: 5 },
          }) +
          "data: [DONE]\n\n",
      ),
    ];
    expect(events.filter((event) => event.type === "stop")).toHaveLength(1);
    const usage = getUsageEvidence(parser.getPricingUsage()!)!.usage;
    expect(usage.quantities.total_input_tokens?.value).toBe("100");
    expect(usage.quantities.output_tokens?.value).toBe("5");
  });

  it("does not price a missing chat or Responses usage report as observed zero", () => {
    for (const parser of [
      new ChatCompletionsStreamParser(),
      new ResponsesStreamParser(),
    ]) {
      const events = [...parser.parse("data: [DONE]\n\n")];
      const stop = events.find((event) => event.type === "stop");
      expect(stop?.type).toBe("stop");
      if (stop?.type === "stop")
        expect(
          getUsageEvidence(stop.usage)!.usage.quantities.total_input_tokens
            ?.value,
        ).toBeNull();
    }
  });

  it("preserves Responses service-tier and cache-inclusive usage evidence", () => {
    const parser = new ResponsesStreamParser();
    [
      ...parser.parse(
        frame(
          {
            response: {
              status: "completed",
              service_tier: "default",
              usage: {
                input_tokens: 100,
                output_tokens: 5,
                input_tokens_details: { cached_tokens: 90 },
              },
            },
          },
          "response.completed",
        ),
      ),
    ];
    const evidence = getUsageEvidence(parser.getPricingUsage()!)!;
    expect(evidence.resolvedServiceTier).toBe("default");
    expect(evidence.usage.quantities.uncached_input_tokens?.value).toBe("10");
  });

  it.each(
    [1, 7, 64, 4096].flatMap((chunkSize) =>
      [false, true].map((wrapped) => ({ chunkSize, wrapped })),
    ),
  )("retains exact failed Responses usage (chunk=$chunkSize, wrapped=$wrapped) without a success stop", ({ chunkSize, wrapped }) => {
    const parser = new ResponsesStreamParser();
    const response = {
      status: "failed",
      service_tier: "default",
      error: { code: "server_error", message: "Synthetic failure" },
      usage: {
        input_tokens: "9007199254740993",
        output_tokens: 25,
        input_tokens_details: { cached_tokens: 40, cache_write_tokens: 0 },
      },
    };
    const failed = frame(wrapped ? { response } : response, "response.failed");
    const raw = failed + failed + "data: [DONE]\n\n";
    const events = [];
    for (let offset = 0; offset < raw.length; offset += chunkSize)
      events.push(...parser.parse(raw.slice(offset, offset + chunkSize)));
    expect(events.map((event) => event.type)).toEqual(["error", "error"]);
    const usage = parser.getPricingUsage();
    expect(usage).toBeDefined();
    const evidence = getUsageEvidence(usage!)!;
    expect(evidence.resolvedServiceTier).toBe("default");
    expect(evidence.usage.quantities.total_input_tokens).toMatchObject({
      value: "9007199254740993", quality: "observed", source: "provider_usage",
    });
    expect(evidence.usage.quantities.uncached_input_tokens?.value).toBe("9007199254740953");
    expect(evidence.usage.quantities.output_tokens?.value).toBe("25");
    expect(evidence.usage.diagnostics).toEqual([]);
    expect(JSON.stringify(events)).not.toContain("adapter_id");
    expect(JSON.stringify(events)).not.toContain("pricingUsage");
  });

  it.each([
    { name: "absent", counters: undefined, expected: null },
    { name: "malformed", counters: { input_tokens: -1, output_tokens: "invalid" }, expected: null },
    { name: "observed zero", counters: { input_tokens: 0, output_tokens: 0, input_tokens_details: { cached_tokens: 0 } }, expected: "0" },
  ])("keeps $name failed Responses usage distinct from a guessed zero", ({ counters, expected }) => {
    const parser = new ResponsesStreamParser();
    const events = [...parser.parse(frame({ response: { status: "failed", usage: counters } }, "response.failed"))];
    expect(events.map((event) => event.type)).toEqual(["error"]);
    expect(parser.getPricingUsage()).toBeDefined();
    const evidence = getUsageEvidence(parser.getPricingUsage()!)!.usage;
    expect(evidence.quantities.total_input_tokens?.value).toBe(expected);
    expect(evidence.quantities.output_tokens?.value).toBe(expected);
    if (expected === "0") expect(evidence.quantities.total_input_tokens?.quality).toBe("observed");
    else expect(evidence.quantities.total_input_tokens?.quality).not.toBe("observed");
  });

  it("replaces earlier cumulative Responses usage with final failed usage rather than adding both reports", () => {
    const parser = new ResponsesStreamParser();
    const events = [...parser.parse(
      frame({ response: { usage: { input_tokens: 100, output_tokens: 2 } } }, "response.incomplete") +
      frame({ response: { usage: { input_tokens: 100, output_tokens: 5 } } }, "response.failed"),
    )];
    expect(events.map((event) => event.type)).toEqual(["stop", "error"]);
    const usage = getUsageEvidence(parser.getPricingUsage()!)!.usage;
    expect(usage.quantities.total_input_tokens?.value).toBe("100");
    expect(usage.quantities.output_tokens?.value).toBe("5");
  });

  it("merges Messages start counters with cumulative delta output and retains both TTLs", () => {
    const schema = getCompatibilityProfile("anthropic_messages_compatible")!
      .usage_schema!.messages;
    const parser = new MessagesStreamParser(schema);
    [
      ...parser.parse(
        frame(
          {
            message: {
              id: "message",
              usage: {
                input_tokens: 30,
                output_tokens: 0,
                cache_read_input_tokens: 40,
                cache_creation_input_tokens: 30,
                cache_creation: {
                  ephemeral_5m_input_tokens: 20,
                  ephemeral_1h_input_tokens: 10,
                },
              },
            },
          },
          "message_start",
        ) +
          frame({ delta: {}, usage: { output_tokens: 2 } }, "message_delta") +
          frame(
            { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
            "message_delta",
          ),
      ),
    ];
    const usage = getUsageEvidence(parser.getPricingUsage()!)!.usage;
    expect(usage.quantities.total_input_tokens?.value).toBe("100");
    expect(usage.quantities.output_tokens?.value).toBe("5");
    expect(usage.quantities.cache_write_5m_tokens?.value).toBe("20");
    expect(usage.quantities.cache_write_1h_tokens?.value).toBe("10");
    expect(usage.diagnostics).toEqual([]);
  });

  it("retains the last Gemini usage report after the first terminal frame", () => {
    const parser = new GeminiStreamParser();
    [
      ...parser.parse(
        frame({
          candidates: [{ finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 2 },
        }) +
          frame({
            usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 5 },
          }),
      ),
    ];
    const usage = getUsageEvidence(parser.getPricingUsage()!)!.usage;
    expect(usage.quantities.total_input_tokens?.value).toBe("100");
    expect(usage.quantities.output_tokens?.value).toBe("5");
  });
});

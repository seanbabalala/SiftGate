import {
  normalizeGeminiPricingUsage,
  geminiCompatibilityUsage,
} from "../../src/providers/gemini-pricing-usage";
import { attachTokenPricingEvidence } from "../../src/providers/pricing-usage-evidence";
import { getUsageEvidence } from "../../src/canonical/usage-evidence";
import { getCompatibilityProfile } from "../../src/catalog/compatibility-profiles";
import { GeminiStreamParser } from "../../src/providers/stream/gemini.stream";
import { providerFailureUsage } from "../../src/providers/provider-failure-evidence";
import { book, quote, rate } from "./pricing-fixtures";

const parts = (text: unknown, audio: unknown, image: unknown) => [
  { modality: "TEXT", tokenCount: text },
  { modality: "AUDIO", tokenCount: audio },
  { modality: "IMAGE", tokenCount: image },
];
const fixture = () => ({
  promptTokenCount: 100,
  candidatesTokenCount: 30,
  thoughtsTokenCount: 0,
  totalTokenCount: 130,
  cachedContentTokenCount: 40,
  promptTokensDetails: parts(60, 30, 10),
  cacheTokensDetails: parts(30, 10, 0),
  candidatesTokensDetails: parts(10, 15, 5),
});
const normalize = (value: Record<string, unknown>) => {
  const canonical = { input_tokens: 0, output_tokens: 0 };
  attachTokenPricingEvidence(
    { usageMetadata: value },
    canonical,
    getCompatibilityProfile("google_gemini_compatible")!.usage_schema!
      .gemini_generate_content,
  );
  expect(canonical).toEqual({ input_tokens: 0, output_tokens: 0 });
  return getUsageEvidence(canonical)!.usage;
};

describe("native Gemini exact metering", () => {
  it.each(["chat_completions", "responses", "messages"])(
    "retains reported failed-attempt fees for the real %s operation name",
    (operation) => {
      const failure = providerFailureUsage(
        JSON.stringify({
          error: { message: "Synthetic rejected result" },
          usageMetadata: fixture(),
        }),
        getCompatibilityProfile("google_gemini_compatible")!.usage_schema!
          .gemini_generate_content,
        operation,
      );
      expect(getUsageEvidence(failure!)!.usage).toEqual(normalize(fixture()));
    },
  );
  it("diagnoses derived-count overflow or negative remainders without throwing into a valid model response", () => {
    const max = "9".repeat(30);
    for (const raw of [
      {
        promptTokenCount: 0,
        candidatesTokenCount: max,
        thoughtsTokenCount: max,
      },
      {
        totalTokenCount: 0,
        candidatesTokenCount: max,
        thoughtsTokenCount: max,
      },
      { totalTokenCount: 0, promptTokenCount: max },
      { totalTokenCount: 0, promptTokenCount: max, candidatesTokenCount: max },
    ]) {
      const usage = normalize(raw);
      expect(usage.diagnostics.length).toBeGreaterThan(0);
      expect(usage.quantities.output_tokens?.value).toBeNull();
      expect(() => geminiCompatibilityUsage(raw)).not.toThrow();
    }
  });
  it("subtracts cached modality counts and bills each output modality without aggregate duplication", () => {
    const usage = normalize(fixture());
    expect(usage.adapter_id).toBe("gemini-generate-content");
    expect(usage.quantities.total_input_tokens?.value).toBe("100");
    expect(usage.quantities.uncached_input_tokens?.value).toBe("60");
    expect(usage.quantities.uncached_text_input_tokens).toMatchObject({
      value: "30",
      source: "provider_usage",
      quality: "observed",
    });
    expect(usage.quantities.uncached_audio_input_tokens?.value).toBe("20");
    expect(usage.quantities.uncached_image_input_tokens?.value).toBe("10");
    expect(usage.quantities.image_output_tokens?.value).toBe("5");
    expect(usage.quantities.reasoning_output_tokens?.value).toBe("0");
    expect(usage.diagnostics).toEqual([]);
    const result = quote(
      book([
        rate("in", "uncached_audio_input_tokens", "2", "1"),
        rate("out", "image_output_tokens", "3", "1"),
      ]),
      usage,
    );
    expect(result.status).toBe("priced");
    expect(result.amount).toBe("55.000000000");
  });

  it("includes thoughts once in aggregate output without inventing their modality", () => {
    const usage = normalize({
      ...fixture(),
      thoughtsTokenCount: 50,
      totalTokenCount: 180,
    });
    expect(usage.quantities.output_tokens).toMatchObject({
      value: "80",
      quality: "observed",
    });
    expect(
      geminiCompatibilityUsage({
        ...fixture(),
        thoughtsTokenCount: 50,
        totalTokenCount: 180,
      }),
    ).toMatchObject({
      output_tokens: 80,
      input_tokens: 100,
      cache_read_input_tokens: 40,
    });
    expect(usage.quantities.reasoning_output_tokens).toMatchObject({
      value: "50",
      subset_of: "output_tokens",
    });
    expect(usage.quantities.text_output_tokens).toMatchObject({
      value: null,
      quality: "missing",
    });
    expect(usage.quantities.audio_output_tokens?.value).toBe("15");
    expect(usage.diagnostics).toEqual([]);
    expect(
      quote(book([rate("output", "output_tokens", "1", "1")]), usage).amount,
    ).toBe("80.000000000");
    expect(
      quote(book([rate("text", "text_output_tokens", "1", "1")]), usage).amount,
    ).toBeNull();
  });

  it("reconstructs only genuinely missing totals using prompt + candidates + thoughts", () => {
    for (const key of [
      "promptTokenCount",
      "candidatesTokenCount",
      "thoughtsTokenCount",
    ] as const) {
      const raw: Record<string, unknown> = {
        ...fixture(),
        thoughtsTokenCount: 50,
        totalTokenCount: 180,
      };
      delete raw[key];
      const usage = normalize(raw);
      expect(usage.quantities.total_input_tokens?.value).toBe("100");
      expect(usage.quantities.output_tokens?.value).toBe("80");
      expect(usage.quantities.reasoning_output_tokens?.value).toBe("50");
      expect(usage.diagnostics).toEqual([]);
    }
    const unknown = normalize({
      candidatesTokenCount: 30,
      totalTokenCount: 180,
    });
    expect(unknown.quantities.total_input_tokens?.value).toBeNull();
    expect(unknown.quantities.output_tokens?.value).toBeNull();
  });

  it("keeps a missing thoughts/total pair estimated, not observed zero thoughts", () => {
    const usage = normalize({
      promptTokenCount: 100,
      candidatesTokenCount: 30,
      cachedContentTokenCount: 0,
      candidatesTokensDetails: parts(10, 15, 5),
    });
    expect(usage.quantities.output_tokens).toMatchObject({
      value: "30",
      quality: "estimated",
      source: "heuristic",
    });
    expect(usage.quantities.reasoning_output_tokens?.value).toBeNull();
    expect(usage.quantities.text_output_tokens?.value).toBeNull();
    expect(
      quote(book([rate("output", "output_tokens", "1", "1")]), usage).status,
    ).toBe("estimated");
  });

  it("preserves large exact string counters and zero-output receipts", () => {
    const usage = normalize({
      promptTokenCount: "9007199254740993",
      candidatesTokenCount: "2",
      thoughtsTokenCount: "3",
      totalTokenCount: "9007199254740998",
      cachedContentTokenCount: "0",
      promptTokensDetails: [
        { modality: "TEXT", tokenCount: "9007199254740993" },
      ],
    });
    expect(usage.quantities.uncached_text_input_tokens?.value).toBe(
      "9007199254740993",
    );
    expect(usage.quantities.output_tokens?.value).toBe("5");
    expect(usage.diagnostics).toEqual([]);
    const zero = normalize({
      promptTokenCount: 0,
      candidatesTokenCount: 0,
      thoughtsTokenCount: 0,
      totalTokenCount: 0,
      cachedContentTokenCount: 0,
      candidatesTokensDetails: parts(0, 0, 0),
    });
    expect(zero.quantities.text_output_tokens).toMatchObject({
      value: "0",
      quality: "observed",
    });
    expect(zero.diagnostics).toEqual([]);
  });

  it.each([
    null,
    -1,
    "NaN",
    "1e3",
    "1.5",
    false,
    {},
    Number.MAX_SAFE_INTEGER + 1,
  ])(
    "does not overwrite invalid thoughts %p with a cheaper inferred value",
    (value) => {
      const usage = normalize({ ...fixture(), thoughtsTokenCount: value });
      expect(usage.quantities.output_tokens?.value).toBeNull();
      expect(
        usage.diagnostics.some((d) => d.code === "pricing_invalid_quantity"),
      ).toBe(true);
    },
  );

  it.each([129, 131, 99])(
    "rejects inconsistent aggregate %s",
    (totalTokenCount) => {
      const usage = normalize({ ...fixture(), totalTokenCount });
      expect(usage.quantities.output_tokens?.value).toBeNull();
      expect(usage.quantities.total_input_tokens?.value).toBeNull();
      expect(
        usage.diagnostics.some((d) => d.code === "pricing_usage_conflict"),
      ).toBe(true);
    },
  );

  it("validates candidate subsets against candidates, not a larger thought-inclusive output", () => {
    const usage = normalize({
      ...fixture(),
      thoughtsTokenCount: 50,
      totalTokenCount: 180,
      candidatesTokensDetails: [{ modality: "AUDIO", tokenCount: 40 }],
    });
    expect(usage.quantities.output_tokens?.value).toBe("80");
    expect(usage.quantities.audio_output_tokens?.value).toBeNull();
    expect(
      usage.diagnostics.some(
        (d) => d.path === "usageMetadata.candidatesTokensDetails",
      ),
    ).toBe(true);
  });

  it("uses complete cache allocation to establish omitted zero subsets, but not missing aggregates", () => {
    const usage = normalize({
      ...fixture(),
      cacheTokensDetails: [{ modality: "TEXT", tokenCount: 40 }],
    });
    expect(usage.quantities.uncached_audio_input_tokens?.value).toBe("30");
    expect(usage.quantities.uncached_text_input_tokens?.value).toBe("20");
    const partial = normalize({
      ...fixture(),
      cacheTokensDetails: [{ modality: "TEXT", tokenCount: 30 }],
    });
    expect(partial.quantities.uncached_text_input_tokens?.value).toBe("30");
    expect(partial.quantities.uncached_audio_input_tokens?.value).toBeNull();
    const raw: Record<string, unknown> = fixture();
    delete raw.cachedContentTokenCount;
    const missing = normalize(raw);
    expect(missing.quantities.uncached_text_input_tokens?.value).toBeNull();
    expect(missing.quantities.cache_read_tokens?.value).toBeNull();
    expect(missing.diagnostics).toEqual([]);
  });

  it.each([
    parts(41, 0, 0),
    parts(0, 40, 0),
    [
      { modality: "TEXT", tokenCount: 20 },
      { modality: "TEXT", tokenCount: 20 },
    ],
    [{ modality: "TEXT", tokenCount: -1 }],
    [{ modality: "TEXT" }],
    { TEXT: 40 },
    Array(33).fill({ modality: "TEXT", tokenCount: 0 }),
  ])(
    "rejects invalid, excessive, duplicate or wrongly allocated cache details %p",
    (cacheTokensDetails) => {
      const usage = normalize({ ...fixture(), cacheTokensDetails });
      expect(usage.quantities.uncached_text_input_tokens?.value).toBeNull();
      expect(usage.diagnostics.length).toBeGreaterThan(0);
    },
  );

  it("does not map native VIDEO/DOCUMENT token quantities to image or audio tokens", () => {
    const usage = normalize({
      ...fixture(),
      promptTokensDetails: [
        { modality: "TEXT", tokenCount: 10 },
        { modality: "VIDEO", tokenCount: 90 },
      ],
    });
    expect(usage.quantities.total_input_tokens?.value).toBe("100");
    expect(usage.quantities.uncached_text_input_tokens?.quality).toBe(
      "unsupported",
    );
    expect(usage.quantities.uncached_image_input_tokens).toBeUndefined();
    expect(usage.diagnostics).toEqual([]);
  });

  it("does not read inherited counters or override custom token schemas", () => {
    expect(
      normalizeGeminiPricingUsage(Object.create({ promptTokenCount: 99 }))
        .quantities.total_input_tokens?.value,
    ).toBeNull();
    const usage = { input_tokens: 0, output_tokens: 0 };
    attachTokenPricingEvidence(
      {
        custom: { input: 4, output: 2 },
        usageMetadata: { ...fixture(), cachedContentTokenCount: 0 },
      },
      usage,
      { input_tokens: "custom.input", output_tokens: "custom.output" },
    );
    expect(
      getUsageEvidence(usage)!.usage.quantities.total_input_tokens?.value,
    ).toBe("4");
    expect(getUsageEvidence(usage)!.usage.adapter_id).not.toBe(
      "gemini-generate-content",
    );
  });

  it("shares JSON and fragmented cumulative SSE evidence, preserving the last receipt once", () => {
    const parser = new GeminiStreamParser(
      getCompatibilityProfile("google_gemini_compatible")!.usage_schema!
        .gemini_generate_content,
    );
    const frame = (usageMetadata: unknown) =>
      `data: ${JSON.stringify({ candidates: [{ finishReason: "STOP" }], usageMetadata })}\n\n`;
    const raw =
      frame({
        ...fixture(),
        candidatesTokenCount: 1,
        totalTokenCount: 101,
        candidatesTokensDetails: [{ modality: "TEXT", tokenCount: 1 }],
      }) +
      frame(fixture()) +
      frame(fixture());
    const events = [];
    for (let index = 0; index < raw.length; index += 11)
      events.push(...parser.parse(raw.slice(index, index + 11)));
    expect(events.filter((event) => event.type === "stop")).toHaveLength(1);
    expect(getUsageEvidence(parser.getPricingUsage()!)!.usage).toEqual(
      normalize(fixture()),
    );
  });
});

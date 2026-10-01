import { attachTokenPricingEvidence } from "../../src/providers/pricing-usage-evidence";
import { getUsageEvidence } from "../../src/canonical/usage-evidence";
import { getCompatibilityProfile } from "../../src/catalog/compatibility-profiles";
import type { UsageSchema } from "../../src/providers/usage-schema-resolver";
import { extractUsageByKnownFields } from "../../src/providers/usage-schema-resolver";
import { book, quote, rate } from "./pricing-fixtures";
import { providerFailureUsage } from "../../src/providers/provider-failure-evidence";

const normalize = (
  body: Record<string, unknown>,
  schema?: UsageSchema,
  operation?: string,
) => {
  // Canonical fallback zeroes and unsafe numbers must not override raw billing evidence.
  const canonical = { input_tokens: 0, output_tokens: 0 };
  attachTokenPricingEvidence(body, canonical, schema, operation);
  expect(canonical).toEqual({ input_tokens: 0, output_tokens: 0 });
  return getUsageEvidence(canonical)!.usage;
};

describe("raw provider pricing evidence", () => {
  it("preserves only explicit failed audio/rerank request and character counters", () => {
    const speech = getUsageEvidence(providerFailureUsage(JSON.stringify({ input: "PRIVATE-INPUT", error: { message: "Synthetic" }, usage: { text_characters: "9007199254740993", request_count: 1 } }), undefined, "audio_speech")!)!.usage;
    expect(speech.quantities.text_characters).toMatchObject({ value: "9007199254740993", quality: "observed", source: "provider_usage" });
    expect(speech.quantities.request_count?.value).toBe("1"); expect(JSON.stringify(speech)).not.toContain("PRIVATE-INPUT");
    const unknown = getUsageEvidence(providerFailureUsage(JSON.stringify({ input: "PRIVATE-INPUT", error: "failed" }), undefined, "audio_speech")!)!.usage;
    expect(unknown.quantities.text_characters?.value ?? null).toBeNull(); expect(unknown.quantities.request_count?.value ?? null).toBeNull();
    const rerank = getUsageEvidence(providerFailureUsage(JSON.stringify({ meta: { rerank_request_count: 2, request_count: 2, billed_units: { search_units: 3 } } }), undefined, "rerank")!)!.usage;
    expect(rerank.quantities.rerank_request_count?.value).toBe("2"); expect(rerank.quantities.rerank_search_units?.value).toBe("3");
  });
  it("does not replace explicit invalid/null primary failed-media counters with fallback aliases", () => {
    const audio = getUsageEvidence(providerFailureUsage(JSON.stringify({ usage: { audio_input_seconds: null, seconds: 10 } }), undefined, "audio_transcription")!)!.usage;
    expect(audio.quantities.audio_input_seconds?.value).toBeNull();
    const rerank = getUsageEvidence(providerFailureUsage(JSON.stringify({ usage: { document_count: -1, documents: 3, billed_units: null }, meta: { billed_units: { search_units: 2 } } }), undefined, "rerank")!)!.usage;
    expect(rerank.quantities.rerank_document_count?.value).toBeNull(); expect(rerank.diagnostics.some(d => d.code === "pricing_invalid_quantity")).toBe(true);
    expect(rerank.quantities.rerank_search_units?.value ?? null).toBeNull();
  });
  it.each(["chat_completions", "responses", "messages"])("retains raw Chat modality counts on a failed %s attempt", operation => {
    const failure = providerFailureUsage(JSON.stringify({ error: { message: "Synthetic failure" }, usage: { prompt_tokens: 1, completion_tokens: 20, completion_tokens_details: { audio_tokens: 20 } } }), undefined, operation);
    expect(getUsageEvidence(failure!)!.usage.quantities.audio_output_tokens).toMatchObject({ value: "20", quality: "observed" });
  });
  it.each([
    -1,
    NaN,
    Infinity,
    "NaN",
    "1e3",
    "1.5",
    Number.MAX_SAFE_INTEGER + 1,
    {},
    false,
  ])("retains invalid raw input %p rather than a canonical zero", (value) => {
    const usage = normalize({
      usage: { prompt_tokens: value, completion_tokens: 2 },
    });
    expect(usage.quantities.total_input_tokens?.value).toBeNull();
    expect(usage.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "pricing_invalid_quantity" }),
      ]),
    );
  });

  it("preserves exact decimal-string counters above the numeric safe range", () => {
    const usage = normalize({
      usage: { prompt_tokens: "9007199254740993", completion_tokens: "2" },
    });
    expect(usage.quantities.total_input_tokens?.value).toBe("9007199254740993");
    expect(usage.quantities.output_tokens?.value).toBe("2");
    expect(usage.diagnostics).toEqual([]);
  });

  it("sums custom and Anthropic-compatible partitions without binary rounding", () => {
    const schema = getCompatibilityProfile("anthropic_messages_compatible")!
      .usage_schema!.messages;
    const usage = normalize(
      {
        usage: {
          input_tokens: "9007199254740993",
          output_tokens: "2",
          cache_read_input_tokens: "100",
          cache_creation_input_tokens: "10",
        },
      },
      schema,
    );
    expect(usage.quantities.total_input_tokens?.value).toBe("9007199254741103");
    expect(usage.quantities.uncached_input_tokens?.value).toBe(
      "9007199254740993",
    );
    expect(usage.quantities.cache_write_tokens?.value).toBe("10");
  });

  it("does not turn a partial or malformed custom sum into a known canonical total", () => {
    const schema = { input_tokens_parts: ["usage.a", "usage.b"] };
    expect(
      normalize({ usage: { a: 2 } }, schema).quantities.total_input_tokens
        ?.value,
    ).toBeNull();
    const malformed = normalize({ usage: { a: 2, b: "bad" } }, schema);
    expect(malformed.quantities.total_input_tokens?.value).toBeNull();
    expect(malformed.diagnostics.length).toBeGreaterThan(0);
  });

  it("keeps an observed zero and reconstructs only missing values from complete totals", () => {
    expect(
      normalize({
        usage: { prompt_tokens: 0, completion_tokens: 3, total_tokens: 10 },
      }).quantities.total_input_tokens?.value,
    ).toBe("0");
    expect(
      normalize({
        usage: { completion_tokens: 3, total_tokens: "9007199254741000" },
      }).quantities.total_input_tokens?.value,
    ).toBe("9007199254740997");
    expect(normalize({}).quantities.total_input_tokens?.value).toBeNull();
  });

  it("marks absent cache attribution as estimated without downgrading observed output", () => {
    const usage = normalize({
      usage: { prompt_tokens: 100, completion_tokens: 2 },
    });
    expect(usage.quantities.uncached_input_tokens).toMatchObject({
      value: "100",
      quality: "estimated",
      source: "heuristic",
    });
    expect(usage.quantities.output_tokens).toMatchObject({
      value: "2",
      quality: "observed",
    });
  });

  it("does not infer cache TTL and does not read inherited object properties", () => {
    const inherited = Object.create({ prompt_tokens: 42 }) as Record<
      string,
      unknown
    >;
    expect(
      normalize({ usage: inherited }).quantities.total_input_tokens?.value,
    ).toBeNull();
    const usage = normalize({
      usage: {
        input_tokens: 2,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 10,
      },
    });
    expect(usage.quantities.total_input_tokens?.value).toBe("12");
    expect(usage.quantities.cache_write_tokens?.value).toBe("10");
    expect(usage.quantities.cache_write_5m_tokens?.value).toBe("0");
    expect(usage.diagnostics).toEqual([]);
  });

  it("supports an embeddings output-zero contract without inventing input usage", () => {
    const usage = normalize({}, undefined, "embeddings");
    expect(usage.quantities.output_tokens?.value).toBe("0");
    expect(usage.quantities.total_input_tokens?.value).toBeNull();
  });

  it("meters documented chat subsets exactly, without billing parent or reasoning twice", () => {
    const usage = normalize({ usage: {
      prompt_tokens: "9007199254741000", completion_tokens: 25,
      prompt_tokens_details: { text_tokens: "9007199254740993", audio_tokens: 5, image_tokens: 2, cached_tokens: 0, cache_write_tokens: 0 },
      completion_tokens_details: { text_tokens: 5, audio_tokens: 20, reasoning_tokens: 2, accepted_prediction_tokens: 1, rejected_prediction_tokens: 1 },
    }});
    expect(usage.adapter_version).toBe("3");
    expect(usage.quantities.uncached_text_input_tokens).toMatchObject({ value: "9007199254740993", source: "provider_usage", quality: "observed", subset_of: "uncached_input_tokens" });
    expect(usage.quantities.audio_output_tokens).toMatchObject({ value: "20", source: "provider_usage", quality: "observed", subset_of: "output_tokens" });
    expect(usage.quantities.image_output_tokens).toBeUndefined();
    expect(usage.diagnostics).toEqual([]);
    const result = quote(book([rate("text", "text_output_tokens", "1", "1"), rate("audio", "audio_output_tokens", "2", "1")]), usage);
    expect(result.status).toBe("priced");
    expect(result.report_amount).toBe("45.000000000");
    expect(result.lines.map(line => line.dimension)).toEqual(["text_output_tokens", "audio_output_tokens"]);
  });

  it.each([
    { cached_tokens: 1, cache_write_tokens: 0 },
    { cached_tokens: 0, cache_write_tokens: 1 },
    { cached_tokens: 0 },
    { cache_write_tokens: 0 },
    {},
  ])("keeps uncached allocation unknown with nonzero or undisclosed caches: %p", caches => {
    const usage = normalize({ usage: {
      prompt_tokens: 10, completion_tokens: 4,
      prompt_tokens_details: { text_tokens: 8, audio_tokens: 2, image_tokens: 0, ...caches },
      completion_tokens_details: { audio_tokens: 4 },
    }});
    expect(usage.quantities.uncached_text_input_tokens).toMatchObject({ value: null, quality: "missing" });
    expect(usage.quantities.uncached_audio_input_tokens?.value).toBeNull();
    expect(usage.quantities.uncached_image_input_tokens).toMatchObject({ value: "0", quality: "observed" });
    expect(usage.quantities.audio_output_tokens?.value).toBe("4");
    expect(usage.quantities.text_output_tokens).toBeUndefined();
    expect(usage.diagnostics).toEqual([]);
    expect(quote(book([rate("audio", "uncached_audio_input_tokens", "1")]), usage).report_amount).toBeNull();
  });

  it.each([-1, "1.5", "1e3", false, {}, Number.MAX_SAFE_INTEGER + 1])("diagnoses invalid modality counters %p even when caches prevent allocation", value => {
    const usage = normalize({ usage: { prompt_tokens: 10, completion_tokens: 10, prompt_tokens_details: { audio_tokens: value }, completion_tokens_details: { audio_tokens: value } } });
    expect(usage.quantities.uncached_audio_input_tokens?.value).toBeNull();
    expect(usage.quantities.audio_output_tokens?.value).toBeNull();
    expect(usage.diagnostics.filter(d => d.code === "pricing_invalid_quantity")).toHaveLength(2);
  });

  it("rejects contradictory prompt and completion subsets, not clamps them", () => {
    const usage = normalize({ usage: {
      prompt_tokens: 10, completion_tokens: 10,
      prompt_tokens_details: { text_tokens: 8, audio_tokens: 3, cached_tokens: 0, cache_write_tokens: 0 },
      completion_tokens_details: { text_tokens: 9, audio_tokens: 2 },
    }});
    expect(usage.quantities.uncached_text_input_tokens?.value).toBeNull();
    expect(usage.quantities.audio_output_tokens?.value).toBeNull();
    expect(usage.diagnostics.filter(d => d.code === "pricing_usage_conflict")).toHaveLength(2);
    const incomplete = normalize({ usage: { prompt_tokens: 10, completion_tokens: 10, prompt_tokens_details: { text_tokens: 5, audio_tokens: 0, image_tokens: 0, cached_tokens: 0, cache_write_tokens: 0 } } });
    expect(incomplete.diagnostics[0].code).toBe("pricing_usage_conflict");
  });

  it("does not synthesize missing modalities, infer text from totals or trust inherited fields", () => {
    const usage = normalize({ usage: { prompt_tokens: 10, completion_tokens: 8, completion_tokens_details: Object.assign(Object.create({ text_tokens: 6 }), { audio_tokens: 2 }) } });
    expect(usage.quantities.audio_output_tokens?.value).toBe("2");
    expect(usage.quantities.text_output_tokens).toBeUndefined();
    expect(usage.quantities.image_output_tokens).toBeUndefined();
    const unsupported = normalize({ usage: { input_tokens: 10, output_tokens: 8, input_tokens_details: { text_tokens: 10 }, output_tokens_details: { audio_tokens: 8 } } });
    expect(unsupported.quantities.uncached_text_input_tokens).toBeUndefined();
    expect(unsupported.quantities.audio_output_tokens).toBeUndefined();
  });

  it("does not mix Chat detail fields with a native or explicitly overridden total schema", () => {
    const body = { usage: { input_tokens: 100, output_tokens: 200, prompt_tokens: 10, completion_tokens: 20, prompt_tokens_details: { audio_tokens: 10, cached_tokens: 0, cache_write_tokens: 0 }, completion_tokens_details: { audio_tokens: 20 } } };
    for (const schema of [undefined, { input_tokens: "usage.input_tokens", output_tokens: "usage.output_tokens" }]) {
      const usage = normalize(body, schema);
      expect(usage.quantities.total_input_tokens?.value).toBe("100");
      expect(usage.quantities.output_tokens?.value).toBe("200");
      expect(usage.quantities.uncached_audio_input_tokens).toBeUndefined();
      expect(usage.quantities.audio_output_tokens).toBeUndefined();
    }
  });

  it.each(["prompt_tokens_details", "input_tokens_details"])("recognizes documented %s cache-write totals in both exact and compatibility usage", details => {
    const body = { usage: { prompt_tokens: 10, completion_tokens: 2, [details]: { cache_write_tokens: 3, cached_tokens: 2 } } };
    expect(extractUsageByKnownFields(body).cache_creation_input_tokens).toBe(3);
    const usage = normalize(body);
    expect(usage.quantities.cache_write_tokens?.value).toBe("3");
    expect(usage.quantities.uncached_input_tokens).toMatchObject({ value: "5", quality: "observed" });
    expect(usage.diagnostics).toEqual([]);
  });
});

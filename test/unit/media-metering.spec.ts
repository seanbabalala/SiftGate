import { MediaNormalizer } from "../../src/canonical/normalizers/media.normalizer";
import type {
  CanonicalMediaRequest,
  CanonicalMediaResponse,
  CanonicalRerankRequest,
  CanonicalRerankResponse,
} from "../../src/canonical/canonical.types";
import {
  meterMediaUsage,
  meterRerankProviderUsage,
  mediaPricingContext,
} from "../../src/pricing/media-metering";
import { pcmWaveSeconds } from "../../src/pricing/wave-metering";
import { compilePriceBook } from "../../src/pricing/pricing-compiler";
import { calculateCost } from "../../src/pricing/cost-calculator";
import { book, rate, tokens } from "./pricing-fixtures";

import { wave } from "./media-metering-fixtures";
const normalize = (
  payload: unknown,
  format: CanonicalMediaRequest["source_format"] = "image_generation",
  contentType = "application/json",
) =>
  new MediaNormalizer().normalize(
    payload,
    { "content-type": contentType },
    format,
  );
const response = (
  body: CanonicalMediaResponse["body"],
): CanonicalMediaResponse => ({
  id: "synthetic",
  body,
  content_type: "application/json",
  provider_response_type: "application/json",
  usage: { input_tokens: 0, output_tokens: 0 },
  model: "synthetic",
  routing: {
    tier: "direct",
    node: "node",
    score: 0,
    latency_ms: 1,
    is_fallback: false,
  },
});

describe("actual media metering", () => {
  it("CALC-10 separates requested images from successful output evidence and never retains image content", () => {
    const request = normalize({
      model: "synthetic",
      n: 4,
      prompt: "private prompt",
    });
    const usage = meterMediaUsage(
      request,
      response({
        data: [
          { url: "https://private.test/a" },
          { b64_json: "privatebytes" },
          { url: "https://private.test/b" },
          { error: { code: "failed" } },
        ],
      }),
    );
    expect(usage.quantities.image_count).toMatchObject({
      value: "3",
      source: "provider_job_result",
      quality: "observed",
    });
    expect(usage.quantities.requested_image_count).toMatchObject({
      value: "4",
      source: "request_metadata",
    });
    const price = book([rate("actual", "image_count", "0.04", "1")]);
    const compiled = compilePriceBook(price, {
      book_id: "test",
      version_id: "1",
    });
    expect(calculateCost(usage, compiled.resolve(usage)).amount).toBe(
      "0.120000000",
    );
    expect(JSON.stringify(usage)).not.toMatch(/private|prompt|https/);
  });

  it("never converts unknown image envelopes or malformed scalar counters to a known zero", () => {
    const request = normalize({ n: 4 });
    expect(
      meterMediaUsage(request, response({})).quantities.image_count?.value,
    ).toBeNull();
    const incomplete = meterMediaUsage(
      request,
      response({ data: [{ url: "synthetic" }, {}] }),
    );
    expect(incomplete.quantities.image_count?.quality).toBe("estimated");
    expect(incomplete.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "pricing_dimension_missing" }),
      ]),
    );
    const malformed = meterMediaUsage(
      request,
      response({ usage: { image_count: -1 }, data: [{ url: "synthetic" }] }),
    );
    expect(malformed.quantities.image_count?.value).toBeNull();
    expect(malformed.diagnostics[0].code).toBe("pricing_invalid_quantity");
    expect(
      meterMediaUsage(request, undefined, "failure").quantities
        .requested_image_count?.value,
    ).toBeNull();
  });

  it("CALC-12 reads duration units as seconds and does not conflate them with tokens", () => {
    const usage = meterMediaUsage(
      normalize({ model: "synthetic" }, "audio_transcription"),
      response({
        usage: { type: "duration", seconds: "61" },
        text: "private transcript",
      }),
    );
    expect(usage.quantities.audio_input_seconds?.value).toBe("61");
    expect(usage.quantities.total_input_tokens).toBeUndefined();
    const compiled = compilePriceBook(
      book([rate("minute", "audio_input_seconds", "0.06", "60")]),
      { book_id: "test", version_id: "1" },
    );
    expect(calculateCost(usage, compiled.resolve(usage)).amount).toBe(
      "0.061000000",
    );
  });

  it("measures bounded PCM WAV headers and rejects compressed, inconsistent and truncated data", () => {
    expect(pcmWaveSeconds(wave(6.4))).toBe("6.400000000000000000");
    expect(pcmWaveSeconds(wave(0))).toBe("0.000000000000000000");
    expect(pcmWaveSeconds(wave(6.4).subarray(0, 60))).toBeNull();
    const compressed = wave(1);
    compressed.writeUInt16LE(85, 20);
    expect(pcmWaveSeconds(compressed)).toBeNull();
    const inconsistent = wave(1);
    inconsistent.writeUInt32LE(999, 28);
    expect(pcmWaveSeconds(inconsistent)).toBeNull();
    expect(pcmWaveSeconds(Buffer.from("MP3 bytes"))).toBeNull();
  });

  it("measures binary speech without saving audio, and counts Unicode code points instead of UTF-16 units", () => {
    const request = normalize(
      { model: "synthetic", input: "你好😀" },
      "audio_speech",
    );
    const usage = meterMediaUsage(request, response(wave(6.4)));
    expect(usage.quantities.audio_output_seconds).toMatchObject({
      value: "6.4",
      source: "local_measurement",
      quality: "observed",
    });
    expect(usage.quantities.text_characters?.value).toBe("3");
    expect(JSON.stringify(usage)).not.toContain("你好");
    expect(
      meterMediaUsage(request, response(Buffer.from("MP3 bytes"))).quantities
        .audio_output_seconds?.value,
    ).toBeNull();
  });

  it("extracts only allowlisted multipart fields and measures the file without decoding it as text", () => {
    const boundary = "meter-fixture";
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nsynthetic\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="private-name.wav"\r\nContent-Type: audio/wav\r\n\r\n`,
      ),
      wave(1.125),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const request = normalize(
      body,
      "audio_transcription",
      `multipart/form-data; boundary=${boundary}`,
    );
    const usage = meterMediaUsage(
      request,
      response({ text: "private transcript" }),
    );
    expect(usage.quantities.audio_input_seconds).toMatchObject({
      value: "1.125",
      source: "local_measurement",
    });
    expect(JSON.stringify(usage)).not.toMatch(/private|transcript|filename/);
  });

  it("does not trust incomplete multipart containers or conflicting duplicate quantity fields", () => {
    const boundary = "invalid-fields";
    const fields = `--${boundary}\r\nContent-Disposition: form-data; name="n"\r\n\r\n4\r\n--${boundary}\r\nContent-Disposition: form-data; name="n"\r\n\r\n8\r\n--${boundary}--\r\n`;
    const duplicate = meterMediaUsage(
      normalize(
        Buffer.from(fields),
        "image_edit",
        `multipart/form-data; boundary=${boundary}`,
      ),
      response({ data: [] }),
    );
    expect(duplicate.quantities.requested_image_count?.value).toBeNull();
    expect(
      duplicate.diagnostics.some(
        (entry) => entry.code === "pricing_invalid_quantity",
      ),
    ).toBe(true);
    const truncated = normalize(
      Buffer.from(fields.slice(0, fields.lastIndexOf(`--${boundary}--`))),
      "image_edit",
      `multipart/form-data; boundary=${boundary}`,
    );
    expect(
      meterMediaUsage(truncated, response({ data: [] })).quantities
        .requested_image_count?.value,
    ).toBeNull();
  });

  it("requires explicit additive billing when requested and actual measurements overlap", () => {
    const content = book([
      rate("actual", "image_count", "0.04", "1"),
      rate("requested", "requested_image_count", "0.04", "1"),
    ]);
    expect(() =>
      compilePriceBook(content, { book_id: "overlap", version_id: "1" }),
    ).toThrow();
    content.allow_combined_media = true;
    expect(() =>
      compilePriceBook(content, { book_id: "explicit-add", version_id: "1" }),
    ).not.toThrow();
  });

  it("retains safe reported variants and redacts credential-shaped strings before storing context", () => {
    const request = normalize({ n: 4, size: "1024x1024", quality: "high" });
    expect(
      mediaPricingContext(request, response({ size: "512x512" })).media?.size,
    ).toBe("512x512");
    const unsafe = normalize({
      quality: "sk-synthetic-not-a-real-key",
      width: 12,
    });
    expect(JSON.stringify(mediaPricingContext(unsafe))).not.toContain(
      "sk-synthetic",
    );
  });

  it("preserves input/output modality partitions without charging token parents twice", () => {
    const request = normalize({ input: "hello" }, "audio_speech");
    const usage = meterMediaUsage(
      request,
      response({
        usage: {
          input_tokens_details: { text_tokens: 10 },
          output_tokens_details: { audio_tokens: 20 },
        },
      }),
      "result",
      tokens({ input_tokens: 10, output_tokens: 20 }),
    );
    expect(usage.quantities.uncached_text_input_tokens?.value).toBe("10");
    expect(usage.quantities.audio_output_tokens?.value).toBe("20");
    expect(usage.diagnostics).toEqual([]);
    expect(() =>
      compilePriceBook(
        book([
          rate("input-parent", "uncached_input_tokens", "1"),
          rate("input-child", "uncached_text_input_tokens", "1"),
        ]),
        { book_id: "bad", version_id: "1" },
      ),
    ).toThrow();
  });

  it("does not treat heuristic zero caches as observed uncached modality allocation", () => {
    const tokenUsage = tokens({ input_tokens: 10, output_tokens: 20 });
    tokenUsage.quantities.cache_read_tokens!.quality = "estimated";
    const usage = meterMediaUsage(
      normalize({ input: "hello" }, "audio_speech"),
      response({ usage: { input_tokens_details: { text_tokens: 10 }, output_tokens_details: { audio_tokens: 20 } } }),
      "result", tokenUsage,
    );
    expect(usage.quantities.uncached_text_input_tokens).toMatchObject({ value: null, quality: "missing" });
    expect(usage.quantities.audio_output_tokens).toMatchObject({ value: "20", quality: "observed" });
    expect(usage.diagnostics).toEqual([]);
  });

  it("keeps rerank requests, documents and provider search units separate from tokens and top_n", () => {
    const request: CanonicalRerankRequest = {
      model: "synthetic",
      query: "private query",
      documents: ["private a", "private b", "private c"],
      top_n: 1,
      metadata: {
        source_format: "rerank",
        original_model: "synthetic",
        raw_headers: {},
      },
    };
    const result: CanonicalRerankResponse = {
      id: "synthetic",
      object: "rerank",
      model: "synthetic",
      results: [{ index: 0, relevance_score: 0.9 }],
      usage: { input_tokens: 0, output_tokens: 0 },
      routing: {
        tier: "direct",
        node: "node",
        score: 0,
        latency_ms: 1,
        is_fallback: false,
      },
    };
    const usage = meterRerankProviderUsage(request, result, {
      meta: { billed_units: { search_units: 2 } },
    });
    expect(usage.quantities.rerank_search_units?.value).toBe("2");
    expect(usage.quantities.rerank_request_count?.value).toBe("1");
    expect(usage.quantities.requested_rerank_document_count?.value).toBe("3");
    expect(usage.quantities.rerank_document_count?.value).toBeNull();
    expect(usage.quantities.total_input_tokens).toBeUndefined();
    expect(JSON.stringify(usage)).not.toMatch(/private|relevance/);
  });
});

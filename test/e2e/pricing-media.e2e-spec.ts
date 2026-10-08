import { PricingRecoveryService } from "../../src/pricing/pricing-recovery.service";
import { DataSource } from "typeorm";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as yaml from "js-yaml";
import { createE2EHarness, E2EHarness, FIXTURE_PATH, API_KEY } from "./setup";
import { applyPricingSchema } from "../../src/pricing/pricing-schema";
import type { PriceBookContent } from "../../src/pricing/pricing.types";
import { book, rate, tokenBook } from "../unit/pricing-fixtures";
import { wave } from "../unit/media-metering-fixtures";

describe("synchronous quantity pricing (isolated, mock media)", () => {
  let harness: E2EHarness;
  let directory: string;
  const base = "/api/dashboard/pricing";
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "media-pricing-"));
    const config = yaml.load(readFileSync(FIXTURE_PATH, "utf8")) as Record<
      string,
      unknown
    >;
    config.budget = {
      daily_token_limit: 10000000,
      daily_cost_limit: 1000,
      alert_threshold: 0.8,
    };
    (config.routing as Record<string, unknown>).retry = {
      max_retries: 1,
      backoff_base_ms: 1,
      backoff_max_ms: 1,
      retryable_status: [500, 502, 503, 504],
    };
    (config.nodes as unknown[]).push({
      id: "mock-media-other",
      name: "Synthetic image node",
      protocol: "chat_completions",
      base_url: "http://mock-media-other.test",
      endpoint: "/v1/chat/completions",
      images_generations_endpoint: "/v1/images/generations",
      api_key: "synthetic-test-key",
      models: [],
      image_models: ["fixture-image-other"],
    });
    (config.models_pricing as Record<string, unknown>)["fixture-image-other"] =
      { input: 999, output: 0 };
    const file = join(directory, "gateway.yaml");
    writeFileSync(file, yaml.dump(config));
    harness = await createE2EHarness(file);
    await applyPricingSchema(harness.app.get(DataSource));
  }, 30000);
  afterEach(async () => {
    await harness?.close();
    rmSync(directory, { recursive: true, force: true });
  });

  async function publish(
    content: PriceBookContent,
    model: string,
    operation?: string,
  ) {
    const created = await harness.agent
      .post(`${base}/books`)
      .send({ name: "Synthetic media price", content });
    expect(created.status).toBe(201);
    const revision = (await harness.agent.get(`${base}/bindings`)).body.head
      .revision;
    const result = await harness.agent
      .post(`${base}/drafts/${created.body.draft.id}/publish`)
      .send({
        draft_revision: 1,
        catalog_revision: revision,
        reason: "Synthetic fixture only",
        confirm: true,
        targets: [
          { level: "model", model, ...(operation ? { operation } : {}) },
        ],
      });
    expect(result.status).toBe(201);
  }
  const call = (path: string, body: Record<string, unknown>) =>
    harness.agent
      .post(path)
      .set("Authorization", `Bearer ${API_KEY}`)
      .send(body);
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
    });
  const images = () => ({
    data: [
      { b64_json: "synthetic-image-a" },
      { url: "https://private-output.test/b" },
      { b64_json: "synthetic-image-c" },
      { error: { code: "failed" } },
    ],
  });
  async function detail() {
    const log = (await harness.agent.get("/api/dashboard/logs")).body.data[0];
    const response = await harness.agent.get(
      `/api/dashboard/logs/${log.id}/cost-breakdown`,
    );
    expect(response.status).toBe(200);
    return { log, cost: response.body };
  }

  it("CALC-10 bills actual successful images and agrees with the quote API without retaining content", async () => {
    const content = book([rate("image", "image_count", "0.04", "1")]);
    await publish(content, "gpt-image-1", "image_generation");
    harness.fetchMock.setHandler(async () => json(images()));
    const result = await call("/v1/images/generations", {
      model: "gpt-image-1",
      n: 4,
      prompt: "PRIVATE-PROMPT",
    });
    expect(result.status).toBe(200);
    expect(result.body).toEqual(images());
    const { log, cost } = await detail();
    expect(cost.amount).toBe("0.120000000000000000");
    expect(cost.budget_committed_usd).toBe(cost.amount);
    expect(log.cost_usd).toBeCloseTo(0.12, 10);
    expect(cost.attempts[0].cost.usage.quantities.image_count.value).toBe("3");
    expect(
      cost.attempts[0].cost.usage.quantities.requested_image_count.value,
    ).toBe("4");
    const quote = await harness.agent
      .post(`${base}/quote`)
      .send({
        content,
        evidence: [
          {
            dimension: "image_count",
            value: "3",
            source: "provider_job_result",
          },
        ],
      });
    expect(quote.status).toBe(201);
    expect(quote.body.cost.report_amount).toBe("0.120000000");
    const source = harness.app.get(DataSource);
    const persisted = JSON.stringify([
      await source.query(
        "SELECT cost_json, price_context_json FROM pricing_attempts",
      ),
      await source.query(
        "SELECT estimate_json, target_json FROM pricing_reservations",
      ),
    ]);
    expect(persisted).not.toMatch(
      /PRIVATE-PROMPT|synthetic-image|private-output/,
    );
    expect(harness.fetchMock.calls).toHaveLength(1);
  });

  it("bills requested quantities only when the price book explicitly chooses that basis", async () => {
    await publish(
      book([rate("requested", "requested_image_count", "0.04", "1")]),
      "gpt-image-1",
      "image_generation",
    );
    harness.fetchMock.setHandler(async () => json(images()));
    expect(
      (
        await call("/v1/images/generations", {
          model: "gpt-image-1",
          n: 4,
          prompt: "test",
        })
      ).status,
    ).toBe(200);
    expect((await detail()).cost.amount).toBe("0.160000000000000000");
  });

  it("uses request-frozen image prices for auto routing instead of configured token prices", async () => {
    await publish(
      book([rate("expensive", "image_count", "0.04", "1")]),
      "gpt-image-1",
    );
    await publish(
      book([rate("cheap", "image_count", "0.01", "1")]),
      "fixture-image-other",
    );
    harness.fetchMock.setHandler(async () => json(images()));
    expect(
      (
        await call("/v1/images/generations", {
          model: "auto",
          n: 4,
          prompt: "auto media",
        })
      ).status,
    ).toBe(200);
    expect(harness.fetchMock.calls[0].url).toContain("mock-media-other.test");
    expect((await detail()).cost.amount).toBe("0.030000000000000000");
  });

  it("preserves unknown output quantities rather than declaring an opaque image response free", async () => {
    await publish(
      book([rate("image", "image_count", "0.04", "1")]),
      "gpt-image-1",
    );
    harness.fetchMock.setHandler(async () =>
      json({ id: "opaque-provider-response" }),
    );
    expect(
      (
        await call("/v1/images/generations", {
          model: "gpt-image-1",
          n: 4,
          prompt: "missing output count",
        })
      ).status,
    ).toBe(200);
    const { cost } = await detail();
    expect(cost.amount).toBeNull();
    expect(cost.unknown_attempts).toBe(1);
    expect(cost.status).not.toBe("free");
    expect(harness.fetchMock.calls).toHaveLength(1);
  });

  it("CALC-12 bills transcription seconds exactly or by rounded minutes according to the selected price book", async () => {
    const ratePerMinute = rate("minute", "audio_input_seconds", "0.06", "60");
    await publish(
      book([ratePerMinute]),
      "gpt-4o-mini-transcribe",
      "audio_transcription",
    );
    harness.fetchMock.setHandler(async () =>
      json({
        text: "PRIVATE-TRANSCRIPT",
        usage: { type: "duration", seconds: 61 },
      }),
    );
    expect(
      (
        await call("/v1/audio/transcriptions", {
          model: "gpt-4o-mini-transcribe",
        })
      ).status,
    ).toBe(200);
    expect((await detail()).cost.amount).toBe("0.061000000000000000");
    await publish(
      book([
        {
          ...ratePerMinute,
          quantity_rounding: { increment: "60", mode: "ceil" },
        },
      ]),
      "gpt-4o-mini-transcribe",
      "audio_transcription",
    );
    expect(
      (
        await call("/v1/audio/transcriptions", {
          model: "gpt-4o-mini-transcribe",
        })
      ).status,
    ).toBe(200);
    const { cost } = await detail();
    expect(cost.amount).toBe("0.120000000000000000");
    expect(JSON.stringify(cost)).not.toContain("PRIVATE-TRANSCRIPT");
  });

  it("measures PCM speech duration and combines an explicit base request fee", async () => {
    await publish(
      book([
        rate("seconds", "audio_output_seconds", "0.10", "1"),
        rate("base", "request_count", "0.02", "1"),
      ]),
      "tts-1",
      "audio_speech",
    );
    harness.fetchMock.setHandler(
      async () =>
        new Response(Uint8Array.from(wave(6.4)), {
          headers: { "content-type": "audio/wav" },
        }),
    );
    const result = await call("/v1/audio/speech", {
      model: "tts-1",
      input: "private speech text",
      response_format: "wav",
    });
    expect(result.status).toBe(200);
    expect(result.headers["content-type"]).toContain("audio/wav");
    const { cost } = await detail();
    expect(cost.amount).toBe("0.660000000000000000");
    expect(cost.budget_committed_usd).toBe(cost.amount);
    expect(
      cost.attempts[0].cost.usage.quantities.audio_output_seconds.source,
    ).toBe("local_measurement");
    expect(JSON.stringify(cost)).not.toContain("private speech");
  });

  it("uses explicit character pricing for opaque speech, and leaves unsupported duration unknown", async () => {
    await publish(
      book([rate("character", "text_characters", "0.01", "1")]),
      "tts-1",
      "audio_speech",
    );
    harness.fetchMock.setHandler(
      async () =>
        new Response(Buffer.from("opaque audio"), {
          headers: { "content-type": "audio/mpeg" },
        }),
    );
    expect(
      (await call("/v1/audio/speech", { model: "tts-1", input: "你好😀" }))
        .status,
    ).toBe(200);
    expect((await detail()).cost.amount).toBe("0.030000000000000000");
    await publish(
      book([rate("seconds", "audio_output_seconds", "0.1", "1")]),
      "tts-1",
      "audio_speech",
    );
    expect(
      (await call("/v1/audio/speech", { model: "tts-1", input: "你好😀" }))
        .status,
    ).toBe(200);
    expect((await detail()).cost.amount).toBeNull();
  });

  it("prices rerank request, requested documents and reported search units independently", async () => {
    harness.fetchMock.setHandler(async () =>
      json({
        results: [{ index: 1, relevance_score: 0.9 }],
        meta: { billed_units: { search_units: 2 } },
      }),
    );
    const input = {
      model: "rerank-english-v3",
      query: "private query",
      documents: ["one", "two", "three"],
      top_n: 1,
    };
    await publish(
      book([rate("per-request", "rerank_request_count", "0.1", "1")]),
      input.model,
      "rerank",
    );
    expect((await call("/v1/rerank", input)).status).toBe(200);
    expect((await detail()).cost.amount).toBe("0.100000000000000000");
    await publish(
      book([
        rate("per-document", "requested_rerank_document_count", "0.01", "1"),
      ]),
      input.model,
      "rerank",
    );
    expect((await call("/v1/rerank", input)).status).toBe(200);
    expect((await detail()).cost.amount).toBe("0.030000000000000000");
    await publish(
      book([rate("per-search-unit", "rerank_search_units", "0.01", "1")]),
      input.model,
      "rerank",
    );
    expect((await call("/v1/rerank", input)).status).toBe(200);
    const { cost } = await detail();
    expect(cost.amount).toBe("0.020000000000000000");
    expect(
      cost.attempts[0].cost.usage.quantities.total_input_tokens.value,
    ).toBeNull();
    expect(
      cost.attempts[0].cost.usage.quantities.rerank_document_count.value,
    ).toBeNull();
  });

  it("retains an accepted asynchronous image task as pending rather than committing its requested-quantity price", async () => {
    await publish(
      book([rate("requested", "requested_image_count", "0.04", "1")]),
      "gpt-image-1",
      "image_generation",
    );
    const reply = { id: "synthetic-pending-job", status: "queued" };
    harness.fetchMock.setHandler(
      async () =>
        new Response(JSON.stringify(reply), {
          status: 202,
          headers: { "content-type": "application/json" },
        }),
    );
    const result = await call("/v1/images/generations", {
      model: "gpt-image-1",
      n: 4,
      prompt: "pending job",
    });
    expect(result.status).toBe(200);
    expect(result.body).toEqual(reply);
    const initial = await detail();
    expect(initial.cost.status).toBe("pending");
    expect(initial.cost.amount).toBeNull();
    expect(initial.cost.budget_committed_usd).toBe("0.000000000000000000");
    expect(Number(initial.cost.budget_reserved_usd)).toBeGreaterThan(0);
    expect(
      (
        await harness.app
          .get(DataSource)
          .query("SELECT job_id, state FROM pricing_reservations")
      )[0],
    ).toEqual({ job_id: reply.id, state: "reserved" });
    await harness.app.get(PricingRecoveryService).runOnce();
    expect((await detail()).cost).toEqual(initial.cost);
    expect(harness.fetchMock.calls).toHaveLength(1);
  });

  it.each([
    ["edits", "image_edit"],
    ["variations", "image_variation"],
  ])(
    "meters multipart image %s without retaining file content",
    async (endpoint, operation) => {
      await publish(
        book([rate("image", "image_count", "0.04", "1")]),
        "gpt-image-1",
        operation,
      );
      harness.fetchMock.setHandler(async () => json(images()));
      const boundary = "pricing-image-fixture";
      const body = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\ngpt-image-1\r\n--${boundary}\r\nContent-Disposition: form-data; name="n"\r\n\r\n4\r\n--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="private-image.png"\r\nContent-Type: image/png\r\n\r\nPRIVATE-IMAGE-BYTES\r\n--${boundary}--\r\n`,
      );
      const result = await harness.agent
        .post(`/v1/images/${endpoint}`)
        .set("Authorization", `Bearer ${API_KEY}`)
        .set("Content-Type", `multipart/form-data; boundary=${boundary}`)
        .send(body);
      expect(result.status).toBe(200);
      const { cost } = await detail();
      expect(cost.amount).toBe("0.120000000000000000");
      expect(
        cost.attempts[0].cost.usage.quantities.requested_image_count.value,
      ).toBe("4");
      expect(JSON.stringify(cost)).not.toMatch(/PRIVATE-IMAGE|private-image/);
    },
  );

  it("meters uploaded PCM audio when the transcription provider returns text without duration usage", async () => {
    await publish(
      book([rate("duration", "audio_input_seconds", "0.06", "60")]),
      "gpt-4o-mini-transcribe",
      "audio_translation",
    );
    harness.fetchMock.setHandler(async () =>
      json({ text: "private translation" }),
    );
    const boundary = "pricing-audio-fixture";
    const payload = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\ngpt-4o-mini-transcribe\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="private.wav"\r\nContent-Type: audio/wav\r\n\r\n`,
      ),
      wave(1.125),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const result = await harness.agent
      .post("/v1/audio/translations")
      .set("Authorization", `Bearer ${API_KEY}`)
      .set("Content-Type", `multipart/form-data; boundary=${boundary}`)
      .send(payload);
    expect(result.status).toBe(200);
    const { cost } = await detail();
    expect(cost.amount).toBe("0.001125000000000000");
    expect(
      cost.attempts[0].cost.usage.quantities.audio_input_seconds.source,
    ).toBe("local_measurement");
    expect(JSON.stringify(cost)).not.toMatch(/private.wav|private translation/);
  });

  it("does not fall through to a cheap unconditional rate for an unknown required media variant", async () => {
    const content = book([rate("base", "image_count", "0.01", "1")]);
    content.groups.push({
      id: "quality",
      order: 1,
      required: true,
      rules: [
        {
          id: "high",
          priority: 1,
          mode: "whole_request",
          condition: { media: { quality: ["high"] } },
          rates: [
            {
              operation: "replace",
              component: rate("high-image", "image_count", "0.08", "1"),
            },
          ],
        },
        {
          id: "cheap-default",
          priority: 0,
          mode: "whole_request",
          condition: {},
          rates: [],
        },
      ],
    });
    await publish(content, "gpt-image-1", "image_generation");
    harness.fetchMock.setHandler(async () => json(images()));
    expect(
      (
        await call("/v1/images/generations", {
          model: "gpt-image-1",
          n: 4,
          quality: "unexpected",
          prompt: "variant test",
        })
      ).status,
    ).toBe(200);
    const { cost } = await detail();
    expect(cost.amount).toBeNull();
    expect(cost.attempts[0].cost.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "pricing_unknown_variant" }),
      ]),
    );
  });

  it("does not activate media pricing merely because an unrelated chat book was published", async () => {
    harness.fetchMock.setHandler(async () => json(images()));
    expect(
      (
        await call("/v1/images/generations", {
          model: "gpt-image-1",
          n: 4,
          prompt: "legacy request",
        })
      ).status,
    ).toBe(200);
    const before = await detail();
    await publish(tokenBook(), "gpt-4o");
    expect(
      (
        await call("/v1/images/generations", {
          model: "gpt-image-1",
          n: 4,
          prompt: "legacy request",
        })
      ).status,
    ).toBe(200);
    const after = await detail();
    expect(after.cost.status).toBe("legacy_estimate");
    expect(after.log.cost_usd).toBe(before.log.cost_usd);
  });
});

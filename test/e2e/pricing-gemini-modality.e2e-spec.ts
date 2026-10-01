import { DataSource } from "typeorm";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as yaml from "js-yaml";
import { createE2EHarness, E2EHarness, FIXTURE_PATH, API_KEY } from "./setup";
import { applyPricingSchema } from "../../src/pricing/pricing-schema";
import { PricingRecoveryService } from "../../src/pricing/pricing-recovery.service";
import { book, rate } from "../unit/pricing-fixtures";
import type { PricingAdmissionPolicy } from "../../src/pricing/pricing-admission.types";

const base = "/api/dashboard/pricing";
const tariff = () =>
  book([
    rate("text-in", "uncached_text_input_tokens", "1"),
    rate("audio-in", "uncached_audio_input_tokens", "10"),
    rate("image-in", "uncached_image_input_tokens", "5"),
    rate("text-out", "text_output_tokens", "2"),
    rate("audio-out", "audio_output_tokens", "20"),
    rate("image-out", "image_output_tokens", "30"),
    rate("cache", "cache_read_tokens", "0.1"),
  ]);
const parts = (text: number, audio: number, image: number) => [
  { modality: "TEXT", tokenCount: text },
  { modality: "AUDIO", tokenCount: audio },
  { modality: "IMAGE", tokenCount: image },
];
const usage = () => ({
  promptTokenCount: 100,
  candidatesTokenCount: 30,
  thoughtsTokenCount: 0,
  totalTokenCount: 130,
  cachedContentTokenCount: 40,
  promptTokensDetails: parts(60, 30, 10),
  cacheTokensDetails: parts(30, 10, 0),
  candidatesTokensDetails: parts(10, 15, 5),
});

describe("native Gemini modality pricing through real public ingress, with isolated state and mocked upstream", () => {
  let h: E2EHarness, db: DataSource, directory: string;
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "gemini-modality-"));
    const config = yaml.load(readFileSync(FIXTURE_PATH, "utf8")) as Record<
      string,
      unknown
    >;
    config.cache = { enabled: false };
    const node = (config.nodes as Record<string, unknown>[])[0];
    node.protocol = "gemini";
    node.compatibility_profile = "google_gemini_compatible";
    node.endpoint = "/v1beta/models/:model:generateContent";
    config.budget = {
      daily_token_limit: 10000000,
      daily_cost_limit: 1000,
      alert_threshold: 0.8,
    };
    (config.routing as Record<string, unknown>).retry = {
      max_retries: 0,
      backoff_base_ms: 1,
      backoff_max_ms: 1,
      retryable_status: [500],
    };
    const file = join(directory, "gateway.yaml");
    writeFileSync(file, yaml.dump(config));
    h = await createE2EHarness(file);
    db = h.app.get(DataSource);
    await h.app.get(PricingRecoveryService).onModuleDestroy();
    await applyPricingSchema(db);
  }, 30000);
  afterEach(async () => {
    await h?.close();
    rmSync(directory, { recursive: true, force: true });
  });

  async function publish(operation = "chat_completions", content = tariff()) {
    const created = await h.agent
      .post(`${base}/books`)
      .send({ name: "Synthetic Gemini modality tariff", content });
    expect(created.status).toBe(201);
    const catalog = (await h.agent.get(`${base}/bindings`)).body.head.revision;
    const options = {
      draft_revision: 1,
      catalog_revision: catalog,
      confirm: true,
      reason: "Synthetic test",
      targets: [{ level: "model", model: "gpt-4o", operation }],
    };
    const preview = await h.agent
      .post(`${base}/drafts/${created.body.draft.id}/preview-publication`)
      .send(options);
    expect(preview.status).toBe(201);
    expect(preview.body.metering.registry_version).toBe("gateway-metering-v5");
    if (
      content.billing_dimensions.some(
        (dimension) =>
          dimension.includes("text") ||
          dimension.includes("audio") ||
          dimension.includes("image"),
      )
    )
      expect(preview.body.metering.targets[0].notices).toContain(
        "modality_allocation_required",
      );
    expect(preview.body.metering.can_publish).toBe(true);
    const published = await h.agent
      .post(`${base}/drafts/${created.body.draft.id}/publish`)
      .send({
        ...options,
        metering_assessment_hash: preview.body.metering.assessment_hash,
      });
    expect(published.status).toBe(201);
    return {
      bookId: created.body.book.id,
      versionId: published.body.version_id,
    };
  }
  async function policy(
    value: PricingAdmissionPolicy,
    operation = "chat_completions",
  ) {
    const revision = (await h.agent.get(`${base}/admission-policies`)).body.head
      .revision;
    const result = await h.agent.put(`${base}/admission-policy`).send({
      catalog_revision: revision,
      confirm: true,
      reason: "Synthetic limits",
      scope: "workspace",
      operation,
      policy: value,
    });
    expect(result.status).toBe(200);
  }
  const caps: PricingAdmissionPolicy = {
    mode: "reserve_upper_bound",
    quantity_limits: { total_input_tokens: "100", output_tokens: "40" },
    limit_reference: "Synthetic provider contract, not a real model limit",
  };
  function upstream(
    stream: boolean,
    counters: Record<string, unknown> = usage(),
  ) {
    const data = {
      responseId: "synthetic-gemini",
      modelVersion: "gpt-4o",
      candidates: [
        {
          content: { parts: [{ text: "synthetic answer" }] },
          finishReason: "STOP",
        },
      ],
      usageMetadata: counters,
    };
    return stream
      ? new Response(
          `data: ${JSON.stringify(data)}\n\ndata: ${JSON.stringify({ ...data, candidates: [] })}\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        )
      : new Response(JSON.stringify(data), {
          headers: { "content-type": "application/json" },
        });
  }
  const request = (path = "/v1/chat/completions", stream = false) =>
    h.agent
      .post(path)
      .set("Authorization", `Bearer ${API_KEY}`)
      .send({
        model: "gpt-4o",
        max_tokens: 20,
        stream,
        ...(path === "/v1/responses"
          ? { input: "synthetic" }
          : { messages: [{ role: "user", content: "synthetic" }] }),
      });
  async function cost() {
    const logs = (await h.agent.get("/api/dashboard/logs")).body.data;
    const result = await h.agent.get(
      `/api/dashboard/logs/${logs[0].id}/cost-breakdown`,
    );
    expect(result.status).toBe(200);
    return result.body;
  }

  it.each([
    ["/v1/chat/completions", "chat_completions", false],
    ["/v1/chat/completions", "chat_completions", true],
    ["/v1/responses", "responses", false],
    ["/v1/responses", "responses", true],
    ["/v1/messages", "messages", false],
    ["/v1/messages", "messages", true],
  ] as const)(
    "settles %s (%s, stream=%s) from the same native Gemini receipt, with positive declared-limit reservations",
    async (path, operation, stream) => {
      const identity = await publish(operation);
      await policy(caps, operation);
      let hold: string | undefined;
      h.fetchMock.setHandler(async () => {
        hold = (
          await db.query("SELECT reserved_cost_usd FROM pricing_reservations")
        )[0].reserved_cost_usd;
        expect(h.fetchMock.calls.at(-1)?.url).toContain(
          stream ? ":streamGenerateContent" : ":generateContent",
        );
        return upstream(stream);
      });
      const result = await request(path, stream);
      expect({ status: result.status, body: result.body }).toMatchObject({
        status: 200,
      });
      expect(JSON.stringify(result.body)).not.toContain("adapter_id");
      // Independent per-dimension caps conservatively over-reserve; they are not actual partitions.
      expect(hold).toBe("0.003690000000000000");
      const summary = await cost();
      expect(summary.amount).toBe("0.000754000000000000");
      expect(summary.budget_committed_usd).toBe(summary.amount);
      expect(summary.budget_reserved_usd).toBe("0.000000000000000000");
      expect(summary.provider_attempts).toBe(1);
      const receipt = summary.attempts[0].cost;
      expect(receipt.version_id).toBe(identity.versionId);
      expect(receipt.usage.adapter_id).toBe("gemini-generate-content");
      expect(
        receipt.usage.quantities.uncached_audio_input_tokens,
      ).toMatchObject({ value: "20", quality: "observed" });
      expect(receipt.usage.quantities.image_output_tokens).toMatchObject({
        value: "5",
        quality: "observed",
      });
      expect(receipt.usage.quantities.audio_output_tokens).toMatchObject({
        value: "15",
        quality: "observed",
        subset_of: "output_tokens",
      });
      expect(
        receipt.lines.map((line: { dimension: string }) => line.dimension),
      ).toEqual(tariff().billing_dimensions);
      expect(summary.reservations[0].admission.guarantee).toBe(
        "conditional_on_declared_limits",
      );
      const before = await db.query("SELECT * FROM pricing_settlement_intents");
      const replay = await h.agent
        .post(`${base}/replay`)
        .send({ request_ids: [summary.request_id], content: tariff() });
      expect(replay.status).toBe(201);
      expect(replay.body.results[0].simulations[0].simulated.amount).toBe(
        "0.000754000",
      );
      const report = await h.agent
        .get(`${base}/cost-report`)
        .query({
          from: new Date(Date.now() - 60000).toISOString(),
          to: new Date(Date.now() + 60000).toISOString(),
        });
      expect(report.status).toBe(200);
      expect(
        report.body.rows.find(
          (row: { request_id: string }) =>
            row.request_id === summary.request_id,
        ),
      ).toMatchObject({
        basis: "immutable_ledger",
        amount_usd: "0.000754000000000000",
        status: "priced",
      });
      expect(
        await db.query("SELECT * FROM pricing_settlement_intents"),
      ).toEqual(before);
      expect(h.fetchMock.calls).toHaveLength(1);
    },
  );

  it("rejects missing reservation bounds before dispatch rather than reserving unknown modality fees as zero", async () => {
    await publish();
    await policy({ mode: "reserve_upper_bound" });
    expect((await request()).status).toBe(422);
    await policy({ mode: "reject_unpriced" });
    expect((await request()).status).toBe(422);
    expect(h.fetchMock.calls).toHaveLength(0);
    expect(await db.query("SELECT * FROM pricing_reservations")).toEqual([]);
  });

  it("records explicit native usage from a failed upstream attempt rather than discarding its cost", async () => {
    await publish();
    await policy(caps);
    h.fetchMock.setHandler(
      async () =>
        new Response(
          JSON.stringify({
            error: { message: "Synthetic rejection", code: 400 },
            usageMetadata: usage(),
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
    );
    expect((await request()).status).toBeGreaterThanOrEqual(400);
    const summary = await cost();
    expect(summary.attempts[0].cost.usage.adapter_id).toBe(
      "gemini-generate-content",
    );
    expect(summary.amount).toBe("0.000754000000000000");
    // The existing explicitly labeled legacy budget releases failed requests;
    // it must not erase their independently retained upstream expense.
    expect(summary.budget_committed_usd).toBe("0.000000000000000000");
    expect(summary.reservations[0]).toMatchObject({ state: "released", budget_basis: "legacy_logical" });
    expect(h.fetchMock.calls).toHaveLength(1);
  });

  it.each(["absent", "invalid", "cache-allocation", "thoughts"])(
    "preserves valid model output but keeps %s native evidence incomplete",
    async (kind) => {
      await publish();
      await policy(caps);
      const raw: Record<string, unknown> = usage();
      if (kind === "absent") delete raw.candidatesTokensDetails;
      if (kind === "invalid")
        raw.candidatesTokensDetails = [{ modality: "AUDIO", tokenCount: -1 }];
      if (kind === "cache-allocation") delete raw.cacheTokensDetails;
      if (kind === "thoughts") {
        raw.thoughtsTokenCount = 10;
        raw.totalTokenCount = 140;
      }
      h.fetchMock.setHandler(async () => upstream(false, raw));
      expect((await request()).status).toBe(200);
      const summary = await cost();
      expect(summary.amount).toBeNull();
      expect(summary.attempts[0].cost.evidence_status).toBe("incomplete");
      expect(summary.attempts[0].cost.status).not.toBe("free");
      expect(h.fetchMock.calls).toHaveLength(1);
    },
  );

  it.each([false, true])(
    "includes thinking exactly once in aggregate output and numeric logs (stream=%s)",
    async (stream) => {
      await publish(
        "chat_completions",
        book([rate("output", "output_tokens", "1")]),
      );
      await policy({
        ...caps,
        quantity_limits: { total_input_tokens: "100", output_tokens: "100" },
      });
      h.fetchMock.setHandler(async () =>
        upstream(stream, {
          ...usage(),
          thoughtsTokenCount: 50,
          totalTokenCount: 180,
        }),
      );
      expect((await request("/v1/chat/completions", stream)).status).toBe(200);
      const summary = await cost();
      expect(summary.amount).toBe("0.000080000000000000");
      expect(
        summary.attempts[0].cost.usage.quantities.output_tokens.value,
      ).toBe("80");
      expect(
        summary.attempts[0].cost.usage.quantities.reasoning_output_tokens.value,
      ).toBe("50");
      const logs = (await h.agent.get("/api/dashboard/logs")).body.data;
      expect(logs[0].output_tokens).toBe(80);
    },
  );
});

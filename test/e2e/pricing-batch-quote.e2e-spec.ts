import { request as httpRequest } from "node:http";
import { AsyncResource } from "node:async_hooks";
import { EmbeddingBatchingService } from "../../src/pipeline/embedding-batching.service";
import { PipelineService } from "../../src/pipeline/pipeline.service";
import { CircuitBreakerService } from "../../src/routing/circuit-breaker.service";
import { ConfigService } from "../../src/config/config.service";
import { API_KEY } from "./setup";
import { DataSource } from "typeorm";
import { createE2EHarness, type E2EHarness } from "./setup";
import { applyPricingSchema } from "../../src/pricing/pricing-schema";
import { tokenBook, book, rate } from "../unit/pricing-fixtures";
import { ExactDecimal } from "../../src/pricing/exact-decimal";

describe("pure batch pricing/allocation over isolated HTTP", () => {
  let harness: E2EHarness, source: DataSource;
  beforeEach(async () => {
    harness = await createE2EHarness();
    source = harness.app.get(DataSource);
    await applyPricingSchema(source);
  }, 30000);
  afterEach(async () => {
    jest.restoreAllMocks();
    await harness?.close();
  });
  const path = "/api/dashboard/pricing/batch/quote";
  const members = ["a", "b", "c"].map((id) => ({
    id,
    input_count: 1,
    weight: "1",
    weight_basis: "text_token_estimate",
  }));
  const evidence = (input: string) =>
    [
      "total_input_tokens",
      "uncached_input_tokens",
      "output_tokens",
      "cache_read_tokens",
      "cache_write_tokens",
      "cache_write_5m_tokens",
      "cache_write_1h_tokens",
    ].map((dimension) => ({
      dimension,
      value: dimension.includes("input_tokens") ? input : "0",
      source: "request_metadata",
      quality: "observed",
    }));
  const sum = (values: string[]) =>
    values
      .reduce(
        (sum, value) => sum.add(ExactDecimal.parse(value)),
        ExactDecimal.zero,
      )
      .toFixed(18);

  // These allocation/cancellation cases need an actual shared invocation, not
  // an assumption about HTTP/auth/budget scheduling completing inside 15ms.
  // Keep the real queue, timer, provider path and each request's async context.
  const enterQueueTogether = (count: number) => {
    const batcher = harness.app.get(EmbeddingBatchingService);
    const enqueue = batcher.enqueue.bind(batcher);
    const waiting: Array<() => void> = [];
    let released = false;
    return jest.spyOn(batcher, "enqueue").mockImplementation((...args) => {
      if (released || args[5]?.signal?.aborted) return enqueue(...args);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () =>
            reject(
              new Error(
                "Expected member did not reach the isolated enqueue barrier",
              ),
            ),
          2000,
        );
        waiting.push(
          AsyncResource.bind(() => {
            clearTimeout(timer);
            enqueue(...args).then(resolve, reject);
          }),
        );
        if (waiting.length === count) {
          released = true;
          for (const start of waiting.splice(0)) start();
        }
      });
    });
  };

  it("prices the physical 300k invocation in the long-context tier before exact allocation, without writes or model calls", async () => {
    const content = tokenBook();
    content.groups.push({
      id: "large",
      order: 1,
      required: false,
      rules: [
        {
          id: "over-272k",
          priority: 0,
          mode: "whole_request",
          condition: { input_tokens: { min: "272001" } },
          rates: [
            {
              operation: "replace",
              component: rate("large-input", "uncached_input_tokens", "2"),
            },
          ],
        },
      ],
    });
    const result = await harness.agent
      .post(path)
      .send({ quote: { content, evidence: evidence("300000") }, members });
    expect(result.status).toBe(201);
    expect(result.body.simulation).toBe(true);
    expect(result.body.allocation.physical_cost.amount).toBe("0.600000000");
    expect(
      result.body.allocation.shares.map(
        (share: { amount: string }) => share.amount,
      ),
    ).toEqual([
      "0.200000000000000000",
      "0.200000000000000000",
      "0.200000000000000000",
    ]);
    for (const table of [
      "pricing_books",
      "pricing_request_snapshots",
      "pricing_attempts",
      "pricing_reservations",
      "pricing_settlement_intents",
      "pricing_audit_events",
    ])
      expect(await source.query(`SELECT * FROM ${table}`)).toHaveLength(0);
    expect(harness.fetchMock.calls).toHaveLength(0);
  });

  it("allocates source/report currencies separately with explicit synthetic FX and rejects unknown body fields", async () => {
    const content = book([rate("input", "uncached_input_tokens", "7", "1")]);
    content.currency = "CNY";
    const quote = {
      content,
      evidence: evidence("1"),
      report_currency: "USD",
      fx: {
        version_id: "synthetic",
        source: "fixture",
        effective_at: "2026-01-01T00:00:00Z",
        from_currency: "CNY",
        to_currency: "USD",
        numerator: "1",
        denominator: "7",
      },
    };
    const result = await harness.agent.post(path).send({ quote, members });
    expect(result.status).toBe(201);
    expect(
      sum(
        result.body.allocation.shares.map(
          (share: { amount: string }) => share.amount,
        ),
      ),
    ).toBe("7.000000000000000000");
    expect(
      sum(
        result.body.allocation.shares.map(
          (share: { report_amount: string }) => share.report_amount,
        ),
      ),
    ).toBe("1.000000000000000000");
    expect(
      (
        await harness.agent
          .post(path)
          .send({ quote, members, workspace_id: "other" })
      ).status,
    ).toBe(400);
    expect(
      (
        await harness.agent
          .post(path)
          .send({ quote, members: [members[0], members[0]] })
      ).status,
    ).toBe(400);
    expect(
      (
        await harness.agent
          .post(path)
          .send({ quote, members: [{ ...members[0], weight: "0" }] })
      ).status,
    ).toBe(400);
    expect(
      (await harness.agent.post(path).send({ quote, members: [] })).status,
    ).toBe(400);
  });

  it("keeps three actual legacy embedding requests within their upstream total, including zero shares", async () => {
    enterQueueTogether(3);
    const config = harness.app.get(ConfigService);
    jest.spyOn(config, "embeddingBatching", "get").mockReturnValue({
      enabled: true,
      window_ms: 15,
      max_batch_size: 3,
      max_input_items: 4,
      max_queue: 100,
      timeout_ms: 1000,
    });
    harness.fetchMock.setHandler(
      async () =>
        new Response(
          JSON.stringify({
            id: "synthetic-batch",
            model: "text-embedding-3-small",
            data: [0, 1, 2].map((index) => ({ index, embedding: [index] })),
            usage: { prompt_tokens: 2, total_tokens: 2 },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    const results = await Promise.all(
      [0, 1, 2].map((index) =>
        harness.agent
          .post("/v1/embeddings")
          .set("Authorization", `Bearer ${API_KEY}`)
          .send({ model: "text-embedding-3-small", input: `abcd${index}` }),
      ),
    );
    expect(results.map((result) => result.status)).toEqual([200, 200, 200]);
    expect(harness.fetchMock.calls).toHaveLength(1);
    expect(
      results.map((result) => result.body.usage.prompt_tokens).sort(),
    ).toEqual([0, 1, 1]);
    expect(results.map((result) => result.body.data[0].embedding[0])).toEqual([
      0, 1, 2,
    ]);
  });

  it("does not let one real client cancellation abort a surviving member’s shared embedding request", async () => {
    const enqueued = enterQueueTogether(2);
    const pipeline = harness.app.get(PipelineService);
    const process = pipeline.processEmbeddings.bind(pipeline);
    const failure = jest.spyOn(
      harness.app.get(CircuitBreakerService),
      "recordFailure",
    );
    let cancelledStatus: number | undefined;
    let drained!: () => void;
    const cancelledDone = new Promise<void>((resolve) => {
      drained = resolve;
    });
    jest
      .spyOn(pipeline, "processEmbeddings")
      .mockImplementation(async (...args) => {
        try {
          const result = await process(...args);
          if (args[0].input === "aaaa") cancelledStatus = result.statusCode;
          return result;
        } finally {
          if (args[0].input === "aaaa") drained();
        }
      });
    const config = harness.app.get(ConfigService);
    jest.spyOn(config, "embeddingBatching", "get").mockReturnValue({
      enabled: true,
      window_ms: 40,
      max_batch_size: 2,
      max_input_items: 4,
      max_queue: 100,
      timeout_ms: 1000,
    });
    let dispatched!: () => void;
    const started = new Promise<void>((resolve) => {
      dispatched = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let providerSignal: AbortSignal | null | undefined;
    harness.fetchMock.setHandler(async (_url, init) => {
      providerSignal = init.signal;
      dispatched();
      await gate;
      if (init.signal?.aborted)
        throw new DOMException("synthetic aborted batch", "AbortError");
      return new Response(
        JSON.stringify({
          id: "shared",
          model: "text-embedding-3-small",
          data: [
            { index: 0, embedding: [0] },
            { index: 1, embedding: [1] },
          ],
          usage: { prompt_tokens: 10, total_tokens: 10 },
        }),
        { headers: { "content-type": "application/json" } },
      );
    });
    const address = harness.app.getHttpServer().address();
    if (!address || typeof address === "string" || address.port === 2099)
      throw new Error("Invalid isolated port");
    const cancelled = httpRequest({
      host: "127.0.0.1",
      port: address.port,
      path: "/v1/embeddings",
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "content-type": "application/json",
      },
    });
    cancelled.on("error", () => undefined);
    cancelled.end(
      JSON.stringify({ model: "text-embedding-3-small", input: "aaaa" }),
    );
    const remaining = harness.agent
      .post("/v1/embeddings")
      .set("Authorization", `Bearer ${API_KEY}`)
      .send({ model: "text-embedding-3-small", input: "bbbb" })
      .then((response) => response);
    try {
      await started;
      cancelled.destroy();
      await cancelledDone;
      expect(providerSignal?.aborted).toBe(false);
      release();
      const result = await remaining;
      expect(result.status).toBe(200);
      expect(result.body.usage.prompt_tokens).toBe(5);
      expect(harness.fetchMock.calls).toHaveLength(1);
      expect(enqueued).toHaveBeenCalledTimes(2);
      expect(cancelledStatus).toBe(499);
      expect(failure).not.toHaveBeenCalled();
    } finally {
      cancelled.destroy();
      release();
      await remaining;
      await cancelledDone;
    }
  });

  it("preserves provider-declared zero usage through the actual embedding pipeline", async () => {
    const config = harness.app.get(ConfigService);
    jest.spyOn(config, "embeddingBatching", "get").mockReturnValue({
      enabled: true,
      window_ms: 5,
      max_batch_size: 3,
      max_input_items: 4,
      max_queue: 100,
      timeout_ms: 1000,
    });
    harness.fetchMock.setHandler(
      async () =>
        new Response(
          JSON.stringify({
            id: "zero",
            model: "text-embedding-3-small",
            data: [{ index: 0, embedding: [0] }],
            usage: { prompt_tokens: 0, total_tokens: 0 },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    const result = await harness.agent
      .post("/v1/embeddings")
      .set("Authorization", `Bearer ${API_KEY}`)
      .send({
        model: "text-embedding-3-small",
        input: "nonempty synthetic input",
      });
    expect(result.status).toBe(200);
    expect(result.body.usage.prompt_tokens).toBe(0);
  });

  it("conserves usage per physical call when arrivals miss the batch window", async () => {
    jest
      .spyOn(harness.app.get(ConfigService), "embeddingBatching", "get")
      .mockReturnValue({
        enabled: true,
        window_ms: 5,
        max_batch_size: 3,
        max_input_items: 4,
        max_queue: 100,
        timeout_ms: 1000,
      });
    harness.fetchMock.setHandler(
      async () =>
        new Response(
          JSON.stringify({
            model: "text-embedding-3-small",
            data: [{ index: 0, embedding: [1] }],
            usage: { prompt_tokens: 2, total_tokens: 2 },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    const responses = [];
    for (const input of ["first-window", "next-window"])
      responses.push(
        await harness.agent
          .post("/v1/embeddings")
          .set("Authorization", `Bearer ${API_KEY}`)
          .send({ model: "text-embedding-3-small", input }),
      );
    expect(responses.map((result) => result.status)).toEqual([200, 200]);
    expect(harness.fetchMock.calls).toHaveLength(2);
    expect(responses.map((result) => result.body.usage.prompt_tokens)).toEqual([
      2, 2,
    ]);
    expect(
      responses.reduce(
        (total, result) => total + result.body.usage.prompt_tokens,
        0,
      ),
    ).toBe(2 * harness.fetchMock.calls.length);
  });

  it("cannot use batch simulation to access a foreign draft or bypass origin checks", async () => {
    const created = await harness.agent
      .post("/api/dashboard/pricing/books")
      .send({ name: "Owned fixture", content: tokenBook() });
    expect(created.status).toBe(201);
    await source
      .createQueryBuilder()
      .update("pricing_books")
      .set({ workspace_id: "foreign-workspace" })
      .where("id = :id", { id: created.body.book.id })
      .execute();
    const result = await harness.agent.post(path).send({
      quote: { draft_id: created.body.draft.id, evidence: evidence("3") },
      members,
    });
    expect(result.status).toBe(404);
    expect(
      (
        await harness.agent
          .post(path)
          .set("Origin", "https://foreign.invalid")
          .send({
            quote: { content: tokenBook(), evidence: evidence("3") },
            members,
          })
      ).status,
    ).toBe(403);
    expect(harness.fetchMock.calls).toHaveLength(0);
  });
});

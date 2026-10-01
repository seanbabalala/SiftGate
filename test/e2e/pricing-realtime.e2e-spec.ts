import { pricingContentHash } from '../../src/pricing/pricing-json';
import { DataSource } from "typeorm";
import { createE2EHarness, E2EHarness, API_KEY } from "./setup";
import { createHash } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket } from "undici";
import { ConfigService } from "../../src/config/config.service";
import { RealtimeProxyService } from "../../src/realtime/realtime-proxy.service";
import { PricingRecoveryService } from "../../src/pricing/pricing-recovery.service";
import { RealtimePricingService } from "../../src/pricing/realtime-pricing.service";
import { realtimePricingEvent } from "../../src/pricing/realtime-metering";
import { applyPricingSchema } from "../../src/pricing/pricing-schema";
import { CostLedgerService } from "../../src/pricing/cost-ledger.service";
import { book, rate } from "../unit/pricing-fixtures";
import type { GatewayApiKeyContext } from "../../src/auth/gateway-api-key.service";
import type { PriceBookContent } from "../../src/pricing/pricing.types";

const base = "/api/dashboard/pricing";
const key = {
  id: "synthetic",
  name: "synthetic",
  workspace_id: "default-workspace",
  namespace_id: null,
} as GatewayApiKeyContext;
const done = (id: string, tokens = 10, status = "completed") =>
  realtimePricingEvent(
    JSON.stringify({
      type: "response.done",
      response: {
        id,
        status,
        usage: {
          input_tokens: 0,
          output_tokens: tokens,
          total_tokens: tokens,
          input_token_details: { cached_tokens: 0 },
          output_token_details: { text_tokens: tokens, audio_tokens: 0 },
        },
      },
    }),
  )!;
describe("Realtime frozen accounting on isolated real storage", () => {
  let h: E2EHarness, db: DataSource, pricing: RealtimePricingService;
  beforeEach(async () => {
    h = await createE2EHarness();
    await h.app.get(PricingRecoveryService).onModuleDestroy();
    db = h.app.get(DataSource);
    await applyPricingSchema(db);
    pricing = h.app.get(RealtimePricingService);
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await h?.close();
  });
  async function publish(
    price = "0.01",
    extra = false,
    model = "synthetic-realtime",
    override?: PriceBookContent,
  ) {
    const content =
      override ??
      book([
        rate("output", "output_tokens", price, "1"),
        ...(extra ? [rate("session", "session_seconds", "0.01", "1")] : []),
      ]);
    content.allow_combined_media = extra;
    const created = await h.agent
      .post(`${base}/books`)
      .send({ name: "Synthetic realtime", content });
    expect(created.status).toBe(201);
    const revision = (await h.agent.get(`${base}/bindings`)).body.head.revision;
    const result = await h.agent
      .post(`${base}/drafts/${created.body.draft.id}/publish`)
      .send({
        draft_revision: 1,
        catalog_revision: revision,
        targets: [
          {
            level: "model",
            model,
            operation: "realtime",
          },
        ],
        reason: "Synthetic only",
        ...(content.time_basis && content.time_basis !== 'attempt_dispatched_at' ? { time_basis_confirmation: { basis: content.time_basis, content_hash: pricingContentHash(content), reference: 'SYNTHETIC-TIMING-CONTRACT', confirmed: true as const } } : {}), confirm: true,
      });
    expect(result.status).toBe(201);
    return result.body.version_id;
  }
  async function policy() {
    const revision = (await h.agent.get(`${base}/admission-policies`)).body.head
      .revision;
    const result = await h.agent.put(`${base}/admission-policy`).send({
      catalog_revision: revision,
      scope: "workspace",
      operation: "realtime",
      reason: "Synthetic limits",
      confirm: true,
      policy: {
        mode: "reserve_upper_bound",
        realtime_max_responses: 2,
        quantity_limits: {
          total_input_tokens: "100",
          output_tokens: "40",
          session_seconds: "60",
        },
        limit_reference: "Synthetic contract",
      },
    });
    expect(result.status).toBe(200);
  }
  const begin = (id = "realtime-test") =>
    pricing.begin(id, key, "mock-openai", "synthetic-realtime", 60000);
  const summary = (id = "realtime-test") =>
    h.app.get(CostLedgerService).summary(id, key.workspace_id);

  it("freezes session duration at transport close, before waiting for queued accounting", async () => {
    await publish("0.01", true);
    await policy();
    const session = (await begin())!;
    const clock = jest
      .spyOn(process.hrtime, "bigint")
      .mockReturnValue(1000000000n);
    session.opened();
    clock.mockRestore();
    await session.observe(done("a"));
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const closingClock = jest
      .spyOn(process.hrtime, "bigint")
      .mockReturnValue(3000000000n);
    const closing = session.close(false, pending);
    closingClock.mockReturnValue(20000000000n);
    expect(session.close(true)).toBe(closing);
    release();
    await closing;
    closingClock.mockRestore();
    const result = (await summary())!;
    expect(result.amount).toBe("0.120000000000000000");
    expect(
      result.attempts.find((row) => row.fee_source === "synthetic")!.cost!.usage
        .quantities.session_seconds?.value,
    ).toBe("2");
  });

  it("does not call a request-count-only tariff free when outstanding model responses are unknown", async () => {
    await publish(
      "0.01",
      false,
      "synthetic-realtime",
      book([rate("response", "request_count", "0.01", "1")]),
    );
    await policy();
    const session = (await begin())!;
    session.dispatched();
    session.opened();
    session.clientActivity();
    await session.close(true);
    const result = (await summary())!;
    expect(result.amount).toBeNull();
    expect(result.status).not.toBe("free");
    expect(result.budget_reserved_usd).toBe("0.030000000000000000");
    expect(
      result.attempts[0].cost!.usage.quantities.request_count?.value,
    ).toBeNull();
  });

  it.each([
    "queued-before-new-input",
    "duplicate-created",
    "late-created-after-done",
  ])("does not let %s acknowledge later client work", async (scenario) => {
    await publish();
    await policy();
    const session = (await begin())!;
    session.dispatched();
    session.opened();
    session.clientActivity();
    const created = realtimePricingEvent(
      '{"type":"response.created","response":{"id":"old"}}',
    )!;
    const oldObservation = session.observation();
    if (scenario === "duplicate-created")
      await session.observe(created, oldObservation);
    if (scenario === "late-created-after-done")
      await session.observe(done("old"), oldObservation);
    session.clientActivity();
    await session.observe(
      created,
      scenario === "queued-before-new-input"
        ? oldObservation
        : session.observation(),
    );
    await session.observe(done("old"));
    await session.close(false);
    expect((await summary())!.amount).toBeNull();
    expect((await summary())!.budget_reserved_usd).toBe("1.200000000000000000");
  });

  it("uses transport observation timestamps for calendar selection and preserves estimated clocks in replay", async () => {
    const content = book([rate("output", "output_tokens", "0.01", "1")]);
    content.time_basis = "completed_at";
    content.calendar = {
      schema_version: 1,
      version_id: "synthetic-clock",
      time_zone: "UTC",
      tzdb_version: process.versions.tz!,
      valid_from: "2026-01-01",
      valid_to: "2027-01-01",
      default_tag: "day",
      weekly: [],
      holidays: [],
      date_overrides: [],
    };
    content.groups[0].rules[0].condition.time_tags = ["day"];
    await publish("0.01", false, "synthetic-realtime", content);
    await policy();
    const session = (await begin())!;
    session.opened();
    const at = session.observation();
    await session.observe(done("a"), at);
    await session.close(false);
    const result = (await summary())!;
    const response = result.attempts.find(
      (row) => row.fee_source === "provider",
    )!;
    expect(response.dispatched_at).toBe(at.at);
    expect(response.cost!.selection!.calendar_match!.instant).toBe(at.at);
    expect(response.cost!.evidence_status).toBe("estimated");
    const replay = await h.agent
      .post(`${base}/replay`)
      .send({ request_ids: [result.request_id], content });
    expect(replay.status).toBe(201);
    const simulated = replay.body.results[0].simulations.find(
      (row: { attempt_id: string }) => row.attempt_id === response.id,
    ).simulated;
    expect(simulated.evidence_status).toBe("estimated");
    expect(simulated.amount).toBe(response.cost!.amount);
  });

  it("returns structured HTTP rejection before upgrading or contacting a supplier when strict caps are missing", async () => {
    await publish("0.01", false, "gpt-4o-realtime-preview");
    const revision = (await h.agent.get(`${base}/admission-policies`)).body.head
      .revision;
    await h.agent.put(`${base}/admission-policy`).send({
      catalog_revision: revision,
      scope: "workspace",
      operation: "realtime",
      reason: "Synthetic",
      confirm: true,
      policy: { mode: "reserve_upper_bound" },
    });
    h.app.get(ConfigService).getNode("mock-openai")!.realtime_endpoint =
      "ws://127.0.0.1:1/forbidden-test-target";
    const port = h.app.getHttpServer().address().port;
    const result = await new Promise<{ status: number; body: string }>(
      (resolve, reject) => {
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port,
            path: "/v1/realtime?model=gpt-4o-realtime-preview",
            headers: {
              Authorization: `Bearer ${API_KEY}`,
              Connection: "Upgrade",
              Upgrade: "websocket",
              "Sec-WebSocket-Key":
                Buffer.from("synthetic-16byte!").toString("base64"),
              "Sec-WebSocket-Version": "13",
            },
          },
          (res) => {
            let body = "";
            res.on("data", (chunk) => (body += chunk));
            res.on("end", () => resolve({ status: res.statusCode!, body }));
          },
        );
        req.on("upgrade", (_res, socket) => {
          socket.destroy();
          reject(Error("Pricing rejection upgraded unexpectedly"));
        });
        req.on("error", reject);
        req.setTimeout(2000, () => {
          req.destroy();
          reject(Error("No pricing rejection"));
        });
        req.end();
      },
    );
    expect(result.status).toBe(422);
    expect(JSON.parse(result.body).error.code).toBe(
      "realtime_pricing_admission_failed",
    );
    expect(await db.query("SELECT * FROM pricing_reservations")).toHaveLength(
      0,
    );
  });

  it("prices the actual loopback WebSocket bridge and drains its accounting before shutdown", async () => {
    const model = "gpt-4o-realtime-preview";
    await publish("0.01", false, model);
    await policy();
    const upstream = createServer();
    let peer: Duplex | undefined,
      client: InstanceType<typeof WebSocket> | undefined,
      opens = 0;
    const frame = (data: unknown) => {
      const body = Buffer.from(JSON.stringify(data));
      const header =
        body.length < 126
          ? Buffer.from([0x81, body.length])
          : Buffer.from([0x81, 126, body.length >> 8, body.length & 255]);
      return Buffer.concat([header, body]);
    };
    upstream.on("upgrade", (request, socket) => {
      opens++;
      peer = socket;
      socket.on("error", () => undefined);
      const accept = createHash("sha1")
        .update(
          String(request.headers["sec-websocket-key"]) +
            "258EAFA5-E914-47DA-95CA-C5AB0DC85B11",
        )
        .digest("base64");
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      socket.once("data", () => {
        const response = {
          id: "wire-response",
          metadata: { correlation: "synthetic-wire-request" },
          status: "completed",
          usage: {
            input_tokens: 0,
            output_tokens: 10,
            total_tokens: 10,
            input_token_details: { cached_tokens: 0 },
          },
        };
        socket.write(
          Buffer.concat([
            frame({ type: "response.created", response: { id: response.id, metadata: response.metadata } }),
            frame({ type: "response.done", response }),
            frame({ type: "response.done", response }),
            frame({ type: "fixture.finished" }),
          ]),
        );
      });
    });
    try {
      await new Promise<void>((resolve) =>
        upstream.listen(0, "127.0.0.1", resolve),
      );
      const address = upstream.address();
      if (!address || typeof address === "string" || address.port === 2099)
        throw Error("Unsafe mock port");
      h.app.get(ConfigService).getNode("mock-openai")!.realtime_endpoint =
        `ws://127.0.0.1:${address.port}/realtime`;
      const port = h.app.getHttpServer().address().port;
      expect(port).not.toBe(2099);
      client = new WebSocket(
        `ws://127.0.0.1:${port}/v1/realtime?model=${model}`,
        { headers: { Authorization: `Bearer ${API_KEY}` } },
      );
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(Error("WebSocket open timed out")),
          3000,
        );
        client!.addEventListener(
          "open",
          () => {
            clearTimeout(timeout);
            resolve();
          },
          { once: true },
        );
        client!.addEventListener(
          "error",
          () => {
            clearTimeout(timeout);
            reject(Error("Unexpected WebSocket admission failure"));
          },
          { once: true },
        );
      });
      const finished = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(Error("Mock response timed out")),
          3000,
        );
        client!.addEventListener("message", (event) => {
          if (
            typeof event.data === "string" &&
            event.data.includes("fixture.finished")
          ) {
            clearTimeout(timeout);
            resolve();
          }
        });
      });
      client.send('{"type":"response.create","response":{"metadata":{"correlation":"synthetic-wire-request"}}}');
      await finished;
      const requestId = h.app
        .get(RealtimeProxyService)
        .getStatus(key.workspace_id).recent[0].request_id;
      const closed = new Promise<void>((resolve) =>
        client!.addEventListener("close", () => resolve(), { once: true }),
      );
      client.close(1000);
      await closed;
      await h.app.get(RealtimeProxyService).onModuleDestroy();
      const result = (await summary(requestId))!;
      expect(opens).toBe(1);
      expect(result.amount).toBe("0.100000000000000000");
      expect(result.provider_attempts).toBe(1);
      expect(result.budget_reserved_usd).toBe("0.000000000000000000");
      expect(result.budget_committed_usd).toBe(result.amount);
      const report = await h.agent.get(`${base}/cost-report`).query({
        from: new Date(Date.now() - 60000).toISOString(),
        to: new Date(Date.now() + 60000).toISOString(),
      });
      expect(report.status).toBe(200);
      expect(
        report.body.rows.some(
          (row: { request_id: string }) => row.request_id === requestId,
        ),
      ).toBe(true);
    } finally {
      client?.close();
      peer?.destroy();
      if (upstream.listening)
        await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  }, 15000);

  it("freezes prices, reserves before connect and sums each response once", async () => {
    const version = await publish();
    await policy();
    const session = (await begin())!;
    session.opened();
    expect((await summary())!.budget_reserved_usd).toBe("1.200000000000000000");
    expect(await session.observe(done("a"))).toBe(true);
    expect(await session.observe(done("a"))).toBe(true);
    await publish("9");
    expect(await session.observe(done("b", 5, "cancelled"))).toBe(true);
    await session.close(false);
    await session.close(false);
    const result = (await summary())!;
    expect(result.amount).toBe("0.150000000000000000");
    expect(result.budget_committed_usd).toBe(result.amount);
    expect(result.budget_reserved_usd).toBe("0.000000000000000000");
    expect(result.provider_attempts).toBe(2);
    expect(
      result.attempts.every((row) => row.cost?.version_id === version),
    ).toBe(true);
    expect(h.fetchMock.calls).toHaveLength(0);
  });
  it("keeps missing response usage and excess responses pending rather than releasing them as free", async () => {
    await publish();
    await policy();
    const session = (await begin())!;
    session.opened();
    await session.observe(done("a"));
    await session.observe(done("b"));
    expect(await session.observe(done("c"))).toBe(false);
    await session.close(false);
    const result = (await summary())!;
    expect(result.amount).toBeNull();
    expect(result.budget_reserved_usd).toBe("1.200000000000000000");
    expect(result.budget_committed_usd).toBe("0.000000000000000000");
    expect(result.provider_attempts).toBe(3); // The first over-limit reported receipt is preserved, not discarded.
  });

  it("keeps an unacknowledged client dispatch unresolved even on a clean client close", async () => {
    await publish();
    await policy();
    const session = (await begin())!;
    session.dispatched();
    session.opened();
    session.clientActivity();
    await session.close(false);
    const result = (await summary())!;
    expect(result.amount).toBeNull();
    expect(result.budget_reserved_usd).toBe("1.200000000000000000");
  });
  it("retains conflicting duplicate receipts for review without replacing the first fee", async () => {
    await publish();
    await policy();
    const session = (await begin())!;
    session.opened();
    await session.observe(done("a"));
    expect(await session.observe(done("a", 20))).toBe(false);
    await session.close(false);
    const result = (await summary())!;
    expect(
      result.attempts.find((row) => row.fee_source === "provider")!.cost!
        .amount,
    ).toBe("0.100000000");
    expect(result.amount).toBeNull();
    expect(
      (
        await db.query(
          "SELECT * FROM pricing_runtime_outcomes WHERE state = 'review_required'",
        )
      ).length,
    ).toBeGreaterThan(0);
  });
  it("rejects a strict session without declared caps before an upstream connection or reservation", async () => {
    await publish();
    const revision = (await h.agent.get(`${base}/admission-policies`)).body.head
      .revision;
    await h.agent.put(`${base}/admission-policy`).send({
      catalog_revision: revision,
      scope: "workspace",
      operation: "realtime",
      reason: "Synthetic",
      confirm: true,
      policy: { mode: "reserve_upper_bound" },
    });
    await expect(begin()).rejects.toMatchObject({ statusCode: 422 });
    expect(await db.query("SELECT * FROM pricing_reservations")).toHaveLength(
      0,
    );
  });
  it("recovers a durable failed settlement without a second model response or duplicate budget debit", async () => {
    await publish();
    await policy();
    const session = (await begin())!;
    session.opened();
    await session.observe(done("a"));
    const ledger = h.app.get(CostLedgerService);
    jest
      .spyOn(ledger, "applySettlement")
      .mockRejectedValueOnce(new Error("Synthetic DB outage"));
    await session.close(false);
    expect((await summary())!.reservations[0].settlement_status).toBe(
      "pending",
    );
    jest.restoreAllMocks();
    await ledger.reconcilePending();
    const after = await summary();
    await ledger.reconcilePending();
    expect(await summary()).toEqual(after);
    expect(after!.budget_committed_usd).toBe("0.100000000000000000");
  });
  it("adds a separately measured session fee only when explicitly configured", async () => {
    await publish("0.01", true);
    await policy();
    const session = (await begin())!;
    const clock = jest.spyOn(process.hrtime, "bigint");
    clock.mockReturnValueOnce(1000000000n);
    session.opened();
    clock.mockRestore();
    await session.observe(done("a"));
    const closeClock = jest
      .spyOn(process.hrtime, "bigint")
      .mockReturnValue(3000000000n);
    await session.close(false);
    closeClock.mockRestore();
    const result = (await summary())!;
    expect(result.amount).toBe("0.120000000000000000");
    expect(result.provider_attempts).toBe(1);
  });
});

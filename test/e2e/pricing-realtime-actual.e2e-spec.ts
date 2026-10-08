import { DataSource } from "typeorm";
import { createE2EHarness, API_KEY, type E2EHarness } from "./setup";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import type { Duplex } from "node:stream";
import { WebSocket } from "undici";
import { ConfigService } from "../../src/config/config.service";
import { RealtimeProxyService } from "../../src/realtime/realtime-proxy.service";
import { PricingRecoveryService } from "../../src/pricing/pricing-recovery.service";
import { RealtimePricingService } from "../../src/pricing/realtime-pricing.service";
import { realtimePricingEvent } from "../../src/pricing/realtime-metering";
import { applyPricingSchema } from "../../src/pricing/pricing-schema";
import { CostLedgerService } from "../../src/pricing/cost-ledger.service";
import { BudgetService } from "../../src/budget/budget.service";
import { book, rate } from "../unit/pricing-fixtures";
import type { GatewayApiKeyContext } from "../../src/auth/gateway-api-key.service";
import type { PricingAdmissionPolicy } from "../../src/pricing/pricing-admission.types";

const base = "/api/dashboard/pricing", model = "gpt-4o-realtime-preview";
const key = { id: "synthetic", name: "synthetic", workspace_id: "default-workspace", namespace_id: null } as GatewayApiKeyContext;
const event = (body: unknown) => realtimePricingEvent(JSON.stringify(body))!;
const manual = () => event({ type: "session.updated", session: { audio: { input: { turn_detection: null, transcription: null } } } });
const created = (id: string) => event({ type: "response.created", response: { id } });
const done = (id: string, output = 10, status = "completed") => event({ type: "response.done", response: { id, status,
  usage: { input_tokens: 0, output_tokens: output, total_tokens: output, input_token_details: { cached_tokens: 0 }, output_token_details: { text_tokens: output, audio_tokens: 0 } } } });
describe("actual Realtime complete expense closure", () => {
  let h: E2EHarness, db: DataSource, pricing: RealtimePricingService;
  beforeEach(async () => { h = await createE2EHarness(); await h.app.get(PricingRecoveryService).onModuleDestroy(); db = h.app.get(DataSource); await applyPricingSchema(db); pricing = h.app.get(RealtimePricingService); });
  afterEach(async () => { jest.restoreAllMocks(); await h?.close(); });
  async function publish(content = book([rate("output", "output_tokens", "0.01", "1")])) {
    const created = await h.agent.post(`${base}/books`).send({ name: "Synthetic RT actual", content }); expect(created.status).toBe(201);
    const head = (await h.agent.get(`${base}/bindings`)).body.head;
    const published = await h.agent.post(`${base}/drafts/${created.body.draft.id}/publish`).send({ draft_revision: 1, catalog_revision: head.revision,
      reason: "Synthetic RT actual", confirm: true, targets: [{ level: "model", model, operation: "realtime" }] });
    expect(published.status).toBe(201); return published.body.version_id as string;
  }
  async function policy(extra: Partial<PricingAdmissionPolicy> = {}) {
    const head = (await h.agent.get(`${base}/admission-policies`)).body.head;
    const reply = await h.agent.put(`${base}/admission-policy`).send({ catalog_revision: head.revision, scope: "workspace", operation: "realtime", reason: "Synthetic actual RT policy", confirm: true,
      policy: { mode: "reserve_upper_bound", budget_basis: "actual_upstream", realtime_max_responses: 3,
        quantity_limits: { total_input_tokens: "100", output_tokens: "40", session_seconds: "60" }, limit_reference: "Synthetic supplier cap", ...extra } });
    expect(reply.status).toBe(200);
  }
  const begin = (id = "rt-actual") => pricing.begin(id, key, "mock-openai", model, 60000);
  const summary = (id = "rt-actual") => h.app.get(CostLedgerService).summary(id, key.workspace_id);
  async function ready() { const session = (await begin())!; await session.dispatched(); session.opened(); await session.observe(manual()); return session; }

  it.each([false, true])("does not hold a complete session forever because of non-generating controls (actual=%s)", async actual => {
    await publish(); await policy({ budget_basis: actual ? "actual_upstream" : "legacy_logical" }); const session = await ready();
    for (const type of ["conversation.item.create", "conversation.item.delete", "response.cancel", "input_audio_buffer.clear"])
      session.clientActivity(JSON.stringify({ type }));
    session.clientActivity('{"type":"response.create"}'); await session.observe(created("a")); await session.observe(done("a"));
    session.clientActivity('{"type":"session.update","session":{"instructions":"PRIVATE"}}');
    await session.close(false); const result = (await summary())!;
    expect(result.reservations[0].state).toBe("committed"); expect(result.budget_committed_usd).toBe("0.100000000000000000");
  });
  it.each([false, true])("settles a completed automatic VAD response after acknowledged buffer clear (actual=%s)", async actual => {
    await publish(); await policy({ budget_basis: actual ? "actual_upstream" : "legacy_logical" }); const session = (await begin())!;
    await session.dispatched(); session.opened();
    await session.observe(event({ type: "session.updated", session: { audio: { input: { turn_detection: { type: "server_vad", create_response: true }, transcription: null } } } }));
    session.clientActivity('{"type":"input_audio_buffer.append","audio":"PRIVATE"}');
    await session.observe(event({ type: "input_audio_buffer.committed", event_id: "commit", item_id: "audio" }));
    await session.observe(event({ type: "response.created", response: { id: "a", conversation_id: "default-conversation" } }));
    await session.observe(done("a")); session.clientActivity('{"type":"input_audio_buffer.clear"}');
    await session.observe(event({ type: "input_audio_buffer.cleared", event_id: "clear" })); await session.close(false);
    const result = (await summary())!; expect(result.reservations[0].state).toBe("committed"); expect(result.budget_committed_usd).toBe("0.100000000000000000");
    expect(JSON.stringify(await db.query("SELECT price_context_json,cost_json FROM pricing_attempts"))).not.toContain("PRIVATE");
  });
  it.each(["missing-response", "newer-audio", "independent-asr"])("keeps automatic work unresolved rather than inferring zero: %s", async problem => {
    await publish(); await policy(); const session = (await begin())!; await session.dispatched(); session.opened();
    await session.observe(event({ type: "session.updated", session: { audio: { input: { turn_detection: { type: "semantic_vad", create_response: true }, transcription: null } } } }));
    session.clientActivity('{"type":"input_audio_buffer.append","audio":"PRIVATE"}');
    await session.observe(event({ type: "input_audio_buffer.committed", event_id: "commit", item_id: "audio" }));
    session.clientActivity('{"type":"input_audio_buffer.clear"}');
    if (problem === "newer-audio") session.clientActivity('{"type":"input_audio_buffer.append","audio":"PRIVATE-NEW"}');
    await session.observe(event({ type: "input_audio_buffer.cleared", event_id: "clear" }));
    if (problem !== "missing-response") { await session.observe(event({ type: "response.created", response: { id: "a", conversation_id: "default-conversation" } })); await session.observe(done("a")); }
    if (problem === "independent-asr") await session.observe(event({ type: "conversation.item.input_audio_transcription.completed", event_id: "transcript", item_id: "audio", transcript: "PRIVATE", usage: { type: "duration", seconds: 2 } }));
    await session.close(false); expect((await summary())!.reservations[0].state).toBe("reserved"); expect((await summary())!.amount).toBeNull();
  });
  it("applies response custody before queued accounting so a mode change cannot misattribute it", async () => {
    await publish(); await policy(); const session = await ready(); session.clientActivity('{"type":"response.create"}');
    const creation = created("a"), observed = session.observation(creation);
    session.clientActivity('{"type":"session.update"}');
    await session.observe(creation, observed); await session.observe(done("a")); await session.close(false);
    expect((await summary())!.reservations[0].state).toBe("committed");
  });
  it("reserves automatic creation capacity at transport receipt before database observation", async () => {
    await publish(); await policy({ realtime_max_responses: 1 }); const session = await ready();
    const response = created("auto"), observed = session.observation(response);
    expect(session.clientActivity('{"type":"response.create"}')).toBe(false);
    await session.observe(response, observed); await session.observe(done("auto")); await session.close(false);
    expect((await summary())!.budget_committed_usd).toBe("0.100000000000000000");
  });
  it.each([
    { actual: false, problem: "none" }, { actual: true, problem: "none" },
    { actual: true, problem: "newer-audio" }, { actual: true, problem: "independent-asr" },
    { actual: true, problem: "missing-response" },
  ])("tracks real WebSocket VAD turns, clears and separate ASR custody (actual=$actual,problem=$problem)", async ({ actual, problem }) => {
    await publish(); await policy({ budget_basis: actual ? "actual_upstream" : "legacy_logical" });
    const upstream = createServer(); let peer: Duplex | undefined, client: WebSocket | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    const commands: string[] = []; let buffer: Buffer = Buffer.alloc(0), opens = 0, sentTurn = false;
    const frame = (body: unknown) => {
      const payload = Buffer.from(JSON.stringify(body)); const header = payload.length < 126 ? Buffer.from([0x81, payload.length]) : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 255]);
      return Buffer.concat([header, payload]);
    };
    const configured = { type: "session.updated", session: { audio: { input: { turn_detection: { type: "server_vad", create_response: true }, transcription: null } } } };
    upstream.on("upgrade", (request, socket) => {
      peer = socket; opens++; socket.on("error", () => undefined);
      const accept = createHash("sha1").update(String(request.headers["sec-websocket-key"]) + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      socket.write(Buffer.concat([frame(configured), frame({ type: "fixture.ready" })]));
      socket.on("data", chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 2) {
          const opcode = buffer[0] & 0x0f, masked = Boolean(buffer[1] & 0x80); let size = buffer[1] & 0x7f, offset = 2;
          if (size === 127) { socket.destroy(); return; }
          if (size === 126) { if (buffer.length < 4) return; size = buffer.readUInt16BE(2); offset = 4; }
          const maskBytes = masked ? 4 : 0; if (buffer.length < offset + maskBytes + size) return;
          const mask = buffer.subarray(offset, offset + maskBytes), payload = Buffer.from(buffer.subarray(offset + maskBytes, offset + maskBytes + size));
          if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
          buffer = buffer.subarray(offset + maskBytes + size); if (opcode !== 1) continue;
          const command = JSON.parse(payload.toString()) as { type: string }; commands.push(command.type);
          if (command.type === "input_audio_buffer.append" && !sentTurn) {
            sentTurn = true;
            const response = { id: "vad-response", conversation_id: "default-conversation", status: "completed", usage: { input_tokens: 0, output_tokens: 10, total_tokens: 10, input_token_details: { cached_tokens: 0 } } };
            const committed = { type: "input_audio_buffer.committed", event_id: "commit", item_id: "audio" };
            socket.write(Buffer.concat([
              frame({ type: "input_audio_buffer.speech_started", item_id: "audio", audio_start_ms: 0 }),
              frame({ type: "input_audio_buffer.speech_stopped", item_id: "audio", audio_end_ms: 1000 }), frame(committed), frame(committed),
              ...(problem === "missing-response" ? [] : [frame({ type: "response.created", response }), frame({ type: "response.done", response }), frame({ type: "response.done", response })]),
              ...(problem === "independent-asr" ? [frame({ type: "conversation.item.input_audio_transcription.completed", event_id: "transcript", item_id: "audio", content_index: 0, transcript: "PRIVATE-TRANSCRIPT", usage: { type: "tokens", input_tokens: 3, output_tokens: 2, total_tokens: 5 } })] : []),
              frame({ type: "fixture.clear" }),
            ]));
          } else if (command.type === "input_audio_buffer.clear") {
            const cleared = { type: "input_audio_buffer.cleared", event_id: "clear" };
            socket.write(Buffer.concat([frame(cleared), frame(cleared), frame({ type: "fixture.finished" })]));
          }
        }
      });
    });
    try {
      await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve)); const address = upstream.address();
      if (!address || typeof address === "string" || address.port === 2099) throw new Error("Unsafe VAD fixture port");
      h.app.get(ConfigService).getNode("mock-openai")!.realtime_endpoint = `ws://127.0.0.1:${address.port}/realtime`;
      const port = h.app.getHttpServer().address().port; expect(port).not.toBe(2099);
      client = new WebSocket(`ws://127.0.0.1:${port}/v1/realtime?model=${model}`, { headers: { Authorization: `Bearer ${API_KEY}` } });
      await new Promise<void>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Synthetic VAD flow timeout")), 5000);
        client!.addEventListener("error", () => reject(new Error("Unexpected VAD client error")));
        client!.addEventListener("message", reply => {
          if (typeof reply.data !== "string") return;
          const type = (JSON.parse(reply.data) as { type: string }).type;
          if (type === "fixture.ready") client!.send('{"type":"input_audio_buffer.append","audio":"UFJJVkFURQ=="}');
          if (type === "fixture.clear") {
            client!.send('{"type":"input_audio_buffer.clear"}');
            if (problem === "newer-audio") client!.send('{"type":"input_audio_buffer.append","audio":"UFJJVkFURS1ORVc="}');
          }
          if (type === "fixture.finished") resolve();
        });
      });
      clearTimeout(timer); const proxy = h.app.get(RealtimeProxyService), requestId = proxy.getStatus(key.workspace_id).recent[0].request_id;
      const closed = new Promise<void>(resolve => client!.addEventListener("close", () => resolve(), { once: true })); client.close(1000); await closed; await proxy.onModuleDestroy();
      const result = (await summary(requestId))!; expect(opens).toBe(1);
      expect(commands).toEqual(["input_audio_buffer.append", "input_audio_buffer.clear", ...(problem === "newer-audio" ? ["input_audio_buffer.append"] : [])]);
      expect(result.reservations[0].state).toBe(problem === "none" ? "committed" : "reserved");
      expect(result.budget_committed_usd).toBe(problem === "none" ? "0.100000000000000000" : "0.000000000000000000");
      if (problem !== "none") expect(result.amount).toBeNull();
      if (problem !== "missing-response") expect(result.known_subtotal).toBe("0.100000000000000000");
      expect(JSON.stringify(await db.query("SELECT price_context_json,cost_json FROM pricing_attempts"))).not.toMatch(/PRIVATE|UFJJVk/);
    } finally { if (timer) clearTimeout(timer); client?.close(); peer?.destroy(); if (upstream.listening) await new Promise<void>(resolve => upstream.close(() => resolve())); }
  }, 15000);

  it("retains explicit actual mode with no price binding instead of bypassing to legacy accounting", async () => {
    await policy({ mode: "compatibility" }); const session = await ready();
    await session.observe(done("a")); await session.close(false);
    expect((await summary())!.reservations[0]).toMatchObject({ budget_basis: "actual_upstream", state: "reserved" });
  });
  it("releases a known never-dispatched admission without inventing a provider attempt", async () => {
    await publish(); await policy(); const session = (await begin())!; await session.close(false); await session.close(false);
    const result = (await summary())!; expect(result.attempts).toHaveLength(0); expect(result.reservations[0].state).toBe("released");
    expect(await db.query("SELECT * FROM pricing_actual_budget_cohorts")).toHaveLength(1);
  });
  it("does not send after close races a delayed durable connection marker", async () => {
    await publish(); await policy(); const session = (await begin())!, ledger = h.app.get(CostLedgerService);
    const original = ledger.beginAttempt.bind(ledger); let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const fault = jest.spyOn(ledger, "beginAttempt").mockImplementation(async input => { await gate; return original(input); });
    const dispatched = session.dispatched(); const closing = session.close(false); release(); await dispatched; await closing; fault.mockRestore();
    const result = (await summary())!; expect(result.budget_committed_usd).toBe("0.000000000000000000"); expect(result.reservations[0].state).toBe("committed");
    expect(result.attempts[0].cost!.usage.quantities.session_seconds?.value).toBe("0"); expect(h.fetchMock.calls).toHaveLength(0);
  });
  it("does not manufacture a known supplier debit after a connection marker write fails", async () => {
    await publish(); await policy(); const session = (await begin())!, ledger = h.app.get(CostLedgerService);
    const fault = jest.spyOn(ledger, "beginAttempt").mockRejectedValue(new Error("Synthetic marker unavailable"));
    await expect(session.dispatched()).rejects.toThrow("Synthetic marker unavailable"); await session.close(true); fault.mockRestore();
    expect((await summary())!.reservations[0].state).toBe("reserved"); expect((await summary())!.attempts).toHaveLength(0);
    expect(await db.query("SELECT * FROM pricing_actual_budget_cohorts")).toHaveLength(0);
  });
  it("uses provider attribution and a single actual cohort for every known response including paid cancellation", async () => {
    await publish(); await policy(); const session = await ready();
    session.clientActivity('{"type":"response.create"}'); session.clientActivity('{"type":"response.create"}');
    await session.observe(created("a")); await session.observe(done("a")); await session.observe(done("a"));
    await session.observe(created("b")); await session.observe(done("b", 5, "cancelled")); await session.close(false);
    const result = (await summary())!; expect(result.budget_committed_usd).toBe("0.150000000000000000");
    expect(result.reservations[0]).toMatchObject({ state: "committed", budget_basis: "actual_upstream", committed_tokens: "15" });
    expect(result.attempts.every(a => a.fee_source === "provider")).toBe(true); expect(result.provider_attempts).toBe(3);
    expect(await db.query("SELECT * FROM pricing_budget_effects WHERE kind = 'commit'")).toHaveLength(1);
    await h.app.get(CostLedgerService).reconcilePending(); expect(await summary()).toEqual(result);
  });
  it("does not close two sent generations after only one is acknowledged and complete", async () => {
    await publish(); await policy(); const session = await ready(); session.clientActivity('{"type":"response.create"}'); session.clientActivity('{"type":"response.create"}');
    await session.observe(created("a")); await session.observe(done("a")); await session.close(false);
    const result = (await summary())!; expect(result.reservations[0].state).toBe("reserved"); expect(result.known_subtotal).toBe("0.100000000000000000");
    const closure = (await db.query("SELECT closure_json FROM pricing_actual_budget_cohorts"))[0]; expect(JSON.parse(closure.closure_json).missing_dispatch_evidence).toBe(true);
  });
  it.each([false, true])("keeps supplier session mode in transport order rather than accounting-queue order (updated=%s)", async updated => {
    await publish(); await policy(); const session = (await begin())!; await session.dispatched(); session.opened();
    const mode = manual(), observed = session.observation(mode);
    if (updated) session.clientActivity('{"type":"session.update","session":{"audio":{"input":{"turn_detection":{"type":"server_vad"}}}}}');
    session.clientActivity('{"type":"response.create"}');
    await session.observe(mode, observed); await session.observe(created("a")); await session.observe(done("a")); await session.close(false);
    expect((await summary())!.reservations[0].state).toBe(updated ? "reserved" : "committed");
  });
  it.each([false, true])("keeps sent handshake/abnormal close unknown rather than inferring zero (opened=%s)", async opened => {
    await publish(); await policy(); const session = (await begin())!; await session.dispatched(); if (opened) session.opened();
    await session.close(true); expect((await summary())!.reservations[0].state).toBe("reserved");
    expect((await summary())!.amount).toBeNull(); expect(await db.query("SELECT * FROM pricing_budget_effects WHERE kind = 'commit'")).toHaveLength(0);
  });
  it("keeps a sent but unacknowledged handshake unknown even on a clean client close", async () => {
    await publish(); await policy(); const session = (await begin())!; await session.dispatched(); await session.close(false);
    expect((await summary())!.reservations[0].state).toBe("reserved"); expect((await summary())!.amount).toBeNull();
  });
  it("sums explicit session duration and token fees using the monotonic transport-close clock", async () => {
    const content = { ...book([rate("output", "output_tokens", "0.01", "1"), rate("seconds", "session_seconds", "0.1", "1")]), allow_combined_media: true };
    await publish(content); await policy(); const session = (await begin())!; await session.dispatched();
    const opening = jest.spyOn(process.hrtime, "bigint").mockReturnValue(1000000000n); session.opened(); opening.mockRestore();
    await session.observe(done("a")); let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; });
    const closing = jest.spyOn(process.hrtime, "bigint").mockReturnValue(3000000000n); const closed = session.close(false, pending);
    closing.mockReturnValue(99000000000n); release(); await closed; closing.mockRestore();
    const result = (await summary())!; expect(result.budget_committed_usd).toBe("0.300000000000000000");
    expect(result.attempts.find(a => a.id.startsWith("rt-session-"))!.cost!.usage.quantities.session_seconds?.value).toBe("2");
  });
  it("keeps original price versions through in-session publication and uses the new price for new sessions", async () => {
    const version = await publish(); await policy(); const session = await ready(); await session.observe(done("a"));
    await publish(book([rate("output", "output_tokens", "0.1", "1")])); await session.observe(done("b", 5)); await session.close(false);
    expect((await summary())!.budget_committed_usd).toBe("0.150000000000000000"); expect((await summary())!.attempts.every(a => a.cost?.version_id === version)).toBe(true);
    const next = (await begin("next"))!; await next.dispatched(); next.opened(); await next.observe(done("new")); await next.close(false);
    expect((await summary("next"))!.budget_committed_usd).toBe("1.000000000000000000");
  });
  it("replays a durably retained actual closure after delivery failure without another provider attempt", async () => {
    await publish(); await policy(); const session = await ready(); await session.observe(done("a")); const ledger = h.app.get(CostLedgerService);
    const fault = jest.spyOn(ledger as unknown as { closeActualBudget: (...args: unknown[]) => Promise<void> }, "closeActualBudget").mockRejectedValue(new Error("Synthetic RT closure delivery failure"));
    await session.close(false); expect((await summary())!.reservations[0].state).toBe("reserved"); fault.mockRestore();
    const fresh = new CostLedgerService(db, h.app.get(BudgetService)); await fresh.replayRuntimeOutcomes(new Date(Date.now() + 120000));
    const result = await summary(); expect(result!.budget_committed_usd).toBe("0.100000000000000000");
    await fresh.replayRuntimeOutcomes(new Date(Date.now() + 240000)); expect(await summary()).toEqual(result); expect(h.fetchMock.calls).toHaveLength(0);
  });
  it.each(["reported_tokens", "not_applicable"] as const)("honors %s policy for a session tariff when response tokens are missing", async token_budget => {
    await publish(book([rate("seconds", "session_seconds", "0.1", "1")])); await policy({ token_budget });
    const session = await ready(); await session.observe(event({ type: "response.done", response: { id: "no-tokens", status: "completed" } })); await session.close(false);
    expect((await summary())!.reservations[0].state).toBe(token_budget === "not_applicable" ? "committed" : "reserved");
  });
  it("rejects a token-bearing Realtime tariff selected with a non-token exemption", async () => {
    await publish(); await policy({ token_budget: "not_applicable" }); await expect(begin()).rejects.toMatchObject({ statusCode: 422 });
    expect(await db.query("SELECT * FROM pricing_reservations")).toHaveLength(0);
  });
  it("exempts exhausted token budgets only when the frozen session contract explicitly permits it", async () => {
    await publish(book([rate("seconds", "session_seconds", "0.1", "1")])); await policy({ token_budget: "not_applicable" });
    await db.query("UPDATE budget_rules SET current_value = limit_value WHERE type = 'daily_tokens'");
    const tokens = await db.query("SELECT * FROM budget_rules WHERE type = 'daily_tokens' ORDER BY id");
    const session = await ready(); await session.close(false); expect((await summary())!.reservations[0].state).toBe("committed");
    expect(await db.query("SELECT * FROM budget_rules WHERE type = 'daily_tokens' ORDER BY id")).toEqual(tokens);
    await policy({ token_budget: "reported_tokens" }); await expect(begin("token-required")).rejects.toMatchObject({ budgetType: "daily_tokens" });
  });

  it.each(["complete-manual", "missing-second", "uncorrelated-auto", "correlated-auto"])(
    "uses the real loopback WebSocket boundary for parallel generation custody: %s", async scenario => {
      await publish(); await policy(); const upstream = createServer(); let peer: Duplex | undefined, client: WebSocket | undefined;
      const commands: Record<string, unknown>[] = []; let opens = 0, buffer: Buffer = Buffer.alloc(0);
      const frame = (body: unknown) => {
        const payload = Buffer.from(JSON.stringify(body)); const header = payload.length < 126 ? Buffer.from([0x81, payload.length]) : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 255]);
        return Buffer.concat([header, payload]);
      };
      upstream.on("upgrade", (request, socket) => {
        peer = socket; opens++; socket.on("error", () => undefined);
        const accept = createHash("sha1").update(String(request.headers["sec-websocket-key"]) + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
        socket.write(Buffer.concat([frame({ type: "session.updated", session: { audio: { input: {
          turn_detection: scenario.includes("auto") ? { type: "server_vad" } : null, transcription: null,
        } } } }), frame({ type: "fixture.ready" })]));
        socket.on("data", chunk => {
          buffer = Buffer.concat([buffer, chunk]);
          while (buffer.length >= 2) {
            const opcode = buffer[0] & 0x0f, masked = Boolean(buffer[1] & 0x80); let size = buffer[1] & 0x7f, offset = 2;
            if (size === 127) { socket.destroy(); return; }
            if (size === 126) { if (buffer.length < 4) return; size = buffer.readUInt16BE(2); offset = 4; }
            const maskBytes = masked ? 4 : 0; if (buffer.length < offset + maskBytes + size) return;
            const mask = buffer.subarray(offset, offset + maskBytes), payload = Buffer.from(buffer.subarray(offset + maskBytes, offset + maskBytes + size));
            if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
            buffer = buffer.subarray(offset + maskBytes + size);
            if (opcode !== 1) continue;
            const command = JSON.parse(payload.toString()) as Record<string, unknown>; commands.push(command);
            if (commands.length !== 2) continue;
            const responses = scenario === "missing-second" ? ["a"] : ["b", "a"];
            const events = responses.flatMap(id => {
              const metadata = scenario === "correlated-auto" ? { correlation: `PRIVATE-${id}` } : undefined;
              const response = { id, metadata, status: "completed", usage: { input_tokens: 0, output_tokens: 10, total_tokens: 10, input_token_details: { cached_tokens: 0 } } };
              return [frame({ type: "response.created", response: { id, metadata } }), frame({ type: "response.done", response }), frame({ type: "response.done", response })];
            });
            socket.write(Buffer.concat([...events, frame({ type: "fixture.finished" })]));
          }
        });
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve)); const address = upstream.address();
        if (!address || typeof address === "string" || address.port === 2099) throw new Error("Unsafe synthetic supplier port");
        h.app.get(ConfigService).getNode("mock-openai")!.realtime_endpoint = `ws://127.0.0.1:${address.port}/realtime`;
        const port = h.app.getHttpServer().address().port; expect(port).not.toBe(2099);
        client = new WebSocket(`ws://127.0.0.1:${port}/v1/realtime?model=${model}`, { headers: { Authorization: `Bearer ${API_KEY}` } });
        await new Promise<void>((resolve, reject) => {
          timer = setTimeout(() => reject(new Error("Synthetic parallel Realtime flow timed out")), 5000);
          client!.addEventListener("error", () => reject(new Error("Unexpected Realtime client error")));
          client!.addEventListener("message", reply => {
            if (typeof reply.data !== "string") return;
            const message = JSON.parse(reply.data) as { type: string };
            if (message.type === "fixture.ready") for (const id of ["a", "b"])
              client!.send(JSON.stringify({ type: "response.create", response: { conversation: "none", ...(scenario === "correlated-auto" ? { metadata: { correlation: `PRIVATE-${id}` } } : {}) } }));
            if (message.type === "fixture.finished") resolve();
          });
        });
        if (timer) clearTimeout(timer);
        const proxy = h.app.get(RealtimeProxyService), requestId = proxy.getStatus(key.workspace_id).recent[0].request_id;
        const closed = new Promise<void>(resolve => client!.addEventListener("close", () => resolve(), { once: true })); client.close(1000); await closed;
        await proxy.onModuleDestroy(); const result = (await summary(requestId))!;
        expect(opens).toBe(1); expect(commands).toHaveLength(2); expect(commands.every(c => c.type === "response.create")).toBe(true);
        const complete = scenario === "complete-manual" || scenario === "correlated-auto";
        expect(result.reservations[0].state).toBe(complete ? "committed" : "reserved");
        expect(result.budget_committed_usd).toBe(complete ? "0.200000000000000000" : "0.000000000000000000");
        expect(result.known_subtotal).toBe(scenario === "missing-second" ? "0.100000000000000000" : "0.200000000000000000");
        expect(JSON.stringify(await db.query("SELECT price_context_json,cost_json FROM pricing_attempts"))).not.toContain("PRIVATE");
      } finally { if (timer) clearTimeout(timer); client?.close(); peer?.destroy(); if (upstream.listening) await new Promise<void>(resolve => upstream.close(() => resolve())); }
    }, 15000,
  );
});

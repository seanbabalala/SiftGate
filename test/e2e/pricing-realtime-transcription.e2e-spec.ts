import { pricingContentHash } from '../../src/pricing/pricing-json';
import { DataSource } from "typeorm";
import { createE2EHarness, API_KEY, type E2EHarness } from "./setup";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import type { Duplex } from "node:stream";
import { WebSocket } from "undici";
import { ConfigService } from "../../src/config/config.service";
import { RealtimeProxyService } from "../../src/realtime/realtime-proxy.service";
import { applyPricingSchema } from "../../src/pricing/pricing-schema";
import { PricingRecoveryService } from "../../src/pricing/pricing-recovery.service";
import { RealtimePricingService } from "../../src/pricing/realtime-pricing.service";
import { CostLedgerService } from "../../src/pricing/cost-ledger.service";
import { realtimePricingEvent } from "../../src/pricing/realtime-metering";
import { book, rate } from "../unit/pricing-fixtures";
import type { GatewayApiKeyContext } from "../../src/auth/gateway-api-key.service";
import type { PriceBookContent } from "../../src/pricing/pricing.types";
import { runRealtimePriceLifecycle, realtimeLifecycleCases, type RealtimeLifecycleAdmin } from "../helpers/realtime-price-lifecycle";

const base = "/api/dashboard/pricing", rt = "gpt-4o-realtime-preview", asr = "synthetic-asr";
const key = { id: "synthetic", name: "synthetic", workspace_id: "default-workspace", namespace_id: null } as GatewayApiKeyContext;
const event = (value: unknown) => realtimePricingEvent(JSON.stringify(value))!;
describe("independent ASR reservation and receipts in a Realtime session", () => {
  let h: E2EHarness, db: DataSource, service: RealtimePricingService;
  beforeEach(async () => { h = await createE2EHarness(); await h.app.get(PricingRecoveryService).onModuleDestroy(); db = h.app.get(DataSource); await applyPricingSchema(db); service = h.app.get(RealtimePricingService); });
  afterEach(async () => { jest.restoreAllMocks(); await h?.close(); });
  async function publish(model: string, operation: string, content: PriceBookContent) {
    const created = await h.agent.post(base + "/books").send({ name: "Synthetic " + model, content }); expect(created.status).toBe(201);
    const head = (await h.agent.get(base + "/bindings")).body.head;
    const result = await h.agent.post(`${base}/drafts/${created.body.draft.id}/publish`).send({ draft_revision: 1, catalog_revision: head.revision, ...(content.time_basis && content.time_basis !== 'attempt_dispatched_at' ? { time_basis_confirmation: { basis: content.time_basis, content_hash: pricingContentHash(content), reference: 'SYNTHETIC-TIMING-CONTRACT', confirmed: true as const } } : {}), reason: "Synthetic ASR contract", confirm: true, targets: [{ level: "model", model, operation }] });
    expect(result.status === 201 ? 201 : result.body).toBe(201); return result.body.version_id as string;
  }
  async function policy(operation: string, value: unknown) {
    const head = (await h.agent.get(base + "/bindings")).body.head;
    return h.agent.put(base + "/admission-policy").send({ catalog_revision: head.revision, scope: "workspace", operation, reason: "Synthetic ASR allowance", confirm: true, policy: value });
  }
  const begin = () => service.begin("asr-request", key, "mock-openai", rt, 60000);
  const summary = () => h.app.get(CostLedgerService).summary("asr-request", key.workspace_id);
  const lifecycleAdmin = (): RealtimeLifecycleAdmin => ({
    publish,
    async fx(denominator) {
      const head = (await h.agent.get(base + '/bindings')).body.head;
      const response = await h.agent.put(base + '/fx').send({ catalog_revision: head.revision, scope: 'workspace', reason: 'Synthetic lifecycle FX', confirm: true,
        versions: denominator ? [{ fx: { from_currency: 'CNY', to_currency: 'USD', numerator: '1', denominator, effective_at: '2020-01-01T00:00:00.000Z', source: 'Synthetic FX' } }] : [] });
      expect(response.status === 200 ? 200 : response.body).toBe(200);
      return (await h.agent.get(base + '/bindings')).body.fx_versions[0]?.fx.version_id ?? null;
    },
    async policy(operation, value) { expect((await policy(operation, value)).status).toBe(200); },
  });

  it.each(realtimeLifecycleCases)('shows frozen independent ASR and Realtime fees after tariff, FX and calendar changes (duration=$duration,actual=$actual,calendar=$calendar)', async ({ duration, actual, calendar }) => {
    // Two simultaneous worst-case duration allowances require more than the
    // shared fixture's $50 key cap. Match this lifecycle's explicit $100 unit fixture.
    await db.query("UPDATE budget_rules SET limit_value=100 WHERE type='daily_cost'");
    const ledger = h.app.get(CostLedgerService);
    const result = await runRealtimePriceLifecycle(lifecycleAdmin(), service, ledger, key, 'mock-openai', duration, actual, false, calendar);
    const before = await db.query('SELECT * FROM pricing_budget_effects ORDER BY id');
    // This directly drives the real accounting service, not a WebSocket proxy;
    // use its request-evidence API rather than inventing transport log rows.
    for (const expected of [result.first, result.second!]) {
      const detail = await h.agent.get(`${base}/requests/${expected.request_id}/cost`);
      expect(detail.status).toBe(200);
      expect(detail.body).toEqual(expected);
    }
    const report = await h.agent.get(base + '/cost-report').query({ from: new Date(Date.now() - 86400000).toISOString(), to: new Date(Date.now() + 86400000).toISOString() });
    expect(report.status).toBe(200);
    for (const detail of [result.first, result.second!]) expect(report.body.rows.find((row: { request_id: string }) => row.request_id === detail.request_id)).toMatchObject({ amount_usd: detail.amount, budget_committed_usd: detail.budget_committed_usd });
    expect(await db.query('SELECT * FROM pricing_budget_effects ORDER BY id')).toEqual(before);
    expect(h.fetchMock.calls).toHaveLength(0);
  });

  it.each([false, true])('reports original ASR costs after current FX removal and rejects a new session without dispatch (duration=%s)', async duration => {
    const ledger = h.app.get(CostLedgerService);
    const result = await runRealtimePriceLifecycle(lifecycleAdmin(), service, ledger, key, 'mock-openai', duration, true, true);
    expect(result.second).toBeNull();
    expect(await db.query("SELECT * FROM pricing_attempts WHERE request_id='lifecycle-new'")).toHaveLength(0);
    expect(await db.query("SELECT * FROM pricing_reservations WHERE request_id='lifecycle-new'")).toHaveLength(0);
    expect(h.fetchMock.calls).toHaveLength(0);
  });
  async function setup(duration = false, actual = true) {
    await publish(rt, "realtime", book([rate("rt-output", "output_tokens", "0.01", "1")]));
    const asrVersion = await publish(asr, "audio_transcription", duration ? book([rate("duration", "audio_input_seconds", "0.1", "1")]) : book([rate("input", "uncached_input_tokens", "0.001", "1"), rate("output", "output_tokens", "0.002", "1")]));
    expect((await policy("audio_transcription", { mode: "reserve_upper_bound", budget_basis: "actual_upstream", ...(duration ? { token_budget: "not_applicable" } : {}), quantity_limits: duration ? { audio_input_seconds: "10" } : { total_input_tokens: "100", output_tokens: "20" }, limit_reference: "Synthetic ASR limits" })).status).toBe(200);
    expect((await policy("realtime", { mode: "reserve_upper_bound", ...(actual ? { budget_basis: "actual_upstream" } : {}), realtime_max_responses: 2, realtime_transcription: { model: asr, max_items: 2 }, quantity_limits: { total_input_tokens: "100", output_tokens: "40", session_seconds: "60" }, limit_reference: "Synthetic RT limits" })).status).toBe(200);
    return asrVersion;
  }
  const configured = (model = asr) => event({ type: "session.updated", event_id: "config-" + model, session: { audio: { input: { turn_detection: null, transcription: { model } } } } });
  const receipt = (duration: boolean, value = 13) => event({ type: "conversation.item.input_audio_transcription.completed", event_id: "transcript", item_id: "audio-1", content_index: 0, transcript: "PRIVATE", usage: duration ? { type: "duration", seconds: 6.4 } : { type: "tokens", input_tokens: value, output_tokens: 9, total_tokens: value + 9, input_token_details: { audio_tokens: value, text_tokens: 0 } } });
  it.each([{ duration: false, actual: true }, { duration: true, actual: true }, { duration: false, actual: false }])("separates ASR model/rates/quota from Realtime, including non-token duration (duration=$duration,actual=$actual)", async ({ duration, actual }) => {
    const version = await setup(duration, actual); const handle = (await begin())!;
    const holds = await db.query("SELECT * FROM pricing_reservations"); expect(holds).toHaveLength(2);
    const extra = holds.find((row: { target_json: string }) => JSON.parse(row.target_json).model === asr);
    expect(extra.reserved_cost_usd).toBe(duration ? "2.000000000000000000" : "0.280000000000000000");
    expect(JSON.parse(extra.holds_json).every((row: { type: string }) => !duration || row.type !== "daily_tokens")).toBe(true);
    await handle.dispatched(); handle.opened(); await handle.observe(configured());
    expect(handle.clientActivity('{"type":"input_audio_buffer.append","audio":"PRIVATE"}')).toBe(true);
    await handle.observe(event({ type: "input_audio_buffer.committed", event_id: "commit", item_id: "audio-1" }));
    await publish(asr, "audio_transcription", duration ? book([rate("duration", "audio_input_seconds", "99", "1")]) : book([rate("input", "uncached_input_tokens", "99", "1"), rate("output", "output_tokens", "99", "1")]));
    await handle.observe(receipt(duration)); await handle.observe(receipt(duration));
    handle.clientActivity('{"type":"response.create"}'); await handle.observe(event({ type: "response.created", response: { id: "response" } }));
    await handle.observe(event({ type: "response.done", response: { id: "response", status: "completed", usage: { input_tokens: 0, output_tokens: 10, total_tokens: 10, input_token_details: { cached_tokens: 0 } } } }));
    handle.clientActivity('{"type":"input_audio_buffer.clear"}'); await handle.observe(event({ type: "input_audio_buffer.cleared", event_id: "clear" }));
    await handle.close(false); const result = (await summary())!;
    expect(result.amount).toBe(duration ? "0.740000000000000000" : "0.131000000000000000"); expect(result.budget_committed_usd).toBe(result.amount);
    expect(result.reservations.every(row => row.state === "committed")).toBe(true);
    const transcribed = result.attempts.find(row => row.id.startsWith("rt-asr-") && !row.id.startsWith("rt-asr-session-"))!;
    expect(transcribed.model).toBe(asr); expect(transcribed.cost?.version_id).toBe(version); expect(transcribed.cost?.report_amount).toBe(duration ? "0.640000000" : "0.031000000");
    expect(JSON.stringify(result)).not.toContain("PRIVATE"); expect(h.fetchMock.calls).toHaveLength(0);
  });
  it("rejects missing ASR bounds before any supplier attempt and preserves policy round-trips", async () => {
    await setup(); expect((await policy("audio_transcription", { mode: "compatibility", budget_basis: "actual_upstream" })).status).toBe(200);
    await expect(begin()).rejects.toMatchObject({ statusCode: 422 });
    expect(await db.query("SELECT * FROM pricing_attempts")).toHaveLength(0); expect(await db.query("SELECT * FROM pricing_reservations")).toHaveLength(0);
    expect((await h.agent.get(base + "/admission-policies")).body.policies.find((p: { operation: string }) => p.operation === "realtime").policy.realtime_transcription).toEqual({ model: asr, max_items: 2 });
  });
  it("refuses audio without an acknowledged declared ASR model before sending bytes", async () => {
    await setup(); const handle = (await begin())!; await handle.dispatched(); handle.opened();
    expect(handle.clientActivity('{"type":"input_audio_buffer.append","audio":"PRIVATE"}')).toBe(false);
    await handle.observe(configured("other-asr")); expect(handle.clientActivity('{"type":"input_audio_buffer.append"}')).toBe(false);
    await handle.observe(configured()); expect(handle.clientActivity('{"type":"input_audio_buffer.append"}')).toBe(true);
    await handle.close(false); expect((await summary())!.amount).toBeNull();
  });
  it("does not let creation or duplicate acknowledgements release audio before all sent updates are acknowledged", async () => {
    await setup(); const handle = (await begin())!; await handle.dispatched(); handle.opened();
    const audio = '{"type":"input_audio_buffer.append","audio":"PRIVATE"}';
    expect(handle.clientActivity('{"type":"session.update","session":{"instructions":"PRIVATE"}}')).toBe(true);
    expect(handle.clientActivity('{"type":"session.update","session":{"audio":{"input":{"transcription":{"model":"synthetic-asr"}}}}}')).toBe(true);
    const acknowledged = (type: string, id: string, model = asr) => event({ type, event_id: id, session: { audio: { input: { turn_detection: null, transcription: { model } } } } });
    await handle.observe(acknowledged("session.created", "created"));
    expect(handle.clientReady!(audio)).toBe(false);
    await handle.observe(acknowledged("session.updated", "updated-1"));
    expect(handle.clientReady!(audio)).toBe(false);
    await handle.observe(acknowledged("session.updated", "updated-1"));
    expect(handle.clientReady!(audio)).toBe(false);
    await handle.observe(acknowledged("session.updated", "updated-2"));
    expect(handle.clientReady!(audio)).toBe(true);
    expect(handle.clientActivity(audio)).toBe(true);
    await handle.observe(event({ type: "input_audio_buffer.committed", event_id: "commit", item_id: "audio-1" }));
    await handle.observe(receipt(false));
    handle.clientActivity('{"type":"input_audio_buffer.clear"}'); await handle.observe(event({ type: "input_audio_buffer.cleared", event_id: "clear" }));
    await handle.close(false);
    expect((await summary())!.budget_committed_usd).toBe("0.031000000000000000");
    expect(JSON.stringify(await summary())).not.toContain("PRIVATE");
  });
  it("does not admit audio from a session configuration lacking native acknowledgement identity", async () => {
    await setup(); const handle = (await begin())!; await handle.dispatched(); handle.opened();
    expect(await handle.observe(event({ type: "session.created", session: { audio: { input: { turn_detection: null, transcription: { model: asr } } } } }))).toBe(false);
    expect(handle.clientReady!('{"type":"input_audio_buffer.append"}')).toBe(false);
    expect(handle.clientActivity('{"type":"input_audio_buffer.append"}')).toBe(false);
    await handle.close(false); expect((await summary())!.amount).toBeNull();
  });
  it("returns a stop decision for conflicting ASR receipts instead of hiding it behind an audio control event", async () => {
    await setup(); const handle = (await begin())!; await handle.dispatched(); handle.opened(); await handle.observe(configured());
    handle.clientActivity('{"type":"input_audio_buffer.append"}');
    await handle.observe(event({ type: "input_audio_buffer.committed", event_id: "commit", item_id: "audio-1" }));
    expect(await handle.observe(receipt(false))).toBe(true);
    expect(await handle.observe(receipt(false, 14))).toBe(false);
    await handle.close(false);
    const result = (await summary())!;
    expect(result.amount).toBeNull(); expect(result.known_subtotal).toBe("0.031000000000000000");
    expect(result.reservations.some(row => row.state === "reserved")).toBe(true);
  });
  it("drains already-observed Realtime fees after a separate ASR conflict while stopping further work", async () => {
    await setup(); const handle = (await begin())!; await handle.dispatched(); handle.opened(); await handle.observe(configured());
    handle.clientActivity('{"type":"input_audio_buffer.append"}');
    await handle.observe(event({ type: "input_audio_buffer.committed", event_id: "commit", item_id: "audio-1" }));
    await handle.observe(receipt(false));
    const observed = [receipt(false, 14),
      event({ type: "response.created", response: { id: "already-received" } }),
      event({ type: "response.done", response: { id: "already-received", status: "completed", usage: { input_tokens: 0, output_tokens: 10, total_tokens: 10, input_token_details: { cached_tokens: 0 } } } }),
    ].map(value => ({ value, at: handle.observation(value) }));
    observed.push(observed[2]);
    const decisions: boolean[] = [];
    const pending = observed.reduce((work, { value, at }) => work.then(async () => { decisions.push(await handle.observe(value, at)); }), Promise.resolve());
    await handle.close(true, pending);
    expect(decisions).toEqual([false, false, false, false]);
    const result = (await summary())!;
    expect(result.amount).toBeNull(); expect(result.known_subtotal).toBe("0.131000000000000000");
    expect(result.attempts.find(row => row.id.startsWith("rt-response-"))!.cost?.report_amount).toBe("0.100000000");
    expect(result.reservations.every(row => row.state === "reserved")).toBe(true);
    expect(result.budget_committed_usd).toBe("0.000000000000000000");
  });
  it("counts sent unacknowledged commits against the ASR limit and does not release them on buffer clear", async () => {
    await setup(); const handle = (await begin())!; await handle.dispatched(); handle.opened(); await handle.observe(configured());
    for (let i = 0; i < 2; i++) {
      expect(handle.clientActivity('{"type":"input_audio_buffer.append"}')).toBe(true);
      expect(handle.clientActivity('{"type":"input_audio_buffer.commit"}')).toBe(true);
    }
    expect(handle.clientActivity('{"type":"input_audio_buffer.append"}')).toBe(false);
    expect(handle.clientActivity('{"type":"input_audio_buffer.commit"}')).toBe(false);
    expect(handle.clientActivity('{"type":"input_audio_buffer.clear"}')).toBe(true);
    await handle.observe(event({ type: "input_audio_buffer.cleared", event_id: "clear" })); await handle.close(false);
    const result = (await summary())!;
    expect(result.amount).toBeNull(); expect(result.budget_reserved_usd).toBe("0.280000000000000000");
    expect(result.budget_committed_usd).toBe("0.000000000000000000");
  });
  it("keeps uncompleted ASR expense pending and never prices it as a Realtime response", async () => {
    await setup(); const handle = (await begin())!; await handle.dispatched(); handle.opened(); await handle.observe(configured());
    handle.clientActivity('{"type":"input_audio_buffer.append"}'); await handle.observe(event({ type: "input_audio_buffer.committed", event_id: "commit", item_id: "audio-1" }));
    handle.clientActivity('{"type":"input_audio_buffer.clear"}'); await handle.observe(event({ type: "input_audio_buffer.cleared", event_id: "clear" })); await handle.close(false);
    const result = (await summary())!; expect(result.amount).toBeNull();
    expect(result.reservations.some(row => row.state === "reserved")).toBe(true); expect(result.budget_committed_usd).toBe("0.000000000000000000");
  });
  it("uses the same combined assessment in read-only preview and the two actual reservations", async () => {
    await setup(); const before = await db.query("SELECT * FROM pricing_reservations");
    const preview = await h.agent.post(base + "/admission-preview").send({ target: { node_id: "mock-openai", model: rt, operation: "realtime" }, attempts: 3, context: { attempt_dispatched_at: new Date().toISOString() }, evidence: [{ dimension: "session_seconds", value: "60", source: "heuristic", quality: "estimated" }] });
    expect(preview.status).toBe(201); expect(preview.body.assessment.allowed).toBe(true);
    expect(preview.body.assessment.transcription_allowance).toMatchObject({ model: asr, max_items: 2, reserved_tokens: "240", assessment: { allowed: true, budget_basis: "actual_upstream", reserved_cost_usd: "0.280000000000000000" } });
    expect(preview.body.assessment.combined_reserved_cost_usd).toBe("1.480000000000000000");
    expect(await db.query("SELECT * FROM pricing_reservations")).toEqual(before);
    const handle = (await begin())!; expect((await summary())!.budget_reserved_usd).toBe(preview.body.assessment.combined_reserved_cost_usd); await handle.close(false);
    expect((await summary())!.budget_reserved_usd).toBe("0.000000000000000000");
  });
  it("compensates an earlier reservation if the independent ASR budget cannot be admitted", async () => {
    await setup(); await db.query("UPDATE budget_rules SET limit_value=1.3 WHERE type='daily_cost'");
    await expect(begin()).rejects.toMatchObject({ budgetType: "daily_cost" });
    expect(await db.query("SELECT * FROM pricing_attempts")).toHaveLength(0);
    expect((await summary())!.budget_reserved_usd).toBe("0.000000000000000000");
    expect((await db.query("SELECT current_value FROM budget_rules WHERE type='daily_cost'"))[0].current_value).toBe(0);
  });
  it.each(["audio_transcription", "chat_completions"])("rejects a Realtime ASR declaration on an unrelated operation %s", async operation => {
    expect((await policy(operation, { mode: "compatibility", realtime_transcription: { model: asr, max_items: 2 } })).status).toBe(400);
  });
  it.each([
    { duration: false, scenario: "basic" }, { duration: true, scenario: "basic" },
    { duration: false, scenario: "ordered-updates" }, { duration: false, scenario: "wrong-model" }, { duration: false, scenario: "conflict" }, { duration: false, scenario: "conflict-drain" },
  ])("prices native ASR over WebSocket and enforces pre-send admission (duration=$duration,scenario=$scenario)", async ({ duration, scenario }) => {
    await setup(duration); const upstream = createServer(); let peer: Duplex | undefined, client: WebSocket | undefined, timer: ReturnType<typeof setTimeout> | undefined, ackTimer: ReturnType<typeof setTimeout> | undefined;
    let buffer: Buffer = Buffer.alloc(0), calls = 0, early = -1, sent = false, updates = 0, audioCalls = 0;
    const audioBeforeFinal: number[] = [], conflicting = scenario.startsWith("conflict"), rejected = scenario === "wrong-model" || conflicting;
    const frame = (value: unknown) => { const payload = Buffer.from(JSON.stringify(value)); return Buffer.concat([payload.length < 126 ? Buffer.from([0x81, payload.length]) : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 255]), payload]); };
    upstream.on("upgrade", (request, socket) => {
      peer = socket; socket.on("error", () => undefined);
      const accept = createHash("sha1").update(String(request.headers["sec-websocket-key"]) + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      const acknowledgement = (type: string, eventId: string) => frame({ type, event_id: eventId, session: { audio: { input: { turn_detection: null, transcription: { model: scenario === "wrong-model" ? "other-asr" : asr } } } } });
      if (scenario !== "ordered-updates") ackTimer = setTimeout(() => { early = calls; socket.write(acknowledgement("session.created", "created")); }, 60);
      socket.on("data", chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 2) {
          const opcode = buffer[0] & 15, masked = Boolean(buffer[1] & 128); let size = buffer[1] & 127, offset = 2;
          if (size === 127) { socket.destroy(); return; } if (size === 126) { if (buffer.length < 4) return; size = buffer.readUInt16BE(2); offset = 4; }
          const maskBytes = masked ? 4 : 0; if (buffer.length < offset + maskBytes + size) return;
          const mask = buffer.subarray(offset, offset + maskBytes), payload = Buffer.from(buffer.subarray(offset + maskBytes, offset + maskBytes + size));
          if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4]; buffer = buffer.subarray(offset + maskBytes + size); if (opcode !== 1) continue;
          const command = JSON.parse(payload.toString()) as { type: string }; calls++;
          if (command.type === "session.update" && scenario === "ordered-updates" && ++updates === 2) {
            const phases = [["session.created", "created"], ["session.updated", "updated-1"], ["session.updated", "updated-1"], ["session.updated", "updated-2"]];
            const next = (index: number) => {
              audioBeforeFinal.push(audioCalls); socket.write(acknowledgement(phases[index][0], phases[index][1]));
              if (index + 1 < phases.length) ackTimer = setTimeout(() => next(index + 1), 30);
            };
            ackTimer = setTimeout(() => next(0), 30);
          } else if (command.type === "input_audio_buffer.append" && !sent) {
            audioCalls++;
            sent = true; const receipt = { type: "conversation.item.input_audio_transcription.completed", event_id: "transcript", item_id: "audio-1", content_index: 0, transcript: "PRIVATE", usage: duration ? { type: "duration", seconds: 6.4 } : { type: "tokens", input_tokens: 13, output_tokens: 9, total_tokens: 22, input_token_details: { audio_tokens: 13, text_tokens: 0 } } };
            const second = conflicting ? { ...receipt, event_id: "conflicting", usage: { type: "tokens", input_tokens: 14, output_tokens: 9, total_tokens: 23, input_token_details: { audio_tokens: 14, text_tokens: 0 } } } : receipt;
            const response = { id: "drained-response", status: "completed", usage: { input_tokens: 0, output_tokens: 10, total_tokens: 10, input_token_details: { cached_tokens: 0 } } };
            socket.write(Buffer.concat([frame({ type: "input_audio_buffer.committed", event_id: "commit", item_id: "audio-1" }), frame(receipt), frame(second), ...(scenario === "conflict-drain" ? [frame({ type: "response.created", response }), frame({ type: "response.done", response }), frame({ type: "response.done", response })] : []), ...(rejected ? [] : [frame({ type: "fixture.clear" })])]));
          } else if (command.type === "input_audio_buffer.clear") socket.write(Buffer.concat([frame({ type: "input_audio_buffer.cleared", event_id: "clear" }), frame({ type: "fixture.finished" })]));
        }
      });
    });
    try {
      await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve)); const address = upstream.address(); if (!address || typeof address === "string" || address.port === 2099) throw new Error("Unsafe ASR fixture port");
      h.app.get(ConfigService).getNode("mock-openai")!.realtime_endpoint = `ws://127.0.0.1:${address.port}/realtime`;
      const port = h.app.getHttpServer().address().port; expect(port).not.toBe(2099);
      client = new WebSocket(`ws://127.0.0.1:${port}/v1/realtime?model=${rt}`, { headers: { Authorization: `Bearer ${API_KEY}` } });
      await new Promise<void>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error("ASR WebSocket timeout")), 5000);
        client!.addEventListener("error", () => reject(new Error("ASR client failed")));
        client!.addEventListener("open", () => {
          if (scenario === "ordered-updates") {
            client!.send('{"type":"session.update","session":{"instructions":"PRIVATE"}}');
            client!.send('{"type":"session.update","session":{"audio":{"input":{"transcription":{"model":"synthetic-asr"}}}}}');
          }
          client!.send('{"type":"input_audio_buffer.append","audio":"UFJJVkFURQ=="}');
        });
        if (rejected) client!.addEventListener("close", () => resolve(), { once: true });
        client!.addEventListener("message", reply => { const value = JSON.parse(String(reply.data)) as { type: string }; if (value.type === "fixture.clear") client!.send('{"type":"input_audio_buffer.clear"}'); if (value.type === "fixture.finished") resolve(); });
      });
      clearTimeout(timer); const proxy = h.app.get(RealtimeProxyService), requestId = proxy.getStatus(key.workspace_id).recent[0].request_id;
      if (!rejected) { const closed = new Promise<void>(resolve => client!.addEventListener("close", () => resolve(), { once: true })); client.close(1000); await closed; }
      await proxy.onModuleDestroy();
      const result = (await h.app.get(CostLedgerService).summary(requestId, key.workspace_id))!;
      if (scenario === "ordered-updates") expect(audioBeforeFinal).toEqual([0, 0, 0, 0]); else expect(early).toBe(0);
      expect(calls).toBe(scenario === "ordered-updates" ? 4 : scenario === "wrong-model" ? 0 : conflicting ? 1 : 2);
      expect(result.amount).toBe(rejected ? null : duration ? "0.640000000000000000" : "0.031000000000000000");
      expect(result.budget_committed_usd).toBe(rejected ? "0.000000000000000000" : result.amount);
      if (conflicting) expect(result.known_subtotal).toBe(scenario === "conflict-drain" ? "0.131000000000000000" : "0.031000000000000000");
      expect(result.attempts.filter(row => row.fee_source === "provider" && row.model === asr)).toHaveLength(scenario === "wrong-model" ? 0 : 1);
      expect(JSON.stringify(result)).not.toMatch(/PRIVATE|UFJJVk/);
    } finally { if (timer) clearTimeout(timer); if (ackTimer) clearTimeout(ackTimer); client?.close(); peer?.destroy(); if (upstream.listening) await new Promise<void>(resolve => upstream.close(() => resolve())); }
  }, 15000);
});

import { strict as assert } from "node:assert";
import type { PricingRepository } from "../../src/pricing/pricing-repository";
import type { RealtimePricingHandle } from "../../src/pricing/realtime-pricing.service";
import { realtimePricingEvent } from "../../src/pricing/realtime-metering";
import type { GatewayApiKeyContext } from "../../src/auth/gateway-api-key.service";
import { book, rate } from "../unit/pricing-fixtures";

export const asrWorkspace = "default-workspace";
export const asrActor = { id: "synthetic-admin", workspace_id: asrWorkspace, role: "admin" as const, global_admin: true };
export const asrKey = { id: "synthetic", name: "synthetic", workspace_id: asrWorkspace, namespace_id: null } as GatewayApiKeyContext;
export const asrModel = "synthetic-asr", realtimeModel = "realtime-model";
export const asrEvent = (body: unknown) => { const event = realtimePricingEvent(JSON.stringify(body)); assert(event); return event; };
export const asrReceipt = (duration: boolean, input = 13) => asrEvent({ type: "conversation.item.input_audio_transcription.completed", event_id: "transcript", item_id: "audio", content_index: 0, transcript: "PRIVATE", usage: duration
  ? { type: "duration", seconds: 6.4 }
  : { type: "tokens", input_tokens: input, output_tokens: 9, total_tokens: input + 9, input_token_details: { audio_tokens: input, text_tokens: 0 } } });

/** Synthetic catalog only; never reads deployed configuration or sends audio. */
export async function configureAsrFixture(prices: PricingRepository, duration = false, nonTokenRealtime = false) {
  let version = "";
  for (const [model, operation, content] of [
    [realtimeModel, "realtime", book([rate("rt", nonTokenRealtime ? "request_count" : "output_tokens", "0.01", "1")])],
    [asrModel, "audio_transcription", duration ? book([rate("duration", "audio_input_seconds", "0.1", "1")]) : book([rate("input", "uncached_input_tokens", "0.001", "1"), rate("output", "output_tokens", "0.002", "1")])],
  ] as const) {
    const created = await prices.createBook(asrActor, { name: "Synthetic " + model, scope: "workspace", content });
    const catalog_revision = (await prices.listBindings(asrActor)).head.revision;
    const published = await prices.publishDraft(asrActor, created.draft.id, { draft_revision: 1, catalog_revision, reason: "Synthetic separate ASR tariff", confirm: true, targets: [{ level: "model", model, operation }] });
    if (model === asrModel) version = published.version_id;
  }
  await prices.updateAdmissionPolicy(asrActor, { catalog_revision: (await prices.listBindings(asrActor)).head.revision, scope: "workspace", operation: "audio_transcription", reason: "Synthetic ASR allowance", confirm: true,
    policy: { mode: "reserve_upper_bound", budget_basis: "actual_upstream", ...(duration ? { token_budget: "not_applicable" } : {}),
      quantity_limits: duration ? { audio_input_seconds: "10" } : { total_input_tokens: "100", output_tokens: "20" }, limit_reference: "Synthetic bounds" } });
  await prices.updateAdmissionPolicy(asrActor, { catalog_revision: (await prices.listBindings(asrActor)).head.revision, scope: "workspace", operation: "realtime", reason: "Synthetic Realtime allowance", confirm: true,
    policy: { mode: "reserve_upper_bound", budget_basis: "actual_upstream", ...(nonTokenRealtime ? { token_budget: "not_applicable" } : {}), realtime_max_responses: 2, realtime_transcription: { model: asrModel, max_items: 2 },
      quantity_limits: nonTokenRealtime ? { request_count: "1", session_seconds: "60" } : { total_input_tokens: "100", output_tokens: "40", session_seconds: "60" }, limit_reference: "Synthetic bounds" } });
  return version;
}

export async function observeAsrFixture(handle: RealtimePricingHandle, duration: boolean, withReceipt = true) {
  await handle.dispatched(); handle.opened();
  await handle.observe(asrEvent({ type: "session.created", event_id: "created", session: { audio: { input: { turn_detection: null, transcription: { model: asrModel } } } } }));
  assert.equal(handle.clientActivity('{"type":"input_audio_buffer.append","audio":"PRIVATE"}'), true);
  assert.equal(handle.clientActivity('{"type":"input_audio_buffer.commit"}'), true);
  await handle.observe(asrEvent({ type: "input_audio_buffer.committed", event_id: "commit", item_id: "audio" }));
  if (withReceipt) await handle.observe(asrReceipt(duration));
  assert.equal(handle.clientActivity('{"type":"input_audio_buffer.clear"}'), true);
  await handle.observe(asrEvent({ type: "input_audio_buffer.cleared", event_id: "clear" }));
}

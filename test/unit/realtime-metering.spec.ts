import {
  realtimePricingEvent,
  realtimeSessionUsage,
} from "../../src/pricing/realtime-metering";
import { book, quote, rate } from "./pricing-fixtures";

const report = (id = "response-1") => ({
  type: "response.done",
  event_id: "event-1",
  response: {
    id,
    status: "completed",
    output: [{ content: "PRIVATE-TRANSCRIPT" }],
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      total_tokens: 120,
      input_token_details: {
        text_tokens: 60,
        audio_tokens: 30,
        image_tokens: 10,
        cached_tokens: 40,
        cached_tokens_details: {
          text_tokens: 30,
          audio_tokens: 10,
          image_tokens: 0,
        },
      },
      output_token_details: { text_tokens: 5, audio_tokens: 15 },
    },
  },
});
describe("Realtime metering without content retention", () => {
  it("captures only audio custody identities, never transcript/audio content or ASR money at Realtime rates", () => {
    for (const type of ["input_audio_buffer.committed", "conversation.item.input_audio_transcription.completed", "conversation.item.input_audio_transcription.failed"]) {
      const parsed = realtimePricingEvent(JSON.stringify({ type, event_id: "event", item_id: "item", transcript: "PRIVATE", audio: "PRIVATE", error: { message: "PRIVATE" }, usage: { type: "duration", seconds: 9 } }))!;
      expect(parsed.kind).toBe("audio_custody"); expect(parsed.audioCustody).toMatchObject({ eventId: "event", itemId: "item" });
      expect(parsed.usage).toBeUndefined(); expect(JSON.stringify(parsed)).not.toContain("PRIVATE");
    }
    expect(realtimePricingEvent('{"type":"input_audio_buffer.cleared","event_id":"clear"}')?.audioCustody).toEqual({ action: "cleared", eventId: "clear" });
    expect(realtimePricingEvent('{"type":"input_audio_buffer.committed","event_id":"clear"}')?.kind).toBe("uncertain");
    expect(realtimePricingEvent('{"type":"input_audio_buffer.cleared"}')?.kind).toBe("uncertain");
  });
  it("distinguishes default-conversation responses from unbound or explicitly out-of-band responses", () => {
    for (const conversation_id of [undefined, null, "conversation-1"]) {
      const parsed = realtimePricingEvent(JSON.stringify({ type: "response.created", response: { id: "response", conversation_id } }))!;
      expect(parsed.defaultConversation).toBe(conversation_id === "conversation-1");
    }
  });
  it("extracts exact nonoverlapping input/cache/output usage and does not retain content", () => {
    const event = realtimePricingEvent(JSON.stringify(report()))!;
    expect(event.kind).toBe("done");
    expect(event.usage!.quantities.uncached_audio_input_tokens?.value).toBe(
      "20",
    );
    expect(event.usage!.quantities.audio_output_tokens?.value).toBe("15");
    expect(event.usage!.quantities.session_seconds?.value).toBe("0");
    expect(event.usage!.diagnostics).toEqual([]);
    expect(JSON.stringify(event)).not.toContain("PRIVATE");
    expect(
      quote(
        book([rate("audio", "audio_output_tokens", "1", "1")]),
        event.usage!,
      ).amount,
    ).toBe("15.000000000");
    const changed = report();
    changed.event_id = "other";
    changed.response.output = [{ content: "DIFFERENT-PRIVATE-CONTENT" }];
    expect(realtimePricingEvent(JSON.stringify(changed))!.hash).toBe(
      event.hash,
    );
  });
  it("keeps missing counts unknown and ignores nonbilling deltas without inventing fees", () => {
    expect(
      realtimePricingEvent('{"type":"response.audio.delta","delta":"PRIVATE"}'),
    ).toBeNull();
    const event = realtimePricingEvent(
      '{"type":"response.done","response":{"id":"a","status":"failed"}}',
    )!;
    expect(event.usage!.quantities.total_input_tokens?.value).toBeNull();
    expect(event.usage!.quantities.output_tokens?.value).toBeNull();
    expect(event.status).toBe("failed");
  });
  it.each([-1, "1e4", "1.5", {}, Number.MAX_SAFE_INTEGER + 1])(
    "diagnoses invalid exact usage %p",
    (value) => {
      const raw = report();
      const usage = raw.response.usage as Record<string, unknown>;
      usage.input_tokens = value;
      const event = realtimePricingEvent(JSON.stringify(raw))!;
      expect(event.usage!.diagnostics.length).toBeGreaterThan(0);
    },
  );
  it("does not infer uncached input modalities from absent cached-token detail", () => {
    const raw = report();
    delete (raw.response.usage.input_token_details as Record<string, unknown>)
      .cached_tokens_details;
    expect(
      realtimePricingEvent(JSON.stringify(raw))!.usage!.quantities
        .uncached_audio_input_tokens?.value,
    ).toBeNull();
  });
  it("detects incompatible totals and bounded malformed events", () => {
    const raw = report();
    raw.response.usage.total_tokens = 119;
    expect(
      realtimePricingEvent(JSON.stringify(raw))!.usage!.diagnostics[0].code,
    ).toBe("pricing_usage_conflict");
    expect(realtimePricingEvent("x".repeat(1024 * 1024 + 1))?.kind).toBe(
      "uncertain",
    );
    expect(realtimePricingEvent("not-json")?.kind).toBe("uncertain");
    expect(
      realtimePricingEvent(
        '{"type":"response.done","response":{"id":"private invalid id"}}',
      )?.kind,
    ).toBe("uncertain");
  });
  it("keeps session measurement separate from response counts and exposes uncertain closure", () => {
    const usage = realtimeSessionUsage("1.234567891");
    expect(usage.quantities.request_count?.value).toBe("0");
    expect(usage.quantities.output_tokens?.value).toBe("0");
    expect(
      quote(book([rate("seconds", "session_seconds", "1", "1")]), usage).amount,
    ).toBe("1.234567891");
    expect(
      realtimeSessionUsage("1", true).quantities.output_tokens?.value,
    ).toBeNull();
    expect(realtimeSessionUsage("1", true).quantities.request_count?.value).toBeNull();
    expect(quote(book([rate("response", "request_count", "0.01", "1")]), realtimeSessionUsage("1", true)).amount).toBeNull();
  });
});

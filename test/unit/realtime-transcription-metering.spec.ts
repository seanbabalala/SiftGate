import { realtimeTranscriptionReceipt } from "../../src/pricing/realtime-transcription-metering";
import { realtimePricingEvent } from "../../src/pricing/realtime-metering";
import { book, rate, quote } from "./pricing-fixtures";

const event = (usage?: unknown) => ({ type: "conversation.item.input_audio_transcription.completed", event_id: "event", item_id: "item", content_index: 0, transcript: "PRIVATE", logprobs: [{ token: "PRIVATE" }], usage });
describe("independent Realtime ASR native metering", () => {
  it("uses ASR token totals and modality subsets without retaining text or multiplying repeated reports", () => {
    const parsed = realtimeTranscriptionReceipt(event({ type: "tokens", input_tokens: 13, output_tokens: 9, total_tokens: 22, input_token_details: { text_tokens: 0, audio_tokens: 13 } }))!;
    expect(parsed.usage.diagnostics).toEqual([]); expect(parsed.usage.quantities.uncached_audio_input_tokens?.value).toBe("13");
    expect(quote(book([rate("input", "uncached_input_tokens", "1", "1"), rate("output", "output_tokens", "2", "1")]), parsed.usage).amount).toBe("31.000000000");
    expect(JSON.stringify(parsed)).not.toContain("PRIVATE");
    expect(realtimeTranscriptionReceipt({ ...event({ type: "tokens", input_tokens: 13, output_tokens: 9, total_tokens: 22, input_token_details: { text_tokens: 0, audio_tokens: 13 } }), transcript: "other" })!.hash).toBe(parsed.hash);
  });
  it("prices explicit duration separately and keeps token counts unknown", () => {
    const parsed = realtimeTranscriptionReceipt(event({ type: "duration", seconds: 6.4 }))!;
    expect(parsed.usage.quantities.total_input_tokens?.value).toBeNull();
    expect(quote(book([rate("duration", "audio_input_seconds", "0.1", "1")]), parsed.usage).amount).toBe("0.640000000");
    expect(parsed.usage.quantities.request_count?.value).toBe("1");
  });
  it.each([-1, "NaN", Infinity, Number.MAX_SAFE_INTEGER + 1])("does not coerce invalid ASR quantities %p", input => {
    const parsed = realtimeTranscriptionReceipt(event({ type: "tokens", input_tokens: input, output_tokens: 1, total_tokens: 2 }))!;
    expect(parsed.usage.diagnostics.length).toBeGreaterThan(0);
  });
  it("diagnoses inconsistent totals, failed or missing usage, and malformed identities", () => {
    expect(realtimeTranscriptionReceipt(event({ type: "tokens", input_tokens: 3, output_tokens: 4, total_tokens: 8 }))!.usage.diagnostics.some(d => d.code === "pricing_usage_conflict")).toBe(true);
    const failed = realtimeTranscriptionReceipt({ ...event(), type: "conversation.item.input_audio_transcription.failed", error: { message: "PRIVATE" } })!;
    expect(failed.status).toBe("failed"); expect(failed.usage.quantities.audio_input_seconds?.value).toBeNull();
    expect(realtimeTranscriptionReceipt({ ...event(), content_index: -1 })).toBeNull();
    const parsed = realtimePricingEvent(JSON.stringify(event({ type: "duration", seconds: 1 })))!;
    expect(parsed.transcription?.usage.quantities.audio_input_seconds?.value).toBe("1"); expect(JSON.stringify(parsed)).not.toContain("PRIVATE");
  });
});

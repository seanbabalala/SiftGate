import { RealtimeWorkCustody, realtimeCorrelation, realtimeSessionMode } from "../../src/pricing/realtime-work-custody";
import { realtimePricingEvent } from "../../src/pricing/realtime-metering";

const generation = (metadata?: Record<string, string>) => JSON.stringify({ type: "response.create", response: { metadata } });
const manual = { manual: true, transcriptionDisabled: true };
describe("Realtime sent work custody", () => {
  it("requires explicit supplier-acknowledged manual mode, not an absent field or client wish", () => {
    expect(realtimeSessionMode({})).toEqual({ manual: false, transcriptionDisabled: false });
    expect(realtimeSessionMode({ audio: { input: { turn_detection: null, transcription: null } } })).toEqual(manual);
    expect(realtimeSessionMode({ turn_detection: null, input_audio_transcription: null })).toEqual(manual);
    const event = realtimePricingEvent(JSON.stringify({ type: "session.updated", session: { instructions: "PRIVATE", audio: { input: { turn_detection: null, transcription: null } } } }));
    expect(event?.sessionMode).toEqual(manual); expect(JSON.stringify(event)).not.toContain("PRIVATE");
  });
  it("does not acknowledge two parallel generations with one created response", () => {
    const tracker = new RealtimeWorkCustody(3); tracker.configured(manual);
    tracker.sent(generation()); tracker.sent(generation()); tracker.createdResponse(2);
    expect(tracker.unresolved()).toBe(true); tracker.createdResponse(2); expect(tracker.unresolved()).toBe(false);
  });
  it("does not acknowledge a newer generation with an older transport observation", () => {
    const tracker = new RealtimeWorkCustody(3); tracker.configured(manual);
    tracker.sent(generation()); const sequence = tracker.sequence; tracker.sent(generation());
    tracker.createdResponse(sequence); tracker.createdResponse(sequence); expect(tracker.unresolved()).toBe(true);
  });
  it("does not use an automatic response as acknowledgement of an uncorrelated manual command", () => {
    const tracker = new RealtimeWorkCustody(3); tracker.sent(generation()); tracker.createdResponse(1); expect(tracker.unresolved()).toBe(true);
  });
  it("correlates parallel out-of-order metadata without retaining private values", () => {
    const tracker = new RealtimeWorkCustody(3);
    tracker.sent(generation({ request: "PRIVATE-A" })); tracker.sent(generation({ request: "PRIVATE-B" }));
    tracker.createdResponse(2, realtimeCorrelation({ request: "PRIVATE-B" })); expect(tracker.unresolved()).toBe(true);
    tracker.createdResponse(2, realtimeCorrelation({ request: "PRIVATE-A" })); expect(tracker.unresolved()).toBe(false);
    expect(JSON.stringify(tracker)).not.toContain("PRIVATE");
  });
  it("does not arbitrarily resolve duplicate or malformed correlations", () => {
    const tracker = new RealtimeWorkCustody(3); tracker.configured(manual);
    tracker.sent(generation({ request: "same" })); tracker.sent(generation({ request: "same" }));
    tracker.createdResponse(2, realtimeCorrelation({ request: "same" })); expect(tracker.unresolved()).toBe(true);
    expect(realtimeCorrelation({ request: {} })).toBeUndefined(); expect(realtimeCorrelation({ a: "x".repeat(513) })).toBeUndefined();
  });
  it("does not ignore a mismatching correlation just because manual generation is enabled", () => {
    const tracker = new RealtimeWorkCustody(3); tracker.configured(manual); tracker.sent(generation({ request: "a" }));
    tracker.createdResponse(1, realtimeCorrelation({ request: "other" })); expect(tracker.unresolved()).toBe(true);
  });
  it("invalidates manual assumptions while configuration is unacknowledged", () => {
    const tracker = new RealtimeWorkCustody(3); tracker.configured(manual);
    tracker.sent('{"type":"session.update","session":{"audio":{"input":{"turn_detection":{"type":"server_vad"}}}}}');
    tracker.sent(generation()); tracker.createdResponse(1); expect(tracker.unresolved()).toBe(true);
  });
  it("keeps unclassified audio work pending but does not invent inference from known manual control messages", () => {
    const auto = new RealtimeWorkCustody(3); auto.sent('{"type":"input_audio_buffer.append","audio":"PRIVATE"}'); auto.createdResponse(1); expect(auto.unresolved()).toBe(true);
    const known = new RealtimeWorkCustody(3); known.configured(manual);
    for (const type of ["input_audio_buffer.append", "input_audio_buffer.commit", "response.cancel", "conversation.item.create"])
      expect(known.sent(JSON.stringify({ type }))).toBe(true);
    expect(known.unresolved()).toBe(false);
  });
  it("rejects excess explicit generation before dispatch and never clears malformed work", () => {
    const tracker = new RealtimeWorkCustody(1); tracker.configured(manual); expect(tracker.sent(generation())).toBe(true);
    expect(tracker.sent(generation())).toBe(false); tracker.createdResponse(1); expect(tracker.sent(generation())).toBe(false);
    const unknown = new RealtimeWorkCustody(2); unknown.sent("not-json"); unknown.createdResponse(1); expect(unknown.unresolved()).toBe(true);
  });
  it("recognizes explicit VAD response-off as manual but does not assume an omitted generation setting", () => {
    expect(realtimeSessionMode({ audio: { input: { turn_detection: { type: "server_vad", create_response: false }, transcription: null } } })).toEqual(manual);
    expect(realtimeSessionMode({ turn_detection: { type: "semantic_vad", create_response: true }, input_audio_transcription: null })).toEqual({ manual: false, transcriptionDisabled: true, automatic: true });
    expect(realtimeSessionMode({ turn_detection: { type: "server_vad" }, input_audio_transcription: null })).toEqual({ manual: false, transcriptionDisabled: true });
    expect(realtimeSessionMode({ turn_detection: { type: "server_vad", create_response: false, idle_timeout_ms: 6000 }, input_audio_transcription: null }).manual).toBe(false);
  });
  it("requires both automatic-response custody and an acknowledged clear for trailing audio", () => {
    const tracker = new RealtimeWorkCustody(3); tracker.configured({ manual: false, transcriptionDisabled: true, automatic: true });
    tracker.sent('{"type":"input_audio_buffer.append","audio":"PRIVATE"}');
    tracker.receivedAudio({ action: "committed", eventId: "commit-1", itemId: "item-1" }, tracker.sequence);
    tracker.receivedResponse("response-1", tracker.sequence, undefined, true);
    expect(tracker.unresolved()).toBe(true);
    tracker.sent('{"type":"input_audio_buffer.clear"}'); tracker.receivedAudio({ action: "cleared", eventId: "clear-1" }, tracker.sequence);
    expect(tracker.unresolved()).toBe(false); expect(JSON.stringify(tracker)).not.toContain("PRIVATE");
  });
  it("does not use a buffer clear as acknowledgement of generated or independent ASR work", () => {
    for (const transcriptionDisabled of [false, true]) {
      const tracker = new RealtimeWorkCustody(3); tracker.configured({ manual: false, transcriptionDisabled, automatic: true });
      tracker.sent('{"type":"input_audio_buffer.append"}'); tracker.receivedAudio({ action: "committed", eventId: "commit", itemId: "item" }, 1);
      tracker.sent('{"type":"input_audio_buffer.clear"}'); tracker.receivedAudio({ action: "cleared", eventId: "clear" }, 1);
      expect(tracker.unresolved()).toBe(true);
      tracker.receivedResponse("response", 1, undefined, true);
      expect(tracker.unresolved()).toBe(!transcriptionDisabled);
    }
  });
  it("deduplicates commit/response/clear events without acknowledging newer audio or extra turns", () => {
    const tracker = new RealtimeWorkCustody(4); tracker.configured({ manual: false, transcriptionDisabled: true, automatic: true });
    tracker.sent('{"type":"input_audio_buffer.append"}');
    const commit = { action: "committed" as const, eventId: "commit", itemId: "one" };
    tracker.receivedAudio(commit, 1); tracker.receivedAudio({ ...commit, eventId: "another" }, 1);
    tracker.sent('{"type":"input_audio_buffer.clear"}');
    tracker.sent('{"type":"input_audio_buffer.append"}');
    tracker.receivedAudio({ action: "committed", eventId: "commit-2", itemId: "two" }, 2);
    tracker.receivedAudio({ action: "cleared", eventId: "clear" }, 2);
    tracker.receivedResponse("r1", 1, undefined, true); tracker.receivedResponse("r1", 2, undefined, true);
    expect(tracker.unresolved()).toBe(true);
    tracker.sent('{"type":"input_audio_buffer.clear"}'); tracker.receivedAudio({ action: "cleared", eventId: "clear" }, 2);
    tracker.receivedResponse("r2", 2, undefined, true); expect(tracker.unresolved()).toBe(true);
    tracker.receivedAudio({ action: "cleared", eventId: "clear-2" }, 2); expect(tracker.unresolved()).toBe(false);
  });
  it("never takes an out-of-band or uncorrelated manual response as the automatic turn", () => {
    for (const manualSend of [false, true]) {
      const tracker = new RealtimeWorkCustody(3); tracker.configured({ manual: false, transcriptionDisabled: true, automatic: true });
      tracker.sent('{"type":"input_audio_buffer.append"}'); tracker.receivedAudio({ action: "committed", eventId: "commit", itemId: "item" }, 1);
      if (manualSend) tracker.sent(generation());
      tracker.receivedResponse("response", tracker.sequence, undefined, manualSend);
      tracker.sent('{"type":"input_audio_buffer.clear"}'); tracker.receivedAudio({ action: "cleared", eventId: "clear" }, tracker.sequence);
      expect(tracker.unresolved()).toBe(true);
    }
  });
  it("independent transcription can never be settled by a matching Realtime response or clear", () => {
    const tracker = new RealtimeWorkCustody(2); tracker.configured(manual);
    tracker.receivedAudio({ action: "independent_transcription", eventId: "transcript", itemId: "audio" }, 0);
    tracker.receivedResponse("response", 0, undefined, true); tracker.sent('{"type":"input_audio_buffer.clear"}'); tracker.receivedAudio({ action: "cleared", eventId: "clear" }, 0);
    expect(tracker.unresolved()).toBe(true);
  });
  it("counts transport-observed automatic creations before allowing more explicit generation", () => {
    const tracker = new RealtimeWorkCustody(1); tracker.configured({ manual: false, transcriptionDisabled: true, automatic: true });
    tracker.receivedAudio({ action: "committed", eventId: "commit", itemId: "item" }, 0);
    expect(tracker.sent(generation())).toBe(false); tracker.receivedResponse("auto", 0, undefined, true);
    expect(tracker.sent(generation())).toBe(false);
  });
  it("bounds control acknowledgements and cannot clear unknown data after overflowing evidence identity storage", () => {
    const tracker = new RealtimeWorkCustody(1);
    for (let i = 0; i < 1024; i++) expect(tracker.sent('{"type":"input_audio_buffer.clear"}')).toBe(true);
    expect(tracker.sent('{"type":"input_audio_buffer.clear"}')).toBe(false);
    for (let i = 0; i < 4097; i++) tracker.receivedAudio({ action: "cleared", eventId: `clear-${i}` }, 0);
    expect(tracker.unresolved()).toBe(true);
  });
});

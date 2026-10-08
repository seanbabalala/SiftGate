import { createHash } from "node:crypto";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as ObjectValue : undefined;

/** Ephemeral correlation only. Never persist metadata values or rewrite wire payloads. */
export function realtimeCorrelation(value: unknown): string | undefined {
  const row = object(value);
  if (!row) return undefined;
  const keys = Object.keys(row).sort();
  if (!keys.length || keys.length > 16 || keys.some(key => key.length > 64 || typeof row[key] !== "string" || (row[key] as string).length > 512)) return undefined;
  return createHash("sha256").update(JSON.stringify(keys.map(key => [key, row[key]]))).digest("hex");
}

export interface RealtimeSessionMode {
  manual: boolean;
  transcriptionDisabled: boolean;
  automatic?: true;
  transcriptionModel?: string;
}

export interface RealtimeAudioCustodyEvent {
  action: "committed" | "cleared" | "independent_transcription";
  eventId: string;
  itemId?: string;
}

/** Only an explicit supplier acknowledgement can establish manual generation. */
export function realtimeSessionMode(value: unknown): RealtimeSessionMode {
  const session = object(value), input = object(object(session?.audio)?.input);
  const turn = input && Object.hasOwn(input, "turn_detection") ? input.turn_detection : session?.turn_detection;
  const transcription = input && Object.hasOwn(input, "transcription") ? input.transcription : session?.input_audio_transcription;
  const detection = object(turn), knownVad = detection?.type === "server_vad" || detection?.type === "semantic_vad";
  const idleDisabled = detection?.idle_timeout_ms === undefined || detection.idle_timeout_ms === null;
  return { manual: turn === null || (knownVad && detection?.create_response === false && idleDisabled), transcriptionDisabled: transcription === null,
    ...(typeof object(transcription)?.model === "string" && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(object(transcription)!.model as string) ? { transcriptionModel: object(transcription)!.model as string } : {}),
    ...(knownVad && detection?.create_response === true ? { automatic: true as const } : {}) };
}

interface SentGeneration { sequence: number; correlation?: string; manual: boolean }

/** Bounded sent-but-unacknowledged work. One creation cannot consume several sends. */
export class RealtimeWorkCustody {
  sequence = 0;
  private mode: RealtimeSessionMode = { manual: false, transcriptionDisabled: false };
  private pending: SentGeneration[] = [];
  private ambiguous = false;
  private created = 0;
  private audioSequence = 0;
  private clearedAudioSequence = 0;
  private clearRequests: number[] = [];
  private committedAudio = new Set<string>();
  private automatic: Array<{ itemId: string; sequence: number }> = [];
  private audioEvents = new Map<string, string>();
  private responseIds = new Set<string>();
  constructor(private readonly maximum: number, private readonly independentTranscription = false) {}

  configured(mode: RealtimeSessionMode): void { this.mode = { ...mode }; }

  /** Returns false before sending a generation that exceeds the explicit session allowance. */
  sent(text?: string): boolean {
    let row: ObjectValue | undefined;
    try { row = text && Buffer.byteLength(text) <= 1024 * 1024 ? object(JSON.parse(text)) : undefined; }
    catch { /* Unknown client messages must never clear custody. */ }
    const type = row?.type;
    if (type === "response.create") {
      if (this.created + this.pending.length + this.automatic.length >= this.maximum) return false;
      this.pending.push({ sequence: ++this.sequence, correlation: realtimeCorrelation(object(row?.response)?.metadata), manual: this.mode.manual });
    } else if (type === "session.update") {
      // An unacknowledged configuration change must not inherit the old mode.
      this.mode = { manual: false, transcriptionDisabled: false };
    } else if (type === "input_audio_buffer.append" || type === "input_audio_buffer.commit") {
      if (!this.mode.manual || !this.mode.transcriptionDisabled) this.audioSequence = ++this.sequence;
    } else if (type === "input_audio_buffer.clear") {
      if (this.clearRequests.length >= 1024) return false;
      // The acknowledgement only covers audio preceding THIS command, never
      // newer bytes that happen to be sent before the acknowledgement arrives.
      this.clearRequests.push(this.audioSequence);
    } else if (type === "conversation.item.create") {
      const content = object(row?.item)?.content;
      if (Array.isArray(content) && content.some(part => object(part)?.type === "input_audio") && !this.mode.transcriptionDisabled && !this.independentTranscription)
        this.ambiguous = true;
    } else if (!["response.cancel", "conversation.item.delete", "conversation.item.truncate", "conversation.item.retrieve", "output_audio_buffer.clear"].includes(String(type))) {
      this.sequence++; this.ambiguous = true;
    }
    return true;
  }

  /** Apply at transport receipt, before forwarding or awaiting ledger work. */
  receivedResponse(responseId: string, sequence: number, correlation?: string, defaultConversation = false): void {
    if (this.responseIds.has(responseId)) return;
    if (this.responseIds.size >= this.maximum + 1) { this.ambiguous = true; return; }
    this.responseIds.add(responseId);
    this.createdResponse(sequence, correlation, defaultConversation);
  }

  receivedAudio(event: RealtimeAudioCustodyEvent, observedSequence: number): void {
    const signature = JSON.stringify([event.action, event.itemId ?? null]);
    const previous = this.audioEvents.get(event.eventId);
    if (previous !== undefined) { if (previous !== signature) this.ambiguous = true; return; }
    if (this.audioEvents.size >= 4096) { this.ambiguous = true; return; }
    this.audioEvents.set(event.eventId, signature);
    if (event.action === "independent_transcription") {
      // ASR has its own model/tariff. Never acknowledge it with a Realtime
      // response or price it using that response's contract.
      if (!this.independentTranscription) this.ambiguous = true;
      return;
    }
    if (event.action === "cleared") {
      const through = this.clearRequests.shift();
      if (through === undefined) return;
      this.clearedAudioSequence = Math.max(this.clearedAudioSequence, through);
      return;
    }
    if (!event.itemId) { this.ambiguous = true; return; }
    if (this.committedAudio.has(event.itemId)) return;
    if (this.committedAudio.size >= this.maximum + 1) { this.ambiguous = true; return; }
    this.committedAudio.add(event.itemId);
    if (!this.mode.transcriptionDisabled && !this.independentTranscription) this.ambiguous = true;
    if (this.mode.automatic) this.automatic.push({ itemId: event.itemId, sequence: observedSequence });
    else if (!this.mode.manual) this.ambiguous = true;
    // A committed turn does not establish that later/trailing audio is empty.
    // Only the matching clear acknowledgement can discard that buffer custody.
  }

  createdResponse(observedSequence: number, correlation?: string, defaultConversation = false): void {
    this.created++;
    const candidates = this.pending.filter(entry => entry.sequence <= observedSequence);
    const matching = correlation ? candidates.filter(entry => entry.correlation === correlation) : [];
    const acknowledged = matching.length === 1 ? matching[0]
      : !correlation && this.mode.manual && this.automatic.length === 0 && candidates.length > 0 && candidates.every(entry => entry.manual) ? candidates[0]
      : undefined;
    if (acknowledged) this.pending.splice(this.pending.indexOf(acknowledged), 1);
    // Duplicate correlation is ambiguous, not an arbitrary FIFO acknowledgement.
    if (matching.length > 1) this.ambiguous = true;
    if (!acknowledged && !correlation && defaultConversation && this.pending.length === 0) {
      const index = this.automatic.findIndex(entry => entry.sequence <= observedSequence);
      if (index >= 0) this.automatic.splice(index, 1);
    }
  }

  unresolved(): boolean { return this.ambiguous || this.pending.length > 0 || this.automatic.length > 0 || this.audioSequence > this.clearedAudioSequence; }
}

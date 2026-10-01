import { ExactDecimal } from "./exact-decimal";
import {
  normalizeCanonicalTokenUsage,
  normalizeQuantities,
  normalizeTokenModalityUsage,
} from "./usage-normalizer";
import {
  DIMENSION_UNITS,
  type MeterDimension,
  type NormalizedUsage,
} from "./pricing.types";
import { pricingContentHash } from "./pricing-json";
import { realtimeCorrelation, realtimeSessionMode, type RealtimeSessionMode, type RealtimeAudioCustodyEvent } from "./realtime-work-custody";
import { realtimeTranscriptionReceipt, type RealtimeTranscriptionReceipt } from "./realtime-transcription-metering";

const adapter = {
  adapter_id: "openai-realtime-response",
  adapter_version: "1",
  source: "provider_usage" as const,
};
const own = (value: unknown, key: string): unknown =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.hasOwn(value, key)
    ? (value as Record<string, unknown>)[key]
    : undefined;
const id = (value: unknown): string | null =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value)
    ? value
    : null;
export interface RealtimePricingEvent {
  kind: "created" | "done" | "uncertain" | "session_mode" | "audio_custody";
  responseId?: string;
  usage?: NormalizedUsage;
  status?: string;
  hash: string;
  correlation?: string;
  sessionMode?: RealtimeSessionMode;
  sessionAcknowledgement?: { kind: "created" | "updated"; eventId?: string };
  audioCustody?: RealtimeAudioCustodyEvent;
  defaultConversation?: boolean;
  transcription?: RealtimeTranscriptionReceipt;
}

/** Allowlisted metering only. No audio, transcripts, instructions, tool arguments or provider secrets survive. */
export function realtimePricingEvent(
  text: string,
): RealtimePricingEvent | null {
  if (Buffer.byteLength(text) > 1024 * 1024)
    return { kind: "uncertain", hash: "oversized-event" };
  let event: unknown;
  try {
    event = JSON.parse(text);
  } catch {
    return { kind: "uncertain", hash: "invalid-json" };
  }
  const type = own(event, "type");
  if (type === "session.created" || type === "session.updated") {
    const sessionMode = realtimeSessionMode(own(event, "session"));
    const eventId = id(own(event, "event_id"));
    return { kind: "session_mode", sessionMode,
      sessionAcknowledgement: { kind: type === "session.created" ? "created" : "updated", ...(eventId ? { eventId } : {}) },
      hash: pricingContentHash(sessionMode) };
  }
  if (type === "input_audio_buffer.committed" || type === "input_audio_buffer.cleared" ||
      type === "conversation.item.input_audio_transcription.completed" || type === "conversation.item.input_audio_transcription.failed") {
    const eventId = id(own(event, "event_id")), itemId = id(own(event, "item_id"));
    if (!eventId || type !== "input_audio_buffer.cleared" && !itemId) return { kind: "uncertain", hash: "invalid-audio-custody-identity" };
    const audioCustody: RealtimeAudioCustodyEvent = { eventId, ...(itemId ? { itemId } : {}),
      action: type === "input_audio_buffer.committed" ? "committed" : type === "input_audio_buffer.cleared" ? "cleared" : "independent_transcription" };
    const transcription = realtimeTranscriptionReceipt(event);
    return { kind: "audio_custody", audioCustody, ...(transcription ? { transcription } : {}), hash: pricingContentHash({ audioCustody, transcription }) };
  }
  if (type !== "response.created" && type !== "response.done") return null;
  const response = own(event, "response");
  const responseId = id(own(response, "id"));
  if (!responseId) return { kind: "uncertain", hash: "missing-response-id" };
  if (type === "response.created")
    return {
      kind: "created",
      responseId,
      defaultConversation: id(own(response, "conversation_id")) !== null,
      correlation: realtimeCorrelation(own(response, "metadata")),
      hash: pricingContentHash({ type, responseId }),
    };
  const raw = own(response, "usage");
  const input = own(raw, "input_token_details"),
    output = own(raw, "output_token_details"),
    cache = own(input, "cached_tokens_details");
  let usage = normalizeCanonicalTokenUsage(
    {
      input_tokens: own(raw, "input_tokens"),
      output_tokens: own(raw, "output_tokens"),
      cache_read_input_tokens: own(input, "cached_tokens"),
      cache_creation_input_tokens: "0",
    },
    adapter,
  );
  usage = normalizeTokenModalityUsage(usage, {
    input: {
      text: own(input, "text_tokens"),
      audio: own(input, "audio_tokens"),
      image: own(input, "image_tokens"),
    },
    cached_input: {
      text: own(cache, "text_tokens"),
      audio: own(cache, "audio_tokens"),
      image: own(cache, "image_tokens"),
    },
    output: {
      text: own(output, "text_tokens"),
      audio: own(output, "audio_tokens"),
    },
  });
  const total = own(raw, "total_tokens");
  if (total !== undefined) {
    const checked = normalizeQuantities(
      [{ dimension: "total_input_tokens", value: total }],
      adapter,
    );
    usage.diagnostics.push(
      ...checked.diagnostics.map((d) => ({ ...d, path: "usage.total_tokens" })),
    );
    const a = usage.quantities.total_input_tokens?.value,
      b = usage.quantities.output_tokens?.value;
    if (
      checked.quantities.total_input_tokens?.value != null &&
      a != null &&
      b != null &&
      ExactDecimal.parse(a)
        .add(ExactDecimal.parse(b))
        .compare(
          ExactDecimal.parse(checked.quantities.total_input_tokens.value),
        ) !== 0
    ) {
      usage.diagnostics.push({
        code: "pricing_usage_conflict",
        path: "usage.total_tokens",
        message: "Realtime input and output do not equal reported total tokens",
      });
    }
  }
  Object.assign(
    usage.quantities,
    normalizeQuantities(
      [
        { dimension: "request_count", value: "1", source: "local_measurement" },
        {
          dimension: "session_seconds",
          value: "0",
          source: "local_measurement",
        },
      ],
      adapter,
    ).quantities,
  );
  const reportedStatus = own(response, "status");
  const status = ["completed", "cancelled", "failed", "incomplete"].includes(
    String(reportedStatus),
  )
    ? String(reportedStatus)
    : "unknown";
  return {
    kind: "done",
    responseId,
    defaultConversation: id(own(response, "conversation_id")) !== null,
    usage,
    status,
    correlation: realtimeCorrelation(own(response, "metadata")),
    hash: pricingContentHash({ responseId, usage, status }),
  };
}

/** One separately measured session component; token quantities are zero, not a second response. */
export function realtimeSessionUsage(
  seconds: string | null,
  uncertain = false,
): NormalizedUsage {
  return normalizeQuantities(
    (Object.keys(DIMENSION_UNITS) as MeterDimension[])
      .filter(
        (dimension) =>
          dimension.endsWith("tokens") ||
          dimension === "session_seconds" ||
          dimension === "request_count",
      )
      .map((dimension) => ({
        dimension,
        value:
          dimension === "session_seconds"
            ? seconds
            : uncertain && (dimension.endsWith("tokens") || dimension === "request_count")
              ? null
              : "0",
      })),
    {
      adapter_id: "realtime-session-clock",
      adapter_version: "2",
      source: "local_measurement",
    },
  );
}

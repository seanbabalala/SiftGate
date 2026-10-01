import { normalizeCanonicalTokenUsage, normalizeQuantities, normalizeTokenModalityUsage } from "./usage-normalizer";
import { ExactDecimal } from "./exact-decimal";
import { pricingContentHash } from "./pricing-json";
import type { NormalizedUsage } from "./pricing.types";

const own = (value: unknown, key: string): unknown => value && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined;
export interface RealtimeTranscriptionReceipt {
  itemId: string;
  contentIndex: number;
  status: "completed" | "failed";
  usage: NormalizedUsage;
  hash: string;
}

/** Native ASR usage is independent of Realtime response usage. Never retain text/audio. */
export function realtimeTranscriptionReceipt(event: unknown): RealtimeTranscriptionReceipt | null {
  const type = own(event, "type");
  if (type !== "conversation.item.input_audio_transcription.completed" && type !== "conversation.item.input_audio_transcription.failed") return null;
  const itemId = own(event, "item_id"), index = own(event, "content_index");
  if (typeof itemId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(itemId) || typeof index !== "number" || !Number.isSafeInteger(index) || index < 0 || index > 1023) return null;
  const raw = own(event, "usage"), adapter = { adapter_id: "openai-realtime-transcription", adapter_version: "1", source: "provider_usage" as const };
  let usage: NormalizedUsage;
  if (own(raw, "type") === "tokens") {
    usage = normalizeCanonicalTokenUsage({ input_tokens: own(raw, "input_tokens"), output_tokens: own(raw, "output_tokens"), cache_read_input_tokens: "0", cache_creation_input_tokens: "0" }, adapter);
    const details = own(raw, "input_token_details");
    usage = normalizeTokenModalityUsage(usage, { input: { text: own(details, "text_tokens"), audio: own(details, "audio_tokens"), image: "0" }, cached_input: { text: "0", audio: "0", image: "0" } });
    const total = normalizeQuantities([{ dimension: "total_input_tokens", value: own(raw, "total_tokens") }], adapter);
    usage.diagnostics.push(...total.diagnostics.map(d => ({ ...d, path: "usage.total_tokens" })));
    const input = usage.quantities.total_input_tokens?.value, output = usage.quantities.output_tokens?.value, all = total.quantities.total_input_tokens?.value;
    if (input != null && output != null && all != null && ExactDecimal.parse(input).add(ExactDecimal.parse(output)).compare(ExactDecimal.parse(all)) !== 0)
      usage.diagnostics.push({ code: "pricing_usage_conflict", path: "usage.total_tokens", message: "Transcription input and output differ from the reported total" });
  } else {
    usage = normalizeQuantities([{ dimension: "audio_input_seconds", value: own(raw, "type") === "duration" ? own(raw, "seconds") : undefined }], adapter);
    // Duration billing does not establish token counts, even when no token fee is configured.
    Object.assign(usage.quantities, normalizeCanonicalTokenUsage({}, adapter).quantities);
  }
  Object.assign(usage.quantities, normalizeQuantities([{ dimension: "request_count", value: "1", source: "local_measurement" }], adapter).quantities);
  const status = type.endsWith(".failed") ? "failed" as const : "completed" as const;
  const body = { itemId, contentIndex: index, status, usage };
  return { ...body, hash: pricingContentHash(body) };
}

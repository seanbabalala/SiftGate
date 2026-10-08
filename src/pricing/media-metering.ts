import { FIXED_MEDIA_ATTRIBUTES } from './media-specification.types';
import { videoResultProfile, nativeVideoRequestUsage, translateNativeVideoResult, nativeVideoPricingContext } from "./video-result-profile";
import type { VideoResultProfile } from "./video-result-profile.types";
import { redactErrorText } from "../security/error-redaction";
import type {
  CanonicalMediaRequest,
  CanonicalMediaResponse,
  CanonicalRerankRequest,
  CanonicalRerankResponse,
  CanonicalRequestMetadata,
} from "../canonical/canonical.types";
import { normalizeQuantities, normalizeTokenModalityUsage, type QuantityEvidence } from "./usage-normalizer";
import type {
  NormalizedUsage,
  PricingContext,
  MediaAttribute,
  MeterDimension,
} from "./pricing.types";
import { pcmWaveSeconds } from "./wave-metering";

export type MeteredRequest = CanonicalMediaRequest | CanonicalRerankRequest;
export const METERED_FORMATS = [
  "rerank",
  "image_generation",
  "image_edit",
  "image_variation",
  "audio_transcription",
  "audio_translation",
  "audio_speech",
  "video_generation",
] as const;
export function isMeteredRequest(value: {
  metadata: CanonicalRequestMetadata;
}): value is MeteredRequest {
  return (METERED_FORMATS as readonly string[]).includes(
    value.metadata.source_format,
  );
}

const own = (value: unknown, key: string): unknown =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  !Buffer.isBuffer(value) &&
  Object.prototype.hasOwnProperty.call(value, key)
    ? (value as Record<string, unknown>)[key]
    : undefined;
function first(body: unknown, paths: string[]): unknown {
  for (const path of paths) {
    const value = path
      .split(".")
      .reduce<unknown>((value, key) => own(value, key), body);
    if (value !== undefined) return value;
  }
  return undefined;
}
const TEXT_FIELDS = new Set([
  "n",
  "duration",
  "duration_seconds",
  "seconds",
  "size",
  "quality",
  "width",
  "height",
  "resolution",
  "frame_rate",
  "fps",
  "audio_track",
]);
interface RequestMetadata {
  fields: Record<string, unknown>;
  inputSeconds: string | null;
}
const requestCache = new WeakMap<MeteredRequest, RequestMetadata>();

/** Bounded multipart header/allowlisted-field scan; file bodies remain slices, never strings. */
function multipartMetadata(body: Buffer, contentType: string): RequestMetadata {
  const fields: Record<string, unknown> = {};
  let inputSeconds: string | null = null;
  const rawBoundary = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  const boundary = rawBoundary?.[1] ?? rawBoundary?.[2];
  if (!boundary || boundary.length > 200 || /[^\x20-\x7e]/.test(boundary))
    return { fields, inputSeconds };
  const marker = Buffer.from(`--${boundary}`, "ascii");
  const delimiter = Buffer.from(`\r\n--${boundary}`, "ascii");
  let offset = body.indexOf(marker);
  let fileCount = 0;
  let closed = false;
  for (let parts = 0; offset >= 0 && parts < 128; parts++) {
    const start = offset + marker.length;
    if (body.toString("ascii", start, start + 2) === "--") {
      closed = true;
      break;
    }
    if (body.toString("ascii", start, start + 2) !== "\r\n") break;
    const headersEnd = body.indexOf("\r\n\r\n", start + 2);
    if (headersEnd < 0 || headersEnd - start > 8192) break;
    const next = body.indexOf(delimiter, headersEnd + 4);
    if (next < 0) break;
    const headers = body.toString("latin1", start + 2, headersEnd);
    const disposition =
      /(?:^|\r\n)content-disposition:\s*form-data;([^\r\n]*)/i.exec(
        headers,
      )?.[1];
    const name =
      disposition && /(?:^|;)\s*name="([^"]+)"/i.exec(disposition)?.[1];
    const file = disposition && /(?:^|;)\s*filename=/i.test(disposition);
    const value = body.subarray(headersEnd + 4, next);
    if (file && name === "file") {
      fileCount++;
      inputSeconds = fileCount === 1 ? pcmWaveSeconds(value) : null;
    } else if (!file && name && TEXT_FIELDS.has(name)) {
      const text =
        value.length <= 128 ? value.toString("utf8").trim() : "invalid";
      fields[name] =
        fields[name] === undefined || fields[name] === text
          ? text
          : "ambiguous";
    }
    offset = next + 2;
  }
  return closed ? { fields, inputSeconds } : { fields: {}, inputSeconds: null };
}

function requestMetadata(canonical: MeteredRequest): RequestMetadata {
  const multipart =
    "payload" in canonical && Buffer.isBuffer(canonical.payload);
  const cached = multipart ? requestCache.get(canonical) : undefined;
  if (cached) return cached;
  const result =
    "payload" in canonical && Buffer.isBuffer(canonical.payload)
      ? multipartMetadata(canonical.payload, canonical.content_type)
      : {
          fields:
            "payload" in canonical
              ? (canonical.payload as Record<string, unknown>)
              : {},
          inputSeconds: null,
        };
  // Do not cache whole JSON payloads: hold only allowlisted shape fields, never prompts or URLs.
  const fields: Record<string, unknown> = {};
  for (const key of TEXT_FIELDS)
    if (Object.prototype.hasOwnProperty.call(result.fields, key)) {
      const value = result.fields[key];
      fields[key] =
        typeof value === "string"
          ? redactErrorText(value, { maxLength: 128 })
          : typeof value === "number" ||
              typeof value === "boolean" ||
              value === null
            ? value
            : "invalid";
    }
  const sanitized = { fields, inputSeconds: result.inputSeconds };
  if (multipart) requestCache.set(canonical, sanitized);
  return sanitized;
}

export function mediaPricingContext(
  canonical: MeteredRequest,
  response?: CanonicalMediaResponse | CanonicalRerankResponse,
  selectedProfile?: VideoResultProfile,
): Pick<PricingContext, "media" | "media_estimated" | "media_sources" | "media_adapter"> {
  const profile = videoResultProfile(selectedProfile);
  if (canonical.metadata.source_format === "video_generation" && profile !== "generic-v1")
    return nativeVideoPricingContext(canonical as CanonicalMediaRequest, profile);
  const { fields } = requestMetadata(canonical);
  const body = response && "body" in response ? response.body : undefined;
  const media: Partial<Record<MediaAttribute, string>> = {
    operation: "media" in canonical ? canonical.media.operation : "rerank",
  };
  if (canonical.metadata.source_format.startsWith("audio_"))
    media.audio_direction =
      canonical.metadata.source_format === "audio_speech" ? "output" : "input";
  const sources: NonNullable<PricingContext["media_sources"]> = { operation: "operation", ...(media.audio_direction ? { audio_direction: "operation" as const } : {}) };
  const keys: Array<[MediaAttribute, string]> = FIXED_MEDIA_ATTRIBUTES.map(key => [key, key]);
  let estimated = false;
  for (const [attribute, key] of keys) {
    const reported = own(body, key);
    const requested =
      fields[key] ?? (key === "frame_rate" ? fields.fps : undefined);
    const value = reported === undefined ? requested : reported;
    if (
      (typeof value === "string" && value.length <= 128) ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
    ) {
      const safe = redactErrorText(String(value), { maxLength: 128 });
      media[attribute] = safe.includes("://") ? "invalid" : safe;
      sources[attribute] = reported === undefined ? "request_parameter" : "provider_result";
      if (reported === undefined) estimated = true;
    } else if (reported !== undefined || requested !== undefined) {
      // Keep invalid presence separate; legacy effective-media behavior is unchanged.
      sources[attribute] = reported === undefined ? "request_parameter" : "provider_result";
    }
  }
  if (fields.n !== undefined && ["string", "number"].includes(typeof fields.n))
    media.generation_count = /^\d{1,9}$/.test(String(fields.n))
      ? String(fields.n)
      : "invalid";
  if (media.generation_count) sources.generation_count = "request_parameter";
  return { media, media_estimated: estimated, media_sources: sources, media_adapter: "generic-v1" };
}

function imageCount(body: unknown): {
  value: unknown;
  incomplete: boolean;
  source?: QuantityEvidence["source"];
} {
  const explicit = first(body, [
    "usage.image_count",
    "usage.images",
    "image_count",
  ]);
  if (explicit !== undefined)
    return { value: explicit, incomplete: false, source: "provider_usage" };
  const data = own(body, "data");
  if (!Array.isArray(data)) return { value: undefined, incomplete: false };
  let count = 0;
  let incomplete = false;
  for (const entry of data) {
    if (
      (typeof own(entry, "url") === "string" &&
        (own(entry, "url") as string).length) ||
      (typeof own(entry, "b64_json") === "string" &&
        (own(entry, "b64_json") as string).length)
    )
      count++;
    else if (!own(entry, "error")) incomplete = true;
  }
  return {
    value: incomplete && count === 0 ? undefined : count,
    incomplete,
    source: "provider_job_result",
  };
}

export function meterMediaUsage(
  canonical: MeteredRequest,
  response?: CanonicalMediaResponse | CanonicalRerankResponse,
  phase: "estimate" | "result" | "failure" = response ? "result" : "estimate",
  tokenUsage?: NormalizedUsage,
  selectedProfile?: VideoResultProfile,
): NormalizedUsage {
  const profile = videoResultProfile(selectedProfile);
  if (canonical.metadata.source_format === "video_generation" && profile !== "generic-v1") {
    const requested = nativeVideoRequestUsage(canonical as CanonicalMediaRequest, profile, phase === "estimate");
    if (phase === "estimate" || !response || !("body" in response)) return requested;
    const actual = translateNativeVideoResult(profile, response.body).usage;
    for (const [dimension, quantity] of Object.entries(requested.quantities))
      if (dimension.startsWith("requested_") && quantity) actual.quantities[dimension as MeterDimension] = quantity;
    return actual;
  }
  const { fields, inputSeconds } = requestMetadata(canonical);
  const format = canonical.metadata.source_format;
  const body = response && "body" in response ? response.body : undefined;
  const evidence: QuantityEvidence[] = [];
  const add = (
    dimension: MeterDimension,
    value: unknown,
    source: QuantityEvidence["source"],
    quality: QuantityEvidence["quality"] = "observed",
  ) =>
    evidence.push({
      dimension,
      value: phase === "failure" ? undefined : value,
      source,
      quality: phase === "estimate" ? "estimated" : quality,
    });
  add(
    "request_count",
    phase === "failure" ? undefined : 1,
    "local_measurement",
  );
  let incompleteImages = false;
  if (format.startsWith("image_")) {
    add("requested_image_count", fields.n, "request_metadata");
    const actual = imageCount(body);
    incompleteImages = actual.incomplete;
    add(
      "image_count",
      phase === "estimate" ? fields.n : actual.value,
      phase === "estimate" ? "heuristic" : (actual.source ?? "provider_usage"),
      actual.incomplete ? "estimated" : "observed",
    );
  } else if (format === "video_generation") {
    const requestedSeconds =
      fields.seconds ?? fields.duration_seconds ?? fields.duration;
    const status = String(first(body, ["status", "state", "phase"]) ?? "");
    const completed = [
      "completed",
      "succeeded",
      "success",
      "done",
      "partially_completed",
    ].includes(status);
    const reportedSeconds = first(body, [
      "usage.video_seconds",
      "usage.duration_seconds",
      "duration_seconds",
      "duration",
    ]);
    const reportedGenerations = first(body, [
      "usage.generation_count",
      "usage.generations",
    ]);
    add("requested_video_seconds", requestedSeconds, "request_metadata");
    add("requested_video_generation_count", fields.n ?? 1, "request_metadata");
    add(
      "video_seconds",
      phase === "estimate" ? requestedSeconds : reportedSeconds,
      phase === "estimate" ? "heuristic" : "provider_job_result",
    );
    add(
      "video_generation_count",
      phase === "estimate"
        ? (fields.n ?? 1)
        : (reportedGenerations ??
            (completed && String(fields.n ?? 1) === "1" ? 1 : undefined)),
      phase === "estimate" ? "heuristic" : "provider_job_result",
    );
  } else if (format === "rerank") {
    const rerank = canonical as CanonicalRerankRequest;
    const raw = response && "results" in response ? response : undefined;
    // Provider adapters attach their raw billed counters separately; result length is top_n, not work done.
    add(
      "rerank_request_count",
      raw || phase === "estimate" ? 1 : undefined,
      "local_measurement",
    );
    add(
      "requested_rerank_document_count",
      rerank.documents.length,
      "request_metadata",
    );
    if (phase === "estimate")
      add("rerank_document_count", rerank.documents.length, "heuristic");
  } else if (format.startsWith("audio_")) {
    const output = format === "audio_speech";
    const dimension = output ? "audio_output_seconds" : "audio_input_seconds";
    const requested =
      fields.duration_seconds ?? fields.seconds ?? fields.duration;
    add(
      output
        ? "requested_audio_output_seconds"
        : "requested_audio_input_seconds",
      requested,
      "request_metadata",
    );
    const reported = first(
      body,
      output
        ? [
            "usage.audio_output_seconds",
            "usage.seconds",
            "duration",
            "duration_seconds",
          ]
        : [
            "usage.audio_input_seconds",
            "usage.seconds",
            "duration",
            "duration_seconds",
          ],
    );
    const measured =
      output && response && "body" in response && Buffer.isBuffer(response.body)
        ? pcmWaveSeconds(response.body)
        : !output
          ? inputSeconds
          : null;
    add(
      dimension,
      reported !== undefined
        ? reported
        : (measured ?? (phase === "estimate" ? requested : undefined)),
      reported !== undefined
        ? "provider_usage"
        : measured !== null
          ? "local_measurement"
          : "heuristic",
    );
    if (
      output &&
      "payload" in canonical &&
      !Buffer.isBuffer(canonical.payload)
    ) {
      const input = own(canonical.payload, "input");
      let characters: number | undefined;
      if (typeof input === "string") {
        characters = 0;
        for (const _point of input) characters++;
      }
      add("text_characters", characters, "request_metadata");
    }
  }
  // Shared prompt/cache conservation semantics with raw chat metering. Media
  // schemas have their own documented field names; neither path guesses aliases.
  if (tokenUsage && body && typeof body === "object" && !Buffer.isBuffer(body)) {
    const detail = (direction: "input" | "output", modality: "text" | "audio" | "image") =>
      first(body, [`usage.${direction}_tokens_details.${modality}_tokens`, `usage.${direction}_token_details.${modality}_tokens`]);
    tokenUsage = normalizeTokenModalityUsage(tokenUsage, {
      input: { text: detail("input", "text"), audio: detail("input", "audio"), image: detail("input", "image") },
      output: { text: detail("output", "text"), audio: detail("output", "audio"), image: detail("output", "image") },
    });
  }
  const existing = tokenUsage
    ? Object.values(tokenUsage.quantities)
        .filter((quantity) => quantity !== undefined)
        .map(
          (quantity): QuantityEvidence => ({
            dimension: quantity!.dimension,
            value: quantity!.value,
            source: quantity!.source,
            quality: quantity!.quality,
          }),
        )
    : [];
  const result = normalizeQuantities([...existing, ...evidence], {
    adapter_id: "media-metering",
    adapter_version: "2",
    source: "provider_usage",
  });
  result.diagnostics.push(...(tokenUsage?.diagnostics ?? []));
  if (incompleteImages)
    result.diagnostics.push({
      code: "pricing_dimension_missing",
      path: "usage.image_count",
      message:
        "Some returned image entries have no recognized output or explicit failure evidence",
    });
  return result;
}

/** Normalize only allowlisted scalar provider counters. Never retain documents, scores or output bodies. */
export function meterRerankProviderUsage(
  canonical: CanonicalRerankRequest,
  response: CanonicalRerankResponse,
  rawBody: Record<string, unknown>,
  tokens?: NormalizedUsage,
): NormalizedUsage {
  const base = meterMediaUsage(canonical, response, "result", tokens);
  const additions = normalizeQuantities(
    [
      {
        dimension: "rerank_document_count",
        value: first(rawBody, [
          "usage.document_count",
          "meta.document_count",
          "usage.documents",
        ]),
      },
      {
        dimension: "rerank_search_units",
        value: first(rawBody, [
          "usage.billed_units.search_units",
          "meta.billed_units.search_units",
        ]),
      },
    ],
    {
      adapter_id: "rerank-provider-metering",
      adapter_version: "1",
      source: "provider_usage",
    },
  );
  return {
    ...base,
    quantities: { ...base.quantities, ...additions.quantities },
    diagnostics: [...base.diagnostics, ...additions.diagnostics],
  };
}

import type { CanonicalMediaRequest } from "../canonical/canonical.types";
import type { MediaJobStatus } from "./media-task.types";
import type { NormalizedUsage, PricingContext } from "./pricing.types";
import { normalizeQuantities } from "./usage-normalizer";
import { parsePricingInstant } from "./pricing-time";
import { PricingRepositoryError } from "./pricing-repository.types";
import { ExactDecimal } from "./exact-decimal";
import {
  VIDEO_RESULT_PROFILES,
  type VideoResultProfile,
  type NativeVideoResultProfile,
} from "./video-result-profile.types";

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  !Buffer.isBuffer(value)
    ? (value as Record<string, unknown>)
    : null;
const own = (value: unknown, key: string): unknown => {
  const row = object(value);
  return row && Object.hasOwn(row, key) ? row[key] : undefined;
};
const fail = (message: string): never => {
  throw new PricingRepositoryError(
    "pricing_media_profile_invalid",
    message,
    409,
  );
};
export function videoResultProfile(value: unknown): VideoResultProfile {
  if (value === undefined) return "generic-v1";
  if (!(VIDEO_RESULT_PROFILES as readonly unknown[]).includes(value))
    fail("Unknown video result profile; choose a supported version");
  return value as VideoResultProfile;
}
export interface NativeVideoObservation {
  provider_job_id: string;
  status: MediaJobStatus;
  usage: NormalizedUsage;
  context: PricingContext;
  /** Creation is not acceptance. Current native schemas do not document an acceptance instant. */
  provider_created_at: string | null;
}

/** Ingress permits native envelopes, but the selected node must explicitly accept that schema before any HTTP dispatch. */
export function nativeVideoRequestShape(
  profile: NativeVideoResultProfile,
  body: unknown,
): boolean {
  const data = object(body);
  if (!data) return false;
  if (profile === "gemini-veo-rest-v1") {
    const instances = data.instances;
    return (
      Array.isArray(instances) &&
      instances.length === 1 &&
      object(instances[0]) !== null &&
      (typeof own(instances[0], "prompt") === "string" ||
        object(own(instances[0], "image")) !== null ||
        object(own(instances[0], "video")) !== null) &&
      (data.parameters === undefined || object(data.parameters) !== null)
    );
  }
  return (
    typeof data.promptText === "string" ||
    typeof data.promptImage === "string" ||
    Array.isArray(data.promptImage)
  );
}

export function nativeVideoGenerationPath(
  profile: NativeVideoResultProfile,
  template: string,
  model: string,
): string {
  if (profile !== "gemini-veo-rest-v1") return template;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(model))
    fail("Native Gemini video model must be an opaque model identifier");
  const path = template.replace(/:model|\{model\}/g, encodeURIComponent(model));
  if (!path.endsWith(`/models/${encodeURIComponent(model)}:predictLongRunning`))
    fail(
      "Native Gemini video endpoint must identify the dispatched model using a matching path or {model} placeholder",
    );
  return path;
}

export function nativeVideoJobId(
  profile: NativeVideoResultProfile,
  body: unknown,
): string {
  const id = own(body, profile === "gemini-veo-rest-v1" ? "name" : "id");
  const valid =
    typeof id === "string" &&
    id.length <= 160 &&
    (profile === "gemini-veo-rest-v1"
      ? /^(?:models\/[A-Za-z0-9_-]+\/)?operations\/[A-Za-z0-9_-]{1,128}$/.test(
          id,
        )
      : /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          id,
        ));
  if (!valid)
    fail("Native video result has no supported provider job identity");
  return id as string;
}

/** No URLs, bytes, prompts, error text, credit totals or unknown extensions leave the translator. */
export function translateNativeVideoResult(
  profile: NativeVideoResultProfile,
  body: unknown,
): NativeVideoObservation {
  if (!object(body)) fail("Native video result must be an object");
  const id = nativeVideoJobId(profile, body);
  let status: MediaJobStatus = "pending",
    outputs: unknown,
    created: string | null = null;
  if (profile === "gemini-veo-rest-v1") {
    const done = own(body, "done"),
      response = own(body, "response"),
      error = own(body, "error");
    if (done !== undefined && typeof done !== "boolean")
      fail("Native video operation has an invalid done flag");
    if (done !== true && (response !== undefined || error !== undefined))
      fail("Native video operation has a terminal result before completion");
    if (done === true) {
      if ((response !== undefined) === (error !== undefined))
        fail(
          "Completed native video operation needs exactly one response or error",
        );
      if (error !== undefined) {
        if (
          !object(error) ||
          typeof own(error, "code") !== "number" ||
          !Number.isSafeInteger(own(error, "code"))
        )
          fail("Native video operation has an invalid error status");
        status = own(error, "code") === 1 ? "cancelled" : "failed";
      } else {
        const generated = own(response, "generateVideoResponse");
        if (!object(generated))
          fail("Native video response does not match the selected REST schema");
        outputs = own(generated, "generatedSamples");
        const filtered = own(generated, "raiMediaFilteredCount");
        if (
          filtered !== undefined &&
          (typeof filtered !== "number" ||
            !Number.isSafeInteger(filtered) ||
            filtered < 0)
        )
          fail("Native video result has an invalid filtered count");
        status = "completed";
      }
    }
  } else {
    const raw = own(body, "status");
    const states: Record<string, MediaJobStatus> = {
      PENDING: "pending",
      THROTTLED: "pending",
      RUNNING: "pending",
      SUCCEEDED: "completed",
      FAILED: "failed",
      CANCELLED: "cancelled",
    };
    // Submission acknowledgement contains only the job ID. It is not terminal.
    if (
      raw !== undefined &&
      (typeof raw !== "string" || !Object.hasOwn(states, raw))
    )
      fail("Native video task has an unsupported lifecycle state");
    if (raw !== undefined) status = states[raw as string];
    if (status === "completed") outputs = own(body, "output");
    else if (own(body, "output") !== undefined)
      fail(
        "Native video task reports output outside a successful terminal state",
      );
    const submitted = own(body, "createdAt");
    if (submitted !== undefined) {
      if (typeof submitted !== "string")
        fail("Native video task creation time must be an absolute timestamp");
      try {
        // RFC3339 permits sub-millisecond precision; creation metadata is not a pricing instant.
        if (
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(
            submitted as string,
          )
        )
          throw new Error("Invalid timestamp");
        parsePricingInstant(
          (submitted as string).replace(
            /(\.\d{3})\d+(?=Z|[+-]\d{2}:\d{2}$)/,
            "$1",
          ),
        );
        created = submitted as string;
      } catch {
        fail("Native video task creation time is invalid");
      }
    }
  }
  let count: number | undefined;
  if (outputs !== undefined) {
    if (!Array.isArray(outputs) || outputs.length > 64)
      fail("Native video output inventory must be a bounded array");
    const identities = new Set<string>();
    for (const output of outputs as unknown[]) {
      const value =
        profile === "gemini-veo-rest-v1"
          ? own(own(output, "video"), "uri")
          : output;
      if (
        typeof value !== "string" ||
        value.length === 0 ||
        value.length > 16384
      )
        fail("Native video output has no bounded URI");
      // Count returned assets, never dereference their locations. Byte-only results remain unsupported metadata.
      let uri: URL;
      try {
        uri = new URL(value as string);
      } catch {
        fail("Native video output URI is malformed");
      }
      if (
        !["https:", "http:", "gs:"].includes(uri!.protocol) ||
        uri!.username ||
        uri!.password ||
        identities.has(value as string)
      )
        fail("Native video output URI is invalid or duplicated");
      identities.add(value as string);
    }
    count = (outputs as unknown[]).length;
  }
  const usage = normalizeQuantities(
    [
      { dimension: "request_count", value: "1", source: "local_measurement" },
      {
        dimension: "video_generation_count",
        value: count,
        source: "provider_job_result",
      },
      {
        dimension: "video_seconds",
        value: null,
        quality: "unsupported",
        source: "provider_job_result",
      },
    ],
    {
      adapter_id: profile,
      adapter_version: "1",
      source: "provider_job_result",
    },
  );
  // Unsupported dimensions are explicit quantities, not global parse errors.
  // The calculator diagnoses them if the selected price actually requires them.
  return {
    provider_job_id: id,
    status,
    usage,
    context: {
      time_estimated: true,
      media: { operation: "generation" },
      media_estimated: true,
    },
    provider_created_at: created,
  };
}

/** Only explicitly selected native request fields enter estimates. No request content is retained. */
export function nativeVideoRequestUsage(
  canonical: CanonicalMediaRequest,
  profile: NativeVideoResultProfile,
  estimate: boolean,
): NormalizedUsage {
  const parameters =
    profile === "gemini-veo-rest-v1"
      ? own(canonical.payload, "parameters")
      : canonical.payload;
  const seconds = own(
    parameters,
    profile === "gemini-veo-rest-v1" ? "durationSeconds" : "duration",
  );
  const samples =
    profile === "gemini-veo-rest-v1" &&
    own(parameters, "sampleCount") !== undefined
      ? own(parameters, "sampleCount")
      : 1;
  const evidence = normalizeQuantities(
    [
      { dimension: "request_count", value: 1, source: "local_measurement" },
      {
        dimension: "requested_video_seconds",
        value: seconds,
        source: "request_metadata",
      },
      {
        dimension: "requested_video_generation_count",
        value: samples,
        source: "request_metadata",
      },
      ...(estimate
        ? [
            {
              dimension: "video_seconds" as const,
              value: seconds,
              source: "heuristic" as const,
              quality: "estimated" as const,
            },
            {
              dimension: "video_generation_count" as const,
              value: samples,
              source: "heuristic" as const,
              quality: "estimated" as const,
            },
          ]
        : []),
    ],
    { adapter_id: profile, adapter_version: "1", source: "request_metadata" },
  );
  // Actual video_seconds is aggregate output duration; admission reserves per-video duration times output count.
  if (
    estimate &&
    evidence.quantities.video_seconds?.value !== null &&
    evidence.quantities.video_generation_count?.value !== null
  ) {
    const secondsQ = evidence.quantities.video_seconds!,
      countQ = evidence.quantities.video_generation_count!;
    secondsQ.value = ExactDecimal.parse(secondsQ.value!)
      .multiply(ExactDecimal.parse(countQ.value!))
      .toFixed(18);
  } else if (estimate && evidence.quantities.video_seconds) {
    evidence.quantities.video_seconds.value = null;
    evidence.quantities.video_seconds.quality = "missing";
  }
  return evidence;
}

export function nativeVideoPricingContext(
  canonical: CanonicalMediaRequest,
  profile: NativeVideoResultProfile,
): PricingContext {
  const parameters =
    profile === "gemini-veo-rest-v1"
      ? own(canonical.payload, "parameters")
      : canonical.payload;
  const media: PricingContext["media"] = { operation: "generation" };
  const resolution = own(parameters, "resolution"),
    ratio = own(parameters, "ratio");
  if (typeof resolution === "string")
    media.resolution = /^(480p|720p|1080p|4k)$/.test(resolution)
      ? resolution
      : "invalid";
  if (typeof ratio === "string" && /^\d{2,5}:\d{2,5}$/.test(ratio)) {
    const [width, height] = ratio.split(":");
    media.width = width;
    media.height = height;
    media.size = `${width}x${height}`;
  }
  return { media, media_estimated: true, media_adapter: profile, media_sources: Object.fromEntries(Object.keys(media).map(key => [key, key === "operation" ? "operation" : "request_parameter"])) };
}

/** Native schemas do not document completion/acceptance instants: never reuse local lifecycle timestamps as evidence. */
export function nativeVideoTaskContext(
  original: PricingContext,
): PricingContext {
  const context = { ...original, time_estimated: true, media_estimated: true };
  delete context.provider_accepted_at;
  delete context.completed_at;
  return context;
}

/** Preserve slash-separated, validated operation resources only for the documented Google status route. */
export function videoProfileStatusPath(
  profile: VideoResultProfile,
  template: string,
  job: string,
): string {
  const encoded =
    profile === "gemini-veo-rest-v1"
      ? nativeVideoJobId(profile, { name: job })
          .split("/")
          .map(encodeURIComponent)
          .join("/")
      : encodeURIComponent(job);
  return template.replace(/:id|\{id\}/g, encoded);
}

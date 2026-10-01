import { videoResultProfile, translateNativeVideoResult, nativeVideoTaskContext } from "./video-result-profile";
import type {
  CanonicalMediaRequest,
  CanonicalMediaResponse,
} from "../canonical/canonical.types";
import { attachTokenPricingEvidence } from "../providers/pricing-usage-evidence";
import { getUsageEvidence } from "../canonical/usage-evidence";
import { mediaPricingContext, meterMediaUsage } from "./media-metering";
import type { MediaJobStatus, MediaTaskContext } from "./media-task.types";
import type { NormalizedUsage, PricingContext } from "./pricing.types";

export function mediaJobStatus(body: Record<string, unknown>): MediaJobStatus {
  const raw = String(
    body.status ?? body.state ?? body.phase ?? "",
  ).toLowerCase();
  if (
    [
      "completed",
      "succeeded",
      "success",
      "done",
      "partially_completed",
    ].includes(raw) ||
    (body.done === true && !body.error)
  )
    return "completed";
  if (
    ["failed", "error", "rejected"].includes(raw) ||
    (body.done === true && body.error)
  )
    return "failed";
  if (["cancelled", "canceled"].includes(raw)) return "cancelled";
  return "pending";
}

export function mediaJobId(body: Record<string, unknown>): string | null {
  const operation =
    body.operation && typeof body.operation === "object"
      ? (body.operation as Record<string, unknown>)
      : {};
  return (
    [body.id, body.job_id, body.video_id, body.name, operation.name].find(
      (value): value is string =>
        typeof value === "string" &&
        /^[A-Za-z0-9_./:-]{1,160}$/.test(value) &&
        !/\b(?:sk-|gw_sk_|Bearer)/i.test(value),
    ) ?? null
  );
}

/** Reconstruct only a metering footprint, not the original prompt or media. */
export function meterMediaTask(
  context: MediaTaskContext,
  body: Record<string, unknown>,
  status: MediaJobStatus,
): { usage: NormalizedUsage; context: PricingContext } {
  const profile = videoResultProfile(context.video_result_profile);
  if (context.operation === "video_generation" && profile !== "generic-v1") {
    const translated = translateNativeVideoResult(profile, body);
    if (translated.status !== status) throw new Error("Native video status differs from its validated envelope");
    for (const [dimension, quantity] of Object.entries(context.request_usage.quantities))
      if (dimension.startsWith("requested_") && quantity) translated.usage.quantities[dimension as keyof typeof translated.usage.quantities] = { ...quantity };
    return { usage: translated.usage, context: nativeVideoTaskContext(context.pricing) };
  }
  const fields = context.pricing.media ?? {};
  const payload: Record<string, unknown> = { ...fields };
  const quantities = context.request_usage.quantities;
  payload.n =
    quantities.requested_image_count?.value ??
    quantities.requested_video_generation_count?.value;
  payload.seconds = quantities.requested_video_seconds?.value;
  const canonical: CanonicalMediaRequest = {
    model: context.target.model,
    source_format: context.operation,
    payload,
    content_type: "application/json",
    is_multipart: false,
    media: {
      media_type: context.operation === "video_generation" ? "video" : "image",
      operation:
        context.operation === "image_edit"
          ? "edit"
          : context.operation === "image_variation"
            ? "variation"
            : "generation",
      multipart: false,
      file_count: 0,
      byte_size: 0,
    },
    metadata: {
      source_format: context.operation,
      original_model: context.target.model,
      raw_headers: {},
    },
  };
  const response: CanonicalMediaResponse = {
    id: "metered-task",
    body: { ...body, status },
    model: context.target.model,
    usage: { input_tokens: 0, output_tokens: 0 },
    content_type: "application/json",
    provider_response_type: "application/json",
    routing: {
      node: context.target.node_id ?? "",
      latency_ms: 0,
      tier: "direct",
      score: 0,
      is_fallback: false,
    },
  };
  attachTokenPricingEvidence(body, response.usage);
  const usage = meterMediaUsage(
    canonical,
    response,
    "result",
    getUsageEvidence(response.usage)?.usage,
  );
  for (const [dimension, quantity] of Object.entries(quantities))
    if (dimension.startsWith("requested_") && quantity)
      usage.quantities[dimension as keyof typeof usage.quantities] = {
        ...quantity,
        quality: quantity.value === null ? "missing" : "observed",
      };
  return {
    usage,
    context: {
      ...context.pricing,
      ...mediaPricingContext(canonical, response),
    },
  };
}

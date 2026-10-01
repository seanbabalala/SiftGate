import { createHmac, timingSafeEqual } from "node:crypto";
import { PricingApiInput } from "./pricing-api-input";
import { pricingContentHash } from "./pricing-json";
import { parsePricingInstant } from "./pricing-time";
import { normalizeQuantities } from "./usage-normalizer";
import { PricingRepositoryError } from "./pricing-repository.types";
import type {
  MediaSupplierAuthentication,
  MediaSupplierEvent,
  MediaSupplierSource,
} from "./media-supplier.types";
import type { MediaTaskContext } from "./media-task.types";

export const MEDIA_SUPPLIER_EVENT_LIMIT = 4096;
export function mediaSupplierError(message: string, status = 409): never {
  throw new PricingRepositoryError(
    "pricing_media_supplier_conflict",
    message,
    status,
  );
}
export function parseMediaSupplierEvent(value: unknown): MediaSupplierEvent {
  // Bounded known fields only. No prompts, URLs, provider raw bodies or monetary claims.
  let size: number;
  try {
    size = Buffer.byteLength(JSON.stringify(value));
  } catch {
    return mediaSupplierError("Invalid event document", 400);
  }
  if (size > 32768) mediaSupplierError("Media event exceeds 32 KiB", 413);
  const input = new PricingApiInput(value),
    raw = input.body([
      "schema_version",
      "event_id",
      "task_id",
      "provider_job_id",
      "sequence",
      "status",
      "accepted_at",
      "completed_at",
      "time_quality",
      "evidence",
      "media",
      "resolved_service_tier",
    ]);
  const id = (v: unknown, field: string, max = 128) => {
    const text = input.string(v, field, max);
    if (
      !/^[A-Za-z0-9_.:/-]+$/.test(text) ||
      /\b(?:https?:|Bearer|gw_sk_|sk-)/i.test(text)
    )
      input.invalid(
        field,
        "Use an opaque identifier, not content, credentials or a URL",
      );
    return text;
  };
  const instant = (value: unknown, field: string) => {
    const result = input.string(value, field, 64);
    try {
      parsePricingInstant(result);
    } catch {
      input.invalid(field, "Use a valid absolute timestamp");
    }
    return result;
  };
  const event: MediaSupplierEvent = {
    schema_version: 1,
    event_id: id(raw.event_id, "event_id"),
    task_id: id(raw.task_id, "task_id"),
    provider_job_id: id(raw.provider_job_id, "provider_job_id", 160),
    sequence: input.string(raw.sequence, "sequence", 30),
    status: input.string(raw.status, "status") as MediaSupplierEvent["status"],
    accepted_at: instant(raw.accepted_at, "accepted_at"),
    completed_at:
      raw.completed_at === null
        ? null
        : instant(raw.completed_at, "completed_at"),
    time_quality: input.string(
      raw.time_quality,
      "time_quality",
    ) as MediaSupplierEvent["time_quality"],
    evidence: [],
  };
  if (raw.schema_version !== 1 || !/^(0|[1-9]\d{0,29})$/.test(event.sequence))
    input.invalid(
      "sequence",
      "Use schema 1 and a canonical nonnegative integer string",
    );
  if (!["pending", "completed", "failed", "cancelled"].includes(event.status))
    input.invalid("status", "Unsupported task status");
  if (!["observed", "estimated"].includes(event.time_quality))
    input.invalid("time_quality", "Declare the timestamp evidence quality");
  if ((event.status === "pending") !== (event.completed_at === null))
    input.invalid(
      "completed_at",
      "Only terminal snapshots include a completion instant",
    );
  try {
    if (
      event.completed_at &&
      parsePricingInstant(event.completed_at) <
        parsePricingInstant(event.accepted_at)
    )
      input.invalid("completed_at", "Completion cannot precede acceptance");
  } catch {
    input.invalid("accepted_at", "Valid absolute instants are required");
  }
  const seen = new Set<string>();
  event.evidence = input
    .array(raw.evidence, "evidence", 40)
    .map((value, index) => {
      const field = `evidence.${index}`,
        row = input.object(value, field, ["dimension", "value", "quality"]);
      const evidence = input.evidence([
        { ...row, source: "provider_job_result" },
      ])[0];
      if (
        seen.has(evidence.dimension) ||
        evidence.dimension.startsWith("requested_")
      )
        input.invalid(field, "Duplicate or request-owned metering dimension");
      seen.add(evidence.dimension);
      if (
        !(
          row.value === null ||
          (typeof row.value === "string" &&
            /^\d{1,30}(?:\.\d{1,18})?$/.test(row.value))
        )
      )
        input.invalid(
          field,
          "Quantities must be exact nonnegative decimal strings or null",
        );
      if (
        (row.value === null) !==
        ["missing", "unsupported"].includes(evidence.quality!)
      )
        input.invalid(
          field,
          "Missing/unsupported quantities use null; known quantities need explicit quality",
        );
      if (row.quality === undefined)
        input.invalid(field, "Explicit evidence quality is required");
      return {
        dimension: evidence.dimension,
        value: row.value as string | null,
        quality: evidence.quality!,
      };
    });
  if (raw.media !== undefined || raw.resolved_service_tier !== undefined) {
    const context = input.context({
      ...(raw.media !== undefined ? { media: raw.media } : {}),
      ...(raw.resolved_service_tier !== undefined
        ? { resolved_service_tier: raw.resolved_service_tier }
        : {}),
    });
    if (context.media) event.media = context.media;
    if (context.resolved_service_tier)
      event.resolved_service_tier = context.resolved_service_tier;
  }
  input.done();
  const normalized = normalizeQuantities(
    event.evidence.map((e) => ({
      ...e,
      source: "provider_job_result" as const,
    })),
    {
      adapter_id: "siftgate-media-event",
      adapter_version: "1",
      source: "provider_job_result",
    },
  );
  if (normalized.diagnostics.length)
    mediaSupplierError("Media event quantities are inconsistent", 400);
  return event;
}
export function mediaSupplierSigningInput(
  sourceId: string,
  revision: string,
  timestamp: string,
  event: MediaSupplierEvent,
): string {
  return `siftgate-media-v1\n${sourceId}\n${revision}\n${timestamp}\n${pricingContentHash(event)}`;
}
export function authenticateMediaSupplierEvent(
  source: MediaSupplierSource,
  event: MediaSupplierEvent,
  auth: MediaSupplierAuthentication,
  secret: string | undefined,
  now = Date.now(),
): void {
  const denied = () =>
    mediaSupplierError("Media event authentication failed", 401);
  if (
    source.enabled !== 1 ||
    auth.revision !== String(source.revision) ||
    !/^\d{10}$/.test(auth.timestamp) ||
    Math.abs(Number(auth.timestamp) * 1000 - now) > 300000 ||
    !/^v1=[a-f0-9]{64}$/.test(auth.signature) ||
    !secret ||
    Buffer.byteLength(secret) < 32 ||
    Buffer.byteLength(secret) > 4096
  )
    denied();
  const expected = createHmac("sha256", secret!)
    .update(
      mediaSupplierSigningInput(
        source.id,
        auth.revision,
        auth.timestamp,
        event,
      ),
    )
    .digest();
  if (!timingSafeEqual(expected, Buffer.from(auth.signature.slice(3), "hex")))
    denied();
}
export function supplierEventMetering(
  context: MediaTaskContext,
  event: MediaSupplierEvent,
) {
  if (event.media?.operation && event.media.operation !== context.operation)
    mediaSupplierError("Media event operation differs from the original task");
  const usage = normalizeQuantities(
    event.evidence.map((e) => ({
      ...e,
      source: "provider_job_result" as const,
    })),
    {
      adapter_id: "siftgate-media-event",
      adapter_version: "1",
      source: "provider_job_result",
    },
  );
  for (const [dimension, quantity] of Object.entries(
    context.request_usage.quantities,
  ))
    if (dimension.startsWith("requested_") && quantity)
      usage.quantities[dimension as keyof typeof usage.quantities] = {
        ...quantity,
      };
  // Preserve old observation hashes for tasks created before provenance capture.
  // For new tasks, event fields are provider evidence, not the original request's values.
  const provenance = context.pricing.media_adapter !== undefined || context.pricing.media_sources !== undefined
    ? { media_adapter: "siftgate-media-event-v1" as const, media_sources: {
        ...context.pricing.media_sources,
        ...Object.fromEntries(Object.keys(event.media ?? {}).map(key => [key, "provider_result" as const])),
      } }
    : {};
  return {
    usage,
    context: {
      ...context.pricing,
      ...provenance,
      media: { ...context.pricing.media, ...event.media },
      ...(event.resolved_service_tier
        ? { resolved_service_tier: event.resolved_service_tier }
        : {}),
      provider_accepted_at: event.accepted_at,
      ...(event.completed_at ? { completed_at: event.completed_at } : {}),
      time_estimated: event.time_quality === "estimated",
    },
  };
}

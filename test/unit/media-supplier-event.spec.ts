import { createHmac } from "node:crypto";
import {
  authenticateMediaSupplierEvent,
  mediaSupplierSigningInput,
  parseMediaSupplierEvent,
} from "../../src/pricing/media-supplier-event";
import type {
  MediaSupplierEvent,
  MediaSupplierSource,
} from "../../src/pricing/media-supplier.types";

export function supplierEvent(
  sequence = "1",
  seconds = "6.4",
): MediaSupplierEvent {
  return {
    schema_version: 1,
    event_id: `event-${sequence}`,
    task_id: "attempt-a",
    provider_job_id: "provider-task",
    sequence,
    status: "completed",
    accepted_at: "2026-09-27T00:00:00Z",
    completed_at: "2026-09-27T00:00:08Z",
    time_quality: "observed",
    evidence: [
      { dimension: "video_seconds", value: seconds, quality: "observed" },
      { dimension: "video_generation_count", value: "1", quality: "observed" },
    ],
  };
}
describe("normalized supplier media event authentication", () => {
  const secret = "synthetic-media-event-secret-not-production";
  const source = {
    id: "source-a",
    enabled: 1,
    revision: 2,
  } as MediaSupplierSource;
  const event = supplierEvent(),
    timestamp = "1790467200";
  const auth = () => ({
    timestamp,
    revision: "2",
    signature:
      "v1=" +
      createHmac("sha256", secret)
        .update(mediaSupplierSigningInput(source.id, "2", timestamp, event))
        .digest("hex"),
  });
  it("authenticates canonical complete snapshots without signing or storing raw content", () => {
    expect(parseMediaSupplierEvent(event)).toEqual(event);
    authenticateMediaSupplierEvent(
      source,
      event,
      auth(),
      secret,
      Number(timestamp) * 1000,
    );
    const reordered = Object.fromEntries(
      Object.entries(event).reverse(),
    ) as unknown as MediaSupplierEvent;
    authenticateMediaSupplierEvent(
      source,
      reordered,
      auth(),
      secret,
      Number(timestamp) * 1000,
    );
    expect(() =>
      authenticateMediaSupplierEvent(
        source,
        { ...event, sequence: "2" },
        auth(),
        secret,
        Number(timestamp) * 1000,
      ),
    ).toThrow("authentication");
  });
  it("allows ordinary task-prefixed opaque identifiers without mistaking them for a secret", () => {
    const value={...event,task_id:"task-123",provider_job_id:"task-456"};
    expect(parseMediaSupplierEvent(value)).toEqual(value);
  });
  it.each([
    { signature: "v1=bad" },
    { revision: "1" },
    { timestamp: "0" },
    { timestamp: "1790460000" },
    { signature: "v1=" + "0".repeat(64) },
  ])("rejects invalid, stale or wrong-version authentication %j", (patch) => {
    expect(() =>
      authenticateMediaSupplierEvent(
        source,
        event,
        { ...auth(), ...patch },
        secret,
        Number(timestamp) * 1000,
      ),
    ).toThrow("authentication");
  });
  it("rejects disabled sources and weak/unavailable keys", () => {
    for (const key of [undefined, "short"])
      expect(() =>
        authenticateMediaSupplierEvent(
          source,
          event,
          auth(),
          key,
          Number(timestamp) * 1000,
        ),
      ).toThrow("authentication");
    expect(() =>
      authenticateMediaSupplierEvent(
        { ...source, enabled: 0 },
        event,
        auth(),
        secret,
        Number(timestamp) * 1000,
      ),
    ).toThrow("authentication");
  });
  it.each([
    { sequence: "01" },
    { sequence: "1e20" },
    { sequence: "-1" },
    { sequence: 2 },
    { prompt: "do not retain" },
    { provider_job_id: "https://private.example/job" },
    { event_id: "Bearer_secret" },
    { accepted_at: "2026-02-30T00:00:00Z" },
    { completed_at: "2026-09-26T00:00:00Z" },
    { status: "unknown" },
    { time_quality: "trusted" },
    { status: "pending" },
    { completed_at: null },
    {
      evidence: [{ dimension: "video_seconds", value: 1, quality: "observed" }],
    },
    {
      evidence: [
        { dimension: "video_seconds", value: "1", quality: "missing" },
      ],
    },
    {
      evidence: [
        {
          dimension: "requested_video_seconds",
          value: "1",
          quality: "observed",
        },
      ],
    },
    { evidence: [{ dimension: "video_seconds", value: "1" }] },
    {
      evidence: [
        {
          dimension: "video_seconds",
          value: "1",
          quality: "observed",
          source: "provider_usage",
        },
      ],
    },
    {
      evidence: [
        {
          dimension: "video_generation_count",
          value: "0.1",
          quality: "observed",
        },
      ],
    },
  ])(
    "rejects unknown fields, invalid times and ambiguous quantities %j",
    (patch) => {
      expect(() => parseMediaSupplierEvent({ ...event, ...patch })).toThrow();
    },
  );
  it("accepts known zero and explicit missing separately, without numerical coercion", () => {
    const e = {
      ...event,
      evidence: [
        {
          dimension: "video_seconds" as const,
          value: "0",
          quality: "observed" as const,
        },
        {
          dimension: "video_generation_count" as const,
          value: null,
          quality: "missing" as const,
        },
      ],
    };
    expect(parseMediaSupplierEvent(e).evidence).toEqual(e.evidence);
  });
  it("rejects duplicate dimensions and invalid partitions", () => {
    expect(() =>
      parseMediaSupplierEvent({
        ...event,
        evidence: [event.evidence[0], event.evidence[0]],
      }),
    ).toThrow();
    expect(() =>
      parseMediaSupplierEvent({
        ...event,
        evidence: [
          { dimension: "total_input_tokens", value: "1", quality: "observed" },
          { dimension: "cache_read_tokens", value: "2", quality: "observed" },
        ],
      }),
    ).toThrow();
  });
});

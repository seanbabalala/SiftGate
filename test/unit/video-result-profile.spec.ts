import { calculateCost } from "../../src/pricing/cost-calculator";
import { compilePriceBook } from "../../src/pricing/pricing-compiler";
import { book, rate } from "./pricing-fixtures";
import { MediaNormalizer } from "../../src/canonical/normalizers/media.normalizer";
import {
  translateNativeVideoResult,
  nativeVideoRequestUsage,
  nativeVideoPricingContext,
  nativeVideoTaskContext,
  nativeVideoJobId,
  videoProfileStatusPath,
  videoResultProfile,
  nativeVideoGenerationPath,
  nativeVideoRequestShape,
} from "../../src/pricing/video-result-profile";
import {
  meterMediaUsage,
  mediaPricingContext,
} from "../../src/pricing/media-metering";
import { validateConfigObject } from "../../src/config/config-validator";
import { validateSync } from "class-validator";
import { CreateNodeDto, UpdateNodeDto } from "../../src/dashboard/dto/node.dto";

const google = {
  name: "models/synthetic-veo/operations/task-1",
  done: true,
  response: {
    generateVideoResponse: {
      generatedSamples: [
        { video: { uri: "https://media.invalid/video-1" } },
        { video: { uri: "https://media.invalid/video-2" } },
      ],
      raiMediaFilteredCount: 1,
    },
  },
};
const runway = {
  id: "17f20503-6c24-4c16-946b-35dbbce2af2f",
  status: "SUCCEEDED",
  createdAt: "2026-09-27T01:02:03.123Z",
  output: ["https://media.invalid/output-1"],
  cost: { credits: 25 },
};
const canonical = (payload: Record<string, unknown>) =>
  new MediaNormalizer().normalize(
    { model: "synthetic-video", ...payload },
    {},
    "video_generation",
  );

describe("explicit native video result profiles", () => {
  it("counts Gemini REST outputs without importing filtered outputs, request duration, credits or provider content", () => {
    const value = translateNativeVideoResult("gemini-veo-rest-v1", {
      ...google,
      duration: 8,
      usage: { video_seconds: 100 },
      prompt: "PRIVATE-CONTENT",
    });
    expect(value.status).toBe("completed");
    expect(value.usage.quantities.video_generation_count).toMatchObject({
      value: "2",
      quality: "observed",
      source: "provider_job_result",
    });
    expect(value.usage.quantities.video_seconds).toMatchObject({
      value: null,
      quality: "unsupported",
    });
    expect(value.context).toMatchObject({ time_estimated: true });
    expect(JSON.stringify(value)).not.toMatch(/https:|PRIVATE|video-1/);
  });
  it("counts Runway output URLs but does not use vendor credit totals as money or task creation as acceptance", () => {
    const value = translateNativeVideoResult("runway-task-v1", {
      ...runway,
      duration: 8,
      usage: { video_seconds: "999" },
      failure: "PRIVATE",
    });
    expect(value.usage.quantities.video_generation_count?.value).toBe("1");
    expect(value.usage.quantities.video_seconds?.value).toBeNull();
    expect(value.provider_created_at).toBe(runway.createdAt);
    expect(value).not.toHaveProperty("cost");
    expect(value).not.toHaveProperty("estimatedCost");
    expect(value.context.provider_accepted_at).toBeUndefined();
    expect(value.context.completed_at).toBeUndefined();
    expect(JSON.stringify(value)).not.toMatch(/https:|PRIVATE|999/);
  });
  it.each(["PENDING", "THROTTLED", "RUNNING", "FAILED", "CANCELLED"])(
    "keeps Runway %s non-success usage unknown, never auto-free",
    (status) => {
      const value = translateNativeVideoResult("runway-task-v1", {
        id: runway.id,
        status,
        createdAt: runway.createdAt,
        cost: { credits: 0 },
      });
      expect(value.status).toBe(
        status === "FAILED"
          ? "failed"
          : status === "CANCELLED"
            ? "cancelled"
            : "pending",
      );
      expect(value.usage.quantities.video_generation_count?.value).toBeNull();
      expect(value.usage.quantities.video_seconds?.value).toBeNull();
    },
  );
  it("handles native submission acknowledgements, pending and cancellation without inventing terminal usage", () => {
    expect(
      translateNativeVideoResult("gemini-veo-rest-v1", { name: google.name })
        .status,
    ).toBe("pending");
    expect(
      translateNativeVideoResult("gemini-veo-rest-v1", {
        name: google.name,
        done: false,
      }).status,
    ).toBe("pending");
    expect(
      translateNativeVideoResult("gemini-veo-rest-v1", {
        name: google.name,
        done: true,
        error: { code: 1, message: "PRIVATE" },
      }).status,
    ).toBe("cancelled");
    expect(
      translateNativeVideoResult("gemini-veo-rest-v1", {
        name: google.name,
        done: true,
        error: { code: 13 },
      }).status,
    ).toBe("failed");
    expect(
      translateNativeVideoResult("runway-task-v1", { id: runway.id }).status,
    ).toBe("pending");
  });
  it("distinguishes an explicit empty inventory from an absent inventory", () => {
    for (const outputs of [undefined, []]) {
      const value = translateNativeVideoResult("gemini-veo-rest-v1", {
        ...google,
        response: {
          generateVideoResponse: {
            generatedSamples: outputs,
            raiMediaFilteredCount: 1,
          },
        },
      });
      expect(value.usage.quantities.video_generation_count?.value).toBe(
        outputs ? "0" : null,
      );
      expect(value.usage.quantities.video_seconds?.value).toBeNull();
    }
    expect(
      translateNativeVideoResult("runway-task-v1", { ...runway, output: [] })
        .usage.quantities.video_generation_count?.value,
    ).toBe("0");
  });
  it.each([
    { ...google, done: "true" },
    { ...google, done: false },
    { ...google, error: { code: 13 } },
    { name: google.name, done: true },
    {
      ...google,
      response: {
        generatedVideos: google.response.generateVideoResponse.generatedSamples,
      },
    },
    {
      ...google,
      response: { generateVideoResponse: { generatedSamples: [{}] } },
    },
    {
      ...google,
      response: {
        generateVideoResponse: {
          generatedSamples: Array(65).fill({
            video: { uri: "https://media.invalid/a" },
          }),
        },
      },
    },
  ])("refuses malformed or wrong-version Gemini envelopes", (body) =>
    expect(() =>
      translateNativeVideoResult("gemini-veo-rest-v1", body),
    ).toThrow(),
  );
  it.each([
    "not-uri",
    "file:///private/movie",
    "https://secret@media.invalid/a",
    "data:video/mp4;base64,PRIVATE",
  ])("refuses invalid output identity %s without fetching it", (uri) => {
    expect(() =>
      translateNativeVideoResult("runway-task-v1", {
        ...runway,
        output: [uri],
      }),
    ).toThrow();
  });
  it("does not silently deduplicate repeated output identities or ignore malformed entries", () => {
    expect(() =>
      translateNativeVideoResult("runway-task-v1", {
        ...runway,
        output: [runway.output[0], runway.output[0]],
      }),
    ).toThrow("duplicated");
    expect(() =>
      translateNativeVideoResult("runway-task-v1", {
        ...runway,
        output: [runway.output[0], null],
      }),
    ).toThrow();
    expect(() =>
      translateNativeVideoResult("runway-task-v1", {
        ...runway,
        status: "RUNNING",
      }),
    ).toThrow();
    expect(() =>
      translateNativeVideoResult("runway-task-v1", {
        ...runway,
        status: "NEW_STATE",
      }),
    ).toThrow();
  });
  it("reserves aggregate native durations exactly but retains request duration separately", () => {
    const request = canonical({
      instances: [{ prompt: "PRIVATE" }],
      parameters: {
        durationSeconds: "6.4",
        sampleCount: 3,
        resolution: "1080p",
      },
      seconds: 1,
      n: 1,
    });
    const estimate = nativeVideoRequestUsage(
      request,
      "gemini-veo-rest-v1",
      true,
    );
    expect(estimate.quantities.video_seconds).toMatchObject({
      value: "19.200000000000000000",
      quality: "estimated",
    });
    expect(estimate.quantities.requested_video_seconds).toMatchObject({
      value: "6.4",
      source: "request_metadata",
    });
    expect(estimate.quantities.requested_video_generation_count?.value).toBe(
      "3",
    );
    const result = meterMediaUsage(
      request,
      undefined,
      "result",
      undefined,
      "gemini-veo-rest-v1",
    );
    expect(result.quantities.video_seconds).toBeUndefined();
    expect(
      mediaPricingContext(request, undefined, "gemini-veo-rest-v1"),
    ).toMatchObject({ media: { resolution: "1080p" }, media_estimated: true });
    expect(JSON.stringify(estimate)).not.toMatch(/PRIVATE|prompt/);
  });
  it("does not turn malformed or unspecified native request quantities into zero or generic fallback quantities", () => {
    for (const sampleCount of [
      null,
      "bad",
      -1,
      0.5,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      const value = nativeVideoRequestUsage(
        canonical({ parameters: { durationSeconds: 8, sampleCount } }),
        "gemini-veo-rest-v1",
        true,
      );
      expect(value.quantities.video_seconds).toMatchObject({
        value: null,
        quality: "missing",
      });
    }
    expect(
      nativeVideoRequestUsage(canonical({ seconds: 8 }), "runway-task-v1", true)
        .quantities.video_seconds?.value,
    ).toBeNull();
    expect(
      nativeVideoRequestUsage(
        canonical({ duration: "9007199254740993.123" }),
        "runway-task-v1",
        true,
      ).quantities.video_seconds?.value,
    ).toBe("9007199254740993.123000000000000000");
  });
  it("validates and preserves native operation paths without accepting path traversal or URLs", () => {
    expect(
      videoProfileStatusPath("gemini-veo-rest-v1", "/v1beta/{id}", google.name),
    ).toBe("/v1beta/" + google.name);
    expect(videoProfileStatusPath("generic-v1", "/jobs/:id", google.name)).toBe(
      "/jobs/" + encodeURIComponent(google.name),
    );
    for (const name of [
      "https://private.invalid/operations/a",
      "operations/../secret",
      "operations/a%2fsecret",
      "projects/p/locations/x/operations/a",
    ])
      expect(() => nativeVideoJobId("gemini-veo-rest-v1", { name })).toThrow();
    expect(() =>
      nativeVideoJobId("runway-task-v1", { id: "not-a-uuid" }),
    ).toThrow();
  });
  it("preserves missing native provider instants and does not mutate the original pricing context", () => {
    const original = {
      provider_accepted_at: "2026-09-27T00:00:00Z",
      completed_at: "2026-09-27T00:01:00Z",
      attempt_dispatched_at: "2026-09-27T00:00:00Z",
    };
    expect(nativeVideoTaskContext(original)).toEqual({
      attempt_dispatched_at: original.attempt_dispatched_at,
      time_estimated: true,
      media_estimated: true,
    });
    expect(original.completed_at).toBeDefined();
    expect(
      nativeVideoPricingContext(
        canonical({ ratio: "1280:720" }),
        "runway-task-v1",
      ).media,
    ).toMatchObject({ width: "1280", height: "720", size: "1280x720" });
  });
  it("prices a known native output count without treating unused unsupported seconds as a parsing failure", () => {
    const usage = translateNativeVideoResult("runway-task-v1", runway).usage;
    const count = compilePriceBook(
      book([rate("clips", "video_generation_count", "0.04", "1")]),
      { book_id: "synthetic", version_id: "1" },
    );
    expect(calculateCost(usage, count.resolve(usage))).toMatchObject({
      report_amount: "0.040000000",
      status: "priced",
    });
    const duration = compilePriceBook(
      book([rate("duration", "video_seconds", "0.10", "1")]),
      { book_id: "synthetic", version_id: "1" },
    );
    expect(calculateCost(usage, duration.resolve(usage))).toMatchObject({
      report_amount: null,
      status: "missing_usage",
    });
  });
  it("requires matching native request schemas and Gemini model endpoints before dispatch", () => {
    expect(
      nativeVideoRequestShape("gemini-veo-rest-v1", {
        instances: [{ prompt: "synthetic" }],
      }),
    ).toBe(true);
    expect(
      nativeVideoRequestShape("gemini-veo-rest-v1", {
        instances: [{ prompt: "a" }, { prompt: "b" }],
      }),
    ).toBe(false);
    expect(
      nativeVideoRequestShape("runway-task-v1", { prompt: "generic" }),
    ).toBe(false);
    expect(
      nativeVideoGenerationPath(
        "gemini-veo-rest-v1",
        "/v1beta/models/{model}:predictLongRunning",
        "synthetic",
      ),
    ).toBe("/v1beta/models/synthetic:predictLongRunning");
    expect(() =>
      nativeVideoGenerationPath(
        "gemini-veo-rest-v1",
        "/v1beta/models/other:predictLongRunning",
        "synthetic",
      ),
    ).toThrow();
  });
  it("accepts sub-millisecond native creation metadata without using it as a pricing timestamp", () => {
    const value = translateNativeVideoResult("runway-task-v1", {
      ...runway,
      createdAt: "2026-09-27T01:02:03.123456789Z",
    });
    expect(value.provider_created_at).toBe("2026-09-27T01:02:03.123456789Z");
    expect(value.context.provider_accepted_at).toBeUndefined();
    expect(() =>
      translateNativeVideoResult("runway-task-v1", {
        ...runway,
        createdAt: "2026-02-30T01:02:03.123456789Z",
      }),
    ).toThrow();
  });
  it('accepts literal video endpoint slots without relaxing secret-reference validation', () => {
    const check=(patch:Record<string,unknown>)=>validateConfigObject({nodes:[{id:'n',name:'n',protocol:'chat_completions',base_url:'http://mock.invalid',endpoint:'/chat',models:[],api_key:'SYNTHETIC',...patch}]},{env:{}});
    const valid=check({video_generations_endpoint:'/v1beta/models/{model}:predictLongRunning',video_endpoint:'/v1beta/models/{model}:predictLongRunning',video_status_endpoint:'/v1beta/{id}'});
    expect(valid.errors.filter(e=>e.code==='malformed_secret_reference')).toEqual([]);
    const unset=check({video_status_endpoint:'/${env:MISSING}/{id}'});expect(unset.errors.filter(e=>e.code==='malformed_secret_reference')).toEqual([]);expect(unset.warnings.some(e=>e.code==='env_reference_unset')).toBe(true);
    for(const patch of [{api_key:'secret{id}'},{video_status_endpoint:'/{id}}'},{video_status_endpoint:'/${bogus:x}/{id}'},{video_status_endpoint:'/${env:KEY:-{id}}'},{video_endpoint:'/{unknown}'},{video_status_endpoint:'/${id}'}])
      expect(check(patch).errors.some(e=>['malformed_secret_reference','malformed_env_reference'].includes(e.code))).toBe(true);
  });
  it("requires explicit known profiles in YAML validation and dashboard DTOs", () => {
    expect(videoResultProfile(undefined)).toBe("generic-v1");
    expect(() => videoResultProfile("future")).toThrow();
    for (const profile of [
      "generic-v1",
      "gemini-veo-rest-v1",
      "runway-task-v1",
      "unknown",
      null,
    ]) {
      const result = validateConfigObject(
        {
          nodes: [
            {
              id: "n",
              name: "n",
              protocol: "chat_completions",
              base_url: "http://mock.invalid",
              endpoint: "/chat",
              models: [],
              api_key: "SYNTHETIC",
              video_result_profile: profile,
            },
          ],
        },
        { env: {} },
      );
      expect(
        result.errors.some((e) => e.code === "invalid_video_result_profile"),
      ).toBe(profile === null || profile === "unknown");
      for (const Type of [CreateNodeDto, UpdateNodeDto]) {
        const errors = validateSync(
          Object.assign(new Type(), { video_result_profile: profile }),
        );
        expect(errors.some((e) => e.property === "video_result_profile")).toBe(
          profile === "unknown",
        );
      }
    }
  });
});

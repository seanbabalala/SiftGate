import type {
  CanonicalRequest,
  Tier,
} from "../../src/canonical/canonical.types";
import { getUsageEvidence } from "../../src/canonical/usage-evidence";
import type { NodeConfig } from "../../src/config/gateway.config";
import type { ConfigService } from "../../src/config/config.service";
import { ProviderClientService } from "../../src/providers/provider-client.service";
import { CredentialPoolService } from "../../src/providers/credential-pool.service";
import { TelemetryService } from "../../src/telemetry/telemetry.service";
import { providerFailureUsage } from "../../src/providers/provider-failure-evidence";

describe("provider dispatch observer boundary", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });
  const canonical: CanonicalRequest = {
    messages: [{ role: "user", content: "synthetic" }],
    stream: false,
    metadata: {
      source_format: "chat_completions",
      original_model: "model",
      raw_headers: {},
    },
  };
  const routing = { tier: "standard" as Tier, score: 0, is_fallback: false };
  function client(overrides: Partial<NodeConfig> = {}) {
    const node: NodeConfig = {
      id: "node",
      name: "Synthetic",
      protocol: "chat_completions",
      base_url: "http://mock-upstream.test",
      endpoint: "/v1/chat/completions",
      models: ["model"],
      timeout_ms: 1000,
      credentials: [
        { id: "a", api_key: "synthetic-a" },
        { id: "b", api_key: "synthetic-b" },
      ],
      ...overrides,
    };
    const pool = new CredentialPoolService();
    return {
      pool,
      service: new ProviderClientService(
        { getNode: () => node } as unknown as ConfigService,
        new TelemetryService(),
        undefined,
        undefined,
        pool,
      ),
    };
  }
  const response = () =>
    new Response(
      JSON.stringify({
        model: "reported",
        choices: [],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
      { headers: { "content-type": "application/json" } },
    );

  it("waits for the durable begin callback before invoking fetch", async () => {
    const fetch = jest.fn(async () => response());
    global.fetch = fetch;
    let persisted!: () => void;
    const gate = new Promise<void>((resolve) => {
      persisted = resolve;
    });
    const begin = jest.fn(async () => {
      await gate;
      return { failed: jest.fn() };
    });
    const pending = client().service.forward(
      canonical,
      "node",
      "model",
      routing,
      { pricingAttempts: { begin } },
    );
    for (let i = 0; i < 20 && begin.mock.calls.length === 0; i++)
      await new Promise((resolve) => setImmediate(resolve));
    try {
      expect(begin).toHaveBeenCalledTimes(1);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      persisted();
    }
    await pending;
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("never selects a credential, records an attempt or calls fetch for a pre-aborted operation", async () => {
    const { service, pool } = client();
    const selected = jest.spyOn(pool, "select");
    const fetch = jest.fn(async () => response());
    global.fetch = fetch;
    const controller = new AbortController();
    controller.abort();
    const begin = jest.fn();
    await expect(
      service.forward(canonical, "node", "model", routing, {
        signal: controller.signal,
        pricingAttempts: { begin },
      }),
    ).rejects.toMatchObject({ statusCode: 499 });
    expect(fetch).not.toHaveBeenCalled();
    expect(begin).not.toHaveBeenCalled();
    expect(selected).not.toHaveBeenCalled();
  });

  it("does not continue through other credentials after an external abort during fetch", async () => {
    const { service } = client();
    const controller = new AbortController();
    const fetch = jest.fn(async () => {
      controller.abort();
      throw new DOMException("synthetic abort", "AbortError");
    });
    global.fetch = fetch;
    const failed = jest.fn(async () => undefined),
      begin = jest.fn(async () => ({ failed }));
    await expect(
      service.forward(canonical, "node", "model", routing, {
        signal: controller.signal,
        pricingAttempts: { begin },
      }),
    ).rejects.toBeDefined();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(begin).toHaveBeenCalledTimes(1);
    expect(failed).toHaveBeenCalledWith("client_aborted");
  });

  it("retains the wire model for Gemini where the model is encoded in the URL instead of the JSON body", async () => {
    const fetch = jest.fn(
      async () =>
        new Response(
          JSON.stringify({
            modelVersion: "gemini-reported",
            candidates: [],
            usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    global.fetch = fetch;
    const begin = jest.fn(async () => ({ failed: jest.fn() }));
    await client({
      protocol: "gemini",
      endpoint: "/v1beta/models/:model:generateContent",
      upstream_model_aliases: { model: "gemini-wire" },
    }).service.forward(canonical, "node", "model", routing, {
      pricingAttempts: { begin },
    });
    expect(begin).toHaveBeenCalledWith(
      expect.objectContaining({
        wire_model: "gemini-wire",
        protocol: "gemini",
      }),
    );
  });

  it("parses only explicit failure usage and keeps missing, invalid and zero counters distinct", () => {
    expect(providerFailureUsage("not-json")).toBeUndefined();
    const missing = getUsageEvidence(
      providerFailureUsage('{"error":{"message":"private"}}')!,
    )!;
    expect(missing.usage.quantities.total_input_tokens?.value).toBeNull();
    expect(JSON.stringify(missing)).not.toContain("private");
    const zero = getUsageEvidence(
      providerFailureUsage(
        '{"usage":{"prompt_tokens":0,"completion_tokens":0}}',
      )!,
    )!;
    expect(zero.usage.quantities.total_input_tokens?.value).toBe("0");
    const invalid = getUsageEvidence(
      providerFailureUsage(
        '{"usage":{"prompt_tokens":-5,"completion_tokens":0}}',
      )!,
    )!;
    expect(invalid.usage.quantities.total_input_tokens?.value).toBeNull();
    expect(invalid.usage.diagnostics.length).toBeGreaterThan(0);
    const audio = getUsageEvidence(
      providerFailureUsage(
        '{"usage":{"audio_output_seconds":"0.001"},"audio":"private-bytes"}',
        undefined,
        "audio_speech",
      )!,
    )!;
    expect(audio.usage.quantities.audio_output_seconds?.value).toBe("0.001");
    expect(JSON.stringify(audio)).not.toContain("private-bytes");
    const rerank = getUsageEvidence(
      providerFailureUsage(
        '{"meta":{"billed_units":{"search_units":"7"},"document_count":"3"}}',
        undefined,
        "rerank",
      )!,
    )!;
    expect(rerank.usage.quantities.rerank_document_count?.value).toBe("3");
    expect(rerank.usage.quantities.rerank_search_units?.value).toBe("7");
  });
});

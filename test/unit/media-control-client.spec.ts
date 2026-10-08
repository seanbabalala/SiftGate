import {
  fetchMediaControl,
  mediaControlHeaders,
  readMediaControlMetadata,
} from "../../src/pricing/media-control-client";
import type { NodeConfig } from "../../src/config/gateway.config";

const node: NodeConfig = {
  id: "synthetic",
  name: "synthetic",
  base_url: "http://synthetic.test",
  protocol: "chat_completions",
  endpoint: "/generate",
  timeout_ms: 1000,
  models: [],
  credentials: [
    { id: "original", api_key: "key-a" },
    { id: "other", api_key: "key-b" },
  ],
};
describe("bounded pinned media controls", () => {
  afterEach(() => jest.restoreAllMocks());
  it("implements bearer, Google, Anthropic and custom-header authentication on the pinned logical credential", async () => {
    expect(await mediaControlHeaders(node, "other")).toEqual({
      Authorization: "Bearer key-b",
    });
    expect(
      await mediaControlHeaders({ ...node, protocol: "gemini" }, "original"),
    ).toEqual({ "x-goog-api-key": "key-a" });
    expect(
      await mediaControlHeaders({ ...node, protocol: "messages" }, "original"),
    ).toEqual({ "x-api-key": "key-a", "anthropic-version": "2023-06-01" });
    expect(
      await mediaControlHeaders(
        {
          ...node,
          auth_type: "custom-header",
          auth_header_name: "X-Auth",
          auth_header_prefix: "Token",
          headers: { "X-Extra": "value" },
        },
        "other",
      ),
    ).toEqual({ "X-Auth": "Token key-b", "X-Extra": "value" });
    await expect(mediaControlHeaders(node, "missing")).rejects.toThrow(
      "Original media task credential",
    );
    await expect(
      mediaControlHeaders(
        {
          ...node,
          credentials: [{ id: "original", api_key: "key", enabled: false }],
        },
        "original",
      ),
    ).rejects.toThrow("Original media task credential");
  });
  it("bounds body read time, not just response headers, and cancels hanging mock streams", async () => {
    const cancel = jest.fn();
    jest
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(new ReadableStream({ start() {}, cancel })),
      );
    const controllers = new Set<AbortController>();
    const response = await fetchMediaControl(
      "http://synthetic.test/status",
      {},
      controllers,
      30,
    );
    await expect(readMediaControlMetadata(response)).rejects.toMatchObject({
      code: "pricing_media_control_aborted",
    });
    expect(controllers.size).toBe(0);
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it("supports shutdown abort while a body is pending", async () => {
    jest
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(new ReadableStream({ start() {} })));
    const controllers = new Set<AbortController>();
    const response = await fetchMediaControl(
      "http://synthetic.test/status",
      {},
      controllers,
      5000,
    );
    const result = readMediaControlMetadata(response);
    for (const controller of controllers) controller.abort();
    await expect(result).rejects.toMatchObject({
      code: "pricing_media_control_aborted",
    });
    expect(controllers.size).toBe(0);
  });
  it("caps metadata, follows no credential-bearing redirects and treats 204 as acknowledgement only", async () => {
    const fetch = jest
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ payload: "x".repeat(140000) })),
      );
    const response = await fetchMediaControl(
      "http://synthetic.test/status",
      {},
      new Set(),
      5000,
    );
    expect(fetch.mock.calls[0][1]?.redirect).toBe("error");
    await expect(readMediaControlMetadata(response)).rejects.toMatchObject({
      code: "pricing_media_control_too_large",
    });
    expect(
      await readMediaControlMetadata(new Response(null, { status: 204 })),
    ).toEqual({});
    await expect(
      readMediaControlMetadata(new Response("PRIVATE ERROR", { status: 500 })),
    ).rejects.toThrow("Provider media control request failed");
  });
  it("streams content with cancellation rather than buffering the entire result", async () => {
    const cancel = jest.fn();
    jest.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3]));
          },
          cancel,
        }),
      ),
    );
    const controllers = new Set<AbortController>();
    const response = await fetchMediaControl(
      "http://synthetic.test/content",
      {},
      controllers,
      5000,
    );
    const reader = response.body!.getReader();
    expect((await reader.read()).value).toEqual(new Uint8Array([1, 2, 3]));
    await reader.cancel();
    expect(controllers.size).toBe(0);
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

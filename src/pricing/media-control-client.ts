import type { NodeConfig } from "../config/gateway.config";
import type { SecretReferenceResolverService } from "../config/secret-reference-resolver.service";
import { PricingRepositoryError } from "./pricing-repository.types";

/** Same authentication conventions as ProviderClient; never select another credential for an existing job. */
export async function mediaControlHeaders(
  node: NodeConfig,
  credentialId: string,
  secrets?: SecretReferenceResolverService,
): Promise<Record<string, string>> {
  const credentials = node.credentials?.length
    ? node.credentials
    : node.api_key
      ? [{ id: "default", api_key: node.api_key, enabled: true }]
      : [];
  const credential = credentials.find(
    (entry) => entry.id === credentialId && entry.enabled !== false,
  );
  if (!credential)
    throw new PricingRepositoryError(
      "pricing_media_credential_unavailable",
      "Original media task credential is unavailable",
      409,
    );
  const key = secrets
    ? await secrets.resolveString(credential.api_key, {
        location: `nodes.${node.id}.credentials.${credential.id}.api_key`,
      })
    : credential.api_key;
  const custom = secrets
    ? await secrets.resolveRecord(node.headers, {
        optional: true,
        location: `nodes.${node.id}.headers`,
      })
    : { ...node.headers };
  const headers: Record<string, string> = {};
  const type =
    node.auth_type ??
    (node.protocol === "messages" || node.protocol === "gemini"
      ? "x-api-key"
      : "bearer");
  if (type === "custom-header") {
    if (!node.auth_header_name?.trim())
      throw new PricingRepositoryError(
        "pricing_media_auth_invalid",
        "Media node custom authentication header is not configured",
        409,
      );
    headers[node.auth_header_name.trim()] = node.auth_header_prefix
      ? `${node.auth_header_prefix} ${key}`
      : key;
  } else if (type === "x-api-key") {
    if (
      node.protocol === "gemini" ||
      node.base_url.toLowerCase().includes("generativelanguage.googleapis.com")
    )
      headers["x-goog-api-key"] = key;
    else {
      headers["x-api-key"] = key;
      headers["anthropic-version"] = "2023-06-01";
    }
  } else headers.Authorization = `Bearer ${key}`;
  return Object.assign(headers, custom);
}

/** A single deadline includes headers AND body; cancellation/shutdown also interrupts custom streams. */
export async function fetchMediaControl(
  url: string,
  init: RequestInit,
  controllers: Set<AbortController>,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  controllers.add(controller);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref();
  const cleanup = () => {
    clearTimeout(timer);
    controllers.delete(controller);
  };
  const aborted = () =>
    new PricingRepositoryError(
      "pricing_media_control_aborted",
      "Media control request timed out or was stopped",
      504,
    );
  const bounded = <T>(work: Promise<T>): Promise<T> =>
    new Promise((resolve, reject) => {
      const stop = () => reject(aborted());
      if (controller.signal.aborted) {
        void work.catch(() => undefined);
        reject(aborted());
        return;
      }
      controller.signal.addEventListener("abort", stop, { once: true });
      work
        .then(resolve, reject)
        .finally(() => controller.signal.removeEventListener("abort", stop));
    });
  try {
    const response = await bounded(
      fetch(url, { ...init, signal: controller.signal, redirect: "error" }),
    );
    if (!response.body) {
      cleanup();
      return response;
    }
    const reader = response.body.getReader();
    let finished = false;
    let detach = () => {};
    const finish = () => {
      finished = true;
      detach();
      cleanup();
    };
    const body = new ReadableStream<Uint8Array>({
      start(sink) {
        const stop = () => {
          if (finished) return;
          finish();
          void reader.cancel().catch(() => undefined);
          sink.error(aborted());
        };
        detach = () => controller.signal.removeEventListener("abort", stop);
        controller.signal.addEventListener("abort", stop, { once: true });
        if (controller.signal.aborted) stop();
      },
      async pull(sink) {
        try {
          const chunk = await bounded(reader.read());
          if (finished) return;
          if (chunk.done) {
            finish();
            reader.releaseLock();
            sink.close();
          } else sink.enqueue(chunk.value);
        } catch (error) {
          if (finished) return;
          finish();
          controller.abort();
          void reader.cancel().catch(() => undefined);
          sink.error(error);
        }
      },
      cancel() {
        finish();
        controller.abort();
        void reader.cancel().catch(() => undefined);
      },
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch (error) {
    controller.abort();
    cleanup();
    throw error;
  }
}

/** No raw provider error text or unbounded body is retained. */
export async function readMediaControlMetadata(
  response: Response,
): Promise<Record<string, unknown>> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new PricingRepositoryError(
      "pricing_media_control_failed",
      "Provider media control request failed",
      502,
    );
  }
  const reader = response.body?.getReader();
  if (!reader) return {};
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 131072)
        throw new PricingRepositoryError(
          "pricing_media_control_too_large",
          "Provider task response exceeded the metadata limit",
          502,
        );
      chunks.push(part.value);
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (size === 0) return {}; // HTTP 204 is an acknowledgement, not terminal evidence.
  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new PricingRepositoryError(
      "pricing_media_control_invalid",
      "Provider task response is not JSON",
      502,
    );
  }
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new PricingRepositoryError(
      "pricing_media_control_invalid",
      "Provider task metadata must be an object",
      502,
    );
  return body as Record<string, unknown>;
}

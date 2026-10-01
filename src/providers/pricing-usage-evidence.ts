import { redactErrorText } from "../security/error-redaction";
import { ExactDecimal } from "../pricing/exact-decimal";
import { isNativeGeminiUsageSchema, normalizeGeminiPricingUsage } from "./gemini-pricing-usage";
import { attachUsageEvidence } from "../canonical/usage-evidence";
import type { TokenUsage } from "../canonical/canonical.types";
import { normalizeCanonicalTokenUsage, normalizeTokenModalityUsage } from "../pricing/usage-normalizer";
import {
  CACHE_CREATION_TOKEN_PATHS,
  CACHE_READ_TOKEN_PATHS,
  INPUT_TOKEN_PATHS,
  OUTPUT_TOKEN_PATHS,
  TOTAL_TOKEN_PATHS,
  type UsageSchema,
  type UsageSchemaPath,
} from "./usage-schema-resolver";

interface RawCounter {
  value: unknown;
  path?: string;
}

function pathValue(root: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (value, key) =>
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        Object.prototype.hasOwnProperty.call(value, key)
          ? (value as Record<string, unknown>)[key]
          : undefined,
      root,
    );
}

function first(root: unknown, paths?: UsageSchemaPath): RawCounter {
  for (const path of paths === undefined
    ? []
    : Array.isArray(paths)
      ? paths
      : [paths]) {
    const value = pathValue(root, path);
    // An explicitly malformed field cannot be replaced by a later, cheaper fallback.
    if (value !== undefined) return { value, path };
  }
  return { value: undefined };
}

function exactCount(value: unknown): ExactDecimal {
  if (typeof value !== "string" && typeof value !== "number")
    throw new Error("Missing counter");
  if (typeof value === "number" && !Number.isSafeInteger(value))
    throw new Error("Unsafe counter");
  const count = ExactDecimal.parse(String(value));
  if (count.compare(ExactDecimal.zero) < 0 || !count.isInteger())
    throw new Error("Invalid counter");
  return count;
}

function sumParts(body: unknown, paths?: string[]): RawCounter {
  if (!paths?.length) return { value: undefined };
  const values = paths.map((path) => ({ value: pathValue(body, path), path }));
  // Partial custom sums are unknown; absent parts are not documented zeroes.
  if (values.some((counter) => counter.value === undefined))
    return { value: undefined };
  let sum = ExactDecimal.zero;
  for (const counter of values) {
    try {
      sum = sum.add(exactCount(counter.value));
    } catch {
      return counter;
    }
  }
  return { value: sum.toFixed(0), path: paths.join("+") };
}

function resolve(
  body: unknown,
  direct: UsageSchemaPath | undefined,
  parts: string[] | undefined,
  fallback: string[],
): RawCounter {
  const explicit = first(body, direct);
  if (explicit.value !== undefined) return explicit;
  if (parts?.length) return sumParts(body, parts);
  return first(body, fallback);
}

/** Raw evidence stays exact even though the compatibility response uses numeric TokenUsage. */
export function attachTokenPricingEvidence(
  body: Record<string, unknown>,
  canonical: TokenUsage,
  schema?: UsageSchema,
  operation = "chat",
): void {
  const chatOperation = ["chat", "chat_completions", "responses", "messages"].includes(operation);
  let input = resolve(
    body,
    schema?.input_tokens,
    schema?.input_tokens_parts,
    INPUT_TOKEN_PATHS,
  );
  let output = resolve(
    body,
    schema?.output_tokens,
    schema?.output_tokens_parts,
    OUTPUT_TOKEN_PATHS,
  );
  const read = resolve(
    body,
    schema?.cache_read_input_tokens,
    undefined,
    CACHE_READ_TOKEN_PATHS,
  );
  const write = resolve(
    body,
    schema?.cache_creation_input_tokens,
    undefined,
    CACHE_CREATION_TOKEN_PATHS,
  );
  const total = first(body, schema?.total_tokens ?? TOTAL_TOKEN_PATHS);

  if (chatOperation && pathValue(body, "usageMetadata") !== undefined && isNativeGeminiUsageSchema(schema) &&
      (!input.path || input.path === "usageMetadata.promptTokenCount") &&
      (!output.path || output.path === "usageMetadata.candidatesTokenCount") &&
      (!read.path || read.path === "usageMetadata.cachedContentTokenCount") &&
      (!total.path || total.path === "usageMetadata.totalTokenCount") && write.value === undefined) {
    attachUsageEvidence(canonical, {
      usage: normalizeGeminiPricingUsage(pathValue(body, "usageMetadata")),
      ...(typeof body.modelVersion === "string" ? { resolvedModel: redactErrorText(body.modelVersion, { maxLength: 256 }) } : {}),
    });
    return;
  }

  // A declared schema already specifies its input summands. For the existing
  // known-field adapter only, top-level Anthropic-style input excludes caches.
  const topLevelInput = ["usage.input_tokens", "usage.inputTokens"].includes(
    input.path ?? "",
  );
  const separateCaches = [
    "usage.cache_creation_input_tokens",
    "usage.cacheCreationInputTokens",
    "usage.cache_read_input_tokens",
    "usage.cacheReadInputTokens",
  ].some((path) => pathValue(body, path) !== undefined);
  if (!schema && topLevelInput && separateCaches) {
    try {
      input = {
        value: exactCount(input.value)
          .add(exactCount(read.value ?? 0))
          .add(exactCount(write.value ?? 0))
          .toFixed(0),
        path: input.path,
      };
    } catch {
      /* Preserve malformed raw counters for the normalizer diagnostics. */
    }
  }
  // Missing totals may be reconstructed, but explicit zero or invalid evidence is never replaced.
  if (
    input.value === undefined &&
    total.value !== undefined &&
    output.value !== undefined
  ) {
    try {
      input = {
        value: exactCount(total.value)
          .subtract(exactCount(output.value))
          .toFixed(0),
      };
    } catch {
      /* Unknown. */
    }
  }
  if (
    output.value === undefined &&
    total.value !== undefined &&
    input.value !== undefined
  ) {
    try {
      output = {
        value: exactCount(total.value)
          .subtract(exactCount(input.value))
          .toFixed(0),
      };
    } catch {
      /* Unknown. */
    }
  }

  let normalized = normalizeCanonicalTokenUsage(
    {
      input_tokens: input.value,
      output_tokens: operation === "embeddings" ? 0 : output.value,
      cache_read_input_tokens: read.value === undefined ? 0 : read.value,
      cache_creation_input_tokens: write.value === undefined ? 0 : write.value,
      cache_creation_5m_input_tokens: pathValue(
        body,
        "usage.cache_creation.ephemeral_5m_input_tokens",
      ),
      cache_creation_1h_input_tokens: pathValue(
        body,
        "usage.cache_creation.ephemeral_1h_input_tokens",
      ),
      reasoning_output_tokens:
        pathValue(body, "usage.completion_tokens_details.reasoning_tokens") ??
        pathValue(body, "usage.output_tokens_details.reasoning_tokens"),
    },
    {
      adapter_id: "provider-raw-evidence",
      adapter_version: "3",
      source: "provider_usage",
    },
  );
  // Retain compatibility estimates without claiming undisclosed cache counters were observed.
  for (const dimension of [
    ...(read.value === undefined ? (["cache_read_tokens"] as const) : []),
    ...(write.value === undefined
      ? ([
          "cache_write_tokens",
          "cache_write_5m_tokens",
          "cache_write_1h_tokens",
        ] as const)
      : []),
    ...(read.value === undefined || write.value === undefined
      ? (["uncached_input_tokens"] as const)
      : []),
  ]) {
    const quantity = normalized.quantities[dimension];
    if (quantity?.value !== null && quantity) {
      quantity.quality = "estimated";
      quantity.source = "heuristic";
    }
  }
  if (
    !schema &&
    topLevelInput &&
    separateCaches &&
    (read.value === undefined || write.value === undefined)
  ) {
    const quantity = normalized.quantities.total_input_tokens;
    if (quantity?.value !== null && quantity) {
      quantity.quality = "estimated";
      quantity.source = "heuristic";
    }
  }
  // Chat Completions' documented raw fields apply regardless of the downstream
  // ingress format. Native Responses/Messages/Gemini fields are not aliases for
  // this schema. In particular, no completion image count or text remainder is
  // inferred from audio, reasoning, predictions, content bytes or request shape.
  if (chatOperation) normalized = normalizeTokenModalityUsage(normalized, {
    input: input.path === "usage.prompt_tokens" ? {
      text: pathValue(body, "usage.prompt_tokens_details.text_tokens"),
      audio: pathValue(body, "usage.prompt_tokens_details.audio_tokens"),
      image: pathValue(body, "usage.prompt_tokens_details.image_tokens"),
    } : undefined,
    output: output.path === "usage.completion_tokens" ? {
      text: pathValue(body, "usage.completion_tokens_details.text_tokens"),
      audio: pathValue(body, "usage.completion_tokens_details.audio_tokens"),
    } : undefined,
  });
  const tier =
    typeof body.service_tier === "string" && body.service_tier.length <= 80
      ? body.service_tier
      : undefined;
  attachUsageEvidence(canonical, {
    usage: normalized,
    ...(typeof (body.model ?? body.modelVersion) === "string"
      ? {
          resolvedModel: redactErrorText(
            String(body.model ?? body.modelVersion),
            { maxLength: 256 },
          ),
        }
      : {}),
    resolvedServiceTier: tier,
  });
}

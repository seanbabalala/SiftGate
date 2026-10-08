import type { TokenUsage } from "../canonical/canonical.types";
import {
  attachUsageEvidence,
  getUsageEvidence,
} from "../canonical/usage-evidence";
import {
  normalizeQuantities,
  type QuantityEvidence,
} from "../pricing/usage-normalizer";
import { attachTokenPricingEvidence } from "./pricing-usage-evidence";
import type { UsageSchema } from "./usage-schema-resolver";

/** Extract only explicit usage counters. An HTTP error never proves a free invocation. */
export function providerFailureUsage(
  text: string,
  schema?: UsageSchema,
  operation = "chat",
): TokenUsage | undefined {
  try {
    const body: unknown = JSON.parse(text);
    if (!body || typeof body !== "object" || Array.isArray(body))
      return undefined;
    const raw = body as Record<string, unknown>;
    const usage: TokenUsage = { input_tokens: 0, output_tokens: 0 };
    attachTokenPricingEvidence(
      raw.usage === undefined && raw.meta ? { ...raw, usage: raw.meta } : raw,
      usage,
      schema,
      operation,
    );
    const tokens = getUsageEvidence(usage)!;
    const source =
      raw.usage && typeof raw.usage === "object" && !Array.isArray(raw.usage)
        ? (raw.usage as Record<string, unknown>)
        : {};
    const evidence: QuantityEvidence[] = [];
    const add = (dimension: QuantityEvidence["dimension"], value: unknown) => {
      if (value !== undefined) evidence.push({ dimension, value });
    };
    // An explicit null/invalid primary counter must not be replaced by a
    // convenient fallback field. No request-body quantity proves billed work.
    const first = (...values: unknown[]) => values.find(value => value !== undefined);
    if (operation.startsWith("audio_")) {
      const output = operation === "audio_speech";
      add("request_count", source.request_count);
      if (output) add("text_characters", source.text_characters);
      add(
        output ? "audio_output_seconds" : "audio_input_seconds",
        first(source[output ? "audio_output_seconds" : "audio_input_seconds"], source.seconds),
      );
    } else if (operation === "rerank") {
      const meta =
        raw.meta && typeof raw.meta === "object" && !Array.isArray(raw.meta)
          ? (raw.meta as Record<string, unknown>)
          : {};
      add(
        "rerank_document_count",
        first(source.document_count, source.documents, meta.document_count),
      );
      add("request_count", first(source.request_count, meta.request_count));
      add("rerank_request_count", first(source.rerank_request_count, meta.rerank_request_count));
      const units = first(source.billed_units, meta.billed_units);
      if (units && typeof units === "object" && !Array.isArray(units))
        add(
          "rerank_search_units",
          (units as Record<string, unknown>).search_units,
        );
    }
    const metered = normalizeQuantities(evidence, {
      adapter_id: "provider-failure-evidence",
      adapter_version: "2",
      source: "provider_usage",
    });
    attachUsageEvidence(usage, {
      ...tokens,
      usage: {
        ...tokens.usage,
        quantities: { ...tokens.usage.quantities, ...metered.quantities },
        diagnostics: [...tokens.usage.diagnostics, ...metered.diagnostics],
      },
    });
    return usage;
  } catch {
    return undefined;
  }
}

import { ExactDecimal } from "../pricing/exact-decimal";
import {
  normalizeCanonicalTokenUsage,
  normalizeQuantities,
  normalizeTokenModalityUsage,
  type QuantityEvidence,
} from "../pricing/usage-normalizer";
import type {
  MeterDimension,
  NormalizedUsage,
  PricingDiagnostic,
} from "../pricing/pricing.types";
import type { TokenUsage } from "../canonical/canonical.types";
import type { UsageSchema } from "./usage-schema-resolver";

const ADAPTER = {
  adapter_id: "gemini-generate-content",
  adapter_version: "1",
  source: "provider_usage" as const,
};
const MODALITIES = ["TEXT", "AUDIO", "IMAGE"] as const;
type Modality = (typeof MODALITIES)[number];
type Parts = Partial<Record<Modality, string | null>>;
const own = (root: unknown, key: string): unknown =>
  root &&
  typeof root === "object" &&
  !Array.isArray(root) &&
  Object.hasOwn(root, key)
    ? (root as Record<string, unknown>)[key]
    : undefined;

/** Native GenerateContent accounting cannot override an operator's custom schema. */
export function isNativeGeminiUsageSchema(schema?: UsageSchema): boolean {
  if (!schema) return true;
  const paths: Record<string, string> = {
    input_tokens: "usageMetadata.promptTokenCount",
    output_tokens: "usageMetadata.candidatesTokenCount",
    total_tokens: "usageMetadata.totalTokenCount",
    cache_read_input_tokens: "usageMetadata.cachedContentTokenCount",
  };
  return Object.entries(schema).every(
    ([key, value]) =>
      value === undefined ||
      (paths[key] !== undefined &&
        (Array.isArray(value)
          ? value.length > 0 && value.every((path) => path === paths[key])
          : value === paths[key])),
  );
}

function count(
  value: unknown,
  path: string,
  diagnostics: PricingDiagnostic[],
): string | null {
  if (value === undefined) return null;
  if (
    (typeof value === "number" && Number.isSafeInteger(value)) ||
    typeof value === "string"
  ) {
    try {
      const parsed = ExactDecimal.parse(String(value));
      if (parsed.isInteger() && parsed.compare(ExactDecimal.zero) >= 0)
        return parsed.toFixed(0);
    } catch {
      /* Diagnose without retaining the supplier's arbitrary value. */
    }
  }
  diagnostics.push({
    code: "pricing_invalid_quantity",
    path,
    message: "Expected a nonnegative exact integer token count",
  });
  return null;
}

interface ModalityCounts {
  values: Parts;
  valid: boolean;
  unsupported: boolean;
}
function modalities(
  raw: unknown,
  parent: string | null,
  path: string,
  diagnostics: PricingDiagnostic[],
): ModalityCounts {
  const result: ModalityCounts = {
    values: {},
    valid: true,
    unsupported: false,
  };
  if (raw === undefined || raw === null) return result;
  const start = diagnostics.length;
  if (!Array.isArray(raw) || raw.length > 32) {
    diagnostics.push({
      code: "pricing_invalid_quantity",
      path,
      message: "Expected a bounded modality-count array",
    });
    return { ...result, valid: false };
  }
  let sum = ExactDecimal.zero;
  const seen = new Set<string>();
  for (const entry of raw) {
    const modality = own(entry, "modality");
    const value = count(own(entry, "tokenCount"), path, diagnostics);
    if (
      typeof modality !== "string" ||
      ![...MODALITIES, "VIDEO", "DOCUMENT", "MODALITY_UNSPECIFIED"].includes(
        modality,
      ) ||
      value === null
    ) {
      diagnostics.push({
        code: "pricing_invalid_quantity",
        path,
        message: "A modality entry is incomplete or unrecognized",
      });
      continue;
    }
    if (seen.has(modality)) {
      diagnostics.push({
        code: "pricing_usage_conflict",
        path,
        message: "Duplicate modality entries are not incremental usage",
      });
      continue;
    }
    seen.add(modality);
    sum = sum.add(ExactDecimal.parse(value));
    if ((MODALITIES as readonly string[]).includes(modality))
      result.values[modality as Modality] = value;
    else if (value !== "0") result.unsupported = true;
  }
  if (parent !== null && sum.compare(ExactDecimal.parse(parent)) > 0)
    diagnostics.push({
      code: "pricing_usage_conflict",
      path,
      message: "Reported modality subsets exceed their aggregate",
    });
  // Three explicit supported parts form a complete partition only if no other
  // positive modality is present. Omitted entries remain missing, not zero.
  if (
    parent !== null &&
    !result.unsupported &&
    MODALITIES.every((modality) => result.values[modality] != null) &&
    sum.compare(ExactDecimal.parse(parent)) !== 0
  )
    diagnostics.push({
      code: "pricing_usage_conflict",
      path,
      message: "Complete modality partition does not equal its aggregate",
    });
  result.valid = start === diagnostics.length;
  return result;
}

function geminiTotals(metadata: unknown) {
  const diagnostics: PricingDiagnostic[] = [];
  const readCount = (key: string) =>
    count(own(metadata, key), `usageMetadata.${key}`, diagnostics);
  let input = readCount("promptTokenCount");
  let candidates = readCount("candidatesTokenCount");
  let thoughts = readCount("thoughtsTokenCount");
  const total = readCount("totalTokenCount");
  const cached = readCount("cachedContentTokenCount");
  let invalidTotals = diagnostics.some(
    (diagnostic) => diagnostic.path !== "usageMetadata.cachedContentTokenCount",
  );
  const missing = (key: string) => own(metadata, key) === undefined;
  // The native total includes thoughts. Never reconstruct prompt = total - candidates.
  if (!invalidTotals && total !== null) {
    const remainder = (a: string, b: string) =>
      count(
        ExactDecimal.parse(total)
          .subtract(ExactDecimal.parse(a))
          .subtract(ExactDecimal.parse(b))
          .toFixed(0),
        "usageMetadata.totalTokenCount",
        diagnostics,
      );
    if (
      input === null &&
      missing("promptTokenCount") &&
      candidates !== null &&
      thoughts !== null
    )
      input = remainder(candidates, thoughts);
    if (
      thoughts === null &&
      missing("thoughtsTokenCount") &&
      input !== null &&
      candidates !== null
    )
      thoughts = remainder(input, candidates);
    if (
      candidates === null &&
      missing("candidatesTokenCount") &&
      input !== null &&
      thoughts !== null
    )
      candidates = remainder(input, thoughts);
  }
  invalidTotals ||= diagnostics.some(
    (diagnostic) => diagnostic.path !== "usageMetadata.cachedContentTokenCount",
  );
  let output: string | null = null;
  let estimated = false;
  let conflict = [input, candidates, thoughts].some(
    (value) =>
      value !== null &&
      ExactDecimal.parse(value).compare(ExactDecimal.zero) < 0,
  );
  if (!invalidTotals && !conflict) {
    if (candidates !== null && thoughts !== null)
      output = count(
        ExactDecimal.parse(candidates)
          .add(ExactDecimal.parse(thoughts))
          .toFixed(0),
        "usage.output_tokens",
        diagnostics,
      );
    else if (input !== null && total !== null)
      output = count(
        ExactDecimal.parse(total)
          .subtract(ExactDecimal.parse(input))
          .toFixed(0),
        "usage.output_tokens",
        diagnostics,
      );
    else if (
      candidates !== null &&
      missing("thoughtsTokenCount") &&
      missing("totalTokenCount")
    ) {
      output = candidates;
      estimated = true;
    }
    if (
      output !== null &&
      ExactDecimal.parse(output).compare(ExactDecimal.zero) < 0
    )
      conflict = true;
    if (
      input !== null &&
      output !== null &&
      total !== null &&
      ExactDecimal.parse(input)
        .add(ExactDecimal.parse(output))
        .compare(ExactDecimal.parse(total)) !== 0
    )
      conflict = true;
  }
  if (conflict) {
    diagnostics.push({
      code: "pricing_usage_conflict",
      path: "usageMetadata.totalTokenCount",
      message: "Gemini total must equal prompt plus candidates plus thoughts",
    });
    input = output = candidates = thoughts = null;
  }
  if (invalidTotals) output = null;
  return {
    input,
    output,
    candidates,
    thoughts,
    cached,
    estimated,
    diagnostics,
  };
}

/** Numeric compatibility fields, not the exact private billing evidence. */
export function geminiCompatibilityUsage(metadata: unknown): TokenUsage {
  const { input, output, cached } = geminiTotals(metadata);
  const safe = (value: string | null) =>
    value !== null &&
    ExactDecimal.parse(value).compare(
      ExactDecimal.parse(String(Number.MAX_SAFE_INTEGER)),
    ) <= 0
      ? Number(value)
      : 0;
  return {
    input_tokens: safe(input),
    output_tokens: safe(output),
    cache_read_input_tokens: safe(cached),
  };
}

/** Exact GenerateContent-only usage; Interactions, Vertex prediction and Live differ. */
export function normalizeGeminiPricingUsage(
  metadata: unknown,
): NormalizedUsage {
  const {
    input,
    output,
    candidates,
    thoughts,
    cached,
    estimated,
    diagnostics,
  } = geminiTotals(metadata);
  let usage = normalizeCanonicalTokenUsage(
    {
      input_tokens: input,
      output_tokens: output,
      cache_read_input_tokens: cached,
      // GenerateContent input is prompt minus cached content. Cache resource
      // creation/storage belongs to a separate API, not a generation write count.
      cache_creation_input_tokens: "0",
      reasoning_output_tokens: thoughts,
    },
    ADAPTER,
  );
  if (
    estimated &&
    usage.quantities.output_tokens?.value !== null &&
    usage.quantities.output_tokens
  ) {
    usage.quantities.output_tokens.quality = "estimated";
    usage.quantities.output_tokens.source = "heuristic";
  }
  const prompt = modalities(
    own(metadata, "promptTokensDetails"),
    input,
    "usageMetadata.promptTokensDetails",
    diagnostics,
  );
  const cache = modalities(
    own(metadata, "cacheTokensDetails"),
    cached,
    "usageMetadata.cacheTokensDetails",
    diagnostics,
  );
  const generated = modalities(
    own(metadata, "candidatesTokensDetails"),
    candidates,
    "usageMetadata.candidatesTokensDetails",
    diagnostics,
  );
  const map = (parts: ModalityCounts) => ({
    text: parts.values.TEXT,
    audio: parts.values.AUDIO,
    image: parts.values.IMAGE,
  });
  const inputSupported =
    prompt.valid && cache.valid && !prompt.unsupported && !cache.unsupported;
  const outputSupported = generated.valid && !generated.unsupported;
  usage = normalizeTokenModalityUsage(usage, {
    input: inputSupported ? map(prompt) : undefined,
    cached_input: inputSupported ? map(cache) : undefined,
    output: outputSupported
      ? {
          ...map(generated),
          // Candidate details exclude internal thoughts; do not label their text
          // subset a complete text-output basis without known-zero thinking.
          text:
            thoughts === "0"
              ? generated.values.TEXT
              : generated.values.TEXT === undefined
                ? undefined
                : null,
        }
      : undefined,
  });
  const unavailable: QuantityEvidence[] = [];
  for (const [prefix, supported, parts] of [
    ["input", inputSupported, prompt],
    ["output", outputSupported, generated],
  ] as const) {
    if (supported) continue;
    for (const modality of MODALITIES) {
      if (parts.values[modality] === undefined) continue;
      unavailable.push({
        dimension: (prefix === "input"
          ? `uncached_${modality.toLowerCase()}_input_tokens`
          : `${modality.toLowerCase()}_output_tokens`) as MeterDimension,
        value: null,
        quality: parts.valid && parts.unsupported ? "unsupported" : "missing",
      });
    }
  }
  Object.assign(
    usage.quantities,
    normalizeQuantities(unavailable, ADAPTER).quantities,
  );
  usage.diagnostics.push(...diagnostics);
  return usage;
}

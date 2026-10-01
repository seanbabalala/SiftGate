import { ExactDecimal } from "./exact-decimal";
import {
  DIMENSION_UNITS,
  EvidenceQuality,
  EvidenceSource,
  MeterDimension,
  MeterQuantity,
  NormalizedUsage,
  PricingDiagnostic,
} from "./pricing.types";

export interface QuantityEvidence {
  dimension: MeterDimension;
  value: unknown;
  source?: EvidenceSource;
  quality?: EvidenceQuality;
}

export interface UsageAdapterIdentity {
  adapter_id: string;
  adapter_version: string;
  source: EvidenceSource;
  quality?: "observed" | "estimated";
}

const INPUT_PARTS: MeterDimension[] = [
  "uncached_input_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "cache_write_5m_tokens",
  "cache_write_1h_tokens",
];
const INPUT_MODALITIES: MeterDimension[] = [
  "uncached_text_input_tokens",
  "uncached_audio_input_tokens",
  "uncached_image_input_tokens",
];
const OUTPUT_MODALITIES: MeterDimension[] = [
  "text_output_tokens",
  "audio_output_tokens",
  "image_output_tokens",
];

function parseQuantity(value: unknown, dimension: MeterDimension): string {
  const unit = DIMENSION_UNITS[dimension];
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
      throw new Error(
        "Numeric quantity must be finite and within the safe integer range; use a decimal string",
      );
    }
    value = String(value);
  }
  if (typeof value !== "string")
    throw new Error("Quantity must be a decimal string or safe number");
  const parsed = ExactDecimal.parse(value);
  if (parsed.compare(ExactDecimal.zero) < 0)
    throw new Error("Quantity must not be negative");
  if (unit !== "second" && !parsed.isInteger())
    throw new Error("Token and count quantities must be integral");
  return parsed
    .toFixed(unit === "second" ? 18 : 0)
    .replace(/(\.\d*?)0+$/, "$1")
    .replace(/\.$/, "");
}

function subsetOf(dimension: MeterDimension): MeterDimension | undefined {
  if (INPUT_PARTS.includes(dimension)) return "total_input_tokens";
  if (INPUT_MODALITIES.includes(dimension)) return "uncached_input_tokens";
  if (
    OUTPUT_MODALITIES.includes(dimension) ||
    dimension === "reasoning_output_tokens"
  )
    return "output_tokens";
  return undefined;
}

export function normalizeQuantities(
  evidence: QuantityEvidence[],
  adapter: UsageAdapterIdentity,
): NormalizedUsage {
  const quantities: NormalizedUsage["quantities"] = {};
  const diagnostics: PricingDiagnostic[] = [];
  for (const item of evidence) {
    const path = `usage.${item.dimension}`;
    if (
      !Object.prototype.hasOwnProperty.call(DIMENSION_UNITS, item.dimension)
    ) {
      diagnostics.push({
        code: "pricing_invalid_quantity",
        path,
        message: "Unknown metering dimension",
      });
      continue;
    }
    if (quantities[item.dimension]) {
      diagnostics.push({
        code: "pricing_usage_conflict",
        path,
        message: "Duplicate metering dimension",
      });
      quantities[item.dimension] = {
        ...quantities[item.dimension]!,
        value: null,
        quality: "missing",
      };
      continue;
    }
    const quantity: MeterQuantity = {
      dimension: item.dimension,
      unit: DIMENSION_UNITS[item.dimension],
      value: null,
      source: item.source ?? adapter.source,
      quality: item.quality ?? adapter.quality ?? "observed",
      subset_of: subsetOf(item.dimension),
    };
    if (
      quantity.quality === "missing" ||
      quantity.quality === "unsupported" ||
      item.value === undefined ||
      item.value === null
    ) {
      if (quantity.quality !== "unsupported") quantity.quality = "missing";
    } else {
      try {
        quantity.value = parseQuantity(item.value, item.dimension);
      } catch (error) {
        quantity.quality = "missing";
        diagnostics.push({
          code: "pricing_invalid_quantity",
          path,
          message: (error as Error).message,
        });
      }
    }
    quantities[item.dimension] = quantity;
  }

  const result: NormalizedUsage = {
    schema_version: 1,
    adapter_id: adapter.adapter_id,
    adapter_version: adapter.adapter_version,
    quantities,
    diagnostics,
  };
  validatePartition(result, "total_input_tokens", INPUT_PARTS);
  validatePartition(result, "uncached_input_tokens", INPUT_MODALITIES);
  validatePartition(result, "output_tokens", OUTPUT_MODALITIES);
  validatePartition(
    result,
    "output_tokens",
    ["reasoning_output_tokens"],
    false,
  );
  return result;
}

function validatePartition(
  usage: NormalizedUsage,
  parent: MeterDimension,
  parts: MeterDimension[],
  exhaustive = true,
): void {
  const parentValue = usage.quantities[parent]?.value;
  if (parentValue == null) return;
  let sum = ExactDecimal.zero;
  for (const part of parts) {
    const value = usage.quantities[part]?.value;
    if (value != null) sum = sum.add(ExactDecimal.parse(value));
  }
  const comparison = sum.compare(ExactDecimal.parse(parentValue));
  const allKnown = parts.every((part) => usage.quantities[part]?.value != null);
  if (comparison <= 0 && !(exhaustive && allKnown && comparison !== 0)) return;
  usage.diagnostics.push({
    code: "pricing_usage_conflict",
    path: `usage.${parent}`,
    message:
      comparison > 0
        ? `Known subsets (${parts.join(", ")}) exceed their parent total`
        : `Complete partition (${parts.join(", ")}) does not equal its parent total`,
  });
  for (const dimension of [parent, ...parts]) {
    const quantity = usage.quantities[dimension];
    if (quantity)
      usage.quantities[dimension] = {
        ...quantity,
        value: null,
        quality: "missing",
      };
  }
}

export interface CanonicalTokenEvidence {
  input_tokens?: unknown;
  output_tokens?: unknown;
  cache_read_input_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
  cache_creation_5m_input_tokens?: unknown;
  cache_creation_1h_input_tokens?: unknown;
  reasoning_output_tokens?: unknown;
}

export interface TokenModalityEvidence {
  /** Provider prompt counts include caches; these are NOT uncached counts. */
  input?: Partial<Record<"text" | "audio" | "image", unknown>>;
  /** Optional provider-reported cache-read subsets, in the same prompt modalities. */
  cached_input?: Partial<Record<"text" | "audio" | "image", unknown>>;
  output?: Partial<Record<"text" | "audio" | "image", unknown>>;
}

/** Preserve reported subsets without inventing the missing remainder or cache allocation. */
export function normalizeTokenModalityUsage(
  usage: NormalizedUsage,
  evidence: TokenModalityEvidence,
): NormalizedUsage {
  const input: QuantityEvidence[] = [];
  const output: QuantityEvidence[] = [];
  for (const modality of ["text", "audio", "image"] as const) {
    if (evidence.input?.[modality] !== undefined)
      input.push({
        dimension: `uncached_${modality}_input_tokens`,
        value: evidence.input[modality],
      });
    if (evidence.output?.[modality] !== undefined)
      output.push({
        dimension: `${modality}_output_tokens`,
        value: evidence.output[modality],
      });
  }
  if (!input.length && !output.length) return usage;
  const adapter: UsageAdapterIdentity = {
    adapter_id: usage.adapter_id,
    adapter_version: usage.adapter_version,
    source: "provider_usage",
  };
  // Validate the provider's prompt breakdown against the cache-INCLUSIVE parent
  // before attribution. The temporary parent is never copied into final evidence.
  const promptParts = normalizeQuantities(
    [
      ...input,
      {
        dimension: "uncached_input_tokens",
        value: usage.quantities.total_input_tokens?.value,
      },
    ],
    adapter,
  );
  const cachedParts = normalizeQuantities(
    [
      ...(["text", "audio", "image"] as const)
        .filter(modality => evidence.cached_input?.[modality] !== undefined)
        .map((modality): QuantityEvidence => ({ dimension: `uncached_${modality}_input_tokens`, value: evidence.cached_input![modality] })),
      { dimension: "uncached_input_tokens", value: usage.quantities.cache_read_tokens?.value },
    ], adapter,
  );
  const writesObservedZero = (
    ["cache_write_tokens", "cache_write_5m_tokens", "cache_write_1h_tokens"] as const
  ).every((dimension) => {
    const counter = usage.quantities[dimension];
    return counter?.value === "0" && counter.quality === "observed";
  });
  const read = usage.quantities.cache_read_tokens;
  const cachedSum = INPUT_MODALITIES.reduce((sum, dimension) => sum.add(ExactDecimal.parse(cachedParts.quantities[dimension]?.value ?? "0")), ExactDecimal.zero);
  const cacheFullyAllocated = read?.value != null && read.quality === "observed" && cachedParts.diagnostics.length === 0 && cachedSum.compare(ExactDecimal.parse(read.value)) === 0;
  const cacheConflicts: PricingDiagnostic[] = [];
  const additions = input.map(({ dimension }): QuantityEvidence => {
    const counter = promptParts.quantities[dimension]!;
    const cached = cachedParts.quantities[dimension]?.value ?? (cacheFullyAllocated ? "0" : null);
    let value: string | null = counter.value === "0" ? "0" : null;
    if (counter.value !== null && cached !== null && read?.quality === "observed" && read.value !== null && writesObservedZero && cachedParts.diagnostics.length === 0) {
      const remainder = ExactDecimal.parse(counter.value).subtract(ExactDecimal.parse(cached));
      if (remainder.compare(ExactDecimal.zero) >= 0) value = remainder.toFixed(0);
      else cacheConflicts.push({ code: "pricing_usage_conflict", path: `usage.${dimension}`, message: "Cached modality tokens exceed the corresponding prompt modality" });
    }
    return {
      dimension,
      value,
      quality: counter.quality,
    };
  });
  if (cacheConflicts.length || cachedParts.diagnostics.length)
    for (const addition of additions) addition.value = null;
  const result = normalizeQuantities(
    [
      ...Object.values(usage.quantities).filter((quantity): quantity is MeterQuantity => !!quantity),
      ...additions,
      ...output,
    ],
    adapter,
  );
  result.diagnostics.push(
    ...usage.diagnostics,
    ...cacheConflicts,
    ...cachedParts.diagnostics.map(diagnostic => ({ ...diagnostic, path: "usage.cache_read_tokens" })),
    ...promptParts.diagnostics.map((diagnostic) => ({
      ...diagnostic,
      path: diagnostic.path === "usage.uncached_input_tokens"
        ? "usage.total_input_tokens"
        : diagnostic.path,
    })),
  );
  return result;
}

/** The input total must already include cache counters, as in canonical TokenUsage. */
export function normalizeCanonicalTokenUsage(
  tokens: CanonicalTokenEvidence,
  adapter: UsageAdapterIdentity,
  options: { absent_cache_is_zero?: boolean } = {},
): NormalizedUsage {
  const missingCache = options.absent_cache_is_zero ? "0" : undefined;
  const raw: QuantityEvidence[] = [
    { dimension: "total_input_tokens", value: tokens.input_tokens },
    { dimension: "output_tokens", value: tokens.output_tokens },
    {
      dimension: "cache_read_tokens",
      value: tokens.cache_read_input_tokens ?? missingCache,
    },
    {
      dimension: "cache_write_tokens",
      value: tokens.cache_creation_input_tokens ?? missingCache,
    },
    {
      dimension: "cache_write_5m_tokens",
      value: tokens.cache_creation_5m_input_tokens ?? "0",
    },
    {
      dimension: "cache_write_1h_tokens",
      value: tokens.cache_creation_1h_input_tokens ?? "0",
    },
  ];
  if (tokens.reasoning_output_tokens !== undefined) {
    raw.push({
      dimension: "reasoning_output_tokens",
      value: tokens.reasoning_output_tokens,
    });
  }
  // Cache write evidence here is a total; decompose it before validating partitions.
  const parsed: NormalizedUsage = normalizeQuantities(
    raw.filter((entry) => entry.dimension !== "total_input_tokens"),
    adapter,
  );
  const total = normalizeQuantities([raw[0]], adapter);
  Object.assign(parsed.quantities, total.quantities);
  parsed.diagnostics.push(...total.diagnostics);
  const read = parsed.quantities.cache_read_tokens;
  const write = parsed.quantities.cache_write_tokens;
  const write5m = parsed.quantities.cache_write_5m_tokens;
  const write1h = parsed.quantities.cache_write_1h_tokens;
  const input = parsed.quantities.total_input_tokens;
  let originalWrite =
    write?.value != null ? ExactDecimal.parse(write.value) : null;
  if (
    write?.value != null &&
    originalWrite !== null &&
    write5m?.value != null &&
    write1h?.value != null
  ) {
    const remainder = originalWrite
      .subtract(ExactDecimal.parse(write5m.value))
      .subtract(ExactDecimal.parse(write1h.value));
    if (remainder.compare(ExactDecimal.zero) < 0) {
      parsed.diagnostics.push({
        code: "pricing_usage_conflict",
        path: "usage.cache_write_tokens",
        message: "TTL-specific cache writes exceed the total cache writes",
      });
      for (const dimension of [
        "cache_write_tokens",
        "cache_write_5m_tokens",
        "cache_write_1h_tokens",
      ] as const) {
        parsed.quantities[dimension] = {
          ...parsed.quantities[dimension]!,
          value: null,
          quality: "missing",
        };
      }
      originalWrite = null;
    } else {
      write.value = remainder.toFixed(0);
    }
  } else if (write) {
    // The aggregate cannot masquerade as an unknown-TTL remainder when a part is invalid.
    write.value = null;
    write.quality = "missing";
  }
  let uncached: string | null = null;
  if (input?.value != null && read?.value != null && originalWrite !== null) {
    const remaining = ExactDecimal.parse(input.value)
      .subtract(ExactDecimal.parse(read.value))
      .subtract(originalWrite);
    if (remaining.compare(ExactDecimal.zero) >= 0)
      uncached = remaining.toFixed(0);
    else
      parsed.diagnostics.push({
        code: "pricing_usage_conflict",
        path: "usage.total_input_tokens",
        message: "Cache reads and writes exceed total input tokens",
      });
  }
  parsed.quantities.uncached_input_tokens = {
    dimension: "uncached_input_tokens",
    unit: "token",
    value: uncached,
    source: adapter.source,
    quality: uncached === null ? "missing" : (adapter.quality ?? "observed"),
    subset_of: "total_input_tokens",
  };
  validatePartition(parsed, "total_input_tokens", INPUT_PARTS);
  return parsed;
}

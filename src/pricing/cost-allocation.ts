import {
  allocateExact,
  weightedFraction,
  type AllocationWeight,
} from "./exact-allocation";
import { ExactDecimal } from "./exact-decimal";
import { pricingContentHash } from "./pricing-json";
import { normalizeQuantities } from "./usage-normalizer";
import {
  DIMENSION_UNITS,
  type CostComputation,
  type MeterDimension,
  type NormalizedUsage,
} from "./pricing.types";
import type {
  BatchCostAllocation,
  EmbeddingBatchMember,
} from "./pricing-batch.types";

const partitions: Array<{ parent: MeterDimension; parts: MeterDimension[] }> = [
  {
    parent: "total_input_tokens",
    parts: [
      "uncached_input_tokens",
      "cache_read_tokens",
      "cache_write_tokens",
      "cache_write_5m_tokens",
      "cache_write_1h_tokens",
    ],
  },
  {
    parent: "uncached_input_tokens",
    parts: [
      "uncached_text_input_tokens",
      "uncached_audio_input_tokens",
      "uncached_image_input_tokens",
    ],
  },
  {
    parent: "output_tokens",
    parts: ["text_output_tokens", "audio_output_tokens", "image_output_tokens"],
  },
  // Reasoning overlaps output: it is not another disjoint output modality.
  { parent: "output_tokens", parts: ["reasoning_output_tokens"] },
];

export function allocateBatchUsage(
  physical: NormalizedUsage,
  weights: readonly AllocationWeight[],
): NormalizedUsage[] {
  allocateExact("0", weights);
  const values: Partial<Record<MeterDimension, string[]>> = {};
  const split = (dimension: MeterDimension, capacities?: string[]) => {
    const source = physical.quantities[dimension];
    if (source?.value == null) return undefined;
    const result = allocateExact(
      source.value,
      weights,
      source.unit === "second" ? 18 : 0,
      capacities,
    );
    values[dimension] = result;
    return result;
  };
  for (const dimension of Object.keys(
    physical.quantities,
  ) as MeterDimension[]) {
    const source = physical.quantities[dimension]!;
    if (source.unit !== DIMENSION_UNITS[dimension])
      throw new Error("Invalid physical usage unit");
    if (!source.subset_of) split(dimension);
  }
  for (const { parent, parts } of partitions) {
    const remaining = values[parent]?.map((value) => ExactDecimal.parse(value));
    for (const part of parts) {
      const allocated = split(
        part,
        remaining?.map((value) => value.toFixed(0)),
      );
      if (remaining && allocated)
        for (let i = 0; i < remaining.length; i++)
          remaining[i] = remaining[i].subtract(
            ExactDecimal.parse(allocated[i]),
          );
    }
  }
  return weights.map((_, index) => {
    const usage = normalizeQuantities(
      (Object.keys(physical.quantities) as MeterDimension[]).map(
        (dimension) => {
          const original = physical.quantities[dimension]!;
          return {
            dimension,
            value: values[dimension]?.[index] ?? null,
            source:
              original.value === "0" || weights.length === 1
                ? original.source
                : "heuristic",
            quality:
              original.value == null
                ? original.quality
                : original.value === "0" || weights.length === 1
                  ? original.quality
                  : "estimated",
          };
        },
      ),
      {
        adapter_id: "batch-allocation",
        adapter_version: "1",
        source: "heuristic",
      },
    );
    return {
      ...usage,
      diagnostics: [...physical.diagnostics, ...usage.diagnostics],
    };
  });
}

/** Price the physical invocation ONCE before calling this, including its context tier, base fee and FX. */
export function allocateBatchCost(
  batchId: string,
  physical: CostComputation,
  input: readonly EmbeddingBatchMember[],
): BatchCostAllocation {
  if (physical.batch)
    throw new Error("Cannot allocate an already allocated receipt");
  if (
    !batchId ||
    batchId.length > 160 ||
    !input.length ||
    input.length > 1024 ||
    physical.lines.length > 4096 ||
    physical.lines.length * input.length > 65536
  )
    throw new Error("Invalid batch allocation size");
  const members = structuredClone([...input]).sort(
    (a, b) => a.input_start - b.input_start,
  );
  const reservations = new Set<string>();
  let next = 0;
  for (const member of members) {
    if (
      !member.reservation_id ||
      member.reservation_id.length > 160 ||
      reservations.has(member.reservation_id) ||
      !Number.isSafeInteger(member.input_start) ||
      member.input_start !== next ||
      !Number.isSafeInteger(member.input_count) ||
      member.input_count < 1 ||
      !["token_input_count", "text_token_estimate"].includes(
        member.weight_basis,
      )
    )
      throw new Error("Invalid or overlapping batch membership");
    reservations.add(member.reservation_id);
    next += member.input_count;
    if (!Number.isSafeInteger(next))
      throw new Error("Batch input range is too large");
  }
  const weights = members.map((member) => ({
    id: member.request_id,
    weight: member.weight,
  }));
  allocateExact("0", weights); // Validate identities/weights even when every source amount is unknown.
  for (const value of [
    physical.amount,
    physical.known_subtotal,
    physical.report_amount,
    physical.report_known_subtotal,
    ...physical.lines.flatMap((line) => [line.amount, line.report_amount]),
  ])
    if (
      value !== null &&
      ExactDecimal.parse(value).compare(ExactDecimal.zero) < 0
    )
      throw new Error("Negative physical cost");
  const split = (value: string | null) =>
    value === null ? members.map(() => null) : allocateExact(value, weights);
  const totalWeight = weights
    .reduce(
      (sum, entry) => sum.add(ExactDecimal.parse(entry.weight)),
      ExactDecimal.zero,
    )
    .toFixed(0);
  const hash = pricingContentHash(physical);
  const source = split(physical.known_subtotal),
    report = split(physical.report_known_subtotal);
  const amounts = split(physical.amount),
    reportAmounts = split(physical.report_amount);
  const usage = allocateBatchUsage(physical.usage, weights);
  const lines = physical.lines.map((line) => ({
    line,
    amounts: split(line.amount),
    report: split(line.report_amount),
  }));
  // A corrupt snapshot cannot be made plausible by manufacturing a balancing adjustment.
  for (const reporting of [false, true]) {
    const subtotal = reporting
      ? physical.report_known_subtotal
      : physical.known_subtotal;
    const total = reporting ? physical.report_amount : physical.amount;
    const adjustment = reporting
      ? physical.report_rounding_adjustment
      : physical.rounding_adjustment;
    if (
      total !== null &&
      (subtotal === null ||
        ExactDecimal.parse(total).compare(ExactDecimal.parse(subtotal)) !== 0)
    )
      throw new Error("Physical total and known subtotal conflict");
    if (subtotal === null) {
      if (
        physical.lines.some((line) => !reporting || line.report_amount !== null)
      )
        throw new Error("Missing physical subtotal");
      continue;
    }
    if (
      adjustment === null ||
      physical.lines.some((line) => reporting && line.report_amount === null)
    )
      throw new Error("Physical subtotal lacks component evidence");
    const sum = physical.lines.reduce(
      (sum, line) =>
        sum.add(
          ExactDecimal.parse(reporting ? line.report_amount! : line.amount),
        ),
      ExactDecimal.parse(adjustment),
    );
    if (sum.compare(ExactDecimal.parse(subtotal)) !== 0)
      throw new Error("Physical cost does not balance");
  }
  return {
    schema_version: 1,
    algorithm: "proportional_largest_remainder_v1",
    batch_id: batchId,
    physical_cost: structuredClone(physical),
    physical_cost_hash: hash,
    members,
    shares: members.map((member, index) => {
      const allocatedLines = lines.map(({ line, amounts, report }) => ({
        component_id: line.component_id,
        rule_id: line.rule_id,
        dimension: line.dimension,
        currency: line.currency,
        amount: amounts[index]!,
        report_amount: report[index],
        exact_amount: weightedFraction(
          line.exact_amount,
          member.weight,
          totalWeight,
        ),
      }));
      const adjustment = (subtotal: string | null, report: boolean) =>
        subtotal === null
          ? null
          : ExactDecimal.parse(subtotal)
              .subtract(
                allocatedLines.reduce(
                  (sum, line) =>
                    sum.add(
                      ExactDecimal.parse(
                        (report ? line.report_amount : line.amount) ?? "0",
                      ),
                    ),
                  ExactDecimal.zero,
                ),
              )
              .toFixed(18);
      return {
        member,
        physical_cost_hash: hash,
        weight_total: totalWeight,
        status:
          physical.status === "priced" && members.length > 1
            ? "estimated"
            : physical.status,
        usage: usage[index],
        amount: amounts[index],
        known_subtotal: source[index],
        rounding_adjustment: adjustment(source[index], false),
        report_amount: reportAmounts[index],
        report_known_subtotal: report[index],
        report_rounding_adjustment: adjustment(report[index], true),
        lines: allocatedLines,
      };
    }),
  };
}

/** Shared receipt representation: retain physical math; top-level amounts/usage belong to one member. */
export function batchShareCost(
  allocation: BatchCostAllocation,
  index: number,
  physicalAttemptId: string,
): CostComputation {
  const share = allocation.shares[index];
  if (!share || !physicalAttemptId || physicalAttemptId.length > 160)
    throw new Error("Invalid batch share");
  return {
    ...structuredClone(allocation.physical_cost),
    status: share.status,
    evidence_status:
      allocation.physical_cost.evidence_status === "incomplete"
        ? "incomplete"
        : allocation.members.length > 1
          ? "estimated"
          : allocation.physical_cost.evidence_status,
    usage: structuredClone(share.usage),
    amount: share.amount,
    known_subtotal: share.known_subtotal,
    rounding_adjustment: share.rounding_adjustment,
    report_amount: share.report_amount,
    report_known_subtotal: share.report_known_subtotal,
    report_rounding_adjustment: share.report_rounding_adjustment,
    // Lines describe allocated component money; the original billed quantity/formula remains in batch.physical_cost.
    lines: allocation.physical_cost.lines.map((line, i) => ({
      ...line,
      ...share.lines[i],
      quantity: share.usage.quantities[line.dimension]?.value ?? "0",
      billed_quantity: share.usage.quantities[line.dimension]?.value ?? "0",
      evidence_source: "heuristic",
      evidence_quality: "estimated",
    })),
    batch: {
      algorithm: allocation.algorithm,
      batch_id: allocation.batch_id,
      physical_attempt_id: physicalAttemptId,
      weight_total: share.weight_total,
      physical_cost: structuredClone(allocation.physical_cost),
      physical_cost_hash: allocation.physical_cost_hash,
      members: structuredClone(allocation.members),
      member_index: index,
    },
  };
}

/** Validate stored/revised shares by recomputing them. Never accept arbitrary per-member amounts. */
export function validateBatchShare(cost: CostComputation): void {
  const batch = cost.batch;
  if (!batch) return;
  if (
    batch.algorithm !== "proportional_largest_remainder_v1" ||
    batch.physical_cost.batch ||
    pricingContentHash(batch.physical_cost) !== batch.physical_cost_hash
  )
    throw new Error("Invalid physical batch cost");
  const expected = batchShareCost(
    allocateBatchCost(batch.batch_id, batch.physical_cost, batch.members),
    batch.member_index,
    batch.physical_attempt_id,
  );
  if (batch.correction) {
    const correction = batch.correction;
    if (
      Object.keys(correction).some(
        (key) =>
          !["id", "revision", "previous_physical_cost_hash"].includes(key),
      ) ||
      !correction.id ||
      correction.id.length > 160 ||
      !Number.isSafeInteger(correction.revision) ||
      correction.revision < 1 ||
      !/^[a-f0-9]{64}$/.test(correction.previous_physical_cost_hash)
    )
      throw new Error("Invalid batch correction identity");
    expected.batch!.correction = structuredClone(correction);
  }
  const { attribution: _actualAttribution, ...actual } = cost;
  const { attribution: _expectedAttribution, ...canonical } = expected;
  if (pricingContentHash(actual) !== pricingContentHash(canonical))
    throw new Error("Invalid deterministic batch allocation");
}

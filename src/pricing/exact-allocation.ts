import { ExactDecimal } from "./exact-decimal";

export interface AllocationWeight {
  id: string;
  weight: string;
}

/** Monetary and usage apportionment, with deterministic ties and no floating-point arithmetic. */
export function allocateExact(
  value: string,
  weights: readonly AllocationWeight[],
  precision = 18,
  capacities?: readonly string[],
): string[] {
  if (!Number.isInteger(precision) || precision < 0 || precision > 18)
    throw new Error("Invalid allocation precision");
  if (!weights.length || weights.length > 1024)
    throw new Error("Allocation requires 1–1024 participants");
  const ids = new Set<string>();
  const values = weights.map((entry) => {
    if (!entry.id || entry.id.length > 160 || ids.has(entry.id))
      throw new Error("Allocation participant identities must be unique");
    ids.add(entry.id);
    const weight = ExactDecimal.parse(entry.weight);
    if (!weight.isInteger() || weight.compare(ExactDecimal.zero) <= 0)
      throw new Error("Allocation weights must be positive integers");
    return weight.numerator;
  });
  const scale = ExactDecimal.parse(`1${"0".repeat(precision)}`);
  const scaled = ExactDecimal.parse(value).multiply(scale);
  if (!scaled.isInteger())
    throw new Error("Allocation would silently round the source quantity");
  const negative = scaled.numerator < 0n;
  const absolute = negative ? -scaled.numerator : scaled.numerator;
  if (capacities && (negative || capacities.length !== weights.length))
    throw new Error("Invalid allocation capacities");
  const limits = capacities?.map((value) => {
    const quantity = ExactDecimal.parse(value).multiply(scale);
    if (!quantity.isInteger() || quantity.compare(ExactDecimal.zero) < 0)
      throw new Error("Invalid allocation capacity");
    return quantity.numerator;
  });
  if (limits && limits.reduce((sum, value) => sum + value, 0n) < absolute)
    throw new Error("Allocated subsets exceed their parent");
  const result = weights.map(() => 0n);
  let remaining = absolute;
  let active = weights.map((_, index) => index);
  while (active.length) {
    const totalWeight = active.reduce((sum, index) => sum + values[index], 0n);
    const capped = limits
      ? active.filter(
          (index) => remaining * values[index] > limits[index] * totalWeight,
        )
      : [];
    if (capped.length) {
      for (const index of capped) {
        result[index] = limits![index];
        remaining -= result[index];
      }
      const cappedSet = new Set(capped);
      active = active.filter((index) => !cappedSet.has(index));
      continue;
    }
    let remainderUnits = remaining;
    for (const index of active) {
      result[index] = (remaining * values[index]) / totalWeight;
      remainderUnits -= result[index];
    }
    const remainderOrder = [...active].sort((a, b) => {
      const left = (remaining * values[a]) % totalWeight,
        right = (remaining * values[b]) % totalWeight;
      return left === right
        ? weights[a].id < weights[b].id
          ? -1
          : 1
        : left > right
          ? -1
          : 1;
    });
    for (const index of remainderOrder) {
      if (remainderUnits === 0n) break;
      if (!limits || result[index] < limits[index]) {
        result[index]++;
        remainderUnits--;
      }
    }
    if (remainderUnits !== 0n)
      throw new Error("Allocation failed to conserve quantity");
    break;
  }
  const format = (value: bigint) => {
    const sign = negative && value !== 0n ? "-" : "";
    const text = value.toString().padStart(precision + 1, "0");
    return precision === 0
      ? sign + text
      : `${sign}${text.slice(0, -precision)}.${text.slice(-precision)}`;
  };
  return result.map(format);
}

/** Unrounded explanation only; final amounts are allocated from the physical settled amount. */
export function weightedFraction(
  fraction: { numerator: string; denominator: string },
  weight: string,
  totalWeight: string,
) {
  if (
    !/^\d{1,512}$/.test(fraction.numerator) ||
    !/^[1-9]\d{0,511}$/.test(fraction.denominator)
  )
    throw new Error("Invalid exact source amount");
  const parsedWeight = ExactDecimal.parse(weight);
  if (
    !parsedWeight.isInteger() ||
    parsedWeight.compare(ExactDecimal.zero) <= 0 ||
    !/^[1-9]\d{0,33}$/.test(totalWeight)
  )
    throw new Error("Invalid allocation ratio");
  let numerator = BigInt(fraction.numerator) * parsedWeight.numerator,
    denominator = BigInt(fraction.denominator) * BigInt(totalWeight);
  if (denominator <= 0n || parsedWeight.numerator > BigInt(totalWeight))
    throw new Error("Invalid allocation ratio");
  let a = numerator,
    b = denominator;
  while (b) [a, b] = [b, a % b];
  numerator /= a;
  denominator /= a;
  return {
    numerator: numerator.toString(),
    denominator: denominator.toString(),
  };
}

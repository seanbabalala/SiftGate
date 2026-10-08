export type RoundingMode = "half_even" | "half_up" | "ceil" | "floor";

/** Bounded decimal input, exact intermediate arithmetic, explicit output rounding. */
export class ExactDecimal {
  private constructor(
    readonly numerator: bigint,
    readonly denominator: bigint,
  ) {}

  static readonly zero = new ExactDecimal(0n, 1n);
  static readonly one = new ExactDecimal(1n, 1n);

  static parse(value: string): ExactDecimal {
    if (
      typeof value !== "string" ||
      !/^-?\d{1,30}(?:\.\d{1,18})?$/.test(value)
    ) {
      throw new Error(
        "Expected a decimal string with at most 30 integral and 18 fractional digits",
      );
    }
    const negative = value.startsWith("-");
    const [integral, fractional = ""] = (
      negative ? value.slice(1) : value
    ).split(".");
    return this.fraction(
      BigInt(integral + fractional) * (negative ? -1n : 1n),
      10n ** BigInt(fractional.length),
    );
  }

  private static fraction(
    numerator: bigint,
    denominator: bigint,
  ): ExactDecimal {
    if (denominator === 0n) throw new Error("Division by zero");
    if (denominator < 0n) {
      numerator = -numerator;
      denominator = -denominator;
    }
    let a = numerator < 0n ? -numerator : numerator;
    let b = denominator;
    while (b !== 0n) [a, b] = [b, a % b];
    return new ExactDecimal(numerator / a, denominator / a);
  }

  add(other: ExactDecimal): ExactDecimal {
    return ExactDecimal.fraction(
      this.numerator * other.denominator + other.numerator * this.denominator,
      this.denominator * other.denominator,
    );
  }

  subtract(other: ExactDecimal): ExactDecimal {
    return this.add(ExactDecimal.fraction(-other.numerator, other.denominator));
  }

  multiply(other: ExactDecimal): ExactDecimal {
    return ExactDecimal.fraction(
      this.numerator * other.numerator,
      this.denominator * other.denominator,
    );
  }

  divide(other: ExactDecimal): ExactDecimal {
    return ExactDecimal.fraction(
      this.numerator * other.denominator,
      this.denominator * other.numerator,
    );
  }

  compare(other: ExactDecimal): number {
    const difference =
      this.numerator * other.denominator - other.numerator * this.denominator;
    return difference < 0n ? -1 : difference > 0n ? 1 : 0;
  }

  isInteger(): boolean {
    return this.denominator === 1n;
  }

  roundToIncrement(increment: ExactDecimal, mode: RoundingMode): ExactDecimal {
    if (increment.compare(ExactDecimal.zero) <= 0)
      throw new Error("Rounding increment must be positive");
    const units = this.divide(increment).roundInteger(mode);
    return ExactDecimal.fraction(units, 1n).multiply(increment);
  }

  toFixed(precision: number, mode: RoundingMode = "half_even"): string {
    if (!Number.isInteger(precision) || precision < 0 || precision > 18) {
      throw new Error("Decimal precision must be an integer from 0 to 18");
    }
    const scaled = this.multiply(
      ExactDecimal.fraction(10n ** BigInt(precision), 1n),
    ).roundInteger(mode);
    const negative = scaled < 0n;
    const digits = (negative ? -scaled : scaled)
      .toString()
      .padStart(precision + 1, "0");
    const sign = negative ? "-" : "";
    return precision === 0
      ? sign + digits
      : `${sign}${digits.slice(0, -precision)}.${digits.slice(-precision)}`;
  }

  /** Exact fraction for replay; unlike toFixed this never rounds a repeating decimal. */
  toFraction(): { numerator: string; denominator: string } {
    return {
      numerator: this.numerator.toString(),
      denominator: this.denominator.toString(),
    };
  }

  private roundInteger(mode: RoundingMode): bigint {
    const truncated = this.numerator / this.denominator;
    const remainder = this.numerator % this.denominator;
    if (remainder === 0n) return truncated;
    if (mode === "floor") return remainder < 0n ? truncated - 1n : truncated;
    if (mode === "ceil") return remainder > 0n ? truncated + 1n : truncated;
    if (mode !== "half_even" && mode !== "half_up")
      throw new Error("Unsupported rounding mode");
    const sign = remainder < 0n ? -1n : 1n;
    const twice = (remainder < 0n ? -remainder : remainder) * 2n;
    if (twice < this.denominator) return truncated;
    if (
      twice === this.denominator &&
      mode === "half_even" &&
      truncated % 2n === 0n
    )
      return truncated;
    return truncated + sign;
  }
}

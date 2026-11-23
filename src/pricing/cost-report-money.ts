/** Reporting sums may exceed an individual component's 30-digit input bound. No binary-float addition. */
export function sumCostReportMoney(left: string, right: string): string {
  const scaled = (value: string) => {
    if (!/^\d{1,48}(?:\.\d{1,18})?$/.test(value)) throw new Error('Invalid report amount');
    const [whole, fraction = ''] = value.split('.'); return BigInt(whole + fraction.padEnd(18, '0'));
  };
  const value = String(scaled(left) + scaled(right)).padStart(19, '0');
  if (value.length > 66) throw new Error('Report total exceeds the supported range');
  return `${value.slice(0, -18)}.${value.slice(-18)}`;
}

/** Signed difference of recorded report amounts, never a reprice or budget mutation. */
export function subtractCostReportMoney(left: string, right: string): string {
  const scaled = (value: string) => {
    if (!/^\d{1,48}(?:\.\d{1,18})?$/.test(value)) throw new Error('Invalid report amount');
    const [whole, fraction = ''] = value.split('.'); return BigInt(whole + fraction.padEnd(18, '0'));
  };
  const value = scaled(left) - scaled(right), negative = value < 0n;
  const digits = String(negative ? -value : value).padStart(19, '0');
  return `${negative ? '-' : ''}${digits.slice(0, -18)}.${digits.slice(-18)}`;
}
/** Preserve the decimal representation of a legacy float; unrepresentably tiny/large values remain unknown. */
export function legacyReportMoney(value: number): string | null {
  if (!Number.isFinite(value) || value < 0) return null;
  const text = String(value), [coefficient, exponent] = text.toLowerCase().split('e');
  if (exponent === undefined) return reportScale(text);
  const [whole, part = ''] = coefficient.split('.'), digits = whole + part, position = whole.length + Number(exponent);
  if (position > 30 || position < -17) return null;
  const expanded = position <= 0 ? `0.${'0'.repeat(-position)}${digits}` : position >= digits.length ? digits + '0'.repeat(position - digits.length) : `${digits.slice(0, position)}.${digits.slice(position)}`;
  return reportScale(expanded);
}

/**
 * Fit a plain decimal to the 18-digit report scale. Binary floats such as
 * 0.0003978 print as 0.00039779999999999997; round those extra digits half-up
 * instead of discarding the row. A nonzero amount that would round to zero
 * stays unknown, so a tiny cost is never reported as free.
 */
function reportScale(text: string): string | null {
  const match = /^(\d{1,30})(?:\.(\d+))?$/.exec(text);
  if (!match) return null;
  const [, whole, fraction = ''] = match;
  if (fraction.length <= 18) return sumCostReportMoney('0', text);
  const kept = BigInt(whole + fraction.slice(0, 18)) + (fraction.charCodeAt(18) >= 53 ? 1n : 0n);
  if (kept === 0n) return null;
  const digits = String(kept).padStart(19, '0');
  return sumCostReportMoney('0', `${digits.slice(0, -18)}.${digits.slice(-18)}`);
}

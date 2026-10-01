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
  if (exponent === undefined) return /^\d{1,30}(?:\.\d{1,18})?$/.test(text) ? sumCostReportMoney('0', text) : null;
  const [whole, part = ''] = coefficient.split('.'), digits = whole + part, position = whole.length + Number(exponent);
  if (position > 30 || position < -17) return null;
  const expanded = position <= 0 ? `0.${'0'.repeat(-position)}${digits}` : position >= digits.length ? digits + '0'.repeat(position - digits.length) : `${digits.slice(0, position)}.${digits.slice(position)}`;
  return /^\d{1,30}(?:\.\d{1,18})?$/.test(expanded) ? sumCostReportMoney('0', expanded) : null;
}

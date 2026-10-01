/** Strict civil date validation avoids Date.parse silently normalizing invalid dates. */
export function parsePricingDate(value: string): number {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw new Error("Expected a YYYY-MM-DD civil date");
  const date = Date.parse(`${value}T00:00:00.000Z`);
  if (
    !Number.isFinite(date) ||
    new Date(date).toISOString().slice(0, 10) !== value
  )
    throw new Error("Invalid civil date");
  return date;
}

/** Wall-clock strings without an offset are not accepted as pricing instants. */
export function parsePricingInstant(value: string): number {
  const match =
    typeof value === "string" &&
    /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(
      value,
    );
  if (
    !match ||
    Number(match[2]) > 23 ||
    Number(match[3]) > 59 ||
    Number(match[4]) > 59
  )
    throw new Error(
      "Expected an ISO timestamp with an explicit UTC offset and millisecond precision",
    );
  parsePricingDate(match[1]);
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch)) throw new Error("Invalid timestamp offset");
  return epoch;
}

export function shiftPricingDate(date: string, days: number): string {
  return new Date(parsePricingDate(date) + days * 86400000)
    .toISOString()
    .slice(0, 10);
}

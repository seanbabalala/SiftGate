import { parsePricingDate, shiftPricingDate } from './pricing-time';

/** ISO Monday week containing a civil date; never converts a browser/server local instant. */
export function pricingWeekDates(date: string): string[] {
  const epoch = parsePricingDate(date);
  if (date < '1970-01-01' || date > '9998-12-31') throw Error('Unsupported calendar date');
  const monday = shiftPricingDate(date, -((new Date(epoch).getUTCDay() + 6) % 7));
  return Array.from({ length: 7 }, (_, index) => shiftPricingDate(monday, index));
}

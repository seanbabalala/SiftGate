import { performance } from "node:perf_hooks";
import { PublicGatewayError } from "../http/public-error-handling";

export const MAX_PRICING_CLOCK_WAIT_MS = 1000;

/** Wall-clock observation is separate from the monotonic recovery deadline. */
export function readPricingAdmissionTime(): Date {
  return new Date();
}

interface AdmissionClockWait {
  monotonic: () => number;
  sleep: (milliseconds: number) => Promise<void>;
}

/** Per-admission, bounded clock recovery. Call only AFTER releasing database locks. */
export class PricingAdmissionClockWait {
  private readonly deadline: number;

  constructor(private readonly clock: AdmissionClockWait = {
    monotonic: () => performance.now(),
    sleep: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  }) {
    this.deadline = clock.monotonic() + MAX_PRICING_CLOCK_WAIT_MS;
  }

  async wait(milliseconds: number): Promise<void> {
    const remaining = this.deadline - this.clock.monotonic();
    if (!Number.isFinite(milliseconds) || milliseconds <= 0 ||
      milliseconds > MAX_PRICING_CLOCK_WAIT_MS || remaining < milliseconds)
      throw new PublicGatewayError(
        "Pricing admission is temporarily unavailable because the server clock is earlier than the active catalog. Retry after clock synchronization.",
        { statusCode: 503, type: "pricing_error", code: "pricing_clock_skew" },
      );
    await this.clock.sleep(Math.ceil(milliseconds));
  }
}

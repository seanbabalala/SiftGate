import { PricingAdmissionClockWait, MAX_PRICING_CLOCK_WAIT_MS } from "../../src/pricing/pricing-admission-clock";
import { mapPublicGatewayError } from "../../src/http/public-error-handling";

describe("bounded pricing admission clock recovery", () => {
  it("waits only the observed skew and shares one monotonic deadline across repeated rollbacks", async () => {
    let monotonic = 0;
    const sleep = jest.fn(async (ms: number) => { monotonic += ms; });
    const clock = new PricingAdmissionClockWait({ monotonic: () => monotonic, sleep });
    await clock.wait(53);
    await clock.wait(100);
    expect(sleep.mock.calls).toEqual([[53], [100]]);
    monotonic = MAX_PRICING_CLOCK_WAIT_MS - 10;
    await expect(clock.wait(11)).rejects.toMatchObject({ statusCode: 503, code: "pricing_clock_skew" });
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("cannot extend the deadline by repeatedly requesting short waits", async () => {
    let monotonic = 0;
    const clock = new PricingAdmissionClockWait({ monotonic: () => monotonic, sleep: async ms => { monotonic += ms; } });
    await clock.wait(MAX_PRICING_CLOCK_WAIT_MS);
    await expect(clock.wait(1)).rejects.toMatchObject({ code: "pricing_clock_skew" });
  });

  it.each([MAX_PRICING_CLOCK_WAIT_MS + 1, Infinity, NaN, 0, -1])("does not sleep on invalid or excessive skew %s", async milliseconds => {
    const sleep = jest.fn();
    const clock = new PricingAdmissionClockWait({ monotonic: () => 0, sleep });
    await expect(clock.wait(milliseconds)).rejects.toMatchObject({ statusCode: 503, code: "pricing_clock_skew" });
    expect(sleep).not.toHaveBeenCalled();
  });

  it("maps exhausted recovery to a public 503 without exposing catalog data", async () => {
    const clock = new PricingAdmissionClockWait({ monotonic: () => 0, sleep: jest.fn() });
    const error: unknown = await clock.wait(10001).catch(value => value);
    const mapped = mapPublicGatewayError(error, { originalUrl: "/v1/embeddings", url: "/v1/embeddings", headers: {} });
    expect(mapped).toMatchObject({ statusCode: 503, type: "pricing_error", code: "pricing_clock_skew" });
    expect(mapped.message).toContain("clock");
    expect(mapped.details).toEqual({ source_type: "pricing_error" });
  });
});

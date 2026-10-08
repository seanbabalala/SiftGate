import {
  PricingOutcomeRetryBuffer,
  type PricingOutcome,
} from "../../src/pricing/pricing-outcome-retry";
import { PricingRepositoryError } from "../../src/pricing/pricing-repository.types";

const settlement = (
  id = "reservation-a",
  workspace = "workspace-a",
): PricingOutcome => ({
  workspace,
  reservationId: id,
  type: "settlement",
  payload: {
    kind: "commit",
    tokens: "10",
    cost_usd: "0.001",
    budget_basis: "legacy_logical",
    receipt: null,
  },
});
const gate = () => {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { ready, release };
};

describe("bounded pre-durable accounting retries", () => {
  it("releases successful entries and never schedules their writes again", async () => {
    const write = jest.fn(async (_outcome: PricingOutcome) => {});
    const buffer = new PricingOutcomeRetryBuffer(write);
    expect(await buffer.persist(settlement(), 100)).toBe("persisted");
    expect(buffer.status()).toMatchObject({ entries: 0, bytes: 0 });
    expect(await buffer.flush(100000)).toMatchObject({ persisted: 0 });
    expect(write).toHaveBeenCalledTimes(1);
  });
  it("retains immutable metadata across caller and writer mutations and honors backoff", async () => {
    const received: PricingOutcome[] = [];
    const write = jest.fn(async (outcome: PricingOutcome) => {
      received.push(structuredClone(outcome));
      if (outcome.type === "settlement")
        outcome.payload.cost_usd = "writer-mutation";
      if (received.length < 3) throw new Error("synthetic storage failure");
    });
    const buffer = new PricingOutcomeRetryBuffer(write);
    const original = settlement();
    expect(await buffer.persist(original, 100)).toBe("pending");
    if (original.type === "settlement")
      original.payload.cost_usd = "caller-mutation";
    expect(buffer.protects("reservation-a", "workspace-a")).toBe(true);
    expect(buffer.protects("reservation-a", "foreign")).toBe(false);
    await buffer.flush(1099);
    expect(write).toHaveBeenCalledTimes(1);
    await buffer.flush(1100);
    expect(write).toHaveBeenCalledTimes(2);
    await buffer.flush(3099);
    expect(write).toHaveBeenCalledTimes(2);
    await buffer.flush(3100);
    expect(write).toHaveBeenCalledTimes(3);
    expect(
      received.every(
        (entry) =>
          entry.type === "settlement" && entry.payload.cost_usd === "0.001",
      ),
    ).toBe(true);
    expect(buffer.status()).toMatchObject({ entries: 0, bytes: 0 });
  });
  it("coalesces concurrent exact outcomes and overlapping sweeps", async () => {
    const held = gate();
    const write = jest.fn(async (_outcome: PricingOutcome) => {
      await held.ready;
    });
    const buffer = new PricingOutcomeRetryBuffer(write);
    const first = buffer.persist(settlement(), 0),
      duplicate = buffer.persist(settlement(), 0);
    const flush = buffer.flush(1000),
      other = buffer.flush(1000);
    expect(flush).toBe(other);
    held.release();
    await Promise.all([first, duplicate, flush]);
    expect(write).toHaveBeenCalledTimes(1);
    expect(buffer.status().entries).toBe(0);
  });
  it.each([400, 404, 409])(
    "quarantines permanent integrity failures (%s), without retrying or overwriting",
    async (status) => {
      const write = jest.fn(async (_outcome: PricingOutcome) => {
        throw new PricingRepositoryError(
          "synthetic_conflict",
          "synthetic",
          status,
        );
      });
      const buffer = new PricingOutcomeRetryBuffer(write);
      expect(await buffer.persist(settlement(), 0)).toBe("review_required");
      await buffer.flush(100000, 1000, true);
      expect(await buffer.persist(settlement(), 100000)).toBe(
        "review_required",
      );
      expect(write).toHaveBeenCalledTimes(1);
      expect(buffer.protects("reservation-a", "workspace-a")).toBe(false);
    },
  );
  it("does not silently replace a failed terminal decision with a different one", async () => {
    const write = jest.fn(async (_outcome: PricingOutcome) => {
      throw new Error("storage");
    });
    const buffer = new PricingOutcomeRetryBuffer(write);
    await buffer.persist(settlement(), 0);
    const changed = settlement();
    if (changed.type === "settlement") changed.payload.cost_usd = "99";
    expect(await buffer.persist(changed, 1)).toBe("review_required");
    await buffer.flush(10000);
    expect(write).toHaveBeenCalledTimes(1);
    expect(buffer.status()).toMatchObject({
      conflicts: 1,
      review_required: 2,
      entries: 2,
    });
  });
  it("keeps the incoming variant when its earlier in-flight writer succeeds", async () => {
    const held = gate(),
      first = settlement(),
      changed = settlement();
    if (changed.type === "settlement") changed.payload.cost_usd = "99";
    const archived: PricingOutcome[] = [];
    let available = false;
    const write = jest.fn(async () => {
      await held.ready;
    });
    const buffer = new PricingOutcomeRetryBuffer(
      write,
      undefined,
      async (value) => {
        if (!available) throw new Error("archive unavailable");
        archived.push(value);
        return true;
      },
    );
    const pending = buffer.persist(first, 0);
    expect(await buffer.persist(changed, 1)).toBe("review_required");
    held.release();
    await pending;
    expect(buffer.status()).toMatchObject({ entries: 1, review_required: 1 });
    available = true;
    await buffer.flush(60001);
    expect(archived).toEqual([changed]);
    expect(buffer.status()).toMatchObject({
      entries: 0,
      bytes: 0,
      archived: 1,
    });
    expect(write).toHaveBeenCalledTimes(1);
  });
  it("archives both distinct failed outcomes without treating either as a replacement write", async () => {
    const saved: PricingOutcome[] = [],
      first = settlement(),
      next = settlement();
    if (next.type === "settlement") next.payload.tokens = "20";
    const write = jest.fn(async () => {
      throw new Error("storage");
    });
    const buffer = new PricingOutcomeRetryBuffer(
      write,
      undefined,
      async (value) => {
        saved.push(value);
        return true;
      },
    );
    await buffer.persist(first, 0);
    await buffer.persist(next, 1);
    await buffer.flush(10000);
    expect(saved).toEqual([next, first]);
    expect(write).toHaveBeenCalledTimes(1);
    expect(buffer.status()).toMatchObject({
      entries: 0,
      bytes: 0,
      archived: 2,
    });
  });
  it("never evicts a review body on a failed or negative archive acknowledgement", async () => {
    const write = jest.fn(async () => {
      throw new PricingRepositoryError("conflict", "test", 409);
    });
    const archive = jest.fn(async () => false);
    const buffer = new PricingOutcomeRetryBuffer(write, undefined, archive);
    await buffer.persist(settlement(), 0);
    await buffer.flush(100000);
    expect(buffer.status()).toMatchObject({ entries: 1, archived: 0 });
    expect(write).toHaveBeenCalledTimes(1);
    expect(archive).toHaveBeenCalledTimes(2);
  });
  it("uses archival-only overflow for conflicting evidence rather than overwriting an earlier outcome", async () => {
    const write = jest.fn(async () => {
      throw new Error("storage");
    });
    const archive = jest.fn(async () => false),
      buffer = new PricingOutcomeRetryBuffer(
        write,
        { entries: 1, bytes: 10000, entryBytes: 1000 },
        archive,
      );
    await buffer.persist(settlement(), 0);
    const next = settlement();
    if (next.type === "settlement") next.payload.tokens = "20";
    expect(await buffer.persist(next, 1)).toBe("overflow");
    expect(write).toHaveBeenCalledTimes(1);
    expect(buffer.status()).toMatchObject({
      entries: 1,
      overflows: 1,
      review_required: 1,
    });
    archive.mockResolvedValue(true);
    expect(await buffer.persist(next, 2)).toBe("review_required");
    expect(archive).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenCalledTimes(1);
  });
  it("bounds entries/bytes, rejects new admission before dispatch, but tries already-dispatched writes", async () => {
    const write = jest.fn(async (_outcome: PricingOutcome) => {
      throw new Error("storage");
    });
    const buffer = new PricingOutcomeRetryBuffer(write, {
      entries: 1,
      bytes: 1000,
      entryBytes: 500,
    });
    await buffer.persist(settlement(), 0);
    expect(() => buffer.assertAdmissionCapacity()).toThrow(
      expect.objectContaining({
        code: "pricing_recovery_backpressure",
        status: 503,
      }),
    );
    expect(await buffer.persist(settlement("other"), 0)).toBe("overflow");
    expect(write).toHaveBeenCalledTimes(2);
    expect(buffer.status()).toMatchObject({ entries: 1, overflows: 1 });
    write.mockResolvedValue(undefined as never);
    await buffer.flush(1000);
    expect(() => buffer.assertAdmissionCapacity()).not.toThrow();
  });
  it("does not retain oversized outcomes and still accepts a successful direct write", async () => {
    const write = jest.fn(async (_outcome: PricingOutcome) => {});
    const buffer = new PricingOutcomeRetryBuffer(write, {
      entries: 10,
      bytes: 200,
      entryBytes: 1,
    });
    expect(await buffer.persist(settlement(), 0)).toBe("persisted");
    expect(buffer.status()).toMatchObject({ entries: 0, bytes: 0 });
    write.mockRejectedValueOnce(new Error("storage"));
    expect(await buffer.persist(settlement(), 0)).toBe("overflow");
    expect(buffer.status()).toMatchObject({
      entries: 0,
      bytes: 0,
      overflows: 1,
    });
  });
  it("uses workspace in identity and forces one bounded shutdown pass before backoff expires", async () => {
    let fail = true;
    const write = jest.fn(async (_outcome: PricingOutcome) => {
      if (fail) throw new Error("storage");
    });
    const buffer = new PricingOutcomeRetryBuffer(write);
    await buffer.persist(settlement("same", "one"), 0);
    await buffer.persist(settlement("same", "two"), 0);
    fail = false;
    expect(await buffer.flush(1, 1, true)).toMatchObject({ persisted: 1 });
    expect(buffer.status().entries).toBe(1);
    expect(await buffer.flush(1, 1000, true)).toMatchObject({ persisted: 1 });
    expect(buffer.status().entries).toBe(0);
  });
  it("retires an audited superseded decision and frees capacity without writing it again", async () => {
    const write = jest.fn(async (_outcome: PricingOutcome) => {
      throw new PricingRepositoryError("conflict", "synthetic", 409);
    });
    const buffer = new PricingOutcomeRetryBuffer(write, {
      entries: 1,
      bytes: 1000,
      entryBytes: 500,
    });
    await buffer.persist(settlement(), 0);
    expect(await buffer.retireSuperseded(async () => false)).toBe(0);
    expect(buffer.status().entries).toBe(1);
    expect(
      await buffer.retireSuperseded(async () => {
        throw new Error("authority unavailable");
      }),
    ).toBe(0);
    expect(await buffer.retireSuperseded(async () => true)).toBe(1);
    expect(buffer.status()).toMatchObject({ entries: 0, bytes: 0, retired: 1 });
    expect(write).toHaveBeenCalledTimes(1);
    expect(() => buffer.assertAdmissionCapacity()).not.toThrow();
  });
  it("does not retire an entry that starts writing while authority is checked", async () => {
    const held = gate();
    let fail = true;
    const buffer = new PricingOutcomeRetryBuffer(async () => {
      if (fail) throw new Error("temporary");
      await held.ready;
    });
    await buffer.persist(settlement(), 0);
    let checked!: () => void;
    const started = new Promise<void>((resolve) => {
      checked = resolve;
    });
    let release!: () => void;
    const check = new Promise<void>((resolve) => {
      release = resolve;
    });
    const retirement = buffer.retireSuperseded(async () => {
      checked();
      await check;
      return true;
    });
    await started;
    fail = false;
    const writing = buffer.persist(settlement(), 10);
    release();
    expect(await retirement).toBe(0);
    held.release();
    await writing;
    expect(buffer.status()).toMatchObject({ entries: 0, bytes: 0 });
  });
});

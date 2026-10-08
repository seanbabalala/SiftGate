import { PricingRecoveryService } from "../../src/pricing/pricing-recovery.service";
import { CostLedgerService } from "../../src/pricing/cost-ledger.service";
import { PricingRuntimeService } from "../../src/pricing/pricing-runtime.service";

describe("pricing recovery lifecycle", () => {
  const setup = () => {
    const ledger = {
      available: jest.fn(async () => true),
      reconcilePending: jest.fn(async () => ({
        applied: 0,
        pending: 0,
        review_required: 0,
      })),
      reconcileActualBudgets: jest.fn(async () => ({ applied: 0, pending: 0, review_required: 0 })),
      recoverUndispatched: jest.fn(async () => 0),
      reconcileDispatched: jest.fn(async () => ({ opened: 0, updated: 0, unchanged: 0, skipped: 0 })),
    };
    const runtime = { renewActiveLeases: jest.fn(async () => 0), flushPendingOutcomes: jest.fn(async () => ({ persisted: 0, pending: 0, review_required: 0, overflow: 0 })) };
    const worker = new PricingRecoveryService(
      ledger as unknown as CostLedgerService,
      runtime as unknown as PricingRuntimeService,
    );
    return { ledger, runtime, worker };
  };

  it("does nothing without an explicit migration and clears its own timer on shutdown", async () => {
    jest.useFakeTimers();
    const { ledger, runtime, worker } = setup();
    ledger.available.mockResolvedValue(false);
    try {
      await worker.onModuleInit();
      await jest.advanceTimersByTimeAsync(30000);
      expect(ledger.available).toHaveBeenCalledTimes(2);
      expect(runtime.renewActiveLeases).not.toHaveBeenCalled();
      expect(ledger.reconcilePending).not.toHaveBeenCalled();
      expect(ledger.reconcileActualBudgets).not.toHaveBeenCalled();
      await worker.onModuleDestroy();
      await jest.advanceTimersByTimeAsync(30000);
      expect(ledger.available).toHaveBeenCalledTimes(2);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      await worker.onModuleDestroy();
      jest.useRealTimers();
    }
  });

  it("renews leases before sweeping, shares an in-flight run, and waits for it on shutdown", async () => {
    const { ledger, runtime, worker } = setup();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    runtime.renewActiveLeases.mockImplementationOnce(async () => {
      await held;
      return 1;
    });
    const first = worker.runOnce();
    const second = worker.runOnce();
    expect(first).toBe(second);
    await Promise.resolve();
    expect(ledger.reconcilePending).not.toHaveBeenCalled();
    let closed = false;
    const closing = worker.onModuleDestroy().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    release();
    await Promise.all([first, closing]);
    expect(ledger.reconcilePending).toHaveBeenCalledTimes(1);
    expect(ledger.recoverUndispatched).toHaveBeenCalledTimes(1);
    expect(ledger.reconcileActualBudgets).toHaveBeenCalledTimes(1);
    await worker.runOnce();
    expect(ledger.reconcilePending).toHaveBeenCalledTimes(1);
  });

  it("continues orphan recovery after an actual cohort has been quarantined", async () => {
    const { ledger, worker } = setup();
    ledger.reconcileActualBudgets.mockResolvedValue({ applied: 1, pending: 0, review_required: 1 });
    await worker.runOnce();
    expect(ledger.recoverUndispatched).toHaveBeenCalledTimes(1);
    expect(ledger.reconcileDispatched).toHaveBeenCalledTimes(1);
    await worker.onModuleDestroy();
  });
});

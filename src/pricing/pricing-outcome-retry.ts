import { pricingContentHash } from "./pricing-json";
import { PricingRepositoryError } from "./pricing-repository.types";
import type { CostComputation } from "./pricing.types";
import type { CostSettlementPayload } from "./cost-ledger.types";
import type { ActualBudgetClosurePayload } from "./actual-upstream-budget-cohort";

/** Only finalized allowlisted accounting data; never request contexts or retry closures. */
export type PricingOutcome = {
  workspace: string;
  reservationId: string;
} & (
  | {
      type: "attempt";
      attemptId: string;
      cost: CostComputation;
      errorCode: string | null;
    }
  | {
      type: "settlement";
      payload: CostSettlementPayload;
    }
  | {
      type: "actual_budget_closure";
      payload: ActualBudgetClosurePayload;
    }
);

export type OutcomeWriteResult =
  | "persisted"
  | "pending"
  | "review_required"
  | "overflow";
interface RetainedOutcome {
  identity: string;
  outcome: PricingOutcome;
  hash: string;
  bytes: number;
  attempts: number;
  nextAt: number;
  state: "pending" | "review_required";
  running?: Promise<OutcomeWriteResult>;
  inspectedAt?: number;
}

/** A bounded pre-durable retry aid, NOT an outbox that survives a process loss. */
export class PricingOutcomeRetryBuffer {
  private readonly entries = new Map<string, RetainedOutcome>();
  private bytes = 0;
  private overflows = 0;
  private conflicts = 0;
  private retired = 0;
  private archived = 0;
  private flushing?: Promise<Record<OutcomeWriteResult, number>>;

  constructor(
    private readonly write: (outcome: PricingOutcome) => Promise<void>,
    private readonly limits = {
      entries: 1000,
      bytes: 16 * 1024 * 1024,
      entryBytes: 256 * 1024,
    },
    private readonly archive?: (outcome: PricingOutcome) => Promise<boolean>,
  ) {}

  status() {
    return {
      entries: this.entries.size,
      bytes: this.bytes,
      pending: [...this.entries.values()].filter(
        (entry) => entry.state === "pending",
      ).length,
      review_required: [...this.entries.values()].filter(
        (entry) => entry.state === "review_required",
      ).length,
      overflows: this.overflows,
      conflicts: this.conflicts,
      retired: this.retired,
      archived: this.archived,
    };
  }

  assertAdmissionCapacity(): void {
    if (
      this.entries.size >= this.limits.entries ||
      this.bytes + this.limits.entryBytes > this.limits.bytes
    )
      throw new PricingRepositoryError(
        "pricing_recovery_backpressure",
        "Accounting persistence is backlogged; retry before dispatching a new priced request.",
        503,
      );
  }

  protects(reservationId: string, workspace: string): boolean {
    return [...this.entries.values()].some(
      (entry) =>
        entry.outcome.reservationId === reservationId &&
        entry.outcome.workspace === workspace &&
        entry.state === "pending",
    );
  }

  async persist(
    outcome: PricingOutcome,
    now = Date.now(),
  ): Promise<OutcomeWriteResult> {
    // Copy before the first await. Later callbacks cannot change a queued terminal decision.
    const json = JSON.stringify(outcome);
    const copy = JSON.parse(json) as PricingOutcome;
    const hash = pricingContentHash(copy);
    const identity = JSON.stringify([
      copy.workspace,
      copy.type,
      copy.type === "attempt" ? copy.attemptId : copy.reservationId,
    ]);
    // Retain distinct bodies independently; a completing earlier writer must not
    // erase an incoming different receipt under the same logical identity.
    const key = JSON.stringify([identity, hash]);
    const prior = this.entries.get(key);
    if (prior) {
      if (prior.running) return prior.running;
      return this.attempt(key, prior, now);
    }
    const siblings = [...this.entries.values()].filter(
      (entry) => entry.identity === identity,
    );
    const conflicting = siblings.length > 0;
    if (conflicting) {
      this.conflicts++;
      for (const entry of siblings) entry.state = "review_required";
    }
    const bytes = Buffer.byteLength(json, "utf8");
    if (
      bytes > this.limits.entryBytes ||
      this.entries.size >= this.limits.entries ||
      this.bytes + bytes > this.limits.bytes
    ) {
      // Already-dispatched work must still get its first persistence attempt.
      // If that fails, its durable dispatch/hold remains for orphan review.
      try {
        if (conflicting) {
          if (!this.archive || !(await this.archive(copy)))
            throw new Error("No durable archive acknowledgement");
          this.archived++;
          return "review_required";
        }
        await this.write(copy);
        return "persisted";
      } catch {
        this.overflows++;
        return "overflow";
      }
    }
    const entry: RetainedOutcome = {
      identity,
      outcome: copy,
      hash,
      bytes,
      attempts: 0,
      nextAt: now,
      state: conflicting ? "review_required" : "pending",
    };
    this.entries.set(key, entry);
    this.bytes += bytes;
    return this.attempt(key, entry, now);
  }

  flush(
    now = Date.now(),
    limit = 100,
    force = false,
  ): Promise<Record<OutcomeWriteResult, number>> {
    if (this.flushing) return this.flushing;
    const count = Math.max(1, Math.min(1000, Math.trunc(limit)));
    this.flushing = (async () => {
      const result = {
        persisted: 0,
        pending: 0,
        review_required: 0,
        overflow: 0,
      };
      const due = [...this.entries.entries()]
        .filter(
          ([, entry]) =>
            (entry.state === "pending" || this.archive) &&
            (force || entry.nextAt <= now),
        )
        .sort((a, b) => a[1].nextAt - b[1].nextAt)
        .slice(0, count);
      for (const [key, entry] of due) {
        if (this.entries.get(key) !== entry) continue;
        result[await this.attempt(key, entry, now)]++;
      }
      return result;
    })().finally(() => {
      this.flushing = undefined;
    });
    return this.flushing;
  }

  /** Retire only explicitly audited superseded budget decisions, never unpersisted usage receipts. */
  async retireSuperseded(
    check: (outcome: PricingOutcome) => Promise<boolean>,
    limit = 100,
  ): Promise<number> {
    let retired = 0;
    const entries = [...this.entries.entries()]
      .filter(
        ([, entry]) => !entry.running && entry.outcome.type === "settlement",
      )
      .sort((a, b) => (a[1].inspectedAt ?? 0) - (b[1].inspectedAt ?? 0))
      .slice(0, Math.max(1, Math.min(1000, limit)));
    for (const [key, entry] of entries) {
      entry.inspectedAt = Date.now();
      let authoritative = false;
      try {
        authoritative = await check(structuredClone(entry.outcome));
      } catch {
        /* Retain evidence if authority cannot be verified. */
      }
      if (authoritative && this.entries.get(key) === entry && !entry.running) {
        this.entries.delete(key);
        this.bytes -= entry.bytes;
        retired++;
        this.retired++;
      }
    }
    return retired;
  }

  private attempt(
    key: string,
    entry: RetainedOutcome,
    now: number,
  ): Promise<OutcomeWriteResult> {
    if (entry.running) return entry.running;
    entry.running = (async (): Promise<OutcomeWriteResult> => {
      if (entry.state === "review_required")
        return this.archiveEntry(key, entry, now);
      try {
        // A fresh copy also prevents a writer from mutating the retained retry body.
        await this.write(structuredClone(entry.outcome));
        if (this.entries.get(key) === entry) {
          this.entries.delete(key);
          this.bytes -= entry.bytes;
        }
        return "persisted";
      } catch (error) {
        entry.attempts = Math.min(entry.attempts + 1, 1000000);
        if (
          error instanceof PricingRepositoryError &&
          [400, 404, 409].includes(error.status)
        )
          entry.state = "review_required";
        entry.nextAt =
          now + Math.min(60000, 1000 * 2 ** Math.min(entry.attempts - 1, 6));
        return entry.state === "review_required"
          ? this.archiveEntry(key, entry, now)
          : entry.state;
      }
    })().finally(() => {
      entry.running = undefined;
    });
    return entry.running;
  }

  private async archiveEntry(
    key: string,
    entry: RetainedOutcome,
    now: number,
  ): Promise<OutcomeWriteResult> {
    try {
      if (
        this.archive &&
        (await this.archive(structuredClone(entry.outcome)))
      ) {
        if (this.entries.get(key) === entry) {
          this.entries.delete(key);
          this.bytes -= entry.bytes;
          this.archived++;
        }
      }
    } catch {
      /* Keep the original body until a durable scoped acknowledgement exists. */
    }
    entry.nextAt = now + 60000;
    return "review_required";
  }
}

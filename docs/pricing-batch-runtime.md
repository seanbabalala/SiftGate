# Priced embedding batching — runtime checkpoint

Implemented in the isolated development candidate, **not deployed and not full
Goal completion**. The [allocation foundation](pricing-batch-allocation.md) is now
connected to actual priced embedding requests. The
[Goal Spec](pricing-engine-goal-spec.md) and [progress](pricing-engine-progress.md)
retain all remaining acceptance requirements.

## Dispatch and grouping

When embedding batching is enabled and the request has an activated pricing
snapshot, the pipeline uses `PricedEmbeddingBatchingService`. Unactivated requests
continue through the corrected legacy queue. Disabled batching, an individual
request that cannot fit the queue, or an incompatible aggregate uses ordinary
independent dispatch rather than silently changing admission policy.

Every member captures its own pricing context, request/reservation identity,
credential allowance and renewable hold. Queue identity includes the workspace
and principal/budget scopes, selected target, catalog revision, price/content/FX
version, admission policy, request shape, session and configuration revision.
Different tenants or differently admitted tariffs are not merged just because
their logical model names match. The raw provider callback stays bound to the
originating asynchronous context; it does not replace the member contexts.

Before a shared physical credential attempt, all member dispatch intents commit
in one transaction. Any member mismatch or failed preparation prevents fetch.
Each physical retry gets a new shared physical-attempt ID and separate per-member
attempt IDs; previous unknown/observed fees remain retained. Internal credential
retries and later outer retries cannot overwrite one another.

## Aggregate admission and strict reservations

The proposed physical aggregate is assessed using the frozen catalog and the same
admission/envelope implementation as independent requests. A physical supplier cap
is not multiplied by member count. The coordinator declines the proposed aggregate
when its input would exceed a declared cap or configured context bound.

For `reserve_upper_bound`, the physical envelope is conservatively allocated with
the same member weights. Each share must fit the member's already reserved
per-attempt allowance. If that proof is unavailable, requests remain independent;
the coordinator does not increase live budget limits or fabricate an output cap.
The provider client uses the minimum captured credential allowance across members.
The guarantee remains conditional on declared supplier limits and verified adapter
semantics, not a promise that arbitrary provider behavior is bounded.

## Physical fee and per-member receipt

The actual aggregate usage is priced exactly once, including context tiers,
invocation fees, quantity rounding and fixed FX. The same deterministic allocation
primitive used by `/batch/quote` produces each member's share. A successful
independent invocation now also supplies the explicit invocation count to the
calculator, so a base fee is not supported only when batching happens.

Every top-level attempt cost is **that member's allocated amount**. Its optional
`batch` evidence holds:

- Batch and physical-attempt IDs.
- Complete physical computation and its hash.
- Stable member/request/reservation identities, input spans, weighting basis and
  exact weights, total weight, and this member's index.

The physical computation is currently repeated inside each member receipt for
self-contained replay and integrity checking. It is explanatory metadata, not
another charge; summing nested physical totals would double-count. Global report
physical-call counts must deduplicate physical-attempt IDs, while per-request
attempt counts describe the calls in which that request participated.

Ledger validation recomputes the deterministic share from the physical evidence.
Changed amounts, wrong membership or partial group outcomes are rejected. Every
share and terminal decision commits atomically, so no subset can be accepted with
a different total. No schema migration is added by this checkpoint.

The shared frontend breakdown distinguishes a share from physical cost and uses
`physical component amount × weight / total weight`, not a misleading smaller
request's tariff formula. It can expand the original physical formula. All new
strings cover seven locales. Full request-log/report UI and browser acceptance
for that presentation remain open M5 work.

## Failure, cancellation and delivery

HTTP failure is not zero cost. Explicit failure usage contributes to the physical
known subtotal; missing usage or an unproven failed-invocation fee remains unknown.
Shares preserve this unknown status. The final-response-compatible logical budget
stays distinct from all supplier attempt fees.

- Cancellation while still queued removes that member before batch preparation.
- Once the batch is prepared/in flight, cancelling one member returns that
  client's cancellation without aborting surviving members or reallocating its fee.
- Shared upstream cancellation occurs when all participating clients cancel or
  time out. Missing terminal provider usage stays unknown, never free by assumption.
- Holds/leases survive an early client response until the physical outcome and
  member terminal intents are durable.
- A generated result whose member slice is missing/invalid still has its supplier
  cost allocation retained; its compatible logical hold is released. Existing
  routing policy may then try a separate fallback, which has its own evidence.

The coordinator commits successful members' allocated logical costs and releases
cancelled/missing-result members. Ordinary pipeline bookkeeping observes the
coordinator-managed settlement and cannot debit a second time. It may still report
estimated usage to clients when raw usage is absent; the immutable receipt remains
explicitly unknown/incomplete.

## Persistence and recovery

`completeAttemptGroup` atomically stores all physical shares and any terminal
member intents. Individual budget effects then apply using the existing durable
outbox. A crash after that atomic commit is recoverable without provider replay;
concurrent workers cannot double debit.

An allocation failure records unknown cost and retains the normalized usage for
reconciliation instead of making up a zero or triggering a paid fallback.
A transient final-persistence failure does not turn a valid provider result into
another paid request. Pending metadata/outcomes remain in the owning process,
holds stay renewable, and a bounded periodic retry attempts persistence again.
Failed receipt persistence also fences further internal paid credential retries.
The task never changes another process's watchdog/restart behavior to recover.

An in-memory pending outcome is **not** durable. Process loss before its atomic
commit still leaves prepared dispatches with an ambiguous outcome; general orphan
reconciliation must address that. The final Goal must also review pending-outcome
retention, metadata amplification from repeated physical evidence, shutdown races
and large-batch performance. Passing the current tests does not waive these gates.

## Evidence

Real isolated HTTP tests exercise:

- Three member requests, one actual fetch, and all dispatch intents existing first.
- Whole-batch context tier plus base fee, component conservation and logical costs.
- Credential/outer retries, observed failures and unknown prior fees.
- Price/FX publication while pending and differently versioned queue admissions.
- Principal isolation and strict aggregate-cap/allocated-envelope checks.
- Missing usage/result slices, physical-usage replay, and independently priced
  single requests using the same base-fee semantics.
- One real HTTP client disconnect with a surviving member; all clients cancelling.
- Injected preparation/outcome storage failure, retained leases and recovery with
  no repeated provider call.

SQLite WAL and the task-owned PostgreSQL contract also inject a second-member
intent failure and verify full rollback, reject tampered/incomplete allocations,
race reversed-order writers/replayers, and terminate only an isolated child after
the physical outcome commits but before budget application.

## Subsequent correction checkpoint

[Conserved batch corrections](pricing-batch-corrections.md) now provide an
administrator-only preview/apply path that restores the historical tariff and
appends every member revision, exact budget effect, log projection and group audit
atomically. Single-member overwrites remain forbidden. Request-log correction,
replay and history now have an [isolated Dashboard workflow](pricing-dashboard.md),
but supplier-authenticated callbacks and full report/coverage acceptance remain open.

## Budget observation and cancellation checkpoint

Budget threshold/telemetry observations now wait for the full transaction commit,
using the net effect of all members rather than temporary intermediate holds.
Rollback does not enqueue a threshold notification, and notifier failure cannot
retry the provider. See [budget observers](pricing-budget-observers.md).

The legacy embedding cancellation path now exits without re-enqueueing on another
target or penalizing provider health. Real HTTP tests wait for its cancelled
pipeline to finish while the shared provider remains alive for another member.
Grouping-specific tests synchronize initial queue arrival while preserving async
contexts; they do not assume HTTP pre-processing always finishes within a 15ms
window. A separate straggler test expects separate physical calls and conserves
usage for each. The production batching parameters are unchanged.

## Remaining work
- Broader adapter/limit domain checks, cancellation/preparation and shutdown race
  review, pending/outbox retention and orphan reconciliation.
- Full report/operator UI, physical-call deduplication in reports, broader browser
  checks, and large-batch metadata/performance measurements.
- Full Goal acceptance, candidate packaging, deployment/rollback review and explicit
  user approval before deployment. The live 2099 gateway remains untouched.

## Subsequent complete-group custody checkpoint

[Group inbox010](pricing-group-outcomes.md) now retains complete physical outcomes
before the group writer and permits replay without the original memory coordinator.
Cost-only and terminal-decision phases remain distinct; all physical shares stay
atomic. Positive review custody can retire local lease ownership without applying
budget proposals. The pre-retention memory-loss boundary, complete group
disposition/UI and final capacity/retention acceptance remain explicitly open.

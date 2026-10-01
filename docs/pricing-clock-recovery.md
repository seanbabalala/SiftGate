# Pricing admission during clock rollback

An active catalog revision can temporarily appear to be in the future when the
host wall clock moves backward. Request admission must not rewrite that revision,
backdate it, clamp a request timestamp, disable snapshot verification or fall back
to different prices. Calendar selection still uses the actual admitted instant.

## Bounded recovery

When a new request observes a catalog creation time ahead of its wall clock,
`PricingRepository.capture` completes its read-only transaction and releases the
shared SQLite serialization fence before waiting. There is no provider dispatch,
budget reservation or saved request snapshot at that point. An unrelated writer
can proceed during the wait.

The wait uses a per-admission monotonic deadline of at most1000milliseconds.
Repeated rollback observations share that deadline; wall-clock changes cannot
extend it. After waiting, admission rechecks the request's idempotent winner and
the current catalog head under a fresh transaction. A publication during the wait
may therefore become the request's admitted revision. Only a successful capture
fixes its immutable snapshot.

Excessive skew, or skew that cannot recover within the remaining wait allowance,
produces HTTP503 with `error.type: pricing_error` and
`error.code: pricing_clock_skew`. The response contains no catalog identifier,
private tariff, request body or credential. It does not initiate a provider retry
or alter the host clock. Operators must investigate persistent synchronization
or cross-host clock problems rather than repeatedly restarting the gateway.

An already captured request restores its original snapshot even if the current
clock later moves backward. Corrupt or backdated snapshot fields still fail the
existing chronology and checksum checks; clock recovery does not repair history.

## Evidence and limits

The original full regression had3309passing unit tests and430of431passing E2E
tests. Its batch-allocation failure occurred alongside two admission chronology
errors. A read-only host log query found a successful system clock adjustment of
`-0.052490830`seconds at2026-09-28 22:16:50 Asia/Shanghai, the same second as those
errors. That run did not record per-request timestamps, so the exact original
admission delta is not available.

Three subsequent instrumented runs of the preceding conditions/media suites and
the fresh-harness batch suite did not naturally reproduce the failure. A
process-local53millisecond rollback then reproduced the admission chronology
HTTP500 before the fix. A larger injected rollback reproduced
the previous generic500 rather than a structured temporary-unavailability result.
Those failed results remain part of the diagnostic record, not passing acceptance.
An initial test-wide Date-constructor replacement also interfered with TypeORM's
date-column hydration. The regression fixture now injects only the admission
clock observation, preserving native Date identity and exercising real auth,
database, batching and provider-response paths without that fixture artifact.

Regression coverage includes bounded and repeated waits, public error mapping,
SQLite/PostgreSQL concurrent publication and idempotent capture during recovery,
unchanged historical snapshots, tamper rejection, and the real HTTP batch path.
No test changes the operating-system clock, contacts a paid provider or binds2099.

This admission recovery is not a general monotonic clock for the application.
Supplier timestamps, lease expiry, budget periods and other wall-clock consumers
retain their existing semantics. Full pricing acceptance, performance targets,
the actual-upstream budget policy, and final candidate-image validation remain
separate requirements; this fix does not establish deployment readiness.

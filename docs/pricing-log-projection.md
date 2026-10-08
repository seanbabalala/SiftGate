# Owned PostgreSQL call-log cost projection

The synchronous PostgreSQL logging path uses the cost projected while saving the
call log, instead of first computing a separate preliminary ledger summary.
This applies only when the active pricing context owns the same request and
workspace. It does not publish prices, change budget policy or add a deployment
configuration switch.

## Accounting and failure boundaries

- The request snapshot must exist in the selected workspace. The normal ordered
  request lock, receipt/adjustment verification and log-write transaction remain.
  An unavailable owned projection must not fall through to unpriced storage with
  an input placeholder.
- Metrics on this path use the saved log's verified numeric cost projection after
  the write commits. The ledger's exact decimal amounts and immutable cost hashes
  remain the financial source of truth; the legacy numeric log field does not
  become a new billing authority.
- Missing usage remains an unknown fee, with its original unresolved hold. A
  numeric known-subtotal projection of zero does not establish a free request.
- A captured request with no attempts or reservations does not retain an arbitrary
  caller-supplied log cost. This is distinct from a provider request with missing
  usage, which remains unresolved in the ledger.
- If persistence or a preceding observer fails, the logger attempts the ordinary
  summary-based metric path once. It does not repeat a provider call or publish a
  failed placeholder write. A failure after metrics are attempted does not cause
  a duplicate metric attempt.
- A telemetry or event-publisher failure after a successful commit does not undo
  that committed log. Request shutdown still drains the existing accounting and
  logging work before database providers are destroyed.

SQLite, including its write-behind queue, still obtains a preliminary summary
before publishing a queued log. Unowned and legacy paths also retain their
ordinary behavior. The optimization does not remove log-row fencing, combine
independent financial writes or relax transaction durability.

## Verification scope

Tests cover owned/unowned contexts, missing snapshots, unavailable projections,
known and missing-usage costs, corrupted receipts, save rollback, SQLite queued
values, and metric/publisher failures. The implementation checkpoint passes3828
unit tests and688 HTTP tests, plus builds, lint and compatibility checks.

On the instrumented500-request PostgreSQL workload, full summary calculations
fell from four to three per request and SQL calls from166 to160. This is a measured
work reduction, **not performance acceptance**. The uninstrumented PostgreSQL and
SQLite comparisons still miss original targets in the cases recorded in
[pricing performance](pricing-performance.md). No production2099 restart,
configuration change, deployment or final-image acceptance is implied.

## Explicit transaction ownership for row locks

PostgreSQL locked request/reservation/attempt helpers now require an active
transaction on the ledger's own `DataSource`. A raw `getRawOne` locking query did
not itself reject an autocommit call in the isolated test. The explicit guard
prevents that private-helper misuse; this is not evidence that normal production
writers were running without transactions. Existing public write paths already
establish their transactions.

Tests verify rejection before reads for an inactive or foreign data source,
request-before-child lock order, workspace failures, fresh reads after a blocked
parent lock, and deletion while waiting. Unlocked reads and SQLite behavior remain.
The read-width experiment described in the performance record was removed; this
guard does not change the original query shape or receipt validation.

## Verify the subtotal before acquiring shared budget locks

Settlement now prepares its log-cost projection after validating and completing
the retained receipts, but before acquiring the shared budget rows. The same full
summary and adjustment-chain checks still run, even when there are no log rows to
update. The request-parent lock remains held throughout the transaction, fencing
cooperating receipt and correction writers.

Only the verified numeric log subtotal crosses this boundary; the earlier summary's
budget state is not reused. Budget changes, effects, reservation state, applied
intent and recovery state retain their original order. The log UPDATE still happens
after those writes in the same transaction. Failures roll back the entire delivery,
while the separate first retention commit remains available for recovery.
Other projection callers continue to prepare and write together as before.

A PostgreSQL concurrency test pauses projection and proves that another transaction
can lock the shared budget row, while a non-waiting request-row lock is rejected.
The preceding implementation failed the budget-row assertion. Ordering tests cover
both databases; corrupted unrelated receipts remain rejected with no log rows.
These checks pass together with the existing crash, rollback, duplicate, unknown-
cost, local-cache, actual-expense and batch selections: 591 unit tests and 132 HTTP
tests, plus build and lint. This is focused evidence, not a complete-source release
certificate. The full regression checkpoint is recorded separately.

The diagnostic profile retains 154 SQL calls, 11 transactions and three full
summaries per request. The work was moved outside the shared budget-lock interval,
not removed. Current comparative performance still misses original targets; see
the complete results in [pricing performance](pricing-performance.md).

## Joined PostgreSQL log settlement

**Historical experiment, now removed.** The following describes the archived
joined-log implementation and its verification. It did not demonstrate the
intended overall performance gain. Current code again uses separate settlement
and scoped call/route-log writes; full pricing, recovery and logging capabilities
remain. See [the restoration record](pricing-performance.md#joined-log-experiment-removal-and-restoration).

An ordinary non-streaming PostgreSQL request can insert its call and optional
route log inside the final settlement transaction. Eligibility requires its
matching, unclosed reservation, no pending batch/media work, legacy logical
budgeting, synchronous route writes and disabled async evaluation. The awaited
runtime frame binds request, workspace and reservation; unrelated or background
work cannot consume another request's log completion.

The log cost comes from the full validated receipt/history projection in that
same transaction, never a cached projection carried across commits. Log insertion
happens before shared budget locks. Budget scope discovery, period resets, exact
counter hydration and both independent durable outcome retentions remain intact.

Optional log inserts use a real nested savepoint. A call or route insertion error
rolls back those tentative inserts without poisoning the PostgreSQL transaction;
accounting continues, followed by the existing separate logging fallback. A money
write failure still rolls back the outer transaction and its staged logs. The
pipeline publishes a joined row only after the outer commit returns.

PostgreSQL sequence-allocated IDs are retained for scoped fallback logging after
rollback or a lost commit acknowledgement, avoiding another insert identity.
They are not evidence that a row or expense committed. SQLite keeps the separate
path and receives no provisional rowid, because rolled-back rowids can be reused.
Already-terminal settlements do not insert another joined log.

Log metadata preparation failures preserve budget-first fallback. Optional trace
construction failure is caught separately: call-only settlement/logging continues,
and the failed pure trace build is not retried. Enabled async evaluation preserves
its original post-budget ordering. Streaming, batch and actual-expense accounting
are not redirected through this joined path.

Current tests include real PostgreSQL trigger failures, tentative-write visibility,
fresh shared-budget locking, cross-request correlation and commit-acknowledgement
loss. Eleven actual compiled-main cases verify these flows and exclusions using
14 synthetic provider calls. The shutdown case holds tentative log writes,
confirms they are invisible externally, sends SIGTERM, observes new connections
refused, then releases work and verifies a successful response, exact expense and
exit code zero. Restart after the lost-ack case creates no duplicate expense/log
or provider request.

The full source passes 4,357 unit and 811 HTTP tests. The new native fault fixture's
first actual-expense assertion incorrectly expected no settlement intent; the
existing cohort path explicitly requires an applied intent. The corrected fixture
also verifies each reservation's budget basis. This is native PostgreSQL evidence,
not refreshed Linux image certification. Original HTTP performance still fails
four scenarios, as recorded in [pricing performance](pricing-performance.md#joined-log-settlement-native-checkpoint).

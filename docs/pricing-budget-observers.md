# Budget notifications and telemetry after commit

This contract covers the candidate's ordinary budget mutations and pricing-ledger
reservation, settlement and correction paths. It does not change production
configuration, budget limits, budget accounting policy or notification recipients.
There is no schema migration in this change.

## Transaction boundary

Previously an ordinary budget write could queue a threshold notification before
its SQL transaction committed. A later failure could roll back the balance while
the queued notification and in-memory telemetry snapshot remained visible. The
new exact-ledger path also lacked equivalent threshold notifications.

`BudgetService.withCommittedBudgetEffects` surrounds the **entire transaction
promise**, including commit/rollback, rather than only the transaction callback.
`CostLedgerService.write` and ordinary `withBudgetMutation` use that boundary.
Internal `reserveLedger`, `settleLedger` and `adjustLedger` methods only collect
observations; they cannot infer that a transaction owned by their caller committed.

Each observation captures workspace, rule ID, exact period/epoch, original exact
balance and final exact balance. Multiple mutations of the same rule within one
transaction coalesce. Temporary release/reapplication of a hold, or one member's
intermediate batch adjustment, cannot by itself trigger a notification.

On successful commit, a positive net change crossing the configured threshold
emits `budget_threshold`. Comparisons use exact arithmetic against the stored
rule parameters. The legacy database's representation of limits/thresholds is
unchanged; this is not a migration to exact configuration columns.

On rollback, collected threshold observations and telemetry updates are discarded.
A genuine `BudgetExceededError` may emit `budget_exceeded` **after rollback**:
that reports a rejected admission decision/projected value, not a committed debit.
An unrelated transaction error cannot publish that decision accidentally.

Nested savepoint boundaries merge observations into their parent only on success.
The outermost commit controls publication. Failed inner savepoints do not leak
observations if their caller continues the outer transaction.

## Amounts, scope and epochs

Budget values include reservations and compatible logical commitments; they are
not necessarily the sum of physical supplier fees. Notification details include:

- `workspace_id`, existing scope/key/namespace/team metadata;
- `current_exact` and `limit_exact` decimal strings alongside old rounded fields;
- `basis: reserved_and_committed_budget`;
- `period_start`, the exact epoch identifier, and `reset_at`.

Deduplication identity includes workspace, rule ID, scope, event type and the exact
epoch. Different workspaces and manual resets no longer share a debounce identity.
Corrections to a retained old epoch do not trigger a current-period threshold.

Telemetry snapshots collected during ordinary budget transactions are published
only after commit. The ledger's post-commit metric refresh uses the same SQLite
connection queue as participating ledger/budget writes, so it does not read another
participating transaction's uncommitted intermediate balance. PostgreSQL retains
its existing transaction/row-lock behavior.

Ledger metric refresh is requested through the commit boundary only when it
collected current-epoch budget observations. Attempt receipts, settlement intents
and idempotent replays without budget changes no longer query every active rule.
Corrections confined to an older epoch do not refresh current-period metrics.
Nested refresh requests merge only after a successful savepoint, execute once
after the outer commit, and are discarded on inner or outer rollback. Existing
ordinary budget metric snapshots and threshold notifications retain their
post-commit behavior; this does not remove any ledger transaction or durable write.

## Failure semantics and limits

An exception while queueing a notification is logged without sensitive exception
content. It cannot turn an already committed reservation or successful provider
response into a failure, and cannot cause another provider attempt.

These are post-commit, **best-effort notifications**, not a durable outbox or an
exactly-once external delivery protocol. A process crash between SQL commit and
enqueue, or while an existing AlertService delivery is pending, may lose a
notification. Replaying an already-applied idempotent settlement does not invent
a new threshold crossing or replay that alert. No production connector is enabled
or contacted by the tests.

This change alone did not coordinate every unrelated SQLite writer. The subsequent
[administrator-writer checkpoint](pricing-admin-writers.md) coordinates generated-key/
team budget updates, authentication metadata and transactional management audit;
other repository writers still require review. General orphan reconciliation and
durable supplier evidence recovery remain independent requirements in the full
[Goal Spec](pricing-engine-goal-spec.md).

## Verification

The same isolated SQLite WAL/PostgreSQL contract tests cover rollback, real commit
ordering, grouped net changes, exact sub-floating-point threshold crossings,
settlement/correction/refund behavior, rejected admission, throwing notification
sinks, nested savepoints, telemetry rollback, workspace/epoch deduplication and
old-epoch corrections. A separate database without pricing tables verifies the
ordinary legacy path remains usable and rollback-safe.

Ledger integration injects a failure after budget writes but before durable effect
insertion: there is no notification until a successful retry; subsequent identical
reserve/settle operations do not duplicate it. A real mocked-provider HTTP request
with a throwing alert sink still returns 200, records the committed cost and uses
only one provider call. See [progress](pricing-engine-progress.md) for the latest
full-suite counts and remaining Goal gates.

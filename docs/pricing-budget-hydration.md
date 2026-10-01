# Bounded exact-budget balance reads

The candidate batches exact-balance hydration for the rules already selected by
the budget service. It does not change rule selection, pricing, budget policy,
transaction boundaries or the meaning of a reservation.

## Read and lock boundaries

Scope discovery, duplicate-rule removal and PostgreSQL's globally ordered
budget-row locks are unchanged. After those steps, a read selects only the exact
`(rule_id, period_start)` pairs in the current workspace. Each chunk contains at
most 250 pairs and 501 parameters. An empty selection does not query balances.
This is not an unrestricted workspace scan or a cross-product of IDs and epochs.

Hydrated values exist only on the current operation's rule objects. There is no
cross-transaction cache. Ordinary reservation arithmetic no longer repeats the
same read after scope hydration. A daily reset clears the transient value, so
the new epoch is read again rather than reusing yesterday's balance. Other
single-rule callers still perform fresh reads through the same helper.

The legacy projection comparison is unchanged, including the PostgreSQL float4
bridge. Missing balances and changed compatibility projections follow the existing
legacy fallback. An invalid selected exact amount still fails accounting rather
than becoming zero. Writes, rollback, post-commit observations and inactive/old
hold settlement retain their existing paths. No migration is added or changed.

## Verification

Twenty new SQLite/PostgreSQL cases verify overlapping scopes and exact microamounts,
read-only checks, empty selections, 251-rule chunking, fresh values across
transactions, missing/projection-mismatch fallback, workspace/epoch isolation,
daily resets, malformed-amount rollback and legacy-null workspace ownership.
Synthetic seed failures are retained separately from valid query-count red tests;
they are not reported as production defects.

The full candidate passes 4,100 unit tests in 200 suites and 746 HTTP tests in
59 suites, with no failures or skips. Existing concurrency, inactive-hold,
manual-reset, rollback, notification and recovery cases remain included. Builds,
frontend contracts/budgets, SDKs and configuration/documentation/static-deployment
checks pass; migration001–018 checksums remain unchanged.

A separate 500-request PostgreSQL profile records 136 to 131 SQL statements per
request, with exact-balance reads reduced from eight to three. Ten transactions,
two independent outcome retentions and two cost summaries per request remain.
These are structural counts, not end-to-end latency acceptance; inclusive timing
spans overlap. The unchanged-workload comparisons still fail two original HTTP
targets. See [the measured results](pricing-performance.md#bounded-exact-budget-hydration).

This work is isolated and not deployed. Production2099 and the user-confirmed
model configuration were not modified, reloaded or restarted.

# Runtime retention state reads

Status: **correctness verified; overall performance acceptance remains unmet**.

## Current PostgreSQL persistence phase

PostgreSQL now discovers the reservation's parent and locks **only that parent**
in one statement. The full ownership/body/membership/audit graph is still read
in a separate statement after the lock has been acquired. It is not read from
the lock statement's potentially older snapshot. A two-connection test waits on
the parent, moves the child in the blocking transaction, and verifies rejection
against the fresh graph after the wait.

Each new retained body and its mandatory audit markers use one parameterized
data-modifying statement inside the existing retention transaction. A validated
acknowledgement group likewise writes its pending-state transitions and delivery
markers together. Identifiers come from fixed internal column lists; body JSON,
workspace, identity, state and audit text remain bound values. Updates and marker
inserts have checked row counts, so a trigger that suppresses a row cannot
silently acknowledge persistence. Any failure rolls back the owning transaction.

Acknowledgements remain bounded to129 outcomes per statement, at most2065 bound
parameters. Already delivered rows are revalidated but not transitioned again.
SQLite retains the sequential write path. The two independent retention commits,
full historical cost validation, fresh budget scopes/epochs and final accounting
commit are unchanged; no request is completed early.

Seventeen added cases cover binding and transaction counts, real audit/body
failures, suppressed PostgreSQL writes, the full receipt chunk boundary,
idempotence and the parent-lock race. Existing query-builder fault mocks that
could not intercept the grouped SQL now use real database triggers, with their
rollback assertions and test names preserved. The complete source passes
**4,336 unit tests and807 HTTP tests**, without failures or skips, including all
previous assertions. Migration and dependency checksums are unchanged.

The measured common PostgreSQL path drops105 to97 SQL statements, and its two
retentions drop14 to10 statements, including transaction boundaries. The paired
diagnostic does **not** establish an overall latency gain. Original balanced
comparisons still fail delayed PostgreSQL JSON, while the other seven scenarios
pass. See [the current measurements](pricing-performance.md#postgresql-inbox-persistence-phase).
This is retained for bounded, request-fenced persistence and checked atomic
effects, not declared sufficient to meet the original latency target.

## Earlier checkpoint: relational state reads

Independently retained runtime evidence still commits before its receipt delivery
or budget application. Retention locks the request, then performs one bounded
relational read containing the reservation edge, exact receipt membership,
asynchronous-task indicators, one exact outcome body, sibling existence and three
unique audit identities. It does not aggregate history or combine unrelated
requests, retention commits, audit writes or money application.

Every execution reads state after the request lock; no validation crosses a
transaction. An active transaction is required. A changed request edge,
missing/foreign attempt, corrupt retained marker or terminal marker without a
body is rejected rather than trusting stale ownership. Existing sibling
quarantine, retry, body-hash, audit and process-exit recovery checks remain. The
returned outcome excludes joined inspection fields. Body and mandatory audit
writes remain separate statements in the same independent transaction.

This changes [runtime evidence retention](pricing-runtime-outcomes.md), not the
settlement policy, usage calculation, default budgets or activation rules.
The request-edge test uses an adversarial transaction hook; it is not evidence
that a production caller had changed an immutable ownership edge.

## Verification

Twenty-six added cross-database cases cover the three-read sequence, missing and
foreign receipt membership, changed ownership after the fence, transaction
preconditions, orphan/corrupt audit markers and post-fence job attachment. Existing
independent-connection races, process exits, quarantine, audit failures, exact
budgets and replay tests remain intact.

Complete regression passes **4,255 unit tests in 205 suites and 807 HTTP tests in
65 suites**, without failures or skips. All earlier 4,229 unit assertion names
remain present. Builds, lint, frontend contracts/bundle budgets, SDKs, configuration,
documentation and static deployment checks pass. All18 migration checksums are
unchanged. Runtime and test dependencies did not change.

The initial negative fixtures used nonexistent foreign-key targets; corrected
fixtures create the other valid request/reservation before changing an edge.
An existing query observer mistook a nested attempt predicate in the new query
for the dedicated acknowledgement audit read. Its filter now names the audit
`FROM` table; original count and transaction assertions are unchanged. The failed
runs remain recorded, not counted as successful verification.

## Performance scope

A normal first retention uses three `SELECT` statements rather than seven.
Including transaction boundaries and body/audit writes, it uses seven statements
rather than eleven. A paired instrumented actual-main PostgreSQL run retains two
independent retentions and ten transactions per request, reducing123 to115 SQL
statements. All1200 mock requests and exact accounting checks pass.

The retention phase's SQL interval union averages4.936ms before and4.021ms
afterward; post-upstream-header wall time averages21.885ms and20.019ms. The run
order is before/after, not balanced. These are diagnostic means, not acceptance
p95, isolated database CPU, or proof that every workload improves.

The subsequent unchanged balanced comparisons still fail two PostgreSQL cases
and one SQLite case. See [the complete performance results](pricing-performance.md#bounded-retention-state-reads).
The change is retained for bounded shared reads and verified ownership/audit
checks, **not** declared sufficient to meet the original performance target.
Remaining settlement work must be improved without removing durability or
integrity guarantees. No threshold or slow repetition is waived.

All owned verification processes are stopped. Production2099 and the user's
model configuration were not changed. No Git publication, image creation or
deployment occurred; database/platform/provenance and final candidate gates
remain open.

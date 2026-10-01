# Settlement receipt graph

Status: **correctness verified; overall HTTP performance remains unmet**.

The original receipt-graph checkpoint is recorded first. The later
[completion phase](#tentative-completion-before-budget-mutation) changes placement
of request-owned writes without merging retention or settlement commits.

The joint receipt-acknowledgement path derives the exact expected identities
before awaiting its request fence. One bounded relational query reads their
stored bodies, receipt membership, three audit markers, sibling existence and
operator-disposition presence. It verifies all rows in a chunk before writing
any acknowledgements. Each audit insert and state update remains an individual
statement in the same settlement transaction. Independent receipt and terminal
decision retention commits remain outside that transaction.

At most128 receipt expectations plus one settlement delivery are read per chunk.
A later-chunk integrity failure rolls back earlier acknowledgements and prevents
budget application. Optional absent receipt predecessors remain valid for direct
intents only if neither a sibling nor an orphan audit indicates existing custody.
Changing a stored subject cannot hide an exact malformed body. The required
settlement delivery retains its captured bytes; semantically equal receipt JSON
with a different property order remains accepted by the canonical content hash.
Unrelated or alternate receipt bodies are not downloaded merely to test existence.

This replaces only joined settlement receipt acknowledgement, normally used for
successful synchronous PostgreSQL calls. The ordinary non-acknowledging receipt
path and generic standalone acknowledgement API are unchanged. SQLite tests
exercise the same joint helper explicitly; this does not imply every SQLite
request now uses it. There is no database migration, dependency or budget-policy
change, cross-transaction verification cache or earlier response boundary.

## Original graph verification

Twenty-six added cross-database tests verify corrupted metadata, missing exact
evidence, orphan markers, bounds, caller mutation, fresh post-lock membership,
direct intents, JSON-order equivalence and129-member late-chunk rollback.
Existing independent-connection races, process exits, audit failures and monetary
tests remain. All previously passed assertion names are retained.

Two old SQL-observer assertions now describe the bounded joined read rather than
the replaced discovery/audit queries. They still require one bounded exact-body
read, all audit markers, unread alternate bodies and unchanged transaction counts.
A missing-row TypeScript guard and an invalid foreign-key fixture were corrected
before the accepted run. Failed results are retained, not counted as passes.

Complete regression passes **4,281 unit tests in205suites and807 HTTP tests in
65suites**, without failures or skips. Builds, lint, frontend contracts/budgets,
SDKs, configuration, documentation and static deployment checks pass. All18
migration checksums and dependency versions are unchanged.

## Original graph performance boundary

The new paired diagnostic records115 to110 SQL statements per request. Ten
transactions and two independent retention commits remain. The instrumented mean
receipt-stage interval decreases from3.567ms to2.698ms, while total post-upstream
header time increases from20.991ms to21.753ms in the same before/after run. These
inclusive intervals overlap and must not be summed. A faster individual stage
does not establish an end-to-end improvement or isolate the cause of variation.

The original balanced comparisons still fail PostgreSQL delayed JSON and SQLite
zero-delay JSON. See [the full results](pricing-performance.md#bounded-settlement-receipt-graph).
No repetition, workload or threshold is removed to claim success. The change is
retained for fewer redundant reads and explicit receipt-integrity checks, not
declared sufficient for the performance target.

All owned verification processes are stopped. Production2099 and the user's model
configuration remain unchanged. No Git publication, image creation or deployment
occurred at that checkpoint. See [current progress](pricing-engine-progress.md)
for later database/provenance acceptance and remaining delivery gates.

## Tentative completion before budget mutation

The settlement transaction still validates the immutable intent, exact receipt
bodies, ownership, audits, dispositions and full historical cost projection before
changing money. It now prepares the request-owned reservation, intent, recovery
case and log records **before** entering the budget writer. The budget writer
then discovers current scopes/epochs, reads exact balances and applies counters;
the budget effect is written from its returned allocations. Everything commits or
rolls back together.

Those prepared records are not an independently visible completion. Another
connection sees the original reservation, intent, recovery case and log until
commit. If a metadata statement fails, no budget writer runs. If a subsequent
budget statement fails or the owned process exits, all tentative writes roll back;
the separately retained outcome remains pending and replayable. No provider
request is repeated as part of this recovery.

The change does not release locks early, bypass budget checks, retain a stale
budget plan or skip history validation when no log row exists. A concurrent budget
epoch change before acquisition is read freshly: an old hold cannot refund the
new epoch. The completion timestamps are transaction-write timestamps, not a
separate commitment or an exact database commit clock. They do not select tariff
or calendar versions.

This ordering shortens the normal single-reservation path. Grouped callers may
already hold budget locks for earlier members, and actual-cohort/group work after
an individual application is unchanged. It is not a claim that every grouped
operation now performs all metadata work before all budget locks.

Nineteen added cross-database tests verify tentative visibility, four metadata
failure points, real database budget-rejection triggers, a real child exit before
budget writing, exact recovery and a two-connection PostgreSQL epoch/lock probe.
The complete source passes **4,319 unit tests in205suites and807 HTTP tests in
65suites**, with every earlier assertion retained and no failures or skips.
Builds, lint, frontend contracts/bundle limits, SDKs and static checks pass;
dependencies and all18migration checksums remain unchanged.

In the paired PostgreSQL diagnostic, the client-observed interval from completion
of the budget-lock query to completion of COMMIT contains seven statements rather
than eleven. Its mean changes3.208→1.761ms, while post-upstream-header mean time
changes21.582→18.895ms. These are instrumented observations, not a guaranteed
bound on server lock duration or performance acceptance. The original balanced
comparisons pass all four SQLite scenarios and three PostgreSQL scenarios;
PostgreSQL delayed JSON remains unmet. See
[the current results](pricing-performance.md#settlement-metadata-phase).

All owned verification instances stop. Production2099, its user-edited model
configuration and deployment remain untouched. Final platform/candidate work and
overall performance acceptance are still required.

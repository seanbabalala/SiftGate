# Owned dispatch and receipt reads

This checkpoint tightens request association and bounds repeated database work.
It does not change prices, budget policy, migration definitions or the production
Gateway. Overall HTTP performance acceptance remains unmet.

## Capture the dispatch owner before yielding

`beginAttempt` captures its input before availability checks or database
serialization can yield. Grouped dispatch first enforces its existing size bound
and then captures the dispatch entries. Nested target and price-context data are
part of that capture.

The request that acquires the parent fence therefore remains the request whose
attempt is written. Tests reproduce caller mutation both while the operation is
queued and after its request query starts. The original attempt ID, request,
reservation and price context now remain intact. These are defensive synthetic
tests, not evidence of a production incident or a remote exploit.

After acquiring the known request fence, dispatch reads the complete matching
reservation once, with its request/workspace predicates and PostgreSQL row lock.
That locked row remains owned throughout the transaction. It is not a cached row
from before waiting for the parent. A two-connection test holds the request fence,
verifies that dispatch has not acquired an eager child lock, changes the
reservation to terminal and confirms that the waiting dispatch rejects it.

The generic reservation/attempt lookup helpers retain their existing discovery,
parent-lock and fresh-child-read behavior for callers without a known owner.

## Bound receipt inspection under the existing request fence

Queueing and settlement already hold their reservation's request fence. Receipt
inspection now sorts distinct attempt IDs and reads them in chunks of at most128,
retaining PostgreSQL child row locks and explicit request, reservation and
workspace predicates. It does not rediscover the same parent for every receipt.

Each chunk reads complete rows. Only ID, state, cost hash and error code survive
in the result map; large stored cost/context bodies are not accumulated across
all chunks. All receipt IDs must be present in their expected association.

A synthetic corrupted association exposed a previous gap: a same-workspace
attempt attached to another request could pass queue-only receipt preflight if
its reservation ID still matched. It is now rejected before retaining an intent.
Application rechecks the association even when a valid intent was queued earlier.

The change preserves:

- the independently committed receipt and terminal-decision retention boundaries;
- fresh stored body, audit and operator-disposition validation;
- immutable terminal receipt checks and full historical cost validation, including
  cases where no call-log row exists yet;
- atomic acknowledgement, budget effects and intent application;
- original active-budget checks, exact arithmetic and post-commit observations;
- the existing unknown-cost, failure, retry and recovery behavior.

There is no cross-transaction ownership cache, early untracked provider call,
default-budget bypass or new migration.

## Regression evidence

Nineteen new cross-database assertions cover bounded reads, wrong request links,
late-chunk missing/foreign/mismatched receipts, valid-queue-then-corrupt-apply,
caller mutation and the real PostgreSQL parent wait. A130-receipt queue uses two
bounded child reads instead of per-receipt discovery and locking.

Four existing parameterized single-pass assertions now observe the actual batch
inspection helper rather than the no-longer-used individual lookup method. They
still require exactly one application-time inspection, not duplicate intent
preflight, and additionally verify the small returned metadata shape. Existing
fault injection, rollback, replay and acknowledgement checks remain intact.

The complete source passes **4,300 unit tests in205suites and807 HTTP tests in
65suites**, with no failures or skips. All4,281 prior unit assertion names and all
prior HTTP assertions remain present. Builds, lint, frontend contracts/build and
bundle limits, SDKs, configuration and static deployment checks pass. All18
migration checksums and dependency versions remain unchanged.

Initial red runs and the obsolete-observer failure are retained with their source
identities. A focused success is not substituted for the full regression.

## Performance boundary

A paired native PostgreSQL profile confirms110→105SQL statements per request,
with the same ten transactions, two independent retentions and fourteen retention
statements. However, mean post-upstream-header time changes from21.531ms to
22.183ms. This does **not** establish an end-to-end speedup.

The same traces show eleven statements between completion of the shared budget
row-lock query and transaction commit. The candidate's client-observed interval
averages3.260ms, with p95 of4.709ms. This client interval includes commit-response time; it is not a guaranteed bound
on server lock duration, an exclusive database-lock measurement or proof of the
sole bottleneck.
Request-ownership read reduction does not shorten that shared critical section.

The [original balanced comparisons](pricing-performance.md#owned-attempt-reads)
still fail three scenarios. All slower repetitions and near-threshold failures
remain included. The change is retained for verified request integrity and bounded
multi-receipt work, not declared performance-complete. Further work must address
the measured transaction path without weakening persistence or accounting.

All owned test instances are stopped after verification. Production2099 and the
user-edited model configuration remain unchanged. Nothing is committed, pushed,
containerized or deployed by this checkpoint.

# Historical pricing after log cleanup

Ordinary request/route log retention and immutable pricing evidence have different
lifetimes. Deleting an old `call_logs` row must not delete its price snapshot,
receipt, budget settlement, pending outcome or recovery case. This document
records the current application contract, not permission to clean a live database.

## What the application retains

The existing Dashboard maintenance worker removes old `call_logs` and
`route_decisions` in coordinated batches of up to500rows. Its configured
`database.log_retention_days` does not currently purge `pricing_*` evidence.
No price-version deletion endpoint or automatic historical-price pruning is
provided. Publishing a new price can compact the new active catalog manifest;
it does not rewrite older catalog revisions or remove the versions they reference.

As a result, the supported cleanup path retains pricing metadata longer than
ordinary logs. This deliberately keeps versions available for the costs that
reference them. It is **not a bounded retention policy for all pricing tables**:
request snapshots, receipts, exact balances, audits and recovery evidence still
consume storage. Plan capacity and independent backups. Do not assume that a
30-day request-log policy also removes30-day pricing records, or that moving to
PostgreSQL eliminates storage growth. A future purge/archive policy must preserve
reference closure, pending/review work and historical accounting semantics;
this checkpoint does not introduce or authorize one.

## What remains available without a call log

- A request-ID cost lookup returns the original stored amount and receipt evidence.
- The cost report enumerates retained request snapshots as well as legacy logs.
  A priced row whose log has expired has `log_id: null` and remains distinct from
  a missing receipt or a legacy estimate. Some metadata formerly available only
  from the log, such as `source_format`, can be absent; it is not invented.
- Restoring the original request snapshot resolves the original catalog and price,
  even through a fresh repository instance after newer prices have been published.
- Replay under another price is a separate simulation; it does not overwrite the
  original amount or its evidence. The HTTP response explicitly labels this.
- A URL keyed only by the deleted numeric log ID returns404. It is not a durable
  substitute for the request-ID cost/report endpoints.

Report totals cover **retained requests and legacy logs**, not an assertion that
all historical traffic is still present. Expired legacy-only logs have no new
receipt or pricing snapshot from which to reconstruct an amount. The report does
not fabricate those records or treat their absence as confirmed zero cost.

## Pending work and cleanup failure

Cleanup does not release a held budget, acknowledge an outcome or choose between
conflicting evidence. Durable retained outcomes and queued settlement intents can
still be replayed afterward, using their recorded prices and idempotency keys.
An unresolved dispatched request stays pending/reviewable instead of becoming
free simply because its ordinary log is gone.

Each cleanup batch is a transaction. A failure after a batch's delete rolls that
batch back. Previously committed batches are not a single all-or-nothing global
purge; their prior success is not undone. No pricing evidence is deleted by either
the successful or failed ordinary-log batch.

## Integrity and privileged database access

Snapshot-to-catalog, catalog ancestry/head and version-to-book relationships have
schema constraints. The catalog manifest references particular price versions
inside JSON; there is **not** a SQL foreign key for every such manifest reference.
The application does not expose physical deletion of published price versions.
Privileged SQL tools can still corrupt these relationships and are outside the
supported cleanup contract.

A cold historical restore detects a missing/tampered version and fails instead
of substituting today's price. A self-contained receipt can remain readable even
when its catalog has been corrupted; that does not certify that the catalog is
healthy or that replay is possible. The empty-schema removal operation also
refuses a nonempty pricing installation after its ordinary logs have been deleted.
An application downgrade is not a data rollback; use the separately reviewed
backup/compatibility procedure.

## Verified lifecycle

The same isolated SQLite WAL/PostgreSQL tests execute the actual Dashboard
cleanup method and prove:

1. After an old synthetic request is settled and a new price is published, cleanup
   removes only its aged call/route logs. All pricing and budget table contents
   remain identical, and a recent ordinary log survives.
2. Original quote/receipt/report values survive a cold service read. New admissions
   see the new price; another workspace cannot read the old request.
3. Retained outcomes, pending intents and unresolved holds survive cleanup. Replay
   settles the known outcomes once, leaves the orphan hold unchanged, and does not
   recreate deleted logs or call a model provider.
4. A deliberately failed delete batch rolls back without changing the evidence.
5. Empty-schema removal refuses live pricing evidence, and privileged deletion of
   a referenced version makes historical restore fail safely.

A separate real-Nest HTTP test verifies request-ID lookup, the old log-ID404,
price-version lookup, report output and labeled replay after actual cleanup.
The synthetic original amount is0.0012USD; the separate new-price simulation is
0.0024USD. These are fixture amounts, not vendor prices. No production retention
setting, database, process or watchdog is modified.

See [progress](pricing-engine-progress.md) for verification scope and remaining
full-Goal acceptance, and [Rancher rollout](pricing-rancher-rollout.md) for the
separately authorized deployment and rollback boundary.

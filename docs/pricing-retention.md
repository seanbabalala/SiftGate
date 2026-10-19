# Historical pricing after log cleanup

Ordinary request/route log retention and immutable pricing evidence have different
lifetimes. Deleting an old `call_logs` row must not delete its price snapshot,
receipt, budget settlement, pending outcome or recovery case. This document
records the current application contract, not permission to clean a live database.

## What the application retains

The existing Dashboard maintenance worker removes old `call_logs` and
`route_decisions` in coordinated batches of up to500rows. Its configured
`database.log_retention_days` does not purge `pricing_*` evidence.
No price-version deletion endpoint or automatic historical-price pruning is
provided. Publishing a new price can compact the new active catalog manifest;
it does not rewrite older catalog revisions or remove the versions they reference.

By default the supported cleanup path retains pricing metadata longer than
ordinary logs. This deliberately keeps versions available for the costs that
reference them. It is **not a bounded retention policy for all pricing tables**:
request snapshots, receipts, exact balances, audits and recovery evidence still
consume storage. Plan capacity and independent backups. Do not assume that a
30-day request-log policy also removes30-day pricing records, or that moving to
PostgreSQL eliminates storage growth.

## Optional purge of settled request evidence

`database.pricing_evidence_retention_days` (default `0`, keep forever) enables
a background worker that deletes the per-request evidence of requests settled
long enough ago. Ten minutes after startup and then every 30 minutes it
examines at most 2,000 requests created before the cutoff, oldest first, and
resumes where the previous run stopped. Each request is decided and deleted in
its own short transaction, so live traffic interleaves with the work.

A request is deleted only when all of the following hold:

- its snapshot is older than the cutoff;
- every hold is committed or released, every attempt is terminal, belongs to one
  of those holds and is not part of a batch, every hold has an applied settlement
  intent and every runtime outcome is delivered;
- nothing references it from recovery cases or decisions, actual-budget
  cohorts, media tasks, grouped outcomes, cost adjustments and their
  applications, outcome dispositions, batch manifests or a bypass audit.

Anything else is kept, untouched, and examined again on a later pass. A row the
checks do not cover that still references the request makes the database
refuse the delete; the transaction rolls back and the request counts as
blocked. A request whose evidence changes while it is examined is kept.

For a deleted request the worker removes its snapshot, holds, attempts, budget
effects, settlement intent, runtime outcomes and their audit markers. Budget
balances are stored totals and do not change; catalogs, price versions and
every other audit event stay. Afterward a request-ID cost lookup no longer
finds the request, the cost report no longer counts it, and its original price
can no longer be replayed. Choose the period accordingly; it is normally no
shorter than the request-log retention.

The worker relies on migration `pricing-engine-020` (see
[index migrations](pricing-index-migrations.md)). On a copy of one 2.7 GB SQLite
installation it removed 1,988 settled requests at 2.9 ms each, and the longest
event-loop block was 38 ms. Freed pages are reused by new writes; SQLite does
not shrink the file without a separately planned `VACUUM`.

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
6. With the evidence purge enabled, only an aged request settled through the
   real ledger flow loses its rows. Recent, reserved, undelivered,
   recovery-referenced, corrected and database-referenced requests keep every
   row, the foreign-key check stays clean, a repeated run deletes nothing, a run
   cut short by its limit resumes, and the worker does nothing unless the period
   is positive.

A separate real-Nest HTTP test verifies request-ID lookup, the old log-ID404,
price-version lookup, report output and labeled replay after actual cleanup.
The synthetic original amount is0.0012USD; the separate new-price simulation is
0.0024USD. These are fixture amounts, not vendor prices. No production retention
setting, database, process or watchdog is modified.

See [progress](pricing-engine-progress.md) for verification scope and remaining
full-Goal acceptance, and [Rancher rollout](pricing-rancher-rollout.md) for the
separately authorized deployment and rollback boundary.

# Retained runtime accounting outcomes

Status: undeployed development checkpoint, not full Goal acceptance. This extends
[outcome recovery](pricing-outcome-recovery.md); it does not replace immutable
attempt receipts, budget intents, batch coordination or asynchronous task owners.

## Why a separate durable boundary

A finalized response can be available while receipt or intent persistence fails.
The earlier bounded memory retry aid could retain only one body per identity. A
different incoming receipt was marked as a conflict but its body was lost; an
earlier in-flight writer could then remove the only buffered entry. Distinct
bodies now have separate workspace/type/subject/hash identities. Completing one
writer cannot erase another variant.

The internal runtime now retains each allowlisted outcome **before** delivering
it to the existing ledger writer. Explicit migration `pricing-engine-008` adds
`pricing_runtime_outcomes`; migrations `001`–`007` retain their frozen checksums.
Normal startup does not migrate, repair or overwrite a database. No production
database or running 2099 service was changed.

## Stored document and authority

Only the gateway's internal accounting runtime writes this inbox. There is no
HTTP ingestion endpoint, public supplier webhook or user-supplied money API.
A subsequent administrator-only [disposition workflow](pricing-outcome-disposition.md)
selects already-retained evidence with fresh review; it does not ingest new data.
`source: gateway_runtime` means an internal capture, **not** authenticated external
supplier evidence, an invoice or a claim that a charge is confirmed.

An outcome contains either a final attempt computation/error code or an immutable
proposed settlement body and its receipts, with workspace/reservation identity.
The complete normalized computation preserves exact quantity/rate/FX/version
evidence; it is never repriced from current configuration. Receipt hashes stay
unchanged. A strict nested allowlist rejects raw request/response/header fields,
reservation estimates, unsupported fields and non-finite numbers rather than
silently stripping them or converting them to missing/zero. Documents are bounded
to 4 MiB; the existing smaller memory-buffer limit remains separate.

Retention checks existing request, reservation and attempt ownership under the
ledger's request-first transaction order. Insertion and a mandatory retention
audit commit together. The audit binds the hash, source and scoped identity but
does not duplicate the computation. Delivery applies the captured immutable copy,
not the caller-owned object after an asynchronous wait.

## Lifecycle

| Inbox state | Meaning |
| --- | --- |
| `pending` | The durable body is retained but delivery to the original attempt or terminal-intent writer is not acknowledged. |
| `delivered` | That immutable receipt or intent accepted the exact body. This is **not** supplier confirmation and does not itself prove final budget application. |
| `review_required` | A differing variant, permanent conflict, dedicated batch/task ownership or integrity failure prevents automatic delivery. The body is preserved, not replaced. |

Receipt delivery still uses `completeAttempt`. The default `persistRuntimeOutcome`
settlement API and durable inbox replay still use `queueSettlement`, followed by
the existing idempotent budget-intent replay. Ordinary logical runtime settlements
use the explicit composed path described below. No new calculator, provider call
or successful-response retry is introduced. A crash
after retention but before delivery can recover from the inbox. A lost delivery
acknowledgement replays the exact body without another debit. State changes have
mandatory audits and cannot regress delivered work or clear a durable quarantine
because an older writer finished late.

A distinct variant for an existing subject is quarantined, not chosen as a new
winner. A previously pending first variant may still finish its original
delivery; this does not erase the later variant. Standalone physical batch shares,
allocation failures and asynchronous ownership stay with their dedicated
lifecycle; this inbox does not turn them into independent member settlements.
An administrator estimate does not discard differing retained runtime evidence.
Retiring a superseded buffered budget proposal first archives its body, including
any receipts it carries.

The maintenance path retries due pending bodies in bounded batches with backoff.
It verifies hashes and audits, never generates model work or adopts today's
prices. Corrupt pending bodies are preserved and moved out of automatic replay
with an integrity observation; their detail read still fails verification rather
than presenting them as trusted. A failed observation write leaves the original
body untouched. In-memory review entries are removed only after an affirmative
durable scoped archive acknowledgement. Archive failure keeps the memory copy.

The current safety bound blocks a new priced reservation when its workspace has
1,000 undisposed inbox rows (`pending` or `review_required`, excluding matching
audited dispositions after 009). This complements
memory backpressure and still allows already-dispatched work to attempt retention.
It is not a hard disk quota: retention, operator disposition and measured
performance remain required before product acceptance.

## Stream completion and delivery

For HTTP streams, `prepareStreamReceipt` commits the allowlisted immutable
receipt and retention audit before normal HTTP completion. It then hands a
tracked, idempotent delivery callback to the request runtime. Delivery still uses
the same receipt/acknowledgement transaction and conflict checks; it is not a
detached background task. HTTP completion does not mean the budget is settled.

Every pending callback is drained before settlement, another dispatch on that
group, or request teardown. Concurrent same-group receipts cannot overwrite one
another. Actual-expense finality fences new dispatch before waiting for in-flight
work and then drains every retained receipt. If retention finishes after its
owning action returned, delivery runs inline instead of entering an abandoned
queue. Active in-flight work keeps its lease until it finishes.
Finishing one concurrent stream also cannot remove the lease while another
same-group receipt is still in the tracked delivery queue. Both conditions must
be clear before that lease is retired.

A process exit between retention and delivery leaves replayable evidence. Receipt
recovery alone cannot fabricate a lost settlement decision or dispatch finality;
the original reservation stays unresolved without that authority. A retention
failure uses the existing bounded accounting retry/orphan path, not provider
redispatch or a zero-cost fallback. The durability guarantee applies when
retention succeeds; a total storage outage cannot promise a persisted receipt.

The shutdown owner drains tracked request work before database disposal, including
delivery after an SSE response has ended. See [shutdown ordering](pricing-shutdown.md).

## Composed logical settlement candidate

`persistAndApplyRuntimeSettlement` keeps the independent retention transaction:
the immutable body and mandatory retention audit commit before application starts.
Its next transaction queues one logical settlement intent, acknowledges the exact
retained body, applies the budget effect and marks the intent applied. Delivery
acknowledgement is checked before acquiring shared budget locks, but commits
together with application. It cannot clear quarantine or an operator disposition.

A failure before or after budget writes rolls back that second transaction,
including a newly inserted intent and delivery audit. The first retained body
survives for replay; the original hold is not silently released. A lost commit
acknowledgement may mean the transaction actually committed, so retries must still
verify immutable evidence and deduplicate effects. A successful composed call
guarantees application; a generic `delivered` inbox marker still does **not**.
Old queue-only callers and older delivered-but-pending intents remain compatible.

Ordinary logical and local-cache runtime paths use this method without a second
public `applySettlement` call. Local-cache supplier cost remains zero while the
explicit legacy logical budget convention is preserved. Actual-upstream closure,
batch groups, asynchronous task ownership and Realtime keep their dedicated paths.
There is no global transaction coalescing or cross-request retention batching.

The candidate has 38 SQLite/PostgreSQL tests, including independent retention
visibility, partial-write rollback, audit failure, actual child-process exits,
commit-acknowledgement loss, duplicates, caller mutation, quarantine/disposition
fences and dedicated-owner exclusions. The unchanged runtime also passed a broader
586-test ledger/recovery selection; 132 HTTP regressions verify successful replies,
exact accounting, cache behavior and recovery without provider redispatch.
These are scoped checks, not a new complete regression or final acceptance.
The [performance targets remain open](pricing-performance.md).

## Composed receipt validation

The synchronous composed path now defers its duplicated stored-receipt preflight
until the application step in the **same owned transaction**. Proposal shape,
quantities, budget-basis authorization and immutable terminal-state checks still
run before writing the provisional intent. The application then reads current
attempt ownership and terminal evidence, verifies retained receipt provenance
and mandatory audits, and applies the existing budget/log projection. The intent
cannot commit separately from that validation and application.

If an attempt is missing, foreign or inconsistent, the provisional intent,
delivery acknowledgement and monetary writes roll back together. Independently
retained outcome bodies remain available for recovery or review. This is not a
cross-transaction validation cache, early HTTP return, asynchronous debit policy
or removal of durable retention. There are still ten transactions and two
independent outcome retentions in the profiled ordinary request path.

Queue-only callers retain their stored-receipt preflight **before** committing
an unapplied intent. Shared batch, actual-expense and administrative callers keep
their existing authorization and application paths. Sixteen new SQLite/PostgreSQL
cases verify single application-stage inspection, intact queue-only rejection,
and revalidation of missing/foreign/changed attempts after provisional storage.
Existing concurrent replay, child-exit, audit-failure, lost-acknowledgement and
post-budget rollback cases remain in the full regression.

Four HTTP fault-injection fixtures now target the common intent-storage helper
so their original outage/recovery assertions still exercise a real failure. The
initial run with obsolete helper hooks failed and is retained; those failures
are not hidden by removing assertions or relabeling a run as passing. Full
regression passes 4,126 unit and 750 HTTP tests with no failures or skips. The
[HTTP performance gate remains unmet](pricing-performance.md#composed-receipt-preflight).

## Bounded joint acknowledgement reads

Within a joint settlement transaction, up to128 exact retained attempt rows and
the settlement row share one fresh ownership/body/audit read set. The helper
requires an active transaction, distinct identities and a single reservation,
request and workspace. It locks the request and validates the union of referenced
attempt identities; only exact outcome IDs and their three possible audit IDs
are read. No result is reused across transactions or cached for a later request.

Every current body and retention/transition audit is verified before any
acknowledgement write. Already delivered rows still require valid audits;
quarantined rows, missing evidence, identity changes and foreign ownership cannot
be acknowledged. Individual audit insertions and row updates remain atomic with
all receipt, budget, effect, intent and log writes. A late failure rolls back the
whole transaction while both separately retained original bodies survive.

Longer receipt sets are processed in bounded chunks in that same transaction;
the new helper accepts at most129 rows. Existing non-joint transitions and
queue-only callers retain their separate behavior. This does not merge initial
retention commits, authorize unreviewed outcomes, or infer a final fee from an
acknowledgement marker alone.

## Read-only operator APIs

Both endpoints use existing Dashboard authentication, workspace scope and
operator/admin permissions. Viewers are denied. GETs do not trigger delivery,
correction, model calls, pricing changes or budget effects.

- `GET /api/dashboard/pricing/runtime-outcomes?state=review_required&limit=20`
  returns metadata only. States are `pending`, `delivered`, `review_required`;
  limits are 1–50. The cursor is bound to workspace/state and uses immutable
  creation time plus ID. No duplicated outcome JSON appears in the listing.
- `GET /api/dashboard/pricing/runtime-outcomes/:id` verifies the document,
  retention and transition audit before returning the allowlisted outcome with
  `read_only: true` and `supplier_confirmed: false`. Wrong workspace returns 404;
  corrupt evidence cannot be acknowledged as valid.

These APIs expose **retained runtime outcomes**, not all traffic and not a cost
report. Do not sum every variant as an additional charge. The original ledger's
effective receipt and explicit budget decisions remain monetary authority.

## Verification and remaining boundary

The buffer regressions cover differing-arrival/in-flight races, separate archival,
negative acknowledgement and conflicting overflow without replacement writes.
Cross-database contracts cover retention/audit rollback, immutable delivery,
independent PostgreSQL connections, malformed documents, original-price replay,
manual-estimate conflicts, batch/task exclusions, scoped read-only pagination,
lost acknowledgement and an actual child exit after retention before delivery.
Actual HTTP tests use mocked upstreams and prove response privacy, no extra model
calls, recovery without the original memory buffer and Dashboard permissions.

This is a durable **post-retention** recovery boundary, not a complete pre-durable
disk spool. If the process dies before any durable write succeeds, memory-only
evidence can still be lost and the surviving dispatch remains unknown. A finite
buffer also cannot guarantee retention of arbitrary oversized outcomes while
storage is unavailable. Neither case may be reported as known zero cost.

Still required for the full Goal: trusted supplier adapters; full group/task selection coverage and remaining supplier lifecycle;
the independent-receipt selection backend and seven-language UI are implemented;
complete group/task inbox coverage; older-writer/resumed-owner fencing; the full
pre-durable-loss strategy; retention/index/performance and remaining database
writers; coverage reports, source/parent governance, Linux/Docker and fixed-source
candidate acceptance. A successful inbox replay is not whole-Goal completion.

## Subsequent 009 disposition

A separate immutable audited decision now supports administrator acceptance of
complete independent receipts or rejection with custody retained. The old inbox
state and body stay unchanged; inventory shows a separate decision. Delayed
current-runtime delivery is fenced and the original budget proposal is not
automatically applied. See [outcome disposition](pricing-outcome-disposition.md)
for exact preview, atomicity, acknowledgement and outstanding UI/group/lifecycle
boundaries. This is not supplier authentication or complete Goal acceptance.

## Subsequent complete-group inbox010

Physical embedding outcomes and undispatched cancellation cohorts now have a
[separate group inbox](pricing-group-outcomes.md), preserving full conservation
and phase-aware terminal proposals. Independent inbox008/disposition009 are not
repurposed into per-share adoption. Group disposition/UI, async media ownership,
trusted supplier events and full pre-durable/capacity acceptance remain open.

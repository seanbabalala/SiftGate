# Pricing engine implementation decisions

Status: implementation authorized on 2026-09-25. Deployment is not authorized.
Scope and acceptance authority: [Goal Spec](pricing-engine-goal-spec.md).

## ADR-001 — Isolation and rollout

The implementation starts from deployed source `b61d8f48`, not the older main
checkout. Dependencies, build output, temporary databases, configuration and
test ports are separate from the active service. No live configuration or
database migration runs as part of development. Dependency lifecycle scripts
are disabled during installation; a required native build is reviewed and run
explicitly in isolation using the deployed Node major and ABI.

New pricing code first lands as an independently tested domain module. Existing
traffic continues to use its existing behavior until an administrator activates
a validated binding after an independently approved deployment. The new engine
must never turn absent prices into zero or silently change legacy budgets.

## ADR-002 — Layers and ownership

```text
Protocol adapters / task results
             |
       Usage normalizer
             |
Request catalog snapshot ---- immutable bindings / calendar / FX references
             |
       Compiled rule resolver
             |
       Pure cost calculator <---- Dashboard quote / historical replay
             |
       Settlement transaction / recoverable outbox
             |
       Budget projection + immutable cost records
             |
       Logs / reporting / Dashboard details
```

The normalizer and calculator have no NestJS lifecycle hooks, filesystem access,
network access or database side effects. They can run against synthetic evidence
without loading application configuration. Protocol adapters remain responsible
for vendor-specific inclusion rules and for distinguishing missing counters
from counters that a documented protocol defines as zero when absent.

## ADR-003 — Quantities and exact arithmetic

External prices and quantities are decimal strings. Internal operations use
reduced BigInt fractions. Parsing permits at most 30 integral and 18 fractional
digits; exponent notation, non-finite values and unsafe numeric integers are
rejected. Legacy numeric prices have an explicit conversion adapter, not a
general-purpose `Number()` path in the new API.

Token and count quantities are integral. Durations are decimal seconds. Rates
carry the same canonical unit and an explicit unit size (for example, 60 seconds
or 1,000,000 tokens). Quantity rounding/minimums are separate from amount
rounding. Exact intermediate fractions are retained and added before rounding
the final settlement; the initial default is nine decimal currency places and
half-even rounding. An explicit rounding adjustment reconciles displayed lines
to their total. Different currencies are never implicitly added.

The ordinary input dimension means **uncached input only**. Total input is
metadata used for context thresholds, not another billable component. Cache
write totals are decomposed into 5m, 1h and unknown-TTL remainder. Output reasoning
is a subset of output, not a second billable output total. Input/output modality
partitions cannot be charged alongside their parent total.

## ADR-004 — Billing basis and rule composition

A price book declares an explicit billing basis: the dimensions that make up
its cost. Ancillary counters do not implicitly create fees. A pure image book
does not require fictional token prices. Incompatible billing bases use separate
book bindings; an intentional additive media basis must be declared explicitly.

Groups have unique numeric execution order. Within a group, matching rules are
exclusive and the greatest priority wins. Ambiguous equal-priority rules are
rejected at publication rather than relying on array order. A selected rule may
replace a dimension's rates, explicitly add a component, and then apply explicit
dimension multipliers. A missing required group is unpriced. The first supported
context mode is whole-request; graduated mode is rejected until independently
implemented and verified.

Conditions use an allowlist: total-input integer ranges, resolved service tier,
explicit media attributes and versioned calendar tags. Exact time handling and
calendar validation belong to the compiler/resolver, never to the calculator.
Dates use half-open intervals. No GPT-name heuristic or hard-coded universal
272k policy is allowed; numeric fixtures are synthetic.

## ADR-005 — Snapshot boundaries and provenance

Each admitted request holds a catalog revision containing immutable bindings,
price, FX and calendar references. Retries and fallback resolve the actual node
inside that same revision. A later activation cannot alter an in-flight request.
Attempt dispatch timestamps may differ, so their time-window match may differ
within the frozen versions. Async tasks persist those references before dispatch.

Manual and approved catalog rates can be priced; unapproved reference rates are
estimates and cannot become active production bindings without approval. Legacy
rates retain legacy-estimate provenance. The calculator records observed versus
estimated usage independently of price source. Computed costs do not imply a
supplier invoice was reconciled.

## ADR-006 — Persistence and compatibility boundaries

New price versions, bindings, reservations and settlement details use additive
tables, workspace-scoped authorization and immutable JSON documents with schema
validation and content hashes. Production schema changes use explicit migration
commands, not application-startup synchronization. SQLite remains supported;
cross-instance strict budget guarantees require the existing shared transaction
storage path and database-specific concurrency tests.

Old numeric cost columns remain compatibility projections. Historical rows are
not recomputed in read APIs. Cache hits can have zero upstream cost while still
consuming the existing logical budget. New cost snapshots must not silently
replace that policy. A final settlement is idempotent; better later evidence
creates a linked adjustment rather than overwriting the original record.

## ADR-007 — Calendar and media semantics

Calendars use named IANA zones and absolute timestamps with explicit offsets.
The civil coverage interval is half-open and bounded to ten years. Weekdays use
Monday=1 through Sunday=7. Window endpoints are minute boundaries; 24:00 is an
allowed end only, and 00:00–24:00 is the explicit full-day representation.

Cross-midnight windows belong to their start date. An explicit date plan replaces
that entire local day, including incoming carry from the same or lower layer.
Otherwise an exception's carry overlays only the carried interval of the next
day. Explicit-date carry can override a lower-priority holiday; holiday carry is
suppressed when its start date was replaced by an explicit-date plan. Replacing
a start date also cancels its ordinary weekly carry. Uncovered portions of an
explicit day use the configured default tag, not an implicit weekday fallback.

The local time, UTC offset, anchor date, chosen tag, calendar hash and timezone
database version are captured in the selection trace. A runtime with different
timezone data produces an unavailable-calendar diagnostic rather than claiming
an exact historical replay. Civil preview rows are not promises that every
minute exists during a DST transition. Continuous session interval splitting
remains a separately unsupported mode, not an implicit side effect.

Media predicates allow only operation, size, width, height, quality, resolution,
frame rate, audio track, audio direction and generation count. Values are
canonical strings. Missing/unknown required variant attributes cannot fall
through to a cheap unconditional rate. Every evaluated rule records match and
rejection reasons. Estimated selector evidence also marks the resulting price
as estimated even when the billed quantities themselves were observed.

## ADR-008 — Catalog identity and effective binding view

A request descriptor stores a catalog revision/hash, admission timestamp,
workspace and report currency. It references a compiled revision, avoiding a
full catalog copy for every request. The descriptor hash identifies pricing
context, not a unique request or an authorization credential. Restoring it must
use a workspace identity obtained from trusted authorization, not its own body.

Bindings are selected at admission time, including scheduled activations. Within
the workspace's effective view, workspace-specific bindings override global
defaults; within each scope the order is node, model, approved catalog, legacy.
Operation-specific bindings outrank generic operation bindings at the same
level. Equal-rank overlapping activation intervals are rejected. This policy is
not yet activated for any existing traffic.

Retries select the actual target node inside the same revision and admission
epoch. Dispatch/completion time can still choose a different time-window rule
inside the fixed price version. Price/FX identities and book ownership cannot
be reused for changed content. Rollback creates a new catalog activation; it
does not rewrite older descriptors. A missing historical revision must be
loaded from persistence, never replaced by the latest catalog.

## ADR-009 — Explicit pricing schema boundary

The initial schema adds eight isolated pricing tables: migration marker, books,
drafts, immutable book versions, catalog revisions, catalog head, audit events
and request snapshots. Price bodies are stored once per immutable book version;
catalog manifests reference those bodies. The repository and administrative API
now implement publication/context persistence; the existence of those tables is
not a claim that actual request settlement or budget outbox recovery is operational.

No application module invokes the migration automatically. Inspection is
read-only, apply is transactional and idempotent, and conflicting/partial schemas
are rejected rather than repaired destructively. Removing an unused schema is
supported for isolated downgrade rehearsal; any real pricing or audit/snapshot
data prevents that operation. Production migration/backup approval remains a
separate gate. Settlement/outbox tables will be added by explicit subsequent
schema steps when their transaction contract is finalized.

## ADR-010 — Repository, publication and administrative boundary

The candidate now exposes authenticated pricing administration. Normal startup
still performs no pricing migration; initialization requires the explicit CLI.
The repository stores price bodies once per immutable version, keeps manifests
as references, checks hashes/ownership while hydrating, and batches version
lookups instead of querying separately for every model. New manifests discard expired
bindings and unreferenced bodies without deleting any historical SQL records.

Publication, optimistic head/draft checks, version insertion and pricing audit
are one transaction. An audit failure rolls back the whole change. PostgreSQL
admission shares the catalog-head row until request context is persisted, so
publication cannot cross that admission point. SQLite pricing operations share
a process-local DataSource queue; integration with existing budget writers and
cross-process limitations remain explicit M3 work.

Administrative queries and mutations are scoped to the authenticated workspace;
global edits additionally verify default-workspace administration. The internal
catalog is a system resource, never returned as an unfiltered user listing.
Request bodies cannot supply roles/owners. JSON-only writes and explicit trusted
origins complement existing Dashboard sessions/RBAC. Denials are recorded in the
existing management audit, while pricing transaction audit remains atomic.

Read-only simulation never calls providers, changes budgets or publishes. A
published version is immutable; rollback creates new version/activation records.
Only future activations can be cancelled, and overlapping future schedules must
be cancelled explicitly instead of silently displaced.

The backend workflow is documented in [pricing management API](pricing-management-api.md).

## ADR-011 — Candidate token runtime and budget ledger

The token candidate now captures a request-scoped catalog using AsyncLocalStorage.
Routing estimates, target-group reservations and final attempt receipts resolve
against that frozen catalog and a pricing-only snapshot of the legacy config.
Publication during dispatch cannot replace the in-flight version. Advanced pricing
is currently gated on the explicit ledger migration and workspace bindings; media
and rerank still retain their legacy runtime path.

Migration `pricing-engine-002` adds exact budget shadows, reservations, effects,
attempt receipts and an adjustment table without modifying the `001` checksum.
An explicit populated `001` to `002` rehearsal passes on both databases. The
PostgreSQL schema inspector reads actual index key ordinality from `pg_catalog`:
the pinned ORM inspector does not preserve multi-column index order. Reversed
workspace indexes are detected, not accepted merely because they have the same
column set.

Budget shadows use decimal strings while existing `real` columns remain numeric
compatibility projections. All applicable active rule scopes, including inactive
reservation holds, are locked in one ascending rule-ID order on PostgreSQL.
Idempotent reservation/dispatch creation locks the persisted request row before
checking for an existing identity. Changed identity, target or receipt content
cannot reuse an existing operation. The SQLite pricing and central budget paths
share a DataSource queue; completing the audit of all unrelated legacy/admin
writers is still required before making a whole-application serialization claim.

Hold release is scoped to the original budget period. Manual reset creates a new
ledger epoch even within the same civil day, preventing old holds from subtracting
new usage. Exact balances drive limit and alert-state comparisons, including amounts
that the compatibility float has rounded up to the limit. Converting old numeric
inputs uses the shortest decimal preserving the JS numeric value, not `toFixed`
binary artifacts.

An attempt receipt and final budget effect can be repaired atomically in one
settlement transaction. Duplicate terminal settlement is read-only and conflicting
terminal evidence is rejected. A provider success is not retried because receipt
or budget persistence failed. At that initial checkpoint, leases and an adjustment table alone were **not a
crash-recovery guarantee**. ADR-013 below adds durable terminal intents and renewal;
ambiguous dispatch recovery and linked corrections remain required M3/M4 work.

## ADR-012 — Evidence, streams and historical presentation

Billing evidence is attached to canonical TokenUsage through a private WeakMap;
it is not added to `/v1` response JSON. Raw decimal-string counters are retained
exactly, including counters beyond JavaScript's safe numeric range. Invalid raw
values are diagnosed rather than replaced by the compatibility parser's fallback
zero. Partial custom sums are unknown, observed zero is not overwritten, cache
TTL is not invented, and absent cache attribution is explicitly estimated.

Chat, Responses, Messages and Gemini stream parsers expose private final usage
metadata. Cumulative reports replace earlier counters rather than being summed.
Messages combines the start input/cache evidence with cumulative output deltas;
both cache-write TTLs survive. The provider wrapper carries a late final report
back to the existing stop usage object without emitting an extra client-visible
stop frame. Missing `[DONE]` usage is missing evidence, not observed free usage.
The cost runtime uses final normalized token counts for the exact budget effect.

Ledger summaries distinguish known subtotal, incomplete total and the compatible
logical budget. Local-cache requests have explicit zero upstream fees while their
logical token budget remains separately charged. Historical read APIs no longer
recompute stored log values from current model prices. New cost-breakdown and
metadata-only replay APIs are workspace-scoped; replay neither calls a provider
nor modifies receipts or budgets. Legacy rows remain labelled `legacy_estimate`.
At that checkpoint, list/report enrichment and late-attempt projections were
unfinished. ADR-014 adds transactional late-receipt projections; broader report
coverage/status work remains. A numeric `cost_usd` alone never proves complete pricing.

## ADR-013 — Durable settlement intent and recovery fencing

Migration `pricing-engine-003` adds `pricing_settlement_intents`; it does not edit
`001`/`002` definitions or checksums. Inspection rejects surviving markers whose
tables are missing. Populated `002` exact balances survive the explicit upgrade.
No migration runs on application startup.

Settlement has two durable boundaries. First, a scoped, immutable terminal intent
records the outcome, canonical decimal quantities, budget basis and optional final
receipt. Second, one transaction repairs that receipt, releases the original hold,
applies the budget effect and marks the intent applied. Payload hashes fence
changed outcomes; duplicate application has no additional budget effect. The
transaction uses reservation → intent/attempt → ascending budget-rule locks.
No recovery operation consults current model prices or calls a provider.

The candidate recovery service runs at initialization and every 30 seconds, only
when the explicit schema is available. It renews local in-flight leases, replays
up to 100 pending intents, then examines up to 100 expired undispatched holds.
Runs cannot overlap within a process and application shutdown clears its timer
and waits for an in-flight pass. Transient storage failures use bounded retry
backoff (1 second through 60 seconds); persisted errors contain stable codes, not
provider/database error payloads. Immutable-evidence conflicts become
`review_required` rather than being overwritten or retried indefinitely.

A durable terminal intent fences new dispatch and lease renewal. A lease can only
be extended by its current owner and cannot be shortened; async job identity is
immutable once attached. Recovery rechecks expiry, absence of dispatch/intent and
absence of an async job while holding the reservation lock. Only this proven
undispatched synchronous case receives a `recovery_no_dispatch` release. A
concurrent first dispatch either wins the lock or is rejected after reclamation;
it cannot proceed with a reclaimed hold.

This is deliberately **not** a claim that every orphan is recoverable yet. An
already-dispatched request with no durable terminal decision may have incurred
upstream cost. It remains unresolved, not automatically free. Async jobs are
excluded from generic reclamation and still need the M4 state machine, durable
provider job linkage, cancellation/result recovery and linked corrections.
Failure before the first durable terminal write cannot be represented as a
successfully queued intent. Those remaining gaps must be closed before release.

BudgetService reads the existing `002` marker and exact-balance table before its
legacy initialization writes, even when the newer recovery migration is not yet
applied. Config budget synchronization uses the same serialized transaction and
PostgreSQL lock order as consumption. A service-reinitialization test preserves
sub-float increments; concurrent config synchronization and ledger usage no longer
replace each other's counters. This does not complete the separate audit of
unrelated legacy/admin writers or post-commit threshold notification delivery.

Verification includes an isolated child process exiting immediately after durable
intent commit (SQLite WAL and PostgreSQL), concurrent replayers, transaction
rollback/receipt repair, retry backoff, hash-conflict quarantine, missing-schema
startup, timer shutdown, lease fencing, dispatch-versus-reclamation races, and
actual HTTP requests that recover budget application without repeating a provider
call. Only isolated processes and databases are used for these failure cases.

## ADR-014 — Append-only usage corrections and log projections

Explicit migration `pricing-engine-004` adds adjustment-application metadata; the
`001`–`003` checksums stay unchanged. A populated `003` terminal outbox survives
the upgrade and still replays. No startup schema synchronization creates pricing
tables.

Trusted metering/reconciliation callers can append an adjustment to a terminal
receipt after its original reservation is settled. There is no arbitrary HTTP
endpoint for changing computed costs. An adjustment supplies a stable idempotency
ID, expected effective cost hash, actor/source and reason, plus a computation from
the frozen request context. A known original price/FX identity cannot be replaced
with the current price. The original attempt and terminal intent remain immutable.
Unique per-attempt revisions, chained hashes and an application hash protect the
cost and budget metadata. Concurrent different corrections to one prior hash
cannot fork the history; duplicate IDs with identical evidence have no extra effect.

The effective request cost uses the newest linked receipt for each attempt, while
`cost` still exposes the original receipt and `effective_cost`/`adjustments` expose
its corrections. Replay uses effective usage and separately includes the initial
receipt. Missing revised usage/FX is unknown, never a fabricated zero.

Budget corrections apply only when the original committed terminal intent identifies
the corrected attempt as its logical-budget basis. Released or other-attempt costs
can increase upstream totals without changing that compatible logical budget.
Unknown original attribution or an unavailable report amount leaves a pending
budget correction, not an invented debit/refund. Later known evidence computes
its difference from the last applied budget amount (or the original charged
estimate), not from zero. Media-only corrections without token evidence preserve
the original token amount and explicitly report a cost-only application.

Signed differences apply to the original committed rule scopes and epochs. A new
day/manual reset must never receive a refund for old usage. Old-epoch corrections
update retained exact balances without changing the current rule projection.
Underflow or a missing original allocation aborts the transaction instead of
clamping away an accounting discrepancy. Cost revision, exact budget change,
application metadata, pricing audit and existing-log projection share a transaction;
audit failure rolls everything back.

All reservation/attempt writes acquire their persisted request fence before
reservation/attempt/budget locks. New and write-behind log persistence obtains the
same request fence and calculates its projection inside the transaction. Late
first receipts and linked corrections update existing `cost_usd` projections
from retained ledger evidence, never current model prices. This closes the race
where a stale queued log could overwrite a late cost. Legacy logs without new
ledger evidence keep their stored estimates. The scalar column still represents
only a known subtotal when the request contains unknown attempts.

The tests cover SQLite and PostgreSQL exact deltas, duplicate/concurrent writers,
unknown-to-known evidence, old-period refunds, audit rollback, corrupted application
metadata and a populated outbox upgrade. Isolated HTTP tests verify original versus
effective receipts, publication of a newer price during historical correction,
late simulated fallback receipts, stale queued logs and effective-usage replay.
Those simulated late-receipt cases are not a claim that all real timeout-race,
credential retry, batch or async-media adapters have been integrated yet. These
remain required before release, along with report status/coverage and frontend UI.

## ADR-015 — Synchronous media evidence and async submission barrier

Image generation/edit/variation, transcription/translation/speech and rerank now
use request-frozen pricing on the real candidate pipeline. Quantity estimates also
feed the media/rerank/embedding auto-ranking paths. Operation-specific bindings use
source-format names, and actual metering is independent of legacy TokenUsage fields.

Requested and actual dimensions are separate. Successful image outputs, reported
seconds, supported PCM header duration, explicit input characters and provider
rerank search units have named evidence sources. Missing actual units do not inherit
request estimates silently. Top-n results are not processed-document count, and
search units are never pricing tokens. Required unknown variants remain unpriced.
The supported shapes, limits and synthetic examples are described in
[media metering](pricing-media-metering.md).

An unrelated chat book cannot activate media traffic. Legacy logical budget fallback
uses the frozen legacy formula and final logical usage, not the multiplied retry
allowance. This integration exposed a legacy JS micro-cost whose shortest float
representation exceeded the decimal parser's 18 fractional digits. Only that legacy
numeric bridge now rounds the excess precision; valid short decimals and all new
exact decimal-string prices/calculator outputs keep their existing semantics. Both
storage backends verify the bridge instead of allowing a valid legacy request to
fail with an accounting 500.

A recognized accepted async media submission remains a dispatched/pending attempt
with a reserved budget hold and safe job identity. It is not a final receipt, does
not cause a provider retry and cannot be automatically released by a synchronous
request cleanup. Full asynchronous image/video lifecycle integration is still
unfinished. In particular, the existing VideoController requires scoped job lookup,
identity/credential binding, confirmed terminal/cancellation semantics, sanitized
errors and transactional lifecycle settlement before new video pricing is activated.

## ADR-016 — Durable task observations and pinned media controls

Explicit migration `005` adds hashed submission claims, minimal image/video task
footprints and normalized observations. Older schema checksums are unchanged.
Attempt/task insertion and idempotency-owner verification share a transaction.
No production database is migrated by startup or by this development work.

New task-enabled image/video generation uses one paid attempt. A lost response is
uncertain, not permission to retry another credential or fallback model. Request
idempotency is owner/namespace/operation scoped. Replays are explicitly metadata
only; this does not silently introduce prompt/output storage for synchronous images.

The task fixes its catalog, quantities, logical credential and node connection
fingerprint. Observations contain allowlisted quantities/context only. Terminal
processing persists the chosen computation/action before applying the existing
settlement outbox, and marks processing afterward. Hash validation and the ledger's
idempotent operations permit replay across both boundaries. New usage creates a
linked adjustment with an observation-derived idempotency ID. Repeated polling
cannot repeatedly debit the same usage. A legitimate later correction may return
to an earlier amount; deduplication is not a permanent prohibition on that amount.

Polling leases and task revisions prevent overlapping old responses from replacing
new evidence. Control deadlines include body reads and shutdown cancellation;
content streams rather than accumulating a whole video in memory. Credential
selection is pinned, with the same supported auth conventions as generation.
No redirect follows a credential-bearing request. Changed connection configuration
or a missing credential requires explicit reconciliation instead of guessing.

Cancel acknowledgements preserve pending holds until provider-confirmed terminal
status. Failed/cancelled status alone never proves zero cost. Explicit measured zero,
partial usage and unavailable usage retain distinct financial meanings. Download
failure does not refund generation. API-key owners see scoped job metadata/totals;
immutable detailed receipts remain under Dashboard permissions. Legacy video
lookups now scope workspace/key/namespace first, errors are generic codes, and
legacy rows without credential evidence cannot guess among a current pool.

SQLite WAL and PostgreSQL tests cover duplicate/concurrent settlement, corrections,
claim takeover, ownership, poll fencing, corrupted evidence, populated `004` upgrade,
a child process exiting after terminal preparation, and recovery after financial
commit but before the processed marker. Isolated HTTP tests cover exact/rounded
video costs, pending/cancelled/partial usage, content failure, idempotent clients,
async images and frozen prices published while a task is pending.

This is a polling integration, not a completed universal supplier callback system.
Out-of-order callbacks require verified event identities/versions; no unauthenticated
callback route exists. Unknown submission identities, failures before durable
observation, lifecycle retention, operator reconciliation UI, strict reservation
bounds and the final Goal acceptance remain explicit work, not hidden guarantees.

## ADR-017 — Explicit admission modes and conditional reservation envelopes

Admission policies are optional, scoped members of immutable catalog revisions.
Old documents keep the field absent and retain their original hashes. Updating a
policy requires administrator scope, catalog CAS, confirmation, a reason and an
atomic audit record. Price publication does not drop policies. Request capture
freezes policy with prices/FX; later policy changes do not alter an in-flight hold.

Compatibility remains the default. `reject_unpriced` requires a usable approved
binding but still reserves an estimate. `reserve_upper_bound` additionally requires
bounded billed quantities and computes a conservative rate envelope. Neither strict
mode silently substitutes a legacy price or missing FX, and denial occurs before
provider dispatch, including before streaming response headers. Proposal preview
uses the same assessment without persistence or activation.

The envelope propagates nonnegative per-dimension cost maxima through possible
replace/add/multiply rule paths using the shared actual component calculator.
Unreachable input tiers are removed with per-attempt limits, while time/service/media
alternatives are not assumed to remain cheap. Currency conversion uses the frozen FX
rational with outward rounding. Independent dimension envelopes may over-reserve;
this is an upper bound under the declared domain, not a claim of optimality.

Quantities come from exact request-billed metadata, single-invocation semantics or
explicit administrator-declared supplier limits (including derived parent limits).
A tokenizer heuristic, requested image count or requested duration cannot silently
become a cap on actual provider output. The guarantee is explicitly conditional on
the approved limits and tariff domain. Provider contract/adapter validity is not
proved merely by entering a number. Unintegrated endpoints cannot be explicitly
configured as if their admission path were already supported.

Retry multiplication follows rate evaluation. Configured credential attempts are
included in strict allowances and capped in the provider client even if a pool grows
after reservation. This does not replace the remaining full credential-attempt and
batch receipt-attribution work. Known actual costs above the hold still settle;
read APIs expose known cost excess and observed quantity-limit excess separately.
No budget guarantee is fabricated from missing usage or missing logical media tokens.

The API, mathematical assumptions, synthetic tests and remaining boundaries are
specified in [pricing admission policy](pricing-admission-policy.md). Whole-Goal
acceptance, seven-language frontend and post-commit notifications remain open.

## ADR-018 — Shared Dashboard pricing contracts and non-destructive editing

The candidate adds a lazy pricing route using the existing Forest Console design.
The six editor areas expose string rates, explicit free values, rules, calendars,
media dimensions, simulation, versions and publication. Shared server contracts
are type-only except for pure unit/operation constants; server services and exact
calculation code are not duplicated into the browser. The server remains the only
calculator, validator, authority for scope and source of immutable versions.

Policy and FX management are separate scoped catalog publications, not price-book
fields or configuration reloads. Their new admin-only dry-run routes validate the
same payloads/CAS/scope as mutation and do not insert catalogs, snapshots or audit
events. The full selected-scope FX schedule is shown before replacing it. No market
rate or supplier quantity cap is invented. Cross-currency quotes retain the existing
missing-FX behavior. Mutation confirmation is separate from read-only validation.

Legacy node editing sends allowlisted price patches for dirty rows only, applied
to the current stored capabilities within the config audit callback. It no longer
reconstructs hidden capabilities from resolved prices. Inheritance removal is
explicit and warns that all hidden legacy rate overrides will be removed.

A single pricing-route navigation guard registers editor/dialog dirty and busy
states. The supported data router handles links and browser Back/Forward; workspace
switching is cancellable before changing local workspace identity. In-flight writes
cannot be navigated away from in-app; unload receives the browser warning. A
successful mutation releases its own guard before controlled navigation. Browser
reload/force-close still cannot guarantee a completed network write, so revision
checks and a fresh scoped read remain essential.

Draft queries refetch when revisited. A newer server revision is adopted only when
the local editor is clean; dirty fields are retained with an explicit conflict and
comparison. Older cached responses cannot regress a locally saved revision. This
fix was prompted by real browser evidence: a version selector showed revision 2
while a remounted editor still used a permanently cached revision 1.

The supported router adds measurable shared code: vendor gzip grew from 105.96 KiB
to 123.47 KiB. The initial 120 KiB build gate correctly failed; its cap was explicitly
revised to 125 KiB (not bypassed), and a separate 24 KiB lazy-pricing-route cap was
added. The final pricing route is 17.67 KiB gzip. No dependency or lockfile change
was needed. Broader first-paint/performance acceptance remains part of M6.

SQLite/PostgreSQL and real isolated-browser evidence are recorded in the progress
document. This is not completion of request-log/report UI, governance coverage,
callback/reconciliation, retention or final delivery gates. No real catalog, gateway
configuration, model route, runtime or watchdog was modified.

## ADR-019 — Physical dispatch observers and multi-receipt terminal intents

Provider invocation wrappers no longer collapse credential/compatibility retries
into one fee. A request-scoped observer commits each dispatch before fetch, after
credential selection. Context stores bounded allowlisted model/credential metadata;
terminal cost hashing includes attribution. Raw provider content, secrets and
URLs are excluded. Preflight failures create no fictitious paid attempts.

Explicit error-response usage can be billed; missing counters do not become free.
A failed receipt does not trigger another paid call. Request totals sum known
attempt costs, while the existing final-response logical budget policy remains
separate. The special compatibility replay now shares the strict dispatch allowance
rather than resetting it. Request-frozen price/catalog identity never changes on
an internal retry. Gemini URL model identity is captured explicitly.

Terminal intents optionally include additional receipts, retaining old payload/hash
compatibility. All receipts are ownership/uniqueness/hash checked and applied with
the budget effect atomically. Runtime retains failed and successful outcomes so a
transient individual receipt write does not silently lose a paid retry. SQLite and
PostgreSQL tests prove child-exit recovery, transaction rollback and concurrent
idempotence. Failure before durable terminal intent persistence remains an open
reconciliation boundary, not a completed guarantee.

Late timeout-race losers keep lease renewal until their actual provider invocation
finishes. A real isolated HTTP test returns the fallback to the client first,
publishes a different test price, and then completes the primary: both fees retain
the old price, only the winner consumes the compatible logical budget, and no
late orphan is silently marked free. The terminal observer separately preserves reported SSE usage on client disconnect
before a public stop event, with no synthetic stop or second receipt. A real
loopback HTTP client cancellation test proves the behavior. Shared attribution
metadata is isolated from backend observer/canonical types so the frontend does
not need Node globals; the initial Buffer-type build failure is fixed at that
boundary rather than by loosening the browser configuration.

The detailed contract and remaining scope are in [attempt attribution](pricing-attempt-attribution.md).

## ADR-020 — Physical batch cost allocation before runtime fan-out

Batch fees must be computed on physical aggregate usage before allocating costs.
The deterministic allocation core preserves physical total, per-component source
and report amounts, frozen FX, exact unrounded fractions and explicit balancing
adjustments. Allocated usage is not asserted to be independently observed; token
partitions respect parent capacities and reasoning remains an overlapping subset.
Weights are positive integers and ties use stable identity order, not float math.

Legacy queue inspection exposed over-allocation on repeated rounding, donation of
cancelled members' usage to survivors, explicit zero becoming a heuristic estimate,
an asynchronous context inherited from the request that happened to flush, and
a first-client abort signal that could cancel a surviving member’s shared work.
These paths now use conserved usage allocation, captured cancellation identities,
stricter tenant/context keys, bound dispatch callbacks and a shared provider abort
signal that only cancels when every member cancels or times out. A real HTTP regression
proves two physical tokens remain two across three client responses, including
zero shares. This is a correctness fix, not a claim of precise legacy fee allocation.

Atomic grouped dispatch/outbox primitives prepare all participants or none, check
tenant/target/snapshot consistency and retain all terminal decisions before budget
application. SQLite/PostgreSQL tests cover rollback, reversed-order concurrency,
scoping and a child exit after atomic outcome commit. No new schema or startup
migration is introduced. A bounded viewer-readable batch quote API reuses the
existing calculator and resource authorization without writes or provider calls.

The priced request runtime still bypasses legacy batching. Restoring that path
requires a coordinator for per-member frozen context, aggregate strict bounds,
shared physical receipts, cancellation/holds, logical budgets, corrections and
replay/report presentation. These requirements are not waived by the new helper
or passing simulation tests. See [batch allocation](pricing-batch-allocation.md).

## ADR-021 — Request-scoped priced batch coordination

Activated embedding requests now use a dedicated coordinator rather than the
legacy queue bypass. Each member retains an independent frozen context and
renewable hold. Compatible admission identity includes principal/budget scope,
catalog/book/content/FX/policy identity and request shape; the physical aggregate
must satisfy the same admission core and every reserved member envelope. An
unprovable aggregate stays independent without weakening strict policies.

Every physical credential attempt prepares all member intents before fetch. The
physical computation is calculated once and allocated with conserved exact shares.
Top-level member cost is the share; nested physical evidence is never another
charge. Complete group outcomes/terminal decisions are atomic. Reversed-order
SQLite/PostgreSQL writes, injected member failure and child-exit recovery verify
no partial allocation or duplicate effect. Self-contained nested metadata trades
storage for simple immutable replay; its amplification/performance still needs M6
review. No new schema/startup migration is introduced.

A surviving client is not cancelled by another member. Early cancellation retains
its own supplier share and lease until terminal accounting; all-client cancellation
aborts only that shared provider request. Missing result slices retain supplier
cost while releasing the compatible logical hold. In-memory persistence retries
never repeat provider work, but cannot survive process loss before the durable
outcome commit: general orphan reconciliation remains an explicit requirement.

Read-only replay uses physical usage/rules then the recorded allocation. The shared
breakdown renders an allocation formula and physical-cost expansion with all seven
locales, not a misleading per-member tariff. Browser log/report coverage is still
pending. Independent member corrections are currently refused; a conserved
physical-group correction/reconciliation path must be implemented before whole-Goal
acceptance. Runtime behavior and remaining gates are in
[priced embedding batching](pricing-batch-runtime.md).

## ADR-022 — Conserved physical batch corrections with explicit budget winner

A physical correction now derives its entire member set from immutable receipts,
not caller-selected targets. The service restores the admitted catalog/FX and
recalculates physical usage before exact allocation. Every member appends a new
cost revision with one correction ID, physical predecessor hash and revision;
initial receipts and original intents remain unchanged. Histories must be
continuous and consistent across the complete group.

Member revisions, exact budget deltas, log projections and one group audit commit
in one transaction. The audit binds idempotency ID, actor/source/reason and the
before/after physical hashes. Identical retries return their original result even
after newer corrections; competing changes compare against the latest physical
hash. A second-member or final-audit failure rolls back the entire correction.
SQLite/PostgreSQL child-exit and concurrency tests verify this boundary.

New multi-receipt intents explicitly identify the successful logical-budget
attempt. Older singular intents are unchanged; older batch intents only infer a
winner when exactly one successful batch receipt exists. Released members and
failed retry fees remain supplier cost evidence without becoming new logical
charges. Unknown revisions stay pending; later evidence adjusts from the last
charged amount, and refunds never spill into a new budget epoch.

Admin-only JSON correction preview/apply endpoints accept usage evidence, expected
physical hash, idempotency ID, reason and confirmation. They reject caller-selected
prices/FX/membership/scope and do not call suppliers. Administrator attestation is
not invoice confirmation. The request-log/correction UI, authenticated supplier
callbacks and whole-Goal acceptance remain open. See
[batch corrections](pricing-batch-corrections.md).

## ADR-023 — Request evidence, read-only replay and safe correction UI

Log cost detail reads only allowlisted metadata and the immutable ledger. Old
stored projections/reference estimates remain labelled, never recomputed from
current prices. Exact decimal strings are localized without Number/parseFloat
money conversions. Cache upstream cost, logical budget and counterfactual replay
are explicitly distinct. A batch's physical cost explains its shares and is not
added to each share again.

Historical replay lazily selects scoped draft/version metadata and marks results
stale after selection changes. Logs, summaries and cost detail capture scope in
both cache keys and HTTP headers, rejecting responses after a workspace change.

Administrator correction captures the original physical CAS basis and exact
proposal. Preview is read-only; edits invalidate preview/consent. An uncertain
write freezes the proposal and retries the same idempotency ID, not a new one.
A conflict preserves edits and requires reread rather than silently overwriting.
The backend normalizes all manual evidence to administrator/request metadata,
even when clients send provider-source labels. Calculation is not invoice proof.

Browser fault injection deliberately loses a successful response; exact retry
preserves original receipts and adds only one revision per member and one group
audit. The current UI does not solve generalized orphan recovery, source/parent
governance or full report/coverage requirements; the entire Goal remains active.

## ADR-024 — Net transaction budget observations, published after commit

Ordinary and exact-ledger mutations now share a transaction-completion observation
boundary. It stages threshold changes and telemetry without network/notification
side effects inside SQL. Per-workspace/rule/epoch observations coalesce from first
to final exact balance, so temporary hold releases and intermediate batch members
cannot trigger false crossings. Savepoint success merges into the parent; rollback
discards observations. Rejected admission is reported only after rollback and is
distinct from a committed balance notification.

Notification exceptions cannot invalidate committed cost or retry provider work.
Scope/epoch-aware debounce identity and exact decimal event fields retain budget
provenance. The existing legacy limit/threshold column representation is unchanged.
This is not a durable delivery outbox: commit-to-enqueue crashes remain an explicit
best-effort boundary. All unrelated SQLite writers and orphan recovery still need
their own work. See [budget observers](pricing-budget-observers.md).

## ADR-025 — Coordinated owner configuration and mandatory transactional audit

Generated-key/team budget configuration no longer saves stale whole budget rows.
Owner mutations use transaction-scoped repositories; PostgreSQL protects the owner
and locks its budget rules in ledger-compatible ID order. SQLite uses the shared
connection queue for participating owner reads, authentication and writes.
Partial metadata updates preserve exact spending and epochs. Last-used writes
cannot restore old hashes/permissions and carry a non-regressing timestamp guard.

Dashboard policy mutations and their management/configuration audit share the
same manager. Mandatory audit failure propagates and rolls the entire mutation
back; standalone audit retains its best-effort return contract. Workspace hash
heads are serialized even before the first event exists. Actual request actors
and sanitized summaries are retained; reset audit captures the pre-reset exact
balance inside the reset transaction. Existing audit history is not rewritten.

These are targeted invariants, not a blanket claim about every repository writer,
multi-process SQLite, or universal HTTP idempotency. No new schema or price/budget
policy is activated. See [administrator writers](pricing-admin-writers.md).

## ADR-026 — Workspace authority and invitation effects share database ownership

Workspace, membership and invitation repositories now participate in the same
SQLite queue as the ledger. Explicit active transaction managers join compound
operations; scoped clones prevent shared singleton state from crossing requests.
PostgreSQL uses a shared schema/workspace advisory lock, including empty member
sets, with organization-bootstrap and audit-head locks in defined order.

Workspace creation/owner/audit, target changes/audit and member/invitation
administration/audit commit together. Last-admin checks re-read after the lock,
including upsert paths. ID-based member updates and invite revocation require the
current workspace. Local and OIDC acceptance pass membership effects through the
invitation transaction; failure leaves the token pending, and competing accepts
cannot both commit. Expired top-level acceptance commits its status before
returning the public error; list-time expiry remains workspace-scoped and lazy.

Existing email and ordinary membership provisioning policies are retained, apart
from preventing an upsert from removing the last admin. Existing default member
IDs are preserved; a newly created PostgreSQL default member uses its generated
UUID rather than inserting SQLite's historical non-UUID ID into a UUID column.
No startup schema/migration redesign or universal login idempotency is implied.
The original PostgreSQL UUID-fixture failure is retained as evidence rather than
counted as a pass. See [workspace writers](pricing-workspace-writers.md).

## ADR-027 — Separate pre-durable retry, immutable intent and suspected-orphan review

Generic synchronous receipt and terminal-decision writes now retain immutable,
metadata-only retry bodies across transient storage failures. Pending entries
protect local leases. The buffer bounds entry count and serialized bytes, applies
backoff, coalesces same-key writes and quarantines incompatible decisions.
At capacity new priced admissions fail before dispatch; already-dispatched work
still attempts persistence. This does not make the memory buffer a durable outbox.

Additive `006` records scoped suspected-orphan cases after expired dispatch leases,
preserving all five earlier migration checksums. Observation is not monetary
authority: unknown provider outcomes remain unknown, and even a known receipt
does not prove the logical budget decision. Active leases, async task footprints
and durable pending intents are excluded. Bounded sweeps rotate unchanged cases
without churning evidence revisions. An actual late intent resolves its case in
the same transaction as budgets and log projection.

The operator case endpoint is read-only. Full operator/CAS/audit resolution,
quarantine handling, pre-durable process-loss acceptance, trusted supplier events,
case lifecycle/retention and UI are still required. No earlier failed-write or
in-memory replay test is presented as proof of a durable outcome that was never
written. See [outcome recovery](pricing-outcome-recovery.md).

## ADR-028 — Audited connected-group budget resolution, not invented supplier usage

Recovery now separates an administrator's internal hold decision from evidence of
provider cost. New resolutions release a hold or commit an existing known winner;
an existing immutable intent can only be replayed. Cache upstream zero remains
distinct from its original logical-budget estimate. Unknown usage is not supplied
or manufactured by this API.

The resolver discovers transitive physical/request membership, takes the normal
request/reservation/attempt locks, and reloads the graph before using a fresh
snapshot/effective-adjustment/lease/intent basis. Every unresolved member needs a
decision, while terminal siblings are read-only context. Preview performs no
writes. Member effects, logs, audit and decision links commit together; an exact
retry verifies the audit and its applied member decisions.

Additive `007` retains immutable decision links and one metadata-only allocation
manifest per new physical dispatch. Earlier migration definitions stay frozen.
Verified operator decisions can retire superseded local budget retry entries;
late genuine shared usage is still stored without overriding those decisions.
Usage receipt quarantine, supplier evidence recovery, operator UI, case lifecycle
and complete durability/retention/performance acceptance remain open. See
[budget recovery](pricing-budget-recovery.md).

## ADR-029 — Recovery inventory and tab-scoped ambiguous-write UX

The Dashboard exposes the existing audited **internal-budget-only** resolver,
not a second settlement implementation. Budget state and supplier-cost
completeness remain distinct. The operational inventory is scoped, keyset-paged,
metadata-only and explicitly limited to recorded cases. Unknown-cost filtering
is bounded to 200 candidates; empty batches can still have a continuation.
Duplicate request totals are displayed but not aggregated.

Operators inspect; administrators explicitly choose all unresolved members,
preview on the server and separately consent to apply. The client never sends
money. Edits invalidate previews; stale evidence preserves choices until an
explicit rebase. Ambiguous results freeze the original ID/body. A new read-only
acknowledgement verifies the existing audit and all terminal decision links.

A versioned workspace/actor/anchor-scoped session record is written before POST.
It contains only the proposal and sanitized preview, has a bounded serialized
size, and is cleared after verified completion. Reload cannot silently create a
fresh idempotency key or retain consent. Storage failure blocks new submission.
This is not durable supplier evidence and is not a substitute for recovery after
process loss. Initial basis loading, complete winner identifiers and responsive
header controls were corrected after real-browser testing exposed presentation
problems. No schema migration is added; checksums `001`–`007` stay frozen.

See [budget recovery](pricing-budget-recovery.md) for API, privacy and operator
steps. Whole-Goal supplier recovery, reporting, lifecycle and M6 gates remain open.

## ADR-030 — Missing initial usage is cost evidence, not an inferred budget winner

Administrator attestation can now recover an absent first accounting receipt
using the recorded dispatch and immutable request price/FX snapshot. Quantities
are explicitly estimated `request_metadata`; client money and provider-provenance
labels are rejected. Unknown quantities/rates remain unknown. Recorded dispatch
time and target cannot be replaced by current config or a caller's different
model/operation. This is not supplier invoice approval or an actual outcome claim.

The selected physical invocation is processed as a whole under the existing
connected graph locks/CAS. Its canonical first member chooses the price and the
durable manifest supplies allocation weights. Legacy missing weights, mixed
initial/terminal groups, active owners, async ownership and pending immutable
intents cannot be bypassed. Original receipt, audit and log projection commit
together; budget choices stay separate. Exact retries and read-only acknowledgements
verify original hashes after process exit or concurrent completion. Serialized
review results are bounded to 4 MiB before writes. No schema step is changed.

An existing receipt still requires a linked correction. A differing queued
supplier receipt is retained, not erased by this attestation. Dashboard input,
trusted supplier ingestion, receipt quarantine/correction and full pre-durable
recovery remain open. See [missing usage recovery](pricing-usage-recovery.md).

## ADR-031 — Missing-usage UI keeps receipt attestation separate from budget consent

The seven-language form is a separate lazy route from budget recovery. It asks
for explicit attempt selection and exact quantity strings, with blank meaning
missing and no guessed cache zeros. Changing the target clears evidence after
confirmation. All physical members remain part of preview/validation regardless
of display pagination. Optional conditions cannot change the original operation,
target or dispatch instant. Backend ordering of offset-bearing instants now uses
absolute time; the previous lexical comparison was incorrect across offsets.

Preview and write use one frozen proposal. An edit invalidates preview/consent;
a conflict retains the draft for explicit reread. Ambiguous writes survive tab
reload through a minimal versioned scoped session record, with consent reset.
Browser-side canonical SHA-256, complete member identity and original-preview
hash checks prevent an unverifiable response from being labelled successful.
The server's transactional audit remains authoritative; browser validation is not
an authentication or accounting authority.

Pending records contain only allowlisted proposal/preview data, not full provider
responses or raw result objects. Storage failure blocks a new submission. Verified
acknowledgement clears the record. This does not provide a durable disk spool or
supplier invoice confirmation. Current browser evidence is a trusted-loopback
secure context; deployment-origin/browser compatibility stays in M6 acceptance.
No new migration or production price/budget configuration is introduced.

## ADR-032 — Terminal corrections reuse exact budget application without rewriting initial receipts

Single-attempt administrator corrections now have a scoped original/effective
basis, explicit preview/apply and read-only acknowledgement. They restore the
original catalog/legacy price/FX and preserve dispatch attribution. Submitted
quantities are complete normalized replacement evidence, forced to estimated
administrator provenance. Client money and supplier-confirmation labels are not
accepted. Shared batches and asynchronous jobs keep their own correction paths.

Preview uses the same append/epoch-delta calculation as apply, with persistence
and post-commit observations disabled. It is not a write followed by rollback.
Applicable budget deltas, correction/application rows, mandatory audit and log
projection commit atomically. Original attempt rows, intents and earlier revisions
remain immutable. Retry identity includes scope, actor, attempt and full input;
acknowledgement verifies the audit and revision chain, including after newer
corrections or process exit.

An expired synchronous hold without a terminal intent can receive a cost-only
revision. It remains reserved with no monetary effect. The separate audited budget
resolver may then commit the effective winner amount, while preserving initial
receipt copies in its intent. Later corrections start from that actual committed
amount. The resolver's unknown-cost result now uses terminal effective evidence
rather than an old receipt copy. No schema changes or policy activation occur.

The result distinguishes supplier evidence, logical-budget deltas and original
epoch allocations; it never promises a refund in the current period. Underflow
and missing original epochs are errors, not reasons to invent a zero. A released
hold or losing attempt cannot accrue an unapproved logical charge. This completes
a backend contract. The UI follows in ADR-033; retained-receipt ingestion, trusted
supplier adapters and remaining M6 gates stay open. See
[attempt corrections](pricing-attempt-corrections.md).

## ADR-033 — Single-attempt UI reviews exact budget epochs before immutable retry

The correction form reuses the missing-usage quantity editor without reusing its
no-budget promise: terminal revisions may change a logical charge. It shows
original/effective receipts, frozen-price cost differences, signed token/cost
deltas and original-period allocations. Preview labels are explicitly proposed
until an acknowledged commit; cost-only reserved/released cases remain distinct.
Manual evidence stays estimated and cannot confirm supplier billing.

A complete proposal and its compact verified preview are retained before write
in versioned workspace/actor/attempt-scoped session storage. Reload resets consent.
The exact retry and read-only acknowledgement verify request/attempt/predecessor,
canonical cost hashes and the original signed epoch allocations, then compare
persisted adjustment/application identity. A different or malformed reply is not
success. Session storage excludes arbitrary response fields and is not durable
accounting storage. A recovered pending proposal is usable even if a new basis
read fails; storage failure blocks a new submission.

Edits clear preview/consent; conflicts retain draft data for explicit reread.
Operators are read-only and viewers are denied; the server remains authoritative.
This is an isolated seven-language/browser checkpoint, not trusted supplier
receipt ingestion or full Goal acceptance. No migration, dependency version,
production state, committed source identity or deployment changes in this step.

## ADR-034 — Retain distinct runtime evidence before immutable delivery

The memory buffer previously keyed by subject, losing the incoming body on a
conflict and allowing an earlier writer to erase that conflict entry. It now
retains workspace/type/subject/hash variants independently. A conflicting overflow
can only archive, not overwrite; an unacknowledged archive never frees its entry.

Explicit additive migration 008 stores allowlisted immutable runtime outcomes and
mandatory retention audits. Pending bodies replay through existing attempt and
terminal-intent writers; delivered acknowledges those writers, not provider
billing. Retry metadata and monotonic delivered/review transitions do not modify
body hashes. Distinct evidence is retained for review rather than automatically
selected. Invalid pending bodies leave automatic replay without being erased or
presented as verified. Original snapshots and budget epochs remain authority.

Capture happens before the first asynchronous wait, and delivery uses the retained
copy. Scope/ownership checks, size/field allowlists, audit verification, bounded
keyset inventory and unresolved-workspace backpressure are explicit. No public
write/ingest endpoint is exposed, and `gateway_runtime` is not a trusted external
supplier source. Batch/async ownership keeps its dedicated lifecycle. Existing
buffered budget decisions cannot retire without preserving carried receipts.

This advances post-retention crash recovery and preserves conflicting evidence;
it does not finish pre-durable-loss handling, authenticated supplier ingestion,
conflict-to-correction disposition, complete batch/task coverage, resumed-owner
fencing, retention/performance or full Goal acceptance. Migrations 001–007 are
unchanged. Production activation remains forbidden without separate approval.

## ADR-035 — Reviewed inbox disposition selects evidence, not a budget proposal

An administrator can accept the complete supported independent receipts in one
retained outcome or reject that evidence without erasing it. Separate additive
009 stores the immutable decision; the 008 body/state remains intact. Neither
choice implicitly adopts a stored budget amount, releases a hold, changes an
existing request error/outcome, or authenticates a supplier invoice.

Acceptance reproduces the exact retained cost from original request price/FX,
legacy version, normalized quantities and immutable dispatch fields. It cannot
accept client money or edited evidence. Missing initial receipts and linked
corrections share the original request lock, required decision audit, disposition
and log-projection transaction. Existing exact-budget epoch effects apply only
where the prior logical decision makes them applicable. No-write preview and
fresh related-evidence CAS precede explicit confirmation.

Workspace/actor/input-bound retries and read-only acknowledgements verify custody,
result/audit and initial/revision chains, including after newer corrections or
child process exit. Competing decisions cannot both win. A current runtime write
that was already waiting is fenced by the disposition under the request lock.
This does not claim complete old-binary, batch or task-owner fencing.

Independent-receipt disposition is a backend checkpoint, not the unfinished
seven-language review UI, trusted supplier adapters, full group/task disposition,
pre-durable-loss/reconsideration lifecycle or remaining M6 gates. See
[outcome disposition](pricing-outcome-disposition.md). Migrations 001–008 remain
frozen and no live gateway activation is permitted by this Goal.

## ADR-036 — Disposition UI verifies all members and keeps recovered editors mounted

A dedicated lazy inventory/review route selects already-retained evidence, never
new client money or quantities. Original custody state and separate decision are
displayed independently. Every receipt participates in preview and verification,
not merely the visible inspection page; alternatives are not added as new charges.
Acceptance and nonselection have separate explanations and consent. Proposed
budget deltas are not presented as applied or as today's account-balance refunds.

The browser binds action/outcome/member/error/cost/epoch identities to a compact
verified preview, persists only allowlisted scoped retry data, resets consent on
reload and checks acknowledgement or exact same-ID retry before showing success.
An existing decision is verified against its recorded result hash, not reused as
a new write. Conflicts keep action/reason but require a fresh basis and preview.
Operators inspect; admins write; viewers are denied by both UI and backend.

A failed initial basis plus pending proposal exposed a recovery-wrapper bug:
acknowledgement cleared storage, then query invalidation unmounted the successful
editor and reintroduced stale pending props. A shared pure loading-state helper
preserves the restored editor during error-basis refetch while still waiting for
the initial basis attempt. Four recovery wrappers use it; the actual disposition
fault/reload/acknowledgement/refetch sequence verifies the fix.

The final layout harness measures actual CSS viewport dimensions, accounting for
the owned browser's page zoom. Seven locales pass three detail widths and narrow
inventory checks; no new migration or production activation is introduced.
This completes this UI checkpoint, not group/task disposition, trusted supplier
adapters, old-writer/pre-durable-loss, retention/performance or remaining M6 gates.

## Delivery gates

The implementation progress document records evidence per phase, not a claim
that domain tests alone satisfy the Goal. Backend integration, media adapters,
permissions, frontend, migrations, PostgreSQL/Docker checks and candidate
packaging remain required before `READY_FOR_REVIEW_NOT_DEPLOYED`.

## ADR-037 — Auxiliary database writers do not own provider work

The enumerated legacy/auxiliary repositories now participate in the cost ledger's
SQLite serialization boundary. Short writes use scoped repositories; imports and
prompt version allocation/pruning are atomic. No wrapper encloses a provider,
PipelineService or independently coordinated budget call. PostgreSQL uses row or
schema-qualified natural-key locks instead of the SQLite queue.

Agent-profile mutations read linked-key summaries through an explicit active
same-database manager. Detached profile reads release their queue before entering
the normal key service. Fresh-row updates prevent render/cancel operations from
restoring stale profile/job fields. Portable Date metadata also lets the profile
entity initialize on PostgreSQL without a SQLite-only column type.

The regression exposed legacy empty-204 cancellation and sparse-response status
handling: creation may default to validating, but a later response without status
must not reset it. Compatibility response filtering is workspace scoped; the
legacy global uniqueness constraint is preserved, not silently migrated. None of
these operations supplies missing supplier usage, changes a price/budget policy,
or completes retained physical-group/task recovery.

Contract and verification boundaries:
[auxiliary writer isolation](pricing-auxiliary-writers.md).

## ADR-038 — Retain physical groups intact and separate terminal-decision phases

Migration010 provides a separate compact group inbox and complete reservation
roster, leaving independent inbox008/disposition009 semantics and all earlier
migration hashes intact. The phase subject includes the physical call and the
terminal-member set: an earlier cost-only receipt and a later final intent are not
mistaken for contradictory physical prices. Every body still contains the complete
physical allocation; historical partial shares require existing durable authority.

Delivery reuses the existing atomic group writer and terminal outbox. Retention,
delivery and applied logical budgets remain separate facts. No physical outcome
is converted into independent member adoption or a second supplier charge.
Custody-only acknowledgement can stop a live owner's lease renewal/bookkeeping,
but cannot release a database hold or apply its superseded budget proposal.

Hash-addressed shared evidence reduces repeated physical metadata. Both compact
bytes and expanded reference traversal are bounded; validation must occur before
a compact reference graph creates a very large string/tree. Required audits and
roster links commit atomically, request-first locks remain consistent during
corruption quarantine, and a delayed final acknowledgement cannot clear review.

Read-only scoped APIs and actual cross-database/process/HTTP contracts are part of
this checkpoint. Complete group disposition/UI and pre-durable process-loss,
trusted supplier/media lifecycle and final capacity acceptance are not waived.
Contract: [complete-group runtime outcomes](pricing-group-outcomes.md).

## ADR-039 — A group decision verifies every member and previews shared epochs

Additive 011 records one immutable disposition separately from custody010. An
administrator can accept all supported represented receipts or record rejection;
neither action adopts a retained budget proposal or invents a missing physical
lineage. Complete changed cohorts use conserved group corrections. Initial fills
require exact compatible recorded members; partial historical evidence can only
be acknowledged unchanged. Original receipts, errors, intents and custody stay
intact, and supplier confirmation remains false.

Original tariff reproduction is shared with independent disposition, but a
physical group also rechecks every prepared member's tenant/target/catalog/price/
FX/policy authority. Real HTTP tests exposed operation-qualified embedding
bindings absent from old media context metadata: the validated dedicated
embedding lifecycle supplies that operation, never a model-name guess or client
override. Accepted reported-model context flows into later ordinary corrections;
their exact retries use the context recorded with the original correction.

No-write preview simulates all member effects against one transaction-local map
of original budget epochs. Independent checks against an unchanged starting
balance could each pass while the aggregate refund underflowed. PostgreSQL raw
epoch timestamps also require ISO normalization before basis hashing; otherwise
Date objects would not invalidate an old preview after a reset. Both regressions
are covered without weakening monetary constraints or introducing preview writes.

Complete initial/linked/no-op records, exact applications, required group audit,
decision and log projections commit atomically. Same-ID retry and read-only
acknowledgement verify all membership, retained versus accepted hashes, error
evidence and revision audits, including after process exit or later corrections.
Cross-database tests and real permission/origin/frozen-FX HTTP tests provide the
backend evidence. Dedicated group UI and all remaining Goal gates stay open.
Contract: [complete-group disposition](pricing-group-disposition.md).

## ADR-040 — Inheritance is immutable provenance, not a live pricing dependency

A derived draft has an explicit fixed parent version/hash and declarative recipe.
The resolver materializes a complete ordinary price book before publication;
the existing compiler checks the expanded rule set. Runtime calculations never
follow a mutable parent pointer or perform a parent/database/network lookup.
Unknown/removed dimensions are not backfilled by inferred prices.

Migration012 adds restrictive draft/version lineage sidecars and required audits
without changing001–011 or historical content. Workspace/global scope is enforced
at every ancestor; global prices cannot depend on private parents. Bounded
ancestry, content/lineage hashes and audit markers detect inconsistent/lost recipes.
Normal/manual catalog integrity probes remain bounded bulk queries. Publication,
lineage/audit persistence and draft cleanup are atomic; recipe writes use the
existing draft CAS. Ordinary materialized updates cannot implicitly detach.

Fork and rollback preserve original recipe semantics. Portable derived exports
carry the fixed-parent recipe with sanitized source URLs, not a flattened manual
document; unresolved imports fail rather than select another parent. This is
source traceability, not a supplier invoice or proof against total database/audit
rewriting. Dedicated seven-language UI and historical source rendering remain
required. Contract: [immutable parent prices](pricing-inheritance.md).

## ADR-041 — Ordered supplier evidence is separate from delivery arrival order

Additive013 introduces scoped signing-source registration, immutable normalized
media-event custody and a per-task ordering head. The connector protocol accepts
complete quantity snapshots, not monetary totals or deltas. Only a configured
independent HMAC key can authenticate the normalized event endpoint; dashboard
roles configure sources but cannot substitute a dashboard token for the event
signature. Source revision, workspace, original connection fingerprint and
physical dispatch credential are checked again when the observation is retained.

An event's sequence is a provider/connector contract, never a value inferred from
arrival time. Lower sequences, same-sequence alternatives and pending-after-
terminal observations are retained with explicit decisions. Newer terminal
snapshots feed the existing frozen-price observation and linked-adjustment path.
A missing submission reply can be repaired only when authenticated evidence
identifies the exact original task; no generation is repeated to discover a job.

Once a sequenced source owns a task, unordered polling metadata is retained for
review instead of overriding the signed snapshot. A receipt, its original source
approval audit, the ordering head and any new task observation commit atomically.
Financial processing remains a recoverable subsequent step. Source rotation does
not erase prior authorization, and missing ordering state fails closed.

This is not native universal vendor-webhook support or supplier invoice
confirmation. A connector must authenticate its upstream before translating the
snapshot. Unknown job correlation, unordered-evidence disposition, complete
operator pagination/UI, retention and capacity policy still need their remaining
Goal implementation and acceptance. Contract: [media supplier events](pricing-media-supplier-events.md).

## ADR-042 — Unknown-job association is explicit attestation over pinned provider IO

An administrator may correlate an existing uncertain gateway task with a
separately investigated provider job. A status GET authenticates access to that
job under the original credential; it does not prove the request-to-job mapping.
The mapping is therefore audited as administrator attestation, never supplier
invoice confirmation. No arbitrary URL/header/credential or client-authored cost
can enter this path, and no generation is dispatched.

A no-write preview returns original-basis, normalized-observation and immutable-
price cost hashes. Confirmation re-fetches and rechecks all three; role and task
changes during IO invalidate the proposal. Unknown provider timestamps stay
unknown rather than becoming a current completion-time tariff. Database locks
are short and are not held over provider IO.

Migration014 records association, observation and required audit atomically,
with exact same-ID replay before any further provider IO. Existing durable media
processing handles subsequent budget application and crash recovery. Signed and
manually correlated job claims share an identity lock, preventing different
workflow tables from independently accepting the same physical provider job.

Workspace-bound keyset inventories expose task metadata and retained events
without prompts, raw task contexts or credentials. The UI, alternative-evidence
disposition and whole-Goal capacity/retention/reporting gates remain required.
Contract: [media job lookup](pricing-media-job-lookup.md).

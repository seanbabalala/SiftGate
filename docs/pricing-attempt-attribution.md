# Provider-attempt attribution — development candidate

This is a partial M3 checkpoint, not full Goal acceptance or deployment. See the
[Goal Spec](pricing-engine-goal-spec.md), [progress](pricing-engine-progress.md),
[management API](pricing-management-api.md) and
[admission policy](pricing-admission-policy.md).

## The accounting boundary

A provider-client invocation can make more than one HTTP request: credential
rotation, an outer pipeline retry, a fallback, or the existing narrowly classified
Responses compatibility replay. A single receipt around the outer invocation
cannot describe all of these attempts.

For an activated pricing request, the pipeline supplies a request-scoped observer
to the provider client. After choosing the credential and constructing the request,
the observer commits a dispatch record **before fetch is invoked**. A failed
dispatch-record write prevents that fetch. Errors before this boundary do not
create fictitious provider attempts. Pre-aborted operations do not select a
credential or create a dispatch record.

The persisted record means a dispatch was prepared, not proof that bytes reached
the supplier. A crash immediately after the record commits can still leave an
ambiguous attempt. Such an attempt is not declared free and cannot be blindly
replayed. Supplier reconciliation for those ambiguous orphans remains open.

Each credential failure is finalized independently before retrying. The successful
response body or terminal stream usage finalizes only its own attempt. Stream
cumulative usage continues to replace earlier counters; this change adds neither
extra client-visible stop events nor pricing fields to `/v1` responses.

A private terminal stream callback also retains the parser's final reported usage
when the client disconnects before any public stop event. It records the abort
independently of those counters; no synthetic stop is sent to make accounting
work. If the provider did not report usage, cost still remains unknown. Socket,
reader and external-abort cleanup runs even if terminal observation fails.

## Identity and immutable evidence

New attempt context stores allowlisted `dispatch` metadata; the completed cost
also includes `attribution` under its immutable cost hash:

- Original requested model from canonical metadata.
- Selected route model, actual wire model (including Gemini's URL model), and
  provider-reported response model when present.
- Node ID, credential ID/strategy (never the credential value), protocol and
  dispatch timestamp.
- Invocation ID, dispatch index, credential retry index and compatibility replay
  index. Separate outer retries have separate invocation IDs.

Model names and IDs are bounded/redacted. No prompt, output, raw error body,
provider header, URL, credential value, tool payload or media bytes are persisted
by this feature. Legacy rows without dispatch metadata return `dispatch: null`.
Reading metadata never rewrites their original hashes or costs.

Pricing still uses the admitted route binding and the request-frozen catalog.
A different reported model is evidence, not permission to silently use a new
price or current binding. Reported/wire/route identity must stay distinguishable.

## Failures, unknown costs and logical budgets

An error HTTP status alone does not establish zero cost. Known token usage is
parsed through the same raw-counter adapter as success responses. Explicit billed
audio seconds and rerank counters are also retained through bounded allowlisted
paths. Unsupported/missing counters stay missing; malformed and explicit zero
counters remain distinct. Private error/debug content is discarded after parsing.

Request cost sums all known attempt fees. If any attempt remains unknown/pending,
the final total remains null and the known subtotal is displayed separately.
For example, two fully metered synthetic attempts costing 0.000020 USD each yield
0.000040 USD, even if the first attempt returned 429. A 429 with no usage does not
turn into a zero-cost attempt merely because a later credential succeeds.

Compatible logical budget accounting still follows its documented final-response
policy: it can commit 0.000020 USD while supplier attempt costs total 0.000040 USD.
Releasing a failed or race-losing logical reservation does not remove the upstream
cost evidence. Changing that compatibility policy is a separate explicit decision,
not an implicit effect of collecting more accurate receipts.

## Strict retry allowance

`reserve_upper_bound` captures credential allowance with the reservation. The
provider client shares a decrementing dispatch counter across its compatibility
replay, rather than resetting the allowance recursively. A pool growing after
reservation cannot add unreserved credential attempts. External aborts stop
further credential retries. Conditional supplier-limit assumptions are unchanged;
the system does not invent a universal cost cap from heuristic usage.

Generation operations retain their existing single-attempt and durable task
lifecycle protections. This feature does not enable blind image/video retries or
replace task-owner/credential pinning with ordinary chat retry behavior.

## Multi-receipt settlement and recovery

A runtime reservation retains each terminal attempt receipt, including observed
failures. A terminal settlement intent can now carry optional additional
`receipts` alongside the existing singular `receipt`. Existing intents omit the
new field and preserve their hashes. No SQL schema migration is added here.

Queueing validates every receipt's workspace/reservation ownership, immutable
hash and uniqueness. Applying the intent repairs **all** its missing receipts,
updates the logical budget and marks the intent applied in one transaction. A
budget-effect failure rolls all receipt repairs back. Replay after a crash or
concurrent recovery does not debit the budget twice. Releasing a reservation can
still durably retain its failed attempts' nonzero supplier fees.

This protects known outcomes once the terminal intent is persisted. A crash before
that durable boundary, or failure to persist the intent itself, can still require
reconciliation. Broader terminal-persistence retry/delivery remains explicit Goal
work. Do not mix pricing workers from incompatible candidate revisions during
upgrade/downgrade; M6 must verify the final supported transition and rollback plan.

## Timeout race and lease lifetime

If the configured fallback race returns a winner while another paid request is
still in flight, that losing request retains its own observer, snapshot and lease.
Returning the client response no longer discards the still-active lease. A late
result records its original-price receipt; the loser then releases its compatible
logical hold without erasing its supplier cost.

The isolated test exercises a real HTTP server on an ephemeral loopback port:
fallback returns first, the client sees the winner, a new price is published in
the test catalog, and the delayed primary completes. Both attempts retain the old
price; final supplier cost includes both, while only the winner's compatible
logical budget is committed. Only task-owned sockets are closed afterward.

## Evidence and remaining boundaries

- HTTP tests use the real gateway/provider adapters with synthetic upstream data.
  They cover both retry layers, nonzero failure usage, missing usage, model aliases,
  frozen prices across retry/publication, stream attribution, embeddings, audio,
  special compatibility replay and strict allowance. CALC-18 exercises exactly
  three attempts with the first unknown and two subsequent observed fees.
- A real HTTP client disconnects from the isolated gateway after receiving a
  partial stream with reported usage but no stop event. The provider stream is
  cancelled, its known cost is retained once, and the hold reaches a terminal state.
- Every mock fetch observes the durable dispatch row before returning. Dedicated
  tests gate `begin` to prove fetch cannot run first, and reject pre-aborted calls.
- SQLite WAL and independent PostgreSQL tests terminate only an isolated child
  after it persists a multi-receipt intent, inject transaction failure, and race
  replayers. Ownership and duplicate-receipt failures leave no partial intent.
- No test changes the live 2099 gateway, its database, configuration, watchdog,
  runtime, model dependency or routing. Providers are mocked or task-owned loopback.

The [batch allocation foundation](pricing-batch-allocation.md) now provides exact
conservation, atomic group primitives and read-only preview, and the [priced-runtime coordinator](pricing-batch-runtime.md) now integrates
shared dispatch/cancellation/settlement/replay. [Conserved group corrections](pricing-batch-corrections.md) are implemented;
final reconciliation/coverage/performance/operator UI remain unfinished.

Remaining: generalized supplier reconciliation and broader
adapter/metering coverage, remaining writer coordination/post-commit notifications,
ambiguous orphan reconciliation and supplier callbacks, operator/report UI,
retention, performance/Docker and complete candidate delivery. These tests do not
stand in for those acceptance gates.

## Browser-safe type boundary

Attribution metadata lives in a pure wire-types module. Observer callbacks and
canonical server response types live separately. This avoids importing server-only
`Buffer` types into the Dashboard through `CostComputation`. The first frontend
build exposed this accidental type dependency; it was fixed by splitting the
contracts, not by enabling Node globals in the browser or adding dependencies.

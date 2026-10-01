# Embedding batch allocation — foundation checkpoint

**Not deployed.** This document records the original foundation checkpoint. The
subsequent [runtime integration](pricing-batch-runtime.md) now connects these
primitives to priced requests; [conserved group corrections](pricing-batch-corrections.md) are also implemented,
while remaining reconciliation/UI/performance gates are still open. The foundation checkpoint
adds a precise allocation core, read-only batch quote API, atomic ledger group
operations, and fixes the existing legacy embedding queue. These are prerequisites
for the runtime coordinator, not substitutes for it. The full
[Goal Spec](pricing-engine-goal-spec.md) and [progress](pricing-engine-progress.md)
remain authoritative.

## Price the physical invocation, then allocate

Applying a per-request tariff separately to every member of a batch is wrong when
the tariff depends on total input, a base invocation fee, minimums or rounding.
The new core takes the physical invocation's **already-computed** immutable
`CostComputation`, produced by the same calculator used for actual requests.

1. Resolve the physical batch's complete usage, context/service/time rules and FX.
2. Calculate its original-currency and reporting-currency amounts once.
3. Allocate those finalized amounts to member identities using positive integral
   weights and deterministic largest-remainder apportionment.
4. Retain the complete physical computation/hash, weights, input spans, membership
   and per-component shares. Do not call a fractional share a separately observed
   provider invoice or reprice it as a smaller standalone request.

Synthetic example: three requests each contribute 100,000 input tokens. If a
physical request above 272,000 costs 2 USD per million input tokens, the batch
costs 0.60 USD; equal allocations are 0.20 USD each. Pricing each 100,000-token
member separately at the cheaper tier would incorrectly produce 0.30 USD total.
This threshold and these rates are test fixtures, not supplier defaults.

## Exact amount and quantity conservation

All arithmetic uses integer fractions/decimal strings. Final allocated money uses
18 decimal places and must sum exactly to the physical settled amount. Ties are
resolved by participant ID, not locale, wall clock or input iteration order.
Negative rounding adjustments are supported, but physical fees cannot be negative.
No source value is silently rounded to make it fit a coarser allocation unit.

- Each physical component's source/report amounts are allocated separately.
- Each member's explicit adjustment balances its displayed components against its
  allocated subtotal. Those adjustments also sum to the original adjustment.
- Original/report currencies and fixed FX metadata remain distinct. Missing FX
  leaves reporting amounts null; unknown use/price is not free.
- Reduced unrounded component fractions remain available for explanation. Final
  allocation uses settled amounts, not newly rounded copies of the original fee.
- A positive tariff that rounds to zero is not relabelled an explicitly free tariff.

Usage counters are allocated independently of money rounding. Integral counts
remain integral; durations retain 18-place precision. Parent-constrained token
partitions prevent rounding from assigning a member more cache tokens than its
total input. Reasoning overlaps output and is not treated as a second disjoint
modality. Missing/unsupported usage stays missing; allocated nonzero usage is
labelled estimated rather than claimed as provider-observed per-member usage.

The core bounds participants at 1024, physical components at 4096 and the expanded
member/component matrix at 65,536. This limits amplification even if an input fits
the HTTP body cap. More general configurable pricing limits and production-scale
performance acceptance are still M6 work.

## Read-only API

`POST /api/dashboard/pricing/batch/quote` is Dashboard-viewer-readable and uses the
same authentication, scope, JSON/origin guards and price lookup as ordinary quote.
It has no provider calls, budget effects, ledger insertion, publication or migration.

```json
{
  "quote": {
    "draft_id": "AUTHORIZED_DRAFT_ID",
    "evidence": [
      {"dimension": "total_input_tokens", "value": "300000", "source": "request_metadata", "quality": "observed"},
      {"dimension": "uncached_input_tokens", "value": "300000", "source": "request_metadata", "quality": "observed"}
    ],
    "report_currency": "USD"
  },
  "members": [
    {"id": "synthetic-a", "input_count": 1, "weight": "100000", "weight_basis": "token_input_count"},
    {"id": "synthetic-b", "input_count": 1, "weight": "100000", "weight_basis": "token_input_count"},
    {"id": "synthetic-c", "input_count": 1, "weight": "100000", "weight_basis": "token_input_count"}
  ]
}
```

`quote` accepts the ordinary draft/version/inline-content selectors, evidence,
context and optional synthetic FX. A selected book may require additional
dimensions (for example output/cache zero counters); omitting them stays missing.
Member IDs are synthetic allocation identities, **not** a query for other requests.
The supplied weight basis is an input assumption, not evidence that a provider
reported those per-member quantities. Repeated IDs, zero/fractional weights,
unknown fields and invalid spans are rejected. Integral decimal spellings such as
`1.0` remain exact. A foreign draft returns 404 rather than exposing its prices.

## Existing legacy queue fixes

The unactivated legacy embedding queue now uses the same conserved usage
allocation primitive:

- Two physical tokens across three equal members produce `[1, 1, 0]` in stable
  identity order, never three tokens from repeated rounding-up.
- All dispatched members are included before distributing results. Cancelling one
  member does not donate its usage to surviving members. The provider request uses
  a shared abort controller: one client cannot abort another member’s work; it is
  cancelled when every remaining member cancels or times out. A real isolated HTTP
  client-disconnect test verifies the surviving request still receives its share.
- Explicit provider zero survives both the queue and the embedding pipeline;
  missing raw usage remains missing even if a compatible display estimate is used.
- Workspace, namespace, team, principal/session, selected credential hint and
  configuration revision participate in the queue key. Matching API-key text alone
  is not permission to mix tenant contexts.
- Each queued dispatch is bound to its originating asynchronous context. A later
  request flushing the queue cannot replace that context with its own.
- Cancellation uses the captured queue key, not potentially mutated request
  metadata. Credential routing metadata survives response splitting.

These fixes do not by themselves make existing legacy monetary accounting a
precise batch ledger. That requires the next coordinator integration below.

## Atomic group persistence primitives

`CostLedgerService.beginAttemptGroup` prepares all same-workspace participants in
one transaction. It rejects duplicate request/reservation identities, mixed
principals/targets, differing catalog/price/FX/policy snapshots, and mismatched
reserved targets. Request locks precede reservation locks in deterministic order.
If any participant is invalid, no dispatch record is inserted for any member.

`queueSettlementGroup` persists every participant's terminal intent in one
transaction before any budget effect is applied. A fractional token count is
rejected before normalization; an invalid/missing member leaves no partial intent
set. Existing individual recovery can then apply each immutable intent exactly
once. A cancellation/release can still retain a known nonzero upstream receipt.
Sibling effects may become visible at different instants during recovery, but all
their outcomes are durable before application starts.

These methods reuse the existing explicit schema and outbox; no startup migration
or new public write endpoint was introduced. They are internal building blocks;
the original foundation did not yet connect the priced runtime. The later
[runtime coordinator](pricing-batch-runtime.md) uses a separate priced queue.

## Verified and still required

Current evidence includes exact boundary/rounding/FX/missing/free tests, 250
deterministic conservation fixtures, queue cancellation/isolation/context tests,
real isolated HTTP batch quotes and legacy embedding requests, and atomic grouped
dispatch/outbox tests on SQLite WAL and independent PostgreSQL. Child-process
fault tests exit only after the group intent commit and verify idempotent recovery.

Integration requirements identified at the foundation checkpoint (see the
[runtime checkpoint](pricing-batch-runtime.md) for implemented portions and
remaining work):

1. Capture independent pricing-runtime contexts/leases for every queued member.
2. Validate the combined physical quantity/rate envelope before shared dispatch.
   Combining members must not turn individual strict reservations into an invalid
   batch upper bound. Retain separate requests when approved bounds cannot cover
   a proposed batch; do not invent new supplier caps or accept unreserved risk.
3. Use the atomic group methods at physical credential-attempt boundaries and
   persist the shared physical receipt plus allocations without duplicate cost.
4. Coordinate cancellation, timeouts, partial/missing result rows and all-members
   cancellation: a client response may finish before paid work does, but its hold
   and outcome evidence must not disappear or be allocated to someone else.
5. Integrate per-member logical budget policy, corrections, log/replay/report
   presentation, recovery after every durable boundary and priced batching E2E.
6. Remove the priced-runtime bypass only after that full path is verified.

The Goal is not complete at this checkpoint. No production 2099 configuration,
database, process, watchdog, release or model dependency is changed by this work.

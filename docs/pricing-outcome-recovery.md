# Outcome persistence retry and suspected-orphan review

This is an undeployed [pricing Goal](pricing-engine-goal-spec.md) checkpoint.
It improves recovery without retrying paid provider work or changing budget policy.
It does **not** complete general reconciliation, operator resolution or the Goal.

## Separate the failure boundaries

| Durable evidence available | Behavior |
| --- | --- |
| Reservation, no dispatch, expired synchronous lease | Existing proven-undispatched reclamation may release the hold. |
| Retained runtime outcome, original receipt/intent delivery pending | Replay the exact durable body through the immutable ledger writer; conflicting variants remain quarantined. |
| Dispatch, but final usage/outcome missing | Keep unknown cost and the hold; record a suspected-orphan review case after lease expiry. Never infer zero. |
| Terminal attempt receipts, no logical budget decision | Costs remain readable, but the hold cannot be converted into a debit merely by guessing which response won. Record a missing-decision case. |
| Immutable settlement intent, budget application pending | Replay the existing intent transactionally and idempotently, under original price/FX evidence. |
| Later supplier evidence changing a settled cost | Existing linked corrections are required; never replace an immutable original receipt. |

Lease expiry proves neither that a process is dead nor that a provider did not
charge. A case is an observation requiring reconciliation, not authorization to
release a hold, resend a model request or charge an inferred successful response.

## Bounded pre-durable retry buffer

[The buffer](../src/pricing/pricing-outcome-retry.ts) retains only finalized cost
computations, terminal budget payloads and their scoped IDs. It does not retain
request contexts, prompts, response text, provider secrets, raw headers or retry
closures. A copy is captured before the first await; caller changes and a writer
mutating its argument cannot change the queued decision. Per-key concurrent
writes and overlapping sweeps share an in-flight operation.

Limits are 1,000 entries, a **16 MiB serialized-payload budget**, and 256 KiB per
entry. This is not a claim that JavaScript heap overhead is exactly 16 MiB.
Transient failures back off from one second to at most 60 seconds; the existing
30-second maintenance cycle retries at most 100 eligible entries per pass. Local
pending outcomes retain their metadata-only lease until persistence can resume.
Permanent integrity/scope conflicts are quarantined, not repeatedly overwritten.
Distinct bodies now have separate hash identities, including an incoming variant
that races a still-running first writer. Memory reviews retire only after durable
archive acknowledgement; archive failure preserves the memory copy.

At capacity, a new priced reservation fails before provider dispatch with a 503
accounting-backpressure error. Already-dispatched outcomes still receive a direct
write attempt. If an oversized/overflowed outcome cannot be persisted, only its
durable dispatch/hold is guaranteed to survive; the overflow is reported and later
orphan review is required. Do not describe that condition as successful settlement.

Successful terminal-intent persistence hands ownership to the durable replay
worker, even if immediate budget application fails. A receipt already repaired by
that intent can be retried idempotently. Local-cache confirmed upstream zero and
its separate logical-budget amount use the same retry path. Shared embedding
batch outcomes remain owned by the existing atomic group coordinator, not split
into independent member writes through this buffer.

Shutdown waits for the maintenance run and attempts one bounded forced flush.
That is best effort, not a durable filesystem spool or a guarantee that all
in-flight requests drained. A process loss **before** the outcome reached a durable
boundary can still lose that in-memory outcome. The surviving dispatch then
becomes an explicit unknown case; it is not silently reported as a known cost.

## Durable runtime inbox (subsequent 008 checkpoint)

The internal runtime now writes an immutable allowlisted outcome and mandatory
retention audit before original receipt/intent delivery. A fresh process can
replay pending bodies through the existing ledger without provider calls or
repricing. Differing variants and batch/async ownership are retained for review;
GET inventory/detail endpoints are read-only and scope/role checked. Delivered
means accepted by the receipt/intent writer, not invoice confirmation or final
budget application. See [runtime outcomes](pricing-runtime-outcomes.md) for the
schema, bounds, transition audits and precise remaining evidence-loss boundary.

Receipt/intent delivery and its mandatory `delivered` acknowledgement now share
one transaction. Initial retention still commits independently first: an
acknowledgement failure rolls back delivery, not the retained evidence. A fresh
worker can replay that evidence, and older receipts whose acknowledgement was
lost remain recoverable. Final budget application still uses its separate
idempotent settlement-intent boundary; a delivered marker does not mean the
budget has already been applied.

On SQLite, the runtime gives pending network I/O one event-loop turn after the
initial retention transaction and connection fence have completed, before further
delivery work. It does not sleep for a fixed duration, hold a transaction while
yielding, defer the first durable copy, or make budget application optional.
PostgreSQL retains its existing asynchronous database behavior.

## Additive migration 006

Explicit `pricing-engine-006` adds `pricing_recovery_cases`. Definitions and
checksums of steps `001`–`005` remain unchanged; the migration tests pin all five
earlier checksums and exercise a real `005`→`006` upgrade. No startup hook applies
this migration and no live database has been migrated. A missing 006 table with
a surviving marker is a conflict, not permission for automatic schema repair.

Each case is keyed by reservation and retains workspace/request scope, reason,
evidence hash, revision and observation/resolution timestamps. Its private
evidence contains attempt IDs/state/hashes and reservation/lease metadata, not
duplicated response payloads or price-book bodies. Updating an observation does
not modify the underlying immutable monetary evidence.

The internal bounded sweep locks and rechecks each reservation and its attempts.
It excludes active leases, existing terminal intents, job-linked reservations,
and non-synchronous media-task footprints even when no supplier job ID was
received. It distinguishes unknown attempt outcomes, missing budget decisions and
invalid immutable evidence. New cases are considered before existing cases;
`checked_at` rotates existing observations without bumping the evidence revision
on every unchanged pass. No budgets are debited or released by this sweep.

When an actual late terminal intent is applied, its budget effects, log projection
and case resolution share one transaction. Failure leaves the case open. An
idempotent replay does not repeatedly increment a resolved case's revision.

## Read-only API and evidence

`GET /api/dashboard/pricing/recovery-cases` requires operator/admin access and
returns at most 100 open cases for the current authorized workspace. It neither
runs a sweep nor mutates budget state. Private `evidence_json` is omitted. Cost
details include the corresponding `recovery_case` summary per reservation,
including a resolved case when present. These views are observations, not a new
supplier-invoice confirmation state.

The subsequent [audited internal-budget recovery](pricing-budget-recovery.md)
adds fresh group inspection, administrator preview and atomic hold resolution.
Those operations do not invent missing supplier usage. The GET described here
remains read-only; an explicit budget decision is a different operation.
The seven-language budget-only Dashboard, scoped paginated inventory and
read-only proposal acknowledgement are now implemented. A released budget can
still appear in the unresolved-provider-cost inventory; these are separate states.
The subsequent [missing-usage API](pricing-usage-recovery.md) can now record an
administrator-attested first receipt under the original request price snapshot,
including manifest-backed complete physical groups. It changes neither the
budget decision nor a prior receipt and does not discard differing queued
supplier evidence. Its seven-language Dashboard input is now implemented;
authenticated supplier ingestion remains separate work.

Relevant evidence:

- [Buffer tests](../test/unit/pricing-outcome-retry.spec.ts): copies, exact retry,
  backoff, concurrency, quarantine, capacity, overflow and bounded forced flush.
- [Ledger tests](../test/unit/cost-ledger.spec.ts): SQLite WAL/PostgreSQL cases,
  conflicting evidence, active/async exclusions, fair sweeps, atomic late
  resolution and an actual isolated child exit after dispatch without intent.
- [Migration tests](../test/unit/pricing-schema.spec.ts): preserved earlier
  checksums, explicit upgrade, repeated inspection and missing-table rejection.
- [Real HTTP tests](../test/e2e/pricing-runtime.e2e-spec.ts): simultaneous receipt
  and pre-durable intent failures, original-price replay after publication,
  deduplication after intent repair, no-extra-dispatch backpressure and scoped
  read-only operator visibility. All provider traffic is mocked.

## Remaining acceptance work

- Complete supplier-evidence reconciliation and its operator workflow.
  Missing-first-receipt administrator attestation is implemented; existing
  terminal unknown/partial receipts now have the [single-attempt correction
  API](pricing-attempt-corrections.md), while shared batches retain their existing
  conserved correction path. The individual correction input UI is verified.
  Durable runtime retention/replay and administrator-selected independent receipt
  [disposition](pricing-outcome-disposition.md) are now implemented. Dedicated
  operator UI and full group/task disposition remain open.
  The seven-language budget-only UI, paginated inventory and audited
  preview/resolve with fresh group CAS and retirement of
  superseded queued budget decisions is now implemented; it does not resolve
  quarantined usage receipts or authorize invented provider evidence.
- A final pre-durable process-loss strategy and acceptance of its evidence-loss
  boundary; this in-memory aid must not be called a complete durable outbox.
- Trusted supplier event adapters, unknown media-job reconciliation and automatic
  correction delivery; never blindly regenerate a lost job.
- Case lifecycle under older-binary writes or owner resumption, retention,
  storage/index and performance measurements, remaining database writers,
  reporting/coverage UI and full candidate acceptance.

Until those and all other Goal requirements pass, the Goal remains active and
must not be labelled `READY_FOR_REVIEW_NOT_DEPLOYED` or deployed.

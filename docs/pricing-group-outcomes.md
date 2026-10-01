# Complete-group runtime outcome custody

Implemented in the isolated candidate, **not deployed and not full Goal
completion**. This extends durable accounting recovery to physical embedding
batches and undispatched cancellation cohorts. It does not implement the complete
group-review UI, authenticated supplier imports or the async media task lifecycle.
See the [Goal Spec](pricing-engine-goal-spec.md) and
[implementation progress](pricing-engine-progress.md).

## Durable boundaries and monetary meaning

1. The existing dispatch transaction fixes every physical member and its immutable
   manifest before a shared provider call.
2. The group inbox atomically retains the complete allowlisted document, all
   related reservation links and a required custody audit. No member cost or
   budget changes at this boundary.
3. Delivery passes the retained document identity into the existing complete-group
   writer. All physical shares and eligible terminal intents commit together;
   no subset of the physical allocation is adopted.
4. The existing durable settlement worker applies each logical budget intent
   idempotently. A retained or delivered inbox row is not a second cost, a supplier
   invoice or proof that every budget application has already completed.

An earlier audited operator budget decision still takes precedence over a stale
live budget proposal. Genuine physical cost can be retained/delivered without
reapplying the superseded proposal. Review of that distinction uses the original
ledger and operator audits, not a sum of every retained variant.

The first SQL retention boundary survives a process exit. Failure before it
remains a pre-durable failure: the live coordinator retains memory and renews its
holds, but process loss can still leave only an ambiguous dispatch. This checkpoint
must not be described as a disk spool or a complete process-loss solution.

## Separate phases, not separate physical shares

A failed credential attempt first produces a cost-only complete physical receipt.
Later a subset of cancelled members, or the complete terminal cohort, may have
logical budget decisions. These are legitimate phases of the same physical call.

The subject includes the physical identity and the declared terminal-member set.
Adding terminal decisions does not by itself quarantine valid progress. A different
body for the same subject is retained separately for review; immutable original
receipts/intents still reject overlapping contradictory decisions. Every phase
carries the complete physical allocation even if not every member is logically
terminal yet. Receipt completeness is not weakened into per-member acceptance.

Receipts carried from earlier attempts must match already durable original
receipts, unless they also belong to the current complete primary group. An
unrecorded historical share is retained for review, not adopted independently.
Missing/changed prepared manifests and asynchronous ownership similarly block
automatic replay. Legacy allocation weights are never guessed.

## Lossless representation and privacy

The retained representation stores shared physical computations/manifests once,
and uses hash-addressed costs for references in terminal payloads. Expansion
reconstructs the original cost values and verifies their hashes, existing
allowlists and deterministic allocation. Canonical terminal receipt ordering and
nullable error fields do not rewrite the monetary evidence or original ledger.
Unused dictionary entries, unknown/private fields, invalid references, unsupported
shapes and non-finite values are rejected. This is metadata only: no embedding
inputs/vectors, prompts, model responses, provider headers or credentials.

The current bounds are explicit:

- Up to 1,024 primary members and 4,096 related reservation links.
- Up to 16,384 referenced cost variants.
- At most 16 MiB of compact JSON and a conservative 64 MiB traversal/reference
  expansion allowance. Traversal is stopped before shared references can expand
  into an unbounded string/tree; a compact-body limit alone would be insufficient.
- Existing per-receipt and allocation limits still apply.

A size rejection does not fabricate zero cost or authorize a paid retry. Maximum
batch sizing, live memory retention, metadata amplification and measured production
capacity still require the final performance/pre-durable-loss acceptance. These
limits do not claim that every theoretical maximum fits every combination of
price rules and historical receipts.

## Concurrency and review custody

The inbox locks all declared request owners in sorted order before delivery or
state transitions. Both direct group writers verify the exact retained identity
inside their write transaction, before any member mutation. Corruption quarantine
uses the separately retained bounded roster to keep request-first lock ordering.
It preserves the observed bytes and records an integrity observation instead of
repairing or trusting corrupt financial content.

Custody, reservation links and audits are atomic. A transient delivery failure
keeps the document pending with bounded replay/backoff; repeated or lost
acknowledgements do not duplicate receipts or budget effects. Quarantine is
monotonic with respect to a delayed delivery acknowledgement: a caller must not
report successful delivery merely because its target write completed earlier.

The live coordinator can retire a memory entry only after a positive durable
review acknowledgement. Its custody-only completion stops ordinary pipeline
bookkeeping and lease renewal without applying the proposed budget, releasing a
hold or asserting a supplier charge. The database reservation remains available
for review. This prevents an already archived conflict from keeping a live lease
renewing indefinitely. The subsequent disposition API does not yet complete the
dedicated group UI, reconsideration or supplier/task workflows.

Undispatched cancellation cohorts use the same retention mechanism, but automatic
replay permits only zero-quantity releases with no dispatch/job ownership. A racing
real dispatch or carried usage forces review rather than a blind refund.

## Read-only operator APIs

Existing Dashboard authentication, workspace scope and operator/admin permissions
apply; viewers are denied. GETs do not deliver, settle, correct or call providers.

- `GET /api/dashboard/pricing/runtime-group-outcomes` accepts `state`, `limit`
  (1–50) and a workspace/state-bound keyset cursor. Its listing is metadata only.
- `GET /api/dashboard/pricing/runtime-group-outcomes/:id` verifies custody and
  returns the compact document and complete related roster with `read_only: true`
  and `supplier_confirmed: false`. A foreign workspace receives 404.

Pending replay also loads metadata first, then one bounded body at a time; it does
not preload a page of large group documents. The admission backlog bound counts
these pending/review rows together with undisposed independent runtime outcomes.
Already-dispatched work is still allowed to attempt retention.

These APIs are not an all-traffic cost report, a supplier callback or the existing
independent-receipt disposition UI. Do not total alternative bodies as extra fees.
The subsequent [complete-group disposition](pricing-group-disposition.md)
implements an independent administrator accept/reject API with original price/FX,
all-member authority/CAS, budget epochs and required audits. The dedicated group
UI remains unfinished. A decision is projected separately without changing this
custody document or implying supplier confirmation.

## Migration and evidence

Explicit migration 010 adds the group inbox and reservation-link table. Every
migration 001–009 retains its original checksum. Migration planning, upgrades,
constraints and missing-marker/table refusal are tested in isolated databases;
no automatic startup repair or live migration is performed.

The cross-database contracts cover complete retention, atomic required audit/link
failure, member-intent rollback, independent concurrent writers, reversed arrival,
real child exit after retention, exact lost-ack replay, variant custody, phase
progression, scope, missing manifests/async exclusion, prior receipt authority,
corrupt bytes, expansion bounds, undispatched releases, backpressure and keyset
inventory. Existing conserved correction and batch runtime tests remain in place.
Actual HTTP tests add recovery through a fresh ledger without the memory
coordinator, custody-only lease retirement/permissions and explicit pre-retention
failure behavior, with no additional model call. All providers are mocked.

Final full-regression/source/process evidence is recorded in
[progress](pricing-engine-progress.md). Dedicated group disposition/UI, complete
media/supplier recovery, final old-writer/pre-durable boundaries, source/parent
inheritance, all-traffic reports, retention/performance/Linux/Docker and fixed-source
candidate delivery remain part of the full Goal.

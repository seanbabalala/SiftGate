# Reviewed disposition of retained runtime evidence

Status: undeployed development checkpoint, **not complete Goal acceptance**.
This builds on [retained runtime outcomes](pricing-runtime-outcomes.md) and reuses
the exact append-only correction/budget machinery. It does not authenticate an
external supplier receipt or turn local calculation into invoice confirmation.

## What an administrator decides

An inbox entry in `review_required` can receive one immutable reviewed decision:

- **`accept_receipts`**: adopt the complete set of supported independent attempt
  receipts carried by this entry. A missing first receipt is recorded; an existing
  different receipt receives a linked correction; an identical effective receipt
  is acknowledged without another correction. The retained document is not edited.
- **`reject_evidence`**: record that this entry was not selected. Keep its bytes,
  hash and original review state. Do not infer zero supplier cost, refund money,
  release a hold, change a budget decision or delete any existing cost evidence.

For an entry containing a settlement proposal, acceptance selects **receipts
only**, not its proposed amount, token debit or winning attempt. A proposal with
no receipts can be rejected but cannot manufacture receipt evidence. A missing
first receipt or a correction to a released/unresolved hold does not implicitly
choose a budget outcome; use the separate audited budget workflow if needed.

Shared physical batches, allocation failures, asynchronous ownership, non-provider
attempts, active leases and pending immutable intents remain with their dedicated
lifecycle. This generic workflow cannot accept a partial physical share or force
an owner to relinquish work. The backend accepts at most 128 independent receipts
per selected outcome, with bounded related/history inspection. Dedicated group
and task disposition is still required for the full Goal.

## No client-supplied money or provenance

The client supplies only an operation ID, action, fresh basis/outcome hashes,
reason and explicit confirmation. It cannot supply rates, cost, quantities,
actor/workspace, a provider-source label or modified receipt content.

Before accepting a retained computation, the service restores the original
request catalog and FX snapshot, original attempt target and legacy price/version
where applicable. It verifies normalized disjoint quantities and immutable
dispatch metadata. Then it reproduces the **exact retained cost hash** with the
shared calculator. Changed current prices or removed current FX do not affect it.
Unsupported calculator versions, inconsistent amounts, altered targets/dispatch,
or unreproducible computations cannot be accepted merely because an inbox hash
exists. Rejection preserves such validly retained evidence without applying it.

Older traces did not retain the two selection-estimated booleans. Verification
enumerates their finite combinations only to reproduce the exact existing body;
it never changes the retained quality, quantity, rate or source to make it fit.
`gateway_runtime` remains an internal capture source. Administrator selection
does not upgrade it to an authenticated external supplier or invoice source.
The result always carries `supplier_confirmed: false`.

Original receipts, original budget intents and earlier adjustments stay intact.
Existing request outcome/error codes are preserved during cost correction; an
accepted initial receipt uses its retained error evidence. A cost decision is not
an outcome-success override. A reported-model observation can differ in the new
append-only receipt, but immutable dispatch/credential/route metadata cannot.

## Preview, concurrency and atomicity

The basis binds the selected immutable outcome, related alternatives and their
decisions, original request snapshot, reservation/lease, current attempts and
correction chain, terminal intent and task footprints. Siblings are alternatives,
not additional charges. New evidence or an intervening manual correction requires
a fresh basis; the API does not silently select the latest variant.

Preview uses the same exact correction/epoch calculation with persistence disabled.
It does not write receipts, budgets, audits, disposition rows or log projections.
It reports each receipt's operation, previous/new cost, signed logical-budget
changes and original-period allocations. Old-period credits are not promised
against today's reset balance. Unknown revised costs do not imply a zero refund.

Apply locks and rechecks the request/reservation/attempt/intent and fresh basis.
Every selected receipt change, applicable exact-budget delta, mandatory decision
audit, immutable disposition row and request-log projection commits together.
Failure of any member, audit, disposition insertion or log projection rolls back
the transaction. New first receipts and cost-only unresolved corrections do not
invent a logical winner or debit the retained settlement proposal's money.

Operation IDs are scoped to workspace and bound to actor, outcome and full input.
An exact retry returns the original verified result even after a newer correction;
it cannot move effective history backward. An ID reused for another outcome,
actor or different action/reason fails. Read-only acknowledgement checks retained
custody, required audit and each original receipt or linked revision, not only a
success flag. The source entry stays unchanged and the disposition is separate.

Current runtime receipt/intent delivery carries its inbox identity into the
original ledger transaction. A reviewed decision fences a delayed writer under
the request lock, including a settlement that started waiting before rejection.
This does not claim every older binary or all batch/task writers participates in
that fence; the broader older-writer/resumed-owner lifecycle remains open.

## Additive migration and inspection bounds

Explicit migration `pricing-engine-009` adds
`pricing_runtime_outcome_dispositions`. A primary outcome reference and unique
workspace/operation ID prevent competing final decisions. The result and audit
hashes bind its immutable action and effects. Steps `001`–`008` are unchanged.
Normal startup does not migrate, and no production database has been modified.

Inspection bounds include 128 selected receipts, 4,096 related attempts/revisions/
outcomes, 1,024 task footprints, an 8 MiB selected-history prefetch bound, and
4 MiB basis/result responses. Unrelated attempt bodies are not fetched solely to
build the freshness view. Oversized/unverifiable history fails explicitly rather
than returning a truncated financial review. These bounds are not a substitute
for the final retention, indexes and performance acceptance.

Inbox inventory shows the decision separately from the original `review_required`
state. Durable-backlog admission excludes entries with matching disposition/audit
identity; absent audits remain unresolved for that safety check. This does not
delete history or set supplier cost to known. There is no automatic purge or
implicit reconsideration of an immutable decision.

## Dashboard API contract

Base: `/api/dashboard/pricing/runtime-outcomes/:outcomeId`.

| Endpoint | Authority and behavior |
| --- | --- |
| `GET /disposition-basis` | Operator/admin; bounded read-only retained/current evidence and freshness hash. |
| `POST /disposition/preview` | Admin; no-write exact cost/budget preview. |
| `POST /disposition` | Admin; atomic audited decision and supported receipt effects. |
| `GET /dispositions/:operationId` | Operator/admin; read-only acknowledgement, including after a lost successful reply. |

The POST body is `{ id, action, expected_basis_hash, expected_outcome_hash,
reason, confirm: true }`. Existing Dashboard sessions, workspace scoping, RBAC,
JSON-write and trusted-origin checks remain authoritative. Viewers cannot inspect
these operational evidence endpoints. The generic inbox still has no public
supplier-ingestion endpoint. The seven-language dedicated disposition form is implemented below; it does
not replace the separate manual quantity-correction workflow.

## Dashboard workflow

**Pricing → Retained evidence** opens the lazy `/pricing/outcomes` inventory.
The same entry is linked from budget recovery. Its states describe original inbox
custody/delivery, not invoice confirmation. The separate disposition badge shows
whether a decision was recorded without changing the original review state.
Scoped cursor navigation displays 20 rows per page; the page never totals variants
as additional charges. Pending/delivered entries explain why they cannot receive
new review decisions here.

Open an entry at `/pricing/outcomes/:outcomeId` to compare current, original and
retained usage/calculation, receipt/document hashes and error evidence. All
quantities are read-only. Independent members are paged for inspection, but every
member remains part of server preview and client verification. The twelve-member
browser case verifies that the second page is not omitted from acceptance.

1. Select **Accept all supported receipts** or **Do not select; retain evidence**
   explicitly, and provide a reason without prompts or secrets. No amount or
   quantity can be edited here.
2. Preview the server-calculated decision. Acceptance shows each initial/linked/
   already-recorded operation, exact old/new costs, signed budget deltas and
   original-period allocations. Rejection displays no financial effect and warns
   that nonselection is not a refund, hold release or zero supplier cost.
3. Confirm separately before applying. Action or reason edits invalidate preview
   and consent. Changed siblings or evidence return a conflict; the draft is kept
   and requires an explicit basis reread rather than automatic overwrite.
4. Ambiguous writes freeze the original ID/body. This tab stores a bounded,
   versioned workspace/actor/outcome-scoped record containing only that proposal
   and compact verified preview. Reload resets consent. Exact retry and read-only
   acknowledgement verify action, outcome, every member/error/receipt hash,
   original signed budget allocations and linked adjustment/application identity
   before declaring success and clearing the record.

Already-disposed entries offer verified acknowledgement without a new proposal.
Operators inspect and acknowledge; only administrators submit, and viewers are
denied. Active leases, existing intents and dedicated batch/task ownership remain
blocked. Feedback and previews receive focus/scroll assistance; dirty/busy
navigation uses the shared pricing guard. No arbitrary provider response fields
are retained in browser storage, and this tab-local aid is not durable accounting
storage.

A restored pending editor still waits for the first basis attempt. If that attempt
fails, it remains usable for exact retry/acknowledgement. Refetch after successful
acknowledgement must not unmount it and restore stale pending state. Browser fault
injection exposed that loading-branch bug; the corrected shared pure helper is
used by disposition, single-attempt correction, missing-usage and budget recovery.
Its initial-wait/refetch cases are tested, and the real disposition flow verifies
that the success state survives a failed-basis acknowledgement and subsequent
successful basis refresh. Earlier three workflows retain their prior browser
coverage; this is not a claim of fresh end-to-end execution of all their failures.

## Verification and unfinished work

Isolated unit contracts run on SQLite WAL and PostgreSQL, including independent
connections and real child exit after commit. HTTP contracts use mocked providers
and verify exact log/budget effects, no-write preview, uncertain-reply retry and
acknowledgement, rejection custody, conflicts, role/origin enforcement and required
projection rollback. Migration tests preserve prior checksums and rehearse a
populated 008 inbox upgrade without altering its bytes or accounting history.

The isolated browser fixture makes zero model calls. It exercises inventory
pagination, current-period lost response/reload/same-ID retry, rejection plus
read-only acknowledgement and later acknowledged inspection, real sibling conflict
with retained draft/reread, twelve-member initial receipt acceptance, old-period
refund with unchanged current counters, operator/viewer and active/intent/state
restrictions, action/reason consent invalidation and failed-basis recovery.
Synthetic table snapshots verify no-write previews/acknowledgements, one effect per
decision, all-member custody and no automatic use of the stored budget proposal.

All seven locales were measured at actual **1200/640/375 CSS-pixel** detail widths,
plus 375-pixel inventory widths, with no page/main overflow or clipped detail
header/title controls. Narrow dark screenshots were inspected. The test browser
had a 75% page zoom: the final harness measures `innerWidth` and adjusts its test
viewport rather than equating requested viewport pixels with CSS pixels. Earlier
measurements and unsupported-settings/duplicate-dialog fixture errors are retained
as historical diagnostics, not the final layout proof.

Still open: authenticated supplier adapters; complete physical-group and task
disposition; corrupted-source operational handling and broader reconsideration
lifecycle; pre-durable process-loss strategy; all older-writer/resumed-owner
boundaries; report/coverage integration, source/parent governance, remaining
writers, retention/performance, Docker/Linux and fixed-source candidate gates.
The full Goal remains active; nothing is deployed or authorized to restart 2099.

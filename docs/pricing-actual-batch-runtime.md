# Actual-upstream embedding batches — development integration

This connects the actual-expense policy to independent and physically batched
embedding requests. It is part of the unfinished [pricing Goal](pricing-engine-goal-spec.md),
not deployment authorization or a claim that media/Realtime acceptance is complete.

## One physical computation, all paid attempts

The coordinator continues to price each physical invocation once under its frozen
price/FX policy and allocate it deterministically. Actual-budget contributions
count only each logical member's verified allocated share, not the nested physical
amount again. Paid credential/outer retries, cancelled members and missing result
slices do not become free merely because the logical response failed.

An explicit `actual_upstream` policy is now accepted for `embeddings`. Legacy
budget semantics remain unchanged when the field is absent or selects legacy.
Batch grouping already incorporates frozen policy and budget identity; it never
combines incompatible workspaces or policy snapshots.

Only committed dispatch IDs enter the runtime cohort. A failed grouped preparation
does not create fictional paid attempts. The coordinator owns finality while a
physical call is active; ordinary pipeline bookkeeping cannot apply a second
logical debit or prematurely close its member. Cancelled queued work remains
undispatched, while a cancelled in-flight member retains its original share.

## Durable grouped closure

`actual_budget_closure_group` is an allowlisted compact outcome in the existing
group inbox, using the same workspace ownership, complete member links, retained
audit and bounded decoding as other group evidence. No new migration is added.

Final receipt custody and finality custody are retained separately before delivery.
Closure entries normally contain only the reservation and full attempt IDs; they
do not duplicate every nested physical receipt. A fresh ledger can replay these
records without the original in-memory coordinator or another provider call.
Every closing member's fence, ready budget debit and group-delivery acknowledgement
commit in one transaction. A second-member or acknowledgement failure rolls the
transaction back while preserving the retained body. Unknown members remain
reserved instead of receiving guessed-zero terminal links.

Single and grouped closure delivery share the same original-policy, complete
population, immutable receipt and cohort validation. Existing operator authority
cannot be replaced by a late runtime closure. Replaying a delivered actual closure
also validates the existing application rather than repeating its budget effect.

## Custody, corrections and evidence quality

Initial actual settlement now checks the group's full document, member links,
dispatch/manifest ownership and audit, not merely a group ID. Pending or conflicting
undisposed custody blocks settlement. The caller's held request lock fences
cooperating full-group writers, so single-hold inspection does not acquire sibling
locks in an inverted order. Explicit dispositions remain separate from proof of
zero supplier expense; missing-dispatch uncertainty is preserved.

Closed actual cohorts provide authority for complete physical cost corrections,
including those whose initial expense is still unknown. Administrator quantities
remain estimated; trusted later observed evidence can reconcile all allocated
members through the existing exact correction ledger. Original intents, receipts,
physical cost identities and budget periods remain intact.

An uncached-input tariff cannot be treated as observed when the response omits
cache evidence. An isolated HTTP diagnostic showed that the same synthetic prompt
total remains pending without cache counters and settles with explicitly reported
zero cache counters. The first expanded HTTP test run failed six new expectations
that incorrectly assumed this evidence was complete. The generic provenance guard
was retained; fixtures now distinguish complete evidence from that missing-counter
case. This is not a claim that every embedding provider uses the same cache schema.

The next HTTP regression exposed two implementation defects: the bulk administrator
correction path still retained a client-provided observed quality label, and an
exhausted outer retry submitted physical shares again through the single-outcome
receipt path. Administrator correction now explicitly normalizes present counts
as estimated and null counts as missing. Single-hold finality retains all attempt
IDs but leaves physical receipts in their original full-group custody; it does not
weaken the independent-receipt quarantine or infer free failures. Both failed runs
and the isolated all-failed diagnostic remain part of the evidence history.

## Remaining acceptance

The grouped-write, real HTTP, retry/cancellation, corruption, correction and
recovery checks remain tied to their recorded source checkpoints. A new inbox kind
is exposed in the seven-language group inventory. Broader browser scenarios,
full-source regression, final image and performance evidence still need completion.
Media and remaining Realtime policy work are not waived by embedding support.

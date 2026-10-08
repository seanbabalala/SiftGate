# Actual-upstream expense adjustments

This connects corrections to the current text-runtime prototype. It does not
complete the remaining batch/media, operator budget-resolution, seven-language
configuration, performance or deployment requirements of the pricing Goal.

## Three distinct views of evidence

1. **Original receipt and initial applied plan:** immutable. The first actual
   debit may include corrections received before initial settlement; its per-member
   cost hashes identify exactly which revisions were included.
2. **Budget-accepted evidence:** the initial contribution for each attempt plus
   its latest applied correction. This is reconstructed across the complete closed
   cohort, including paid failed attempts, without reading current prices or FX.
3. **Latest reported evidence:** may be unknown or estimated and can differ from
   what has actually been applied to the budget. Such a difference stays pending.

An observed correction to a failed attempt changes that attempt's share, not the
successful winner's entire fee. The same exact planner verifies the full cohort
before and after a change. The sum of immutable applied deltas must reproduce the
accepted cohort; a rehashed total without corresponding evidence is not sufficient.
Other attempts with pending estimates retain their previously accepted values
while an independently confirmed change is applied.

## Existing records, no new migration

The implementation reuses the closed-cohort table from016 and existing per-attempt
cost-adjustment/application histories. No migration017 is introduced for this
flow. Original attempts, the closure, the initial terminal intent and initial
budget debit remain unchanged. New adjustments have explicit signed cost/token
deltas and use the original budget allocations, including their old-period scope.
An old-period refund does not automatically free capacity in the current period.

Corrections before initial settlement retain a pending application marker and do
not independently debit the budget. If later complete observed evidence permits
initial settlement, its contribution hashes cover those revisions. The current
pending-adjustment count does not count a revision already covered by that initial
debit again. Historical application rows are not overwritten.

Acknowledgement and audit failures roll back the corresponding budget delta and
new history together. Replaying the old closure or the same correction does not
repeat a debit or invoke a supplier. Workspace, price/FX identity, original attempt
outcome and complete membership stay fixed.

## Administrator input is still an estimate

The existing correction API continues to normalize administrator-entered quantities
as estimated, with `supplier_confirmed: false`. The new budget basis does not
promote a typed value or an evidence digest to provider-confirmed usage. Such a
correction can be recorded and displayed, but its actual-budget delta remains
pending until adequate observed evidence is available.

A valid closed actual cohort supplies the dispatch-finality authority, so its
correction need not wait for a stale legacy lease timer. Preview/confirmation CAS
includes the whole cohort's accepted and effective history. A concurrent correction
to another paid attempt invalidates a stale preview; independent database row
ordering does not change the CAS hash.

The text correction path has isolated SQLite/PostgreSQL coverage for failed and
successful members, estimated-to-observed transitions, pre-initial anchors,
old-period refunds, audit rollback and idempotency. Real HTTP checks cover
read-only preview, unpromoted administrator attestation and cross-member stale
CAS rejection. These are scoped checks, not full Goal or production acceptance.

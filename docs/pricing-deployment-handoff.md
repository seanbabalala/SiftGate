# Pricing deployment and recovery handoff

This is a reusable procedure, not an installation-specific deployment approval.
Release scope and performance limits are recorded in [the baseline](BASELINE.md).
Actual image identity, private configuration and maintenance approvals belong in
the installation owner's restricted records.

## Before the maintenance window

1. Verify the publisher proof, immutable image, source version and matching host tools.
2. Review database compatibility and the release's measured performance limitations.
3. Preserve caller addresses, interface bindings, API paths, business keys, ownership
   and budget/price policy; do not substitute a development fixture configuration.
4. Rehearse the upgrade and recovery on independent storage with synthetic traffic.
5. Confirm disk capacity, backup retention and a tested recovery copy outside the host.
6. Record the owner's explicit maintenance window and acceptable drain deadline.

## Approved execution

Drain accepted work and coordinate one supervisor. Verify a consistent backup,
then apply the supported migration and image/host-tool transition. Check HTTP
liveness/readiness, authentication, streaming, preserved business keys and cost
receipts before accepting the change. Never run two active writers against one
SQLite database or restart a live gateway merely to exercise a checklist.

If the target may have accepted writes, preserve the scene and reconcile before
recovery. Do not put an old image on a newer schema or overwrite newer business
data with an old snapshot. Prefer an isolated restore and explicit traffic cutover.
No general zero-downtime or automatic-rollback promise is made.

See [customer installation](customer-install.md),
[independent control](customer-control.md), [pricing operations](pricing-operations.md)
and [reliability operations](RELIABILITY_OPERATIONS.md).

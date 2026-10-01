# Actual expense recovery — development integration

This extends [internal-budget recovery](pricing-budget-recovery.md) inside the
unfinished [pricing Goal](pricing-engine-goal-spec.md). It is not deployment
authorization or proof of complete actual-budget lifecycle coverage.

## Administrator action

`reconcile_actual` is available only for holds whose original admission policy
selected `actual_upstream`. It accepts no winning attempt, token attestation,
money override or client-selected population. The normal workspace-admin gate,
reason, explicit confirmation, complete-group membership and evidence CAS apply.
Legacy `release`, `commit` and `apply_recorded` retain their existing meaning and
cannot be used to bypass actual expense accounting.

The basis includes the original budget basis, known subtotal, unresolved attempt
IDs, pending reasons and whether dispatch membership is already closed. A valid
existing cohort supplies finality without waiting for its old lease to expire.
Without a cohort, an active lease still blocks the action. Asynchronous ownership
remains with its lifecycle. Expiry is not interpreted as zero supplier expense.

On confirmation the server fences the complete recorded population. All observed
paid attempts, including failures and retries, contribute to the original-budget
settlement. A genuinely empty, undispatched population can release. Missing or
estimated costs and required missing token counters instead retain the hold.
The latter result has `next_state: reserved`; its zero applied debit does **not**
mean a known-zero supplier charge. Pending operator fences appear in the recovery
inventory even when an ordinary dispatched-orphan case did not previously exist.

## Authority and durable evidence

Operator finality is stored in the existing cohort JSON with an
`operator_authority` reference to the immutable recovery audit. This is not a
gateway runtime inbox event: the runtime wire parser rejects that authority
field. The audit result binds each action to `actual_closure_hash`. No migration
017 is required; migrations001–015 and the current016 definition are unchanged.

Audit, fence, receipts, budget effects, terminal intent and applicable decision
links share a transaction. Pending holds do not receive terminal decision links.
Acknowledgement validates terminal links separately from pending fence proof.
A historical acknowledged pending action remains valid after later automatic
settlement; it does not claim to be a fresh current-state report.

Late original worker receipts may fill the fenced population without replacing
operator finality or replaying a debit. New membership, conflicting original
receipts and newly reported missing dispatch evidence require review. Linked
cost corrections retain the existing observed-versus-estimated distinction;
an administrator estimate is never promoted to provider confirmation.

Retained single-outcome state, hashes and explicit dispositions participate in
CAS and are checked again before initial actual settlement. Undelivered/review
evidence keeps a hold pending until delivery or review. Rejecting a receipt does
not make an otherwise unknown attempt free or erase missing-dispatch uncertainty.
Polling timestamps do not invalidate an otherwise unchanged proposal.

## Original budget periods

Actual initial settlement replaces the reservation amount in its **original
rule IDs and periods**, using exact signed differences. It does not select new
rules, debit today's balance for yesterday's reservation, or redirect a refund
after a manual reset. Original historical balance rows must still exist; missing
or inconsistent balances fail the transaction rather than fabricating a refund.
Legacy logical settlement behavior is not silently changed by this action.

The first dual-database recovery regression exposed the old initial-settlement
path selecting current periods. That failed evidence is retained; the fix is a
real budget-writer change, not a relaxed expectation or a stale-test relabeling.

## Dashboard and remaining boundaries

The recovery form offers actual reconciliation instead of a logical winner.
Preview, acknowledgement, stored uncertain-operation validation and the seven
locales distinguish a recorded pending fence from a final budget resolution.
An acknowledgement describes the operation at its recorded time, not a live
budget balance. The Dashboard labels its debit and unresolved-attempt count as
historical, and provides a fresh evidence read after later automatic settlement.
Known subtotals do not imply that an otherwise complete cohort is incomplete.

Complete-group runtime custody is now verified by the
[actual embedding-batch lifecycle](pricing-actual-batch-runtime.md); pending or
conflicting undisposed evidence still retains its hold. Complete batch acceptance,
media integration, remaining Realtime
audit, complete browser acceptance of all configuration/recovery surfaces,
performance targets, final image identity and rollback deliverables remain open.
The [budget-basis selector](pricing-admission-policy.md) is now connected, with
separate scoped verification; its availability does not complete other lifecycles.

# Single-attempt receipt corrections

Status: development candidate, not deployed and not whole-Goal acceptance.
This extends [missing-usage recovery](pricing-usage-recovery.md) and reuses the
existing append-only cost adjustment and exact budget machinery. The new
administrator API corrects a **recorded terminal provider receipt**, including a
partial/unknown receipt or an earlier manual attestation. It never replaces the
original receipt, changes the recorded provider outcome or repeats a model call.

The seven-language Dashboard input and retry workflow is implemented below.
Existing [batch corrections](pricing-batch-corrections.md)
continue to own shared physical invocations; a member cannot use this API to
change its share independently.

## Scope and authority

Base path: `/api/dashboard/pricing/attempts/:attemptId`.

| Operation | Authority and behavior |
| --- | --- |
| `GET /correction-basis` | Operator/admin. Reads original/current cost, latest effective hash, revision, reservation state, eligibility and a fresh `basis_hash`. |
| `POST /correction/preview` | Admin. Computes the new cost and logical-budget difference without writing receipts, budgets, audit or logs. |
| `POST /correction` | Admin. Checks the same input, fresh basis and predecessor, then atomically records correction, budget application, mandatory audit and log projection. |
| `GET /corrections/:correctionId` | Operator/admin. Read-only acknowledgement of a committed operation, after verifying its audit, original receipt and complete revision chain. |

The POST body contains:

- `id`: a unique retry identity, reused unchanged after an uncertain reply;
- `expected_basis_hash`: from the fresh correction basis;
- `expected_cost_hash`: the latest effective receipt hash, not a current price hash;
- `reason` and `confirm: true`: explicit administrator attestation;
- `evidence`: the complete replacement normalized quantities, as decimal strings
  or explicit `null` for missing;
- optional `conditions` and `evidence_digest`, with the same allowlist and privacy
  rules as missing-usage recovery.

Evidence is not a partial JSON patch. Omitted partitions are not copied, inferred
or turned into zero. Cache input/write partitions must remain disjoint. A client
cannot send money, rate versions, a different scope/actor or a provider-authenticated
source label. All submitted quantities are `request_metadata` with estimated
quality under `administrator-attempt-correction`. A known amount still is **not
supplier invoice confirmation**. `supplier_confirmed` is always false.

The basis uses workspace-scoped request/reservation/attempt/intent locks and
bounded history inspection. Original request snapshot and receipt hashes must
verify. Active leases, pending immutable intents, asynchronous media ownership,
local-cache/synthetic attempts and shared batches block manual correction.
Missing first receipts use missing-usage recovery instead. Async task corrections
stay with their task lifecycle, not this manual override.

## Historical calculation

The service restores the admitted catalog, price, calendar and FX snapshot. It
uses the recorded node/model/operation, not today's provider configuration.
Legacy fallback requires the stored legacy price body and original version.
Changing current prices or FX cannot rewrite the historical price identity.
Physical dispatch attribution is preserved.

Current effective condition evidence is retained unless an allowed reviewed
condition is explicitly replaced. The requested tier, operation, target and
dispatch instant cannot be changed. Provider acceptance/completion require an
explicit offset and are compared as absolute instants; no wall-clock or browser
timezone guess is used. New condition evidence remains estimated. A revised
quantity may select another applicable rule **inside the same frozen version**.

Unknown revised prices/quantities yield unknown/partial cost, never an invented
refund. Explicit zero and missing remain different. Exact fractions/decimals are
used for calculation and logical deltas; old numeric log fields are compatibility
projections only.

## Budget effects are explicit and separate

| Original budget state | Correction behavior |
| --- | --- |
| Reserved, expired synchronous owner, no terminal intent | Append cost-only evidence. Do not choose a budget winner, release the hold or invent a debit. |
| Committed with this attempt as its recorded logical winner | Adjust from the last charged amount, using the existing exact budget allocation and original epochs. |
| Committed with a different recorded winner | Correct the supplier fee, not the other attempt's logical debit. |
| Released | Preserve the release; late supplier evidence does not create a new logical charge. |
| Committed but winner cannot be established, or revised cost remains unknown | Preserve the prior logical amount and retain pending-correction status. |

An unresolved hold with a cost-only correction remains `reserved`; its adjustment
application is `not_applicable`, meaning **no budget effect was applied**, not that
the whole request is resolved. The separate audited budget resolver may later
select the effective corrected winner. Its intent retains immutable initial
receipt copies, while the fresh basis includes the linked effective revisions.
It commits the corrected amount once. Future corrections then calculate from
that committed amount, not from a previously superseded estimate.

The response includes a `budget` preview: before/after logical amount and token
totals, signed deltas, application state and original scope/epoch allocations.
These are **not current account balance projections**. `current_period_refund_not_guaranteed`
is true: old usage refunds go to retained original epochs, never an unrelated
current day or manually reset balance. Missing original epochs and underflow fail
validation; previews run the same checks as applies without changing the database.

The actual correction and any applicable exact budget delta commit together. A
later missing-usage/unknown revision does not refund a guessed zero. A subsequent
known revision resumes from the last applied amount. Automatic threshold
observations remain post-commit; a preview must not emit them.

## Atomicity, history and uncertain replies

The append-only adjustment row, application hash, exact budget changes,
`cost.attempt_attestation` audit and request-log projection share one transaction.
Failure in required audit or a projection rolls back the whole operation.
Original `pricing_attempts`, original settlement intents and earlier adjustments
remain unchanged. The bounded response must fit within 4 MiB; oversized operations
fail rather than returning a truncated financial result.

The audit binds the workspace-scoped retry ID to actor, attempt and normalized
input. The persisted reason is redacted; only a digest of any review document is
accepted, never its contents, path, prompt or credentials. An audit/chain mismatch
prevents acknowledgement. An exact retry can still return its original result
after a later correction exists, without moving effective history backward or
adding another debit. Concurrent identical requests and process exit after commit
are covered by the same identity and transactional evidence.

No new migration is introduced. Explicit steps `001`–`007` retain their frozen
checksums. No production database/configuration or running service is changed.

## Dashboard workflow

Open **Request Logs → Cost details → Correct recorded usage**, or follow the
recorded member link from budget recovery. The separate lazy route is
`/pricing/attempts/:attemptId/correction`. Operators inspect the original/effective
receipts; administrators can edit. Viewers receive an explicit permission page.
The server still enforces workspace/role/origin checks on every operation.

1. Inspect the effective receipt and original history. Exact quantity strings are
   initialized from current evidence, including explicit missing values. The
   shared quantity editor supports additional dimensions and optional reviewed
   conditions without inventing cache partitions or units.
2. Enter a review reason (no prompts or secrets), and optionally an evidence
   digest. Preview computes replacement cost and exact signed logical-budget
   deltas on the server without durable writes. It shows before/after amounts,
   price/FX references, receipt hashes, formulas and original epoch allocations.
3. Review the budget boundary: a released hold is not charged again, and an
   unresolved hold needs a separate budget decision. The displayed figures are
   not current account balances. Before completion, labels say **proposed**, not
   applied; old-period refunds are not promised as current-period credits.
4. Confirm separately and apply. Editing invalidates both preview and consent.
   Active leases/pending intents keep input disabled. An evidence conflict retains
   the draft, locks submission and requires explicit reread; reread does not
   discard the reviewed quantities or reason silently.

Before POST, the form saves a minimal versioned workspace/actor/attempt-scoped
session record containing the exact proposal and compact preview. An ambiguous
reply freezes that ID/body. Reload restores the pending review with consent
unchecked. Read-only acknowledgement or exact same-ID retry must verify the
original preview's canonical cost hashes **and signed budget/epoch allocations**,
together with the persisted adjustment/application identity. An unverifiable reply
is not shown as success. Verified completion clears the session record and
refreshes affected pricing/log/budget queries. Storage failure blocks new writes;
tab storage is a retry aid, not a durable ledger, supplier proof or backup.

The route captures its initial basis before mounting the editor, but a stored
pending proposal remains recoverable when a new basis read fails. Dirty/busy
navigation is guarded; status/errors and preview results receive focus/scroll
feedback. All user-facing strings are localized in the existing seven locales.

## Evidence and remaining work

[Unit contracts](../test/unit/pricing-attempt-correction.spec.ts) run on isolated
SQLite WAL and PostgreSQL, including independent PostgreSQL connections and an
actual child exit after commit. They cover no-write preview, exact deltas, original
price retention, unresolved/released/loser handling, unknown-to-known recovery,
old-epoch refunds, underflow, audit rollback, role/scope/idempotency, active/async
exclusions and tamper detection.

[HTTP contracts](../test/e2e/pricing-attempt-correction.e2e-spec.ts) execute a
mocked provider request, then preview/correct through authenticated Dashboard
routes. They verify real budget/log changes, immutable original receipts,
lost-successful-reply retry, read-only acknowledgement, audit rollback, permissions,
origin validation and exactly one provider call.

The isolated browser fixture uses synthetic receipts with **zero model calls**.
It verifies current-period lost-successful-reply/reload/same-ID retry, old-period
refund plus read-only acknowledgement, genuine concurrent conflict/reread,
active-lease/intent exclusions, operator read-only/viewer denial, cost-only
unresolved/released previews, exact decimal/condition input, consent invalidation
and cleared retry records. Table snapshots prove preview/acknowledgement are
read-only, retries add no second budget effect, and old refunds leave current
budget rows unchanged. All seven locales passed 375/640/1200-pixel page/main
width and header-clipping checks; light/dark screenshots were inspected.

This does not complete the full Goal. Still required: retained/quarantined
supplier receipt ingestion and correction; authenticated supplier event adapters; owner-resumption and full
pre-durable-loss strategy; remaining batch/async lifecycle cases; retention,
all-traffic reporting, writer coordination, source/parent governance and M6
Docker/performance/fixed-source candidate acceptance. Manual evidence must not
silently discard a queued, different supplier receipt.

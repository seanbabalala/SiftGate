# Actual-upstream budget runtime

This is the explicit actual-expense path in the development candidate, **not a
production activation or release approval**. Supported operations and evidence
boundaries are listed below. The [operations guide](pricing-operations.md#9-choose-budget-behavior-separately-from-price)
explains configuration; the [progress record](pricing-engine-progress.md) identifies
current regression, performance and delivery status. Historical slice counts
later in this document are not the current test inventory.

## Current connected path

An optional immutable admission-policy field, `budget_basis`, accepts
`legacy_logical` or `actual_upstream`. Absence preserves legacy behavior without
adding a default field to historical normalized catalogs. Existing scoped admin
permission, catalog revision, reason, confirmation and in-flight snapshot rules
continue to apply.

Actual mode is available for explicitly selected `chat_completions`, `responses`,
`messages`, `embeddings`, image generation/edit/variation, video generation,
audio transcription/translation/speech, rerank and native Realtime operations. These are client ingress operations, not
supplier identities: a Gemini supplier is reached through those existing ingress
paths, not a newly invented public Gemini route. [Embedding batches](pricing-actual-batch-runtime.md)
use their actual allocated-expense lifecycle. Image/video tasks retain their
asynchronous receipt and whole-cohort finality requirements. Audio/rerank use the
synchronous attempt-closure path, not a new asynchronous job adapter; see
[non-token policy boundaries](pricing-non-token-budgets.md). Realtime uses its own
connection/response capture and the same durable actual-cohort settlement; see
[its custody boundaries](pricing-realtime.md#actual-upstream-policy). Broad/all-operation
and unsupported actual-policy selections are rejected rather than silently using
logical settlement. Supported ingress operations do not certify arbitrary remote
model contracts or vendor-specific asynchronous event formats.

For a connected synchronous request:

1. Admission freezes the explicit policy along with its price catalog. The ledger
   checks the reservation basis against that snapshot, not the latest policy.
2. The runtime records real provider attempt IDs and terminal receipts through
   retries. Closing a logical request first prevents new attempts and waits for
   its tracked in-flight dispatches to drain.
3. A bounded `actual_budget_closure` body is retained in the existing durable
   runtime inbox. Delivery checks exact complete membership, ownership, original
   receipt hashes and frozen policy, then records the cohort in migration016's
   `pricing_actual_budget_cohorts` table.
4. A complete observed cohort commits every known supplier attempt, including
   paid failures and retries. A failed client response is not a zero-cost release.
   Local cache hits commit supplier zero while preserving logical response usage
   and the original logical/reference computation.
5. Closure, receipt delivery, the terminal intent, budget application and required
   acknowledgement share the delivery transaction. Failure rolls that transaction
   back; the already-retained body can be replayed without another supplier call.

## Unknown evidence and recovery

Unknown or estimated expenses, required missing token counts, and explicitly
missing dispatch evidence do not become free. The cohort stays pending and holds
remain reserved. The existing internal planner retains known subtotal separately
from an unknown total. No absent media/token counters are fabricated.

A pending closed cohort prevents any genuinely new attempt even before a numeric
settlement intent exists. A later original receipt can be recorded, after which
background reconciliation revalidates the cohort and settles it once. Period,
workspace and other budget scopes come from the original retained holds.

Replay verifies the original policy and exact membership again. Applied plans are
checked against their immutable intent, reservation totals and effective evidence;
rehashing edited metadata is not authorization. Conflicting/corrupt pending
cohorts are quarantined for review so they do not block unrelated ready work.
Pending scan timestamps rotate unresolved records rather than starving later work.

## Scope and historical verification

The original text-only integration gaps are superseded by the dedicated
[actual batch](pricing-actual-batch-runtime.md), [media](pricing-media-acceptance.md),
[non-token](pricing-non-token-budgets.md), [Realtime](pricing-realtime.md) and
[cost-lifecycle](pricing-cost-lifecycle-acceptance.md) records. Each describes its
tested scope and remaining provider/evidence boundaries; operation availability
alone is not proof of a particular supplier contract.

[Actual-mode operator recovery](pricing-actual-budget-recovery.md) uses a
server-derived action and pending-fence acknowledgement. Logical winner/release
actions still refuse actual reservations. [Closed-cohort corrections](pricing-actual-budget-adjustments.md)
apply observed member deltas while estimated corrections remain pending. The
seven-language basis selector and scope-aware impact preview preserve explicit
choices across unrelated edits; see [admission configuration](pricing-admission-policy.md).

The full Goal still requires the original performance gate and final portable,
fixed-source candidate delivery. The following paragraphs preserve the earlier
prototype runs, failures and fixes. References to unfinished slices in those
historical runs do not replace the current linked lifecycle records.

The first connected slice passed233unit tests and35E2E tests with no skips,
including real HTTP opt-in, paid retries, local cache, unknown holds, policy changes
in flight and fresh-service replay, plus SQLite/PostgreSQL mutation tests. Later
hardening and broader checks are tracked separately; those counts are not a claim
that the whole feature, every operation or the final Goal is complete.

The broader scoped run subsequently passed400unit tests in9suites and96E2E
tests in6suites, with no skips, plus backend/frontend builds, lint, docs and the
existing frontend contracts/bundle budgets. It includes native Gemini supplier
usage through the actual chat ingress, all-paid-failure and SSE retry accounting,
cross-database corruption quarantine and acknowledgement rollback, and unchanged
legacy batch/media/correction/recovery paths. An earlier new test incorrectly
invented a public Gemini ingress; that failed fixture is retained separately and
was corrected to use the existing supplier adapter. Full current-source regression
and the unfinished actual-policy lifecycles remain separate acceptance work.

The first full run of the text prototype passed3342unit tests and failed two
partial-schema report tests. Adding016 exposed a latest-marker-only readiness
check:015 could be missing while016 was present. That failed run is retained and
its chained E2E/build/main checks did not execute. Readiness now checks the complete
known migration-marker set, rejecting missing/changed/unknown markers. Unmigrated
databases still use the legacy path; an incomplete installed chain produces a
structured503 before priced dispatch instead of silently falling back. Checks are
cached after initial readiness, not advertised as continuous SQL-tamper monitoring.
The full structural migration planner remains an explicit separate inspection.

The marker fix passed436unit and97E2E tests plus backend/frontend checks. Subsequent
cohort-adjustment work passed446unit and99E2E tests on its recorded source, including
real administrator estimate/CAS behavior. A later ordering hardening and full
current-source regression are still tracked independently.

## Explicit actual policy without approved bindings

Actual mode must still track attempts when no approved price binding is active.
The old compatibility bypass now applies only to the absent/legacy budget basis.
Missing prices or historical reference estimates remain unresolved for actual
budget settlement; they are not invented as zero or silently converted to logical
budgeting. A subsequent local cache hit still has confirmed supplier zero, while
its response retains the original logical usage. New price publication does not
retroactively reprice the earlier snapshot.

A real HTTP regression reproduced the old failure: explicit actual policy produced
no reservation at all, while the legacy contrast case correctly charged logical
cache tokens. The one-condition fix passed its 448-unit/101-E2E scoped regression.
The subsequent operator checkpoint passed 3,392 unit and452E2E tests, including
this case. Later selector changes have their own scoped regression and browser
evidence; the [progress record](pricing-engine-progress.md) keeps those source
identities separate rather than treating an older full run as current acceptance.

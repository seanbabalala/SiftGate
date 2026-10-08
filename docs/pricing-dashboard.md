# Pricing Dashboard — development candidate

Status: implemented editor/governance checkpoint, **not deployed and not complete
Goal acceptance**. See the [Goal Spec](pricing-engine-goal-spec.md) and
[progress record](pricing-engine-progress.md). Do not use these instructions to
change the live 2099 gateway without a separately approved deployment.

For the operator's end-to-end configuration and change-review sequence, start
with [Pricing operations](pricing-operations.md). This document provides the
deeper API, interaction and historical verification details.

## Entry and scope

The lazy `/pricing` Dashboard route is also linked from advanced node pricing.
The page uses the current authenticated workspace, with workspace identity fixed
in both the request headers and query keys. It checks scope before a request and
after the response. Backend RBAC remains authoritative.

- Missing schema displays explicit initialization guidance; opening the page
  never applies a migration.
- Viewers can inspect books and use quotes. Admins edit their authorized workspace;
  global changes additionally require default-workspace administration.
- Scoped admission and FX management are independent of individual price books.
- Draft saving never changes active prices. Publishing changes the catalog for
  newly admitted requests, not frozen requests/jobs or historical calculations.

## Price books and six editor areas

Create from an unpriced token/image/audio/video/rerank basis, copy a book, or import
a portable `siftgate-price-book-v1` document. Import is validated before creation;
files over 1 MiB are rejected. A copy/import still creates only a draft.

| Area | Implemented controls |
| --- | --- |
| Base & cache | Currency, precision, rounding, source/reference, billed dimensions, base/cache/TTL rates, explicit free, component add/replace, minimums and quantity rounding. |
| Context tiers | A16-row range table, ordered groups, priorities, inclusive minimum/exclusive maximum input, live advisory overlap checks, optional/required groups and replacement rates. Whole-request tiers only; progressive mode is explicitly unavailable. |
| Time & service | Requested/resolved tier rule values, calendar tags, time basis, timezone-data version, weekday/cross-midnight windows, date/holiday overrides, boundaries and a normalized calendar-local week preview. |
| Multimodal | Actual versus requested image/video/audio quantities, characters, rerank units, media predicates, rounding, minimum quantities and explicit combined billing. |
| Simulate & compare | Synthetic quantities, context/time/tier/media, optional simulation-only FX, shared server calculator, formula/selection trace and comparison to the latest published book version. |
| Versions & audit | Immutable version inspection, fork, export, binding/schedule view, draft publication, rollback preview, cancellation and scoped audit. |

Rates and quantities stay decimal strings. Blank is missing; explicit free is a
separate checkbox. An empty later rule can leave earlier groups' rates unchanged,
but cannot manufacture a missing base rate. Configuring a media unit is not proof
that a provider supplies that measurement. Coverage warnings must be reviewed.

The context table pages within the selected group without dropping off-screen
rules. It shows `[minimum, maximum)` and treats a blank maximum as unbounded;
blank minimums remain invalid, not zero. Select a row to edit its rates in the
existing form below. The local overlap check uses the same pure predicate and
media-value normalization as the compiler, including priority and other
conditions. A clean advisory result does not validate the whole price document.
Backend validation/publication remains authoritative. Narrow tables scroll inside
their own container; the enclosing fieldset is explicitly allowed to shrink.

For a configured calendar, **Normalized calendar week** displays the Monday–Sunday
week containing a selected local date. Preview is explicit, read-only and available
on published documents. It shows the final time tags and their override/holiday/
weekly/default origins, including previous-day carry. Dates outside coverage are
marked rather than assigned a low price. Editing the date or calendar hides the
old result until previewed again. See [calendar-week semantics](pricing-calendar-week.md),
especially the distinction between civil clock intervals and actual elapsed time
at daylight-saving transitions.

The simulator never calls a model, reserves a budget, inserts a request snapshot,
or changes history. Known subtotals remain distinct from complete totals. Quotes
are estimates/calculations, not supplier invoice confirmation. Changing inputs
marks displayed results stale. Simulation FX is not persistent FX configuration.

Published documents are read-only. Editing requires a derived draft. Local export
removes private source references, URL credentials, query strings and fragments;
it does not mutate the editor state. A published version is labelled/exported as
a version, not as a draft.

## Admission policies

Select the scope and operation before opening the policy dialog. The exact
override is edited, including an explicit inheritance option. Precedence is:
workspace operation, workspace default, global operation, global default, then
compatibility. Removal does not necessarily restore compatibility.

Modes are compatibility estimate, reject unpriced targets, and conditional
upper-bound reservation. The latter exposes precise per-attempt quantity limits
and an approved source/reference. Blank limits remain absent; requested media
counts/durations do not automatically become caps on actual output. Entering a
number is not proof of a supplier contract or adapter guarantee.

The dialog summarizes the old/new mode and limits, validates the exact proposed
configuration through an admin-only read-only endpoint, then requires a reason and
separate confirmation. A changed proposal invalidates its preview. Publication
uses the captured catalog revision; a conflict retains edits and does not silently
retry with a newer revision. See [admission policy](pricing-admission-policy.md)
for the quantity/target assessment API and guarantee boundaries.

## Persistent FX

The scoped FX schedule displays original/reporting currency, exact rational rate,
source, version and effective interval. Editing replaces the **entire selected
scope's schedule**; retain every interval still needed. Other scopes and already
frozen request snapshots are unaffected. No rates are fetched or invented.

Each row uses exact numerator/denominator strings, source, inclusive start and
optional exclusive end. Server preview rejects invalid currencies, nonpositive
ratios, overlaps and stale catalog revisions without writes. Applying requires
confirmation and creates audited new catalog/FX versions. Missing conversion rates
leave cross-currency totals unknown rather than relabelling or zeroing them.

## Legacy node editing

The node wizard keeps compact base input/output editing. Only dirty rows send
explicit base-rate patches. Editing a name or unrelated field does not promote
resolved catalog prices into node overrides. Cache/media prices and capabilities
not shown by the wizard survive a base-rate edit.

Blank/negative/invalid/underflow prices are rejected; zero is intentional. Removing
an actual override asks for confirmation and removes **all** that model's legacy
price fields, including hidden cache/media prices, while retaining capabilities.
It does not delete a separate advanced catalog binding. See the
[management API](pricing-management-api.md) for the wire contract.

## Unsaved changes and concurrency

One pricing navigation guard tracks every editor/dialog's dirty and busy state.
Links and browser Back/Forward use the supported data router's blocker. Workspace
switching is cancellable before active workspace identity changes. Unload displays
the browser's standard warning. Busy writes cannot be navigated away from in-app.
Closing a browser forcibly cannot guarantee an HTTP write outcome: reread the
resource before retrying an uncertain publication.

New server draft revisions are adopted when the editor is clean. When dirty, the
editor keeps local fields, disables writes, and offers comparison/reload. Old cache
responses cannot regress a locally saved revision. Draft queries refetch after
navigation instead of trusting a permanently cached document.

## Request cost evidence

Expand **Request Logs → Cost details** to open `/logs/:id/cost`. The page loads
workspace-scoped, allowlisted log metadata and immutable cost receipts, not
prompts, response bodies, raw headers or secrets. Log list/summary and cost-detail
queries capture the workspace in their HTTP headers and cache keys; stale-scope
responses cannot enter the next workspace's cache.

The header distinguishes upstream totals from known subtotals with unknown or
pending attempts. Logical budget holds/commitments are separate. Local cache
shows zero new upstream cost, logical token use and a **stored** reference estimate;
missing references stay unknown. Legacy rows preserve their stored estimate.

Attempt details show requested/routing/wire/reported models, credential ID (not
the secret), retry/dispatch indices, timestamps and failure codes. Computations
show exact quantities/units, formulas, rules/version/hash/FX references, service
tiers, media conditions, calendar matches, normalized evidence and rounding.
Batch shares have an expandable physical computation, not an additional charge.
Original receipts, revision history, budget deltas and actor/source remain visible.
Reservations expose cost/token holds, commitments, admission bounds/diagnostics,
known overruns and settlement state. Declared limits are conditional guarantees.

### Historical FX evidence

Expand **Historical exchange rate** under a retained computation to inspect its
exact conversion numerator/denominator, source, FX version, effective time,
request admission time and admitted catalog revision. Original and corrected
computations have their own hash-bound references. The rate is displayed as an
exact rational expression, not a floating-point approximation. Dates follow the
selected interface locale and are explicitly UTC.

The read endpoint is:

```text
GET /api/dashboard/pricing/requests/:requestId/fx/:versionId?cost_hash=<retained-cost-sha256>
```

It requires an authorized Dashboard session and the selected workspace's read
role. A consistent read transaction verifies the ledger receipt/history and
restores its immutable admitted catalog. Only a rate used by the exact retained
receipt is returned; an unused catalog ID, another workspace, another request or
a different receipt hash cannot select arbitrary FX records. The response includes
the request/snapshot identities and a hash of the display projection. The frontend
checks those identities, currencies, positive exact rate strings, times and hashes
before rendering. It does not make an external FX request.

Public source URLs lose credentials, query strings and fragments. Private hosts,
local paths and recognized secret-bearing values are omitted with an explicit
notice. Plain provenance labels are escaped text, not HTML or automatically
followed links. Sanitization changes the display projection only; the stored FX
document and original receipt hash remain unchanged.

An unknown reference returns404; invalid input returns400. Integrity failures
remain structured errors, including503 for corrupt stored pricing snapshots and
409 for a receipt/FX selection mismatch. The panel shows an error with manual
retry rather than substituting the current FX schedule. Same-currency and missing
FX cases do not issue this lookup. Missing FX is not proof of a zero conversion.
Pending estimates without a retained cost receipt are not accepted as receipt
references by this endpoint.

Verification covers SQLite/PostgreSQL consistent reads, original/corrected costs,
scope and hash mismatches, malformed snapshots, source filtering and real-session
HTTP access. Fourteen browser layouts across seven languages verify old1/7 versus
new1/5 synthetic rates, keyboard access, exact source/version/date display,
missing/same-currency behavior and rejection/retry of an altered response. Pricing,
budget, log and configuration snapshots remain unchanged, with no supplier calls
during those UI checks. Browser fixtures use synthetic no-login mode; real-session
authentication is checked separately by HTTP tests. Guarded browser runs use
fallback fonts because the external font stylesheet is blocked.

This scoped FX result does not certify every Dashboard workflow, final image or
the original HTTP performance targets.

### Historical simulation

The panel lazily loads scoped, paginated price books. Choose a draft or published
version to replay metadata. Original effective costs and simulations stay separate;
changing selection marks an old result stale. Missing FX remains unknown. A
local-cache simulation is a counterfactual reference, not a new upstream charge.
Replay never changes receipts, budgets, active prices or provider call counts.

### Batch usage correction

Only administrators see **Correct batch usage**. The dialog captures the immutable
physical hash; background refreshes cannot replace its fields or CAS basis. Edit
physical quantities, not member shares. Blank/missing is unknown; explicit `0`
is zero. The server forces administrator/request-metadata provenance, including
when a caller submits a provider-source label. Attestation is not invoice approval.

1. Enter a reason without prompts or secrets and preview the entire group.
2. Review all member costs and the new physical computation. Member costs are
   not automatically the same as logical-budget deltas.
3. Confirm, then apply. Editing invalidates both preview and confirmation.
4. Success refreshes cost/log/summary queries; original receipts remain immutable.

Ambiguous write failures freeze the proposal ID/body and fields. Retry that exact
proposal or read the recorded state. Until that read or retry, in-app departure
is blocked. A read without the proposal does not prove a previous write cannot
finish; prefer the same-ID retry. Leaving after a read requires explicit warning
and refresh before another proposal. CAS conflicts retain edits, prohibit
overwrite and require a fresh read before discarding. Forcing browser closure can
still lose local form state: review history before submitting another correction.

### Single-attempt usage correction

Recorded non-batch provider attempts link to **Correct recorded usage**. Operators
inspect; admins may replace normalized quantities under the original price/FX
snapshot. The form shows original/effective history, distinct missing/zero values,
optional reviewed conditions, and server-only cost/budget preview. No client money
or supplier-confirmation claim is accepted.

Before applying, review signed logical-cost/token changes and original-period
allocations, then consent separately. Proposed effects are labelled as proposed,
not already applied; an old refund is not a current-balance promise. Unresolved
and released holds explicitly show their cost-only boundary. Conflicts retain
fields for explicit reread; ambiguous writes freeze the original proposal and
survive reload through scoped minimal session storage with consent reset.
Read-only acknowledgement and exact retry verify preview cost hashes and budget
allocations before clearing the record. See the complete
[attempt-correction workflow](pricing-attempt-corrections.md#dashboard-workflow).

## Budget recovery

**Pricing → Budget recovery** separates internal-budget state from provider-cost
completeness. The inventory covers recorded recovery cases, not all traffic;
released holds with unknown supplier fees remain visible under **Provider cost
unresolved**. Repeated request amounts are never added as separate charges.

Operators inspect connected groups; administrators choose every pending member,
preview on the server and consent separately. Active leases are blocked, recorded
intents are immutable, full-ID winner choices remain distinguishable, and only
missing logical token counts can be attested. No client-supplied fee is accepted.
Conflicts retain edits for explicit reread; ambiguous replies lock the original
proposal. Its minimal workspace/actor/anchor-scoped session record is saved before
POST, restored after reload without consent and removed after verified completion.
Read-only acknowledgement and same-ID retry never create a second budget debit.
Session storage is a tab-local retry aid, not a durable accounting backup.

See [budget recovery](pricing-budget-recovery.md) for the bounded cursor API,
empty-batch continuation, privacy and complete workflow. Supplier-evidence
reconciliation remains separate work, not an implied ability of this page.

The group now links to a separate **Recover missing usage** form for the existing
missing-first-receipt API. It offers exact quantity strings, explicit missing/zero,
optional reviewed conditions and document digest, complete physical membership,
server preview and distinct consent. Known first receipts cannot be overwritten.
Ambiguous writes keep the original ID/body across reload; acknowledgement and
retry compare the preview's member hashes. Compact allowlisted session records
exclude arbitrary request/response fields and are cleared after verification.
No budget is changed and no supplier confirmation is claimed. See the
[usage-recovery workflow](pricing-usage-recovery.md#dashboard-workflow).

## Retained evidence disposition

**Pricing → Retained evidence** opens a separate operator/admin-only inventory
and review route. Viewers are denied. Review original/current/retained receipts,
choose acceptance or nonselection, and preview before giving separate consent.
There is no quantity or money editor. Every independent receipt is included even
when inspection uses pages; the retained settlement's budget amount is never
adopted implicitly. Rejection keeps custody and does not mean a zero supplier fee.

Exact old/new receipt costs and original-epoch budget deltas are displayed as
proposed until verified completion. Related variants are alternatives, not totals.
Conflicts retain action/reason for explicit reread. A minimal scoped pending record
survives reload with consent reset; exact retry/read-only acknowledgement checks
all member hashes/errors/epoch allocations and clears it only after verification.
Already-disposed entries read their recorded result without a second write.
See [the complete workflow](pricing-outcome-disposition.md#dashboard-workflow).

Real isolated browser evidence covers pagination, twelve-member inclusion,
no-write previews/acknowledgements, rejection custody, current-period lost-response
retry, old-period refund, sibling conflict, role/state restrictions and English
consent invalidation. The failed-initial-basis case exposed a loading-branch remount
bug: recovery wrappers now preserve a restored editor during its basis refetch,
without skipping the initial basis attempt. The fixed disposition flow was rerun
through acknowledgement and refresh with the success state preserved.

Seven locales passed detail at actual 1200/640/375 CSS pixels and inventory at 375.
The final harness measured `innerWidth` to account for the owned browser's 75%
zoom; screenshots of the narrow/dark layouts were inspected. This is targeted
workflow evidence, not full remote-origin or performance acceptance.

## Validation evidence and outstanding scope

Evidence uses disposable SQLite/PostgreSQL, synthetic rates, mock providers and
task-owned ephemeral loopback ports. Tests never use the default Vite proxy to
2099. Chinese/English, dark desktop and narrow layouts have been inspected in a
real browser. Static key/contract checks cover all seven locales.

Backend tests cover policy/FX previews with no catalog/audit/snapshot writes,
revision conflicts, permissions, overlap/invalid input and no provider calls.
Browser evidence covers long-context threshold quotes, draft/publish behavior,
policy/FX confirmation/publication, precise explicit-zero node patching, history
blocking, dirty refetch conflicts and hidden-field preservation.

The request-cost browser checkpoint covers log navigation, exact batch formulas,
original/revision history, no-write replay/preview, stale simulation selection,
preview/consent invalidation, blank/zero handling, lost-response idempotent retry,
CAS conflicts retaining edits, viewer access, cache/reference separation and
legacy estimates. Synthetic database snapshots prove one audit and one revision
per member after a lost successful response and its retry. Chinese/English,
dark desktop and 390-pixel layouts were inspected without whole-page cost/dialog
overflow. Aborted-response/409 console errors were intentionally induced.

The recovery browser checkpoint also covers connected-group preview and exact
same-ID retry after a lost successful response and a page reload; recorded-intent
read-only acknowledgement; draft-preserving evidence conflicts; active-lease
blocking; operator/viewer permissions; and preview/consent invalidation. Synthetic
table snapshots prove previews/acknowledgement do not write and a retried group
does not apply budget twice. Budget-resolved unknown fees stay separately visible.
All seven recovery locales rendered at 375, 640 and 1200 pixels without page
overflow or offscreen header controls. Narrow/dark screenshots were inspected;
English/Chinese actions were exercised. These are workflow-specific checks, not
a claim that every page or remaining media/supplier workflow is accepted.

The single-attempt browser checkpoint adds lost-successful-reply/reload/exact
retry with one cost/budget application, original-period refund acknowledgement
without changing current budget rows, genuine evidence conflict/reread, active
lease/intent exclusions, operator/viewer controls, cost-only previews and English
exact decimal/condition editing with preview/consent invalidation. Synthetic
snapshots show zero model calls and no preview or acknowledgement writes. The
seven-language route passed 21 locale/width combinations (375/640/1200), including
light/dark screenshots, with no page/main overflow or clipped header controls.

Those earlier checkpoints have since gained report/list coverage, inheritance,
admission assessment and additional scope/conflict evidence. The current remaining
UI map is in [clause-level acceptance](pricing-ui-acceptance.md); it does not treat
all earlier TODOs as still missing or every implementation as fully accepted.
The normalized calendar-week view is now implemented and separately verified.
Remaining integrated publication/import/rollback workflow evidence, original
performance and final candidate/platform gates are still separate.

Historical bundle measurement at that checkpoint: supported data-router blockers increased
shared vendor gzip from the earlier 105.96 KiB to 123.63 KiB; its previously
approved cap remains 125 KiB. Pricing measures 14.36/24 KiB, request-cost 6.22/8,
budget recovery 7.52/12, single-attempt correction 3.53/12, missing usage 4.44/12,
and the new retained-evidence inventory/review route 7.31/12. Shared cost/budget
preview components are extracted rather than duplicated. All seven pricing
locales contain 707 keys. Other bundle limits and dependency versions are
unchanged; M6 first-paint/performance and remote-origin support remain unproven.

The current range-table checkpoint defers the context table and historical-replay
module until their panels open. Frontend tests/build pass the same24KiB pricing
route and8KiB request-cost caps, measuring22.10KiB and7.17KiB respectively. An
earlier eager build exceeded those caps and is not counted as accepted. Version
and audit dates and capacity counts follow the selected interface locale. These
bundle measurements are not a substitute for Gateway HTTP performance acceptance.

## Complete-group evidence review

The dedicated lazy `/pricing/group-outcomes` inventory and `/:id` review route
are now implemented in all seven languages. This extends the independent inbox
workflow rather than treating physical shares as separately billed calls. The
inventory distinguishes original custody from the separate audited decision.
Physical groups, represented receipts, alternatives and effects have independent
inspection pagination; preview and confirmation always cover the complete
represented set. Expensive evidence tables mount only when opened.

The client verifies original/current/retained hashes, physical identity and
membership, conserved complete totals, exact adjustment/application hashes, actor,
workspace and original budget epochs. Linked revisions may change the accepted
share hash without changing the selected physical fee. Compact retry storage
contains scoped identifiers and reviewed summaries, not provider payloads or full
cost documents. Loss of the basis does not turn a rejected group's unknown member
count into zero. An uncertain operation is recovered by acknowledgement or the
same ID; it is not silently replaced with a new charge.

Initial real-browser evidence covers no-write preview, lost-successful-response /
reload / exact retry, read-only acknowledgement, all 12 missing receipts adopted
while inspecting page two without changing held budgets, and rejection of
inconsistent initial history while preserving money and custody. Accounting table
snapshots show no extra provider calls. Operators can inspect without write
controls; viewers cannot inspect the group. Seven-language collapsed-detail
layouts at actual 375/640/1200 CSS pixels pass page/main overflow and title
clipping checks; English desktop and Chinese narrow/dark screenshots are inspected.

The subsequent fixed-frontend run verifies old-period refunds without changing
current budget rows; reserved/released cost-only corrections; a real sibling409
with no accounting writes; draft-preserving reread; action/reason consent
invalidation; lost-successful-response recovery with an unavailable basis; and
foreign-workspace fail-closed navigation. It produces seven decisions, ten linked
corrections and twelve initial receipts with zero provider calls. Operator/viewer
samples from the preceding checkpoint still apply to the unchanged permission
controls. Active leases and a separately verified pending-intent fixture disable
both decisions. The latter fixture was corrected because later fixture setup had
already reconciled its supposedly pending intent; production rules were unchanged.

Client contracts now include multiple complete cohorts, independently carried
history, exact partial-historical no-ops, unknown charges, 1,024 receipts and large
exact allocation weights. Comparing whole physical totals is insufficient: the
client also verifies each selected share's full content, allowing only the linked
revision marker to differ. Rehashed attempts to redistribute a conserving total
between members are rejected.

Twenty-eight final expanded-evidence/inventory layout cases cover all seven
languages, actual 375/640/1200 CSS widths, and dark narrow layouts without page/main
overflow, title clipping or untranslated group keys. Representative screenshots
were visually inspected. Keyset pagination loads20 then3 distinct alternatives
without overlap. The final frontend tests/build pass with757 keys per pricing
locale and a10.01KiB group route under its16KiB cap; existing caps and dependency
versions remain unchanged. Backend code was unchanged during this UI verification;
its last full regression remains2770 unit/304 E2E. No new full-backend count is
claimed for the separate in-progress inheritance resolver.

This verifies this group UI checkpoint, not full M5 or the entire Goal. Trusted
supplier/task workflows, source/parent controls, all-traffic reporting and all
remaining Goal-wide compatibility, performance and delivery gates remain required.
All owned browser/backend instances are stopped after acceptance; the production
identity and protected hashes remain unchanged.

## Rule display names

The Context tiers editor supports an optional display name separate from each
stable rule ID. Selectors, inherited-rate previews, simulations and historical
cost traces preserve that versioned name. Clearing it removes only the label.
See [rule names and immutable history](pricing-rule-names.md) for validation,
compatibility and verification details.

## Keyboard navigation and dialog cleanup

The price editor's section tabs support left/right arrow navigation and native
Tab navigation into its controls. New-book and publication dialogs retain forward
and reverse Tab traversal. Closing or cancelling a dialog returns focus to its
still-connected trigger without scrolling the underlying page.

Real keyboard testing exposed a conditional-unmount bug: the former dialog root
restored focus only when its `open` prop became false, not when the parent removed
the dialog. Cleanup now restores focus and the prior inline scroll-lock value in
both cases. A closed dialog does not clear another dialog's scroll lock; detached
triggers are not focused. Six component-effect contracts cover cleanup, controlled
closing, detached/null triggers and nested last-opened/first-closed behavior.

Native-browser evidence covers seven languages at 1440px/light and 390px/dark:
14 layouts, 28 dialog traversal/close cycles, 98 tab transitions and 56 screenshots.
The new-book workflow is reached with Tab and opened with Enter, then closed with
Escape; publication is cancelled with keyboard activation. Both return focus to
their original buttons. All layouts have no whole-page horizontal overflow or
browser errors. Pricing and financial snapshots remain unchanged, with no model
calls, draft creation or publication during the interactions.

Frontend tests, type-check/build, localization and bundle checks pass. Backend
source and tests are unchanged from the separately verified 3,905-unit/704-HTTP
full checkpoint; that is not a newly rerun backend total for this frontend patch.
Older counts above describe their historical checkpoints. This keyboard evidence
does not certify every Dashboard workflow or complete the remaining performance,
platform and candidate-delivery gates.

## Editor mutation, confirmation and conflict acceptance

Deletion confirmation is now consistent for rate components, multipliers, weekly
calendar plans, time windows and date exceptions. A native confirmation must be
accepted before the local draft changes; cancellation preserves its values and
clean state. Removing the complete calendar retains its existing separate
confirmation. These local edits still need an explicit valid draft save and do
not publish a price.

An actual browser reproduced the former multiplier behavior: clicking remove
deleted the local multiplier immediately, without a confirmation. Calendar item
callbacks had the same omission. The fix reuses existing localized confirmation
text, with no new locale keys. Component-callback tests execute eight actual
removal paths with both accept and cancel and check that input documents are not
mutated. The first implementation also exposed a local variable shadowing the
browser `window`; it was corrected before the passing build/browser run.

Native-browser verification covers all seven languages at 1440×1000/light and
390×844/dark. The 14 layouts include 84 cancelled deletions and 28 accepted local
deletions. Exported JSON confirms exactly the intended multiplier or date-window
removal, unchanged other rates, and restoration of the complete original document
after discarding unsaved changes. These probes perform no draft saves, supplier
calls or publication. No page overflow or JavaScript exception was observed in
the accepted removal runs. Failed automation attempts are kept separately, not
counted as successful interactions.

Additional Chinese desktop workflows exercise:

- **Empty versus free:** a blank single rate returns HTTP400 without saving;
  explicitly checking free saves the decimal string `0` with its free flag.
- **Inheritance:** an explicit free component becomes a local override. Cancelling
  reset preserves it; confirming and saving restores the original parent recipe
  and rate without changing the immutable parent.
- **Concurrent editing:** a second fixture editor writes a newer revision with
  a different audit actor. The browser's stale save returns HTTP409, preserves its
  local values and disables another save. The comparison identifies the changed
  `content.groups` array; it is not a per-rate side-by-side diff. Cancelling reload
  preserves local edits; only explicit confirmation adopts the server revision.
- **Node-name edits:** the actual node form sends neither a capability replacement
  nor a price patch when only the name is edited. Configured cache/media prices,
  source/review metadata, inactive model capabilities and new-engine 5m/1h price
  components remain unchanged. The wizard still submits other visible/default
  configuration fields; this is not a guarantee of a name-only YAML difference.
- **Publication review:** a scheduled preview shows affected bindings and metering
  qualifications. Publishing stays disabled before consent. Changing the reviewed
  form clears the preview and consent; cancelling leaves active prices unchanged.

The only pricing-data writes in those additional workflows are four intentional
draft updates and their six audit entries, including the two inherited-recipe
records. Published versions, catalogs, budgets and call logs are unchanged;
provider calls remain zero. The node setup/name change is confined to the private
fixture configuration. All owned browser/backend instances are stopped afterward.

Frontend tests, build, localization and bundle budgets pass. Backend, dependency,
SDK, migration and test source remains identical to the prior complete
4,015-unit/734-HTTP checkpoint; those tests were not newly rerun for this frontend
change. These checks close the specific name-preservation, empty/free/inheritance
and conflict workflows. Other original UI/workflow, performance, platform and
final candidate requirements remain separate.

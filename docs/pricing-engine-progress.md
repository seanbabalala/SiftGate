# Pricing engine Goal — implementation progress

Goal status: **active, implementation in progress**.
Not deployed. Not yet `READY_FOR_REVIEW_NOT_DEPLOYED`.


## Current checkpoint: non-executed deployment/rollback handoff

The [D-10 handoff](pricing-deployment-handoff.md) consolidates current artifact
hashes/source scope, the provisional image, Rancher Moby and unchanged-2099
requirements, preservation of the user's model edit, maintenance stop conditions,
backup verification and rollback/reconciliation decisions. Its companion plan
keeps every unresolved approval and final-candidate field explicit. There are no
service, database or container execution commands in the checklist.

The document checker passes the non-executed plan but deliberately fails a
readiness requirement. Negative tests reject a changed port, fabricated approval,
unsafe binary-only rollback and widened binding policy. Fresh extraction and
integrity checks pass. Exact production protection checks are retained privately;
they do not claim that legitimate live traffic made no database writes.

D-10 is delivered as a non-executed handoff. The audit is now **90 verified /
4 enforced / 6 partial / 1 incomplete**. D-09's final source commit/runtime
candidate and aggregate G/SCOPE/DONE remain open. Permission for a local candidate
commit has been requested but not received; no commit or GitHub publication has
occurred. PostgreSQL performance remains unmet, with no accepted exception.

All application/test/dependency/migration and 1,473 compiled hashes remain
unchanged. Production 2099, configuration and watchdog are untouched. This is
not `READY_FOR_REVIEW_NOT_DEPLOYED` or permission to deploy.

## Previous checkpoint: implementation, tests and quality delivery

The [implementation review](pricing-implementation-delivery.md) now packages the
whole 1,405-file public source snapshot, complete 4,336-unit/807-HTTP assertion
inventories, 17 command groups and their evidence. A separate private companion
retains 163 exact originals; 141 portable copies replace only machine paths.
The first failed full run and rejected joined-log experiment remain explicit.

Independent extraction checks reconcile every batch/aggregate assertion and
recompute the original HTTP samples. Falsifying the failed performance flag,
removing a test or adding an unexpected file is rejected. Application/test/
dependency and all 1,473 compiled hashes still match the restored full checkpoint;
this is not a newly rerun full suite or image test.

The previous pure-quote catalog/compiler fingerprints were stale, so the current
full-scale pure calculation was rerun: p95 0.063083ms, p99 0.208292ms, with all
10,000 amounts independently verified. This does **not** waive the original
PostgreSQL HTTP failure (+16.924709ms p95 / 18.472475% throughput loss).

D-02, D-04 and D-08 are delivered for this checkpoint. The audit becomes
**89 verified / 4 enforced / 7 partial / 1 incomplete**. D-09 fixed-source/runtime
candidate, D-10 non-executed deployment/rollback handoff and aggregate G/SCOPE/DONE
remain open. No performance exception has been accepted. Production 2099 and its
user-edited model configuration are unchanged; nothing is committed, pushed,
merged or deployed.

## Previous checkpoint: migration/import and native recovery delivery

The [D-03 migration package](pricing-migration-delivery.md) now provides exact
compatibility/CLI/schema extracts, synthetic import inputs/plans, current native
recovery evidence and an executed disposable offline rehearsal script.

Fresh SQLite and PostgreSQL runs use the current compiled `dist/main.js`, real
password/session authentication and six mock requests per database. Both pass
dry-run/apply001–018/reapply, populated-removal refusal, three independent backup
restores and a new authenticated request from the latest restored gateway. Old
fees, key identities and the unresolved hold survive; unknown work is not resent.
All owned gateway/mock/PostgreSQL listeners are stopped.

Seven compiled CLI boundary cases verify import/redaction, unresolved catalog,
invalid input and nonexistent-target planning with no network/listen attempts.
The portable SQLite script also completes all eight steps in a fresh owned
temporary database. Independent recovery checks, archive extraction and negative
integrity tests pass. No runtime/dependency/migration code or checksum changed;
the full 4,336-unit/807-HTTP result remains carried, not rerun.

D-03 is delivered for this checkpoint. The audit becomes **86 verified / 4 enforced
/ 10 partial / 1 incomplete**. Core/test/quality umbrella delivery, final
fixed-source/runtime package, deployment checklist and aggregate gates still need
reconciliation. The PostgreSQL performance deviation remains unaccepted and
PERF-02 unmet. Production 2099 and the user's model configuration are unchanged;
nothing is committed, pushed or deployed.

## Previous checkpoint: current cost/report/API output delivery

The [D-06 output attachment](pricing-cost-output-delivery.md) contains **88 fresh
API packets and three summary exports** from the current TypeScript AppModule,
using an isolated in-memory SQLite instance, real password/session authorization
and mocked suppliers. It covers all eight cost states, old/new price and FX
separation, read-only replay, local-cache accounting, pending-to-settled video,
pagination and viewer/foreign-workspace boundaries. The owned instance is stopped.

An independent Python Fraction/Decimal oracle verifies 20 receipts, 25 component
lines and all 22 final request/report classifications. Four read-only phases
preserve 38 table hashes/counts, configuration and provider-call counts. The actual
frontend validators and export function are exercised offline, not presented as
a new browser run. Fresh extraction, modified-total rejection and unexpected-file
checks pass for the portable 108-payload package.

D-06 is delivered for this checkpoint. The audit becomes **85 verified / 4 enforced
/ 11 partial / 1 incomplete**. Application, tests, frontend, dependencies,
migrations and all 1,473 compiled files remain unchanged; the full 4,336-unit/
807-HTTP regression is carried by source identity, not rerun. This does not replace
PostgreSQL, durable restart, compiled-main or Docker acceptance.

Final fixed-source/runtime delivery and aggregate gates remain open. The original
PostgreSQL performance deviation has not been accepted, so PERF-02 remains unmet.
Production 2099 and the user's model configuration are unchanged. Nothing is
committed, pushed or deployed.

## Previous checkpoint: portable frontend delivery

The [UI review package](pricing-ui-delivery.md) now contains 390 frontend source
files, 154 static build files, all seven locale catalogs, 332 existing PNGs and
28 calendar/range interaction records. Relative paths, hashes, a gallery and an
offline verifier make it portable. It includes 21 source-matched editor/locale
clauses and explicitly separates newer component evidence from older workflows.
No old capture is presented as a new browser run.

Fresh frontend contracts/localization/build and unchanged bundle caps pass.
An independent extraction verifies all 919 payloads; all PNGs pass format/decode
checks. Modified-capture and unexpected-file negative tests are rejected. All
1,473 compiled files remain byte-identical to the restored source checkpoint.
Representative visuals across seven languages were inspected. The package is a
UI review snapshot, not an independently runnable backend or final release bundle.

D-05 is now delivered for this source-scoped checkpoint. The audit becomes
**84 verified / 4 enforced / 12 partial / 1 incomplete**. D-06's report/API export
consolidation, final fixed-source candidate/bundle and aggregate delivery remain
open. The PostgreSQL performance deviation has not been accepted; PERF-02 remains
unmet. Nothing is committed, pushed or deployed.

No browser, gateway, database or runtime container was started during packaging.
Production 2099 and its user-edited model configuration remain unchanged.

## Previous checkpoint: consolidated operator guide

[Pricing operations](pricing-operations.md) now provides the end-to-end operator
sequence: draft-only work, base/cache rates, context tiers, immutable inheritance,
peak/off-peak calendars, service/media contracts, quantity/money rounding, FX,
publication/rollback, budget policy and historical reconciliation. Its examples
are explicitly synthetic. The guide separates tariff changes from schema/code
deployment and preserves the independent approval requirement.

The admission and actual-budget documents also distinguish current supported
operations from their historical text-only prototype notes. Native Realtime and
embedding-batch policies are no longer described by obsolete integration gaps;
their actual evidence/custody restrictions remain explicit. No runtime behavior
or provider-support claim was added by this documentation correction.

Fresh checks pass **161 existing unit tests in seven suites**, covering the guide's
calculator, cache, tier, calendar, inheritance, admission and import rules, plus
documentation and whitespace checks. All application, frontend, dependency,
migration and 1,473 compiled files remain unchanged. The full **4,336-unit/807-HTTP**
result is carried by source identity, not presented as a new full run or browser
session.

D-07's named operating topics are consolidated and source-reviewed. The checkpoint
audit is **83 verified / 4 enforced / 13 partial / 1 incomplete**. This does not
complete the portable UI/report evidence, final source/bundle or aggregate delivery
gates. The PostgreSQL performance deviation has been presented for an explicit
user decision; no acceptance has been received and PERF-02 remains unmet.

No gateway, database, image build or runtime container was started for these
checks. Production 2099 and its user-edited model configuration remain unchanged.
Nothing is committed, pushed or deployed.

## Previous checkpoint: remove the unproven joined-log optimization

The joined-log experiment has been archived and removed. Its paired diagnostic
and original balanced comparisons did not establish the intended overall gain;
fewer database statements did not justify retaining the additional transaction,
savepoint and fallback-identity path. No pricing capability or acceptance
requirement was removed with this optimization.

Exactly seven application/test files were restored to their preceding inbox-phase
hashes. Every other application, frontend, dependency and migration file already
matched that checkpoint. A fresh build reproduces **all 1,473 compiled files
byte-for-byte**. Fresh targeted checks pass **450 unit tests and 47 HTTP tests**
against an isolated durable PostgreSQL instance, plus build and lint. The earlier
full **4,336-unit/807-HTTP** result applies by exact source identity; it is not a
new full-suite run. The experiment's 4,357/811 count is no longer the current
inventory.

The same application source also matches the preceding authenticated Rancher
image; only documentation differs. Its image identity remains present in the
explicit Rancher Moby engine. Existing image checks are carried forward, not
presented as a fresh build or container test. OPS-TEST-03 returns to verified for
that same application/platform scope: **82 verified / 4 enforced / 14 partial /
1 incomplete**. Final release-source and bundle delivery remain separate gates.

No unchanged performance workload was rerun. The restored source's earlier
comparison passed four SQLite and three PostgreSQL scenarios, but PostgreSQL
JSON/50ms still failed at **+16.924709ms p95 and 18.472475% throughput loss**.
The rejected candidate's four failures remain recorded below; they are not
relabelled as host noise or passing results. **PERF-02 remains incomplete.**

All owned test instances are stopped. Production 2099 and its user-edited model
configuration are unchanged. No image build, runtime-container action, commit,
push or deployment occurred during restoration.

## Rejected experiment: joined log settlement, native verification only

This section records the archived experiment, not the current application. Its
tests and measurements remain evidence for why the path was removed.

The [joined logging path](pricing-log-projection.md#joined-postgresql-log-settlement)
places ordinary synchronous PostgreSQL call/route logs inside their existing
settlement transaction. It retains both independent outcome commits, complete
receipt/history validation and fresh budget scope/epoch discovery. A nested
savepoint isolates optional log failures from expense settlement. SQLite,
streaming, actual-expense and asynchronous evaluation paths retain their previous
ordering.

The fixed application source passes **4,357 unit tests in 205 suites and 811 HTTP
tests in 65 suites**, without failures or skips. All 4,336/807 preceding assertions
remain; 21 unit cases and four HTTP cases are added. Builds, lint, frontend/bundle
checks, SDKs and static checks pass. Dependencies and 18 migration checksums are
unchanged.

Eleven actual-main PostgreSQL fault cases also pass: normal operation, in-flight
shutdown, concurrent requests, lost commit acknowledgement, trace/preparation
failure, each optional log INSERT failure, and streaming/async-evaluation/
actual-expense exclusions. Fourteen synthetic provider calls have exact, singly
applied expenses and request-correlated logs. A failed private fixture expected
no settlement intent for an actual-expense cohort; the existing implementation
requires that applied intent. Correcting the fixture and adding explicit budget-
basis assertions made all cases pass without changing application code or limits.
The failed run is retained.

**Performance is not accepted.** The original comparisons now pass four of eight
cases. PostgreSQL delayed JSON adds 21.154792ms p95 and loses 21.020488% throughput;
zero-delay PostgreSQL SSE loses 5.765017% throughput. SQLite delayed JSON/SSE add
6.482417ms/5.536583ms p95. All 19,200 request/accounting checks, 9,600 candidate
amounts and 32 exact balances pass, but those results do not waive performance
failures. See [the complete comparison](pricing-performance.md#joined-log-settlement-native-checkpoint).

The preceding Rancher image does not include this application change. Its
successful checks remain historical evidence, not current-image certification.
OPS-TEST-03 therefore returns to partial for this source: the current audit is
**81 verified / 4 enforced / 15 partial / 1 incomplete**. Native fault validation
does not replace Linux image checks, final source/bundle identity or aggregate
delivery gates. The Goal remains active and is not deployment-ready.

All owned test instances are stopped. Production 2099 and its user-edited model
configuration are unchanged. No Docker action, commit, push or deployment occurred
in this checkpoint.

## Previous checkpoint: PostgreSQL inbox persistence phase

The [inbox persistence phase](pricing-retention-state.md#current-postgresql-persistence-phase)
reduces the common PostgreSQL request from105 to97 SQL statements while keeping
ten transactions and two independent receipt/decision retentions. Ownership is
still rechecked after waiting for the parent lock. Grouped, parameterized writes
check both body/update and mandatory-audit row counts; real trigger failures and
suppressed writes cannot leave partially acknowledged accounting.

Fresh full regression passes **4,336 unit tests in205suites and807 HTTP tests in
65suites**, with no failures/skips. All4,319previous unit assertions and807HTTP
assertions remain;17unit cases are added. Builds, lint, frontend/bundle checks,
SDKs, configuration and static deployment checks pass. Dependencies and all18
migration checksums are unchanged. Three old PostgreSQL fixture failures were
corrected by verifying the new two-read shape and replacing bypassed mock hooks
with real audit-insert failures; the failed runs remain preserved.

The original balanced comparisons pass all four SQLite cases and three
PostgreSQL cases. Delayed PostgreSQL JSON still misses the original target:
**+16.924709ms p95 and18.472475% throughput loss**. The paired diagnostic shows
fewer statements and shorter retention work, but not lower overall latency;
cross-checkpoint timing differences are not proof of a sole cause. No repetition
or threshold is waived. All19,200response/accounting checks and9,600candidate
amount checks pass. See [the full measurements](pricing-performance.md#postgresql-inbox-persistence-phase).

A refreshed current-application Rancher Moby/ARM64 image passes real password and
session authentication, packaged CMD/HEALTHCHECK, listener recovery and both
in-flight shutdown phases. Audit counts remain **82verified /4enforced /14partial
/1incomplete**. PERF-02 and final fixed-source/aggregate delivery remain open;
this is not deployment approval. All owned verification instances are stopped.
Production2099, its user-edited model configuration, other Rancher containers and
engine settings are unchanged. Nothing is committed, pushed or deployed.

## Previous checkpoint: authenticated Rancher image

The [current Linux/ARM64 image](pricing-rancher-rollout.md#previous-image-checkpoint-authenticated-startup-and-in-flight-drain)
now passes real Dashboard password/session authentication without the earlier
unauthenticated fixture flag. Actual CMD/HEALTHCHECK, live/ready, static assets,
caller-key acceptance/rejection, listener-loss recovery and two in-flight SSE
shutdown cases pass. Final accounting is exact across13synthetic requests;
the container exits0 only after held work completes. The first fixture's
single-caller pause failure remains recorded; the corrected all-caller gate
passes on the same application image.

There are no application, dependency, migration or frontend changes in this
checkpoint. The image's1,401-file manifest matches the preceding native full
regression's application code; **4,319 unit and807 HTTP results are carried
forward, not presented as a newly rerun suite**. Only these progress and rollout
documents change afterward.

OPS-TEST-03 is verified for this source/platform. Audit counts become
**82 verified /4enforced /14partial /1incomplete**. The remaining nonaggregate
gap is PERF-02: PostgreSQL delayed JSON still adds19.628668ms at p95 and loses
21.341128% throughput in the latest original comparison. No unchanged benchmark
was rerun or waived. Final fixed-source and aggregate delivery gates also remain
open; the Goal is active and not deployment-ready.

All owned test instances are stopped and temporary fixture resources removed.
Other Rancher containers/settings/context and production2099, including the
user's model configuration, are unchanged. Nothing is committed, pushed or
deployed.

## Previous checkpoint: settlement metadata phase

The [completion phase](pricing-settlement-receipt-graph.md#tentative-completion-before-budget-mutation)
prepares request-owned reservation/intent/recovery/log records before entering the
budget writer, without changing the transaction boundary. Independent connections,
real database rejection triggers and actual child exits verify that tentative
completion is never exposed and rolls back if money cannot be applied. Budget
scopes and epochs are still read freshly after preparation.

The complete source passes **4,319 unit tests in205suites and807 HTTP tests in
65suites**, with no failures/skips and all previous assertions retained. Nineteen
new checks join the unchanged pricing, ownership, audit and recovery contracts.
Builds, lint, frontend/bundle checks, SDKs and static deployment checks pass;
dependencies and18migration checksums are unchanged.

The paired diagnostic moves four statements out of the client-observed budget-lock
query-to-COMMIT interval, reducing that interval from eleven statements to seven
without reducing the105statement total. Fresh original balanced comparisons pass
all four SQLite scenarios and three PostgreSQL scenarios. PostgreSQL delayed JSON
still misses the5ms/5% targets. All19,200response/accounting checks pass; no
repetition or threshold is discarded. See [the actual measurements](pricing-performance.md#settlement-metadata-phase).

Audit counts remain **81 verified /4enforced /15partial /1incomplete**. The Goal
is active: overall performance, current platform and final fixed-source/aggregate
delivery remain open. All owned instances are stopped; production2099 and the
user's model change are untouched. Nothing is committed, pushed or deployed.


## Previous checkpoint: owned dispatch and receipt reads

The [owned-read change](pricing-owned-attempt-reads.md) captures dispatch identity
before yielding and validates each receipt's request/reservation/workspace link
under the existing request fence. It fixes reproduced caller-mutation and
cross-request association gaps and replaces repeated receipt lookups with bounded
locked reads. Full historical validation, independent retention commits, exact
budget effects and default admission checks remain intact.

The complete source passes **4,300 unit tests in205suites and807 HTTP tests in
65suites**, with no failures or skips, including19new assertions and every earlier
assertion name. Builds, lint, frontend contracts/bundle limits, SDKs and static
deployment checks pass. Dependencies and18migration checksums are unchanged.

The paired profile reduces110 to105SQL statements per request but does not show
an overall latency improvement. Fresh original balanced comparisons fail
PostgreSQL delayed JSON, SQLite zero-delay JSON and SQLite delayed JSON; all
19,200response/accounting checks pass. No slow repetition or near-threshold miss
is waived. See the [current measurements](pricing-performance.md#owned-attempt-reads).

The Goal remains active. Audit counts stay **81 verified /4enforced /15partial
/1incomplete**; performance, current platform and final fixed-source/aggregate
delivery gates remain open. All owned test instances are stopped. Production2099
and the user's model edit are unchanged. Nothing is committed, pushed or deployed.


## Previous checkpoint: reference-use and source provenance

The [original reference-boundary review](pricing-reference-boundary.md) closes
REF-01 for this source. The pinned reference license is checked explicitly; no
code-reuse authorization is inferred. Its component/tier/settlement ideas are
distinguished from the Gateway's independently implemented calendars, evidence
states, precision rules, budget effects and configuration workflow.

Comparison covers1,331reference files and532Goal-changed code files. All36exact
matching regions are already in the Gateway baseline; no new matching reference
block is identified. Complete-function shape checks, manual inherited-region
review and67literal classifications supplement that result. All1,016current code
files and13package/lock/TypeScript documents pass the reference-dependency check.
The unchanged configurable plugin loader is recorded separately, not hidden by
the static check. This is bounded provenance evidence, not universal authorship or
legal certification.

Code and compiled artifacts are unchanged from the4,281-unit/807-HTTP full
checkpoint. The321directly relevant passing assertions are rechecked, not rerun
as a new full regression. Audit counts are **81 verified /4enforced /15partial
/1incomplete**.

The two original performance failures, current platform acceptance and final
fixed-source/aggregate delivery remain open. The Goal is still active and not
deployment-ready. Production2099, the user-edited model and both repositories'
runtime state remain untouched; nothing is committed, pushed or deployed.


## Previous checkpoint: original database migration acceptance

The [six-clause database report](pricing-database-acceptance.md) closes original
MIG-02 at the current compiled source. Both native SQLite and PostgreSQL pass
explicit001–018 dry-run/apply/reapply and three populated-backup restores. The
actual gateway retains immutable costs, video task/workspace/request links,
caller-key identities and the unknown-cost hold, accepts one new authenticated
request and never redispatches unresolved supplier work.

Separate50,001-task fixtures measure018 index/transaction/storage behavior and
demonstrate writer blocking. Deliberate contention delays are not reported as
natural migration times. A maintenance disk/lock budget and the mandatory
database/configuration-restore/reconciliation prerequisite for downgrade are
documented; no production migration or mixed-version rollout is authorized.

Application code, dependencies, compiled artifacts and tests are unchanged from
the4,281-unit/807-HTTP full checkpoint below. Their exact hashes and167 directly
relevant passing assertions were rechecked; that is carried evidence, not a new
full regression. New native recovery/scale results do not replace final-image
platform acceptance. Audit counts are now **80 verified /4enforced /16partial
/1incomplete**.

The Goal remains active. The same two original performance cases still fail;
reference provenance, platform acceptance and final fixed-source/aggregate
delivery remain open. All owned test instances are stopped. Production2099 and
the user's model change remain unchanged. Nothing was committed, pushed,
containerized or deployed.


## Previous checkpoint: bounded settlement receipt graph

The [joint receipt graph](pricing-settlement-receipt-graph.md) shares fresh stored
body, membership, audit and disposition reads under its request fence. It rejects
changed subjects and orphan evidence rather than treating them as an absent
predecessor. Individual acknowledgement writes, independent retention commits
and atomic money application remain unchanged; later-chunk failures roll back
earlier acknowledgements.

All **4,281 unit tests in205suites and807 HTTP tests in65suites** pass without
failures or skips, including26new cross-database checks. Builds, lint, frontend
contracts/bundle caps, SDKs and static deployment checks pass; previous assertion
names, dependencies and18migration checksums remain intact.

A paired instrumented profile reduces115 to110statements per request and the
receipt-stage mean decreases, but its total post-upstream-header time does not.
Original balanced comparisons still fail PostgreSQL delayed JSON and SQLite
zero-delay JSON. All19,200response/accounting checks pass; the slower repetition
and both failures are retained. See [current results](pricing-performance.md#bounded-settlement-receipt-graph).

Overall performance remains incomplete. Audit counts stay **79 verified /
4enforced /17partial /1incomplete**. Database/platform/provenance and final
candidate/aggregate delivery gates remain open. All owned processes have stopped;
production2099 and the user's model edit remain unchanged. Nothing was committed,
pushed, containerized or deployed.


## Previous checkpoint: bounded runtime retention state

[Runtime evidence retention](pricing-retention-state.md) now shares its fresh
post-lock ownership, body, sibling and audit reads. It preserves separate durable
receipt/decision commits and atomic budget application. New checks reject changed
request edges and orphan terminal audits without trusting stale state.

The same source completes **4,255 unit tests in205suites and807 HTTP tests in
65suites**, without failures or skips, plus builds, lint, frontend contracts and
bundle caps, SDKs, configuration and static deployment checks. All previous
4,229unit assertion names and18migration checksums remain intact.

A paired instrumented PostgreSQL profile reduces123 to115statements per request,
with ten transactions and two independent retentions unchanged. Retention SQL
time decreases in that diagnostic, but the original balanced comparisons still
fail two PostgreSQL cases and SQLite delayed JSON. All19,200response/accounting
checks pass; no slow repetition or near-threshold failure is waived. The
[current numbers](pricing-performance.md#bounded-retention-state-reads) supersede
earlier source-specific performance claims.

The change is retained for bounded reads and verified ownership/audit hardening,
not as full performance acceptance. Audit counts remain **79 verified /4enforced
/17partial /1incomplete**. Further settlement-path optimization, database/platform/
provenance acceptance and a final fixed-source candidate are still required.
All owned test instances are stopped; production2099 and the user-edited model
configuration remain unchanged. Nothing was committed, pushed or deployed.


## Previous checkpoint: complete original editor/form acceptance

The [six-region/ten-clause audit](pricing-editor-completion.md) verifies original
UI-02 and UI-03. A reproducing callback test found two destructive media settings
actions without confirmation; disabling the specification and restoring its
parent now honor cancellation before changing the draft.

Current English/Chinese native interactions verify inherited free/reset,
media disable/restore, deletion cancellation, exact unsaved restoration, invalid
calendar rejection, image-family defaults, a size/quality price matrix and minimum
quantity rounding. Known image quotes reconcile independently; a missing variant
stays unknown and a missing adapter visibly blocks publication. All published and
financial state remains unchanged, with zero supplier calls.

The prior complete editor/keyboard rehearsal and scoped node/range/week proofs
are retained only against checked unchanged dependencies. The private audit maps
all16original clauses to direct evidence. Counts are **79 verified / 4 enforced /
17 partial / 1 incomplete**, not a completion percentage.

Fresh frontend tests/build and unchanged bundle caps pass. Only the media
confirmation component and its regression test change application/test behavior;
the existing4,229-unit/807-HTTP backend proof remains applicable by hashes.
Failed private harness assumptions are retained; no completed mutation is retried
blindly. All owned processes stopped; production2099 and the user's model edit
remain unchanged. No Git, Docker or deployment action occurred.

Original PostgreSQL performance, database/platform/provenance acceptance and the
final fixed-source candidate and aggregate delivery gates still require completion.


## Previous checkpoint: editor workflows, locale and keyboard acceptance

The [current authenticated rehearsal](pricing-ui-roundtrip.md) refreshes English
desktop/light and Chinese narrow/dark import, copy, edit, quote, publish and
rollback. Eight mock-backed calls prove that saving a draft leaves the active
price unchanged, publishing selects the new price, and rollback creates a distinct
immutable version. Independent arithmetic and 25 snapshots reconcile 12000 tokens
and 0.022USD, preserving every historical cost response.

The same compiled build passes 14 seven-language layouts, 28 native modal focus
cycles and 98 arrow-key section transitions. English/Chinese blank/free,
revision-conflict, confirmed reload and before-send permission/network fault
checks preserve local edits. Only six intended unpublished-draft updates and
their audits occur; active prices and financial state remain unchanged.
Both long rollback dialogs retain reachable confirmation and final-action controls.

Fresh frontend contracts pass; application code and compiled assets are unchanged.
The existing 4,229-unit/807-HTTP proof is retained by exact hashes, not rerun.
Original UI-05 and UI-TEST-06 locale/layout/keyboard criteria are verified within
the pricing scope. Audit counts are **77 verified / 4 enforced / 19 partial /
1 incomplete**, not a completion percentage. This does not mark all UI-02/UI-03
form behaviors complete; the acceptance map lists their remaining evidence work.

The first two read-only verifier failures are retained and corrected without
replaying mutations or altering application behavior. All owned browser/application
processes have stopped. Production2099 and the user's model edit are unchanged.
No commit, push, Docker or deployment action occurred. Original PostgreSQL
performance, migration/platform/provenance and final candidate gates remain open.


## Previous checkpoint: unified dimension and module-boundary acceptance

The [original dimension/module map](pricing-dimension-acceptance.md) verifies
METER-01's eleven rows and embeddings paragraph, plus all eight ARCH-01 rows.
It binds exact passed actual-ingress/storage assertions to the current source,
including cache TTLs, modality conservation, audio direction/characters, rerank
processed work, async generation and separate Realtime/ASR/session accounting.
These two families are now verified. Audit counts are **75 verified / 4 enforced /
21 partial / 1 incomplete**, not a completion percentage.

Nineteen new compiled-adapter scenarios and four invalid-basis checks run without
network/listeners or databases. Independent Python fractions reproduce17known
amounts; two missing-quantity cases remain unknown. A33-module compiled dependency
graph confirms the normalizer/compiler/resolver/calculator roots import only the
crypto builtin externally, not storage/network services. Earlier malformed fixture
failures are retained; the production code and its validation were not changed.

Application, public tests, dependencies and all compiled artifacts remain unchanged;
the existing4,229-unit/807-HTTP proof is retained by hashes, not rerun. Metering docs
now identify implemented signed events and opt-in actual budgets rather than stale
unimplemented notes. Remote model/contract support and source provenance remain
separate assertions. No new performance pass is claimed.

The original PostgreSQL performance target, remaining UI/migration/platform and
final fixed-source candidate still require completion. No server or database was
started for this checkpoint. Production2099 and the user's model configuration are
unchanged; there was no Git, Docker or deployment action.


## Previous checkpoint: original calculation-policy explanation

The request-cost source panel now shows the original minimum billed quantity,
quantity-rounding step/mode, money precision/mode and measured/billed quantities.
It reads only the verified version already referenced by the receipt, not current
prices. Mismatched or unavailable evidence remains explicit. Inherited prices use
their immutable materialized version, while allocated batches clearly show physical
rather than per-member quantity policy. See [the contract](pricing-calculation-policy.md).

All252policy browser views, eight error/retry cases and four viewer checks pass
across seven locales and desktop/light/narrow/dark layouts. All38financial/log tables,
config and mock-call counts are unchanged by inspection. Frontend contracts/build
pass with the same23.40KiB pricing and7.14KiB request-cost route budgets. Backend,
SDK, dependency, migration and public backend-test sources/compiled files are
unchanged; the4,229-unit/807-HTTP proof is retained, not rerun.

The concrete UI-04 rounding-explanation gap is resolved. Together with the unchanged
broader compatibility view/report/cache/video proof, both original UI-04 paragraphs
are verified. Audit counts are **73 verified / 4 enforced / 23 partial / 1 incomplete**,
not a completion percentage. Other UI families, original PostgreSQL performance,
remaining metering/platform work and final fixed-source candidate remain open.
All owned instances stopped; production2099 and the user's configuration are
untouched. Nothing was committed, pushed, containerized or deployed.


## Previous checkpoint: compatibility and current cost-view verification

The [original compatibility/activation map](pricing-compatibility-acceptance.md)
verifies MIG-01's seven clauses and both MIG-03 paragraphs. The actual compiled
legacy-import CLI preserves its input files, emits review-only proposals and makes
no network/listen attempt or database creation. Existing source/confidence metadata,
cache inference and explicit activation boundaries remain intact. Audit counts
are **72 verified / 4 enforced / 24 partial / 1 incomplete**, not a percentage.

A fresh password-authenticated fixture runs282browser checks:252detail views,
14post-video-completion views,14report/export views and two viewer checks. Seven
languages, desktop/light and narrow/dark pass. Independent decimal totals agree
with every exported report. Read-only phases preserve all38pricing/budget/log
tables, configuration and supplier-call count. The only explicit supplier status
operation settles an existing video from0.8USDreserved to0.64USDcommitted, with no
new generation or unrelated historical change.

The review found a genuine UI-04 explanation gap: measured and billed quantities
are visible, but the original minimum/step/mode producing their difference is not.
The original immutable price already stores the needed metadata. UI-04 remains
partial until it can display that policy without consulting current prices or
rewriting receipts. The harness's earlier512-versus-reported1024expectation error
was corrected; supplier precedence and application code were not changed.

Application, tests, dependencies and compiled assets are unchanged, so the current
4,229-unit/807-HTTP proof remains applicable; it was not rerun. All owned instances
are stopped. PostgreSQL performance, the identified UI gap, other original
requirements and final-source candidate remain open. Production2099 and the user's
model configuration are untouched; nothing was pushed, containerized or deployed.


## Previous checkpoint: original rule and synchronous-flow acceptance

A [clause-by-clause map](pricing-rule-flow-acceptance.md) verifies all20original
RULE-01/RULE-05/FLOW-01 items, including the unnumbered overlap-rejection rule.
It connects exact current passed assertions to catalog snapshots, service evidence,
calendar/context/media matching, duplicate-charge rejection, retained computations,
budget/log consistency and real child-process crash recovery. All three families
are now verified; unrelated requirements are not promoted. Audit counts become
**70 verified / 4 enforced / 26 partial / 1 incomplete**, not a completion percentage.

An additional pure compiled probe verifies different node-specific fast prices,
requested-versus-resolved evidence and explicit image count/token combinations.
It uses the real quantity normalizer and no network/database. A malformed fixture
unit failed before correction; the failure is retained and validation is unchanged.
Application/test/dependency/compiled files remain byte-identical, so the preceding
4,229-unit/807-HTTP and source-bound browser results remain applicable. They were
not rerun or relabelled as new tests.

Offline attribution of the retained PostgreSQL profile locates41post-header SQL
statements in settlement application and22in the two independent retentions.
Their SQL interval unions are11.706ms and5.841ms; these are instrumented means, not
new acceptance measurements. This narrows the next performance investigation to
the durable critical path rather than peripheral telemetry/pool tuning. No unsafe
fast path or application optimization was introduced merely to lower a query count.

The original PostgreSQL performance target, remaining UI/migration/platform scope
and final fixed-source candidate remain incomplete. Production2099 and the user's
model configuration are unchanged. No service was restarted, and nothing was
committed, pushed, built into Docker or deployed in this checkpoint.


## Previous checkpoint: explicit media specification authority

Price versions can explicitly distinguish model-fixed media specifications from
adapter-selected request/result fields. Fixed values override request parameters;
contradictory provider results remain unknown instead of selecting a cheap or
fixed price. Signed media events now correctly replace request provenance with
provider-result provenance. Legacy tasks without source capture retain their
historical shape. See [the contract and RULE-05.4 acceptance map](pricing-media-specification.md).

The full regression passes **4,229 unit tests in 205 suites and 807 HTTP tests in
65 suites**, with no skips. Builds, lint, frontend contracts/build, SDKs,
configuration, documentation and static deployment checks pass. The callback
provenance defect has retained red/green evidence; earlier failed runs remain
recorded. Migration001–018, supplier-secret restrictions, test timeouts and bundle
caps were not relaxed. The pricing route is 23.40 KiB gzip within its 24 KiB cap.

Seventy real-browser cases cover seven languages in desktop/light and narrow/dark
layouts without altering financial data. An additional workflow verifies restored
inheritance, hypothetical source selection, draft save, publication and immutable
history; actual mock requests remain at USD0.4 until publication and then use
USD0.2. Source/adapter edits invalidate a previous simulation and viewer controls
remain read-only. These are synthetic prices and mocked suppliers. A clipped long
simulation capture was replaced as visual evidence by fully visible result views;
the original capture and one selector-error log were retained.

Only original RULE-05.4 is accepted here; the whole RULE-05 family remains partial.
The audit therefore remains **67 verified / 4 enforced / 29 partial / 1 incomplete**,
not a completion percentage. PostgreSQL performance, remaining original workflows,
migrations/platform scope and the final fixed-source candidate remain open.
All owned fixtures have stopped. Production2099 and the user's model configuration
remain unchanged; nothing was pushed, built into Docker or deployed.

## Previous checkpoint: currency and budget contract acceptance

Four new real-HTTP cases cover JSON/SSE fallback from a paid USD attempt to a CNY
attempt while FX changes. They preserve both native amounts, use only the admitted
conversion, keep missing FX unknown, and leave old receipts/reports unchanged
when a later request uses the new rate. They verify USD0.0024complete versus
USD0.0012known subtotal with an unknown fallback, rather than adding unlike native
currencies. These are synthetic rates, not supplier price claims.

The current full HTTP inventory passes **801 tests in64 suites**, with no failures
or skips. Builds, lint, frontend tests/build, SDKs, configuration, documentation
and static deployment gates pass. The application, dependencies, unit tests and
all compiled artifacts are unchanged. The existing **4,203-unit/204-suite** proof
therefore remains applicable after an exact source/inventory check; only69 focused
currency/budget unit cases were rerun, not another complete unit run.

A direct [clause-level acceptance map](pricing-currency-budget-acceptance.md)
verifies all twelve original PRICE-03/FLOW-02 clauses against source and actual
passed assertions. These two families are now verified. Other original families
are not promoted. The audit also isolates a concrete RULE-05 gap: quantity
availability/video-profile metadata is not yet an explicit declaration of whether
media specifications are model-fixed or request-derived.

No runtime code or production configuration changed in this checkpoint. All owned
test databases stopped; no new browser, performance or Docker result is claimed.
The original PostgreSQL performance target, remaining media/UI/migration/platform
requirements and final fixed-source candidate remain open. Production2099 and
the user's model edit remain untouched; nothing was pushed or deployed.

## Previous checkpoint: recorded provider-cache comparisons

Cache reports no longer invent missing historical references from current token
prices or replace recorded costs with cheaper current estimates. Media fees are
excluded from token-cache comparisons. Missing references, partial coverage and
bounded scans are explicit; known zero and genuine negative differences remain
separate. Exact recorded-pair subtotals are not all-traffic supplier expense.
See [the response contract and compatibility correction](pricing-provider-cache-comparison.md).

All **4,203 unit tests in 204 suites and 797 HTTP tests in 63 suites** pass, with
no failures or skips in the test results. The private unit aggregator originally
expected 4,204 by mistake: its failed invocation is retained, and the aggregate
was recovered from all 21 passed batches after verifying complete inventory and
unchanged source. Remaining gates ran against that same source in a fresh owned
PostgreSQL cluster. Builds, lint, frontend, SDKs, configuration, documentation and
static deployment checks pass; migration001–018 and bundle limits are unchanged.
Three old tests intentionally asserting historical repricing now enforce unknown
or unchanged recorded amounts; this is not claimed as unchanged legacy behavior.

Real browser inspection also found a Budget-page note promising a provider
cache discount even when the comparison was unavailable. The frontend-only
follow-up removes that claim and uses neutral/amber states for unknown/negative
comparisons. All frontend tests and build pass again; backend/test/dependency
hashes remain identical to the complete regression run.

Seventy final browser cases cover the three reference views and missing/negative
legacy-log details in seven locales, desktop/light and narrow/dark layouts.
Read-only views preserve the entire pricing, budget and call-log snapshots;
only the two explicit synthetic fixture log insertions differ between phases.

This is a safety correction, not completion of advanced cache analytics. Frozen
provider-cache counterfactuals, complete large-period coverage and immutable
per-dimension decomposition remain open. UI-04/MIG-01 remain partial; the overall
Goal, original PostgreSQL performance gate and final candidate are incomplete.
All owned test/browser instances have stopped. No Docker action, Git publication,
production2099 restart or change to the user's model configuration occurred.

## Previous checkpoint: distinct media states and safe delivery errors

Media task inventory and detail now separately label supplier generation and
task/accounting processing in all seven languages. Failed/cancelled generation
can retain a known fee; unknown provider state is never guessed from accounting
state. Delivery is explicitly not inferred. A browser-discovered legacy label
also no longer describes complete known amounts as an incomplete total.

The real HTTP fixture found that the intended content-error explanation was
actually being redacted to a generic video-proxy error. The known constant error
now uses the explicit public-error contract, preserving502, the existing error
type and request correlation while exposing a safe code and fee-retention message.
No raw provider error, financial record or budget policy is changed. Two strengthened
existing HTTP cases fail against the original handler and pass after the fix.

Fresh regression passes **4,186 unit tests in203 suites and791 HTTP tests in62
suites**, with no failures or skips, plus all build/lint/frontend/SDK/configuration
and static deployment gates. The subsequent frontend-only subtotal-label correction
passes all frontend tests/build again; backend and backend-test hashes are identical
to that complete run. No redundant backend rerun is claimed. Migration001–018
checksums and original bundle caps remain unchanged.

Fifty-four real browser checks cover42locale/layout cases, known/zero/unknown fees,
keyboard navigation and role boundaries. Financial snapshots do not change during
read-only UI use. STATE-07 is now verified; the [acceptance record](pricing-cost-lifecycle-acceptance.md#state-07-presentation-and-safe-delivery-error)
documents both the correction to the earlier assumption and evidence limits.
All owned test/browser instances are stopped. PostgreSQL performance, other
remaining original requirements and the final candidate remain open; no image was
rebuilt or deployed, no Git publication occurred, and2099/user configuration remain
unchanged.

## Previous checkpoint: PostgreSQL critical path and lifecycle review

A paired, instrumented PostgreSQL run locates the remaining overhead rather than
guessing from query counts. Both versions use500measured/100warmup synthetic
requests at concurrency4. The candidate's mean post-upstream-header phase is
23.724ms versus6.527ms in the startup-only compatibility control;21.166ms versus
4.293ms falls inside SQL intervals. Candidate pool acquisition in that phase is
only0.034ms. The profile is diagnostic, not a balanced acceptance benchmark or a
performance pass. See [the attribution and limits](pricing-performance.md#paired-postgresql-critical-path-profile).

A separate source-bound lifecycle review verifies17 original clauses and promotes
FLOW-03, FLOW-04, STATE-02/03/04/06 against the existing4,186-unit/791-HTTP full run.
Actual application, tests, dependencies and compiled files are unchanged; no
redundant full regression is reported. STATE-07 remains partial: backend charges
survive content errors, but the complete customer-facing generation/processing
distinction still needs implementation/UI verification. See
[the lifecycle acceptance map](pricing-cost-lifecycle-acceptance.md).

No pool tuning, detached accounting, weaker durability, budget-policy change or
performance waiver was applied. Both isolated gateways exited0 and their private
PostgreSQL cluster stopped. Remaining original acceptance and the final fixed-source
Rancher candidate remain open; production2099 and the user's configuration were
not modified. No Docker operation or Git publication occurred.

## Previous checkpoint: failed-stream metering and protocol parity

The Responses failure path now retains explicit upstream usage before emitting
the existing error. Twelve new parser cases and nine HTTP failure cases distinguish
observed charges from missing/invalid evidence without changing native SSE or
adding a success stop. Twenty-four real-ingress combinations compare all four
upstream token protocols across JSON/SSE and the three existing client formats.
A companion real-client cancellation case covers absent usage.

The full source-bound run passes **4,186 unit tests in203 suites and791 HTTP
tests in62 suites**, with no failures or skips. The corrected tests reproduce
12unit/3HTTP failures against the parent parser; all original tests remain covered.
An independent integer/rational oracle also verifies84 compiled-adapter cases.
All seven original METER-03 clauses are now mapped and verified; no other partial
family is promoted. See [the acceptance map](pricing-stream-metering-acceptance.md).

Builds, lint, frontend contracts and unchanged bundle caps, SDKs, configuration/docs
and static deployment/version/registry checks pass. Migration001–018 checksums and
frontend compiled assets are unchanged. No new image/browser/performance result
is claimed. The original PostgreSQL performance gate, other remaining acceptance
and final candidate delivery remain open. All owned test instances are stopped;
production2099 and the user's edited configuration remain unchanged.

## Previous checkpoint: rejected atomic-budget-write experiment

A PostgreSQL experiment combined selected budget counters and exact balances into
bounded parameterized writes. Its10new cases and complete4,184-unit/757-HTTP run
passed, with the existing transaction, scope, old-period, precision and rollback
checks. The diagnostic profile showed123 to117SQL statements per request without
reducing transactions or independent outcome retention.

However, the unchanged-workload PostgreSQL comparison did not demonstrate a
useful end-to-end improvement: JSON/50ms still added24.865ms p95 and lost25.340%
throughput; SSE/50ms added6.204ms p95 and also failed. These are retained results,
not proven causal regressions or a reason to discard slow samples. Fewer SQL
statements alone do not justify the additional production path.

The complete experiment source/build and raw evidence were archived privately,
and its runtime/test changes were removed. All application, test and dependency
files are restored byte-for-byte to the preceding bounded-acknowledgement source.
Its4,174-unit/757-HTTP full run is the applicable baseline, not the rejected
candidate's test count. The restored build and all executable compiled files
match the parent exactly;74 focused unit tests,55HTTP tests, build and lint pass.
This is a verified restoration, not a new full regression run of identical code.
See [the experiment record](pricing-performance.md#rejected-atomic-budget-write-experiment).

No SQLite comparison was run for the rejected candidate after its PostgreSQL
gate failed. The previous source-bound SQLite evidence applies again after verified
restoration. The original PostgreSQL JSON/50ms gap, remaining
acceptance and final candidate delivery are still open. Production2099 and the
user-edited model configuration remain unchanged.

## Previous checkpoint: bounded joint acknowledgement reads

The joint receipt/settlement path now reads a same-reservation set of retained
bodies and exact audit markers under one request fence, rather than reacquiring
the same ownership and audit evidence for each row. Every row is still checked
for identity, current body, ownership, audit integrity and quarantine before any
transition write. Transition writes and money application remain in one transaction;
initial receipt and settlement retention remain independent durable commits.

Twenty new cross-database cases and existing crash/concurrency/recovery coverage
pass in457 selected unit tests and47 HTTP tests. The subsequent full run passes
**4,174 unit tests in203 suites and757 HTTP tests in62 suites**, without failures
or skips. Builds, lint, frontend contracts and unchanged bundle caps, SDKs,
configuration/docs and static deployment/version/registry checks pass. Migration
001–018 checksums and all previous test assertions are preserved.

A separate500-request PostgreSQL profile records123 rather than128 SQL statements
per request, with10transactions, two independent retentions and two summaries
unchanged. Both full native comparisons verify9,600requests,4,800exact candidate
amounts and16balances each. All four SQLite cases and three PostgreSQL cases meet
the original targets, but **PostgreSQL JSON/50ms still fails**: added p95
24.070ms and20.908%throughput reduction. All repetitions remain in the result;
no overall performance pass or exclusive environmental explanation is claimed.
See [the complete comparison](pricing-performance.md#bounded-joint-acknowledgement-reads).

All owned test instances are stopped. Remaining original acceptance, the unmet
HTTP gate and final fixed-source candidate delivery remain open. Production2099,
the user's model configuration and deployment state remain unchanged. No Docker
operation, commit, push, merge, publication or deployment occurred.

## Previous checkpoint: supplier timing agreement

The missing RULE-04.7 activation guard is now implemented. Publication and rollback
of a configured accepted/completed-time basis require a version-bound administrator
confirmation and an opaque review-record identifier. Draft simulation stays
read-only; default dispatch timing and already-published historical snapshots stay
unchanged. Backend enforcement covers direct API, inherited and scheduled prices;
the seven-language Dashboard provides a separate confirmation and clears it when
the reviewed input changes. This does not certify supplier timestamps or invoices.

The focused run passes126 SQLite/PostgreSQL unit tests and84 HTTP tests. The
subsequent full run passes **4,154 unit tests in203 suites and757 HTTP tests
in62 suites**, with no failures or skips. Builds, lint, frontend contracts and
unchanged bundle limits, SDKs, configuration/docs and static deployment/version/
registry checks pass. Migration001–018 checksums are unchanged. Existing Realtime/
ASR fixture writers now supply explicit synthetic timing confirmations; all their
previous lifecycle assertions are preserved.

Additional SQLite and independent-PostgreSQL-connection checks cover scheduled
activation, peer draft edits, stale confirmation, cancellation and rollback.
Actual browser checks cover seven locales in desktop/light and narrow/dark layouts
plus default-timing controls:16 read-only layout cases leave all recorded pricing/
financial/configuration state unchanged. Two confirmed publications and one rollback
verify the API payload and persisted audit, with19 screenshots and no provider calls.
The original RULE-04 time-basis review gap is closed; no supplier invoice or
timestamp verification is claimed. Initial private runner/fixture failures are
retained, followed by12 genuine pre-fix failing cases and the passing full run.

All owned test instances are stopped. No production2099 configuration, data or
process has been changed. Native HTTP performance, remaining original acceptance
and final-source candidate delivery remain open. No Docker action, commit, push,
merge, publication or deployment occurred.

## Previous checkpoint: core contract acceptance audit

The original quantity-property, exact-money, cache, composition, context-tier
and cumulative-stream requirements now have clause-level maps to actual passed
assertions in the unchanged 4,142-unit/753-HTTP source. An additional 256-case
compiled-calculator fixture agrees with an independent rational-arithmetic
oracle for all line fractions, duration rounding, currency conversion and
display adjustments. No application, test, dependency or compiled file changed,
and no new full regression or performance comparison was needed or claimed.

[The acceptance map](pricing-core-contract-acceptance.md) retains one explicit
calendar gap: calculation with alternative timing bases is supported, but the
current evidence does not prove required confirmation of the supplier's timing
agreement before selecting those bases. RULE-04 remains partial. The completed
normalized-week browser evidence is carried only for its unchanged modules,
not represented as a fresh whole-Dashboard verification.

The PostgreSQL profile was inspected, not rerun. Its repeated request ownership,
receipt and audit operations are real durability/integrity boundaries; no check
was removed to claim a latency improvement. Original native HTTP acceptance,
the remaining original requirements and final fixed-source Rancher delivery
remain incomplete. Production2099 and its user-edited model configuration remain
unchanged, with no restart, Docker action, publication or deployment.

## Previous checkpoint: publication FX review

An original-clause audit found a publication-preview gap: a non-USD price could
be published without any conversion warning, although quotation already kept
the report amount unknown. Publication and rollback now review the full proposed
interval against scoped FX, including future gaps and half-open expiry. The
Dashboard displays the gap periods and requires an explicit acknowledgment;
existing API clients can still publish original-currency prices. No default FX,
zero cost or historical revaluation is introduced. See the
[API contract](pricing-management-api.md#publication-contract) and the
[version/history acceptance map](pricing-version-history-acceptance.md).

The focused run passes 138 SQLite/PostgreSQL unit cases and 37 HTTP cases.
The subsequent full-source run passes **4,142 unit tests in 202 suites and
753 HTTP tests in 61 suites**, with no failures or skips. Builds, lint, frontend
contracts and existing bundle limits, SDKs, configuration/docs and static
deployment/version/registry checks pass. Migration001–018 checksums are unchanged.

The current source also passes the independent-PostgreSQL-connection version
rehearsal and the original version/history/access clause audit. Actual browser
checks cover all seven locales in desktop/light and narrow/dark layouts, plus
covered EUR and no-conversion USD controls: 18 read-only layout cases leave all
pricing/financial tables identical. Two additional English/Chinese publications
verify explicit missing-FX acknowledgment and its audit, with no provider calls.
Twenty screenshots and source-bound evidence are retained. Initial test-harness
method, decimal-format and login-selector mistakes remain recorded as failed
attempts; they were not hidden or worked around in the product.

All owned test instances have stopped. The prior native HTTP performance failures
remain unmet; this management-only change is not a throughput optimization.
Remaining original acceptance and the final-source Rancher candidate/bundle are
still required. Production2099 and the user-edited model configuration remain
untouched. Nothing has been pushed, merged, published or deployed.

## Previous checkpoint: composed receipt preflight

The composed settlement path no longer reads each stored attempt twice, once at
intent creation and again at application inside the same transaction. It retains
proposal checks and performs the current receipt/ownership/integrity checks during
application before commit. Queue-only callers still validate receipts before an
unapplied intent can commit. Retention and accounting durability are unchanged;
see [the exact boundaries](pricing-runtime-outcomes.md#composed-receipt-validation).

Sixteen new cross-database cases and the existing crash/replay/audit suite verify
those guarantees. Full regression passes **4,126 unit tests in 201 suites and
750 HTTP tests in 60 suites**, without failures or skips. Builds, frontend
contracts/budgets, lint, SDKs, configuration/docs and static deployment/version/
registry checks pass; migration001–018 checksums are unchanged. Four synthetic
HTTP outage hooks were moved to the common storage helper, with all previous
assertions preserved; the initial failing run remains in the evidence.

A separate 500-request PostgreSQL profile records 128 rather than 131 SQL
statements per request, with the same ten transactions and two independent
retentions. Both complete native comparisons verify 9,600 requests and 4,800 exact
candidate amounts per database. **HTTP performance remains unmet:** PostgreSQL
JSON/50ms adds 25.386ms p95 and loses 25.375% throughput; SQLite JSON/50ms adds
5.420ms p95, above the unchanged 5ms limit. No repetition or near-threshold
failure is discarded. The earlier pure-quote evidence remains bound to unchanged
pricing-core files; it is not a newly executed benchmark or an HTTP waiver.

All owned test instances are stopped. Broader original clause-level/platform
and final fixed-source candidate delivery remain incomplete. Production2099 and
the user's model configuration are unchanged. No image, commit, push, merge or
deployment was made.

## Prior checkpoint: indexed activation availability

The remaining whole-catalog scan in the admission availability check is removed.
Compilation unions activation intervals per workspace and globally; admission
uses binary search with one timestamp parse. The original model/node/operation
selector, price documents, hashes, compatibility policy and historical versions
are unchanged. See [the exact semantics and evidence](pricing-activation-index.md).

Ten new unit cases and four actual JSON/SSE scenarios verify scope, exact start/
end boundaries, gaps, historical stability and legacy fallback. A 1000-binding
diagnostic reproduces all 40,000 old/new results with an independent predicate;
the expired-catalog check drops from 2001 timestamp parses to one. This is not an
HTTP benchmark or a claimed performance waiver.

Fresh full regression passes **4,110 unit tests in 201 suites and 750 HTTP tests
in 60 suites**, without failures or skips, plus builds, frontend contracts/budgets,
lint, SDKs, configuration/docs and static deployment checks. Migration001–018
checksums are unchanged. A separate full-scale 10,000-quote run passes at p95
0.062625ms and p99 0.199125ms, with independent exact-amount verification.

The four PERF-01 hot-path/index/resource/pagination clauses now have consolidated
current-source evidence. **PERF-02's Gateway HTTP gate remains unmet**; the last
native comparison's two failed cases are retained, not relabeled by this lookup
improvement. Broader original clause-level/platform and final fixed-source
candidate delivery remain incomplete. All owned instances are stopped; production
2099 and the user's model edit remain untouched. Nothing was committed, pushed,
merged, image-published or deployed.

## Prior checkpoint: bounded exact-budget reads

Exact balances for selected budget rules are now read in bounded chunks rather
than one query per rule. Workspace/epoch matching, ordered locks, legacy
projection checks and reset behavior remain intact. A reservation reuses only
its just-hydrated rule objects, never a balance cached across transactions. See
[the read boundaries and tests](pricing-budget-hydration.md).

Complete regression passes **4,100 unit tests in 200 suites and 746 HTTP tests in
59 suites**, without failures or skips. Builds, frontend contracts/bundle budgets,
lint, SDKs, configuration/docs and static deployment/version/registry checks pass;
all 18 migration checksums are unchanged. A separate 500-request PostgreSQL profile
shows 131 rather than 136 SQL statements per request, with the same ten transactions
and two independent durable retentions.

Both full native comparisons complete 9,600 requests, with 4,800 candidate costs
and 16 exact balances independently verified per database. **HTTP performance is
still unmet:** PostgreSQL JSON/50ms adds 29.998ms p95 and loses 24.797% throughput;
SQLite JSON/0ms loses 5.970% throughput. All repetitions remain included. Other
passing cases and fewer queries do not waive these failures or prove a sole cause.
The separate full-scale 10,000-quote benchmark passes at p95 0.066167ms and
p99 0.322917ms, with all amounts independently checked using decimal arithmetic.

All owned verification instances are stopped. Broader original clause-level,
capacity/platform, unmet HTTP performance and final-source delivery gates remain
open. The prior Rancher image is stale; no new image or deployment is claimed.
Production2099 and the user's model edit remain unchanged. Nothing was committed,
pushed, merged or deployed.

## Prior checkpoint: authenticated end-to-end pricing workflows

English desktop/light and Chinese narrow/dark now complete the actual Dashboard
import, copy, edit, quote comparison, publication and rollback sequence under real
password/session authentication. Six explicitly invoked mock requests use V1,
edited V2 and restored-content V3, yielding 0.002, 0.005 and 0.002 USD per flow.
Rollback creates a new immutable identity; every earlier cost response and saved
finalized row remains unchanged. Full exports preserve hidden cache/TTL, context,
calendar and source fields. Copies remain unpublished and unbound.

Independent snapshot verification confirms read-only previews, draft-only edits,
six applied settlements, 38 expected audits and exact aggregate balances of
9000 tokens and 0.018 USD. Key identity/permission fields and fixture config stay
unchanged; only expected last-used metadata changes with mock traffic. Modal
bounds, scrolling, keyboard reachability and stale-consent invalidation pass.
See the [complete scope and retained harness failures](pricing-ui-roundtrip.md).

There are no application-code changes. The existing 4,080-unit/746-HTTP full
regression is carried by verified source and compiled-artifact hashes, not rerun
or relabeled. The integrated workflow gap is closed; broader clause-level
consolidation, capacity/platform, unmet native HTTP performance and final-source
candidate delivery remain open. No new image or performance result is claimed.
All owned test instances are stopped; production2099 and the user's model edit
are unchanged. Nothing was committed, pushed or deployed.

## Prior checkpoint: normalized calendar-week preview

The editor now shows the overlaid Monday–Sunday week for an explicitly selected
calendar-local date. A new bounded read-only endpoint compiles the supplied
calendar once and composes seven existing civil-date previews. It preserves
date-override/holiday/weekly/fallback precedence, overnight anchor dates and
explicit uncovered days. No independent calendar matcher or price formula is
introduced. See [the contract and operating limits](pricing-calendar-week.md).

The lazy seven-language view validates the input/calendar identities, hashes,
dates, coverage and contiguous segments. Day details page through12 segments at
a time. Date or unsaved-calendar edits hide the previous result; cancellation and
response validation prevent a late or partial result from appearing current.
Published documents can be previewed without enabling their disabled editor.
The view explicitly distinguishes civil-clock schedules from elapsed billable
time during daylight-saving transitions.

Fourteen real-browser layouts cover42 weeks and294 civil dates: Shanghai
overrides, holidays, midnight carry and dense pagination; a New York fall-back
week; and coverage boundaries. Independent expected segments agree. Altered
responses are rejected, unsaved edits are previewed without saving, and cancel/
retry succeeds. All pricing, budget, log and configuration snapshots are unchanged,
with zero provider calls. Browser fixtures are separate from the endpoint's real
password/session and viewer HTTP tests.

Full regression passes **4,080 unit tests in199 suites and746 HTTP tests in59
suites**, without failures or skips. Builds, frontend contracts/budgets, lint,
SDKs, config/docs and static deployment/version/registry checks pass. Migration
001–018 checksums are unchanged, and browser artifacts match the subsequent full
build. The preceding missing-week-view gap is closed; broader original workflow,
capacity/platform, unmet HTTP performance and final-source delivery gates remain
open. No new image or performance acceptance is claimed. All owned verification
instances are stopped. Production2099 and the user's model edit are unchanged;
nothing was committed, pushed or deployed.

## Prior checkpoint: context range table and UI workflow reconciliation

The context editor now has a16-row paginated range table for the selected rule
group. Exact string bounds, inclusive/exclusive intervals and equal-priority
conflicts update locally. The advisory check reuses the server's condition-overlap
predicate and media normalization, including service-tier/time/media exclusions;
it is not a second price calculator or a substitute for full publication validation.
Editing a range preserves every hidden rate, condition and off-screen rule.

Version/audit timestamps and capacity numbers now use the selected interface
locale rather than the browser default. All seven languages pass desktop/light
and narrow/dark checks for the range controls, compiler rejection of an overlap,
restoration/export, pagination and localized dates/counts. Visual review caught
a fieldset minimum-width clipping issue that the document-overflow check missed.
After fixing it, the fourteen layouts were repeated with actual region bounds
and table-local horizontal scrolling checks. Earlier functional runs are not
substituted for the corrected layout evidence.

An actual Dashboard workflow saves one synthetic draft, compares its0.004USD
quote with the still-published0.003USD price and replays an original0.001USD
receipt without rewriting it. Only the draft and one draft audit change; active
versions, request snapshots, budgets, logs and configuration remain identical.
There are no provider calls. This directly verifies UI-TEST-04 and STATE-08 for
this checkpoint. See the [clause-level status](pricing-ui-acceptance.md).

Frontend tests/build and the unchanged bundle budgets pass. Context-table and
historical-replay modules load only when their panels open; pricing and request
cost route gzip sizes are22.10KiB and7.17KiB. The final helper also normalizes
media values before overlap detection; sixteen direct compiler comparisons cover
that edge. This helper-only change follows the browser run, whose fixture contains
no media predicates; no additional media-browser run is claimed.

Backend source/tests, dependencies, migrations and compiled backend artifacts are
byte-identical to the completed4,067-unit/739-HTTP checkpoint. A new full backend
run is not claimed for this frontend-only change. All owned test instances are
stopped; production2099 and the user's model configuration remain unchanged.
The original normalized calendar-week view was still missing at that checkpoint;
it is implemented above. Remaining
UI/workflow/capacity/platform, performance and final-source delivery gates remain
open. Nothing was committed, pushed or deployed.

## Prior checkpoint: historical FX evidence

Request details now expose the historical conversion ratio, sanitized source,
effective time and admission time alongside the immutable FX version. Expansion
performs a lazy, workspace-authorized read bound to the exact retained receipt
hash. It uses the admitted catalog's existing FX selector, not today's schedule
or a rate inferred from rounded totals. Original and corrected receipt references
remain readable; missing evidence never causes a current-price fallback.

The new endpoint verifies the complete receipt/history and restores the request
catalog within one consistent read transaction. It returns only the selected FX
projection and its request/snapshot identity. No receipt JSON, financial state,
price configuration or migration is rewritten, and the display adds no FX lookup
to the model-request path. Snapshot restoration now rejects malformed JSON/shape
and mismatched admission timestamps with the existing structured integrity error.

Full regression passes **4,067 unit tests in 198 suites and 739 HTTP tests in
58 suites**, without failures or skips. This includes real Dashboard login/session
tests for the new endpoint, scoped viewer access, corruption and current-version
rejection, unchanged finances and original/corrected history. Builds, frontend
contracts/budgets, lint, SDKs, configuration/docs and static deployment/version/
registry checks pass; migrations001–018 are unchanged.

Fourteen real-browser layouts cover all seven languages in desktop/light and
narrow/dark modes. They verify 28 historical FX receipts, keyboard expansion,
localized UTC dates, 28 missing/same-currency cases without FX requests and a
corrupt-response rejection followed by explicit retry. All compiled browser
assets match the subsequent full build. See
[the display and API contract](pricing-dashboard.md#historical-fx-evidence).

The identified historical-FX display gap is fixed, not the entire original Goal.
Remaining UI/workflow/capacity/platform acceptance, unmet HTTP performance targets
and final-source candidate delivery remain open. The preceding Rancher image
does not contain this change. No image or performance acceptance is substituted
for those gates. All owned verification instances are stopped; production2099
and the user's model edit remain unchanged. Nothing was deployed or published.

## Prior checkpoint: mixed-report acceptance and historical FX display gap

The current compiled frontend and backend source pass a fresh mixed-report
rehearsal with 58 synthetic records: twelve actual mock-backed requests, 44 legacy
logs, one missing receipt and one invalid snapshot. All eight report statuses,
legacy versus immutable evidence, explicit free, unknown amounts and CNY/USD
conversion are checked through the real application. Historical amounts remain
fixed after publishing a different FX version; a missing conversion retains the
CNY original and unknown USD rather than inventing a zero.

All seven languages pass desktop/light and narrow/dark report workflows, including
both pages, visible row classification and downloaded JSON totals. An independent
decimal calculation reproduces the four separate amount buckets. English desktop
and Chinese narrow-screen checks cover 32 request-detail cases. A failed next-page
read preserves the partial export; retry completes without double counting.
Workspace switching clears old totals, another workspace cannot read the original
detail, and a viewer is not offered correction actions. See the
[precise evidence and limitations](pricing-cost-report.md#mixed-report-browser-checkpoint-2026-09-30).

This review identified an **UI-04 gap**, fixed in the later checkpoint above:
request details displayed the frozen
FX version and original/report amounts, but not that version's exact rational rate,
source or effective time. Correct amounts and a version ID alone do not complete
the required explanation. The fix must read the request's immutable FX evidence,
not today's schedule or a rate inferred from rounded totals. No fix for that gap
was claimed at this earlier checkpoint.

Application code, tests, dependencies and compiled assets are unchanged from the
4,031-unit/734-HTTP full regression and current Rancher image. This is new browser
acceptance evidence, not a new full test run or performance comparison. Browser
actions leave pricing, budgets, logs and fixture configuration unchanged; only
the two expected workspace-selection POSTs accompany the scope check. The fixture
uses test-only unauthenticated Dashboard mode, not a new login certificate.
All owned instances are stopped. Production2099 and the user's model edit remain
unchanged. Historical FX display, remaining original acceptance, unmet performance
targets and final-source delivery still prevent Goal completion.

## Prior checkpoint: current-source Rancher image and SQLite recovery

The 1,326-file log-subtotal source now has its own Rancher Desktop Moby
Linux/ARM64 image and review bundle. Runtime, frontend and dependency files are
identical to the completed **4,031-unit/734-HTTP** full regression; this checkpoint
adds image/platform evidence, not another native full run or a performance pass.

The actual packaged entrypoint and health check pass legacy startup, explicit
migrations001–018, authenticated JSON/SSE, cached and long-context pricing,
historical-cost preservation and normal shutdown. Both an idle nonzero process
exit and unexpected closure of the real HTTP listener cause automatic recovery
on the same temporary host-loopback port. All requests use synthetic local mocks.

Three online SQLite backup-API artifacts are exported outside the VM and checked
independently, read-only. Restoring the latest into fresh storage preserves keys,
immutable prices/receipts and the unknown-cost hold; a new authenticated request
succeeds without redispatching unresolved supplier work. Image/source archives,
locked dependencies and migration checksums have verified hashes. See the
[recorded image scope](pricing-rancher-rollout.md#current-source-image-checkpoint-2026-09-30)
and [restore scope](pricing-database-recovery.md#log-subtotal-source-image-restore-2026-09-30).

All owned runtime containers, fixture networks and successful-fixture volumes are
removed, and the task-owned builder is stopped. Other Rancher containers, engine
settings, global Docker context, production2099 and the user's model edit remain
unchanged. No production port was published, and nothing was committed, pushed or
deployed. The bundle is an explicit uncommitted overlay, **not**
`READY_FOR_REVIEW_NOT_DEPLOYED`: original performance targets, remaining
workflow/capacity/platform acceptance and final fixed-source delivery remain open.

## Prior checkpoint: log subtotal read scope

Numeric log projection now skips settlement-intent and recovery-case metadata
queries used only for detailed display. It retains the same shared receipt,
adjustment-chain, decimal, reservation and allowance checks and the existing
request-lock/commit boundaries. Only the internal numeric overload returns a
subtotal; ordinary detail, report and replay paths remain complete. There is no
cross-transaction cache or independent second pricing formula.

Full regression passes **4,031 unit tests in 197 suites and 734 HTTP tests in
57 suites**, without failures or skips. Sixteen new cases verify the narrower
read scope, detailed-report parity, corrupt-input rejection and fresh correction
visibility. Builds, frontend contracts/bundle budgets, lint, SDKs, config/docs and
static deployment/version/registry checks pass; migrations001–018 are unchanged.

Profiling confirms 140 to 136 SQL statements per request, with ten transactions
and two independent retentions unchanged. The complete comparisons retain exact
accounting for 19,200 requests, but PostgreSQL still fails three scenarios and
SQLite fails delayed SSE p95. See [the measured results](pricing-performance.md#log-subtotal-read-scope).
No thresholds or durability requirements were relaxed. Frontend source is
unchanged from the prior editor checkpoint; no new browser or image acceptance
is claimed. Remaining original acceptance and final-source delivery are open.
All owned test instances are stopped; production2099 and the user's model edit
remain unchanged. Nothing was restarted, deployed or published to Git.

## Prior checkpoint: editor confirmation and mutation workflows

Multiplier and calendar-item deletion now requires the same localized confirmation
as rate deletion. Cancellation preserves the draft. The missing multiplier
confirmation was first reproduced in a browser, then covered by eight actual
component-callback paths and native checks across all seven languages in desktop
light and narrow dark layouts. Those 14 layouts verify 84 cancellations and 28
accepted local deletions, with exact exported-document comparisons and no provider
calls or unintended pricing writes.

Separate browser workflows verify rejected blank prices, explicit free and restored
parent inheritance, stale-save HTTP409 and confirmed reload, node-name edits that
preserve hidden pricing/capabilities and 5m/1h books, and invalidation of publication
consent after form changes. Only the expected synthetic draft/audit records and
fixture node configuration change; active versions, catalogs, budgets and logs
remain untouched. See [the exact scope and limitations](pricing-dashboard.md#editor-mutation-confirmation-and-conflict-acceptance).

Frontend tests, build, locale and bundle checks pass. Backend, dependencies, SDKs,
migrations and backend tests are byte-identical to the previous complete
**4,015-unit/734-HTTP** checkpoint; no new backend run is claimed for this frontend
patch. Production2099 and the user's model edit are unchanged, with no restart,
reload, deployment or Git publication. All owned verification instances are stopped.
Performance, remaining original acceptance mapping and final-source candidate
delivery still prevent Goal completion.

## Prior checkpoint: original management API contract

The thirteen original management operations now have a consolidated authenticated
HTTP contract: real local login/session cookies, rejected invalid or disabled
legacy tokens, stored viewer/other-workspace membership, per-resource scope,
JSON/origin/body limits, read-only simulation and complete required error codes.
Lifecycle coverage includes revision conflicts, scheduling, confirmation/reason,
preview and atomic rollback on audit failure. See
[the operation-by-operation map](pricing-management-api.md#original-management-contract-verification).

That audit reproduced a source-redaction gap: a trailing DNS root dot let an
internal hostname escape the existing local-reference filter. Backend export,
model-status metadata, configuration-import provenance and frontend export now
normalize the hostname before filtering. Stored prices are not rewritten. Actual
browser downloads of a draft and published version retain all six rate components
and omit the internal reference; pricing/configuration/financial snapshots are
unchanged, with no supplier calls or browser errors. This is a focused export
check, not a new all-page browser certificate.

Full regression passes **4,015 unit tests in 197 suites and 734 HTTP tests in
57 suites**, without failures or skips. Builds, frontend contracts/bundle budgets,
lint, SDKs, config/docs and static deployment/version/registry checks pass; all
18 migration checksums remain unchanged. The new contract contributes 22 HTTP
cases; eight additional unit cases cover metadata/import filtering. Initial
fixture typing and incorrect field names were corrected; the separately
reproduced redaction failure is retained in the evidence.

The original API-01 contract is verified at this checkpoint. Later recovery/media
administration, remaining UI/workflow/platform mapping and final-source delivery
still require their separate gates. There is no new performance comparison or
image claim: the last comparison below remains unmet. Production2099 and the
user's model edit were not changed, reloaded or restarted. No deployment or Git
publication occurred; all owned verification instances are stopped.

## Prior checkpoint: transition audit verification

Runtime outcome transitions now bind captured caller identities to the actual
locked owner and fresh persisted row, rejecting mismatched request/workspace
metadata and returning a structured error for missing rows. Under that same lock,
the verified absence of a transition audit avoids a redundant lookup before its
unique insertion. Joint acknowledgements use the transition's complete fresh
verification once; non-acknowledging paths retain their separate checks.

The ten new reproducing cases pass on SQLite/PostgreSQL. Complete regression
passes **4,007 unit tests in 197 suites and 712 HTTP tests in 56 suites**, with
no failures or skips. Builds, frontend contracts/bundle checks, lint, SDKs,
configuration, docs and static deployment/version/registry checks pass; migration
checksums001–018 are unchanged. All owned test services and private databases
are stopped. Frontend source/dependencies match the prior browser checkpoint;
no new browser or image acceptance is claimed.

Profiling confirms 143 to 140 SQL statements per request, while ten transactions
and both independent retentions remain. The complete 19,200-request comparisons
have exact amounts/balances, but PostgreSQL still fails three scenarios and
SQLite fails zero-delay JSON throughput. See [all measured results](pricing-performance.md#transition-audit-verification).
No threshold, durability setting or repetition was relaxed. Performance and
remaining original workflow/API/UI/platform evidence, plus final-source delivery,
still prevent Goal completion. Production2099 and the user's model edit are
unchanged; no restart, deployment or Git publication occurred.

## Prior checkpoint: bounded historical replay

Historical replay now bounds cumulative selected rows, source bytes, complete
response bytes, calculation/serialization work and elapsed time, in addition to
the existing 30-request and input-body limits. Reads use one owned snapshot with
size inspection before hydration. Cancellation, a single-instance replay slot
and shutdown draining keep work owned until cleanup finishes. PostgreSQL has
transaction-local statement timeouts; SQLite restores its scoped busy timeout.
The deadline is cooperative, not absolute native-operation preemption. See
[the exact defaults and limits](pricing-resource-limits.md#historical-replay-semantics).

Successful replay explicitly reports completeness. Limit/time/busy failures return
no partial results, and the dashboard clears a prior simulation before rerunning.
Chinese desktop/light and English narrow/dark browser checks verify success and
HTTP422/408/429 errors, localized alerts and stale-result removal. Financial and
configuration snapshots and mock supplier-call counts remain unchanged; the
accepted browser run has no JavaScript exceptions or horizontal page overflow.
Earlier failed browser instrumentation is retained separately, not counted as
application acceptance.

Complete source-matched regression verifies **3,997 unit tests in 197 suites and
712 HTTP tests in 56 suites**, with no failed or skipped test cases. The initial
unit wrapper incorrectly expected 3,996 and stopped after all 20 batches passed.
The preserved raw inventory proves the extra PostgreSQL-only timeout case; the
count was reconciled without rerunning or altering tests. Remaining HTTP/build
gates use identical source and a new private PostgreSQL cluster. Builds, frontend
contracts/bundle budgets, lint, SDKs, configuration, documentation and static
deployment/version/registry checks pass; all 18 migration checksums are unchanged.
Both private PostgreSQL clusters and the browser fixture are stopped.

This closes the identified replay-resource gap, not the whole Goal or API audit.
No new runtime performance comparison or Rancher image is claimed here. The last
complete comparisons below still fail two PostgreSQL cases and one SQLite case;
remaining original acceptance mapping and a final-source candidate are unfinished.
Production2099 and the user's model configuration were not changed, reloaded,
restarted or switched. Nothing was pushed or deployed.

## Prior checkpoint: joint receipt delivery

PostgreSQL synchronous legacy-budget requests now retain their receipt independently,
then apply it with its acknowledgement and budget settlement in the final transaction.
They await the settlement attempt before returning; failed composition, request teardown
and another dispatch drain the owned standalone receipt. SQLite's normal runtime,
streams, actual-upstream budgets and media/batch lifecycles do not use this optimization.

Pending attempts also check any independently retained receipt before applying a
proposal: a different cost, missing audit, quarantine or incorrect owner cannot be
overwritten merely because the terminal attempt projection is still pending. Joint
delivery revalidates even previously delivered audits. Variant discovery fetches
bounded distinct identities, then only exact matching bodies.

Complete regression passes **3,950 unit tests across 196 suites and 704 HTTP tests
across 55 suites**, with no failures or skipped tests. Builds, frontend contracts,
SDKs, lint, configuration, docs and static deployment/version/registry checks pass;
all 18 migration checksums remain unchanged. The 34 new cases include a real child
exit before commit on both databases. Both earlier red experiments are retained.

The fresh native profile records 143 SQL statements and 10 transactions per request,
versus 152 and 11 previously; both independent retentions remain. Both complete
9,600-request HTTP comparisons have exact accounting, but performance is still
unmet: PostgreSQL passes two scenarios and fails two; SQLite passes three and fails
SSE/50ms at +5.186ms p95. No threshold was rounded or waived. See
[the current performance evidence](pricing-performance.md#joint-receipt-delivery).

An API audit also identified an unfinished replay bound: the handler caps request
IDs at 30 but loads their full summaries and maps all attempts without an explicit
elapsed-time/work bound. Shared guards and bounded replay behavior still need to
be verified or completed. This is not a whole-API failure claim.

The old image does not contain this change. Remaining original acceptance mapping,
performance, replay limits and final-source delivery prevent Goal completion.

## Prior checkpoint: bounded audit verification

Runtime outcome audit verification now uses one bounded workspace-scoped read
instead of two, without removing actor, action, hash or state validation. The
request-first lock and independent durable-retention/application boundaries are
unchanged. Focused verification passes 137 unit tests and 132 HTTP tests, build
and lint. Complete regression now passes **3,916 unit tests across 196 suites and
704 HTTP tests across 55 suites**, with no failures or skipped tests. Backend and
frontend builds, frontend contracts, SDKs, lint, configuration, documentation,
migration checksums and static deployment/version/registry checks also pass.
The full run uses a fresh, durable private PostgreSQL cluster; it is stopped.

Both full HTTP comparisons completed 9,600 requests with exact amounts and
balances. All four SQLite cases pass; PostgreSQL still fails three cases, with
the JSON/50ms case adding 28.786ms p95 and reducing throughput by 25.450%.
Profiling confirms 154 to 152 SQL statements per request, but this alone does not
satisfy the performance goal. See [performance verification](pricing-performance.md#bounded-runtime-audit-reads).

The previously verified Rancher image and recovery bundle predate this runtime
change. A final-source image, remaining original acceptance mapping and fixed-source
delivery are not complete. The user's model edit remains in the confirmed
production baseline; 2099 was not restarted, switched, reloaded or written.

**Entries below are historical checkpoints, not a current TODO list.** In
particular, early ASR-unimplemented and earlier SQLite-performance-pass statements
must be read with their later, source-specific evidence and the current status above.

## Realtime automatic-audio custody — implementation checkpoint

Realtime now classifies non-generating controls in both budget modes instead of
treating every client message as another model request. First response identities
and mode acknowledgements are applied before the accounting queue. Automatic
VAD commits, default-conversation responses and acknowledged buffer clears have
bounded, deduplicated custody; a clear cannot acknowledge newer audio or an
uncompleted generation. Explicitly disabled VAD generation is distinguished from
an unknown setting or an enabled idle-response timeout.

Five real loopback WebSocket cases cover legacy/actual automatic completion,
newer audio after a clear, a missing response and independent ASR expense. Eight
real subprocess exits cover response/closure/settlement/unknown-ASR boundaries
on SQLite and PostgreSQL. The current scoped checkpoint passes54unit and70HTTP cases,
backend/frontend builds, child-helper typechecking, lint and frontend/doc checks.
Four compiled-main cases separately verify clean automatic completion, newer
audio, independent ASR and active-session shutdown. Only the fully acknowledged
case commits; the others preserve known fees with unresolved holds. The prior legacy
WebSocket fixture lacked any mode/correlation evidence; its successful explicit
generation fixture now carries matching metadata rather than assuming all
unsolicited responses acknowledge client commands.

The subsequent full regression passes3561unit tests across180suites and604E2E
tests across47suites, with no skipped or failed tests. E2E discovery is covered
in10fresh serial processes under the unchanged2GiB heap limit. Backend/frontend
builds, both crash-helper typechecks, lint, frontend contracts/bundle budgets,
docs, SDKs and deployment/version/registry checks pass. The final compiled build
also passes eight Realtime entrypoint cases: the four automatic-audio cases plus
active shutdown, abrupt disconnect, pending handshake and normal client close.
This is a full regression checkpoint, not completion of the remaining Goal.

Independent transcription is recognized but not yet fully priced. Its native
usage belongs to an ASR model and cannot use the Realtime tariff. Unresolved ASR
work keeps its hold; transcripts/audio are not retained. Model-specific ASR
allowances, receipt/correction flows, other original lifecycle gates, performance
and candidate delivery remain incomplete. See [Realtime boundaries](pricing-realtime.md).

## Same-model node contracts — CALC-22 cross-layer checkpoint

Four HTTP scenarios now exercise the same logical model on two nodes with
different contracts, for JSON/SSE and legacy/actual budgets. Node A's observed
paid failure and B's successful fallback retain separate prices and receipts.
Publishing a tenfold B price during A's execution does not change the in-flight
fallback; a later B request uses the new version. Published quotes, both receipts,
budgets, logs and cost-report rows agree. The scoped run passes188unit cases and
38HTTP cases, plus backend build/lint. The initial new fixture run failed on an
incorrect default import of Node's assert module; the corrected named import and
all four scenarios are verified, not skipped.

The actual-budget SSE browser fixture adds28detail/layout checks in seven locales,
42physical-attempt views and seven rendered old-versus-hypothetical comparisons.
All63accepted screenshots have visible amount evidence. Independent decimal
arithmetic verifies0.0046 USD for the original two-attempt request and0.034 USD
for the later request. The complete pricing/budget/log state stays unchanged
during browser inspection and simulation; supplier calls stay at the three
fixture dispatches. Wrapped amounts are hit-tested per text-line rectangle,
not the empty gap between lines. External font CSS is blocked; fallback fonts
were visually inspected. See [node contract operations](pricing-node-contracts.md).

No business code changed in this checkpoint; it adds the shared synthetic fixture,
regression tests, documentation and evidence. Original performance and remaining
lifecycle/delivery gates stay open. A correlated diagnostic separated the50ms
mock wait from admission/dispatch scheduling delays; a private cooperative SQLite
scheduling experiment was slower and was **not** added to the application.
Neither instrumented run is used as performance acceptance.

## Tracked stream receipt delivery — regression and follow-up fixes

Stream receipts now have a durable retention boundary before normal HTTP
completion and tracked delivery before settlement/request disposal. Actual
finality fences new dispatch synchronously; concurrent same-group receipts are
all drained, and post-return retention cannot leave an abandoned callback.
SQLite and PostgreSQL tests cover immutable capture, audit rollback, replay,
quarantine and a real subprocess exit before delivery. The full checkpoint
passed3542unit tests and585E2E tests, including missing usage, duplicate cumulative
SSE and first-retention failure cases. Backend/frontend builds, lint, frontend
contracts and bundle limits, docs, SDKs, deployment templates and release/registry
checks also passed. E2E execution covered the entire46-suite inventory in10
fresh serial processes under the unchanged2GiB heap limit.

Subsequent targeted reproduction found two additional boundaries: a concurrent
late stream could retire a lease while another retained receipt was draining;
and a short-connection shutdown could finish after accounting but before a late
queued call log was saved. Lease retirement now checks pending delivery too.
Shutdown drains pending pipeline log/trace writes after request completion,
before database disposal. Both regressions were observed failing before their
fixes. The current scoped run passes188unit and49HTTP/runtime cases, build and
lint. That focused current-source proof does not relabel the earlier full run as
a full run of these later changes; a final full regression remains required.

A deterministic compiled-main shutdown fixture passed four scenarios: both
legacy and actual budgets, paused before retention or after HTTP completion but
before delivery. SIGTERM waits for the pause to release; every request retains
its exact receipt, one budget debit and one log before clean exit. This fixture
pauses only the main thread; an earlier faulty preload also affected the SQLite
analytics worker and is retained as failed diagnostic evidence, not acceptance.
The corrected current build additionally passes two explicit short-connection,
late-log barrier scenarios described in [shutdown ordering](pricing-shutdown.md).
An earlier keep-alive-only probe was too weak to expose the late-log race and is
not treated as proof that short-connection shutdown was already safe.

The unchanged four-scenario SQLite comparison completed9600requests across16
processes. Independent exact-decimal checks passed4800candidate costs and16
balances, and all processes drained successfully. Incremental pooled p95:
JSON0ms−3.184ms, SSE0ms−6.301ms, JSON50ms+3.752ms, **SSE50ms+13.457ms**.
Throughput reductions were0.378%,−2.975%,2.097%,3.437%. The delayed SSE scenario
still exceeds the5ms target: **overall HTTP performance remains unmet**. Moving
delivery beyond HTTP completion is not claimed as a completed performance fix.
PostgreSQL comparison and the original remaining lifecycle/UI/candidate gates
also remain open. Production2099 was not changed; nothing was deployed or pushed.

## Semantic unsaved-change detection and CALC-13

The admission editor no longer compares JSON property insertion order when
detecting unsaved changes. It reuses the existing structural change helper;
actual value changes, removed overrides, zero versus absent values, exact decimal
strings and reason/reference edits remain distinct. Confirmation for real unsaved
work is preserved, not disabled. The regression first failed against the original
comparison before the component was corrected.

Across seven locales,56browser scenarios now close untouched or restored forms
without a false prompt, including edit/preview/undo. Another21scenarios confirm
real cap, reason and reference changes still require confirmation; dismissing the
prompt preserves the input, and restoring it then allows clean closure. Pricing,
budgets and logs remain unchanged, with no provider calls from these checks.

CALC-13 now also has a complete three-state current-catalog fixture: a genuinely
unbound model, a priced model with missing duration, and an explicitly free
model. Three actual synthetic requests and42seven-locale/layout simulations agree
on `unpriced`, `missing_usage` and `free`. The first two retain unknown amounts
and pending holds; only explicit free shows a known zero. The unbound target has
no invented book, version or original currency. All42screenshots have visible
status/amount evidence, and simulation leaves accounting state unchanged.

Only the editor and frontend contract tests changed in this cycle. Frontend
tests/build and unchanged bundle limits, docs and whitespace checks pass. Backend
source and locked dependencies are identical to the preceding full checkpoint;
that historical evidence is not described as a new same-source full run. All
owned browser/test resources are stopped, and production remains unchanged.
Remaining original lifecycle, numerical, performance and delivery gates remain
open; this is not final readiness or deployment authorization.

A subsequent same-code SQLite performance comparison passes all9600request and
accounting checks but still misses the delayed-SSE p95 target: +16.594ms versus
the allowed5ms. The other three scenarios pass, and pure-quote p95/p99 pass at
full synthetic scale. Instrumented request/CPU evidence is retained to guide the
next optimization; it does not waive the failed gate. See the
[current performance record](pricing-performance.md#2026-09-29-current-source-verification--delayed-sse-still-unmet).

## Realtime actual-expense cohort and additional calculation acceptance

Native Realtime now supports an explicit actual-upstream budget policy. It awaits
a durable provider connection intent immediately before transport dispatch,
distinguishes known no-send admission from an unacknowledged handshake, and closes
connection/response expenses through the shared actual-cohort inbox rather than
a separate logical settlement. Known failed/cancelled response costs survive;
unknown or conflicting work retains its hold. Session time freezes at transport
closure, before queued accounting finishes. Existing policies retain their
previous accounting basis.

Parallel generation tracking no longer lets one response acknowledge several
commands. Unique ephemeral metadata correlation or supplier-confirmed manual
generation establishes the match; raw metadata is not retained or injected.
Session-mode acknowledgement is applied in transport order, not after delayed
database work. Unclassified automatic audio/VAD work and independent transcription
remain incomplete boundaries, not silently free or claimed fully supported.
The seven-language policy UI now explains those limits.

Scoped tests pass36unit cases and56HTTP cases. New real WebSocket tests cover
parallel manual completion, a missing second response, uncorrelated automatic
work and out-of-order uniquely correlated responses. SQLite/PostgreSQL cases
cover exact reservation, pending evidence, debit rollback and retained closure
replay. The fixed-source full run passes **3528unit tests in180suites** and
**571E2E tests in45suites**, without skips or failures. All E2E files are verified
across9fresh serial processes under the unchanged2GiB heap limit. Backend/frontend
builds, child-fixture types, lint, SDKs, docs, static deployment checks,
version/registry checks and existing frontend bundle budgets pass.

Four compiled-entrypoint actual-policy scenarios cover active shutdown, abrupt
disconnect, unacknowledged supplier handshake and clean client closure. Known
fees survive the first three pending cohorts; the clean cohort commits once.
Fourteen current Realtime configuration-dialog cases across seven locales and two
layouts verify selection, response-limit previews and localized warnings, with
28screenshots and unchanged pricing/budget/log snapshots. These are preview
checks, not GUI publication acceptance. Restoring original form values still
triggered a discard prompt; the semantic dirty-state comparison remains an open
UI audit item rather than being dismissed as a successful save workflow.

Additional cross-layer calculation checks now cover CALC-16,17,20,21: frozen
7CNY-to-1USD conversion and missing FX, sub-micro component accumulation with an
explicit rounding adjustment, unknown-TTL generic writes, and reasoning already
included in output. Seven synthetic requests produce98locale/layout cases,
196real frontend quote responses and196screenshots. GUI simulations preserve
historical amounts without claiming their manually entered FX has the request's
published FX identity. Missing duration and explicitly free usage also remain
distinct; the separate CALC-13 no-price case is still required. The seven requests
have1.005001USD in known committed costs and two unknown costs, not a fully known
combined total. GUI checks perform no new provider work or accounting mutations.

All owned fixtures, browsers, listeners and PostgreSQL instances are stopped.
Production remains unchanged. The original Goal still requires remaining native
Realtime/late-evidence/crash boundaries, lifecycle/race and requirement audits,
the unmet performance target and final portable candidate/image/rollback delivery.
No deployment, restart, commit or push has occurred.

## Actual audio/rerank accounting and bounded full regression

Audio transcription, translation, speech and rerank now join the explicit
actual-upstream policy. Their synchronous attempts use the shared exact expense
closure, including paid failures, retries and late known usage after client
cancellation. PCM duration, Unicode character counts, provider-reported document
counts and token evidence remain distinct. Explicit combined token/duration
contracts retain token rules; non-token tariffs still enforce monetary budgets.
An asynchronous acknowledgement is not a completed job, and this checkpoint does
not add an asynchronous audio/rerank completion adapter.

New regressions exposed two real errors before correction: an exhausted token
quota could block an explicitly non-token request in the legacy precheck, and a
pending rerank acknowledgement could be finalized as an invocation fee. The
captured non-token policy now uses the ledger's atomic monetary reservation and
frozen-tariff checks instead of that all-rule precheck. Switching back restores
token checks for new requests. Pending rerank work retains its dispatch and hold.
The expanded quantity HTTP suite has64cases, including credential/outer-attempt
allowances, monetary rejection, cancellation, pending acknowledgements and
reported-token/combined pricing. Its scoped acceptance passes62unit and97HTTP
tests with no failures or skips.

The fixed-source full unit run passes **3508tests in178suites**. The first
monolithic E2E process exhausted its2GiB heap; that is retained as a failed run,
and its later build checks did not execute. With no source or dependency changes,
all44E2E suites were then rediscovered and run in9fresh serial processes under the
same heap limit. Their checked, non-overlapping inventory passes **549tests** with
zero failures or skips. The completed unit evidence is explicitly reused from the
identical source rather than represented as another execution. Backend/frontend
builds, child-fixture typecheck, lint, docs, SDKs, static deployment checks,
version/registry checks and unchanged frontend bundle budgets pass afterward.
The compiled entrypoint also passes the three existing Realtime shutdown and
disconnect scenarios; those do not prove actual-expense Realtime integration.

The current browser fixture pairs four synthetic audio/rerank requests with their
published quotes and committed actual costs. Seven locales and two layouts cover
56configuration-dialog cases,28screenshots and four additional changed-policy
previews. Published selections, incompatible choices, exact preview payloads and
horizontal bounds are checked. Pricing/budget/log snapshots remain identical
through the GUI checks, with no additional supplier calls. This is preview and
selection evidence, not a new claim of GUI publication acceptance. Initial helper
failures were corrected without changing application behavior or relaxing checks.

All owned test/database/browser processes are stopped. Production remains
unchanged. The original Goal is still incomplete: actual Realtime attribution and
unacknowledged-response custody, remaining lifecycle/race and requirement audits,
the unmet performance target, portable final evidence, candidate image and
database-aware rollback delivery remain required. Nothing was committed, pushed,
deployed or restarted in production.


## Media FX, subprocess recovery and CALC-10–12 checkpoint

Current media-specific validation passes76SQLite/PostgreSQL unit cases and49HTTP
cases, plus backend/frontend builds, lint, docs, contracts and unchanged bundle
budgets. Eight of the unit cases terminate a real child process at four receipt or
transaction checkpoints in both databases, then recover through a fresh connection.
The expected checkpoint and exit code are checked; the fixture's initial CommonJS
assertion-import error and accidental Jest-only helper dependency remain failed
evidence, not successful crash tests. A separate typecheck covers the child helper.

New actual-media tests also pin price and FX identities through concurrent catalog
changes, late corrections and new admission; exercise all three image operations
in synchronous/asynchronous forms; and preserve costs across cancellation, content
delivery failure and reviewed unknown-job lookup. The lookup fixture initially
expected provenance labels at the wrong response level; the assertion now checks
the existing retained preview contract rather than changing the API.

CALC-10–12 now have an exact cross-layer browser matrix: six synthetic request
receipts, six published quotes, and84dashboard case/locale/layout combinations in
all seven languages. Both displayed simulations agree with the retained request's
line quantities, billed quantities, rates, rule IDs and exact amounts. The matrix
checks USD0.12/0.16 images, USD0.66/0.72 video and USD0.061/0.12 audio, including
visible measured-versus-rounded quantities. UI runs leave pricing/accounting tables
unchanged and add no supplier calls. See [media acceptance](pricing-media-acceptance.md).

The subsequent fixed-source full run passed **3,482 unit tests in177suites and
485E2E tests in43suites**, with zero failures or skips. It also passed the explicit
child-helper typecheck, backend/frontend builds, lint, docs, both SDKs, static
deployment validation, version/registry checks, and unchanged frontend bundle
budgets. The freshly compiled entrypoint passed all three retained Realtime
shutdown/disconnect scenarios. Actual audio budget-basis activation is not claimed
by the audio arithmetic test, and those shutdown cases do not prove actual-cost
Realtime support. The original audit now covers41of101requirement families; all
remaining integration, performance and delivery requirements stay in scope.

## Whole-reservation media finality — implementation checkpoint

An isolated regression first reproduced premature finality: the first completed
media task fenced the reservation while its sibling was still live, then the
sibling's initial receipt was rejected. The implementation now retains individual
receipt/audit pairs before finality and closes only after all asynchronous members
have acknowledged terminal receipts. The stored authority references every member;
earlier synchronous expenses still contribute without becoming async authorities.
See [media cohorts](pricing-media-cohorts.md).

The latest scoped integration run passed297unit tests across4suites and38HTTP
media tests. It covers sibling completion, queued corrections, signed alternatives,
reject/accept review, lost acknowledgements, transaction rollback, concurrency,
fresh-connection replay, earlier synchronous expenses and background completion of
every member. Backend/frontend builds, lint, docs, shared contracts and unchanged
bundle budgets also passed. Earlier failed runs remain evidence: a transaction
guard was incorrectly placed on a read-only summary helper; raw-table ordering
needed explicit column aliases; reserved actual-cost evidence was incorrectly
blocked by the legacy review guard; and rejection had inadvertently invoked
financial processing. Those defects were corrected without changing the legacy
rejection contract or permitting unaudited financial writes. The zero-warning lint
gate also caught a moved helper's unused import, which was removed.

The subsequent fixed-source full run passed **3,472 unit tests in177suites and
474E2E tests in43suites**, with zero failures or skips. Backend/frontend builds,
contracts, unchanged bundle budgets, lint, docs, SDKs, static deployment assets,
version and registry checks passed. The freshly compiled actual entrypoint also
passed the three retained Realtime shutdown/disconnect scenarios. Those scenarios
do not certify actual-cost Realtime integration or a final container image.

Whole-reservation media custody is now included in administrative recovery
fingerprints and readiness. A verified actual cohort can review a terminal receipt
while its budget is still reserved; legacy restrictions remain. Review rejection
retains its prior no-financial-processing contract. Deferred financial processing
is explicitly reported even when durable receipt storage succeeded.

The original requirement audit has now examined40of101requirement families; the
newly examined media/state entries remain partial. Actual-media in-flight FX/rate
changes, all image-operation variants, actual-path subprocess interruption and
delivery-failure pairings need stronger evidence. Performance and final portable
candidate/image/rollback gates remain open. No production deployment is authorized.

## Explicit non-token quota checkpoint

An optional, captured `token_budget` policy now distinguishes unchanged/reported
token rules from explicitly inapplicable token quotas for pure non-token media
prices. The ledger independently checks the original catalog, filters only token
rules, and preserves monetary rules, old requests and missing usage evidence.
Mixed token prices (including free token components), missing bindings and changed
attempt targets cannot bypass the frozen contract. See
[media token budgets](pricing-non-token-budgets.md).

The scoped pass completed **44 SQLite/PostgreSQL unit cases and 37 HTTP cases**,
with no failures or skips, plus backend/frontend builds, lint, docs, browser
contracts and existing bundle budgets. It includes default daily-token rules,
explicit non-token completion, unchanged over-limit token rules, old snapshots,
monetary-limit rejection and mixed-price rejection before provider IO.

Real-browser governance preview and publication submitted identical policy
payloads. Reopening retained the selection. The dialog was checked in all seven
locales at 1366/light and 768/dark, including incompatible-combination blocking,
localized descriptions and horizontal overflow checks. Screenshots were repeated
after the dialog animation finished; the initial animated frames are retained,
not substituted for steady-state visual evidence. A published-policy simulation
returned the synthetic 6.4-second-plus-generation cost of USD0.66. Revoking the
fixture operator's admin role while the dialog was open caused the subsequent
preview to return403, without changing pricing data. No supplier was called.

The subsequent fixed-source full run passed **3,450 unit tests in177suites and
473E2E tests in43suites**, with no failures or skips. Backend/frontend builds,
contracts, bundle budgets, lint, docs, both SDKs, static deployment validation,
version and registry checks passed. The freshly compiled entrypoint passed all
three retained Realtime shutdown/disconnect scenarios. These smoke scenarios do
not claim that actual-upstream Realtime accounting has been implemented.

Non-token quota semantics are no longer an unimplemented proposal, but broader media/custody and
Realtime integration, complete calculation/UI pairings, requirement audit,
performance and final fixed-source candidate/image/rollback delivery remain.

## Actual asynchronous media — in progress

The earlier embedding-batch full checkpoint completed **3,406 unit tests in
176 suites and 467 E2E tests in 43 suites**, with no failures or skips. Builds,
frontend contracts, lint, SDKs, static deployment checks and three compiled
actual-main Realtime scenarios also passed. That checkpoint predates the new
media implementation; its full-run evidence is not current-media acceptance.

Actual media processing now uses the retained terminal observation as authority,
rather than constructing a gateway-runtime receipt for an asynchronous job.
Original-price calculation, the receipt or correction, observation acknowledgement,
closure and ready budget effects share an owned ledger transaction. Missing usage
retains holds. Replayed acknowledgements also check retained financial effects,
not merely an audit hash. No migration definitions were changed.

A scoped media checkpoint passed **28 SQLite/PostgreSQL unit cases and 33 HTTP
media cases**, plus backend/frontend builds, contracts, bundle budgets, docs and
lint. It covers paid completed/failed/cancelled
jobs, missing usage, delayed observations, correction replay, original budget
periods, cross-workspace rejection and rollback when acknowledgement writes fail.
It also verifies that a late earlier-attempt receipt permits settlement without
another debit or a stale reservation-state conflict. Broader current-source
regression still needs its own verification. The earlier expanded run retained
816 passing existing tests;
its 22 new-fixture failures are not counted as a pass. The fixture lacked its
synthetic node; the next run reached and passed actual media processing. A later
unused-import lint failure was fixed without relaxing the lint gate.

**At this earlier checkpoint, non-token quota policy was unresolved.** Cost-only media fixtures could settle;
the HTTP fixture with its original daily-token hold remains reserved when no token
counters exist, even when the reserved token quantity was zero. Neither test
fabricates token zeros or treats seconds as tokens. This is not proof that default
media deployment is complete. Sibling-task closure, custody/disposition and fault
boundaries, all media operations, Realtime, seven-language UI acceptance, performance
and the final fixed-source image/rollback package remain original required work.

Deployment preference is unchanged: local Mac first on the existing Rancher
Desktop Moby engine, preserving the host's 2099 address and access scope. It is
not permission to start, restart or switch production. The final image must be
rebuilt and verified after the implementation is complete.

## Actual embedding-batch integration checkpoint

Actual-upstream policy now includes embeddings and their physical batch lifecycle.
The coordinator records successful dispatch IDs, retains complete physical receipt
custody and grouped finality before delivery, and atomically applies member fences,
ready budget effects and the grouped acknowledgement. Unknown fees remain reserved;
paid retries, cancelled members and missing result slices retain their real shares.
Original-group custody is checked rather than submitted as independent receipt
evidence. Closed actual groups can receive complete physical corrections under
their original budget scopes and periods. See [actual batches](pricing-actual-batch-runtime.md).

The latest scoped pass completed 658 unit tests in14suites and144E2Etests in9suites,
including SQLite/PostgreSQL grouped rollback, second-member failure, replay,
corrections and real HTTP cancellation/retries. Backend/frontend builds, lint,
docs, browser transport contracts and unchanged bundle budgets passed. The first
two expanded HTTP runs remain failed evidence: the first assumed missing cache
counters were observed; the second exposed a real administrator-quality promotion
bug and an exhausted-retry receipt-custody error. Tests now preserve missing-counter
uncertainty, administrator corrections normalize present quantities as estimated,
and single finality references physical attempts without re-submitting their
group-owned receipts. The previous safety checks were not bypassed.

This is not full-source or final-image acceptance. New group-inventory metadata is
localized in seven languages, but broader browser and performance checks remain.
Media/Realtime actual-policy work, non-token quota semantics, remaining original
requirements and the final rollback/artifact package are still required.

## Verified operator checkpoint and subsequent selector work

The stable-storage operator checkpoint completed 3,392 unit tests in176suites
and452E2Etests in43suites without failures or skips. Backend/frontend builds,
lint, SDKs, deployment-file static validation, docs, version/registry checks and
three compiled actual-main Realtime shutdown scenarios passed. A full1,227-file
scratch public scan passed without changing the real Git index. Its source and
production guards matched; the task-owned PostgreSQL and test listeners stopped.
This is a verified checkpoint, not final Goal acceptance.

Subsequent work adds a real Dashboard budget-basis selector, whole-policy
inheritance-aware before/after effects, and basis-aware admission simulation.
The old omitted field remains omitted on unrelated edits. A lower policy's
actual basis is not falsely inherited through an explicit higher policy that
omits the field. Seven locales cover the controls, scope caveats, opt-in boundary
and new-admissions-only warning. These edits postdate that full checkpoint and
require their own verification; do not label the old full result as testing them.

The selector's scoped verification subsequently passed 510 unit tests across12
suites and122E2Etests across8suites, plus backend/frontend checks and unchanged
bundle budgets. Real-browser records bind the preview and publication bodies,
verify retention of an actual basis during an unrelated limit edit, distinguish
workspace whole-policy overrides from field-level inheritance, and reject a stale
catalog revision without overwriting the concurrent update. Three basis-aware
simulations left every captured pricing/budget table unchanged and made no supplier
calls. Seven-language shared-selector and simulator-result checks cover desktop
light and narrow dark layouts. The full dialog-specific locale matrix and the new
control's viewer interaction still require their final acceptance pass; the server
permission regression is not substituted for those UI scenarios. The complete
original Goal, including batch/media integration and performance, remains open.

## Actual operator recovery and verification-storage checkpoint

- Added the server-derived `reconcile_actual` workflow, including pending dispatch
  fences, immutable operator authority, distinct terminal versus pending
  acknowledgements, retained-outcome custody, late original receipts and no
  client-selected logical winner. Actual initial settlement now replaces the
  original held rule/period amounts rather than charging newly selected periods.
- The first focused run exposed that original-period defect on both databases;
  the failing assertions were retained and the real writer corrected. The next
  run passed 474 unit and 103 HTTP tests, backend build/lint/docs, then correctly
  rejected an ORM-dependent browser type import. Transport types were extracted;
  the browser boundary check was not weakened.
- The subsequent full run failed with 3,144 passed / 248 failed out of 3,392 unit tests when
  old task-owned PostgreSQL files disappeared during system temporary-directory
  cleaning. System logs place `dirhelper` in the task's temporary tree at that
  time; they do not identify every individual unlink. 247 failures directly report
  unavailable PostgreSQL files/connections; the remaining failure is a migration
  CLI cleanup exit assertion. This entire run remains failed. E2E, build and
  actual-main checks chained after it did not execute.
- Surviving evidence was moved to a stable task-owned directory outside system
  temporary and dot-prefixed runtime paths. The damaged test cluster is preserved;
  a fresh isolated PostgreSQL 16.14 cluster was initialized and stopped. The missing
  protection baseline was recovered from the immediately preceding verified
  protection record and compared with the unchanged production identity. Cleanup
  now attempts the production/source guards even if fixture shutdown fails.
- Real-browser checks exercised pending versus known recovery, exact retry
  metadata, lost-response acknowledgement after reload, preserved historical
  acknowledgement after late settlement, and a fresh read of the committed state.
  Display checks cover seven locales, desktop/light and narrow/dark. They exposed
  and corrected misleading preview/current-state wording in historical results.
  The CLI returned early at a before-unload dialog during one scenario while the
  awaited script continued; its final capture and independent recorded-result/
  database checks are retained with that qualification, not disguised as a
  normal returned result.
- These are scoped implementation and browser proofs, not full Goal acceptance.
  A new full fixed-source run is still required. The requirement audit has 33 of 101
  entries examined, many still partial; remaining batch/media/Realtime, selector,
  calculation-pairing, performance, final image and rollback gates remain open.

Authority: [Goal Spec](pricing-engine-goal-spec.md).
Decisions: [implementation ADRs](pricing-engine-decisions.md).

## Production safety

- Work continues in the isolated worktree based on deployed source `b61d8f48`,
  not the older main checkout or the active release.
- Dependencies and build outputs are worktree-owned. The candidate lockfiles now
  include the reviewed dependency security updates; production dependencies are
  unchanged. Host verification uses Node22.23.2 / ABI127; the earlier isolated
  Rancher Linux/ARM64 image uses Node22.23.3 / ABI127 with its own native addon.
- Tests run with a clean environment, private HOME/TMPDIR, a 2 GiB Node heap
  limit, low process priority, serial Jest and mocked providers. Test listeners
  bind loopback ephemeral ports; no fault injection targets port 2099.
- The standalone PostgreSQL 16.14 test process uses its own data directory,
  loopback ephemeral port, test-only database and short Unix socket path.
  No existing PostgreSQL service is used. Its owned process is stopped after
  verification; its identity is retained only in the ignored local record.
- Read-only production verification checks the process entrypoint and its
  resolved `current` release, not the process cwd. Production's cwd intentionally
  remains the main config checkout, which is **not** its running build directory.
- The production PID, listener, active release and five protected configuration,
  startup and watchdog hashes remain unchanged at this checkpoint.
- No production restart, stop, switch, hot reload, DB/configuration mutation,
  watchdog change, commit, GitHub push, merge or release has been performed.

## Milestone status

This table summarizes the latest checkpoints below; earlier dated notes retain
their historical limitations. Implementation coverage is not a substitute for
the final requirement-by-requirement audit, and no milestone is marked complete
solely because a later test count increased.

| Milestone | Implemented | Still required |
| --- | --- | --- |
| M0 | Isolation, runtime identity, domain contracts, ADRs and synthetic fixtures. | Final per-requirement review remains mandatory. |
| M1 | Exact calculation, token/cache normalization, TTL decomposition, rounding, currency/FX, legacy adapter and metering-capability assessment. | Final dimension/source/boundary audit against the original requirements. |
| M2 | Context/service tiers, media predicates, calendars/DST, immutable catalogs, scoped bindings, CAS publication/rollback/audit, parent-price lineage, publication review and admission simulation. | Final rule/calendar/inheritance/governance requirement audit; do not substitute capability declarations for supplier evidence. |
| M3 | Frozen routing/admission, reservations, attempt receipts, exact budgets, immutable outcomes, batch allocation/corrections, recovery/disposition, coordinated writers, cost reports and unknown/legacy separation. | Final writer/capacity/older-writer/retention/recovery/reporting scope audit and unmet HTTP performance. |
| M4 | Image/audio/rerank metering; media task lifecycle, scoped controls, native video profiles, authenticated normalized supplier events, alternative-evidence disposition and job lookup. | Final supported-profile/control/quantity-evidence audit and retention/capacity acceptance; no claim of universal vendor coverage. |
| M5 | Seven-language pricing/inheritance/calendar/FX/editor flows; cost reports; recovery/correction/disposition forms; media tasks/sources; publication governance and admission simulator, with isolated browser evidence. | Match the original UI requirements to current source and actual browser evidence; retain explicit limitations. |
| M6 | Full host regression/SDK checks, SQLite/PostgreSQL evidence, Rancher Linux/ARM64 image and loopback/SSE/persistence/process/listener-restart verification, plus full-candidate public-boundary inspection. | HTTP latency/throughput, justified PostgreSQL comparator, full acceptance matrix, retention/capacity/dependency review, final fixed-identity package and rollback approval materials. |

## Implementation evidence

### Durable ledger and budget precision

- Explicit migration `pricing-engine-002` adds five tables: budget balances,
  reservations, effects, attempts and adjustments. The original `001` definitions
  and checksum are preserved; neither migration runs on startup.
- Both databases pass fresh migration, populated `001`→`002`, repeated inspection,
  constraint tests and refusal to remove nonempty data. A reversed workspace
  index is detected; PostgreSQL inspection preserves actual key ordinality.
- Request-row locking fences concurrent identical reservation/dispatch creation
  on PostgreSQL. Rule locks, including old inactive holds, use ascending rule IDs.
  Different identities/targets/receipts cannot reuse an idempotency identity.
- Receipt repair and final budget effects can commit in one transaction. Injected
  effect failure rolls back both, leaving the hold and dispatched receipt intact.
- Exact shadows retain increments too small for the old PostgreSQL `real` column.
  Limit/alert-state comparisons use those exact values. Manual same-day reset
  starts a new ledger epoch so old holds cannot consume new usage on release.
- Explicit `003` adds immutable terminal intents. Known terminal outcomes survive
  a process exit before budget application; receipt repair, budget effect and the
  applied marker commit atomically. Concurrent replayers cannot debit twice.
- A candidate-only worker renews local leases and replays pending intents with
  bounded batches/backoff. Hash conflicts are quarantined. Timer shutdown and
  absence of an automatic schema migration are covered by lifecycle tests.
- Expired **undispatched synchronous** holds can be reclaimed with a dispatch
  fence. Already-dispatched ambiguous orphans and async jobs are not freed by
  generic expiry; their full recovery and adapter-driven correction delivery remain unfinished.
- Exact-balance awareness is restored before legacy startup writes. Budget config
  synchronization now shares the consumption transaction/lock order, preserving
  counters under concurrent reload/usage. Unrelated legacy/admin writers and
  post-commit notification delivery still require review.

### Token request path and evidence

- Chat/Responses/Messages/Gemini and embeddings admission uses a request-frozen
  catalog plus pricing-only legacy fallback snapshot when migrated and bindings
  are present. Existing unactivated workspaces retain legacy behavior.
- Routing estimates and reservation quotes use that same snapshot. Reservation
  cache-partition variants are evaluated at single-attempt input quantity before
  multiplying the allowance by retry count; the general worst-case bound remains
  unfinished for time/service/media conditions.
- Each physical provider dispatch now has a receipt, including internal credential
  and compatibility retries. Failed attempts remain unknown
  rather than free; the request summary exposes known subtotal separately.
- Invalid/unsafe raw counters are diagnosed instead of replaced by canonical
  zero. Decimal strings and complete custom sums retain integer precision. Missing
  cache attribution is estimated, unknown TTL is not silently treated as 5m.
- The private WeakMap evidence does not add billing fields to `/v1` response JSON.
  Stream cumulative counters replace earlier reports; Messages start/cache/TTL
  counters survive output deltas. Late cumulative metadata does not create an
  extra client-visible stop frame. Missing terminal usage stays unknown.
- A successful provider response is not retried after a pricing receipt failure.
  The final budget transaction can repair a transiently missing receipt.
- Local-cache upstream cost is explicitly zero; its compatible logical token/cost
  budget remains separate. Historical GET APIs no longer reprice old logs.
- Scoped cost-breakdown and metadata-only replay APIs expose immutable evidence.
  Replay does not call providers, publish prices, or change budgets/history.

### Recovery checkpoint

The new failure tests terminate only a test child process after intent persistence,
then reconstruct services and race two replayers. Both SQLite WAL and the separate
PostgreSQL database retain the intent and apply only one budget effect. Additional
tests cover receipt/effect rollback, backoff, integrity-conflict quarantine,
undispatched reclamation versus first dispatch, async exclusions, scoped access,
lease renewal and worker shutdown. Real request E2E verifies that a failed budget
application is later recovered without another provider call.

### Correction and projection checkpoint

- Additive `004` application metadata links each immutable usage correction to an
  exact budget effect and audit entry. Original attempts/intents are unchanged;
  hash-CAS, revision uniqueness and application integrity checks prevent forks or
  duplicate debits. A real populated `003` outbox upgrade is verified on both DBs.
- Unknown-to-known corrections reconcile from the actual charged estimate; unknown
  revised costs remain pending. Released logical holds do not silently become
  actual-upstream budget charges. Refunds cannot subtract from a newer budget epoch.
- Late receipts and corrections update existing log projections in the same
  request-fenced transaction. Both direct and write-behind log persistence replace
  stale projected values from retained ledger evidence, not current prices.
- Read-only details keep initial and effective receipts separate; replay uses the
  effective normalized usage and includes the initial receipt for comparison.
- These are internal settlement primitives plus isolated HTTP/read-path evidence.
  Async job adapters, generalized late-evidence ingestion and report/frontend
  status displays still require integration; the full Goal is not complete.

### Synchronous media checkpoint

Images (including multipart edits/variations), audio JSON/PCM and rerank are now
integrated with the actual candidate request path. The calculator distinguishes
actual output count, explicit requested count, seconds, code points, documents and
search units. Auto selection uses frozen quantity quotes. Required unknown media
variants and unavailable/compressed audio duration do not become free or cheapest
rates. An unrelated chat publication leaves legacy media behavior unactivated.

The isolated media suite contains 14 HTTP tests, including actual-versus-requested
images ($0.12 versus $0.16), 61-second audio ($0.061 versus $0.12 with rounding),
PCM speech with a base fee, multipart metadata, Unicode character count, rerank
units, unknown variants and accepted-async pending behavior. A discovered legacy
float-expansion failure is fixed and tested on both databases. These are synthetic
prices, not claims about supplier rates.

At that synchronous checkpoint, video remained outside the new runtime. The
subsequent asynchronous checkpoint below adds the durable lifecycle and fixes
scoping/credential/terminal concerns. Supported formats and remaining boundaries
are in [media metering](pricing-media-metering.md).

### Asynchronous image/video checkpoint

- Additive `005` persists submission claims, task footprints and normalized
  observations. Task creation is atomic with its attempt; earlier schema checksums
  and populated request snapshots survive migration on SQLite and PostgreSQL.
- Request/namespace/key-scoped client idempotency prevents another budget hold or
  generation, including after current pricing is unavailable. Changed payloads
  conflict. Only hashes are stored; replay returns explicit metadata, never cached
  image bytes or private prompts.
- New task-enabled images/video dispatch at most one paid generation attempt.
  Lost responses do not retry another credential or route. Stale/unknown submissions
  remain uncertain and retain their holds instead of being declared free.
- Video and image status/cancel/content controls use scoped job lookup, the original
  logical credential and a node connection fingerprint. Poll leases/revisions fence
  overlapping stale responses; late provider IDs are retained even when metering
  is unchanged. Operation-name/done and immediate terminal job shapes are covered.
- Terminal evidence and prepared action/cost are persisted before financial
  application; original settlement is immutable and later usage appends an exact
  correction. Both a child exit after preparation and a failure after ledger commit
  but before the processed marker replay without another debit or provider generation.
- Cancel acknowledgement is not confirmed cancellation. Missing usage, explicit
  zero, partial failed output and content-delivery failure retain distinct cost
  semantics. Exact 6.4-second video costs `$0.66`; whole-second rounding costs
  `$0.72` under synthetic fixtures. New price publication does not reprice the job.
- Task controls have bounded body-inclusive deadlines, metadata size limits, no
  credential-bearing redirects and shutdown cancellation. Content is streamed.
  API-key views expose totals/status only; detailed receipts remain Dashboard-scoped.
- Legacy video metadata now includes workspace, scopes lookup before ID matching,
  uses shared SQLite write serialization and never persists raw provider error text.
  Legacy rows cannot guess among several credentials when no original credential
  identity was stored.

This is verified polling/settlement integration, not a completed universal callback
or operator reconciliation system. No public callback route is exposed. Arbitrary
out-of-order callback delivery requires authenticated event identities/versions;
unknown provider job IDs cannot be safely invented or automatically resubmitted.
The full M4/Goal acceptance remains open.

### Explicit admission and reservation checkpoint

- Catalog-versioned policies add compatibility, missing-price rejection and
  conservative quantity-limit envelopes. Old catalog hashes/default behavior are
  unchanged; strict policies can explicitly govern unpriced requests even when no
  binding exists. Publishing a book does not discard a workspace's policy.
- A shared nonnegative component calculation bounds possible context/time/service/
  media rule paths, including minimums, rounding and frozen FX. Quantity bounds have
  explicit provenance; heuristics and requested media values are not silently
  promoted to caps on actual provider output. Guarantees are labelled conditional
  on the declared supplier limits and supported tariff domain, not unconditional.
- Strict reservations include configured credential attempts after per-attempt rate
  evaluation; the provider client enforces the captured credential allowance if a
  pool grows before dispatch. Physical credential/compatibility dispatch receipts are now implemented;
  priced batch allocation and full adapter coverage remain open.
- Scoped GET/PUT and pure/proposed preview APIs have CAS, confirmation, RBAC, origin
  protection and atomic audit rollback. In-flight policy restoration is verified
  on both databases. Rejections preserve stable codes before any paid call or SSE
  header flush across chat, Responses, Messages and embeddings.
- Actual overrun usage settles without clamping. Dashboard reservation evidence
  separates the hold/assumptions from actual receipts and exposes known cost excess
  and provider-observed quantity-limit excess. No real limit/rate was activated.

See [admission policy](pricing-admission-policy.md) for API, source assumptions and
remaining coverage boundaries. This checkpoint does not complete M3 or the Goal.

### Dashboard editor and governance checkpoint

- The lazy `/pricing` page retains the existing visual system and all seven locales
  (343 pricing keys per locale).
  Draft creation/copy/import, six editing areas, exact string fields, explicit free,
  rule groups, calendars, media, quote comparison, immutable versions, export,
  publication/rollback preview, scheduling and audit are implemented. Source/parent
  governance and full request/report presentation are still incomplete.
- Scoped policy and FX dialogs use captured catalog revisions, read-only server
  validation, reasons, change summaries and explicit confirmation. Future requests
  see new catalog snapshots; in-flight and historical evidence is not rewritten.
- Legacy NodeForm changes no longer promote every resolved rate into an override
  or discard hidden fields. Browser saved an explicit zero input rate and renamed
  the synthetic node while preserving context/reasoning and hidden cache/media
  prices; all untouched catalog-only model prices remained unconfigured.
- Browser tests also validated 272000/272001 thresholds and exact formulas, draft
  revision/save versus published head, read-only published mode and confirmation.
  A later fixture exercised policy/FX publication: preview left head at 1 with zero
  provider calls; policy then FX advanced it to 3, still with zero provider calls.
- A single navigation blocker protects links, browser history, workspace changes
  and unload. Forward navigation was blocked; staying retained a 1.000000001 rate.
  An injected concurrent save returned 409 without losing edits; add/save controls
  stayed disabled until explicit comparison and reload. A second conflict arrived
  during refresh, preserving 1.000000003 until explicit reload to server revision 3.
- Real browser work caught and fixed a raw-table version query alias error, a
  test-only static-serving setup issue and a stale cached draft after navigation.
  The deliberate stale-save request produces an expected browser 409 resource
  error; it is not reported as a zero-error test. The final clean reload has no
  application console errors. The NodeForm retains a browser DOM advisory about
  its pre-existing password input layout.
- English dark desktop (1440×900), narrow view (390×844), and Chinese forms were
  visually inspected. No default Vite proxy or production frontend was used.
  Fixture backend/static copies, database, browser session and ports are task-owned.

Detailed use and remaining scope: [pricing Dashboard](pricing-dashboard.md).
This checkpoint does **not** complete M5, M6, or the Goal.

### Physical dispatch and retry-attribution checkpoint

- A scoped observer records each HTTP attempt before fetch, with invocation ID,
  credential/compatibility indices and original/route/wire/reported model evidence.
  A pre-aborted operation selects no credential or dispatch record; external abort
  stops further credential retries. Gemini's URL model is retained explicitly.
- Internal credential failures no longer disappear inside one successful wrapper.
  Nonzero reported failure usage contributes to known cost; missing counters stay
  unknown. Error metadata is allowlisted, and no prompts, output, raw errors, keys,
  headers or media bytes enter the ledger. Public model responses remain unchanged.
- The special Responses compatibility replay shares the reserved dispatch counter,
  closing a path that could reset a strict credential allowance. Captured prices
  remain stable across internal retries and concurrent test-catalog publication.
- Optional multi-receipt intents durably retain failed and successful attempts.
  Repairing their receipts and applying a budget effect is atomic. Child-exit and
  concurrent-recovery tests on both databases verify no lost known retry receipt
  or duplicate debit, including releases with observed nonzero supplier fees.
- A real, task-owned loopback HTTP server exercises timeout-race fallback. The
  client receives the winner before the primary finishes; the latter keeps lease
  renewal and later records its old-price cost, even after a test price update.
  Supplier costs include both attempts; compatible logical budget follows the
  winner only. The server/sockets are closed without touching any shared service. The owned
  PostgreSQL instance is stopped after the final regression run.
- CALC-18 now exercises exactly three real adapter attempts with one unknown and
  two observed fees. A private stream-terminal observer also preserves reported
  usage after a real client disconnects before any stop event. Known cost survives
  once; the provider stream is cancelled and the hold reaches a terminal state.
- The first frontend build caught a backend canonical/Buffer type leaking through
  the new attribution contract. Splitting pure metadata from observer types fixes
  the boundary without adding dependencies or Node globals to the browser.
- Full priced batching/allocation, terminal-intent persistence retries, ambiguous
  orphan reconciliation, post-commit notifications and final coverage remain open.

Details: [provider-attempt attribution](pricing-attempt-attribution.md). This
checkpoint does not complete M3 or redefine the full Goal.

### Batch allocation foundation checkpoint (historical; runtime integration follows)

- A physical invocation is priced once before exact allocation: full-batch context
  tier, service/time rules, FX, base fee and minimum/rounding are not reapplied to
  smaller members. Integer largest-remainder shares conserve physical totals and
  every displayed component with explicit balancing adjustments and source hashes.
- Usage allocations keep missing/zero/free distinct and preserve nested input/cache
  partitions. Reasoning stays overlapping output. Nonzero per-member usage is
  marked estimated; a synthetic weight label is not provider observation evidence.
- Legacy embedding batching now avoids rounding more usage than the provider total
  and does not give cancelled members' shares to survivors. A shared abort signal
  prevents one client from aborting other members; a real HTTP disconnect regression
  verifies the remaining request receives only its own share. Exact zero also survives
  the actual embedding pipeline. Keys include tenant/workspace/namespace/team/session
  and config identity; dispatch context and cancellation queue identity are captured.
- Atomic multi-request dispatch/outbox methods reject mixed tenant/target/price/FX/
  policy snapshots, bad ownership and duplicate members without partial writes.
  All outcomes become durable before individual budget application. Both database
  suites exercise rollback, reversed-order concurrency and child-exit recovery.
- The read-only `/pricing/batch/quote` API invokes the real quote calculator and
  scoped lookup. HTTP tests verify long-context allocation, synthetic FX, forbidden
  origins/foreign drafts, and zero writes/provider calls. Output expansion is bounded.
- **Still required:** restore the priced runtime through a coordinator for captured
  per-member context, aggregate upper-bound admission, physical receipts, cancellation
  holds, budget policy, corrections and report/replay. The foundation checkpoint
  still bypassed priced batching; the subsequent runtime section below records
  the implemented coordinator and its remaining acceptance gaps.

Details and next integration contract: [batch allocation](pricing-batch-allocation.md).
The original M0–M6 objective and all delivery gates remain unchanged.

### Priced embedding runtime checkpoint

- Actual activated embedding requests now use the separate priced coordinator.
  Members retain independent snapshots, holds and leases. Queue identities prevent
  mixing principals or different tariff/FX/policy admissions. The existing batching
  configuration controls activation; no production configuration was changed.
- Shared credential attempts atomically prepare all member intents before fetch,
  calculate the physical aggregate once, and persist conserved shares/terminal
  decisions together. Known retry fees accumulate; unknown prior usage stays unknown.
- Strict aggregate checks use the same frozen policy/envelope and compare every
  allocated maximum to its reserved per-attempt share. Aggregates exceeding declared
  supplier/context caps remain independent, not silently under-reserved.
- Real HTTP tests cover one/multiple client cancellation, missing usage/result
  slices, different API-key principals, price/FX changes, outer/credential retries,
  preparation failure and final-persistence retry without another model call.
- Durable physical receipt hashes/member allocation are verified before writes.
  Both DBs test partial-intent rollback, tamper/incomplete-group rejection,
  reversed-order writers and child exit before budget application. Existing outbox
  recovery applies committed decisions once; no schema migration was added.
- Read-only replay prices physical usage before allocating. Shared frontend
  breakdowns label shares, show the physical formula and avoid summing nested costs.
  All strings are translated; actual log/report browser integration is still pending.
- **At this historical checkpoint still open:** group corrections (subsequently
  implemented below), orphan reconciliation before durable outcome commit, final race/shutdown/retention
  and metadata-amplification/performance review, and full log/report/operator UI.

Runtime contract: [priced embedding batching](pricing-batch-runtime.md). This is
not completion of M3/M5/M6 or the full Goal.

### Conserved batch correction checkpoint

- Complete physical batch corrections now restore frozen price/context/FX, reprice
  updated aggregate usage and allocate all shares together. Initial receipts and
  intents remain immutable. Each member records a continuous correction chain with
  the same group ID, revision and physical predecessor hash.
- Member cost revisions, exact applicable budget deltas, log projections and group
  audit commit atomically. Competing corrections are CAS-fenced; identical delivery
  is idempotent even after later revisions. Member/audit failure rolls back every
  change. Child-exit replay and reversed-anchor concurrent tests run on both DBs.
- New batch intents explicitly name the logical budget winner. Unambiguous older
  batch intents remain compatible without hash rewriting. Corrections to failed
  retries/released members retain supplier evidence without charging the winner or
  resurrecting released usage. Unknown revisions resume from the last charged
  amount, and old-period refunds cannot reduce a newer epoch's balance.
- Admin-only preview/apply accepts replacement normalized usage, expected physical
  hash, reason, confirmation and correction ID. The server derives membership and
  historical tariffs; client prices/FX/actors/scopes are rejected. Preview writes
  nothing and no action calls a supplier. Administrator attestation is not invoice
  confirmation or an authenticated provider callback.
- Real isolated HTTP evidence covers immutable old-price/current-FX removal,
  whole-batch threshold correction, exact cost/budget/log changes, failed retry
  accounting, viewer/origin/scope rejection and no correction before original
  settlement. Correction UI/browser presentation and broader reconciliation remain
  part of the unfinished Goal.

Contract and limitations: [conserved batch corrections](pricing-batch-corrections.md).

### Request-cost Dashboard checkpoint

The log detail links to a lazy request-cost route with immutable attempts,
normalized usage, formulas, original/report currency, rules/versions/FX,
service/media/calendar evidence, rounding, reservations, budget effects and
append-only correction history. SQL reads only allowlisted log metadata.
Legacy estimates and missing reference amounts are not reconstructed from current
rates. Cache logical usage and budget remain separate from zero upstream cost;
cache replay is explicitly a counterfactual reference.

Scoped paginated draft/version selection drives metadata-only historical replay.
Selection changes mark old output stale. Both existing log queries and new cost
queries capture workspace/header/cache identity and abort signals; an old-scope
response is rejected. Exact large/fractional decimals retain their precision while
displaying locale separators. All seven pricing locales have **479 keys**.

Batch correction starts from physical quantities and a frozen CAS hash. Blank
and zero stay distinct; manual evidence cannot forge provider provenance. Editing
invalidates preview and consent. Unknown write outcomes freeze fields and retain
the original proposal ID/body for retry. Conflicts keep local fields and require
a read before discarding. The API still derives price/FX/membership/actor scope.

Real isolated browser flows verified log navigation, formula/usage/history views,
no-write replay/preview, stale results, confirmation invalidation, viewer controls,
cache/legacy labels and dark/narrow English/Chinese layouts. A deliberately lost
successful correction response followed by retry produced exactly one group audit
and one revision per member: three shares changed from **$0.04 to $0.08**, all
original receipts remained **$0.04**, and no additional provider call occurred.
A concurrent correction made a stale **36-token** proposal fail without losing
its fields; explicit reread/discard showed the actual **48-token** record.

These use synthetic rates only. Backend tests additionally verify safe metadata,
legacy null/zero, foreign workspace/unsafe IDs, cache counterfactuals and server-side
manual provenance. The browser/fixture and independent test PostgreSQL are stopped
after validation. No report/coverage or whole-Goal acceptance gate is waived.

### Post-commit budget observer checkpoint

Ordinary budget writes formerly emitted threshold notifications and updated
telemetry before commit; the new exact ledger did not emit equivalent threshold
notifications. Both paths now collect workspace/rule/epoch observations and publish
only after the complete transaction succeeds. Intermediate hold release/reapply
or grouped member effects are reduced to the net exact balance change. Rollback
and failed nested savepoints discard observations; successful savepoints wait for
the outer commit. Admission rejection is separately reported after rollback.

Event deduplication includes workspace, rule and exact reset epoch. Exact amount
strings accompany legacy rounded details, and old-epoch adjustments do not warn
against today's budget. A throwing alert sink cannot fail a committed balance or
cause another upstream call. Ordinary telemetry waits for commit; the ledger's
SQLite metric read shares the participating connection queue.

The same SQLite/PostgreSQL fixtures verify these boundaries, including a truly
unmigrated legacy database. Ledger effect-insert failure/idempotent replay and a
real HTTP request with a throwing notifier are covered. No schema or production
connector changed. Notification delivery is still best effort, not a crash-durable
outbox; broader admin writers and orphan reconciliation remain open. Contract and
limits: [budget observers](pricing-budget-observers.md).

The first full E2E run also exposed a scheduling assumption in a legacy batch
test: three concurrent HTTP requests were not guaranteed to enter one 15ms queue
window. The test now aligns only the initial queue entries, preserving each
request's async context and the real queue/dispatch path. A separate real-HTTP
test verifies conserved usage when arrivals genuinely form two physical batches;
no production batching window changed. The cancellation case drains the cancelled
pipeline before teardown rather than relying on a fixed sleep.

That work exposed unnecessary legacy embedding fallback after client cancellation.
Cancellation now stops before another reservation/dispatch and releases the active
logical hold without penalizing provider health. The surviving member still gets
its shared result; the cancelled pipeline returns 499, only two initial enqueue
calls occur, and no provider failure is recorded. Existing priced cancellation and
late-usage tests continue to cover retained physical fee shares. Initial failure
logs remain in private staging rather than being discarded.

### Administrator budget-writer checkpoint

Generated-key/team mutations now use transaction-scoped repositories and the
participating SQLite connection queue. PostgreSQL owner/rule locks follow the
ledger's rule order. Configuration patches exclude current spending and epochs;
exact shadows survive even a deliberately stale configuration read. Concurrent
owner edits preserve distinct fields; scoped-name races use domain errors.

Last-used metadata writes are partial, conditional and non-regressing. They cannot
restore a rotated/disabled key or stale team permissions. Authentication cannot
read an uncommitted cooperating administrator permission change that later rolls
back. Default-workspace legacy-null budgets remain scoped without duplicate rules.

Dashboard key/team policy and before/after audit now commit together. Mandatory
audit failure rolls back creation/rotation, limit changes or deletion; reset audit
also shares the exact balance/epoch transaction. Actual actors come from request
context. Configuration-event summaries use audit sanitization, fixing a path where
caller-provided summary values could otherwise contain a secret. Standalone audit
append stays best effort but has a serialized workspace hash head.

Identical SQLite/PostgreSQL fixtures and isolated HTTP failure injection cover
these invariants. The PostgreSQL fixture initially exposed UUID-extension placement
in a disposable schema; support now lives only in the owned test database's public
schema, and failed initialization cleans up its connection/schema. No production
schema, connector, configuration or process was changed. Other writers and general
orphan recovery remain open. Contract: [administrator writers](pricing-admin-writers.md).

### Workspace-authority writer checkpoint

Workspace, membership and invitation services now share the participating SQLite
connection queue and explicit transaction-manager ownership. PostgreSQL protects
each workspace's cooperating writers with a configured-schema-aware advisory lock,
including empty member sets and independent DataSources. Organization bootstrap,
workspace authority and audit heads follow an explicit lock order.

Workspace creation/initial administrator/audit commit together. Rename, disable
and reactivate check target permission and capture before-state inside their
transaction. Member updates and invite revocation include the active workspace
in ID lookup; required audit failure rolls back their mutations and configuration
history. Concurrent member demotion/upsert cannot remove the last active admin.

Local and OIDC invitation acceptance now execute membership creation in the same
transaction. Failed membership effects preserve pending tokens; competing
accept/revoke operations re-read after locking. Top-level expired acceptance
commits its expiry before raising the public error. List-time expiration is lazy
and only touches the listed workspace. Existing email policy remains unchanged.

The PostgreSQL fixture exposed the old default-admin helper's insertion of a
non-UUID ID into a native UUID column. New PostgreSQL rows now use generated UUIDs;
existing legacy IDs and SQLite's historical default ID are preserved and tested.
The first HTTP fixture omitted its synthetic signing secret; it was corrected
without changing any live authentication configuration. Original failure logs
are retained. No frontend, production schema or deployment changes are involved.
Earlier permission fixtures used upsert to demote their only administrator; they
now retain a separate synthetic administrator before exercising viewer/operator
restrictions. The actual denial assertions and production invariant are retained.
Contract: [workspace writers](pricing-workspace-writers.md).

### Pre-durable outcome retry and suspected-orphan checkpoint

The generic token/synchronous-media and local-cache runtime now captures exact
metadata-only receipt/terminal-decision retry bodies, rather than forgetting a
failed first persistence attempt after the request returns. Retries are bounded,
back off, retain applicable local leases and never invoke a provider. A durable
intent takes over budget recovery; its replay also repairs missing receipts.
Capacity rejection occurs before another priced dispatch. Overflow and permanent
conflicts remain explicit, not fabricated zero-cost outcomes.

Explicit `006` adds scoped recovery observations without changing any earlier
migration checksum. Expired dispatched holds with missing outcomes/decisions get
review cases, never automatic charges or releases. Active leases, jobs, uncertain
media footprints and existing intents are excluded. Fair bounded scans rotate
unchanged cases; changed evidence gets a new revision. Actual late intent
application and case resolution share the budget/log transaction.

An operator/admin read-only case API and per-reservation cost-detail metadata
expose that state. SQLite/PostgreSQL tests include an actual isolated child exit
after dispatch without intent. HTTP tests cover both receipt and intent write
failure, pinned old-price replay after publication, duplicate repair, no-dispatch
backpressure and workspace/role isolation. The buffer is not a durable disk spool;
full pre-durable process-loss recovery, operator resolution, quarantine lifecycle
and the corresponding UI remain open. Contract: [outcome recovery](pricing-outcome-recovery.md).

### Audited internal-budget recovery checkpoint

Recovery now has operator-readable fresh group inspection and administrator-only
preview/resolve APIs. These are **budget-only** operations: an unknown provider
outcome remains unknown after an explicitly chosen hold release. Known commits
use a recorded winner; existing intents are applied unchanged. Cache upstream
zero remains separate from its stored original logical-budget price.

The basis follows physical membership transitively, includes terminal siblings
and effective adjustment evidence, and rechecks the graph after locking requests.
Active leases and async ownership block overrides. All unresolved members require
a decision. Budget/intent/log changes, required audit and immutable decision links
are atomic; repeated proposals and ambiguous post-commit replies cannot add a
second debit. Polling an unchanged case does not invalidate its basis hash.

Explicit `007` adds decision links and one immutable allocation manifest per new
physical dispatch. The six earlier checksums remain unchanged. Bounded SQL reads
limit group/history retrieval. An audited operator decision can retire a stale
local budget retry, while late genuine shared cost is persisted without replaying
its superseded budget instruction. This does not discard missing usage receipts.

Tests cover single/cache/group semantics, transitive closure, stale evidence and
leases, role/scope, manifest integrity, member/audit rollback, exact replay and an
isolated post-commit child exit. Supplier-evidence attestation,
receipt quarantine and full pre-durable-loss strategy remain unfinished; the
subsequent checkpoint below adds the budget-only operator UI. Contract:
[audited budget recovery](pricing-budget-recovery.md).

### Budget-only recovery Dashboard checkpoint

The seven-language recovery inventory and connected-group editor now expose the
existing audited API. Operators inspect; administrators make explicit per-member
choices, select full-ID known winners, preview exact amounts on the server and
separately consent. Active leases block override, existing intents remain
immutable, and client requests never declare supplier money. Budget-handled cases
with unknown fees remain in a separate unresolved-cost inventory. Request-level
amounts are not summed across repeated cases.

New read-only APIs provide keyset-paged inventory and audited acknowledgement.
The unresolved-cost scan inspects at most 200 candidates, so an empty filtered
batch may still carry a continuation. Column allowlists exclude stored private
evidence. Invalid evidence is explicit, not zero. No migration is added.

Edits invalidate preview/consent. Conflicts retain valid drafts for explicit
reread. Ambiguous writes freeze the original proposal, with a minimal scoped
session record saved before POST. Reload restores its exact ID/body without
consent; verified completion clears it. This is a tab-local retry aid, not a
durable supplier-outcome spool. Navigation/history guards and focused feedback
protect the workflow without replacing server CAS/audit/authorization.

Synthetic browser evidence proves a shared group's lost-successful-reply retry
adds exactly one audit and two member links, with no second durable effect.
Internal debit is **$0.0003**, separate from **$0.0012** physical provider cost.
Recorded-intent acknowledgement and Chinese/English previews leave durable
tables unchanged. Model-call count remains zero. Tests also exercised genuine
concurrent evidence conflict/reread, active leases, immutable intents, operator
read-only/viewer denial, preview invalidation and pending-record removal.

The initial browser build exposed a Node-only implementation imported through a
browser type barrel; the wire types now live in a separate type module. Browser
QA also caught the pending editor capturing an empty pre-fetch basis and shared
header controls clipping: initial-basis gating, full winner IDs and responsive
header controls fix those observations. Initial failure evidence is retained.
All seven locales rendered at 375, 640 and 1200 pixels with no whole-page
horizontal overflow or offscreen header controls; narrow/dark screenshots were
inspected. This does not complete supplier recovery, all-traffic reports or M6.

### Missing-first-usage attestation checkpoint

The recovery backend now accepts explicit administrator quantities for a recorded
provider dispatch whose first receipt is missing. It restores the request's
original price/calendar/FX snapshot and recorded target. There is no caller money,
current-rate substitution, automatic budget winner or extra provider request.
The resulting usage is explicitly estimated `request_metadata`, with a
seven-language attestation diagnostic, not a confirmed supplier invoice.

Shared physical attempts are priced once and allocated under their immutable
pre-dispatch manifest. A missing legacy manifest, partly recorded group, live
lease, non-synchronous media owner or pending immutable intent blocks the action.
Terminal receipts cannot be overwritten. Optional condition evidence cannot
change dispatch time/target/operation; missing quantities remain missing, and
normalized cache partitions are not guessed from omitted fields.

Receipt writes, required `cost.usage_recovered` audit and log projection are
atomic. Preview writes nothing, a later member/audit failure rolls back the
whole operation, and the serialized review result is bounded to 4 MiB. Exact-ID
retries and a read-only acknowledgement verify original receipt hashes after an
ambiguous reply, process exit or concurrent completion. Budget effects remain
unchanged until a separate approved budget resolution. No migration is added.

Tests cover original and legacy prices, very large exact quantities, missing/zero,
scope/provenance rejection, active/async exclusion, partial/corrupt groups,
conservation, rollback, independently connected PostgreSQL retries and a child
exit immediately after commit. Actual isolated HTTP tests fail the original
receipt and intent writes after one mocked provider response, then verify the
new API, real request-log projection and no additional provider calls.
The first scaffold build required a new diagnostic union member; test fixtures
then exposed omitted normalized partitions and a Jest-only mock in a child.
Those initial failures are retained, not represented as passes; no missing-use
validation was relaxed to make the fixtures succeed.

The subsequent checkpoint adds the missing-usage Dashboard form. This is not
complete supplier reconciliation: trusted supplier ingestion, terminal receipt correction and
quarantine workflows, resumed-owner lifecycle and pre-durable-loss strategy
remain required. Contract: [missing usage](pricing-usage-recovery.md).

### Missing-usage Dashboard checkpoint

The existing missing-first-receipt API now has a dedicated seven-language lazy
form. Explicit attempt selection, complete physical membership, blank/missing vs
zero, decimal durations, exact large quantities, disjoint cache partitions,
optional reviewed conditions and evidence digest stay separate from budget
decisions. Changing attempts requires confirmation and clears the old evidence.

Server preview must be reviewed before separate submission consent. Response
identity, complete membership, no-budget/no-supplier-confirmation flags and
canonical cost hashes are validated; writes/acknowledgements must match the
original preview hashes. The client keeps a bounded allowlisted proposal and
compact preview in workspace/actor/anchor-scoped session storage before POST.
Reload restores the exact ID/body without consent. Storage failure blocks new
submission; a verified acknowledgement clears it. This is not a durable outbox.

Real-browser evidence proves no-write preview, successful shared commit with lost
response followed by reload/same-ID retry, and read-only partial-receipt
acknowledgement. One shared audit records exactly two conserved receipts totalling
**$0.0012**; all original budget/reservation/intent tables remain unchanged. The
fixture makes zero model calls. Genuine evidence conflict retains the draft for
reread, active leases block preview, operators cannot submit and viewers cannot
enter. English quantity/decimal-dimension editing invalidates preview and consent.
All seven locales render at 375/640/1200 pixels without whole-page overflow;
narrow/dark screenshots were inspected.

Initial frontend compilation exposed the inferred UUID-template type for a
validation-only ID; the parameter now explicitly accepts a string. Browser review
also removed the misleading incomplete-subtotal label on complete previews and
distinguished receipt hashes from price-content hashes. Offset time comparisons
on the backend now use strict absolute instants, with independent SQLite and
PostgreSQL regression cases. No migration checksum changed. Trusted supplier
ingestion, terminal corrections/quarantine, complete process-loss/owner lifecycle
and all remaining Goal/M6 gates are still required.

### Terminal single-attempt correction checkpoint

The administrator backend now exposes original/effective receipt inspection,
read-only correction preview, audited apply and acknowledgement for single
provider attempts. It reuses the existing immutable correction chain and exact
budget adjustment code instead of a second calculator or an in-place overwrite.
Quantities are explicitly estimated administrator evidence; original price/FX,
legacy identity and physical dispatch attribution are preserved.

Previews perform no receipt/budget/audit/log writes, using the same epoch/delta
checks as apply. Original logical winners adjust from their last charged amount;
released holds and losing attempts receive cost evidence only. Unknown revisions
preserve prior debits and stay pending. Expired synchronous reserved holds with
no intent can receive cost-only evidence, then a separate audited budget decision
commits the effective corrected amount exactly once. Initial receipt copies in
the intent and all earlier revisions remain immutable.

Request/reservation/attempt/intent locking and fresh evidence CAS fence competing
updates. Active owners, pending intents, async ownership, non-provider attempts
and batch members cannot be forced through this path. Corrections and any budget
delta share the required audit and log-projection transaction. Stable retries and
read-only acknowledgement verify the original audit/revision after lost replies,
newer revisions and a real child exit after commit. No migration is introduced.

Unit contracts cover exact before/after/deltas, no-write preview, unknown-to-known,
reserved/released/loser cases, old-epoch refunds, underflow, scope/identity/tamper
checks, mandatory audit rollback and independent PostgreSQL connections. Actual
HTTP cases begin with one mocked provider response and verify real log/budget
corrections, retries, permissions and no second provider call. Original scaffold
syntax and lease-expiry fixture failures are retained; the first full lint run
also rejected an unused test import, which was removed rather than relaxing lint.
Explicit legacy and removed-current-FX regression cases were added before the
final full verification.

The subsequent UI checkpoint below supplies the single-attempt form and browser
acceptance. Retained/quarantined supplier receipt processing, trusted ingestion,
full process-loss/resumed-owner lifecycle and all remaining Goal/M6 gates remain
required.
Contract: [single-attempt corrections](pricing-attempt-corrections.md).

### Single-attempt correction UI checkpoint

The new lazy route opens from request cost details and recorded recovery members.
It initializes exact replacement quantities from the effective receipt and reuses
shared missing-usage fields. Operators inspect, viewers are denied and only admins
may preview/apply. Original/effective costs, historical price/FX, formulas, receipt
hashes and signed logical-budget changes with original epochs stay distinct.
Preview states are labelled proposed, never prematurely applied. Cost-only
unresolved/released cases do not imply a budget decision or new charge.

Proposal-bound previews, separate consent, dirty/busy navigation, focused feedback,
conflict-preserved draft/reread and scoped minimal session storage follow the
existing recovery pattern. Reply validation additionally compares signed budget
arithmetic and original allocations with the reviewed preview and persisted
adjustment/application identity. Reloaded pending proposals reset consent; a
stored proposal can recover even when a fresh basis read fails. Storage errors
block new writes. Original receipts, source prices and supplier-confirmation
status are not changed by browser state.

The real browser exercised current-period cost increase after a lost successful
reply, reload and exact retry (one adjustment only); old-period refund plus
read-only acknowledgement (current budget rows unchanged); genuine concurrent
409 with retained draft and explicit reread; active-lease/pending-intent blocking;
operator read-only/viewer denial; unresolved/released no-write cost-only previews;
and English decimal seconds, reviewed conditions and consent invalidation. No
model calls occurred. Snapshot comparison verifies preview/acknowledgement do not
write, exact retry has no second effect, and retry storage clears on success.

All seven locales pass 375/640/1200 width checks, including page/main overflow,
title/header clipping and narrow dark mode. Screenshots were inspected. Browser
fixture issues were corrected without weakening application checks: a zero delta
is an exact decimal string, the English budget heading includes a hyphen, and
narrow layouts hide theme controls (choose the theme before narrowing). Original
fixture logs are retained. No backend implementation or migration changes in this
UI checkpoint; all `001`–`007` checksums remain frozen. Broader supplier/lifecycle,
reporting, governance, remaining writers and all M6 acceptance gates stay open.

### Retained runtime evidence checkpoint (008)

The earlier subject-keyed memory buffer lost an incoming different receipt and
could let a still-running first writer delete its conflict marker. Both cases
were reproduced before this change. The buffer now separates exact body hashes,
archives conflicting overflow without replacement writes, and removes reviews
only after a durable scoped acknowledgement. An archive failure keeps the body.

Explicit additive migration `pricing-engine-008` stores immutable allowlisted
runtime outcomes, pending/delivered/review state and bounded retry metadata.
Retention and mandatory audit commit before original receipt/intent delivery.
Fresh recovery uses the original computation, not current price/FX or a second
model call. Different variants, standalone batch shares and async-owned evidence
are retained for review rather than choosing an automatic winner. Original
attempts, budget intents, manual estimates and linked revisions remain intact.
Retiring an audited superseded budget proposal first preserves its carried
receipts. This is not a supplier-authenticated ingest endpoint.

Integrity and transition audits, request-first reads, immutable captured inputs,
workspace ownership, scoped metadata-only keyset inventory and verified detail
GETs are implemented. Invalid pending bodies leave automatic replay without
being erased or presented as trusted. A workspace with 1,000 unresolved durable
rows blocks a new priced reservation even after memory state is lost. This is a
backpressure bound, not a disk-retention policy or final performance acceptance.

Tests cover both database backends, separate PostgreSQL connections, no-write
reads, mandatory audit rollback, exact replay, lost acknowledgement, conflicting
arrivals, manual-estimate coexistence, malformed/private/non-finite data, invalid
state audits, batch/async boundaries and a real child exit after retention.
Actual HTTP tests preserve a valid provider response through storage failure,
replay without the original memory buffer, and check privacy/RBAC with no second
model call. Final full regression/build/lint/frontend/docs checks for this checkpoint pass
with no skipped tests; that is not whole-Goal acceptance.

The initial compiler and fixture failures are retained in private verification
logs. Fixes include typed row inference, JSON wire-equivalence instead of comparing
explicit `undefined`, database-neutral test parameters and an explicit physical
attempt ID. The backlog fixture now supplies raw-insert column names and asserts
its actual row state/count: the pinned raw bulk builder otherwise used physical
column order. The first full HTTP run's two old memory-count expectations were
replaced with stronger persisted-body/state and unchanged-budget assertions after
archival. No threshold, validation or permission was weakened to make tests pass.

The full pre-durable process-loss boundary remains: if no durable write succeeds,
a process loss can still lose the in-memory final outcome. Trusted supplier
adapters, conflict-to-linked-correction disposition and seven-language UI,
complete group/task coverage, older-writer/resumed-owner fencing, retention,
remaining writers/reports/governance and full M6 are still required. See
[retained runtime outcomes](pricing-runtime-outcomes.md).

### Reviewed retained-evidence disposition checkpoint (009)

The administrator API now selects already-retained evidence instead of accepting
new client money or quantities. It can accept all supported independent receipts
in an outcome or reject evidence with custody preserved. Missing initial receipts,
linked corrections and identical-record acknowledgements are distinct. Accepting
receipts from a stored settlement does not adopt its budget amount or choose a
logical winner. Rejection never fabricates a zero fee, refund or hold release.

Original request price/FX/legacy version and dispatch fields reproduce the exact
retained computation before acceptance. Current price changes or removal of the
current FX schedule cannot reprice it. Unknown revisions remain pending rather
than refunding a guessed zero; later known evidence resumes from the last logical
charge. Original receipt/error history, intents and retained bodies stay intact.

The fresh basis includes related variants, current attempts/corrections, original
snapshot, reservation/lease, terminal intent and task ownership. Preview performs
no writes; selected receipt changes, applicable exact-budget effects, mandatory
audit, disposition and log projection commit atomically. A unique workspace/
operation identity and request-first locks fence competing decisions. Exact retry
and verified read-only acknowledgement survive lost replies, newer corrections
and a real child exit after commit. Current runtime writers carry an inbox identity
into their ledger transaction so a delayed rejected body cannot become a new
receipt/intent merely because it began waiting earlier.

Explicit migration 009 adds a separate immutable disposition; all eight earlier
steps retain their checksums. The original review state is not rewritten. Inventory
projects the decision separately, and audited completed decisions no longer count
as undisposed admission backlog. Bounded metadata/history inspection avoids
fetching unrelated attempt bodies; oversized financial reviews fail explicitly.

SQLite/PostgreSQL and mocked HTTP contracts cover no-write previews, initial/mixed
receipt handling, cost-only released/reserved cases, exact retries, conflicting
siblings/manual estimates, identity/permissions/origins, all-member validation,
required audit/disposition/log rollback, legacy/FX/context-tier reproduction,
original-period refund, backlog custody, independent reviewers, delayed delivery
and populated 008→009 migration. Final full cross-database regression, backend build/lint and existing frontend/
documentation checks pass with zero skipped tests. No new disposition UI or browser acceptance is
claimed in this backend checkpoint.

Still required: seven-language disposition input/review/consent/retry UI; trusted
external supplier adapters; full physical batch/task disposition and corrupted
source operations; broader old-binary/resumed-owner and pre-durable process-loss
lifecycle; retention/reports/governance/writer coordination and remaining M6.
Original fixture failures are retained: a settlement omitted explicit `receipt:
null`, and a pure service parser assertion incorrectly expected the HTTP filter's
status field on `PricingCompileError`. The initial full run stopped at lint for
an unused test import. Those fixtures/imports were corrected without relaxing
validation; final verification includes all four subsequently added per-database
migration/concurrency/fencing/size-bound cases and zero skipped tests.
Contract: [retained-evidence disposition](pricing-outcome-disposition.md).

### Seven-language retained-evidence disposition UI checkpoint

The new lazy `/pricing/outcomes` inventory/review route is linked from pricing
and budget recovery. It displays original custody state and separate decision,
compares current/original/retained receipts, and requires an explicit accept or
reject choice with a reason. No client quantity or money input exists. All
independent members are verified even when evidence inspection uses pages.
Preview shows exact receipt operations and original-epoch budget deltas, while
rejection explicitly makes no refund, release or zero-supplier-cost claim.

Pending writes use an immutable proposal and bounded, minimized workspace/actor/
outcome session record. Reload resets consent. Exact retry or read-only
acknowledgement checks action, full membership, errors, canonical receipt hashes,
signed budget arithmetic, epoch allocations and adjustment/application identity.
Existing decisions use their recorded result hash instead of a new proposal.
Draft-preserving conflict/reread, operator/viewer authority, owner/intent blocks,
focus/scroll feedback and dirty/busy navigation remain explicit.

The isolated browser verifies pricing-link navigation and 20+2 cursor pages,
lost successful current-period reply/reload/exact retry, rejection plus read-only
acknowledgement and already-disposed inspection, genuine sibling409 with retained
action/reason, twelve-member initial adoption across two inspection pages,
old-period refund without changing current budget counters, active/intent/nonreview
states, operator read-only/viewer denial and English action/reason consent resets.
Table snapshots prove preview and acknowledgement write nothing, retries have no
second budget effect, originals stay intact and no stored budget proposal is
implicitly applied. The fixture makes zero model calls.

Fault injection also verified pending recovery after the initial basis fails.
It exposed an actual UI bug: successful acknowledgement cleared retry storage,
then basis invalidation remounted the editor with stale pending props. A shared
pure `waitForRecoveryBasis` helper keeps a restored editor mounted on failed-basis
refetch while preserving the original initial-read wait. Disposition and the three
existing recovery wrappers use it. The corrected real disposition sequence reaches
and retains success after refresh, with no repeated write and cleared storage.
Initial failed screenshots/logs remain as diagnostics, not claimed acceptance.

All seven locales passed actual 1200/640/375 CSS-pixel detail widths plus375-pixel
inventory: no page/main overflow or clipped detail title/header controls. The
final harness reads `innerWidth` rather than assuming the owned browser's requested
viewport equals CSS pixels at its75% page zoom. Narrow dark screenshots were
inspected. Earlier zoom/rounding/duplicate-dialog/settings-tab fixture diagnostics
are retained; no live Gateway state was changed to perform this validation.

Shared cost/budget presentation and validation are reused by both correction
forms. A wire-only inbox type module avoids bringing Node-only implementations
into frontend type checking. All 707 pricing locale keys, form/session/hash tests
and bundle gates pass. The source-locked final regression passed 2570 unit tests
in 152 suites and 287 E2E tests in 30 suites, with zero skipped tests; backend
build/lint and frontend tests/build also passed. The disposition route is
7.31/12 KiB gzip; no existing bundle cap increased. Documentation validation
passed (31 required / 99 scanned). All 1063 verification-source files remained
unchanged through the run. The owned PostgreSQL, fixture backend and browsers
are stopped; live PID/release/listener and five protected hashes are unchanged.
No migration or dependency version changes.
This does not finish trusted supplier adapters, full group/task disposition,
old-writer/pre-durable-loss/retention/reporting/governance or remaining M6 gates.

### Auxiliary writer transaction-boundary checkpoint

The remaining enumerated batch-job/legacy-log, evaluation, prompt-template,
agent-profile, shadow-result, compatibility-result and Dashboard cleanup writers
now use the ledger's SQLite coordination boundary with transaction-scoped
repositories. Short database work does not hold that queue across a provider,
PipelineService, independent budget service or telemetry call. PostgreSQL uses
fresh-row and schema-qualified natural-key locks. Prompt version/pruning and
metadata-only evaluation imports are atomic; shadow retention stays a separate
best-effort operation. Linked-key reads explicitly reuse the profile transaction,
while detached profile lists release their read queue first.

Tests use an actual failing pricing settlement and verify that all 15 auxiliary
writer paths survive its rollback, preserve the original hold and exact balance,
and still permit a single subsequent settlement. Independent PostgreSQL
connections exercise prompt versions, compatibility upserts and concurrent profile
render/edit. Additional cases cover scope, failed imports/pruning, unlocked network
calls, read isolation and bounded cleanup. Profile generated-at uses a portable
Date mapping rather than a PostgreSQL-incompatible SQLite type.

The HTTP regression exposed a real legacy batch bug: the adapter's empty 204 JSON
object was interpreted as a new validating job. Explicit empty-cancel handling and
sparse status preservation now fix it without changing costs, supplier truth or
budgets. Original failing logs remain retained. Five new actual HTTP cases cover
priced traffic/config concurrency, real pipeline evaluations, pruning rollback,
empty cancellation and workspace-safe compatibility responses. Final source-locked
verification passed 2628 unit tests in 153 suites and 292 E2E tests in 31 suites,
with zero skipped tests. The focused runs passed 92 cross-database/regression
cases and 9 HTTP cases. Backend build/lint, frontend tests/build and documentation
checks (31 required / 100 scanned) pass. All 1066 verification-source files remained
unchanged throughout that run. The owned PostgreSQL process and listener stopped;
the live 2099 PID/release/listener and five protected hashes still match baseline.
No frontend, dependency or pricing-migration changes. Existing browser evidence
belongs to its original UI workflows; no new browser acceptance is claimed here.

This closes the enumerated writer boundaries, not arbitrary plugin/external SQL,
full retained physical-group/task lifecycle, supplier adapters, source governance,
coverage reports, pricing retention or M6. See
[auxiliary writer isolation](pricing-auxiliary-writers.md).

### Complete physical-group outcome custody checkpoint

Explicit migration010 adds a compact full-group inbox and all related reservation
links, without changing001–009. The actual priced embedding coordinator now
retains each complete outcome before delivery. Recovery uses the original complete
group writer and terminal outbox rather than issuing another provider request.
Cost-only and terminal-member-set phases remain distinct, so valid progression
is not confused with arbitrary competing physical receipts. Original costs,
manifests, all-member conservation, price/FX and budget decisions remain separate.

The compact format deduplicates physical evidence/cost references and validates
lossless expansion. Raw traversal and reference expansion stop at a conservative
bound before allocating an unbounded tree. Required custody/audit/member links
are atomic. All owner request locks precede delivery/state changes; corruption
quarantine uses the retained roster and preserves bytes. A positive durable
review acknowledgement retires live memory/lease ownership without applying a
budget proposal, releasing a hold or claiming a known-zero supplier fee.

Scoped operator GETs expose metadata inventory and the verified compact document.
They are not the independent disposition UI or an all-traffic report. Historical
carried receipts must already be durable unless in the current complete primary
group; missing legacy manifests or async ownership require review. Undispatched
cohorts can replay only genuine zero-quantity releases, not blind post-dispatch
refunds. Admission backlog includes both independent and complete-group custody.

Initial targeted cross-database validation passed200 cases, including the original
independent inbox/disposition and schema contracts, plus28 actual batch HTTP cases;
backend build/lint passed. Four further per-database hardening cases now cover
final acknowledgement/quarantine, expanded-reference bounds, carried historical
receipts and false/null terminal fields. All46 new group cases passed on SQLite
WAL/PostgreSQL in the subsequent fixed-source attempt. However, repeated host
maintenance sleep interrupted two complete targeted runs:204/208 passed with four
timeouts, then207/208 with one schema timeout. The latter used a temporary
idle-sleep assertion, which did not prevent that sleep. Neither interrupted
attempt is counted as passing evidence. The subsequent sustained-awake run passed
all208 focused cross-database cases and28 batch HTTP cases, then2678 unit tests in
154 suites and295 E2E tests in31 suites, with zero skips. Backend build/lint,
frontend tests/build and docs validation (31 required /101 scanned) also passed.
All1072 frozen verification-source hashes remained unchanged through the run.
No timeout, test, constraint or acceptance condition was relaxed. The owned test
processes, PostgreSQL and temporary assertion are stopped; production identity
and all protected hashes remain unchanged. The sleep-interrupted logs remain
retained as failed attempts, not discarded or relabelled.

This is post-retention durability, not a disk spool. Complete group disposition/UI,
media/supplier lifecycle, pre-durable/older-writer strategy, maximum-size capacity,
parent/source governance, reports and remaining M6 still require work. Original
fixture/type failures and raw TypeORM column-order/order-alias diagnostics are
retained, not hidden as successful evidence. Contract:
[complete-group runtime outcomes](pricing-group-outcomes.md).

### Complete-group disposition011 backend (full regression verified)

The dedicated group basis/preview/atomic decision/acknowledgement API now reuses
frozen price/FX reproduction, conserved batch revisions and exact epoch budget
applications. All represented receipts participate; compatible initial fills and
unchanged partial history are distinct from changed complete cohorts. Rejection
retains source custody. Current leases/intents/async ownership fence decisions;
original logical winners and stored budget proposals are never replaced.

New44 cases per SQLite WAL/PostgreSQL backend cover complete adoption/correction,
multi-cohort and partial history, no-write preview, unknown charges, old epochs,
concurrency, required-write rollback, exact retry/ack after later corrections and
actual child exit. Two added migration cases per database preserve populated010
and frozen001–010 checksums. Nine real HTTP cases cover actual mocked embedding
dispatch, permission/origin/scope, lost replies, projection rollback and original
CNY/FX after current catalog changes.

The focused source-locked run passes **436 unit/database cases and44 HTTP cases**
with no skips; full lint passes. It exposed and fixed missing all-member authority
checks, cumulative shared-budget preview underflow and PostgreSQL Date epoch
hashing. Actual HTTP also exposed operation-qualified embedding bindings missing
from old media context metadata; the validated dedicated lifecycle now supplies
that operation. Original failing evidence and the synthetic catalog fixture error
remain retained. No timeout, skip, constraint or dependency was relaxed.

The fixed-source011 full run now passes **2770 unit tests /155 suites** and
**304 E2E tests /32 suites**, with zero skips. Backend build/lint, frontend
tests/build and documentation checks (31 required /102 scanned) pass. All1081
verification-source files remained unchanged during the run. Owned PostgreSQL
and the bounded sleep assertion are stopped; production identity and protected
hashes remain unchanged. Dedicated group UI/browser, supplier/media ownership,
pre-durable/older-writer/capacity, parent/source governance, reports and M6 remain
open. Contract:
[complete-group disposition](pricing-group-disposition.md).

### Dedicated group review UI (workflow checkpoint verified)

The separate group inventory/editor, complete physical/member evidence views,
paginated impacts, strict browser hash/application/epoch validation and scoped
same-ID retry storage are implemented. All seven locales now contain757 pricing
keys, including50 new group-specific strings. Frontend tests/build pass; the group
route is9.96KiB gzip under a new16KiB cap without changing existing limits or
dependency versions. Backend source/tests remain identical to the verified011
checkpoint; the frontend work does not claim another full backend run.

Actual isolated browser/DB snapshots verify no-write previews across12 accounting
tables; a lost successful reply followed by reload and exact retry yields one
decision/two conserved corrections; acknowledgement writes nothing. Adopting12
missing members from the second inspection/impact page leaves reservations,
budgets and terminal intents unchanged. An acceptance-blocked historical group
can be explicitly rejected without changing costs or custody. Operator read-only
controls and viewer denial are exercised. All21 collapsed-detail locale/width
combinations pass actual CSS viewport, overflow and title checks; representative
English desktop and Chinese375px dark screenshots are inspected. Zero model calls.

The subsequent final-frontend verification completes conflict/reread/consent,
failed-basis acknowledgement, old-period/cost-only flows, foreign-workspace
navigation and28 expanded/inventory seven-language layout cases. Seven decisions,
ten conserved corrections and12 initial receipts commit with zero provider calls.
The client also verifies complete selected share contents, not merely conserved
physical totals; additional mixed-cohort/independent/partial-history/unknown/1024
contracts pass. Final route10.01/16KiB, full frontend checks/build pass. Active
owner and corrected pending-intent fixtures fence both actions; initial intent
fixture failure is retained (later fixture setup had already applied its intent).

This completes the group UI workflow checkpoint, not M5 or the entire Goal.
Do not rebuild this page or repeat011 backend implementation. All owned browser
and test backend processes are stopped; production identity and protected hashes
remain unchanged. The original TypeScript/fixture/socket diagnostics and expected
beforeunload handling remain retained. Contract: [Dashboard](pricing-dashboard.md).

### Explicit price inheritance foundation (M2; integration in progress)

A new typed declarative resolver expands one explicitly selected immutable parent
into a complete effective price book. It preserves unmodified parent components,
permits explicit component/group overrides or removals, and records source
provenance. Parent hashes, source approval, identity/currency/unit boundaries,
calendar inheritance/replacement and existing rule conflict validation are enforced.
No model-name multiplier or missing fee is invented. The foundation now has24
pure cases plus20 repository cases per SQLite WAL/PostgreSQL backend, two new
migration cases per database and six actual HTTP cases. The focused fixed-source
run passes228 unit/database cases and21 HTTP cases with no skips; lint passes.

Additive012 now retains draft recipes and published lineage with restrictive
parent/audit references. Scoped repository create/preview/update/publish/fork/
rollback/read and portable recipe import/export are integrated. Exact ancestor
scope/content/lineage verification and draft CAS prevent source loss; the original
complete runtime materialization stays unchanged by later parent publication.
Actual in-flight HTTP evidence verifies this boundary. An old migration fixture
incorrectly left012 present while removing011; it now recreates a real010 schema
by removing later test-only migrations, without relaxing ordering checks. Original
fixture/typecheck-path/unused-import diagnostics remain preserved.

The fixed-source012 full run passes **2838 unit tests /157 suites** and **310 E2E
tests /33 suites**, with no skips. Build/lint, existing frontend tests/build and
docs (31 required /103 scanned) also pass. All1093 verification-source hashes
remained unchanged; the owned PostgreSQL process and bounded sleep assertion
are stopped. Production identity and protected hashes remain unchanged. Dedicated
seven-language editor, lossless copy/import controls and historical cost source
presentation remain open. Migrations
001–011 retain their original hashes. Contract: [price inheritance](pricing-inheritance.md).
The entire M0–M6 Goal remains active; this is not a deployable final candidate.

### Immutable parent-price editor and historical sources

The frontend now preserves derivation metadata throughout editing, copy,
import/export, save, publication and rollback preview. The parent picker fixes an
exact accessible version/hash, shows inherited rates and requires consent before
staging a replacement. Component/group/calendar resets are explicit; unchanged
cache rates and same-value override intent are retained. Current-edit copy no
longer substitutes the previously fetched saved document. Creation previews the
recipe in the selected child scope before writing.

The historical-source panel is separate from the editor bundle. It lazily verifies
the receipt's original child version and lineage, with links to exact original
parent versions; it never quotes or reprices history. Read-only validation uses
the materialized-document route rather than an administrator-only parent edit.
Publication replies are checked against the reviewed content and lineage.

The fixed-source frontend gate passes all frontend tests, build/bundle checks and
docs. All seven locales have **807 pricing keys**. Browser form contracts use the
actual pure backend resolver, not a second pricing implementation. Pricing route
size is **17.89 KiB gzip**, request-cost **6.71 KiB**, shared vendor **123.63 KiB**;
all existing caps remain unchanged. The previously verified backend and all
001–012 migrations are unchanged, so this frontend-only step does not rerun or
rebuild already verified backend recovery layers.

The isolated browser run verifies exact parent selection/staging with no writes,
input override plus five inherited output/cache rates, save/publication preview
and confirmed publication. A newer synthetic parent publication leaves the child
and historical receipt hashes unchanged; the historical link still opens the old
parent price. Historical details make zero version reads before expansion and
one exact child-version read after expansion. It also verifies unsaved-copy
preservation, private-parent/global-child rejection, explicit component reset,
and actual recipe file export/import. Fourteen historical-source locale/layout
cases pass (desktop/light and 390-pixel/dark in all seven languages).

The final synthetic fixture has six books, three derived drafts, five immutable
versions, two published lineage records and **zero model calls**. The owned
browser/server are stopped; production identity and protected hashes are
unchanged. This is **partial browser acceptance**, not final delivery. Parent
picker/editor locale layouts, conflict/parent switching, read-only/scope and
failure feedback, calendar/group reset and rollback browser cases remain open,
as do all other uncompleted M0–M6 requirements listed below.

### Inheritance editor acceptance completion

The subsequent inheritance run closes its dedicated editor/source acceptance
worklist. Revision conflicts preserve the user's rate and expose recipe/content
differences; explicit reload restores the server revision. Unavailable parent
reads lock editing/saving until successful retry. A tampered lineage preview
cannot mutate pricing data. Pending previews prevent workspace switching;
read-only validation calls only the allowed materialized-content endpoint, and
private child/parent metadata disappears when switching to another workspace.

Calendar edits normalize a supplied time-zone alias through both server previews,
and calendar/group resets restore their exact parent definitions while preserving
other rate overrides. Explicit parent switching replaces the complete document,
including old overrides and calendars. The rollback dialog now asks before
abandoning dirty edits; cancellation keeps them, and confirmed rollback publishes
the original immutable content/lineage rather than the unsaved rate.

Two observed feedback defects were fixed, with direct browser evidence: an error
formerly located above the viewport now scrolls into view and receives keyboard
focus, and staging a verified parent clears a previous unrelated error. Full
frontend tests/build/docs pass after these fixes. Existing bundle limits remain
unchanged: pricing **18.02 KiB**, request cost **6.72 KiB**, shared vendor
**123.63 KiB gzip**. Backend source and all 001–012 migrations still match the
2838-unit/310-E2E checkpoint; no recovery layer was rebuilt for this UI work.

The editor and parent picker have **28** additional seven-locale surface/layout
cases at desktop/light and 390-pixel/dark widths, plus keyboard focus/arrow
navigation checks. Final visual screenshots wait for CSS transitions to settle;
intermediate theme frames are retained separately and are not claimed as visual
acceptance. Combined with the previous 14 historical-source cases, the three
inheritance surfaces have dedicated locale/layout coverage.

Durable synthetic snapshots verify no-write failure/viewer checks, calendar and
group restoration, and equal immutable hashes across rollback versions. The
final fixture contains six books, three drafts (two derived), five versions
(three derived), 37 pricing audit rows and one synthetic cost attempt, with
**zero model calls**. All owned test/browser processes are stopped; production
identity and five protected hashes are unchanged. Inheritance-specific editor
acceptance is complete at this checkpoint; the overall M0–M6 Goal is not.

### Authenticated normalized media-event backend013

A registered, workspace-scoped connector can now deliver complete normalized
media snapshots through a dedicated HMAC-authenticated endpoint. Dashboard/API
keys cannot replace that signature. Source configuration is revision guarded,
requires explicit administrator consent, and stores only a dedicated environment
variable name, not its signing secret. Event acceptance rechecks source revision,
original node connection fingerprint and the persisted dispatch credential.

Additive013 stores source registrations, immutable event receipts and task
ordering heads. Complete snapshot sequence numbers are exact strings; lower
sequences are retained without repricing, same-sequence disagreements require
review, and pending-after-terminal cannot reopen the task. A newer terminal
snapshot uses the original frozen price/FX and existing linked-adjustment path.
Once a sequenced source owns a task, unversioned polling alternatives are retained
for review instead of silently undoing it. Missing ordering state fails closed.

A lost submission response can now be repaired when the authenticated connector
knows the exact original gateway task: the job ID is associated with its original
physical credential and no generation is repeated. This does not invent missing
supplier/task correlation, and it is not universal native webhook support or
supplier invoice confirmation. Operator pagination, seven-language source/task
configuration and alternative-evidence disposition remain required.

Required source-approval and event audits, custody/head and observation writes
commit atomically. Financial processing is a separate durable, retryable step;
the endpoint distinguishes retained evidence from pending processing. Tests cover
an actual child exit after authenticated custody but before financial application,
concurrent deliveries, exact retries after key-source revision changes, failed
required audits, stale/out-of-order alternatives and late runtime state updates.

The final source-locked run passes **2903 unit tests /158 suites** and **314 E2E
 tests /33 suites**, with no skips. It includes 29 pure protocol tests, 17 new task
contracts per SQLite WAL/PostgreSQL backend, one new migration contract per
backend and four real-HTTP cases. Build/lint, existing frontend tests/build and
docs (31 required /104 scanned) pass. All1108 source files remained unchanged;
001–012 checksums are intact and013 is frozen. All owned database/test processes
are stopped; production identity and five protected hashes are unchanged.

Original diagnostics remain recorded: an inaccessible helper accessor, historical
migration fixture lists/order that omitted the new013 step, and an opaque-ID
regex that incorrectly rejected `task-` prefixes. Fixes preserve old migration
checksums and strict ordering; no failing tests were converted to skips. This
backend checkpoint does not complete the whole M0–M6 Goal. Contract:
[authenticated media events](pricing-media-supplier-events.md).

### Media inventory and administrator-attested job lookup014

Source, task and supplier-event inventories now support workspace/resource/view-
bound keyset pagination. Task detail exposes allowlisted metadata and its existing
original cost ledger; event detail exposes retained normalized evidence, not raw
provider bodies. Equal creation timestamps are covered by ID tie-breaking, and
cursors from another workspace, task or list type are rejected.

An administrator can preview a separately investigated provider job ID against
an existing uncertain gateway task. The server uses only the original configured
status endpoint, connection fingerprint and physical credential. It verifies the
returned job identity, normalizes allowed evidence and quotes the original price/
FX snapshot without database writes or locks held over provider IO. Authority and
task basis are checked before and after the lookup; an administrator revoked
during the GET cannot obtain a usable preview.

Confirmation repeats the GET and checks the exact basis, normalized-observation
and cost hashes. The association is explicitly administrator attestation, not
proof of supplier-request correlation or invoice confirmation. Additive014 writes
the immutable reconciliation receipt, required audit and media observation
atomically. Existing durable task processing handles the subsequent financial
step. Same-ID exact retries and acknowledgement use retained evidence rather
than fetching the supplier again. Pending jobs remain reserved. Signed/manual
claims share a provider-job identity lock so separate workflows cannot attach
one physical job to different tasks.

A review after the initial full run found and reproduced a missing-time bug:
later ordinary polling could copy operational task dates into pricing as if they
were provider acceptance/completion times. The corrected path verifies the
immutable lookup receipt and preserves which provider instants were known or
missing; a lost receipt with a surviving deterministic audit marker fails closed.
Actual HTTP polling and both database backends verify this regression. The
original failed test and earlier pre-fix run remain recorded, not discarded.

The final corrected source-locked run passes **2949 unit tests /158 suites** and
**319 E2E tests /33 suites**, with zero skips. It adds22 task contracts per SQLite
WAL/PostgreSQL backend, one migration contract per backend and five actual HTTP
cases beyond013. Independent connections, manual-versus-signed claim races,
required-audit rollback, actual process exit, original prices, no-provider-retry
acknowledgement and pagination/scope behavior are covered. Build/lint, existing
frontend tests/build and docs (31 required /105 scanned) pass. All1116 source
files remain fixed during verification;001–013 checksums are unchanged and014 is
frozen. All owned test/PG processes are stopped and production identity plus five
protected hashes are unchanged.

This is backend acceptance, not a completed media operator experience. The
seven-language task/source/lookup UI, alternative-event disposition, native
translator coverage and whole-Goal governance/reporting/operational gates remain
required. Source disabling after a configured node is removed or changed also
needs its focused configuration review before that UI is called enterprise-ready.
Contract: [media task inventory and lookup](pricing-media-job-lookup.md).

### Seven-language media operator Dashboard

The media task/source/job-lookup pages now use the paginated014 APIs. Task pages
show original cost/ledger evidence separately from internal job state, retain
normalized supplier events with verified hashes, and state that the inventory is
not all gateway traffic. Operators are read-only; administrator actions use
workspace-captured transport and existing dirty/busy navigation guards.

The lookup editor verifies the exact task, physical credential, preview hashes
and returned receipt. A scoped minimal proposal is saved before POST; lost replies
restore the same operation across browser reload and allow exact retry or receipt
acknowledgement even when the basis read is unavailable. Receipt custody and
`processing_pending` are distinct from financial settlement. Conflicts preserve
fields, invalid previews cannot apply, and visible/focused error feedback is
retained. A pending basis read does not hide restored retry metadata.

Signing-source forms accept only a dedicated signing-variable name, never a key
value. Sources start disabled, original node/credential identity is locked, and
writes preserve revision checks. Uncertain replies are resolved by verified
current-state rereads; this is explicitly not proof of delivery of an earlier
reply. A separate new-source session slot and creation path avoid collision with
an existing source ID named `new`. A focused backend fix now permits disabling
an existing source after node removal/fingerprint change or signing-key loss,
without retargeting its historical identity. Scoped source detail is available.

All seven locales contain **897 pricing keys**. Frontend contracts cover exact
monetary/hash fields, source revisions, minimal scoped retry records, cursor
validation and dynamic statuses. A type-only inventory contract prevents the
browser compiler from importing server Buffer/NestJS implementations.

Actual isolated browser evidence covers task/source/event page2, no-write lookup
preview, lost reply → reload with failed basis → acknowledgement, exact same-ID
retry without another supplier call, durable-but-processing-pending state,
changed-evidence conflicts, invalid preview rejection, source creation/update
recovery and revision rebase, operator/viewer/workspace restrictions, and safe
old-node source disabling. **56 surface/layout cases** cover four media surfaces
in seven languages at desktop/light and390-pixel/dark widths after CSS transitions
settle. The fixture has23tasks,24sources,23events and3lookup receipts. Its9mock
status GETs include no generation calls; exact retry/ack snapshots show no further
supplier calls or durable writes.

The final source-locked run passes **2951 unit tests /158 suites** and **320 E2E
 tests /33 suites**, without skips. Build/lint, frontend tests/build and docs
(31required /106scanned) pass. Existing bundle caps stay intact; new route sizes
are1.35KiB inventory,4.04KiB task and3.13KiB source configuration, with shared
vendor123.71KiB gzip. All1125source files remain fixed during regression and all
001–014 migration checksums are unchanged. Final browser entry/current assets
match the full build; obsolete files from earlier copied fixture builds are
retained but are not referenced by that final entry. Browser/PG/test fixtures are
stopped and production identity plus five protected hashes remain unchanged.

Alternative media-event disposition and native translator coverage are still
required, as are the whole-Goal capacity/governance/report/operational gates.
This checkpoint is not `READY_FOR_REVIEW_NOT_DEPLOYED`.
Contract: [media operator Dashboard](pricing-media-dashboard.md).

## Verification

**Last completed full regression: media operator Dashboard and safe source
revocation (2951unit /320E2E, zero skips), on unchanged migrations001–014.
This verifies the current implementation checkpoint, not the entire M0–M6 Goal
or a deployment. Inheritance and media operator pages have separate real-browser
acceptance. Alternative media-event disposition, native translator coverage,
report/governance and operational gates remain required.**

All results use synthetic prices and mocked providers, not current supplier prices.

| Gate | Current result |
| --- | --- |
| Full backend build | Passed for the current M3/M4/M5 candidate. |
| Full lint | Passed with zero warnings for the current backend candidate. |
| Full unit/regression | **158 suites; 2951 tests passed; no skips**, including the independent PostgreSQL tests. |
| Full E2E | **33 suites; 320 tests passed; no skips**, including native Messages/embeddings, image/video lifecycle and policy/stream admission cases. |
| Focused actual request E2E | **24 token/correction/recovery, 14 synchronous-media, 12 async-media and 14 admission, 15 physical-attribution/race/cancellation, 7 batch preview/legacy-queue and 25 priced-batch runtime/correction tests passed**, all included in the final full E2E run. |
| Frontend static/contract tests and production build | Passed; all seven locales, scoped actions, precise strings, lossless patches and bundle gates. Explicit shared-vendor budget change is documented in ADR-018. |
| Real isolated browser | Request-log evidence/replay, no-write correction preview, lost-response idempotency, retained-edit conflicts, viewer controls, cache/legacy labels, visible focused error feedback, and policy/FX validation and publication, no-write previews, legacy explicit-zero patch, hidden-price preservation, long-context quote boundaries, publication, history guard and two conflict/reload cases. Desktop/mobile and Chinese/English inspected; remaining flows are not claimed passed. |
| Administrator writer contracts | 20 cases per SQLite/PostgreSQL backend plus 7 real-HTTP administration/failure cases; metadata, epochs, audit and permissions remain consistent. |
| Workspace authority contracts | 24 cases per SQLite WAL/PostgreSQL backend plus 8 real-HTTP workspace/member/invitation cases; independent connections, scoped authority, required audit, ID compatibility and acceptance effects. |
| Outcome retry and suspected-orphan contracts | 10 bounded-buffer cases; 8 orphan cases per SQLite WAL/PostgreSQL backend, 2 added migration cases per backend, and 4 new real-HTTP recovery/backpressure/scoping cases; prior migration hashes remain intact. |
| Audited budget recovery | 19 added cases per SQLite/PostgreSQL backend, 2 retry-retirement cases, an additional migration upgrade case per backend, and 5 real HTTP cases; atomic connected groups, cache separation, CAS, authority, late usage, audit/member rollback and post-commit recovery. |
| Recovery UI and inventory | Four additional ledger cases per SQLite/PostgreSQL backend, three bounded-projection tests and one added actual HTTP case, plus role checks for the new GETs. Real-browser group/recorded-intent lost replies, exact retry/acknowledgement, reload, conflicts, no-write previews, operator/viewer controls, consent invalidation, seven locales and narrow/dark layout passed. |
| Missing first usage | 23 cases per SQLite WAL/PostgreSQL backend and 5 actual HTTP cases. Frozen/legacy prices, explicit estimated provenance, large quantities, manifest conservation, active/async/intent exclusions, audit/member rollback, independent-connection exact retries, child-exit acknowledgement, actual log projection, absolute-offset timestamp ordering and no additional provider calls. Seven-language input/form/session/hash tests and isolated browser workflow passed. |
| Terminal single-attempt correction | 24 cases per SQLite WAL/PostgreSQL backend and 5 actual HTTP cases. No-write exact-budget preview, original/legacy price and FX retention, cost-only unresolved evidence followed by effective-winner settlement, released/loser separation, unknown-to-known deltas, original-epoch refunds, underflow/audit rollback, scope/idempotency, independent connections and post-commit child exit. Seven-language form/session/hash/budget checks and isolated no-write/retry/acknowledgement/conflict/permission/locale browser evidence now pass. |
| Durable runtime outcome inbox | 24 cases per SQLite WAL/PostgreSQL backend, four new buffer cases, two migration cases per backend and four added HTTP cases; 90 focused cross-database/buffer/schema tests and 39 focused HTTP tests pass. Retention/audit rollback, exact replay after actual child exit, concurrent reads/writes, separate variants, unknown/private/non-finite inputs, batch/async exclusions, custody after manual decisions and persisted backpressure. |
| Retained evidence disposition | 40 cases per SQLite WAL/PostgreSQL backend, two added migration cases per backend and seven actual HTTP cases; 158 focused disposition/inbox/schema tests and 35 focused HTTP tests pass. Exact historical verification, initial/linked/no-op receipts, rejection custody, no-write original-epoch preview, atomic required audit/disposition/log effects, competing reviewers, delayed delivery, same-ID/child-exit acknowledgement and populated008 upgrade. Dedicated seven-language UI and isolated browser retry/permission/layout checks are now implemented. |
| Auxiliary repository writers | 29 cases per SQLite WAL/PostgreSQL backend and 5 new actual HTTP cases; 15 writer paths survive an actual ledger rollback, plus prompt/import atomicity, network queue reentry, scope, fresh metadata, concurrent render/edit and bounded cleanup. Final focused92/9 and full2628/292 have no skips. |
| Complete-group outcome custody | 23 cases per SQLite WAL/PostgreSQL backend, two added migration cases per backend and three added HTTP cases. Final focused208/28 and full2678/295 pass with zero skips; complete retention, phase progression, physical conservation, required audit/member rollback, child exit, exact replay, scope/ownership, historical receipts, reference bounds, quarantine acknowledgement and local lease retirement. |
| Complete-group disposition | 44 cases per SQLite WAL/PostgreSQL backend, two migration cases per backend and nine actual HTTP cases. Focused436/44 and full2770/304 pass without skips; full-member authority, shared-epoch preview, immutable original price/FX, compatible fills/conserved revisions, multi-cohort/partial-history boundaries, exact retry/ack, child exit, required-write rollback and current-delivery fencing. Dedicated group UI now has separate verified browser/contract evidence. |
| Immutable parent-price backend | 24 pure cases, 20 repository contracts per SQLite WAL/PostgreSQL backend, two added migration contracts per backend and six actual HTTP cases; focused228/21 and full2838/310 pass without skips. Immutable materialization/provenance, scoped16-parent ancestry, draft CAS, missing/tampered source detection, restrictive audits/parents, populated011 upgrade, fork/rollback/import/export and in-flight request price isolation. Dedicated parent-price editor/source presentation remains open. |
| Authenticated media-event backend | 29 pure protocol cases, 17 task contracts per SQLite WAL/PostgreSQL backend, one new schema contract per backend and four actual HTTP cases. Full2903/314 passes without skips. Signatures/source revisions, frozen prices, unknown submissions with known task correlation, sequence conflicts, unordered custody, required-audit rollback, concurrent delivery and actual child exit are verified. Operator UI, full pagination/disposition and native translators remain open. |
| Media inventory and job-lookup backend | 22 new task contracts per SQLite WAL/PostgreSQL backend, one schema contract per backend and five actual HTTP cases. Full2949/319 passes without skips. No-write pinned lookups, exact reviewed evidence/original costs, role changes during IO, independent-connection/claim races, required-audit rollback, actual process exit, exact no-network acknowledgement, pagination and conservative provider-time evidence are verified. Seven-language UI and alternative-event disposition remain open. |
| Media operator UI and source revocation | Seven-language897-key UI, exact scoped proposal/source/hash and pagination contracts; real browser lookup/source retry, conflict, privacy, pending-settlement and56layout cases. Full2951/320 includes one added source-revocation case per database and one HTTP case. Node/key loss cannot prevent safe disabling or permit source retargeting. |
| Recovery failure tests | SQLite WAL and PostgreSQL child-exit/replay, transaction rollback, concurrent recovery, lease fencing, startup precision and config/usage concurrency are included in the final unit run. |
| Config validation | Passed against an isolated synthetic fixture, including image control endpoints; expected custom-catalog warnings retained. |
| Documentation check | Passed: 31 required files, 106 scanned files. |
| Production protection | Same PID, active entrypoint/release, 2099 listener and all five protected hashes. |

The actual request tests cover cached-inclusive long context (**$0.126**), in-flight
publication, retry unknown-cost accounting, local cache, final cumulative SSE,
malformed usage, read-only replay, native Messages with both TTLs (**$0.000089**),
embeddings, and receipt-failure/no-extra-provider-retry behavior.

The earlier M2 checkpoint had 1921 unit tests and 125 E2E tests passing; the first
M3 checkpoint had 1968 and 135, synchronous media had 2021 and 154, and async
media had 2048 and 166. Admission had 2069 and 180, and the first Dashboard checkpoint had 2074 and 189. Physical dispatch attribution had
2083 and 204; the batch foundation had 2111 and 210; the first priced-runtime checkpoint had
2115 and 228.
Those are historical counts. The results above
include the recovery/correction/task schemas, budget coordination, immutable
revision chains, late log projections, bounded pinned controls, migration/crash
replay, atomic admission policy/CAS, rate envelopes and real HTTP recovery/
correction/idempotency/stream-admission tests.
The preceding budget-resolution checkpoint had 2325 unit and 265 E2E tests.
The subsequent recovery-UI checkpoint had 2336 unit and 266 E2E tests, adding
the recovery inventory, acknowledgement and scan-bound contracts. Its three
projection tests include an empty 200-candidate page
with a continuation, shared-request summary reuse and unavailable-storage errors.
The first missing-usage backend checkpoint had 2380 unit and 271 E2E tests, adding
44 cross-database contracts and 5 actual HTTP cases. The missing-usage UI checkpoint added
two offset-time regressions and the seven-language input/form/session/receipt-hash
checks and browser evidence above. That checkpoint had 605 keys; the subsequent
single-attempt UI has 644 pricing keys in each locale.
The preceding single-attempt correction checkpoint added 48 cross-database cases
and 5 actual HTTP cases. The original lint failure is retained; the final full
run uses the corrected import and includes explicit legacy/removed-FX tests.
The subsequent durable inbox adds 48 cross-database cases, four buffer cases,
four migration cases and four actual HTTP cases. It also strengthens two existing
recovery HTTP assertions from memory counts to byte-for-byte durable custody.
All seven earlier migration checksums remain unchanged; new 008 is frozen at this
checkpoint. Final full unit/E2E runs have no skips. The owned browser, synthetic
backend and PostgreSQL process are stopped after verification.

The next disposition checkpoint adds 80 cross-database contracts, four schema
contracts and seven actual HTTP cases: final totals are 2570 unit tests and 287
E2E tests. All nine migration checksums and the uncommitted verification source
identity are recorded privately. No new UI or browser evidence is claimed for
this backend step; all owned test services are stopped after verification.

The subsequent auxiliary-writer checkpoint adds 58 cross-database cases and five
HTTP cases: 2628 unit and 292 E2E tests in the fixed-source full run, with zero
skips. All nine pricing migrations retain their checksums. The only entity type
adjustment maps profile timestamps portably, with both actual backends tested.
The original 204-cancellation failure and test-fixture diagnostics are preserved;
no test limit, dependency version or production state was relaxed to pass.

The complete-group custody checkpoint adds46 group and4 migration cases plus
three HTTP cases. The sustained-awake full run passes2678 unit and295 E2E tests,
with zero skips; all1072 verification-source files match. Migration010 is frozen
alongside unchanged001–009. Its compact custody/read-only API does not complete
operator disposition, async supplier ownership, pre-durable capacity or the full
Goal. Two preceding sleep-interrupted attempts remain explicitly recorded.

Pinned dependencies still emit existing pg introspection deprecation / ts-jest
JavaScript warnings; no dependency upgrade was performed.

## Next work, in dependency order

1. **Finish M3 consistency and recovery:** complete supplier-evidence resolution,
   receipt-quarantine disposition, pre-durable process-loss strategy and automatic
   correction delivery. Durable runtime outcome retention/replay and read-only
   inventory are implemented in 008, preserving incoming different receipts.
   Independent-receipt disposition is implemented in009 and complete-group
   custody/replay in010. Complete-group disposition backend011 is now verified;
   its dedicated UI is now verified as well. Automatic supplier reconciliation remains open; task alternative disposition
   and its seven-language UI are now implemented in015. Do not rebuild these verified layers.
   Missing-first-receipt administrator attestation is now
   implemented under original snapshots with no budget effects, together with
   its seven-language Dashboard input and browser retry/preview evidence. Terminal
   partial/unknown correction APIs are now implemented for individual attempts
   and the existing conserved batch path. The individual correction UI is also
   verified. Retained independent-receipt disposition/correction has a backend API;
   its dedicated seven-language UI is now verified. Full group/task coverage and
   authenticated supplier imports remain open.
   The bounded retry aid, suspected-orphan observations and
   audited connected-group **budget-only** resolution are implemented, not a
   complete supplier-outcome recovery solution. The budget-only operator UI and
   scoped operational inventory are implemented; supplier-evidence workflows and
   remaining resumed-owner/older-writer case lifecycle are still required.
   The enumerated legacy/auxiliary writers now join SQLite coordination,
   in addition to generated-key/team, management-audit and workspace/member/
   invitation boundaries. Complete the final call-graph/acceptance audit rather
   than assuming arbitrary plugins or external SQL are covered.
   Known terminal-intent replay, local lease renewal, central budget config/startup
   coordination and post-commit threshold/telemetry observations are implemented.
   The existing alert queue is still best effort, not a durable outbox.
   The batch job/legacy call-log, evaluation, prompt-template, agent-profile,
   shadow-result, compatibility-result and Dashboard cleanup call graphs are now
   coordinated and tested. This is not a claim that this inventory is exhaustive.
2. **Finish M3 accounting coverage:** validate real provider limit/adapter domains
   for the conditional reservation policy; finish race/retention coverage for the
   priced embedding coordinator and its now-implemented conserved corrections,
   remaining adapter coverage and report/list status enrichment.
   Physical credential/compatibility retries, requested/route/wire/reported model
   provenance, real HTTP timeout-race/late-loser evidence, late ledger-receipt
   projections and stale write-behind protection are now implemented.
3. Complete the remaining supported-domain and requirement-level acceptance.
   The read-only admission-assessment UI is now verified in the checkpoint below;
   do not rebuild it or conflate it with remaining-budget authorization.
   Metering extraction inventory, conditional-coverage presentation, unsupported
   publication blocking and reviewed-profile conflict protection are now verified
   in the metering checkpoint below; do not recreate those layers. Retained-
   request cost reporting and authoritative log cost cells are now implemented
   and verified in the cost-report checkpoint below; do not rebuild them. The
   parent-version editor, lossless copy/import/export and lazy historical-source
   display now have dedicated frontend and browser acceptance, including locale,
   conflict, scope, failure, calendar/group reset and rollback checks above.
   Do not repeat inheritance implementation/acceptance instead of proceeding to
   the remaining supplier/media, coverage and reporting requirements. The explicit parent
   resolver and scoped recipe/lineage repository/API are now verified in012; do
   not rebuild them. Do not invent or auto-activate vendor contract rates.
4. **Finish M4:** the authenticated `siftgate-media-v1` connector boundary and
   ordered durable event custody are implemented in013. Paginated source/task/
   event inventories and administrator-attested known-task/unknown-job lookup are
   now implemented and verified in014. Their seven-language operator UI and safe
   source disabling on configuration change are also implemented and verified.
   Same-sequence/unversioned alternative disposition and its UI are implemented
   in015. Next complete native supplier translators and task/claim/event retention
   and the remaining media coverage audit. No public unauthenticated callback,
   inferred task/job correlation, arrival-time ordering or blind generation
   recovery is permitted.
5. **Finish M5:** audit remaining analytics/export integration beyond the new
   retained-request report and log cost cells; complete admission assessment UI
   and any still-unverified calendar/import/rollback/
   permissions/race browser checks. The six-area editor, catalog policy/FX forms,
   lossless NodeForm patches, request-log evidence/replay/batch correction,
   budget-only recovery/inventory, missing-usage/single-attempt correction and
   retained-evidence and complete-group disposition UI are now implemented in all
   seven languages. Group custody/disposition workflows are verified; do not
   repeat them instead of finishing other Goal requirements. All browser
   testing must continue to use isolated instances only.
6. **M6:** retention, full acceptance matrix, cross-database recovery, Docker,
   performance and candidate packaging with fixed source identity and rollback
   instructions. No skipped gate may be labelled passed.
7. Stop for user review at `READY_FOR_REVIEW_NOT_DEPLOYED`; deployment requires
   new explicit approval after review. Do not reuse prior restart authorization.

Operational API behavior is documented in [pricing management API](pricing-management-api.md).
Current private log paths, production evidence and test PostgreSQL identity are
stored in the ignored local development environment record. Inspect the actual
process state before starting or stopping any test service.


## Media alternative-event disposition verified checkpoint

The previously missing media alternative-event decision path is now implemented:
additive015 custody and authority, no-write original-catalog/FX preview with exact
original-period adjustment impacts, administrator/CAS/idempotency protection,
atomic decision/audit/observation, crash recovery and separate subsequent ordering.
Unversioned acceptance requires manual review; a reviewed signed snapshot can
explicitly resume ordering at its sequence. Original supplier receipts and signed
heads are not relabelled or overwritten. Inventory excludes separately disposed
alternatives from its unresolved view.

The new seven-language route includes explicit choices, compared line-item costs,
scoped exact-ID session recovery even with unavailable basis reads, rejection,
conflict retention and historical decisions. There are41new locale keys (938 total
per pricing namespace). Browser verification found and fixed two issues: a stale
basis error after successful acknowledgement, and a long event hash expanding the
narrow header. No global header, prior migration or pricing contract was changed.

The focused run passes233unit contracts (SQLite and PostgreSQL),47HTTP contracts
and lint. The subsequent fixed-source full run passes2991unit tests in158suites
and325E2E tests in33suites, with zero skipped or failed tests. Backend build/lint,
frontend tests/build and documentation checks (31required/107scanned) pass.
All001–014migration checksums are unchanged;015is frozen for this checkpoint.
These results verify this implementation checkpoint, not the entire Goal. Native supplier translators, pre-durable
process-loss/older-writer/capacity strategy, governance, all-traffic reporting,
retention/performance/Linux/Docker and fixed-source candidate/rollback acceptance
remain open. No production restart, configuration/database write or Git publication
is authorized. See [media event disposition](pricing-media-event-disposition.md).


Browser evidence covers8synthetic tasks,18retained events and6dispositions
(5accepted/1rejected), with0provider calls. Exact-ID retries and read-only
acknowledgements create no duplicate rows; previews and malformed-preview handling
produce no writes. Rejection leaves financial state unchanged; a manual-review
hold retains a later signed update until explicit administrator resumption.
Historical decisions, operator/viewer/workspace isolation, native keyboard
navigation and the task-event link are verified. All28final-build locale/layout
cases pass root/main overflow checks. Every current frontend build file and entry
matches the served fixture; obsolete unreferenced copied assets are identified,
not mistaken for current files. All owned browser/test/PostgreSQL processes are
stopped and the production identity and five protected hashes remain unchanged.


## Native video profile verified checkpoint

Explicit `gemini-veo-rest-v1` and `runway-task-v1` native result profiles now sit
beside the unchanged default `generic-v1`. The profile is pinned in each task's
immutable context. Verified native envelopes yield output counts; absent actual
seconds and provider acceptance/completion instants remain unknown. Supplier
credits and returned URLs are not cost evidence or fetched assets. Native-body
schema gating and model-bound Gemini endpoints precede dispatch. Existing signed
source ordering, unversioned alternatives, lookup and settlement are reused.

The focused checkpoint passes279unit contracts across SQLite/PostgreSQL and51HTTP
contracts plus lint. Earlier synthetic assertions exposed native ingress gating
and inappropriate global missing-duration diagnostics; those were corrected, not
worked around by supplying generic prompts or fake durations. Dashboard profile
selection and its seven-language copy are implemented. Frontend tests/build pass,
with14real-browser locale/layout cases and explicit profile save/reread, unrelated
edit and hidden-video-field preservation. The new selector has a localized
accessible name. The final fixed-source regression now passes3039unit tests in159suites and329E2E
tests in33suites, with zero failed or skipped tests. Backendbuild/lint, fullfrontend
tests/build, docs31required108scanned and the explicit privateconfigCLI pass. Native cancellation/content connectors, other native media
coverage, governance/capacity/reporting and M6remain open. See
[native video profiles](pricing-native-video-profiles.md).


A first full run passes3038unit and329E2E tests, but its following standalone
config CLI check found that video `{model}`/`{id}` endpoint slots were mistaken
for secret-reference delimiters. The validator now masks only supported slots in
specific video endpoint fields while preserving actual/malformed secret
expressions. The original failed CLI result is retained. The same private YAML
passes after the correction, with an additional negative-reference contract test;
the second fixed-source full run passes with3039unit and329E2Etests. All001–015
migration checksums remain unchanged. This checkpoint does not require a new
pricing migration. The first fullrun is retained as evidence of the pre-fix source,
not represented as verification of the final validator.


The native-profile browser fixture and its browser session are stopped. Every
current frontend build file and entry matches the final full build; obsolete
unreferenced copied files are identified as such. Browser configuration tests made
zero provider calls. Production PID, release target and five protected hashes are
unchanged. Source and documented-source manifests are recorded privately. This is
not `READY_FOR_REVIEW_NOT_DEPLOYED`: remaining native media/control coverage,
provider-limit/metering governance, pre-durable/older-writer/capacity handling,
all-traffic reporting and the full M6performance/Linux/Docker/candidate/rollback
acceptance still need completion. Do not add arbitrary suppliers instead of
closing the original requirement matrix.

## Retained-request cost report verified checkpoint

The new workspace-scoped report scans retained request snapshots by admission
time, including requests without logs, and legacy-only logs by recorded time.
Its compact log-summary endpoint replaces numeric log-cost cells with ledger
amounts/statuses, explicit unknowns, partial known amounts and legacy labels.
Existing traffic/key aggregates are labelled stored compatibility projections,
not presented as complete actual costs. Captured requests with missing receipts
remain unknown; only a durable original compatibility-bypass marker allows a
legacy estimate. Reads never create markers or modify costs/budgets.

Keyset pages use fixed initial upper bounds and consistent per-page reads, not
a whole-scan point-in-time guarantee. The UI verifies scope, cursor and page
content before accumulating exact separate amounts, displays partial scans,
supports bounded foreground continuation/pause, and exports a summary explicitly
marked with completeness and consistency. Both interval inputs and displayed
report timestamps use UTC. No production/default policy or existing migration
was changed. See [cost coverage reporting](pricing-cost-report.md).

The fixed-source regression passes **3065 unit tests in160suites and334E2E
tests in34suites**, with zero failures or skips. Backend build/lint, frontend
tests/build and documentation checks (31required/109scanned) pass. All001–015
migration checksums remain unchanged. The frontend report route is2.90KiB gzip;
existing bundle budgets remain unchanged. The UTC helper also passes frontend
contracts with a non-UTC host timezone.

Browser evidence covers133synthetic requests,50-row partial pages, unavailable
and corrupt continuation responses, retry without double counting, pause after
100rows and resume, completed summary export, default-workspace viewer reads,
other-workspace empty results without leaked totals, and unknown/legacy log cells
and cost details. All28final-build language/layout cases pass; the final Chinese
narrow/dark amount view was visually inspected. An initial UTC-layout attempt
had no active scan after a language change and timed out; that evidence is
retained, and an explicit fresh scan followed by the full28-case rerun passed.

The captured pricing/log tables are byte-equivalent before and after all report
reads, with0provider calls. All138current frontend files match the served
fixture; obsolete unreferenced copied assets are identified separately. The
browser, fixture and owned PostgreSQL are stopped. Production identity and five
protected hashes remain unchanged. Earlier focused-test, lint and frontend
build failures remain recorded with their fixes; they are not hidden as skips.

This closes the reporting checkpoint, **not the full Goal**. Metering/provider-
limit governance and publication/assessment warnings, pre-durable/older-writer/
capacity boundaries, remaining media/control and analytics scope acceptance,
retention/performance/Linux/Docker and fixed-source candidate/rollback delivery
remain open. A static Docker audit additionally identifies that the frontend
build stage does not yet copy the sibling shared pricing source now imported by
the Dashboard; isolated Docker build/smoke evidence is still required. Continue
against the original requirement matrix, not by adding arbitrary suppliers or
reimplementing the verified recovery, inheritance, custody and reporting layers.

## Metering publication review verified checkpoint

Publication and rollback now assess the full billing basis against implemented
operation-specific extraction paths. Provider-reported fields remain conditional;
explicit request-billed quantities, local counters, native-video quantities
requiring separate authoritative evidence, and unsupported paths are distinct.
No single matching operation means publication is blocked with a stable error,
including unintegrated realtime/session billing and impossible dimension
combinations. Drafts remain editable and previews remain read-only.

Node-targeted reviews include the selected native video profile, without its URL
or credentials. The Dashboard validates the review's content/target hash, shows
notices before confirmation and sends that reviewed hash on publication. A
changed profile rejects the write with409 and leaves the draft/catalog intact.
Errors and fresh previews clear previous confirmation. The successful publication
audit retains the exact review and whether it was confirmed; programmatic
callers without a review hash do not receive false review provenance. Supplier
support and administrator-declared quantity caps are explicitly not verified by
this code inventory. See [metering governance](pricing-metering-governance.md).

The shared review component appears in the editor and publication/rollback
dialogs in all seven languages (26new keys;1012pricing keys per locale). Browser
acceptance verifies native duration warnings, corrupt-hash blocking, a real
profile-change409, required fresh confirmation, a successful audited synthetic
publication, unsupported publication remaining disabled even when confirmed,
keyboard details toggling, viewer validation and workspace isolation. Fourteen
final-build desktop/light and narrow/dark locale cases pass. A narrow summary
wrap found during visual review was corrected; the final Chinese view was
inspected. Selector-label and hidden-native-option waits are retained as test
locator mistakes, not represented as product failures or silently discarded.

All pricing tables remain unchanged across previews and the rejected profile
race, and across subsequent viewer reads. The fixture contains exactly one
published version with a matching confirmed review, and zero paid attempts,
request snapshots, reservations or provider calls. All138current frontend files
match the served fixture; obsolete copied assets are identified separately.
Browser and fixture processes are stopped.

The fixed-source full regression passes **3079unit tests in161suites and338E2E
tests in35suites**, with zero failed or skipped tests. Backend build/lint,
frontend tests/build and docs checks (31required/110scanned) pass. All001–015
migration checksums remain unchanged; this checkpoint adds no migration.
The pricing route is19.21KiB gzip, within its unchanged24KiB budget. The owned
PostgreSQL process is stopped; production identity and five protected hashes
remain unchanged.

Earlier targeted runs found a TypeScript literal-widening error and a test that
queried the wrong audit-column name. Both were fixed, with original failures
retained, before the successful114unit/25HTTP focused run and full regression.
The cost report also now classifies non-object snapshot JSON as invalid evidence
without turning it into free/legacy cost or failing the entire page; that
regression is verified in both database contracts.

This is a verified implementation checkpoint, not full Goal completion.
Admission-assessment presentation, remaining recovery/capacity and traffic-scope
acceptance, retention/performance/Linux/Docker and fixed-source candidate/rollback
delivery still require completion against the original Goal requirements.

## Admission simulation and initial M6 verification checkpoint

The read-only Dashboard admission simulator is implemented at
`/pricing/admission-preview`, linked from price management, the policy panel and
draft-price simulation. It distinguishes current published catalog/FX from draft
prices and optional unpublished policy proposals. Explicit quantity source and
quality, null versus zero, conditions, declared/parent bounds, exact reservation
multiplication, quote/rounding details and price-policy-only decisions remain
separate. It does not check remaining budget or authorize actual dispatch.
Response metadata binds the scenario, workspace, target, evaluation time and
canonical hashes. Cancel/unmount and workspace changes cannot let a late response
replace a newer scenario. See [admission simulation](pricing-admission-simulation.md).

Frontend tests execute the actual pure backend catalog/admission code. Browser
acceptance covers compatibility and upper-bound proposals, the difference between
a0.5USD quote and7.2USD reservation, inconsistent rehashed responses, failed reads,
cancelled-old/new requests, missing FX with preserved CNY, request quantities
above a declared cap, stale indicators, a reread after an explicit fixture-policy
publication, and viewer/workspace isolation. All42final language/layout surfaces
pass. The final Chinese decision and English quote views were inspected; a
missing add label, an inapplicable incomplete-subtotal label and an optional
operation label were corrected before final captures. There are51new locale keys
(1063pricing keys per locale). The new route is6.17KiB gzip within its12KiB cap;
existing budgets are unchanged.

All pricing, budget and log rows remain unchanged across each read-only browser
interval; the only catalog change was an explicit synthetic fixture policy update.
No provider calls, attempts, reservations, request snapshots or call logs were
created by simulation. All current frontend assets match the served browser
fixture, and owned browser/fixture processes are stopped.

### Packaging boundary correction, not a Docker image pass

The Docker frontend stage now copies the sibling shared source it imports, and
`.local-dev` is excluded from build context. A clean COPY-equivalent directory
containing only frontend dependencies reproduced a real TypeScript failure:
transport types reached an ORM schema module. Recovery row/summary types were
moved to a pure contract module; the schema reexports them for compatibility, and
its table definitions/checksums did not change. The isolated frontend-only build
then passed. A CI dependency-closure guard checks27entry/33shared modules for
server-package dependencies. This host-platform build is **not** Linux image or
native-addon verification.

A separate capped arm64 Linux VM and Docker daemon were successfully initialized,
without host mounts, SSH-agent forwarding, host SSH-config changes or activation
of the user's Docker context. Builder bootstrap failed while fetching the public
BuildKit image because the registry connection timed out. Direct host registry
TLS and a TLS-verified direct-address DNS probe also timed out. No host DNS,
network or task-model environment was modified. The private VM was then stopped,
with no owned containers and the original Docker context unchanged. **No image
build or smoke test passed; this remains an outstanding M6gate.**

### Pure-quote performance result

The new bounded benchmark exercises1000models ×20rules ×12components, with1000
warmup and10000measured quotes and fixed seed20260928. All1000models are visited,
and every quote is fully priced with12lines. On the isolated Node22/ABI127 arm64
macOS reference host, p95 is **0.074ms** and p99 **0.299125ms**, passing the
pure-quote targets. Compilation, memory, source fingerprints and raw samples are
recorded separately. This does not measure database persistence or Gateway HTTP
latency/throughput; see [performance methodology](pricing-performance.md).

The fixed-source full regression passes **3082unit tests in162suites and341E2E
tests in36suites**, with zero failures or skips. Backend build/lint, frontend
tests/build, and docs checks (31required/112scanned) pass. All001–015migration
checksums remain unchanged. Private PostgreSQL is stopped and production
identity plus five protected hashes remain unchanged.

The Goal is still active and not `READY_FOR_REVIEW_NOT_DEPLOYED`. Required next
work includes the baseline-versus-candidate HTTP/DB comparison, remaining
retention/capacity/recovery/analytics scope acceptance, actual Linux/Docker image
verification, fixed-source candidate/dependency/ABI/migration manifests and
rollback delivery. A private discovery index enumerates101explicit Spec IDs;
its tagged-test matches are candidate evidence only, not automatic completion.
Do not substitute more arbitrary features or a test count for the final
requirement-by-requirement audit.

## 2026-09-28 actual-main HTTP/DB checkpoint — full Goal still active

The isolated baseline archive builds successfully. Real HTTP comparison now runs
the compiled application rather than an E2E replacement module: synthetic local
upstream, private on-disk WAL/FULL SQLite, fresh PostgreSQL databases, independent
ports, high budgets, no retries/cache/provider traffic and identical workload
settings. Raw timings, first failures, profiles and database assertions are
retained. See [performance results and limitations](pricing-performance.md).

The SQLite comparison uncovered a measurable overhead. A profile-driven narrow
projection removes irrelevant complete-log-row hydration from adaptive routing
statistics without changing its bounded sample or returned summaries. Both JSON
scenarios still miss the performance targets after this change; passing SSE
scenarios do not make the full performance gate pass.

Actual PostgreSQL startup found a native UUID bootstrap incompatibility, now
corrected without changing existing IDs or SQLite's legacy ID. Actual SSE
shutdown then exposed competing shutdown handlers and unfinished post-response
accounting. One bounded shutdown owner now starts closing ingress, allows Nest
to close upgraded transports, then drains HTTP and tracked accounting at adapter
disposal before database shutdown hooks. A real Nest/upgraded-socket regression
guards that lifecycle ordering. Eight subsequent
candidate PostgreSQL runs validate4800complete requests, exact receipts/balances
and clean immediate post-response shutdown. The pristine baseline's separate
`datetime` metadata failure prevents an unmodified PostgreSQL comparison; no
unannounced baseline patch or passing comparative claim has been substituted.

These new edits supersede the earlier full-regression source fingerprint. The
new fixed-source regression passes **3092unit tests in164suites and341E2E tests
in36suites**, with zero failures or skips. Backend build/lint, frontend tests/build,
docs (31required/112scanned), TypeScript SDK tests/typechecks, Python SDK tests,
static Helm/Kubernetes validation, version consistency and provider-registry
checks pass. The001–015pricing migration checksums are unchanged. Static deploy
template checks do not replace a Linux image/native-addon smoke test. No production configuration,
database, dependency, release, watchdog or2099process has been modified. The
original M0–M6 Goal remains active: synchronous HTTP performance, a justified
PostgreSQL comparator, original-requirement audit, remaining capacity/retention
acceptance, actual Linux image smoke and fixed candidate/rollback delivery are
still outstanding. No commit, push, merge or deployment is authorized here.

## 2026-09-28 Rancher Desktop image and host-port checkpoint

The user clarified that the existing Docker environment is Rancher Desktop and
prefers the local machine as the first eventual deployment target, preserving2099
and caller addresses. The separate private Colima verification VM is stopped;
subsequent verification selects the Rancher socket explicitly without changing
the global Docker context or the daemon's settings.

The Node22-based Linux/ARM64 image builds from a frozen source context and a
pinned official base-image digest. The actual image entrypoint passes isolated
native SQLite/WAL-backup, legacy ingress, explicit migration, published pricing,
cache/long-context/SSE, history and restart checks on Rancher Desktop. A second
fixture proves host-loopback publishing on a temporary port and a host-side SSE
request followed by a clean stop. A controlled idle-process exit triggers one
automatic container restart while preserving that temporary address and the data.
An additional idle-listener fault closes the actual HTTP server; the real
listener watchdog exits and Docker performs a second restart on the same port.
No production port, database, provider or existing Rancher container is used by
those fixtures. Details and limitations are in the
[local-first rollout plan](pricing-rancher-rollout.md).

The standard public check covered only860tracked files. A separate temporary
audit repository included all1179candidate files and exposed a company-term
scanner collision with ordinary numerical/database wording. Only explanatory
comments and prose were rephrased; the full-candidate public check then passed
without relaxing the checker. These wording-only edits and the later rollout
documentation postdate the image's frozen source identity and require the final
candidate's documented source manifest to be updated.

The production-only dependency audit reports unresolved findings; they are not
hidden by the successful build. The full Goal is still active, not ready for
deployment: synchronous HTTP performance, the original requirement/capacity/
retention audit, dependency review and final fixed-source delivery remain open.
The Rancher host/engine itself was not restarted, and this checkpoint is not a
substitute for an approved2099cutover or a whole-host recovery test.

## 2026-09-28 conditional ledger metrics and fixed-source regression

A current-source HTTP profile confirmed redundant post-ledger metric refreshes
on attempt, intent and replay-only writes. The ledger now requests a refresh
through the existing post-commit effects boundary only when it collected budget
observations. Successful nested savepoints merge that request; outer commit runs
it once, while inner or outer rollback discards it. Current-period telemetry is
not reloaded for a correction confined to an older epoch. No price, balance,
reservation, recovery or SQL durability behavior is disabled.

SQLite and native PostgreSQL targeted verification passes243unit tests across
five suites and44E2E tests across three suites. The full fixed-source regression
passes **3104unit tests in164suites and341E2E tests in36suites**, without failures
or skipped tests. Backend build/lint, frontend tests/build/bundle checks,
documentation, TypeScript SDK tests/types, Python SDK tests, static Helm/Kubernetes,
version consistency and the provider registry checks also pass. Migration001–015
checksums are unchanged; the private PostgreSQL process is stopped afterward.

The500-request profiles retain2750 ledger writes and6750 SQL commits while
metric refreshes decrease from2750 to1000. A new uninstrumented16-process SQLite
comparison validates all9600 requests including warmup and4800 exact candidate
receipts. Nevertheless, the50ms JSON case remains above both HTTP targets, and
the50ms SSE case remains above the p95 target. See the full numerical results and
shared-host limitations in [performance verification](pricing-performance.md).
The whole performance gate is **not passed**, despite both zero-delay cases
passing in this run.

This checkpoint changes runtime source after the recorded Rancher image. That
image remains evidence for its own frozen source, not proof of the newer metric
change. Final packaging must rebuild/identify the approved candidate. The full
original Goal remains active, with its PostgreSQL comparison, requirement audit,
retention/capacity/dependency review and final rollback/candidate materials still
required. Production2099, its data/configuration/watchdog and the existing Rancher
environment remain unchanged; there is no deployment authorization or GitHub push.

## 2026-09-28 flat statistics reader and completed regression

The bounded statistics reader now avoids entity identity processing while keeping
its nine fields, window, sample, order and driver conversions. The same complete-row
comparison passes on actual SQLite and PostgreSQL, including millisecond boundaries,
booleans, empty results and limit clamps. The fixed-source full regression completes
**3109unit tests in164suites and341E2E tests in36suites**, with no failures or skips.
Backend/frontend builds, lint, frontend contracts/bundle limits, SDK checks, static
deployment checks, versions, registry and docs pass; the owned PostgreSQL stops and
production guards match.

The actual-main SQLite and PostgreSQL candidate experiments match their expected
persisted counts and exact amounts. The explicitly startup-modified PostgreSQL
control fails its first SSE shutdown case with600responses but598logs. It is not
a completed comparison and was not padded with a wait to hide the failure. The
SQLite JSON50ms result and the valid PostgreSQL JSON0ms comparison also miss the
HTTP targets; see [performance evidence](pricing-performance.md).

## Configurable capacity checkpoint — targeted verification

The original PERF-01 audit identified fixed schema bounds but no configurable
published-rule ceiling. The candidate now has optional `pricing_limits`, enforced
for new publication/rollback and guarded pricing JSON actions, with strict config
validation and atomic reload behavior. Existing active/historical catalogs remain
readable after a lower ceiling; metadata changes and future cancellation are not
blocked. Seven-language Dashboard information and explicit localized failures
are included. See [capacity semantics](pricing-resource-limits.md).

At this checkpoint,158targeted unit tests across four suites and24targeted E2E tests
across three suites pass with real SQLite/PostgreSQL, followed by backend build/lint
and frontend tests/build/bundle checks. Initial fixture errors and a missing frontend
import were corrected, with failed runs retained separately. These results are not
claimed as a new full regression or a passing HTTP performance gate. The original
requirement audit, dependency review, final image/candidate identity, portable
verification and database-aware rollback materials remain required. No production
configuration reload,2099restart, deployment or GitHub action occurred.

The capacity Dashboard also passed real-browser verification in all seven locales
at1440px/light and390px/dark:14layout states with no page/main horizontal overflow.
The displayed synthetic limits were1rule and4096parsed-JSON bytes. A rejected
publication preview showed the localized capacity message with confirmation still
disabled. Fifteen screenshots were retained, with representative desktop/English/
Thai narrow layouts visually inspected. Pricing, budget and log snapshots remained
identical; no provider calls occurred. The task-owned browser and temporary Gateway
were closed, and the temporary listener was confirmed absent before further tests.

## 2026-09-28 resumed capacity verification, retention and telemetry shutdown

The capacity full run was interrupted after3138unit tests had passed. On resume,
its execution handle and verifier were absent; the task-owned PostgreSQL remained
with no client connections. It was stopped by its verified exact data-directory/
PID identity. The unfinished E2E run was not declared passed. The identical source
manifest was then used to rerun only E2E and later gates: **350E2E tests in37suites**
passed, together with build/lint/frontend/SDK/static deployment/docs/version and
registry checks. Combined with the completed **3138unit tests in165suites**, this
is a same-source full checkpoint, not a claim that the interrupted run succeeded.

New [retention lifecycle tests](pricing-retention.md) invoke actual log cleanup on
SQLite and PostgreSQL, preserving original prices/receipts/reports, pending outcomes,
intents and orphan holds. Recovery after cleanup is idempotent; a failed batch rolls
back. Privileged removal of a referenced price fails cold restore instead of using
current prices. Targeted verification passes94unit tests in three suites and6E2E
tests in two suites, including the new eight cross-database cases and one HTTP
lifecycle. An initial fixture omitted required route trace metadata; it was fixed
without changing the application schema or weakening assertions.

The remaining shutdown audit found a real enabled-telemetry defect: the SDK
initializer still installed its own SIGTERM/SIGINT handlers and called process exit,
racing the already-implemented HTTP/accounting drain. A pre-change isolated test
confirmed both registrations. The initializer now exports one idempotent shutdown
promise; main awaits it after application/accounting teardown under the existing
deadline. Disabled telemetry stays a no-op. See [shutdown ordering](pricing-shutdown.md).
The targeted initializer/main/real-Nest drain tests pass, and an actual compiled-main
smoke with the real SDK passes104JSON/SSE requests with exact budgets/receipts/logs,
local trace export and orderly exporter-listener closure. No external collector or
provider is contacted.

This runtime shutdown change requires its own full regression. The earlier full
checkpoint and the small telemetry smoke are not substitutes, nor do they make the
unmet HTTP performance targets pass. Final source/image, dependency, complete
requirement and candidate/rollback acceptance remain open. Production2099 and its
configuration, data, release and watchdog are unchanged; no GitHub action occurred.

The retention/telemetry fixed-source full regression is now complete:
**3153unit tests in167suites and351E2E tests in38suites**, with zero failures and
zero skipped tests. Build/lint, frontend tests/build/bundle limits, SDK tests/types,
static Helm/Kubernetes, documentation, version consistency and provider registry
checks pass. The private PostgreSQL process stopped and protected production
identity/configuration checks matched. This supersedes the pending-full-run note
above, but does not waive the outstanding HTTP performance, dependency or final
candidate acceptance work. No production restart or deployment took place.

## 2026-09-28 dependency security candidate — verification in progress

The recorded backend production dependency audit was reproduced:36findings,
including9high. Maintainer advisories and registry metadata were inspected, then
candidate locks were resolved in isolation and reviewed before installation.
The update stays on Nest11, TypeORM0.3, Undici6, ReactRouter7 and Vite6; the
OpenTelemetry SDK/exporter set is updated together. Original runtime/config/data
and production dependencies are not touched.

Both installed dependency trees now return **zero findings from full npm audit**,
including development dependencies. Root YAML remains4.3.2; the Swagger nested
YAML path and obsolete OTLP/protobuf override were corrected. Native SQLite was
rebuilt for hostNode22.23.2/ABI127. These are dated advisory results, not a complete
security certificate. See [dependency scope and evidence](pricing-dependency-review.md).

Twenty-two targeted runtime/security/shutdown/pool tests pass, as do backend build,
frontend contracts/build and unchanged bundle gates. Seven new security tests use
small bounded inputs; no denial-of-service load is sent to production. The real
updated telemetry SDK passes104mockJSON/SSErequests with exact accounting and
shutdown. Real-browser unsaved-edit cancellation/confirmation, report navigation,
history restoration and narrow dark layout pass without pricing/budget mutation
or supplier requests; the fixture/browser are stopped. Full regression for the
new dependency locks remains required, as does final-source performance, image,
requirement and candidate/rollback acceptance.

The dependency-update full regression has now completed on the frozen candidate:
**3160unit tests in168suites and351E2E tests in38suites**, zero failures/skips.
Backend/frontend build/lint/contracts/bundle checks, SDK checks, static deployment,
documentation, version and registry validation all pass. Migration001–015checksums
are unchanged. The test PostgreSQL is stopped and protected production identity
and hashes match. This supersedes the pending-full-run note for this checkpoint.

The continuing original-requirement audit also identified an implementation gap
rather than a reason to declare completion: METER-01 names Realtime session time
and reported audio/text usage, while the current Realtime proxy has no unified
pricing/settlement integration. Chat raw usage also does not yet extract the media
path's modality partitions. The metering registry correctly refuses unsupported
publication today; those safety checks are not proof that the requested metering
workflows are complete. These paths require actual normalization, frozen-price,
accounting/recovery and UI/API evidence before full acceptance. They are not
silently removed from the Goal because other tests pass.


## 2026-09-28 raw Chat modality integration — full regression pending

The shared raw Chat adapter now extracts explicitly reported text/audio/image
prompt tokens and text/audio completion tokens before response conversion. It
validates prompt/cache conservation, retains exact strings and unknown attribution,
and does not infer text or duplicate parent/reasoning fees. Newly documented
nested cache-write counters are recognized. Media and Chat now share the same
modality conservation helper. Adapter identities advance to raw version3 and
media version2; historical receipts are unchanged.

Metering review version2 exposes conditional Chat-route capability with a new
seven-language cache/evidence/reservation warning. It does not advertise Chat
completion image tokens or native Responses/Messages/Gemini modality extraction.
See [exact fields and limitations](pricing-chat-modality.md). Native Gemini array
metering and Realtime integration remain open original-Goal work, not waived
requirements. Existing compatibility admission can still admit an explicitly
unknown estimate; verified declared-limit admission is required for bounded
budget protection. No policy was silently enabled or changed.

The first targeted checkpoint passed95unit tests in6suites and66E2E tests in5suites,
including six real Chat/Responses/Messages JSON/SSE ingress cases using raw Chat
receipts, positive upper-bound holds, exact settlement and read-only replay.
Backend build/lint and frontend contracts/build/bundle gates pass. A subsequent
schema-isolation regression prevents mixing native/custom totals with Chat
breakdowns; the final full regression must verify that latest change.

Real-browser checks pass14locale/layout cases (seven languages, desktop light and
390px dark), validating five conditional rows, translated warning, disabled then
explicitly enabled confirmation, and cancellation.15screenshots were retained;
Chinese and English desktop/narrow and Thai narrow examples were visually reviewed.
The initial background capture timeout was recovered by foregrounding the owned
browser for capture, not changing the UI. All pricing, budget and call-log rows
remain identical; no provider requests were sent. Browser and private UI server
are stopped. Full final-source regression, performance and remaining original
acceptance/image/rollback work are still required. No production2099 changes,
GitHub actions or container cutover occurred.


The frozen raw-Chat integration run passed **3179unit tests in168suites and
361E2E tests in39suites**, zero failures/skips, plus backend/frontend builds,
lint/contracts/bundle limits, SDKs, static deployment, docs, versions and registry
checks. Owned PostgreSQL stopped and the production guard matched.

A final scope review then narrowed the new modality capability list to the three
proven public ingress APIs. `gemini_generate_content` is an upstream schema name,
not a public ingress controller; advertising its unimplemented modality path was
too broad. Only that capability inventory, corresponding backend/frontend tests
and explanatory documentation changed after the full run. A fresh focused run
checks this restrictive delta; the earlier full-suite source identity is retained
separately, not relabeled as a full run of the later source. This checkpoint is
not final fixed-source M0–M6 acceptance.

That final restrictive scope delta now passes96unit tests in6suites and66E2E
tests in5suites on its own frozen source, with backend build/lint and frontend
contracts/build/bundle checks. PostgreSQL is stopped and protected production
identity/hashes match. The full-before-delta and focused-current manifests remain
separate. A final full-source acceptance run is still required after the remaining
native Gemini, Realtime, performance and candidate-delivery work; none is waived.

## 2026-09-28 native Gemini metering — full regression pending

The native GenerateContent adapter now resolves prompt, candidate and thinking
counts using the supplier's actual total relationship, rather than treating
candidate tokens as the full output. It extracts text/audio/image arrays,
subtracts attributable cached modality counts, and preserves exact strings,
unknown quantities and unsupported nonmapped modality partitions. Candidate-only
text is not promoted to all billable text when thinking is nonzero or unknown.
Numeric response/log output counts include known thinking, while the exact
private receipt remains the accounting source. See
[native Gemini scope](pricing-gemini-metering.md).

All three public chat ingress APIs use the native adapter for Gemini upstreams,
including cumulative SSE and explicitly reported failed-attempt usage. Real
operation names now activate Chat/Gemini failure metering too; media attachment
passes its own operation instead of accidentally using the generic Chat default.
The shared cache-modality normalizer has bounded arithmetic and conflict checks.
Malformed or overflowing derived counts are diagnosed, not thrown into a valid
model response. No supplier prices, model limits or protocol aliases are guessed.

Metering review version3 conditionally permits the six modality dimensions on
those three public APIs. Seven-language warnings now explain cache attribution
and candidate/thinking gaps. Native Gemini schema names do not become public
endpoints. Existing v1/v2 reviews and old receipts remain readable and immutable.

The latest targeted source passes **275unit tests in9suites and80E2E tests in6suites**,
zero failures/skips, plus backend build/lint and frontend contracts/build/bundle
limits. It includes six real JSON/SSE ingress variants with exact0.000754USD
receipts,0.00369USD declared-limit reservations, reports and read-only replay;
aggregate thinking, missing/invalid details and failed provider responses also
have dedicated tests. Earlier fixture failures were corrected: an aggregate-only
price does not require a modality warning; a failed request's explicit upstream
expense is preserved separately from its unchanged legacy logical-budget release.
No default budget semantics were silently changed.

Real browser verification passes14locale/layout cases (seven languages, desktop
light and390px dark) with14screenshots. All seven configured dimensions are shown
as conditional, translated warnings appear, and publication remains gated by
explicit confirmation. Tests cancel instead of publishing. Whole pricing,
budget and call-log snapshots remain identical, with0provider requests. Browser
and private UI server are stopped. Chinese desktop/narrow, English narrow and
Thai narrow screenshots were visually reviewed.

A full fixed-source regression is next. Realtime integration, the original
requirement audit (including selectable actual-cost budget-basis coverage),
performance, portable evidence, final image and rollback acceptance remain open.
The existing separate upstream ledger is not a waiver of any original policy
requirement. Production2099, its configuration/data/releases/watchdog and task
model dependencies remain untouched. No GitHub or container cutover occurred.

The complete fixed-source Gemini checkpoint now passes **3214unit tests in169suites
and375E2E tests in40suites**, zero failures and zero skipped tests. Backend/frontend
builds, lint, contracts and unchanged bundle limits pass; SDK tests/types, static
Kubernetes/Helm, documentation, version consistency and provider-registry checks
also pass. Migration001–015checksums and both dependency lockfiles are unchanged.
Private PostgreSQL stopped and protected production identity/configuration hashes
match. Only this progress record is appended after the frozen run; no runtime
code is changed afterward. This supersedes the pending-full-run note above, not
the remaining Realtime, policy-scope audit, performance or final-delivery gates.

## 2026-09-28 native Realtime pricing — full regression pending

Realtime now captures one catalog revision before connecting to the supplier,
reserves a bounded session allowance and records native `response.created` /
`response.done` usage per response ID. Identical terminal events do not duplicate
fees; conflicting events are archived for review. Exact input/cache/modality
normalization reuses the shared contracts. A separate monotonic session-duration
receipt has zero model-response count and zero response-token quantities. Session
and token fees require explicit combined configuration; no supplier duration or
voice price is guessed. See [Realtime contract and limits](pricing-realtime.md).

The actual WebSocket bridge attaches accounting before supplier messages can
arrive, marks dispatched/unacknowledged input, bounds metering queues and client
fragment assembly, and drains close-time accounting before database shutdown.
Strict admission rejects with a structured HTTP error before upgrading when its
caps are missing. Native response times are observation-based and estimated for
calendar rules. A session failure, missing response, unacknowledged dispatch or
conflict keeps the allowance for review rather than manufacturing zero cost.
Durable intents reuse existing recovery; no recovery path redispatches a model.

Versioned policy adds `realtime_max_responses` (1–999); strict admission and its
simulator require the response limit, per-response quantity limits, session cap
and matching envelope multiplicity. The allowance is intentionally conservative
and conditional, not an unconditional supplier spend guarantee. Existing HTTP
legacy budgets are unchanged. Realtime cost accounting activates only with an
explicit relevant binding. Other Live/transcription/delegation protocols are not
silently included.

The latest focused run passes **52unit tests in6suites and54E2E tests in5suites**,
including actual loopback WebSocket forwarding/admission/closure and independent
SQLite/PostgreSQL concurrency, exact settlement, cold snapshot restoration and
crash-orphan retention. Backend build/lint and frontend contracts/build/bundle
limits pass. Initial test failures were an incorrect repository helper name and
an obsolete unsupported-Realtime fixture; both were corrected and rerun, not
skipped. Migration001–015 and installed dependency locks remain unchanged.

Seven-language browser verification passes28publication/policy/layout cases with
28screenshots, plus a separately inspected narrow response-limit closeup. The
new response limit reads back as2, can be edited and restored, and publication
remains confirmation-gated. Session-rate editing is visible under the existing
media tab. All pricing, budget and call-log rows remain unchanged; no supplier
calls occur. Both private UI fixtures and browsers are stopped. Full fixed-source
regression follows; original requirement/cost-basis audit, performance, final
image/candidate and rollback gates still remain. Production2099 is untouched;
no commit, push, merge, deployment or restart occurred.

Realtime checkpoint regression now passes **3230unit tests in171suites and384E2E
tests in41suites**, with zero failed or skipped tests in the accepted results.
The first full E2E run exposed one obsolete fixture expecting Realtime policy
preview rejection. It was changed to assert rejection of an unimplemented Live
operation and acceptance of Realtime. Only that E2E test file changed between
the completed full unit run and the successful full E2E rerun; all application,
frontend, dependency and unit-test sources were byte-identical. The two source
manifests and the original failed result remain separate, not relabeled as one
single-source full run. Final candidate acceptance still requires its own fixed
source after remaining work.

Backend/frontend builds, lint, contracts and unchanged bundle limits, SDKs,
static Helm/Kubernetes, docs, version consistency and provider registry checks
pass on the corrected fixture source. Private PostgreSQL stopped and production
identity/configuration hashes match. No pricing migrations or dependency locks
changed. This supersedes the pending-full-run note without claiming completion
of the original101requirement audit, performance or candidate/rollback gates.

## 2026-09-28 Realtime boundary audit — fixes and actual-main proof

The requirement audit found concrete lifecycle gaps rather than assuming green
base-path tests proved every boundary. Session seconds were captured after the
accounting queue drained; a bare TCP close was classified as clean; and delayed
or duplicate creation events could acknowledge later client work. These are now
fixed: transport close freezes elapsed time and its timestamp synchronously,
events capture their timestamp and client-input sequence before queueing, duplicate
creation reports cannot clear new work, and an unframed TCP close remains uncertain.
Per-response calendar replay also preserves the observed-clock estimate status.

The unknown session witness now marks response count as missing as well as tokens.
A request-count-only tariff therefore cannot display free cost while unacknowledged
work remains. New session-clock receipts use adapter version2; historical receipts
are not changed. Pending handshakes and close-time accounting are bounded by the
connection-work limit, preventing rapid socket closure from admitting unbounded
pending accounting. No HTTP legacy-budget or production policy changed.

The latest focused verification passes **57unit tests in6suites and60E2E tests in5suites**,
zero failures/skips, plus backend build/lint and frontend tests/build/unchanged
bundle gates. Tests exercise delayed drain with a frozen2second duration, all
three stale-creation orderings, request-count-only unknown cost, estimated-clock
calendar replay, and transport/work-capacity boundaries.

Three actual `dist/main.js` scenarios pass using a byte-identical staged build,
private loopback supplier and on-disk WAL/FULL SQLite: active priced session during
SIGTERM, abrupt TCP client loss, and incomplete upstream handshake during SIGTERM.
All candidate processes exit0 within the configured deadline. Completed response
fees are retained exactly once; uncertain session witnesses and allowances remain
for review. Each run also verifies `/live`, `/ready`, Dashboard HTTP200 and invalid
Realtime-key HTTP401, with no supplier connection on invalid authentication.
All1320copied compiled/UI files match the isolated build. No pricing code, database
or lifecycle method is mocked in these entrypoint checks; the egress guard only
blocks non-fixture destinations.

Earlier harness attempts are retained as failed evidence: one omitted a required
node endpoint, another compared stored zero against a display scale, and a static
page probe exposed Express's dot-directory path restriction. Only the harness was
corrected: stage the unchanged build outside dot-prefixed paths, never loosen the
application's dotfile policy. The final three-scenario run includes all probes.
All task-owned servers/processes are stopped and protected production hashes match.

The private audit now records20examined requirement families with exact scoped
findings and sources, and81explicitly not-yet-reviewed families from the original
101IDs. Many examined entries remain partial. It is not a completion certificate:
all subclauses, commands, artifacts and final-source gates still require evidence.
HTTPperformance remains unmet with no waiver, and finalcandidate/rollback delivery
is still pending. Full fixed-source regression of these boundary fixes follows.

The boundary-fix full regression now passes **3235unit tests in171suites and390E2E
tests in41suites**, zero failures/skips, on one frozen source. Backend/frontend
builds, lint, contracts, unchanged bundle gates, SDKs, static Helm/Kubernetes,
docs, version consistency and provider registry validation all pass. Private
PostgreSQL stopped; fixed-source and production guards matched. Only this progress
record is appended after the run. The actual-main staging checks are independent
runtime evidence, not performance comparisons or final image approval. The
original requirement audit and quantified performance/final-delivery gaps remain
open; there has been no production restart, GitHub action or deployment.

The post-boundary actual-main SQLite comparison is now complete:16processes and
9600requests including warmup, zero request errors, complete logs/budgets,4800exact
candidate receipts and16exact balances, with orderly shutdown in every case.
Both50msupstream scenarios still miss the performance limits: JSON adds23.062ms
p95 with21.155%lower throughput; SSE adds10.789ms with7.173%lower throughput.
The two zero-delay cases pass. Full results and methodology are recorded in the
performance document; no partial or passing subset is treated as full acceptance.
The baseline keeps its original dependencies while the candidate uses the audited
updates. Test listeners are closed and the production guard still matches.

The local-first deployment preference remains Rancher Desktop Moby with the same
host2099address, keys and API paths. The rollout document now distinguishes the
older image's dependency findings from the later clean candidate-lock audits and
requires upstream/local-dependency connectivity checks from inside the container.
No image was rebuilt, no container or supervisor was changed, and no deployment
was authorized by this planning clarification. Application/test/dependency source
is unchanged since the last full regression; only these progress/rollout records
changed after the completed benchmark. The full original Goal remains active.

## 2026-09-28 delivery boundary optimization and exact HTTP amount audit

Runtime receipt/intent delivery and its acknowledgement now commit atomically
after independent durable retention. SQLite/PostgreSQL fault tests prove that an
acknowledgement failure preserves the retained body while rolling back delivery,
and a fresh service replays it exactly once. Mismatched acknowledgement amounts,
requests and reservations are rejected. SQLite now yields one event-loop turn
after retention has committed and its access fence has been released, rather than
holding a transaction while yielding. No budget policy or durability setting changed.

Focused verification passes403unit tests in7suites and73E2E tests in6suites,
zero failures/skips, plus build/lint/docs. Initial TypeScript errors in the new
nullable-reservation guard and test fixture were fixed; the failed result is
retained rather than relabeled. New exact HTTP scenarios cover CALC-01 through
CALC-04, including both272000/272001boundaries and native Messages cache TTLs.
Each compares the management quote, the actual mocked-provider receipt, logs and
committed budget under the same published version. Quote calls do not change
budgets or dispatch a supplier request. These are backend cross-layer proofs,
not yet exact-case browser proofs.

The new completed9600request SQLite comparison meets both limits for JSON0ms,
SSE0ms and JSON50ms. JSON50ms now adds4.556ms p95 with3.908%lower throughput.
SSE50ms still adds13.213ms p95, so the full performance gate is not passed.
All correctness/exact-accounting/shutdown checks pass. Rejected exploratory
scheduling overrides are not part of the accepted comparison or application.

The original requirement audit now has24examined families and77not yet reviewed;
the four new numeric entries remain partial because exact-case frontend evidence
is still required. The goal has not been reduced to the passing tests or three
passing performance scenarios. Full fixed-source regression follows; PostgreSQL
comparison, remaining requirement audit, final image/candidate and database-aware
rollback delivery are still pending. Production2099 remains untouched, with no
commit, push, merge, restart or deployment.

This delivery/scheduling checkpoint now passes the complete frozen-source
regression: **3247unit tests in171suites and394E2E tests in41suites**, with zero
failed or skipped tests. Backend/frontend builds, lint, contracts and unchanged
bundle limits, SDKs, static Kubernetes/Helm, docs, version consistency and provider
registry validation all pass. The owned PostgreSQL server stopped, and source and
production guards matched.

The current compiled application also passes all three actual-main Realtime
scenarios again: active-session shutdown, abrupt client loss and pending upstream
handshake shutdown. Exact known fees, unresolved allowances, health/readiness,
Dashboard access, invalid-key rejection and orderly exit are retained. This is
fresh runtime evidence for the updated ledger, not a reuse of the older binary's
proof. Only this progress record changes after the full run. The delayed SSE
performance gate and the other original acceptance/delivery work remain open;
no production restart or deployment has occurred.

## 2026-09-28 CALC-01–04 real frontend numeric acceptance

The first four numeric requirements now have matching core, management-quote,
isolated-request settlement and actual frontend evidence. The five scenarios
include both sides of the272000/272001boundary:

| Scenario | Exact synthetic USD amount |
| --- | ---: |
| Ordinary1000input and500output | 0.002 |
| Mixed cache reads and5minute/1hour writes | 0.00715 |
| Input272000 with1000output | 0.274 |
| Input272001 with1000output | 0.547002 |
| Cached-inclusive300000input and10000output | 0.126 |

All five were entered and simulated in all seven languages, in desktop-light and
narrow-dark layouts:70browser cases and140quote responses. Both the current-content
preview and explicitly pinned published version match the same independently
calculated decimal result and actual request receipt. Spanish decimal-comma display
retains the exact digits. Each request body, quantity partition, selected rule,
line-item sum and published-version identity was checked.

The first screenshot method attempted to capture a tall panel inside an internal
scroll container and produced clipped blank regions. Those images were not accepted
as visual proof. The entire matrix was rerun in a fresh fixture: scroll each result
amount into the real viewport, verify its bounds and hit-test visibility, then take
current/published viewport screenshots. All140amount regions contain rendered pixels;
eight screenshots spanning all seven languages were visually inspected. Internal
table scrolling remains available without whole-page horizontal overflow. External
font CSS was deliberately blocked, so this checks available system-font fallbacks,
not external font delivery.

Pricing, budget, call-log and route-decision rows are identical before and after
the browser runs. In the accepted fixture, the five mocked supplier setup calls
remain exactly five; simulation itself makes no supplier call. Their independently checked totals are
0.956152USD and867501logical budget tokens. Both fixtures and the private browser
are stopped; production identity/configuration guards still match.

Application, test, dependency and compiled frontend source did not change for this
acceptance work. The latest full regression remains3247unit and394E2E tests; it was
not rerun merely to recount unchanged code. The requirement audit now has29examined
families and72not yet reviewed. CALC-05–09 still need full cross-layer tier/calendar
evidence despite their existing core tests. Delayed-SSE/PostgreSQL comparative
performance, the remaining original requirements and final candidate/rollback
delivery remain open. No production restart, deployment or GitHub action occurred.

## 2026-09-28 CALC-05–09 service-tier and calendar acceptance

New shared synthetic fixtures cover absolute service-tier rates, requested
Priority with resolved Default, unpriced Priority versus explicitly free Priority,
all four half-open peak boundaries, weekday/weekend/holiday/date overrides,
overnight carry and both daylight-saving transitions. Eighteen cases now pass
management quote, real isolated model-ingress settlement and read-only replay in
both JSON and SSE:36HTTP scenarios. Each verifies the pinned price version,
requested/resolved tier, selected rule and immutable calendar/timezone evidence.

Dispatch/completion timestamp construction now reads `Date.now()` before creating
its ISO timestamp. This keeps normal wall-clock behavior and permits isolated
event-time control without replacing the `Date` constructor. An initial test-only
constructor replacement was rejected because it broke TypeORM's reflected type
identity during startup. That failed harness was stopped; the accepted helper
replaces only `Date.now` in its own process and restores it. Host clocks, real
timers, production and database driver/type metadata were not changed.
Focused core/adapter verification passes96unit tests in5suites, plus build/lint.

The real Dashboard matrix passes252cases:18scenarios across seven languages and
desktop-light/narrow-dark layouts. Its504current-content/published-version quote
responses match the actual settled receipt or explicit unknown status. The browser
was configured to `Pacific/Honolulu`, while calendars use `Asia/Shanghai` and
`America/New_York`; the entered offset-bearing instants, matched civil times and
fees remain correct. Both repeated01:30instants retain distinct UTC instants and
offsets. Spring-forward does not manufacture the skipped hour.

There are504viewport screenshots with the amounts scrolled into view, hit-tested
and checked for rendered pixels; eight samples spanning all seven languages were
visually inspected. Expanded selection details expose the matched civil date/time,
calendar zone/tag and requested/resolved service tier. Unknown price shows a dash
and an unpriced diagnostic, not zero; explicit zero remains labeled free. External
font CSS was blocked, retaining the earlier system-fallback-font test boundary.

All pricing, budget, call-log and route-decision rows are unchanged by the browser
matrix. The accepted fixture has18mocked supplier setup calls and no additional
supplier calls from simulation. Seventeen known request amounts sum to0.059USD;
the remaining request is unknown, so this is not a confirmed total for all18.
Independent decimal and timezone checks match the retained evidence. The fixture
and browser are closed; production guards match. Full fixed-source regression of
the timestamp-read change follows. CALC-05–09 now have scoped cross-layer evidence,
but the full original requirement audit, performance and final delivery gates are
not complete. No deployment or restart is authorized by these results.

The first full unit run passes3266tests in172suites. Its subsequent E2E run
found one existing correction fixture assuming three independent HTTP requests
must enter the same60msbatch window. Under load the first physical batch contained
two members, so returning two correction targets was valid. The original
429passed/1failed result is retained as a failed full run.

The correction fixture now uses a bounded admission-alignment gate before the
original enqueue method and asserts one physical dispatch with three members
before testing three-member correction. It does not change the real batching
window, original async contexts, price calculations or persistence. A new case
lets the real window flush two members before sending a third request, verifies
separate physical dispatches and limits correction to the original two. Both
complete affected E2E suites pass65tests with zero skips. The initial filtered
diagnostic run is not counted as a complete acceptance run.

Only that E2E test file and this progress record changed after the successful full
unit run; application, dependency, frontend and unit-test sources remain identical.
The full E2E suite and remaining gates are being rerun with a separately recorded
source manifest. These two manifests will not be presented as one frozen-source
full run. The final candidate still needs its own complete acceptance after all
remaining original work is finished.

The complete E2E rerun now passes **431tests in42suites**, with zero failures or
skips. Together with the earlier **3266unit tests in172suites** on identical
application/dependency/frontend/unit sources, this verifies the checkpoint while
retaining both source manifests and the original failed E2E result. Backend and
frontend builds, lint, contracts and unchanged bundle limits, SDKs, static
Kubernetes/Helm, docs, version consistency and provider registry checks pass.

The current compiled application also passes active Realtime shutdown, abrupt
client loss and pending-handshake shutdown again, including health/readiness,
Dashboard and invalid-key probes, retained exact fees/allowances and normal exit.
The owned PostgreSQL server and all test listeners are stopped; production guards
match. Only this progress record changes after the accepted rerun.

The audit has32examined requirement families and69not yet reviewed, not32completed
families. CALC-05–09 now have the scoped cross-layer evidence described above;
CALC-10–12 still need exact media simulator/quote/settlement pairing. Inspection
also confirms that an administrator-selectable actual-upstream HTTP budget basis
is not implemented yet; preserving the legacy default does not waive that opt-in
requirement. These gaps, delayed-SSE/PostgreSQL comparative performance and final
candidate/image/rollback delivery remain open. No production restart, deployment
or GitHub action occurred.

## 2026-09-28 actual-upstream budget decision foundation

The missing budget-basis work now has an internal pure decision model and a
read-only ledger comparison. It sums known provider attempts including failures,
keeps local-cache zero separate from logical tokens, counts conserved physical
batch shares only once, and waits for missing evidence or dispatch finality.
Corrections compare complete cohorts and frozen price/FX identity; a changed failed
attempt cannot replace the entire successful request budget. Exact integer token
and decimal-money checks also apply to aggregates.

The internal reader uses request-first storage fencing, scoped original receipts
and verified adjustment chains. Original token holds remain authoritative even
after current rules change. It checks row/byte bounds before full receipt hydration.
SQLite/PostgreSQL tests verify fresh-service reconstruction, failed-attempt
correction, scope/corruption rejection and unchanged database rows. A new adversarial
case caught fractional token rounding in the first implementation; it now rejects
fractional counters explicitly. Failed intermediate test results are retained.

This is **not yet the administrator-selectable policy**. No catalog parser, runtime
settlement, recovery workflow or frontend switch activates it; existing behavior is
unchanged. The [planning contract](pricing-actual-budget-planning.md) identifies the
remaining opt-in policy, full-path settlement/recovery and UI work. The Goal remains
active, including those requirements; a tested calculator or read-only comparison
does not substitute for the requested switch.

## 2026-09-28 admission clock rollback investigation and recovery

The actual-budget foundation's full run passed3309unit tests in174suites, then
failed one of431E2E tests. The failure was an admission chronology rejection,
not the older correction fixture's two-versus-three batch-window assumption.
The raw failed full run is retained; its chained build/frontend/main checks did
not execute and are not credited as passing.

A read-only system log query found a successful52.490830millisecond backward
clock adjustment at the same second as the original errors. Three instrumented
fresh-harness runs of the preceding conditions/media/batch suites passed79tests
each without naturally reproducing it. A synthetic rollback reproduced the
chronology failure. The original run did not capture exact admission timestamps,
so its precise skew is not invented.

The [clock-recovery implementation](pricing-clock-recovery.md) waits outside both
the database transaction and SQLite serialization fence, with one bounded
monotonic deadline, then rechecks idempotency and the current catalog head.
It never clamps observed admission time, changes historical revisions or weakens
the existing chronology/checksum guard. Excessive/persistent skew is a structured
503 rather than a generic500 or a paid retry.

The first new fixture replaced the global Date constructor and unintentionally
broke TypeORM date-column hydration in repeated authentication. A private exception
trace identified that separate fixture artifact. Tests now inject only the
admission-time reader and leave native Date identity unchanged. All original
allocation-failure assertions remain intact. The new clock test checks every
original wire input exactly once rather than requiring time-shifted admissions to
occupy one batching window.

Focused verification passes122unit tests in5suites and81E2E tests in3suites,
without skips, plus backend build, lint and docs checks. SQLite and PostgreSQL
coverage proves concurrent publication is not blocked during the wait, a concurrent
idempotent winner is restored, excessive skew does not create a request snapshot,
and history remains unchanged and tamper-checked. The owned PostgreSQL instance is
stopped and source/production guards match. A new fixed-source full regression
follows; the Goal remains active and not ready for deployment. Actual-upstream
policy activation and the other original acceptance/performance/delivery gaps
remain required.

The clock-fix checkpoint now passes one fixed-source full run: **3325unit tests in
175suites and433E2E tests in42suites**, with no failures or skips. The original
failed full run and the intermediate fixture failures remain retained separately.
Backend build/lint, frontend tests/build and unchanged bundle budgets, docs,
TypeScript/Python SDKs, static Kubernetes/Helm validation, version consistency and
provider-registry checks all pass on that same source manifest.

The freshly compiled actual application entrypoint also passes active Realtime
shutdown, abrupt-client disconnect and pending-upstream-handshake shutdown, with
health/readiness, Dashboard and invalid-key probes, retained exact fees and
allowances, delivered outcomes and normal exits. All owned test listeners and the
isolated PostgreSQL server are stopped; source and production guards match.
Only this progress appendix changes after those tests. This is a verified
development checkpoint, not completion of the full Goal: budget-policy activation,
the remaining requirement audit, media exact-case UI evidence, performance targets
and final candidate/image/rollback delivery are still outstanding.

## Actual-upstream text settlement integration — still incomplete

The planner is now connected to an explicit immutable budget-basis policy and
real text-request settlement, rather than only a read-only comparison. Absent
`budget_basis` remains legacy. The initial connected operations are the existing
Chat Completions, Responses and Messages ingress paths, including native Gemini
suppliers behind those paths. Unsupported/broad actual-policy selections are
temporarily rejected; this is not a reduction of the final Goal's scope.

Migration016 adds closed-cohort persistence while preserving every001–015
checksum. Runtime closure prevents further attempts, drains tracked in-flight
work, retains the complete attempt identity/receipt set in the durable inbox and
applies known supplier expense atomically with the mandatory delivery acknowledgement.
Paid failed attempts and retries are included even when the client receives an
error. Cache hits preserve logical response usage but consume no supplier budget.
Unknown or missing evidence retains holds; late original receipts and retained
closures can be replayed by a fresh service without a second supplier call.

Snapshot policy, complete cohort membership, receipt/plan hashes, intent amounts
and original scopes are rechecked inside writes. Conflicting pending cohorts are
quarantined without blocking other requests, and pending scans rotate unresolved
records. The existing admission dialog preserves an explicit basis during other
edits, but there is no new seven-language selector yet. The legacy logical-winner
correction/recovery path explicitly refuses actual reservations until aggregate
handling is implemented, rather than silently applying the wrong budget basis.

The broad scoped run passes **400unit tests in9suites and96E2E tests in6suites**,
without skips, plus backend/frontend build/tests, unchanged bundle limits, lint
and docs. SQLite/PostgreSQL mutation tests cover exact/idempotent cohort settlement,
late evidence, acknowledgement rollback, scope/membership rejection, rehashed
policy/plan tampering and recovery isolation. HTTP tests cover legacy preservation,
opt-in paid retries, all-paid failures, SSE, Responses/Messages, native Gemini,
cache zero, policy changes in flight and retained-body replay.

Failed intermediate evidence is retained: migration expectations initially omitted
the new table, and one new test incorrectly assumed a public Gemini ingress existed.
The corrected supplier test uses the existing route and adapter, not a new API.
The owned PostgreSQL server is stopped and source/production guards match. Full
current-source regression follows. Actual batch/media/correction/operator recovery,
Realtime policy audit, complete configuration UI, remaining original audit and
performance/candidate/image/rollback work are still required. Nothing was deployed,
committed, pushed or restarted in production.

## Complete migration markers and closed-cohort expense corrections

The text prototype's first full unit run passed3342tests and failed two existing
partial-schema report cases. Adding016 exposed a real latest-marker-only readiness
gap: a missing015 marker was accepted while016 remained. The failed full run is
retained, and its chained E2E/build/main checks did not execute. A bounded shared
readiness check now validates the complete known marker/checksum set and rejects
unknown future markers. An empty unmigrated database still uses legacy behavior;
an incomplete installed chain is rejected before priced dispatch instead of being
silently reclassified. SQLite/PostgreSQL report tests and real HTTP no-dispatch
coverage pass. The ledger also shares the injected pricing repository when
available rather than duplicating its immutable catalog cache.

[Actual expense corrections](pricing-actual-budget-adjustments.md) now reconstruct
the complete budget-accepted cohort from its immutable initial contribution hashes
and each attempt's latest applied adjustment. This uses existing records rather
than introducing migration017. Confirmed changes to failed and successful attempts
produce independent exact deltas, with whole-cohort conservation checked before
application. Estimates remain pending; a confirmed change to another attempt can
still be applied against the accepted evidence without promoting that estimate.

Corrections received before the first debit are anchored by the initial plan and
are not counted twice as unresolved budget changes afterward. Original attempts,
closure and initial intent remain unchanged; closure replay does not reverse or
repeat a valid later adjustment. Audit failures roll back their deltas, and refunds
retain the original budget epoch. The administrator API preserves estimated
attestation provenance, previews without writes, and rejects stale approval when
another cohort member changes. Its CAS hash is stable across independent history
row order. The original target operation is retained during correction quoting.

The latest focused run passes **448unit tests in10suites and99E2E tests in6suites**,
with no skips, plus backend/frontend builds, frontend contracts and unchanged
bundle budgets, lint and docs. Owned PostgreSQL is stopped and source/production
guards match. A moved helper's initial TypeScript narrowing failure remains in
the diagnostic record; the runtime checks were preserved when fixing the helper.
Full current-source regression follows. Operator budget resolution, actual
batch/media lifecycles, Realtime audit, the complete seven-language selector,
remaining original acceptance/performance work and final candidate/image/rollback
delivery are still required. No production restart or deployment is authorized.

The text-adjustment checkpoint now passes one fixed-source full run: **3364unit
tests in176suites and448E2E tests in43suites**, with zero skips or failures.
Backend/frontend builds and contracts, unchanged bundle budgets, lint, docs, SDKs,
static deployment validation, version checks and provider registry checks pass.
The freshly compiled actual entrypoint also passes all three retained Realtime
shutdown/disconnect scenarios. Owned PostgreSQL/test listeners are stopped and
source/production guards match. Only this progress appendix changes afterward.

This is still not final Goal readiness. Further inspection identified an untested
edge: compatibility admission with no published bindings can return before honoring
an explicit actual budget basis. That case needs regression coverage and correction,
not a claim that full regression already proves every requirement. Actual operator
budget resolution, batch/media/Realtime integration, complete seven-language UI,
remaining requirement audit, performance and final delivery gates remain open.

The no-approved-binding edge is now corrected. A controlled HTTP test first
reproduced the ignored explicit actual policy (zero reservations), while the
legacy contrast retained its15-to30 logical cache-token behavior. Compatibility
bypass now excludes explicit actual mode. With no approved bindings, provider
expense remains pending/unknown rather than becoming a logical debit; cache hits
consume no supplier budget and preserve response usage. The complete affected
scoped run passes448unit/101E2E tests with zero skips, plus backend/frontend build,
contracts, unchanged bundle budgets, lint and docs. The earlier full checkpoint
and this later source manifest remain separate; no same-source full claim is made.
Operator budget resolution and the other original remaining requirements are
still open. Production2099, configuration, database, runtime and watchdog remain
untouched by this work.

## Independent Realtime ASR checkpoint — original Goal still incomplete

Realtime input transcription now has an explicit fixed-model declaration,
separately published audio-transcription price, independent actual-expense
reservation and token/duration receipts. The same immutable assessment is used
by admission and the simulator. Realtime token exemptions do not remove ASR
token holds. Two earlier-source HTTP regressions reproduced premature audio
release by a creation acknowledgement and a swallowed ASR stop decision; those
failures remain retained separately from the passing evidence.

The transport now waits for every pending configuration update, deduplicates
acknowledgements, counts sent manual commits before their item receipts, and
propagates conflicting evidence to the connection's stop path. Clearing buffered
audio does not cancel previously sent commits. Known costs remain available when
closure is uncertain. A subsequent guard also rejects a configuration without a
native acknowledgement identity; its new negative case is included in the next
current-source full regression, not retroactively attributed to the earlier run.

The preceding fixed-source scoped run passes **98 unit tests in 7 suites and
88 E2E tests in 4 suites**, without skips or failures, plus backend/frontend
builds, child-helper type checks, frontend contracts, unchanged bundle budgets,
lint and docs. Sixteen actual child-exit cases cover token and duration ASR on
SQLite and PostgreSQL at receipt retention, closure retention, settlement and
missing usage. Fresh-connection recovery, acknowledgement rollback, mixed token
scopes and confirmed original-tariff/epoch corrections are also verified. Native
WebSocket cases prove audio stays queued through duplicate/older acknowledgements,
a mismatched model receives no audio, and a conflicting receipt closes the bridge.

Browser evidence covers seven locales, two layouts each and 28 screenshots.
Editors validate complete declarations, reject invalid limits and invalidate stale
approval; the exact separate and combined synthetic reservations are visible.
All read-only editor/preview flows leave pricing tables, budgets and call logs
identical. Three actual save/remove/restore operations change only the catalog
head and append three immutable revisions and audit records. No provider calls
occur, all owned browser/server resources stop, and source/production checks match.
The initial browser probe used an unsupported accessible-name lookup for a native
definition term; the visible amounts were present. It was corrected to use the
observed term text and associated definition, without changing application code
or weakening the amount/visibility assertions.

The current backend source still requires full regression. This is not final
ASR or M0–M6 completion: broader audio modes, complete late-conflict operator
reconciliation, FX/calendar boundaries, other original requirement families,
whole-configuration migration, the unmet latency target and final candidate,
Rancher image and rollback rehearsal remain open. Nothing was committed, pushed,
deployed or restarted in production.

The independent-ASR checkpoint subsequently passed a full fixed-source run:
**3590 unit tests in 182 suites and 623 E2E tests in 48 suites**, plus all build,
lint, frontend, SDK, documentation and static deployment checks. Review during
that run identified another case not covered by those tests: the new ASR stop
branch could skip a known Realtime response already waiting in the receipt queue.
A new regression reproduced the missing known expense (synthetic subtotal
`0.031` instead of `0.131`). That failed evidence is retained.

The fix propagates the stop decision without bypassing already-observed response
persistence. Both a delayed accounting/close test and a real WebSocket burst with
conflicting ASR and duplicate Realtime receipts now preserve the `0.131` known
subtotal while retaining unresolved holds. The corrected source passes
**98 unit tests in 7 suites and 91 E2E tests in 4 suites**, builds, child types,
frontend contracts and bundle limits, lint and docs. The earlier full result is
not relabeled as full acceptance of this later fix; current-source entrypoint
checks and full regression still follow. All production protections remain.

The freshly compiled application also passes twelve isolated Realtime entrypoint
scenarios: four independent-ASR cases, four automatic-audio custody cases and
four actual-budget shutdown/disconnect/handshake cases. Each checks liveness,
readiness, Dashboard access, invalid-key refusal, exact retained receipts and
normal process exit. Owned ports and processes are stopped; production guards
match. This does not close the remaining Goal or authorize deployment.

## Whole legacy configuration import — scoped implementation

A new offline `pricing-import --config FILE` command and the existing import
validation API now produce a pricing-only proposal for the entire supplied
configuration. Explicit node overrides, gateway-model inheritance, model and
upstream aliases, hidden capability prices and supplied catalog fallback are
kept distinct. Runtime and importer share the unchanged legacy cache-inference
formula; new published tariffs do not inherit its name-based inference.

The report retains decimal values, sanitized source/confidence metadata and
explicit currency mismatches. Media references remain unverified, and unresolved
external catalogs are not replaced with ambient prices. YAML anchors/merges are
handled without secret expansion or executable tags. Inputs are bounded; no file,
database, active price, historical amount or production configuration is written.
The API uses the same pure planner and returns no running gateway configuration.

The first complete scoped run passes74unit tests in7suites and40E2E tests in3suites,
plus backend/frontend builds, contracts, unchanged bundle budgets, lint and docs.
HTTP checks match the real isolated configuration resolver, retain the expected
legacy draft quote and verify unchanged full pricing/budget/log state and input
bytes. Intermediate failed fixtures are retained: an expected amount initially
assumed exact half-rounding instead of the deployed binary rounding; typed test
objects and the synthetic node's required credential were then corrected without
changing production validation. Additional input/privacy cases and documentation
are newer than that checkpoint and require current-source verification.

This closes neither the complete migration/rollback gate nor the original Goal.
The report is a CLI/API review artifact, not automatic publication or a multi-book
Dashboard wizard. Current-source full regression, rule-name metadata, remaining
cross-layer requirements, performance and final portable/image/rollback delivery
remain required. Production2099 has not been modified, restarted or switched.

The subsequent fixed-source scoped run passes77unit/40E2E tests, builds, lint,
frontend contracts and documentation after adding opaque-token redaction,
media-only configuration preservation, invalid UTF-8 and regular-file/size checks.
An actual compiled CLI invocation also succeeds with filesystem writes, database
initialization, network connections, child processes and filesystem watchers
blocked by the isolated harness. Input bytes remain unchanged and no credential
appears in its report. A whitespace-only trailing line and a documentation wording
clarification follow that run; current-source full regression is still required.

That configuration-import source passed a full fixed-source regression with
3623unit tests in185suites and628E2E tests in49suites, plus builds, frontend/SDK
checks and static deployment gates. A subsequent contract review found the new
importer's ASCII-only identifier restriction was narrower than existing gateway
model validation. Four explicit @-prefix/Unicode/version/short-prefix regressions
reproduced it. The importer now preserves these opaque identifiers without
trimming or renaming, while refusing control/prototype/URL/credential identities.

The corrected source passes83unit/40E2E tests, including real isolated runtime
comparison with those names, as well as build/lint/frontend/docs checks. This
later fix is not retroactively covered by the prior full-source result. The
remaining original implementation, performance, migration/rollback and final
candidate requirements still prevent whole-Goal completion or deployment.

## Rule display names — original identity and costs preserved

Rules now have optional bounded display names separate from their stable IDs.
Names survive editor changes, immutable-parent recipes, publication, export,
fork/rollback and selection traces. Historical labels come from the original
receipt, never a current-price lookup. Clearing the field removes only metadata.
Unnamed price, selection and cost hashes remain byte-for-byte compatible, as
verified against pre-change hash fixtures. No earlier migration or stored
document is rewritten.

The latest scoped run passes207unit tests in6suites and37E2E tests in3suites,
including fresh-connection SQLite/PostgreSQL restoration and JSON/SSE publication
while requests are in flight. Backend/frontend builds, lint, frontend contracts
and unchanged bundle limits pass. The first new test omitted the compiler's
required identity argument and failed type checking; the fixture was corrected,
and the failed result remains retained rather than counted as a pass.

Seven-language browser verification covers14desktop/light and narrow/dark cases
and70screenshots: editable and cleared names, native keyboard order, exact
current/published simulations and old/new historical traces. Literal HTML-like
text stays inert. All read-only state is unchanged; three real save/reload/export
operations change only the draft and append three audits. Price versions,
request receipts, budgets and the two original synthetic provider calls remain
unchanged. All owned browser/server resources are stopped.

Current-source full regression and final candidate checks follow. The remaining
original requirements, including performance and populated-database rollback,
are still open. This is not a completed M0–M6 Goal, a release or authorization to
restart the production gateway.

## Model-list pricing status and precise editor navigation

The original model-list gap now has a bounded, read-only, workspace-scoped
endpoint and an expandable seven-language node-list view. Current and scheduled
winners share the actual request selector, including operation-specific scope,
node overrides and expiry to a fallback or no binding. Conditional prices are
not flattened into a misleading token pair. Currency, source, version,
inheritance, review/missing flags, policy and legacy-reference status are explicit.
Missing bindings retain the selected node/model/operation through draft creation
and the publication dialog, without activating any price.

The fixed-source focused run passes93unit tests (including SQLite/PostgreSQL
repository contracts) and15HTTP tests, plus builds, lint, frontend checks, bundle
limits and documentation. Earlier new-test fixture mistakes were corrected;
those failed runs are retained, not counted as passes.

Browser verification covers14desktop/light and narrow/dark cases across all seven
languages, with44screenshots. It verifies keyboard expansion, all-model pagination,
conditional/inherited/scheduled metadata, exact immutable-version navigation and
media-specific draft context. Read-only browsing leaves all pricing, budget and
log rows and configuration bytes unchanged. One explicit synthetic draft creation
adds exactly one book, draft and audit; it preserves the target in the publication
dialog without publishing or contacting a supplier.

The browser exposed a real rapid-navigation issue: a live Outlet inside the
exiting route animation briefly mounted the destination and then remounted it,
discarding a newly opened dialog. The layout now retains the exiting route element
with useOutlet; the same fast interaction passes without adding an artificial
navigation delay. All owned browser and fixture processes are stopped.

Full current-source regression follows this focused evidence. This is not a
whole-Goal completion: remaining original object/lifecycle acceptance, the unmet
HTTP performance gate, final portable/image verification and populated-database
rollback are still required. Production2099 remains unchanged and undeployed.

## Original cache-reference savings gap closed

The model-list full regression completed187suites with3660passing tests and one
PostgreSQL inheritance fixture setup exceeding its5second hook timeout. The
identical source then passed all40inheritance tests in a fresh isolated process
without changing that timeout. The failed full result remains a failure; it is
not relabelled by the diagnostic. Subsequent full validation will use a complete
inventory of serial fresh-process unit batches to bound retained test memory.

The remaining original requirement inventory has now been examined in full;
this is not a count of passing requirements. Inspection found that new-engine
cache logs deliberately leave their legacy reference column null, while the
request page lacked the required independent reference-savings value.

Local-cache summaries now expose a read-only hypothetical reference derived
from the saved logical estimate, validated against the original immutable request
catalog and zero-supplier receipt. The UI separates supplier expense, recorded
budget basis, logical quantities, reference and hypothetical savings. Unknown or
corrupt references stay unknown; explicit zero remains distinct. Neither
current prices nor the legacy floating-point log column supplies this value.

The current focused source passes210unit tests,54HTTP tests, builds, lint and
frontend/bundle checks. Six actual scenarios cover both budget policies with
paid, explicitly free and missing-FX references. Each compares quotes, receipts,
budget, logs and reports, then verifies that a later price publication does not
change the original reference. Seven-language browser proof covers34cases and
40screenshots, including six actual simulator comparisons. All read-only
pricing/budget/log/configuration state remains unchanged, with only the original
six fixture provider calls. All owned browser and fixture processes are stopped.

These focused results do not replace the remaining full-source regression,
CALC/state/lifecycle acceptance, unmet performance target or final portable/image
and populated-database rollback gates. No production2099restart or deployment
has occurred.

## Status classification and future-activation diagnostics checkpoint

Actual HTTP fixtures now compare all eight external cost states with original
quotes, request details, log summaries and cost reports. Expired calendars,
unknown media quality and missing FX remain explicit unknowns; pending video
holds remain separate from supplier charges. This exposed and fixed an
all-missing-usage aggregation bug without changing receipts, money or budgets.

Overlapping future activations now return `pricing_activation_conflict`, rather
than a stale-revision message. Seven-language editor guidance asks the operator
to change the interval or explicitly cancel the conflicting schedule; refreshing
alone is not presented as a solution. The entered draft is retained.

The scoped checkpoint passed316unit and75HTTP tests, builds, lint, frontend
contracts and documentation checks. Browser evidence covers the status matrix
and localized conflict workflow. One browser run's final production guard
detected an external change: its functional results remain valid, but its guard
is recorded as failed, not retroactively passed. On2026-09-29 the user confirmed
editing a model configuration on2099. The original baseline and mismatch evidence
are preserved; subsequent isolated verification uses a separately recorded,
user-confirmed baseline. This confirmation does not authorize deployment or
production writes. Full-source regression and the original remaining performance,
lifecycle, candidate and rollback gates still apply.

## Price-book responsibility and derived lifecycle

The original PRICE-01 owner/state gap now has a dedicated management API and
seven-language UI. New normal and inherited books explicitly assign their creator;
older books remain unassigned until an administrator chooses an owner. This label
does not grant access or send alerts. Metadata edits have independent revisions,
confirmation and transactional audit; concurrent edits cannot silently overwrite
each other. A conflict retains the proposed input and requires fresh review.

Lifecycle is derived at an explicit read time from immutable versions and scoped
binding intervals. Drafts, versions, active bindings and scheduled bindings are
counted separately. An active binding is not a guarantee that routing selects it.
Migration017 adds only a metadata table; migrations001–016 remain unchanged, and
historical creators are not backfilled as responsible owners.

The scoped checkpoint passes174SQLite/PostgreSQL unit tests and24HTTP tests,
backend/frontend builds, lint, frontend contracts and unchanged bundle limits.
Real browser workflows cover seven languages and two layouts, including ordinary
assignment, two-editor conflict and explicit clearing. Across the fixture's
24audited metadata updates, every existing price, catalog, receipt, budget and
configuration record remained unchanged, with only the two original mock supplier
calls. The final production guard matched the separately confirmed baseline and
all owned browser/server/database resources were stopped.

These focused checks do not replace final full-source regression, the remaining
lifecycle/FLOW acceptance, the unmet HTTP performance target, or final candidate,
image and rollback verification. Nothing has been deployed to2099. See
[book management](pricing-book-management.md) for the API and migration contract.

## SQLite comparative performance checkpoint

The long-standing delayed-SSE miss now passes on the reference host in two
balanced, uninstrumented comparisons with identical source. All four JSON/SSE
and0/50ms mock scenarios meet the original5ms/5%targets. The final delayed-SSE
p95deltas are1.014ms and3.612ms; delayed-JSON deltas are4.770ms and4.318ms.

The accepted changes avoid duplicate validation of captured outcome documents,
combine two ownership reads after the same lock, and omit a redundant I/O turn
only for the matching live stream's final decision. Generic JSON and background
recovery behavior remain unchanged. Independent-retention, caller-mutation,
database/audit integrity, pending-versus-final HTTP views and both budget bases
have focused SQLite/PostgreSQL tests. Failed write-coalescing experiments were
preserved and removed from the candidate; no durability setting was relaxed.

Both comparisons passed all19200requests including warmup and immediate shutdown;
9600candidate amounts and32budget balances passed independent decimal checks.
The detailed method, limitations and remaining PostgreSQL/capacity/platform gates
are in [pricing performance](pricing-performance.md). This is not whole-Goal
completion and no2099deployment or restart occurred.

## Additive ownership index and PostgreSQL performance checkpoint

Migration018 adds only a nonunique workspace/reservation/state index;001–017
definitions and checksums are unchanged. CLI planning now reports pending indexes
even when no tables need creating. Integrity checks reject unmarked, malformed or
wrong-schema objects, and index creation rolls back if its marker cannot be saved.
The [migration guide](pricing-index-migrations.md) describes blocking DDL and the
separate production approval/backup boundary.

The current1308-file source passes3754 unit tests and688 HTTP tests, plus builds,
lint, frontend contracts, SDK/configuration/static deployment checks and the
public-file scan. The first full run exposed historical test builders that removed
the new marker but left its index behind; five fixture downgrade loops now handle
index-only additions. The original failures remain recorded and production
integrity checks were not relaxed. A compiled-CLI upgrade on50001 synthetic tasks
preserves all58 non-marker table hashes and original migration records.

The first complete PostgreSQL comparison now has explicit comparator and
post-measurement observation limits. Accounting and separate candidate immediate
shutdown checks pass, but three performance cases miss the original targets. The
largest miss is delayed JSON: added p95 of50.788ms and39.808% lower throughput.
See [the complete results and method](pricing-performance.md); this is not a
performance pass or a whole-Goal completion. PostgreSQL optimization/capacity,
remaining lifecycle/UI mapping and the final image/rollback package remain.
Production2099, its user-edited model configuration and GitHub are unchanged by
this task.

## Budget transaction query optimization

PostgreSQL now locks each selected budget row in global ID order with one query,
retains it through commit and folds that settlement's release/reapply arithmetic
before saving the final counter. It preserves inactive and replaced scopes,
original epochs, exact decimal values, rollback and post-commit notifications.
Ordinary updates leave configuration fields and database timestamp precision
untouched. SQLite's existing calculation path remains in place.

The retained1309-file source passes3772 unit tests and688 HTTP tests, builds,
lint, frontend, SDK/configuration/static-deployment checks and a public-file scan.
A separate JSON-aggregation experiment was removed after performance tradeoffs
failed the full target; its evidence was preserved. Current PostgreSQL throughput
and delayed-JSON targets remain unmet, and the current SQLite comparison has a
delayed-JSON p95 miss of0.668ms beyond the5ms limit. See the latest
[performance checkpoint](pricing-performance.md) for exact methods and results.
This is verified development progress, not final acceptance or deployment.

## PostgreSQL backup/restore and constraint inspection

A real PostgreSQL16.14 custom-archive restore exposed a false schema conflict:
the pinned driver did not preserve composite foreign-key column order during
inspection. The candidate now reads paired catalog keys by ordinality in the
selected schema, without changing migration001–018 definitions or checksums.
Wrong mappings, missing/foreign-schema targets and unvalidated constraints still
fail closed. The failed restoration and deterministic regression failures remain
recorded rather than being relabeled as successful backups.

The corrected native candidate passes three fresh-database restorations. The
latest preserves59 tables,11 sequences, four accepted requests, immutable prices,
key identities and an unknown-cost reserved hold; one new authenticated request
succeeds without repeating the unresolved provider call or overwriting the source.
The original failed targets are also recognized by the fixed read-only CLI with
no schema repair. See [the recovery scope and limitations](pricing-database-recovery.md).

The1313-file implementation checkpoint passes3800 unit tests across193 suites and
688 HTTP tests across55 suites, using serial fresh-process batches, plus builds,
lint, frontend contracts and SDK/configuration/static-deployment checks. This is a
new full run, including the17 health-probe tests and11 foreign-key tests. It does
not add new browser or Linux-image acceptance: the previous Rancher image/bundle
predates this fix. Performance targets and remaining original acceptance/final
delivery work are still open. Production2099 and its user-edited model configuration
were not changed, reloaded or restarted.

## Performance experiment rejected, verified implementation retained

Budget-scope query consolidation passed focused correctness checks and reduced
measured query counts, but did not meet the actual HTTP performance targets.
The complete9600-request comparison and exact-accounting checks were preserved;
three scenarios still missed the original gates. The experimental source and
tests were archived rather than shipped on the strength of a smaller query count.

The earlier implementation was restored by exact hashes, rebuilt and rechecked
with113 focused unit tests and47 HTTP tests. No new runtime change is retained
from this experiment, and the preceding3800/688 full regression is not relabeled
as a new run. See [the measured results](pricing-performance.md). Goal completion,
final-source image acceptance and any2099 deployment remain outstanding.

## Owned PostgreSQL log projection

The PostgreSQL synchronous log path now records metrics from the verified saved
log projection, removing one redundant preliminary summary while retaining the
request lock and receipt/adjustment checks. Snapshot/context guards prevent
unpriced placeholder fallback; failure metrics remain single-attempt, and SQLite
write-behind keeps its preliminary value. Exact ledger amounts and unknown-cost
holds are unchanged. See [the projection contract](pricing-log-projection.md).

The implementation passes3828 unit tests across194 suites and688 HTTP tests across
55 suites, with no failures or skips, plus builds, lint and compatibility checks.
Actual comparisons pass all request/accounting assertions, but PostgreSQL still
misses three performance cases and SQLite delayed JSON misses p95 by0.262ms.
The [complete results](pricing-performance.md) remain explicit; reduced query
counts are not substituted for the original targets. The full Goal remains open,
and the existing Rancher image/bundle must eventually be rebuilt from final source.
No production2099 configuration, process or deployment was changed.

## Transaction-owner precondition

Locked PostgreSQL pricing helpers now explicitly require an active transaction
on their own data source. Existing public writers already satisfy that contract;
tests cover misuse, workspace rejection, parent-before-child locks and fresh
state after concurrent updates or deletion. A separate narrower-read experiment
did not demonstrate performance acceptance and was removed.

The retained implementation passes3847 unit tests and688 HTTP tests, with builds,
lint and compatibility checks. New PostgreSQL/SQLite comparison failures are
preserved in [the performance record](pricing-performance.md), including slower
unchanged controls; no causal explanation or threshold waiver is assumed. The
Goal, final-source image and remaining original acceptance work are not complete.
Production2099 remains untouched.

## Composed logical settlement candidate — scoped verification

Ordinary logical and local-cache accounting now uses an explicit composed delivery
transaction after the independent durable retention commit. Intent, acknowledgement
and budget application commit together; rollback does not erase the first retained
body. Existing queue-only APIs, batch application and actual-expense/task authorities
remain unchanged. Generic inbox delivery still does not imply settled money.

The candidate passes 38 SQLite/PostgreSQL cases covering crashes, partial writes,
commit-acknowledgement loss, immutable retries and review fences. A broader ledger/
recovery selection passed 586 tests on identical runtime source. After correcting
two test-only observer/type issues, all 132 selected HTTP regressions, build and
lint pass. HTTP tests preserve successful responses and verify no extra upstream
call when accounting must recover. These are scoped checks, not a new full run.

The diagnostic SQL/transaction counts fell from 160/12 to 154/11 per request, but
the [complete PostgreSQL and SQLite comparisons](pricing-performance.md) still miss
the original performance gate. All 19,200 comparison requests passed response and
accounting checks; 9,600 candidate amounts and 32 balances passed exact checks.
No slower repetition was removed and no performance exception was accepted.

The experiment remains a development candidate, not final Goal acceptance. Full
regression on this source, remaining original requirements and final-source Rancher
image/bundle verification are still outstanding. The user-edited model configuration,
running2099 process, production database and deployment remain untouched.

## Scheduled activation and Realtime/ASR lifecycle checks

New JSON/SSE tests cross a scheduled tariff activation during a paid primary
failure. The fallback still uses the request's original node contract; the next
request uses the newly effective contract. Both legacy and actual-expense budget
modes agree with their expected fees, stored logs and report output. This extends
the existing immediate-publication/fallback checks without changing runtime
selection or bypassing clock-skew admission protection.

Independent transcription lifecycle tests exposed a missing completion instant on
the synthetic ASR closure witness. A completion-time calendar made that witness
unpriced even when every item fee was computable. The closure now uses the already
captured transport-close timestamp, including when its accounting waits behind
other work. Unknown custody remains unknown. See [the exact semantics and evidence
boundaries](pricing-realtime.md).

The affected selection passes 42 SQLite/PostgreSQL tests and 90 HTTP regressions,
plus build and lint. New fixtures cover both models' tariff and FX changes, original
calendar observations, duplicate delivery, cold replay, removed FX and explicit
estimated-versus-observed budget behavior. Actual-budget guards were not weakened
to make estimated calendar fees settle. These selected counts are not the full
inventory. The subsequent full run separately passes **3,905 unit tests in 196
suites and 704 HTTP tests in 55 suites**, with no failures or skips, using serial
fresh-process batches. Builds, lint, frontend contracts/build, SDKs, configuration,
documentation and static deployment checks pass. Migration001–018 checksums remain
unchanged; the frozen source and production guards match, and owned test servers
have stopped.

No ordinary chat performance optimization is added in this checkpoint. The last
complete performance comparisons remain unmet and predate this Realtime-only fix;
remaining original acceptance, final-source image and candidate delivery are still
open. Production2099, its user-edited model configuration and its deployment have
not been changed.

## Native keyboard verification and focus restoration

Following the completed 3,905-unit/704-HTTP full run, native keyboard testing found
that conditionally removed pricing dialogs left focus on the page body. The shared
dialog cleanup now returns focus to a connected trigger and restores the prior
scroll lock, including controlled-close and nested LIFO cases. A reproducing
browser result and failing automated effect check were retained before the fix.

The corrected UI passes six effect contracts and native checks across all seven
languages in desktop/light and narrow/dark layouts: 28 complete dialog focus cycles,
98 section-tab transitions and 56 screenshots. Browser errors and page overflow
checks are clear; before/after pricing and financial data are identical, and no
supplier requests were made. See [the tested keyboard scope](pricing-dashboard.md).
Frontend tests, build, localization and existing bundle budgets pass.

Only the shared dialog, its frontend regression checks and documentation changed
after the full backend checkpoint. Backend files, tests, SDKs, dependencies and
migration definitions remain byte-identical. The full Goal is not complete:
performance acceptance, remaining original workflow/platform evidence and a
final-source candidate image/bundle are still outstanding. All owned test instances
are stopped; production2099 and the user's model configuration remain untouched.

## Settlement shared-lock interval

Cost projection is now prepared after receipt validation/completion and before
shared budget-row acquisition. The request lock remains held; the same full
receipt/history validation runs; the log is still updated after budget, effect,
intent and recovery writes in the same transaction. Only the subtotal is retained,
not an earlier budget summary. First durable outcome retention stays independent.

Five added cross-database/order/concurrency cases, including a real PostgreSQL
non-waiting budget/request lock probe, join the existing focused accounting tests.
All 591 selected unit tests, 132 HTTP tests, build and lint pass. The probe failed
on the earlier implementation and now verifies that cost projection no longer
holds the shared budget row. Full-source regression remains a separate gate.

Complete PostgreSQL and SQLite comparisons pass all 19,200 request/accounting
checks, with 9,600 exact candidate amounts and 32 balances verified. Nevertheless,
three PostgreSQL cases and the zero-delay SQLite JSON throughput target still fail;
the [full numbers and diagnostic limitations](pricing-performance.md) are retained.
No failure is waived or attributed to an unproven external cause. This is development
progress, not final performance acceptance or permission to deploy.

## Full regression and refreshed Rancher candidate

The early-projection source completes a fresh full run with **3,910 unit tests in
196 suites and 704 HTTP tests in 55 suites**, with no failures or skips. Builds,
lint, frontend contracts/build, SDKs, configuration, documentation and static
deployment checks pass, and migration001–018 checksums remain unchanged.

An earlier full attempt is retained as a failure: one PostgreSQL empty-uninstall/
reinstall case exceeded its unchanged five-second test timeout. The same 38 index
migration cases passed separately without changes. The complete rerun uses a new
isolated PostgreSQL directory, the same test inventory/timeouts and enabled fsync,
synchronous commits and full-page writes. It does not lower durability or erase
the earlier failure; a sole environmental cause is not asserted.

The same 1,320-file source and locked dependencies now build a refreshed Rancher
Desktop Moby Linux/ARM64 image. Actual entrypoint/health, legacy and migrated
requests, JSON/SSE pricing, historical costs and owned process/listener recovery
pass. A new online SQLite backup/restore rehearsal preserves caller keys, recorded
prices and an unresolved hold, then accepts a new request without replaying unknown
supplier work. See [the exact platform scope](pricing-rancher-rollout.md) and
[recovery boundaries](pricing-database-recovery.md).

The image/source archives and dependency/migration manifests are exported with
verified hashes and OCI layer identities. This remains a provisional uncommitted
candidate, **not** `READY_FOR_REVIEW_NOT_DEPLOYED`: original performance and the
remaining workflow/capacity/platform/final-source requirements are still open.
All owned test instances and fixture volumes are stopped or removed. Production
2099, its user-edited model configuration, other Rancher containers and global
Docker settings were not changed. Nothing was pushed or deployed.

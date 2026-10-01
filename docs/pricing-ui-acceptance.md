# Pricing UI acceptance map

Status: **development in progress, not deployed**. This map reconciles the original
[UI and workflow requirements](pricing-engine-goal-spec.md#12-前端配置方案) with
implementation and scoped evidence. It does not reduce M0–M6 to whichever tests
already pass. Machine-specific logs, screenshots and source hashes remain in the
private verification artifacts.

The [portable UI review package](pricing-ui-delivery.md) now collects current
frontend/static files, seven-language captures and scoped interaction records.
It distinguishes byte-identical current components from historical evidence and
does not represent package assembly as another browser execution.

## Current UI-02/UI-03 acceptance

The [editor completion audit](pricing-editor-completion.md) now maps all six
regions and ten original behavior clauses to source-bound evidence. New native
English/Chinese flows cover inherited reset, image defaults/matrix/minimums,
destructive actions and invalid calendar/adapter cases. Two missing media
confirmations were reproduced and fixed; cancellation preserves the full recipe.
Previous complete editor, node, range-table and week-view proofs are retained
only for their verified unchanged dependencies, supplemented by fresh frontend
checks and current full backend assertions.

UI-02/UI-03 are verified within the original specification, including its explicit
allowance for unsupported progressive tiers. Remote supplier support, platform,
performance and final candidate delivery are not certified by this UI audit.

## Current UI-04 acceptance

The [historical calculation-policy view](pricing-calculation-policy.md) resolves
the earlier missing minimum/step/mode explanation. The current source panel first
verifies the exact original version, then matches each recorded component before
showing its quantity and monetary policy. Later prices are never substituted.
The new252policy views, eight failure/retry checks and four viewer checks preserve
all fixture financial state. Inheritance and physical-versus-allocated batch
quantities are explicit.

Combined with the preceding source-bound compatibility detail/report/cache/video
evidence for unchanged components, both original UI-04 paragraphs are now verified.
Final Goal acceptance remains separate. The older sections
below retain their original scoped findings rather than retroactively claiming
that those earlier checks had already closed the missing explanation.

## Current locale/layout/keyboard acceptance: UI-05 and UI-TEST-06

The [refreshed current-build rehearsal](pricing-ui-roundtrip.md) verifies seven
languages in 14 desktop/light and narrow/dark layouts, 28 native dialog focus
cycles and 98 section transitions. Native focus trapping, reverse navigation,
Escape/cancel restoration, selected-panel labels and page containment pass.
English/Chinese complete workflows also verify readable errors, unsaved state,
full hidden-field exports and scroll-reachable confirmation/final actions.

Fresh frontend tests check all seven locale namespaces, dynamic pricing labels,
explicit interface-locale formatting and exact decimal display without feeding
localized strings into calculations. Current immutable-cost/FX/report evidence
from the calculation-policy checkpoint remains unchanged. These original
locale/adaptation criteria are verified; this is not a claim to have tested every
Dashboard control. The subsequent six-region/form-behavior evidence is described
above, not retroactively attributed to this locale rehearsal.

## Six editor regions: UI-02

| Region | Implementation and evidence | Remaining boundary |
| --- | --- | --- |
| Base/cache | Exact string rates, explicit free, cache/TTL dimensions, currency/source and immutable inheritance; actual blank/free/reset and hidden-field workflows are recorded. | Selecting a dimension is not proof of provider metering support. |
| Context | Paginated range-table editing, local invalid-bound and overlap feedback, selected-rule rates and explicit whole-request mode. Seven-language browser edits preserve all20 fixture rules. | Progressive mode stays unavailable as allowed by RULE-03; advisory checks do not replace complete compiler validation. |
| Time/service | Timezone, weekdays, windows, date/holiday overrides and explicit service-tier values, plus the verified normalized calendar-week view. | Civil schedule previews do not represent elapsed billable duration through DST; actual request-time matching remains in the existing engine. |
| Multimodal | Quantity dimensions, media predicates, minimums, rounding and explicit combined billing; media fixtures and separate lifecycle evidence exist. | Do not infer a verified adapter or supplier contract from the presence of an input field. |
| Simulation/impact | Real UI compares a saved draft with the published version and displays separate exact costs, rules and diagnostics. | Simulation never authorizes publication or a real provider request. |
| Versions/publication | Version/audit records respect interface locale. Authenticated English/Chinese import, copy, edit, quote, publish and rollback now run as complete workflows, with exact history and budget checks. | Scheduled activation, cross-role authorization and other lifecycle boundaries retain their separate evidence; this is not blanket VERSION-01 acceptance. |

The core sources are [the book editor](../frontend/src/components/pricing/price-book-editor.tsx),
[rule forms](../frontend/src/components/pricing/price-rules-editor.tsx),
[context table](../frontend/src/components/pricing/context-range-table.tsx),
[calendar editor](../frontend/src/components/pricing/price-calendar-editor.tsx) and
[publish dialog](../frontend/src/components/pricing/price-publish-dialog.tsx).

## Form behavior: UI-03

| Original behavior | Evidence or implementation boundary |
| --- | --- |
| Appropriate defaults | Token/media dimensions are separated; media predicates are folded and image drafts do not require token prices. Full adapter coverage is not implied. |
| Blank, inherited, explicit zero | Existing actual save/reset workflows distinguish these states; the range table also rejects a blank minimum instead of coercing it to zero. |
| Invisible values survive editing | Node-name tests preserve capabilities/advanced prices. Range-table exports preserve all hidden rates, conditions and paginated rules. |
| Exact strings and explicit units | The table retains integers beyond JavaScript's safe numeric range as strings. Rates and calculations retain the existing exact-decimal contracts. |
| Validation and publish impact | A live overlap warning agrees with a real compiler400 rejection. A restored draft validates201. Publication still requires its own checked preview and consent. |
| Missing calendar/adapter warnings | Existing compiler and metering-review gates remain authoritative; a clean range-overlap result does not mean the full configuration is valid. |
| Confirmation and safe draft save | Native cancellation/acceptance now includes media disable/reset, rates, rules, groups and calendars; active prices and financial state stay unchanged. Exact expected draft/audit updates are checked per fixture. |
| Errors, loading, dirty state and keyboard | Lazy panels have loading fallbacks; existing navigation guards remain. Earlier native keyboard and error/retry evidence is retained, not presented as a new all-page audit. |
| Revision conflicts | Existing two-editor409/compare/confirmed-reload evidence remains; this change does not bypass the stale/editability gate. |
| Isolated no-send simulation | Current UI quote and replay workflows issue only local management requests and no provider calls. |

## Exact closed workflows

### Authenticated import, copy, publish and rollback

The [integrated roundtrip](pricing-ui-roundtrip.md) closes the previously separate
import/copy/edit/quote/publication/rollback check in English desktop/light and
Chinese narrow/dark. V1/V2/restored-content V3 drive eight actual mock-backed
requests; earlier records and complete hidden fields remain unchanged. Impact
previews do not write, stale consent is invalidated, copies stay unpublished,
and exact budgets reconcile. These are password-authenticated administrator
flows, not a new all-role or all-protocol certificate.

### UI-TEST-04: save, quote and replay

An isolated application starts with an immutable0.001USD historical receipt and
a later published0.003USD tariff. The real Dashboard saves a new draft rate,
then compares its0.004USD quote with the0.003USD published quote. Historical replay
displays the original0.001USD and simulated0.004USD separately, with the explicit
unchanged-history label. The test does not publish the draft.

Before/after comparisons include every pricing table, budget rules, logs and
configuration hash. Exactly one draft row and one `draft.updated` audit change;
published versions, catalogs, request snapshots, costs, reservations and budgets
do not. Provider call count is zero. A native-option visibility timeout interrupted
the harness after the successful save; it resumed read-only, without repeating
that write. This is accepted evidence for UI-TEST-04, not a lost-write retry test.

### STATE-08: history after a price change

The same fixture deliberately publishes the later price before opening history.
Original receipt and log data remain unchanged after the quote/replay actions.
Replay loads only when its panel opens and its results are labelled simulations;
the new price is never substituted into the historical amount. Existing immutable
version/FX/adjustment tests provide complementary backend coverage.

## Prior cost-view recheck and the quantity explanation gap

The [compatibility checkpoint](pricing-compatibility-acceptance.md) adds282current
password-authenticated browser checks across seven languages and both layouts.
It verifies normalized and billed quantities, formulas, original FX, rule/calendar/
service/media metadata, all cost states, cache cost/budget/reference separation,
video reserve-to-final state and independently checked report exports.

At that earlier checkpoint UI-04 remained partial because original minimum and
rounding step/mode were absent from the historical-source panel. The subsequent
calculation-policy checkpoint resolves that gap, as described at the top of this
map. The original immutable policy now explains measured/billed differences
without recalculating history or borrowing today's settings.

## Earlier range-table and locale verification

Request details already show normalized usage, billed quantities, rates, rule and
version references, conditions, rounding, status and known versus complete costs.
The historical FX gap is addressed by the
[receipt-bound FX view](pricing-dashboard.md#historical-fx-evidence). Cache reference
and asynchronous-media states have their own evidence. This range-table check
does not certify every detail/media/recovery workflow again.

Four implicit browser-locale calls were found and corrected: capacity rule/body
counts and version/audit timestamps. A structural check now rejects implicit
locale formatting in pricing-page/components. Fourteen current browser layouts
exercise seven languages at1440px/light and390px/dark. Initial document-width
checks missed a762px fieldset clipped inside the page; the corrected runs check
actual region bounds and usable table-local scrolling. Font requests are blocked
in the guarded fixture, so visual evidence uses fallback fonts.

The final advisory helper adds media normalization after that browser run. The
tested browser fixture has no media predicates and the rendered component is
unchanged. Sixteen additional direct comparisons with the actual compiler cover
equivalent frame-rate strings, overlapping/adjacent ranges, service tiers and
priorities. This is not misrepresented as a fresh normalized-media browser run.

## Gates not closed by this map

- The normalized calendar-week view is implemented; its complete scoped evidence
  is documented in [calendar-week verification](pricing-calendar-week.md).
  The integrated import/copy/edit/quote/publish/rollback check is also complete.
  The subsequent16-clause editor completion audit closes UI-02/UI-03 using scoped
  dependency checks and refreshed native controls, not tab navigation alone.
- UI-TEST-05's real-session/default-admin/other-admin/viewer API proofs remain
  distinct from earlier no-login browser fixtures. The new roundtrip adds real
  administrator password/session browser evidence, not the entire role matrix.
- The range-table checkpoint carried forward4,067 unit and739 HTTP tests. The
  subsequent calendar-week endpoint has a fresh full4,080-unit/746-HTTP result;
  those are separate source checkpoints, not interchangeable counts. The refreshed
  roundtrip changes no application code and carries the current4,229-unit/807-HTTP
  result by exact hashes. The subsequent media confirmation change has fresh
  frontend tests/build and unchanged backend files; no new backend run is claimed.
- Original Gateway HTTP latency/throughput thresholds remain unmet. Frontend
  bundle budgets and screenshots cannot waive them.
- The earlier image mentioned by those historical checkpoints predates their
  frontend/FX changes. The subsequently restored application now matches the
  authenticated inbox-phase image's inputs, as recorded in current progress;
  this is carried image evidence, not a new container test. Final fixed-source
  candidate delivery and separate deployment approval remain mandatory.
  Production2099 is untouched.

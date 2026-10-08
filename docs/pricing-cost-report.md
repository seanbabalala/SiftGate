# Retained-request cost coverage

The Dashboard's **Cost coverage report** (`/pricing/cost-report`) separates
calculated charges, estimates, unknown costs and stored legacy estimates. It uses
the same immutable ledger summary as request cost details; it does not reprice
history using the current catalog. This is an internal cost report, not a
supplier invoice or a promise that all network traffic was durably recorded.

The [current output attachment](pricing-cost-output-delivery.md) provides fresh
cost-detail/report/replay API examples, complete and partial summary exports,
and an independent exact-arithmetic verifier. Its SQLite/AppModule execution
scope and separation from historical browser evidence are explicit.

## Population and time

Choose an explicit UTC interval `[from, to)`, no longer than 366 days. Both the
inputs and the displayed scanned interval use UTC; formatting follows the chosen
Dashboard language without changing the timezone.

The population is:

1. Retained request snapshots, selected by **admission time**, including requests
   without a call log. Attempts and later corrections belong to that request's
   admission cohort, not to a new cohort at correction time.
2. Legacy-only call logs, selected by their recorded timestamp. A log associated
   with a retained request snapshot is not counted again in this second cohort.

The default workspace includes its historical `NULL`-workspace logs. Other
workspaces cannot read them. Report access requires an authenticated workspace
viewer or higher. This report covers the selected workspace, **not** the
provider/key/namespace filters on the Request Logs page. Deleted or
never-persisted requests cannot be reconstructed from these reads.

## Paging and consistency

`GET /api/dashboard/pricing/cost-report` accepts `from`, `to`, `limit` (1–50)
and an optional opaque `cursor`. The initial page fixes the upper snapshot tuple
and legacy log ID. Subsequent keyset cursors bind the workspace, window, page
size, schema availability and report identity. A changed scope or malformed
cursor is rejected. Only a `null` next cursor means the scan is finished.

Each page reads in a short database transaction (PostgreSQL `REPEATABLE READ`;
serialized SQLite read transaction). **The whole scan is not a single
point-in-time snapshot.** Corrections, late persistence and retention can change
its contents between pages; including deletion of snapshots or logs. The upper
bounds are not a global ingestion watermark and do not prove completeness.
Use a new scan when a current view is needed. A finalized financial-period
export would need a separate snapshot/finalization contract.

The UI loads one page initially. **Continue scan** reads sequentially, up to 200
pages per explicit action. It has no background job or timer that silently scans
the remaining population. **Pause after this page** retains the completed page;
unmounting aborts the UI request. Failed or malformed pages do not increment
counts. Responses are checked against their workspace, window, cursor, report
identity, content hash and recomputed page totals before accumulation. Content
hashes detect mismatches; they are not supplier signatures.

The table retains only the last page. JSON export contains the scanned summary,
window, read timestamps, consistency and `scan_complete`; it is neither an
all-row export nor an invoice. A partial scan remains explicitly partial.

## Amounts and statuses

Four exact decimal USD amounts remain separate:

| Field | Meaning |
| --- | --- |
| `calculated_usd` | Complete `priced`/explicitly `free` ledger charges |
| `estimated_usd` | Complete estimated ledger amounts, including ledger `legacy_estimate` receipts |
| `legacy_estimate_usd` | Safely representable stored compatibility amounts |
| `partial_known_usd` | Known parts of incomplete ledger charges |

Do not add these columns and label the result complete actual cost. Calculated
coverage is `priced + free` requests divided by scanned requests. Estimated,
legacy, pending, partial, unpriced and missing-usage requests are not calculated
coverage. Unknown calculated amount includes legacy estimates, even when the
stored estimate itself is present. Original-currency components and fixed FX
remain inspectable in request details; this report requires the existing USD
report-currency contract and does not relabel other currencies.

`legacy_requests` counts the legacy-log basis, including captured requests with
an explicit compatibility-bypass marker. A ledger receipt whose price provenance
is `legacy_estimate` instead remains in the estimated-ledger amount bucket and
retains that status. Neither path increases calculated coverage.

Missing evidence is not zero. A captured request without a receipt is unknown,
unless the original admission path durably recorded an intentional compatibility
bypass (`no_active_bindings` or `no_media_binding`). That marker is tied to the
request, snapshot and operation; only then may its stored legacy estimate be
shown. Reads never create markers or retroactively guess that a missing receipt
meant bypass. A failed marker write preserves compatibility traffic but leaves
report classification unknown.

When every terminal receipt lacks usage and no known subtotal exists, the
request summary retains `missing_usage`, matching the attempt and report. It is
not collapsed into a missing-price `unpriced` state. Mixed known/unknown attempts
retain partial coverage, and unfinished attempts remain pending. A pending task's
budget hold is not a final supplier charge: an amount can remain unknown while a
nonzero reservation is still visible.

Known integrity failures appear as `invalid_evidence` with an unknown amount.
Database/storage failures fail the page instead of returning false completeness.
An incomplete pricing installation is rejected rather than treating new records
as legacy. Unrepresentable legacy floating-point amounts remain unknown, not
free. Decimal aggregation does not use floating-point addition.

## Request Logs integration

`GET /api/dashboard/pricing/log-cost-summaries?ids=...` accepts at most 200
unique positive IDs and returns only accessible log summaries. Missing or
inaccessible IDs are listed without revealing another workspace's records.
New log rows display authoritative ledger status, explicit unknowns, legacy
labels and partial known amounts. The existing traffic/key aggregate remains a
**stored compatibility projection**, with an explanation and a link to the
coverage report. It has not become an authoritative ledger aggregate.

Cost details likewise refuse to turn a captured missing receipt into a confirmed
or free stored log value. Reports and details do not send provider requests,
change budgets, create settlements, write markers or modify historical logs.
This checkpoint adds no migration and changes no previously frozen migration.

## Verification and remaining acceptance

Synthetic SQLite/PostgreSQL and HTTP contracts cover workspace scope, bounded
pagination, missing logs/receipts, explicit bypass, exact sums, corrections,
legacy scientific notation, malformed cursors, integrity and storage failures.
The earlier browser fixture includes 125 snapshots and eight legacy logs; it exercises
partial/final scans, retry, hash rejection, pause/resume, export, workspace/viewer
access and all seven language/layout combinations. A UTC-display regression is
also checked under a non-UTC host timezone.

This report does not complete the full pricing Goal. Global performance,
remaining workflow/capacity/platform acceptance and final candidate delivery
remain separate requirements. See the
[Goal spec](pricing-engine-goal-spec.md), [progress](pricing-engine-progress.md)
and [request ledger and dashboard](pricing-dashboard.md).

## Mixed-report browser checkpoint —2026-09-30

The current application source and compiled frontend were exercised with 58
synthetic records: twelve mock-backed requests, 44 legacy logs, a captured request
without its receipt and an invalid snapshot. The report spans two pages and all
eight statuses. Existing legacy zero remains a legacy estimate, not proof of a
free supplier call. Missing or invalid evidence stays unknown even when the old
numeric log column contains99USD; it is not substituted as the authoritative cost.

The fourteen seven-language desktop/light and narrow/dark workflows verify visible
row basis/status, the incomplete first page, complete second page and actual JSON
downloads. Independently computed totals are:

| Separate bucket | Synthetic USD amount |
| --- | --- |
| Calculated charges | 0.002685714000000000 |
| Estimated charges | 0.004000000000000000 |
| Stored legacy estimates | 1.120000000000000000 |
| Known part of incomplete charges | 0.001000000000000000 |

These buckets must not be relabeled as one complete supplier charge. Of58 rows,
four are calculated/free, six have known calculated or estimated amounts and52
lack a complete calculated amount, including the44 legacy-only rows. Thirty-two
English-desktop/Chinese-narrow request-detail checks retain the same distinction.

Two requests with the same0.002CNY original use different synthetic FX versions:
1/7 and1/5USD per CNY. Their historical USD amounts remain fixed after publication;
an earlier request without FX keeps its CNY amount and unknown USD. That checkpoint
exposed a UI-04 gap: FX version IDs were visible, but the historical ratio, source
and effective time were not. The subsequent
[historical FX panel](pricing-dashboard.md#historical-fx-evidence) closes that gap
using a receipt-bound, read-only lookup of the admitted catalog. It never derives
the rate from today's schedule or already-rounded totals. The original report
amounts and classifications remain unchanged.

A deliberately failed next-page request preserves the existing partial export;
retry completes without duplication. Switching workspaces clears prior totals,
the empty workspace returns no original rows, and direct access to another
workspace's detail returns404. The stored viewer role removes correction actions.
This fixture uses test-only unauthenticated Dashboard mode: these checks prove
scope/UI behavior, not a new password/session-authentication result.

Pricing tables, budgets, logs and fixture configuration match before/after;
there are no additional supplier calls during browser verification. The scope
workflow makes exactly two expected workspace-selection POSTs. Guarded browser
runs block the external font stylesheet and use fallback fonts; expected blocked
font and injected HTTP errors are distinguished from JavaScript exceptions.
Initial harness-assumption failures are retained separately and are not counted
as product failures or accepted runs. All owned browser/server instances stop
after verification. Production2099 and its configuration are untouched.

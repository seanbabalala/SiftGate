# Authenticated pricing workflow verification

Status: **scoped verification complete; full Goal active, not deployed**.
This refreshes the integrated import/copy/edit/quote/publish/rollback check and
adds current keyboard, error and conflict evidence. It does not close every
UI-02/UI-03 clause or the performance, platform and candidate-delivery gates.
All prices below are synthetic test rates, not supplier prices.

## Environment and identity

The current application and compiled Dashboard run against disposable in-memory
SQLite on a loopback temporary port. Password authentication is enabled, legacy
token authentication is disabled, and the real login returns an HttpOnly session
cookie. Two complete flows use English at 1440px/light and Chinese at 390px/dark.
They share one fixture, with separate books and model bindings.

The fixture matches the dimension/module checkpoint: 1,395 source files and 1,473
compiled files. Its unchanged backend has 4,229 passing unit tests in 205 suites
and 807 HTTP tests in 65 suites. Those results are carried by exact hashes, not
claimed as a new full-suite execution. Frontend contracts are rerun successfully;
the existing compiled build and bundle limits remain unchanged. Machine-specific
evidence stays in private artifacts.

## Complete workflow

Each browser flow performs these operations through the actual Dashboard:

1. Reject an import containing an unknown field with HTTP400. Reject a file over
   1MiB locally without sending it to the API.
2. Import a complete document: six ordinary/cache/TTL rates, source metadata,
   long-context rules, timezone/week windows, holiday and date override.
3. Create a book, copy it into another book and export both. The copy stays an
   unpublished draft without a catalog binding.
4. Preview publication. Confirmation starts unchecked; editing the reason after
   checking it invalidates both the preview and consent. Explicitly preview again,
   then confirm publication of version V1.
5. Issue one explicitly authorized mock-backed gateway request.
6. Fork V1, change only the ordinary input rate from 1 to 4, save, and compare
   the draft quote with the published quote. Nothing else in the document changes.
   An additional mock-backed request after saving still uses published V1.
7. Preview and confirm V2, then issue one new mock-backed request.
8. Preview and confirm rollback to V1 content. This creates a distinct immutable
   V3, not a rewrite or reuse of V1. Export the restored version and issue one
   final mock-backed request.

| Version | Input rate per million | Input/output tokens | Exact request cost, USD |
| --- | ---: | --- | ---: |
| V1 | 1 | 1000 / 500 | 0.002000000000000000 |
| After draft save, still V1 | 1 | 1000 / 500 | 0.002000000000000000 |
| V2 | 4 | 1000 / 500 | 0.005000000000000000 |
| V3, restored V1 content | 1 | 1000 / 500 | 0.002000000000000000 |

Output remains 2 per million. There are exactly eight mock-backed requests across
both flows, no real supplier requests. Quote and impact-preview operations do not
generate provider traffic. Metering remains visibly **conditional**; publication
does not claim verified supplier support or guaranteed availability of usage.

## Independent state checks

Twenty-five saved database snapshots cover the workflows and final shutdown. An
independent verifier checks their complete rows and exported JSON:

- Imported, copied and rolled-back documents equal the complete original.
  Edited documents differ only at the intended input-rate value. Hidden TTL,
  context, calendar and source fields survive.
- Five pairs bracketing publication/rollback **previews** have identical complete
  pricing/budget/log/key rows and fixture configuration hashes. The English V2
  pair also includes the deliberate after-draft-save request; it is not labelled
  a no-op. Its one request, expected cost/budget changes and unchanged catalog are
  checked separately. Quotes and previews do not contact suppliers.
- Every previously finalized version, catalog revision, request snapshot,
  reservation, receipt, settlement, budget effect, runtime outcome, audit and log
  row remains unchanged in later snapshots. The server also re-reads and compares
  every original cost-breakdown response before shutdown.
- Eight request snapshots refer to the intended six versions. All reservations
  are committed and settlement intents applied, with 16 budget effects. Final
  balances are 12000 tokens and 0.022000000000000000 USD. An independent rational
  arithmetic oracle reproduces every amount and its compatibility projection.
- Four books remain, with two unpublished copies and six immutable versions.
  The 52 audits comprise four book creations, four draft publications, two draft
  creations, eight draft updates, two rollbacks, 16 outcome retentions and 16
  deliveries. There are no duplicate browser publication or rollback writes.
- Caller-key identities, hashes, permissions and scopes are unchanged. Only the
  used synthetic key's expected last-used time/IP and update timestamp change
  after model requests. This is not described as byte-identical key rows across
  actual traffic; preview-only snapshots still compare every column.

Both final rollback-preview dialogs fit their viewports with no page or dialog
horizontal overflow. Long content scrolls inside the modal; confirmation is
keyboard reachable, the final action can be scrolled fully into view, and it
stays disabled until checked. Read-only layout
previews are cancelled and leave the final database snapshot unchanged. Screenshots
were inspected. Google Fonts CSS and font requests are blocked, so this evidence
covers fallback-font rendering.

## Current keyboard and failure paths

All seven languages run at 1440px/light and 390px/dark: 14 layouts, 28 native
dialog focus cycles, 98 arrow-key section transitions and 56 screenshots.
Native Tab reaches the triggers; Tab and Shift+Tab stay inside each dialog;
Escape or keyboard cancellation restores focus and removes the scroll lock.
All six section labels and selected panels agree. The keyboard-only phase changes
no pricing, financial or configuration state and makes no supplier request.

Each English/Chinese unpublished copy then exercises these actual controls:

- A blank price remains blank in the export and receives HTTP400. Explicit free
  saves zero plus its free flag. Unchecking free restores a blank, not an inferred
  price; returning to the saved free state clears the dirty indicator.
- A separate fixture client edits the draft while the browser retains an unsaved
  output rate. Saving receives HTTP409 without overwriting either side. Comparison
  shows changed paths; cancelling reload preserves the exact local export, while
  confirmed reload adopts the server revision.
- Scoped, before-send fault injection displays localized permission and network
  errors. Busy controls are disabled, local input survives, and only an explicit
  retry saves it. These are UI fault simulations, not new backend permission tests.

Only the two unpublished copies and six expected update audits change during
these controls checks: free-save, peer edit and explicit retry per copy. Every
active version, catalog, original cost response and budget remains unchanged.

## Scope and retained failures

The earlier calendar-week rehearsal and its failures remain historical evidence,
not the current browser run. The refreshed run's first verifier accidentally
parsed the intentionally oversized whitespace import as valid JSON. Its second
version incorrectly counted four intercepted faults as server-bound writes.
Both failed scripts/results are retained. The accepted audit separately validates
the oversized fixture, ten observed draft PUTs, four intercepted faults, exact
database revisions and all expected audits. No mutation was blindly repeated.

This is an authenticated administrator flow, not a new all-role authorization
matrix. Existing real-session viewer/other-workspace API proofs remain separate.
The short-input calls verify ordinary rates and immutable version selection;
nonzero TTL, long-context and time-window billing retain their separate test
evidence. This in-memory rehearsal is not a persistence, restart, PostgreSQL,
Docker, capacity or performance result.

This rehearsal alone does not certify inherited reset, image-family defaults,
media-matrix controls or invalid calendar/adapter handling. The subsequent
[editor completion audit](pricing-editor-completion.md) verifies those remaining
clauses with current native workflows, a media-confirmation fix and checked
dependency-bound evidence. Merely navigating six tabs does not close UI-02/UI-03.

All owned browser and application processes are stopped. Production2099, its
active release and the user-confirmed model edit remain unchanged. No commit,
push, image publication or deployment occurred. The prior Rancher image remains
stale and the original native HTTP performance target remains unmet. See the
[full acceptance map](pricing-ui-acceptance.md) and [performance record](pricing-performance.md).

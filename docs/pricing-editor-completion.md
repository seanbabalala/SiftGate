# Pricing editor acceptance

Status: **original UI-02/UI-03 criteria verified; full Goal active, not deployed**.
The private clause audit maps all six editor regions and ten form-behavior clauses
to current source, actual interactions and passed assertions. It preserves the
original scope; tabs or screenshots alone are not treated as completion.

## Corrected destructive controls

Turning off an explicit media specification and restoring its parent specification
previously discarded draft settings without confirmation. An actual component
callback test reproduces the missing confirmation before the fix. Both controls
now use the existing localized confirmation messages. Cancellation does not change
the document; enabling an empty specification remains non-destructive.

The expanded regression exercises ten rate, multiplier, calendar and media
deletion/reset callback paths, both cancellation and acceptance, with immutable
source/parent assertions. Native English/Chinese browser checks verify the new
confirmations, saved results and inherited recipe semantics:

- Disabling the child specification stores an explicit null override.
- Cancelling restoration preserves that override.
- Confirmed restoration removes the local override, restoring the exact fixed
  parent version rather than copying a newer price or flattening the recipe.
- An inherited token rate can be made explicitly free, then restored with the
  same cancel/confirm behavior. Other rates, TTLs, calendar and parent identity
  survive unchanged. The child retains its own declared source metadata.

## Remaining controls exercised in the current build

Both English at 1440px/light and Chinese at 390px/dark run these actual operations:

1. Cancel rate, rule, group, calendar and individual window/date deletions. Accept
   selected rule/window deletions, export the exact intended changes, and reload
   the original unsaved draft through the native leave confirmation.
2. Remove a calendar while a rule requires a time tag. Validation and save both
   return HTTP400, with no database revision change.
3. Create an image-family draft. It contains only `image_count`, no invented
   rates and no mandatory input/output token prices.
4. Configure two image size/quality variants, exact string rates, per-image units,
   a minimum quantity and rounding. Save the draft without publishing it.
5. Simulate one image: the 1024 variant bills the configured minimum of two at
   0.01USD each; the 512 variant costs 0.04USD; an unmatched 2048 variant remains
   unpriced. An independent rational-arithmetic oracle reproduces known amounts.
6. Preview this image basis against a chat-only operation. The UI shows the
   affected binding and a localized missing-metering blocker; publication remains
   disabled. No supplier probe is used to infer support.

The fixture uses real password/session authentication, the actual application,
private in-memory SQLite, copied compiled assets and a loopback temporary port.
Its supplier handler rejects unsolicited work; **zero supplier requests occur**.
All published versions, catalogs, financial rows, caller keys and configuration
remain identical. Only two new unpublished image books, their two saved drafts,
eight inherited-draft updates and twenty corresponding audits are added or changed.
The four ordinary seeded drafts remain byte-identical.

## Clause coverage and retained evidence

The immediately preceding [authenticated editor rehearsal](pricing-ui-roundtrip.md)
already verifies complete import/copy/edit/quote/publish/rollback, blank versus
explicit free, conflict comparison, confirmed reload, permission/network failures
and native seven-language keyboard interaction. All its frontend sources except
the media confirmation component and removal test are unchanged. Its original
scope is retained, not described as a rerun of the new callbacks.

The source-bound range-table, normalized-week and unrelated-node-edit proofs are
retained only for their checked unchanged components, helpers, shared controls and
styles. Fresh frontend checks execute range-table callbacks, exact boundaries,
shared overlap matching, inherited recipes, units and metering-review validation.
The unchanged full backend proof contributes actual stored-config preservation,
calendar errors, media receipts, immutable inheritance and authorization assertions.

These combined checks cover every original UI-02/UI-03 clause. `whole_request`
remains the supported context mode. `graduated` is explicitly unavailable, as
permitted by RULE-03; it is not silently approximated. Units, fields and adapters
are configuration capabilities, not confirmation of any remote model or supplier
contract. Locale/layout/keyboard and historical cost explanation retain their
separate verified UI-05/UI-TEST-06 and UI-04 scopes.

## Build, failures and remaining gates

Frontend tests and a fresh build pass, with unchanged bundle limits: pricing
23.40KiB gzip under 24KiB, request-cost 7.14KiB under 8KiB. Backend, public backend
tests, dependencies and migrations are unchanged; the 4,229-unit/807-HTTP result
is carried by exact hashes, not claimed as a new backend run.

The initial private fixture incorrectly attached a media contract to a chat
publication; the real metering gate correctly rejected it. The corrected fixture
separates token and image parents without weakening validation. Native automation
also exposed harness assumptions about checkbox confirmation, quoted labels,
inherited recipe exports and browser-global evaluation. Completed saves were
recovered from their responses, never blindly repeated. The first independent
verifier wrongly equated a child's declared source with its parent's source;
the accepted verifier checks both explicitly. Failed scripts/results are retained.

Screenshots and reachable warning/form controls were inspected. Font requests are
blocked, so rendering evidence uses fallback fonts. All owned test processes are
stopped. Production2099 and the user-confirmed model edit remain unchanged.

The original PostgreSQL performance target remains unmet. Database/restore and
current platform acceptance, reference provenance, final fixed-source candidate
and final quality gates remain open. This is not `READY_FOR_REVIEW_NOT_DEPLOYED`
and does not authorize a restart, Git push or deployment.

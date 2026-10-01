# Portable pricing UI review package

This delivers D-05's frontend files, seven-language text, screenshots and
interaction evidence for the current development checkpoint. It is **not a new
browser run, a committed release, performance acceptance or deployment approval**.
The [Goal Spec](pricing-engine-goal-spec.md), [UI acceptance map](pricing-ui-acceptance.md)
and [current progress](pricing-engine-progress.md) retain their separate scope.

## Contents and identity

The private delivery attachment is named `pricing-ui-review.zip`:

| Item | Count / purpose |
| --- | --- |
| `frontend-source/` | 390 current public frontend-tree files, including the seven locale catalogs and frontend lockfile |
| `frontend-build/` | 154 current compiled static files |
| `screenshots/` | 332 existing PNG captures with per-file hashes, language, layout and pixel dimensions |
| `results/` | Seven allowlisted synthetic workflow summaries, with original proof digests and source-scope explanations |
| `interactions/` | 28 calendar/range-table records, preserving quantities, states and locale formatting |
| `coverage/` | 21 original editor/locale clauses, cost-view field mapping and per-checkpoint source differences |
| `source-identity.json` | Base Git commit, explicit uncommitted overlay and frontend/build hashes |
| `verify.py` / `SHA256SUMS.json` | Offline inventory/digest checks; optional comparison with a checkout |

The archive contains 919 payload files plus its checksum inventory. Its size is
42,613,162 bytes and SHA-256 is:

```text
7c06d50b440b830ac4b995d1a06d2f2a234306e21fe8e7fcfb9dabac44bd43e7
```

The source folders are review snapshots, not a standalone replacement for the
whole repository: frontend development also uses shared backend types/pure
helpers. The compiled static files still require a compatible backend. Do not
open this package expecting it to start or configure a gateway. The final
whole-source/runtime release package remains D-09's separate deliverable.

## Browser evidence, with its limits

| Capture group | PNGs | What can be carried forward |
| --- | ---: | --- |
| Editor completion | 16 | All 390 frontend sources and 154 static files match current bytes. English desktop/light and Chinese narrow/dark cover final media/inheritance/confirmation controls. |
| Editor acceptance | 82 | Token import/copy/edit/quote/publish/rollback and keyboard/dialog behavior across seven languages. Only the later media-confirmation component and its static checker differ; completion evidence covers that change. |
| Calculation policy | 98 | Original quantity/money policy, FX, inherited/batch quantities and failure/viewer states. The later media-editor changes do not change these read-only components. |
| Compatibility cost views | 92 | Unchanged cost/report/cache/video components. The later calculation-policy group supplies the original-source panel's missing quantity explanation. Five superseded non-v2 images are not included as accepted captures. |
| Model status | 44 | Historical list/render/link-component views across seven languages. Five relevant dependencies still match; the old complete editor/API is not claimed byte-identical. These images were first individually hashed during packaging, not retrospectively described as originally sealed. |

The package includes all seven locales: English, Simplified Chinese, Traditional
Chinese, Japanese, Korean, Thai and Spanish. Desktop/light and narrow/dark are
present for each. This does not claim that every control was manually exercised
in every language, role or device. The editor's original six-region and ten-form-
behavior clauses remain mapped to their scoped interaction, source and test
evidence rather than being inferred from tab screenshots.

Long dialogs can be captured at different scroll positions. A region screenshot's
pixel size is not its browser viewport size. Scroll reachability, focus trapping,
confirmation and page containment have their own recorded assertions. Screenshot
appearance alone is not proof that a save, publication or accounting action worked.

Model list rendering/link dependencies are unchanged; destination editor behavior
is covered by newer editor evidence, and the current full HTTP regression retains
the model-status API cases. The much older complete pricing roundtrip, with broad
subsequent frontend differences, was deliberately not substituted for the newer
workflow evidence. All synthetic charges are test data, not supplier prices.

## Verification performed for packaging

- Fresh frontend contracts, localization checks and build pass. Existing route
  bundle limits are unchanged: pricing is 23.40 KiB gzip under 24 KiB; request cost
  is 7.14 KiB under 8 KiB.
- All 1,473 compiled files, including the 154 frontend static files, remain equal
  to the restored checkpoint. No application, dependency or migration changed.
- Source references in all 21 editor/locale clauses and the carried cost-view
  components match the current checkout. Older group-wide differences remain
  listed rather than hidden behind a single current-source label.
- An independent fresh extraction verifies every payload digest. All 332 PNGs
  pass chunk-CRC, dimensions and decompression checks. Altering a capture or
  adding an unexpected file causes the verifier to reject the copy; restoring it
  passes again.
- Representative images across all seven languages were visually inspected.
  This is not described as visual inspection of all 332 images.
- Exported result/coverage/interaction records exclude configuration, databases,
  cookies, passwords and API credentials. Local endpoint origins/private paths
  are normalized where declared; original private record hashes remain available.

The first packaging run rejected two navigation image names that lacked locale
tokens. Their original fixture explicitly sets English/light at 1440×1000; an
exact-name mapping fixes the packaging metadata. The failed directory is retained.
Passed frontend checks were reused only after their logs and unchanged source/
compiled identities were verified; they were not rerun or counted twice.

## Using the package

Start with `README.md` and `GALLERY.md`, then read `coverage/scope.json` and the
workflow summaries. After extraction:

```sh
python3 verify.py
python3 verify.py --repo /path/to/reviewed-checkout
```

These commands check integrity and source identity only. SHA-256 manifests are not
trusted-party release signatures or a substitute for functional verification.
No live service, browser, database or container starts as part of these checks.

D-05 can be reviewed independently of the remaining report/API export bundle,
fixed-source candidate, original PostgreSQL performance gate and aggregate Goal
acceptance. Production 2099 and the user's model configuration remain unchanged.

# Historical calculation policy

Request-cost details now expose quantity and monetary rules from the **exact
original price version**, not the active price catalog. Expand **Original price
source** to inspect this read-only explanation. The existing authorized version
lookup verifies the receipt's book ID, version ID and content hash before the
policy component loads.

## What is shown

- Original currency, money precision and rounding mode.
- Per recorded component: dimension, rule/component identity, original measured
  quantity, billed quantity, minimum, and optional quantity-rounding step/mode.
- Explicit absence of a minimum or rounding rule. A configured zero minimum stays
  distinct from an absent minimum.
- A reminder that observed zero usage does not trigger a minimum. When a receipt
  has no billed component lines, the UI says so rather than fabricating rates.

For example, a historical synthetic request measured800input tokens but billed
1000. Its original rule has minimum1000 and upward rounding in500-token steps.
A later publication sets minimum2000 and changes money precision/mode; the old
request still shows its original1000/500/upward rule and original money policy.
An image record with actual1/billed4 exposes minimum4 and a2-image step.
These are fixture prices and quantities, not supplier pricing claims.

## Evidence matching and limits

The display helper matches each retained line's component/rule identifiers,
selected rule, dimension, currency, rate, unit and unit size to the verified
original version. Unsupported calculator versions, mismatched components and
unavailable source versions do not fall back to current prices. There is no
calculation, supplier request, price publication, receipt rewrite or budget write
in this display path.

The existing backend is still the authority for receipt and batch integrity.
This frontend projection is an explanation, not a second cost engine or a new
receipt-verification API. It uses decimal strings and the existing localized
exact-number display; it never infers the rounding policy by dividing amounts.

Inherited prices use the child's immutable materialized content. Parent changes
do not retroactively alter that content. For allocated batch receipts, the
explanation uses the original physical receipt's quantities and clearly labels
them as belonging to the complete batch, not the individual share. These quantities
must not be added as another charge or used as the member's billed minimum.

Loading, source-read errors and retry use the existing original-version panel.
The new policy is lazy-loaded only after that panel is expanded and its original
version is verified. Existing page bundle caps are unchanged. All new strings
are present in the seven existing languages; the layout follows existing flat
field groups and supports narrow/dark views without whole-page overflow.

## Validation boundary

Frontend contract checks use the actual pure compiler, normalizer, calculator,
inheritance resolver and batch allocator. They cover minimum/floor preservation,
original versus newer identities, missing and zero minima, omitted rounding,
large exact decimal values, inherited materialization, physical batch quantities,
component/rule/rate/unit/currency mismatches, duplicate lines, unsupported calculator
versions and unavailable source data. Existing full frontend tests and the build
pass without raising bundle limits.

The source-bound browser fixture uses real password authentication and a private
SQLite gateway with mocked suppliers. It creates original/new price and FX
versions, an inherited image record and a genuine two-member embedding batch.
Reading the expanded policy checks exact original-version requests, contents,
localized labels and quantities. Synthetic browser-response failures separately
verify network failure/retry, rejected version hash and mismatched receipt lines;
server-side prices, receipts and budgets remain unchanged by those injections.

No backend, dependency, physical migration or request-price behavior changes in
this feature. The previous4,229unit/807HTTP results remain applicable to unchanged
backend/test source; they were not rerun or represented as a new full regression.
The current frontend is separately built and exercised in the browser. The entire
pricing Goal still requires the original PostgreSQL performance gate, remaining
original UI/metering/platform evidence and final fixed-source candidate delivery.
Production2099 and the user-edited configuration are not changed or restarted.


## Current browser results and original UI-04 acceptance

All252expanded policy views pass in seven locales at desktop/light and narrow/dark
sizes. They include old/new FX, a later price publication, inherited image prices,
zero/no-line costs, unavailable usage and actual two-member embedding allocation.
Eight synthetic response-error/retry checks and four viewer checks also pass.
All38pricing/budget/log tables, the configuration hash and18setup mock calls remain
identical throughout browser work; no additional provider dispatch occurs.

Representative component screenshots were inspected. Each captured component fits
inside its viewport; no document-level horizontal overflow was observed. The
policies remain lazy: there is no version request before expansion and only one
original-version request per inspected record. Source/hash failure leaves the
existing error/retry state; a matching version with mismatched receipt components
shows an explicit unavailable explanation rather than fabricated rules.

The preceding compatibility browser proof covers the unchanged broader cost view:
all original usage/rate/rule/version/calendar/service/media/FX/status fields,
known subtotal versus final total, local-cache cost/budget/reference separation,
and the video reserve-to-final transition. Its independent21-row report arithmetic
and seven-language exports remain applicable to those unchanged components.
Together with this newly verified rounding explanation, the two original UI-04
paragraphs are now accepted. This does not promote the other UI families or the
full pricing Goal.

The current frontend tests/build pass. Pricing remains23.40KiB gzip under24KiB;
request-cost remains7.14KiB under8KiB. No cap, timeout, accounting assertion or
permission rule was relaxed. The initial new check failed because the feature
module was not yet present. A subsequent locale-write encoding failure left all
translations unwritten and the frontend gate correctly failed on missing keys;
all failures are retained. The final seven-language run succeeds.

All owned gateway/browser processes are stopped. There was no commit, push,
container build or deployment. Final approval and the remaining performance and
platform requirements remain separate.

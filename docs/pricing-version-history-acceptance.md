# Version, history and access acceptance

This map concerns the original VERSION-01, VERSION-02, STATE-01 and UI-TEST-05
requirements. It is not a release certificate or permission to change a running
gateway. The complete Goal and its HTTP performance gate remain separate.

## Publication and lifecycle

Drafts are mutable under revision checks; published content is immutable.
Validation is a read-only result, not a stored lifecycle enum. The management
view derives draft, scheduled, active and inactive states. Superseded prices
remain available as historical versions. Rollback creates a new version and
activation using the old content rather than rewriting that old version.

`pricing-repository.spec.ts` exercises atomic publication/audit rollback, stale
draft/head rejection, scheduled cancellation, scope, admission linearization,
immutable rollback and cold restoration. An additional isolated PostgreSQL
rehearsal used two DataSources with distinct backend connections: peer
publications became visible on newly admitted requests despite cached old
catalogs; concurrent publishers had one winner; failed mandatory audits left
the old head intact. This proves shared database coordination, not an arbitrary
cross-version rolling deployment.

The clause audit found that missing FX was correctly diagnosed during quotation
but absent from publication preview. The management path now adds
[scoped interval FX review](pricing-management-api.md#publication-contract)
to publication and rollback. Coverage gaps remain explicit and original-currency
publication stays compatible; the Dashboard requires acknowledgment of gaps.
`publication-fx-review.spec.ts`, repository cases and
`publication-fx-review.e2e-spec.ts` cover adjacent boundaries, interior gaps,
future expiry, currency direction, scope, read-only previews, stale reviews,
rollback and original-currency/unknown-report amounts.

## In-flight requests

`pricing-node-contracts.e2e-spec.ts` covers all eight combinations of immediate
publication versus scheduled activation, JSON versus SSE, and legacy versus
actual budgets. An already admitted failed primary and its fallback retain
their original snapshot and combined cost; a newly admitted request uses the
new version. Recorded costs and reports agree. These synthetic fixtures are not
claims about any supplier's current tariff.

## Historical evidence and retention

Receipts keep applicable request/attempt/task identities, normalized quantities,
source quality, rule/rate/price hashes, time and frozen FX references. Original
and effective corrected amounts are separate. Replay under another price is
also separate and never replaces the original receipt. Missing old evidence
stays `legacy_estimate` or `not_replayable`, rather than inventing cache TTLs or
media seconds. Historical FX and replay have both backend and Dashboard paths.

The report, correction, retention, historical-FX and replay tests exercise these
contracts. [Ordinary log cleanup](pricing-retention.md) does not prune pricing
evidence, and there is no published-version deletion API. This satisfies the
supported reference-lifetime contract but **does not bound pricing storage**.
Not every reference embedded in JSON has a database foreign key. Privileged
SQL can corrupt it; cold restoration fails safely rather than substituting a
new price. Do not represent this as protection from arbitrary DBA deletion.

Pricing evidence uses metadata allowlists, not prompts, responses or media bytes.
Outcome-inbox and actual HTTP tests reject or exclude raw/nested private data.

## Authorization evidence

`pricing-management-contract.e2e-spec.ts` exercises the original management
operations through real-password, HttpOnly-session authentication. Stored
memberships override forged token role claims: viewer mutations are forbidden,
known foreign resource IDs remain inaccessible, and non-global administrators
cannot change global prices. This is broader role coverage than the separate
real-browser administrator roundtrip; it is not a claim that every role was
tested through a browser.

See [the implementation checkpoint](pricing-engine-progress.md) for completed
verification runs and remaining release gates.

## Current verification checkpoint

The FX-review source passes the complete 4,142-unit/753-HTTP inventory, builds and
frontend checks. The two independent PostgreSQL connections repeat the shared
head, publication race, cancellation/rollback and audit-failure checks on this
source. The previously reproduced FX gap now yields the preview and publication
review while the quote still keeps missing conversion unknown.

Browser review covers all seven locales at desktop and narrow widths, with
separate covered/non-conversion controls and two acknowledged missing-FX
publications. This closes the new review workflow, not the original unrelated
HTTP performance or final-candidate gates. The whole Goal remains active.

# Pricing management API

Implementation status: these management operations are implemented in the isolated
development candidate. The [implementation checkpoint](pricing-engine-progress.md)
is the source of truth for completed verification and remaining Goal work; older
scope notes are not a current TODO list. The live service is unchanged. The
[pricing editor](pricing-dashboard.md), policy/FX management and lossless node
price patches are implemented; this is not whole-Goal acceptance.
Do not treat publishing a candidate price book as proof that real traffic has
been migrated to the new engine.

## Safe initialization

The application never creates pricing tables on startup. Missing tables produce
`pricing_schema_required` on administrative data operations; ordinary legacy
gateway startup remains unchanged. Inspect readiness with
`GET /api/dashboard/pricing/status`.

The CLI requires an explicitly selected database and defaults to read-only
planning. It does not load the gateway configuration or infer a database from
ambient environment variables:

```sh
siftgate pricing-migrate --sqlite-path ./isolated-data/gateway.db --dry-run
siftgate pricing-migrate --postgres-url-env PRICING_DATABASE_URL --dry-run
```

Only after a separately approved maintenance/backup plan should an operator use
`--apply`. `--remove-empty --apply` is a downgrade rehearsal for an unused schema;
it refuses to delete price, audit or request-snapshot data. It is not a substitute
for a verified database backup and recovery plan.

## Authentication and scope

- All endpoints use existing Dashboard authentication and workspace RBAC.
- GET operations normally require viewer access. Read-only POST simulation and
  validation endpoints explicitly permit viewers. Mutations require admin access.
  Policy/FX change previews remain admin-only, like their corresponding mutations;
  admission assessment simulation remains viewer-readable.
- `GET /audit` additionally requires admin access.
- Recovery inventory, basis and acknowledgement GETs require operator/admin
  access; recovery preview and resolve require admin access.
- Select an authorized workspace using the existing workspace header. Request
  bodies cannot supply a different workspace, actor or role.
- New books default to workspace scope. Creating/changing global books or global
  FX additionally requires administration of the default workspace.
- Every mutation requires JSON. Cross-origin actions require an explicit trusted
  CORS origin; wildcard CORS does not authorize credentialed pricing changes.
- Publish, rollback, scheduled cancellation and FX changes require an explicit
  confirmation plus a reason. Permission denials are management-audited.

## Operations

Base path: `/api/dashboard/pricing`.

| Method and path | Input / behavior |
| --- | --- |
| `GET /calendar/runtime` | Server timezone-data version and UTC date for calendar drafts; no activation. |
| `GET /admission-policies` | Scoped policies and catalog head; compatibility fallback remains explicit. |
| `POST /admission-policy/preview` | Admin-only read-only validation of the exact PUT body, CAS/scope checks, before/after override; no catalog/audit/snapshot writes. |
| `PUT /admission-policy` | Catalog revision, scope, optional operation, policy or null, reason and confirmation; scoped audited catalog publication. |
| `GET /status` | Read-only schema plan; never applies a migration. |
| `GET /recovery-cases` | Operator/admin-only, read-only current-workspace list of at most 100 open suspected-orphan cases; private evidence JSON omitted. Does not run recovery or release holds. |
| `GET /recovery-inventory` | Operator/admin. `view=open/resolved/unresolved_cost/all`, `limit` 1–50, opaque scope/filter-bound cursor. Budget and provider-cost states remain separate; an empty filtered page may have `next_cursor`. Recorded cases only, not an all-traffic report. |
| `GET /recovery-cases/:id/basis` | Operator/admin. Fresh, bounded connected physical/request group and effective evidence/lease hash. |
| `GET /recovery-cases/:id/resolutions/:resolutionId` | Operator/admin. Read-only applied-proposal acknowledgement after audit/result/member integrity checks. Returns 404 if not recorded in this scope/anchor; never performs a mutation. |
| `POST /recovery-cases/:id/preview` | Admin. Read-only preview of exhaustive internal hold decisions under `expected_basis_hash`; does not invent usage or change prices. |
| `POST /recovery-cases/:id/resolve` | Admin. Proposal ID, fresh basis hash, reason, explicit confirmation and exhaustive member decisions. Atomic budget/intent/log/audit application; exact idempotent retry. See [budget recovery](pricing-budget-recovery.md). |
| `POST /recovery-cases/:id/missing-usage/preview` | Admin. Read-only, estimated administrator attestation of a missing first receipt, priced under its original request snapshot; complete physical groups use recorded manifest weights. |
| `POST /recovery-cases/:id/missing-usage` | Admin. Fresh basis, unique ID, quantities, reason and confirmation; atomic initial receipts/audit/log projection, no budget effect or provider call. Existing terminal receipts require corrections. See [missing usage](pricing-usage-recovery.md). |
| `GET /recovery-cases/:id/missing-usage/:recoveryId` | Operator/admin. Read-only acknowledgement verifying the audit and every original recovered receipt; a missing receipt/changed identity is not successful completion. |
| `GET /attempts/:id/correction-basis` | Operator/admin. Scoped original/current receipt, effective hash, revision, eligibility and fresh basis hash for a single attempt. |
| `POST /attempts/:id/correction/preview` | Admin. Original-snapshot estimated usage correction and exact logical-budget delta/epoch allocations, with no writes. |
| `POST /attempts/:id/correction` | Admin. Unique ID, fresh basis and predecessor, explicit quantities/reason/consent; linked correction/budget/audit/log transaction. Unresolved expired holds receive cost-only evidence. See [single-attempt corrections](pricing-attempt-corrections.md). |
| `GET /attempts/:id/corrections/:correctionId` | Operator/admin. Read-only verified acknowledgement; original receipt and revision chain remain immutable. |
| `GET /books` | Scoped list, `limit` up to 200 and `offset`; includes catalog revision. |
| `GET /books/:id` | Book, complete drafts, version summaries, active/future bindings, revision. |
| `GET /books/:id/management` | Viewer-readable responsibility and derived lifecycle at an explicit evaluation time; no implicit owner assignment. |
| `PUT /books/:id/owner` | Admin-only owner label or explicit null, independent metadata revision, reason and confirmation; atomic metadata/audit change, no price or permission change. |
| `POST /books` | `name`, optional `scope` (`workspace` or `global`), full `content`; creates a draft only. |
| `POST /books/:id/drafts` | `version_id`; derive a draft from an immutable version. |
| `GET /drafts/:id` | Complete draft and its integer revision. |
| `PUT /drafts/:id` | `revision`, complete `content`; rejects stale writes rather than merging away hidden fields. |
| `POST /drafts/:id/validate` | Validate the stored draft; returns its revision, canonical content/hash and coverage warnings. |
| `POST /drafts/:id/preview-publication` | Publication body below; returns planned/replaced binding IDs and warnings without writes. |
| `POST /drafts/:id/publish` | Atomically creates a version and catalog revision, records audit, and consumes the draft. |
| `POST /books/:id/preview-rollback` | Same rollback payload; plans a new activation without writes. |
| `POST /books/:id/rollback` | `version_id` plus publication fields except `draft_revision`; creates a new version/activation, never overwrites history. |
| `GET /books/:id/versions/:version` | Scoped immutable version content. |
| `GET /books/:id/export?version_id=...` | Portable `siftgate-price-book-v1` document; removes machine-local/private source links and URL credentials/query strings. |
| `GET /bindings` | Scoped bindings and FX versions plus catalog revision. |
| `POST /bindings/:id/cancel` | `catalog_revision`, `reason`, `confirm: true`; future activations only. |
| `POST /fx/preview` | Admin-only validation of the exact FX update body, including interval overlap, units/currency, CAS and scope; before/after scoped schedule, no writes. |
| `PUT /fx` | `catalog_revision`, `reason`, `confirm`, `scope`, `versions`; replaces only the selected authorized scope. |
| `GET /audit` | Scoped audit, optional `book_id`, bounded pagination. |
| `POST /batch/quote` | Viewer-readable `quote` plus synthetic `members`; prices aggregate usage once, returns conserved exact allocations and physical evidence. No provider, ledger, budget or publication writes. See [batch allocation](pricing-batch-allocation.md). |
| `POST /quote` | Pure simulation using one draft, immutable version or inline content; never calls a provider or modifies budgets. |
| `POST /calendar/preview` | `calendar`, civil `date`; normalized civil-time segments, not a claim about DST elapsed duration. |
| `POST /import/validate` | `format`, `content`; validates portable books or legacy token prices. `legacy-gateway-config` adds whole-configuration planning with optional explicit `catalog` and `evaluated_at`; no writes. See [configuration import](pricing-config-import.md). |

The candidate also exposes these cost operations (viewer-readable except the
explicitly marked historical correction endpoints):

| Method and path | Input / behavior |
| --- | --- |
| `GET /api/dashboard/logs/:id/cost-breakdown` | Workspace-scoped call-log ID; immutable attempt receipts, total status and known subtotal. Legacy logs return stored cost labelled `legacy_estimate` and are not falsely replayable. |
| `GET /api/dashboard/pricing/requests/:id/cost` | Workspace-scoped request ID; provider attempts, unknown/pending counts, committed/reserved logical budget and receipts. Unknown workspace resources return 404. |
| `POST /api/dashboard/pricing/attempts/:id/batch-correction/preview` | **Admin only**; correction ID, expected physical hash, reason, confirmation and replacement usage evidence. Recompute all member shares under historical rates, with no writes. |
| `POST /api/dashboard/pricing/attempts/:id/batch-correction` | **Admin only**; same body, atomic group correction/audit/log projection and applicable budget deltas. No client-selected prices/membership/FX. |
| `POST /api/dashboard/pricing/replay` | At most 30 `request_ids` and one `draft_id`, `book_id` + `version_id`, or inline `content`. Re-evaluates retained metadata only, returns original and simulated results; no provider calls or budget/history writes. |

A summary's `amount` is null while any provider attempt is pending or unknown.
`known_subtotal` is only the known portion, not a promise of complete upstream
cost. Each new attempt exposes a bounded `dispatch` identity (null for older rows);
its immutable cost includes `attribution` and an optional provider-reported model.
See [attempt attribution](pricing-attempt-attribution.md) for retry/unknown-cost
semantics. `budget_committed_usd` is a separate compatibility policy, not necessarily
the sum of all provider attempts. A local-cache hit can have zero upstream cost
and nonzero logical budget. No current-price recalculation runs on historical log
reads. Late first receipts and linked usage corrections update the stored compatibility
projection transactionally. For shared embedding attempts, top-level cost is the member allocation; nested
`batch.physical_cost` is explanatory evidence and must not be summed again. Replay
prices the physical usage then reapplies the recorded allocation, rather than
repricing a smaller member into a cheaper tier. Independent member corrections
are refused; [conserved physical-group corrections](pricing-batch-corrections.md)
are available through the admin-only historical usage correction API. See the
[batch runtime contract](pricing-batch-runtime.md) and the implemented
[retained-request cost coverage report](pricing-cost-report.md). The existing
traffic aggregates remain compatibility projections, not authoritative ledger
reports.

Cost-breakdown adds a `log` allowlist: `id`, `request_id`, `timestamp`, `model`,
`node_id`, `source_format`, `status_code`, `input_tokens`, `output_tokens`,
`stored_cost_usd` and `stored_reference_cost_usd`. The database query selects only
these fields, not legacy content or free-text errors. Monetary projections are
strings, but that does not make the old floating-point column an exact ledger.
A missing reference is `null`; an explicit stored zero is `"0"`. Reservations
also expose exact string `reserved_tokens` and `committed_tokens`.

Replay entries with a receipt include `fee_source`. A `local_cache` replay is a
reference counterfactual from logical usage, not a new upstream fee. Its original
upstream receipt stays zero. See [request cost workflows](pricing-dashboard.md#request-cost-evidence).

## Admission and reservation policy

The candidate now offers scoped `GET /admission-policies`, administrator-only
`PUT /admission-policy` and read-only `POST /admission-preview`. Modes distinguish
compatibility estimates, missing-price rejection and conservative cost envelopes
conditional on approved quantity limits. Policies are catalog-versioned, audited
and captured with each request. A proposed policy can be previewed without
publication. Structured 422 errors occur before dispatch/stream headers.

Reservation summaries expose `admission`, `known_cost_overrun_usd` and
`observed_limit_excesses`, separate from actual receipt amounts. A numeric hold is
not a final charge, and an administrator-declared limit is not observed usage.
See the [admission policy contract](pricing-admission-policy.md) for the API,
synthetic example, bound algorithm, source requirements and remaining limitations.

## Publication contract

A draft publication requires:

- The latest `draft_revision` and `catalog_revision` from read/preview responses.
- `confirm: true` and a nonempty `reason` of at most 1,000 characters.
- Between 1 and 256 unique `targets`, each with `level`, `model`, and optional
  `node_id` / `operation`. Node-level targets require a node ID.
- Optional ISO `effective_from` / `effective_to` timestamps with explicit offsets.
  The interval is half-open. An activation cannot already be expired.
- Optional `fx_review_status`: `not_required`, `covered` or `incomplete`, copied
  from the reviewed preview. A different recomputed status returns409. Catalog
  and draft revisions also fence changes to the rates, scope and FX schedule.
- Required `time_basis_confirmation` for an explicitly configured
  `provider_accepted_at` or `completed_at` basis. See the timing contract below;
  neither generic publication consent nor a source verification date replaces it.

Price approval/source constraints, unknown conditions, duplicate rules/targets,
unit mismatches and activation conflicts are checked before committing. A
time-priced activation must be covered by its frozen calendar. An indefinite
binding still needs a renewed calendar before that calendar's coverage expires.

Publication and rollback previews return a separate `fx_review`, also returned
and audited on successful publication. It checks conversion from the book's
currency to the runtime report currency, USD, across the entire proposed
activation interval. `window` and `gaps` use half-open ISO intervals; a null end
means no expiry. Exactly adjacent FX periods cover continuously. Inverse or
triangulated exchange rates are never invented. `fx_version_ids` lists relevant
available versions, not a claim that every listed version will be selected.

A workspace book may use its own FX or global fallback; other workspaces' FX
cannot cover it and are not exposed. Global books are checked against global FX
only. USD prices report `not_required`. Non-USD prices report `covered` or
`incomplete`; missing periods carry `pricing_fx_missing` diagnostics. A finite
FX schedule does not fully cover an indefinite price activation.

This is a warning/review, not a blanket ban on original-currency prices. Existing
API clients may omit `fx_review_status`; the audit then records
`fx_review_confirmed: false`. The Dashboard requires a separate acknowledgment
before publishing incomplete coverage and sends the reviewed status. Missing
conversion remains unknown, never zero. Existing admission/budget checks are
unchanged and may still refuse a request that needs a known USD amount.
Changing FX later remains a separate, audited catalog mutation. This review
does not freeze future administrator changes or rewrite historical request FX.

### Supplier timing agreement

Drafts and read-only simulation may explore alternative time bases. Every new
publication, scheduled activation and rollback with a non-default `time_basis`
must explicitly attest that the administrator verified the supplier agreement for
all selected targets. This also applies to inherited prices and to versions that
select an alternative basis before any current rule uses the calendar.

Publication/rollback preview returns `time_basis_review`: content hash, selected
basis, whether time rules exist, and whether confirmation is required. The
confirmation body is:

```json
{
  "basis": "completed_at",
  "content_hash": "REVIEWED_PRICE_CONTENT_SHA256",
  "reference": "PROCUREMENT-REVIEW-01",
  "confirmed": true
}
```

Supply the actual 64-character reviewed hash, not the placeholder above.
`reference` is an opaque internal review-record identifier: 1–128 ASCII letters,
digits, dots, underscores or hyphens, starting with a letter or digit. Keep the
underlying contract in its authorized records system; do not submit its text,
rates, credentials or private URLs. Extra confirmation fields are rejected.

Missing confirmation returns400 `pricing_time_basis_review_required`; malformed
input returns400. A different basis/content hash returns409. Existing draft and
catalog revisions still reject concurrent edits. The requirement is enforced by
the repository as well as the HTTP API, not only by a disabled Dashboard button.
Successful publication stores the review and confirmation with the existing
authenticated actor/reason/timestamp audit. Audit failure rolls back publication.

Default `attempt_dispatched_at` publication remains compatible and returns a null
confirmation. Previously published versions and in-flight request snapshots are
not rewritten or revoked. A later rollback requires fresh confirmation, not an
automatic reuse of the old audit. This is administrator attestation, not an
independent supplier check: `supplier_verified` stays false. It neither fabricates
provider timestamps nor upgrades estimated clocks or invoices to observed facts.
Missing time evidence still follows the existing explicit unknown-price policy.

An overlapping future activation must be cancelled explicitly before replacement.
Bounded temporary activations preserve the previous price outside their interval.
Cancelling a future activation restores its predecessor where applicable.
Already active prices change through a new publication or rollback, not deletion.

Drafts, versions, catalog-head compare-and-swap and audit writes share a database
transaction. Failure to persist the pricing audit rolls back the publication.
The catalog head uses an integer revision; it is not a timestamp or a mutable
price version. A lost update returns HTTP 409 and requires a fresh preview.

## Simulation contract

`POST /quote` selects exactly one of:

- `draft_id`;
- `book_id` plus `version_id`;
- inline `content`.

Supply at most 24 `evidence` entries with `dimension`, `value` and optional
`source` / `quality`. Decimal quantities/prices use strings; missing values are
not zero. Context can contain requested/resolved service tier, explicit attempt/
acceptance/completion timestamps and allowlisted media attributes. Optional
`report_currency` and a versioned rational `fx` snapshot support currency preview.

The response identifies itself as `simulation: true`. Cost status, selector
trace, original/billed quantities, exact line fractions, rounding adjustments,
known subtotal and unknown components are separate. A computed price is not a
supplier invoice reconciliation.

Legacy import is deliberately labelled `legacy_estimate`; it does not assert
that all old zero prices or inferred cache rates were verified. It currently
converts the deployed four-token formula, not media-contract or parent-price
inheritance semantics.

## Persistence and recovery

Request descriptors reference immutable catalog revisions, which reference
immutable book versions stored separately. They are workspace-checked on restore.
Expired bindings are removed only from **new** catalog manifests; old manifests,
versions and request descriptors are not rewritten or deleted.

PostgreSQL request admission holds a shared catalog-head lock until the descriptor
is persisted. Publication takes the corresponding transactional write lock.
SQLite pricing and central budget operations share a per-DataSource queue.
This does not claim cross-process strict SQLite budgets or complete serialization
of unrelated legacy/admin writers.

Explicit migration `pricing-engine-002` extends the intact `001` schema; it does
not alter existing price versions or delete prior data. Exact budget balances,
reservations, effects and attempt receipts are persisted. Repeating a reservation
or final settlement does not duplicate its effect. The same terminal receipt can
be repaired with the final budget effect atomically. Changing terminal evidence
is rejected rather than silently overwriting it.

Migration `pricing-engine-003` adds durable terminal intents, preserving both
older migration checksums. First commit the immutable terminal intent; then apply
its receipt, budget effect and applied marker atomically. The internal worker
replays pending intents after startup and every 30 seconds, with bounded batches
and transient-error backoff. Ledger replay does not invoke providers or use current prices. The separate media
recovery phase can issue configured pinned job-status GETs, never generation.

Each reservation in a cost summary additionally includes `settlement_status`
(`pending`, `applied`, `review_required`, or null when no intent exists), a stable
`settlement_error_code` and `lease_until`. Provider-cost completeness and budget
application status are separate. Corrupt/conflicting intent evidence requires
review; the worker never overwrites it. No new HTTP endpoint permits viewers to
manually alter or force a financial outcome.

Locally active request leases are renewed before recovery scans. A queued terminal
intent fences additional dispatch. Only expired synchronous holds with no dispatch,
no intent and no async job can be reclaimed automatically. Async jobs and ambiguous
already-dispatched orphans are retained, not declared free solely due to expiry.

Explicit `006` adds durable suspected-orphan observations with evidence revisions,
while a bounded metadata-only retry buffer repairs transient receipt and
pre-durable terminal-intent failures. Each reservation can include `recovery_case`
status. Applying a real late intent resolves its case in the budget transaction.
No case observation alone authorizes budget release or provider redispatch. See
[outcome recovery](pricing-outcome-recovery.md) for capacity, shutdown and expiry
boundaries. Audited [budget-only resolution](pricing-budget-recovery.md) is now
available through separate explicit administrator operations; the case GET never
performs those writes. Unknown supplier cost can remain unresolved after an
administrator releases the internal hold.

**Remaining recovery boundary:** process loss before a terminal decision was
durably written, full ambiguous-outcome/operator resolution, automatic correction delivery from all adapters,
supplier callback adapters, unknown job identity reconciliation and actual-upstream
budget policy remain unfinished. Do not deploy this
partial ledger as a complete crash-recovery solution. An accounting failure after
a successful provider response must never trigger another paid provider call.

Unknown or inconsistent historical references fail integrity checks. Never repair
them by substituting the current rate. A process restart must load the referenced
historical revision, not merely the latest catalog.

## Linked usage corrections

The explicit `004` migration adds versioned budget-application metadata for linked
cost corrections. Existing `001`–`003` rows, hashes and pending intents survive.
Trusted metering/reconciliation callers may append corrections; this does not add
an HTTP endpoint that accepts arbitrary cost amounts from a Dashboard user.

Cost-breakdown attempts now include:

- `cost` and `cost_hash`: immutable initial receipt;
- `effective_cost` and `effective_cost_hash`: latest valid receipt in the chain;
- `adjustments`: ordered revisions, previous/new hashes, reason, actor/source,
  original budget scopes/epochs and explicit budget application metadata.

Request totals and known subtotals use effective receipts. `pending_budget_adjustments`
counts unresolved latest budget-correction heads. A priced upstream total and a
pending logical-budget correction can coexist; they are different states. Replay's
`original` computation uses the effective evidence, and `initial_receipt` keeps the
first receipt separately. No current-price recalculation is performed by a GET.

A correction cannot replace a known frozen price/FX identity. Duplicate IDs are
idempotent, competing expected hashes conflict, and audit failure rolls back the
cost revision and budget delta together. A correction of a released logical
reservation does not introduce an unapproved actual-upstream budget policy.
Cross-period refunds apply only to retained original epochs, never unrelated
current-day usage. Unknown revised costs preserve the prior budget amount and
remain pending rather than refunding an assumed zero.

Log `cost_usd` remains a numeric compatibility projection. It is updated from
ledger evidence when late receipts/corrections arrive; the original receipt is
not overwritten. Write-behind logs use the same request fence so a stale queued
value cannot overwrite a newer cost. Use cost-breakdown status and effective
receipts to assess completeness, not the scalar projection alone.

## Synchronous media configuration

The candidate supports explicit actual/requested image quantities, provider audio
seconds, bounded PCM WAV duration, speech input code points, rerank invocations,
requested documents and reported search units. See [media metering](pricing-media-metering.md)
for dimension names, operation-specific bindings, privacy limits and synthetic examples.
Do not use token input rates as substitutes for media-unit rates.

An accepted queued image/video submission stays pending in cost-breakdown and
retains its hold. Explicit migration `005` enables durable submission claims,
minimal task footprints and normalized observation processing. Scoped status/cancel/
content controls and confirmed terminal settlement use the original price snapshot.
Cancellation acknowledgement is not terminal evidence; later metering uses linked
adjustments. Client idempotency returns metadata only, not cached media bytes.
See the [async lifecycle and control contract](pricing-media-metering.md#persisted-asynchronous-imagevideo-lifecycle)
for paths, endpoint configuration, limits and remaining boundaries. No new public
callback or arbitrary-money-write endpoint is exposed. This candidate is not yet
ready for deployment.

## Error handling

Errors have `error.type`, `error.code` and `error.message`; schema diagnostics
include field paths. Typical codes are `pricing_schema_required` (503),
`pricing_version_conflict` (409 for stale edits),
`pricing_activation_conflict` (409 for overlapping future activations),
`pricing_permission_denied` (403),
`pricing_not_found` (404 within the selected scope), `pricing_invalid_document`
(400), and `pricing_calendar_unavailable` (400 for invalid activation).

An activation overlap is not a stale-edit conflict: refreshing alone cannot fix
it. Change the proposed interval or explicitly cancel the conflicting future
activation. The editor preserves the entered fields and disables publication
until a valid preview succeeds. A stale revision still requires reloading and
reviewing the newer state; neither conflict silently replaces a schedule.

### Ordinary version ancestry

Book responsibility and lifecycle are described in [book management](pricing-book-management.md).

New `draft.published` audit records retain the consumed `draft_id`. Its scoped
`draft.created` record identifies the immutable source `version_id` and
`content_hash`; an initial draft instead links to `book.created`. This preserves
ordinary-fork ancestry even when two drafts publish identical prices in a
different order. Explicit parent-price inheritance remains a separate contract,
and rollback retains its existing `rolled_back_from` reference.

Older publications without a draft link cannot be reliably reconstructed from
timestamps, content equality or the currently active version. They remain
unavailable rather than being guessed or backfilled. This additive audit metadata
does not modify existing audits, immutable content hashes, prices or receipts.

Successful writes require an explicit user action. Validation, quote, calendar
preview and import dry-run cannot implicitly publish, reload configuration,
restart the gateway, invoke a provider, or mutate budget consumption.

See [Goal Spec](pricing-engine-goal-spec.md),
[decisions](pricing-engine-decisions.md), and
[implementation progress](pricing-engine-progress.md).

## Lossless legacy node price editing

`GET /api/dashboard/nodes` adds `configured_pricing_models`, distinguishing actual
node overrides from resolved catalog prices. An unrelated node edit must not turn
all displayed reference rates into node overrides.

`PUT /api/dashboard/nodes/:id` accepts an optional `model_pricing_updates` array:

- `{ "model": "example-model", "action": "set", "input": 0, "output": 2 }` patches
  only the two legacy base rates in the current stored model capabilities. Hidden
  cache/media prices and other capabilities survive. Explicit zero is supported.
- `{ "model": "example-model", "action": "inherit" }` explicitly removes that
  model's entire legacy price override, including hidden rates, but not capabilities.
- Omitted/empty updates do not change pricing. Blank, incomplete, duplicate, unsafe,
  prototype-key or ambiguous edits are rejected. The patch cannot be mixed with
  full `model_capabilities` replacement in one request.

The patch applies inside the existing configuration-audit mutation callback to the
current stored values, not a stale resolved GET projection. This endpoint changes
the isolated/deployed instance's configuration when deliberately invoked; tests
use disposable fixtures only, never the live 2099 instance.

## Retained runtime accounting evidence

The additive 008 inbox exposes operator/admin-only metadata inventory and verified
read-only detail under `GET /api/dashboard/pricing/runtime-outcomes` and
`GET /api/dashboard/pricing/runtime-outcomes/:id`. It has no public supplier-ingestion endpoint. The subsequent administrator-only
retained-evidence disposition is documented below. These entries are retained alternatives, not
additional charges; `delivered` acknowledges an original receipt/intent writer,
not supplier confirmation or completed budget settlement. See
[retained runtime outcomes](pricing-runtime-outcomes.md) for states, cursor,
privacy/ownership, replay bounds and the remaining conflict-disposition boundary.

## Reviewed retained-evidence disposition

Under `/api/dashboard/pricing/runtime-outcomes/:outcomeId`, operators/admins read
`GET /disposition-basis` and `GET /dispositions/:operationId`; admins use
`POST /disposition/preview` and `POST /disposition`. Input is a fresh pair of
basis/outcome hashes, scoped retry ID, explicit reason/confirmation and either
`accept_receipts` or `reject_evidence`, never money or new evidence. Preview is
read-only. Accepted independent receipts become initial or linked records under
the original price/FX; rejected evidence remains stored. Original budget decisions
and request outcomes are not replaced. See [outcome disposition](pricing-outcome-disposition.md)
for authority, conflict, retry, atomicity and remaining batch/async/UI boundaries.

## Reviewed complete-group disposition

The dedicated physical-group routes live under
`/api/dashboard/pricing/runtime-group-outcomes/:outcomeId`: operators/admins read
`GET /disposition-basis` and `GET /dispositions/:operationId`; admins use
`POST /disposition/preview` and `POST /disposition`. They accept the same six input
fields as independent disposition, but always review the complete represented
receipt set. A member subset, client money/usage or supplier-confirmation claim is
not accepted. Original custody state and the separate immutable decision appear
independently in the group listing/detail.

Complete changed cohorts produce conserved all-member revisions; compatible
initial groups may be adopted, and partial historical cohorts must be exact
no-ops. Preview includes exact proposed adjustments without persisting them.
Retained hashes can differ from accepted share hashes because the latter include
revision metadata. Neither acceptance nor rejection applies a stored logical
budget proposal. See [complete-group disposition](pricing-group-disposition.md)
for original authority, current/historical epoch simulation, audit/acknowledgement,
bounds and the unfinished dedicated UI/supplier/task workflows.

## Explicit immutable parent prices

Administrator-only `POST /inheritance/preview`, `POST /inherited-books` and
`PUT /drafts/:id/inheritance` expand an explicitly referenced immutable parent
and retain the recipe separately from the complete materialized price book.
Ordinary draft updates cannot silently flatten a derived draft. Publication,
fork, rollback, version/draft reads and simulations preserve or expose verified
lineage. Derived exports use `siftgate-inherited-price-book-v1`; import validation
resolves only accessible fixed parent versions, never a guessed replacement.

See [parent-price inheritance](pricing-inheritance.md) for the declarative recipe,
scope, CAS, audit/transaction, ancestry and import boundaries. The dedicated
seven-language editor and historical source presentation are implemented; see
[the dashboard verification scope](pricing-dashboard.md). This remains a development
candidate, not an authorized production release.

## Original management contract verification

The Goal's thirteen original operations have explicit HTTP coverage in
[`pricing-management-contract.e2e-spec.ts`](../test/e2e/pricing-management-contract.e2e-spec.ts),
alongside the existing repository and runtime suites. This fixture enables real
Dashboard authentication: local password login issues the session cookie, and
separately signed viewer/other-workspace sessions use actual stored memberships.
Forged role/workspace claims do not grant authority. The fixture does not disable
authentication to stand in for authenticated acceptance.

| Original operation | Behavior exercised |
| --- | --- |
| List books | Authorized-scope filtering, valid session and viewer access |
| Read a book | Complete metadata, private-book isolation; inherited detail is also covered by the inheritance suite |
| Create book/draft | Administrator access, rejected actor/workspace overrides, audited creation |
| Fork a published version | Immutable version reference; foreign resources and viewers cannot mutate it |
| Update draft | Exact content preservation, stale-revision HTTP409 without overwrite |
| Validate draft | Viewer-readable, read-only; compiler errors reject invalid conditions/units |
| Quote | Exact synthetic amount, no provider calls or budget writes; missing evidence stays unknown |
| Replay | Authorized historical evidence, exact simulated amount, read-only result; separate replay-limit suite covers row/time/work/output bounds |
| Publish | Reason and confirmation, preview, scheduled activation and rollback of all writes on audit failure |
| Roll back prices | Read-only impact preview, a new immutable version of old content, no rewrite of history |
| Validate import | Portable/legacy dry-run, strict unknown-field rejection, no executable content |
| Export version | Immutable-source export/reimport equivalence, URL credential/query/fragment removal and local-reference filtering |
| Read log cost | Workspace-owned log/receipt access, exact known cost and budget amount, foreign IDs rejected |

Every original operation rejects absent or invalid sessions. Every POST/PUT is
tested against cross-origin, cross-site, form-content and oversized JSON requests;
publication/fork/rollback cannot be invoked through GET. Read-only and rejected
operations preserve pricing tables, budgets, logs, fixture configuration and
provider-call counts. Security-denial management audit entries are intentionally
allowed and checked separately; “read-only” does not mean bypassing denial audit.

The error vocabulary is also exercised rather than inferred from type names.
Invalid rules, units and unsupported modes return HTTP400 with
`pricing_rule_conflict`, `pricing_unit_mismatch` and `unsupported_rule_mode`.
Revision conflicts use HTTP409/`pricing_version_conflict`; pricing scope/origin
denials use HTTP403/`pricing_permission_denied`. Existing Dashboard RBAC can instead
return `workspace_role_required`, and missing sessions return HTTP401. A successful
quote can still contain `pricing_dimension_missing`, `pricing_fx_missing`,
`pricing_calendar_unavailable` or `pricing_unknown_variant` diagnostics with a null
report amount: transport success is not a known-zero price.

Source URL filtering normalizes case and an optional trailing DNS root dot before
checking local hosts, IP literals and private suffixes. Thus `rates.internal.`
does not bypass the same check as `rates.internal`. The source kind and verification
time survive export, but the original stored version is never rewritten. Matching
checks protect model-status metadata, whole-config import provenance and frontend
draft/version export. This is metadata minimization, not DNS resolution or a
general guarantee that an arbitrary public-looking URL contains no private text.
Credentials and confidential text must not be placed in rule names or public URL
paths. Unknown private-note/credential fields are rejected by the strict schema.

Supporting suites cover
[inherited import/export and in-flight prices](../test/e2e/pricing-inheritance.e2e-spec.ts),
[whole-config import](../test/e2e/pricing-config-import.e2e-spec.ts),
[historical replay limits](../test/e2e/pricing-replay-limits.e2e-spec.ts),
[publication/body limits](../test/e2e/pricing-limits.e2e-spec.ts) and
[SQLite/PostgreSQL transaction and concurrency behavior](../test/unit/pricing-repository.spec.ts).
These tests do not certify every later recovery/media administration endpoint or
all browser workflows. Remaining performance, platform and final-source delivery
requirements are not waived by passing this original management contract.

# Explicit immutable parent-price inheritance

Backend inheritance and its dedicated seven-language editor are implemented in
the isolated candidate; **not deployed and not full Goal completion**. The editor
keeps the immutable parent reference and explicit overrides separate from the
expanded published price; a derived draft is not an ordinary flat price book.
See the [Goal Spec](pricing-engine-goal-spec.md) and
[implementation progress](pricing-engine-progress.md) for current test evidence.

## Model: a recipe plus a complete published price

A child explicitly selects a parent `book_id`, `version_id` and `content_hash`.
It inherits that immutable version, not the parent's currently active version.
Publishing a newer parent does not automatically reprice an existing child,
in-flight request, asynchronous task or historical record.

The child recipe declares `inherit: "all"` and supports:

- `rate_overrides`: complete replacement components with existing IDs. An override
  keeps the parent's billing dimension and unit. Explicit zero still needs the
  existing free-price declaration; blank is not zero.
- `removed_component_ids`: explicit removals. The engine does not fill a removed
  cache or other rate from an unrelated catalog or guess a multiplier.
- `replaced_groups`, `added_groups`, `removed_group_ids`: explicit rule-group
  changes. A group replacement and a component override inside that group cannot
  be combined ambiguously. New groups need new identities.
- `settings`: explicit precision, monetary rounding, billing dimensions and
  combined-media options. Currency remains the parent's currency; inheritance
  is not an implicit currency-conversion operation.
- `calendar`: inherit the exact parent calendar, explicitly remove it, or replace
  it with a complete calendar and explicit time basis. Dangling time rules fail
  the normal price compiler's validation.
- `source`: the child's explicitly configured price source, separately from the
  parent's retained source. A reference-only parent cannot be used as an approved
  inherited tariff.

The resolver expands the recipe into a complete normal `PriceBookContent` and
runs the existing schema, conflict, unit, quantity, calendar and size validation.
Published runtime pricing continues to use this complete materialization. There
is no parent database lookup, current catalog lookup or network price lookup
inside the calculator.

## Persistent lineage and scope

Additive migration `pricing-engine-012` introduces `pricing_draft_inheritance` and
`pricing_version_inheritance`. It does not rewrite earlier version bodies or
migrations 001–011. The new records retain the recipe, immediate-parent reference,
per-group/component/calendar origin, ancestor references, effective-content hash,
lineage hash and required audit reference.

Workspace children may use their own workspace's parent or a global parent.
Global children cannot depend on a private workspace parent. Another workspace's
private parent is unavailable even if a caller knows its ID. Each ancestry link
is scope checked; chains are bounded to 16 parents and cycles are rejected.

Parent versions and mandatory audit references are restrictive foreign keys.
Deterministic audit markers detect a missing published lineage or a missing
derived-draft recipe rather than silently interpreting it as manual content.
Reads rederive the content from the stored recipe and original parent and check
the lineage/audit hashes. Cold catalog hydration verifies lineage; normal/manual
version probes remain batched instead of adding two lookups per model. Immutable
in-memory catalog quotes need no repeated ancestry reads.

This integrity check is not a cryptographic signature against a database owner
who can rewrite every version and audit. It detects inconsistent/missing records
and unauthorized application-level source selection within the database contract.

## Draft, publication and rollback behavior

Derived drafts store both materialized content and the explicit recipe. The
dedicated recipe update uses the existing draft revision compare-and-swap.
Ordinary `PUT /drafts/:id` rejects a derived draft instead of silently discarding
its parent source. There is currently no implicit detach operation.

Before publication, the repository revalidates the exact immutable parent and
materialization. The new complete version, lineage, audits, catalog switch and
draft cleanup share one transaction. Required audit/lineage failures roll all of
them back. Concurrent recipe updates cannot both win the same draft revision.

Forking a derived version preserves its recipe. Rolling back to a derived version
creates a new published version with the same original parent recipe and lineage;
it does not silently follow a newer parent. Request snapshots still refer to the
child's immutable complete version. Actual mock-upstream HTTP tests confirm that
parent publication while a request is in flight does not change its cost.

## Dashboard API

All paths are relative to `/api/dashboard/pricing`. Existing authenticated
workspace, administrator, JSON and trusted-origin requirements apply.

| Method | Path | Behavior |
| --- | --- | --- |
| POST | `/inheritance/preview` | No-write recipe expansion; input `definition`, optional `scope` and existing child `book_id` |
| POST | `/inherited-books` | Create a child book and derived draft; input `name`, `definition`, optional `scope` |
| PUT | `/drafts/:id/inheritance` | Attach/update an explicit recipe with `revision` and `definition`; no publication |
| GET | `/drafts/:id` | Materialized content plus verified `inheritance` metadata when derived |
| GET | `/books/:id/versions/:version` | Immutable content and verified lineage when derived |
| POST | `/drafts/:id/preview-publication` | Existing no-write publication preview, including the reviewed lineage |
| POST | `/drafts/:id/publish` | Existing confirmed publication with atomic lineage persistence |

Existing fork, rollback and draft/version quote routes preserve or return lineage.
The `inheritance` view includes the canonical definition, per-component provenance,
immediate-parent-first ancestors and a lineage hash. It is evidence of the selected
configuration, not supplier invoice confirmation.

### Import and export

Derived version export returns `siftgate-inherited-price-book-v1` with the explicit
recipe, not an unlabeled flattened manual book. Source URLs omit credentials,
query strings, fragments and private/local references. Parent version identity and
hash remain unchanged. No parent credentials, provider payload or usage records
are included.

`POST /import/validate` resolves this format against an accessible immutable parent
without writes. It rejects a recipe combined with client-supplied materialized
content, and rejects a recipe hidden inside the ordinary manual-book format.
Importing into another deployment requires that the referenced parent is already
available with the same verified identity/hash. A missing parent is not silently
replaced or automatically imported/approved. Manual/legacy import compatibility
remains unchanged.

## Dashboard editing and historical source display

The seven-language editor now keeps the explicit recipe alongside the complete
editable price. Choose an accessible published parent or enter its exact book and
version IDs, inspect the inherited rates, and explicitly confirm replacement of
the current editor content. This stages a local edit only; it does not save or
publish. A later parent publication never changes the selected parent reference.

Rate edits preserve untouched cache/TTL components. Explicit same-value overrides
and whole-group replacement intent survive unrelated edits. A component reset
restores its original parent location without creating duplicate IDs; a group
reset deliberately replaces all local rules and components in that group.
Calendar reset and replacement remain explicit, and inherited currency is locked.
The source snapshot hashes are labeled separately from unvalidated local edits.

Saving a derived draft uses the dedicated revision-checked recipe endpoint.
Before saving, the editor compares the recipe expansion with server-normalized
materialized content, so canonical calendar/time-zone forms cannot silently
change prices. Unavailable parent evidence locks ordinary edits and saving rather
than selecting another price. Read-only users can validate the materialized
content without invoking administrator-only inheritance operations.

Copy includes current editor changes, not an older fetched draft. A changed
derived copy is previewed before opening the creation dialog. Copy/import/export
preserve the recipe; creation rechecks the requested child scope. A forbidden
private-parent/global-child combination fails without flattening the price or
clearing the form. Removing an imported definition starts a new manual draft
only after explicit confirmation; it does not detach the original book.

Publication and rollback previews bind the displayed content and lineage to the
reviewed draft or immutable source version. Successful publication replies must
preserve that content hash and lineage and advance the catalog revision. A
non-verifiable successful reply is not presented as confirmed publication.

Historical cost details lazily read the exact child book/version/hash already on
the receipt. Opening a request does not eagerly fetch every attempt's parent.
The returned materialization and lineage hashes are verified, and parent links
open the original immutable version rather than the newest draft. Missing/legacy
references leave the recorded cost unchanged. This view does not fetch current
catalog prices, issue quotes, or recalculate past usage.

## Verification and remaining delivery

Current tests cover deterministic core expansion and calendar/long-context/cache
interactions, SQLite WAL and PostgreSQL recipe/lineage persistence, cross-tenant
scope, independent-connection CAS, parent/child publication, bounded ancestry,
mandatory-write rollback, missing/tampered source detection, restrictive parent
references, populated 011 upgrade, HTTP origin/role checks, portable recipe import,
simulation metadata and an actual frozen in-flight request.

The frontend contracts run the actual pure backend resolver against editor edits,
including no-op overrides, moved components, settings, calendars, exact hashes and
portable recipes. Full frontend checks/build pass with 807 pricing keys per
locale and the existing bundle caps unchanged.

The first isolated browser run verifies selection/staging without writes, an input
override with five preserved output/cache components, save/preview/publication,
a later parent publication, lazy historical-source lookup and the exact historical
parent link. It also verifies copying an unsaved change without saving its source,
rejection of a private parent in a global child, component reset, and actual file
export/import. Historical source layout is checked in all seven locales at
desktop/light and 390-pixel/dark widths. Mock-provider call count is zero.

A subsequent isolated browser run verifies the remaining inheritance editor
contracts: revision conflicts retain local edits and compare both content and
recipe, explicit reload restores the server revision, unavailable parent reads
lock edits until retry, and a corrupt lineage preview cannot save anything.
A held preview prevents workspace switching. Read-only validation issues no
administrator-only preview calls, and another workspace cannot see the private
child or its parent metadata.

The same run verifies complete parent switching, canonical calendar time-zone
normalization, calendar reset, and whole-group reset without losing unrelated
input/cache overrides. Rollback requires acknowledgement before discarding dirty
fields; declining preserves the edits. Confirmed rollback uses the original
immutable price and lineage, not the unsaved edits.

Browser evidence exposed two feedback defects that are now fixed: long-editor
errors were offscreen, and successful parent staging retained an obsolete error.
Feedback now scrolls into view and receives keyboard focus; verified staging
clears the old error. The final frontend checks/build pass with existing bundle
caps unchanged (pricing route 18.02 KiB gzip, request-cost 6.72 KiB).

All seven locales have editor and parent-picker desktop/light and 390-pixel/dark
layout evidence: 28 additional surface/layout cases without horizontal overflow,
plus keyboard arrow navigation and focus checks. Visual captures wait for CSS
transitions to finish; intermediate theme-animation frames are not counted as
visual acceptance. Both isolated runs used zero model calls and their owned
browser/backend fixtures are stopped. This does not complete the whole pricing
Goal or waive its remaining media, coverage, reports and operational gates.
Full regression and source identity are reported in the progress document rather
than inferred from these focused tests. No test or migration in this document
authorizes a production deployment, restart, price activation or Git push.

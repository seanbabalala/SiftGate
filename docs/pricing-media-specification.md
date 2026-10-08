# Media specification authority

A media size, resolution or quality can be fixed by a model contract or selected
by request parameters. These are different inputs to pricing. Model names never
supply implicit specification defaults.

## Explicit immutable contract

An optional price-book field declares model-fixed attributes:

```json
{
  "media_specification": {
    "fixed": {
      "size": "1024x1024"
    }
  }
}
```

This is part of the complete price-book content, version and hash. The supported
fixed attributes are size, width, height, quality, resolution, frame rate and audio
track. Operation, audio direction and generation quantity are not overridable
model-fixed values. Quantities and their evidence continue to use the existing
metering contract; a fixed size does not invent an image or video count.

Omitting this field preserves legacy adapter selection and its historical trace
shape. An explicit empty `fixed` object enables source tracing without overriding
adapter-selected values. Fixed values are bounded specification identifiers, not
scripts, URLs or an unrestricted metadata payload. Do not enter private
identifiers in specification fields. Blank fixed values
are invalid, not a default, a free price or restored inheritance.

For a fixed attribute, request parameters do not select another price variant.
The original supplied value/source remains visible. A conflicting or invalid
provider-reported value makes the cost unpriced with a stable diagnostic rather
than selecting either a cheaper rate or the configured fixed rate. A valid model
response still reaches the caller; unknown fees and unresolved budgets retain
the existing policy semantics.

Fixed attributes are administrator declarations of a supplier/model contract,
not observations of the generated media or supplier invoice confirmation. Verify
the binding and contract before publication. The review never labels remote model
support or quantity limits as verified merely because an adapter is implemented.

## Adapter declarations and historical evidence

The generic media extractor declares provider-result precedence followed by
request-parameter fallback for supported specification fields. Operation and audio
direction are operation facts; requested generation-count conditions are request
parameters and are separate from actual output quantities. The existing native
video profiles declare their implemented request-derived fields, not undocumented
provider results or model-name-derived defaults. An unspecified video profile is
shown as conditional candidate adapters, not proof of one vendor contract.

Authenticated media events label their supplied specification fields as provider
results, overriding the original request-source labels. Their dedicated normalized
event adapter remains distinct from native request-only profiles. Tasks created
before source capture retain their old observation shape rather than having
historical provenance synthesized. Event-adapter declarations are conditional on
a separately configured authenticated source; they do not enable a connector.

Metering review version 5 contains the explicit fixed attributes and per-adapter
source declarations. Publishing an explicit specification contract requires an
explicit supported media operation. Older review versions remain readable; a
version 5 response missing this new contract metadata is rejected by the client.

For requests using the explicit contract, `selection.media_specification` records
the resolver version, actual adapter, effective value, source, supplied value and
source, invalid-evidence flag and conflict flag. Only allowlisted bounded fields
are retained. No image/video bytes, prompts or raw provider response are added.
Missing provenance is displayed as unrecorded, not as provider evidence.

Replay uses the originally supplied specification captured in that trace, not a
previous tariff's fixed replacement. For example, replaying a 1024-fixed tariff
against a new parameter-based draft can recover the original 512 request choice.
The original receipt and budget are not changed. Old records without this trace
remain legacy evidence; no source provenance is invented for them.

## Dashboard and inheritance

The Media editor enables the explicit contract and selects adapter-derived or
model-fixed values per attribute. Switching to fixed requires an explicit value.
Disabling the complete specification or restoring the inherited specification
requires confirmation because either action can discard local settings. Cancelling
preserves the draft; confirmed restoration removes the local override and uses
the fixed parent version. Enabling an empty contract does not require deletion
confirmation. See the [native editor acceptance](pricing-editor-completion.md).
Published versions remain read-only; changes use draft validation, preview and
publication. The simulator allows explicit hypothetical source/adapter input,
and changing either invalidates the previous result. It does not call a supplier.

Publication review displays the adapter declarations and contract warnings.
Request cost details distinguish the supplied value from the value used for
pricing, with an explicit conflict message. All new text is localized in the
seven existing languages. Optional controls, detail display and mutation-response
validation are loaded on demand without increasing the established bundle caps;
validation loads before sending preview/publication requests, not after a mutation.

Inherited prices retain the parent's immutable specification contract. An explicit
settings override can replace it; a null override removes it. The Dashboard also
has a separate restore-inheritance action. Copy, export, import and parent updates
do not silently flatten or rewrite the contract.

## Verification and compatibility boundary

Synthetic unit and real-HTTP cases cover fixed versus parameter/result selection,
missing and invalid metadata, contradictory provider output, retained trace
validation, source-aware replay, inheritance, publication guards and async task
version pinning. Actual image quotes, receipts, budgets and log amounts agree;
a contradictory result remains unknown while delivery succeeds. An async video
uses its original fixed contract after a later publication, and a subsequent
request uses the new contract.

There is no physical database migration or production configuration change in
this feature. The unchanged migration-marker set does not certify that an older
binary understands the new price-book/receipt fields or review version 5. Use the
candidate's source identity and existing database-aware rollback procedure rather
than assuming blind downgrade is safe.

This is part of the isolated pricing candidate, not deployment approval. Full
original Goal acceptance, the separate PostgreSQL performance target and final
fixed-source/platform delivery remain required.

## Original RULE-05.4 acceptance map

The original clause requires an adapter declaration distinguishing model-fixed
specifications from request-selected specifications. This checkpoint verifies
that clause, **not all six RULE-05 clauses or the complete Goal**.

| Boundary | Implementation | Passed evidence |
| --- | --- | --- |
| Explicit authority | [Contract and resolver](../src/pricing/media-specification.ts), [immutable types](../src/pricing/media-specification.types.ts) | Fixed model versus request/result selection; no inferred defaults; malformed/absent values; legacy trace compatibility |
| Adapter declarations | [Metering review](../src/pricing/pricing-metering.ts), [generic extraction](../src/pricing/media-metering.ts), [native profiles](../src/pricing/video-result-profile.ts) | Generic result/request precedence, native request-derived fields, operation guards, declaration/hash binding and unverified supplier support |
| Signed results | [Supplier event normalization](../src/pricing/media-supplier-event.ts) | Real authenticated HTTP event overrides request provenance; conflicting provider specification remains unpriced; legacy task context remains unchanged |
| Retained evidence | [Replay](../src/pricing/pricing-replay.service.ts), [outcome boundary](../src/pricing/pricing-outcome-document.ts) | Source-aware replay, strict retained trace validation, unchanged original receipts and async version pinning |
| Configuration lifecycle | [Inheritance](../src/pricing/pricing-inheritance.ts), [editor](../frontend/src/components/pricing/media-specification.tsx) | Immutable parent, explicit override/removal, export/import and actual UI restore-inheritance |
| User-visible result | [Unit cases](../test/unit/media-specification.spec.ts), [HTTP cases](../test/e2e/media-specification.e2e-spec.ts) | Actual quote, receipt, budget and log integration; valid response survives a contradictory specification; UI draft/publication/history workflow |

The new test files contain 26 unit assertions and six HTTP assertions. The
complete final regression passes **4,229 unit tests in 205 suites and 807 HTTP
tests in 65 suites**, without skips. Backend build, lint, frontend contracts/build,
SDKs, configuration, documentation and static deployment checks pass. The pricing
route remains 23.40 KiB gzip within its unchanged 24 KiB budget. Migration001–018
checksums and database durability settings are unchanged.

The final application run is bound to a 1,387-file source manifest with SHA-256
`923e600f2576e465788c23309cd91c2c2a25d9b3614c6cbe46cd59e27cd1c2ae`.
Only this document and the progress report were added/updated afterward; the
application and its compiled artifacts were not changed by documentation.

Real-browser acceptance covers five views in each of seven locales and two
layouts: explicit editor, fixed cost, adapter-selected cost, provider-conflict
cost and publication review. All 70 read-only cases preserve the same 38-table
pricing/budget/log snapshot, configuration hash and synthetic supplier-call count.
External fonts are blocked; no requests are allowed outside the fixture origin.
This is a synthetic local mock environment, not a supplier integration certificate.

A separate actual browser workflow restores a child's inherited specification,
compares a draft with the published version, changes hypothetical evidence source,
saves, reviews and publishes. A two-image request still costs USD0.4 after saving
the USD0.2 draft; only a new request after publication costs USD0.2. The earlier
USD0.4 receipt remains byte-equivalent. Provider-result contradictions in simulation
remain unknown, and source/adapter edits invalidate a prior simulation. Viewer
controls are read-only. These are fixture rates, not current commercial prices.

Earlier failed runs are retained: stale review-version expectations, a synthetic
fixture violating the dedicated callback-secret prefix, an over-budget frontend
chunk and the actual signed-event provenance bug. The latter has a retained
failing pure calculation and corrected calculation plus authenticated HTTP coverage.
No test timeout, accounting assertion, provider-secret restriction or bundle cap
was relaxed. One supplemental visual capture used a wrong label and timed out;
its log is retained. The original long simulation screenshot was clipped by its
scroll container, so it is not accepted as a complete visual proof. Smaller,
fully visible draft/published screenshots were captured in a second unchanged,
read-only fixture and inspected.

All owned browser servers and PostgreSQL fixtures were stopped after verification.
The production process, release identity and selected user-confirmed configuration
hashes remain unchanged. No commit, push, container build or deployment was made.
The original PostgreSQL performance target and remaining Goal requirements remain
open; this is not a final review-ready candidate.

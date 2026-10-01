# Pricing publication: metering review

A saved tariff is not proof that a provider returns the quantities it charges for.
The candidate pricing editor and publication/rollback previews now include a
versioned **metering review**. It inventories implemented extraction paths and
keeps supplier support and quantity-limit verification explicitly false. It does
not call a provider, inspect private content, invent limits, or enable a provider
feature such as Priority merely because a price rule names that tier.

## Evidence classes

| Availability | Meaning |
| --- | --- |
| `conditional` | The integrated path can extract a recognized field or supported local measurement, but the actual receipt may be absent, invalid or estimated. |
| `request_metadata` | A distinct, explicitly request-billed quantity. It is not actual output and does not prove a provider maximum. |
| `local_measurement` | A local invocation counter; missing failure evidence still does not become confirmed free usage. |
| `manual_only` | The selected native profile cannot extract that actual quantity. Separate authenticated supplier evidence or reviewed attestation is required. |
| `unsupported` | No integrated extraction/settlement path supports that operation and dimension. |

The registry covers the admission-operation inventory, including the three public
chat entry formats, embeddings, rerank, image operations, audio operations and
video generation. Ordinary provider token fields remain conditional. The raw Chat
adapter now extracts five documented modality subsets for compatible routes;
native Gemini additionally supports array-based cache attribution and image
output token evidence; media retains its separate field schemas. These are conditional, not support
claims for every native protocol or model. Missing/cache-unattributed quantities
remain unknown; see [chat modality evidence](pricing-chat-modality.md) for exact
fields, reservation requirements and unimplemented native-path boundaries.
`gemini_generate_content` is an upstream schema name, not an implemented public
ingress controller. Binding to that name does not enable an endpoint; native
Gemini metering runs behind the public chat APIs. See
[native Gemini evidence](pricing-gemini-metering.md) for supported totals,
thinking, modality and cache relationships.
[Native Realtime session pricing](pricing-realtime.md) is integrated separately;
other Live protocols cannot be enabled merely because the calculator knows the unit.

Explicit native video profiles report output counts, not actual aggregate output
seconds. Their `video_seconds` review is `manual_only`; requested seconds remain
a separate request quantity. This reuses the existing authenticated supplier and
attestation workflows, not a new route that trusts arbitrary unauthenticated
webhooks. See [native profiles](pricing-native-video-profiles.md) and
[supplier evidence](pricing-media-supplier-events.md).

A binding without an operation is shown as unscoped. Its compatible-operation
list means **at least one implemented path can represent the entire billing
basis**, not that every possible route/model supports it. A model/global binding
does not pin every eligible node's native video profile. Explicit node bindings
include the currently selected profile without exposing its URL or credentials.
If no integrated operation can represent the full billing basis, publication and
rollback fail with `pricing_metering_unsupported`; drafts remain editable and
previews remain read-only. This also rejects combinations of individually known
units that have no single compatible integrated operation.

## Publication and review identity

The existing draft validation/import, publication preview and rollback preview
responses expose `metering`. A review includes:

- `schema_version`, `registry_version` and the immutable price `content_hash`;
- each binding target, selected native profile, compatible operations, dimension
  availability and structured notice codes;
- `can_publish`, `supplier_support_verified: false`, and
  `quantity_limits_verified: false`;
- `assessment_hash`, SHA-256 of the canonical review body.

The editor displays the notices before its separate publish confirmation. It
validates the response hash, content and targets and blocks unsupported reviews.
It sends the reviewed `metering_assessment_hash` in the existing publication or
rollback body. The repository recomputes the assessment inside the publication
transaction. If the selected profile or reviewed content/targets no longer
match, it returns 409, preserving the draft and active catalog. The administrator
must preview and confirm again; a previous checked confirmation is cleared after
an error or a new preview.

For compatibility, programmatic callers may omit the review hash, but they do
not bypass unsupported-operation checks and their audit records do **not** claim
that a review was confirmed. A successful publication stores the exact review
and `metering_review_confirmed` in its existing workspace-scoped audit event.
Old price versions and historical costs are not modified. New metadata uses
existing tables; no pricing migration changes are needed.

The check is a publication-time view, not a permanent lock on routing/node
configuration. Subsequent configuration changes can change extraction capability
for new calls. In-flight media tasks retain their original profiles, while
unknown/malformed usage continues to follow the existing explicit cost-state and
admission-policy contracts. It is not safe to label a binding “fully metered”
forever based on one successful preview.

## Contracts and limits remain explicit

Service-tier names do not verify a particular model's contract. Provider
acceptance/completion timestamps may not exist, and native video translators do
not manufacture them. The review surfaces these conditions without changing the
selected time basis or substituting requested quantities for actual output.

Administrator-supplied quantity limits remain conditional assertions tied to a
reference. The metering review neither proves them nor increases a reservation.
[Admission assessment](pricing-admission-policy.md) remains authoritative for
exact quantities, parent bounds, the frozen rate envelope, policy and overrun
reporting. The [Dashboard admission simulator](pricing-admission-simulation.md) exposes
that separate read-only assessment without applying it. Operators must confirm
real model support, contract source, permitted variants and limits before
activating their prices/policies. No vendor rates or universal GPT thresholds are
embedded in this feature.

## Validation boundary

Tests cover operation/dimension compatibility, conditional versus request-billed
quantities, actual native translator fixtures, impossible combinations,
publication/rollback profile races, read-only previews, audit provenance and
workspace/role protection on SQLite and PostgreSQL. Frontend contracts check
hash/target validation, unsupported publication blocking, confirmation reset and
all seven locales. Real-browser acceptance and final fixed-source regression are
recorded in [implementation progress](pricing-engine-progress.md), not inferred
from this document alone.

This is not the entire [pricing Goal](pricing-engine-goal-spec.md). Remaining recovery/capacity and coverage boundaries, retention,
performance, Linux/Docker and candidate/rollback delivery remain required.

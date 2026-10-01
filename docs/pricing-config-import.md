# Whole legacy gateway pricing import preview

`pricing-import` is an offline, read-only migration preview for an entire gateway
configuration. It is separate from `pricing-migrate`, which manages the database
schema. Neither a successful preview nor an existing price field activates a new
price or proves that the gateway captures its usage.

The [migration review attachment](pricing-migration-delivery.md) includes current
compiled CLI output, a synthetic portable input/catalog pair and an optional
strictly disposable SQLite rehearsal. It does not grant production migration
or price-publication approval.

```sh
siftgate pricing-import --config ./review/gateway.yaml --dry-run
siftgate pricing-import --config ./review/gateway.yaml \
  --catalog-file ./review/catalog-snapshot.json \
  --at 2026-09-29T00:00:00Z --dry-run
```

The configuration path is mandatory. There is no default production path and no
`--apply`, `--output`, database option, secret expansion, catalog refresh or model
request. Output goes to standard output; redirect it only to a separately chosen
review artifact, not over the input file. Explicit `--at` makes freshness metadata
and the complete plan reproducible. It does not select current supplier prices.

## Input and inventory

Configuration input is one UTF-8 YAML or JSON document. YAML anchors and merge
keys retain their normal precedence; duplicate keys and executable/custom tags
are rejected. Date-like source metadata remains text. Each file must be a regular
file of at most 4 MiB. Expanded graphs are bounded by depth, visits and byte size;
cycles and prototype keys are refused. Invalid file/parser errors do not echo the
file path, YAML source snippet or credentials.

Model identifiers are opaque: Unicode, `@` prefixes and version punctuation are
preserved, not normalized into different names. Empty/oversized identifiers,
control characters, prototype keys, URLs and recognizable credentials in identity
fields are rejected rather than echoed or silently changed.

The inventory includes:

- every `models_pricing` entry;
- node model lists for text, embedding, rerank, image, audio, video, Realtime and
  batch operations;
- alias targets, upstream-model alias keys and hidden `model_capabilities` entries;
- explicit node price overrides, inherited gateway-model prices, or catalog
  fallback references.

Provider connection fields, secrets, prompts, plugin contents and unrelated
configuration are not copied into the output. This is a pricing migration check,
not a full validation of connection settings or other gateway features.

The optional catalog file must be a resolved `ProviderCatalog` snapshot with
`version: 1` and a `providers` array. It is not a live URL or an override to merge
with files from the current directory. Existing provider-ID/alias/base-URL model
matching is reused. No built-in, downloaded or ambient override catalog is consulted
when the file is omitted. Unresolved catalog fallbacks stay explicit; the plan
must not invent their prices.

`complete_source_resolution` means that every inventoried target has an explicit
source in these inputs. It does **not** mean that all quantities are supported,
the source is approved, token prices exist, or migration is ready to publish.
Media-only catalog entries can have a known source and no token draft.

## Preserving legacy behavior

The runtime and preview share a side-effect-free compatibility resolver:

1. A complete node-model price object overrides the gateway-model object.
2. Otherwise the gateway-model object applies.
3. Otherwise an explicitly supplied catalog provides a fallback for the preview.

A node override is not a field-by-field merge with its gateway-model price. The
report's `inherits` field records the original lookup relationship; it is **not**
a published price-book parent ID or an automatically attached inheritance recipe.
Review that relationship before binding a materialized draft. Publishing a node
price can intentionally stop future gateway-model fallback, which is a separate
administrator decision.

Legacy cache inference depends on model names, protocol, compatibility profiles
and upstream model aliases. Two nodes inheriting the same gateway-model prices
may therefore have different effective cache rates. The preview retains those
context-specific values, explicit zeroes, cache aliases and legacy input-price
fallbacks, and lists the changes under `differences`.

Existing six-decimal JavaScript rounding is preserved in this compatibility
calculation, including its binary half-boundary behavior. The report converts the
resulting values to decimal strings rather than claiming that old floats were
originally exact decimals. The new deterministic pricing engine does not acquire
model-name inference from this helper. Generated token drafts remain
`source.kind: legacy`, and their computed costs remain `legacy_estimate`.

## Review output

The `siftgate-legacy-pricing-plan-v1` document includes target/source identities,
aliases, sanitized declared and effective prices, explicit differences, token
draft suggestions, media references, diagnostics and integrity hashes. Hashes
identify the supplied document/plan; they are not supplier attestations.

- Numeric price values use decimal strings. Missing, explicit zero and inherited
  prices remain distinct.
- Source type, confidence, review flags, dates and other recognized provenance
  are retained. Recognized credentials, supplied opaque secrets, URL credentials,
  queries/fragments and machine-local references are redacted from text metadata.
- Unrecognized price fields produce `field_not_migrated` diagnostics rather than
  being executed or silently used as a price. The original file is unchanged.
- Media price fields remain `metering_verified: false`. A per-second or per-image
  reference is not evidence of actual audio/video duration or generated quantity.
- The legacy token adapter historically uses USD. If input metadata declares CNY
  or another currency, the proposal preserves that declared currency and emits
  `legacy_currency_mismatch`, alongside `legacy_currency: USD`. This is an explicit
  difference requiring review and FX configuration, not an equivalent automatic
  currency migration.

At most 256 nodes, 4096 gateway-model prices, 4096 catalog models, 8192 resolved
entries and 16 MiB of output are accepted. Larger inputs require deliberate
partitioning; partial output is not reported as a complete successful migration.

## Dashboard API

The existing viewer-readable, authenticated
`POST /api/dashboard/pricing/import/validate` also accepts:

```json
{
  "format": "legacy-gateway-config",
  "content": { "models_pricing": { "example-model": { "input": 1, "output": 2 } } },
  "evaluated_at": "2026-09-29T00:00:00Z"
}
```

An optional `catalog` contains the same explicit snapshot as the CLI. This route
reads only the supplied document; it does not export the gateway's running
configuration. Existing workspace/authentication and request-body limits apply,
including deployments whose HTTP limit is lower than the CLI file limit. It
creates no drafts, audit entries, request snapshots, reservations or model calls.
The existing single-book and inherited-book import formats remain unchanged.

The whole-configuration report is currently a CLI/API review artifact, not an
atomic multi-book publication or a Dashboard wizard. A `token_draft` is a proposed
single-book document that can be reviewed with the existing editor. Publishing,
attaching immutable parents, selecting bindings and changing budget policy remain
separate explicit operations. Do not upload production credentials unnecessarily;
prefer a pricing-only copy for review even though output is sanitized.

## Verification and deployment boundary

Synthetic unit/CLI tests cover precedence, cache aliases and zeroes, merged YAML,
exact legacy rounding, supplied catalog selection, media-only references, malformed
input, bounded graphs and secret-safe errors. HTTP tests compare proposed rates to
the real isolated `ConfigService` and verify byte-identical input files, unchanged
pricing/budget/log tables, no configuration reload and no provider calls. Draft
simulation retains the expected legacy estimate instead of creating active prices.

This preview does not replace a database migration or a populated-database rollback
rehearsal. It does not modify historical costs, convert all models to new bindings,
or authorize deployment of the candidate gateway.

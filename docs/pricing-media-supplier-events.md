# Authenticated, ordered media evidence

This is the normalized `siftgate-media-v1` connector protocol, not a claim of
native compatibility with every supplier webhook. A trusted connector must first
verify its supplier's event using that supplier's documented authentication and
translate it into this complete, bounded snapshot. No connectors are enabled by
default. A dashboard or gateway API key does **not** authenticate an event.

This implementation is part of the pricing development candidate. It does not
authorize production migration, configuration, activation or restart.

## Source registration

Workspace administrators can configure a source through
`PUT /api/dashboard/pricing/media-event-sources/:id`. The usual dashboard
session, workspace role, trusted origin and JSON rules apply. Full gateway
instances recheck administrator membership under the workspace writer lock.

Required fields:

- `revision`: `0` to create; the exact current revision to update.
- `node_id` and `credential_id`: the original provider connection/credential.
- `secret_env`: a dedicated variable named `SIFTGATE_MEDIA_EVENT_<NAME>`.
- `enabled`: explicit boolean.
- `reason` and `confirm: true`: mandatory audited change consent.

The dedicated signing key must already be available to the process. Enabled
sources require 32–4096 bytes; use a high-entropy, independent signing secret.
Do not reuse a provider key or a dashboard/gateway token. Arbitrary environment
variables and secret-reference expressions are rejected. Only the variable name,
never its value, is persisted or returned.

The server records the node connection fingerprint. Updates can disable the
source or rotate its configured signing variable, advancing its revision. They
cannot retarget the source's node, credential or connection fingerprint; create a
new source for a different provider identity. Historical receipts retain the
original source authorization audit even after rotation.

`GET /api/dashboard/pricing/media-event-sources` requires operator access.
The listing supports workspace-bound keyset pagination with `limit`, `cursor`
and `next_cursor`. The seven-language source configuration and task lookup UI
are implemented; see [task inventory and lookup](pricing-media-job-lookup.md).

## Event contract

Send JSON to `POST /api/pricing/media-events/:sourceId` with these headers:

- `x-siftgate-media-time`: ten-digit Unix seconds for this delivery.
- `x-siftgate-media-revision`: current source revision as a decimal string.
- `x-siftgate-media-signature`: `v1=` followed by the lowercase SHA-256 HMAC hex.

The signature input is the UTF-8 concatenation below. Newlines are literal LF,
with no final newline:

```text
siftgate-media-v1
<SOURCE_ID>
<SOURCE_REVISION>
<DELIVERY_UNIX_SECONDS>
<CANONICAL_EVENT_SHA256>
```

The event hash uses `canonicalPricingJson`: object keys sorted lexicographically,
arrays in their original order, and JSON scalar/string encoding without extra
whitespace. Quantities and sequence numbers are strings, not JSON numbers.
The delivery timestamp may differ by at most five minutes from the gateway's
clock. Retries outside that window use the same event ID and event body but a
fresh delivery timestamp/signature. Reusing an event ID with a different body
is a conflict, not a new correction.

A complete event contains:

| Field | Contract |
| --- | --- |
| `schema_version` | `1` |
| `event_id` | Stable opaque event ID, at most 128 characters |
| `task_id` | Exact gateway attempt/task ID, not an arbitrary request alias |
| `provider_job_id` | Exact opaque provider job identity, at most 160 characters |
| `sequence` | Canonical nonnegative integer string, at most 30 digits |
| `status` | `pending`, `completed`, `failed`, or `cancelled` |
| `accepted_at` | Absolute ISO timestamp with offset |
| `completed_at` | Absolute timestamp for terminal events; `null` for pending |
| `time_quality` | `observed` or explicitly `estimated` |
| `evidence` | At most 40 `{dimension, value, quality}` entries |
| `media` | Optional allowlisted actual media specification |
| `resolved_service_tier` | Optional actual resolved tier |

The payload limit is 32 KiB. No prompts, output/media bytes, raw responses,
credentials, arbitrary URLs, invoice totals or executable expressions are accepted.
Known quantities require exact nonnegative decimal strings and explicit quality;
missing/unsupported quantities require `null`. Duplicate dimensions, invalid
partitions, negative/fractional counts and request-owned `requested_*` overrides
are rejected. Original request quantities are retained from the frozen task.

This is a **complete snapshot**, not an additive usage delta. Sequence numbers
must come from a trustworthy monotonic job revision. Do not manufacture ordering
from webhook arrival time. Suppliers without verifiable event ordering need
explicit reconciliation rather than automatic translation into this protocol.

## Admission, ordering and unknown submissions

The registered workspace, original node fingerprint and credential must match
the task. A missing post-submission credential can only be recovered from the
persisted physical dispatch attribution; the connector cannot choose a new one.
Reserved/not-yet-dispatched and synchronous tasks do not accept these events.
An already pinned provider job cannot be changed.

A signed event with the exact original task identity can recover an `uncertain`
submission and supply its previously unknown provider job ID. It never sends
another generation request. This does **not** solve missing correlation when the
supplier/connector cannot identify the original gateway task. For a known gateway
task and a separately investigated provider job, the administrator can use the
[pinned lookup workflow](pricing-media-job-lookup.md), with explicit attestation
rather than an inferred association.

For an accepted task/source pair:

- Repeated same-ID/same-content delivery acknowledges the retained receipt.
- Lower sequences are retained as `ignored_stale`, without repricing.
- A different event at the same sequence is `review_required`.
- Pending after terminal is retained as `ignored_regression` and cannot reopen
  or release the task. Its ordering head still advances.
- Newer terminal evidence creates a durable observation and, when necessary,
  a linked cost adjustment under the original price/FX snapshot.
- A task cannot silently switch ordered sources. A provider connection/job key
  has a unique ordering owner, preventing multiple event heads for the same job.

Receipt, required audit, ordering head and observation commit together under the
existing request/task locks. Financial processing then uses the existing durable
media observation/settlement path. If it fails, `processing_pending: true` reports
that evidence is retained but processing still needs recovery. It is not a
reason to dispatch another paid request. An actual child-exit test verifies the
boundary between retained authenticated evidence and financial application.

`202` means the event was retained with the stated decision. Neither a successful
signature nor local pricing is supplier invoice confirmation:
`supplier_invoice_confirmed` remains `false`.

## Unordered observations and custody

Once an ordered source owns a task, a later unversioned status/poll observation
cannot be assumed newer. Its normalized metadata is retained for review instead
of automatically undoing the ordered receipt. Identical alternatives are deduped.
The original polling-only flow remains available for tasks without an ordered
source. No source-head lookup is added to ordinary token request pricing.

`GET /api/dashboard/pricing/media-tasks/:id/supplier-events` provides a scoped,
operator-only receipt summary with hashes, sequence, decision and observation ID.
The list now supports `limit`, `cursor` and `next_cursor`, and an operator can read
an individual retained normalized event by ID. Disposition and the source/task
operator UI are still required.

Each task can retain at most 4096 supplier/unversioned event records. New records
beyond that bound return a retryable storage-capacity error; existing exact
retries still work. Nothing is evicted or silently marked delivered. Coordinated
retention, operator disposal and capacity alerting remain part of the complete
Goal, not a completed operational guarantee at this checkpoint.

## Storage and verification

Additive migration `pricing-engine-013` introduces source registration,
immutable event custody and ordering-head tables. All 001–012 definitions and
checksums are preserved. Source authorization, task, observation and audit
references are restrictive; deleting a required parent record is not a cleanup
strategy. A missing ordering head with surviving applied-event evidence fails
closed instead of restoring unordered automatic settlement.

Verification covers strict signatures/quantities, source scope/revision,
immutable original pricing, signed unknown-job recovery, duplicates/stale/conflict
ordering, terminal regression, unordered custody, source rotation, required-audit
rollback, concurrent delivery and actual process exit. SQLite WAL and an owned
PostgreSQL instance are used. Full results and remaining work are tracked in
[the pricing progress record](pricing-engine-progress.md).

The task/source/job-lookup Dashboard is now implemented with separate browser
acceptance: [media operator Dashboard](pricing-media-dashboard.md). Earlier UI
worklist statements above are superseded by that checkpoint; alternative-event
disposition and the remaining whole-Goal requirements are not waived.

## Operator decisions

Retained alternatives can be accepted or rejected through the separate
[audited disposition workflow](pricing-media-event-disposition.md). This never
changes their original custody decision. Accepting unordered evidence requires
manual review of future updates until an administrator explicitly accepts a
signed sequence to resume ordering.

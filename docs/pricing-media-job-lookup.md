# Media task inventory and unknown-job lookup

The media inventory and job-lookup APIs extend the signed media-event backend.
They are development-candidate functionality, not permission to migrate, activate
or restart a running gateway. No operation in this workflow generates media.

## Scoped keyset inventories

All dashboard paths below are relative to `/api/dashboard/pricing`. Existing
session, workspace, role, JSON and trusted-origin restrictions apply.

| Method | Path | Permission and purpose |
| --- | --- | --- |
| GET | `/media-tasks` | Operator; persisted task inventory |
| GET | `/media-tasks/:id` | Operator; task metadata and original cost ledger |
| GET | `/media-event-sources` | Operator; source registration inventory |
| GET | `/media-tasks/:id/supplier-events` | Operator; event receipt inventory |
| GET | `/media-tasks/:id/supplier-events/:eventId` | Operator; retained normalized event and integrity hashes |
| GET | `/media-tasks/:id/job-lookup-basis` | Operator; current eligibility and basis hash |
| POST | `/media-tasks/:id/job-lookup/preview` | Administrator; no-write pinned status lookup and cost preview |
| POST | `/media-tasks/:id/job-lookup` | Administrator; recheck and apply the reviewed job association |
| GET | `/media-tasks/:id/job-lookups/:operationId` | Administrator; durable acknowledgement of the applied operation |

Inventory queries accept `limit` from 1 to 100 and an optional `cursor` returned
by the previous page. Task inventory also accepts `view`: `all`, `uncertain`,
`pending`, `terminal`, `settled`, or `review_required`. Cursors are bound to the
workspace, resource type and task/view, and advance by immutable creation time
plus ID. Equal timestamps do not duplicate or omit entries. Changing a view
requires starting a new cursor chain.

`next_cursor: null` means the current traversal is exhausted. This is a live
inventory, not a frozen report: concurrent state transitions can move tasks
between views. `review_required` currently means a retained alternative exists;
it is not a claim that a complete operator-disposition workflow is implemented.
The inventory covers persisted media tasks, not all gateway traffic. It does not
include raw task configuration, prompt/media bodies or resolved credentials.

## When a job can be associated

This workflow is for an existing gateway task whose submission outcome is
`uncertain` and whose provider job ID is not yet known. The administrator supplies
an opaque job ID found through a separate operational investigation. The lookup
must use the original node connection and original physical dispatch credential.
There is no administrator-selectable credential, URL, request body or header.

The basis blocks tasks with known jobs, an ordered source owner, unverified
credentials, terminal evidence, existing budget decisions or active controls.
Only the original workspace may inspect or reconcile the task. The existing
request snapshot, reservation and physical attempt must still agree.

An authenticated status response proves that a job exists under that provider
account; it does **not** alone prove which client request created it. The mapping
is explicitly recorded as `association_source: administrator_attestation` and
requires the administrator's reason and confirmation. Supplier invoice
confirmation remains false. When that operational association cannot be made
reliably, leave the task unknown; do not guess or resend generation.

## No-write preview

The preview input contains only:

```json
{
  "provider_job_id": "YOUR_JOB_ID",
  "expected_basis_hash": "YOUR_CURRENT_BASIS_SHA256"
}
```

The server rechecks administrator authority, then makes a bounded status GET
through the original configured endpoint and credential. Redirects are rejected.
The response must identify the exact proposed job and a supported job state.
URLs, credential-like IDs and path-traversal segments are rejected before IO.
Only normalized allowed metering fields survive; response URLs, media content,
provider errors and arbitrary metadata are not returned or retained.

No task, lease, audit, observation, receipt or budget record is written by a
successful preview. Database locks are released before provider IO. Authority
and the original task basis are checked again afterwards. An administrator
removed while the GET is in flight cannot obtain a usable preview.

The response includes the normalized observation, its hash, a cost computed
from the original immutable price/FX snapshot, the cost hash and basis hash.
It does not use current prices or automatically approve the association.

Missing provider acceptance/completion timestamps are **not** invented from the
recovery request's current wall clock. Existing task instants remain explicitly
estimated where applicable; absent instants remain absent. If a pricing rule
requires unavailable time evidence, its diagnostic/partial cost remains visible.
A status lookup cannot manufacture a complete time-based charge. Later unversioned
polling preserves the same known/missing provider-time boundary from the immutable
reconciliation receipt. Operational task timestamps are not copied back into
pricing as new provider-time evidence. A missing receipt with its surviving audit
marker fails closed. Independently authenticated sequenced supplier events may
still supply genuinely newer time evidence through their own verified path.

## Confirmation, replay and crash recovery

Confirmation includes:

- A stable `id` for this operation.
- The same `provider_job_id` and `expected_basis_hash`.
- Exact `expected_observation_hash` and `expected_cost_hash` from the preview.
- A nonempty `reason` and `confirm: true`.

The server repeats the authenticated pinned GET and recomputes the original
snapshot cost. Changed job state, metering evidence, task basis, role or price
result rejects the proposal; the user must inspect a new preview. No client-
supplied raw provider body or cost computation can become the authority.

The job association, immutable reconciliation receipt, required administrator
audit and durable media observation commit atomically. A shared provider-job
identity lock coordinates these associations with signed callback claims, so
two tasks cannot claim the same connection/credential/job through different
workflows. The job association does not erase original dispatch or price records.

Financial processing uses the existing durable media settlement/adjustment
pipeline after that commit. `processing_pending: true` means the association and
evidence are retained but financial application still needs recovery; it is not
a successful final settlement. A linked pending job remains reserved and resumes
ordinary polling rather than settling early.

Retry the **same** operation ID and exact body after an uncertain reply. A stored
acknowledgement is checked against its audit and normalized observation; it does
not repeat provider IO or charge the reservation again. A different body or actor
cannot reuse the ID. Read-only acknowledgement can recover the applied operation
even after process exit. Changing prices or disabling a provider later does not
cause an acknowledged old operation to fetch a new charge.

## Storage and evidence

Additive migration `pricing-engine-014` introduces
`pricing_media_job_reconciliations` with restrictive task/observation/audit
references and unique operation, task and provider-job identities. All 001–013
migration definitions/checksums are preserved. The existing explicit migration
policy is unchanged; application startup does not migrate automatically.

Tests cover no-write previews, original credential/price use, changed evidence,
ID substitution, missing timestamps, role/scope changes, required-audit rollback,
concurrent independent connections, manual-versus-signed job claims, actual
process exit, pending-state preservation and exact receipt acknowledgement.
SQLite WAL and a separate owned PostgreSQL instance are used. Full results are
recorded in [the progress record](pricing-engine-progress.md).

The seven-language task/source/reconciliation UI and alternative-event disposition
remain separate required work. This API does not automatically correlate jobs,
resolve conflicting signed sequences, reconcile invoices, or waive retention,
reporting, performance and deployment acceptance gates.

The task/source/job-lookup Dashboard is now implemented with separate browser
acceptance: [media operator Dashboard](pricing-media-dashboard.md). Earlier UI
worklist statements above are superseded by that checkpoint; alternative-event
disposition and the remaining whole-Goal requirements are not waived.

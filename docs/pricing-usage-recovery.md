# Missing-usage recovery — administrator attestation

This undeployed [pricing Goal](pricing-engine-goal-spec.md) capability recovers a
missing **first accounting receipt** for an already recorded provider dispatch.
It does not reissue a model request, declare provider success, certify an invoice
or make an internal-budget decision. The seven-language Dashboard input workflow
is now implemented; trusted supplier ingestion remains unfinished Goal work.

## When this applies

An operator first inspects the existing connected recovery group. The selected
attempt must still be `dispatched`, with no original cost or adjustment history.
The selected physical invocation must have complete recorded membership.

- A fresh lease, asynchronous media ownership or a pending immutable settlement
  intent blocks this operation. Apply an existing intent through its own workflow.
- A terminal receipt cannot be overwritten, even when it is partial or unpriced;
  later evidence must use a linked correction. Missing-usage recovery is not an
  escape hatch around immutable receipts or required corrections.
  The [single-attempt correction API](pricing-attempt-corrections.md) now supports
  those terminal receipts with exact budget previews; shared batches continue to
  use the existing conserved batch correction API. The new single-attempt
  correction input UI is still required.
- Local-cache/synthetic attempts are not missing provider receipts.
- A released internal hold does not prevent recovering its supplier cost. The
  release and existing budget effects remain unchanged.
- Shared embedding usage is priced once and allocated using the immutable
  pre-dispatch manifest. A legacy unknown batch without recorded weights is
  rejected; equal shares and fabricated member quantities are not substitutes.
- A partially recorded or corrupted physical group is rejected for explicit
  reconciliation, not filled by guessing its remaining shares.

Lease expiry alone does not prove process death. This is a deliberate
administrator attestation, not an automatic orphan charge. A late actual owner
must not overwrite the resulting immutable receipt; its differing evidence
requires a linked correction. The old queued evidence must be retained meanwhile.

## API

Base path: `/api/dashboard/pricing/recovery-cases/:reservationId`.

| Method/path | Authority and behavior |
| --- | --- |
| `GET /basis` | Existing operator/admin fresh connected group and `basis_hash`. |
| `POST /missing-usage/preview` | Admin. Validate and price the entire affected physical invocation without writes. |
| `POST /missing-usage` | Admin. Recheck fresh group/CAS/ownership, then atomically persist first receipts, required audit and log projections. |
| `GET /missing-usage/:recoveryId` | Operator/admin. Read-only acknowledgement after checking the audit and every original recovered receipt. |

The two POSTs accept the same body. All figures below are synthetic metering
examples, not supplier prices or production data:

```json
{
  "id": "YOUR_UNIQUE_RECOVERY_ID",
  "attempt_id": "YOUR_RECORDED_ATTEMPT_ID",
  "expected_basis_hash": "YOUR_64_CHARACTER_LOWERCASE_SHA256",
  "reason": "Describe the review without prompts or secrets",
  "confirm": true,
  "evidence": [
    { "dimension": "total_input_tokens", "value": "1000" },
    { "dimension": "uncached_input_tokens", "value": "1000" },
    { "dimension": "output_tokens", "value": "100" },
    { "dimension": "cache_read_tokens", "value": "0" },
    { "dimension": "cache_write_tokens", "value": "0" },
    { "dimension": "cache_write_5m_tokens", "value": "0" },
    { "dimension": "cache_write_1h_tokens", "value": "0" }
  ]
}
```

Use a unique ID and the exact hash returned by the inspected basis. The example
placeholders must be replaced; they are not accepted literal hashes. Every
quantity is a decimal string or explicit `null` for missing. Tokens/counts are
integral; seconds retain decimal precision. Normalized cache-write quantities
are disjoint partitions, not duplicated totals. The API does not infer uncached
input or missing cache/TTL values from absence. Supply only quantities actually
attested; missing billing dimensions remain unknown rather than becoming zero.

Optional `conditions` may contain `resolved_service_tier`, `provider_accepted_at`,
`completed_at` and allowlisted `media` attributes. It cannot change dispatch time,
the requested tier, model, node or operation. Attested times cannot precede the
recorded dispatch; completion cannot precede acceptance. Attested time/media
conditions are explicitly estimated. Omitted completion time is not replaced by
the time the administrator happens to save the form.

Optional `evidence_digest` is a lowercase SHA-256 of an externally retained
review document, **not its content, path, URL or credentials**. A digest supports
correlation only; it is not proof that a supplier issued or approved that document.
The reason is redacted in the audit. Neither raw supplier responses nor prompt,
media or invoice document content is accepted by this endpoint.

Unknown fields, client money/rates, actor/scope overrides and client-declared
`provider_usage` provenance are rejected. Existing Dashboard authentication,
workspace RBAC, JSON and origin guards apply.

## Price selection and provenance

The service restores the original request catalog, calendar and FX snapshot.
It uses the recorded attempted node/model/operation, not current node settings.
Legacy fallback requires the stored legacy price body and version; current YAML
configuration cannot substitute for missing historical identity.

Administrator quantities have `source: request_metadata`, estimated quality and
the versioned `administrator-usage-recovery` adapter identity. Each receipt has
a localized `pricing_usage_attested` diagnostic. Explicit zero remains distinct
from missing, but manual zero is not authenticated supplier confirmation.
The attempt's error marker is `supplier_outcome_unconfirmed`: accounting receipt
availability is not proof that generation succeeded or a response was delivered.

Every response includes:

- `source: administrator_attestation`;
- `supplier_confirmed: false`;
- `budget_changed: false`;
- per-member original `cost`, `cost_hash` and request/reservation/attempt IDs;
- `basis_hash`, `id`, `dry_run` and `replayed`.

Unknown rates, conditions or quantities can still yield partial/unknown results.
Do not equate a persisted accounting receipt with a fully known supplier bill.
Use the preview and the normal status/quality fields to assess completeness.

## Atomicity and retries

The operation uses the existing connected graph and sorted request/attempt lock
order, then rereads all membership, lease, snapshot and evidence state. A changed
basis produces a conflict. The canonical first physical member selects the price,
regardless of which member the administrator opened. Exact proportional allocation
and the stored manifest determine every share; callers cannot submit member costs.

All recovered first receipts, the `cost.usage_recovered` audit and log projections
commit in one transaction. The audit records the actor, proposal/result hashes,
optional evidence digest and returned receipt evidence. Failure in a later member,
audit or log projection rolls everything back. No settlement intent, budget
effect, refund or case-as-budget-resolved write is made by this operation.

Proposal identity includes workspace, actor, anchor and normalized full input.
After a lost response or process exit, retry the **same ID and body**, or read its
acknowledgement. A concurrent exact retry is acknowledged after verifying the
original receipts. Different input/actor under the same ID conflicts. Later linked
corrections do not rewrite the original recovery receipt or its audit.

The group inspection bounds remain those of budget recovery. The serialized
result is additionally limited to 4 MiB before any writes. Oversized groups need
additional tooling, not silently truncated membership. No new migration is
introduced; explicit schema steps `001`–`007` remain unchanged.

## Dashboard workflow

Open **Pricing → Budget recovery → Review whole group → Recover missing usage**.
The dedicated lazy route keeps the usage form separate from internal-budget
decisions. Operator access is read-only; workspace administrators may submit.
Existing dirty/uncertain budget forms guard navigation into the usage form.

1. Explicitly choose the recorded attempt. The complete physical membership is
   shown, including when entered through a later batch member. Switching attempts
   requires confirmation and clears quantities, conditions and reason; amounts
   from one invocation cannot silently carry over to another.
2. Enter only attested quantities. The seven default token-partition fields are
   blank, never guessed zeros. Add/remove other metering dimensions as needed;
   quantities stay exact decimal strings. Omitted and blank values remain missing.
3. Optional condition fields accept an actual service tier, explicit-offset
   acceptance/completion times and supported media attributes. They cannot change
   the dispatched operation/target/time. The shared strict timestamp parser
   rejects invalid civil dates and implicit local times. Backend comparisons use
   absolute instants, not the lexical order of offset strings.
4. Enter a non-sensitive reason and optional document digest, then preview.
   The preview shows original/report currency, price and FX version, receipt
   hashes, exact formulas/multipliers, or conserved physical allocation shares.
   Partial/missing costs are distinct from explicit zero. The whole result remains
   administrator attestation, not invoice approval. Ten receipts are shown per
   page without dropping other members from the proposal.
5. Separately consent before recording. Every edit invalidates both preview and
   consent. Conflicts retain the draft and require a fresh group read/preview.
   Server ownership/manifest checks remain authoritative even when local form
   validation passes.

An ambiguous write freezes the exact ID/body and disables field changes. Query
the read-only acknowledgement or consent to retry the same proposal. A 404 alone
does not prove an earlier write cannot finish; abandoning the ID requires an
explicit warning. The UI validates response identity, complete membership,
`supplier_confirmed: false`, `budget_changed: false` and canonical receipt SHA-256.
A write/acknowledgement must also match every hash from its original preview.
An unverifiable response cannot be presented as confirmed success.

Before POST, only the sanitized proposal and bounded cost preview are saved in
versioned, workspace/actor/anchor-scoped `sessionStorage`. No arbitrary server
payload, prompt, provider response or credential is copied. Reload restores that
exact proposal after the initial group read; it does not restore consent. Storage
failure prevents submission. Verified completion removes the pending record.
This is a tab-local retry aid, not a durable accounting outbox; closing the tab
can lose it. Browser UUID/Web Crypto APIs must be available (the current browser
verification uses trusted loopback). Final deployment/browser-origin acceptance
remains an M6 responsibility.

Navigation guards and focused status feedback protect edits and uncertain writes.
Successful usage recovery refreshes pricing and log queries, not budget balances:
any budget decision remains a separate explicit operation.

## Verified coverage and remaining work

[Unit contracts](../test/unit/pricing-usage-recovery.spec.ts) cover preview,
frozen/legacy prices, exact quantities, disjoint partitions, physical conservation,
active/async/intent exclusions, audit/member rollback, role/scope/idempotency,
corrupt manifests, independent PostgreSQL connections and an actual child exit
after commit. [HTTP contracts](../test/e2e/pricing-usage-recovery.e2e-spec.ts)
inject failure after a mocked provider response, then exercise these endpoints,
real log projection, ambiguous acknowledgements, origin/RBAC and audit rollback.

Frontend contract tests exercise exact large quantities, invalid/offset dates,
missing vs zero, complete physical membership, ownership blocking, receipt hash
verification, scoped minimized storage and stable retries. Real isolated-browser
evidence includes no-write preview, lost successful reply followed by reload and
same-ID retry (one audit/two shared receipts), read-only partial-receipt
acknowledgement, unchanged budget tables, genuine conflict/reread with retained
draft, active lease and role views, new duration fields and consent invalidation.
All seven locales rendered at 375/640/1200 pixels without page overflow;
narrow/dark screenshots were inspected. All provider traffic was synthetic and
the browser fixture made zero model calls.

Still required for the full Goal: authenticated supplier receipt/event ingestion, quarantined
receipt inspection and correction, complete terminal-evidence UI workflows,
resumed-owner/older-writer lifecycle, full pre-durable-loss strategy, retention,
all-traffic reporting, Docker/performance and fixed-source candidate acceptance.
The existing retry buffer is not made durable by this API. A manual attestation
does not authorize discarding a retained, differing supplier receipt.

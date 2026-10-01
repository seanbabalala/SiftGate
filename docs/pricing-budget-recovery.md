# Audited internal-budget recovery

This extends [outcome recovery](pricing-outcome-recovery.md) in the undeployed
[pricing Goal](pricing-engine-goal-spec.md). It resolves **internal budget holds**.
It does not create supplier usage, certify invoices or make unknown upstream cost
free. The seven-language Dashboard now exposes this budget-only workflow.
Supplier-evidence reconciliation remains a separate, unfinished Goal requirement.

## Workflow and authority

Base path: `/api/dashboard/pricing/recovery-cases`.

| Operation | Permission and behavior |
| --- | --- |
| `GET /:id/basis` | Operator/admin. Reads a fresh, bounded, connected recovery group and its `basis_hash`. |
| `POST /:id/preview` | Admin. Validates the proposal, compares its basis and returns projected budget changes without writes. |
| `POST /:id/resolve` | Admin. Requires `confirm: true`, a reason and the same proposal ID/body. Applies all required member decisions and their audit atomically. |
| `GET /:id/resolutions/:resolutionId` | Operator/admin. Read-only acknowledgement of an applied proposal, after audit-result and member-decision integrity checks. No automatic retry or budget mutation. |

A proposal contains `id`, `expected_basis_hash`, `reason`, `confirm` and
`decisions`. Every still-reserved member needs exactly one decision:

- `release`: release the internal hold; preserve unknown or known provider cost.
  This is an explicit administrator decision, never an automatic inference that
  the provider did not charge.
- `commit`: name `budget_attempt_id` for an already recorded, priced attempt
  belonging to that hold. Its verified effective amount is used, not a caller-supplied
  price or the latest catalog. Known logical token totals are derived exactly;
  missing totals require explicit `logical_tokens` attestation. An explicit count
  cannot contradict already known totals.
  Cost-only linked corrections of an unresolved hold can supply the effective
  winner amount. The new budget intent keeps the initial receipt copies intact;
  its CAS basis verifies the effective revision, and subsequent corrections use
  the actually committed amount rather than charging the earlier revision again.
- `apply_recorded`: apply an existing immutable terminal intent as written. The
  administrator cannot replace its outcome or amounts with another decision.
- `reconcile_actual`: for an originally selected actual-upstream budget, derive
  the complete expense cohort server-side rather than choosing a logical winner.
  This can acknowledge a dispatch fence while leaving the hold `reserved` when
  evidence is incomplete. See [actual expense recovery](pricing-actual-budget-recovery.md)
  for authority, custody, period handling and temporary lifecycle boundaries.

Amounts are never accepted directly from this API. An unpriced or nonterminal
attempt cannot be used to guess a debit. Local-cache upstream zero remains zero,
while a cache commit retains its separately stored original logical-budget price.
Unknown attempts are returned in `unknown_attempt_ids`, and results carry
`budget_only: true`. A released hold does not complete missing supplier evidence.
Missing first receipts can separately use the [administrator usage-attestation
API](pricing-usage-recovery.md). That operation retains the original request
pricing snapshot and does not apply a budget decision. It is not authenticated
supplier confirmation; existing terminal receipts require linked corrections.

Preview does not require final consent; apply requires explicit confirmation.
Unknown fields, actor/price spoofing, invalid integer counts and incomplete member
decisions are rejected. No provider request, price publication or source-config
mutation occurs in this workflow.

## Fresh evidence and connected physical groups

The resolver follows shared physical attempt membership transitively, including
already terminal siblings and fallback holds on the affected requests. It does
not accept a caller-selected subset of a batch. Inspection is bounded to 1,024
requests and 4,096 rows per inspected table; larger graphs require further
operator tooling rather than silently truncating a financial operation.

Request locks are acquired in sorted order. The graph is discovered again after
locking; a newly connected request causes a conflict/re-read rather than acquiring
additional locks out of order. Reservations and attempts are locked before the
plan is applied. The basis includes original/effective cost hashes, linked
adjustment application hashes, snapshot and price-context evidence, reservation
state/leases, intents and physical membership. Polling timestamps are excluded so
merely checking an unchanged case does not invalidate a proposal.

Fresh active leases block a new unclosed decision. A verified actual cohort already
fences dispatch and can supply finality instead of its stale lease. Asynchronous job ownership and
non-synchronous media-task footprints remain owned by their existing lifecycle.
An existing intent already fences dispatch, so its exact replay is distinct from
overriding an active request. Expiry alone remains insufficient proof that a
process is dead or that supplier usage is zero.

## Atomicity, audit and uncertain replies

All member budget effects, intent application, log projection, case status,
required pricing audit and decision links share one transaction. Failure in a
later member or in audit persistence rolls back earlier member changes. Existing
exact-budget epoch rules remain authoritative; releasing an old hold does not
promise a refund against today's balance. The preview explicitly marks that
boundary instead of showing an invented current-balance refund.

Proposal identity is scoped to workspace, actor, anchor, basis and normalized
decision ordering. The audit stores a proposal digest and hashed stable result;
reasons are redacted before storage. A retry after a lost post-commit reply returns
that result after checking its member decision links and applied intents. Reusing
an ID with different evidence or another actor is a conflict, not another debit.

Cases resolved here use `operator_budget_resolved`. This refers only to budget
ownership: cost detail can still be pending/unpriced. The open-case list is not a
complete inventory of remaining supplier-evidence work after a budget release.

## Dashboard and paginated inventory

Open **Pricing → Budget recovery**. Operators can inspect; only workspace
administrators see the decision form. Viewers cannot read these recovery pages
or their APIs. Existing request-cost details also link to the affected group.

`GET /api/dashboard/pricing/recovery-inventory` accepts:

- `view`: `open` (default), `resolved`, `unresolved_cost`, or `all`;
- `limit`: 1–50 (default 20);
- `cursor`: the opaque continuation returned by the previous response, bound to
  the same workspace and filter.

Budget filters use the actual reservation state, not supplier-cost completeness.
`unresolved_cost` includes budget-resolved cases with missing/invalid fee evidence.
Each row separates internal held/committed money from the request's effective
provider cost and known subtotal. Missing or corrupt evidence is never rendered
as a zero charge. Request-level amounts can repeat across reservations: **do not
sum the inventory rows**. Coverage is `recorded_recovery_cases`, not all traffic.
Responses use a metadata-column allowlist, not raw stored evidence.

The unresolved-cost filter inspects at most 200 candidates per request. An empty
page with `next_cursor` means “inspect the next batch,” not “nothing remains.”
Keyset pagination consumes only inspected candidates, including equal-timestamp
rows. Concurrent changes do not turn this operational list into a frozen report.

In the editor, each unresolved member needs an explicit action. Display pagination
shows 20 reservations at a time without dropping other members from the proposal.
Known winner choices retain full unique attempt IDs. Active leases are blocked;
existing immutable intents can only be applied as recorded. No money field is
accepted from the browser. Missing logical-token evidence requires a separate
explicit count, not an invented zero.

1. Choose all member actions and enter a non-sensitive reason.
2. Request a server preview. It performs no writes or provider calls.
3. Inspect the exact amounts, unknown-attempt warning and budget-only boundary.
   Consent is required separately before submitting.
4. Any edit invalidates preview and consent. An evidence conflict retains valid
   draft choices, but requires an explicit reread and a new preview.
5. A lost/ambiguous reply freezes the proposal. Query its acknowledgement or retry
   the **same ID and body**. A read-only 404 is not evidence that an earlier write
   can never complete; abandoning it requires an explicit warning/confirmation.

Before POST, a minimal versioned proposal and sanitized preview are saved in
`sessionStorage`, scoped to workspace, actor and anchor. Reload restores the exact
pending body; it does not restore consent. The initial basis read completes before
the editor captures its group, and an unavailable basis is not displayed as zero
members. The pending record is removed after a verified acknowledgement. Storage
quota/unavailability prevents a new submission rather than losing retry identity.
This is a **tab-local retry aid**, not a durable accounting outbox or backup.
Closing the tab can lose it. Never put prompts, credentials or customer content
in the reason; the UI stores no arbitrary request/response payloads.

Navigation/history guards protect edits and uncertain writes. The seven locales
have localized states, explicit permission views and narrow/dark layouts. These
controls do not replace the server's scope, CAS, audit and idempotency checks.

## Quarantine and late provider results

Maintenance can retire a local queued/quarantined **budget decision** only when a
matching applied operator decision and valid audit prove it was superseded. It
cannot discard a missing usage receipt merely because the budget was released.
Capacity is freed only after that authoritative check; lookup failures retain
the evidence.

A paused shared coordinator can later deliver genuine physical usage. Its
conserved receipt group is still persisted; its superseded budget instructions
are not reapplied over the audited operator decision. Original receipts remain
immutable. Revised evidence for an already terminal receipt still requires the
linked correction path rather than a silent overwrite.

## Explicit migration 007 and allocation manifests

`pricing-engine-007` adds:

- `pricing_recovery_decisions`: immutable per-reservation links to required audit
  records and exact applied intent hashes, with restrictive foreign keys.
- `pricing_batch_manifests`: one immutable allocation manifest per physical
  dispatch, containing only member request/reservation IDs, input ranges, counts,
  weights and weight basis. No embedding text, token arrays or other content.

New shared dispatches persist and reference their manifest before calling the
provider. The full manifest is stored once, not copied into every attempt's
context. Recovery verifies the reference and checks known allocations against it.
Legacy prepared attempts remain readable without invented weights; full pricing
of a legacy unknown physical outcome still requires genuine allocation evidence.

All `001`–`006` definitions/checksums remain unchanged. The migration is explicit,
never a startup side effect, and has only been exercised on isolated databases.
Manifest retention and older-binary compatibility still need final M6 acceptance.

## Evidence and remaining work

Relevant tests are in [ledger contracts](../test/unit/cost-ledger.spec.ts),
[retry-buffer contracts](../test/unit/pricing-outcome-retry.spec.ts),
[migration contracts](../test/unit/pricing-schema.spec.ts) and
[isolated HTTP recovery](../test/e2e/pricing-recovery-resolution.e2e-spec.ts).
They cover preview/no writes, unknown cost preservation, known commits, cache
semantics, fresh CAS, active leases, role/scope, immutable-intent replay,
concurrent proposals, transitive physical groups, manifest integrity, late group
receipts, audit/member rollback and an isolated post-commit child exit. HTTP tests
also exercise an ambiguous post-commit acknowledgement and exact retry.

This is not whole-Goal acceptance. Still required: supplier-usage
attestation/import and trusted callbacks, receipt-quarantine
handling, full pre-durable process-loss strategy, resumed-owner/older-writer case
lifecycle, complete traffic-wide reporting/coverage, retention/performance and the
remaining M0–M6 deliverables. Do not deploy or mark the Goal complete yet.

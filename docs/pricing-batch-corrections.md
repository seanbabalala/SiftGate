# Conserved batch corrections — development candidate

Status: implemented in isolation, **not deployed and not full Goal acceptance**.
This extends the [priced batch runtime](pricing-batch-runtime.md). Independent
member corrections remain prohibited: a revised physical invocation must update
all its allocations together.

## What changes and what stays immutable

A correction supplies updated physical usage evidence, not replacement prices,
member weights or individually chosen charges. The administrative service restores
the admitted catalog and evaluates the original target, pricing context and FX.
It runs the shared calculator on the revised whole-batch usage and reapplies the
original exact allocation weights and input spans.

The original attempt rows, physical receipt and settlement intents stay unchanged.
New append-only member revisions retain their predecessor hashes, while each
batch receipt links to one shared correction ID, physical predecessor hash and
revision number. All member histories must form the same continuous physical
revision chain. A later correction does not overwrite an earlier one.

- A revised aggregate can cross a context threshold using its original price-book
  rules; member quantities must not be separately priced in a cheaper tier.
- Publishing new prices or removing current FX does not change the correction's
  historical rate/FX version.
- Original physical dispatch attribution cannot be changed by a usage correction.
- Membership, allocation algorithm, input spans and weights are derived from
  retained evidence, never accepted from the caller.
- Missing usage remains unknown. A tiny change still appends all member revisions
  even if some rounded monetary shares do not change.

## Atomic transaction and idempotence

The correction loader uses the recorded member set and physical-attempt ID to
find exactly one scoped attempt per member. It verifies all initial hashes,
prepared membership, tenant/target consistency, and the complete revision chain.
It locks requests, reservations, attempts and intents in deterministic order.

Every member's cost revision, exact budget delta, adjustment application and
call-log projection, plus one group audit event, commit in **one transaction**.
A failure on the second member or final audit insert rolls everything back. There
is no intermediate state where one member received a refund while another was
not updated. Original terminal budget effects must already be applied.

The caller supplies an idempotency ID and the expected latest physical-cost hash.
The group audit binds that ID to workspace, physical invocation, original hash,
new physical hash, actor, reason and source. Per-member revision IDs are derived
deterministically. Concurrent identical deliveries apply once; competing changed
deliveries permit only one winner. Reusing an ID with changed evidence is rejected.

An identical retry still returns its original correction after newer corrections
exist; it never moves the latest state backwards. The stored audit and every
member revision must agree before such a replay is accepted. A child-process test
exits immediately after commit; the next process retries without another debit.

## Logical budget policy

Supplier cost and compatible logical budget remain distinct:

- A member whose original reservation was released receives corrected supplier
  cost evidence, not a new logical charge.
- Correcting a failed physical retry does not charge its fee to the successful
  retry's logical budget.
- A successful logical-budget winner adjusts from its **last charged amount**,
  including when the first amount was a reservation estimate for missing usage.
- An unknown revision marks budget correction pending rather than assuming zero.
  A later known revision resumes from the last applied amount, not the unknown one.
- Refunds affect only the original budget scopes/epoch; a new day or manual reset
  cannot accidentally receive an old request's refund.

New multi-receipt settlement intents explicitly include `budget_attempt_id`, which
must identify an included receipt in a commit. Older intents retain their hashes.
An older batch intent with exactly one successful batch receipt can resolve its
winner; an ambiguous intent stays pending rather than guessing. Ordinary singular
receipt intents continue to work unchanged. No SQL schema migration is introduced.

## Administrator API

Both endpoints require Dashboard authentication, workspace **admin** role,
same-origin/explicitly trusted-origin JSON, a reason and `confirm: true`:

| Endpoint | Behavior |
| --- | --- |
| `POST /api/dashboard/pricing/attempts/:id/batch-correction/preview` | Recompute and compare all allocations; no cost, budget, log, audit or catalog writes. |
| `POST /api/dashboard/pricing/attempts/:id/batch-correction` | Atomically append all member corrections, apply applicable exact budget deltas, project logs and write one group audit. |

The path can identify any recorded member of the physical batch. The service
derives the complete group. Foreign-workspace attempts are not exposed. Viewers
cannot preview or apply a historical correction, even though they can use ordinary
read-only price simulation.

```json
{
  "id": "UNIQUE_CORRECTION_ID",
  "expected_physical_cost_hash": "EXPECTED_64_CHARACTER_HEX_HASH",
  "reason": "Administrator reviewed the corrected synthetic usage evidence",
  "confirm": true,
  "evidence": [
    {"dimension": "total_input_tokens", "value": "24000", "source": "request_metadata", "quality": "observed"},
    {"dimension": "uncached_input_tokens", "value": "24000", "source": "request_metadata", "quality": "observed"},
    {"dimension": "output_tokens", "value": "0", "source": "request_metadata", "quality": "observed"}
  ]
}
```

The hash above is a placeholder, not a valid request value. Use the latest physical
hash from the authorized cost detail. Evidence is a replacement physical usage
set; supply all needed cache/TTL/media/count dimensions or their missing state is
retained. Negative/invalid counters, conflicting partitions and unsupported body
fields are rejected. The caller cannot submit a model/price version, FX, actor,
workspace, member list or arbitrary final amount.

Preview returns old/new member costs, physical hashes and the planned revision;
its `adjustment` fields are null. Apply returns the immutable adjustment and exact
budget application for every member. A repeated committed operation is marked
`replayed: true`. A version conflict requires a fresh read and review, never an
automatic overwrite with the latest hash.

This is an **administrator-attested correction**, not an authenticated supplier
callback or proof of invoice reconciliation. Source/actor provenance is audited,
and UI must not label it supplier-invoice-confirmed. No provider is called, and no
prompt, output, media bytes, raw headers, credentials or raw supplier payload is
required or persisted by this API.

The server forces `request_metadata` provenance for this administrator API;
client-provided `provider_usage` or job-result labels cannot promote an attestation
to provider evidence. The [Dashboard workflow](pricing-dashboard.md#batch-usage-correction)
provides exact physical quantities, whole-group preview, explicit confirmation,
stable-ID retries, conflict reread and immutable revision history.

## Verification and remaining Goal work

SQLite WAL and the independently owned PostgreSQL instance verify identical and
competing concurrent corrections, audit/member rollback, immutable originals,
unknown→known recovery, released members, old epochs, tiny shares, prepared
membership integrity, frozen-price rejection and child-exit idempotence.

Actual isolated HTTP tests verify preview has no writes; applying updates all
cost/log/budget views once; price publication/current FX removal does not change
the historical tariff; failed retries do not consume the winner's budget; stale,
invalid, foreign-origin, foreign-workspace and viewer actions are rejected.

Isolated browser verification covers preview/consent, a lost successful response
followed by a same-ID retry (one group audit, one revision per member), conflict
retention/reread, viewer controls and narrow/dark layouts. No supplier was called.

Still required: complete report/coverage/operator workflows, generalized supplier
callback/orphan reconciliation, retention, remaining
writer/notification coordination and final performance/Docker/candidate acceptance.
The full [Goal Spec](pricing-engine-goal-spec.md) is unchanged. The live 2099
gateway, production configuration/database, watchdog and release remain untouched.

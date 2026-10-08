# Complete-group retained evidence disposition

Implemented in the isolated development candidate, **not deployed and not full
Goal completion**. Migration 011 adds an immutable administrator decision on a
previously retained physical group. A dedicated seven-language Dashboard workflow
is now implemented with isolated browser evidence; the independent receipt UI
is not a substitute. See the
[Goal Spec](pricing-engine-goal-spec.md), [group custody](pricing-group-outcomes.md)
and [implementation progress](pricing-engine-progress.md) for current evidence.

## What the decision means

`accept_receipts` selects the complete supported receipt evidence retained in one
group outcome. Every represented receipt participates, including earlier complete
physical cohorts and independent receipts carried in terminal payloads. A paged
display must never narrow this scope to the currently visible members.

- Missing initial physical groups are adopted only with a complete, consistent
  prepared manifest and original request authority.
- A partially recorded initial group can be filled only when its recorded members
  match the retained receipts exactly and have no revision history.
- A changed, fully recorded physical cohort uses one conserved group correction;
  every member receives its linked revision in the same transaction.
- Identical physical evidence is acknowledged without creating another charge.
- A partial historical cohort is accepted only as unchanged existing evidence.
  Changed partial history, inconsistent old lineages, missing manifests, ambiguous
  variants and allocation failures block acceptance rather than inventing weights,
  missing shares, usage or a price.

`reject_evidence` records nonselection while retaining the original document and
roster. It does not declare usage free, refund money, release a reservation,
change an existing request outcome or acknowledge a supplier invoice. Unsupported
acceptance evidence can still be explicitly rejected when ownership permits.

Neither decision applies the retained terminal **budget proposal**. The original
logical settlement/winner remains authoritative. A linked correction changes
budget usage only where that earlier decision makes it applicable; loser costs,
released requests and expired cost-only reservations remain separate. Known to
unknown usage retains the prior charge; unknown to known uses the actual charged
estimate rather than treating the earlier unknown amount as zero.

## Frozen authority and exact calculation

Acceptance reproduces the physical cost from the original immutable catalog,
price version, FX, normalized quantities, dispatch identity and pricing context.
Current prices or exchange schedules cannot replace those snapshots. No client
prices, quantities, source, actor or subset of members are accepted.

Every prepared member must still agree on the dispatch-time tenant, target,
catalog, price, FX and admission-policy identity. Its target, dispatch time and
manifest association must agree with the physical cohort. Verifying one anchor's
quote alone is insufficient to authorize another member. The dedicated validated
embedding manifest supplies the operation for older batch contexts that did not
store it in media metadata; it is not inferred from a model name or supplied by a
client. Operation-qualified price bindings are tested through actual mock-upstream
HTTP requests, not only hand-created ledger fixtures.

The original receipt, retained body and error evidence remain immutable. A group
correction adds revision metadata, so the retained share hash can legitimately
differ from the accepted cost hash. Responses expose both `retained_hash` and
`cost_hash`; physical identity, allocation and every member must still agree.
Accepted reported-model metadata is retained for subsequent ordinary corrections.
An exact retry uses its recorded metadata even if a newer correction has changed
the currently accepted reported model.

## Preview, concurrency and recovery

Preview is a no-write computation. Its adjustment objects are proposed evidence,
not stored applications. All cohorts and independent receipts use one
transaction-local virtual budget balance map, keyed by workspace, rule and original
epoch. This catches aggregate underflow even when each member's refund would fit
individually. Both current and historical epochs are checked; historical refunds
never become refunds against today's reset budget.

A fresh basis covers custody, related alternatives, original snapshots, every
member, revision/intent/ownership evidence and current budget epochs. PostgreSQL
timestamp values are normalized to ISO strings before hashing. A reset between
preview and confirmation therefore requires a new basis on both databases.

Sorted request/reservation/member locks, scoped operation identities and required
audits keep competing reviewers, member changes and delayed runtime delivery from
partially applying a decision. Live leases, pending intents, asynchronous task
ownership and non-provider ownership fence this workflow. It never takes over a
media task or chooses a new budget winner.

Acceptance, all receipts/revisions, exact budget applications, decision/audits and
mandatory call-log projections commit atomically. A required member, audit,
disposition or projection failure rolls the transaction back. A lost reply or
process exit after commit is recovered with the same operation ID or read-only
acknowledgement, not a new correction.

Acknowledgement verifies the retained document, complete represented membership,
original/revision receipts, retained errors, exact applications, actor and required
physical-group audit. It remains valid after a later legitimate correction without
applying the earlier money again. A disposed row leaves the unresolved admission
backlog only through the separately audited decision; the original custody state
and bytes are not rewritten.

## Scoped Dashboard API

All routes are under
`/api/dashboard/pricing/runtime-group-outcomes/:outcomeId`:

| Method | Suffix | Permission | Effect |
| --- | --- | --- | --- |
| GET | `/disposition-basis` | Operator/admin | Complete read-only evidence and blockers |
| POST | `/disposition/preview` | Admin | No-write complete decision preview |
| POST | `/disposition` | Admin | Atomic confirmed decision |
| GET | `/dispositions/:operationId` | Operator/admin | Verified read-only acknowledgement |

Viewers are denied. Foreign-workspace records are unavailable. Writes require
JSON, trusted-origin checks, a nonempty reason, explicit confirmation, an action,
an operation ID and exact expected basis/outcome hashes. Unexpected fields are
rejected. No route calls a provider or trusts a client claim of supplier evidence.

The body is:

```json
{
  "id": "YOUR_UNIQUE_OPERATION_ID",
  "expected_basis_hash": "COPY_CURRENT_64_CHARACTER_BASIS_HASH",
  "expected_outcome_hash": "COPY_CURRENT_64_CHARACTER_OUTCOME_HASH",
  "action": "accept_receipts",
  "reason": "Explain the completed evidence review",
  "confirm": true
}
```

The hash placeholders must be replaced with the actual returned hashes. Editing
an action or proposal is not an exact retry. Inspect the prior operation before
abandoning an uncertain response.

## Bounds and remaining work

The review bound is 1,024 distinct represented receipts, 256 revisions per
selected attempt, 8,192 related attempts, 4,096 task/alternative records and
32 MiB for a basis or result. Existing compact custody and expansion bounds also
apply. These are safety ceilings, not measured maximum production capacity or a
promise that every maximal combination fits.

Migration 011 creates only the separate disposition table and unique scoped
operation index. Migrations 001–010 retain their checksums. Populated 010 upgrade,
missing-table refusal and transactional constraints are tested in disposable
SQLite WAL and PostgreSQL databases; no production migration is authorized.

Trusted supplier/task workflows, reconsideration of disputed evidence,
older-writer/pre-durable-loss
strategy, capacity/retention/performance and full M6 delivery remain required.
`gateway_runtime` is not supplier authentication, and `supplier_confirmed` remains
false. This backend checkpoint does not authorize deployment or a live restart.

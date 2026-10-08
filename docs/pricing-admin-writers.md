# Administrator budget writers and transactional audit

Implemented in the isolated candidate, not deployed. This closes specific races
between generated-key/team administration and the pricing budget ledger; it does
not claim every unrelated database writer is coordinated.

## Invariants

- Updating a key/team name, limit, status or restrictions does not copy an old
  `current_value` or `period_start` back over concurrent spending.
- The exact budget shadow remains associated with the same rule and epoch.
- Creating, updating or removing the owner and its budget rules is one transaction.
- Dashboard key/team mutations include their before/after audit records in that
  transaction. A mandatory audit failure rolls the mutation back; a failed key
  rotation leaves the original key valid rather than losing access unexpectedly.
- Authentication does not use uncommitted permission changes from a cooperating
  administrator transaction that later rolls back.
- A stale usage-metadata write cannot restore an old key hash, policy, status or
  team restrictions. Last-used timestamps do not regress when older writes finish
  later; key metadata updates also match the current hash and active status.

Existing budget-limit semantics and numeric limit columns are unchanged. This is
not a price publication, budget reset, ledger rewrite or schema migration.

## Coordination

`coordinatedRepositoryOperation` uses the same single-DataSource SQLite queue as
the ledger, with transaction-scoped repositories for writes. Key/team reads and
authentication participate in the same boundary. An explicitly supplied active
transaction manager may be reused; unrelated callers do not silently join a
transaction through the global repository.

On PostgreSQL, owner updates lock the key/team row. Budget configuration locks all
existing rules for that owner in ascending ID order before modifying metadata,
matching the ledger's rule-lock order. Partial updates exclude spending, exact
shadows and epochs. New rules are created only after the owner is protected;
concurrent scoped-name conflicts are returned as the existing domain validation
error rather than a raw uniqueness failure.

Default-workspace legacy-null rows remain eligible for scoped updates. Other
workspaces cannot mutate those owners or their budgets. This does not consolidate
or delete pre-existing duplicate historical rules automatically.

## Audit behavior

Dashboard key/team methods pass their transaction manager to
`ConfigAuditService.recordManagementEvent`. The optional configuration audit and
the authoritative management audit therefore commit or roll back with the policy
and budget changes. Actual actor identity comes from the request context, not a
hard-coded Dashboard identity.

`ManagementAuditService.record(input, manager)` requires an active manager from
the same DataSource and propagates errors to its transaction owner. Calls without
that explicit manager retain the standalone best-effort contract, but now execute
their append in an isolated, coordinated transaction. Workspace audit heads are
serialized, including the initially empty-chain case; PostgreSQL tests use two
independent DataSources against the same schema to verify the chain.

Configuration audit summaries, metadata and failure strings are sanitized using
the management-audit rules. Numeric token limits remain readable; secrets and
content-bearing fields are redacted. New event hashes use the same sanitized
failure reason that is stored. Existing audit rows are not rewritten.

The authoritative `budget.rule.reset` audit now shares the reset transaction and
contains the exact pre-reset balance when an exact shadow exists. Audit failure
preserves both that balance and its epoch. The older Dashboard `budget.reset`
event remains an additional after-operation summary, not the monetary authority.

## Compatibility and limits

- SQLite remains a single-instance path. Coordination covers participating code
  on the same DataSource, not arbitrary external SQL or multiple SQLite processes.
- PostgreSQL remains optional. Existing installations without pricing tables can
  still administer keys/teams; the tests explicitly exercise that state.
- Existing rate limits, authentication formats, role checks and ingress endpoints
  remain unchanged. A transaction-scoped service is internal to its operation.
- This does not provide idempotency for every administrative HTTP action or remove
  the usual uncertain-outcome window if a connection drops after commit.
- Other repository writers, generalized dispatched-orphan recovery, retention and
  full performance/candidate validation remain part of the full
  [Goal Spec](pricing-engine-goal-spec.md).

## Verification

The SQLite WAL/PostgreSQL contract covers exact balance/epoch preservation, a
forced stale configuration read, concurrent ledger commit/rollback, independent
administrator updates, duplicate names, second-rule insertion failure, audit
rollback, actual actor and sanitized summaries, stale key/team metadata, monotonic
activity, uncommitted-permission isolation, legacy-null scope, foreign workspace
rejection, concurrent empty audit heads, atomic reset, manager validation and a
database without pricing tables.

Real isolated HTTP tests combine synthetic model usage with administration, fail
mandatory audit writes during key creation/rotation, budget reset and team
update/deletion, and verify no partial state or extra provider call. Concurrent
updates produce matching before/after records in one audit chain. All model
requests are mocked; no production credentials or database are used.

Test PostgreSQL UUID support is installed in that owned database's public schema
rather than in a disposable fixture schema; nested fixtures must not depend on an
extension dropped with the first fixture. Fixture initialization failures now
close their admin connection and remove their partially created schema. See
[progress](pricing-engine-progress.md) for full-suite evidence and remaining gates.

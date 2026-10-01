# Coordinated workspace, membership and invitation writers

This checkpoint extends the [administrator writer contract](pricing-admin-writers.md).
It protects the shared database connection used by the pricing ledger. It does
not activate pricing, migrate production storage, change a deployed process or
complete the full [pricing Goal](pricing-engine-goal-spec.md).

## Transaction ownership and lock order

- Workspace, membership and invitation services use the same per-DataSource
  SQLite queue as participating budget/ledger writers. Cooperating reads cannot
  accidentally observe an unrelated uncommitted write on that shared connection.
- Cross-service writes pass an explicit, active manager belonging to the same
  DataSource. Never call an unscoped service from inside a queued transaction:
  it would wait behind itself. Transaction-bound clones do not change singleton
  repository state or implicitly join another request's transaction.
- PostgreSQL writers use a configured-schema-aware, transaction-scoped advisory lock
  shared across these three services, keyed by workspace. This covers an empty
  membership set and concurrent writers using separate connections/DataSources
  with the same schema configuration.
- Creating a workspace locks organization bootstrap first, then the newly
  allocated workspace for its initial membership, then its audit head. Other
  administrator mutations lock the target workspace before checking membership
  and appending audit. Future compound operations touching multiple existing
  workspaces must order their workspace locks consistently before mutation.
- These are **cooperating-writer** guarantees. They do not fence arbitrary SQL,
  older binaries ignoring the lock, or every multi-process SQLite workflow.
  No schema migration is introduced here.

## Administrator operations

Workspace creation, its initial administrator and the authoritative management
audit commit together. Failure cannot leave an ownerless workspace. Rename,
disable and reactivate obtain their before-state and target-admin permission
inside the transaction, and require the audit to commit. Concurrent slug conflicts
retain the domain conflict response; unrelated storage errors are not relabelled.
This includes the compatibility schema's explicitly named workspace-slug index,
not only indexes whose names were generated from TypeORM metadata.
Concurrent rename/status edits cannot restore stale values read before the lock.

Member updates include the active workspace in the ID lookup. Competing admin
demotions/disables re-evaluate the active-admin set under the workspace lock, so
at least one admin remains if the set was nonempty. Membership upsert cannot
bypass that last-admin check. Initial default-admin upserts and competing
membership creation use the same lock. Existing role/reactivation semantics are
otherwise retained; this is not a redesign of OIDC role provisioning.
Existing default-member IDs remain unchanged. When a PostgreSQL default member
does not exist, its generated UUID is used so both a native UUID column and a
legacy varchar column can accept it; SQLite keeps its historical bootstrap ID.
The service generates this ID explicitly, without requiring a database ID default.

Member and invitation dashboard mutations require transactional configuration
and management audit. Disabling optional configuration history does not make the
authoritative management audit best effort. Standalone audit calls elsewhere
retain their documented best-effort contract. Member audit uses the real request
actor rather than a hard-coded dashboard identity, with sanitized summaries.

## Invitation acceptance

Local-password and OIDC login pass their membership effect into the invitation
transaction. A token is consumed only if that effect commits. Membership failure
keeps the invitation pending and prevents session issuance on that attempt.
Competing accept/revoke operations reload the token after acquiring the workspace
lock; only one acceptance can commit. Authentication protocol/network operations
are not moved into a database transaction.

The token itself is an intentional cross-workspace capability at login. Dashboard
revocation, in contrast, requires both ID and active workspace. List-time expiry
only touches the workspace being listed, and cannot overwrite a concurrently
accepted token through a stale pre-lock entity snapshot. Creation through the
dashboard requires the selected workspace to be active; it does not silently
fall back to creating an invitation in the default workspace.

For a top-level expired acceptance, the transaction returns an expired outcome,
commits the status, and then raises the public expiry error. An explicit outer
transaction still controls rollback of all of its work. Expiry remains lazy, not
a newly introduced cleanup scheduler. Existing email policy is retained: a
mismatch is rejected when both invite and authenticated identity have an email;
the local-password flow does not gain a new email-verification requirement.

Acceptance is not an HTTP idempotency protocol. Losing a successful login response
does not make a used token reusable, and signing/delivery is not a durable session
outbox. OIDC state consumption and provider authentication remain separate
existing concerns. No prompts, supplier response bodies, real keys or media are
stored for these changes.

## Verification scope

[Database contracts](../test/unit/workspace-writers.spec.ts) run against SQLite WAL
and the owned PostgreSQL fixture. They cover concurrent empty bootstrap, slug
conflicts, competing edits and demotions, default-admin/membership races, scoped
ID lookup, accept/revoke races, expiration, failed effects with retry, OIDC manager
propagation, required-audit rollback, read isolation, monetary-transaction
rollback separation and invalid transaction managers. The PostgreSQL cases use
independent DataSources where relevant.

[HTTP contracts](../test/e2e/pricing-workspace-writers.e2e-spec.ts) use the real
isolated application, synthetic configuration and no real providers. They cover
workspace lifecycle, failed owner/audit creation, rename/status rollback, member
audit rollback, cross-workspace IDs, invitation creation/revocation rollback and
local-login membership failure followed by a successful retry.

Pass counts and logs belong in [implementation progress](pricing-engine-progress.md)
and the ignored environment record. These cases do not replace remaining orphan
reconciliation, retention, adapter governance, operator UI, Docker, performance or
candidate acceptance gates. The full Goal remains active and undeployed.

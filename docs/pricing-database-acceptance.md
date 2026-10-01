# Pricing database acceptance

This report addresses the six original **MIG-02** clauses. It is development
evidence, not permission to migrate or restart production. The Goal remains
incomplete; [current progress](pricing-engine-progress.md) is authoritative for
remaining gates, not the historical test counts below. The subsequent
[migration delivery](pricing-migration-delivery.md) repeats both native populated
recovery rehearsals on the current application and packages the migration/import
evidence. The earlier index/lock scale measurements retain their original scope.

## Source and evidence boundary

The native rehearsals use the compiled gateway from the 1,398-file documented
settlement-graph source checkpoint, whose source-manifest SHA-256 is
`f18dca15b3461ddb03ecaf1c9d8495af1a4d6e1da5d801265e518ac15e0a2253`.
All 1,473 compiled-file hashes match that checkpoint. This report and its related
documentation are later documentation-only changes, not a new backend build.

Each database uses the actual `dist/main.js` entrypoint, Node22.23.2/ABI127 on
macOS/ARM64, its own configuration/storage and loopback mock. Dashboard operations
use a real password login and session; legacy Dashboard token authentication is
disabled. Gateway requests use an independent synthetic API key. No real supplier
requests or production database accesses are part of these rehearsals.

Application startup and migration commands use `synchronize: false`. Only the
initial empty legacy-schema fixture bootstrap uses synchronization. Development
SQLite defaults are not a production upgrade procedure.

## Original requirement mapping

| Clause | Direct evidence and decision |
| --- | --- |
| Explicit, inspectable migrations | The CLI requires exactly one explicit database target, does not load gateway configuration, defaults to read-only planning and applies only with an explicit flag. Pricing startup has no migration caller. Both rehearsals run dry-run, apply001–018, inspect and reapply. |
| SQLite and PostgreSQL recovery | Three snapshots per database are restored into fresh targets and compared before application startup. The latest restored actual gateway preserves old financial state and accepts one new authenticated request. |
| Side tables, indexes, locks and storage | Pricing uses additive side tables rather than rewriting historical call logs. Original application rows and sequences survive001–018 unchanged. The bounded scale rehearsal below measures018 on both databases and demonstrates blocking. No automatic historical per-row backfill is introduced. |
| Workspace, request, task and global authorization | Recovered rows retain the linked snapshot, request, attempt, reservation, video task, observation and price version in the same workspace. Existing real-session HTTP tests reject foreign-workspace access and global writes by a workspace-only administrator, even with forged session claims. |
| Coexistence and rollback | Mixed old/new writers and binary-only downgrade on an upgraded database are unsupported. A rollback requires a separately verified database/configuration restore and reconciliation of all work accepted after the selected backup. Details follow below. |
| Separate production window | All writes target owned fixtures. Production protection compares the selected user-confirmed configuration hashes, listener PID and release before/after. No production migration, configuration change, restart, Docker action or deployment occurred. |

The carried full regression contains4,281 passing unit tests and807 passing HTTP
tests, with no failures or skips. Direct clause coverage includes38 additive-index,
52 schema,6 migration-CLI,22 management-contract and49 media-task assertions.
Their source hashes and passing assertion names were rechecked. These are carried
results for unchanged code, **not** a newly executed full regression.

## Populated backup and recovery

| Snapshot | Accepted calls | SQLite artifact | PostgreSQL custom archive |
| --- | ---: | ---: | ---: |
| Before pricing migration | 1 | 946,176 bytes | 118,825 bytes |
| After pricing and video work | 4 | 1,581,056 bytes | 233,710 bytes |
| After one additional request | 5 | 1,638,400 bytes | 236,105 bytes |

These are synthetic, small recovery fixtures. Archive sizes are not comparable to
live database storage and are not a production backup budget.

- SQLite uses the compiled managed-backup CLI and SQLite backup interface while
  the live source has committed WAL data. Only a completed derivative is changed
  to DELETE journal mode. The source remains in WAL mode. Managed manifests,
  artifact hashes, integrity and foreign keys are checked.
- PostgreSQL16.14 uses a custom dump with an exported transaction snapshot.
  Restores use a fresh database and
  `--single-transaction --exit-on-error --no-owner --no-privileges`. Durability
  settings remain enabled. Full row digests, columns, indexes, validated
  constraints, sequences and caller-key identities match before startup.
- The latest snapshot contains60 SQLite tables including its internal sequence
  table, or59 PostgreSQL tables. Populated `--remove-empty` is rejected without
  changing any table state.
- A priced token request remains exactly0.006USD. The completed video remains
  exactly0.66USD:6.4seconds at0.1USD/second plus one generation at0.02USD. These
  are test prices, not vendor rates. Its original task/request/reservation links
  and immutable attempt cost hashes survive recovery.
- The response lacking supplier usage retains a null amount and an unresolved
  0.001010000000000000USD reservation. Starting the restored gateway does not
  redispatch it. A new authenticated request succeeds, producing six distinct
  accepted-call identities in total.
- The source database and backup hashes remain unchanged. Earlier snapshots
  visibly omit subsequent accepted work; none overwrites newer state.

An independent Python verifier reads SQLite artifacts and recomputes every table
digest, schema and sequence state. For the stopped, sidecar-free restored SQLite
file it uses immutable read-only mode only after confirming no nonempty WAL and no
owned test listener. An independent offline PostgreSQL archive inspection checks
COPY row counts, sequence values, constraint names and the actual stored cost/task
links; it does not substitute for the complete comparisons performed during the
real database restore. Exact attempt cost hashes are independently recalculated.

This is same-version native recovery with a live but quiescent backup source.
It does not certify concurrent sequence allocation, production roles/grants,
cross-version restore, PITR, whole-host recovery or the final Linux image.

## Bounded index and lock assessment

Separate copies of the latest backups receive50,000 schema-valid synthetic
attempt/task pairs, giving50,001 media tasks. Only these disposable copies are
reconstructed as017 before the actual compiled018 migration CLI runs. This is
not50,000 accepted provider requests. The added rows share a reservation and use
minimal context, so their cardinality and index compression are not representative
of every customer database.

| Native database | Natural `createIndex` call | Natural migration transaction | Storage observation |
| --- | ---: | ---: | --- |
| SQLite | 30.054ms | 43.866ms | Occupied pages increase3,760,128 bytes; previously freed pages are reused. |
| PostgreSQL | 35.785ms | 343.767ms | Index increases393,216 bytes; isolated-cluster WAL advances353,320 bytes. |

Timings include client/driver work. The transaction interval includes schema
inspection and commit; it is not an exact server-exclusive-lock measurement.
File/WAL sizes are sampled, not peak disk consumption. SQLite's main file remains
61,186,048 bytes and its sampled WAL is59,941,912 bytes, illustrating why unchanged
main-file size does not mean zero migration storage cost.

A **separate** experiment deliberately holds the migration transaction for an
extra1,000ms after index creation. An independent connection's no-op task update
waits869.166ms on SQLite and830.777ms on PostgreSQL, completing only after commit.
The deliberate delay is excluded from the natural timings above. This confirms
writer blocking;018 is not an online/concurrent-index migration.

Dry-run changes no rows. Apply/reapply and the contention experiment preserve
every non-marker table digest and the original17 markers; only018's marker and
index are added. Integrity/foreign-key or validated-constraint checks pass.

### Maintenance storage and lock budget

Before a separately approved deployment:

1. Rehearse on a representative, safely copied customer database, including its
   real row cardinality and index distribution. Record the whole migration and
   writer-wait intervals, peak temporary/WAL space and expected downtime. The
   measurements above are not a linear production estimate or downtime promise.
2. Budget **additional free space**, per filesystem, for new tables/indexes,
   temporary/index-build work, WAL/journal growth, all retained backups and any
   on-disk rehearsal/restore copies, plus a documented operational margin. Keep
   the original database until verification/reconciliation finishes; do not count
   its deletion as available space. A compressed archive is not restored size.
3. Account separately for the host disk and Rancher VM/volume limits. Keep at
   least one verified backup outside the VM. Retention/rotation must not delete
   the only recovery point or evidence of outstanding work.
4. Fence competing writers and stop new admission in the approved maintenance
   procedure. Drain accepted work, take/verify the final consistent backup, then
   migrate explicitly. If storage or lock budget is exceeded, stop the procedure
   and inspect transaction/schema state rather than blindly retrying.

## Mandatory downgrade prerequisite

**Do not deploy an old binary against the upgraded live database.** A historical
isolated baseline rehearsal showed why process health is insufficient: the old
binary ignored the new price book and logged the legacy price instead.

Before any downgrade, preserve the upgraded database and all pending work; select
and independently restore a matching pre-upgrade database/configuration into
separate storage; reconcile every request, hold, receipt, key/configuration change
and audit accepted since that backup; fence old/new writers; and obtain explicit
approval for the reviewed cutover. Without that reconciliation, restoring the old
backup loses accepted work and is not a safe rollback. This prerequisite must also
appear in the final delivery report and deployment checklist.

See [recovery procedures](pricing-database-recovery.md),
[index migration semantics](pricing-index-migrations.md) and the
[Rancher deployment approval boundary](pricing-rancher-rollout.md).

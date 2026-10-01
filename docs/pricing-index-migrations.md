# Additive pricing index migrations

Migration018 adds the nonunique index
`idx_pricing_task_reservation_state` on
`pricing_media_tasks(workspace_id, reservation_id, state)`. It supports the
workspace-scoped reservation ownership lookup used before durable outcome
retention. It does not change ownership rules, prices, receipts, budgets or
retention policy. Historical migrations001–017 and their checksums are unchanged.

## Explicit planning and application

The existing `siftgate pricing-migrate` command still requires one explicit
SQLite path or PostgreSQL URL environment-variable name. It does not read the
gateway configuration or automatically migrate on service startup.

Default/dry-run output now includes `create_indexes`, with the table, index name
and ordered `column_names`. A017 database reports no new tables but one pending
index. A nonexistent SQLite file reports the proposed tables and index without
creating the file or its directory. Consumers must inspect the plan's `state`
and both creation lists; an empty `create_tables` list does not mean the database
is current.

Application requires explicit `--apply`. Index creation and its migration marker
are recorded in the same transaction. If the marker cannot be recorded, index
creation is rolled back. An intact installation can be inspected or applied
again without changing its migration records.

## Integrity and namespace checks

An existing index or object with the expected name but no018 marker is a
conflict, not an invitation to adopt, replace or repair it. A marked index must
exist on the correct table with exactly the ordered columns and nonunique,
ordinary definition. Partial, expression, reordered, descending and modified
collation definitions are rejected. PostgreSQL inspection also checks index
readiness/validity, B-tree access, default operator classes and the absence of
included columns. Names are resolved only in the selected schema.

A mismatched migration checksum or a later migration without its predecessors
is rejected. Investigate conflicts before retrying; do not delete markers or
indexes on a live system to bypass validation. Tests reconstruct historical
schemas only inside disposable fixtures.

## Maintenance and rollback boundary

This is ordinary transactional index creation, **not concurrent/online DDL**.
It can block writers while building. Plan a separately approved maintenance
window, check available storage and lock duration on representative data, and
take a verified SQLite backup-interface backup or PostgreSQL backup first.
Never copy only a live WAL-mode SQLite main file as a backup.

Dry-run inspects schema and is not a lock-time or disk-space forecast. A fast
synthetic index build is not a production downtime guarantee. In particular,
successful isolated migration tests do not authorize a production migration,
restart, configuration change or deployment.

`--remove-empty` continues to refuse any pricing, audit or activated catalog
data. It removes an intact unused schema, including its indexes; it is not a
populated-data downgrade. A real rollback must preserve all post-upgrade
receipts, outstanding reservations and recovery evidence, and requires a
separately rehearsed database-aware plan.

See [performance](pricing-performance.md), [retention](pricing-retention.md)
and the [deployment approval boundary](pricing-rancher-rollout.md).

## Isolated capacity checkpoint —2026-09-29

The compiled migration CLI was exercised on a backup-interface copy of a closed,
synthetic017 SQLite database containing50001 media tasks. Default planning left
the database file unchanged. Explicit application added018; all non-marker table
row hashes and the original17 migration records were unchanged, and foreign-key
checks passed. Separate SQLite/PostgreSQL tests also preserve a real fixture's
price publication, receipt, budget, audit and historical quote replay.

For the exact reservation ownership SELECT,200 measured samples after20 warmups
gave these p95 times on the reference host:

| Case | Before index | After actual018 migration |
| --- | ---: | ---: |
| Reservation without a media task | 4.607167ms | 0.001958ms |
| Reservation with a late-inserted task | 3.914625ms | 0.002083ms |
| Synchronous-only task | 3.678416ms | 0.002000ms |

All result rows, including a wrong-workspace lookup, were identical before and
after. The planner selected the new covering index. Occupied database pages grew
by2592768 bytes. The complete apply CLI took289.65ms, including process startup,
schema inspection and DDL; this is **not** an isolated index-build or lock-hold
duration. Earlier exploratory evidence's `seed_ms` label included the entire
scale; a provenance-linked derivative corrects it to `scale_elapsed_ms` without
changing the values or overwriting the original evidence.

These are synthetic SQLite query/migration results, not a full HTTP benchmark,
PostgreSQL capacity measurement, populated-database downgrade rehearsal or
production maintenance estimate.

## Current compiled-source cross-database assessment

The later [database acceptance report](pricing-database-acceptance.md) adds native
SQLite and PostgreSQL018 measurements on separate populated backup copies, each
with50,001 media tasks. It distinguishes natural index/transaction timing from an
artificially extended lock-contention experiment, checks all non-marker table
digests and records database/index/WAL storage observations. It also provides the
maintenance storage-budget checklist. Neither this bounded assessment nor the
earlier query benchmark certifies production downtime or authorizes migration.

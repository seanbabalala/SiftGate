# Pricing database recovery and application rollback

**Preparation only. This document does not authorize a production migration,
restart, downgrade or restoration.** A backup restore and an application
downgrade are different operations.

For the current compiled-source native SQLite/PostgreSQL rehearsals, populated
video-task recovery, lock/storage assessment and original MIG-02 clause mapping,
see [database acceptance](pricing-database-acceptance.md). The image checkpoints
below are historical evidence for their recorded source versions, not acceptance
of the final candidate image.

## Decision table

| Situation | Supported decision |
| --- | --- |
| The current gateway failed, but the database is intact | Restart the approved current image after preserving diagnostic evidence and draining/fencing competing writers. |
| Recover the current version from a verified backup | Restore into separate storage first; verify schema, identities, receipts, budgets and pending work before selecting it for service. |
| Return to the pre-pricing application | Do not point the old binary at the upgraded live database. Preserve upgraded data and use a separately reviewed database/configuration restore or reconciliation plan. |
| Work was accepted after the selected backup | That backup is not a lossless replacement. Preserve the latest database and account for every subsequent request, hold, audit and configuration change. |
| An unused pricing installation must be removed | The explicit migration CLI's `--remove-empty` guard may be used only on an intact unused installation; it rejects populated pricing/audit data. |

Do not treat “the old process starts” or “the model API returns200” as evidence of
pricing compatibility. Mixed old/new writers are not a supported pricing rollout.

## Consistent SQLite backup

1. Select the database explicitly; do not infer it from the current working
   directory. Record the running source/image identity and migration checksums.
2. Use SQLite's backup interface or the SQLite CLI `.backup` command. A copy of
   only a live WAL-mode main file is not a consistent backup procedure.
3. Write a new, isolated backup artifact. For a sidecar-free portable artifact,
   switch **the completed backup**, not the live source, to `journal_mode=DELETE`
   using an exclusively owned connection, then close it. Never use this step to
   “repair” a main file copied without its WAL.
4. Validate the artifact with integrity and foreign-key checks, expected schema
   markers, accepted request IDs and financial state. Record its SHA-256 and the
   validation results before making it available for restoration.
5. Export an independent copy outside the Rancher VM. A named volume is useful
   persistent storage, but it is not an independent backup of that VM.
6. Retain the matching configuration and secret references securely. Do not place
   live credentials or customer payloads in a public source or review bundle.

An online backup is a point-in-time snapshot, not an ongoing replica. For a
maintenance cutover, stop new admission, drain current work, fence all writers and
take or verify the final backup under the approved procedure. Retaining an older
backup does not make it safe to discard newer accepted work.

## Restore verification

Use a new database path or volume. Never overwrite the only upgraded database
while testing recovery. With the same approved image and `synchronize: false`:

- Before starting the application, compare restored table contents, migration
  checksums, API-key identities and accepted request inventory with the backup.
- After startup, verify API authentication, the original immutable price/FX
  references, exact receipt amounts and budget state.
- An unknown supplier cost must remain unknown. Its unresolved hold must not
  silently become free, be released or cause an automatic repeat provider call.
- Confirm a new synthetic request can complete without altering earlier history.
- Keep the original database, backup and source identity until recovery and any
  reconciliation are accepted.

## PostgreSQL logical backup and restore

Select the source database explicitly and record the PostgreSQL server, dump
client and gateway source versions. Create a custom-format archive with `pg_dump`
and keep it outside the database's storage. Inspect the archive with
`pg_restore --list`; a readable table of contents alone is not a recovery test.

Restore into a fresh, separately named database with `pg_restore` configured to
stop on error. The rehearsal below used `--single-transaction --exit-on-error`.
It used the same synthetic role with `--no-owner --no-privileges`; that does not
verify production role ownership or grants. Review roles, permissions, extensions,
tablespaces, configuration and secret references separately for the target.

Before starting a writer, compare row digests, columns, indexes, foreign keys,
sequences, migration checksums and accepted request IDs. Then run the explicit
migration dry-run and the application-level checks above. Do not use automatic
schema synchronization, rewrite migration markers or remove a real constraint
to force a recovered database to be accepted.

The test used an exported transaction snapshot for both inspection and `pg_dump`.
The gateway stayed running, but no new requests were admitted during each backup
and comparison. In particular, this is not a concurrent sequence-allocation,
point-in-time recovery, cross-version or whole-cluster recovery certification.

## Isolated evidence —2026-09-29

The then-current Linux/ARM64 image was exercised on Rancher Desktop Moby with synthetic
data, named volumes and local mock providers. No production database was mounted
or changed, and no test listener or probe used2099.

- A pre-upgrade snapshot contained one legacy call. Explicit migrations001–018
  preserved every existing table's contents.
- The upgraded database contained priced requests and a completed response whose
  supplier usage was missing. Its amount stayed unknown and its
  `0.001010000000000000`USD synthetic budget hold remained reserved.
- Online backup-interface snapshots were taken while the actual gateway's WAL
  contained committed data. The completed artifacts were normalized to DELETE
  journal mode, exported outside the VM, hash-checked and opened read-only by an
  independent SQLite client.
- One snapshot contained three calls; another request then completed, and the
  final snapshot contained four. Replacing the latter state with the earlier
  snapshot would lose that accepted request; the rehearsal did not do so.
- Restoration of the final snapshot into a fresh volume preserved all tables
  before startup. The current image retained original prices, receipts, key
  identities and the unknown-cost hold, did not repeat the unknown provider
  request, and successfully handled one new synthetic request.
- The populated-schema removal command was rejected without changing table data.

The original `b61d8f48` native baseline was also tested on disposable copies.
Its source archive was verified before execution. It served a pre-upgrade copy,
but when started on an upgraded copy it ignored the new price book: a synthetic
request that cost0.006USD under the new rules was logged at the legacy reference
price of approximately0.0012USD, with no immutable pricing snapshot for that new
request. Existing pricing tables remaining intact did **not** make the downgrade
correct. This is evidence against blind binary rollback, not an approved procedure.

All figures above are test prices and test usage, not customer charges. These
checks do not prove whole-host/engine recovery, every failure mode, PostgreSQL
cross-version restoration, performance acceptance or permission to deploy. See the
[Rancher rollout boundary](pricing-rancher-rollout.md).

## PostgreSQL recovery checkpoint —2026-09-29

The compiled candidate was also exercised with PostgreSQL16.14 on macOS/ARM64,
Node22.23.2 and synthetic loopback HTTP requests. This is separate from the
Linux-image SQLite result above.

- Explicit migrations001–018 preserved all23 existing application tables and
  their sequences. Dry-run and repeated application did not rewrite that state.
- Custom-format backups contained one, three and four accepted requests. All
  three archives were restored into different fresh databases. Table contents,
  columns, indexes, validated constraints, key identities and all11 sequences
  matched their recorded snapshots; the latest snapshot contained59 tables.
- The latest restored database retained original immutable cost hashes and exact
  `0.006000000000000000`USD synthetic charges. A response with missing usage
  retained its unknown amount and `0.001010000000000000`USD reserved hold.
- The restored service did not repeat the unknown provider request. One new
  authenticated request succeeded, with a new log identity and the expected
  exact charge. The separate source database and archive hashes stayed unchanged.
- The populated-schema removal command refused to proceed. An older backup
  would lose later accepted requests; none was used to overwrite the source.

The first real restore exposed a schema-inspection defect: the pinned PostgreSQL
driver returned composite foreign-key columns in a different order, making intact
inheritance constraints look missing. The candidate now reads paired local and
referenced columns by catalog ordinality, scoped to the selected table/schema.
It still rejects wrong column mappings, other-schema targets, missing relations
and unvalidated constraints. Migration definitions and all18 checksums are
unchanged; this is an inspection fix, not a database repair.

The original failed restore evidence was retained. The fixed read-only CLI then
recognized those same restored databases without rewriting their schema. A fresh
end-to-end recovery rehearsal passed, followed by3800 unit tests and688 HTTP
tests. Test servers and databases were cleaned up; archives remain available for
review. The Rancher image at that checkpoint did not include this inspection fix;
the 1,320-file refresh described below does. Neither observation replaces
the remaining final candidate acceptance.

## Refreshed image: populated SQLite restore

The refreshed 1,320-file source image has a new Linux/ARM64 SQLite restore rehearsal,
separate from the historical PostgreSQL exercise above. Three snapshots are made
through the SQLite backup API while committed source data remains in WAL: before
upgrade, after three accepted requests, and after a fourth request. The standalone
backup artifacts use DELETE journal mode; the source remains in WAL mode.

All prior tables survive migration001–018 unchanged. The populated installation
refuses an empty-schema removal rather than silently discarding pricing records.
Restoring the latest snapshot into fresh storage preserves all table contents,
caller-key identities, prices, receipt hashes and the original unknown-cost hold.
The restored service handles one new authenticated request, while the unresolved
provider request is not sent again. Independent read-only checks outside the VM
verify integrity, foreign keys, migration records and unchanged backup bytes.

Older snapshots are explicitly shown to omit subsequently accepted requests; they
are not used as lossless replacements. This evidence does not authorize an in-place
binary downgrade, reconcile production writes, or prove host-failure/PITR recovery.
The native PostgreSQL evidence remains scoped to its recorded source and method;
no new PostgreSQL-in-container restore is claimed by this SQLite refresh.

## Log-subtotal source image restore —2026-09-30

The later 1,326-file source has a separate successful Linux/ARM64 SQLite recovery
rehearsal using its own built image, disposable volumes and synthetic data.
Runtime, frontend and dependency files match the completed 4,031-unit/734-HTTP
native regression. The preceding 1,320-file image is not reused as evidence for
the intervening code changes.

The backup API captures one accepted request before migration, three after
migration and four in the latest snapshot while the source uses WAL. All three
standalone artifacts are exported outside the VM. Independent read-only checks
verify integrity, foreign keys, caller-key identities, migration001–018 where
applicable and the latest unknown-cost reservation; the backup bytes stay
unchanged. A populated-schema removal is rejected.

Restoring the latest snapshot into a fresh volume preserves recorded prices,
receipt hashes and the original unresolved hold. The actual packaged gateway
passes its health check, accepts one new authenticated request and does not
redispatch the unresolved provider request. Earlier snapshots demonstrably omit
later accepted requests and are not used to replace the newer state.

Owned test containers and volumes are removed after successful verification.
Production data and configuration remain untouched. This is a source-specific
historical SQLite image/restore result, not a new PostgreSQL restore, a lossless binary
downgrade procedure, a whole-host failure test or permission to deploy.

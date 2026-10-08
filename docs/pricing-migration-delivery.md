# Migration, import and recovery delivery

This checkpoint delivers D-03's compatibility/import code, explicit migration
plans and isolated rehearsal material. It uses the **current compiled application**
for new SQLite and PostgreSQL recovery runs. It does not authorize a production
migration, price activation, restart, downgrade or deployment. The original
performance and final fixed-source delivery gates remain open.

## Portable attachment

`pricing-migration-review.zip` contains 58 payload files plus its checksum inventory:

| Content | Purpose |
| --- | --- |
| `recovery/` | Current native recovery summaries, table counts/digests, fee/hold examples and independent verification scope |
| `commands/` | Actual migration/backup/restore commands and outputs, with machine root paths replaced by explicit tokens |
| `fixtures/`, `import-results/` | Synthetic pricing-only input, resolved catalog, read-only plans and expected rejection cases |
| `implementation/` | 26 exact compatibility, CLI, backup and migration/schema source extracts |
| `schema.json` | All 18 migration identities/checksums, table and index plans |
| Source/compiled manifests | Exact source identity and explicit uncommitted overlay over the base Git commit |
| `rehearse-sqlite.py` | Optional offline rehearsal that creates its own fresh temporary database; no existing database target is accepted |
| `verify.py` | Offline inventory/digest verification and optional matching-checkout comparison |

The archive is 245,230 bytes. SHA-256:

```text
c990c0309ffa9ab9675adcec30965d1f596f8191cdcb085b6ad495420eca5663
```

No database backup/archive, key rows, credentials, configuration dump, customer
content or private deployment path is distributed. The full synthetic backups
remain in the private evidence set. Command paths use `$FIXTURE`, `$REPO`, `$NODE`
and `$POSTGRES_BIN` tokens; they are evidence, not instructions to paste against
a live database. Source extracts depend on the full repository and are not a
standalone installer or final runtime release.

## Fresh current-source native recovery

Both databases use the actual `dist/main.js`, Node 22.23.2/ABI 127 on macOS/ARM64,
a real Dashboard password/session and a synthetic caller key. PostgreSQL is
16.14. Its fsync, synchronous commits and full-page writes remain enabled. Only
the initial empty legacy fixture bootstrap uses synchronization; application
startup and migration use `synchronize: false`.

Each rehearsal performs the following on its own data, ports and mock supplier:

1. Accept one legacy request and take a consistent pre-upgrade backup.
2. Run the compiled migration CLI's dry-run, apply 001–018, inspect and reapply.
   Dry-run is read-only; original rows and sequences survive the additive change.
3. Record a priced request, an unresolved missing-usage request, a completed
   video and one later request, taking two further snapshots.
4. Reject `--remove-empty` on populated pricing data without changing it.
5. Restore all three snapshots to fresh targets and compare complete rows,
   schema/indexes/constraints/sequences and caller-key identities before startup.
6. Start the latest restored gateway, verify old amounts/receipts/hold identity,
   then accept one new authenticated request. Unknown work is not redispatched.

There are six mock requests per database and six restored backups overall. A token
request remains USD 0.006. Video remains USD 0.66: 6.4 seconds at USD 0.1 plus one
generation at USD 0.02. The missing-usage request retains a null amount and its
USD 0.001010 reservation. These are synthetic examples, not supplier rates.

| Snapshot | Accepted calls | SQLite bytes | PostgreSQL custom archive bytes |
| --- | ---: | ---: | ---: |
| Pre-upgrade | 1 | 946,176 | 118,829 |
| Before later work | 4 | 1,581,056 | 233,740 |
| Latest | 5 | 1,638,400 | 236,165 |

SQLite uses the managed backup CLI/SQLite backup interface while committed WAL
pages exist. Only completed derivative backups are changed to DELETE journal
mode; the source remains WAL. PostgreSQL uses exported-snapshot custom dumps and
fresh `--single-transaction --exit-on-error --no-owner --no-privileges` restores.
Backup/source digests remain unchanged after target restoration.

Independent Python reads verify SQLite rows, schema and sequences. Offline
`pg_restore` inspection checks PostgreSQL COPY row counts, sequence values,
constraint identities, task/hold/price links and exact receipt hashes; the actual
database restores additionally checked full digest equality. No application cost
calculator substitutes for this independent receipt-hash check.

These are small, same-version native recovery fixtures with a live but quiescent
source. They do not certify concurrent sequence allocation, production roles/
grants, cross-version restoration, PITR, Linux-image or whole-host recovery.
Earlier 50,001-task index/storage/lock measurements retain their original source
and dataset limits; that scale workload was not rerun or represented as a
current customer downtime estimate.

## Fresh compiled import and no-write boundaries

Seven CLI cases use the current compiled entrypoint. A network/listen-denying
preload records zero attempted I/O in every case:

- The private synthetic redaction fixture and distributed pricing-only fixture
  each produce eight proposal entries with the explicitly supplied catalog.
- Cache inheritance remains visible: the synthetic messages node resolves cache
  read 0.25 and cache creation 3.125. Confidence and manual-review metadata remain.
- Without the catalog, unresolved fallback sources stay unresolved rather than
  borrowing an ambient catalog or inventing prices.
- Duplicate-key YAML, absent explicit input and unsupported `--apply` are rejected.
- Planning a nonexistent SQLite target does not create its file or parent folder.

Input hashes are unchanged. No default config/data directory is created; secrets
are not resolved, prices are not activated, and no database or supplier is called
by the import preview. Media references do not become verified measurement
support. The separate secret-redaction input is intentionally not distributed.

## Optional disposable script

After extracting the package, a matching built isolated checkout can run:

```sh
python3 verify.py
python3 rehearse-sqlite.py --repo /path/to/isolated-checkout --node /path/to/node
```

The reusable script verifies the compiled fingerprints, clears ambient service/
database variables, creates a private HOME/TMP and a new temporary database, then
runs eight steps: missing-target plan, apply, installed plan, reapply, unused
removal, reinstall, populated-removal refusal and import preview. Its test book
is synthetic and unpublished. It never accepts an existing database target or
starts a gateway/network listener. The new artifact directory remains for review.

The script was executed successfully, not merely packaged. A fresh archive
extraction passes integrity checks; modified schema metadata and extra files are
rejected. These digest checks do not replace the separate populated native
recovery tests or constitute a trusted-party release signature.

## Required approval and rollback boundary

**Never point an old binary at an upgraded live database.** Keep the upgraded
data and pending work, restore a matching pre-upgrade database/configuration into
separate storage, reconcile every request/hold/receipt/key/config/audit accepted
since that backup, fence writers, and obtain explicit cutover approval. An older
backup visibly lacks newer work; restoring it without reconciliation is data loss,
not a safe rollback.

The package includes a non-executed maintenance checklist: approve candidate and
window, preserve the user's newest model configuration, budget storage/WAL and
backup copies per filesystem/VM, verify recovery before migration, drain/fence
only in the approved window, and activate selected tariffs separately from schema.
It does not approve any of those production actions.

See [database acceptance](pricing-database-acceptance.md),
[recovery requirements](pricing-database-recovery.md),
[configuration import](pricing-config-import.md) and
[Rancher rollout](pricing-rancher-rollout.md). All owned test instances are stopped.
Production 2099 and its user-edited model configuration remain unchanged.

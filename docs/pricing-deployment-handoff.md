# Pricing deployment and rollback handoff — not executed

**Status on October 1, 2026: development review only. No cutover, migration,
watchdog change or restart is authorized by this handoff.** The Goal is not yet
`READY_FOR_REVIEW_NOT_DEPLOYED`: the original PostgreSQL performance gate and
final fixed-source candidate deliverable remain open.

This is D-10's non-executed procedure, risk record and approval checklist. It
does not convert previously granted reliability-feature restart approval into
permission for this pricing change. The companion `plan.json` records unresolved
approvals explicitly; its checker cannot authorize or perform deployment.

## 1. Historical checkpoint identity and artifacts

The historical development checkpoint was based on
`b61d8f48ee184cadd13049687729f8c2e4352b9c` with an **uncommitted implementation
overlay**. That base commit and the existing `2.11.5` package version must not be
presented as a commit/release containing the new pricing code. That checkpoint did not assign a candidate commit. Use the separately supplied
final candidate manifest for the local commit, exact source, image digest and
remaining gates; neither this historical image nor the base version identifies it.

An existing provisional Rancher Moby image has manifest digest:

```text
sha256:8307aee19a259254474bd2254d0a2736865f9d998f0903dc23b28e3f7fcaff1f
```

This is a historical image checkpoint. Subsequent implementation changes are
not covered by that image; the final candidate manifest must identify its own
source commit, image digest and verification results. Its tested platform is Linux/ARM64, Node 22.23.3/ABI 127,
SQLite 3.49.2. Actual CMD/HEALTHCHECK, authentication, listener recovery and
in-flight drains were tested. **This is not a newly finalized D-09 candidate or
approval to run that image on 2099.** Native SQLite/PostgreSQL recovery uses the
separate Node 22.23.2/ABI 127/macOS ARM64 build. Do not copy native dependencies
between those platforms merely because their ABI numbers match.

The companion inventory lists exact hashes, sizes and source scope for:

- Whole-source implementation/test/quality review and its **private** raw evidence.
- Seven-language frontend review and scoped screenshots/interaction records.
- Current cost/report/replay API outputs and independent arithmetic checks.
- Current native migration/recovery and the disposable offline rehearsal.
- Operator guidance and the public/source and compiled manifests.

Review-package hashes identify those attachments, not deployable runtime releases.
Keep private raw logs and production identity checks out of public repository or
customer bundles. Never ship synthetic configuration, test credentials or fixture
prices as the production configuration.

## 2. Decisions that are still required

| Decision | Current state |
| --- | --- |
| Performance exception or a candidate meeting the original target | **Unresolved**; no exception accepted |
| Local source commit for the final candidate | Required by D-09; recorded in the final candidate manifest, separately from GitHub publication |
| Final candidate commit/release and image/runtime archive | Not finalized or selected |
| Maintenance window and acceptable interruption/drain deadline | Not approved |
| Production schema migration and verified recovery point | Not approved |
| First model/node bindings, contract rates, calendar, FX and budget basis | Not approved |
| Production supervision/watchdog transition | Not approved |
| GitHub push/merge/release | Not approved; separate from local build and runtime cutover |

The historical checkpoint's PostgreSQL non-streaming JSON/50ms comparison adds
**16.924709ms p95 and loses 18.472475% throughput**, against targets of 5ms and 5%.
Four SQLite and three other PostgreSQL scenarios passed for that source/host.
These numbers are not the later frozen candidate's results; use its raw comparison
report and original unchanged targets.
Pure quote passes separately; it cannot waive this HTTP failure. Silence,
automated Goal continuation, a healthy image or a passing correctness test is
not acceptance of a performance deviation.

Even after all development gates are satisfied, the user must review the final
candidate and separately approve the deployment window. Approval for a local
commit or an artifact export is not permission to restart the gateway.

## 3. Preserve the local-first caller contract

The preferred first deployment target is this Mac using **Rancher Desktop's Moby
engine**, not another Docker engine. The exact local engine endpoint is recorded
privately. Do not change the global Docker context, restart Rancher or stop other
containers as part of this handoff.

Keep the existing caller address, port **2099**, API paths and caller keys. A
future approved container may listen on `0.0.0.0:2099` internally, but the host
publication must preserve the existing host-interface policy. Do not widen LAN
exposure by assuming that `2099:2099` is equivalent to the existing binding.
Record and test localhost, any currently used LAN/reverse-proxy/domain route,
authentication, streaming and client-IP/rate-limit behavior in the approved plan.

The native host's loopback upstream/dependency addresses do not automatically
mean the same endpoint inside a container. Review each configured local service
and secret reference, separating container connectivity adjustments from the
unchanged caller-facing address. Obtain approval before real paid-provider tests.

There must be exactly one production listener and one active database writer.
The native launchd service, its watchdog and the container restart policy must
not compete for 2099 or the same SQLite database. A process restart policy alone
does not repair an unhealthy-but-running listener. Preserve the listener check
and select one explicitly managed production supervision target.

## 4. Staging — allowed only in independent storage

Before any maintenance approval, development may stage reviewed artifacts in
independent storage without loading a service, binding 2099, mounting a production
database, changing production configuration or touching watchdog state.

The operator must later:

1. Verify the final source commit, full manifest, dependency locks, runtime/ABI,
   image identity, package digests and migration 001–018 checksums. Stop on any
   discrepancy. The existing overlay cannot be substituted for an approved commit.
2. Resolve the performance gate and document the exact candidate to which any
   accepted exception applies. A later code change requires scope revalidation.
3. Capture the **then-current** production PID, release, config/secret references,
   database target and supervision identity through authorized inspection. The
   user's model edit must survive; do not overwrite it with an old development
   baseline. If configuration changes after approval, reconcile it explicitly.
4. Define persistent storage outside the disposable image layer. Rehearse its
   permissions/ownership and file sharing. Budget data, indexes, temporary work,
   WAL/journals, retained backups and an operational margin on both host and VM.
5. Produce a matching configuration proposal without resetting caller keys,
   budgets, ownership or price policy. Review the difference, not secret contents
   in public logs. Keep at least one verified recovery copy outside the Rancher VM.
6. Prepare a locally executable, operator-owned maintenance procedure that does
   not need this gateway to obtain its next instruction during the outage. This
   document deliberately contains no executable stop/restart/cutover commands.

## 5. Approved maintenance sequence — not run now

| Stage | Required evidence before proceeding |
| --- | --- |
| A. Reconfirm authority | Written candidate/window/interruption/migration/supervision approval; current identity still matches the reviewed proposal |
| B. Quiesce and drain | Stop new admission by the approved method; account for JSON requests, SSE, WebSocket/Realtime, batches and async work. A zero concurrency counter alone is not proof of a full drain. |
| C. Coordinate supervision | Only with explicit approval, enter the external watchdog maintenance state and prevent native/container restart races. Do not activate a second watchdog. |
| D. Preserve and fence | Preserve diagnostics; verify accepted-work inventory; prove no competing writer remains. Do not delete pending records or kill work to manufacture an empty queue. |
| E. Backup and verify | Make a consistent final backup and independently restore into different storage; verify schema, key identities, requests, receipts, budget/hold state and configuration references. |
| F. Inspect and migrate | Explicit dry-run then approved migration with `synchronize: false`. Stop on conflicts, missing checksums or storage/lock limits; inspect actual state before retrying. |
| G. Switch once to the approved target | Assign the unchanged host address/2099 contract only after the old listener/writer is fenced. Use the pinned artifact, reviewed config and persistent storage. |
| H. Validate service and accounting | Check the acceptance list below; keep rollback materials and prior data intact. Do not label `/health` alone a successful release. |
| I. Restore supervision | Select the approved container-aware target, restore protection and verify no old native watchdog can relaunch a competing writer. |
| J. Observe and record | Record actual interruption, new runtime identity, migration outcome, request errors and accounting state. Close the maintenance record only after approval. |

Short interruption may be necessary. The current evidence promises neither
zero downtime nor an unconditional single restart. Choose drain deadlines and
handling of long-running jobs in the maintenance approval; do not invent them.

## 6. Acceptance checks for the approved deployment

- Same client address, host binding, port 2099 and API routes; no broadened exposure.
- `/live`, `/ready`, `/health` and static Dashboard assets succeed for the intended
  audience. Missing/wrong caller keys and sessions remain rejected.
- Existing caller keys, providers, workspaces and the user's current model
  configuration are preserved. Environment paths and secrets resolve correctly.
- JSON and SSE requests complete; planned Realtime/batch/media integrations retain
  their required drain and custody behavior. Never resend unknown supplier work
  simply to make a pending record disappear.
- Schema inspection reports the approved 001–018 chain with no unexpected edits;
  startup synchronization is disabled. Migration alone creates no model binding.
- A separately approved synthetic/test request validates exact cost, selected
  price/FX/calendar, budget basis, call log and request detail. Paid tests require
  explicit authorization. Unknown usage/FX remains unknown, not zero.
- In-flight/history references remain fixed; no automatic historical reprice or
  destructive backfill occurs. New price activation is a separate admin action.
- Persistent data survives an approved replacement/restart check only if that
  check is part of the window. An application image test does not authorize a
  host reboot, sleep/engine failure test or unrelated-container interruption.
- External alert connectors remain unconfigured unless the user separately
  configures/approves them. Do not send test notifications to real destinations.

## 7. Rollback decision tree

**Never run the pre-pricing binary against the upgraded live database.** A prior
isolated rehearsal showed that an old process can look healthy while ignoring
the new tariff. Starting successfully is not accounting compatibility.

| Failure point | Safe decision boundary |
| --- | --- |
| Before production writes or switching | Stop preparation; leave the existing service, configuration and data untouched. |
| Migration reports an error | Keep admission fenced as approved; inspect transaction/schema state and preserve evidence. Do not assume rollback from the CLI exit code alone or rewrite markers/constraints. |
| New process fails, database is intact | Prefer the approved current-version recovery path after diagnostics; do not substitute an old binary without its database compatibility plan. |
| Restore the same approved version | Restore a verified backup into new storage; compare schema, keys, original prices/receipts/holds and accepted-work inventory before selecting it. |
| Downgrade or restore a pre-upgrade backup | Preserve upgraded data/configuration first. Restore matching old DB/config elsewhere, reconcile every request/hold/receipt/key/config/audit since that backup, fence writers and obtain explicit approval. |
| Requests accepted after the chosen backup | The backup is not lossless. Keep newer data and pending work; reconcile it rather than overwriting the only evidence of accepted requests. |

For SQLite WAL, use the backup interface/`.backup`, never a copy of only the live
main file. For PostgreSQL, select the exact target, take a consistent dump and
verify restore, ownership/grants and environment requirements separately.
`--remove-empty` is for an intact unused installation; it is not a rollback tool
for populated pricing or audit data. Keep backups, current/old releases and
diagnostic records until recovery and reconciliation are accepted.

## 8. Known limits and remaining risks

| Risk / unverified operational condition | Required treatment |
| --- | --- |
| PostgreSQL JSON/50ms performance gap | Meet the original gate or obtain explicit quantified acceptance for the fixed candidate; otherwise no ready declaration |
| Final candidate commit/runtime package absent | Complete D-09 and verify all identities before selecting any production artifact |
| Rancher host reboot, sleep or engine failure | Not tested by restarting the shared host/engine; plan a separately approved operational check |
| Local upstreams, host bindings and real credentials | Not tested against production; review/rehearse authorized connectivity without changing the public caller contract |
| Production scale, disk-full, roles/grants, PITR/cross-version restore | Native synthetic backups and historical index measurements do not certify these; assess the actual environment and recovery objectives |
| Long-lived or async work | Define drain/pending-work custody; do not equate transport completion, provider generation and financial settlement |
| Signal/drain deadline expires | Treat a nonzero/forced exit as incomplete drain, preserve durable evidence and recover; do not report a clean shutdown |
| Global pricing/calendar/FX and budget changes | Require scoped preview, reason, current revision and separate confirmation; do not enable fixture rates or change default business policy automatically |

The private protection record verifies the active listener/release and five
protected configuration/script/plist hashes against the user-confirmed model-edit
baseline. This is evidence that this task did not alter those protected objects;
it is not proof that legitimate production traffic made no database writes.
Production data was neither mounted nor read for development recovery tests.

Refer to [operator guidance](pricing-operations.md),
[migration delivery](pricing-migration-delivery.md),
[database recovery](pricing-database-recovery.md),
[shutdown ownership](pricing-shutdown.md) and [Rancher rollout](pricing-rancher-rollout.md).
The handoff is complete as a **non-executed review document**. Missing approvals
and final-candidate fields are stop conditions, not defaults to guess.

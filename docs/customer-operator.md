# Independent host Operator

The Operator is an opt-in Python 3.9+ process with a private SQLite WAL journal.
It is not the gateway, and the gateway never receives the Docker socket or a
writable operation queue. Publication does not authorize deployment.

For the separate browser-based control plane, roles, two-phase approvals and
Fleet, use [Control Room](customer-control.md). These are two execution modes:
do not run the standalone Operator daemon and the Control executor against the
same installation without reviewing their exclusive worker-lock ownership.

## Explicit enrollment

Use the verified matching release kit and the original installation account:

```bash
INSTALL_DIR="$HOME/siftgate"
python3 "$REVIEWED_KIT/siftgate_agent.py" --directory "$INSTALL_DIR" bootstrap-host-tools --confirm
python3 "$REVIEWED_KIT/siftgate_agent.py" --directory "$INSTALL_DIR" enroll --confirm
```

Bootstrap selects a sealed, versioned host kit without overwriting the original
kit or restarting the gateway. It is for installations not already enrolled;
an enrolled installation must upgrade its kit through a reviewed release plan.
The host owner is a privileged trust boundary, not an ordinary Dashboard role.

## Stage, review and approve

Managed release verification needs an independently trusted GitHub CLI **2.86+**.
Fetch or import an official release, then retain its returned manifest digest:

```bash
python3 "$REVIEWED_KIT/siftgate_agent.py" --directory "$INSTALL_DIR" fetch-release --version X.Y.Z
python3 "$REVIEWED_KIT/siftgate_operator.py" --directory "$INSTALL_DIR" plan upgrade \
  --release-digest "$RELEASE_DIGEST" --request-id change-unique-id
# Or create a disruptive SQLite backup plan:
python3 "$REVIEWED_KIT/siftgate_operator.py" --directory "$INSTALL_DIR" plan backup --request-id backup-unique-id
```

This is preflight, not approval. Upgrade preflight verifies the publisher,
repository/workflow/tag/commit, exact source configuration digest, native target
image and matching host kit. Unsupported source versions/images are rejected.
It does not infer compatibility from a version label alone. Enrolled production
installs cannot use manual `--image` trust or the old `siftgate.py upgrade` path.
`--development` is reserved for synthetic testing, not customer trust policy.

For an owner-operated CLI job, inspect the returned ID/digest and approve within
15 minutes, using your actual timezone-aware start window:

```bash
python3 "$REVIEWED_KIT/siftgate_operator.py" --directory "$INSTALL_DIR" approve "$JOB_ID" \
  --plan-digest "$PLAN_DIGEST" --accept-downtime \
  --not-before "$WINDOW_START" --not-after "$WINDOW_END"
python3 "$REVIEWED_KIT/siftgate_operator.py" --directory "$INSTALL_DIR" serve
```

Windows are at most one hour, starting within seven days. They limit when the
interruption may begin, not when it must finish. Omitting the CLI window permits
immediate execution. Use a service manager for durable unattended execution;
closing an ordinary foreground terminal is not equivalent to closing a browser.
`run-once` is available for deliberate one-shot maintenance.

The Control Room mode instead records a fresh, non-executable host review first,
then grants execution only at the approved window and selected Fleet wave.
A standalone CLI approval cannot bypass a plan already reserved for Control.
Two different control identities are required; host-owner CLI actions are
explicitly a separate privileged channel.

## Execution and failure

The executor rechecks source container/start time, engine, config and kit hashes,
release proof, disk and actual HTTP readiness. It journals stage intent before
external actions: preflight → isolated read-only candidate check → maintenance
marker → graceful stop → verified SQLite snapshot → image/kit metadata switch →
start → HTTP verification. It never automatically boots old code on a newly
migrated database or overwrites new writes with a checkpoint.

Queued CLI jobs survive process restart. Interrupted mutations become
`needs_attention`, not automatic replays. Inspect the owned container, helper
containers, maintenance marker, checkpoint and possible new writes. Recover into
a new directory/port and reconcile before approving a traffic cutover.

```bash
python3 "$REVIEWED_KIT/siftgate_operator.py" --directory "$INSTALL_DIR" show "$JOB_ID"
python3 "$REVIEWED_KIT/siftgate_operator.py" --directory "$INSTALL_DIR" cancel "$JOB_ID"
# Only after actual host reconciliation and deliberate marker handling:
python3 "$REVIEWED_KIT/siftgate_operator.py" --directory "$INSTALL_DIR" resolve "$JOB_ID" --confirm-reconciled
```

Cancel only stops unstarted work. Resolve still requires a matching, running,
HTTP-ready instance with no maintenance marker or orphaned helpers; it does not
perform the repair. Do not delete the journal to bypass safety reservations.

## Read-only observation and bridge

`status`, `show JOB_ID` and `socket-path` remain available independently of the
gateway. The private Unix socket exposes only GET status/job observations.

```bash
python3 "$REVIEWED_KIT/siftgate_operator.py" --directory "$INSTALL_DIR" bridge --enable --confirm
```

This saves the read-only projection/mount setting for the next separately
approved recreation; it does not restart the gateway. It invalidates earlier
preflight fingerprints. The Dashboard observer cannot approve operations and
cannot itself stay reachable while its gateway is down; use independent Control
or the host socket. Disabling the bridge also takes effect only on an approved
recreation. Never restart2099 simply to make an indicator appear.

Protect the host journal separately with WAL-safe tooling. Gateway recovery does
not restore an old operation queue. Backup checksum verification and a completed
isolated Recovery Vault drill are distinct evidence.

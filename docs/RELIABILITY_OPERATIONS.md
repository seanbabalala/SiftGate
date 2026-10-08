# Reliability Operations

## Safety boundary: prepare first, activate once

Building code is not deploying it. While a gateway is serving traffic:

- Use an isolated checkout, dependency installation, build directory, temporary
  database, mock providers, and an ephemeral loopback port for tests.
- Do not change the live configuration, active release symlink, dependencies,
  database, launchd jobs, or systemd units during preparation.
- Do not enable a new external watchdog before the maintenance window: it can
  restart the live process even if no operator explicitly runs a restart command.
- Stage candidate artifacts and a disabled watchdog bundle. Nothing in the
  staging command installs or loads a job, switches a release, or restarts one.

The normal deployment path needs one planned restart. A failed acceptance check
can require an additional restart to roll back; do not promise zero downtime or
an unconditional one-restart guarantee.

## Three separate health meanings

| Endpoint | Meaning | Intended use |
| --- | --- | --- |
| `/live` | HTTP request handling works; returns `{"status":"alive"}` | Liveness/watchdog |
| `/ready` | Database is available; `503` otherwise | Traffic readiness |
| `/health` | Database, upstream, circuit, budget diagnostics | Dashboard/monitoring |

An upstream outage is not a reason to restart the gateway. `/live` deliberately
does not query dependencies. The internal listener watchdog starts only after
`listen()` succeeds, stops before intentional shutdown, and exits with code 1
on unexpected server close or two missing-listener samples five seconds apart.
It emits only PID, time, uptime, and a reason; it does not dump environment
variables, request content, or Node diagnostic reports containing secrets.

An in-process timer cannot recover an event-loop hang. Keep an external HTTP
probe. Restart policies in plain Docker/Compose do not automatically act on
`unhealthy` status; use an external supervisor or an orchestrator liveness probe.
Kubernetes/Helm templates use `/live` for liveness and `/ready` for readiness.

## Stage the macOS watchdog (no installation or activation)

Use an installation directory outside Desktop, Documents, and Downloads.
Check that it is not a symlink back into a protected folder. Use the same
absolute Node executable selected by the service, not an interactive shell alias.

```bash
node scripts/stage-macos-watchdog.js \
  --output-dir "$PWD/output/watchdog-bundle" \
  --install-dir "$HOME/Library/Application Support/siftgate-watchdog" \
  --node "$(command -v node)" \
  --service com.example.siftgate \
  --health-url http://127.0.0.1:2099/live
```

This writes a standalone script, bounded-error-log launcher, configuration, and
plist to **output-dir only**. `enabled` and `allowRestart` are both false. The
plist is not loaded. Use the actual service label during installation; do not
create a second watchdog beside an old job managing the same gateway.

The external watchdog has consecutive-failure detection, an overlap lock,
persistent cooldown/restart limits (default three attempts per 15 minutes), a
maintenance-file gate, a bounded recovery check, and private rotating logs.
An existing lock with an invalid owner or corrupt state fails closed; inspect
the recorded process before repairing state. Never delete a live owner's lock.
Keep state across restarts, or the restart budget will be reset.

Both the wrapper's bootstrap-error log and the watchdog's event log rotate at
1 MiB with three previous files. This does not rotate the gateway's own stdout
or other application files; configure their separate OS log policy as well.

## External notifications

For self-service Feishu/Lark, WeCom, Telegram, or webhook setup, use Dashboard
**Alert connectors**. See [Alert Connectors](WEBHOOK_ALERTS.md) for the private
snapshot bridge and explicit test-message flow. The setup below remains an
alternative for an existing generic receiver. When `alertChannelsFile` is set,
its Dashboard-managed policy takes precedence over `webhookUrlFile`.

Set `webhookUrlFile` to an operator-owned, mode-0600 file containing a generic
HTTPS webhook URL. Never put a real URL/token in Git or a public report. The
receiver must accept JSON fields `event`, `service`, and `timestamp`; use an
adapter for chat systems with a different payload contract.

Events cover unavailable/recovered gateways, restart attempts/failures,
restart-rate limits, optional free-space warnings, and database size warnings.
Set `dataDirectory`/`minFreeBytes` and `databasePath`/`maxDatabaseBytes` to opt in
to those local checks. Disk and database-size warnings never trigger a restart.
Webhook errors are bounded and do not prevent local recovery. Validate actual
delivery with a test receiver before declaring alerting operational.

This local watchdog cannot notify during host power loss or network isolation.
A separate machine/control plane must monitor missing heartbeats or reachability.

## Linux/systemd

Templates are under `deploy/systemd/`. Customize Node, release, config, and data
paths; create the service user and writable directories before installation.
The gateway runs as `siftgate`, with systemd restart throttling. The separate
oneshot watchdog and timer probe HTTP rather than just checking a PID.

Install the watchdog script at `/usr/local/lib/siftgate-watchdog/` and its
configuration at `/etc/siftgate-watchdog/config.json`, owned by root and not
writable by the gateway user. The root-owned watchdog can run the fixed
`systemctl restart` command for its configured unit. Copy the example with
`enabled: false` and `allowRestart: false` until acceptance. Do not enable the
timer during staging. These are templates; validate them on the target Linux
distribution before a customer rollout. A macOS test is not a Linux/systemd test.
Also install `src/alerts/alert-connector-runtime.js` as
`/usr/local/lib/siftgate-watchdog/lib/alert-connectors.js`; it has only Node
built-in dependencies. The provided systemd/Compose gateway templates set the
private connector-export path for subsequent self-service changes.

## SQLite backups and rotation

Never copy only a live WAL-mode `.db` file with `cp`/`copyFileSync`. Committed
transactions may still live in `-wal`. Copying the three files sequentially is
not a transactional snapshot either. Do not delete live WAL/SHM files.

```bash
node dist/cli/siftgate.js backup-db \
  --sqlite-path /var/lib/siftgate/gateway.db \
  --output-dir /var/backups/siftgate

# Explicitly opt in to keeping seven managed snapshots of this source:
node dist/cli/siftgate.js backup-db \
  --sqlite-path /var/lib/siftgate/gateway.db \
  --output-dir /var/backups/siftgate --prune --keep 7
```

The command uses the SQLite backup API in bounded page batches, checks the
completed snapshot with `quick_check`, writes private files, and publishes
without overwriting existing files. A JSON manifest includes SHA-256 and size.
Only after a new snapshot succeeds can rotation delete recognized managed
backups of the same source. Historical manually named backups, other sources,
and incomplete/unrecognized files are left alone. No rotation occurs without
`--prune`. Use a dedicated, private directory and one job at a time.

A `.siftgate-backup.lock` left by a killed backup requires operator inspection;
do not remove it until its recorded process has stopped. The job returns nonzero
on backup/validation failure and must be covered by job-failure monitoring.
The command is on-demand: scheduling nightly execution is a separate explicit
deployment step, not something an application upgrade silently enables.

Store another copy outside the gateway host. Check hashes and periodically boot
an isolated restore, verify schema and representative row counts, and exercise
Dashboard/API-key access. `quick_check` alone is not a complete recovery drill.
Do not remove old manual backups until a replacement has passed that drill.

`migrate-db --backup` uses the same WAL-safe primitive. The migration itself
still requires stopped writes/a maintenance window; this is not online migration.

## Log retention and disk reclamation

Automatic cleanup already starts 60 seconds after initialization and repeats
every six hours, deleting at most 500 rows per batch. The default is 30 days.
`database.log_retention_days: 0` explicitly means keep forever and remains so.
Shutdown prevents additional cleanup batches. No upgrade changes this value.

Before lowering retention, obtain operator approval, take a verified backup,
and confirm which usage/billing/audit reports depend on raw history. Use a
staged configuration change, not an edit to the live hot-reloaded file during
preparation. Monitor the first cleanup; a large backlog still creates I/O.

Deleting rows makes pages reusable but normally does not shrink the SQLite
file. Schedule compaction separately, with free-space and lock-time checks,
and only after a restore-tested backup. Do not automatically run `VACUUM` on a
busy production database. PostgreSQL remains the recommended independently
operated production metadata path; backup and retention policies still apply.

## Approved cutover and rollback checklist

1. Record the live PID, release target, build manifest, and config checksum.
   Confirm the candidate matches the reviewed source and required tests passed.
2. Prepare an immutable candidate using the service's Node/native-addon ABI.
   Build outside the active release. Smoke-test on a temporary loopback port
   with a disposable database and mock upstreams; never copy live secrets into
   test fixtures. Keep the previous release intact.
3. Obtain approval for the maintenance window. Pause admission and drain active
   streams/agent requests, or explicitly agree to interrupt them.
4. Set the external watchdog's maintenance gate. Disable/remove any previous
   watchdog job before installing its replacement. Make a verified backup if
   applying retention/schema changes; retain the previous configuration.
5. Atomically switch the release target and perform the **one planned restart**.
   Apply only the configuration changes explicitly approved for this window.
6. Verify PID/version/checksums, `/live`, `/ready`, Dashboard and a controlled
   gateway request. Check process and listener stability. If acceptance fails,
   keep the watchdog paused, restore the previous release/config, and restart
   again. Application rollback cannot undo deleted history or schema changes.
7. Install/load the watchdog from its non-protected path with restarts disabled.
   Verify execution under launchd/systemd, not merely from an interactive shell.
   Verify webhook receipt; then enable automatic recovery and remove the gate.
8. Do destructive failure injection only against an isolated test service. For
   future maintenance, set the gate before any intentional stop.

Listener self-healing does not provide host-level high availability. Customers
requiring continuity through machine loss need a tested multi-instance traffic
and shared-state design. Central automatic upgrades, retention-policy choices,
alert channel credentials, and customer-fleet views are separate rollout work;
they are not silently activated by this reliability patch.

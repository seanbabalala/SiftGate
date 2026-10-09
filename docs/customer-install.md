# Customer installation and release kit

For v2.12.0+, download the signed manifest and Sigstore bundle as well as the archive/checksum. **Verify publisher identity and bound archive bytes before extracting or executing the kit**, following [artifact verification](customer-artifact-verification.md). Managed lifecycle features require independently trusted GitHub CLI2.86+. Basic self-built, un-enrolled installs remain an explicitly owner-trusted path, not a publisher-verification result.

Independent upgrades, recovery drills, roles, approvals and offline/Fleet operations are described in [Control Room](customer-control.md). They are opt-in and never enroll or upgrade an existing2099 automatically.

> Development-branch lifecycle changes are not released yet. v2.11.7 used its bundled random-password instructions; this branch uses first activation and an opt-in operator. Do not mix the new source kit with an older image.

This kit installs a **new, independent** SiftGate instance. It never imports the
maintainer's configuration, keys, call history, or machine-specific deployment
bundle. It is not a migration script for an existing native service. Do not use
it to overwrite an existing installation or an occupied port.

## Availability and prerequisites

- Source checkout: supply `--image` for an image you have built or published.
  Adding this kit to Git does **not** publish the new application image.
- Formal release: use the `siftgate-vX.Y.Z-install.tar.gz` asset and its `.sha256`
  file from that version's GitHub Release. `release.json` pins the image's
  registry digest and exact source commit. No implicit `latest` channel.
- Linux: Docker Engine, Docker Compose **2.30+**, Python **3.9+**, and the OS IANA
  timezone database. No host Node.js, npm, compiler, or pip packages are needed.
- macOS: Rancher Desktop **Moby** or another local Docker-compatible Linux engine,
  Compose and Python 3.9+. Rancher Desktop is not required on a Linux server.
- Use an account permitted to access Docker. This permission is effectively
  host-root access. Run all kit commands as the same installation owner.
- Local Unix sockets only; remote Docker contexts are rejected because host
  directory mounts would refer to a different machine. The selected engine and
  context/socket are recorded; the kit never switches the global Docker context.
- Store the install directory on a local disk, outside Desktop/Documents/Downloads
  on macOS, and inside a directory shared with the Docker VM. The root directory
  must not exist yet. Do not put it inside a source checkout or synchronize it to
  a public/cloud-shared folder. Network filesystems are not supported for SQLite.

## Install

Verify the downloaded archive before extracting it:

```bash
sha256sum -c siftgate-vX.Y.Z-install.tar.gz.sha256
# macOS alternative: shasum -a 256 -c siftgate-vX.Y.Z-install.tar.gz.sha256
tar -xzf siftgate-vX.Y.Z-install.tar.gz
cd siftgate-vX.Y.Z
sha256sum -c SHA256SUMS

# Select your actual billing/budget timezone. UTC is also supported.
python3 siftgate.py --directory "$HOME/siftgate" init --timezone Asia/Shanghai
python3 "$HOME/siftgate/kit/siftgate.py" --directory "$HOME/siftgate" up
```

`vX.Y.Z` is a placeholder for an actually published release, not an existing
download promise. On Rancher Desktop pass `--docker-host "unix://$HOME/.rd/docker.sock"`
to `init` when that is your configured Moby socket. This is an explicit choice,
not a change to any existing Docker context.

For an unpublished source build, build an image with the repository Dockerfile,
then run `python3 deploy/customer/siftgate.py --directory "$HOME/siftgate" init
--timezone Asia/Shanghai --image siftgate:YOUR_VERSION --local-image`.
`--local-image` also supports air-gapped images previously imported with
`docker load`; transfer the exact image and verify its checksum separately.

The default port is **2099**, bound to **127.0.0.1 only**. Use `--port 21099` for
a second instance. Occupied ports are rejected; the installer never stops the
process using that port. Each installation gets a unique Compose project name.

`init` prepares files, pulls/resolves the image, and validates configuration. It
does not start the gateway. `up` starts it and checks real HTTP `/live` and `/ready`.
If initialization fails, keep the partial directory for diagnosis; a repeated
`init` refuses to overwrite it. Choose a new directory after fixing the cause.

## First login and configuration

Open `http://localhost:2099/dashboard`. Read this installation's **single-use, 15-minute activation code** locally:

```bash
cat "$HOME/siftgate/config/activate-code.txt"
```

Choose your administrator password in the activation page, then sign in. There is no shared default password. The private identity file stores a password hash and a rotating session signer, not the plaintext password. Spent codes are invalidated and removed; code files are excluded from backups.

If activation expires, the installation owner can run `access-code --purpose activate --confirm` with the installed `siftgate.py`. Forgotten managed passwords use `access-code --purpose recover --confirm` and the login page's recovery flow. Credential recovery does not restart the gateway or rotate application API keys. Existing legacy password/OIDC installs are not automatically migrated.

Launchpad guides environment review → provider setup → bounded single-node/model text API key → explicitly approved real request → recorded evidence. New sample nodes use `disabled: true`. The formerly ignored `enabled:false` field is not reinterpreted on old installations, preventing an upgrade from unexpectedly disabling established traffic. Review prices, limits and any configured health probes before enabling a node. Tests can incur provider charges and are never sent automatically by Launchpad.

Secrets can be entered through the existing Dashboard or supplied in
`provider.env` as raw `KEY=value` lines and referenced using `${env:KEY}` in YAML.
Changing environment variables requires a scheduled container recreation; a
Dashboard edit does not magically update a running process's environment.

## Persistence and security

```text
installation.json   immutable image identity, timezone, engine and instance identity
kit/                installed management scripts and Compose definition
config/             writable configuration DIRECTORY (supports atomic Dashboard saves)
data/               SQLite, WAL and retained accounting data
state/              catalog cache/overrides and local managed state
provider.env        private provider environment (raw values; never commit)
backups/            private verified recovery snapshots
maintenance         fail-closed marker for interrupted/failed maintenance
watchdog.json       bounded external-recovery history
```

Directories are private and the container runs with the install owner's UID/GID,
not an assumed root user. Backups are mounted only into the temporary backup
helper, not the running gateway. Docker logs rotate at 10 MB × 3. Call-log retention
starts at 30 days. These are separate retention policies. No Docker socket is
mounted inside the gateway container.

The default `local` mode uses HTTP cookies only on host loopback. For a server,
initialize with `--mode https`; put an HTTPS reverse proxy in front of the
loopback listener, then access the Dashboard via that HTTPS origin. In this
mode `NODE_ENV=production` makes the session cookie Secure. The kit does not
provision a domain, proxy, or certificate. Do not expect direct plain-HTTP login
to work in this mode. `--bind 0.0.0.0` is accepted only with HTTPS mode; it is
**not TLS termination** and must be protected by firewall/private ingress.
Configure trusted proxy and CORS settings for your actual topology, not `*`.

Never change the timezone casually on an existing instance: it defines daily
budget boundaries. Restore preserves the snapshot's timezone. Host-loopback
provider addresses must be changed for containers; `127.0.0.1` inside the
container is not the host. Prefer routable private provider endpoints. If using
`host.docker.internal` on Linux, explicitly configure an appropriate host-gateway
mapping and verify connectivity; this kit does not silently rewrite nodes.

## Operate, back up and upgrade

Use the installed script, not a newer unrelated checkout:

```bash
python3 "$HOME/siftgate/kit/siftgate.py" --directory "$HOME/siftgate" doctor
python3 "$HOME/siftgate/kit/siftgate.py" --directory "$HOME/siftgate" status
python3 "$HOME/siftgate/kit/siftgate.py" --directory "$HOME/siftgate" backup --accept-downtime --keep 7
```

Full kit backups **briefly stop and drain this single instance**, snapshot the
SQLite database using the application's SQLite backup API, copy configuration,
private environment and retained local state, verify SHA-256 manifests, and
restart only if the instance was previously running. Plan a maintenance window.
This is not a zero-downtime or cross-database distributed snapshot feature.
Never `cp gateway.db` from a live WAL database. For database-only online snapshots,
the application also has `node dist/cli/siftgate.js backup-db`; those snapshots
alone are not a full configuration/secret/retained-state recovery bundle.

Rotation is opt-in (`--keep 7`). Only verified routine snapshots belonging to
this installation are pruned. Incomplete, damaged, foreign and upgrade snapshots
are retained. Monitor disk usage and explicitly retire obsolete upgrade checkpoints
after the recovery window; do not assume every backup is automatically deleted.
Keep encrypted/off-host copies and periodically rehearse a restore.

Upgrade to an explicitly reviewed published digest/version:

```bash
python3 "$HOME/siftgate/kit/siftgate.py" --directory "$HOME/siftgate" upgrade \
  --image ghcr.io/seanbabalala/ai-gateway@sha256:RELEASE_DIGEST --accept-downtime
```

The target is pulled and config-validated before stopping the old instance. A
verified full recovery checkpoint precedes application boot/schema changes.
Config, keys and timezone are preserved. The command checks HTTP readiness, not
just process existence. This is a single-instance restart, **not a zero-downtime
upgrade or unattended fleet auto-update**. Container restart policy is not an
image updater. Review migration/release notes before choosing a version.

If backup or upgrade fails, inspect the retained `maintenance` marker, Docker
logs, `installation.json` and backup manifest. The kit does not automatically
restore an old DB or run an old binary against an upgraded schema. The candidate
may already have accepted business data before a readiness failure. Preserve
and reconcile that data first. Removing `maintenance` is an explicit operator
decision after inspection, not a troubleshooting shortcut.

## Restore and rollback rehearsal

Restore only into a **new directory**, initially on a different port:

```bash
python3 "$HOME/siftgate/kit/siftgate.py" --directory "$HOME/siftgate-recovery" restore \
  --backup "$HOME/siftgate/backups/backup-SNAPSHOT_ID" --port 21099
python3 "$HOME/siftgate-recovery/kit/siftgate.py" --directory "$HOME/siftgate-recovery" up
```

Use `--local-image` if the original image is still loaded or was imported offline.
Otherwise the original image reference must still be available; the resolved
image identity must equal the backup's identity. Preserve the old image/offline
archive for the entire recovery window. A mismatch fails without starting the
restored gateway. Hash mismatches, extra files and symbolic links are rejected.

Managed-identity restores revoke prior Dashboard sessions and pending recovery codes; sign in again with the password from the snapshot. Application API keys are preserved.

Verify authentication, keys, budgets, logs, pricing and provider connectivity in
the restored instance. It is intentionally **not** automatically made production.
Pause writers and reconcile data since the snapshot before any real traffic
switch. Restore does not modify or stop the source installation.

The kit's managed backup/restore path supports only SQLite at its managed path.
Switching to PostgreSQL requires the documented application migration procedure
and PostgreSQL-native backup/restore; the kit refuses to pretend its SQLite
snapshot protects an external PostgreSQL database. Redis/HA/Kubernetes are
separate advanced deployment paths, not automatically installed dependencies.

## Boot and bounded self-healing

`restart: unless-stopped` restarts an exited container when the Docker engine is
running. Enable the Docker service at boot on Linux. On a Mac, enable Rancher
Desktop's startup at login separately; this is not guaranteed pre-login server
availability. The installer does not reboot the host or change desktop settings.

The application exits on a lost listener. An independent HTTP watchdog also
covers a process that stays alive but cannot answer `/live`. Compose's unhealthy
label alone does not restart a container. Run:

```bash
python3 "$HOME/siftgate/kit/siftgate.py" --directory "$HOME/siftgate" watchdog
# Explicitly permit recovery (schedule every 30 seconds):
python3 "$HOME/siftgate/kit/siftgate.py" --directory "$HOME/siftgate" watchdog --recover
```

The default invocation observes only. Recovery requires three failed probes,
has a 120-second cooldown and a maximum of three attempts per 15 minutes, locks
against maintenance, checks container ownership, and never revives a stopped
or paused instance. It probes `/live`, not database/provider readiness.

Linux templates `siftgate-watchdog.service` and `.timer` are included in the
release archive/source `deploy/customer/`. Adapt owner and absolute paths,
install them under `/etc/systemd/system`, run `systemctl daemon-reload`, then
`systemctl enable --now siftgate-watchdog.timer`. Test observe-only first.
For a Mac, schedule the same command with a user LaunchAgent stored outside
protected folders and an explicit Python path; do not reuse maintainer-specific
plist labels. The kit does not install a scheduler automatically.

Watchdog JSON goes to the scheduler's logs. Application alert connectors remain
configurable in the Dashboard. This kit does not claim that a dead gateway can
send its own alert: use an external monitor/journal collector to deliver host
watchdog/down notifications. HTTP liveness is not proof a provider is healthy.

## Maintainer release gate

The full publisher runbooks are `docs/customer-release.md` and
`docs/customer-release.zh-cn.md` in the source repository. They cover first-time
GHCR access, exact-commit CI, tag approval, fixed architecture digests, both version
aliases, interrupted uploads, anonymous verification and offline delivery.

1. Review and merge the candidate code and customer kit to `main`. Align the
   actual version metadata and run the repository release checks.
2. Manually run **Customer multi-platform release** for a test-only build if
   desired. It builds and runs real acceptance on native Linux AMD64 and ARM64;
   a manual run never publishes an image or release, even if a tag is selected.
3. Wait for successful full main push CI for the exact reviewed commit, then push
   an annotated `vX.Y.Z` tag on that commit. Only this action
   enables image publication. No branch push triggers a release or fleet update.
4. Both architectures must pass before the combined version image and installation
   archive are published. The workflow requires anonymous GHCR access before
   uploading a public installer. A new GHCR package may initially be private:
   the owner must make it public, then rerun only the failed publish job. An
   existing version is accepted only if it contains the exact tested architecture
   digests; a different release is never overwritten. Private distribution needs
   a separately reviewed credential-aware publication policy.
5. Rehearse install/upgrade/restore with the actual versioned image. The smoke test
   covers fresh setup, real mock-provider routing, Dashboard config persistence,
   credentials, safe backup, restart and independent restore. It is not a claim
   that arbitrary old/new schema combinations or every Linux distribution passed.

Never publish maintainer migration bundles, runtime volumes, or local test
directories. `scripts/package-customer-release.py` reads a fixed allowlist from
an exact Git commit, not the working directory. Publishing a release does not
automatically upgrade the maintainer's or a customer's running instance.

References: Docker Compose installation, Docker restart policies, SQLite Online
Backup API, and Rancher Desktop Moby documentation should be consulted for your
specific supported platform/runtime versions.

- https://docs.docker.com/compose/install/linux/
- https://docs.docker.com/engine/containers/start-containers-automatically/
- https://www.sqlite.org/backup.html
- https://docs.rancherdesktop.io/ui/preferences/container-engine/general/


## Optional independent host operator

The new operator provides persistent host-approved backup/upgrade jobs and an instance-bound, read-only Control Room. Enrollment does not start services; bridge changes take effect only at a separately approved recreation. It is not a publisher-signature verifier or an automatic cross-version upgrade system. Read the matching [operator guide](customer-operator.md) before enabling it. Existing running instances are not enrolled automatically.

## Release notifications

The post-v2.12.0 source adds opt-out background version notices in the regular
dashboard; see [Release update notifications](release-updates.md) for privacy,
offline policy and the distinction between discovery and actual upgrade. This
does not retroactively change the published v2.12.0 image.

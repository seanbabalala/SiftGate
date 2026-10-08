# Control Room, Release Center, Recovery Vault and Fleet

A separate, opt-in host service owns maintenance execution. It does not run in
the gateway and does not inherit Dashboard passwords, JWTs, business API Keys or
roles. The gateway keeps serving if the control plane is unavailable. Publication
is not deployment; no existing installation is enrolled automatically.

## Prerequisites and trust

Python3.9+, local Docker/Compose2.30+, and independently trusted GitHub CLI2.86+
for managed release verification. Use the original installation account and
private local directories, never a shared network filesystem. Docker authority
is effectively host-root authority. The host owner is explicitly trusted.

Use a reviewed release kit, not scripts copied casually into an old installation:

```bash
CONTROL_HOME="$HOME/siftgate-control"
python3 "$REVIEWED_KIT/siftgate_control.py" --home "$CONTROL_HOME" init --owner operations-owner --confirm
python3 "$REVIEWED_KIT/siftgate_control.py" --home "$CONTROL_HOME" serve --port 2100
```

Use the local `activate-code.txt` (single-use,15minutes) to set your control
password. There is no default/shared password. Invite another named approver;
even an account with all roles cannot approve or reconcile its own proposal.

| Role | Authority |
|---|---|
| viewer | Observe enrolled sites, jobs and evidence |
| planner | Fetch/import releases, preflight and propose maintenance |
| approver | Approve another user's exact plan/waves, pause/cancel, reconcile |
| admin | Manage control identities and inspect audit; does not imply other roles |

Password/role changes revoke control sessions only. Browser credentials are
explicit Bearer tokens in origin-bound sessionStorage, never host-wide cookies
or gateway storage. Do not log Authorization headers, codes or request bodies.

For persistent execution use the reviewed `siftgate-control.service` template.
Closing a page does not cancel accepted work; killing a foreground host process
is different. Do not run the standalone Operator daemon and Control worker
against the same install without reviewing exclusive worker ownership.

## Network boundary

The server binds only127.0.0.1, rejects port2099, and checks exact Host/Origin.
For remote use supply `--origin https://ops.example.com` behind a dedicated TLS
reverse proxy. Preserve the configured Host and browser Origin; allow long
maintenance request reads. Do not share an origin with untrusted apps, use a URL
subpath instead of a dedicated origin, or proxy Control through the very gateway
being restarted. No CORS or arbitrary shell/path execution API is exposed.

## Enroll deliberately

```bash
python3 "$REVIEWED_KIT/siftgate_agent.py" --directory "$INSTALL_DIR" bootstrap-host-tools --confirm
python3 "$REVIEWED_KIT/siftgate_agent.py" --directory "$INSTALL_DIR" enroll --confirm
python3 "$REVIEWED_KIT/siftgate_control.py" --home "$CONTROL_HOME" enroll-local \
  --name "Office gateway" --directory "$INSTALL_DIR" \
  --agent-path "$REVIEWED_KIT/siftgate_agent.py" --confirm
```

Bootstrap is for a not-yet-enrolled install. It selects sealed versioned tools,
retains the original kit and leaves the current gateway running. Already enrolled
installs must use approved kit upgrades. Keep the original entrypoint immutable;
it delegates to the selected kit. Enrollment fixes instance/engine identity.

For SSH, configure only on the control host, not in a browser:

```bash
python3 "$REVIEWED_KIT/siftgate_control.py" --home "$CONTROL_HOME" enroll-ssh \
  --name "Branch gateway" --host "$HOST" --user "$OWNER" --port 22 \
  --directory "$REMOTE_INSTALL" --agent-path "$REMOTE_AGENT" \
  --identity-file "$IDENTITY_FILE" --known-hosts-file "$KNOWN_HOSTS" --confirm
```

Verify host keys independently first; a blind first scan is not authenticated
trust. The connection uses strict host-key checking and no forwarding. Ensure
the remote noninteractive account can run its fixed Python/Agent and Docker CLI.
Prefer a restricted SSH key/forced-agent entrypoint for one installation. The
web plane cannot register arbitrary hosts or choose executable paths.

## Release planning and waves

Discovery is not verification and never auto-installs. Fetch/inspect verifies the
publisher's repository, workflow, tag, commit and artifact digest; then verifies
native image configuration and staged kit. Only declared exact source image
configurations are supported. Labels/checksums alone are not publisher proof.

Preflight every selected target; failures are not silently removed. Independent
approval first enters `approval_pending`. A separate thread records real host
reviews before the original15-minute expiry; Agent jobs remain non-executable.
Only after all reviews are confirmed is the Control job scheduled. At the start
window and selected wave it grants execution to those targets and rechecks
actual source state. Existing reviews can be observed after restart but cannot
be backdated, extended or replaced with a different plan/window.

Windows are at most one hour, within seven days; they bound interruption start,
not completion. Begin with a canary, then independently approve each wave.
Execution is sequential within a wave, not an HA/zero-downtime promise. Pause or
cancel lets an in-flight target reach a safe outcome; later targets do not start.
A reached failure threshold requires review/cancellation and a new proposal.

## Recovery and reconciliation

Vault distinguishes historical checksum evidence, a completed isolated restore
drill and production cutover. A drill uses another directory, no network and no
published port; it checks HTTP, database/key/log/config evidence and cleanup.
Managed copied sessions are revoked. Authenticated legacy recovery changes only
the management signing secret, preserving password/OIDC and business data;
unauthenticated legacy configs fail closed.

New backups freeze matching tools and bind the real image config digest/arch.
Restore checks it before copying/mounting customer files; `restore --image` may
select a differently named offline handle only when that identity matches.
Unproven old backups require the original engine/architecture/runtime handle.
Backups contain secrets and executable tools: use private, trusted-origin backups.
Digests are not protection against an attacker who owns the backup/host.

For `needs_attention`, do not retry the upgrade blindly. Repair/inspect the host
first when actual gateway mutation is uncertain, then let a different approver
recheck the original Agent plan and close the batch. Pending work is cancelled;
terminal success is re-observed; uncertain/running jobs retain reservations.
Only owned, networkless drill containers may be cleaned up automatically.
`resolved` is not proof an upgrade succeeded. Remaining targets need a new plan.
Never edit the ledger to force success or restore over new writes.

## Offline workflow

On an independently trusted online host, obtain the official verifier and its
trusted roots separately from an incoming upgrade package:

```bash
gh attestation trusted-root > trusted-root.jsonl
sha256sum trusted-root.jsonl
# Transfer/verify that digest through an independent trusted channel.
python3 "$REVIEWED_KIT/siftgate_agent.py" --directory "$INSTALL_DIR" pin-trust \
  --file trusted-root.jsonl --sha256 "$ROOT_SHA256" --confirm
python3 "$REVIEWED_KIT/siftgate_agent.py" --directory "$INSTALL_DIR" fetch-release --version X.Y.Z
mkdir -m 700 "$HOME/siftgate-exports"
python3 "$REVIEWED_KIT/siftgate_agent.py" --directory "$INSTALL_DIR" export-offline \
  --release-digest "$RELEASE_DIGEST" --output "$HOME/siftgate-exports/version-package" --confirm
```

`--local-image` exports a previously verified, engine-bound image instead of
pulling again; it cannot select an arbitrary image. The package contains only
manifest/bundle/installer/image/offline metadata, not a trusted root or customer
configuration. Pin roots separately on the receiving host, then stage there:

```bash
python3 "$REVIEWED_KIT/siftgate_agent.py" --directory "$INSTALL_DIR" stage-offline \
  --source "$OFFLINE_PACKAGE" --confirm
```

Verify/import its opaque inbox ID in Control, then propose with offline mode.
Import verifies files, every layer, loaded configuration and engine binding;
it never approves or starts an upgrade. No automatic overwrite or cutover.
Trust-root changes require explicit owner review outside imported packages.

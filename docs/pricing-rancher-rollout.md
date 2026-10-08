# Local-first Rancher Desktop rollout plan

**Status: preparation and isolated verification only. No production deployment is
authorized by this document.** The pricing Goal still stops at
`READY_FOR_REVIEW_NOT_DEPLOYED`; its remaining performance and acceptance work
must not be replaced with a successful container smoke test.

Use the consolidated [non-executed deployment handoff](pricing-deployment-handoff.md)
for current artifact identity, unresolved approvals, maintenance checkpoints and
rollback decisions. Its valid checklist deliberately does not mean a deployable
candidate or permission to cut over 2099.

The deployment preference recorded on 2026-09-28 is to make the existing local
Mac the first deployment target, using its **Rancher Desktop Moby engine**, while
preserving the existing gateway address and host port **2099**. Docker is a
deployment option, not a new client protocol or a requirement to change callers.
The active native Node/launchd gateway remains untouched during development.

The image records below are historical checkpoints, not an identification of
the final frozen candidate. Its separate manifest must pin the source commit,
image digest and actual verification results. Do not deploy an old image merely
because a historical checkpoint passed.

## Target and invariants

```text
Existing client address and API path
  -> existing host interface(s):2099
  -> Rancher Desktop port publishing
  -> gateway container, listening on 0.0.0.0:2099
```

- Preserve API paths, gateway keys, provider configuration and workspace data.
  Port mapping alone does not migrate any of those records.
- Preserve the existing host binding policy. Verify localhost, any existing LAN
  or reverse-proxy/domain entry points, authentication, streaming and rate-limit
  behavior. Do not silently widen access or assume client-IP handling is unchanged.
- Rehearse connectivity from the container to every configured upstream and local
  dependency. A host-loopback address in the native configuration must not be
  assumed to reach the Mac from the container. Keep any container-specific
  connection changes separate from the client-facing2099address contract.
- There must be one production listener and one database writer during cutover.
  The native launchd service and its watchdog must not race the container for2099.
- Keep configuration and the database outside the disposable container layer.
  A named volume survives container replacement, but an independent backup
  outside the Rancher VM is still required. Host-directory permissions and file
  sharing must be rehearsed before selecting a bind-mounted alternative.
- Use an identified image digest, source/dependency manifests and an explicit
  schema migration. Do not enable production `synchronize` as an upgrade method.

## Historical image checkpoint: PostgreSQL inbox-persistence source

The provisional `siftgate-pricing-goal:rancher-49e49e49b2ff` image refreshes the
1,401-file source after the inbox-persistence change and the complete
4,336-unit/807-HTTP regression. Its manifest digest is
`sha256:8307aee19a259254474bd2254d0a2736865f9d998f0903dc23b28e3f7fcaff1f`.
The tested runtime remains Rancher Desktop Moby, Linux/ARM64, Node22.23.3/ABI127
and SQLite3.49.2, with the actual image CMD and packaged HEALTHCHECK.

The corrected all-caller fixture below passes again on this image: real
Dashboard password/session authentication without an unauthenticated override,
caller-key boundaries, live/ready/health/static assets, explicit migration001–018,
JSON/SSE pricing and history, process/listener automatic recovery, and both
in-flight SIGTERM phases. Final accounting remains13mock calls/logs,12priced
attempts,286300logical tokens and exactly0.584620000000000000USD. All owned test
containers, network and data volume are removed; the builder is stopped. Other
containers, engine settings, global context and production2099 remain unchanged.

This image's fixture database is SQLite. PostgreSQL-specific grouped writes are
covered by the separate native PostgreSQL tests and comparisons, not relabeled
as PostgreSQL-in-image evidence. No new image export/release bundle, AMD64,
host-failure or production cutover is certified. The delayed PostgreSQL JSON
performance gate and final delivery still remain open.

## Previous image checkpoint: authenticated startup and in-flight drain

The provisional `siftgate-pricing-goal:rancher-0fa727d2a594` image is built from
the 1,401-file settlement-phase source manifest, including the current receipt
and budget transaction changes. Its image manifest digest is
`sha256:7e752dda824473cd2a91383acefeb00e6d57ce4e77ea30af7e973ccf4375a4a2`.
It uses Rancher Desktop Moby, Linux/ARM64, Node22.23.3/ABI127 and SQLite3.49.2.
The application source matches the recorded 4,319-unit/807-HTTP full regression;
this image exercise is new, but those native suites were not rerun for it.

Unlike the earlier image fixtures, Dashboard authentication is enabled with a
synthetic bcrypt password and **no unauthenticated-dashboard override**. The
actual image CMD, packaged HEALTHCHECK, `/live`, `/ready`, `/health`, SPA entry
and static assets pass. HTTP authentication checks verify:

- Missing/wrong passwords and missing/malformed sessions are rejected.
- A real login issues a Secure, HttpOnly, SameSite=Lax cookie; that cookie grants
  Dashboard access and remains usable across the tested container restarts.
- Legacy bearer-session authentication is explicitly disabled in this fixture.
  A Gateway caller key cannot act as a Dashboard session, nor vice versa.
- Valid Bearer and `X-Api-Key` caller credentials work; missing/wrong keys fail.
- Logout clears the cookie and a subsequent cookie-free request is rejected.
  This does not claim server-side revocation of a previously issued JWT.

These are real HTTP password/session checks, not a new browser-login or OIDC
certification. Prior source-bound UI evidence remains separate.

The same image also passes legacy operation, explicit migration001–018,
synthetic JSON/SSE, cached input, long-context rules and immutable historical
costs. An idle exit42 and unexpected closure of the real HTTP listener each
trigger automatic recovery on the same temporary host-loopback mapping. The
listener test observes the actual watchdog event; its injector neither invokes
the watchdog nor directly exits the process.

Two additional SIGTERM cases pause an actual SSE request before receipt
retention and after HTTP completion but before receipt delivery. The image
refuses new connections, stays alive while accounting is paused, then completes
the original work and exits0 after release. Each request adds exactly one
committed budget effect and log. Final inspection verifies13mock calls/logs,
12priced attempts,286300logical budget tokens and exactly
0.584620000000000000USD of synthetic consumption, with no pending receipt,
reservation or settlement intent. The preload only pauses the original methods;
it does not replace their financial writes or the application's shutdown logic.

The first exercise exposed a fixture mistake: its pause covered only the first
delivery caller, allowing shutdown recovery to advance the same receipt. That
failed assertion and its raw state snapshots are preserved. Gating all concurrent
callers, as intended, passes on the **unchanged image**; no application fix or
weakened accounting assertion is claimed.

Both attempts' owned containers and networks are removed; their temporary data
volumes are also removed after retaining diagnostic artifacts. The task-owned
builder is stopped. Other Rancher containers, engine settings, global Docker
context and production2099—including the user's model edit—remain unchanged.
The successful mapping was127.0.0.1:51046to container45215, never2099.

This closes OPS-TEST-03 for this application source and tested platform only.
PostgreSQL delayed-JSON performance still fails its original target; final
fixed-source delivery remains open. No new PostgreSQL-in-image restore, AMD64,
host/engine restart, power-loss, production connectivity or deployable release
bundle is certified. This image is **not deployment approval**.

## Earlier image checkpoint —2026-09-30 (not current source)

This image predates the subsequent historical-FX, context/calendar, hydration,
activation-index, receipt-preflight and publication-FX work. It must not be used
as the final candidate for the current source. No new image or Docker action was
performed for the publication-FX checkpoint; refresh only after the remaining
original acceptance gates and source are finalized.

The local provisional image `siftgate-pricing-goal:rancher-d1879536ff11` is built
from the 1,326-file source manifest of the completed 4,031-unit/734-HTTP native
regression. Unlike the historical images below, it includes bounded audit reads,
joint receipt delivery, bounded replay, transition verification, management
contracts, editor confirmations and the log-subtotal read scope. Source and
dependency hashes are checked before and after the isolated build.

The actual packaged CMD and HEALTHCHECK pass on Rancher Desktop Moby,
Linux/ARM64, Node22.23.3/ABI127 and SQLite3.49.2. The fixture verifies `/live`,
`/health`, `/ready`, frontend assets, caller authentication, explicit migrations
001–018, JSON/SSE, cached tokens, long-context rates, historical costs and graceful
shutdown. Its final assertions cover 11 mock calls/logs, 10 priced attempts,
284100 logical budget tokens and exactly0.572620000000000000USD of synthetic
budget consumption. No real model request is made.

An idle process exit and unexpected closure of the real HTTP listener each cause
automatic recovery on the same temporary loopback-published port. The latter
emits the actual listener-watchdog event; the injector does not call the watchdog
or directly exit the process. Neither test targets2099, the host or the engine.
The separate populated SQLite restore preserves keys, immutable costs and an
unknown-cost hold, then accepts a new request without resending unresolved work.

The exported review bundle contains the image/source archives, dependency locks
and unchanged migration001–018 checksums. OCI manifest/config, compressed layer
hashes, uncompressed layer identities and every source file are verified. The
source is still an uncommitted overlay and the bundle is **not release-ready**.
No new HTTP performance comparison, PostgreSQL-in-image restore, AMD64, host
restart, power-loss or production-connectivity certification is claimed.

All owned test containers, fixture networks and successful-fixture volumes are
removed; the owned builder is stopped. Other containers retain their running
state, start time and restart count. Rancher settings, global Docker context and
production2099, including the user's confirmed model edit, remain unchanged.

## Earlier isolated checkpoint (schema001–015)

The tested platform was Rancher Desktop Moby on Linux/ARM64, using the real image
entrypoint and compiled application. Its runtime was Node22.23.3, ABI127, with
native SQLite3.49.2. This is not an AMD64 or bare-metal Linux certification.

The fixture used only synthetic configuration, keys, budgets, prices and local
mock responses. It used separate named volumes and uniquely named test resources,
with CPU/memory limits. It did not mount the production database, publish2099,
request2099, change the global Docker context or restart Rancher Desktop.

Verified cases include:

1. Native SQLite loading, WAL-backed writes, integrity checks and a backup made
   through SQLite's backup API while committed data was still in WAL.
2. The legacy, unmigrated application path, API-key rejection and frontend
   entry/static asset serving from the Linux image.
3. Explicit migration dry-run without changing the database file, application of
   migrations001–015, repeated application, and a subsequent read-only inspection.
   The schema API's applied state is `applied`; schema installation does not
   itself publish model price bindings.
4. Published synthetic base, cached-input and whole-request long-context rates;
   JSON and SSE requests; exact budget/receipt amounts; and historical fees that
   remain unchanged after publishing a different price and restarting the container.
5. Host-loopback forwarding on an OS-assigned temporary port, with a unique
   fixture marker checked before any host-side API write. The host-side SSE call
   was followed immediately by an orderly container stop and persistent-state checks.
6. An idle gateway's controlled nonzero process exit followed by the configured
   Docker restart policy, with the same temporary host address and retained data.
   A test-only preload generated exit42; Docker's explicit manual-kill API was
   not treated as evidence for automatic recovery from a process failure.
7. Unexpected closure of the actual gateway HTTP listener while its process was
   still running. The existing listener watchdog emitted `gateway_listener_lost`
   with `unexpected_http_server_close`, exited, and Docker restarted the gateway
   on the same temporary host port. The injector closed the real server; it did
   not fake the watchdog result or invoke its exit method.

The mapped fixture ended with11mock calls,11logs,10priced attempts,284100logical
budget tokens and an exact cumulative budget amount of0.572620000000000000USD.
There were no mock errors, pending reservations or unapplied settlement intents.
These are fixture assertions, not customer usage or vendor prices.

The no-network fixture used Docker's `none` network. The published-port fixture
used a dedicated bridge and an explicit fetch guard allowing only its own
gateway/mock loopback origins. An internal-only bridge did not create the
requested published-port bindings and was not accepted as a host-network pass.
All test containers, test networks and successful-fixture data volumes were
removed; failed-test evidence is retained separately.

## Schema001–018 image and SQLite recovery checkpoint —2026-09-29

The updated source and dependency locks were rebuilt with the same pinned Node
base on Rancher Desktop Moby. That image was tested on Linux/ARM64 with
Node22.23.3, ABI127 and SQLite3.49.2. It includes migrations001–018; the earlier
schema015 image is not substituted for this result.

Its smoke test repeats legacy startup, explicit migration, token/cache/
long-context pricing, unchanged historical fees, authenticated host-loopback
requests, orderly shutdown, process-failure restart and listener-loss recovery.
It also runs the image's actual packaged HEALTHCHECK, rather than disabling it.
The probe defaults to2099; when `server.port` differs, set
`SIFTGATE_HEALTHCHECK_PORT` to that same **container** port. This variable changes
only the probe, not the server listener or the host port mapping. Invalid values
fail before connection, redirects are rejected and requests remain on loopback.
The test used an OS-assigned non2099port and retained the same temporary host
address through both automatic restarts.

A separate populated-database exercise exported consistent backups outside the
VM and restored that image on fresh storage, including an unknown-cost
request with a still-reserved hold. It also demonstrated why an old binary that
starts successfully on an upgraded database is not a valid pricing rollback.
See [database recovery and downgrade limits](pricing-database-recovery.md).

The local image/source bundle has fixed manifests and checked archive hashes;
its OCI manifest, config and layer identities are distinguished and verified.
It is explicitly **provisional, not release-ready**: the source still includes
uncommitted work and the original Goal's remaining performance and acceptance
gates have not passed. Nothing was pushed, deployed or switched on2099.

A subsequent native PostgreSQL backup/restore rehearsal found and fixed a
composite foreign-key inspection ordering defect. That fix passed fresh recovery
and full backend/HTTP regression, but is **not in this image or provisional
bundle**. Their existing SQLite evidence remains valid for their recorded source;
do not present them as final-source artifacts or as PostgreSQL recovery proof.
That earlier image remains historical evidence. The current-source refresh below
includes the fix; final release acceptance is still separate.

## Image refresh checkpoint before bounded audit reads

The later bounded runtime-audit-read and joint receipt-delivery changes are not
included in this image. The
following evidence applies only to the recorded image/source manifest, not to the
latest worktree or a final-source release candidate.

A new isolated build includes the PostgreSQL constraint-inspection fix, composed
logical settlement, earlier validated log projection, Realtime/ASR closure clocks
and Dashboard focus restoration. Its fixed source manifest contains 1,320 files
and the same dependency locks as the completed 3,910-unit/704-HTTP regression.
The source is still an explicit uncommitted overlay, not a published release commit.

The new image repeats the actual-entrypoint smoke on Rancher Desktop Moby,
Linux/ARM64, Node22.23.3/ABI127 and SQLite3.49.2. Packaged health checks, migration
001–018, legacy authentication, frontend assets, JSON/SSE pricing, cached tokens,
long context and unchanged historical fees pass. Idle process failure and actual
HTTP-listener closure both trigger recovery on the same temporary host-loopback
address. No host or engine restart, production2099 mapping or real provider call
is part of this test.

A fresh populated SQLite rehearsal makes three backup-API snapshots while the
source still has WAL data. Copies exported outside the VM pass independent
read-only checks. Restoration preserves all accepted requests, caller key
identities, original price/receipt hashes and an unknown-cost reserved hold. One
new authenticated request succeeds, without redispatching the unknown request.
This is SQLite image evidence for that manifest, not a new PostgreSQL image restore,
AMD64, power-loss or bare-metal systemd certification.

The refreshed local review bundle contains the image archive, deterministic source
archive, dependency locks, migration checksums and SHA-256 manifest. OCI index,
manifest, config, every compressed layer and every uncompressed layer identity
are verified separately; every source-archive file matches the source manifest.
The artifact is **provisional and not release-ready**: the original measured
performance targets, remaining acceptance mapping and final source commit are
still outstanding. All owned runtime containers, fixture networks and data volumes
were removed, the task-owned builder stopped, and other Rancher containers,
settings, global Docker context and production2099 remained unchanged.

## Boundaries that still need approval or further evidence

- The actual2099cutover, real caller/domain reachability and production data
  migration have **not** been executed.
- Rancher/application startup after login, host reboot, engine failure and sleep
  require a separately approved operational check. The shared Rancher instance
  was not restarted to obtain a test result.
- The idle-process/listener restart tests do not prove arbitrary mid-request crash,
  power-loss, disk-full or whole-host recovery. Use the pricing recovery evidence
  and a specific failure scenario rather than generalizing this smoke result.
- Packaged health checks and an engine restart policy are not substitutes for
  listener self-checks and an explicitly managed watchdog target. Do not assume
  an unhealthy-but-running container will be restarted by a process-exit policy.
- Smoke resource limits are not production capacity sizing. Account for catalog
  size, database/cache use and the other workloads in the shared Rancher VM.
- The earlier schema001–015 image predates dependency remediation. Its frozen
  audit had unresolved findings; the later schema001–018 build and candidate
  dependency checks reported zero known findings for their recorded locks. These
  are different artifacts, not conflicting attestations. Both of those older
  artifacts predate the PostgreSQL inspection fix. The image refresh checkpoint
  above includes that fix, but predates the bounded audit-read change. None of
  these historical artifacts replaces a final-source build and acceptance run.
- The HTTP latency/throughput targets remain unmet; see
  [performance verification](pricing-performance.md).

## Later maintenance-window procedure — not executed now

1. Obtain final review and explicit deployment authorization. Freeze image,
   configuration, source/dependency identity, migration checksums and rollback
   materials. Record the existing native runtime, supervisor and watchdog targets.
   Use the then-current approved production configuration, including the user's
   model edits; never replace it with a development fixture or an older captured
   configuration. If its identity changes after approval, stop and reconcile the
   difference with the operator rather than silently overwriting or rebaselining it.
2. Prepare the approved persistent storage and credentials without rotating caller
   keys unnecessarily. Confirm backups can be recovered independently of the
   Rancher VM. Do not copy a live SQLite main file and assume its WAL commits
   are included.
3. Quiesce incoming work and drain in-flight requests. Stop or fence the native
   supervisor/watchdog as one coordinated operation; prove no competing listener
   or database writer remains before assigning2099to the container.
4. Take/verify a consistent backup, run migration inspection, then apply only the
   approved migrations. New price bindings, calendars, FX and admission policy
   still require explicit operator publication; migration alone must not change
   the business price policy.
5. Start the pinned container with the existing host address/port contract.
   Validate real host connectivity, API-key behavior, schema state and frontend
   access. Perform a paid-provider test only if separately authorized.
6. Enable the approved container-aware supervision arrangement. Verify its restart
   behavior and ensure the old native watchdog cannot relaunch the old process.
7. On failure, follow the rehearsed rollback decision. Merely launching the old
   binary against the newly written database is not a proven rollback. Once new
   requests have been accepted, restoring a pre-cutover backup may discard their
   records; preserve the newer database and reconcile those writes rather than
   blindly overwriting it.

Use a checked local cutover procedure that does not require the gateway itself
to obtain its next instruction while2099is unavailable. A short interruption may
be necessary; neither zero interruption nor an unconditional single restart is
promised. This plan never authorizes stopping other Rancher containers or changing
the task's model routing during development.

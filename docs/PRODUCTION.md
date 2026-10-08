# Production Deployment

This guide covers the open-source SiftGate Data Plane only. A self-hosted
gateway remains fully usable with local config, local provider credentials,
SQLite for small deployments, PostgreSQL for durable production metadata, and
optional Redis-backed shared state.

v1.3.0 keeps that deployment shape while adding the Production Ready layer:
local Virtual Key + Team management, Semantic Cache preview, Evaluation
Framework preview, and community documentation assets. Structured output,
rerank, images, audio, video, Batch API metadata, secret resolution, audit
metadata, benchmark summaries, provider catalog metadata, and API key policy
stay in the open-source Data Plane. Keep the guardrails webhook sink disabled
until the receiver, queue limits, retry policy, and downstream retention policy
have been reviewed.
Realtime, video, and Batch result download proxying should only be enabled for
production after upstream provider behavior, connection limits, job/file
retention, and load balancer paths have been tested in your environment.

Provider pricing sync remains an operator-controlled metadata workflow. Leave
`catalog.sync.enabled` off unless the deployment is allowed to make outbound
requests to a supported public catalog. In v1.2 only OpenRouter has an
automatic adapter; the recommended target is the local sync cache so reviewed
`catalog.override.yaml`, node `model_capabilities[].pricing`, and
`models_pricing` stay authoritative.

Run `npm run docs:check` before releases to catch broken documentation links,
common secret patterns, private repository references, and accidentally present
`gateway.config.yaml` files.

## v1.5.0 Migration Note

If you are upgrading from the v1.4.x line, check every legacy `${VAR}`
reference in `gateway.config.yaml` before rollout. v1.5.0 tightens startup and
reload behavior: missing required envs now fail fast and the new config is
rejected instead of being silently interpolated to an empty string. Keep
`${VAR:-default}` when you intentionally want a fallback, or switch to
`${env:VAR}` / Vault / AWS / GCP runtime references when request-time secret
resolution is the right fit.

## Baseline Topology

- Run one SiftGate instance for small deployments, or two or more instances
  behind an HTTP load balancer for higher availability.
- Put `gateway.config.yaml` on every instance through the same deployment
  process.
- Keep provider credentials out of committed config. Legacy `${VAR}` env
  interpolation is valid for simple deployments but is now required at startup
  and reload time. Use `${VAR:-default}` for explicit fallbacks or `${env:VAR}`
  runtime secret references when you want SecretReferenceResolver caching and
  consistent Dashboard redaction.
- Keep Dashboard authentication enabled. Configure `dashboard.password` or OIDC
  explicitly for production; generated first-start passwords are intended for
  local bootstrap, not long-term operations.
- Use PostgreSQL for durable call logs and generated Gateway API key records
  when SQLite is not enough for production traffic.
- Manage client credentials from the OSS Dashboard API Keys page. It supports local namespace binding, endpoint/modality/node/model restrictions, per-key budgets, per-key rate limits, disable/delete/rotate, masked display, one-time copy on create/rotate, and audit events without requiring Cloud workspace/RBAC.
- Use Redis only for features that need shared state or multi-instance
  coordination.
- Keep `semantic_cache.store_responses=false` and `evaluation.store_samples=false`
  unless local policy explicitly allows replayable responses or redacted sample
  previews.
- Keep `/health` on the load balancer health check path.

## Platform Trust Baseline

v2.0.0 is the Platform Trust GA for the OSS data plane. Production operators
should treat these as the stable baseline capabilities before layering on
future v2.x features:

- default organization/workspace bootstrap and workspace-scoped metadata,
- local Dashboard RBAC with Admin, Operator, and Viewer roles,
- optional generic OIDC login and metadata-only workspace invites,
- PostgreSQL as the documented durable metadata path,
- optional Redis shared runtime state for multi-instance deployments,
- management audit logs with redacted summaries and hash-chain fields,
- repeatable benchmark evidence under `docs/PERFORMANCE.md`.

## Runtime Hardening Controls

Production releases should keep these controls enabled and covered by release
checks:

- Dashboard auth fails closed by default. Keep `dashboard.auth_required=true` in
  production unless a controlled break-glass deployment explicitly sets
  `SIFTGATE_ALLOW_UNAUTHENTICATED_DASHBOARD=true`.
- Dashboard sessions use the HttpOnly `siftgate_dashboard_session` cookie. OIDC
  callbacks should redirect without `#token=` fragments, and normal browser SSE
  connections should not include session tokens in the URL.
- Set `dashboard.allow_legacy_token_auth=false` once clients no longer need
  Dashboard JWTs in `Authorization: Bearer` headers or SSE `?token=` query
  parameters. Use the
  [legacy token burn-down runbook](SECURITY.md#legacy-dashboard-token-burn-down)
  to verify the compatibility metric is quiet before flipping the fence.
- Provider streams should have both idle-body and total-duration bounds. Set
  `connection.body_timeout_ms` for idle time between stream chunks and
  `connection.stream_max_duration_ms` for a total wall-clock cap on long-lived
  streams.
- Downstream client disconnects should abort upstream provider fetches so
  abandoned streams do not keep provider or worker resources alive.
- Budget rules remain the release gate for local cost controls. The
  `BudgetService.reserve()` path provides a tested pre-dispatch reservation
  contract for estimated token/cost usage; when request paths adopt it, failed
  or aborted calls must release reservations and successful calls must commit
  actual usage.
- The frontend bundle budget and zero-warning lint gates should stay enabled so
  release candidates cannot silently grow the Dashboard initial payload or hide
  stale code behind warnings.
- Use the [operator observability runbook](OPERATOR_OBSERVABILITY.md) as the
  shared triage map for auth, streaming, budget, redaction, MCP, and frontend
  performance signals.

## Dashboard Login, OIDC, And Invites

v2.0.0-beta.1 adds optional generic OIDC login for the open-source Dashboard.
It is disabled by default and does not replace local password login unless you
choose to remove `dashboard.password`.

Minimal OIDC shape:

```yaml
dashboard:
  session_secret: "${env:SIFTGATE_DASHBOARD_SESSION_SECRET}"
  oidc:
    enabled: true
    issuer: "https://accounts.google.com"
    client_id: "${env:OIDC_CLIENT_ID}"
    client_secret: "${env:OIDC_CLIENT_SECRET}"
    redirect_uri: "https://siftgate.example.com/api/auth/oidc/callback"
    allowed_domains:
      - example.com
    default_role: viewer
    default_workspace_id: default-workspace
    timeout_ms: 10000
```

Provider notes:

- Google: issuer `https://accounts.google.com`; configure the redirect URI in
  the OAuth client.
- GitHub: use an OIDC-capable enterprise or identity-provider integration that
  exposes a standard issuer discovery document.
- Azure AD / Entra ID: use the tenant issuer discovery URL for your directory
  and register the callback URI in the app registration.

Invitations are metadata-only. Admins create an invite from the Members page and
copy the returned link. OSS does not send email by default. The database stores
the invite token hash, role, workspace, expiry, and status; the plain token is
returned once at creation.

## Kubernetes / Helm

v0.9 adds OSS-only deployment assets for Kubernetes:

- Helm chart: `deploy/helm/siftgate`
- Kustomize/plain manifests: `deploy/kubernetes/base`
- local validation: `npm run validate:k8s`

The defaults stay conservative: one replica, SQLite on a PVC, memory state
backend, `cluster.enabled=false`, `realtime.enabled=false`, no Ingress, no
autoscaling, no SiftGate Cloud, no enterprise image, and no real secrets in the
repository. Redis, PostgreSQL, Ingress, HPA, PodDisruptionBudget,
ServiceMonitor, existing Secrets/ConfigMaps, resource requests/limits, and
persistence controls are opt-in through Helm values.

See [Kubernetes And Helm](KUBERNETES.md) before using these assets in a
production cluster.

## Database Recommendation

v2.0.0-alpha.3 makes PostgreSQL the documented production database path while
preserving SQLite as the zero-friction local and small single-node default.
SQLite remains supported; PostgreSQL is recommended when generated Gateway API
keys, RBAC memberships, budgets, call logs, eval metadata, batch jobs, audit
events, and workspace metadata need managed backups or independent operations.

SQLite is the default because it keeps local development and small self-hosted
installs simple:

```yaml
database:
  type: sqlite
  path: ./data/gateway.db
```

For production, use PostgreSQL so call logs, Dashboard-managed Gateway API
keys, local teams, budgets, and node status can be backed up and operated
independently from one container filesystem:

```yaml
database:
  type: postgres
  url: "${DATABASE_URL}"
  synchronize: false
  pool:
    max: 10
    min: 0
    idle_timeout_ms: 30000
    connection_timeout_ms: 5000
    statement_timeout_ms: 60000
    query_timeout_ms: 60000
    max_uses: 7500
    application_name: siftgate
  ssl: false
  log_retention_days: 30
```

`database.synchronize` defaults to `true` for backwards-compatible local
development. Runtime option generation now defaults PostgreSQL to
`synchronize: false` unless explicitly overridden. Production PostgreSQL
deployments should bootstrap or migrate the schema during a maintenance step,
then run the gateway with `database.synchronize: false`.

### PostgreSQL Pool And SSL

The PostgreSQL pool maps directly to the underlying `pg` client:

- `pool.max` limits concurrent database clients per SiftGate process.
- `pool.min` keeps warm clients available when supported by the driver.
- `pool.connection_timeout_ms` fails startup and readiness checks quickly when
  the database is unreachable.
- `pool.statement_timeout_ms` and `pool.query_timeout_ms` prevent stuck
  metadata queries from consuming workers forever.
- `pool.max_uses` recycles long-lived clients, useful behind some poolers.
- `pool.application_name` appears in `pg_stat_activity`.

Use `ssl: true` or an object when managed PostgreSQL requires TLS:

```yaml
database:
  type: postgres
  url: "${DATABASE_URL}"
  synchronize: false
  ssl:
    reject_unauthorized: true
    servername: postgres.example.com
```

`reject_unauthorized: false` is accepted for local tests and private networks
but `siftgate validate` warns because certificate verification is disabled.

## SQLite To PostgreSQL Migration

Build the gateway so the `siftgate` executable exists, then run a dry run:

```bash
npm run build
node dist/cli/siftgate.js migrate-db \
  --from sqlite \
  --to postgres \
  --sqlite-path ./data/gateway.db \
  --postgres-url "$DATABASE_URL" \
  --dry-run
```

When the dry run looks correct, stop writes to the gateway and import:

```bash
node dist/cli/siftgate.js migrate-db \
  --from sqlite \
  --to postgres \
  --sqlite-path ./data/gateway.db \
  --postgres-url "$DATABASE_URL" \
  --backup
```

The migrator:

- Reads `organizations`, `workspaces`, `workspace_memberships`,
  `gateway_api_keys`, `budget_rules`, `node_status`, `call_logs`,
  `route_decisions`, `config_versions`, `config_audit_events`,
  `management_audit_events`, `provider_compatibility_results`, `batch_jobs`,
  and `video_jobs`.
- Creates a verified, WAL-aware SQLite snapshot using the SQLite online backup
  API when `--backup` is set. It refuses to overwrite an existing backup.
- Creates/updates the PostgreSQL schema through the OSS TypeORM entities before
  import.
- Refuses to import into non-empty target tables unless `--force` is provided.
- Normalizes SQLite booleans, dates, numbers, and JSON fields for PostgreSQL.
- Resets imported numeric sequences and validates row counts after import.

Useful flags:

```bash
--backup-path ./backups/gateway.pre-postgres.db
--force
--json
--batch-size 1000
```

Use `--force` only when you intentionally want to append/update rows in an
existing PostgreSQL database. Keep the SQLite backup until the PostgreSQL
deployment has served real traffic and backups have been verified.

## TypeORM Migration Strategy

Today the open-source runtime uses TypeORM entities as the schema source of
truth. The `migrate-db` command is the supported one-time bootstrap path from a
SQLite development database to a PostgreSQL production database.

Recommended production process:

1. Run `siftgate validate --config gateway.config.yaml`.
2. Run `siftgate migrate-db --dry-run`.
3. Stop gateway writes or enter a maintenance window.
4. Run `siftgate migrate-db --backup`.
5. Switch `gateway.config.yaml` to PostgreSQL with `synchronize: false`.
6. Restart SiftGate and verify `/health`, Dashboard API keys, budgets, and call
   logs.

### Production Schema Policy

Treat production PostgreSQL schema changes as deployment steps, not as ordinary
gateway startup side effects:

- Keep `database.synchronize: false` for production PostgreSQL. SQLite and
  local development can keep the default synchronize behavior, but production
  Postgres should not rely on TypeORM runtime synchronization as a migration
  strategy.
- Run schema bootstrap or migration commands once per environment before the
  gateway rollout. For multi-instance deployments, apply the database step
  before starting new gateway instances so several pods do not attempt schema
  changes concurrently.
- Take a database backup or managed snapshot before every mutating schema step.
  Keep the backup until `/ready`, `/health`, Dashboard login, API key lookup,
  budgets, call logs, and audit/event pages have been verified on the new
  release.
- Rehearse the same command sequence against staging or a restored production
  snapshot. Keep the dry-run output, row counts, and release version with the
  change record.
- Rollbacks are database rollbacks. Do not assume application downgrade can
  reverse a schema change; restore the snapshot or run the documented down
  migration when one is provided.

The startup schema patch services in `src/database/*schema-patch.service.ts`
exist for compatibility windows around local SQLite and older metadata tables.
They are intentionally small, idempotent bridges so upgraded single-node
deployments can keep starting while the project moves older metadata into the
current entity shape. Operators should treat them as compatibility support, not
as a substitute for production migration planning. When a release note or
change review says a schema patch may run, test it in staging first and watch
startup logs for `Applied schema patch:` entries.

## Health And Readiness

Use `/live` for HTTP liveness and restart decisions. It does not query the
database, budget, or providers. The runtime exits nonzero on an unexpected HTTP
listener close, or after two missing-listener samples five seconds apart;
intentional shutdown is excluded. Keep an independent external probe for event
loop hangs. Plain Docker/Compose health checks do not themselves restart an
unhealthy but still-running container.

Use `/ready` for load balancer and Kubernetes readiness probes. It checks the
runtime database only and returns `503` when SQLite/PostgreSQL is unavailable.
Provider/node health is intentionally excluded so a degraded upstream does not
remove an otherwise usable gateway process from service.

Use `/health` for dashboards and monitoring. It reports:

- `database`: type, redacted target, connectivity, latency, synchronize mode,
  pool summary, and SSL summary.
- `nodes`: circuit breaker state, active health probe state, realtime state,
  and model circuit state.
- `budget`: current budget gauges.

This separation lets operators distinguish database outage from upstream
provider outage during incidents.

See [Reliability Operations](RELIABILITY_OPERATIONS.md) for staged deployment,
external watchdogs, systemd, WAL-safe backup rotation, retention, and rollback.

Future releases that change persistent schema should ship explicit TypeORM
migration files. Production operators should run those release migrations as a
deployment step instead of leaving runtime schema synchronization enabled.

## MCP Tool Gateway

The MCP Tool Gateway is disabled by default. Enable it only for MCP
servers you operate or explicitly trust:

```yaml
mcp:
  enabled: true
  servers:
    - id: local-docs
      url: "http://localhost:8787/mcp"
      transport: http_json_rpc
      allowed_namespaces: [team-a]
      headers:
        Authorization: "Bearer ${env:LOCAL_DOCS_MCP_TOKEN}"
```

Use Gateway API key `allowed_endpoints` to scope access to `mcp`,
`mcp:<serverId>`, or `mcp:<serverId>:<toolName>`. Keep upstream credentials in
environment or secret references, avoid secrets in MCP URLs, and prefer
namespace allow-lists for team-scoped tool servers. Use `streamable_http` for
current remote MCP servers, `sse` plus optional `message_url` for legacy
HTTP+SSE servers, and `stdio` with `command`, optional `args`, `env`, and `cwd`
for local MCP processes. The preview audit buffer is
metadata-only and in-memory; it is useful for recent operational visibility but
is not a durable compliance event store.

## Evaluation Framework

The v1.3 Evaluation Framework preview stores local experiment metadata in the
runtime database. SQLite works for local single-node use; PostgreSQL is
recommended if eval history needs backup, restore testing, or multi-instance
operational visibility.

```yaml
evaluation:
  enabled: true
  store_samples: false
  max_sample_chars: 500
  retention_days: 30
  judge_model: gpt-4o-mini
```

Production guidance:

- Keep `store_samples` disabled for production datasets unless legal/privacy
  review explicitly approves local redacted previews.
- Judge calls are ordinary SiftGate requests and can spend real budget. Scope
  the judge key/model with normal Gateway API key, namespace, budget, and rate
  limit controls.
- Fixed rubrics and representative samples make judge scores comparable across
  runs; treat the score as operational evidence, not a final truth label.
- Include `eval_datasets`, `eval_experiment_runs`, and `eval_sample_results` in
  database backups if historical reports are needed after incidents.
- Dashboard Eval Reports are read-only. Automation that calls
  `POST /api/dashboard/evals/runs` should run from a trusted local environment.

## Config Audit And Rollback

The v0.9 OSS Data Plane keeps local config audit history in the same database
used for runtime metadata. SQLite remains the default; PostgreSQL is recommended
when config history should survive container replacement and be backed up with
the rest of production metadata.

```yaml
config_audit:
  enabled: true
  max_versions: 50
  max_events: 200
  capture_startup_snapshot: false
```

Operational guidance:

- Keep provider keys as environment references such as `${OPENAI_API_KEY}`
  wherever possible.
- Snapshots redact literal secrets before storage. Rollback rehydrates redacted
  fields from the current local config only when the path or array `id` matches.
- Rollback validates the target config before writing the file. Failed rollback
  attempts keep the current config active and write a failure audit event.
- In multi-instance deployments, rollback is local to one instance. Roll config
  changes through your deployment system so every instance converges.
- Include `config_versions`, `config_audit_events`, and
  `management_audit_events` in PostgreSQL backups and restore tests if you rely
  on Dashboard rollback or management audit evidence during incident response.

## Docker Compose PostgreSQL Profile

The default Compose path still starts only the gateway with SQLite. To run the
optional local PostgreSQL service for testing:

```bash
POSTGRES_PASSWORD=replace-me docker compose --profile postgres up -d postgres
```

Then set `DATABASE_URL` in `.env` and update `gateway.config.yaml`:

```env
DATABASE_URL=postgresql://siftgate:replace-me@postgres:5432/siftgate
```

```yaml
database:
  type: postgres
  url: "${DATABASE_URL}"
  synchronize: false
```

For real production, use managed PostgreSQL or a hardened database deployment
with backups, TLS/network controls, secret management, and regular restore
tests.

## Secret References

The default production recommendation remains simple: store provider keys and
tokens in environment variables and reference them from `gateway.config.yaml`.

```yaml
nodes:
  - id: openai
    api_key: "${env:OPENAI_API_KEY}"

control_plane:
  enabled: false
  registration_token: "${env:SIFTGATE_CONTROL_TOKEN}"
```

Vault, AWS Secrets Manager, and GCP Secret Manager are optional SDK-less HTTP
adapters and stay disabled until configured:

```yaml
secret_manager:
  cache_ttl_seconds: 300
  failure_policy: fail_closed
  backends:
    env:
      enabled: true
    vault:
      enabled: true
      address: "${env:VAULT_ADDR}"
      token: "${env:VAULT_TOKEN}"
```

Use external managers when your deployment platform already manages those
systems. Resolved values are used only at the outbound edge and are redacted
from Dashboard config, compatibility results, call logs, route traces, and
telemetry summaries. See [SECRET_MANAGEMENT.md](SECRET_MANAGEMENT.md) for
backend-specific syntax.

## Redis Shared State And Cluster Mode

Cluster mode is disabled in the default memory configuration. Enable it with either `state.backend: redis` or `cluster.enabled: true`:

```yaml
state:
  backend: redis
  unavailable_policy: fail_open
  redis:
    url: ${REDIS_URL:-redis://127.0.0.1:6379}
    prefix: siftgate:state:
    timeout_ms: 500
    sync_interval_ms: 2000

cluster:
  enabled: true
  instance_id: ${SIFTGATE_INSTANCE_ID:-}
  heartbeat_interval_seconds: 10
  heartbeat_ttl_seconds: 30
  reload_broadcast: true
```

Redis shared state can coordinate API key/IP rate limits, circuit breaker
state, cache affinity/session route history, routing momentum, prompt-cache
entries, concurrency summaries, active health probe summaries, and realtime
session metadata across instances. Runtime keys are scoped as
`<prefix>ws:<workspace-id>:<category>:<key>` so the default workspace upgrade
path stays compatible with v2 isolation.

`fail_open` keeps request traffic flowing when Redis is unavailable.
`fail_closed` rejects rate-limited paths and treats strict categories as
unavailable until Redis recovers. The global policy can be overridden per
state category:

```yaml
state:
  categories:
    rate_limit:
      unavailable_policy: fail_closed
      ttl_seconds: 60
    concurrency:
      unavailable_policy: fail_closed
      ttl_seconds: 120
```

When cluster mode is enabled, each instance writes a heartbeat record under the
configured Redis prefix and publishes lifecycle events through Redis Pub/Sub.
`GET /cluster/status` reports the local instance, peer inventory, Redis status,
heartbeat timing, and reload broadcast metadata. In default single-instance
memory mode, the endpoint returns `404`. Dashboard viewers can always read the
privacy-safe local summary at `GET /api/dashboard/cluster`; it includes local
node id, shared-state backend, Redis connectivity, recent state errors, and
per-category TTL/policy metadata.

There is no leader election. Every instance independently handles requests and should have the same local configuration, provider credentials, and plugin declarations.

## Config Reload Broadcasts

A successful local reload from the Dashboard API, `SIGHUP`, or file watcher publishes a Redis `config.reload` event when `cluster.reload_broadcast` is enabled. Peer instances respond by running their own `ConfigService.reload({ source: "cluster" })`, which means each peer parses and validates its local file and keeps its previous snapshot if reload fails.

Redis Pub/Sub does not carry provider keys, prompts, responses, raw headers, or full config contents. It carries metadata such as instance id, timestamps, and config version.

## Redis Operations

- Prefer `rediss://` or private network Redis; do not expose Redis publicly.
- Use a dedicated prefix such as `siftgate:prod:` when Redis is shared with other workloads.
- Set `heartbeat_ttl_seconds` higher than `heartbeat_interval_seconds`; the example uses a 3x TTL.
- Redis outages are logged and shown in `/cluster/status` and Dashboard cluster state. Whether they block a path depends on the configured category policy.
- The first implementation uses Redis `KEYS` for the small cluster inventory namespace; keep the prefix narrow.
- Do not share a Redis prefix across environments. Use dedicated prefixes such as `siftgate:prod:` and `siftgate:staging:`.

## Security Notes

- Provider API keys should stay in environment variables or a local secret manager referenced from `gateway.config.yaml`.
- Dashboard-generated Gateway API keys are the only keys clients should use against `/v1/*`. Operators should scope them with local teams, endpoint/modalities, allowed nodes/models, namespace, daily budgets, and rate limits instead of sharing one global client key.
- Local teams are OSS-only shared policy groups. They help manage multiple keys locally, but they are not enterprise SSO, SCIM, workspaces, RBAC, or org billing.
- Gateway API key list/update/delete responses only expose masked prefixes. Create and rotate responses show the full key once; config audit events store redacted summaries and do not persist that one-time secret.
- The open-source Data Plane does not require SiftGate Cloud. If `control_plane` is enabled, it is an outbound optional integration and AI traffic still flows from the gateway to the configured providers.

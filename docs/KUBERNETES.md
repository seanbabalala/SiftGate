# Kubernetes And Helm

SiftGate v0.9 adds Kubernetes deployment assets for the MIT open-source Data
Plane:

- Helm chart: `deploy/helm/siftgate`
- Plain Kubernetes/Kustomize base: `deploy/kubernetes/base`
- Local validator: `npm run validate:k8s`

These assets deploy only the local SiftGate Data Plane. They do not install
external control-plane components, private images, or real provider secrets.

## Defaults

The default Helm values and Kustomize base intentionally mirror the single-host
open-source default:

- one SiftGate replica
- SQLite persisted on a PVC at `/app/data/gateway.db`
- memory state backend
- `cluster.enabled: false`
- `realtime.enabled: false`
- no Ingress
- no autoscaling
- no Redis or PostgreSQL dependency
- no external control-plane configuration

The default config includes a placeholder OpenAI-compatible node so the gateway
can boot and the Dashboard can be used. Replace the placeholder Secret before
sending production traffic.

## Helm Quickstart

```bash
helm upgrade --install siftgate ./deploy/helm/siftgate \
  --namespace siftgate \
  --create-namespace \
  --set secrets.env.OPENAI_API_KEY="$OPENAI_API_KEY"
```

Open the Dashboard locally:

```bash
kubectl -n siftgate port-forward svc/siftgate 2099:2099
```

Then open `http://127.0.0.1:2099`.

## Plain Kubernetes Quickstart

```bash
kubectl apply -k deploy/kubernetes/base
kubectl -n siftgate port-forward svc/siftgate 2099:2099
```

`deploy/kubernetes/base/secret.example.yaml` contains placeholders only. For a
real environment, replace it with your own Secret, sealed secret, or external
secret controller output.

## Secrets

Provider keys should come from Kubernetes Secrets or an external secret
controller. The chart supports:

```yaml
existingSecret: siftgate-env
```

or:

```yaml
secrets:
  existingSecret: siftgate-env
```

For simple local testing, you can let the chart create a Secret from explicit
values:

```yaml
secrets:
  create: true
  env:
    OPENAI_API_KEY: replace-me
    DASHBOARD_PASSWORD_HASH: ""
```

Do not commit real provider keys, webhook tokens, database passwords, or raw
authorization headers. `npm run validate:k8s` scans deployment defaults for
secret-looking values.

## Config

The gateway reads config from:

```text
/app/config/gateway.config.yaml
```

via the `GATEWAY_CONFIG_PATH` environment variable. Helm supports either an
inline `config.data` value or an externally managed ConfigMap:

```yaml
existingConfigMap: siftgate-config
```

or:

```yaml
config:
  existingConfigMap: siftgate-config
```

Kubernetes ConfigMap mounts are read-only. If you enable Dashboard
authentication, use a precomputed bcrypt hash in `DASHBOARD_PASSWORD_HASH`
instead of a plaintext password that the gateway would try to hash and write
back to the config file.

## PostgreSQL

PostgreSQL is optional for local tests and recommended for production traffic
once SQLite is no longer enough. First create a Secret with `DATABASE_URL`, then
enable the env wire-up:

```yaml
postgres:
  enabled: true
  databaseUrlSecret:
    name: siftgate-postgres
    key: DATABASE_URL
```

Also update `config.data`:

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
    application_name: siftgate
  ssl: true
```

Run the SQLite-to-PostgreSQL migration or schema bootstrap before switching a
live deployment to `synchronize: false`. See [Production Deployment](PRODUCTION.md).

The chart and plain manifests use `/ready` for readiness and `/live` for
liveness. `/ready` checks database availability only. Provider/node degradation
is visible in `/health` and Dashboard views but does not evict a pod from the
Service endpoints.

## Redis And Cluster Mode

Redis is optional. Use it only when you need shared state for rate limits,
circuit breakers, cache affinity, prompt cache, routing momentum, concurrency
summaries, active health probe summaries, realtime session metadata, or
cluster inventory:

```yaml
redis:
  enabled: true
  urlSecret:
    name: siftgate-redis
    key: REDIS_URL
```

Then update `config.data`:

```yaml
state:
  backend: redis
  unavailable_policy: fail_open
  redis:
    url: "${REDIS_URL}"
    prefix: siftgate:state:
    timeout_ms: 500
    sync_interval_ms: 2000
  categories:
    rate_limit:        { ttl_seconds: 60 }
    circuit_breaker:   { ttl_seconds: 3600 }
    cache_affinity:    { ttl_seconds: 1800 }
    momentum:          { ttl_seconds: 1800 }
    prompt_cache:      { ttl_seconds: 300 }
    concurrency:       { ttl_seconds: 120 }
    health_probe:      { ttl_seconds: 120 }
    realtime_session:  { ttl_seconds: 1800 }

cluster:
  enabled: true
  instance_id: "${SIFTGATE_INSTANCE_ID:-}"
  reload_broadcast: true
```

There is no leader election. Every pod handles requests independently and must
receive the same validated gateway config. `/cluster/status` is available only
when cluster mode is enabled; Dashboard reads privacy-safe local status from
`/api/dashboard/cluster` in both single-instance and cluster deployments.

## Ingress, HPA, PDB, And Metrics

All production add-ons are opt-in:

```yaml
ingress:
  enabled: true

autoscaling:
  enabled: true

podDisruptionBudget:
  enabled: true

serviceMonitor:
  enabled: true
```

For realtime/WebSocket traffic, configure your Ingress controller for WebSocket
upgrades and long enough idle timeouts before setting `realtime.enabled=true`.

## Validation

Run the local validator after editing deployment assets:

```bash
npm run validate:k8s
```

It checks:

- YAML parsing for values and plain manifests
- required Helm templates and Kustomize manifests
- default SQLite + memory-state behavior
- default Cloud disabled behavior
- absence of real-looking secrets in deployment defaults
- OSS image name, HTTP port, config mount, and SQLite data mount basics

This complements, but does not replace, cluster-specific checks such as
`helm template`, `helm lint`, `kubectl apply --dry-run=server`, admission
policies, and external secret controller validation.

# Alert Connectors

SiftGate v0.3 adds local webhook alerting to the MIT data plane. It does not require SiftGate Cloud and does not send prompts, responses, provider API keys, or raw headers.

The Dashboard now provides **Alert connectors** at `/alerts` for Feishu/Lark,
WeCom, Telegram, and generic webhooks. No account, URL, or token is preconfigured.

## Self-service setup

1. Sign in as an administrator of the default workspace. These settings are
   gateway-wide, not tenant-specific; administrator access only to another
   workspace is insufficient.
2. Add a connector, enter its destination credentials, choose event subscriptions,
   and save. New connectors and the automatic-alert master switch are off by
   default. Saving does not send a message.
3. Optionally choose **Send test**, then confirm that a real message will be sent.
   Tests deliberately work while automatic alerts are paused, send only one
   message, and are rate-limited. They do not arm automatic alerts or restarts.
4. Enable the connector and then enable automatic alerts when ready. Future
   edits do not require restarting the gateway. Pausing notifications does not
   pause a watchdog's independent recovery policy.

| Connector | Required settings | Success check |
| --- | --- | --- |
| Feishu / Lark | Official custom-bot webhook; optional signing secret | Platform JSON `code: 0` or `StatusCode: 0` |
| WeCom | Official group-message webhook including its key | Platform JSON `errcode: 0` |
| Telegram | Bot Token and numeric Chat ID or channel username | Bot API JSON `ok: true` |
| Generic webhook | Your receiver URL; optional private request headers | Successful HTTP status; receiver-specific processing is its responsibility |

For Feishu signing, timestamps and HMAC signatures are generated per request.
If the bot requires a keyword, allow `SiftGate`, which is included in message
text. Configure any platform IP allowlist to permit the deployment's egress IP.
For Telegram, add the bot to the destination and grant permission to send there.
Chat connectors use fixed/validated official HTTPS endpoints, never arbitrary
Telegram API base URLs. Generic webhooks retain legacy HTTP compatibility, but
HTTPS is strongly recommended. Redirects are not followed.

All messaging-platform business receipts are validated: HTTP 200 alone does not
mean a Feishu, WeCom, or Telegram message was accepted. Responses are bounded;
vendor response bodies and URLs containing secrets are not exposed in errors.

## Credentials and permissions

Reads return only destination origins and configured/not-configured flags,
never stored URLs, tokens, signing secrets, or request-header values. Leave a
credential blank when editing to retain it. Optional signing secrets and custom
headers have explicit clear controls. Updates use a revision token to reject
stale concurrent edits. Mutations and manual tests create metadata-only audit
records; config-history snapshots also redact connector credentials.

Credentials are stored in the local configuration file with owner-only mode
`0600`, not encrypted by this feature. Environment/secret-manager references are
supported. Back up and restrict access to the config file and host. The
configuration file/directory must be writable by the gateway user; read-only
ConfigMap/GitOps deployments must provide a writable configuration volume or
manage configuration outside the UI. Do not commit real credentials to Git.

For Compose, atomic configuration saves require a **directory mount**, not just
a writable single-file bind mount. An optional overlay is provided without
changing existing deployments:

```bash
mkdir -p data/operator-config
cp gateway.config.yaml data/operator-config/gateway.config.yaml
chmod 700 data/operator-config
chmod 600 data/operator-config/gateway.config.yaml
SIFTGATE_CONFIG_DIR="$(pwd)/data/operator-config" docker compose \
  -f docker-compose.yml -f deploy/docker-compose.dashboard.yml up -d
```

Only seed that file on first setup; do not overwrite later Dashboard edits.
The active configuration becomes `data/operator-config/gateway.config.yaml`.
Match directory ownership to the container's service user. Run this deployment
step only in an approved maintenance window, not while staging code changes.

## Independent watchdog integration

Application alerts cannot report a stopped application. An independent watchdog
can reuse these connectors through an operator-selected private snapshot:

1. Set `SIFTGATE_WATCHDOG_ALERTS_PATH` to an **absolute** writable file path in the
   gateway service environment, outside protected macOS folders.
2. Set the watchdog's `alertChannelsFile` to that same host-visible path. For a
   container, use its mounted host data path, not the container path.
3. Deploy the standalone script **with its `lib/alert-connectors.js` transport**.
   The macOS staging generator includes it. For systemd, copy
   `src/alerts/alert-connector-runtime.js` to that library path, root-owned.
4. Keep both the master alert switch and watchdog recovery disabled until your
   planned acceptance. Watchdog installation/activation remains a deployment step.

The gateway exports owner-only JSON atomically after saves and refreshes secret
references periodically. The watchdog reads it directly, including when the
gateway is down; it never calls the gateway for credentials. No snapshot is
written when the environment variable is unset. The Dashboard reports whether
the export is linked/synchronized. A save can succeed while export fails; the
UI explicitly warns that old watchdog notification settings may still apply.
Resolve that warning before relying on a changed or disabled destination.

The shared connector transport validates receipts in both processes. Event
subscriptions and duplicate suppression are per connector. Watchdog sends are
bounded to five seconds per channel and retry failed notifications on later
probe runs rather than delaying recovery with the application queue's retry
settings. Successful channels are not resent merely because another fails.
Watchdog send history stays in its own rotating log; the Dashboard history is
the application's local in-memory history, not a durable or fleet-wide log.

Host power/network failures still require monitoring from another host. See
[Reliability Operations](RELIABILITY_OPERATIONS.md) for safe staged activation.

## Events

Supported events:

- `budget_threshold`
- `budget_exceeded`
- `node_down`
- `node_recovered`
- `circuit_open`
- `circuit_close`
- `error_spike`
- `latency_spike`
- `quality_gate_failed`, `cost_anomaly`
- Watchdog: `gateway_unavailable`, `gateway_recovered`, `gateway_restart_attempt`,
  `gateway_restart_failed`, `gateway_restart_unhealthy`, `restart_rate_limited`,
  `disk_space_low`, `database_size_high`, `disk_check_failed`, `database_size_check_failed`

Budget events come from `BudgetService`. Node events come from active health probes. Circuit events come from the local circuit breaker state machine. Spike events are detected from the in-memory call-log stream using local sliding windows.

## Configuration

```yaml
alerts:
  enabled: true
  history_size: 50
  channels:
    - type: webhook
      name: ops
      url: "${ALERT_WEBHOOK_URL}"
      headers:
        Authorization: "Bearer ${ALERT_WEBHOOK_TOKEN}"
      events: [budget_threshold, budget_exceeded, node_down, node_recovered, circuit_open, circuit_close, error_spike, latency_spike]
      debounce_seconds: 300
      retry:
        attempts: 3
        backoff_ms: 1000
        timeout_ms: 5000
  error_spike:
    enabled: true
    window_seconds: 300
    min_requests: 20
    error_rate: 0.1
  latency_spike:
    enabled: true
    window_seconds: 300
    min_requests: 20
    p95_ms: 10000
```

`channels[].events` is optional. If omitted, the webhook receives every supported alert event. `debounce_seconds` suppresses duplicate sends for the same channel, event, and resource key.

## Payload

Webhook payloads are JSON:

```json
{
  "version": "siftgate.alert.v1",
  "event": "circuit_open",
  "severity": "critical",
  "timestamp": "2026-05-02T00:00:00.000Z",
  "message": "Circuit opened for openai:gpt-4o: 3 consecutive failures.",
  "dedupe_key": "openai:gpt-4o",
  "details": {
    "node_id": "openai",
    "model": "gpt-4o",
    "state": "OPEN",
    "reason": "3 consecutive failures"
  }
}
```

The payload sanitizer removes sensitive fields such as `prompt`, `response`, `messages`, `content`, `raw_headers`, `headers`, `api_key`, `provider_api_key`, `authorization`, `password`, `secret`, and `token`.

## Delivery Semantics

Alert delivery is asynchronous. The request path records the event and returns immediately; webhook POSTs run from an in-memory queue. Each webhook has retry controls and per-attempt timeout. Failures are recorded for Dashboard visibility but do not fail the original AI request.

The Dashboard endpoint `GET /api/dashboard/alerts` returns configured channel names, recent delivery status, attempts, timestamps, and failure reasons. It does not expose webhook URLs or configured headers.

Connector management uses `GET/POST /api/dashboard/alerts/connectors`,
`PUT/DELETE /api/dashboard/alerts/connectors/:id`,
`PUT /api/dashboard/alerts/connectors/enabled`, and
`POST /api/dashboard/alerts/connectors/:id/test`. Mutations require the current
`revision`; tests additionally require `confirm: true`. A failed test returns
`status: failed` with a safe error code, never echoed credentials.

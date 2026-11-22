# 30-Minute PoC Playbook

[中文](poc-playbook.zh-cn.md) · [Enterprise overview](enterprise-overview.md) · [Security and compliance brief](security-compliance-brief.md)

Use this script to show a platform, security and finance audience what
SiftGate governs, in four short acts. Each act ends with a pass criterion you
can check in front of the audience.

## Before The Session

- A running gateway: the [customer install kit](customer-install.md) or the
  source [Quickstart](QUICKSTART.md). SQLite is fine for a PoC.
- An administrator login to the Dashboard at `http://localhost:2099/dashboard`.
- One real provider key for the demo account, set as an environment variable,
  for example `ANTHROPIC_POOL_KEY_BACKUP`. Use a low-limit account.
- Optional: Claude Code or Codex on the presenter's laptop.

Use placeholders on screen. Never paste a real key into slides or chat.

Add this node to the private `gateway.config.yaml` before the session. The
`primary` credential is deliberately invalid so that Act 3 can show
credential failover; `401` is in `retry_on_status` only for this demo.

```yaml
nodes:
  - id: poc-anthropic
    name: "PoC Anthropic"
    protocol: messages
    base_url: "https://api.anthropic.com"
    endpoint: "/v1/messages"
    auth_type: x-api-key
    models: ["YOUR_MODEL", "YOUR_SECOND_MODEL"]
    credentials:
      - id: primary
        api_key: "${env:POC_INVALID_KEY}"
      - id: backup
        api_key: "${env:ANTHROPIC_POOL_KEY_BACKUP}"
    credential_pool:
      enabled: true
      strategy: cache_aware
      sticky_by: agent_session
      cooldown_ms: 60000
      retry_on_status: [401, 429, 500, 502, 503, 504]
```

Set `POC_INVALID_KEY` to any non-working placeholder value, validate the file
with `npm run validate:config` (source installs), and start the gateway.

## Act 1 (5 minutes): Engineers Never Hold A Provider Key

1. In **Gateway Keys**, create a key named `pilot-team` with direct routing
   allowed and its allowed models limited to `YOUR_MODEL`. Show that the full
   key is displayed once and only a masked prefix remains in the list.
2. In **Agent Profiles**, render a Claude Code profile for that key. The
   rendered config contains `<SIFTGATE_GATEWAY_API_KEY>`, not a provider key.
3. Point the agent, or a shell, at SiftGate:

   ```bash
   export SIFTGATE_API_KEY="<the pilot-team key>"
   curl -sS -D - http://localhost:2099/v1/messages \
     -H "content-type: application/json" \
     -H "x-api-key: ${SIFTGATE_API_KEY}" \
     -H "anthropic-version: 2023-06-01" \
     -d '{"model":"poc-anthropic/YOUR_MODEL","max_tokens":64,
          "messages":[{"role":"user","content":"Reply with OK. marker-POC-7F3A"}]}'
   ```

4. Note the `x-siftgate-request-id` response header for Act 3.

**Pass:** the request succeeds through the gateway, it appears in **Request
Logs** under `pilot-team`, and no provider key exists on the client machine.

## Act 2 (5 minutes): Policy And Budgets Are Enforced

1. Send the same request with `"model": "poc-anthropic/YOUR_SECOND_MODEL"`.
   The model is configured on the node but not allowed for this key, so the
   gateway rejects it with HTTP 403 before any provider is called.
2. In **Budget Rules**, open the `pilot-team` API key scope and set a very low
   daily token limit, for example `100`.
3. Repeat the Act 1 request until the limit is crossed. The gateway answers
   HTTP 429 with `error.type: budget_exceeded` and a `daily_tokens` code.
4. Reset or remove the limit afterwards.

**Pass:** the caller receives a clear 403 for the unapproved model and a 429
`budget_exceeded` for the exhausted budget, the **Budget Rules** page shows the
key's usage against its limit, and neither rejected request reached the
provider.

## Act 3 (10 minutes): Failover You Can Explain

1. The Act 1 request already exercised the credential pool: the invalid
   `primary` credential returned 401 and the request was retried on `backup`.
2. In **Request Logs**, open the request and show the credential id, strategy
   and retry count. No secret value is displayed anywhere.
3. Open `/route-decisions/<request-id>` with the id from Act 1. Walk through the
   selected candidate, the rejected or filtered candidates, the policy filters,
   the fallback reason, latency and the cost estimate.
4. Optional for coding agents: send several requests from the same agent
   session and show that `cache_aware` keeps them on one credential, with cache
   read tokens reported in the log.

**Pass:** the audience can answer "which key served this request, and why"
from the Dashboard alone.

## Act 4 (10 minutes): Evidence Without Content

1. In **Request Logs**, export the last day as CSV or JSON. Search the export
   for the marker you sent in Act 1:

   ```bash
   grep -c "marker-POC-7F3A" logs-1d.csv
   ```

   The count is `0`: the prompt was never stored.
2. On a SQLite PoC, repeat the search against the database file named in
   `database.path` (by default `./data/gateway.db`). The marker is absent there
   too.
3. Open **Audit Log** and show the key creation and budget change from Acts 1
   and 2, recorded with redacted summaries.
4. Open **Config Audit** to show versioned configuration with validation-first
   rollback.
5. Open **Cost Review** and export the chargeback report as CSV, grouped by API
   key or team.

**Pass:** security sees that content is absent from both exports and storage;
finance sees cost attributed to `pilot-team`.

## Scorecard

| Question from the audience | Shown in |
| --- | --- |
| Can engineers work without holding provider keys? | Act 1 |
| Can we restrict models and cap spend per team? | Act 2 |
| What happens when a key or provider fails, and can we prove it? | Act 3 |
| Does the gateway store our prompts or code? | Act 4 |
| Can finance attribute cost to teams? | Act 4 |
| Are administrative changes audited? | Act 4 |

## After The Session

- Remove the PoC node and the deliberately invalid credential, or drop `401`
  from `retry_on_status` before production use.
- Revoke the `pilot-team` key if it was created for the demo.
- Share the [security and compliance brief](security-compliance-brief.md) and
  the [enterprise overview](enterprise-overview.md) rollout plan.

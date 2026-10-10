# Security

SiftGate is designed for local operation with privacy-safe defaults.

## Secret Handling

- Do not commit `gateway.config.yaml` with real credentials.
- Prefer environment or secret references for provider keys.
- Dashboard responses mask provider keys, Gateway API keys, webhook secrets, secret manager resolved values, and authorization headers.
- `catalog.override.yaml` is not a secret store.

## Metadata-Only Defaults

The following surfaces avoid prompt/response persistence by default:

- call logs
- route decision traces
- shadow comparison reports
- provider compatibility tests
- guardrails findings
- MCP audit entries
- batch and video job metadata
- semantic cache
- evaluation reports
- management audit events
- first-run onboarding evidence
- platform benchmark reports

Features that can store samples or replayable responses require explicit configuration and should be documented in local operating procedures.

## API Keys

Gateway API keys are shown in full only once at creation or rotation time. Lists and details return masked values. Local teams, namespaces, budgets, rate limits, endpoint permissions, modality permissions, node permissions, and model permissions are enforced before provider forwarding.

## Dashboard Login And OIDC

Dashboard authentication is required by default. New managed customer installations
use a short-lived, one-time activation code and let the installation owner choose
the administrator password. Neither passwords nor activation codes are written
to application logs. See [customer identity](customer-identity.zh-cn.md).

Existing legacy installations retain their explicitly configured password/OIDC
identity. Direct source/image startup without a password or OIDC fails closed;
it does not generate or log a fallback password. Do not upload startup logs,
activation/recovery files or raw configuration to obtain login help.

Set `dashboard.auth_required=false` only for trusted local development environments.
In `NODE_ENV=production`, SiftGate ignores
`dashboard.auth_required=false` unless
`SIFTGATE_ALLOW_UNAUTHENTICATED_DASHBOARD=true` is explicitly set.

Local Dashboard password login remains available for self-hosted installs.
Generic OIDC login is optional and disabled unless `dashboard.oidc.enabled=true`.
When OIDC is enabled without a local password, set `dashboard.session_secret`
through an environment or external secret reference so Dashboard JWTs are stable
across restarts and instances.

Successful Dashboard login sets an HttpOnly, SameSite=Lax
`siftgate_dashboard_session` cookie. Dashboard APIs still accept bearer tokens
for compatibility, but browser Server-Sent Events use the cookie-first path so
session tokens do not need to be placed in SSE URLs during normal operation.
OIDC callbacks set the same cookie and redirect back to the Dashboard without
placing a Dashboard JWT in the URL hash. The legacy SSE `?token=` path remains
for older clients during the compatibility window; when it is used, SiftGate
logs a one-time deprecation warning without including the token value.
Set `dashboard.allow_legacy_token_auth=false` after browser clients have moved
to cookie-backed sessions to reject both legacy Dashboard bearer tokens and
legacy SSE query tokens.

## Legacy Dashboard Token Burn-Down

Use this runbook to remove the compatibility window for Dashboard JWTs sent in
`Authorization: Bearer` headers or SSE `?token=` query parameters. The target
state is cookie-only Dashboard auth with `dashboard.allow_legacy_token_auth=false`.

Before the change:

1. Confirm browser Dashboard clients are on the cookie-backed session flow:
   successful login sets `siftgate_dashboard_session`, OIDC callbacks do not
   return `#token=`, and normal live-log SSE requests do not include `?token=`.
2. Watch `siftgate_dashboard_legacy_token_events_total` over a normal traffic
   window. The burn-down is ready when both usage events stay at zero:

   ```promql
   sum by (event, source) (
     increase(siftgate_dashboard_legacy_token_events_total[24h])
   )
   ```

   Expected labels are bounded and never contain token values:
   `event="legacy_bearer_used", source="bearer"` for Dashboard bearer fallback,
   `event="legacy_query_used", source="query"` for legacy SSE query fallback,
   and `event="legacy_rejected"` with `source="bearer"` or `source="query"`
   after compatibility is disabled.
3. If usage is still non-zero, update the remaining client or automation to
   use the HttpOnly session cookie. Do not add token values to logs while
   investigating; rely on bounded source labels, ingress metadata, deployment
   ownership, and client release notes.

Change rollout:

1. Set the explicit fence:

   ```yaml
   dashboard:
     allow_legacy_token_auth: false
   ```

2. Roll it out to a canary or staging deployment first when available.
3. Verify Dashboard login, reload, API calls, and live-log SSE still work from
   a fresh browser session.
4. Watch for `legacy_rejected` events. A rejected event means a client is still
   sending a legacy bearer or query token and will receive `401` until it moves
   to cookie auth.
5. Roll the setting out to all gateway instances only after the canary stays
   clean for the deployment's normal Dashboard traffic pattern.

Rollback:

- If legitimate Dashboard users are blocked, temporarily omit
  `dashboard.allow_legacy_token_auth` or set it back to `true`, redeploy, and
  keep the compatibility window open while the remaining client is fixed.
- Keep the metric alert active after rollback so the next burn-down attempt is
  driven by observed zero usage rather than calendar time.

Store OIDC client secrets as secret references such as
`${env:OIDC_CLIENT_SECRET}`. Dashboard auth status only exposes whether OIDC is
enabled plus issuer/client metadata; it never returns client secrets.

Workspace invitations store only a SHA-256 hash of the invitation token. The
plain token is returned once when the Admin creates the invite. OIDC login state
stores only a nonce and invitation token hash, not the reusable invitation token.

## Reporting Vulnerabilities

See the root [SECURITY.md](../SECURITY.md) for reporting instructions.

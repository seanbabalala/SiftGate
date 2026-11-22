# Security And Compliance Brief

[中文](security-compliance-brief.zh-cn.md) · [Enterprise overview](enterprise-overview.md) · [Security](SECURITY.md)

This brief is written for security reviewers, legal and procurement. It answers
the questions a vendor security questionnaire usually asks about an AI gateway.
Every statement describes default behavior of the open-source gateway; anything
that changes it requires explicit operator configuration.

## Deployment Model

- SiftGate is self-hosted. It runs inside your network, on your hosts or
  cluster, under your accounts.
- AI requests go only to the upstream providers you configure. No hosted
  service sits in the request path, and no SiftGate cloud account is needed.
- The only other outbound connection is an optional release-availability check
  against the public GitHub releases API. It sends no tokens, keys,
  configuration, installation identity or usage, and the installation owner
  can disable it with `SIFTGATE_RELEASE_UPDATES_DISABLED=1`
  ([details](release-updates.md)).
- The source is MIT-licensed and public, so reviewers can audit it directly.

## Data Retention

| Data | Stored by default | Notes |
| --- | --- | --- |
| Prompts and request bodies | **No** | Not written to logs, traces, sessions, exports or telemetry. |
| Model responses | **No** | The optional response caches store nothing unless an operator sets `store_responses: true`; semantic caching additionally needs a per-request opt-in header. |
| Raw provider headers and authorization headers | **No** | Not stored; redacted from error text. |
| Provider API keys | Config only | Kept in config, environment or secret-manager references. Never returned by Dashboard APIs, logs, route traces, exports or log sinks. |
| Tool payloads, source code, diffs, media bytes | **No** | MCP calls, coding-agent sessions and media jobs keep metadata only. |
| Hidden reasoning text and resolved secrets | **No** | Reasoning intent and effort may be recorded; reasoning text is not. |
| Request metadata | Yes | Request id, endpoint, node, model, status, latency, token counts, cost estimate, key, team and namespace ids, credential id, cache and fallback evidence. |
| Agent session metadata | Yes | Connector, session id, optional repository and project labels, route and cost. |
| Upstream error messages | Yes, redacted | Bearer tokens, gateway keys, provider keys and other sensitive values are replaced with `[REDACTED]` before storage. |
| Guardrail findings | Yes, metadata | Rule, kind, action, severity and match count, never the matched text. |
| Management and config audit | Yes, redacted | Hash-chained management events and versioned configuration with redacted summaries. |

Call-log retention defaults to 30 days (`database.log_retention_days`). Pricing
evidence retention is configurable with
`database.pricing_evidence_retention_days`.

## Credentials And Secrets

- Provider keys support `${env:...}`, HashiCorp Vault, AWS Secrets Manager and
  GCP Secret Manager references, resolved at request time
  ([Secret management](SECRET_MANAGEMENT.md)).
- Clients authenticate with Gateway API keys, which are separate from provider
  keys. A full key is shown once at creation or rotation; lists show masked
  prefixes. Keys can be scoped, rotated and disabled.
- Credential pools log the operator-defined credential id, strategy and retry
  count, never the secret value.
- Workspace invitation tokens are stored only as SHA-256 hashes.

## Identity And Access

- Dashboard authentication is required by default. Starting without a password
  or OIDC fails closed; no fallback password is generated or logged. In
  production, disabling authentication needs a separate explicit override.
- Managed customer installations start with a single-use activation code that
  expires after 15 minutes, and the owner chooses the administrator password.
- Login sets an HttpOnly, SameSite=Lax session cookie. Legacy bearer and SSE
  query tokens can be switched off with `dashboard.allow_legacy_token_auth=false`.
- Fixed admin, operator and viewer roles per Workspace, with invitations and
  optional generic OIDC.
- Gateway traffic permissions are the intersection of key, team and namespace
  rules for endpoints, modalities, nodes and models. An empty intersection
  denies access.
- Dashboard login attempts are rate limited per client address.

## Content Controls

- The official [guardrails plugin](plugins/OFFICIAL_PLUGINS.md) runs locally in
  the gateway. It can audit, redact or block PII (email, phone, SSN, credit
  card, IBAN, passport, IP address, API key patterns), secrets and tokens,
  prompt injection and jailbreak phrases, unsafe URLs, schema and tool-call
  policy, and custom patterns on input and output. It is disabled until
  configured.
- Findings and optional webhook notifications contain metadata only: request
  id, rule, kind, action, count and path.
- Semantic Controls record Guardrails v2 findings as metadata; enforcement is
  done by the guardrails plugin.

## Audit And Change Control

- Dashboard management actions are recorded as redacted audit events linked in
  a hash chain, so removed or edited records are detectable.
- Configuration changes create versions with diffs. Rollback validates the
  target version before applying it ([Config audit and rollback](CONFIG_AUDIT_ROLLBACK.md)).
- Call logs can be exported as metadata-only CSV or JSON, or streamed to your
  own [log sinks](LOG_SINKS.md) and OpenTelemetry collectors.
- Requests refused by a budget, a key permission or a key's rate limit are
  recorded as metadata-only denial records (reason, status, key and scope,
  requested model; never content), shown under Request Logs → Blocked requests.

## Software Supply Chain

- Customer release kits are published with a release manifest, a checksum and
  a Sigstore provenance bundle produced by the GitHub release workflow. Verify
  them with GitHub CLI before running anything
  ([verification guide](customer-artifact-verification.md)).
- CI runs a pinned secret scanner over the full Git history, a publication
  boundary check for Docker build inputs and reviewed media, dependency audit
  and the full unit and HTTP test suites.
- Publishing a release never updates a running installation. The optional
  host Operator applies upgrades and backups only from reviewed plans, and the
  Control Room requires a second person to approve a plan
  ([Control Room](customer-control.md)).

## Network Exposure

- The gateway listens on one port (default 2099) for `/v1/*` traffic, the
  Dashboard and its APIs. Put it behind your TLS-terminating reverse proxy or
  ingress, and restrict Dashboard access to your corporate network.
- Set `server.trust_proxy` only for proxies you control, so client addresses
  used for rate limits are not spoofable.
- Outbound access can be limited to the provider endpoints you configure.

## Shared Responsibility

| SiftGate provides | Your team is responsible for |
| --- | --- |
| Metadata-only defaults, policy enforcement, key scoping, audit trails | Choosing which providers and models are approved, and their data terms |
| Secret references and redaction | Operating the secret manager and rotating provider keys |
| Signed release artifacts and verification steps | Verifying artifacts and scheduling upgrades |
| TLS-ready deployment manifests | TLS certificates, network policy, host hardening and backups |
| Content-retaining features that are off by default | Approving any feature that stores content, and documenting it |

## Questionnaire Quick Answers

| Question | Answer |
| --- | --- |
| Is customer data sent to the vendor? | No. Traffic goes only to the providers you configure. |
| Are prompts or responses stored? | Not by default. Content retention needs explicit configuration. |
| Where are provider credentials kept? | In your configuration or secret manager, inside your environment. |
| Is access role-based? | Yes: admin, operator and viewer per Workspace, plus scoped Gateway API keys. |
| Is SSO supported? | Yes, generic OIDC. |
| Are admin actions audited? | Yes, in a redacted, hash-chained audit log. |
| Can usage be attributed to teams? | Yes, by key, team, namespace and project, with CSV/JSON export. |
| Are releases signed? | Customer release kits carry Sigstore provenance. |
| Is the source available for review? | Yes, under the MIT license. |

To report a vulnerability, follow the root [SECURITY.md](../SECURITY.md).

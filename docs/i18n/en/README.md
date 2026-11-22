# SiftGate Documentation

[Documentation home](../../README.md) · [Project README](../../../README.md)

Current release: **v2.13.0**.

**Self-hosted AI gateway for enterprise AI governance.** SiftGate puts one
control point you run in front of every AI call your company makes, from
business apps, coding agents and MCP tools. Provider keys stay on your servers,
access follows policy, spend is budgeted and charged back, and every request
leaves an audit trail without storing prompts or responses.

<p align="center">
  <img src="../../assets/homepage/siftgate-hero.svg" alt="SiftGate: self-hosted AI gateway for enterprise AI governance" width="100%" />
</p>

## Why Enterprises Use SiftGate

| What breaks as AI use grows | What SiftGate changes |
| --- | --- |
| Shadow AI and key sprawl | Provider keys stay in the gateway; teams get scoped, revocable Gateway API keys. |
| Security review blocks rollout | Metadata-only by default: no prompts, responses, source code, tool payloads or secrets stored. |
| Spend arrives as one unexplained bill | Budgets at global, namespace, team and key scope, chargeback exports, cache-aware key pools. |
| One provider outage stops everyone | Fallback chains, circuit breakers, credential failover and a route explanation per request. |

## Four Governance Pillars

| Pillar | What it covers |
| --- | --- |
| Access and policy | Scoped keys, Workspaces, Teams and Policy Namespaces with fail-closed intersections, per-key model pools, Agent Profiles, MCP Tool Gateway, RBAC and OIDC. |
| Data protection and audit | Metadata-only logs and traces, local guardrails for PII, secrets and prompt injection, hash-chained management audit, versioned config rollback. |
| Cost control | Daily token and cost budgets, workspace price books, cost report, chargeback CSV/JSON, anomaly evidence, cache savings. |
| Reliability and operations | Smart routing, fallbacks, circuit breakers, route explanation, PostgreSQL/Redis/Kubernetes path, Sigstore-signed release kits, reviewed upgrade plans. |

## Evaluate SiftGate

1. Decide: [Enterprise overview](../../enterprise-overview.md)
2. Review security: [Security and compliance brief](../../security-compliance-brief.md)
3. Demo in 30 minutes: [PoC playbook](../../poc-playbook.md)

## Quick Start

```bash
git clone https://github.com/seanbabalala/SiftGate.git
cd SiftGate
# Select Node >=22.13.0 <23 using .nvmrc.
npm run runtime:check
npm install
cd frontend && npm install && cd ..
cp gateway.config.example.yaml gateway.config.yaml
cp .env.example .env
npm run build
# Configure dashboard.password (or OIDC) in the private YAML before this step.
npm start
```

Open `http://localhost:2099/dashboard`, add a provider node, create a Gateway
API key, then send requests to `http://localhost:2099/v1/chat/completions`.
For a versioned Docker installation with a one-time activation code, use the
[customer install kit](../../customer-install.md).

## Provider Credential Pools

One provider node can hold several upstream keys. `cache_aware` keeps requests
that created or read a provider prompt cache on the same key, and moves to
another key on 429, 5xx or timeouts.

```yaml
credential_pool:
  enabled: true
  strategy: cache_aware
  sticky_by: agent_session
  cooldown_ms: 60000
  retry_on_status: [429, 500, 502, 503, 504]
```

## Documentation Map

| Goal | Start here |
| --- | --- |
| Enterprise evaluation | [Enterprise overview](../../enterprise-overview.md), [Security and compliance brief](../../security-compliance-brief.md), [PoC playbook](../../poc-playbook.md), [Comparison](../../COMPARISON.md) |
| Local trial and Dashboard | [Quickstart](../../QUICKSTART.md), [Dashboard](../../DASHBOARD.md), [OSS Concepts](../../OSS_CONCEPTS.md), [Playground](../../PLAYGROUND.md) |
| Production operations | [Customer install](../../customer-install.md), [Production](../../PRODUCTION.md), [Kubernetes and Helm](../../KUBERNETES.md), [State Backends](../../STATE_BACKEND.md), [Secret Management](../../SECRET_MANAGEMENT.md), [Config Audit and Rollback](../../CONFIG_AUDIT_ROLLBACK.md) |
| Agents and MCP tools | [Coding Agent Gateway](../../CODING_AGENT_GATEWAY.md), [Agent Integrations](../../AGENT_INTEGRATIONS.md), [MCP Tool Gateway](../../MCP_GATEWAY.md), [Agent + MCP Demo](../../AGENT_MCP_DEMO.md) |
| Cost governance | [Cost Platform](../../COST_CHARGEBACK_PLATFORM.md), [Billing Loop](../../BILLING_LOOP.md), [Policy Namespaces](../../NAMESPACES_AND_SHADOW.md) |
| Providers and routing | [Provider Catalog](../../PROVIDER_CATALOG.md), [Provider Compatibility](../../PROVIDER_COMPATIBILITY.md), [Routing Recommendations](../../ROUTING_RECOMMENDATIONS.md), [Multimodal Capabilities](../../MULTIMODAL_CAPABILITIES.md) |
| Observability and alerts | [Operator Observability](../../OPERATOR_OBSERVABILITY.md), [Webhook Alerts](../../WEBHOOK_ALERTS.md), [Log Sinks](../../LOG_SINKS.md), [Security](../../SECURITY.md) |
| Development | [Architecture](../../ARCHITECTURE.md), [API Reference](../../API_REFERENCE.md), [SDKs](../../SDKS.md), [Plugins](../../PLUGINS.md), [Release Checklist](../../RELEASE_CHECKLIST.md) |

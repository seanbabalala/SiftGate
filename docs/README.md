# SiftGate Documentation

SiftGate is a self-hosted AI Gateway for multi-provider model traffic, coding
agents, MCP tools, cost governance, policy enforcement, and metadata-only
operations. The root [README](../README.md) is the product overview; this page
is the documentation map for operators, platform teams, contributors, and
self-hosters.

## Languages

| Language | Localized entrypoint |
| --- | --- |
| English | [i18n/en/README.md](i18n/en/README.md) |
| 简体中文 | [i18n/zh/README.md](i18n/zh/README.md) |
| 繁體中文 | [i18n/zh-TW/README.md](i18n/zh-TW/README.md) |
| 日本語 | [i18n/ja/README.md](i18n/ja/README.md) |
| 한국어 | [i18n/ko/README.md](i18n/ko/README.md) |
| ไทย | [i18n/th/README.md](i18n/th/README.md) |
| Español | [i18n/es/README.md](i18n/es/README.md) |

## Recommended Reading Paths

For current source, verification, deployment, and performance-evidence boundaries,
start with the [engineering baseline](BASELINE.md).

| Goal | Read these first |
| --- | --- |
| Try SiftGate locally | [Quickstart](QUICKSTART.md), [Dashboard](DASHBOARD.md), [OSS concepts](OSS_CONCEPTS.md) |
| Run it in containers | [Docker quickstart](DOCKER_QUICKSTART.md), [Production](PRODUCTION.md), [State backends](STATE_BACKEND.md) |
| Add provider coverage | [Provider Catalog](PROVIDER_CATALOG.md), [Provider Smoke Matrix](PROVIDER_SMOKE_MATRIX.md), [Adding providers](ADDING_PROVIDERS.md), [Provider extensibility](PROVIDER_EXTENSIBILITY.md) |
| Govern teams and apps | [Dashboard](DASHBOARD.md), [Policy Namespaces and Shadow Traffic](NAMESPACES_AND_SHADOW.md), [Cost and chargeback platform](COST_CHARGEBACK_PLATFORM.md) |
| Connect coding agents | [Coding Agent Gateway](CODING_AGENT_GATEWAY.md), [Agent Gateway profiles](AGENT_GATEWAY.md), [Agent + MCP Demo](AGENT_MCP_DEMO.md), [Agent integrations](AGENT_INTEGRATIONS.md) |
| Operate advanced controls | [Semantic Controls](SEMANTIC_PLATFORM.md), [Evaluation framework](EVALUATION_FRAMEWORK.md), [Caching](CACHING.md), [MCP Tool Gateway](MCP_GATEWAY.md) |
| Deploy to production | [Production](PRODUCTION.md), [Kubernetes and Helm](KUBERNETES.md), [Security](SECURITY.md), [Operator observability](OPERATOR_OBSERVABILITY.md), [Secret management](SECRET_MANAGEMENT.md) |
| Extend or contribute | [Architecture](ARCHITECTURE.md), [API reference](API_REFERENCE.md), [Plugins](PLUGINS.md), [Release checklist](RELEASE_CHECKLIST.md) |

## Feature Coverage Matrix

| Product surface | Public docs |
| --- | --- |
| First-run setup, Dashboard onboarding, OSS concepts | [Quickstart](QUICKSTART.md), [Dashboard](DASHBOARD.md), [OSS concepts](OSS_CONCEPTS.md) |
| Workspaces, local RBAC, OIDC, invites | [Dashboard](DASHBOARD.md), [OIDC and invites](OIDC_AND_INVITES.md), [Migration from v1 to v2](MIGRATION_V1_TO_V2.md) |
| Gateway API keys, Policy Namespaces, budgets, chargeback | [API reference](API_REFERENCE.md), [Policy Namespaces and Shadow Traffic](NAMESPACES_AND_SHADOW.md), [Cost and chargeback platform](COST_CHARGEBACK_PLATFORM.md), [Billing loop](BILLING_LOOP.md) |
| Provider nodes, provider catalog, compatibility, custom providers | [Provider Catalog](PROVIDER_CATALOG.md), [Provider Smoke Matrix](PROVIDER_SMOKE_MATRIX.md), [Provider compatibility](PROVIDER_COMPATIBILITY.md), [Provider extensibility](PROVIDER_EXTENSIBILITY.md), [Adding providers](ADDING_PROVIDERS.md) |
| Protocols, modalities, streaming, batching, playground | [API reference](API_REFERENCE.md), [Multimodal capabilities](MULTIMODAL_CAPABILITIES.md), [Stream, cache, and batching](STREAM_CACHE_BATCHING.md), [Batch API](BATCH_API.md), [Playground](PLAYGROUND.md) |
| Routing recommendations, route explanation, performance evidence | [Routing recommendations](ROUTING_RECOMMENDATIONS.md), [Architecture](ARCHITECTURE.md), [Performance](PERFORMANCE.md) |
| Cache, Semantic Controls, Intelligence Loop, evals, experiments, shadow traffic | [Caching](CACHING.md), [Semantic Controls](SEMANTIC_PLATFORM.md), [Intelligence Loop](INTELLIGENCE_LOOP.md), [Evaluation framework](EVALUATION_FRAMEWORK.md), [Policy Namespaces and Shadow Traffic](NAMESPACES_AND_SHADOW.md) |
| Coding agents, Agent Profiles, integrations, Agent Platform, MCP tools | [Coding Agent Gateway](CODING_AGENT_GATEWAY.md), [Agent Gateway profiles](AGENT_GATEWAY.md), [Agent + MCP Demo](AGENT_MCP_DEMO.md), [Agent integrations](AGENT_INTEGRATIONS.md), [Agent Platform preview](AGENT_PLATFORM_PREVIEW.md), [MCP Tool Gateway](MCP_GATEWAY.md) |
| Deployment, state, secrets, observability, config audit, logs, alerts, optional control plane | [Docker quickstart](DOCKER_QUICKSTART.md), [Production](PRODUCTION.md), [Kubernetes and Helm](KUBERNETES.md), [State backends](STATE_BACKEND.md), [Operator observability](OPERATOR_OBSERVABILITY.md), [Secret management](SECRET_MANAGEMENT.md), [Config validation](CONFIG_VALIDATION.md), [Config audit and rollback](CONFIG_AUDIT_ROLLBACK.md), [Log sinks](LOG_SINKS.md), [Webhook alerts](WEBHOOK_ALERTS.md), [Optional Control Plane Contract](CONTROL_PLANE.md) |
| SDKs, plugins, migrations, release process | [SDKs](SDKS.md), [Python SDK design](PYTHON_SDK_DESIGN.md), [Plugins](PLUGINS.md), [Official plugins](plugins/OFFICIAL_PLUGINS.md), [Migration compatibility](MIGRATION_COMPAT.md), [Migration from LiteLLM](MIGRATION_LITELLM.md), [Release checklist](RELEASE_CHECKLIST.md) |

## Start

| Topic | Link |
| --- | --- |
| Product overview | [../README.md](../README.md) |
| Quickstart | [QUICKSTART.md](QUICKSTART.md) |
| Customer installation | [English](customer-install.md), [中文](customer-install.zh-cn.md) |
| Formal image release | [English](customer-release.md), [中文](customer-release.zh-cn.md) |
| Docker quickstart | [DOCKER_QUICKSTART.md](DOCKER_QUICKSTART.md) |
| Dashboard | [DASHBOARD.md](DASHBOARD.md) |
| OSS concepts | [OSS_CONCEPTS.md](OSS_CONCEPTS.md) |
| Comparison | [COMPARISON.md](COMPARISON.md) |
| API reference | [API_REFERENCE.md](API_REFERENCE.md) |
| Open-core model | [OPEN_CORE.md](OPEN_CORE.md) |

## Operate

| Topic | Link |
| --- | --- |
| Production | [PRODUCTION.md](PRODUCTION.md) |
| Kubernetes and Helm | [KUBERNETES.md](KUBERNETES.md) |
| State backends | [STATE_BACKEND.md](STATE_BACKEND.md) |
| Secret management | [SECRET_MANAGEMENT.md](SECRET_MANAGEMENT.md) |
| Config validation | [CONFIG_VALIDATION.md](CONFIG_VALIDATION.md) |
| Config audit and rollback | [CONFIG_AUDIT_ROLLBACK.md](CONFIG_AUDIT_ROLLBACK.md) |
| Operator observability | [OPERATOR_OBSERVABILITY.md](OPERATOR_OBSERVABILITY.md) |
| OIDC and invites | [OIDC_AND_INVITES.md](OIDC_AND_INVITES.md) |
| Security | [SECURITY.md](SECURITY.md) |
| Performance | [PERFORMANCE.md](PERFORMANCE.md) |
| Billing loop | [BILLING_LOOP.md](BILLING_LOOP.md) |
| Alert connectors: Feishu, WeCom, Telegram, webhook | [WEBHOOK_ALERTS.md](WEBHOOK_ALERTS.md) |
| Log sinks | [LOG_SINKS.md](LOG_SINKS.md) |
| Optional Control Plane Contract | [CONTROL_PLANE.md](CONTROL_PLANE.md) |

## Configure AI Traffic

| Topic | Link |
| --- | --- |
| Provider Catalog | [PROVIDER_CATALOG.md](PROVIDER_CATALOG.md) |
| Provider Smoke Matrix | [PROVIDER_SMOKE_MATRIX.md](PROVIDER_SMOKE_MATRIX.md) |
| Provider compatibility | [PROVIDER_COMPATIBILITY.md](PROVIDER_COMPATIBILITY.md) |
| Provider extensibility | [PROVIDER_EXTENSIBILITY.md](PROVIDER_EXTENSIBILITY.md) |
| Adding providers | [ADDING_PROVIDERS.md](ADDING_PROVIDERS.md) |
| Routing recommendations | [ROUTING_RECOMMENDATIONS.md](ROUTING_RECOMMENDATIONS.md) |
| Policy Namespaces and Shadow Traffic | [NAMESPACES_AND_SHADOW.md](NAMESPACES_AND_SHADOW.md) |
| Cost and chargeback platform | [COST_CHARGEBACK_PLATFORM.md](COST_CHARGEBACK_PLATFORM.md) |
| Multimodal capabilities | [MULTIMODAL_CAPABILITIES.md](MULTIMODAL_CAPABILITIES.md) |
| Stream, cache, and batching | [STREAM_CACHE_BATCHING.md](STREAM_CACHE_BATCHING.md) |
| Batch API | [BATCH_API.md](BATCH_API.md) |

## Agents, Tools, And Advanced Surfaces

| Topic | Link |
| --- | --- |
| Coding Agent Gateway | [CODING_AGENT_GATEWAY.md](CODING_AGENT_GATEWAY.md) |
| Agent Gateway profiles | [AGENT_GATEWAY.md](AGENT_GATEWAY.md) |
| Agent + MCP Demo | [AGENT_MCP_DEMO.md](AGENT_MCP_DEMO.md) |
| Agent integrations | [AGENT_INTEGRATIONS.md](AGENT_INTEGRATIONS.md) |
| Agent Platform preview | [AGENT_PLATFORM_PREVIEW.md](AGENT_PLATFORM_PREVIEW.md) |
| MCP Tool Gateway | [MCP_GATEWAY.md](MCP_GATEWAY.md) |
| Semantic Controls | [SEMANTIC_PLATFORM.md](SEMANTIC_PLATFORM.md) |
| Intelligence Loop | [INTELLIGENCE_LOOP.md](INTELLIGENCE_LOOP.md) |
| Evaluation framework | [EVALUATION_FRAMEWORK.md](EVALUATION_FRAMEWORK.md) |
| Caching | [CACHING.md](CACHING.md) |
| Playground | [PLAYGROUND.md](PLAYGROUND.md) |

## Developers

| Topic | Link |
| --- | --- |
| Architecture | [ARCHITECTURE.md](ARCHITECTURE.md) |
| SDKs | [SDKS.md](SDKS.md) |
| Python SDK design | [PYTHON_SDK_DESIGN.md](PYTHON_SDK_DESIGN.md) |
| Plugins | [PLUGINS.md](PLUGINS.md) |
| Official plugins | [plugins/OFFICIAL_PLUGINS.md](plugins/OFFICIAL_PLUGINS.md) |
| Migration compatibility | [MIGRATION_COMPAT.md](MIGRATION_COMPAT.md) |
| Migration from v1 to v2 | [MIGRATION_V1_TO_V2.md](MIGRATION_V1_TO_V2.md) |
| Migration from LiteLLM | [MIGRATION_LITELLM.md](MIGRATION_LITELLM.md) |
| Release checklist | [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md) |

## Privacy Baseline

SiftGate documentation and examples use placeholders only. The gateway does not
store prompts, responses, raw provider headers, provider keys, tool payloads,
media bytes, hidden reasoning, source code, diffs, or resolved secrets by
default.

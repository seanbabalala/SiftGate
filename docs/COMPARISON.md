# Comparison

SiftGate is positioned as an open-source, self-hosted AI gateway for
enterprise AI governance: one control point that companies run themselves for
provider keys, provider credential pools, model routing, agent and MCP traffic,
budgets, policy, audit, and operational evidence. It is not primarily an API
resale platform, billing wallet, or single-purpose model router.

Public positioning references:

| Project | Public source |
| --- | --- |
| Manifest | [github.com/mnfst/manifest](https://github.com/mnfst/manifest) |
| One API | [github.com/songquanpeng/one-api](https://github.com/songquanpeng/one-api) |
| New API | [github.com/QuantumNous/new-api](https://github.com/QuantumNous/new-api) |
| LiteLLM Proxy | [docs.litellm.ai](https://docs.litellm.ai/) |

## Prior Art And Acknowledgements

SiftGate is built in conversation with a broader open-source AI gateway
ecosystem. Manifest helped make cost-aware intelligent model routing for agents
and applications feel practical. One API and New API made multi-provider API
aggregation, channel management, quota workflows, and self-hosted admin
operations accessible to many operators. LiteLLM helped normalize the idea that
teams should not be locked into one provider SDK or model API.

SiftGate takes a different path: a self-hosted AI gateway for enterprise AI
governance, focused on BYOK control, explainable routing, agent and MCP
controls, privacy-safe metadata, and production operations. We are grateful for the public work these
projects contributed to the ecosystem.

## Positioning Summary

| Product | Best At | SiftGate Difference |
| --- | --- | --- |
| Manifest | Cost-first smart model routing for agents and applications | SiftGate adds a broader team data plane: Workspaces, Dashboard RBAC, Policy Namespaces, provider compatibility profiles, richer protocol coverage, MCP governance, route explanations, provider credential pools, audit, production deployment paths, and metadata-only privacy defaults. |
| One API | LLM API management, channels, users, tokens, quota, and redistribution | SiftGate is not primarily a redistribution panel. It focuses on BYOK team-owned traffic, explainable routing, policy hierarchy, provider credential pools, agent governance, provider health, semantic controls, audit, and self-hosted production operations. |
| New API | Aggregation/distribution hub with UI, channel management, billing, and OpenAI/Claude/Gemini conversion | SiftGate overlaps on gatewaying and protocol compatibility, but emphasizes local policy enforcement, evidence-rich route decisions, workspace-scoped operational metadata, provider credential pools, no default content storage, and separation from reseller/payment workflows. |
| LiteLLM Proxy | Broad provider compatibility and developer-friendly proxying | SiftGate emphasizes Dashboard-first operations, canonical protocol metadata, policy governance, cost evidence, provider catalog governance, agent profiles, MCP gatewaying, and route explainability. |

## Benchmark Evidence Snapshot

SiftGate includes committed benchmark reports, not only a benchmark script. The
v2.0.0 GA report was generated on 2026-05-08 at commit
`2328dd76ba1a26e7de5b9d2b88610921aec69883` on macOS arm64, Node v24.12.0, and
Apple M4 hardware. It uses a local deterministic mock upstream to isolate
SiftGate overhead from provider/network latency.

| Evidence | v2.0.0 GA result |
| --- | --- |
| Non-streaming direct proxy overhead | +8 ms p50 / +8 ms p95 / +8 ms p99 versus local mock upstream |
| Smart routing path | 15 ms p50 / 15 ms p95 / 15 ms p99 through SQLite metadata path |
| Streaming total overhead | +10 ms p50 / +10 ms p95 / +10 ms p99 versus local streaming mock upstream |
| Streaming first-byte overhead | +3 ms p50 / +3 ms p95 / +3 ms p99 |
| Metadata-only Dashboard log write | 1 ms p50 / 1 ms p95 / 1 ms p99 |
| Metadata-only Dashboard benchmark read | 5 ms p50 / 5 ms p95 / 5 ms p99 |

The rc.2 report remains available as a slightly larger release-candidate run:
5 requests at concurrency 2, with non-streaming proxy overhead of +13 ms p50 /
+17 ms p95 / +17 ms p99 and streaming first-byte overhead of +3 ms p50 / +3 ms
p95 / +3 ms p99.

The smart-routing prompt corpus is tracked separately in
[`docs/reports/smart-routing-prompt-corpus.md`](reports/smart-routing-prompt-corpus.md).
It contains 500 prompts with seed `42`, tiered as 75 simple, 150 standard, 175
complex, and 100 reasoning prompts. Source counts are WildBench v2 157, IFEval
140, MT-Bench 95, GSM8K 53, and HumanEval 55.

Use these reports as evidence for local gateway overhead, logging overhead, and
repeatability. Do not treat them as live-provider or competitor benchmarks
unless request body, concurrency, commit, hardware, database, network
placement, upstream latency profile, and config are identical. See
[Performance](PERFORMANCE.md) and the committed reports under
[`docs/reports/`](reports/).

## When To Choose SiftGate

Choose SiftGate when the operator owns the AI traffic and needs a governed
runtime path rather than a resale panel or thin SDK proxy:

- Teams need separate Gateway API keys from upstream provider keys.
- Coding agents, applications, MCP tools, and batch jobs should share policy
  without sharing provider credentials.
- Operators need route evidence: selected/rejected candidates, compatibility
  filters, credential hits, fallback reasons, cost estimates, cache evidence,
  and namespace or budget context.
- Provider credentials need to rotate inside a logical node with sticky
  affinity, cooldown, retry-on-status, and credential-level metadata.
- Prompt, response, tool payload, media, source, diff, and resolved secret
  storage must stay off by default.
- The production path needs Dashboard operations, config validation, config
  audit/rollback, OIDC, secret references, log sinks, OpenTelemetry, Docker,
  Kubernetes, and Helm without requiring a hosted control plane.

## When Another Project May Fit Better

This is also an intentional boundary. SiftGate is not trying to win every
gateway-shaped job:

- Choose One API or New API when the primary product is API distribution,
  channel administration, users, quotas, recharge, prepaid wallets, or a
  public-facing resale workflow.
- Choose Manifest when the primary job is a lightweight smart router focused
  on choosing cheaper capable models for agents or applications.
- Choose LiteLLM Proxy when the primary job is broad provider abstraction,
  quick SDK compatibility, and developer-friendly proxying across many model
  APIs with minimal product surface.
- Choose Envoy AI Gateway-style infrastructure when the organization already
  standardizes on Envoy/Gateway API and wants L7 gateway primitives first, with
  AI routing layered into that platform.

## Gaps To Close

SiftGate's current gaps are mostly product adoption and proof, not lack of
surface area:

- **Faster first value**: the feature set is broad, so new users need a shorter
  "one provider, one key, one request, one route explanation" path before they
  learn Workspaces, Policy Namespaces, MCP, Semantic Controls, and evals.
- **Provider confidence**: LiteLLM has stronger market memory for provider
  breadth. SiftGate needs clearer compatibility tables, migration examples,
  and repeated provider smoke tests to make its coverage feel equally trusted.
- **Migration guides**: SiftGate already has LiteLLM migration coverage, but
  One API and New API operators need explicit mapping from channels, tokens,
  groups, quota, and model aliases into SiftGate nodes, Gateway API keys,
  teams, budgets, and Policy Namespaces.
- **Performance proof**: committed v2.0.0 reports already cover local
  mock-upstream overhead, streaming first-byte overhead, and Dashboard/log write
  cost. Future reports should expand concurrency, PostgreSQL, Redis, provider
  credential-pool retry, and MCP stdio launch overhead.
- **Demo assets**: add a visible end-to-end demo for Claude Code or Codex,
  `claude-opus`/`coding-auto`, MCP web search/image understanding, namespace
  policy, budget, and route explanation.
- **Operational defaults**: reduce setup choices for the default local path
  while keeping the advanced controls discoverable.

## Near-Term Documentation Backlog

These additions would make the comparison easier for new operators to act on:

| Gap | Public doc to add or expand |
| --- | --- |
| Shorter first value | Keep expanding the "Five-Minute Governed Request" path in [Quickstart](QUICKSTART.md) with screenshots or a short video. |
| One API / New API migration | Keep expanding channel/token/quota mapping in [Migration compatibility](MIGRATION_COMPAT.md), or create a focused migration guide if it grows. |
| LiteLLM confidence | Use [Migration from LiteLLM](MIGRATION_LITELLM.md) to validate migrated aliases against Dashboard logs and Route Explanation, then add more provider-specific examples. |
| Performance proof | Use the committed v2.0.0 reports in [Performance](PERFORMANCE.md) as current evidence, then add higher-concurrency PostgreSQL/Redis/MCP reports when available. |
| Agent + MCP demo | Use the end-to-end Claude Code/Codex + MCP path and screenshot storyboard in [Agent + MCP Demo](AGENT_MCP_DEMO.md), then add real redacted Dashboard captures when available. |
| Provider coverage trust | Use [Provider Smoke Matrix](PROVIDER_SMOKE_MATRIX.md) for current evidence, then add dated live-provider reports as operator keys and accounts are available. |

## Capability Matrix

| Capability | SiftGate | Manifest | One API | New API | LiteLLM Proxy |
| --- | --- | --- | --- | --- | --- |
| Primary stance | Self-hosted AI gateway for enterprise AI governance | Smart model router | API management and redistribution | Aggregation/distribution hub | Multi-provider proxy |
| Core buyer/operator | Platform teams, AI infrastructure owners, agent teams | Agent builders and cost-conscious app builders | API distributors and internal admins | Aggregation operators and internal admins | Developers and platform teams |
| OpenAI-compatible ingress | Yes | Yes | Yes | Yes | Yes |
| Anthropic Messages-compatible ingress | Yes | Not primary | Partial / adapter-dependent | Yes | Yes |
| OpenAI Responses support | Yes | Not primary | Not primary | Version/provider dependent | Yes / provider-dependent |
| Embeddings and rerank | Yes | Model-dependent | Provider-dependent | Yes | Yes |
| Images, audio, video | Yes, with endpoint families and preview flags where appropriate | Limited / not primary | Provider-dependent | Broad protocol coverage; exact endpoint coverage depends on deployment/version | Provider-dependent |
| Batch API | Yes | Not primary | Not primary | Version/provider dependent | Provider-dependent |
| Realtime | Preview pass-through, disabled by default | Not primary | Not primary | Version/provider dependent | Provider-dependent |
| Smart routing | Complexity scoring, compatibility filtering, cache-aware cost evidence, circuit state, split rules | Core strength: cheapest capable model by local scoring | Channel priority/weight/load balancing | Channel weighting and failover | Routing and fallbacks |
| Route explainability | First-class Route Explanation with selected/rejected candidates and policy/cost/latency/compatibility evidence | Cost/model metadata focus | Channel/log evidence | Channel/log/quota evidence | Logs and callback metadata |
| Provider catalog governance | 50+ provider metadata, compatibility profiles, price source status, active vs transport-only visibility, local overrides | Model catalog oriented toward cost routing | Channel/provider administration | Channel/model asset administration | Provider support matrix |
| Gateway API keys | Yes, separate from provider keys | Yes / provider credentials model | Yes, token-centric | Yes, token-centric | Yes / virtual keys |
| Provider credential pools | Yes: multiple `credentials[]` per node, least-in-flight, weighted round-robin, sticky affinity, cooldown, retryable-status failover, and credential-hit logs without secret exposure | Not the center of the product; provider credentials support routing | Usually channel/token based rather than per-node credential-pool operations | Usually channel/provider based capacity and failover | Supports provider keys and routing patterns; implementation depends on deployment |
| Policy hierarchy | Workspace, API key, Team, Policy Namespace, endpoint/modality/node/model restrictions | Agents, providers, budgets, limits | Users, tokens, channels, quotas | Users, groups, tokens, channels, quotas, billing | Keys, teams/orgs, budgets depending on setup |
| Budget scopes | Global, Policy Namespace, Team, API Key | Spend limits and tracking | Quota/token accounting | Billing, recharge/subscription-style quotas | Budgets and spend controls |
| Agent profiles | Cursor, Cline, Roo Code, Continue, Codex, Claude Code, OpenCode, Generic OpenAI, Generic Anthropic | Strong personal-agent orientation | Generic API integration | AI editor skills and app integrations | Generic client/proxy integration |
| MCP Tool Gateway | Built in with Gateway API key auth, namespace allow-lists, rate limits, metadata logs | Not primary | Not primary | Skills/app integrations exist; gatewaying is not the core product surface | Not primary |
| Semantic controls | Semantic Cache v2, Prompt Registry metadata, context optimizer evidence, intent classification, guardrails metadata | Not primary | Not primary | Not primary | Not primary |
| Audit and rollback | Management audit, config audit, validation-first rollback | Not primary | Admin logs | Admin logs | Logs and config practices |
| Privacy default | Metadata-only by default; no prompt/response/raw header/provider key/tool payload/media/source/diff storage by default | Public docs state prompt/response are not stored by default | Deployment/operator dependent | Deployment/operator dependent | Deployment/operator dependent |
| Production path | SQLite local default, PostgreSQL production path, optional Redis, Docker, Kubernetes, Helm, OIDC, secret references, log sinks, OpenTelemetry | Docker-focused self-hosting plus cloud option | Single binary and Docker-ready | Docker, database options, admin UI, multi-tenant operations | Docker/Kubernetes/common infra patterns |
| Product boundary | Governance and operations for team-owned AI traffic | Cost optimization for agents/apps | API distribution and key management | API aggregation, distribution, billing, and asset management | Provider abstraction and proxying |

## What SiftGate Is

- A self-hosted gateway for Chat Completions, Responses, Messages, Embeddings,
  Rerank, Images, Audio, Video preview, Batch, Realtime preview, Feedback, and
  MCP Tool Gateway traffic.
- A local data plane where provider keys, runtime policy, and operational
  metadata stay with the operator by default.
- A provider credential-pool layer that can rotate multiple upstream keys
  inside one logical node before node-level fallback runs.
- A routing and governance layer for teams using multiple models, agents,
  providers, and client applications.
- A Dashboard-first operations product for keys, workspaces, budgets, route
  evidence, logs, sessions, provider health, audit, cost, semantic controls,
  eval reports, shadow traffic, and MCP.

## What SiftGate Is Not

- Not an AI model provider.
- Not an AI API resale platform by default.
- Not a billing wallet or public marketplace.
- Not a hosted proxy that must sit in the middle of all customer AI traffic.
- Not dependent on a hosted control plane for core local operation.
- Not a prompt store, response store, source-code store, or tool-payload store
  by default.

## Why The Data-Plane Model Matters

If all enterprise AI traffic flows through a vendor-hosted proxy, the vendor
absorbs bandwidth, streaming connection load, latency risk, and
sensitive-content responsibility. SiftGate keeps the runtime data plane in the
operator's environment and treats any external control-plane direction as
optional metadata, policy, recommendation, and audit coordination.

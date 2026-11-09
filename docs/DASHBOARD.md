# Dashboard

The SiftGate Dashboard is part of the MIT open-source Data Plane. It runs from the same gateway process, stores local metadata in SQLite by default, and does not require SiftGate Cloud.

v2.1 adds Coding Agent Gateway profiles on the **Agents** page. It gives
Cursor, Cline, Roo Code, Continue, Codex, Claude Code, OpenCode, Generic
OpenAI-compatible coding agents, Generic Anthropic-compatible coding agents,
and compatible chatbot clients a clear local setup entry while keeping provider
keys in Nodes, env vars, or secret references.

v2.2 adds Intelligence Loop evidence to Overview and Route Explanation. Operators
can inspect cost optimizer decisions, token prediction risk, async eval metadata,
and opt-in quality gate events without storing prompts, responses, raw headers,
provider keys, source code, diffs, tool payloads, media bytes, or hidden
reasoning text by default.

v2.3 adds Provider Extensibility to the **Nodes** workflow: custom provider
templates, custom-header auth mapping, Provider SDK Generator beta docs, and a
workspace-scoped Provider Health Dashboard that aggregates metadata-only
availability, latency, error-rate, probe, circuit, compatibility, and pricing
warning evidence.

v2.6 adds a **Cost Platform** page for internal chargeback, cost anomaly
response, provider price source governance, and thumbs feedback aggregation. It
does not add payment collection, recharge balances, reseller ledgers, or
content storage.

v2.7 adds a **Semantic Controls** page for Semantic Cache v2, Prompt Registry,
Context Window Optimizer evidence, Intent Classification, and Guardrails v2.
It keeps the same metadata-only default: prompt text, response text, raw
headers, provider keys, source code, diffs, tool payloads, media bytes, hidden
reasoning text, and resolved secrets are not stored or returned by default.

v2.0.0-alpha.1 adds the Workspace Core foundation. The Dashboard header shows the active workspace, reads `GET /api/dashboard/workspaces`, validates switches through `POST /api/dashboard/workspaces/switch`, stores the selected workspace in browser local storage, and sends `x-siftgate-workspace-id` on Dashboard API calls. Fresh and upgraded OSS installs start with `Default Organization` and `Default Workspace`; legacy v1.9 metadata maps to that default workspace.

v2.0.0-alpha.2 adds local Dashboard RBAC. The active Dashboard identity is mapped to a workspace membership, the header shows an Admin / Operator / Viewer role badge, and Dashboard write APIs now enforce centralized role checks. Existing local installs bootstrap the `dashboard` identity as an Admin in the default workspace.

v2.0.0-rc.1 adds a workspace-scoped **Audit Log** page for platform management events. It records metadata-only evidence for Dashboard management operations, denied RBAC attempts, local config changes, key/member/invite operations, budget resets, cache clears, and node control actions.

v2.0.0 GA adds a compact first-run checklist to the Overview page. It guides
operators through selecting the active workspace, adding a provider node,
creating a Gateway API key, running the first request, and opening logs,
route evidence, and cost metadata. The checklist is read-only and uses existing
Dashboard APIs.

v2.8.0-alpha.1 adds shared concept language across the Dashboard. Workspace,
Policy Namespace, Semantic Controls, Traffic Experiments, Evals, Shadow
Traffic, MCP Tool Gateway, budget scopes, fixed OSS roles, and Provider Catalog
visibility now use concise helper panels and capability labels such as
Read-only, Config-driven, Preview, OSS fixed roles, Runtime-supported, and
Requires config. See [OSS Concepts](OSS_CONCEPTS.md).

v2.8.0-alpha.3 makes OSS Workspace management real in the Dashboard. Workspace
Admins can create, switch, rename, disable, and reactivate local Workspaces from
the **Workspaces** page. The creator is granted Admin in the new Workspace.
Disabling a Workspace keeps its metadata and audit trail, does not delete or
migrate default Workspace data, and prevents that Workspace from being selected
until it is reactivated.

v2.8.0-beta.1 adds a **Policy Namespaces** page for admin-only, config-backed
Policy Namespace management. It keeps Policy Namespaces distinct from Workspaces:
Policy Namespaces are local routing policy labels with allowed nodes/models, budgets,
and rate limits. The page shows bound API keys and Teams, requires explicit
impact confirmation before deleting bound namespaces, and writes through the
existing config validation, audit, rollback, and hot-reload path.

v2.8.0-beta.2 redesigns the **Budget** page around budget scope and source of
truth. Operators can inspect Global, Policy Namespace, Team, and API Key
budgets, see whether the selected scope is directly configured, inherited, or
unset, and verify daily reset time, alert threshold, current usage, and the
blocking order (`global -> namespace -> team -> key`). Safe edits reuse
existing Policy Namespace, Team, and API Key update paths; Global remains
config-backed through `gateway.config.yaml`.

v2.8.0-beta.3 adds setup-complete panels and copyable YAML examples to
**Semantic Controls**, **Traffic Experiments**, **Eval Reports**, **Shadow
Traffic**, and **MCP Tool Gateway**. These panels explain current config state,
keep advanced features disabled or metadata-only by default, and clearly
separate live split analytics, controlled eval runs, asynchronous shadow
mirroring, semantic metadata controls, and MCP tool-call proxying.

v2.8.0 connects those clarified concepts into the Overview first-run setup
path and related docs links. The checklist now covers Workspace, Provider Node,
Gateway API Key, optional Policy Namespace, daily Budget scope, first request,
evidence review, and advanced setup surfaces. Optional items are clearly marked
so a fresh OSS install is not blocked when it does not need Policy Namespaces or
advanced features yet.

## Pages

| Page | Purpose |
| --- | --- |
| Overview | First-run setup path, related OSS docs, live calls, cost, cache savings, Intelligence Loop summary, latency, budget, provider health, guardrails finding summary, and recent activity |
| Analytics | Daily cost trends, provider/model breakdowns, provider-cache savings trends, hit-rate rankings, and cost-mix visualization |
| Traffic Experiments | Read-only setup YAML and live A/B split analytics from routing `split` variants, without automatic winner promotion |
| Budget | Scope-based Global, Policy Namespace, Team, and API Key budget source-of-truth, inherited/unset state, reset actions, model pricing, and actual-vs-no-cache cost comparison details |
| Cost Platform | Internal chargeback reports, CSV/JSON exports, cost anomalies, provider price sync guardrails, and feedback aggregation |
| Semantic Controls | Semantic cache status/invalidation, prompt template metadata, setup YAML, context optimizer evidence, intent counts, Guardrails v2 findings, and semantic privacy controls |
| Playground | Operator-triggered safe probes for chat, responses, messages, embeddings, rerank, images, audio, video, and realtime capability checks |
| Agents | Coding Agent Gateway profiles for Cursor, Cline, Roo Code, Continue, Codex, Claude Code, OpenCode, Generic OpenAI, Generic Anthropic, and compatible chatbot setup with redacted render snippets and metadata-only recent coding-agent sessions |
| Members | Local workspace membership governance with Admin, Operator, and Viewer roles |
| MCP Tool Gateway | Local MCP servers, setup YAML, static tool metadata, recent metadata-only calls, and error summaries |
| Nodes | Upstream node health, configured-upstream vs catalog-onboarding views, resolved compatibility profiles, compatibility matrix, active probes, realtime status, and Add Node wizard |
| Provider Catalog | Merged provider projection with provider status, canonical/pricing coverage, compatibility profiles, enrichment metadata, recommended model defaults, price source status, scheduled sync status, refresh sources, modality coverage, and provider identity |
| Routing | Tiers, fallback chains, load-balancing targets, adaptive recommendations, and local routing config edits |
| Route Explanation | Privacy-safe route decision traces showing candidate targets, filters, cost/latency/context tradeoffs, Intelligence Loop evidence, multimodal evidence, compatibility evidence, and reasoning support |
| Sessions | Metadata-only request timelines grouped by `agent_session_id`, `session_id`, or legacy `session_key`, with coding-agent connector/repo/project filters, model switches, fallback, errors, cost, latency, shadow, guardrails, and Route Explanation links |
| Logs | Request metadata, source format, route result, local/provider cache outcome, compatibility summary, structured-output intent, reasoning intent, fallback reason, per-request cache-savings evidence, and export-safe call details |
| API Keys | Local Gateway API key create/edit/disable/delete/rotate, one-time full-key copy, masked list values, Policy Namespace binding, endpoint/modality/node/model restrictions, budgets, rate limits, and usage summaries |
| Workspaces | Local Workspace create, switch, rename, disable, and reactivate for workspace Admins, preserving default workspace fallback and legacy metadata behavior |
| Policy Namespaces | Local config-backed Policy Namespace create/edit/delete for Admins, with binding impact summaries, config validation, audit, rollback, and hot reload |
| Eval Reports | Metadata-only setup guidance and primary/candidate/judge run reports, separate from live split analytics and shadow mirroring |
| Shadow Traffic | Setup YAML plus read-only primary vs shadow reports with success, latency, cost, token, fallback, confidence, and risk evidence |
| Benchmarks | Local call-log performance evidence with latency percentiles, status/source breakdowns, cost/token summaries, and methodology notes |
| Batch Jobs | Read-only OpenAI-compatible Batch status, provider batch ids, file ids, request counts, API key/Policy Namespace scope, and sanitized errors without local file-content storage |
| Config Audit | Sanitized config versions, audit events, and validation-first rollback |
| Audit Log | Workspace-scoped platform management audit events with redacted summaries, result filters, actor/resource filters, request ids, and hash-chain evidence |

## First-Run Setup Path

The Overview setup card is the shortest supported OSS path from a fresh clone to
a working gateway:

1. Pick the active Workspace from **Workspaces**.
2. Add one upstream Provider Node from **Nodes** or inspect active presets in
   **Provider Catalog**.
3. Create a Dashboard-managed Gateway API Key from **API Keys**.
4. Optionally create a Policy Namespace when a key or Team needs shared policy.
5. Review daily Budget scope and source of truth in **Budget**.
6. Send a safe request from **Playground** or an OpenAI-compatible client.
7. Open **Logs** and **Route Explain** evidence after traffic lands.
8. Review advanced setup docs for Semantic Controls, Traffic Experiments, Eval
   Reports, Shadow Traffic, and MCP Tool Gateway only when needed.

The card is read-only and metadata-only. It links to Quickstart, OSS Concepts,
Provider Catalog, Policy Namespace, Dashboard, and advanced setup docs. It does
not create backend resources beyond the existing pages the operator opens, and
it does not store prompts, responses, raw headers, provider keys, media bytes,
tool payloads, hidden reasoning, or resolved secrets.

## Provider Catalog UX

The Provider Catalog page is a read-only operations explorer for large provider catalogs. It uses `GET /api/dashboard/catalog/providers` and does not keep a separate provider/model list in React components.

v1.4 adds summary cards, provider-family groups, collapsed provider lists, and filters for family, modality, provider type, price source status, compatibility profile, review-required state, stale pricing, and provider/model aliases. v2.8.0-alpha.2 makes the summary cards count active catalog rows separately from transport-only, custom, deprecated/legacy, and total provider presets so the default visible count is not mistaken for total runtime support. Provider rows show logo identity, modalities, primary endpoints, compatibility profile, price source status, last-updated metadata, manual-review state, model count, override state, and sync state when present.

In v1.8, Provider Catalog detail also surfaces the normalized catalog truth in a constrained way: provider status, default visibility, canonical/pricing coverage, fresh default model groups, release date, max context, throughput, and a few high-value benchmark snippets when available. It stays focused on setup and governance rather than becoming a benchmark leaderboard.

The detail panel shows homepage/docs/pricing links, auth type, base URL, endpoint map, model buckets, capability flags, limits, pricing units, override state, sync status, enrichment summaries, and catalog-truth copy that explains OpenRouter canonical pricing is a reference and ZeroEval is a secondary review-required reference. It remains metadata-only and never exposes provider API keys, raw headers, prompts, responses, media bytes, or generated video bytes.

The Add Node Wizard uses the same catalog response for provider presets. The provider step supports family filters and alias search such as Kimi/Moonshot, Qwen/Tongyi, and Doubao/Volcengine while keeping advanced endpoint, headers, model aliases, prefixes, pricing, compatibility profile, health check, and custom-provider fields available before save.

v1.8 changes the defaulting behavior behind that same flow:

- the wizard still has the full model list for search and manual edits
- the default buckets now come from backend `recommended_model_buckets` derived from canonical projection
- provider cards default to active providers only; transport-only, deprecated, and legacy rows stay behind an explicit transport-only/hidden-presets control
- provider cards and model steps can show "latest recommended" style guidance, status badges, coverage signals, and trust copy
- default pricing rows are seeded from recommended models first
- trust copy clarifies that catalog enrichment pricing is a review-required default reference and explicit operator pricing still wins

## Nodes UX

In v1.8, the Nodes page no longer treats catalog onboarding and configured runtime state as the same thing:

- `Catalog Onboarding` highlights active providers that are not configured yet and shows their canonical/pricing coverage plus recommended models
- `Configured Upstreams` focuses on actual runtime nodes, then adds catalog match, status, and trust signals only when a clean provider mapping exists
- operator-defined custom nodes remain editable without pretending they are canonical catalog rows
- deprecated / transport-only / legacy provider rows are not promoted into the default onboarding path, even though transport-only presets can still be configured as runtime nodes

v2.3 adds a Provider Health Dashboard section on the Nodes page. It reads
`GET /api/dashboard/provider-health` and shows configured provider availability,
call counts, p95 latency, error rate, active probe/circuit state, compatibility
labels, custom-header metadata, and pricing-source warnings for the active
workspace. It is an operations view, not a content store: prompts, responses,
raw headers, provider keys, source code, diffs, media bytes, tool payloads, and
hidden reasoning text are not stored or returned by default.

The Add Node Wizard can now configure `auth_type: custom-header` for compatible
providers that need an auth header name such as `api-key` or `X-Provider-Key`.
The optional prefix is rendered as metadata only; provider key values stay in
local config, env vars, or secret references and are never returned by Dashboard
APIs.

## Cache Savings Analytics

The Dashboard Overview now uses the provider-cache savings summary to show how much spend was avoided during the active window because the upstream provider returned cache-read tokens instead of billing everything as normal input. The KPI keeps local prompt-cache and semantic-cache short-circuit hits separate from provider-side cache savings.

The Analytics page reads `GET /api/dashboard/cache-savings` to render daily savings trends, provider-cache hit-rate trends, provider/model savings rankings, and a stacked cost mix for normal input, cache read, cache write, and output cost. These views are derived from privacy-safe call-log metadata only.

Logs rows add a Provider Cache badge when a provider-routed request reports `cache_read_input_tokens > 0`. The tooltip and detail panel compare `cost_usd` with `cost_without_cache_usd`, so operators can inspect per-request savings without exposing prompts, responses, raw headers, or provider keys. The Budget page reuses the same data to explain that actual spend already includes provider-cache discounts.

## API Key Safety

The API Key editor also supports opt-in [per-model routing](api-key-model-routing.md)
across allowed nodes, with round-robin or weighted selection. This is independent
of global `auto` routing and does not expand Key/Team/Namespace permissions.

Gateway API keys are client credentials generated by the Dashboard. Provider API keys remain in `gateway.config.yaml`, `.env`, or an enabled secret reference backend and are used only by SiftGate when it calls upstream providers.

Dashboard API key create and rotate responses show the full key once. After that, the Dashboard and APIs only return masked prefixes and permission metadata. Mutating API key operations write config audit events with redacted summaries and never store the one-time secret.

## Workspace RBAC

Dashboard RBAC is local to the OSS data plane in v2.0.0-alpha.2. It uses a `workspace_memberships` table with `user_id`, `organization_id`, `workspace_id`, `role`, `status`, and timestamps. The local Dashboard session identity is `dashboard` unless a future identity provider supplies a different subject.

Role behavior:

- Viewer can read Dashboard resources, analytics, logs, reports, and sanitized config metadata.
- Operator can perform operational writes such as node tests/resets, routing updates, Agent Profile management, eval runs, batches, MCP operational views, cache clear, and safe config reloads.
- Admin can manage members, Gateway API keys, local teams, budgets, workspace settings, destructive operations, node deletion, and config rollback.

The Workspaces page reads `GET /api/dashboard/workspaces`, creates through `POST /api/dashboard/workspaces`, renames through `PUT /api/dashboard/workspaces/:id`, disables through `POST /api/dashboard/workspaces/:id/disable`, reactivates through `POST /api/dashboard/workspaces/:id/reactivate`, and switches through `POST /api/dashboard/workspaces/switch`. Workspace mutations require Admin in the target Workspace; switch requires an active membership in the target Workspace.

The Policy Namespaces page reads `GET /api/dashboard/namespaces`, creates
through `POST /api/dashboard/namespaces`, updates through `PUT
/api/dashboard/namespaces/:id`, and deletes through `DELETE
/api/dashboard/namespaces/:id`. Mutations require Admin. Delete requests that
would affect bound API keys or Teams require explicit impact confirmation, and
all namespace writes pass full config validation before the gateway reloads.

The Members page reads `GET /api/dashboard/members` and updates roles through `PUT /api/dashboard/members/:id`. SiftGate prevents disabling or demoting the last active workspace Admin to avoid local lockout. RBAC responses expose only membership metadata and never include provider secrets, raw headers, prompts, responses, media bytes, tool payloads, hidden reasoning text, or resolved secrets.

## Management Audit Safety

The Audit Log page reads `GET /api/dashboard/audit`. It is available to Viewer
and above, because it is a read-only governance surface. Filters cover result,
action, resource type, resource id, and actor id. Event details show
redacted before/after summaries plus request id, source, metadata, previous
hash, current hash, and schema version.

Audit rows are not editable from the Dashboard. The audit writer sanitizes
summaries before storage and response serialization. It redacts secret-like
fields, Gateway API key plaintext, bearer tokens, provider keys, prompt/response
content, raw headers, media bytes, tool payloads, hidden reasoning text, and
resolved secrets by default.

## Agent Profiles Safety

The **Agents** page reads and writes `/api/dashboard/agent-profiles`. Profiles
store local setup metadata for agent and chatbot clients, including connector
type, workspace, optional Gateway API key binding, optional namespace binding,
default model, smart model id, coding virtual model aliases, base URL mode,
advisory routing hint JSON, and optional MCP server ids.

Rendered configs are intentionally redacted. The Dashboard shows a Gateway API
key placeholder for agents and chatbots, plus masked key metadata when a profile
is bound to an existing key. It does not expose stored Gateway API key
plaintext, provider API keys, raw auth headers, prompts, responses, source code,
diffs, repository content, MCP tool payloads, media bytes, or video bytes.

Smart router uses `auto`, `coding-auto`, `coding-fast`, `coding-deep`,
`coding-security`, or a legacy connector-safe virtual model such as
`claude-siftgate-auto`. Those virtual models are profile-scoped and map to
internal `auto` only for a matching active profile and Gateway API key. Smart
routing still requires `allow_auto`; direct model routing still requires
`allow_direct`.

The Agents page also shows recent coding-agent sessions. These summaries are
metadata-only and aggregate request count, cost, latency, connector, repo label,
project label, and Route Explanation links without storing source files, diffs,
prompts, responses, or tool payloads.

Routing hints are advisory. Gateway API key policies, Policy Namespaces, local teams, budgets, rate limits, allowed endpoints, allowed models, allowed nodes, allowed modalities, circuit state, and fallback rules remain authoritative.

## Intelligence Loop

The Overview page reads `GET /api/dashboard/intelligence/summary` and shows a
compact Intelligence Loop card with estimated savings, optimized route count,
and quality gate failures for the active window.

Route Explanation adds an Intelligence Loop panel when a trace contains v2.2
evidence. The panel shows:

- Cost Optimizer enabled/applied state, objective, and evidence-only vs applied
  mode.
- Token Prediction risk, action, estimated cost, and remaining budget.
- Quality Gate final status, mode, and matched rule events.
- Async Eval queue state, metadata-only status, and configured dimensions.

Quality Gate actions are visible only as metadata. The Dashboard does not expose
prompt text, response text, raw headers, provider keys, source code, diffs, tool
payloads, media bytes, hidden reasoning text, or resolved secrets. Streaming
requests are marked as skipped for post-start retry/fallback safety.

## Cost Platform

The Cost Platform page reads `GET /api/dashboard/cost-platform` and offers
metadata-only CSV/JSON exports through
`GET /api/dashboard/cost-platform/export`.

Operators can group chargeback by workspace, team, project, Gateway API key,
model, or node. The page shows period cost, request counts, estimated savings,
success rate, budget period close status, and invoice-friendly internal line
items. These summaries are for internal allocation only; provider invoices and
operator rate cards remain authoritative.

Cost anomaly cards compare the current half of the selected period against the
previous half and surface warning or critical rate-of-change spikes. Automatic
downgrade remains optional and is never applied silently.

Provider price sync status shows explicit supported sources, freshness,
review-required warnings, and operator override state. SiftGate does not
auto-trust synced prices and does not silently overwrite operator overrides.

Feedback aggregation reads metadata recorded by `POST /v1/feedback`. The
Dashboard displays thumbs up/down by model and node with route-weight evidence.
It does not expose prompts, responses, source code, diffs, tool payloads, raw
headers, provider keys, media bytes, or hidden reasoning text.

## Semantic Controls

The Semantic Controls page reads `GET /api/dashboard/semantic-platform` and
combines disabled-by-default Semantic Cache v2, Prompt Registry, Context Window
Optimizer, Intent Classification, and Guardrails v2 metadata.

The setup panel renders a metadata-only YAML baseline for `semantic_cache` and
`semantic_platform`. Its status badges show whether the control plane, semantic
cache, and content-storage opt-ins are active. This is intentionally a setup
guide: it does not enable features from the browser and it does not store
prompts, responses, template bodies, raw headers, provider keys, tool payloads,
media bytes, hidden reasoning, or resolved secrets by default.

Operators can create prompt template versions through
`POST /api/dashboard/semantic-platform/prompt-templates`, list template
metadata through `GET /api/dashboard/semantic-platform/prompt-templates`, and
invalidate active-workspace semantic cache entries through
`POST /api/dashboard/semantic-platform/semantic-cache/invalidate`.

Prompt Registry stores template hashes, variables, route policy ids, A/B
metadata, and version status by default. Template body storage requires
`semantic_platform.prompt_registry.store_template_content=true`. Semantic cache
response replay requires both `semantic_cache.store_responses=true` and, by
default, the per-request header `x-siftgate-semantic-store-response: true`.

Route Explanation shows top-level `semantic_platform` evidence when present:
intent category/confidence, context token ratio/action, prompt key/version/hash,
and Guardrails v2 metadata-only findings. It does not expose prompt text,
response text, raw headers, provider keys, source code, diffs, tool payloads,
media bytes, hidden reasoning text, or resolved secrets by default.

## Playground Safety

The Playground calls `POST /api/dashboard/playground/run` through the Dashboard session. It can apply a selected local Gateway API key by id, Policy Namespace restriction, model, endpoint, stream toggle, and routing hint, but the browser never receives the plaintext Gateway API key or any provider key.

Default samples are intentionally tiny and synthetic. Realtime is a probe-only capability check; it does not open a WebSocket session. Playground request and response previews are returned to the current Dashboard view only. Normal call logs keep the same metadata as regular gateway traffic, including route decision ids when available, but Playground does not add a raw prompt/response/media store.

## MCP Tool Gateway Safety

The MCP Tool Gateway page reads `GET /api/dashboard/mcp`. It is read-only and only displays local config registry metadata plus recent in-memory audit metadata. It does not call tools from the browser and cannot modify MCP server config.

The MCP Tool Gateway preview stores server id/name, method, tool name, API key id/name, Policy Namespace, upstream status, latency, byte size, and sanitized error type. It does not store MCP tool arguments, tool results, raw headers, provider keys, resolved secret values, media bytes, or marketplace metadata.

The setup panel clarifies that MCP Tool Gateway governs tool-call proxying, not
model routing. The copyable YAML example combines `mcp.servers[]`,
transport choice, optional `message_url` or stdio fields, `allowed_namespaces`,
secret-reference headers, and API key `allowed_endpoints` such as
`mcp:local-docs:search_docs`.

## Agent Platform Preview

The Agent Platform page reads `GET /api/dashboard/agent-platform`. It combines
workspace-scoped Agent Profiles, Gateway API key summaries, MCP Tool Gateway server metadata,
preview-only workflow metadata, Conversation Memory Gateway counters, and recent
agent trace spans into one read-only control plane.

The page does not execute MCP tools, create workflows, replay agent calls, or
change routing policy. Workflow metadata is explicitly marked preview-only with
`runtime_enabled=false`, and memory content storage is disabled by default.
Prompts, responses, source code, diffs, tool payloads, raw headers, provider
keys, media bytes, hidden reasoning text, and resolved secrets remain excluded
from default storage.

## Batch Jobs

The Batch Jobs page reads `GET /api/dashboard/batches` and stays read-only. It shows provider batch id, selected node/model hint, endpoint, input/output/error file ids, completion window, request counts, status, API key/Policy Namespace attribution, and sanitized error text. It does not show or persist batch input JSONL, provider output JSONL, raw headers, provider keys, or file bytes; result download routes proxy content on demand through `/v1/batches/:id/output` or `/v1/batches/:id/errors`.

## Session Traceability

Applications can pass `x-session-id`, legacy `x-session-key`,
`x-siftgate-session-id`, `x-trace-id`, `x-siftgate-trace-id`, or standard W3C
`traceparent` headers. Coding agents can additionally pass safe labels such as
`x-siftgate-agent-session-id`, `x-siftgate-agent-turn-id`, `x-siftgate-repo`,
and `x-siftgate-project`. SiftGate records only identifiers, sanitized labels,
and operational metadata. The Session View does not persist prompt text,
response text, source code, diffs, tool payloads, raw authorization headers,
provider keys, uploaded media, or generated video bytes.

The page is read-only. It helps operators understand when a session changed models, fell back, hit shadow traffic, produced guardrails findings, or has a route-decision trace available. It does not change routing policy or replay traffic.

## Provider Compatibility

v1.4 Provider Compatibility Profiles are shown consistently across Provider Catalog, Nodes, Route Explanation, and Logs. Profiles describe provider protocol behavior such as request style, response style, endpoint strategy, streaming, multipart, async jobs, supported source formats, supported modalities, passthrough fields, downgraded fields, unsupported fields, and known limitations.

The Add Node Wizard reads suggested profiles from the catalog API and lets operators set `compatibility_profile` for custom gateways or local model servers. Provider Catalog and Node detail pages show profiles as read-only metadata. They do not modify routing config from detail pages.

The Provider Compatibility Matrix uses profiles to choose safe probes for chat, responses, messages, embeddings, rerank, images, audio, video, realtime, and batch. Text-like probes use tiny synthetic inputs. Media, video, realtime, and batch probes default to endpoint/auth checks.

Route Explanation displays why a provider was selected or filtered by profile, including source-format support, modality support, endpoint strategy, protocol strategy, and fields that were passed through, downgraded, or unsupported. Logs detail shows a compact compatibility summary. Neither view stores or exposes prompts, responses, raw headers, provider keys, media bytes, or video bytes.

## Localization

Dashboard copy is maintained in seven languages: English, Simplified Chinese, Traditional Chinese, Japanese, Korean, Thai, and Spanish. New Dashboard features should add product-aware localized labels rather than raw backend field translations.

## Open-Source Boundary

The Dashboard manages the local Data Plane only. Workspace Core in v2.0.0-alpha.1 is the OSS ownership boundary for local metadata, and v2.0.0-alpha.2 adds local Dashboard RBAC for that boundary. Optional OIDC and invite metadata are available in v2.0.0, but the OSS Dashboard does not include SCIM, LDAP, organization billing, the public website, private Cloud dashboard code, or custom enterprise permission expressions.

# SiftGate API Reference

SiftGate exposes provider-compatible AI ingress endpoints, a local Dashboard API, and machine-readable OpenAPI documentation for the MIT open-source Data Plane.

v0.8 hardens the OpenAI-compatible images/audio ingress added in v0.6 with image variations, audio translations, richer media metadata, production log visibility, and an experimental async video generation preview. Media files and video bytes remain pass-through only and are not persisted by SiftGate.

## Live Documentation

When the gateway is running, the API documentation is available from the same HTTP server:

| Endpoint | Purpose |
| --- | --- |
| `GET /docs` | Swagger UI for interactive exploration |
| `GET /openapi.json` | OpenAPI 3.x document for client generation and CI checks |

The generated spec covers the OSS Data Plane only. It does not require SiftGate Cloud, and Cloud remains an optional control plane.

## Authentication

SiftGate uses two client authentication contexts:

| Context | Used by | Header |
| --- | --- | --- |
| Gateway API key | AI proxy endpoints under `/v1/*` | `Authorization: Bearer gw_sk_live_...`, or `x-api-key: gw_sk_live_...` for native Anthropic clients |
| Dashboard session JWT | Dashboard API under `/api/dashboard/*` when dashboard auth is enabled | HttpOnly `siftgate_dashboard_session` cookie, or `Authorization: Bearer <dashboard_jwt>` when legacy token compatibility is enabled |

Provider API keys are never client credentials. They stay in `gateway.config.yaml`, `.env`, or another local secret source and are used only by the gateway when it calls upstream providers.

When both Gateway API key headers are present, a non-empty `Authorization: Bearer`
credential takes precedence. SiftGate never forwards either client credential as
an upstream provider credential.

## AI Proxy Endpoints

| Method | Endpoint | Description |
| --- | --- | --- |
| `POST` | `/v1/chat/completions` | OpenAI Chat Completions-compatible ingress |
| `POST` | `/v1/responses` | OpenAI Responses-compatible ingress |
| `POST` | `/v1/messages` | Anthropic Messages-compatible ingress |
| `POST` | `/v1/embeddings` | OpenAI Embeddings-compatible ingress |
| `POST` | `/v1/rerank` | OpenAI/common-compatible rerank ingress |
| `POST` | `/v1/images/generations` | OpenAI Images generation-compatible ingress |
| `POST` | `/v1/images/edits` | OpenAI Images edits-compatible ingress |
| `POST` | `/v1/images/variations` | OpenAI Images variations-compatible ingress |
| `POST` | `/v1/audio/transcriptions` | OpenAI Audio transcription-compatible ingress |
| `POST` | `/v1/audio/translations` | OpenAI Audio translation-compatible ingress |
| `POST` | `/v1/audio/speech` | OpenAI Audio speech-compatible ingress |
| `POST` | `/v1/videos/generations` | Experimental async video generation preview |
| `GET` | `/v1/videos/:id` | Experimental video job status |
| `GET` | `/v1/videos/:id/content` | Experimental video content proxy |
| `POST` | `/v1/videos/:id/cancel` | Experimental video cancel proxy |
| `POST` | `/v1/batches` | OpenAI-compatible Batch API create proxy |
| `GET` | `/v1/batches/:id` | Batch status proxy using local metadata lookup |
| `POST` | `/v1/batches/:id/cancel` | Batch cancel proxy |
| `GET` | `/v1/batches/:id/output` | Batch output file content proxy; content is not persisted |
| `GET` | `/v1/batches/:id/errors` | Batch error file content proxy; content is not persisted |
| `WS` | `/v1/realtime` | Experimental OpenAI Realtime-style WebSocket pass-through, disabled by default |
| `GET` | `/v1/models` | OpenAI-compatible model list, including gateway aliases |
| `POST` | `/v1/feedback` | Metadata-only thumbs feedback for a gateway request id |

All proxy endpoints require a Dashboard-generated Gateway API key. Use `model: "auto"` for smart routing, a real model id for direct routing, a configured alias, a node id, or a `node/model` prefix route when that key allows direct access. Dashboard-managed keys can also restrict endpoint families (`chat_completions`, `responses`, `messages`, `embeddings`, `rerank`, `images`, `audio`, `video`, `realtime`, `batch`, `models`) and modalities (`text`, `vision`, `embedding`, `rerank`, `image`, `audio`, `video`, `realtime`) before routing reaches an upstream provider.

In v2.1, Coding Agent Gateway profiles can expose profile-scoped virtual smart
models to `/v1/models`. `coding-auto`, `coding-fast`, `coding-deep`, and
`coding-security` are visible only when an active coding-agent profile is bound
to the calling Gateway API key and the key allows smart routing. Requests for
those virtual models map to internal `auto`; they do not force direct provider
model routing. The legacy `claude-siftgate-auto` profile virtual model remains
supported for older Claude-style profile configs.

The gateway preserves the caller-facing protocol while routing across configured provider protocols. Requests and responses may be normalized internally, but provider credentials and raw authorization headers are not exposed in OpenAPI examples or Dashboard DTOs.

v2.2 adds the optional Intelligence Loop. Token prediction can reject a request
before an upstream call only when `intelligence.token_prediction.budget_policy`
is explicitly set to `reject`; otherwise it records metadata-only route
evidence. Cost optimizer route changes require
`intelligence.cost_optimizer.action=optimize`. Quality Gate retries/fallbacks
run only before response bytes are sent and never after streaming has started.

v2.5 adds `GET /api/dashboard/agent-platform`, a read-only Dashboard endpoint
for the Agent Platform preview. It returns workspace-scoped A2A registry rows,
MCP-backed Tool Registry metadata, preview-only workflow metadata, memory
metadata counters, recent agent trace spans, and an explicit privacy contract.
It does not execute tools, run workflows, or store prompts, responses, source
code, diffs, tool payloads, raw headers, provider keys, media bytes, hidden
reasoning text, or resolved secrets.

v2.6 adds Cost And Chargeback Platform endpoints for internal chargeback,
anomaly response, provider price source governance, and thumbs feedback. These
endpoints do not add payments, recharge balances, reseller ledgers, public API
marketplaces, prompt/response storage, source-code storage, tool payload
storage, raw-header storage, or provider-key exposure.

v2.7 adds Semantic Controls endpoints for Semantic Cache v2, Prompt Registry,
Context Window Optimizer evidence, Intent Classification, and Guardrails v2.
These endpoints are workspace-scoped and metadata-only by default. They do not
store or return prompts, responses, raw provider headers, provider keys, media
bytes, tool payloads, hidden reasoning text, or resolved secrets unless a
separate documented content-storage opt-in is explicitly enabled.

### Structured Output

Structured-output intent is preserved in the canonical request and forwarded to the selected provider when SiftGate has a safe protocol mapping.

| Ingress | Supported Field | Behavior |
| --- | --- | --- |
| `/v1/chat/completions` | `response_format.type=json_object` or `json_schema` | Passed through to Chat targets or mapped to Responses `text.format` / Messages `output_config.format` when possible |
| `/v1/responses` | `text.format.type=json_object` or `json_schema` | Passed through to Responses targets or mapped to Chat `response_format` / Messages `output_config.format` when possible |
| `/v1/messages` | `output_config.format.type=json_schema` | Passed through for native Messages targets; mapped to OpenAI-compatible structured-output fields only when safe |

Example Chat request:

```json
{
  "model": "auto",
  "messages": [{ "role": "user", "content": "Return a JSON status." }],
  "response_format": {
    "type": "json_schema",
    "json_schema": {
      "name": "status",
      "schema": {
        "type": "object",
        "required": ["ok"],
        "properties": { "ok": { "type": "boolean" } }
      },
      "strict": true
    }
  }
}
```

Example Responses request:

```json
{
  "model": "auto",
  "input": "Return a JSON status.",
  "text": {
    "format": {
      "type": "json_schema",
      "name": "status",
      "schema": {
        "type": "object",
        "required": ["ok"],
        "properties": { "ok": { "type": "boolean" } }
      },
      "strict": true
    }
  }
}
```

Example Messages request:

```json
{
  "model": "auto",
  "max_tokens": 512,
  "messages": [{ "role": "user", "content": "Return a JSON status." }],
  "output_config": {
    "format": {
      "type": "json_schema",
      "schema": {
        "type": "object",
        "required": ["ok"],
        "properties": { "ok": { "type": "boolean" } }
      }
    }
  }
}
```

### Reasoning And Thinking Controls

v1.0 adds privacy-safe canonical reasoning intent so production clients can ask for deeper thinking without losing provider-specific parameters during routing.

| Ingress | Supported Field | Behavior |
| --- | --- | --- |
| `/v1/chat/completions` | `reasoning_effort` | Passed through to Chat targets, mapped to Responses `reasoning.effort`, or mapped to Anthropic `thinking.budget_tokens` only when a safe budget can be derived |
| `/v1/responses` | `reasoning.effort` | Passed through to Responses targets or mapped to OpenAI-compatible `reasoning_effort` / Anthropic thinking when safe |
| `/v1/messages` | `thinking.type=enabled`, `thinking.budget_tokens` | Passed through for native Messages targets; cross-protocol forwarding keeps the original intent in canonical metadata and marks downgraded when no safe effort mapping exists |
| OpenAI-compatible Gemini-style Chat | `thinking_config` | Preserved for compatible Chat targets as `thinking_config`; other protocols record the downgrade instead of inventing provider-specific values |

Canonical OpenAI effort levels include `none`, `minimal`, `low`, `medium`,
`high`, `xhigh`, and `max`; actual support remains model-specific. GPT-5.6 uses
`none`, `low`, `medium`, `high`, `xhigh`, and `max`. Provider-specific values
are preserved only on native same-protocol routes and are not guessed across
protocols.

Example Chat request:

```json
{
  "model": "auto",
  "messages": [{ "role": "user", "content": "Solve this carefully." }],
  "reasoning_effort": "high"
}
```

Example Responses request:

```json
{
  "model": "auto",
  "input": "Create a migration plan.",
  "reasoning": { "effort": "medium" }
}
```

Example Anthropic Messages request:

```json
{
  "model": "auto",
  "max_tokens": 4096,
  "messages": [{ "role": "user", "content": "Analyze the tradeoffs." }],
  "thinking": { "type": "enabled", "budget_tokens": 2048 }
}
```

Reasoning metadata stored in `call_logs` and route decisions is limited to intent, effort, budget token count, source, forwarding strategy, support status, and sanitized downgrade reason. SiftGate does not store hidden chain-of-thought, prompts, responses, raw headers, or provider keys.

Call logs, CSV/JSON exports, external log sinks, and optional control-plane telemetry include structured-output metadata: requested status, type, strategy (`passthrough`, `native`, or `downgraded`), support flag, and schema name. Reasoning logs similarly record requested status, effort, strategy (`passthrough`, `native`, `downgraded`, or `unsupported`), support flag, source, budget tokens, and sanitized reason. If `routing.fallback_policy.structured_output.enabled` is true, non-streaming requests can fallback on JSON parse or schema validation failure. Streaming requests do not fallback after SSE output has started.

### Embeddings

`POST /v1/embeddings` accepts OpenAI-compatible embedding requests:

```json
{
  "model": "auto",
  "input": ["hello", "world"],
  "dimensions": 1536,
  "encoding_format": "float"
}
```

Embedding routing uses `nodes[].embedding_models`. `model: "auto"` filters by API key permissions, active circuits, and requested dimensions, then prefers the lowest configured input price. Direct model requests must resolve to an embedding model; chat models listed only in `nodes[].models` are not selected for this endpoint. Responses preserve the OpenAI shape with `object: "list"`, embedding data, and `usage.prompt_tokens` / `usage.total_tokens`.

### Rerank

`POST /v1/rerank` accepts OpenAI/common-compatible rerank requests:
```json
{
  "model": "auto",
  "query": "what is SiftGate?",
  "documents": [
    "SiftGate is a self-hosted AI traffic gateway.",
    "SQLite is the default local database."
  ],
  "top_n": 1,
  "return_documents": true
}
```

Rerank routing uses `nodes[].rerank_models`. `model: "auto"` filters by Gateway API key permissions, local namespace restrictions, circuit/health state, and configured model availability, then prefers the lowest configured input price. Direct model requests must resolve to a rerank model; chat models listed only in `nodes[].models` and embeddings listed only in `nodes[].embedding_models` are not selected for this endpoint. Responses preserve a common rerank shape with `object: "rerank"`, sorted `results`, `relevance_score`, optional `document`, and `usage.prompt_tokens` / `usage.total_tokens`.

### Images

`POST /v1/images/generations` accepts OpenAI-compatible JSON bodies and selects from `nodes[].image_models`:

```json
{
  "model": "auto",
  "prompt": "A clean product render of SiftGate",
  "size": "1024x1024"
}
```

`POST /v1/images/edits` accepts JSON or `multipart/form-data`. For multipart requests, SiftGate does not parse, resize, transcode, or inspect image file contents. It preserves the raw multipart bytes, rewrites or appends the selected `model` form field, and records only safe canonical metadata such as media type, operation, multipart status, file count, byte size, requested/response format, and upstream response content type.

`POST /v1/images/variations` uses the same image-capable route pool and multipart pass-through behavior. If an upstream does not implement image variations, keep `images_variations_endpoint` pointed at a compatible proxy that does, or let the provider return its native unsupported-operation error; SiftGate will surface it as a normal provider failure/fallback without storing image bytes.

Image responses are returned in the upstream provider's OpenAI-compatible JSON shape.

### Audio

`POST /v1/audio/transcriptions` accepts JSON or `multipart/form-data` and selects from `nodes[].audio_models`. Multipart audio is pass-through: SiftGate rewrites/appends `model`, forwards the original file bytes, and does not decode or transcode media locally.

```bash
curl http://localhost:2099/v1/audio/transcriptions \
  -H "Authorization: Bearer gw_sk_live_..." \
  -F model=auto \
  -F file=@sample.wav
```

`POST /v1/audio/translations` follows the same route, budget, fallback, and multipart pass-through path as transcriptions:

```bash
curl http://localhost:2099/v1/audio/translations \
  -H "Authorization: Bearer gw_sk_live_..." \
  -F model=auto \
  -F response_format=json \
  -F file=@sample.wav
```

`POST /v1/audio/speech` accepts OpenAI-compatible JSON and can return binary provider audio directly:

```json
{
  "model": "tts-1",
  "input": "Hello from SiftGate",
  "voice": "alloy"
}
```

When an upstream returns non-JSON audio such as `audio/mpeg`, SiftGate forwards the provider body and content type unchanged and records only the provider response content type. Increase `server.body_limit` when image edit/variation or audio transcription/translation files are larger than the default `1mb`.

### Experimental Video

`POST /v1/videos/generations` is an experimental async preview. It accepts JSON bodies, selects from `nodes[].video_models`, rewrites `model` to the chosen upstream model, and forwards provider-specific fields such as `prompt`, `input_reference`, `duration`, `size`, `aspect_ratio`, `quality`, and `metadata`.

```json
{
  "model": "auto",
  "prompt": "A five second product demo clip",
  "duration": 5,
  "aspect_ratio": "16:9"
}
```

SiftGate stores only `video_jobs` metadata: local request id, provider job id, node, model, Gateway API key/namespace attribution, status, timestamps, expiry, and sanitized error. It does not persist prompts, source images, generated video bytes, raw headers, or provider keys.

`GET /v1/videos/:id` returns local job metadata and refreshes from `video_status_endpoint` when configured. `GET /v1/videos/:id/content` and `POST /v1/videos/:id/cancel` proxy to `video_content_endpoint` and `video_cancel_endpoint` only when the selected node declares those endpoints.

### Batch API Proxy

`POST /v1/batches` proxies OpenAI-compatible Batch API creation. The gateway forwards provider fields such as `input_file_id`, `endpoint`, `completion_window`, and `metadata`, but stores only local metadata: request id, provider batch id, node, model hint, endpoint, file ids, request counts, status, timestamps, sanitized error, and Gateway API key/namespace attribution.

```json
{
  "input_file_id": "file-batch-input",
  "endpoint": "/v1/chat/completions",
  "completion_window": "24h",
  "model": "gpt-4o-mini",
  "metadata": {
    "purpose": "nightly-eval"
  }
}
```

SiftGate never stores batch input JSONL, provider output JSONL, raw headers, provider keys, or metadata values. It stores metadata keys only so operators can identify safe labels without retaining payload content. If a Gateway API key has `allowed_models`, the create request must include a top-level `model` or `x-siftgate-model` hint so SiftGate can enforce the restriction before forwarding.

Node endpoint overrides:

```yaml
nodes:
  - id: openai
    batch_endpoint: /v1/batches
    batch_status_endpoint: /v1/batches/:id
    batch_cancel_endpoint: /v1/batches/:id/cancel
    batch_result_endpoint: /v1/files/:id/content
```

`GET /v1/batches/:id` refreshes status through the configured provider status endpoint and updates local metadata. `POST /v1/batches/:id/cancel` proxies cancellation and updates metadata from the provider response. `GET /v1/batches/:id/output` and `GET /v1/batches/:id/errors` proxy provider file content using `output_file_id` or `error_file_id`; bytes are streamed to the caller and are not persisted locally.

Dashboard metadata is available at `GET /api/dashboard/batches` and the Batch Jobs page. Both surfaces are read-only and metadata-only.

### Experimental Realtime

`WS /v1/realtime` is an experimental preview and is disabled unless `realtime.enabled: true` is set. It is intentionally a pass-through proxy for OpenAI Realtime-style providers:

- Clients connect to `/v1/realtime?model=<realtime-model>` with `Authorization: Bearer <gateway-api-key>`.
- Upstream targets come from `nodes[].realtime_models` and `nodes[].realtime_endpoint`.
- The gateway enforces Gateway API key auth, API key/namespace node-model permissions, global and per-node connection limits, idle timeout, session timeout, and close cleanup.
- The gateway forwards `OpenAI-Beta: realtime=v1` and the provider API key upstream.
- It does not parse, transcode, inspect, persist, or validate audio frames.
- Gateway API keys are not accepted in query strings; browser clients that cannot set headers should connect through a trusted backend.

Connection state summaries are exposed through `/health` and `/api/dashboard/nodes` under each node's `realtime` field. Errors are sanitized and do not include provider keys, Gateway API keys, prompts, responses, raw headers, or audio payloads.

## Health

| Method | Endpoint | Description |
| --- | --- | --- |
| `GET` | `/health` | Gateway health, uptime, node circuit state, realtime connection summary, model circuit state, and budget status |
| `GET` | `/cluster/status` | Redis-backed cluster inventory, heartbeat status, and reload broadcast metadata when `state.backend=redis` or `cluster.enabled=true` |

`/health` is intended for local health checks, Docker checks, and monitoring systems. `/cluster/status` returns `404` in the default single-instance memory mode.

## Dashboard API

Dashboard routes are guarded by the dashboard auth layer by default. Set
`dashboard.auth_required=false` only for trusted local development. In
`NODE_ENV=production`, that setting is ignored unless
`SIFTGATE_ALLOW_UNAUTHENTICATED_DASHBOARD=true` is explicitly set.
Set `dashboard.allow_legacy_token_auth=false` to require the HttpOnly Dashboard
session cookie and reject legacy Dashboard JWTs from `Authorization: Bearer`
and SSE `?token=` query parameters.

| Method | Endpoint | Description |
| --- | --- | --- |
| `POST` | `/api/auth/login` | Exchange the dashboard password for a session JWT and HttpOnly session cookie |
| `POST` | `/api/auth/logout` | Clear the dashboard session cookie |
| `GET` | `/api/auth/status` | Check whether dashboard auth is required |
| `GET` | `/api/dashboard/stats` | Aggregate calls, tokens, cost, latency, success rate, and distributions |
| `GET` | `/api/dashboard/logs` | Paginated call logs |
| `GET` | `/api/dashboard/logs/summary` | Aggregate request, token, cost, success, and cache metrics; `period=today` also returns a zero-filled, privacy-safe `hourly_trend` with 24 local-hour buckets |
| `GET` | `/api/dashboard/logs/export` | Export logs as CSV or JSON |
| `GET` | `/api/dashboard/logs/sse` | Server-Sent Events stream for live call logs and metadata-only request lifecycle updates (`routed`, `streaming`, `completed`, `failed`), including `first_token_latency_ms` and estimated/final `tokens_per_second` when available |
| `GET` | `/api/dashboard/sessions` | Metadata-only session summaries grouped by `session_id` / legacy `session_key` |
| `GET` | `/api/dashboard/sessions/:sessionId` | One session timeline enriched with route decision, shadow result, and guardrails metadata |
| `GET` | `/api/dashboard/route-decisions` | Paginated explainable routing summaries |
| `GET` | `/api/dashboard/route-decisions/:requestId` | Full route decision trace for one request |
| `GET` | `/api/dashboard/analytics/cost` | Cost analytics by day, model, node, and tier |
| `GET` | `/api/dashboard/cost-platform` | Internal chargeback, anomaly, price-source, and feedback summary |
| `GET` | `/api/dashboard/cost-platform/export` | Metadata-only chargeback CSV or JSON export |
| `GET` | `/api/dashboard/intelligence/summary` | Metadata-only cost optimizer, token prediction, async eval, and quality gate summary |
| `GET` | `/api/dashboard/semantic-platform` | Metadata-only Semantic Cache v2, Prompt Registry, context, intent, Guardrails v2, and privacy summary |
| `GET` | `/api/dashboard/semantic-platform/prompt-templates` | List active-workspace prompt template metadata and hashes |
| `POST` | `/api/dashboard/semantic-platform/prompt-templates` | Create a prompt template version for the active workspace |
| `DELETE` | `/api/dashboard/semantic-platform/prompt-templates/:id` | Archive a prompt template version |
| `POST` | `/api/dashboard/semantic-platform/semantic-cache/invalidate` | Invalidate Semantic Cache v2 entries for the active workspace or all workspaces |
| `GET` | `/api/dashboard/analytics/experiment` | Read-only Traffic Experiment analytics from configured routing split variants |
| `POST` | `/api/dashboard/playground/run` | Run an operator-triggered safe Playground probe through the routed Data Plane path |
| `GET` | `/api/dashboard/mcp` | Metadata-only MCP Tool Gateway server registry, tools, recent calls, and error summary |
| `GET` | `/api/dashboard/agent-profiles` | List local Agent Gateway profiles for the Dashboard **Agents** page |
| `POST` | `/api/dashboard/agent-profiles` | Create a local Agent Gateway profile |
| `PUT` | `/api/dashboard/agent-profiles/:id` | Update a local Agent Gateway profile |
| `DELETE` | `/api/dashboard/agent-profiles/:id` | Delete a local Agent Gateway profile |
| `POST` | `/api/dashboard/agent-profiles/:id/render` | Render redacted connector setup cards for a profile |
| `GET` | `/api/dashboard/benchmarks/report` | Read-only local benchmark report from call-log metadata |
| `GET` | `/api/dashboard/budget` | Global, namespace, team, and per-key budget status |
| `GET` | `/api/dashboard/budget/keys` | API keys with budget metadata |
| `POST` | `/api/dashboard/budget/:id/reset` | Reset a budget rule by id |
| `GET` | `/api/dashboard/namespaces` | Local Policy Namespace policies, budget status, counts, and bound API key/team impact summaries |
| `POST` | `/api/dashboard/namespaces` | Create a config-backed Policy Namespace; Admin role required |
| `PUT` | `/api/dashboard/namespaces/:id` | Update a config-backed Policy Namespace; Admin role required |
| `DELETE` | `/api/dashboard/namespaces/:id` | Delete a config-backed Policy Namespace after explicit impact acknowledgement when bound resources exist; Admin role required |
| `GET` | `/api/dashboard/teams` | Local team policies, usage summaries, and OSS-only enterprise markers |
| `GET` | `/api/dashboard/shadow` | Read-only shadow traffic status and sanitized recent results |
| `GET` | `/api/dashboard/shadow/report` | Read-only primary vs shadow comparison report with success, latency, cost, token, fallback, confidence, and risk fields |
| `GET` | `/api/dashboard/shadow/results/:id/comparison` | Single shadow result comparison paired with the primary call log by request id |
| `GET` | `/api/dashboard/alerts` | Local webhook alert channels and recent delivery status |
| `GET` | `/api/dashboard/guardrails` | Privacy-safe guardrails finding summary and webhook delivery status; does not expose prompts, responses, raw headers, provider keys, webhook URL, or webhook headers |
| `GET` | `/api/dashboard/config` | Sanitized local configuration |
| `POST` | `/api/dashboard/config/reload` | Reload `gateway.config.yaml` from disk |
| `GET` | `/api/dashboard/config/versions` | List local sanitized config versions for audit and rollback |
| `GET` | `/api/dashboard/config/versions/:id` | Read one sanitized config version snapshot |
| `POST` | `/api/dashboard/config/versions/:id/rollback` | Validate and restore a previous local config version |
| `GET` | `/api/dashboard/config/audit-events` | List local config audit events |
| `GET` | `/api/dashboard/audit` | List workspace-scoped platform management audit events |
| `GET` | `/api/dashboard/capabilities` | Capability metadata used by routing and Dashboard views |
| `POST` | `/api/dashboard/capabilities/recommend-tiers` | Recommend tier placement for models |
| `GET` | `/api/dashboard/catalog/providers` | Merged Provider Catalog providers, Dashboard provider identity/family/type metadata, compatibility profile registry, enrichment summaries, recommended model defaults, price source status, override metadata, refresh-source availability, and pricing sync status |
| `GET` | `/api/dashboard/catalog/models` | Flattened Provider Catalog models with provider/modality/endpoint filters, enrichment metadata, price source metadata, and pricing sync status |
| `POST` | `/api/dashboard/provider-extensibility/templates/custom/preview` | Preview sanitized custom provider node/catalog metadata without mutating config |
| `POST` | `/api/dashboard/provider-extensibility/sdk/generate` | Generate beta provider adapter skeleton files for manual review |
| `GET` | `/api/dashboard/provider-health` | Workspace-scoped provider/node health, latency, errors, probe/circuit state, and pricing warnings |
| `POST` | `/api/dashboard/routing/recommend` | Recommend routing changes for a request sample |
| `GET` | `/api/dashboard/routing/recommendations` | Read-only adaptive routing recommendations from local sliding-window metrics |
| `PUT` | `/api/dashboard/routing` | Update local routing configuration |
| `GET` | `/api/dashboard/nodes` | Node health, configured models, tags, circuit state, resolved compatibility profiles, realtime summary, and provider compatibility matrix |
| `POST` | `/api/dashboard/nodes/test` | Test an arbitrary node payload before saving |
| `POST` | `/api/dashboard/nodes` | Create a node in local config |
| `PUT` | `/api/dashboard/nodes/:id` | Update a node in local config |
| `DELETE` | `/api/dashboard/nodes/:id` | Delete a node from local config |
| `POST` | `/api/dashboard/nodes/:id/test` | Run safe provider compatibility checks for a configured node |
| `POST` | `/api/dashboard/nodes/:id/reset` | Reset a node circuit breaker |
| `GET` | `/api/dashboard/cache/stats` | Prompt-cache statistics |
| `POST` | `/api/dashboard/cache/clear` | Clear prompt-cache entries |
| `GET` | `/api/dashboard/telemetry-status` | Optional connected-gateway telemetry status |

### Editing provider credential pools

When updating a node through `PUT /api/dashboard/nodes/:id`, a credential row
may omit `api_key` or send a blank value to keep the secret already stored for
that credential ID on the same node. This lets Dashboard users edit models,
weights, or other settings without re-entering a redacted provider key.
An explicit non-blank value replaces the secret. A new credential ID always
requires a non-blank key; otherwise the update returns HTTP 400 before changing
the node. Node creation still requires keys for every supplied credential row.
Keep credential IDs stable when preserving secrets, and never submit a masked
display value as a replacement key.

### Agent Gateway Profiles API

Agent Gateway Profiles are local Dashboard-managed records for coding agents
and chatbot clients. They support Cursor, Cline, Roo Code, Continue, Codex,
Claude Code, OpenCode, Generic OpenAI, Generic Anthropic, Cherry Studio, Hermes,
and OpenClaw connectors. See [Coding Agent Gateway](CODING_AGENT_GATEWAY.md) and
[Agent Gateway Profiles](AGENT_GATEWAY.md) for setup examples.

| Method | Endpoint | Description |
| --- | --- | --- |
| `GET` | `/api/dashboard/agent-profiles` | Returns `{ items, connectors, mode: "local_only" }` with profile summaries |
| `POST` | `/api/dashboard/agent-profiles` | Creates a profile with connector, status, key binding, namespace binding, model, routing hint, and MCP metadata |
| `PUT` | `/api/dashboard/agent-profiles/:id` | Updates a profile and records a redacted config audit event |
| `DELETE` | `/api/dashboard/agent-profiles/:id` | Deletes a profile and records a redacted config audit event |
| `POST` | `/api/dashboard/agent-profiles/:id/render` | Returns redacted OpenAI-compatible or Anthropic-compatible setup cards |

Create/update payloads may include `name`, `description`, `connector`, `status`, `api_key_id`, `namespace_id`, `default_model`, `smart_model_id`, `base_url_mode`, `routing_hint`, `mcp_server_ids`, and `metadata`.

Connector values are `cursor`, `cline`, `roo_code`, `continue`, `codex`,
`claude_code`, `opencode`, `cherry_studio`, `hermes`, `openclaw`,
`generic_openai`, and `generic_anthropic`. Status values are `active` and
`disabled`. Base URL modes are `openai_v1`, `anthropic_v1`, and `root`.

Rendered configs include connector label, base URL, default model, smart model
id, coding virtual model aliases, advisory routing hint metadata, optional MCP
server ids, and setup cards. They use `gateway_api_key.placeholder` plus masked
key metadata; they never return stored Gateway API key plaintext, provider API
keys, raw auth headers, prompts, responses, source code, diffs, tool payloads,
MCP tool payloads, media bytes, or video bytes.

Smart routing through `auto` or profile virtual models requires `allow_auto`.
Direct model routing requires `allow_direct` and still passes allowed
model/node/namespace/policy checks. Profile routing hints are advisory and never
bypass Gateway API key policy. MCP access remains enforced by API key
`allowed_endpoints` such as `mcp`, `mcp:<serverId>`, and
`mcp:<serverId>:<toolName>`.

Session APIs accept optional filters `agent_connector`, `agent_repo`, and
`agent_project`. Coding-agent session metadata is built only from profile data
and allowlisted safe headers such as `x-siftgate-agent-session-id`,
`x-siftgate-agent-turn-id`, `x-siftgate-repo`, and `x-siftgate-project`; raw
headers and repository content are not stored by default.

### MCP Tool Gateway API

MCP Tool Gateway preview is disabled by default and uses local configuration only. It does not implement an enterprise MCP marketplace or hosted tool registry.

| Method | Endpoint | Description |
| --- | --- | --- |
| `POST` | `/mcp/:serverId` | Proxy one JSON-RPC MCP request or batch to a configured upstream MCP server over `http_json_rpc`, `streamable_http`, `sse`, or `stdio` |
| `GET` | `/api/dashboard/mcp` | Read MCP registry, static tool metadata, recent call metadata, and error summaries |

`POST /mcp/:serverId` requires `Authorization: Bearer <gateway-api-key>` and runs through the normal Gateway API key and rate-limit guards. API key endpoint restrictions may allow `mcp`, `mcp:<serverId>`, or `mcp:<serverId>:<toolName>`. If a server declares `allowed_namespaces`, the Gateway API key must be bound to one of those local Policy Namespaces.

Configured MCP servers may use HTTP JSON-RPC POST forwarding, Streamable HTTP with JSON or `text/event-stream` JSON-RPC response collection, legacy HTTP+SSE with an optional `message_url`, or local stdio processes with `command`, optional `args`, `env`, and `cwd`. The external client endpoint remains `POST /mcp/:serverId` for all transports.

The Dashboard API is metadata-only. It returns server id/name, sanitized upstream endpoint without query strings, static tool names/descriptions, recent method/tool/status/latency/size entries, API key id/name, Policy Namespace id, and sanitized error type. Tool input, tool output, raw headers, provider keys, and resolved secret values are never returned or stored by the preview audit buffer.

### Provider Catalog API

`GET /api/dashboard/catalog/providers` and `GET /api/dashboard/catalog/models` return merged built-in + sync cache + local override catalog data. v1.0 built-ins cover 30+ providers, including Bedrock, Qwen, Wenxin, Doubao, Zhipu, Moonshot/Kimi, MiniMax, Hunyuan, Perplexity, NVIDIA NIM, Cerebras, and SambaNova. v1.4 expands the built-in catalog to 50+ providers, adds Dashboard identity/family/type metadata, and adds `compatibility_profiles` to provider rows. In v1.8, those same responses still stay the single public provider catalog surface, but the model truth behind them is normalized around an internal OpenRouter-first canonical registry, a ZeroEval enrichment overlay, and provider projections. The providers response also includes a `compatibility_profiles` registry with profile id, protocol family, request/response style, endpoint/streaming/multipart/async strategies, supported source formats, supported modalities, passthrough fields, downgraded fields, unsupported fields, and known limitations. v1.4 pricing fields include `currency`, `billing_unit`, token/cache/media/rerank/realtime/batch price units, `source_type`, `source`, `source_url`, `retrieved_at`, `last_verified_at`, `last_updated`, optional `last_sync`, `manual_review_required`, `review_reason`, `stale_after_days`, and `pricing_confidence`. Responses also include `refresh_sources`, which tells the Dashboard whether a provider can be refreshed automatically, needs docs review, or requires local operator pricing.

v1.2 adds `sync_status` to these responses. It reports whether scheduled sync is enabled, whether it is actually scheduled, the `write_to` target, cache/override paths, enabled adapters, provider `last_sync`, source URL, confidence, stale state, and recent sync issues. Scheduled sync is disabled by default. In v1.8, OpenRouter remains the primary automatic adapter and now drives the canonical model registry materialization, while ZeroEval remains enrichment-only and does not create provider presets or become a runtime dependency.

v1.4 adds Dashboard UX metadata to provider rows without introducing a second catalog. Fields include `provider_id`, `display_name`, `aliases`, `family`, `category`, `provider_type`, `compatibility_profile`, `logo_id`, `homepage_url`, `docs_url`, `pricing_url`, `input_types`, `output_types`, `model_buckets`, `limits`, and `pricing_units`. These fields power provider-family filters, alias search, Add Node presets, provider detail panels, and consistent logo identity across Catalog, Nodes, Logs, and Route Explanation. They are metadata-only and never include provider keys, raw headers, prompts, responses, media bytes, or generated video bytes.

v1.7 adds model enrichment metadata to model rows and fresh-default metadata to provider rows. v1.8 extends that same API layer with canonical/projection/deprecation visibility. Provider rows can now include `provider_status`, `default_visible`, `replacement_provider_id`, `replacement_note`, `canonical_model_coverage`, `pricing_coverage`, `recommended_model_buckets`, `latest_model_hints`, `recommended_models`, and `enrichment_summary`. v2.8.0-alpha.2 adds response-level `provider_visibility` counts for active catalog rows, transport-only presets, custom presets, deprecated/legacy rows, default-visible rows, hidden-by-default rows, and total presets. Model rows can now include `canonical_id`, `projection_source`, `lifecycle`, `specs`, `benchmarks`, `pricing_sources`, and `match_confidence`. These fields let the Dashboard prefer fresher stable models from canonical projection, keep deprecated or transport-only providers off the default onboarding path, and still preserve the complete model list for manual selection.

Both endpoints also accept `show_legacy=1` when the caller explicitly wants `transport_only`, `deprecated`, or `legacy_alias` providers and their projected model views instead of the default active-only path. The query name is kept for API compatibility; Dashboard copy describes the same control as showing transport-only or hidden presets because transport-only providers can still be configured as nodes.

Dashboard copy calls this **price source status**. The internal response field remains `pricing_hygiene` for backward compatibility.

### Provider Extensibility API

v2.3 adds read-only helper APIs for sustainable provider expansion. They sit
beside the merged Provider Catalog rather than creating a second provider truth.

`POST /api/dashboard/provider-extensibility/templates/custom/preview` accepts a
custom provider template with `provider_id`, `provider_name`, `base_url`,
`protocol`, optional `auth_type`, custom auth header mapping, endpoints, model
ids, compatibility profiles, pricing rows, tags, and optional health probe
settings. It returns:

- `node_preview`: sanitized local node config with `${env:PROVIDER_API_KEY}` as
  the key placeholder.
- `catalog_manifest_preview`: a review-required provider manifest preview.
- `issues`: validation errors, warnings, and manual-review notes.
- `privacy`: metadata-only flags.

`auth_type` may be `bearer`, `x-api-key`, `custom-header`, or `none`.
`custom-header` requires `auth_header_name` and may include
`auth_header_prefix`.

`POST /api/dashboard/provider-extensibility/sdk/generate` accepts the same
template plus `language: "typescript"`. It returns beta skeleton files for an
adapter, manifest, README, and generated unit test. The response is for manual
review; SiftGate does not write generated files to disk or auto-trust them as
runtime adapters.

`GET /api/dashboard/provider-health?period=1h|24h|7d` returns active workspace
provider health summarized from existing metadata: active probe status, circuit
state, calls, errors, error rate, average latency, p95 latency, compatibility
profiles, custom auth header name when applicable, and pricing-source warnings.
The response never includes provider key values.

These endpoints do not expose prompts, responses, raw provider headers,
provider keys, Gateway API key plaintext, media bytes, source code, diffs, tool
payloads, hidden reasoning text, or resolved secrets by default.

### Provider Compatibility Profiles

Node config accepts an optional `compatibility_profile` string or string array. If omitted, SiftGate resolves profiles from the merged Provider Catalog or infers them from protocol, endpoints, model buckets, and base URL.

```json
{
  "id": "local-vllm",
  "protocol": "chat_completions",
  "base_url": "http://localhost:8000",
  "endpoint": "/v1/chat/completions",
  "models": ["local-model"],
  "compatibility_profile": ["local_vllm", "embedding_compatible"]
}
```

Dashboard node create/update DTOs preserve this field. `GET /api/dashboard/nodes` returns both `compatibility_profile` and `resolved_compatibility_profiles` so the UI can distinguish explicit operator overrides from catalog inference.

Validation reports unknown profile ids as errors and warns when the configured provider, endpoint, source format, modality, or model bucket is not supported by the selected profile. Compatibility profile details are read-only evidence; they do not automatically modify routing config.

### Session Trace API

SiftGate normalizes request identity from `x-session-id`, `x-session-key`, `x-siftgate-session-id`, `x-trace-id`, `x-siftgate-trace-id`, standard W3C `traceparent`, and request-id fallback headers. `session_id` is also mirrored into the legacy `session_key` field for backward-compatible Dashboard statistics.

`GET /api/dashboard/sessions` supports `period`, `namespace`, `api_key_id`, legacy `api_key`, `model`, `source_format`, `page`, and `limit` filters. It returns session summaries with first/last seen timestamps, request count, error/fallback count, model switches, cost, token totals, average latency, models, nodes, source formats, trace ids, and latest request metadata.

`GET /api/dashboard/sessions/:sessionId` returns a request timeline for one session. Timeline events are keyed by `request_id` and can include a Route Explanation link, shadow result counts/statuses, and recent guardrails finding metadata when available.

These endpoints are read-only and metadata-only. They do not expose prompt text, response text, raw headers, provider keys, media bytes, or video bytes, and they do not mutate routing configuration.

### Explainable Routing Traces

`GET /api/dashboard/route-decisions` returns paginated summaries and supports `page`, `limit`, `tier`, `node`, `source_format`, `api_key_id`, legacy `api_key`, and `namespace` filters. `GET /api/dashboard/route-decisions/:requestId` returns the full trace for one request.

Each trace includes request id, source format, tier, score, domain and modality hints, candidate targets, filter reasons, cost/latency/context scores, circuit state, fallback chain, cost-downgrade state, final selection, and outcome status.

For multimodal and capability-specific requests, traces may include:

- `modality_evidence.requested_modality`
- `modality_evidence.input_types` / `output_types`
- `modality_evidence.file_count` / `byte_size`
- `modality_evidence.required_capabilities`
- `modality_evidence.endpoint_strategy`
- `modality_evidence.filtered_by_capability`
- `modality_evidence.filtered_by_file_size`
- `candidate_targets[].capability_evidence.supported_modalities`
- `candidate_targets[].capability_evidence.endpoint_status`
- `candidate_targets[].capability_evidence.pricing_source`
- `candidate_targets[].capability_evidence.pricing_confidence`
- `candidate_targets[].capability_evidence.pricing_stale`
- `candidate_targets[].capability_evidence.pricing_used_from`
- `candidate_targets[].capability_evidence.missing_price_units`
- `candidate_targets[].capability_evidence.estimated_cost_basis`
- `candidate_targets[].capability_evidence.catalog_source`

v1.4 adds compatibility evidence to candidate targets:

- `candidate_targets[].compatibility_evidence.provider_id`
- `candidate_targets[].compatibility_evidence.compatibility_profile`
- `candidate_targets[].compatibility_evidence.endpoint_strategy`
- `candidate_targets[].compatibility_evidence.protocol_strategy`
- `candidate_targets[].compatibility_evidence.passthrough_fields`
- `candidate_targets[].compatibility_evidence.downgraded_fields`
- `candidate_targets[].compatibility_evidence.unsupported_fields`
- `candidate_targets[].compatibility_evidence.selected_reason`
- `candidate_targets[].compatibility_evidence.filtered_by_profile_reason`

These fields are counts, sizes, capability labels, and route metadata only. The trace does not store prompt text, response text, uploaded file bytes, raw headers, or provider API keys.

### Config Audit And Rollback

The v0.9 Dashboard API exposes local config version history and audit events. It is backed by SQLite by default and PostgreSQL when configured; it does not require SiftGate Cloud.

`GET /api/dashboard/config/versions` returns version metadata:

```json
{
  "data": [
    {
      "version_id": "cfgv_m...",
      "created_at": "2026-05-04T12:00:00.000Z",
      "created_by": "dashboard:dashboard",
      "source": "dashboard",
      "checksum": "sha256...",
      "node_count": 2,
      "node_ids": ["openai", "anthropic"],
      "route_tiers": ["standard"]
    }
  ],
  "pagination": { "limit": 50, "count": 1 }
}
```

`GET /api/dashboard/config/versions/:id` includes `sanitized_config`. Literal provider keys, dashboard password hashes, raw auth headers, and secret-like fields are redacted; raw provider key values are never returned.

`POST /api/dashboard/config/versions/:id/rollback` accepts an optional reason:

```json
{
  "reason": "Restore last known good routing config"
}
```

Rollback parses and validates the target snapshot first. If validation or secret rehydration fails, SiftGate keeps the current config and returns `400` with a clear message.

`GET /api/dashboard/config/audit-events` supports optional `limit`, `action`, `target`, and `result=success|failure` filters. Events record actor, action, target, before/after summaries, result, failure reason, source, and related version ids.

### Management Audit

v2.0.0-rc.1 adds a platform management audit log for Dashboard operations that
affect local governance, runtime config, workspace membership, invitations,
Gateway API keys, budgets, cache operations, and node control actions.

`GET /api/dashboard/audit` supports optional `limit`, `action`,
`resource_type`, `resource_id`, `actor_id`, and
`result=success|failure|denied` filters. Results are scoped to the active
workspace and include actor id/type, organization/workspace id, action,
resource type/id, redacted before/after summaries, request id, timestamp,
result status, source, metadata, and hash-chain fields.

The management audit log is append-only from the Dashboard perspective.
Dashboard APIs do not expose an edit/delete operation for audit rows. Summaries
are sanitized before storage and response serialization; SiftGate does not log
provider keys, Gateway API key plaintext, prompts, responses, raw provider
headers, media bytes, tool payloads, hidden reasoning text, or resolved secrets
by default.

### Shadow Traffic

The Dashboard Shadow Traffic APIs are read-only. They expose sanitized status,
recent mirrored results, and comparison metadata for the local shadow traffic
feature documented in [Policy Namespaces and Shadow Traffic](NAMESPACES_AND_SHADOW.md).

`GET /api/dashboard/shadow` supports `namespace` and `limit` filters and returns
whether shadow traffic is configured, whether a target node/model is set, and
recent metadata-only mirror results.

### Shadow Comparison Report

`GET /api/dashboard/shadow/report` supports `namespace`, `api_key`, `api_key_id`, `node`, `model`, `period`, and `source_format` filters. Node/model filters match either the primary side or the shadow side.

The report is calculated by pairing `shadow_traffic_results.request_id` with the primary `call_logs.request_id`. It returns `primary_success_rate`, `shadow_success_rate`, `latency_delta_ms`, `p50_latency_comparison`, `p95_latency_comparison`, `cost_delta_usd`, `potential_savings_usd`, `token_delta`, `fallback_delta`, `quality_sample_coverage`, `confidence`, `risk_notes`, and grouped primary-to-shadow pair rows.

`GET /api/dashboard/shadow/results/:id/comparison` returns a single result comparison with primary status, shadow status, deltas, privacy flags, and risk notes. These endpoints are read-only and do not apply routing changes. They do not expose raw headers, provider keys, media bytes, video bytes, or prompt/response samples unless local comparison storage was explicitly enabled; stored samples are redacted and truncated before persistence and response.

### Benchmark Report

`GET /api/dashboard/benchmarks/report` summarizes local gateway behavior from `call_logs`. It supports `period`, `namespace`, `api_key_id`, legacy `api_key`, `node`, `model`, `source_format`, and `limit` filters.

The report includes total requests, success/error/fallback/cache rates, p50/p75/p95/p99 latency, throughput estimates, cost and token summaries, status-code distribution, `node:model` breakdown, source-format breakdown, source-family breakdown for chat/responses/messages/embeddings/rerank/images/audio/video/realtime, route-trace coverage, and `cache_summary` fields for local prompt-cache hits, provider cache-read hits, provider cache-write events, cache-aware request rate, and cache-read token ratio.

This endpoint is read-only and never applies routing changes. It does not store or return prompts, responses, raw headers, provider keys, media bytes, or video bytes. Treat it as local operational evidence; fair comparisons still require identical machine, upstream latency, request body, concurrency, config, and commit.

Route Decision Trace responses may include `cache_evidence` on the trace and on each candidate target. Cache evidence records only metadata such as local prompt-cache lookup state, provider cache capability, observed provider cache-read hit rate, cache read/write token counters, cache-adjusted estimated cost, estimated savings, and v1.3 semantic cache match state.

v2.2 route decision traces may also include top-level `intelligence` evidence:

- `token_prediction` records estimated input/output/context tokens, estimated
  cost, budget scope/headroom, risk, and configured action.
- `optimizer` records objective, evidence-only or optimize mode, whether a
  route change was applied, and candidate metadata such as estimated cost,
  latency, success, quality, cache probability, and rejection reasons.
- `quality_gate` records enabled mode, final status, matched rule ids, selected
  action, failure reasons, and streaming retry/fallback safety state.
- `async_eval` records metadata queue status, sample rate, dimensions, and job
  id.

These fields are metadata-only. They do not include prompt text, response text,
tool payloads, raw headers, provider keys, source code, diffs, media bytes, or
hidden reasoning text.

### Intelligence Summary

`GET /api/dashboard/intelligence/summary` supports `period`, `api_key`,
`api_key_id`, and `namespace` filters. It returns total requests, optimizer
application rate, estimated savings, async eval queue count, token-risk counts,
quality-gate status counts, and grouped summaries by agent and node.

The endpoint reads `call_logs` metadata only. It is read-only and never applies
routing changes, eval jobs, retries, fallbacks, or alerts by itself.

### Traffic Experiments

`GET /api/dashboard/analytics/experiment` reads `routing.tiers.*.split`
configuration and call-log experiment metadata. The Dashboard setup panel shows
a copyable split YAML example and reports whether active split variants exist.

Traffic Experiments are live split analytics: configured variants receive real
primary traffic according to their weights. This is separate from Eval Reports
controlled primary/candidate/judge runs and from Shadow Traffic asynchronous
mirroring. The endpoint is read-only and does not auto-promote winners, update
weights, or edit routing config.

### Semantic Cache Preview

`semantic_cache` is disabled by default. v2.7 keeps the local memory
hashed-vector backend as the production-safe default and records only
similarity metadata unless replayable response storage is explicitly enabled.

```yaml
semantic_cache:
  enabled: false
  backend: memory
  similarity_threshold: 0.92
  ttl_seconds: 3600
  max_entries: 500
  store_responses: false
  isolation: workspace_api_key_model
  response_storage_requires_header: true
```

When `store_responses: false`, a semantic match is evidence only and the
gateway still calls upstream. When `store_responses: true`, a high-confidence
match can return a cached response and call logs include
`semantic_cache_hit=true` with `node_id=semantic_cache`. By default, response
storage also requires `x-siftgate-semantic-store-response: true` on the request.
The cache is isolated by workspace, source format, requested model, Gateway API
key, Policy Namespace, and local team metadata.

### Semantic Controls

`GET /api/dashboard/semantic-platform` supports `period` and returns
workspace-scoped semantic cache stats, prompt template summaries, context
optimizer action counts, intent category counts, Guardrails v2 finding counts,
and an explicit privacy block.

Prompt Registry endpoints store template hashes and metadata by default.
Template body storage requires
`semantic_platform.prompt_registry.store_template_content=true`. Requests can
bind a route trace to a template with `x-siftgate-prompt-key` and optional
`x-siftgate-prompt-version`. The resulting `semantic_platform.prompt_registry`
trace evidence includes key, version, template hash, variables, route policy,
and A/B metadata, not rendered prompt content.

Route Decision Trace responses may include top-level `semantic_platform`
evidence with:

- `intent`: category, confidence, signals, and advisory route hints
- `context_optimizer`: token estimate, context ratio, strategy, action, and mutation state
- `prompt_registry`: prompt key, version, hash, variables, route policy, and A/B metadata
- `guardrails_v2`: metadata-only finding counts and policy shape

These fields are metadata-only. They do not include prompt text, response text,
tool payloads, raw headers, provider keys, source code, diffs, media bytes,
hidden reasoning text, or resolved secrets.

The Dashboard setup panel mirrors the safe config shape for
`semantic_cache` and `semantic_platform`. It keeps response storage,
template-body storage, content mutation, and Guardrails blocking visibly
opt-in rather than enabling those behaviors from the browser.

The API route keeps `/api/dashboard/semantic-platform` for compatibility, while
Dashboard and docs use the product label **Semantic Controls**.

### Evaluation Reports

The v1.3 Evaluation Framework preview stores local experiment metadata for primary-vs-candidate comparisons. LLM-as-judge calls are ordinary SiftGate requests through the normal routing pipeline; no hosted enterprise service is required.

| Method | Endpoint | Description |
| --- | --- | --- |
| `GET` | `/api/dashboard/evals/reports` | List metadata-only evaluation reports |
| `GET` | `/api/dashboard/evals/reports/:id` | Get one report with sample-level request ids and judge scores |
| `POST` | `/api/dashboard/evals/runs` | Run a local primary-vs-candidate experiment through SiftGate routing |

`GET /api/dashboard/evals/reports` supports `period`, `status`, `dataset_id`, and `limit`. Responses include totals, primary and candidate success/latency/cost/fallback metrics, average judge score, winner, and privacy flags.

`GET /api/dashboard/evals/reports/:id` adds per-sample metadata: sample hash, optional sample id, primary/candidate/judge request ids, status codes, latency, cost, fallback flags, judge score, judge label, sanitized reason summary, sanitized error type, and sanitized metadata.

`POST /api/dashboard/evals/runs` is intended for local automation. The Dashboard page remains read-only. A run body contains dataset metadata, primary target, candidate target, optional judge config, samples, and optional `store_samples`. Prompt/response sample previews are persisted only when both `evaluation.store_samples: true` and request `store_samples: true` are set; previews are redacted and truncated. By default, evaluation tables do not store prompt text, response text, raw headers, provider keys, media bytes, video bytes, or rubric text.

The Dashboard setup panel keeps Eval Reports separate from Traffic Experiments
and Shadow Traffic. Evals are controlled comparison runs; the report endpoints
do not create live traffic splits, mirror production traffic, promote winners,
or update routing config.

### Dashboard Playground

`POST /api/dashboard/playground/run` is a Dashboard-session protected operator tool for safe interactive probes. It supports:

- `endpoint`: `chat_completions`, `responses`, `messages`, `embeddings`, `rerank`, `images`, `audio`, `video`, or `realtime`
- `operation`: media/video/realtime operation such as `image_generation`, `audio_speech`, `video_generation`, or `realtime_probe`
- `api_key_id`, `namespace_id`, `model`, `stream`, `routing_hint`, and an optional JSON `body`

The backend applies the selected Gateway API key context by id, so the Dashboard does not need or receive the plaintext key. The response includes request preview, response summary, usage, cost, latency, status, and a Route Decision link when normal call-log metadata produced one.

Realtime is a probe-only check and does not open a WebSocket. Playground previews are returned only to the current Dashboard request. The endpoint does not persist prompt bodies, response bodies, raw headers, provider keys, media bytes, video bytes, or realtime frames beyond normal privacy-safe call-log metadata.

### Provider Compatibility Matrix

`GET /api/dashboard/nodes` includes `compatibility_matrix` for every node. Each row contains `capability`, `configured`, `profile_supported`, `compatibility_profiles`, `tested`, `last_status`, `last_checked_at`, `failure_reason`, `latency_ms`, `status_code`, `test_mode`, and `requires_confirmation`.

`POST /api/dashboard/nodes/:id/test` accepts an optional body:

```json
{
  "capabilities": ["chat", "embeddings", "images", "video", "realtime"],
  "confirm_expensive": false
}
```

Supported capabilities are `chat`, `responses`, `messages`, `embeddings`, `rerank`, `images`, `audio`, `video`, `realtime`, and `batch`. Text, embedding, and rerank checks send tiny synthetic requests. Media, video, realtime, and batch checks default to endpoint/auth probes; video/realtime generation or long-lived sessions are not started unless a future explicit confirmation flow enables it. Results are local metadata only and never include prompt text, response bodies, raw headers, provider API keys, media bytes, video bytes, or realtime frames.

## Gateway API Key Management

| Method | Endpoint | Description |
| --- | --- | --- |
| `GET` | `/api/dashboard/api-keys` | List Dashboard-managed Gateway API keys with masked prefix and per-key usage summary |
| `POST` | `/api/dashboard/api-keys` | Create a Gateway API key and return the plain key once |
| `PUT` | `/api/dashboard/api-keys/:id` | Update key name, status, namespace binding, permissions, budgets, or rate limits |
| `POST` | `/api/dashboard/api-keys/:id/rotate` | Rotate the Gateway API key secret and return the new plain key once |
| `DELETE` | `/api/dashboard/api-keys/:id` | Delete a Gateway API key |
| `GET` | `/api/dashboard/teams` | List local teams with permissions, usage, budgets, and rate limits |
| `POST` | `/api/dashboard/teams` | Create a local team policy |
| `PUT` | `/api/dashboard/teams/:id` | Update team name, status, namespace binding, permissions, budgets, or rate limits |
| `DELETE` | `/api/dashboard/teams/:id` | Delete a local team policy and disable team budget rules |

Create and update payloads support `allowed_nodes`, `allowed_models`, `allowed_endpoints`, `allowed_modalities`, `namespace_id`, `team_id`, `daily_token_limit`, `daily_cost_limit`, and `rate_limit_per_minute`. Empty permission arrays mean "all configured" for that dimension; team and namespace restrictions still intersect with the key's own restrictions.

List responses include `status`, `last_used_at`, `key_prefix`, and a `today` summary with calls, cost, tokens, errors, and `error_rate`. OpenAPI examples redact plain Gateway API key values. Runtime create and rotate responses still return the plain key once so the operator can copy it into client configuration; after that, Dashboard APIs only return the masked prefix. Mutating API key operations write local config audit events with redacted summaries and never store the one-time secret.

Local teams are OSS-only shared policy groups. They persist locally in SQLite/PostgreSQL, can be disabled, and can define namespace binding, allowed endpoints/modalities/nodes/models, daily token/cost budgets, and RPM limits. Bound keys fail closed when their team is disabled. SiftGate checks global, namespace, team, and key budgets and records `team_id` in call logs for usage summaries. Team APIs never return secrets and do not implement SSO, SCIM, enterprise workspaces, or org billing.

## Budget Scope Settings

`GET /api/dashboard/budget` accepts optional `namespace`, `team_id`,
`api_key`, or `api_key_id` query parameters. Responses remain backward
compatible with `rules` for global rules and now include explanatory metadata:
`selectedScope`, `scopeChain`, `sourceOfTruth`, `editableVia`,
`alertThreshold`, `dailyResetAt`, and `blockingOrder`. Selected namespace,
team, and key views return `namespaceRules`, `teamRules`, or `perKeyRules`
respectively. Empty selected-scope rule arrays mean the scope is inherited
rather than a missing runtime feature.

Budget sources are intentionally separate:

| Scope | Source of truth | Dashboard edit path |
| --- | --- | --- |
| Global | `budget` in `gateway.config.yaml` | Config file + reload |
| Policy Namespace | `namespaces[].budget` | Policy Namespace update API |
| Team | local Team policy columns | Team update API |
| API Key | Dashboard-managed Gateway API key policy columns | API Key update API |

SiftGate enforcement order is unchanged: global budgets are checked first,
then Policy Namespace, then Team, then API Key. Manual reset still uses
`POST /api/dashboard/budget/:id/reset` and only resets the selected budget rule
counter; it does not alter configured limits or daily reset semantics.

## Policy Namespace Management

Policy Namespace management is local and config-backed. The Dashboard APIs
support `id`, `name`, `allowed_nodes`, `allowed_models`, `budget`, and
`rate_limit` fields under the existing `namespaces` config section. They do not
create tenants, Workspaces, org billing scopes, SSO identities, or secrets.

`GET /api/dashboard/namespaces` returns each namespace with budget status,
binding summaries for Dashboard-managed API keys, YAML-defined API keys, and
local Teams, plus counts for total namespaces, budgeted namespaces, rate-limited
namespaces, bound keys, and bound Teams.

Create, update, and delete operations require Dashboard Admin access. SiftGate
rewrites only the `namespaces` section, validates the full candidate gateway
config, records a config audit event, and reloads through the rollback-safe
config path. If a delete would affect bound API keys or Teams, the first request
returns conflict with impact details; the caller must resubmit with
`confirm_impact: true`. Backend config validation still controls whether the
result is persisted.

## Secret Handling In The Spec

The OpenAPI schema is intentionally secret-safe:

- Provider API key inputs are marked `writeOnly` and use placeholder examples such as `${OPENAI_API_KEY}`.
- Sanitized config responses mark node `api_key` as `readOnly` and describe it as masked.
- Dashboard password input is marked `writeOnly`.
- Dashboard password hashes and raw provider keys are not part of documented response DTOs.
- Connected-gateway configuration remains optional and must not require private Cloud packages.


## Customer lifecycle endpoints (unreleased development branch)

Use the API documentation shipped with the selected release. These endpoints do not authorize an upgrade.

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/api/auth/identity/activate` | Consume a host-issued one-time code and set the managed administrator password |
| POST | `/api/auth/identity/recover` | Consume a host-issued recovery code; invalidate prior managed sessions |
| POST | `/api/auth/identity/password` | Reauthenticate and change the managed password; gateway keys remain unchanged |
| GET | `/api/dashboard/launchpad` | Read workspace-scoped setup observations and configuration fingerprints |
| POST | `/api/dashboard/launchpad/keys` | Administrator-only bounded single-node/model text key creation |
| POST | `/api/dashboard/launchpad/prepare-test` | Record explicit cost consent and verify the selected key; no provider dispatch |
| GET | `/api/dashboard/launchpad/attempts/:id` | Reconstruct scoped evidence from persisted call metadata; no request retry |

Managed identity is explicitly enabled by the matching installer and is not automatically applied to existing password/OIDC deployments. Codes and passwords are write-only. Launchpad preparation requires the current configuration digest, timezone acknowledgement, pricing review, explicit cost consent, selected key ID and that key's actual secret; the secret is compared but never persisted in the receipt. The real test uses `/v1/chat/completions`, not privileged Dashboard proxy access. See the customer identity and Launchpad guides for limits and failure states.


## Release update notices (post-v2.12.0 source)

These endpoints observe public release metadata; none can pull an image, install
an artifact, approve an upgrade, change provider configuration or restart a gateway.

| Endpoint | Access | Effect |
| --- | --- | --- |
| `GET /api/dashboard/release-updates` | Dashboard viewer | Cached state only; no external request |
| `POST /api/dashboard/release-updates/check` | Dashboard admin + same-origin | One bounded public-metadata check, with shared cooldown/backoff |
| `PUT /api/dashboard/release-updates/preferences` | Dashboard admin + same-origin | Save `enabled`, `interval_hours` (6/12/24), `notify_connectors` |

Responses always have `automatic_install:false` and `publisher_verified:false`.
`last_attempt_at`, `last_success_at`, `next_check_at` and `retry_after` are nullable
UTC epoch milliseconds. Status distinguishes not-checked, checking, available,
current (no higher version number found), no-release, unknown-version, disabled,
error and stale. A failed check retains historical metadata but cannot report a
fresh success. Host `SIFTGATE_RELEASE_UPDATES_DISABLED=1` overrides dashboard opt-in.
See [release notice policy](release-updates.md) for persistence and privacy.

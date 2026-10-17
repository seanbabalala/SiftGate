# Architecture

SiftGate has two layers:

- Customer Data Plane: the open-source gateway that handles real AI requests in the customer's infrastructure.
- Cloud Control Plane: the future hosted product for fleet policy, telemetry analytics, audit, and router recommendations.

The data plane is complete on its own. The cloud layer is optional and disabled by default.

## System Model

```text
User App
  -> Customer SiftGate Data Plane
  -> OpenAI / Anthropic / Google / Local / Custom Provider

Customer SiftGate Data Plane
  -> heartbeat / telemetry metadata / audit summary
  -> Cloud Control Plane

Cloud Control Plane
  -> policy bundle / router recommendation / emergency control
  -> Customer SiftGate Data Plane
```

Default guarantees:

- AI requests do not pass through the cloud control plane.
- Prompts and responses stay in the customer data plane.
- Provider API keys stay in the customer data plane.
- The gateway initiates outbound cloud connections when connected mode is enabled.
- Customers do not need to expose inbound ports for control-plane access.

## Data Plane Request Flow

```text
Client Request
  -> Controller
  -> Normalizer
  -> API Key Guard
  -> Local Policy Namespace
  -> Budget Check
  -> Prompt Cache Lookup
  -> Scoring
  -> Compatibility Profile Filter
  -> Router
  -> Optional Intelligence Loop Preflight
  -> Provider Client
  -> Optional Quality Gate
  -> Denormalizer
  -> Call Log
  -> Optional Shadow Traffic Mirror
  -> Optional External Log Sinks
  -> Optional Control-Plane Metadata Upload
```

### Controllers

The gateway accepts the major AI API shapes supported by the open-source Data Plane:

- `POST /v1/chat/completions`
- `POST /v1/responses`
- `POST /v1/messages`
- `POST /v1/embeddings`
- `POST /v1/rerank`
- `POST /v1/images/generations`
- `POST /v1/images/edits`
- `POST /v1/images/variations`
- `POST /v1/audio/transcriptions`
- `POST /v1/audio/translations`
- `POST /v1/audio/speech`
- `POST /v1/videos/generations`
- `GET /v1/videos/:id`
- `GET /v1/videos/:id/content`
- `POST /v1/videos/:id/cancel`
- `WS /v1/realtime` when the experimental realtime preview is enabled

Each controller normalizes inbound requests into the canonical internal format before routing.

### Canonical Format

The canonical format lets the gateway translate between provider protocols without making the rest of the pipeline care about the original wire shape.

Normalizers convert client input into canonical requests. Denormalizers convert canonical responses or stream events back into the caller's requested protocol.

v0.6 adds canonical structured-output fields so the pipeline preserves OpenAI Chat `response_format`, OpenAI Responses `text.format`, and Anthropic Messages `output_config.format` intent across routing. Provider forwarding records whether the target received a native passthrough, a safe native mapping, or an explicit downgrade/unsupported strategy.

v1.0 extends the same canonical layer for reasoning controls. Normalizers preserve OpenAI Chat `reasoning_effort`, OpenAI Responses `reasoning`, Anthropic Messages `thinking`, and Gemini-style `thinking_config` intent as metadata-safe fields: requested status, effort, source, budget token count, and raw provider-specific shape. Denormalizers only emit a cross-protocol value when the mapping is safe; otherwise the provider call is marked downgraded or unsupported for logs and route explanations without storing prompts, responses, hidden reasoning text, raw headers, or provider keys.

v2.12.6 distinguishes Chat/OpenRouter reasoning from Responses reasoning and
recognizes nested Google thinking controls. A node's `chat_reasoning_format`
selects the outgoing Chat dialect after drops and semantic default merging.
Official host detection is conservative; private proxies opt in explicitly.
Known level-based Gemini models use levels, while legacy native budget mappings
remain unchanged. Canonical request state is not mutated between fallback attempts.

### Authentication And Governance

Gateway API keys are generated in the Dashboard and used by client applications. Provider API keys are configured on upstream nodes and used only by the gateway.

Gateway API keys can carry:

- automatic routing permission
- direct model routing permission
- allowed nodes
- allowed models
- allowed endpoint families such as `responses`, `embeddings`, `images`, `audio`, `video`, `realtime`, and `models`
- allowed modalities such as `text`, `vision`, `embedding`, `rerank`, `image`, `audio`, and `video`
- per-key budgets
- per-key rate limits
- optional local namespace binding
- optional local team binding

Local teams are open-source data-plane policy groups stored in SQLite/PostgreSQL. They can define namespace binding, allowed nodes/models/endpoints/modalities, daily token/cost budgets, and rate limits for multiple Dashboard-generated Gateway API keys. A disabled team makes bound keys fail closed. Teams intentionally do not implement enterprise SSO, SCIM, organization billing, Cloud workspaces, or workspace RBAC.

Local namespaces are open-source data-plane policy labels. They can restrict allowed nodes/models and add namespace budgets/rate limits, but they are not Cloud workspaces and do not include enterprise SSO, SCIM, organization billing, or workspace RBAC. Key, team, and namespace restrictions are intersected before routing. The effective rate limit is the strictest configured key/team/namespace limit. Budget checks run across global, namespace, team, and key scopes before a request reaches an upstream provider.

Budget ownership is deliberately explicit. Global daily token/cost limits come
from `gateway.config.yaml`; namespace budgets come from config-backed Policy
Namespaces; team budgets come from local Team policy rows; API Key budgets come
from Dashboard-managed Gateway API key rows. If a namespace, team, or key has no
direct budget rule, the request still inherits earlier scope checks in the same
enforcement order. Manual resets zero counters only and do not change configured
limits.

Dashboard API key list responses expose only `key_prefix`, status, team/namespace labels, usage summary, and permission metadata. The full key is returned once on create or rotate, then discarded. API key and team mutations write local config audit events with redacted before/after summaries, including `secret: redacted` for keys and no secret-bearing fields for teams.

### Routing

Routing targets a `node + model` pair.

For direct model requests, the gateway resolves model names in this order:

1. Exact model id
2. Alias
3. Node id shortcut
4. Node prefix
5. Model-family prefix
6. Unknown model fallback to automatic routing, unless key permissions require rejection

For automatic routing, the scoring engine evaluates request complexity across 14 dimensions and maps the request into:

- simple
- standard
- complex
- reasoning

The router then applies tier config, domain preferences, modality compatibility, Provider Compatibility Profile support, reasoning-support preference, cache-aware cost evidence, circuit breaker state, momentum, load-balancing strategy, fallbacks, and A/B split rules. Tiers can use legacy `primary/fallbacks` or the v0.2 `targets + strategy` schema; `split` keeps experiment precedence when configured.

Dashboard Traffic Experiments are a read-only projection of those `split`
rules and the call-log metadata they produce. They do not choose winners,
rewrite weights, or promote variants automatically.

v1.4 Provider Compatibility Profiles add a local metadata filter between coarse capability checks and provider forwarding. A profile describes protocol family, request/response style, endpoint strategy, streaming behavior, multipart behavior, async-job behavior, supported source formats, supported modalities, passthrough fields, downgraded fields, unsupported fields, and known limitations. Routing rejects or records downgrade evidence when a candidate cannot safely handle the requested source format, modality, streaming mode, multipart media body, video async job, or batch endpoint. Profiles are inferred from the Provider Catalog or explicit `nodes[].compatibility_profile`, and no provider network call is made during routing.

v1.2 prompt-cache-aware routing keeps the existing local prompt-cache short-circuit intact. A local cache hit returns before upstream routing. For cache misses, `cost` and `balanced` optimization can consider provider prompt-cache/read-cache/write-cache capability, configured `cache_read_input` / `cache_creation_input` prices, and observed provider cache-read hit rate. Route traces expose only metadata evidence and never include prompt text, responses, raw headers, provider keys, or media/video bytes.

v1.4 pricing source governance normalizes explicit config, catalog overrides, sync cache, and built-in catalog entries into one resolver. Cost and balanced routing, Route Decision Trace, Benchmark reports, Dashboard Provider Catalog, and config validation all use the same priority order: explicit node/model pricing, `models_pricing`, `catalog.override.yaml`, local sync cache, then built-in catalog. Route traces record only pricing evidence such as source, confidence, stale status, used-from layer, missing price units, and estimated cost basis.

v1.3 adds Semantic Cache preview as a separate disabled-by-default layer. It computes a local hashed-vector embedding from canonical request text, stores embedding/hash/metadata by default, and records semantic match evidence in call logs and Route Decision Trace. Replayable response storage is off unless `semantic_cache.store_responses=true`; when off, semantic matches are advisory evidence and traffic still goes upstream.

v2.7 promotes the semantic layer into Semantic Controls. Semantic Cache v2
keeps `memory` as the production-safe default backend while validating preview
Redis/vector backend settings, isolates matches by workspace/API key/model by
default, and requires a per-request storage header before replayable responses
are retained when response storage is enabled. Prompt Registry adds
workspace-scoped template versions and route-policy/A-B metadata while storing
template hashes by default. Context Window Optimizer records token estimates,
context ratios, and trim/summarize suggestions without mutating prompt content
in v2.7. Intent Classification adds advisory task categories such as coding,
security, reasoning, and analysis. Guardrails v2 records metadata-only input
and output findings for PII, toxicity, and jailbreak signals.

v2.2 adds the optional Intelligence Loop after normal route resolution and
before the upstream call. Token Prediction estimates input/output/context token
risk and cost risk against the active budget policy. The Cost Optimizer scores
the selected target and fallbacks with model price, budget headroom, latency,
cache probability, observed success/quality metadata, and coding/task intent.
By default it records evidence only; route changes require explicit
`intelligence.cost_optimizer.action=optimize`. Quality-critical coding and
reasoning requests are not downgraded unless the operator explicitly allows it.

After non-streaming upstream responses, the optional Quality Gate can evaluate
metadata-safe checks such as empty text, minimum output tokens, stop reason,
latency, tier, source format, and coding virtual model. It may retry or fallback
only before response bytes are sent. Streaming requests record
`streaming_no_post_start_retry` and never retry or fallback after bytes have
started. Async Eval v1 queues metadata only by default.

v2.6 adds a Cost And Chargeback Platform on top of existing call logs, route
decision traces, provider catalog pricing governance, alerting, and optional
feedback metadata. It does not sit in the critical request path except for the
lightweight `POST /v1/feedback` metadata endpoint. Chargeback reports, anomaly
detection, price-source summaries, and feedback aggregation are Dashboard/API
read paths over workspace-scoped metadata. Payments, recharge balances,
reseller ledgers, public marketplaces, prompt/response storage, raw-header
storage, provider-key exposure, and automatic price trust remain out of scope.

### Reliability

The data plane protects request flow with:

- retry with backoff
- provider fallback chains and optional v0.3 fallback policies for 429, timeout, structured-output validation, and cost downgrade
- model-level circuit breakers
- prompt cache
- optional Redis shared state backend for circuit breakers, rate limits, prompt cache, and routing momentum
- optional v2.2 Intelligence Loop for evidence-only cost optimization, token prediction, async eval metadata, and opt-in quality gates
- optional MCP Tool Gateway preview for local MCP server proxying behind Gateway API key auth, Policy Namespace allow-lists, and the same rate limiter
- graceful shutdown
- body size limits
- dashboard health and node status

### Observability

The gateway records call logs with:

- request id
- session id / legacy session key
- trace id from direct trace headers or W3C `traceparent`
- Gateway API key id and name
- namespace id
- team id
- source protocol
- selected tier
- upstream node and model
- token usage
- estimated cost
- latency
- status code
- fallback status and fallback reason
- structured-output requested status, type, strategy, support flag, and schema name
- reasoning requested status, effort, forwarding strategy, support flag, budget token count, source, and sanitized downgrade reason
- retry count
- cache token fields
- cache-aware route evidence: local prompt-cache lookup status, provider cache capability, observed provider cache-read hit rate, cache-adjusted estimated cost, and estimated savings
- experiment group
- Intelligence Loop metadata: optimizer applied flag, estimated cost/savings,
  token prediction risk, quality gate status, and async eval queued flag

These logs power Dashboard pages, SSE updates, analytics, budgets, local webhook alert spike detection, namespace filters, and optional connected-gateway metadata upload.
v2.6 also uses them for internal chargeback reports and cost anomaly detection.
The new `route_feedback` table stores request id, workspace, key/team labels,
thumbs value, reason code, and route-weight evidence only.

The v1.1 Session View does not add content storage. It correlates existing metadata by `request_id`, `session_id`, and `trace_id`: `call_logs` provide the timeline backbone, `route_decisions` attach explainable-routing evidence, `shadow_traffic_results` attach asynchronous mirror outcomes, benchmark reports reuse the same log metrics, and the guardrails plugin can contribute recent in-memory finding metadata. Prompt text, response text, raw headers, provider keys, uploaded media, and video bytes stay out of this correlation layer.

The v0.9 Benchmark Report API reads the same sanitized `call_logs` table and
does not introduce another metrics store. It computes local operational
evidence for the Dashboard: request totals, success/error/fallback/cache rates,
latency percentiles, throughput estimates, cost/token summaries, status-code
distribution, `node:model` breakdowns, and source-format/source-family
breakdowns across chat, responses, messages, embeddings, rerank, images, audio,
video, realtime, and batch. When matching `route_decisions` rows exist, the report also
shows trace coverage so operators can see whether performance samples have
explainable-routing evidence.

Benchmark reports are read-only. They never mutate routing config and never
store or expose prompts, responses, raw headers, provider keys, media bytes, or
video bytes.

For explainable routing, the pipeline also writes a separate `route_decisions` row keyed by `request_id`. This trace records the routing evidence that led to the final `node:model`: source format, tier, score, domain and modality hints, structured-output, reasoning, and compatibility constraints, candidate targets, filter reasons, cost/latency/context scores, circuit state, fallback chain, cost downgrade, final selection, and outcome.

Multimodal requests add a privacy-safe evidence layer to the same trace. The top-level `modality_evidence` block records the requested modality, input/output type shape, file count, byte size, required capabilities, endpoint strategy, and which targets were filtered by capability or file-size limits. Each candidate target adds `capability_evidence` with supported modalities, matched/missing capabilities, endpoint status, max file size, pricing source, and catalog source. This gives Dashboard Route Explanation enough context to explain image/audio/video/rerank/embedding decisions without storing prompt text, response text, uploaded file bytes, raw headers, or provider keys.

v1.4 adds `compatibility_evidence` to candidate targets. It records provider id, compatibility profile ids, endpoint/protocol strategy, passthrough fields, downgraded fields, unsupported fields, selected reason, and profile filter reason. It is designed for Dashboard Route Explanation and Logs detail, not for content capture; prompts, responses, raw headers, provider keys, media bytes, and video bytes remain excluded.

v2.2 adds top-level `intelligence` evidence to route traces. It records token
prediction estimates and budget risk, optimizer candidate scores/rejection
reasons, quality gate events/actions, and async eval queue metadata. The trace
does not store prompt text, response text, raw headers, provider keys, source
code, diffs, tool payloads, media bytes, video bytes, or hidden reasoning text.

v2.7 adds top-level `semantic_platform` evidence to route traces. It records
intent classification, context-window optimizer evidence, Prompt Registry
binding metadata, and Guardrails v2 findings. The trace remains metadata-only:
prompt text, response text, template body content, matched finding text, raw
headers, provider keys, source code, diffs, tool payloads, media bytes, hidden
reasoning text, and resolved secrets are excluded by default.

The Dashboard setup surface for Semantic Controls mirrors this architecture:
operators can see whether `semantic_platform` and `semantic_cache` are enabled,
copy a metadata-only YAML baseline, and verify that response replay, template
body storage, content mutation, and blocking behavior remain explicit opt-ins.

The experimental v0.8 video preview uses an async job model. `POST /v1/videos/generations` is routed through the normal media pipeline, then writes a `video_jobs` row containing only request id, provider job id, node, model, Gateway API key/namespace attribution, status, timestamps, expiry, and sanitized error text. Status/content/cancel routes look up that local metadata, enforce the creating key/namespace boundary, and proxy to provider endpoints only when the node explicitly declares them. Prompts, source media, generated video bytes, raw headers, and provider keys are not persisted.

## MCP Tool Gateway

The MCP Tool Gateway is a small sidecar path beside the AI protocol pipeline. `McpGatewayController` exposes `POST /mcp/:serverId`, reusing `ApiKeyGuard` and `RateLimitGuard`. `McpGatewayService` resolves the local `mcp.servers` registry, checks API key endpoint permissions and Policy Namespace allow-lists, resolves configured upstream headers through `SecretReferenceResolverService`, and forwards the JSON-RPC body through the configured upstream transport: `http_json_rpc`, `streamable_http`, `sse`, or `stdio`.

HTTP JSON-RPC uses direct POST forwarding, Streamable HTTP collects either JSON or `text/event-stream` JSON-RPC responses, legacy SSE uses an SSE endpoint plus optional `message_url`, and stdio launches the configured local MCP process for the proxied call with `command`, optional `args`, `env`, and `cwd`. The preview does not implement an enterprise MCP marketplace, remote workspace registry, long-running process supervisor, or Cloud dependency. Dashboard reads `GET /api/dashboard/mcp` for local registry metadata, static tool names, recent call metadata, and error summaries. The local audit buffer is metadata-only: server, method, tool name, API key id/name, namespace, status, latency, byte size, and sanitized error type. MCP tool input/output, raw headers, provider keys, resolved secret values, media bytes, and marketplace content are not stored.

The MCP Tool Gateway is intentionally a tool-call proxy and governance path,
not part of model routing. Model routing still lives in the main pipeline, node
config, Gateway API key policy, and Policy Namespace restrictions.

## Agent Platform Preview

The v2.5 Agent Platform preview is a read-only Dashboard control-plane module
layered over Agent Profiles, Gateway API key summaries, MCP Tool Gateway metadata,
and call-log agent metadata. `AgentPlatformService` returns the
`GET /api/dashboard/agent-platform` response for A2A registry rows, Tool
Registry permission evidence, preview workflow metadata, Conversation Memory
Gateway counters, recent trace spans, and the privacy contract.

Runtime policy stays in the existing data plane. Agent calls still enter through
Gateway API keys and `/v1/*` compatible endpoints; MCP calls still enter through
`POST /mcp/:serverId` and the MCP guards. The preview does not run a workflow
engine, execute tools from the browser, or store prompts, responses, source
code, diffs, tool payloads, raw headers, provider keys, media bytes, hidden
reasoning text, or resolved secrets by default.

## Batch API Proxy

The v1.2 Batch API proxy follows the same metadata-only async pattern without running through the synchronous generation pipeline. `POST /v1/batches` resolves a provider node, enforces Gateway API key endpoint/node/model permissions, namespace scope, rate limits, and budget checks, then forwards the OpenAI-compatible create body to the upstream batch endpoint. It writes a `batch_jobs` row with request id, provider batch id, node, model hint, endpoint, file ids, request counts, status, timestamps, API key/namespace attribution, and sanitized error text. It stores metadata keys only, not metadata values. Status, cancel, output, and error-file routes look up `batch_jobs`, enforce the creating key/namespace boundary, and proxy provider file content without persisting input JSONL, output JSONL, raw headers, provider keys, or file bytes.

## Evaluation Framework

The v1.3 Evaluation Framework is a local metadata layer around the existing request pipeline. It does not create a second inference path. Primary, candidate, and judge calls are built as canonical text requests and sent through `PipelineService.process`, so normal routing, fallback, budgets, call logs, telemetry, plugins, and route decisions still apply.

Persistent state is split across three tables:

- `eval_datasets` stores dataset identity, source, sample count, sanitized metadata, and whether sample previews were explicitly enabled.
- `eval_experiment_runs` stores primary/candidate/judge target metadata, aggregate success, latency, cost, fallback, judge score, winner, status, timestamps, sanitized summary, and privacy flags.
- `eval_sample_results` stores sample hashes, request ids, status codes, latency, cost, fallback flags, judge score/label, sanitized reason summary, sanitized error type, and sanitized metadata.

By default, these tables do not store prompt text, response text, raw headers, provider keys, media bytes, video bytes, or judge rubric text. `evaluation.store_samples` is a local opt-in for redacted previews; a run must also set `store_samples: true`, which prevents a broad config flag from silently capturing samples from automation that did not request it.

## Provider Catalog And Pricing Sync

The Provider Catalog is local metadata, not a hosted dependency. SiftGate loads built-in provider/model references, then an optional SiftGate-managed sync cache, then the operator-managed `catalog.override.yaml`. That merge order lets automatic OpenRouter model/pricing sync improve defaults while keeping explicit local overrides authoritative.

v1.4 expands the built-in catalog to 50+ providers and adds `docs/ADDING_PROVIDERS.md` as the maintenance checklist for provider additions. The codebase still keeps a legacy provider diagnostics projection alongside the built-in catalog for compatibility with older validation paths; the long-term architecture direction is one catalog source with generated Dashboard/API/diagnostic views.

The v1.2 pricing sync scheduler is disabled by default and runs only when a supported adapter is explicitly enabled under `catalog.sync.adapters`. In v1.2 the only automatic adapter is OpenRouter's public model catalog API. Other providers remain docs-review or operator-local because prices often depend on region, deployment, account, or private model names.

Runtime cost routing still prefers explicit node/model pricing from `model_capabilities[].pricing` or `models_pricing`. Catalog sync does not store provider API keys and does not modify routing decisions by itself; it only updates metadata used by validation, Dashboard source status, and pricing fallback when no explicit user price exists.

Provider Compatibility Profiles live beside catalog pricing metadata. Built-in providers reference one or more profiles, local overrides can set `compatibility_profiles`, and node config can set `compatibility_profile` when an upstream proxy or local server behaves differently from its catalog provider. Config validation checks profile existence, provider/profile match, endpoint/source-format support, and modality/model-bucket support. The compatibility registry remains static local metadata; user-triggered compatibility tests use it only to choose safe probes.

## Config Audit And Rollback

The v0.9 OSS Data Plane adds a local configuration history layer:

- `config_versions` stores sanitized rollback snapshots and summaries.
- `config_audit_events` stores actor/action/target/result metadata for config changes.
- Dashboard config reload, node create/update/delete, routing edits, Dashboard-managed API key mutations, and rollback attempts write audit events.

The audit layer sits beside `ConfigService`; it does not change the request forwarding path. Mutating Dashboard operations are wrapped so SiftGate captures a before snapshot, runs the mutation, captures an after snapshot, and records success or failure.

Rollback uses the same atomic validation semantics as config reload: SiftGate parses and validates the target YAML before writing `gateway.config.yaml` and committing the in-memory snapshot. If parsing, validation, or secret rehydration fails, the current file and active runtime config are retained.

Snapshots are secret-safe storage. Literal provider keys, dashboard password hashes, raw auth headers, and secret/token/password-like values are redacted before persistence. Environment references such as `${OPENAI_API_KEY}` remain visible. When rollback needs a redacted value, SiftGate rehydrates it only from a matching field in the current local config; array entries with an `id` must match by `id`, preventing a deleted node from borrowing another node's secret.

## Shadow Traffic

The open-source data plane includes optional shadow traffic for sampled test-node mirroring. When enabled, successful primary requests can enqueue an asynchronous copy to a configured shadow node/model. The primary response has already been produced, so shadow latency and failures do not affect the caller.

Shadow results are stored separately from `call_logs` and are read-only in the Dashboard. By default they store metadata only and do not store prompts, responses, raw headers, or provider keys. Operators must explicitly enable local comparison sample storage with `shadow.compare.store_prompts` or `shadow.compare.store_responses`; config validation warns when either is enabled.

The v0.9 comparison report layer does not introduce a new decision-making path. It pairs shadow result rows with primary `call_logs` by `request_id` and computes success rate, p50/p95 latency, estimated shadow cost, potential savings, token delta, fallback delta, quality sample coverage, confidence, and risk notes. Shadow cost uses the local pricing configuration and is flagged when pricing is missing. Dashboard and API reports stay read-only: they can support a gray-release decision, but they never mutate routing config, promote a target, or replay media/video bytes.

This separation is deliberate: Traffic Experiments split live primary traffic,
Eval Reports compare controlled primary/candidate/judge runs, and Shadow
Traffic mirrors sampled primary requests after the caller path.

## Local Webhook Alerts

The open-source data plane includes an optional `alerts` subsystem. It listens to budget threshold/exceeded events, active health probe state, circuit breaker transitions, and the local call-log stream for error/latency spikes. Delivery runs from an in-memory asynchronous queue so webhook latency does not block AI proxy requests.

Alert payloads are sanitized before dispatch. Prompts, responses, provider API keys, raw headers, configured webhook headers, passwords, secrets, and tokens are not included. Dashboard alert status is read from local memory through `GET /api/dashboard/alerts`; webhook URLs and headers are not exposed there.

## Guardrails Findings

The official `plugins/guardrails` plugin remains a local Data Plane plugin. It runs in pipeline hooks and records privacy-safe finding metadata in the per-request plugin store plus an in-memory Dashboard summary. It can inspect text content for PII, secret/token patterns, prompt injection, jailbreak language, unsafe URLs, schema violations, tool-call policy violations, and named policy rules.

The optional guardrails webhook sink is separate from local webhook alerts. It sends `siftgate.guardrails.findings.v1` metadata asynchronously with debounce, retry, timeout, max queue, and drop-policy controls. Payloads include request id, source format, rule/action/kind/severity counts, and finding metadata only. They do not include prompts, responses, matched text, raw headers, provider keys, webhook URL, webhook headers, media bytes, or video bytes. Dashboard reads `GET /api/dashboard/guardrails` for local counters and recent delivery state; no persistence table is required.

## Shared Runtime State

The data plane defaults to in-process memory for runtime state. The optional
v0.5 Redis backend lets multiple gateway instances share state without requiring
the Cloud Control Plane:

- circuit breakers are mirrored through a Redis hash
- API key/IP rate limits use Redis `INCR` and expiry
- prompt-cache entries use Redis String+TTL values
- routing momentum uses Redis sorted sets

When Redis is unavailable, `state.unavailable_policy` controls behavior:
`fail_open` keeps traffic flowing with degraded state, while `fail_closed`
rejects rate-limited paths and treats circuits as unavailable.

External log sinks can mirror sanitized `CallLog` metadata to JSONL files, webhook receivers, or a minimal Elasticsearch bulk endpoint. Sink delivery is asynchronous and starts only after the local database write succeeds. Export payloads do not include prompts, responses, provider keys, raw auth headers, or secret-bearing fields by default.

OpenTelemetry is the data plane's metrics and tracing layer. When `telemetry.enabled` is set in `gateway.config.yaml`, the existing Prometheus exporter exposes scrapeable metrics on `telemetry.metrics.prometheus_port` at `/metrics`.

Business metrics are emitted from the request pipeline and runtime services:

- `siftgate_requests_total{tier,node,model,status}`
- `siftgate_request_duration_seconds{tier,node,model,status}`
- `siftgate_tokens_total{node,model,direction}`
- `siftgate_cost_total{node,model}`
- `siftgate_fallback_total{tier,node,model}`
- `siftgate_cache_hits_total`
- `siftgate_cache_misses_total`
- `siftgate_budget_usage_ratio{scope,budget_type}`
- `siftgate_concurrent_requests{node}`
- `siftgate_circuit_breaker_state{node,model}`

Labels are kept low-cardinality. Request status is a class such as `2xx`; budget usage is aggregated by `scope` and `budget_type`; API key names/IDs, prompt text, response text, provider keys, and raw headers are excluded from metric labels.

## Connected Gateway

Connected Gateway is a data-plane client for a future hosted control plane. It is configured under:

```yaml
control_plane:
  enabled: true
  url: "http://localhost:3100"
  gateway_id: "gw_local_dev"
  registration_token: "${GATEWAY_REGISTRATION_TOKEN}"
  telemetry:
    upload_interval_seconds: 30
    include_prompt: false
    include_response: false
```

When enabled, the data plane:

- registers with the cloud service using a registration token
- receives a workspace id, gateway id, and access token
- sends heartbeat every 30 seconds
- uploads privacy-preserving call metadata
- pulls the latest policy bundle every 60 seconds

When disabled, the gateway never contacts a control plane.

## Privacy Boundary

Connected telemetry can include:

- workspace id
- gateway id
- request id
- Gateway API key id
- node id
- model
- tier
- score
- domain hint
- modality
- latency
- status code
- input and output tokens
- estimated cost
- fallback used
- retry count
- cache hit
- policy hits
- timestamp

Connected telemetry does not include by default:

- prompt text
- response text
- tool input payloads
- provider API keys
- raw authorization headers
- raw secret-bearing headers

## Cloud Control Plane

The cloud control plane is the future paid product. It should manage:

- workspaces
- users and roles
- gateway fleet registration and health
- version drift
- config drift
- metadata analytics
- audit events
- policy bundles
- router recommendations
- optional Autopilot with guardrails

See [Control Plane](./CONTROL_PLANE.md) and [Open Core](./OPEN_CORE.md) for the product boundary.

## Packaging

This repository is currently distributed as GitHub source plus Docker image. The root `package.json` keeps `private: true` so accidental npm publication is blocked until an npm package is intentionally designed.

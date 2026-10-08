# Changelog

## Unreleased

## 2.11.7 - 2026-10-08

### Fixed

- Verify the remote annotated release tag in an isolated temporary ref instead
  of trusting the local tag ref that `actions/checkout` can flatten to a commit.
  Reject lightweight, missing, renamed or wrong-commit remote tags without
  rewriting any version tag or `FETCH_HEAD`.
- Initialize the source SHA in the release-check shell as well as exporting it
  for later steps. Retain exact-main CI, native AMD64/ARM64, immutable aliases,
  anonymous download and Draft-to-public installer gates; manual runs stay test-only.
- Add 12 offline Git regression cases, including the exact failing checkout
  refspec; the customer tooling suite now has 37 cases.

### Publication And Upgrade Boundary

- Carry forward the v2.11.6 pricing/customer-install changes below. The v2.11.6
  source tag is preserved, but its tag-only validation failed before image builds
  and no image or GitHub Release was published for it. Use the verified successor
  release, not that source tag, for customer image installation.
- Apart from release/version metadata, this successor changes release tooling,
  not gateway behavior. The quantified pricing performance exception below still
  applies; this is not a new performance benchmark or a blanket cross-version
  upgrade guarantee. Publication never restarts an existing 2099 instance.

## 2.11.6 - 2026-10-08

**Source tag only:** image publication stopped at the tag-validation gate. The
immutable tag is retained; v2.11.7 is the successor release candidate.

### Added

- Unified versioned pricing configuration for token/context tiers, cache usage,
  calendar/time-window policies, currencies/FX and supported media quantities.
  Dashboard pricing controls and cost evidence are available in all seven locales.
- Immutable request pricing snapshots, exact budget/ledger settlement, retained
  outcomes, reconciliation and read-only replay across SQLite and PostgreSQL.
- Customer Docker installation, explicit timezone and private initialization,
  persistent configuration directories, verified SQLite backups, opt-in rotation,
  safe image upgrades and restore-to-new-directory recovery.
- Versioned native AMD64/ARM64 GHCR publication, fixed digest receipts, checksummed
  installer assets, public-download checks and resumable Draft-to-public releases.

### Reliability And Operations

- Update transitive `proxy-addr` to 2.0.8 for GHSA-jqcg-44mw-7w3h, preserving
  correctly scoped proxy trust while preventing IPv4-mapped IPv6 trust bypass.
  Three bounded regression cases protect subnet and forwarded-header behavior.
- Actual HTTP/listener checks, bounded watchdog recovery, self-service alert
  connectors, timed call-log retention and WAL-aware backup tooling.
- Node 22 (`>=22.13.0 <23`) development/build contract shared by CI and Docker;
  SDK consumers do not inherit a new package-engine restriction.
- Complete maintainer/customer runbooks, release-state gates and a command card.
- Full CI test discovery is retained while unit and HTTP tests run in four shards
  each. Isolated PostgreSQL coverage is enabled, and a final accounting job
  rejects missing/duplicate suites, failures or skipped tests. The 30-minute job
  limit and all data assertions remain intact. Real schema/subprocess
  integration contracts receive explicit 30-second test execution budgets instead of the
  implicit 5-second Jest default; they perform repeated DDL/rollback operations
  and are not request-latency or throughput gates. Business performance targets
  are unchanged.

### Upgrade And Acceptance Boundaries

- Review pricing migrations and take a verified backup before upgrading. New
  pricing controls require explicit operator configuration; do not treat example
  prices as current vendor prices or overwrite existing operator configuration.
- The accepted pricing application originated at commit `591ebb99`. Its measured
  PostgreSQL JSON/50ms case added 15.031749ms p95 and lost 15.532176% throughput,
  exceeding the original 5ms/5% targets. This was accepted by explicit exception
  on October 1, 2026, not relabeled as a performance pass or universal SLA.
- The release requires successful exact-commit main CI plus both native image
  gates. GitHub run results and the release summary are the final evidence;
  historical development checkpoints are not current release status.
- Publication does not restart or migrate an existing gateway. Single-instance
  upgrades require a separate maintenance decision, and rollback must preserve
  business data accepted after the backup. No production secrets/data are shipped.

## 2.11.5 - 2026-09-20

### Fixed

- Retained the Messages protocol fixes merged in PR #130: native server tools
  and citations, signed thinking history, tool choice, and cache usage metadata.
- Promoted deployed transport error-cause diagnostics and configurable
  `routing.circuit_breaker` settings into the maintained release source,
  including configuration validation and regression coverage.
- Restricted Jest discovery to maintained source/test/SDK roots so generated
  worktrees, foreign test frameworks, and local package caches cannot pollute
  unit or E2E results. Dedicated SDK discovery remains covered.

### Maintenance

- Tracked the existing macOS 2099 watchdog helper without auto-installing or
  invoking it during builds, tests, or release checks.
- Established `docs/BASELINE.md` as the current engineering baseline and added
  it to release-version validation. Marked the July optimization plan historical.
- Clarified that the one-request v2.0.0 benchmark is smoke evidence, not a
  current performance or tail-latency baseline.

### Upgrade Boundaries

- No database migration, Dashboard translation change, or live configuration
  rewrite. Existing breaker defaults and explicitly configured overrides remain
  intact. Provider and Gateway credentials are not part of this release.
- Publishing this version does not restart a running gateway. Prepare a
  separate verified release directory and switch it only at the planned restart.

## 2.11.4 - 2026-09-08

### Fixed

- Dashboard edits to pooled provider credentials now preserve an existing key
  when its field is omitted or blank. New credential IDs still require a
  non-blank key and invalid updates return HTTP 400 without changing config.
- Model ownership diagnostics deduplicate each provider across general and
  specialized model buckets, eliminating false cross-provider duplicate
  warnings while preserving real conflicts.
- Runtime startup and reload accept specialized-only providers with an empty
  `models` array, matching the config validator and Dashboard-generated config.

### Validation

- Regression coverage for credential DTO validation, secret preservation,
  replacement, missing-secret rejection, metadata-only audit, and exact model
  IDs containing brackets through the Messages endpoint.
- Regression coverage for specialized-only startup/reload and duplicate-model
  diagnostics across provider model buckets.

### Boundaries

- Provider credentials, local model selections, and live gateway config are not
  included in the release. No live process restart or config reload is required
  to publish this release; deployed processes must be restarted separately to
  load the new backend code.

## 2.11.3 - 2026-05-14

### Added

- Added `transport: stdio` support to MCP Tool Gateway so local MCP server
  processes can be launched, initialized, and proxied behind existing Gateway
  API key, Policy Namespace, rate-limit, request-size, and metadata-only audit
  controls.
- Added real Streamable HTTP SSE-response handling and legacy HTTP+SSE
  transport support for MCP Tool Gateway, including optional `message_url`
  configuration for older MCP servers.
- Added MiniMax Token Plan MCP examples for `web_search` and
  `understand_image`, including tool-level `allowed_endpoints` examples for
  `mcp:minimax-token-plan:web_search` and
  `mcp:minimax-token-plan:understand_image`.

### Test Evidence

- `npm test -- --runInBand test/unit/mcp-gateway-service.spec.ts test/unit/config-validator.spec.ts`
- `npm run build`
- `npm test -- --runInBand`
- `npm run docs:check`
- `npm run lint`
- `npm run release:check`
- `npm run validate:k8s`
- `npm run validate:config -- --config gateway.config.yaml`
- `cd frontend && npm test`
- `cd frontend && npm run build`

### Boundaries

- v2.11.3 keeps existing HTTP MCP proxy behavior unchanged. Stdio MCP servers
  are explicitly configured per server and continue to store only metadata by
  default; SiftGate does not persist tool arguments, tool results, raw headers,
  provider keys, resolved secrets, or media bytes.

## 2.11.2 - 2026-05-14

### Changed

- Updated all localized documentation entry README files for English,
  Simplified Chinese, Traditional Chinese, Japanese, Korean, Thai, and Spanish
  so the localized project storefront matches the latest SiftGate positioning:
  AI traffic data plane, 30-second pitch, agent/MCP governance, cache-aware
  provider credential pools, metadata-only defaults, and production deployment
  path.

### Test Evidence

- `npm run docs:check`
- `npm run validate:k8s`
- `npm run release:check`
- `npm run build`
- `cd frontend && npm run build`
- `git diff --check`

### Boundaries

- v2.11.2 is a localization and documentation release. It does not change
  runtime gateway behavior, provider routing semantics, config schemas, or
  public ingress APIs.

## 2.11.1 - 2026-05-14

### Changed

- Refreshed the public repository homepage with a stronger SiftGate product
  storefront: clearer AI traffic data-plane positioning, a 30-second pitch,
  stronger differentiators, and updated provider-credential-pool messaging.
- Added a new README hero SVG and tightened the competitive matrix SVG so
  headings, table labels, and comparison text stay inside their visual bounds
  across GitHub and local renderers.

### Test Evidence

- `xmllint --noout docs/assets/homepage/siftgate-hero.svg docs/assets/comparison/competitive-matrix.svg`
- `npm run docs:check`
- `npm run validate:k8s`
- `npm run release:check`
- `git diff --check`

### Boundaries

- v2.11.1 is a public documentation and repository presentation release. It
  does not change runtime gateway behavior, provider routing semantics, config
  schemas, or public ingress APIs.

## 2.11.0 - 2026-05-14

### Added

- Added `cache_aware` provider credential-pool strategy. When upstream usage
  reports prompt-cache creation or reads, SiftGate pins matching Gateway API
  key/session/team/namespace traffic to the same provider credential for the
  cache window, while still failing over to another credential on 429/5xx,
  network errors, and timeouts.

### Test Evidence

- `npm test -- --runInBand test/unit/provider-client.spec.ts test/unit/config-validator.spec.ts`
- `npm run build`
- `npm run lint`
- `cd frontend && npm run i18n:check`
- `cd frontend && npm run build`
- `npm run docs:check`
- `npm run release:check`
- `npm run validate:config -- --config gateway.config.yaml`

### Boundaries

- v2.11.0 is backward compatible for existing single-key nodes and existing
  `least_in_flight` / `weighted_round_robin` credential pools. The new
  strategy only activates when `nodes[].credential_pool.strategy` is set to
  `cache_aware`.

## 2.10.0 - 2026-05-14

### Added

- Added first-class native Gemini provider support via `protocol: gemini`,
  including GenerateContent request translation, native streaming through
  `streamGenerateContent?alt=sse`, Gemini usage accounting, function tools,
  JSON output, thinking config, and Google Search grounding.
- Added Dashboard and provider-catalog support for Gemini native nodes,
  including protocol selection, capability selection, node testing, localized
  labels, Gemini catalog defaults, and native health-probe request bodies.

### Changed

- Google Gemini catalog defaults now prefer the native Gemini endpoint while
  preserving the OpenAI-compatible chat endpoint as an alternate path.
- Google AI Studio API-key requests sent to
  `generativelanguage.googleapis.com` now use `x-goog-api-key`, including the
  OpenAI-compatible endpoint path.

### Test Evidence

- `npm run build`
- `npm test -- --runInBand test/unit/provider-client.spec.ts test/unit/stream-parsers.spec.ts test/unit/compatibility-profiles.spec.ts test/unit/config-validator.spec.ts test/unit/provider-catalog.service.spec.ts test/unit/built-in-catalog.spec.ts test/unit/usage-schema-resolver.spec.ts`
- `npm test -- --runInBand test/unit/provider-client.spec.ts test/unit/active-health-probe.service.spec.ts test/unit/dashboard-controller.spec.ts`
- `cd frontend && npm run i18n:check`
- `cd frontend && npm run build`
- `npm run docs:check`

### Boundaries

- v2.10.0 is backward compatible for existing OpenAI-compatible Gemini nodes
  and single-key node configs. It adds native Gemini as a first-class upstream
  protocol without changing public OpenAI/Anthropic-compatible ingress routes.

## 2.9.1 - 2026-05-14

### Fixed

- Fixed Gateway API Key creation examples so the generated curl sample follows
  the selected/allowed ingress endpoint, including `/v1/messages`,
  `/v1/responses`, `/v1/embeddings`, and `/v1/chat/completions`.
- Added credential-hit visibility to Dashboard request log details. Logs now
  show the selected provider credential id when a credential pool is used and a
  localized default-key badge for legacy single-key nodes, without exposing
  provider secrets.

### Test Evidence

- `cd frontend && npm run i18n:check`
- `cd frontend && npm run api-keys:check`
- `cd frontend && npm run build`
- `npm run release:check`

### Boundaries

- v2.9.1 is a Dashboard bugfix release. It does not change provider routing,
  credential selection semantics, schemas, or public ingress API behavior.

## 2.9.0 - 2026-05-14

### Added

- Added first-class provider credential pools for upstream nodes via
  `nodes[].credentials[]` and `nodes[].credential_pool`, including
  least-in-flight and weighted round-robin selection, agent/API-key/team/
  namespace sticky affinity, retryable-status failover, cooldown handling, and
  write-only Dashboard editing.
- Added credential-level observability without secret exposure: call logs now
  store `credential_id`, `credential_strategy`, and
  `credential_retry_count`; Dashboard node responses expose sanitized
  credential runtime status.

### Changed

- Provider requests now retry another credential inside the same node on
  configured retry statuses, 401/403 credential failures, network errors, and
  timeouts before node-level fallback runs.
- Provider compatibility tests, active health probes, realtime upstream auth,
  batch provider auth, video provider proxy auth, config migration exports, and
  secret preservation all understand credential-pool configs.
- Updated release metadata to v2.9.0 across package, lock, Dashboard, client,
  Python, Helm, Kubernetes, OpenAPI, README, and release-version sync files.

### Test Evidence

- `npm run build`
- `cd frontend && npm run build`
- `npm test -- --runInBand test/unit/provider-client.spec.ts test/unit/config-validator.spec.ts test/unit/call-log-schema-patch.service.spec.ts`

### Boundaries

- v2.9.0 is a backward-compatible core runtime feature. Existing single
  `nodes[].api_key` configs continue to work unchanged. Provider secret values
  remain redacted from Dashboard responses, call logs, route traces, telemetry,
  and external log sinks.

## 2.8.4 - 2026-05-13

### Fixed

- Fixed local Quick Start startup by loading `.env` automatically before config
  interpolation and switching example provider keys to runtime secret
  references.
- Prevented Dashboard config saves from writing unedited resolved provider
  secrets back into `gateway.config.yaml`.
- Cleared production dependency audit findings by upgrading OpenTelemetry,
  `uuid`, and the affected protobuf transformer path.
- Restored the root `npm run lint` script with an ESLint flat config and
  tracked dev dependencies.

### Changed

- Hardened OSS defaults: source installs bind to localhost, Docker Compose
  publishes localhost-only, CORS defaults to same-origin/no credentials, and
  Dashboard auth is required by default with first-start password generation.
- Added a non-Docker GitHub CI workflow covering docs, build, unit/e2e tests,
  frontend checks, SDK checks, Kubernetes validation, release checks, provider
  registry validation, and production dependency audit.

### Test Evidence

- `npm run lint`
- `npm run build`
- `npm test -- --runInBand test/unit/config-mutations.spec.ts`
- `npm test -- --runInBand test/unit/auth-service.spec.ts test/unit/dashboard-guard.spec.ts test/unit/auth-controller.spec.ts`
- `npm run test:e2e -- --runInBand test/e2e/auth.e2e-spec.ts`
- `npm run docs:check`
- `npm run validate:config -- --config gateway.config.example.yaml`
- `npm run validate:k8s`
- `npm run release:check`
- `npm run provider-registry:check`
- `npm audit`

### Boundaries

- v2.8.4 is an OSS hardening release. It does not change storage schemas,
  provider request/response formats, routing selection semantics, budget
  accounting, or the public OpenAI/Anthropic-compatible API shape.

## 2.8.3 - 2026-05-12

### Fixed

- Hardened Anthropic native message passthrough against malformed desktop history payloads by dropping invalid messages, coercing invalid content fields, and stripping empty or unsupported blocks before forwarding upstream.
- Made message normalization tolerate compacted request history that contains null, primitive, or missing-type content blocks without preserving malformed provider payload nodes.

### Test Evidence

- Added focused coverage for malformed native content fields, compacted desktop history blocks, invalid native messages, and normalizer edge cases.

### Boundaries

- v2.8.3 is a compatibility bugfix only. It does not change routing defaults, storage schemas, authentication, budget behavior, provider alias semantics, or Dashboard UX.

### Added

- Added reusable Dashboard guidance sections that collapse by setup completion, remember manual visibility, and keep help entry points available without permanently occupying each page.
- Added stronger Dashboard i18n quality gates for seven-locale key parity, hardcoded visible English copy, onboarding/sidebar/checklist coverage, and full translated-value fallback detection with a narrow technical-literal allowlist.

### Changed

- Updated v2.8.1 Dashboard checklist behavior so incomplete setup stays expanded, completed setup defaults to collapsed, and each checklist item points to a concrete next action.
- Reworked key Dashboard page copy across `en`, `zh`, `zh-TW`, `ja`, `ko`, `th`, and `es` to reduce vague explanations, align navigation/page names, and avoid untranslated English fallback.
- Hardened Provider Catalog responsive layout so filters, badges, action buttons, detail metadata, and key/value rows remain readable across desktop, narrow, and multilingual widths.
- Added `/dashboard` as a Dashboard route alias and tightened sidebar active-state matching so navigation highlights remain precise.

## 2.8.2 - 2026-05-12

### Added

- Added `nodes[].upstream_model_aliases` so SiftGate can expose Claude-compatible public model IDs to Claude Code/Desktop while forwarding the real upstream model ID to the provider.
- Added config validation, OpenAPI/Dashboard DTO coverage, frontend API typing, and example config documentation for upstream model alias mappings.

### Changed

- Updated direct-route permission checks and `/v1/models` discovery so API keys can match either the public SiftGate model ID or the mapped upstream model ID.
- Stripped Anthropic native `thinking` and `redacted_thinking` blocks from passthrough message payloads before forwarding them upstream.
- Updated release metadata to v2.8.2 across package, lock, Dashboard, client, Python, Helm, Kubernetes, OpenAPI, README, and release-version sync files.

### Test Evidence

- Validation passed for focused alias and passthrough coverage: `npm test -- --runInBand test/unit/provider-client.spec.ts test/unit/pipeline-service.spec.ts test/unit/config-validator.spec.ts`.

### Boundaries

- v2.8.2 is a backward-compatible provider routing compatibility patch. It does not change storage schemas, routing defaults, privacy defaults, budget semantics, or the public OpenAI-compatible API shape.

## 2.8.1 - 2026-05-10

### Added

- Added a public-facing SiftGate brand mark and wordmark based on a simple open-door and reflection motif, plus refreshed the Dashboard favicon.
- Added a professional GitHub README storefront with badges, quickstart, concept table, privacy boundary, documentation map, and seven-language documentation entrypoints.
- Added localized documentation entrypoints for `en`, `zh`, `zh-TW`, `ja`, `ko`, `th`, and `es`, and made `docs:check` require them.

### Changed

- Removed tracked internal planning and execution draft documents from the public repository surface.
- Expanded repository hygiene rules so local agent notes, public skill prompts, local development specifications, runtime config, databases, and sync cache stay out of public commits.
- Updated release metadata to v2.8.1 across package, lock, Dashboard, client, Python, Helm, Kubernetes, OpenAPI, README, and release-version sync files.

### Boundaries

- v2.8.1 is a public repository readiness patch only. It does not change runtime behavior, schemas, routing, budgets, provider behavior, auth, MCP proxying, or privacy storage defaults.

## 2.8.0 - 2026-05-10

### Added

- Shipped the final v2.8 OSS concept model across the Dashboard, API docs, README, config examples, and release notes: Workspace, Policy Namespace, Provider Node, Gateway API Key, Budget scope, Semantic Controls, Traffic Experiments, Evals, Shadow Traffic, and MCP Tool Gateway.
- Included the full v2.8 release train from alpha through RC: in-product concept clarity, Provider Catalog visibility counts, OSS Workspace management, config-backed Policy Namespace management, scoped budget setup, advanced setup panels, first-run onboarding, and cross-linked docs.
- Prepared final GA release notes with highlights, upgrade notes, test evidence, privacy boundaries, and known limitations.

### Changed

- Updated release metadata to v2.8.0 across package, lock, Dashboard, client, Python, Helm, Kubernetes, OpenAPI, README, and release-version sync files.
- Polished remaining config-example wording so the user-facing names are MCP Tool Gateway and Semantic Controls while compatibility routes and config keys remain unchanged.
- Confirmed v2.8.0 GA does not add new scope after RC; it is hardening, regression-check, docs polish, test evidence, and final release packaging only.

### Upgrade Notes

- Existing `gateway.config.yaml` files remain compatible. Compatibility routes and config keys such as `/api/dashboard/semantic-platform`, `semantic_platform`, `mcp`, and `namespaces` are intentionally unchanged.
- Operators can adopt the new Dashboard setup path without enabling advanced features. Semantic Controls, Traffic Experiments, Eval Reports, Shadow Traffic, and MCP Tool Gateway stay disabled or metadata-only until configured.
- Workspace, Policy Namespace, Budget, Team, API Key, Provider Node, and Provider Catalog behavior follows the v2.8 prerelease documentation and tests.

### Test Evidence

- GA validation passed: `npm run docs:check`, `npm run build`, `npm test -- --runInBand`, `npm run test:e2e`, `npm run validate:config`, `npm run validate:k8s`, `npm run test:sdk`, `npm run typecheck:sdk`, `npm run test:python-sdk`, `cd frontend && npm test && npm run build`, and `npm run release:check`.

### Known Limitations

- Provider Catalog visibility remains source-governed: transport-only providers are connectable as nodes but hidden from the default active catalog when model or pricing truth is not trusted.
- SiftGate OSS fixed roles remain Admin, Operator, and Viewer; custom role systems, SSO, SCIM, cloud org billing, and enterprise tenant behavior are not part of v2.8.0.
- Advanced features do not auto-promote experiment winners, run workflow automation, or store prompts, responses, raw provider headers, provider keys, tool payloads, media bytes, hidden reasoning, or resolved secrets by default.

### Boundaries

- v2.8.0 does not add new GA features, widen RC scope, change runtime defaults, or change privacy storage defaults.

## 2.8.0-rc.1 - 2026-05-10

### Added

- Added an end-to-end first-run Dashboard checklist that guides OSS operators through Workspace, Provider Node, Gateway API Key, optional Policy Namespace, daily Budget scope, first request, evidence review, and advanced setup surfaces.
- Added reusable Dashboard docs links from the Overview and affected concept pages to the matching OSS docs so each clarified v2.8 concept has an in-product path to configuration guidance.
- Added a static onboarding check that verifies the setup path, docs links, privacy boundary copy, and seven-locale onboarding coverage.

### Changed

- Updated README, QUICKSTART, Dashboard, API Reference, Provider Catalog, Policy Namespace and Shadow Traffic, MCP Tool Gateway, Semantic Controls, Evaluation Framework, and OSS concept docs to close the v2.8 configuration loop.
- Removed inconsistent pre-v2.8 wording from onboarding and related docs while keeping the agreed concept model: Workspace, Policy Namespace, Provider Node, Gateway API Key, Budget scope, Semantic Controls, Traffic Experiments, Evals, Shadow Traffic, and MCP Tool Gateway.
- Updated release metadata to v2.8.0-rc.1 across package, lock, client, Python, Helm, Kubernetes, OpenAPI, README, and release-version sync files.

### Boundaries

- v2.8.0-rc.1 does not add backend features, change runtime defaults, introduce new terminology, or store prompts, responses, raw provider headers, provider keys, tool payloads, media bytes, hidden reasoning, or resolved secrets by default.

## 2.8.0-beta.3 - 2026-05-10

### Added

- Added shared Dashboard setup-state guidance with copyable YAML snippets for Semantic Controls, Traffic Experiments, Eval Reports, Shadow Traffic, and MCP Tool Gateway.
- Added Traffic Experiments frontend checks and expanded Semantic, Eval, Shadow, and MCP checks to cover setup panels, safe YAML defaults, read-only behavior, and seven-locale copy.
- Added docs that distinguish Semantic Controls metadata, live Traffic Experiments, controlled Eval runs, asynchronous Shadow Traffic, and MCP tool-call proxy governance.

### Changed

- Updated the five advanced Dashboard pages to show whether the related config is enabled, missing, metadata-only, or explicitly storing samples/content.
- Updated README, Dashboard, API, Architecture, Semantic, Evaluation, Shadow, and MCP docs for setup-complete advanced surfaces.
- Updated release metadata to v2.8.0-beta.3 across package, lock, client, Python, Helm, Kubernetes, OpenAPI, README, and release-version sync files.

### Boundaries

- v2.8.0-beta.3 does not enable advanced features by default, add auto-promotion, add workflow or experiment decision automation, change routing behavior, or store prompts, responses, raw provider headers, provider keys, tool payloads, media bytes, hidden reasoning, resolved secrets, eval samples, or shadow samples by default.

## 2.8.0-beta.2 - 2026-05-10

### Added

- Added budget source-of-truth metadata to Dashboard budget responses, including selected scope, scope chain, source, safe edit path, alert threshold, daily reset time, and blocking order.
- Added a scope-based Budget page for Global, Policy Namespace, Team, Dashboard-managed API Key, and legacy YAML key views with inherited/unset states, current usage, manual reset, model pricing, and provider-cache savings context.
- Added safe Budget page edit flows that reuse existing Policy Namespace, Team, and Dashboard-managed API Key update paths without adding billing or changing global config mutation behavior.
- Added budget scope frontend checks and unit coverage for response metadata, namespace source-of-truth, team inherited state, and alert threshold propagation.

### Changed

- Updated Dashboard, API, Architecture, and README docs to explain Global vs Policy Namespace vs Team vs API Key budget ownership, daily reset behavior, and unchanged enforcement order.
- Updated seven Dashboard budget locales and release metadata to v2.8.0-beta.2 across package, lock, client, Python, Helm, Kubernetes, OpenAPI, README, and release-version sync files.

### Boundaries

- v2.8.0-beta.2 does not add billing, resale, recharge, invoices, customer balances, new financial data storage, or new privacy storage defaults. It does not change budget enforcement semantics, routing, provider behavior, configured node behavior, or manual reset semantics.

## 2.8.0-beta.1 - 2026-05-10

### Added

- Added admin-only Dashboard APIs to create, update, and delete config-backed Policy Namespaces with `id`, `name`, `allowed_nodes`, `allowed_models`, `budget`, and `rate_limit` fields.
- Added the Dashboard Policy Namespaces page with seven-locale copy, concept guidance, summary counts, create/edit/delete flows, binding impact display, and admin-only controls.
- Added Policy Namespace mutation audit coverage through the existing config audit path, including delete impact metadata for bound API keys and Teams.
- Added tests for namespace config persistence, full candidate config validation, runtime secret-reference preservation, admin-only mutation metadata, binding summaries, and explicit delete impact confirmation.

### Changed

- Policy Namespace list responses now include budget status, binding summaries for Dashboard-managed API keys, YAML-defined API keys, local Teams, and aggregate counts.
- Updated README, OSS concepts, Dashboard, API, and namespace/shadow docs to explain that Policy Namespaces are config-backed local policy labels, not Workspaces or tenants.
- Updated release metadata to v2.8.0-beta.1 across the root package, Dashboard package, TypeScript client, Python package, Helm chart, Kubernetes base manifest, OpenAPI document metadata, README, package locks, and release-version sync coverage.

### Boundaries

- v2.8.0-beta.1 does not make Policy Namespaces tenants, Workspaces, orgs, SSO identities, SCIM groups, billing scopes beyond existing local policy behavior, or secret stores. It does not change routing behavior, configured node behavior, budget semantics, MCP proxying, provider projection, auth, or privacy storage defaults.

## 2.8.0-alpha.3 - 2026-05-10

### Added

- Added admin-only Dashboard Workspace lifecycle APIs to create, rename, disable, reactivate, and switch local OSS workspaces while preserving default workspace fallback behavior.
- Added the Dashboard Workspaces page with seven-locale copy for workspace list, create, switch, rename, disable, reactivate, admin-only denial state, and concept guidance.
- Added workspace lifecycle audit events for `workspace.create`, `workspace.rename`, `workspace.disable`, and `workspace.reactivate`.
- Added tests for workspace creation, creator admin membership, switching, disabled workspace fallback, RBAC denial, and cross-workspace log isolation.

### Changed

- Workspace state now exposes workspaces accessible to the current Dashboard identity and keeps disabled workspaces visible only for Admin management.
- Updated Workspace concept documentation, Dashboard docs, README highlights, and release metadata for v2.8.0-alpha.3.

### Boundaries

- v2.8.0-alpha.3 does not add cloud orgs, SSO, SCIM, organization billing, custom enterprise tenant behavior, destructive workspace deletion, default workspace data migration, or new privacy storage defaults.

## 2.8.0-alpha.2 - 2026-05-10

### Added

- Added Provider Catalog visibility summary counts for active catalog providers, transport-only presets, custom presets, deprecated/legacy rows, default-visible rows, hidden-by-default rows, and total presets.
- Added Dashboard detail copy for runtime support, catalog confidence, pricing confidence, and hidden-by-default reasons so transport-only providers are understood as connectable node presets rather than unsupported providers.
- Added catalog visibility coverage for current sync-cache behavior so active canonical projections stay counted separately from transport-only presets.

### Changed

- Replaced user-facing "Show legacy" Provider Catalog/Add Node wording with transport-only/hidden-presets wording while keeping the compatible `show_legacy` API query parameter.
- Clarified Provider Catalog, Dashboard, API, and README docs that active catalog visibility is not total runtime provider support: transport-only presets remain configurable as nodes but stay hidden from the default model catalog when model/pricing truth is not trusted.
- Updated release metadata for v2.8.0-alpha.2.

### Boundaries

- v2.8.0-alpha.2 is a product-clarity release only. It does not mark transport-only providers active, invent prices or models, change routing, alter configured node behavior, or change privacy defaults.

## 2.8.0-alpha.1 - 2026-05-10

### Added

- Added shared Dashboard concept helper panels for Workspace, Policy Namespace, Gateway API Keys, Semantic Controls, Traffic Experiments, Eval Reports, Shadow Traffic, MCP Tool Gateway, budget scopes, fixed OSS member roles, and Provider Catalog visibility.
- Added shared Dashboard capability/status language: Read-only, Config-driven, Preview, OSS fixed roles, Runtime-supported, and Requires config, with seven-locale copy for `en`, `zh`, `zh-TW`, `ja`, `ko`, `th`, and `es`.
- Added `docs/OSS_CONCEPTS.md` to explain Workspace vs Policy Namespace vs Team vs Gateway API Key vs Node vs Provider.

### Changed

- Renamed user-facing Dashboard copy from Semantic Platform to Semantic Controls, Experiments to Traffic Experiments, MCP Gateway to MCP Tool Gateway, and Namespace to Policy Namespace where it describes policy scope.
- Clarified empty states and helper copy for config-driven surfaces so OSS users can tell when data requires existing routing, namespace, MCP, eval, shadow, provider, or budget configuration.
- Updated Dashboard, namespace/shadow, MCP, semantic, eval, provider catalog, README, and release metadata for v2.8.0-alpha.1.

### Boundaries

- v2.8.0-alpha.1 is a product-clarity release only. It does not change runtime behavior, schemas, routing, budgets, MCP proxying, provider projection, auth, Workspace CRUD, Policy Namespace CRUD, or privacy defaults.

## 2.7.1 - 2026-05-10

### Changed

- Reorganized the Dashboard sidebar into Monitor, Runtime, Intelligence, Agents & Tools, and Governance groups so observability, runtime configuration, intelligence surfaces, agent tooling, and administration follow a clearer operator workflow.
- Added seven-locale Dashboard group labels for the new sidebar information architecture.
- Updated release metadata to v2.7.1 across the root package, Dashboard package, TypeScript client, Python package, Helm chart, Kubernetes base manifest, OpenAPI document metadata, README, package locks, release-version sync coverage, and benchmark script expectations.

### Boundaries

- v2.7.1 is a Dashboard polish and release-metadata patch only. It does not change gateway runtime behavior, public API compatibility, storage schemas, provider routing, or privacy defaults.

## 2.7.0 - 2026-05-09

### Added

- Added the v2.7 Semantic Platform for the OSS data plane: Semantic Cache v2 controls, Prompt Registry metadata/versioning, Context Window Optimizer evidence, Intent Classification, and Guardrails v2 metadata.
- Added `GET /api/dashboard/semantic-platform`, `GET/POST/DELETE /api/dashboard/semantic-platform/prompt-templates`, and `POST /api/dashboard/semantic-platform/semantic-cache/invalidate` for workspace-scoped semantic operations.
- Added the `prompt_templates` metadata table with SQLite/PostgreSQL schema patching, workspace scoping, template hashes, variables, route policy binding, A/B metadata, and disabled-by-default template body storage.
- Added top-level `semantic_platform` Route Decision Trace evidence for intent category/confidence, context-window pressure, Prompt Registry binding metadata, and Guardrails v2 findings.
- Added the Dashboard **Semantic Platform** page with seven-locale copy for `en`, `zh`, `zh-TW`, `ja`, `ko`, `th`, and `es`, plus static frontend checks for route, hook, API types, privacy copy, actions, and locale coverage.
- Added `docs/SEMANTIC_PLATFORM.md` and updated API, Architecture, Caching, Dashboard, README, roadmap, and config example documentation for v2.7 operations.

### Changed

- Upgraded semantic cache behavior from preview copy to Semantic Cache v2 semantics with workspace/API-key/model isolation defaults, TTL invalidation, preview Redis/vector backend validation, and response replay gated by `x-siftgate-semantic-store-response` when response storage is enabled.
- Updated release metadata to v2.7.0 across the root package, Dashboard package, TypeScript client, Python package, Helm chart, Kubernetes base manifest, OpenAPI document metadata, README, package locks, release-version sync coverage, and benchmark script expectations.

### Boundaries

- v2.7.0 does not store prompts, responses, template bodies, raw provider headers, provider keys, Gateway API key plaintext, media bytes, tool payloads, hidden reasoning text, matched finding text, source code, diffs, or resolved secrets by default.
- Context Window Optimizer records trim/summarize evidence in v2.7 but does not silently mutate prompt content.
- Guardrails v2 records metadata-only findings by default and does not replace the official guardrails plugin for deeper local enforcement.

## 2.6.0 - 2026-05-09

### Added

- Added the v2.6 Cost And Chargeback Platform for the OSS data plane: workspace-scoped internal chargeback summaries, CSV/JSON exports, budget period close metadata, cost anomaly detection, provider price sync governance, and thumbs feedback aggregation.
- Added `GET /api/dashboard/cost-platform` and `GET /api/dashboard/cost-platform/export` for metadata-only chargeback, anomaly, price-source, and feedback summaries grouped by workspace, team, project, API key, model, or node.
- Added `POST /v1/feedback` for Gateway API key clients to submit thumbs up/down feedback against a request id, storing only route metadata, key/team labels, reason code, and route-weight evidence.
- Added the `route_feedback` metadata table with SQLite/PostgreSQL schema patching, workspace scoping, and feedback aggregation by model/node.
- Added the Dashboard **Cost Platform** page with seven-locale copy for `en`, `zh`, `zh-TW`, `ja`, `ko`, `th`, and `es`, plus static frontend checks for route, hook, export, API types, privacy copy, and locale coverage.
- Added `cost_anomaly` as a local webhook alert event type for metadata-only cost spike alerts.
- Added `docs/COST_CHARGEBACK_PLATFORM.md` and updated API, Dashboard, Architecture, Billing Loop, and README docs with v2.6 boundaries and operations guidance.

### Changed

- Updated release metadata to v2.6.0 across the root package, Dashboard package, TypeScript client, Python package, Helm chart, Kubernetes base manifest, OpenAPI document metadata, README, package locks, release-version sync coverage, and benchmark script expectations.

### Boundaries

- v2.6.0 does not add payments, prepaid balances, recharge flows, reseller ledgers, customer billing identities, public API marketplaces, automatic price trust, silent operator price override, or silent automatic route downgrade.
- Cost Platform exports and feedback do not store prompts, responses, source code, diffs, tool inputs/outputs, raw provider headers, provider keys, Gateway API key plaintext, media bytes, hidden reasoning text, or resolved secrets by default.

## 2.5.0 - 2026-05-09

### Added

- Added the v2.5 Agent Platform Preview for the OSS data plane: a workspace-scoped A2A registry, MCP-backed Tool Registry, preview-only workflow metadata, Conversation Memory Gateway metadata counters, recent agent trace spans, and an explicit privacy contract.
- Added `GET /api/dashboard/agent-platform`, a read-only Dashboard endpoint that combines Agent Profiles, Gateway API key policy, MCP server/tool metadata, and call-log agent span metadata without executing tools or running workflows.
- Added a Dashboard **Agent Platform** page with seven-locale copy for `en`, `zh`, `zh-TW`, `ja`, `ko`, `th`, and `es`, plus static frontend checks for the route, hook, API types, privacy copy, and locale coverage.
- Added `docs/AGENT_PLATFORM_PREVIEW.md` and updated API, Dashboard, Architecture, Coding Agent Gateway, MCP Gateway, and README docs with the v2.5 preview boundaries.

### Changed

- Updated release metadata to v2.5.0 across the root package, Dashboard package, TypeScript client, Python package, Helm chart, Kubernetes base manifest, OpenAPI document metadata, README, package locks, release-version sync coverage, and benchmark script expectations.

### Boundaries

- v2.5.0 does not add a full workflow builder, DAG runtime, hosted tool marketplace, cloud dependency, or automatic tool execution from the Dashboard.
- Agent Platform Preview does not store prompts, responses, source code, diffs, tool inputs, tool outputs, raw provider headers, provider keys, Gateway API key plaintext, media bytes, hidden reasoning text, or resolved secrets by default.
- Agent and tool routing still goes through existing Gateway API key, workspace, namespace, endpoint/model/node, rate-limit, budget, MCP, and routing policy enforcement.

## 2.4.0 - 2026-05-09

### Added

- Added the v2.4 Provider Ecosystem Expansion batch with source-governed built-in catalog rows for DeepInfra, Nebius AI Studio, Novita AI, FriendliAI, Databricks Mosaic AI, and GitHub Models.
- Added Dashboard provider identity metadata for the v2.4 provider batch so OpenAI-compatible providers keep their own logos/badges instead of falling back to generic OpenAI identity.
- Added `npm run provider-registry:check`, an offline community provider manifest validation check with a review-required fixture for provider shape, endpoint/model evidence, pricing source governance, and secret hygiene.
- Added provider catalog and provider extensibility docs describing the v2.4 batch, registry CI expectations, and the continued requirement for reviewed local overrides before production cost routing.

### Changed

- Marked the v2.4 batch as transport/review metadata where model availability, workspace endpoints, marketplace access, or account-specific pricing can change outside SiftGate.
- Updated release metadata to v2.4.0 across the root package, Dashboard package, TypeScript client, Python package, Helm chart, Kubernetes base manifest, OpenAPI document metadata, README, package locks, and release-version sync coverage.

### Boundaries

- v2.4.0 does not promise 100+ provider coverage and does not add untested provider rows for count inflation.
- Built-in/community pricing remains review-required reference metadata unless a trusted operator override supplies high-confidence pricing.
- Provider Ecosystem Expansion does not store prompts, responses, raw provider headers, provider keys, Gateway API key plaintext, media bytes, source code, diffs, tool payloads, hidden reasoning text, or resolved secrets by default.

## 2.3.0 - 2026-05-09

### Added

- Added the v2.3 Provider Extensibility release for the OSS data plane: custom provider templates, custom-header auth, Provider SDK Generator beta, community registry design, and Provider Health Dashboard v1.
- Added `POST /api/dashboard/provider-extensibility/templates/custom/preview` for read-only custom-provider node/catalog manifest previews with secret placeholders and manual-review evidence.
- Added `POST /api/dashboard/provider-extensibility/sdk/generate` for beta TypeScript adapter skeleton generation with generated tests, manifest, README, and an explicit manual review checklist.
- Added `GET /api/dashboard/provider-health` for workspace-scoped provider/node availability, probe status, circuit state, latency, error rate, compatibility labels, auth metadata, and pricing-source warnings.
- Added Dashboard Nodes support for `custom-header` auth mapping plus provider health summary cards with seven-locale copy for `en`, `zh`, `zh-TW`, `ja`, `ko`, `th`, and `es`.
- Added `docs/PROVIDER_EXTENSIBILITY.md` plus Provider Catalog, Adding Providers, API Reference, Dashboard, and README documentation for v2.3 operations.

### Changed

- Provider clients, active health probes, node test APIs, config validation, catalog validation, and Dashboard node DTOs now understand `auth_type: custom-header` with `auth_header_name` and optional `auth_header_prefix`.
- Custom provider previews and generated manifests keep pricing as review-required operator metadata and do not auto-trust generated adapters or community pricing.
- Provider Health uses existing probes, circuit breakers, call logs, compatibility metadata, and pricing governance instead of adding a raw-content health store.
- Updated release metadata to v2.3.0 across the root package, Dashboard package, TypeScript client, Python package, Helm chart, Kubernetes base manifest, OpenAPI document metadata, README, package locks, and release-version sync coverage.

### Boundaries

- v2.3.0 does not promise 100+ provider coverage, scrape provider pricing, or merge generated adapters without review and tests.
- Provider Extensibility and Provider Health do not store prompts, responses, raw provider headers, provider keys, Gateway API key plaintext, media bytes, source code, diffs, tool payloads, hidden reasoning text, or resolved secrets by default.
- Generated SDK artifacts are returned to the caller as beta scaffolds only; SiftGate does not write them to disk or trust them as runtime providers automatically.

## 2.2.0 - 2026-05-09

### Added

- Added the v2.2 Intelligence Loop for the OSS data plane: Real-time Cost Optimizer v1, Token Prediction v1, Async Eval metadata, and disabled-by-default Quality Gate v1.
- Added privacy-safe `intelligence` route-decision evidence for optimizer candidates, token estimates, budget risk, quality gate events, and async eval queue state.
- Added metadata columns on call logs and route decisions for optimizer applied state, estimated cost/savings, token prediction risk, quality gate status, and async eval queued state.
- Added `GET /api/dashboard/intelligence/summary` for metadata-only optimizer, token risk, async eval, and quality gate summaries grouped by agent and node.
- Added Dashboard Overview and Route Explanation surfaces for Intelligence Loop evidence with seven-locale copy for `en`, `zh`, `zh-TW`, `ja`, `ko`, `th`, and `es`.
- Added `docs/INTELLIGENCE_LOOP.md` plus config example, API reference, Dashboard, and architecture documentation for v2.2 operations.

### Changed

- Cost optimization remains evidence-only unless `intelligence.cost_optimizer.action=optimize` is explicitly configured.
- Token Prediction can reject or request downgrade only through explicit budget policy; default behavior records evidence without changing traffic.
- Quality Gate retries/fallbacks are limited to non-streaming responses before bytes are sent. Streaming requests record a `streaming_no_post_start_retry` skip reason.
- Updated release metadata to v2.2.0 across the root package, Dashboard package, TypeScript client, Python package, Helm chart, Kubernetes base manifest, OpenAPI document metadata, README, package locks, and release-version sync coverage.

### Boundaries

- Intelligence Loop does not store prompts, responses, raw provider headers, provider keys, Gateway API key plaintext, source code, diffs, tool payloads, MCP payloads, media bytes, hidden reasoning text, or resolved secrets by default.
- Async Eval v1 is metadata-only by default and does not make inline eval mandatory.
- Optimizer and token prediction do not bypass workspace isolation, RBAC, Gateway API key permissions, endpoint/model/node policy, budgets, circuit breakers, or fallback policy.

## 2.1.0 - 2026-05-09

### Added

- Added the v2.1 Coding Agent Gateway release for the OSS data plane: workspace-scoped Agent Profiles now render governed setup snippets for Cursor, Cline, Roo Code, Continue, Codex, Claude Code, OpenCode, Generic OpenAI-compatible coding agents, and Generic Anthropic-compatible coding agents.
- Added coding-agent virtual model aliases `coding-auto`, `coding-fast`, `coding-deep`, and `coding-security`, mapped to internal smart-routing hints without forcing one upstream provider.
- Added metadata-only coding-agent observability across canonical request metadata, call logs, route-decision traces, Dashboard session summaries, and Route Explanation serialization.
- Added allowlisted safe coding-agent headers for session id, turn id, connector, repo label, and project label, with normalization/truncation instead of raw-header storage.
- Added Dashboard **Agents** recent-session summaries with request count, cost, latency, connector/repo/project breakdowns, and links to session traces.
- Added connector logo assets and seven-locale Dashboard copy for the new Coding Agent Gateway connectors, virtual model labels, setup snippets, privacy copy, empty states, and errors.
- Added `docs/CODING_AGENT_GATEWAY.md` with connector setup, safe headers, virtual aliases, and the Engineering PR Review Workspace North Star demo.

### Changed

- Updated `/v1/models` agent-profile virtual model exposure so Gateway API keys can see profile `smart_model_id` values plus the coding aliases when `allow_auto` permits smart routing.
- Updated Agent Profile rendering to prefer coding aliases for coding-agent connectors while preserving existing Cherry Studio, Hermes, OpenClaw, Claude-style, and generic connector compatibility.
- Updated Dashboard sessions APIs to group by `agent_session_id` when present and to filter by `agent_connector`, `agent_repo`, and `agent_project`.
- Updated docs, README positioning, API reference, Dashboard docs, and release metadata to v2.1.0.

### Boundaries

- Coding Agent Gateway does not store source code, prompts, responses, diffs, tool payloads, raw repository content, raw provider headers, provider keys, Gateway API key plaintext, hidden reasoning text, media bytes, or resolved secrets by default.
- Coding aliases are advisory and profile-scoped. They do not bypass workspace isolation, RBAC, Gateway API key permissions, budgets, allowed models/nodes/modalities, circuit breakers, fallback policy, or audit boundaries.
- v2.1.0 does not add a workflow engine, hosted cloud dependency, provider-key exposure in agent configs, or coding-agent vendor lock-in.

## 2.0.0 - 2026-05-09

### Added

- Shipped Platform Trust GA for the OSS data plane: workspace isolation, local Dashboard RBAC, optional OIDC login and invites, PostgreSQL production guidance, Redis shared-state cluster mode, management audit logs, upgrade hardening, and repeatable benchmark evidence are now the stable v2.0 baseline.
- Added a Dashboard first-run checklist that guides operators through active workspace, provider node, Gateway API key, first request, and logs/route/cost evidence without adding new storage or hosted dependencies.
- Added committed GA sample benchmark reports in JSON and Markdown under `docs/reports/`.

### Changed

- Finalized README and docs positioning around "open-source AI infrastructure platform for teams and agents".
- Updated `docs/PERFORMANCE.md` with v2.0.0 GA benchmark methodology and report links while keeping the rc.2 report as release-candidate history.
- Updated release metadata to v2.0.0 across the root package, Dashboard package, TypeScript client, Python package, Helm chart, Kubernetes base manifest, OpenAPI document metadata, README, package locks, release-version sync coverage, and benchmark script output.
- Reviewed seven-locale Dashboard copy for the GA first-run path: `en`, `zh`, `zh-TW`, `ja`, `ko`, `th`, and `es`.

### Fixed

- Restored OpenAI-style Responses cache accounting for providers that report cache hits under `usage.input_tokens_details.cached_tokens`, so OpenAI-compatible responses now propagate cached-token usage into gateway responses, streaming serializers, and `call_logs.cache_read_input_tokens` instead of silently dropping provider-side cache hits.
- Moved the Dashboard theme bootstrap out of inline HTML so the production app stays compatible with Helmet's default content-security policy without console CSP errors.

### Boundaries

- v2.0.0 GA does not add API resale/recharge flows, mandatory cloud dependency, SCIM/LDAP, organization billing, full DAG workflow orchestration, or broad provider-count expansion.
- The first-run checklist and benchmark reports do not store prompts, responses, raw provider headers, provider keys, media bytes, tool payloads, hidden reasoning text, or resolved secrets by default.

## 2.0.0-rc.2 - 2026-05-09

### Added

- Added `npm run benchmark:platform`, a deterministic local benchmark harness that starts a mock upstream plus real SiftGate AppModule instances and measures direct mock, non-streaming proxy, streaming proxy, `model=auto` smart routing, metadata-only call-log write, and Dashboard benchmark-report read overhead.
- Added optional benchmark coverage for PostgreSQL production metadata mode, Redis shared-state/cluster mode, and live direct-upstream baselines when explicit environment variables are provided.
- Added committed rc.2 sample benchmark reports in JSON and Markdown under `docs/reports/`.
- Added unit coverage for the platform benchmark script, including JSON/Markdown output, privacy flags, measured SQLite scenarios, and skipped optional Postgres/Redis behavior.

### Changed

- Expanded `docs/PERFORMANCE.md` with v2.0.0-rc.2 benchmark methodology, environment variables, scenario definitions, limitations, rerun instructions, and GA re-measurement requirements.
- Added `benchmark:platform` alongside the existing `benchmark:upstream` command so deterministic local measurements and existing-gateway/live-upstream measurements are clearly separated.
- Updated release metadata to v2.0.0-rc.2 across the root package, Dashboard package, TypeScript client, Python package, Helm chart, Kubernetes base manifest, OpenAPI document metadata, README, package locks, and release-version sync coverage.

### Boundaries

- rc.2 benchmark numbers are release-candidate measurements from a local deterministic mock upstream. They must be re-measured before v2.0.0 GA if runtime behavior changes.
- The benchmark harness and reports do not store prompts, responses, raw provider headers, provider keys, media bytes, tool payloads, hidden reasoning text, or resolved secrets by default.

## 2.0.0-rc.1 - 2026-05-09

### Added

- Added workspace-scoped platform management audit events for Dashboard management operations, including actor id/type, organization/workspace, action, resource type/id, redacted before/after summaries, request id, timestamp, result status, metadata, and hash-chain fields.
- Added centralized audit writing and RBAC-denied audit coverage so successful, failed, and denied management operations have consistent metadata-only evidence.
- Added the Dashboard Audit Log page with filters, event details, hash-chain evidence, and seven-locale copy for `en`, `zh`, `zh-TW`, `ja`, `ko`, `th`, and `es`.
- Added `GET /api/dashboard/audit` and OpenAPI response schemas for management audit event lists, pagination, and explicit privacy flags.
- Added `management_audit_events` schema creation and SQLite-to-PostgreSQL migration coverage.

### Changed

- `siftgate migrate-v2 --dry-run` now supports `--output`, `--report`, `--out`, and `-o` for writing the stable JSON dry-run report to disk without mutating production data.
- Config audit bridge events now also write redacted platform management audit entries where appropriate, while preserving existing local config audit and rollback behavior.
- Updated production, Dashboard, API reference, v1.9-to-v2 migration, README, OpenAPI, Kubernetes, Helm, and release metadata to v2.0.0-rc.1.

### Boundaries

- Management audit rows do not store provider keys, Gateway API key plaintext, prompts, responses, raw provider headers, media bytes, tool payloads, hidden reasoning text, or resolved secrets by default.
- Audit logs are read-only from the Dashboard and remain local to the OSS data plane.

## 2.0.0-beta.1 - 2026-05-09

### Added

- Added optional generic OIDC Dashboard login with discovery, authorization-code callback handling, userinfo identity mapping, allowed-domain checks, default role/workspace mapping, and local Dashboard JWT issuance.
- Added OIDC config under `dashboard.oidc` plus `dashboard.session_secret` support for stable Dashboard sessions when OIDC is enabled without a local password.
- Added workspace invitation metadata with role, workspace, optional email, expiry, status, one-time plain invite link return, SHA-256 token hashing at rest, local-login acceptance, OIDC acceptance, and revoke/list Dashboard APIs.
- Added Members page invitation creation/list/revoke UI and Login page SSO entry with seven-locale copy for `en`, `zh`, `zh-TW`, `ja`, `ko`, `th`, and `es`.
- Added provider docs/templates for Google, GitHub OIDC-capable setups, and Azure AD / Entra ID.

### Changed

- `GET /api/auth/status` now returns local login and privacy-safe OIDC public status metadata while preserving the existing `authRequired` field.
- Dashboard auth remains backwards-compatible: installs without `dashboard.password` or OIDC stay open, and local password login still works when configured.
- Updated config examples, env examples, production docs, security docs, and release metadata to v2.0.0-beta.1.

### Boundaries

- OIDC is disabled by default, does not require SiftGate Cloud, and does not force SSO for local installs.
- OIDC client secrets are resolved through the existing secret-reference path and are never returned by Dashboard APIs.
- No SCIM, LDAP, or built-in email delivery was added in this release.
- Invitation and OIDC state do not store prompts, responses, raw provider headers, provider keys, media bytes, tool payloads, hidden reasoning text, resolved secrets, or reusable invite tokens by default.

## 2.0.0-alpha.4 - 2026-05-09

### Added

- Added coherent Redis shared-state cluster mode for multi-instance OSS data-plane deployments with workspace-scoped runtime keys: `<prefix>ws:<workspace-id>:<category>:<key>`.
- Added per-category state backend policies and TTLs for `rate_limit`, `circuit_breaker`, `cache_affinity`, `momentum`, `prompt_cache`, `concurrency`, `health_probe`, and `realtime_session`.
- Added shared Redis-backed runtime coordination for API/login rate limits, circuit state, cache affinity, routing momentum, prompt cache lookups, metadata-only concurrency summaries, metadata-only active health probe summaries, and metadata-only realtime/session summaries.
- Added `GET /api/dashboard/cluster` for authenticated Dashboard viewers to inspect privacy-safe local node id, state backend, Redis connectivity, recent state errors, instance count, and per-category policy/TTL status even when cluster mode is disabled.
- Added a Dashboard cluster state summary card with seven-locale copy for `en`, `zh`, `zh-TW`, `ja`, `ko`, `th`, and `es`.

### Changed

- `GET /cluster/status` remains the operator endpoint for enabled Redis-backed cluster mode, while Dashboard now uses the always-available privacy-safe local summary endpoint.
- Updated production, state-backend, Docker, Kubernetes, Helm, config example, and environment example docs with alpha.4 Redis shared-state and cluster-mode guidance.
- Updated release metadata to v2.0.0-alpha.4 across the root package, Dashboard package, TypeScript client, Python package, Helm chart, Kubernetes base manifest, OpenAPI document metadata, README, package locks, and release-version sync coverage.

### Boundaries

- Redis remains optional. Single-node memory state, local SQLite startup, local Dashboard login, and Docker quickstart behavior remain unchanged.
- Redis shared state does not store prompts, responses, raw provider headers, provider keys, media bytes, tool payloads, hidden reasoning text, or resolved secrets by default. Prompt-cache response storage still requires the existing explicit cache opt-in.

## 2.0.0-alpha.3 - 2026-05-09

### Added

- Added a hardened PostgreSQL production path with connection-pool settings, SSL options, fail-fast database config validation, and redacted startup diagnostics.
- Added `/ready` for load balancers and Kubernetes readiness probes. It checks database availability only, while `/health` continues to report provider/node degradation separately.
- Added database health details to `/health`, including database type, redacted target, connectivity, latency, synchronize mode, pool summary, and SSL summary.
- Added PostgreSQL pool/SSL config examples across `gateway.config.example.yaml`, `.env.example`, Docker Compose, Helm values, and Kubernetes Secret examples.
- Added tests for PostgreSQL config validation, TypeORM option generation, database health/readiness behavior, and RBAC workspace membership migration coverage.

### Changed

- Kubernetes and Docker Compose readiness/healthcheck defaults now use `/ready` so upstream provider degradation does not remove an otherwise healthy gateway instance from service.
- SQLite remains the default local/dev database with schema sync enabled; PostgreSQL now defaults to `synchronize: false` in runtime option generation unless explicitly overridden.
- SQLite-to-PostgreSQL migration now includes `workspace_memberships` so alpha.2 RBAC data is preserved on production migration.
- Updated production, state-backend, Docker, Kubernetes, and Helm docs with backup, migration, readiness, pool, SSL, and validation guidance.
- Updated release metadata to v2.0.0-alpha.3 across the root package, Dashboard package, TypeScript client, Python package, Helm chart, Kubernetes base manifest, OpenAPI document metadata, README, package locks, and release-version sync coverage.

### Boundaries

- SQLite support and the zero-friction local quickstart remain unchanged.
- No new ORM or migration framework was introduced.
- PostgreSQL integration tests are skipped unless a local PostgreSQL service is explicitly available; deterministic config and migration tests cover the generated production path.

## 2.0.0-alpha.2 - 2026-05-09

### Added

- Added local Dashboard RBAC for workspace governance with `admin`, `operator`, and `viewer` roles backed by a new `workspace_memberships` table.
- Bootstrapped the existing local Dashboard identity as an active Admin in `default-workspace` during fresh installs and v1.9-to-v2 upgrades.
- Added centralized Dashboard permission helpers, decorators, and guards so role checks are shared across Dashboard controllers instead of being implemented ad hoc.
- Added Dashboard member APIs: `GET /api/dashboard/members` and `PUT /api/dashboard/members/:id` for Admin-managed local role updates.
- Added a Dashboard Members page, role badges in the header, and permission-aware disabled controls/tooltips for high-risk management actions.
- Added seven-locale RBAC and member-management copy for `en`, `zh`, `zh-TW`, `ja`, `ko`, `th`, and `es`.

### Changed

- Dashboard read APIs default to Viewer access, operational writes require Operator where safe, and Admin-only actions cover member management, Gateway API keys, budgets, teams, workspace settings, destructive operations, and config rollback.
- Added a guardrail that prevents disabling or demoting the last active workspace Admin.
- Updated release metadata to v2.0.0-alpha.2 across the root package, Dashboard package, TypeScript client, Python package, Helm chart, Kubernetes base manifest, OpenAPI document metadata, README, package locks, and release-version sync coverage.

### Boundaries

- SSO/OIDC, custom permission expressions, invitations, and cloud/enterprise identity features remain out of scope for alpha.2.
- Provider secrets, raw headers, prompts, responses, media bytes, tool payloads, hidden reasoning text, and resolved secrets remain excluded from Dashboard role responses and member APIs.

## 2.0.0-alpha.1 - 2026-05-08

### Added

- Introduced the Workspace Core foundation with local `organizations` and `workspaces` entities, default `default-org` / `default-workspace` bootstrap, and safe default workspace mapping for fresh installs and v1.9 upgrades.
- Added workspace ownership metadata across persisted API keys, local teams, budgets, nodes/status projections, agent profiles, call logs, route decision traces, eval metadata, batch jobs, MCP/shadow/provider-compatibility/video/config metadata, and related dashboard services.
- Added workspace context resolution for Dashboard sessions and Gateway API keys, including safe fallback to `default-workspace` for legacy keys and rows without a workspace id.
- Added Dashboard workspace APIs: `GET /api/dashboard/workspaces` and `POST /api/dashboard/workspaces/switch`.
- Added a compact Dashboard header workspace selector and workspace-aware Dashboard API client headers with seven-locale copy for `en`, `zh`, `zh-TW`, `ja`, `ko`, `th`, and `es`.
- Added unit and E2E coverage for default workspace bootstrap, migration backfill, context resolution, legacy API key compatibility, and Dashboard workspace filtering.

### Changed

- Extended the SQLite-to-PostgreSQL migrator to include default organization/workspace rows and normalize workspace-scoped rows into `default-workspace` when migrating v1.9-style databases.
- Updated migration, Dashboard, and roadmap documentation for the alpha.1 workspace foundation while preserving the v1.9.2 read-only dry-run contract.
- Updated release metadata to v2.0.0-alpha.1 across the root package, Dashboard package, TypeScript client, Python package, Helm chart, Kubernetes base manifest, OpenAPI document metadata, README, package locks, and release-version sync coverage.

### Boundaries

- RBAC, OIDC, invitations, organization billing, full multi-workspace provisioning, and production PostgreSQL hardening remain scheduled for later v2.0 prompts.
- Existing `/v1/*` ingress compatibility, legacy Gateway API keys, local SQLite startup, Docker quickstart behavior, and metadata-only privacy boundaries are preserved.

## 1.9.2 - 2026-05-08

### Added

- Added `docs/MIGRATION_V1_TO_V2.md` to document how existing v1.9 single-tenant config and metadata rows will map into the future v2 default organization/workspace.
- Added a read-only `siftgate migrate-v2 --dry-run` CLI command with stable JSON and human-readable output for API keys, local teams, namespaces, nodes, budgets, routing policies, agent profiles, call logs, eval rows, MCP servers, batch jobs, and Dashboard user counts.
- Added fixture coverage for a v1.9-style gateway config plus dry-run tests for normal SQLite, empty SQLite, missing SQLite, PostgreSQL planning, missing config blockers, CLI JSON output, dry-run enforcement, and human-readable formatting.

### Changed

- Updated release metadata to v1.9.2 across the root package, Dashboard package, TypeScript client, Python package, Helm chart, Kubernetes base manifest, OpenAPI document metadata, README, package locks, and release-version sync coverage.

## 1.9.1 - 2026-05-08

### Added

- Added the v2.x platform roadmap for the OSS Data Plane, positioning SiftGate as an AI infrastructure platform for teams and agents while keeping the v2.0.0 Platform Trust scope separate from later minor-release capabilities.
- Added a release checklist covering version sync files, required tests, seven-locale review, branch/PR/merge/tag/GitHub release steps, rollback discipline, and privacy review.
- Added release-discipline documentation for the v2.x release train.
- Added a read-only `npm run release:check` command that verifies release version alignment across packages, OpenAPI metadata, Helm, Kubernetes, README, and changelog without pushing, tagging, or creating releases.

### Changed

- Updated release metadata to v1.9.1 across the root package, Dashboard package, TypeScript client, Python package, Helm chart, Kubernetes base manifest, OpenAPI document metadata, README, package locks, and release-version sync coverage.

## 1.9.0 - 2026-05-08

### Added

- Released Agent Gateway Profiles for the MIT OSS Data Plane with a first-class Dashboard **Agents** page and local Dashboard APIs for creating, editing, deleting, listing, and rendering agent/client connection profiles.
- Added connector templates for Codex, Claude Code, Cherry Studio, Hermes, OpenClaw, Generic OpenAI-compatible clients, and Generic Anthropic-compatible clients so agents and chatbot tools can use SiftGate without guessing base URLs or model wiring.
- Added profile-scoped smart virtual models, including `claude-siftgate-auto`, so Claude-style clients can request a connector-safe model that maps to internal smart routing instead of direct Claude model routing.
- Added secret-safe rendered configs that use Gateway API key placeholders and masked metadata only; provider keys remain in Nodes, env vars, or secret references and stored Gateway API key plaintext is never exposed.
- Added full seven-language Dashboard localization for Agent Profiles across `en`, `zh`, `zh-TW`, `ja`, `ko`, `th`, and `es`, plus a static Agent Profiles localization check in the frontend test chain.
- Added real connector identity assets for the Agent Profiles picker, including Codex, Claude Code, Cherry Studio, Hermes Agent, OpenClaw, Generic OpenAI, and Generic Anthropic.

### Changed

- Agent Profile traffic reuses existing SiftGate governance and observability: Gateway API keys, namespaces, budgets, rate limits, endpoint/model/node/modality policy, metadata-only logs, sessions, route explanations, and MCP endpoint permissions all continue to apply.
- `/v1/models` now exposes Agent Profile virtual models only in the matching active profile and Gateway API key context.
- Smart-router-only Agent Profile model listings now avoid exposing direct/provider model clutter to clients such as Cherry Studio, while direct routing in the Dashboard can select from configured node models instead of relying on free-text model entry.
- Dashboard Logs now distinguishes streaming vs sync delivery and labels request duration as total response time, reducing confusion when streamed answers take longer because more content is returned.
- The Agent Profiles edit dialog layout was tightened for CJK locales, with aligned connector logos, stable connector card rows, and top-aligned API key/status/namespace fields.
- Release metadata is aligned to v1.9.0 across the root package, Dashboard package, TypeScript client, Python package, Helm chart, Kubernetes base manifest, OpenAPI document metadata, and release-version sync coverage.

## 1.8.5 - 2026-05-08

### Fixed

- Fixed the Dashboard API key and local team permission picker layout so the allowed endpoint/modality selectors no longer overlap in the create/edit modal at constrained widths or in CJK locales.
- Improved permission picker selection ergonomics with a clearer "all items" state, bounded selected chips, and visible-item select/deselect controls across all Dashboard locales.

## 1.8.4 - 2026-05-08

### Fixed

- Preserved explicit routing order for Responses-compatible targets so configured smart-routing priority remains stable when resolving upstream compatibility.

## 1.8.3 - 2026-05-07

### Fixed

- Clarified Dashboard call logs by renaming the source-format column to ingress protocol and adding a separate upstream protocol column derived from the configured node protocol, so GPT/Claude requests entering through Chat Completions no longer appear to be forwarded with the wrong upstream API.
- Updated log detail localization across Dashboard locales so ingress protocol and upstream protocol are consistently distinguishable in expanded call log rows.

## 1.8.2 - 2026-05-07

### Fixed

- Fixed Responses upstream request denormalization so assistant history is forwarded with `output_text` content parts while user content remains `input_text`, preventing OpenAI Responses-compatible gateways from rejecting multi-turn direct GPT requests and triggering unintended fallback chains.

## 1.8.0 - 2026-05-06

### Added

- Released the v1.8.0 Canonical Catalog Normalization + Node UX Cleanup minor for the MIT OSS Data Plane, focusing on unifying provider/model source-of-truth boundaries, reducing stale catalog defaults, and making the Dashboard operator path clearer without introducing cloud-only dependencies.
- Added an internal OpenRouter-first canonical model registry materialization layer on top of the existing catalog refresh/sync pipeline, so SiftGate can keep one primary canonical model dataset for ids, aliases, architecture, supported parameters, context, top-provider metadata, and reference pricing without turning that registry into a second operator-facing catalog.
- Added a stricter ZeroEval canonical enrichment overlay with explicit match strategy, match confidence, matched-from evidence, and diagnostics for unmatched or low-confidence rows, allowing lifecycle, throughput, benchmark, multimodal/spec, and secondary pricing metadata to attach to canonical models instead of only a few built-in exact provider/model matches.
- Added provider-projection metadata and Dashboard API fields for `provider_status`, `default_visible`, `replacement_provider_id`, `canonical_model_coverage`, `pricing_coverage`, `recommended_model_buckets`, `recommended_models`, `latest_model_hints`, `enrichment_summary`, `canonical_id`, `projection_source`, `lifecycle`, `specs`, `benchmarks`, `pricing_sources`, and `match_confidence`.
- Added shared catalog signal UI across Nodes, Add Node, and Provider Catalog so operators now see consistent status badges, canonical/pricing coverage, recommended model previews, and trust-copy about OpenRouter and ZeroEval reference pricing.

### Changed

- OpenRouter sync no longer acts only like an `openrouter` provider refresh. It now drives the internal canonical model primary dataset, while the merged provider catalog remains the single public operator-facing surface.
- ZeroEval enrichment now layers onto canonical models first, then flows through provider projections. OpenRouter reference pricing remains primary, ZeroEval pricing remains secondary and review-required, and the established pricing precedence is unchanged: explicit `nodes[].model_capabilities.<model>.pricing`, `models_pricing`, `catalog.override.yaml`, sync cache, then built-in/fallback catalog references.
- Built-in static provider model lists were demoted from primary truth to transport seed/fallback/reference data when canonical projections exist. Historical stale provider/model rows are now classified as `active`, `transport_only`, `deprecated`, `legacy_alias`, or `custom` instead of continuing to look equally authoritative in the default UI path.
- Dashboard Nodes now separates configured upstreams from catalog onboarding; Add Node now defaults to active providers and canonical recommended buckets instead of stale alphabetical model guesses; Provider Catalog now explains catalog truth, coverage, and trust signals without presenting multiple competing provider/model truths.
- Release metadata is aligned to v1.8.0 across the root package, Dashboard package, TypeScript client, Python package, Helm chart, Kubernetes manifest, OpenAPI document metadata, and release-version sync coverage.

## 1.7.0 - 2026-05-06

### Added

- Released the v1.7.0 Catalog Enrichment + Fresh Model Defaults minor for the MIT OSS Data Plane, focusing on fresher catalog-backed model metadata, better default model recommendations, and pricing-prefill ergonomics instead of horizontal provider-count expansion or cloud-only features.
- Added a ZeroEval-backed catalog enrichment adapter to the existing refresh/sync pipeline so SiftGate can ingest third-party reference metadata for already-known provider/model pairs, write it into the managed local sync cache, and expose the source in CLI sync status and Dashboard catalog APIs without making ZeroEval a runtime dependency.
- Added v1.7 model enrichment metadata to the merged catalog schema and Dashboard catalog APIs, including lifecycle fields, specs, benchmark containers, source metadata, and operator-visible enrichment summaries for future provider/model governance surfaces.
- Added backend-generated `recommended_model_buckets`, `latest_model_hints`, and `recommended_models` to provider catalog responses so Dashboard Add Node defaults can prefer newer stable models with usable pricing metadata while preserving the full model list for search and manual edits.
- Added Provider Catalog and Add Node operator-facing enrichment UI for release date, max context, throughput, selected benchmark snippets, and trust-copy that explains catalog pricing is a review-required default reference rather than a billing authority.

### Changed

- Dashboard Add Node now defaults model buckets and pricing rows from the new recommended-model metadata instead of naively taking the first alphabetically sorted catalog models, which prevents common stale-snapshot defaults when merged catalog data is fresher than built-in ordering.
- Merged catalog pricing prefill now accepts ZeroEval reference input/output pricing for supported provider/model mappings and normalizes it into existing token price fields, while keeping the established pricing precedence unchanged: explicit `nodes[].model_capabilities.<model>.pricing`, `models_pricing`, `catalog.override.yaml`, sync cache, then built-in catalog.
- Catalog sync status, refresh-source reporting, config validation, tests, and CLI help now recognize ZeroEval alongside OpenRouter while keeping OpenRouter's existing adapter behavior unchanged.
- Release metadata is aligned to v1.7.0 across the root package, Dashboard package, TypeScript client, Python package, Helm chart, Kubernetes manifest, and release-version sync coverage.

## 1.6.0 - 2026-05-06

### Added

- Released the v1.6.0 Provider Cache Intelligence minor for the MIT OSS Data Plane, focusing on provider-cache-aware usage normalization, operator-visible savings, and cache-aware routing bias instead of new provider breadth or cloud-only features.
- Added a provider usage-schema registry on compatibility profiles so SiftGate can declare official response paths for usage, cache-read, and cache-write token fields instead of hardcoding every provider family inside the transport layer.
- Added provider-cache savings analytics for the OSS Dashboard, including `GET /api/dashboard/cache-savings`, grouped savings/hit-rate summaries, daily trends, and a new `cost_without_cache_usd` call-log field for actual-vs-no-cache comparisons.
- Added Dashboard cache-savings visualizations across Overview, Analytics, Logs, and Budget so operators can see provider-cache savings, hit rate, cost mix, and per-request cache evidence without exposing prompts, responses, raw headers, or provider keys.
- Added cache session affinity routing for provider-cache-capable nodes, including per-session route history, optional Redis-backed state hydration, TTL-aware affinity activation, and Route Decision evidence for affinity reason, bonus, TTL, last hit age, and estimated hit probability.

### Changed

- Non-streaming provider normalization and the chat/responses/messages stream parsers now resolve usage fields from compatibility-profile schemas first, while preserving the previous hardcoded extraction path as a backward-compatible fallback for nodes without a known profile.
- Responses streaming serialization now writes both `usage.prompt_tokens_details.cached_tokens` and legacy `usage.input_token_details.cached_tokens` so modern OpenAI-style cache accounting and older SDK expectations stay aligned.
- Refreshed built-in cache-aware pricing references from official docs for Gemini 3.1 preview models and DeepSeek v4 compatibility mappings, and re-verified the current OpenAI and Anthropic cache pricing metadata.
- Call logs now persist cache-aware and no-cache cost views together, while the SQLite/PostgreSQL schema patch and SQLite-to-PostgreSQL migrator both recognize the new `cost_without_cache_usd` column.
- Balanced, cost, and least-latency routing can now apply a bounded cache-affinity bonus when the same session recently confirmed provider-side cache hits on a matching node/model, while still respecting circuit-breaker availability and fallback behavior.
- Route Explanation, localization bundles, and the example gateway config now document cache-affinity routing so Dashboard evidence, config validation, and release docs stay aligned for v1.6.0 operators.

### Fixed

- The `cost_without_cache_usd` schema patch now skips empty databases that do not have `call_logs` yet, avoiding a startup-time `ALTER TABLE` failure on incomplete SQLite/PostgreSQL setups.

## 1.5.0 - 2026-05-05

### Changed

- Released the v1.5.0 Contract Hardening and Runtime Safety minor for the MIT OSS Data Plane, focusing on stable public contracts and safer runtime behavior instead of new provider breadth or cloud features.
- Tightened legacy `${VAR}` config interpolation so missing required env values now fail fast during startup and reload, while `${VAR:-default}` keeps explicit fallback semantics and `${env:VAR}` / Vault / AWS / GCP references keep runtime resolution behavior.
- Added one public gateway error mapping layer for OSS ingress so gateway-generated public errors keep consistent `message`, `type`, `request_id`, status semantics, and request-id headers without changing successful OpenAI / Anthropic / Batch / MCP / Video response shapes.
- Extended request-id consistency across gateway-generated non-streaming and pre-controller error paths, including parser/body-limit failures, while preserving `x-siftgate-request-id` and legacy-compatible `x-request-id`.

### Fixed

- Hot reload, Dashboard reload, rollback restore, file-watcher reload, and `SIGHUP` now reject invalid configs atomically and keep the previously active config in memory instead of replacing it with a partially resolved or broken candidate.
- Updated OpenAPI error schema and release documentation so request-id and required-env behavior are documented consistently for v1.5.0 operators upgrading from the v1.4.x line.

## 1.4.1 - 2026-05-05

### Fixed

- Released the v1.4.1 public contract consistency patch for the MIT OSS Data Plane without expanding scope into new features or breaking startup semantics.
- Unified public gateway request-id responses so gateway-generated responses now return `x-siftgate-request-id` while keeping `x-request-id` for backward compatibility, including Batch, MCP, streaming, and provider-compatible ingress paths.
- Hardened gateway-generated public error envelopes so OpenAI-compatible, Anthropic-compatible, Batch, MCP, and Video gateway errors consistently expose `message`, `type`, and `request_id` while preserving the existing outer protocol shapes.
- Updated the TypeScript client and Python SDK to prefer `x-siftgate-request-id` and then fall back to `x-request-id` and `x-correlation-id`.
- Synced the published release version across the root package, the TypeScript client package, the Python package, and OpenAPI/Swagger metadata so `/openapi.json` no longer reports a stale `0.x` version.
- Added regression coverage for public request-id headers, SDK request-id extraction, OpenAPI version sync, gateway-generated error contracts, and cross-package release version alignment.

## 1.4.0 - 2026-05-05

### Added

- Expanded the built-in Provider Catalog for v1.4 to 50+ providers, adding Hugging Face, Cloudflare Workers AI, IBM watsonx.ai, Baseten, Lepton AI, Modal, RunPod, Predibase, Lamini, AI21 Labs, fal.ai, Stability AI, Black Forest Labs, Ideogram, Luma AI, Runway, Pika, ElevenLabs, Deepgram, AssemblyAI, Cartesia, Speechmatics, LM Studio, llama.cpp server, TGI, SGLang, and Xinference.
- Added v1.4 provider governance metadata across the built-in catalog, including aliases, family/category, provider type, homepage/docs/pricing URLs, logo identity, input/output types, model buckets, batch modality metadata, compatibility profile, and review-required pricing source metadata.
- Added Dashboard/provider-logo identity coverage for the new providers so OpenAI-compatible or compatible-style providers do not fall back to the OpenAI logo.
- Added v1.4 Provider Catalog pricing source governance for the OSS Data Plane, with unified token/cache/media/rerank/realtime/batch pricing fields, source type, source URL, verification timestamps, confidence, stale windows, and review reasons.
- Added pricing evidence to Route Decision Trace and Dashboard Route Explanation, including source, confidence, stale status, resolver layer, missing price units, and estimated cost basis without exposing prompts, responses, raw headers, provider keys, or secrets.
- Added `siftgate catalog show <provider> --pricing` output for pricing governance details and extended catalog validation/export coverage for source-governed prices.
- Added Provider Catalog Dashboard UX 2.0 for the v1.4 provider ecosystem work: catalog responses now expose Dashboard-ready provider family, provider type, compatibility profile, aliases, logo id, links, model buckets, limits, and pricing-unit metadata without introducing a second catalog.
- Added a grouped Provider Catalog explorer with summary cards, family/type/modality/compatibility/price-source filters, stale/review quick filters, collapsed provider groups, detail panels, sync status, override markers, and 7-language operator copy.
- Added Add Node Wizard provider family filters, alias/model search, provider type badges, catalog identity logos, and a bounded scroll area so 50+ providers remain usable while advanced endpoint/header/pricing/health fields stay editable.
- Added v1.4 Provider Compatibility Profiles for the OSS Data Plane, with a local registry covering OpenAI-compatible, Responses-compatible, Anthropic Messages, Gemini, Vertex, Bedrock, Azure OpenAI, Hugging Face, OpenRouter, Cohere, Mistral, Ollama, vLLM, TGI, LM Studio, media generation, speech, rerank, and embedding protocol styles.
- Added `nodes[].compatibility_profile` and Provider Catalog `compatibility_profiles`, with validation for unknown profiles, provider/profile mismatch, source-format mismatch, endpoint mismatch, and modality/model-bucket mismatch.
- Added compatibility-profile routing evidence so Route Decision Trace and Dashboard Route Explanation can show selected/filtered profiles, endpoint/protocol strategy, passthrough fields, downgraded fields, unsupported fields, and profile filter reasons without storing prompts, responses, raw headers, provider keys, media bytes, or video bytes.
- Added compatibility-profile-aware safe probes for the Provider Compatibility Matrix, including batch endpoint/auth probing alongside chat, responses, messages, embeddings, rerank, images, audio, video, and realtime.
- Added Dashboard Provider Catalog, Nodes, Add Node Wizard, Route Explanation, and Logs localization for compatibility profile metadata across all seven OSS Dashboard languages.
- Added `docs/PROVIDER_COMPATIBILITY.md` and updated API, architecture, dashboard, provider catalog, config example, and CLI documentation for compatibility profiles.

### Changed

- Unified legacy provider catalog diagnostics with the merged built-in Provider Catalog so Dashboard APIs, Add Node Wizard presets, catalog CLI, and config validation all read the same provider/model data.
- Config validation now reports catalog auth-type mismatches for known providers and marks unknown providers as custom catalog entries without blocking single-node startup.
- Cost and balanced routing, Benchmark reports, config validation, Dashboard catalog APIs, catalog overrides, sync cache, and built-in catalog fallback now use the same pricing resolver priority: explicit node/model pricing, `models_pricing`, `catalog.override.yaml`, sync cache, then built-in catalog.
- Dashboard and docs use “Price source status”, “Review required”, and “Stale” wording for operator-facing pricing copy; internal `pricing_hygiene` fields remain for API compatibility.
- Dashboard Logs and Route Explanation candidate tables now render provider identity icons from node/model hints so compatible providers remain visually distinct from OpenAI fallbacks.

## 1.3.2 - 2026-05-05

### Added

- Added a localized, animated Dashboard Sidebar scroll hint that appears only while additional navigation items remain below the visible scroll area.

## 1.3.1 - 2026-05-05

### Fixed

- Fixed Dashboard Sidebar overflow when the navigation list grows beyond the viewport. The logo and health/language footer now stay visible while the middle navigation region scrolls independently.
- Stabilized the local e2e quality gate by running e2e suites serially, avoiding shared temporary config races between Dashboard reload and realtime WebSocket tests.

## 1.3.0 - 2026-05-05

### Added

- Added v1.3 local Virtual Key + Team management for the OSS Data Plane. Dashboard-generated Gateway API keys can now bind to local teams with team-level namespace, allowed node/model, endpoint/modality, budget, and rate-limit policy.
- Added `local_teams` persistence on SQLite/PostgreSQL, `team_id` attribution in call logs, and team-scoped budget rules that are checked alongside global, namespace, and key budgets.
- Added Dashboard APIs `GET/POST/PUT/DELETE /api/dashboard/teams` with sanitized audit events for team create/update/delete, plus 7-language Dashboard Team management UI on the API Keys page.
- Added migration coverage for local teams and key/team metadata while preserving one-time-only Gateway API key secret behavior and masked list responses.
- Added the v1.3 local Evaluation Framework preview for the OSS Data Plane, with metadata-only dataset, experiment run, and per-sample result storage on SQLite/PostgreSQL.
- Added LLM-as-judge primary-vs-candidate comparison through the normal SiftGate routing pipeline, reporting success, latency, cost, fallback, judge score, and winner without introducing hosted enterprise services.
- Added Dashboard APIs `GET /api/dashboard/evals/reports`, `GET /api/dashboard/evals/reports/:id`, and local automation endpoint `POST /api/dashboard/evals/runs`.
- Added a read-only Dashboard Eval Reports page with 7-language localization and static frontend checks.
- Added config validation and example settings for `evaluation.store_samples`; prompt/response previews remain disabled by default and require explicit opt-in plus redaction.
- Added SQLite-to-PostgreSQL migration coverage for `eval_datasets`, `eval_experiment_runs`, and `eval_sample_results`.
- Added v1.3 Semantic Cache preview with disabled-by-default local memory similarity metadata, namespace/API key/model/team isolation, Route Explanation evidence, and optional replay only when `semantic_cache.store_responses=true`.
- Added `docs:check`, a static documentation safety check for required community assets, broken relative Markdown links, private repository references, committed `gateway.config.yaml`, and common secret patterns.
- Added Quickstart, SDKs, Playground, Batch, Caching, Security, contribution, code of conduct, issue template, and PR template community assets for the OSS Data Plane.

### Changed

- Reworked README as a concise open-source product entry for v1.3.0 and removed private/enterprise repository references from the public entrypoint.

## 1.2.0 - 2026-05-05

### Added

- Added v1.2 MCP Gateway preview with local `mcp.servers` registry, `POST /mcp/:serverId` JSON-RPC proxying, Gateway API key auth, endpoint permission checks, namespace allow-lists, rate limiting, and secret-reference-aware upstream headers.
- Added `GET /api/dashboard/mcp` plus a Dashboard MCP Gateway page showing local MCP servers, static tools, recent metadata-only calls, and error summaries without storing tool input/output, raw headers, provider keys, or resolved secret values.
- Added MCP config validation, frontend 7-language localization, Dashboard static checks, and unit coverage for proxy privacy, permission enforcement, namespace enforcement, and config diagnostics.
- Added the v1.2 OpenAI-compatible Batch API proxy with `POST /v1/batches`, `GET /v1/batches/:id`, `POST /v1/batches/:id/cancel`, `GET /v1/batches/:id/output`, and `GET /v1/batches/:id/errors`.
- Added local `batch_jobs` metadata storage for request id, provider batch id, node/model hint, endpoint, file ids, request counts, status, timestamps, API key/namespace attribution, metadata keys, and sanitized errors without storing input JSONL, output JSONL, raw headers, provider keys, or file bytes.
- Added Dashboard Batch Jobs page and `GET /api/dashboard/batches`, including 7-language localization, endpoint permission copy, read-only filters, status cards, and privacy/static frontend checks.
- Added Batch endpoint configuration fields, config validation, SQLite-to-PostgreSQL migration coverage, call-log/benchmark source-format support, and e2e coverage for create/status/cancel/output proxying and endpoint-permission enforcement.
- Added v1.2 prompt-cache-aware routing evidence for the OSS Data Plane. Routing now records local prompt-cache lookup state, provider prompt-cache/read-cache/write-cache capability, observed provider cache-read hit rate, cache read/write token counters, cache-adjusted cost estimates, and cache savings in Route Decision Trace without storing prompts, responses, raw headers, provider keys, media bytes, or video bytes.
- Added cache-aware Dashboard Route Explanation evidence, Logs cache routing-effect copy, and Benchmark cache-impact summaries with 7-language localization.
- Added prompt-cache capability flags (`prompt_cache`, `read_cache`, `write_cache`) to node/model capability schema and cache read/write pricing metadata for model pricing/catalog fallback.
- Added the v1.2 Model Pricing Sync framework for the OSS Data Plane. Catalog sync is disabled by default, requires explicit provider adapters, initially supports OpenRouter only, and can write public model/pricing metadata into a SiftGate-managed local cache without overwriting operator `catalog.override.yaml` entries.
- Added `siftgate catalog sync openrouter`, local catalog sync-cache merge support, Dashboard sync status metadata, and config validation warnings for missing or unsupported sync adapters.

### Changed

- Cost and balanced optimization can prefer provider paths with lower cache-read prices or observed provider cache hits while preserving the existing local prompt cache short-circuit behavior.
- Benchmark cache rates now include local prompt-cache hits and provider cache-read hits, with separate provider/local breakdowns in `cache_summary`.
- Provider Catalog responses now include scheduled sync status, last sync time, source URL, confidence, and stale state so operators can tell which prices came from automatic sync, docs review, local cache, or explicit override.

## 1.1.0 - 2026-05-05

### Added

- Added the v1.1 lightweight Python SDK scaffold under `packages/python`, with a stdlib-only synchronous `SiftGateClient`, typed package metadata, Gateway API key auth, routing hints, structured errors, raw response access, and helpers for models, chat completions, responses, messages, embeddings, rerank, images, audio, and async video jobs.
- Added Python SDK unit tests and the root `npm run test:python-sdk` quality-gate script for local package verification without publishing to PyPI.
- Added a v1.1 Dashboard Playground page for operator-triggered safe probes across chat, responses, messages, embeddings, rerank, images, audio, video, and realtime capability checks.
- Added `POST /api/dashboard/playground/run`, a dashboard-session protected probe endpoint that can apply a selected Gateway API key and namespace scope without exposing plaintext Gateway API keys to the browser.
- Added Playground result summaries for status, latency, usage, cost, response preview, and Route Decision deep links while keeping prompts, responses, raw headers, provider keys, media bytes, and realtime frames out of Playground persistence by default.
- Added 7-language Dashboard localization and frontend static checks for the Playground route, hook, endpoint coverage, privacy copy, and API types.
- Added v1.1 Session/Trace correlation for the OSS Dashboard, normalizing `session_id`, legacy `session_key`, W3C `traceparent`, and trace headers into call logs and route decision traces.
- Added read-only Dashboard APIs `GET /api/dashboard/sessions` and `GET /api/dashboard/sessions/:sessionId` for metadata-only session timelines across call logs, route decisions, shadow results, and recent guardrails findings.
- Added the Dashboard Session View with 7-language localization, namespace/API key/model/source filters, model-switch/fallback/cost/latency summaries, and deep links into Route Explanation without storing prompts, responses, raw headers, provider keys, or media/video bytes.
- Added runnable v1.1 agent framework examples under `examples/agents` for OpenAI SDK `base_url`, LangChain, CrewAI, and OpenAI Agents SDK.
- Added shared example headers for Gateway API keys, advisory routing hints, local namespace labels, session correlation, trace labels, and structured-output intent without committing real provider keys.
- Added `docs/AGENT_INTEGRATIONS.md` and static coverage to explain how operators inspect agent cost, fallback, route explanation, session correlation, and namespace policy through SiftGate.

## 1.0.0 - 2026-05-05

### Added

- Expanded the built-in Provider / Model Catalog toward v1.0 ecosystem coverage with 30+ providers, adding AWS Bedrock, Alibaba Qwen/Tongyi, Baidu Qianfan/Wenxin, Volcengine Ark/Doubao, Zhipu GLM, Moonshot/Kimi, MiniMax, Tencent Hunyuan, 01.AI/Yi, Replicate, Perplexity, NVIDIA NIM, Cerebras, and SambaNova Cloud.
- Added review-required pricing source metadata for the new providers, including source URLs, `last_updated`, `pricing_confidence`, and manual-review state without using placeholder wording in operator-facing catalog data.
- Added provider identity mappings and tests so new OpenAI-compatible or compatible-style providers do not fall back to the OpenAI logo in Dashboard node/catalog surfaces.
- Added v1.0 canonical reasoning/thinking intent for Chat `reasoning_effort`, Responses `reasoning`, Anthropic Messages `thinking`, and Gemini-style `thinking_config`.
- Added reasoning-aware provider forwarding strategies, routing preference for `supports_reasoning` targets, call-log metadata, external log sink fields, control-plane metadata, and Route Explanation evidence without storing prompts, responses, hidden reasoning text, raw headers, or provider keys.
- Added Dashboard Logs and Route Explanation localization for reasoning intent, effort, budget, strategy, support status, and downgrade notes across all 7 OSS Dashboard languages.
- Upgraded the official guardrails plugin to v1.0 with metadata-only webhook finding delivery, per-rule `webhook` actions, debounce/retry/timeout/max-queue/drop-policy controls, expanded PII, secret/token, jailbreak, unsafe URL, strict schema, and tool-call policy rules.
- Added `GET /api/dashboard/guardrails` and a Dashboard Guardrails summary card showing finding counters and recent webhook state without exposing prompts, responses, matched text, raw headers, provider keys, webhook URLs, webhook headers, media bytes, or video bytes.
- Hardened the OSS Dashboard API Key management surface for v1.0 with local create/edit/disable/delete/rotate flows, one-time full-key copy, masked list values, namespace binding, per-key budgets, per-key rate limits, and status/last-used/calls/cost/error-rate summaries.
- Added API key permission controls for `allowed_endpoints` and `allowed_modalities`, enforced before routing/provider forwarding and reflected in `/v1/models` filtering.
- Added redacted config audit coverage for API key create/update/rotate/delete operations, plus tests to ensure one-time Gateway API key secrets are not persisted in audit metadata.

### Changed

- Dashboard Add Node presets, catalog CLI output, config validation, and legacy catalog diagnostics now recognize the v1.0 provider set while preserving local `catalog.override.yaml` as the path for operator-reviewed model and price overrides.
- Dashboard API key forms and tables now include endpoint/modality permission pickers and 7-language localization for the new controls.
- SQLite-to-PostgreSQL migration now preserves Dashboard-managed API key endpoint and modality permission arrays when present.

## 0.9.3 - 2026-05-05

### Changed

- Improved the Dashboard Provider Catalog refresh-source section with collapsed-by-default source cards, pinned automatic/local override sources, summary badges, and 7-language copy so long provider lists no longer dominate the page.
- Rebalanced the Routing page layout so each tier shows the route lane first and expands load-balancing/split controls across the available width instead of crowding them into a narrow right column.
- Updated Dashboard Logs for the v0.9 surface: source format is visible in the table, route result is separated from upstream node, and prompt-cache hits now display as cache outcomes with no upstream call instead of fake `cached` tiers or `cache` nodes.
- Filtered prompt-cache synthetic rows out of Dashboard tier/node distribution charts while keeping them visible in cache metrics and recent-call activity.

## 0.9.2 - 2026-05-04

### Added

- Added Provider Catalog refresh-source metadata to Dashboard catalog APIs and the CLI, making it clear which providers can be refreshed automatically and which require docs review or local operator overrides.
- Added `siftgate catalog sources` and `siftgate catalog refresh openrouter --out catalog.override.yaml` for generating a local OpenRouter catalog override from the public model API, including prompt/completion pricing converted to USD per 1M tokens.
- Added catalog pricing `source_url` and `retrieved_at` metadata so Dashboard and validation can explain where pricing came from and when it was fetched.

### Changed

- Renamed Dashboard and operator-facing copy from "pricing hygiene" to "price source status" / "价格来源状态" while keeping the internal `pricing_hygiene` API field for compatibility.
- Updated built-in catalog pricing source labels from placeholder wording to review-required reference metadata, avoiding confusing "占位" UI language while still warning operators to verify production prices.
- Improved the Provider Catalog Dashboard layout with wrapped modality filters, stable table widths, horizontal scrolling, clearer source badges, confidence labels, source links, and a refresh-source section.

## 0.9.1 - 2026-05-04

### Fixed

- Dashboard provider icons now resolve from catalog/provider identity, base URL, node name, tags, and model buckets before protocol fallbacks, so Voyage AI, Jina AI, Together AI, Fireworks AI, vLLM, Azure OpenAI, and custom OpenAI-compatible nodes no longer incorrectly show the OpenAI logo.
- Added a provider-logo identity check to the frontend test suite to prevent `chat_completions` or `responses` protocol fallbacks from forcing the OpenAI mark for compatible providers.
- Provider compatibility probes for OpenAI Responses-style upstreams now use a safer minimal `max_output_tokens` value, aligning single-node test responses with the Dashboard compatibility matrix.

## 0.9.0 - 2026-05-04

### Added

- v0.9 local config audit and rollback for the OSS Data Plane with `config_versions` and `config_audit_events` persistence on SQLite/PostgreSQL.
- Dashboard APIs `GET /api/dashboard/config/versions`, `GET /api/dashboard/config/versions/:id`, `POST /api/dashboard/config/versions/:id/rollback`, and `GET /api/dashboard/config/audit-events`.
- Dashboard Config Audit page with sanitized version detail, audit event stream, and confirmation-based rollback.
- Config audit settings under `config_audit` with validation for `enabled`, `max_versions`, `max_events`, and `capture_startup_snapshot`.
- SQLite-to-PostgreSQL migrator coverage for config version and audit event tables.
- Unit coverage for config audit redaction, rollback success, rollback failure, Dashboard APIs, config validation, and migration.
- v0.9 optional Secret Manager reference support for the OSS Data Plane, with runtime `${env:...}`, `${vault:...}`, `${aws-sm:...}`, and `${gcp-sm:...}` references.
- `SecretReferenceResolverService` with local TTL cache, `fail_closed` / `fail_open_for_optional` behavior, SDK-less Vault/AWS/GCP HTTP adapters, and explicit backend enablement.
- Secret-reference support for provider `nodes[].api_key`, node headers, active health probes, realtime upstream auth, video provider proxy routes, provider compatibility tests, and optional control-plane registration tokens.
- Config validation diagnostics for malformed references, disabled backends, unset env values, secret-manager shape, and secret-like catalog override values.
- Secret management documentation and example configuration.
- v0.9 Shadow Traffic Comparison Report for the OSS Data Plane, adding read-only Dashboard/API comparisons for primary vs shadow success rate, p50/p95 latency, cost delta, potential savings, token delta, fallback delta, quality sample coverage, confidence, and risk notes.
- Dashboard Shadow filters for namespace, API key, node, model, period, and source format, plus localized overview cards and primary-to-shadow comparison tables without any automatic routing changes.
- Privacy-safe shadow report APIs `GET /api/dashboard/shadow/report` and `GET /api/dashboard/shadow/results/:id/comparison`, paired with call logs by `request_id` and never returning raw headers, provider keys, media bytes, or video bytes.
- v0.9 official guardrails plugin upgrade for the OSS Data Plane, replacing the skeleton with disabled-by-default local PII detection/redaction/blocking, lightweight prompt-injection checks, schema validation helpers, named allow/block/redact policies, input/output hooks, and conservative streaming delta handling.
- Privacy-safe guardrails findings in the per-request plugin store, capped by `max_findings_per_request` and limited to metadata such as request id, rule, kind, action, count, and path without prompt text, response text, raw headers, provider keys, media bytes, or video bytes.
- Unit coverage for guardrails privacy behavior, PII redaction/blocking, prompt-injection blocking, schema validation, allow/block policy exceptions, stream delta handling, and hook executor store propagation.
- v0.9 OSS-only Helm chart under `deploy/helm/siftgate` with default single-node SQLite + memory state behavior and opt-in Redis, PostgreSQL, Ingress, HPA, PodDisruptionBudget, ServiceMonitor, existing Secret/ConfigMap, resources, and persistence settings.
- v0.9 Kustomize/plain Kubernetes base under `deploy/kubernetes/base` with placeholder-only Secrets, SQLite PVC, config mount, health probes, and no SiftGate Cloud or enterprise image dependency.
- `npm run validate:k8s` plus manifest validation tests for YAML parsing, required deployment assets, default Cloud-disabled behavior, secret hygiene, image/port checks, and config/data mounts.
- v0.9 Benchmark Report API `GET /api/dashboard/benchmarks/report` for local call-log performance evidence, including success/error/fallback/cache rates, p50/p75/p95/p99 latency, throughput estimate, cost/token summaries, status-code distribution, node:model breakdowns, source-format/source-family breakdowns, and route-trace coverage.
- Read-only Dashboard Benchmarks page with period, namespace, API key, node, model, and source-format filters plus methodology notes that warn against treating local samples as strict cloud benchmarks.
- `npm run benchmark:upstream` JSON report output via `GATEWAY_BENCH_OUTPUT=report.json`, with p75 latency, top sanitized errors, labels, and methodology metadata.
- v0.9 compatibility migration expansion for the OSS Data Plane: `siftgate migrate` now imports LiteLLM, New API, and One API configs into SiftGate and exports SiftGate configs to LiteLLM/New API/One API scaffold YAML.
- Migration reports now include compatible, partially supported, unsupported, manual actions, provider/model mapping notes, and pricing/capability confidence.
- New migration fixtures and tests for LiteLLM, New API, One API, SiftGate v0.8 model buckets, reverse scaffold export, and overwrite protection.
- v0.9 Provider Catalog pricing hygiene for the OSS Data Plane, extending the v0.8 catalog instead of introducing a second model catalog.
- Catalog pricing metadata now includes currency, modality-specific price/unit fields, `stale_after_days`, and `pricing_confidence`.
- Dashboard Provider Catalog page showing pricing freshness, manual-review state, source, confidence, and override markers in the 7-language operator UI.
- `siftgate catalog validate --pricing` and `siftgate catalog export --include-pricing` for local pricing hygiene workflows without online updates.

### Changed

- Dashboard config reload, node create/update/delete, routing edits, and Dashboard-managed API key mutations now record local audit metadata when config audit is enabled.
- Rollback snapshots store redacted safe YAML and rehydrate secrets only from matching current local config fields; unresolved redactions fail safely without writing the config file.
- Runtime config loading now preserves typed secret references such as `${env:OPENAI_API_KEY}` for request-time resolution while keeping legacy `${OPENAI_API_KEY}` startup interpolation compatible.
- Dashboard sanitized config keeps secret references visible as references, masks literal provider keys and sensitive headers, and never resolves secrets for display.
- Explicit shadow prompt/response sample storage now applies built-in redaction and `shadow.compare.sample_max_chars` truncation, and config validation warnings now call out the storage risk more clearly.
- `siftgate migrate` now supports `--to` and `--force`; `--overwrite` remains a backward-compatible alias.
- Cost-aware routing and cost accounting can fall back to merged Provider Catalog pricing when explicit node/model pricing and `models_pricing` are absent; explicit user config always wins.
- Config validation now warns for placeholder, stale, missing, and modality-unit-mismatched catalog pricing, including `routing.optimization=cost` cases with insufficient prices.

## 0.8.0 - 2026-05-04

### Added

- v0.8 local Provider / Model Catalog for the OSS Data Plane, covering provider metadata, models, modalities, endpoints, auth type, pricing source, capabilities, and limits.
- Built-in static catalog entries for OpenAI, Anthropic, Google Gemini/Vertex, Azure OpenAI, OpenRouter, Groq, Mistral, DeepSeek, xAI, Cohere, Voyage, Jina, Together, Fireworks, Ollama, vLLM, and OpenAI-compatible custom providers.
- Dashboard catalog APIs `GET /api/dashboard/catalog/providers` and `GET /api/dashboard/catalog/models` with provider/modality/endpoint filters and built-in + local override merge metadata.
- Config validation warnings for catalog unknown models, endpoint/modality mismatches, and placeholder pricing that still needs operator review.
- v0.8 Dashboard Add Node wizard backed by the local catalog, with provider/proxy/custom selection, capability selection, model bucket editing, endpoint/auth/header/pricing confirmation, and connection test/save flow.
- `nodes[].video_models`, `video_generations_endpoint`, and `video_status_endpoint` config surface for video-capable providers and the experimental async video gateway preview.
- v0.8 media endpoint hardening for the OSS Data Plane with OpenAI-compatible `POST /v1/images/variations` and `POST /v1/audio/translations`.
- Canonical media metadata for images/audio requests: media type, operation, multipart flag, file count, byte size, requested format, response format, and provider response content type.
- Dashboard call-log visibility, CSV/JSON export fields, external log sink fields, and optional connected-gateway telemetry metadata for media operations without storing file contents.
- Node config support for `images_variations_endpoint` and `audio_translations_endpoint`, plus validation and OpenAPI docs for the new media endpoints.
- v0.8 provider compatibility test matrix for the OSS Data Plane Dashboard, covering chat, responses, messages, embeddings, rerank, images, audio, video, and realtime capabilities.
- Local `provider_compatibility_results` metadata storage for configured/tested state, last status, timestamp, latency, HTTP status, and sanitized failure reason without storing prompts, responses, raw headers, provider keys, media bytes, or realtime frames.
- Safe provider test policy: tiny synthetic requests for text/embedding/rerank and endpoint/auth probes for media, video, and realtime by default.
- Dashboard Nodes compatibility matrix, safe test action, and non-blocking compatibility diagnostics.
- Experimental video capability config fields (`video_models`, `video_endpoint`, `video_status_endpoint`, `video_content_endpoint`, `video_cancel_endpoint`) for provider compatibility checks and future async video routing.
- `siftgate catalog list/show/validate/export/import` plus `npm run catalog` for managing `catalog.override.yaml` without network updates.
- Config validation warnings for secret-like catalog override fields/values.
- v0.8 multimodal route decision evidence for image, audio, video, rerank, and embedding requests.
- Route Decision Trace `modality_evidence` and per-candidate `capability_evidence` covering requested modality, input/output types, file count, byte size, required capabilities, capability/file-size filters, endpoint strategy/status, pricing source, and catalog source.
- Dashboard Route Explanation capability badges, endpoint status, pricing/catalog source badges, and 7-language localization for the new read-only evidence.
- Unit coverage for routing trace evidence, pipeline trace persistence, and Dashboard route decision API shape.
- Experimental async video generation preview with `POST /v1/videos/generations`, status/content/cancel routes, video route evidence, and local `video_jobs` metadata storage that does not persist prompts, source media, or video bytes.

### Changed

- Dashboard Add Node provider presets now load from the catalog API instead of a hardcoded frontend list.
- Dashboard Add Node now supports `models`, `embedding_models`, `rerank_models`, `image_models`, `audio_models`, `video_models`, and `realtime_models` in one localized wizard while preserving advanced local Data Plane fields.
- Config validation now allows specialized-only nodes with `models: []` when embedding/rerank/media/realtime model buckets are configured.
- Images/audio ingress now documents production pass-through behavior for JSON and multipart requests across generations, edits, variations, transcriptions, translations, and speech.
- `gateway.config.yaml` now supports optional `catalog.override_file` while keeping the static built-in catalog as the default.

## 0.6.1 - 2026-05-03

### Changed

- Tightened Dashboard localization coverage for v0.2-v0.6 OSS Data Plane surfaces, including Route Explanation, structured-output log details, namespace filters, shadow traffic, realtime status, multimodal capability badges, and adaptive routing recommendations.
- Updated route explanation validation to assert localized empty/no-trace states instead of English-only copy.

## 0.6.0 - 2026-05-03

### Added

- v0.6 canonical structured-output support that preserves OpenAI Chat Completions `response_format`, OpenAI Responses `text.format`, and Anthropic Messages `output_config.format` intent across protocol conversion.
- Provider forwarding strategies for structured output: native passthrough, cross-protocol native mapping, and explicit downgrade/unsupported metadata when a target cannot safely honor the request.
- Structured-output call-log metadata for Dashboard details, CSV/JSON exports, external log sinks, and optional connected-gateway telemetry.
- Unit coverage for Chat, Responses, Anthropic passthrough/downgrade behavior, provider forwarding, schema fallback, and streaming conservative behavior.
- v0.6 unified multimodal capability schema for node/model declarations, covering modalities, endpoint maps, input/output types, file-size limits, streaming, realtime, rerank, and pricing metadata.
- Smart-routing modality filtering that removes incompatible node:model targets for image/audio-style requests while preserving legacy `vision` compatibility.
- Read-only Dashboard Nodes and Routing capability summaries for per-model modalities, streaming/realtime/rerank flags, context windows, dimensions, file-size limits, and pricing hints.
- Config validation and docs for v0.6 capability fields, endpoint maps, and multimodal model metadata.
- v0.6 OpenAI/common-compatible `POST /v1/rerank` endpoint for the open-source Data Plane.
- Canonical rerank request/response types, normalizer, provider forwarding, routing, usage, cost, telemetry, and call-log support.
- `nodes[].rerank_models` and optional `nodes[].rerank_endpoint` configuration with validation and example pricing.
- Rerank routing that respects Gateway API key permissions, local namespace policy, circuit/health state, fallback, and cost-aware target ranking.
- Unit and e2e coverage for rerank controller, normalizer, provider client, routing, pipeline behavior, config validation, and OpenAPI exposure.
- v0.6 minimal OpenAI-compatible images and audio ingress for the OSS Data Plane.
- `POST /v1/images/generations`, `POST /v1/images/edits`, `POST /v1/audio/transcriptions`, and `POST /v1/audio/speech` with canonical media metadata and provider pass-through forwarding.
- `nodes[].image_models`, `nodes[].audio_models`, media endpoint path configuration, pricing validation, routing, budget, rate-limit, telemetry, and call-log coverage.
- Multipart pass-through for image edits and audio transcriptions that rewrites/appends only the selected `model` field and avoids local media parsing/transcoding.
- Unit and e2e coverage for media normalization, routing, provider forwarding, config validation, controllers, OpenAPI paths, multipart pass-through, and binary audio responses.
- v0.6 experimental OpenAI Realtime-style WebSocket preview for the OSS Data Plane.
- Disabled-by-default `realtime` config with `/v1/realtime` upgrade handling, Gateway API key auth, API key/namespace permission checks, global/per-node connection limits, idle/session timeouts, and close cleanup.
- `nodes[].realtime_models` and `nodes[].realtime_endpoint` for realtime-capable upstreams, plus config validation and pricing diagnostics.
- Dashboard nodes and `/health` realtime summaries with active connection counts, capability status, last close timestamps, and sanitized errors.
- E2E coverage for realtime auth rejection, safe WebSocket proxying, close release, upstream failure handling, and provider-key redaction.
- v0.6 explainable routing backend trace for the OSS Data Plane, recording why each request selected a `node:model` without storing prompts, responses, raw headers, or provider keys.
- `route_decisions` persistence for SQLite/PostgreSQL plus Dashboard APIs `GET /api/dashboard/route-decisions` and `GET /api/dashboard/route-decisions/:requestId`.
- Route decision trace details for candidate targets, filter reasons, cost/latency/context scores, circuit state, fallback chain, cost downgrade, final selection, and privacy flags.
- Dashboard Route Explanation page with read-only route decision list/detail views, candidate tradeoff tables, filter reasons, fallback context, empty/error states, and deep links from log details.

### Changed

- Structured-output fallback validation now reads canonical request fields first, with raw body fallback for older call paths.
- Dashboard call log details now show structured-output requested status, type, strategy, and unsupported markers.

## 0.5.0 - 2026-05-02

### Added

- v0.5 optional Redis shared state backend for circuit breakers, rate limits, prompt cache, and routing momentum while keeping memory as the default backend.
- `state.backend`, `state.unavailable_policy`, and `state.redis` configuration with validation, Docker Compose Redis profile, and shared state docs.
- Unit coverage for memory/Redis state behavior, Redis fail-open/fail-closed rate limiting, circuit hash writes, prompt-cache Redis entries, and momentum sorted-set writes.
- v0.5 PostgreSQL production migration path for the OSS Data Plane via `siftgate migrate-db --from sqlite --to postgres`.
- SQLite-to-PostgreSQL migrator with dry-run inspection, optional SQLite backup, non-empty target protection, row-count validation, sequence reset, and secret-redacted reports.
- Production deployment documentation covering PostgreSQL recommendation, TypeORM schema strategy, Docker Compose PostgreSQL profile, and SQLite migration workflow.
- v0.5 upstream connection pooling for the OSS Data Plane via optional `nodes[].connection` undici per-node dispatchers.
- Keep-alive, pool size, headers timeout, body timeout, and experimental HTTP/2 connection settings for upstream provider calls.
- Upstream benchmark script and performance notes for future forwarding regression checks.
- v0.5 stream cache controls via `cache.stream_cache.enabled`, disabled by default and only storing fully completed deterministic streams for later SSE replay.
- v0.5 local embedding batching via `embedding_batching`, disabled by default, with per-node/model safe grouping, queue limits, cancellation, timeout, and partial-response handling.
- Config validation, unit coverage, and documentation for stream cache and embedding batching safety defaults.
- v0.5 Redis-backed cluster mode for OSS Data Plane instance registration, heartbeats, and config reload broadcasts.
- `GET /cluster/status` for Redis-backed multi-instance inventory and reload broadcast status, enabled only when `state.backend=redis` or `cluster.enabled=true`.
- Config validation, docs, and example config for `state` and `cluster` settings without requiring SiftGate Cloud.
- v0.5 local OSS namespaces for Gateway API keys, with namespace-level node/model restrictions, budgets, rate limits, call-log attribution, and Dashboard filtering.
- v0.5 asynchronous shadow traffic mirroring for sampled successful chat, stream, and embedding requests, disabled by default and shown in a read-only Dashboard view.
- Privacy-safe shadow defaults that avoid storing prompts, responses, raw headers, or provider keys unless local comparison storage is explicitly enabled.
- Config validation, example config, docs, and unit coverage for namespace references, policy intersection, namespace budgets, shadow config, sanitized shadow results, and Dashboard APIs.

### Changed

- Added optional `database.synchronize` configuration so local SQLite development can keep schema sync while production PostgreSQL can run with synchronization disabled.
- Provider forwarding now shares the optional per-node dispatcher across streaming, non-streaming, and embeddings requests while leaving default `fetch` behavior unchanged when no connection pool is configured.

## 0.4.0 - 2026-05-02

### Added

- v0.4 OpenAI-compatible `POST /v1/embeddings` endpoint for the open-source Data Plane.
- Canonical embeddings request/response types, normalizer, provider forwarding, routing, usage, cost, telemetry, and call-log support.
- `nodes[].embedding_models`, optional `nodes[].embeddings_endpoint`, and embedding `model_capabilities[].dimensions` configuration with validation.
- Embedding routing that supports batch input, API key permissions, dimension filtering, circuit state, fallback, concurrency limits, and cost-aware target ranking.
- Unit and e2e coverage for embeddings controller, pipeline, provider client, routing, config validation, OpenAPI, and proxy behavior.
- v0.4 plugin manager CLI via `siftgate plugin install/list/remove`.
- Local path and npm package plugin installation with initial `@siftgate/plugin-*` registry scope support.
- `plugins.config.yaml` declaration management so plugin installs do not rewrite `gateway.config.yaml`.
- Plugin version and SiftGate gateway compatibility checks using package metadata.
- Runtime plugin loader support for `plugins.config.yaml` and npm package resolution through `node_modules`.
- v0.4 official runtime plugin batch: `redis-cache`, `analytics-sink`, `request-transform`, and `guardrails`.
- Plugin READMEs, example configs, safety notes, and official plugin documentation under `docs/plugins`.
- Unit coverage for official plugin behavior plus plugin loader and hook executor edge cases.
- v0.4 LiteLLM migration CLI via `siftgate migrate --from litellm --config ./litellm_config.yaml`.
- LiteLLM YAML migration for model names, provider/model mapping, API key environment references, fallbacks, router retry settings, known routing strategies, and optional pricing.
- Human and JSON migration reports covering compatible, incompatible, and manual-review items.
- LiteLLM migration fixtures and unit coverage.
- v0.4 lightweight TypeScript SDK scaffold in `packages/client` with typed helpers for models, chat completions, responses, messages, embeddings, routing hints, raw response access, and Gateway API key auth.
- TypeScript SDK package scripts and tests for build, typecheck, endpoint routing, errors, and request typing.
- Python SDK design document covering planned client shape, auth, routing hints, errors, and streaming approach without implementing a Python package.

### Changed

- Plugin loader now resolves `plugins/<name>` directory declarations to `index.ts` in development, matching production `dist-runtime-plugins` behavior and avoiding duplicate loads.

## 0.3.0 - 2026-05-02

### Added

- v0.3 automatic routing optimization with `routing.optimization` modes `cost`, `latency`, `balanced`, and `quality`.
- Node/model routing capability metadata for `max_context_tokens`, `structured_output`, `quality_score`, and optional per-node/model `pricing` overrides.
- Local request token estimation for automatic routing, including messages, tools, and output budget.
- Context-window aware routing that removes targets whose configured window is too small and demotes targets above 80% of their window behind longer-context alternatives.
- v0.3 fallback policy controls via `routing.fallback_policy` for 429 immediate fallback, timeout fallback, structured-output parse/schema fallback, and cost downgrade.
- `fallback_reason` in call logs, Dashboard log details/exports/SSE payloads, OpenTelemetry fallback metrics, and optional control-plane telemetry metadata.
- Structured-output validation for OpenAI `response_format` and Responses `text.format` requests, with conservative stream behavior that never falls back after SSE has started.
- v0.3 adaptive routing recommendation mode for the open-source Data Plane.
- Local sliding-window node:model stats for success rate, p50/p95 latency, cost, and fallback rate.
- Read-only Dashboard routing recommendations with reasons, confidence, potential savings, and risk notes.
- `GET /api/dashboard/routing/recommendations` for local recommendation evidence without mutating routing config.
- v0.3 local webhook alerts via `alerts.channels` for budget, node health, circuit breaker, error spike, and latency spike events.
- Asynchronous alert delivery with per-channel debounce, retry, timeout, sanitized payloads, and Dashboard delivery status.
- Config validation and documentation for webhook alert channels and spike detector rules.
- v0.3 external log sinks via `logging.sinks`, with JSONL file output, webhook batches, and a minimal Elasticsearch bulk exporter.
- Asynchronous per-sink batching, retry, max queue, overflow handling, and sanitized field allow/deny filtering for exported call logs.
- Config validation and documentation for external log sink settings, with S3 reserved as an interface placeholder.
- v0.3 business Prometheus metrics through the existing OpenTelemetry exporter for requests, latency, tokens, cost, fallback, cache hit/miss, budget usage, concurrency, and circuit breaker state.
- Low-cardinality metric labels that avoid API key names/IDs, prompts, responses, provider keys, and raw headers.
- Unit coverage for telemetry helpers, pipeline metric recording, budget gauge aggregation, concurrency gauges, and circuit breaker gauges.

### Changed

- Direct model routing now preserves caller intent by returning a clear 400 when the selected direct target has a configured context window that cannot fit the estimated request, instead of silently rerouting.
- Cost accounting can prefer node/model pricing overrides before falling back to `models_pricing`.
- Chat Completions and Responses normalization now preserves raw request bodies so fallback policies can inspect structured-output intent.
- Provider timeouts are surfaced as explicit timeout failures for routing and logging.

## 0.2.0 - 2026-05-02

### Added

- v0.2 config validation CLI via `siftgate validate` and `npm run validate:config`, with grouped errors, warnings, info, CI-safe exit codes, JSON output, and shared ConfigService diagnostics.
- Config validation docs and fixtures covering YAML parse failures, routing reference integrity, split weights, pricing warnings, environment reference format, and optional control-plane safety checks.
- Added per-node upstream concurrency limits with `max_concurrency`, `queue_timeout_ms`, and `queue_policy` (`wait`, `fallback`, `reject`).
- Added health, dashboard API, and OpenTelemetry visibility for active concurrency and queue depth.
- Added unit coverage for limiter queueing, fallback/reject overflow behavior, slot release on success/failure, streaming completion, streaming interruption, and fallback paths.
- Added atomic configuration reload snapshots with rollback on parse or validation failure.
- Added `SIGHUP` reload support, optional `hot_reload.watch` file watching with debounce, and EventBus topics `config.reload.success` / `config.reload.failed`.
- Added reload-aware budget and optional control-plane synchronization so runtime services use the latest committed config.
- Added optional per-node active health probing with `enabled`, `interval_seconds`, `timeout_ms`, `method`, `path`, and `lightweight_model` configuration.
- Added probe-to-circuit-breaker integration so failed probes immediately open node/model circuits and successful probes close recovered circuits.
- Added active probe status, `last_checked_at`, and `failure_reason` to `/health` and Dashboard node responses.
- v0.2 load balancing for OSS Data Plane routing tiers with `targets + strategy` schema supporting `weighted`, `round_robin`, `least_latency`, and `random`.
- Local sliding-window latency feedback for `least_latency` target selection and Dashboard routing status.
- Dashboard routing view for strategy, targets, weights, latency samples, p95, and recent target selection.
- Added v0.2 OpenAPI/Swagger documentation for the OSS Data Plane at `/docs` and `/openapi.json`.
- Documented AI proxy endpoints, health checks, Dashboard APIs, Gateway API key management, and config reload with secret-safe DTO examples.
- Added e2e coverage to verify the OpenAPI endpoints are reachable and do not expose provider keys or dashboard password hashes.

### Changed

- Preserved legacy `primary/fallbacks` routing as `primary_fallback` and documented that `split` overrides `targets` while experiment mode is enabled.
- Config diagnostics now validate `targets` references and warn when `split` and `targets` are both configured.

## 0.1.0 - Open Source Gateway

Initial open-source release target.

### Included

- Multi-protocol ingress for OpenAI Chat Completions, OpenAI Responses, and Anthropic Messages.
- Canonical request/response conversion across supported protocols.
- Smart routing with scoring tiers, domain preferences, fallbacks, retry, circuit breaker, momentum, and A/B split support.
- Gateway API keys with per-key permissions, budgets, rate limits, rotation, and dashboard management.
- Cost, token, latency, log, cache, node health, and experiment analytics in the Dashboard.
- Prompt cache, plugin hooks, OpenTelemetry, Docker quickstart, and Docker smoke test.

### Added For Roadmap

- Optional Connected Gateway configuration for future hosted control-plane integration.
- Privacy-preserving control-plane metadata uploader scaffold, disabled by default.
- Open-core positioning and comparison documentation.

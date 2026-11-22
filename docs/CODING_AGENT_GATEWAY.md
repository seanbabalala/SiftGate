# Coding Agent Gateway

SiftGate v2.1.0 makes the OSS data plane a governed gateway for coding agents.
Teams can run Cursor, Cline, Roo Code, Continue, Codex, Claude Code, OpenCode,
and compatible developer agents through one workspace-scoped ingress instead of
copying provider keys into every local tool.

The goal is control without content retention: SiftGate stores operational
metadata for policy, cost, latency, routing, and traces, but does not store
source code, prompts, responses, diffs, tool payloads, raw repository content,
raw provider headers, provider keys, or resolved secrets by default.

## What It Provides

- Workspace-scoped Coding Agent Gateway profiles on the Dashboard **Agents**
  page.
- Connector templates for Cursor, Cline, Roo Code, Continue, Codex, Claude
  Code, OpenCode, Generic OpenAI-compatible agents, and Generic
  Anthropic-compatible agents.
- Redacted rendered configs with Gateway API key placeholders, base URLs,
  model aliases, and optional VS Code/settings-style JSON snippets.
- Per-agent virtual model aliases: `coding-auto`, `coding-fast`,
  `coding-deep`, and `coding-security`.
- Metadata-only session tracing for connector, profile, workspace, session id,
  turn id, route decision id, fallback/retry, token, cost, latency, and optional
  repo/project tags supplied through allowlisted headers.
- Dashboard session summaries and cost breakdowns by coding agent, repo, and
  project.
- v2.5 Agent Platform preview: a read-only A2A registry, MCP-backed Tool
  Registry, preview workflow metadata, memory metadata counters, and recent
  agent trace spans in one Dashboard view.

## Connector Matrix

| Connector | Protocol style | Recommended model alias | Rendered config shape |
| --- | --- | --- | --- |
| Cursor | OpenAI-compatible | `coding-auto` | Custom OpenAI-compatible JSON with `/v1` base URL |
| Cline | OpenAI-compatible | `coding-auto` | OpenAI Compatible provider JSON |
| Roo Code | OpenAI-compatible | `coding-auto` | OpenAI Compatible provider JSON |
| Continue | OpenAI-compatible | `coding-auto` | Continue `models` JSON snippet |
| Codex | OpenAI-compatible | `coding-auto` | OpenAI environment variables |
| Claude Code | Anthropic-compatible | `coding-auto` | Anthropic environment variables |
| OpenCode | OpenAI-compatible | `coding-auto` | OpenAI-compatible provider JSON |
| Generic OpenAI | OpenAI-compatible | `coding-auto` | OpenAI environment variables |
| Generic Anthropic | Anthropic-compatible | `coding-auto` | Anthropic environment variables |

Legacy chatbot connectors remain supported: Cherry Studio, Hermes, and OpenClaw.
They can continue using existing Agent Gateway Profile behavior while v2.1 adds
the coding-agent aliases and metadata-only session view.

## Virtual Model Aliases

Coding agents should usually call one of the profile-scoped aliases instead of
a direct provider model id:

| Alias | Routing hint | Intended use |
| --- | --- | --- |
| `coding-auto` | `{ "mode": "coding", "optimization": "balanced" }` | Default coding-agent route |
| `coding-fast` | `{ "mode": "coding", "optimization": "latency" }` | Fast completions and small edits |
| `coding-deep` | `{ "mode": "coding", "depth": "deep" }` | Larger reasoning-heavy implementation work |
| `coding-security` | `{ "mode": "coding", "task": "security_audit" }` | Security review and audit tasks |

Aliases are advisory and scoped to the active profile plus Gateway API key. They
map to internal `auto` routing and never bypass API key permissions, workspace
scope, budgets, allowed models, allowed nodes, allowed modalities, circuit
breakers, or fallback rules.

Smart aliases require `allow_auto: true` on the Gateway API key. Direct provider
model ids still require `allow_direct: true` and must pass the key's policy.

## Safe Headers

Compatible agents can send these optional headers to improve metadata-only
tracing:

| Header | Stored field | Notes |
| --- | --- | --- |
| `x-siftgate-agent-session-id` | `agent_session_id` | Preferred session id for coding-agent traces |
| `x-agent-session-id` | `agent_session_id` | Generic fallback |
| `x-coding-agent-session-id` | `agent_session_id` | Generic fallback |
| `x-siftgate-agent-turn-id` | `agent_turn_id` | Optional turn id |
| `x-agent-turn-id` | `agent_turn_id` | Generic fallback |
| `x-coding-agent-turn-id` | `agent_turn_id` | Generic fallback |
| `x-siftgate-repo` | `agent_repo` | Optional repo label, not repository content |
| `x-siftgate-agent-repo` | `agent_repo` | Optional repo label |
| `x-agent-repo` | `agent_repo` | Optional repo label |
| `x-siftgate-project` | `agent_project` | Optional project/worktree label |
| `x-siftgate-agent-project` | `agent_project` | Optional project/worktree label |
| `x-agent-project` | `agent_project` | Optional project/worktree label |
| `x-siftgate-agent-connector` | `agent_connector` | Optional connector override label |
| `x-agent-connector` | `agent_connector` | Generic fallback |
| `x-coding-agent-connector` | `agent_connector` | Generic fallback |

Header values are normalized, control characters are removed, whitespace is
collapsed, and stored tags are truncated. SiftGate does not store raw headers.

## Quick Connect

**Coding Agents → Quick connect** sets up a tool in three steps:

1. Choose the tool.
2. Name it and choose its scope. The scope is either gateway routing or one
   model. You can also set an optional policy scope, a daily cost limit (USD)
   and requests per minute (60 by default).
3. Copy the result.

Step 3 creates a new Gateway API key with that scope and limits, plus an active
agent profile bound to it, and renders the setup snippet.

The full key is shown once, in its own field, and is kept only in that dialog's
memory. The rendered snippet keeps the `<SIFTGATE_GATEWAY_API_KEY>` placeholder,
so you paste the key in yourself. If the profile cannot be created, the key is
still shown, and you can add a profile for it from the list.

Requests from the tool then follow the key's model scope, budget and rate limit.
Refusals appear under Request Logs → Blocked requests.

## Setup Flow

For full control over the profile (routing hints, MCP servers, an existing key),
create it manually:

1. Open the Dashboard and go to **Agents**.
2. Create a profile for the target connector.
3. Bind a Dashboard-generated Gateway API key.
4. Optionally bind a namespace and MCP server ids.
5. Keep routing in Smart mode unless a specific direct model is required.
6. Render the connector setup card.
7. Copy the redacted snippet into the coding agent.
8. Run an agent request and inspect **Agents** or **Sessions** for metadata-only
   session, cost, latency, fallback, and route explanation links.

Rendered configs use `<SIFTGATE_GATEWAY_API_KEY>` placeholders or masked key
metadata. Provider keys stay in SiftGate nodes, environment variables, or secret
references.

## Example OpenAI-Compatible Config

```env
OPENAI_BASE_URL=http://localhost:2099/v1
OPENAI_API_KEY=<SIFTGATE_GATEWAY_API_KEY>
OPENAI_MODEL=coding-auto
```

## Example Anthropic-Compatible Config

```env
ANTHROPIC_BASE_URL=http://localhost:2099
ANTHROPIC_AUTH_TOKEN=<SIFTGATE_GATEWAY_API_KEY>
ANTHROPIC_MODEL=coding-auto
```

Use the Dashboard-rendered card for the exact shape required by each connector.

## North Star Demo

The v2.1 demo scenario is an **Engineering PR Review Workspace**:

1. Create a workspace named `engineering-pr-review`.
2. Add provider nodes for a fast coding model, a deeper reasoning model, and a
   security-oriented model.
3. Create one Gateway API key scoped to the workspace with `allow_auto: true`.
4. Create Coding Agent Gateway profiles for Cursor, Cline or Roo Code, Continue,
   Codex, Claude Code, and OpenCode using the same key.
5. Configure agents to use:
   - `coding-fast` for inline suggestions,
   - `coding-deep` for implementation review,
   - `coding-security` for security audit,
   - `coding-auto` for summary and general assistance.
6. Run a PR review from the developer tools.
7. Open the Dashboard **Agents** page and inspect recent sessions, cost by
   connector/repo/project, route explanations, fallback/retry evidence, and
   metadata-only privacy status.

The demo should prove that SiftGate can govern multiple coding agents through
one workspace policy boundary without becoming a workflow engine and without
retaining repository content by default.

## API Surface

Dashboard profile APIs are documented in [API Reference](API_REFERENCE.md).
Session APIs now accept optional filters for `agent_connector`, `agent_repo`,
and `agent_project`.

The public `/v1/*` ingress remains OpenAI-compatible and Anthropic-compatible.
Existing v2.0 workspace/RBAC, PostgreSQL, Redis cluster mode, audit log,
upgrade, and first-run behavior remain unchanged.

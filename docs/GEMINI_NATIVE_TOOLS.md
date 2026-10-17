# Gemini native tools through Chat Completions

For a Gemini provider exposing an OpenAI-compatible Chat Completions API,
configure a `chat_completions` node and use `/v1/chat/completions` on SiftGate.
The model must also be allowed by the caller's API key and any team/namespace
restrictions. Provider credentials stay on the node, not in client requests.

```json
{
  "model": "YOUR_GEMINI_MODEL",
  "messages": [{"role": "user", "content": "Find the official Example Domains page and cite the source."}],
  "tools": [{"googleSearch": {}}],
  "max_tokens": 2048,
  "stream": false
}
```

## Tool transport

SiftGate preserves provider-executed `googleSearch`, `enterpriseWebSearch`,
`urlContext`, `codeExecution`, and `googleMaps` tool objects, including their
nested options and snake-case spellings. Native tools can accompany ordinary
OpenAI function declarations; normalized function tools are not replaced or
resurrected after a policy hook removes them.

Support and limits remain provider/model dependent. Acceptance of a request is
not proof that a tool executed. Check grounding references, URL retrieval status,
or other provider execution evidence. Enterprise search availability depends on
the upstream enterprise configuration; SiftGate does not create an index.

Do not use the deprecated `GoogleSearchRetrieval` / `googleSearchRetrieval`
tool. The gateway forwards it unchanged so that the provider's rejection remains
visible; it does not convert an unsupported tool request into ordinary chat.

These Google-shaped tools are not Responses API `web_search` tools. Requests that
would translate them through a Responses or Messages upstream are rejected before
provider I/O. The existing native Gemini adapter remains available separately.

## Response metadata and streaming

### Function-call thought signatures

For Chat Completions function calls, SiftGate preserves the opaque signature from
`tool_calls[].extra_content.google.thought_signature` or the compatibility alias
`tool_calls[].provider_specific_fields.thought_signature`, or a tool-ID-linked
`message.reasoning_details[]` entry with `type: "reasoning.encrypted"`. When both Google aliases are strings,
the Google field takes precedence (including an empty string). Values are never
decoded, trimmed, concatenated, regenerated or replaced with a dummy signature.
Absent or non-string values do not create a signature.

Chat JSON and SSE output include **both** `extra_content.google.thought_signature`
on the corresponding tool call and an OpenRouter encrypted envelope in
`choices[].message.reasoning_details` (JSON) or `choices[].delta.reasoning_details`
(SSE). Its `id` is the exact tool-call ID and its `data` is the same opaque string.
Google-only state gets a `google-gemini-v1` envelope; this wraps existing bytes,
not newly generated reasoning or a replacement signature. Keep either supported
format when replaying the assistant message
alongside its tool results on the next turn; SiftGate carries it through request
normalization and upstream serialization. This contract covers Chat Completions
ingress and Chat Completions upstream, not cross-protocol signature translation.

In SSE, merge tool deltas by `index`, preserving signatures even when a chunk has
no `function` fields. Upstream signatures can precede the ID or follow argument/finish/usage
chunks. SiftGate correlates explicit indexes and known IDs, never function names,
and drains tool streams through `[DONE]` or EOF before emitting its terminal event.
An unaddressed continuation cannot be assigned safely among parallel calls and is
ignored rather than attached to the last call. Ordinary unsigned calls acquire no
signature metadata. Arbitrary provider-specific fields are not copied.

### pi and OpenRouter compatibility

pi's Chat Completions adapter replays encrypted state through `reasoning_details`.
Older pi 0.73.1 only attaches a detail after it has seen the matching tool ID;
newer pi 1.3.0 preserves the details in a thinking-signature block. SiftGate emits
the complete encrypted envelopes once, after tool IDs are known and before its
terminal event. Signature-only chunks without IDs are retained by index until
identity arrives, so clients do not create empty tool items in signature-arrival
order. Text and argument deltas still flow immediately. The original
encrypted-detail sequence and recognized `format`/`index` metadata survive;
the reasoning `index` is **not** a tool-call index and is never used for matching.
Signatures arriving before IDs, after usage/finish, or through repeated aliases
do not become concatenated signatures or duplicate reasoning envelopes.

Only `reasoning.encrypted` entries with a non-empty matching tool `id`, string
`data`, and Gemini-compatible format are recognized. `google-gemini-v1`, absent,
null and `unknown` format are accepted for compatible clients. Explicit OpenAI,
Anthropic and other formats, orphan IDs, plaintext reasoning and summaries are
not translated into Gemini tool state. This is not general cross-provider
reasoning replay. Google signatures take precedence over conflicting aliases;
conflicting envelope metadata is not reused with a different signature.

Client output always supports both dialects. **Upstream** requests default to
Google's tool-call extension, so strict Google APIs do not receive an unknown
`reasoning_details` message field. An upstream whose hostname is `openrouter.ai`
automatically receives OpenRouter envelopes instead. Private proxies can select
their upstream contract explicitly, without changing pi:

```yaml
request_compatibility:
  chat_tool_signatures: openrouter # google | openrouter | both
```

`both` is opt-in for upstreams that accept both extensions. Existing
`chat_tool_messages: drop` / `stringify_as_user` policy still removes tool state;
the signature bridge does not resurrect removed history. No new secret or
reasoning-payload logging is enabled.

### Grounding metadata

For non-streaming Chat Completions responses, these fields remain at the JSON
root, with their upstream JSON structure preserved:

- `vertex_ai_grounding_metadata`
- `vertex_ai_url_context_metadata`

Other arbitrary provider fields and provider headers are not copied. The metadata
is not translated into another client's protocol.

For `stream: true`, read every SSE `data:` frame through `[DONE]`. Grounding and
URL metadata may arrive in a chunk with `choices: []`, including after a text
finish reason. SiftGate emits these metadata chunks before its final stop event
and `[DONE]`, retaining usage received in an earlier chunk. Stream-event hooks
still process the events; this is not an opaque stream bypass.

This preservation is conditional on the upstream actually sending metadata.
Some OpenAI-compatible Gemini providers return grounding/URL metadata only in
non-streaming JSON, not in SSE. SiftGate does not invent citations, run a second
search, or silently replace a streaming request with a buffered non-streaming
call. Use `stream: false` when complete citations or URL status are required from
such a provider. A successful text stream alone is not execution evidence.

Tool requests bypass exact, streaming and semantic response caches. This prevents
a previously cached plain-chat answer from being mistaken for a fresh search or
tool execution, and avoids storing grounding payloads through those caches.

No new persistent prompt, response, tool-payload or provider-secret logging is
enabled by this support. Existing opt-in plugins and capture settings retain
their own configuration and responsibilities.

## Verification

The regression suite covers tool objects and mixed function declarations,
provider rejection of deprecated tools, JSON metadata filtering, split SSE
chunks, late metadata, terminal markers, usage accounting, cache bypass and
unsupported protocol rejection. HTTP tests exercise both a Flash-style and an
Argon-style synthetic model; they do not assert remote model availability.

```bash
npm test -- --runInBand test/unit/gemini-native-tools.spec.ts
npm run test:e2e -- --runTestsByPath test/e2e/gemini-native-tools.e2e-spec.ts
npm test -- --runInBand test/unit/gemini-thought-signature.spec.ts
npm run test:e2e -- --runTestsByPath test/e2e/gemini-thought-signature.e2e-spec.ts
npm test -- --runInBand test/unit/openrouter-tool-signature.spec.ts
npm run test:e2e -- --runTestsByPath test/e2e/openrouter-tool-signature.e2e-spec.ts
```

CI additionally installs pinned, unmodified pi clients **outside** the gateway
dependency tree and runs `scripts/test-pi-signature-compat.mjs`. The real clients
exercise two turns against loopback Google/OpenRouter fixtures, including a
200 → 400 negative control with the bridge removed. These fixtures are not
remote-model availability proof and never use production credentials or data.

To reproduce locally after `npm run build`:

```bash
npm install --prefix .local-dev/pi-compat --ignore-scripts @mariozechner/pi-ai@0.73.1
PI_AI_PACKAGE_DIR="$PWD/.local-dev/pi-compat/node_modules/@mariozechner/pi-ai" \
  node scripts/test-pi-signature-compat.mjs
# Repeat with @earendil-works/pi-ai@1.3.0 in a separate prefix.
```

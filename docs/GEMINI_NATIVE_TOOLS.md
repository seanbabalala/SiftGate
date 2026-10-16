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
`tool_calls[].provider_specific_fields.thought_signature`. When both are strings,
the Google field takes precedence (including an empty string). Values are never
decoded, trimmed, concatenated, regenerated or replaced with a dummy signature.
Absent or non-string values do not create a signature.

Chat JSON and SSE output use `extra_content.google.thought_signature` on the
corresponding tool call. Keep that field when replaying the assistant message
alongside its tool results on the next turn; SiftGate carries it through request
normalization and upstream serialization. This contract covers Chat Completions
ingress and Chat Completions upstream, not cross-protocol signature translation.

In SSE, merge tool deltas by `index`, preserving signatures even when a chunk has
no `function` fields. Signatures can precede the ID or follow argument/finish/usage
chunks. SiftGate correlates explicit indexes and known IDs, never function names,
and drains tool streams through `[DONE]` or EOF before emitting its terminal event.
An unaddressed continuation cannot be assigned safely among parallel calls and is
ignored rather than attached to the last call. Ordinary unsigned calls acquire no
signature metadata. Arbitrary provider-specific fields are not copied.

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
```

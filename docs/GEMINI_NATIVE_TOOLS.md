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
```

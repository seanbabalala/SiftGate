# Native video result profiles

This is development-candidate functionality, not an instruction to change or
restart an active gateway. No provider connection is enabled by selecting a price.
No supplier rates are downloaded or activated by these profiles.

## Explicit schemas, not model-name heuristics

`nodes[].video_result_profile` selects one versioned interpretation:

| Profile | Result contract | Verified quantities |
| --- | --- | --- |
| `generic-v1` | Existing compatible metadata parser; default when omitted | Existing explicitly reported counters |
| `gemini-veo-rest-v1` | Gemini Developer API REST long-running video operation | Returned video count from `response.generateVideoResponse.generatedSamples` |
| `runway-task-v1` | Runway task metadata | Returned video count from successful `output` entries |

The Dashboard node editor exposes this choice in the video endpoint section, with
seven-language help. Unrelated edits do not submit a replacement profile, hidden
video fields retain the existing profile, and changing an existing node's preset
does not silently reset its interpreter. YAML and Dashboard writes reject unknown
profile IDs. An existing task stores its profile inside its immutable context;
changes affect only new tasks. Older contexts without a profile remain generic.
New schema behavior requires a new versioned profile, not rewriting a historical
interpreter.

## Request and endpoint contracts

These are native-body pass-throughs, not a universal prompt converter. The gateway
`model` field still selects the configured route. The selected node must accept the
native request shape before a provider request is sent. A native-only body is not
sent to a generic node, nor is a Google envelope sent to a Runway-profile node.

For Gemini, use the documented `instances` input (one input) and optional
`parameters`, including `durationSeconds` and `sampleCount`. The outbound JSON
omits the gateway's `model`; the configured generation endpoint must name the
actual dispatched model or use `{model}`, for example:

```yaml
video_result_profile: gemini-veo-rest-v1
video_generations_endpoint: /v1beta/models/{model}:predictLongRunning
video_status_endpoint: /v1beta/{id}
```

The configured node base URL and authentication remain the operator's explicit
choice. Upstream model aliases resolve before the endpoint is checked. A validated
Google operation resource retains its slash-separated path on status GETs; it
cannot inject traversal, a URL or an arbitrary resource type.

For Runway, provide its native request fields such as `promptText`, `duration` and
`ratio`, with an explicitly configured generation endpoint for the chosen model.
A task status endpoint uses `/v1/tasks/{id}`. Configure Runway's required API-version
header through the existing node header settings. The gateway does not create or
change credentials or overwrite your header configuration.

Request duration is retained as request metadata, not observed output duration.
Native admission estimates multiply duration by the requested output count using
exact decimal arithmetic. Omitted or malformed quantities do not fall back to
unrelated generic fields, become implicit zeroes, or acquire an invented duration.
Provider-specific capability and request-limit governance remains separate work.
Configuration validation distinguishes literal video `{model}`/`{id}` endpoint
slots from `${...}` secret references. Unknown slots, malformed references and
secret-field braces retain their existing validation errors.

## Evidence and unknowns

Current verified native result schemas return output references but not actual
video duration. `video_seconds` is therefore explicitly `unsupported`, with no
value. A per-output contract can still compute a known count-based amount; a
contract requiring actual seconds gets a missing/partial amount. Unsupported
*unused* dimensions are not global parse errors. The selected price decides which
quantities are required. An explicit request-quantity price remains a different
contract and is not relabelled as actual measured usage.

Returned arrays are bounded to64entries. Every counted entry must have a valid,
non-duplicate output URI. An explicit empty array reports zero outputs; a missing
array reports an unknown count. Filtered outputs are not counted as successful
videos. An unfamiliar envelope or malformed identity fails closed instead of
falling back to a cheaper generic interpretation. Google SDK `generatedVideos`
is not the REST `generatedSamples` schema and is deliberately not auto-detected.

Runway `PENDING`, `THROTTLED` and `RUNNING` remain pending. `FAILED` and `CANCELLED`
are terminal statuses, **not** proof of zero supplier cost. Google operation errors
are processed as terminal errors, with cancellation only for its cancellation
status code. HTTP204/404, disappearing output URLs or a client disconnect are not
used to infer a refund or successful cancellation.

Neither `createdAt` nor the gateway's polling time establishes provider acceptance
or completion time. Time-based pricing retains missing provider instants. Request
specifications are marked as request-derived, not supplier-observed output specs.
Supplier credit totals and estimated prices are not converted to USD, trusted as
invoice confirmation, or used to replace the captured price/FX snapshot.

## Authentication, custody and recovery

Status reads use the original connection fingerprint and physical credential.
Redirects, endpoint replacement and credential substitution are not used to find
an equivalent job. No output URI is dereferenced to meter an asset. Only normalized
quantity and pricing metadata enter the ledger; prompts, output bytes, URLs, raw
provider errors and credit totals are not persisted by these translators.

The existing durable task settlement path, unknown-job lookup, signed-event
ownership, alternative custody and administrator disposition are reused. Native
polling after a signed source owns a task is retained as unversioned alternative
evidence, not used to overwrite ordered evidence automatically. Repeated native
results do not duplicate observations or terminal settlement. Profile changes and
newly published prices do not reprice an in-flight task.

These profiles currently support **status metadata only** for task control.
Cancellation and asset retrieval need separately verified native connectors; they
are rejected rather than mapping a POST to a provider's destructive DELETE or
following a provider-supplied URL with credentials. There is no new public native
webhook endpoint, no unverified signature bypass, and no automatic retry of a
possibly accepted generation. Existing generic media controls are unchanged.

## Sources and verification scope

Primary schema sources inspected on2026-09-27UTC:

- [Gemini Veo REST examples](https://ai.google.dev/gemini-api/docs/veo).
- [Google SDK type definitions](https://github.com/googleapis/js-genai/blob/main/src/types.ts)
  and its [REST conversion implementation](https://github.com/googleapis/js-genai/blob/main/src/converters/_models_converters.ts).
- [Runway OpenAPI schema](https://docs.dev.runwayml.com/openapi.json)
  and [task resource implementation](https://github.com/runwayml/sdk-node/blob/main/src/resources/tasks.ts).

Official OpenAI documentation also reports that its Sora/Videos API closed on
September24,2026. No active Sora connector is added based on that historical schema;
see the [retained reference](https://developers.openai.com/api/reference/typescript/resources/videos/methods/retrieve).

Tests use synthetic bodies, temporary SQLite/PostgreSQL databases and mock
upstream HTTP responses, not paid provider calls. They verify exact counts and
estimates, unknown durations/times, ordering boundaries, original-price settlement,
profile pinning, authenticated paths, lookup recovery, malformed envelopes,
no-content persistence and node configuration round trips. This scope does not
claim every supplier API, media format, model limit or full M0–M6 acceptance.

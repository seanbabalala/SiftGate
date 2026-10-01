# Quantity-based media pricing

Status: synchronous images/audio/rerank, persisted image/video polling, authenticated
normalized supplier events, explicit actual-upstream budgets, operator review and
coordinated retention are implemented in the isolated candidate. See
[dimension acceptance](pricing-dimension-acceptance.md),
[supplier events](pricing-media-supplier-events.md),
[actual quantity budgets](pricing-non-token-budgets.md) and
[retention](pricing-retention.md) for their exact scope. The full Goal is not
complete and no production deployment is authorized. A normalized event connector
is not automatic support for every vendor webhook or contract.

## Selecting a billing basis

Prices and unit sizes are decimal strings. Choosing a dimension explicitly selects
what is billed; request quantities never silently replace unavailable actual usage.

| Dimension | Evidence / meaning |
| --- | --- |
| `image_count` | Explicit provider scalar count, otherwise recognized successful `data` outputs. Entries with explicit errors are not successful images; unrecognized entries produce incomplete evidence. URLs/base64 are not retained. |
| `requested_image_count` | Explicit incoming `n`, including a bounded multipart text field. No universal custom-provider default is invented when it is missing. |
| `audio_input_seconds` | Provider `usage.audio_input_seconds`, `usage.seconds`, `duration` or `duration_seconds`; otherwise a supported uploaded PCM WAV header measurement. |
| `audio_output_seconds` | Provider duration fields; otherwise a supported PCM WAV output header measurement. |
| `requested_audio_input_seconds`, `requested_audio_output_seconds` | Explicit request duration fields. Use only for a contract that bills requested quantities. |
| `text_characters` | Unicode code points in the speech input, including whitespace. It is not UTF-16 code units, bytes or grapheme clusters. Text is not retained by the meter. |
| `video_seconds` | Reported `usage.video_seconds`, `usage.duration_seconds`, `duration_seconds` or `duration`; never HTTP latency. |
| `video_generation_count` | Reported `usage.generation_count` or `usage.generations`; completed single-generation job metadata can establish one. Multi-generation requests without actual counts remain unknown. |
| `requested_video_seconds`, `requested_video_generation_count` | Explicit request seconds/duration and requested generation count. Select only for a request-quantity contract. |
| `request_count` | One accepted invocation. It adds no fee unless the book declares a component for it. |
| `rerank_request_count` | One successful rerank invocation. |
| `requested_rerank_document_count` | Input document count, not returned `top_n` result count. |
| `rerank_document_count` | Explicit provider processed-document counters only. |
| `rerank_search_units` | Explicit `usage/meta.billed_units.search_units`; never converted into tokens. |

Reported text/audio/image token partitions remain distinct from token parents.
Nonzero cache usage without modality attribution makes uncached input partitions
unavailable rather than guessed. Existing public numeric usage fields are legacy
compatibility projections; normalized pricing evidence records missing quantities.

Overlapping requested/actual bases, parent/subset tokens and incompatible media
bases are rejected unless the applicable explicit additive contract permits them.
A base request fee plus measured seconds is a declared hybrid, not an automatic fee.

## Examples (synthetic, not supplier prices)

- Four images requested, three recognized successful outputs, `$0.04 / image`:
  `image_count` costs `$0.12`; explicitly choosing `requested_image_count` costs
  `$0.16`.
- Audio lasting 61 seconds at `$0.06 / 60 seconds`: prorated cost is `$0.061`.
  A separate `quantity_rounding: { increment: "60", mode: "ceil" }` makes it
  `$0.12`. The unit denominator alone does not imply rounding up.
- A 6.4-second video result at `$0.10 / second` plus an explicitly additive
  `$0.02 / generation` costs `$0.66`; rounding seconds upward in increments of
  `"1"` costs `$0.72`. These are synthetic test prices.
- A 6.4-second PCM speech result at `$0.10 / second`, plus an explicit `$0.02`
  request component, costs `$0.66`.
- Rerank input of three documents with one returned result and two reported search
  units contains three different quantities; a selected rate uses its named one.

The same calculator serves quote, reservation and actual settlement. Auto routing
uses the request-frozen quantity quote rather than comparing token input rates for
images or audio. Operation-specific bindings use ingress names (`image_generation`,
`image_edit`, `image_variation`, `audio_transcription`, `audio_translation`,
`audio_speech`, `rerank`, `video_generation`). The separate `media.operation` selector uses the canonical
business operation (`generation`, `edit`, `variation`, `transcription`, etc.).

Publishing an unrelated chat price does not activate media pricing. When a relevant
media pricing catalog is active, legacy fallback targets retain their frozen logical
budget formula instead of multiplying final logical usage by the retry allowance.

## Evidence and privacy boundaries

- PCM measurement supports bounded RIFF/WAVE headers with uncompressed 8-/16-bit
  PCM, consistent sample rate/block alignment/byte rate and complete data chunks.
  Compressed, extensible, inconsistent or truncated formats remain unknown. MP3
  duration is not guessed from byte length. This is header measurement, not audio
  decoding or invoice reconciliation.
- Multipart scanning is bounded, uses binary slices and reads only approved shape
  fields. Conflicting duplicate fields and incomplete containers are not trusted.
  It does not retain filenames, prompts, transcripts or media bytes.
- Required unknown quality/size variants do not fall through to a cheap generic
  rate. Request-derived variant assumptions are marked estimated. Credential-like
  values are redacted before pricing context persistence.
- Missing or malformed usage produces explicit missing/partial pricing, not a
  known zero. Provider responses remain compatible; accounting parsing must not
  cause a second paid invocation.
- Lack of request quantity, duration or a supported provider counter can leave a
  reservation without a proven upper bound. The explicit [admission policy](pricing-admission-policy.md)
  now distinguishes compatible estimates from missing-price rejection and envelopes
  conditional on approved quantity limits. Requested duration/count alone is not an
  actual output cap. Do not deploy this partial candidate as complete strict-budget enforcement.

## Persisted asynchronous image/video lifecycle

Explicit migration `pricing-engine-005` adds submission claims, task footprints and
normalized observations. It preserves earlier migration checksums and is never run
by application startup. An approved relevant binding activates the candidate path;
unrelated chat publications do not activate media pricing.

The task and dispatched attempt are inserted together before generation. Its frozen
catalog, minimal request quantities, workspace/key/namespace, logical credential
identity and connection fingerprint govern later observations. No prompt, raw
provider response, media bytes, signed output URL or resolved secret is persisted.
Provider errors become stable generic codes, not retained arbitrary message text.

Lifecycle: `reserved → submitted → pending → terminal → settled`. `uncertain`
means that acceptance or identity could not be proved; it is not failed/free.
Synchronous image outputs retain a separate `synchronous` metadata marker.

- Image/video generation under this pricing path uses one paid attempt. A lost
  submission response does not cause another credential try, route fallback or
  background generation. Ambiguous holds remain for reconciliation; elapsed time
  alone cannot establish zero incurred cost.
- Terminal normalized evidence is persisted before financial application. Its
  action/computation is hash-fenced, followed by the existing durable settlement
  intent and exact budget transaction. Replaying after either durable boundary
  does not debit twice. New terminal usage appends a linked correction; it never
  overwrites the original receipt.
- A cancel HTTP 2xx/204 is only an acknowledgement. Pending cancellation keeps the
  hold. Confirmed failed/cancelled jobs with missing usage remain unknown and their
  compatible logical budget estimate is labelled separately. Explicit zero usage
  for every configured component can close the hold at zero. Partial generation
  usage remains billable even after a failure/cancellation. Content-delivery errors
  never undo generation costs.
- Background recovery performs bounded status polling and local settlement replay,
  never generation. Stale submitted/reserved tasks become `uncertain`; unresolved
  provider identities are not guessed. Poll leases and revision fences discard
  older responses that overlap a newer observation.
- Controls reuse the submission credential's logical ID, including custom-header,
  Google-key, Anthropic-key and bearer conventions. Removed credentials or changed
  node connection/auth/endpoints require reconciliation. Secrets are resolved at
  control time; changing the logical credential to another supplier account is not
  an approved migration of old tasks.
- Control deadlines cover headers and body (5 seconds for status/cancel, 60 seconds
  for streamed content); metadata is capped at 128 KiB. Redirects are rejected.
  Shutdown aborts controls. Acceptance/completion timestamps are locally observed
  estimates when the provider supplies no verified timestamp; the first terminal
  timestamp stays fixed across subsequent polls.

### API-key-owned job controls

| Operation | Video | Async images |
| --- | --- | --- |
| Status | `GET /v1/videos/:id` | `GET /v1/images/jobs/:id` |
| Cancel | `POST /v1/videos/:id/cancel` | `POST /v1/images/jobs/:id/cancel` |
| Content | `GET /v1/videos/:id/content` | `GET /v1/images/jobs/:id/content` |

Image nodes optionally configure `images_status_endpoint`, `images_cancel_endpoint`
and `images_content_endpoint`. Existing video endpoint properties are retained.
Control templates must contain `:id` or `{id}`; the original provider job ID is
URL-encoded into that position. No endpoint/provider is invented by the worker.

Lookups scope workspace, API key and namespace **before** matching an ID. Use the
Gateway request ID if a provider reuses IDs within one owner; an ambiguous match
returns 409. Status responses expose job state and cost totals, not detailed rates,
credentials or ledger receipts. Full cost details remain under Dashboard RBAC.
If polling is unavailable the retained state is returned with
`refresh_status: "unavailable"`; it is not falsely presented as fresh provider data.
Legacy video rows are scoped before lookup and cannot guess among multiple current
credentials when no submission credential was persisted.

### Client idempotency and output retention

`Idempotency-Key` (up to 256 characters) is scoped to workspace, API key, namespace
and operation. Its hash and a request fingerprint are stored, not the raw header or
prompt. Identical concurrent submissions reuse the original task without another
hold/generation, even if the current binding has since been disabled; changing the payload with the same key returns 409. JSON key order
is canonicalized. Multipart fingerprints cover exact bytes/content type; callers
must reuse those bytes, including the boundary, for the same idempotency key.

Replays return metadata with `idempotent_replay: true` and `output_retained: false`,
not retained image/video bytes. Synchronous image replay explicitly includes
`output_unavailable_reason: "synchronous_output_not_retained"`. It must not be
misread as a new normal image-output response or trigger automatic regeneration.
Task content, when supported, is streamed from its configured provider endpoint.

### Authenticated events and remaining async boundaries

The current [normalized supplier-event protocol](pricing-media-supplier-events.md)
has an authenticated callback route, source revisions and ordered event identities.
[Operator disposition](pricing-media-event-disposition.md) and
[job lookup](pricing-media-job-lookup.md) provide explicit review paths. They do not
accept arbitrary vendor payloads as trusted usage or feed unordered callbacks into
the generic polling observation method. Native profile support and quantity limits
remain explicit and conditional.

Loss before any terminal observation is durably written remains unresolved if no
provider job can be queried. Generic code cannot safely infer a job ID, refund or
redispatch. Coordinated task/claim retention and the operator UI do not make absent
supplier evidence known. Verified contract limits, remaining platform/performance
and whole-Goal acceptance are still required. This checkpoint is not a deployed
or release-ready billing product.

## Format references

Implementation field/format checks consulted these primary sources. They establish
formats, not vendor rate defaults or the correctness of a customer's contract:

- [OpenAI image generation guide](https://developers.openai.com/api/docs/guides/image-generation)
- [OpenAI audio transcription response reference](https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create)
- [Microsoft WAVEFORMATEX](https://learn.microsoft.com/en-us/windows/win32/api/mmeapi/ns-mmeapi-waveformatex)

All validation used synthetic metadata and mocked providers, never paid model calls.
See the [Goal Spec](pricing-engine-goal-spec.md), [decisions](pricing-engine-decisions.md)
and [progress](pricing-engine-progress.md) for remaining acceptance gates.

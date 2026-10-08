# Chat modality token evidence

The candidate raw-usage adapter (`provider-raw-evidence` version `3`) reads the
documented Chat Completions token breakdown before response-format conversion.
JSON and final cumulative SSE reports use the same adapter. Repeated cumulative
reports replace earlier evidence; they do not add another fee. Private billing
metadata does not add fields to client-compatible responses.

## Supported fields and boundaries

| Provider Chat field | Pricing dimension | Condition |
| --- | --- | --- |
| `usage.prompt_tokens_details.text_tokens` | `uncached_text_input_tokens` | Cache attribution below |
| `usage.prompt_tokens_details.audio_tokens` | `uncached_audio_input_tokens` | Cache attribution below |
| `usage.prompt_tokens_details.image_tokens` | `uncached_image_input_tokens` | Cache attribution below |
| `usage.completion_tokens_details.text_tokens` | `text_output_tokens` | Explicit reported subset |
| `usage.completion_tokens_details.audio_tokens` | `audio_output_tokens` | Explicit reported subset |

The prompt details are used only with the selected `usage.prompt_tokens` total;
completion details only with `usage.completion_tokens`. A custom total schema or
native Responses total is not silently mixed with a different protocol's details.
No modality is inferred from request content, output bytes, model name or the
remainder after subtracting another modality. In particular, reasoning and
accepted/rejected prediction counts are not extra output charges or evidence
that the remaining output is text. Chat completion image tokens are **not**
advertised by this adapter.

Prompt modality counts include cached tokens. Positive counts become observed
uncached modality quantities only when all cache read/write components are
observed zero. An explicit zero subset remains zero independently of cache
allocation. Nonzero or undisclosed caches leave positive uncached splits missing,
not zero or a guessed proportional allocation. Existing aggregate token estimates
remain explicitly marked estimates. The media adapter now uses the same
conservation helper (`media-metering` version `2`), with its own field names.

Both `usage.prompt_tokens_details.cache_write_tokens` and the separately
documented Responses `usage.input_tokens_details.cache_write_tokens` are read as
cache-write totals. Missing write counters are still not observed zeroes. The
existing TTL decomposition is unchanged; an unknown TTL is not guessed to be 5m.

Safe numbers and exact integer strings are accepted. Negative, fractional,
non-finite, unsafe numeric and malformed counters produce diagnostics. Known
subsets cannot exceed their parent. An explicitly complete three-part input
partition must match total input. Malformed modality evidence cannot become a
free receipt, but does not turn an otherwise valid model response into a 5xx.

## Configuration, admission and historical costs

Choose the desired modality dimensions and their individual rates in the existing
price editor; do not also bill their aggregate input/output parent. Publication
review currently uses `gateway-metering-v5` and describes these dimensions as
**conditional**, with the localized modality/cache/limit warning. Version4 was
the original Chat-modality checkpoint; version5 adds the
[media specification declaration](pricing-media-specification.md). Supplier support and limits
remain unverified. Old review/receipt versions are not rewritten.

Availability is a route capability, not proof that every provider implements the
fields. A Responses or Messages client routed to a Chat Completions upstream can
use these raw fields. Native Responses and Messages do not thereby acquire a
modality breakdown. [Native Gemini array metering](pricing-gemini-metering.md)
is a separate implemented adapter with cache attribution and thinking rules;
[Realtime metering](pricing-realtime.md) uses its own session/response lifecycle. See the
[metering review](pricing-metering-governance.md).

Before relying on a modality tariff for budget protection, configure
`reserve_upper_bound` with verified supplier/contract quantity limits and a
reference. Parent input/output limits establish conservative bounds for each
modality. Those reservation bounds are not observed token partitions. The final
receipt uses actual evidence and the frozen price version, not the reserve.
Missing bounds reject before provider dispatch. `reject_unpriced` also rejects
when the pre-request modality estimate is unavailable. The existing explicit
`compatibility` policy can admit an unknown estimate and reserve zero; it does
**not** guarantee a budget cap. Its admission receipt retains a null estimate and
`estimate_only`, rather than claiming free usage. This policy was not silently
changed. See [admission policies](pricing-admission-policy.md).

Receipts, log cost details and replay retain exact quantities, sources and subset
relationships. A missing/invalid final modality remains incomplete even after a
successful model response; final unknown charges follow existing recovery policy.
Replay is read-only and cannot modify settlements or historical prices.

## Evidence and source scope

The isolated tests exercise all five fields, large integer strings, absent and
nonzero caches, malformed/contradictory partitions, duplicate/fragmented SSE,
Chat/Responses/Messages ingress conversion, reviewed publication, declared-limit
reservation, exact settlement and read-only replay. No real model requests are
needed. Browser and full-suite results are recorded separately in
[implementation progress](pricing-engine-progress.md); this document alone is not
a full M0–M6 acceptance certificate or deployment approval.

Field semantics were checked on September 28, 2026 against the official
[Chat Completions create reference](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create/index.md)
and [Responses create reference](https://developers.openai.com/api/reference/resources/responses/methods/create/index.md).
These sources establish field meanings, not a provider's actual model support,
commercial prices or limits. The separately inspected
[Gemini GenerateContent reference](https://ai.google.dev/api/generate-content)
uses modality arrays and a distinct thoughts/candidate total relationship; those
must not be guessed from Chat field names.

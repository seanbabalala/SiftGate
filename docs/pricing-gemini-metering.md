# Native Gemini GenerateContent metering

`gemini-generate-content` adapter version `1` normalizes the native
`usageMetadata` report before response conversion. It is used for a Gemini
upstream behind the existing Chat Completions, Responses and Messages ingress
APIs. There is no new public Gemini ingress route. JSON and final cumulative SSE
reports share the same adapter; duplicate cumulative reports do not add fees.

## Totals and thinking

The native relationship is:

```text
totalTokenCount = promptTokenCount + candidatesTokenCount + thoughtsTokenCount
pricing total_input_tokens = promptTokenCount
pricing output_tokens = candidatesTokenCount + thoughtsTokenCount
pricing reasoning_output_tokens = thoughtsTokenCount (subset, never an extra fee)
```

A missing component can be reconstructed only from a complete, consistent
reported relationship. In particular, `totalTokenCount - candidatesTokenCount`
is **not** prompt usage when thinking is present. Explicit invalid values are
not replaced by a more convenient fallback. Contradictory totals produce
diagnostics and cannot produce a complete priced receipt.

If both the total and thinking count are absent, a reported candidate count can
remain a labeled **estimate** of aggregate output. Thinking stays missing, not
observed zero. The numeric compatibility response/log fields include thinking
when the complete total is known; unsafe integers remain exact in the private
pricing receipt instead of being rounded into numeric compatibility fields.

## Modality and cache allocation

| Native field | Meaning |
| --- | --- |
| `promptTokensDetails[]` | Cache-inclusive prompt counts, keyed by `modality` |
| `cacheTokensDetails[]` | Cached prompt counts, keyed by `modality` |
| `candidatesTokensDetails[]` | Returned candidate output counts, excluding internal thinking |
| `tokenCount` | Nonnegative exact integer count for the named modality |

`TEXT`, `AUDIO` and `IMAGE` map to the existing input/output token dimensions.
The shared normalization helper subtracts attributable cached counts for each
input modality. For example, 60 text prompt tokens with 30 cached text tokens
produce 30 uncached text tokens, not 60 and not a guessed proportional split.
If explicit cache parts account for the entire reported cached total, a missing
cache part can be established as zero by conservation. Otherwise, missing cache
attribution stays unknown. An absent cached aggregate is not inferred from a
potentially partial list. A cached subset cannot exceed its prompt counterpart.

GenerateContent input accounting has no cache-write token component: the prompt
contains uncached and cached input. This does **not** declare separate cache
resource creation, storage, tool or other API fees free; they are outside this
GenerateContent receipt. No default cache TTL or storage duration is inferred.

Candidate modality lists are checked against `candidatesTokenCount`, not the
larger thought-inclusive output. Candidate text is not asserted to be the whole
billable text-output quantity when thinking is nonzero or unknown: its pricing
text quantity stays missing, while aggregate output remains usable when known.
Use aggregate output pricing for such a contract, or the existing reviewed
supplier-evidence workflow when the supplier establishes the allocation. The
adapter does not guess that all internal thinking has a particular modality.

Duplicate modality entries, malformed counts, excessive arrays, negative or
unsafe numeric values and impossible sums produce bounded diagnostics without
retaining arbitrary supplier values. Each list is limited to 32 entries. Missing
modality entries are not generally synthesized as zero. Positive native `VIDEO`,
`DOCUMENT` or `MODALITY_UNSPECIFIED` counts are not relabeled as image/audio
tokens; that direction's modality partition is unsupported while its aggregate
token evidence remains available. No content, media bytes or hidden thoughts are
stored as pricing evidence.

## Configuration and compatibility

The existing visual price editor supports the six modality token dimensions and
aggregate cached tokens. The original Gemini checkpoint introduced this capability
in metering review version3; the current review is `gateway-metering-v5`, with
[specification-source declarations](pricing-media-specification.md). Image output
token pricing is available on the three public chat ingress formats because the
native Gemini adapter can supply it. This remains **conditional**: it does not claim that a
Chat Completions upstream reports image output tokens, that every model supports
the chosen modality, or that the gateway gained a new image transport feature.
The seven-language review warning explains cache attribution and thinking gaps.

Use verified supplier limits and `reserve_upper_bound` for budget protection.
Per-dimension reservation bounds can be larger than an actual partition; they
are conservative reserves, not final token observations. Frozen price versions,
actual settlement, reports, replay and unknown-cost recovery use the same existing
accounting chain. Compatibility admission remains explicitly estimate-only and
does not guarantee a spending cap.

Explicit usage on a failed upstream response is also retained. The existing
legacy logical-budget policy still releases a failed client request's reserve;
its budget debit can be zero while the separate upstream expense is positive.
Upper-bound admission does not silently switch this settlement policy. The current
[actual-upstream policy](pricing-actual-budget-runtime.md) can be separately selected
by an administrator; it is not inferred from using this adapter or from publishing
a price. Incomplete evidence retains the actual-policy hold rather than becoming
an invented supplier debit.

An explicit non-native/custom usage schema is not overwritten by the native
adapter. Interactions, Gemini Live, Vertex prediction and asynchronous Veo result
schemas are different contracts, not aliases for this one. Older receipts and
review versions are not rewritten. There is no migration change.

## Sources and verification scope

The field relationship and modality enum were verified on September 28, 2026
against the official [GenerateContent reference](https://ai.google.dev/api/generate-content).
The current general thinking, caching and token guides describe Interactions
fields; those fields were deliberately **not** copied into this GenerateContent
adapter. No current model price, maximum, cache discount or support claim is
inferred from a model name.

Unit and real-ingress tests cover cache allocation, missing versus invalid data,
large integers, totals/thinking, custom-schema isolation, JSON/SSE parity,
publication, positive upper-bound reservations, settlement and read-only replay.
They also cover failed-attempt usage, reports and bounded derived-count overflow;
normalization errors cannot turn valid model output into a 5xx.
The [progress log](pricing-engine-progress.md) records actual executed checks and
remaining original-Goal work; neither a source document nor a passing targeted
test is a full M0–M6 acceptance certificate or permission to deploy.

# Unified metering dimensions and module boundaries

This record maps the eleven original METER-01 dimension rows plus its embeddings
paragraph, and the eight original ARCH-01 module rows, to the current source and
passed assertions. It verifies those twenty items, not every supplier/model,
performance target or final deployment requirement.

## Dimension acceptance

| Original dimension family | Actual evidence and accounting boundary |
| --- | --- |
| Total and uncached input | Cache-inclusive total selects context tiers; uncached input is the ordinary chargeable quantity. Total input is not a separate billable component. |
| Cache reads | Reads retain their input-subset relationship. Native cache-exclusive Messages totals and Gemini modality/cache allocations are normalized before pricing. |
| Cache writes | Known5m/1h quantities and unknown-TTL remainder are separate. The full write aggregate is not charged again and an unknown TTL is not assigned to5m. |
| Output and reasoning | Aggregate or explicit text/audio/image subsets can be priced, but not both parent and children. Thinking is included once in the native Gemini aggregate; reasoning is non-billable subset metadata. |
| Multimodal input | Text/audio/image splits require explicit evidence and cache attribution. Unknown cache allocation never becomes an invented uncached split. |
| Requests | Client request, physical attempt and batch identities remain separate. Known successful invocations can contribute a local count; failed counts require supplier evidence. A shared physical base fee is allocated, not multiplied by client count. |
| Images | Successful observed output count differs from requestedn. Requested quantity is a separate explicit contract basis or labelled estimate. Opaque output does not establish zero. |
| Audio | Provider duration or bounded PCM WAVE measurement supplies input/output seconds. Requested seconds and HTTP latency are not actual duration. Speech characters use Unicode code points. |
| Video | Actual/requested duration and generation counts preserve their sources. Polling, content downloads and idempotent replays do not add generation charges; uncertain submission is not regenerated. |
| Rerank | Request count, processed documents, requested documents and search units have separate units. Result length/top_n is not processed work; missing counts remain unknown. |
| Realtime | Each response has its own token receipt. Session duration is a separate monotonic component with zero response count. Fees combine only under an explicit contract; independent ASR uses its own model, quota and token/duration evidence. |
| Embeddings | Independent input prices and an explicit output-zero operation are supported. Missing input/cache evidence is not fabricated. Actual single and batched ingress use the same accounting core. |

Direct actual-request evidence includes:

- `pricing-runtime.e2e-spec.ts`: raw cache TTLs, input thresholds, embeddings,
  immutable costs and quote/receipt/budget/log agreement;
- `pricing-chat-modality.e2e-spec.ts` and `pricing-gemini-modality.e2e-spec.ts`:
  six JSON/SSE ingress combinations each, explicit limits, positive reservations,
  observed partitions and incomplete-evidence behavior;
- `pricing-media.e2e-spec.ts`, `pricing-actual-quantity.e2e-spec.ts` and
  `pricing-media-task.e2e-spec.ts`: image counts, audio direction/duration/characters,
  all rerank bases, actual budgets, async price pinning, polls, cancellation,
  downloads and no-repeat-generation behavior;
- `pricing-realtime.e2e-spec.ts`, `pricing-realtime-actual.e2e-spec.ts` and
  `pricing-realtime-transcription.e2e-spec.ts`: real loopback WebSockets, response
  and session clocks, separate ASR, paid failure/cancellation and exact replay;
- `pricing-batch-runtime.e2e-spec.ts`: one physical dispatch/base fee, conserved
  allocation, separate retries and original price/FX references.

The private clause map identifies exact passed assertion names and source hashes.
These tests run mocked suppliers and disposable databases; they are not live
vendor-contract certification. Native profiles without actual seconds remain
explicitly manual/conditional. Choosing a price dimension does not manufacture
an adapter, model capability or missing evidence.

## New compiled-adapter probe

Nineteen additional scenarios call the actual compiled adapters and calculator,
with network/listener/child-process entry points blocked. Seventeen known amounts
are independently reproduced with Python integer fractions and final decimal
rounding; two scenarios retain unknown quantities and no final amount.

| Synthetic example | Exact result |
| --- | --- |
| 10,000input split into4,500uncached/4,000cached/1,000five-minute/500one-hour, plus100output | USD0.00735 |
| Request4images, actual3, USD0.04/image | USD0.12 actual basis; USD0.16 explicit requested basis |
| 61audio seconds at USD0.06/60seconds | USD0.061 |
| 6.4measured output seconds plus one explicit request fee | USD0.66 |
| Three Unicode speech characters at USD0.01/character | USD0.03 |
| One rerank request, three processed documents, two search units | USD0.17 under the three explicit rates |
| 6.4video seconds plus one explicit generation | USD0.66 |
| 1.234567891session seconds at USD0.1/second | USD0.123456789 at nine-place rounding |

Additional cases inspect exact Chat/Gemini modalities, reasoning, unspecified
cache TTL, embedding evidence quality, Realtime response counters and independent
ASR token/duration reports. The embedding fixture intentionally lacks explicit
cache counters and stays **estimated**, not newly observed. Opaque speech duration
and unreported rerank processed-work quantity remain unknown.

Four negative cases reject billable total input, separate reasoning fees,
output-parent/subset duplication and implicit same-input audio-duration/token
combination. Earlier probe failures are retained: rates missing a leading zero
violated the decimal-string contract, and a negative fixture incorrectly treated
input duration plus output tokens as the same-side duplicate. The fixture was
corrected to the intended same-input overlap; application validation was unchanged.
No failed probe is included as a passing result.

## Architectural boundary acceptance

| Original module | Verified responsibility |
| --- | --- |
| Usage Normalizer | Converts protocol evidence to allowlisted quantities/source/quality, with no price-database or network dependency and no retained content. |
| Pricing Rule Compiler | Validates shape, units, overlap and bounds, then builds immutable indexes. It does not fetch price pages during requests. |
| Price Resolver | Uses the admitted catalog and actual target/context, returning selected rules and explanations without inventing unavailable prices. |
| Cost Calculator | Performs shared pure exact arithmetic for quotes and actual receipts; persistence is outside it. |
| Pricing Repository | Owns drafts, immutable versions, scopes and audited publication transactions using standard local dependencies. |
| Cost Settlement | Owns exact reservations, durable evidence, atomic effects and linked corrections; supplier cost and explicit logical budget policy remain distinguishable. |
| Pricing Dashboard API | Applies real sessions, workspace/RBAC/origin/body validation, portable exports and atomic audit without returning provider credentials. |
| Compatibility Adapter | Preserves complete legacy overrides, explicit zero/cache aliases, formula semantics and review-only import; it does not auto-activate a new budget policy. |

An AST walk of the **exact compiled** literal dependency graph covers33modules
reachable from the normalizers, rule compiler, catalog resolver and calculator.
Its only external module is `node:crypto`; no filesystem, network, ORM or server
service enters those roots. The executed probes complement this static check.
This is not protection against malicious runtime monkeypatching and does not
forbid storage/network in the separate repository, settlement and supplier-control
services where those responsibilities belong.

Runtime manifests and source contain no dependency on the proprietary reference
repository. That architectural fact does **not** resolve every source-license or
provenance question; REF-01 remains a separate final audit.

## Source and remaining gates

The application, tests, dependencies and compiled files are unchanged from the
historical-calculation-policy checkpoint. Its **4,229unit/205-suite and807HTTP/
65-suite** results remain applicable by exact source and result hashes; this was
not another full regression run. New evidence is the19-case compiled probe,
independent arithmetic, module graph and20-item original-clause map.

Older metering documents have been clarified where they still described callbacks
or actual budgets as unimplemented. That documentation correction adds no runtime
feature and does not claim universal supplier support. The original PostgreSQL
latency/throughput target remains unmet. Remaining UI, migration/platform,
provenance and final fixed-source candidate requirements remain open.

No production config, database, process, watchdog or dependency was changed. No
server or database was started by this probe, and no Git, container or deployment
action was performed.

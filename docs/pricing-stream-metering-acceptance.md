# Stream metering acceptance

This record maps the seven original `METER-03` clauses to executable evidence.
It does not close other metering, asynchronous lifecycle, performance or deployment
requirements. All fixtures are synthetic; no production provider is queried.

## Failed Responses receipt

`response.failed` previously emitted an error without retaining its usage for the
physical-attempt observer. An observed charge therefore became unknown. The parser
now invokes the existing usage resolver before emitting the same error. It does
not emit a successful stop, change the public error, dispatch another attempt or
introduce a second settlement path.

The regression covers flat/wrapped envelopes, four fragment sizes, duplicate
reports, exact counts above JavaScript's safe integer range, final cumulative
replacement, missing/invalid counters and observed zero. HTTP tests cover native
Responses and conversion to Chat Completions and Messages. For the synthetic
100-input/30-cached/20-output receipt, each route records one USD0.000113 cost;
missing or malformed usage stays unknown. Native SSE remains byte-for-byte intact.

The corrected regression fixtures fail against the parent parser: twelve unit
cases and the three observed-usage HTTP cases. Missing/invalid HTTP cases already
passed; those were not represented as new failures. An earlier fixture mixed
cache-exclusive and Responses-style fields; it was corrected rather than changing
normalization or weakening the expected amount.

## Clause map

| Original clause | Implementation and assertion boundary |
| --- | --- |
| 1. Extend existing adapters | `pricing-usage-evidence.ts` resolves raw counters through the existing usage schema. Custom and Anthropic cache partitions retain exact strings; no ingress-specific pricing formula is added. |
| 2. Native/converted parity | The `METER-03 normalizes` HTTP matrix uses four upstream protocols, three existing public ingress routes and both JSON/SSE: 24 paths with the same 100-input/40-cached/25-output quantities, one USD0.000114 receipt and the same budget effect. |
| 3. Cumulative vs incremental | The four stream parsers retain final cumulative values. Messages merges start counters and output deltas. Repeated reports do not add costs or attempts; native protocol frames are not rewritten to achieve deduplication. |
| 4. Final evidence and settlement | `ProviderClientService` sends final private evidence to the tracked runtime observer, independently of the client stop frame. Actual/legacy stream-delivery tests verify one retained receipt and budget effect; later corrections remain linked records. |
| 5. Client cancellation | Real HTTP reader cancellation before any stop tests both observed and absent usage. Observed expense survives; absent expense remains unknown. This does not promise to obtain counters that the supplier never reports. |
| 6. Invalid quantities | Raw-adapter and normalizer cases reject negative, non-finite, malformed and unsafe numeric counts, invalid cache partitions and excessive TTL subsets, with structured diagnostics. Large decimal strings remain exact. |
| 7. Response compatibility | Valid JSON with malformed/missing pricing evidence remains successful. Failed SSE retains the original error; private pricing metadata and prompt/output content do not leak into the provider contract or accounting tables. |

Primary suites: `provider-pricing-stream.spec.ts`,
`provider-pricing-evidence.spec.ts`, `pricing-usage-normalizer.spec.ts`,
`pricing-attribution.e2e-spec.ts`, `pricing-runtime.e2e-spec.ts` and
`pricing-stream-delivery.e2e-spec.ts`. Separate Chat/Gemini modality suites cover
their native optional token partitions. Protocol parity means equal supported
evidence, not invented support for every supplier-specific field or model.

## Checkpoint boundary

The source-bound full run passes **4,186 unit tests in203 suites and791 HTTP
tests in62 suites**, with no failures or skips. All original test names and
assertions remain covered. The seven clauses above are verified against exact
passed assertions and source hashes. An additional84-case compiled-adapter matrix
covers ordinary, zero and large exact counts; an independent integer/rational
oracle reproduces every amount without network access.

Builds, lint, frontend contracts/bundle caps, SDKs, configuration/docs and static
deployment/version/registry checks pass. Migration001–018 checksums are unchanged.
Only the Responses parser executable/map and build metadata differ from the
previous compiled checkpoint; frontend assets are unchanged. No new browser,
performance or container acceptance is claimed. The original PostgreSQL HTTP
performance gate and other remaining Goal requirements are still open.

No production config, database, process, watchdog or dependency was changed.
The user-edited2099 model configuration remains protected. All owned test
instances are stopped. No image was rebuilt or deployed, and no Git publication
occurred.

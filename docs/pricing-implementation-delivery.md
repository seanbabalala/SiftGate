# Implementation, fixtures and quality delivery

This checkpoint delivers the current implementation/type contracts (D-02),
complete synthetic fixtures/tests (D-04), and original quality commands/results
(D-08). It is **not** final Goal completion, a committed release, performance
acceptance or deployment approval. Recording a failed gate is part of D-08; it
does not make that gate pass.

## Two attachments

| Attachment | Contents | Bytes |
| --- | --- | ---: |
| `pricing-implementation-review.zip` | Whole public source snapshot, assertion inventories, path-normalized command/result copies, architecture index and independent verification | 6,990,993 |
| `pricing-private-raw-evidence.zip` | Exact original bytes, including private local paths and synthetic test identities; keep private | 3,129,951 |

SHA-256, respectively:

```text
3ba31b0ee6f78647140e8ec372b24928463b988fd57a0ecfcb67da9bcb9432a1
82befbf57f7b23c83e2f15a17542f054e9324621390db07db6aa27181b7bd5ed
```

The portable archive has 1,566 payload files plus its checksum inventory. The
private archive has 165 payloads plus its inventory: 163 exact evidence originals,
an index and a privacy notice. Its machine-specific context is not repository
content and must not be published as a public release artifact.

## Implementation and complete source identity

`source/` contains all 1,405 public files at the tested packaging checkpoint:
437 backend files, including 170 pricing-domain files, 303 files under `test/`,
frontend, SDKs, dependency locks, configuration examples and documentation.
Unlike earlier focused extracts, it is a whole public repository snapshot. It
does not contain installed dependencies, production configuration, runtime data
or a Git repository. Build only in isolated storage with the repository's normal
instructions. This is not the final runtime-image/committed-source deliverable.

The implementation index maps these areas to current source hashes and matching
passed assertion files:

1. Protocol quantities, provenance, missing evidence and media measurements.
2. Rule compilation, frozen catalog selection, calendars, variants and envelopes.
3. Exact money, independent quantity/amount rounding and frozen FX.
4. Immutable versions, inheritance, source review and migrations.
5. Runtime dispatch, exact budget scopes, durable outcomes and settlement/recovery.
6. Image/video tasks, embedding batches and native Realtime accounting.
7. Authenticated administration, cost reports and read-only historical replay.
8. Legacy configuration adaptation and explicit migration/import tools.

All pricing type/schema files are indexed and included with the complete
implementation. The original METER/PRICE/RULE/FLOW/STATE/CALC/ARCH/API wording is
preserved in a requirement index. That index aids navigation; it is not used
alone as proof that every behavior works. Existing clause-level acceptance,
current full-regression assertions and the independently delivered UI/API/native
recovery evidence retain their distinct scopes.

## Full test inventory, without a new full-run claim

| Test group | Passed assertions | Suites | Serial fresh-process batches |
| --- | ---: | ---: | ---: |
| Unit | 4,336 | 205 | 21 |
| HTTP/E2E | 807 | 65 | 13 |

Every batch's exit code, log digest and result digest is checked against the
aggregate. The independent verifier reconciles every `(file, assertion name)`
and its multiplicity, not just a total count. No failed, pending, skipped, todo
or runtime-error test is counted as passing. PostgreSQL was enabled in the full
run. Source fingerprints match the tested application, tests and dependencies;
all 1,473 compiled files are byte-identical. Later source differences are
documentation only and explicitly listed.

These full results are **carried evidence**, not a newly executed 5,143-test run
during packaging. The removed joined-log experiment's 4,357/811 counts are not
the current test inventory. Its dedicated tests remain with its archived code,
not falsely counted among current passing assertions.

## Quality commands and raw provenance

The package includes the 17 full-run command groups: unit and HTTP batches,
backend build, media/realtime child typechecks, lint, frontend tests/build,
documentation, TypeScript SDK tests/types, Python SDK tests, Kubernetes validation,
version synchronization, provider registry, configuration validation and whitespace.
Current delivery documentation/public-source checks are recorded separately.

There are 141 portable evidence derivatives. Each has its own digest and the
digest/path of its exact original in the private companion. Only machine root or
temporary paths are replaced by tokens; assertion names, failures, amounts and
statuses are not removed from those copies. Sensitive runtime configuration and
databases are not bundled. Synthetic fixture data is not supplier/customer data.

The earlier failed full run is retained with all available batches and its three
failed query-shape/mock-injection assertions. Their corrections and subsequent
complete run are distinguished. The rejected joined-log experiment and its
performance failures remain historical evidence. Delivery-only fixture/metadata
and independent-oracle corrections are also recorded; they are not relabelled
as application fixes or hidden as skipped tests.

## Performance: pure calculation passes; HTTP does not

A source audit found that the older pure-quote record's catalog and compiler
fingerprints differed from current files. A fresh run therefore uses the same
full-scale workload: 1,000 models, 20 rules per model, 12 components per rule,
1,000 warmups and 10,000 measured quotes. It visits every model and all quotes
produce 12 priced lines. Its current timings are:

| Percentile | Pure quote |
| --- | ---: |
| p50 | 0.057916ms |
| p95 | 0.063083ms |
| p99 | 0.208292ms |
| Maximum | 0.574208ms |

An independent decimal/integer oracle reproduces the digest of all 10,000 amounts.
The network/listen guard records zero attempts. This is pure in-memory pricing,
not admission persistence, database settlement, an upstream call or HTTP latency.

The original current-application HTTP comparisons were not rerun unchanged.
Both retain every 500-measured/100-warmup repetition, concurrency four, ABBA order,
JSON/SSE, 0/50ms mock delays, durability and the original 5ms/5% targets. The
independent verifier recomputes pooled percentiles and throughput from samples.
All four SQLite and three PostgreSQL scenarios pass. **PostgreSQL JSON/50ms still
adds 16.924709ms p95 and loses 18.472475% throughput.** No exception has been accepted.

The PostgreSQL control includes its documented two startup compatibility fixes;
both versions use read-only post-measurement accounting observation. SQLite uses
immediate shutdown/accounting verification. These limits remain visible. All
19,200 response/accounting checks and 9,600 candidate amounts/32 balances pass,
but correct arithmetic does not waive the failed performance gate.

## Platform evidence and limitations

The carried Linux/ARM64 image is from Rancher Desktop Moby and has the current
application inputs, with documentation-only differences. Its actual CMD,
HEALTHCHECK, password/session authentication, listener recovery and in-flight
shutdown checks are recorded. This is not a new image run. The image fixture
uses SQLite; PostgreSQL is covered by native tests/recovery, not a claimed
PostgreSQL-in-image rehearsal.

The separately delivered [migration package](pricing-migration-delivery.md) has
fresh current compiled-main recovery for both native databases. The
[UI package](pricing-ui-delivery.md) and [cost/API outputs](pricing-cost-output-delivery.md)
have separate source identities, archive hashes and execution boundaries.
Whole-request tiers and the supported USD report/budget contract are explicit;
progressive tiers, continuous-session tariff slicing and arbitrary supplier/model
support are not inferred from the presence of a unit or form.

## Independent archive verification

Fresh extractions verify both inventories and all 163 exact originals. Portable
derivative digests are cross-checked against their raw originals. The verifier
also rejects a falsely changed performance-pass flag, a removed test assertion
and an unexpected payload. Restoring the files passes again.

After extraction, run `python3 verify.py`; optionally add
`--repo /path/to/matching-checkout` for exact source/compiled comparison. This
starts no network, application, database, browser or container. Digests are not
trusted-party release signatures or replacements for code review.

Final committed-source/runtime candidate delivery (D-09), the non-executed
deployment/rollback handoff (D-10), aggregate acceptance and PostgreSQL performance
remain open. Production 2099 and the user's latest model configuration are
unchanged. Nothing has been committed, pushed, merged or deployed.

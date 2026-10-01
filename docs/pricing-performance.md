# Pricing performance verification

Latest conclusion: **overall HTTP performance acceptance remains unmet**. The
inbox-persistence candidate passes three PostgreSQL scenarios and all four SQLite
scenarios. PostgreSQL delayed JSON still fails the unchanged thresholds. See
[PostgreSQL inbox persistence phase](#postgresql-inbox-persistence-phase).
Earlier experiments below are source-specific history, not verification of a
later candidate.

The [activation-availability index](pricing-activation-index.md) has
its own source-bound lookup diagnostic, full regression and repeated pure-quote
benchmark. It is not a new Gateway HTTP comparison and does not waive the
remaining failed case above.

The pricing Goal has separate pure-quote and end-to-end Gateway targets. Passing
one does not prove the other, nor does a macOS result establish Linux/native
SQLite behavior.

## Bounded pure-quote benchmark

`scripts/benchmark-pricing.ts` generates a deterministic synthetic catalog with
1000 model bindings,20 conditional whole-request rules per model, and12 explicit
additive fee components per rule. This is240000 components across1000 immutable
price books. These are synthetic rates, not vendor prices. The components share
the uncached-input dimension deliberately; they represent separately declared
additive fees rather than accidental duplicate usage.

The benchmark compiles the actual catalog, captures one frozen request context,
warms up1000 calls and records10000 real quotes. It visits every model using
round-robin selection, with seeded context-tier choices. Every measured quote
must be priced and produce the expected component count. Output includes raw
per-call durations, p50/p95/p99/max, fixture and result digests, compile time,
source fingerprints, runtime/ABI/platform, hardware and memory/CPU observations.
Amounts are not summed with floating-point arithmetic.

Run only in an isolated, resource-limited environment. The explicit confirmation
flag prevents accidental execution of the full workload; it does not authorize
production load. For example, from an isolated checkout with a private temporary
output directory:

```sh
nice -n 10 npm run benchmark:pricing -- \
  --confirm-isolated --output /YOUR_PRIVATE_TMP/pricing-quote.json
```

Apply the Goal's clean environment, fixed runtime, heap and concurrency limits.
An existing output file is never overwritten. Smaller runs are available for
fixture tests, but `full_scale` and `quote_slo_met` remain false for them. Parameters
are capped at the required scale, with a bounded warmup; do not bypass resource
limits by starting overlapping benchmark processes.

The pure-quote target is p95 ≤2ms and p99 ≤10ms at full scale. A full-scale failure
returns a nonzero exit status, rather than reporting a successful gate merely
because the benchmark ran.

## What it does not measure

The measured interval covers quote selection and exact computation against the
already compiled, frozen catalog. Catalog construction/compilation is reported
separately. It does not include database admission/snapshot writes, reservations,
settlement, provider HTTP, streaming, logging, recovery, reports or retention.
The synthetic workload is not a universal worst case for calendars, FX, media
conditions, every possible contract or every customer machine.

The required fixed mock-upstream comparison with the baseline Gateway remains a
separate gate: incremental p95 latency ≤5ms and throughput reduction ≤5%, with
SQLite/PostgreSQL effects distinguished from pure-function timings. The benchmark
output explicitly records that this HTTP comparison was not performed by this
script. Actual results and any accepted deviations must be recorded before full
Goal completion; see [progress](pricing-engine-progress.md) and the
[Goal performance requirements](pricing-engine-goal-spec.md#16-性能资源和容量验收).

## Initial isolated reference-host result

The full synthetic scale was measured with seed20260928 after1000 warmup calls.
All1000 models were visited; every quote was priced with12 cost lines. The first
reference-host run recorded p50 **0.063416ms**, p95 **0.074ms**, p99
**0.299125ms**, and maximum **0.820916ms**. Catalog compilation was approximately
**2079.20ms**, outside the quote interval. The pure-quote thresholds passed.

This was a resource-limited Node22/ABI127 arm64 macOS process, not the production
Gateway and not a Linux container. The complete hardware/runtime record, source
fingerprints, raw10000 samples and result digest are retained in the private
verification record. No configuration, database or provider was accessed by the
workload. **Gateway HTTP latency/throughput, database persistence and Linux
performance remain unverified by this measurement.**

## Actual HTTP verification — 2026-09-28, not an overall performance pass

The private comparison uses the real compiled `dist/main.js`, including HTTP
validation, API-key authentication, routing, budgets, logging and pricing
recovery. The baseline is an archive of `b61d8f48ee184cadd13049687729f8c2e4352b9c`
with independent dependencies. Neither binary uses the production configuration,
database, port or upstream. An identical egress guard permits only the local mock.

Each fresh on-disk SQLite WAL/FULL instance runs100warmup and500measured requests
at concurrency4. The fixed scenarios are JSON versus SSE and0ms versus50ms mock
delay, in baseline/candidate/candidate/baseline order. The mock reports1000input
and100output tokens, no cached usage, at synthetic input/output rates1/2USD per
million tokens. Candidate prices are actually published and settled, not bypassed.
Quantiles pool the1000measured samples per version/scenario; throughput divides
the request count by the sum of measured intervals. Warmup, setup, shutdown and
post-shutdown persistence validation are outside the HTTP measurement and are
recorded separately. This is a shared reference host, so host activity remains a
limitation even with order balancing and sequential low-priority processes.

The first comparison missed the targets in all four scenarios. A separate V8,
SQL and inclusive method profile identified repeated complete-log-row hydration
by adaptive routing statistics. That reader now selects only the nine fields
needed by its existing bounded sample. It does not change prices, sample size,
routing logic, durability, budget checks or recovery. A real SQLite regression
compares projected versus complete-row summaries and checks timestamp hydration.

The repeated comparison after this projection change produced:

| SQLite scenario | Candidate minus baseline p95 | Throughput reduction | Both targets met in this run? |
| --- | ---: | ---: | --- |
| JSON,0ms mock | +7.864ms | 7.796% | No |
| SSE,0ms mock | −10.946ms | −10.799% | Yes |
| JSON,50ms mock | +9.808ms | 7.402% | No |
| SSE,50ms mock | +4.260ms | 3.620% | Yes |

Negative reduction means an increase in measured throughput. **The overall HTTP
target is still unmet.** These results predate the subsequent startup/shutdown
corrections below; the final candidate must be measured again. Do not use the
passing streaming rows or the pure quote benchmark to declare the full gate met.

### PostgreSQL startup and shutdown boundaries

The pristine baseline cannot initialize its native PostgreSQL entities because
`AgentProfile.last_generated_at` explicitly uses SQLite's `datetime` type. The
candidate's existing portable `Date` mapping avoids that failure. The baseline
was not silently patched to manufacture a comparative PostgreSQL result.

Actual candidate startup then exposed another path that was absent from the
earlier service-level tests: default membership bootstrap inserted a text ID into
a native UUID column. The PostgreSQL startup insert now supplies a UUID while
the conflict update preserves existing IDs. SQLite's legacy ID is unchanged;
native and legacy-varchar startup paths have regression coverage.

The first real PostgreSQL streaming shutdown also caught incomplete post-response
work:600successful HTTP responses but597logs,598committed reservations and two
pending settlement intents after process exit. The intents were retained; this
was not accepted as a successful drain. Competing Nest/manual signal handlers
have been replaced with one SIGTERM/SIGINT shutdown owner: stop the listener
watchdog and begin closing ingress. Nest can then close upgraded Realtime sockets
in its module-destroy hooks. At HTTP-adapter disposal, await HTTP completion and
tracked request accounting (including work after SSE completion), before database
shutdown hooks run. A real Nest/upgraded-socket regression checks this ordering;
waiting for upgraded sockets before their module cleanup would deadlock. The configured timeout
still bounds shutdown and exits nonzero if draining cannot finish.

After these corrections, eight fresh actual-main PostgreSQL runs completed
**4800requests including warmup**, all with matching mock calls, logs, terminal
attempts, committed reservations and applied settlement intents. Every process
exited normally after immediate post-response SIGTERM. Native/report cost strings
and exact budget balances were also checked with decimal arithmetic. No extra
sleep was added to hide a shutdown race. These are candidate-only correctness
and absolute performance observations, **not a baseline comparison**:

| PostgreSQL candidate scenario | p50 | p95 | p99 | Requests/second |
| --- | ---: | ---: | ---: | ---: |
| JSON,0ms mock | 77.815ms | 159.214ms | 232.675ms | 44.100 |
| SSE,0ms mock | 69.307ms | 126.336ms | 171.554ms | 51.896 |
| JSON,50ms mock | 89.946ms | 117.061ms | 129.787ms | 41.799 |
| SSE,50ms mock | 77.131ms | 112.199ms | 147.724ms | 48.674 |

The database pool is capped at4, with one bounded private PostgreSQL server.
Raw per-request timings, database counts, configuration/source fingerprints,
first failures and profiler output are retained in the private verification
record. None of this proves Linux image/native-addon behavior, arbitrary crash
recovery, or the full M6 performance target.

## 2026-09-28 conditional ledger-metric refresh

A new current-source profile found2750 post-ledger budget metric refreshes during
500 measured requests, including writes that changed only attempt receipts,
settlement intents or log projections. Refresh is now requested only when the
transaction collects current-period budget observations, and nested requests are
coalesced until the outer commit. Rollback discards them. The same SQLite and
PostgreSQL tests cover read-only writes, savepoints, old-period corrections,
idempotent reserve/settlement and unchanged threshold notifications.

The second profile records1000 refreshes instead of2750 and9000 budget-rule
SELECTs instead of10750. Both profiles retain2750 ledger writes and6750 SQL
commits. These are profiling counts, not uninstrumented latency claims; inclusive
method timings overlap. Durability, price computation, recovery and the fixed
HTTP workload were not relaxed.

The subsequent uninstrumented baseline/candidate/candidate/baseline comparison,
using the same on-disk SQLite WAL/FULL settings and concurrency4, produced:

| SQLite scenario | Candidate minus baseline p95 | Throughput reduction | Both targets met in this run? |
| --- | ---: | ---: | --- |
| JSON,0ms mock | −9.058ms | −3.405% | Yes |
| SSE,0ms mock | −8.944ms | −3.865% | Yes |
| JSON,50ms mock | +6.844ms | 5.273% | No |
| SSE,50ms mock | +5.257ms | 1.612% | No |

All9600 requests including warmup across16 processes passed response, mock-call,
log, budget and immediate-shutdown checks. The eight candidate processes also
passed4800 exact native/report amount checks and16 exact budget-balance checks,
with terminal attempts, committed reservations and applied settlement intents.

**The full HTTP performance gate remains unmet.** The zero-delay observations
must not be generalized to delayed upstreams, and a shared-host comparison does
not establish that this one change caused every timing difference. Neither the
earlier PostgreSQL candidate-only run nor the earlier Rancher image was rerun
for this source checkpoint. The justified PostgreSQL comparator, final-source
image and full M6 acceptance still require evidence.

## Flat statistics reader and PostgreSQL control follow-up

A delayed-upstream profile was added without changing the comparison workload.
It still found repeated statistics hydration on the request path. The reader now
uses a flat nine-column projection rather than constructing an entity identity
map or loading a hidden primary key. It retains the original time predicate,
order, sample limit and the database driver's column conversions. Real SQLite
and PostgreSQL tests compare the complete-row result, timestamp boundaries,
boolean conversion, empty windows and option clamps. No cache, smaller sample
or weaker accounting durability was introduced.

The subsequent SQLite comparison validates all9600requests including warmup,
4800candidate exact receipts and16exact balances:

| SQLite scenario | Candidate minus baseline p95 | Throughput reduction | Both targets met in this run? |
| --- | ---: | ---: | --- |
| JSON,0ms mock | −10.755ms | −8.006% | Yes |
| SSE,0ms mock | −9.215ms | −4.019% | Yes |
| JSON,50ms mock | +9.358ms | 5.891% | No |
| SSE,50ms mock | +4.444ms | 2.499% | Yes |

The full HTTP gate remains unmet. Shared-host variance remains a limitation;
these results do not establish a causal gain from one reader change alone.

### Explicitly modified PostgreSQL startup control

An independent archive of the baseline was built with only two compatibility
changes: portable Date metadata for `AgentProfile.last_generated_at`, and a UUID
for native PostgreSQL default-membership insertion. No pricing, accounting,
shutdown or performance implementation was copied from the candidate. The exact
two-file diff, source manifest and independently copied locked dependencies are
recorded. The pristine baseline archive was not modified. This control must not
be called an unmodified PostgreSQL baseline.

Its first four JSON0ms comparison processes passed response, log and shutdown
checks. Pooled control p95 was47.270583ms at104.946479requests/second; candidate
p95 was59.224958ms at78.186415requests/second. That is **+11.954375ms p95 and
25.498773% throughput reduction**, not a passing result.

The next process, the control's SSE0ms case, returned600successful responses but
only598logs despite a clean exit. The runner stopped and preserved the failure;
no artificial delay or relaxed assertion masked the missing post-response work.
The remaining scenarios were not run. Therefore this is **an incomplete control
comparison**, not a completed PostgreSQL performance gate.

A separate current-source candidate-only PostgreSQL run then passed4800requests
across eight fresh databases, including immediate JSON/SSE shutdown,4800exact
native/report amounts and16exact balances. Its absolute pooled p95 values were
66.587458ms,66.713875ms,128.046208ms and83.636333ms for JSON0, SSE0, JSON50 and
SSE50 respectively. This is correctness and absolute-timing evidence only.
All task-owned test servers stopped after those experiments; production was not
modified. Later source changes require their own final candidate identity and
verification rather than relabeling these results.

## 2026-09-28 post-Realtime-boundary SQLite comparison

The completed comparison after the Realtime boundary fixes used the same actual
main entrypoint, on-disk SQLite WAL/FULL, concurrency4,100warmup and500measured
requests per process, and baseline/candidate/candidate/baseline ordering. The
baseline retained its original deployed dependency lock; the candidate used its
audited updated lock. This compares complete gateway versions, not pricing-only
overhead with identical dependencies.

| SQLite scenario | Candidate minus baseline p95 | Throughput reduction | Both targets met in this run? |
| --- | ---: | ---: | --- |
| JSON,0ms mock | −9.046ms | −5.403% | Yes |
| SSE,0ms mock | −13.013ms | −11.587% | Yes |
| JSON,50ms mock | +23.062ms | 21.155% | No |
| SSE,50ms mock | +10.789ms | 7.173% | No |

The table pools measured samples across the two repetitions, excludes warmup,
uses nearest-rank p95 and divides total measured requests by total elapsed time
for throughput. Negative reductions indicate higher observed throughput.
All9600requests including warmup passed response, supplier-call, log, budget and
immediate-shutdown checks across16processes. All4800candidate native/report fees
and16exact budget balances passed independent decimal checks; candidate attempts,
reservations, intents and runtime outcomes reached their expected terminal states.
No requests failed and every process exited0. Protected production identity and
configuration hashes remained unchanged, and all test listeners were closed.

**The performance gate remains unmet.** The delayed cases exceed both original
limits; the passing zero-delay cases and correctness results do not waive them.
Shared-host variance and intervening candidate changes preclude attributing these
differences to a particular change without profiling. This completed result
supersedes the earlier partial observations for this source, not the preserved
historical experiments. PostgreSQL comparison and final-image acceptance remain
separate outstanding work.

## 2026-09-28 acknowledged delivery and SQLite I/O scheduling

Request-phase profiling separated socket waits, receipt persistence, budget
application and logging. The runtime now commits a receipt/intent and its
mandatory delivery acknowledgement together, after the independent durable
retention. SQLite/PostgreSQL regressions prove that failed acknowledgement rolls
back delivery while preserving the original replayable evidence. Standalone
legacy delivery and recovery of an older unacknowledged receipt still work.

Profiling500measured requests recorded1000outcome writes instead of2000 and
5796commits instead of6791; background call-log batch counts differed by5.
The transaction-count reduction alone did **not** meet the delayed targets.
Its complete9600request comparison still missed JSON50ms and SSE50ms, with p95
deltas of24.001ms and11.247ms respectively. That failure is retained.

A separate scheduling experiment that yielded inside every SQLite access fence
made latency worse and was rejected. The accepted code yields only after the
first runtime outcome retention has committed and the connection fence is
released. This gives pending network I/O a turn before further synchronous SQLite
work, without a fixed sleep or a weaker persistence boundary. Experimental
preloads were removed from the active comparison runner before the ordinary
uninstrumented comparison; its candidate runs used the actual built application.

| SQLite scenario | Candidate minus baseline p95 | Throughput reduction | Both targets met in this run? |
| --- | ---: | ---: | --- |
| JSON,0ms mock | −1.832ms | 2.788% | Yes |
| SSE,0ms mock | −5.250ms | −1.367% | Yes |
| JSON,50ms mock | +4.556ms | 3.908% | Yes |
| SSE,50ms mock | +13.213ms | 2.565% | No |

All16processes and9600requests including warmup again passed response, logs,
budget, exact receipt and immediate-shutdown checks. The4800candidate exact
native/report amounts and16exact budget balances also match. The workload,
WAL/FULL durability, original baseline dependencies and pooled-quantile method
were unchanged.

The delayed JSON case now meets both targets, but **the overall HTTP gate remains
unmet** because of the delayed SSE p95. A subsequent instrumented SSE diagnostic
had lower p95 but still a high p99; it cannot replace the uninstrumented result or
establish a performance pass. Shared-host and scheduling variation remain
limitations to investigate. PostgreSQL comparative acceptance and final-source
image/package verification are still separate outstanding gates.

## Earlier 2026-09-29 verification — delayed SSE still unmet

After the actual Realtime implementation and semantic policy-editor fix, the
complete SQLite comparison was repeated without a runtime override or profiling
preload. All860files in the baseline archive were checked against the original
`b61d8f48` Git archive; its original lock remained intact. The candidate used its
audited updated dependencies. The workload remains100warmup/500measured requests,
concurrency4, on-disk WAL/FULL and baseline/candidate/candidate/baseline order.

| SQLite scenario | Candidate minus baseline p95 | Throughput reduction | Both targets met? |
| --- | ---: | ---: | --- |
| JSON,0ms mock | −4.700ms | −0.350% | Yes |
| SSE,0ms mock | −6.915ms | −1.058% | Yes |
| JSON,50ms mock | +4.013ms | 4.278% | Yes |
| SSE,50ms mock | +16.594ms | 4.360% | No |

All9600requests across16processes passed response, mock-call, log, budget and
immediate-shutdown checks. Independent decimal validation checked4800candidate
costs and16exact balances. Every owned gateway process and listener stopped;
production identity and configuration hashes remained unchanged. The delayed
SSE p95 still exceeds the original5ms limit, so this is **not an HTTP performance
pass**, despite acceptable throughput and the three passing scenarios.

The separate full-scale1000model/20rule/12component benchmark, with1000warmup and
10000measured quotes, records pure-quote p95 **0.068125ms** and p99 **0.223292ms**.
Those pure-function targets pass; they do not include database or HTTP overhead.

A further instrumented delayed-SSE run preserves600successful requests including
warmup and normal shutdown. Its per-request spans show receipt retention/delivery
work before HTTP completion, with occasional long waits between the committed
retention and delivery. CPU samples also identify canonical JSON work, database
query processing and garbage collection. Inclusive timings overlap, and the
profiling window ends at HTTP completion while final accounting can still drain;
its method counts are not complete lifecycle invocation totals. These are
diagnostic leads, not a causal proof or replacement for the uninstrumented result.

The next optimization must preserve durable evidence before acknowledging work,
complete tracked accounting after responses, and transactional replay semantics.
No persistence guarantee or test was relaxed for this measurement. PostgreSQL
comparison, remaining original acceptance and final-source candidate/image
delivery still require their own evidence.

## 2026-09-29 stream-specific retention scheduling

The retained-outcome path now validates and hashes a caller's document once before
awaiting database access. A private callback holds immutable strings and parses
its own working copy; it cannot accept a caller-supplied “validated” object.
Existing database bytes and mandatory audit are still verified on replay. The
writer also rejects an uncoordinated outer SQLite transaction rather than
acknowledging a nested transaction as durable.

The job/task ownership predicates were combined into one scoped query **after**
the existing request lock. They were not moved before that lock, where an async
attachment could change while waiting. A 500-request diagnostic records3500
document validations and13500 content hashes, versus4500 and14500 before this
work. These are instrumented invocation counts, not latency acceptance.

Two unsuccessful scheduling experiments are preserved, not shipped:

- Collecting SQLite writes while holding the connection fence reduced commits
  but delayed unrelated admission. Its delayed SSE comparison missed both targets.
- Collecting only already-ready work removed that deliberate wait, but the actual
  measured SSE workload used no item savepoints and gained no meaningful commit
  reduction. The coordinator and its isolated experimental tests were removed.

Removing the post-retention I/O turn from every final decision helped SSE but
regressed delayed JSON. The accepted implementation instead keeps the normal
JSON/recovery path unchanged. Only a final decision for the same live request,
workspace and reservation whose stream delivery has already performed its I/O
turn can omit a second turn. Attempt receipts, unrelated work and background
retries retain the default. This hint is not stored in prices, receipts or hashes.
All retention still commits before acknowledgement; delivery and budget recovery
remain separate and tracked through shutdown.

### Balanced, uninstrumented SQLite comparisons

The two runs below use identical source, actual compiled main, on-disk WAL/FULL,
100warmup/500measured requests per process, concurrency4 and the original
baseline/candidate/candidate/baseline order. All860baseline archive files were
checked against `b61d8f48`. The baseline keeps its original dependency lock; the
candidate keeps its independently audited lock. No profiling or scheduling
override is loaded in either comparison.

| Scenario | First run: added p95 / throughput reduction | Confirmation: added p95 / throughput reduction |
| --- | --- | --- |
| JSON,0ms mock | −7.291ms / −3.100% | −7.300ms / −1.914% |
| SSE,0ms mock | −7.243ms / −5.913% | −5.622ms / −1.727% |
| JSON,50ms mock | +4.770ms / 2.795% | +4.318ms / 3.146% |
| SSE,50ms mock | +1.014ms / 0.125% | +3.612ms / 1.258% |

**All four SQLite scenarios meet both original targets in both runs.** Negative
reductions mean higher observed throughput. Shared-host variability remains a
limitation; this is reference-host acceptance, not a universal latency promise.
The raw failures and rejected experiments remain in the private record.

Across32processes, all19200requests including warmup passed response, supplier-call,
log and immediate-SIGTERM drain checks. Independent decimal verification checked
9600candidate native/report costs and32exact budget balances. No post-measurement
sleep was added before SIGTERM. Tests that inspect final SSE totals now await the
existing tracked-accounting completion signal; separate paused-delivery HTTP
checks prove that a request remains visibly pending, not free, before that signal.

These SQLite comparisons used schema017. The **whole M6 gate remains incomplete**;
subsequent index-capacity and PostgreSQL results are recorded below. Final-source
image/runtime and populated-database rollback still require their own evidence.
No production configuration, schema, process or dependency was changed.

## Schema018 capacity and PostgreSQL checkpoint —2026-09-29

The workspace-only task scan now has an additive ownership index. The compiled
migration was verified on50001 synthetic media tasks with identical lookup
results, unchanged non-marker table hashes and unchanged001–017 migration records.
The no-task query's p95 fell from4.607167ms to0.001958ms. This is a SQLite query-only
capacity result, not an HTTP or PostgreSQL capacity claim; see the
[index migration method and maintenance limits](pricing-index-migrations.md).

### Explicit PostgreSQL comparator limits

The pristine historical baseline cannot start with its native PostgreSQL schema.
The comparator retains its original dependency lock and has only the two already
documented startup fixes: portable Date metadata and a UUID-compatible membership
bootstrap. It is a **startup-compatibility control, not a pristine baseline**.
No candidate pricing, accounting, scheduling or shutdown code was transplanted.

The earlier control lost post-response logs when stopped immediately after SSE.
This comparison therefore observes complete accounting through a read-only
PostgreSQL connection **after the measured interval, on both versions**, before
sending SIGTERM. The observation has a10-second deadline and records its samples;
it is not hidden in measured latency or throughput. Warmup,500 measured requests,
concurrency4, pool4,0/50ms local mock delays and ABBA ordering are unchanged.
This experiment does not certify the old control's immediate-shutdown safety.

The first observer incorrectly expected one durable runtime outcome per request;
this fixture actually emits one attempt outcome and one settlement outcome. Its
failed run is preserved. The corrected observer requires exactly twice the request
count, rather than relaxing completion to an arbitrary lower bound. Application
source and measured workload were unchanged.

| PostgreSQL scenario | Added p95 versus startup control | Throughput reduction | Both original targets met? |
| --- | ---: | ---: | --- |
| JSON,0ms mock | +12.626ms | 25.346% | No |
| SSE,0ms mock | +15.666ms | 23.067% | No |
| JSON,50ms mock | +50.788ms | 39.808% | No |
| SSE,50ms mock | −15.373ms | −18.674% | Yes |

**PostgreSQL performance is not accepted:** three scenarios miss the original
5ms/5% targets. No source change, workload reduction or target waiver is concealed
by the passing accounting checks. The delayed-JSON gap is a concrete next
diagnostic target; this measurement alone does not identify its cause.

Separately, eight candidate-only actual-main processes send SIGTERM immediately
after HTTP completion using the original harness, without the new quiescence
observer. All4800 requests including warmup, final logs, terminal outcomes and
budgets survive normal shutdown. Together with the comparison,24 processes and
14400 requests pass accounting checks; independent decimal checks cover9600
candidate costs and32 exact balances. All owned processes/listeners were stopped
and the production guard matched the user-confirmed configuration baseline.

These results use the same runtime source as the1308-file full regression:
3754 unit tests and688 HTTP tests, with no failures or skips. They do not complete
the remaining PostgreSQL performance/capacity, lifecycle, final-image or
populated-database rollback gates. Nothing was deployed to2099.

## PostgreSQL budget-query checkpoint —2026-09-29

Profiling the same actual-main workload identified repeated budget-row reads and
lock waits during settlement. The retained change locks the selected PostgreSQL
rule IDs in one ascending-order query and reuses those locked rows within the
same transaction. Hold releases are still applied in their original order with
the same zero clamp; actual usage is then added and each final counter is saved
once. Inactive original holds, replacement rules and old epochs remain distinct.
This does not merge requests, release locks early or defer durability.

PostgreSQL counter writes now update only the counter, plus the period on an
explicit manual reset. They do not save a stale full configuration entity or
truncate an existing database timestamp's sub-millisecond precision. Tests cover
eight overlapping scopes, a foreign workspace, tiny exact decimals, duplicate
holds, reset epochs, legacy projection drift, concurrent services, rollback after
a partial write and the ordered lock query. SQLite keeps its existing arithmetic
and persistence path.

In the diagnostic run, mean inclusive `settleLedger` time fell from11.263ms to
3.844ms and exact-counter save calls fell from3000 to2000 for500 measured requests.
These overlapping instrumented spans are not latency acceptance. The subsequent
uninstrumented PostgreSQL comparison uses the same explicit startup-compatible
control and post-measurement observation method described above:

| Scenario | Added p95 | Throughput reduction | Both targets met? |
| --- | ---: | ---: | --- |
| JSON,0ms mock | +2.792ms | 9.506% | No |
| SSE,0ms mock | +2.515ms | 10.681% | No |
| JSON,50ms mock | +37.354ms | 34.185% | No |
| SSE,50ms mock | −18.535ms | −17.105% | Yes |

The zero-delay latency gaps are smaller, but **PostgreSQL still misses the full
5ms/5% gate**. A separate experiment combined summary reads using bounded JSON
aggregation. Although delayed JSON improved, zero-delay cases regressed to
14.721ms/23.249% and8.106ms/19.158%. Its passing correctness tests did not make
that tradeoff acceptable: the experiment and its three dedicated tests were
archived and removed from the candidate. Existing summary integrity checks and
read paths remain unchanged.

The current-source SQLite comparison passed all9600 requests and immediate
shutdown/accounting checks, but delayed JSON measured+5.668ms p95, above the5ms
limit, with3.528% lower throughput. Its other three scenarios met both targets.
This does not reproduce the earlier schema017 all-pass result; the miss is
preserved, not attributed to external load without evidence or hidden by a
different threshold. Each of these two comparisons independently verified4800
candidate amounts and16 exact balances.

The retained budget-only source passes3772 unit tests in191 suites and688 HTTP
tests in55 suites, with no failures or skips, plus builds, lint, frontend and
public-file checks. A legacy unit mock was updated to assert the new scoped,
ordered lock query inside its transaction; real PostgreSQL coverage was retained.
Migrations001–018 are unchanged. Performance, remaining lifecycle/capacity and
final candidate/image/rollback gates are still incomplete;2099 was not changed.

## Rejected PostgreSQL scope-discovery experiment

A later experiment combined overlapping budget-scope discovery into one query
and avoided re-reading an already hydrated, still-locked balance. Epoch resets
still invalidated that value and required a fresh read. Focused tests covered216
selector combinations, legacy/null workspaces, scope precedence, external counter
edits, resets, rollback and concurrent settlement. These checks passed, but they
did not establish a performance improvement.

On the same500-request instrumented workload, SQL calls fell from166 to161 per
request and exact-balance hydration calls fell from4000 to3000. Inclusive timings
were mixed; fewer queries alone were not accepted as lower end-to-end overhead.
The balanced uninstrumented PostgreSQL comparison retained the original request
counts, concurrency, delays, control and post-measurement observation method:

| Scenario | Added p95 | Throughput reduction | Both targets met? |
| --- | ---: | ---: | --- |
| JSON,0ms mock | +6.011ms | 15.301% | No |
| SSE,0ms mock | +4.218ms | 10.730% | No |
| JSON,50ms mock | +32.570ms | 30.487% | No |
| SSE,50ms mock | −38.012ms | −26.255% | Yes |

All9600 requests including warmup passed response/accounting checks;4800 candidate
amounts and16 exact balances passed independent decimal checks. Nevertheless,
three cases still failed, with a larger zero-delay JSON gap than the preceding
retained implementation's measurement. Shared-host runs do not prove a cause for
every timing difference, so this result is not labeled a universal regression.
It also does not justify retaining the extra path as an effective optimization.

The experiment and its evidence were archived, and its runtime/test changes were
removed. The preceding implementation was restored by file hashes, rebuilt and
rechecked with113 focused unit tests and47 HTTP tests. Its original3800-unit/
688-HTTP full checkpoint remains the source reference; this is not another full
regression run. The original performance gates remain open. Further work must
address measured request-path work without weakening receipt validation,
transaction boundaries, durability or failure behavior.

## Owned log-projection checkpoint

The retained synchronous PostgreSQL path now uses the verified projection from
the call-log write for metrics, rather than computing a preliminary summary and
then recomputing it under the write's request lock. It requires the captured
request/workspace and a real snapshot; missing projections cannot fall through
to unpriced placeholder writes. SQLite queued logs and unowned paths retain their
preliminary summaries. Error paths still attempt metrics without replaying the
provider. See [the accounting and failure boundaries](pricing-log-projection.md).

The500-request diagnostic profile records1500 full summary computations instead
of2000, zero preliminary summary calls instead of500, and160 SQL calls per request
instead of166. Mean inclusive logging time is3.757ms versus4.547ms in the preceding
profile. These spans overlap, and this observation is not an uninstrumented
latency claim. The following complete comparisons retain the established methods:

| Database and scenario | Added p95 | Throughput reduction | Both targets met? |
| --- | ---: | ---: | --- |
| PostgreSQL JSON,0ms | +1.672ms | 10.317% | No |
| PostgreSQL SSE,0ms | +2.802ms | 12.366% | No |
| PostgreSQL JSON,50ms | +34.645ms | 28.312% | No |
| PostgreSQL SSE,50ms | −8.585ms | −14.803% | Yes |
| SQLite JSON,0ms | −5.273ms | −1.276% | Yes |
| SQLite SSE,0ms | −8.950ms | −2.908% | Yes |
| SQLite JSON,50ms | +5.262ms | 3.275% | No |
| SQLite SSE,50ms | +3.579ms | 0.520% | Yes |

Each comparison completed9600 requests including warmup, with4800 candidate
amounts and16 exact balances independently verified. PostgreSQL still uses the
explicit startup-compatibility control and post-measurement accounting observer;
SQLite retains the original immediate-SIGTERM procedure. Their different shutdown
methods must not be presented as equivalent evidence.

**Performance acceptance remains incomplete:** PostgreSQL misses three cases,
and SQLite delayed JSON is0.262ms above the original5ms p95 limit. The miss is not
waived because it is small. The code is retained for its single authoritative log
projection and verified work reduction, not labeled as meeting the full target.
The exact implementation passes3828 unit tests in194 suites and688 HTTP tests in
55 suites, plus builds, lint and frontend/SDK/configuration checks. Existing
Rancher image and review-bundle evidence predates this code; final-source image
verification and the remaining original acceptance work are still required.

## Transaction-owner guard and rejected read-width experiment

An experiment projected only the request ID during PostgreSQL reservation/attempt
ownership discovery, retaining the subsequent parent lock and full child reread.
The actual profile confirmed six narrower discovery reads per request, but no
reduction in the160-query total. Its completed comparison still missed three
targets: JSON0 added5.928ms/15.741% throughput reduction, SSE0 added4.937ms/12.400%,
JSON50 added41.282ms/35.565%, and SSE50 measured−18.485ms/−19.668%.
The narrower-read implementation was archived and removed, not reported as an
accepted performance improvement.

Separately, the tests exposed that raw locking reads did not reject private-helper
calls outside an explicit transaction. A small transaction/data-source ownership
guard was retained; the original read shape and lock sequence were restored.
Normal public writers already had transactions. This is a defensive precondition,
not a claim that production accounting had been unprotected.

The current guard-only implementation has these subsequent measured results:

| Database and scenario | Added p95 | Throughput reduction | Both targets met? |
| --- | ---: | ---: | --- |
| PostgreSQL JSON,0ms | +40.112ms | 41.153% | No |
| PostgreSQL SSE,0ms | +36.753ms | 32.633% | No |
| PostgreSQL JSON,50ms | +35.826ms | 28.692% | No |
| PostgreSQL SSE,50ms | +1.399ms | 2.337% | Yes |
| SQLite JSON,0ms | +56.715ms | 32.616% | No |
| SQLite SSE,0ms | +41.092ms | 25.476% | No |
| SQLite JSON,50ms | +37.422ms | 17.756% | No |
| SQLite SSE,50ms | +61.427ms | 26.923% | No |

Both unchanged control binaries also ran substantially more slowly than in the
preceding comparisons. A contemporaneous host observation showed background CPU
activity, but did not establish causality for these differences. Neither an
environment explanation nor a guard-induced regression is asserted as proven.
The failed results remain recorded and **performance acceptance remains open**;
earlier passing cases must not be substituted for these current measurements.

Each comparison passed all9600 response/accounting checks, with4800 candidate
amounts and16 balances independently verified. The retained guard-only source
passes3847 unit tests across195 suites and688 HTTP tests across55 suites, plus
builds, lint and compatibility checks. No database schema, pricing policy,
production configuration or running2099 process was changed.

## Composed logical settlement candidate

The ordinary logical runtime now retains the finalized body independently, then
composes intent delivery, acknowledgement and budget application in one owned
transaction. It does not merge retention with application or combine unrelated
requests. The queue-only APIs and dedicated group/task/actual-expense paths remain
unchanged. See [the recovery contract](pricing-runtime-outcomes.md).

A fresh 500-request PostgreSQL diagnostic records 154 SQL calls and 11 transactions
per request, versus the preceding diagnostics' 160 and 12. There are 500 composed
settlements, no separate public `queueSettlement` or `applySettlement` calls on
that path, and still 1,000 independent outcome retentions. This establishes the
intended work reduction, not end-to-end performance acceptance. Inclusive profile
spans overlap and cannot be added as independent costs.

The uninstrumented comparisons retain 500 measured requests plus 100 warmups per
process, concurrency four, 0/50ms mock delays and balanced ABBA ordering:

| Database and scenario | Added p95 | Throughput reduction | Both targets met? |
| --- | ---: | ---: | --- |
| PostgreSQL JSON,0ms | +2.717ms | 9.604% | No |
| PostgreSQL SSE,0ms | +4.236ms | 9.738% | No |
| PostgreSQL JSON,50ms | +36.079ms | 31.349% | No |
| PostgreSQL SSE,50ms | −12.345ms | −14.925% | Yes |
| SQLite JSON,0ms | +4.839ms | 14.287% | No |
| SQLite SSE,0ms | −9.056ms | −6.982% | Yes |
| SQLite JSON,50ms | +3.843ms | 2.103% | Yes |
| SQLite SSE,50ms | +3.966ms | 0.784% | Yes |

Each comparison completed 9,600 requests including warmup with no response or
accounting failures; 4,800 candidate amounts and 16 exact balances were independently
checked. PostgreSQL still uses the documented startup-compatibility control and
read-only post-measurement accounting observation on both versions. SQLite retains
the original immediate-SIGTERM procedure. The first zero-delay SQLite JSON candidate
run was slower than its second run; both remain included in the pooled results.
No outlier removal, causal attribution or threshold waiver is made.

**The original performance gate is still unmet.** Three PostgreSQL cases and one
SQLite case fail at least one target. The candidate passes 38 new cross-database
tests and 132 HTTP regressions, plus build and lint; a broader 586-unit selection
passed on identical runtime source before two test-only fixes. This is not a new
full-suite run. The previous 3,847-unit/688-HTTP checkpoint predates composition.
Full regression, remaining original acceptance and final-source Rancher image/bundle
verification remain outstanding; no production deployment was performed.

## Earlier validated cost projection within settlement

The next candidate prepares the same validated log subtotal before acquiring the
shared budget rows, while keeping the request fence, transaction boundaries and
the original log-write position. No query, receipt validation or adjustment-chain
check is omitted. A real PostgreSQL non-waiting lock test proves the shared budget
row is available while projection is paused, but the request parent remains locked.
See [the projection boundaries](pricing-log-projection.md).

The 500-request diagnostic still records 154 SQL calls and 11 transactions per
request. All 500 application projections occur before budget application. The
mean span from budget-application return to settlement-application return is
0.886ms, versus 2.285ms in the preceding diagnostic. This is only part of the
transaction, not the entire lock-acquisition-to-commit duration. Runs were sampled
separately, inclusive spans overlap, and these observations are not an end-to-end
acceptance result.

The complete uninstrumented comparisons preserve the original workload and methods:

| Database and scenario | Added p95 | Throughput reduction | Both targets met? |
| --- | ---: | ---: | --- |
| PostgreSQL JSON,0ms | +1.972ms | 6.601% | No |
| PostgreSQL SSE,0ms | +6.811ms | 10.451% | No |
| PostgreSQL JSON,50ms | +29.241ms | 24.537% | No |
| PostgreSQL SSE,50ms | −14.142ms | −15.210% | Yes |
| SQLite JSON,0ms | −2.883ms | 5.023% | No |
| SQLite SSE,0ms | −8.758ms | −6.584% | Yes |
| SQLite JSON,50ms | +3.948ms | 3.048% | Yes |
| SQLite SSE,50ms | +3.714ms | 1.144% | Yes |

Each comparison completed 16 processes and 9,600 requests including warmup with no
response/accounting failures; 4,800 candidate amounts and 16 balances passed exact
decimal checks. PostgreSQL retains the explicit startup-compatibility control and
read-only post-measurement accounting observation on both versions. SQLite retains
the immediate-SIGTERM procedure. No repetition was removed or threshold relaxed.
The SQLite 5.023% throughput result remains a failure despite its proximity to 5%.

**Overall performance acceptance remains incomplete.** The candidate is retained
for its verified shorter shared-lock interval and unchanged accounting guarantees,
not labeled as meeting the original performance target. Focused verification passes
591 unit tests and 132 HTTP tests, build and lint; complete-source regression is
tracked separately. No new image, deployment or production change is implied.

## Bounded runtime-audit reads

Runtime outcome verification now retrieves the exact retained, delivered and
review-required audit identities in one workspace-scoped query, bounded to three
rows. It still validates the mandatory retention marker first, then every
transition actor, action, metadata hash and state combination. The request-first
lock, independently committed retention, delivery acknowledgement, budget
application and rollback boundaries are unchanged. Verification is not cached
between transactions, and a delivered marker alone is not proof of budget application.

Six added SQLite/PostgreSQL tests cover all 12 state/transition combinations per
database, six corruption variants for each mandatory event, foreign workspaces
and suffix lookalikes. The focused checkpoint passes 137 unit tests and 132 HTTP
tests, build and lint. The initial red test correctly observed two audit reads;
subsequent compiler-narrowing and synthetic JSON-expectation failures are retained
in the private evidence rather than relabeled as passes.

Fresh profiling of 500 measured requests records 152 SQL statements per request,
down from 154, with the same 11 transactions. This proves fewer round trips, not
an end-to-end latency improvement. A separate startup-control profile records 36
SQL statements per request. In those separate instrumented JSON/50ms runs, the
mean window from upstream response headers to downstream response completion is
6.292ms for the control and 21.909ms for the candidate. The fetch-to-headers means
are 51.464ms and 51.212ms. These locate additional work after headers; they do not
establish an exclusive root cause, and inclusive method spans must not be added.

The uninstrumented comparisons keep 100 warmup plus 500 measured requests per
process, concurrency four, ABBA ordering and the original thresholds:

| Database and scenario | Added p95 | Throughput reduction | Both targets met? |
| --- | ---: | ---: | --- |
| PostgreSQL JSON,0ms | +2.658ms | 8.447% | No |
| PostgreSQL SSE,0ms | +3.256ms | 7.749% | No |
| PostgreSQL JSON,50ms | +28.786ms | 25.450% | No |
| PostgreSQL SSE,50ms | −5.754ms | −8.384% | Yes |
| SQLite JSON,0ms | −6.326ms | 0.207% | Yes |
| SQLite SSE,0ms | −6.040ms | −4.544% | Yes |
| SQLite JSON,50ms | +4.032ms | 3.362% | Yes |
| SQLite SSE,50ms | +3.668ms | 0.944% | Yes |

Each comparison completes 9,600 requests, with 4,800 candidate amounts and 16
balances checked exactly and no response/accounting failures. PostgreSQL uses a
fresh private cluster for both versions with fsync, synchronous_commit and
full_page_writes enabled, rather than restarting the accumulated older fixture
cluster. The startup-only compatibility control and read-only post-measurement
accounting observation on both versions remain explicit. SQLite still performs
immediate SIGTERM. Previous failed comparisons remain valid historical evidence;
the fresh cluster does not prove they were caused only by the environment.

The simpler bounded read is retained with its integrity checks, **not as a passed
PostgreSQL performance gate**. The prior Rancher image predates this runtime change
and is not a current-source release candidate. Production 2099, including the
user-confirmed model configuration change, was not modified or restarted.

## Joint receipt delivery

Eligible PostgreSQL synchronous legacy-budget requests now use three durable
boundaries for receipt and settlement work instead of four:

1. Independently retain the immutable attempt receipt before returning from the
   provider stage. Pricing is already fixed; no new prices are read at settlement.
2. Independently retain the settlement proposal.
3. In one transaction, validate retained receipt ownership, body and mandatory
   audits, acknowledge the receipt and settlement, apply the receipt and budget,
   and update the existing log projection. Failure rolls this transaction back
   without losing either independently retained body.

Successful joint settlement commits before the synchronous caller returns; accounting
failures retain the existing bounded recovery behavior, not a provider retry. A failed composition,
another dispatch or request teardown drains the owned standalone receipt. Only the
captured callbacks acknowledged by that decision are retired; newer work is not
discarded. Streams, SQLite's ordinary runtime, actual-upstream budgets, media and
physical-batch lifecycles do not select the new joint-delivery path. Generic queue
and replay APIs remain queue-only; a delivered marker alone does not prove budget
application.

The pending-attempt path also checks existing durable receipt provenance before
applying an intent. A pending terminal projection cannot authorize replacing a
different retained cost or bypassing quarantine, scope or required audits. Joint
delivery revalidates previously delivered markers rather than trusting the state
column. Discovery reads distinct subject identities in chunks of 900 and then only
the exact matching bodies, not all alternate receipt bodies.

The 34 new SQLite/PostgreSQL cases include immutable mismatch, audit and ownership
damage, both acknowledgement/money rollback, concurrent standalone replay, real
child exit after uncommitted acknowledgements, bounded body reads and runtime
drain/failure/retry behavior. Complete regression passes 3,950 unit and 704 HTTP
tests with no failures or skips; both red experiments remain in the evidence.

The separate 500-request PostgreSQL profile records 152 to 143 SQL statements per
request, 11 to 10 transactions, and three to two full summary computations.
Independent receipt/settlement retention remains twice per request. These counts
prove the structural reduction; inclusive timings overlap and do not themselves
prove latency acceptance.

| Database and scenario | Added p95 | Throughput reduction | Both targets met? |
| --- | ---: | ---: | --- |
| PostgreSQL JSON,0ms | −1.591ms | 3.932% | Yes |
| PostgreSQL SSE,0ms | +3.149ms | 9.159% | No |
| PostgreSQL JSON,50ms | +27.085ms | 22.697% | No |
| PostgreSQL SSE,50ms | −9.485ms | −12.156% | Yes |
| SQLite JSON,0ms | −5.245ms | 2.033% | Yes |
| SQLite SSE,0ms | −4.154ms | −2.070% | Yes |
| SQLite JSON,50ms | +3.918ms | 2.657% | Yes |
| SQLite SSE,50ms | +5.186ms | 0.911% | No |

Each comparison contains all 16 processes and 9,600 requests, with no response or
accounting errors. All 4,800 candidate amounts and 16 balances per comparison are
exact. Requests, warmup, concurrency, ABBA ordering, durability and thresholds are
unchanged. PostgreSQL uses a fresh private durable cluster, the explicit startup-only
compatibility control and read-only accounting observation after measurement on
both versions. SQLite keeps immediate SIGTERM. Neither slow repetitions nor the
SQLite +5.186ms failure are discarded. Shared-host variance is not an established
exclusive cause and is not used to claim a pass.

The candidate is retained for the verified transaction reduction and stronger
pending-receipt consistency, not declared performance-complete. Production 2099
and its user-confirmed model edit remain untouched. No new image or deployment is
claimed; the original Goal remains active.

## Transition audit verification

After verifying a retained row and its three possible audit markers under the
request lock, a transition no longer re-reads the terminal marker it has just
proved absent. Its insertion remains unique and part of the same transaction.
Joint receipt acknowledgement likewise uses the transition's fresh body/owner/
audit verification instead of running it twice. Non-acknowledging intent paths
still perform their own verification. No validation is cached across transactions,
no terminal state is trusted without its audit, and neither independent retention
boundary nor budget commit is removed.

Transition identity checks now compare the caller's captured workspace, request,
reservation and document with both the locked owner and fresh stored row. A
missing row returns a structured not-found error. Ten reproducing red cases
covered the duplicate audit read and missing/mismatched identity defenses; all
now pass. These synthetic raw-helper corruption cases are not evidence of a
production exploit or actual customer misbilling.

The 500-request PostgreSQL profile records **143 to 140 SQL statements per
request**, with audit reads reduced from seven to four. Ten transactions and two
independent retentions per request remain unchanged. This is a measured query
reduction, not evidence that every latency or throughput target passes.

| Database and scenario | Added p95 | Throughput reduction | Both targets met? |
| --- | ---: | ---: | --- |
| PostgreSQL JSON,0ms | +4.783ms | 8.664% | No |
| PostgreSQL SSE,0ms | +5.587ms | 11.942% | No |
| PostgreSQL JSON,50ms | +17.552ms | 16.934% | No |
| PostgreSQL SSE,50ms | −6.780ms | −13.760% | Yes |
| SQLite JSON,0ms | +1.716ms | 10.362% | No |
| SQLite SSE,0ms | −10.076ms | −5.943% | Yes |
| SQLite JSON,50ms | +4.648ms | 4.586% | Yes |
| SQLite SSE,50ms | +1.380ms | 0.145% | Yes |

Each comparison keeps all 16 processes and 9,600 requests, including warmup.
There are no response/accounting errors; all 4,800 candidate amounts and 16 exact
balances per database pass independent decimal checks. Runtime, workload,
concurrency, ABBA order, durability and original thresholds remain unchanged.
PostgreSQL uses a fresh durable private cluster and the same explicitly patched
startup-compatibility control/read-only post-measurement observer. SQLite retains
the immediate-SIGTERM procedure. No slow repetition is dropped, and shared-host
variance is not asserted as the exclusive cause of a failure.

Current-source regression passes **4,007 unit tests in 197 suites and 712 HTTP
tests in 56 suites**, without failures or skips, plus builds, lint, frontend,
SDKs, config/docs and static deployment checks. All 18 migration checksums remain
unchanged. The change is retained for fewer redundant reads and stricter identity
validation, not a passed overall performance gate. The Goal, remaining acceptance
mapping and final-source image/bundle are unfinished; production2099 and the user's
model edit remain untouched.

## Log subtotal read scope

The numeric call-log projection no longer reads complete settlement-intent and
recovery-case lists simply to discard their display fields. Both numeric and
detailed views still execute the same receipt, adjustment-chain, decimal,
reservation and allowance checks. They use fresh scoped database reads inside
the existing request transaction; no subtotal or integrity result is cached
across commits. The numeric overload returns only `known_subtotal`, so it cannot
be passed off as a complete report. Normal detail/report/replay callers still
load their intent/recovery metadata.

This changes neither supplier pricing nor the independent retention/settlement
boundaries. Sixteen added SQLite/PostgreSQL tests cover omitted display reads,
complete detailed reports, corrupt receipt/context/estimate/decimal rejection,
fresh correction reads and broken application-chain rejection. Existing tests
still verify projection before shared budget locks, rollback on log failure,
unknown-cost handling, tenant ownership and retained receipt integrity.

The separate 500-request PostgreSQL profile records **140 to 136 SQL statements
per request**. The two summary calculations remain, but their four display-only
queries are gone. Ten transactions and two independent retentions per request
are unchanged. This is structural evidence, not a substitute for end-to-end
performance acceptance.

| Database and scenario | Added p95 | Throughput reduction | Both targets met? |
| --- | ---: | ---: | --- |
| PostgreSQL JSON,0ms | +3.417ms | 8.581% | No |
| PostgreSQL SSE,0ms | +7.975ms | 8.547% | No |
| PostgreSQL JSON,50ms | +13.255ms | 12.225% | No |
| PostgreSQL SSE,50ms | −19.625ms | −18.035% | Yes |
| SQLite JSON,0ms | −2.119ms | 3.357% | Yes |
| SQLite SSE,0ms | −1.015ms | −0.165% | Yes |
| SQLite JSON,50ms | +4.305ms | 4.087% | Yes |
| SQLite SSE,50ms | +7.109ms | 3.195% | No |

Both comparisons retain all 16 processes and 9,600 requests including warmup.
All 4,800 candidate amounts and 16 exact balances per comparison pass independent
decimal checks, with no response/accounting errors. The original workload,
concurrency, ABBA ordering and thresholds are unchanged. PostgreSQL uses a fresh
private durable cluster, the existing explicit startup-compatibility control and
read-only post-measurement accounting observer on both versions. SQLite retains
immediate SIGTERM. No slow repetition is omitted and no host-load-only explanation
is asserted for a failure.

Complete regression passes **4,031 unit tests in 197 suites and 734 HTTP tests in
57 suites**, with no failures or skips. Builds, frontend contracts/bundle budgets,
lint, SDKs, configuration, documentation and static deployment checks pass; all
18 migration checksums are unchanged. The reduced-read projection is retained,
but the original performance gate, remaining acceptance and final-source image/
bundle are still incomplete. Production2099 and the user's model configuration
were not changed or restarted.

## Bounded exact-budget hydration

Selected budget balances are now read in chunks of at most 250 exact rule/epoch
pairs under the existing workspace and transaction boundaries. Reservations no
longer immediately repeat an unchanged rule's hydration; reset epochs still get
a fresh read. There is no cross-transaction balance cache or relaxed accounting
guarantee. See [the implementation boundaries](pricing-budget-hydration.md).

The separate 500-request PostgreSQL diagnostic records **136 to 131 SQL
statements per request**, including eight to three exact-balance reads. Ten
transactions, two independent durable retentions and two cost summaries per
request remain unchanged. Inclusive profile spans overlap; their timings cannot
be added or substituted for the uninstrumented comparisons below.

| Database and scenario | Added p95 | Throughput reduction | Both targets met? |
| --- | ---: | ---: | --- |
| PostgreSQL JSON,0ms | −1.740ms | 3.830% | Yes |
| PostgreSQL SSE,0ms | −0.292ms | 4.633% | Yes |
| PostgreSQL JSON,50ms | +29.998ms | 24.797% | No |
| PostgreSQL SSE,50ms | −4.385ms | −11.704% | Yes |
| SQLite JSON,0ms | −4.711ms | 5.970% | No |
| SQLite SSE,0ms | −7.507ms | −0.564% | Yes |
| SQLite JSON,50ms | +4.677ms | 4.578% | Yes |
| SQLite SSE,50ms | +3.903ms | 1.811% | Yes |

Each database comparison retains all 16 processes and 9,600 requests, including
warmup, with zero response/accounting failures. All 4,800 candidate amounts and
16 exact balances per comparison are independently verified. Workload, concurrency,
ABBA order, durability and thresholds remain unchanged. PostgreSQL uses a fresh
private durable cluster, the previously documented startup-only compatibility
control, and read-only post-measurement accounting observation on both versions.
SQLite retains immediate SIGTERM. No slow repetition or near-threshold failure
is excluded, and shared-host variance is not asserted as an exclusive cause.

The same source separately completes the full 1000-model, 20-rule, 12-component,
10,000-quote workload. Pure-quote p50 is 0.059166ms, p95 0.066167ms and p99
0.322917ms. An independent decimal calculation reproduces the digest of all
10,000 output amounts. This verifies only pure pricing, not HTTP performance.

Complete regression passes 4,100 unit tests in 200 suites and 746 HTTP tests in
59 suites, without failures or skips, plus builds, frontend contracts/budgets,
lint, SDKs, configuration/docs and static deployment checks. Migration001–018
checksums are unchanged. The bounded read optimization is retained, **not declared
performance-complete**. All owned instances are stopped; production2099 and its
user-edited model configuration remain untouched. Final-source image/candidate
delivery and the original remaining Goal requirements are still incomplete.

## Composed receipt preflight

Composed settlement now inspects the stored attempt during application rather
than also preflighting it immediately before intent creation in the same
transaction. The provisional intent cannot commit without application. Proposal,
retained-evidence, ownership, audit and terminal-state validation remain; queue-only
callers keep their pre-commit receipt inspection. There is no validation cache
across transactions or earlier response/debit boundary. See the
[recovery contract](pricing-runtime-outcomes.md#composed-receipt-validation).

Sixteen new SQLite/PostgreSQL tests cover single application-stage inspection,
queue-only missing/foreign/terminal rejection and fresh detection of receipt
changes after provisional intent storage. Existing concurrent replay, audit
failure, actual child exits, lost commit acknowledgements and monetary rollback
remain covered. Four HTTP fault hooks were moved to the common storage helper;
their assertions were preserved exactly. The initial seven failures caused by
obsolete hooks are retained, not relabeled as a successful run.

A separate 500-request PostgreSQL profile records **131 to 128 SQL statements
per request**, with ten transactions, two independent outcome retentions and two
cost summaries unchanged. This reduction is not itself end-to-end acceptance.

| Database and scenario | Added p95 | Throughput reduction | Both targets met? |
| --- | ---: | ---: | --- |
| PostgreSQL JSON,0ms | −3.942ms | −2.281% | Yes |
| PostgreSQL SSE,0ms | −1.890ms | −0.796% | Yes |
| PostgreSQL JSON,50ms | +25.386ms | 25.375% | No |
| PostgreSQL SSE,50ms | +2.946ms | −6.306% | Yes |
| SQLite JSON,0ms | −6.327ms | −2.777% | Yes |
| SQLite SSE,0ms | −8.896ms | −7.157% | Yes |
| SQLite JSON,50ms | +5.420ms | 2.710% | No |
| SQLite SSE,50ms | +3.990ms | 1.290% | Yes |

Both comparisons preserve all 16 processes and 9,600 requests including warmup,
with zero response/accounting failures. All 4,800 candidate amounts and 16 exact
balances per database pass independent decimal checks. The original workload,
concurrency, balanced order, durability and thresholds are unchanged. PostgreSQL
uses a fresh private durable cluster, the explicit startup-only compatibility
control and read-only accounting observation after measurement on both versions.
SQLite retains immediate SIGTERM. No slow repetition is excluded; the SQLite
5.420ms result remains a failure despite being near the 5ms boundary. Shared-host
activity is not asserted as the exclusive cause of any failure.

Complete regression passes 4,126 unit tests in 201 suites and 750 HTTP tests in
60 suites, without failures or skips. Builds, frontend contracts/budgets, lint,
SDKs, configuration/docs and static deployment checks pass; migration001–018
checksums remain unchanged. The preceding pure-quote result is retained against
unchanged core source and compiled dependencies, not reported as a new measurement.

**Overall performance and final Goal delivery remain incomplete.** All owned
verification processes are stopped. Production2099 and the user's model edit
remain unchanged. No new browser, image, deployment or Git publication is claimed.

## Bounded joint acknowledgement reads

The joint receipt/settlement transaction now shares fresh same-reservation
ownership, body and audit reads. Up to128 attempt rows and the settlement row
are verified under one request lock; every exact retained body, ownership edge,
mandatory audit and quarantine state is checked before any acknowledgement write.
Audit inserts and state updates remain individual and transactionally coupled to
receipt and budget application. No validation crosses a commit boundary, and no
retention commit or money check is removed.

Twenty added cross-database cases verify query sharing, transaction and batch
bounds, distinct ownership, caller mutation, fresh revalidation of already
acknowledged rows, later-row damage and rollback after a later audit insert fails.
Existing independent replay races, process-exit rollback, quarantine and monetary
correction cases remain intact. Full regression passes **4,174 unit tests in203
suites and757 HTTP tests in62 suites**, with no failures or skips, plus builds,
lint, frontend contracts/budgets, SDKs and configuration/static deployment checks.
Migration001–018 checksums and all previous test assertions are unchanged.

A separate500-request PostgreSQL profile records **128 to123 SQL statements per
request**, with the same10transactions, two independent retentions and two
summaries. The reduction is one ownership discovery, one request-lock query,
one attempt-membership query, one net body read and one net audit read. Inclusive
profile durations are diagnostic, not the uninstrumented acceptance result.

| Database and scenario | Added p95 | Throughput reduction | Both targets met? |
| --- | ---: | ---: | --- |
| PostgreSQL JSON,0ms | -5.328ms | -4.026% | Yes |
| PostgreSQL SSE,0ms | -1.466ms | 0.869% | Yes |
| PostgreSQL JSON,50ms | +24.070ms | 20.908% | No |
| PostgreSQL SSE,50ms | -7.442ms | -10.466% | Yes |
| SQLite JSON,0ms | -4.818ms | -1.197% | Yes |
| SQLite SSE,0ms | -8.002ms | -4.829% | Yes |
| SQLite JSON,50ms | +4.319ms | 3.402% | Yes |
| SQLite SSE,50ms | +2.208ms | -0.097% | Yes |

Each native comparison retains all16processes and9,600requests, including warmup,
with no response/accounting errors. All4,800candidate amounts and16balances per
comparison pass independent exact-decimal checks. Runtime, data,500measured plus
100warmup requests, concurrency4,ABBAorder,durability and original thresholds are
unchanged. PostgreSQL uses a fresh durable private cluster and the explicitly
scoped startup-compatibility control plus read-only accounting observation after
measurement on both versions; SQLite keeps immediate SIGTERM.

The shared-host limitation remains; neither a slow repetition nor the failed
PostgreSQL case is discarded. Cross-checkpoint variation is not proof of a sole
cause. The change is retained for its verified read reduction and unchanged
correctness guarantees, **not** declared overall performance-complete. The earlier
pure-quote result is carried only by unchanged source/compiled core hashes, not
rerun or used to waive the HTTP failure. No production2099 write/restart, Docker
operation, Git publication or deployment occurred.

## Rejected atomic-budget-write experiment

An isolated experiment used bounded PostgreSQL data-modifying statements to write
selected compatibility counters and their exact balances together. Scope discovery,
ordered row locks, exact arithmetic, epoch handling and post-commit observations
were unchanged. Ten additional tests covered two-connection increments, foreign
and missing rows, legacy-null scope,251-rule chunking, and real database triggers
failing a later row or chunk. The complete experimental source passed4,184unit
and757HTTP tests, builds, frontend checks, SDKs and migration checksums.

A500-request profile reduced SQL from123 to117statements per request, with the
same10transactions, two independent outcome retentions and two summaries. The
balanced native PostgreSQL comparison nevertheless produced:

| Scenario | Added p95 | Throughput reduction | Both targets met? |
| --- | ---: | ---: | --- |
| JSON,0ms | -4.154ms | -4.940% | Yes |
| SSE,0ms | -1.848ms | 2.022% | Yes |
| JSON,50ms | +24.865ms | 25.340% | No |
| SSE,50ms | +6.204ms | -6.190% | No |

All16processes/9,600requests and all4,800candidate amounts/16balances passed
response and exact-accounting checks. Runtime,500measured plus100warmup requests,
concurrency4,ABBAorder,durability,control and thresholds were unchanged. Slow
repetitions remain in the result. Host variance is a limitation, not a proven
exclusive cause or a basis for waiving either failure.

Because the experiment did not establish the intended end-to-end gain, its full
source, compiled files, tests and raw evidence were archived, and the added path
was removed. This is not a claim that batching universally regresses performance.
The preceding bounded-acknowledgement implementation was restored by source
hashes rather than retaining extra code solely for a lower query count.

No SQLite comparison followed the failed PostgreSQL gate. The rejected candidate
must not be represented as a fully compared or deployable result. Current runtime
source returns to the earlier4,174-unit/757-HTTP checkpoint and its source-bound
native results: all four SQLite cases and three PostgreSQL cases passed, while
PostgreSQL JSON/50ms remained unmet. Fresh restoration checks are recorded in
[implementation progress](pricing-engine-progress.md); the rejected4,184test count
is not the current test inventory. Production2099 was never changed or restarted.

## Paired PostgreSQL critical-path profile

A new diagnostic uses the current failed-stream-fix source and the existing,
explicitly labelled startup-only compatibility control. Each actual compiled
gateway handles100warmup and500measured JSON requests against a50ms loopback mock,
at concurrency4, using a separate database in a fresh durable private PostgreSQL
cluster. The control runs first, then the candidate. All SQL spans and new-runner
connection acquisition are recorded; query parameters are not recorded.

The following are **instrumented means, not acceptance p95 values**:

| Per-request observation | Startup-only control | Candidate |
| --- | ---: | ---: |
| SQL statements | 36 | 123 |
| Before upstream headers begin | 11.411ms | 16.434ms |
| Waiting for upstream headers | 51.259ms | 51.191ms |
| After upstream headers until HTTP finish | 6.527ms | 23.724ms |
| SQL interval union in that last phase | 4.293ms | 21.166ms |
| Pool-acquisition interval union in that phase | 0.175ms | 0.034ms |

Intervals are clipped to their phases and overlapping SQL intervals are unioned.
Pool acquisition overlaps SQL and must not be added again. Nested service timings
also overlap. SQL elapsed includes network, server execution, locks and event-loop
scheduling; the profile does **not** isolate PostgreSQL CPU or actual row-lock wait.
The connection pool is not the dominant observed delay. The main measured gap is
the sequential database work after the supplier has returned its headers, not a
different mock delay or the pure in-memory price calculation.

All1,200requests succeed. The candidate's600receipts,600settlements and1,200retained
outcomes reconcile, and exact accounting checks pass. Both gateways exit0 after
read-only post-measurement accounting observation; the private cluster stops.
Production2099, its configuration and application/dependency/compiled source are
unchanged. No Docker operation is involved.

This pair is neither ABBA-balanced nor uninstrumented and cannot replace the
original failed performance gate. It rules out blind pool-size tuning as the next
step and explains why removing only a few round trips need not remove the full
gap. Further optimization must demonstrate a substantial reduction of the measured
post-upstream critical path, preserving independent durable receipt/settlement
retention, ownership/audit checks, exact budgets and crash replay. Early responses
with untracked accounting or accumulating hidden work are not a performance fix.
The original native comparison remains unaccepted; no threshold was waived.


## Critical-stage attribution of the retained profile

A further offline analysis assigns each SQL interval in the existing paired
500-request profile to its smallest containing major operation. It clips intervals
to upstream-headers through HTTP finish and checks for overlaps before summing.
This is **not a new live profile, benchmark or passing performance result**. The
five inspected orchestration files remain identical to that recorded profile.

| Candidate stage after upstream headers | SQL/request | Mean SQL interval union | Mean stage wall interval union |
| --- | ---: | ---: | ---: |
| Composed settlement application | 41 | 11.706ms | 13.001ms |
| Two independent evidence retentions | 22 | 5.841ms | 6.061ms |
| Call-log persistence | 9 | 2.507ms | 2.799ms |
| Route-decision record | 3 | 0.876ms | 1.123ms |
| Post-commit budget metric refresh | 1 | 0.235ms | 0.283ms |

The SQL totals reproduce the prior21.166ms post-header SQL union. The startup-only
control has18post-header statements totaling4.293ms. Service wall and SQL times
must not be added together: SQL is inside those service intervals. These remain
instrumented means, not acceptance p95 or an exclusive database CPU measurement.

The dominant targets are settlement application and independent retention, not
post-commit telemetry or the connection pool. Removing a handful of peripheral
queries is not demonstrated to close the measured gap. Any future restructuring
must preserve fresh receipt/ownership/audit checks, independent durable evidence,
atomic budgets and recoverable crashes. The new source-bound synchronous-flow
[audit](pricing-rule-flow-acceptance.md) confirms those are required guarantees,
not optional checks to discard for the latency target. No application optimization
or threshold waiver is claimed by this attribution.

## Bounded retention state reads

The [retention state change](pricing-retention-state.md) reads fresh ownership,
receipt membership, asynchronous indicators, one exact body and unique audit
markers together after the request fence. It preserves independent evidence
retention and all subsequent application/acknowledgement transaction boundaries.
Twenty-six added cases and the complete4,255-unit/807-HTTP regression pass without
skips; all18 migration checksums and dependency versions are unchanged.

A new paired instrumented PostgreSQL diagnostic compares the exact preceding
compiled runtime with this candidate. Each handles100warmup and500measured JSON
requests against a50ms loopback mock at concurrency4. Statements fall from123 to115
per request; the two retentions fall from22 to14 statements. Ten transactions and
two independent retention commits remain. Retention SQL interval union averages
4.936ms before and4.021ms after; total post-upstream-header wall time averages
21.885ms and20.019ms. Both600-request accounting checks pass.

This pair is instrumented and before/after, not ABBA-balanced. It does not isolate
database CPU, prove universal improvement, or replace the following uninstrumented
comparisons against the existing deployed-version comparator.

| Database and scenario | Added p95 | Throughput reduction | Both targets met? |
| --- | ---: | ---: | --- |
| PostgreSQL JSON,0ms | -0.317ms | 4.321% | Yes |
| PostgreSQL SSE,0ms | +1.230ms | 6.967% | No |
| PostgreSQL JSON,50ms | +21.840ms | 21.112% | No |
| PostgreSQL SSE,50ms | -5.866ms | -14.596% | Yes |
| SQLite JSON,0ms | -5.559ms | 1.670% | Yes |
| SQLite SSE,0ms | -4.903ms | -1.151% | Yes |
| SQLite JSON,50ms | +5.511ms | 4.153% | No |
| SQLite SSE,50ms | +3.470ms | 0.866% | Yes |

Each database comparison retains16processes and9,600requests including warmup,
with no response/accounting failures. All4,800candidate amounts and16exact balances
per database are independently checked. Runtime,500measured plus100warmup requests,
concurrency4,ABBAordering,durability and original5ms/5% thresholds are unchanged.
PostgreSQL retains the explicitly labelled startup-only compatibility control and
read-only post-measurement accounting observation on both versions; SQLite retains
immediate SIGTERM. No slow repetition is dropped, and5.511ms is not rounded into
a passing result. Shared-host variation is a limitation, not an exclusive cause.

The optimization is retained for its bounded reads and tested ownership/audit
hardening, not reported as a completed performance fix. The original target still
requires further work on the dominant settlement path. All owned processes stop;
production2099 and its user-edited model configuration remain unchanged. No Docker,
Git publication or deployment operation occurs in these checks.

## Bounded settlement receipt graph

The [joint acknowledgement change](pricing-settlement-receipt-graph.md) reads a
bounded expected-identity graph after its request fence. Exact stored bodies,
membership, audit markers and disposition presence are verified before any
acknowledgement write. A missing predecessor remains allowed for a direct intent,
but changed subjects or orphan markers cannot bypass retained-evidence checks.
Independent retention commits and all budget/application transaction boundaries
remain unchanged.

A paired instrumented actual-main PostgreSQL diagnostic records115 to110 SQL
statements per request, retaining ten transactions and two independent retentions.
Mean inclusive receipt-stage time decreases3.567ms to2.698ms. Total post-upstream
header wall time instead measures20.991ms before and21.753ms after. These values
are before/after diagnostic means, not balanced acceptance results or proof of
an exclusive cause. All1200 mock requests and exact accounting checks pass.

| Database and scenario | Added p95 | Throughput reduction | Both targets met? |
| --- | ---: | ---: | --- |
| PostgreSQL JSON,0ms | -3.951ms | -3.794% | Yes |
| PostgreSQL SSE,0ms | +0.101ms | 2.965% | Yes |
| PostgreSQL JSON,50ms | +19.976ms | 22.581% | No |
| PostgreSQL SSE,50ms | -0.194ms | -14.913% | Yes |
| SQLite JSON,0ms | +2.329ms | 12.537% | No |
| SQLite SSE,0ms | -4.356ms | -1.040% | Yes |
| SQLite JSON,50ms | +4.986ms | 4.090% | Yes |
| SQLite SSE,50ms | +3.936ms | 1.308% | Yes |

Each uninstrumented comparison retains16processes and9,600requests including
warmup, with no response/accounting errors. All4,800candidate costs and16exact
balances per database are independently verified. Runtime,500measured plus100warmup
requests,concurrency4,0/50ms mocks,ABBAorder,durability and5ms/5% thresholds are
unchanged. PostgreSQL retains the explicit startup-only compatibility control
and read-only post-measurement accounting observation on both versions. SQLite
retains immediate SIGTERM.

The first SQLite zero-delay JSON candidate repetition is slower than its second;
both remain in the pooled result. The usual SQLite request path does not use the
new joined-acknowledgement helper. Neither that fact nor shared-host variation
establishes an exclusive environmental explanation or excuses the failed target.
Earlier passing results are not substituted for this source's measurements.

Full regression passes4,281unit/205suites and807HTTP/65suites without failures or
skips, plus builds, lint, frontend contracts/budgets, SDKs and static deployment
checks. All earlier assertion names and18migration checksums are retained. The
read reduction and integrity checks are retained, **not** declared overall
performance-complete. All owned instances stop; production2099, its model
configuration and deployment are untouched.


## Owned attempt reads

The [owned dispatch/receipt change](pricing-owned-attempt-reads.md) captures caller
input before yielding and checks complete request/reservation/workspace ownership
in bounded receipt reads. Nineteen new assertions include reproduced association
and caller-mutation failures. The complete4,300-unit/807-HTTP regression passes;
old assertion names, dependency versions and18migration checksums are retained.

A paired PostgreSQL profile records110→105SQL statements per request with the
same ten transactions, two independent retentions and fourteen retention
statements. Post-upstream-header mean time instead changes21.531→22.183ms; query
reduction alone is not accepted as an overall speedup. All1200profile requests and
exact accounting checks pass. This before/candidate instrumented pair is separate
from the original uninstrumented balanced comparisons below.

| Database and scenario | Added p95 | Throughput reduction | Both targets met? |
| --- | ---: | ---: | --- |
| PostgreSQL JSON,0ms | -4.253ms | -8.634% | Yes |
| PostgreSQL SSE,0ms | +3.307ms | 3.338% | Yes |
| PostgreSQL JSON,50ms | +25.259ms | 24.982% | No |
| PostgreSQL SSE,50ms | -4.674ms | -11.573% | Yes |
| SQLite JSON,0ms | +0.674ms | 5.496% | No |
| SQLite SSE,0ms | -7.939ms | -2.111% | Yes |
| SQLite JSON,50ms | +5.205ms | 3.458% | No |
| SQLite SSE,50ms | +4.808ms | 1.654% | Yes |

Each database comparison retains sixteen processes and9,600 requests, including
warmup. All4,800 candidate amounts and sixteen exact balances per database pass
independent decimal checks, with zero response/accounting errors. The fixed
runtime,500 measured plus100warmup requests,concurrency4,ABBAorder,0/50ms mocks,
JSON/SSE cases and5ms/5% targets are unchanged. PostgreSQL uses the explicit
two-fix startup-compatibility control and read-only post-measurement accounting
observation on both versions; SQLite retains immediate SIGTERM. Neither method
uses production2099.

Three cases remain unmet, including SQLite's small delayed-JSON overrun and
zero-delay throughput miss. Threshold decisions use unrounded measurements, not
the rounded display above. Both SQLite zero-delay candidate repetitions are kept,
including the slower first tail. These results supersede the earlier source's
comparison; no passing earlier result or exclusive host-variance explanation is
substituted for a failure.

The same profile exposes eleven statements after the shared budget row-lock query
completes and before commit, including exact-balance reads, counter writes,
reservation/intent/recovery/log updates and the budget effect. The candidate's
client-observed interval averages3.260ms with p95 of4.709ms. The client interval includes commit-response time, so it is not a guaranteed
bound on server lock duration, exact server-exclusive lock time or a demonstrated
sole cause. Shorter ownership reads do not remove that shared critical section.

The implementation is retained for stronger ownership/capture correctness and
bounded multi-receipt work, **not** as completed HTTP performance acceptance.
Further transaction-path work, current platform checks and a final fixed-source
candidate remain required. All owned instances stop; production configuration,
release identity, listener and the user's model edit remain unchanged. There is
no Git publication, Docker action or deployment in this checkpoint.


## Settlement metadata phase

The [tentative completion phase](pricing-settlement-receipt-graph.md#tentative-completion-before-budget-mutation)
prepares request-owned records before acquiring shared budget rows. It preserves
fresh budget discovery/epochs, full receipt/history validation and the original
retention/application transaction boundaries. Real two-connection visibility,
database-trigger failure and process-exit checks accompany the change.

A paired PostgreSQL profile keeps105SQL statements, ten transactions, two
independent retentions and fourteen retention statements per request. Four owner
metadata statements move ahead of the budget writer. The client-observed interval
from the lock query's completion through COMMIT completion changes from eleven
statements to seven, with mean3.208→1.761ms and p95 of4.672→3.009ms. The interval
includes client scheduling and commit-response transport: it is neither a direct
server-lock measurement nor a guaranteed bound on the server lock lifetime.

Post-upstream-header mean time in that pair changes21.582→18.895ms. Both actual
runtimes complete all1200mock requests and exact accounting checks. These
instrumented before/candidate observations are not the original acceptance
comparison and do not establish a sole cause or a universal customer improvement.

| Database and scenario | Added p95 | Throughput reduction | Both targets met? |
| --- | ---: | ---: | --- |
| PostgreSQL JSON,0ms | -0.759ms | -1.938% | Yes |
| PostgreSQL SSE,0ms | -2.380ms | -0.110% | Yes |
| PostgreSQL JSON,50ms | +19.629ms | 21.341% | No |
| PostgreSQL SSE,50ms | -7.551ms | -15.348% | Yes |
| SQLite JSON,0ms | -4.679ms | 0.846% | Yes |
| SQLite SSE,0ms | -6.657ms | -1.111% | Yes |
| SQLite JSON,50ms | +4.974ms | 4.332% | Yes |
| SQLite SSE,50ms | +4.491ms | 1.244% | Yes |

Each original comparison retains sixteen processes and9,600requests including
warmup, with no response/accounting errors. All4,800candidate costs and sixteen
exact balances per database pass independent decimal checks. The runtime,
500measured plus100warmup requests,concurrency4,ABBAorder,0/50ms mocks,JSON/SSE
cases and5ms/5% thresholds are unchanged. PostgreSQL retains its explicit
two-fix startup-only compatibility control and read-only post-measurement
accounting observation on both versions. SQLite retains immediate SIGTERM.

All SQLite cases and three PostgreSQL cases pass for this recorded source and
host. The SQLite delayed-JSON margin is small; decisions use unrounded data and
all repetitions, not rounded table cells or an earlier faster sample.
PostgreSQL delayed JSON remains unmet at+19.628668ms p95 and21.341128% throughput
reduction. The improved diagnostic and other passing cases do not waive it.

The full source passes4,319unit tests in205suites and807HTTP tests in65suites,
without failures/skips and with every prior assertion retained. Dependencies and
18migration checksums remain unchanged; builds, lint, frontend/bundle checks,
SDKs and static deployment checks pass. All owned test instances stop, and
production2099/configuration/release identity remain unchanged. Overall
performance, current platform acceptance and final candidate delivery are still
open; there is no publication or deployment in this checkpoint.

## PostgreSQL inbox persistence phase

The [bounded inbox writes](pricing-retention-state.md#current-postgresql-persistence-phase)
retain full post-lock graph validation and both independent retention commits.
A normal request now uses97 SQL statements instead of105, still in ten
transactions. Each of its two retentions uses five statements rather than seven.
The acknowledgement group uses one checked update/marker statement instead of
separate row-by-row writes. SQLite's sequential write path is unchanged.

A paired actual-main PostgreSQL diagnostic uses100warmup plus500measured
requests per version, concurrency4 and50ms JSON mock responses:

| Instrumented mean | Previous phase | Inbox phase |
| --- | ---: | ---: |
| Post-upstream-header wall time | 19.008ms | 19.122ms |
| SQL interval union in that phase | 16.433ms | 16.450ms |
| Retention wall interval union | 4.092ms | 3.627ms |
| Statements per request | 105 | 97 |
| Statements across two retentions | 14 | 10 |

Fewer statements and shorter retention work do **not** establish a lower overall
latency here. This diagnostic is before/candidate, instrumented and not ABBA
acceptance. SQL elapsed includes scheduling, transport and lock waits; it is not
isolated database CPU or exact server lock duration.

Subsequent original balanced comparisons keep500measured plus100warmup requests,
concurrency4, ABBA ordering,0/50ms upstream delays, JSON/SSE, the same control and
5ms/5% thresholds. PostgreSQL retains the documented two-startup-fix control and
read-only post-measurement accounting observation. SQLite retains immediate
SIGTERM/accounting verification. All repetitions remain included.

| Database / scenario | Added p95 | Throughput loss | Both targets met? |
| --- | ---: | ---: | --- |
| PostgreSQL JSON0ms | −5.163542ms | −5.690486% | Yes |
| PostgreSQL SSE0ms | −2.509083ms | −2.277819% | Yes |
| PostgreSQL JSON50ms | **+16.924709ms** | **18.472475%** | **No** |
| PostgreSQL SSE50ms | −13.423417ms | −14.976556% | Yes |
| SQLite JSON0ms | −7.281333ms | −3.194723% | Yes |
| SQLite SSE0ms | −9.680251ms | −8.932273% | Yes |
| SQLite JSON50ms | +2.165751ms | 2.780086% | Yes |
| SQLite SSE50ms | +4.097167ms | 0.554134% | Yes |

Threshold decisions use unrounded values. Negative loss means higher throughput
in that comparison. Compared with the preceding checkpoint, delayed PostgreSQL
JSON has a smaller measured gap, but separate runs do not establish a sole cause.
It still fails both targets and is not waived. All19,200response/accounting
checks,9,600candidate exact amounts and32exact budget balances pass.

The current source passes4,336unit and807HTTP tests with all preceding assertion
names retained. The refreshed Rancher image also passes its authenticated
startup/recovery/drain fixture. Those checks do not replace PERF-02 or final
fixed-source delivery. No production configuration, process, database or caller
address was changed, and no Git publication or deployment occurred.

## Joined log settlement native checkpoint

This section describes the subsequently rejected candidate. Its failures remain
part of the record; the restored application is identified in the next section.

The [joined PostgreSQL logging path](pricing-log-projection.md#joined-postgresql-log-settlement)
inserts ordinary call/route logs inside their existing final settlement. Full
receipt/history validation and two independent outcome retentions remain.
Optional log writes use a savepoint before shared budget locks; they neither
return an HTTP response early nor bypass exact accounting.

A diagnostic pair, recorded before the subsequent optional-trace preparation
fix, reduced statements from 97 to 89 and outer transactions from ten to eight.
Both retentions still use ten statements in total. Post-header mean time changed
17.874814 to 17.663948ms, but overall p95 changed 95.451708 to 96.715875ms and
throughput 46.448048 to 45.552046 requests/second. This instrumented, non-ABBA pair
is **not an overall improvement or current-source acceptance result**.

The corrected full source passes 4,357 unit and 811 HTTP tests, with all preceding
assertions retained. Eleven actual-main PostgreSQL fault cases pass with exact
expenses across 14 provider calls, including concurrent ownership, lost commit
acknowledgement/restart, optional-log failures and in-flight shutdown. The first
private actual-expense fixture had an incorrect intent-count expectation; the
existing cohort implementation was verified and the fixture corrected, with
additional budget-basis assertions. That failure remains recorded.

Both original balanced comparisons were then run on that fixed source. They
retain 500 measured plus 100 warmup requests per process, concurrency four,
ABBA ordering, JSON/SSE, 0/50ms mock delays, durability and the 5ms/5% targets.
PostgreSQL uses the same documented two-startup-fix control and read-only
post-measurement accounting observation; SQLite retains immediate SIGTERM.

| Database / scenario | Added p95 | Throughput loss | Both targets met? |
| --- | ---: | ---: | --- |
| PostgreSQL JSON 0ms | −4.170375ms | −3.004629% | Yes |
| PostgreSQL SSE 0ms | +3.502584ms | **5.765017%** | **No** |
| PostgreSQL JSON 50ms | **+21.154792ms** | **21.020488%** | **No** |
| PostgreSQL SSE 50ms | −6.733916ms | −16.407306% | Yes |
| SQLite JSON 0ms | −3.372208ms | 3.496777% | Yes |
| SQLite SSE 0ms | −5.702875ms | −0.116698% | Yes |
| SQLite JSON 50ms | **+6.482417ms** | 3.131149% | **No** |
| SQLite SSE 50ms | **+5.536583ms** | 1.448025% | **No** |

All repetitions remain included; decisions use unrounded values. All 19,200
request/accounting checks, 9,600 candidate amounts and 32 exact balances pass.
Nevertheless, **four scenarios miss the original performance gate**. Fewer SQL
statements, successful fault tests and earlier passing runs do not override these
results. SQLite did not receive the joined transaction path; this observation
does not establish a sole cause for its timing changes or waive its failures.

This is a native checkpoint, not a refreshed Linux/Rancher image or final
candidate. The prior image predates the changed application source. Performance,
current-image certification and final fixed-source/aggregate delivery remain
open. All owned test instances stop; production 2099 and the user's model edit
remain unchanged. No code publication or deployment occurred.

## Joined-log experiment removal and restoration

The joined-log path was removed after its diagnostic and balanced comparisons
failed to demonstrate the intended overall gain. Reducing statements from 97 to
89 did not by itself justify additional transactional and fallback machinery.
The full experimental source, compiled output, dedicated tests and raw results
are archived; its failures are neither erased nor attributed to a proven external
cause. No pricing capability, durable retention boundary or target was waived.

Restoration changes exactly seven application/test files to their recorded
inbox-phase hashes. A fresh build reproduces all 1,473 compiled files exactly.
Fresh targeted regression passes 450 unit tests and 47 HTTP tests, plus build and
lint, using a new private PostgreSQL cluster with fsync, synchronous commits and
full-page writes enabled. All original test assertions remain. The experimental
tests removed with their experimental API are retained in the rejected archive.

The 4,336-unit/807-HTTP full regression and the inbox-phase native comparisons
apply by exact application/dependency/migration identity, **not a new full run or
benchmark**. That source had four passing SQLite cases and three passing
PostgreSQL cases; delayed PostgreSQL JSON remained unmet at +16.924709ms p95 and
18.472475% throughput loss. The rejected candidate's four failing scenarios remain
separately recorded above. Restoration is not a newly measured speedup.

The preceding authenticated Rancher image has the same application inputs and
its recorded identity is still present in Rancher Moby. Documentation differences
are explicit; prior image verification is carried forward only for its original
scope. No new image or runtime container is started. Current performance and
final fixed-source/bundle delivery remain open, so the Goal is active and not
deployment-ready. All owned restoration fixtures stop, while production 2099 and
the user's model configuration remain unchanged.

## Current-source pure-quote delivery check

The [implementation/quality delivery](pricing-implementation-delivery.md) found
that the earlier carried pure-quote record had stale catalog/compiler source
fingerprints. A fresh isolated run keeps the full 1,000-model/20-rule/12-component
workload, 1,000 warmups, 10,000 measurements and seed 20260928. Current p50/p95/p99
are 0.057916ms / 0.063083ms / 0.208292ms, with maximum 0.574208ms. All models are
visited, each quote has 12 lines, and an independent integer/decimal oracle matches
the complete amount digest. No network/listener or database is used.

This refresh is pure calculation evidence, not an unchanged HTTP rerun or a
performance waiver. The restored application's PostgreSQL JSON/50ms comparison
still fails at +16.924709ms p95 and 18.472475% throughput loss. The original
thresholds and both repetitions remain unchanged; no exception was accepted.

# Indexed activation availability

The request-admission check for **any active price in this workspace** now uses
an index instead of scanning every model binding in the catalog. This closes a
specific hot-path capacity gap; it does not mean the original HTTP latency and
throughput targets have passed.

## Semantics and ownership

Catalog compilation already parses each binding's absolute activation endpoints.
The candidate reuses those numbers to build separate interval unions for global
bindings and each workspace. Overlapping, nested and adjacent windows are merged
once. At request time, the admission instant is parsed once and binary-searched
against only the global and requested-workspace intervals.

Starts remain inclusive and ends exclusive. Gaps remain gaps, and an omitted end
remains unbounded. The global key is distinct from literal workspace names such
as `null`; one workspace's activation never enables another workspace by itself.
The index is private to the immutable compiled revision. Serialized documents,
content hashes, stored price versions and historical request descriptors do not
change. An older request keeps its original revision and activation result.

This check deliberately answers whether **any** applicable price is active. It
does not select a tariff for a requested model, node or operation. That separate
selector still uses the existing model-keyed binding index and original
precedence. An unrelated active model must not become the requested model's
price. Compatibility bypass, legacy fallback and explicit admission policies
retain their existing meanings.

## Verification

Ten new unit cases cover half-open boundaries, overlaps, nested/adjacent windows,
gaps, empty/unbounded catalogs, explicit offsets, workspace isolation, immutable
snapshots, defensive copies and independent seeded linear-predicate equivalence.
An expired 1000-model catalog previously reparsed 2000 stored endpoints plus the
query instant; the new path parses only the query instant. Structural checks
also prohibit access to the complete binding array and bound interval reads for
1000 disjoint windows, without timing-based unit-test assertions.

Four actual HTTP scenarios cover JSON/SSE and workspace/global prices, with six
mock-backed requests each. They exercise the exact start/end and gap boundaries,
ignore foreign-workspace prices, and retain legacy fallback when only another
model is active. Each flow keeps prior costs and catalog versions unchanged,
records three explicit compatibility bypasses and three priced-runtime
reservations, and reconciles 9000 logical budget tokens. No supplier is contacted.

A private ABBA diagnostic compares the previous catalog implementation with the
indexed implementation using the same 1000 bindings and 10,000 seeded availability
queries per run. All 40,000 results match an independent linear predicate. The
two baseline p95 values are approximately 1.137ms and 1.128ms; indexed p95 values
are approximately 0.000833ms and 0.000750ms. These numbers measure only the
availability predicate with a shared six-rate book—not the full pricing workload,
database writes, Gateway HTTP or Linux performance.

The original full-scale 1000-model ×20-rule ×12-component pure-quote benchmark
was separately repeated on the new source: 10,000 measured quotes after 1000
warmups, p95 0.062625ms and p99 0.199125ms. An independent decimal calculation
reproduces every output amount through the recorded digest.

Complete regression passes 4,110 unit tests in 201 suites and 750 HTTP tests in
60 suites, without failures or skips. Builds, frontend contracts/bundle budgets,
SDKs, config/docs and static deployment checks pass. Migration001–018 checksums
are unchanged. Initial synthetic-test errors are retained: a missing actor flag
and a global Date-constructor proxy that interfered with ORM date hydration.
The corrected fixture overrides only the pricing admission-clock seam; production
authentication and clocks were not changed.

## Acceptance boundary

The four PERF-01 clauses have source-bound evidence for an in-memory pricing
core, indexed selection/availability, configurable rule/body ceilings, and
paginated reports/bounded replay. This is distinct from PERF-02's measured
Gateway HTTP targets. The last native comparison still has two failed cases;
no new HTTP comparison or waiver is implied by this index diagnostic.

All owned test instances are stopped. Production2099 and the user-confirmed
model configuration remain unchanged. No image was published or deployed.
Remaining Goal and final-candidate requirements are tracked in
[implementation progress](pricing-engine-progress.md).

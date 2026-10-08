# Current Engineering Baseline

Reviewed: 2026-10-08
Release: **v2.11.7**

## Release Identity And Scope

This release promotes the reviewed pricing application (`591ebb99`) and the
customer installation/publication system. The annotated `v2.11.7` tag, exact
main CI run and image index/child digests identify the final release. A package
version by itself does not identify a deployed instance.

The preserved `v2.11.6` source tag points to `cff3cc9`, whose main CI passed
4,472 unit and 815 HTTP tests with zero skips, plus both native rehearsals.
Its tag workflow stopped before image builds: checkout flattened its local tag
ref, so the old local-object-type check rejected a valid remote annotated tag.
No v2.11.6 image or GitHub Release was published. The v2.11.7 successor validates
the remote annotated object in a disposable non-tag ref, preserving all version
tags and the exact-commit main CI gate. Twelve offline Git regressions cover this
path; the customer test suite now contains 37 cases. New run results, not the
v2.11.6 evidence alone, are required for this successor's publication.

The successor's first PR CI also exposed a remaining implicit 5-second timeout
in the actual-media sibling conflict-review contract. Media-budget and Realtime
ASR lifecycle contracts now consistently receive bounded 30-second case/fixture
budgets, including parameterized cases; all 36 case declarations and fixture
bodies are byte-identical. These multi-step database/recovery tests are not API
latency gates. No assertion, global Jest default or business performance target
was changed, and failed runs remain recorded rather than counted as passes.

Later HTTP runs exposed batch fixtures that assumed every request would arrive
within the 60ms window. Missing-usage mocks now use actual physical input sizes;
fixtures requiring one physical batch reuse a bounded admission barrier before
the real enqueue, including shared-client cancellation cases. The production
60ms window, 2-second deadline, grouping and monetary assertions are unchanged.
Two forced-split cases and a 120ms delayed-admission case cover both behaviors;
the complete 47-case batch suite passes locally. No gateway code changed.

- Pricing includes versioned rules, long-context/cache and time-window pricing,
  media quantities, frozen FX, exact settlement, durable recovery and cost evidence.
- Customer installations use an independently initialized database/configuration,
  a pinned image, private directories and explicit timezone. They do not import
  the maintainer's configuration, provider credentials or deployment bundle.
- Node 22 (`>=22.13.0 <23`) is enforced for gateway development/builds. CI and
  Docker share the contract; container-only customers do not need host Node.
- The transitive `proxy-addr` 2.0.8 security fix closes GHSA-jqcg-44mw-7w3h.
  Existing live images are not silently replaced by publishing this patch.
- The release leaves existing running gateways untouched. See the
  [customer runbook](customer-install.md) and [publication state gates](customer-release.md).

## Required Acceptance Evidence

The complete CI workflow now separates build/docs/audit, frontend, SDKs and eight
SQLite/PostgreSQL test shards (four unit, four E2E). The previous combined job
passed unit tests and continued passing HTTP suites until its 30-minute job
limit; cancellation was not a complete validation result.

Every shard retains normal Jest discovery and all original assertions. Schema
and subprocess integration contracts use explicit 30-second execution budgets:
the first PostgreSQL-enabled run hit six implicit 5-second defaults, and a later
run exposed one remaining rollback case. All 26 shared schema cases now have
the same bounded integration budget on SQLite and PostgreSQL, with byte-identical
test bodies; data assertions and application latency/throughput targets are
unchanged.
Its report carries the exact commit and full discovered suite list. A final
coverage gate requires all eight reports, exactly-once suite coverage, no skipped
or failed tests, and at least 4,472 unit / 818 HTTP tests (including three new
proxy-trust security regressions beyond the accepted 4,469-unit baseline and three
batch-timing HTTP cases beyond the predecessor's 815-test HTTP baseline).
The pricing and shared-budget PostgreSQL suites use an isolated per-job database
with normal durability, never a production URL.

Run results, not this document's presence, establish a pass. The tag publisher
requires a successful full main-push CI run for its exact commit and then native
AMD64 and ARM64 customer-install/image tests. The release summary records image
and installer identities. A manual branch CI or rehearsal is not permission to
skip merge/main CI, publish an image, or update a running service.

## Explicit Performance Exception

The fixed pricing candidate `591ebb99acd1f5b85b5bfe7b9a0ed1eaecda5d22` was accepted
on October 1, 2026 with one quantified exception: PostgreSQL JSON with a 50ms mock
upstream added **15.031749ms p95** and lost **15.532176% throughput**, against
original limits of 5ms and 5%. Seven of eight original scenarios met their targets.
The exception is not a measured pass, a new benchmark, or a general SLA promise.
This release's packaging/CI and bounded dependency-security changes do not claim
a new performance improvement or a fresh benchmark of the final release.

Earlier pricing documents are retained development checkpoints; their statements
about unfinished experiments or pending acceptance must be interpreted at that
checkpoint. They do not supersede this fixed-candidate acceptance and the actual
release's current CI/image evidence. Private raw data and machine-specific
handoffs must not become public Release attachments.

## Deployment Boundary

A source merge, a public image and a running instance are separate events.
Publishing v2.11.7 does not restart 2099, change provider routing or copy production
configuration into a customer installation. Record actual deployed commit/image,
backups, approval and post-switch health separately. Never start an older binary
against an upgraded database without verified compatibility and reconciliation.

## Historical v2.11.5 Baseline (Retained Evidence)

The section below is the previous release's record, not v2.11.7 test counts or
current deployment status.

Reviewed: 2026-09-20
Release: **v2.11.5**

This is the current engineering baseline for the open-source data plane. The
[July optimization plan](reports/optimization-plan-2026-07-14.md) is historical
execution evidence, not the current work queue.

## Source And Release Identity

- The annotated `v2.11.5` tag is the release source of truth. Compare full commit
  IDs, not just package versions: earlier deployment fixes shared v2.11.4.
- This release starts from main commit `8f12730c` (PR #130), retaining native
  Messages server tools, citations, signed thinking history, tool intent, and
  usage metadata.
- Previously deployed transport-cause diagnostics and configurable per-model
  circuit breakers are now part of the maintained source and regression tests.
- Default breaker behavior is unchanged: enabled, three consecutive failures,
  30-second cooldown, and one configured half-open probe slot. Existing local
  configuration is not rewritten by the release.
- The macOS 2099 watchdog helper is tracked. It is not installed, started, or
  invoked by builds or release checks; deployments must review its launchd
  label and local paths before adopting it.

## Repeatable Quality Gates

Local verification on 2026-09-20 completed the 17-step release-hardening gate:

| Check | Result |
| --- | --- |
| Backend/SDK unit discovery | 114 suites, 1,669 tests passed; one optional PostgreSQL suite/test skipped |
| Backend E2E | 13 suites, 115 tests passed |
| Dedicated TypeScript SDK | 2 suites, 6 tests passed; build and typecheck passed |
| Python SDK | 7 tests passed |
| Backend/runtime-plugin build, lint, config, Kubernetes, registry | Passed |
| Docs, public-boundary scan, version sync | Passed |
| Frontend static checks, build, bundle budgets | Passed |
| Production dependency audit | Passed the configured critical-severity gate; lower-severity advisories remain |

Cloud CI results belong to the release commit's GitHub checks. Runtime health
and deployment evidence must be recorded separately after the planned restart.

Run `npm run release:hardening` from the repository root. It includes backend
build/unit/E2E checks, configuration and Kubernetes validation, zero-warning
lint, documentation/public-boundary/version checks, provider registry checks,
SDK checks, dependency auditing, and frontend checks/build/bundle budgets.

Jest now has explicit discovery roots:

| Command | Maintained test scope |
| --- | --- |
| `npm test -- --runInBand` | `src`, `test` (excluding E2E), and `packages/client` |
| `npm run test:e2e` | `test/e2e` only |
| `npm run test:sdk` | TypeScript client tests only |

Generated worktrees under `output` and caches under `.local-dev` are not test
roots. Regression tests exercise real Jest discovery against both types of
artifacts, including duplicate package names. Frontend `npm test` consists of
static source/i18n/contract checks; it is not a browser-rendering or interaction
test suite.

Real PostgreSQL row-lock coverage is conditional locally. The separate
Postgres Budget Smoke CI workflow provisions an isolated service database.
Docker smoke is likewise a separate CI gate. Do not report skipped local
integration checks as passed.

The dependency audit gate retains the existing `--audit-level=critical`
threshold. Passing it does not mean there are no lower-severity advisories;
dependency upgrades require separate review and are not bundled into this
source/runtime alignment release.

## Runtime Alignment Without An Early Restart

A checkout, a published tag, and a running process are distinct identities.
The process command and active release manifest identify what is actually
serving requests; a repository-local `dist` directory does not establish that.

1. Record the active PID, resolved release directory, config checksum, and
   release-manifest checksums. Keep machine paths and configuration private.
2. Preserve local changes before synchronizing source. Review deployed patches
   against the release branch rather than overwriting them with an older build.
3. Build and validate in an isolated worktree. Do not run dependency installs
   or replace frontend assets through links used by the live process.
4. Merge passing changes, publish the annotated tag and GitHub release, and
   prepare an immutable candidate with commit/version and file checksums.
5. Leave the active runtime untouched until the scheduled restart. Verify
   in-flight work, preserve a rollback release, then switch and restart once.
6. Verify the new PID, readiness, release checksums, and unchanged config.
   Record the deployed release separately from the GitHub release.

Never store provider credentials, Gateway keys, request/response bodies, or
resolved secrets in public provenance or release notes.

## Evidence Limits And Next Optimization Work

- The committed v2.0.0 performance report uses one measured request per
  scenario. It is historical harness smoke evidence, not a statistically
  useful p95/p99 or current-version capacity baseline. No new latency,
  throughput, or SLA claim is made by v2.11.5.
- Before performance optimization, capture repeated warm runs with sufficient
  samples, fixed concurrency, hardware, config, commit, and upstream behavior.
  Separate gateway overhead from upstream latency and first non-empty content
  from the first SSE byte. See [Performance](PERFORMANCE.md).
- A healthy HTTP endpoint establishes only the checks it actually performs.
  If circuit breaking and active probes are disabled, it does not demonstrate
  that every upstream can currently complete model requests.
- Continue with protocol/stream/tool/usage regression coverage and measured
  bottlenecks rather than reopening completed July work or adding features
  without a reproducible baseline.

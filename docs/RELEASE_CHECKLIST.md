# SiftGate Release Checklist

Use this checklist for every open-source data-plane release. It is intentionally
manual and non-destructive: scripts may verify release readiness, but they must
not push branches, merge PRs, move tags, or create GitHub releases without an
explicit maintainer action.

First determine S0/S1/S2/S3 from the [release-state gate](customer-release.md)
([中文](customer-release.zh-cn.md)). A feature-branch runbook does not establish
that main contains the system. Merge this checklist update together with the
customer workflows, kit, Node constraints and tests; do not retain the old manual
public-Release instructions beside a newly merged automatic publisher.

## Branch And Scope

- Start from the latest `main`.
- Create one branch per release, for example:
  - `codex/v1.9.1-v2-roadmap-baseline`
  - `codex/v2.0.0-alpha.1-workspace-core`
  - `codex/v2.1.0-coding-agent-gateway`
- Keep one version goal per branch.
- Do not mix unrelated local changes into the release branch.
- Do not edit the cloud or enterprise app for OSS data-plane releases.

## Version Sync Files

For a normal release, confirm the version is aligned in every applicable file:

- `package.json`
- `package-lock.json`
- `frontend/package.json`
- `frontend/package-lock.json`
- `packages/client/package.json`
- `packages/python/pyproject.toml`
- `deploy/helm/siftgate/Chart.yaml`
- `deploy/kubernetes/base/deployment.yaml`
- `src/openapi/setup-openapi.ts`
- `test/unit/release-version-sync.spec.ts`
- `README.md`
- `CHANGELOG.md`
- `docs/BASELINE.md`

Additional release docs may also mention the new version when the release
changes those surfaces.

Run:

```bash
npm run release:check
```

The check must be read-only. It should fail if version metadata is misaligned.

## Required CI Signals

Gateway CI selects Node 22 from `.nvmrc`; root/frontend manifests and lockfiles
require `>=22.13.0 <23`, enforced at installation by `.npmrc`. Run
`npm run runtime:check` and `npm run test:runtime` before release preparation.
These select a supported release line, not an exact base-image digest.

Every pull request should get non-Docker CI signal from `.github/workflows/ci.yml`:

- backend docs, build, unit tests, e2e tests, config validation, Kubernetes
  validation, release metadata, provider registry, and production dependency
  audit
- frontend checks and build
- TypeScript SDK build, tests, typecheck, and Python SDK tests

Customer tooling tests include offline Git fixtures for remote annotated-tag
validation, including checkout's commit-to-local-tag refspec. The publisher must
verify the remote tag object, not assume the runner's local tag remains annotated.
When a pushed tag contains a workflow defect, preserve it and release a verified
successor; rerunning the old tag does not pick up a workflow fix made on main.

Docker smoke remains a separate workflow because it depends on a working Docker
daemon and is useful as a container-path complement, not the only quality gate.

## Public Repository Boundary

Run the public release guard before opening the repository or cutting a
release:

```bash
npm run public:check
```

This check verifies required community files, package publication metadata,
critical ignore rules, tracked-file boundaries, and common literal secret
patterns across non-test tracked text files. It is intentionally read-only and
should fail if local runtime config, build output, dependency folders, private
workspace folders, `.DS_Store`, or other local-only artifacts are accidentally
tracked.

## Required Tests

Choose the full set that matches the release scope. For v2 platform releases,
prefer the broadest reasonable gate.

Dry-run the repeatable release hardening command before starting a long local
run:

```bash
npm run release:hardening -- --dry-run
```

Then run the standard gate:

```bash
npm run release:hardening
```

This gate does **not** include `test:customer` or `smoke:customer`. Run the customer
unit suite separately (`npm run test:customer`) and the real customer installer
smoke against a specific built image (`npm run smoke:customer -- --image IMAGE`).
The optional `--include-docker` below adds the legacy `smoke:docker`, not the
customer-kit smoke; these are distinct paths and neither is a universal migration test.

Optional when Docker is available:

```bash
npm run release:hardening -- --include-docker
```

Optional when a safe isolated PostgreSQL database is available:

```bash
SIFTGATE_TEST_POSTGRES_URL="$DATABASE_URL" \
npm run release:hardening -- --include-postgres
```

For docs-only releases, the minimum is:

```bash
npm run docs:check
npm run build
```

## Production Hardening Gates

For releases that touch auth, provider streaming, budgets, frontend loading, or
release tooling, confirm the relevant hardening gates before merge:

- Dashboard auth stays fail-closed:
  - `/api/auth/status` failures keep protected routes blocked.
  - `dashboard.auth_required=false` is ignored in production unless
    `SIFTGATE_ALLOW_UNAUTHENTICATED_DASHBOARD=true` is explicitly set.
  - Cookie-backed Dashboard sessions survive reload without requiring
    `localStorage`.
  - OIDC callbacks do not return Dashboard JWTs in URL hashes.
  - Browser SSE paths authenticate with the HttpOnly session cookie first; any
    legacy `?token=` fallback emits only a token-free deprecation warning.
  - `dashboard.allow_legacy_token_auth=false` rejects both legacy bearer tokens
    and legacy SSE query tokens when the deployment is ready for cookie-only
    Dashboard auth. Before flipping it, follow the
    [legacy token burn-down runbook](SECURITY.md#legacy-dashboard-token-burn-down)
    and verify `siftgate_dashboard_legacy_token_events_total` has no
    `legacy_bearer_used` or `legacy_query_used` events for the deployment's
    normal Dashboard traffic pattern.
- Provider stream lifecycle remains bounded:
  - header/connect timeout behavior still falls back correctly,
  - idle stream body timeout emits a timeout error,
  - `connection.stream_max_duration_ms` caps total stream wall-clock duration,
  - downstream client cancellation aborts upstream provider fetches.
- Budget and cost controls remain conservative:
  - `BudgetService.reserve()` rejects concurrent reservations that would exceed
    a shared rule,
  - failed scoped reservations do not partially consume global budget,
  - reservation `commit()` and `release()` keep counters consistent.
  - strict multi-instance budget enforcement uses one shared PostgreSQL
    metadata database for all gateway instances; Redis shared state does not
    make budget counters atomic.
- Frontend and tooling gates keep their ratchets:
  - `npm run lint` fails on any warning,
  - `cd frontend && npm run build` runs the bundle budget check,
  - Dashboard string changes still pass the seven-locale check.

Suggested targeted checks when these areas change:

```bash
npm test -- --runInBand test/unit/auth-controller.spec.ts test/unit/dashboard-guard.spec.ts test/unit/oidc-service.spec.ts
npm test -- --runInBand test/unit/provider-client.spec.ts
npm test -- --runInBand test/unit/budget*.spec.ts
cd frontend && npm test && npm run build
```

## Budget Backend Decision Gate

Before claiming strict shared-budget enforcement in a release or deployment,
identify the authoritative budget backend:

- PostgreSQL shared by every gateway instance is sufficient and preferred. It
  stores the budget ledger and supports transaction-scoped row locks for
  reservation, commit, release, and record mutations.
- SQLite and in-memory repositories are acceptable for local development,
  tests, and one-process deployments. They are not a multi-instance budget
  coordination mechanism.
- Redis shared state does not currently store budget counters. It may be used
  for rate limits, circuit breaker state, affinity, prompt cache, concurrency
  summaries, health probes, or realtime session metadata, but it is not a
  replacement for the PostgreSQL budget ledger.
- A Redis atomic budget reservation backend is only required if a supported
  deployment target must enforce strict shared budgets across multiple gateway
  instances without using PostgreSQL as the shared metadata database.

For budget reservation, transaction, or backend decision changes, run:

```bash
npm test -- --runInBand test/unit/budget*.spec.ts
```

When PostgreSQL is the release target and a safe isolated database is
available, also run the optional row-lock smoke:

```bash
SIFTGATE_TEST_POSTGRES_URL="$DATABASE_URL" \
SIFTGATE_RUN_DATABASE_URL_INTEGRATION_TESTS=true \
npm run test:postgres-budget-smoke
```

For CI evidence, run the `Postgres Budget Smoke` GitHub Actions workflow
manually. It provisions a PostgreSQL service container and runs the same script
against an isolated test database.

## Seven-Locale Check

When Dashboard user-facing copy changes, update all existing locale folders:

- `frontend/src/locales/en`
- `frontend/src/locales/zh`
- `frontend/src/locales/zh-TW`
- `frontend/src/locales/ja`
- `frontend/src/locales/ko`
- `frontend/src/locales/th`
- `frontend/src/locales/es`

Then run:

```bash
cd frontend && npm test && npm run build
```

If no Dashboard strings changed, state that no locale files were changed in the
release notes or final implementation summary.

## Database Migration Review

When a release changes persistent entities, schema patch services, or database
configuration:

- Confirm production PostgreSQL guidance keeps `database.synchronize=false`.
- Document the migration or bootstrap command, dry-run evidence, and rollback
  path in the PR and release notes.
- Take or verify a database backup before running mutating schema steps.
- Apply migrations once per environment before rolling multiple gateway
  instances.
- Treat startup schema patch services as compatibility windows; verify them in
  staging and watch startup logs for `Applied schema patch:` entries.
- For budget reservation or transaction changes, run the optional PostgreSQL
  row-lock smoke with `SIFTGATE_TEST_POSTGRES_URL` pointing at an isolated test
  database. The test creates and drops a unique schema; set
  `SIFTGATE_RUN_DATABASE_URL_INTEGRATION_TESTS=true` only when `DATABASE_URL` is
  safe to use for integration tests. The repeatable command is
  `npm run test:postgres-budget-smoke`; maintainers can also trigger the
  `Postgres Budget Smoke` workflow for service-container evidence.

## Documentation And Privacy Review

- Update `CHANGELOG.md` under the exact release version.
- Update `README.md` release/current-focus copy when the release changes
  public positioning.
- Update topic docs for changed behavior.
- Re-check privacy boundaries:
  - no prompts or responses by default
  - no raw provider headers
  - no provider API keys or resolved secrets
  - no tool payloads, media bytes, or hidden reasoning text by default

Run:

```bash
npm run docs:check
```

## PR, Merge, Tag, And Release

For official GHCR images and customer installer assets, follow the executable
[formal image release runbook](customer-release.md)
([中文完整版](customer-release.zh-cn.md)). It includes initial package permissions,
exact-commit main CI, dual-architecture acceptance, immutable version aliases,
draft-to-public asset publication and failure recovery.

Publishing source is separate from deploying it. Follow the
[runtime alignment procedure](BASELINE.md#runtime-alignment-without-an-early-restart)
when a live gateway must keep serving during release preparation. Build in an
isolated directory, preserve deployed patches, and do not replace shared
dependencies/frontend assets or switch the active release before the scheduled
restart. Record both the published tag and the actually deployed commit.

After tests pass:

```bash
git status --short
git push -u origin <branch>
```

Open a PR against `main`. The PR description should include:

- release version
- scope summary
- tests run
- localization status
- migration or rollback notes
- known limitations

After review:

```bash
git checkout main
git pull --ff-only origin main
git tag -a vX.Y.Z -m "Release vX.Y.Z"
git push origin vX.Y.Z
```

With the customer release workflow installed on `main`, the approved annotated
tag push publishes the tested images and installer. Do not create a competing
empty public Release while it runs: the workflow stages a Draft and verifies
assets before publishing. Manual workflow dispatch is test-only, including a
dispatch that selects a tag. Keep the following content in the release notes:

- concise highlights
- upgrade notes
- test evidence
- known limitations
- prerelease flag for alpha, beta, and rc tags

Never force-push or rewrite a published tag. If a release regression blocks
existing v1.9 behavior, ship a forward hotfix before continuing the roadmap.

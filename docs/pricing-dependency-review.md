# Candidate dependency security review

Review date: **2026-09-28**. This is an isolated candidate update, not a production
upgrade or authorization to restart the Gateway. The Node runtime and existing
production dependency directory are untouched.

## Scope and observed audit results

The original backend production lock reported36known advisory findings:
9high,26moderate and1low. A first targeted update removed those original vulnerable
paths, but review also found remaining development-tool findings and a separate
frontend dependency tree. Both trees were checked rather than assuming the backend
production audit covered the Dashboard build.

After the final targeted changes and installation, `npm audit --json` reported
**zero findings in both the backend and frontend dependency trees**, including their
development dependencies. The backend production-only audit also reported zero.
These are dated npm advisory-database results for the recorded lockfiles, **not a
claim that the application or dependencies have no unknown vulnerabilities**.
Raw audit outputs, package metadata, dependency differences and integrity hashes
are retained with the private verification evidence.

## Selected versions and compatibility boundaries

| Component | Candidate version | Boundary |
| --- | --- | --- |
| Nest common/core/platform-express/testing | 11.2.6 | Remains on Nest11; no Nest12 migration |
| Nest Swagger | 11.4.7 | Removes its older nested YAML dependency path |
| OpenTelemetry experimental packages | 0.222.0 | Updated as one compatible SDK/exporter/instrumentation set |
| OpenTelemetry stable SDK packages | 2.11.0 | Matches the experimental package dependency graph |
| Root js-yaml | 4.3.2 | Existing Gateway YAML configuration remains on4.x |
| Undici | 6.29.0 | Remains on6.x; Pool and Realtime use verified installed APIs |
| TypeORM | 0.3.31 | Remains on0.3.x; explicit pricing migration definitions unchanged |
| React Router / DOM | 7.18.4 | Remains on7.x; navigation and unsaved-edit protection rechecked |
| Vite | 6.4.3 | Remains on6.x; no production2099proxy or dev server started |

Multer, gRPC, protobuf, brace expansion, body parsing, query serialization and
build-tool transitive versions were resolved within the applicable dependency
ranges and audited. The obsolete override that forced protobufjs8under the old
OpenTelemetry transformer was removed: the new transformer no longer depends on
that package, while the gRPC loader resolves its supported7.6.6line. This is not
an application pricing/protocol change.

React, ReactDOM, the backend/frontend TypeScript versions and better-sqlite3
11.10.0were not upgraded. SQLite was rebuilt from source for the fixed host
Node22.23.2/ABI127, producing SQLite3.49.2. The old task-owned dependency directory
and manifests were retained privately for comparison, not overwritten as if they
represented the new candidate.

## Evidence used to choose fixes

Selected registry metadata and maintainer advisories were inspected before applying
the proposed lockfiles. Examples include:

- [Undici fragment-count protection](https://github.com/nodejs/undici/security/advisories/GHSA-vxpw-j846-p89q).
- [YAML empty-merge work accounting](https://github.com/nodeca/js-yaml/security/advisories/GHSA-2883-xcg3-v3hh).
- [Jaeger malformed trace/baggage headers](https://github.com/open-telemetry/opentelemetry-js/security/advisories/GHSA-45rx-2jwx-cxfr).
- [gRPC malformed compressed-message handling](https://github.com/grpc/grpc-node/security/advisories/GHSA-99f4-grh7-6pcq).
- [Multer crafted field-name handling](https://github.com/expressjs/multer/security/advisories/GHSA-wc9g-mqfw-jrwm).
- [Brace expansion intermediate allocation bounds](https://github.com/juliangruber/brace-expansion/security/advisories/GHSA-rgw5-rvv9-x895).
- [Protobuf Any conversion depth](https://github.com/protobufjs/protobuf.js/security/advisories/GHSA-wcpc-wj8m-hjx6).
- [HTTP body-limit validation](https://github.com/expressjs/body-parser/security/advisories/GHSA-v422-hmwv-36x6).
- [Query serialization constructor handling](https://github.com/ljharb/qs/security/advisories/GHSA-4mjr-xmp4-gh2g).
- [TypeORM generated migration escaping](https://github.com/typeorm/typeorm/security/advisories/GHSA-2rp8-mm9q-fp49).
- [Router external-navigation handling](https://github.com/remix-run/react-router/security/advisories/GHSA-wrjc-x8rr-h8h6).

Installed-package presence alone was not treated as exploit proof. For example,
Jaeger propagation requires an applicable telemetry configuration; ordinary media
ingress uses raw-body handling rather than the inspected Multer interceptor path.
Those distinctions do not excuse leaving affected packages in the candidate.
The bounded regressions do not execute large denial-of-service examples.

## Verification and installation method

Proposed lockfiles were first resolved and audited in private temporary directories.
No blanket `npm audit fix --force` or unrelated framework-major migration was used.
Installation disabled general lifecycle scripts; only the reviewed native SQLite
build ran separately, at low priority with a single build job. Local package
manifests, registry integrity data and lockfiles identify the result. Deprecation
warnings from existing tooling are retained; zero audit findings does not mean
all upstream packages are actively maintained.

The new bounded security regressions exercise real installed modules:

- ordinary YAML merge compatibility and empty-map work-budget enforcement;
- malformed Jaeger headers without an exception, plus valid context extraction;
- invalid HTTP size configuration refusing silent unlimited parsing;
- query serialization with noncallable constructor metadata;
- five empty WebSocket fragments against an explicit four-fragment limit on a
  private loopback server—only ten frame bytes, not a load/OOM test.

Targeted runtime/telemetry/drain/pooling tests pass. The real telemetry SDK was also
exercised through actual compiled-main JSON/SSE requests against local mocks and a
local trace collector, verifying exact receipts, budget/log persistence and orderly
shutdown. Real-browser navigation verifies keeping or discarding an unsaved price
edit, reaching the report, returning via browser history and restoring the stored
price; no supplier calls or pricing/budget writes occur. A narrow dark layout is
also checked. Full-suite status is recorded in [progress](pricing-engine-progress.md).

## What this does not certify

- It is not a final Linux/Rancher image audit. The previously built image has the
  earlier source and dependency graph and must be rebuilt from the final candidate.
- The fixed baseline/control in the HTTP comparison retain their original deployed
  dependencies. A new comparison therefore measures the full candidate versus the
  baseline, not a pricing-only change with identical libraries. Both lock hashes
  must remain explicit in the evidence.
- It does not waive the still-unmet HTTP performance targets, complete the full
  requirement audit, approve fees, or authorize deployment/GitHub publication.

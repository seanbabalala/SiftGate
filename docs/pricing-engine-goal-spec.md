# Unified pricing engine: public specification

This is the public product contract. Personal deployment approvals, internal
reference snapshots and raw engineering evidence are not customer documentation.
See [the current baseline](BASELINE.md) for release scope and measured limitations.

## Functional scope

- Versioned price books, drafts, validation, previews and controlled activation.
- Explicit token/context tiers and cache dimensions; no universal model-name surcharge.
- Time-window calendars with IANA zones, stable currency/FX snapshots and precise money arithmetic.
- Media quantities with explicit units and provenance rather than invented usage.
- Durable attempt attribution, settlement, corrections, recovery and budget effects.
- Seven-language configuration and inspectable cost evidence.

## Safety and acceptance

Preserve existing API paths, keys, ownership and historical accounting. Missing
usage, unpriced usage and explicitly free requests remain distinguishable.
Duplicate events must not charge twice. Later evidence creates a linked adjustment
rather than overwriting an earlier receipt. SQLite and PostgreSQL require their
own correctness, durability and concurrency evidence.

No source update or specification authorizes a running installation to restart.
Changes require a verified release, supported upgrade source, approved maintenance
window and a tested recovery path. Performance exceptions must remain explicit;
a passing quote test does not replace end-to-end request benchmarks.

## Detailed contracts

- [Architecture decisions](pricing-engine-decisions.md)
- [Calculation policy](pricing-calculation-policy.md)
- [Reference-use boundary](pricing-reference-boundary.md)
- [Compatibility acceptance](pricing-compatibility-acceptance.md)
- [Performance evidence](pricing-performance.md)
- [Deployment procedure](pricing-deployment-handoff.md)

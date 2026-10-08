# Pricing-management capacity limits

These optional host settings bound new price publication and pricing-management
JSON actions. They do not activate the pricing engine, change supplier rates,
alter budgets, or authorize a production configuration reload.

```yaml
pricing_limits:
  max_published_rules: 20000
  max_request_body_bytes: 1048576
  max_replay_rows: 4096
  max_replay_source_bytes: 67108864
  max_replay_result_bytes: 8388608
  max_replay_work: 250000
  max_replay_ms: 2000
```

| Setting | Default | Allowed range | Meaning |
| --- | ---: | ---: | --- |
| `max_published_rules` | 20000 | 1–100000 | Total rules across distinct current/scheduled price versions in the proposed catalog |
| `max_request_body_bytes` | 1048576 | 1024–1048576 | UTF-8 bytes of the parsed JSON body for guarded pricing-management actions |
| `max_replay_rows` | 4096 | 1–20000 | Cumulative selected historical rows per replay, counting repeat reads |
| `max_replay_source_bytes` | 67108864 | 1–134217728 | Selected field UTF-8 bytes plus a 64-byte metadata allowance per field per read |
| `max_replay_result_bytes` | 8388608 | 1–16777216 | Bytes of the complete replay JSON response, including repeated evidence |
| `max_replay_work` | 250000 | 1–2000000 | Conservative compilation, calculation and JSON-traversal work units |
| `max_replay_ms` | 2000 | 1–30000 | Cooperative elapsed-time budget in milliseconds, including database queue/read time |

Use integer YAML values, not numeric strings. Zero does not disable a limit.
Unknown settings and invalid values fail CLI validation, startup and reload.
A failed reload retains the prior valid configuration. Capacity changes appear
in the existing `pricing_changed` change summary.

These are host-configured ceilings, not a distributed quota registry. All writers
sharing one catalog must use a consistent policy; changing one host's YAML does
not atomically update another host's limits. Catalog revision locking still
serializes publications, but does not synchronize host configuration.

## Publication semantics

- The rule ceiling is host-wide across the shared catalog, not an independent
  budget or quota per customer. A version referenced by multiple bindings is
  counted once. Current and future scheduled versions both count.
- Expanded inherited price content is counted, not just the inheritance recipe.
  The existing schema limits on books, bindings, groups, rules and components
  continue to apply independently.
- Drafts may be prepared without activating them. Publication preview, publication
  and price rollback check the proposed compacted catalog. The check is repeated
  at publication storage, under the existing catalog revision transaction.
- Oversized proposals fail with HTTP400 and `pricing_capacity_exceeded`. A failed
  publication leaves the prior catalog, immutable versions, draft and audit state
  unchanged. The error does not reveal another workspace's resource identities
  or aggregate counts.
- Lowering the ceiling does not invalidate a stored catalog, interrupt new requests
  using already-active prices, change in-flight snapshots or remove history.
  New price publications must fit. Metadata-only admission/FX updates and future
  activation cancellation remain available, including operations that reduce a
  catalog which is already above a newly lowered ceiling.

These limits do not certify that every document near the maximum fits every
machine. Size the host, maintain independent backups, and retain the separate
performance/capacity evidence required by the [Goal](pricing-engine-goal-spec.md).

## Request-body semantics

The existing pricing JSON/origin guard applies the size check before controller
parsing, compilation, simulation or publication. It covers single/batch quotes,
calendar/admission/inheritance previews, imports and other guarded pricing
management actions. An oversized body returns HTTP413 with
`pricing_request_too_large`; it does not invoke a supplier or charge a budget.

The metric is `Buffer.byteLength(JSON.stringify(parsedBody), 'utf8')`, not JavaScript
character count or the HTTP Content-Length header. Whitespace removed by JSON
parsing is not counted. The normal `server.body_limit` remains the independent
transport/parser limit; this policy does not replace it, raise it, or claim to
limit compressed wire bytes before JSON parsing. Native model ingress and
supplier callback endpoints retain their own existing limits.

## Historical replay semantics

`POST /api/dashboard/pricing/replay` continues to accept at most 30 request IDs.
That count alone does not bound their historical evidence. The five replay limits
above are additional, independent ceilings; a small selection can still exceed
them. One replay executes per gateway instance, not per workspace. Another replay
gets HTTP429 with `pricing_replay_busy`, rather than joining an unbounded queue.
This is not a cluster-wide semaphore; ordinary model calls do not acquire the
replay slot. Replay still uses database resources, and SQLite reads can delay
ordinary database work while holding its shared connection fence.

Each replay reads price content and historical summaries from one owned snapshot.
Selected row counts and field lengths are checked with a bounded metadata query
before values are hydrated. Only the inspected columns are then selected. Source
bytes include text representations of non-text fields and the 64-byte allowance;
they are not a measurement of total process memory, database scan I/O or wire
traffic. Catalogs loaded only for the replay use a private memo released with the
read scope, rather than filling the process-wide cache. These wrappers are not
installed on ordinary gateway database managers.

PostgreSQL uses a read-only repeatable-read transaction and transaction-local
statement timeouts based on the remaining budget. SQLite retains its shared
connection serialization fence, caps each scoped busy timeout to both its prior
value and the remaining budget, and restores the prior timeout on exit.
Monotonic deadline/cancellation checks and cooperative event-loop yields surround
reads and calculation/output work. Work accounting includes pairwise rule checks,
rate components, repeated calculations and JSON traversal. Result-byte accounting
is incremental and counts repeated references, punctuation and UTF-8 escaping
before constructing a complete response.

**The deadline is cooperative, not a promise of absolute wall-clock interruption
of every native operation.** Connection acquisition, transaction cleanup, a
synchronous SQLite call or a single calculation can finish before the next check.
PostgreSQL statement timeouts do not limit every connection/driver operation.
No detached `Promise.race` returns an error while leaving untracked replay work
running: the service owns its active operation until cleanup finishes. Client
disconnect requests cancellation, and module shutdown cancels and drains active
replay before database shutdown. Cancellation can therefore take longer than the
configured deadline when the underlying operation cannot yet be interrupted.

Successful responses include `complete: true`, `simulation: true` and
`historical_records_modified: false`. Resource exhaustion returns HTTP422 with
`pricing_replay_limit_exceeded`; elapsed-time exhaustion returns HTTP408 with
`pricing_replay_timeout`. Cancellation uses `pricing_replay_cancelled` (HTTP499
when a response is still possible). Errors contain no partial results and never
silently truncate history or turn missing evidence into zero cost. The dashboard
clears prior simulation results before a rerun and displays localized resource,
time or busy errors. Replay makes no supplier calls and does not publish prices,
change receipts or adjust budgets.

## Dashboard and operation

The pricing status API reports effective limits with
`request_size_basis: parsed_json_utf8`. The pricing page displays publication and
request-body limits read-only, with their scope and historical-price guarantees,
in all seven locales. Capacity, body-size and replay failures have specific
localized messages. Host operators change
`pricing_limits` through the existing reviewed configuration workflow; workspace
users cannot raise a host-wide limit through the pricing API.

The example configuration contains a commented block; no user's running config
is changed. In this Goal, reloads and over-limit requests are tested only against
private synthetic fixtures, never production2099.

## Verification scope

Admission's availability predicate now has a
[workspace activation-interval index](pricing-activation-index.md), separate from
the existing model-keyed tariff selector. It avoids revisiting every unrelated or
expired model binding per request. This capacity improvement does not alter any
configured limit or imply that the HTTP performance gate passed.

Unit/SQLite/PostgreSQL contracts cover defaults, strict validation, valid/invalid
reloads, exact UTF-8 boundary behavior, duplicate bindings, cross-workspace totals,
future versions, cancellation, concurrent publication/retry, lowered limits,
historical snapshots and rollback. HTTP tests cover ordinary read-only quotes,
limit reporting, six over-size simulation/import routes, origin rejection,
unchanged native ingress and atomic rejected publication.

Replay tests cover SQLite/PostgreSQL row/source/result/work limits, exact UTF-8
accounting, one-snapshot consistency, a real PostgreSQL statement timeout, aborts,
shutdown draining, scope/inheritance validation and all-or-nothing HTTP responses.
Private-browser checks exercise success, resource/time/busy errors and removal of
stale simulations in Chinese desktop/light and English narrow/dark layouts, with
unchanged financial/configuration snapshots and supplier-call counts. This scope
does not certify every host can process the maximum settings within two seconds.

Refer to [implementation progress](pricing-engine-progress.md) for the latest
completed verification and remaining full-Goal gates. A configured ceiling is
not evidence that the separate HTTP performance target passed.

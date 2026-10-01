# Current cost-detail, report and replay outputs

This checkpoint delivers D-06's fee details, unknown-state distinctions and
separate historical/replay report/API outputs. It uses **fresh responses from the
current application source**, not older wire examples relabelled as current.
It does not complete the [pricing Goal](pricing-engine-goal-spec.md), waive its
PostgreSQL performance target or authorize production deployment.

## Execution boundary

The current TypeScript Nest `AppModule` ran behind real HTTP controllers on a
system-assigned loopback port, with a fresh in-memory SQLite database. Dashboard
access used a real password session and persisted workspace roles. The existing
fixture mocked provider fetches and disabled plugin discovery. Eighteen synthetic
provider calls generated the dataset, including an intentional video-status poll.
No real supplier or production database was accessed. The test instance closed.

This is not a compiled-`main.js`, durable database restart, PostgreSQL, Docker or
browser test. Existing source-matched full regression/platform evidence remains
separate. All application, frontend, dependency, migration and 1,473 compiled files
remain unchanged by this output-delivery work.

## Portable attachment

`pricing-cost-api-review.zip` contains 108 payload files plus a checksum inventory:

| Content | Purpose |
| --- | --- |
| `outputs/` | 88 complete API packets: method, path, relevant query/body, HTTP status and unmodified JSON response |
| `exports/` | Three scanned-summary exports: before/after completion and a five-row partial scan |
| `response-index.json` | Named synthetic cases and request/log identities |
| `read-only-invariants.json` | Four before/after count/hash checks over 38 pricing/budget/log tables and configuration; no underlying dumps |
| `contracts/` | Six selected current TypeScript wire contracts and their source hashes |
| Source/compiled manifests | Exact checkpoint identity, base commit and explicit uncommitted overlay |
| `verify.py` | Offline payload integrity and optional checkout identity check |
| `verify-contracts.py` | Independent Python exact arithmetic and fixture-contract checks |

The archive is 351,173 bytes, with SHA-256:

```text
87e11a4aec00485a5558ed1606b24119120a515c0462abf4cf55af2cc6a3e33b
```

Authentication headers/cookies, credentials, configuration/database dumps, model
prompts/responses and media bytes are not exported. Negative mutation packets
contain only synthetic pricing input. Selected contract files are review extracts,
not a standalone SDK; their imports may refer to the complete repository. This
attachment is not the final committed-source/runtime release package.

## What the outputs demonstrate

### All eight states, without treating unknown as zero

The initial report contains 21 requests and all eight states: priced, estimated,
partial, unpriced, missing usage, pending, free and legacy estimate. A partial
receipt has a USD 0.001 known subtotal but an unknown total. A missing-FX example
retains native CNY 0.002 while its USD total stays null. Legacy-only rows keep
their original estimates, remain non-replayable and are not counted as calculated
ledger expenses.

### Old prices and FX remain fixed

A retained request remains USD 0.002 after a newer tariff is published. A new
request costs USD 0.004; replay of the old request displays its original USD 0.002
and simulated USD 0.004 separately. The replay response explicitly says that
historical records were not modified. Legacy-only and nonexistent request IDs
return `not_replayable`, not invented usage.

An original CNY request retains its admitted 1/7 FX after 1/5 is published. The
historical FX endpoint returns the original version/rational rate bound to the
retained receipt hash. A request admitted without FX stays unknown rather than
borrowing the later schedule. Complete old cost-detail responses remain identical.

### Local cache and asynchronous completion

Cache hits show zero new supplier expense, separate logical budget use and a
frozen reference estimate. In logical mode the example retains USD 0.002 budget
use; actual-upstream mode records zero supplier expense. A CNY reference without
FX stays unknown. Zero supplier expense does not require inventing a conversion
rate for the missing reference.

The video begins pending with USD 0.8 reserved and no final amount. Synthetic
authoritative completion reports 6.4 seconds and commits USD 0.64, leaving zero
reserved. It is the same request, not an additional report charge. Other historical
details remain unchanged across that deliberate transition.

### Report columns and pagination

The final dataset has 22 requests after the new-price request. Its independently
checked columns remain distinct:

| Column | USD |
| --- | ---: |
| Calculated | 2.973553 |
| Estimated ledger amounts | 0.004 |
| Stored legacy estimates | 0.7 |
| Known parts of incomplete costs | 0.001 |

Do not add these and label the result complete actual expenses. Eight final
amounts remain unknown; seven requests remain financially pending in this
deliberately mixed-state fixture. A single 50-row-limit read and five 5-row-limit
pages select identical rows and totals. All 22 final details agree with their
report classifications, amounts and receipt-bound evidence hashes.

The actual current frontend page/log validators accept the captured outputs and
reject altered totals. The UI's export arrow function is extracted by TypeScript
syntax tree and invoked offline with a captured `Blob`; it is not reimplemented
and is not described as a new browser download. The partial example uses a real
five-row API page; the normal UI requests 50 rows. Its export retains
`scan_complete: false` and scanned-prefix totals.

Exports describe scanned summaries, not every row, supplier invoices or a single
point-in-time financial close. The declared consistency remains
`page_snapshot_live_between_pages`; this quiet-fixture equality does not strengthen
that contract for concurrent production writes.

### Permissions and read-only effects

Unauthenticated detail/report/replay calls return 401. A stored viewer can read
and replay but receives 403 for mutation. Another workspace sees no private
detail, gets non-replayable results for the foreign request and cannot reuse its
report cursor. Each read/replay/denial phase leaves all 38 inspected table hashes,
counts, configuration hash and provider-call count unchanged. Intentional fixture
publication, role setup, new dispatch and video completion occur between those
separately checked phases, not inside a claimed read-only interval.

## Independent verification

The Python oracle imports no application calculator or report accumulator. It
checks 20 cost receipts, 25 component lines, exact fraction/rate/unit arithmetic,
half-even rounding, admitted FX, immutable receipt hashes, report totals, page
continuation and all stated state/history/permission distinctions. Legacy-only
logs account for the remaining two of 22 final requests.

A fresh extraction passes both payload and contract checks. Changing a report
total is rejected by both; an unexpected file is rejected by the inventory check.
After extraction, run:

```sh
python3 verify.py
python3 verify-contracts.py
python3 verify.py --repo /path/to/matching-checkout
```

These verify this synthetic attachment, not arbitrary supplier invoices or a
trusted-party release signature. The first capture attempt failed a private
artifact-filename validator; its stopped fixture and failure are retained. Two
initial independent-oracle assumptions were corrected against the unchanged API:
literal zero need not have decimal places, and an explicitly zero local-cache
supplier expense needs no FX while its separate reference remains unknown.
No application assertion, price calculation, timeout or performance threshold
was relaxed, and the API run was not repeated for those oracle corrections.

The [cost report contract](pricing-cost-report.md), [UI delivery](pricing-ui-delivery.md)
and [operator guide](pricing-operations.md) explain interpretation. Final source/
runtime delivery, aggregate acceptance and the original performance gate remain
open. Production 2099 and the user's model configuration were not changed.

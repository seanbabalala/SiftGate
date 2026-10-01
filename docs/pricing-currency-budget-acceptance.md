# Currency and budget contract acceptance

This record checks the original PRICE-03 and FLOW-02 clauses, not a reduced Goal.
Prices, usage and exchange rates below are synthetic. The gateway under test uses
mock suppliers, temporary databases and non-production ports.

## Mixed-currency fallback closes a missing integration check

The new real-HTTP matrix uses JSON and SSE, with and without an admitted CNY/USD
conversion. A USD node reports paid usage and fails; the fallback succeeds on a
CNY node. While the first node is running, an administrator publishes a new FX
version. The price books themselves do not change.

| Evidence | Original request, FX available | Original request, FX absent |
| --- | --- | --- |
| Failed first attempt | USD0.0012 | USD0.0012 |
| Successful fallback | CNY0.0084 | CNY0.0084 |
| Admitted conversion | USD1/CNY7 | None |
| Complete report total | USD0.0024 | Unknown |
| Known report subtotal | USD0.0024 | USD0.0012 |
| Newly published USD1/CNY5 | Not borrowed by fallback | Not borrowed by fallback |

A subsequent direct request uses the new conversion and costs USD0.00168 for the
same CNY0.0084 original. The first request's receipts, budget result and report
remain unchanged. In particular, the implementation never adds0.0012and0.0084
as if both were USD, and never turns absent FX into a free fallback. Under the
explicit actual-upstream policy, the unknown fallback retains its unresolved
reservation while the known first attempt remains charged.

Published-version quotes reproduce the native amounts. Retained receipts, the
cost-detail API, numeric log projection and report totals agree on USD amounts
under the admitted FX, separately from those native-only quote checks. Report reads do not write pricing, budget or
call-log rows. Each case makes exactly three mocked supplier calls: original
primary, original fallback and a new direct request.

## PRICE-03: all six original clauses

| Clause | Inspected implementation and verification |
| --- | --- |
| Native currency and report labels | `CostComputation`/lines retain native currency; USD report fields and current breakdown/report components label their basis. The new mixed-currency HTTP cases preserve both native amounts. |
| Frozen version, source, ratio and effective time | Admission freezes the catalog and FX selector. Historical FX reads are scoped to a retained receipt hash. Existing async-media HTTP tests retain price/FX through completion and correction. |
| Explicit FX administration; no hot-path network lookup | Scoped confirmed CAS updates and previews use the repository/controller; catalog calculation and historical FX inspection use retained data only. No external rate feed is enabled. |
| Missing FX is unknown, not free | Calculator and real-ingress tests retain native CNY while USD remains null. Strict mode rejects before dispatch; compatible mode keeps the valid response. |
| Never sum unlike native currencies | The new JSON/SSE matrix verifies complete versus partial report totals, the known USD subtotal and unchanged native receipts. |
| Separate price/FX audit and historical identity | Price publication and FX update use distinct audit actions; catalog identities are immutable. New FX publication does not reprice an admitted fallback or historical receipt. |

This verifies the supported USD reporting contract with separately retained native
currencies; it does not promise arbitrary supplier invoice reconciliation or
certify the provenance of an administrator's exchange-rate data.

## FLOW-02: all six original clauses

| Clause | Inspected implementation and verification |
| --- | --- |
| All budget scopes remain | SQLite/PostgreSQL fixtures cover eight overlapping global/namespace/team/key token and cost rules inside a workspace, plus an unchanged foreign-workspace counter. |
| Database concurrency boundary | SQLite uses the owned single-instance write queue. PostgreSQL tests exercise independent service instances and transaction runners with ordered locks; independent SQLite files are not a shared budget store. |
| Explainable conservative reservation | The shared envelope covers cached partitions, input tiers, calendar/service variants, minimums and rounding. Retry allowances do not multiply the tier-input quantity. |
| Strict admission and truthful overrun | A real HTTP case retains its admitted100-token cap despite an in-flight policy edit, settles900observed tokens as USD11 with USD3.8overrun, returns200, and rejects the next request before another supplier call. |
| Idempotency and safe recovery | Concurrent reserve/settle/release, reset epochs, lease renewal, async-job preservation and the first-dispatch/recovery race have direct cross-database assertions. |
| Explicit budget-policy change | Legacy logical/winner accounting remains default. Actual-upstream/non-token policy requires scoped administrator confirmation/CAS/audit and is frozen for in-flight work. Price publication does not reset policy. |

## Evidence boundary and remaining work

The four new HTTP cases supplement the previously passed unit, integration and
browser evidence. The full current HTTP inventory is rerun; unchanged application,
unit-test and dependency hashes retain the prior complete unit regression instead
of claiming an unnecessary new run. The private acceptance attachment binds every
clause to the exact source hashes and passed assertions.

PRICE-03 and FLOW-02 can now be marked verified for this checkpoint. This does not
complete M0–M6 or waive the original PostgreSQL performance target. No new
performance, Docker-image, deployment or browser result is claimed here.

One concrete remaining RULE-05 question is now isolated: quantity availability
and a video-profile selection do not establish whether a media specification is
model-fixed or request-derived. Current extraction paths and the metering review
lack an explicit specification-authority declaration at that boundary. Keep that
clause open rather than inferring it from general media support. The remaining
original UI/migration/platform and final candidate requirements also stay open.

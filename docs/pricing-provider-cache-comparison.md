# Provider-cache comparisons: recorded evidence and coverage

The Dashboard cache report is a comparison of **recorded legacy token-log
estimates**, not an invoice, a supplier-expense total, or a budget credit. It is
separate from the immutable [cost report](pricing-cost-report.md) and from the
[frozen local-cache reference](pricing-local-cache-reference.md).

## Why current-price reconstruction was removed

The earlier report substituted today's token prices when a historical
`cost_without_cache_usd` was missing. It could also replace the recorded actual
cost with a cheaper current estimate. New-engine projections deliberately leave
the legacy reference empty; media charges cannot be compared with a token-only
estimate. A synthetic seven-video fixture exposed the consequence: no provider
cache tokens, but a large negative "cache saving" caused by comparing media fees
with unrelated token prices.

The report now reads the persisted `cost_usd` and `cost_without_cache_usd` pair
only when both are finite, nonnegative and representable. Missing evidence stays
unknown. No configuration publication can reprice a historical pair in this view.
This is an intentional correction of the old reporting behavior, not a migration
or a rewrite of historical records. Request fees, budget effects and provider
calls are unchanged.

## Response contract

`GET /api/dashboard/cache-savings` remains workspace-scoped and supports the
existing period, grouping and identity filters. Its coverage is explicit:

- `comparison_basis: recorded_log_estimates` identifies the source, not a verified
  supplier invoice or the advanced pricing engine's immutable counterfactual.
- `comparison_status` is `empty`, `complete`, `partial` or `unavailable`.
- `cache_eligible_requests` counts recognized token operations. Media and other
  non-token provider operations increase `excluded_requests`; local cache,
  semantic cache and hook nodes are not provider-routed requests.
- `comparable_requests` counts valid stored pairs. Eligible rows lacking a pair
  increase `unavailable_reference_requests`.
- Whole-selection `actual_cost_usd`, `hypothetical_no_cache_cost_usd` and
  `savings_usd` are null when coverage is incomplete. They are not all-traffic
  supplier totals. Mixed token/media selections are not complete comparisons.
- `known_*` fields are subtotals for comparable pairs only. `exact` carries their
  18-decimal sums and signed difference without binary-floating-point addition.
  It preserves the representable decimal form of a legacy number; it does not
  restore precision already lost when that number was originally recorded.
- A recorded zero baseline is valid. An undefined percentage for a zero baseline
  stays null. Genuine negative recorded differences remain negative.
- Per-dimension cost fields stay null: the legacy logs do not retain a verified
  input/read/write/output price decomposition. Today's prices cannot repair it.

The read uses deterministic timestamp/ID ordering and examines at most
`pricing_limits.max_replay_rows + 1` records. `scan.scanned_rows`, `scan.row_limit`
and `scan.has_more` disclose the bounded prefix. A truncated selection, group or
trend day is never labeled complete. Counts and known subtotals in a truncated
response describe the scanned prefix, not the entire requested period. Future
log rows are excluded. SQLite reads coordinate with owned writers rather than
observing their uncommitted updates.

## Dashboard and compatibility

Overview, Budget and Analytics render unavailable values as an em dash, explain
coverage in all seven languages and link to the immutable cost report. Missing
per-dimension evidence produces an explanation, not an invented cost chart. Log
details distinguish a missing reference from zero and retain negative differences.
Small nonzero comparisons use scientific display rather than appearing to be zero.
The log detail comparison cost is unavailable without a paired baseline; its
independent original log amount remains visible in the request list.

Consumers of this endpoint must accept nullable comparison/decomposition fields
and inspect coverage; replacing null with zero changes the meaning. The ordinary
stored-pair aggregate regression remains, but three old tests were intentionally
corrected: missing-baseline current-price fallback, retroactive cache-price
recalculation, and cheaper-current-price replacement. They now assert unknown or
unchanged historical amounts. This exception is documented rather than claimed as
unchanged legacy behavior.

## Verification and remaining scope

The checkpoint adds 17 unit cases and six real-HTTP cases, including priced media,
workspace isolation, zero/missing/negative references, current-price changes,
submicro precision, scan caps, future rows and SQLite writer coordination.

This is a truthful reporting boundary, **not completion of advanced provider-cache
analytics**. Advanced cache counterfactuals still require verified frozen usage,
price/version, tier/calendar and FX evidence. Complete large-period aggregation
or pagination, and immutable per-dimension reference decomposition, remain open.
No current-price guess is an acceptable substitute. UI-04 and MIG-01 are not
promoted to complete by this correction. Overall Goal acceptance, the original
PostgreSQL performance target and the final candidate remain separate gates.

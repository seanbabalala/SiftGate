# Metering, precision and rule acceptance

This acceptance map covers original METER-02, PRICE-02, PRICE-05, RULE-02,
RULE-03, RULE-04 and STATE-05 clauses. It is not a certificate for the entire
pricing Goal. In particular, the native HTTP performance gate and final-source
candidate delivery remain open.

## Verified contracts

| Requirement | Current implementation and direct evidence |
| --- | --- |
| METER-02: quantity properties | `MeterQuantity` uses an exact decimal-string value in its canonical base unit. The string represents its integer significand and decimal scale without separately mutable scaling fields. Source, quality, subset relation and adapter identity remain in normalized evidence. Unit tests cover large counts, fractional seconds, invalid partitions, missing counters and explicit local-cache zero. |
| PRICE-02: precision | BigInt rational arithmetic retains intermediate remainders. Money rounding is independent from minimum/quantity rounding. Explicit original/report adjustments reconcile rounded lines to totals; numeric log columns remain compatibility projections. Calculator, exact-decimal, report and real HTTP correction tests exercise those boundaries. |
| PRICE-05: cache | Cache reads, unknown-TTL writes and known 5m/1h writes have independent rates. The aggregate is decomposed rather than billed again. Legacy model-specific cache inference stays in `legacy_estimate`; missing TTL is never silently guessed as 5m. Raw Messages/SSE and published-quote comparisons verify the runtime path. |
| RULE-02: composition | Ordered groups define precedence. A group selects one highest-priority matching rule; equal-priority overlaps are rejected. Additions, replacements, multipliers and combined-media billing are explicit. Mixing add and replace for the same dimension inside one group is rejected, not resolved by array order. |
| RULE-03: context tiers | Whole-request tiers use normalized total input, including cached input. Bounds are exact integers with a half-open upper edge. Input/output rates may differ. Retry allowance multiplication does not change a single attempt's tier. Graduated mode is not implemented: the API rejects it and the UI exposes only whole-request mode. |
| STATE-05: cumulative streams | Chat duplicate cumulative usage retains the final counters. Messages start/delta merging and Responses/Gemini completion evidence remain protocol-specific. The HTTP test verifies one final receipt and budget amount rather than summing cumulative reports. |

The clause-level evidence uses actual passed assertions from the current full
4,142-unit/753-HTTP run, not filenames or test counts alone. Each referenced
source and compiled artifact is hash-bound to that checkpoint. This audit does
not claim a new full regression run or promote the broader METER-01/03,
RULE-01/05, media lifecycle or platform requirements.

## Independent monetary cross-check

A separate fixture executes the compiled compiler, normalizer and calculator
for 256 combinations of:

- USD or synthetic CNY with a fixed rational CNY-to-USD conversion;
- six or nine display decimal places;
- half-even, half-up, ceiling or floor money rounding;
- zero, one millisecond, fractional seconds or an exact quantity above the
  binary-safe integer range;
- no quantity rounding, whole seconds, whole minutes, or floor plus minimum;
- explicit base fees, small additive fees and an exact dimension multiplier.

An independently written Python `Fraction` oracle verifies every exact line
fraction, billed duration, final original/report amount and rounding adjustment.
The fixture makes no provider request and does not open an application database.
Its first invalid draft mixed add/replace inside one group; the compiler correctly
rejected it. The fixture was corrected to use explicitly ordered groups, without
changing application code or weakening validation.

This is additional correctness evidence, **not a performance benchmark** and not
a claim about any supplier's actual rates.

## Calendar clauses and timing-agreement review

The existing calendar and HTTP tests verify IANA zones, multiple half-open windows,
explicit-date/holiday/weekday precedence, working-weekend declarations, overnight
carry, DST jumps/repeated hours, expiry diagnostics and frozen completion-time
selection. The normalized week UI has its own prior browser evidence, including
seven locales, narrow/dark layouts, dense-day pagination and independent expected
segments. Its relevant matcher/editor/preview modules remain unchanged in the
current source; this audit does not replay that browser workflow.

The earlier audit left RULE-04 clause7 unverified: a valid time-basis enum did not
prove confirmation of the supplier's timing agreement. New publication, scheduled
activation and rollback now require an explicit administrator attestation bound
to the exact price-content hash and alternative basis, with an opaque review ID.
Direct repository/API calls, inherited prices and unused calendars cannot bypass
the check. Default dispatch timing and previously published snapshots remain
unchanged. See the [timing agreement API contract](pricing-management-api.md#supplier-timing-agreement).

The complete 4,154-unit/757-HTTP run verifies this change. Separate SQLite and
independent-PostgreSQL-connection fixtures cover scheduled publication, peer edits,
stale confirmations, cancellation and rollback. The actual Dashboard checks all
seven locales in desktop/light and narrow/dark layouts, plus the default timing
control. Two confirmed publications and a rollback verify the submitted review
and audit without provider calls. RULE-04 now has evidence for every original
clause; the whole Goal is still incomplete.

Attestation records the administrator's verification, not an independent supplier
check or invoice reconciliation. The software does not fabricate missing
timestamps, accept private contract text, or upgrade estimated clocks to observed
facts merely because publication was confirmed.

Continuous-session tariff slicing is still a separate unsupported mode, not an
automatic extension of the whole-request calendar. Ordinary streams do not
silently split costs across a time boundary.

See [current progress](pricing-engine-progress.md), [calendar week behavior](pricing-calendar-week.md)
and [performance evidence](pricing-performance.md) for the remaining scope.

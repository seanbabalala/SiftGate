# Pricing boundary acceptance

All rates and counters below are synthetic fixtures, not provider pricing or
customer traffic. These checks complement the broader pricing Goal; they do not
waive its performance, lifecycle or final deployment/rollback requirements.

## Invalid and very large quantities

The actual JSON and SSE paths receive negative counts, a malformed `NaN` string,
an unsafe numeric integer and cached counts larger than the total. The model
response remains successful while the retained cost includes explicit diagnostics
and an unknown total, not a negative/free charge. Known components remain a
separately labelled subtotal. Original-price quotes and report rows agree.

An exact decimal string is a different input type from an unsafe binary number.
`"9007199254740993"` is preserved as a string, and its synthetic output price is
calculated without rounding the token count through JavaScript `Number`. The UI
intentionally uses decimal strings: a valid string is not rejected merely because
it could not safely be represented as a numeric JSON value. Browser checks cover
both the invalid receipt diagnosis and the valid large-string simulation.

## Duplicate billing and invalid rules

Import validation and book creation reject an implicit combination of image
count and output tokens. Explicit combined-media permission still cannot enable
charging a token parent and its subset together. Ambiguous equal-priority rules
and incompatible units are also rejected. Rejection leaves the catalog unchanged,
and an actual request still settles using the previous active version.

A separate HTTP scenario attempts to publish over an already scheduled future
activation. The conflicting publication returns a version conflict; the original
head and price records remain unchanged, and the current price continues serving.
This does not assert that every schedule-conflict UI interaction is verified.

## Multiple attempts with incomplete evidence

One customer request makes three synthetic credential attempts. The first has no
reliable usage and the later two each cost `0.00002 USD`. The retained request has
an unknown total, a known subtotal of `0.00004 USD` and one unknown attempt. It is
not reported as a fully known `0.00004 USD` charge. Per-attempt quotes, request
details and period report rows preserve this distinction.

## Cache-write reservation and retry tiers

The fixture prices ordinary input at `1 USD/1M tokens` and one-hour cache writes
at `20 USD/1M tokens`. An expensive tier begins at 201 input tokens. A nine-attempt
allowance must not move a single attempt with 100 or 200 input tokens into that
tier.

| Admission mode | Single-attempt input | Retained allowance | Actual one-hour write plus 10 output tokens |
| --- | ---: | ---: | ---: |
| Compatibility estimate | 100 | 0.01818 USD | 0.00202 USD |
| Declared upper bound | 200 | 0.04266 USD | 0.00402 USD |

The strict envelope conservatively bounds independent dimensions, so it may
exceed the most expensive mutually exclusive allocation. Neither mode applies
the expensive context tier simply because the sum of its retry allowances is
large. Compatibility remains an estimate, not a supplier usage guarantee.

Tests observe the actual hold before the mocked provider responds and compare it
with the retained receipt, actual-upstream budget result and report. The browser
also reproduces those allowances using the identical price-content hash and an
explicit unpublished policy proposal. The proposal is not a new budget hold;
historical request details retain their original price-version identities.

## Evidence and remaining scope

The dedicated HTTP suite covers JSON/SSE variants and read-only before/after state.
Browser workflows exercise original-price simulation, invalid file import,
recorded holds, incomplete attempt totals, admission proposals and period reports.
Shared diagnostic and status surfaces are checked in all seven dashboard locales,
with the complete fixture matrix in English and Chinese, desktop and narrow/dark.

No browser read or simulation changes pricing, budgets, logs or configuration, and
none makes an additional provider call. The fixtures run on isolated ports and
databases, never the live gateway. Final candidate acceptance remains separate.

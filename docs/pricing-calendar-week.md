# Normalized calendar-week preview

The pricing editor's **Time & service** section can show an overlaid week for an
explicit date in the calendar's named time zone. It previews supplied calendar
data, including unsaved edits. It never saves a draft, publishes a price, reserves
a budget, calls a provider or rewrites history. Published documents and authorized
viewers can use the preview without gaining editing permission.

## Read-only API

```text
POST /api/dashboard/pricing/calendar/week-preview
Content-Type: application/json

{"calendar": "<PricingCalendarDocument object>", "date": "2026-09-30"}
```

`calendar` is a structured calendar document, not the example string above.
The existing Dashboard authentication, stored-role checks, JSON/origin checks and
pricing request-size limits apply. Only `calendar` and `date` are accepted; no
book/workspace override or executable fields are accepted in the body.

The date identifies the containing ISO Monday–Sunday week. Date arithmetic is
performed on civil dates, not by converting a browser-local timestamp. Calendar
compilation validates the named time zone, source version, coverage, window bounds
and overlaps. A frozen timezone-data version that differs from the server's
runtime produces a structured409 error rather than a seemingly valid preview.

One compilation feeds at most seven calls to the existing
`CompiledPricingCalendar.previewDate`. Its precedence is unchanged:

1. Explicit date override, including applicable previous-date carry.
2. Versioned holiday exception.
3. Weekly windows, including allowed previous-day carry.
4. The configured fallback tag.

Each day includes its date, coverage flag and contiguous `[start, end)` segments.
Each segment identifies its tag, source layer and anchor date. Days outside
calendar coverage have no segments and are explicitly unavailable; they are not
inferred to be free or off-peak. The selected week always contains seven dates,
even when only part of the week is covered.

The response binds the requested date and input hash to the normalized calendar's
version, hash, time zone, timezone-data version and coverage. A response hash
covers those identities and all segments. Client validation checks the binding,
seven expected dates, coverage, allowed sources and anchors, and contiguous
00:00–24:00 coverage for valid days. A partial or altered response is not displayed.
No full price book, provider credentials or financial records are returned.

## Civil schedule, not elapsed usage

The response declares `civil_schedule_not_elapsed_time`. It is a normalized
wall-clock schedule: on a DST transition, some displayed clock minutes may not
exist or may occur twice. Timeline widths are not measurements of elapsed time,
token usage or supplier charges. Actual requests continue to match absolute
timestamps through the original calendar engine, preserving their distinct
offsets/instants and frozen calendar version.

Neither this view nor a price label creates the interval-usage evidence required
for time-sliced session billing. No continuous-session billing mode is enabled.

## UI limits and cancellation

- The preview module loads only when its editor section is used; requests start
  only after pressing **Preview week**.
- Seven day summaries are shown. Expanded detail pages contain at most12
  segments, with navigation to all remaining segments. The backend's civil loop
  bounds each day to at most1440 segments.
- Changing the date or calendar hides prior results and aborts their outstanding
  browser request. A response must still match the captured input before use.
- Manual cancellation and a15-second browser deadline prevent indefinite UI
  waiting. They do not promise preemption of synchronous server computation;
  server work is bounded and read-only, and may finish after disconnection.
- Invalid dates, expired coverage, timezone-data mismatches and request errors
  remain explicit. Retrying does not change stored configuration.

## Verification checkpoint

Seven languages pass desktop/light and narrow/dark browser checks:42 week views,
294 dates, keyboard expansion, dense-day pagination and actual viewport bounds.
Fixtures cover Shanghai holiday/date precedence, overnight carry, a28-segment
day, a New York fall-back week and partial calendar coverage. Independently written
expected segments agree with the returned data. Browser date/calendar changes
hide stale results; malformed response, cancel and retry tests pass.

Every pricing table, budget rule, log and fixture configuration hash is unchanged,
and no provider request occurs. Guarded browser runs use fallback fonts because
external font requests are blocked. The browser fixture uses synthetic no-login
mode; real password/session and viewer authorization are checked separately by
HTTP tests. Earlier harness route-removal/modal failures are retained and excluded
from accepted browser results.

The complete source checkpoint passes4,080 unit tests and746 HTTP tests with no
failures or skips, along with build, frontend, lint, SDK and static/config checks.
Existing migration001–018 checksums remain unchanged. This verifies the calendar
week feature, not the entire Goal, production cutover, final image or unmet Gateway
HTTP performance targets. Production2099 remains untouched.

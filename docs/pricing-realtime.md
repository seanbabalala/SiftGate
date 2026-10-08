# Realtime session and response pricing

The Realtime WebSocket bridge can use an explicitly published `realtime` price
binding. The session captures one immutable catalog revision before the supplier
connection opens. Model responses use that revision for their entire session;
later price or policy publication affects new sessions only. A session without a
binding retains the existing compatibility path. This is not a new client URL or
deployment requirement.

## Supported evidence and quantities

The adapter reads the native Realtime `response.created` and `response.done`
events. Each supplier response ID maps to one local attempt. Repeated terminal
reports with the same normalized usage/status are ignored. A different terminal
report for the same ID is archived for review; it never silently replaces the
first fee. Transcripts, audio bytes, instructions, tool arguments and arbitrary
provider fields are not stored in the pricing ledger.

`response.done.response.usage` supplies total input/output tokens. Its
`input_token_details` supplies text/audio/image input, cached input and
`cached_tokens_details`; `output_token_details` supplies text/audio output.
Cached modality counts are subtracted only when attribution is known. Missing
counts are not zero, unsafe numbers are not rounded into cheaper quantities, and
input/output/aggregate relationships are checked. A failed, cancelled or
incomplete response may still carry billable usage and is not assumed free.

Two components are recorded separately:

| Component | Quantities and identity |
| --- | --- |
| Model response | Reported token quantities; `request_count = 1`; `session_seconds = 0`. Each response is counted once, including a reported cancelled/failed response. |
| Session measurement | Monotonic elapsed connection time in `session_seconds`; token quantities and `request_count = 0` when closure is known. This local measurement is not another model response. |

Thus `request_count` in a Realtime tariff means **model responses**, not client
connections. Session seconds are measured locally, not inferred from audio byte
length or advertised as supplier-reported voice duration. Operators must verify
that this is their intended contract basis. Duration and token fees are added only
when both are explicitly configured; `allow_combined_media` is required for a
combined basis. A token parent cannot also be billed with its modality children.
Zero-valued dimensions do not incur another minimum fee on the other component.

The session measurement uses connection admission time for rule selection.
Response dispatch and completion times are captured when the supplier event
arrives, before waiting for the accounting queue, and are marked estimated for
calendar pricing; a server-VAD response does not have a
verified client dispatch timestamp. No provider-accepted timestamp is invented.
Replay preserves this estimated-clock status. Session elapsed time stops at
transport close, not after queued receipt writes; repeated closes cannot extend it.
Session time is not split across tariff windows; the selected session component
rule is fixed at session start. GPT-Live and delegated Responses events are not
aliases for these native Realtime events. Input transcription has the separate
contract below; it is never included in a Realtime response's token receipt.

## Admission and limits

The existing price editor accepts `operation: realtime`. Its metering review
remains conditional and displays the seven-language session/response warning.
The admission policy dialog adds `realtime_max_responses` (1–999). Policies are
versioned with the catalog, and this field is preserved during later edits.

For `reserve_upper_bound`, configure:

- `realtime_max_responses`: the number of model responses covered by the session;
- per-response token limits, or corresponding parent input/output limits;
- `quantity_limits.session_seconds`, covering the gateway's configured
  `realtime.max_session_ms` timeout;
- a verified supplier/contract `limit_reference`.

The conservative reservation is the full rate envelope multiplied by
`realtime_max_responses + 1`. This deliberately includes an entire duration
allowance in every envelope, covering rounding, minima and differently selected
response rules, plus the session component. It can over-reserve substantially;
it is not a final charge or a proof of a supplier's hard limits. The admission
simulator uses the same rule: choose that attempt count and supply the gateway
session cap as estimated `session_seconds`. Incorrect multiplicity or missing
caps reject before the supplier connection opens.

Compatibility mode can admit an explicitly unknown price estimate and reserve
zero. It does not guarantee a spending cap. A priced session defaults to a bounded
128 responses if no response limit is declared. The first observed response
beyond its allowance is retained when possible, then the bridge closes and keeps
the remaining accounting uncertain. Server-initiated generation cannot be
stopped before a `response.created` event has already occurred; the guarantee is
conditional on declared supplier limits, not an unconditional hard spend cap.

## Persistence, closure and recovery

A durable session witness and reservation are created before connecting to the
supplier. Model-response receipts are persisted independently during the session.
After known closure, the duration receipt and all known response fees produce
one exact, idempotent budget settlement. This new explicitly activated Realtime
path accounts for its retained response/session costs; it does not change HTTP
requests' legacy logical-budget policy. Log-independent costs are available by
request ID in the existing cost ledger/report APIs.

If usage is missing, terminal events conflict, input was forwarded without a
corresponding response, the transport fails, or accounting persistence is
backlogged, existing receipts survive and the allowance remains reserved for
reconciliation. A durable settlement application failure is retried through the
existing outbox. Pre-durable failures have a bounded retry buffer, not a claim of
crash-proof memory; after process loss the durable dispatch witness prevents an
automatic free/undispatched release and appears in orphan review after its lease
expires. A TCP disconnect without a WebSocket close frame is abnormal, even if
the socket API reports no error. Client-input sequence numbers are captured with
each incoming event: delayed or duplicate creation events cannot acknowledge
newer input. On uncertain closure, the session witness has unknown token and
response-count quantities, so a per-response-only tariff cannot appear free.
The session-clock adapter is version `2` for new receipts; historical records are
unchanged. The lease covers the frozen session timeout plus two minutes. Recovery
never opens another supplier connection or replays generation.

The proxy bounds queued metering events, fragmented client messages, pending
handshakes and close-time accounting work. Closing a transport does not release
all admission capacity while its accounting is still draining. During
application shutdown, it closes upgraded transports, drains their queued
accounting and flushes retained outcomes before database shutdown. It does not
introduce a competing process-exit handler.

## Actual-upstream policy

Administrators can explicitly publish `budget_basis: actual_upstream` for
`realtime`; absence retains the older session-allowance settlement. In actual
mode, admission creates the reservation, and an awaited durable provider
connection intent is recorded immediately before opening the supplier socket.
The separately measured connection component has provider attribution, not a
synthetic expense relabeled by the planner. A known never-dispatched admission
closes an empty cohort and releases its hold. An attempted handshake without an
open acknowledgement remains unknown even on clean client closure.

Connection and response receipts close one complete actual-expense cohort through
the shared durable inbox. Closure, debit and delivery acknowledgement retain the
same transactional and replay protections as other actual requests. Paid failed
or cancelled responses are included; duplicate terminal reports do not double
debit. Missing required token totals, conflicting evidence, ambiguous sent work
or abnormal transport closure keep the hold pending, with known response fees
still visible. A published token-free tariff may explicitly select
`token_budget: not_applicable`; this never bypasses monetary budget scopes.

Native generation tracking now applies to both the legacy session allowance and
actual-upstream policy. It distinguishes `response.create` from non-generating
control messages; editing session instructions, cancelling an already tracked
response or adding a text conversation item does not itself create a new model
fee or an unacknowledged-generation hold. Each response can acknowledge at most one outstanding command,
and observations cannot acknowledge commands sent later. For parallel responses,
an exact, unique metadata correlation can establish the match; only an ephemeral
hash is used, never retained metadata or injected wire fields. Without correlation,
matching requires supplier-acknowledged manual generation. Unacknowledged
configuration changes invalidate the previous assumption. Supplier session-mode
acknowledgements and first response identities are applied in transport order,
before the accounting queue. A slow receipt writer cannot let a later client
configuration change misclassify an earlier observed response or bypass the
response allowance. Explicit VAD `create_response: false` can establish manual
generation only when no idle-response timeout is configured.

### Automatic VAD buffer custody

An acknowledged server/semantic VAD configuration with explicit
`create_response: true` and disabled transcription can associate committed audio
turns with distinct responses in the default conversation. The
`input_audio_buffer.committed` item identity is deduplicated separately from
response IDs. A response cannot clear an unrelated outstanding manual command,
and an out-of-band response cannot acknowledge a default-conversation audio turn.

Finishing a response does not prove that later or trailing audio was discarded.
Before closing a fully accounted automatic session, the client can send
`input_audio_buffer.clear` and wait for `input_audio_buffer.cleared`. This clears
only buffer custody preceding that specific clear command; audio sent afterward
remains pending. It does not erase committed turns, responses or independent
transcription work. Duplicate event IDs cannot consume another clear command.
These control acknowledgements do not create price components or infer billed
seconds from audio bytes. Native wire payloads are not rewritten.

### Independent input transcription

An administrator can opt into separate ASR accounting by setting this declaration
on an explicit `realtime` operation policy:

```json
{ "realtime_transcription": { "model": "YOUR_ASR_MODEL", "max_items": 2 } }
```

First publish that model's `audio_transcription` tariff and an operation policy
with `mode: reserve_upper_bound`, `budget_basis: actual_upstream`, per-item
quantity limits and their reference. Token-priced ASR requires input/output token
limits; duration-priced ASR requires its own audio-seconds limit and an explicit
token-budget choice where applicable. The ASR policy and price must be available
in the same immutable request snapshot as the Realtime contract.

Admission creates two separately scoped reservations before the supplier
connection. Failure to admit the second compensates the first without dispatch.
An explicit token exemption on the Realtime contract does not exempt token-priced
ASR. The editor and admission simulator show the model, item limit, separate ASR
reservation and combined total. Changing a proposal invalidates its prior
approval. Clearing both ASR fields removes the declaration for new sessions only.

Audio waits in the existing bounded transport queue until the supplier confirms
the declared model or explicitly disabled transcription. All sent session updates
must be acknowledged: `session.created` is not an update acknowledgement, and a
duplicate event ID cannot acknowledge a later update. Missing or conflicting
acknowledgement identity does not authorize audio. A different confirmed model
is rejected before sending the queued audio. Rejected updates without a matching
usable acknowledgement do not silently reuse an earlier configuration.

Each committed audio item gets an independent provider attempt. Native
`conversation.item.input_audio_transcription.completed` receipts use their own
token totals or audio-input duration, never the Realtime model's rates. Duplicate
normalized receipts do not double charge. The synthetic session witness is zero
only when independent ASR custody is known complete; it is not another paid
transcription. Transcripts, audio bytes, prompts and arbitrary ASR error bodies
are discarded by the pricing adapter.

Sent manual commits count against the allowance before their item acknowledgement
arrives. A later buffer-clear acknowledgement does not release unacknowledged
commits or committed items. Server-generated VAD work can exceed a declared item
limit before the gateway observes it; this is still a conditional supplier-limit
contract, not an unconditional hard spending cap. Conflicting receipts or
unclassifiable ASR work propagate a stop decision to the bridge while preserving
known fees and unresolved holds.
Stopping transport does not discard already-observed Realtime response receipts
queued behind the conflicting transcription event. Those receipts are drained
and retained, including duplicate-safe terminal handling; the stop decision
remains false rather than reopening admission or declaring the session complete.

The current integration supports one fixed ASR model per session and committed
buffer items with `content_index: 0`. Direct audio `conversation.item.create`
messages are rejected under this declaration. In-flight buffer configuration
changes, missing terminal evidence and ambiguous automatic settings remain
uncertain. Without a separate ASR declaration, enabled/unknown transcription with
committed audio still retains unresolved custody rather than being priced free.
These boundaries do not waive the original Goal's remaining mode, calendar/FX,
capacity and late-receipt requirements.

Known closure uses the shared durable actual-expense cohort machinery. Fresh
SQLite and PostgreSQL connections can replay a retained closure once; a stored
receipt alone cannot invent a lost closure. Confirmed later ASR adjustments use
the original tariff and budget epoch, with atomic audit and idempotency. This
tested internal adjustment path is not an automatic acceptance of conflicting
native events: those are archived for review, and their complete operator
correction workflow still requires acceptance evidence.

## Verification and limitations

Tests use private loopback WebSocket peers, synthetic tariff/usage fixtures and
temporary SQLite/PostgreSQL storage. They cover the actual authenticated bridge,
duplicate terminal events, frozen pricing, exact costs, concurrent reservations,
unknown closure, conflict archiving, durable retry and orphan retention. Separate
actual-entrypoint checks run the compiled `main` with on-disk WAL/FULL SQLite,
private peers and blocked external egress. They verify active-session shutdown,
abrupt client disconnect and incomplete supplier handshakes without losing known
receipts or declaring unresolved work free. Browser
and full-regression evidence is recorded in the
[progress log](pricing-engine-progress.md). This document is not deployment
authorization or a full M0–M6 completion certificate.

The automatic-audio change also has real child-exit checks on SQLite and
PostgreSQL: after a response receipt, after durable closure retention, after
settlement, and with unresolved independent transcription. Fresh connections
replay only recorded authority. A response receipt alone does not invent a lost
closure; retained closure can settle once; unknown ASR work stays unresolved.

Independent-ASR tests additionally cover token and duration receipts after real
child exits before closure, after closure retention, after settlement and with
missing usage. They check acknowledgement rollback, original-epoch corrections,
separate token scopes and actual WebSocket ordering/refusal. Browser checks cover
the declaration, exact combined preview, invalid fields, stale approval and
audited save/remove/restore in an isolated fixture. These checks are not a
substitute for a current-source full regression or the outstanding delivery gates.

## Closure clocks, changing tariffs and FX

Independent ASR closure now receives the transport's frozen close observation.
Previously its synthetic custody witness omitted `completed_at`; a valid
completion-time calendar therefore made that witness unpriced, incorrectly
turning a computable request total into an unknown total. The fix supplies the
captured close instant, not the later accounting-drain time. Repeated close calls
retain the first outcome. Abnormal or incomplete custody still has unknown
quantities; a timestamp cannot make missing work free.

Cross-database lifecycle fixtures now change both Realtime and ASR tariffs, the
calendar and CNY/USD FX while a session remains open. Old items and subsequent
items in that session use its original versions; a new session uses the new
versions. Transport observations select the original calendar even if accounting
is delayed across a window boundary. Removing the current FX does not remove an
old session's frozen FX, but a new strict admission without FX is refused before
dispatch. Duplicate receipts and fresh-connection replay do not add another debit.

Computability and actual-budget authority remain distinct. Observed receipts with
ordinary tariff/FX changes settle exactly. Locally observed calendar times remain
explicitly estimated; actual-upstream budgets keep their holds rather than promote
those estimates to confirmed supplier expense. The legacy Realtime convention can
commit its logical estimate, while the independent ASR allowance remains governed
by its own actual-upstream policy. This fix does not rewrite historical receipts
or automatically repair earlier unresolved sessions.

The new lifecycle coverage drives the real accounting service with authenticated
management publication, request-cost and report APIs; it is not a new wire-level
WebSocket certification. Existing native WebSocket and child-process crash tests
remain separate. The scoped check passes 42 SQLite/PostgreSQL tests and 90 HTTP
tests across the affected suites, plus build and lint. A subsequent complete run
passes 3,905 unit tests in 196 suites and 704 HTTP tests in 55 suites, with no
failures or skips, plus frontend, SDK, configuration and build checks. This source
also includes the composed logical-settlement candidate. The original performance
and final-delivery gates remain open; no deployment is authorized.

Field meanings were checked on September 29, 2026 against the official
[Realtime server event reference](https://developers.openai.com/api/reference/resources/realtime/server-events)
and [VAD guide](https://developers.openai.com/api/docs/guides/realtime-vad).
These establish a metering contract, not current supplier prices, account access,
model support or hard quantity limits.

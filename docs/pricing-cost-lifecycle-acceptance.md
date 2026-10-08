# Cost lifecycle acceptance

This is a clause-by-clause review of the original failure, cache and asynchronous
accounting requirements. The initial seventeen-clause review made no application
changes. The subsequent STATE-07 implementation below received a fresh
**4,186-unit/791-HTTP** backend regression plus final frontend tests and browser
verification. Historical audit notes about missing actual-media crash recovery or
independent Realtime transcription are superseded by the inspected implementation
and its passing assertions, not by filenames or test totals alone.

## Local cache and failed attempts — FLOW-03

| Clause | Verified behavior |
| --- | --- |
| 1. Local-cache zero | A request with no upstream invocation has an explicit zero supplier fee. Hypothetical cache savings and optional local resource costs are not supplier charges. |
| 2. Compatibility budget | Legacy logical-token budgeting remains the default. Explicit actual-upstream policy preserves response usage but charges zero supplier budget for a local hit; in-flight policy does not change on publication. |
| 3. Multiple attempts | Credential retries, outer retries and a late timeout loser retain distinct physical attempts. Known expenses are summed; unknown attempts remain visible. Shared batch expense is conserved. |
| 4. Failed status | Observed failed JSON/SSE usage remains billable. Missing usage is unknown, not free; actual-budget finality stays pending when an earlier failed expense is unknown. |
| 5. Internal allocation | Releasing an unsuccessful logical request does not erase incurred supplier expense. A missing batch-member result preserves its allocated supplier cost. |

## Asynchronous media — FLOW-04

| Clause | Verified behavior |
| --- | --- |
| State chain | Reserved, submitted, pending, terminal and settled are durable states; uncertain and synchronous paths are explicit. Confirmed paid failures/cancellations settle, while unresolved usage keeps its hold. |
| 1. Admission snapshot | Price, FX, target, context, quantities, reservation and dispatch identity survive process memory loss. Price/FX identity assertions prevent coincidentally equal converted totals from hiding repricing. |
| 2. Retry/target identity | Status, cancellation and content use the original connection/credential. Ambiguous submissions do not generate again or fall back. A substituted target cannot bypass the admitted contract. |
| 3. Actual/requested quantity | All three image operations test sync/async actual returned counts. Reported video duration is distinct from requested estimates; missing or malformed results are not zero. |
| 4. Failure separation | Paid completed, failed and partial generation survives a content-download error. Cancellation acknowledgement alone is not cancellation. Unsupported native-profile controls reject explicitly. |
| 5. Deduplication | Client keys, durable observations, signed-event sequences and processing acknowledgements deduplicate submission, callbacks, polling and recovery. Concurrent sibling completion produces one initial debit. |
| 6. Corrections | Original terminal receipts are immutable. Later quantities produce linked adjustments at the original price/FX, without repeating the initial debit. |
| 7. Process recovery | Eight real actual-media child exits and two legacy-media exits cover retained evidence and transaction boundaries across SQLite/PostgreSQL. Fresh connections recover without supplier calls. Recovery is bounded to50observations and10tasks per invocation. |

These checks also satisfy `STATE-02`, `STATE-03`, `STATE-04` and `STATE-06`.
The audit additionally checks in-flight batch price/FX, Realtime/independent-ASR
snapshots, duplicate replay and real ASR process-exit cases. Confirmed cancellation
releases unused allowance through settlement; an unresolved cancellation does not
establish that any allowance is safely releasable.

Primary evidence lives in `pricing-attribution.e2e-spec.ts`,
`pricing-actual-budget.e2e-spec.ts`, `pricing-runtime.e2e-spec.ts`,
`pricing-batch-runtime.e2e-spec.ts`, `pricing-media-task.e2e-spec.ts`,
`media-task.spec.ts`, `actual-media-budget.spec.ts`,
`realtime-actual-storage.spec.ts` and `realtime-transcription-storage.spec.ts`.
The private audit records each original clause, exact assertion names and hashes.

## STATE-07 presentation and safe delivery error

The Dashboard task list and detail now use the same independently labelled
supplier-generation and task/accounting states in all seven languages. Unknown
provider status is not inferred from a known job ID or a settled task. Accounting
state never becomes a successful-delivery badge. Detail explains that failed or
cancelled generation may cost money and that this view does not record delivery
success. Complete known totals, including zero, no longer carry the old misleading
“total incomplete” subtotal label.

Real HTTP fixture verification also corrected an earlier audit assumption: the
internal content-failure message was being sanitized into a generic video-proxy
error, so the fee-retention explanation did **not** reach clients. Only this known,
constant error now uses the explicit public-error contract. It retains HTTP502,
the existing video error type and request correlation, while exposing
`media_content_unavailable` and the safe explanation that incurred generation
costs are unchanged. Raw upstream error content remains hidden. Both paid-success
and paid-failure tests reproduce the missing code/message on the parent source
and pass on the fixed source without changing stored fees or budget effects.

The final browser evidence contains54 checks:42seven-language desktop/light and
narrow/dark cases, all seven task scenarios with exact known/zero/unknown amounts,
keyboard navigation, operator visibility and viewer denial. The pages use actual
AppModule HTTP-created tasks, including two real proxy502 responses against a
synthetic upstream. Financial-table snapshots remain byte-equivalent throughout
the read-only views; no further generation or control call occurs. Supplemental
full-card visual capture uses a taller390px-wide viewport; the original390×844
layout checks remain recorded, not replaced.

This is not a requirement to invent a new billable download operation or a new
financial ledger for every download. Reuse the existing generation, processing,
receipt and structured transport-error evidence without changing charges.

The initial review promoted six families; this implementation additionally closes
STATE-07. Other metering, UI,
migration/platform and final-delivery gates remain independent. The PostgreSQL
performance gate is still open; see [the critical-path profile](pricing-performance.md#paired-postgresql-critical-path-profile).
Production2099 and its user-edited configuration remain unchanged.

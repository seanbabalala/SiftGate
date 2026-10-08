# Media calculation and recovery acceptance

These checks use synthetic prices, mock suppliers and disposable databases. They
do not deploy the gateway, change production policy or verify supplier invoices.

## Exact cross-layer calculations

For each case, the real dashboard submits both an editable-content simulation and
a published-version quote. Their rule IDs, price identity, quantities, billed
quantities, rates, exact line amounts and totals are compared with a real isolated
HTTP request's retained cost and budget result.

| Case | Input and explicit price basis | Expected USD |
| --- | --- | ---: |
| CALC-10 actual images | Request4, return3; USD0.04 per actual image | 0.12 |
| CALC-10 requested images | Request4, return3; explicitly price requested count | 0.16 |
| CALC-11 exact video | 6.4seconds at USD0.10/second plus USD0.02/generation | 0.66 |
| CALC-11 rounded video | Same usage, bill whole seconds upward:7seconds | 0.72 |
| CALC-12 exact audio | 61seconds at USD0.06 per60seconds | 0.061 |
| CALC-12 rounded audio | Same usage, bill whole minutes upward:120seconds | 0.12 |

The dashboard matrix covers all seven locales at desktop/light and narrow/dark
sizes:84case/layout/locale combinations, with separate visible current/published
amount screenshots. The original6.4/61quantities remain visible when the billed
quantities become7/120. Decimal separators are localized without changing exact
values. Simulations neither make supplier calls nor modify pricing/accounting rows.

Image and video fixture requests use explicit actual-upstream accounting with
non-token quotas. Audio retains the existing logical budget policy. CALC-12 proves
cross-layer audio price arithmetic, not actual-upstream audio policy integration.

## In-flight price and FX identity

SQLite/PostgreSQL ledger tests and HTTP tests change both the price book and FX
while a media task is pending. Old receipts and later corrections retain the old
price and FX identities; a new request uses the new identities.

The synthetic rate doubles while the FX conversion halves. USD totals therefore
happen to agree. Assertions also compare original-currency amounts, version IDs,
FX IDs and the saved request snapshot, so matching totals cannot hide repricing.

## Real subprocess interruption

`test/helpers/actual-media-crash-child.ts` opens only the explicitly supplied
disposable SQLite file or loopback test PostgreSQL schema. It does not bootstrap
the application or call a supplier. Four checkpoints terminate the child without
running graceful application shutdown:

1. After the first sibling's receipt/audit acknowledgement commits.
2. Before the last sibling's audit acknowledgement is written.
3. After the last sibling's completion-state write, still inside its transaction.
4. After the last sibling's complete ledger transaction commits.

Each scenario reopens the database through a fresh connection, replays processing,
checks both task states and verifies exactly one initial budget debit. Previously
committed receipts remain byte-identical. Mid-transaction exits must roll back the
last member's receipt, closure and debit together. The checkpoint and expected exit
code are asserted; an unrelated child error is a test failure.

## HTTP operation and failure matrix

The actual-budget HTTP suite covers image generation, edits and variations with
both synchronous output and asynchronous jobs. Edits/variations use multipart
input. Request4/actual3is retained, while prompt, source image, output image and
private output URL content is excluded from accounting storage. Idempotent replay
does not issue another generation.

Additional checks cover paid completed/failed video generation followed by content
delivery failure, cancellation acknowledgement versus confirmed cancellation,
missing usage versus reported zero, later immutable corrections, and reviewed
unknown-job lookup without repeating submission. Job association remains labeled
administrator attestation rather than supplier invoice confirmation.

## Remaining boundary

This is a verified media checkpoint, not complete M0–M6 acceptance. Actual-cost
Realtime/audio/rerank integration, broader capacity and late-review behavior,
performance targets, remaining requirement audit and portable final candidate,
image and database-aware rollback evidence remain separate gates. The private
browser harness and its raw evidence still need final delivery packaging.

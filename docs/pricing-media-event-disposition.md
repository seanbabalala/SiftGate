# Media alternative-event disposition

This candidate adds explicit administrator decisions for retained `review_required`
media evidence. It does not authorize production activation or a gateway restart.
The seven-language Dashboard editor opens at
`/pricing/media/:task/events/:event`. The task event viewer keeps original custody
and the separate operator decision visible, with a link to review the alternative.

## Custody is not accounting authority

Original supplier-event documents, their `decision`, hashes, source authorization
and original signed head remain immutable. A separate disposition records who
accepted or rejected an alternative, why, the exact reviewed task basis and
preview, and its normalized observation. Acceptance is an administrator decision,
**not** confirmation of a supplier invoice. Rejection changes neither observation
history nor financial processing.

Each retained event receives at most one decision. A workspace operation ID is
bound to the task, event, actor and exact proposal. Reuse with different data is a
conflict. New evidence needs a new event; prior decisions are not edited.

## Explicit subsequent ordering

Acceptance requires one of these policies:

- `continue_ordered`: only for authenticated, signed evidence at or beyond the
  current sequence floor. A later sequence can supersede it normally; equal
  sequences remain alternatives and older sequences remain stale.
- `manual_review`: future signed updates cannot automatically replace the
  administrator-selected evidence. Higher/equal sequences are retained for
  review. Older sequences are still stale. This policy is **mandatory** when
  accepting unversioned polling evidence; arrival time is not a provider sequence.

An administrator can end a manual-review hold by accepting a later signed
snapshot with `continue_ordered`. The accepted sequence then becomes the floor.
There is no blind “resume latest” action. The original signed head still references
its original applied receipt; an independent verified authority references the
accepted disposition. Missing or rolled-back authority fails closed.

`reject` requires `ordering: unchanged`. It cannot release or create a hold.
Terminal tasks cannot become pending again. A stale signed alternative can be
rejected but not accepted. Unprocessed observations must finish before accepting
another alternative; rejection remains available.

## API and no-write preview

Prefix:
`/api/dashboard/pricing/media-tasks/:task/supplier-events/:event`

| Method and suffix | Permission | Effect |
| --- | --- | --- |
| `GET /disposition-basis` | Operator | Current immutable evidence and eligibility |
| `POST /disposition/preview` | Administrator | No-write original-price/FX computation and impact |
| `POST /disposition` | Administrator | Audited decision and optional durable observation |
| `GET /dispositions/:operation` | Administrator | Read-only exact receipt acknowledgement |

Preview accepts `action`, `ordering`, `expected_basis_hash` and
`expected_event_hash`. Apply adds a stable `id`, `expected_preview_hash`, `reason`
and `confirm: true`. Arbitrary amounts, replacement rates, credentials and
supplier payloads are not accepted. The normal dashboard session, workspace,
trusted-origin and JSON protections apply. Membership is rechecked inside the
writing transaction, not trusted from the earlier preview.

Preview uses the request's captured catalog and FX, never newly published rates.
It shows the prior receipt, proposed computation, exact report-currency delta
when both totals are known, and the original-reservation budget correction preview
for terminal adjustments. Unknown totals remain unknown. Pending observations are
nonfinancial; first terminal observations use the existing initial settlement.
No current-period refund is promised: corrections follow the original budget
epoch. Preview does not fetch a provider, write an audit, or change budget balances.

## Commit, processing and recovery

The decision, audit, optional new observation and ordering authority commit in one
transaction under the original request/task and administrator locks. Terminal
observations retain the reviewed computation and expected prior cost hash before
financial processing. The existing idempotent initial-settlement/linked-adjustment
processor is reused; original cost receipts are not overwritten. Adjustments from
accepted alternatives carry the administrator's identity and reconciliation
provenance, not a fictional automatic supplier confirmation.

A decision receipt acknowledges custody, not completed financial settlement.
`processing_pending` reports a processing failure; check the task ledger as well.
If the reply is lost, read the same operation's acknowledgement or retry the exact
same proposal. A recorded retry uses its durable computation; it does not fetch a
supplier, apply current prices, create another observation or double-charge.
Changed evidence returns a conflict and requires a fresh preview.

Migration015 adds `pricing_media_event_dispositions` and
`pricing_media_event_authorities`; migrations001–014 are unchanged. Foreign keys,
unique operation/event/revision constraints and verified audit hashes protect
custody. Do not manually delete these rows to clear a queue. The task inventory's
`review_required` view excludes events with separate completed dispositions;
the original event decision still reads `review_required` in custody history.


## Dashboard recovery and accessibility

The editor requires an explicit decision and, for acceptance, a future-event
policy. Unversioned evidence never offers automatic ordering. It displays original
and proposed line-item costs, exact deltas, original budget-period allocations and
normalized evidence. A hash-invalid response cannot enable submission.

Before writing, the tab stores only workspace/actor/task/event-scoped operation
metadata, reviewed hashes, choice, policy and reason. A lost reply locks edits and
offers exact-ID retry or receipt acknowledgement. This recovery remains accessible
if the initial basis request fails or is still loading. Conflicts preserve the
user's reason; rereading is explicit and cannot silently reuse a stale preview.
Recorded receipt status is separate from pending financial processing. Existing
decisions load their historical preview, not a simulation at current prices.

Operator access is read-only, viewer access is denied, and workspace switching
cannot reveal another workspace's evidence. The page supports all seven locales,
keyboard-accessible native controls and narrow/dark layouts. Long event hashes
wrap independently of the heading; only the detailed cost tables scroll locally.

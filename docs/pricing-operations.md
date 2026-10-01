# Pricing operations

Use this guide to configure and review the development candidate's pricing
features. It is **not deployment approval**. The original PostgreSQL performance
gate is still open; the [progress record](pricing-engine-progress.md) identifies
the tested source and remaining delivery work. Do not follow these write steps
on a live gateway until its code, migration, backup and maintenance plan have
been separately approved.

All numeric examples below are synthetic exercises, not current supplier rates.
Confirm the actual model contract, measurement fields, service variants, calendar
and currency before publishing. The gateway does not infer a universal GPT
long-context multiplier or a DeepSeek peak/off-peak schedule from a model name.

## 1. Know which action changes traffic

| Action | Effect |
| --- | --- |
| Open Pricing, inspect a version, preview a week, quote or replay | Read-only; no supplier call, price activation or budget write |
| Create, copy, import or save a draft | Changes draft storage only; active prices do not change |
| Publish or roll back a price | Creates an audited price/catalog change for new admissions |
| Apply FX or admission policy | Separate, confirmed catalog change for new admissions |
| Edit a book's owner label | Responsibility metadata only; not permission, notification or price activation |
| Migrate pricing storage | Schema operation, not activation of every model's prices |

Work in the intended authenticated workspace. Viewers inspect and simulate;
admins edit authorized resources. Global changes additionally require global
administration. A workspace selector or a responsibility label does not grant
access. If the page reports missing pricing storage, ask the deployment operator
to review the explicit migration plan; opening the page never initializes it.

## 2. Create a reviewable draft

1. Open **Pricing**, or use **Advanced pricing** from a node/model. Choose the
   intended scope and create a token, image, audio, video or rerank price book.
2. Set a recognizable name and responsibility label. Keep reasons and references
   concise; do not paste credentials, customer text or full contracts into them.
3. In **Base & cache**, choose the native currency, money precision/rounding and
   price source. Record the contract/reference identity and verification date.
   Reference-only content is not an approved runtime tariff.
4. Select billed dimensions before entering rates. A rate has an amount and a
   unit size: `1 / 1000000 tokens` is different from `1 / token`. Keep amounts as
   decimal strings; the UI handles locale display separately.
5. Configure the other editor sections, then **Validate** and **Save draft**.
   Validation is not publication, proof of supplier support or invoice approval.
6. Use **Simulate & compare** with explicit synthetic quantities and inspect the
   selected rules, units, original/report amounts and diagnostics. Changed inputs
   invalidate the previous result. Compare against a published version before
   opening its publication dialog.

Blank, inherited and explicitly free are different. Use the explicit-free control
for a zero rate; do not clear an input to make it free. An empty later rule leaves
earlier groups' rates unchanged but cannot supply a missing base rate.

## 3. Base tokens and cache pricing

Ordinary input means **uncached input**, not total prompt tokens. Configure output,
cache reads, generic cache-write remainder, five-minute writes and one-hour writes
only when the adapter/contract provides those distinctions. Total input selects
context tiers; it is not another billable component. Reasoning tokens are a subset
of output, not an extra output total.

Synthetic checks, with all token rates quoted per million:

| Quantities and rates | Expected native amount |
| --- | ---: |
| 1000 input, 500 output; input 1, output 2 | USD 0.002 |
| Total input 10000: read cache 4000, 5m writes 1000, 1h writes 500, uncached 4500; rates 0.1 / 1.25 / 2 / 1; no output | USD 0.00715 |

The write total in the second example is 1500, decomposed into its TTL children;
it is not billed again. Do not substitute zero for an absent provider counter or
invent TTL attribution. The cost detail's normalized evidence tells you what was
observed, estimated, missing or unsupported.

## 4. Long context, rule ordering and inheritance

In **Context tiers**, enter inclusive minimums and exclusive maximums. A blank
maximum is unbounded; a blank minimum is invalid. The supported mode is
**whole-request tiers**. Progressive/excess-only billing is not enabled.

For a synthetic contract that changes price strictly above 272000 total input
tokens, create these alternatives in one group:

| Total input range | Input / 1M | Output / 1M | Amount with 1000 output tokens |
| --- | ---: | ---: | ---: |
| `[0, 272001)` | USD 1 | USD 2 | At 272000 input: USD 0.274 |
| `[272001, unbounded)` | USD 2 | USD 3 | At 272001 input: USD 0.547002 |

Cached input still contributes to the threshold. Configure each changed rate
explicitly; changing the input rate does not automatically change output/cache
rates. The rule table is paginated; off-screen rules remain part of validation.

Groups apply in order. Within a group, the highest-priority matching rule wins;
ambiguous equal-priority overlap is rejected. **Replace** removes the earlier
components for that dimension. **Add** creates another explicitly billed component.
Do not mix add and replace for the same dimension in one rule; use separate,
ordered groups and inspect the simulator's expanded fees. Explicit combined-media
permission does not permit token parent/subset double charging.

Price selection and parent inheritance are separate:

- A node/model override can outrank a model default or catalog fallback. Inspect
  the effective source, operation and bindings; an active book need not win.
- An inherited child pins an accessible parent **book, version and hash**. A later
  parent publication does not update that child. Use its dedicated inheritance
  controls for component/group/calendar overrides; currency remains the parent's.
- Copy/import is not a live subscription to future source prices. An inherited
  export requires the exact accessible parent on the destination installation;
  the importer does not silently approve or replace it.
- Removing a legacy node override removes all its legacy price fields, including
  hidden cache/media prices, but not its capabilities or a separate advanced
  binding. Editing an unrelated node field must not create a price override.

See [inheritance](pricing-inheritance.md) and [model status](pricing-model-status.md).

## 5. Peak/off-peak and service variants

In **Time & service**, enable a versioned calendar and choose its named timezone,
timezone-data version, coverage dates and fallback tag. Enter weekly windows,
holiday exceptions and explicit date overrides, then select the matching tags
on the price rules. The order is date override, holiday, weekly window, fallback.
Cross-midnight windows include their permitted next-day carry; endpoints use
half-open intervals. Check both sides of every boundary.

Use **Normalized calendar week** to review the final seven-day schedule, including
overrides and carry. It is a civil-clock view, not elapsed usage or a DST billing
measurement. Days outside coverage are unavailable, not automatically off-peak.
The gateway does not fetch a holiday schedule on each request. Maintain coverage
by reviewing and publishing a new calendar-bearing price version.

Dispatch time is the default pricing clock. A provider-accepted or completion-time
contract needs explicit publication/rollback review. Missing provider timestamps
remain missing; the gateway does not substitute a cheaper clock. Requests/tasks
keep their admitted price/calendar version even when the selected event occurs
later. A continuous session is not automatically split at a tariff boundary.

Enter actual service-tier identifiers, such as `default`, `priority`, `flex` or
`batch`, and explicit applicable rates. These are not universal aliases or
automatic multipliers. Resolved provider tier evidence takes precedence; absent
evidence retains the requested/default basis. Check metering and contract warnings
for every target, not only the model's display name.

## 6. Images, audio, video and mixed fees

Choose the quantity the contract actually bills:

| Contract basis | Typical dimension | Important distinction |
| --- | --- | --- |
| Successful image outputs | `image_count` | Not automatically requested `n` |
| Requested image quantity | `requested_image_count` | Only for an explicit requested-quantity contract |
| Measured audio duration | `audio_input_seconds` / `audio_output_seconds` | Supported evidence/PCM WAV measurement; not HTTP latency |
| Speech characters | `text_characters` | Unicode code points, including whitespace; not bytes |
| Actual video duration / generation count | `video_seconds` / `video_generation_count` | Not silently replaced with requested duration/count |
| Requested video quantity | `requested_video_seconds` / `requested_video_generation_count` | Separate declared billing basis |
| Invocation base fee | `request_count` | No fee unless a component explicitly declares it |
| Rerank work | Request, processed-document or search-unit dimension | Returned `top_n` is not processed-document count |

For four requested images but three successful outputs at synthetic USD 0.04 per
image, actual-image billing is USD 0.12; requested-image billing is USD 0.16.
Select one appropriate basis, not an accidental charge for both.

Media size, quality, resolution, frame rate and audio track can affect rule
selection. In **Multimodal**, distinguish adapter-derived attributes from an
explicit model-fixed contract. A fixed size does not invent an output count.
Conflicting provider evidence remains diagnosed, not silently priced as fixed.
Review source/adapter declarations before publication. A successful review does
not certify every supplier's support or enable an arbitrary vendor webhook.

An async job's accepted/pending status is not settled cost. Inspect provider state,
delivery state, reservation and accounting state separately. Success followed by
download failure can still incur a fee. Use the documented authenticated supplier
events/polling/recovery workflow; do not resend unknown work to make a missing
receipt disappear. Realtime and embedding batches have dedicated accounting
lifecycles; their physical/group costs must not be added again to member shares.

See [media metering](pricing-media-metering.md), [specification authority](pricing-media-specification.md),
[supplier events](pricing-media-supplier-events.md), [batch accounting](pricing-batch-runtime.md)
and [Realtime](pricing-realtime.md).

## 7. Quantity rounding, minimums and FX

Unit conversion, quantity rounding and final money rounding are independent.
Synthetic 61-second audio at USD 0.06 per 60 seconds costs USD 0.061 when prorated.
An explicit upward 60-second quantity step bills 120 seconds and costs USD 0.12.
A positive minimum applies before step rounding and cannot be defeated by rounding
down. **Known zero usage does not trigger a minimum**; an independently declared
request fee can still apply. Missing usage is not known zero.

Exact component fractions are added before final monetary rounding. Displayed
rounded lines can differ from the rounded total; inspect the recorded rounding
adjustment instead of adding a new fee to force equality. Historical details show
the original policy, not the current price book's settings.

Set the book's native currency and configure **Persistent FX** separately. The
current reporting/budget contract uses USD. A synthetic CNY-to-USD numerator `1`
and denominator `7` converts CNY 0.0084 to USD 0.0012. Missing FX preserves the
native amount and leaves the USD amount unknown, not zero.

FX editing replaces the selected scope's entire schedule: retain required existing
intervals, use offset-bearing timestamps, preview overlaps/coverage, and confirm
with a reason and current revision. Simulation-only FX does not save that schedule.
Price publication checks its proposed interval against current FX coverage; an
acknowledged gap does not supply a rate. Global prices cannot rely on one private
workspace's FX coverage. Admitted requests/tasks and history keep their frozen FX.

## 8. Publish, schedule or roll back

1. Validate and save the intended draft. Review scope, source, units and simulation.
2. Open **Publish**, select exact node/model/operation targets and offset-bearing
   effective timestamps. The interval is `[from, to)`; an omitted end is unbounded.
3. **Preview impact**. Review replaced bindings, metering availability, conditional
   measurements, FX gaps and any non-default pricing-clock contract confirmation.
4. Resolve errors. A supplier-support warning is not automatic approval. If you
   knowingly accept an allowed FX gap, confirm its unknown-USD consequence.
5. Enter the reason and separate confirmation, then publish once. Editing the
   proposal invalidates its preview/consent. Verify the recorded version/bindings.
6. In the approved environment, validate new requests and inspect their retained
   price/FX identifiers. Previously admitted work and history must remain unchanged.

Cancel an unwanted future schedule explicitly. A conflicting activation interval
needs cancellation/rescheduling, not repeated refresh. Rolling back republishes
the selected old content as a new version after preview/confirmation; it is not a
database downgrade and does not rewrite already-recorded costs.

On a revision conflict, keep the draft, compare/reload and review before retrying.
On an ambiguous write/network result, reread recorded state before another
publication. For recovery/correction workflows, use their preserved proposal ID
and exact retry/acknowledgement process; never invent a second financial action.

## 9. Choose budget behavior separately from price

Changing a tariff does not reset or opt into a new budget policy. Select the
policy's scope and operation, preview the effective old/new choices, then confirm.

| Admission mode | Meaning |
| --- | --- |
| Compatibility | Preserve legacy behavior; missing price/FX is explicit, not free |
| Reject unpriced | Require an applicable approved price/usable estimate; this is not a proven maximum |
| Reserve upper bound | Require finite supported quantity bounds and a conservative frozen-price envelope |

Declared limits are conditional contract assertions, not measured usage or an
unconditional supplier spend guarantee. Check retry allowance, service/calendar
variants, cache partitions, minimums and FX in **Admission simulation**. Actual
usage exceeding a declared limit is still recorded truthfully.

The accounting basis is another choice: absent/`legacy_logical` preserves logical
request budgeting; explicit `actual_upstream` counts the complete paid-attempt
cohort, including paid failures/retries. Unknown expenses retain unresolved holds.
Actual mode requires a supported explicit operation, not an all-operation guess.

Policy inheritance selects a whole policy: workspace operation, workspace default,
global operation, global default, then compatibility. Removing an override inherits
the next policy, which may be stricter. Clearing only a field is not field-level
inheritance. Admitted work retains its original policy and budget epochs.

For eligible non-token media/rerank/Realtime tariffs, actual mode can explicitly
select `token_budget: not_applicable`. The frozen book must contain no token billing
dimensions, including free ones. All monetary scopes remain enforced. Otherwise
keep reported-token requirements; missing counters must not be replaced by zero.
See [admission policy](pricing-admission-policy.md), [actual budgets](pricing-actual-budget-runtime.md)
and [non-token eligibility](pricing-non-token-budgets.md).

## 10. Inspect and reconcile without repricing history

- Open **Request Logs → Cost details** for normalized/billed quantities, component
  rates, selected rules/version, time/service/media, original FX and rounding.
  `priced` means locally calculated, not supplier invoice confirmation.
- Keep complete totals, estimates, known subtotals and unknown/pending costs
  separate. A missing total is not zero. Historical simulation is a separate,
  read-only result; it never overwrites the original receipt or budget.
- For local cache, distinguish new supplier cost, logical budget use and the
  frozen counterfactual reference. Provider-cache reports use stored comparison
  evidence; absent historical baselines cannot be repaired with today's rates.
- **Cost coverage report** scans an explicit UTC interval. Continue until no next
  cursor if a complete bounded scan is needed. The export is a scanned summary,
  not every row, an invoice or a single point-in-time financial close.
- For unresolved holds/receipts, use the appropriate budget recovery, missing-usage
  or retained-evidence view. Inspect first; admins preview and confirm a scoped
  action. Never delete ledger rows, erase a hold or rerun a supplier request merely
  to clear an error. Corrections retain original evidence and explicit deltas.

See [cost reports](pricing-cost-report.md), [request details](pricing-dashboard.md#request-cost-evidence),
[budget recovery](pricing-budget-recovery.md), [usage recovery](pricing-usage-recovery.md)
and [retained evidence](pricing-outcome-disposition.md).

## 11. Change-review checklist

- [ ] Correct environment, workspace, administrator and responsibility label.
- [ ] Confirmed model contract/source; explicit units, cache partitions and free/missing states.
- [ ] Threshold, timezone/coverage, service-tier and media-source boundary simulations reviewed.
- [ ] Quantity minimums/rounding, native currency, USD FX and budget basis reviewed separately.
- [ ] Draft validation, metering warnings, target bindings and activation intervals reviewed.
- [ ] Reason, current revision and fresh confirmation recorded; uncertain writes resolved before retry.
- [ ] New admitted requests select the intended version; in-flight/history remain on their originals.
- [ ] Unknown usage/FX and pending holds remain visible rather than coerced to zero.

For code/schema rollout, consistent backups and rollback limits, use the separate
[database recovery](pricing-database-recovery.md) and [Rancher rollout](pricing-rancher-rollout.md)
procedures. This guide is not permission to execute them.

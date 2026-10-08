# Pricing admission and reservation evidence

Status: candidate implementation, not deployed. This closes the policy/API and
conditional rate-envelope gap; it does **not** complete all M3 accounting, metering
coverage, frontend or deployment acceptance gates.

## Budget accounting basis and Dashboard impact preview

The admission mode is separate from `budget_basis`. An omitted basis preserves
legacy policy hashes and logical-request accounting. Explicit `legacy_logical`
records the same accounting choice; `actual_upstream` counts the confirmed paid
attempt cohort, including paid failures, while local cache uses supplier zero
and unknown expenses retain their holds.

The Dashboard policy editor now has an explicit basis selector, current-policy
display and before/after effective-basis preview. Preview and publication still
require the catalog revision, reason and explicit confirmation. An unrelated
limits edit preserves the existing explicit basis; leaving an old basis absent
does not silently add it to a normalized historical policy.

Inheritance selects a **whole policy**, in this order: workspace+operation,
workspace-wide, global+operation, global-wide. A workspace-wide compatibility
policy with no `budget_basis` therefore uses legacy accounting even if a global
operation policy selects actual expenses. Remove the whole override to restore
inheritance; clearing just the basis means the legacy default. The effective
impact preview shares the same pure selection function as the catalog resolver.
Global previews describe behavior before workspace overrides, not a claim that
every workspace will change.

The standalone admission simulator also accepts the selected basis as part of
its hypothetical override and displays the server-returned basis. That optional
assessment field participates in the response digest and must match an explicit
scenario override. It does not change the meaning of a hypothetical quote into
a final supplier expense, publish a policy, or alter a budget. Existing/in-flight
requests and historical records retain their original snapshots.

The selector offers actual expenses for the integrated text/embedding, image/video,
audio, rerank and native Realtime operations. Realtime retains separate
[session and generation custody](pricing-realtime.md#actual-upstream-policy).
An explicit Realtime operation may also declare
[`realtime_transcription`](pricing-realtime.md#independent-input-transcription).
Its fixed ASR model uses a separately published `audio_transcription` tariff and
actual-upstream upper-bound policy, with a separate reservation. The Realtime
token-budget choice does not override the ASR contract. The simulator displays
both reservations and their combined total without applying either.
The shared operation list is an implementation boundary, not evidence that all
batch/media lifecycles or their final acceptance gates are complete. The explicit
[non-token option](pricing-non-token-budgets.md) excludes token holds only for an
eligible frozen tariff, without bypassing monetary budgets.

## Three explicit modes

| Mode | Behavior before a paid attempt |
| --- | --- |
| `compatibility` | Default when no policy is configured. Preserve legacy routing/budget behavior, permit missing prices/FX, and label the cost/estimate unknown instead of claiming free usage. |
| `reject_unpriced` | Require an applicable published binding and a usable estimate for the requested variant. No implicit legacy-price fallback. The reservation is still an estimate, not a proven maximum. |
| `reserve_upper_bound` | Additionally require a finite quantity bound for every billed dimension. Reserve a conservative envelope over the frozen book's possible rules and attempt allowance. Missing bounds/FX/unsupported variants reject before dispatch. |

A computed reservation is not a supplier invoice and is never substituted for known
final usage. A missing amount is distinct from an explicitly free rate. Pure pricing
calculation failure stays unknown in compatibility mode and is refused in strict
modes, rather than causing a second paid call or silently reserving a known zero.

Policies live inside immutable catalog revisions. They are captured at admission
with the price/FX bindings, not read from the current policy during settlement.
Workspace entries override global entries; an operation-specific entry overrides a
generic entry within the same scope. Removing an entry inherits the next applicable
entry/default; it does not necessarily disable a stricter global policy.

The policy registry includes Chat Completions, Responses, Messages, the existing
Gemini generate-content identifier, embeddings, rerank, image generation/edit/
variation, audio transcription/translation/speech, video generation and native
Realtime. Use the existing canonical source-format names; a policy identifier
does not create a new public ingress route. The actual-upstream and non-token
choices use their narrower explicit operation lists, described above. Embedding
batch members use their operation's captured policy and the dedicated
[physical-batch lifecycle](pricing-actual-batch-runtime.md), not an invented generic
batch operation. Unknown operations are rejected by the policy API.

## Where a quantity bound comes from

1. **Exact request quantity:** an explicitly request-billed image count/duration,
   speech code-point count, or input-document count. It must be present, observed and
   extracted from request metadata/local measurement, not a tokenizer heuristic.
2. **Single invocation:** at most one request per dispatched attempt; rerank request
   counts are only inferred for the rerank operation.
3. **Administrator-declared supplier limit:** a decimal-string quantity plus an
   explicit `limit_reference`. This must describe the supported provider/contract's
   limit, not the amount an operator hopes to spend. A workspace/operation policy's
   limits must cover all eligible targets in that scope.
4. **Parent limit:** each cache/uncached input partition is bounded by the declared
   total-input limit; output partitions are bounded by total output. The selected
   bound records the parent relationship.

Requested image count is **not automatically an upper bound on reported output**;
requested video/audio duration is not an actual-duration cap. A token estimate is
not promoted to an observed token count. Actual-unit media contracts therefore need
appropriate approved limits if no stronger evidence is available. Explicit request
quantities and `max_tokens` exceeding their configured limits are rejected, but a
heuristic input-token estimate is not falsely presented as proof of a limit breach.

The response labels the guarantee `conditional_on_declared_limits`. It is conditional
on the declared supplier quantities and supported frozen tariff/variant/calendar
domain being accurate. This is not an unconditional spend ceiling or a guarantee
that a remote provider cannot violate a contract. Limits cannot manufacture a price
for an unsupported service tier or a missing FX rate. They do not prove adapter
coverage, actual invoice reconciliation or the validity of an expired calendar.

## Rate-envelope calculation

The `nonnegative_rule_envelope_v1` algorithm uses the same component calculation as
actual pricing: quantity minimum, quantity rounding, exact decimal/fraction rate and
unit denominator. All configured rates and multipliers are nonnegative.

For each dimension, maintain an upper cost through the ordered rule groups. Evaluate
each possible group's replace/add/multiply operations against the preceding envelope,
then keep the maximum. Retain the incoming envelope conservatively for optional or
unmatched groups. A context-tier rule whose minimum exceeds the per-attempt input
cap is unreachable and excluded. Time/service/media alternatives are not assumed
to stay at today's cheapest rule. Finally sum dimension envelopes, apply the frozen
FX rational and round **outward** at the book's money precision.

Each component calculation is monotone in its nonnegative quantity. Replacing,
adding and multiplying by positive factors preserve an upper bound, so the group
maximum bounds every declared reachable path. Independent dimension maxima may
combine mutually exclusive scenarios; that deliberately over-reserves instead of
claiming to calculate the tightest possible maximum. Cache partition minimums and
rounding can make a simple “all uncached” estimate unsafe; all billed partitions are
included in the envelope.

The per-attempt bound is multiplied only **after** rule calculation. Retry allowances
do not move a request across a context-tier threshold. Strict-mode allowance includes
outer retries and the node's configured enabled credential attempts. That credential
allowance is passed to the provider client and remains capped if the pool grows after
reservation. Priced image/video generation retains its single-attempt protection.
The internal compatibility replay shares this allowance rather than resetting it.
[Physical credential-attempt receipts](pricing-attempt-attribution.md) are now
implemented; priced batching/allocation and full adapter coverage remain open.

## Actual settlement and excess evidence

Known actual costs settle normally, even when greater than the reservation. They are
not clamped, dropped, or turned into a retry. Immutable receipts and linked correction
semantics remain unchanged. Unknown usage retains the separately labelled logical
budget fallback rather than being declared free.

Dashboard cost-summary reservations include:

- `admission`: mode, policy hash/source, frozen catalog, decision, quantity bounds,
  per-attempt allowance, attempts, envelope and diagnostics;
- `known_cost_overrun_usd`: positive excess of known effective receipt subtotals over
  the original hold, otherwise zero. It is a known lower bound, not proof that unknown
  attempts incurred no excess;
- `observed_limit_excesses`: provider-observed quantities above the retained bounds.
  Tokenizer heuristics are not emitted as confirmed supplier-limit violations.

Cost and logical-token budget remain separate. Cost bounds do not magically prove a
logical-token bound on media for which token usage itself is unavailable. Post-commit
notifications and broader coverage/report UI remain separate incomplete Goal work.

## Administrative API

All paths start with `/api/dashboard/pricing`. Existing Dashboard authentication,
workspace membership, JSON-only writes, trusted-origin checks and RBAC apply.

| Operation | Contract |
| --- | --- |
| `GET /admission-policies` | Scoped entries, compatibility default and catalog head revision. |
| `POST /admission-policy/preview` | Admin-only read-only validation of the same publication body; checks CAS, scope and limits, returns the previous/proposed override without writes. |
| `PUT /admission-policy` | Administrator; `catalog_revision`, `reason`, literal `confirm: true`, `scope`, optional `operation`, and `policy`. `policy: null` removes that exact scope override. |
| `POST /admission-preview` | Viewer-readable pure simulation using `target`, metering `evidence`, optional `context`, `attempts` (1–1000) and optional proposed `policy`. No provider call, budget mutation, request snapshot insertion or policy publication. |

Policy publication, catalog-head CAS and audit are atomic. Stale revisions return
409. Global edits require global administrator authority. Workspace IDs and roles
are not accepted from the request body. A proposal preview identifies its assessment
as `policy_source: "simulation_override"`; ordinary captured policies use `catalog`.
A price publication preserves existing admission policies. Existing catalogs without
this optional field retain their original normalized content/hash; no SQL schema
change or automatic startup migration is introduced by this feature.

Synthetic example, **not supplier defaults**:

```json
{
  "catalog_revision": 4,
  "scope": "workspace",
  "operation": "chat_completions",
  "reason": "Approved synthetic limits for isolated testing",
  "confirm": true,
  "policy": {
    "mode": "reserve_upper_bound",
    "quantity_limits": {
      "total_input_tokens": "100",
      "output_tokens": "40"
    },
    "limit_reference": "Synthetic supplier limit fixture"
  }
}
```

Actual admission denial returns structured HTTP 422, including on streaming ingress
before SSE headers are flushed. Codes are `pricing_admission_unpriced`,
`pricing_reservation_bound_missing` and `pricing_reservation_limit_exceeded`.
Public callers receive diagnostic paths/codes, not private contract references or
full rate envelopes. Full explanations are Dashboard-scoped.

## Verification and remaining boundaries

Synthetic tests enumerate input/cache partitions, context thresholds, time windows,
service tiers, media rounding and FX. SQLite/PostgreSQL repository tests cover scoped
publication, concurrent CAS, audit rollback and historical policy restoration. HTTP
tests cover no-binding rejection, stream/error protocol behavior, missing FX, media
caps, frozen in-flight policy, pool growth, overrun settlement, pure/proposed preview
and administrative permissions.

The [Goal Spec](pricing-engine-goal-spec.md) remains the full acceptance authority.
The [progress record](pricing-engine-progress.md) identifies unfinished metering
coverage, complete retry/batch attribution, writer/alert coordination, frontend,
retention/performance and candidate-delivery gates. No production policy, limit,
configuration or price is activated by these tests.

## Dashboard configuration

The candidate [pricing Dashboard](pricing-dashboard.md) can manage every mode and
optional approved per-attempt limit without editing YAML. It starts from the exact
scope/operation override, not an inferred supplier cap. Blank limits stay absent;
source references and precise decimal strings survive edits. Deleting an override
means inheritance, not necessarily compatibility. The UI shows policy precedence
and all visible scoped overrides, validates the proposal read-only, and requires
a reason and separate confirmation before publication. The read-only
[admission simulator](pricing-admission-simulation.md) now exposes the same
quantity/target assessment, explicit proposal provenance, bounds and conditional
guarantees without changing the effective policy or making a provider call.

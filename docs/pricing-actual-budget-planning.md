# Actual-upstream budget planning — internal foundation

**Foundation, not the complete budget-policy feature.** Existing policies remain
legacy when the new field is absent. A later [text-runtime prototype](pricing-actual-budget-runtime.md)
now connects explicit opt-in policies to closed-cohort settlement for the existing
Chat Completions, Responses and Messages ingress paths. Other lifecycle and UI
work remains unfinished. The pure decision model and internal read-only comparison
described here do not by themselves complete the budget-basis requirement in the
[pricing Goal](pricing-engine-goal-spec.md).

## What the planner does

An actual-upstream budget plan groups immutable effective receipts by one request,
workspace and reservation. It sums every known provider attempt, including failed
and retried attempts, instead of charging only a successful logical winner. It
never fetches current prices, exchange rates or provider data.

- A proven local-cache zero has zero supplier cost and zero supplier tokens;
  the original logical-use receipt is unchanged. Nonzero local/synthetic charges
  remain unclassified rather than being silently treated as supplier expense.
- A validated physical-batch share contributes its allocated share only, not the
  nested full physical total again. Its `allocated_physical_receipt` label remains
  distinct from a per-member supplier measurement.
- Token totals use the input/output parents, not cache, modality or reasoning
  subsets again. Missing counters stay missing; estimates are not promoted to
  observed totals. No tokens are invented for a per-image or per-second tariff.
- Unknown, in-flight and estimated expenses prevent a complete decision. A valid
  observed partial receipt may preserve its reported known subtotal, but does not
  make the entire cost known. Legacy estimates remain unresolved, not corrupted.
- Dispatch finality is separate from the current sample. An empty list while
  dispatch is still open does not prove a final zero. Only a future fenced caller
  can establish that no more paid attempts can begin.
- Without a retained token-budget requirement, a cost-only plan may be ready while
  its token total is unknown. With an original token hold, missing required token
  evidence prevents completion. This is an internal representation, not a new
  user-selectable default or permission to remove existing token limits.

`ready` means the internal evidence is sufficient for the represented calculation,
not that a transaction has been applied, a supplier invoice is reconciled, or the
caller is authorized to change budgets. Known failed expense produces a commit
proposal rather than an automatic release. The planner performs no writes.

## Corrections and evidence identity

Each contribution retains the attempt and cost hashes, original outcome, price/FX
identity hash and evidence classification. A correction compares the complete
cohort: changing a failed attempt does not replace the successful attempt's share
or the entire request budget. Cohort membership, scope, original outcomes and
frozen price/FX identity cannot be replaced by a correction.

Hashes detect mismatched bytes but are not authorization. The correction planner
also rechecks derived totals and state rather than accepting a hand-edited total
merely because a caller computed a new hash. New missing evidence produces no
applicable delta. Monetary values remain exact decimal strings; token counts must
be nonnegative integers, with bounded aggregate precision.

## Internal storage comparison

`CostLedgerService.previewActualUpstreamBudget` is not connected to an HTTP route
or runtime settlement path. It returns `read_only: true` and
`activation_available: false`, along with the existing basis/state and the proposed
plan. It reads original receipts and verified linked adjustments under the same
request-first transaction fence used by writers. It derives the token requirement
from retained original holds, not today's mutable budget-rule list.

The reader bounds attempts to1024, correction/application histories to4096rows
and stored receipt/history payloads to8MiB. Byte-size projections run before full
body hydration. Scoped ownership, receipt hashes and adjustment-chain integrity
are checked; corruption is rejected, never repaired by a read. SQLite WAL/FULL
and isolated PostgreSQL tests verify reconstruction with a fresh service, scoped
reads, exact corrections and unchanged database contents.

## Still required before activation

1. Complete the versioned opt-in policy across all required lifecycles and UI,
   preserving legacy behavior and historical hashes when the field is absent.
2. Connect actual-cost decisions to atomic or durably recoverable budget settlement
   across synchronous/SSE retries, fallback/races, cache, physical batches and media
   task lifecycles. Do not settle before verified dispatch closure.
3. Define and test pending unknown/estimated expenses, required token evidence,
   late receipts, corrections, old-period resets and operator recovery. The
   existing logical-winner recovery UI must not silently override this policy.
4. Add administrator scope/CAS/confirmation/audit and seven-language configuration,
   preview and evidence views. A UI selector without matching settlement behavior
   is not completion.
5. Run the original full acceptance and performance gates before candidate review.

The subsequent runtime prototype adds isolated migration016 while preserving
001–015. That is not authorization to migrate production or change any production
policy, provider rate, service or deployment. Keep the incomplete integration
status explicit until every original requirement is implemented and verified.

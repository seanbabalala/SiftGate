# Local cache: expense, budget and reference savings

A local cache hit makes no provider request. Its immutable supplier receipt is
therefore explicitly zero. This is separate from the administrator's recorded
budget policy:

- `legacy_logical` retains logical returned tokens and the compatible logical
  cost in the budget.
- `actual_upstream` charges no supplier expense or supplier tokens for that hit.

The request detail shows both these facts and a third, **hypothetical reference
savings** value. The reference is the logical-usage estimate saved for that
cache-hit request, using its frozen catalog and any captured legacy fallback. It
is not a newly calculated current-price quote, a confirmed vendor discount, a
budget credit or cash returned to the company. It is not a prediction of which
node or service tier a cache miss would actually have used.

## Original evidence, never current-price reconstruction

For a single terminal local-cache attempt without adjustments, the ledger may
return `local_cache_reference`. This optional projection contains the fixed price
version/hash, FX version, logical token quantities, reference USD amount and
hypothetical savings USD amount. Monetary and token values are decimal strings.
The basis is `frozen_request_logical_estimate`.

The projection validates the saved estimate's allowlisted shape and its immutable
price/quantity metadata against the retained zero-supplier receipt, then checks
that the same estimate reproduces from the original request catalog. Reproduction
is only an integrity check; it does not replace recorded amounts, create snapshots,
change a budget or contact a provider. Short read transactions are used where a
catalog restore requires one; normal non-cache summary reads are unchanged.

Because the verified supplier amount is zero, a complete reference estimate and
its hypothetical savings have the same amount. A **known reference of zero** stays
zero. Missing price, missing FX or unverifiable original evidence yields unknown
savings instead of an invented zero. Invalid reference evidence does not hide an
independently valid zero-supplier receipt.

The older `cost_without_cache_usd` log field remains historical legacy metadata.
New-engine records deliberately do not populate it from current prices; it is
not substituted for the frozen reference. Provider expense reports continue to
aggregate supplier receipts, never reference savings. Publishing a different
price does not change historical cache references.

## Verification boundary

Synthetic tests compare both budget policies with a paid USD reference, an
explicitly free reference, and a CNY reference without USD conversion. The same
scenarios cover actual HTTP requests, one provider call followed by a local hit,
original-price quotes, retained receipts, report rows and later price publication.
Browser checks compare those references with the actual simulator and render the
three separate accounting concepts in all seven dashboard languages.

This is an isolated development candidate, not deployment approval. Broader Goal
acceptance, performance and final database rollback verification remain separate.

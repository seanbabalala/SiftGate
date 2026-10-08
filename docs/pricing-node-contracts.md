# Node-specific contracts for the same model

Two providers can expose the same routing model with different negotiated prices.
Publish each price book with a **node-level binding**, specifying both the node
ID and model, rather than replacing the shared model-wide default. Select the
operation too when the contract applies only to one API family.

In the pricing editor, prepare and validate each contract, inspect its simulation,
then publish to its intended node/model target. Publication uses the current
catalog revision; conflicting administrator changes are not silently overwritten.
See [Dashboard pricing](pricing-dashboard.md) and [price inheritance](pricing-inheritance.md).

## Dispatch and fallback

The admitted request fixes a catalog snapshot. Each physical attempt selects the
contract for its actual routing node and model inside that snapshot. An upstream
wire alias or provider-reported model remains separate dispatch evidence; it must
not accidentally select another node's contract.

A failed attempt can still have observed supplier usage and a calculable expense.
Its receipt stays separate from the successful fallback receipt. The request's
known upstream cost includes both. Legacy-logical budget settlement and the
explicit actual-upstream policy remain distinct; accurate cost reporting does
not silently change the selected budget policy.

## Synthetic worked example

These are test rates, not vendor prices. Both nodes route the same logical model.
Each attempt reports1,000 uncached input tokens and100 output tokens.

| Contract | Input USD / million | Output USD / million | Attempt expense |
| --- | ---: | ---: | ---: |
| Node A | 1 | 2 | 0.0012 USD |
| Node B, original | 3 | 4 | 0.0034 USD |
| Node B, newly published | 30 | 40 | 0.034 USD |

While A is executing, an administrator publishes B's new contract. A then fails
with observed usage and the request falls back to B:

- B's in-flight attempt still uses its **original** contract:0.0034 USD.
- The complete recorded upstream expense is0.0012 +0.0034 = **0.0046 USD**.
- Legacy-logical budgeting commits the successful attempt's0.0034 USD. Explicit
  actual-upstream budgeting commits the observed0.0046 USD across both attempts.
- A later request explicitly targeting B uses the new contract: **0.034 USD**.
- Viewing the earlier request still shows0.0046 USD and its original version IDs.

The request-cost page exposes each node/model, wire model, receipt, quantity/rate
lines and original price source. Historical simulation can compare the retained
usage with a selected newer contract, but displays the result as **not applied**.
It does not rewrite receipts, budgets or active prices. Applying one selected
price book to historical attempts is a hypothetical comparison, not a claim
about the original contracts or a supplier invoice.

## Verification scope

The same synthetic scenario is tested through actual isolated HTTP publication,
quotes, JSON/SSE model ingress, paid failure/fallback, logs and the cost-report API
under both budget policies. A separate actual-budget SSE fixture verifies the
Dashboard in seven languages, desktop/light and narrow/dark layouts, including
original-version lookup and rendered original-versus-hypothetical comparisons.
The browser's simulations leave the entire fixture accounting state unchanged
and make no additional supplier calls.

This establishes the named node-contract scenario. It is not proof that all
media/Realtime lifecycle cases, performance targets or final deployment gates
have passed. Production configuration and port2099 are not part of this fixture.

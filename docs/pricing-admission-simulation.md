# Read-only admission simulation

The Dashboard route `/pricing/admission-preview` is available to workspace
viewers and higher, with links from pricing management, its policy panel and the
existing price simulator. It answers a deliberately bounded question: **what does
the effective price-admission policy decide for this hypothetical scenario?**

It does not check remaining budget, actual routing, credentials or provider
availability, and does not authorize a real dispatch. No provider is called, no
reservation is created, and no proposed policy is saved.

## Published catalog versus draft prices

This page uses the catalog, price bindings, calendars and FX effective at the
server's evaluation time. It does not use an unsaved price-book draft or the
manual FX fields of the separate draft-price simulator. It also does not import
legacy YAML prices into the catalog just to make an unknown quote look complete.
Use the existing price simulator to compare draft and published tariffs, or
request-cost replay for historical immutable evidence.

Hypothetical dispatch/acceptance/completion times can select conditions **inside
the currently selected price versions**. They do not select a historical or
future catalog activation. Provider acceptance and completion instants are
optional: absent instants remain absent rather than being copied from dispatch
or request duration. The result identifies the evaluation instant, catalog
revision, policy hash, selected price version and selected rule IDs.

## Inputs and evidence

Choose the model, optional node, integrated ingress operation and a scenario
attempt allowance from1 to1000. The allowance is a simulation parameter, not a
change to the runtime retry configuration or proof that a provider supports that
many attempts.

Quantity rows retain decimal strings, a hypothetical source and a quality label.
Operation templates replace the local rows with a relevant set; a separate
explicit action fills synthetic example values. Additional supported dimensions
can be added without duplicating a row. Blank means unknown, while an explicit
zero remains zero. Missing/unsupported quality sends a null quantity. Heuristic
sources cannot be labelled observed by this form. No prompt, document, media
bytes or provider credentials are input fields.

The template and example do not prove provider metering capability. Values and
source labels entered here are hypothetical. The actual runtime still relies on
its own usage adapters, admission policy and immutable receipts. See
[metering review](pricing-metering-governance.md).

The condition section accepts explicit-offset/UTC timestamps, requested and
resolved service tiers, and allowlisted media attributes. Requested quantities
remain distinct from actual output, durations are not request latency, and
character counts are not UTF-8 byte counts.

## Policy modes and proposed limits

By default the effective workspace/global catalog policy applies. The existing
precedence is unchanged. An explicit **unpublished policy** toggle instead sends
a proposal for this one evaluation, with one of the three existing modes and
optional per-dimension limits plus a reference. Switching the toggle off omits
the proposal entirely; hidden draft values do not affect the published policy.

Declaring a bound requires a reference. It does not verify the provider's actual
contract or impose a hard cap on an upstream service. The result identifies
`catalog` versus `simulation_override` and the relevant guarantee. Missing
bounds/FX remain unavailable. Requested quantities can exceed a declared cap and
be rejected even if the hypothetical tariff quote is known.

## Reading the result

The price-policy decision, per-attempt amount and total scenario reservation are
separate from the scenario quote. A rejection has no applied reservation. An
allowed compatibility decision with unknown pricing is not presented as free.

Quantity bounds show whether they came from an administrator declaration, an
exact request-billed quantity, a parent dimension or the single-invocation rule.
The optional rate envelope exposes exact original-currency fractions, FX identity
and the conditional guarantee. The calculator's outward rounding is not replaced
with browser floating-point arithmetic.

The quote section preserves original and USD report amounts, unknowns, known
subtotals, rate/unit formulas, multipliers, rounding adjustments and normalized
usage labels. In upper-bound mode, missing quantities can use declared limits as
explicitly estimated substitutions. The quote can therefore differ from a
reservation and is never represented as settled supplier cost.

## Scope, integrity and cancellation

`POST /api/dashboard/pricing/admission-preview` still accepts the existing
`target`, `evidence`, `context`, `attempts` and optional `policy` fields. Additive
response fields are `workspace_id`, `target`, `evaluated_at`, `request_hash` and
`response_hash`; the response retains `simulation`, `head`, `cost` and
`assessment`. The hashes cover canonical JSON, not original HTTP byte order, and
are consistency checks, not supplier signatures or authorization credentials.

The UI binds a response to its exact submitted scenario, workspace and target,
checks policy provenance, and verifies reservation multiplication using integers.
It rejects malformed or inconsistent results instead of displaying a successful
admission. Editing a completed scenario marks its result stale. Starting another
evaluation clears the prior result; failures do not leave an old success on
screen. Changing workspace remounts the form and clears the previous result.

Inputs are held while a request is in flight. **Cancel** aborts the client read
and releases the navigation guard; a late response cannot replace a newer
scenario. Unmount also aborts the read. Cancellation does not roll back a server
transaction: this endpoint performs no financial write to undo, and it does not
claim to stop server-side read work already in progress.

## Verification scope

Frontend contracts execute the actual pure backend catalog/admission calculation,
not a second mock pricing engine. They cover exact reservations, declared/parent
bounds, proposal provenance, missing FX/bounds, decimal and evidence validation,
large integer quantities, scope/hash binding, inconsistent replies and seven
locales. HTTP contracts check response identities, viewer scope and unchanged
pricing/budget tables. Browser and fixed-source regression evidence is tracked in
[implementation progress](pricing-engine-progress.md).

The full [Goal](pricing-engine-goal-spec.md) additionally requires remaining
recovery/capacity and accounting coverage, retention, performance, Linux/Docker,
fixed-source candidate packaging and rollback acceptance. This page does not
replace those gates or permit production deployment.

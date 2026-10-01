# Legacy compatibility and selective activation acceptance

This checkpoint verifies the seven original MIG-01 clauses and both MIG-03
paragraphs. It does not close database/platform recovery, the remaining UI work,
performance acceptance or the final candidate. All prices and requests below are
synthetic; the production gateway was not used.

## Original compatibility contract

| Clause | Inspected implementation and passed assertion boundary |
| --- | --- |
| MIG-01.1 | Existing `models_pricing` and complete node `model_capabilities.pricing` objects retain their precedence, explicit zeroes and cache aliases. Shared import/runtime resolution agrees across node contexts. |
| MIG-01.2 | The four-token compatibility formula is checked over 40 deterministic cases with 14-decimal comparison tolerance. Legacy cache inference retains six-decimal JavaScript rounding; the exact-decimal bridge and exceptional excess-fraction handling are documented, not claimed to reconstruct originally exact floats. |
| MIG-01.3 | Media references remain unverified for metering. Suggested token books are unsaved, legacy and review-required; media-only input does not invent token prices or observed quantities. Currency mismatches require review. |
| MIG-01.4 | New price versions/catalogs do not write back to the old configuration schema. Draft save and preview do not activate prices; the common selector resolves scope/node/model/operation precedence. |
| MIG-01.5 | Source, confidence and review metadata survive explicit import or are visibly sanitized. Existing catalog/dashboard/cache/routing tests pass. Historical cache reports no longer replace old costs or absent references with today's prices; this safety correction is not represented as identical to the old erroneous behavior. |
| MIG-01.6 | Additive checked migrations preserve populated versions/balances and existing cost fields. Old zero and positive amounts remain legacy estimates, not newly observed/free receipts. There is no implicit full historical fee backfill. |
| MIG-01.7 | The complete current authentication, gateway-key, protocol/stream, provider and SDK regression remains applicable by exact application/test hashes. New browser checks use a real password session and verify viewer read-only access. |

The primary sources are the
[compatibility resolver](../src/config/legacy-pricing-resolution.ts),
[token adapter](../src/pricing/legacy-pricing-adapter.ts),
[whole-configuration import](pricing-config-import.md),
[cost view](../src/pricing/pricing-cost.controller.ts), and
[report projection](../src/pricing/cost-report-projection.ts).
The private clause map names exact passed assertions and file hashes, rather than
using the presence of those files as proof.

## Selective activation, not migration-triggered rollout

MIG-03's first paragraph is verified by explicit schema/import previews, unsaved
review proposals and scoped activation tests. A migrated database does not itself
activate all model prices. JSON/SSE tests cover exact activation/expiry/gap
boundaries, foreign-scope exclusion and unrelated-model legacy fallback.

The second paragraph is verified by scoped administrator confirmation, revision
checks, invalid-calendar/reference rejection and separately approved FX/policy
updates. The preceding real Dashboard workflow saved a USD0.2 draft while actual
requests still used USD0.4; only publication changed new requests. The same owned
process handled both, with historical costs unchanged. Neither migration nor this
acceptance record authorizes a production restart or first code/schema rollout.
See [the rollout boundary](pricing-rancher-rollout.md).

## Current compiled CLI rehearsal

The actual compiled `pricing-import` entrypoint was run in a fresh private
folder, with explicit synthetic configuration and catalog files and a fixed
evaluation instant. A child-process network/listen guard recorded zero attempts.
Input hashes stayed identical; no database, default config or data directory was
created. Provider connection fields, configured synthetic secrets and unrelated
plugin content were absent from the report. Inherited cache values and confidence/
review metadata were checked directly. The output consists of proposals only;
no price or policy was published by the CLI.

This supplements the existing read-only SQLite/PostgreSQL migration CLI tests.
It is not a new populated-database restore, downgrade or container rehearsal.

## Current Dashboard evidence

One isolated password-authenticated gateway serves the unchanged compiled
Dashboard and mocked suppliers. The 282 browser checks comprise:

- 252 request-detail views: 18 cases, seven languages, desktop/light and
  narrow/dark;
- 14 views after one explicit synthetic video completion;
- 14 report views and actual JSON-summary downloads;
- two additional viewer checks, with no corrective-action controls.

The cases cover all eight cost states, original and newer FX, measured versus
billed quantities, version/rule/calendar/service metadata, media specifications,
local-cache accounting and old legacy amounts. The old CNY request retains its
1/7 conversion after a 1/5 publication; its USD0.901480 amount is not replaced by
the newer request's USD1.262073. Three cache cases retain zero supplier expense
and distinct logical/actual budget policy; a missing frozen reference stays
unknown after FX becomes available.

The video first has USD0.8 reserved, zero committed and an unknown final amount.
One explicit mocked status response reports 6.4 seconds, yielding USD0.64 committed
and no remaining reserve. Its global budget balance changes by minus USD0.16,
not by a second generation charge. No browser operation invokes a supplier.
All 38 pricing/budget/log tables and the configuration hash are identical within
each read-only phase. Only that explicit fixture settlement changes financial
state; unrelated historical requests and price versions remain identical.

Independent decimal arithmetic reproduces the 21-row report: USD2.969553 calculated,
USD0.004 estimated, USD0.7 legacy-only estimates and USD0.001 known partial cost.
These categories remain separate. Eleven requests have calculated coverage,
eight have unknown calculated amounts, and seven still require financial processing.
All seven language exports agree; they are not supplier invoices.

Representative screenshots were inspected. Narrow tables scroll locally without
document overflow. Some full-region capture bounds extended fractionally below
the viewport and were saved as explicitly labelled viewport captures, not claimed
as complete-region images. The initial harness incorrectly expected request size
512 after the supplier explicitly reported 1024; the corrected assertion verifies
provider-result precedence. The application was unchanged, and the failed log and
screenshots remain available.

## UI-04 gap identified at this checkpoint

The current detail view shows measured800 versus billed1000, and monetary rounding
adjustments, but not the **minimum1000 / step500 / ceil** rule in the immutable
original price. The image example similarly shows actual1 billed4 without the
minimum4 explanation. The historical-source panel exposes provenance and lineage,
not those calculation-policy fields.

This display/explanation gap was subsequently resolved by the
[historical calculation-policy view](pricing-calculation-policy.md). It was not a
wrong amount. At this compatibility checkpoint, original UI-04 required
rounding and difference reasons, so it remains partial. The next change should
read the already verified original price version and display the applied minimum,
quantity-rounding increment/mode and monetary policy. It must not infer them from
current rates, reprice history or rewrite receipts just to add a display field.
Legacy/unavailable versions must remain explicitly unavailable.

## Verification identity and limits

No application, dependency, public test or compiled file changed during this
checkpoint. The preceding full **4,229-unit/205-suite and 807-HTTP/65-suite** proof
remains applicable; it was not rerun or counted as a new full suite. Existing
TypeScript SDK tests/type checks and Python SDK tests remain part of that proof.
New evidence is the compiled CLI rehearsal and source-bound browser checks.

All owned browser and gateway processes have stopped. Production2099, including
the user's model edit, is unchanged. There was no commit, push, Docker operation
or deployment. MIG-02, UI-04's explanation gap, remaining original requirements,
the unmet PostgreSQL performance target and final fixed-source delivery remain open.

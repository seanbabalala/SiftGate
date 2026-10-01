# Rule matching and synchronous pricing acceptance

This record maps all original RULE-01, RULE-05 and FLOW-01 clauses to the current
source and passed assertions. There are 20 items: seven matching-order items
(including ambiguous publication), six service/media clauses and seven synchronous
flow clauses. It does not certify arbitrary supplier models, migration/platform
coverage or the unmet HTTP performance target.

## Rule and service/media boundaries

| Original item | Verified boundary |
| --- | --- |
| RULE-01.1 | Admission fixes the catalog. Actual node/model/operation selection and later fallback use that catalog, not a newly published binding. |
| RULE-01.2 | Resolved service-level evidence wins; absent evidence retains the requested/default basis. Both fields remain in the receipt. |
| RULE-01.3 | The selected price's clock and calendar version govern matching. JSON/SSE fixtures cover ordinary boundaries, overnight windows, DST and date/holiday overrides. |
| RULE-01.4 | Normalized total input includes cached subsets. Retry allowance does not multiply the per-attempt tier threshold. |
| RULE-01.5 | Declared fixed/adapter media specifications precede rule matching. Unknown or contradictory values remain diagnosed. |
| RULE-01.6 | Ordered add/replace/multiplier components are expanded and checked for unit and dimension overlap before exact calculation. |
| RULE-01 ambiguity paragraph | Equal-priority overlapping alternatives fail publication; the previous active catalog remains unchanged. |
| RULE-05.1 | Service-level names are explicit strings, not a global fast-to-priority alias. Distinct node bindings may price the same name differently. |
| RULE-05.2 | UI review exposes unsupported extraction, conditional quantities and unverified supplier/model contracts. Missing prices remain unknown, never invented support. |
| RULE-05.3 | Compiler and editor share the media allowlist. Integer dimensions/counts, exact frame rate, audio-track and direction domains are validated. |
| RULE-05.4 | Immutable model-fixed contracts, per-adapter sources and authenticated event provenance are integrated with replay and inheritance. |
| RULE-05.5 | Image counts and image tokens can be chosen separately, or explicitly combined. Token parent/subset double charging stays invalid even with combined permission. |
| RULE-05.6 | Missing/unknown required media values cannot fall through to a cheap unconditional price. Compatible delivery and strict admission retain their distinct missing-price policies. |

The [media specification checkpoint](pricing-media-specification.md) supplies the
actual editor/inheritance/publication/history workflow and seven-language browser
evidence. Its earlier clause-4-only conclusion is not used by itself to promote
an entire family; the remaining five clauses are mapped separately here.

## Synchronous flow

| Original item | Verified boundary |
| --- | --- |
| FLOW-01.1 | Candidate estimates and actual routing use the immutable request context, including media rules rather than unrelated token defaults. |
| FLOW-01.2 | Budget reservation uses actual rule envelopes, costly cache-write partitions and a separate monetary retry allowance. |
| FLOW-01.3 | Each physical attempt is recorded before supplier dispatch, with node/model/credential/time evidence. Later tariff/FX publications do not replace the captured catalog. |
| FLOW-01.4 | Native and converted JSON/SSE paths share normalized evidence; final cumulative usage, malformed counters and disconnects retain their specified semantics. |
| FLOW-01.5 | Costs, budgets and logs derive from retained computations. Explicit legacy logical-cache/winner accounting remains distinguishable from supplier expense. |
| FLOW-01.6 | Independently committed evidence survives application failure. Receipt, budget, intent and acknowledgement changes commit atomically; replay cannot duplicate charges or trigger another supplier call. |
| FLOW-01.7 | Scoped details, reports and historical simulations are read-only and preserve the original receipt and financial rows. |

Primary executable suites include `pricing-catalog.spec.ts`,
`pricing-compiler.spec.ts`, `media-specification.spec.ts`,
`pricing-composed-settlement.spec.ts`, `pricing-outcome-inbox.spec.ts`,
`pricing-conditions.e2e-spec.ts`, `pricing-runtime.e2e-spec.ts`,
`pricing-attribution.e2e-spec.ts`, `pricing-boundaries.e2e-spec.ts`,
`pricing-media.e2e-spec.ts` and `pricing-mixed-currency.e2e-spec.ts`.
The private clause map identifies exact passed assertion names and file hashes,
not merely these filenames. Crash coverage includes real isolated child exits
following retention and after both acknowledgements but before transaction commit,
on SQLite and PostgreSQL.

## Additional compiled contract probe

A new pure probe uses the already built catalog, compiler, quantity normalizer and
calculator, with no database or network. Seven positive/unknown scenarios and two
compilation rejections verify:

- `fast` costs USD0.002 and USD0.007 under two synthetic node bindings;
- absent resolution remains requested evidence, while an unpriced `priority`
  response or differently cased identifier remains unknown;
- two images cost USD0.08, 100 image-output tokens cost USD0.002, and an explicitly
  combined contract costs USD0.082 with exactly the declared components;
- an implicit count/token combination and an output parent/subset combination
  are rejected.

These are synthetic rates, not current supplier prices. The final probe uses the
real quantity normalizer with consistent output-parent and image-subset quantities.
An earlier fixture used a display-unit spelling instead of the contract unit and
failed; that failure and the intermediate fixture are retained, not counted as
accepted evidence. Application validation was not changed to accommodate it.

## Scope of the proof

Application, dependencies, tests and all 1,472 compiled artifacts are unchanged
from the media-specification checkpoint. Its full **4,229-unit/205-suite and
807-HTTP/65-suite** results remain applicable by exact hashes; no new full run is
claimed. The same 70 browser cases remain source-bound evidence for their tested
views, not a claim that every possible workflow was exercised again.

This audit promotes only RULE-01, RULE-05 and FLOW-01. The overall Goal remains
active. PostgreSQL performance, remaining original UI/migration/platform items and
the final fixed-source candidate still require completion. No production process,
configuration, database or deployment was changed; no Git publication occurred.

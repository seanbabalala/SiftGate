# Pricing reference-use and provenance boundary

This report addresses original **REF-01**, not the remaining performance,
platform or final-delivery gates. No deployment, production configuration change
or restart is authorized by this review.

## Reference identity and reuse decision

The reference is the exact relay-saas snapshot
`0070e0c775008ab96aee6a3f1c39b833195647d5`, not that repository's later working
tree. Its license reserves rights and requires prior written authorization for
code reuse. This Goal does **not** infer such permission from repository access
or from the request to compare the products.

The implementation decision is to learn from the reference's component, threshold,
quantity-breakdown and asynchronous-settlement designs, while implementing the
Gateway's own contracts. No reference package, source directory or service is
made a required runtime dependency. Any future direct code reuse needs a separate
authorization review; this report does not grant it.

The Gateway baseline is
`b61d8f48ee184cadd13049687729f8c2e4352b9c`. Its existing MIT license and notices
remain unchanged. Pre-existing similarities between repositories are distinguished
from changes introduced by this Goal; they are not represented as newly copied
reference implementation or as proof of every file's historical authorship.

## What was learned—and what was not assumed

| Reference design lesson | Gateway implementation and boundary |
| --- | --- |
| Separate metering dimensions, rates and unit sizes | Normalized quantities carry units, source and evidence status. Missing usage, unpriced, estimated and explicitly free are distinct. A total and its disjoint subsets cannot be billed twice. |
| Select long-context tiers from total input, including cached input | Explicit integer ranges and whole-request rules use synthetic boundary tests, including272000/272001. There is no model-name heuristic or universal GPT surcharge. Unsupported rule modes are rejected, not approximated silently. |
| Preserve integer precision and quantity/cost breakdowns | The Gateway uses its own reduced rational arithmetic, decimal-string boundaries, separate quantity rounding/minimums and final money rounding. Small lines are aggregated before final rounding; reference integer truncation is not transplanted as a new default. |
| Service-tier variants and conservative preflight estimates | The Gateway requires explicit applicable rules and preserves missing-price diagnostics. A reference fallback multiplier is not treated as a universal supplier policy or automatically enabled. |
| Persist ownership, idempotency and settlement snapshots for asynchronous work | Gateway task/request/workspace associations, immutable price/FX/calendar versions, retained usage evidence and exact budget effects use the Gateway's own ledger and recovery protocol. Retail balances, discounts and sales margins are not imported. |
| Make tier configuration and cost explanations inspectable | The Gateway provides its own draft/publish/preview/replay workflow and seven-language configuration. The reference's pricing editor is not copied into the Dashboard. |

The reviewed snapshot is evidence for these bounded ideas. It is **not** described
as already providing a complete recurring peak/off-peak calendar, every media
specification, or separate cache-lifetime pricing. Those Gateway requirements have
their own implementation and tests; an arbitrary metadata field in a reference
model would not prove that a corresponding pricing rule actually executes.

See [architecture decisions](pricing-engine-decisions.md),
[core contracts](pricing-core-contract-acceptance.md),
[rule-flow acceptance](pricing-rule-flow-acceptance.md),
[media acceptance](pricing-media-acceptance.md) and
[editor acceptance](pricing-editor-completion.md).

## Source comparison and manual review

The review compares1,331 JavaScript/TypeScript reference files with the532
JavaScript/TypeScript files added or modified by this Goal. It also indexes564
code files from the original Gateway baseline to distinguish inherited content.
Reference blobs are read from the pinned Git object without importing or executing
reference code.

Two comparison passes are used:

- Contiguous token matches of at least32tokens, ignoring formatting and comments.
  Rolling-hash candidates are verified against actual tokens, so a hash collision
  does not count as a match.
- Complete function-body shapes of at least100tokens, with identifier and literal
  substitutions normalized, to supplement exact matching.

Synthetic controls verify detection of formatting/comment changes, renamed
function bodies and an unrelated negative example. All matching regions receive
manual review rather than being accepted from a similarity score alone.

The exact pass finds36 matching regions. **All36 are already present in the
Gateway baseline**; none is a newly introduced matching reference block. They
include existing layout/dialog code, cache-display helpers, ordinary object
guards and synthetic stream-fixture fields. The substantial existing UI fragments
are recorded as inherited source, not dismissed as generic boilerplate. The
function-shape pass finds no matches at its stated threshold.

A separate literal review finds67 shared long-string occurrences newly present
in Goal files:44 utility-class strings,18 synthetic fixture timestamps,3 public
or local import strings and2 loopback-URL rejection fixtures. Each is classified;
none is a supplier contract rate, credential, private deployment address or
customer record.

This is a bounded source review, **not** a mathematical proof of universal
authorship, detection of every possible paraphrase or a legal noninfringement
opinion. No newly introduced protected reference implementation was identified
within the inspected source and design scope.

## Runtime dependency and privacy checks

- All1,016 current JavaScript/TypeScript source files are inspected, covering6,920
  static import/export/require references. None imports a reference-workspace
  package or reference repository path.
- Thirteen package, lockfile and TypeScript-configuration documents are checked.
  No reference dependency or alias is present. Recorded external package archive
  resolutions use the public npm registry; the local SDK workspace remains local
  to this Gateway.
- The only nonliteral module load is the unchanged, administrator-configured
  Gateway plugin loader. This Goal adds no dynamic pricing import. User-installed
  plugins remain a separate deployment trust decision, not a dependency on the
  reference repository.
- The public source inventory contains no runtime configuration, private
  development evidence, database or backup artifact. Docker source-copy boundaries
  and ignored private paths are reviewed; a final image/bundle check remains a
  separate delivery gate.
- Changes to the example configuration add pricing resource ceilings only; they
  do not add supplier prices, provider URLs or keys. Test prices and dates are
  synthetic, not copied customer records or statements of current supplier rates.
- Existing real-session HTTP tests reject executable pricing fields and embedded
  credentials/private metadata. Portable price export removes local/private source
  paths and URL credentials/query/fragment data without rewriting the stored
  immutable version.

No private deployment configuration, credential store, production database or
supplier contract is opened for this comparison. Raw reference implementation and
private comparison evidence are not included in the public documentation bundle.

## Verification identity

The source comparison starts from the1,399-file database-acceptance checkpoint,
whose source-manifest SHA-256 is
`8c916c2e8440fef4c482f28487b9723ee72d2f18b74bef3e4beb06852af21153`.
The implementation, dependencies and1,473compiled-file hashes remain unchanged;
this report and the progress update are documentation-only additions.

The existing full regression remains4,281 passing unit tests and807 passing HTTP
tests. Source hashes and321 directly relevant assertions in eight suites are
rechecked: exact arithmetic, calculator, compiler, tier/calendar conditions,
calendar boundaries, metering, media tasks and management/privacy contracts.
These are **carried results**, not a new full regression or a substitute for
remaining platform and performance acceptance.

The original REF-01 boundary is verified for this checkpoint. Final fixed-source
packaging must retain these exclusions and notices. Production2099 and the user's
model configuration remain unchanged; no repository publication or deployment
has occurred.

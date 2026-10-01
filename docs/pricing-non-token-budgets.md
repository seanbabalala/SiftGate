# Media and rerank pricing with token budgets

This is an explicit, versioned admission policy, not a change to deployment
defaults. It applies to new requests only after an administrator previews and
confirms publication. Existing requests retain their captured catalog and holds.

## Policy choices

`token_budget` is optional. Omitting it keeps historical rule selection: an
applicable daily-token rule still requires reported token totals in actual-cost
accounting, even if zero tokens were reserved. Missing counters are not zero.

Under `budget_basis: actual_upstream`, administrators can explicitly select:

- `reported_tokens`: keep applicable token rules; unknown required totals retain
  the original hold. This does not create a token rule when none exists.
- `not_applicable`: exclude daily-token rules for image generation/edit/variation,
  video generation, audio transcription/translation/speech, rerank and Realtime operations
  whose selected, frozen price book contains **no token billing dimensions**.
  All monetary budget scopes remain enforced. No token usage is fabricated.

The non-token choice rejects an unsupported operation, missing price binding or
mixed token/non-token book before dispatch. Even a free token component counts as
a token dimension. Eligibility examines every declared billing dimension, not only
the branch selected by estimated quantities. Each later attempt is checked against
the original policy and its own frozen target binding before it can be recorded.

## Configuration and review

In pricing governance, choose the workspace/global scope and specific media or rerank
operation, select actual-upstream accounting, and then select the token budget
option. The preview shows the old and new effective choices. Confirm publication
only after checking monetary limits and the model's admission simulation.

The admission simulator has the same hypothetical option and compatibility check.
It does not publish policy, reserve a budget or call a provider. An incompatible
model returns `token_budget_incompatible`, including when compatibility pricing
would otherwise allow an unknown estimate.

Clearing an option is not field-level inheritance. Removing the entire policy
restores the normal catalog inheritance order. All seven dashboard locales expose
the choices, scope impact, incompatible selection and future-request-only warning.

## Accounting invariants

The ledger independently reads the captured policy; the client cannot pass a
token-rule bypass flag. Excluded token rules are neither reset nor mutated by the
reservation. Actual settlement and subsequent corrections use the original held
monetary scopes and periods. Missing provider quantities still prevent a known
actual cost; the non-token option does not turn unknown cost into free usage.

Do not remove historical token holds to apply this policy retroactively. Do not
replace missing input/output counters with zero, and do not convert seconds or
image counts into tokens. Request logs retain the original normalized evidence.

Audio and rerank use the synchronous provider-attempt closure: known paid retries
are included, while missing billed seconds/documents or required token counters
keep the hold pending. Rerank results (`top_n`) are not processed-document counts.
Binary speech duration is measured only for supported PCM WAV; opaque compressed
audio does not acquire an invented duration. Character prices count Unicode code
points. An explicit combined token/media tariff still requires reported token
evidence and cannot use the non-token exemption.

This does not add an asynchronous audio/rerank job-completion adapter. An audio or rerank
acknowledgement marked pending is not proof of completed work; its retained
dispatch and hold require later authoritative evidence. Realtime actual-upstream
policy uses a separate connection/response lifecycle; its non-token choice is
limited to frozen tariffs with no token dimensions, such as explicit session time.
Unacknowledged or ambiguous generation work still retains the hold.

An exhausted token rule does not block an explicitly non-token request. Such a
request uses the pricing ledger's atomic monetary reservation, not the legacy
all-rule precheck. Frozen tariff eligibility and every monetary budget scope are
still checked before provider dispatch. Clearing this policy or selecting reported
tokens restores the normal token checks for new requests.

This policy is one part of the pricing Goal. It does not by itself prove complete
media lifecycle, performance, current-source full regression or deployment readiness.

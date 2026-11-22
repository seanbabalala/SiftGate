# Native Messages reasoning in logs

For Messages-to-Messages requests, call logs and the completed route explanation
read `output_config.effort` independently of `thinking`. An explicit effort such
as `high` or `max` is reported even when the request also contains an enabled
thinking budget, or contains no `thinking` object at all.

When a request supplies only `thinking.budget_tokens`, its effort is unset and
the dashboard shows **Thinking Budget** alongside the recorded token count.
A budget is not converted into a model-independent high/max tier. Legacy rows
that already contain `unknown` plus a budget receive the same budget-oriented
display; their historical effort cannot be reconstructed from that value alone.

This is an observation-only change. It does not change canonical transport
intent, model selection, route constraints, request serialization, provider
support declarations, or requests bridged to another protocol. A logged effort
describes the supplied control, not proof of how much internal reasoning the
provider performed. Existing records are not rewritten or inferred as `max`.

Regression checks:

```sh
npm test -- --runInBand test/unit/reasoning-observation.spec.ts
npm --prefix frontend run reasoning-effort:check
```

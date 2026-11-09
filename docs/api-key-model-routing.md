# Per-key model routing

An optional API key `model_routes` binding distributes an exact chat model ID
across multiple upstream nodes using the existing routing engine. It works for
Chat Completions, Responses and Messages ingress, including streaming. It does
not change global `auto` tiers, other keys, or unbound model lookup.

## Configure

In **API Keys → Edit**, enable **Direct routing**, select the allowed nodes and
models, then add a **Per-model routing** rule. Select two or more nodes exposing
the same canonical model. Choose round robin for equal request counts, or
weighted selection to send a larger share to one node. Team and Namespace
restrictions are checked by the server; the editor does not grant permissions.

The Dashboard create/update API accepts the same field. For example, send this
body to `PUT /api/dashboard/api-keys/<key-id>` using an authenticated admin
Dashboard session (not the gateway client key):

```json
{
  "allow_direct": true,
  "model_routes": [
    {
      "model": "shared-model",
      "strategy": "weighted",
      "targets": [
        { "node": "primary-provider", "weight": 3 },
        { "node": "secondary-provider", "weight": 1 }
      ]
    }
  ]
}
```

Both nodes must already exist, be enabled, list `shared-model` in `nodes[].models`,
and be permitted by the key's effective Key/Team/Namespace policy. This field
does not store provider credentials. `allow_auto` can remain false.

- Strategies: `round_robin` or `weighted`; weights are integers 1–100, default 1.
- Limits: 32 model rules per key; 2–16 distinct nodes per rule.
- Only exact canonical model IDs match. Model aliases do not activate a pool.
- Explicit `node/model`, `node:model`, and node shortcuts bypass the pool.
- Omitting `model_routes` on update preserves it; `[]` or `null` removes it.
- Updates that conflict with permissions are rejected before the key is changed.
- Agent virtual-model resolution retains precedence; a smart alias still uses
  `auto`, not a concrete-model pool.
- Embeddings, rerank, media, realtime and batch do not use these chat-model pools.

## Selection, concurrency and fallback

Effective permissions are applied **before** selection, then the router filters
disabled/deleted nodes, missing model registrations, open circuits, incompatible
protocol profiles, modalities and context/capability constraints. Existing
context-safety preferences still apply; global optimization does not override
the key's strategy. A disjoint permission intersection is denied, never treated
as an unrestricted list.

Round-robin state is scoped by workspace, key, model, strategy and target set.
It is bounded, in memory, and per gateway process; it resets on restart. It is
not a cluster-wide scheduler. Weighted selection is probabilistic per request,
not a fixed ratio in small samples and not session-affinity routing. Weights
control request shares, not concurrent-request limits.

The existing retry, timeout, circuit breaker, budget, rate-limit and node
concurrency machinery remains authoritative. Fallbacks stay inside the eligible
same-model pool; a full or unavailable pool never spills to arbitrary global
nodes. No permitted targets yields 403; no healthy configured targets yields
503. Incompatible request capabilities can yield 400. Streaming supports the
existing connection-phase fallback, not replay after partial output.

Adding a second endpoint only increases usable capacity if it has independent
upstream capacity or quota. Two paths backed by the same upstream quota are not
guaranteed to double throughput. Measure with a bounded load test after rollout.

## Stateful Responses safety

Provider-owned `previous_response_id` may not exist on another node. A matching
pooled request using it is rejected with 400. Pin to the originating node with
`node/model`, or send full conversation input without `previous_response_id`.
Automatic response-ID affinity is not implemented. Explicit pins keep their
existing direct-routing behavior; this feature does not add affinity guarantees
to existing direct fallback policies.

## Storage and rollout

API key bindings use a nullable `gateway_api_keys.model_routes` JSON/text column.
The existing startup schema patch adds it idempotently for SQLite and PostgreSQL;
old rows remain unbound. SQLite-to-PostgreSQL migration preserves nested routes.
Admin audit summaries include model/node IDs and weights, never credentials.

Deploy the new backend and Dashboard together before configuring a binding. Back
up the database and config first, preserve any local maintenance changes, and
verify key permissions, node health, distribution and fallback. To stop using
the pool, clear the binding; no global tier changes are necessary. An older binary cannot honor
the binding and restores legacy lookup; retain the backup for rollback.

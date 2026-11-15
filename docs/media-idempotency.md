# Opt-in media idempotency

For an upstream that implements durable request deduplication, set
`media_idempotency: true` on that node. Existing nodes remain unchanged.

SiftGate emits a single `Idempotency-Key` header derived from the authenticated
gateway key identity, workspace, namespace, node, operation, and caller-provided
key. Caller keys must contain 1–256 printable non-space ASCII characters. The
upstream sees a hash, never the gateway credential or the caller identity.

When clients omit the header, SiftGate creates a random identity once for that
in-memory request. Transport retries of that request reuse it; a new client
request gets a new identity. Clients must provide their own stable key if they
need safe retries across separate HTTP requests. Payload changes keep the same
identity so a conforming upstream can reject conflicting reuse.

This setting does not make arbitrary providers idempotent. Enable it only after
verifying the upstream's deduplication and conflict handling. It does not forward
other client headers, alter chat requests, or change existing retry policies.
Avoid fallback to another image provider after an uncertain submission; do not
use a new key to retry a possibly completed generation.

For a local or quota-sensitive channel, also set `media_direct_only: true`.
The node can then only be selected by an explicit media model/node request.
It is excluded from automatic selection and other nodes' fallback pools; requests
directed to it have no fallback targets, including aliases on the same node.
Existing nodes default to their previous behavior. API key permissions still apply.

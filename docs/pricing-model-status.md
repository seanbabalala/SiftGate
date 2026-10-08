# Model-list pricing status

The node list has an expandable, operation-specific pricing view. It reads only
when expanded, paginates all configured model identities, and scopes its requests
and query cache to the active workspace. Selecting a different operation does
not imply that the supplier supports it.

`POST /api/dashboard/pricing/model-status` is a **read-only** dashboard endpoint
available to viewers. Its JSON body contains `targets`, an array of 1–20 unique
`{ node_id, model, operation }` objects. Unknown fields, unknown configured
identities, unsupported operation identifiers and duplicate targets are rejected.
The normal dashboard authentication, workspace membership, JSON size and
same-origin guards still apply. This endpoint does not contact model providers,
quote fees, create request snapshots, reserve budgets or edit configuration.

## What the view means

- Current bindings use the same immutable catalog precedence and effective-time
  selector as request pricing. Scope, node, model and operation are not resolved
  by a separate UI pricing algorithm.
- A row shows its admission mode, budget basis, currency, source, immutable price
  version, override level, parent version and review/missing-rate flags.
- Conditional rules are labelled explicitly; they are not flattened into a
  misleading single input/output tariff. Review flags describe obvious reference
  or missing-rate conditions, not complete supplier or metering certification.
- Scheduled changes include expiry to a lower-priority fallback or to no binding.
  Hidden lower-priority changes are omitted. At most eight effective transitions
  are returned per target; truncation is explicit. These are observations of the
  current catalog, not promises that a future publication cannot change them.
- Legacy/catalog prices are labelled reference-only. No new-engine binding does
  **not** mean free; compatibility mode may still use its existing legacy formula.
- If the pricing schema is absent, the view returns reference metadata and an
  explicit `schema_available: false` without installing it. Incompatible migration
  markers are an error, not a successful empty result.

The response includes its workspace, evaluation time, catalog head,
`read_only: true` and `supplier_support_verified: false`. Source URL credentials,
query strings, fragments and private/local references are omitted; raw contract
rates and credentials are not returned by this endpoint.

## Editor navigation

Each active/scheduled version links to the same price editor using locally built,
URL-encoded `book`, `version`, `node`, `model` and `operation` parameters. A missing
binding opens a visible target context with an administrator-only action to create
a draft. New drafts retain node/model/operation context for the publication dialog.
Existing book bindings are preserved instead of being silently narrowed to the
clicked model. Published versions remain read-only; actual activation still needs
an explicit impact preview and confirmation. Opening the page alone changes no
prices or configuration.

All new labels are provided in the seven dashboard languages. This feature is
part of the isolated pricing candidate; it does not deploy or alter the live
service.

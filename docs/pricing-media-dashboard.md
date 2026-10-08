# Media operator Dashboard

The media Dashboard combines persisted task inventory, recorded cost evidence,
signed event-source configuration and administrator-attested job lookup. It is
part of the isolated development candidate; no page or verification result
authorizes production migration or deployment.

## Navigation and permissions

Open **Pricing → Media tasks**. The lazy media pages are:

- `/pricing/media`: persisted media task inventory and state filter.
- `/pricing/media/:id`: original task metadata, cost ledger, job lookup and
  retained supplier events.
- `/pricing/media-sources`: paginated registered source inventory.
- `/pricing/media-sources/:id`: inspect or edit one source.
- `/pricing/media-sources/new/register`: register a source. The separate path
  does not conflict with an existing source literally named `new`.

Operators may inspect tasks, costs, sources and normalized events. Administrators
may change sources or associate an unknown provider job. Viewers cannot inspect
these operational pages. Every query captures the workspace in its cache key,
request header and pending-session identity. A workspace switch cannot reuse a
private task/source response from another workspace.

Task/source/event lists use keyset pages, including a second-page workflow for
identical or adjacent creation timestamps. These pages cover persisted media
records, not all gateway traffic or a complete financial report. Retained events
are alternatives/evidence, not extra charges to add together. The event detail
checks the recorded document hash before displaying normalized metadata.

## Job lookup and uncertain replies

Provide a provider job ID that an administrator independently investigated as
belonging to the original request. The preview performs a status GET using the
original connection and physical credential, without writing task or cost data.
Review the normalized evidence, original-price calculation, exact hashes and
attestation warning. Missing provider instants are not filled with recovery time.

Editing a job ID invalidates its preview and confirmation. Confirmation sends
the exact preview hashes with a stable operation ID. Before the mutation, the
browser stores only the scoped proposal in session storage: operation/job IDs,
exact hashes, reason and confirmation. No provider body, media or credential
value is stored in that recovery record. Invalid storage prevents a mutation.

An unconfirmed reply locks the proposal for same-ID retry. Reload restores that
proposal, even when the eligibility/basis request fails; its receipt can still be
queried. A restored operation is not hidden by a newly pending basis read. A
confirmed conflict preserves input fields and requires a new basis/preview.
Discarding an unconfirmed proposal is only offered after receipt lookup returned
not found, with explicit warning about a delayed reply.

A verified receipt means the association was recorded, not that accounting is
finished. `processing_pending` is shown separately; the refreshed original task
ledger remains authoritative for pending, unknown, committed and reserved amounts.
Receipt acknowledgement does not itself drive financial processing. A role
change disables writes but does not delete the retained proposal.

## Signing-source configuration

New sources are disabled by default. Enter only the dedicated signing variable
name, node ID and credential ID. The deployment administrator supplies the
independent signing key outside this page. The page never accepts the signing
secret itself and does not send a test webhook or generate media.

Existing node/credential identity is locked. Changes use the original revision,
require a reason and confirmation, and verify the returned configuration hash.
An unconfirmed reply can be resolved by rereading the current source. Only an
exact next-revision state match is accepted; the UI describes this as a current
state check, not proof that a particular earlier reply was delivered. Repeated
writes retain the original revision and cannot overwrite a newer configuration.

Conflicts preserve entered fields. Inspect the current source before explicitly
starting from that revision. New-source recovery uses its own session slot and
retains the submitted source ID across reload. Invalid local session metadata can
be explicitly cleared without any server write.

Revocation remains possible after the original node is removed, its connection
fingerprint changes, or its signing key is unavailable. Disabling preserves the
original node, credential, signing-variable name and historical connection hash;
it cannot retarget or reactivate the source. Enabling a changed source still
requires its original verified connection rather than silently adopting another.

## Verification and remaining work

All strings cover the existing seven locales. Pure frontend contracts validate
exact source/job identities, preview/receipt hashes, decimal amounts, scoped
minimal pending records, cursor/row envelopes and dynamic status translations.

The isolated browser verifies no-write preview, recorded-but-processing-pending
state, lost lookup reply → reload with unavailable basis → acknowledgement,
exact same-ID retry with no additional provider call, conflict input preservation,
invalid preview rejection, source creation/update recovery, configuration conflict
and explicit rebase, operator/viewer/workspace restrictions, and task/source/event
second pages. A changed-node source is disabled without retargeting. Fifty-six
surface/layout cases cover four media surfaces in seven languages at desktop/light
and 390-pixel/dark widths; screenshots wait for CSS transitions to settle.

The synthetic browser makes only mocked status GETs and no generation calls.
Static/bundle checks use unchanged existing caps, with separate caps for the new
lazy routes. Full source identity and backend regression results are tracked in
[the progress record](pricing-engine-progress.md).

This does not complete alternative-event disposition, native supplier translator
coverage, metering governance, all-traffic reports, capacity/retention or final
Linux/Docker/performance/candidate acceptance. Those remain required by the Goal.

Related contracts: [job lookup](pricing-media-job-lookup.md) and
[signed media events](pricing-media-supplier-events.md).

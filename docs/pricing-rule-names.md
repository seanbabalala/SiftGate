# Rule names and immutable pricing history

A price rule has a stable `id` and may also have a human-readable `name`. The name
is display metadata, not another identifier or a matching condition.

```json
{
  "id": "long-context",
  "name": "Long context contract",
  "priority": 10,
  "mode": "whole_request",
  "condition": { "input_tokens": { "min": "272001" } },
  "rates": []
}
```

This example names a rule; an empty `rates` array does not supply a complete
long-context tariff. Configure the actual components and required groups
separately, then validate and publish using the existing workflow.

## Validation and compatibility

- A name, when supplied, must contain non-whitespace text, at most 128 UTF-16 code
  units, and no control characters. Unicode and ordinary punctuation are allowed.
- Names are rendered as plain text. Text resembling HTML is not interpreted as
  markup or executable content.
- Editing a name never changes the rule ID, priority, conditions, units or rates.
  Duplicate names are permitted: IDs remain the unambiguous references.
- Names are optional for old documents. The parser does not insert default names
  or add `name: null`; old content, selection traces and cost hashes remain
  unchanged when the field is absent.
- Clearing the Dashboard field removes only the optional property. It does not
  delete the rule or reset its prices. A supplied empty name in an API document is
  invalid rather than silently repaired.

A label change changes the content hash of the newly saved/published document,
just like other versioned metadata. It does not recalculate old fees. Existing
schema checksums and historical document bodies are not rewritten. Readers from
older implementations that reject unknown JSON fields may not understand named
rules; do not assume that this extension makes arbitrary code downgrades safe.
The existing deployment and database rollback checks still apply.

## Dashboard and evidence

Edit the name under **Context tiers**, next to the stable rule fields. The rule
selector shows both the name and ID. The parent-price picker includes names when
reviewing inherited components. Save, copy, import, export, fork and rollback
preserve them through the same complete price document.

Changing a child's inherited rule name is an explicit group replacement in its
inheritance recipe. It does not rename or mutate the parent version. Later edits
to an unrelated component preserve the chosen child label.

Each selection evaluation records an optional `rule_name` from the immutable
price version used for that quote or request. Both selected and rejected rules
retain their names. The simulator, recorded cost breakdown and selection trace
show these names alongside IDs; they do not query a current label during history
reads. A replay using another version can therefore show a different name while
the original receipt remains unchanged, even if the numerical price is identical.

## Verification

Unit tests pin hashes from unnamed documents captured before this extension and
verify that name-only changes leave amounts and matching unchanged. They reject
invalid definitions and retained evidence and check immutable-parent expansion.
SQLite and PostgreSQL tests restore named request snapshots through fresh database
connections after a later label publication.

Actual JSON and SSE requests publish a new label while a request is in flight.
The in-flight receipt retains the old label and version; a later request uses the
new label with the same exact amount. Export/import, rollback and replay preserve
original metadata without rewriting recorded attempts or budgets.

Browser checks cover seven locales in desktop/light and narrow/dark layouts,
native Tab/Shift-Tab access to the field, local clear/restore, literal-text rendering,
current-versus-published simulation, original/new request details and real draft
save/reload/export. Read-only flows leave pricing, budget and log tables unchanged.
Three draft label saves append audits but do not alter active versions, fees or
reservations. These checks are a rule-name checkpoint, not whole-Goal completion
or production deployment authorization.

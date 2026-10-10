## Summary

-

## Testing

-

## Safety Checklist

- [ ] No real provider API keys, Gateway API keys, raw auth headers, private tokens, prompts, or responses are committed.
- [ ] `gateway.config.yaml` is not committed.
- [ ] Memory/SQLite remains usable by default.
- [ ] Redis/PostgreSQL/Kubernetes/secret managers remain optional.
- [ ] Dashboard copy is localized in all 7 supported languages when UI text changes.
- [ ] Docs and examples use placeholders only.
- [ ] Public docs links and localized docs entrypoints still pass `npm run docs:check`.
- [ ] `npm run security:scan` and `npm run security:boundary` pass; no directory-wide secret exclusions were added.
- [ ] Screenshots/media have been reviewed for names, email addresses, credentials, customer content and source rights; changed media hashes are recorded in `.security/media-review.json`.
- [ ] Personal deployment records, internal project snapshots and raw audit evidence remain outside the public repository.

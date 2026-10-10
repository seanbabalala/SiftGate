# Contributing

Thanks for helping improve SiftGate.

## Development Setup

Use Node `>=22.13.0 <23`, selected by `.nvmrc`. With nvm, run `nvm install` and
`nvm use` first. Root/frontend `.npmrc` enforce the package engine constraints;
do not put registry credentials in these committed files.

```bash
npm run runtime:check
npm run test:runtime
npm install
cd frontend && npm install && cd ..
cp gateway.config.example.yaml gateway.config.yaml
npm run build
npm test -- --runInBand
```

## Before Opening A PR

Run the checks that match your change:

```bash
npm run docs:check
npm run security:scan
npm run security:boundary
npm run test:security
npm run build
npm test -- --runInBand
npm run test:e2e
npm run validate:k8s
cd frontend && npm test && npm run build
```

Docs-only changes also require the secret and publication-boundary checks.
The scanner needs complete Git history and verifies its pinned binary before use.
See [publication privacy](docs/PUBLICATION_SECURITY.md) for offline scanning,
reviewed false positives, private records and screenshot approval.

## Contribution Rules

- Keep the open-source Data Plane useful without hosted services.
- Keep memory/SQLite as the default local path.
- Treat Redis, PostgreSQL, Kubernetes, and external secret managers as optional.
- Do not commit real provider keys, Gateway API keys, private tokens, raw authorization headers, or local `gateway.config.yaml`.
- Do not add private packages or private repository dependencies.
- Add tests for behavioral changes and privacy-sensitive logic.
- Add Dashboard copy in all supported locales: `en`, `zh`, `zh-TW`, `ja`, `ko`, `th`, `es`.

## Commit Style

Prefer concise conventional-style messages:

- `feat: add local team policy`
- `fix: mask provider key in dashboard response`
- `docs: add semantic cache guide`
- `test: cover eval privacy defaults`

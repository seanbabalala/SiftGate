# Security Policy

Please report vulnerabilities privately before public disclosure.

## Supported Scope

This policy covers the open-source SiftGate Data Plane in this repository, including:

- gateway runtime
- local Dashboard
- config validation
- local SQLite/PostgreSQL metadata stores
- provider forwarding
- plugins shipped in this repository
- Docker, Kubernetes, and Helm assets

## Reporting

Open a private security advisory on GitHub or contact the repository maintainer through the project profile. Include:

- affected version or commit
- reproduction steps
- expected impact
- whether secrets, prompts, responses, raw headers, cache entries, audit entries, traces, or eval samples may be exposed

Do not include real provider API keys, customer prompts, customer responses, or private infrastructure credentials in the report.

## Security Defaults

Repository, build-input, credential and screenshot controls are documented in
[Publication privacy](docs/PUBLICATION_SECURITY.md). Raw audit evidence and
installation-specific records must not be published with customer documentation.

SiftGate should remain safe by default:

- memory/SQLite local mode works without external services
- provider keys and Gateway API keys are masked in Dashboard/API responses
- config audit, route traces, cache, eval, shadow, batch, MCP, video, and guardrails surfaces are metadata-only by default
- opt-in storage of samples or replayable semantic cache responses must be explicit and documented

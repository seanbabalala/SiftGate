# Publication privacy and secret prevention

Source publication, image publication and deployment are separate operations.
Security-gate changes do not restart a running gateway or revoke its credentials.

## Public and private records

Public docs describe product contracts, installation, supported upgrades, recovery
and bounded test evidence. Keep personal deployment diaries, internal project
snapshots, credentials, customer requests, raw incident data and private review
records outside the public repository. A folder named `private` inside a public
repository provides no confidentiality. Preserve required licensing/attribution
when reducing internal detail.

Screenshots must use synthetic data and have a human privacy/source review. Check
names, email addresses, browser URL bars, terminal output, tokens and customer
content, including text embedded in images. `.security/media-review.json` binds
each approved asset's bytes to its review. A changed image needs renewed review;
hash matching alone cannot determine privacy or copyright status. Preserve the
official logo and existing attribution.

## Required developer gates

```sh
npm run public:check
npm run docs:check
npm run security:scan
npm run security:boundary
npm run test:security
```

The pinned Gitleaks binary is downloaded from its official release and checked
against an explicit SHA-256 before execution. Scanning is local; repository files
and findings are not uploaded to a scanning service. Offline developers can set
`SIFTGATE_GITLEAKS_ARCHIVE` to the matching verified platform archive; this does not
bypass the digest check. CI and formal tag publication scan both tracked current
content and complete reachable commit history. A shallow checkout fails closed.

The scanner includes tests, dotfiles and extensionless text. Inline allow comments
and local ignore files cannot bypass it. False positives require exact
path + detector + value-digest entries with a reviewed reason in
`.security/secret-exceptions.json`. Never approve a real credential, whole directory
or commit to obtain a green check. Raw matching values exist only in an ephemeral
owner-private directory; console reports contain locations and detector names,
not secret values. Do not upload raw scan output as Actions artifacts.

For earlier feedback, maintainers may explicitly install `.githooks/pre-push` as
the repository's pre-push hook after checking any existing hook. It scans every
outgoing commit history, not just the checked-out branch. Client hooks are optional
convenience, not a substitute for CI, GitHub secret scanning and push protection.
Review security-policy changes using normal repository controls.

## Build and release boundaries

`.dockerignore` is default-deny and admits only reviewed build inputs. Private
configs, backup files, caches, databases and unrelated projects must not enter a
build context even when Git already ignores them. The boundary test checks both
the reviewed rules/COPY list and Docker's actual matcher with synthetic sentinels:

```sh
python3 scripts/check-publication-boundary.py --docker
```

This test does not start a gateway, bind a port or use a real configuration.
Use clean Git checkouts or explicit source exports for release builds, never a
live installation directory. Customer installer archives use a separate explicit
file mapping read from an exact Git commit. Do not replace it with a workspace glob.

## Private credentials and backups

Use dedicated owner-private storage, directories mode `0700`, sensitive files
mode `0600`, and an encrypted disk or encrypted off-host backup with keys kept
separately. Keep active settings stable; move or remove backups only after checking
restoration needs, open processes and installation references. Adopt a documented
retention policy and verify a replacement before pruning. Do not symlink private
material back into an allowed build directory.

## Historical findings

Deleting a file or changing a document does not erase Git history, existing
releases, clones, forks or cached copies. If a real secret was exposed, first
identify and revoke/rotate it with the installation owner and review its usage.
Avoid unplanned rotation that cuts off business clients. Do not test an unknown
credential against a provider merely to establish whether it works.

Unused local branches can be quarantined in owner-private Git bundles outside the
repository, verified, and removed from normal pushable references. Keep a private
recovery manifest; sanitize before reintroducing that history. This containment
does not prove a token was revoked or remove reflog/unreachable copies.

Public history cleanup is a separately approved incident operation: coordinate
branches, tags, forks and support/cache removal. It must not silently move signed
release tags or replace immutable release assets. For an unverified design-image
identity or internal metadata disclosure, record the residual risk and decision;
do not claim prevention gates erased an already public historical object.

Report actual vulnerabilities privately using [the security policy](../SECURITY.md).

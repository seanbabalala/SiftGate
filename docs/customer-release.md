# Formal container-image release runbook

This is the maintainer procedure for publishing SiftGate to GHCR and shipping a
verified customer installer. The [Chinese runbook](customer-release.zh-cn.md)
contains the same operational stages. Customer deployment is documented in
[Customer installation](customer-install.md). The executable authority is
[`customer-release.yml`](../.github/workflows/customer-release.yml).

**Instructions are not authorization to publish or deploy.** Ordinary branch
pushes do not release images. Publishing an image does not upgrade a running
gateway. Merges, version tags, package visibility changes and deployments require
explicit maintainer decisions. Work in an isolated checkout, never a live runtime.
Commands below use Bash; macOS zsh users should open a Bash session first. Keep
the exported release variables in that session.

## 0. State gate: a branch runbook is not a ready main branch

**Publication checkpoint, October 8, 2026:** PR #132 merged the customer system
to `main` (`cff3cc9`); its full main CI and both native rehearsals passed.
The `v2.11.6` tag workflow then failed before builds because checkout flattened
the runner's local annotated-tag ref to a commit. The remote tag is preserved;
no v2.11.6 image or GitHub Release was published. Successor v2.11.7 validates the
remote tag object and adds offline regressions. It still requires its own full
gates: the predecessor's green runs are not successor release evidence. Fetch
and inspect actual commits before each operation.

| State | Required evidence | Permitted actions |
| --- | --- | --- |
| **S0 not merged** | Main lacks any release/install component or still has the old checklist | Review, repair, isolated local tests only; **do not execute sections 4/5** |
| **S1 rehearsal-ready** | All components, Node constraints and the updated checklist are reviewed and merged to the default branch | Test-only dispatch; a green rehearsal is not publication |
| **S2 tag-ready** | Version aligned, exact main push CI green, both native rehearsals green, migrations reviewed and explicit publication approval | Push the approved annotated tag; never overwrite a conflict |
| **S3 customer-installable** | Publication gates pass, actual anonymous layers and verified assets download, clean-host acceptance complete | Announce availability; existing 2099 deployments still need separate approval |

```text
S0 not merged → reviewed complete merge → S1 rehearsal-ready
S1 → version/CI/platform/migration/approval gates → S2 tag-ready
S2 → publication + public downloads + clean-host acceptance → S3 customer-installable
```

Merge the customer workflows, deployment kit, scripts/tests, Node constraints,
`docs/customer-*` and **the `docs/RELEASE_CHECKLIST.md` update together**. Do not
merge only the new manual while leaving main's old manual-Release instructions.
Subsequent fixes also require normal review and merge; a feature-branch fix is
not already on main. These read-only checks must succeed in an isolated checkout:

```bash
git fetch origin main
git rev-parse origin/main
git cat-file -e origin/main:.github/workflows/customer-release.yml
git cat-file -e origin/main:deploy/customer/siftgate.py
git show origin/main:docs/RELEASE_CHECKLIST.md
```

**First GHCR release:** a public repository does not guarantee a public package.
The first tag may stop at anonymous manifest access. The **package administrator**
audits/makes the package public, then uses **`gh run rerun RUN_ID --failed` only**.
Do not rebuild successful architectures or bypass the gate (sections 2 and 7).
Use the [separate-gate command card](customer-release-quickref.md) under pressure;
it is not one unattended paste-and-publish script.

## 1. Deliverables and identity

A completed release has all of the following:

- A reviewed commit on `main` and an annotated `vX.Y.Z` tag pointing at it.
- Successful full `ci.yml` **main push CI for that exact commit**.
- Native `linux/amd64` and `linux/arm64` image builds and customer-install smoke tests.
- A multi-platform index referencing those exact tested child digests.
- Equal index digests for `ghcr.io/seanbabalala/ai-gateway:vX.Y.Z` and `:X.Y.Z`.
  The bare version is required by the existing Helm/Kustomize image defaults.
- `siftgate-vX.Y.Z-install.tar.gz` and `.tar.gz.sha256` GitHub Release assets.
- A matching commit/version/immutable registry digest in the archive's `release.json`.
- Anonymous registry access, clean-machine layer pulls/installations and migration evidence.
- Release notes stating upgrade, backup, downtime, recovery and known limitations.

`X.Y.Z` is selected by the maintainer; examples are not proof a version exists.
There is no `latest` tag. Local review tags are not public registry references.
Build tags use `build-<run id>-<attempt>-<architecture>` and are not customer entrypoints.
Customer installations pin the combined index digest, not a moving tag.

## 2. One-time repository and GHCR setup

```bash
export REPO=seanbabalala/ai-gateway
export IMAGE_REPO=ghcr.io/seanbabalala/ai-gateway
gh auth status
gh api "repos/$REPO" --jq '{default_branch,visibility,archived}'
gh api "repos/$REPO/actions/permissions" --jq '{enabled,allowed_actions}'
```

The operator needs repository/tag-write access; managing GHCR visibility requires
package administration. Never put authentication tokens in command arguments,
Git, examples or logs. Actions uses its short-lived `GITHUB_TOKEN`; a personal PAT
is not required for the normal image-release workflow.

Check **Settings → Actions → General**, organization policies and runner quotas.
Allow the official actions referenced by the workflow and native `ubuntu-24.04`
and `ubuntu-24.04-arm` runners. Jobs request scoped `contents`, `packages` and
`actions` permissions. Do not grant every workflow global write access merely to
make a release succeed. Protect `main` and version tags; do not bypass review.

First merge the workflow into the default branch. GitHub requires a default-branch
workflow definition for `workflow_dispatch`; adding it to a feature branch alone
does not guarantee a **Run workflow** button. Manual dispatch is test-only,
**including dispatch with a tag selected**. Publication requires a tag **push** event.

For `ghcr.io/seanbabalala/ai-gateway`, check the package's **Package settings**:

1. Confirm the source-repository association (`org.opencontainers.image.source`).
2. Give this repository write access under **Manage Actions access** if necessary.
3. Check inherited permissions and organization restrictions.
4. A public repository does not guarantee its newly created package is public.
   Audit every image layer for private data before the administrator makes it Public.
5. The workflow blocks public installer upload until an empty Docker auth directory
   can read the manifest. Fix visibility and rerun only the failed publish job.

Do not remove the anonymous-access gate to disguise private distribution as OSS
public installation. Deliberately private distribution needs a separate reviewed
credential and delivery policy.

### Remote annotated-tag validation

On tag events, checkout can replace the runner's local `refs/tags/<version>`
with the event commit. That does not mean the remote tag moved. The publisher's
`scripts/check-customer-release-tag.py` fetches the remote object into a fresh
non-tag ref, checks its annotation, name/version and direct source-commit target,
then deletes only that temporary ref. It never rewrites version tags or
`FETCH_HEAD`; unavailable, lightweight, missing or mismatched remote tags fail
closed. Main ancestry and exact main-push CI checks remain mandatory afterwards.

If a pushed tag contains a workflow defect, fixing main and rerunning the old run
does not replace that tag's workflow. Preserve the tag and validate a successor
version. Do not move the old tag, upload manually around the gates or enable
manual publication as a workaround.

## 3. Prepare and review the version

```bash
git clone "https://github.com/$REPO.git" "$HOME/siftgate-release"
cd "$HOME/siftgate-release"
git fetch origin --tags
git status --short
```

Select the reviewed candidate branch, not an assumption that unmerged features
already exist on `main`. If the directory exists, inspect it; never overwrite or
reset a live checkout. Review changes before staging, committing and pushing.

Synchronize the version following [Release checklist](RELEASE_CHECKLIST.md):

| File | Values |
| --- | --- |
| `package.json` | root version |
| `package-lock.json` | top-level, root package, workspace client versions |
| `frontend/package.json`, `frontend/package-lock.json` | frontend and lock root versions |
| `packages/client/package.json` | TypeScript SDK version |
| `packages/python/pyproject.toml` | Python version |
| `deploy/helm/siftgate/Chart.yaml` | chart version and appVersion |
| `deploy/kubernetes/base/deployment.yaml` | bare-version image tag |
| `src/openapi/setup-openapi.ts` | OpenAPI version |
| `test/unit/release-version-sync.spec.ts` | expected release assertion |
| `README.md` | current version, badge, release URL |
| `CHANGELOG.md` | dated entry for the actual release |
| `docs/BASELINE.md` | version and acceptance evidence |

One `npm version` command does not update this whole set. Do not globally replace
historical version references, reuse published version numbers or move old tags.

This candidate uses **Node `>=22.13.0 <23`**: `.nvmrc` selects the 22 line,
root/frontend `engines.node` and lockfile metadata match, every Node CI selector
reads `.nvmrc`, and the Docker default is `node:22-alpine`. Root/frontend
`.npmrc` enforce `engine-strict=true` at installation. Never add registry credentials
to those build-context files. This is a major/minimum-version contract, not an
exact patch/digest pin; retain the resolved `NODE_IMAGE` digest for reproducibility.
It governs gateway development/builds, not a new restriction on downstream SDK consumers.

At the audit starting point, main Docker/CI used 20, but the candidate Dockerfile
already used 22 while CI still used 20. This correction aligns the candidate on
22 rather than downgrading Docker. With nvm, run `nvm install` and `nvm use` first;
other managers should follow `.nvmrc`. Do not rely on the interactive shell default.

Validate runtime in the isolated checkout before installing locked dependencies:

```bash
npm run runtime:check
npm run test:runtime
npm ci
npm --prefix frontend ci
npm run release:hardening -- --dry-run
npm run release:hardening
npm run test:customer
git diff --check
```

Keep these checks distinct:

| Command | Covers | Does not cover |
| --- | --- | --- |
| `release:hardening` | Node contract plus backend/frontend/SDK/config/docs/audit/version gates | **Not** `test:customer`, `smoke:customer` or `smoke:docker` by default |
| `release:hardening -- --include-docker` | The above plus the legacy `smoke:docker` | Still not customer unit/smoke tests |
| `test:customer` | Python installer/recovery/release-asset regression, no real Docker operations | No actual container startup |
| `smoke:customer -- --image IMAGE` | Real customer-kit flow against the specified loaded image | Not the root-Compose `smoke:docker`, nor arbitrary cross-version migration proof |

Run the separate customer unit and smoke gates; a hardening pass does not subsume
them. Main CI also runs customer unit tests separately, without changing that boundary.

The hardening gate covers backend/frontend/SDK/config/docs/audit/version checks.
PostgreSQL claims require additional isolated PostgreSQL evidence. Never supply
a production database URL to tests. Document accepted deviations instead of
calling them a measured pass. No Dashboard strings change in a tooling-only release.

Optional local customer smoke uses only isolated fixtures:

```bash
# Only on a Rancher Desktop host configured with this Moby socket:
export DOCKER_HOST="unix://$HOME/.rd/docker.sock"
docker build -t siftgate:release-review .
npm run smoke:customer -- --image siftgate:release-review
```

Linux operators use their own local engine. Do not change the global Docker
context. The smoke owns fresh names, ephemeral ports and synthetic credentials;
it does not use production volumes or provider keys.

Review/merge the release PR normally. It must describe scope, version, tests,
localization, migration, recovery and limitations. Then select the exact release
commit and wait for its full main CI:

```bash
git switch main
git pull --ff-only origin main
export SOURCE_SHA="$(git rev-parse HEAD)"
export VERSION="$(node -p "require('./package.json').version")"
export TAG="v${VERSION}"
test -z "$(git status --porcelain)"
npm run release:check
gh run list --repo "$REPO" --workflow ci.yml --commit "$SOURCE_SHA" --event push --branch main --limit 5
read -r -p 'Exact main CI run ID: ' MAIN_CI_RUN_ID
gh run watch "$MAIN_CI_RUN_ID" --repo "$REPO" --exit-status
```

The release workflow enforces this exact-commit main-push CI condition. A green
PR merge-ref, an older build, or a different branch's build is not equivalent.

## 4. Test-only multi-architecture rehearsal

After the workflow exists on the default branch:

```bash
gh workflow run customer-release.yml --repo "$REPO" --ref main
gh run list --repo "$REPO" --workflow customer-release.yml --event workflow_dispatch --limit 5
read -r -p 'Dry-run workflow run ID: ' DRY_RUN_ID
gh run view "$DRY_RUN_ID" --repo "$REPO" --json headSha,event,status,conclusion
gh run watch "$DRY_RUN_ID" --repo "$REPO" --exit-status
```

Confirm `headSha` is the reviewed target. Both native architectures build and run
the installation tests. There is no GHCR login/push or Release creation; a skipped
`publish` job is expected. Local ARM64 evidence alone is not AMD64 evidence.

The smoke checks first startup, HTTP readiness, password login, atomic Dashboard
config saves, Gateway keys, mock-provider requests, WAL-aware full backup,
same-code image replacement, restart, independent restore, timezone/session/key/log
preservation and watchdog non-revival of stopped instances. It does not prove
arbitrary cross-version schema migrations, zero downtime or every Linux distribution.

## 5. Publish by pushing an annotated version tag

**This step publishes external artifacts and needs explicit maintainer approval.**

```bash
test "$(git rev-parse HEAD)" = "$SOURCE_SHA"
test -z "$(git status --porcelain)"
test -z "$(git tag --list "$TAG")"
test -z "$(git ls-remote --tags origin "refs/tags/$TAG" "refs/tags/$TAG^{}")"
git tag -a "$TAG" "$SOURCE_SHA" -m "Release $TAG"
git show --no-patch "$TAG"
git push origin "refs/tags/$TAG"
```

Push only this tag, never `--force` or an indiscriminate `--tags`. A signed
annotated tag is optional with an established verification policy; the current
workflow checks annotated type, not GPG trust. A tag pushed by another workflow's
`GITHUB_TOKEN` normally does not trigger a recursive workflow run. Use the approved
maintainer Git flow, not an unreviewed automatic tag workaround.

The pipeline then:

1. Validates version/tag/main ancestry and successful exact-commit main CI.
2. Builds/tests native AMD64 and ARM64 with OCI source/revision/version/license labels.
3. Pushes run/attempt-specific architecture candidates only after their smoke tests pass.
4. Stores commit/architecture/digest in `customer-image-amd64` and `customer-image-arm64`
   Actions artifacts. These immutable receipts, not staging tags, drive combination.
5. Publishes both version aliases without overwriting a different existing release.
6. Checks equal index digests and anonymous manifest access.
7. Packages only allowlisted files from the exact Git commit, including checksums.
8. Creates a Draft GitHub Release, verifies existing asset bytes, uploads missing
   assets, downloads/verifies the result, and only then makes the release public.
9. Writes commit, aliases, index/child digests and installer checksum to the job summary.

Hyphenated alpha/beta/rc versions are marked prerelease. Do not manually announce
an empty public Release while the pipeline is still uploading assets.

## 6. Independent post-publication verification

```bash
gh run list --repo "$REPO" --workflow customer-release.yml --event push --limit 10
read -r -p 'Release workflow run ID: ' RELEASE_RUN_ID
gh run watch "$RELEASE_RUN_ID" --repo "$REPO" --exit-status
gh release view "$TAG" --repo "$REPO" --json tagName,isDraft,isPrerelease,publishedAt,assets
mkdir -p "$HOME/siftgate-release-evidence/$TAG"
gh run download "$RELEASE_RUN_ID" --repo "$REPO" --pattern 'customer-image-*' \
  --dir "$HOME/siftgate-release-evidence/$TAG/architectures"
```

Both verify jobs and publish must succeed. Check the release is not Draft and
contains both assets. Inspect both architecture entries and aliases:

```bash
docker buildx imagetools inspect "$IMAGE_REPO:$TAG"
docker buildx imagetools inspect "$IMAGE_REPO:$VERSION"
export IMAGE_DIGEST="$(docker buildx imagetools inspect "$IMAGE_REPO:$TAG" --format '{{json .Manifest.Digest}}' | tr -d '\"')"
export BARE_DIGEST="$(docker buildx imagetools inspect "$IMAGE_REPO:$VERSION" --format '{{json .Manifest.Digest}}' | tr -d '\"')"
test "$IMAGE_DIGEST" = "$BARE_DIGEST"
export IMAGE="$IMAGE_REPO@$IMAGE_DIGEST"
AUTH_FREE_DIR="$(mktemp -d)"
DOCKER_CONFIG="$AUTH_FREE_DIR" docker manifest inspect "$IMAGE"
```

The temporary empty auth directory does not log the operator out of their normal
Docker config. Remove only that owned temporary directory afterwards. Anonymous
manifest access is not a full image-layer download test.

Download, verify and inspect the real customer archive:

```bash
mkdir -p "$HOME/siftgate-release-evidence/$TAG/download"
cd "$HOME/siftgate-release-evidence/$TAG/download"
gh release download "$TAG" --repo "$REPO" \
  --pattern "siftgate-$TAG-install.tar.gz" --pattern "siftgate-$TAG-install.tar.gz.sha256"
sha256sum -c "siftgate-$TAG-install.tar.gz.sha256"
tar -xzf "siftgate-$TAG-install.tar.gz"
cd "siftgate-$TAG"
sha256sum -c SHA256SUMS
python3 - <<'PY'
import json, os
release = json.load(open('release.json'))
assert release['version'] == os.environ['TAG']
assert release['commit'] == os.environ['SOURCE_SHA']
assert release['image'] == os.environ['IMAGE']
print('Release identities and file checksums match.')
PY
```

Use `shasum -a 256 -c` instead of `sha256sum -c` on macOS. Public customers can
download from the Release page without a `gh` account; the CLI is an operator
convenience. Checksums detect mismatch/corruption, not authenticity by signature.

**Continue from the extracted `siftgate-$TAG/` Release archive in the preceding
step**, with its verified `release.json`. Do not run this image-less command from
the source root or `deploy/customer/`. Source invocation requires an explicit
real `--image`, and an unpublished local image also requires `--local-image`.
Source availability is not proof that a registry image exists.

On clean AMD64 and ARM64 test machines, install the actual downloaded bundle:

```bash
test -f siftgate.py
test -f release.json
python3 siftgate.py --directory "$HOME/siftgate-release-acceptance" init \
  --timezone Asia/Shanghai --port 21099
python3 "$HOME/siftgate-release-acceptance/kit/siftgate.py" \
  --directory "$HOME/siftgate-release-acceptance" up
python3 "$HOME/siftgate-release-acceptance/kit/siftgate.py" \
  --directory "$HOME/siftgate-release-acceptance" doctor
python3 "$HOME/siftgate-release-acceptance/kit/siftgate.py" \
  --directory "$HOME/siftgate-release-acceptance" status
```

Use an unused port and fresh directory, never production credentials or data.
Follow the install guide for login/config/request/budget/log/backup/restore checks.
Also rehearse supported actual old→new schema upgrades and retain the source/target
versions and evidence. Only then announce the release as customer-installable.

## 7. Failure handling and safe resumption

| Failure | Action |
| --- | --- |
| No Run workflow button | Check default-branch definition, Actions policy and operator permissions |
| Manual tag dispatch skips publish | Expected: only a version-tag push publishes |
| Tag push has no run | Check event source, workflow at that tag, Actions policy and token recursion rules; do not move tags |
| Version/annotated-tag/main check fails | Fix in a reviewed new version; never repoint a published tag |
| Exact main CI unavailable | Wait for that commit's successful main push CI, not another run's green status |
| Native runner unavailable | Check quota/policy; do not silently drop an architecture |
| Build/native addon/smoke failure | Inspect the failing architecture and fix source; do not mix unrelated builds |
| GHCR write denied | Check packages:write, repository association and Manage Actions access |
| Anonymous read denied | Administrator audits/makes package public, then reruns only failed publish |
| Existing alias has different digests | Refuse overwrite; investigate and ship a new version |
| Registry tag existence cannot be established | An auth/network failure is not absence; restore reads before any push |
| Architecture receipt missing/expired | Verify this run's artifacts; do not borrow a similarly named artifact from another run |
| Asset upload interrupted | Rerun the failed job: matching bytes are retained and only missing files uploaded |
| Existing asset differs | Refuse `--clobber`; investigate and release corrected bytes under a new version |
| Release remains Draft | Finish asset verification first; do not manually publish an incomplete release |
| Customer cannot download layers | Check network/platform/registry policy; manifest access alone is insufficient |
| Installer refuses path or port | Use an empty independent directory/free port; do not clear or stop production |

```bash
gh run view "$RELEASE_RUN_ID" --repo "$REPO" --log-failed
gh run rerun "$RELEASE_RUN_ID" --repo "$REPO" --failed
gh run watch "$RELEASE_RUN_ID" --repo "$REPO" --exit-status
```

Do not rerun successful builds for an upload/visibility outage: mutable base
images or package mirrors may produce different bytes. Architecture receipts
are retained for 90 days. If the original inputs cannot be proven, do not
reconstruct an allegedly identical old release; use a reviewed new version.

## 8. Bad releases, offline delivery and retention

For a bad release, pause promotion/new installs, state affected scope and a safe
alternative, preserve tags/digests/assets/evidence and ship a forward fix through
all gates. Do not delete or overwrite published artifacts to hide a regression.
Old code must not open an upgraded DB without verified schema compatibility.
Restore into a new directory, preserve/reconcile post-snapshot data, then schedule
any traffic switch. Publication never automatically rolls back customer instances.

The maintainer's own gateway can be the first deployment target, but deployment
still needs its own approval and maintenance window. Non-kit installations must
use their own deployment/migration procedure; do not point this kit at an arbitrary
existing runtime directory. Single-instance upgrades restart the application.

For offline customers, export each target architecture on an isolated delivery host:

```bash
read -r -p 'Target architecture (amd64 or arm64): ' ARCH
case "$ARCH" in amd64|arm64) ;; *) exit 1 ;; esac
docker pull --platform "linux/$ARCH" "$IMAGE"
docker tag "$IMAGE" "siftgate-offline:$VERSION-$ARCH"
docker save -o "siftgate-$VERSION-$ARCH-image.tar" "siftgate-offline:$VERSION-$ARCH"
sha256sum "siftgate-$VERSION-$ARCH-image.tar" > "siftgate-$VERSION-$ARCH-image.tar.sha256"
```

Deliver the verified installer and matching platform image through a trusted
channel. The customer verifies, `docker load`s, then uses `init --image` with that
offline tag and `--local-image`. Record platform, commit, image ID and checksums.
Never `docker commit` a production container into a customer image.

Retain the published index **and every architecture digest it references**.
Deleting a child image because it only shows a build tag can break an existing
version. Keep old images/offline copies for the full recovery window. Image,
database backup and request-log retention are independent policies.

The current workflow provides digest pinning, native tests, OCI source labels,
an export allowlist and checksums. It does not claim Cosign signing, SBOMs, SLSA
attestations, container vulnerability blocking or automatic fleet upgrades.
Those require separate implementation/acceptance if enterprise policy demands them.

## 9. Release record and completion checklist

Record: version/tag; reviewed commit; PR/approval; exact main CI URL; dual-platform
run URL; both child digests; index digest; equal aliases; archive checksum;
anonymous/clean-host results; supported old→new migration evidence; downtime,
backup and recovery notes; known limitations; and the separately approved deployed
identity. Never record customer secrets or private database paths in public notes.

- [ ] Source, version, tag, image and installer identities agree.
- [ ] Full main CI and both architecture gates pass without exaggerated coverage.
- [ ] A public customer needs no maintainer credential and actual layer pulls work.
- [ ] Downloaded bytes match; no private config, secrets or production data are included.
- [ ] Upgrade/migration/backup/recovery/limitations are documented.
- [ ] Publication and deployment are recorded separately; no unapproved 2099 changes.

## Primary references

- [GHCR authentication and source association](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)
- [Package access and visibility](https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility)
- [Manual workflows and the default branch](https://docs.github.com/en/actions/managing-workflow-runs-and-deployments/managing-workflow-runs/manually-running-a-workflow)
- [Workflow triggers and GITHUB_TOKEN recursion](https://docs.github.com/en/actions/how-tos/writing-workflows/choosing-when-your-workflow-runs/triggering-a-workflow)
- [Docker multi-platform GitHub Actions](https://docs.docker.com/build/ci/github-actions/multi-platform/)
- [imagetools inspect](https://docs.docker.com/reference/cli/docker/buildx/imagetools/inspect/)
- [gh release create](https://cli.github.com/manual/gh_release_create)
- [gh release upload](https://cli.github.com/manual/gh_release_upload)

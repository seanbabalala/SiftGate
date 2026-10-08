# Release command card / 发布命令速查

Read the state gate in [中文手册](customer-release.zh-cn.md) /
[English runbook](customer-release.md) first. Bash only, in an isolated checkout.
Each block is a separate gate: **do not paste all blocks as one unattended script**.
当前为 S0 时只做审阅和修复；下面不能替代合并审批或正式发布授权。

## A. S1 preflight — read-only / 合入后只读检查

```bash
set -euo pipefail
export REPO=seanbabalala/SiftGate
export IMAGE_REPO=ghcr.io/seanbabalala/ai-gateway
git fetch origin main --tags
test "$(git branch --show-current)" = main
test -z "$(git status --porcelain)"
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"
for file in .github/workflows/customer-release.yml .github/workflows/customer-install.yml \
  deploy/customer/siftgate.py docs/customer-release.zh-cn.md scripts/check-node-runtime.js \
  scripts/check-customer-release-tag.py; do
  git cat-file -e "origin/main:$file"
done
npm run runtime:check
npm run release:check
export SOURCE_SHA="$(git rev-parse HEAD)"
export VERSION="$(node -p "require('./package.json').version")"
export TAG="v$VERSION"
gh run list --repo "$REPO" --workflow ci.yml --commit "$SOURCE_SHA" --event push --branch main --limit 5
read -r -p 'Exact successful main CI run ID: ' MAIN_CI_RUN_ID
test "$(gh run view "$MAIN_CI_RUN_ID" --repo "$REPO" --json headSha --jq .headSha)" = "$SOURCE_SHA"
gh run watch "$MAIN_CI_RUN_ID" --repo "$REPO" --exit-status
```

## B. S1 → S2 rehearsal — no publication / 仅演练

```bash
gh workflow run customer-release.yml --repo "$REPO" --ref main
gh run list --repo "$REPO" --workflow customer-release.yml --event workflow_dispatch --limit 5
read -r -p 'This rehearsal run ID: ' DRY_RUN_ID
gh run view "$DRY_RUN_ID" --repo "$REPO" --json headSha,event,status,conclusion
test "$(gh run view "$DRY_RUN_ID" --repo "$REPO" --json headSha --jq .headSha)" = "$SOURCE_SHA"
gh run watch "$DRY_RUN_ID" --repo "$REPO" --exit-status
```

## C. S2 approved publication — external changes / 需明确批准

```bash
test "$(git rev-parse HEAD)" = "$SOURCE_SHA"
test -z "$(git status --porcelain)"
test -z "$(git tag --list "$TAG")"
test -z "$(git ls-remote --tags origin "refs/tags/$TAG" "refs/tags/$TAG^{}")"
read -r -p "Type $TAG to authorize public image and Release publication: " APPROVED_TAG
test "$APPROVED_TAG" = "$TAG"
git tag -a "$TAG" "$SOURCE_SHA" -m "Release $TAG"
git push origin "refs/tags/$TAG"
gh run list --repo "$REPO" --workflow customer-release.yml --event push --limit 5
read -r -p 'This release run ID: ' RELEASE_RUN_ID
gh run watch "$RELEASE_RUN_ID" --repo "$REPO" --exit-status
```

## D. Failed publish only / 管理员处理首次 GHCR Public 后，仅重跑失败 job

```bash
gh run view "$RELEASE_RUN_ID" --repo "$REPO" --log-failed
gh run rerun "$RELEASE_RUN_ID" --repo "$REPO" --failed
gh run watch "$RELEASE_RUN_ID" --repo "$REPO" --exit-status
```

## E. S3 acceptance — use the extracted Release bundle / 不从源码目录省略 --image

```bash
export IMAGE_DIGEST="$(docker buildx imagetools inspect "$IMAGE_REPO:$TAG" --format '{{json .Manifest.Digest}}' | tr -d '"')"
export IMAGE="$IMAGE_REPO@$IMAGE_DIGEST"
DOCKER_CONFIG="$(mktemp -d)" docker manifest inspect "$IMAGE"
gh release view "$TAG" --repo "$REPO" --json isDraft,isPrerelease,assets
ACCEPTANCE_DIR="$(mktemp -d "$HOME/siftgate-release-check.XXXXXX")"
gh release download "$TAG" --repo "$REPO" --dir "$ACCEPTANCE_DIR" \
  --pattern "siftgate-$TAG-install.tar.gz" --pattern "siftgate-$TAG-install.tar.gz.sha256" \
  --pattern "siftgate-$TAG-release.json" --pattern "siftgate-$TAG-release.sigstore.jsonl"
cd "$ACCEPTANCE_DIR"
if command -v sha256sum >/dev/null; then CHECKSUM=sha256sum; else CHECKSUM='shasum -a 256'; fi
$CHECKSUM -c "siftgate-$TAG-install.tar.gz.sha256"
gh attestation verify "siftgate-$TAG-release.json" --hostname github.com --repo "$REPO" \
  --signer-workflow github.com/seanbabalala/SiftGate/.github/workflows/customer-release.yml \
  --cert-identity "https://github.com/seanbabalala/SiftGate/.github/workflows/customer-release.yml@refs/tags/$TAG" \
  --cert-oidc-issuer https://token.actions.githubusercontent.com \
  --source-ref "refs/tags/$TAG" --source-digest "$SOURCE_SHA" --deny-self-hosted-runners \
  --predicate-type https://slsa.dev/provenance/v1 --bundle "siftgate-$TAG-release.sigstore.jsonl"
python3 -c 'import hashlib,json,os; from pathlib import Path; t=os.environ["TAG"];m=json.load(open("siftgate-"+t+"-release.json"));p=Path("siftgate-"+t+"-install.tar.gz");assert m["tag"]==t and m["installer"]["name"]==p.name and m["installer"]["bytes"]==p.stat().st_size and m["installer"]["sha256"]==hashlib.sha256(p.read_bytes()).hexdigest()'
tar -xzf "siftgate-$TAG-install.tar.gz"
cd "siftgate-$TAG"
$CHECKSUM -c SHA256SUMS
test -f siftgate.py
test -f release.json
python3 -c 'import json,os; r=json.load(open("release.json")); assert r["version"]==os.environ["TAG"] and r["commit"]==os.environ["SOURCE_SHA"] and r["image"]==os.environ["IMAGE"]'
python3 siftgate.py --directory "$HOME/siftgate-release-acceptance" init --timezone Asia/Shanghai --port 21099
python3 "$HOME/siftgate-release-acceptance/kit/siftgate.py" --directory "$HOME/siftgate-release-acceptance" up
```

Stop here and finish both native-platform request/backup/restore and supported-version
migration checks in the full runbook before claiming customer readiness.
No block upgrades an existing 2099 instance. A reused acceptance directory or occupied
port must be investigated, never cleared by deleting production files or killing services.

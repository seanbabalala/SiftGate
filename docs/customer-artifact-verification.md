# Verify a signed customer release / 校验客户发行

For **v2.12.0 and later**, obtain all four assets from the same public GitHub
Release: `siftgate-vX.Y.Z-install.tar.gz`, its `.sha256`,
`siftgate-vX.Y.Z-release.json`, and `siftgate-vX.Y.Z-release.sigstore.jsonl`.
Use a separately trusted GitHub CLI **2.86+** before executing downloaded kit code.
A checksum alone is not publisher authentication. Use an actually published tag;
a development candidate or a source tag alone is not a download promise.

对于v2.12.0及以后版本，需要同一公开Release的安装包、校验和、发行清单与Sigstore证明。
先通过独立可信渠道取得GitHub CLI2.86+，不要先执行尚未核验的下载脚本。校验和不是
发行者身份验证，开发候选或单独源码tag不代表镜像已经发布。

In Bash, in the directory containing the downloaded assets:

```bash
set -euo pipefail
TAG=vX.Y.Z # Replace with the exact public release / 换成确切公开版本
PREFIX="siftgate-${TAG}"
SOURCE_COMMIT="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["source_commit"])' "${PREFIX}-release.json")"
gh attestation verify "${PREFIX}-release.json" \
  --hostname github.com --repo seanbabalala/SiftGate \
  --cert-identity "https://github.com/seanbabalala/SiftGate/.github/workflows/customer-release.yml@refs/tags/${TAG}" \
  --cert-oidc-issuer https://token.actions.githubusercontent.com \
  --source-ref "refs/tags/${TAG}" --source-digest "$SOURCE_COMMIT" \
  --deny-self-hosted-runners --predicate-type https://slsa.dev/provenance/v1 \
  --bundle "${PREFIX}-release.sigstore.jsonl"
python3 - "$TAG" <<'PY'
import hashlib,json,re,sys
from pathlib import Path
tag=sys.argv[1]
assert re.fullmatch(r'v\d+\.\d+\.\d+',tag)
manifest=json.loads(Path('siftgate-'+tag+'-release.json').read_text())
assert manifest['format']=='siftgate-release-v2' and manifest['tag']==tag
assert manifest['repository']=='seanbabalala/SiftGate'
name='siftgate-'+tag+'-install.tar.gz'; archive=Path(name)
assert manifest['installer']['name']==name
assert 0<archive.stat().st_size==manifest['installer']['bytes']<=64*1024*1024
sha=hashlib.sha256(archive.read_bytes()).hexdigest()
assert sha==manifest['installer']['sha256']
assert Path(name+'.sha256').read_text().strip()==sha+'  '+name
print('Publisher-bound installer bytes verified; no installation performed.')
PY
```

Only after this succeeds extract into a **new empty directory**, inspect the
matching instructions, and initialize a new install. Do not overwrite a source
checkout or existing installation. The nested `release.json` pins the image;
the signed outer manifest also binds both native image configuration digests.
The canonical repository is `seanbabalala/SiftGate`, while the established image
namespace remains `ghcr.io/seanbabalala/ai-gateway`.

全部通过后，才解压到新的空目录，并按配套手册初始化。不要覆盖现有安装/源码目录。
包内`release.json`固定镜像，外层签名清单同时绑定双架构配置摘要。仓库已更名为SiftGate，
镜像命名空间仍保持ai-gateway，不要擅自改镜像地址。

Offline verification uses a previously trusted verifier and separately pinned
trusted roots with `--custom-trusted-root`. See [Control offline workflow](customer-control.md).
A package cannot supply its own trust anchor. Legacy v2.11.7 did not publish this
signed lifecycle contract; follow that release's bundled legacy instructions
and explicitly bootstrap verified newer host tools before enabling management.

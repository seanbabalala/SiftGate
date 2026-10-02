# 正式镜像发布手册

本文面向维护者，覆盖首次发布、日常发布、验收、失败续传和问题版本处置。
客户安装见 [客户安装与运维](customer-install.zh-cn.md)，英文版见
[Release runbook](customer-release.md)。执行事实以
[`customer-release.yml`](../.github/workflows/customer-release.yml) 为准。

**这是一份操作手册，不是发布授权。** 合并、推送版本 tag、公开 GHCR 包、发布 Release
和升级生产实例都是有外部影响的动作，需要维护者明确决定。阅读、修改或推送本文不会
触发发布；镜像发布也不会自动升级正在使用的 2099。

本文命令按 **Bash** 编写。Mac 默认使用 zsh 的维护者先运行 `bash`，并在同一发布终端
保留后续导出的版本、提交和镜像变量；不要在变量未设置时直接跳到中间步骤执行。

## 1. 什么才算“发布完成”

一次正式发布必须同时具备：

| 对象 | 要求 |
| --- | --- |
| 源码 | 审核后的 `main` 提交及其 annotated Git tag，例如 `v2.11.6` |
| 完整 CI | 这个**确切提交**在 `main` 上的 push CI 成功，不是另一个提交的绿灯 |
| 架构镜像 | 原生 Linux AMD64、ARM64 分别构建并通过安装验收 |
| 镜像索引 | GHCR 多架构 index 指向这次验收的两个不可变 digest |
| 标签 | `v2.11.6` 与 `2.11.6` 两个镜像标签解析到同一 index digest |
| 安装包 | `siftgate-v2.11.6-install.tar.gz` 和相应 `.sha256` 附件 |
| 身份 | 安装包内 `release.json` 的 commit、version、image digest 与发布记录一致 |
| 可下载性 | 不登录 GitHub/Docker 也能读取公共镜像 manifest；在干净机器实际拉取并安装 |
| 发布说明 | 变更、迁移、测试证据、已知限制、回滚边界明确 |

表中的 `2.11.6` 只是示例，**不表示该版本已经发布**。版本必须由维护者审核确定。
不能仅凭“代码推送成功”“本机有镜像”“GitHub Actions 某个测试成功”宣布正式发布。

### 命名规则

```text
Git tag:          v2.11.6
Registry:         ghcr.io
Image repository: ghcr.io/seanbabalala/ai-gateway
Version aliases:  ghcr.io/seanbabalala/ai-gateway:v2.11.6
                  ghcr.io/seanbabalala/ai-gateway:2.11.6
Production pin:   ghcr.io/seanbabalala/ai-gateway@sha256:<index digest>
Build staging:    build-<workflow run id>-<attempt>-<architecture>
Platforms:       linux/amd64, linux/arm64
```

不带 `v` 的别名用于兼容已有 Helm `appVersion` 和 Kustomize 镜像配置；带 `v` 的别名
与 Git tag 对齐。两者必须一致，正式安装包直接使用 digest。**不发布或移动 `latest`**。
构建暂存标签不是客户安装入口，不能把本机测试标签当作公共镜像地址。

## 2. 首次发布的一次性准备

### 2.1 仓库与操作账户

以下命令在独立发布 checkout 执行，不在正在运行服务的目录里构建或安装依赖：

```bash
export REPO=seanbabalala/ai-gateway
export IMAGE_REPO=ghcr.io/seanbabalala/ai-gateway
gh auth status
gh api "repos/$REPO" --jq '{default_branch,visibility,archived}'
gh api "repos/$REPO/actions/permissions" --jq '{enabled,allowed_actions}'
```

维护者需要仓库写入/tag 创建权限；查看或修改包设置另需对应包的管理权限。
GitHub CLI 登录使用自己的授权流程，禁止把 token 写在文档、命令参数、日志或 Git 中。
流水线使用 GitHub 提供的短期 `GITHUB_TOKEN`，不需要配置个人 PAT 才能正常发布。

### 2.2 GitHub Actions 设置

检查仓库 **Settings → Actions → General**：

- Actions 已启用，组织策略允许使用本仓库工作流引用的官方 actions。
- 有可用的 `ubuntu-24.04` 和 `ubuntu-24.04-arm` 原生 runner，以及足够运行额度。
- 工作流声明的 `contents`、`packages`、`actions` 权限未被上级策略禁止。
- 不需要为方便而把所有工作流全局改成高权限；发布工作流按 job 声明所需权限。
- `verify` 需要读取代码、读取 CI 状态，以及在版本 tag 发布时写 GHCR；`publish`
  需要写 GHCR 和 GitHub Release。只允许可信代码进入正式发布分支。

建议保护 `main` 和 `v*` tag：先审查 PR、要求 CI，通过明确的维护者操作创建版本 tag。
不要为了让发布成功绕过保护规则或使用 `--admin` 强行合并。

### 2.3 让发布工作流先进入默认分支

GitHub 的 `workflow_dispatch` 要求工作流文件存在于默认分支。首次添加工作流时，
它仅在功能分支并不意味着 Actions 页面已经能点 **Run workflow**。
先审查并把工作流及安装工具合入 `main`，然后再进行正式版本演练。

手动运行是**只测试**：即使选择的是一个 tag，也不能发布镜像或 Release。
只有 `push` 事件中的 `refs/tags/v*` 才会进入发布步骤。

### 2.4 GHCR 包权限与可见性

目标包是 `ghcr.io/seanbabalala/ai-gateway`，不是 Docker Hub，也不是另一套镜像名。
OCI `org.opencontainers.image.source` 标签把镜像关联到源码仓库。

如果包已存在，打开包的 **Package settings**：

1. 检查关联的源码仓库是否正确。
2. 在 **Manage Actions access** 中允许此仓库的工作流写入该包；必要时检查继承权限。
3. OSS 公共分发要求包可匿名读取。首次 push 后新包可能仍为 Private，不能因为仓库
   是 Public 就认定镜像也是 Public。
4. 公开前确认所有镜像层都没有真实密钥、数据库、客户配置或私有文件。
5. 由包管理员将包设为 Public；不要把“公开包”当成一般排障的无风险动作。

流水线会用临时空 Docker 认证目录检查匿名 manifest 访问。如果首次发布在这里失败，
先修正包可见性，再**只重跑失败 job**；不要重建已经验收的两个架构来碰运气。
私人镜像分发需要另外设计客户凭证和发布策略，不能直接删除匿名检查来冒充公共发行。

## 3. 准备一个正式版本

### 3.1 使用干净的隔离 checkout

```bash
git clone "https://github.com/$REPO.git" "$HOME/siftgate-release"
cd "$HOME/siftgate-release"
git fetch origin --tags
git status --short
```

选择已审查的候选分支继续工作；不要默认 `main` 已包含尚未合并的新功能。当前安装工具
和计价候选的合并属于代码审查的一部分，不是发布脚本会替你完成的操作。
如目录已经存在，先检查其用途，不覆盖、不清空、不对运行目录执行 `git reset --hard`。

### 3.2 同步版本元数据

按 [Release checklist](RELEASE_CHECKLIST.md) 修改这些位置：

| 文件 | 要同步的内容 |
| --- | --- |
| `package.json` | 根 version |
| `package-lock.json` | 顶层、根包、`packages/client` 的 version |
| `frontend/package.json`、`frontend/package-lock.json` | 前端及 lock 根包 version |
| `packages/client/package.json` | TypeScript SDK version |
| `packages/python/pyproject.toml` | Python 包 version |
| `deploy/helm/siftgate/Chart.yaml` | version、appVersion |
| `deploy/kubernetes/base/deployment.yaml` | 不带 `v` 的镜像 tag |
| `src/openapi/setup-openapi.ts` | OpenAPI version |
| `test/unit/release-version-sync.spec.ts` | 本轮版本断言 |
| `README.md` | 当前发行版、徽章、Release 链接 |
| `CHANGELOG.md` | 新版本条目与真实发布日期 |
| `docs/BASELINE.md` | 发行基线与证据 |

不要对历史文档全局替换旧版本，也不要以为单独执行一次 `npm version` 就完成所有同步。
版本号不在本文替维护者决定，不能复用已发布版本号或移动旧 tag。

### 3.3 发布前验证

在该隔离 checkout 使用 Node 22 及锁文件安装依赖：

```bash
npm ci
npm --prefix frontend ci
npm run release:hardening -- --dry-run
npm run release:hardening
npm run test:customer
git diff --check
```

`release:hardening` 包含后端、前端、SDK、配置、文档、依赖审计及版本检查，不含真实
生产请求。PostgreSQL 相关声明还要补隔离 PostgreSQL 验证；不得把生产 `DATABASE_URL`
传给测试。已知性能或功能偏差要明确记录在发布说明，不能把例外写成全部达标。

需要本地客户安装烟测时，只使用隔离测试实例：

```bash
export DOCKER_HOST="unix://$HOME/.rd/docker.sock"
docker build -t siftgate:release-review .
npm run smoke:customer -- --image siftgate:release-review
```

上面的 socket 只适用于使用该 Moby socket 的 Rancher Desktop 主机；Linux 选择自己的
本地 Docker context/socket。不要运行 `docker context use` 改坏其他项目的环境。
测试不会复用生产名称、端口、密钥或数据；测试完成会删除自己创建的容器。

### 3.4 审查、合并并等待确切提交的主分支 CI

提交、推送审核过的变更，创建/更新 PR。PR 应包含版本、范围、测试、迁移、回滚、限制。
通过审查后按仓库正常合并策略合入 `main`；不要用 force push 代替合并。

在发布 checkout 更新并确认目标提交：

```bash
git switch main
git pull --ff-only origin main
export SOURCE_SHA="$(git rev-parse HEAD)"
export VERSION="$(node -p "require('./package.json').version")"
export TAG="v${VERSION}"
test -z "$(git status --porcelain)"
npm run release:check
gh run list --repo "$REPO" --workflow ci.yml --commit "$SOURCE_SHA" --event push --branch main --limit 5
```

选中该提交的 `CI` run，使用实际 ID 观察：

```bash
read -r -p 'Exact main CI run ID: ' MAIN_CI_RUN_ID
gh run watch "$MAIN_CI_RUN_ID" --repo "$REPO" --exit-status
```

镜像发布工作流也会检查此条件；它不会因为上一轮或另一个分支有绿灯而放行。
如果主分支后来继续前进，仍要记录和审核本次实际 tag 指向的确切提交。

## 4. 先做不发布的双架构演练

工作流已经存在于默认分支后，可在 Actions 页面选择 **Customer multi-platform release**
并 Run workflow，或执行：

```bash
gh workflow run customer-release.yml --repo "$REPO" --ref main
gh run list --repo "$REPO" --workflow customer-release.yml --event workflow_dispatch --limit 5
```

选择刚创建的 run，核对 `headSha` 与待发布提交，再等待：

```bash
read -r -p 'Dry-run workflow run ID: ' DRY_RUN_ID
gh run view "$DRY_RUN_ID" --repo "$REPO" --json headSha,event,status,conclusion
gh run watch "$DRY_RUN_ID" --repo "$REPO" --exit-status
```

此演练构建原生 AMD64、ARM64 并运行烟测，不登录 GHCR、不 push 镜像、不创建 Release。
`publish` job 显示 skipped 是正确结果。只在 Mac ARM64 成功不等于 AMD64 也成功。

烟测覆盖：初始化、HTTP readiness、随机密码登录、后台配置原子保存、Gateway key、
mock 上游请求、WAL 安全备份、同代码不同镜像替换、重启、独立目录恢复、时区与会话/Key/
日志保留、停止后看门狗不擅自拉起。它不是任意跨版本数据库迁移、零停机或所有 Linux
发行版兼容性的证明。实际旧版本→新版本的业务数据迁移仍需单独彩排。

## 5. 正式发布：推送审核后的 annotated tag

**从这里开始会公开发布镜像和附件。执行前必须有维护者的明确发布决定。**

重新确认 `SOURCE_SHA`、`VERSION`、`TAG` 和 CI。先检查本地及远端没有同名 tag：

```bash
test "$(git rev-parse HEAD)" = "$SOURCE_SHA"
test -z "$(git status --porcelain)"
test -z "$(git tag --list "$TAG")"
test -z "$(git ls-remote --tags origin "refs/tags/$TAG" "refs/tags/$TAG^{}")"
git tag -a "$TAG" "$SOURCE_SHA" -m "Release $TAG"
git show --no-patch "$TAG"
git push origin "refs/tags/$TAG"
```

命令不使用 `-f` 或 `--tags`，只推这一枚 tag。不要把打 tag 和重启生产绑定在一起。
如果使用签名 tag，可在建立组织签名验证流程后选择 `git tag -s`；当前流水线验证
annotated tag 类型，不自动验证 GPG 签名策略。

由另一个工作流通过 `GITHUB_TOKEN` 推送 tag 通常不会再触发新的工作流，以避免递归。
本手册使用维护者的正常 Git 推送；不要指望一个内部自动 tag 步骤绕过发布审批。

### 流水线执行顺序

1. 确认 tag 与根版本一致，是 annotated tag，提交属于 `main`，该提交主分支 CI 成功。
2. 两台原生 runner 分别构建，写入源码仓库、commit、版本和许可证 OCI 标签。
3. 每个架构运行真实客户安装验收；失败就不进入公共版本组合。
4. 成功架构上传到本次 run/attempt 专属构建标签，并把 digest、architecture、commit
   保存成 `customer-image-amd64` / `customer-image-arm64` Actions artifacts。
5. `publish` 只读取**本次 run 的固定 digest**，不重新读取一个可能移动的旧构建标签。
6. 创建 `vVERSION`、`VERSION` 两个别名；已有版本只能接受相同子镜像 digest，不能覆盖。
7. 检查两个别名 index digest 一致、公共 manifest 可以匿名读取。
8. 从确切 Git commit 的文件白名单生成安装包和 SHA-256 文件。
9. 新 GitHub Release 先建 Draft；核对已有附件、补传缺失附件、下载复核字节，再公开。
10. Job summary 输出源码 commit、index/架构 digest、别名和压缩包 SHA-256，作为发布记录。

alpha/beta/rc 按 `vX.Y.Z-rc.N` 等形式发布，会标记为 prerelease，不冒充稳定发行。
不要在 tag 流水线完成前手工创建一个空的公开 Release 然后宣布可安装。

## 6. 发布后独立验收

### 6.1 Actions 与身份

```bash
gh run list --repo "$REPO" --workflow customer-release.yml --event push --limit 10
read -r -p 'Release workflow run ID: ' RELEASE_RUN_ID
gh run watch "$RELEASE_RUN_ID" --repo "$REPO" --exit-status
gh release view "$TAG" --repo "$REPO" --json tagName,isDraft,isPrerelease,publishedAt,assets
```

必须确认两个 `verify` 和 `publish` 全部 success，Release 不是 Draft，附件成对存在。
必要时下载 digest artifacts，与 job summary 一起归档：

```bash
mkdir -p "$HOME/siftgate-release-evidence/$TAG"
gh run download "$RELEASE_RUN_ID" --repo "$REPO" \
  --pattern 'customer-image-*' --dir "$HOME/siftgate-release-evidence/$TAG/architectures"
```

### 6.2 验证多架构和匿名可访问

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

manifest 应包含 `linux/amd64` 与 `linux/arm64`。上述临时目录是空 Docker 认证目录，
不会清除维护者原有登录状态；检查完可删除这个由本次操作创建的空目录。
匿名 manifest 检查不等于已经拉取所有 layer，下一步还要在干净机器实际安装。

### 6.3 下载并校验客户安装包

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
print('Release version, commit, image digest and file checksums match.')
PY
```

Mac 将两处 `sha256sum -c` 换成 `shasum -a 256 -c`。客户可从公共 Release 页面直接
下载，不需要 `gh` 登录；维护者使用 `gh` 是为了方便保存审计证据。
校验和检测损坏/不一致，不等价于代码签名、软件供应链 attestation 或安全审计。

### 6.4 用实际公开包在干净机器安装

分别选一台 AMD64、一台 ARM64 测试机，使用没有历史容器、密钥和配置的新目录：

```bash
python3 siftgate.py --directory "$HOME/siftgate-release-acceptance" init \
  --timezone Asia/Shanghai --port 21099
python3 "$HOME/siftgate-release-acceptance/kit/siftgate.py" \
  --directory "$HOME/siftgate-release-acceptance" up
python3 "$HOME/siftgate-release-acceptance/kit/siftgate.py" \
  --directory "$HOME/siftgate-release-acceptance" doctor
python3 "$HOME/siftgate-release-acceptance/kit/siftgate.py" \
  --directory "$HOME/siftgate-release-acceptance" status
```

不要把这个验收目录指向现网，21099 也必须事先空闲。按安装手册验证登录、后台保存、
自有测试上游与 Key、预算、日志、备份和另一个新目录恢复。不要用客户生产密钥做烟测。
再针对已支持的旧版本做真实升级/数据迁移彩排，记录源版本和目标版本，不只测同代码
镜像替换。全部通过后才宣布“客户可安装”。

## 7. 常见失败与安全续传

| 现象 | 排查与处理 |
| --- | --- |
| 没有 Run workflow 按钮 | 确认工作流已在默认分支，Actions 开启，账户有权限 |
| 手动跑 tag 但 publish skipped | 正常；手动运行只测试，正式发布由维护者推送 tag 触发 |
| tag 推送没有触发 | 核对事件来源、Actions 策略和工作流是否在该 tag；不要移动 tag |
| version mismatch | 修复版本同步，重新审查新提交；不能让旧 tag 偷偷改指向 |
| annotated tag 检查失败 | lightweight tag 不满足发布规则；已推送 tag 不强行重写，使用新版本 |
| main CI gate 失败 | 等待确切提交的 main push CI 成功；不能拿 PR merge-ref 或旧提交绿灯代替 |
| AMD64/ARM64 runner 排队/不可用 | 检查账户额度、组织 runner 策略；不删除一个架构检查来伪装通过 |
| 编译、原生模块或烟测失败 | 查看失败架构日志，在新代码提交修复；不把不同架构层手工拼在一起 |
| GHCR `denied` / `permission_denied` | 检查 job packages:write、包与仓库关联、Manage Actions access |
| 登录可读但匿名检查失败 | 包管理员核对 Public 可见性，然后仅重跑失败的 publish job |
| index 或别名已存在且不同 | 拒绝覆盖；调查来源，发布新版本，不移动旧 digest/tag |
| 无法确定 registry tag 是否存在 | 认证/网络错误不是不存在的证据；先恢复读取，不能直接 push 覆盖 |
| 缺少架构 artifact | 核对本次 run 的两个 verify 及 artifact 保留期；不从另一个 run 凭名字借结果 |
| 附件上传中断 | 固定原 run、commit 和 digest，重跑失败 job；脚本验证相同附件并只上传缺失项 |
| 已有附件字节不同 | 脚本会拒绝，不 `--clobber`；调查并发布修正版，不静默替换公开内容 |
| Release 仍为 Draft | 附件或校验没有完成；先恢复流程，不能直接把开关改公开掩盖错误 |
| 客户无法拉 layer | 检查 GHCR 网络、架构及凭证策略；匿名 manifest 成功不代表客户网络可达 |
| 安装器拒绝路径/端口 | 换独立新目录或空闲端口；不要清理生产目录或杀掉占用服务 |

安全重跑命令：

```bash
gh run view "$RELEASE_RUN_ID" --repo "$REPO" --log-failed
gh run rerun "$RELEASE_RUN_ID" --repo "$REPO" --failed
gh run watch "$RELEASE_RUN_ID" --repo "$REPO" --exit-status
```

不要为可见性或网络问题重跑成功的构建：基础镜像或安装源可能随时间变化，重建会产生
不同 digest。流程保留原 run 的架构 artifact 90 天；超过保留期或无法证明原 digest
来源时，不重拼一个“看起来一样”的发行版，走新的受审版本。

## 8. 出问题的正式版本怎么处理

- 暂停推广和新客户安装，明确通知受影响范围和安全替代版本。
- 保留已发布 tag、digest、附件和原始证据，不 force push、不覆盖标签、不删附件掩盖问题。
- 发布新的修复版本，重新走全部门禁；不要对旧版本名重新 build/push。
- 镜像回退不代表数据库能回退。保留新数据，检查 schema 兼容性，按安装手册在新目录
  恢复、对账，再安排切流。不能让旧程序直接打开已经升级的数据库。
- 不应通过删除 registry 中的镜像强迫客户回退，既有实例不由发布流水线管理。

**发布与部署分离**：维护者本机可以是第一个部署对象，但升级也要单独批准并安排窗口。
已有非 customer-kit 布局的实例要沿用或迁移自己的部署方案，不能直接把示例
`--directory` 改成它的目录硬套。单机升级会重启，不是无中断更新。

## 9. 离线交付、保留和供应链边界

无 GHCR 网络的客户需要对应架构的离线镜像及已验证安装包。以下仅在隔离交付机执行，
`ARCH` 选择客户实际架构；不要把生产容器 `docker commit` 成客户镜像：

```bash
read -r -p 'Target architecture (amd64 or arm64): ' ARCH
case "$ARCH" in amd64|arm64) ;; *) exit 1 ;; esac
docker pull --platform "linux/$ARCH" "$IMAGE"
docker tag "$IMAGE" "siftgate-offline:$VERSION-$ARCH"
docker save -o "siftgate-$VERSION-$ARCH-image.tar" "siftgate-offline:$VERSION-$ARCH"
sha256sum "siftgate-$VERSION-$ARCH-image.tar" > "siftgate-$VERSION-$ARCH-image.tar.sha256"
```

客户先校验、`docker load`，再使用安装器的 `--image siftgate-offline:版本-架构
--local-image`。离线镜像是平台专属的，不能把 ARM64 包交给 AMD64 并声称已验证。
保留离线交付的版本、平台、镜像 ID、commit 和校验和；与安装包一起通过可信渠道交付。

保留公共 index **以及它引用的两个架构 digest**。不要因为架构镜像显示为构建暂存标签
就把它删除；删除被 index 引用的子镜像会破坏已发布版本。客户也需保留恢复窗口内的
旧镜像和数据库备份。镜像保留策略、数据库备份策略和日志轮转是三件不同的事。

当前流水线有版本/digest 固定、双架构烟测、来源 OCI 标签、文件白名单和校验和。
它没有宣称已实现 Cosign 签名、SBOM、SLSA 证明、镜像漏洞阻断或集中式自动升级；如果
企业要求这些能力，应另行建设并验收，不能把普通 SHA-256 文件称为供应链签名。

## 10. 发布记录模板与最终勾选

将下面字段保存在 Release 说明及内部变更记录，不填写真实客户密钥或数据路径：

```text
Version / Git tag:
Reviewed source commit:
PR and maintainer approval:
Exact main CI run URL:
Dual-architecture release run URL:
linux/amd64 child digest:
linux/arm64 child digest:
Multi-platform index digest:
v-prefixed and bare version aliases match:
Installer archive SHA-256:
Anonymous registry and clean-host installation results:
Supported old-version upgrade rehearsal:
Database migration / downtime / backup / rollback notes:
Known limitations and accepted exceptions:
Deployment approval and actual deployed identity (separate from publication):
```

- [ ] 版本、提交、tag、镜像、安装包身份一致。
- [ ] 完整 main CI 与两个架构门禁通过，测试范围没有被夸大。
- [ ] 公共客户无需维护者私有凭证，实际 layer 拉取与安装成功。
- [ ] 所有附件字节校验一致，无生产配置、数据和密钥。
- [ ] 发布说明包含升级、迁移、备份、回滚和已知限制。
- [ ] 镜像已经发布和实例已经部署分开记录；没有擅自修改 2099。

## 官方参考

- [GHCR 权限、认证与源码关联](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)
- [包访问控制与可见性](https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility)
- [手动工作流与默认分支](https://docs.github.com/en/actions/managing-workflow-runs-and-deployments/managing-workflow-runs/manually-running-a-workflow)
- [事件与 GITHUB_TOKEN 触发限制](https://docs.github.com/en/actions/how-tos/writing-workflows/choosing-when-your-workflow-runs/triggering-a-workflow)
- [Docker 多架构 GitHub Actions](https://docs.docker.com/build/ci/github-actions/multi-platform/)
- [imagetools inspect](https://docs.docker.com/reference/cli/docker/buildx/imagetools/inspect/)
- [gh release create](https://cli.github.com/manual/gh_release_create)
- [gh release upload](https://cli.github.com/manual/gh_release_upload)

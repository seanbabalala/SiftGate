# 客户安装与运维

从v2.12.0开始，除安装包/校验和，还应下载发行清单及Sigstore证明。**执行下载的kit代码前，先按[发行校验](customer-artifact-verification.md)核验发行者与安装包字节**；受管生命周期功能需要独立可信的GitHub CLI2.86+。自行构建的未纳管安装属于安装账户自己承担的信任路径，不等于发行者验证。

独立升级、恢复演练、角色审批与离线/Fleet流程见[Control Room](customer-control.zh-cn.md)。这些功能明确启用，不会自动纳管或升级已有2099。

> **版本边界**：首次激活和本机恢复属于2.12.0起的客户工具。
> v2.11.7 安装包仍使用其版本内的随机初始密码流程。请使用与镜像配套的 Release
> 安装包及文档，不要拿新版 `init` 工具搭配 v2.11.7 镜像。升级现有旧身份实例
> 不会自动迁移身份，也不会重置原密码或开启认领。

这是**全新独立安装**工具，不是维护者本机迁移包。安装包不包含任何真实供应商
密钥、客户 API Key、历史数据库或机器专属配置。现有实例不得用 `init` 覆盖。

## 安装前

- Linux：Docker Engine、Compose 2.30+、Python 3.9+ 和系统时区数据库。
- Mac：可用 Rancher Desktop 的 Moby 引擎；Linux 客户不需要 Rancher Desktop。
- 数据放本地磁盘的独立目录；Mac 避开 Desktop/Documents/Downloads，确保 Docker VM
  共享该目录。不要用网络盘存 SQLite，也不要把安装目录提交进 Git。
- 所有命令使用同一个安装账户。Docker 权限等价于高权限主机访问。
- 仓库里有安装工具，不代表某个新版镜像已发布。正式下载必须以实际 GitHub Release
  为准；下面的 `vX.Y.Z` 是版本占位符。源码测试需要自己构建镜像并指定 `--image`。

## 正式安装

下载对应版本的安装压缩包及 `.sha256` 文件，校验、解压：

```bash
sha256sum -c siftgate-vX.Y.Z-install.tar.gz.sha256
# Mac 可改用 shasum -a 256 -c
tar -xzf siftgate-vX.Y.Z-install.tar.gz
cd siftgate-vX.Y.Z
sha256sum -c SHA256SUMS

python3 siftgate.py --directory "$HOME/siftgate" init --timezone Asia/Shanghai
python3 "$HOME/siftgate/kit/siftgate.py" --directory "$HOME/siftgate" up
```

Rancher Desktop 如需显式选择 Moby，在 `init` 增加
`--docker-host "unix://$HOME/.rd/docker.sock"`；不会修改全局 Docker context。
默认端口仍为 **2099**，仅绑定本机 `127.0.0.1`。端口已占用会拒绝，不会杀掉原服务。
第二套实例可指定 `--port 21099`。`init` 只初始化，`up` 才正式启动。

打开 `http://localhost:2099/dashboard`，在安装服务器的私有终端读取**单次激活码**：

```bash
cat "$HOME/siftgate/config/activate-code.txt"
```

激活码 15 分钟有效，仅可使用一次；在页面设置自己的管理员密码，然后重新登录。
没有通用默认密码。激活码消费后删除，备份不收录明文码；身份文件仅保存哈希和会话
签名密钥。配置、环境变量、身份文件和备份仍须保密。所有新安装示例节点以 `disabled: true` 显式禁用：在后台配置供应商及其密钥，
核对模型计价、路由和预算，再启用节点、创建自己的 Gateway API Key、发送测试请求。
示例价格不保证是供应商现行价格。告警接收地址由客户自行配置。

服务器部署使用 `init --mode https`，自行配置域名、HTTPS 反向代理和防火墙。
这个选项会启用 Secure 会话 Cookie，**并不自动申请证书或把 2099 变成 HTTPS**。
`--bind 0.0.0.0` 仅在 HTTPS 模式允许，仍需可信入口保护；不要裸露管理后台。

激活并登录后进入 **首次上手（Launchpad）**，按“环境 → 模型 → 受限 Key → 真实调用回执”完成接入。
真实测试必须主动确认可能产生的费用；准备和检查回执不调用模型。见 [上手说明](customer-launchpad.zh-cn.md)。
旧安装包的 `enabled:false` 曾被忽略；本版不重新解释该历史字段，以免升级后停服。

## 激活过期 / 忘记管理员密码

安装账户在服务器执行以下命令签发新码；只返回私有文件路径，不直接打印码值，
**不会重启网关**。`activate` 仅用于未激活实例；已激活实例使用 `recover`。

```bash
python3 "$HOME/siftgate/kit/siftgate.py" --directory "$HOME/siftgate" access-code --purpose activate --confirm
cat "$HOME/siftgate/config/activate-code.txt"
# 忘记密码时，改为：
python3 "$HOME/siftgate/kit/siftgate.py" --directory "$HOME/siftgate" access-code --purpose recover --confirm
cat "$HOME/siftgate/config/recover-code.txt"
```

每次重签都会使旧码失效；不要把码放进 URL、工单、邮件或聊天。恢复码通过登录页
“忘记密码？”填写。已登录时通过页头盾牌进入安全设置，验证旧密码后修改。
改密或恢复后所有旧控制台会话失效，供应商凭据、Gateway API Key 与业务数据不变。
密码为 15 个以上字符、至多 72 个 UTF-8 字节；长口令和密码管理器均可用。

本阶段是**本地单实例管理员**，不等于已实现独立多用户。显式配置
`dashboard.identity_file`，不能与旧 `password`、`session_secret`、免认证或已启用
OIDC 混用；不接受工作空间邀请。旧密码/OIDC 模式继续原流程，尚无自动身份迁移。
身份文件缺失/损坏时拒绝访问，不自动重新认领。详见 [P0 身份边界](customer-identity.zh-cn.md)。

## 日常操作

```bash
python3 "$HOME/siftgate/kit/siftgate.py" --directory "$HOME/siftgate" doctor
python3 "$HOME/siftgate/kit/siftgate.py" --directory "$HOME/siftgate" status
python3 "$HOME/siftgate/kit/siftgate.py" --directory "$HOME/siftgate" backup --accept-downtime --keep 7
```

配置目录、数据库和状态独立持久化；日志默认保留 30 天。完整备份会**短暂排空并停止
本实例**，调用 SQLite 备份接口，连同配置、环境变量和保留状态一起校验保存，然后
恢复原本运行的实例。不能对正在使用 WAL 的数据库直接 `cp`。

`--keep 7` 只轮转本实例经过校验的普通备份，不删损坏、未知或升级恢复点。
升级恢复点需确认过恢复窗口后自行清理，并把重要备份加密保存在另一台机器。
备份失败可能保留停机状态与 `maintenance` 标记，需检查后恢复，不会掩盖失败。

升级使用明确的已发布镜像：

```bash
python3 "$HOME/siftgate/kit/siftgate.py" --directory "$HOME/siftgate" upgrade \
  --image ghcr.io/seanbabalala/ai-gateway@sha256:RELEASE_DIGEST --accept-downtime
```

先拉镜像并验证配置，再停机、做恢复点、启动候选、检查 HTTP。**单机升级会有短暂
中断，不是零停机，也不是无人确认的自动升级。** 环境变量的修改同样需要计划重建容器。
安装后不要随意更改时区，它会影响日预算边界。

## 安全恢复

只恢复到一个新目录，先使用另一个端口：

```bash
python3 "$HOME/siftgate/kit/siftgate.py" --directory "$HOME/siftgate-recovery" restore \
  --backup "$HOME/siftgate/backups/backup-SNAPSHOT_ID" --port 21099
python3 "$HOME/siftgate-recovery/kit/siftgate.py" --directory "$HOME/siftgate-recovery" up
```

原镜像还在本机可增加 `--local-image`；否则仓库必须仍可拉到相同镜像。
受管身份恢复会清除待用访问码并重新签发会话密钥，必须用备份时的密码重新登录；
旧密码/OIDC 模式保持原会话策略。Gateway API Key 不被轮换。
恢复保留原时区，验证文件摘要和镜像身份，不启动源实例也不覆盖源目录。
先检查密码、Key、预算、日志、价格和上游连通性，再决定是否切流。
升级失败后**不会自动用旧数据库覆盖新数据**：候选可能已接到新请求，必须保留并对账。
旧程序也不能直接打开已升级的数据库。确认后再处理 `maintenance` 标记。

该工具的自动备份/恢复只支持其默认路径的 SQLite。大型企业可迁移到 PostgreSQL，
但要走应用迁移流程和 PostgreSQL 原生备份，不能把 SQLite 备份当成外部数据库备份。

## 自启动与看门狗

Linux 单独启用 Docker 服务开机启动；Mac 单独启用 Rancher Desktop 登录启动。
容器使用 `unless-stopped`，不会把人工停止的实例自动拉起。Compose 显示 unhealthy
本身并不会自动重启；应用的监听自检之外，可每 30 秒执行独立探测：

```bash
# 仅观察
python3 "$HOME/siftgate/kit/siftgate.py" --directory "$HOME/siftgate" watchdog
# 明确允许有节制的恢复
python3 "$HOME/siftgate/kit/siftgate.py" --directory "$HOME/siftgate" watchdog --recover
```

连续三次失败才尝试恢复，间隔至少 120 秒，15 分钟最多三次；维护、停止和暂停期间
不拉起。探测是真实 HTTP `/live`，不因供应商或数据库就绪失败重启。
安装包附 Linux systemd 模板，需按实际账户和目录修改后安装；Mac 使用独立 LaunchAgent。
安装器不会擅自修改宿主机启动项。外部看门狗日志需接外部监控，不能指望已宕机的应用
发送自身告警。后台连接器仍由客户自己配置。

## 发布边界

维护者完整发布手册位于源码仓库的 `docs/customer-release.zh-cn.md`，包含首次 GHCR
设置、版本同步、双架构演练、正式 tag、失败续传、匿名验收、离线交付及问题版本处理。

普通代码推送不发布镜像、不升级现网。合并主分支、对齐版本并推送审核过的 annotated
版本 tag 后，发布流水线才构建和原生验证 AMD64/ARM64，再发布版本镜像及校验安装包。
手动运行流水线只测试，即使选择 tag 也不发布。正式发布还要求确切提交的主分支 CI
成功；带 v/不带 v 标签须对应同一 digest，附件完成校验后才公开 Release。

更完整的权限、备份、升级失败处理与发布检查见随包附带的英文说明。


## 可选：独立主机执行器

本分支新增持久任务账本与只读Control Room，必须由安装账户明确启用，不自动接管既有实例，也不改系统自启动。只读挂载要到下一次单独批准的容器重建才生效。当前不验证发行签名或任意跨版本兼容性，启用前阅读配套的 [Operator手册](customer-operator.zh-cn.md)。

## 后续版本提醒

v2.12.0之后的源码新增后台自动发现与站内提醒，详见[正式版本提醒](release-updates.md)。
需安装包含改动的后续发行；既有v2.12.0镜像不会因为源码合入而自动获得功能，2099也不会自动升级。

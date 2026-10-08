# 客户安装与运维

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

打开 `http://localhost:2099/dashboard`，在本机读取随机密码：

```bash
cat "$HOME/siftgate/config/initial-admin-password.txt"
```

妥善保存密码后删除此一次性提示文件；备份不会收录该文件。配置中保存密码哈希，
配置、环境变量和备份仍须保密。所有示例节点初始禁用：在后台配置供应商及其密钥，
核对模型计价、路由和预算，再启用节点、创建自己的 Gateway API Key、发送测试请求。
示例价格不保证是供应商现行价格。告警接收地址由客户自行配置。

服务器部署使用 `init --mode https`，自行配置域名、HTTPS 反向代理和防火墙。
这个选项会启用 Secure 会话 Cookie，**并不自动申请证书或把 2099 变成 HTTPS**。
`--bind 0.0.0.0` 仅在 HTTPS 模式允许，仍需可信入口保护；不要裸露管理后台。

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

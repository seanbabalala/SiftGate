# 独立 Control Room / Fleet 操作说明

**适用2.12.0起的签名生命周期安装工具。** 先核验确切版本的公开四件套和成功的发行工作流，再执行安装；文档或源码不是发布证明。实现与验收边界见 `customer-lifecycle-release-goal.zh-cn.md`。升级已有实例仍需明确批准。

Control Room是独立宿主服务，不是网关中的高权限页面。网关后台的运维页仍然只读，不持有Docker socket、运维账户或执行权限。启动控制台不等于授权升级。

## 部署与身份

- Python 3.9+，安装账户可访问对应主机的Docker/Compose。Linux与Rancher Desktop使用各自明确的本地Unix socket，不修改全局Docker context。
- 控制数据库使用安装账户私有的本地目录，不使用网络盘，不挂载进网关。
- HTTP只监听127.0.0.1，拒绝2099端口。远程访问须使用专用HTTPS反向代理，并配置精确的外部Origin。不要通过网关本身反向代理控制台，否则网关停机时无法观察。
- 主机账户与SSH权限是高权限信任边界；控制台不能防御能直接改文件或Docker的主机所有者。

以下变量须填写实际、经过核验的安装包和专用目录。不要使用生产2099作为试验对象。

```bash
CONTROL_HOME="$HOME/siftgate-control"
python3 "$REVIEWED_KIT/siftgate_control.py" --home "$CONTROL_HOME" init \
  --owner operations-owner --confirm
python3 "$REVIEWED_KIT/siftgate_control.py" --home "$CONTROL_HOME" serve --port 2100
```

初始化不重启网关。使用本地`activate-code.txt`中的15分钟一次性码设置运维密码；没有共享默认密码。不要将激活码、密码或数据库提交到Git。首次管理员默认持有全部角色，但仍然不能批准或核对自己提出的计划。请邀请另一位具名审批者，通过安全渠道交付一次性邀请。

| 角色 | 权限 |
|---|---|
| viewer | 查看实例、计划和记录 |
| planner | 暂存发行/离线包、预检、提出维护计划 |
| approver | 批准别人的计划、后续批次及故障核对；暂停/取消剩余目标 |
| admin | 用户邀请、角色及稽核管理；不隐含planner或approver |

角色变更和改密撤销控制会话，不变更业务API Key。网页使用当前Origin的sessionStorage保存显式Bearer凭证，不使用Cookie或网关凭据。关闭页面不取消已交给独立执行器的任务；关闭前台服务进程则会失去执行能力，长期运行须由服务管理器托管。

## 明确纳管

新安装附带对应Agent。旧安装须先使用经过核验的工具显式执行bootstrap；它不重启网关、不覆盖原kit。已纳管安装不能用bootstrap跳过审批覆盖工具。

```bash
python3 "$REVIEWED_KIT/siftgate_agent.py" --directory "$INSTALL_DIR" bootstrap-host-tools --confirm
python3 "$REVIEWED_KIT/siftgate_agent.py" --directory "$INSTALL_DIR" enroll --confirm
python3 "$REVIEWED_KIT/siftgate_control.py" --home "$CONTROL_HOME" enroll-local \
  --name "Office gateway" --directory "$INSTALL_DIR" \
  --agent-path "$REVIEWED_KIT/siftgate_agent.py" --confirm
```

纳管固定安装ID、引擎及传输配置。使用稳定、只读保存的Agent入口，不要一边执行任务一边改其文件。核验过的升级会成组选择新的版本化工具，稳定入口转交当前工具版本。

SSH纳管仅允许主机CLI，须指定专用身份文件、独立核对的known_hosts、远端路径和用户。严格检查主机身份，禁用转发及SSH agent转发。不能把首次未经核验的网络扫描结果直接当作可信身份。双原生平台均已用不同HostKey的真实SSH端点演练分批更新；测试端点共享物理主机/引擎，不代表跨硬件故障转移验收。

## 版本、提案与批次

1. 选择明确纳管的实例，检查公开版本。发现版本或历史验证日期不等于当前发行者验证通过。
2. 下载/查看发行，核对仓库、工作流、tag、提交、平台配置摘要和配套工具。没有受管发行元数据的旧版本不能走受管升级。
3. 预检每个选定目标。失败目标不会被悄悄排除。
4. 核对源/目标版本、计划摘要和中断风险，由另一位审批者批准。
5. 从试点开始，每批内顺序执行。后续批次须再次批准；达到失败门槛后应核查并重新规划，不能直接继续。

批准后先显示“正在记录主机审批”。独立线程在15分钟预检有效期内记录每台主机的审批，完成后才显示排期；Agent此时仍不能自行执行。到维护窗口和对应批次才派发执行权限。窗口最长1小时、最多提前7天，限制的是开始中断时间，不保证完成时间。跨两天及慢批次通过合成时钟测试，实际原生实测覆盖短窗口、进程重建与不可提前执行。首次审批过期仍然拒绝，不会通过伪造时间延长。

可信宿主计划使用发行清单摘要，而不是手工镜像信任开关：

```bash
python3 "$REVIEWED_KIT/siftgate_operator.py" --directory "$INSTALL_DIR" plan upgrade \
  --request-id change-unique-id --release-digest "$VERIFIED_RELEASE_DIGEST"
# 离线仅使用此前建立信任且已导入的材料：
python3 "$REVIEWED_KIT/siftgate_operator.py" --directory "$INSTALL_DIR" plan upgrade \
  --request-id offline-change-unique-id --release-digest "$VERIFIED_RELEASE_DIGEST" --offline
```

这些命令只生成计划，不批准或执行。`siftgate.py upgrade --image`是未纳管安装的旧手工路径，不是可信受管升级，也不从新控制API提供；已纳管安装会拒绝该旧命令。

## 失去回执后的核对

`needs_attention`不是“再试一次升级”，而是结果未确认、目标仍被占用。

1. 检查连接、主机和保留现场，不删除账本或维护标记来强行解锁。
2. 网关升级故障由主机安装账户先检查新写入、数据库和容器，按安全恢复路径处理。必要时使用Operator的`resolve --confirm-reconciled`；它仍会检查实际容器/HTTP/维护标记与残留助手，不自行修复网关。
3. 由不同于提议者的审批者勾选授权，点击“核对主机并关闭本批任务”。

核对只针对原安装与原计划：

- 未执行计划撤销，防止迟到的执行消息启动它。
- 已成功任务重新核验运行镜像及HTTP，才能记录成功。
- 隔离演练只清理确认归属的无网络、无公开端口容器；清理成功不是恢复验证成功。
- 无法确认、仍在执行或主机仍需处理时保持占用。网页不能提交自称成功的回执。
- 确认后关闭整批，不自动继续后续实例；剩余目标重新提案。resolved与completed含义不同。

审计采用本地哈希链，不是防主机所有者篡改的外部不可变存储。

## 恢复、离线与服务托管

Recovery Vault区分历史校验、隔离启动验证和正式切流。演练在新目录、无网络且无公开端口的环境核对数据库、Key、日志与配置，不覆盖现网。受管身份撤销复制的会话；开启认证的旧身份仅更换管理签名secret，保留口令与企业登录设置。未开启认证的旧配置拒绝此安全恢复流程。

新备份同时保留镜像配置摘要、架构与配套工具。恢复前校验内容，可用`restore --image`指定离线导入后的本地句柄，不能用它绕过摘要检查。旧备份没有这份证明时只支持原引擎、原架构、原runtime ID，不宣称跨主机可移植。备份包含机密配置及可执行工具，只能使用来源可信、私有保存并已核验完整性的备份；校验和不是发行者签名，也不是对主机所有者的防篡改保证。

离线包由宿主CLI暂存，再在页面校验导入。验证器及信任根须在包之外建立信任；导入只是预加载，不批准或执行升级。没有自动覆盖新写入、自动回滚或自动切流。

`siftgate-control.service`是Linux模板，须人工核对User、路径、Docker权限和Origin后安装。独立Control执行器与旧Operator守护进程可能竞争工作锁，不要未经评估同时启用。网页没有通用shell/path执行接口。

本机2099仍是固定镜像、unless-stopped和仅恢复原容器的看门狗。发布Git版本或镜像不会自动升级它。首次纳管、切换镜像或重建2099均须另行批准。

## 完整离线导出与独立信任

先在独立可信的联网主机取得验证器和根信任，不要信任升级包自带的根：

```bash
gh attestation trusted-root > trusted-root.jsonl
sha256sum trusted-root.jsonl
# ROOT_SHA256必须经独立可信渠道核对
python3 "$REVIEWED_KIT/siftgate_agent.py" --directory "$INSTALL_DIR" pin-trust \
  --file trusted-root.jsonl --sha256 "$ROOT_SHA256" --confirm
python3 "$REVIEWED_KIT/siftgate_agent.py" --directory "$INSTALL_DIR" fetch-release --version X.Y.Z
mkdir -m 700 "$HOME/siftgate-exports"
python3 "$REVIEWED_KIT/siftgate_agent.py" --directory "$INSTALL_DIR" export-offline \
  --release-digest "$RELEASE_DIGEST" --output "$HOME/siftgate-exports/version-package" --confirm
```

`--local-image`仅选择已经验证且绑定当前引擎的镜像，不接受任意未验证本地镜像。导出只含
发行清单、证明、安装包、镜像与离线元数据，不含客户配置或根信任。接收端另行固定可信根，
用`stage-offline`暂存，再由页面按不透明package ID验证导入。导入不等于批准升级。
完整首次发行校验见[发行校验](customer-artifact-verification.md)。


## 容量与保留边界

首版生命周期设有防御性上限：每个安装最多20条Vault演练、10,000条Operator任务；
Control最多256个账户、1,000个安装和100,000条审计。这不是吞吐量或HA承诺。
达到历史/审计上限时停止新增运维动作，要求主机所有者审核；不会停止网关业务请求。
本版没有自动删除审计/检查点、网页强制覆盖上限或原地审计轮转功能；应提前安排
保留审核，保留经验证的私有导出，不得编辑活动SQLite账本，也不得删除被待执行、
结果不明或失败任务引用的记录。仅普通网关备份可以显式使用安装器keep策略；
升级检查点和保留的恢复诊断不会被自动清理。停机前会检查镜像身份导出的额外空间。

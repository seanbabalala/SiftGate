# 独立宿主 Operator

Operator是安装账户运行的Python 3.9+进程，使用私有SQLite WAL账本。网关不持有Docker
socket、审批数据库或可写命令队列。发布镜像不是部署授权。

浏览器运维、独立角色和Fleet流程见[Control Room](customer-control.zh-cn.md)。独立
Operator守护进程与Control执行器会竞争同一工作锁，不要未经评估同时管理同一实例。

## 明确启用，不重启网关

使用已核验的配套发行工具，以原安装账户执行：

```bash
INSTALL_DIR="$HOME/siftgate"
python3 "$REVIEWED_KIT/siftgate_agent.py" --directory "$INSTALL_DIR" bootstrap-host-tools --confirm
python3 "$REVIEWED_KIT/siftgate_agent.py" --directory "$INSTALL_DIR" enroll --confirm
```

Bootstrap选择封存的版本化工具，不覆盖原kit、不重启网关；只适用于尚未纳管的安装。
已纳管实例必须通过核验过的升级计划切换工具包。宿主账户本身是高权限信任边界。

## 版本预检与批准

可信发行验证需要独立建立信任的GitHub CLI **2.86+**。先取得并核验正式发行，保存返回的
清单摘要，再生成计划：

```bash
python3 "$REVIEWED_KIT/siftgate_agent.py" --directory "$INSTALL_DIR" fetch-release --version X.Y.Z
python3 "$REVIEWED_KIT/siftgate_operator.py" --directory "$INSTALL_DIR" plan upgrade \
  --release-digest "$RELEASE_DIGEST" --request-id change-unique-id
python3 "$REVIEWED_KIT/siftgate_operator.py" --directory "$INSTALL_DIR" plan backup --request-id backup-unique-id
```

预检不等于批准。升级核验发行者、仓库/工作流/tag/提交、实际源镜像配置摘要、原生目标
镜像和配套kit。未知源版本/镜像会拒绝，不凭一个版本标签推断兼容性。生产已纳管实例
不能使用手工`--image`信任或旧`siftgate.py upgrade`绕过；`--development`仅供合成测试。

宿主CLI维护需在计划生成15分钟内，核对确切ID/摘要后批准：

```bash
python3 "$REVIEWED_KIT/siftgate_operator.py" --directory "$INSTALL_DIR" approve "$JOB_ID" \
  --plan-digest "$PLAN_DIGEST" --accept-downtime \
  --not-before "$WINDOW_START" --not-after "$WINDOW_END"
python3 "$REVIEWED_KIT/siftgate_operator.py" --directory "$INSTALL_DIR" serve
```

时间必须带时区；窗口最长1小时，最多提前7天，只限制何时开始中断，不保证完成时间。
省略CLI时间参数允许立即开始。长期执行须由服务管理器托管，关闭普通前台终端不等于
关闭浏览器；`run-once`可执行一次到期维护。

Control模式先在有效期内持久记录主机审批，Agent仍不可执行；到维护窗口及对应批次才
单独放行。已经保留给Control的计划不能通过普通CLI审批跳过批次。Control要求不同的
具名提议/审批账号；宿主CLI是单独标记的高权限渠道。

## 执行、中断与恢复

执行前再次核对安装身份、引擎、源容器/启动时间、配置、kit、发行证明、磁盘及实际HTTP。
顺序：预检 → 无网络只读候选检查 → 维护标记 → 排空停止 → 校验SQLite快照 → 镜像/kit
元数据成组切换 → 启动 → HTTP就绪验证。阶段意图先写账本，再执行外部操作。

排队的CLI任务跨进程重启保留。中途退出标记`needs_attention`，不盲目重放，不用旧库
覆盖新写入，也不自动让旧代码读新schema。先核查所属容器、助手、维护标记、检查点和
新写入；恢复到另一空目录/端口，再单独批准切流。

```bash
python3 "$REVIEWED_KIT/siftgate_operator.py" --directory "$INSTALL_DIR" show "$JOB_ID"
python3 "$REVIEWED_KIT/siftgate_operator.py" --directory "$INSTALL_DIR" cancel "$JOB_ID"
# 仅在实际完成宿主核对并有意识处理维护标记之后：
python3 "$REVIEWED_KIT/siftgate_operator.py" --directory "$INSTALL_DIR" resolve "$JOB_ID" --confirm-reconciled
```

Cancel只取消未执行工作。Resolve仍检查运行镜像、HTTP、维护标记和残留助手，不替你修复。
不要删除账本强行解除占用。备份校验和通过与真正完成隔离恢复演练是不同证据。

## 独立观察与只读桥

`status`、`show JOB_ID`和`socket-path`不依赖网关。私有Unix socket只允许GET状态查询。

```bash
python3 "$REVIEWED_KIT/siftgate_operator.py" --directory "$INSTALL_DIR" bridge --enable --confirm
```

这只保存下次另行批准重建所需的只读挂载，不立即重启；此前预检指纹会失效。Dashboard
观察页不能审批，网关停机时它自身也不可访问，应使用独立Control或宿主socket。禁用桥
也须等到另行批准的重建才生效，不能为点亮状态随便重启2099。

宿主账本须单独用WAL安全方法保护。网关恢复不会继承旧升级审批队列。

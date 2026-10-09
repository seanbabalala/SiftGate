# Release update notifications / 正式版本提醒

This describes the post-v2.12.0 source addition. It is not included retroactively
in the immutable v2.12.0 image/tag. Use the next release containing this change;
a source commit, release notice, or image publication never updates an existing
container automatically.

本文描述 v2.12.0 之后的源码增量，不代表已发布的 v2.12.0 镜像自动具备此功能。
安装包含这项改动的后续发行版后生效，发布与部署仍是两回事。

## Customer experience / 客户体验

- The ordinary gateway dashboard has a visible release bell, including on mobile,
  and an `/updates` page. No Control Room enrollment is needed to read notices.
- By default the server checks every6hours with ±10% random spacing. Startup waits
  30–120seconds; startup and customer requests never wait for GitHub. Closing the
  browser does not stop checking. Intervals6/12/24hours and disabling are supported.
- Only public stable releases with the matching uploaded installer, checksum,
  release manifest and signature-bundle assets are listed. Source commits,
  drafts, prereleases and incomplete asset sets do not qualify.
- A notice is **not** publisher-signature verification or compatibility approval.
  Follow the independent [Control Room process](customer-control.md) for verified
  artifacts, preflight, explicit approval and the maintenance window.
- The page shows the running version number, last attempt, last success, next
  attempt, public release notes as plain text, and explicit failure/stale states.
  “No newer version found” means a recent metadata lookup found no higher version
  number; it does not attest to locally built source or establish image identity.
- Only Dashboard administrators can manually check or change preferences.
  Authenticated viewers can read the public release information. These permissions
  grant no Docker access, executable download, configuration rewrite or restart.

后台铃铛和“版本更新”页提供日常入口，不必先纳管到独立控制中心。默认每6小时错峰
检查，可选择12/24小时或关闭；页面关闭后调度继续。只提示公开稳定发行，不追踪每次
源码提交。发现版本不等于签名/兼容性验证，真正升级仍须独立预检、审批和维护窗口。
页面不会把“尚未检查”“网络失败”“限流”“缓存过期”显示成“已是最新版”。

## Privacy, offline policy and persistence / 隐私、离线策略与持久化

The only discovery destination is the fixed public GitHub releases endpoint for
`seanbabalala/SiftGate`. Redirects are refused. The checker sends no GitHub account
token, gateway API Key, provider configuration, installation identity or usage.
The public service naturally sees the connection's source IP. The browser reads
cached gateway status, not GitHub directly.

To prohibit all online checks before the next start, the installation owner sets:

```sh
SIFTGATE_RELEASE_UPDATES_DISABLED=1
```

For a managed install put that variable in its private `provider.env`, respecting
the existing maintenance/deployment process; do not restart a live gateway merely
to try this example. The dashboard cannot override the host prohibition. Offline
customers obtain update information from their administrator and use the verified
offline package workflow. There is no claim that an offline instance can discover
remote releases. Vault's network-isolated restore probes explicitly disable this
checker; a background lookup must not change recovery evidence.

Preferences and bounded public metadata are stored in a0600
`.siftgate-release-updates.json` file beside the gateway configuration. The checker
never modifies `gateway.config.yaml`, provider settings or the business database.
Use private local per-instance storage, not a shared multi-process/network cache.
A missing file is a new-install default; corrupt/unsafe/unwritable state disables
automatic checks and produces a storage error without stopping business traffic.
The owner should repair storage before restarting the checker; do not delete a
saved disabled preference blindly, since a genuinely new state defaults to enabled.
Backups include these preferences with the configuration directory.

只访问固定公开发行列表，不携带账号令牌、业务密钥、客户配置或用量；远端服务自然
可以看到来源IP。安装所有者可在首次启动前设置环境变量禁止联网，后台不能覆盖。
完全离线环境由企业管理员提供发行资料与经验证的离线包，不伪造“已是最新版”。
偏好和公开元数据独立持久化，权限0600；损坏或不可写时停止检查，但不停止业务。

## Retries and optional connectors / 重试与可选连接器

- ETag conditional requests, a shared60second manual-check cooldown, one in-flight
  check per gateway process, a10second request/body deadline and a2MiB response
  bound keep the checker independent of the request path.
- Failed checks retain historical information marked as such. Retries back off
  from approximately5minutes up to6hours; rate-limit responses respect the server's
  Retry-After/reset delay (bounded to24hours). Disabling cancels in-flight checks;
  late responses cannot silently re-enable checking.
- Connector notification is **off by default**. Opt in on `/updates`, configure
  an existing alert connector and subscribe to `release_available`. Only public
  version/URL information is passed to the existing connector delivery queue.
  At-most-once queue attempts per release survive restarts; queueing is not a
  delivery receipt. Inspect the existing alert delivery status for actual results.
- The in-app notice works without any external alert receiver. No notification
  action downloads an installer/image, approves a plan or triggers an upgrade.

连接器通知默认关闭。需要时启用版本页的通知选项，在现有告警连接器中订阅
“发现正式新版本”；站内提醒不依赖外部接收地址。每个版本最多尝试入队一次，
实际送达结果以告警记录为准。任何提醒都不会自动拉取镜像或重启2099。

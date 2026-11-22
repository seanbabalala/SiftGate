# 安全与合规简报

[English](security-compliance-brief.md) · [企业 AI 治理方案](enterprise-overview.zh-cn.md) · [Security](SECURITY.md)

本简报面向安全评审、法务和采购，回答供应商安全问卷中关于 AI 网关的常见问题。以下每一条都描述开源网关的默认行为；任何改变默认行为的设置都需要运维方显式配置。

## 部署模式

- SiftGate 是自托管软件，运行在你的网络、你的主机或集群上，使用你的账号。
- AI 请求只发往你配置的上游供应商。请求路径上没有托管服务，也不需要 SiftGate 云账号。
- 唯一的其他出站连接是可选的版本可用性检查，访问公开的 GitHub Releases API。它不发送令牌、Key、配置、安装标识或用量数据，安装负责人可用 `SIFTGATE_RELEASE_UPDATES_DISABLED=1` 关闭（[详情](release-updates.md)）。
- 源码以 MIT 许可公开，评审人员可以直接审计。

## 数据留存

| 数据 | 默认是否存储 | 说明 |
| --- | --- | --- |
| Prompt 与请求体 | **否** | 不写入日志、路由记录、会话、导出或遥测。 |
| 模型响应 | **否** | 默认关闭。运营者开启精确匹配响应缓存（`cache.enabled`）后，响应会在内存中保留至 TTL（默认 300 秒）。语义缓存只有在设置 `semantic_cache.store_responses: true` 且请求携带单次授权请求头时才保存响应。 |
| 原始供应商请求头与认证头 | **否** | 不存储，并会从错误文本中脱敏。 |
| 供应商 API Key | 仅在配置中 | 保存在配置、环境变量或密钥管理器引用中。控制台 API、日志、路由记录、导出和日志出口都不会返回。 |
| 工具载荷、源码、Diff、媒体字节 | **否** | MCP 调用、Coding Agent 会话和媒体任务只保留元数据。 |
| 隐藏推理文本与解析后的密钥 | **否** | 可记录推理意图和强度，不记录推理文本。 |
| 请求元数据 | 是 | 请求 ID、端点、节点、模型、状态、延迟、Token 数、费用估算、Key/Team/Namespace ID、凭证 ID、缓存与 fallback 证据。 |
| Agent 会话元数据 | 是 | 连接器、会话 ID、可选的仓库与项目标签、路由和成本。 |
| 上游错误信息 | 是，已脱敏 | Bearer 令牌、网关 Key、供应商 Key 和其他敏感值在存储前替换为 `[REDACTED]`。 |
| 护栏发现 | 是，仅元数据 | 规则、类型、动作、严重级别和命中次数，从不包含命中原文。 |
| 管理与配置审计 | 是，已脱敏 | 哈希链管理事件，以及带脱敏摘要的配置版本。 |

调用日志默认保留 30 天（`database.log_retention_days`），计价证据的保留期可通过 `database.pricing_evidence_retention_days` 配置。

`GET /api/dashboard/governance/privacy-posture` 列出所有会保存内容的设置，并显示当前运行配置是否已开启：响应缓存、语义缓存响应、提示词模板正文、评测样本与影子流量样本、系统提示词采集；同时统计本检查无法审阅的插件数量。治理总览的“数据保护”卡片读取此接口。

## 凭证与密钥

- 供应商 Key 支持 `${env:...}`、HashiCorp Vault、AWS Secrets Manager 和 GCP Secret Manager 引用，在请求时解析（[Secret management](SECRET_MANAGEMENT.md)）。
- 客户端使用与供应商 Key 分离的 Gateway API Key 认证。完整 Key 只在创建或轮换时展示一次，列表中只显示掩码前缀。Key 可以限定范围、轮换和停用。
- 凭证池只记录运维方定义的凭证 ID、策略和重试次数，从不记录密钥值。
- Workspace 邀请令牌只以 SHA-256 哈希存储。

## 身份与访问控制

- 控制台默认要求认证。未配置密码或 OIDC 时启动即失败，不会生成或打印兜底密码。生产环境中关闭认证还需要单独的显式覆盖开关。
- 托管客户安装使用一次性激活码首次初始化，激活码 15 分钟后失效，由安装负责人自行设置管理员密码。
- 登录后写入 HttpOnly、SameSite=Lax 的会话 Cookie。旧版 Bearer 和 SSE 查询令牌可通过 `dashboard.allow_legacy_token_auth=false` 关闭。
- 每个 Workspace 提供 admin、operator、viewer 固定角色，支持邀请和可选的通用 OIDC。
- 网关流量权限取 Key、Team、Namespace 规则在端点、模态、节点和模型上的交集，交集为空时拒绝访问。
- 控制台登录按客户端地址限流。

## 内容管控

- 官方 [guardrails 插件](plugins/OFFICIAL_PLUGINS.md)在网关本地运行，可对输入和输出中的 PII（邮箱、电话、SSN、信用卡、IBAN、护照、IP 地址、API Key 格式）、密钥与令牌、Prompt 注入和越狱话术、不安全 URL、Schema 与工具调用策略以及自定义规则进行审计、脱敏或拦截。默认关闭，配置后生效。
- 护栏发现和可选的 Webhook 通知只包含元数据：请求 ID、规则、类型、动作、次数和路径。
- Semantic Controls 以元数据形式记录 Guardrails v2 发现，实际拦截由 guardrails 插件执行。

## 审计与变更控制

- 控制台管理操作以脱敏审计事件记录，并通过哈希链串联，删除或篡改记录可被发现。
- 配置变更生成带差异的版本，回滚前先校验目标版本（[Config audit and rollback](CONFIG_AUDIT_ROLLBACK.md)）。
- 调用日志可以导出为只含元数据的 CSV 或 JSON，也可以推送到你自己的[日志出口](LOG_SINKS.md)和 OpenTelemetry 采集器。
- 因预算、密钥权限或密钥限流被拒绝的请求会记录为仅含元数据的拦截记录（原因、状态码、密钥与范围、请求的模型，不含任何内容），可在 请求日志 → 已拦截请求 中查看。

## 软件供应链

- 客户发行包随发行清单、校验和以及由 GitHub 发布工作流生成的 Sigstore 来源证明一起发布。运行任何内容之前，请先用 GitHub CLI 校验（[校验指南](customer-artifact-verification.md)）。
- CI 对完整 Git 历史运行固定版本的密钥扫描，对 Docker 构建输入和已审核媒体执行发布边界检查，并运行依赖审计和完整的单元与 HTTP 测试。
- 发布新版本从不会自动更新正在运行的实例。可选的主机 Operator 只按经过评审的计划执行升级和备份，Control Room 要求第二个人审批（[Control Room](customer-control.zh-cn.md)）。

## 网络暴露面

- 网关在一个端口（默认 2099）上提供 `/v1/*` 流量、控制台及其 API。请放在你自己负责 TLS 终止的反向代理或 Ingress 之后，并把控制台访问限制在企业网络内。
- 只对你控制的代理设置 `server.trust_proxy`，避免限流所用的客户端地址被伪造。
- 出站访问可以只放行你配置的供应商端点。

## 责任划分

| SiftGate 提供 | 你的团队负责 |
| --- | --- |
| 只存元数据的默认值、策略执行、Key 范围限定、审计链 | 选择批准哪些供应商和模型，以及它们的数据条款 |
| 密钥引用与脱敏 | 运维密钥管理器并轮换供应商 Key |
| 签名的发行产物和校验步骤 | 校验产物并安排升级窗口 |
| 支持 TLS 的部署清单 | TLS 证书、网络策略、主机加固和备份 |
| 默认关闭的内容留存功能 | 审批任何会存储内容的功能，并形成文档 |

## 问卷速答

| 问题 | 回答 |
| --- | --- |
| 客户数据会发给厂商吗？ | 不会。流量只发往你配置的供应商。 |
| 会存储 Prompt 或响应吗？ | 默认不会。保留内容需要显式配置。 |
| 供应商凭证保存在哪里？ | 在你的配置或密钥管理器中，位于你的环境内。 |
| 是否支持基于角色的访问控制？ | 支持：每个 Workspace 的 admin、operator、viewer，以及受限 Gateway API Key。 |
| 是否支持 SSO？ | 支持通用 OIDC。 |
| 管理操作有审计吗？ | 有，写入脱敏的哈希链审计日志。 |
| 用量能归因到团队吗？ | 能，可按 Key、团队、命名空间和项目归因，并导出 CSV/JSON。 |
| 发行包有签名吗？ | 客户发行包附带 Sigstore 来源证明。 |
| 源码可以审查吗？ | 可以，采用 MIT 许可。 |

报告漏洞请按根目录 [SECURITY.md](../SECURITY.md) 的说明进行。

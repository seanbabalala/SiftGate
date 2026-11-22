# SiftGate 文档

[文档首页](../../README.md) · [项目 README](../../../README.md)

当前版本：**v2.12.16**。

**企业级自托管 AI 治理网关。** SiftGate 为企业的每一次 AI 调用提供一个由你自己运维的统一管控入口，覆盖业务应用、Coding Agent 和 MCP 工具。供应商 Key 留在你的服务器上，访问遵循策略，支出先有预算、后可分摊，每个请求都留下审计记录，但默认不存储 Prompt 和响应。

<p align="center">
  <img src="../../assets/homepage/siftgate-hero.svg" alt="SiftGate：企业级自托管 AI 治理网关" width="100%" />
</p>

## 企业为什么需要 SiftGate

| AI 规模化后出现的问题 | SiftGate 带来的改变 |
| --- | --- |
| Shadow AI 与 Key 散落 | 供应商 Key 只留在网关内；团队和个人使用受限、可吊销的 Gateway API Key。 |
| 安全评审卡住上线 | 默认只存元数据：不存 Prompt、响应、源码、工具载荷或密钥。 |
| 账单只有一个总数 | 全局、命名空间、团队、Key 四级预算，成本分摊导出，缓存感知 Key 池。 |
| 一家供应商故障，全员停工 | Fallback 链、熔断、凭证故障切换，每个请求都有路由解释。 |

## 四大治理支柱

| 支柱 | 覆盖内容 |
| --- | --- |
| 接入与权限 | 受限 Key、Workspace、Team、Policy Namespace（交集为空即拒绝）、按 Key 的模型池、Agent Profile、MCP Tool Gateway、RBAC 与 OIDC。 |
| 数据保护与审计 | 只存元数据的日志与路由记录，本地护栏处理 PII、密钥和 Prompt 注入，哈希链管理审计，版本化配置回滚。 |
| 成本管控 | 每日 Token 与费用预算、Workspace 价格簿、成本报表、CSV/JSON 成本分摊、异常证据、缓存节省。 |
| 可靠性与运维 | 智能路由、Fallback、熔断、路由解释，PostgreSQL/Redis/Kubernetes 生产路径，Sigstore 签名发行包，经评审的升级计划。 |

## 评估路径

1. 决策参考：[企业 AI 治理方案](../../enterprise-overview.zh-cn.md)
2. 安全评审：[安全与合规简报](../../security-compliance-brief.zh-cn.md)
3. 30 分钟演示：[PoC 演示剧本](../../poc-playbook.zh-cn.md)

## 快速开始

```bash
git clone https://github.com/seanbabalala/ai-gateway.git
cd ai-gateway
# 按 .nvmrc 选择 Node >=22.13.0 <23。
npm run runtime:check
npm install
cd frontend && npm install && cd ..
cp gateway.config.example.yaml gateway.config.yaml
cp .env.example .env
npm run build
# 启动前先在私有 YAML 中配置 dashboard.password（或 OIDC）。
npm start
```

打开 `http://localhost:2099/dashboard`，添加一个 Provider Node，创建一个 Gateway API Key，然后向 `http://localhost:2099/v1/chat/completions` 发送请求。需要带版本、使用一次性激活码的 Docker 安装，请使用[客户安装包](../../customer-install.zh-cn.md)。

## 供应商凭证池

一个 Provider Node 可以放多个上游 Key。`cache_aware` 会让创建或读取供应商 Prompt 缓存的请求继续命中同一个 Key，遇到 429、5xx 或超时则切换到其他 Key。

```yaml
credential_pool:
  enabled: true
  strategy: cache_aware
  sticky_by: agent_session
  cooldown_ms: 60000
  retry_on_status: [429, 500, 502, 503, 504]
```

## 文档地图

| 方向 | 文档入口 |
| --- | --- |
| 企业评估 | [企业 AI 治理方案](../../enterprise-overview.zh-cn.md), [安全与合规简报](../../security-compliance-brief.zh-cn.md), [PoC 演示剧本](../../poc-playbook.zh-cn.md), [Comparison](../../COMPARISON.md) |
| 本地试用与控制台 | [Quickstart](../../QUICKSTART.md), [Dashboard](../../DASHBOARD.md), [OSS Concepts](../../OSS_CONCEPTS.md), [Playground](../../PLAYGROUND.md) |
| 生产运维 | [客户安装](../../customer-install.zh-cn.md), [Production](../../PRODUCTION.md), [Kubernetes and Helm](../../KUBERNETES.md), [State Backends](../../STATE_BACKEND.md), [Secret Management](../../SECRET_MANAGEMENT.md), [Config Audit and Rollback](../../CONFIG_AUDIT_ROLLBACK.md) |
| Agent 与 MCP 工具 | [Coding Agent Gateway](../../CODING_AGENT_GATEWAY.md), [Agent Integrations](../../AGENT_INTEGRATIONS.md), [MCP Tool Gateway](../../MCP_GATEWAY.md), [Agent + MCP Demo](../../AGENT_MCP_DEMO.md) |
| 成本治理 | [Cost Platform](../../COST_CHARGEBACK_PLATFORM.md), [Billing Loop](../../BILLING_LOOP.md), [Policy Namespaces](../../NAMESPACES_AND_SHADOW.md) |
| 供应商与路由 | [Provider Catalog](../../PROVIDER_CATALOG.md), [Provider Compatibility](../../PROVIDER_COMPATIBILITY.md), [Routing Recommendations](../../ROUTING_RECOMMENDATIONS.md), [Multimodal Capabilities](../../MULTIMODAL_CAPABILITIES.md) |
| 观测与告警 | [Operator Observability](../../OPERATOR_OBSERVABILITY.md), [Webhook Alerts](../../WEBHOOK_ALERTS.md), [Log Sinks](../../LOG_SINKS.md), [Security](../../SECURITY.md) |
| 开发与扩展 | [Architecture](../../ARCHITECTURE.md), [API Reference](../../API_REFERENCE.md), [SDKs](../../SDKS.md), [Plugins](../../PLUGINS.md), [Release Checklist](../../RELEASE_CHECKLIST.md) |

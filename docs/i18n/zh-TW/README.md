# SiftGate 文件

[文件首頁](../../README.md) · [專案 README](../../../README.md)

目前版本：**v2.12.16**。

**企業級自架 AI 治理閘道。** SiftGate 為企業的每一次 AI 呼叫提供一個由你自行維運的統一管控入口，涵蓋業務應用、Coding Agent 與 MCP 工具。供應商 Key 留在你的伺服器上，存取遵循政策，支出先有預算、後可分攤，每個請求都留下稽核紀錄，但預設不儲存 Prompt 與回應。

<p align="center">
  <img src="../../assets/homepage/siftgate-hero.svg" alt="SiftGate：企業級自架 AI 治理閘道" width="100%" />
</p>

## 企業為什麼需要 SiftGate

| AI 規模化後出現的問題 | SiftGate 帶來的改變 |
| --- | --- |
| Shadow AI 與 Key 散落 | 供應商 Key 只留在閘道內；團隊與個人使用受限、可撤銷的 Gateway API Key。 |
| 安全審查卡住上線 | 預設只存中繼資料：不存 Prompt、回應、原始碼、工具載荷或密鑰。 |
| 帳單只有一個總數 | 全域、命名空間、團隊、Key 四級預算，成本分攤匯出，快取感知 Key 池。 |
| 一家供應商故障，全員停擺 | Fallback 鏈、熔斷、憑證故障切換，每個請求都有路由說明。 |

## 四大治理支柱

| 支柱 | 涵蓋內容 |
| --- | --- |
| 存取與權限 | 受限 Key、Workspace、Team、Policy Namespace（交集為空即拒絕）、依 Key 的模型池、Agent Profile、MCP Tool Gateway、RBAC 與 OIDC。 |
| 資料保護與稽核 | 只存中繼資料的日誌與路由紀錄，本地護欄處理 PII、密鑰與 Prompt 注入，雜湊鏈管理稽核，版本化設定回滾。 |
| 成本管控 | 每日 Token 與費用預算、Workspace 價格簿、成本報表、CSV/JSON 成本分攤、異常證據、快取節省。 |
| 可靠性與維運 | 智慧路由、Fallback、熔斷、路由說明，PostgreSQL/Redis/Kubernetes 正式環境路徑，Sigstore 簽章發行套件，經審查的升級計畫。 |

## 評估路徑

1. 決策參考：[企業 AI 治理方案（簡體中文）](../../enterprise-overview.zh-cn.md)
2. 安全審查：[安全與合規簡報（簡體中文）](../../security-compliance-brief.zh-cn.md)
3. 30 分鐘示範：[PoC 示範劇本（簡體中文）](../../poc-playbook.zh-cn.md)

## 快速開始

```bash
git clone https://github.com/seanbabalala/ai-gateway.git
cd ai-gateway
# 依 .nvmrc 選擇 Node >=22.13.0 <23。
npm run runtime:check
npm install
cd frontend && npm install && cd ..
cp gateway.config.example.yaml gateway.config.yaml
cp .env.example .env
npm run build
# 啟動前先在私有 YAML 中設定 dashboard.password（或 OIDC）。
npm start
```

開啟 `http://localhost:2099/dashboard`，新增一個 Provider Node，建立一個 Gateway API Key，再向 `http://localhost:2099/v1/chat/completions` 發送請求。需要帶版本、使用一次性啟用碼的 Docker 安裝，請使用[客戶安裝套件（簡體中文）](../../customer-install.zh-cn.md)。

## 供應商憑證池

一個 Provider Node 可以放多個上游 Key。`cache_aware` 會讓建立或讀取供應商 Prompt 快取的請求繼續命中同一個 Key，遇到 429、5xx 或逾時則切換到其他 Key。

```yaml
credential_pool:
  enabled: true
  strategy: cache_aware
  sticky_by: agent_session
  cooldown_ms: 60000
  retry_on_status: [429, 500, 502, 503, 504]
```

## 文件地圖

| 方向 | 文件入口 |
| --- | --- |
| 企業評估 | [Enterprise overview](../../enterprise-overview.md), [Security and compliance brief](../../security-compliance-brief.md), [PoC playbook](../../poc-playbook.md), [Comparison](../../COMPARISON.md) |
| 本地試用與控制台 | [Quickstart](../../QUICKSTART.md), [Dashboard](../../DASHBOARD.md), [OSS Concepts](../../OSS_CONCEPTS.md), [Playground](../../PLAYGROUND.md) |
| 正式環境維運 | [Customer install](../../customer-install.md), [Production](../../PRODUCTION.md), [Kubernetes and Helm](../../KUBERNETES.md), [State Backends](../../STATE_BACKEND.md), [Secret Management](../../SECRET_MANAGEMENT.md), [Config Audit and Rollback](../../CONFIG_AUDIT_ROLLBACK.md) |
| Agent 與 MCP 工具 | [Coding Agent Gateway](../../CODING_AGENT_GATEWAY.md), [Agent Integrations](../../AGENT_INTEGRATIONS.md), [MCP Tool Gateway](../../MCP_GATEWAY.md), [Agent + MCP Demo](../../AGENT_MCP_DEMO.md) |
| 成本治理 | [Cost Platform](../../COST_CHARGEBACK_PLATFORM.md), [Billing Loop](../../BILLING_LOOP.md), [Policy Namespaces](../../NAMESPACES_AND_SHADOW.md) |
| 供應商與路由 | [Provider Catalog](../../PROVIDER_CATALOG.md), [Provider Compatibility](../../PROVIDER_COMPATIBILITY.md), [Routing Recommendations](../../ROUTING_RECOMMENDATIONS.md), [Multimodal Capabilities](../../MULTIMODAL_CAPABILITIES.md) |
| 觀測與告警 | [Operator Observability](../../OPERATOR_OBSERVABILITY.md), [Webhook Alerts](../../WEBHOOK_ALERTS.md), [Log Sinks](../../LOG_SINKS.md), [Security](../../SECURITY.md) |
| 開發與擴充 | [Architecture](../../ARCHITECTURE.md), [API Reference](../../API_REFERENCE.md), [SDKs](../../SDKS.md), [Plugins](../../PLUGINS.md), [Release Checklist](../../RELEASE_CHECKLIST.md) |

# SiftGate ドキュメント

[ドキュメントホーム](../../README.md) · [プロジェクト README](../../../README.md)

現在のリリース: **v2.13.0**。

**エンタープライズ AI ガバナンスのためのセルフホスト型 AI ゲートウェイ。** SiftGate は、業務アプリ、コーディングエージェント、MCP ツールから発生するすべての AI 呼び出しの前に、自社で運用する単一のコントロールポイントを置きます。プロバイダーの Key は自社サーバーに留まり、アクセスはポリシーに従い、支出は予算で管理されて部門ごとに配賦されます。すべてのリクエストに監査証跡が残りますが、プロンプトとレスポンスは既定で保存しません。

<p align="center">
  <img src="../../assets/homepage/siftgate-hero.svg" alt="SiftGate: エンタープライズ AI ガバナンスのためのセルフホスト型 AI ゲートウェイ" width="100%" />
</p>

## 企業が SiftGate を導入する理由

| AI 活用の拡大で起きる問題 | SiftGate による変化 |
| --- | --- |
| シャドー AI と Key の散在 | プロバイダー Key はゲートウェイ内に限定し、チームには範囲を限定して失効可能な Gateway API Key を発行します。 |
| セキュリティ審査で導入が止まる | 既定はメタデータのみ。プロンプト、レスポンス、ソースコード、ツールペイロード、シークレットを保存しません。 |
| 請求書が内訳のない総額だけ | グローバル、Namespace、チーム、Key 単位の予算、配賦エクスポート、キャッシュを考慮した Key プール。 |
| 1 社の障害で全員が止まる | フォールバックチェーン、サーキットブレーカー、認証情報のフェイルオーバー、リクエストごとのルーティング説明。 |

## 4 つのガバナンスの柱

| 柱 | 対象範囲 |
| --- | --- |
| アクセスとポリシー | 範囲限定 Key、Workspace、Team、Policy Namespace（共通部分が空なら拒否）、Key 単位のモデルプール、Agent Profile、MCP Tool Gateway、RBAC と OIDC。 |
| データ保護と監査 | メタデータのみのログとルート記録、PII・シークレット・プロンプトインジェクション向けのローカルガードレール、ハッシュチェーン化された管理監査、バージョン管理された設定ロールバック。 |
| コスト管理 | 日次のトークン・費用予算、Workspace 価格表、コストレポート、CSV/JSON 配賦、異常の証跡、キャッシュによる削減額。 |
| 信頼性と運用 | スマートルーティング、フォールバック、サーキットブレーカー、ルーティング説明、PostgreSQL/Redis/Kubernetes への移行パス、Sigstore 署名付きリリースキット、レビュー済みのアップグレード計画。 |

## 評価の進め方

1. 導入判断: [Enterprise overview](../../enterprise-overview.md)
2. セキュリティ審査: [Security and compliance brief](../../security-compliance-brief.md)
3. 30 分デモ: [PoC playbook](../../poc-playbook.md)

## クイックスタート

```bash
git clone https://github.com/seanbabalala/SiftGate.git
cd SiftGate
# .nvmrc に従って Node >=22.13.0 <23 を選択します。
npm run runtime:check
npm install
cd frontend && npm install && cd ..
cp gateway.config.example.yaml gateway.config.yaml
cp .env.example .env
npm run build
# 起動前に非公開の YAML で dashboard.password（または OIDC）を設定します。
npm start
```

`http://localhost:2099/dashboard` を開き、Provider Node を 1 つ追加して Gateway API Key を作成し、`http://localhost:2099/v1/chat/completions` にリクエストを送ります。バージョン固定でワンタイム有効化コードを使う Docker インストールには [customer install kit](../../customer-install.md) を使用してください。

## プロバイダー認証情報プール

1 つの Provider Node に複数の上流 Key を登録できます。`cache_aware` は、プロバイダーのプロンプトキャッシュを作成または読み取ったリクエストを同じ Key に留め、429、5xx、タイムアウト時には別の Key に切り替えます。

```yaml
credential_pool:
  enabled: true
  strategy: cache_aware
  sticky_by: agent_session
  cooldown_ms: 60000
  retry_on_status: [429, 500, 502, 503, 504]
```

## ドキュメントマップ

| 目的 | 最初に読むもの |
| --- | --- |
| エンタープライズ評価 | [Enterprise overview](../../enterprise-overview.md), [Security and compliance brief](../../security-compliance-brief.md), [PoC playbook](../../poc-playbook.md), [Comparison](../../COMPARISON.md) |
| ローカル試用とダッシュボード | [Quickstart](../../QUICKSTART.md), [Dashboard](../../DASHBOARD.md), [OSS Concepts](../../OSS_CONCEPTS.md), [Playground](../../PLAYGROUND.md) |
| 本番運用 | [Customer install](../../customer-install.md), [Production](../../PRODUCTION.md), [Kubernetes and Helm](../../KUBERNETES.md), [State Backends](../../STATE_BACKEND.md), [Secret Management](../../SECRET_MANAGEMENT.md), [Config Audit and Rollback](../../CONFIG_AUDIT_ROLLBACK.md) |
| エージェントと MCP ツール | [Coding Agent Gateway](../../CODING_AGENT_GATEWAY.md), [Agent Integrations](../../AGENT_INTEGRATIONS.md), [MCP Tool Gateway](../../MCP_GATEWAY.md), [Agent + MCP Demo](../../AGENT_MCP_DEMO.md) |
| コストガバナンス | [Cost Platform](../../COST_CHARGEBACK_PLATFORM.md), [Billing Loop](../../BILLING_LOOP.md), [Policy Namespaces](../../NAMESPACES_AND_SHADOW.md) |
| プロバイダーとルーティング | [Provider Catalog](../../PROVIDER_CATALOG.md), [Provider Compatibility](../../PROVIDER_COMPATIBILITY.md), [Routing Recommendations](../../ROUTING_RECOMMENDATIONS.md), [Multimodal Capabilities](../../MULTIMODAL_CAPABILITIES.md) |
| 可観測性とアラート | [Operator Observability](../../OPERATOR_OBSERVABILITY.md), [Webhook Alerts](../../WEBHOOK_ALERTS.md), [Log Sinks](../../LOG_SINKS.md), [Security](../../SECURITY.md) |
| 開発 | [Architecture](../../ARCHITECTURE.md), [API Reference](../../API_REFERENCE.md), [SDKs](../../SDKS.md), [Plugins](../../PLUGINS.md), [Release Checklist](../../RELEASE_CHECKLIST.md) |

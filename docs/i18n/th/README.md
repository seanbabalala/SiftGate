# เอกสาร SiftGate

[หน้าหลักเอกสาร](../../README.md) · [README ของโปรเจกต์](../../../README.md)

รีลีสปัจจุบัน: **v2.12.16**

**AI gateway แบบ self-hosted สำหรับธรรมาภิบาล AI ในองค์กร** SiftGate วางจุดควบคุมเดียวที่องค์กรดูแลเองไว้หน้าการเรียก AI ทุกครั้ง ทั้งจากแอปธุรกิจ Coding Agent และ MCP tools โดย provider key อยู่บนเซิร์ฟเวอร์ขององค์กร การเข้าถึงเป็นไปตามนโยบาย ค่าใช้จ่ายมีงบประมาณและปันส่วนให้แต่ละทีมได้ และทุก request มี audit trail โดยค่าเริ่มต้นไม่บันทึก prompt และ response

<p align="center">
  <img src="../../assets/homepage/siftgate-hero.svg" alt="SiftGate: AI gateway แบบ self-hosted สำหรับธรรมาภิบาล AI ในองค์กร" width="100%" />
</p>

## ทำไมองค์กรจึงใช้ SiftGate

| ปัญหาที่เกิดเมื่อใช้ AI มากขึ้น | สิ่งที่ SiftGate เปลี่ยน |
| --- | --- |
| Shadow AI และ key กระจัดกระจาย | provider key อยู่ใน gateway เท่านั้น ทีมได้รับ Gateway API Key ที่จำกัดขอบเขตและเพิกถอนได้ |
| การตรวจสอบความปลอดภัยทำให้เปิดใช้ไม่ได้ | ค่าเริ่มต้นเก็บเฉพาะ metadata ไม่บันทึก prompt, response, source code, tool payload หรือ secret |
| บิลมาเป็นยอดรวมก้อนเดียว | งบประมาณระดับ global, namespace, team และ key พร้อม export สำหรับปันส่วนต้นทุน และ key pool ที่คำนึงถึง cache |
| provider รายเดียวล่ม ทุกคนหยุดงาน | fallback chain, circuit breaker, credential failover และ route explanation ของทุก request |

## เสาหลักธรรมาภิบาลสี่ด้าน

| เสาหลัก | ครอบคลุม |
| --- | --- |
| การเข้าถึงและนโยบาย | key ที่จำกัดขอบเขต, Workspace, Team, Policy Namespace (ถ้าส่วนร่วมว่างจะปฏิเสธทันที), model pool ราย key, Agent Profile, MCP Tool Gateway, RBAC และ OIDC |
| การปกป้องข้อมูลและการตรวจสอบ | log และ route trace แบบ metadata-only, guardrails ภายในสำหรับ PII, secret และ prompt injection, management audit แบบ hash chain, rollback ของ config แบบมีเวอร์ชัน |
| การควบคุมต้นทุน | งบ token และค่าใช้จ่ายรายวัน, price book ราย Workspace, cost report, การปันส่วนแบบ CSV/JSON, หลักฐานความผิดปกติ, ยอดประหยัดจาก cache |
| ความเสถียรและการปฏิบัติการ | smart routing, fallback, circuit breaker, route explanation, เส้นทาง PostgreSQL/Redis/Kubernetes, release kit ที่ลงนามด้วย Sigstore, แผนอัปเกรดที่ผ่านการตรวจทาน |

## ขั้นตอนการประเมิน

1. ประกอบการตัดสินใจ: [Enterprise overview](../../enterprise-overview.md)
2. ตรวจสอบความปลอดภัย: [Security and compliance brief](../../security-compliance-brief.md)
3. สาธิตใน 30 นาที: [PoC playbook](../../poc-playbook.md)

## เริ่มต้นอย่างรวดเร็ว

```bash
git clone https://github.com/seanbabalala/ai-gateway.git
cd ai-gateway
# เลือก Node >=22.13.0 <23 ตาม .nvmrc
npm run runtime:check
npm install
cd frontend && npm install && cd ..
cp gateway.config.example.yaml gateway.config.yaml
cp .env.example .env
npm run build
# ตั้งค่า dashboard.password (หรือ OIDC) ใน YAML ส่วนตัวก่อนขั้นตอนนี้
npm start
```

เปิด `http://localhost:2099/dashboard` เพิ่ม Provider Node หนึ่งตัว สร้าง Gateway API Key แล้วส่ง request ไปที่ `http://localhost:2099/v1/chat/completions` หากต้องการติดตั้งด้วย Docker แบบระบุเวอร์ชันพร้อมรหัสเปิดใช้งานครั้งเดียว ให้ใช้ [customer install kit](../../customer-install.md)

## Provider credential pools

Provider Node เดียวเก็บ upstream key ได้หลายตัว `cache_aware` จะให้ request ที่สร้างหรืออ่าน prompt cache ของ provider อยู่กับ key เดิม และสลับไป key อื่นเมื่อเจอ 429, 5xx หรือ timeout

```yaml
credential_pool:
  enabled: true
  strategy: cache_aware
  sticky_by: agent_session
  cooldown_ms: 60000
  retry_on_status: [429, 500, 502, 503, 504]
```

## แผนที่เอกสาร

| เป้าหมาย | เริ่มที่ |
| --- | --- |
| การประเมินสำหรับองค์กร | [Enterprise overview](../../enterprise-overview.md), [Security and compliance brief](../../security-compliance-brief.md), [PoC playbook](../../poc-playbook.md), [Comparison](../../COMPARISON.md) |
| ทดลองในเครื่องและ Dashboard | [Quickstart](../../QUICKSTART.md), [Dashboard](../../DASHBOARD.md), [OSS Concepts](../../OSS_CONCEPTS.md), [Playground](../../PLAYGROUND.md) |
| การใช้งาน production | [Customer install](../../customer-install.md), [Production](../../PRODUCTION.md), [Kubernetes and Helm](../../KUBERNETES.md), [State Backends](../../STATE_BACKEND.md), [Secret Management](../../SECRET_MANAGEMENT.md), [Config Audit and Rollback](../../CONFIG_AUDIT_ROLLBACK.md) |
| Agent และ MCP tools | [Coding Agent Gateway](../../CODING_AGENT_GATEWAY.md), [Agent Integrations](../../AGENT_INTEGRATIONS.md), [MCP Tool Gateway](../../MCP_GATEWAY.md), [Agent + MCP Demo](../../AGENT_MCP_DEMO.md) |
| ธรรมาภิบาลต้นทุน | [Cost Platform](../../COST_CHARGEBACK_PLATFORM.md), [Billing Loop](../../BILLING_LOOP.md), [Policy Namespaces](../../NAMESPACES_AND_SHADOW.md) |
| Provider และ routing | [Provider Catalog](../../PROVIDER_CATALOG.md), [Provider Compatibility](../../PROVIDER_COMPATIBILITY.md), [Routing Recommendations](../../ROUTING_RECOMMENDATIONS.md), [Multimodal Capabilities](../../MULTIMODAL_CAPABILITIES.md) |
| Observability และการแจ้งเตือน | [Operator Observability](../../OPERATOR_OBSERVABILITY.md), [Webhook Alerts](../../WEBHOOK_ALERTS.md), [Log Sinks](../../LOG_SINKS.md), [Security](../../SECURITY.md) |
| การพัฒนา | [Architecture](../../ARCHITECTURE.md), [API Reference](../../API_REFERENCE.md), [SDKs](../../SDKS.md), [Plugins](../../PLUGINS.md), [Release Checklist](../../RELEASE_CHECKLIST.md) |

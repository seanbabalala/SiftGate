# Documentación de SiftGate

[Inicio de la documentación](../../README.md) · [README del proyecto](../../../README.md)

Versión actual: **v2.12.16**.

**Gateway de IA autoalojado para la gobernanza de IA empresarial.** SiftGate coloca un único punto de control, operado por tu equipo, delante de cada llamada de IA de la empresa: aplicaciones de negocio, agentes de programación y herramientas MCP. Las claves de los proveedores permanecen en tus servidores, el acceso sigue las políticas, el gasto se presupuesta y se reparte por equipo, y cada solicitud deja un registro de auditoría sin almacenar prompts ni respuestas de forma predeterminada.

<p align="center">
  <img src="../../assets/homepage/siftgate-hero.svg" alt="SiftGate: gateway de IA autoalojado para la gobernanza de IA empresarial" width="100%" />
</p>

## Por qué las empresas usan SiftGate

| Lo que falla cuando crece el uso de IA | Lo que cambia SiftGate |
| --- | --- |
| IA en la sombra y claves dispersas | Las claves de proveedor quedan dentro del gateway; los equipos reciben Gateway API Keys acotadas y revocables. |
| La revisión de seguridad bloquea el despliegue | Solo metadatos por defecto: no se guardan prompts, respuestas, código fuente, payloads de herramientas ni secretos. |
| El gasto llega como una factura sin desglose | Presupuestos globales, por namespace, equipo y clave, exportaciones de imputación de costos y pools de claves con afinidad de caché. |
| La caída de un proveedor detiene a todos | Cadenas de fallback, circuit breakers, conmutación de credenciales y una explicación de ruta por solicitud. |

## Cuatro pilares de gobernanza

| Pilar | Qué cubre |
| --- | --- |
| Acceso y políticas | Claves acotadas, Workspaces, Teams y Policy Namespaces con intersecciones que deniegan si quedan vacías, pools de modelos por clave, Agent Profiles, MCP Tool Gateway, RBAC y OIDC. |
| Protección de datos y auditoría | Logs y trazas de ruta solo con metadatos, guardrails locales para PII, secretos e inyección de prompts, auditoría de gestión encadenada por hash y rollback de configuración versionada. |
| Control de costos | Presupuestos diarios de tokens y costo, libros de precios por Workspace, informe de costos, imputación en CSV/JSON, evidencia de anomalías y ahorro por caché. |
| Confiabilidad y operaciones | Enrutamiento inteligente, fallbacks, circuit breakers, explicación de rutas, camino a PostgreSQL/Redis/Kubernetes, kits de versión firmados con Sigstore y planes de actualización revisados. |

## Cómo evaluar SiftGate

1. Para decidir: [Enterprise overview](../../enterprise-overview.md)
2. Revisión de seguridad: [Security and compliance brief](../../security-compliance-brief.md)
3. Demo de 30 minutos: [PoC playbook](../../poc-playbook.md)

## Inicio rápido

```bash
git clone https://github.com/seanbabalala/SiftGate.git
cd SiftGate
# Selecciona Node >=22.13.0 <23 según .nvmrc.
npm run runtime:check
npm install
cd frontend && npm install && cd ..
cp gateway.config.example.yaml gateway.config.yaml
cp .env.example .env
npm run build
# Configura dashboard.password (u OIDC) en el YAML privado antes de este paso.
npm start
```

Abre `http://localhost:2099/dashboard`, agrega un Provider Node, crea una Gateway API Key y envía solicitudes a `http://localhost:2099/v1/chat/completions`. Para una instalación Docker versionada con código de activación de un solo uso, usa el [customer install kit](../../customer-install.md).

## Pools de credenciales de proveedor

Un Provider Node puede contener varias claves upstream. `cache_aware` mantiene en la misma clave las solicitudes que crearon o leyeron la caché de prompts del proveedor y cambia a otra clave ante 429, 5xx o timeouts.

```yaml
credential_pool:
  enabled: true
  strategy: cache_aware
  sticky_by: agent_session
  cooldown_ms: 60000
  retry_on_status: [429, 500, 502, 503, 504]
```

## Mapa de documentación

| Objetivo | Empieza aquí |
| --- | --- |
| Evaluación empresarial | [Enterprise overview](../../enterprise-overview.md), [Security and compliance brief](../../security-compliance-brief.md), [PoC playbook](../../poc-playbook.md), [Comparison](../../COMPARISON.md) |
| Prueba local y Dashboard | [Quickstart](../../QUICKSTART.md), [Dashboard](../../DASHBOARD.md), [OSS Concepts](../../OSS_CONCEPTS.md), [Playground](../../PLAYGROUND.md) |
| Operación en producción | [Customer install](../../customer-install.md), [Production](../../PRODUCTION.md), [Kubernetes and Helm](../../KUBERNETES.md), [State Backends](../../STATE_BACKEND.md), [Secret Management](../../SECRET_MANAGEMENT.md), [Config Audit and Rollback](../../CONFIG_AUDIT_ROLLBACK.md) |
| Agentes y herramientas MCP | [Coding Agent Gateway](../../CODING_AGENT_GATEWAY.md), [Agent Integrations](../../AGENT_INTEGRATIONS.md), [MCP Tool Gateway](../../MCP_GATEWAY.md), [Agent + MCP Demo](../../AGENT_MCP_DEMO.md) |
| Gobernanza de costos | [Cost Platform](../../COST_CHARGEBACK_PLATFORM.md), [Billing Loop](../../BILLING_LOOP.md), [Policy Namespaces](../../NAMESPACES_AND_SHADOW.md) |
| Proveedores y enrutamiento | [Provider Catalog](../../PROVIDER_CATALOG.md), [Provider Compatibility](../../PROVIDER_COMPATIBILITY.md), [Routing Recommendations](../../ROUTING_RECOMMENDATIONS.md), [Multimodal Capabilities](../../MULTIMODAL_CAPABILITIES.md) |
| Observabilidad y alertas | [Operator Observability](../../OPERATOR_OBSERVABILITY.md), [Webhook Alerts](../../WEBHOOK_ALERTS.md), [Log Sinks](../../LOG_SINKS.md), [Security](../../SECURITY.md) |
| Desarrollo | [Architecture](../../ARCHITECTURE.md), [API Reference](../../API_REFERENCE.md), [SDKs](../../SDKS.md), [Plugins](../../PLUGINS.md), [Release Checklist](../../RELEASE_CHECKLIST.md) |
